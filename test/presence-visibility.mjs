// Presence-visibility overhaul (2026-07-29 audit) — the "13 sessions rendered
// as 4" incident class. Locks in:
//   V1 — resolveMcpSessionId reads CLAUDE_CODE_SESSION_ID (the var Claude Code
//        actually exports; the old list only had the speculative name).
//   V2 — receiveMessages acks ONLY what it returns: overflow past the 6-cap
//        arrives on the next call instead of being destroyed.
//   V3 — capMessages evicts delivered messages before undelivered ones.
//   V4 — intentAt stamps when the intent VALUE changes and survives heartbeats,
//        so renderers can age intents independently of lastSeen.
//   V5 — formatPresenceMessage: overflow line past 8 peers + intent-age suffix.
//   V6 — logical-session suppression uses explicit identity only; a shared
//        hostPid never hides independent Codex work.
//   V7 — hostmapSessionId follows the hook-written host-pid → session-id map.
//   V8 — the REAL hook stamps client/channel/hostPid on its lane row, observes
//        write-tool file scope live (--live) in PATH form, and its message
//        footer delivers-then-acks with an explicit overflow notice.
//   V9 — CRLF conversion of a projected harness file classifies as healable
//        (stale/ok), never hand-edited; hand-edited rewrites leave a .klypix-bak.
//   V10 — brain_doctor: a recovery-failed supervisor is DRIFT, not healthy;
//        sync-silent and connection-scoped identity gaps are called out.
//   V11 — otherwise-healthy multi-session state with a sync-silent peer is
//        PARTIAL, never the misleading ALIGNED all-clear.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  capMessages,
  consumeMessageReceipt,
  formatReceivedMessages,
  formatPresenceMessage,
  laneFileFor,
  MESSAGE_FRESH_MS,
  messageDeliveryState,
  messageDeliveryReceipt,
  postPresenceMessage,
  receiveMessages,
  upsertSession,
} from '../src/agent-presence.mjs';
import {
  buildPresenceSnapshot,
  findPresenceConflicts,
  hostmapSessionId,
  resolveMcpSessionId,
} from '../src/mcp-presence.mjs';
import { linkProject, auditProject } from '../src/agent-rules.mjs';
import { inspect as doctorInspect } from '../src/brain-doctor.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = path.join(os.tmpdir(), 'klypix-presvis-home');
const project = path.join(os.tmpdir(), 'klypix-presvis-project');
for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({
  title: 'presence-visibility fixture',
  kind: 'brain',
  areas: [{ title: 'Brain', cards: [{ text: 'seed decision for the visibility fixture.' }] }],
}));
const now = 2_000_000_000_000;

// ── V1: env-key fix ──────────────────────────────────────────────────────────
ok(resolveMcpSessionId({ env: { CLAUDE_CODE_SESSION_ID: 'abc-123' }, pid: 1, nonce: 'x' }) === 'abc-123',
  'V1: CLAUDE_CODE_SESSION_ID (the real Claude Code export) resolves the session id');
ok(resolveMcpSessionId({ env: { KLYPIX_SESSION_ID: 'k-1', CLAUDE_CODE_SESSION_ID: 'abc' }, pid: 1, nonce: 'x' }) === 'k-1',
  'V1: explicit KLYPIX_SESSION_ID still wins over host vars');
ok(resolveMcpSessionId({ env: { KLYPIX_MCP_CONNECTION_ID: 'supervisor-connection' }, pid: 7, nonce: 'aaaa' }) === 'supervisor-connection',
  'V1: supervised replacement workers share the stable MCP connection identity');
ok(resolveMcpSessionId({ env: {}, pid: 7, nonce: 'aaaa' }) === 'mcp-7-aaaa',
  'V1: no env → pid-nonce fallback unchanged');

// ── V2: deliver-then-ack (no silent message destruction) ─────────────────────
upsertSession({ brainPath, home, now, id: 'rx', client: 'codex' });
for (let i = 0; i < 8; i++) {
  postPresenceMessage({ brainPath, home, now: now + i, from: 'tx', to: 'all', text: `note number ${i}` });
}
const firstBatch = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 100, actionId: 'batch-1' });
ok(firstBatch.length === 6, `V2: first receive delivers the 6-cap (got ${firstBatch.length})`);
const replayAndOverflow = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 200, actionId: 'batch-2' });
ok(replayAndOverflow.length === 6
  && replayAndOverflow.filter(m => !firstBatch.some(f => f.id === m.id)).length === 2,
  'V2: pending overflow is prioritized ahead of acknowledged replays and cannot starve');
