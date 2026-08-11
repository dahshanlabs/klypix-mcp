// Agent-neutral live-session registry.
//
// Every host adapter writes the same per-brain lane used by Claude Code's
// existing global-brain-hook. The schema is deliberately additive: old Claude
// entries remain valid, while newer adapters can identify their client, model,
// surface, current intent, and touched files.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const SESSION_FRESH_MS = 10 * 60 * 1000;
export const MCP_SESSION_FRESH_MS = 3 * 60 * 1000;
export const MESSAGE_FRESH_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_RECEIPT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const MESSAGE_DELIVERY_VERSION = 2;
export const MESSAGE_LANE_CAP = 30;
export const MESSAGE_RECEIPT_CAP = 100;

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
const normBrainPath = (value) => String(value).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const canonicalPath = (value) => {
  try { return fs.realpathSync.native(value); }
  catch { return path.resolve(value); }
};
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};

// Machine identity for a lane row. A host PID is unique only per machine and per
// moment, so twin recognition (mcp-presence.mjs isSuspectedTwin) cannot rest on
// pid alone — see the comment there. There was no machine identifier anywhere in
// this codebase, so one is introduced here, in the single place lane rows are
// written. ADDITIVE: rows written by an older build (or by the Claude Code
// lifecycle hook, which has its own writer) simply carry no `machine`, and every
// reader must treat that as "unknown", never as "different".
export const MACHINE_ID = (() => {
  try { return sha16(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`); }
  catch { return sha16(`${os.hostname?.() || 'unknown'}|${os.platform?.() || 'unknown'}`); }
})();

// A lane write can legitimately FAIL: the lock is held and we give up rather than
// clobber a peer's just-posted message. That path returned listActiveSessions(),
// i.e. the exact same shape as a success — so a dropped heartbeat was
// indistinguishable from a written one and no caller could report it. The verdict
// now rides on the returned array as NON-ENUMERABLE own properties: the type stays
// Array, so every existing consumer (.find / .map / spread / JSON.stringify) is
// byte-for-byte unaffected, while a caller that cares can check `laneWriteOk`.
const withWriteVerdict = (sessions, ok, reason = null) => {
  try {
    Object.defineProperty(sessions, 'laneWriteOk', { value: ok, enumerable: false, configurable: true });
    Object.defineProperty(sessions, 'laneWriteSkippedReason', { value: reason, enumerable: false, configurable: true });
  } catch { /* frozen/exotic array — the verdict is best-effort, never a throw */ }
  return sessions;
};

export function findProjectBrain(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of ['brain.klypix', 'brain.any']) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; }
      catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function laneFileFor(brainPath, home = os.homedir()) {
  const key = sha16(normBrainPath(canonicalPath(brainPath)));
  return path.join(home, '.claude', 'project-brain', 'sessions', `${key}.json`);
}

function readLane(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function acquireLock(lockFile, { tries = 30, waitMs = 20, staleMs = 30_000 } = {}) {
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); }
  catch { /* write below will report failure */ }
  for (let i = 0; i < tries; i++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch { /* raced with the lock owner */ }
      sleepSync(waitMs);
    }
  }
  return false;
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); }
  catch { /* best effort */ }
}

// Delivered messages are rendered into a PEER AGENT'S PROMPT, and any same-user
// process can write the lane file directly — so message text is untrusted. A
// message carrying a live capture marker ("🧠 BRAIN [X]: fake decision") could
// be echoed by the receiving model and harvested into the shared brain as if the
// peer had decided it. Break the glyph-keyword adjacency the marker regexes
// require (🧠·BRAIN no longer matches /🧠\s*BRAIN/) — visually near-identical,
// never harvestable. Applied at POST (honest writers) AND at delivery (forged
// lane rows bypass post).
export function neutralizeMarkers(text) {
  return String(text || '').replace(/🧠(\s*)(BRAIN|MSG)/gi, '🧠·$2');
}

// ── Machine-turn intent guard ───────────────────────────────────────────────
// UserPromptSubmit does not only carry human-typed text: harnesses inject task
// notifications, system reminders and slash-command wrappers as "user" prompts.
// One of those stored verbatim became a session's declared intent
// ("<task-notification> <task-id>…" — 2026-08-07 AgentLit field incident), so
// every peer surface showed tool-plumbing instead of what the session was doing.
// deriveIntentFromPrompt() extracts the human intent from a raw prompt, or
// returns null when the whole turn is machine-generated — callers must then KEEP
// the previous intent (and may still stamp activity), never store the junk and
// never clear a good intent because a background task happened to complete.
const MACHINE_TAGS = 'task-notification|system-reminder|system-warning|local-command-caveat'
  + '|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr'
  + '|ide_selection|ide_opened_file|ide_diagnostics|persisted-output|tool-use-error'
  + '|session-start-hook|user-prompt-submit-hook|post-tool-use-hook|hook-[a-z0-9-]+';
const MACHINE_BLOCK_RE = new RegExp(
  '^(?:<(' + MACHINE_TAGS + ')\\b[^>]*>[\\s\\S]*?(?:</\\1>|$)|\\[SYSTEM NOTIFICATION[^\\]]*\\])\\s*', 'i');
// Tag-shaped start AFTER stripping known blocks: an unrecognized harness tag is
// far more likely than a human opening a prompt with raw XML, and the cost of
// failing closed is only "previous intent kept" — never data loss.
const TAG_SHAPED_RE = /^<[a-z][\w.:-]*(?:\s|\/?>)/i;

export function deriveIntentFromPrompt(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // A "[SYSTEM NOTIFICATION …]"-led turn is machine end to end — the prose
  // after the bracket header is harness narration, never the user's intent.
  if (/^\[SYSTEM NOTIFICATION/i.test(text)) return null;
  for (let hops = 0; hops < 12; hops++) {
    const m = MACHINE_BLOCK_RE.exec(text);
    if (!m) break;
    text = text.slice(m[0].length).trim();
  }
  if (!text || TAG_SHAPED_RE.test(text)) return null;
  return text;
}

// True when a non-empty prompt/intent value is machine-generated end to end.
// Empty strings are NOT machine turns — brain_sync phase "complete" clears
// intent with '' deliberately, and that semantic must keep working.
export function looksMachineTurn(text) {
  const t = String(text || '').trim();
  return Boolean(t) && deriveIntentFromPrompt(t) === null;
}

// tmp+rename so lock-free readers (readLane, messageFooter, peers' status
// lines) can never parse a torn lane as an authoritative "0 peers / no
// messages", and a crash mid-write can never destroy undelivered messages.
// On Windows, renaming over a destination a reader/AV momentarily holds open
// throws EPERM — one immediate retry wins that race, and on final failure the
// tmp is REMOVED before rethrowing (the field found dozens of orphaned
// `.tmp-<pid>-<rand>` files littering the sessions dir, 2026-08-07).
function writeLaneFileAtomic(laneFile, payload) {
  const tmp = `${laneFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, payload);
  try {
    fs.renameSync(tmp, laneFile);
  } catch (err) {
    try { fs.renameSync(tmp, laneFile); }
    catch { try { fs.unlinkSync(tmp); } catch { /* best-effort */ } throw err; }
  }
  sweepStaleTmpFiles(path.dirname(laneFile));
}

// Opportunistic janitor for tmp orphans left by crashes or the pre-fix rename
// path. Throttled to once per process per 10 minutes; only files matching our
// own tmp naming and older than 15 minutes are touched, so an in-flight write
// (millisecond lifetime) can never be swept.
let lastTmpSweep = 0;
export function sweepStaleTmpFiles(dir, { now = Date.now(), maxAgeMs = 15 * 60 * 1000, force = false } = {}) {
  if (!force && now - lastTmpSweep < 10 * 60 * 1000) return 0;
  lastTmpSweep = now;
  let swept = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.tmp-\d+(?:-[a-z0-9]+)?$|\.\d+\.tmp$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); swept++; }
      } catch { /* raced or locked — next sweep */ }
    }
  } catch { /* dir unreadable — best-effort */ }
  return swept;
}

