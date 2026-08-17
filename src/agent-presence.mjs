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
export const MESSAGE_DELIVERY_VERSION = 3;
export const MESSAGE_LANE_CAP = 30;
export const MESSAGE_RECEIPT_CAP = 100;
export const SESSION_ALIAS_CAP = 8;
export const ENDED_SESSION_CAP = 80;
export const ENDED_SESSION_FRESH_MS = 24 * 60 * 60 * 1000;
// Marker shared by the pure relay seam. A message carrying this prefix was
// received from another computer, rather than authored on this local lane.
// Revoking cross-computer presence must remove these notes as well as cloud
// session rows while leaving local coordination history untouched.
export const REMOTE_MESSAGE_DEDUPE_PREFIX = 'xpc:';

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
const normBrainPath = (value) => String(value).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const canonicalPath = (value) => {
  try { return fs.realpathSync.native(value); }
  catch { return path.resolve(value); }
};
const PINNED_LANE_IDENTITIES = new Map();
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

// ── Dead-host sweep (2026-08-14 wave) ────────────────────────────────────────
// TTL pruning alone leaves a crashed host's rows visible for up to 10 minutes —
// long enough for a peer to "coordinate" with a ghost. When any session touches
// the lane, rows whose HOST process is provably dead are swept immediately.
// The probe is deliberately narrow, because a false sweep erases live presence:
//   · only rows written on THIS machine (row.machine === MACHINE_ID; a pid from
//     another machine or a cloud-relayed row lives in a foreign pid namespace),
//   · only rows whose hostPid came from a host-declared env var
//     (hostPidSource === 'env'). A ppid-guessed pid may be a short-lived shell
//     wrapper — probing it would sweep a perfectly live session — so guessed
//     pids are used for row correlation only, never for liveness,
//   · only rows older than a grace window, so a row written moments ago by a
//     process racing its own exit cannot flap.
// Anything the probe cannot decide falls back to the TTL rule — the sweep can
// only ever REMOVE provably-dead rows earlier, never keep rows longer.
// The grace deliberately EXCEEDS the MCP heartbeat interval (60s in
// mcp-presence.mjs — not imported here because that module imports this one):
// a session that is still writing heartbeats keeps its row's age under the
// grace, so even a WRONGLY-declared host pid (say, a stale KLYPIX_HOST_PID
// leaked from a shell profile) can never sweep a session that is actively
// alive. Only silent rows — the crash shape the sweep exists for — get probed.
export const DEAD_HOST_GRACE_MS = 90 * 1000;

// kill(pid, 0) is the portable liveness probe (works on Windows via
// OpenProcess). ESRCH ⇒ no such process; EPERM/EACCES ⇒ exists but owned by
// someone else ⇒ alive. Anything else — invalid input or an error code this
// table doesn't know — returns null ("cannot say"), NEVER false: an unproven
// death must fall back to TTL, because a false "dead" erases live presence.
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try { process.kill(n, 0); return true; }
  catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM' || err?.code === 'EACCES') return true;
    return null;
  }
}

export function isDeadHostRow(session, now = Date.now(), probe = isProcessAlive) {
  if (!session || session.via === 'cloud') return false;
  if (String(session.hostPidSource || '') !== 'env') return false;
  if (!session.machine || String(session.machine) !== String(MACHINE_ID)) return false;
  if (now - Number(session.lastSeen || 0) < DEAD_HOST_GRACE_MS) return false;
  return probe(session.hostPid) === false;
}

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

// Codex invokes one MCP tool through three independently running adapters:
// PreToolUse, the MCP worker, and PostToolUse. Request ids and tool_use_id are
// not present on every side, so they cannot be the shared action boundary. The
// host-authored turn id plus canonical tool name and a bounded canonical input
// digest are present on both sides and make the three observations converge.
const canonicalCodexToolName = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const mcpTail = raw.match(/^mcp(?:__|:)[^:]+?(?:__|:)(.+)$/);
  return String(mcpTail?.[1] || raw)
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
};

const canonicalActionInput = (value, state = { chars: 0 }, depth = 0) => {
  if (state.chars >= 16_384) return '[truncated]';
  if (depth > 8) return '[depth]';
  if (value === null) return null;
  if (typeof value === 'string') {
    const remaining = Math.max(0, 16_384 - state.chars);
    const text = value.slice(0, remaining);
    state.chars += text.length;
    return value.length > text.length ? `${text}[+${value.length - text.length}]` : text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) {
    const items = value.slice(0, 128).map((item) => canonicalActionInput(item, state, depth + 1));
    if (value.length > items.length) items.push(`[+${value.length - items.length}]`);
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).sort().slice(0, 128);
    for (const key of keys) out[key.slice(0, 160)] = canonicalActionInput(value[key], state, depth + 1);
    if (Object.keys(value).length > keys.length) out['[truncated-keys]'] = Object.keys(value).length - keys.length;
    return out;
  }
  return String(value);
};

export function codexToolActionId({ turnId, toolUseId, toolName, toolInput } = {}) {
  const turn = String(turnId || '').trim().slice(0, 72);
  const tool = canonicalCodexToolName(toolName);
  if (turn && tool) {
    let encoded = '';
    try { encoded = JSON.stringify(canonicalActionInput(toolInput)); }
    catch { encoded = '[unserializable]'; }
    const digest = crypto.createHash('sha256').update(encoded).digest('hex').slice(0, 20);
    return `codex-tool:${turn}:${tool}:${digest}`.slice(0, 160);
  }
  // tool_use_id is still valuable inside lifecycle-only operation, where it
  // keeps Pre/Post paired. It is deliberately only a fallback: including it
  // when a turn is available would split the MCP observation from its hooks.
  const use = String(toolUseId || '').trim().slice(0, 120);
  if (use) return `codex-tool-use:${use}`.slice(0, 160);
  return turn ? `codex-turn:${turn}` : '';
}

// Inbox APIs historically returned a bare array. Keep that contract while
// making lock/write failure observable: `[]` can now truthfully mean an empty
// inbox instead of also masquerading as a dropped receipt write.
const withDeliveryWriteVerdict = (items, ok, reason = null) => {
  try {
    const verdict = Object.freeze({ ok: Boolean(ok), reason: reason || null });
    Object.defineProperty(items, 'deliveryWriteOk', { value: Boolean(ok), enumerable: false, configurable: true });
    Object.defineProperty(items, 'deliveryWriteSkippedReason', { value: reason || null, enumerable: false, configurable: true });
    Object.defineProperty(items, 'deliveryWriteVerdict', { value: verdict, enumerable: false, configurable: true });
  } catch { /* best-effort metadata on a backward-compatible Array */ }
  return items;
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

export function laneFileFor(brainPath, home = os.homedir(), stableIdentityPath = null) {
  // `stableIdentityPath` is supplied only by a caller that has already captured
  // and revalidated the exact canonical brain object. Do not realpath it again:
  // a host callback between validation and this call may have retargeted the
  // lexical project junction, but it must not redirect lane hashing.
  const pinKey = normBrainPath(path.resolve(brainPath));
  const identity = stableIdentityPath
    ? path.resolve(stableIdentityPath)
    : (PINNED_LANE_IDENTITIES.get(pinKey) || canonicalPath(brainPath));
  const key = sha16(normBrainPath(identity));
  return path.join(home, '.claude', 'project-brain', 'sessions', `${key}.json`);
}

export function pinLaneIdentity(brainPath, stableIdentityPath = brainPath) {
  if (!brainPath || !stableIdentityPath) return { ok: false, reason: 'no-brain-or-identity' };
  const key = normBrainPath(path.resolve(brainPath));
  const identity = path.resolve(stableIdentityPath);
  PINNED_LANE_IDENTITIES.set(key, identity);
  return { ok: true, key, identity, laneFile: laneFileFor(brainPath, undefined, identity) };
}

// Missing is a valid first-use lane. Every other read failure is materially
// different: treating corrupt/unreadable bytes as `{}` lets the next mutator
// atomically replace the only copy of peer scope and unconsumed messages. Keep
// a permissive reader for read-only status surfaces, but require mutators to
// consume the checked result and fail closed.
function readLaneChecked(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, missing: true, data: {} };
    return {
      ok: false,
      missing: false,
      data: null,
      reason: `lane-unreadable:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`,
    };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, missing: false, data: null, reason: 'lane-corrupt:root-not-object' };
    }
    return { ok: true, missing: false, data };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      data: null,
      reason: `lane-corrupt:${String(error?.message || 'invalid-json').slice(0, 80)}`,
    };
  }
}

function readLane(file) {
  const result = readLaneChecked(file);
  return result.ok ? result.data : {};
}

const readMutableLane = (file) => readLaneChecked(file);

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

const normalizeChannelOwners = (owners, channelSeen) => {
  const source = owners && typeof owners === 'object' && !Array.isArray(owners) ? owners : {};
  const out = {};
  for (const channel of Object.keys(channelSeen || {})) {
    const pid = Number(source[channel]);
    if (Number.isInteger(pid) && pid > 0) out[channel] = pid;
  }
  return out;
};

const normalizeAliases = (aliases, exclude = '') => [...new Set((Array.isArray(aliases) ? aliases : [])
  .map((value) => recipientKey(value))
  .filter((value) => value && value !== recipientKey(exclude)))]
  .slice(-SESSION_ALIAS_CAP);

const pruneEndedSessions = (rows, now) => (Array.isArray(rows) ? rows : [])
  .filter((row) => row?.id && now - Number(row.endedAt || 0) < ENDED_SESSION_FRESH_MS)
  .map((row) => ({
    id: recipientKey(row.id),
    endedAt: Number(row.endedAt),
    aliases: normalizeAliases(row.aliases, row.id),
  }))
  .slice(-ENDED_SESSION_CAP);

