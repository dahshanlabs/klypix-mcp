// brain-doctor — the brain reads its OWN state and reports it as ONE fact.
// ============================================================================
// The audited gap: klypix had a dozen stamps and footers but no single surface that
// answers "is THIS brain current, are my hooks wired, is the harness projection in
// sync, and who else is live?". Liveness ("a process is up") was conflated with
// readiness ("fully wired + consistent"). This is that surface — a pure, read-only
// inspection over seams that already exist:
//
//   • VERSION   — the BAKED brain-core version (PKG_VERSION in the installed
//                 klypix-mcp-server.mjs) is the source of truth, because the install
//                 stamp's version key is channel-dependent (npm writes `brainVersion`,
//                 the desktop app writes `appVersion`). + the deploy `dirty` flag.
//   • CLAUDE    — are all 4 existing Claude Code hooks wired (HOOK_MARK present)?
//   • CODEX     — automatic MCP presence + optional enhanced lifecycle hooks.
//   • TOOLS     — the discoverable MCP verb manifest (what the installed server
//                 REALLY registers) so a caller can't assume a phantom tool.
//   • SESSIONS  — all live MCP/lifecycle sessions on this project's brain, by host.
//   • HARNESS   — per-file projection drift (ok/stale/hand-edited/missing) via the
//                 versioned fence in agent-rules.
//
// Pure node builtins + agent-rules (both in the published package). Never throws on a
// missing seam — an absent file is a fact to report, not an error.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { auditProject, codexGlobalInstructionsInstalled, resolveVersion } from './agent-rules.mjs';
import { detectEditors } from './editor-detect.mjs';
import { codexPresenceHookStatus } from './codex-hooks.mjs';
import { renderReceiptSummary, summarizeReceipts } from './finding-routing.mjs';

// The updater, loaded failure-tolerant (2026-10-03): the doctor must load beside
// an OLDER, missing or half-written mcp-auto-update.mjs (an install that stopped
// half-way renames files one at a time) and diagnose it. A named import of an
// export that file lacks fails at LINK time and takes the whole doctor down;
// here a missing member is just undefined and every use below falls back.
let autoUpdateLib = {};
try { autoUpdateLib = await import('./mcp-auto-update.mjs'); } catch { autoUpdateLib = {}; }

// klypix-format is the DECAY-GUARD seam (classifyDecay + the status renderer),
// loaded failure-tolerant: the doctor's doctrine is "an absent seam is a fact
// to report, not an error" — klypix-format pulls jszip, and a broken/partial
// install must degrade the layer to 'unknown', never kill the doctor. The
// sibling './' specifier resolves identically in the package (src/) and the
// flat deployed (~/.claude/project-brain) layouts; top-level await keeps
// inspect() synchronous for its existing callers.
let fmtLib = null;
try { fmtLib = await import('./klypix-format.mjs'); } catch { fmtLib = null; }
let gitCaptureLib = null;
try { gitCaptureLib = await import('./git-capture-install.mjs'); } catch { gitCaptureLib = null; }
let historyLib = null;
try { historyLib = await import('./brain-history.mjs'); } catch { historyLib = null; }
// repo-state powers the advisory CHECKOUT line (released-tag visibility). Same
// failure-tolerant idiom: a half-updated flat bundle that predates the module
// must degrade to omitting the line, never kill the doctor.
let repoStateLib = null;
try { repoStateLib = await import('./repo-state.mjs'); } catch { repoStateLib = null; }
// agent-presence is the CANONICAL owner of the session-liveness rule (freshness
// windows + dead-host sweep). The doctor deliberately keeps reading lane files
// directly so it can diagnose a broken bundle, so this import is failure-
// tolerant too: on a bundle without it, the local fallback literals below keep
// the doctor alive — but a healthy bundle can no longer drift from the engine
// (the exact drift that once produced three different live-session counts).
let presenceLib = null;
try { presenceLib = await import('./agent-presence.mjs'); } catch { presenceLib = null; }
// provenance powers the informational JUDGMENTS line (confirm/dismiss verdict
// counts + rejected-prompt pool). Same failure-tolerant idiom; absence of the
// module OR of any records is a fact, never drift.
let provenanceLib = null;
try { provenanceLib = await import('./provenance.mjs'); } catch { provenanceLib = null; }

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
// Same normalization the hook uses to key the sessions lane: forward slashes + a
// lowercased drive letter, so the CLI computes the SAME sessions filename the hook wrote.
const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;
// "3h 55m", "45m", "2d 4h": the age and ETA unit of the AUTO-UPDATE lines.
const durationText = (ms) => {
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), mins = minutes % 60;
  if (hours < 48) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24), hrs = hours % 24;
  return hrs ? `${days}d ${hrs}h` : `${days}d`;
};
// ISO 8601 to the minute, UTC: unambiguous when a report is pasted elsewhere.
const isoMinute = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
  ? `${new Date(ms).toISOString().slice(0, 16)}Z`
  : 'unknown time');
const timeOf = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' ? Date.parse(value) : NaN;
};

// The cadence of this doctor's SIBLING updater module. In the flat bundle that
// is the installed one; run from npx it is the package's own copy, and after a
// rollback the installed one can be older — autoUpdateView reads the installed
// file's AUTO_UPDATE_API and follows ITS rules (2026-10-03 review). The
// fallbacks are the pre-2026-10-03 values, which is what an older sibling (the
// only kind that lacks these exports) runs.
const AUTO_UPDATE_TTL_MS = Number(autoUpdateLib.AUTO_UPDATE_TTL_MS) > 0
  ? Number(autoUpdateLib.AUTO_UPDATE_TTL_MS) : 24 * 60 * 60 * 1000;
const AUTO_UPDATE_POLL_MS = Number(autoUpdateLib.AUTO_UPDATE_POLL_MS) > 0
  ? Number(autoUpdateLib.AUTO_UPDATE_POLL_MS) : 60 * 60 * 1000;

// C6 (2026-10-03): say WHICH doctor is talking. A bare `npx klypix-mcp doctor`
// inside a project that pins klypix-mcp as a devDependency runs THAT copy —
// 1.67.0 in the KLYPIX app checkout, a doctor without half of today's layers —
// and nothing said so. The flat bundle (~/.claude/project-brain) has no
// package.json of ours: there the version is the baked PKG_VERSION of the
// server beside this file. Unknown stays null; it is never guessed.
function resolveDoctorVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const baked = readText(path.join(here, 'klypix-mcp-server.mjs'))?.match(/const PKG_VERSION = '([^']+)'/)?.[1];
  if (baked) return baked;
  const pkg = readJson(path.join(PKG_ROOT, 'package.json'), null);
  return pkg?.name === 'klypix-mcp' && typeof pkg.version === 'string' ? pkg.version : null;
}
const DOCTOR_VERSION = resolveDoctorVersion();

const HOOK_MARK = 'global-brain-hook';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse'];
// Liveness windows imported from the canonical rule; literals are the LAST
// RESORT for a bundle whose agent-presence predates the exports.
const SESSION_FRESH_MS = Number(presenceLib?.SESSION_FRESH_MS) > 0
  ? Number(presenceLib.SESSION_FRESH_MS) : 10 * 60 * 1000;
const MCP_SESSION_FRESH_MS = Number(presenceLib?.MCP_SESSION_FRESH_MS) > 0
  ? Number(presenceLib.MCP_SESSION_FRESH_MS) : 3 * 60 * 1000;

// ── VERSION layer ────────────────────────────────────────────────────────────
function inspectVersion(brainDir) {
  // The baked version in the DEPLOYED server is authoritative (channel-independent).
  const serverSrc = readText(path.join(brainDir, 'klypix-mcp-server.mjs'));
  const m = serverSrc && serverSrc.match(/const PKG_VERSION = '([^']+)'/);
  const baked = m ? m[1] : null;
  const stamp = readJson(path.join(brainDir, '.brain-version.json'), null);
  // The stamp's version is `brainVersion` (npm) OR `appVersion` (desktop app) — read both.
  const stampVersion = stamp ? (stamp.brainVersion || stamp.appVersion || null) : null;
  return {
    installed: !!serverSrc || !!stamp,
    baked,                                     // real brain-core version (or null if not deployed)
    supervisorCapable: !!(serverSrc && serverSrc.includes('runMcpSupervisor'))
      && fs.existsSync(path.join(brainDir, 'mcp-supervisor.mjs')),
    channel: stamp?.via || null,               // 'npm' | 'app' | 'dev' | null
    stampVersion,                              // provenance only (namespace varies by channel)
    dirty: !!(stamp && stamp.dirty),
    dev: !!(stamp && stamp.dev),
    sourceSha: stamp?.sourceSha || null,
    installedAt: stamp?.installedAt || stamp?.deployedAt || null,
  };
}