// batch-3 under the lease: the four notes acknowledged on batch-2 are
// auto-consumed (third independent action) instead of replayed, so only the
// four still-offered notes render and advance to acknowledged.
const finishAcknowledgement = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 300, actionId: 'batch-3' });
ok(finishAcknowledgement.length === 4,
  `V2: remaining offers replay while acknowledged notes lease-consume (got ${finishAcknowledgement.length})`);
let deliveryLane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
const initialEight = deliveryLane.messages.filter((message) => /^note number /.test(message.text));
ok(initialEight.length === 8 && initialEight.every((message) =>
  ['acknowledged', 'consumed'].includes(messageDeliveryState(message, 'rx'))),
  'V2: every overflowed note reaches acknowledgement or lease-consumption without silent loss');
for (const message of initialEight) {
  const receipt = messageDeliveryReceipt(message, 'rx');
  consumeMessageReceipt({
    brainPath, sessionId: 'rx', messageId: message.id, offerToken: receipt.offerToken,
    home, now: now + 400, actionId: `consume-${message.id}`,
  });
}
ok(receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 500, actionId: 'batch-4' }).length === 0,
  'V2: explicit consumption retires every note; acknowledgement alone never claimed consumption');

postPresenceMessage({ brainPath, home, now: now + 510, from: 'tx-a', to: 'all', text: 'same coordination text' });
postPresenceMessage({ brainPath, home, now: now + 511, from: 'tx-b', to: 'all', text: 'same coordination text' });
const twoSendersOffer = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 520, actionId: 'senders-1' });
const twoSendersAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 530, actionId: 'senders-2' });
ok(twoSendersOffer.length === 2 && new Set(twoSendersOffer.map(message => message.from)).size === 2
  && twoSendersAck.length === 2,
'V2: identical text from different senders keeps both attributions and advances each receipt honestly');
const groupedTwoSenders = formatReceivedMessages(twoSendersOffer, now + 520);
ok(groupedTwoSenders.split('same coordination text').length - 1 === 1
  && groupedTwoSenders.includes('tx-a') && groupedTwoSenders.includes('tx-b'),
  'V2: model-facing rendering groups identical instructions once while naming both senders');
for (const message of twoSendersAck) {
  const receipt = messageDeliveryReceipt(message, 'rx');
  consumeMessageReceipt({ brainPath, sessionId: 'rx', messageId: message.id,
    offerToken: receipt.offerToken, home, now: now + 535, actionId: `senders-consume-${message.id}` });
}
const caseDistinctPaths = formatReceivedMessages([
  { id: 'case-a', from: 'tx-a', text: 'Edit src/API.ts before release', ts: now + 521 },
  { id: 'case-b', from: 'tx-b', text: 'Edit src/api.ts before release', ts: now + 522 },
], now + 523);
ok(caseDistinctPaths.includes('Edit src/API.ts before release')
  && caseDistinctPaths.includes('Edit src/api.ts before release'),
  'V2: case-distinct paths remain two instructions; grouping never destroys case-sensitive identity');
postPresenceMessage({ brainPath, home, now: now + 540, from: 'peer-copy', to: 'rx', text: 'same as my just-sent note' });
ok(receiveMessages({
  brainPath, sessionId: 'rx', home, now: now + 550, ignoreTexts: ['same as my just-sent note'],
}).length === 0,
'V2: transcript self-echo compatibility suppresses matching text for only the current response');
const peerCopy = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 560 });
ok(peerCopy.length === 1 && peerCopy[0].from === 'peer-copy',
  'V2: a genuine peer note identical to my text remains pending and reaches the next model-context action');
const peerCopyAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 565, actionId: 'peer-copy-ack' });
const peerCopyReceipt = messageDeliveryReceipt(peerCopyAck[0], 'rx');
consumeMessageReceipt({ brainPath, sessionId: 'rx', messageId: peerCopyAck[0].id,
  offerToken: peerCopyReceipt.offerToken, home, now: now + 566, actionId: 'peer-copy-consume' });
