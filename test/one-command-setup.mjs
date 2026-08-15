// One-command setup (1.71.0) — `npx klypix-mcp install` wires the PROJECT too.
//
// Before this, `install` wired the machine and nothing a Cursor / Antigravity /
// Codex / Cline / Copilot user could see; the missing `link` step failed
// SILENTLY, which is the worst possible failure for config. Locks in:
//   S1  — resolveProjectRoot walks UP from a nested cwd and prefers an existing
//         brain over the git root (monorepos may keep per-package brains).
//   S2  — with no brain anywhere, it falls back to the git repository root.
//   S3  — projectSignal REFUSES the home directory and a drive root, so a
//         mistyped command can never seed a brain into C:\Users\me.
//   S4  — projectSignal accepts a brain, a git repo, or a project manifest, so
//         non-developers with no repo are still first-class.
//   S5  — detectEditors never fabricates: an empty home + empty env detects
//         nothing, and every positive carries the evidence that produced it.
//   S6  — an editors filter stops projecting files for hosts nobody installed.
//   S7  — but a target the PROJECT already carries is retained even when this
//         machine lacks that editor — a one-editor developer must keep their
//         team's committed configs current.
//   S8  — back-compat: linkProject with no editors option still projects all
//         14 managed files, exactly as every existing caller expects.
//   S9  — readLaunchSpec understands all three written shapes (mcpServers JSON,
//         VS Code `servers` JSON, Codex TOML).
//   S10 — the verification gate FAILS CLOSED on the real-world broken config
//         (an absolute container path) and passes on the good one. This is the
//         regression that cost a project all 17 brain verbs for five days.
//   S11 — runSetup refuses a non-project directory and writes nothing at all.
//   S12 — runSetup on a fresh repo seeds a brain, wires it, registers the merge
//         driver, and proves the result with a live handshake.
//   S13 — a PROJECT-OWNED server (repo-relative, vendored, version-gated by the
//         repo) is left byte-identical and reported, never silently replaced
//         with a machine-specific path. An explicit `link` still rewrites it:
//         an action the user did not ask for stays more conservative than one
//         they did.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { detectEditors } from '../src/editor-detect.mjs';
import { linkProject } from '../src/agent-rules.mjs';
import { readLaunchSpec, verifyMcpConfig } from '../src/mcp-verify.mjs';
import { resolveProjectRoot, projectSignal, runSetup, isProjectOwnedMcp } from '../src/setup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');
let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };
const tmps = [];
function tmpdir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `klypix-${name}-`));
  tmps.push(d);
  return d;
}
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

