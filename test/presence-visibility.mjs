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
//   V6 — twin suppression: same-hostPid rows never raise a conflict against
//        their own session; different hosts still do.
//   V7 — hostmapSessionId follows the hook-written host-pid → session-id map.
//   V8 — the REAL hook stamps client/channel/hostPid on its lane row, observes
//        write-tool file scope live (--live) in PATH form, and its message
//        footer delivers-then-acks with an explicit overflow notice.
//   V9 — CRLF conversion of a projected harness file classifies as healable
//        (stale/ok), never hand-edited; hand-edited rewrites leave a .klypix-bak.
//   V10 — brain_doctor: a recovery-failed supervisor is DRIFT, not healthy;
//        sync-silent sessions and twin rows are called out.
//   V11 — otherwise-healthy multi-session state with a sync-silent peer is
//        PARTIAL, never the misleading ALIGNED all-clear.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  capMessages,
  formatPresenceMessage,
  laneFileFor,
  MESSAGE_FRESH_MS,
  messageDeliveryState,
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
ok(resolveMcpSessionId({ env: {}, pid: 7, nonce: 'aaaa' }) === 'mcp-7-aaaa',
  'V1: no env → pid-nonce fallback unchanged');

// ── V2: deliver-then-ack (no silent message destruction) ─────────────────────
upsertSession({ brainPath, home, now, id: 'rx', client: 'codex' });
for (let i = 0; i < 8; i++) {
  postPresenceMessage({ brainPath, home, now: now + i, from: 'tx', to: 'all', text: `note number ${i}` });
}
const firstBatch = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 100 });
ok(firstBatch.length === 6, `V2: first receive delivers the 6-cap (got ${firstBatch.length})`);
const replayBatch = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 200 });
ok(replayBatch.length === 6 && replayBatch.every(m => firstBatch.some(f => f.id === m.id)),
  'V2: the first six replay once on a later in-band action before acknowledgement');
const overflowOffer = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 300 });
ok(overflowOffer.length === 2 && overflowOffer.every(m => !firstBatch.some(f => f.id === m.id)),
  `V2: overflow remains pending until acknowledged messages clear (got ${overflowOffer.length})`);
const overflowAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 400 });
ok(overflowAck.length === 2 && overflowAck.every(m => overflowOffer.some(f => f.id === m.id)),
  'V2: overflow also replays once before its later-action acknowledgement');
ok(receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 500 }).length === 0,
  'V2: nothing re-delivers after every offer has a later-action acknowledgement');

postPresenceMessage({ brainPath, home, now: now + 510, from: 'tx-a', to: 'all', text: 'same coordination text' });
postPresenceMessage({ brainPath, home, now: now + 511, from: 'tx-b', to: 'all', text: 'same coordination text' });
const twoSendersOffer = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 520 });
const twoSendersAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 530 });
ok(twoSendersOffer.length === 2 && new Set(twoSendersOffer.map(message => message.from)).size === 2
  && twoSendersAck.length === 2,
'V2: identical text from different senders keeps both attributions and advances each receipt honestly');
postPresenceMessage({ brainPath, home, now: now + 540, from: 'peer-copy', to: 'rx', text: 'same as my just-sent note' });
ok(receiveMessages({
  brainPath, sessionId: 'rx', home, now: now + 550, ignoreTexts: ['same as my just-sent note'],
}).length === 0,
'V2: transcript self-echo compatibility suppresses matching text for only the current response');
const peerCopy = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 560 });
ok(peerCopy.length === 1 && peerCopy[0].from === 'peer-copy',
  'V2: a genuine peer note identical to my text remains pending and reaches the next model-context action');
receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 565 });
postPresenceMessage({ brainPath, home, now: now + 570, from: 'tx-action', to: 'rx', text: 'do not ack inside one tool action' });
const preToolOffer = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 580, actionId: 'tool:tool-1' });
const sameToolPost = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 590, actionId: 'tool:tool-1' });
const laterActionAck = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 600, actionId: 'turn:prompt-2' });
ok(preToolOffer.length === 1 && sameToolPost.length === 0 && laterActionAck.length === 1,
  'V2: PreToolUse/PostToolUse for one tool cannot self-ack; only a distinct later action acknowledges the offer');

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
  ok(expired?.deadLetter?.reason === 'expired-before-acknowledgement'
    && messageDeliveryState(expired, 'rx') === 'failed',
    'V3: TTL expiry leaves a sender-visible failed receipt instead of silently pruning pending work');

  const acknowledgedRows = Array.from({ length: 30 }, (_, index) => ({
    id: `acked-${index}`, from: 'tx', to: 'rx', text: `done ${index}`, ts: now + index + 1,
    candidateIds: index % 2 ? ['rx'] : [], deliveryVersion: 2,
    deliveries: [{ recipientId: 'rx', state: 'acknowledged', acknowledgedAt: now + index + 1 }],
  }));
  const pendingBeforeAcked = {
    id: 'oldest-still-pending', from: 'tx', to: 'rx', text: 'must survive ack receipts', ts: now,
    candidateIds: ['rx'], deliveryVersion: 2, deliveries: [],
  };
  const receiptCapped = capMessages([pendingBeforeAcked, ...acknowledgedRows], 30, now + 100);
  ok(!receiptCapped.find(m => m.id === pendingBeforeAcked.id)?.deadLetter
    && receiptCapped.filter(m => m.retiredAt).length === 30,
  'V3: fully acknowledged snapshot and late-recipient receipts retire before cap selection and cannot evict pending work');
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

