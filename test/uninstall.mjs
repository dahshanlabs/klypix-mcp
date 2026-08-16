// UNINSTALL / UNLINK contract suite — the removal path, which until 2026-07-30
// did not exist at all (`npx klypix-mcp uninstall` printed nothing and exited 0).
//
// An uninstaller is the highest-blast-radius code in the package: it edits three
// machine-global host config files and up to 14 files per project. The assertions
// that matter are therefore not "did it remove things" but:
//
//   A  --check / --dry-run writes NOTHING (content-addressed tree hash) and exits 1
//   B  unlink removes exactly the 14 managed files
//   C  user-authored content around a managed block SURVIVES byte-for-byte, and so
//      do sibling MCP servers, sibling hooks and sibling TOML tables
//   D  a second run is a clean no-op that exits 0 (idempotent)
//   E  brain.klypix — and every .klypix/.any canvas — is NEVER touched
//   F  an unparseable file is BLOCKED and left untouched, never overwritten
//   G  machine-global removal is ownership-scoped
//   H  the argv shape is the fixed one: `unlink <dir> --check` audits <dir> and
//      leaves the cwd alone (the klypix-link slice(3) P0, which in an uninstaller
//      would DELETE when asked to preview)
//   I  the removal map cannot silently fall out of sync with the projection map
//
// Hermetic: every fixture lives under the OS temp dir, every spawn gets a throwaway
// HOME + KLYPIX_MCP_INSTALL_DIR. It never reads or writes the developer's real
// ~/.claude, ~/.codex, or any real project.
// Run:  node test/uninstall.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { linkProject, mergeCodexGlobalInstructions } from '../src/agent-rules.mjs';
import { mergeCodexPresenceHooks } from '../src/codex-hooks.mjs';
import { PROJECT_TARGETS, assertRemovable, planUnlink } from '../src/uninstall.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNINSTALL = path.join(REPO, 'bin', 'klypix-uninstall.mjs');
const LINK = path.join(REPO, 'bin', 'klypix-link.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } };
const tmp = (tag) => {
  const p = path.join(os.tmpdir(), `klypix-uninstall-${tag}`);
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

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
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, 'utf8'); };

const run = (args, { cwd = REPO, home, timeout = 60_000 } = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    input: '',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KLYPIX_BRAIN_NUDGE: 'off',
      // ALWAYS explicit — never let a stray inherited value point a test at the
      // developer's real bundle.
      KLYPIX_MCP_INSTALL_DIR: path.join(home, '.claude', 'project-brain'),
      KLYPIX_AUTO_UPDATE: '0',
    },
  });
  return { code: result.status, out: String(result.stdout || ''), err: String(result.stderr || '') };
};

// A project with a REAL prior life: user prose in AGENTS.md, a sibling MCP server,
// an unrelated file, and a canvas. Path deliberately contains a space and non-ASCII.
const USER_PROSE = '# My project\n\nUser prose here — keep me.\n';
const SIBLING_MCP = '{\n  "mcpServers": {\n    "other-server": {\n      "command": "node",\n      "args": [\n        "x.js"\n      ]\n    }\n  }\n}\n';
const seedProject = (tag) => {
  const root = path.join(tmp(tag), 'my prôject');
  fs.mkdirSync(root, { recursive: true });
  write(path.join(root, 'AGENTS.md'), USER_PROSE);
  write(path.join(root, '.mcp.json'), SIBLING_MCP);
  write(path.join(root, 'brain.klypix'), 'PRETEND-CANVAS-BYTES');
  write(path.join(root, 'notes.klypix'), 'ANOTHER-CANVAS');
  write(path.join(root, 'README.md'), '# readme\n');
  return root;
};

const HOME_A = tmp('home-a');

