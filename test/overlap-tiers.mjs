// Overlap tiers beyond the exact file (1.97.0).
//
// Exact-file overlap stays the blocking signal. This file locks the two new
// tiers and the footer cleanup:
//   T1 — mergeTreeConflicts on a REAL repo: two branches that conflict in a file
//        neither side declared; hook-projected files (AGENTS.md, brain.klypix…)
//        are filtered as noise; a clean pair is clean.
//   T2 — mergeTreeConflicts says "unknown" (null) instead of guessing or
//        throwing: unsafe ref names, a missing branch, the same branch.
//   T3 — findMergeConflicts: blocking merge-conflict per peer on another branch;
//        same branch, another machine, an idle row and an exhausted budget are
//        skipped; one test merge per branch pair.
//   T4 — findNearbyWork: same folder, no shared file → advisory; an exact
//        overlap is not repeated; folders most sessions touch are noise; the
//        repo root is never a folder signal.
//   T5 — MERGE_NOISE_PATHS covers every project file `link` manages.
//   T6 — brain_sync end to end, run from inside the repo: the merge-conflict
//        warning, the exactly-once merge alert, the nearby notice, and the
//        unchanged "No exact file overlap" line.
//   T7 — the REAL Claude hook footer: one same-branch line (not one per peer)
//        and a 📁 same-folder note.
//
// Every home and project lives under os.tmpdir(); nothing touches ~/.claude.
// Run:  node test/overlap-tiers.mjs   (exit 0 = pass)
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { upsertSession, laneFileFor } from '../src/agent-presence.mjs';
import { findMergeConflicts, findNearbyWork } from '../src/mcp-presence.mjs';
import {
  MERGE_NOISE_PATHS,
  __resetMergeTreeCacheForTests,
  isMergeNoise,
  isSafeBranchName,
  mergeTreeConflicts,
} from '../src/repo-state.mjs';
import { PROJECT_TARGETS } from '../src/uninstall.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => { console.log(`${condition ? '[ok]' : '[x]'} ${label}`); if (!condition) failures++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-overlap-tiers-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

let gitOk = true;
try { git('init', '-q', '-b', 'main'); } catch { try { git('init', '-q'); git('checkout', '-q', '-b', 'main'); } catch { gitOk = false; } }
const mergeTreeSupported = gitOk && spawnSync('git', ['merge-tree', '-h'], { encoding: 'utf8' }).stdout.concat(
  spawnSync('git', ['merge-tree', '-h'], { encoding: 'utf8' }).stderr || '').includes('--write-tree');

if (gitOk) {
  write('src/shared.ts', 'line 1\nline 2\nline 3\n');
  write('AGENTS.md', 'base\n');
  write('README.md', 'readme\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  // feat-a and feat-b both rewrite line 2 of a file NEITHER will declare, and
  // both rewrite AGENTS.md (hook projection — must be filtered as noise).
  git('checkout', '-q', '-b', 'feat-a');
  write('src/shared.ts', 'line 1\nline 2 from A\nline 3\n'); write('AGENTS.md', 'from A\n');
  git('commit', '-q', '-am', 'a');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'feat-b');
  write('src/shared.ts', 'line 1\nline 2 from B\nline 3\n'); write('AGENTS.md', 'from B\n');
  git('commit', '-q', '-am', 'b');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'feat-c');
  write('README.md', 'readme from C\n');
  git('commit', '-q', '-am', 'c');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'noise-a');
  write('AGENTS.md', 'noise A\n'); git('commit', '-q', '-am', 'na');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'noise-b');
  write('AGENTS.md', 'noise B\n'); git('commit', '-q', '-am', 'nb');
  git('checkout', '-q', 'feat-a');
}