function freshChannelSeen(channelSeen, now) {
  if (!channelSeen || typeof channelSeen !== 'object' || Array.isArray(channelSeen)) return {};
  return Object.fromEntries(Object.entries(channelSeen)
    .filter(([channel, seen]) => channel
      && now - Number(seen || 0) < (channel === 'mcp' ? MCP_SESSION_FRESH_MS : SESSION_FRESH_MS)));
}

const normalizeTransport = (transport, channelSeen) => {
  const source = transport && typeof transport === 'object' && !Array.isArray(transport) ? transport : {};
  const out = {};
  for (const channel of Object.keys(channelSeen || {})) {
    const record = source[channel];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    out[channel] = {
      status: String(record.status || 'connected').slice(0, 40),
      at: Number(record.at || channelSeen[channel] || 0),
    };
  }
  return out;
};

export function sessionDeliveryReachability(session) {
  const channels = new Set(Array.isArray(session?.channels) ? session.channels.map(String) : []);
  const transport = session?.transport && typeof session.transport === 'object' ? session.transport : {};
  if (channels.has('lifecycle')) return 'connected';
  if (channels.has('mcp')) {
    const status = String(transport.mcp?.status || 'connected');
    if (['pull-only', 'impaired', 'backpressured'].includes(status)) return status;
    return 'connected';
  }
  if (channels.has('cloud')) return 'relay-best-effort';
  return 'unknown';
}

function pruneSessions(sessions, now) {
  const out = [];
  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    if (!session?.id) continue;
    const hadChannels = session.channelSeen
      && typeof session.channelSeen === 'object'
      && !Array.isArray(session.channelSeen)
      && Object.keys(session.channelSeen).length > 0;
    const channelSeen = freshChannelSeen(session.channelSeen, now);
    const transport = normalizeTransport(session.transport, channelSeen);
    const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
    const lastSeen = seenValues.length ? Math.max(...seenValues) : Number(session.lastSeen || 0);
    if ((hadChannels && !seenValues.length) || now - lastSeen >= SESSION_FRESH_MS) continue;
    out.push({
      ...session,
      ...(hadChannels ? { channelSeen, channels: Object.keys(channelSeen) } : {}),
      ...(hadChannels ? {
        transport,
        deliveryReachability: sessionDeliveryReachability({
          ...session,
          channelSeen,
          channels: Object.keys(channelSeen),
          transport,
        }),
      } : {}),
      lastSeen,
    });
  }
  return out;
}

