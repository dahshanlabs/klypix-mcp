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
    .filter(([channel, seen]) => channel && now - Number(seen || 0) < SESSION_FRESH_MS));
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
  files,
  replaceFiles = false,
  event = null,
  channel = null,
  cwd = null,
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
      intent: intent !== undefined ? String(intent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : (previous.intent || ''),
      files: mergedFiles,
      event: event ?? previous.event ?? null,
      ...(Object.keys(channelSeen).length
        ? { channels: Object.keys(channelSeen), channelSeen }
        : {}),
      cwd: cwd ? path.resolve(cwd) : (previous.cwd || path.dirname(brainPath)),
      startedAt: previous.startedAt || now,
      lastSeen: now,
    };
    const kept = sessions.filter((session) => session.id !== id);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      messages: pruneMessages(data.messages, now).slice(-30),
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
      messages: pruneMessages(data.messages, now).slice(-30),
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

    const unseenIds = new Set(unseen.map((message) => message.id));
    for (const message of messages) {
      if (!unseenIds.has(message.id)) continue;
      if (!Array.isArray(message.seen)) message.seen = [];
      if (!message.seen.includes(sessionId)) message.seen.push(sessionId);
    }
    fs.writeFileSync(laneFile, JSON.stringify({ ...data, sessions, messages }));

    const ignored = new Set(ignoreTexts.map((text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()));
    const shown = [];
    const seenText = new Set();
    for (const message of unseen) {
      const key = String(message.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key || ignored.has(key) || seenText.has(key)) continue;
      seenText.add(key);
      shown.push(message);
    }
    return shown.slice(0, 6);
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
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
      messages: messages.slice(-30),
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
    const details = [
      clientLabel(session),
      session.branch ? `branch ${session.branch}` : null,
      session.intent ? `"${String(session.intent).slice(0, 90)}"` : null,
      `${ageMin}m ago`,
    ].filter(Boolean);
    lines.push(`- ${String(session.id).slice(0, 8)}: ${details.join(' | ')}`);
  }
  lines.push('Coordinate before touching shared files; use brain_message for a targeted note.');
  return lines.join('\n');
}

export function formatReceivedMessages(messages, now = Date.now()) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const lines = ['KLYPIX message(s) from another active session:'];
  for (const message of messages) {
    const ageMin = Math.max(0, Math.round((now - Number(message.ts || now)) / 60_000));
    lines.push(`- from ${String(message.from || '?').slice(0, 12)} (${ageMin}m ago): ${String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }
  return lines.join('\n');
}
