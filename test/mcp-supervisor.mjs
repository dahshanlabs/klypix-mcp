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
import { fileURLToPath, pathToFileURL } from 'url';
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

function workerSource(version, { extraTool = false, removeVersion = false, presence = null } = {}) {
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
const PRESENCE = ${JSON.stringify(presence)};
// A presence-owning fixture must behave like the REAL worker: it registers its
// lane row and REMOVES it on shutdown. Without the removal, a supervisor that
// fails to hold the row still looks correct — exactly how the first takeover
// implementation passed its test and lost the row against the real worker.
let PRES = null;
if (PRESENCE) {
  PRES = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'agent-presence.mjs')).href)});
  const id = process.env.KLYPIX_SESSION_ID || PRESENCE.id;
  PRES.upsertSession({ brainPath: PRESENCE.brain, id, client: 'stub-client', surface: 'stub', branch: 'main', channel: 'mcp' });
  const bye = () => {
    try { PRES.removeSession({ brainPath: PRESENCE.brain, id, channel: 'mcp' }); } catch {}
    process.exit(0);
  };
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  process.on('SIGTERM', bye);
}
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
  const result = { content: [{ type: 'text', text: value }] };
  // A worker that OWNS a presence row reports its identity here, exactly like
  // the real brain_sync does — this is what the supervisor needs to hold the
  // row while the worker sleeps.
  if (name === 'brain_sync' && PRESENCE) {
    result.structuredContent = {
      status: 'active',
      brain: PRESENCE.brain,
      self: { id: process.env.KLYPIX_SESSION_ID || PRESENCE.id, client: 'stub-client', surface: 'stub', branch: 'main' },
    };
  }
  send({ jsonrpc: '2.0', id: msg.id, result });
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
  // Windows: a live supervisor polls this manifest, so rename-over-destination
  // intermittently throws EPERM while a reader holds it open — the same race the
  // production writers now retry through. Without this the whole suite aborts
  // mid-run on an unrelated OS timing artifact (seen 2026-08-07).
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, manifestPath); return; }
    catch (err) {
      if (attempt >= 20) { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief spin — this helper is sync by contract */ }
    }
  }
}

const textOf = result => result?.content?.find(block => block.type === 'text')?.text;
const waitFor = async (fn, timeout = 15000) => {   // generous: crash→respawn→handshake under a loaded machine legitimately exceeds 6s
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
    KLYPIX_AUTO_UPDATE: '0',
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
  ok(typeof states[0]?.connectionId === 'string' && states[0].connectionId.length >= 16, 'supervisor assigns a stable connection id for passive attribution');
  ok(states[0]?.clientInfo?.name === 'klypix-supervisor-test', 'supervisor records bounded MCP client identity from initialize');
  ok(states[0]?.parentPid > 0 && states[0]?.cwd, 'supervisor receipt includes parent and working-directory attribution');
  lastActivePid = states[0]?.active?.pid || null;
} finally {
  await client.close().catch(() => {});
}