const DELIVERY_STATES = new Set(['offered', 'acknowledged', 'failed']);
const recipientKey = (value) => String(value || '').trim().slice(0, 160);

function normalizeDeliveryRecord(record) {
  const recipientId = recipientKey(record?.recipientId || record?.id);
  if (!recipientId) return null;
  const state = DELIVERY_STATES.has(record?.state) ? record.state : 'offered';
  return {
    recipientId,
    state,
    attempts: Math.max(0, Number(record?.attempts || 0)),
    ...(record?.offeredAt ? { offeredAt: Number(record.offeredAt) } : {}),
    ...(record?.acknowledgedAt ? { acknowledgedAt: Number(record.acknowledgedAt) } : {}),
    ...(record?.failedAt ? { failedAt: Number(record.failedAt) } : {}),
    ...(record?.offeredActionId ? { offeredActionId: String(record.offeredActionId).slice(0, 160) } : {}),
    ...(record?.acknowledgedActionId ? { acknowledgedActionId: String(record.acknowledgedActionId).slice(0, 160) } : {}),
    ...(record?.reason ? { reason: String(record.reason).slice(0, 120) } : {}),
    ...(record?.legacySeen ? { legacySeen: true } : {}),
  };
}

// Legacy `seen[]` was written before hook/tool output reached model context.
// Migration therefore treats it as OFFERED only. The v2 receiver replays that
// note once, and only the later in-band action can acknowledge it.
export function normalizeMessageDelivery(message, now = Date.now()) {
  if (!message || !message.id) return null;
  const next = { ...message };
  const byRecipient = new Map();
  for (const raw of Array.isArray(message.deliveries) ? message.deliveries : []) {
    const record = normalizeDeliveryRecord(raw);
    if (record) byRecipient.set(record.recipientId, record);
  }
  for (const legacyId of Array.isArray(message.seen) ? message.seen : []) {
    const recipientId = recipientKey(legacyId);
    if (!recipientId || byRecipient.has(recipientId)) continue;
    byRecipient.set(recipientId, {
      recipientId,
      state: 'offered',
      attempts: 1,
      offeredAt: Number(message.ts || now),
      legacySeen: true,
    });
  }
  next.deliveryVersion = MESSAGE_DELIVERY_VERSION;
  next.deliveries = [...byRecipient.values()];
  if (!Array.isArray(next.seen)) next.seen = [];
  return next;
}

export function messageDeliveryState(message, sessionId) {
  const recipientId = recipientKey(sessionId);
  if (!recipientId) return 'pending';
  const record = (Array.isArray(message?.deliveries) ? message.deliveries : [])
    .find((entry) => recipientKey(entry?.recipientId || entry?.id) === recipientId);
  if (record && DELIVERY_STATES.has(record.state)) return record.state;
  if (Array.isArray(message?.seen) && message.seen.map(recipientKey).includes(recipientId)) return 'offered';
  return 'pending';
}

const messageDeliveryRecord = (message, sessionId) => {
  const recipientId = recipientKey(sessionId);
  return (Array.isArray(message?.deliveries) ? message.deliveries : [])
    .find((entry) => recipientKey(entry?.recipientId || entry?.id) === recipientId) || null;
};

function setDeliveryState(message, sessionId, state, now, reason = null, actionId = '') {
  const recipientId = recipientKey(sessionId);
  if (!recipientId) return;
  if (!Array.isArray(message.deliveries)) message.deliveries = [];
  let record = message.deliveries.find((entry) => recipientKey(entry?.recipientId || entry?.id) === recipientId);
  if (!record) {
    record = { recipientId, state: 'offered', attempts: 0 };
    message.deliveries.push(record);
  }
  record.recipientId = recipientId;
  record.state = state;
  if (state === 'offered') {
    record.attempts = Math.max(0, Number(record.attempts || 0)) + 1;
    record.offeredAt = now;
    if (actionId) record.offeredActionId = String(actionId).slice(0, 160);
    delete record.acknowledgedAt;
    delete record.failedAt;
    delete record.reason;
  } else if (state === 'acknowledged') {
    record.acknowledgedAt = now;
    if (actionId) record.acknowledgedActionId = String(actionId).slice(0, 160);
    delete record.failedAt;
    delete record.reason;
    if (!Array.isArray(message.seen)) message.seen = [];
    if (!message.seen.includes(recipientId)) message.seen.push(recipientId);
  } else if (state === 'failed') {
    record.failedAt = now;
    record.reason = String(reason || 'delivery-failed').slice(0, 120);
  }
}