// ── I — the removal map cannot drift from the projection map ──────────────────
// linkProject IS the writer's source of truth. If a future release adds a 15th
// target and nobody teaches the remover about it, that must fail HERE, loudly —
// not silently leave a file behind on a user's machine.
{
  const probe = tmp('i-probe');
  const projected = linkProject(probe, { check: true });
  const projectedRels = [...projected.rules, ...projected.mcp].map((r) => String(r.file).replace(/\\/g, '/')).sort();
  const knownRels = Object.keys(PROJECT_TARGETS).sort();
  ok(projectedRels.length === 14, `I: linkProject still projects 14 managed files (saw ${projectedRels.length})`);
  ok(projectedRels.join('|') === knownRels.join('|'),
    'I: every projected target has a removal recipe (no drift between link and unlink)');
  ok(snap(probe) === '', 'I: computing the plan wrote nothing into the probe directory');

  // …and an unknown target is BLOCKED, not skipped. Proven by planning against a
  // fabricated projection is impossible without touching agent-rules, so assert the
  // guard exists in the shape the planner depends on.
  ok(typeof PROJECT_TARGETS['.vscode/mcp.json']?.wrapKey === 'string'
    && PROJECT_TARGETS['.vscode/mcp.json'].wrapKey === 'servers',
    'I: .vscode/mcp.json is removed under its OWN wrap key ("servers", not "mcpServers")');
}

// ── E(unit) — the canvas guard is a hard gate, not a convention ───────────────
{
  let threw = false;
  try { assertRemovable(path.join(os.tmpdir(), 'brain.klypix')); } catch { threw = true; }
  ok(threw, 'E: assertRemovable() refuses a .klypix path');
  threw = false;
  try { assertRemovable(path.join(os.tmpdir(), 'legacy.any')); } catch { threw = true; }
  ok(threw, 'E: assertRemovable() refuses a legacy .any canvas too');
  ok(assertRemovable(path.join(os.tmpdir(), 'AGENTS.md')).endsWith('AGENTS.md'),
    'E: a normal managed file passes the guard');
}