// ── HOOKS (readiness) layer ──────────────────────────────────────────────────
function inspectHooks(home) {
  const settings = readJson(path.join(home, '.claude', 'settings.json'), null);
  const wiredFor = (evt) => {
    const groups = settings?.hooks?.[evt];
    return Array.isArray(groups) && groups.some(g => Array.isArray(g?.hooks)
      && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
  };
  const present = !!settings;
  const wired = present ? HOOK_EVENTS.filter(wiredFor) : [];
  const missing = present ? HOOK_EVENTS.filter(e => !wired.includes(e)) : HOOK_EVENTS.slice();
  // Informational (never a verdict): installs before 1.86.2 wired SessionStart
  // for "startup|resume" only, so /clear starts a conversation with no brain
  // brief. A runtime-only update never rewrites settings.json; a full
  // `npx klypix-mcp install` does. An empty/absent matcher means every source.
  const ours = (Array.isArray(settings?.hooks?.SessionStart) ? settings.hooks.SessionStart : [])
    .filter(g => Array.isArray(g?.hooks) && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
  const coversClear = (g) => !g.matcher || String(g.matcher).split('|').map(x => x.trim()).some(x => x === 'clear' || x === '*');
  const sessionStartMissesClear = ours.length > 0 && !ours.some(coversClear);
  return { settingsPresent: present, wired, missing, sessionStartMissesClear };
}

// ── TOOLS (discoverable manifest) layer ──────────────────────────────────────
function inspectTools(brainDir, pkgRoot) {
  // Prefer the DEPLOYED server (what this machine's brain actually exposes); fall back
  // to the running package's server file. Regex the registration list — no import, no
  // spawning the stdio server.
  const candidates = [
    path.join(brainDir, 'klypix-mcp-worker.mjs'),
    path.join(brainDir, 'klypix-mcp-server.mjs'),
    path.join(pkgRoot, 'bin', 'klypix-worker.mjs'),
    path.join(pkgRoot, 'bin', 'klypix-mcp.mjs'),
  ];
  for (const f of candidates) {
    const src = readText(f);
    if (!src) continue;
    const names = [];
    // Also match ext-apps' registerAppTool(server, 'name', …) — the canvas_view
    // MCP App registers through it; the manifest must count it or doctor drifts.
    const re = /(?:server\.registerTool|registerAppTool)\(\s*(?:server\s*,\s*)?['"]([^'"]+)['"]/g;
    let mm; while ((mm = re.exec(src))) names.push(mm[1]);
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length) return { names: uniqueNames, count: uniqueNames.length, source: f.startsWith(brainDir) ? 'deployed' : 'package', hash: sha(uniqueNames.slice().sort().join(',')).slice(0, 8) };
  }
  return { names: [], count: 0, source: null, hash: null };
}

// ── RUNNING layer (behavioral truth, not a baked stamp) ──────────────────────
// The baked-file VERSION layer certifies whatever install last wrote — NOT the
// process actually answering MCP tool calls (an npx-spawned server serves its warm
// cache, which can lag the install). Servers record {pid, version, vault,
// lastSeenAt} into a per-pid REGISTRY (.running-servers.json); comparing to the baked version
// surfaces the "stamp says current, live server is stale" incident as DRIFT.
//
// Per-pid matters: MCP servers are per-session, so a single shared value is last-
// writer-wins and could report a DIFFERENT session's server (a phantom). Two modes:
//   • self (brain_doctor called AS the MCP tool, inside a server): report THAT
//     process's version — authoritative for the caller, never a phantom.
//   • CLI (separate process): enumerate every LIVE server (dead pids and stale
//     renewable heartbeats pruned); drift
//     if ANY live server ≠ installed, so a multi-version machine is visible, not hidden.
const RUNNING_HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
const RUNNING_LEGACY_GRACE_MS = 5 * 60 * 1000;
// Alive ONLY if we can signal it: ESRCH (dead) and EPERM (another user's process,
// never our MCP server) both count as NOT a live server of ours — narrows the
// reused-PID phantom; the age ceiling bounds the same-user-reuse remainder.
const isAlivePid = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function inspectRunning(brainDir, baked, now, self) {
  const ageMin = (b) => { const m = b ? Math.round((now - Date.parse(b)) / 60000) : null; return Number.isFinite(m) ? m : null; };
  const freshEntry = (server) => {
    const heartbeat = Date.parse(server?.lastSeenAt);
    if (Number.isFinite(heartbeat)) return (now - heartbeat) < RUNNING_HEARTBEAT_FRESH_MS;
    const booted = Date.parse(server?.bootedAt);
    return Number.isFinite(booted) && (now - booted) < RUNNING_LEGACY_GRACE_MS;
  };
  const fmt = (s) => ({
    pid: s.pid || null,
    version: s.version,
    vault: s.vault || null,
    ageMin: ageMin(s.bootedAt),
    heartbeatAgeMin: ageMin(s.lastSeenAt),
  });
  // Live servers from the registry (prune dead pids + aged-out phantoms); fall back
  // to the legacy single-file heartbeat only if the registry is absent/empty.
  let live = [];
  const reg = readJson(path.join(brainDir, '.running-servers.json'), null);
  if (reg && Array.isArray(reg.servers)) live = reg.servers.filter(s => s && s.version && isAlivePid(s.pid) && freshEntry(s));
  if (!live.length) {
    // Legacy single-file heartbeat (a still-running pre-registry server). Trust it
    // ONLY if its pid is alive + fresh — a dead server's leftover file must never
    // read as a live stale server (that would be the very phantom this fix prevents).
    const legacy = readJson(path.join(brainDir, '.running-version.json'), null);
    if (legacy && legacy.version && isAlivePid(legacy.pid) && freshEntry(legacy)) live = [{ pid: legacy.pid || null, version: legacy.version, bootedAt: legacy.bootedAt || null }];
  }
  // self mode — report the CALLER's own process (definitive, phantom-proof).
  if (self && self.version) {
    return {
      known: true, self: true, version: self.version, pid: self.pid || null,
      matchesInstalled: baked ? cmpSemver(self.version, baked) === 0 : null,
      others: live.filter(s => s.pid !== self.pid).map(fmt),   // other live servers, for visibility
    };
  }
  // CLI mode — no single "mine"; report the live set.
  if (!live.length) return { known: false, self: false, version: null, matchesInstalled: null, servers: [] };
  const servers = live.map(fmt);
  const versions = [...new Set(servers.map(s => s.version))];
  return {
    known: true, self: false,
    version: versions.length === 1 ? versions[0] : versions.join(', '),
    matchesInstalled: baked ? servers.every(s => cmpSemver(s.version, baked) === 0) : null,
    servers,
  };
}

// ── PEERS (alignment) layer ──────────────────────────────────────────────────
// A supervisor with a live pid can still be a ZOMBIE: recovery-failed means it
// has NO worker and every queued host request hangs — the pid-alive check alone
// rendered exactly that state as "✅ SUPERVISOR N live" (2026-07-29 audit,
// field pid 12312 exit 0xC0000142). These statuses mean the transport is
// impaired regardless of process liveness.
//
// Two more ways the receipts misled the verdict (2026-10-03, 921 samples on the
// founder's PC):
//   • A DEAD receipt whose pid Windows had reused. .supervisors/3228.json named a
//     pid ChatGPT.exe now held, its host (parent 7632) long gone; it counted as a
//     live supervisor and its sleeping v1.86.0 target kept the verdict DRIFTED.
//     A live supervisor closes itself within 30 s of its host dying (its parent
//     watchdog), so: parent provably gone (ESRCH — EPERM means alive) and the
//     receipt silent for more than 120 s = dead. The same rule as the
//     supervisor's own boot cleanup.
//   • The 1-5 s of a wake or a hot-swap. All 363 IMPAIRED readings in that
//     sample were a pair with no active worker and a live candidate. Every
//     internal supervisor call times out at 15 s, so a real candidate never
//     leaves its receipt silent for 45 s: a fresher receipt is TRANSITIONING —
//     requests queue, nothing is lost, nothing needs a reconnect.
const SUPERVISOR_DEAD_RECEIPT_MS = 120 * 1000;
const SUPERVISOR_TRANSITION_MS = 45 * 1000;
const WAKING_STATUSES = new Set(['validating-update', 'update-ready', 'recovering', 'recovery-ready']);
const majorOf = (version) => {
  const match = String(version || '').match(/^v?(\d+)\.\d+\.\d+/);
  return match ? Number(match[1]) : null;
};
// 'alive' | 'dead' | 'foreign' | 'unknown'. Only ESRCH proves a process gone.
// EPERM is a live process this user may not signal: never a supervisor of ours
// to count (the isAlivePid rule), and never a dead parent either.
const pidState = (pid) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return 'dead';
  try { process.kill(n, 0); return 'alive'; }
  catch (error) { return error?.code === 'ESRCH' ? 'dead' : (error?.code === 'EPERM' ? 'foreign' : 'unknown'); }
};

function inspectSupervisors(brainDir, baked, now = Date.now()) {
  const dir = path.join(brainDir, '.supervisors');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { /* absent */ }
  const live = [];
  let deadReceipts = 0;
  for (const name of names) {
    const state = readJson(path.join(dir, name), null);
    if (!state?.pid) continue;
    const self = pidState(state.pid);
    if (self === 'dead') { deadReceipts++; continue; }
    if (self !== 'alive') continue;     // another user's process, or unknowable: not ours to count
    const updatedMs = Date.parse(state.updatedAt);
    const receiptAgeMs = Number.isFinite(updatedMs) ? now - updatedMs : null;
    const parentPid = Number(state.parentPid);
    // Identical to the boot cleanup's rule (mcp-supervisor.mjs, B7): a receipt
    // every supervisor writes carries updatedAt, so one without it has no owner.
    if (Number.isInteger(parentPid) && parentPid > 1 && pidState(parentPid) === 'dead'
      && (receiptAgeMs === null || receiptAgeMs > SUPERVISOR_DEAD_RECEIPT_MS)) {
      deadReceipts++;
      continue;
    }
    const status = state.status || 'unknown';
    const intentionallyHibernated = status === 'hibernated'
      && state.hibernation?.hibernated === true;
    const sleepingTarget = intentionallyHibernated ? state.hibernation?.target : null;
    // B1 supervisors keep `target` = the version the pair last ran and record a
    // newer valid manifest as `pendingWakeTarget` instead of waking for it.
    const pendingWake = intentionallyHibernated && state.hibernation?.pendingWakeTarget?.version
      ? state.hibernation.pendingWakeTarget : null;
    const candidate = state.candidate && typeof state.candidate === 'object' ? state.candidate : null;
    const fresh = receiptAgeMs !== null && Math.abs(receiptAgeMs) < SUPERVISOR_TRANSITION_MS;
    const candidateLive = Boolean(candidate?.pid) && pidState(candidate.pid) === 'alive';
    const transition = !fresh || !candidateLive ? null
      : (!state.active && WAKING_STATUSES.has(status) ? 'waking'
        : (state.active && baked && candidate.version && cmpSemver(candidate.version, baked) === 0 ? 'swapping' : null));
    const recordedDelivery = state.transport?.delivery
      || (intentionallyHibernated ? 'pull-only' : (state.active ? 'connected' : 'unknown'));
    // The supervisor writes delivery 'impaired' whenever no worker is active,
    // which is also true for the second a wake takes; requests then wait in its
    // queue. A broken or backpressured host pipe stays what it is.
    const deliveryStatus = transition === 'waking' && !['impaired', 'backpressured'].includes(state.transport?.host)
      ? 'queued' : recordedDelivery;
    // F6 (2026-10-03 review): a sleeping pair whose last wake found no
    // consistent core to boot (wakeDeferred, which the supervisor writes on the
    // first refused wake) answers every request with an error until the core
    // files verify. It used to read "wakes on the next request".
    // Only that refusal counts (K1-DOCTOR-WAKEBLOCKED-FALSE, 2026-10-03 review),
    // the rule `klypix-mcp runtime` follows (runtime-inspector wakeBlock). An
    // integrity error the receipt merely carries is not one: the wake resumes
    // .prev when it holds this pair's version — every pair K1 booted from .prev
    // records the error in its first receipt and wakes from .prev — or the
    // package's own worker outside the managed directory. Read as "cannot
    // wake", every connection that started during a failing install was
    // printed IMPAIRED while it woke without trouble. The error itself is still
    // shown on the pair's line.
    const wakeDeferred = intentionallyHibernated && state.hibernation?.wakeDeferred
      && typeof state.hibernation.wakeDeferred === 'object' ? state.hibernation.wakeDeferred : null;
    // Only a wake the supervisor actually refused proves a sleeping pair cannot
    // wake — the same rule as `klypix-mcp runtime` (wakeBlock). An integrity error
    // alone does not: the wake waits for the install to settle, and a pair that
    // served from .prev resumes that snapshot while it still verifies.
    const wakeBlocked = intentionallyHibernated && Boolean(wakeDeferred);
    const workerImpaired = (!state.active && !intentionallyHibernated && transition !== 'waking'
      && status !== 'starting' && status !== 'awaiting-initialize') || wakeBlocked;
    const deliveryImpaired = deliveryStatus === 'impaired' || state.transport?.host === 'impaired';
    // The version this pair serves, is switching to, or wakes into next.
    const effectiveVersion = transition ? (candidate.version || null)
      : (state.active ? (state.active.version || null) : (pendingWake?.version || sleepingTarget?.version || null));
    // F5 (2026-10-03 review): a recorded wake target in another MAJOR than the
    // version the pair last ran is refused by the wake's own gate (a reconnect
    // error, or a .prev resume that still needs one). Not benign.
    const wakeCrossesMajor = Boolean(pendingWake && sleepingTarget?.version
      && majorOf(pendingWake.version) !== null && majorOf(pendingWake.version) !== majorOf(sleepingTarget.version));
    const alignment = !baked || !effectiveVersion ? 'unknown'
      : (wakeCrossesMajor ? 'reconnect-on-wake'
        : (cmpSemver(effectiveVersion, baked) !== 0 ? 'mismatch'
          : (pendingWake && sleepingTarget?.version && cmpSemver(sleepingTarget.version, baked) !== 0 ? 'pending-wake' : 'match')));
    live.push({
      pid: state.pid,
      status,
      // IMPAIRED = no live worker outside the normal boot window: tool calls
      // hang/fail. 'restart-required' with a live active worker is DEGRADED
      // (an update was rejected, the old worker keeps serving) — flagging that
      // red as "tool calls hang" would be factually wrong (review-caught).
      impaired: workerImpaired || deliveryImpaired,
      workerImpaired,
      deliveryImpaired,
      wakeBlocked,
      wakeDeferred,
      bootedAt: typeof state.bootedAt === 'string' ? state.bootedAt : null,
      degraded: deliveryStatus === 'backpressured' || state.transport?.host === 'backpressured',
      deliveryStatus,
      transport: state.transport || null,
      transition,
      activePid: state.active?.pid || null,
      activeVersion: state.active?.version || sleepingTarget?.version || null,
      activePath: state.active?.path || sleepingTarget?.path || null,
      candidateVersion: candidate?.version || null,
      effectiveVersion,
      wakeVersion: intentionallyHibernated && !wakeBlocked && !wakeCrossesMajor ? (pendingWake?.version || sleepingTarget?.version || null) : null,
      pendingWakeVersion: pendingWake?.version || null,
      alignment,
      hotReloads: Number(state.hotReloads || 0),
      lastSwapAt: state.lastSwapAt || null,
      lastError: state.lastError || null,
      updatedAt: state.updatedAt || null,
      // A worker hot-swaps behind a live connection; the SUPERVISOR cannot
      // replace its own process under the host's stdio, so supervisor-level
      // features arrive only on the next reconnect. Without this the doctor
      // reported "aligned" (true of workers) while a shipped supervisor
      // feature was silently inactive — the same class as rendering a
      // truncated list as a complete one.
      supervisorGeneration: state.hibernation ? 'current' : 'pre-1.57',
      // B9: supervisors carrying the 2026-10-03 fixes (hibernation that stays
      // asleep, gated wakes) write their own code version. The key's ABSENCE
      // is what marks pre-fix code; its value may be null in odd layouts.
      supervisorVersion: typeof state.supervisorVersion === 'string' ? state.supervisorVersion : null,
      preFix: !Object.prototype.hasOwnProperty.call(state, 'supervisorVersion'),
      // Each process reads KLYPIX_AUTO_UPDATE from its OWN environment; the
      // receipt is the only place a host's setting is visible.
      autoUpdateEnabled: typeof state.autoUpdate?.enabled === 'boolean' ? state.autoUpdate.enabled : null,
      // K3: when this supervisor last polled the update schedule — the overdue
      // rule's evidence. Absent from receipts written by older supervisor code.
      lastPollAt: typeof state.autoUpdate?.lastPollAt === 'string' ? state.autoUpdate.lastPollAt : null,
      hibernation: state.hibernation || null,
    });
  }
  const pendingReconnect = live.filter(state => state.supervisorGeneration !== 'current');
  return {
    active: live.length > 0,
    count: live.length,
    live,
    deadReceipts,
    pendingReconnect,
    preFix: live.filter(state => state.preFix),
    hibernated: live.filter(state => state.status === 'hibernated'),
    transitioning: live.filter(state => state.transition),
    impaired: live.filter(state => state.impaired),
    // Every live pair serves, is switching to, or wakes into the installed
    // version. A hibernated pair whose recorded wake target is the installed
    // version is benign (it validates that target on its next request).
    matchesInstalled: live.length && baked
      ? live.every(state => state.alignment === 'match' || state.alignment === 'pending-wake')
      : null,
  };
}

// ── ENGINE CODE layer (unreceipted modules, 2026-10-03) ──────────────────────
// The install receipt (.mcp-runtime.json `files`) names every module an
// installer put in the managed directory, with its hash. On the founder's PC,
// merge-brains.mjs and klypix-merge-driver.mjs sat outside the 1.88.0 receipt
// matching no release, and the KLYPIX repo's git merge driver runs
// `node <brainDir>/klypix-merge-driver.mjs` on every brain merge — code no
// installer vouched for, executing silently. The desktop installer
// (klypix-app electron/projectBrainInstaller.ts SCRIPTS) also stages these four
// beside the npm bundle; an npm receipt never lists them.
const DESKTOP_EXTRA_SCRIPTS = new Set(['klypix-brain.mjs', 'brain-sync-core.mjs', 'export-klypix.mjs', 'import-jsoncanvas.mjs']);
// What `node klypix-merge-driver.mjs` loads from this directory.
const MERGE_DRIVER_CLOSURE = new Set(['klypix-merge-driver.mjs', 'merge-brains.mjs', 'brain-graveyard.mjs', 'klypix-format.mjs']);
// Modules a release staged and a later one dropped without deleting (F7,
// 2026-10-03 review). Nothing current imports them, so they are leftovers to
// delete, not a readiness gap: remote-client.mjs sat on every machine that ever
// ran v1.66.1–v1.72.0 and would have read PARTIAL there forever.
const RETIRED_ENGINE_MODULES = new Map([
  ['remote-client.mjs', 'KLYPIX Remote, staged by v1.66.1–v1.72.0'],
]);
const NO_ENGINE_CODE = { checked: false, receiptVersion: null, total: 0, desktopExtras: [], retired: [], unreceipted: [], mergeDriverFiles: [] };
export function inspectEngineCode(brainDir) {
  const receipt = readJson(path.join(brainDir, '.mcp-runtime.json'), null);
  const files = receipt && typeof receipt.files === 'object' && !Array.isArray(receipt.files) ? receipt.files : null;
  if (!files) return { ...NO_ENGINE_CODE };
  const key = (name) => String(name).toLowerCase();
  const covered = new Set(Object.keys(files).map(key));
  let names = [];
  try {
    names = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.mjs$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch { return { ...NO_ENGINE_CODE }; }
  const outside = names.filter((name) => !covered.has(key(name)));
  const retired = outside.filter((name) => RETIRED_ENGINE_MODULES.has(key(name)));
  const unreceipted = outside.filter((name) => !DESKTOP_EXTRA_SCRIPTS.has(key(name)) && !RETIRED_ENGINE_MODULES.has(key(name)));
  return {
    checked: true,
    receiptVersion: typeof receipt.version === 'string' ? receipt.version : null,
    total: names.length,
    desktopExtras: outside.filter((name) => DESKTOP_EXTRA_SCRIPTS.has(key(name))),
    retired: retired.map((name) => ({ name, origin: RETIRED_ENGINE_MODULES.get(key(name)) })),
    unreceipted,
    mergeDriverFiles: unreceipted.filter((name) => MERGE_DRIVER_CLOSURE.has(key(name))),
  };
}

// ── AUTO-UPDATE view (2026-10-03) ────────────────────────────────────────────
// The old line printed a hard-coded "24h" and the raw status: '[ok] … last result
// dev-owned v1.86.0' beside 'VERSION brain core v1.88.0 via npm', a day after a
// manual install made the runtime npm-owned. This derives what the doctor may
// honestly say from inspectAutoUpdate (the updater's own schedule), the live
// supervisors' receipts and the local npm caches — never the network.

// The npm version this machine already knows, freshest first. The updater's
// status carries the version it fetched at checkedAt; the Stop hook's cache
// (global-brain-hook.mjs NPM_CURRENCY) stamps `latestAt` on a SUCCESSFUL fetch
// since 2026-10-03, while older caches stamp checkedAt even when the fetch
// failed (they then carry lastError) — their age is unknown in that case.
// Read from THIS brainDir, never os.homedir(): fixtures and other homes must
// not see the live machine's cache.
function knownNpmLatest(brainDir, au, npmLatest, now) {
  const candidates = [];
  if (STRICT_SEMVER.test(String(npmLatest || ''))) candidates.push({ version: String(npmLatest), at: now, source: 'npm view' });
  if (STRICT_SEMVER.test(String(au?.latestVersion || ''))) {
    const at = timeOf(au.checkedAt);
    candidates.push({ version: String(au.latestVersion), at: Number.isFinite(at) ? at : null, source: 'last update check' });
  }
  const cache = readJson(path.join(brainDir, '.npm-currency.json'), null);
  if (cache && STRICT_SEMVER.test(String(cache.latest || ''))) {
    let at = timeOf(cache.latestAt);
    if (!Number.isFinite(at)) at = cache.lastError ? NaN : timeOf(cache.checkedAt);
    candidates.push({ version: String(cache.latest), at: Number.isFinite(at) ? at : null, source: 'session-end npm cache' });
  }
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => ((item.at ?? -Infinity) > (best.at ?? -Infinity) ? item : best));
}

// The hold the NEXT check will record (mcp-auto-update.mjs rolledBackFrom). Until
// the helper runs, a deliberate --force downgrade shows only as a stale
// 'manual-downgrade' result; deciding without it would promise to re-install
// the very version the owner rolled back from.
function predictedHold(au) {
  if (!au || au.hold || au.staleReason !== 'manual-downgrade') return null;
  const current = au.installedIdentity;
  if (!current || current.unknown || current.dev || current.managed !== true || !STRICT_SEMVER.test(String(current.version || ''))) return null;
  const evaluated = au.identity;
  const candidates = [];
  if (evaluated && !evaluated.dev && (evaluated.legacy
    ? ['current', 'updated', 'bootstrapped', 'major-blocked'].includes(au.result)
    : evaluated.managed === true)) candidates.push(evaluated.version);
  if (['updated', 'bootstrapped'].includes(au.result)) candidates.push(au.installedVersion, au.latestVersion);
  const highest = candidates
    .filter((value) => STRICT_SEMVER.test(String(value || '')))
    .map(String)
    .reduce((best, value) => (!best || cmpSemver(value, best) > 0 ? value : best), null);
  return highest && cmpSemver(current.version, highest) < 0 ? { version: highest, since: null, predicted: true } : null;
}

// The rules of the updater that spawners actually launch: AUTO_UPDATE_API in
// the INSTALLED <brainDir>/mcp-auto-update.mjs, read as text (MV-2/F1,
// 2026-10-03 review). This doctor's own sibling module is not that file when it
// runs from npx, and after a rollback the installed one is older. 1 = an updater
// from before the marker (≤ 1.89.0); null = no installed updater, or unreadable.
function installedUpdaterApi(brainDir) {
  const text = readText(path.join(brainDir, 'mcp-auto-update.mjs'));
  if (text == null) return null;
  const marker = text.match(/^export const AUTO_UPDATE_API = (\d+);/m);
  if (marker) return Number(marker[1]);
  return /\brunAutoUpdateCheck\b/.test(text) ? 1 : null;
}
// What an api-1 updater (≤ 1.89.0) does: one 24 h stamp, no backoff, no hold.
const LEGACY_UPDATER_TTL_MS = 24 * 60 * 60 * 1000;

function autoUpdateView({ au, brainDir, supervisors, version, hooks, npmLatest, doctorVersion, now }) {
  const live = supervisors?.live || [];
  const recorded = live.filter((state) => typeof state.autoUpdateEnabled === 'boolean');
  const connections = recorded.length
    ? { live: recorded.length, enabled: recorded.filter((state) => state.autoUpdateEnabled).length }
    : null;
  // Live connections are what run the checks; with none, the next host to start
  // decides, and this process's own environment is the best available guess.
  // F4 (2026-10-03 review): the Claude Code SessionStart hook launches the
  // helper with ITS environment. With the opt-out set only in the MCP server
  // entries, brain-project sessions still update; "off … will NOT install" was
  // false there. This doctor's environment stands in for the hooks' one.
  const hooksWired = Array.isArray(hooks?.wired) && hooks.wired.includes('SessionStart');
  const hooksOnly = Boolean(connections) && connections.enabled === 0 && hooksWired && au.enabled !== false;
  const effectiveEnabled = (connections ? connections.enabled > 0 : au.enabled !== false) || hooksOnly;
  // Whose rules: the installed updater's. Same api → this doctor's rules hold;
  // an older (pre-hold) one → 24 h checks and no hold; a newer one → unknown.
  const ownApi = Number(autoUpdateLib.AUTO_UPDATE_API) > 0 ? Number(autoUpdateLib.AUTO_UPDATE_API) : 1;
  const installedApi = installedUpdaterApi(brainDir);
  const rules = installedApi === null || installedApi === ownApi ? 'own' : (installedApi < ownApi ? 'older' : 'newer');
  const cadenceMs = rules === 'own' ? AUTO_UPDATE_TTL_MS : (rules === 'older' && installedApi === 1 ? LEGACY_UPDATER_TTL_MS : null);
  let dueAtMs = timeOf(au.dueAt);
  if (rules === 'older' && installedApi === 1) dueAtMs = Number.isFinite(au.lastCheck) ? au.lastCheck + LEGACY_UPDATER_TTL_MS : now;
  else if (rules !== 'own') dueAtMs = NaN;
  const stampFailures = Number.isInteger(au.failures) && au.failures > 0 ? au.failures : 0;
  // A running check pre-stamps ITSELF as failed (A7); it has not failed yet.
  const settledFailures = au.inProgress ? Math.max(0, stampFailures - 1) : stampFailures;
  const consecutiveFailures = Math.max(settledFailures, au.result === 'failed' ? 1 : 0);
  const checkedMs = timeOf(au.checkedAt);
  const lastCheckMs = Number.isFinite(au.lastCheck) ? au.lastCheck : null;
  // The stamp moved past the status: an attempt was made and recorded nothing
  // (the helper was killed, slept away, or could not write the status).
  const unfinishedAttempt = !au.inProgress && stampFailures > 0 && lastCheckMs !== null
    && (!Number.isFinite(checkedMs) || lastCheckMs > checkedMs + 1000);

  const versionSkew = doctorVersion && version.baked && cmpSemver(doctorVersion, version.baked) !== 0
    ? { doctor: doctorVersion, installed: version.baked } : null;
  // An installed updater whose api matches this doctor's runs these rules,
  // whatever the version numbers; without one, versions are the only hint.
  const skew = rules !== 'own'
    ? { doctor: doctorVersion, installed: version.baked, rules, api: installedApi }
    : (installedApi === null ? versionSkew : null);
  // K2 (2026-10-03): OVERDUE is the updater's own rule (autoUpdateOverdue), the
  // one the SessionStart notice applies too, judged from the live supervisors
  // (dead receipts are already excluded above) and, since K3, from when each
  // last polled the schedule. The doctor adds only what is about itself: a
  // schedule computed by rules other than the installed updater's (a newer
  // `npx klypix-mcp@latest doctor` on an older install) is never judged, and an
  // updater module without the rule judges nothing.
  let rule = { overdue: false, overdueByMs: null, evidence: null, suppressed: null };
  if (effectiveEnabled && typeof autoUpdateLib.autoUpdateOverdue === 'function') {
    try {
      rule = autoUpdateLib.autoUpdateOverdue({
        plan: au,
        supervisors: live.map((state) => ({
          bootedAt: state.bootedAt,
          autoUpdate: { enabled: state.autoUpdateEnabled, lastPollAt: state.lastPollAt },
        })),
        now,
        helperApi: installedApi,
      }) || rule;
    } catch { /* never judged */ }
  }
  const overdueSuppressed = rule.suppressed === 'no-live-session' ? 'no-live-session'
    : (skew && (rule.overdue || rule.suppressed) ? 'version-skew' : (rule.suppressed || null));
  const overdue = rule.overdue === true && !skew;
  // TR-1 (2026-10-03 review): a long-due check the rule did NOT judge for want
  // of a poll (K3) used to print the generic "check due now — runs within
  // 10 min", hiding how long it had been due and repeating a promise an open
  // session had visibly not kept. That is the normal state right after this
  // release: every live connection runs pre-fix supervisor code, which records
  // no poll, until it reconnects. Keep not judging, but carry what is known:
  // how long it has been due, the latest poll on record, and how many sessions
  // record none.
  const pollers = live.filter((state) => state.autoUpdateEnabled !== false);
  const pollTimes = pollers.map((state) => timeOf(state.lastPollAt)).filter((ms) => Number.isFinite(ms) && ms <= now + 1000);
  const latestPollAt = pollTimes.length ? new Date(Math.max(...pollTimes)).toISOString() : null;
  const unpolledSessions = pollers.filter((state) => !Number.isFinite(timeOf(state.lastPollAt))).length;

  const knownLatest = knownNpmLatest(brainDir, au, npmLatest, now);
  // MV-2: a pre-hold updater re-installs whatever the owner rolled back from;
  // decide as it will, and say so, instead of promising a hold it cannot keep.
  const ruleHold = au.hold || predictedHold(au);
  const hold = rules === 'older' ? null : ruleHold;
  const holdIgnored = rules === 'older' && ruleHold ? ruleHold : null;
  const decide = rules === 'newer' ? null
    : (typeof autoUpdateLib.autoUpdateDecision === 'function' ? autoUpdateLib.autoUpdateDecision : null);
  // When no receipt names a version, the helper decides with the version its
  // spawner passed (KLYPIX_MCP_AUTO_UPDATE_CURRENT: the running or baked one),
  // and so does the SessionStart notice. Deciding with the bare receipts said
  // "installs at the next check" for a new major the helper refuses
  // (2026-10-03 integration review).
  const id = au.installedIdentity;
  const decidingAs = id && typeof id === 'object' && !id.unknown && !id.version && version.baked
    ? { ...id, version: version.baked }
    : (id || null);
  const decisionFor = (latest) => {
    if (!latest) return null;
    if (!effectiveEnabled) return 'disabled';
    if (!decide) return 'unknown';
    try { return decide({ installed: decidingAs, latestVersion: latest, hold }); }
    catch { return 'unknown'; }
  };
  const installedVersion = au.installedIdentity?.version || version.baked || null;
  const knownDecision = decisionFor(knownLatest?.version);
  const knownNewer = Boolean(knownLatest && installedVersion && cmpSemver(knownLatest.version, installedVersion) > 0);
  return {
    effectiveEnabled,
    hooksOnly,
    hooksWired,
    connections,
    // The installed updater's rules (MV-2/F1): 'own' | 'older' | 'newer'.
    updaterRules: rules,
    updaterApi: installedApi,
    cadenceMs,
    pollMs: AUTO_UPDATE_POLL_MS,
    // When the installed updater checks next, by its own rules.
    dueAt: Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : null,
    consecutiveFailures,
    unfinishedAttempt,
    overdue,
    overdueByMs: overdue ? rule.overdueByMs : null,
    overdueSuppressed,
    // How long the check has been due by the rule's own reckoning (null when
    // it was due since before any record), and the polls behind a suppression.
    dueForMs: Number.isFinite(rule.dueForMs) ? rule.dueForMs : null,
    latestPollAt,
    unpolledSessions,
    // What the overdue rule saw: the live sessions that polled after the check
    // fell due, and the latest such poll (K3).
    overdueEvidence: overdue ? rule.evidence || null : null,
    scheduleSkew: skew,
    knownLatest,
    knownDecision,
    knownNewer,
    // Paused for a reason other than "off": a newer release this install will not take.
    blocked: knownNewer && ['dev-owned', 'major-blocked', 'held', 'unknown'].includes(knownDecision),
    predictedHold: au.hold ? null : (ruleHold || null),
    // A hold the installed (pre-hold) updater will not keep: it re-installs it.
    holdIgnored,
    // What the updater would do with the version `--npm` just fetched.
    npmDecision: STRICT_SEMVER.test(String(npmLatest || '')) ? decisionFor(String(npmLatest)) : null,
  };
}

// Channel-aware liveness, mirroring agent-presence.mjs: an mcp-channel heartbeat
// is dead after 3 minutes even though the flat 10-minute window keeps the row —
// without this the hook, brain_sync, and doctor reported three different counts.
// (Both windows are now imported from agent-presence at the top of this file.)
const sessionLiveness = (s, now) => {
  // Dead-host parity: a row every WRITER would sweep on its next lane touch
  // must not render as live here. Guarded — an old bundle simply skips it.
  if (typeof presenceLib?.isDeadHostRow === 'function' && presenceLib.isDeadHostRow(s, now)) return null;
  const channelSeen = (s?.channelSeen && typeof s.channelSeen === 'object' && !Array.isArray(s.channelSeen)) ? s.channelSeen : null;
  if (channelSeen && Object.keys(channelSeen).length) {
    const fresh = Object.entries(channelSeen)
      .filter(([ch, seen]) => ch && now - Number(seen || 0) < (ch === 'mcp' ? MCP_SESSION_FRESH_MS : SESSION_FRESH_MS));
    if (!fresh.length) return null;
    return { lastSeen: Math.max(...fresh.map(([, seen]) => Number(seen))), channels: fresh.map(([ch]) => ch) };
  }
  const lastSeen = Number(s?.lastSeen || 0);
  return now - lastSeen < SESSION_FRESH_MS ? { lastSeen, channels: Array.isArray(s?.channels) ? s.channels : [] } : null;
};

function inspectPeers(brainDir, brainPath, now, selfId = null) {
  const file = path.join(brainDir, 'sessions', `${sha(normBrainPath(brainPath))}.json`);
  const data = readJson(file, null);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const rawRecent = sessions.filter(s => s && now - (s.lastSeen || 0) < SESSION_FRESH_MS).length;
  const liveRows = sessions
    .map(s => ({ s, liveness: sessionLiveness(s, now) }))
    .filter(({ liveness }) => liveness)
    .map(({ s, liveness }) => ({
      rawId: String(s.id || ''),
      // 'unknown' stays 'unknown' — the old 'claude-code' fallback silently
      // relabeled client-less rows, masking the writer that forgot to stamp.
      client: s.client || 'unknown',
      surface: s.surface || null,
      model: s.model || null,
      branch: s.branch || null,
      intent: s.intent || '',
      intentAgeMin: s.intentAt ? Math.round((now - Number(s.intentAt)) / 60000) : null,
      files: Array.isArray(s.files) ? s.files : [],
      channels: liveness.channels,
      hostPid: s.hostPid || null,
      logicalSessionId: s.logicalSessionId ? String(s.logicalSessionId) : null,
      identitySource: s.identitySource || null,
      // Sync-rich vs sync-silent: has this session declared any task scope?
      synced: Boolean(String(s.intent || '').trim() || (Array.isArray(s.files) && s.files.length)),
      // Transport liveness is not task activity. Only real prompt/tool work
      // stamps activityAt; heartbeats deliberately preserve rather than refresh it.
      activityAt: Number(s.activityAt || 0) || null,
      activityKind: s.activityKind || null,
      activeUnscoped: !Boolean(String(s.intent || '').trim() || (Array.isArray(s.files) && s.files.length))
        && Number(s.activityAt || 0) > 0
        && now - Number(s.activityAt) < SESSION_FRESH_MS,
      lastSeenMin: Math.round((now - liveness.lastSeen) / 60000),
      // Mailbox (1.88.0): host activity as the shared word every surface uses.
      hostStatus: s.hostStatus || null,
      statusLabel: typeof presenceLib?.sessionStatusLabel === 'function' ? presenceLib.sessionStatusLabel(s, now) : '',
    }));
  // Display IDs must stay usable when time-ordered UUIDs share a long prefix.
  // Eight characters is only the floor: grow each prefix until it is unique.
  const ids = liveRows.map((row) => row.rawId);
  const displayId = new Map(ids.map((id) => {
    const lower = id.toLowerCase();
    let width = Math.min(8, id.length);
    while (width < id.length && ids.some((other) => other !== id
      && other.toLowerCase().startsWith(lower.slice(0, width)))) width++;
    return [id, id.slice(0, width)];
  }));
  const live = liveRows.map((row) => ({ ...row, id: displayId.get(row.rawId) || row.rawId }));

  // hostPid is process topology, NOT session identity. Codex Desktop gives many
  // independent conversations the same parent pid, so pid grouping hid real
  // overlaps and produced a false "one session counted Nx" diagnosis. Only an
  // explicit logicalSessionId may deduplicate rows. Rows without one remain
  // distinct (fail open); lifecycle rows are already authoritative identities.
  const logicalKey = (row) => row.logicalSessionId || row.rawId;
  const logicalGroups = new Map();
  for (const row of live) {
    const key = logicalKey(row);
    logicalGroups.set(key, [...(logicalGroups.get(key) || []), row]);
  }
  const identityMergeGaps = [...logicalGroups.entries()]
    .filter(([key, rows]) => rows.length > 1 && rows.some((row) => row.logicalSessionId === key))
    .map(([logicalSessionId, rows]) => ({
      logicalSessionId,
      ids: rows.map((row) => row.id),
    }));
  const connectionScopedCount = live.filter((row) => !row.logicalSessionId
    && !row.channels.includes('lifecycle')).length;
  const activeCodexConnectionScopedCount = live.filter((row) => row.client === 'codex'
    && !row.logicalSessionId
    && !row.channels.includes('lifecycle')
    && (row.synced || row.activeUnscoped)).length;
  const receipts = selfId
    ? summarizeReceipts({
      messages: Array.isArray(data?.messages) ? data.messages : [],
      sessions,
      selfId,
      now,
    })
    : { sent: 0, receipts: [] };
  // Readiness is a logical-session verdict, so its numerator must use the same
  // denominator as logicalSessionCount. A lifecycle + MCP pair for one exact
  // thread is two observable connections, but never two scoped sessions.
  const logicalStates = [...logicalGroups.values()].map((rows) => {
    const synced = rows.some((row) => row.synced);
    return {
      synced,
      activeUnscoped: !synced && rows.some((row) => row.activeUnscoped),
    };
  });
  const syncedCount = logicalStates.filter((state) => state.synced).length;
  const activeUnscopedCount = logicalStates.filter((state) => state.activeUnscoped).length;
  // Mailbox (1.88.0): the sessions the lane REMEMBERS but that are not running
  // (two-week directory) and the notes queued for them — the doors with mail.
  // Read straight off the lane so a bundle whose engine predates the directory
  // simply reports none.
  const directoryFreshMs = Number(presenceLib?.DIRECTORY_FRESH_MS) > 0
    ? Number(presenceLib.DIRECTORY_FRESH_MS) : 14 * 24 * 60 * 60 * 1000;
  const liveKeys = new Set(liveRows.flatMap((row) => [row.rawId, row.logicalSessionId]
    .filter(Boolean).map((value) => String(value).toLowerCase())));
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  // THIS note's own state for THIS recipient — never "some pending note to it".
  const notePendingFor = (m, id) => m && !m.deadLetter && !m.retiredAt
    && Array.isArray(m.candidateIds) && m.candidateIds.map(String).includes(id)
    && !(Array.isArray(m.deliveries) && m.deliveries.some((d) => String(d?.recipientId || d?.id) === id
      && d?.state && d.state !== 'pending'));
  const pendingNotesFor = (id) => messages.filter((m) => notePendingFor(m, id)).length;
  const directoryRows = (Array.isArray(data?.directory) ? data.directory : [])
    .filter((e) => e && e.id && now - Number(e.lastSeen || 0) < directoryFreshMs);
  // Shown ids must be valid message targets: grow each prefix (floor 8) until
  // it names ONE session across the directory and the live lane — two UUIDv7
  // threads opened in the same minute share far more than 8 characters.
  const allIds = [...new Set([...directoryRows.map((e) => String(e.id)), ...liveRows.map((row) => row.rawId)])];
  const uniquePrefix = (id) => {
    const lower = id.toLowerCase();
    let width = Math.min(8, id.length);
    while (width < id.length && allIds.some((other) => other !== id
      && other.toLowerCase().startsWith(lower.slice(0, width)))) width++;
    return id.slice(0, width);
  };
  const known = directoryRows
    .filter((e) => !liveKeys.has(String(e.id).toLowerCase()))
    .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))
    .map((e) => ({
      id: String(e.id),
      shortId: uniquePrefix(String(e.id)),
      client: e.client || 'unknown',
      intent: String(e.intent || '').slice(0, 80),
      branch: e.branch || null,
      lastSeenMin: Math.round((now - Number(e.lastSeen || 0)) / 60000),
      endedAt: Number(e.endedAt || 0) || null,
      waitingNotes: pendingNotesFor(String(e.id)),
      resumeCommand: typeof presenceLib?.resumeCommandFor === 'function' ? presenceLib.resumeCommandFor(e.client, e.id) : '',
    }));
  // A note counts as "waiting for a session not on the lane" only while THIS
  // note is still pending for its target AND that target is not live now (a
  // live target gets it at its next action — that is ordinary delivery).
  const waitingOffline = messages
    .filter((m) => m && m.offline
      && Array.isArray(m.candidateIds) && m.candidateIds.length === 1
      && notePendingFor(m, String(m.candidateIds[0]))
      && !liveKeys.has(String(m.candidateIds[0]).toLowerCase()))
    .map((m) => ({
      id: String(m.id),
      from: String(m.from || '').slice(0, 8),
      to: uniquePrefix(String(m.candidateIds[0])),
      client: m.offline?.target?.client || 'unknown',
      ageMin: Math.round((now - Number(m.ts || 0)) / 60000),
    }));
  return {
    file,
    live,
    known,
    knownCount: known.length,
    waitingOffline,
    // `count` remains the user-facing active-session count. The additive
    // connectionCount/laneRowCount fields keep transport topology inspectable.
    count: logicalGroups.size,
    logicalSessionCount: logicalGroups.size,
    connectionCount: live.length,
    laneRowCount: live.length,
    connectionScopedCount,
    activeCodexConnectionScopedCount,
    exactIdentityCount: Math.max(0, logicalGroups.size - connectionScopedCount),
    rawRecent,
    syncedCount,
    activeUnscopedCount,
    idleUnscopedCount: Math.max(0, logicalGroups.size - syncedCount - activeUnscopedCount),
    identityMergeGaps,
    // Compatibility field for older programmatic consumers. A host-pid repeat
    // is deliberately never classified as a twin again.
    twinGroups: [],
    receipts,
  };
}

