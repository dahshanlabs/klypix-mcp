#!/usr/bin/env node
// Self-contained KLYPIX MCP conformance test.
//
// Launches two real stdio clients against this exact installed server build,
// using a temporary brain + isolated presence registry. It verifies the
// Context Gateway, task memory, truthful task counts, exact overlap detection,
// proactive MCP logging, and guaranteed next-action delivery without touching
// the user's project or durable brain.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildKlypixMap } from '../src/klypix-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsonMode = process.argv.includes('--json');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PKG_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version; }
  catch {
    try {
      const stamp = JSON.parse(fs.readFileSync(path.join(here, '.brain-version.json'), 'utf8'));
      return stamp.brainVersion || stamp.appVersion || 'deployed';
    } catch { return 'deployed'; }
  }
})();
const serverPath = [
  path.join(here, 'klypix-mcp.mjs'),
  path.join(here, 'klypix-mcp-server.mjs'),
].find((candidate) => fs.existsSync(candidate));

if (!serverPath) {
  console.error('KLYPIX conformance failed: the MCP server executable is missing beside this command.');
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-conformance-'));
const vault = path.join(tempRoot, 'project');
const isolatedHome = path.join(tempRoot, 'home');
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(isolatedHome, { recursive: true });
fs.writeFileSync(path.join(vault, 'brain.klypix'), await buildKlypixMap({
  title: 'KLYPIX conformance brain',
  kind: 'brain',
  areas: [{
    title: 'Brain',
    cards: [{
      text: 'Codex Context Gateway automatically coordinates active tasks and exact file overlaps across MCP sessions.',
    }],
  }],
}));

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
);

async function connect(name, sessionId) {
  const logs = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--vault', vault],
    env: {
      ...baseEnv,
      USERPROFILE: isolatedHome,
      HOME: isolatedHome,
      KLYPIX_SESSION_ID: sessionId,
      KLYPIX_MCP_INBOX_POLL_MS: '250',
      KLYPIX_RERANK: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '1.0.0' });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(String(notification?.params?.data || ''));
  });
  await client.connect(transport);
  await client.setLoggingLevel('info');
  return { client, transport, logs };
}

const checks = {};
const metrics = {};
let a;
let b;
try {
  a = await connect('codex-klypix-conformance-a', 'klypix-conformance-a');
  b = await connect('codex-klypix-conformance-b', 'klypix-conformance-b');
  const tools = await a.client.listTools();
  checks.brainSyncDiscoverable = tools.tools?.some((tool) => tool.name === 'brain_sync') === true;

  const aStart = await a.client.callTool({
    name: 'brain_sync',
    arguments: {
      phase: 'start',
      intent: 'Validate automatic Codex Context Gateway coordination',
      files: ['src/conformance-overlap.ts'],
    },
  });
  const bStart = await b.client.callTool({
    name: 'brain_sync',
    arguments: {
      phase: 'start',
      intent: 'Validate proactive overlap delivery from a second session',
      files: ['src/conformance-overlap.ts'],
    },
  });
  const aStructured = aStart.structuredContent || {};
  const bStructured = bStart.structuredContent || {};
  checks.taskMemory = Array.isArray(aStructured.context?.hits) && aStructured.context.hits.length > 0;
  checks.truthfulTaskCount = bStructured.counts?.activeTasks === 2
    && bStructured.peers?.length === 1;
  checks.exactBlockingOverlap = bStructured.conflicts?.length === 1
    && bStructured.conflicts[0]?.kind === 'exact-file'
    && bStructured.conflicts[0]?.severity === 'blocking';
  checks.alertQueued = bStructured.alertsQueued?.length === 1;
  metrics.firstClientMs = aStructured.timingMs?.total ?? null;
  metrics.secondClientMs = bStructured.timingMs?.total ?? null;

  const pushDeadline = Date.now() + 4_000;
  while (Date.now() < pushDeadline
    && !a.logs.some((line) => line.includes('Automatic KLYPIX overlap alert'))) {
    await wait(100);
  }
  checks.proactiveLogging = a.logs.some((line) =>
    line.includes('Automatic KLYPIX overlap alert'));
  metrics.firstClientLogCount = a.logs.length;
  if (!checks.proactiveLogging && a.logs.length) metrics.firstClientLogs = a.logs.slice(-4);

  const aCheckpoint = await a.client.callTool({
    name: 'brain_sync',
    arguments: {
      phase: 'checkpoint',
      intent: 'Validate automatic Codex Context Gateway coordination',
      files: ['src/conformance-overlap.ts'],
    },
  });
  const checkpointStructured = aCheckpoint.structuredContent || {};
  checks.guaranteedInBandDelivery = checkpointStructured.messages?.some((message) =>
    String(message.text).includes('Automatic KLYPIX overlap alert')) === true;

  await Promise.all([
    a.client.callTool({ name: 'brain_sync', arguments: { phase: 'complete' } }),
    b.client.callTool({ name: 'brain_sync', arguments: { phase: 'complete' } }),
  ]);
} catch (error) {
  checks.runtime = false;
  checks.error = error?.message || String(error);
} finally {
  await Promise.allSettled([a?.client?.close(), b?.client?.close()]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const required = [
  'brainSyncDiscoverable',
  'taskMemory',
  'truthfulTaskCount',
  'exactBlockingOverlap',
  'alertQueued',
  'proactiveLogging',
  'guaranteedInBandDelivery',
];
const ok = required.every((name) => checks[name] === true);
const result = {
  ok,
  packageVersion: PKG_VERSION,
  checks,
  metrics,
  contract: {
    proactive: 'best-effort MCP logging notification',
    guaranteed: 'same alert on the next KLYPIX action',
  },
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(`KLYPIX MCP conformance v${PKG_VERSION}: ${ok ? 'PASS' : 'FAIL'}`);
  for (const name of required) {
    console.log(`  ${checks[name] ? '✓' : '✗'} ${name}`);
  }
  if (checks.error) console.log(`  error: ${checks.error}`);
  console.log(`  memory/coordination: ${metrics.firstClientMs ?? '?'}ms / ${metrics.secondClientMs ?? '?'}ms`);
  console.log('  proactive notifications are best-effort; next-action delivery is guaranteed.');
}
process.exit(ok ? 0 : 1);