// ── A/B/C/D/E — the full project round trip ──────────────────────────────────
{
  const project = seedProject('abc');
  const virgin = snap(project);
  const brainBytes = read(path.join(project, 'brain.klypix'));

  const linked = run([LINK, project], { home: HOME_A });
  ok(linked.code === 0 && /14 file\(s\) written/.test(linked.out), 'B: fixture linked (14 managed files projected)');
  const afterLink = snap(project);

  // A — dry run writes NOTHING.
  const dry = run([UNINSTALL, 'unlink', project, '--check'], { home: HOME_A });
  ok(snap(project) === afterLink, 'A: `unlink --check` created/changed/deleted ZERO files (tree hash unchanged)');
  ok(dry.code === 1, 'A: `unlink --check` exits 1 while managed files remain (usable as a gate)');
  ok(/DRY RUN — nothing was changed/.test(dry.out), 'A: the dry run says plainly that nothing changed');
  ok(/14 item\(s\) still present/.test(dry.out), 'A: the dry run counts all 14 managed items');
  ok(/never touched by this command/.test(dry.out), 'A: the output states that brain.klypix is never touched');

  // …and the inventory is printed BEFORE anything happens.
  ok(dry.out.indexOf('AGENTS.md') < dry.out.indexOf('still present'),
    'A: the full inventory is printed before the verdict');

  // The bare form refuses to act.
  const bare = run([UNINSTALL, 'unlink', project], { home: HOME_A });
  ok(bare.code === 2 && snap(project) === afterLink,
    'A: without --yes it exits 2 and changes nothing (no accidental removal)');

  // B/C — remove for real.
  const done = run([UNINSTALL, 'unlink', project, '--yes'], { home: HOME_A });
  ok(done.code === 0, 'B: `unlink --yes` exits 0');
  for (const rel of Object.keys(PROJECT_TARGETS)) {
    if (rel === 'AGENTS.md' || rel === '.mcp.json') continue;   // shared files: asserted below
    ok(!fs.existsSync(path.join(project, rel)), `B: ${rel} is gone`);
  }
  ok(read(path.join(project, 'AGENTS.md')) === USER_PROSE,
    'C: the user prose in AGENTS.md survives BYTE-FOR-BYTE (only the managed fence was removed)');
  ok(read(path.join(project, '.mcp.json')) === SIBLING_MCP,
    'C: the sibling MCP server survives byte-for-byte; only klypix-canvas was removed');
  ok(read(path.join(project, 'README.md')) === '# readme\n', 'C: an unrelated file is untouched');
  ok(read(path.join(project, 'brain.klypix')) === brainBytes, 'E: brain.klypix is byte-identical after removal');
  ok(read(path.join(project, 'notes.klypix')) === 'ANOTHER-CANVAS', 'E: a second canvas is untouched');

  // D — idempotent.
  const again = run([UNINSTALL, 'unlink', project, '--check'], { home: HOME_A });
  ok(again.code === 0 && /nothing to remove/.test(again.out), 'D: a second `--check` reports nothing to remove and exits 0');
  const beforeSecondApply = snap(project);
  const reapply = run([UNINSTALL, 'unlink', project, '--yes'], { home: HOME_A });
  ok(reapply.code === 0 && snap(project) === beforeSecondApply,
    'D: a second `--yes` is a clean no-op — exit 0, not one byte changed');

  // Backups exist and are honest restore points, not counted as "remaining".
  ok(fs.existsSync(path.join(project, 'AGENTS.md.klypix-bak')), 'C: a .klypix-bak restore point was written before AGENTS.md changed');
  ok(read(path.join(project, 'AGENTS.md.klypix-bak'))?.includes('klypix-brain:start'),
    'C: the backup holds the PRE-removal content (the fence is in it)');
  ok(/restore point\(s\) exist/.test(again.out), 'D: leftover backups are reported, not silently deleted');

  // …and --purge-backups clears them, restoring the project to its original shape.
  const purged = run([UNINSTALL, 'unlink', project, '--purge-backups'], { home: HOME_A });
  ok(purged.code === 0, 'D: `--purge-backups` on a clean project exits 0');
  ok(snap(project) === virgin,
    'D: after unlink + purge, the project is byte-identical to before it was ever linked');
}

// ── F — an unparseable managed file is BLOCKED, never overwritten ─────────────
{
  const project = seedProject('f');
  run([LINK, project], { home: HOME_A });
  const broken = '{ not json at all';
  write(path.join(project, '.cursor', 'mcp.json'), broken);

  const dry = run([UNINSTALL, 'unlink', project, '--check'], { home: HOME_A });
  ok(dry.code === 1 && /BLOCKED/.test(dry.out), 'F: an unparseable MCP config is reported as BLOCKED');
  ok(/invalid JSON/.test(dry.out), 'F: the reason is named, not swallowed');

  const done = run([UNINSTALL, 'unlink', project, '--yes'], { home: HOME_A });
  ok(read(path.join(project, '.cursor', 'mcp.json')) === broken, 'F: the unparseable file is left EXACTLY as it was');
  ok(done.code === 1, 'F: the run exits 1 — a blocked item is never reported as a clean uninstall');
  ok(/could NOT be removed/.test(done.err + done.out), 'F: the summary says something could not be removed');
}

