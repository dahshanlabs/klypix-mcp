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
// Run (stdio):   node scripts/klypix-mcp-server.mjs --vault "C:\\path\\to\\canvases"
//   or set env:  KLYPIX_VAULT=...   (default: ~/Documents)
//
// Register in Claude Code (.mcp.json) or Claude Desktop (claude_desktop_config
// .json) — see docs/KLYPIX_MCP.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown, atomicWrite } from '../src/klypix-format.mjs';

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

const vaultArgIdx = process.argv.indexOf('--vault');
const VAULT = path.resolve(
    vaultArgIdx >= 0 ? process.argv[vaultArgIdx + 1]
        : process.env.KLYPIX_VAULT || path.join(os.homedir(), 'Documents'),
);
const IS_CANVAS = /\.(klypix|any)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', '$Recycle.Bin', 'Windows']);
const MAX_FILES = 400;

function walkVault() {
    const out = [];
    const visit = (dir, depth) => {
        if (out.length >= MAX_FILES || depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= MAX_FILES) return;
            if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) visit(full, depth + 1);
            else if (e.isFile() && IS_CANVAS.test(e.name)) out.push(full);
        }
    };
    visit(VAULT, 0);
    return out;
}

// Resolve a user-supplied canvas reference: absolute path, vault-relative path,
// or a bare filename (matched against the walked list, case-insensitively).
function resolveCanvas(ref) {
    if (!ref) return null;
    if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
    const rel = path.join(VAULT, ref);
    if (fs.existsSync(rel)) return rel;
    const want = path.basename(ref).toLowerCase();
    const matches = walkVault().filter(f => path.basename(f).toLowerCase() === want
        || path.basename(f).toLowerCase() === want + '.klypix'
        || path.basename(f).toLowerCase() === want + '.any');
    return matches[0] || null;
}