postPresenceMessage({ brainPath, home, now: now + 570, from: 'tx-action', to: 'rx', text: 'do not ack inside one tool action' });
const preToolOffer = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 580, actionId: 'tool:tool-1' });
const sameToolPost = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 590, actionId: 'tool:tool-1' });
const laterActionAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 600, actionId: 'turn:prompt-2' });
ok(preToolOffer.length === 1 && sameToolPost.length === 0 && laterActionAck.length === 1,
  'V2: PreToolUse/PostToolUse for one tool cannot self-ack; only a distinct later action acknowledges the offer');
const laterReceipt = messageDeliveryReceipt(laterActionAck[0], 'rx');
consumeMessageReceipt({ brainPath, sessionId: 'rx', messageId: laterActionAck[0].id,
  offerToken: laterReceipt.offerToken, home, now: now + 601, actionId: 'turn:consume-2' });

// ── V3: cap prefers evicting delivered messages ──────────────────────────────
{
  const msgs = [
    { id: 'seen-old', ts: 1, seen: ['someone'] },
    { id: 'unseen-old', ts: 2, seen: [] },
    { id: 'seen-new', ts: 3, seen: ['someone'] },
    { id: 'unseen-new', ts: 4, seen: [] },
  ];
  const capped = capMessages(msgs, 2, now);
  const active = capped.filter(m => !m.deadLetter && !m.retiredAt);
  const failed = capped.filter(m => m.deadLetter?.reason === 'lane-capacity-overflow');
  ok(active.length === 2 && failed.length === 2,
    'V3: the cap bounds active work and retains sender-visible failed receipts instead of deleting notes');
  ok(messageDeliveryState(capped.find(m => m.id === 'seen-old'), 'someone') === 'failed',
    'V3: legacy seen is never trusted as acknowledgement when an overflow is dead-lettered');

  const laneFile = laneFileFor(brainPath, home);
  const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  lane.messages.push({
    id: 'expired-pending', from: 'tx', to: 'rx', text: 'must not disappear',
    ts: now - MESSAGE_FRESH_MS - 1, candidateIds: ['rx'], seen: [],
  });
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  upsertSession({ brainPath, home, now, id: 'rx', client: 'codex' });
  const expired = JSON.parse(fs.readFileSync(laneFile, 'utf8')).messages.find(m => m.id === 'expired-pending');
  ok(expired?.deadLetter?.reason === 'expired-before-consumption'
    && messageDeliveryState(expired, 'rx') === 'failed',
    'V3: TTL expiry leaves a sender-visible failed receipt instead of silently pruning pending work');

  const acknowledgedRows = Array.from({ length: 30 }, (_, index) => ({
    id: `acked-${index}`, from: 'tx', to: 'rx', text: `done ${index}`, ts: now + index + 1,
    candidateIds: index % 2 ? ['rx'] : [], deliveryVersion: 3,
    deliveries: [{ recipientId: 'rx', state: 'acknowledged', acknowledgedAt: now + index + 1 }],
  }));
  const pendingBeforeAcked = {
    id: 'oldest-still-pending', from: 'tx', to: 'rx', text: 'must survive ack receipts', ts: now,
    candidateIds: ['rx'], deliveryVersion: 3, deliveries: [],
  };
  const receiptCapped = capMessages([pendingBeforeAcked, ...acknowledgedRows], 30, now + 100);
  // Eviction still targets the most-progressed note first, but an acknowledged
  // note (already in model context twice) evicts as a visible delivered-
  // unconfirmed retirement — never as a false "failed" dead letter.
  ok(!receiptCapped.find(m => m.id === pendingBeforeAcked.id)?.deadLetter
    && receiptCapped.filter(m => m.deadLetter).length === 0
    && receiptCapped.filter(m => String(m.retirement?.reason || '').includes('lane-capacity-overflow')).length === 1,
  'V3: capacity evicts an acknowledged replay before unseen pending work, as a visible retirement not a false failure');
}

// ── V4: intentAt semantics ───────────────────────────────────────────────────
upsertSession({ brainPath, home, now, id: 'aging', client: 'codex', intent: 'first intent', intentSource: 'declared' });
let sessions = upsertSession({ brainPath, home, now: now + 5 * 60 * 1000, id: 'aging', client: 'codex' });   // heartbeat, no intent
let aging = sessions.find(s => s.id === 'aging');
ok(aging.intentAt === now && aging.intent === 'first intent',
  'V4: a heartbeat refreshes lastSeen but NOT intentAt — the intent keeps its true age');
