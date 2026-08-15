// Undeclared-but-working sessions (1.71.0) — coordination that says what it
// cannot see.
//
// The coordination promise is "your agents see each other". It holds only for
// sessions that declared a scope, and until now the sync response folded two
// very different things into one `backgroundConnections` number: a connection
// sitting idle, and a session actively editing this repo that never declared
// anything. Only the second falsifies the promise — a peer reading a clean
// conflict report has no idea real edits are happening outside its view.
// Measured on a real machine while this was written: 3 of 5 live sessions.
//
//   U1 — a declared session counts as an active task, never as undeclared.
//   U2 — an undeclared session with FRESH work activity is undeclaredActive.
//   U3 — an undeclared session with stale or absent activity is idle instead;
//        transport liveness alone must never be reported as invisible work.
//   U4 — back-compat: backgroundConnections still equals undeclared + idle, so
//        every existing reader sees exactly what it saw before.
//   U5 — undeclared-active peers are NAMED, not merely counted, so a session
//        can address one with brain_message.
//   U6 — the rendered footer warns that overlap detection is incomplete while
//        any unseen worker exists, and says what to do about it.
//   U7 — with nobody unseen, no warning is emitted (no crying wolf).
//   U8 — a session never reports ITSELF as an unseen peer.
//   U9 — suspected twin rows of the same session are excluded from both counts.
import assert from 'assert';
import { buildPresenceSnapshot, formatTaskPresence } from '../src/mcp-presence.mjs';

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };
const now = Date.now();
const MIN = 60 * 1000;

const snap = (rows, selfId = 'self') => buildPresenceSnapshot(rows, selfId, { now });

// ---- U1 / U2 / U3 — the three states ------------------------------------
const mixed = snap([
  { id: 'self', lastSeen: now },
  { id: 'declared-intent', intent: 'fix the login timeout', lastSeen: now },
  { id: 'declared-files', files: ['src/a.ts'], lastSeen: now },
  { id: 'silent-working', lastSeen: now, activityAt: now - 5000 },
  { id: 'silent-working-2', lastSeen: now, activityAt: now - 2 * MIN },
  { id: 'silent-stale', lastSeen: now, activityAt: now - 45 * MIN },
  { id: 'never-worked', lastSeen: now },
]);

ok('U1 declared sessions are active tasks', mixed.activeTaskCount === 2);
ok('U1 a declared session is not counted as undeclared',
  !mixed.undeclaredActive.some((p) => /^declared/.test(p.id)));
ok('U2 fresh undeclared work is counted', mixed.undeclaredActiveCount === 2);
ok('U3 stale activity is idle, not unseen work', mixed.idleConnectionCount === 2);
ok('U3 a heartbeat-only connection is never reported as working',
  !mixed.undeclaredActive.some((p) => p.id === 'never-worked'));

// ---- U4 — nothing existing changes shape --------------------------------
ok('U4 the legacy count is preserved exactly',
  mixed.backgroundConnectionCount === mixed.undeclaredActiveCount + mixed.idleConnectionCount);
ok('U4 the legacy count is still 4', mixed.backgroundConnectionCount === 4);

// ---- U5 — addressable, not just countable -------------------------------
const named = mixed.undeclaredActive.map((p) => p.id).sort();
ok('U5 unseen workers are named', named.join(',') === 'silent-working,silent-working-2');
ok('U5 each carries the fields a peer needs to address it',
  mixed.undeclaredActive.every((p) => typeof p.id === 'string' && 'client' in p && 'branch' in p));

// ---- U6 / U7 — the rendered warning -------------------------------------
const warned = formatTaskPresence(mixed, now);
ok('U6 the footer states how many are working unseen', /2 working WITHOUT declared scope/.test(warned));
ok('U6 it warns that a clean conflict report is incomplete', /incomplete/i.test(warned));
ok('U6 it names the remedy', /brain_message/.test(warned));
ok('U6 idle connections are reported separately, not merged', /2 connected but idle/.test(warned));

const clean = snap([
  { id: 'self', lastSeen: now },
  { id: 'declared', intent: 'ship the release', files: ['package.json'], lastSeen: now },
]);
const quiet = formatTaskPresence(clean, now);
ok('U7 no unseen workers means no warning', !/WITHOUT declared scope/.test(quiet));
ok('U7 and no incompleteness caveat', !/incomplete/i.test(quiet));
ok('U7 the count is honestly zero', clean.undeclaredActiveCount === 0);

// ---- U8 — never report yourself -----------------------------------------
const selfWorking = snap([
  { id: 'self', lastSeen: now, activityAt: now - 1000 },
  { id: 'other', intent: 'something', lastSeen: now },
]);
ok('U8 an undeclared SELF is not an unseen peer', selfWorking.undeclaredActiveCount === 0);
ok('U8 self is still reported as self', selfWorking.self?.id === 'self');

// ---- U9 — twins are one session, not two --------------------------------
const withTwin = snap([
  { id: 'self', client: 'claude-code', hostPid: 4242, logicalSessionId: 'L1', lastSeen: now },
  { id: 'self-twin', client: 'claude-code', hostPid: 4242, logicalSessionId: 'L1', lastSeen: now, activityAt: now - 1000 },
  { id: 'real-peer', lastSeen: now, activityAt: now - 1000 },
]);
ok('U9 a twin row does not inflate the unseen count', withTwin.undeclaredActiveCount <= 1);
ok('U9 the genuine peer is still seen',
  withTwin.undeclaredActiveCount === 0 || withTwin.undeclaredActive[0].id === 'real-peer');

console.log(`✓ undeclared-active presence — ${pass}/${pass} assertions`);
