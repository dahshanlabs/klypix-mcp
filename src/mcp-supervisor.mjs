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
import { formatReceivedMessages, peekMessages, removeSession, upsertSession } from './agent-presence.mjs';

const INTERNAL_PREFIX = '__klypix_supervisor__';
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ROLLBACK_GRACE_MS = 3000;
const DEFAULT_AUTO_UPDATE_POLL_MS = 60 * 60 * 1000;
const DEFAULT_AUTO_UPDATE_START_DELAY_MS = 2000;
// Worker-recovery retry policy: capped exponential backoff (1s → 2s → 4s …,
// ceiling 60s), bounded attempts. After the last attempt the supervisor answers
// requests with a retryable error instead of queueing them forever.
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_BACKOFF_BASE_MS = 1000;
const RECOVERY_BACKOFF_MAX_MS = 60_000;
// Unbounded queue growth is its own failure mode while a recovery is running.
const HOST_QUEUE_MAX = 200;

const log = (...args) => console.error('[klypix-supervisor]', ...args);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const idKey = (id) => JSON.stringify(id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isAlivePid = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const within = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
};
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
  catch { return { ok: false, absent: true, error: 'runtime manifest is absent' }; }
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
  }

  writeState(extra = {}) {
    try {
      atomicJson(this.stateFile, {
        protocol: 1,
        pid: process.pid,
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
          target: this.status === 'hibernated' && this.hibernatedTarget ? {
            version: this.hibernatedTarget.version || null,
            path: this.hibernatedTarget.path?.replace(/\\/g, '/') || null,
            source: this.hibernatedTarget.source || null,
          } : null,
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
          enabled: this.autoUpdate,
          ...inspectAutoUpdate(path.dirname(this.runtimeManifest)),
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
      const probe = await this.sendInternal(this.active, 'tools/call', {
        name: 'brain_sync',
        arguments: { phase: 'checkpoint', include_context: false },
      }, 4000);
      const structured = probe?.structuredContent || null;
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
    this.hibernatedTarget = worker.target;
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
    if (this.closed || this.active || this.candidate) return;
    const target = this.hibernatedTarget || this.selectInitialTarget();
    log('waking hibernated worker');
    this.startCandidate(target, { recovery: true });
  }

  selectInitialTarget() {
    const runtime = readRuntimeTarget(this.runtimeManifest, { allowExternal: this.allowExternal });
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
        if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
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
      this.loadToolManifest(this.active).catch(error => {
        this.lastError = `initial tool manifest unavailable: ${error.message}`;
        this.writeState();
      }).finally(() => this.checkForUpdate());
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

  async startCandidate(target, { recovery = false } = {}) {
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

      const previousTools = this.active?.manifest || [];
      const compatibility = toolCompatibility(previousTools, candidate.manifest);
      const oldVersion = this.active?.version || this.active?.target?.version;
      const oldSemver = parseSemver(oldVersion);
      const nextSemver = parseSemver(candidate.version);
      if (oldSemver && nextSemver && oldSemver[0] !== nextSemver[0]) {
        throw new Error(`major upgrade v${oldVersion} → v${candidate.version} requires reconnect`);
      }
      if (!compatibility.ok) {
        const details = [
          compatibility.removed.length ? `removed tools: ${compatibility.removed.join(', ')}` : '',
          compatibility.changed.length ? `incompatible schemas: ${compatibility.changed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        throw new Error(`breaking tool manifest requires reconnect (${details})`);
      }
      await this.replayTaskScope(candidate);
      candidate.compatibility = compatibility;
      candidate.ready = true;
      this.status = recovery ? 'recovery-ready' : 'update-ready';
      this.writeState();
      this.maybeCommitCandidate();
    } catch (error) {
      this.rejectCandidate(error.message);
      if (recovery && !this.active) this.tryPreviousWorker(target);
    }
  }

  rejectCandidate(reason, terminate = true) {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;
    this.status = this.active ? 'restart-required' : 'recovery-failed';
    this.lastError = reason;
    if (terminate && !candidate.exited) this.retireWorker(candidate, 0);
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
          this.startCandidate(candidate.target, { recovery: true });
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

  maybeCommitCandidate() {
    if (!this.candidate?.ready) return;
    // A woken worker owns its lane row again — hand presence back before it
    // becomes active so exactly one writer heartbeats at any moment.
    this.stopPresenceHeartbeat();
    this.expireAbandonedRequests();
    if (this.hostRequests.size || this.workerRequests.size) return;
    const next = this.candidate;
    const previous = this.active;
    this.candidate = null;
    next.role = 'active';
    this.active = next;
    this.rejectedSignature = null;
    this.recoveryAttempts = 0;   // a committed worker resets the retry budget
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    this.status = 'ready';
    this.lastError = null;
    this.lastSwapAt = new Date().toISOString();
    if (previous) this.hotReloads++;

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
    if (previous && previous.manifestHash !== next.manifestHash) {
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    if (previous) log(`hot-swapped worker v${previous.version} → v${next.version} without reconnect`);
    else log(`recovered worker v${next.version} without reconnect`);

    if (this.pendingTarget && this.pendingTarget.signature !== next.target.signature) {
      const pending = this.pendingTarget;
      this.pendingTarget = null;
      queueMicrotask(() => this.startCandidate(pending));
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

  tryPreviousWorker(target) {
    const previousPath = path.join(path.dirname(target.path), '.prev', path.basename(target.path));
    if (!fs.existsSync(previousPath)) return;
    const previousVersion = readBakedVersion(previousPath);
    if (!previousVersion) return;
    const previous = {
      path: previousPath,
      version: previousVersion,
      signature: `previous:${previousPath}:${previousVersion}`,
      source: 'rollback',
      dev: false,
    };
    setTimeout(() => {
      if (!this.closed && !this.active && !this.candidate) this.startCandidate(previous, { recovery: true });
    }, 150).unref?.();
  }

  async checkForUpdate() {
    if (this.closed || this.checking) return;
    if (this.recoveryTimer) return;   // a recovery backoff owns the next attempt — the poller must not preempt it
    this.checking = true;
    try {
      const runtime = readRuntimeTarget(this.runtimeManifest, { allowExternal: this.allowExternal });
      if (!runtime.ok) {
        if (!runtime.absent) {
          this.lastError = runtime.error;
          this.writeState();
        }
        return;
      }
      const target = runtime.target;
      if (target.signature === this.active?.target.signature || target.signature === this.candidate?.target.signature || target.signature === this.rejectedSignature) return;
      const cmp = compareSemver(target.version, this.active?.version || this.active?.target.version);
      if (!target.dev && cmp !== null && cmp <= 0) return;
      this.startCandidate(target);
    } finally {
      this.checking = false;
    }
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
    // Opportunistic cleanup of dead supervisor receipts.
    try {
      for (const name of fs.readdirSync(this.stateDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.stateDir, name);
        const state = readJson(file);
        if (!state?.pid || !isAlivePid(state.pid)) {
          try { fs.unlinkSync(file); } catch { /* raced */ }
        }
      }
    } catch { /* */ }

    const initial = this.selectInitialTarget();
    this.active = this.spawnWorker(initial, 'active');
    this.status = 'awaiting-initialize';
    this.writeState();
    this.flushHostQueue();

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

    await new Promise(resolve => {
      this.resolveRun = resolve;
      process.stdin.once('end', () => this.close());
      process.stdin.once('close', () => this.close());
      process.once('SIGINT', () => this.close());
      process.once('SIGTERM', () => this.close());
    });
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
};
