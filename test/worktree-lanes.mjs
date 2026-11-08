// Linked git worktrees share one lane (1.112.0).
//
// THE contract under test: a session in a linked worktree of a repository and a
// session in its primary checkout resolve the SAME lane file, so the peer list,
// the exact-file overlap heads-up and messages span the worktrees — while an
// unrelated repository, a plain folder and a submodule-shaped pointer keep the
// lanes they always had, byte for byte. Both lane writers are checked: the
// engine (agent-presence.mjs laneFileFor / worktreeLaneIdentity) and the real
// Claude Code hook, which computes its lane file independently (PARITY twin
// worktreeLaneCanon in global-brain-hook.mjs).
//
// Run:  node test/worktree-lanes.mjs        (exit 0 = pass, 1 = fail)
// Needs git on PATH (the fixture is a real repository with `git worktree add`).
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  laneFileFor,
  listActiveSessions,
  pinLaneIdentity,
  postPresenceMessage,
  upsertSession,
  worktreeLaneIdentity,
} from '../src/agent-presence.mjs';
import { findPresenceConflicts } from '../src/mcp-presence.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// The pre-1.112.0 lane formula, byte for byte (sha1-16 of the realpath'd brain
// path, forward slashes, lowercased drive). Anything that is NOT a linked
// worktree must still land exactly here — that is the "unchanged" promise.
const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
const normBrainPath = (value) => String(value).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const realpath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const legacyLane = (brain, home) => path.join(home, '.claude', 'project-brain', 'sessions', `${sha16(normBrainPath(realpath(brain)))}.json`);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-worktree-lanes-'));
const home = path.join(base, 'home');
const primary = path.join(base, 'aurora');                 // the primary checkout
const linked = path.join(base, 'aurora-rate-limits');      // a linked worktree beside the repo
const nested = path.join(primary, '.worktrees', 'nested'); // a linked worktree inside the repo (the KLYPIX layout)
const otherRepo = path.join(base, 'other');                // an unrelated repository
const plain = path.join(base, 'plain');                    // no git at all
const submoduleLike = path.join(base, 'submodule-like');   // `.git` is a file, but not a worktree pointer
fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
for (const dir of [primary, otherRepo, plain, submoduleLike]) fs.mkdirSync(dir, { recursive: true });

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'aurora', GIT_AUTHOR_EMAIL: 'demo@aurora.test',
  GIT_COMMITTER_NAME: 'aurora', GIT_COMMITTER_EMAIL: 'demo@aurora.test',
};
fs.writeFileSync(path.join(base, 'gitconfig'), '');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const brainBytes = await buildKlypixMap({ title: 'worktree fixture', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] });
const seedRepo = (dir) => {
  fs.writeFileSync(path.join(dir, 'brain.klypix'), brainBytes);
  fs.mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'app', 'brain.klypix'), brainBytes);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture (fictional)\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
};
seedRepo(primary);
seedRepo(otherRepo);
fs.writeFileSync(path.join(plain, 'brain.klypix'), brainBytes);
fs.writeFileSync(path.join(submoduleLike, 'brain.klypix'), brainBytes);
fs.writeFileSync(path.join(submoduleLike, '.git'),
  `gitdir: ${path.join(otherRepo, '.git', 'modules', 'sub').replace(/\\/g, '/')}\n`);

git(primary, 'worktree', 'add', '-q', '-b', 'feat/rate-limiting', linked);
git(primary, 'worktree', 'add', '-q', '-b', 'feat/nested', nested);

const primaryBrain = path.join(primary, 'brain.klypix');
const linkedBrain = path.join(linked, 'brain.klypix');
const nestedBrain = path.join(nested, 'brain.klypix');
ok(fs.existsSync(linkedBrain) && fs.existsSync(nestedBrain), 'both linked worktrees check out their own brain.klypix');
ok(fs.statSync(path.join(linked, '.git')).isFile(), 'a linked worktree\'s .git is a file — the pointer the mapping follows');

// ── 1. The engine: laneFileFor ───────────────────────────────────────────────
const primaryLane = laneFileFor(primaryBrain, home);
ok(primaryLane === legacyLane(primaryBrain, home), 'the primary checkout keeps the lane it always had');
ok(laneFileFor(linkedBrain, home) === primaryLane, 'a linked worktree beside the repository shares the primary lane');
ok(laneFileFor(nestedBrain, home) === primaryLane, 'a linked worktree inside the repository shares the primary lane');
ok(normBrainPath(worktreeLaneIdentity(linkedBrain)) === normBrainPath(realpath(primaryBrain)),
  'worktreeLaneIdentity maps the worktree brain to the primary checkout\'s brain path');
ok(normBrainPath(worktreeLaneIdentity(primaryBrain)) === normBrainPath(path.resolve(primaryBrain)),
  'worktreeLaneIdentity leaves the primary checkout\'s brain path alone');
ok(laneFileFor(path.join(linked, 'packages', 'app', 'brain.klypix'), home)
  === laneFileFor(path.join(primary, 'packages', 'app', 'brain.klypix'), home),
'a brain below the worktree root keeps its relative path under the primary root (monorepo)');
ok(laneFileFor(path.join(primary, 'packages', 'app', 'brain.klypix'), home) !== primaryLane,
  'two brains in one repository are still two lanes');
