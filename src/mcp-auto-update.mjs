// Host-neutral automatic updates for the standalone KLYPIX MCP runtime.
//
// Every MCP host starts the same stable supervisor. The supervisor launches this
// helper out-of-band, so update discovery never delays or breaks the stdio
// connection. A machine-wide stamp and lock make many concurrent Codex, Claude,
// Cursor, Cline, or generic MCP sessions behave like one updater.
//
// Safety contract:
//   - default on, with KLYPIX_AUTO_UPDATE=0|off|false|no as the explicit opt-out.
//     Every launching process reads its OWN environment, so the opt-out belongs
//     in each host's launch env and takes effect at that host's next supervisor
//     start or reconnect;
//   - one registry check per machine per 6 hours, plus one re-check (never sooner
//     than 5 minutes after the last attempt) when something other than this
//     helper changes the runtime's version or ownership;
//   - a failed check retries after 15 min, 1 h, then 4 h, then returns to the
//     6 h cadence. The attempt is stamped as FAILED before any network call, so
//     a helper that dies mid-check backs off instead of retrying in a storm;
//   - a deliberate older install (a --force rollback) is held: the updater never
//     re-installs the version it was rolled back from, only a newer release
//     (KLYPIX_AUTO_UPDATE_FORCE=1 overrides the hold). The hold lives in the
//     status and is mirrored in the stamp, so losing either file keeps it. A
//     rollback onto a release from before the hold (AUTO_UPDATE_API 1, ≤ 1.89.0)
//     also rolls this helper back, and that helper re-installs: spawners never
//     launch it while a hold applies, and the README tells owners how to stay;
//   - a helper whose lock was taken from it (a live owner past 2 h) records only
//     an install it made itself, and a failure never overwrites an outcome
//     another helper recorded after this attempt began;
//   - stable, same-major releases only (a new major requires a manual install),
//     whether or not the runtime is managed yet;
//   - a developer-owned (dev:true) runtime is never fetched for, installed over,
//     or recorded as updated;
//   - npm installs an exact version and verifies the package's registry integrity;
//   - runtime installation is isolated; only after verification do we reconcile
//     KLYPIX-managed blocks/config entries in registered brain projects, and only
//     when the runtime or its instructions changed or the last pass is a day old;
//   - project reconciliation preserves non-KLYPIX content, is per-file isolated,
//     and never turns a harness failure into a broken MCP runtime;
//   - installer commits .mcp-runtime.json last; the supervisor validates and
//     compatibility-gates the worker before a zero-restart hot-swap;
//   - offline, registry, npm, or filesystem failures are fail-open.
//
// Why the schedule reads the install receipts (2026-10-03): the previous gate was
// one time-only 24 h stamp, written BEFORE the dev-owned return that never
// fetches, and no installer reset it. On the founder's PC a dev-owned check that
// did nothing held the first npm check back until 13 h after 1.89.0 was
// published, every failed check cost another full day, and the doctor kept
// printing the dev-owned result next to an npm-owned runtime. The schedule now
// compares the install the last result describes (.autoupdate-status.json
// `identity`) with the receipts on disk, and the stamp carries an explicit
// failure count and next-attempt time.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

// The rules this file implements, as a literal other code can read without
// importing it (MV-2, 2026-10-03 review): 2 = the identity-aware 6 h schedule,
// failure backoff and downgrade hold. A file without the line is api 1 — every
// release through 1.89.0: a time-only 24 h stamp and no hold. Bump it whenever
// the schedule, the hold or a decision changes meaning; the doctor and the
// spawners read it from the file a spawner will actually launch.
export const AUTO_UPDATE_API = 2;
export const AUTO_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
// How often supervisors and workers ask "is a check due?". Each poll is a few
// small JSON reads and never touches the network; npm is contacted only when
// the schedule below says a check is due.
export const AUTO_UPDATE_POLL_MS = 10 * 60 * 1000;
// An install that changed this runtime re-opens the schedule, but never sooner
// than this after the last attempt, so a flapping receipt cannot storm npm.
export const AUTO_UPDATE_RECHECK_FLOOR_MS = 5 * 60 * 1000;
// Failed attempt n waits AUTO_UPDATE_RETRY_MS[n - 1]; from the fourth failure on,
// the normal TTL. The first retry stays short because a re-run is also how a
// half-applied install heals.
export const AUTO_UPDATE_RETRY_MS = Object.freeze([15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000]);
// A lock whose owner pid is gone is stolen at once. A live-looking owner is
// stolen only after this long: Windows reuses pids quickly, and a hung helper
// must not block updates forever. A real check finishes within minutes.
export const AUTO_UPDATE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
// A stamp, retry time or lock time further in the future than this is invalid
// (an RTC reset or a hand edit) and makes the check due, instead of throttling
// updates until the wall clock catches up.
export const AUTO_UPDATE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
// The harness pass rewrites tracked files in every registered project, many of
// them other sessions' live worktrees (57 on the founder's PC, 2026-10-03). At
// 4 checks a day it runs only when something it projects changed, or daily.
export const AUTO_UPDATE_HARNESS_REFRESH_MS = 24 * 60 * 60 * 1000;
// Bulk passes skip registrations nobody has used for this long. brain_sync
// reconciles its own project at registration, so a revived project still heals
// on its first use.
export const AUTO_UPDATE_STALE_REGISTRATION_MS = 14 * 24 * 60 * 60 * 1000;
// A spawner whose last helper left the stamp and the status untouched (it
// exited 'throttled' or 'busy', or could not start) waits this long before
// launching another (MV-3, 2026-10-03 review).
export const AUTO_UPDATE_SPAWN_RETRY_MS = AUTO_UPDATE_TTL_MS / 2;
// A due check runs within one poll (10 min) while any session is open, so a
// check due this long — three polls — is OVERDUE (autoUpdateOverdue), when a
// poll proves a session was there to run it (K3): a supervisor's
// autoUpdate.lastPollAt at least AUTO_UPDATE_POLL_EVIDENCE_MS after the check
// fell due. That tick launched the helper, which takes the lock and pre-stamps
// within seconds, so a tick at least AUTO_UPDATE_POLL_SETTLE_MS old that left
// the stamp unmoved is a real stall. A younger one is not evidence yet: the
// first SessionStart after an idle night reads its own supervisor's first tick
// (2 s after it starts) before the helper that tick launched has run.
export const AUTO_UPDATE_OVERDUE_GRACE_MS = 30 * 60 * 1000;
export const AUTO_UPDATE_POLL_EVIDENCE_MS = 2 * 60 * 1000;
export const AUTO_UPDATE_POLL_SETTLE_MS = 60 * 1000;
export const AUTO_UPDATE_WORKER_ARG = '--klypix-auto-update-worker';

const MAX_DATE_MS = 8.64e15;
// A lock file that exists but names no owner is either being written right now
// or was torn by a crash (an empty file after a power cut). Past this grace it
// cannot be an in-flight write.
const TORN_LOCK_GRACE_MS = 60 * 1000;
const RECEIPT_SETTLE_TRIES = 5;
const RECEIPT_SETTLE_WAIT_MS = 200;

const strictSemver = (value) => /^\d+\.\d+\.\d+$/.test(String(value || '').trim());
const parseSemver = (value) => {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
};
const compareSemver = (a, b) => {
  const aa = parseSemver(a), bb = parseSemver(b);
  if (!aa || !bb) return null;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
};
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};
// The installer's bounded rename backoff (bin/klypix-install.mjs, 1.71.1),
// mirrored rather than imported because the installer does its work on import.
// 15+ live supervisors re-read the stamp and status on every state write, and on
// Windows a rename over a file another process holds throws EPERM/EBUSY/EACCES.
// That hold is transient: ~2.7 s of retries outlasts it; a persistent one throws.
const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_BACKOFF_MS = [40, 120, 300, 700, 1500];
function renameWithBackoff(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); }
    catch (error) {
      if (attempt >= RENAME_BACKOFF_MS.length || !RENAME_RETRYABLE_CODES.has(error?.code)) throw error;
      sleepSync(RENAME_BACKOFF_MS[attempt]);
    }
  }
}
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameWithBackoff(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged / already moved */ }
    throw error;
  }
};
const cleanError = (error) => String(error?.message || error || 'unknown error')
  .replace(/[\r\n]+/g, ' ')
  .slice(0, 240);
