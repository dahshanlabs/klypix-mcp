// One command that knows where it is.
//
// Until 1.71 a user had to know three things nobody told them: that `install`
// wires the machine but not the project, that `link` writes the per-editor
// config, and that `init` seeds the brain. Miss the middle one — as the website
// invited people to — and seven of eight editors showed an empty MCP panel with
// no error. A promise is only as true as its quietest step, so this module
// deletes the steps instead of documenting them.
//
// It deliberately DELEGATES rather than reimplements: the brain seed comes from
// the existing `init` verb and the merge driver from `git-driver install`, both
// already tested and both idempotent (init refuses to overwrite an existing
// brain; the driver re-registers harmlessly). Running them as child processes
// keeps their exact behaviour and keeps this file thin — a duplicated seed is a
// second source of truth waiting to drift.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { detectEditors } from './editor-detect.mjs';
import { linkProject } from './agent-rules.mjs';
import { verifyMcpConfig, readLaunchSpec } from './mcp-verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');
const BRAIN_NAMES = ['brain.klypix', 'brain.any'];
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function runCli(args, cwd, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || ''), err: String(stderr || ''), code: error?.code ?? 0 });
    });
  });
}

/**
 * Where does this project actually start?
 *
 * Users run commands from wherever they happen to be — `src/`, `admin/`, a
 * package folder — so cwd is the wrong answer more often than it is the right
 * one. An existing brain wins over the git root, because a monorepo may keep
 * per-package brains; the git root is the fallback that makes a fresh repo seed
 * its brain beside the code rather than three levels down.
 */
export function resolveProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const chain = [];
  for (let i = 0; i < 40; i++) {
    chain.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of chain) {
    for (const name of BRAIN_NAMES) if (exists(path.join(d, name))) return { root: d, why: `found ${name}` };
  }
  for (const d of chain) {
    if (exists(path.join(d, '.git'))) return { root: d, why: 'git repository root' };
  }
  return { root: path.resolve(startDir), why: 'current directory' };
}

// Manifests that mark a directory as somebody's project even without git.
// Non-developers are a first-class audience here, so "no repo" must not mean
// "no brain" — but it does mean we need SOME positive signal before writing.
const PROJECT_MANIFESTS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'CMakeLists.txt',
  'README.md', 'AGENTS.md', 'CLAUDE.md',
];

/**
 * Is it safe and sensible to wire this directory?
 *
 * `install` is run from wherever the user happens to be standing, and the
 * failure we must never ship is seeding a brain into a home directory or a
 * drive root because someone typed the command in the wrong window. A refusal
 * is cheap; an unexpected brain.klypix in C:\Users\me is not.
 */
export function projectSignal(root, { home = null } = {}) {
  const resolved = path.resolve(root);
  const homeDir = path.resolve(home || (process.env.USERPROFILE || process.env.HOME || ''));
  if (homeDir && resolved === homeDir) return { ok: false, why: 'this is your home folder, not a project' };
  if (path.dirname(resolved) === resolved) return { ok: false, why: 'this is a drive root, not a project' };

  for (const name of BRAIN_NAMES) if (exists(path.join(resolved, name))) return { ok: true, why: `has ${name}` };
  if (exists(path.join(resolved, '.git'))) return { ok: true, why: 'git repository' };
  for (const name of PROJECT_MANIFESTS) if (exists(path.join(resolved, name))) return { ok: true, why: `has ${name}` };
  return { ok: false, why: 'no project files found here' };
}

// Every MCP config this project could carry, relative to its root. Kept beside
// the projection map's own list so the ownership check covers all six hosts,
// not just the Claude Code one the original migration knew about.
const MCP_FILES = [
  '.mcp.json', '.cursor/mcp.json', '.cline/mcp.json',
  '.gemini/settings.json', '.vscode/mcp.json', '.codex/config.toml',
];

