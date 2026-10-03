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
import { __test as supervisorTest, readRuntimeTarget } from '../src/mcp-supervisor.mjs';

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

function workerSource(version, {
  extraTool = false, removeVersion = false, presence = null, identity = false, bootAudit = null,
  crashOnce = null, hangOnce = null, initDelayMs = 0,
} = {}) {
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
if (BOOT_AUDIT) fs.appendFileSync(BOOT_AUDIT, JSON.stringify({ pid: process.pid, version: VERSION, file: process.argv[1], autoUpdate: process.env.KLYPIX_AUTO_UPDATE ?? null }) + '\\n');
// Transient failures, once per marker file: crash at start, or ignore the first
// initialize (the supervisor's initialize timeout then fires).
const CRASH_ONCE = ${JSON.stringify(crashOnce)};
if (CRASH_ONCE && fs.existsSync(CRASH_ONCE)) { fs.unlinkSync(CRASH_ONCE); process.exit(1); }
const HANG_ONCE = ${JSON.stringify(hangOnce)};
let hangInitialize = false;
if (HANG_ONCE && fs.existsSync(HANG_ONCE)) { fs.unlinkSync(HANG_ONCE); hangInitialize = true; }
// A real worker answers initialize in ~0.5 s, sometimes longer than one 1 s poll.
const INIT_DELAY_MS = ${JSON.stringify(initDelayMs)};
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
    if (hangInitialize) { hangInitialize = false; return; }
    if (INIT_DELAY_MS) await new Promise(resolve => setTimeout(resolve, INIT_DELAY_MS));
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
  // bin/klypix-install.mjs in miniature: snapshot the live install to .prev —
  // only when it verifies against its own manifest, which goes in last — rename
  // the new worker in, commit the manifest last (commit:false = it stopped there).
  const install = (dir, version, { commit = true, ...options } = {}) => {
    const worker = path.join(dir, 'worker.mjs');
    if (readRuntimeTarget(manifestOf(dir)).ok) {
      const prev = path.join(dir, '.prev');
      fs.mkdirSync(prev, { recursive: true });
      fs.rmSync(manifestOf(prev), { force: true });
      fs.copyFileSync(worker, path.join(prev, 'worker.mjs'));
      writeAtomic(manifestOf(prev), fs.readFileSync(manifestOf(dir), 'utf8'));
    }
    writeAtomic(worker, workerSource(version, options));
    if (commit) commitManifest(dir, version);
  };
  const boots = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : []);
  const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
  const fromPrev = (entry) => /[\\/]\.prev[\\/]worker\.mjs$/.test(String(entry?.file || ''));
  // A pid that is dead NOW. Windows reuses pids within minutes under load, so a
  // check that runs much later takes a fresh one (obtainDeadPid) instead of this.
  const obtainDeadPid = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await new Promise(resolve => child.once('exit', resolve));
      if (supervisorTest.pidState(child.pid) === 'dead') return child.pid;
    }
    throw new Error('could not obtain a dead pid');
  };
  const deadPid = await obtainDeadPid();

  async function openPair(dir, name, { env = {}, args = [], entry = BIN, pollMs = null, onLog = null } = {}) {
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
    if (pollMs) childEnv.KLYPIX_MCP_SUPERVISOR_POLL_MS = String(pollMs);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, ...args],
      cwd: dir,
      env: childEnv,
      stderr: 'pipe',
    });
    const logs = [];
    transport.stderr?.on('data', (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 400) logs.shift();
      onLog?.(logs.join(''));   // the whole tail: a log line can span chunks
    });
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
    ok(/resumed v90\.0\.0 from \.prev; v91\.0\.0 needs \/mcp reconnect \(major upgrade/.test(pair.logs())
      && !/recovered worker v90\.0\.0 without reconnect/.test(pair.logs()),
    'F10: the log says the .prev resume still needs a reconnect, never "recovered … without reconnect"');
  });

  // B8 swap at 1 s + B1/B3: a --force rollback while asleep. MV-1 (2026-10-03
  // review): v90.1.0 takes 2.5 s to initialize — longer than one 1 s poll, as a
  // real worker sometimes does — and adds a tool, so a rollback slipped in
  // while the wake's .prev candidate validates would either hot-swap to v90.0.0
  // or strand the pair restart-required. Boots are counted seconds later.
  const swapThenRollbackWhileAsleep = () => scenario('rollback', async (track) => {
    const dir = runtimeDir('rollback');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'b3-rollback'));
    await pair.call();
    install(dir, '90.1.0', { identity: true, bootAudit: audit, extraTool: true, initDelayMs: 2500 });
    await waitFor(async () => (await pair.call()) === '90.1.0', 20000);
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
    await sleep(4000);   // several 1 s polls after the .prev candidate committed
    const woke = boots(audit).slice(bootCount);
    ok(woke.length === 1 && woke[0].version === '90.1.0' && fromPrev(woke[0]),
      `B3/MV-1: that wake booted only .prev — the rolled-back v90.0.0 never started, even while .prev validated across polls (boots: ${woke.map(entry => `${entry.version}${fromPrev(entry) ? '(.prev)' : ''}`).join(' ') || 'none'})`);
    // Ready, or asleep again (1 s idle): a restart-required pair never hibernates.
    const settled = pair.state();
    const ran = settled?.active?.version || settled?.hibernation?.target?.version;
    ok(['ready', 'hibernated'].includes(settled?.status) && ran === '90.1.0' && !settled.lastError && await pair.call() === '90.1.0',
      `MV-1: the woken pair stays on v90.1.0 — no in-place downgrade, no "breaking tool manifest" for a deliberate rollback (${settled?.status}${settled?.lastError ? `: ${settled.lastError}` : ''})`);
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
    // F6: the reinstall hint needs 3 refusals over 10 min in production; 0 here.
    const pair = track(await openPair(dir, 'b3-flat', { entry, env: { KLYPIX_MCP_WAKE_REINSTALL_HINT_MS: '0' } }));
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
    ok(deferred?.hibernation?.wakeDeferred?.count === 1 && /integrity mismatch: worker\.mjs/.test(deferred.hibernation.wakeDeferred.reason || ''),
      'F6: the receipt records the refused wake, so the doctor stops promising a wake on the next request');
    const second = await pair.callError();
    const third = await pair.callError();
    ok(/retry shortly/.test(String(second?.message || ''))
      && /still do not verify .* after 3 attempts since .* — the install on this machine needs a repair: ask the user to run npx -y klypix-mcp@latest doctor, which shows the fix \(do not run an installer yourself\), then retry/.test(String(third?.message || ''))
      && !/klypix-mcp@\S+ install|install --force/.test(String(third?.message || ''))
      && pair.state()?.hibernation?.wakeDeferred?.count === 3 && boots(audit).length === bootCount,
    `F6: a refusal that persists names the repair and its owner (the user, via the doctor) instead of "retry shortly", never an installer command (${String(third?.message || '').slice(0, 160)})`);
    commitManifest(dir, '90.1.0');   // the interrupted install is re-run to completion
    const healed = await waitFor(async () => {
      const s = pair.state();
      return s?.status === 'hibernated' && s.lastError === null && s.hibernation?.wakeDeferred === null ? s : null;
    }, 10000).then(() => true, () => false);
    ok(healed, 'F6: once the runtime verifies again, the poller clears the refusal while the pair still sleeps');
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

  // 2026-10-03 integration review: the receipt's autoUpdate.enabled is the
  // supervisor's OWN setting. The doctor ("enabled in N of M connections") and
  // the SessionStart notice ("overdue") read it to know which connections run
  // checks, but the environment's view from inspectAutoUpdate() overwrote it,
  // so a supervisor embedded with autoUpdate:false (the public
  // klypix-mcp/supervisor API) claimed to run them.
  const embeddedReceiptOwnSetting = () => scenario('embedded', async (track) => {
    const dir = runtimeDir('embedded');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const entry = path.join(dir, 'embedded-supervisor.mjs');
    fs.writeFileSync(entry, [
      `import { runMcpSupervisor } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'mcp-supervisor.mjs')).href)};`,
      `await runMcpSupervisor({ fallbackWorker: ${JSON.stringify(path.join(dir, 'worker.mjs'))}, fallbackVersion: '90.0.0', autoUpdate: false });`,
      '',
    ].join('\n'));
    // Updates ON in the environment. KLYPIX_MCP_AUTO_UPDATE_CHILD=1 still keeps
    // any helper from starting: nothing in this suite may contact npm.
    const pair = track(await openPair(dir, 'embedded', {
      entry,
      env: { KLYPIX_AUTO_UPDATE: '', KLYPIX_MCP_AUTO_UPDATE_CHILD: '1', KLYPIX_WORKER_HIBERNATE_MS: '0' },
    }));
    ok(await pair.call() === '90.0.0', 'an embedded supervisor (runMcpSupervisor, autoUpdate:false) serves its worker');
    const state = await waitFor(async () => (pair.state()?.status === 'ready' ? pair.state() : null), 10000);
    ok(state.autoUpdate?.enabled === false && 'dueReason' in (state.autoUpdate || {}),
      "the receipt records the supervisor's own auto-update setting (off), not its environment's (on), next to the schedule");
    // CF-5 (2026-10-03 review): the worker runs its own update poll from its
    // own environment, so "off" in the receipt was true of the supervisor only.
    const workerBoots = boots(audit);
    ok(workerBoots.length >= 1 && workerBoots.every(entry => entry.autoUpdate === '0'),
      `CF-5: the worker of a supervisor embedded with autoUpdate:false runs with KLYPIX_AUTO_UPDATE=0 (${JSON.stringify(workerBoots.map(entry => entry.autoUpdate))})`);
  });

  await Promise.all([
    embeddedReceiptOwnSetting(),
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

  // ── 2026-10-03 review round: wakes of a direct-package pair, transient wake
  // failures, the stat gate's forced read, an unreadable manifest ────────────
  // A direct-package launch in miniature: the supervisor's own worker lives
  // OUTSIDE the managed runtime directory, like <npx cache>/klypix-mcp/bin.
  const packageEntry = (name, version, options = {}) => {
    const pkgDir = path.join(root, 'b', `${name}-pkg`);
    fs.mkdirSync(pkgDir, { recursive: true });
    const worker = path.join(pkgDir, 'worker.mjs');
    fs.writeFileSync(worker, workerSource(version, options));
    const entry = path.join(pkgDir, 'entry.mjs');
    fs.writeFileSync(entry, [
      `import { runMcpSupervisor } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'mcp-supervisor.mjs')).href)};`,
      `await runMcpSupervisor({ fallbackWorker: ${JSON.stringify(worker)}, fallbackVersion: ${JSON.stringify(version)}, workerArgs: [] });`,
      '',
    ].join('\n'));
    return { entry, worker };
  };
  // The flat bundle in miniature: the supervisor's own worker IS the runtime's.
  const flatEntry = (dir, version) => {
    const entry = path.join(dir, 'server.mjs');
    fs.writeFileSync(entry, [
      `import { runMcpSupervisor } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'mcp-supervisor.mjs')).href)};`,
      `await runMcpSupervisor({ fallbackWorker: ${JSON.stringify(path.join(dir, 'worker.mjs'))}, fallbackVersion: ${JSON.stringify(version)}, workerArgs: [] });`,
      '',
    ].join('\n'));
    return entry;
  };
  const answer = (pair) => pair.call().catch(error => `ERROR ${error?.message || error}`);
  const bootList = (entries) => entries.map(entry => `${entry.version}${fromPrev(entry) ? '(.prev)' : ''}`).join(' ') || 'none';

  // CF-1: the README's `npx -y klypix-mcp` (Claude Desktop) runs the package's
  // own worker while the managed runtime is OLDER. Its first wake after a
  // hibernation settled restart-required ("a rollback applies at the next
  // reconnect") — after every publish, until the managed runtime caught up.
  const packagePairWakesOwnWorker = () => scenario('pkg-older-runtime', async (track) => {
    const dir = runtimeDir('pkg-older-runtime');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const { entry, worker } = packageEntry('pkg-older-runtime', '90.1.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'cf1-pkg-older', { entry }));
    ok(await pair.call() === '90.1.0', 'CF-1: a direct-package pair whose managed runtime is older serves the package\'s own worker');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const bootCount = boots(audit).length;
    const first = await answer(pair);
    const second = await answer(pair);
    const woke = boots(audit).slice(bootCount);
    const s = pair.state();
    ok(first === '90.1.0' && second === '90.1.0', `CF-1: after a hibernation it wakes into the worker it ran — no reconnect error (${first} / ${second})`);
    ok(['ready', 'hibernated'].includes(s?.status) && !s.lastError && woke.length >= 1 && woke.every(item => samePath(item.file, worker)),
      `CF-1: the wake booted only the package worker; the older managed runtime never started (${s?.status}; ${bootList(woke)})`);
  });

  // CF-1: the same pair while the managed runtime fails integrity. The worker
  // it slept on is the package's own, outside the managed directory: every
  // request waited ~5 s and failed "core files do not verify … retry shortly".
  const packagePairWakesThroughIntegrity = () => scenario('pkg-integrity', async (track) => {
    const dir = runtimeDir('pkg-integrity');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    writeAtomic(manifestOf(dir), fs.readFileSync(manifestOf(dir), 'utf8').replace(/("worker\.mjs": ")[0-9a-f]{64}/, `$1${'0'.repeat(64)}`));
    const { entry, worker } = packageEntry('pkg-integrity', '90.1.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'cf1-pkg-integrity', { entry }));
    ok(await pair.call() === '90.1.0', 'CF-1: a direct-package pair beside a runtime failing integrity serves the package\'s own worker');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const bootCount = boots(audit).length;
    const woken = await answer(pair);
    const woke = boots(audit).slice(bootCount);
    ok(woken === '90.1.0' && woke.length >= 1 && woke.every(item => samePath(item.file, worker)) && !pair.state()?.hibernation?.wakeDeferred,
      `CF-1: it wakes into the package worker it slept on — never "core files do not verify" for a worker outside the managed directory (${woken.slice(0, 120)})`);
  });

  // TQ-6: a pair that slept on the MANAGED runtime meets an install that
  // stopped half-way, with no .prev to resume. The package's own worker lives
  // outside the managed directory, so the wake boots that — a consistent graph
  // — and never the half-installed runtime's worker.mjs.
  const runtimePairWakesPackageOnIntegrity = () => scenario('pkg-fallback-integrity', async (track) => {
    const dir = runtimeDir('pkg-fallback-integrity');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const { entry, worker } = packageEntry('pkg-fallback-integrity', '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'tq6-pkg-fallback', { entry }));
    ok(await pair.call() === '90.0.0' && samePath(boots(audit)[0]?.file, path.join(dir, 'worker.mjs')),
      'TQ-6: an equal-version direct-package pair starts on the managed runtime');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    fs.rmSync(path.join(dir, '.prev'), { recursive: true, force: true });
    const bootCount = boots(audit).length;
    const woken = await answer(pair);
    const woke = boots(audit).slice(bootCount);
    ok(woken === '90.0.0' && woke.length >= 1 && woke.every(item => samePath(item.file, worker)),
      `TQ-6: with no .prev, the wake boots the package's own worker, never the half-installed runtime (${woken.slice(0, 120)}; ${woke.map(item => path.basename(path.dirname(item.file))).join(' ')})`);
  });

  // TQ-1: .prev holds a version OTHER than the one this connection last ran
  // (v90.0.0 after a swap to v90.1.0, which added a tool). A crash on wake
  // retries the installed core. Resuming any .prev turned it into a permanent
  // restart-required: gated against v90.1.0, v90.0.0 "removed tools".
  const crashOnWakeRetriesInstalled = () => scenario('crash-once', async (track) => {
    const dir = runtimeDir('crash-once');
    const audit = path.join(dir, 'boots.jsonl');
    const marker = path.join(dir, 'crash-once.marker');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'tq1-crash-once'));
    await pair.call();
    install(dir, '90.1.0', { identity: true, bootAudit: audit, extraTool: true, crashOnce: marker });
    await waitFor(async () => (await pair.call()) === '90.1.0', 15000);
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    fs.writeFileSync(marker, 'x');   // the next v90.1.0 boot exits once
    const bootCount = boots(audit).length;
    const woken = await answer(pair);
    await sleep(1500);
    const woke = boots(audit).slice(bootCount);
    const s = pair.state();
    ok(woken === '90.1.0' && ['ready', 'hibernated'].includes(s?.status) && !s.lastError && !fs.existsSync(marker) && !woke.some(fromPrev),
      `TQ-1: a crash on wake retries the installed v90.1.0 after the backoff; the older .prev never starts (${woken.slice(0, 120)}; ${s?.status}; ${bootList(woke)})`);
  });

  // TQ-2: a transient failure that is not an exit — the woken candidate
  // ignores its first initialize — keeps the recovery backoff. Classed as
  // deterministic, it settled restart-required with no retry.
  const timeoutOnWakeRetriesInstalled = () => scenario('hang-once', async (track) => {
    const dir = runtimeDir('hang-once');
    const audit = path.join(dir, 'boots.jsonl');
    const marker = path.join(dir, 'hang-once.marker');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'tq2-hang-once', { env: { KLYPIX_MCP_SUPERVISOR_TIMEOUT_MS: '2000' } }));
    await pair.call();
    install(dir, '90.1.0', { identity: true, bootAudit: audit, extraTool: true, hangOnce: marker });
    await waitFor(async () => (await pair.call()) === '90.1.0', 15000);
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    fs.writeFileSync(marker, 'x');   // the next v90.1.0 boot never answers its initialize
    const bootCount = boots(audit).length;
    const woken = await answer(pair);
    await sleep(1500);
    const woke = boots(audit).slice(bootCount);
    const s = pair.state();
    ok(woken === '90.1.0' && ['ready', 'hibernated'].includes(s?.status) && !s.lastError
      && woke.filter(item => item.version === '90.1.0' && !fromPrev(item)).length >= 2 && !woke.some(fromPrev),
    `TQ-2: an initialize timeout on wake is transient — the backoff retry serves v90.1.0, status clean (${woken.slice(0, 120)}; ${s?.status}; ${bootList(woke)})`);
  });

  // SWAP-RETRY (2026-10-03, field): a HOT-SWAP candidate that times out while the
  // old worker keeps serving used to be rejected for good — restart-required,
  // its signature blacklisted — so one initialize timeout under load pinned the
  // connection to its old version until a reconnect. It now retries on the swap
  // backoff (base 1 s here) and lands the new version without a reconnect.
  const timeoutOnSwapRetries = () => scenario('swap-hang-once', async (track) => {
    const dir = runtimeDir('swap-hang-once');
    const audit = path.join(dir, 'boots.jsonl');
    const marker = path.join(dir, 'swap-hang-once.marker');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'swap-hang-once', {
      env: { KLYPIX_MCP_SUPERVISOR_TIMEOUT_MS: '2000', KLYPIX_MCP_SWAP_RETRY_BASE_MS: '4000', KLYPIX_WORKER_HIBERNATE_MS: '0' },
    }));
    ok(await pair.call() === '90.0.0', 'SWAP-RETRY: the pair serves v90.0.0 before the update');
    fs.writeFileSync(marker, 'x');   // the first v90.1.0 candidate never answers its initialize
    install(dir, '90.1.0', { identity: true, bootAudit: audit, extraTool: true, hangOnce: marker });
    // The 4 s retry window opens once the hung first attempt times out (2 s).
    let sawRetry = null;
    try {
      await waitFor(async () => {
        const s = pair.state();
        if (s?.swapRetry) sawRetry = { status: s.status, swapRetry: s.swapRetry, served: await pair.call() };
        return Boolean(sawRetry);
      }, 15000);
    } catch { /* reported below */ }
    let landed = false;
    try { await waitFor(async () => (await pair.call()) === '90.1.0', 20000); landed = true; } catch { /* reported below */ }
    const s = pair.state();
    ok(landed && s?.status === 'ready' && !s.lastError && s.hotReloads >= 1
      && boots(audit).filter(item => item.version === '90.1.0').length >= 2,
    `SWAP-RETRY: after a transient initialize timeout the swap is retried and lands v90.1.0 with no reconnect (${s?.status}; hot ${s?.hotReloads}; ${s?.lastError || 'no error'}; ${bootList(boots(audit))})`);
    ok(Boolean(sawRetry) && sawRetry.status === 'ready' && sawRetry.served === '90.0.0' && sawRetry.swapRetry.attempt === 1,
      `SWAP-RETRY: while the retry waits, the old worker keeps serving and the pair reads ready, not restart-required (${JSON.stringify(sawRetry)})`);
  });

  // TQ-6: the stat gate only ever SKIPS work. A breaking B is rejected while A
  // serves; B's worker is then edited with no new manifest (the stat gate still
  // says "verified"), and A's crash recovery clears the rejection. The next poll
  // must re-verify B in full before starting it, never boot its new bytes.
  const forcedReadBeforeCandidate = () => scenario('forced-read', async (track) => {
    const dir = runtimeDir('forced-read');
    const writeWorkerFile = (name, version, options) => writeAtomic(path.join(dir, name), workerSource(version, options));
    const commitWorker = (name, version) => writeAtomic(manifestOf(dir), `${JSON.stringify({
      protocol: 1, version, worker: name, channel: 'npm', installedAt: new Date().toISOString(),
      files: { [name]: hash(path.join(dir, name)) },
    }, null, 2)}\n`);
    writeWorkerFile('worker-a.mjs', '90.0.0', { identity: true });
    writeWorkerFile('worker-b.mjs', '90.1.0', { identity: true, removeVersion: true });   // breaking: drops `version`
    commitWorker('worker-a.mjs', '90.0.0');
    const pair = track(await openPair(dir, 'tq6-forced-read', { env: { KLYPIX_WORKER_HIBERNATE_MS: '0', KLYPIX_MCP_ROLLBACK_GRACE_MS: '300' } }));
    ok(await pair.call() === '90.0.0', 'TQ-6: A serves v90.0.0');
    commitWorker('worker-b.mjs', '90.1.0');
    await waitFor(async () => /removed tools: version/.test(pair.state()?.lastError || ''), 15000);
    writeWorkerFile('worker-b.mjs', '90.1.0', { identity: true, extraTool: true });   // new bytes, same manifest
    const crashed = await pair.callError('crash');
    await waitFor(async () => pair.state()?.status === 'ready' && pair.state()?.active?.version === '90.0.0', 15000);
    await sleep(3000);   // several 1 s polls after the recovery commit
    const served = await answer(pair);
    const s = pair.state();
    ok(Boolean(crashed) && served === '90.0.0' && s?.active?.version === '90.0.0'
      && /integrity mismatch: worker-b\.mjs/.test(s?.lastError || ''),
    `TQ-6: a cached target is re-verified in full before a candidate starts — the edited B is reported, never booted (${served}; ${s?.lastError})`);
  });

  // CF-2: a manifest that exists but cannot be read is not "absent". Here it is
  // briefly a directory (EISDIR); in the field, EBUSY while an installer renames
  // the new one over it. The wake waits it out like an integrity failure; taken
  // for "no runtime", it skipped the wait and booted the flat bundle's worker.
  const unreadableManifestWaitsOnWake = () => scenario('unreadable', async (track) => {
    const dir = runtimeDir('unreadable');
    install(dir, '90.0.0', { identity: true });
    const pair = track(await openPair(dir, 'cf2-unreadable', { entry: flatEntry(dir, '90.0.0') }));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    install(dir, '90.1.0', { identity: true });
    await waitFor(async () => pair.state()?.hibernation?.pendingWakeTarget?.version === '90.1.0', 10000);
    const committed = fs.readFileSync(manifestOf(dir), 'utf8');
    fs.rmSync(manifestOf(dir), { force: true, maxRetries: 20, retryDelay: 25 });
    fs.mkdirSync(manifestOf(dir));
    const restore = sleep(1500).then(() => {
      fs.rmSync(manifestOf(dir), { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      writeAtomic(manifestOf(dir), committed);
    });
    const woken = await answer(pair);
    await restore;
    ok(woken === '90.1.0', `CF-2: a wake that meets an unreadable (not absent) manifest waits for it and wakes into the install (${woken.slice(0, 160)})`);
  });

  // CF-2: with NO manifest at all, the flat bundle's own worker is the managed
  // runtime itself, which nothing verifies — a wake never boots it.
  const flatAbsentManifestDefers = () => scenario('flat-absent', async (track) => {
    const dir = runtimeDir('flat-absent');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'cf2-flat-absent', { entry: flatEntry(dir, '90.0.0') }));
    await pair.call();
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    const committed = fs.readFileSync(manifestOf(dir), 'utf8');
    fs.rmSync(manifestOf(dir), { force: true, maxRetries: 20, retryDelay: 25 });
    const bootCount = boots(audit).length;
    const refused = await answer(pair);
    ok(/KLYPIX core files do not verify \(runtime manifest is absent\)/.test(refused) && boots(audit).length === bootCount,
      `CF-2: a flat-bundle wake with no manifest boots nothing unverified and answers with a retryable error (${refused.slice(0, 140)})`);
    writeAtomic(manifestOf(dir), committed);
    await waitFor(async () => pair.state()?.hibernation?.wakeDeferred === null, 10000);
    ok(await answer(pair) === '90.0.0', 'CF-2: once the manifest is back, the next request wakes the pair');
  });

  // CF-2: the package's own worker can change on disk under a running
  // supervisor (an npx cache refresh). A wake uses the version the file carries
  // NOW — under the old tag every attempt failed "candidate advertised vY,
  // manifest says vX" and the pair reached recovery-failed.
  const packageRefreshedWakesNewVersion = () => scenario('pkg-refreshed', async (track) => {
    const dir = runtimeDir('pkg-refreshed');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    const { entry, worker } = packageEntry('pkg-refreshed', '90.1.0', { identity: true, bootAudit: audit });
    const pair = track(await openPair(dir, 'cf2-pkg-refreshed', { entry }));
    ok(await pair.call() === '90.1.0', 'CF-2: a direct-package pair serves its package worker v90.1.0');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    writeAtomic(worker, workerSource('90.2.0', { identity: true, bootAudit: audit }));   // npx refreshed the package
    const woken = await answer(pair);
    const s = pair.state();
    ok(woken === '90.2.0' && ['ready', 'hibernated'].includes(s?.status) && !s.lastError,
      `CF-2: the wake starts the package worker under the version its file carries now (${woken.slice(0, 140)})`);
  });

  await Promise.all([
    packagePairWakesOwnWorker(),
    packagePairWakesThroughIntegrity(),
    runtimePairWakesPackageOnIntegrity(),
    crashOnWakeRetriesInstalled(),
    timeoutOnWakeRetriesInstalled(),
    timeoutOnSwapRetries(),
    forcedReadBeforeCandidate(),
    unreadableManifestWaitsOnWake(),
    flatAbsentManifestDefers(),
    packageRefreshedWakesNewVersion(),
  ]);

  // ── K1 (2026-10-03): a FRESH connection that starts while an install is
  // half-applied. In the flat bundle the supervisor's own worker IS the managed
  // worker, so the old boot (integrity failure → the package's own worker)
  // started a file in the middle of the install's renames. Polls are pinned at
  // 60 s so no poll-driven swap interferes; the post-handshake update check still
  // runs, so only the raw first-receipt check below proves what the boot records.
  const stateIn = (dir) => {
    try {
      return fs.readdirSync(path.join(dir, 'states'))
        .filter(entry => /^\d+\.json$/.test(entry))
        .map(entry => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'states', entry), 'utf8')); } catch { return null; } })
        .find(Boolean) || null;
    } catch { return null; }
  };
  const quiet = { pollMs: 60_000, env: { KLYPIX_WORKER_HIBERNATE_MS: '0' } };

  const bootDuringInstallStartsPrev = () => scenario('boot-prev', async (track) => {
    const dir = runtimeDir('boot-prev');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });   // stopped before its manifest; .prev holds v90.0.0
    // Every receipt status written while the boot waits (it waits ~5 s here).
    const seen = new Set();
    const watcher = setInterval(() => { const s = stateIn(dir); if (s) seen.add(s.status); }, 40);
    const started = Date.now();
    let pair;
    try { pair = track(await openPair(dir, 'k1-boot-prev', { entry: flatEntry(dir, '90.1.0'), ...quiet })); }
    finally { clearInterval(watcher); }
    const waited = Date.now() - started;
    ok(!seen.has('starting'),
      `K1: nothing is receipted while the boot waits — a pair with no worker would read as impaired and unaligned (${[...seen].join(', ') || 'none'})`);
    const booted = boots(audit);
    ok(await answer(pair) === '90.0.0' && booted.length === 1 && fromPrev(booted[0]),
      `K1: a connection starting during a half-applied install boots .prev's complete copy, never the directory being renamed (${bootList(booted)})`);
    ok(waited >= 4000, `K1: it first waited for the install to settle (${waited} ms)`);
    const s = pair.state();
    ok(s?.active?.source === 'rollback' && /integrity mismatch: worker\.mjs/.test(s?.lastError || ''),
      `K1: its receipt names the .prev worker it serves and the integrity error (${s?.active?.source}; ${s?.lastError})`);
  });

  const bootWaitsForInstallToFinish = () => scenario('boot-settles', async (track) => {
    const dir = runtimeDir('boot-settles');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    // The installer commits once this supervisor says it is waiting for it.
    let committed = false;
    const onLog = (text) => {
      if (committed || !/runtime fails integrity at start .* waiting up to \d+ ms for an install to settle/.test(text)) return;
      committed = true;
      commitManifest(dir, '90.1.0');
    };
    const pair = track(await openPair(dir, 'k1-boot-settles', { entry: flatEntry(dir, '90.1.0'), onLog, ...quiet }));
    ok(committed, 'K1: a boot that meets an install mid-rename says it waits for the install to settle');
    const booted = boots(audit);
    const s = pair.state();
    ok(await answer(pair) === '90.1.0' && booted.length === 1 && !fromPrev(booted[0])
      && s?.active?.source === 'installed' && !s.lastError,
    `K1: an install that commits inside the wait is booted as the verified runtime (${bootList(booted)}; ${s?.active?.source}; ${s?.lastError})`);
  });

  const bootWithoutPrevRejectsUncheckedFiles = () => scenario('boot-noprev', async (track) => {
    const dir = runtimeDir('boot-noprev');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    fs.rmSync(path.join(dir, '.prev'), { recursive: true, force: true });
    const started = Date.now();
    const child = spawn(process.execPath, [flatEntry(dir, '90.1.0')], {
      cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KLYPIX_MCP_RUNTIME_MANIFEST: manifestOf(dir), KLYPIX_MCP_STATE_DIR: path.join(dir, 'states'), KLYPIX_AUTO_UPDATE: '0' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('unchecked startup did not close within 30 s')); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'k1-boot-noprev', version: '1.0.0' } } }) + '\n');
    const result = await exited;
    const replies = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const error = replies.find(message => message.id === 1)?.error;
    ok(result.code !== 0 && Date.now() - started >= 4000 && boots(audit).length === 0
      && error?.code === -32002 && error.data?.retryable === true && /no worker was started/.test(error.message),
      `K1: an incomplete install without .prev boots nothing and answers initialize with a retryable error (${JSON.stringify(result)}; ${stdout}; ${stderr.slice(-160)})`);
    commitManifest(dir, '90.1.0');
    const pair = track(await openPair(dir, 'k1-boot-repaired', { entry: flatEntry(dir, '90.1.0'), ...quiet }));
    ok(await answer(pair) === '90.1.0' && boots(audit).length === 1,
      'K1: reconnect after the install finishes starts the verified worker');
  });

  const bootDirectPackageAtOnce = () => scenario('boot-pkg', async (track) => {
    const dir = runtimeDir('boot-pkg');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    const { entry, worker } = packageEntry('boot-pkg', '90.1.0', { identity: true, bootAudit: audit });
    const started = Date.now();
    const pair = track(await openPair(dir, 'k1-boot-pkg', { entry, env: { KLYPIX_WORKER_HIBERNATE_MS: '0' } }));
    const connected = Date.now() - started;
    const booted = boots(audit);
    ok(await answer(pair) === '90.1.0' && booted.length === 1 && samePath(booted[0].file, worker)
      && connected < 4500 && !/still fails integrity/.test(pair.logs()),
    `K1: a direct-package launch boots its own worker at once — it lives outside the directory being installed (${connected} ms; ${bootList(booted)})`);
  });

  // K1-PREV-UNVERIFIED (2026-10-03 review): .prev is booted only while its own
  // manifest verifies. An installer that refreshed .prev from a half-applied
  // live directory (any installer before this fix, retrying 15 min after the
  // failed attempt) left a worker that still carries a baked version beside a
  // sibling module of the other version; the desktop installer keeps no manifest
  // in .prev at all. A .prev shaped like the real one: the worker beside a
  // sibling module, both hashed by the manifest.
  const writePrevSnapshot = (prev, version, { audit }) => {
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, 'worker.mjs'), workerSource(version, { identity: true, bootAudit: audit }));
    fs.writeFileSync(path.join(prev, 'engine.mjs'), `export const ENGINE = ${JSON.stringify(version)};\n`);
    writeAtomic(manifestOf(prev), `${JSON.stringify({
      protocol: 1, version, worker: 'worker.mjs', channel: 'npm', installedAt: new Date().toISOString(),
      files: { 'worker.mjs': hash(path.join(prev, 'worker.mjs')), 'engine.mjs': hash(path.join(prev, 'engine.mjs')) },
    }, null, 2)}\n`);
  };
  const mixPrev = (prev) => fs.writeFileSync(path.join(prev, 'engine.mjs'), 'export const ENGINE = "90.1.0";\n');
  const bootRefusesUnverifiedPrev = (name, label, spoil) => scenario(name, async (track) => {
    const dir = runtimeDir(name);
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    const prev = path.join(dir, '.prev');
    writePrevSnapshot(prev, '90.0.0', { audit });
    spoil(prev);
    // Same outcome as no .prev at all (boot-noprev): nothing boots, and the
    // host's initialize gets the retryable refusal instead of unchecked files.
    const child = spawn(process.execPath, [flatEntry(dir, '90.1.0')], {
      cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KLYPIX_MCP_RUNTIME_MANIFEST: manifestOf(dir), KLYPIX_MCP_STATE_DIR: path.join(dir, 'states'), KLYPIX_AUTO_UPDATE: '0' },
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name}: startup did not close within 30 s`)); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `k1-${name}`, version: '1.0.0' } } }) + '\n');
    const result = await exited;
    const replies = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const error = replies.find(message => message.id === 1)?.error;
    ok(result.code !== 0 && boots(audit).length === 0 && error?.code === -32002 && error.data?.retryable === true
      && /no previous worker whose own manifest verifies/.test(error.message),
    `K1-PREV: ${label} is never booted — the boot refuses the connection, as with no .prev (${JSON.stringify(result)}; ${bootList(boots(audit))}; ${error?.message || stdout.slice(-160)})`);
  });
  const bootRefusesMixedPrev = () => bootRefusesUnverifiedPrev('boot-prev-mixed',
    'a .prev whose worker carries a baked v90.0.0 beside a sibling module from v90.1.0', mixPrev);
  const bootRefusesUnvouchedPrev = () => bootRefusesUnverifiedPrev('boot-prev-nomanifest',
    'a .prev with a baked worker but no manifest of its own', (prev) => fs.rmSync(manifestOf(prev), { force: true }));

  // The same for a pair that already runs from .prev (K1 booted it there): its
  // wake resumed that copy on a baked version alone. Mixed since, it is not
  // resumed; in the flat bundle nothing consistent is left, so the wake defers.
  const wakeRefusesMixedPrev = () => scenario('wake-prev-mixed', async (track) => {
    const dir = runtimeDir('wake-prev-mixed');
    const audit = path.join(dir, 'boots.jsonl');
    install(dir, '90.0.0', { identity: true, bootAudit: audit });
    install(dir, '90.1.0', { identity: true, bootAudit: audit, commit: false });
    writePrevSnapshot(path.join(dir, '.prev'), '90.0.0', { audit });
    const pair = track(await openPair(dir, 'k1-wake-prev-mixed', { entry: flatEntry(dir, '90.1.0'), pollMs: 60_000 }));
    ok(await answer(pair) === '90.0.0' && pair.state()?.active?.source === 'rollback',
      'K1-PREV: a .prev whose manifest verifies — worker and sibling module — is booted');
    await waitFor(async () => pair.state()?.status === 'hibernated', 20000);
    mixPrev(path.join(dir, '.prev'));
    const bootCount = boots(audit).length;
    const woken = await answer(pair);
    ok(/KLYPIX core files do not verify/.test(woken) && boots(audit).length === bootCount,
      `K1-PREV: a pair running from .prev does not wake from it once it stops verifying (${woken.slice(0, 140)})`);
  });

  // The FIRST receipt such a boot writes already names the integrity error. A
  // raw host sends `initialize` and nothing else, and the receipt is read the
  // moment that is answered: without notifications/initialized the
  // post-handshake update check never runs, and the poll is pinned at 60 s, so
  // only the boot can have recorded the error.
  const firstReceiptAfterBoot = async (name, { prev }) => {
    const dir = runtimeDir(name);
    install(dir, '90.0.0', { identity: true });
    install(dir, '90.1.0', { identity: true, commit: false });
    if (!prev) fs.rmSync(path.join(dir, '.prev'), { recursive: true, force: true });
    const stateDir = path.join(dir, 'states');
    fs.mkdirSync(stateDir, { recursive: true });
    const child = spawn(process.execPath, [flatEntry(dir, '90.1.0')], {
      cwd: dir,
      env: {
        ...process.env,
        KLYPIX_MCP_RUNTIME_MANIFEST: manifestOf(dir),
        KLYPIX_MCP_STATE_DIR: stateDir,
        KLYPIX_AUTO_UPDATE: '0',
        KLYPIX_WORKER_HIBERNATE_MS: '0',
        KLYPIX_MCP_SUPERVISOR_POLL_MS: '60000',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    try {
      const answered = new Promise((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => reject(new Error('initialize was not answered within 30 s')), 30000);
        child.stdout.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop();
          for (const line of lines) {
            let message = null;
            try { message = JSON.parse(line); } catch { continue; }
            if (message?.id === 1) { clearTimeout(timer); resolve(message); }
          }
        });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('the supervisor exited before answering initialize')); });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0.0' } } })}\n`);
      await answered;
      return stateIn(dir);
    } finally {
      try { child.stdin.end(); } catch { /* already gone */ }
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref?.(); });
      }
    }
  };
  const bootReceiptsNameTheError = async () => {
    try {
      const withPrev = await firstReceiptAfterBoot('boot-receipt-prev', { prev: true });
      const view = (s) => `${s?.status}/${s?.active?.source}/${s?.lastError}`;
      ok(withPrev?.status === 'awaiting-initialize' && withPrev.active?.source === 'rollback'
        && /integrity mismatch: worker\.mjs/.test(withPrev.lastError || ''),
      `K1: the first receipt after booting .prev already names the integrity error (${view(withPrev)})`);
    } catch (error) {
      ok(false, `K1: the first receipt after the boot — ${error?.message || error}`);
    }
  };

  // ── K3 (2026-10-03): every auto-update poll tick is receipted as
  // autoUpdate.lastPollAt — the overdue rule's evidence that a session was there
  // to run a due check. Nothing here may contact npm: a fresh check AND a live
  // lock owned by this test process keep the schedule from being due, so the
  // poll launches no helper (one started anyway would exit throttled or busy).
  const pollIsReceipted = () => scenario('poll-receipt', async (track) => {
    const dir = runtimeDir('poll-receipt');
    install(dir, '90.0.0', { identity: true });
    const now = Date.now();
    const identity = { version: '90.0.0', managed: true, dev: false };
    const stampFile = path.join(dir, '.autoupdate-check.json');
    const lockFile = path.join(dir, '.autoupdate.lock');
    fs.writeFileSync(stampFile, JSON.stringify({ protocol: 1, lastCheck: now - 60_000, failures: 0, nextCheckAt: now + 6 * 3_600_000, identity }));
    fs.writeFileSync(path.join(dir, '.autoupdate-status.json'), JSON.stringify({
      protocol: 1, result: 'current', checkedAt: new Date(now - 60_000).toISOString(), currentVersion: '90.0.0', latestVersion: '90.0.0', identity,
    }));
    fs.writeFileSync(lockFile, JSON.stringify({ protocol: 1, token: `${process.pid}-k3-fixture`, pid: process.pid, acquiredAt: now }));
    const stampBefore = fs.readFileSync(stampFile, 'utf8');
    const lockBefore = fs.readFileSync(lockFile, 'utf8');
    const started = Date.now();
    const pair = track(await openPair(dir, 'k3-poll', {
      env: { KLYPIX_AUTO_UPDATE: '', KLYPIX_MCP_AUTO_UPDATE_START_DELAY_MS: '300', KLYPIX_WORKER_HIBERNATE_MS: '0' },
    }));
    ok(await answer(pair) === '90.0.0', 'K3: a pair with automatic updates on serves its worker');
    const receipt = await waitFor(async () => { const s = pair.state(); return s?.autoUpdate?.lastPollAt ? s : null; }, 15000);
    const polledAt = Date.parse(receipt.autoUpdate.lastPollAt);
    ok(receipt.autoUpdate.enabled === true && polledAt >= started - 1000 && polledAt <= Date.now() && receipt.autoUpdate.due === false,
      `K3: the supervisor receipts its auto-update poll as autoUpdate.lastPollAt (${receipt.autoUpdate.lastPollAt})`);
    ok(fs.readFileSync(stampFile, 'utf8') === stampBefore && fs.readFileSync(lockFile, 'utf8') === lockBefore,
      'K3: that poll launched no helper here — the schedule was not due; the stamp and the lock are untouched');
  });

  await Promise.all([
    bootDuringInstallStartsPrev(),
    bootWaitsForInstallToFinish(),
    bootWithoutPrevRejectsUncheckedFiles(),
    bootDirectPackageAtOnce(),
    bootReceiptsNameTheError(),
    pollIsReceipted(),
    bootRefusesMixedPrev(),
    bootRefusesUnvouchedPrev(),
    wakeRefusesMixedPrev(),
  ]);

  // K1-PREV-UNVERIFIED — what makes .prev bootable, unit level.
  {
    const dir = runtimeDir('prev-unit');
    const prev = path.join(dir, '.prev');
    const target = () => supervisorTest.prevSnapshotTarget(path.join(dir, 'worker.mjs'));
    writePrevSnapshot(prev, '90.0.0', { audit: null });
    const whole = target();
    mixPrev(prev);
    const mixed = target();
    writePrevSnapshot(prev, '90.0.0', { audit: null });
    const manifest = JSON.parse(fs.readFileSync(manifestOf(prev), 'utf8'));
    writeAtomic(manifestOf(prev), JSON.stringify({ ...manifest, files: { 'engine.mjs': manifest.files['engine.mjs'] } }));
    const workerUnhashed = target();
    writeAtomic(manifestOf(prev), JSON.stringify({ ...manifest, version: '90.0.1' }));
    const versionDiffers = target();
    fs.rmSync(manifestOf(prev), { force: true });
    const unvouched = target();
    ok(whole?.source === 'rollback' && whole.version === '90.0.0' && samePath(whole.path, path.join(prev, 'worker.mjs'))
      && mixed === null && workerUnhashed === null && versionDiffers === null && unvouched === null,
    `K1-PREV: .prev is a target only while its manifest verifies, hashes its worker and names the worker's version (${[whole?.version, mixed, workerUnhashed, versionDiffers, unvouched].map(String).join(' / ')})`);
  }

  // CF-2 — only a missing manifest is absent, unit level.
  {
    const dir = runtimeDir('absent-unit');
    const manifest = manifestOf(dir);
    const missing = readRuntimeTarget(manifest);
    fs.mkdirSync(manifest);
    const directory = readRuntimeTarget(manifest);
    fs.rmSync(manifest, { recursive: true, force: true });
    fs.writeFileSync(manifest, '{}');
    const realRead = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(manifest)) {
        const error = new Error('EBUSY: resource busy or locked, open'); error.code = 'EBUSY'; throw error;
      }
      return realRead.call(fs, file, ...rest);
    };
    let busy = null;
    try { busy = readRuntimeTarget(manifest); } finally { fs.readFileSync = realRead; }
    ok(missing.absent === true && !directory.absent && !directory.ok && !busy?.absent && /unreadable: EBUSY/.test(busy?.error || ''),
      'CF-2: readRuntimeTarget reports absent only for a missing file; EBUSY or a directory is an unreadable manifest');
  }

  // TQ-5 — the receipt rename retries EPERM/EBUSY/EACCES. The directory case
  // below fails every attempt and cannot tell a retry from none; on Linux CI
  // nothing holds a file open, so this is pinned with an injected rename.
  {
    const dir = runtimeDir('atomic-retry');
    const target = path.join(dir, 'receipt.json');
    const realRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (from, to) => {
      attempts++;
      if (attempts <= 2) { const error = new Error('EPERM: simulated reader hold'); error.code = 'EPERM'; throw error; }
      return realRename.call(fs, from, to);
    };
    let threw = null;
    try { supervisorTest.atomicJson(target, { committed: true }); }
    catch (error) { threw = error; }
    finally { fs.renameSync = realRename; }
    ok(!threw && attempts === 3 && JSON.parse(fs.readFileSync(target, 'utf8')).committed === true,
      'TQ-5: a supervisor state write outlasts a transient EPERM on its rename and commits');
    attempts = 0;
    fs.renameSync = () => { attempts++; const error = new Error('ENOENT: gone'); error.code = 'ENOENT'; throw error; };
    threw = null;
    try { supervisorTest.atomicJson(target, { committed: false }); }
    catch (error) { threw = error; }
    finally { fs.renameSync = realRename; }
    ok(threw?.code === 'ENOENT' && attempts === 1 && !fs.readdirSync(dir).some(name => name.endsWith('.tmp')),
      'TQ-5: a non-retryable rename error is rethrown at once and the tmp is removed');
  }

  // B7 — exactly which receipts a starting supervisor removes. The scenarios
  // above spawn hundreds of processes, so the dead pid is taken afresh here: one
  // from the start of the run was reused under load (2026-10-03 review round).
  {
    const deadPid = await obtainDeadPid();
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

  // K1-WAIT-FULL-REHASH — a boot or wake waiting for an install hashes the
  // runtime again only when the manifest's stat moves (installs commit it last),
  // plus once at the deadline. It used to re-hash every file every 250 ms.
  {
    let key = 'manifest-0';
    let lastRead = null;
    let reads = 0;
    let verifiesAt = null;
    const watch = {
      statKey: () => key,
      lastReadKey: () => lastRead,
      read: () => {
        reads++;
        lastRead = key;
        return key === verifiesAt
          ? { ok: true, target: { version: '90.1.0' } }
          : { ok: false, error: 'runtime integrity mismatch: worker.mjs' };
      },
    };
    const stuck = await supervisorTest.settleRuntime(watch, { waitMs: 600, pollMs: 20 });
    ok(!stuck.ok && reads === 2,
      `K1-WAIT: a manifest that never moves is hashed once at the start and once at the deadline, not on every poll (${reads} full reads in 600 ms at a 20 ms poll)`);
    reads = 0;
    verifiesAt = 'manifest-1';
    setTimeout(() => { key = 'manifest-1'; }, 150);   // the installer commits its manifest
    const started = Date.now();
    const settled = await supervisorTest.settleRuntime(watch, { waitMs: 5000, pollMs: 20 });
    const waited = Date.now() - started;
    ok(settled.ok && reads === 2 && waited < 1500,
      `K1-WAIT: a manifest commit inside the wait is read at once and ends it (${reads} full reads, ${waited} ms)`);
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
