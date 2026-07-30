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

const DIRECT = new Set(['install', 'link', 'doctor', 'conformance', 'garden-code', 'init']);

const USAGE = [
  `klypix-mcp ${PKG_VERSION} — shared project brain + MCP coordination server.`,
  '',
  'Verbs:',
  '  install [--force] [--codex-hooks]   install/update this machine\'s brain engine + Claude Code hooks',
  '  link [dir] [--check]                project this project\'s 14 managed agent config files (--check audits, writes nothing, exits 1 on drift)',
  '  doctor [--npm] [--all] [--json]     read-only self-check; exits 1 on drift',
  '  conformance [--json]                launch two real MCP clients against this build',
  '  init                                seed a starter ./brain.klypix + print an MCP config',
  '  garden-code [brain]                 print the human approval code for brain_garden',
  '',
  'With no verb (or any --flag, e.g. --vault <dir>) it runs as an MCP stdio server.',
  'There is no uninstall command — removal is manual (see README).',
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

if (DIRECT.has(verb)) {
  await import('./klypix-worker.mjs');
} else {
  const { runMcpSupervisor } = await import('../src/mcp-supervisor.mjs');
  await runMcpSupervisor({
    fallbackWorker: path.join(HERE, 'klypix-worker.mjs'),
    fallbackVersion: PKG_VERSION,
    workerArgs: process.argv.slice(2),
  });
}
