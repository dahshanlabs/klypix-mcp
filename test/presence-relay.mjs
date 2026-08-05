// Cross-PC presence relay — unit tests against the failure matrix
// (docs/prompts/CROSS_PC_PRESENCE_SESSION_PROMPT.md P1–P9) plus the structural
// guarantees: metadata-only whitelist, loop prevention, symmetric consent, and
// "presence writes NOTHING to the brain" (asserted on the module source).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  laneFileFor,
  listActiveSessions,
  postPresenceMessage,
  purgeRemoteSessions,
  receiveMessages,
  upsertRemoteSessions,
  upsertSession,
} from '../src/agent-presence.mjs';
import { findPresenceConflicts } from '../src/mcp-presence.mjs';
import {
  acceptMessageFrame,
  acceptPresenceFrame,
  buildMessageFrame,
  buildPresenceFrame,
  canonicalWireFiles,
  PRESENCE_CONSENT_PURPOSE,
  PRESENCE_CONSENT_SCOPE,
  PRESENCE_CONSENT_VERSION,
  PRESENCE_WIRE_VERSION,
  presenceConsentAllows,
  relayInbound,
  relayOutbound,
  selectOutboundMessages,
  XPC_DEDUPE_PREFIX,
} from '../src/presence-relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const GRANT = {
  version: PRESENCE_CONSENT_VERSION,
  decision: 'granted',
  decidedAt: '2026-08-01T00:00:00.000Z',
  purpose: PRESENCE_CONSENT_PURPOSE,
  scope: PRESENCE_CONSENT_SCOPE,
};
const now = 2_000_000_000_000;