// Every time the scheduler reads is ABSENT, VALID or INVALID. Invalid covers NaN,
// strings, 1e20 (new Date() throws on it) and anything more than a day ahead of
// `now`; the scheduler treats it as "due now", so a corrupt stamp heals by being
// rewritten instead of crashing a poller or throttling forever.
function readTime(value, now) {
  if (value === undefined || value === null) return { absent: true, ms: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DATE_MS) {
    return { invalid: true, ms: null };
  }
  if (value - now > AUTO_UPDATE_CLOCK_SKEW_MS) return { invalid: true, ms: null };
  return { ms: value };
}
const validNow = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS
  ? value
  : Date.now());
const isoAt = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
  ? new Date(ms).toISOString()
  : null);
const sanitizeFailures = (value) => (Number.isInteger(value) && value > 0 && value <= 10_000 ? value : 0);
const retryDelay = (failures, ttlMs) => (failures >= 1 && failures <= AUTO_UPDATE_RETRY_MS.length
  ? AUTO_UPDATE_RETRY_MS[failures - 1]
  : ttlMs);
const validTtl = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 365 * 24 * 60 * 60 * 1000
  ? value
  : AUTO_UPDATE_TTL_MS);

export function autoUpdateEnabled(env = process.env) {
  const value = String(env.KLYPIX_AUTO_UPDATE ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(value);
}

export function autoUpdatePaths(brainDir = path.join(os.homedir(), '.claude', 'project-brain')) {
  const root = path.resolve(brainDir);
  return {
    brainDir: root,
    stamp: path.join(root, '.autoupdate-check.json'),
    status: path.join(root, '.autoupdate-status.json'),
    lock: path.join(root, '.autoupdate.lock'),
    runtime: path.join(root, '.mcp-runtime.json'),
    version: path.join(root, '.brain-version.json'),
    registry: path.join(root, 'registry.json'),
    registryLock: path.join(root, '.registry.lock'),
  };
}

const normalizeBrainPath = (value) => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Register a project from any MCP host, not only Claude's lifecycle hook.
 * The small lock + atomic replace prevents concurrent brain_sync calls from
 * losing one another's projects. Failure is deliberately non-fatal: the next
 * task start retries registration.
 */
export function registerProjectBrain({
  brainPath,
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  now = Date.now(),
} = {}) {
  const candidate = path.resolve(String(brainPath || ''));
  if (!['brain.klypix', 'brain.any'].includes(path.basename(candidate).toLowerCase())) {
    return { registered: false, reason: 'invalid-brain-path' };
  }
  try {
    if (!fs.statSync(candidate).isFile()) return { registered: false, reason: 'missing-brain' };
  } catch { return { registered: false, reason: 'missing-brain' }; }

  const files = autoUpdatePaths(brainDir);
  let token = null;
  for (let attempt = 0; attempt < 20 && !token; attempt++) {
    token = acquireLock(files.registryLock, Date.now(), 10_000);
    if (!token) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } catch { /* retry */ }
    }
  }
  if (!token) return { registered: false, reason: 'busy' };
  try {
    const current = readJson(files.registry) || { brains: [] };
    const byPath = new Map();
    for (const item of Array.isArray(current.brains) ? current.brains : []) {
      if (!item?.path) continue;
      const key = normalizeBrainPath(item.path);
      const prior = byPath.get(key);
      if (!prior || Number(item.lastSeen || 0) >= Number(prior.lastSeen || 0)) {
        byPath.set(key, { ...prior, ...item, path: path.resolve(item.path) });
      }
    }
    const key = normalizeBrainPath(candidate);
    byPath.set(key, {
      ...(byPath.get(key) || {}),
      path: candidate,
      project: path.basename(path.dirname(candidate)),
      lastSeen: now,
    });
    const brains = [...byPath.values()]
      .filter((item) => {
        try { return fs.statSync(item.path).isFile(); } catch { return false; }
      })
      .sort((a, b) => Number(a.lastSeen || 0) - Number(b.lastSeen || 0))
      .slice(-200);
    atomicJson(files.registry, { ...current, brains });
    return { registered: true, brainPath: candidate, projects: brains.length };
  } catch (error) {
    return { registered: false, reason: cleanError(error) };
  } finally {
    releaseLock(files.registryLock, token);
  }
}