/**
 * Is this config pinned to a server the PROJECT owns?
 *
 * A repo-relative node launch (`scripts/klypix-mcp-server.mjs`) is a deliberate
 * choice: it resolves offline, is identical on every machine, and rides a
 * vendored bundle the repo version-gates, so the running server can never skew
 * from what the repo ships. Replacing it with a machine-specific ~/.claude path
 * would break exactly the property it was chosen for — and silently. The
 * existing `.mcp.json` migration has always honoured this; automatic setup must
 * honour it across every host.
 */
export function isProjectOwnedMcp(file) {
  const spec = readLaunchSpec(file);
  if (!spec.ok) return false;
  const first = spec.args?.[0];
  return /(^|[\\/])node(\.exe)?$/i.test(spec.command)
    && typeof first === 'string'
    && first !== '-e'
    && !first.startsWith('-')
    && !path.isAbsolute(first);
}

/** The written config most worth proving — the host we are running inside, if any. */
function pickVerifyTarget(written, present) {
  const inside = [...present.values()].find((e) => /running inside it/.test(e.why));
  const byEditor = (id) => written.find((w) => (w.editors || []).includes(id));
  return (inside && byEditor(inside.id))
    || byEditor('claude-code')
    || byEditor('cursor')
    || written[0]
    || null;
}

/**
 * Wire this project end to end, then prove it.
 * @param {{ cwd?, verifyAll?, skipVerify?, timeoutMs? }} [opts]
 * @returns {Promise<object>} a structured report (also the `--json` payload)
 */
export async function runSetup(opts = {}) {
  const started = Date.now();
  const { root, why: rootWhy } = resolveProjectRoot(opts.cwd || process.cwd());
  const report = {
    schema: 1,
    project: root,
    rootReason: rootWhy,
    brain: null,
    editors: { present: [], skippedTargets: [] },
    wrote: [],
    gitDriver: null,
    verified: null,
    warnings: [],
  };

  // 0) Refuse politely rather than write into somewhere that isn't a project.
  const signal = projectSignal(root);
  if (!signal.ok) {
    report.skipped = signal.why;
    report.ms = Date.now() - started;
    return report;
  }
  report.rootReason = `${rootWhy}`;

  // 1) A brain, or there is nothing to wire.
  const brainPath = BRAIN_NAMES.map((n) => path.join(root, n)).find(exists);
  if (brainPath) {
    report.brain = { path: brainPath, created: false };
  } else {
    const seeded = await runCli(['init'], root);
    const madePath = BRAIN_NAMES.map((n) => path.join(root, n)).find(exists);
    if (!madePath) {
      report.brain = { path: null, created: false, error: (seeded.err || seeded.out).trim().slice(0, 300) || 'init produced no brain' };
      report.warnings.push('No brain could be created — nothing else could be wired.');
      report.ms = Date.now() - started;
      return report;
    }
    report.brain = { path: madePath, created: true };
  }

  // 2) Which hosts does this machine actually have?
  const detected = detectEditors();
  report.editors.present = [...detected.present.values()];

  // 3) Project config for those hosts only — plus anything the project already
  // carries, so a one-editor developer keeps their team's files current.
  const projectOwned = MCP_FILES.filter((rel) => isProjectOwnedMcp(path.join(root, rel)));
  const linked = linkProject(root, { editors: detected.present.keys(), exclude: projectOwned });
  report.editors.skippedTargets = linked.skipped;
  report.wrote = [...linked.rules, ...linked.mcp]
    .filter((t) => t.status !== 'error' && t.action !== 'skipped')
    .map((t) => ({ tool: t.tool, file: t.file, action: t.action || t.status || 'ok' }));
  for (const t of [...linked.rules, ...linked.mcp]) {
    if (t.status === 'error' || (t.action === 'skipped' && t.why)) {
      report.warnings.push(`${t.file}: ${t.why || 'could not be written'}`);
    }
  }

  // 4) The merge driver, silently — never a settings panel with an Install
  // button. Only meaningful inside a git repo.
  if (exists(path.join(root, '.git'))) {
    const drv = await runCli(['git-driver', 'install', root], root, 30_000);
    report.gitDriver = { ok: drv.ok, detail: (drv.out || drv.err).split('\n').find((l) => l.trim())?.trim() || null };
    if (!drv.ok) report.warnings.push('Could not register the .klypix merge driver — brain merges will need manual conflict resolution.');
  }

  // 5) Prove it. Writing a config is not evidence that a server starts, and the
  // failure mode of a wrong entry is silence, so setup does not exit until a
  // real client has connected and counted tools.
  if (!opts.skipVerify) {
    // linkProject reports per-file results, not the editor ids behind them, so
    // re-attach them here purely to choose WHICH config to prove.
    const idFor = {
      '.codex/config.toml': ['codex'], '.mcp.json': ['claude-code'], '.cursor/mcp.json': ['cursor'],
      '.cline/mcp.json': ['cline'], '.gemini/settings.json': ['gemini-cli', 'antigravity'], '.vscode/mcp.json': ['vscode', 'copilot'],
    };
    const mcpWritten = linked.mcp
      .filter((m) => m.status !== 'error' && m.action !== 'skipped')
      .map((m) => ({ ...m, editors: idFor[m.file] || [] }));
    // A project-owned config is left untouched but is still what the editor
    // will launch — and an unverified vendored path is precisely how a repo
    // once lost every brain verb for five days. Prove it too.
    for (const rel of projectOwned) {
      mcpWritten.push({ tool: `${rel} (project-owned)`, file: rel, editors: idFor[rel] || [] });
    }

    const chosen = opts.verifyAll ? mcpWritten : [pickVerifyTarget(mcpWritten, detected.present)].filter(Boolean);
    const results = [];
    for (const target of chosen) {
      const res = await verifyMcpConfig({
        file: path.join(root, target.file),
        projectDir: root,
        timeoutMs: opts.timeoutMs || 25_000,
      });
      results.push({ tool: target.tool, file: target.file, ...res });
      if (!res.ok) report.warnings.push(`${target.file} did not start a server: ${res.why}`);
    }
    report.verified = results;
  }

  report.ms = Date.now() - started;
  return report;
}

