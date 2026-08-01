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
// ARGV: flag lookup is position-independent, so this file is already correct for
// both `klypix-conformance --json` and `klypix-mcp conformance --json` (the
// dispatcher splices its verb out — see bin/klypix-worker.mjs runVerb). Kept as
// `includes` deliberately; test/cli-args.mjs asserts the two forms stay identical.
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
// The harness simulates two INDEPENDENT hosts. When it itself runs inside an
// agent session (Claude Code exports CLAUDE_PID + CLAUDE_CODE_SESSION_ID to
// children), both simulated clients would inherit the SAME host identity and
// be correctly treated as one session's twin halves — failing every two-client
// check. Strip host/session identity; each client gets its own KLYPIX_SESSION_ID.
for (const key of [
  'CLAUDE_PID', 'KLYPIX_HOST_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID',
  'CODEX_THREAD_ID', 'CURSOR_SESSION_ID', 'CLINE_SESSION_ID', 'WINDSURF_SESSION_ID',
]) delete baseEnv[key];

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
      KLYPIX_AUTO_UPDATE: '0',
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

  // ── Cross-PC presence: simulated two-machine scenario ─────────────────────
  // Two isolated registries (one per "machine") + a mock channel around the
  // pure transport seam (src/presence-relay.mjs relayOutbound/relayInbound —
  // the exact functions the desktop relay wraps its Realtime channel with).
  // Proves: peer visibility across machines, overlap warning on the canonical
  // file key, message delivered once under double-delivery, clean degradation
  // with the channel dead, and the consent gate at the seam.
  {
    const [{ relayOutbound, relayInbound, PRESENCE_CONSENT_VERSION, PRESENCE_CONSENT_PURPOSE, PRESENCE_CONSENT_SCOPE },
      { upsertSession, upsertRemoteSessions, listActiveSessions, postPresenceMessage, receiveMessages },
      { findPresenceConflicts }] = await Promise.all([
      import('../src/presence-relay.mjs'),
      import('../src/agent-presence.mjs'),
      import('../src/mcp-presence.mjs'),
    ]);
    const GRANT = {
      version: PRESENCE_CONSENT_VERSION, decision: 'granted', decidedAt: new Date().toISOString(),
      purpose: PRESENCE_CONSENT_PURPOSE, scope: PRESENCE_CONSENT_SCOPE,
    };
    const xpcRoot = path.join(tempRoot, 'xpc');
    const homeA = path.join(xpcRoot, 'homeA');
    const homeB = path.join(xpcRoot, 'homeB');
    const repoA = path.join(xpcRoot, 'machineA', 'repo');
    const repoB = path.join(xpcRoot, 'machineB', 'repo');
    for (const dir of [homeA, homeB, repoA, repoB]) fs.mkdirSync(dir, { recursive: true });
    const brainA = path.join(repoA, 'brain.klypix');
    const brainB = path.join(repoB, 'brain.klypix');
    fs.writeFileSync(brainA, 'xpc-fixture');
    fs.writeFileSync(brainB, 'xpc-fixture');
    const now = Date.now();

    upsertSession({
      brainPath: brainA, home: homeA, now, id: 'xpc-dev-a', client: 'claude-code', branch: 'main',
      intent: 'edit the shared component', files: [path.join(repoA, 'src', 'Shared.tsx')],
    });
    upsertSession({
      brainPath: brainB, home: homeB, now, id: 'xpc-dev-b', client: 'codex', branch: 'main',
      intent: 'restyle the shared component', files: ['src/Shared.tsx'],
    });

    // Consent gate FIRST: with no record, the seam must emit nothing.
    let framesSent = 0;
    const gated = relayOutbound({
      sessions: listActiveSessions({ brainPath: brainA, home: homeA, now }),
      consent: null, machineId: 'xpc-mach-a', root: repoA, now, send: () => { framesSent++; },
    });
    checks.crossMachineConsentGate = framesSent === 0 && gated.reason === 'no-consent';

    // Live channel: A's session and message reach B exactly once.
    const wire = [];
    relayOutbound({
      sessions: listActiveSessions({ brainPath: brainA, home: homeA, now }),
      messages: (() => {
        postPresenceMessage({ brainPath: brainA, from: 'xpc-dev-a', text: 'starting on Shared.tsx now', home: homeA, now });
        try { return JSON.parse(fs.readFileSync(path.join(homeA, '.claude', 'project-brain', 'sessions', fs.readdirSync(path.join(homeA, '.claude', 'project-brain', 'sessions')).find((f) => f.endsWith('.json'))), 'utf8')).messages || []; }
        catch { return []; }
      })(),
      consent: GRANT, machineId: 'xpc-mach-a', hostLabel: 'MACHINE-A', root: repoA, now,
      send: (frame) => wire.push(frame),
    });
    const deliverAll = (stampNow) => {
      const rows = [];
      for (const frame of wire) {   // double-delivery: every frame arrives twice (at-least-once transport)
        for (let i = 0; i < 2; i++) {
          const inbound = relayInbound(frame, { consent: GRANT, machineId: 'xpc-mach-b', now: stampNow });
          if (inbound?.type === 'presence') rows.push(inbound.row);
          if (inbound?.type === 'message') {
            postPresenceMessage({
              brainPath: brainB, from: inbound.message.from, to: inbound.message.to,
              text: inbound.message.text, dedupeKey: inbound.message.dedupeKey, home: homeB, now: stampNow,
            });
          }
        }
      }
      if (rows.length) upsertRemoteSessions({ brainPath: brainB, rows, machineId: 'xpc-mach-b', home: homeB, now: stampNow });
    };
    deliverAll(now + 500);

    const bSessions = listActiveSessions({ brainPath: brainB, home: homeB, now: now + 500 });
    const remote = bSessions.find((session) => session.id === 'xpc-dev-a');
    checks.crossMachinePeerVisibility = !!remote && remote.via === 'cloud' && remote.host === 'MACHINE-A';
    const overlaps = findPresenceConflicts(bSessions, 'xpc-dev-b', { projectRoot: repoB });
    checks.crossMachineOverlapWarning = overlaps.length === 1
      && overlaps[0].id === 'xpc-dev-a'
      && overlaps[0].files.some((file) => file.toLowerCase().includes('src/shared.tsx'));
    const delivered = receiveMessages({ brainPath: brainB, sessionId: 'xpc-dev-b', home: homeB, now: now + 600 });
    checks.crossMachineMessageOnce = delivered.filter((message) => message.text.includes('Shared.tsx')).length === 1;

    // Dead channel: outbound reports without throwing; local presence intact.
    const dead = relayOutbound({
      sessions: listActiveSessions({ brainPath: brainA, home: homeA, now: now + 700 }),
      consent: GRANT, machineId: 'xpc-mach-a', root: repoA, now: now + 700, send: undefined,
    });
    checks.crossMachineOfflineDegradation = dead.sent === 0 && dead.reason === 'no-channel'
      && listActiveSessions({ brainPath: brainA, home: homeA, now: now + 700 }).some((session) => session.id === 'xpc-dev-a');
  }
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
  'crossMachineConsentGate',
  'crossMachinePeerVisibility',
  'crossMachineOverlapWarning',
  'crossMachineMessageOnce',
  'crossMachineOfflineDegradation',
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
