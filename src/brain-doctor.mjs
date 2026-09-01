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
import { inspectAutoUpdate } from './mcp-auto-update.mjs';
import { renderReceiptSummary, summarizeReceipts } from './finding-routing.mjs';

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

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
// Same normalization the hook uses to key the sessions lane: forward slashes + a
// lowercased drive letter, so the CLI computes the SAME sessions filename the hook wrote.
const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

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
  return { settingsPresent: present, wired, missing };
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
function inspectSupervisors(brainDir, baked) {
  const dir = path.join(brainDir, '.supervisors');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { /* absent */ }
  const live = [];
  for (const name of names) {
    const state = readJson(path.join(dir, name), null);
    if (!state?.pid || !isAlivePid(state.pid)) continue;
    const status = state.status || 'unknown';
    const intentionallyHibernated = status === 'hibernated'
      && state.hibernation?.hibernated === true;
    const sleepingTarget = intentionallyHibernated ? state.hibernation?.target : null;
    const deliveryStatus = state.transport?.delivery
      || (intentionallyHibernated ? 'pull-only' : (state.active ? 'connected' : 'unknown'));
    const workerImpaired = !state.active && !intentionallyHibernated
      && status !== 'starting' && status !== 'awaiting-initialize';
    const deliveryImpaired = deliveryStatus === 'impaired' || state.transport?.host === 'impaired';
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
      degraded: deliveryStatus === 'backpressured' || state.transport?.host === 'backpressured',
      deliveryStatus,
      transport: state.transport || null,
      activePid: state.active?.pid || null,
      activeVersion: state.active?.version || sleepingTarget?.version || null,
      activePath: state.active?.path || sleepingTarget?.path || null,
      hotReloads: Number(state.hotReloads || 0),
      lastSwapAt: state.lastSwapAt || null,
      lastError: state.lastError || null,
      // A worker hot-swaps behind a live connection; the SUPERVISOR cannot
      // replace its own process under the host's stdio, so supervisor-level
      // features arrive only on the next reconnect. Without this the doctor
      // reported "aligned" (true of workers) while a shipped supervisor
      // feature was silently inactive — the same class as rendering a
      // truncated list as a complete one.
      supervisorGeneration: state.hibernation ? 'current' : 'pre-1.57',
      hibernation: state.hibernation || null,
    });
  }
  const pendingReconnect = live.filter(state => state.supervisorGeneration !== 'current');
  return {
    active: live.length > 0,
    count: live.length,
    live,
    pendingReconnect,
    hibernated: live.filter(state => state.status === 'hibernated'),
    impaired: live.filter(state => state.impaired),
    matchesInstalled: live.length && baked
      ? live.every(state => state.activeVersion && cmpSemver(state.activeVersion, baked) === 0)
      : null,
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
  return {
    file,
    live,
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
  const supervisors = inspectSupervisors(brainDir, version.baked);
  const autoUpdate = inspectAutoUpdate(brainDir, { now, env: opts.env || process.env });
  const hooks = inspectHooks(home);
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
    autoUpdate: !autoUpdate.enabled
      ? 'off'
      : (autoUpdate.result === 'failed' || Number(autoUpdate.harness?.failed || 0) > 0 ? 'warning' : 'ok'),
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
    if (npm && npm.relation === 'stale') actions.push(`npx klypix-mcp install   # installed brain v${version.baked} < npm latest v${npm.latest}`);
    if (npm && npm.relation === 'ahead') actions.push(`publish the release (or \`npx klypix-mcp install\` to restore the released version)   # installed brain v${version.baked} > npm latest v${npm.latest} — this machine runs an UNRELEASED build`);
    if (running.matchesInstalled === false) actions.push(`/mcp reconnect (or restart the session)   # LIVE server v${running.version} ≠ installed v${version.baked} — the running MCP server is stale`);
    if (version.supervisorCapable && running.known && !supervisors.active) actions.push('/mcp reconnect once   # activate the zero-restart supervisor; compatible future core updates hot-swap automatically');
    if (hooks.missing.length) actions.push(`npx klypix-mcp install   # half-wired: hooks not active — ${hooks.missing.join(', ')}`);
    if (hasBrain && !harness.ok) actions.push('automatic harness repair pending   # retried at the next brain_sync/update check; no manual link command required');
    if (layers.decayGuard === 'drift') actions.push('npx klypix-mcp install   # decay-aware status guard missing/stale — stale build/deploy claims can render as CURRENT state');
    for (const s of supervisors.impaired || []) {
      const why = s.workerImpaired ? 'has no live worker; tool calls cannot complete' : `cannot confirm host delivery (${s.deliveryStatus})`;
      actions.push(`/mcp reconnect   # supervisor pid ${s.pid} ${why}`);
    }
    for (const s of supervisors.live.filter(state => state.degraded)) {
      actions.push(`/mcp reconnect if backpressure persists   # supervisor pid ${s.pid} has queued host output awaiting drain`);
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
  return { verdict, layers, drifted, readinessWarnings, version, running, supervisors, autoUpdate, hooks, codexSmart, codexHooks, gitCapture, history, tools, peers, sessions: peers, receipts: peers.receipts, receiptSessionId, harness, npm, decayGuard, checkout, project: { dir: projectDir, brainPath, hasBrain }, brainDir, actions };
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
    const workerless = r.supervisors.impaired.filter(state => state.workerImpaired).length;
    const transport = r.supervisors.impaired.length - workerless;
    if (workerless) bits.push(`${workerless} supervisor(s) have no live worker — tool calls cannot complete (/mcp reconnect)`);
    if (transport) bits.push(`${transport} supervisor transport(s) cannot confirm host delivery (/mcp reconnect)`);
  }
  if (r.supervisors?.live?.some(state => state.degraded)) bits.push('supervisor host delivery backpressured');
  if (r.hooks.missing.length) bits.push(`${r.hooks.missing.length} hook(s) unwired`);
  if (r.project.hasBrain && !r.harness.ok) bits.push(`${r.harness.drift.length} harness file(s) drifted`);
  if (r.layers?.decayGuard === 'drift') bits.push('decay-guard stale (fast-decay status claims unstamped)');
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
  L.push(`${c.bold}# brain_doctor${c.rst}  —  ${head}`);
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
    if (!run.known) L.push(`${ok} ${c.bold}RUNNING${c.rst}  ${c.dim}live server version unknown — no server has booted since the heartbeat shipped; /mcp reconnect to populate${c.rst}`);
    else if (run.matchesInstalled === false) L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${c.red}${who}live MCP server v${run.version} ≠ installed v${r.version.baked} — STALE; /mcp reconnect${c.rst}`);
    else L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${who}live MCP server v${run.version} ✓ matches installed`);
    // Multi-session visibility: list other live servers (self mode) or the full set
    // (CLI mode when >1) so a phantom / a stale peer server is never hidden.
    const extra = run.self ? (run.others || []) : (run.servers && run.servers.length > 1 ? run.servers : []);
    for (const s of extra) L.push(`        ${c.dim}· ${run.self ? 'other' : 'server'} pid ${s.pid ?? '?'} · v${s.version}${s.vault ? ' · ' + s.vault : ''}${s.ageMin != null ? ` (booted ${s.ageMin}m ago)` : ''}${c.rst}`);
  }

  // SUPERVISOR (stable host connection + replaceable worker)
  if (r.supervisors?.active) {
    const totalReloads = r.supervisors.live.reduce((sum, state) => sum + state.hotReloads, 0);
    const impaired = r.supervisors.impaired || [];
    const degraded = r.supervisors.live.filter(state => state.degraded);
    const smark = impaired.length || degraded.length ? warn : ok;
    const healthy = r.supervisors.count - impaired.length - degraded.length;
    L.push(`${smark} ${c.bold}SUPERVISOR${c.rst}  ${healthy} healthy${impaired.length ? ` · ${c.red}${impaired.length} IMPAIRED${c.rst}` : ' · zero-restart core activation ready'}${degraded.length ? ` · ${c.yel}${degraded.length} delivery-backpressured${c.rst}` : ''}${totalReloads ? ` · ${totalReloads} hot-swap${totalReloads === 1 ? '' : 's'}` : ''}`);
    for (const state of r.supervisors.live) {
      if (state.impaired) {
        const reason = state.workerImpaired
          ? 'no live worker; tool calls cannot complete'
          : `host delivery ${state.deliveryStatus}`;
        L.push(`        ${c.red}· pid ${state.pid} ${state.status}: ${reason}${state.lastError ? `; ${state.lastError}` : ''} — /mcp reconnect${c.rst}`);
      }
      else if (state.degraded) L.push(`        ${c.yel}· pid ${state.pid} ${state.status}: host delivery is backpressured; queued output is awaiting drain${c.rst}`);
      else if (state.lastError) L.push(`        ${c.yel}· pid ${state.pid} ${state.status}: ${state.lastError}${c.rst}`);
    }
    // Workers hot-swap; a SUPERVISOR cannot replace its own process under the
    // host's stdio. Say so explicitly — otherwise "aligned" reads as "every
    // shipped improvement is live", and a supervisor-level feature (today:
    // idle-worker hibernation and its RAM saving) is silently inactive.
    const pending = r.supervisors.pendingReconnect || [];
    const sleeping = r.supervisors.hibernated || [];
    if (pending.length) {
      L.push(`        ${c.yel}· ${pending.length} of ${r.supervisors.count} connection(s) still run a PRE-1.57 supervisor — their workers are current, but supervisor-level features (idle-worker hibernation / RAM release) start at each one's next reconnect${c.rst}`);
    } else if (r.supervisors.count) {
      L.push(`        ${c.dim}· all supervisors current${sleeping.length ? ` · ${sleeping.length} hibernated (worker released, presence held, wakes on the next request)` : ''}${c.rst}`);
    }
  } else if (r.version.supervisorCapable) {
    L.push(`${warn} ${c.bold}SUPERVISOR${c.rst}  installed but this is a legacy direct-worker session · reconnect once to activate`);
  } else {
    L.push(`${warn} ${c.bold}SUPERVISOR${c.rst}  not installed · core updates require reconnect`);
  }

  // AUTO-UPDATE (host-neutral supervisor policy; never part of the drift verdict).
  if (!r.autoUpdate?.enabled) {
    L.push(`${c.dim}· ${c.bold}AUTO-UPDATE${c.rst}  off by KLYPIX_AUTO_UPDATE${c.rst}`);
  } else if (r.autoUpdate.result === 'failed') {
    L.push(`${warn} ${c.bold}AUTO-UPDATE${c.rst}  enabled · last check failed safely${r.autoUpdate.error ? `: ${c.yel}${r.autoUpdate.error}${c.rst}` : ''}`);
  } else if (r.autoUpdate.result === 'major-blocked') {
    L.push(`${warn} ${c.bold}AUTO-UPDATE${c.rst}  compatible releases automatic · ${c.yel}${r.autoUpdate.error}${c.rst}`);
  } else if (r.autoUpdate.result) {
    const versionText = r.autoUpdate.installedVersion || r.autoUpdate.latestVersion || r.autoUpdate.currentVersion;
    L.push(`${ok} ${c.bold}AUTO-UPDATE${c.rst}  enabled · machine-wide 24h check · last result ${r.autoUpdate.result}${versionText ? ` v${versionText}` : ''}`);
  } else {
    L.push(`${ok} ${c.bold}AUTO-UPDATE${c.rst}  enabled · machine-wide 24h check starts with the MCP supervisor`);
  }
  if (r.autoUpdate?.harness) {
    const h = r.autoUpdate.harness;
    const hmark = Number(h.failed || 0) > 0 ? warn : ok;
    L.push(`${hmark} ${c.bold}AUTO-HARNESS${c.rst}  ${h.checked || 0} registered project(s) checked · ${h.updated || 0} refreshed · ${h.unchanged || 0} current · ${h.failed || 0} partial${h.skipped ? ` · ${h.skipped} busy/missing` : ''}`);
  }

  // Host adapters
  const hmark = r.layers.hooks === 'ok' ? ok : warn;
  if (!r.hooks.settingsPresent) L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   no ~/.claude/settings.json found`);
  else if (r.hooks.missing.length === 1 && r.hooks.missing[0] === 'PreToolUse') L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   capture path intact; ${c.yel}guard lane not wired yet${c.rst} — \`npx klypix-mcp install\` adds the PreToolUse hook (guard cards)`);
  else if (r.hooks.missing.length) L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   half-wired — missing: ${c.yel}${r.hooks.missing.join(', ')}${c.rst}  ${c.dim}(liveness up, readiness no)${c.rst}`);
  else L.push(`${hmark} ${c.bold}CLAUDE${c.rst}   existing 5-hook capture path intact: ${r.hooks.wired.join(', ')}`);
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
      L.push(`        · ${p.client}:${p.id}${p.branch ? ' @' + p.branch : ''}${p.channels.length ? ` [${p.channels.join('+')}]` : ''}${p.intent ? ` “${p.intent.slice(0, 50)}”${intentAge}` : ''}${scopeState} ${c.dim}(${p.lastSeenMin}m ago)${c.rst}`);
    }
    for (const g of (r.sessions.identityMergeGaps || [])) {
      L.push(`        ${c.yel}⚠ explicit logical identity ${g.logicalSessionId} remains split across ${g.ids.join(' + ')}${c.rst}`);
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
