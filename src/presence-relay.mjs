// Cross-PC presence relay core — PURE frame logic, no IO of any kind.
//
// Extends the machine-local presence lane (agent-presence.mjs) across machines:
// Dev A's sessions and Dev B's sessions on the same shared brain surface each
// other's declared intent, expected files, and one-line messages. The transport
// (one Supabase Realtime channel per shared brain, keyed by the Brain Sync
// blobId stamped in the brain manifest — brain-sync-core.mjs readCloudLink) is
// OWNED BY THE DESKTOP APP; this module only builds, validates, and merges the
// frames that ride it, so every rule here is unit-testable with a mock channel.
//
// GOVERNING PROPERTIES (do not weaken):
//   1. Presence is ADVISORY and EPHEMERAL. It never blocks, never gates a
//      write, and writes NOTHING to any brain file — its worst failure is a
//      missing or stale advisory, never corruption. This module deliberately
//      imports only node:crypto (test/presence-relay.mjs asserts it): no fs,
//      no network, no brain format API can even be reached from here.
//   2. METADATA ONLY. A frame carries at most: session id, hashed machine id,
//      host label, client, surface, branch, the one-line declared intent,
//      canonical repo-relative expected-file keys, and an informational send
//      time. Never cwd, pid, card text, file contents, diffs, or screen data.
//      buildPresenceFrame constructs by WHITELIST — unknown row fields cannot
//      leak because nothing copies them.
//   3. DEFAULT OFF, symmetric consent. presenceConsentAllows() gates BOTH
//      directions at this seam (relayOutbound / relayInbound): no consent
//      record ⇒ zero outbound frames AND no receive-display of others.
//   4. Receiver-clock truth (P4): a peer's freshness is stamped with the
//      RECEIVER's clock at accept time. frame.sentAt is informational only —
//      a machine with a wrong clock can neither appear permanently fresh nor
//      permanently stale.
//   5. Old clients never crash on new frames (P7): every accept function
//      returns null for an unknown wire version or malformed frame, silently.
import crypto from 'crypto';

export const PRESENCE_WIRE_VERSION = 1;
export const PRESENCE_HEARTBEAT_MS = 60_000;
// Consent record contract (mirrors src/services/screenCloudConsent.ts in the
// desktop app: versioned, revocable, default-off, checked at send time).
export const PRESENCE_CONSENT_VERSION = 1;
export const PRESENCE_CONSENT_PURPOSE = 'session-presence';
export const PRESENCE_CONSENT_SCOPE = 'metadata-only';
// Cross-PC lane-message dedup prefix: also the marker that stops a received
// message from being re-broadcast (loop prevention for the message lane).
export const XPC_DEDUPE_PREFIX = 'xpc:';

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const str = (value, max) => compact(value).slice(0, max);

