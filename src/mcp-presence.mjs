// Hookless, agent-neutral presence over the MCP connection lifecycle.
//
// Connecting the KLYPIX MCP server is already an explicit user authorization.
// Every stdio server process therefore registers one live session, heartbeats
// while the connection is open, and removes only its own MCP channel on close.
// Host hooks may enrich the same session id with prompt/file detail, but are not
// required for truthful active-session counts or pull-based message delivery.
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import path from 'path';
import {
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  messageDecayInfo,
  peekMessages,
  postPresenceMessage,
  receiveMessages,
  removeSession,
  upsertSession,
} from './agent-presence.mjs';

export const MCP_HEARTBEAT_MS = 60_000;
export const MCP_INBOX_POLL_MS = 3_000;

// Standard MCP server instructions are the approval-free awareness path. Hosts
// that surface InitializeResult.instructions to the model learn the same
// contract as Codex's managed AGENTS.md block; neither path executes local
// commands or crosses Codex's hook-trust boundary.
export const KLYPIX_MCP_INSTRUCTIONS = [
  'KLYPIX is the shared project brain for repositories containing ./brain.klypix.',
  'At the start of each task, call brain_sync with the current project root, a one-sentence intent, and any expected files before editing; the explicit project root keeps separate repositories on separate brains even when an MCP host launches servers from its own install directory.',
  'Use its active-task, message, and file-overlap report to coordinate concurrent work.',
  'Call brain_sync again when your file scope materially changes, and with phase "complete" before your final response.',
  'Do not read the full brain brief unless brain_sync says its compact context is insufficient or the task asks for broad history/status; use brain_ask for deeper retrieval.',
  'Capture only durable decisions or milestones with brain_note.',
  'Never hand-edit brain.klypix. If the current project has no brain.klypix, ignore this workflow.',
].join(' ');

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeFileKey = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .trim()
  .toLowerCase();

export function findPresenceConflicts(sessions, selfId) {
  const active = Array.isArray(sessions) ? sessions : [];
  const me = active.find((session) => session.id === selfId);
  if (!me) return [];
  const mine = new Map((me.files || [])
    .map((file) => [normalizeFileKey(file), String(file || '').replace(/\\/g, '/')])
    .filter(([key]) => key));
  if (!mine.size) return [];
  const conflicts = [];
  for (const peer of active) {
    if (peer.id === selfId) continue;
    const overlap = [...new Set((peer.files || [])
      .map(normalizeFileKey)
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
  files: Array.isArray(session?.files) ? session.files : [],
  ageMs: Math.max(0, now - Number(session?.lastSeen || now)),
});

export function buildPresenceSnapshot(sessions, selfId, { now = Date.now() } = {}) {
  const connected = Array.isArray(sessions) ? sessions : [];
  const tasks = connected.filter(isTaskSession);
  const self = connected.find((session) => session.id === selfId) || null;
  return {
    connectionCount: connected.length,
    activeTaskCount: tasks.length,
    backgroundConnectionCount: connected.length - tasks.length,
    self: self ? publicSession(self, now) : null,
    peers: tasks.filter((session) => session.id !== selfId).map((session) => publicSession(session, now)),
  };
}

function formatTaskPresence(snapshot) {
  const taskWord = snapshot.activeTaskCount === 1 ? 'task' : 'tasks';
  const connectionWord = snapshot.connectionCount === 1 ? 'connection' : 'connections';
  const lines = [
    `KLYPIX task presence: ${snapshot.activeTaskCount} active ${taskWord} across ${snapshot.connectionCount} live ${connectionWord}`
      + (snapshot.backgroundConnectionCount ? ` (${snapshot.backgroundConnectionCount} background/idle)` : '') + '.',
  ];
  if (!snapshot.peers.length) {
    lines.push('No other synchronized task is currently active; idle MCP connections are hidden from the peer list.');
    return lines.join('\n');
  }
  lines.push('Other active tasks:');
  for (const peer of snapshot.peers.slice(0, 8)) {
    const details = [
      peer.client,
      peer.branch ? `branch ${peer.branch}` : null,
      peer.intent ? `"${String(peer.intent).slice(0, 90)}"` : null,
      peer.files.length ? peer.files.slice(0, 4).join(', ') : null,
    ].filter(Boolean);
    lines.push(`- ${String(peer.id).slice(0, 12)}: ${details.join(' | ')}`);
  }
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
    'CLAUDE_SESSION_ID',
    'CURSOR_SESSION_ID',
    'CLINE_SESSION_ID',
    'WINDSURF_SESSION_ID',
  ]) {
    if (compact(env?.[key])) return compact(env[key]).slice(0, 160);
  }
  return `mcp-${pid}-${nonce}`;
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
  const sessionId = resolveMcpSessionId({ env });
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
  const sentTexts = new Set();
  const notifiedConflicts = new Set();
  const announcedMessageIds = new Set();

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
    if (!brainPath) return { sessions: [], messages: [], notice: '' };
    const stamp = now();
    const { client, surface } = clientInfo();
    const sessions = upsertSession({
      brainPath,
      id: sessionId,
      client,
      surface,
      branch: gitBranch(path.dirname(brainPath)),
      intent,
      files,
      replaceFiles,
      event,
      channel: 'mcp',
      cwd: path.dirname(brainPath),
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
    return { sessions, messages, notice };
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
        const filesKey = peer.files.map(normalizeFileKey).sort().join('|');
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
        guaranteed: 'next-klypix-action',
      },
      timingMs: { coordination: durationMs },
    };
    const text = [
      `KLYPIX Context Gateway: session ${sessionId} · phase ${nextPhase} · coordination ${durationMs}ms.`,
      formatTaskPresence(snapshot),
      messagesText,
      conflictText,
    ].filter(Boolean).join('\n\n');
    return { ...report, snapshot, conflicts, alertsQueued, structured, text };
  };

  const decorateToolResult = (result) => {
    if (!started) start(vault);
    const { notice } = touch({ event: 'McpToolUse', deliverMessages: true });
    if (!notice || !result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: notice }],
    };
  };

  const noteSent = (text) => {
    const value = compact(text).toLowerCase();
    if (value) sentTexts.add(value);
  };

  return {
    id: sessionId,
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