export function readRegisteredProjectBrains(brainDir = path.join(os.homedir(), '.claude', 'project-brain')) {
  const registry = readJson(autoUpdatePaths(brainDir).registry);
  const out = [];
  const byKey = new Map();
  for (const item of Array.isArray(registry?.brains) ? registry.brains : []) {
    if (typeof item?.path !== 'string' || !item.path) continue;
    const brainPath = path.resolve(item.path);
    const key = normalizeBrainPath(brainPath);
    const lastSeen = typeof item.lastSeen === 'number' && Number.isFinite(item.lastSeen) ? item.lastSeen : null;
    const seen = byKey.get(key);
    if (seen) {
      // Case-variant duplicates (Windows) are one project: keep its freshest
      // sighting, or the stale-registration filter would drop a live project.
      if (lastSeen !== null && (seen.lastSeen === null || lastSeen > seen.lastSeen)) seen.lastSeen = lastSeen;
      continue;
    }
    const entry = {
      brainPath,
      projectDir: path.dirname(brainPath),
      project: item.project || path.basename(path.dirname(brainPath)),
      lastSeen,
    };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

async function loadInstalledAgentRules(brainDir, version) {
  const file = path.join(path.resolve(brainDir), 'agent-rules.mjs');
  if (!fs.existsSync(file)) throw new Error('installed agent-rules.mjs is missing');
  // Query-bust because this helper may have loaded the pre-update module before
  // the installer atomically replaced it. The newly verified runtime must
  // project its own instructions, never the prior version's cached module.
  return import(`${pathToFileURL(file).href}?harness=${encodeURIComponent(version || 'current')}-${Date.now()}`);
}

/** Reconcile every registered project (or an explicit brain subset). */
export async function reconcileRegisteredProjects({
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  version = null,
  brainPaths = null,
  rules = null,
  now = Date.now(),
  staleAfterMs = AUTO_UPDATE_STALE_REGISTRATION_MS,
} = {}) {
  const bulk = !Array.isArray(brainPaths);
  const requested = bulk
    ? readRegisteredProjectBrains(brainDir)
    : brainPaths.map((brainPath) => ({
      brainPath: path.resolve(brainPath),
      projectDir: path.dirname(path.resolve(brainPath)),
      project: path.basename(path.dirname(path.resolve(brainPath))),
    }));
  const unique = [];
  const seen = new Set();
  for (const item of requested.slice(0, 200)) {
    const key = normalizeBrainPath(item.brainPath);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const summary = { checked: unique.length, updated: 0, unchanged: 0, failed: 0, skipped: 0, projects: [] };
  const skip = (item, reason) => {
    summary.skipped++;
    summary.skippedReasons = { ...summary.skippedReasons, [reason]: (summary.skippedReasons?.[reason] || 0) + 1 };
    summary.projects.push({ project: item.project, status: 'skipped', reason });
  };
  // Bulk passes only. On the founder's PC 52 of 57 registrations were git
  // worktrees, 39 unseen for days (2026-10-03 survey); rewriting their tracked
  // files four times a day re-dirtied trees other sessions had cleaned. An
  // explicit brainPaths request (brain_sync's own project) is never filtered.
  const live = [];
  for (const item of unique) {
    if (bulk && !(Number.isFinite(item.lastSeen) && now - item.lastSeen < staleAfterMs)) skip(item, 'stale-registration');
    else live.push(item);
  }
  if (!live.length) return summary;
  let projector;
  try { projector = rules || await loadInstalledAgentRules(brainDir, version); }
  catch (error) {
    summary.failed = live.length;
    summary.projects.push(...live.map((item) => ({ project: item.project, status: 'failed', error: cleanError(error) })));
    return summary;
  }

  for (const item of live) {
    const brainName = path.basename(item.brainPath).toLowerCase();
    const projectLock = path.join(
      path.resolve(brainDir),
      '.harness-locks',
      `${crypto.createHash('sha1').update(normalizeBrainPath(item.brainPath)).digest('hex').slice(0, 16)}.lock`,
    );
    let projectToken = null;
    try {
      if (!['brain.klypix', 'brain.any'].includes(brainName) || !fs.statSync(item.brainPath).isFile()) {
        skip(item, 'brain-missing');
        continue;
      }
      for (let attempt = 0; attempt < 20 && !projectToken; attempt++) {
        projectToken = acquireLock(projectLock, Date.now(), 2 * 60 * 1000);
        if (!projectToken) {
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch { /* retry */ }
        }
      }
      if (!projectToken) {
        skip(item, 'busy');
        continue;
      }
      const before = projector.auditProject(item.projectDir, { version });
      if (before.ok) {
        summary.unchanged++;
        summary.projects.push({ project: item.project, status: 'unchanged' });
        continue;
      }
      const written = projector.linkProject(item.projectDir, { version });
      if (typeof projector.compactAgentsBrief === 'function') {
        await projector.compactAgentsBrief(item.projectDir);
      }
      const after = projector.auditProject(item.projectDir, { version });
      const changed = [...written.rules, ...written.mcp]
        .filter((entry) => !['unchanged', 'skipped'].includes(entry.action)).length;
      if (!after.ok) {
        summary.failed++;
        summary.projects.push({
          project: item.project,
          status: 'partial',
          changed,
          drift: after.drift.map((entry) => ({ file: entry.file, status: entry.status, why: entry.why })).slice(0, 20),
        });
      } else {
        summary.updated++;
        summary.projects.push({ project: item.project, status: 'updated', changed });
      }
    } catch (error) {
      summary.failed++;
      summary.projects.push({ project: item.project, status: 'failed', error: cleanError(error) });
    } finally {
      if (projectToken) releaseLock(projectLock, projectToken);
    }
  }
  return summary;
}

// ── Install identity: what is on disk, from the receipts alone ───────────────
// A receipt is ABSENT, readable, or UNREADABLE (EBUSY/EPERM while an installer
// renames it, or partial JSON from a non-atomic writer). Unreadable is a third
// state on purpose: treating it as absent made a busy read look like an
// unmanaged runtime, i.e. a "change".
function readReceipt(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'absent', value: null };
    return { state: 'unreadable', value: null, error: `${path.basename(file)}: ${cleanError(error)}` };
  }
  try {
    const value = JSON.parse(raw);
    if (!isRecord(value)) return { state: 'unreadable', value: null, error: `${path.basename(file)}: not a JSON object` };
    return { state: 'ok', value };
  } catch (error) {
    return { state: 'unreadable', value: null, error: `${path.basename(file)}: ${cleanError(error)}` };
  }
}
function readInstallReceipts(brainDir) {
  const files = autoUpdatePaths(brainDir);
  return { runtime: readReceipt(files.runtime), stamp: readReceipt(files.version) };
}
// The helper only: a receipt caught mid-rename is usually readable a moment later.
function readInstallReceiptsSettled(brainDir) {
  let receipts = readInstallReceipts(brainDir);
  for (let attempt = 1; attempt < RECEIPT_SETTLE_TRIES
    && (receipts.runtime.state === 'unreadable' || receipts.stamp.state === 'unreadable'); attempt++) {
    sleepSync(RECEIPT_SETTLE_WAIT_MS);
    receipts = readInstallReceipts(brainDir);
  }
  return receipts;
}
function runtimeFromReceipts(runtime, stamp, fallbackVersion = null) {
  const runtimeVersion = strictSemver(runtime?.version) ? String(runtime.version) : null;
  const stampedVersion = strictSemver(stamp?.brainVersion || stamp?.appVersion)
    ? String(stamp.brainVersion || stamp.appVersion)
    : null;
  return {
    version: runtimeVersion || stampedVersion || (strictSemver(fallbackVersion) ? String(fallbackVersion) : null),
    managed: runtime?.protocol === 1 && !!runtimeVersion,
    dev: runtime?.dev === true || stamp?.dev === true,
    channel: runtime?.channel || stamp?.via || null,
  };
}
function identityFromReceipts({ runtime, stamp }) {
  const unreadable = [runtime, stamp].filter((receipt) => receipt.state === 'unreadable');
  if (unreadable.length) {
    return {
      version: null, managed: null, dev: null, channel: null, installedAt: null,
      unknown: true,
      error: unreadable.map((receipt) => receipt.error).join('; '),
    };
  }
  const installedAt = [runtime.value?.installedAt, stamp.value?.installedAt].find((value) => typeof value === 'string');
  return { ...runtimeFromReceipts(runtime.value, stamp.value), installedAt: installedAt || null, unknown: false };
}
// What the status and stamp record. channel and installedAt are display-only:
// the desktop installer re-installs an equal version with channel 'app' on
// every launch, so neither may ever trigger a check.
const recordedIdentity = (identity) => (isRecord(identity) && !identity.unknown ? {
  version: identity.version || null,
  managed: identity.managed === true,
  dev: identity.dev === true,
  channel: identity.channel || null,
  installedAt: identity.installedAt || null,
} : null);

export function readInstalledRuntime(brainDir, fallbackVersion = null) {
  const files = autoUpdatePaths(brainDir);
  return runtimeFromReceipts(readJson(files.runtime), readJson(files.version), fallbackVersion);
}

/**
 * The installed runtime as its receipts describe it — never a caller's fallback
 * version. Spawners, the helper, the doctor and the hook all pass different
 * "current" versions (active worker, PKG_VERSION, baked version); comparing one
 * view with another would read as a change forever and re-query npm every poll.
 */
export function installIdentity(brainDir) {
  try { return identityFromReceipts(readInstallReceipts(brainDir)); }
  catch (error) {
    return {
      version: null, managed: null, dev: null, channel: null, installedAt: null,
      unknown: true,
      error: cleanError(error),
    };
  }
}

// The install the last recorded result describes. A pre-identity (legacy)
// status carries only its versions and result, so only version and ownership
// are recoverable from it; anything less is unusable.
function evaluatedIdentity(status) {
  if (!isRecord(status)) return null;
  const id = status.identity;
  if (isRecord(id) && (id.version === null || strictSemver(id.version))
    && typeof id.managed === 'boolean' && typeof id.dev === 'boolean') {
    return { version: id.version === null ? null : String(id.version), managed: id.managed, dev: id.dev, legacy: false };
  }
  const version = [status.installedVersion, status.currentVersion].find((value) => strictSemver(value));
  if (!version) return null;
  return { version: String(version), managed: null, dev: status.result === 'dev-owned', legacy: true };
}

// null means "no receipt names a version".
function compareIdentityVersions(current, evaluated) {
  if (current === evaluated) return 0;
  if (!evaluated) return 1;
  if (!current) return null;
  return compareSemver(current, evaluated);
}

// What changed between the install the last result describes and the install
// on disk now. `fires` marks the transitions that re-open the schedule: leaving
// dev ownership, becoming managed, a version increase this helper did not
// perform, or a status that cannot be attributed at all. A version DECREASE is a
// deliberate rollback and never fires (it is held instead); entering dev
// ownership never fires because a dev runtime is never fetched for.
function identityDelta(evaluated, current) {
  if (!isRecord(current) || current.unknown) return { stale: false, reason: null, fires: false };
  if (!evaluated) return { stale: true, reason: 'unverified-status', fires: true };
  const cmp = compareIdentityVersions(current.version || null, evaluated.version || null);
  if (evaluated.dev && !current.dev) return { stale: true, reason: 'left-dev-ownership', fires: true };
  if (evaluated.managed === false && current.managed === true) return { stale: true, reason: 'became-managed', fires: true };
  if (cmp > 0) return { stale: true, reason: 'version-increased', fires: true };
  if (!evaluated.dev && current.dev) return { stale: true, reason: 'became-dev-owned', fires: false };
  if (cmp === null) return { stale: true, reason: 'receipts-missing', fires: false };
  if (cmp < 0) return { stale: true, reason: current.dev ? 'version-decreased' : 'manual-downgrade', fires: false };
  if (evaluated.managed === true && current.managed === false) return { stale: true, reason: 'became-unmanaged', fires: false };
  return { stale: false, reason: null, fires: false };
}

const sanitizeHold = (hold) => (isRecord(hold) && strictSemver(hold.version)
  ? { version: String(hold.version), since: typeof hold.since === 'string' ? hold.since : null }
  : null);
const sameIdentity = (a, b) => isRecord(a) && isRecord(b)
  && (a.version || null) === (b.version || null)
  && a.managed === b.managed
  && a.dev === b.dev;

// The version a deliberate downgrade rolled back FROM, or null. Only a managed,
// npm-owned install counts: a dev runtime was never auto-updated, and a legacy
// status (no ownership facts) counts only when its result proves the version
// was a released managed install — a direct-package run records its caller's
// unpublished version, which must never become a hold.
function rolledBackFrom(status, identity) {
  if (!isRecord(identity) || identity.unknown || identity.dev || !identity.managed || !strictSemver(identity.version)) return null;
  const candidates = [];
  const evaluated = evaluatedIdentity(status);
  if (evaluated && !evaluated.dev && (evaluated.legacy
    ? ['current', 'updated', 'bootstrapped', 'major-blocked'].includes(status.result)
    : evaluated.managed)) {
    candidates.push(evaluated.version);
  }
  if (isRecord(status) && ['updated', 'bootstrapped'].includes(status.result)) {
    candidates.push(status.installedVersion, status.latestVersion);
  }
  const highest = candidates
    .filter((value) => strictSemver(value))
    .map(String)
    .reduce((best, value) => (!best || compareSemver(value, best) > 0 ? value : best), null);
  return highest && compareSemver(identity.version, highest) < 0 ? highest : null;
}

// The hold a check applies (A4): the recorded one, raised to the version a
// deliberate downgrade left, and dropped once the install has reached it. The
// helper records it; inspectAutoUpdate decides with it too, so no view promises
// to re-install a version the next check will hold (until the helper had run, a
// --force downgrade read 'install' there — 2026-10-03 integration review).
function nextHold(status, identity, since = null) {
  let hold = sanitizeHold(isRecord(status) ? status.hold : null);
  const from = rolledBackFrom(status, identity);
  if (from && (!hold || compareSemver(from, hold.version) > 0)) hold = { version: from, since };
  if (hold && strictSemver(identity?.version) && compareSemver(identity.version, hold.version) >= 0) hold = null;
  return hold;
}

/**
 * What the updater does with `latestVersion` for this install — pure, shared by
 * runAutoUpdateCheck, the doctor and the hook so they can never disagree.
 * 'unknown' means it cannot say (unreadable receipts, or no valid latest).
 * The major gate applies whenever an installed version is known, managed or
 * not: a direct-package launch used to bootstrap a new major unchecked.
 */
export function autoUpdateDecision({ installed = null, latestVersion = null, hold = null } = {}) {
  try {
    if (!isRecord(installed) || installed.unknown) return 'unknown';
    if (installed.dev === true) return 'dev-owned';
    if (!strictSemver(latestVersion)) return 'unknown';
    const latest = String(latestVersion).trim();
    const current = strictSemver(installed.version) ? String(installed.version).trim() : null;
    if (current) {
      const cmp = compareSemver(latest, current);
      // Never downgrade — across a major boundary too (that is ahead, not a new major).
      if (cmp < 0) return 'ahead';
      if (parseSemver(latest)[0] !== parseSemver(current)[0]) return 'major-blocked';
      // A direct-package launch bootstraps a managed runtime at an equal version.
      if (cmp === 0) return installed.managed ? 'current' : 'install';
    }
    const held = sanitizeHold(hold);
    if (held && compareSemver(latest, held.version) <= 0) return 'held';
    return 'install';
  } catch { return 'unknown'; }
}

// The schedule a status implies, for a stamp that cannot be used (CF-4): a
// failed result's attempt and nextRetryAt, else the cadence after checkedAt.
// null when the status carries no usable time.
function scheduleFromStatus(status, now, ttlMs) {
  if (!isRecord(status) || typeof status.result !== 'string') return null;
  const at = (value) => readTime(typeof value === 'string' ? Date.parse(value) : NaN, now).ms;
  const checkedMs = at(status.checkedAt);
  if (status.result === 'failed') {
    const failures = sanitizeFailures(status.attempt) || 1;
    const retryMs = at(status.nextRetryAt);
    if (retryMs !== null) return { failures, dueAt: retryMs };
    return checkedMs !== null ? { failures, dueAt: checkedMs + retryDelay(failures, ttlMs) } : null;
  }
  return checkedMs !== null ? { failures: 0, dueAt: checkedMs + ttlMs } : null;
}

// The stamp and the status, each ABSENT, readable or UNREADABLE (readReceipt).
function readCheckState(files) {
  return { stampRead: readReceipt(files.stamp), statusRead: readReceipt(files.status) };
}

// The record a hold and the evaluated identity are read from (CF-4): the
// status — or, when the status cannot be read, the stamp, which mirrors both.
// Losing the status used to drop a recorded downgrade hold, and the next check
// re-installed the version the owner had rolled back from.
function outcomeRecord({ stampRead, statusRead }) {
  if (statusRead.state === 'ok') return statusRead.value;
  if (stampRead.state === 'ok') return { identity: stampRead.value.identity, hold: stampRead.value.hold };
  return null;
}

/**
 * When is the next check due, and why? Pure and TOTAL: it validates every
 * number before using it and answers {due:false, error} on any surprise, so a
 * corrupt stamp can never crash the worker/supervisor timers that poll it
 * (neither installs an uncaughtException handler).
 *
 *   stamp      .autoupdate-check.json  {lastCheck, failures, nextCheckAt, ...}
 *   stampState 'unreadable' when that file exists but could not be read
 *   status     .autoupdate-status.json {result, identity, ...}
 *   installed  installIdentity(brainDir)
 *   lock       {pid, acquiredAt, alive} of .autoupdate.lock, or null
 */
export function autoUpdateSchedule({
  stamp = null,
  stampState = null,
  status = null,
  installed = null,
  lock = null,
  now = Date.now(),
  enabled = true,
  ttlMs = AUTO_UPDATE_TTL_MS,
} = {}) {
  try {
    const t = validNow(now);
    const ttl = validTtl(ttlMs);
    const record = isRecord(stamp) ? stamp : null;
    const corrupt = stampState === 'unreadable' || (stamp !== null && stamp !== undefined && !record);
    let failures = sanitizeFailures(record?.failures);
    const last = readTime(record?.lastCheck, t);
    const next = readTime(record?.nextCheckAt, t);
    const lockAt = isRecord(lock) ? readTime(lock.acquiredAt, t) : { absent: true, ms: null };
    const delta = identityDelta(evaluatedIdentity(status), installed);
    // Only a recorded RESULT can be stale; with no status there is nothing to mislabel.
    const hasResult = isRecord(status) && typeof status.result === 'string' && status.result !== '';

    let dueAt;
    let dueReason;
    let nextCheckAt = null;
    if (corrupt || last.invalid || next.invalid || lockAt.invalid) {
      dueAt = t;
      dueReason = 'invalid-stamp';
      // CF-4 (2026-10-03 review): a stamp that cannot be used (a power cut
      // leaves NULs; NTFS journals metadata, not data) used to read as "never
      // checked": due at once with the failure count back at zero, so a 4 h
      // backoff shrank to now + 15 min. The status mirrors the backoff — a
      // failed result carries its attempt and nextRetryAt — so the schedule is
      // rebuilt from it. Only when neither file says anything is it due now.
      if (!lockAt.invalid) {
        const rebuilt = scheduleFromStatus(status, t, ttl);
        if (rebuilt) {
          failures = rebuilt.failures;
          if (rebuilt.dueAt > t) { dueAt = rebuilt.dueAt; nextCheckAt = rebuilt.dueAt; }
        }
      }
    } else if (last.absent) {
      dueAt = t;
      dueReason = 'never-checked';
    } else {
      // A legacy stamp has no nextCheckAt: lastCheck + the cadence it implies.
      nextCheckAt = next.ms ?? last.ms + (failures > 0 ? retryDelay(failures, ttl) : ttl);
      dueAt = nextCheckAt;
      dueReason = failures > 0 ? 'retry' : 'interval';
      if (delta.fires) {
        const floorAt = last.ms + AUTO_UPDATE_RECHECK_FLOOR_MS;
        if (failures > 0) {
          // An install change never bypasses a pending failure backoff.
          if (floorAt > dueAt) { dueAt = floorAt; dueReason = 'install-changed'; }
        } else if (floorAt < dueAt) {
          dueAt = floorAt;
          dueReason = 'install-changed';
        }
      }
    }

    // A live helper already owns this check; spawning another only buys 'busy'.
    let inProgress = null;
    if (isRecord(lock) && lock.alive === true && lockAt.ms !== null && t - lockAt.ms <= AUTO_UPDATE_LOCK_STALE_MS) {
      inProgress = {
        pid: Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : null,
        startedAt: isoAt(lockAt.ms),
      };
    }

    return {
      due: enabled !== false && !inProgress && t >= dueAt,
      dueAt,
      dueReason,
      stale: hasResult && delta.stale,
      staleReason: hasResult && delta.stale ? delta.reason : null,
      failures,
      nextCheckAt,
      inProgress,
    };
  } catch (error) {
    return {
      due: false,
      dueAt: null,
      dueReason: null,
      stale: false,
      staleReason: null,
      failures: 0,
      nextCheckAt: null,
      inProgress: null,
      error: cleanError(error),
    };
  }
}

/**
 * Diagnostic view for the doctor, supervisor receipts and the hook. Keeps every
 * historical field; never throws.
 *
 * `currentVersion` is what a spawner would pass the helper
 * (KLYPIX_MCP_AUTO_UPDATE_CURRENT: its running or baked version). It never
 * touches the schedule (A1: receipts only); it lets `decision` decide a
 * runtime no receipt names exactly as the helper will.
 */
export function inspectAutoUpdate(brainDir, { now = Date.now(), env = process.env, currentVersion = null } = {}) {
  let enabled = true;
  try { enabled = autoUpdateEnabled(env); } catch { /* default on */ }
  try {
    const t = validNow(now);
    const files = autoUpdatePaths(brainDir);
    const state = readCheckState(files);
    const stamp = state.stampRead.value;
    const rawStatus = state.statusRead.value;
    const status = isRecord(rawStatus) ? rawStatus : {};
    const record = outcomeRecord(state);
    const installed = installIdentity(files.brainDir);
    const plan = autoUpdateSchedule({
      stamp,
      stampState: state.stampRead.state,
      status: rawStatus,
      installed,
      lock: readLockState(files.lock),
      now: t,
      enabled,
      ttlMs: AUTO_UPDATE_TTL_MS,
    });
    const lastCheck = isRecord(stamp) ? readTime(stamp.lastCheck, t).ms : null;
    const hold = sanitizeHold(record?.hold);
    const evaluated = evaluatedIdentity(rawStatus);
    // `decision` is what the NEXT check does with latestVersion (2026-10-03
    // integration review): with the hold that check applies, and with the
    // version the helper falls back to when no receipt names one. It used to
    // read 'install' for a --force downgrade the helper would hold, and for a
    // new major the helper would block on a receipt-less runtime.
    const upcomingHold = nextHold(record, installed);
    const decidingAs = isRecord(installed) && !installed.unknown && !installed.version && strictSemver(currentVersion)
      ? { ...installed, version: String(currentVersion).trim() }
      : installed;
    // The helper this process launches is this module's FILE, which a rollback
    // replaces (the flat bundle). A helper from before the hold (api 1, ≤ 1.89.0)
    // re-installs the version the owner left: decide as that helper will
    // (MV-2, 2026-10-03 review), never "held" on its behalf.
    const helperApi = updaterApiOf(fileURLToPath(import.meta.url));
    const helperHolds = helperApi === null || helperApi >= 2;
    // When the stamp and the runtime receipt were last written, for the overdue
    // rule (autoUpdateOverdue): a check due "now" by construction has been due
    // since its stamp went bad, and an install-changed check since the install.
    const writtenAt = (file) => {
      try { return isoAt(fs.statSync(file).mtimeMs); } catch { return null; }
    };
    return {
      enabled,
      lastCheck,
      lastCheckAt: isoAt(lastCheck),
      due: plan.due,
      dueAt: isoAt(plan.dueAt),
      result: status.result || null,
      currentVersion: status.currentVersion || null,
      latestVersion: status.latestVersion || null,
      installedVersion: status.installedVersion || null,
      lastUpdatedAt: status.lastUpdatedAt || null,
      error: status.error || null,
      harness: status.harness || null,
      // Since 2026-10-03:
      checkedAt: status.checkedAt || null,
      dueReason: plan.dueReason,
      nextCheckAt: isoAt(plan.nextCheckAt),
      failures: plan.failures,
      attempt: Number.isInteger(status.attempt) ? status.attempt : null,
      nextRetryAt: typeof status.nextRetryAt === 'string' ? status.nextRetryAt : null,
      stale: plan.stale,
      staleReason: plan.staleReason,
      inProgress: plan.inProgress,
      // The install the last result describes, and the install on disk now.
      identity: evaluated ? { ...evaluated } : null,
      installedIdentity: installed,
      hold,
      // The hold the next check applies: `hold`, or the version a deliberate
      // downgrade left that the helper has not recorded yet.
      nextHold: upcomingHold,
      // The rules of the helper file spawners launch (null: unreadable).
      helperApi,
      // What the updater would do with the last fetched npm version.
      decision: autoUpdateDecision({
        installed: decidingAs,
        latestVersion: strictSemver(status.latestVersion) ? status.latestVersion : null,
        hold: helperHolds ? upcomingHold : null,
      }),
      scheduleError: plan.error || null,
      // Since K2 (2026-10-03): null when the file does not exist.
      stampWrittenAt: writtenAt(files.stamp),
      runtimeCommittedAt: writtenAt(files.runtime),
    };
  } catch (error) {
    return {
      enabled,
      lastCheck: null,
      lastCheckAt: null,
      due: false,
      dueAt: null,
      result: null,
      currentVersion: null,
      latestVersion: null,
      installedVersion: null,
      lastUpdatedAt: null,
      error: null,
      harness: null,
      checkedAt: null,
      dueReason: null,
      nextCheckAt: null,
      failures: 0,
      attempt: null,
      nextRetryAt: null,
      stale: false,
      staleReason: null,
      inProgress: null,
      identity: null,
      installedIdentity: null,
      hold: null,
      nextHold: null,
      helperApi: null,
      decision: 'unknown',
      scheduleError: cleanError(error),
      stampWrittenAt: null,
      runtimeCommittedAt: null,
    };
  }
}

// ── Overdue: one rule for every surface (K2, 2026-10-03) ─────────────────────
// The doctor and the SessionStart notice each decided "overdue" with their own
// conditions: the notice never judged a check that was never recorded, and a
// machine could read overdue in one and "due now" in the other. Both now ask
// this function, with the plan above and the live supervisors' receipts.

/**
 * Is the automatic check OVERDUE: due past the grace, although a running
 * session polled the schedule after it fell due? Pure and TOTAL (never throws).
 *
 *   plan         inspectAutoUpdate(brainDir)
 *   supervisors  the LIVE supervisors' receipts as written — the caller drops
 *                dead ones (own pid gone, or host gone and the receipt silent
 *                for > 120 s: the B7 rule) — each {bootedAt, autoUpdate:
 *                {enabled, lastPollAt}}
 *   helperApi    AUTO_UPDATE_API of the helper spawners launch (default
 *                plan.helperApi); a pre-hold updater (1) is never judged
 *
 * → {overdue, overdueByMs, dueForMs, evidence, suppressed}: `dueForMs` is how
 * long the check has been due (null: since before any record); `suppressed`
 * names why a check due past the grace is not called overdue.
 */
export function autoUpdateOverdue(input = {}) {
  const verdict = (suppressed = null, dueForMs = null) => ({ overdue: false, overdueByMs: null, dueForMs, evidence: null, suppressed });
  try {
    // Destructured here, not in the signature: a null argument must not throw.
    const { plan = null, supervisors = [], now = Date.now(), helperApi } = isRecord(input) ? input : {};
    if (!isRecord(plan) || plan.scheduleError || plan.inProgress) return verdict();
    const t = validNow(now);
    const at = (value) => {
      const ms = typeof value === 'string' ? Date.parse(value) : NaN;
      return Number.isFinite(ms) ? ms : null;
    };
    const dueAt = at(plan.dueAt);
    if (dueAt === null) return verdict();
    // When the check really fell due. Two reasons make dueAt a stand-in: an
    // install-changed check re-opened when the receipts changed, not at
    // lastCheck + 5 min; a never-checked or invalid-stamp check is due "now" by
    // construction, so it could never be late — it has been due since its stamp
    // was written, or, with no stamp at all, since before anything was recorded.
    let since = dueAt;
    if (plan.dueReason === 'install-changed') {
      const changedAt = at(plan.installedIdentity?.installedAt) ?? at(plan.runtimeCommittedAt);
      if (changedAt !== null) since = Math.max(dueAt, changedAt);
    } else if (['never-checked', 'invalid-stamp'].includes(plan.dueReason) && dueAt <= t + 1000) {
      since = at(plan.stampWrittenAt) ?? -Infinity;
    }
    if (t - since < AUTO_UPDATE_OVERDUE_GRACE_MS) return verdict();
    const dueForMs = Number.isFinite(since) ? t - since : null;
    // Its times and decisions are not this module's: never judged (MV-2).
    if ((helperApi === undefined ? plan.helperApi : helperApi) === 1) return verdict('pre-hold-updater', dueForMs);
    // The sessions that run checks: live supervisors with updates on.
    const pollers = (Array.isArray(supervisors) ? supervisors : [])
      .filter((state) => isRecord(state) && !(isRecord(state.autoUpdate) && state.autoUpdate.enabled === false));
    if (!pollers.length) return verdict('no-live-session', dueForMs);
    // K3 (2026-10-03): evidence that one of them polled after the check fell
    // due, from its receipt's lastPollAt. "Open since before the check fell
    // due" was not: a machine asleep across dueAt woke with every session
    // "open for hours" and read overdue before any of them had polled. A
    // receipt without lastPollAt (supervisor code from before this rule) is
    // never evidence.
    const polls = pollers.map((state) => ({
      state,
      polledAt: isRecord(state.autoUpdate) ? at(state.autoUpdate.lastPollAt) : null,
    })).filter(({ polledAt }) => polledAt !== null
      && polledAt >= since + AUTO_UPDATE_POLL_EVIDENCE_MS
      && polledAt <= t - AUTO_UPDATE_POLL_SETTLE_MS);
    if (!polls.length) return verdict('no-poll-evidence', dueForMs);
    // How late: since the check fell due — or, due since before any record,
    // since the longest-running of these sessions began (it polls 2 s in).
    const boots = polls.map(({ state }) => at(state.bootedAt)).filter((value) => value !== null);
    const lateSince = Number.isFinite(since) ? since : (boots.length ? Math.min(...boots) : null);
    return {
      overdue: true,
      overdueByMs: lateSince === null ? null : t - lateSince,
      dueForMs,
      evidence: { sessions: polls.length, lastPollAt: isoAt(Math.max(...polls.map(({ polledAt }) => polledAt))) },
      suppressed: null,
    };
  } catch { return verdict(); }
}

// The AUTO_UPDATE_API a file declares: a number, 1 for an updater from before
// the marker, null when it cannot be read. Text only — importing another copy
// of this module into a long-lived process would pin it in memory for good.
// Cached by size + mtime: spawners ask on every poll and receipt write.
const updaterApiCache = new Map();
export function updaterApiOf(file) {
  try {
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = updaterApiCache.get(file);
    if (cached?.key === key) return cached.api;
    const text = fs.readFileSync(file, 'utf8');
    const marker = text.match(/^export const AUTO_UPDATE_API = (\d+);/m);
    const api = marker ? Number(marker[1]) : (/\brunAutoUpdateCheck\b/.test(text) ? 1 : null);
    updaterApiCache.set(file, { key, api });
    return api;
  } catch { return null; }
}

/**
 * Start the detached updater when this machine is due.
 *
 * Safe to call from both the stable supervisor and the replaceable worker:
 * the shared schedule prevents unnecessary children and the helper lock
 * collapses the remaining cross-process race. Callers are bare timers, so
 * nothing here may throw.
 */
export function spawnAutoUpdateHelper({
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  currentVersion = null,
  env = process.env,
  spawnProcess = spawn,
  now = Date.now(),
} = {}) {
  try {
    if (!autoUpdateEnabled(env) || env.KLYPIX_MCP_AUTO_UPDATE_CHILD === '1') return null;
    const view = inspectAutoUpdate(brainDir, { env, now });
    if (!view.due) return null;
    const helper = fileURLToPath(import.meta.url);
    // MV-2 (2026-10-03 review): a rollback onto a release from before the hold
    // also rolled this FILE back. Never launch that helper while a hold applies:
    // it would re-install the version the owner left. (The rolled-back
    // release's own spawners still do — the README says how to stay.)
    if (view.nextHold && view.helperApi !== null && view.helperApi < 2) return null;
    // MV-3: the schedule runs here, in long-lived code; the throttle runs in the
    // helper on disk. When they disagree (that older helper waits 24 h), every
    // poll launched a node process that exited 'throttled' having written
    // nothing — about 30 every 10 min on a machine with 15 connections. A
    // helper that changed nothing is not relaunched by this process until the
    // stamp or the status changes, or AUTO_UPDATE_SPAWN_RETRY_MS has passed.
    const files = autoUpdatePaths(brainDir);
    const signature = checkStateSignature(files);
    const at = validNow(now);
    const last = lastSpawnByDir.get(files.brainDir);
    if (last && last.signature === signature && at >= last.at && at - last.at < AUTO_UPDATE_SPAWN_RETRY_MS) return null;
    const child = spawnProcess(process.execPath, [helper, AUTO_UPDATE_WORKER_ARG], {
      // Do not hold the managed directory as this detached process's cwd.
      // This matters for ephemeral/test homes on Windows and is cleaner for
      // uninstallers; the installer receives its exact target through env.
      cwd: os.tmpdir(),
      env: {
        ...env,
        KLYPIX_MCP_AUTO_UPDATE_DIR: path.resolve(brainDir),
        KLYPIX_MCP_AUTO_UPDATE_CURRENT: String(currentVersion || ''),
        KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => { /* fail-open: the MCP transport remains healthy */ });
    child.unref();
    lastSpawnByDir.set(files.brainDir, { at, signature });
    return child;
  } catch { return null; }
}

// What this process's last helper launch saw (spawnAutoUpdateHelper, MV-3).
const lastSpawnByDir = new Map();
// The stamp's and the status's bytes, hashed: a helper that ran wrote at least
// its pre-stamp, so an unchanged signature means it did nothing.
function checkStateSignature(files) {
  const hash = crypto.createHash('sha1');
  for (const file of [files.stamp, files.status]) {
    try { hash.update(fs.readFileSync(file)); } catch { hash.update('-'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

// ── Locks (install-lock.mjs semantics) ───────────────────────────────────────
function processAppearsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }   // alive, just not ours to signal
}
function observeLock(lockFile) {
  let raw;
  try { raw = fs.readFileSync(lockFile, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    raw = null;
  }
  let value = null;
  if (raw !== null) {
    try { value = JSON.parse(raw); } catch { /* being written, or torn */ }
  }
  try {
    return { raw, value: isRecord(value) ? value : null, mtimeMs: fs.statSync(lockFile).mtimeMs };
  } catch { return null; }
}
function lockOwnerPid(observed) {
  const structured = Number(observed?.value?.pid);
  if (Number.isInteger(structured) && structured > 0) return structured;
  const legacy = Number(String(observed?.value?.token || '').split('-', 1)[0]);
  return Number.isInteger(legacy) && legacy > 0 ? legacy : null;
}
function lockStampedAt(observed) {
  const acquiredAt = observed?.value?.acquiredAt;
  if (typeof acquiredAt === 'number' && Number.isFinite(acquiredAt) && acquiredAt > 0) return acquiredAt;
  return Number.isFinite(observed?.mtimeMs) ? observed.mtimeMs : null;
}
function readLockState(lockFile) {
  try {
    const observed = observeLock(lockFile);
    if (!observed) return null;
    const pid = lockOwnerPid(observed);
    return { pid, acquiredAt: lockStampedAt(observed), alive: pid ? processAppearsAlive(pid) : false };
  } catch { return null; }
}

// Steal a lock only when its owner is provably gone (EPERM from kill(pid, 0)
// counts as ALIVE), when a live-looking owner has held it past staleMs (pid reuse
// or a hung helper), or when its timestamp is unusable. Age alone no longer
// steals from a live owner: a laptop that slept 30 min mid-check used to have its
// lock stolen while the owner still ran. Compare-and-rename lets two stealers
// race safely: only the one whose rename moved the exact bytes it judged retries.
function removeAbandonedLock(lockFile, observed, now, staleMs) {
  if (!observed) return true;   // released between our open and our read
  const stampedAt = lockStampedAt(observed);
  const invalid = stampedAt === null || readTime(stampedAt, now).invalid;
  const age = invalid ? Infinity : now - stampedAt;
  const pid = lockOwnerPid(observed);
  const abandoned = invalid
    || (pid ? (!processAppearsAlive(pid) || age > staleMs) : age > Math.min(staleMs, TORN_LOCK_GRACE_MS));
  if (!abandoned) return false;
  const moved = `${lockFile}.abandoned-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const current = observeLock(lockFile);
    if (!current) return true;
    if (current.raw !== observed.raw || current.mtimeMs !== observed.mtimeMs) return false;
    fs.renameSync(lockFile, moved);
    const check = observeLock(moved);
    if (!check || check.raw !== observed.raw || check.mtimeMs !== observed.mtimeMs) {
      if (!fs.existsSync(lockFile)) fs.renameSync(moved, lockFile);
      return false;
    }
    fs.unlinkSync(moved);
    return true;
  } catch { return false; }
}

function acquireLock(lockFile, now, staleMs = AUTO_UPDATE_LOCK_STALE_MS) {
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch { return null; }
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let created = false;
    try {
      const fd = fs.openSync(lockFile, 'wx');
      created = true;
      try { fs.writeFileSync(fd, JSON.stringify({ protocol: 1, token, pid: process.pid, acquiredAt: now })); }
      finally { fs.closeSync(fd); }
      return token;
    } catch (error) {
      if (created) {
        // Never leave an ownerless lock behind; it would block for the torn-lock grace.
        try { fs.unlinkSync(lockFile); } catch { /* */ }
        return null;
      }
      if (error?.code !== 'EEXIST') return null;
      if (!removeAbandonedLock(lockFile, observeLock(lockFile), now, staleMs)) return null;
    }
  }
  return null;
}

// Release by rename-then-verify (install-lock.mjs releaseInstallLockSync): a
// read-then-unlink could delete a lock another helper took over between the
// read and the unlink (CF-3, 2026-10-03 review).
function releaseLock(lockFile, token) {
  if (!token) return false;
  const released = `${lockFile}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    if (readJson(lockFile)?.token !== token) return false;
    fs.renameSync(lockFile, released);
    if (readJson(released)?.token === token) {
      fs.unlinkSync(released);
      return true;
    }
    // Not ours after all: put it back unless its owner already replaced it.
    if (!fs.existsSync(lockFile)) fs.renameSync(released, lockFile);
    return false;
  } catch { return false; }   // a stale-lock recovery may already have removed it
}
const lockOwnedBy = (lockFile, token) => Boolean(token) && readJson(lockFile)?.token === token;

export function fetchLatestStableVersion({
  timeoutMs = 8000,
  request = https.get,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = request('https://registry.npmjs.org/klypix-mcp/latest', {
      headers: {
        accept: 'application/json',
        'user-agent': 'klypix-mcp-auto-update',
      },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 128 * 1024) req.destroy(new Error('npm registry response was too large'));
      });
      response.on('end', () => {
        try {
          const version = JSON.parse(body)?.version;
          if (!strictSemver(version)) throw new Error(`invalid stable version ${JSON.stringify(version)}`);
          resolve(String(version));
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`npm registry timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

export function installExactRuntime(version, {
  brainDir,
  timeoutMs = 10 * 60 * 1000,
  spawnProcess = spawn,
} = {}) {
  if (!strictSemver(version)) return Promise.reject(new Error(`refusing invalid update version ${JSON.stringify(version)}`));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    let child;
    try {
      let command = 'npx';
      let args = ['-y', `klypix-mcp@${version}`, 'install', '--runtime-only'];
      if (process.platform === 'win32') {
        // .cmd files require a shell on Windows, but Node 24 correctly warns
        // that shell:true concatenates arguments. Invoke npm's JS entry with
        // this exact Node binary instead: no quoting ambiguity, no shell, and
        // the strict-semver gate above leaves no command-injection surface.
        const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
        if (fs.existsSync(npxCli)) {
          command = process.execPath;
          args = [npxCli, ...args];
        } else {
          // Portable fallback for unusual Windows Node layouts. The only
          // interpolated value is strict x.y.z semver.
          command = process.env.ComSpec || 'cmd.exe';
          args = ['/d', '/s', '/c', `npx -y klypix-mcp@${version} install --runtime-only`];
        }
      }
      child = spawnProcess(command, args, {
        cwd: brainDir,
        env: {
          ...process.env,
          KLYPIX_MCP_INSTALL_DIR: brainDir,
          KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
        },
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* */ }
      finish(new Error(`npm install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`npm installer exited ${code ?? signal ?? 'unknown'}`));
    });
  });
}

const tryWrite = (file, value) => {
  try { atomicJson(file, value); return null; }
  catch (error) { return cleanError(error); }
};

/**
 * Run one serialized update check.
 *
 * The fetch/install/reconcile/rules seams are injectable so the full policy can
 * be tested without touching a user's machine or contacting npm.
 */
export async function runAutoUpdateCheck({
  brainDir = process.env.KLYPIX_MCP_AUTO_UPDATE_DIR
    || path.join(os.homedir(), '.claude', 'project-brain'),
  currentVersion = process.env.KLYPIX_MCP_AUTO_UPDATE_CURRENT || null,
  enabled = autoUpdateEnabled(),
  force = process.env.KLYPIX_AUTO_UPDATE_FORCE === '1',
  now = Date.now(),
  ttlMs = AUTO_UPDATE_TTL_MS,
  fetchLatest = fetchLatestStableVersion,
  installVersion = installExactRuntime,
  reconcileProjects = reconcileRegisteredProjects,
  loadRules = loadInstalledAgentRules,
} = {}) {
  const files = autoUpdatePaths(brainDir);
  if (!enabled) return { checked: false, result: 'disabled' };
  const clock = validNow(now);
  const ttl = validTtl(ttlMs);

  // The helper consults the schedule WITHOUT the lock: acquiring the lock is
  // what answers "another helper is already checking" ('busy').
  const throttled = () => {
    const state = readCheckState(files);
    const stamp = state.stampRead.value;
    const plan = autoUpdateSchedule({
      stamp,
      stampState: state.stampRead.state,
      status: state.statusRead.value,
      installed: installIdentity(files.brainDir),
      lock: null,
      now: clock,
      enabled: true,
      ttlMs: ttl,
    });
    if (plan.due) return null;
    return {
      checked: false,
      result: 'throttled',
      lastCheck: isRecord(stamp) ? readTime(stamp.lastCheck, clock).ms : null,
      dueAt: isoAt(plan.dueAt),
      dueReason: plan.dueReason,
      ...(plan.error ? { error: plan.error } : {}),
    };
  };
  if (!force) {
    const skip = throttled();
    if (skip) return skip;
  }

  const token = acquireLock(files.lock, clock);
  if (!token) return { checked: false, result: 'busy' };
  try {
    // Another helper may have completed between the first read and lock acquisition.
    if (!force) {
      const skip = throttled();
      if (skip) return skip;
    }
    // Awaited INSIDE the try (2026-10-03): a bare `return finalize(...)` let
    // the finally release the lock before the harness pass and the status
    // write, and turned a failed status write into an unhandled rejection.
    return await checkWhileLocked({
      files, token, currentVersion, force, now: clock, ttlMs: ttl,
      fetchLatest, installVersion, reconcileProjects, loadRules,
    });
  } finally {
    releaseLock(files.lock, token);
  }
}

async function checkWhileLocked({
  files, token, currentVersion, force, now, ttlMs, fetchLatest, installVersion, reconcileProjects, loadRules,
}) {
  const state = readCheckState(files);
  const priorStamp = state.stampRead.value;
  const priorStatus = state.statusRead.value;
  const prior = isRecord(priorStatus) ? priorStatus : {};
  // The status, or the stamp's mirror of its identity and hold (CF-4).
  const record = outcomeRecord(state);
  const checkedAt = isoAt(now);
  const receipts = readInstallReceiptsSettled(files.brainDir);
  const identity = identityFromReceipts(receipts);
  // The decision view may use the caller's version (a direct-package launch has
  // no receipts yet); the identity that is RECORDED never does.
  const installed = runtimeFromReceipts(receipts.runtime.value, receipts.stamp.value, currentVersion);
  const evaluated = recordedIdentity(identity);
  // An unreadable stamp lost its count (CF-4). The status mirrors it for a
  // failed outcome; otherwise the unknown counts as one failed attempt — never
  // zero, which shrank a 4 h backoff to 15 min.
  const priorFailures = state.stampRead.state === 'unreadable'
    ? Math.max(1, prior.result === 'failed' ? sanitizeFailures(prior.attempt) : 0)
    : sanitizeFailures(priorStamp?.failures);
  const attempt = priorFailures + 1;
  const retryAt = now + retryDelay(attempt, ttlMs);
  const priorHarness = isRecord(prior.harness) ? prior.harness : null;
  // A4: a managed npm install that is now older than the install the last
  // result described was rolled back on purpose; hold the version it left.
  // Receipts that cannot be read keep whatever hold was recorded.
  let hold = identity.unknown ? sanitizeHold(record?.hold) : nextHold(record, identity, checkedAt);

  // Pessimistic pre-stamp: until a terminal outcome is recorded this attempt
  // COUNTS as failed. A helper killed after this point (sleep, shutdown, AV, the
  // 10-min npx timeout) therefore escalates 15 min → 1 h → 4 h, never a storm.
  // Every stamp also mirrors the hold, so losing the status keeps it (CF-4).
  const failedStamp = {
    protocol: 1,
    lastCheck: now,
    checkedAt,
    failures: attempt,
    nextCheckAt: retryAt,
    identity: evaluated,
    hold: hold || null,
    inProgress: { pid: process.pid, startedAt: checkedAt },
  };
  const stampError = tryWrite(files.stamp, failedStamp);
  if (stampError) {
    // With no stamp there is no backoff, so network work now would repeat on
    // every poll. Record what we can and stop before contacting npm.
    const status = {
      protocol: 1,
      result: 'failed',
      checkedAt,
      currentVersion: installed.version,
      identity: evaluated,
      attempt,
      error: `could not record the update attempt: ${stampError}`,
      ...(hold ? { hold } : {}),
      ...(priorHarness ? { harness: priorHarness } : {}),
    };
    const recordError = tryWrite(files.status, status);
    return { checked: true, ...status, ...(recordError ? { recordError } : {}) };
  }

  // CF-3 (2026-10-03 review): a live owner older than AUTO_UPDATE_LOCK_STALE_MS
  // is robbed by design (A8: a laptop that slept 2 h mid-check). Both helpers
  // then reach their terminal writes, in either order, and a false 'failed' —
  // the robber's installer could not take .install.lock from the live original
  // — landed on top of a good 'updated'. So before every terminal write:
  //   - a helper whose lock was taken records only an install it made itself
  //     (that install happened, whoever holds the lock now);
  //   - a failure never overwrites an outcome another helper recorded after
  //     this attempt's pre-stamp.
  const holdsLock = () => lockOwnedBy(files.lock, token);
  const preStampIntact = () => {
    const current = readReceipt(files.stamp);
    return current.state !== 'ok'
      || (current.value.lastCheck === now && current.value.inProgress?.pid === process.pid);
  };
  const superseded = (status) => ({ checked: true, ...status, superseded: true });

  const fail = (error, extra = {}) => {
    const status = {
      protocol: 1,
      result: 'failed',
      checkedAt,
      currentVersion: installed.version,
      ...extra,
      identity: evaluated,
      attempt,
      nextRetryAt: isoAt(retryAt),
      error: cleanError(error),
      ...(hold ? { hold } : {}),
      ...(priorHarness ? { harness: priorHarness } : {}),
    };
    if (!holdsLock() || !preStampIntact()) return superseded(status);
    const recordError = tryWrite(files.status, status);
    tryWrite(files.stamp, { ...failedStamp, inProgress: null });
    return { checked: true, ...status, ...(recordError ? { recordError } : {}) };
  };

  // A12: the pass rewrites tracked files in every registered project, so it
  // runs only when something it projects changed, or once a day.
  const harnessPass = async ({ passIdentity, version, mustRun = false }) => {
    let rules = null;
    let instructionsHash = null;
    try {
      rules = await loadRules(files.brainDir, version);
      instructionsHash = typeof rules?.INSTRUCTIONS_HASH === 'string' ? rules.INSTRUCTIONS_HASH : null;
    } catch { rules = null; }
    const lastAt = Date.parse(priorHarness?.checkedAt);
    const fresh = Number.isFinite(lastAt)
      && now - lastAt < AUTO_UPDATE_HARNESS_REFRESH_MS
      && lastAt - now <= AUTO_UPDATE_CLOCK_SKEW_MS;
    if (!mustRun && priorHarness && fresh
      && sameIdentity(priorHarness.identity, passIdentity)
      && (priorHarness.instructionsHash ?? null) === instructionsHash) {
      return priorHarness;
    }
    let summary;
    try {
      summary = await reconcileProjects({ brainDir: files.brainDir, version, rules, now });
    } catch (error) {
      summary = {
        checked: 0,
        updated: 0,
        unchanged: 0,
        failed: 1,
        skipped: 0,
        projects: [],
        error: cleanError(error),
      };
    }
    return { ...summary, checkedAt, version: version || null, identity: passIdentity, instructionsHash };
  };

  const finish = async (status, pass = null) => {
    // Robbed (CF-3): only an install this helper made is still its to record.
    if (!holdsLock() && !['updated', 'bootstrapped'].includes(status.result)) return superseded(status);
    const harness = pass ? await harnessPass(pass) : priorHarness;
    const complete = { ...status, ...(harness ? { harness } : {}) };
    const recordError = tryWrite(files.status, complete);
    if (recordError) {
      // An outcome that was not recorded does not count: keep the attempt
      // counted (the pre-stamp's backoff) so the next check redoes it.
      tryWrite(files.stamp, { ...failedStamp, inProgress: null });
      return { checked: true, ...complete, recordError };
    }
    tryWrite(files.stamp, {
      protocol: 1,
      lastCheck: now,
      checkedAt,
      failures: 0,
      nextCheckAt: now + ttlMs,
      identity: complete.identity,
      hold: complete.hold || null,
      inProgress: null,
    });
    return { checked: true, ...complete };
  };

  if (identity.unknown) {
    // Never act on receipts we could not read: half-written dev receipts look
    // exactly like "no runtime yet", and bootstrapping over them breaks the
    // dev-owned contract. A short retry is the safe default.
    return fail(new Error(`install receipts unreadable — ${identity.error}`));
  }

  if (installed.dev) {
    // Never fetched for: the developer's deploy owns these files.
    return finish({
      protocol: 1,
      result: 'dev-owned',
      checkedAt,
      currentVersion: installed.version,
      identity: evaluated,
      ...(hold ? { hold } : {}),
    });
  }

  let latestVersion;
  try {
    const fetched = await fetchLatest();
    if (!strictSemver(fetched)) throw new Error(`registry returned invalid stable version ${JSON.stringify(fetched)}`);
    latestVersion = String(fetched).trim();
  } catch (error) {
    return fail(error);
  }

  const decision = autoUpdateDecision({ installed, latestVersion, hold: force ? null : hold });
  const settled = (result, extra = {}) => ({
    protocol: 1,
    result,
    checkedAt,
    currentVersion: installed.version,
    latestVersion,
    ...extra,
    identity: evaluated,
    ...(hold ? { hold } : {}),
  });
  const pass = { passIdentity: evaluated, version: installed.version };
  if (decision === 'major-blocked') {
    return finish(settled('major-blocked', {
      error: `major update v${installed.version} → v${latestVersion} requires a manual install`,
    }), pass);
  }
  if (decision !== 'install') return finish(settled(decision), pass);

  try {
    await installVersion(latestVersion, { brainDir: files.brainDir });
  } catch (error) {
    return fail(error, { latestVersion });
  }
  const verified = identityFromReceipts(readInstallReceiptsSettled(files.brainDir));
  if (verified.unknown) {
    return fail(new Error(`installer completed but its receipts are unreadable — ${verified.error}`), { latestVersion });
  }
  if (verified.dev) {
    // AU-4: a developer deploy (brain:deploy stamps dev:true and takes no
    // install lock) won the race during the fetch window. It owns the runtime
    // now; claiming 'updated' would be false.
    return finish({
      protocol: 1,
      result: 'dev-owned',
      checkedAt,
      currentVersion: installed.version,
      latestVersion,
      identity: recordedIdentity(verified),
      ...(hold ? { hold } : {}),
    });
  }
  if (!verified.managed || compareSemver(verified.version, latestVersion) !== 0) {
    return fail(new Error(`installer completed but managed runtime is v${verified.version || 'unknown'}, expected v${latestVersion}`), { latestVersion });
  }
  // A newer release supersedes the hold (and a forced install clears it).
  if (hold && compareSemver(verified.version, hold.version) >= 0) hold = null;
  const verifiedIdentity = recordedIdentity(verified);
  return finish({
    protocol: 1,
    result: installed.managed ? 'updated' : 'bootstrapped',
    checkedAt,
    currentVersion: installed.version,
    latestVersion,
    installedVersion: verified.version,
    lastUpdatedAt: new Date().toISOString(),
    // The VERIFIED identity: the helper's own install must never read as a
    // change that re-triggers a check.
    identity: verifiedIdentity,
    ...(hold ? { hold } : {}),
  }, { passIdentity: verifiedIdentity, version: verified.version, mustRun: true });
}

if (process.argv.includes(AUTO_UPDATE_WORKER_ARG)) {
  // Detached with stdio ignored: a rejection here would vanish with the
  // process. runAutoUpdateCheck records its own failures; this only keeps a
  // truly unexpected one from dying as an unhandled rejection.
  try { await runAutoUpdateCheck(); }
  catch { process.exitCode = 1; }
}

export const __test = {
  compareSemver,
  strictSemver,
  acquireLock,
  releaseLock,
  atomicJson,
  retryDelay,
  processAppearsAlive,
};