// ── T1 / T2: the git primitive ───────────────────────────────────────────────
if (!gitOk) {
  console.log('[skip] T1/T2/T6: git is not available on this machine');
} else if (!mergeTreeSupported) {
  __resetMergeTreeCacheForTests();
  ok(mergeTreeConflicts(repo, 'feat-a', 'feat-b') === null, 'T1: git without merge-tree --write-tree answers "unknown" (null), never a false clean');
} else {
  __resetMergeTreeCacheForTests();
  const ab = mergeTreeConflicts(repo, 'feat-a', 'feat-b');
  ok(ab && ab.clean === false && ab.files.length === 1 && ab.files[0] === 'src/shared.ts',
    'T1: two branches that both rewrite line 2 of an undeclared file conflict in exactly that file');
  ok(ab && !ab.files.includes('AGENTS.md'), 'T1: a conflict in a hook-projected file (AGENTS.md) is filtered as noise');
  ok(ab && /^[0-9a-f]{40,64}$/.test(ab.shaA) && /^[0-9a-f]{40,64}$/.test(ab.shaB), 'T1: the result names both tips it tested');
  const ac = mergeTreeConflicts(repo, 'feat-a', 'feat-c');
  ok(ac && ac.clean === true && ac.files.length === 0, 'T1: branches touching different files merge clean');
  const nn = mergeTreeConflicts(repo, 'noise-a', 'noise-b');
  ok(nn && nn.clean === true && nn.noiseOnly === true, 'T1: a pair conflicting ONLY in managed files reads as clean (noiseOnly)');
  // Cache: same tips → same object, no second spawn.
  let spawns = 0;
  const counting = (args, cwd, t) => { spawns++; return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: t }); };
  __resetMergeTreeCacheForTests();
  mergeTreeConflicts(repo, 'feat-a', 'feat-b', { runMergeTree: counting });
  mergeTreeConflicts(repo, 'feat-a', 'feat-b', { runMergeTree: counting });
  ok(spawns === 1, 'T1: a pair of unchanged tips is test-merged once (cached by commit ids)');
}
if (gitOk) {
  ok(mergeTreeConflicts(repo, '-oops', 'feat-b') === null && mergeTreeConflicts(repo, 'a..b', 'feat-b') === null
    && mergeTreeConflicts(repo, 'feat-a@{1}', 'feat-b') === null,
    'T2: ref names that could inject options or revision syntax are refused (null)');
  ok(mergeTreeConflicts(repo, 'feat-a', 'no-such-branch') === null, 'T2: a branch missing from this repo (a teammate\'s PC) is unknown, not clean');
  ok(mergeTreeConflicts(repo, 'feat-a', 'feat-a') === null, 'T2: the same branch is never test-merged against itself');
  ok(mergeTreeConflicts(path.join(tmp, 'not-a-repo'), 'feat-a', 'feat-b') === null, 'T2: outside a repo the answer is unknown, never a throw');
}
ok(isSafeBranchName('feat/overlap-best-in-class') && !isSafeBranchName('') && !isSafeBranchName('x y') && !isSafeBranchName('refs.lock'),
  'T2: branch-name guard accepts real names and rejects whitespace/empty/.lock');

// ── T3: findMergeConflicts (injected git) ────────────────────────────────────
{
  const NOW = 2_000_000_000_000;
  const row = (id, branch, extra = {}) => ({ id, client: 'claude-code', branch, intent: `task ${id}`, files: [], lastSeen: NOW, machine: 'pc1', ...extra });
  const calls = [];
  const fakeTree = (dir, a, b) => { calls.push(`${a}|${b}`); return b === 'clean' ? { clean: true, files: [] } : { clean: false, files: ['src/shared.ts'], shaA: 'a'.repeat(40), shaB: 'b'.repeat(40) }; };
  const sessions = [
    row('me', 'feat-a'),
    row('p-conflict', 'feat-b'),
    row('p-conflict-2', 'feat-b'),
    row('p-clean', 'clean'),
    row('p-same', 'feat-a'),
    row('p-remote', 'feat-x', { machine: 'pc2' }),
    row('p-idle', 'feat-y', { intent: '', files: [] }),
  ];
  const found = findMergeConflicts(sessions, 'me', { repoDir: '/repo', mergeTree: fakeTree });
  ok(found.map((c) => c.id).sort().join(',') === 'p-conflict,p-conflict-2', 'T3: only peers on a conflicting other branch are reported');
  ok(found.every((c) => c.kind === 'merge-conflict' && c.severity === 'blocking' && c.committedOnly === true),
    'T3: a merge conflict is a blocking conflict, labelled committed-work-only');
  ok(found[0].refs.mine === 'feat-a@aaaaaaa' && found[0].refs.theirs === 'feat-b@bbbbbbb', 'T3: both refs are named with short tips');
  ok(calls.filter((c) => c === 'feat-a|feat-b').length === 1, 'T3: one test merge per branch pair, shared by peers on that branch');
  ok(!calls.some((c) => c.endsWith('feat-x') || c.endsWith('feat-y') || c.endsWith('|feat-a')),
    'T3: no test merge for another machine, an idle row, or the same branch');
  let t = 0;
  const slow = findMergeConflicts(sessions, 'me', { repoDir: '/repo', mergeTree: fakeTree, budgetMs: 5, clock: () => (t += 10) });
  ok(slow.length === 0, 'T3: an exhausted time budget stops test-merging instead of stalling brain_sync');
  ok(findMergeConflicts(sessions, 'me', { repoDir: null, mergeTree: fakeTree }).length === 0
    && findMergeConflicts([row('me', '')], 'me', { repoDir: '/repo', mergeTree: fakeTree }).length === 0,
    'T3: no repo or no branch of my own → nothing to test');
}

