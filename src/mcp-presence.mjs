// Hookless, agent-neutral presence over the MCP connection lifecycle.
//
// Connecting the KLYPIX MCP server is already an explicit user authorization.
// Every stdio server process therefore registers one live session, heartbeats
// while the connection is open, and removes only its own MCP channel on close.
// Host hooks may enrich the same session id with prompt/file detail, but are not
// required for truthful active-session counts or pull-based message delivery.
import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import {
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  laneFileFor,
  messageDecayInfo,
  peekMessages,
  postPresenceMessage,
  receiveMessages,
  removeSession,
  upsertSession,
} from './agent-presence.mjs';
// ONE definition of the file key. Exact-overlap detection (here) and finding
// ROUTING (there) must agree byte for byte — a file "owned" by a peer under one
// normalizer and not the other is a route that silently never happens. The
// canonical copy lives in the pure module because that one is import-restricted
// (crypto only), so it can never grow a dependency this file would inherit.
import { normalizeFileKey } from './finding-routing.mjs';

export const MCP_HEARTBEAT_MS = 60_000;
export const MCP_INBOX_POLL_MS = 3_000;

// Standard MCP server instructions are the approval-free awareness path. Hosts
// that surface InitializeResult.instructions to the model learn the same
// contract as Codex's managed AGENTS.md block; neither path executes local
// commands or crosses Codex's hook-trust boundary.
export const KLYPIX_MCP_INSTRUCTIONS = [
  'KLYPIX is the shared project brain for repositories containing ./brain.klypix.',
  'At the start of each task, call brain_sync with the current project root, a one-sentence intent, and any expected files before editing; the explicit project root keeps separate repositories on separate brains even when an MCP host launches servers from its own install directory.',
  'A session that never calls brain_sync appears to every peer as a connection with no declared scope — sync early so concurrent sessions can coordinate with you.',
  'Use its active-task, message, and file-overlap report to coordinate concurrent work.',
  'Call brain_sync again when your file scope materially changes, and with phase "complete" before your final response.',
  'Do not read the full brain brief unless brain_sync says its compact context is insufficient or the task asks for broad history/status; use brain_ask for deeper retrieval.',
  'Capture only durable decisions or milestones with brain_note.',
  'Never hand-edit brain.klypix. If the current project has no brain.klypix, ignore this workflow.',
].join(' ');

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// File-key normalization. `root` (optional) is the project root the two rows share
// — passing it folds an ABSOLUTE declaration and a REPO-RELATIVE one onto the same
// key. Without it, one session declaring "E:/repo/src/App.tsx" and another
// declaring "src/App.tsx" never matched, so the overlap warning silently never
// fired for the commonest mixed pair (2026-07-30 hardening). Defensive by design:
// a path that cannot be placed under `root` keeps the previous (absolute,
// lowercased) key, so an unrelated file still compares as itself and a
// declaration is never dropped.

// TWIN recognition: one logical session can (still) appear as two lane rows —
// its lifecycle id and an mcp-<pid> id — whenever id adoption failed. Rows that
// share a hostPid belong to ONE host process; treating the twin as a peer would
// raise a "blocking" file conflict against the session itself and queue it an
// overlap alert. Suppression is explicit (suspectedTwin), never silent.
//
// hostPid ALONE is not identity (2026-07-30 hardening). A pid number is only
// unique per machine and per moment: a lane read from a synced/shared home, or a
// recycled pid whose previous host died inside the 10-minute freshness window,
// made two UNRELATED sessions suppress each other's overlap warnings — and a
// MISSING warning is invisible, so nothing surfaced the mistake. Two extra
// discriminators are required, both drawn from fields the lane row already
// carries (see agent-presence.mjs upsertSession):
//   machine — must match when BOTH rows carry it. Absent on rows written by an
//             older build or by the lifecycle hook, so absence must not un-suppress
//             a genuine twin; it degrades to the previous behaviour.
//   client  — must match when BOTH are specifically known. 'mcp'/'unknown' are
//             placeholders (getClientVersion() is optional), so a generic value on
//             either side stays compatible. This is what separates a codex row from
//             a claude-code row that collided on one pid.
const sameMachine = (a, b) => !a.machine || !b.machine || String(a.machine) === String(b.machine);
const genericClient = (value) => !value || value === 'mcp' || value === 'unknown';
const compatibleClient = (a, b) => {
  const x = String(a.client || '').toLowerCase();
  const y = String(b.client || '').toLowerCase();
  return genericClient(x) || genericClient(y) || x === y;
};
export const isSuspectedTwin = (peer, me) => Boolean(
  peer && me
  && peer.hostPid && me.hostPid && peer.hostPid === me.hostPid
  && sameMachine(peer, me)
  && compatibleClient(peer, me),
);