// ── Structural: the relay core can never touch a brain or the network ───────
const source = fs.readFileSync(path.join(root, 'src', 'presence-relay.mjs'), 'utf8');
ok(!/from\s+'(node:)?fs'|require\(\s*'(node:)?fs'/.test(source)
  && !/klypix-format|klypix-core|\.klypix'/.test(source)
  && !/https?:\/\/|fetch\(|net\.|WebSocket/.test(source),
'presence-relay.mjs imports no fs, no brain format API, no network — advisory-only is structural (P8)');

// ── Wire files: canonical repo-relative keys, privacy-first ─────────────────
const wireFiles = canonicalWireFiles(
  ['E:/work/Repo/src/App.tsx', 'src\\App.tsx', './src/other.ts', 'C:/Users/someone/secrets.txt'],
  'E:/work/repo',
);
ok(wireFiles.length === 2 && wireFiles[0] === 'src/app.tsx' && wireFiles[1] === 'src/other.ts',
  'wire file keys fold absolute and relative spellings onto one repo-relative key and dedupe');
ok(!wireFiles.some((key) => key.includes('secrets')),
  'an absolute path OUTSIDE the repo never reaches the wire (metadata-only)');

// ── Frame whitelist: nothing beyond the declared metadata can leak ───────────
const richRow = {
  id: 'sess-a', client: 'claude-code', surface: 'cli', branch: 'master',
  intent: 'wire cross-PC presence', files: ['src/app.tsx'],
  cwd: 'E:/work/repo', pid: 4242, hostPid: 4242, model: 'secret-model',
  apiKey: 'sk-should-never-leak', machine: 'mach-a', lastSeen: now,
};
const frame = buildPresenceFrame(richRow, { machineId: 'mach-a', hostLabel: 'DEV-PC-A', root: 'E:/work/repo', now });
ok(frame && frame.v === PRESENCE_WIRE_VERSION && frame.sid === 'sess-a' && frame.files[0] === 'src/app.tsx',
  'presence frame carries the declared metadata');
const allowedKeys = ['v', 'kind', 'sid', 'machine', 'host', 'client', 'surface', 'branch', 'intent', 'files', 'sentAt'];
ok(Object.keys(frame).every((key) => allowedKeys.includes(key))
  && !JSON.stringify(frame).includes('secret') && !JSON.stringify(frame).includes('4242')
  && !JSON.stringify(frame).toLowerCase().includes('cwd'),
'frame is whitelist-only: cwd, pid, model, and unknown row fields can never leak');

// ── Loop prevention ──────────────────────────────────────────────────────────
ok(buildPresenceFrame({ ...richRow, via: 'cloud' }, { machineId: 'mach-a', now }) === null,
  'a row received from the channel is never re-broadcast');
ok(acceptPresenceFrame(frame, { machineId: 'mach-a', now }) === null,
  'a frame from this machine is dropped on receive (own echo)');

// ── P7: unknown versions/kinds ignored silently ──────────────────────────────
ok(acceptPresenceFrame({ ...frame, v: 2 }, { machineId: 'mach-b', now }) === null
  && acceptPresenceFrame({ garbage: true }, { machineId: 'mach-b', now }) === null
  && acceptPresenceFrame(null, { machineId: 'mach-b', now }) === null
  && relayInbound({ v: 1, kind: 'hologram' }, { consent: GRANT, machineId: 'mach-b', now }) === null,
'unknown wire versions, kinds, and malformed frames are ignored silently — never a crash (P7)');

// ── P4: receiver clock decides freshness ─────────────────────────────────────
const skewed = acceptPresenceFrame({ ...frame, sentAt: now + 9_000_000_000 }, { machineId: 'mach-b', now });
ok(skewed && skewed.lastSeen === now,
  'a sender with a wrong clock cannot appear permanently fresh — lastSeen is the receiver\'s clock (P4)');

// ── P2: idempotent re-accept ─────────────────────────────────────────────────
const once = acceptPresenceFrame(frame, { machineId: 'mach-b', now });
const twice = acceptPresenceFrame(frame, { machineId: 'mach-b', now });
ok(JSON.stringify(once) === JSON.stringify(twice),
  'rejoin/flap re-delivery of the same frame is idempotent (P2)');

// ── Consent: default OFF, versioned, symmetric ───────────────────────────────
ok(!presenceConsentAllows(null) && !presenceConsentAllows({})
  && !presenceConsentAllows({ ...GRANT, decision: 'denied' })
  && !presenceConsentAllows({ ...GRANT, version: PRESENCE_CONSENT_VERSION + 1 })
  && presenceConsentAllows(GRANT),
'consent is default-off, versioned, and only an explicit current-version grant allows');

let sendCount = 0;
const outNoConsent = relayOutbound({
  sessions: [richRow], messages: [{ from: 'sess-a', text: 'hello', ts: now }],
  consent: null, machineId: 'mach-a', root: 'E:/work/repo', now,
  send: () => { sendCount++; },
});
ok(sendCount === 0 && outNoConsent.sent === 0 && outNoConsent.reason === 'no-consent',
  'no consent record ⇒ ZERO outbound frames, asserted at the transport seam (gate 3)');
ok(relayInbound(frame, { consent: null, machineId: 'mach-b', now }) === null
  && relayInbound(frame, { consent: GRANT, machineId: 'mach-b', now })?.type === 'presence',
'no consent ⇒ no receive-display either — consent is symmetric (P9)');

const outGranted = relayOutbound({
  sessions: [richRow, { ...richRow, id: 'cloud-row', via: 'cloud' }],
  messages: [
    { from: 'sess-a', text: 'fresh note', ts: now },
    { from: 'sess-a', text: 'already injected', ts: now, dedupeKey: `${XPC_DEDUPE_PREFIX}abc` },
    { from: 'sess-a', text: 'old note', ts: now - 10 },
  ],
  consent: GRANT, machineId: 'mach-a', root: 'E:/work/repo', sinceTs: now - 5, now,
  send: () => { sendCount++; },
});
ok(outGranted.sent === 2 && sendCount === 2 && outGranted.maxMessageTs === now,
  'granted consent broadcasts local rows + fresh local messages only (cloud rows, xpc-injected and pre-cursor messages skipped)');

// ── P5: message double-delivery renders once ─────────────────────────────────
const msgFrame = buildMessageFrame({ from: 'sess-a', to: 'all', text: 'Rebase before you commit', ts: now }, { machineId: 'mach-a', now });
const accepted1 = acceptMessageFrame(msgFrame, { machineId: 'mach-b' });
const accepted2 = acceptMessageFrame({ ...msgFrame, sentAt: now + 5 }, { machineId: 'mach-b' });
ok(accepted1 && accepted1.dedupeKey.startsWith(XPC_DEDUPE_PREFIX) && accepted1.dedupeKey === accepted2.dedupeKey,
  'redelivered message content yields the SAME dedupe key (session id + content hash, P5)');
ok(selectOutboundMessages([{ from: 'x', text: 'y', ts: now, dedupeKey: accepted1.dedupeKey }]).length === 0,
  'an injected cross-PC message is never re-broadcast (message loop prevention)');

// ── Lane integration: two isolated "machines", one shared logical brain ──────
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-xpc-'));
const homeA = path.join(tempRoot, 'homeA');
const homeB = path.join(tempRoot, 'homeB');
const repoA = path.join(tempRoot, 'machineA', 'repo');
const repoB = path.join(tempRoot, 'machineB', 'repo');
for (const dir of [homeA, homeB, repoA, repoB]) fs.mkdirSync(dir, { recursive: true });
const brainA = path.join(repoA, 'brain.klypix');
const brainB = path.join(repoB, 'brain.klypix');
fs.writeFileSync(brainA, 'stub');
fs.writeFileSync(brainB, 'stub');

// Machine A: one local session declaring an ABSOLUTE path spelling.
upsertSession({
  brainPath: brainA, home: homeA, now, id: 'dev-a-session', client: 'claude-code',
  branch: 'master', intent: 'refactor the app shell',
  files: [path.join(repoA, 'src', 'App.tsx')],
});
// Machine B: one local session declaring the REPO-RELATIVE spelling of the same file.
upsertSession({
  brainPath: brainB, home: homeB, now, id: 'dev-b-session', client: 'codex',
  branch: 'master', intent: 'restyle the app shell',
  files: ['src/App.tsx'],
});

// Pump A → B through the pure seam (mock channel = direct function call).
const aRows = listActiveSessions({ brainPath: brainA, home: homeA, now });
const framesFromA = [];
relayOutbound({
  sessions: aRows, consent: GRANT, machineId: 'mach-a', hostLabel: 'DEV-PC-A',
  root: repoA, now, send: (f) => framesFromA.push(f),
});
const inboundRows = framesFromA
  .map((f) => relayInbound(f, { consent: GRANT, machineId: 'mach-b', now: now + 500 }))
  .filter((r) => r?.type === 'presence')
  .map((r) => r.row);
upsertRemoteSessions({ brainPath: brainB, rows: inboundRows, machineId: 'mach-b', home: homeB, now: now + 500 });

const bSessions = listActiveSessions({ brainPath: brainB, home: homeB, now: now + 500 });
const remoteOnB = bSessions.find((session) => session.id === 'dev-a-session');
ok(!!remoteOnB && remoteOnB.via === 'cloud' && remoteOnB.machine === 'mach-a' && remoteOnB.host === 'DEV-PC-A',
  'a peer from another machine appears in the lane every existing surface renders');

const conflicts = findPresenceConflicts(bSessions, 'dev-b-session', { projectRoot: repoB });
ok(conflicts.length === 1 && conflicts[0].id === 'dev-a-session'
  && conflicts[0].files.some((file) => file.toLowerCase().includes('src/app.tsx')),
'overlap warning fires across machines on the canonical file key despite different path spellings');

// D3 precedence: a cloud frame must never overwrite a LOCAL row with the same id.
upsertRemoteSessions({
  brainPath: brainB,
  rows: [{ id: 'dev-b-session', client: 'impostor', intent: 'spoofed', files: [], machine: 'mach-a', via: 'cloud' }],
  machineId: 'mach-b', home: homeB, now: now + 600,
});
const localStillWins = listActiveSessions({ brainPath: brainB, home: homeB, now: now + 600 })
  .find((session) => session.id === 'dev-b-session');
ok(localStillWins.client === 'codex' && localStillWins.via !== 'cloud',
  'a locally-registered session id always beats a cloud frame with the same id (D3 precedence)');

// P5 end-to-end: double-delivery of one message lands exactly one lane row.
postPresenceMessage({ brainPath: brainA, from: 'dev-a-session', text: 'Claiming src/App.tsx for an hour', home: homeA, now: now + 700 });
const laneMsgs = JSON.parse(fs.readFileSync(laneFileFor(brainA, homeA), 'utf8')).messages;
const outMsgFrames = [];
relayOutbound({
  sessions: [], messages: laneMsgs, consent: GRANT, machineId: 'mach-a', now: now + 800,
  send: (f) => outMsgFrames.push(f),
});
ok(outMsgFrames.length === 1 && outMsgFrames[0].kind === 'message', 'a lane message becomes one wire frame');
for (let i = 0; i < 2; i++) {   // at-least-once transport: deliver twice
  const inbound = relayInbound(outMsgFrames[0], { consent: GRANT, machineId: 'mach-b', now: now + 900 });
  if (inbound?.type === 'message') {
    postPresenceMessage({ brainPath: brainB, from: inbound.message.from, to: inbound.message.to, text: inbound.message.text, dedupeKey: inbound.message.dedupeKey, home: homeB, now: now + 900 });
  }
}
const deliveredOnB = receiveMessages({ brainPath: brainB, sessionId: 'dev-b-session', home: homeB, now: now + 1000 });
ok(deliveredOnB.length === 1 && deliveredOnB[0].text.includes('Claiming src/App.tsx'),
  'double-delivered cross-PC message renders exactly once on the receiving machine (P5)');

// P3: a ghost session (no fresh heartbeat) drops out via existing TTL pruning.
const afterTtl = listActiveSessions({ brainPath: brainB, home: homeB, now: now + 11 * 60_000 });
ok(!afterTtl.some((session) => session.id === 'dev-a-session'),
  'a remote session with no fresh heartbeat is pruned by the existing TTL — never "active" on a stale claim (P3)');

// P9: revoke purges receive-display while local presence is untouched.
upsertRemoteSessions({ brainPath: brainB, rows: inboundRows, machineId: 'mach-b', home: homeB, now: now + 1100 });
const purged = purgeRemoteSessions({ brainPath: brainB, home: homeB, now: now + 1200 });
ok(!purged.some((session) => session.via === 'cloud')
  && purged.some((session) => session.id === 'dev-b-session'),
'consent revoke purges cloud rows and leaves local presence exactly as today (P9 symmetric)');

// P1: a dead channel degrades silently — outbound reports, local reads still work.
const deadOut = relayOutbound({ sessions: aRows, consent: GRANT, machineId: 'mach-a', root: repoA, now, send: undefined });
ok(deadOut.sent === 0 && deadOut.reason === 'no-channel'
  && listActiveSessions({ brainPath: brainA, home: homeA, now: now + 1300 }).length === 1,
'a dead/unreachable channel degrades to local-only presence with no throw (P1)');

// Frame authenticity (optional per-brain MAC): signed frames verify; forged /
// unsigned / tampered frames DROP when the receiver holds the key; no key
// configured keeps today's behavior byte-identical.
{
  const KEY = 'per-brain-shared-key';
  const signedOut = [];
  relayOutbound({ sessions: aRows, consent: GRANT, machineId: 'mach-a', root: repoA, now, send: (f) => signedOut.push(f), key: KEY });
  ok(signedOut.length > 0 && signedOut.every((f) => typeof f.mac === 'string' && f.mac.length === 32),
    'with a key, every outbound frame carries a MAC');
  const good = relayInbound(signedOut[0], { consent: GRANT, machineId: 'mach-b', now, key: KEY });
  ok(good !== null, 'a correctly signed frame verifies and renders');
  const tampered = { ...signedOut[0], sid: 'forged-session-id' };
  ok(relayInbound(tampered, { consent: GRANT, machineId: 'mach-b', now, key: KEY }) === null,
    'a tampered field invalidates the MAC — the frame drops');
  const unsigned = { ...signedOut[0] }; delete unsigned.mac;
  ok(relayInbound(unsigned, { consent: GRANT, machineId: 'mach-b', now, key: KEY }) === null,
    'a keyed receiver drops unsigned frames (spoofed sid/machine cannot enter the lane)');
  ok(relayInbound(unsigned, { consent: GRANT, machineId: 'mach-b', now }) !== null,
    'no key configured → unsigned frames still accepted (compat path unchanged)');
}

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(failures ? `\n[x] ${failures} presence-relay assertion(s) failed` : '\n[ok] presence-relay: all assertions passed');
process.exit(failures ? 1 : 0);