sessions = upsertSession({ brainPath, home, now: now + 6 * 60 * 1000, id: 'aging', client: 'codex', intent: 'second intent' });
aging = sessions.find(s => s.id === 'aging');
ok(aging.intentAt === now + 6 * 60 * 1000, 'V4: a CHANGED intent re-stamps intentAt');

// ── V5: renderer overflow + intent age ───────────────────────────────────────
{
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: `peer-${i}`, client: 'codex', lastSeen: now, intent: `task ${i}`,
    intentAt: i === 0 ? now - 50 * 60 * 1000 : now,
  }));
  many.push({ id: 'self', client: 'codex', lastSeen: now });
  const text = formatPresenceMessage(many, 'self', { now });
  ok(/and 3 more live session\(s\) not listed/.test(text),
    'V5: >8 peers render an explicit overflow line (v1.32.0 law)');
  ok(/\(intent set 50m ago\)/.test(text),
    'V5: an intent much older than the heartbeat carries its own age');
}

// ── V6: explicit logical identity only ───────────────────────────────────────
{
  const lane = [
    { id: 'me-mcp', hostPid: 111, logicalSessionId: 'logical-me', files: ['src/a.ts'], lastSeen: now },
    { id: 'me-lifecycle', hostPid: 111, logicalSessionId: 'logical-me', files: ['src/a.ts'], lastSeen: now },
    { id: 'same-pid-real-peer', hostPid: 111, files: ['src/a.ts'], lastSeen: now },
    { id: 'real-peer', hostPid: 222, files: ['src/a.ts'], lastSeen: now },
  ];
  const conflicts = findPresenceConflicts(lane, 'me-mcp');
  ok(conflicts.length === 2 && conflicts.some((row) => row.id === 'same-pid-real-peer')
    && conflicts.some((row) => row.id === 'real-peer'),
  'V6: only the explicitly identical logical row is suppressed; a same-pid real peer still conflicts');
  const snap = buildPresenceSnapshot(lane, 'me-mcp', { now });
  ok(snap.suspectedTwinCount === 1 && !snap.peers.some(p => p.id === 'me-lifecycle')
    && snap.peers.some(p => p.id === 'same-pid-real-peer'),
  'V6: the snapshot merges only an explicit logical identity and keeps same-pid peers visible');
}

// ── V7: hostmap rotation source ──────────────────────────────────────────────
{
  const mapFile = laneFileFor(brainPath, home).replace(/\.json$/, '.hostmap');
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, JSON.stringify({ 4242: { sessionId: 'rotated-session', ts: now } }));
  upsertSession({
    brainPath, home, now, id: 'rotated-session', client: 'claude-code',
    channel: 'lifecycle', event: 'UserPromptSubmit', hostPid: 4242,
  });
  ok(hostmapSessionId({ brainPath, hostPid: 4242, home, now: now + 1000 }) === 'rotated-session',
    'V7: a fresh hostmap entry maps host pid → current session id');
  ok(hostmapSessionId({ brainPath, hostPid: 4242, home, now: now + 11 * 60 * 1000 }) === null,
    'V7: a stale hostmap entry (host gone >10m) is ignored');
  ok(hostmapSessionId({ brainPath, hostPid: 9999, home, now: now + 1000 }) === null,
    'V7: an unknown host pid maps to nothing');
  fs.writeFileSync(mapFile, JSON.stringify({ 4242: { sessionId: 'sidecar-ahead-session', ts: now } }));
  ok(hostmapSessionId({ brainPath, hostPid: 4242, home, now: now + 1000 }) === null,
    'V7: a sidecar-ahead id is ignored until its matching lifecycle row commits');
}