function terminalizeMessage(message, now, reason) {
  const next = normalizeMessageDelivery(message, now);
  const known = new Set([
    ...(Array.isArray(next.candidateIds) ? next.candidateIds : []),
    ...next.deliveries.map((entry) => entry.recipientId),
  ].map(recipientKey).filter(Boolean));
  let unacknowledged = known.size === 0;
  for (const recipientId of known) {
    if (messageDeliveryState(next, recipientId) === 'acknowledged') continue;
    unacknowledged = true;
    setDeliveryState(next, recipientId, 'failed', now, reason);
  }
  if (unacknowledged) next.deadLetter = { state: 'failed', reason, at: now };
  else next.retiredAt = now;
  return next;
}

const isTerminalMessage = (message) => Boolean(message?.deadLetter || message?.retiredAt);

function retireFullyAcknowledged(message, now) {
  if (!message || isTerminalMessage(message)) return message;
  const candidates = [...new Set([
    ...(Array.isArray(message.candidateIds) ? message.candidateIds : []),
    ...(Array.isArray(message.deliveries) ? message.deliveries.map((entry) => entry?.recipientId || entry?.id) : []),
  ].map(recipientKey).filter(Boolean))];
  if (candidates.length && candidates.every((id) => messageDeliveryState(message, id) === 'acknowledged')) {
    message.retiredAt = now;
  }
  return message;
}

function pruneMessages(messages, now) {
  const out = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    let message = normalizeMessageDelivery(raw, now);
    if (!message) continue;
    const terminalAt = Number(message.deadLetter?.at || message.retiredAt || 0);
    if (terminalAt && now - terminalAt >= MESSAGE_RECEIPT_FRESH_MS) continue;
    if (!terminalAt && now - Number(message.ts || 0) >= MESSAGE_FRESH_MS) {
      message = terminalizeMessage(message, now, 'expired-before-acknowledgement');
    }
    out.push(message);
  }
  return out;
}

export function capMessages(messages, cap = MESSAGE_LANE_CAP, now = Date.now()) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((message) => retireFullyAcknowledged(normalizeMessageDelivery(message, now), now))
    .filter(Boolean);
  const active = list.filter((message) => !isTerminalMessage(message));
  const excess = Math.max(0, active.length - Math.max(0, Number(cap) || 0));
  const overflow = new Set(active.slice(0, excess).map((message) => message.id));
  const terminalized = list.map((message) => overflow.has(message.id)
    ? terminalizeMessage(message, now, 'lane-capacity-overflow')
    : message);
  const terminal = terminalized.filter(isTerminalMessage);
  const keepTerminal = new Set(terminal.slice(-MESSAGE_RECEIPT_CAP).map((message) => message.id));
  return terminalized.filter((message) => !isTerminalMessage(message) || keepTerminal.has(message.id));
}

const maintainMessages = (messages, now) => capMessages(pruneMessages(messages, now), MESSAGE_LANE_CAP, now);

function normalizeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const value = String(file || '').replace(/\\/g, '/').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(-20);
}

export function listActiveSessions({ brainPath, home, now = Date.now() }) {
  if (!brainPath) return [];
  const lane = readLane(laneFileFor(brainPath, home));
  return pruneSessions(lane.sessions, now).sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
}