export function findPresenceConflicts(sessions, selfId, { projectRoot } = {}) {
  const active = Array.isArray(sessions) ? sessions : [];
  const me = active.find((session) => session.id === selfId);
  if (!me) return [];
  // The lane is per-brain, so every row in it shares one project root; this
  // session's own cwd is that root (mcp-presence sets it to dirname(brain.klypix),
  // and brain_sync's explicit `project` flows into it).
  const root = projectRoot || me.cwd || null;
  const mine = new Map((me.files || [])
    .map((file) => [normalizeFileKey(file, root), String(file || '').replace(/\\/g, '/')])
    .filter(([key]) => key));
  if (!mine.size) return [];
  const conflicts = [];
  for (const peer of active) {
    if (peer.id === selfId) continue;
    if (isSuspectedTwin(peer, me)) continue;   // own twin row — a session cannot conflict with itself
    const overlap = [...new Set((peer.files || [])
      .map((file) => normalizeFileKey(file, root))
      .filter((file) => mine.has(file))
      .map((file) => mine.get(file)))];
    if (!overlap.length) continue;
    conflicts.push({
      id: peer.id,
      client: peer.client,
      surface: peer.surface || null,
      branch: peer.branch || null,
      intent: peer.intent || '',
      files: overlap,
      kind: 'exact-file',
      severity: 'blocking',
      sameWorktree: normalizeFileKey(peer.cwd) === normalizeFileKey(me.cwd),
    });
  }
  return conflicts;
}

const isTaskSession = (session) =>
  Boolean(compact(session?.intent) || (Array.isArray(session?.files) && session.files.length));

const publicSession = (session, now) => ({
  id: String(session?.id || ''),
  client: session?.client || 'unknown',
  surface: session?.surface || null,
  branch: session?.branch || null,
  intent: session?.intent || '',
  intentAgeMs: session?.intentAt ? Math.max(0, now - Number(session.intentAt)) : null,
  intentSource: session?.intentSource || null,
  files: Array.isArray(session?.files) ? session.files : [],
  ageMs: Math.max(0, now - Number(session?.lastSeen || now)),
});

export function buildPresenceSnapshot(sessions, selfId, { now = Date.now() } = {}) {
  const connected = Array.isArray(sessions) ? sessions : [];
  const self = connected.find((session) => session.id === selfId) || null;
  // A session's own twin rows are IT, not peers or background connections.
  const others = connected.filter((session) => session.id !== selfId && !isSuspectedTwin(session, self));
  const twinCount = connected.length - 1 - others.length;
  const tasks = others.filter(isTaskSession);
  return {
    connectionCount: connected.length - Math.max(0, twinCount),
    activeTaskCount: tasks.length + (self && isTaskSession(self) ? 1 : 0),
    // "background" here means SYNC-SILENT, not idle: a connection that never
    // declared a task may still be actively working — say so, don't bury it.
    backgroundConnectionCount: others.length - tasks.length,
    suspectedTwinCount: Math.max(0, twinCount),
    self: self ? publicSession(self, now) : null,
    peers: tasks.map((session) => publicSession(session, now)),
  };
}