// ── V8: the REAL hook — lane row shape, live file observation, message overflow ──
{
  const hookHome = path.join(os.tmpdir(), 'klypix-presvis-hookhome');
  const hookProj = path.join(os.tmpdir(), 'klypix-presvis-hookproj');
  for (const dir of [hookHome, hookProj]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(hookProj, { recursive: true });
  fs.writeFileSync(path.join(hookProj, 'brain.klypix'), await buildKlypixMap({
    title: 'brain', kind: 'brain',
    areas: [{ title: 'Goal', cards: [{ text: 'hook fixture seed' }] }],
  }));
  const env = { ...process.env, HOME: hookHome, USERPROFILE: hookHome, CLAUDE_PID: '31337' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runHook = (args, input) => execFileSync(process.execPath, [HOOK, ...args], {
    cwd: hookProj, env, encoding: 'utf8', input: JSON.stringify(input),
  });
  runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'observe the lane row shape' });
  const sessionsDir = path.join(hookHome, '.claude', 'project-brain', 'sessions');
  const laneFile = fs.readdirSync(sessionsDir).map(f => path.join(sessionsDir, f)).find(f => f.endsWith('.json'));
  let lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  let row = lane.sessions.find(s => s.id === 'sess-v8');
  ok(row && row.client === 'claude-code' && row.hostPid === 31337 && (row.channels || []).includes('lifecycle'),
    'V8: the hook lane row carries client/hostPid/lifecycle-channel (no more client:"unknown")');
  ok(row.intentSource === 'prompt' && typeof row.intentAt === 'number',
    'V8: the raw-prompt intent is provenance-tagged and time-stamped');
  const hostmap = laneFile.replace(/\.json$/, '.hostmap');
  ok(fs.existsSync(hostmap) && JSON.parse(fs.readFileSync(hostmap, 'utf8'))['31337'].sessionId === 'sess-v8',
    'V8: the hook writes the host-pid → session-id hostmap for MCP id rotation');
  // Live file observation (--live with an Edit payload).
  runHook(['--live'], {
    session_id: 'sess-v8',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(hookProj, 'src', 'widget.ts') },
  });
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  row = lane.sessions.find(s => s.id === 'sess-v8');
  ok(Array.isArray(row.files) && row.files.includes('src/widget.ts'),
    'V8: an Edit is observed into the lane files[] mid-session, project-relative PATH form');
  runHook(['--live'], {
    session_id: 'sess-v8',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(os.tmpdir(), 'outside.ts') },
  });
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  row = lane.sessions.find(s => s.id === 'sess-v8');
  ok(!row.files.some(f => f.includes('outside')), 'V8: a path outside the project is never recorded');
  // Review fix F5: a DECLARED-but-EMPTY intent (brain_sync phase "complete"
  // clears it) must not block the raw-prompt fallback for 10 minutes.
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  row = lane.sessions.find(s => s.id === 'sess-v8');
  row.intent = ''; row.intentSource = 'declared'; row.intentAt = Date.now();
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'fallback intent after complete' });
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  row = lane.sessions.find(s => s.id === 'sess-v8');
  ok(/fallback intent after complete/.test(row.intent),
    'V8: an empty declared intent never suppresses the prompt-intent fallback');
  // Message overflow honesty through the real footer.
  lane.messages = Array.from({ length: 8 }, (_, i) => ({
    id: `mm-${i}`, from: 'peerX', to: 'all', text: `unique payload ${i}`, ts: Date.now(), seen: [],
  }));
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const out1 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'deliver my messages' });
  ok(/2 more message\(s\) waiting/.test(out1), 'V8: the 6-cap renders an explicit overflow notice');
  const out2 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'confirm first offers' });
  ok(/unique payload 6/.test(out2) && /unique payload 7/.test(out2),
    'V8: unseen overflow is prioritized ahead of acknowledged replay traffic');
  const out3 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'deliver the rest' });
  ok(/unique payload/.test(out3),
    'V8: still-offered notes remain model-visible on the next action');
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const inbox = lane.messages.filter((message) => /^mm-/.test(message.id));
  ok(inbox.length === 8 && inbox.every((message) =>
    ['offered', 'acknowledged', 'consumed'].includes(messageDeliveryState(message, 'sess-v8'))),
  'V8: every overflowed note reached a token-bearing delivered state (offered/acknowledged/lease-consumed)');
  ok(inbox.some((message) => message.deliveries?.some((delivery) =>
    delivery.recipientId === 'sess-v8' && delivery.consumedVia === 'auto-lease')),
  'V8: notes acknowledged on an earlier action lease-consumed instead of replaying forever');
  for (const message of inbox) {
    const receipt = message.deliveries?.find((delivery) => delivery.recipientId === 'sess-v8');
    consumeMessageReceipt({ brainPath: path.join(hookProj, 'brain.klypix'), sessionId: 'sess-v8',
      messageId: message.id, offerToken: receipt?.offerToken, home: hookHome,
      actionId: `v8-consume-${message.id}` });
  }
  const out4 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'quiet after consumption' });
  ok(!/unique payload/.test(out4),
    'V8: only explicit token-bound consumption silences acknowledged notes');
  fs.rmSync(hookHome, { recursive: true, force: true });
  fs.rmSync(hookProj, { recursive: true, force: true });
}

