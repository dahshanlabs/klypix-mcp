#!/usr/bin/env node
// klypix-mcp-server — a Model Context Protocol server that gives any MCP client
// (Claude Desktop, Claude Code, "cowork", …) full READ + WRITE access to your
// .klypix canvas library. It turns the one-off read-klypix / write-klypix
// skills into a standing, tool-based connection: an outside agent can list your
// canvases, read one (cards + connection graph + [[links]] + #tags), search
// across all of them, create a new board, or add cards to an existing one.
//
// It operates on the .klypix FILES in a "vault" folder — no need for the KLYPIX
// desktop app to be running, and nothing here can corrupt a live canvas.
//
// Run (stdio):   node bin/klypix-mcp.mjs --vault "C:\\path\\to\\canvases"
//   or set env:  KLYPIX_VAULT=...   (default: ~/Documents)
//
// All vault logic lives in ../src/klypix-core.mjs — this file is the thin MCP
// FACE over that engine (the A2A face, bin/klypix-a2a.mjs, shares the same core).

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  resolveVault, getEmbedder, buildKlypixMap, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opBrainReconcile, opCreateCanvas, opAddToCanvas,
} from '../src/klypix-core.mjs';

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

// `npx klypix-mcp init` — 60-second onboarding: seed a starter project brain in
// the current folder so a new user's FIRST contact isn't an empty vault, then
// print a paste-ready MCP config. Runs before any server setup.
if (process.argv[2] === 'init') {
  const target = path.resolve(process.cwd(), 'brain.klypix');
  if (fs.existsSync(target)) { console.error(`brain.klypix already exists in ${process.cwd()} — not overwriting.`); process.exit(0); }
  const buf = await buildKlypixMap({
    title: 'project brain',
    areas: [
      { title: 'Goal', cards: [{ text: '❓ What is this project for, and for whom?\nAgent: survey the repo on your first session and replace this with the real goal.' }] },
      { title: 'Architecture', cards: [{ text: '❓ Key components and how they fit.\nAgent: record the actual shape from the repo — only what a new session must know.' }] },
      { title: 'Decisions', cards: [{ text: 'Decisions land here automatically: agents emit `🧠 BRAIN [Area]: …` markers; a new decision that replaces an old one archives it (superseded). Resolve finished items with `✓`, correct in place with `~`. Drag any card into 📌 Focus to make it lead every session brief.' }] },
      { title: 'Pending / next', cards: [{ text: 'What is in flight and what comes next. Close finished items with the ✓ marker.' }] },
      { title: 'Open questions', cards: [{ text: 'Unresolved questions (the ❓ marker) live here — the session brief surfaces them first.' }] },
      { title: '📌 Focus', cards: [{ text: 'Drag any card into this area to make it lead every session brief — steer your agent by moving cards.' }] },
    ],
  });
  fs.writeFileSync(target, buf);
  const cfg = JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', process.cwd().replace(/\\/g, '/')] } } }, null, 2);
  console.error(`✓ Created ${target}\n\nAdd this to your MCP client config (.mcp.json / claude_desktop_config.json):\n\n${cfg}\n\nThen ask your agent to read the canvas "brain" — it now has a project memory.`);
  process.exit(0);
}

const vaultArgIdx = process.argv.indexOf('--vault');
const VAULT = resolveVault(vaultArgIdx >= 0 ? process.argv[vaultArgIdx + 1] : undefined);

// Map a protocol-neutral core result → an MCP tool result.
const toContent = (r) => {
  const content = r.blocks.map(b => b.kind === 'image'
    ? { type: 'image', data: b.data, mimeType: b.mime }
    : { type: 'text', text: b.text });
  return r.isError ? { content, isError: true } : { content };
};

const server = new McpServer({ name: 'klypix-canvas', version: '1.0.0' });

server.registerTool('list_canvases', {
  title: 'List KLYPIX canvases',
  description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
  inputSchema: {},
}, async () => toContent(await opListCanvases({ vault: VAULT })));

