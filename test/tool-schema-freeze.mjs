// tool-schema-freeze — no existing tool's input schema may change.
//
// The supervisor hot-swaps a new worker only when every tool the host already
// knows still accepts what it accepted before (src/mcp-supervisor.mjs
// toolCompatibility / schemaAcceptsPrevious). A removed tool, a removed
// property, a newly required field or any change inside a property makes it
// refuse the swap ("breaking tool manifest requires reconnect") and every host
// would need a restart. New capability arrives as NEW tools.
//
// test/fixtures/tool-schemas-1.91.0.json was generated from the untouched
// origin/master worker (the code of v1.91.0) BEFORE any P0 edit, over a real
// stdio handshake: [{ name, inputSchema }] for its 23 tools. It is never
// regenerated to make this test pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolCompatibility } from '../src/mcp-supervisor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-schemas-1.91.0.json'), 'utf8'));
ok(Array.isArray(snapshot) && snapshot.length === 23, `the 1.91.0 snapshot holds 23 tools (got ${snapshot.length})`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-schema-freeze-'));
const home = path.join(tmp, 'home');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(vault, { recursive: true });
const env = {
  ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0',
  KLYPIX_VAULT: vault, KLYPIX_APP_BRIDGE_DIR: path.join(tmp, 'bridge'),
};
delete env.KLYPIX_BRAIN;

const client = new Client({ name: 'schema-freeze', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'klypix-worker.mjs'), '--vault', vault], cwd: vault, env, stderr: 'pipe' }));
const { tools } = await client.listTools();
await client.close();
const current = tools.map(({ name, inputSchema }) => ({ name, inputSchema }));

const verdict = toolCompatibility(snapshot, current);
ok(verdict.ok === true, `the supervisor's own compatibility check accepts this worker over 1.91.0 (removed: ${verdict.removed.join(', ') || 'none'}; changed: ${verdict.changed.join(', ') || 'none'})`);
ok(verdict.added.includes('klypix_status') && verdict.added.includes('read_card_contents'), 'klypix_status and read_card_contents are the added tools');
ok(verdict.added.length === 2 && current.length === 25, `exactly two tools were added — 25 in all (got ${current.length}: +${verdict.added.join(', ')})`);
// Stricter than the supervisor: not even a description inside an old schema moved.
const byName = new Map(current.map(t => [t.name, t]));
const drifted = snapshot.filter(t => JSON.stringify(byName.get(t.name)?.inputSchema) !== JSON.stringify(t.inputSchema)).map(t => t.name);
ok(drifted.length === 0, `every one of the 23 old input schemas is byte-identical to the snapshot (drifted: ${drifted.join(', ') || 'none'})`);
const status = tools.find(t => t.name === 'klypix_status');
const reader = tools.find(t => t.name === 'read_card_contents');
ok(status?.annotations?.readOnlyHint === true && status?.annotations?.openWorldHint === false && Object.keys(status?.inputSchema?.properties || {}).length === 0,
  'klypix_status: read-only, closed-world, no input');
ok(reader?.annotations?.readOnlyHint === false && reader?.annotations?.destructiveHint === false && reader?.annotations?.openWorldHint === true
  && JSON.stringify(reader?.inputSchema?.required) === '["canvas","card_ids"]' && reader?.inputSchema?.properties?.card_ids?.maxItems === 5,
'read_card_contents: honest annotations; canvas + card_ids (1-5) required, the rest optional');

// 1.92.0 published klypix_status and read_card_contents, so from then on THEIR
// schemas are frozen too. test/fixtures/tool-schemas-1.92.0.json was generated
// from the untouched v1.92.0 worker (origin/master 4fe728f) over the same stdio
// handshake, before any later edit; it is added beside the 1.91.0 snapshot,
// never regenerated to make this pass. Later releases add tools or NEW optional
// top-level fields only.
const snapshot192 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-schemas-1.92.0.json'), 'utf8'));
ok(Array.isArray(snapshot192) && snapshot192.length === 25, `the 1.92.0 snapshot holds 25 tools (got ${snapshot192.length})`);
const verdict192 = toolCompatibility(snapshot192, current);
ok(verdict192.ok === true && verdict192.removed.length === 0 && verdict192.changed.length === 0,
  `the supervisor accepts this worker over 1.92.0 (removed: ${verdict192.removed.join(', ') || 'none'}; changed: ${verdict192.changed.join(', ') || 'none'})`);
const drifted192 = snapshot192.filter(t => JSON.stringify(byName.get(t.name)?.inputSchema) !== JSON.stringify(t.inputSchema)).map(t => t.name);
ok(drifted192.length === 0, `every 1.92.0 input schema — klypix_status and read_card_contents included — is byte-identical (drifted: ${drifted192.join(', ') || 'none'})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ tool-schema-freeze: all assertions passed');
process.exit(failures ? 1 : 0);