// ── T4: findNearbyWork ───────────────────────────────────────────────────────
{
  const NOW = 2_000_000_000_000;
  const row = (id, files, extra = {}) => ({ id, client: 'codex', branch: 'main', intent: `task ${id}`, files, lastSeen: NOW, cwd: '/p', ...extra });
  const two = [row('me', ['src/canvas/brain/CatchUpView.tsx']), row('peer', ['src/canvas/brain/catchUpModel.ts'])];
  const near = findNearbyWork(two, 'me');
  ok(near.length === 1 && near[0].kind === 'same-directory' && near[0].severity === 'advisory'
    && near[0].dirs[0] === 'src/canvas/brain' && near[0].theirs[0] === 'src/canvas/brain/catchUpModel.ts',
    'T4: same folder, no shared file → one advisory notice naming the folder and both sides\' files');
  const exact = [row('me', ['src/a/x.ts']), row('peer', ['src/a/x.ts', 'src/a/y.ts'])];
  ok(findNearbyWork(exact, 'me').length === 0, 'T4: an exact overlap is reported by the exact tier, not repeated as nearby');
  ok(findNearbyWork(two, 'me', { excludePeerIds: new Set(['peer']) }).length === 0, 'T4: peers already in a blocking conflict are excluded');
  const rootOnly = [row('me', ['README.md']), row('peer', ['package.json'])];
  ok(findNearbyWork(rootOnly, 'me').length === 0, 'T4: two root-level files are not a "same folder" signal');
  const busy = [
    row('me', ['docs/RELEASE_NOTES_NEXT.md', 'src/x/a.ts']),
    row('p1', ['docs/A.md']), row('p2', ['docs/B.md']), row('p3', ['docs/C.md', 'src/x/b.ts']),
  ];
  const busyNear = findNearbyWork(busy, 'me');
  ok(!busyNear.some((n) => n.dirs.includes('docs')), 'T4: a folder most scoped sessions touch (docs/) is dropped as noise');
  ok(busyNear.some((n) => n.id === 'p3' && n.dirs.includes('src/x')), 'T4: a folder only this pair shares still warns in a busy lane');
}

