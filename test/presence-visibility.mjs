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
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  capMessages,
  formatPresenceMessage,
  laneFileFor,
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
const secondBatch = receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 200 });
ok(secondBatch.length === 2 && secondBatch.every(m => !firstBatch.some(f => f.id === m.id)),
  `V2: the 2 overflow messages arrive on the NEXT receive instead of being acked-unseen (got ${secondBatch.length})`);
ok(receiveMessages({ brainPath, sessionId: 'rx', home, now: now + 300 }).length === 0,
  'V2: nothing re-delivers after everything was actually shown');

// ── V3: cap prefers evicting delivered messages ──────────────────────────────
{
  const msgs = [
    { id: 'seen-old', ts: 1, seen: ['someone'] },
    { id: 'unseen-old', ts: 2, seen: [] },
    { id: 'seen-new', ts: 3, seen: ['someone'] },
    { id: 'unseen-new', ts: 4, seen: [] },
  ];
  const capped = capMessages(msgs, 2);
  ok(capped.length === 2 && capped.every(m => m.seen.length === 0),
    'V3: eviction removes delivered messages first — undelivered notes survive the cap');
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
  const out2 = runHook(['--prompt'], { session_id: 'sess-v8', prompt: 'deliver the rest' });
  ok(/unique payload 6/.test(out2) && /unique payload 7/.test(out2),
    'V8: the overflow messages ARRIVE next prompt instead of being destroyed');
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

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n[ok] presence-visibility: all assertions passed');