server.registerTool('read_canvas', {
  title: 'Read a KLYPIX canvas',
  description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND return its images so you can SEE them, not just their filenames. Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
  inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => toContent(await opReadCanvas({ vault: VAULT, canvas })));

server.registerTool('search_canvases', {
  title: 'Search inside all canvases',
  description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
  inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => toContent(await opSearchCanvases({ vault: VAULT, query })));

server.registerTool('search_all_brains', {
  title: 'Search every project brain on this machine',
  description: 'Cross-project memory search: looks through every brain.klypix this machine has worked with (auto-registered by the brain hook), not just the current vault. Semantic (on-device) + lexical hybrid ranking. Use when the answer may live in ANOTHER project\'s decisions. Optional as_of (YYYY-MM-DD) answers "what was true then" — superseded cards count as live if they were current at that date.',
  inputSchema: {
    query: z.string().describe('What to find across all project brains.'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: rank what was TRUE at that date (time-travel query).'),
  },
}, async ({ query, as_of }) => toContent(await opSearchAllBrains({ vault: VAULT, query, as_of, log })));

server.registerTool('brain_insights', {
  title: 'What matters in a brain — hubs, orphans, stale questions',
  description: 'Structural read of a brain.klypix: the most-connected "hub" cards (load-bearing decisions), orphaned decisions (no connections — maybe forgotten), stale open questions (aging & unresolved), and area sizes. Use to answer "what matters here / what am I forgetting / what should I review?" — read it at the start of a planning session, or before tidying.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    staleDays: z.number().optional().describe('Open questions older than this many days count as stale (default 21).'),
  },
}, async ({ canvas, staleDays }) => toContent(await opBrainInsights({ vault: VAULT, canvas, staleDays })));

server.registerTool('brain_connect', {
  title: 'Connect related-but-unlinked brain cards (densify the graph)',
  description: 'Finds genuinely related cards that AREN\'T linked yet and proposes connections — semantic similarity when the on-device model is installed, else shared tags + [[mentions]]. Dry-run by default (review the suggestions); pass apply:true to draw them (ADDITIVE — never deletes; the human can remove any arrow). Use after brain_insights flags many orphans, to turn a flat list into a real knowledge graph.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = suggest only; true = draw the connections.'),
    max: z.number().optional().describe('Max connections to propose/draw (default 24).'),
    threshold: z.number().optional().describe('Min semantic similarity 0–1 to link (default 0.45). Higher = fewer, tighter links.'),
  },
}, async ({ canvas, apply, max, threshold }) => toContent(await opBrainConnect({ vault: VAULT, canvas, apply, max, threshold, log })));

server.registerTool('brain_reconcile', {
  title: 'Reconcile the brain against committed migrations (find unrecorded rollouts)',
  description: 'External-state check the brain otherwise CANNOT do: a brain only knows facts someone narrated (a marker, a commit body), so a DB migration APPLIED to prod — which narrates nothing — silently never lands. This lists committed migration files (Supabase / Rails / Prisma / Knex / generic) under the project and flags any that NO brain card references, so you can confirm the rollout with one marker. It reads ONLY the filesystem — never the database, never the network — and never claims a migration was applied, only that it is unrecorded. Defaults to the migrations dir beside the project brain; pass root to point elsewhere. Run it when you want to be sure the brain reflects what actually shipped.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    root: z.string().optional().describe("Project root holding the migrations dir (default: the brain file's folder)."),
  },
}, async ({ canvas, root }) => toContent(await opBrainReconcile({ vault: VAULT, canvas, root })));

server.registerTool('create_canvas', {
  title: 'Create a KLYPIX canvas',
  description: 'Create a new .klypix canvas from cards + connections and save it to the vault. The user opens it in KLYPIX (Canvas → Open). Prefer short, titled cards (one idea each) connected by meaningful arrows.',
  inputSchema: {
    title: z.string().describe('Canvas title (also the filename).'),
    cards: z.array(cardSchema).min(1).describe('The cards. 5-12 atomic cards is ideal.'),
    connections: z.array(connSchema).optional().describe('Arrows between cards.'),
    filename: z.string().optional().describe('Override the output filename (without extension).'),
  },
}, async ({ title, cards, connections, filename }) => toContent(await opCreateCanvas({ vault: VAULT, title, cards, connections, filename })));

server.registerTool('add_to_canvas', {
  title: 'Add cards to an existing canvas',
  description: 'Append cards (and optional connections) to an existing v4 .klypix, preserving all existing items and their positions. New cards are placed to the right of the current content. Connections may reference new cards (by index/title) or existing cards (by title).',
  inputSchema: {
    canvas: z.string().describe('Canvas filename, vault-relative path, or absolute path.'),
    cards: z.array(cardSchema).min(1).describe('Cards to add.'),
    connections: z.array(connSchema).optional(),
  },
}, async ({ canvas, cards, connections }) => {
  // Provenance: stamp WHICH agent wrote these cards (from the MCP client's
  // initialize handshake — cursor / claude / cline).
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  return toContent(await opAddToCanvas({ vault: VAULT, canvas, cards, connections, via }));
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready · vault=${VAULT}`);
// Pre-warm the on-device embedder in the BACKGROUND so the first cross-project
// search of a session is already semantic, not a lexical fallback.
getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