/** The five-line brief a human reads after the command finishes. */
export function renderBrief(report) {
  const L = [];
  const rel = (p) => path.relative(report.project, p).replace(/\\/g, '/') || path.basename(p);
  L.push('');
  if (report.skipped) {
    L.push(`  No project wired — ${report.skipped}.`);
    L.push(`  Run this again inside your project folder: cd <your project> && npx klypix-mcp install`);
    L.push('');
    return L.join('\n');
  }
  L.push(`  project   ${report.project}  (${report.rootReason})`);
  L.push(report.brain?.created
    ? `  brain     created ${rel(report.brain.path)} — a starter brain, ready for its first decision`
    : report.brain?.path ? `  brain     ${rel(report.brain.path)} (already here — left untouched)`
      : '  brain     ✗ none');

  const names = report.editors.present.map((e) => e.name);
  L.push(`  editors   ${names.length ? names.join(' · ') : 'none detected'}`);

  const changed = report.wrote.filter((w) => w.action && !/^(ok|unchanged|current)$/i.test(w.action));
  L.push(`  wired     ${report.wrote.length} file(s)${changed.length ? ` · ${changed.length} updated` : ' · all current'}`
    + (report.editors.skippedTargets.length ? `   (skipped ${report.editors.skippedTargets.length} for tools you don't have)` : ''));

  if (report.gitDriver) {
    L.push(`  git       ${report.gitDriver.ok ? 'lossless .klypix merge driver registered' : '✗ merge driver not registered'}`);
  }

  for (const v of report.verified || []) {
    L.push(v.ok
      ? `  verified  ✓ ${v.toolCount} tools reachable via ${v.file} (${v.ms}ms)`
      : `  verified  ✗ ${v.file} — ${v.why}`);
  }

  L.push('');
  if (report.warnings.length) {
    for (const w of report.warnings) L.push(`  ⚠ ${w}`);
    L.push('');
  } else if ((report.verified || []).some((v) => v.ok)) {
    L.push('  Open the project in your editor and ask it: "sync with the KLYPIX brain."');
    L.push('');
  }
  return L.join('\n');
}