const endedMatches = (row, id) => {
  const key = recipientKey(id);
  return key && (recipientKey(row?.id) === key || normalizeAliases(row?.aliases).includes(key));
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
    // Dead-host sweep: a row whose host process is provably gone is removed on
    // the next lane touch instead of lingering for the full TTL window.
    if (isDeadHostRow(session, now)) continue;
    const hadChannels = session.channelSeen
      && typeof session.channelSeen === 'object'
      && !Array.isArray(session.channelSeen)
      && Object.keys(session.channelSeen).length > 0;
    const channelSeen = freshChannelSeen(session.channelSeen, now);
    const transport = normalizeTransport(session.transport, channelSeen);
    const channelOwners = normalizeChannelOwners(session.channelOwners, channelSeen);
    const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
    const lastSeen = seenValues.length ? Math.max(...seenValues) : Number(session.lastSeen || 0);
    if ((hadChannels && !seenValues.length) || now - lastSeen >= SESSION_FRESH_MS) continue;
    out.push({
      ...session,
      ...(hadChannels ? { channelSeen, channels: Object.keys(channelSeen) } : {}),
      ...(hadChannels ? {
        transport,
        channelOwners,
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

const DELIVERY_STATES = new Set(['pending', 'offered', 'acknowledged', 'consumed', 'failed']);
const recipientKey = (value) => String(value || '').trim().slice(0, 160);
const makeOfferToken = () => crypto.randomBytes(18).toString('base64url');

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
    ...(record?.consumedAt ? { consumedAt: Number(record.consumedAt) } : {}),
    ...(record?.failedAt ? { failedAt: Number(record.failedAt) } : {}),
    ...(record?.offeredActionId ? { offeredActionId: String(record.offeredActionId).slice(0, 160) } : {}),
    ...(record?.acknowledgedActionId ? { acknowledgedActionId: String(record.acknowledgedActionId).slice(0, 160) } : {}),
    ...(record?.consumedActionId ? { consumedActionId: String(record.consumedActionId).slice(0, 160) } : {}),
    ...(record?.offerToken ? { offerToken: String(record.offerToken).slice(0, 160) } : {}),
    ...(record?.consumedVia ? { consumedVia: String(record.consumedVia).slice(0, 40) } : {}),
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
  const sourceVersion = Math.max(1, Number(message.deliveryVersion || 1));
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
  // History is never rewritten (2026-08-13). The previous migration deleted
  // retiredAt from v2-retired messages to "conservatively replay" them — which
  // resurrected up to a week of already-delivered notes, and immediately
  // re-terminalized every one older than 24h as FAILED. That falsified
  // delivery history in both directions on first post-upgrade touch. A v2
  // retirement proved model-context injection; it stays retired, recorded as
  // exactly that and no more.
  if (sourceVersion < MESSAGE_DELIVERY_VERSION && next.retiredAt && !next.deadLetter && !next.retirement) {
    next.retirement = { reason: 'v2-retired — model-context injection proven, explicit consumption unknown', at: Number(next.retiredAt) || now };
  }
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
    if (!record.offerToken) record.offerToken = makeOfferToken();
    if (actionId) record.offeredActionId = String(actionId).slice(0, 160);
    delete record.acknowledgedAt;
    delete record.consumedAt;
    delete record.acknowledgedActionId;
    delete record.consumedActionId;
    delete record.consumedVia;
    delete record.failedAt;
    delete record.reason;
  } else if (state === 'acknowledged') {
    if (!record.offerToken) record.offerToken = makeOfferToken();
    record.acknowledgedAt = now;
    if (actionId) record.acknowledgedActionId = String(actionId).slice(0, 160);
    delete record.failedAt;
    delete record.reason;
    if (!Array.isArray(message.seen)) message.seen = [];
    if (!message.seen.includes(recipientId)) message.seen.push(recipientId);
  } else if (state === 'consumed') {
    if (!record.offerToken) record.offerToken = makeOfferToken();
    record.consumedAt = now;
    if (actionId) record.consumedActionId = String(actionId).slice(0, 160);
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
  // Split by how far delivery actually got (2026-08-13). 'acknowledged' means
  // the note was rendered into model context on two independent actions —
  // expiring after that is NOT a delivery failure, and the old blanket
  // 'failed' told the sender "no target consumed it" about a note the model
  // saw repeatedly. Only recipients the note never reached (pending) or
  // reached exactly once without confirmation (offered) fail, each with a
  // reason that says which. A message whose every recipient at least
  // acknowledged retires as delivered-unconfirmed instead of dead-lettering.
  let failures = 0, reachedUnconsumed = 0;
  for (const recipientId of known) {
    const state = messageDeliveryState(next, recipientId);
    if (state === 'consumed') continue;
    if (state === 'acknowledged') { reachedUnconsumed++; continue; }
    failures++;
    setDeliveryState(next, recipientId, 'failed', now,
      state === 'pending' ? `${reason} (never delivered)` : `${reason} (offered once, unconfirmed)`);
  }
  if (failures || known.size === 0) {
    next.deadLetter = { state: 'failed', reason, at: now };
  } else {
    next.retiredAt = now;
    if (reachedUnconsumed) next.retirement = { reason: `${reason} — after acknowledgement (delivered, consumption unconfirmed)`, at: now };
  }
  return next;
}

const isTerminalMessage = (message) => Boolean(message?.deadLetter || message?.retiredAt);

function retireFullyConsumed(message, now) {
  if (!message || isTerminalMessage(message)) return message;
  const candidates = [...new Set([
    ...(Array.isArray(message.candidateIds) ? message.candidateIds : []),
    ...(Array.isArray(message.deliveries) ? message.deliveries.map((entry) => entry?.recipientId || entry?.id) : []),
  ].map(recipientKey).filter(Boolean))];
  if (candidates.length && candidates.every((id) => messageDeliveryState(message, id) === 'consumed')) {
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
      message = terminalizeMessage(message, now, 'expired-before-consumption');
    }
    out.push(message);
  }
  return out;
}

export function capMessages(messages, cap = MESSAGE_LANE_CAP, now = Date.now()) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((message) => retireFullyConsumed(normalizeMessageDelivery(message, now), now))
    .filter(Boolean);
  const active = list.filter((message) => !isTerminalMessage(message));
  const excess = Math.max(0, active.length - Math.max(0, Number(cap) || 0));
  // Under bounded capacity, preserve messages that have made the least
  // delivery progress: an acknowledged replay has already reached the model,
  // while a pending note has not. Every eviction is still a visible failed
  // receipt—this ordering prevents a replay from starving unseen work.
  const progressRank = (message) => {
    const recipients = [...new Set([
      ...(message.candidateIds || []),
      ...(message.deliveries || []).map((entry) => entry?.recipientId || entry?.id),
    ].map(recipientKey).filter(Boolean))];
    const states = recipients.map((id) => messageDeliveryState(message, id));
    if (states.includes('pending')) return 2;
    if (states.includes('offered')) return 1;
    return states.includes('acknowledged') ? 0 : 2;
  };
  const overflow = new Set([...active]
    .sort((left, right) => progressRank(left) - progressRank(right)
      || Number(left.ts || 0) - Number(right.ts || 0))
    .slice(0, excess)
    .map((message) => message.id));
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

// Comparison fold for scope coverage checks — mirrors mcp-presence.mjs
// normalizeFileKey's slash/./-prefix/case fold (duplicated because THAT module
// imports THIS one). Coverage must match across spellings: a hook observes
// `src\App.tsx` while brain_sync declared `src/app.tsx`.
const scopeKey = (file) => String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();

// Cap for the observed-scope lane (automatic scope adoption, 1.70.0). Kept as
// its own constant so writers and tests agree on the LRU bound.
export const OBSERVED_FILES_CAP = 20;

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
  // Automatic scope adoption (1.70.0): paths the HOST reported this session
  // editing (hook PostToolUse / codex tool events) — observations, never
  // declarations. A path already covered by the row's DECLARED scope is
  // ignored (the declaration is the higher-confidence claim); anything else
  // joins `observedFiles` (LRU, cap OBSERVED_FILES_CAP) AND the legacy
  // `files` union so pre-1.70 readers keep their overlap coverage. The
  // `observedFiles` marker is what lets every 1.70+ reader state the
  // observed/declared distinction instead of mistaking a live edit for a
  // declared scope.
  observedFiles,
  event = null,
  channel = null,
  transportStatus = null,
  cwd = null,
  hostPid = null,
  hostPidSource = null,
  logicalSessionId = null,
  identitySource = null,
  aliases,
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
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return withWriteVerdict([], false, laneRead.reason);
    const data = laneRead.data;
    let endedSessions = pruneEndedSessions(data.endedSessions, now);
    const ended = endedSessions.find((row) => endedMatches(row, id));
    const explicitRevival = /^(?:SessionStart|UserPromptSubmit|McpTaskStart)$/i.test(String(event || ''));
    if (ended && !explicitRevival) {
      return withWriteVerdict(pruneSessions(data.sessions, now), false, 'session-ended');
    }
    if (ended && explicitRevival) endedSessions = endedSessions.filter((row) => !endedMatches(row, id));
    const sessions = pruneSessions(data.sessions, now);
    const previous = sessions.find((session) => session.id === id) || {};
    const channelSeen = freshChannelSeen(previous.channelSeen, now);
    if (channel) channelSeen[String(channel)] = now;
    const transport = normalizeTransport(previous.transport, channelSeen);
    const channelOwners = normalizeChannelOwners(previous.channelOwners, channelSeen);
    if (channel) {
      const status = transportStatus
        || (String(channel) === 'mcp' && String(event || '') === 'McpHibernated' ? 'pull-only' : 'connected');
      transport[String(channel)] = { status: String(status).slice(0, 40), at: now };
      channelOwners[String(channel)] = process.pid;
    }
    let mergedFiles = files === undefined
      ? normalizeFiles(previous.files)
      : normalizeFiles(replaceFiles ? files : [...(previous.files || []), ...(files || [])]);
    // ── Observed-scope maintenance (automatic scope adoption, 1.70.0) ────────
    // `files` arrivals are DECLARATIONS (brain_sync). A path the declaration
    // now names sheds its observed marker — the claim was upgraded, never
    // duplicated. A declaration NOT covering an observed path leaves the
    // marker alone (replaceFiles/completion clears declared scope only:
    // the 1.69.0 completion guard must never erase what a session was
    // OBSERVED editing — those edits are still real in the worktree).
    const prevObserved = normalizeFiles(previous.observedFiles);
    const declarationKeys = files !== undefined
      ? new Set(normalizeFiles(files).map(scopeKey))
      : null;
    let nextObserved = declarationKeys
      ? prevObserved.filter((file) => !declarationKeys.has(scopeKey(file)))
      : prevObserved;
    if (observedFiles !== undefined) {
      // Declared coverage = files minus observed markers (observed paths ride
      // in `files` too, for pre-1.70 readers — they are not declarations).
      const observedKeys = new Set(nextObserved.map(scopeKey));
      const declaredCovered = new Set(mergedFiles.map(scopeKey).filter((key) => !observedKeys.has(key)));
      for (const file of normalizeFiles(observedFiles)) {
        const key = scopeKey(file);
        if (declaredCovered.has(key)) continue;   // declared scope covers it — nothing to adopt
        nextObserved = nextObserved.filter((existing) => scopeKey(existing) !== key);
        nextObserved.push(file);                  // LRU: a re-observation moves to the tail
        if (!mergedFiles.some((existing) => scopeKey(existing) === key)) mergedFiles.push(file);
      }
      // Cap pressure evicts OBSERVATIONS, never declarations (review-caught,
      // 1.70.0): normalizeFiles' plain slice(-20) let an observation flood push
      // a session's DECLARED files out of files[] — peers silently lost
      // blocking coverage on declared work, and a later re-edit of the evicted
      // path re-entered it as observed, rendering an owned scope as
      // `*`-unconfirmed. Declarations keep the tail (slice keeps newest); the
      // observations fill whatever room remains, oldest evicted first.
      if (mergedFiles.length > 20) {
        const observedKeySet = new Set(nextObserved.map(scopeKey));
        const declared = mergedFiles.filter((file) => !observedKeySet.has(scopeKey(file)));
        const observed = mergedFiles.filter((file) => observedKeySet.has(scopeKey(file)));
        mergedFiles = [...observed.slice(-Math.max(0, 20 - declared.length)), ...declared];
      }
      mergedFiles = normalizeFiles(mergedFiles);
    }
    nextObserved = nextObserved.slice(-OBSERVED_FILES_CAP);
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
    const taskStarted = /^McpTaskStart$/i.test(String(event || ''));
    const taskCompleted = /^McpTaskComplete$/i.test(String(event || ''));
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
      // ADDITIVE observed lane: written only for rows that ever carried it, so
      // pre-1.70 rows stay byte-stable through a touch that changes nothing.
      ...(nextObserved.length || previous.observedFiles !== undefined
        ? { observedFiles: nextObserved }
        : {}),
      event: event ?? previous.event ?? null,
      ...(activityEvent
        ? { activityAt: now, activityKind: activityEvent }
        : (previous.activityAt ? { activityAt: previous.activityAt, activityKind: previous.activityKind || null } : {})),
      ...(Object.keys(channelSeen).length
        ? {
          channels: Object.keys(channelSeen),
          channelSeen,
          transport,
          channelOwners,
          deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
        }
        : {}),
      cwd: cwd ? path.resolve(cwd) : (previous.cwd || path.dirname(brainPath)),
      // Host-process correlation is diagnostic topology only. A desktop parent
      // can own many chats, so hostPid must never imply identity or deduping.
      hostPid: Number(hostPid) || previous.hostPid || null,
      // Provenance of the pid decides what it may be used for: 'env' (declared
      // by the host itself, safe to liveness-probe) vs 'ppid' (a best-effort
      // parent guess, correlation only). ADDITIVE — absent means unknown, and
      // unknown is never probed. Kept aligned with the pid it describes: a new
      // pid without a declared source resets the field rather than inheriting
      // the previous pid's provenance.
      hostPidSource: Number(hostPid)
        ? (hostPidSource ? String(hostPidSource).slice(0, 16)
          : (Number(hostPid) === Number(previous.hostPid) ? previous.hostPidSource || null : null))
        : previous.hostPidSource || null,
      logicalSessionId: recipientKey(logicalSessionId || previous.logicalSessionId || '') || null,
      identitySource: String(identitySource || previous.identitySource || 'provisional').slice(0, 80),
      aliases: normalizeAliases(aliases === undefined ? previous.aliases : [...(previous.aliases || []), ...(aliases || [])], id),
      machine: MACHINE_ID,
      startedAt: previous.startedAt || now,
      ...(taskStarted
        ? {
          scopeGeneration: Math.max(0, Number(previous.scopeGeneration || 0)) + 1,
          scopeStartedAt: now,
          completedAt: null,
        }
        : {
          ...(previous.scopeGeneration ? { scopeGeneration: previous.scopeGeneration } : {}),
          ...(previous.scopeStartedAt ? { scopeStartedAt: previous.scopeStartedAt } : {}),
          ...(taskCompleted ? { completedAt: now } : (previous.completedAt ? { completedAt: previous.completedAt } : {})),
        }),
      lastSeen: now,
    };
    const kept = sessions.filter((session) => session.id !== id);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      messages: maintainMessages(data.messages, now),
      endedSessions,
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
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return withWriteVerdict([], false, laneRead.reason);
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    for (const row of rows) {
      if (!row?.id || !row.machine || row.via !== 'cloud') continue;
      if (String(row.machine) === String(machineId)) continue;   // never a remote row for this machine
      const existingIdx = sessions.findIndex((session) => session.id === row.id);
      if (existingIdx >= 0 && sessions[existingIdx].via !== 'cloud') continue;   // local row wins
      const previous = existingIdx >= 0 ? sessions[existingIdx] : {};
      // REPLACE semantics, like `files` below: the frame is a full snapshot of
      // the sender's row, so an empty/absent observed lane must CLEAR the
      // mirror. The `...previous` spread otherwise pinned a completed remote
      // task's stale markers to the local mirror forever (review-caught
      // 1.70.0) — remote rows carry no completedAt, so no local gate could
      // ever retire them.
      const remoteObserved = normalizeFiles(row.observedFiles).slice(-OBSERVED_FILES_CAP);
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
        // Observed/declared distinction crosses machines too (additive — an old
        // sender simply never populates it; see remoteObserved above for the
        // replace-not-merge rule).
        ...(remoteObserved.length ? { observedFiles: remoteObserved } : {}),
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
      // The `...previous` spread carried any stale marker into `next`; an empty
      // snapshot clears it (see the replace-not-merge rule above).
      if (!remoteObserved.length) delete next.observedFiles;
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
// (symmetric consent, P9). This is the serializable result contract used by the
// desktop bridge: cloud-sourced session rows AND cross-computer notes are purged
// under one lane lock. Local sessions/messages are preserved byte-for-byte apart
// from normal expiry maintenance. A lock failure is explicit so the caller can
// retry instead of falsely reporting that revocation completed.
export function purgeRemotePresence({ brainPath, home, now = Date.now() }) {
  if (!brainPath) return {
    laneWriteOk: false,
    reason: 'no-brain',
    sessions: [],
    purgedSessions: 0,
    purgedMessages: 0,
  };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return {
    laneWriteOk: false,
    reason: 'lane-locked',
    sessions: listActiveSessions({ brainPath, home, now }),
    purgedSessions: 0,
    purgedMessages: 0,
  };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return {
      laneWriteOk: false,
      reason: laneRead.reason,
      sessions: [],
      purgedSessions: 0,
      purgedMessages: 0,
    };
    const data = laneRead.data;
    const maintainedSessions = pruneSessions(data.sessions, now);
    const sessions = maintainedSessions.filter((session) => session.via !== 'cloud');
    const maintainedMessages = maintainMessages(data.messages, now);
    const messages = maintainedMessages.filter((message) =>
      !String(message?.dedupeKey || '').startsWith(REMOTE_MESSAGE_DEDUPE_PREFIX));
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions,
      messages,
    }));
    return {
      laneWriteOk: true,
      reason: null,
      sessions,
      purgedSessions: maintainedSessions.length - sessions.length,
      purgedMessages: maintainedMessages.length - messages.length,
    };
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

// Backward-compatible array API retained for existing local callers. It now
// inherits the stronger purge semantics; new IPC callers should prefer the
// explicit, serializable purgeRemotePresence() receipt above.
export function purgeRemoteSessions(args) {
  const result = purgeRemotePresence(args);
  return withWriteVerdict(result.sessions, result.laneWriteOk, result.reason);
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
  if (!brainPath || !id) return withWriteVerdict([], false, 'no-brain-or-id');
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return withWriteVerdict(listActiveSessions({ brainPath, home, now }), false, 'lane-locked');
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return withWriteVerdict([], false, laneRead.reason);
    const data = laneRead.data;
    const sessions = [];
    for (const session of pruneSessions(data.sessions, now)) {
      if (session.id !== id) {
        sessions.push(session);
        continue;
      }
      const owners = normalizeChannelOwners(session.channelOwners, session.channelSeen);
      const ownedPid = channel ? (owners[String(channel)] || session.pid) : session.pid;
      if (expectedPid !== null && Number(ownedPid) !== Number(expectedPid)) {
        sessions.push(session);
        continue;
      }
      if (!channel || !session.channelSeen || typeof session.channelSeen !== 'object') continue;
      const channelSeen = freshChannelSeen(session.channelSeen, now);
      delete channelSeen[String(channel)];
      const transport = normalizeTransport(session.transport, channelSeen);
      const channelOwners = normalizeChannelOwners(owners, channelSeen);
      const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
      if (!seenValues.length) continue;
      sessions.push({
        ...session,
        channels: Object.keys(channelSeen),
        channelSeen,
        transport,
        channelOwners,
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
    return withWriteVerdict(sessions, true);
  } finally {
    if (gotLock) releaseLock(lockFile);
  }
}

// Authoritative lifecycle close. Unlike removeSession(channel), this removes
// every transport for the logical session and leaves a short-lived tombstone so
// a passive heartbeat from an old MCP worker cannot recreate a ghost row.
export function endSession({ brainPath, id, home, now = Date.now(), expectedPid = null }) {
  if (!brainPath || !id) return { ok: false, changed: false, reason: 'no-brain-or-id', sessions: [] };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return {
    ok: false,
    changed: false,
    reason: 'lane-locked',
    sessions: listActiveSessions({ brainPath, home, now }),
  };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, changed: false, reason: laneRead.reason, sessions: [] };
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const row = sessions.find((session) => session.id === id
      || normalizeAliases(session.aliases).includes(recipientKey(id)));
    if (row && expectedPid !== null) {
      const owners = normalizeChannelOwners(row.channelOwners, row.channelSeen);
      const owner = owners.lifecycle || row.pid;
      if (Number(owner) !== Number(expectedPid)) {
        return { ok: false, changed: false, reason: 'owner-mismatch', sessions };
      }
    }
    const identities = [...new Set([
      recipientKey(id),
      recipientKey(row?.id),
      ...normalizeAliases(row?.aliases),
    ].filter(Boolean))];
    let endedSessions = pruneEndedSessions(data.endedSessions, now)
      .filter((ended) => !identities.some((identity) => endedMatches(ended, identity)));
    endedSessions.push({ id: recipientKey(row?.logicalSessionId || row?.id || id), endedAt: now,
      aliases: normalizeAliases(identities, row?.logicalSessionId || row?.id || id) });
    endedSessions = endedSessions.slice(-ENDED_SESSION_CAP);
    // The sweep also removes transport twins that never completed id adoption:
    // an mcp-<pid> row whose logicalSessionId names the ended identity IS this
    // session and must not linger until its own TTL. Rotation stays safe — a
    // NEW conversation created after SessionEnd(A) carries its OWN id as
    // logicalSessionId (rotateEndedSessionIdentity sets logicalSessionId=toKey
    // and never aliases A), so it can never match A's identity set here.
    const kept = sessions.filter((session) => !identities.includes(recipientKey(session.id))
      && !normalizeAliases(session.aliases).some((alias) => identities.includes(alias))
      && !(session.logicalSessionId && identities.includes(recipientKey(session.logicalSessionId))));
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: kept,
      messages: maintainMessages(data.messages, now),
      endedSessions,
    }));
    return { ok: true, changed: kept.length !== sessions.length, reason: null, sessions: kept };
  } finally {
    releaseLock(lockFile);
  }
}

