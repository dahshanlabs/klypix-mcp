// End-to-end zero-restart supervisor proof:
//   same client connection survives v1→v2→v3,
//   in-flight work drains on the old worker,
//   brain_sync task scope follows the session,
//   added tools trigger standard list_changed,
//   a breaking candidate is rejected without downtime.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'klypix-mcp.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-supervisor-'));
const manifestPath = path.join(root, '.mcp-runtime.json');
const stateDir = path.join(root, 'states');
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`✓ ${message}`); }
  else { fail++; console.error(`✗ ${message}`); }
};
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

function workerSource(version, { extraTool = false, removeVersion = false } = {}) {
  const toolNames = [
    ...(removeVersion ? [] : ['version']),
    'slow',
    'crash',
    'brain_sync',
    'scope',
    ...(extraTool ? ['new_tool'] : []),
  ];
  return `#!/usr/bin/env node
import readline from 'readline';
const VERSION = ${JSON.stringify(version)};
const TOOLS = ${JSON.stringify(toolNames)}.map(name => ({
  name,
  description: name,
  inputSchema: name === 'brain_sync'
    ? { type: 'object', properties: { phase: { type: 'string' }, intent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, include_context: { type: 'boolean' } } }
    : { type: 'object', properties: {} },
}));
let scope = null;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'stub-klypix', version: VERSION },
      instructions: 'stub'
    }});
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method !== 'tools/call') return;
  const name = msg.params?.name;
  const args = msg.params?.arguments || {};
  if (name === 'crash') {
    process.exit(91);
    return;
  }
  if (name === 'slow') await new Promise(resolve => setTimeout(resolve, 350));
  if (name === 'brain_sync') {
    if (args.phase === 'complete') scope = null;
    else scope = { intent: args.intent || '', files: args.files || [] };
  }
  const value = name === 'scope' ? JSON.stringify(scope) : VERSION;
  send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: value }] } });
});
`;
}

function writeWorker(name, version, options) {
  const file = path.join(root, name);
  fs.writeFileSync(file, workerSource(version, options), 'utf8');
  return file;
}

function activate(worker, version) {
  const value = {
    protocol: 1,
    version,
    worker: path.basename(worker),
    channel: 'test',
    dev: true,
    installedAt: new Date().toISOString(),
    files: { [path.basename(worker)]: hash(worker) },
  };
  const tmp = `${manifestPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, manifestPath);
}

const textOf = result => result?.content?.find(block => block.type === 'text')?.text;
const waitFor = async (fn, timeout = 6000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* candidate may be between states */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`timed out; last=${last}`);
};

const v1 = writeWorker('worker-v1.mjs', '1.0.0');
const v2 = writeWorker('worker-v2.mjs', '1.1.0');
const v3 = writeWorker('worker-v3.mjs', '1.2.0', { extraTool: true });
const bad = writeWorker('worker-bad.mjs', '1.3.0', { extraTool: true, removeVersion: true });
activate(v1, '1.0.0');

let changed = 0;
let changedTools = [];
const client = new Client(
  { name: 'klypix-supervisor-test', version: '1.0.0' },
  {
    listChanged: {
      tools: {
        onChanged: (error, tools) => {
          if (!error) {
            changed++;
            changedTools = tools?.tools || tools || [];
          }
        },
      },
    },
  },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  cwd: root,
  env: {
    ...process.env,
    KLYPIX_MCP_RUNTIME_MANIFEST: manifestPath,
    KLYPIX_MCP_STATE_DIR: stateDir,
    KLYPIX_MCP_SUPERVISOR_POLL_MS: '50',
    KLYPIX_MCP_ROLLBACK_GRACE_MS: '500',
  },
  stderr: 'pipe',
});

let lastActivePid = null;
try {
  await client.connect(transport);
  ok(textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.0.0', 'initial worker serves v1');

  await client.callTool({
    name: 'brain_sync',
    arguments: { phase: 'start', intent: 'supervisor continuity test', files: ['src/a.ts'] },
  });
  activate(v2, '1.1.0');
  await waitFor(async () => textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.1.0');
  ok(true, 'same MCP client connection hot-swaps v1 → v2');
  const scope = JSON.parse(textOf(await client.callTool({ name: 'scope', arguments: {} })));
  ok(scope?.intent === 'supervisor continuity test' && scope?.files?.[0] === 'src/a.ts', 'brain_sync task scope is replayed into the new worker');

  const slow = client.callTool({ name: 'slow', arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 60));
  activate(v3, '1.2.0');
  ok(textOf(await slow) === '1.1.0', 'in-flight call drains on the old worker before activation');
  await waitFor(async () => textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.2.0');
  ok(true, 'next call uses v3 without reconnect');
  await waitFor(async () => changed > 0);
  ok(changedTools.some(tool => tool.name === 'new_tool'), 'tools/list_changed refreshes newly added tools');

  let crashRejected = false;
  try { await client.callTool({ name: 'crash', arguments: {} }); }
  catch { crashRejected = true; }
  ok(crashRejected, 'a crashing active worker fails only its in-flight call');
  await waitFor(async () => textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.1.0');
  ok(true, 'warm standby rolls the same connection back to the last good worker');
  await new Promise(resolve => setTimeout(resolve, 20));
  activate(v3, '1.2.0');
  await waitFor(async () => textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.2.0');
  ok(true, 'a newly committed runtime retries cleanly after rollback');

  activate(bad, '1.3.0');
  await new Promise(resolve => setTimeout(resolve, 500));
  ok(textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.2.0', 'breaking candidate is rejected while v3 stays available');
  const states = fs.readdirSync(stateDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')));
  ok(states.some(state => state.status === 'restart-required' && /removed tools/.test(state.lastError || '')), 'supervisor publishes an exact restart-required diagnostic');
  lastActivePid = states[0]?.active?.pid || null;
} finally {
  await client.close().catch(() => {});
}
if (lastActivePid) {
  await waitFor(async () => !isAlive(lastActivePid));
  ok(!isAlive(lastActivePid), 'closing the host connection terminates the supervised worker (no orphan session)');
}
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows child teardown can lag */ }

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n✓ mcp-supervisor: ${pass} assertions passed`);
