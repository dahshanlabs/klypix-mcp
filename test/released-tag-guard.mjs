// Released-tag deploy guard (2026-08-14 bundle-currency incident).
// Locks in:
//   G1 — bin/klypix-install.mjs run from a source checkout whose HEAD does NOT
//        carry the release tag for its own package version REFUSES, prints
//        WHAT would have been deployed (version, branch, headShort), changes
//        no receipts, and releases the install lock.
//   G2 — KLYPIX_MCP_ALLOW_UNTAGGED=1 acknowledges the deploy; the receipts
//        then record an honest dev-owned install (via/channel 'dev', dev:true,
//        sourceSha, branch) instead of impersonating a clean npm delivery.
//   G3 — the dev-owned stamp mechanically protects the deploy: a later plain
//        install preserves it instead of silently replacing it.
//   G4 — the --allow-untagged flag is equivalent to the env acknowledgement.
//   G5 — a dirty working tree is recorded as dirty:true in the stamp.
//   G6 — a checkout whose HEAD IS tagged v<version> installs exactly as
//        before: via:'npm', dirty:false, no dev marker (byte-compatible
//        receipts for the released path).
//   G6b — a TAGGED but dirty working tree still installs (the tag stands) but
//        stamps dirty:true + sourceSha/branch: the tag certifies HEAD's bytes,
//        not the working tree's, so a clean npm stamp would lie.
//   D1-D4 — brain_doctor reports a versioned source checkout's release state
//        (released-tag vs untagged-working-tree, with branch + version) as ONE
//        advisory line that never feeds layers, actions, or the verdict.
//
// Technique: real git fixtures under the OS temp dir (same as test/repo-state.mjs).
// The installer fixture is a COPY of this package (src/ + bin/ + package.json)
// whose node_modules is a junction/symlink back to the real one, and whose
// install target's node_modules is pre-seeded the same way — so the guard and
// receipts are exercised end-to-end without paying the multi-minute dependency
// closure copy.
//
// Run:  node test/released-tag-guard.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { inspect, render } from '../src/brain-doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = (cwd, message) => git(cwd,
  '-c', 'user.email=guard@test', '-c', 'user.name=guard-test',
  '-c', 'commit.gpgsign=false', 'commit', '-m', message);