// ── Release lease (1.70.0 measured wave) ────────────────────────────────────
// One EXCLUSIVE per-project release-preparation record in the same lane file
// every presence reader already parses. First declarer takes it; a second
// declarer gets a hard conflict naming the holder+version+ref. The lease is
// bounded three ways, all reusing the lane's existing liveness machinery:
//   • TTL (~2h) refreshed by the holder's checkpoints — a stalled release
//     cannot squat on the project forever;
//   • freed explicitly when the holder's task truly completes;
//   • freed implicitly when the holder stops being a live lane session
//     (TTL pruning + dead-host sweep, via pruneSessions) — a crashed holder
//     never blocks the next release engineer.
// The stored record is additive lane state: every existing mutator spreads
// `...data` on write, so the key survives session/message maintenance, and
// old readers simply ignore it.
export const RELEASE_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

const releaseLeaseVersionKey = (value) => String(value || '').trim().replace(/^v/i, '').slice(0, 64);
const releaseLeaseRefKey = (value) => String(value || '').trim().slice(0, 200);

function normalizeReleaseLease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const holderId = recipientKey(raw.holderId);
  const version = releaseLeaseVersionKey(raw.version);
  const ref = releaseLeaseRefKey(raw.ref);
  const takenAt = Number(raw.takenAt || 0);
  const refreshedAt = Number(raw.refreshedAt || raw.takenAt || 0);
  if (!holderId || !version || !ref || !takenAt || !refreshedAt) return null;
  const ttlMs = Math.max(60_000, Number(raw.ttlMs) || RELEASE_LEASE_TTL_MS);
  const acknowledgedShas = [...new Set((Array.isArray(raw.acknowledgedShas) ? raw.acknowledgedShas : [])
    .map((x) => String(x || '').trim().toLowerCase())
    .filter((x) => /^[0-9a-f]{4,40}$/.test(x)))].slice(0, 2048);
  return {
    holderId,
    holderClient: String(raw.holderClient || 'unknown').slice(0, 40),
    version,
    ref,
    takenAt,
    refreshedAt,
    ttlMs,
    expiresAt: refreshedAt + ttlMs,
    ...(acknowledgedShas.length ? { acknowledgedShas } : {}),
  };
}

// The holder may have rotated ids since taking the lease — match against the
// same identity set message routing uses (id, logical id, aliases).
const sessionOwnsLease = (session, holderId) => {
  const key = recipientKey(holderId);
  return Boolean(key && session && (recipientKey(session.id) === key
    || recipientKey(session.logicalSessionId) === key
    || normalizeAliases(session.aliases).includes(key)));
};

// Verdict for a stored lease against pre-PRUNED sessions (the caller must pass
// pruneSessions output so TTL pruning and the dead-host sweep both apply):
// { status: 'active' | 'expired' | 'dead-holder', lease } or null (no/invalid
// record). Only 'active' binds anyone; the other verdicts are reclaimable.
export function releaseLeaseVerdict(rawLease, sessions, now = Date.now()) {
  const lease = normalizeReleaseLease(rawLease);
  if (!lease) return null;
  if (now >= lease.expiresAt) return { status: 'expired', lease };
  const alive = (Array.isArray(sessions) ? sessions : [])
    .some((session) => sessionOwnsLease(session, lease.holderId));
  return { status: alive ? 'active' : 'dead-holder', lease };
}

// Read-only: the ACTIVE lease or null. Lock-free like every other read surface
// (atomic lane writes guarantee a parseable snapshot).
export function readReleaseLease({ brainPath, home, now = Date.now() } = {}) {
  if (!brainPath) return null;
  const lane = readLane(laneFileFor(brainPath, home));
  const verdict = releaseLeaseVerdict(lane.releaseLease, pruneSessions(lane.sessions, now), now);
  return verdict?.status === 'active' ? verdict.lease : null;
}

// Shared lock/read/verdict/write skeleton for the three mutators. `mutate`
// returns { write, lease, outcome }: lease === null deletes the record,
// undefined leaves it untouched. Sessions/messages bytes are preserved as-is —
// a lease mutation must never race presence maintenance into data loss.
function mutateReleaseLease({ brainPath, home, now, mutate }) {
  if (!brainPath) return { ok: false, status: 'no-brain' };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  if (!acquireLock(lockFile)) return { ok: false, status: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, status: laneRead.reason };
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const verdict = releaseLeaseVerdict(data.releaseLease, sessions, now);
    const result = mutate({ data, sessions, verdict });
    if (result.write) {
      const next = { ...data };
      if (result.lease === null) delete next.releaseLease;
      else if (result.lease !== undefined) next.releaseLease = result.lease;
      fs.mkdirSync(path.dirname(laneFile), { recursive: true });
      writeLaneFileAtomic(laneFile, JSON.stringify(next));
    }
    return result.outcome;
  } finally {
    releaseLock(lockFile);
  }
}

