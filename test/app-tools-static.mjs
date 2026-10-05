// app-tools-static — the tool list is STATIC (agent tool parity P1).
//
// A host learns the tools once, at connect time (and on list_changed after a
// hot-swap). So whether the KLYPIX app is running, has access on, or is absent
// must never change tools/list — only show_in_klypix's platform gating does
// (registered where a KLYPIX app can run: Windows, or KLYPIX_APP_TOOLS=on).
// And starting the server must not touch the app at all (Codex gives an MCP
// server 10 s to start): the fake app records zero connections.
//
// Also: the supervisor's own compatibility check accepts this worker over the
// published 1.92.0 tool list (show_in_klypix is the only addition), and
// show_in_klypix's new schema is what BRIDGE-PROTOCOL.md specifies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolCompatibility } from '../src/mcp-supervisor.mjs';
import { startFakeApp, fakeStatus } from './_fake-app-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kats-'));
const home = path.join(tmp, 'home');
const vault = path.join(tmp, 'vault');
const bridge = path.join(tmp, 'bridge');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(vault, { recursive: true });

async function listTools(bin, { appTools } = {}) {
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_VAULT: vault,
    KLYPIX_APP_BRIDGE_DIR: bridge, KLYPIX_BRAIN_DIR: path.join(tmp, 'brain-dir'),
  };
  delete env.KLYPIX_BRAIN;
  delete env.KLYPIX_PLUGIN;
  if (appTools) env.KLYPIX_APP_TOOLS = 'on'; else delete env.KLYPIX_APP_TOOLS;
  const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', bin), '--vault', vault], cwd: vault, env, stderr: 'pipe' }));
  try { return (await client.listTools()).tools; } finally { await client.close(); }
}
const canon = (tools) => JSON.stringify(tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })));

// KLYPIX absent.
const downWorker = await listTools('klypix-worker.mjs', { appTools: true });
// KLYPIX running with access on (a live fake bridge).
const app = await startFakeApp({ dir: bridge, handlers: { status: async (_p, ctx) => fakeStatus(ctx) } });
const upWorker = await listTools('klypix-worker.mjs', { appTools: true });
const upSupervisor = await listTools('klypix-mcp.mjs', { appTools: true });
ok(canon(downWorker) === canon(upWorker), `tools/list is identical with KLYPIX running or not (${upWorker.length} tools)`);
ok(canon(upSupervisor) === canon(upWorker), 'the supervisor serves the same list as the worker');
ok(app.log.connections === 0, `starting the server never contacts KLYPIX (connections: ${app.log.connections})`);
// Access off changes nothing either.
await app.setAccess(false);
const offWorker = await listTools('klypix-worker.mjs', { appTools: true });
ok(canon(offWorker) === canon(upWorker), 'tools/list is identical with AI tools turned off in KLYPIX');
await app.close();

// Platform gating is the ONLY difference.
const plain = await listTools('klypix-worker.mjs', { appTools: false });
const here = process.platform === 'win32';
ok(upWorker.some(t => t.name === 'show_in_klypix'), 'KLYPIX_APP_TOOLS=on registers show_in_klypix on any system');
ok(plain.some(t => t.name === 'show_in_klypix') === here, `without it, show_in_klypix is registered only on Windows (${here ? 'here: yes' : 'here: no'})`);
ok(canon(plain.filter(t => t.name !== 'show_in_klypix')) === canon(upWorker.filter(t => t.name !== 'show_in_klypix')), 'apart from show_in_klypix the two lists are identical');

// The supervisor accepts this worker over 1.92.0: show_in_klypix is the only addition.
const snapshot192 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-schemas-1.92.0.json'), 'utf8'));
for (const [label, list] of [['KLYPIX_APP_TOOLS=on', upWorker], [process.platform, plain]]) {
  const current = list.map(({ name, inputSchema }) => ({ name, inputSchema }));
  const v = toolCompatibility(snapshot192, current);
  const wantAdded = list.some(t => t.name === 'show_in_klypix') ? ['show_in_klypix'] : [];
  ok(v.ok === true && v.removed.length === 0 && v.changed.length === 0 && JSON.stringify(v.added) === JSON.stringify(wantAdded),
    `[${label}] the supervisor's compatibility check accepts 1.92.0 → this worker (added: ${v.added.join(', ') || 'none'})`);
  const byName = new Map(list.map(t => [t.name, t]));
  const drifted = snapshot192.filter(t => JSON.stringify(byName.get(t.name)?.inputSchema) !== JSON.stringify(t.inputSchema)).map(t => t.name);
  ok(drifted.length === 0, `[${label}] every 1.92.0 input schema is byte-identical (drifted: ${drifted.join(', ') || 'none'})`);
}

// show_in_klypix's schema.
{
  const show = upWorker.find(t => t.name === 'show_in_klypix');
  const p = show?.inputSchema?.properties || {};
  ok(JSON.stringify(show?.inputSchema?.required) === '["canvas"]' && p.canvas?.type === 'string'
    && p.card_ids?.type === 'array' && p.card_ids?.maxItems === 50 && p.banner?.type === 'string' && p.banner?.maxLength === 120
    && p.bring_to_front?.type === 'boolean' && Object.keys(p).length === 4,
  'show_in_klypix: { canvas, card_ids? (≤ 50), banner? (≤ 120), bring_to_front? }');
  ok(show?.annotations?.readOnlyHint === false && show?.annotations?.destructiveHint === false && show?.annotations?.openWorldHint === false,
    'show_in_klypix: not read-only (it moves the person\'s view), never destructive, closed-world');
  ok(/never brings its window to the front/.test(show?.description || ''), 'its description says KLYPIX never comes to the front for an AI tool');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ app-tools-static: all assertions passed');
process.exit(failures ? 1 : 0);
