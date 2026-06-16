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
import crypto from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseKlypix, buildKlypix, buildKlypixMap, appendToKlypix, structToMarkdown, brainInsights, insightsToMarkdown, addBrainConnections, proposeStructuralConnections, atomicWrite } from '../src/klypix-format.mjs';

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

// `npx klypix-mcp init` — 60-second onboarding: seed a starter project brain in
// the current folder so a new user's FIRST contact isn't an empty vault, then
// print a paste-ready MCP config. Runs before any server setup. (Dormant for
// the in-app bundled server, which always launches with --vault.)
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

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

server.registerTool('read_canvas', {
    title: 'Read a KLYPIX canvas',
    description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND return its images so you can SEE them, not just their filenames. Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
    inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => {
    const file = resolveCanvas(canvas);
    if (!file) return { content: [{ type: 'text', text: `Canvas not found: ${canvas} (vault: ${VAULT})` }], isError: true };
    try {
        const { struct, zip, assetPaths } = await parseKlypix(fs.readFileSync(file));
        const content = [{ type: 'text', text: structToMarkdown(struct) }];
        // Return image assets as actual image content so a vision-capable model
        // SEES them — the whole point of a multimodal canvas. Capped (count +
        // per-image size) so the response stays sane.
        let included = 0;
        for (const p of assetPaths) {
            if (included >= 8) break;
            if (!IMG_RE.test(p)) continue;
            try {
                const b64 = await zip.file(p).async('base64');
                if (!b64 || b64.length > 7_000_000) continue; // skip > ~5MB
                const ext = p.split('.').pop().toLowerCase();
                content.push({ type: 'image', data: b64, mimeType: IMG_MIME[ext] || 'image/png' });
                included++;
            } catch { /* skip unreadable asset */ }
        }
        if (included > 0) content.push({ type: 'text', text: `\n(${included} image${included > 1 ? 's' : ''} from this canvas are attached above — read them directly.)` });
        return { content };
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
    // Tokenize so a multi-word query ("window snap") matches a card holding ANY
    // term — the old verbatim `.includes(fullQuery)` only fired on an exact
    // contiguous substring, so most multi-word searches silently found nothing.
    // NOTE: deliberately NOT reusing the brief's scoreCardsAgainstQuery (its
    // precision sibling, now shared in src/klypix-format.mjs) — that one skips
    // containers + archived cards and applies a minScore floor, all of which
    // would hide results a recall-first finder is expected to surface.
    const terms = q.split(/\s+/).filter(Boolean);
    const hit = (s) => { const v = String(s || '').toLowerCase(); return terms.some(t => v.includes(t)); };
    const hits = [];
    for (const f of walkVault()) {
        let struct;
        try { ({ struct } = await parseKlypix(fs.readFileSync(f))); } catch { continue; }
        const rel = path.relative(VAULT, f);
        // Match the canvas TITLE + FILENAME too — not just card text — so
        // searching a canvas by its name (e.g. "SS2") actually finds it.
        const nameMatch = hit(struct.title) || hit(rel);
        const matched = struct.cards.filter(c =>
            hit(c.title) ||
            hit(c.text) ||
            (c.tags || []).some(t => hit('#' + t)));
        if (nameMatch || matched.length) {
            // Rich hits: type + id + position + tags + a longer snippet, so the
            // agent can FIND a card (and tell duplicates apart) before it WRITES.
            const head = `## ${rel} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections${nameMatch && !matched.length ? '  (name/title match)' : ''}`;
            const body = matched.slice(0, 8).map(c => {
                const pos = (c.pos && c.pos.x != null) ? ` @(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '';
                const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
                return `- [${c.type}] "${c.title || '(card)'}" (${c.id})${pos}${tags}\n    ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
            }).join('\n');
            hits.push(matched.length ? `${head}\n${body}` : head);
        }
    }
    return { content: [{ type: 'text', text: hits.length ? `# Matches for "${query}"\n\n${hits.join('\n\n')}` : `No matches for "${query}" in ${VAULT}.` }] };
});

// ── On-device semantic memory ────────────────────────────────────────────────
// Embeddings run INSIDE this long-lived server (the hook stays instant), 100%
// local: transformers.js (WASM) + a 23MB MiniLM model cached under
// ~/.claude/project-brain/hf-cache on first use. Per-brain vectors are cached
// incrementally (content-hashed per card) in ~/.claude/project-brain/embeddings/
// — brains themselves are never mutated by search. Everything degrades to
// lexical scoring gracefully: no lib, no model, no network → search still works.
const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const EMB_DIR = path.join(PB_DIR, 'embeddings');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
let embedderPromise = null;
function getEmbedder() {
    if (!embedderPromise) {
        embedderPromise = (async () => {
            // Dual-path: (1) bare specifier — npx/npm installs ship the lib;
            // (2) ~/.claude/project-brain/semantic — where KLYPIX's one-click
            // "semantic memory" install places it for the bundled server
            // (the ONNX runtimes are ~350MB unpacked, far too heavy to bundle
            // in the installer payload).
            let t;
            try { t = await import('@huggingface/transformers'); }
            catch {
                const local = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.mjs');
                t = await import(new URL('file:///' + local.replace(/\\/g, '/')).href);
            }
            t.env.cacheDir = path.join(PB_DIR, 'hf-cache');
            return await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
        })().catch(e => { log('semantic unavailable (lexical fallback):', e?.message || e); return null; });
    }
    return embedderPromise;
}
async function embedTexts(pipe, texts) {
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    const vecs = [];
    for (let i = 0; i < n; i++) vecs.push(Array.from(out.data.slice(i * d, (i + 1) * d)));
    return vecs;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
// Incremental per-brain vector cache: only new/changed cards get embedded.
async function vectorsForBrain(pipe, brainPath, cards) {
    const file = path.join(EMB_DIR, sha1(brainPath.replace(/\\/g, '/')) + '.json');
    let cache = { v: 1, cards: {} };
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
    const want = cards.filter(c => c.type !== 'container' && (c.text || '').trim());
    const missing = want.filter(c => cache.cards[c.id]?.h !== sha1(String(c.text)));
    if (missing.length) {
        const vecs = await embedTexts(pipe, missing.map(c => String(c.text).slice(0, 1500)));
        missing.forEach((c, i) => { cache.cards[c.id] = { h: sha1(String(c.text)), v: vecs[i] }; });
        const live = new Set(want.map(c => c.id));
        for (const id of Object.keys(cache.cards)) if (!live.has(id)) delete cache.cards[id];
        try { fs.mkdirSync(EMB_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* cache is best-effort */ }
    }
    const map = new Map();
    for (const c of want) { const e = cache.cards[c.id]; if (e?.v) map.set(c.id, e.v); }
    return map;
}
// Death date of an archived card (for as-of queries): the supersede/resolve stamp.
const deathDateOf = (text) => { const m = /(?:↩︎ superseded|✅) (\d{4}-\d{2}-\d{2})/.exec(String(text)); return m ? Date.parse(m[1]) : null; };

// Cross-project memory: search EVERY brain this machine has touched, not just
// this vault. The SessionStart/Stop hook registers each ./brain.klypix it runs
// against into ~/.claude/project-brain/registry.json — so simply having worked
// in a project makes its decisions findable from any other project ("what did
// I decide about auth — in ANY project?"). Hybrid ranking: on-device semantic
// similarity (when the local model is ready) blended with lexical term hits;
// as_of answers "what was true on <date>" via createdAt + supersession stamps.
server.registerTool('search_all_brains', {
    title: 'Search every project brain on this machine',
    description: 'Cross-project memory search: looks through every brain.klypix this machine has worked with (auto-registered by the brain hook), not just the current vault. Semantic (on-device) + lexical hybrid ranking. Use when the answer may live in ANOTHER project\'s decisions. Optional as_of (YYYY-MM-DD) answers "what was true then" — superseded cards count as live if they were current at that date.',
    inputSchema: {
        query: z.string().describe('What to find across all project brains.'),
        as_of: z.string().optional().describe('Optional YYYY-MM-DD: rank what was TRUE at that date (time-travel query).'),
    },
}, async ({ query, as_of }) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { content: [{ type: 'text', text: 'Provide a non-empty query.' }], isError: true };
    const reg = path.join(PB_DIR, 'registry.json');
    let brains = [];
    try { brains = (JSON.parse(fs.readFileSync(reg, 'utf8')).brains || []).filter(b => b && b.path); } catch { /* no registry yet */ }
    if (!brains.length) return { content: [{ type: 'text', text: 'No brains registered yet — the brain hook registers each project as you work in it.' }] };
    const terms = q.split(/[^\p{L}\p{N}#]+/u).filter(t => t.length >= 3);
    if (!terms.length) return { content: [{ type: 'text', text: 'Query too short — use words of 3+ characters.' }], isError: true };
    const asOfTs = as_of ? Date.parse(as_of) : null;
    if (as_of && Number.isNaN(asOfTs)) return { content: [{ type: 'text', text: `Bad as_of date: "${as_of}" — use YYYY-MM-DD.` }], isError: true };

    // Semantic lane: wait briefly for the embedder; first-ever use downloads
    // the model in the background — searches stay lexical until it's warm.
    const pipe = await Promise.race([getEmbedder(), new Promise(r => setTimeout(() => r(null), 20_000))]);
    let qv = null;
    if (pipe) { try { [qv] = await embedTexts(pipe, [q]); } catch { /* lexical only */ } }

    // Current-project locality prior: a card from the project you're working in
    // should outrank an equally-relevant card from an unrelated project (the
    // "cross-project search drowned my own project's cards" complaint). The boost
    // below is modest + mode-aware — never enough to bury a much stronger foreign hit.
    let curKey = null;
    try { const cb = resolveCanvas('brain') || resolveCanvas('brain.klypix'); if (cb) curKey = path.resolve(cb).replace(/\\/g, '/').toLowerCase(); } catch { /* no current brain */ }
    const fresh = Date.now() - 30 * 86_400_000;
    const scored = [];
    for (const b of brains) {
        let isCur = false;
        try { isCur = !!curKey && path.resolve(b.path).replace(/\\/g, '/').toLowerCase() === curKey; } catch { /* */ }
        let struct;
        try { ({ struct } = await parseKlypix(fs.readFileSync(b.path))); } catch { continue; }
        let vecs = null;
        if (qv) { try { vecs = await vectorsForBrain(pipe, b.path, struct.cards); } catch { /* lexical for this brain */ } }
        for (const c of struct.cards) {
            if (c.type === 'container') continue;
            const text = String(c.text || '').toLowerCase();
            const isArchived = /^archive$/i.test(c.area || '');
            if (asOfTs != null) {
                if ((c.createdAt || 0) > asOfTs) continue;                  // didn't exist yet
                const died = isArchived ? deathDateOf(c.text) : null;
                if (died != null && died <= asOfTs) continue;               // already superseded then
            }
            let lex = 0;
            const title = String(c.title || '').toLowerCase();
            const tags = (c.tags || []).map(t => ('#' + t).toLowerCase());
            for (const t of terms) {
                if (title.includes(t)) lex += 3;
                if (tags.some(g => g.includes(t))) lex += 2;
                if (text.includes(t)) lex += 1;
            }
            // Floor calibrated on real cards: related ≈ 0.25, unrelated ≈ 0.0
            // (MiniLM, short decision texts) — 0.18 keeps recall with margin.
            const sem = (qv && vecs?.get(c.id)) ? dot(qv, vecs.get(c.id)) : null;
            if (!lex && (sem == null || sem < 0.18)) continue;
            // Hybrid: semantic dominates when available; lexical is the tie-breaker
            // and the only signal pre-warm-up. Recency/archive nudges skipped for
            // time-travel queries (validity already handled above).
            let score = sem != null ? sem * 10 + Math.min(lex, 6) * 0.5 : lex;
            if (asOfTs == null) {
                if ((c.createdAt || 0) >= fresh) score += 0.5;
                if (isArchived) score -= 1;
                if (isCur) score += sem != null ? 1.5 : 1; // current-project locality prior
            }
            scored.push({ score, sem, cur: isCur, project: b.project || path.basename(path.dirname(b.path)), area: c.area, c });
        }
    }
    if (!scored.length) return { content: [{ type: 'text', text: `No matches for "${query}" across ${brains.length} registered brain(s).` }] };
    scored.sort((a, b2) => b2.score - a.score);
    const top = scored.slice(0, 20);
    const lines = top.map(h => {
        const when = h.c.createdAt ? new Date(h.c.createdAt).toISOString().slice(0, 10) : '';
        return `- ${h.cur ? '★ ' : ''}[${h.project}${h.area ? ' › ' + h.area : ''}] ${when} ${String(h.c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
    });
    const mode = qv ? 'semantic+lexical (on-device)' : 'lexical (semantic model warming — retry for semantic ranking)';
    const asOfNote = asOfTs != null ? ` · as of ${as_of}` : '';
    return { content: [{ type: 'text', text: `# Cross-project matches for "${query}" (${scored.length} hits in ${brains.length} brains, top ${top.length} · ${mode}${asOfNote})\n\n${lines.join('\n')}` }] };
});

server.registerTool('brain_insights', {
    title: 'What matters in a brain — hubs, orphans, stale questions',
    description: 'Structural read of a brain.klypix: the most-connected "hub" cards (load-bearing decisions), orphaned decisions (no connections — maybe forgotten), stale open questions (aging & unresolved), and area sizes. Use to answer "what matters here / what am I forgetting / what should I review?" — read it at the start of a planning session, or before tidying.',
    inputSchema: {
        canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
        staleDays: z.number().optional().describe('Open questions older than this many days count as stale (default 21).'),
    },
}, async ({ canvas, staleDays }) => {
    const file = resolveCanvas(canvas || 'brain') || resolveCanvas('brain.klypix');
    if (!file) return { content: [{ type: 'text', text: `No brain canvas found in ${VAULT}. Pass canvas: "<name>", or run \`npx klypix-mcp init\` to create one.` }], isError: true };
    try {
        const { struct } = await parseKlypix(fs.readFileSync(file));
        const ins = brainInsights(struct, staleDays ? { staleDays } : {});
        return { content: [{ type: 'text', text: insightsToMarkdown(ins, struct.title) }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Insights failed: ${e.message}` }], isError: true };
    }
});

server.registerTool('brain_connect', {
    title: 'Connect related-but-unlinked brain cards (densify the graph)',
    description: 'Finds genuinely related cards that AREN\'T linked yet and proposes connections — semantic similarity when the on-device model is installed, else shared tags + [[mentions]]. Dry-run by default (review the suggestions); pass apply:true to draw them (ADDITIVE — never deletes; the human can remove any arrow). Use after brain_insights flags many orphans, to turn a flat list into a real knowledge graph.',
    inputSchema: {
        canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
        apply: z.boolean().optional().describe('false (default) = suggest only; true = draw the connections.'),
        max: z.number().optional().describe('Max connections to propose/draw (default 24).'),
        threshold: z.number().optional().describe('Min semantic similarity 0–1 to link (default 0.45). Higher = fewer, tighter links.'),
    },
}, async ({ canvas, apply = false, max = 24, threshold = 0.45 }) => {
    const file = resolveCanvas(canvas || 'brain') || resolveCanvas('brain.klypix');
    if (!file) return { content: [{ type: 'text', text: `No brain canvas found in ${VAULT}.` }], isError: true };
    let struct;
    try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return { content: [{ type: 'text', text: `Read failed: ${e.message}` }], isError: true }; }
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !/^archive$/i.test(c.area || ''));
    const linked = new Set(struct.connections.map(c => [c.fromId, c.toId].sort().join('|')));

    let edges = [];
    let mode = 'structural (shared tags + [[mentions]])';
    const pipe = await Promise.race([getEmbedder(), new Promise(r => setTimeout(() => r(null), 20_000))]);
    if (pipe) {
        try {
            const vecs = await vectorsForBrain(pipe, file, struct.cards);
            const items = live.filter(c => vecs.get(c.id));
            for (const a of items) {
                const av = vecs.get(a.id);
                const sims = items
                    .filter(b => b.id !== a.id)
                    .map(b => ({ b, s: dot(av, vecs.get(b.id)), cross: (b.area || '') !== (a.area || '') }))
                    .sort((x, y) => (y.s + (y.cross ? 0.03 : 0)) - (x.s + (x.cross ? 0.03 : 0))); // nudge toward cross-area links
                let taken = 0;
                for (const { b, s } of sims) {
                    if (s < threshold || taken >= 2) break;       // each card keeps its ≤2 strongest fresh links
                    const key = [a.id, b.id].sort().join('|');
                    if (linked.has(key)) continue;
                    linked.add(key);
                    edges.push({ fromId: a.id, toId: b.id, sim: s });
                    taken++;
                }
            }
            edges.sort((x, y) => y.sim - x.sim);
            mode = 'semantic (on-device)';
        } catch (e) { mode = `structural (semantic failed: ${e.message})`; }
    }
    if (!edges.length && mode.startsWith('structural')) {
        edges = proposeStructuralConnections(struct);
    }
    const chosen = edges.slice(0, max);
    if (!chosen.length) return { content: [{ type: 'text', text: `Nothing to connect — no related-but-unlinked cards found (mode: ${mode}).` }] };

    const render = (e) => `- ${flat(byId.get(e.fromId)?.text)} ↔ ${flat(byId.get(e.toId)?.text)}${e.sim != null ? `  (${e.sim.toFixed(2)})` : e.why ? `  (${e.why})` : ''}`;
    if (!apply) {
        return { content: [{ type: 'text', text: `# ${chosen.length} suggested connection(s) · ${mode}\n_Review, then re-run with apply:true to draw them._\n\n${chosen.map(render).join('\n')}` }] };
    }
    try {
        const { buffer, added } = await addBrainConnections(fs.readFileSync(file), chosen);
        await atomicWrite(file, buffer);
        return { content: [{ type: 'text', text: `✓ Drew ${added} connection(s) into ${path.relative(VAULT, file)} (${mode}). Reopen the brain to see the new arrows.\n\n${chosen.slice(0, added).map(render).join('\n')}` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Apply failed (brain unchanged): ${e.message}` }], isError: true };
    }
});

// Format the cards (optionally only a set of new ids) + connection graph so an
// agent that just wrote can chain follow-ups: reference card IDs, place near a
// position, or draw an arrow to something it created. Additive — appended after
// the human-readable line.
function cardDetailBlock(struct, onlyIds) {
    const cards = onlyIds ? struct.cards.filter(c => onlyIds.has(c.id)) : struct.cards;
    if (!cards.length) return '';
    const lines = cards.map(c => {
        const pos = (c.pos && c.pos.x != null) ? `(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '(?)';
        const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
        const title = c.title || (c.text ? String(c.text).replace(/\s+/g, ' ').slice(0, 40) : '(untitled)');
        return `- ${c.id} · ${c.type} · ${pos} · "${title}"${tags}`;
    });
    let out = `\n\nCards you can reference (id · type · pos · title):\n${lines.join('\n')}`;
    if (struct.connections && struct.connections.length) {
        out += `\nConnections: ` + struct.connections.map(cn => `${cn.from} ${cn.relationship ? '—' + cn.relationship + '→' : '→'} ${cn.to}`).join('; ');
    }
    return out;
}

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
        let detail = '';
        try { const { struct } = await parseKlypix(buf); detail = cardDetailBlock(struct); } catch { /* detail is optional */ }
        return { content: [{ type: 'text', text: `Created ${out} — ${cards.length} cards, ${(connections || []).length} connections. Open it in KLYPIX (Canvas → Open).${detail}` }] };
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
        const original = fs.readFileSync(file);
        // Snapshot existing ids so we can report ONLY the newly-added cards back.
        let beforeIds = new Set();
        try { const b = await parseKlypix(original); beforeIds = new Set(b.struct.cards.map(c => c.id)); } catch { /* new/legacy → treat all as new */ }
        // Provenance: stamp WHICH agent wrote these cards (cursor / claude /
        // cline — from the MCP client's initialize handshake).
        let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
        const stamped = via ? cards.map(c => ({ ...c, createdVia: via })) : cards;
        const buf = await appendToKlypix(original, { cards: stamped, connections });
        await atomicWrite(file, buf);
        let detail = '';
        try {
            const { struct } = await parseKlypix(buf);
            detail = cardDetailBlock(struct, new Set(struct.cards.map(c => c.id).filter(id => !beforeIds.has(id))));
        } catch { /* detail is optional */ }
        return { content: [{ type: 'text', text: `Added ${cards.length} card(s) to ${path.relative(VAULT, file)}. Reopen the canvas in KLYPIX to see them.${detail}` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Add failed: ${e.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready · vault=${VAULT}`);
// Pre-warm the on-device embedder in the BACKGROUND so the first cross-project
// search of a session is already semantic, not a lexical fallback while the
// MiniLM model loads. getEmbedder() memoizes + swallows its own errors, so this
// is a safe fire-and-forget (no await → zero added startup latency).
getEmbedder().then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