const leaseHeldBy = (verdict, sessions, callerId) => {
  if (!verdict) return false;
  const me = sessions.find((session) => recipientKey(session.id) === callerId) || null;
  return recipientKey(verdict.lease.holderId) === callerId
    || sessionOwnsLease(me, verdict.lease.holderId);
};

// First-declarer-wins exclusive take. Same holder re-declaring refreshes (and
// may retarget version/ref); an expired or dead-holder record is reclaimed with
// the reason surfaced; a live foreign holder is a hard conflict carrying the
// full holder record so the caller can name it.
export function declareReleaseLease({
  brainPath,
  sessionId,
  version,
  ref,
  client = 'unknown',
  home,
  now = Date.now(),
  ttlMs = RELEASE_LEASE_TTL_MS,
  // Shas this declaration acknowledged away (ancestry + claims). PERSISTED on
  // the lease so a holder's refresh does not have to re-litigate them: without
  // this, the natural refresh pattern — keep attaching the same releaseIntent —
  // was refused on the very claim the holder had already acknowledged, the
  // else-chain skipped the refresh, and the lease starved mid-build: the exact
  // failure the lease-loss warning exists for, rebuilt by the claims gate
  // (2026-08-17 review blocker B1, found independently by all four lenses).
  acknowledgedShas = [],
}) {
  const holderId = recipientKey(sessionId);
  const nextVersion = releaseLeaseVersionKey(version);
  const nextRef = releaseLeaseRefKey(ref);
  if (!holderId || !nextVersion || !nextRef) return { ok: false, status: 'invalid-release-intent' };
  return mutateReleaseLease({ brainPath, home, now, mutate: ({ sessions, verdict }) => {
    const mine = leaseHeldBy(verdict, sessions, holderId);
    if (verdict?.status === 'active' && !mine) {
      return { write: false, outcome: { ok: false, status: 'conflict', holder: verdict.lease } };
    }
    const stillMine = mine && verdict?.status === 'active';
    // Union with what the held lease already acknowledged — a re-declare with a
    // NEW acknowledgement must extend the record, never erase the history that
    // keeps the holder's refresh from re-refusing.
    const priorAcks = stillMine && Array.isArray(verdict.lease.acknowledgedShas)
      ? verdict.lease.acknowledgedShas : [];
    const acks = [...new Set([...priorAcks, ...(Array.isArray(acknowledgedShas) ? acknowledgedShas : [])]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter((x) => /^[0-9a-f]{4,40}$/.test(x)))].slice(0, 2048);
    const stored = {
      schemaVersion: 1,
      holderId,
      holderClient: String(client || 'unknown').slice(0, 40),
      version: nextVersion,
      ref: nextRef,
      takenAt: stillMine ? verdict.lease.takenAt : now,
      refreshedAt: now,
      ttlMs: Math.max(60_000, Number(ttlMs) || RELEASE_LEASE_TTL_MS),
      ...(acks.length ? { acknowledgedShas: acks } : {}),
    };
    const reclaimed = !stillMine && verdict ? verdict.status : null;
    return {
      write: true,
      lease: stored,
      outcome: {
        ok: true,
        status: stillMine ? 'refreshed' : 'taken',
        ...(reclaimed && reclaimed !== 'active' ? { reclaimed } : {}),
        lease: normalizeReleaseLease(stored),
      },
    };
  } });
}

// Checkpoint refresh: only the live holder advances refreshedAt. A stale
// record (expired / dead holder) found by ANY caller is pruned so readers stop
// parsing it — the lane's dead-session sweep analogue for this key.
export function refreshReleaseLease({ brainPath, sessionId, home, now = Date.now() }) {
  const callerId = recipientKey(sessionId);
  if (!callerId) return { ok: false, status: 'no-session' };
  // Lock-free fast path: this runs on EVERY non-completing sync of every
  // session, and almost always there is no lease at all. Skipping the lane
  // lock then keeps lease bookkeeping from doubling lock traffic project-wide.
  // Race-safe: a lease declared concurrently is simply refreshed on the
  // caller's NEXT sync, and a just-declared lease is by definition fresh.
  if (brainPath && readLane(laneFileFor(brainPath, home)).releaseLease === undefined) {
    return { ok: true, status: 'no-lease' };
  }
  return mutateReleaseLease({ brainPath, home, now, mutate: ({ sessions, verdict }) => {
    if (!verdict) return { write: false, outcome: { ok: true, status: 'no-lease' } };
    const mine = leaseHeldBy(verdict, sessions, callerId);
    if (verdict.status !== 'active') {
      return {
        write: true,
        lease: null,
        outcome: { ok: true, status: mine ? 'lease-lost' : 'stale-pruned', reason: verdict.status },
      };
    }
    if (!mine) return { write: false, outcome: { ok: true, status: 'not-holder' } };
    const stored = {
      schemaVersion: 1,
      holderId: verdict.lease.holderId,
      holderClient: verdict.lease.holderClient,
      version: verdict.lease.version,
      ref: verdict.lease.ref,
      takenAt: verdict.lease.takenAt,
      refreshedAt: now,
      ttlMs: verdict.lease.ttlMs,
    };
    return {
      write: true,
      lease: stored,
      outcome: { ok: true, status: 'refreshed', lease: normalizeReleaseLease(stored) },
    };
  } });
}

// Explicit free — the holder's real task completion. A non-holder can never
// free a LIVE peer's lease, but anyone may clear a stale record.
export function freeReleaseLease({ brainPath, sessionId, home, now = Date.now() }) {
  const callerId = recipientKey(sessionId);
  if (!callerId) return { ok: false, status: 'no-session' };
  // Same lock-free fast path as refreshReleaseLease: every real completion
  // calls this, and almost none of them hold a lease. Race-safe for the same
  // reason — a record this snapshot cannot see is one this caller cannot own.
  if (brainPath && readLane(laneFileFor(brainPath, home)).releaseLease === undefined) {
    return { ok: true, status: 'no-lease' };
  }
  return mutateReleaseLease({ brainPath, home, now, mutate: ({ sessions, verdict }) => {
    if (!verdict) return { write: false, outcome: { ok: true, status: 'no-lease' } };
    const mine = leaseHeldBy(verdict, sessions, callerId);
    if (!mine && verdict.status === 'active') {
      return { write: false, outcome: { ok: true, status: 'not-holder' } };
    }
    return {
      write: true,
      lease: null,
      outcome: { ok: true, status: mine ? 'released' : 'stale-pruned', lease: verdict.lease },
    };
  } });
}

// ── Release claims — "my commits ride the next build", surviving session exit ─
//
// The presence half of the release gate dies with its session: rows age out in
// ~10 minutes, after which a dropped commit reverts to an anonymous sha, and a
// commit on a branch NO live session is on never enters the ancestry comparison
// at all. Field shape (2026-08-17, founder-surfaced): a session promises "you'll
// see it in the next build", closes, and the next release passes every gate
// while silently leaving that work behind — the exact v1.3.120 failure, one
// session-lifetime later. A claim is that promise made DURABLE: shas + owner +
// note, persisted in the lane, checked against EVERY releaseIntent ref until it
// is fulfilled, withdrawn, or expires.
//
// Deliberately NOT a lease: claims never conflict with each other, any number
// may coexist, and fulfilment is mechanical (the shas are contained in the
// release ref). Same identity model as the lease (a claim survives id rotation
// via the logical-session match), same atomic lane write, same fail-loud
// bounding — a store the gate depends on must never silently drop an entry.
export const RELEASE_CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const RELEASE_CLAIMS_MAX = 32;
export const RELEASE_CLAIM_SHAS_MAX = 20;

const claimSha = (value) => {
  const s = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{4,40}$/.test(s) ? s : null;
};

function normalizeReleaseClaim(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ownerId = recipientKey(raw.ownerId);
  const shas = [...new Set((Array.isArray(raw.shas) ? raw.shas : []).map(claimSha).filter(Boolean))]
    .slice(0, RELEASE_CLAIM_SHAS_MAX);
  const stakedAt = Number(raw.stakedAt || 0);
  if (!ownerId || !shas.length || !stakedAt) return null;
  const expiresAt = Number(raw.expiresAt || 0) || (stakedAt + RELEASE_CLAIM_TTL_MS);
  if (now >= expiresAt) return null;
  return {
    ownerId,
    ownerClient: String(raw.ownerClient || 'unknown').slice(0, 40),
    ownerLogicalId: recipientKey(raw.ownerLogicalId) || null,
    branch: String(raw.branch || '').slice(0, 120) || null,
    note: String(raw.note || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null,
    shas,
    stakedAt,
    expiresAt,
  };
}

const liveReleaseClaims = (raw, now = Date.now()) => (Array.isArray(raw) ? raw : [])
  .map((c) => normalizeReleaseClaim(c, now))
  .filter(Boolean);

// A claim belongs to the caller when any identity in the caller's set matches
// the identity the claim recorded — the same rotation-tolerant rule the lease
// uses, because "the same conversation after /clear" must still own its claim.
const sessionOwnsClaim = (claim, sessions, callerId) => {
  const key = recipientKey(callerId);
  if (!key || !claim) return false;
  if (claim.ownerId === key || claim.ownerLogicalId === key) return true;
  const me = (Array.isArray(sessions) ? sessions : [])
    .find((s) => recipientKey(s.id) === key) || null;
  if (!me) return false;
  const mine = new Set([recipientKey(me.id), recipientKey(me.logicalSessionId),
    ...normalizeAliases(me.aliases).map(recipientKey)].filter(Boolean));
  return mine.has(claim.ownerId) || (claim.ownerLogicalId && mine.has(claim.ownerLogicalId));
};

function mutateReleaseClaims({ brainPath, home, now, mutate }) {
  if (!brainPath) return { ok: false, status: 'no-brain' };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  if (!acquireLock(lockFile)) return { ok: false, status: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, status: laneRead.reason };
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const claims = liveReleaseClaims(data.releaseClaims, now);
    const result = mutate({ data, sessions, claims });
    if (result.write) {
      const next = { ...data };
      if (!result.claims || !result.claims.length) delete next.releaseClaims;
      else next.releaseClaims = result.claims;
      fs.mkdirSync(path.dirname(laneFile), { recursive: true });
      writeLaneFileAtomic(laneFile, JSON.stringify(next));
    }
    return result.outcome;
  } finally {
    releaseLock(lockFile);
  }
}