function safeName(title) {
    const base = String(title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled';
    let name = base, n = 1;
    while (fs.existsSync(path.join(VAULT, `${name}.klypix`))) name = `${base} ${++n}`;
    return `${name}.klypix`;
}

const cardSchema = z.object({
    text: z.string().describe('Card text. First line is the card title.'),
    heading: z.boolean().optional().describe('Bold title card for the main goal/topic.'),
    color: z.string().optional().describe('Hex color, e.g. #ef4444 for a risk/blocker.'),
});
const connSchema = z.object({
    from: z.union([z.number(), z.string()]).describe('Source card: index (0-based), title, or id.'),
    to: z.union([z.number(), z.string()]).describe('Target card: index, title, or id.'),
    relationship: z.string().optional().describe('leads_to|depends_on|relates_to|conflicts_with|supports|questions|costs|blocks'),
    label: z.string().optional(),
});

const server = new McpServer({ name: 'klypix-canvas', version: '1.0.0' });

server.registerTool('list_canvases', {
    title: 'List KLYPIX canvases',
    description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
    inputSchema: {},
}, async () => {
    const files = walkVault();
    if (files.length === 0) {
        return { content: [{ type: 'text', text: `No .klypix/.any files found under vault: ${VAULT}\nSet --vault or KLYPIX_VAULT to your canvas folder.` }] };
    }
    const rows = [];
    for (const f of files) {
        try {
            const { struct } = await parseKlypix(fs.readFileSync(f));
            const st = fs.statSync(f);
            rows.push(`- ${path.relative(VAULT, f)} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections · ${new Date(st.mtimeMs).toISOString().slice(0, 10)}`);
        } catch {
            rows.push(`- ${path.relative(VAULT, f)} — (unreadable)`);
        }
    }
    return { content: [{ type: 'text', text: `# Canvases in ${VAULT}\n\n${rows.join('\n')}` }] };
});

server.registerTool('read_canvas', {
    title: 'Read a KLYPIX canvas',
    description: 'Read a canvas as structured markdown: every card, the connection graph, [[wikilinks]], #tags, and an asset list. Accepts a filename, vault-relative path, or absolute path.',
    inputSchema: { canvas: z.string().describe('Canvas filename, vault-relative path, or absolute path.') },
}, async ({ canvas }) => {
    const file = resolveCanvas(canvas);
    if (!file) return { content: [{ type: 'text', text: `Canvas not found: ${canvas} (vault: ${VAULT})` }], isError: true };
    try {
        const { struct } = await parseKlypix(fs.readFileSync(file));
        return { content: [{ type: 'text', text: structToMarkdown(struct) }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Failed to read ${file}: ${e.message}` }], isError: true };
    }
});

server.registerTool('search_canvases', {
    title: 'Search inside all canvases',
    description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
    inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { content: [{ type: 'text', text: 'Provide a non-empty query.' }], isError: true };
    const hits = [];
    for (const f of walkVault()) {
        let struct;
        try { ({ struct } = await parseKlypix(fs.readFileSync(f))); } catch { continue; }
        const matched = struct.cards.filter(c =>
            (c.title || '').toLowerCase().includes(q) ||
            String(c.text || '').toLowerCase().includes(q) ||
            (c.tags || []).some(t => ('#' + t).toLowerCase().includes(q)));
        if (matched.length) {
            hits.push(`## ${path.relative(VAULT, f)} — "${struct.title}"\n` +
                matched.slice(0, 6).map(c => `- ${c.title || '(card)'}: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n'));
        }
    }
    return { content: [{ type: 'text', text: hits.length ? `# Matches for "${query}"\n\n${hits.join('\n\n')}` : `No matches for "${query}" in ${VAULT}.` }] };
});

server.registerTool('create_canvas', {
    title: 'Create a KLYPIX canvas',
    description: 'Create a new .klypix canvas from cards + connections and save it to the vault. The user opens it in KLYPIX (Canvas → Open). Prefer short, titled cards (one idea each) connected by meaningful arrows.',
    inputSchema: {
        title: z.string().describe('Canvas title (also the filename).'),
        cards: z.array(cardSchema).min(1).describe('The cards. 5-12 atomic cards is ideal.'),
        connections: z.array(connSchema).optional().describe('Arrows between cards.'),
        filename: z.string().optional().describe('Override the output filename (without extension).'),
    },
}, async ({ title, cards, connections, filename }) => {
    if (!fs.existsSync(VAULT)) { try { fs.mkdirSync(VAULT, { recursive: true }); } catch { /* ignore */ } }
    try {
        const buf = await buildKlypix({ title, cards, connections });
        const name = filename ? safeName(filename.replace(IS_CANVAS, '')) : safeName(title);
        const out = path.join(VAULT, name);
        await atomicWrite(out, buf);
        return { content: [{ type: 'text', text: `Created ${out} — ${cards.length} cards, ${(connections || []).length} connections. Open it in KLYPIX (Canvas → Open).` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Create failed: ${e.message}` }], isError: true };
    }
});

server.registerTool('add_to_canvas', {
    title: 'Add cards to an existing canvas',
    description: 'Append cards (and optional connections) to an existing v4 .klypix, preserving all existing items and their positions. New cards are placed to the right of the current content. Connections may reference new cards (by index/title) or existing cards (by title).',
    inputSchema: {
        canvas: z.string().describe('Canvas filename, vault-relative path, or absolute path.'),
        cards: z.array(cardSchema).min(1).describe('Cards to add.'),
        connections: z.array(connSchema).optional(),
    },
}, async ({ canvas, cards, connections }) => {
    const file = resolveCanvas(canvas);
    if (!file) return { content: [{ type: 'text', text: `Canvas not found: ${canvas}` }], isError: true };
    try {
        const buf = await appendToKlypix(fs.readFileSync(file), { cards, connections });
        await atomicWrite(file, buf);
        return { content: [{ type: 'text', text: `Added ${cards.length} card(s) to ${path.relative(VAULT, file)}. Reopen the canvas in KLYPIX to see them.` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Add failed: ${e.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready · vault=${VAULT}`);