// ── DECAY-GUARD layer (fast-decay status protection, 2026-07-28) ─────────────
// The brain is MEMORY, not a SENSOR: completed-status claims near release nouns
// ("uploaded", "LIVE", "installed", TestFlight/build N/npm/rollout) decay in
// hours, and a bundle that renders them as current state reproduces the stale-
// "what is remaining" incident class. This layer proves the protection is
// PRESENT, end-to-end: (a) the loaded engine exports classifyDecay; (b) its
// status renderer actually stamps a synthetic 20h-old stale claim as ⏱️ LAST
// KNOWN (behavior, not just an export string); (c) the DEPLOYED bundle files
// carry the feature. A bundle that predates the feature reads as DRIFT —
// silently lacking protection is exactly the failure mode — while an
// unloadable engine reads as a reportable fact, never a doctor crash.
export function inspectDecayGuard(brainDir, lib, now = Date.now()) {
  const libLoaded = !!lib;
  const exported = !!(lib && typeof lib.classifyDecay === 'function');
  let rendererStamps = null;   // null = not testable (no lib / no renderer export)
  if (exported && typeof lib.statusContextToMarkdown === 'function') {
    try {
      // Minimal parseKlypix-shaped struct: one 20h-old fast-decay milestone.
      const struct = {
        title: 'decay-probe', format: 'probe', counts: { cards: 1, connections: 0 },
        cards: [{
          id: 'decay-probe-1', type: 'text', title: '', links: [], tags: [],
          text: 'Release: 🏁 build 26 uploaded to TestFlight — rollout LIVE',
          area: 'Release', createdAt: now - 20 * 3_600_000, parentId: null, evidence: null,
        }],
        connections: [],
      };
      const md = String(lib.statusContextToMarkdown(struct, { budgetChars: 4200, now }) || '');
      rendererStamps = /⏱/.test(md) && /LAST KNOWN/i.test(md);
    } catch { rendererStamps = false; }   // a throwing renderer is NOT protecting anything
  }
  // Deployed-bundle currency (inspectVersion/inspectTools idiom: read the
  // DEPLOYED file text — the running package can be newer than the machine's
  // bundle). Absent files are a fact (null), never drift on their own.
  const deployedFmt = readText(path.join(brainDir, 'klypix-format.mjs'));
  const deployedHook = readText(path.join(brainDir, 'global-brain-hook.mjs'));
  return {
    libLoaded, exported, rendererStamps,
    deployedFmtCurrent: deployedFmt == null ? null : /export (?:function|const) classifyDecay\b/.test(deployedFmt),
    deployedHookCurrent: deployedHook == null ? null : deployedHook.includes('classifyDecay'),
  };
}

