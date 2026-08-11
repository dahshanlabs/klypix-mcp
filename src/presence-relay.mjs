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
//   2. WHITELISTED PAYLOADS. A presence frame carries at most: session id,
//      hashed machine id, host label, client, surface, branch, the one-line
//      declared intent, canonical repo-relative expected-file keys, and an
//      informational send time. Message frames additionally carry the explicit
//      one-time coordination-note text (manual notes and automatic overlap-alert
//      text). No cwd, pid, model, file bytes, card payload, diff, or screen data
//      is AUTOMATICALLY attached. A sender can type sensitive material into a
//      note, so consent/UI must never claim the arbitrary note body is metadata.
//      buildPresenceFrame constructs presence rows by WHITELIST — unknown row
//      fields cannot leak because nothing copies them.
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
// v2 is the legacy durable-message envelope. v3 adds a receiver-enforced
// recipient-machine allowlist. A scoped frame MUST use v3 so a v2 client,
// which does not understand the allowlist, fails closed instead of accepting
// a retry intended for somebody else. Unscoped compatibility callers may
// still emit v2; acknowledgement payloads retain their unchanged v2 schema.
export const LEGACY_MESSAGE_WIRE_VERSION = 2;
export const MESSAGE_WIRE_VERSION = 3;
export const MESSAGE_ACK_WIRE_VERSION = 2;
export const PRESENCE_HEARTBEAT_MS = 60_000;
// Consent record contract (mirrors src/services/screenCloudConsent.ts in the
// desktop app: versioned, revocable, default-off, checked at send time).
export const PRESENCE_CONSENT_VERSION = 2;
export const PRESENCE_CONSENT_PURPOSE = 'session-presence';
export const PRESENCE_CONSENT_SCOPE = 'presence-metadata-and-note-text';
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
// machine structure — usernames, drive layout — and the presence-field whitelist
// (property 2) wins over completeness for anything that leaves the machine.
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
// is the ONLY place a presence frame is assembled, so that field whitelist is
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
const canonicalRecipientMachineIds = (values) => [...new Set(
  Array.from(typeof values === 'string' ? [values] : (values || []), (value) => str(value, 40)).filter(Boolean),
)].slice(0, 64);

const eligibleRecipientMachineIds = (values, machineId) => {
  const sender = str(machineId, 40);
  return canonicalRecipientMachineIds(values).filter((id) => id !== sender);
};

function messageRecipientSnapshot(message, fallback, byMessage, machineId) {
  const id = String(message?.id || '');
  const explicit = byMessage !== undefined;
  let values;
  if (byMessage instanceof Map && byMessage.has(id)) {
    values = byMessage.get(id);
  } else if (byMessage && typeof byMessage === 'object'
    && Object.prototype.hasOwnProperty.call(byMessage, id)) {
    values = byMessage[id];
  }
  return {
    explicit,
    // Supplying a per-message registry makes it authoritative. A missing or
    // malformed entry is therefore an explicit empty snapshot (fail closed),
    // never permission to fall back to a later-expanded machine list.
    targets: eligibleRecipientMachineIds(explicit ? values : fallback, machineId),
  };
}

export function buildMessageFrame(message, {
  machineId,
  now = Date.now(),
  recipientMachineIds,
} = {}) {
  if (!message || !machineId) return null;
  if (String(message.dedupeKey || '').startsWith(XPC_DEDUPE_PREFIX)) return null;
  const text = str(message.text, 400);
  const from = str(message.from, 64);
  if (!text || !from) return null;
  const mid = str(message.id, 64) || sha16(`${machineId}|${from}|${text.toLowerCase()}|${Number(message.ts || now)}`);
  const recipients = recipientMachineIds === undefined
    ? null
    : eligibleRecipientMachineIds(recipientMachineIds, machineId);
  // An explicit empty snapshot means there was no eligible remote machine when
  // this message first became due. Do not turn it into a channel-wide frame.
  if (recipientMachineIds !== undefined && !recipients.length) return null;
  return {
    v: recipients === null ? LEGACY_MESSAGE_WIRE_VERSION : MESSAGE_WIRE_VERSION,
    kind: 'message',
    mid,
    machine: str(machineId, 40),
    from,
    to: str(message.to, 160) || 'all',
    text,
    sentAt: Number(message.ts) || Number(now) || Date.now(),
    ...(recipients ? { recipients } : {}),
  };
}

