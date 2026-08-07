#!/usr/bin/env node
// Stable KLYPIX MCP entry point.
//
// CLI verbs still execute directly. A normal stdio launch stays attached to the
// host for the life of the session and delegates protocol work to a replaceable
// worker. Installed brain-core updates can therefore be validated and activated
// without asking Codex, Claude, Cursor, or another MCP host to restart.

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version; }
  catch {
    // The flattened ~/.claude/project-brain bundle bakes this literal.
    return '0.0.0';
  }
})();

const DIRECT = new Set(['install', 'link', 'doctor', 'runtime', 'conformance', 'garden-code', 'init', 'git-driver', 'git-hook', 'diff', 'pr-brief', 'uninstall', 'bench']);

const USAGE = [
  `klypix-mcp ${PKG_VERSION} — shared project brain + MCP coordination server.`,
  '',
  'Verbs:',
  '  install [--force] [--codex-hooks]   install/update this machine\'s brain engine + Claude Code hooks',
  '  link [dir] [--check]                project this project\'s 14 managed agent config files (--check audits, writes nothing, exits 1 on drift)',
  '  doctor [--npm] [--all] [--json]     read-only self-check; exits 1 on drift',
  '  runtime [--json] [--watch seconds]  passive MCP process/RAM attribution; never terminates a process',
  '  conformance [--json]                launch two real MCP clients against this build',
  '  bench [--quick] [--json] [--out F]  reproducible benchmark: concurrent-write safety, latency, soak, crash',
  '  init                                seed a starter ./brain.klypix + print an MCP config',
  '  garden-code [brain]                 print the human approval code for brain_garden',
  '  uninstall [--check|--yes|unlink]    remove this install from the machine (--check inventories first; never deletes a .klypix)',
  '  git-driver [install|status] [repo]  register the lossless .klypix merge driver for a repo (zero-command teams)',
  '  git-hook [install|remove|status]    wire the agent-neutral commit-capture hook (any agent/branch/worktree → brain cards)',
  '  diff [ref] [--brain <path>]         readable brain diff vs a git ref (default HEAD) — markdown to stdout',
  '  pr-brief [baseRef] [--brain <path>] brain decisions touching the files changed since baseRef — PR-comment markdown',
  '',
  'With no verb (or any --flag, e.g. --vault <dir>) it runs as an MCP stdio server.',
].join('\n');

const verb = process.argv[2];
if (verb === '--help' || verb === '-h' || verb === 'help') {
  console.log(USAGE);
  process.exit(0);
}
// A bare unknown WORD used to fall through to the stdio server, which then sat
// waiting on a stdin that no host was driving — so `npx klypix-mcp uninstall`
// (or any typo) printed nothing and exited 0, indistinguishable from success.
// Only non-dash tokens are rejected: a real host launch is `--vault <dir>`,
// and the local-bundle launch form puts '--vault' at argv[2] too.
if (verb && !verb.startsWith('-') && !DIRECT.has(verb)) {
  console.error(`klypix-mcp: unknown command "${verb}".\n\n${USAGE}`);
  process.exit(2);
}

if (verb === 'bench') {
  const { runBenchmark, formatBenchmark } = await import('../src/bench.mjs');
  const quick = process.argv.includes('--quick');
  const report = await runBenchmark({ quick });
  const outIdx = process.argv.indexOf('--out');
  const markdown = formatBenchmark(report);
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.argv[outIdx + 1], `${markdown}\n`);
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : markdown);
  const c = report.scenarios?.concurrentWriters;
  process.exit(c?.verdict === 'no-loss' ? 0 : 1);
} else if (verb === 'runtime') {
  process.argv.splice(2, 1);
  await import('./klypix-runtime.mjs');
} else if (DIRECT.has(verb)) {
  await import('./klypix-worker.mjs');
} else {
  const { runMcpSupervisor } = await import('../src/mcp-supervisor.mjs');
  await runMcpSupervisor({
    fallbackWorker: path.join(HERE, 'klypix-worker.mjs'),
    fallbackVersion: PKG_VERSION,
    workerArgs: process.argv.slice(2),
  });
}
