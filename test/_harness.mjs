// Shared test harness: builds a deterministic fixture vault and drives the
// klypix-mcp stdio server with a real MCP client, returning normalized tool
// outputs. Used to prove the core refactor is behavior-preserving (baseline vs
// after) and to smoke the server end-to-end.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap, buildKlypix } from '../src/klypix-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');

// Volatile-field normalizer so two runs are comparable: random card/connection
// ids, ISO dates, the temp vault path, and .tmp atomic-write suffixes.
export function normalize(s, vault) {
  let out = String(s == null ? '' : s);
  if (vault) out = out.split(vault).join('<VAULT>').split(vault.replace(/\\/g, '/')).join('<VAULT>');
  out = out.replace(/\b(txt|box|img|file|code|con|card|cnt|grp|note|link)_[a-z0-9]{6,8}(_\d+)?/g, '<ID>');
  out = out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>');
  out = out.replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>');
  out = out.replace(/@\(-?\d+,-?\d+\)/g, '@(<X>,<Y>)');         // card positions
  out = out.replace(/\(-?\d+,-?\d+\)/g, '(<X>,<Y>)');
  return out;
}

export function makeVault() {
  const vault = path.join(os.tmpdir(), 'klypix-a2a-test-vault');
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(vault, { recursive: true });
  return vault;
}

export async function seedBrain(vault) {
  const buf = await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Goal', cards: [{ text: 'Ship the A2A face for KLYPIX as a portable agent-neutral memory node.' }] },
      { title: 'Architecture', cards: [{ text: 'Shared klypix-core engine; MCP and A2A are two thin protocol faces over it.' }] },
      { title: 'Open questions', cards: [{ text: '❓ Should search_all_brains be an A2A skill or MCP-only?' }] },
    ],
  });
  fs.writeFileSync(path.join(vault, 'brain.klypix'), buf);
}

export async function seedRoadmap(vault) {
  const buf = await buildKlypix({
    title: 'roadmap',
    cards: [
      { text: 'Q3 — publish A2A server', heading: true },
      { text: 'Agent card at /.well-known/agent-card.json' },
      { text: 'Return .klypix artifacts as FileParts' },
    ],
    connections: [{ from: 0, to: 1, relationship: 'leads_to' }, { from: 1, to: 2, relationship: 'leads_to' }],
  });
  fs.writeFileSync(path.join(vault, 'roadmap.klypix'), buf);
}

// Drive the server through one client session; return a map of {label: text}.
export async function driveServer(vault) {
  const client = new Client({ name: 'klypix-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--vault', vault] });
  await client.connect(transport);

  const out = {};
  const call = async (label, name, args) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const imgs = (r.content || []).filter(c => c.type === 'image').length;
      out[label] = normalize(text, vault) + (imgs ? `\n<${imgs} IMAGE BLOCK(S)>` : '') + (r.isError ? '\n<ISERROR>' : '');
    } catch (e) {
      out[label] = `<THREW> ${e.message}`;
    }
  };

  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  out['_tools'] = tools.join(', ');

  await call('list', 'list_canvases', {});
  await call('read', 'read_canvas', { canvas: 'brain' });
  await call('search', 'search_canvases', { query: 'A2A core' });
  await call('insights', 'brain_insights', { canvas: 'brain' });
  await call('create', 'create_canvas', { title: 'plan-from-test', cards: [{ text: 'Step one' }, { text: 'Step two' }], connections: [{ from: 0, to: 1 }] });
  await call('add', 'add_to_canvas', { canvas: 'roadmap', cards: [{ text: 'Added by test' }] });

  await client.close();
  return out;
}