const root = path.join(os.tmpdir(), `klypix-released-tag-guard-${process.pid}`);
if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test root: ${root}`);
// Junctions point back at the REAL node_modules: remove any link explicitly
// (never recursively) before clearing the root, so a recursive delete can
// never be argued into the developer's dependency tree.
const junctions = [];
const removeJunctions = () => {
  for (const link of junctions.splice(0)) {
    try { fs.rmdirSync(link); } catch { try { fs.unlinkSync(link); } catch { /* already gone */ } }
  }
};
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
fs.mkdirSync(root, { recursive: true });
const link = (target, at) => {
  fs.symlinkSync(target, at, 'junction');
  junctions.push(at);
};

// ── the package fixture: this checkout's code, in a repo we control ──────────
const pkgDir = path.join(root, 'pkg');
fs.mkdirSync(pkgDir, { recursive: true });
fs.cpSync(path.join(REPO, 'src'), path.join(pkgDir, 'src'), { recursive: true });
fs.cpSync(path.join(REPO, 'bin'), path.join(pkgDir, 'bin'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkgDir, 'package.json'));
// no trailing slash: a junction is a link entry, and `node_modules/` (dirs
// only) would leave it untracked-visible, slowing and dirtying `git status`.
fs.writeFileSync(path.join(pkgDir, '.gitignore'), 'node_modules\n');
link(path.join(REPO, 'node_modules'), path.join(pkgDir, 'node_modules'));
git(pkgDir, 'init');
git(pkgDir, 'add', '-A');
commit(pkgDir, 'guard fixture');
git(pkgDir, 'branch', '-M', 'core/guard-fixture');   // deterministic branch name
const headShort = git(pkgDir, 'rev-parse', '--short', 'HEAD');

let homes = 0;
const install = ({ ack = null, args = [] } = {}) => {
  const home = path.join(root, `home-${++homes}`);
  const brainDir = path.join(home, 'bundle');
  const proj = path.join(root, `proj-${homes}`);
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  link(path.join(REPO, 'node_modules'), path.join(brainDir, 'node_modules'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KLYPIX_MCP_INSTALL_DIR: brainDir,
    KLYPIX_AUTO_UPDATE: '0',
  };
  delete env.KLYPIX_MCP_ALLOW_UNTAGGED;   // ambient acknowledgement must not leak in
  if (ack === 'env') env.KLYPIX_MCP_ALLOW_UNTAGGED = '1';
  const result = spawnSync(process.execPath,
    [path.join(pkgDir, 'bin', 'klypix-install.mjs'), '--runtime-only', ...args],
    { cwd: proj, env, encoding: 'utf8', timeout: 120_000 });
  return {
    code: result.status,
    out: String(result.stdout || ''),
    err: String(result.stderr || ''),
    home,
    brainDir,
    proj,
    stamp: () => { try { return JSON.parse(fs.readFileSync(path.join(brainDir, '.brain-version.json'), 'utf8')); } catch { return null; } },
    runtime: () => { try { return JSON.parse(fs.readFileSync(path.join(brainDir, '.mcp-runtime.json'), 'utf8')); } catch { return null; } },
    rerun: (extraEnv = {}, extraArgs = []) => {
      const again = spawnSync(process.execPath,
        [path.join(pkgDir, 'bin', 'klypix-install.mjs'), '--runtime-only', ...extraArgs],
        { cwd: proj, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120_000 });
      return { code: again.status, out: String(again.stdout || ''), err: String(again.stderr || '') };
    },
  };
};

try {
  // ── G1: untagged working tree, no acknowledgement → refusal ────────────────
  const refused = install();
  ok(refused.code === 1, 'G1: an untagged source checkout is refused (exit 1)');
  ok(refused.err.includes('UNRELEASED')
    && refused.err.includes(`v${PKG_VERSION}`)
    && refused.err.includes('core/guard-fixture')
    && refused.err.includes(headShort),
  'G1: the refusal prints WHAT would have been deployed — version, branch, headShort');
  ok(refused.err.includes('--allow-untagged') && refused.err.includes('KLYPIX_MCP_ALLOW_UNTAGGED'),
    'G1: the refusal names both acknowledgement forms');
  ok(refused.stamp() === null && refused.runtime() === null
    && !fs.existsSync(path.join(refused.brainDir, 'klypix-mcp-server.mjs')),
  'G1: a refusal deploys nothing — no receipts, no staged server');
  ok(!fs.existsSync(path.join(refused.brainDir, '.install.lock')),
    'G1: the install lock is released on refusal');

  // ── G2: env acknowledgement → honest dev-owned receipts ────────────────────
  const acked = install({ ack: 'env' });
  ok(acked.code === 0 && /untagged source deploy acknowledged/.test(acked.out)
    && acked.out.includes('core/guard-fixture') && acked.out.includes(headShort),
  'G2: KLYPIX_MCP_ALLOW_UNTAGGED=1 proceeds and states what it deployed');
  const devStamp = acked.stamp();
  ok(devStamp?.brainVersion === PKG_VERSION && devStamp?.via === 'dev' && devStamp?.dev === true
    && devStamp?.sourceSha === headShort && devStamp?.branch === 'core/guard-fixture',
  'G2: .brain-version.json records via dev, dev:true, sourceSha, branch — not a fake npm delivery');
  ok(devStamp?.dirty === false, 'G2: a clean tree stamps dirty:false');
  const devRuntime = acked.runtime();
  ok(devRuntime?.channel === 'dev' && devRuntime?.dev === true && devRuntime?.version === PKG_VERSION,
    'G2: .mcp-runtime.json carries the same dev provenance (crash between receipts stays marked)');
  ok(fs.existsSync(path.join(acked.brainDir, 'klypix-mcp-server.mjs')),
    'G2: the acknowledged deploy actually installs the bundle');

  // ── G3: the dev-owned stamp mechanically protects the deploy ───────────────
  const preserved = acked.rerun();   // plain re-install, no acknowledgement
  ok(preserved.code === 0 && /dev deploy owns/.test(preserved.out) && acked.stamp()?.via === 'dev',
    'G3: a later plain install PRESERVES the dev deploy instead of silently replacing it');

  // ── G4: the --allow-untagged flag is equivalent to the env form ────────────
  const flagAcked = install({ args: ['--allow-untagged'] });
  ok(flagAcked.code === 0 && flagAcked.stamp()?.dev === true,
    'G4: --allow-untagged acknowledges exactly like the env variable');

  // ── G5: a dirty tree is recorded honestly ──────────────────────────────────
  const dirtyMarker = path.join(pkgDir, 'uncommitted-work.txt');
  fs.writeFileSync(dirtyMarker, 'uncommitted');
  const dirty = install({ ack: 'env' });
  ok(dirty.code === 0 && dirty.stamp()?.dirty === true,
    'G5: uncommitted changes at deploy time stamp dirty:true');
  fs.rmSync(dirtyMarker);

  // ── G6: a release-tagged HEAD keeps the byte-compatible released path ──────
  git(pkgDir, 'tag', `v${PKG_VERSION}`);
  const released = install();   // no acknowledgement needed
  ok(released.code === 0 && !/untagged source deploy acknowledged/.test(released.out),
    'G6: a checkout at its release tag installs without acknowledgement');
  const npmStamp = released.stamp();
  ok(npmStamp?.via === 'npm' && npmStamp?.dirty === false && !('dev' in npmStamp) && !('sourceSha' in npmStamp),
    'G6: the released path writes the exact pre-guard receipt shape (via npm, dirty:false, no dev/sourceSha)');
  ok(released.runtime()?.channel === 'npm' && !('dev' in released.runtime()),
    'G6: the released runtime receipt stays channel npm');

  // ── G6b: a TAGGED but dirty tree installs, with an honest dirty stamp ──────
  // The tag certifies HEAD's bytes, not the working tree's — uncommitted edits
  // on a tagged checkout must not impersonate a clean released delivery.
  const taggedDirtyMarker = path.join(pkgDir, 'uncommitted-on-tag.txt');
  fs.writeFileSync(taggedDirtyMarker, 'uncommitted');
  const taggedDirty = install();   // no acknowledgement needed — the tag stands
  ok(taggedDirty.code === 0 && /uncommitted changes/.test(taggedDirty.out),
    'G6b: a tagged-but-dirty checkout installs without acknowledgement and says the tree is dirty');
  const taggedDirtyStamp = taggedDirty.stamp();
  ok(taggedDirtyStamp?.via === 'npm' && taggedDirtyStamp?.dirty === true && !('dev' in taggedDirtyStamp)
    && taggedDirtyStamp?.sourceSha === headShort && taggedDirtyStamp?.branch === 'core/guard-fixture',
  'G6b: the stamp records dirty:true + sourceSha/branch instead of a clean npm delivery');
  ok(taggedDirty.runtime()?.channel === 'npm' && !('dev' in taggedDirty.runtime()),
    'G6b: the runtime receipt stays channel npm (auto-update can still heal to a clean release)');
  fs.rmSync(taggedDirtyMarker);

  // ── D: brain_doctor's advisory CHECKOUT line ───────────────────────────────
  const emptyHome = path.join(root, 'doctor-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const initDocRepo = (name, version) => {
    const dir = path.join(root, `doc-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2));
    git(dir, 'add', '-A');
    commit(dir, 'init');
    git(dir, 'branch', '-M', 'main');
    return dir;
  };
  const repoU = initDocRepo('guard-doc-untagged', '2.0.0');
  const untaggedReport = inspect({ home: emptyHome, projectDir: repoU });
  ok(untaggedReport.checkout?.releaseState === 'untagged-working-tree'
    && untaggedReport.checkout.version === '2.0.0'
    && untaggedReport.checkout.branch === 'main'
    && typeof untaggedReport.checkout.headShort === 'string',
  'D1: doctor reports an untagged versioned checkout with branch + version');
  ok(!('checkout' in untaggedReport.layers)
    && !untaggedReport.actions.some((a) => /CHECKOUT|untagged/i.test(a)),
  'D1: the checkout state is advisory — it never becomes a layer or an action');
  const untaggedText = render(untaggedReport, { color: false });
  ok(/CHECKOUT/.test(untaggedText) && /untagged working tree/.test(untaggedText)
    && untaggedText.includes('v2.0.0') && untaggedText.includes('branch main'),
  'D1: the rendered report carries ONE advisory checkout line (state, version, branch)');
  ok((untaggedText.match(/CHECKOUT/g) || []).length === 1, 'D1: exactly one CHECKOUT line');

  const repoT = initDocRepo('guard-doc-tagged', '2.0.0');
  git(repoT, 'tag', 'v2.0.0');
  const taggedReport = inspect({ home: emptyHome, projectDir: repoT });
  ok(taggedReport.checkout?.releaseState === 'released-tag',
    'D2: a HEAD carrying its release tag reports released-tag');
  ok(/CHECKOUT.*release tag.*v2\.0\.0/.test(render(taggedReport, { color: false })),
    'D2: the released state renders as an ok line');

  const plainDir = path.join(root, 'doc-plain');
  fs.mkdirSync(plainDir, { recursive: true });
  const plainReport = inspect({ home: emptyHome, projectDir: plainDir });
  ok(plainReport.checkout === null && !/CHECKOUT/.test(render(plainReport, { color: false })),
    'D3: a non-git project omits the checkout block and the line entirely');

  ok(untaggedReport.verdict === plainReport.verdict,
    'D4: an untagged checkout never changes the doctor verdict (advisory, never failing)');
} finally {
  removeJunctions();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures
  ? `\n[x] ${failures} released-tag-guard assertion(s) failed`
  : '\n[ok] released-tag-guard: all assertions passed');
process.exit(failures ? 1 : 0);