export function upsertSession({
  brainPath,
  id,
  client = 'unknown',
  surface = null,
  model = null,
  permissionMode = null,
  branch = null,
  intent,
  intentSource = null,
  files,
  replaceFiles = false,
  event = null,
  channel = null,
  transportStatus = null,
  cwd = null,
  hostPid = null,
  home,
  now = Date.now(),
}) {
  if (!brainPath || !id) return withWriteVerdict([], false, 'no-brain-or-id');
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  // Lock timeout → read-only fallback, and SAY SO (see withWriteVerdict): this
  // session's heartbeat did NOT land, so the list is a peer snapshot that does not
  // include this touch.
  if (!gotLock) return withWriteVerdict(listActiveSessions({ brainPath, home, now }), false, 'lane-locked');
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const previous = sessions.find((session) => session.id === id) || {};
    const channelSeen = freshChannelSeen(previous.channelSeen, now);
    if (channel) channelSeen[String(channel)] = now;
    const transport = normalizeTransport(previous.transport, channelSeen);
    if (channel) {
      const status = transportStatus
        || (String(channel) === 'mcp' && String(event || '') === 'McpHibernated' ? 'pull-only' : 'connected');
      transport[String(channel)] = { status: String(status).slice(0, 40), at: now };
    }
    const mergedFiles = files === undefined
      ? normalizeFiles(previous.files)
      : normalizeFiles(replaceFiles ? files : [...(previous.files || []), ...(files || [])]);
    // Intent freshness is its OWN timestamp: lastSeen is refreshed by heartbeats
    // that never touch intent, so without intentAt a 100-minute-old intent renders
    // under "active just now" (2026-07-29 audit). Stamped only when the intent
    // VALUE actually changes; additive — old rows/readers are unaffected.
    // Defense-in-depth: a machine-generated value (harness notification, raw
    // XML tag) is treated as "no update" — the derivation layer in the hooks
    // is the primary guard, this catches any writer that skipped it.
    const effectiveIntent = intent !== undefined && looksMachineTurn(intent) ? undefined : intent;
    const nextIntent = effectiveIntent !== undefined
      ? String(effectiveIntent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      : (previous.intent || '');
    const intentChanged = effectiveIntent !== undefined && nextIntent !== (previous.intent || '');
    // A connection heartbeat proves transport liveness, not that a task is in
    // progress. Stamp only events that carry real user/tool work so doctor can
    // distinguish an idle connected host from an active sync-silent session.
    const activityEvent = /^(?:McpToolUse|McpTaskStart|McpTaskCheckpoint|UserPromptSubmit|PreToolUse|PostToolUse)$/i.test(String(event || ''))
      ? String(event)
      : null;
    const next = {
      ...previous,
      id: String(id),
      pid: process.pid,
      project: path.basename(path.dirname(brainPath)),
      client: String(client || previous.client || 'unknown'),
      surface: surface ?? previous.surface ?? null,
      model: model ?? previous.model ?? null,
      permissionMode: permissionMode ?? previous.permissionMode ?? null,
      branch: branch ?? previous.branch ?? null,
      intent: nextIntent,
      ...(intentChanged ? { intentAt: now, intentSource: intentSource || 'declared' }
        : (previous.intentAt ? { intentAt: previous.intentAt, intentSource: previous.intentSource || null } : {})),
      files: mergedFiles,
      event: event ?? previous.event ?? null,
      ...(activityEvent
        ? { activityAt: now, activityKind: activityEvent }
        : (previous.activityAt ? { activityAt: previous.activityAt, activityKind: previous.activityKind || null } : {})),
      ...(Object.keys(channelSeen).length
        ? {
          channels: Object.keys(channelSeen),
          channelSeen,
          transport,
          deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
        }
        : {}),
      cwd: cwd ? path.resolve(cwd) : (previous.cwd || path.dirname(brainPath)),
      // Host-process correlation (e.g. Claude Code exports CLAUDE_PID to every
      // child): lets readers recognize one logical session's lifecycle row and
      // MCP row as TWINS instead of two independent peers. `machine` scopes that
      // pid — a pid number is unique only per machine and per moment, so twin
      // recognition needs both (mcp-presence.mjs isSuspectedTwin).
      hostPid: Number(hostPid) || previous.hostPid || null,
      machine: MACHINE_ID,
      startedAt: previous.startedAt || now,
      lastSeen: now,
    };
    const kept = sessions.filter((session) => session.id !== id);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      messages: maintainMessages(data.messages, now),
    }));
    return withWriteVerdict(kept.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0)), true);
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

// ── Cross-PC remote rows (presence-relay.mjs is the only intended caller) ───
// Writes rows RECEIVED from the cloud presence channel into the same per-brain
// lane every reader already renders (peer footer, brain_sync peers, overlap
// conflicts, doctor) — one rendering path, zero reader changes. Precedence is
// explicit (D3, 2026-08-01): a row claiming THIS machine is refused (own-echo
// insurance beyond the frame-level drop), and a session id that already exists
// as a LOCAL row is never overwritten by a cloud frame — a session on this
// machine renders once, as local. Rows land with via:'cloud' + channelSeen.cloud
// so existing TTL pruning governs their lifetime (P3) and buildPresenceFrame
// refuses to re-broadcast them (loop prevention).
export function upsertRemoteSessions({ brainPath, rows, machineId = MACHINE_ID, home, now = Date.now() }) {
  if (!brainPath || !Array.isArray(rows) || !rows.length) return withWriteVerdict([], false, 'nothing-to-write');
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return withWriteVerdict(listActiveSessions({ brainPath, home, now }), false, 'lane-locked');
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    for (const row of rows) {
      if (!row?.id || !row.machine || row.via !== 'cloud') continue;
      if (String(row.machine) === String(machineId)) continue;   // never a remote row for this machine
      const existingIdx = sessions.findIndex((session) => session.id === row.id);
      if (existingIdx >= 0 && sessions[existingIdx].via !== 'cloud') continue;   // local row wins
      const previous = existingIdx >= 0 ? sessions[existingIdx] : {};
      const next = {
        ...previous,
        id: String(row.id),
        project: path.basename(path.dirname(brainPath)),
        client: String(row.client || previous.client || 'unknown'),
        surface: row.surface ?? previous.surface ?? null,
        branch: row.branch ?? previous.branch ?? null,
        // Same machine-turn guard as the local writer: a peer machine running a
        // pre-guard build can relay junk intent — never mirror it verbatim.
        intent: looksMachineTurn(row.intent) ? String(previous.intent || '') : String(row.intent || '').slice(0, 160),
        files: normalizeFiles(row.files),
        machine: String(row.machine),
        host: row.host ?? previous.host ?? null,
        via: 'cloud',
        channels: ['cloud'],
        transport: { cloud: { status: 'relay-best-effort', at: now } },
        deliveryReachability: 'relay-best-effort',
        channelSeen: { cloud: now },   // receiver clock (P4) — frame time never decides freshness
        startedAt: previous.startedAt || now,
        lastSeen: now,
      };
      if (existingIdx >= 0) sessions[existingIdx] = next;
      else sessions.push(next);
    }
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: sessions.slice(-40),
      messages: maintainMessages(data.messages, now),
    }));
    return withWriteVerdict(sessions.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0)), true);
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