const otherBrain = path.join(otherRepo, 'brain.klypix');
ok(laneFileFor(otherBrain, home) !== primaryLane && laneFileFor(otherBrain, home) === legacyLane(otherBrain, home),
  'an unrelated repository keeps its own, unchanged lane');
ok(laneFileFor(path.join(plain, 'brain.klypix'), home) === legacyLane(path.join(plain, 'brain.klypix'), home),
  'a folder with no git keeps its own, unchanged lane');
ok(laneFileFor(path.join(submoduleLike, 'brain.klypix'), home) === legacyLane(path.join(submoduleLike, 'brain.klypix'), home),
  'a submodule-shaped .git pointer (no worktrees/ segment) is left alone');
ok(laneFileFor(linkedBrain, home) === primaryLane, 'the answer is stable on a repeated (cached) lookup');

// ── 2. Pins do not undo the mapping ──────────────────────────────────────────
// pinLaneIdentity reports its lane under os.homedir(); compare the lane NAME.
const pinned = pinLaneIdentity(linkedBrain, realpath(linkedBrain));
ok(pinned.ok && path.basename(pinned.laneFile) === path.basename(primaryLane),
  'pinLaneIdentity on the worktree brain still lands on the primary lane');
ok(laneFileFor(linkedBrain, home) === primaryLane, 'laneFileFor after the pin still lands on the primary lane');
ok(laneFileFor(linkedBrain, home, realpath(linkedBrain)) === primaryLane, 'an explicit stable identity maps too');

// ── 3. Presence across worktrees: peers, the overlap heads-up, a note ─────────
const now = Date.now();
upsertSession({
  brainPath: primaryBrain, home, now, id: 'main-session', client: 'claude-code', channel: 'mcp',
  branch: 'main', intent: 'rewrite the auth token refresh', files: ['src/auth/token.ts'], cwd: primary,
});
upsertSession({
  brainPath: linkedBrain, home, now, id: 'wt-session', client: 'codex', channel: 'mcp',
  branch: 'feat/rate-limiting', intent: 'add rate limiting to the auth routes',
  files: ['src/auth/token.ts', 'src/auth/routes.ts'], cwd: linked,
});
const fromWorktree = listActiveSessions({ brainPath: linkedBrain, home, now });
ok(fromWorktree.some((s) => s.id === 'main-session'), 'the worktree session lists the primary checkout\'s session as a live peer');
ok(listActiveSessions({ brainPath: primaryBrain, home, now }).some((s) => s.id === 'wt-session'),
  'the primary checkout\'s session lists the worktree session as a live peer');
const conflicts = findPresenceConflicts(fromWorktree, 'wt-session');
const hit = conflicts.find((c) => c.id === 'main-session');
ok(Boolean(hit) && hit.files.includes('src/auth/token.ts'), 'the exact-file overlap heads-up spans the two worktrees');
ok(Boolean(hit) && hit.sameWorktree === false, 'the overlap names the peer as working in another worktree');
ok(!findPresenceConflicts(fromWorktree, 'wt-session').some((c) => c.files.includes('src/auth/routes.ts')),
  'a file only one side declared is not reported');

// Delivery v3 snapshots the live audience at send time: make the hook's session
// live on the WORKTREE lane first, then post the note from the PRIMARY checkout.
upsertSession({
  brainPath: linkedBrain, home, now, id: 'wt-hook-session', logicalSessionId: 'wt-hook-session',
  identitySource: 'claude-lifecycle', client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit',
  cwd: linked,
});
const NOTE = 'token.ts: refresh() is mid-rewrite on main — rebase before you touch it';
const posted = postPresenceMessage({ brainPath: primaryBrain, from: 'main-session', to: 'all', text: NOTE, home, now });
ok(posted.posted === true, 'a note posted from the primary checkout is accepted into the shared lane');

// ── 4. The REAL Claude Code hook, run FROM the worktree, reads the same lane ──
const hookEnv = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
delete hookEnv.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main()
let hookOut = '';
try {
  hookOut = execFileSync(process.execPath, [HOOK, '--prompt'], {
    cwd: linked, env: hookEnv, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'wt-hook-session', event_id: 'worktree-lanes-1', prompt: 'continue the rate limiting' }),
  });
} catch (error) {
  hookOut = `${error?.stdout || ''}\n${error?.stderr || ''}`;
}
ok(hookOut.includes(NOTE), 'the hook, running in the worktree, receives the note posted in the primary checkout');
const laneAfterHook = JSON.parse(fs.readFileSync(primaryLane, 'utf8'));
ok((laneAfterHook.sessions || []).some((s) => s.id === 'wt-hook-session' || s.logicalSessionId === 'wt-hook-session'),
  'the hook wrote its heartbeat into the primary checkout\'s lane file');
const laneFiles = fs.readdirSync(path.dirname(primaryLane)).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
ok(laneFiles.length === 1, `one lane file for the whole repository, not one per worktree (${laneFiles.length})`);

// ── cleanup (best effort: git objects are read-only on Windows) ──────────────
try { git(primary, 'worktree', 'remove', '--force', linked); } catch { /* best effort */ }
try { git(primary, 'worktree', 'remove', '--force', nested); } catch { /* best effort */ }
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] worktree-lanes: all assertions passed');
if (failures) process.exit(1);