try {
  // ---- S1 / S2 — root resolution -----------------------------------------
  const repo = tmpdir('root');
  git(repo, 'init', '-q');
  const nested = path.join(repo, 'packages', 'web', 'src');
  fs.mkdirSync(nested, { recursive: true });

  const fromGit = resolveProjectRoot(nested);
  ok('S2 nested cwd resolves to the git root', fs.realpathSync(fromGit.root) === fs.realpathSync(repo));
  ok('S2 states why', /git/.test(fromGit.why));

  fs.writeFileSync(path.join(repo, 'packages', 'web', 'brain.klypix'), 'placeholder');
  const fromBrain = resolveProjectRoot(nested);
  ok('S1 an existing brain outranks the git root',
    fs.realpathSync(fromBrain.root) === fs.realpathSync(path.join(repo, 'packages', 'web')));

  // ---- S3 / S4 — the safety guard ----------------------------------------
  const home = os.homedir();
  ok('S3 refuses the home directory', projectSignal(home).ok === false);
  ok('S3 names the home reason', /home folder/.test(projectSignal(home).why));
  ok('S3 refuses a drive/filesystem root', projectSignal(path.parse(process.cwd()).root).ok === false);

  const bare = tmpdir('bare');
  ok('S4 refuses an empty directory', projectSignal(bare).ok === false);
  fs.writeFileSync(path.join(bare, 'package.json'), '{}');
  ok('S4 accepts a project manifest with no git', projectSignal(bare).ok === true);
  ok('S4 accepts a git repository', projectSignal(repo).ok === true);

  // ---- S5 — detection never fabricates -----------------------------------
  const emptyHome = tmpdir('home');
  const none = detectEditors({ home: emptyHome, platform: 'linux', env: {} });
  ok('S5 an empty machine detects no editors', none.present.size === 0);
  ok('S5 the full roster is still reported', none.all.length >= 10);

  fs.mkdirSync(path.join(emptyHome, '.cursor'), { recursive: true });
  const oneEditor = detectEditors({ home: emptyHome, platform: 'linux', env: {} });
  ok('S5 a real config dir is detected', oneEditor.present.has('cursor'));
  ok('S5 the positive carries its evidence', /\.cursor/.test(oneEditor.present.get('cursor').why));

  const viaEnv = detectEditors({ home: emptyHome, platform: 'linux', env: { CODEX_THREAD_ID: 'x' } });
  ok('S5 running inside a host counts as installed', viaEnv.present.has('codex'));
  ok('S5 env evidence is labelled as such', /running inside it/.test(viaEnv.present.get('codex').why));

  // ---- S6 / S7 / S8 — filtered projection --------------------------------
  const proj = tmpdir('link');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'placeholder');

  const all = linkProject(proj, { check: true });
  ok('S8 unfiltered still projects all 14 managed files', all.rules.length + all.mcp.length === 14);
  ok('S8 unfiltered skips nothing', all.skipped.length === 0);

  const filtered = linkProject(proj, { check: true, editors: ['cursor'] });
  const files = [...filtered.rules, ...filtered.mcp].map((f) => f.file);
  ok('S6 a cursor-only machine gets the cursor rule', files.includes('.cursor/rules/klypix-brain.mdc'));
  ok('S6 a cursor-only machine gets the cursor MCP config', files.includes('.cursor/mcp.json'));
  ok('S6 windsurf is not projected', !files.includes('.windsurf/rules/klypix-brain.md'));
  ok('S6 cline is not projected', !files.includes('.cline/mcp.json'));
  ok('S6 the skip is reported, not silent', filtered.skipped.some((s) => /windsurf/i.test(s.file)));
  ok('S6 AGENTS.md rides any detected host', files.includes('AGENTS.md'));

  fs.mkdirSync(path.join(proj, '.clinerules'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.clinerules', 'klypix-brain.md'), '# committed by a teammate');
  const withTeam = linkProject(proj, { check: true, editors: ['cursor'] });
  ok('S7 a teammate-committed target is retained without that editor',
    [...withTeam.rules, ...withTeam.mcp].map((f) => f.file).includes('.clinerules/klypix-brain.md'));

  const noEditors = linkProject(proj, { check: true, editors: [] });
  ok('S7 an empty editor set still keeps existing project files',
    [...noEditors.rules, ...noEditors.mcp].map((f) => f.file).includes('.clinerules/klypix-brain.md'));
  ok('S7 an empty editor set does NOT invent the standard file',
    !noEditors.rules.map((f) => f.file).includes('AGENTS.md'));

  // ---- S9 — launch specs for every written shape -------------------------
  const shapes = tmpdir('shapes');
  fs.writeFileSync(path.join(shapes, 'a.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'node', args: ['-e', 'x', '--vault', '.'] } } }));
  fs.writeFileSync(path.join(shapes, 'b.json'), JSON.stringify({ servers: { 'klypix-canvas': { command: 'node', args: ['y'], type: 'stdio' } } }));
  fs.writeFileSync(path.join(shapes, 'c.toml'), '[mcp_servers.klypix-canvas]\ncommand = "node"\nargs = ["-e", "z", "--", "--vault", "E:/p"]\ncwd = "E:/p"\n');

  const a = readLaunchSpec(path.join(shapes, 'a.json'));
  ok('S9 mcpServers JSON parses', a.ok && a.command === 'node' && a.args.includes('--vault'));
  const b = readLaunchSpec(path.join(shapes, 'b.json'));
  ok('S9 VS Code `servers` JSON parses', b.ok && b.args[0] === 'y');
  const c = readLaunchSpec(path.join(shapes, 'c.toml'));
  ok('S9 Codex TOML parses command, args and cwd', c.ok && c.command === 'node' && c.args.length === 5 && /p$/.test(c.cwd));
  ok('S9 a missing file fails closed', readLaunchSpec(path.join(shapes, 'nope.json')).ok === false);
  fs.writeFileSync(path.join(shapes, 'empty.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  ok('S9 a config without a klypix entry fails closed', readLaunchSpec(path.join(shapes, 'empty.json')).ok === false);

  // ---- S12 — the whole command, on a fresh repo --------------------------
  const fresh = tmpdir('setup');
  git(fresh, 'init', '-q');
  fs.writeFileSync(path.join(fresh, 'README.md'), '# fixture\n');
  const deep = path.join(fresh, 'src', 'deep');
  fs.mkdirSync(deep, { recursive: true });

  const report = await runSetup({ cwd: deep });
  ok('S12 resolves to the repo root from a nested cwd', fs.realpathSync(report.project) === fs.realpathSync(fresh));
  ok('S12 seeds a brain when none exists', report.brain?.created === true && fs.existsSync(path.join(fresh, 'brain.klypix')));
  ok('S12 wires at least the detected hosts', report.wrote.length > 0);
  ok('S12 registers the merge driver in a git repo', report.gitDriver?.ok === true);
  ok('S12 proves the result with a live handshake', report.verified?.[0]?.ok === true);
  ok('S12 the handshake counts real tools', (report.verified?.[0]?.toolCount || 0) > 0);
  ok('S12 brain_sync is among them', report.verified?.[0]?.hasBrainSync === true);
  ok('S12 a clean run reports no warnings', report.warnings.length === 0);

  const again = await runSetup({ cwd: fresh, skipVerify: true });
  ok('S12 is idempotent — the second run does not re-create the brain', again.brain?.created === false);

  // ---- S10 — the gate that catches the silent killer ---------------------
  const good = path.join(fresh, '.mcp.json');
  ok('S10 a good config verifies', (await verifyMcpConfig({ file: good, projectDir: fresh })).ok === true);

  const cfg = JSON.parse(fs.readFileSync(good, 'utf8'));
  const key = Object.keys(cfg.mcpServers).find((k) => /klypix/i.test(k));
  // The exact shape of the real incident: an absolute path from another
  // machine's container, committed as collateral in an unrelated change.
  cfg.mcpServers[key].args = ['-e', 'import("/home/vhsuser/.claude/project-brain/klypix-mcp-server.mjs")', '--', '--vault', '.'];
  const broken = path.join(fresh, 'broken.json');
  fs.writeFileSync(broken, JSON.stringify(cfg, null, 2));
  const verdict = await verifyMcpConfig({ file: broken, projectDir: fresh, timeoutMs: 15_000 });
  ok('S10 the container-path regression FAILS the gate', verdict.ok === false);
  ok('S10 and says why', typeof verdict.why === 'string' && verdict.why.length > 0);

  // ---- S13 — never clobber a project-owned server ------------------------
  // A repo-relative launch is chosen deliberately: it resolves offline and
  // rides a bundle the repo version-gates. Automatic setup must not silently
  // replace it with a machine-specific ~/.claude path.
  const owned = tmpdir('owned');
  git(owned, 'init', '-q');
  fs.writeFileSync(path.join(owned, 'brain.klypix'), 'placeholder');
  const ownedCfg = { mcpServers: { 'klypix-canvas': { command: 'node', args: ['scripts/klypix-mcp-server.mjs', '--vault', '.'] } } };
  fs.writeFileSync(path.join(owned, '.mcp.json'), JSON.stringify(ownedCfg, null, 2));

  ok('S13 a repo-relative node launch is recognised as project-owned',
    isProjectOwnedMcp(path.join(owned, '.mcp.json')) === true);
  ok('S13 the standard inline-eval entry is NOT project-owned',
    isProjectOwnedMcp(path.join(fresh, '.mcp.json')) === false);

  const ownedReport = await runSetup({ cwd: owned, skipVerify: true });
  const afterOwned = JSON.parse(fs.readFileSync(path.join(owned, '.mcp.json'), 'utf8'));
  ok('S13 setup leaves the project-owned entry byte-identical',
    afterOwned.mcpServers['klypix-canvas'].args[0] === 'scripts/klypix-mcp-server.mjs');
  ok('S13 and says so rather than staying silent',
    ownedReport.editors.skippedTargets.some((s) => s.file === '.mcp.json' && /project-owned/.test(s.why)));

  // ---- S11 — refuse to write outside a project ---------------------------
  const notAProject = tmpdir('empty');
  const refused = await runSetup({ cwd: notAProject, skipVerify: true });
  ok('S11 refuses a directory with no project signal', !!refused.skipped);
  ok('S11 writes nothing at all', fs.readdirSync(notAProject).length === 0);

  console.log(`✓ one-command setup — ${pass}/${pass} assertions`);
} finally {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}