// Consent revoked, or the channel deliberately left: receive-display stops too
// (symmetric consent, P9). Removes ONLY cloud-sourced rows — local presence is
// untouched, so degradation lands exactly on today's local-only behavior.
export function purgeRemoteSessions({ brainPath, home, now = Date.now() }) {
  if (!brainPath) return [];
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return listActiveSessions({ brainPath, home, now });
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now).filter((session) => session.via !== 'cloud');
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages: maintainMessages(data.messages, now),
    }));
    return sessions;
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

export function removeSession({
  brainPath,
  id,
  channel = null,
  // Optional ownership guard for replaceable MCP workers. A retiring worker
  // must not remove the shared logical row after a candidate process has
  // refreshed it. Checked under the same lane lock as removal, so there is no
  // read-then-delete race. Legacy callers omit it and retain prior behaviour.
  expectedPid = null,
  home,
  now = Date.now(),
}) {
  if (!brainPath || !id) return [];
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return listActiveSessions({ brainPath, home, now });
  try {
    const data = readLane(laneFile);
    const sessions = [];
    for (const session of pruneSessions(data.sessions, now)) {
      if (session.id !== id) {
        sessions.push(session);
        continue;
      }
      if (expectedPid !== null && Number(session.pid) !== Number(expectedPid)) {
        sessions.push(session);
        continue;
      }
      if (!channel || !session.channelSeen || typeof session.channelSeen !== 'object') continue;
      const channelSeen = freshChannelSeen(session.channelSeen, now);
      delete channelSeen[String(channel)];
      const transport = normalizeTransport(session.transport, channelSeen);
      const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
      if (!seenValues.length) continue;
      sessions.push({
        ...session,
        channels: Object.keys(channelSeen),
        channelSeen,
        transport,
        deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
        lastSeen: Math.max(...seenValues),
      });
    }
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages: maintainMessages(data.messages, now),
    }));
    return sessions;
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

function messageTargetsSession(message, session, sessionId) {
  const target = String(message?.to || '').trim().toLowerCase();
  if (!target || target === 'all' || target === '*') return true;
  const searchable = [
    String(sessionId || ''),
    String(sessionId || '').slice(0, 8),
    session?.branch,
    session?.intent,
    session?.client,
    session?.surface,
  ].filter(Boolean).join(' ').toLowerCase();
  return searchable.includes(target);
}