function formatTaskPresence(snapshot, now = Date.now()) {
  const taskWord = snapshot.activeTaskCount === 1 ? 'task' : 'tasks';
  const connectionWord = snapshot.connectionCount === 1 ? 'connection' : 'connections';
  const lines = [
    `KLYPIX task presence: ${snapshot.activeTaskCount} active ${taskWord} across ${snapshot.connectionCount} live ${connectionWord}`
      + (snapshot.backgroundConnectionCount ? ` (${snapshot.backgroundConnectionCount} connected without a declared task — presence known, scope unknown)` : '') + '.',
  ];
  if (!snapshot.peers.length) {
    lines.push('No other DECLARED task is active; connections that never called brain_sync are not listed here — they may still be working (see the connection count above).');
    return lines.join('\n');
  }
  lines.push('Other active tasks:');
  for (const peer of snapshot.peers.slice(0, 8)) {
    const intentAgeMin = peer.intentAgeMs !== null ? Math.round(peer.intentAgeMs / 60_000) : null;
    const heartbeatMin = Math.round(peer.ageMs / 60_000);
    const intentAge = intentAgeMin !== null && intentAgeMin - heartbeatMin > 3 ? ` (intent set ${intentAgeMin}m ago)` : '';
    const details = [
      peer.client,
      peer.branch ? `branch ${peer.branch}` : null,
      peer.intent ? `"${String(peer.intent).slice(0, 90)}"${intentAge}` : null,
      peer.files.length ? peer.files.slice(0, 4).join(', ') + (peer.files.length > 4 ? ` (+${peer.files.length - 4} more)` : '') : null,
    ].filter(Boolean);
    lines.push(`- ${String(peer.id).slice(0, 12)}: ${details.join(' | ')}`);
  }
  // v1.32.0 law: a truncated list must never render as a complete one.
  if (snapshot.peers.length > 8) lines.push(`- …and ${snapshot.peers.length - 8} more active task(s) not listed — brain_doctor shows all.`);
  lines.push(`Point-in-time as of ${new Date(now).toISOString().slice(11, 16)}Z — re-sync before acting on it.`);
  return lines.join('\n');
}

export function normalizeMcpClient(name) {
  const value = compact(name).toLowerCase();
  if (!value) return 'mcp';
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('cline')) return 'cline';
  if (value.includes('windsurf')) return 'windsurf';
  if (value.includes('antigravity')) return 'antigravity';
  return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'mcp';
}

