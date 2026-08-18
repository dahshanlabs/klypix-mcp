// Install-honesty contract suite — `klypix-install --dry-run` / `--check` and
// the real install's upfront summary (adopter-honesty wave, 2026-08-18).
//
// The public criticism this answers: an installer that wires hooks, spawns a
// 24h auto-updater, and auto-installs git hooks per session must SAY so before
// acting, and must offer a zero-write preview. The assertions that matter:
//
//   A  --dry-run writes NOTHING (content-addressed tree hash over the sandbox
//      home AND the project) and exits 0; the report names the settings.json
//      hooks, the 24h auto-updater + KLYPIX_AUTO_UPDATE=0, the session
//      git-hook auto-install + KLYPIX_GIT_CAPTURE=0, and the uninstall path
//   B  --check is an exact alias of --dry-run
//   C  a broken ~/.claude/settings.json makes the dry run report WOULD REFUSE
//      and exit 1 — and still write nothing, byte-for-byte
//   D  the REAL install prints the one-screen summary (including both ongoing
//      behaviors and the uninstall/quiet switches) BEFORE any action line
//   E  a dry run against an already-installed machine classifies honestly:
//      zero new, zero changed, deps already present
//
// Hermetic: throwaway HOME + KLYPIX_MCP_INSTALL_DIR per case; the developer's
// real ~/.claude and ~/.codex are never touched. KLYPIX_MCP_ALLOW_UNTAGGED=1
// keeps the deploy guard deterministic whether or not HEAD carries the release
// tag (mid-branch it does not). Run: node test/install-dry-run.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'bin', 'klypix-install.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } };
const tmp = (tag) => {
  const p = path.join(os.tmpdir(), `klypix-install-dryrun-${tag}`);
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, 'utf8'); };

// Content-addressed tree snapshot — the only honest way to assert "wrote nothing".
const walk = (dir, base, out) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) { out.push(`${rel}/`); walk(full, base, out); }
    else if (entry.isFile()) out.push(`${rel} ${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`);
  }
  return out;
};
const snap = (dir) => walk(dir, dir, []).join('\n');

const run = (args, { cwd, home, timeout = 180_000 } = {}) => {
  const result = spawnSync(process.execPath, [INSTALL, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    input: '',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KLYPIX_MCP_INSTALL_DIR: path.join(home, '.claude', 'project-brain'),
      KLYPIX_MCP_ALLOW_UNTAGGED: '1',
      KLYPIX_AUTO_UPDATE: '0',
      KLYPIX_GIT_CAPTURE: '0',
      KLYPIX_SEMANTIC_WARM_ON_UPDATE: '0',
      KLYPIX_BRAIN_NUDGE: 'off',
    },
  });
  return { code: result.status, out: String(result.stdout || ''), err: String(result.stderr || '') };
};

const seedProject = (tag) => {
  const root = path.join(tmp(tag), 'proj');
  fs.mkdirSync(root, { recursive: true });
  try { execFileSync('git', ['init', '-q', root], { stdio: 'ignore', timeout: 10_000 }); } catch { /* preview degrades without git */ }
  write(path.join(root, 'README.md'), '# a project\n');
  return root;
};

// Every disclosure the dry run and the upfront summary are contractually
// required to carry. One place, so a future rewording cannot silently drop one.
const DISCLOSURES = [
  [/24h/, 'the 24h auto-update cadence'],
  [/KLYPIX_AUTO_UPDATE=0/, 'the auto-update opt-out switch'],
  [/git hook|commit capture/i, 'the session git-hook auto-install'],
  [/KLYPIX_GIT_CAPTURE=0/, 'the git-capture opt-out switch'],
  [/git-hook remove/, 'the per-repo git-hook removal command'],
  [/uninstall/, 'the uninstall path'],
];