// ── V6: twin suppression by hostPid ──────────────────────────────────────────
{
  const lane = [
    { id: 'me-mcp', hostPid: 111, files: ['src/a.ts'], lastSeen: now },
    { id: 'me-lifecycle', hostPid: 111, files: ['src/a.ts'], lastSeen: now },
    { id: 'real-peer', hostPid: 222, files: ['src/a.ts'], lastSeen: now },
  ];
  const conflicts = findPresenceConflicts(lane, 'me-mcp');
  ok(conflicts.length === 1 && conflicts[0].id === 'real-peer',
    'V6: a same-hostPid twin row never raises a conflict against its own session; a real peer still does');
  const snap = buildPresenceSnapshot(lane, 'me-mcp', { now });
  ok(snap.suspectedTwinCount === 1 && !snap.peers.some(p => p.id === 'me-lifecycle'),
    'V6: the snapshot counts the twin explicitly instead of listing it as a peer');
}

// ── V7: hostmap rotation source ──────────────────────────────────────────────
{
  const mapFile = laneFileFor(brainPath, home).replace(/\.json$/, '.hostmap');
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, JSON.stringify({ 4242: { sessionId: 'rotated-session', ts: now } }));
  ok(hostmapSessionId({ brainPath, hostPid: 4242, home, now: now + 1000 }) === 'rotated-session',
    'V7: a fresh hostmap entry maps host pid → current session id');
  ok(hostmapSessionId({ brainPath, hostPid: 4242, home, now: now + 11 * 60 * 1000 }) === null,
    'V7: a stale hostmap entry (host gone >10m) is ignored');
  ok(hostmapSessionId({ brainPath, hostPid: 9999, home, now: now + 1000 }) === null,
    'V7: an unknown host pid maps to nothing');
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
  ok(/unique payload 0/.test(out2) && !/unique payload 6/.test(out2),
    'V8: the real hook replays its first model-context offer before acknowledging it');
  const out3 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'deliver the rest' });
  ok(/unique payload 6/.test(out3) && /unique payload 7/.test(out3),
    'V8: overflow survives until acknowledged messages clear, then reaches model context');
  const out4 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'confirm overflow' });
  const out5 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'quiet now' });
  ok(/unique payload 6/.test(out4) && !/unique payload/.test(out5),
    'V8: overflow replays once, then a later prompt acknowledges and silences it');
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

// ── V10: doctor — impaired supervisor + sync-silent/twin session flags ───────
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
      { id: 'twin-a', client: 'claude-code', hostPid: 777, lastSeen: Date.now(), intent: 'working' },
      { id: 'twin-b', client: 'claude-code', hostPid: 777, lastSeen: Date.now(), intent: '' },
    ],
    messages: [],
  }));
  const report = doctorInspect({ home: docHome, projectDir: docProj });
  ok(report.layers.supervisor === 'drift', 'V10: a recovery-failed supervisor is DRIFT, not healthy');
  ok(report.actions.some(a => /supervisor pid \d+ is recovery-failed/.test(a)),
    'V10: the reconcile block names the impaired supervisor');
  ok(report.sessions.syncedCount === 1 && report.sessions.count === 3,
    `V10: sync-silent sessions are counted distinctly (${report.sessions.syncedCount}/${report.sessions.count} declared scope)`);
  ok((report.sessions.twinGroups || []).some(g => g.hostPid === 777),
    'V10: twin lane rows sharing one host pid are surfaced as a merge failure');
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
      { id: 'scoped', client: 'codex', lastSeen: Date.now(), intent: 'editing one file', files: ['src/a.mjs'] },
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
      { id: 'scoped', client: 'codex', lastSeen: Date.now(), intent: 'editing one file', files: ['src/a.mjs'] },
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
