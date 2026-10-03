// Stable stdio supervisor for KLYPIX MCP workers.
//
// MCP hosts own the stdio connection and commonly keep it for the full app
// lifetime. Replacing server files on disk therefore cannot update a running
// process. This supervisor keeps that host-owned connection stable while a
// replaceable worker handles the protocol behind it.
//
// Upgrade contract:
//   1. installers stage the complete worker bundle;
//   2. `.mcp-runtime.json` is atomically committed last;
//   3. the supervisor boots and initializes the candidate in parallel;
//   4. it verifies the advertised version + tool compatibility;
//   5. it replays the active brain_sync task scope;
//   6. it switches only between requests and emits tools/list_changed.
//
// A broken or incompatible candidate never replaces the live worker. The old
// worker remains warm for a short rollback grace after a successful switch.
//
// Idle hibernation follows the same contract (2026-10-03). A hibernated pair
// stays asleep until its host sends a request: an install that lands meanwhile
// is only noted (hibernation.pendingWakeTarget, never a downgrade). The wake
// re-reads the manifest and gates the new worker against the last committed one
// exactly like a live swap. A wake the gate rejects resumes the .prev copy of
// the version the pair last ran, or answers with a retryable reconnect error —
// never a respawn loop. Before this, the 1 s poller woke every idle pair about
// a second after it hibernated (14 of 15 pairs on the founder's PC cycled every
// 55-75 s, ~800 worker spawns an hour), and those wakes skipped both gates.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import {
  autoUpdateEnabled,
  inspectAutoUpdate,
  spawnAutoUpdateHelper,
} from './mcp-auto-update.mjs';
// Namespace import for constants added after 1.89.0 (AUTO_UPDATE_POLL_MS). The
// installer renames mcp-supervisor.mjs before mcp-auto-update.mjs, so a host
// that launches mid-install can pair this file with the older module, and a
// named import of a missing export fails at link time — the host's whole MCP
// connection with it.
import * as autoUpdateModule from './mcp-auto-update.mjs';
import { formatReceivedMessages, peekMessages, removeSession, upsertSession } from './agent-presence.mjs';

const INTERNAL_PREFIX = '__klypix_supervisor__';
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ROLLBACK_GRACE_MS = 3000;
// The updater's own poll cadence, so supervisors and workers ask "is a check
// due?" equally often (60 min before 2026-10-03, which left a due check waiting
// up to an hour once hibernated pairs stopped waking every minute).
const DEFAULT_AUTO_UPDATE_POLL_MS = Number(autoUpdateModule.AUTO_UPDATE_POLL_MS) > 0
  ? Number(autoUpdateModule.AUTO_UPDATE_POLL_MS)
  : 60 * 60 * 1000;
const DEFAULT_AUTO_UPDATE_START_DELAY_MS = 2000;
// Worker-recovery retry policy: capped exponential backoff (1s → 2s → 4s …,
// ceiling 60s), bounded attempts. After the last attempt the supervisor answers
// requests with a retryable error instead of queueing them forever.
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_BACKOFF_BASE_MS = 1000;
const RECOVERY_BACKOFF_MAX_MS = 60_000;
// Unbounded queue growth is its own failure mode while a recovery is running.
const HOST_QUEUE_MAX = 200;
// A wake that finds the manifest failing integrity is usually racing an install:
// the installer renames ~38 files one at a time and commits the manifest last,
// which takes seconds. The wake waits this long for it to settle, and so does a
// fresh connection whose own worker sits inside the managed directory (K1).
const WAKE_INTEGRITY_WAIT_MS = 5000;
const WAKE_INTEGRITY_POLL_MS = 250;
// A wake refused this many times, over at least this long, is not an install
// mid-flight: the answer then names the reinstall (F6, 2026-10-03 review).
const WAKE_DEFERRAL_REINSTALL_COUNT = 3;
const DEFAULT_WAKE_REINSTALL_HINT_MS = 10 * 60 * 1000;
// The poller trusts an unchanged manifest stat for this long between full
// re-verifications of every runtime file.
const RUNTIME_REVERIFY_MS = 5 * 60 * 1000;
// A live supervisor closes itself within 30 s of its host dying (the parent
// watchdog in run()). A receipt whose host is provably gone and that nobody has
// rewritten for this long belongs to no live supervisor, even when its own pid
// answers again: Windows reuses pids (.supervisors/3228.json named ChatGPT.exe
// on the founder's PC, 2026-10-02, and kept the doctor's verdict DRIFTED).
const DEAD_RECEIPT_GRACE_MS = 120_000;
// The retryable host error once the installed core can no longer be adopted
// without a reconnect while the pair has no worker (B4, 2026-10-03).
const RESTART_REQUIRED_IDLE = 'KLYPIX core changed incompatibly while idle — /mcp reconnect';
// The identity-only hibernation probe (B6, 2026-10-03). Workers that predate it
// answer JSON-RPC "Method not found", and the supervisor falls back to the
// brain_sync checkpoint it used before.
const PRESENCE_IDENTITY_METHOD = 'klypix/presenceIdentity';
const METHOD_NOT_FOUND = -32601;
// writeState runs on the stdio relay path, so its rename retry stays within a
// few milliseconds; a state write that still fails is redone by the next one.
const STATE_RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STATE_RENAME_BACKOFF_MS = [2, 5, 10];

const log = (...args) => console.error('[klypix-supervisor]', ...args);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const idKey = (id) => JSON.stringify(id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// Liveness of a process another supervisor recorded. Only ESRCH proves it gone:
// EPERM means it exists but is not ours to signal (an elevated host), and the
// boot cleanup deletes on 'dead', so every doubt must read as alive.
const pidState = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return 'none';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'alive'; }
};
const within = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
// A failed rename used to leave `<pid>.json.<pid>.tmp` behind for good (four
// such files sat in the founder's .supervisors from 2026-08-12 on). Unlink the
// tmp on any failure, and retry the rename briefly: on Windows it throws
// EPERM/EBUSY/EACCES while a reader (the doctor, the runtime inspector) holds
// the receipt open.
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); return; }
      catch (error) {
        if (attempt >= STATE_RENAME_BACKOFF_MS.length || !STATE_RENAME_RETRYABLE.has(error?.code)) throw error;
        sleepSync(STATE_RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    throw error;
  }
};
// Rejections the same bytes produce on every attempt: a retry cannot help.
const deterministicError = (message) => Object.assign(new Error(message), { deterministic: true });
const parseSemver = (value) => {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
};
const compareSemver = (a, b) => {
  const aa = parseSemver(a), bb = parseSemver(b);
  if (!aa || !bb) return null;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
};
const readBakedVersion = (file) => {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return source.match(/const PKG_VERSION = ['"]([^'"]+)['"]/)?.[1] || null;
  } catch { return null; }
};
// The version a worker FILE carries now. The flat bundle bakes it into the file;
// the package's bin/klypix-worker.mjs reads ../package.json at run time.
const workerFileVersion = (file) => {
  const baked = readBakedVersion(file);
  if (baked) return baked;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8'));
    return pkg?.name === 'klypix-mcp' && typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
};
// The installer's snapshot of a worker file: `.prev/<name>` beside it. Every
// live file is copied there before the first new one is renamed in, so it is a
// complete copy of the previous install. Null when there is none, or when its
// version is not baked in (only the flat bundle bakes it).
const prevSnapshotTarget = (workerPath) => {
  const previousPath = path.join(path.dirname(workerPath), '.prev', path.basename(workerPath));
  if (!fs.existsSync(previousPath)) return null;
  const version = readBakedVersion(previousPath);
  if (!version) return null;
  return { path: previousPath, version, signature: `previous:${previousPath}:${version}`, source: 'rollback', dev: false };
};

function createLineReader(onMessage, onError) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    for (;;) {
      const index = buffered.indexOf(10);
      if (index < 0) return;
      const raw = buffered.subarray(0, index).toString('utf8').replace(/\r$/, '');
      buffered = buffered.subarray(index + 1);
      if (!raw.trim()) continue;
      try { onMessage(JSON.parse(raw)); }
      catch (error) { onError(error, raw); }
    }
  };
}

function stripSchemaDocs(value) {
  if (Array.isArray(value)) return value.map(stripSchemaDocs);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (['description', 'title', '$comment', 'examples', 'default'].includes(key)) continue;
    out[key] = stripSchemaDocs(child);
  }
  return out;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Conservative input-compatibility check. New optional fields and wider enums
// are safe; removed fields, newly-required fields, narrower enums, and semantic
// schema changes require a host reconnect instead of a transparent swap.
function schemaAcceptsPrevious(oldSchema = {}, nextSchema = {}) {
  const oldClean = stripSchemaDocs(oldSchema || {});
  const nextClean = stripSchemaDocs(nextSchema || {});
  const oldRequired = new Set(Array.isArray(oldClean.required) ? oldClean.required : []);
  const nextRequired = new Set(Array.isArray(nextClean.required) ? nextClean.required : []);
  for (const name of nextRequired) if (!oldRequired.has(name)) return false;

  const oldProps = oldClean.properties && typeof oldClean.properties === 'object' ? oldClean.properties : {};
  const nextProps = nextClean.properties && typeof nextClean.properties === 'object' ? nextClean.properties : {};
  for (const [name, oldProp] of Object.entries(oldProps)) {
    const nextProp = nextProps[name];
    if (!nextProp) return false;
    const oldEnum = Array.isArray(oldProp?.enum) ? oldProp.enum : null;
    const nextEnum = Array.isArray(nextProp?.enum) ? nextProp.enum : null;
    if (oldEnum && nextEnum) {
      if (oldEnum.some(value => !nextEnum.some(candidate => sameJson(candidate, value)))) return false;
      const oldWithout = { ...oldProp }; delete oldWithout.enum;
      const nextWithout = { ...nextProp }; delete nextWithout.enum;
      if (!sameJson(oldWithout, nextWithout)) return false;
    } else if (!sameJson(oldProp, nextProp)) {
      return false;
    }
  }

  const omitShape = (schema) => {
    const copy = { ...schema };
    delete copy.required;
    delete copy.properties;
    return copy;
  };
  return sameJson(omitShape(oldClean), omitShape(nextClean));
}

function toolCompatibility(oldTools = [], nextTools = []) {
  const oldMap = new Map(oldTools.map(tool => [tool.name, tool]));
  const nextMap = new Map(nextTools.map(tool => [tool.name, tool]));
  const removed = [];
  const changed = [];
  for (const [name, oldTool] of oldMap) {
    const nextTool = nextMap.get(name);
    if (!nextTool) {
      removed.push(name);
      continue;
    }
    if (!schemaAcceptsPrevious(oldTool.inputSchema, nextTool.inputSchema)) changed.push(name);
  }
  return {
    ok: removed.length === 0 && changed.length === 0,
    removed,
    changed,
    added: [...nextMap.keys()].filter(name => !oldMap.has(name)),
  };
}