// ── T5: managed-file noise list stays complete ───────────────────────────────
{
  const managed = Object.keys(PROJECT_TARGETS).map((p) => p.toLowerCase());
  const missing = managed.filter((p) => !MERGE_NOISE_PATHS.includes(p));
  ok(missing.length === 0, `T5: every project file link manages is merge-noise${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  ok(isMergeNoise('BRAIN.klypix') && isMergeNoise('sub/brain.klypix') && !isMergeNoise('src/brain.ts'), 'T5: brain files are noise at any depth; ordinary source is not');
}

// ── T6: brain_sync end to end, run from inside the repo ─────────────────────
if (gitOk && mergeTreeSupported) {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const brainPath = path.join(repo, 'brain.klypix');
  fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'tiers', kind: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'overlap tiers fixture seed' }] }] }));
  const NOW = Date.now();
  // Peers: one on feat-b (conflicting branch, unrelated declared file), one in
  // my folder on another branch with no shared file.
  upsertSession({ brainPath, home, now: NOW, id: 'peer-branch-b', client: 'codex', branch: 'feat-b', intent: 'rework shared module', files: ['lib/other.ts'] });
  upsertSession({ brainPath, home, now: NOW, id: 'peer-same-folder', client: 'cursor', branch: 'feat-c', intent: 'polish own module', files: ['src/neighbour.ts'] });
  const presenceUrl = pathToFileURL(path.join(root, 'src', 'mcp-presence.mjs')).href;
  const script = `
    import { createMcpPresence } from ${JSON.stringify(presenceUrl)};
    const server = { server: { getClientVersion: () => ({ name: 'claude-code' }), sendLoggingMessage: async () => {} } };
    const mcp = createMcpPresence({ server, initialVault: ${JSON.stringify(repo)}, env: { KLYPIX_SESSION_ID: 'me-on-a' }, home: ${JSON.stringify(home)},
      now: () => ${NOW + 5}, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
    mcp.start();
    const first = mcp.sync({ phase: 'start', intent: 'tune the shared module', files: ['src/own.ts'] });
    const second = mcp.sync({ phase: 'checkpoint', intent: 'tune the shared module', files: ['src/own.ts'] });
    process.stdout.write(JSON.stringify({
      text: first.text, conflicts: first.conflicts, nearby: first.structured.nearby || [], alerts: first.alertsQueued,
      secondAlerts: second.alertsQueued.length, branch: first.structured.self && first.structured.self.branch,
    }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, 'brain-dir') },
  });
  let out = null;
  try { out = JSON.parse(run.stdout); } catch { console.log(run.stdout, run.stderr); }
  ok(out && out.branch === 'feat-a', 'T6: the syncing session is on feat-a (host cwd branch)');
  const merge = out && out.conflicts.find((c) => c.kind === 'merge-conflict');
  ok(merge && merge.id === 'peer-branch-b' && merge.files.join() === 'src/shared.ts',
    'T6: brain_sync reports a merge-conflict with the feat-b peer in a file neither declared');
  ok(out && /KLYPIX merge-conflict warning \(git merge-tree, committed work only/.test(out.text) && out.text.includes('src/shared.ts'),
    'T6: the response text states the merge conflict and its honesty limit');
  ok(out && out.text.includes('No exact file overlap is currently reported by another synchronized task.'),
    'T6: the exact-file line is unchanged when no declared file overlaps');
  ok(out && out.alerts.some((a) => a.peerId === 'peer-branch-b' && a.kind === 'merge-conflict') && out.secondAlerts === 0,
    'T6: the feat-b peer gets one merge-conflict alert, not one per checkpoint');
  ok(out && out.nearby.length === 1 && out.nearby[0].id === 'peer-same-folder' && out.nearby[0].dirs[0] === 'src'
    && /KLYPIX nearby-work notice \(advisory/.test(out.text),
    'T6: the same-folder peer is an advisory nearby notice (structured + text), with no alert');
  ok(out && !out.alerts.some((a) => a.peerId === 'peer-same-folder'), 'T6: an advisory notice never sends an alert');
  const lane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  const alertMsg = (lane.messages || []).find((m) => m.to === 'peer-branch-b');
  ok(alertMsg && /merge-conflict alert/.test(alertMsg.text) && /committed work only/.test(alertMsg.text),
    'T6: the queued alert is worded as a merge conflict, with its limit');
}

// ── T7: the REAL Claude hook footer ──────────────────────────────────────────
{
  const hookHome = path.join(tmp, 'hookhome');
  const hookProj = path.join(tmp, 'hookproj');
  fs.mkdirSync(hookProj, { recursive: true });
  fs.writeFileSync(path.join(hookProj, 'brain.klypix'), await buildKlypixMap({ title: 'brain', kind: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'footer fixture seed' }] }] }));
  // The hook reads its own branch from git on every prompt, so the project
  // must be a repo on `master` for the same-branch line to be computable.
  if (gitOk) {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: hookProj, stdio: 'ignore' });
    try { g('init', '-q', '-b', 'master'); } catch { g('init', '-q'); g('checkout', '-q', '-b', 'master'); }
    fs.writeFileSync(path.join(hookProj, 'README.md'), 'x\n');
    g('add', 'README.md'); g('commit', '-q', '-m', 'init');
  }
  const env = { ...process.env, HOME: hookHome, USERPROFILE: hookHome, CLAUDE_PID: '42424' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runHook = (args, input) => execFileSync(process.execPath, [path.join(root, 'src', 'global-brain-hook.mjs'), ...args], {
    cwd: hookProj, env, encoding: 'utf8', input: JSON.stringify(input),
  });
  runHook(['--prompt'], { session_id: 'sess-me', prompt: 'footer tiers' });
  const sessionsDir = path.join(hookHome, '.claude', 'project-brain', 'sessions');
  const laneFile = fs.readdirSync(sessionsDir).map((f) => path.join(sessionsDir, f)).find((f) => f.endsWith('.json'));
  const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const me = lane.sessions.find((s) => s.id === 'sess-me');
  me.branch = 'master'; me.files = ['src/canvas/brain/CatchUpView.tsx'];
  const t = Date.now();
  lane.sessions.push(
    { id: 'peer-1', pid: 900001, client: 'codex', branch: 'master', intent: 'first', files: ['lib/a.ts'], lastSeen: t, startedAt: t },
    { id: 'peer-2', pid: 900002, client: 'codex', branch: 'master', intent: 'second', files: ['lib/b.ts'], lastSeen: t, startedAt: t },
    { id: 'peer-3', pid: 900003, client: 'cursor', branch: 'feat/x', intent: 'third', files: ['src/canvas/brain/catchUpModel.ts'], lastSeen: t, startedAt: t },
  );
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const footer = runHook(['--prompt'], { session_id: 'sess-me', prompt: 'footer tiers again' });
  const sameBranchLines = footer.split('\n').filter((l) => l.includes('share your branch `master`'));
  ok(sameBranchLines.length === 1 && sameBranchLines[0].includes('2 of these session(s)') && sameBranchLines[0].includes('git add -u'),
    'T7: same-branch peers are stated ONCE, with the count and the concrete staging advice');
  ok(!footer.includes('same branch — your commits will interleave'), 'T7: the per-peer same-branch line is gone');
  ok(/session \S+ · .*📁 same folder: src\/canvas\/brain\/ — no shared file yet/.test(footer),
    'T7: a peer in my folder with no shared file gets a 📁 same-folder note');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} overlap-tier check(s) FAILED` : '\nall overlap-tier checks passed');
process.exit(failures ? 1 : 0);
