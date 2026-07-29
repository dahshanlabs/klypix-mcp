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

function freshChannelSeen(channelSeen, now) {
  if (!channelSeen || typeof channelSeen !== 'object' || Array.isArray(channelSeen)) return {};
  return Object.fromEntries(Object.entries(channelSeen)
    .filter(([channel, seen]) => channel
      && now - Number(seen || 0) < (channel === 'mcp' ? MCP_SESSION_FRESH_MS : SESSION_FRESH_MS)));
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
    const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
    const lastSeen = seenValues.length ? Math.max(...seenValues) : Number(session.lastSeen || 0);
    if ((hadChannels && !seenValues.length) || now - lastSeen >= SESSION_FRESH_MS) continue;
    out.push({
      ...session,
      ...(hadChannels ? { channelSeen, channels: Object.keys(channelSeen) } : {}),
      lastSeen,
    });
  }
  return out;
}

function pruneMessages(messages, now) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.id && now - Number(message.ts || 0) < MESSAGE_FRESH_MS);
}

// Cap the message lane WITHOUT silently destroying undelivered notes: the old
// flat `.slice(-30)` evicted the OLDEST rows first regardless of delivery, so a
// burst of >30 messages could destroy a note nobody had seen yet. Evict
// delivered (seen-by-someone) messages first, oldest first; only then the
// oldest undelivered ones. Order of survivors is preserved.
export function capMessages(messages, cap = 30) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= cap) return list;
  let excess = list.length - cap;
  const dropped = new Set();
  const evict = (predicate) => {
    for (const message of list) {
      if (!excess) return;
      if (dropped.has(message) || !predicate(message)) continue;
      dropped.add(message);
      excess--;
    }
  };
  evict((m) => Array.isArray(m?.seen) && m.seen.length > 0);   // delivered at least once
  evict(() => true);                                            // still over cap → oldest of the rest
  return list.filter((message) => !dropped.has(message));
}

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
  cwd = null,
  hostPid = null,
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
    const sessions = pruneSessions(data.sessions, now);
    const previous = sessions.find((session) => session.id === id) || {};
    const channelSeen = freshChannelSeen(previous.channelSeen, now);
    if (channel) channelSeen[String(channel)] = now;
    const mergedFiles = files === undefined
      ? normalizeFiles(previous.files)
      : normalizeFiles(replaceFiles ? files : [...(previous.files || []), ...(files || [])]);
    // Intent freshness is its OWN timestamp: lastSeen is refreshed by heartbeats
    // that never touch intent, so without intentAt a 100-minute-old intent renders
    // under "active just now" (2026-07-29 audit). Stamped only when the intent
    // VALUE actually changes; additive — old rows/readers are unaffected.
    const nextIntent = intent !== undefined
      ? String(intent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      : (previous.intent || '');
    const intentChanged = intent !== undefined && nextIntent !== (previous.intent || '');
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
      ...(Object.keys(channelSeen).length
        ? { channels: Object.keys(channelSeen), channelSeen }
        : {}),
      cwd: cwd ? path.resolve(cwd) : (previous.cwd || path.dirname(brainPath)),
      // Host-process correlation (e.g. Claude Code exports CLAUDE_PID to every
      // child): lets readers recognize one logical session's lifecycle row and
      // MCP row as TWINS instead of two independent peers.
      hostPid: Number(hostPid) || previous.hostPid || null,
      startedAt: previous.startedAt || now,
      lastSeen: now,
    };
    const kept = sessions.filter((session) => session.id !== id);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      messages: capMessages(pruneMessages(data.messages, now), 30),
    }));
    return kept.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

export function removeSession({ brainPath, id, channel = null, home, now = Date.now() }) {
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
      if (!channel || !session.channelSeen || typeof session.channelSeen !== 'object') continue;
      const channelSeen = freshChannelSeen(session.channelSeen, now);
      delete channelSeen[String(channel)];
      const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
      if (!seenValues.length) continue;
      sessions.push({
        ...session,
        channels: Object.keys(channelSeen),
        channelSeen,
        lastSeen: Math.max(...seenValues),
      });
    }
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages: capMessages(pruneMessages(data.messages, now), 30),
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