// Stake (or extend) this session's claim. One claim per owner: re-staking
// UNIONS the shas and refreshes note/expiry, so a session adding a second
// commit does not spawn a second entry. The lane bound fails LOUD — silently
// dropping a claim the gate depends on is the 1.74.0 livelock lesson applied
// to a different store.
export function stakeReleaseClaim({ brainPath, sessionId, client, logicalSessionId, branch, shas, note, home, now = Date.now() }) {
  const ownerId = recipientKey(sessionId);
  const cleanShas = [...new Set((Array.isArray(shas) ? shas : []).map(claimSha).filter(Boolean))];
  if (!ownerId) return { ok: false, status: 'no-session' };
  if (!cleanShas.length) return { ok: false, status: 'no-valid-shas' };
  if (cleanShas.length > RELEASE_CLAIM_SHAS_MAX) {
    return { ok: false, status: 'too-many-shas', limit: RELEASE_CLAIM_SHAS_MAX, given: cleanShas.length };
  }
  return mutateReleaseClaims({ brainPath, home, now, mutate: ({ sessions, claims }) => {
    const mineIndex = claims.findIndex((c) => sessionOwnsClaim(c, sessions, ownerId));
    if (mineIndex < 0 && claims.length >= RELEASE_CLAIMS_MAX) {
      return { write: false, outcome: { ok: false, status: 'claims-full', limit: RELEASE_CLAIMS_MAX } };
    }
    const existing = mineIndex >= 0 ? claims[mineIndex] : null;
    // The union must never silently shed a promised sha (review blocker B2 —
    // executed: stake 15 + extend 10 reported 'extended' while 5 promised shas
    // vanished; the v1.3.120 silent-drop class recurring inside its own fix).
    const unionSize = new Set([...(existing?.shas || []), ...cleanShas]).size;
    if (unionSize > RELEASE_CLAIM_SHAS_MAX) {
      return { write: false, outcome: {
        ok: false, status: 'claim-would-overflow',
        limit: RELEASE_CLAIM_SHAS_MAX, existing: (existing?.shas || []).length, adding: cleanShas.length,
      } };
    }
    const merged = {
      ownerId,
      ownerClient: String(client || existing?.ownerClient || 'unknown').slice(0, 40),
      ownerLogicalId: recipientKey(logicalSessionId) || existing?.ownerLogicalId || null,
      branch: String(branch || existing?.branch || '').slice(0, 120) || null,
      note: String(note || existing?.note || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null,
      shas: [...new Set([...(existing?.shas || []), ...cleanShas])],
      stakedAt: existing?.stakedAt || now,
      expiresAt: now + RELEASE_CLAIM_TTL_MS,
    };
    const next = mineIndex >= 0
      ? claims.map((c, i) => (i === mineIndex ? merged : c))
      : [...claims, merged];
    return { write: true, claims: next, outcome: { ok: true, status: mineIndex >= 0 ? 'extended' : 'staked', claim: merged } };
  } });
}

// Withdraw shas from this session's claim (empty/omitted shas = the whole
// claim). Only the owner's identity set can withdraw — a releasing session
// must acknowledge a foreign claim through the gate, never delete it.
export function withdrawReleaseClaim({ brainPath, sessionId, shas, home, now = Date.now() }) {
  const ownerId = recipientKey(sessionId);
  if (!ownerId) return { ok: false, status: 'no-session' };
  const drop = new Set((Array.isArray(shas) ? shas : []).map(claimSha).filter(Boolean));
  return mutateReleaseClaims({ brainPath, home, now, mutate: ({ sessions, claims }) => {
    const mineIndex = claims.findIndex((c) => sessionOwnsClaim(c, sessions, ownerId));
    if (mineIndex < 0) return { write: false, outcome: { ok: true, status: 'no-claim' } };
    const mine = claims[mineIndex];
    const kept = drop.size
      ? mine.shas.filter((s) => ![...drop].some((d) => s.startsWith(d) || d.startsWith(s)))
      : [];
    const next = kept.length
      ? claims.map((c, i) => (i === mineIndex ? { ...mine, shas: kept } : c))
      : claims.filter((_, i) => i !== mineIndex);
    return { write: true, claims: next, outcome: { ok: true, status: kept.length ? 'trimmed' : 'withdrawn', remaining: kept.length } };
  } });
}

// Retire specific (claim owner, shas) pairs after a release FULFILLS them —
// called by the gateway on a granted lease whose ref contains the shas. Whole
// claims disappear only when every sha they carry is fulfilled.
export function retireFulfilledClaims({ brainPath, fulfilled, home, now = Date.now() }) {
  const byOwner = new Map((Array.isArray(fulfilled) ? fulfilled : [])
    .map((f) => [recipientKey(f?.ownerId), new Set((f?.shas || []).map(claimSha).filter(Boolean))]));
  if (!byOwner.size) return { ok: true, status: 'nothing-to-retire' };
  return mutateReleaseClaims({ brainPath, home, now, mutate: ({ claims }) => {
    let changed = false;
    const next = claims.map((c) => {
      const done = byOwner.get(c.ownerId);
      if (!done || !done.size) return c;
      const kept = c.shas.filter((s) => !done.has(s));
      if (kept.length !== c.shas.length) changed = true;
      return kept.length ? { ...c, shas: kept } : null;
    }).filter(Boolean);
    if (!changed) return { write: false, outcome: { ok: true, status: 'nothing-to-retire' } };
    return { write: true, claims: next, outcome: { ok: true, status: 'retired' } };
  } });
}

// Read-only: live claims. Lock-free like every other read surface.
export function readReleaseClaims({ brainPath, home, now = Date.now() } = {}) {
  if (!brainPath) return [];
  return liveReleaseClaims(readLane(laneFileFor(brainPath, home)).releaseClaims, now);
}

// A long-lived MCP worker can observe SessionEnd(A) and then receive the first
// request for a brand-new Codex thread B. That is rotation, not a rekey: A's
// tombstone, scope, message audience/receipts, and authorship must remain bound
// to A. This operation succeeds only when A is still tombstoned and has no live
// row, making it safe to try before the ordinary atomic provisional rekey.
export function rotateEndedSessionIdentity({
  brainPath,
  fromId,
  toId,
  client = 'codex',
  surface = 'mcp',
  cwd = null,
  hostPid = null,
  hostPidSource = null,
  identitySource = 'mcp-request',
  home,
  now = Date.now(),
  expectedPid = process.pid,
}) {
  const fromKey = recipientKey(fromId);
  const toKey = recipientKey(toId);
  if (!brainPath || !fromKey || !toKey || fromKey === toKey) {
    return { ok: false, changed: false, reason: 'invalid-identity-rotation' };
  }
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { ok: false, changed: false, reason: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, changed: false, reason: laneRead.reason };
    const data = laneRead.data;
    const endedSessions = pruneEndedSessions(data.endedSessions, now);
    if (!endedSessions.some((row) => endedMatches(row, fromKey))) {
      return { ok: false, changed: false, reason: 'source-not-ended' };
    }
    if (endedSessions.some((row) => endedMatches(row, toKey))) {
      return { ok: false, changed: false, reason: 'destination-ended' };
    }
    const sessions = pruneSessions(data.sessions, now);
    const sourceStillLive = sessions.some((session) => recipientKey(session.id) === fromKey
      || normalizeAliases(session.aliases).includes(fromKey));
    if (sourceStillLive) return { ok: false, changed: false, reason: 'source-still-live' };

    const existing = sessions.find((session) => recipientKey(session.id) === toKey
      || normalizeAliases(session.aliases).includes(toKey)) || null;
    if (existing?.via === 'cloud') {
      return { ok: false, changed: false, reason: 'destination-remote-only' };
    }
    const channelSeen = freshChannelSeen(existing?.channelSeen, now);
    channelSeen.mcp = now;
    const channelOwners = normalizeChannelOwners(existing?.channelOwners, channelSeen);
    channelOwners.mcp = Number(expectedPid) > 0 ? Number(expectedPid) : process.pid;
    const transport = normalizeTransport(existing?.transport, channelSeen);
    transport.mcp = { status: 'connected', at: now };
    const next = {
      ...(existing || {}),
      id: toKey,
      pid: process.pid,
      project: path.basename(path.dirname(brainPath)),
      client: String(existing?.client || client || 'codex'),
      surface: existing?.surface || surface || 'mcp',
      intent: String(existing?.intent || ''),
      files: normalizeFiles(existing?.files),
      event: 'McpIdentityRotate',
      channels: Object.keys(channelSeen),
      channelSeen,
      channelOwners,
      transport,
      deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
      cwd: cwd ? path.resolve(cwd) : (existing?.cwd || path.dirname(brainPath)),
      hostPid: Number(hostPid) || existing?.hostPid || null,
      hostPidSource: (Number(hostPid) && hostPidSource) ? String(hostPidSource).slice(0, 16)
        : existing?.hostPidSource || null,
      logicalSessionId: toKey,
      identitySource: String(identitySource || 'mcp-request').slice(0, 80),
      // Never attach A as an alias: targeting A after its close must continue
      // to resolve to the tombstone/history, not the new conversation B.
      aliases: normalizeAliases(existing?.aliases, toKey),
      machine: MACHINE_ID,
      startedAt: existing?.startedAt || now,
      lastSeen: now,
    };
    const kept = sessions.filter((session) => session !== existing
      && recipientKey(session.id) !== toKey);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      // Maintenance may expire old messages, but identity rotation never
      // rewrites from/to/candidate/delivery ids from A to B.
      messages: maintainMessages(data.messages, now),
      endedSessions,
    }));
    return { ok: true, changed: true, reason: null, session: next, mode: 'fresh-after-end' };
  } finally {
    releaseLock(lockFile);
  }
}

// Move one long-lived MCP transport from an already-exact logical session A
// to a different exact request identity B without treating the change as a
// provisional rekey. This is the ordering-safe counterpart to
// rotateEndedSessionIdentity(): Codex can deliver B's first MCP request before
// SessionEnd(A) reaches the lifecycle adapter. Under one lane lock we detach
// only this worker's MCP channel from A and create/refresh B from B's own state.
// A's scope, aliases, authorship, message audience, and receipts never flow to
// B; a later SessionEnd(A) can still tombstone A normally.
export function switchMcpSessionIdentity({
  brainPath,
  fromId,
  toId,
  client = 'codex',
  surface = 'mcp',
  cwd = null,
  hostPid = null,
  hostPidSource = null,
  identitySource = 'mcp-request',
  home,
  now = Date.now(),
  expectedPid = process.pid,
}) {
  const fromKey = recipientKey(fromId);
  const toKey = recipientKey(toId);
  if (!brainPath || !fromKey || !toKey || fromKey === toKey) {
    return { ok: false, changed: false, reason: 'invalid-identity-switch' };
  }
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { ok: false, changed: false, reason: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, changed: false, reason: laneRead.reason };
    const data = laneRead.data;
    const endedSessions = pruneEndedSessions(data.endedSessions, now);
    // Ended A is handled by rotateEndedSessionIdentity(), which deliberately
    // retains its tombstone. An ended B must never be revived by a passive MCP
    // request; only an explicit task/session start may do that.
    if (endedSessions.some((row) => endedMatches(row, fromKey))) {
      return { ok: false, changed: false, reason: 'source-ended' };
    }
    if (endedSessions.some((row) => endedMatches(row, toKey))) {
      return { ok: false, changed: false, reason: 'destination-ended' };
    }

    const sessions = pruneSessions(data.sessions, now);
    const from = sessions.find((session) => recipientKey(session.id) === fromKey
      || normalizeAliases(session.aliases).includes(fromKey)) || null;
    const destinationCandidate = sessions.find((session) => recipientKey(session.id) === toKey
      || normalizeAliases(session.aliases).includes(toKey)) || null;
    // A stale alias on A must not turn this fresh switch back into an A→B
    // rekey. Only an independently stored B row may contribute B's own state.
    const existing = destinationCandidate === from ? null : destinationCandidate;
    if (existing?.via === 'cloud') {
      return { ok: false, changed: false, reason: 'destination-remote-only' };
    }

    let retainedFrom = null;
    if (from && from !== existing) {
      const fromSeen = freshChannelSeen(from.channelSeen, now);
      const fromOwners = normalizeChannelOwners(from.channelOwners, fromSeen);
      const ownsMcp = Object.prototype.hasOwnProperty.call(fromSeen, 'mcp');
      const ownedPid = fromOwners.mcp || from.pid;
      if (ownsMcp && expectedPid !== null && Number(ownedPid) !== Number(expectedPid)) {
        return { ok: false, changed: false, reason: 'owner-mismatch' };
      }
      delete fromSeen.mcp;
      const fromTransport = normalizeTransport(from.transport, fromSeen);
      const remainingOwners = normalizeChannelOwners(fromOwners, fromSeen);
      const remainingSeen = Object.values(fromSeen).map(Number).filter(Number.isFinite);
      if (remainingSeen.length) {
        retainedFrom = {
          ...from,
          // B is now an independent exact identity. Remove any stale B alias
          // from A as well, otherwise exact targeting of B becomes ambiguous.
          aliases: normalizeAliases(from.aliases, fromKey).filter((alias) => alias !== toKey),
          channels: Object.keys(fromSeen),
          channelSeen: fromSeen,
          channelOwners: remainingOwners,
          transport: fromTransport,
          deliveryReachability: sessionDeliveryReachability({
            ...from,
            channels: Object.keys(fromSeen),
            channelSeen: fromSeen,
            transport: fromTransport,
          }),
          lastSeen: Math.max(...remainingSeen),
        };
      }
    }

    const channelSeen = freshChannelSeen(existing?.channelSeen, now);
    channelSeen.mcp = now;
    const channelOwners = normalizeChannelOwners(existing?.channelOwners, channelSeen);
    channelOwners.mcp = Number(expectedPid) > 0 ? Number(expectedPid) : process.pid;
    const transport = normalizeTransport(existing?.transport, channelSeen);
    transport.mcp = { status: 'connected', at: now };
    const next = {
      ...(existing || {}),
      id: toKey,
      pid: process.pid,
      project: path.basename(path.dirname(brainPath)),
      client: String(existing?.client || client || 'codex'),
      surface: existing?.surface || surface || 'mcp',
      intent: String(existing?.intent || ''),
      files: normalizeFiles(existing?.files),
      event: 'McpIdentitySwitch',
      channels: Object.keys(channelSeen),
      channelSeen,
      channelOwners,
      transport,
      deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
      cwd: cwd ? path.resolve(cwd) : (existing?.cwd || path.dirname(brainPath)),
      hostPid: Number(hostPid) || existing?.hostPid || null,
      hostPidSource: (Number(hostPid) && hostPidSource) ? String(hostPidSource).slice(0, 16)
        : existing?.hostPidSource || null,
      logicalSessionId: toKey,
      identitySource: String(identitySource || 'mcp-request').slice(0, 80),
      // Even a stale/pre-fix B row must not retain A as a targeting alias.
      aliases: normalizeAliases(existing?.aliases, toKey).filter((alias) => alias !== fromKey),
      machine: MACHINE_ID,
      startedAt: existing?.startedAt || now,
      lastSeen: now,
    };

    const kept = sessions.filter((session) => session !== from && session !== existing
      && recipientKey(session.id) !== fromKey && recipientKey(session.id) !== toKey);
    if (retainedFrom) kept.push(retainedFrom);
    kept.push(next);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({
      ...data,
      sessions: kept.slice(-40),
      // This is a transport switch, never an identity rewrite. A-authored and
      // A-targeted messages remain byte-for-byte bound to A.
      messages: maintainMessages(data.messages, now),
      endedSessions,
    }));
    return { ok: true, changed: true, reason: null, session: next, mode: 'fresh-live-switch' };
  } finally {
    releaseLock(lockFile);
  }
}