// ── H — argv: the named directory is honoured, the cwd is not touched ─────────
// This is the klypix-link slice(3) class. In an uninstaller the same bug would
// delete the wrong project, or delete when asked to preview.
{
  const cwd = seedProject('h-cwd');
  const target = seedProject('h-target');
  run([LINK, cwd], { home: HOME_A });
  run([LINK, target], { home: HOME_A });
  const cwdBefore = snap(cwd);

  const dry = run([UNINSTALL, 'unlink', target, '--check'], { cwd, home: HOME_A });
  ok(dry.out.includes(target), 'H: `unlink <dir> --check` audits the NAMED directory');
  ok(!dry.out.includes(`in ${cwd}`), 'H: it does not audit the cwd');
  ok(snap(cwd) === cwdBefore, 'H: --check touched neither directory');

  const done = run([UNINSTALL, 'unlink', target, '--yes'], { cwd, home: HOME_A });
  ok(done.code === 0, 'H: `unlink <dir> --yes` succeeds');
  ok(snap(cwd) === cwdBefore, 'H: the CWD project is COMPLETELY untouched — the positional directory is not dropped');
  ok(!fs.existsSync(path.join(target, 'GEMINI.md')), 'H: the NAMED directory was the one that got cleaned');

  // A directory literally named `unlink` stays addressable — by absolute path and
  // by the explicit relative form. (The bare token is always the subcommand: it
  // must never be able to flip an `unlink` into a machine-global uninstall.)
  const oddRoot = tmp('h-odd');
  const odd = path.join(oddRoot, 'unlink');
  fs.mkdirSync(odd, { recursive: true });
  run([LINK, odd], { home: HOME_A });
  const abs = run([UNINSTALL, 'unlink', odd, '--check'], { cwd: oddRoot, home: HOME_A });
  ok(abs.out.includes(odd) && abs.code === 1,
    'H: a project directory named `unlink` is addressable by absolute path');
  const rel = run([UNINSTALL, 'unlink', './unlink', '--check'], { cwd: oddRoot, home: HOME_A });
  ok(rel.out.includes(odd) && rel.code === 1,
    'H: …and by the explicit relative form ./unlink');
  ok(/project-local removal/.test(rel.out),
    'H: the leading `unlink` token always selects project-local mode — it can never silently become a machine-global run');
}