// Canonical wire form of an expected-file declaration: repo-relative, lowercase,
// forward slashes — the SAME fold mcp-presence.mjs normalizeFileKey applies at
// compare time, applied at SEND time so two machines with different clone roots
// ("E:/work/repo" vs "/home/dev/repo") produce identical keys. A path that
// cannot be placed under `root` is DROPPED from the wire (unlike the local
// comparator, which keeps it): an absolute path outside the repo is local
// machine structure — usernames, drive layout — and metadata-only (property 2)
// wins over completeness for anything that leaves the machine.
export function canonicalWireFiles(files, root) {
  const rootKey = String(root || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
  const out = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const raw = String(file || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .trim()
      .toLowerCase();
    if (!raw) continue;
    let key = raw;
    if (/^([a-z]:)?\//.test(raw)) {
      if (!rootKey || !raw.startsWith(`${rootKey}/`)) continue;   // outside the repo — never leaves the machine
      key = raw.slice(rootKey.length + 1);
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 20);
}

// One lane row → one wire frame, or null when the row must not be broadcast:
// a row this relay itself wrote from the channel (via:'cloud') would loop, and
// a row with no session id is unaddressable. Constructed by whitelist — this
// is the ONLY place a frame is assembled, so the metadata-only guarantee is
// structural, not a filter that can miss a field.
export function buildPresenceFrame(session, { machineId, hostLabel = null, root = null, now = Date.now() } = {}) {
  if (!session || !session.id || !machineId) return null;
  if (session.via === 'cloud') return null;   // loop prevention: never re-broadcast a received row
  return {
    v: PRESENCE_WIRE_VERSION,
    kind: 'presence',
    sid: str(session.id, 64),
    machine: str(machineId, 40),
    host: hostLabel ? str(hostLabel, 40) : null,
    client: str(session.client || 'unknown', 40),
    surface: session.surface ? str(session.surface, 40) : null,
    branch: session.branch ? str(session.branch, 80) : null,
    intent: str(session.intent, 160),
    files: canonicalWireFiles(session.files, root),
    sentAt: Number(now) || Date.now(),          // informational only — see property 4
  };
}

// One received frame → one lane row, or null (silently) when the frame is not
// ours to render: unknown wire version (P7 — an old client must never crash on
// a new schema, and vice versa), malformed, or an echo of this machine's own
// broadcast (loop prevention + D3 precedence: a session on THIS machine renders
// once, as local). lastSeen/channelSeen are stamped with the RECEIVER's clock.
export function acceptPresenceFrame(frame, { machineId, now = Date.now() } = {}) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.v !== PRESENCE_WIRE_VERSION || frame.kind !== 'presence') return null;
  const sid = str(frame.sid, 64);
  const machine = str(frame.machine, 40);
  if (!sid || !machine) return null;
  if (machineId && machine === String(machineId)) return null;   // own echo
  return {
    id: sid,
    client: str(frame.client || 'unknown', 40) || 'unknown',
    surface: frame.surface ? str(frame.surface, 40) : null,
    branch: frame.branch ? str(frame.branch, 80) : null,
    intent: str(frame.intent, 160),
    files: canonicalWireFiles(frame.files, null),
    machine,
    host: frame.host ? str(frame.host, 40) : null,
    via: 'cloud',
    lastSeen: now,
  };
}

// One lane message → one wire frame, or null when it must not cross machines:
// a message this relay injected FROM the channel (xpc: dedupe key) would loop.
export function buildMessageFrame(message, { machineId, now = Date.now() } = {}) {
  if (!message || !machineId) return null;
  if (String(message.dedupeKey || '').startsWith(XPC_DEDUPE_PREFIX)) return null;
  const text = str(message.text, 400);
  const from = str(message.from, 64);
  if (!text || !from) return null;
  return {
    v: PRESENCE_WIRE_VERSION,
    kind: 'message',
    machine: str(machineId, 40),
    from,
    to: str(message.to, 160) || 'all',
    text,
    sentAt: Number(message.ts) || Number(now) || Date.now(),
  };
}

// One received message frame → arguments for agent-presence postPresenceMessage,
// or null. The dedupe key is (origin session id + content hash), NOT a message
// id: an at-least-once transport may re-deliver the same content under a new
// envelope, and it must still render exactly once (P5). postPresenceMessage's
// existing dedupeKey mechanism enforces it under the lane lock.
export function acceptMessageFrame(frame, { machineId } = {}) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.v !== PRESENCE_WIRE_VERSION || frame.kind !== 'message') return null;
  const machine = str(frame.machine, 40);
  const from = str(frame.from, 64);
  const text = str(frame.text, 400);
  if (!machine || !from || !text) return null;
  if (machineId && machine === String(machineId)) return null;   // own echo
  return {
    from,
    to: str(frame.to, 160) || 'all',
    text,
    dedupeKey: `${XPC_DEDUPE_PREFIX}${sha16(`${machine}|${from}|${text.toLowerCase()}`)}`,
  };
}

// Versioned, revocable, default-OFF consent — the shape the desktop stores per
// linked brain (klypix:brainPresenceConsent:v1:<blobId>). Anything short of an
// explicit, current-version grant is a NO: null record (never asked), wrong
// version (re-consent after a scope change), wrong purpose/scope, revoked.
export function presenceConsentAllows(record) {
  return Boolean(
    record
    && typeof record === 'object'
    && record.version === PRESENCE_CONSENT_VERSION
    && record.decision === 'granted'
    && record.purpose === PRESENCE_CONSENT_PURPOSE
    && record.scope === PRESENCE_CONSENT_SCOPE,
  );
}

