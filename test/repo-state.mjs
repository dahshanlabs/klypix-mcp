// Mechanical repo-state context (2026-08-14 bundle-currency incident).
// Locks in:
//   R1 — collectRepoState reports the project root's release-critical git
//        state: branch, headShort, packageVersion, tagsAtHead, isReleaseTag,
//        aheadBehindOrigin (offline, local tracking ref only).
//   R2 — zero-config bundled-mirror detection pairs packages/<dir> with
//        ../<dir> by PACKAGE NAME and yields the four drift verdicts:
//        aligned / sibling-ahead-untagged / sibling-ahead-released /
//        mirror-ahead.
//   R3 — degradation: not-a-git-repo and git-missing yield null (the block is
//        omitted), never a throw.
//   R4 — the 60s per-process cache: a repeat call spawns zero git processes.
//   R5 — brain_sync integration: structured.repoState appears on start
//        (additive, schemaVersion still 1), the sibling-ahead-untagged
//        advisory line rides the existing text channel, and phase 'complete'
//        omits the block.
//
// Run:  node test/repo-state.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { collectRepoState, repoStateWarnings } from '../src/repo-state.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = (cwd, message) => git(cwd,
  '-c', 'user.email=repo-state@test', '-c', 'user.name=repo-state-test',
  '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message);
const writePkg = (dir, name, version) =>
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2));
const initRepo = (dir, name, version) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  writePkg(dir, name, version);
  git(dir, 'add', '-A');
  commit(dir, 'init');
  git(dir, 'branch', '-M', 'main');   // deterministic branch name across git default-branch configs
};

