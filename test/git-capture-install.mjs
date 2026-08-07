// git-capture-install — the agent-neutral commit-capture wiring (2026-08-07:
// brain-git-hook.mjs shipped for months installed NOWHERE; worktree/branch
// commits were invisible to the Stop hook's walk — the AgentLit `94b0b6b`
// incident). Covers install/idempotence/foreign-chaining/removal/ensure policy,
// and END-TO-END: a real feat commit in a real WORKTREE cards into that
// worktree's brain.klypix through brain-git-hook.mjs.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureGitCaptureHook,
  gitCaptureHookStatus,
  installGitCaptureHook,
  removeGitCaptureHook,
} from '../src/git-capture-install.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { parseKlypix } from '../src/klypix-format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const repo = path.join(os.tmpdir(), 'klypix-git-capture-repo');
const wt = path.join(os.tmpdir(), 'klypix-git-capture-wt');
for (const dir of [repo, wt]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-b', 'main']);
git(['config', 'user.email', 'test@klypix.local']);
git(['config', 'user.name', 'klypix-test']);
// The test must not depend on a deployed machine bundle — pin the resolved hook
// script to the repo's own copy by ensuring no HOME bundle interferes is not
// possible here, so instead just assert the managed block points at SOME
// brain-git-hook.mjs (deployed or sibling — both are the same file by deploy).
fs.writeFileSync(path.join(repo, 'brain.klypix'), await buildKlypixMap({
  title: 'git capture fixture',
  kind: 'brain',
  areas: [{ title: 'Fixes', cards: [{ text: 'seed card' }] }],
}));
fs.writeFileSync(path.join(repo, 'readme.txt'), 'v1\n');
git(['add', '.']);
git(['commit', '-m', 'chore: seed']);

// ── status / install / idempotence ───────────────────────────────────────────
ok(gitCaptureHookStatus(repo).state === 'absent', 'fresh repo reports absent');
const inst = installGitCaptureHook(repo);
ok(inst.ok && inst.changed.includes('post-commit') && inst.changed.includes('post-merge'),
  'install writes post-commit and post-merge');
const st = gitCaptureHookStatus(repo);
ok(st.state === 'installed' && st.hooks['post-commit'] === 'ours' && st.hooks['post-merge'] === 'ours',
  'status reports installed/ours for both slots');
const hookText = fs.readFileSync(path.join(st.hooksDir, 'post-commit'), 'utf8');
ok(hookText.startsWith('#!/bin/sh') && hookText.includes('brain-git-hook.mjs') && !hookText.includes('\r'),
  'the managed hook is sh, references brain-git-hook.mjs, and is LF-only');
const again = installGitCaptureHook(repo);
ok(again.ok && again.changed.length === 0, 'reinstall is a no-op (idempotent)');

// ── ensure() policy ──────────────────────────────────────────────────────────
// remove() now writes a durable opt-out marker (that is the point) — a fixture
// reset must clear it, or every later ensure() legitimately no-ops.
const resetHooks = () => {
  removeGitCaptureHook(repo);
  fs.rmSync(path.join(repo, '.claude', 'git-capture-optout'), { force: true });
};
resetHooks();
const ens1 = ensureGitCaptureHook(repo);
ok(ens1.changed === true && ens1.notice.includes('git commit-capture hook'),
  'ensure installs on a clean repo and announces the transition once');
const ens2 = ensureGitCaptureHook(repo);
ok(ens2.changed === false && ens2.notice === '', 'ensure is silent when already installed');

// foreign hook: ensure must never touch it; explicit install chains it.
resetHooks();
const foreign = '#!/bin/sh\necho custom-hook-ran\n';
fs.writeFileSync(path.join(st.hooksDir, 'post-commit'), foreign);
const ensForeign = ensureGitCaptureHook(repo);
ok(ensForeign.changed === false
  && fs.readFileSync(path.join(st.hooksDir, 'post-commit'), 'utf8') === foreign,
  'ensure refuses to edit a foreign hook (auto-install owns only its own files)');
const chained = installGitCaptureHook(repo);
const chainedText = fs.readFileSync(path.join(st.hooksDir, 'post-commit'), 'utf8');
ok(chained.ok && chainedText.startsWith(foreign.trimEnd()) && chainedText.includes('klypix-brain capture'),
  'explicit install chains the managed block AFTER the foreign lines');
const rm = removeGitCaptureHook(repo);
const afterRm = fs.readFileSync(path.join(st.hooksDir, 'post-commit'), 'utf8');
ok(rm.ok && afterRm.includes('custom-hook-ran') && !afterRm.includes('klypix-brain capture'),
  'remove strips exactly the managed block and preserves the foreign hook');
ok(!fs.existsSync(path.join(st.hooksDir, 'post-merge')),
  'remove deletes a fully-owned hook file instead of leaving an empty husk');

// non-sh foreign hooks are never modified
fs.writeFileSync(path.join(st.hooksDir, 'post-merge'), '#!/usr/bin/env python3\nprint("x")\n');
const skipRes = installGitCaptureHook(repo);
ok(skipRes.skipped.includes('post-merge')
  && !fs.readFileSync(path.join(st.hooksDir, 'post-merge'), 'utf8').includes('klypix'),
  'a non-sh hook is skipped and untouched');
fs.unlinkSync(path.join(st.hooksDir, 'post-merge'));
installGitCaptureHook(repo);

// ── custom hooksPath is not auto-installable ─────────────────────────────────
git(['config', 'core.hooksPath', '.githooks']);
ok(gitCaptureHookStatus(repo).state === 'custom-hookspath'
  && ensureGitCaptureHook(repo).changed === false,
  'core.hooksPath defers to the human (status + ensure no-op)');
git(['config', '--unset', 'core.hooksPath']);

// ── consent: remove STICKS, and the env kill switch is honored ───────────────
removeGitCaptureHook(repo);
ok(fs.existsSync(path.join(repo, '.claude', 'git-capture-optout')),
  'remove writes the opt-out marker');
const afterOptOut = ensureGitCaptureHook(repo);
ok(afterOptOut.changed === false && afterOptOut.state === 'opted-out'
  && !Object.values(gitCaptureHookStatus(repo).hooks).includes('ours'),
  'a removed hook is NOT silently re-installed at the next session start');
installGitCaptureHook(repo);
ok(!fs.existsSync(path.join(repo, '.claude', 'git-capture-optout')),
  'an explicit install clears the opt-out (the human opted back in)');
removeGitCaptureHook(repo);
fs.rmSync(path.join(repo, '.claude', 'git-capture-optout'), { force: true });
const killed = ensureGitCaptureHook(repo, { env: { KLYPIX_GIT_CAPTURE: '0' } });
ok(killed.changed === false && killed.state === 'disabled',
  'KLYPIX_GIT_CAPTURE=0 disables auto-install machine-wide');
installGitCaptureHook(repo);

// ── sh-safety: a path with shell metacharacters cannot inject ────────────────
{
  const nasty = path.join(os.tmpdir(), "klypix-gc-$(touch pwned)-`id`-'q'");
  fs.rmSync(nasty, { recursive: true, force: true });
  fs.mkdirSync(nasty, { recursive: true });
  fs.copyFileSync(path.join(root, 'src', 'brain-git-hook.mjs'), path.join(nasty, 'brain-git-hook.mjs'));
  const fakeHome = path.join(nasty, 'home');
  fs.mkdirSync(path.join(fakeHome, '.claude', 'project-brain'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src', 'brain-git-hook.mjs'), path.join(fakeHome, '.claude', 'project-brain', 'brain-git-hook.mjs'));
  installGitCaptureHook(repo, { home: fakeHome });
  const block = fs.readFileSync(path.join(st.hooksDir, 'post-commit'), 'utf8');
  const line = block.split('\n').find(l => l.includes('brain-git-hook.mjs')) || '';
  ok(line.includes("'") && !/\$\(touch pwned\)[^']/.test(line.replace(/'[^']*'/g, '')),
    'a hook-script path with $(), backticks and quotes is single-quoted, never expanded');
  ok(line.startsWith('[ -f '),
    'the block guards on the engine file existing (an uninstalled bundle no-ops silently, no per-commit noise)');
  installGitCaptureHook(repo);   // restore the real path
}

// ── nested brain: refuse rather than wire the enclosing repo ─────────────────
{
  const nestedPkg = path.join(repo, 'packages', 'inner');
  fs.mkdirSync(nestedPkg, { recursive: true });
  fs.copyFileSync(path.join(repo, 'brain.klypix'), path.join(nestedPkg, 'brain.klypix'));
  const nestedStatus = gitCaptureHookStatus(nestedPkg);
  ok(nestedStatus.state === 'nested-brain',
    'a brain below the worktree top reports nested-brain, not a false green');
  const nestedEnsure = ensureGitCaptureHook(nestedPkg);
  ok(nestedEnsure.changed === false && !installGitCaptureHook(nestedPkg).ok,
    'a nested brain never wires (or mis-reports) the enclosing repo');
  fs.rmSync(path.join(repo, 'packages'), { recursive: true, force: true });
}

// ── injection: a repo-writable baseline file cannot reach the shell ──────────
{
  const marker = path.join(os.tmpdir(), 'klypix-gc-injection-marker.txt');
  fs.rmSync(marker, { force: true });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'brain-last-commit-git'),
    `HEAD; echo pwned > "${marker.replace(/\\/g, '/')}"`);
  execFileSync(process.execPath, [path.join(root, 'src', 'brain-git-hook.mjs'), repo],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  ok(!fs.existsSync(marker),
    'a poisoned .claude/brain-last-commit-git cannot execute a shell command');
  const rebaselined = fs.readFileSync(path.join(repo, '.claude', 'brain-last-commit-git'), 'utf8').trim();
  ok(/^[0-9a-f]{7,64}$/i.test(rebaselined),
    'an invalid baseline re-baselines to a bare sha instead of being re-used');
}

// ── END-TO-END: worktree commit → card in the worktree's brain ───────────────
git(['add', '.']); try { git(['commit', '-m', 'chore: hooks state']); } catch { /* may be clean */ }
git(['worktree', 'add', '-b', 'feat/wt-branch', wt]);
const gitHookScript = path.join(root, 'src', 'brain-git-hook.mjs');
const runCapture = (cwd) => execFileSync(process.execPath, [gitHookScript, cwd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
runCapture(wt);   // first run BASELINES to HEAD, captures nothing
fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
git(['add', '.'], wt);
git(['commit', '-m', 'feat(sources): declare a new grounded source after creation\n\nThe wizard now records the grounding decision so later sessions inherit it.'], wt);
const wtSha7 = git(['rev-parse', '--short=7', 'HEAD'], wt).toLowerCase();
runCapture(wt);
const { struct } = await parseKlypix(fs.readFileSync(path.join(wt, 'brain.klypix')));
// tidy line-wraps card text — normalize whitespace before matching content.
const texts = (struct.cards || []).map(c => String(c.text || '').replace(/\s+/g, ' '));
ok(texts.some(t => t.includes(`#commit-${wtSha7}`)),
  `a worktree feature-branch commit cards into the worktree's brain (#commit-${wtSha7})`);
ok(texts.some(t => t.includes('declare a new grounded source')),
  'the card carries the commit subject (rationale body captured)');
runCapture(wt);
const { struct: struct2 } = await parseKlypix(fs.readFileSync(path.join(wt, 'brain.klypix')));
const hits = (struct2.cards || []).filter(c => String(c.text || '').includes(`#commit-${wtSha7}`));
ok(hits.length === 1, 'a re-run never double-cards the same commit (tag dedup)');

// ── DUAL-CHANNEL: the Claude Stop hook must not re-card what the git hook did ─
// Auto-install makes "both channels live" the DEFAULT configuration, and the
// Stop hook used to have no #commit dedup at all — every rationale-bearing
// commit carded twice (feat → duplicate 🏁 cards; fix/perf → the git hook's
// fresh card supersede-archived by its own clone). Review-caught 2026-08-07.
{
  const stopHome = path.join(os.tmpdir(), 'klypix-gc-stop-home');
  fs.rmSync(stopHome, { recursive: true, force: true });
  fs.mkdirSync(stopHome, { recursive: true });
  const hookPath = path.join(root, 'src', 'global-brain-hook.mjs');
  const sessionId = 'dual-capture-session';
  // Baseline the Stop-hook channel to the commit BEFORE the feature commit, so
  // its own walk still contains a commit the git hook already carded.
  const parentSha = git(['rev-parse', 'HEAD~1'], wt);
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.claude', 'brain-last-commit'), parentSha);
  const transcript = path.join(stopHome, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  execFileSync(process.execPath, [hookPath, '--capture'], {
    cwd: wt,
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcript }),
    env: { ...process.env, HOME: stopHome, USERPROFILE: stopHome, KLYPIX_AUTO_UPDATE: '0' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const { struct: struct3 } = await parseKlypix(fs.readFileSync(path.join(wt, 'brain.klypix')));
  const dual = (struct3.cards || []).filter(c => String(c.text || '').includes(`#commit-${wtSha7}`));
  ok(dual.length === 1,
    `the Stop hook does not re-card a commit the git hook already captured (found ${dual.length})`);
  ok(!dual.some(c => /↩︎|superseded/i.test(String(c.text || ''))),
    'the git hook\'s card is not supersede-archived by a Stop-hook clone');
  // The baseline must still advance — otherwise the same range re-scans forever.
  const advanced = fs.readFileSync(path.join(wt, '.claude', 'brain-last-commit'), 'utf8').trim();
  ok(advanced === git(['rev-parse', 'HEAD'], wt),
    'the Stop-hook commit baseline advances even when every commit was already carded');
}

process.exit(failures ? 1 : 0);