// One received message frame → arguments for agent-presence postPresenceMessage,
// or null. The dedupe key is (origin session id + content hash), NOT a message
// id: an at-least-once transport may re-deliver the same content under a new
// envelope, and it must still render exactly once (P5). postPresenceMessage's
// existing dedupeKey mechanism enforces it under the lane lock.
export function acceptMessageFrame(frame, { machineId } = {}) {
  if (!frame || typeof frame !== 'object') return null;
  if (![PRESENCE_WIRE_VERSION, LEGACY_MESSAGE_WIRE_VERSION, MESSAGE_WIRE_VERSION].includes(frame.v)
    || frame.kind !== 'message') return null;
  const machine = str(frame.machine, 40);
  const from = str(frame.from, 64);
  const text = str(frame.text, 400);
  if (!machine || !from || !text) return null;
  if (machineId && machine === String(machineId)) return null;   // own echo
  const hasRecipients = Object.prototype.hasOwnProperty.call(frame, 'recipients');
  // Only v3 understands recipient scoping. Requiring the field in v3 and
  // rejecting it on legacy envelopes makes the compatibility boundary exact.
  if ((frame.v === MESSAGE_WIRE_VERSION) !== hasRecipients) return null;
  if (hasRecipients) {
    // Realtime is a broadcast transport: this allowlist prevents mailbox
    // persistence/display by non-recipients. It is a delivery boundary, not
    // confidentiality; channel members can still receive the wire payload.
    if (!Array.isArray(frame.recipients) || !machineId) return null;
    const recipients = canonicalRecipientMachineIds(frame.recipients);
    if (!recipients.length || recipients.length !== frame.recipients.length
      || !recipients.includes(str(machineId, 40))) return null;
  }
  return {
    from,
    to: str(frame.to, 160) || 'all',
    text,
    messageId: frame.v >= LEGACY_MESSAGE_WIRE_VERSION ? str(frame.mid, 64) : null,
    originMachine: machine,
    messageWireVersion: frame.v,
    dedupeKey: frame.v >= LEGACY_MESSAGE_WIRE_VERSION && str(frame.mid, 64)
      ? `${XPC_DEDUPE_PREFIX}${machine}:${str(frame.mid, 64)}`
      : `${XPC_DEDUPE_PREFIX}${sha16(`${machine}|${from}|${text.toLowerCase()}`)}`,
  };
}

// Relay acknowledgements confirm durable acceptance by the remote machine's
// mailbox. They are transport receipts, not model-context or human-read receipts.
export function buildMessageAckFrame({ messageId, originMachine, recipientMachine, recipientId = null, now = Date.now() } = {}) {
  const mid = str(messageId, 64);
  const origin = str(originMachine, 40);
  const machine = str(recipientMachine, 40);
  if (!mid || !origin || !machine || origin === machine) return null;
  return {
    v: MESSAGE_ACK_WIRE_VERSION,
    kind: 'message-ack',
    mid,
    originMachine: origin,
    machine,
    recipientId: recipientId ? str(recipientId, 64) : null,
    acceptedAt: Number(now) || Date.now(),
  };
}

export function acceptMessageAckFrame(frame, { machineId } = {}) {
  if (!frame || ![MESSAGE_ACK_WIRE_VERSION, MESSAGE_WIRE_VERSION].includes(frame.v)
    || frame.kind !== 'message-ack') return null;
  const messageId = str(frame.mid, 64);
  const originMachine = str(frame.originMachine, 40);
  const recipientMachine = str(frame.machine, 40);
  if (!messageId || !originMachine || !recipientMachine) return null;
  if (machineId && originMachine !== String(machineId)) return null;
  if (originMachine === recipientMachine) return null;
  return {
    messageId,
    originMachine,
    recipientMachine,
    deliveryKey: messageDeliveryKey(messageId, recipientMachine),
    recipientId: frame.recipientId ? str(frame.recipientId, 64) : null,
    acceptedAt: Number(frame.acceptedAt || 0),
  };
}