const DELIVERY_STATE_RANK = Object.freeze({ failed: 0, pending: 1, offered: 2, acknowledged: 3, consumed: 4 });
const mergeDeliveryRecords = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  const lRank = DELIVERY_STATE_RANK[left.state] ?? 0;
  const rRank = DELIVERY_STATE_RANK[right.state] ?? 0;
  const winner = rRank > lRank ? right : left;
  const loser = winner === right ? left : right;
  return {
    ...loser,
    ...winner,
    recipientId: winner.recipientId || loser.recipientId,
    attempts: Math.max(Number(left.attempts || 0), Number(right.attempts || 0)),
    offeredAt: Math.max(Number(left.offeredAt || 0), Number(right.offeredAt || 0)) || undefined,
    acknowledgedAt: Math.max(Number(left.acknowledgedAt || 0), Number(right.acknowledgedAt || 0)) || undefined,
    consumedAt: Math.max(Number(left.consumedAt || 0), Number(right.consumedAt || 0)) || undefined,
  };
};

export function messageDeliveryReceipt(message, sessionId = '') {
  const requested = recipientKey(sessionId);
  let record = requested ? messageDeliveryRecord(message, requested) : null;
  if (!record && Array.isArray(message?.deliveries)) {
    const offered = message.deliveries.filter((entry) => entry?.offerToken
      && (entry.state === 'offered' || entry.state === 'acknowledged'));
    if (offered.length === 1) record = offered[0];
  }
  if (!record?.offerToken) return null;
  return {
    messageId: recipientKey(message?.id),
    sessionId: recipientKey(record.recipientId || record.id),
    offerToken: String(record.offerToken),
    deliveryState: DELIVERY_STATES.has(record.state) ? record.state : 'pending',
  };
}

const rewriteMessageIdentity = (raw, fromId, toId, now) => {
  const message = normalizeMessageDelivery(raw, now);
  if (!message) return null;
  const rewrite = (value) => recipientKey(value) === fromId ? toId : recipientKey(value);
  message.from = rewrite(message.from);
  if (recipientKey(message.to) === fromId) message.to = toId;
  message.candidateIds = [...new Set((Array.isArray(message.candidateIds) ? message.candidateIds : [])
    .map(rewrite).filter(Boolean))];
  message.seen = [...new Set((Array.isArray(message.seen) ? message.seen : [])
    .map(rewrite).filter(Boolean))];
  const deliveries = new Map();
  for (const rawRecord of message.deliveries || []) {
    const record = normalizeDeliveryRecord(rawRecord);
    if (!record) continue;
    record.recipientId = rewrite(record.recipientId);
    deliveries.set(record.recipientId, mergeDeliveryRecords(deliveries.get(record.recipientId), record));
  }
  message.deliveries = [...deliveries.values()];
  return message;
};

const dedupeRekeyedMessages = (messages, fromId, toId, now) => {
  const byId = new Map();
  for (const raw of Array.isArray(messages) ? messages : []) {
    const message = rewriteMessageIdentity(raw, fromId, toId, now);
    if (!message) continue;
    const previous = byId.get(message.id);
    if (!previous) { byId.set(message.id, message); continue; }
    previous.candidateIds = [...new Set([...(previous.candidateIds || []), ...(message.candidateIds || [])])];
    previous.seen = [...new Set([...(previous.seen || []), ...(message.seen || [])])];
    const deliveries = new Map((previous.deliveries || []).map((record) => [record.recipientId, record]));
    for (const record of message.deliveries || []) {
      deliveries.set(record.recipientId, mergeDeliveryRecords(deliveries.get(record.recipientId), record));
    }
    previous.deliveries = [...deliveries.values()];
  }
  return [...byId.values()];
};

// Atomically adopt a request-provided logical identity. The provisional row,
// any already-existing lifecycle row, and every message receipt are rewritten
// under the same lane lock, so readers never observe a half-rekeyed audience.
export function rekeySessionIdentity({ brainPath, fromId, toId, home, now = Date.now(), expectedPid = null }) {
  const fromKey = recipientKey(fromId);
  const toKey = recipientKey(toId);
  if (!brainPath || !fromKey || !toKey) return { ok: false, changed: false, reason: 'invalid-identity' };
  if (fromKey === toKey) return { ok: true, changed: false, reason: null };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { ok: false, changed: false, reason: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { ok: false, changed: false, reason: laneRead.reason };
    const data = laneRead.data;
    const endedSessions = pruneEndedSessions(data.endedSessions, now);
    if (endedSessions.some((row) => endedMatches(row, toKey))) {
      return { ok: false, changed: false, reason: 'session-ended' };
    }
    const sessions = pruneSessions(data.sessions, now);
    const from = sessions.find((session) => recipientKey(session.id) === fromKey);
    if (!from) return { ok: false, changed: false, reason: 'source-not-found' };
    if (expectedPid !== null) {
      const owners = normalizeChannelOwners(from.channelOwners, from.channelSeen);
      const owner = owners.mcp || from.pid;
      if (Number(owner) !== Number(expectedPid)) return { ok: false, changed: false, reason: 'owner-mismatch' };
    }
    const to = sessions.find((session) => recipientKey(session.id) === toKey) || null;
    const chooseLatest = (field, atField, fallback = null) => {
      if (!to) return from[field] ?? fallback;
      const fromAt = Number(from[atField] || from.lastSeen || 0);
      const toAt = Number(to[atField] || to.lastSeen || 0);
      return (fromAt > toAt ? from[field] : to[field]) ?? (from[field] ?? fallback);
    };
    const channelSeen = {};
    const channelOwners = {};
    const transport = {};
    for (const channel of new Set([...Object.keys(from.channelSeen || {}), ...Object.keys(to?.channelSeen || {})])) {
      const fromSeen = Number(from.channelSeen?.[channel] || 0);
      const toSeen = Number(to?.channelSeen?.[channel] || 0);
      channelSeen[channel] = Math.max(fromSeen, toSeen);
      const source = fromSeen > toSeen ? from : to;
      const owner = normalizeChannelOwners(source?.channelOwners, source?.channelSeen)?.[channel];
      if (owner) channelOwners[channel] = owner;
      const record = source?.transport?.[channel] || from.transport?.[channel] || to?.transport?.[channel];
      if (record) transport[channel] = { ...record, at: Math.max(Number(record.at || 0), channelSeen[channel]) };
    }
    const aliases = normalizeAliases([
      ...(to?.aliases || []),
      ...(from.aliases || []),
      fromKey,
    ], toKey);
    const lastSeen = Math.max(Number(from.lastSeen || 0), Number(to?.lastSeen || 0));
    const activityAt = Math.max(Number(from.activityAt || 0), Number(to?.activityAt || 0));
    const merged = {
      ...from,
      ...(to || {}),
      id: toKey,
      logicalSessionId: toKey,
      identitySource: String(to?.identitySource || from.identitySource || 'rekey').slice(0, 80),
      aliases,
      files: normalizeFiles([...(to?.files || []), ...(from.files || [])]),
      intent: chooseLatest('intent', 'intentAt', ''),
      intentAt: Math.max(Number(from.intentAt || 0), Number(to?.intentAt || 0)) || undefined,
      intentSource: chooseLatest('intentSource', 'intentAt', null),
      event: chooseLatest('event', 'lastSeen', null),
      activityAt: activityAt || undefined,
      activityKind: activityAt === Number(from.activityAt || 0) ? from.activityKind : to?.activityKind,
      channelSeen,
      channels: Object.keys(channelSeen),
      channelOwners,
      transport,
      deliveryReachability: sessionDeliveryReachability({ channels: Object.keys(channelSeen), transport }),
      scopeGeneration: Math.max(Number(from.scopeGeneration || 0), Number(to?.scopeGeneration || 0)) || undefined,
      scopeStartedAt: Math.max(Number(from.scopeStartedAt || 0), Number(to?.scopeStartedAt || 0)) || undefined,
      completedAt: Math.max(Number(from.completedAt || 0), Number(to?.completedAt || 0)) || undefined,
      startedAt: Math.min(...[Number(from.startedAt || 0), Number(to?.startedAt || 0)].filter(Boolean), now),
      lastSeen,
    };
    const kept = sessions.filter((session) => ![fromKey, toKey].includes(recipientKey(session.id)));
    kept.push(merged);
    const messages = maintainMessages(dedupeRekeyedMessages(data.messages, fromKey, toKey, now), now);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions: kept.slice(-40), messages, endedSessions }));
    return { ok: true, changed: true, reason: null, session: merged };
  } finally {
    releaseLock(lockFile);
  }
}

const sessionIdentityKeys = (session) => [...new Set([
  recipientKey(session?.id),
  recipientKey(session?.logicalSessionId),
  ...normalizeAliases(session?.aliases),
].filter(Boolean).map((value) => value.toLowerCase()))];

// Returns the shortest prefix (never under eight characters) that identifies
// one logical row across canonical ids and retained transport aliases.
export function shortestUniqueSessionPrefix(sessions, sessionId, minLength = 8) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const wanted = recipientKey(sessionId).toLowerCase();
  const row = rows.find((candidate) => sessionIdentityKeys(candidate).includes(wanted));
  if (!row) return '';
  const canonical = recipientKey(row.id);
  for (let size = Math.max(8, Number(minLength) || 8); size < canonical.length; size++) {
    const prefix = canonical.slice(0, size).toLowerCase();
    const matches = rows.filter((candidate) => sessionIdentityKeys(candidate)
      .some((key) => key.startsWith(prefix)));
    if (matches.length === 1) return canonical.slice(0, size);
  }
  return canonical;
}

export function resolveMessageTargetIds(message, sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const target = String(message?.to || '').trim().toLowerCase();
  if (!target || target === 'all' || target === '*') return rows.map((row) => String(row.id));

  // Full canonical ids and aliases are accepted only when they resolve to one
  // row. This also makes a retained provisional id useful after atomic rekey.
  const exactIdentity = rows.filter((row) => sessionIdentityKeys(row).includes(target));
  if (exactIdentity.length === 1) return [String(exactIdentity[0].id)];
  if (exactIdentity.length > 1) return [];

  // Prefixes are intentionally fail-closed and require >=8 characters.
  if (target.length >= 8) {
    const prefixMatches = rows.filter((row) => sessionIdentityKeys(row)
      .some((key) => key.startsWith(target)));
    if (prefixMatches.length === 1) return [String(prefixMatches[0].id)];
    if (prefixMatches.length > 1) return [];
  }

  // Human-friendly branch targeting remains, but only exact and unique. Intent,
  // client and surface substring matching are deliberately forbidden.
  const branchMatches = rows.filter((row) => String(row?.branch || '').trim().toLowerCase() === target);
  return branchMatches.length === 1 ? [String(branchMatches[0].id)] : [];
}

