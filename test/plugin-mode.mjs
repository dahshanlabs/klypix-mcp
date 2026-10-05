// plugin-mode — KLYPIX_PLUGIN=1, the switch the Claude plugin turns on when it
// launches the pinned package (`npx -y klypix-mcp@<version>`).
//
// What this proves, over real processes where it matters:
//   1. The supervisor boots the PACKAGE's worker and never adopts or hot-swaps
//      to a runtime under ~/.claude/project-brain — even one that verifies and is
//      newer (dev:true). Control: the same fixture IS adopted in normal mode, so
//      the negative is not vacuous. A hibernation wake also stays on the package.
//   2. No auto-update helper is spawned and no npm registry fetch happens
//      (injected spawn/fetch spies; normal-mode control proves the spy path).
//   3. brain_sync start → checkpoint → complete in a temp brain project leaves
//      the project directory BYTE-IDENTICAL (no AGENTS.md, .mcp.json, rules
//      files, .claude/ ship-observation files). Control: normal mode writes them.
//   4. Process-private state lands under KLYPIX_PLUGIN_DATA; shared state
//      (presence lanes) stays in ~/.claude/project-brain as documented.
//   5. A real stdio handshake against bin/klypix-mcp.mjs: 25 tools (26 with
//      show_in_klypix on Windows), the 23 old
//      input schemas byte-identical to the 1.91.0 snapshot.
//   6. Unsubstituted ${...} values are ignored (no folder of that name).
//   7. No semantic runtime is loaded; `init` and brain_doctor do not advise
//      .mcp.json entries or installs.
//
// Every process runs in a throwaway HOME / USERPROFILE / KLYPIX_BRAIN_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  autoUpdateEnabled, isPluginMode, machineStateDir, pluginDataDir, pluginShipObsPaths,
  reconcileRegisteredProjects, runAutoUpdateCheck, scrubUnexpandedEnv, spawnAutoUpdateHelper,
} from '../src/mcp-auto-update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'klypix-mcp.mjs');
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version;
const NL = String.fromCharCode(10);
const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'tool-schemas-1.91.0.json'), 'utf8'));

