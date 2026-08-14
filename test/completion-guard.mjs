// 2026-08-14 wave — turn-end vs task-end for brain_sync phase "complete":
//   G1 — a complete with no results, moments after task start, with no
//        intervening checkpoint DOWNGRADES to a scope-preserving checkpoint
//        (structured.status 'complete-deferred' + completionDeferred record);
//   G2 — a complete after an explicit checkpoint keeps full semantics;
//   G3 — a mature task (past PREMATURE_COMPLETE_WINDOW_MS) completes normally
//        even without a checkpoint;
//   G4 — a complete with nothing declared (or as a worker's first sync) is
//        never deferred;
//   G5 — peer ids in the brain_sync footer grow past the fixed 12-char slice
//        until unique (same-window UUIDv7 peers).
// A complete WITH results keeps full semantics — locked by test/result-reconcile.mjs
// (result-session-a completes straight from start with a manifest and clears).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { laneFileFor, upsertSession } from '../src/agent-presence.mjs';
import { createMcpPresence, PREMATURE_COMPLETE_WINDOW_MS } from '../src/mcp-presence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-completion-guard-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');

const fakeServer = { server: { getClientVersion: () => ({ name: 'codex', version: 'test' }) }, sendLoggingMessage() {} };
const timer = () => ({ unref() {} });
let clock = 2_600_000_000_000;
const worker = (id) => createMcpPresence({
  server: fakeServer,
  initialVault: project,
  env: { KLYPIX_SESSION_ID: id },
  home,
  now: () => clock,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
const laneRow = (id) => JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'))
  .sessions.find((row) => row.id === id);

try {
  // ── G1: premature complete downgrades and RETAINS scope ────────────────────
  const mcp = worker('guard-sess');
  mcp.start();
  mcp.sync({ phase: 'start', intent: 'wire the completion guard', files: ['src/mcp-presence.mjs'] });
  clock += 1000;
  const deferred = mcp.sync({ phase: 'complete' });
  ok(deferred.isError !== true && deferred.structured?.status === 'complete-deferred',
    'G1: a result-less complete right after start reports complete-deferred, not an error');
  ok(deferred.structured?.completionDeferred?.reason === 'premature-complete-no-results'
    && deferred.structured.completionDeferred.scopeRetained === true
    && Number.isFinite(deferred.structured.completionDeferred.sinceTaskStartMs),
  'G1: the machine-readable deferral record says why and that scope was retained');
  ok(/completion deferred/i.test(deferred.text) && /RETAINED/.test(deferred.text),
    'G1: the model-facing text explains the deferral in prose');
  let row = laneRow('guard-sess');
  ok(row?.intent === 'wire the completion guard' && (row.files || []).includes('src/mcp-presence.mjs'),
    'G1: the lane still shows the declared intent/files to every peer');

  // ── G2: checkpoint → complete keeps the full completion contract ───────────
  clock += 1000;
  mcp.sync({ phase: 'checkpoint' });
  clock += 1000;
  const done = mcp.sync({ phase: 'complete' });
  row = laneRow('guard-sess');
  ok(done.isError !== true && done.structured?.status === 'complete'
    && done.structured.completionDeferred === undefined
    && row?.intent === '' && (row.files || []).length === 0,
  'G2: a complete after an explicit checkpoint clears intent/files as before');

  // ── G3: a mature task completes without a checkpoint ───────────────────────
  clock += 1000;
  mcp.sync({ phase: 'start', intent: 'long-running task', files: ['src/agent-presence.mjs'] });
  // Heartbeats (not checkpoints) keep the row alive across the window.
  clock += Math.floor(PREMATURE_COMPLETE_WINDOW_MS / 2);
  mcp.touch({ event: 'McpToolUse' });
  clock += Math.floor(PREMATURE_COMPLETE_WINDOW_MS / 2) + 1000;
  const mature = mcp.sync({ phase: 'complete' });
  row = laneRow('guard-sess');
  ok(mature.isError !== true && mature.structured?.status === 'complete'
    && row?.intent === '' && (row.files || []).length === 0,
  'G3: past the premature window a result-less complete is a real task end');

  // ── G4: nothing declared / first-ever sync is never deferred ───────────────
  const fresh = worker('guard-fresh');
  fresh.start();
  const freshComplete = fresh.sync({ phase: 'complete' });
  ok(freshComplete.isError !== true && freshComplete.structured?.status === 'complete',
    'G4: a worker whose first sync is a complete keeps the legacy contract (no scope to protect)');

  // ── G5: footer peer ids grow past the fixed 12-char slice ──────────────────
  const shared = 'uuidprefix-shared';
  upsertSession({
    brainPath, home, now: clock, id: `${shared}-alpha`, client: 'codex', channel: 'mcp',
    intent: 'first twin-prefix peer',
  });
  upsertSession({
    brainPath, home, now: clock, id: `${shared}-beta`, client: 'codex', channel: 'mcp',
    intent: 'second twin-prefix peer',
  });
  const view = mcp.sync({ phase: 'checkpoint', intent: 'render shared-prefix peers' });
  ok(view.text.includes(`- ${shared}-a:`) && view.text.includes(`- ${shared}-b:`),
    'G5: brain_sync peer lines grow each id prefix until unique');
  ok(!view.text.includes(`- ${shared.slice(0, 12)}:`),
    'G5: the old ambiguous fixed 12-char slice is gone');

  mcp.stop();
  fresh.stop();
  console.log(failures ? `\n[x] ${failures} completion-guard assertion(s) failed` : '\n[ok] completion-guard: all assertions passed');
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(failures ? 1 : 0);