function messageTargetsSession(message, session, sessionId, sessions = []) {
  // New writers snapshot the live audience at send time. Treat that snapshot
  // as authoritative so a later-joining chat never receives a stale broadcast.
  // Legacy rows without candidateIds retain dynamic target resolution.
  if (Array.isArray(message?.candidateIds)) {
    const keys = new Set([
      recipientKey(session?.id || sessionId),
      recipientKey(session?.logicalSessionId),
      ...normalizeAliases(session?.aliases),
    ].filter(Boolean));
    return message.candidateIds.map(recipientKey).some((id) => keys.has(id));
  }
  const targetIds = resolveMessageTargetIds(message, sessions.length ? sessions : [session].filter(Boolean));
  return targetIds.includes(String(session?.id || sessionId));
}

// One in-band action advances at most one step. A pending note is offered; a
// later action replays and acknowledges model-context injection. Acknowledged
// notes remain replayable until an adapter explicitly consumes the matching
// message+offer token. No state in this file claims that a human read a note.
export function receiveMessages({
  brainPath,
  sessionId,
  ignoreTexts = [],
  home,
  now = Date.now(),
  actionId = '',
}) {
  if (!brainPath || !sessionId) return withDeliveryWriteVerdict([], false, 'no-brain-or-session');
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return withDeliveryWriteVerdict([], false, 'lane-locked');
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return withDeliveryWriteVerdict([], false, laneRead.reason);
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const me = sessions.find((session) => session.id === sessionId);
    // Receipt state belongs to one live, exact logical row. In particular, a
    // late Codex Pre/PostToolUse event after SessionEnd must not use a retained
    // alias (or a missing row) to offer/acknowledge a closed session's inbox.
    if (!me) return withDeliveryWriteVerdict([], false, 'session-not-live');
    const due = messages.filter((message) => {
      const state = messageDeliveryState(message, sessionId);
      const record = messageDeliveryRecord(message, sessionId);
      return !isTerminalMessage(message)
        && message.from !== sessionId
        // 'acknowledged' re-renders ONLY when there is no action-identity
        // evidence of a third action (no actionId on this call, or a legacy
        // record acknowledged without one). With evidence, the lease pass
        // below retires it as consumed instead of injecting it a third time.
        && (state === 'pending' || state === 'offered'
          || (state === 'acknowledged' && (!actionId || !record?.acknowledgedActionId)))
        && !(state === 'offered' && actionId && record?.offeredActionId === String(actionId))
        && messageTargetsSession(message, me, sessionId, sessions);
    }).sort((left, right) => {
      // Never let an acknowledged-but-not-yet-consumed replay starve a fresh
      // pending note behind the six-message model-context budget.
      const rank = { pending: 0, offered: 1, acknowledged: 2 };
      return (rank[messageDeliveryState(left, sessionId)] ?? 9)
        - (rank[messageDeliveryState(right, sessionId)] ?? 9)
        || Number(left.ts || 0) - Number(right.ts || 0);
    });

    // Suppression is case-sensitive: case can carry file/env/command identity
    // on case-sensitive systems. More importantly, receiveMessages returns one
    // row for every note it advances. Presentation layers may group identical
    // text, but only while preserving every message id + offer token.
    const normText = (message) => String(message.text || '').replace(/\s+/g, ' ').trim();
    const ignored = new Set(ignoreTexts.map((text) => String(text || '').replace(/\s+/g, ' ').trim()));
    const shown = [];
    for (const message of due) {
      const textKey = normText(message);
      // Text-only transcript compatibility can suppress this ONE response, but
      // cannot truthfully fail/ack a message: a peer may have sent identical
      // text. Stable sender ids handle real self-echoes via message.from above.
      if (!textKey || ignored.has(textKey)) continue;
      shown.push(message);
    }

    const delivered = shown.slice(0, 6);
    const advance = new Set(delivered.map((message) => message.id));
    for (const message of messages) {
      if (!advance.has(message.id)) continue;
      const previous = messageDeliveryState(message, sessionId);
      if (previous === 'offered') setDeliveryState(message, sessionId, 'acknowledged', now, null, actionId);
      else if (previous === 'pending') setDeliveryState(message, sessionId, 'offered', now, null, actionId);
      else if (previous === 'acknowledged' && !messageDeliveryRecord(message, sessionId)?.offerToken) {
        setDeliveryState(message, sessionId, 'acknowledged', now, null, actionId);
      }
    }
    // Lease auto-consume (2026-08-13). An acknowledged note was rendered into
    // model context on TWO independent actions; when a THIRD independent
    // action arrives, the model has demonstrably moved on with the note in
    // hand. Retire it as consumed (consumedVia 'auto-lease') instead of
    // replaying it every action for 24h and then dead-lettering a note the
    // model saw repeatedly as "failed" — the old design guaranteed a steady
    // background rate of false-failure receipts from every recipient that
    // cannot (hook-only lanes) or does not copy offer tokens back. The
    // explicit brain_message_receipt remains the only path that can record
    // the stronger claim (consumedVia 'receipt' — "I acted on it").
    // Requires a real, DIFFERENT actionId: with no action identity there is
    // no evidence of a third action, so behavior stays replay-until-receipt.
    if (actionId) {
      for (const message of messages) {
        if (isTerminalMessage(message) || message.from === sessionId) continue;
        const record = messageDeliveryRecord(message, sessionId);
        if (!record || record.state !== 'acknowledged') continue;
        if (!record.acknowledgedActionId || record.acknowledgedActionId === String(actionId)) continue;
        if (!messageTargetsSession(message, me, sessionId, sessions)) continue;
        setDeliveryState(message, sessionId, 'consumed', now, null, actionId);
        record.consumedVia = 'auto-lease';
        retireFullyConsumed(message, now);
      }
    }
    // Persist migration/expiry/dead-letter changes even when the inbox is empty.
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
    return withDeliveryWriteVerdict(delivered, true);
  } catch (error) {
    return withDeliveryWriteVerdict([], false,
      `write-failed:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`);
  } finally {
    releaseLock(lockFile);
  }
}

// Explicit receipt path for adapters that can carry prior offer ids on a later
// inbound action. Pending ids are refused: an adapter cannot acknowledge a note
// it never offered into its model-visible response.
export function acknowledgeMessages({ brainPath, sessionId, messageIds = [], home, now = Date.now(), actionId = '' }) {
  if (!brainPath || !sessionId || !Array.isArray(messageIds) || !messageIds.length) {
    return withDeliveryWriteVerdict([], false, 'invalid-receipt');
  }
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return withDeliveryWriteVerdict([], false, 'lane-locked');
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return withDeliveryWriteVerdict([], false, laneRead.reason);
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const wanted = new Set(messageIds.map(String));
    const acknowledged = [];
    for (const message of messages) {
      const record = messageDeliveryRecord(message, sessionId);
      if (!wanted.has(String(message.id)) || messageDeliveryState(message, sessionId) !== 'offered'
        || (actionId && record?.offeredActionId === String(actionId))) continue;
      setDeliveryState(message, sessionId, 'acknowledged', now, null, actionId);
      acknowledged.push(message.id);
    }
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
    return withDeliveryWriteVerdict(acknowledged, true);
  } catch (error) {
    return withDeliveryWriteVerdict([], false,
      `write-failed:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`);
  } finally {
    releaseLock(lockFile);
  }
}

const receiptResult = (ok, changed, status, reason, messageId, sessionId) => ({
  ok: Boolean(ok),
  changed: Boolean(changed),
  status: String(status),
  reason: reason || null,
  messageId: recipientKey(messageId),
  sessionId: recipientKey(sessionId),
});

const tokensEqual = (left, right) => {
  try {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
};

// Durable explicit consumption receipt. A token is minted per recipient on the
// first offer. Requiring both stable ids and that token prevents one session
// from consuming another session's note or a guessed/truncated target.
export function consumeMessageReceipt({
  brainPath,
  sessionId,
  messageId,
  offerToken,
  home,
  now = Date.now(),
  actionId = '',
}) {
  const recipientId = recipientKey(sessionId);
  const wantedMessageId = recipientKey(messageId);
  if (!brainPath || !recipientId || !wantedMessageId || !offerToken) {
    return receiptResult(false, false, 'rejected', 'invalid-receipt', wantedMessageId, recipientId);
  }
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return receiptResult(false, false, 'retry', 'lane-locked', wantedMessageId, recipientId);
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return receiptResult(false, false, 'retry', laneRead.reason, wantedMessageId, recipientId);
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    // Consumption is authority carried by the recipient's exact live logical
    // row, not by a retained alias or a token from a conversation that ended.
    // Check before normalizing or mutating message state so a late receipt is a
    // byte-for-byte no-op.
    if (!sessions.some((session) => session.id === recipientId)) {
      return receiptResult(false, false, 'rejected', 'session-not-live', wantedMessageId, recipientId);
    }
    const messages = maintainMessages(data.messages, now);
    const message = messages.find((candidate) => recipientKey(candidate?.id) === wantedMessageId);
    if (!message) return receiptResult(false, false, 'rejected', 'message-not-found', wantedMessageId, recipientId);
    const record = messageDeliveryRecord(message, recipientId);
    const state = messageDeliveryState(message, recipientId);
    if (!record || !tokensEqual(record.offerToken, offerToken)) {
      return receiptResult(false, false, 'rejected', 'offer-token-mismatch', wantedMessageId, recipientId);
    }
    if (state === 'consumed') {
      // An auto-leased consumption (the third-action lease in receiveMessages)
      // proves the model moved on with the note in context; an explicit
      // receipt is the STRONGER claim — "I acted on it". Record the upgrade.
      if (record.consumedVia !== 'receipt') {
        record.consumedVia = 'receipt';
        fs.mkdirSync(path.dirname(laneFile), { recursive: true });
        writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
        return receiptResult(true, true, 'consumed', null, wantedMessageId, recipientId);
      }
      return receiptResult(true, false, 'consumed', null, wantedMessageId, recipientId);
    }
    if (state === 'offered') {
      if (!actionId || record.offeredActionId === String(actionId)) {
        return receiptResult(false, false, 'rejected', 'same-action-not-consumable', wantedMessageId, recipientId);
      }
      // One later explicit receipt call is sufficient while preserving both
      // durable milestones: acknowledged model injection, then consumed by the
      // receiving agent action. This still never claims a human read it.
      setDeliveryState(message, recipientId, 'acknowledged', now, null, actionId);
    } else if (state !== 'acknowledged') {
      return receiptResult(false, false, 'rejected', 'delivery-not-acknowledged', wantedMessageId, recipientId);
    }
    setDeliveryState(message, recipientId, 'consumed', now, null, actionId);
    const consumedRecord = messageDeliveryRecord(message, recipientId);
    if (consumedRecord) consumedRecord.consumedVia = 'receipt';
    retireFullyConsumed(message, now);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    writeLaneFileAtomic(laneFile, JSON.stringify({ ...data, sessions, messages }));
    return receiptResult(true, true, 'consumed', null, wantedMessageId, recipientId);
  } catch (error) {
    return receiptResult(false, false, 'retry', `write-failed:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`,
      wantedMessageId, recipientId);
  } finally {
    releaseLock(lockFile);
  }
}

