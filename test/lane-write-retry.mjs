// Lane writes survive a busy lane (1.88.x follow-up to the session mailbox).
//
// THE incident (2026-10-02, 15-23 live sessions on one project): the lane's
// atomic rename retried exactly once, lost the race 16 times in six hours, and
// each loss was a thrown EPERM - a hook heartbeat dropped, a delivery skipped,
// and once an MCP tool call (brain_note) failed outright for a reason that had
// nothing to do with the note.
//
// The contract under test:
//   R1  a transient EPERM / EACCES / EBUSY is retried with a bounded backoff
//       and the write lands;
//   R2  anything else (ENOENT ...) is NOT retried;
//   R3  a persistent hold gives up after 1 + 4 attempts and rethrows;
//   R4  a heartbeat whose write still fails is REPORTED (laneWriteOk false,
//       'write-failed:<code>'), never thrown, and the lane bytes are untouched;
//   R5  a send whose write still fails returns posted:false with the same
//       reason, never throws, and posts nothing;
//   R6  no tmp file is left behind on either outcome;
//   R7  the Claude hook twin retries the same way (same codes, same backoff).
//
// Run:  node test/lane-write-retry.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LANE_RENAME_BACKOFF_MS,
  laneFileFor,
  postPresenceMessage,
  renameWithRetry,
  upsertSession,
} from '../src/agent-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };
const failWith = (code) => { const error = new Error(`${code}: simulated`); error.code = code; return error; };

// -- R1-R3: the pure helper ---------------------------------------------------
{
  const slept = [];
  let calls = 0;
  const attempts = renameWithRetry('a', 'b', {
    rename: () => { calls++; if (calls <= 2) throw failWith('EPERM'); },
    sleep: (ms) => slept.push(ms),
  });
  ok(attempts === 3 && calls === 3 && slept.join(',') === '10,25',
    `R1 a transient EPERM is retried with backoff and lands on attempt 3 (slept ${slept.join(',')})`);

  for (const code of ['EACCES', 'EBUSY']) {
    let n = 0;
    const took = renameWithRetry('a', 'b', { rename: () => { n++; if (n === 1) throw failWith(code); }, sleep: () => {} });
    ok(took === 2, `R1 ${code} is retryable too`);
  }

  let enoent = 0;
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { enoent++; throw failWith('ENOENT'); }, sleep: () => {} }),
    (error) => error.code === 'ENOENT');
  ok(enoent === 1, 'R2 a non-retryable error is thrown at once, with no retry');

  const persistentSleeps = [];
  let persistent = 0;
  assert.throws(() => renameWithRetry('a', 'b', {
    rename: () => { persistent++; throw failWith('EPERM'); },
    sleep: (ms) => persistentSleeps.push(ms),
  }), (error) => error.code === 'EPERM');
  ok(persistent === 1 + LANE_RENAME_BACKOFF_MS.length && persistentSleeps.join(',') === LANE_RENAME_BACKOFF_MS.join(','),
    `R3 a persistent hold gives up after ${1 + LANE_RENAME_BACKOFF_MS.length} attempts (${persistentSleeps.join(',')} ms) and rethrows`);
  ok(LANE_RENAME_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) <= 250,
    'R3 the whole backoff stays well inside a peer\'s lane-lock budget');
}