// PID-scoped fixtures; separate trees for the direct-call scenarios and the
// sync() integration so the module's per-process cache cannot cross-feed them.
const fixRoot = path.join(os.tmpdir(), `klypix-repo-state-fix-${process.pid}`);
const syncRoot = path.join(os.tmpdir(), `klypix-repo-state-sync-${process.pid}`);
const home = path.join(os.tmpdir(), `klypix-repo-state-home-${process.pid}`);
for (const target of [fixRoot, syncRoot, home]) {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ── fixture pair: desktop-style project with a bundled mirror + source sibling ──
const proj = path.join(fixRoot, 'desktop-app');
const sibling = path.join(fixRoot, 'core-lib');
initRepo(proj, 'desktop-app', '9.9.9');
git(proj, 'tag', 'v9.9.9');
const mirrorDir = path.join(proj, 'packages', 'core-lib');
fs.mkdirSync(mirrorDir, { recursive: true });
writePkg(mirrorDir, 'core-lib', '1.2.0');
// distractor entries the scan must skip without counting against the verdicts
fs.mkdirSync(path.join(proj, 'packages', 'node_modules', 'dep'), { recursive: true });
writePkg(path.join(proj, 'packages', 'node_modules', 'dep'), 'dep', '0.0.1');
fs.mkdirSync(path.join(proj, 'packages', '.hidden'), { recursive: true });
initRepo(sibling, 'core-lib', '1.2.0');
git(sibling, 'tag', 'v1.2.0');

const fresh = { cacheMs: 0 };   // bypass the cache while the fixture mutates between scenarios

// ── R1: root repo state ──────────────────────────────────────────────────────
const aligned = collectRepoState(proj, fresh);
ok(aligned !== null, 'R1: a git project root yields a repoState block');
ok(aligned?.branch === 'main', 'R1: branch is the checked-out branch');
ok(typeof aligned?.headShort === 'string' && aligned.headShort.length >= 4, 'R1: headShort is a real abbreviated sha');
ok(aligned?.packageVersion === '9.9.9', 'R1: packageVersion reads package.json');
ok(Array.isArray(aligned?.tagsAtHead) && aligned.tagsAtHead.includes('v9.9.9'), 'R1: tagsAtHead lists the tag at HEAD');
ok(aligned?.isReleaseTag === true, 'R1: v<version> at HEAD marks isReleaseTag');
ok(aligned?.aheadBehindOrigin === null, 'R1: no upstream → aheadBehindOrigin null, not an error');

// isReleaseTag must survive the tagsAtHead response cap: `git tag --points-at`
// emits lexicographically, so 8+ tags sorting before v<version> would truncate
// the release tag out of the capped list — the verdict scans the full list.
for (let i = 0; i < 9; i++) git(proj, 'tag', `backup-${i}`);
const manyTags = collectRepoState(proj, fresh);
ok(manyTags?.tagsAtHead?.length === 8 && manyTags.isReleaseTag === true,
  'R1: the release verdict scans ALL tags at HEAD, not the capped response list');
for (let i = 0; i < 9; i++) git(proj, 'tag', '-d', `backup-${i}`);

// ── R2: the four drift verdicts ──────────────────────────────────────────────
ok(aligned?.siblings?.length === 1 && aligned.siblings[0].name === 'core-lib',
  'R2: exactly the name-paired sibling is detected (node_modules and dot-dirs skipped)');
ok(aligned.siblings[0].drift === 'aligned' && aligned.siblings[0].mirrorVersion === '1.2.0',
  'R2: equal versions → aligned, mirrorVersion carried');
ok(aligned.siblings[0].isReleaseTag === true && aligned.siblings[0].branch === 'main',
  'R2: the sibling gets the same full state block');

// the incident: sibling working tree moves ahead to an UNPUBLISHED version
writePkg(sibling, 'core-lib', '1.3.0');
const untagged = collectRepoState(proj, fresh);
ok(untagged?.siblings?.[0]?.drift === 'sibling-ahead-untagged',
  'R2: sibling ahead at an untagged version → sibling-ahead-untagged (the 2026-08-14 shape)');
const warnings = repoStateWarnings(untagged);
ok(warnings.length === 1
  && warnings[0].includes('core-lib 1.3.0')
  && warnings[0].includes('mirror (1.2.0)')
  && warnings[0].includes('NO release tag'),
  'R2: the untagged-ahead sibling produces exactly one advisory warning line');

// same version, now tagged (anywhere in the repo, not only at HEAD)
git(sibling, 'add', '-A');
commit(sibling, 'bump to 1.3.0');
git(sibling, 'tag', 'v1.3.0');
commit(sibling, 'moved past the tag');   // "released" must not require the tag at HEAD
const released = collectRepoState(proj, fresh);
ok(released?.siblings?.[0]?.drift === 'sibling-ahead-released',
  'R2: sibling ahead at a TAGGED version → sibling-ahead-released');
ok(repoStateWarnings(released).length === 0, 'R2: a released-ahead sibling raises no warning line');

// mirror ahead of the sibling checkout
writePkg(sibling, 'core-lib', '1.1.0');
const mirrorAhead = collectRepoState(proj, fresh);
ok(mirrorAhead?.siblings?.[0]?.drift === 'mirror-ahead',
  'R2: sibling behind the bundled mirror → mirror-ahead');

// ── R1b: offline ahead/behind against the local tracking ref ─────────────────
const clone = path.join(fixRoot, 'core-lib-clone');
git(fixRoot, 'clone', sibling, clone);
commit(clone, 'local-only work');
const cloned = collectRepoState(clone, fresh);
ok(cloned?.aheadBehindOrigin?.ahead === 1
  && cloned.aheadBehindOrigin.behind === 0
  && /origin\//.test(cloned.aheadBehindOrigin.upstream || ''),
  'R1: aheadBehindOrigin counts against the local tracking ref, offline');

// ── R3: degradation ──────────────────────────────────────────────────────────
const plainDir = path.join(fixRoot, 'not-a-repo');
fs.mkdirSync(plainDir, { recursive: true });
writePkg(plainDir, 'plain', '1.0.0');
ok(collectRepoState(plainDir, fresh) === null, 'R3: a non-git directory yields null (block omitted)');
const enoent = () => { const err = new Error('spawn git ENOENT'); err.code = 'ENOENT'; throw err; };
ok(collectRepoState(proj, { cacheMs: 0, execGit: enoent }) === null,
  'R3: git missing entirely yields null, never a throw');
ok(collectRepoState(null) === null && collectRepoState('') === null,
  'R3: absent project dir yields null');

// detached HEAD: state survives with branch null
git(clone, 'checkout', '--detach');
const detached = collectRepoState(clone, fresh);
ok(detached !== null && detached.branch === null,
  'R3: detached HEAD keeps the block with branch null');

// ── R4: per-process cache ────────────────────────────────────────────────────
const cacheDir = path.join(fixRoot, 'cache-probe');
initRepo(cacheDir, 'cache-probe', '2.0.0');
let spawns = 0;
const countingGit = (args, cwd) => { spawns += 1; return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }); };
const first = collectRepoState(cacheDir, { execGit: countingGit });
const firstSpawns = spawns;
const second = collectRepoState(cacheDir, { execGit: countingGit });
ok(firstSpawns > 0 && spawns === firstSpawns && second === first,
  `R4: a repeat call within the cache window spawns zero git processes (first call: ${firstSpawns})`);