export function receiveMessages({
  brainPath,
  sessionId,
  ignoreTexts = [],
  home,
  now = Date.now(),
}) {
  if (!brainPath || !sessionId) return [];
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return [];
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const messages = pruneMessages(data.messages, now);
    const me = sessions.find((session) => session.id === sessionId);
    const unseen = messages.filter((message) =>
      message.from !== sessionId
      && !(Array.isArray(message.seen) && message.seen.includes(sessionId))
      && messageTargetsSession(message, me, sessionId));
    if (!unseen.length) return [];

    // Deliver-then-ack, never ack-then-truncate: the old path acked EVERY unseen
    // message under lock but returned only the first 6 — anything past the cap
    // was marked seen without ever being shown, permanently lost under the
    // delivered-once contract (2026-07-29 audit). Ack exactly: the delivered 6,
    // plus self-ignored texts and text-duplicates OF a delivered message (their
    // content was shown once via the twin). Overflow stays unacked and arrives
    // on the next call.
    const normText = (message) => String(message.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ignored = new Set(ignoreTexts.map((text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    const shown = [];
    const dropped = [];   // ignored (own sends) — content intentionally never shown
    const seenText = new Set();
    const dupesByText = new Map();
    for (const message of unseen) {
      const key = normText(message);
      if (!key || ignored.has(key)) { dropped.push(message); continue; }
      if (seenText.has(key)) {
        if (!dupesByText.has(key)) dupesByText.set(key, []);
        dupesByText.get(key).push(message);
        continue;
      }
      seenText.add(key);
      shown.push(message);
    }
    const delivered = shown.slice(0, 6);
    const ackIds = new Set(delivered.map((message) => message.id));
    for (const message of dropped) ackIds.add(message.id);
    for (const message of delivered) {
      for (const dupe of dupesByText.get(normText(message)) || []) ackIds.add(dupe.id);
    }
    if (ackIds.size) {
      for (const message of messages) {
        if (!ackIds.has(message.id)) continue;
        if (!Array.isArray(message.seen)) message.seen = [];
        if (!message.seen.includes(sessionId)) message.seen.push(sessionId);
      }
      fs.writeFileSync(laneFile, JSON.stringify({ ...data, sessions, messages }));
    }
    return delivered;
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

// Non-destructive inbox preview for MCP logging notifications. Unlike
// receiveMessages(), this NEVER appends the session id to message.seen, so a
// host that ignores notifications cannot make a coordination warning vanish.
// The next KLYPIX tool result or lifecycle hook still receives + acknowledges
// the same message through the guaranteed in-band path.
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
  const messages = pruneMessages(data.messages, now);
  const me = sessions.find((session) => session.id === sessionId);
  const ignored = new Set(ignoreTexts.map((value) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()));
  const shown = [];
  const seenText = new Set();
  for (const message of messages) {
    if (message.from === sessionId
      || (Array.isArray(message.seen) && message.seen.includes(sessionId))
      || !messageTargetsSession(message, me, sessionId)) continue;
    const key = String(message.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || ignored.has(key) || seenText.has(key)) continue;
    seenText.add(key);
    shown.push(message);
  }
  return shown.slice(0, 6);
}

// Queue a one-time coordination message directly on the shared presence lane.
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
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!brainPath || !from || !body) return { posted: false, message: null };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { posted: false, message: null };
  try {
    const data = readLane(laneFile);
    const sessions = pruneSessions(data.sessions, now);
    const messages = pruneMessages(data.messages, now);
    const key = String(dedupeKey || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (key) {
      const existing = messages.find((message) => message?.dedupeKey === key);
      if (existing) return { posted: false, message: existing };
    }
    const message = {
      id: sha16(`${from}|${to}|${body}|${now}|${crypto.randomBytes(4).toString('hex')}`),
      from: String(from).slice(0, 160),
      to: String(to || 'all').replace(/\s+/g, ' ').trim().slice(0, 160) || 'all',
      text: body,
      ts: now,
      seen: [],
      ...(key ? { dedupeKey: key } : {}),
    };
    messages.push(message);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages: capMessages(messages, 30),
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
    lines.push(`- from ${String(message.from || '?').slice(0, 12)} (${ageMin}m ago): ${String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    const info = messageDecayInfo(message, now, decay);
    if (info) lines.push(`  ${info.stampText}`);
  }
  return lines.join('\n');
}
