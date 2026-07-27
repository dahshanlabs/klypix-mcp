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
if (DIRECT.has(process.argv[2])) {
  await import('./klypix-worker.mjs');
} else {
  const { runMcpSupervisor } = await import('../src/mcp-supervisor.mjs');
  await runMcpSupervisor({
    fallbackWorker: path.join(HERE, 'klypix-worker.mjs'),
    fallbackVersion: PKG_VERSION,
    workerArgs: process.argv.slice(2),
  });
}