// ── RAM Phase 2: idle worker hibernation ─────────────────────────────────────
// A second, isolated connection with a 1s idle threshold: the worker half must
// retire while idle, the pair must survive, and the next call must wake it
// transparently (no error, no reconnect) with the task scope replayed.
{
  activate(v3, '1.2.0');   // same fixture runtime the main connection used
  const hibStateDir = path.join(root, 'state-hibernation');
  fs.mkdirSync(hibStateDir, { recursive: true });
  const hibClient = new Client({ name: 'klypix-hibernation-test', version: '1.0.0' }, { capabilities: {} });
  const hibTransport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    cwd: root,
    env: {
      ...process.env,
      KLYPIX_MCP_RUNTIME_MANIFEST: manifestPath,
      KLYPIX_MCP_STATE_DIR: hibStateDir,
      KLYPIX_MCP_SUPERVISOR_POLL_MS: '10000',
      KLYPIX_AUTO_UPDATE: '0',
      KLYPIX_WORKER_HIBERNATE_MS: '1000',
    },
    stderr: 'pipe',
  });
  const hibStates = () => fs.readdirSync(hibStateDir).filter(n => n.endsWith('.json'))
    .map(n => { try { return JSON.parse(fs.readFileSync(path.join(hibStateDir, n), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  try {
    await hibClient.connect(hibTransport);
    ok(textOf(await hibClient.callTool({ name: 'version', arguments: {} })) === '1.2.0', 'hibernation: worker serves normally before idling');
    await hibClient.callTool({
      name: 'brain_sync',
      arguments: { phase: 'start', intent: 'hibernation continuity', files: ['src/hib.ts'] },
    });
    const busyPid = hibStates()[0]?.active?.pid || null;
    await waitFor(async () => hibStates().some(s => s.status === 'hibernated'), 20000);
    const sleeping = hibStates().find(s => s.status === 'hibernated');
    ok(Boolean(sleeping) && sleeping.active === null, 'hibernation: an idle worker retires and the state file says so');
    ok(sleeping?.hibernation?.hibernated === true && sleeping.hibernation.count >= 1, 'hibernation: the receipt carries idle policy + count for diagnostics');
    if (busyPid) {
      await waitFor(async () => !isAlive(busyPid), 15000);
      ok(!isAlive(busyPid), 'hibernation: the worker PROCESS is actually gone (the RAM is returned)');
    }
    ok(textOf(await hibClient.callTool({ name: 'version', arguments: {} })) === '1.2.0', 'hibernation: the next call wakes the worker transparently — no error, no reconnect');
    const wokenScope = JSON.parse(textOf(await hibClient.callTool({ name: 'scope', arguments: {} })));
    ok(wokenScope?.intent === 'hibernation continuity' && wokenScope?.files?.[0] === 'src/hib.ts', 'hibernation: the declared task scope survives the wake (peers still see this session correctly)');
  } finally {
    await hibClient.close().catch(() => {});
  }

  // ── Presence takeover: a SCOPED connection hibernates without vanishing ────
  // The whole point of Phase 2 is RAM without spending coordination. A worker
  // that owns a lane row must be able to sleep while peers still see the
  // session — the supervisor holds the row, and the wake adopts the SAME id
  // instead of minting a ghost twin.
  {
    const presHome = path.join(root, 'home-presence');
    fs.mkdirSync(path.join(presHome, '.claude', 'project-brain'), { recursive: true });
    const presBrain = path.join(root, 'presence-project', 'brain.klypix');
    fs.mkdirSync(path.dirname(presBrain), { recursive: true });
    fs.writeFileSync(presBrain, 'stub');
    const presWorker = writeWorker('worker-presence.mjs', '1.4.0', { presence: { brain: presBrain.replace(/\\/g, '/'), id: 'scoped-session-1' } });
    activate(presWorker, '1.4.0');
    const presStateDir = path.join(root, 'state-presence');
    fs.mkdirSync(presStateDir, { recursive: true });
    const presClient = new Client({ name: 'klypix-presence-hibernation-test', version: '1.0.0' }, { capabilities: {} });
    const presTransport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      cwd: root,
      env: {
        ...process.env,
        HOME: presHome,
        USERPROFILE: presHome,
        KLYPIX_MCP_RUNTIME_MANIFEST: manifestPath,
        KLYPIX_MCP_STATE_DIR: presStateDir,
        KLYPIX_MCP_SUPERVISOR_POLL_MS: '10000',
        KLYPIX_AUTO_UPDATE: '0',
        KLYPIX_WORKER_HIBERNATE_MS: '1000',
      },
      stderr: 'pipe',
    });
    const {
      laneFileFor: laneOf,
      messageDeliveryState,
      postPresenceMessage: postLaneMessage,
    } = await import('../src/agent-presence.mjs');
    const lane = laneOf(presBrain, presHome);
    const rows = () => { try { return JSON.parse(fs.readFileSync(lane, 'utf8')).sessions || []; } catch { return []; } };
    const presStates = () => fs.readdirSync(presStateDir).filter(n => n.endsWith('.json'))
      .map(n => { try { return JSON.parse(fs.readFileSync(path.join(presStateDir, n), 'utf8')); } catch { return null; } })
      .filter(Boolean);
    try {
      await presClient.connect(presTransport);
      await presClient.callTool({ name: 'brain_sync', arguments: { phase: 'start', intent: 'scoped work', files: ['src/x.ts'] } });
      await waitFor(async () => presStates().some(s => s.status === 'hibernated'), 20000);
      ok(true, 'presence takeover: a SCOPED connection is allowed to hibernate');
      const sleeping = rows();
      ok(sleeping.length === 1 && sleeping[0].id === 'scoped-session-1',
        'presence takeover: the sleeping session STILL has exactly one live lane row (peers keep seeing it)');
      ok(sleeping[0]?.deliveryReachability === 'pull-only'
        && sleeping[0]?.transport?.mcp?.status === 'pull-only',
      'presence takeover: hibernation advertises honest pull-only delivery reachability');
      const sleepingState = presStates().find(s => s.status === 'hibernated');
      ok(sleepingState?.transport?.delivery === 'pull-only',
        'presence takeover: the supervisor diagnostic reports pull-only instead of connected delivery');
      ok(sleepingState?.hibernation?.target?.version === '1.4.0'
        && /worker-presence\.mjs$/.test(sleepingState?.hibernation?.target?.path || ''),
      'presence takeover: state retains the sleeping runtime identity for version-alignment diagnostics');
      const heldAt = sleeping[0].lastSeen;
      ok(Number.isFinite(heldAt) && Date.now() - heldAt < 90_000,
        'presence takeover: the supervisor keeps that row FRESH while the worker is gone');
      const queued = postLaneMessage({
        brainPath: presBrain,
        from: 'peer-during-sleep',
        to: 'scoped-session-1',
        text: 'queued while the MCP worker is hibernated',
        home: presHome,
      });
      // The supervisor schedules re-assertions at 500ms and 1200ms. Wait past
      // both so this proves its preview/heartbeat path is non-consuming.
      await new Promise(resolve => setTimeout(resolve, 1500));
      const sleepingMessage = JSON.parse(fs.readFileSync(lane, 'utf8')).messages
        ?.find(m => m.id === queued.message?.id);
      ok(messageDeliveryState(sleepingMessage, 'scoped-session-1') === 'pending',
        'presence takeover: best-effort hibernation notification does not consume or acknowledge the durable note');
      await presClient.callTool({ name: 'version', arguments: {} });
      await waitFor(async () => presStates().some(s => s.status === 'ready' && s.active?.pid), 15000);
      const awake = rows();
      ok(awake.length === 1 && awake[0].id === 'scoped-session-1',
        'presence takeover: the wake ADOPTS the same row — no ghost twin, no duplicate peer');
      ok(awake[0]?.deliveryReachability === 'connected' && awake[0]?.transport?.mcp?.status === 'connected',
        'presence takeover: wake restores connected delivery reachability on the same row');
      const keptScope = JSON.parse(textOf(await presClient.callTool({ name: 'scope', arguments: {} })));
      ok(keptScope?.intent === 'scoped work' && keptScope?.files?.[0] === 'src/x.ts',
        'presence takeover: the declared file scope survives — overlap warnings stay correct');
    } finally {
      await presClient.close().catch(() => {});
    }
    activate(v3, '1.2.0');
  }

  // Rollback gate: KLYPIX_WORKER_HIBERNATE_MS=0 must restore today's behavior
  // exactly — an idle worker stays resident. This is the instant-rollback path
  // the Phase-2 ship criteria require.
  const offStateDir = path.join(root, 'state-hibernation-off');
  fs.mkdirSync(offStateDir, { recursive: true });
  const offClient = new Client({ name: 'klypix-hibernation-off-test', version: '1.0.0' }, { capabilities: {} });
  const offTransport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    cwd: root,
    env: {
      ...process.env,
      KLYPIX_MCP_RUNTIME_MANIFEST: manifestPath,
      KLYPIX_MCP_STATE_DIR: offStateDir,
      KLYPIX_MCP_SUPERVISOR_POLL_MS: '10000',
      KLYPIX_AUTO_UPDATE: '0',
      KLYPIX_WORKER_HIBERNATE_MS: '0',
    },
    stderr: 'pipe',
  });
  try {
    await offClient.connect(offTransport);
    await offClient.callTool({ name: 'version', arguments: {} });
    const idleStart = Date.now();
    while (Date.now() - idleStart < 4000) await new Promise(r => setTimeout(r, 200));
    const offStates = fs.readdirSync(offStateDir).filter(n => n.endsWith('.json'))
      .map(n => { try { return JSON.parse(fs.readFileSync(path.join(offStateDir, n), 'utf8')); } catch { return null; } })
      .filter(Boolean);
    ok(offStates.length > 0 && offStates.every(s => s.status !== 'hibernated' && s.active?.pid),
      'hibernation OFF (=0): an idle worker stays resident — instant rollback to pre-Phase-2 behavior');
  } finally {
    await offClient.close().catch(() => {});
  }
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