// A transport acknowledgement is scoped to one destination machine. Treating
// a message id alone as complete lets the first remote machine suppress retry
// to every other machine on the channel.
export function messageDeliveryKey(messageId, recipientMachine) {
  const mid = str(messageId, 64);
  const machine = str(recipientMachine, 40);
  return mid && machine ? `${mid}@${machine}` : '';
}

// The receiver must call this only AFTER its local lane insert/dedupe completed
// durably. relayInbound deliberately cannot mint an ack: parsing a valid frame
// is not proof that the mailbox lock/write succeeded.
export function acknowledgePersistedMessage(inbound, {
  persisted = false,
  recipientId = null,
  now = Date.now(),
} = {}) {
  if (!persisted || inbound?.type !== 'message' || !inbound.message?.messageId) return null;
  return buildMessageAckFrame({
    messageId: inbound.message.messageId,
    originMachine: inbound.message.originMachine,
    recipientMachine: inbound.recipientMachine,
    recipientId,
    now,
  });
}

// Versioned, revocable, default-OFF consent — the shape the desktop stores per
// linked brain (klypix:brainPresenceConsent:v2:<blobId>). Anything short of an
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

// Which lane messages are due for broadcast. The durable mode keys receipts by
// BOTH message and destination machine, so one remote acceptance cannot silence
// retry for another machine. The flat acknowledgedMessageIds form remains a
// one-recipient compatibility shim; with multiple targets it is intentionally
// not trusted as a global acknowledgement.
export function selectOutboundMessages(messages, {
  sinceTs = 0,
  acknowledgedMessageIds,
  acknowledgedDeliveries,
  recipientMachineIds,
  recipientMachineIdsByMessage,
  machineId,
} = {}) {
  const scoped = recipientMachineIds !== undefined || recipientMachineIdsByMessage !== undefined;
  const durable = acknowledgedMessageIds !== undefined || acknowledgedDeliveries !== undefined || scoped;
  const targets = eligibleRecipientMachineIds(recipientMachineIds, machineId);
  const flat = new Set(Array.from(acknowledgedMessageIds || [], String));
  const receipts = new Set(Array.from(acknowledgedDeliveries || [], (entry) => {
    if (typeof entry === 'string') return entry;
    return messageDeliveryKey(entry?.messageId, entry?.recipientMachine);
  }).filter(Boolean));
  const acknowledgedForAllTargets = (message) => {
    const id = String(message?.id || '');
    if (!id) return false;
    const snapshot = messageRecipientSnapshot(message, targets, recipientMachineIdsByMessage, machineId);
    // An explicit empty first-send snapshot is terminal for cross-machine
    // delivery: later device discovery must never expand it into store-forward.
    if (scoped && !snapshot.targets.length) return true;
    if (!snapshot.targets.length) return flat.has(id);
    if (!snapshot.explicit && snapshot.targets.length === 1 && flat.has(id)) return true; // legacy single-peer caller
    return snapshot.targets.every((machine) => receipts.has(messageDeliveryKey(id, machine)));
  };
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message
      && !message.deadLetter
      && !message.retiredAt
      && !String(message.dedupeKey || '').startsWith(XPC_DEDUPE_PREFIX)
      && (durable
        ? !acknowledgedForAllTargets(message)
        : Number(message.ts || 0) > Number(sinceTs || 0)));
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
  acknowledgedMessageIds,
  acknowledgedDeliveries,
  recipientMachineIds,
  recipientMachineIdsByMessage,
  acknowledgements = [],
  now = Date.now(),
  send,
  key = null,
} = {}) {
  if (!presenceConsentAllows(consent)) return { sent: 0, reason: 'no-consent', maxMessageTs: sinceTs, sentMessageIds: [], pendingMessageIds: [] };
  if (typeof send !== 'function') return { sent: 0, reason: 'no-channel', maxMessageTs: sinceTs, sentMessageIds: [], pendingMessageIds: [] };
  let sent = 0;
  let maxMessageTs = Number(sinceTs || 0);
  const sentMessageIds = [];
  const failedMessageIds = [];
  const scoped = recipientMachineIds !== undefined || recipientMachineIdsByMessage !== undefined;
  const durable = acknowledgedMessageIds !== undefined || acknowledgedDeliveries !== undefined || scoped;
  const targetMachines = eligibleRecipientMachineIds(recipientMachineIds, machineId);
  const flatAcknowledged = new Set(Array.from(acknowledgedMessageIds || [], String));
  const acknowledgedDeliveryKeys = new Set(Array.from(acknowledgedDeliveries || [], (entry) =>
    typeof entry === 'string' ? entry : messageDeliveryKey(entry?.messageId, entry?.recipientMachine)).filter(Boolean));
  const trySend = (frame) => {
    try {
      // Synchronous false/throw is a failed attempt. Promise-based transports
      // should await their own send and call this pump again until an ack frame
      // is persisted; receiver dedupe makes retries harmless.
      return send(signFrame(frame, key)) !== false;
    } catch { return false; }
  };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const frame = buildPresenceFrame(session, { machineId, hostLabel, root, now });
    if (!frame) continue;
    if (trySend(frame)) sent++;
  }
  const pending = selectOutboundMessages(messages, {
    sinceTs,
    acknowledgedMessageIds,
    acknowledgedDeliveries,
    ...(scoped ? { recipientMachineIds: targetMachines } : {}),
    ...(recipientMachineIdsByMessage !== undefined ? { recipientMachineIdsByMessage } : {}),
    machineId,
  });
  for (const message of pending) {
    const snapshot = messageRecipientSnapshot(message, targetMachines, recipientMachineIdsByMessage, machineId);
    const frame = buildMessageFrame(message, {
      machineId,
      now,
      ...(scoped ? { recipientMachineIds: snapshot.targets } : {}),
    });
    if (!frame) continue;
    if (trySend(frame)) {
      sent++;
      sentMessageIds.push(String(message.id || frame.mid));
      if (!durable) maxMessageTs = Math.max(maxMessageTs, Number(message.ts || 0));
    } else failedMessageIds.push(String(message.id || frame.mid));
  }
  for (const receipt of Array.isArray(acknowledgements) ? acknowledgements : []) {
    const frame = receipt?.kind === 'message-ack'
      ? receipt
      : buildMessageAckFrame({ ...receipt, recipientMachine: receipt?.recipientMachine || machineId, now });
    if (frame && trySend(frame)) sent++;
  }
  return {
    sent,
    reason: failedMessageIds.length ? 'partial-send-failure' : null,
    maxMessageTs,
    sentMessageIds,
    failedMessageIds,
    pendingMessageIds: pending.map((message) => String(message.id || '')),
    pendingDeliveryKeys: pending.flatMap((message) => {
      const id = String(message.id || '');
      const snapshot = messageRecipientSnapshot(message, targetMachines, recipientMachineIdsByMessage, machineId);
      return snapshot.targets.length
        ? snapshot.targets.map((machine) => messageDeliveryKey(id, machine)).filter((key) =>
          key && !acknowledgedDeliveryKeys.has(key)
          && !(snapshot.targets.length === 1 && !snapshot.explicit && flatAcknowledged.has(id)))
        : (scoped ? [] : [id]);
    }),
  };
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
    return message ? {
      type: 'message',
      message,
      recipientMachine: String(machineId || ''),
      // Deliberately null until acknowledgePersistedMessage() receives the
      // caller's successful mailbox-insert receipt.
      acknowledgement: null,
    } : null;
  }
  if (frame.kind === 'message-ack') {
    const acknowledgement = acceptMessageAckFrame(frame, { machineId });
    return acknowledgement ? { type: 'message-ack', acknowledgement } : null;
  }
  return null;   // unknown kind — a future schema this build doesn't know (P7)
}