// ── A: --dry-run writes nothing and discloses everything ─────────────────────
{
  const home = tmp('home-a');
  const proj = seedProject('proj-a');
  const before = { home: snap(home), proj: snap(proj) };
  const r = run(['--dry-run'], { cwd: proj, home });
  ok(r.code === 0, `A: --dry-run exits 0 (got ${r.code}; stderr: ${r.err.slice(0, 200)})`);
  ok(snap(home) === before.home && snap(proj) === before.proj,
    'A: --dry-run wrote NOTHING (tree hash identical in home and project)');
  ok(!fs.existsSync(path.join(home, '.claude', 'project-brain', '.install.lock')),
    'A: --dry-run never takes the install lock (the lock is itself a write)');
  ok(/settings\.json/.test(r.out) && /4 KLYPIX lifecycle hook|SessionStart/.test(r.out),
    'A: the report names the settings.json hook wiring');
  ok(/scripts would be staged/.test(r.out) && /would be copied/.test(r.out),
    'A: the report names the engine files and dependency copies');
  for (const [re, what] of DISCLOSURES) ok(re.test(r.out), `A: the report discloses ${what}`);
  ok(/nothing was written/i.test(r.out), 'A: the report states nothing was written');
}

// ── B: --check is an exact alias ─────────────────────────────────────────────
{
  const home = tmp('home-b');
  const proj = seedProject('proj-b');
  const before = { home: snap(home), proj: snap(proj) };
  const r = run(['--check'], { cwd: proj, home });
  ok(r.code === 0 && snap(home) === before.home && snap(proj) === before.proj,
    'B: --check behaves as an alias of --dry-run (exit 0, zero writes)');
}

// ── C: a broken settings.json → WOULD REFUSE, exit 1, still zero writes ──────
{
  const home = tmp('home-c');
  const proj = seedProject('proj-c');
  write(path.join(home, '.claude', 'settings.json'), '{ this is not JSON');
  const before = { home: snap(home), proj: snap(proj) };
  const r = run(['--dry-run'], { cwd: proj, home });
  ok(r.code === 1, `C: dry run exits 1 when the real install would refuse (got ${r.code})`);
  ok(/WOULD REFUSE/.test(r.out) && /invalid JSON/i.test(r.out),
    'C: the refusal is named, with the reason');
  ok(snap(home) === before.home && snap(proj) === before.proj,
    'C: the broken config (and everything else) is untouched byte-for-byte');
}

// ── D: the real install prints the summary BEFORE acting ─────────────────────
// --no-project keeps the case fast and scoped: machine engine + hooks + codex
// wiring in the sandbox home, no project setup / real-client verification.
const homeD = tmp('home-d');
{
  const proj = seedProject('proj-d');
  const r = run(['--no-project'], { cwd: proj, home: homeD });
  ok(r.code === 0, `D: real install (--no-project) succeeds in the sandbox (got ${r.code}; stderr: ${r.err.slice(0, 300)})`);
  const banner = r.out.indexOf('about to do the following');
  const firstAction = r.out.search(/✓ (installed|wired)/);
  ok(banner >= 0, 'D: the upfront summary banner is printed');
  ok(firstAction > banner && banner >= 0, 'D: the summary comes BEFORE the first action line');
  const summary = banner >= 0 && firstAction > banner ? r.out.slice(banner, firstAction) : '';
  for (const [re, what] of DISCLOSURES) ok(re.test(summary), `D: the upfront summary (not just later output) discloses ${what}`);
  ok(/--dry-run/.test(summary), 'D: the summary points at the --dry-run preview');
  ok(fs.existsSync(path.join(homeD, '.claude', 'project-brain', 'global-brain-hook.mjs')),
    'D: the install then actually happened (engine present in the sandbox)');
}

// ── E: dry run against an installed machine classifies honestly ──────────────
// --force clears the dev-owned preserve gate a mid-branch (untagged, dev:true)
// install records, so the comparison itself is what this case exercises.
{
  const proj = seedProject('proj-e');
  const before = snap(homeD);
  const r = run(['--dry-run', '--force'], { cwd: proj, home: homeD });
  ok(r.code === 0, `E: dry run over an existing install exits 0 (got ${r.code})`);
  const m = r.out.match(/new (\d+) · changed (\d+) · byte-identical (\d+)/);
  ok(Boolean(m) && m[1] === '0' && m[2] === '0' && Number(m[3]) > 0,
    `E: staged files classified byte-identical against the live install (got ${m ? m.slice(1).join('/') : 'no match'})`);
  ok(/deps: all required packages already present/.test(r.out),
    'E: the dependency plan reports nothing to copy');
  ok(snap(homeD) === before, 'E: and still writes nothing');
}

console.log(failures
  ? `\n✗ ${failures} install-dry-run assertion(s) failed`
  : '\n✓ install-dry-run: all assertions passed');
process.exit(failures ? 1 : 0);