// ── V9: CRLF conversion is healable, never hand-edited ───────────────────────
{
  const linkProj = path.join(os.tmpdir(), 'klypix-presvis-linkproj');
  fs.rmSync(linkProj, { recursive: true, force: true });
  fs.mkdirSync(linkProj, { recursive: true });
  fs.writeFileSync(path.join(linkProj, 'brain.klypix'), 'placeholder');
  linkProject(linkProj, { version: '9.9.9' });
  const agents = path.join(linkProj, 'AGENTS.md');
  fs.writeFileSync(agents, fs.readFileSync(agents, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  const audit = auditProject(linkProj, { version: '9.9.9' });
  const entry = (audit.files || []).find(f => /AGENTS\.md$/i.test(f.file)) || {};
  ok(entry.status !== 'hand-edited',
    `V9: a CRLF-converted projected file is ${entry.status || '?'} — healable, NOT hand-edited`);
  // A real hand-edit gets a backup before the destructive rewrite.
  fs.writeFileSync(agents, fs.readFileSync(agents, 'utf8').replace('KLYPIX', 'KLYPIX-EDITED'), 'utf8');
  linkProject(linkProj, { version: '9.9.9' });
  ok(fs.existsSync(agents + '.klypix-bak'),
    'V9: rewriting a hand-edited file leaves a .klypix-bak of the human version');
  fs.rmSync(linkProj, { recursive: true, force: true });
}

// ── V10: doctor — impaired supervisor + honest logical/connection counts ─────
{
  const docHome = path.join(os.tmpdir(), 'klypix-presvis-dochome');
  const docProj = path.join(os.tmpdir(), 'klypix-presvis-docproj');
  for (const dir of [docHome, docProj]) fs.rmSync(dir, { recursive: true, force: true });
  const brainDir = path.join(docHome, '.claude', 'project-brain');
  fs.mkdirSync(path.join(brainDir, '.supervisors'), { recursive: true });
  fs.mkdirSync(docProj, { recursive: true });
  fs.writeFileSync(path.join(docProj, 'brain.klypix'), 'placeholder');
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '9.9.9'\nrunMcpSupervisor\n");
  fs.writeFileSync(path.join(brainDir, 'mcp-supervisor.mjs'), '// present');
  // A live-pid supervisor whose status says it has NO worker: the old doctor
  // rendered this healthy; it must now be drift with a reconcile action.
  fs.writeFileSync(path.join(brainDir, '.supervisors', `${process.pid}.json`), JSON.stringify({
    protocol: 1, pid: process.pid, status: 'recovery-failed', active: null,
    lastError: 'candidate worker exited before activation (3221225794)',
  }));
  const laneKey = laneFileFor(path.join(docProj, 'brain.klypix'), docHome);
  fs.mkdirSync(path.dirname(laneKey), { recursive: true });
  fs.writeFileSync(laneKey, JSON.stringify({
    sessions: [
      { id: 'silent-one', client: 'claude-code', lastSeen: Date.now(), files: [], intent: '' },
      { id: 'same-pid-a', client: 'codex', hostPid: 777, lastSeen: Date.now(), intent: 'working' },
      { id: 'same-pid-b', client: 'codex', hostPid: 777, lastSeen: Date.now(), intent: '' },
    ],
    messages: [],
  }));
  const report = doctorInspect({ home: docHome, projectDir: docProj });
  ok(report.layers.supervisor === 'drift', 'V10: a recovery-failed supervisor is DRIFT, not healthy');
  ok(report.actions.some(a => /supervisor pid \d+ has no live worker; tool calls cannot complete/.test(a)),
    'V10: the reconcile block names the impaired supervisor');
  ok(report.sessions.syncedCount === 1 && report.sessions.count === 3,
    `V10: sync-silent sessions are counted distinctly (${report.sessions.syncedCount}/${report.sessions.count} declared scope)`);
  ok(report.sessions.connectionCount === 3 && report.sessions.logicalSessionCount === 3
    && report.sessions.activeCodexConnectionScopedCount === 1
    && (report.sessions.twinGroups || []).length === 0,
  'V10: same-pid Codex rows remain distinct and active connection-scoped identity is surfaced');
  fs.rmSync(docHome, { recursive: true, force: true });
  fs.rmSync(docProj, { recursive: true, force: true });
}

// ── V11: doctor — ACTIVE sync-silent work prevents an ALIGNED verdict ───────
{
  const docHome = path.join(os.tmpdir(), 'klypix-presvis-partial-home');
  const docProj = path.join(os.tmpdir(), 'klypix-presvis-partial-project');
  for (const dir of [docHome, docProj]) fs.rmSync(dir, { recursive: true, force: true });
  const brainDir = path.join(docHome, '.claude', 'project-brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(docProj, { recursive: true });
  fs.writeFileSync(path.join(docProj, 'brain.klypix'), 'placeholder');
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '9.9.9'\nrunMcpSupervisor\n");
  fs.writeFileSync(path.join(brainDir, 'mcp-supervisor.mjs'), '// present');
  linkProject(docProj, { version: '9.9.9' });
  const laneKey = laneFileFor(path.join(docProj, 'brain.klypix'), docHome);
  fs.mkdirSync(path.dirname(laneKey), { recursive: true });
  fs.writeFileSync(laneKey, JSON.stringify({
    sessions: [
      { id: 'scoped', logicalSessionId: 'scoped', identitySource: 'codex-lifecycle',
        client: 'codex', lastSeen: Date.now(), intent: 'editing one file', files: ['src/a.mjs'] },
      { id: 'silent', client: 'other-host', lastSeen: Date.now(), activityAt: Date.now(), activityKind: 'McpToolUse', intent: '', files: [] },
    ],
    messages: [],
  }));
  const report = doctorInspect({ home: docHome, projectDir: docProj });
  ok(report.drifted === 0 && report.verdict === 'PARTIAL',
    `V11: one sync-silent live peer makes an otherwise clean doctor PARTIAL (got ${report.verdict})`);
  ok(report.sessions.activeUnscopedCount === 1 && report.readinessWarnings.some((warning) => /1 active session used KLYPIX/.test(warning)),
    'V11: PARTIAL names the exact session adoption gap');
  fs.rmSync(docHome, { recursive: true, force: true });
  fs.rmSync(docProj, { recursive: true, force: true });
}

// ── V12: an idle connected host is visible but does not fake a readiness gap ─
{
  const docHome = path.join(os.tmpdir(), 'klypix-presvis-idle-home');
  const docProj = path.join(os.tmpdir(), 'klypix-presvis-idle-project');
  for (const dir of [docHome, docProj]) fs.rmSync(dir, { recursive: true, force: true });
  const brainDir = path.join(docHome, '.claude', 'project-brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(docProj, { recursive: true });
  fs.writeFileSync(path.join(docProj, 'brain.klypix'), 'placeholder');
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '9.9.9'\nrunMcpSupervisor\n");
  fs.writeFileSync(path.join(brainDir, 'mcp-supervisor.mjs'), '// present');
  linkProject(docProj, { version: '9.9.9' });
  const laneKey = laneFileFor(path.join(docProj, 'brain.klypix'), docHome);
  fs.mkdirSync(path.dirname(laneKey), { recursive: true });
  fs.writeFileSync(laneKey, JSON.stringify({
    sessions: [
      { id: 'scoped', logicalSessionId: 'scoped', identitySource: 'codex-lifecycle',
        client: 'codex', lastSeen: Date.now(), intent: 'editing one file', files: ['src/a.mjs'] },
      { id: 'idle', client: 'other-host', lastSeen: Date.now(), intent: '', files: [] },
    ],
    messages: [],
  }));
  const report = doctorInspect({ home: docHome, projectDir: docProj });
  ok(report.drifted === 0 && report.verdict === 'ALIGNED',
    `V12: a heartbeat-only idle connection is visible but not graded as failed adoption (got ${report.verdict})`);
  ok(report.sessions.idleUnscopedCount === 1 && report.sessions.activeUnscopedCount === 0,
    'V12: idle/unscoped and active/unscoped connections are counted separately');
  fs.rmSync(docHome, { recursive: true, force: true });
  fs.rmSync(docProj, { recursive: true, force: true });
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n[ok] presence-visibility: all assertions passed');