function manifestHash(tools = []) {
  return sha256(JSON.stringify(tools));
}

export function readRuntimeTarget(manifestPath, { allowExternal = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch (error) {
    // Only a missing file is ABSENT. EBUSY/EPERM/EACCES while an installer
    // renames the new manifest over the old one is a read that failed, and a
    // wake that took it for "no runtime" skipped its integrity wait and booted a
    // stale fallback (CF-2, 2026-10-03 review).
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ok: false, absent: true, error: 'runtime manifest is absent' };
    }
    return { ok: false, error: `runtime manifest is unreadable: ${error?.code || error?.message || 'read failed'}` };
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { return { ok: false, error: `runtime manifest is invalid JSON: ${error.message}` }; }
  if (manifest?.protocol !== 1) return { ok: false, error: `unsupported runtime protocol ${manifest?.protocol ?? '(missing)'}` };
  if (!manifest.version || !manifest.worker) return { ok: false, error: 'runtime manifest must contain version and worker' };

  const root = path.dirname(path.resolve(manifestPath));
  const worker = path.resolve(root, String(manifest.worker));
  if (!allowExternal && !within(root, worker)) return { ok: false, error: 'runtime worker escapes the managed directory' };
  if (!fs.existsSync(worker)) return { ok: false, error: `runtime worker is missing: ${worker}` };

  const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  for (const [relative, expected] of Object.entries(files)) {
    const file = path.resolve(root, relative);
    if (!allowExternal && !within(root, file)) return { ok: false, error: `runtime file escapes the managed directory: ${relative}` };
    let actual;
    try { actual = sha256(fs.readFileSync(file)); }
    catch { return { ok: false, error: `runtime file is missing: ${relative}` }; }
    if (actual !== expected) return { ok: false, error: `runtime integrity mismatch: ${relative}` };
  }

  return {
    ok: true,
    target: {
      path: worker,
      version: String(manifest.version),
      signature: sha256(raw),
      source: 'installed',
      dev: manifest.dev === true,
      channel: manifest.channel || manifest.via || null,
      manifestPath: path.resolve(manifestPath),
    },
  };
}