// ── R5: brain_sync integration ───────────────────────────────────────────────
const syncProj = path.join(syncRoot, 'app');
const syncSibling = path.join(syncRoot, 'brain-core');
initRepo(syncProj, 'app', '3.0.0');
const syncMirror = path.join(syncProj, 'packages', 'brain-core');
fs.mkdirSync(syncMirror, { recursive: true });
writePkg(syncMirror, 'brain-core', '1.68.0');
initRepo(syncSibling, 'brain-core', '1.69.0');   // ahead, no tag → the incident
git(syncSibling, 'checkout', '-b', 'core/1.69-feature');
fs.writeFileSync(path.join(syncProj, 'brain.klypix'), await buildKlypixMap({
  title: 'repo-state fixture',
  areas: [{ title: 'Goal', cards: [{ text: 'mechanical repo-state context' }] }],
}));
const fakeServer = {
  server: { getClientVersion: () => ({ name: 'repo-state-test', version: 'test' }) },
  sendLoggingMessage: () => {},
};
const timer = () => ({ unref() {} });
const presence = createMcpPresence({
  server: fakeServer,
  initialVault: syncProj,
  env: { KLYPIX_SESSION_ID: 'repo-state-session' },
  home,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
const startReport = presence.sync({
  project: syncProj,
  phase: 'start',
  intent: 'verify mechanical repo-state context',
  files: ['src/repo-state.mjs'],
});
ok(startReport.isError !== true && startReport.structured?.schemaVersion === 1,
  'R5: sync start succeeds and schemaVersion stays 1 (repoState is additive)');
const repo = startReport.structured?.repoState;
ok(repo && repo.branch === 'main' && repo.packageVersion === '3.0.0',
  'R5: structured.repoState carries the project root state');
ok(repo?.siblings?.[0]?.name === 'brain-core'
  && repo.siblings[0].drift === 'sibling-ahead-untagged'
  && repo.siblings[0].branch === 'core/1.69-feature'
  && repo.siblings[0].mirrorVersion === '1.68.0',
  'R5: the unreleased sibling checkout is reported with branch + mirror version');
ok(/repo-state warning/.test(startReport.text) && /brain-core/.test(startReport.text),
  'R5: the advisory line rides the existing text channel so every agent sees it in prose');
ok(startReport.structured.self && Array.isArray(startReport.structured.peers),
  'R5: existing structured fields (self/peers) are untouched');
const checkpointReport = presence.sync({
  project: syncProj,
  phase: 'checkpoint',
  intent: 'verify mechanical repo-state context',
  files: ['src/repo-state.mjs'],
});
ok(checkpointReport.structured?.repoState?.siblings?.[0]?.drift === 'sibling-ahead-untagged',
  'R5: checkpoint syncs carry repoState too (served from the 60s cache)');
const completeReport = presence.sync({ project: syncProj, phase: 'complete' });
ok(completeReport.isError !== true && completeReport.structured?.repoState === undefined,
  'R5: phase complete omits repoState — it is a task-start/checkpoint signal');
presence.stop();

for (const target of [fixRoot, syncRoot, home]) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(failures
  ? `\n[x] ${failures} repo-state assertion(s) failed`
  : '\n[ok] repo-state: all assertions passed');
process.exit(failures ? 1 : 0);
