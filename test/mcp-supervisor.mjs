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
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { laneFileFor, listActiveSessions } from '../src/agent-presence.mjs';
import { AUTO_UPDATE_POLL_MS } from '../src/mcp-auto-update.mjs';
import { __test as supervisorTest } from '../src/mcp-supervisor.mjs';

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

function workerSource(version, { extraTool = false, removeVersion = false, presence = null, identity = false, bootAudit = null } = {}) {
  const toolNames = [
    ...(removeVersion ? [] : ['version']),
    'slow',
    'crash',
    'brain_sync',
    'scope',
    ...(extraTool ? ['new_tool'] : []),
  ];
  return `#!/usr/bin/env node
import fs from 'fs';
import readline from 'readline';
// Baked like the flat bundle's worker, so readBakedVersion (.prev) can read it.
const PKG_VERSION = ${JSON.stringify(version)};
const VERSION = PKG_VERSION;
const PRESENCE = ${JSON.stringify(presence)};
// identity: answers the supervisor's identity-only hibernation probe, like a
// worker from 2026-10-03 on. Without it the fixture is an OLDER worker: like
// every SDK server it answers unknown requests with "Method not found".
const IDENTITY = ${JSON.stringify(identity)};
const BOOT_AUDIT = ${JSON.stringify(bootAudit)};
if (BOOT_AUDIT) fs.appendFileSync(BOOT_AUDIT, JSON.stringify({ pid: process.pid, version: VERSION, file: process.argv[1] }) + '\\n');
// A presence-owning fixture must behave like the REAL worker: it registers its
// lane row and REMOVES it on shutdown. Without the removal, a supervisor that
// fails to hold the row still looks correct — exactly how the first takeover
// implementation passed its test and lost the row against the real worker.
let PRES = null;
if (PRESENCE) {
  PRES = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'agent-presence.mjs')).href)});
  const id = process.env.KLYPIX_SESSION_ID || PRESENCE.id;
  PRES.upsertSession({ brainPath: PRESENCE.brain, id, client: 'stub-client', surface: 'stub', branch: 'main', channel: 'mcp' });
  let closing = false;
  const bye = () => {
    if (closing) return;
    closing = true;
    try { PRES.removeSession({ brainPath: PRESENCE.brain, id, channel: 'mcp', expectedPid: process.pid }); } catch {}
    try { if (PRESENCE.scopeFile) fs.unlinkSync(PRESENCE.scopeFile); } catch {}
    process.exit(0);
  };
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
}
const TOOLS = ${JSON.stringify(toolNames)}.map(name => ({
  name,
  description: name,
  inputSchema: name === 'brain_sync'
    ? { type: 'object', properties: { phase: { type: 'string' }, intent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, include_context: { type: 'boolean' }, results: {} } }
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
  if (msg.method === 'klypix/presenceIdentity' && IDENTITY) {
    send({ jsonrpc: '2.0', id: msg.id, result: PRESENCE
      ? { schemaVersion: 1, brain: PRESENCE.brain, self: { id: process.env.KLYPIX_SESSION_ID || PRESENCE.id, client: 'stub-client', surface: 'stub', branch: 'main' } }
      : { schemaVersion: 1, reason: 'no-project-brain', brain: null, self: null } });
    return;
  }
  if (msg.method !== 'tools/call') {
    if (msg.method && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  const name = msg.params?.name;
  const args = msg.params?.arguments || {};
  if (name === 'crash') {
    process.exit(91);
    return;
  }
  if (name === 'slow') await new Promise(resolve => setTimeout(resolve, 350));
  let blockedCompletion = false;
  if (name === 'brain_sync') {
    blockedCompletion = args.phase === 'complete'
      && Array.isArray(args.results)
      && args.results.some(result => result?.forceConflict === true);
    try {
      if (PRESENCE?.auditFile) fs.appendFileSync(PRESENCE.auditFile, JSON.stringify({
        pid: process.pid,
        version: VERSION,
        phase: args.phase || 'checkpoint',
        internal: String(msg.id || '').startsWith('__klypix_supervisor__'),
        blocked: blockedCompletion,
      }) + '\\n');
    } catch {}
    if (!blockedCompletion) {
      if (args.phase === 'complete') scope = null;
      else scope = { intent: args.intent || '', files: args.files || [] };
    }
    if (PRESENCE && scope) {
      PRES.upsertSession({
        brainPath: PRESENCE.brain,
        id: process.env.KLYPIX_SESSION_ID || PRESENCE.id,
        client: 'stub-client',
        surface: 'stub',
        branch: 'main',
        channel: 'mcp',
        event: 'McpTaskCheckpoint',
        intent: scope.intent,
        files: scope.files,
        replaceFiles: true,
      });
      try { if (PRESENCE.scopeFile) fs.writeFileSync(PRESENCE.scopeFile, JSON.stringify({ pid: process.pid, version: VERSION, ...scope })); } catch {}
    }
  }
  const value = name === 'scope' ? JSON.stringify(scope) : VERSION;
  const result = { content: [{ type: 'text', text: value }] };
  // A worker that OWNS a presence row reports its identity here, exactly like
  // the real brain_sync does — this is what the supervisor needs to hold the
  // row while the worker sleeps.
  if (name === 'brain_sync' && PRESENCE) {
    result.structuredContent = {
      status: blockedCompletion ? 'needs-reconciliation' : (args.phase === 'complete' ? 'complete' : 'active'),
      phase: args.phase || 'checkpoint',
      brain: PRESENCE.brain,
      self: { id: process.env.KLYPIX_SESSION_ID || PRESENCE.id, client: 'stub-client', surface: 'stub', branch: 'main' },
    };
  }
  if (blockedCompletion) result.isError = true;
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

const handoffHome = path.join(root, 'home-handoff');
const handoffBrain = path.join(root, 'handoff-project', 'brain.klypix');
const handoffAudit = path.join(root, 'handoff-audit.jsonl');
const handoffScope = path.join(root, 'handoff-scope.json');
fs.mkdirSync(path.dirname(handoffBrain), { recursive: true });
fs.mkdirSync(handoffHome, { recursive: true });
fs.writeFileSync(handoffBrain, 'supervisor handoff fixture');
const handoffPresence = {
  brain: handoffBrain.replace(/\\/g, '/'),
  id: 'supervisor-handoff-session',
  auditFile: handoffAudit.replace(/\\/g, '/'),
  scopeFile: handoffScope.replace(/\\/g, '/'),
};
const v1 = writeWorker('worker-v1.mjs', '1.0.0', { presence: handoffPresence });
const v2 = writeWorker('worker-v2.mjs', '1.1.0', { presence: handoffPresence });
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
    KLYPIX_SESSION_ID: handoffPresence.id,
    HOME: handoffHome,
    USERPROFILE: handoffHome,
  },
  stderr: 'pipe',
});

let lastActivePid = null;
try {
  await client.connect(transport);
  ok(textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.0.0', 'initial worker serves v1');
  const currentState = () => fs.readdirSync(stateDir)
    .filter(name => name.endsWith('.json'))
    .map(name => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); } catch { return null; } })
    .find(Boolean);
  const v1Pid = await waitFor(async () => currentState()?.active?.version === '1.0.0'
    ? currentState()?.active?.pid : null);

  await client.callTool({
    name: 'brain_sync',
    arguments: { phase: 'start', intent: 'supervisor continuity test', files: ['src/a.ts'] },
  });
  const blockedCompletion = await client.callTool({
    name: 'brain_sync',
    arguments: { phase: 'complete', results: [{ forceConflict: true }] },
  });
  ok(blockedCompletion.isError === true
    && blockedCompletion.structuredContent?.status === 'needs-reconciliation',
  'a blocked completion is returned as an error without ending the active task');
  activate(v2, '1.1.0');
  await waitFor(async () => textOf(await client.callTool({ name: 'version', arguments: {} })) === '1.1.0');
  ok(true, 'same MCP client connection hot-swaps v1 → v2');
  const v2Pid = await waitFor(async () => currentState()?.active?.version === '1.1.0'
    ? currentState()?.active?.pid : null);
  const scope = JSON.parse(textOf(await client.callTool({ name: 'scope', arguments: {} })));
  ok(scope?.intent === 'supervisor continuity test' && scope?.files?.[0] === 'src/a.ts',
    'a blocked completion keeps task scope for replay into the new worker');
  await waitFor(async () => !isAlive(v1Pid));
  const auditEvents = fs.existsSync(handoffAudit)
    ? fs.readFileSync(handoffAudit, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : [];
  ok(!auditEvents.some(event => event.pid === v1Pid && event.internal && event.phase === 'complete'),
    'handoff never synthesizes phase complete through the superseded worker');
  const handoffRow = listActiveSessions({ brainPath: handoffBrain, home: handoffHome })
    .find(row => row.id === handoffPresence.id);
  const handoffSentinel = fs.existsSync(handoffScope)
    ? JSON.parse(fs.readFileSync(handoffScope, 'utf8')) : null;
  ok(handoffRow?.pid === v2Pid
    && handoffRow?.intent === 'supervisor continuity test'
    && handoffRow?.files?.includes('src/a.ts')
    && handoffSentinel?.pid === v2Pid
    && handoffSentinel?.intent === 'supervisor continuity test',
  'after the old worker exits, the candidate-owned shared presence row and scope still exist');

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

// ── 2026-10-03: a hibernated pair stays asleep; its wake is gated (SPEC B1-B10) ─
// Production shape on purpose: npm-channel (non-dev) manifests at the default
// 1000 ms poll. The fixtures above are dev:true and poll every 10 s, which is
// how the wake loop hid from 1.57.0 on: nothing polled while a pair slept, and a
// dev target skips the never-downgrade guard anyway. Each runtime directory is
// shaped like ~/.claude/project-brain: one worker file name, a .prev snapshot
// taken before every install, the manifest committed last. Fixture versions sit
// far above this package's own (90.x): selectInitialTarget never boots an npm
// runtime older than the package's bundled worker.
{
  const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  const SPEC_RECONNECT_ERROR = 'KLYPIX core changed incompatibly while idle — /mcp reconnect';
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const writeAtomic = (file, text) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {   // same EPERM retry as activate()
      try { fs.renameSync(tmp, file); return; }
      catch (err) {
        if (attempt >= 20) { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
        const until = Date.now() + 25;
        while (Date.now() < until) { /* sync by contract */ }
      }
    }
  };
  const runtimeDir = (name) => {
    const dir = path.join(root, 'b', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const manifestOf = (dir) => path.join(dir, '.mcp-runtime.json');
  const commitManifest = (dir, version) => writeAtomic(manifestOf(dir), `${JSON.stringify({
    protocol: 1,
    version,
    worker: 'worker.mjs',
    channel: 'npm',
    installedAt: new Date().toISOString(),
    files: { 'worker.mjs': hash(path.join(dir, 'worker.mjs')) },
  }, null, 2)}\n`);
  // bin/klypix-install.mjs in miniature: snapshot the live file to .prev, rename
  // the new one in, commit the manifest last (commit:false = it stopped there).
  const install = (dir, version, { commit = true, ...options } = {}) => {
    const worker = path.join(dir, 'worker.mjs');
    if (fs.existsSync(worker)) {
      fs.mkdirSync(path.join(dir, '.prev'), { recursive: true });
      fs.copyFileSync(worker, path.join(dir, '.prev', 'worker.mjs'));
    }
    writeAtomic(worker, workerSource(version, options));
    if (commit) commitManifest(dir, version);
  };
  const boots = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : []);
  const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
  const fromPrev = (entry) => /[\\/]\.prev[\\/]worker\.mjs$/.test(String(entry?.file || ''));
  const deadPid = await (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await new Promise(resolve => child.once('exit', resolve));
      if (supervisorTest.pidState(child.pid) === 'dead') return child.pid;
    }
    throw new Error('could not obtain a dead pid');
  })();

  async function openPair(dir, name, { env = {}, args = [], entry = BIN } = {}) {
    const stateDir = path.join(dir, 'states');
    fs.mkdirSync(stateDir, { recursive: true });
    let listChanged = 0;
    let tools = [];
    const client = new Client({ name, version: '1.0.0' }, {
      listChanged: {
        tools: {
          onChanged: (error, next) => {
            if (error) return;
            listChanged++;
            tools = next?.tools || next || [];
          },
        },
      },
    });
    const childEnv = {
      ...process.env,
      KLYPIX_MCP_RUNTIME_MANIFEST: manifestOf(dir),
      KLYPIX_MCP_STATE_DIR: stateDir,
      KLYPIX_AUTO_UPDATE: '0',
      KLYPIX_WORKER_HIBERNATE_MS: '1000',
      KLYPIX_MCP_ROLLBACK_GRACE_MS: '500',
      ...env,
    };
    delete childEnv.KLYPIX_MCP_SUPERVISOR_POLL_MS;   // the production 1000 ms poll
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, ...args],
      cwd: dir,
      env: childEnv,
      stderr: 'pipe',
    });
    const logs = [];
    transport.stderr?.on('data', (chunk) => { logs.push(String(chunk)); if (logs.length > 400) logs.shift(); });
    await client.connect(transport);
    const state = () => fs.readdirSync(stateDir)
      .filter(entry => /^\d+\.json$/.test(entry))
      .map(entry => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, entry), 'utf8')); } catch { return null; } })
      .find(Boolean) || null;
    return {
      stateDir,
      state,
      call: async (tool = 'version') => textOf(await client.callTool({ name: tool, arguments: {} })),
      callError: async (tool = 'version') => {
        try { await client.callTool({ name: tool, arguments: {} }); return null; }
        catch (error) { return error; }
      },
      listChanged: () => listChanged,
      tools: () => tools,
      logs: () => logs.join(''),
      close: () => client.close().catch(() => {}),
    };
  }
  // A failing scenario prints its supervisor's log tail instead of a bare ✗
  // (KLYPIX_SUPERVISOR_TEST_LOGS=1 prints every scenario's log).
  const scenario = async (name, run) => {
    let pair = null;
    const dump = () => pair && console.error(`--- ${name} supervisor log ---\n${pair.logs().split(/\r?\n/).slice(-40).join('\n')}`);
    try {
      await run((opened) => { pair = opened; return opened; });
      if (process.env.KLYPIX_SUPERVISOR_TEST_LOGS === '1') dump();
    } catch (error) {
      ok(false, `${name}: ${error?.message || error}`);
      dump();
    } finally {
      await pair?.close();
    }
  };

  // B1 + B3 + B5 + B9 (+ B7 boot wiring).
  const asleepThenWakeIntoNewer = () => scenario('asleep', async (track) => {
    const dir = runtimeDir('asleep');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    // What the founder's .supervisors held on 2026-10-02: a receipt whose pid
    // was reused by another program (live pid, dead host, stale) and a tmp file
    // whose writer is gone. The next supervisor to start removes both.
    const stateDir = path.join(dir, 'states');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '424242.json'), JSON.stringify({
      pid: process.pid, parentPid: deadPid, updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    fs.writeFileSync(path.join(stateDir, `424242.json.${deadPid}.tmp`), '{}');
    const pair = track(await openPair(dir, 'b1-asleep'));
    ok(!fs.existsSync(path.join(stateDir, '424242.json')) && !fs.existsSync(path.join(stateDir, `424242.json.${deadPid}.tmp`)),
      'B7: a starting supervisor removes a reused-pid receipt whose host is gone, and a dead writer\'s tmp file');
    ok(await pair.call() === '90.0.0', 'B1: an npm-channel pair serves v90.0.0 at the production 1000 ms poll');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const count = pair.state().hibernation?.count;
    const bootCount = boots(audit).length;
    await sleep(5000);
    const later = pair.state();
    ok(later?.status === 'hibernated' && later.active === null && later.hibernation?.count === count && boots(audit).length === bootCount,
      'B1: a hibernated pair stays asleep across five 1 s polls — no wake, no worker spawned');
    install(dir, '90.1.0', { identity: true, bootAudit: audit, extraTool: true });
    await waitFor(async () => pair.state()?.hibernation?.pendingWakeTarget?.version === '90.1.0', 10000);
    await sleep(2500);
    const noted = pair.state();
    ok(noted?.status === 'hibernated' && noted.hibernation?.count === count && boots(audit).length === bootCount,
      'B1: a newer install that lands while hibernated is noted, and the pair stays asleep');
    ok(noted?.hibernation?.target?.version === '90.0.0' && noted.hibernation.pendingWakeTarget?.validated === false,
      'B1: the receipt keeps the version the pair last ran; the newer install is pending, not yet validated');
    ok(await pair.call() === '90.1.0', 'B3: the next request wakes the pair into the newer install through the gates');
    const awake = pair.state();
    ok(awake?.status === 'ready' && awake.hotReloads === 1 && awake.hibernation?.pendingWakeTarget === null,
      'B5: a wake into a new version counts as a hot reload');
    const notified = await waitFor(async () => pair.listChanged() > 0, 10000).then(() => true, () => false);
    ok(notified && pair.tools().some(tool => tool.name === 'new_tool'),
      'B5: the host receives tools/list_changed and sees the woken worker\'s new tool');
    ok(awake?.supervisorVersion === PKG_VERSION, 'B9: the receipt names the version of the supervisor code itself');
  });

  // B2 + B4: a breaking core with no .prev to resume.
  const breakingWakeWithoutPrev = () => scenario('breaking', async (track) => {
    const dir = runtimeDir('breaking');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'b4-breaking'));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '90.1.0', { identity: true, bootAudit: audit, removeVersion: true });
    fs.rmSync(path.join(dir, '.prev'), { recursive: true, force: true });
    const error = await pair.callError();
    ok(String(error?.message || '').includes(SPEC_RECONNECT_ERROR),
      'B4: a wake whose new core removes a tool answers the queued request with the retryable reconnect error');
    const settled = pair.state();
    ok(settled?.status === 'restart-required' && settled.active === null && /removed tools: version/.test(settled.lastError || ''),
      'B2/B4: the woken candidate is gated against the last committed worker; the pair settles restart-required with the reason');
    const bootCount = boots(audit).length;
    ok(boots(audit).filter(entry => entry.version === '90.1.0').length === 1, 'B4: the breaking core was started exactly once');
    await sleep(4000);   // the old recovery backoff retried at 1 s and 2 s
    ok(boots(audit).length === bootCount && pair.state()?.status === 'restart-required',
      'B4: no respawn loop — nothing is retried while the pair waits for a reconnect');
    const started = Date.now();
    const again = await pair.callError();
    ok(String(again?.message || '').includes(SPEC_RECONNECT_ERROR) && Date.now() - started < 3000 && boots(audit).length === bootCount,
      'B4: later requests are answered at once, without starting a worker');
  });

  // B2 + B4: a new MAJOR, with .prev holding the version the pair ran.
  const majorWakeResumesPrev = () => scenario('major', async (track) => {
    const dir = runtimeDir('major');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'b4-major'));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '91.0.0', { identity: true, bootAudit: audit });   // .prev now holds v90.0.0
    ok(await pair.call() === '90.0.0', 'B4: a wake into a new major resumes the version the pair last ran, from .prev');
    const resumed = pair.state();
    ok(resumed?.status === 'restart-required' && /major upgrade v90\.0\.0 .+ v91\.0\.0 requires reconnect/.test(resumed.lastError || '')
      && /\/\.prev\/worker\.mjs$/.test(resumed.active?.path || ''),
    'B4: it serves from .prev and still reports restart-required with the exact reason');
    const bootCount = boots(audit).length;
    await sleep(3000);
    ok(boots(audit).length === bootCount && boots(audit).filter(entry => entry.version === '91.0.0').length === 1,
      'B4: the new major was tried once and never respawned');
  });

  // B8 swap at 1 s + B1/B3: a --force rollback while asleep.
  const swapThenRollbackWhileAsleep = () => scenario('rollback', async (track) => {
    const dir = runtimeDir('rollback');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'b3-rollback'));
    await pair.call();
    install(dir, '90.1.0', { identity: true, bootAudit: audit });
    await waitFor(async () => (await pair.call()) === '90.1.0', 15000);
    ok(pair.state()?.hotReloads === 1, 'B8: the stat-gated 1 s poll still hot-swaps a live pair when an install commits');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const count = pair.state().hibernation.count;
    const bootCount = boots(audit).length;
    install(dir, '90.0.0', { identity: true, bootAudit: audit });   // --force rollback: .prev now holds v90.1.0
    await sleep(2500);
    const asleep = pair.state();
    ok(asleep?.status === 'hibernated' && asleep.hibernation.count === count
      && asleep.hibernation.pendingWakeTarget === null && boots(audit).length === bootCount,
    'B1: a rollback installed while hibernated is not a wake target and does not wake the pair');
    ok(await pair.call() === '90.1.0', 'B3: the wake does not adopt the rollback — it resumes v90.1.0, the version the pair last ran');
    const woke = boots(audit).slice(bootCount);
    ok(woke.length === 1 && woke[0].version === '90.1.0' && fromPrev(woke[0]),
      'B3: that wake booted only .prev — the rolled-back v90.0.0 never started');
  });

  // B3: an install that stopped half-way.
  const integrityFailureNeverBootsSleepingPath = () => scenario('integrity', async (track) => {
    const dir = runtimeDir('integrity');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'b3-integrity'));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const sleepingPath = pair.state().hibernation.target.path;
    const bootCount = boots(audit).length;
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    const started = Date.now();
    ok(await pair.call() === '90.0.0', 'B3: a wake into a runtime that fails integrity resumes the version it ran, from .prev');
    const waited = Date.now() - started;
    ok(waited >= 4000, `B3: the wake first waited for a possible install to settle (${waited} ms)`);
    const woke = boots(audit).slice(bootCount);
    ok(woke.length >= 1 && woke.every(entry => !samePath(entry.file, sleepingPath)) && woke.some(fromPrev),
      'B3: integrity failure during a wake never boots the sleeping target\'s path (a mixed module graph)');
  });

  // B3: the install finishes while the wake waits.
  const integrityWaitAdoptsFinishedInstall = () => scenario('settles', async (track) => {
    const dir = runtimeDir('settles');
    install(dir, '90.0.0', { identity: true });
    const pair = track(await openPair(dir, 'b3-settles'));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '90.1.0', { identity: true, commit: false });
    const wake = pair.call();
    await sleep(1200);
    commitManifest(dir, '90.1.0');
    ok(await wake === '90.1.0', 'B3: a wake that meets an install mid-rename waits for it and wakes into the finished install');
  });

  // B3, flat-bundle shape: the supervisor's own fallback worker IS the managed
  // worker (klypix-mcp-server.mjs passes <brainDir>/klypix-mcp-worker.mjs), so
  // "fall back to the package worker" would boot the failing runtime itself.
  const flatBundleDefersWake = () => scenario('flat-defer', async (track) => {
    const dir = runtimeDir('flat-defer');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const entry = path.join(dir, 'server.mjs');
    fs.writeFileSync(entry, [
      `import { runMcpSupervisor } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'mcp-supervisor.mjs')).href)};`,
      `await runMcpSupervisor({ fallbackWorker: ${JSON.stringify(path.join(dir, 'worker.mjs'))}, fallbackVersion: '90.0.0', workerArgs: [] });`,
      '',
    ].join('\n'));
    const pair = track(await openPair(dir, 'b3-flat', { entry }));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    fs.rmSync(path.join(dir, '.prev'), { recursive: true, force: true });   // nothing to resume
    const bootCount = boots(audit).length;
    const error = await pair.callError();
    ok(/KLYPIX core files do not verify .*retry shortly/.test(String(error?.message || '')) && boots(audit).length === bootCount,
      'B3: flat bundle, no .prev — a wake into a runtime failing integrity boots nothing and answers with a retryable error');
    const deferred = pair.state();
    ok(deferred?.status === 'hibernated' && /integrity mismatch: worker\.mjs/.test(deferred.lastError || ''),
      'B3: the pair stays hibernated (presence held) and reports the integrity error');
    commitManifest(dir, '90.1.0');   // the interrupted install is re-run to completion
    ok(await pair.call() === '90.1.0' && pair.state()?.lastError === null,
      'B3: the next request wakes into the completed install, with no reconnect');
  });

  // B6: the REAL worker (no installed runtime → this checkout's worker).
  const realWorkerProbeStampsNoActivity = () => scenario('identity-probe', async (track) => {
    const dir = runtimeDir('identity-probe');
    const project = path.join(dir, 'project');
    const home = path.join(dir, 'home');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(project, 'brain.klypix'), 'identity probe fixture');
    const sessionId = 'b6-identity-probe';
    const pair = track(await openPair(dir, 'b6-probe', {
      args: ['--vault', project],
      env: { HOME: home, USERPROFILE: home, KLYPIX_SESSION_ID: sessionId },
    }));
    const lane = laneFileFor(path.join(project, 'brain.klypix'), home);
    const row = () => {
      try { return JSON.parse(fs.readFileSync(lane, 'utf8')).sessions?.find(session => session.id === sessionId) || null; }
      catch { return null; }
    };
    await waitFor(async () => row(), 30000);
    await waitFor(async () => pair.state()?.status === 'hibernated', 30000);
    await waitFor(async () => row()?.event === 'McpHibernated', 10000);
    const held = row();
    ok(held && !held.activityAt && !held.activityKind,
      'B6: hibernating an idle connection stamps no activity on its lane row (identity-only probe, not a brain_sync checkpoint)');
    ok(held?.transport?.mcp?.status === 'pull-only',
      'B6: the supervisor still identified and holds that row while the worker sleeps');
  });

  // B8: an integrity failure is written once, and cleared once it verifies.
  const integrityErrorWrittenOnce = () => scenario('integrity-writes', async (track) => {
    const dir = runtimeDir('integrity-writes');
    install(dir, '90.0.0', { identity: true });
    const pair = track(await openPair(dir, 'b8-writes', { env: { KLYPIX_WORKER_HIBERNATE_MS: '0' } }));
    await pair.call();
    const committed = fs.readFileSync(manifestOf(dir), 'utf8');
    writeAtomic(manifestOf(dir), committed.replace(/("worker\.mjs": ")[0-9a-f]{64}/, `$1${'0'.repeat(64)}`));
    await waitFor(async () => /integrity mismatch: worker\.mjs/.test(pair.state()?.lastError || ''), 10000);
    const firstWrite = pair.state().updatedAt;
    await sleep(3500);
    ok(pair.state()?.updatedAt === firstWrite, 'B8: an ongoing integrity failure is written to the receipt once, not on every 1 s poll');
    writeAtomic(manifestOf(dir), committed);
    const cleared = await waitFor(async () => pair.state()?.lastError === null, 10000).then(() => true, () => false);
    const healed = pair.state();
    ok(cleared && healed?.status === 'ready' && healed.hotReloads === 0 && healed.active?.pid,
      'B8: once the same manifest verifies again its integrity error is cleared, and nothing swaps');
  });

  await Promise.all([
    asleepThenWakeIntoNewer(),
    breakingWakeWithoutPrev(),
    majorWakeResumesPrev(),
    swapThenRollbackWhileAsleep(),
    integrityFailureNeverBootsSleepingPath(),
    integrityWaitAdoptsFinishedInstall(),
    flatBundleDefersWake(),
    realWorkerProbeStampsNoActivity(),
    integrityErrorWrittenOnce(),
  ]);

  // B7 — exactly which receipts a starting supervisor removes.
  {
    const dir = runtimeDir('receipts');
    const now = Date.now();
    const stale = new Date(now - 10 * 60_000).toISOString();
    const fresh = new Date(now).toISOString();
    const foreignPid = process.platform === 'win32' ? 4 : 1;   // exists; usually not ours to signal (EPERM)
    const receipts = {
      [`${deadPid}.json`]: { pid: deadPid },                                         // its own pid is gone
      '1001.json': { pid: process.pid, parentPid: deadPid, updatedAt: stale },       // pid reused, host gone, stale
      '1002.json': { pid: process.pid, parentPid: deadPid, updatedAt: fresh },       // host just died: 120 s to close itself
      '1003.json': { pid: process.pid, parentPid: process.pid, updatedAt: stale },   // idle, but its host lives
      '1004.json': { pid: foreignPid, parentPid: foreignPid, updatedAt: stale },     // EPERM-owned pids are alive
    };
    for (const [name, value] of Object.entries(receipts)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    fs.writeFileSync(path.join(dir, '1005.json'), '{"pid": 1');   // torn
    fs.writeFileSync(path.join(dir, `1006.json.${deadPid}.tmp`), '{}');
    fs.writeFileSync(path.join(dir, `1007.json.${process.pid}.tmp`), '{}');
    fs.writeFileSync(path.join(dir, `1008.json.dead-${deadPid}-0a1b2c3d`), '{}');
    const removed = supervisorTest.cleanSupervisorStateDir(dir, { now });
    const left = new Set(fs.readdirSync(dir));
    ok(!left.has(`${deadPid}.json`) && !left.has('1005.json'), 'B7: receipts of dead or torn supervisors are removed');
    ok(!left.has('1001.json'), 'B7: a receipt whose pid was reused is removed once its host is gone and it is >120 s stale');
    ok(left.has('1002.json') && left.has('1003.json'),
      'B7: a fresh receipt whose host just died, and an idle receipt whose host lives, are kept');
    ok(supervisorTest.pidState(foreignPid) === 'alive' && left.has('1004.json'),
      'B7: a pid we may not signal (EPERM) counts as alive and its receipt is never deleted');
    ok(!left.has(`1006.json.${deadPid}.tmp`) && !left.has(`1008.json.dead-${deadPid}-0a1b2c3d`) && left.has(`1007.json.${process.pid}.tmp`),
      'B7: leftover tmp files are removed only when their writer is dead');
    ok(removed.receipts.length === 3 && removed.tmp.length === 2, 'B7: the cleanup reports exactly what it removed');
  }

  // B8 — the poller's stat gate, unit level.
  {
    const dir = runtimeDir('watch');
    const worker = path.join(dir, 'worker.mjs');
    fs.writeFileSync(worker, 'export const generation = 1;\n');
    commitManifest(dir, '1.0.0');
    let clock = 1_000_000;
    const watch = supervisorTest.createRuntimeWatch(manifestOf(dir), { reverifyMs: 60_000, now: () => clock });
    const first = watch.read();
    const second = watch.read();
    ok(first.ok && !first.cached && second.ok && second.cached && second.target.signature === first.target.signature,
      'B8: an unchanged manifest is served from the stat gate without re-hashing the runtime');
    fs.writeFileSync(worker, 'export const generation = 2;\n');   // a runtime file changes, no new manifest
    const skipped = watch.read();
    clock += 60_000;
    const reverified = watch.read();
    ok(skipped.ok && skipped.cached && !reverified.ok && /integrity mismatch: worker\.mjs/.test(reverified.error || ''),
      'B8: a runtime file mutated without a manifest change is reported at the next full re-verify');
    const again = watch.read();
    ok(!again.ok && !again.cached, 'B8: a failed verification is never cached');
    commitManifest(dir, '1.0.1');
    const committed = watch.read();
    ok(committed.ok && !committed.cached && committed.target.signature !== first.target.signature,
      'B8: a newly committed manifest is read in full on the next poll');
    ok(watch.read().cached && !watch.read({ force: true }).cached, 'B8: a full read can be forced before any candidate starts');
  }

  // B8 — a state write that fails leaves nothing behind.
  {
    const dir = runtimeDir('atomic');
    const blocked = path.join(dir, `${process.pid}.json`);
    fs.mkdirSync(blocked);   // a directory where the receipt belongs: the rename cannot succeed
    let threw = false;
    try { supervisorTest.atomicJson(blocked, { protocol: 1 }); } catch { threw = true; }
    ok(threw && !fs.readdirSync(dir).some(entry => entry.endsWith('.tmp')), 'B8: a failed supervisor state write unlinks its tmp file');
  }

  // B10 — one poll cadence for every spawner.
  {
    const source = fs.readFileSync(path.join(HERE, '..', 'src', 'mcp-supervisor.mjs'), 'utf8').replace(/\r/g, '');
    ok(supervisorTest.DEFAULT_AUTO_UPDATE_POLL_MS === AUTO_UPDATE_POLL_MS && AUTO_UPDATE_POLL_MS <= 15 * 60_000,
      'B10: the supervisor polls the update schedule at AUTO_UPDATE_POLL_MS (10 min)');
    ok(/import \* as (\w+) from '\.\/mcp-auto-update\.mjs';/.test(source) && /Number\(\w+\.AUTO_UPDATE_POLL_MS\)/.test(source)
      && !/\{[^}]*\bAUTO_UPDATE_POLL_MS\b[^}]*\} from '\.\/mcp-auto-update\.mjs'/.test(source),
    'B10: it reads AUTO_UPDATE_POLL_MS as a namespace member, so a mid-install module pair still links');
    ok(supervisorTest.RESTART_REQUIRED_IDLE === SPEC_RECONNECT_ERROR, 'B4: the reconnect error text is the one the doctor and docs quote');
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