// One in-band action advances one step. A pending note is OFFERED; an already
// offered note is replayed on the later action and then ACKNOWLEDGED. This
// deliberate second injection is the recovery window for a closed response
// transport and is what makes legacy false-positive `seen` rows safe to migrate.
export function receiveMessages({
  brainPath,
  sessionId,
  ignoreTexts = [],
  home,
  now = Date.now(),
  actionId = '',
}) {
  if (!brainPath || !sessionId) return [];
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return [];
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const me = sessions.find((session) => session.id === sessionId);
    const due = messages.filter((message) => {
      const state = messageDeliveryState(message, sessionId);
      const record = messageDeliveryRecord(message, sessionId);
      return !isTerminalMessage(message)
        && message.from !== sessionId
        && (state === 'pending' || state === 'offered')
        && !(state === 'offered' && actionId && record?.offeredActionId === String(actionId))
        && messageTargetsSession(message, me, sessionId);
    });

    const normText = (message) => String(message.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ignored = new Set(ignoreTexts.map((text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    const deliveryKey = (message) => `${recipientKey(message?.from)}\u0000${normText(message)}`;
    const shown = [];
    const seenText = new Set();
    const dupesByText = new Map();
    for (const message of due) {
      const textKey = normText(message);
      const key = deliveryKey(message);
      // Text-only transcript compatibility can suppress this ONE response, but
      // cannot truthfully fail/ack a message: a peer may have sent identical
      // text. Stable sender ids handle real self-echoes via message.from above.
      if (!textKey || ignored.has(textKey)) continue;
      if (seenText.has(key)) {
        if (!dupesByText.has(key)) dupesByText.set(key, []);
        dupesByText.get(key).push(message);
        continue;
      }
      seenText.add(key);
      shown.push(message);
    }

    const delivered = shown.slice(0, 6);
    const advance = new Set();
    for (const message of delivered) {
      advance.add(message.id);
      for (const dupe of dupesByText.get(deliveryKey(message)) || []) advance.add(dupe.id);
    }
    for (const message of messages) {
      if (!advance.has(message.id)) continue;
      const previous = messageDeliveryState(message, sessionId);
      if (previous === 'offered') setDeliveryState(message, sessionId, 'acknowledged', now, null, actionId);
      else if (previous === 'pending') setDeliveryState(message, sessionId, 'offered', now, null, actionId);
      retireFullyAcknowledged(message, now);
    }
    // Persist migration/expiry/dead-letter changes even when the inbox is empty.
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
    return delivered;
  } finally {
    releaseLock(lockFile);
  }
}

// Explicit receipt path for adapters that can carry prior offer ids on a later
// inbound action. Pending ids are refused: an adapter cannot acknowledge a note
// it never offered into its model-visible response.
export function acknowledgeMessages({ brainPath, sessionId, messageIds = [], home, now = Date.now(), actionId = '' }) {
  if (!brainPath || !sessionId || !Array.isArray(messageIds) || !messageIds.length) return [];
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return [];
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const wanted = new Set(messageIds.map(String));
    const acknowledged = [];
    for (const message of messages) {
      const record = messageDeliveryRecord(message, sessionId);
      if (!wanted.has(String(message.id)) || messageDeliveryState(message, sessionId) !== 'offered'
        || (actionId && record?.offeredActionId === String(actionId))) continue;
      setDeliveryState(message, sessionId, 'acknowledged', now, null, actionId);
      retireFullyAcknowledged(message, now);
      acknowledged.push(message.id);
    }
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
    return acknowledged;
  } finally {
    releaseLock(lockFile);
  }
}

// Non-destructive inbox preview for MCP logging notifications. Unlike
// receiveMessages(), this never advances a v2 delivery state, so a host that
// ignores notifications cannot make a coordination warning vanish. The next
// supported model-context action can still offer/replay it within lane TTL/cap.
export function peekMessages({
  brainPath,
  sessionId,
  ignoreTexts = [],
  home,
  now = Date.now(),
}) {
  if (!brainPath || !sessionId) return [];
  const data = readLane(laneFileFor(brainPath, home));
  const sessions = pruneSessions(data.sessions, now);
  const messages = maintainMessages(data.messages, now);
  const me = sessions.find((session) => session.id === sessionId);
  const ignored = new Set(ignoreTexts.map((value) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()));
  const shown = [];
  const seenText = new Set();
  for (const message of messages) {
    const state = messageDeliveryState(message, sessionId);
    if (isTerminalMessage(message)
      || message.from === sessionId
      || (state !== 'pending' && state !== 'offered')
      || !messageTargetsSession(message, me, sessionId)) continue;
    const key = String(message.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || ignored.has(key) || seenText.has(key)) continue;
    seenText.add(key);
    shown.push(message);
  }
  return shown.slice(0, 6);
}

// Queue a durable-within-policy coordination message on the shared presence lane.
// `dedupeKey` makes machine-generated alerts (for example, exact file overlap)
// idempotent without weakening deliberate brain_message notes.
export function postPresenceMessage({
  brainPath,
  from,
  to = 'all',
  text,
  dedupeKey = '',
  home,
  now = Date.now(),
}) {
  const body = neutralizeMarkers(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400));
  if (!brainPath || !from || !body) return { posted: false, message: null };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { posted: false, message: null };
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const key = String(dedupeKey || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (key) {
      const existing = messages.find((message) => message?.dedupeKey === key);
      if (existing) return { posted: false, message: existing };
    }
    const senderId = String(from).slice(0, 160);
    const target = String(to || 'all').replace(/\s+/g, ' ').trim().slice(0, 160) || 'all';
    // Receipt truth must survive peers ending before the sender checks doctor.
    // Snapshot only recipient session ids (already lane metadata) at SEND time;
    // old messages without this additive field retain reconstruction fallback.
    const candidateIds = sessions
      .filter((session) => session?.id && session.id !== senderId
        && messageTargetsSession({ to: target }, session, session.id))
      .map((session) => String(session.id).slice(0, 160));
    const message = {
      id: sha16(`${from}|${to}|${body}|${now}|${crypto.randomBytes(4).toString('hex')}`),
      from: senderId,
      to: target,
      text: body,
      ts: now,
      seen: [],
      deliveryVersion: MESSAGE_DELIVERY_VERSION,
      deliveries: [],
      candidateIds,
      ...(key ? { dedupeKey: key } : {}),
    };
    messages.push(message);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages: capMessages(messages, MESSAGE_LANE_CAP, now),
    }));
    return { posted: true, message };
  } finally {
    releaseLock(lockFile);
  }
}