// -- R1, R4-R6: the engine's real writers --------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-lane-retry-'));
const realRename = fs.renameSync;
try {
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const brainPath = path.join(project, 'brain.klypix');
  fs.writeFileSync(brainPath, 'fixture');
  const laneFile = laneFileFor(brainPath, home);
  const now = 2_400_000_000_000;
  const tmpLeft = () => fs.readdirSync(path.dirname(laneFile)).filter((name) => name.includes('.tmp-'));

  upsertSession({ brainPath, home, now, id: 'peer-session-0001', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: 'peer-session-0001' });

  // Transient hold: the first two renames onto the lane fail, then it clears.
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (String(to) === laneFile) { calls++; if (calls <= 2) throw failWith('EPERM'); }
    return realRename(from, to);
  };
  const landed = upsertSession({ brainPath, home, now: now + 1, id: 'me-session-0002', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: 'me-session-0002' });
  ok(landed.laneWriteOk === true && calls === 3
    && JSON.parse(fs.readFileSync(laneFile, 'utf8')).sessions.some((s) => s.id === 'me-session-0002'),
    'R1 a heartbeat survives a transient hold on the lane file: retried, written');
  ok(tmpLeft().length === 0, 'R6 no tmp file is left after a retried write');

  // Persistent hold: every rename onto the lane fails.
  const before = fs.readFileSync(laneFile, 'utf8');
  let persistentCalls = 0;
  fs.renameSync = (from, to) => {
    if (String(to) === laneFile) { persistentCalls++; throw failWith('EPERM'); }
    return realRename(from, to);
  };
  let heartbeat;
  assert.doesNotThrow(() => {
    heartbeat = upsertSession({ brainPath, home, now: now + 2, id: 'me-session-0002', channel: 'mcp', event: 'McpToolUse', intent: 'this touch must not land' });
  });
  ok(heartbeat.laneWriteOk === false && heartbeat.laneWriteSkippedReason === 'write-failed:EPERM'
    && persistentCalls === 1 + LANE_RENAME_BACKOFF_MS.length,
    'R4 a heartbeat whose write still fails is reported (write-failed:EPERM), never thrown');
  ok(fs.readFileSync(laneFile, 'utf8') === before && !heartbeat.some((s) => s.intent === 'this touch must not land'),
    'R4 the lane bytes are untouched and the returned snapshot does not claim the failed touch');

  let send;
  assert.doesNotThrow(() => {
    send = postPresenceMessage({ brainPath, home, now: now + 3, from: 'me-session-0002', to: 'peer-session-0001', text: 'this note must not be claimed as posted' });
  });
  ok(send.posted === false && send.message === null && send.reason === 'write-failed:EPERM',
    'R5 a send whose write still fails returns posted:false with write-failed:EPERM, never throws');
  ok(fs.readFileSync(laneFile, 'utf8') === before, 'R5 nothing was posted to the lane');
  ok(tmpLeft().length === 0, 'R6 no tmp file is left after a failed write');

  // The hold clears: the same send now lands.
  fs.renameSync = realRename;
  const retried = postPresenceMessage({ brainPath, home, now: now + 4, from: 'me-session-0002', to: 'peer-session-0001', text: 'this note lands once the lane is free' });
  ok(retried.posted === true, 'R5 the same send succeeds once the hold clears');
} finally {
  fs.renameSync = realRename;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// -- R7: the Claude hook twin ---------------------------------------------------
const homeH = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-lane-retry-hook-'));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NO_MAIN: process.env.KLYPIX_BRAIN_NO_MAIN, CLAUDE_PID: process.env.CLAUDE_PID };
const prevCwd = process.cwd();
try {
  const projectH = path.join(homeH, 'project');
  fs.mkdirSync(projectH, { recursive: true });
  fs.writeFileSync(path.join(projectH, 'brain.klypix'), 'fixture');
  process.env.HOME = homeH;
  process.env.USERPROFILE = homeH;
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';
  delete process.env.CLAUDE_PID;
  process.chdir(projectH);
  const hookUrl = new URL('../src/global-brain-hook.mjs', import.meta.url);
  hookUrl.searchParams.set('lane-retry-test', String(Date.now()));
  const { SESSIONS_FILE, renameRetry, touchSession } = await import(hookUrl.href);

  const slept = [];
  let n = 0;
  const took = renameRetry('a', 'b', () => { n++; if (n <= 3) throw failWith('EBUSY'); }, (ms) => slept.push(ms));
  ok(took === 4 && slept.join(',') === '10,25,50', `R7 the hook's rename backs off the same way (slept ${slept.join(',')})`);
  let hookPersistent = 0;
  assert.throws(() => renameRetry('a', 'b', () => { hookPersistent++; throw failWith('EPERM'); }, () => {}),
    (error) => error.code === 'EPERM');
  ok(hookPersistent === 5, 'R7 the hook gives up after the same 1 + 4 attempts');
  let hookEnoent = 0;
  assert.throws(() => renameRetry('a', 'b', () => { hookEnoent++; throw failWith('ENOENT'); }, () => {}), (error) => error.code === 'ENOENT');
  ok(hookEnoent === 1, 'R7 the hook does not retry a non-retryable error');

  let hookCalls = 0;
  fs.renameSync = (from, to) => {
    if (String(to) === SESSIONS_FILE) { hookCalls++; if (hookCalls <= 2) throw failWith('EPERM'); }
    return realRename(from, to);
  };
  const touched = touchSession('hook-session-0003', { branch: 'master' });
  ok(touched.ok === true && hookCalls === 3
    && JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')).sessions.some((s) => s.id === 'hook-session-0003'),
    'R7 a hook heartbeat survives a transient hold on the lane file');
  fs.renameSync = (from, to) => { if (String(to) === SESSIONS_FILE) throw failWith('EPERM'); return realRename(from, to); };
  let failed;
  assert.doesNotThrow(() => { failed = touchSession('hook-session-0003', { branch: 'other' }); });
  ok(failed.ok === false && /EPERM/.test(String(failed.reason)), 'R7 a hook heartbeat that still fails is reported, never thrown');
  fs.renameSync = realRename;
  ok(fs.readdirSync(path.dirname(SESSIONS_FILE)).filter((name) => name.includes('.tmp-')).length === 0,
    'R7 the hook leaves no tmp file behind');

  // Parity pin: the two writers must keep the same codes and backoff.
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8').replace(/\r/g, '');
  const engineSrc = read('agent-presence.mjs');
  const hookSrc = read('global-brain-hook.mjs');
  const codes = "new Set(['EPERM', 'EACCES', 'EBUSY'])";
  ok(engineSrc.includes(codes) && hookSrc.includes(codes) && engineSrc.includes('[10, 25, 50, 100]') && hookSrc.includes('[10, 25, 50, 100]'),
    'R7 engine and hook carry the same retryable codes and the same backoff');
} finally {
  fs.renameSync = realRename;
  process.chdir(prevCwd);
  process.env.HOME = prev.HOME;
  process.env.USERPROFILE = prev.USERPROFILE;
  if (prev.NO_MAIN === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = prev.NO_MAIN;
  if (prev.CLAUDE_PID !== undefined) process.env.CLAUDE_PID = prev.CLAUDE_PID;
  fs.rmSync(homeH, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n[ok] lane-write-retry: all ${checks} assertions passed`);