let failures = 0;
let passes = 0;
const ok = (cond, label) => {
  if (cond) { passes++; console.log(`✓ ${label}`); } else { failures++; console.log(`✗ ${label}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const slash = (p) => String(p).split(path.sep).join('/');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-plugin-mode-'));

// Recursive {relativePath: sha256 | '<dir>'} of a directory.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = slash(path.relative(dir, full));
      if (e.isDirectory()) { out[`${rel}/`] = '<dir>'; walk(full); }
      else out[rel] = sha(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}
const sameTree = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function sandbox(name) {
  const base = path.join(TMP, name);
  const home = path.join(base, 'home');
  const brainDir = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(home, { recursive: true });
  return { base, home, brainDir };
}

function baseEnv(box, extra = {}) {
  const env = {
    ...process.env,
    HOME: box.home,
    USERPROFILE: box.home,
    KLYPIX_BRAIN_DIR: box.brainDir,
    KLYPIX_APP_BRIDGE_DIR: path.join(box.base, 'appdata', 'agent-bridge'),
    ...extra,
  };
  for (const key of ['KLYPIX_PLUGIN', 'KLYPIX_PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'KLYPIX_AUTO_UPDATE', 'KLYPIX_MCP_RUNTIME_MANIFEST', 'KLYPIX_MCP_STATE_DIR', 'KLYPIX_BRAIN', 'KLYPIX_SESSION_ID', 'KLYPIX_APP_TOOLS']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

// A runtime in ~/.claude/project-brain that verifies and is newer than the
// package: exactly what normal mode adopts at boot and hot-swaps to.
function stubRuntime(brainDir, version, auditFile) {
  fs.mkdirSync(brainDir, { recursive: true });
  const worker = path.join(brainDir, 'klypix-mcp-worker.mjs');
  const lines = [
    "import fs from 'fs';",
    "import readline from 'readline';",
    `const VERSION = ${JSON.stringify(version)};`,
    `fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ pid: process.pid, version: VERSION }) + String.fromCharCode(10));`,
    "const send = (v) => process.stdout.write(JSON.stringify(v) + String.fromCharCode(10));",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', (line) => {",
    "  let msg; try { msg = JSON.parse(line); } catch { return; }",
    "  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'stub-adopted', version: VERSION }, instructions: 'stub' } });",
    "  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'stub_only', description: 'stub', inputSchema: { type: 'object', properties: {} } }] } });",
    "  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'stub ' + VERSION }] } });",
    "  if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });",
    "});",
  ];
  fs.writeFileSync(worker, lines.join(NL) + NL);
  fs.writeFileSync(path.join(brainDir, '.mcp-runtime.json'), JSON.stringify({
    protocol: 1,
    version,
    worker: 'klypix-mcp-worker.mjs',
    files: { 'klypix-mcp-worker.mjs': sha(fs.readFileSync(worker)) },
    dev: true,
  }, null, 2));
}

async function connect(env, { cwd, args = [] } = {}) {
  const client = new Client({ name: 'plugin-mode-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], cwd, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += String(d); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(NL);
const auditRows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(NL).filter(Boolean) : []);
const readStates = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))
      .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};

async function seedProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = await buildKlypixMap({
    title: 'project brain',
    kind: 'brain',
    areas: [
      { title: 'Goal', cards: [{ text: 'Plugin-mode fixture: a brain the test syncs against.' }] },
      { title: 'Decisions', cards: [{ text: 'Plugin mode never writes project config files.' }] },
    ],
  });
  fs.writeFileSync(path.join(dir, 'brain.klypix'), buf);
  // A version signal, so ship observation has something to baseline.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
}

try {
  // ── 0. Helpers: the switch, the data folder, ${...} scrubbing ──────────────
  ok(isPluginMode({ KLYPIX_PLUGIN: '1' }) && !isPluginMode({}) && !isPluginMode({ KLYPIX_PLUGIN: 'true' }) && !isPluginMode({ CLAUDE_PLUGIN_ROOT: '/x' }),
    'isPluginMode: only KLYPIX_PLUGIN=1 turns it on (CLAUDE_PLUGIN_ROOT alone does not)');
  ok(autoUpdateEnabled({ KLYPIX_PLUGIN: '1', KLYPIX_AUTO_UPDATE: '1' }) === false && autoUpdateEnabled({}) === true,
    'autoUpdateEnabled is false in plugin mode whatever KLYPIX_AUTO_UPDATE says, true by default otherwise');
  const dataDir = path.join(TMP, 'unit-data');
  ok(pluginDataDir({ KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: dataDir }) === path.resolve(dataDir)
    && pluginDataDir({ KLYPIX_PLUGIN_DATA: dataDir }) === null
    && pluginDataDir({ KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' }) === null,
  'pluginDataDir: honoured only in plugin mode, never an unsubstituted ${...}');
  ok(pluginDataDir({ KLYPIX_PLUGIN: '1', CLAUDE_PLUGIN_DATA: dataDir }) === path.resolve(dataDir)
    && pluginDataDir({ KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', CLAUDE_PLUGIN_DATA: dataDir }) === path.resolve(dataDir)
    && pluginDataDir({ CLAUDE_PLUGIN_DATA: dataDir }) === null,
  'pluginDataDir falls back to CLAUDE_PLUGIN_DATA (Claude Code exports it to plugin MCP servers), still only in plugin mode');
  ok(machineStateDir({ env: { KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: dataDir }, home: '/h' }) === path.resolve(dataDir)
    && machineStateDir({ env: { KLYPIX_PLUGIN: '1' }, home: path.resolve('/h') }) === path.join(path.resolve('/h'), '.claude', 'project-brain'),
  'machineStateDir: the plugin data folder when set, else ~/.claude/project-brain');
  const scrubEnv = { KLYPIX_VAULT: '${CLAUDE_PROJECT_DIR}', KLYPIX_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', OTHER: '${KEEP}' };
  const dropped = scrubUnexpandedEnv(scrubEnv);
  ok(dropped.length === 2 && !('KLYPIX_VAULT' in scrubEnv) && !('KLYPIX_PLUGIN_DATA' in scrubEnv) && scrubEnv.OTHER === '${KEEP}',
    'scrubUnexpandedEnv drops KLYPIX_VAULT / KLYPIX_PLUGIN_DATA holding ${...} and touches nothing else');
  const shipPaths = pluginShipObsPaths(path.join(TMP, 'some-project'), { env: { KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: dataDir } });
  ok(shipPaths.state.startsWith(path.join(path.resolve(dataDir), 'ship-observations')) && !shipPaths.state.includes(`${path.sep}.claude${path.sep}brain-ship`),
    'plugin ship-observation baselines live under the data folder, not <project>/.claude');

  // ── 2. No helper spawn, no registry fetch (injected spies) ─────────────────
  {
    const box = sandbox('helper');
    let spawned = 0;
    const spy = () => { spawned++; return { on() {}, unref() {} }; };
    const child = spawnAutoUpdateHelper({ brainDir: box.brainDir, currentVersion: PKG_VERSION, env: { KLYPIX_PLUGIN: '1' }, spawnProcess: spy });
    ok(child === null && spawned === 0, 'spawnAutoUpdateHelper launches nothing in plugin mode');
    const control = spawnAutoUpdateHelper({ brainDir: box.brainDir, currentVersion: PKG_VERSION, env: {}, spawnProcess: spy });
    ok(control !== null && spawned === 1, 'control: the same call in normal mode does launch the helper (the spy path is live)');
    let fetched = 0;
    const prior = process.env.KLYPIX_PLUGIN;
    process.env.KLYPIX_PLUGIN = '1';
    let res;
    try {
      res = await runAutoUpdateCheck({ brainDir: box.brainDir, currentVersion: PKG_VERSION, force: true, fetchLatest: async () => { fetched++; return PKG_VERSION; } });
    } finally {
      if (prior === undefined) delete process.env.KLYPIX_PLUGIN; else process.env.KLYPIX_PLUGIN = prior;
    }
    ok(res?.result === 'disabled' && fetched === 0, 'runAutoUpdateCheck in plugin mode returns "disabled" without a registry request, even forced');
    const harness = await reconcileRegisteredProjects({ brainDir: box.brainDir, brainPaths: [path.join(TMP, 'x', 'brain.klypix')], env: { KLYPIX_PLUGIN: '1' } });
    ok(harness.pluginMode === true && harness.checked === 0, 'reconcileRegisteredProjects refuses in plugin mode (defence in depth)');
  }

  // ── 7a. No semantic runtime in plugin mode ─────────────────────────────────
  {
    const prior = { p: process.env.KLYPIX_PLUGIN, w: process.env.KLYPIX_SEMANTIC_PREWARM };
    process.env.KLYPIX_PLUGIN = '1';
    process.env.KLYPIX_SEMANTIC_PREWARM = '1';
    try {
      const sem = await import('../src/semantic-memory.mjs');
      const pipe = await sem.getEmbedder();
      const reranker = await sem.getReranker();
      ok(pipe === null && reranker === null, 'semantic: no embedder and no reranker are loaded in plugin mode');
      ok(sem.semanticRuntimeInstalled() === false && sem.shouldPrewarmSemantic() === false, 'semantic: runtime reported absent and never pre-warmed, even with KLYPIX_SEMANTIC_PREWARM=1');
      ok(/plugin mode/.test(sem.semanticFallbackNotice(false) || ''), 'semantic: the lexical-fallback notice names plugin mode');
    } finally {
      if (prior.p === undefined) delete process.env.KLYPIX_PLUGIN; else process.env.KLYPIX_PLUGIN = prior.p;
      if (prior.w === undefined) delete process.env.KLYPIX_SEMANTIC_PREWARM; else process.env.KLYPIX_SEMANTIC_PREWARM = prior.w;
    }
  }

  // ── 1. Supervisor: package worker only, never the managed runtime ──────────
  {
    // Control first: normal mode adopts the verifying, newer runtime.
    const box = sandbox('adopt-control');
    const audit = path.join(box.base, 'stub-boots.jsonl');
    stubRuntime(box.brainDir, '99.0.0', audit);
    const vault = path.join(box.base, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const { client } = await connect(baseEnv(box, { KLYPIX_AUTO_UPDATE: '0', KLYPIX_VAULT: vault }), { cwd: vault });
    try {
      ok(client.getServerVersion()?.name === 'stub-adopted' && auditRows(audit).length >= 1,
        'control: normal mode boots the ~/.claude/project-brain runtime (v99 dev) — the fixture is adoptable');
    } finally { await client.close(); }
  }
  {
    const box = sandbox('plugin-boot');
    const audit = path.join(box.base, 'stub-boots.jsonl');
    stubRuntime(box.brainDir, '99.0.0', audit);
    const data = path.join(box.base, 'plugin-data');
    const vault = path.join(box.base, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const env = baseEnv(box, {
      KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: data, KLYPIX_VAULT: vault,
      KLYPIX_AUTO_UPDATE: '1',                         // must be overridden by plugin mode
      KLYPIX_MCP_SUPERVISOR_POLL_MS: '50',             // a poller, if armed, would swap within ms
      KLYPIX_MCP_AUTO_UPDATE_START_DELAY_MS: '0',      // a scheduler, if armed, would fire at once
      KLYPIX_WORKER_HIBERNATE_MS: '4000',              // exercise a wake as well
    });
    const { client, stderr } = await connect(env, { cwd: vault });
    try {
      const info = client.getServerVersion();
      ok(info?.name === 'klypix-canvas' && info?.version === PKG_VERSION, `plugin mode boots the package's own worker (serverInfo klypix-canvas v${info?.version})`);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const drifted = snapshot.filter((t) => JSON.stringify(byName.get(t.name)?.inputSchema) !== JSON.stringify(t.inputSchema)).map((t) => t.name);
      // show_in_klypix (P1) is app-only: Windows here (KLYPIX_APP_TOOLS is cleared by baseEnv).
      const expectedTools = process.platform === 'win32' ? 26 : 25;
      ok(tools.length === expectedTools && drifted.length === 0 && !byName.has('stub_only'),
        `stdio handshake on bin/klypix-mcp.mjs: ${expectedTools} tools, the 23 old schemas equal the 1.91.0 snapshot (drifted: ${drifted.join(', ') || 'none'})`);
      // A newer install lands while the session is open.
      stubRuntime(box.brainDir, '100.0.0', audit);
      await sleep(1200);
      const states = readStates(path.join(data, '.supervisors'));
      const me = states[0];
      ok(states.length === 1 && me?.pluginMode === true && me?.active?.source === 'package'
        && slash(me?.active?.path || '').endsWith('bin/klypix-worker.mjs') && (me?.hotReloads || 0) === 0,
      'the supervisor receipt (under KLYPIX_PLUGIN_DATA/.supervisors) shows the package worker, plugin mode, zero hot-swaps');
      ok(me?.autoUpdate?.enabled === false, 'the receipt records automatic updates off');
      ok(auditRows(audit).length === 0, 'the ~/.claude/project-brain runtime was never started — not at boot, not after a newer install landed');
      // Idle past the hibernation threshold, then wake on a request.
      await sleep(8000);
      const slept = readStates(path.join(data, '.supervisors'))[0];
      const status = await client.callTool({ name: 'klypix_status', arguments: {} });
      await sleep(300);
      const woke = readStates(path.join(data, '.supervisors'))[0];
      ok(slept?.status === 'hibernated' && !status.isError && woke?.active?.source === 'package' && auditRows(audit).length === 0,
        `a hibernation wake resumes the package worker, not the managed runtime (slept: ${slept?.status}, woke: ${woke?.active?.source})`);
      ok(/plugin mode/.test(stderr()), 'the worker logs that it runs in plugin mode');
      const pb = box.brainDir;
      const updateFiles = ['.autoupdate-check.json', '.autoupdate-status.json', '.autoupdate.lock']
        .filter((f) => fs.existsSync(path.join(pb, f)) || fs.existsSync(path.join(data, f)));
      ok(updateFiles.length === 0, `no auto-update stamp, status or lock was written anywhere (found: ${updateFiles.join(', ') || 'none'})`);
    } finally { await client.close(); }
  }

  // ── 3 + 4. brain_sync never writes the project; state goes to the data dir ─
  async function syncRun(box, env, project) {
    const { client } = await connect(env, { cwd: project, args: ['--vault', project] });
    try {
      const start = await client.callTool({ name: 'brain_sync', arguments: { project, intent: 'plugin-mode byte-identity check', files: ['src/a.mjs'], phase: 'start' } });
      await client.callTool({ name: 'brain_sync', arguments: { project, phase: 'checkpoint', include_context: false } });
      await client.callTool({ name: 'read_canvas', arguments: { canvas: 'brain' } });
      await client.callTool({ name: 'search_all_brains', arguments: { query: 'plugin mode config' } });
      const doctor = await client.callTool({ name: 'brain_doctor', arguments: { project } });
      const complete = await client.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
      return { start, doctor, complete };
    } finally { await client.close(); }
  }
  {
    const box = sandbox('sync-control');
    const project = path.join(box.base, 'project');
    await seedProject(project);
    const before = tree(project);
    await syncRun(box, baseEnv(box, { KLYPIX_AUTO_UPDATE: '0', KLYPIX_VAULT: project }), project);
    const after = tree(project);
    const created = Object.keys(after).filter((k) => !(k in before));
    ok(created.some((k) => /^(AGENTS\.md|\.mcp\.json|\.cursor\/|\.clinerules\/|\.windsurf\/|\.github\/|\.codex\/|\.claude\/brain-ship-obs\.json)/.test(k)),
      `control: normal-mode brain_sync start writes project files (${created.slice(0, 6).join(', ')}${created.length > 6 ? ', …' : ''})`);
  }
  {
    const box = sandbox('sync-plugin');
    const project = path.join(box.base, 'project');
    const data = path.join(box.base, 'plugin-data');
    await seedProject(project);
    const before = tree(project);
    const env = baseEnv(box, { KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: data, KLYPIX_VAULT: project });
    const { start, doctor, complete } = await syncRun(box, env, project);
    const after = tree(project);
    ok(!start.isError && start.structuredContent?.brain, `plugin mode: brain_sync start coordinates normally (brain ${start.structuredContent?.brain ? 'found' : 'missing'})`);
    ok(!complete.isError, 'plugin mode: brain_sync complete succeeds');
    const created = Object.keys(after).filter((k) => !(k in before));
    const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
    ok(sameTree(before, after), `plugin mode: the project directory is byte-identical after brain_sync start/checkpoint/complete (created: ${created.join(', ') || 'none'}; changed: ${changed.join(', ') || 'none'})`);
    ok(!fs.existsSync(path.join(project, 'AGENTS.md')) && !fs.existsSync(path.join(project, '.mcp.json')) && !fs.existsSync(path.join(project, '.claude')),
      'plugin mode: no AGENTS.md, no .mcp.json, no .claude/ folder in the project');
    ok(start.structuredContent?.harness === undefined, 'plugin mode: brain_sync reports no harness pass');
    // State: process-private under KLYPIX_PLUGIN_DATA.
    const dataTree = tree(data);
    ok(fs.existsSync(path.join(data, 'registry.json')) && JSON.parse(fs.readFileSync(path.join(data, 'registry.json'), 'utf8')).brains?.some((b) => slash(b.path).toLowerCase() === slash(path.join(project, 'brain.klypix')).toLowerCase()),
      'plugin mode: the project registry is written under KLYPIX_PLUGIN_DATA');
    ok(Object.keys(dataTree).some((k) => k.startsWith('.supervisors/')), 'plugin mode: supervisor receipts live under KLYPIX_PLUGIN_DATA/.supervisors');
    ok(Object.keys(dataTree).some((k) => /^ship-observations\/[0-9a-f]+\.json$/.test(k)), 'plugin mode: the ship-observation baseline lives under KLYPIX_PLUGIN_DATA/ship-observations');
    const pbTree = tree(box.brainDir);
    const pbTop = [...new Set(Object.keys(pbTree).map((k) => k.split('/')[0] + (k.includes('/') ? '/' : '')))].sort();
    const forbidden = ['registry.json', '.running-servers.json', '.supervisors/', '.mcp-runtime.json', '.autoupdate-check.json', '.autoupdate-status.json', 'ship-observations/']
      .filter((k) => pbTop.includes(k));
    ok(forbidden.length === 0, `plugin mode: no process-private state in ~/.claude/project-brain (forbidden found: ${forbidden.join(', ') || 'none'})`);
    // Shared on purpose (presence lanes): documented in the README.
    ok(pbTop.includes('sessions/'), 'plugin mode: presence lanes stay in the shared ~/.claude/project-brain/sessions (cross-session coordination)');
    console.log(`  · ~/.claude/project-brain after a plugin session: ${pbTop.join(' ') || '(empty)'}`);
    console.log(`  · KLYPIX_PLUGIN_DATA after a plugin session: ${[...new Set(Object.keys(dataTree).map((k) => k.split('/')[0] + (k.includes('/') ? '/' : '')))].sort().join(' ')}`);
    // brain_doctor: no install advice in plugin mode.
    const dtext = textOf(doctor);
    ok(dtext.startsWith('PLUGIN MODE') && doctor.structuredContent?.pluginMode?.enabled === true
      && !(doctor.structuredContent?.actions || []).some((a) => /klypix-mcp(@\S+)?\s+install/.test(a)),
    'plugin mode: brain_doctor says so first and withholds install/link actions');
  }

  // ── 3b. A brain write in plugin mode: what it touches, pinned ──────────────
  // The brain itself changes (that is the tool's job) and the cross-process
  // write lock is taken in <project>/.claude/brain-capture.lock — shared with
  // the KLYPIX app and every other session, so it cannot move. Nothing else in
  // the project may appear. Restore points go to the shared history folder.
  {
    const box = sandbox('note-plugin');
    const project = path.join(box.base, 'project');
    const data = path.join(box.base, 'plugin-data');
    await seedProject(project);
    const before = tree(project);
    const env = baseEnv(box, { KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: data, KLYPIX_VAULT: project });
    const { client } = await connect(env, { cwd: project, args: ['--vault', project] });
    let note;
    try {
      await client.callTool({ name: 'brain_sync', arguments: { project, intent: 'plugin-mode brain write check', files: [], phase: 'start' } });
      note = await client.callTool({ name: 'brain_note', arguments: { text: 'Plugin mode keeps project config files untouched.', area: 'Decisions' } });
      await client.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    } finally { await client.close(); }
    const after = tree(project);
    const created = Object.keys(after).filter((k) => !(k in before));
    const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
    ok(!note?.isError, `plugin mode: brain_note writes the brain (${note?.isError ? textOf(note).slice(0, 160) : 'ok'})`);
    ok(changed.length === 1 && changed[0] === 'brain.klypix', `plugin mode: the only changed project file is brain.klypix (changed: ${changed.join(', ') || 'none'})`);
    ok(created.every((k) => k === '.claude/' || k === '.claude/brain-capture.lock'),
      `plugin mode: a brain write adds nothing to the project but the write lock's .claude/ folder (created: ${created.join(', ') || 'none'})`);
    const pbTop = [...new Set(Object.keys(tree(box.brainDir)).map((k) => k.split('/')[0] + (k.includes('/') ? '/' : '')))].sort();
    console.log(`  · project after a plugin brain write: created ${created.join(' ') || '(nothing)'}; changed ${changed.join(' ')}`);
    console.log(`  · ~/.claude/project-brain after a plugin brain write: ${pbTop.join(' ') || '(empty)'}`);
  }

  // ── 6. Unsubstituted ${...} is never a path ────────────────────────────────
  {
    const box = sandbox('unexpanded');
    const cwd = path.join(box.base, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const env = baseEnv(box, { KLYPIX_PLUGIN: '1', KLYPIX_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', KLYPIX_VAULT: '${CLAUDE_PROJECT_DIR}' });
    const { client, stderr } = await connect(env, { cwd });
    try {
      const status = await client.callTool({ name: 'klypix_status', arguments: {} });
      await sleep(300);
      const vaultSeen = status.structuredContent?.server?.vault || '';
      ok(!vaultSeen.includes('${'), `an unsubstituted KLYPIX_VAULT is ignored (vault: ${vaultSeen})`);
      ok(/unsubstituted/.test(stderr()), 'the server logs that it ignored the placeholder');
    } finally { await client.close(); }
    const strays = [cwd, box.home, box.base].flatMap((d) => Object.keys(tree(d))).filter((k) => k.includes('${'));
    ok(strays.length === 0, `no file or folder named after a \${...} placeholder was created (found: ${strays.join(', ') || 'none'})`);
    ok(readStates(path.join(box.brainDir, '.supervisors')).length >= 0 && fs.existsSync(path.join(box.brainDir, '.supervisors')),
      'with KLYPIX_PLUGIN_DATA unusable, process-private state falls back to ~/.claude/project-brain');
  }

  // ── 7b. init in plugin mode does not advise an .mcp.json entry ─────────────
  {
    const box = sandbox('init');
    const cwd = path.join(box.base, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const plugin = spawnSync(process.execPath, [BIN, 'init'], { cwd, env: baseEnv(box, { KLYPIX_PLUGIN: '1' }), encoding: 'utf8', timeout: 60_000 });
    ok(plugin.status === 0 && fs.existsSync(path.join(cwd, 'brain.klypix')) && !/\.mcp\.json/.test(plugin.stderr) && /Claude plugin/.test(plugin.stderr),
      'init in plugin mode seeds brain.klypix and does not advise adding an .mcp.json entry');
    const cwd2 = path.join(box.base, 'proj2');
    fs.mkdirSync(cwd2, { recursive: true });
    const normal = spawnSync(process.execPath, [BIN, 'init'], { cwd: cwd2, env: baseEnv(box), encoding: 'utf8', timeout: 60_000 });
    ok(normal.status === 0 && /\.mcp\.json/.test(normal.stderr), 'control: init in normal mode still prints the MCP config to add');
  }
} catch (error) {
  failures++;
  console.log(`✗ plugin-mode test crashed: ${error?.stack || error}`);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold a handle briefly */ }
}

console.log(`${NL}plugin-mode: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