// ── G — machine-global removal is ownership-scoped ────────────────────────────
{
  const home = tmp('g-home');
  const brainDir = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(path.join(brainDir, 'node_modules', 'zod'), { recursive: true });
  fs.mkdirSync(path.join(brainDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(brainDir, 'semantic'), { recursive: true });
  write(path.join(brainDir, 'registry.json'), '{"brains":[]}');
  write(path.join(brainDir, 'global-brain-hook.mjs'), '// engine');

  const settings = path.join(home, '.claude', 'settings.json');
  write(settings, JSON.stringify({
    theme: 'dark',
    hooks: {
      SessionStart: [
        { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node "C:/x/global-brain-hook.mjs"' }] },
        { hooks: [{ type: 'command', command: 'my-own-tool.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/global-brain-hook.mjs" --capture' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'unrelated.sh' }] }],
    },
  }, null, 2) + '\n');

  const codexToml = path.join(home, '.codex', 'config.toml');
  write(codexToml, [
    'model = "gpt-5"',
    '',
    '[mcp_servers.my-other-server]',
    'command = "node"',
    'args = ["srv.js"]',
    '',
    '[mcp_servers.klypix-canvas]',
    'command = "node"',
    'args = ["-e", "x", "--vault", "."]',
    'startup_timeout_sec = 120',
    '',
  ].join('\n'));

  write(path.join(home, '.codex', 'AGENTS.md'), 'my own guidance\n');
  mergeCodexGlobalInstructions(home);
  mergeCodexPresenceHooks({ home, command: 'node "C:/x/codex-brain-hook.mjs"' });

  const dry = run([UNINSTALL, '--check'], { home });
  ok(dry.code === 1 && /5 item\(s\) still present/.test(dry.out),
    'G: the machine plan finds all 5 machine-global items (hooks · guidance · toml · codex-hooks · bundle)');
  ok(/registry\.json goes with it/.test(dry.out) && /semantic\/ goes with it/.test(dry.out),
    'G: the consequences of deleting the bundle are surfaced BEFORE acting');
  ok(fs.existsSync(brainDir) && read(settings).includes('global-brain-hook'),
    'G: --check changed nothing machine-global');

  const done = run([UNINSTALL, '--yes', '--keep-semantic'], { home });
  ok(done.code === 0, 'G: machine-global removal exits 0');

  const nextSettings = JSON.parse(read(settings));
  ok(nextSettings.theme === 'dark', 'G: unrelated settings.json keys survive');
  ok(!JSON.stringify(nextSettings).includes('global-brain-hook'), 'G: every klypix hook is gone');
  ok(JSON.stringify(nextSettings).includes('my-own-tool.sh'), 'G: the user\'s own hook in the SAME event group survives');
  ok(JSON.stringify(nextSettings).includes('unrelated.sh'), 'G: an unrelated hook event survives');

  const nextToml = read(codexToml);
  ok(nextToml.includes('[mcp_servers.my-other-server]') && nextToml.includes('model = "gpt-5"'),
    'G: sibling Codex TOML tables and top-level keys survive');
  ok(!/klypix/i.test(nextToml), 'G: the klypix Codex MCP table is gone');

  ok(read(path.join(home, '.codex', 'AGENTS.md')).trim() === 'my own guidance',
    'G: the user\'s own ~/.codex/AGENTS.md guidance survives; only the fenced block went');
  ok(!/codex-brain-hook/.test(read(path.join(home, '.codex', 'hooks.json')) || ''),
    'G: the Codex presence hooks are gone');
  ok(!fs.existsSync(path.join(brainDir, 'global-brain-hook.mjs')) && !fs.existsSync(path.join(brainDir, 'node_modules')),
    'G: the engine bundle and its dependency closure are gone');
  ok(fs.existsSync(path.join(brainDir, 'semantic')),
    'G: --keep-semantic preserved the on-device model npm cannot re-download');

  const again = run([UNINSTALL, '--check', '--keep-semantic'], { home });
  ok(again.code === 0 && /nothing to remove/.test(again.out),
    'D: the machine-global run is idempotent under the same flags — second --check exits 0');
}

// ── E(bundle) — a canvas inside the bundle directory blocks the rm -rf ────────
{
  const home = tmp('e-home');
  const brainDir = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(brainDir, { recursive: true });
  write(path.join(brainDir, 'global-brain-hook.mjs'), '// engine');
  write(path.join(brainDir, 'someones-brain.klypix'), 'USER DATA THAT MUST NOT DIE');

  const done = run([UNINSTALL, '--yes'], { home });
  ok(read(path.join(brainDir, 'someones-brain.klypix')) === 'USER DATA THAT MUST NOT DIE',
    'E: a canvas stored inside the engine directory BLOCKS the directory removal instead of dying with it');
  ok(done.code === 1 && /refusing to delete/.test(done.err + done.out),
    'E: that refusal is reported and exits 1 — never a silent partial success');
}

// ── usage ────────────────────────────────────────────────────────────────────
{
  const help = run([UNINSTALL, '--help'], { home: HOME_A });
  ok(help.code === 0 && /Usage:/.test(help.out), 'usage: --help prints usage and exits 0');
  const bad = run([UNINSTALL, '--force-yes-really'], { home: HOME_A });
  ok(bad.code === 3 && /unknown flag/.test(bad.err), 'usage: an unknown flag exits 3 with a message (never a surprise removal)');
  const both = run([UNINSTALL, '--check', '--yes'], { home: HOME_A });
  ok(both.code === 3, 'usage: --check and --yes together is a usage error, not a coin flip');
}

// ── plan purity — planUnlink() never writes, even on a directory that does not exist ──
{
  const ghost = path.join(os.tmpdir(), 'klypix-uninstall-ghost', 'nope');
  rmrf(path.dirname(ghost));
  const plan = planUnlink(ghost);
  ok(plan.items.length === 14 && plan.items.every((i) => i.action === 'none'),
    'plan: an unlinked project plans 14 no-ops');
  ok(!fs.existsSync(ghost), 'plan: planning a non-existent directory did not create it');
}

console.log(failures
  ? `\n✗ ${failures} uninstall assertion(s) failed`
  : '\n✓ uninstall: all assertions passed');
process.exit(failures ? 1 : 0);