// The poller's view of readRuntimeTarget (B8, 2026-10-03). Every supervisor
// re-hashed every runtime file (38 files, ~2.1 MiB) each second: ~31.6 MiB/s of
// SHA-256 across the founder's 15 supervisors, contending with the installer's
// renames — the documented EPERM source. Installs commit the manifest by
// rename-over, which changes its file id, size or mtime, so a stat equal to the
// one taken before the last VERIFIED read means nothing was committed since.
// Only a verified read is remembered (a transient EBUSY just after a commit
// must not pin a failure), a full re-verify still runs every 5 min (a runtime
// file edited without a new manifest is caught there), and callers force a full
// read before any candidate starts.
function createRuntimeWatch(manifestPath, {
  allowExternal = false,
  reverifyMs = RUNTIME_REVERIFY_MS,
  now = () => Date.now(),
} = {}) {
  let verified = null;
  const statKey = () => {
    try {
      // bigint: NTFS file ids exceed 2^53 and must compare exactly.
      const stat = fs.statSync(manifestPath, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch { return null; }
  };
  return {
    read({ force = false } = {}) {
      const key = statKey();
      const at = now();
      if (!force && key !== null && verified?.key === key && at >= verified.at && at - verified.at < reverifyMs) {
        return { ok: true, target: verified.target, cached: true };
      }
      const runtime = readRuntimeTarget(manifestPath, { allowExternal });
      verified = runtime.ok && key !== null ? { key, at, target: runtime.target } : null;
      return runtime;
    },
  };
}

// Is this supervisor receipt provably dead? The boot cleanup deletes on a yes,
// so every doubt keeps the receipt.
function deadSupervisorReceipt(state, { now = Date.now(), probe = pidState } = {}) {
  // atomicJson never leaves a torn receipt, so unparseable JSON has no owner.
  if (!isRecord(state)) return true;
  if (probe(Number(state.pid)) !== 'alive') return true;
  // Its pid answers — but Windows reuses pids. The host it served being gone,
  // with no rewrite since, means the supervisor is gone too.
  const parentPid = Number(state.parentPid);
  if (!Number.isInteger(parentPid) || parentPid <= 1 || probe(parentPid) !== 'dead') return false;
  const updatedAt = Date.parse(state.updatedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt > DEAD_RECEIPT_GRACE_MS;
}

const observeFile = (file) => {
  try { return { raw: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs }; }
  catch { return null; }
};

// Compare-and-rename, the lock-stealing idiom (mcp-auto-update.mjs): a receipt
// its owner rewrote after we judged it is never the one removed.
function removeIfUnchanged(file, observed) {
  const moved = `${file}.dead-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const current = observeFile(file);
    if (!current || current.raw !== observed.raw || current.mtimeMs !== observed.mtimeMs) return false;
    fs.renameSync(file, moved);
  } catch { return false; }
  if (observeFile(moved)?.raw !== observed.raw) {
    try { if (!fs.existsSync(file)) fs.renameSync(moved, file); else fs.unlinkSync(moved); } catch { /* best effort */ }
    return false;
  }
  try { fs.unlinkSync(moved); } catch { /* best effort */ }
  return true;
}

// Boot-time cleanup of .supervisors (B7, 2026-10-03). It used to delete only
// receipts whose own pid was dead, and read EPERM as dead — so a non-elevated
// supervisor deleted an elevated pair's LIVE receipt, while a dead receipt whose
// pid had been reused stayed forever. Leftover tmp files are removed once the
// process that wrote them is gone.
function cleanSupervisorStateDir(stateDir, { now = Date.now(), probe = pidState } = {}) {
  const removed = { receipts: [], tmp: [] };
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { return removed; }
  for (const name of names) {
    const file = path.join(stateDir, name);
    // `<pid>.json.<writer>.tmp` from atomicJson, `<pid>.json.dead-<pid>-<hex>`
    // from an interrupted removal: the writer's pid is in the name.
    const leftover = name.match(/\.json\.(?:(\d+)\.tmp|dead-(\d+)-[0-9a-f]+)$/);
    if (leftover) {
      if (probe(Number(leftover[1] || leftover[2])) === 'dead') {
        try { fs.unlinkSync(file); removed.tmp.push(name); } catch { /* raced */ }
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const observed = observeFile(file);
    if (!observed) continue;
    let state = null;
    try { state = JSON.parse(observed.raw); } catch { /* torn: no owner */ }
    if (deadSupervisorReceipt(state, { now, probe }) && removeIfUnchanged(file, observed)) removed.receipts.push(name);
  }
  return removed;
}

class Supervisor {
  constructor(options) {
    this.workerArgs = Array.isArray(options.workerArgs) ? options.workerArgs : [];
    this.fallbackTarget = {
      path: path.resolve(options.fallbackWorker),
      version: String(options.fallbackVersion || readBakedVersion(options.fallbackWorker) || '0.0.0'),
      signature: `fallback:${path.resolve(options.fallbackWorker)}:${options.fallbackVersion || ''}`,
      source: 'package',
      dev: false,
    };
    this.runtimeManifest = path.resolve(
      options.runtimeManifest
      || process.env.KLYPIX_MCP_RUNTIME_MANIFEST
      || path.join(os.homedir(), '.claude', 'project-brain', '.mcp-runtime.json'),
    );
    this.allowExternal = options.allowExternal === true || process.env.KLYPIX_MCP_ALLOW_EXTERNAL_WORKER === '1';
    this.pollMs = Number(options.pollMs || process.env.KLYPIX_MCP_SUPERVISOR_POLL_MS || DEFAULT_POLL_MS);
    this.timeoutMs = Number(options.timeoutMs || process.env.KLYPIX_MCP_SUPERVISOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.rollbackGraceMs = Number(options.rollbackGraceMs || process.env.KLYPIX_MCP_ROLLBACK_GRACE_MS || DEFAULT_ROLLBACK_GRACE_MS);
    this.autoUpdate = options.autoUpdate !== false && autoUpdateEnabled();
    this.autoUpdatePollMs = Number(
      options.autoUpdatePollMs
      || process.env.KLYPIX_MCP_AUTO_UPDATE_POLL_MS
      || DEFAULT_AUTO_UPDATE_POLL_MS,
    );
    this.autoUpdateStartDelayMs = Number(
      options.autoUpdateStartDelayMs
      || process.env.KLYPIX_MCP_AUTO_UPDATE_START_DELAY_MS
      || DEFAULT_AUTO_UPDATE_START_DELAY_MS,
    );
    this.stateDir = path.resolve(
      options.stateDir
      || process.env.KLYPIX_MCP_STATE_DIR
      || path.join(path.dirname(this.runtimeManifest), '.supervisors'),
    );
    this.stateFile = path.join(this.stateDir, `${process.pid}.json`);
    this.connectionId = String(options.connectionId || crypto.randomUUID());
    this.parentPid = Number(process.ppid) || null;
    // Default-root detection: IDE hosts often launch from their install dir
    // with no --vault/KLYPIX_VAULT, so the pair boots against ~/Documents and
    // idles there. Flagging it in the state file lets doctor/runtime name these
    // pairs explicitly instead of them hiding inside the aggregate RAM number.
    const vaultFlagAt = this.workerArgs ? this.workerArgs.indexOf('--vault') : -1;
    this.vaultArg = vaultFlagAt >= 0 ? String(this.workerArgs[vaultFlagAt + 1] || '') : null;
    this.defaultRoot = !this.vaultArg && !process.env.KLYPIX_VAULT;
    this.clientInfo = null;
    this.lastHostMessageAt = null;
    this.lastActivityStateWriteAt = 0;
    this.hostRequests = new Map();
    this.workerRequests = new Map();
    this.hostQueue = [];
    this.internalCounter = 0;
    this.active = null;
    this.candidate = null;
    this.standby = null;
    this.pendingTarget = null;
    this.rejectedSignature = null;
    this.initializeRequest = null;
    this.initializedNotification = null;
    this.taskScope = null;
    this.hostInitialized = false;
    this.closed = false;
    this.status = 'starting';
    this.lastSwapAt = null;
    this.lastError = null;
    this.hotReloads = 0;
    this.checking = false;
    // Recovery must not be a one-shot: 0xC0000142-class worker failures are
    // transient, and the old permanent signature blacklist turned one bad spawn
    // into a silent zombie that queued host requests forever (2026-07-29 audit).
    this.recoveryAttempts = 0;
    this.recoveryTimer = null;
    this.lastFailedSignature = null;
    // RAM Phase 2 — idle worker hibernation. An idle connection pays for a
    // whole worker process it is not using (measured: 11 idle pairs = 1,445 MB
    // with ZERO models resident, so this is process baseline, not semantics).
    // After this much host silence the worker half is retired; the next host
    // message wakes it through the SAME queue → candidate → commit → flush path
    // recovery already uses, with the task scope replayed. Set 0 to disable
    // (instant rollback to today's behavior; no data/format/protocol change).
    const hibernateEnv = Number(process.env.KLYPIX_WORKER_HIBERNATE_MS);
    this.hibernateIdleMs = Number.isFinite(hibernateEnv) ? Math.max(0, hibernateEnv) : 600_000;
    this.hibernatedTarget = null;
    this.hibernatedAt = null;
    this.hibernations = 0;
    this.hibernateProbeInFlight = false;
    this.hibernateSkipReason = null;
    // Presence identity of the hibernated connection. While the worker is gone
    // the SUPERVISOR keeps its lane row fresh, so peers see exactly what they
    // saw before — hibernation buys RAM without spending coordination.
    this.presenceIdentity = null;
    this.presenceHeartbeat = null;
    this.hibernatedAnnouncements = new Set();
    this.hostTransportState = 'starting';
    this.lastHostWriteError = null;
    this.hostBackpressuredAt = null;
    // B9 (2026-10-03): the version of THIS supervisor's code. Workers hot-swap;
    // a supervisor runs the code its host launched until the next reconnect, so
    // the doctor needs this to tell which connections still run pre-fix code.
    // The entry point passes its own (baked, in the flat bundle) version.
    this.supervisorVersion = String(options.fallbackVersion || readBakedVersion(options.fallbackWorker) || '') || null;
    // B2 (2026-10-03): the last committed worker, {version, manifest,
    // manifestHash, target}. A wake or a crash recovery has no live worker to
    // compare a candidate with; the gates compare against this instead.
    this.baseline = null;
    // B1 (2026-10-03): a newer install noticed while hibernated. Recorded for
    // the doctor ("wakes into vX, not yet validated"); only the wake acts on it.
    this.pendingWakeTarget = null;
    this.waking = false;
    // F6 (2026-10-03 review): wakes refused because the core files fail
    // verification, {reason, count, since}. The receipt carries it, so the
    // doctor stops promising that this pair "wakes on the next request".
    this.wakeDeferral = null;
    const hintEnv = Number(process.env.KLYPIX_MCP_WAKE_REINSTALL_HINT_MS);
    this.wakeReinstallHintMs = Number.isFinite(hintEnv) && hintEnv >= 0 ? hintEnv : DEFAULT_WAKE_REINSTALL_HINT_MS;
    this.runtimeWatch = createRuntimeWatch(this.runtimeManifest, { allowExternal: this.allowExternal });
    // The integrity error the poller last recorded, and the lastError it
    // replaced, so a runtime that verifies again does not keep reporting it.
    this.runtimeError = null;
    this.errorBeforeRuntime = null;
  }

  writeState(extra = {}) {
    // No receipt before the first worker is chosen. K1's boot can wait seconds
    // for an install to settle, and a receipt with no worker and no version
    // reads to the doctor as an impaired pair that does not match the install.
    // The first receipt follows the spawn in run(), with any boot error in it.
    if (this.status === 'starting') return;
    try {
      atomicJson(this.stateFile, {
        protocol: 1,
        pid: process.pid,
        supervisorVersion: this.supervisorVersion,
        connectionId: this.connectionId,
        parentPid: this.parentPid,
        vault: this.vaultArg ? this.vaultArg.replace(/\\/g, '/') : null,
        defaultRoot: this.defaultRoot,
        hibernation: {
          idleMs: this.hibernateIdleMs,
          hibernated: this.status === 'hibernated',
          since: this.status === 'hibernated' ? this.hibernatedAt : null,
          count: this.hibernations,
          skipReason: this.hibernateSkipReason || null,
          // The version the pair last RAN — never an install it has not validated.
          target: this.status === 'hibernated' && this.hibernatedTarget ? {
            version: this.hibernatedTarget.version || null,
            path: this.hibernatedTarget.path?.replace(/\\/g, '/') || null,
            source: this.hibernatedTarget.source || null,
          } : null,
          pendingWakeTarget: this.status === 'hibernated' && this.pendingWakeTarget ? {
            version: this.pendingWakeTarget.version || null,
            validated: false,
          } : null,
          // The last wake(s) found no consistent worker to boot (deferWake).
          wakeDeferred: this.status === 'hibernated' && this.wakeDeferral ? { ...this.wakeDeferral } : null,
        },
        cwd: process.cwd().replace(/\\/g, '/'),
        bootedAt: this.bootedAt,
        updatedAt: new Date().toISOString(),
        lastHostMessageAt: this.lastHostMessageAt,
        transport: {
          host: this.hostTransportState,
          delivery: ['impaired', 'backpressured'].includes(this.hostTransportState)
            ? this.hostTransportState
            : (this.status === 'hibernated' ? 'pull-only' : (this.active ? 'connected' : 'impaired')),
          lastWriteError: this.lastHostWriteError,
          backpressuredAt: this.hostBackpressuredAt,
        },
        clientInfo: this.clientInfo,
        status: this.status,
        hotReloads: this.hotReloads,
        lastSwapAt: this.lastSwapAt,
        lastError: this.lastError,
        autoUpdate: {
          // currentVersion: what scheduleAutoUpdate hands the helper, so the
          // receipt's `decision` is the helper's decision.
          ...inspectAutoUpdate(path.dirname(this.runtimeManifest), {
            currentVersion: this.active?.version || this.fallbackTarget?.version || null,
          }),
          // This supervisor's OWN setting, spread last (2026-10-03 integration
          // review). The doctor ("enabled in N of M connections") and the
          // SessionStart notice ("overdue") read it to know which connections
          // run checks; the environment's `enabled` from inspectAutoUpdate used
          // to overwrite it, so a supervisor embedded with autoUpdate:false
          // (the klypix-mcp/supervisor API) claimed to run them.
          enabled: this.autoUpdate,
        },
        runtimeManifest: this.runtimeManifest.replace(/\\/g, '/'),
        active: this.active ? {
          pid: this.active.child.pid,
          version: this.active.version || this.active.target.version,
          path: this.active.target.path.replace(/\\/g, '/'),
          source: this.active.target.source,
        } : null,
        candidate: this.candidate ? {
          pid: this.candidate.child.pid,
          version: this.candidate.version || this.candidate.target.version,
          path: this.candidate.target.path.replace(/\\/g, '/'),
        } : null,
        ...extra,
      });
    } catch { /* diagnostics must never break the transport */ }
  }

  // Retire the worker half of an idle pair. Deliberately conservative: only a
  // settled, fully-handshaked, request-free connection hibernates, and only
  // when we can prove we are able to wake it (the host's initialize is what a
  // respawned worker replays).
  async maybeHibernate() {
    if (this.closed || !this.hibernateIdleMs || this.hibernateProbeInFlight) return;
    if (!this.active || this.candidate || this.standby) return;
    if (this.status !== 'ready') return;
    if (this.hostRequests.size || this.workerRequests.size || this.hostQueue.length) return;
    if (!this.initializeRequest || !this.hostInitialized) return;
    const last = Date.parse(this.lastHostMessageAt || this.bootedAt);
    if (!Number.isFinite(last) || Date.now() - last < this.hibernateIdleMs) return;

    // PRESENCE IS NON-NEGOTIABLE. A worker's graceful stop calls removeSession,
    // so hibernating would delete a LIVE session from every peer's view unless
    // something keeps its lane row fresh. Probe the worker for its presence
    // identity; the supervisor then heartbeats that row itself while the worker
    // sleeps, and pins the SAME session id into the respawned worker's env so
    // the wake never mints a second row. Identity unavailable → never hibernate.
    this.hibernateProbeInFlight = true;
    let identity = null;
    let probeFailed = false;
    try {
      const structured = await this.probePresenceIdentity(this.active);
      if (!structured || structured.reason === 'no-project-brain') {
        identity = null;                       // no lane row exists → nothing to keep alive
      } else if (structured.brain && structured.self?.id) {
        identity = {
          brainPath: String(structured.brain),
          id: String(structured.self.id),
          client: structured.self.client || 'unknown',
          surface: structured.self.surface || null,
          branch: structured.self.branch || null,
        };
      } else {
        probeFailed = true;                    // owns presence but unidentifiable → refuse
      }
    } catch {
      probeFailed = true;
    } finally {
      this.hibernateProbeInFlight = false;
    }
    // Conditions can change across the await — re-verify before retiring.
    if (this.closed || !this.active || this.candidate || this.standby) return;
    if (this.hostRequests.size || this.workerRequests.size || this.hostQueue.length) return;
    if (probeFailed) {
      this.hibernateSkipReason = 'presence-identity-unavailable';
      return;
    }
    this.hibernateSkipReason = null;
    this.presenceIdentity = identity;
    const worker = this.active;
    this.recordBaseline(worker);
    this.hibernatedTarget = worker.target;
    this.pendingWakeTarget = null;
    this.hibernatedAt = new Date().toISOString();
    this.hibernations++;
    this.active = null;
    this.status = 'hibernated';
    // A connection that owns a row must NOT let the worker remove it on the way
    // out; one without a row retires gracefully as usual.
    this.retireWorker(worker, 350, { preservePresence: Boolean(this.presenceIdentity) });
    this.startPresenceHeartbeat();
    this.writeState();
    log(`worker hibernated after ${Math.round((Date.now() - last) / 1000)}s idle — wakes on the next request${this.presenceIdentity ? ' (presence held by the supervisor)' : ''}`);
  }

  // B6 (2026-10-03): ask the worker which lane row it owns WITHOUT doing work.
  // The probe used to be an internal brain_sync checkpoint, which the lane
  // records as McpTaskCheckpoint — activity — so every hibernation stamped an
  // idle connection "working": 6 idle Codex connections on the founder's PC read
  // as active sessions without declared scope and held the doctor's SESSIONS
  // layer at a warning. Workers that predate the identity request answer
  // "Method not found"; for them (mixed versions while an install rolls out)
  // the checkpoint still answers the same question.
  async probePresenceIdentity(worker) {
    if (worker.identityProbe !== 'unsupported') {
      try {
        const result = await this.sendInternal(worker, PRESENCE_IDENTITY_METHOD, {}, 4000);
        worker.identityProbe = 'supported';
        // Anything but an object is unidentifiable (maybeHibernate refuses),
        // never "no lane row" — that would let the worker remove a row it owns.
        return isRecord(result) ? result : {};
      } catch (error) {
        if (error?.code !== METHOD_NOT_FOUND) throw error;
        worker.identityProbe = 'unsupported';
      }
    }
    const probe = await this.sendInternal(worker, 'tools/call', {
      name: 'brain_sync',
      arguments: { phase: 'checkpoint', include_context: false },
    }, 4000);
    return probe?.structuredContent || null;
  }

  // The last committed worker (B2). Called on every commit, when the first
  // worker's tool manifest is known, on a standby rollback, and at hibernation.
  recordBaseline(worker) {
    if (!worker) return;
    this.baseline = {
      version: worker.version || worker.target?.version || null,
      manifest: worker.manifest || null,
      manifestHash: worker.manifestHash || null,
      target: worker.target || null,
    };
  }

  baselineVersion() {
    return this.baseline?.version || this.baseline?.target?.version || this.hibernatedTarget?.version || null;
  }

  // Never-downgrade, the rule live pairs follow in checkForUpdate: an install
  // is worth noting for a sleeping pair only when it is dev or newer.
  newerThanBaseline(target) {
    const cmp = compareSemver(target.version, this.baselineVersion());
    return target.dev || cmp === null || cmp > 0;
  }

  // A wake may also resume the version it slept on (an equal-version reinstall).
  acceptsWakeTarget(target) {
    const cmp = compareSemver(target.version, this.baselineVersion());
    return target.dev || cmp === null || cmp >= 0;
  }

  // The installer copies every live file to .prev before it renames new ones
  // in, so .prev is a complete, consistent copy of the PREVIOUS install. It is a
  // safe place to resume only when that copy is the version this connection
  // last ran — the version the host's tool list still describes. Any other
  // version would be a swap no gate has seen; crash recovery used to boot
  // whatever .prev held.
  previousBaselineTarget(anchor) {
    if (!anchor?.path || anchor.source === 'rollback') return null;
    const previous = prevSnapshotTarget(anchor.path);
    const baseVersion = this.baselineVersion();
    if (!previous || !baseVersion || previous.version !== String(baseVersion)) return null;
    return previous;
  }

  // The package's own worker as it is on disk NOW. fallbackTarget carries the
  // version this supervisor started with, but an install (flat bundle) or an
  // npx cache refresh (direct-package launch) can replace the file since, and a
  // candidate booted under the old tag failed every attempt with "candidate
  // advertised vY, manifest says vX" (CF-2, 2026-10-03 review).
  currentFallbackTarget() {
    const target = this.fallbackTarget;
    const onDisk = workerFileVersion(target.path);
    if (!onDisk || onDisk === target.version) return target;
    return { ...target, version: onDisk, signature: `fallback:${target.path}:${onDisk}` };
  }

  // The package's own worker as a WAKE target (CF-1, 2026-10-03 review), or
  // null. A direct-package launch (`npx -y klypix-mcp`, the README's Claude
  // Desktop config) runs it whenever the managed runtime is older or failing;
  // it lives outside the managed directory, no install renames files under it,
  // so it is consistent whatever the runtime holds. In the flat bundle the
  // package's worker IS <brainDir>/klypix-mcp-worker.mjs — the managed runtime
  // itself — and nothing vouches for that file without a verifying manifest.
  packageWorker() {
    const file = this.fallbackTarget.path;
    if (within(path.dirname(this.runtimeManifest), file) || !fs.existsSync(file)) return null;
    return this.currentFallbackTarget();
  }

  // B1: a sleeping pair notes a newer install for the doctor and stays asleep.
  notePendingWake(target) {
    const next = target.signature !== this.hibernatedTarget?.signature
      && target.signature !== this.rejectedSignature
      && this.newerThanBaseline(target) ? target : null;
    if ((next?.signature || null) === (this.pendingWakeTarget?.signature || null)) return;
    this.pendingWakeTarget = next;
    this.writeState();
    if (next) log(`hibernated on v${this.baselineVersion()}; v${next.version} is installed and is validated on the next request`);
  }

  // Re-register the sleeping connection's lane row on the SAME cadence the
  // worker used, through the SAME shared upsertSession (one implementation,
  // one lock). Fields not supplied are preserved by the merge, so a declared
  // intent/file scope survives hibernation untouched.
  startPresenceHeartbeat() {
    this.stopPresenceHeartbeat();
    const who = this.presenceIdentity;
    if (!who) return;
    const beat = () => {
      try {
        upsertSession({
          brainPath: who.brainPath,
          id: who.id,
          client: who.client,
          surface: who.surface,
          branch: who.branch,
          channel: 'mcp',
          event: 'McpHibernated',
          transportStatus: 'pull-only',
          // ppid provenance: correlation only — the dead-host sweep never
          // probes a guessed pid (see agent-presence.mjs isDeadHostRow).
          hostPid: this.parentPid,
          hostPidSource: 'ppid',
        });
        // Hibernation intentionally has no model-context consumer. Peek only:
        // a best-effort UI warning may wake the human, but the durable note stays
        // pending/offered until the next host request wakes the worker.
        const pending = peekMessages({ brainPath: who.brainPath, sessionId: who.id });
        const fresh = pending.filter((message) => !this.hibernatedAnnouncements.has(message.id));
        if (fresh.length && this.sendHost({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: 'klypix-supervisor',
            data: `${formatReceivedMessages(fresh)}\nThe worker is hibernated; this is a UI preview only. The note remains queued for the next KLYPIX action.`,
          },
        })) {
          for (const message of fresh) this.hibernatedAnnouncements.add(message.id);
        }
      } catch { /* presence upkeep is best-effort; TTL is the backstop */ }
    };
    // ORDER MATTERS (caught by real-worker measurement, not by the fixture):
    // the retiring worker calls removeSession during its shutdown grace, so a
    // single beat fired now is immediately UNDONE and the row would stay gone
    // until the 60s tick — i.e. the session disappears from every peer for a
    // minute. Re-assert across the whole grace window, then settle into the
    // normal cadence.
    beat();
    for (const delay of [500, 1_200, 2_500, 5_000]) {
      const t = setTimeout(() => { if (this.presenceHeartbeat) beat(); }, delay);
      t.unref?.();
    }
    this.presenceHeartbeat = setInterval(beat, 60_000);
    this.presenceHeartbeat.unref?.();
  }

  stopPresenceHeartbeat() {
    if (this.presenceHeartbeat) clearInterval(this.presenceHeartbeat);
    this.presenceHeartbeat = null;
  }

  wake() {
    if (this.closed || this.active || this.candidate || this.waking) return;
    this.waking = true;
    this.pendingWakeTarget = null;
    log('waking hibernated worker');
    this.resolveWakeTarget()
      // resolveWakeTarget guards every read; a throw here is a bug, and booting
      // an unverified file is never the answer to one.
      .catch((error) => ({ target: null, retry: true, reason: `wake target unresolved: ${error?.message || error}` }))
      .then((plan) => {
        this.waking = false;
        if (this.closed || this.active || this.candidate) return;
        if (plan.target) this.startCandidate(plan.target, { recovery: true, wake: true });
        else if (plan.retry) this.deferWake(plan.reason);
        else this.settleRestartRequired(plan.reason);
      });
  }

  // A full read of the manifest, repeated while it fails integrity (or cannot be
  // read) for up to WAKE_INTEGRITY_WAIT_MS: an install renames its files one at
  // a time and commits the manifest last. Wakes (B3) and boots (K1) wait alike.
  async settledRuntime(runtime = this.runtimeWatch.read({ force: true })) {
    const deadline = Date.now() + WAKE_INTEGRITY_WAIT_MS;
    while (!runtime.ok && !runtime.absent && !this.closed && Date.now() < deadline) {
      await sleep(WAKE_INTEGRITY_POLL_MS);
      runtime = this.runtimeWatch.read({ force: true });
    }
    return runtime;
  }

  // B3 (2026-10-03): the wake re-reads the manifest instead of trusting the
  // target the pair went to sleep on. That target may be stale (an install
  // landed while it slept), and its path may sit in a directory an install is
  // renaming right now — booting it then loads a mixed module graph.
  async resolveWakeTarget() {
    const runtime = await this.settledRuntime();
    // What the pair last ran, and the package's own worker when it lives
    // outside the managed directory (CF-1: a direct-package launch).
    const anchor = this.baseline?.target || this.hibernatedTarget;
    const own = this.packageWorker();
    if (runtime.ok) {
      if (this.acceptsWakeTarget(runtime.target)) return { target: runtime.target };
      // Valid but OLDER than what this connection last ran. A pair that ran the
      // package's own worker (the runtime was older or failing when it started)
      // resumes that worker — what it ran, and what a fresh connection would
      // boot (selectInitialTarget prefers it over an older runtime). Before this
      // (CF-1, 2026-10-03 review) such a pair settled restart-required on its
      // first wake after every publish, with a "rollback" nobody had made.
      const ownAcceptable = own && this.acceptsWakeTarget(own) ? own : null;
      if (ownAcceptable && anchor?.source === 'package') return { target: ownAcceptable };
      // Otherwise a deliberate rollback. A live pair never downgrades in place,
      // so a sleeping one does not either: it resumes its own version from
      // .prev, and the rollback reaches it at the next reconnect.
      const previous = this.previousBaselineTarget(runtime.target);
      if (previous) {
        log(`installed runtime v${runtime.target.version} is older than v${previous.version}, which this connection ran — resuming v${previous.version} from .prev; the rollback applies at the next reconnect`);
        return { target: previous };
      }
      // The package's own worker at the version this pair ran, or newer: what a
      // fresh connection boots too, so no rollback is pending for this one.
      if (ownAcceptable) {
        log(`installed runtime v${runtime.target.version} is older than v${this.baselineVersion()}, which this connection ran — waking the package's own worker v${ownAcceptable.version}`);
        return { target: ownAcceptable };
      }
      return {
        target: null,
        reason: anchor?.source === 'package'
          ? `the package worker v${this.baselineVersion()} this connection ran changed on disk while idle, and the installed runtime v${runtime.target.version} is older than it`
          : `installed runtime v${runtime.target.version} is older than v${this.baselineVersion()}, which this connection last ran; a rollback applies at the next reconnect`,
      };
    }
    if (runtime.absent) {
      // No manifest at all: what a fresh connection boots is the package's own
      // worker. In the flat bundle that IS the managed worker, which nothing can
      // verify without a manifest (an uninstall in progress, or deleted by hand)
      // — a wake never boots it (CF-2).
      if (own) return { target: own };
      return { target: null, retry: true, reason: 'runtime manifest is absent' };
    }
    // Still failing after the wait: an install that stopped half-way. Never the
    // sleeping target's path inside the managed directory — resume .prev when it
    // holds this connection's version...
    // A pair that already resumed from .prev resumes that same copy — while it
    // still holds this connection's version (a new install overwrites .prev).
    const previous = anchor?.source === 'rollback'
      ? (fs.existsSync(anchor.path) && readBakedVersion(anchor.path) === String(this.baselineVersion()) ? anchor : null)
      : this.previousBaselineTarget(anchor);
    if (previous) {
      log(`runtime still fails integrity after ${WAKE_INTEGRITY_WAIT_MS} ms (${runtime.error}) — waking v${previous.version} from .prev`);
      return { target: previous };
    }
    // ...else whatever a fresh connection would boot: the package's own worker,
    // when it lives outside the managed directory — even when it is the very
    // target the pair slept on (CF-1: refusing that path deferred every wake of
    // a direct-package pair while the managed runtime failed integrity, though
    // its worker was never part of it).
    if (own) {
      log(`runtime still fails integrity after ${WAKE_INTEGRITY_WAIT_MS} ms (${runtime.error}) — waking the package's own worker v${own.version}`);
      return { target: own };
    }
    // In the flat bundle the package's own worker IS the failing runtime:
    // booting it is the mixed module graph this branch exists to avoid, and a
    // reconnect would meet the same files.
    return { target: null, retry: true, reason: runtime.error };
  }

  // Nothing consistent is left to boot: the runtime fails integrity and the
  // only fallback lives inside it. Stay asleep, still holding presence, and
  // answer what is queued with a retryable error. The next request tries again;
  // an interrupted install is re-run by the updater (15 min after a failure)
  // or by hand, and the wake then finds a verifying manifest.
  deferWake(reason) {
    // Recorded like the poller's integrity errors, so a manifest that verifies
    // again clears it even if no request comes (clearRuntimeError).
    if (reason && this.lastError !== reason) {
      if (this.runtimeError === null) this.errorBeforeRuntime = this.lastError;
      this.runtimeError = reason;
      this.lastError = reason;
    }
    // F6 (2026-10-03 review): not every refusal is an install mid-flight. A file
    // AV quarantined or edited by hand fails until a reinstall (an equal-version
    // reinstall that stopped half-way is not re-run by the updater, whose
    // receipts still read "current"). Count the refusals; once they span 10 min
    // the answer names the reinstall instead of "retry shortly", and the doctor
    // flags the pair from the first one. It stays asleep either way, so a
    // runtime that verifies again still wakes it with no reconnect.
    const now = new Date().toISOString();
    this.wakeDeferral = {
      reason: this.lastError || reason || 'runtime integrity',
      count: (this.wakeDeferral?.count || 0) + 1,
      since: this.wakeDeferral?.since || now,
      lastAt: now,
    };
    this.writeState();
    const persistent = this.wakeDeferral.count >= WAKE_DEFERRAL_REINSTALL_COUNT
      && Date.now() - Date.parse(this.wakeDeferral.since) >= this.wakeReinstallHintMs;
    const detail = persistent
      // This text reaches the AGENT as a tool error, so it names the repair's owner
      // and the read-only diagnosis, not an installer: reinstalling a shared live
      // install is the user's call (the doctor prints the exact command).
      ? `KLYPIX core files still do not verify (${this.lastError || 'runtime integrity'}) after ${this.wakeDeferral.count} attempts since ${this.wakeDeferral.since} — the install on this machine needs a repair: ask the user to run npx -y klypix-mcp@latest doctor, which shows the fix (do not run an installer yourself), then retry`
      : `KLYPIX core files do not verify (${this.lastError || 'runtime integrity'}) — an update may be mid-install; retry shortly`;
    for (const queued of this.hostQueue.splice(0)) this.failHostRequest(queued, detail);
    log(`wake deferred (${this.wakeDeferral.count}×): ${this.lastError || 'runtime integrity'} — no consistent worker to boot; staying hibernated, the next request retries`);
  }

  // B4 (2026-10-03): the pair has no worker, and the installed core cannot be
  // adopted without a reconnect. Keep presence held, answer every queued and
  // later host request at once with a retryable error, and start nothing — the
  // same bytes would fail the same gate on every attempt.
  settleRestartRequired(reason, extra = {}) {
    this.status = 'restart-required';
    if (reason) this.lastError = reason;
    this.pendingWakeTarget = null;
    // Receipt first: whoever reads it after the host hears the error must see why.
    this.writeState(extra);
    const detail = this.restartRequiredDetail();
    for (const queued of this.hostQueue.splice(0)) this.failHostRequest(queued, detail);
    this.sendHost({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', logger: 'klypix-supervisor', data: detail } });
    log(`no worker started (${this.lastError || 'incompatible runtime'}) — requests are answered with a reconnect error until the host reconnects`);
  }

  restartRequiredDetail() {
    return `${RESTART_REQUIRED_IDLE}${this.lastError ? ` (${this.lastError})` : ''}`;
  }

  // What a fresh connection boots: the installed runtime when its manifest
  // verifies (never older than the package's own worker, unless dev), else the
  // package's own worker.
  //
  // K1 (2026-10-03): a manifest that fails integrity, or cannot be read, is
  // usually an install mid-rename. In the flat bundle the package's own worker
  // is <brainDir>/klypix-mcp-worker.mjs — inside the directory being renamed —
  // and booting it at once could load a mixed module graph (a new worker beside
  // an old engine, or the reverse). So the boot waits for the install to settle,
  // as a wake does (B3), and then boots .prev's complete pre-install copy; only
  // without one does it boot the package's own worker, as before. Either way the
  // integrity error is recorded from the first receipt. A direct-package launch
  // keeps its worker outside the managed directory, which no install touches: it
  // boots at once. The host's first requests queue meanwhile (run()).
  async selectInitialTarget() {
    let runtime = this.runtimeWatch.read({ force: true });
    if (!runtime.ok && !runtime.absent && within(path.dirname(this.runtimeManifest), this.fallbackTarget.path)) {
      log(`runtime fails integrity at start (${runtime.error}) — waiting up to ${WAKE_INTEGRITY_WAIT_MS} ms for an install to settle`);
      runtime = await this.settledRuntime(runtime);
      if (!runtime.ok && !runtime.absent && !this.closed) {
        // Recorded the way the poller records it (noteRuntimeError), so a
        // manifest that verifies later clears it (clearRuntimeError).
        this.errorBeforeRuntime = this.lastError;
        this.runtimeError = runtime.error;
        this.lastError = runtime.error;
        const previous = prevSnapshotTarget(this.fallbackTarget.path);
        if (previous) {
          log(`runtime still fails integrity after ${WAKE_INTEGRITY_WAIT_MS} ms (${runtime.error}) — starting v${previous.version} from .prev, the complete copy of the previous install`);
          return previous;
        }
        log(`runtime still fails integrity after ${WAKE_INTEGRITY_WAIT_MS} ms (${runtime.error}) and .prev holds no worker — starting the package's own worker v${this.fallbackTarget.version}`);
        return this.fallbackTarget;
      }
    }
    if (!runtime.ok) return this.fallbackTarget;
    const cmp = compareSemver(runtime.target.version, this.fallbackTarget.version);
    return runtime.target.dev || cmp === null || cmp >= 0 ? runtime.target : this.fallbackTarget;
  }

  spawnWorker(target, role) {
    const child = spawn(process.execPath, [target.path, ...this.workerArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KLYPIX_MCP_SUPERVISED: '1',
        KLYPIX_MCP_SUPERVISOR_PID: String(process.pid),
        KLYPIX_MCP_CONNECTION_ID: this.connectionId,
        // Pin the session id across a hibernation wake (KLYPIX_SESSION_ID wins
        // resolveMcpSessionId's precedence chain) so the woken worker adopts the
        // row the supervisor kept alive instead of minting a second one. Hosts
        // that export their own id already resolve to the same value.
        ...(this.presenceIdentity?.id ? { KLYPIX_SESSION_ID: this.presenceIdentity.id } : {}),
        // The worker runs its own update poll, gated on its own environment. A
        // supervisor embedded with autoUpdate:false (the klypix-mcp/supervisor
        // API) receipted "off" while its worker still fetched and installed
        // (CF-5, 2026-10-03 review): the worker inherits the supervisor's setting.
        ...(this.autoUpdate ? {} : { KLYPIX_AUTO_UPDATE: '0' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const worker = {
      child,
      target,
      role,
      version: target.version,
      manifest: null,
      manifestHash: null,
      internal: new Map(),
      retiring: false,
      exited: false,
    };
    child.stdout.on('data', createLineReader(
      message => this.onWorkerMessage(worker, message),
      (error, raw) => this.onWorkerProtocolError(worker, error, raw),
    ));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', error => this.onWorkerError(worker, error));
    child.on('exit', (code, signal) => this.onWorkerExit(worker, code, signal));
    return worker;
  }

  send(worker, message) {
    if (!worker || worker.exited || !worker.child.stdin.writable) throw new Error('worker stdin is unavailable');
    worker.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendHost(message) {
    if (this.closed) return false;
    if (process.stdout.destroyed || !process.stdout.writable) {
      this.hostTransportState = 'impaired';
      this.lastHostWriteError = 'host stdout is unavailable';
      this.writeState();
      return false;
    }
    try {
      const accepted = process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error || this.closed) return;
        this.hostTransportState = 'impaired';
        this.lastHostWriteError = String(error.message || error).slice(0, 240);
        this.writeState();
      });
      if (!accepted) {
        this.hostTransportState = 'backpressured';
        this.hostBackpressuredAt = new Date().toISOString();
        this.writeState();
      } else if (this.hostTransportState !== 'connected') {
        this.hostTransportState = 'connected';
        this.hostBackpressuredAt = null;
        this.lastHostWriteError = null;
        this.writeState();
      }
      return true;
    } catch (error) {
      this.hostTransportState = 'impaired';
      this.lastHostWriteError = String(error?.message || error).slice(0, 240);
      this.writeState();
      return false;
    }
  }

  sendInternal(worker, method, params = {}, timeoutMs = this.timeoutMs) {
    const id = `${INTERNAL_PREFIX}${process.pid}_${++this.internalCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.internal.delete(idKey(id));
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      worker.internal.set(idKey(id), { resolve, reject, timer, method });
      try { this.send(worker, { jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        worker.internal.delete(idKey(id));
        reject(error);
      }
    });
  }

  onWorkerMessage(worker, message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = worker.internal.get(idKey(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        worker.internal.delete(idKey(message.id));
        // Keep the JSON-RPC code: "Method not found" is how an older worker
        // says it predates an internal request (probePresenceIdentity).
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || `${pending.method} failed`), { code: message.error.code }));
        else pending.resolve(message.result);
        return;
      }
    }
    if (worker !== this.active) return;

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const key = idKey(message.id);
      const hostRequest = this.hostRequests.get(key);
      // A completion request is only authoritative after the worker accepts it.
      // Invalid/conflicting result evidence returns a tool-level isError and
      // deliberately keeps the task live for replay after upgrade/hibernation.
      if (hostRequest?.taskCompletion
        && !message.error
        && message.result?.isError !== true) {
        this.taskScope = null;
      }
      this.hostRequests.delete(key);
      if (this.initializeRequest && key === idKey(this.initializeRequest.id) && message.result?.serverInfo?.version) {
        worker.version = String(message.result.serverInfo.version);
      }
    } else if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.workerRequests.set(idKey(message.id), message.id);
    }
    this.sendHost(message);
    this.maybeCommitCandidate();
  }

  onWorkerProtocolError(worker, error, raw) {
    const detail = `invalid JSON-RPC from worker v${worker.version}: ${error.message}`;
    if (worker === this.candidate) this.rejectCandidate(detail);
    else {
      this.lastError = detail;
      log(detail, raw.slice(0, 160));
      this.writeState();
    }
  }

  onWorkerError(worker, error) {
    const detail = `worker v${worker.version} error: ${error.message}`;
    if (worker === this.candidate) this.rejectCandidate(detail);
    else {
      this.lastError = detail;
      log(detail);
      this.writeState();
    }
  }

  onWorkerExit(worker, code, signal) {
    worker.exited = true;
    for (const pending of worker.internal.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`worker exited (${code ?? signal ?? 'unknown'})`));
    }
    worker.internal.clear();
    if (worker.retiring || this.closed) return;
    if (worker === this.candidate) {
      this.rejectCandidate(`candidate worker exited before activation (${code ?? signal ?? 'unknown'})`, false);
      return;
    }
    if (worker === this.standby) {
      this.standby = null;
      return;
    }
    if (worker !== this.active) return;

    const failedTarget = worker.target;
    this.active = null;
    this.failInflight(`KLYPIX worker v${worker.version} restarted unexpectedly; retry this tool call.`);
    if (this.standby && !this.standby.exited) {
      const rollback = this.standby;
      this.standby = null;
      this.rejectedSignature = failedTarget.signature;
      rollback.role = 'active';
      this.active = rollback;
      this.recordBaseline(rollback);
      this.status = 'rolled-back';
      this.lastError = `worker v${worker.version} exited during rollback grace`;
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      this.replayTaskScope(rollback).catch(() => {});
      this.writeState();
      log(`rolled back to worker v${rollback.version}`);
      return;
    }

    this.status = 'recovering';
    this.lastError = `active worker exited (${code ?? signal ?? 'unknown'})`;
    this.writeState();
    setTimeout(() => {
      if (this.closed || this.active || this.candidate) return;
      // Pre-handshake death: the candidate path NEEDS the host's initialize,
      // but that message is parked in hostQueue (active=null) and only flushes
      // on commit — a candidate would wedge in pendingTarget forever
      // (review-caught). Respawn a DIRECT active worker like first boot; the
      // queued initialize then flows to it naturally. Bounded by the same
      // recovery budget so a crash-looping worker still settles to failure.
      if (!this.initializeRequest || !this.hostInitialized) {
        if (this.lastFailedSignature && this.lastFailedSignature !== failedTarget.signature) this.recoveryAttempts = 0;
        this.lastFailedSignature = failedTarget.signature;
        this.recoveryAttempts++;
        if (this.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
          this.status = 'recovery-failed';
          this.rejectedSignature = failedTarget.signature;
          const detail = `KLYPIX worker unavailable (crashed ${this.recoveryAttempts}× before the host handshake) — /mcp reconnect to restart.`;
          for (const queued of this.hostQueue.splice(0)) this.failHostRequest(queued, detail);
          this.writeState({ recoveryAttempts: this.recoveryAttempts });
          log(`pre-handshake recovery FAILED after ${this.recoveryAttempts} attempts`);
          return;
        }
        this.active = this.spawnWorker(failedTarget, 'active');
        this.status = 'awaiting-initialize';
        this.writeState();
        this.flushHostQueue();
        return;
      }
      this.startCandidate(failedTarget, { recovery: true });
    }, 150).unref?.();
  }

  failInflight(message) {
    for (const { id } of this.hostRequests.values()) {
      this.sendHost({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    }
    this.hostRequests.clear();
    this.workerRequests.clear();
  }

  // A host request the worker never answers must not pin active+candidate
  // workers (2× RAM) forever: past the deadline we answer the host with an
  // error (its own client timeout has long fired) and stop counting it against
  // candidate commit.
  expireAbandonedRequests(maxAgeMs = 120_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, entry] of this.hostRequests) {
      if ((entry?.ts || 0) >= cutoff) continue;
      this.hostRequests.delete(key);
      this.sendHost({ jsonrpc: '2.0', id: entry.id, error: { code: -32603, message: 'KLYPIX worker did not answer this request within 120s; it was abandoned so a pending worker swap can proceed.' } });
    }
  }

  captureTaskScope(message) {
    if (message?.method !== 'tools/call' || message.params?.name !== 'brain_sync') return null;
    const args = message.params?.arguments || {};
    const phase = args.phase || 'checkpoint';
    if (phase === 'complete') {
      if (this.taskScope && Object.prototype.hasOwnProperty.call(args, 'results')) {
        this.taskScope.resultClaimsPending = true;
      }
      return { taskCompletion: true };
    }
    const nextFiles = Array.isArray(args.files) ? args.files.map(String) : [];
    if (phase === 'start' || !this.taskScope) {
      this.taskScope = {
        intent: String(args.intent || ''),
        files: [...new Set(nextFiles)],
        resultClaimsPending: Object.prototype.hasOwnProperty.call(args, 'results'),
      };
      return { taskCompletion: false };
    }
    if (args.intent) this.taskScope.intent = String(args.intent);
    this.taskScope.files = [...new Set([...(this.taskScope.files || []), ...nextFiles])];
    if (Object.prototype.hasOwnProperty.call(args, 'results')) this.taskScope.resultClaimsPending = true;
    return { taskCompletion: false };
  }

  // A retryable JSON-RPC error for one host request — used instead of silent
  // infinite queueing once worker recovery has genuinely failed.
  failHostRequest(message, detail) {
    if (!Object.prototype.hasOwnProperty.call(message || {}, 'id') || !message.method) return;
    this.sendHost({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: detail } });
  }

  onHostMessage(message) {
    if (this.closed) return;
    this.lastHostMessageAt = new Date().toISOString();
    // An inbound request proves stdin is alive, not that the response pipe
    // recovered. Keep outbound impairment until write/drain proves it cleared.
    if (this.hostTransportState === 'starting') this.hostTransportState = 'connected';
    // MCP initialization is the one host-neutral source of client identity.
    // Persist only bounded name/version metadata; never capabilities, prompts,
    // environment variables, or request content.
    if (message?.method === 'initialize') {
      const info = message?.params?.clientInfo || {};
      this.clientInfo = {
        name: String(info.name || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 120),
        version: String(info.version || '').replace(/[\r\n]/g, ' ').slice(0, 80) || null,
      };
    }
    const activityNow = Date.now();
    if (activityNow - this.lastActivityStateWriteAt >= 60_000) {
      this.lastActivityStateWriteAt = activityNow;
      this.writeState();
    }
    if (!this.active) {
      // A settled restart-required (B4): nothing is starting, so a queued
      // request would wait forever. Same retryable-error contract as below.
      if (this.status === 'restart-required' && !this.candidate && !this.recoveryTimer && !this.waking) {
        this.failHostRequest(message, this.restartRequiredDetail());
        return;
      }
      // recovery-failed with no candidate in flight = a settled outage: answer
      // id-bearing requests with a retryable error (the host can surface it and
      // retry after /mcp reconnect); notifications are dropped. While a recovery
      // attempt IS still running, keep queueing — bounded, with the overflow
      // failed loudly rather than swallowed.
      if (this.status === 'recovery-failed' && !this.candidate && !this.recoveryTimer) {
        this.failHostRequest(message, `KLYPIX worker unavailable (recovery failed after ${RECOVERY_MAX_ATTEMPTS} attempts${this.lastError ? `: ${this.lastError}` : ''}) — /mcp reconnect to restart.`);
        return;
      }
      if (this.hostQueue.length >= HOST_QUEUE_MAX) {
        this.failHostRequest(message, 'KLYPIX worker is recovering and its request queue is full — retry shortly.');
        return;
      }
      this.hostQueue.push(message);
      // A hibernated pair wakes on demand: the queued message flushes to the
      // new worker the moment the candidate commits, so the host sees latency,
      // never an error, and never a reconnect.
      if (this.status === 'hibernated') this.wake();
      return;
    }
    if (message?.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.initializeRequest = JSON.parse(JSON.stringify(message));
    }
    if (message?.method === 'notifications/initialized') {
      this.initializedNotification = JSON.parse(JSON.stringify(message));
      this.hostInitialized = true;
    }
    const taskRequest = this.captureTaskScope(message);

    if (message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.hostRequests.set(idKey(message.id), { id: message.id, ts: Date.now(), ...taskRequest });
    } else if (!message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.workerRequests.delete(idKey(message.id));
    }
    try { this.send(this.active, message); }
    catch (error) {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.hostRequests.delete(idKey(message.id));
        this.sendHost({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      }
    }
    if (message?.method === 'notifications/initialized') {
      this.status = 'ready';
      this.recoveryAttempts = 0;   // a completed handshake proves the worker healthy — fresh budget
      this.lastFailedSignature = null;
      this.writeState();
      const first = this.active;
      this.loadToolManifest(first).catch(error => {
        this.lastError = `initial tool manifest unavailable: ${error.message}`;
        this.writeState();
      }).finally(() => {
        // The first worker is never "committed"; it is the first baseline.
        if (first === this.active) this.recordBaseline(first);
        this.checkForUpdate();
      });
    }
  }

  async loadToolManifest(worker) {
    const tools = [];
    let cursor;
    do {
      const result = await this.sendInternal(worker, 'tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = result?.nextCursor;
    } while (cursor);
    worker.manifest = tools;
    worker.manifestHash = manifestHash(tools);
    return tools;
  }

  async replayTaskScope(worker) {
    if (!this.taskScope) return;
    await this.sendInternal(worker, 'tools/call', {
      name: 'brain_sync',
      arguments: {
        // This is transport replay, not a user task boundary. A real `start`
        // clears the durable pending-result marker and would turn hot reload
        // into an evidence-bypass path after a blocked completion.
        phase: 'checkpoint',
        intent: this.taskScope.intent || 'Continue the active task after a transparent KLYPIX worker upgrade.',
        files: this.taskScope.files || [],
        include_context: false,
      },
    });
  }

  async startCandidate(target, { recovery = false, afterRejection = null, wake = false } = {}) {
    if (this.closed || this.candidate) {
      this.pendingTarget = target;
      return;
    }
    if (!this.initializeRequest || !this.hostInitialized) {
      this.pendingTarget = target;
      return;
    }
    this.pendingTarget = null;
    this.status = recovery ? 'recovering' : 'validating-update';
    const candidate = this.spawnWorker(target, 'candidate');
    // Set when this candidate resumes .prev because the installed core was
    // rejected while idle: it serves, but the connection still needs a reconnect.
    candidate.afterRejection = afterRejection;
    // A hibernated pair waking, as opposed to a crash recovery (the log says which).
    candidate.wake = wake === true;
    this.candidate = candidate;
    this.writeState();
    try {
      const init = JSON.parse(JSON.stringify(this.initializeRequest));
      const initResult = await this.sendInternal(candidate, 'initialize', init.params || {});
      candidate.version = String(initResult?.serverInfo?.version || target.version);
      if (target.version && candidate.version !== target.version) {
        throw new Error(`candidate advertised v${candidate.version}, manifest says v${target.version}`);
      }
      this.send(candidate, this.initializedNotification || { jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.loadToolManifest(candidate);

      // B2 (2026-10-03): a wake or a crash recovery has no live worker, and
      // comparing with `this.active?.manifest || []` waved every such candidate
      // through — no tool check, no major check. The last committed worker is
      // what the host is still using, so it is what the candidate must accept.
      const reference = this.active || this.baseline;
      const previousTools = reference?.manifest || [];
      const compatibility = toolCompatibility(previousTools, candidate.manifest);
      const oldVersion = reference?.version || reference?.target?.version;
      const oldSemver = parseSemver(oldVersion);
      const nextSemver = parseSemver(candidate.version);
      if (oldSemver && nextSemver && oldSemver[0] !== nextSemver[0]) {
        throw deterministicError(`major upgrade v${oldVersion} → v${candidate.version} requires reconnect`);
      }
      if (!compatibility.ok) {
        const details = [
          compatibility.removed.length ? `removed tools: ${compatibility.removed.join(', ')}` : '',
          compatibility.changed.length ? `incompatible schemas: ${compatibility.changed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        throw deterministicError(`breaking tool manifest requires reconnect (${details})`);
      }
      await this.replayTaskScope(candidate);
      candidate.compatibility = compatibility;
      candidate.ready = true;
      this.status = recovery ? 'recovery-ready' : 'update-ready';
      this.writeState();
      this.maybeCommitCandidate();
    } catch (error) {
      const deterministic = error?.deterministic === true;
      // An exit/error handler may already have rejected this candidate (and a
      // retry may own the slot by now) — never reject a different one.
      if (this.candidate === candidate) this.rejectCandidate(error.message, true, { deterministic });
      if (!deterministic && recovery && !this.active) this.tryPreviousWorker(target, { wake: candidate.wake });
    }
  }

  rejectCandidate(reason, terminate = true, { deterministic = false } = {}) {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;
    this.lastError = reason;
    if (terminate && !candidate.exited) this.retireWorker(candidate, 0);
    if (!this.active && deterministic) {
      this.rejectWhileIdle(candidate, reason);
      return;
    }
    this.status = this.active ? 'restart-required' : 'recovery-failed';
    if (!this.active) {
      // RECOVERY rejection: transient spawn failures (0xC0000142-class) must
      // retry with backoff, not blacklist the only installed runtime forever.
      // A DIFFERENT target signature (fresh install landed mid-recovery) gets a
      // fresh attempt budget — the counter must not starve the fix.
      if (this.lastFailedSignature && this.lastFailedSignature !== candidate.target.signature) this.recoveryAttempts = 0;
      this.lastFailedSignature = candidate.target.signature;
      this.recoveryAttempts++;
      if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }   // never stack retry timers
      if (this.recoveryAttempts < RECOVERY_MAX_ATTEMPTS) {
        const delay = Math.min(RECOVERY_BACKOFF_BASE_MS * 2 ** (this.recoveryAttempts - 1), RECOVERY_BACKOFF_MAX_MS);
        // Signature STAYS blacklisted during the backoff window so the 1s
        // checkForUpdate poller cannot burn the attempt budget at poll cadence
        // (review-caught); the timer lifts it right before the retry.
        this.rejectedSignature = candidate.target.signature;
        this.writeState({ rejectedVersion: candidate.version || candidate.target.version, recoveryAttempts: this.recoveryAttempts, nextRetryMs: delay });
        log(`recovery attempt ${this.recoveryAttempts}/${RECOVERY_MAX_ATTEMPTS} failed (${reason}); retrying in ${delay}ms`);
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (this.closed || this.active || this.candidate) return;
          this.rejectedSignature = null;
          this.startCandidate(candidate.target, { recovery: true, afterRejection: candidate.afterRejection || null, wake: candidate.wake });
        }, delay);
        this.recoveryTimer.unref?.();
        return;
      }
      // Final failure: stop pretending. Blacklist the signature, fail everything
      // queued with a retryable error, and tell the host via MCP logging.
      this.stopPresenceHeartbeat();
      if (this.presenceIdentity) {
        const who = this.presenceIdentity;
        try {
          upsertSession({
            brainPath: who.brainPath, id: who.id, client: who.client,
            surface: who.surface, branch: who.branch, channel: 'mcp',
            event: 'McpRecoveryFailed', transportStatus: 'impaired', hostPid: this.parentPid,
            hostPidSource: 'ppid',   // correlation only, never liveness-probed
          });
        } catch { /* TTL remains the backstop */ }
      }
      this.rejectedSignature = candidate.target.signature;
      const detail = `KLYPIX worker unavailable (recovery failed after ${RECOVERY_MAX_ATTEMPTS} attempts: ${reason}) — /mcp reconnect to restart.`;
      for (const queued of this.hostQueue.splice(0)) this.failHostRequest(queued, detail);
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', logger: 'klypix-supervisor', data: detail } });
      this.writeState({ rejectedVersion: candidate.version || candidate.target.version, recoveryAttempts: this.recoveryAttempts });
      log(`recovery FAILED permanently after ${this.recoveryAttempts} attempts: ${reason}`);
      return;
    }
    this.rejectedSignature = candidate.target.signature;
    this.writeState({ rejectedVersion: candidate.version || candidate.target.version });
    log(`kept v${this.active?.version || 'none'}; rejected v${candidate.version || candidate.target.version}: ${reason}`);
  }

  // B4 (2026-10-03): a major-version or breaking-tool rejection is DETERMINISTIC:
  // the same bytes fail the same gate on every attempt. With no live worker the
  // old path retried them with backoff (1, 2, 4, 8 s), declared recovery-failed,
  // and meanwhile booted whatever .prev held. Now: one attempt at the .prev copy
  // of the version this connection last ran, else a settled restart-required.
  rejectWhileIdle(candidate, reason) {
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    const rejectedVersion = candidate.version || candidate.target.version;
    this.rejectedSignature = candidate.target.signature;
    const previous = this.previousBaselineTarget(candidate.target);
    if (!previous) {
      this.settleRestartRequired(reason, { rejectedVersion });
      return;
    }
    this.status = 'recovering';
    this.writeState({ rejectedVersion });
    log(`rejected v${rejectedVersion} while idle (${reason}); resuming v${previous.version} from .prev`);
    const afterRejection = { signature: candidate.target.signature, reason, version: rejectedVersion };
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.closed || this.active || this.candidate) return;
      this.startCandidate(previous, { recovery: true, afterRejection, wake: candidate.wake });
    }, 150);
    this.recoveryTimer.unref?.();
  }

  maybeCommitCandidate() {
    if (!this.candidate?.ready) return;
    // A woken worker owns its lane row again — hand presence back before it
    // becomes active so exactly one writer heartbeats at any moment.
    this.stopPresenceHeartbeat();
    this.expireAbandonedRequests();
    if (this.hostRequests.size || this.workerRequests.size) return;
    const next = this.candidate;
    const previous = this.active;
    // B5 (2026-10-03): a worker that wakes or recovers into a version other than
    // the last committed one is a swap too. It used to go uncounted and unnoticed
    // by the host: no hotReloads, no tools/list_changed for its new tools.
    const reference = previous || this.baseline;
    const swappedWhileIdle = !previous && Boolean(this.baseline)
      && String(this.baseline.version || '') !== String(next.version || '');
    // A .prev resume after an idle rejection serves the old tools, but the
    // installed core still needs the reconnect it was rejected for.
    const rejection = next.afterRejection || null;
    this.candidate = null;
    next.role = 'active';
    this.active = next;
    this.rejectedSignature = rejection ? rejection.signature : null;
    this.recoveryAttempts = 0;   // a committed worker resets the retry budget
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    this.status = rejection ? 'restart-required' : 'ready';
    this.lastError = rejection ? rejection.reason : null;
    this.runtimeError = null;
    this.errorBeforeRuntime = null;
    this.wakeDeferral = null;
    this.lastSwapAt = new Date().toISOString();
    if (previous || swappedWhileIdle) this.hotReloads++;
    this.recordBaseline(next);

    if (previous) {
      previous.role = 'standby';
      this.standby = previous;
      setTimeout(() => {
        if (this.standby === previous) {
          this.standby = null;
          // The candidate already owns the same logical presence row. stdin EOF
          // would run the old worker's graceful mcpPresence.stop() and remove the
          // candidate's shared scope; signal retirement skips that stale cleanup.
          this.retireWorker(previous, 250, { preservePresence: true });
        }
      }, this.rollbackGraceMs).unref?.();
    }

    this.writeState();
    this.flushHostQueue();
    if (reference && reference.manifestHash !== next.manifestHash) {
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    // F10 (2026-10-03 review): say what happened. A .prev resume after an idle
    // rejection used to log "recovered … without reconnect" while the pair
    // settled restart-required, and every worker-less swap said "on wake".
    if (previous) log(`hot-swapped worker v${previous.version} → v${next.version} without reconnect`);
    else if (rejection) log(`resumed v${next.version} from .prev; v${rejection.version || '?'} needs /mcp reconnect (${rejection.reason})`);
    else if (swappedWhileIdle) log(`hot-swapped worker v${reference.version} → v${next.version} ${next.wake ? 'on wake' : 'on recovery'}, without reconnect`);
    else log(`${next.wake ? 'woke' : 'recovered'} worker v${next.version} without reconnect`);

    // MV-1 (2026-10-03 review): a target parked while this candidate validated
    // passes the same gate the poller applies, against the worker just
    // committed. A --force rollback that landed while a wake's .prev candidate
    // validated was parked (nothing was active to compare it with) and then
    // hot-swapped in here — a live pair never downgrades in place.
    if (this.pendingTarget) {
      const pending = this.pendingTarget;
      this.pendingTarget = null;
      if (!this.skipsUpdate(pending)) queueMicrotask(() => this.startCandidate(pending));
    }
  }

  retireWorker(worker, graceMs = 250, { preservePresence = false } = {}) {
    if (!worker || worker.exited) return;
    worker.retiring = true;
    if (preservePresence) {
      // HIBERNATION ONLY. stdin EOF triggers the worker's graceful stop, which
      // REMOVES its presence row — correct when the connection is ending, wrong
      // when it is merely sleeping (the supervisor is about to hold that row).
      // Signal-terminate instead so the row is never removed and peers observe
      // no gap at all, not even a sub-second one.
      try { worker.child.kill('SIGTERM'); } catch { /* */ }
      return;
    }
    try { worker.child.stdin.end(); } catch { /* */ }
    if (graceMs <= 0) {
      try { worker.child.kill('SIGTERM'); } catch { /* */ }
      return;
    }
    setTimeout(() => {
      if (!worker.exited) {
        try { worker.child.kill('SIGTERM'); } catch { /* */ }
      }
    }, graceMs).unref?.();
  }

  // A transient recovery failure may also resume .prev — but only the copy of
  // the version this connection last ran (previousBaselineTarget).
  tryPreviousWorker(target, { wake = false } = {}) {
    const previous = this.previousBaselineTarget(target);
    if (!previous) return;
    setTimeout(() => {
      if (!this.closed && !this.active && !this.candidate) this.startCandidate(previous, { recovery: true, wake });
    }, 150).unref?.();
  }

  async checkForUpdate() {
    if (this.closed || this.checking) return;
    if (this.recoveryTimer) return;   // a recovery backoff owns the next attempt — the poller must not preempt it
    this.checking = true;
    try {
      let runtime = this.runtimeWatch.read();
      if (!runtime.ok) return this.noteRuntimeError(runtime);
      this.clearRuntimeError();
      // B1 (2026-10-03): a pair with no worker that is asleep — hibernated, or
      // settled restart-required — never starts a candidate here. The guard
      // below compared the manifest with `this.active?.version`, which is
      // undefined while hibernated; compareSemver(v, undefined) is null, so it
      // never returned, and every idle pair woke about a second after it fell
      // asleep (since 1.57.0). Only a host request wakes a sleeping pair.
      if (!this.active && !this.candidate && (this.status === 'hibernated' || this.status === 'restart-required')) {
        if (this.status === 'hibernated' && !this.waking) this.notePendingWake(runtime.target);
        return;
      }
      if (this.skipsUpdate(runtime.target)) return;
      // The stat gate only ever SKIPS work: a candidate starts from a full read.
      if (runtime.cached) {
        runtime = this.runtimeWatch.read({ force: true });
        if (!runtime.ok) return this.noteRuntimeError(runtime);
        if (this.skipsUpdate(runtime.target)) return;
      }
      this.startCandidate(runtime.target);
    } finally {
      this.checking = false;
    }
  }

  skipsUpdate(target) {
    if (target.signature === this.active?.target.signature || target.signature === this.candidate?.target.signature || target.signature === this.rejectedSignature) return true;
    // Never-downgrade compares with the last COMMITTED worker when none is
    // active (MV-1, 2026-10-03 review): while a wake's or a recovery's
    // candidate validates, `this.active` is null, compareSemver(v, undefined) is
    // null — the hole B1 closed for hibernated pairs — and an older manifest was
    // parked and then started. A dev target still goes through.
    const reference = this.active ? (this.active.version || this.active.target.version) : this.baselineVersion();
    const cmp = compareSemver(target.version, reference);
    return !target.dev && cmp !== null && cmp <= 0;
  }

  // B8: while the runtime fails integrity (an install mid-rename), every 1 s
  // poll used to rewrite the state file — ~15 renames a second machine-wide,
  // against files 15 supervisors and the doctor read. Write on change only.
  noteRuntimeError(runtime) {
    if (runtime.absent) {
      if (this.pendingWakeTarget) {
        this.pendingWakeTarget = null;
        this.writeState();
      }
      return;
    }
    if (this.lastError === runtime.error) return;
    if (this.runtimeError === null) this.errorBeforeRuntime = this.lastError;
    this.runtimeError = runtime.error;
    this.lastError = runtime.error;
    this.writeState();
  }

  // A runtime that verifies again must not keep reporting the integrity error
  // it recovered from; whatever lastError it displaced comes back.
  clearRuntimeError() {
    if (this.runtimeError === null && !this.wakeDeferral) return;
    const recorded = this.runtimeError;
    const before = this.errorBeforeRuntime;
    const deferred = Boolean(this.wakeDeferral);
    this.runtimeError = null;
    this.errorBeforeRuntime = null;
    // A runtime that verifies again is bootable: the next wake will not defer.
    this.wakeDeferral = null;
    const restore = recorded !== null && this.lastError === recorded;
    if (restore) this.lastError = before;
    if (restore || deferred) this.writeState();
  }

  scheduleAutoUpdate() {
    if (this.closed || !this.autoUpdate || process.env.KLYPIX_MCP_AUTO_UPDATE_CHILD === '1') return;
    spawnAutoUpdateHelper({
      brainDir: path.dirname(this.runtimeManifest),
      currentVersion: this.active?.version || this.fallbackTarget.version,
    });
  }

  flushHostQueue() {
    const queued = this.hostQueue.splice(0);
    for (const message of queued) this.onHostMessage(message);
  }

  async run() {
    this.bootedAt = new Date().toISOString();
    fs.mkdirSync(this.stateDir, { recursive: true });
    // Opportunistic cleanup of dead supervisor receipts and leftover tmp files
    // (cleanSupervisorStateDir has the rules).
    try { cleanSupervisorStateDir(this.stateDir); } catch { /* */ }

    // The host transport is wired BEFORE the first worker is chosen (K1): the
    // choice may wait out an install mid-rename, and meanwhile the host's first
    // requests queue (onHostMessage queues while no worker is active) and flush
    // to the worker below. A host that goes away during the wait still closes
    // this process, so its end/close handlers are registered first too.
    const finished = new Promise(resolve => {
      this.resolveRun = resolve;
      process.stdin.once('end', () => this.close());
      process.stdin.once('close', () => this.close());
      process.once('SIGINT', () => this.close());
      process.once('SIGTERM', () => this.close());
    });

    process.stdout.on('error', (error) => {
      if (this.closed) return;
      this.hostTransportState = 'impaired';
      this.lastHostWriteError = String(error?.message || error).slice(0, 240);
      this.writeState();
      // A broken response pipe cannot deliver MCP results or receipts. Closing
      // removes the misleading live row; unacknowledged lane messages remain on
      // disk and replay when the supported session reconnects.
      if (['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) this.close();
    });
    process.stdout.on('drain', () => {
      if (this.closed || this.hostTransportState !== 'backpressured') return;
      this.hostTransportState = 'connected';
      this.hostBackpressuredAt = null;
      this.lastHostWriteError = null;
      this.writeState();
    });

    process.stdin.on('data', createLineReader(
      message => this.onHostMessage(message),
      (error, raw) => {
        log(`invalid JSON-RPC from host: ${error.message}`, raw.slice(0, 160));
        this.sendHost({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      },
    ));

    const initial = await this.selectInitialTarget();
    if (this.closed) return finished;
    this.active = this.spawnWorker(initial, 'active');
    this.status = 'awaiting-initialize';
    this.writeState();
    this.flushHostQueue();

    this.poller = setInterval(() => this.checkForUpdate(), Math.max(50, this.pollMs));
    this.poller.unref?.();
    this.autoUpdateStarter = setTimeout(
      () => this.scheduleAutoUpdate(),
      Math.max(0, this.autoUpdateStartDelayMs),
    );
    this.autoUpdateStarter.unref?.();
    this.autoUpdatePoller = setInterval(
      () => this.scheduleAutoUpdate(),
      Math.max(60000, this.autoUpdatePollMs),
    );
    this.autoUpdatePoller.unref?.();

    if (this.hibernateIdleMs) {
      this.hibernationTimer = setInterval(() => { this.maybeHibernate().catch(() => {}); }, Math.max(1_000, Math.min(60_000, this.hibernateIdleMs)));
      this.hibernationTimer.unref?.();
    }

    // Host watchdog: shutdown is otherwise 100% stdin-EOF-dependent, and a
    // host that dies holding pipes open (or a wedged IDE) pinned this pair —
    // supervisor AND worker — indefinitely. The parent pid is a cheap,
    // platform-neutral liveness signal; EPERM still means alive.
    if (this.parentPid && this.parentPid > 1) {
      this.parentWatchdog = setInterval(() => {
        try { process.kill(this.parentPid, 0); }
        catch (error) {
          if (error?.code !== 'EPERM') { log('host process is gone — closing the connection pair'); this.close(); }
        }
      }, 30_000);
      this.parentWatchdog.unref?.();
    }

    await finished;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poller);
    clearInterval(this.parentWatchdog);
    clearInterval(this.hibernationTimer);
    // The connection is ending: stop holding its row and remove it, so a
    // hibernated-then-closed session never lingers as a ghost peer.
    this.stopPresenceHeartbeat();
    if (!this.active && this.presenceIdentity) {
      const who = this.presenceIdentity;
      this.presenceIdentity = null;
      // Same removal the worker performs on its own graceful stop.
      try { removeSession({ brainPath: who.brainPath, id: who.id, channel: 'mcp' }); }
      catch { /* TTL prunes it either way */ }
    }
    clearTimeout(this.autoUpdateStarter);
    clearInterval(this.autoUpdatePoller);
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    // Real shutdown grace: stdin EOF lets the worker run its own presence
    // cleanup (stopRuntimePresence/removeSession). An instant SIGTERM is
    // TerminateProcess on Windows — the cleanup never runs and every normally
    // closed session leaves a ghost "live" lane row for the TTL window (the
    // "cleans up automatically" claim was false on exactly this path). SIGTERM
    // stays as the 350ms backstop; the deliberately NOT-unref'd exit delay
    // holds this process open just long enough to deliver it.
    const workers = [this.active, this.candidate, this.standby].filter(w => w && !w.exited);
    for (const worker of workers) this.retireWorker(worker, 350);
    try { fs.unlinkSync(this.stateFile); } catch { /* */ }
    if (workers.length) setTimeout(() => this.resolveRun?.(), 400);
    else this.resolveRun?.();
  }
}

export async function runMcpSupervisor(options) {
  const supervisor = new Supervisor(options);
  await supervisor.run();
}

export const __test = {
  schemaAcceptsPrevious,
  toolCompatibility,
  compareSemver,
  atomicJson,
  createRuntimeWatch,
  cleanSupervisorStateDir,
  deadSupervisorReceipt,
  pidState,
  DEFAULT_AUTO_UPDATE_POLL_MS,
  DEAD_RECEIPT_GRACE_MS,
  PRESENCE_IDENTITY_METHOD,
  RESTART_REQUIRED_IDLE,
};
