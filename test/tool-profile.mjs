// Tool-profile contract suite — the --minimal / KLYPIX_MCP_PROFILE=minimal
// registration surface (adopter-honesty wave, 2026-08-18).
//
// Every registered tool's schema is context the host re-sends to its model on
// every request, so the honest budget control is registration, not advice. The
// assertions that matter:
//
//   A  the DEFAULT profile registers exactly the full documented tool set —
//      this doubles as the regression lock for the README's measured tool count
//   B  KLYPIX_MCP_PROFILE=minimal registers exactly the minimal coordination/
//      recall set, nothing more (no half-registered canvas_view App resource)
//   C  --minimal on the server binary behaves identically to the env var
//      (flag parity — and it proves the supervisor passes workerArgs through)
//   D  a minimal server is not a brochure: brain_note writes and read_canvas
//      reads through the same engine, and an excluded tool fails as unknown
//   E  an unknown profile value falls back to full (never fails a boot)
//
// Hermetic: throwaway HOME so the boot heartbeat never touches the developer's
// real ~/.claude; auto-update disabled. Run: node test/tool-profile.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeVault, seedBrain } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// The two registries this suite locks. FULL_TOOLS is the complete registration
// surface of bin/klypix-worker.mjs — if a tool is added or removed, update this
// list AND the README's "What connecting costs" line in the same commit.
const FULL_TOOLS = [
  'add_to_canvas', 'brain_ask', 'brain_challenge', 'brain_connect', 'brain_doctor',
  'brain_garden', 'brain_insights', 'brain_lens', 'brain_message', 'brain_message_receipt',
  'brain_note', 'brain_reconcile', 'brain_sync', 'canvas_view', 'create_canvas',
  'list_canvases', 'project_map_context', 'project_map_drift', 'project_map_scan',
  'read_canvas', 'search_all_brains', 'search_canvases',
].sort();
const MINIMAL_TOOLS = [
  'brain_ask', 'brain_doctor', 'brain_message', 'brain_message_receipt',
  'brain_note', 'brain_sync', 'read_canvas',
].sort();

async function withServer({ vault, env = {}, extraArgs = [] }, fn) {
  const home = path.join(os.tmpdir(), 'klypix-tool-profile-home');
  try { fs.mkdirSync(home, { recursive: true }); } catch { /* exists */ }
  const client = new Client({ name: 'klypix-profile-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--vault', vault, ...extraArgs],
    env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', ...env },
  });
  await client.connect(transport);
  try { return await fn(client); }
  finally { await client.close(); }
}

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

const vault = makeVault();
await seedBrain(vault);

// ── A: default profile = the full documented set ─────────────────────────────
await withServer({ vault }, async (client) => {
  const names = await toolNames(client);
  ok(JSON.stringify(names) === JSON.stringify(FULL_TOOLS),
    `default profile registers exactly the ${FULL_TOOLS.length} documented tools (got ${names.length}: ${names.join(', ')})`);
});

// ── B: env-var minimal profile ───────────────────────────────────────────────
await withServer({ vault, env: { KLYPIX_MCP_PROFILE: 'minimal' } }, async (client) => {
  const names = await toolNames(client);
  ok(JSON.stringify(names) === JSON.stringify(MINIMAL_TOOLS),
    `KLYPIX_MCP_PROFILE=minimal registers exactly the ${MINIMAL_TOOLS.length} coordination/recall tools (got ${names.length}: ${names.join(', ')})`);

  // ── D: minimal is functional, and exclusion is real ────────────────────────
  const note = await client.callTool({ name: 'brain_note', arguments: { text: 'Profile test decision: minimal mode still captures.', area: 'Goal' } });
  const noteText = (note.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  ok(note.isError !== true && /captur|added|card|brain/i.test(noteText),
    'minimal: brain_note still writes through the capture engine');
  const read = await client.callTool({ name: 'read_canvas', arguments: { canvas: 'brain' } });
  const readText = (read.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  ok(read.isError !== true && /Profile test decision/.test(readText),
    'minimal: read_canvas reads back what brain_note just wrote');
  let excluded = null;
  try { excluded = await client.callTool({ name: 'brain_insights', arguments: {} }); } catch (e) { excluded = { threw: e.message }; }
  ok(Boolean(excluded?.threw) || excluded?.isError === true,
    'minimal: an excluded tool (brain_insights) is genuinely unregistered, not hidden');
});

// ── C: --minimal flag parity (also proves supervisor workerArgs pass-through) ─
await withServer({ vault, extraArgs: ['--minimal'] }, async (client) => {
  const names = await toolNames(client);
  ok(JSON.stringify(names) === JSON.stringify(MINIMAL_TOOLS),
    '--minimal on the server binary registers the same set as the env var');
});

// ── E: unknown profile value falls back to full ──────────────────────────────
await withServer({ vault, env: { KLYPIX_MCP_PROFILE: 'tiny' } }, async (client) => {
  const names = await toolNames(client);
  ok(JSON.stringify(names) === JSON.stringify(FULL_TOOLS),
    'an unknown KLYPIX_MCP_PROFILE value degrades to the full profile, never a broken boot');
});

console.log(failures
  ? `\n✗ ${failures} tool-profile assertion(s) failed`
  : '\n✓ tool-profile: all assertions passed');
process.exit(failures ? 1 : 0);