// ── MERGE ENGINE layer (Stage 2, brain 1.89) ─────────────────────────────────
// Brain Sync, the git driver, history restore and arrange rely on the
// receipt-aware engine (merge-brains.mjs, MERGE_ENGINE_FEATURES.api ≥ 2) and on
// a driver that asks for it (DRIVER_OPTIONS_API ≥ 2). Installs mix file
// generations — a desktop bundle beside a dev-owned ~/.claude, an older
// `git-driver install` — and an api-1 file under a 1.89 brain runs pre-1.89 rules:
// a card deleted here comes back from a copy that still has it. Read the
// DEPLOYED text, no import (the doctor stays synchronous and must diagnose a
// broken bundle). A file without the marker is api 1; a marker that does not
// parse is unknown, never a guess.
const MERGE_ENGINE_SINCE = '1.89.0';
export function inspectMergeEngine(brainDir) {
  const scan = (file, marker, re) => {
    const src = readText(path.join(brainDir, file));
    if (src == null) return { present: false, api: null };
    if (!src.includes(marker)) return { present: true, api: 1 };
    const m = src.match(re);
    return { present: true, api: m ? Number(m[1]) : null };
  };
  return {
    engine: scan('merge-brains.mjs', 'MERGE_ENGINE_FEATURES', /MERGE_ENGINE_FEATURES\s*=\s*Object\.freeze\(\{[^}]*?\bapi:\s*(\d+)/),
    driver: scan('klypix-merge-driver.mjs', 'DRIVER_OPTIONS_API', /\bDRIVER_OPTIONS_API\s*=\s*(\d+)/),
  };
}
// ok | drift (an api-1 file under a ≥ 1.89 brain) | absent (no engine file) |
// unknown (a marker that does not parse) | n/a (brain older than 1.89, or no
// baked version to compare).
function mergeEngineLayer(mergeEngine, baked) {
  if (!baked || cmpSemver(baked, MERGE_ENGINE_SINCE) < 0) return 'n/a';
  const { engine, driver } = mergeEngine;
  const low = (x) => x.present && x.api != null && x.api < 2;
  if (low(engine) || low(driver)) return 'drift';
  if (!engine.present) return 'absent';
  if (engine.api == null || (driver.present && driver.api == null)) return 'unknown';
  return 'ok';
}

/**
 * Inspect this machine's brain (+ a project's harness projection) as one report.
 * @param {{ projectDir?: string, home?: string, now?: number, npmLatest?: string|null }} [opts]
 */
export function inspect(opts = {}) {
  const home = opts.home || os.homedir();
  const projectDir = opts.projectDir || process.cwd();
  const now = opts.now || Date.now();
  const brainDir = path.join(home, '.claude', 'project-brain');
  const klypixBrain = path.join(projectDir, 'brain.klypix');
  const anyBrain = path.join(projectDir, 'brain.any');
  const brainPath = fs.existsSync(klypixBrain) ? klypixBrain : anyBrain;
  const hasBrain = fs.existsSync(brainPath);

  const version = inspectVersion(brainDir);
  const running = inspectRunning(brainDir, version.baked, now, opts.self);
  const supervisors = inspectSupervisors(brainDir, version.baked, now);
  // C3: once supervisors really hibernate, an idle machine has no worker
  // heartbeat at all — that is the healthy state, not an unknown one.
  if (!running.known && supervisors.live.length && supervisors.live.every((state) => state.status === 'hibernated')) {
    running.allHibernated = supervisors.live.length;
  }
  // opts.doctorVersion is a test seam (pin which doctor is talking).
  const doctorVersion = opts.doctorVersion !== undefined ? opts.doctorVersion : DOCTOR_VERSION;
  const doctor = {
    version: doctorVersion || null,
    olderThanInstalled: Boolean(doctorVersion && version.baked && cmpSemver(doctorVersion, version.baked) < 0),
    newerThanInstalled: Boolean(doctorVersion && version.baked && cmpSemver(doctorVersion, version.baked) > 0),
  };
  let auBase = null;
  try {
    if (typeof autoUpdateLib.inspectAutoUpdate === 'function') {
      // currentVersion: the version a spawner hands the helper, so the updater's
      // own `decision` field decides a receipt-less runtime as the helper will.
      auBase = autoUpdateLib.inspectAutoUpdate(brainDir, { now, env: opts.env || process.env, currentVersion: version.baked });
    }
  } catch { auBase = null; }
  if (!auBase || typeof auBase !== 'object') {
    auBase = {
      enabled: true, lastCheck: null, lastCheckAt: null, due: false, dueAt: null, result: null,
      scheduleError: 'auto-update module unavailable', moduleUnavailable: true,
    };
  }
  const hooks = inspectHooks(home);
  const autoUpdate = {
    ...auBase,
    ...autoUpdateView({
      au: auBase, brainDir, supervisors, version, hooks, now, doctorVersion,
      npmLatest: opts.npmLatest && !String(opts.npmLatest).startsWith('(') ? opts.npmLatest : null,
    }),
  };
  const engineCode = inspectEngineCode(brainDir);
  const codexHooks = codexPresenceHookStatus(home);
  const codexSmart = {
    mcpInstructions: true,
    globalInstructions: codexGlobalInstructionsInstalled(home),
  };
  // Commit-capture git hook (2026-08-07): informational, never a drift layer —
  // SessionStart auto-installs it where safe; doctor reports the cases it can't
  // (foreign hook in the slot, core.hooksPath set, brain nested below the repo
  // top). Guarded dynamic import: on a half-updated bundle that lacks the
  // module, doctor must keep working, not crash at load (review-caught).
  let gitCapture = { state: 'n/a', hooks: {} };
  if (hasBrain && gitCaptureLib && typeof gitCaptureLib.gitCaptureHookStatus === 'function') {
    try { gitCapture = gitCaptureLib.gitCaptureHookStatus(projectDir, { home }); } catch { gitCapture = { state: 'error', hooks: {} }; }
  }
  // Restore points (2026-08-07). Informational: their absence on a brand-new
  // brain is normal, and a missing history must never read as machine drift.
  let history = { available: false, count: 0, newestAt: null };
  if (hasBrain && historyLib && typeof historyLib.listBrainHistory === 'function') {
    try {
      const points = historyLib.listBrainHistory(brainPath, { home });
      history = { available: true, count: points.length, newestAt: points[0]?.ts || null };
    } catch { history = { available: true, count: 0, newestAt: null }; }
  }
  // Judgment provenance (2026-09-29). Informational only: a brain with zero
  // recorded verdicts is NEW, not drifted (same doctrine as history above).
  let provenance = null;
  if (hasBrain && provenanceLib && typeof provenanceLib.provenanceCounts === 'function') {
    try { provenance = { available: true, ...provenanceLib.provenanceCounts(brainPath, { home }) }; }
    catch { provenance = null; }
  }
  const tools = inspectTools(brainDir, PKG_ROOT);
  // ── CHECKOUT (release-state visibility, 2026-08-14 incident) ──────────────
  // Advisory, never a verdict layer: when the PROJECT itself is a versioned
  // source checkout, report mechanically whether HEAD carries its own release
  // tag — the 1.3.107 release shipped from an off-trunk branch because no
  // surface made branch/release state visible at the moment of action, and
  // doctor is the one client-neutral surface every agent can query. Only set
  // when a git identity AND a package version exist (release state is
  // meaningless without a version to be released); any probe failure omits
  // the block. collectRepoState is bounded + 60s-cached, so this adds no
  // meaningful cost to a doctor run.
  let checkout = null;
  if (repoStateLib && typeof repoStateLib.collectRepoState === 'function') {
    try {
      const state = repoStateLib.collectRepoState(projectDir);
      if (state && state.packageVersion) {
        checkout = {
          branch: state.branch,
          headShort: state.headShort,
          version: state.packageVersion,
          tagsAtHead: state.tagsAtHead,
          releaseState: state.isReleaseTag ? 'released-tag' : 'untagged-working-tree',
        };
      }
    } catch { checkout = null; }
  }
  const env = opts.env || process.env;
  // MCP passes the adopted live id explicitly. The CLI can inherit a host id,
  // but never invents one: a guessed sender would display somebody else's note.
  const receiptSessionId = opts.selfId || opts.self?.id || [
    'KLYPIX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID', 'CURSOR_SESSION_ID', 'CLINE_SESSION_ID', 'WINDSURF_SESSION_ID',
  ].map((key) => env?.[key]).find((value) => String(value || '').trim()) || null;
  const peers = inspectPeers(brainDir, brainPath, now, receiptSessionId);
  // opts.fmtLib is a test seam (stub engines); production uses the module lib.
  const decayGuard = inspectDecayGuard(brainDir, opts.fmtLib !== undefined ? opts.fmtLib : fmtLib, now);
  const mergeEngine = inspectMergeEngine(brainDir);

  // Harness drift only counts toward the verdict for a real brain project; auditProject
  // against the BAKED brain version (the deployed truth) when available.
  const harnessVer = version.baked || resolveVersion();
  // Audit ONLY what a host on this machine would read — the same detected-editor set
  // `install` projects with (setup.mjs). Field finding 2026-09-01 (install-smoke on a
  // clean ubuntu + macos runner): install wrote 3 files for the 2 hosts present, then
  // doctor audited all 14 and reported "11 of 14 drifted — MISSING" for Cursor,
  // Windsurf, Cline, Copilot, Gemini and Aider config nobody had installed, exiting 1
  // on a brand-new user's very first command. Write and audit must share one filter.
  // Files a teammate already committed stay audited regardless (targetJustified rule 3).
  // opts.editors is a test seam: a Set/array to pin, or null to force the unfiltered audit.
  const harnessEditors = opts.editors !== undefined ? opts.editors
    : detectEditors({ env }).present.keys();
  const harness = hasBrain ? auditProject(projectDir, { version: harnessVer, editors: harnessEditors }) : { files: [], drift: [], ok: true, version: harnessVer, skipped: [] };

  // npm currency (caller fetches it; we just compare to the baked truth).
  // Three honest states, not two (G4/G5/G6, 2026-08-14): `matches` collapsed
  // installed>registry into "current" (cmp <= 0), so a machine running an
  // UNRELEASED build rendered "✓ current" — the exact opposite of the truth a
  // release gate needs. `relation` is the additive truthful field:
  //   'ahead'   — installed > registry (running unreleased code; a warning)
  //   'current' — installed == registry
  //   'stale'   — installed < registry (behind; the existing drift path)
  // `matches` keeps its historical boolean semantics for downstream parsers.
  const npm = (opts.npmLatest && !String(opts.npmLatest).startsWith('('))
    ? (() => {
      const cmp = version.baked ? cmpSemver(opts.npmLatest, version.baked) : null;
      return {
        latest: opts.npmLatest,
        matches: cmp == null ? null : cmp <= 0,
        relation: cmp == null ? null : (cmp > 0 ? 'stale' : cmp < 0 ? 'ahead' : 'current'),
      };
    })()
    : (opts.npmLatest ? { latest: opts.npmLatest, matches: null, relation: null } : null);

  // ── verdict ──────────────────────────────────────────────────────────────
  const layers = {
    version: version.installed ? ((version.dirty || (npm && npm.matches === false)) ? 'drift' : 'ok') : 'absent',
    // RUNNING drifts when the live server's version ≠ the installed bundle — the
    // stale-server incident. Unknown (server not booted since the heartbeat shipped)
    // is NOT drift; it's a reconnect prompt.
    running: !running.known ? 'unknown' : (running.matchesInstalled === false ? 'drift' : 'ok'),
    // A recovery-failed / worker-less supervisor is an OUTAGE (queued tool calls
    // hang), not health — pid-alive alone must never render it ok. A stale
    // active-worker version is the same class of drift RUNNING reports.
    supervisor: supervisors.active
      ? (supervisors.impaired.length || supervisors.live.some(state => state.degraded)
        ? 'drift'
        : (supervisors.matchesInstalled === false ? 'drift' : 'ok'))
      : (version.supervisorCapable ? 'pending-reconnect' : 'legacy'),
    // 'warning' marks anything the updater cannot do on its own right now; it
    // never flips the verdict by itself (overdue and repeated failures add a
    // readiness warning below, i.e. PARTIAL, never DRIFTED).
    autoUpdate: !autoUpdate.effectiveEnabled
      ? 'off'
      : (autoUpdate.overdue || autoUpdate.consecutiveFailures > 0 || autoUpdate.blocked || autoUpdate.scheduleError
        || autoUpdate.holdIgnored || Number(autoUpdate.harness?.failed || 0) > 0 ? 'warning' : 'ok'),
    // Unreceipted modules are a readiness gap (code no installer vouches for),
    // not drift: nothing about the receipted runtime is wrong.
    engineCode: !engineCode.checked ? 'n/a' : (engineCode.unreceipted.length ? 'warning' : 'ok'),
    // Grace for the 1.81 hook addition (adversarial review 2026-08-24): a
    // machine whose only missing event is the NEW PreToolUse guard lane is a
    // valid pre-guard install, not a drifted one — hard-failing every existing
    // machine the day the event ships teaches people to ignore the doctor.
    // Any OTHER missing event still reads as drift.
    hooks: !hooks.settingsPresent ? 'absent'
      : (hooks.missing.some((e) => e !== 'PreToolUse') ? 'drift'
        : (hooks.missing.length ? 'warning' : 'ok')),
    // Codex MCP presence is the automatic baseline. Hooks are an OPTIONAL
    // enrichment layer, so off/unverified must never make the brain "drifted".
    codexHooks: codexHooks.error
      ? 'warning'
      : (!codexHooks.installed
        ? 'optional'
        : (codexHooks.executionStatus === 'observed' ? 'ok' : 'warning')),
    // Informational only — a repo the auto-installer can't wire (foreign hook,
    // custom hooksPath) must never flip the machine verdict to DRIFTED.
    gitCapture: gitCapture.state === 'installed' ? 'ok' : (gitCapture.state === 'n/a' ? 'n/a' : 'optional'),
    harness: hasBrain ? (harness.ok ? 'ok' : 'drift') : 'n/a',
    // DECAY-GUARD drifts when the protection is provably missing: the loaded
    // engine lacks classifyDecay, its renderer left the synthetic stale claim
    // unstamped, or a deployed bundle file predates the feature. An unloadable
    // engine is 'unknown' (a reportable fact, not a verdict flip).
    decayGuard: !decayGuard.libLoaded ? 'unknown'
      : (!decayGuard.exported || decayGuard.rendererStamps === false
        || decayGuard.deployedFmtCurrent === false || decayGuard.deployedHookCurrent === false) ? 'drift' : 'ok',
    // MERGE drifts only on an engine or driver provably OLDER than the brain;
    // a missing or unreadable file is a fact to show, not a verdict flip.
    mergeEngine: mergeEngineLayer(mergeEngine, version.baked),
  };
  const drifted = Object.values(layers).filter(s => s === 'drift').length;
  // A live session that has not declared task scope cannot contribute overlap
  // coordination. That is a readiness gap, not file/runtime drift: say PARTIAL
  // instead of the misleading all-clear that prompted the field audit.
  const readinessWarnings = [];
  const activeSilentSessions = peers.activeUnscopedCount || 0;
  if (peers.count > 1 && activeSilentSessions > 0) {
    readinessWarnings.push(`${activeSilentSessions} active session${activeSilentSessions === 1 ? '' : 's'} used KLYPIX without declared task scope (${peers.logicalSessionCount} logical sessions total)`);
  }
  if (peers.activeCodexConnectionScopedCount > 0) {
    readinessWarnings.push(`${peers.activeCodexConnectionScopedCount} active Codex connection${peers.activeCodexConnectionScopedCount === 1 ? '' : 's'} lack exact request-derived session identity`);
  }
  if (peers.identityMergeGaps?.length) {
    readinessWarnings.push(`${peers.identityMergeGaps.length} explicit logical session${peers.identityMergeGaps.length === 1 ? '' : 's'} remain split across connection rows`);
  }
  if (Number(autoUpdate.harness?.failed || 0) > 0) {
    readinessWarnings.push(`${autoUpdate.harness.failed} automatic harness repair(s) remain partial`);
  }
  if (autoUpdate.overdue) {
    readinessWarnings.push(`automatic update check overdue by ${durationText(autoUpdate.overdueByMs)} — no running session performed it`);
  }
  if (autoUpdate.effectiveEnabled && autoUpdate.holdIgnored) {
    readinessWarnings.push(`the downgrade to v${autoUpdate.installedIdentity?.version || version.baked} is not held: the installed v${version.baked} updater predates the hold and re-installs v${autoUpdate.holdIgnored.version} at its next check`);
  }
  // One failure is a retry 15 min away; two in a row is a pattern. Failures
  // recorded against a previous install (stale) say nothing about this one.
  if (autoUpdate.effectiveEnabled && !autoUpdate.stale && autoUpdate.consecutiveFailures >= 2) {
    readinessWarnings.push(`automatic update check failed ${autoUpdate.consecutiveFailures} times in a row${autoUpdate.error ? ` (last: ${autoUpdate.error})` : ''}`);
  }
  if (engineCode.unreceipted.length) {
    const n = engineCode.unreceipted.length;
    // The merge-driver risk is named only for the driver's own code (F7): it is
    // the one thing that runs these files without any installer involved.
    const driver = engineCode.mergeDriverFiles.length
      ? `; the KLYPIX git merge driver runs ${engineCode.mergeDriverFiles.join(', ')} on every brain merge`
      : '';
    readinessWarnings.push(`${n} unreceipted engine file${n === 1 ? '' : 's'} in the managed directory (${engineCode.unreceipted.join(', ')}) — no installer vouches for ${n === 1 ? 'it' : 'them'}${driver}`);
  }
  const verdict = !version.installed
    ? 'NOT-INSTALLED'
    : (drifted ? 'DRIFTED' : (readinessWarnings.length ? 'PARTIAL' : 'ALIGNED'));

  // ── one reconciliation block ──────────────────────────────────────────────
  const actions = [];
  if (!version.installed) actions.push('npx klypix-mcp install   # no brain installed on this machine');
  else {
    // The old remediation here named scripts/deploy-brain.mjs — a script that
    // does not exist in the published package, so the one string every client
    // renders verbatim was unrunnable. Point at commands that actually run.
    if (version.dirty) actions.push('npx klypix-mcp install --force   # running uncommitted (dirty) source code — restore the released npm version, or commit and re-deploy deliberately with --allow-untagged');
    if (npm && npm.relation === 'stale') {
      // Behind npm stays DRIFTED (the founder's "verify ALIGNED" rule reads it),
      // but when the updater WILL take this release on its own, say so and when.
      // Only for a schedule computed by the installed updater's own rules.
      let wait = '';
      if (autoUpdate.effectiveEnabled && !autoUpdate.overdue && !autoUpdate.scheduleSkew && autoUpdate.npmDecision === 'install') {
        const dueMs = timeOf(autoUpdate.dueAt);
        if (autoUpdate.inProgress) wait = ' — or wait: an automatic update check is running now';
        else if (Number.isFinite(dueMs)) {
          wait = ` — or wait: auto-update installs it at the next check (due ${dueMs <= now ? 'now' : `${isoMinute(dueMs)}, in ${durationText(dueMs - now)}`})`;
        }
      }
      actions.push(`npx klypix-mcp install   # installed brain v${version.baked} < npm latest v${npm.latest}${wait}`);
    }
    if (npm && npm.relation === 'ahead') actions.push(`publish the release (or \`npx klypix-mcp install\` to restore the released version)   # installed brain v${version.baked} > npm latest v${npm.latest} — this machine runs an UNRELEASED build`);
    if (running.matchesInstalled === false) actions.push(`/mcp reconnect (or restart the session)   # LIVE server v${running.version} ≠ installed v${version.baked} — the running MCP server is stale`);
    if (version.supervisorCapable && running.known && !supervisors.active) actions.push('/mcp reconnect once   # activate the zero-restart supervisor; compatible future core updates hot-swap automatically');
    if (hooks.missing.length) actions.push(`npx klypix-mcp install   # half-wired: hooks not active — ${hooks.missing.join(', ')}`);
    if (hasBrain && !harness.ok) actions.push('automatic harness repair pending   # retried at the next brain_sync/update check; no manual link command required');
    if (layers.decayGuard === 'drift') actions.push('npx klypix-mcp install   # decay-aware status guard missing/stale — stale build/deploy claims can render as CURRENT state');
    if (layers.mergeEngine === 'drift') {
      const old = [mergeEngine.engine.api < 2 && 'merge-brains.mjs', mergeEngine.driver.api < 2 && 'klypix-merge-driver.mjs'].filter(Boolean).join(' + ');
      actions.push(`${version.dev ? 'npx klypix-mcp install --force (or re-deploy from the checkout that owns this dev install)' : 'npx klypix-mcp install'}   # ${old} predates brain v${version.baked} — restores, Arrange and the git driver run pre-1.89 rules, so a deleted card can come back from another copy`);
    }
    for (const s of supervisors.impaired || []) {
      if (s.status === 'restart-required') {
        // A deterministic rejection while idle (new major / breaking tools): the
        // supervisor answers every request at once with a retryable error.
        actions.push(`/mcp reconnect   # supervisor pid ${s.pid} restart-required: ${s.lastError || 'KLYPIX core changed incompatibly while idle'}`);
        continue;
      }
      if (s.wakeBlocked) {
        // F6: a reconnect meets the same files; only a reinstall repairs them.
        actions.push(`npx -y klypix-mcp@latest install --force   # supervisor pid ${s.pid} cannot wake: the core files do not verify (${s.wakeDeferred?.reason || s.lastError || 'runtime integrity'}) — its requests fail until they do`);
        continue;
      }
      const why = s.workerImpaired ? 'has no live worker; tool calls cannot complete' : `cannot confirm host delivery (${s.deliveryStatus})`;
      actions.push(`/mcp reconnect   # supervisor pid ${s.pid} ${why}`);
    }
    for (const s of supervisors.live.filter(state => state.degraded)) {
      actions.push(`/mcp reconnect if backpressure persists   # supervisor pid ${s.pid} has queued host output awaiting drain`);
    }
    for (const s of supervisors.live.filter(state => !state.impaired && !state.degraded && !state.transition)) {
      if (s.status === 'restart-required') {
        actions.push(`/mcp reconnect   # supervisor pid ${s.pid} restart-required: kept v${s.activeVersion || '?'}${s.lastError ? ` — ${s.lastError}` : ''}`);
      } else if (s.alignment === 'reconnect-on-wake') {
        // F5: the wake's own major gate refuses this target.
        actions.push(`/mcp reconnect   # supervisor pid ${s.pid} sleeps on v${s.activeVersion || '?'}; the installed v${s.pendingWakeVersion} is a new major, which its next request would refuse ("KLYPIX core changed incompatibly while idle")`);
      } else if (s.alignment === 'mismatch') {
        actions.push(`/mcp reconnect if it persists   # supervisor pid ${s.pid} serves v${s.effectiveVersion} ≠ installed v${version.baked} (a newer install hot-swaps within seconds; an older one never does)`);
      }
    }
    if (autoUpdate.overdue) {
      actions.push(`/mcp reconnect one KLYPIX session   # the automatic update check is overdue by ${durationText(autoUpdate.overdueByMs)} — a fresh connection starts it 2 s after it opens`);
    }
    if (autoUpdate.moduleUnavailable) {
      actions.push('npx klypix-mcp install   # mcp-auto-update.mjs could not be loaded — automatic updates cannot run until the bundle is repaired');
    }
    if (autoUpdate.effectiveEnabled && autoUpdate.holdIgnored) {
      actions.push(`set KLYPIX_AUTO_UPDATE=0 in each KLYPIX MCP server entry's env and in the environment Claude Code runs its hooks in   # to stay on v${autoUpdate.installedIdentity?.version || version.baked}: the installed v${version.baked} updater predates the downgrade hold and re-installs v${autoUpdate.holdIgnored.version} within 24 h of its last check`);
    }
    if (autoUpdate.effectiveEnabled && !autoUpdate.stale && autoUpdate.consecutiveFailures >= 2
      && autoUpdate.knownNewer && autoUpdate.knownDecision === 'install') {
      actions.push(`npx -y klypix-mcp@latest install --runtime-only   # the automatic update to v${autoUpdate.knownLatest.version} failed ${autoUpdate.consecutiveFailures} times in a row${autoUpdate.error ? ` (${autoUpdate.error})` : ''} — a manual run retries it now`);
    }
    if (engineCode.mergeDriverFiles.length) {
      // F7: never "remove" the driver's own files — merge.klypix.driver runs
      // <brainDir>/klypix-merge-driver.mjs. Installers from 1.89.0 on stage and
      // receipt them, so a reinstall is what makes them vouched-for.
      actions.push(`npx -y klypix-mcp@latest install --force   # re-stages and receipts the git merge driver's own code (${engineCode.mergeDriverFiles.join(', ')}), which runs on every brain merge — removing it would break the configured driver`);
    }
    const strays = engineCode.unreceipted.filter((name) => !engineCode.mergeDriverFiles.includes(name));
    if (strays.length) {
      actions.push(`review, then remove ${strays.join(', ')} from ${brainDir}   # not in the ${engineCode.receiptVersion ? `v${engineCode.receiptVersion} ` : ''}install receipt (left by an older release or added by hand); nothing installed imports it`);
    }
    if (peers.activeCodexConnectionScopedCount > 0) actions.push('/mcp reconnect   # active Codex connection lacks exact request-derived thread identity');
    if (peers.identityMergeGaps?.length) actions.push(`/mcp reconnect   # ${peers.identityMergeGaps.length} explicitly identified logical session(s) remain split across connection rows`);
    if (hasBrain && (gitCapture.state === 'foreign' || Object.values(gitCapture.hooks || {}).some(s => s === 'foreign' || s === 'foreign-sh'))) {
      actions.push('npx klypix-mcp git-hook install   # a pre-existing git hook occupies post-commit/post-merge — this chains the commit-capture block after it (auto-install never edits a foreign hook)');
    } else if (hasBrain && gitCapture.state === 'custom-hookspath') {
      actions.push('git config core.hooksPath is set   # commit-capture hook not auto-installable — add the managed block to that hooks dir or unset the config, then `npx klypix-mcp git-hook install`');
    }
  }

  // `checkout` is additive (schema-stable): downstream renderers keep parsing
  // every existing field; it never feeds layers/verdict/actions by design.
  // `doctor`, `engineCode` and `inspectedAt` are additive too (2026-10-03).
  return { verdict, layers, drifted, readinessWarnings, version, running, supervisors, autoUpdate, hooks, codexSmart, codexHooks, gitCapture, history, provenance, tools, peers, sessions: peers, receipts: peers.receipts, receiptSessionId, harness, npm, decayGuard, mergeEngine, checkout, project: { dir: projectDir, brainPath, hasBrain }, brainDir, actions, doctor, engineCode, inspectedAt: now };
}

// ── Structured result (E1, 2026-10-03) ──────────────────────────────────────
// brain_doctor's MCP result carries this next to its unchanged text, so a host
// or an agent can act on the verdict, the update schedule and each connection's
// state without parsing rendered lines (the AUTO-UPDATE line alone has a dozen
// shapes). A projection, not the whole report: a host may hand a tool's
// structuredContent to the model next to its text, so the harness pass drops its
// per-project list and the supervisor sub-lists are pids into `live` instead of
// copies of it. Field names are the report's own; schemaVersion moves only on a
// breaking change. Total: a surprise yields {schemaVersion, verdict, error}.
const STRUCTURED_PAIR_FIELDS = [
  'pid', 'status', 'impaired', 'workerImpaired', 'deliveryImpaired', 'degraded', 'deliveryStatus', 'transition',
  'activePid', 'activeVersion', 'candidateVersion', 'effectiveVersion', 'wakeVersion', 'pendingWakeVersion',
  'alignment', 'hotReloads', 'lastSwapAt', 'lastError', 'updatedAt', 'supervisorGeneration', 'supervisorVersion',
  'preFix', 'autoUpdateEnabled', 'lastPollAt',
];
const STRUCTURED_HARNESS_FIELDS = ['checked', 'updated', 'unchanged', 'failed', 'skipped', 'skippedReasons', 'checkedAt', 'version', 'error'];
const pickFields = (source, keys) => {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};
export function structuredReport(r) {
  try {
    const au = r?.autoUpdate && typeof r.autoUpdate === 'object' ? r.autoUpdate : {};
    const sup = r?.supervisors && typeof r.supervisors === 'object' ? r.supervisors : {};
    const pids = (list) => (Array.isArray(list) ? list.map((state) => state?.pid ?? null) : []);
    return {
      schemaVersion: 1,
      verdict: r?.verdict ?? null,
      layers: { ...(r?.layers || {}) },
      version: {
        ...pickFields(r?.version, ['installed', 'baked', 'channel', 'stampVersion', 'dev', 'dirty', 'sourceSha', 'installedAt', 'supervisorCapable']),
        running: r?.running ? pickFields(r.running, ['known', 'self', 'version', 'matchesInstalled']) : null,
        npm: r?.npm ? pickFields(r.npm, ['latest', 'relation']) : null,
        doctor: r?.doctor ? pickFields(r.doctor, ['version', 'olderThanInstalled', 'newerThanInstalled']) : null,
      },
      autoUpdate: {
        ...au,
        harness: au.harness && typeof au.harness === 'object' ? pickFields(au.harness, STRUCTURED_HARNESS_FIELDS) : null,
      },
      supervisors: {
        ...pickFields(sup, ['active', 'count', 'deadReceipts', 'matchesInstalled']),
        live: Array.isArray(sup.live) ? sup.live.map((state) => pickFields(state, STRUCTURED_PAIR_FIELDS)) : [],
        pendingReconnect: pids(sup.pendingReconnect),
        preFix: pids(sup.preFix),
        hibernated: pids(sup.hibernated),
        transitioning: pids(sup.transitioning),
        impaired: pids(sup.impaired),
      },
      readinessWarnings: Array.isArray(r?.readinessWarnings) ? [...r.readinessWarnings] : [],
      actions: Array.isArray(r?.actions) ? [...r.actions] : [],
    };
  } catch (error) {
    return { schemaVersion: 1, verdict: r?.verdict ?? null, error: String(error?.message || error) };
  }
}

// One-line drift summary (empty when clean) — for a footer / status line.
export function driftLine(r) {
  if (r.verdict === 'ALIGNED') return '';
  if (r.verdict === 'PARTIAL') return `⚠️ brain PARTIAL: ${(r.readinessWarnings || []).join(' · ')}`;
  const bits = [];
  if (!r.version.installed) return 'brain NOT installed — run `npx klypix-mcp install`';
  if (r.version.dirty) bits.push('dirty deploy');
  if (r.npm && r.npm.matches === false) bits.push(`v${r.version.baked}<${r.npm.latest}`);
  if (r.running && r.running.matchesInstalled === false) bits.push(`live server v${r.running.version}≠installed v${r.version.baked} (/mcp reconnect)`);
  if (r.supervisors?.impaired?.length) {
    const blocked = r.supervisors.impaired.filter(state => state.wakeBlocked).length;
    const workerless = r.supervisors.impaired.filter(state => state.workerImpaired && !state.wakeBlocked).length;
    const transport = r.supervisors.impaired.length - workerless - blocked;
    if (workerless) bits.push(`${workerless} supervisor(s) have no live worker — tool calls cannot complete (/mcp reconnect)`);
    if (blocked) bits.push(`${blocked} hibernated supervisor(s) cannot wake — the core files do not verify (npx -y klypix-mcp@latest install --force)`);
    if (transport) bits.push(`${transport} supervisor transport(s) cannot confirm host delivery (/mcp reconnect)`);
  }
  if (r.supervisors?.live?.some(state => state.degraded)) bits.push('supervisor host delivery backpressured');
  const misaligned = (r.supervisors?.live || []).filter(state => state.alignment === 'mismatch' && !state.impaired);
  if (misaligned.length) bits.push(`${misaligned.length} connection(s) serve a version ≠ installed v${r.version.baked}`);
  const crossing = (r.supervisors?.live || []).filter(state => state.alignment === 'reconnect-on-wake' && !state.impaired);
  if (crossing.length) bits.push(`${crossing.length} hibernated connection(s) cannot wake into the new major v${r.version.baked} (/mcp reconnect)`);
  if (r.hooks.missing.length) bits.push(`${r.hooks.missing.length} hook(s) unwired`);
  if (r.project.hasBrain && !r.harness.ok) bits.push(`${r.harness.drift.length} harness file(s) drifted`);
  if (r.layers?.decayGuard === 'drift') bits.push('decay-guard stale (fast-decay status claims unstamped)');
  if (r.layers?.mergeEngine === 'drift') bits.push('merge engine older than the brain (deleted cards can come back)');
  return bits.length ? `⚠️ brain DRIFTED: ${bits.join(' · ')}` : '';
}

// ── human report ──────────────────────────────────────────────────────────────
const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', rst: '\x1b[0m', bold: '\x1b[1m' };
export function render(r, opts = {}) {
  const color = opts.color !== false;
  const c = color ? C : new Proxy({}, { get: () => '' });
  const ok = color ? '✅' : '[ok]', warn = color ? '⚠️ ' : '[!]';
  const L = [];
  const head = r.verdict === 'ALIGNED'
    ? `${ok} ALIGNED`
    : r.verdict === 'PARTIAL'
      ? `${warn}PARTIAL (${r.readinessWarnings.length} readiness warning${r.readinessWarnings.length === 1 ? '' : 's'})`
      : r.verdict === 'NOT-INSTALLED'
        ? `${warn}NOT INSTALLED`
        : `${warn}DRIFTED (${r.drifted} layer${r.drifted === 1 ? '' : 's'})`;
  const nowMs = Number.isFinite(r.inspectedAt) ? r.inspectedAt : Date.now();
  L.push(`${c.bold}# brain_doctor${c.rst}  —  ${head}${r.doctor?.version ? `  ${c.dim}(doctor engine v${r.doctor.version})${c.rst}` : ''}`);
  if (r.doctor?.olderThanInstalled) {
    L.push(`${warn}${c.yel}this doctor (v${r.doctor.version}) is older than the installed brain v${r.version.baked} — it can miss or misread newer layers; run npx -y klypix-mcp@latest doctor${c.rst}`);
  }
  L.push('');

  // VERSION — 'ahead' (installed > registry) is a WARNING mark, never "✓ current":
  // it means this machine runs unreleased code (deliberate dev deploy or a
  // forgotten publish), and a release gate reading "current" here shipped wrong.
  const npmRel = r.npm ? (r.npm.relation ?? (r.npm.matches === false ? 'stale' : r.npm.matches === true ? 'current' : null)) : null;
  const vmark = r.layers.version === 'ok' ? (npmRel === 'ahead' ? warn : ok) : warn;
  L.push(`${vmark} ${c.bold}VERSION${c.rst}  brain core ${c.bold}v${r.version.baked || '(not deployed)'}${c.rst}${r.version.channel ? ` ${c.dim}via ${r.version.channel}${c.rst}` : ''}${r.version.dev ? `  ${c.yel}dev${c.rst}` : ''}`);
  if (r.version.dirty) L.push(`        ${c.red}DIRTY — running uncommitted hook code (source ${String(r.version.sourceSha || '?').slice(0, 12)})${c.rst}`);
  if (r.npm) L.push(`        npm latest v${r.npm.latest}  ${npmRel === 'stale' ? c.yel + '⚠ installed brain is behind' + c.rst
    : npmRel === 'ahead' ? c.yel + `⚠ AHEAD of npm — installed v${r.version.baked} > registry v${r.npm.latest}: running an UNRELEASED build (publish it, or expect peers to differ)` + c.rst
      : npmRel === 'current' ? c.grn + '✓ current' + c.rst : c.dim + '(no baked version to compare)' + c.rst}`);

  // RUNNING (behavioral truth — the live MCP server(s), not the baked file)
  if (r.running) {
    const run = r.running;
    const who = run.self ? "this session's " : (run.servers && run.servers.length > 1 ? `${run.servers.length} ` : '');
    const rm = run.matchesInstalled === false ? warn : ok;
    if (!run.known && run.allHibernated) {
      // Every pair asleep is the healthy idle state: no worker means no
      // heartbeat, and a reconnect would only wake them for nothing.
      const n = run.allHibernated;
      const pairs = r.supervisors?.live || [];
      // Pairs whose wake would fail (F5: a new major; F6: core files that do
      // not verify) are not promised a wake.
      const stuck = pairs.filter((state) => state.wakeBlocked || state.alignment === 'reconnect-on-wake').length;
      const wakes = [...new Set(pairs.map((state) => state.wakeVersion).filter(Boolean))];
      const into = wakes.length && r.version.baked && wakes.every((v) => cmpSemver(v, r.version.baked) === 0)
        ? `v${r.version.baked}`
        : (wakes.length ? wakes.map((v) => `v${v}`).join(' / ') : 'the installed runtime');
      // A wake into a version the pair has not run yet passes the gates first.
      const unvalidated = pairs.some((state) => state.alignment === 'pending-wake') ? ' (not yet validated)' : '';
      if (!stuck) {
        L.push(`${ok} ${c.bold}RUNNING${c.rst}  all ${n} connection${n === 1 ? '' : 's'} hibernated; ${n === 1 ? 'it wakes' : 'they wake'} into ${into} on the next request${unvalidated}`);
      } else {
        const wakeable = n - stuck;
        L.push(`${warn} ${c.bold}RUNNING${c.rst}  all ${n} connection${n === 1 ? '' : 's'} hibernated; ${wakeable ? `${wakeable} wake${wakeable === 1 ? 's' : ''} into ${into} on the next request${unvalidated}, ` : ''}${c.yel}${stuck} cannot wake as installed (see SUPERVISOR)${c.rst}`);
      }
    } else if (!run.known) L.push(`${ok} ${c.bold}RUNNING${c.rst}  ${c.dim}live server version unknown — no server has booted since the heartbeat shipped; /mcp reconnect to populate${c.rst}`);
    else if (run.matchesInstalled === false) L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${c.red}${who}live MCP server v${run.version} ≠ installed v${r.version.baked} — STALE; /mcp reconnect${c.rst}`);
    else L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${who}live MCP server v${run.version} ✓ matches installed`);
    // Multi-session visibility: list other live servers (self mode) or the full set
    // (CLI mode when >1) so a phantom / a stale peer server is never hidden.
    const extra = run.self ? (run.others || []) : (run.servers && run.servers.length > 1 ? run.servers : []);
    for (const s of extra) L.push(`        ${c.dim}· ${run.self ? 'other' : 'server'} pid ${s.pid ?? '?'} · v${s.version}${s.vault ? ' · ' + s.vault : ''}${s.ageMin != null ? ` (booted ${s.ageMin}m ago)` : ''}${c.rst}`);
  }

  // SUPERVISOR (stable host connection + replaceable worker)
  const vText = (value) => (value ? `v${value}` : 'v?');
  if (r.supervisors?.active) {
    const sup = r.supervisors;
    const totalReloads = sup.live.reduce((sum, state) => sum + state.hotReloads, 0);
    const impaired = sup.impaired || [];
    const degraded = sup.live.filter(state => state.degraded);
    const moving = sup.live.filter(state => state.transition && !state.impaired && !state.degraded);
    // The mark follows the LAYER (2026-10-03): a pair serving an old version is
    // drift with nothing impaired, and used to print [ok] beside DRIFTED.
    const smark = r.layers.supervisor === 'drift' ? warn : ok;
    // F11 (2026-10-03 review): a pair that rejected an update (still serving
    // the old worker) or cannot wake into a new major is not "healthy", and
    // zero-restart activation is exactly what did not happen for it.
    const reconnecting = sup.live.filter(state => !state.impaired && !state.degraded && !state.transition
      && (state.status === 'restart-required' || state.alignment === 'reconnect-on-wake'));
    const healthy = sup.count - impaired.length - degraded.length - moving.length - reconnecting.length;
    const activation = impaired.length || reconnecting.length ? '' : ' · zero-restart core activation ready';
    L.push(`${smark} ${c.bold}SUPERVISOR${c.rst}  ${healthy} healthy${moving.length ? ` · ${moving.length} transitioning` : ''}${reconnecting.length ? ` · ${c.yel}${reconnecting.length} need /mcp reconnect${c.rst}` : ''}${impaired.length ? ` · ${c.red}${impaired.length} IMPAIRED${c.rst}` : ''}${activation}${degraded.length ? ` · ${c.yel}${degraded.length} delivery-backpressured${c.rst}` : ''}${totalReloads ? ` · ${totalReloads} hot-swap${totalReloads === 1 ? '' : 's'}` : ''}`);
    for (const state of sup.live) {
      if (state.impaired) {
        if (state.status === 'restart-required') {
          L.push(`        ${c.red}· pid ${state.pid} restart-required: ${state.lastError || 'KLYPIX core changed incompatibly while idle'} — /mcp reconnect${c.rst}`);
          continue;
        }
        if (state.wakeBlocked) {
          const deferred = state.wakeDeferred;
          const why = deferred
            ? `its last wake found no consistent core to boot (${deferred.reason || 'runtime integrity'}${Number(deferred.count) > 1 ? `, ${deferred.count} attempts since ${deferred.since}` : ''})`
            : `the core files fail verification (${state.lastError})`;
          L.push(`        ${c.red}· pid ${state.pid} hibernated: ${why} — requests fail until they verify; npx -y klypix-mcp@latest install --force${c.rst}`);
          continue;
        }
        const reason = state.workerImpaired
          ? 'no live worker; tool calls cannot complete'
          : `host delivery ${state.deliveryStatus}`;
        L.push(`        ${c.red}· pid ${state.pid} ${state.status}: ${reason}${state.lastError ? `; ${state.lastError}` : ''} — /mcp reconnect${c.rst}`);
      }
      else if (state.degraded) L.push(`        ${c.yel}· pid ${state.pid} ${state.status}: host delivery is backpressured; queued output is awaiting drain${c.rst}`);
      else if (state.transition === 'waking') {
        // 'recovering' is shared by wakes and crash recovery; the receipt's
        // lastError tells them apart, so a crash is never relabelled a nap.
        const crash = /worker exited|restarted unexpectedly/i.test(state.lastError || '');
        L.push(`        ${c.dim}· pid ${state.pid} ${crash ? 'recovering after a worker exit' : 'waking'} into ${vText(state.candidateVersion)} — requests are queued (${state.status})${c.rst}`);
      }
      else if (state.transition === 'swapping') L.push(`        ${c.dim}· pid ${state.pid} swapping to ${vText(state.candidateVersion)} (from ${vText(state.activeVersion)})${c.rst}`);
      else if (state.alignment === 'reconnect-on-wake') L.push(`        ${c.yel}· pid ${state.pid} hibernated ${vText(state.activeVersion)} — the installed ${vText(state.pendingWakeVersion)} is a new major: its next request answers "core changed incompatibly" — /mcp reconnect${c.rst}`);
      else if (state.alignment === 'pending-wake') L.push(`        ${c.dim}· pid ${state.pid} hibernated ${vText(state.activeVersion)} — wakes into ${vText(state.pendingWakeVersion)} on next request (not yet validated)${c.rst}`);
      else if (state.status === 'restart-required') L.push(`        ${c.yel}· pid ${state.pid} restart-required: ${state.lastError || 'an update was rejected'} — /mcp reconnect (still serving ${vText(state.activeVersion)})${c.rst}`);
      else if (state.alignment === 'mismatch') L.push(`        ${c.yel}· pid ${state.pid} ${state.status} on ${vText(state.effectiveVersion)} — installed ${vText(r.version.baked)}${state.lastError ? `; ${state.lastError}` : ''}${c.rst}`);
      else if (state.lastError) L.push(`        ${c.yel}· pid ${state.pid} ${state.status}: ${state.lastError}${c.rst}`);
    }
    // Workers hot-swap; a SUPERVISOR cannot replace its own process under the
    // host's stdio. Say so explicitly — otherwise "aligned" reads as "every
    // shipped improvement is live", and a supervisor-level feature (today:
    // idle-worker hibernation and its RAM saving) is silently inactive.
    // C4 (2026-10-03): RAM release is claimed only for supervisors carrying the
    // fix. Pre-fix code (1.57 on) woke every idle pair about 1 s after it
    // hibernated — 750-800 worker spawns an hour on the founder's PC — so a
    // pre-fix pair caught asleep has released nothing that lasts.
    const preFix = sup.preFix || [];
    const pre157 = sup.pendingReconnect || [];
    // Only pairs a request can actually wake are credited with "wakes on the next request".
    const sleeping = (sup.hibernated || []).filter(state => !state.wakeBlocked && state.alignment !== 'reconnect-on-wake');
    const released = sleeping.filter(state => !state.preFix);
    const napping = sleeping.filter(state => state.preFix);
    const releasedText = released.length ? `${released.length} hibernated (worker released, presence held, wakes on the next request)` : '';
    if (preFix.length) {
      L.push(`        ${c.yel}· ${preFix.length} of ${sup.count} connection(s) still run pre-fix supervisor code — /mcp reconnect to apply (idle-worker hibernation / RAM release that stays asleep, compatibility-gated wakes)${pre157.length ? `; ${pre157.length} of them predate 1.57 and never hibernate` : ''}${c.rst}`);
      if (releasedText) L.push(`        ${c.dim}· ${releasedText}${c.rst}`);
      if (napping.length) L.push(`        ${c.dim}· ${napping.length} pre-fix pair(s) asleep at this instant — that code re-wakes an idle worker within seconds, so no RAM release is claimed${c.rst}`);
    } else if (sup.count) {
      L.push(`        ${c.dim}· all supervisors current${releasedText ? ` · ${releasedText}` : ''}${c.rst}`);
    }
  } else if (r.version.supervisorCapable) {
    L.push(`${warn} ${c.bold}SUPERVISOR${c.rst}  installed but this is a legacy direct-worker session · reconnect once to activate`);
  } else {
    L.push(`${warn} ${c.bold}SUPERVISOR${c.rst}  not installed · core updates require reconnect`);
  }
  if (r.supervisors?.deadReceipts) {
    L.push(`        ${c.dim}· ${r.supervisors.deadReceipts} dead supervisor receipt(s) ignored${c.rst}`);
  }

  // AUTO-UPDATE (2026-10-03): what the updater did last, for WHICH install, and
  // when it acts next. Never a drift layer; overdue or repeated failures make
  // the verdict PARTIAL through readinessWarnings. The old line printed a
  // hard-coded "24h" and the raw status, so '[ok] … last result dev-owned
  // v1.86.0' sat beside 'VERSION … v1.88.0 via npm' for a day.
  {
    const au = r.autoUpdate || {};
    const conn = au.connections;
    const known = au.knownLatest;
    const installedV = au.installedIdentity?.version || r.version.baked;
    const decisionText = {
      install: au.inProgress ? 'installs at the check now running' : 'installs at the next check',
      current: 'this install is current',
      ahead: 'this install is ahead of npm',
      'dev-owned': 'will NOT install automatically: developer-owned',
      'major-blocked': 'will NOT install automatically: new major',
      held: `will NOT install automatically: held after a manual downgrade to ${vText(installedV)}`,
      disabled: 'will NOT install automatically: disabled',
      unknown: 'install decision unknown',
    };
    const knownLine = (decision) => {
      const age = Number.isFinite(known.at) ? `${durationText(nowMs - known.at)} ago` : 'age unknown';
      const where = known.source === 'npm view' ? '' : ' known locally';
      return `        ${c.dim}· npm v${known.version}${where} (${known.source}, ${age}) — ${decisionText[decision] || decision}${c.rst}`;
    };
    if (au.moduleUnavailable) {
      // Nothing about the schedule can be known without the updater itself.
      L.push(`${warn} ${c.bold}AUTO-UPDATE${c.rst}  ${c.yel}state unknown — mcp-auto-update.mjs could not be loaded (a half-applied install?); automatic updates cannot run${c.rst}`);
    } else if (!(au.effectiveEnabled ?? au.enabled)) {
      // F4: the Claude Code hooks launch the helper from their own environment.
      const hookNote = au.hooksWired ? ' (the Claude Code hooks read their own environment)' : '';
      L.push(`${c.dim}· ${c.bold}AUTO-UPDATE${c.rst}  off by KLYPIX_AUTO_UPDATE${conn ? ` in all ${conn.live} live connection${conn.live === 1 ? '' : 's'}` : ''}${hookNote}${c.rst}`);
      if (known && au.knownNewer) L.push(knownLine('disabled'));
    } else {
      const at = (ms) => (Number.isFinite(ms) ? `${isoMinute(ms)}, ${durationText(nowMs - ms)} ago` : 'time unknown');
      const checkedMs = timeOf(au.checkedAt);
      const parts = [
        au.hooksOnly && conn
          ? `enabled for Claude Code sessions in brain projects only — off by KLYPIX_AUTO_UPDATE in all ${conn.live} live MCP connection${conn.live === 1 ? '' : 's'}`
          : (conn && conn.enabled < conn.live ? `enabled in ${conn.enabled} of ${conn.live} connections` : 'enabled'),
        au.cadenceMs === null ? 'checks on the installed updater\'s schedule' : `checks every ${durationText(au.cadenceMs || AUTO_UPDATE_TTL_MS)}`,
      ];
      // What the last result says — and whether it describes THIS install.
      if (au.unfinishedAttempt) {
        parts.push(`last attempt (${at(au.lastCheck)}) stopped before recording a result — counted as failed · attempt ${au.consecutiveFailures}`);
      } else if (au.stale) {
        const was = au.identity?.version || au.currentVersion;
        const channel = au.installedIdentity?.channel || r.version.channel;
        parts.push(`the last result (${au.result}${was ? ` v${was}` : ''}, ${Number.isFinite(checkedMs) ? isoMinute(checkedMs) : 'time unknown'}) describes the previous install — this ${channel ? `${channel} ` : ''}${vText(r.version.baked || installedV)} install has not been checked yet`);
      } else if (au.result === 'failed') {
        parts.push(`last attempt failed safely (${at(checkedMs)}): ${c.yel}${au.error || 'unknown error'}${c.rst} · attempt ${au.attempt || au.consecutiveFailures || 1}`);
      } else if (au.result) {
        // The version slot used to mean three different things (npm's latest,
        // the installed version, the version at check time) depending on result.
        const label = ['current', 'ahead', 'major-blocked', 'held'].includes(au.result)
          ? (au.latestVersion ? ` — npm v${au.latestVersion}` : '')
          : ['updated', 'bootstrapped'].includes(au.result)
            ? ` — installed ${vText(au.installedVersion || au.latestVersion)}${au.currentVersion ? ` (from v${au.currentVersion})` : ''}`
            : ['dev-owned'].includes(au.result)
              ? ` — ${au.currentVersion ? `v${au.currentVersion}` : 'version unknown'} at check time`
              : '';
        parts.push(`last result ${au.result}${label} (${at(checkedMs)})`);
      } else {
        parts.push('no check recorded yet');
      }
      // When the updater acts next.
      const dueMs = timeOf(au.dueAt);
      const pollText = AUTO_UPDATE_POLL_MS < 2 * 60 * 60 * 1000
        ? `${Math.round(AUTO_UPDATE_POLL_MS / 60000)} min`
        : durationText(AUTO_UPDATE_POLL_MS);
      if (au.inProgress) {
        parts.push(`check in progress since ${isoMinute(timeOf(au.inProgress.startedAt))}${au.inProgress.pid ? ` (pid ${au.inProgress.pid})` : ''}`);
      } else if (au.scheduleError || !Number.isFinite(dueMs)) {
        parts.push(`next check unknown${au.scheduleError ? ` (${au.scheduleError})` : ''}`);
      } else if (au.overdue) {
        parts.push(`${c.yel}check overdue by ${durationText(au.overdueByMs)} — no running session performed the check${c.rst}`);
      } else if (au.overdueSuppressed === 'no-poll-evidence' && Number.isFinite(au.dueForMs)) {
        // TR-1: not judged (K3), but not "due now" either — the rule reports
        // this only once the check is past its 30 min grace. Say how long, and
        // why it is not called overdue.
        const sinceMs = nowMs - au.dueForMs;
        const polledMs = timeOf(au.latestPollAt);
        const why = Number.isFinite(polledMs) && polledMs >= sinceMs
          ? `the latest poll on record (${isoMinute(polledMs)}, ${durationText(nowMs - polledMs)} ago) is too recent, or too close to the due time, to judge it overdue yet`
          : (au.unpolledSessions
            ? `overdue is not judged: no open session has recorded a poll since then — ${au.unpolledSessions} connection${au.unpolledSessions === 1 ? '' : 's'} on pre-fix supervisor code record${au.unpolledSessions === 1 ? 's' : ''} none (/mcp reconnect)`
            : `no open session has polled since then; it runs within ${pollText} while one is open`);
        parts.push(`check due since ${isoMinute(sinceMs)} (${durationText(au.dueForMs)}) — ${why}`);
      } else if (dueMs <= nowMs) {
        parts.push(`check due now — runs within ${pollText} while any KLYPIX session is open, or 2 s after the next one starts`);
      } else {
        parts.push(`${au.stale ? 'check due' : (au.consecutiveFailures > 0 ? 'next retry' : 'next check')} ${isoMinute(dueMs)} (in ${durationText(dueMs - nowMs)})`);
      }
      const amark = au.overdue || au.consecutiveFailures > 0 || au.scheduleError || au.blocked || au.holdIgnored ? warn : ok;
      L.push(`${amark} ${c.bold}AUTO-UPDATE${c.rst}  ${parts.join(' · ')}`);
      if (au.scheduleSkew?.rules === 'older') {
        L.push(`        ${c.dim}· these times and decisions follow the installed v${au.scheduleSkew.installed} updater's rules${au.updaterApi === 1 ? ' (checks every 24h, no downgrade hold)' : ''}, so overdue is not judged${c.rst}`);
      } else if (au.scheduleSkew?.rules === 'newer') {
        L.push(`        ${c.dim}· the installed v${au.scheduleSkew.installed} updater is newer than this doctor: its schedule and decisions are not shown — run npx -y klypix-mcp@latest doctor${c.rst}`);
      } else if (au.scheduleSkew) {
        L.push(`        ${c.dim}· these times follow this doctor's v${au.scheduleSkew.doctor} rules; the installed updater is v${au.scheduleSkew.installed}${au.overdueSuppressed === 'version-skew' ? ', so overdue is not judged' : ''}${c.rst}`);
      }
      if (au.holdIgnored) {
        L.push(`        ${c.yel}· the downgrade to ${vText(installedV)} is NOT held: the installed v${r.version.baked} updater predates the hold and re-installs v${au.holdIgnored.version} at its next check — to stay, set KLYPIX_AUTO_UPDATE=0 in each host's MCP server env and in Claude Code's hook environment${c.rst}`);
      }
      if (known && au.knownDecision && au.knownDecision !== 'current') L.push(knownLine(au.knownDecision));
    }
  }
  if (r.autoUpdate?.harness) {
    const h = r.autoUpdate.harness;
    const hmark = Number(h.failed || 0) > 0 ? warn : ok;
    // Since 2026-10-03 bulk passes skip stale registrations and record why.
    const reasons = h.skippedReasons && typeof h.skippedReasons === 'object'
      ? Object.entries(h.skippedReasons).map(([why, n]) => `${n} ${why}`).join(', ')
      : '';
    L.push(`${hmark} ${c.bold}AUTO-HARNESS${c.rst}  ${h.checked || 0} registered project(s) checked · ${h.updated || 0} refreshed · ${h.unchanged || 0} current · ${h.failed || 0} partial${h.skipped ? (reasons ? ` · ${h.skipped} skipped (${reasons})` : ` · ${h.skipped} busy/missing`) : ''}`);
  }

  // Host adapters
  const hmark = r.layers.hooks === 'ok' ? ok : warn;
  if (!r.hooks.settingsPresent) L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   no ~/.claude/settings.json found`);
  else if (r.hooks.missing.length === 1 && r.hooks.missing[0] === 'PreToolUse') L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   capture path intact; ${c.yel}guard lane not wired yet${c.rst} — \`npx klypix-mcp install\` adds the PreToolUse hook (guard cards)`);
  else if (r.hooks.missing.length) L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   half-wired — missing: ${c.yel}${r.hooks.missing.join(', ')}${c.rst}  ${c.dim}(liveness up, readiness no)${c.rst}`);
  else L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   existing 5-hook capture path intact: ${r.hooks.wired.join(', ')}`);
  if (r.hooks.sessionStartMissesClear) L.push(`   ${c.dim}note: SessionStart is not wired for /clear — a cleared conversation starts without the brain brief; "npx klypix-mcp install" adds "clear" to its matcher${c.rst}`);
  const chmark = r.layers.codexHooks === 'warning' ? warn : ok;
  const smart = r.codexSmart?.globalInstructions
    ? 'approval-free Context Gateway active (task memory + clean peers + proactive/guaranteed alerts)'
    : 'approval-free brain_sync Context Gateway available through MCP';
  if (r.codexHooks.error) {
    L.push(`${chmark} ${c.bold}CODEX${c.rst}    automatic MCP presence + ${smart}; optional native-hook config unreadable: ${c.yel}${r.codexHooks.error}${c.rst}`);
  } else if (!r.codexHooks.installed) {
    L.push(`${chmark} ${c.bold}CODEX${c.rst}    automatic MCP presence + ${smart} · native hooks off ${c.dim}(optional)${c.rst}`);
  } else if (r.codexHooks.executionStatus !== 'observed') {
    L.push(`${chmark} ${c.bold}CODEX${c.rst}    automatic MCP presence + ${smart} · ${c.yel}native hooks configured but execution not verified${c.rst}`);
    L.push(`        ${c.dim}Context Gateway memory/coordination already works. Once trusted, native hooks auto-inject task memory and warn before exact overlapping edits.${c.rst}`);
  } else {
    L.push(`${chmark} ${c.bold}CODEX${c.rst}    automatic MCP presence + ${smart} · native auto-context + pre-edit overlap warning active ${c.dim}(last observed ${r.codexHooks.lastExecutedAt})${c.rst}`);
  }
  // Commit-capture git hook — per-repo, informational (auto-installed at
  // session start where safe; foreign hooks are never edited automatically).
  if (r.gitCapture && r.gitCapture.state !== 'n/a') {
    const gc = r.gitCapture;
    const gmark = gc.state === 'installed' ? ok : warn;
    const detail = gc.state === 'installed' ? 'post-commit/post-merge wired — any agent/branch/worktree cards its rationale-bearing commits'
      : gc.state === 'custom-hookspath' ? `${c.yel}core.hooksPath set — not auto-installable (see actions)${c.rst}`
        : gc.state === 'foreign' ? `${c.yel}foreign hook in the slot — run \`npx klypix-mcp git-hook install\` to chain it deliberately${c.rst}`
          : gc.state === 'no-git' ? `${c.dim}not a git repo${c.rst}`
            : `${c.dim}${gc.state} — installs automatically at the next session start${c.rst}`;
    L.push(`${gmark} ${c.bold}GIT-CAP${c.rst}  ${detail}`);
  }
  // CHECKOUT — release state of the project's own source tree. Advisory only
  // (never a verdict layer): its job is to make branch + released-tag truth
  // visible at the moment of action, not to fail anything.
  if (r.checkout) {
    const where = `${r.checkout.branch ? `branch ${r.checkout.branch}` : 'detached HEAD'}, head ${r.checkout.headShort || '?'}`;
    if (r.checkout.releaseState === 'released-tag') {
      L.push(`${ok} ${c.bold}CHECKOUT${c.rst} source checkout at its release tag: v${r.checkout.version} (${where})`);
    } else {
      L.push(`${warn}${c.bold}CHECKOUT${c.rst} untagged working tree — v${r.checkout.version} has no release tag at HEAD (${c.yel}${where}${c.rst}) ${c.dim}· a build/release from here ships unreleased code (advisory)${c.rst}`);
    }
  }
  // Restore points — say the count and the age, because "you can undo an
  // accidental delete" is only believable if the machine can show the receipts.
  if (r.history?.available) {
    const age = r.history.newestAt ? `${Math.max(0, Math.round((Date.now() - r.history.newestAt) / 60000))}m ago` : 'none yet';
    L.push(`${ok} ${c.bold}HISTORY${c.rst}  ${r.history.count} restore point(s) · newest ${age} ${c.dim}(npx klypix-mcp brain-history list)${c.rst}`);
  }
  // Judgment provenance — say what confirm/dismiss verdicts this machine has
  // recorded, by verdict and surface, because "the trail exists" is only
  // believable with the counts on the table. Zero records = a new sidecar,
  // never a warning.
  if (r.provenance?.available) {
    const j = r.provenance.judgments || { total: 0, byVerdict: {}, bySource: {} };
    const rej = r.provenance.rejected || { total: 0 };
    const since = j.firstTs ? ` · since ${new Date(j.firstTs).toISOString().slice(0, 10)}` : '';
    const srcBits = Object.entries(j.bySource || {}).map(([source, n]) => `${source} ${n}`).join(' · ');
    L.push(`${ok} ${c.bold}JUDGMENTS${c.rst} ${j.total} recorded (${j.byVerdict?.yes || 0} yes / ${j.byVerdict?.no || 0} no)${since} · rejected-prompt pool ${rej.total}${srcBits ? ` ${c.dim}(${srcBits})${c.rst}` : ''}`);
  }

  // TOOLS
  L.push(`${ok} ${c.bold}TOOLS${c.rst}    ${r.tools.count} MCP verb(s)${r.tools.hash ? ` ${c.dim}[#${r.tools.hash}, ${r.tools.source}]${c.rst}` : ''}${r.tools.count ? `: ${c.dim}${r.tools.names.join(', ')}${c.rst}` : ''}`);

  // DECAY-GUARD (fast-decay status claims must stamp as LAST KNOWN, not current)
  if (r.decayGuard) {
    const d = r.decayGuard;
    const dmark = r.layers.decayGuard === 'ok' ? ok : warn;
    if (r.layers.decayGuard === 'ok') {
      L.push(`${dmark} ${c.bold}DECAY${c.rst}    stale build/deploy claims stamp as ⏱️ LAST KNOWN ${c.dim}(classifyDecay + renderer self-test pass)${c.rst}`);
    } else if (r.layers.decayGuard === 'unknown') {
      L.push(`${dmark} ${c.bold}DECAY${c.rst}    ${c.dim}engine not loadable — decay stamping unverified${c.rst}`);
    } else {
      const why = !d.exported ? 'engine predates classifyDecay'
        : d.rendererStamps === false ? 'status renderer left a synthetic 20h-old stale claim UNSTAMPED'
          : d.deployedFmtCurrent === false ? 'deployed klypix-format.mjs predates the decay guard'
            : 'deployed global-brain-hook.mjs predates message stamps';
      L.push(`${dmark} ${c.bold}DECAY${c.rst}    ${c.red}${why} — stale status claims can render as CURRENT state${c.rst}`);
    }
  }

  // MERGE ENGINE (Stage 2: receipts, restore as a merge, arrange burials)
  if (r.mergeEngine && r.layers.mergeEngine && r.layers.mergeEngine !== 'n/a') {
    const m = r.mergeEngine;
    const said = (x) => (!x.present ? 'missing' : x.api == null ? 'api ?' : `api ${x.api}`);
    const state = r.layers.mergeEngine;
    const mmark = state === 'ok' ? ok : warn;
    const tail = state === 'drift' ? `  ${c.red}older than brain v${r.version.baked} — a deleted card can come back from another copy${c.rst}`
      : state === 'absent' ? `  ${c.dim}history restore replaces the whole file; \`npx klypix-mcp install\` adds the engine${c.rst}`
        : state === 'unknown' ? `  ${c.dim}(version marker unreadable)${c.rst}` : '';
    L.push(`${mmark} ${c.bold}MERGE${c.rst}    engine ${said(m.engine)} · git driver ${said(m.driver)}${tail}`);
  }

  // ENGINE (C7): every module in the managed directory should be one an
  // installer put there and recorded. Shown only when a receipt exists.
  if (r.engineCode?.checked) {
    const e = r.engineCode;
    const receipt = `${e.receiptVersion ? `v${e.receiptVersion} ` : ''}install receipt`;
    const retired = Array.isArray(e.retired) ? e.retired : [];
    if (e.unreceipted.length) {
      const driver = e.mergeDriverFiles.length
        ? ` — ${c.red}including the git merge driver's own code (${e.mergeDriverFiles.join(', ')}), which runs on every brain merge${c.rst}`
        : '';
      L.push(`${warn} ${c.bold}ENGINE${c.rst}   ${e.unreceipted.length} module(s) outside the ${receipt}: ${c.yel}${e.unreceipted.join(', ')}${c.rst} — no installer vouches for this code${driver}`);
    } else {
      L.push(`${ok} ${c.bold}ENGINE${c.rst}   all ${e.total - e.desktopExtras.length - retired.length} engine module(s) covered by the ${receipt}${e.desktopExtras.length ? ` ${c.dim}(+${e.desktopExtras.length} desktop-app script(s))${c.rst}` : ''}`);
    }
    for (const item of retired) {
      L.push(`        ${c.dim}· ${item.name}: retired (${item.origin}); nothing imports it — safe to delete${c.rst}`);
    }
  }

  // SESSIONS: logical sessions are deduplicated only by explicit identity.
  // Connection rows remain visible because guessing identity from pid/client
  // can hide real concurrent work. A recent-chat row is not a heartbeat.
  if (!r.sessions.count) L.push(`${ok} ${c.bold}SESSIONS${c.rst}  0 active sessions ${c.dim}(saved/recent chats are history, not active)${c.rst}`);
  else {
    const hiddenIdle = Math.max(0,
      (r.sessions.rawRecent || r.sessions.connectionCount || r.sessions.count)
      - (r.sessions.connectionCount || r.sessions.count));
    const activeSilent = r.sessions.activeUnscopedCount || 0;
    const idleConnections = r.sessions.idleUnscopedCount || 0;
    const connections = r.sessions.connectionCount ?? r.sessions.count;
    const identityGap = r.sessions.activeCodexConnectionScopedCount || 0;
    L.push(`${activeSilent || identityGap ? warn : ok} ${c.bold}SESSIONS${c.rst}  ${r.sessions.logicalSessionCount ?? r.sessions.count} logical session${(r.sessions.logicalSessionCount ?? r.sessions.count) === 1 ? '' : 's'} · ${connections} live connection${connections === 1 ? '' : 's'} · ${r.sessions.syncedCount ?? r.sessions.count} with declared task scope${activeSilent ? ` · ${activeSilent} active without scope` : ''}${identityGap ? ` · ${identityGap} active Codex connection${identityGap === 1 ? '' : 's'} without exact identity` : ''}${idleConnections ? ` · ${idleConnections} idle/unscoped (not graded)` : ''} ${c.dim}(all hosts; channel-aware liveness${hiddenIdle ? `; +${hiddenIdle} row(s) with only a dead mcp channel excluded` : ''})${c.rst}`);
    for (const p of r.sessions.live) {
      const intentAge = p.intentAgeMin !== null && p.intentAgeMin - p.lastSeenMin > 3 ? ` (set ${p.intentAgeMin}m ago)` : '';
      const scopeState = p.synced
        ? ''
        : (p.activeUnscoped
          ? ` ${c.yel}· active sync-silent (used KLYPIX without brain_sync scope)${c.rst}`
          : ` ${c.dim}· idle connection (no task activity to grade)${c.rst}`);
      L.push(`        · ${p.client}:${p.id}${p.branch ? ' @' + p.branch : ''}${p.channels.length ? ` [${p.channels.join('+')}]` : ''}${p.statusLabel ? ` · ${p.statusLabel}` : ''}${p.intent ? ` “${p.intent.slice(0, 50)}”${intentAge}` : ''}${scopeState} ${c.dim}(${p.lastSeenMin}m ago)${c.rst}`);
    }
    for (const g of (r.sessions.identityMergeGaps || [])) {
      L.push(`        ${c.yel}⚠ explicit logical identity ${g.logicalSessionId} remains split across ${g.ids.join(' + ')}${c.rst}`);
    }
  }
  // MAILBOX: notes waiting for sessions that are not running, and the recent
  // sessions the lane remembers (two weeks) — the doors a note can wait at.
  {
    const waiting = Array.isArray(r.sessions.waitingOffline) ? r.sessions.waitingOffline : [];
    if (waiting.length) {
      L.push(`        ${c.yel}📬 ${waiting.length} note(s) waiting for session(s) not on the lane: ${waiting.slice(0, 4)
        .map((w) => `${w.to} ← ${w.from} (${w.ageMin}m ago)`).join(' · ')}${waiting.length > 4 ? ' · …' : ''}${c.rst}`);
    }
    const known = Array.isArray(r.sessions.known) ? r.sessions.known : [];
    if (known.length) {
      const age = (min) => (min >= 120 ? `${Math.round(min / 60)}h` : `${min}m`) + ' ago';
      L.push(`        ${c.dim}· recent, not on the lane (${known.length} in the last 14d): ${known.slice(0, 5)
        .map((k) => `${k.client}:${k.shortId || k.id.slice(0, 8)}${k.intent ? ` “${k.intent.slice(0, 40)}”` : ''} · ${age(k.lastSeenMin)}${k.endedAt ? ' · closed' : ''}${k.waitingNotes ? ` · ✉ ${k.waitingNotes} waiting` : ''}`)
        .join(' · ')}${known.length > 5 ? ' · …' : ''}${c.rst}`);
    }
  }

  // RECEIPT: on-demand and agent-neutral. This is deliberately not a verdict
  // layer: an absent sender id or an empty 24h window is normal, never drift.
  const receipt = renderReceiptSummary(r.receipts);
  if (receipt) L.push(receipt.replace(/^\ud83d\udcec Your/, '\ud83d\udcec your'));
  else if (r.receiptSessionId) L.push(`${c.dim}\u00b7 NOTES     no sent note from this session in the last 24h${c.rst}`);
  else L.push(`${c.dim}\u00b7 NOTES     receipt unavailable (caller session id not exposed)${c.rst}`);

  // HARNESS
  if (!r.project.hasBrain) L.push(`${c.dim}· HARNESS  no ./brain.klypix in ${r.project.dir} — projection n/a${c.rst}`);
  else {
    const cmark = r.layers.harness === 'ok' ? ok : warn;
    const notHere = (r.harness.skipped || []).filter((x) => /not installed/.test(x.why || '')).length;
    const notHereNote = notHere ? `${c.dim} · ${notHere} host file(s) not audited — that editor is not installed here${c.rst}` : '';
    if (r.harness.ok) L.push(`${cmark} ${c.bold}HARNESS${c.rst}  all ${r.harness.files.length} projected file(s) in sync${notHereNote}`);
    else {
      L.push(`${cmark} ${c.bold}HARNESS${c.rst}  ${r.harness.drift.length} of ${r.harness.files.length} drifted:${notHereNote}`);
      for (const h of r.harness.drift) L.push(`        · ${h.file} — ${c.yel}${h.status.toUpperCase()}${c.rst}${h.stampedVersion ? ` (stamped v${h.stampedVersion})` : ''}`);
    }
  }

  if (r.actions.length) {
    L.push('');
    L.push(`${c.bold}reconcile:${c.rst}`);
    for (const a of r.actions) L.push('  ' + a);
  }
  return L.join('\n');
}

// ── cross-project / cross-channel audit (--all) ─────────────────────────────────
// Superset of the legacy scripts/brain-doctor.mjs: every registered brain on this
// machine + its .mcp.json vault wiring (the SS2-class trap: a foreign absolute vault).
export function inspectAll(opts = {}) {
  const home = opts.home || os.homedir();
  const brainDir = path.join(home, '.claude', 'project-brain');
  const reg = readJson(path.join(brainDir, 'registry.json'), null);
  const brains = (Array.isArray(reg?.brains) ? reg.brains : []).filter(b => b && b.path);
  let drift = 0;
  const out = [];
  for (const b of brains) {
    const exists = fs.existsSync(b.path);
    const dir = path.dirname(b.path);
    const proj = b.project || path.basename(dir);
    let vault = '(none → defaults)', vaultOk = true;
    const cfg = readJson(path.join(dir, '.mcp.json'), null);
    if (cfg) {
      const args = cfg?.mcpServers?.['klypix-canvas']?.args || [];
      const vi = args.indexOf('--vault');
      vault = vi >= 0 ? args[vi + 1] : '(none → defaults)';
      const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
      vaultOk = vault === '.' || (vi >= 0 && norm(path.resolve(dir, vault)) === norm(dir));
      if (!vaultOk) drift++;
    }
    if (!exists) drift++;
    out.push({ project: proj, path: b.path, exists, vault, vaultOk, hasMcp: !!cfg });
  }
  return { brains: out, drift };
}