export function resolveMcpSessionId({
  env = process.env,
  pid = process.pid,
  nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  for (const key of [
    'KLYPIX_SESSION_ID',
    'CODEX_THREAD_ID',
    // Claude Code exports CLAUDE_CODE_SESSION_ID (live-verified 2026-07-29);
    // the list only carried the speculative CLAUDE_SESSION_ID name, so every
    // Claude MCP server fell through to mcp-<pid>-<nonce> and one logical
    // session produced two unmerged lane rows. Both names stay, either wins.
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CURSOR_SESSION_ID',
    'CLINE_SESSION_ID',
    'WINDSURF_SESSION_ID',
  ]) {
    if (compact(env?.[key])) return compact(env[key]).slice(0, 160);
  }
  return `mcp-${pid}-${nonce}`;
}

// The host-pid this server belongs to (Claude Code exports CLAUDE_PID to every
// child process). Used for the hostmap rotation below and for twin recognition.
export function resolveHostPid(env = process.env) {
  const pid = Number(env?.CLAUDE_PID || env?.KLYPIX_HOST_PID || 0);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// Hostmap: the lifecycle hook writes `<lane>.hostmap.json` mapping its host
// process pid → the CURRENT session id on every prompt. A spawn-time env id
// goes stale when the MCP server outlives /clear or a resume (the server
// process persists; the session id rotates) — re-reading the hostmap on every
// touch keeps the adopted id current with zero agent cooperation.
export function hostmapSessionId({ brainPath, hostPid, home, now = Date.now() } = {}) {
  if (!brainPath || !hostPid) return null;
  try {
    const file = laneFileFor(brainPath, home).replace(/\.json$/, '.hostmap');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = map && typeof map === 'object' ? map[String(hostPid)] : null;
    if (!entry || !compact(entry.sessionId)) return null;
    if (now - Number(entry.ts || 0) > 10 * 60 * 1000) return null;   // stale mapping — host gone
    return compact(entry.sessionId).slice(0, 160);
  } catch { return null; }
}

function gitBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

const peerFingerprint = (sessions, selfId) => (Array.isArray(sessions) ? sessions : [])
  .filter((session) => session.id !== selfId)
  .map((session) => [
    session.id,
    session.client,
    session.branch,
    session.intent,
    ...(Array.isArray(session.files) ? session.files : []),
  ].join('|'))
  .sort()
  .join('\n');

export function createMcpPresence({
  server,
  initialVault,
  env = process.env,
  home,
  heartbeatMs = MCP_HEARTBEAT_MS,
  inboxPollMs = MCP_INBOX_POLL_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  // Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B): the
  // injected engine surface ({ classifyDecay, decayStaleMs, decayMessageStamp,
  // formatDecayAge } from klypix-format.mjs) that lets every MCP delivery
  // surface — pollInbox logging, touch/decorateToolResult notices, brain_sync
  // text + structured messages — stamp a stale build/deploy message as LAST
  // KNOWN. Injection (not an import) keeps this file builtin-only; absent or
  // partial (old bundle), delivery degrades to unstamped — never a throw.
  decay = {},
} = {}) {
  let sessionId = resolveMcpSessionId({ env });
  const hostPid = resolveHostPid(env);
  const effectiveInboxPollMs = Number(env?.KLYPIX_MCP_INBOX_POLL_MS)
    || Number(inboxPollMs)
    || MCP_INBOX_POLL_MS;
  let vault = path.resolve(initialVault || process.cwd());
  let brainPath = null;
  let timer = null;
  let inboxTimer = null;
  let started = false;
  let lastPeers = '';
  let taskStartedAt = 0;
  let syncNudgeShown = false;
  const sentTexts = new Set();
  const notifiedConflicts = new Set();
  const announcedMessageIds = new Set();

  // Session-id rotation: the id is resolved once at spawn, but this server
  // process outlives /clear and session resume — the hook-written hostmap is
  // re-checked on every touch so the lane row follows the CURRENT session id
  // instead of silently mislabeling every later conversation (2026-07-29 audit).
  const adoptHostSession = (stamp) => {
    try {
      if (!brainPath || !hostPid) return;
      const mapped = hostmapSessionId({ brainPath, hostPid, home, now: stamp });
      if (!mapped || mapped === sessionId) return;
      const previous = sessionId;
      sessionId = mapped;
      // The old row's mcp channel is ours — release it so the lane never holds
      // two rows for one logical session longer than a single touch interval.
      removeSession({ brainPath, id: previous, channel: 'mcp', home, now: stamp });
      lastPeers = '';
    } catch { /* rotation is best-effort — an fs error must never kill the heartbeat */ }
  };

  const clientInfo = () => {
    let version = {};
    try { version = server?.server?.getClientVersion?.() || {}; } catch { /* optional */ }
    return {
      client: normalizeMcpClient(version.name),
      surface: compact(version.name) || 'mcp',
    };
  };

  const sendNotice = (message) => {
    if (!message || typeof server?.sendLoggingMessage !== 'function') return false;
    Promise.resolve(server.sendLoggingMessage({
      level: 'info',
      logger: 'klypix-presence',
      data: message,
    })).catch(() => {});
    return true;
  };

  // Best-effort proactive path: MCP logging notifications can surface an
  // overlap while the older session is still working. This deliberately PEEKS
  // instead of acknowledging. Hosts are allowed to hide logging notifications,
  // so the same warning remains unread and is guaranteed to arrive in-band on
  // the next KLYPIX tool result / brain_sync call.
  const pollInbox = () => {
    if (!brainPath) return [];
    const pending = peekMessages({
      brainPath,
      sessionId,
      ignoreTexts: [...sentTexts],
      home,
      now: now(),
    }).filter((message) => !announcedMessageIds.has(message.id));
    if (!pending.length) return [];
    if (sendNotice(formatReceivedMessages(pending, now(), decay))) {
      for (const message of pending) announcedMessageIds.add(message.id);
      while (announcedMessageIds.size > 100) {
        announcedMessageIds.delete(announcedMessageIds.values().next().value);
      }
    }
    return pending;
  };

  const touch = ({
    event = 'McpHeartbeat',
    includePresence = false,
    includeSolo = false,
    deliverMessages = false,
    intent,
    files,
    replaceFiles = false,
  } = {}) => {
    if (!brainPath) return { sessions: [], messages: [], notice: '', laneWriteOk: null, laneWriteSkippedReason: 'no-lane' };
    const stamp = now();
    adoptHostSession(stamp);
    const { client, surface } = clientInfo();
    const sessions = upsertSession({
      brainPath,
      id: sessionId,
      client,
      surface,
      branch: gitBranch(path.dirname(brainPath)),
      intent,
      intentSource: intent !== undefined ? 'declared' : null,
      files,
      replaceFiles,
      event,
      channel: 'mcp',
      cwd: path.dirname(brainPath),
      hostPid,
      home,
      now: stamp,
    });
    const messages = deliverMessages
      ? receiveMessages({
        brainPath,
        sessionId,
        ignoreTexts: [...sentTexts],
        home,
        now: stamp,
      })
      : [];
    if (deliverMessages) sentTexts.clear();

    const nextPeers = peerFingerprint(sessions, sessionId);
    const presenceChanged = nextPeers !== lastPeers;
    lastPeers = nextPeers;
    const presence = (includePresence || presenceChanged)
      ? formatPresenceMessage(sessions, sessionId, { includeSolo, now: stamp })
      : '';
    const notice = [
      presence,
      formatReceivedMessages(messages, stamp, decay),
    ].filter(Boolean).join('\n\n');
    if (notice) sendNotice(notice);
    // Additive, non-breaking: surface whether this touch's lane write actually
    // landed (agent-presence.mjs withWriteVerdict). A lock timeout returns a
    // read-only peer snapshot that does NOT include this heartbeat, and that used
    // to be indistinguishable from a successful write. null = unknown (an older
    // bundled agent-presence.mjs that does not stamp the verdict).
    return {
      sessions,
      messages,
      notice,
      laneWriteOk: sessions?.laneWriteOk ?? null,
      laneWriteSkippedReason: sessions?.laneWriteSkippedReason ?? null,
    };
  };

  const stop = () => {
    if (timer) clearIntervalFn(timer);
    if (inboxTimer) clearIntervalFn(inboxTimer);
    timer = null;
    inboxTimer = null;
    if (brainPath) removeSession({
      brainPath,
      id: sessionId,
      channel: 'mcp',
      home,
      now: now(),
    });
    brainPath = null;
    started = false;
    lastPeers = '';
    announcedMessageIds.clear();
  };

  const start = (nextVault = vault, details = {}) => {
    const resolved = path.resolve(nextVault || vault);
    if (started && resolved === vault) return touch({ event: 'McpReconnect', includePresence: true });
    if (started) stop();
    vault = resolved;
    brainPath = findProjectBrain(vault);
    if (!brainPath) return { sessions: [], messages: [], notice: '' };
    started = true;
    const first = touch({
      event: details.event || 'McpInitialize',
      includePresence: true,
      includeSolo: details.includeSolo === true,
      deliverMessages: details.deliverMessages === true,
      intent: details.intent,
      files: details.files,
      replaceFiles: details.replaceFiles === true,
    });
    timer = setIntervalFn(() => touch(), Math.max(5_000, Number(heartbeatMs) || MCP_HEARTBEAT_MS));
    inboxTimer = setIntervalFn(
      () => pollInbox(),
      Math.max(250, effectiveInboxPollMs),
    );
    timer?.unref?.();
    inboxTimer?.unref?.();
    return first;
  };

  const sync = ({ project, intent, files, phase = 'checkpoint' } = {}) => {
    const syncStartedAt = Date.now();
    const nextPhase = ['start', 'checkpoint', 'complete'].includes(phase) ? phase : 'checkpoint';
    const completing = nextPhase === 'complete';
    if (nextPhase === 'start') {
      taskStartedAt = now();
      notifiedConflicts.clear();
    } else if (!taskStartedAt && !completing) {
      taskStartedAt = now();
    } else if (completing) {
      notifiedConflicts.clear();
    }
    const details = {
      event: completing ? 'McpTaskComplete' : (nextPhase === 'start' ? 'McpTaskStart' : 'McpTaskCheckpoint'),
      includePresence: true,
      includeSolo: true,
      deliverMessages: true,
      intent: completing ? '' : intent,
      files: completing ? [] : files,
      replaceFiles: completing || nextPhase === 'start',
    };
    // Some IDE extension hosts launch a project-scoped MCP server from the
    // IDE's own installation directory. `project` is the host-independent
    // Context Gateway binding: one explicit workspace root selects exactly one
    // brain/presence lane for this connection. Omitting it preserves the
    // configured launch vault for backwards compatibility.
    const requestedVault = compact(project) ? path.resolve(project) : vault;
    const report = started && requestedVault === vault
      ? touch(details)
      : start(requestedVault, details);
    if (!brainPath) {
      return {
        ...report,
        conflicts: [],
        structured: {
          schemaVersion: 1,
          status: 'idle',
          phase: nextPhase,
          reason: 'no-project-brain',
          requestedProject: requestedVault,
        },
        text: `KLYPIX Context Gateway is idle: no brain.klypix was found at or above ${requestedVault}.`,
      };
    }

    const stamp = now();
    const conflicts = findPresenceConflicts(report.sessions, sessionId);
    const snapshot = buildPresenceSnapshot(report.sessions, sessionId, { now: stamp });
    const alertsQueued = [];
    if (!completing) {
      for (const peer of conflicts) {
        // Explicit arrow: normalizeFileKey now takes an optional `root` second
        // argument, so a bare `.map(normalizeFileKey)` would hand it the array
        // INDEX as the project root.
        const filesKey = peer.files.map((file) => normalizeFileKey(file)).sort().join('|');
        const key = `${peer.id}|${filesKey}`;
        if (notifiedConflicts.has(key)) continue;
        notifiedConflicts.add(key);
        const queued = postPresenceMessage({
          brainPath,
          from: sessionId,
          to: peer.id,
          text: `Automatic KLYPIX overlap alert: ${String(sessionId).slice(0, 12)}`
            + `${compact(intent) ? ` plans "${compact(intent).slice(0, 110)}"` : ' synchronized a task'}`
            + ` and reports the same file(s): ${peer.files.join(', ')}. Coordinate before editing.`,
          dedupeKey: `overlap|${sessionId}|${peer.id}|${taskStartedAt}|${filesKey}`,
          home,
          now: stamp,
        });
        if (queued.posted) alertsQueued.push({ peerId: peer.id, files: peer.files });
      }
    }

    const conflictText = conflicts.length
      ? [
        'KLYPIX exact file-overlap warning:',
        ...conflicts.map((peer) =>
          `- ${String(peer.id).slice(0, 12)}${peer.intent ? ` "${String(peer.intent).slice(0, 80)}"` : ''}: ${peer.files.join(', ')}`),
        alertsQueued.length
          ? 'The earlier peer was automatically queued an exact-once overlap alert; coordinate ownership before editing.'
          : 'Coordinate ownership before editing the overlapping files.',
      ].join('\n')
      : 'No exact file overlap is currently reported by another synchronized task.';
    const durationMs = Math.max(0, Date.now() - syncStartedAt);
    const messagesText = formatReceivedMessages(report.messages, stamp, decay);
    const structured = {
      schemaVersion: 1,
      status: completing ? 'complete' : 'active',
      phase: nextPhase,
      project: path.dirname(brainPath),
      brain: brainPath,
      self: snapshot.self,
      counts: {
        connections: snapshot.connectionCount,
        activeTasks: snapshot.activeTaskCount,
        backgroundConnections: snapshot.backgroundConnectionCount,
      },
      peers: snapshot.peers,
      conflicts,
      messages: report.messages.map((message) => {
        // Raw structured path gets the same decay verdict as the rendered
        // text: a consumer reading structured.messages directly must see the
        // LAST-KNOWN marking, not re-derive it (additive fields, schema 1).
        const decayInfo = messageDecayInfo(message, stamp, decay);
        return {
          id: message.id,
          from: message.from,
          text: message.text,
          ts: message.ts,
          ...(decayInfo ? { lastKnown: true, age: decayInfo.age, stampText: decayInfo.stampText } : {}),
        };
      }),
      alertsQueued,
      delivery: {
        proactive: 'mcp-logging-best-effort',
        // Honest scope: in-band delivery is guaranteed only while the message
        // survives the lane's 24h TTL / 30-message cap (undelivered notes are
        // preferred at eviction, but a target offline past the TTL misses it).
        guaranteed: 'next-klypix-action (within the 24h message TTL)',
      },
      timingMs: { coordination: durationMs },
    };
    const text = [
      `KLYPIX Context Gateway: session ${sessionId} · phase ${nextPhase} · coordination ${durationMs}ms.`,
      formatTaskPresence(snapshot, stamp),
      messagesText,
      conflictText,
    ].filter(Boolean).join('\n\n');
    return { ...report, snapshot, conflicts, alertsQueued, structured, text };
  };

  const decorateToolResult = (result) => {
    if (!started) start(vault);
    const { sessions, notice } = touch({ event: 'McpToolUse', deliverMessages: true });
    // Mechanical brain_sync nudge (once per server session): the "call
    // brain_sync first" contract was instructions-only — zero enforcement —
    // which is why Claude sessions sat sync-silent while Codex's gateway
    // declared scope automatically (2026-07-29 audit). If this session's own
    // row still has no intent AND no files after a real KLYPIX tool call,
    // say so once, in-band, where the agent actually reads it.
    let nudge = '';
    if (!syncNudgeShown && brainPath) {
      const self = (sessions || []).find((session) => session.id === sessionId);
      if (self && !isTaskSession(self)) {
        syncNudgeShown = true;
        nudge = 'KLYPIX presence: this session has not declared its task — peers see it as a connection with no scope. Call brain_sync {intent, files} so concurrent sessions can coordinate with you.';
      }
    }
    const extra = [notice, nudge].filter(Boolean).join('\n\n');
    if (!extra || !result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: extra }],
    };
  };

  const noteSent = (text) => {
    const value = compact(text).toLowerCase();
    if (value) sentTexts.add(value);
  };

  return {
    get id() { return sessionId; },   // getter — hostmap rotation can change it mid-life
    start,
    stop,
    touch,
    pollInbox,
    sync,
    noteSent,
    decorateToolResult,
    get brainPath() { return brainPath; },
    get vault() { return vault; },
  };
}
