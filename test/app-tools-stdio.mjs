// app-tools-stdio — the real MCP handshake for P0 agent parity, run twice: on
// the stable supervisor (bin/klypix-mcp.mjs, what every host launches) and on
// the worker it proxies (bin/klypix-worker.mjs).
//
// Through the wire, not by importing the engine: the tool list (25, the 23 old
// schemas byte-identical to the 1.91.0 snapshot), klypix_status in file mode,
// the OPEN_IN_APP refusal with a fake lease (file untouched, last line "Tell the
// user:"), and read_card_contents returning a reading KLYPIX saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildParityFixture } from './_parity-fixture.mjs';
import { pathHash, APP_BRIDGE_PROTOCOL } from '../src/app-lease.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-schemas-1.91.0.json'), 'utf8'));

for (const [label, bin] of [['supervisor', 'klypix-mcp.mjs'], ['worker', 'klypix-worker.mjs']]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `klypix-app-stdio-${label}-`));
  const home = path.join(tmp, 'home');
  const vault = path.join(tmp, 'vault');
  const bridge = path.join(tmp, 'appdata', 'agent-bridge');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bridge, { recursive: true });
  const file = await buildParityFixture(vault);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0',
    KLYPIX_VAULT: vault, KLYPIX_APP_BRIDGE_DIR: bridge,
  };
  delete env.KLYPIX_BRAIN;
  delete env.KLYPIX_APP_TOOLS;
  const client = new Client({ name: `app-tools-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', bin), '--vault', vault], cwd: vault, env, stderr: 'pipe' }));
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    ok(names.length === 25 && names.includes('klypix_status') && names.includes('read_card_contents'), `[${label}] listTools shows 25 tools, the two new ones included (got ${names.length})`);
    const byName = new Map(tools.map(t => [t.name, t]));
    const drifted = snapshot.filter(t => JSON.stringify(byName.get(t.name)?.inputSchema) !== JSON.stringify(t.inputSchema)).map(t => t.name);
    ok(drifted.length === 0, `[${label}] the 23 old input schemas equal the 1.91.0 snapshot (drifted: ${drifted.join(', ') || 'none'})`);
    ok(client.getInstructions()?.includes('comes from read_card_contents with the card ids read_canvas prints')
      && client.getInstructions()?.includes('a file name in read_canvas is never the end of what you can read')
      && client.getInstructions()?.includes('call klypix_status'), `[${label}] the server instructions point to read_card_contents (files, PDFs, photos, folders) and klypix_status`);

    const status = await client.callTool({ name: 'klypix_status', arguments: {} });
    const sc = status.structuredContent || {};
    ok(!status.isError && sc.ok === true && sc.mode === 'file' && sc.app?.running === false, `[${label}] klypix_status: ok, file mode, app not running`);
    ok(sc.server?.vault === vault.replace(/\\/g, '/') && Array.isArray(sc.features) && sc.features.some(f => f.tool === 'read_card_contents' && f.available === 'saved_readings_and_files'),
      `[${label}] klypix_status names the folder it reads and what each feature still needs`);

    // A running KLYPIX with the fixture open (this process's pid is alive).
    fs.writeFileSync(path.join(bridge, 'endpoint.json'), JSON.stringify({
      v: 1, protocol: APP_BRIDGE_PROTOCOL, pid: process.pid, appVersion: '1.3.177', startedAt: new Date().toISOString(), access: 'off', openFiles: [pathHash(file)],
    }));
    const live = (await client.callTool({ name: 'klypix_status', arguments: {} })).structuredContent || {};
    ok(live.app?.running === true && live.app?.version === '1.3.177' && live.app?.access === 'off' && live.open_canvases?.some(o => o.title === 'Parity Fixture'),
      `[${label}] with the lease, klypix_status reports KLYPIX running and names the open canvas`);
    const before = fs.readFileSync(file);
    const refused = await client.callTool({ name: 'add_to_canvas', arguments: { canvas: 'Parity Fixture', cards: [{ text: 'must not land' }] } });
    const last = refused.content[refused.content.length - 1];
    ok(refused.isError === true && refused.structuredContent?.code === 'OPEN_IN_APP' && refused.structuredContent?.ok === false, `[${label}] add_to_canvas on the open canvas: isError, code OPEN_IN_APP`);
    ok(last?.type === 'text' && last.text.startsWith('Tell the user:'), `[${label}] its last line starts "Tell the user:"`);
    ok(fs.readFileSync(file).equals(before), `[${label}] and the file is byte-identical`);

    const read = await client.callTool({ name: 'read_card_contents', arguments: { canvas: 'Parity Fixture', card_ids: ['vid_1', 'lnk_reel1'] } });
    const results = read.structuredContent?.results || [];
    ok(!read.isError && results.find(r => r.card_id === 'vid_1')?.text.includes('zebra-crossing') && results.find(r => r.card_id === 'lnk_reel1')?.status === 'partial',
      `[${label}] read_card_contents returns the readings KLYPIX saved`);
    ok(read.content[0].text.includes('[content from card vid_1 (KLYPIX reading, cloud AI'), `[${label}] the text is fenced as data`);
    const md = (await client.callTool({ name: 'read_canvas', arguments: { canvas: 'Parity Fixture' } })).content.map(c => c.text || '').join('\n');
    ok(md.includes('· id lnk_reel1') && !md.includes('SECRET-ONE'), `[${label}] read_canvas over the wire prints ids and hides the locked box`);
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ app-tools-stdio: all assertions passed');
process.exit(failures ? 1 : 0);