// Which lane messages are due for broadcast: authored on this machine (never
// xpc:-injected), newer than the caller's cursor. The caller advances the
// cursor to the max ts it sent — re-pumps then skip already-sent content, and
// even a re-send is harmless (receiver dedup, P5).
export function selectOutboundMessages(messages, { sinceTs = 0 } = {}) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message
      && Number(message.ts || 0) > Number(sinceTs || 0)
      && !String(message.dedupeKey || '').startsWith(XPC_DEDUPE_PREFIX));
}

// ── Frame authenticity (optional per-brain MAC) ─────────────────────────────
// Channel ACLs live outside this repo, so any channel member could otherwise
// forge sid/machine (fabricated presence, overlap-warning spam) or claim a
// victim receiver's machineId so that receiver drops the frames as "own echo"
// (a targeted mute). With a shared per-brain key (the desktop already holds
// one for each cloud-linked brain), frames carry an HMAC over their sorted
// fields; a receiver configured with the key DROPS unsigned or mis-signed
// frames. No key configured → unsigned tolerated (compat: old builds, and
// consent remains the outer gate either way).
function frameMac(frame, key) {
  const entries = Object.keys(frame).filter((k) => k !== 'mac').sort()
    .map((k) => [k, frame[k]]);
  return crypto.createHmac('sha256', String(key)).update(JSON.stringify(entries)).digest('hex').slice(0, 32);
}
export function signFrame(frame, key) {
  if (!frame || typeof frame !== 'object' || !key) return frame;
  return { ...frame, mac: frameMac(frame, key) };
}
export function verifyFrame(frame, key) {
  if (!frame || typeof frame !== 'object') return false;
  if (!key) return true;                                 // no key → tolerate unsigned
  if (typeof frame.mac !== 'string' || !frame.mac) return false;
  const expected = Buffer.from(frameMac(frame, key));
  const presented = Buffer.from(String(frame.mac));
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

// ── The transport seam ───────────────────────────────────────────────────────
// The desktop relay calls exactly these two functions around its Realtime
// channel; the conformance harness calls them around a mock. Consent is
// checked HERE, per call, in both directions — so "no consent ⇒ zero outbound
// frames" and "no consent ⇒ no receive-display" are assertable at this seam
// (acceptance gate 3), and a mid-session revoke takes effect on the next
// heartbeat/frame with no further wiring (P9).

export function relayOutbound({
  sessions = [],
  messages = [],
  consent = null,
  machineId,
  hostLabel = null,
  root = null,
  sinceTs = 0,
  now = Date.now(),
  send,
  key = null,
} = {}) {
  if (!presenceConsentAllows(consent)) return { sent: 0, reason: 'no-consent', maxMessageTs: sinceTs };
  if (typeof send !== 'function') return { sent: 0, reason: 'no-channel', maxMessageTs: sinceTs };
  let sent = 0;
  let maxMessageTs = Number(sinceTs || 0);
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const frame = buildPresenceFrame(session, { machineId, hostLabel, root, now });
    if (!frame) continue;
    send(signFrame(frame, key));
    sent++;
  }
  for (const message of selectOutboundMessages(messages, { sinceTs })) {
    const frame = buildMessageFrame(message, { machineId, now });
    if (!frame) continue;
    send(signFrame(frame, key));
    sent++;
    maxMessageTs = Math.max(maxMessageTs, Number(message.ts || 0));
  }
  return { sent, reason: null, maxMessageTs };
}

export function relayInbound(frame, { consent = null, machineId, now = Date.now(), key = null } = {}) {
  if (!presenceConsentAllows(consent)) return null;   // symmetric: no consent ⇒ no receive-display
  if (!frame || typeof frame !== 'object') return null;
  if (!verifyFrame(frame, key)) return null;          // key configured → unsigned/mis-signed frames drop
  if (frame.kind === 'presence') {
    const row = acceptPresenceFrame(frame, { machineId, now });
    return row ? { type: 'presence', row } : null;
  }
  if (frame.kind === 'message') {
    const message = acceptMessageFrame(frame, { machineId });
    return message ? { type: 'message', message } : null;
  }
  return null;   // unknown kind — a future schema this build doesn't know (P7)
}
