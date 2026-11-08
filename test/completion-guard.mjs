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
import { execFileSync } from 'child_process';
import { laneFileFor, removeSession, upsertSession } from '../src/agent-presence.mjs';
import { completionIntegrationReport, createMcpPresence, PREMATURE_COMPLETE_WINDOW_MS } from '../src/mcp-presence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-completion-guard-'));
const originalCwd = process.cwd();
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');

const fakeServer = { server: { getClientVersion: () => ({ name: 'codex', version: 'test' }) }, sendLoggingMessage() {} };
const timer = () => ({ unref() {} });
let clock = 2_600_000_000_000;
const worker = (id, initialVault = project) => createMcpPresence({
  server: fakeServer,
  initialVault,
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

  // ── G6–G14: completion is not proof of branch integration ────────────────
  // Real git fixtures live ONLY in this test's fresh temp directory. git's
  // global/system config and hooks are isolated from the user's install.
  const integrationProject = path.join(home, 'integration-project');
  fs.mkdirSync(path.join(integrationProject, 'src'), { recursive: true });
  const integrationBrain = path.join(integrationProject, 'brain.klypix');
  fs.writeFileSync(integrationBrain, 'fixture');
  const gitEnv = { ...process.env, HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const gitAt = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(home, 'no-hooks')}`, ...args],
  { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...args) => gitAt(integrationProject, ...args);
  const sharedFile = path.join(integrationProject, 'src', 'shared.js');
  const writeShared = (line) => fs.writeFileSync(sharedFile, `first\n${line}\nlast\n`);
  git('init', '-q', '-b', 'main');
  writeShared('base');
  fs.writeFileSync(path.join(integrationProject, 'AGENTS.md'), 'base instructions\n');
  git('add', 'src/shared.js', 'AGENTS.md'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'peer');
  writeShared('peer change'); git('commit', '-qam', 'peer change');
  git('checkout', '-qb', 'mine', 'main');
  writeShared('my change'); git('commit', '-qam', 'my change');
  git('branch', 'unmerged-mine');
  process.chdir(integrationProject);
  const integrationWorker = worker('integration-self', integrationProject);
  integrationWorker.start();
  const seedPeer = (branch = 'peer') => upsertSession({
    brainPath: integrationBrain, home, now: clock, id: 'integration-peer', client: 'codex',
    branch, cwd: integrationProject, intent: 'peer branch work', files: ['src/shared.js'],
  });
  const endPeer = () => removeSession({ brainPath: integrationBrain, home, now: clock, id: 'integration-peer' });
  const begin = () => {
    clock += 1000;
    const view = integrationWorker.sync({ phase: 'start', intent: 'change shared behavior', files: ['src/shared.js'] });
    integrationWorker.sync({ phase: 'checkpoint' });
    return view;
  };
  const finish = () => integrationWorker.sync({ phase: 'complete' });
  seedPeer();
  const active = begin();
  ok(active.conflicts.some((conflict) => conflict.kind === 'merge-conflict'),
    'G6: fixture starts with a real committed merge conflict');
  endPeer();
  const conflicted = finish();
  const checked = conflicted.structured.completionIntegration;
  ok(checked?.status === 'conflict' && checked.committedOnly === true
    && checked.checks[0].files.join() === 'src/shared.js'
    && checked.checks[0].refs.mine.startsWith('mine@') && checked.checks[0].refs.theirs.startsWith('peer@'),
  'G6: completion rechecks the known peer branch even after the peer stops');
  ok(conflicted.structured.status === 'complete' && conflicted.structured.self.intent === ''
    && conflicted.structured.self.files.length === 0 && conflicted.conflicts.length === 0,
  'G6: unresolved integration is separate from live scope; completion releases its reservation');
  ok(/Unresolved merge conflict/.test(conflicted.text) && /In your final reply/.test(conflicted.text)
    && /a message sent is not agreement/.test(conflicted.text)
    && !/No exact file overlap/.test(conflicted.text),
  'G6: completion retains the integration warning and next-step guidance without a misleading all-clear');

  begin();
  ok(finish().structured.completionIntegration === undefined,
    'G7: a new task with no peer does not inherit the previous task\'s integration warning');

  seedPeer(); begin();
  try { git('merge', '--no-commit', 'peer'); } catch { /* expected textual conflict */ }
  writeShared('both changes integrated'); git('add', 'src/shared.js'); git('commit', '-qm', 'integrate peer');
  endPeer();
  const integrated = finish();
  ok(integrated.structured.completionIntegration?.status === 'clear'
    && integrated.structured.completionIntegration.checks[0].status === 'clear'
    && !/Unresolved merge conflict/.test(integrated.text),
  'G8: completion re-reads changed refs and clears a conflict after a real merge');

  git('branch', 'removed-peer', 'main'); seedPeer('removed-peer'); begin();
  endPeer(); git('branch', '-D', 'removed-peer');
  const missing = finish();
  ok(missing.structured.completionIntegration?.status === 'unknown'
    && missing.structured.completionIntegration.checks[0].reason === 'refs-or-merge-check-unavailable'
    && /Integration unknown/.test(missing.text) && missing.structured.self.files.length === 0,
  'G9: a disappeared peer ref is unknown, never resolved, and does not retain active scope');
  const failedProbe = completionIntegrationReport({ repoDir: integrationProject, branch: 'mine',
    peers: [{ id: 'p', branch: 'peer' }], mergeTree() { throw new Error('unreadable repository'); } });
  ok(failedProbe?.status === 'unknown' && failedProbe.checks[0].status === 'unknown',
    'G9: an unreadable merge probe is explicitly unknown');
  let probeClock = 0;
  const budgeted = completionIntegrationReport({ repoDir: integrationProject, branch: 'mine',
    peers: [{ id: 'p', branch: 'peer' }], budgetMs: 1, clock: () => (probeClock += 10),
    mergeTree() { throw new Error('must not run past the budget'); } });
  ok(budgeted?.status === 'unknown' && budgeted.checks[0].reason === 'probe-budget-exhausted',
    'G9: an exhausted completion probe budget reports unknown instead of a clean result');

  // The overlap report intentionally suppresses managed paths. A textual
  // conflict there still prevents completion from claiming integration clear.
  git('checkout', '-qb', 'managed-peer', 'main');
  fs.writeFileSync(path.join(integrationProject, 'AGENTS.md'), 'peer instructions\n');
  git('commit', '-qam', 'peer managed file');
  git('checkout', '-qb', 'managed-mine', 'main');
  fs.writeFileSync(path.join(integrationProject, 'AGENTS.md'), 'my instructions\n');
  git('commit', '-qam', 'my managed file');
  seedPeer('managed-peer'); begin(); endPeer();
  const filtered = finish();
  ok(filtered.structured.completionIntegration?.status === 'unknown'
    && filtered.structured.completionIntegration.checks[0].reason === 'excluded-generated-conflicts'
    && /Git found conflicts in managed paths/.test(filtered.text)
    && !/No merge conflict in the checked commits/.test(filtered.text),
  'G12: conflicts filtered from active overlap cannot produce a completion all-clear');

  // An IDE may launch the MCP server in a DIFFERENT repository. A coincident
  // branch name there must not select that name's (integrated) tip here.
  git('checkout', '-q', 'unmerged-mine');
  const unrelatedRepo = path.join(home, 'unrelated-repository');
  fs.mkdirSync(unrelatedRepo);
  gitAt(unrelatedRepo, 'init', '-q', '-b', 'mine');
  fs.writeFileSync(path.join(unrelatedRepo, 'other.txt'), 'unrelated\n');
  gitAt(unrelatedRepo, 'add', 'other.txt'); gitAt(unrelatedRepo, 'commit', '-qm', 'unrelated');
  process.chdir(unrelatedRepo);
  seedPeer();
  const unrelatedStart = begin(); endPeer();
  const unrelatedFinish = finish();
  ok(unrelatedStart.structured.self.branch === 'unmerged-mine'
    && unrelatedFinish.structured.completionIntegration?.status === 'conflict'
    && unrelatedFinish.structured.completionIntegration.checks[0].refs.mine.startsWith('unmerged-mine@'),
  'G13: an unrelated host repository cannot substitute a coincident branch name for the selected project');

  // A REAL linked worktree is the opposite: use that session's branch, not
  // the selected brain checkout's integrated branch.
  process.chdir(integrationProject);
  git('checkout', '-q', 'mine');
  const linkedCheckout = path.join(home, 'linked-checkout');
  git('worktree', 'add', '-q', linkedCheckout, 'unmerged-mine');
  process.chdir(linkedCheckout);
  seedPeer();
  const linkedStart = begin(); endPeer();
  const linkedFinish = finish();
  ok(linkedStart.structured.self.branch === 'unmerged-mine'
    && linkedFinish.structured.completionIntegration?.status === 'conflict'
    && linkedFinish.structured.completionIntegration.checks[0].refs.mine.startsWith('unmerged-mine@'),
  'G14: a linked worktree in the same git family still supplies the session branch');
  process.chdir(integrationProject);

  seedPeer(); begin(); endPeer();
  // New start without completing the old task is also a hard boundary.
  begin();
  ok(finish().structured.completionIntegration === undefined,
    'G10: replacing a task clears remembered peers even when the old task never completed');

  seedPeer(); begin(); endPeer();
  const otherProject = path.join(home, 'other-project');
  fs.mkdirSync(otherProject);
  fs.writeFileSync(path.join(otherProject, 'brain.klypix'), 'fixture');
  process.chdir(otherProject);
  integrationWorker.sync({ project: otherProject, phase: 'checkpoint', intent: 'different project', files: ['other.js'] });
  ok(integrationWorker.sync({ project: otherProject, phase: 'complete' }).structured.completionIntegration === undefined,
    'G11: a project switch cannot expose prior-project peer evidence');
  integrationWorker.stop();
  process.chdir(originalCwd);
  console.log(failures ? `\n[x] ${failures} completion-guard assertion(s) failed` : '\n[ok] completion-guard: all assertions passed');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(failures ? 1 : 0);