// Non-destructive inbox preview for MCP logging notifications. Unlike
// receiveMessages(), this never advances a delivery state, so a host that
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
  // A long-lived shared MCP worker can outlive SessionEnd(A). Never preview
  // A's queued notes after its live row has been removed: the next thread B
  // must first adopt its own exact request identity and live row.
  if (!me) return [];
  const ignored = new Set(ignoreTexts.map((value) =>
    String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()));
  const shown = [];
  const seenText = new Set();
  for (const message of messages) {
    const state = messageDeliveryState(message, sessionId);
    if (isTerminalMessage(message)
      || message.from === sessionId
      || (state !== 'pending' && state !== 'offered' && state !== 'acknowledged')
      || !messageTargetsSession(message, me, sessionId, sessions)) continue;
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
  // Machine-addressed notifications only (claim owners, ancestry owners): the
  // exact recipient id is KNOWN, and the recipient being offline is the very
  // case the notification exists for — a staked claim outlives its session, so
  // its owner may be gone when the release that drops their work is declared.
  // The message waits directed in the lane (24h TTL, sender-visible dead-letter
  // on expiry) and greets the owner's next session. NEVER set this for
  // hand-typed targets: the exactly-one-live-row refusal below is what keeps an
  // ambiguous prefix from queuing a note nobody will ever receive.
  allowOfflineTarget = false,
}) {
  const body = neutralizeMarkers(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400));
  if (!brainPath || !from || !body) return { posted: false, message: null, reason: 'invalid-message' };
  const laneFile = laneFileFor(brainPath, home);
  const lockFile = laneFile + '.lock';
  const gotLock = acquireLock(lockFile);
  if (!gotLock) return { posted: false, message: null, reason: 'lane-locked' };
  try {
    const laneRead = readMutableLane(laneFile);
    if (!laneRead.ok) return { posted: false, message: null, reason: laneRead.reason };
    const data = laneRead.data;
    const sessions = pruneSessions(data.sessions, now);
    const messages = maintainMessages(data.messages, now);
    const key = String(dedupeKey || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (key) {
      const existing = messages.find((message) => message?.dedupeKey === key);
      if (existing) return { posted: false, message: existing, reason: 'duplicate' };
    }
    const senderId = String(from).slice(0, 160);
    const target = String(to || 'all').replace(/\s+/g, ' ').trim().slice(0, 160) || 'all';
    // Receipt truth must survive peers ending before the sender checks doctor.
    // Snapshot only recipient session ids (already lane metadata) at SEND time;
    // old messages without this additive field retain reconstruction fallback.
    const resolvedTargets = resolveMessageTargetIds({ to: target }, sessions);
    const candidateIds = resolvedTargets
      .filter((id) => id && id !== senderId)
      .map((id) => String(id).slice(0, 160));
    const broadcast = target === 'all' || target === '*';
    // A broadcast with no OTHER live recipient is not a successful handoff.
    // Refuse before constructing/persisting a message so no zero-audience row
    // can later be mistaken for queued or delivered work.
    if (broadcast && candidateIds.length === 0) {
      return { posted: false, message: null, reason: 'no-live-recipients' };
    }
    // A targeted hint that does not resolve to exactly one OTHER live row is
    // unsafe: it may be an ambiguous UUID prefix or duplicated branch. Refuse
    // instead of queuing a note whose visible `to` never had a recipient.
    if (!broadcast && candidateIds.length !== 1) {
      if (!(allowOfflineTarget && candidateIds.length === 0)) {
        return { posted: false, message: null, reason: 'target-not-unique' };
      }
      // Offline machine-known recipient: address the exact id we were handed.
      candidateIds.push(String(target).slice(0, 160));
    }
    const message = {
      id: sha16(`${from}|${to}|${body}|${now}|${crypto.randomBytes(4).toString('hex')}`),
      from: senderId,
      to: target,
      text: body,
      ts: now,
      seen: [],
      deliveryVersion: MESSAGE_DELIVERY_VERSION,
      deliveries: candidateIds.map((recipientId) => ({ recipientId, state: 'pending', attempts: 0 })),
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
    return { posted: true, message, reason: null };
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

// 'mcp'/'unknown' are placeholders (getClientVersion() is optional) — only a
// concretely known client name may VETO a fold; a placeholder stays compatible.
const specificClient = (client) => {
  const value = String(client || '').toLowerCase();
  return value && value !== 'mcp' && value !== 'unknown' ? value : null;
};

// Group live lane rows into LOGICAL sessions for rendering. One conversation
// can hold multiple transport rows when id adoption failed mid-flight (the
// lifecycle id plus an mcp-<pid> provisional). Rendering each row as its own
// session double-counts peers, so the footer merges — but merge order matters:
//   1. exact logical identity (logicalSessionId || id) — always safe;
//   2. pid-assisted fold, ONLY for an mcp-only row with no logical identity
//      that shares machine + hostPid + a compatible client with EXACTLY ONE
//      identity-anchored session. Codex runs many threads below one desktop
//      pid, so any ambiguity fails open as separate sessions (hiding a real
//      peer is worse than showing a twin twice — 2026-07-30 hardening).
// This is a RENDER grouping only: lane rows, identity, message audiences and
// conflict detection are untouched.
export function mergePresenceRows(sessions) {
  const rows = (Array.isArray(sessions) ? sessions : []).filter((row) => row?.id);
  const keyOf = (row) => (recipientKey(row.logicalSessionId) || recipientKey(row.id)).toLowerCase();
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const isAnchored = (group) => group.some((row) => recipientKey(row.logicalSessionId)
    || (Array.isArray(row.channels) && row.channels.includes('lifecycle')));
  const isFoldableOrphan = (group) => group.length === 1
    && group.every((row) => !recipientKey(row.logicalSessionId)
      && row.via !== 'cloud'
      && Number(row.hostPid) > 0
      && row.machine
      && Array.isArray(row.channels) && row.channels.length
      && row.channels.every((channel) => channel === 'mcp'));
  const anchoredKeys = [...groups.keys()].filter((key) => isAnchored(groups.get(key)));
  for (const [key, group] of [...groups.entries()]) {
    if (!isFoldableOrphan(group)) continue;
    const orphan = group[0];
    const candidates = anchoredKeys.filter((anchorKey) => groups.get(anchorKey)?.some((row) => row.machine
      && String(row.machine) === String(orphan.machine)
      && Number(row.hostPid) === Number(orphan.hostPid)
      && (!specificClient(row.client) || !specificClient(orphan.client)
        || specificClient(row.client) === specificClient(orphan.client))));
    if (candidates.length !== 1) continue;   // ambiguous or none → fail open
    groups.get(candidates[0]).push(orphan);
    groups.delete(key);
  }
  return [...groups.values()].map((groupRows) => {
    const primary = groupRows.find((row) => Array.isArray(row.channels) && row.channels.includes('lifecycle'))
      || groupRows.find((row) => recipientKey(row.logicalSessionId))
      || [...groupRows].sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))[0];
    // The freshest declared intent wins across the group's rows — a brain_sync
    // scope declared on the mcp twin must not vanish behind a silent lifecycle
    // row (the twin's channels/scope count TOWARD the session, never hidden).
    const intentRow = [...groupRows]
      .filter((row) => String(row.intent || '').trim())
      .sort((a, b) => Number(b.intentAt || b.lastSeen || 0) - Number(a.intentAt || a.lastSeen || 0))[0] || primary;
    return {
      primary,
      rows: groupRows,
      channels: [...new Set(groupRows.flatMap((row) => Array.isArray(row.channels) ? row.channels : []))],
      lastSeen: Math.max(...groupRows.map((row) => Number(row.lastSeen || 0)), 0),
      intent: String(intentRow.intent || ''),
      intentAt: intentRow.intentAt || null,
      branch: primary.branch || groupRows.map((row) => row.branch).find(Boolean) || null,
    };
  });
}

export function formatPresenceMessage(sessions, selfId, { includeSolo = false, now = Date.now() } = {}) {
  const active = Array.isArray(sessions) ? sessions : [];
  const merged = mergePresenceRows(active);
  const selfKey = recipientKey(selfId);
  const isSelfGroup = (group) => group.rows.some((row) => recipientKey(row.id) === selfKey
    || recipientKey(row.logicalSessionId) === selfKey
    || normalizeAliases(row.aliases).includes(selfKey));
  const others = merged.filter((group) => !isSelfGroup(group));
  if (!includeSolo && !others.length) return '';

  const counts = new Map();
  for (const group of merged) {
    const label = clientLabel(group.primary);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const mix = [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(', ');
  // When transports outnumber logical sessions, say so — folding a twin must
  // never silently understate how many live connections the lane holds.
  const connectionNote = active.length > merged.length
    ? `; ${active.length} connections` : '';
  const lines = [
    `KLYPIX session awareness: ${merged.length} active session${merged.length === 1 ? '' : 's'} on this project (${mix || 'none'}${connectionNote}); ${others.length} other${others.length === 1 ? '' : 's'} besides this chat.`,
  ];
  if (!others.length) {
    lines.push('Saved/recent chat rows are history, not active sessions; a session counts only while an authorized MCP connection or lifecycle adapter has heartbeated in the last 10 minutes.');
    return lines.join('\n');
  }
  lines.push('Other active sessions:');
  // Uniqueness is computed over the merged primaries: UUIDv7 ids started in the
  // same window share a long time prefix, so each shown prefix grows (git
  // short-hash style, floor 8) until it names exactly one session.
  const prefixRows = merged.map((group) => group.primary);
  for (const group of others.slice(0, 8)) {
    const session = group.primary;
    const ageMin = Math.max(0, Math.round((now - Number(group.lastSeen || now)) / 60_000));
    // A heartbeat refreshes lastSeen while carrying an old intent forward — show
    // the INTENT's own age when it meaningfully lags the heartbeat, so a
    // 100-minute-old task line can never read as "what they're doing right now".
    const intentAgeMin = group.intentAt ? Math.max(0, Math.round((now - Number(group.intentAt)) / 60_000)) : null;
    const intentAge = intentAgeMin !== null && intentAgeMin - ageMin > 3 ? ` (intent set ${intentAgeMin}m ago)` : '';
    const details = [
      clientLabel(session),
      group.rows.length > 1 ? `${group.rows.length} connections` : null,
      group.branch ? `branch ${group.branch}` : null,
      group.intent ? `"${String(group.intent).slice(0, 90)}"${intentAge}` : null,
      `${ageMin}m ago`,
    ].filter(Boolean);
    const shortId = shortestUniqueSessionPrefix(prefixRows, session.id) || String(session.id).slice(0, 8);
    lines.push(`- ${shortId}: ${details.join(' | ')}`);
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

export function formatReceivedMessages(messages, now = Date.now(), decay = {}, sessionId = '') {
  if (!Array.isArray(messages) || !messages.length) return '';
  const lines = ['KLYPIX message(s) from another active session:'];
  const groups = new Map();
  for (const message of messages) {
    // Whitespace-only normalization: case can carry file/env/command identity
    // on case-sensitive systems (`src/API.ts` and `src/api.ts` are not the same
    // instruction), so grouping must never case-fold message bodies.
    const normalized = String(message?.text || '').replace(/\s+/g, ' ').trim();
    const key = normalized || `id:${String(message?.id || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  for (const group of groups.values()) {
    const message = group[0];
    const senders = [...new Set(group.map(item => String(item?.from || '?').slice(0, 12)))];
    const senderLabel = senders.length <= 3 ? senders.join(', ') : `${senders.slice(0, 3).join(', ')} +${senders.length - 3}`;
    const oldestTs = Math.min(...group.map(item => Number(item?.ts) || now));
    const ageMin = Math.max(0, Math.round((now - oldestTs) / 60_000));
    lines.push(`- from ${senderLabel} (${ageMin}m ago): ${neutralizeMarkers(String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 400))}`);
    const receipts = group.map((item) => messageDeliveryReceipt(item, sessionId)).filter(Boolean);
    if (receipts.length) {
      lines.push(`  Receipt(s): ${receipts.map((receipt) => `${receipt.messageId}:${receipt.offerToken}`).join(', ')}. After incorporating ${receipts.length === 1 ? 'it' : 'them'}, call brain_message_receipt with each exact message_id and offer_token — that is the ONLY way the sender learns you acted on ${receipts.length === 1 ? 'it' : 'them'}. If you skip it, your next independent action auto-consumes ${receipts.length === 1 ? 'this note' : 'these notes'} and the sender is told only that ${receipts.length === 1 ? 'it was' : 'they were'} auto-consumed.`);
    }
    const info = messageDecayInfo({ ...message, ts: oldestTs }, now, decay);
    if (info) lines.push(`  ${info.stampText}`);
  }
  return lines.join('\n');
}