const clientLabel = (session) => {
  const client = String(session?.client || '').toLowerCase();
  if (!client) return 'Claude Code';
  if (client === 'codex') return 'Codex';
  if (client === 'claude-code' || client === 'claude') return 'Claude Code';
  return client.replace(/(^|[-_ ])([a-z])/g, (_m, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
};

export function formatPresenceMessage(sessions, selfId, { includeSolo = false, now = Date.now() } = {}) {
  const active = Array.isArray(sessions) ? sessions : [];
  const others = active.filter((session) => session.id !== selfId);
  if (!includeSolo && !others.length) return '';

  const counts = new Map();
  for (const session of active) {
    const label = clientLabel(session);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const mix = [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(', ');
  const lines = [
    `KLYPIX session awareness: ${active.length} active session${active.length === 1 ? '' : 's'} on this project (${mix || 'none'}); ${others.length} other${others.length === 1 ? '' : 's'} besides this chat.`,
  ];
  if (!others.length) {
    lines.push('Saved/recent chat rows are history, not active sessions; a session counts only while an authorized MCP connection or lifecycle adapter has heartbeated in the last 10 minutes.');
    return lines.join('\n');
  }
  lines.push('Other active sessions:');
  for (const session of others.slice(0, 8)) {
    const ageMin = Math.max(0, Math.round((now - Number(session.lastSeen || now)) / 60_000));
    // A heartbeat refreshes lastSeen while carrying an old intent forward — show
    // the INTENT's own age when it meaningfully lags the heartbeat, so a
    // 100-minute-old task line can never read as "what they're doing right now".
    const intentAgeMin = session.intentAt ? Math.max(0, Math.round((now - Number(session.intentAt)) / 60_000)) : null;
    const intentAge = intentAgeMin !== null && intentAgeMin - ageMin > 3 ? ` (intent set ${intentAgeMin}m ago)` : '';
    const details = [
      clientLabel(session),
      session.branch ? `branch ${session.branch}` : null,
      session.intent ? `"${String(session.intent).slice(0, 90)}"${intentAge}` : null,
      `${ageMin}m ago`,
    ].filter(Boolean);
    lines.push(`- ${String(session.id).slice(0, 8)}: ${details.join(' | ')}`);
  }
  // v1.32.0 law: a truncated list must never render as a complete one.
  if (others.length > 8) lines.push(`- …and ${others.length - 8} more live session(s) not listed — brain_doctor shows all.`);
  lines.push(`Presence is point-in-time (as of ${new Date(now).toISOString().slice(11, 16)}Z) — re-check before coordinating; use brain_message for a targeted note.`);
  return lines.join('\n');
}

// ── Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B) ──────────
// A delivered inter-session message is MEMORY, not a SENSOR: one older than 6h
// whose text asserts fast-decay build/deploy status ("no TestFlight upload
// triggered yet") must never read as CURRENT state — the ENGINE stamps it,
// never the reading model. The classifier lives ONCE in klypix-format.mjs;
// this file stays builtin-only, so consumers INJECT it (the optional third
// `decay` argument). With no injection the output is byte-identical to the
// unstamped form — an old bundle degrades to no stamp, never a throw. Each
// stamp is its OWN line appended AFTER the 400-char render slice (the v1.32.0
// law: a warning is never subject to the budget/cut it warns about) and exists
// in render output only — the lane file is never mutated.
const MSG_DECAY_STAMP_MS = 6 * 60 * 60 * 1000;
// classifyDecay is precision-first; mirror that here — only an explicit `true`
// or an explicitly fast-shaped object stamps. Anything ambiguous does NOT
// (a false stamp erodes trust in every stamp).
const isFastDecayResult = (r) => r === true || r === 'fast'
  || (!!r && typeof r === 'object' && (r.fast === true || r.fastDecay === true || r.decay === 'fast' || r.class === 'fast' || r.kind === 'fast'));
const decayAgeLabel = (ms) => {
  const h = Math.floor(Math.max(0, ms) / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : `${Math.max(1, h)}h`;
};

// Decay verdict for ONE delivered message: null, or { age, stampText } when it
// is stale (ts older than the engine threshold) AND its RAW text classifies
// fast-decay (raw, not the render slice — a claim cut out of the 400 chars
// must still stamp). Threshold, wording, and age format come from the injected
// engine surface ({ classifyDecay, decayStaleMs, decayMessageStamp,
// formatDecayAge }) so the renderers can never drift apart; the local
// fallbacks mirror klypix-format verbatim for a bundle old enough to carry the
// classifier but not the helpers.
export function messageDecayInfo(message, now = Date.now(), decay = {}) {
  const { classifyDecay, decayStaleMs, decayMessageStamp, formatDecayAge } = decay || {};
  if (typeof classifyDecay !== 'function') return null;
  try {
    const ts = Number(message?.ts) || 0;
    const staleMs = Number(decayStaleMs) > 0 ? Number(decayStaleMs) : MSG_DECAY_STAMP_MS;
    if (!ts || now - ts < staleMs) return null;
    if (!isFastDecayResult(classifyDecay(String(message?.text || '')))) return null;
    const ageMs = now - ts;
    return {
      age: typeof formatDecayAge === 'function' ? String(formatDecayAge(ageMs)) : decayAgeLabel(ageMs),
      stampText: typeof decayMessageStamp === 'function'
        ? String(decayMessageStamp(ageMs))
        : `⏱️ This message is ${decayAgeLabel(ageMs)} old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.`,
    };
  } catch { return null; }   // stamping is best-effort — a classifier bug must never break delivery
}

export function formatReceivedMessages(messages, now = Date.now(), decay = {}) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const lines = ['KLYPIX message(s) from another active session:'];
  for (const message of messages) {
    const ageMin = Math.max(0, Math.round((now - Number(message.ts || now)) / 60_000));
    lines.push(`- from ${String(message.from || '?').slice(0, 12)} (${ageMin}m ago): ${neutralizeMarkers(String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 400))}`);
    const info = messageDecayInfo(message, now, decay);
    if (info) lines.push(`  ${info.stampText}`);
  }
  return lines.join('\n');
}
