// klypix-core — the protocol-neutral engine behind every KLYPIX agent face.
//
// All vault operations (list / read / search / create / append / insights /
// connect / cross-project search) live here as pure-ish async functions that
// return a protocol-neutral result:
//
//     { blocks: Block[], isError?: boolean, file?: { name, buffer }, struct? }
//
// where Block is { kind:'text', text } or { kind:'image', data(base64), mime, name }.
//
// Two thin faces sit on top and never duplicate this logic:
//   - bin/klypix-mcp.mjs  — maps blocks → MCP content blocks (the MCP server)
//   - bin/klypix-a2a.mjs  — maps blocks → A2A Parts + returns `file` as a FilePart
//
// This file imports ONLY the pure format library (src/klypix-format.mjs) plus
// Node built-ins, so it is safe to load from any process with no MCP/A2A/SDK in
// the loop. It mutates nothing it isn't asked to (search/read never write).

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import {
  parseKlypix, buildKlypix, buildKlypixMap, appendToKlypix, structToMarkdown,
  brainInsights, insightsToMarkdown, addBrainConnections, proposeStructuralConnections, atomicWrite,
  findUnrecordedMigrations, captureIntoBrain, tidyBrain, noteToCaptureInput,
  selectGardenCandidates, applyGarden, detectContradictions,
  rankForQuestion, questionContextToMarkdown, findLegacyShipCards,
} from './klypix-format.mjs';

// ── Card / connection input shape (single source for every face) ─────────────
export const cardSchema = z.object({
  text: z.string().describe('Card text. First line is the card title.'),
  heading: z.boolean().optional().describe('Bold title card for the main goal/topic.'),
  color: z.string().optional().describe('Hex color, e.g. #ef4444 for a risk/blocker.'),
});
export const connSchema = z.object({
  from: z.union([z.number(), z.string()]).describe('Source card: index (0-based), title, or id.'),
  to: z.union([z.number(), z.string()]).describe('Target card: index, title, or id.'),
  relationship: z.string().optional().describe('leads_to|depends_on|relates_to|conflicts_with|supports|questions|costs|blocks'),
  label: z.string().optional(),
});

// ── Vault discovery / resolution ─────────────────────────────────────────────
export const IS_CANVAS = /\.(klypix|any)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', '$Recycle.Bin', 'Windows']);
const MAX_FILES = 400;
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

// Resolve the vault folder the same way every face does: explicit > env > ~/Documents.
export function resolveVault(explicit) {
  return path.resolve(explicit || process.env.KLYPIX_VAULT || path.join(os.homedir(), 'Documents'));
}

export function walkVault(vault) {
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
  visit(vault, 0);
  return out;
}

// Resolve a user-supplied canvas reference: absolute path, vault-relative path,
// or a bare filename (matched against the walked list, case-insensitively).
export function resolveCanvas(vault, ref) {
  if (!ref) return null;
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
  const rel = path.join(vault, ref);
  if (fs.existsSync(rel)) return rel;
  const want = path.basename(ref).toLowerCase();
  const matches = walkVault(vault).filter(f => path.basename(f).toLowerCase() === want
    || path.basename(f).toLowerCase() === want + '.klypix'
    || path.basename(f).toLowerCase() === want + '.any');
  return matches[0] || null;
}

// Resolve the DEFAULT project brain for the brain-* ops, INDEPENDENT of the
// --vault library folder. The vault answers "where does my .klypix library live"
// (list/read/search); the BRAIN is "THIS project's ./brain.klypix". Conflating
// them is what made the brain ops read a stray canvas out of a global vault
// (the "SS2" bug — a foreign brain.klypix picked by a fuzzy basename walk).
// Precedence, project-first:
//   1. KLYPIX_BRAIN env (explicit override)
//   2. ./brain.klypix in the launch cwd — the project brain (coding agents launch
//      this server with cwd = the project root)
//   3. <vault>/brain.klypix (exact) — when the vault itself is the brain's home
//   4. a SINGLE brain.klypix found by walking the vault; if MORE THAN ONE exists
//      we REFUSE to guess (returns { ambiguous }) instead of silently taking one.
export function resolveDefaultBrain(vault) {
  const ex = (p) => { try { return p && fs.existsSync(p) ? path.resolve(p) : null; } catch { return null; } };
  let f;
  if ((f = ex(process.env.KLYPIX_BRAIN))) return { file: f, how: 'env (KLYPIX_BRAIN)' };
  if ((f = ex(path.join(process.cwd(), 'brain.klypix')))) return { file: f, how: 'project cwd' };
  if ((f = ex(path.join(vault, 'brain.klypix')))) return { file: f, how: 'vault root' };
  const matches = walkVault(vault).filter(p => /^brain\.(klypix|any)$/i.test(path.basename(p)));
  if (matches.length === 1) return { file: matches[0], how: 'vault search' };
  if (matches.length > 1) return { ambiguous: matches };
  return { file: null };
}

// Resolve the brain a brain-* op should act on. An explicit `canvas` arg → exact
// resolve against the vault; otherwise the project-aware default above. Always
// returns one of: { file, how } · { ambiguous: [paths] } · { file: null }.
export function brainTarget(vault, canvas) {
  if (canvas) { const file = resolveCanvas(vault, canvas); return file ? { file, how: `canvas:"${canvas}"` } : { file: null }; }
  return resolveDefaultBrain(vault);
}

// One-line provenance shown atop every brain-op result so a wrong brain (the
// "SS2" class) is OBVIOUS at a glance instead of silent. Counts non-container cards.
export function brainStamp(file, struct, how) {
  const title = (struct && struct.title) || path.basename(file);
  const n = struct ? struct.cards.filter(c => c.type !== 'container').length : '?';
  return `_brain: ${path.basename(file)} · “${title}” · ${n} cards${how ? ' · via ' + how : ''}_\n\n`;
}

// Shared error for the refuse-to-guess case — names the candidates so the caller
// can pick one (canvas:"<path>") or fix the vault / run from the project root.
function ambiguousBrainErr(matches) {
  return err(`Found ${matches.length} brain.klypix files in the vault and no ./brain.klypix in the current project — refusing to guess which is "the brain". Pass canvas:"<path>", run from the project root, or set KLYPIX_BRAIN. Candidates:\n${matches.map(m => '  - ' + m).join('\n')}`);
}

function safeName(vault, title) {
  const base = String(title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled';
  let name = base, n = 1;
  while (fs.existsSync(path.join(vault, `${name}.klypix`))) name = `${base} ${++n}`;
  return `${name}.klypix`;
}

// ── On-device semantic memory (shared, lazy, self-healing) ───────────────────
// Embeddings run INSIDE the long-lived host process, 100% local: transformers.js
// (WASM) + a 23MB MiniLM model cached under ~/.claude/project-brain/hf-cache on
// first use. Per-brain vectors are cached incrementally (content-hashed per
// card). Everything degrades to lexical scoring gracefully: no lib, no model, no
// network → search still works.
const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const EMB_DIR = path.join(PB_DIR, 'embeddings');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
let embedderPromise = null;
export function getEmbedder(log = () => {}) {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      // Dual-path: (1) bare specifier — npx/npm installs ship the lib;
      // (2) ~/.claude/project-brain/semantic — where KLYPIX's one-click
      // "semantic memory" install places it for the bundled server.
      let t;
      try { t = await import('@huggingface/transformers'); }
      catch {
        // The optional dep ships dist/transformers.node.mjs on v4 (Node build) and
        // dist/transformers.mjs on older lines — try both so a correct one-click
        // install resolves regardless of version.
        const base = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist');
        let lastErr;
        for (const f of ['transformers.node.mjs', 'transformers.mjs']) {
          try { t = await import(new URL('file:///' + path.join(base, f).replace(/\\/g, '/')).href); lastErr = null; break; }
          catch (e) { lastErr = e; }
        }
        if (!t) throw lastErr;
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
const deathDateOf = (text) => { const m = /(?:↩︎ superseded|✅) (\d{4}-\d{2}-\d{2})/.exec(String(text)); return m ? Date.parse(m[1]) : null; };

// ── small block helpers ──────────────────────────────────────────────────────
const text = (t) => ({ kind: 'text', text: t });
const err = (t) => ({ blocks: [text(t)], isError: true });

// Format the cards (optionally only a set of new ids) + connection graph so a
// caller that just wrote can chain follow-ups. Additive — appended after the
// human-readable line.
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

// ── Operations ───────────────────────────────────────────────────────────────

export async function opListCanvases({ vault }) {
  const files = walkVault(vault);
  if (files.length === 0) {
    return { blocks: [text(`No .klypix/.any files found under vault: ${vault}\nSet --vault or KLYPIX_VAULT to your canvas folder.`)] };
  }
  const rows = [];
  for (const f of files) {
    try {
      const { struct } = await parseKlypix(fs.readFileSync(f));
      const st = fs.statSync(f);
      rows.push(`- ${path.relative(vault, f)} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections · ${new Date(st.mtimeMs).toISOString().slice(0, 10)}`);
    } catch {
      rows.push(`- ${path.relative(vault, f)} — (unreadable)`);
    }
  }
  return { blocks: [text(`# Canvases in ${vault}\n\n${rows.join('\n')}`)] };
}

export async function opReadCanvas({ vault, canvas }) {
  const file = resolveCanvas(vault, canvas);
  if (!file) return err(`Canvas not found: ${canvas} (vault: ${vault})`);
  try {
    const { struct, zip, assetPaths } = await parseKlypix(fs.readFileSync(file));
    const blocks = [text(structToMarkdown(struct))];
    // Return image assets as actual image blocks so a vision-capable model SEES
    // them — the whole point of a multimodal canvas. Capped (count + size).
    let included = 0;
    for (const p of assetPaths) {
      if (included >= 8) break;
      if (!IMG_RE.test(p)) continue;
      try {
        const b64 = await zip.file(p).async('base64');
        if (!b64 || b64.length > 7_000_000) continue; // skip > ~5MB
        const ext = p.split('.').pop().toLowerCase();
        blocks.push({ kind: 'image', data: b64, mime: IMG_MIME[ext] || 'image/png', name: p });
        included++;
      } catch { /* skip unreadable asset */ }
    }
    if (included > 0) blocks.push(text(`\n(${included} image${included > 1 ? 's' : ''} from this canvas are attached above — read them directly.)`));
    return { blocks, struct };
  } catch (e) {
    return err(`Failed to read ${file}: ${e.message}`);
  }
}

export async function opSearchCanvases({ vault, query }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return err('Provide a non-empty query.');
  // Tokenize so a multi-word query matches a card holding ANY term (recall-first;
  // deliberately NOT the brief's precision scorer, which skips containers/archive).
  const terms = q.split(/\s+/).filter(Boolean);
  const hit = (s) => { const v = String(s || '').toLowerCase(); return terms.some(t => v.includes(t)); };
  const hits = [];
  for (const f of walkVault(vault)) {
    let struct;
    try { ({ struct } = await parseKlypix(fs.readFileSync(f))); } catch { continue; }
    const rel = path.relative(vault, f);
    const nameMatch = hit(struct.title) || hit(rel);
    const matched = struct.cards.filter(c =>
      hit(c.title) ||
      hit(c.text) ||
      (c.tags || []).some(t => hit('#' + t)));
    if (nameMatch || matched.length) {
      const head = `## ${rel} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections${nameMatch && !matched.length ? '  (name/title match)' : ''}`;
      const body = matched.slice(0, 8).map(c => {
        const pos = (c.pos && c.pos.x != null) ? ` @(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '';
        const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
        return `- [${c.type}] "${c.title || '(card)'}" (${c.id})${pos}${tags}\n    ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
      }).join('\n');
      hits.push(matched.length ? `${head}\n${body}` : head);
    }
  }
  return { blocks: [text(hits.length ? `# Matches for "${query}"\n\n${hits.join('\n\n')}` : `No matches for "${query}" in ${vault}.`)] };
}

export async function opSearchAllBrains({ vault, query, as_of, log = () => {} }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return err('Provide a non-empty query.');
  const reg = path.join(PB_DIR, 'registry.json');
  let brains = [];
  try { brains = (JSON.parse(fs.readFileSync(reg, 'utf8')).brains || []).filter(b => b && b.path); } catch { /* no registry yet */ }
  if (!brains.length) return { blocks: [text('No brains registered yet — the brain hook registers each project as you work in it.')] };
  const terms = q.split(/[^\p{L}\p{N}#]+/u).filter(t => t.length >= 3);
  if (!terms.length) return err('Query too short — use words of 3+ characters.');
  const asOfTs = as_of ? Date.parse(as_of) : null;
  if (as_of && Number.isNaN(asOfTs)) return err(`Bad as_of date: "${as_of}" — use YYYY-MM-DD.`);

  const pipe = await Promise.race([getEmbedder(log), new Promise(r => setTimeout(() => r(null), 20_000))]);
  let qv = null;
  if (pipe) { try { [qv] = await embedTexts(pipe, [q]); } catch { /* lexical only */ } }

  let curKey = null;
  try { const cb = resolveDefaultBrain(vault).file; if (cb) curKey = path.resolve(cb).replace(/\\/g, '/').toLowerCase(); } catch { /* no current brain */ }
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
      const t = String(c.text || '').toLowerCase();
      const isArchived = /^archive$/i.test(c.area || '');
      if (asOfTs != null) {
        if ((c.createdAt || 0) > asOfTs) continue;                  // didn't exist yet
        const died = isArchived ? deathDateOf(c.text) : null;
        if (died != null && died <= asOfTs) continue;               // already superseded then
      }
      let lex = 0;
      const title = String(c.title || '').toLowerCase();
      const tags = (c.tags || []).map(g => ('#' + g).toLowerCase());
      for (const term of terms) {
        if (title.includes(term)) lex += 3;
        if (tags.some(g => g.includes(term))) lex += 2;
        if (t.includes(term)) lex += 1;
      }
      const sem = (qv && vecs?.get(c.id)) ? dot(qv, vecs.get(c.id)) : null;
      if (!lex && (sem == null || sem < 0.18)) continue;
      let score = sem != null ? sem * 10 + Math.min(lex, 6) * 0.5 : lex;
      if (asOfTs == null) {
        if ((c.createdAt || 0) >= fresh) score += 0.5;
        if (isArchived) score -= 1;
        if (isCur) score += sem != null ? 1.5 : 1; // current-project locality prior
      }
      scored.push({ score, sem, cur: isCur, project: b.project || path.basename(path.dirname(b.path)), area: c.area, c });
    }
  }
  if (!scored.length) return { blocks: [text(`No matches for "${query}" across ${brains.length} registered brain(s).`)] };
  scored.sort((a, b2) => b2.score - a.score);
  const top = scored.slice(0, 20);
  const lines = top.map(h => {
    const when = h.c.createdAt ? new Date(h.c.createdAt).toISOString().slice(0, 10) : '';
    return `- ${h.cur ? '★ ' : ''}[${h.project}${h.area ? ' › ' + h.area : ''}] ${when} ${String(h.c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
  });
  const mode = qv ? 'semantic+lexical (on-device)' : 'lexical (semantic model warming — retry for semantic ranking)';
  const asOfNote = asOfTs != null ? ` · as of ${as_of}` : '';
  return { blocks: [text(`# Cross-project matches for "${query}" (${scored.length} hits in ${brains.length} brains, top ${top.length} · ${mode}${asOfNote})\n\n${lines.join('\n')}`)] };
}

// ── brain_ask — answer a natural-language question over the WHOLE brain ───────
// "What did we decide about X?" / "Where did the auth work land?" The daily-use
// surface: hybrid retrieval (semantic on-device + lexical) over every card
// (including archived history, flagged), correction-aware (a stale hit carries its
// live correction), assembled into a SYNTHESIS-READY context the calling agent
// turns into a direct, cited answer. The engine never calls an LLM (pure retrieval
// + assembly) — same "engine selects, model writes" contract as brain_connect.
export async function opBrainAsk({ vault, canvas, question, as_of, k = 10, log = () => {} }) {
  const q = String(question || '').trim();
  if (!q) return err('brain_ask needs a question.');
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const asOfTs = as_of ? Date.parse(as_of) : null;
  if (as_of && Number.isNaN(asOfTs)) return err(`Bad as_of date: "${as_of}" — use YYYY-MM-DD.`);
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(t.file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(t.file, struct, t.how);
  // Semantic blend (best-effort, time-bounded): embed the question + the brain's
  // cards on-device, hand rankForQuestion a Map<cardId, cosine>. A missing/warming
  // model degrades cleanly to pure lexical.
  let semantic = null, mode = 'lexical';
  try {
    const pipe = await Promise.race([getEmbedder(log), new Promise(r => setTimeout(() => r(null), 20_000))]);
    if (pipe) {
      const [qv] = await embedTexts(pipe, [q]);
      const vecs = await vectorsForBrain(pipe, t.file, struct.cards);
      if (qv && vecs && vecs.size) { semantic = new Map(); for (const [id, v] of vecs) semantic.set(id, dot(qv, v)); mode = 'semantic+lexical (on-device)'; }
    }
  } catch { semantic = null; mode = 'lexical (semantic warming — retry for semantic ranking)'; }
  const result = rankForQuestion(struct, q, { semantic, k: Math.max(1, Math.min(20, k || 10)), as_of: asOfTs != null ? as_of : null });
  return { blocks: [text(stamp + questionContextToMarkdown(q, result, { mode, as_of: asOfTs != null ? as_of : null }))] };
}

export async function opBrainInsights({ vault, canvas, staleDays }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>", or run \`npx klypix-mcp init\` to create one.`);
  try {
    const { struct } = await parseKlypix(fs.readFileSync(t.file));
    const ins = brainInsights(struct, staleDays ? { staleDays } : {});
    return { blocks: [text(brainStamp(t.file, struct, t.how) + insightsToMarkdown(ins, struct.title))] };
  } catch (e) {
    return err(`Insights failed: ${e.message}`);
  }
}

// ── Migration reconcile (external-state omission tripwire) ────────────────────
// Lists committed migration files under a project root (Supabase / Rails / Prisma
// / Knex / generic layouts) and feeds them to the pure findUnrecordedMigrations(),
// returning the ones no live brain card records. Portable: pure fs, no DB, no
// network, no credentials — it flags "committed but unmentioned", NEVER claims
// "applied to prod". Degrades to a clean message for a project with no migrations.
const MIGRATION_DIRS = ['supabase/migrations', 'db/migrate', 'db/migrations', 'prisma/migrations', 'migrations'];
export function collectMigrationFiles(root) {
  const out = [];
  for (const rel of MIGRATION_DIRS) {
    const abs = path.join(root, ...rel.split('/'));
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && /\.sql$/i.test(e.name)) out.push(rel + '/' + e.name);
      // Prisma nests each migration in its own folder holding a migration.sql.
      else if (e.isDirectory()) {
        try { if (fs.statSync(path.join(abs, e.name, 'migration.sql')).isFile()) out.push(rel + '/' + e.name + '/migration.sql'); } catch { /* not a prisma migration dir */ }
      }
    }
  }
  return out;
}
export async function opBrainReconcile({ vault, canvas, root, mode = 'all' }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(file, struct, t.how);
  const sections = [];

  // (1) CONTRADICTIONS — the brain reconciled against ITSELF. Same-subject live
  // pairs where one side carries an explicit correction cue (that side is the
  // presumed truth — UNLESS the cue predates its counterpart, then the newer
  // card is presumed to have superseded the correction and the pair is marked
  // "presumed superseded") or the two use opposite polarity words
  // (deferred↔wired, broken↔fixed …). Candidates only — nothing is changed
  // here; the agent/human confirms each. This is the retroactive cleaner for
  // stale/correction pairs that slipped past capture (cross-area + reworded →
  // no supersede possible).
  if (mode === 'all' || mode === 'contradictions') {
    const pairs = detectContradictions(struct);
    if (pairs.length) {
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const lines = pairs.map((p, i) =>
        `${i + 1}. ${p.why} · overlap ${p.overlap}\n`
        + `   · likely STALE   [${p.stale.area || '?'}] (id ${p.stale.id}) ${flat(p.stale.text).slice(0, 180)}\n`
        + `   · likely CURRENT [${p.fresh.area || '?'}] (id ${p.fresh.id}) ${flat(p.fresh.text).slice(0, 180)}`);
      sections.push(`# ⚔️ ${pairs.length} contradiction candidate(s) — confirm, then reconcile\n_Candidates only — nothing was changed. For each REAL contradiction: retire the stale card with \`brain_note\` marker \`✓\` (text = what it resolved to), or record a correction-cue decision ("CORRECTION: …", uppercase) — capture auto-supersedes it across areas. A pair marked "presumed superseded" is INVERTED — its correction card PREDATES its counterpart (e.g. the old fact was re-captured after the correction): verify which side is real before retiring anything; if the correction still holds, re-assert it (a \`~\` update or a fresh CORRECTION card) instead of retiring it. Dismissing a FALSE positive (either kind — polarity OR correction-cue): \`brain_connect\` with \`pairs:[{fromId, toId}]\` and \`relationship:"not_contradiction"\` using the ids above — the dismissal is persisted, so that pair never resurfaces here (and its cue never re-attaches as a recall/ask overlay)._\n\n${lines.join('\n')}`);
    } else if (mode === 'contradictions') {
      sections.push('✓ No contradiction candidates — no live card pair shows a correction cue or a polarity flip over the same subject.');
    }
  }

  // (1b) LEGACY SHIP CARDS — pre-v1.15 auto-captured "merged PR — auto-captured
  // (`gh …`)" cards with raw shell text / path-scraped junk PR numbers. Already
  // excluded from repeat-matching (so they no longer cry wolf); this surfaces them
  // for optional one-time cleanup. Suggestion-only — retire each with a ✓ marker.
  if (mode === 'all' || mode === 'legacy') {
    const { cards: legacy, total } = findLegacyShipCards(struct);
    if (legacy.length) {
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const lines = legacy.map(c => `- (id ${c.id}) [${c.area || '?'}] ${flat(c.text).slice(0, 140)}`);
      const more = total > legacy.length ? `\n\n…and ${total - legacy.length} more.` : '';
      sections.push(`# 🧹 ${total} legacy raw-bash ship card(s) — optional cleanup\n_Pre-v1.15 auto-capture residue (raw shell command / path-scraped PR numbers). They are ALREADY excluded from repeat-detection, so this is cosmetic hygiene, not a correctness fix. To tidy: retire each with \`brain_note\` marker \`✓\`, or leave them — they no longer trigger false repeat warnings._\n\n${lines.join('\n')}${more}`);
    } else if (mode === 'legacy') {
      sections.push('✓ No legacy raw-bash ship cards — every ship card is a clean fact.');
    }
  }

  // (2) MIGRATIONS — the brain reconciled against committed external state.
  // Migrations live in the CODE repo (usually beside brain.klypix), not in a
  // separate canvas vault — so default the root to the brain file's folder.
  if (mode === 'all' || mode === 'migrations') {
    const repoRoot = root ? path.resolve(root) : path.dirname(file);
    const files = collectMigrationFiles(repoRoot);
    if (!files.length) {
      if (mode === 'migrations') sections.push(`No migration files under ${repoRoot} (looked in: ${MIGRATION_DIRS.join(', ')}). Nothing to reconcile.`);
    } else {
      const { gaps, total } = findUnrecordedMigrations(struct, files, { max: 20 });
      if (!gaps.length) sections.push(`✓ All ${files.length} migration(s) under ${path.basename(repoRoot)} are referenced by a brain card — no unrecorded rollouts.`);
      else {
        const lines = gaps.map(g => `- \`${g.path}\` — committed, but no brain card mentions it. If applied to prod, record it:\n    \`🧠 BRAIN [DB] !: migration ${g.file.replace(/\.sql$/i, '')} applied to prod ev: ${g.path}\``);
        const more = total > gaps.length ? `\n\n…and ${total - gaps.length} more.` : '';
        sections.push(`# ⚠️ ${total} migration(s) committed but unrecorded in the brain\n_The brain can't see prod — it flags migrations that are in git but unmentioned, so you can confirm the rollout. It never asserts a migration was applied. To dismiss one without applying, record any card that names it (e.g. "committed, not applied")._\n\n${lines.join('\n')}${more}`);
      }
    }
  }

  if (!sections.length) sections.push('✓ Nothing to reconcile — no contradiction candidates, and no unrecorded migrations.');
  return { blocks: [text(stamp + sections.join('\n\n---\n\n'))] };
}

// ── Brain gardener (two-phase: select → agent synthesizes → apply) ───────────
// The portable /garden. Dry-run returns the over-grown areas + their old cards
// for the CALLING agent to synthesize (the engine is pure — the model writes the
// prose); apply consolidates each area into a 🌿 card and archives the originals
// with audit arrows. Mirrors brain_connect's dry-run/apply discipline.
export async function opBrainGarden({ vault, canvas, apply = false, syntheses }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(file, struct, t.how);
  const areas = selectGardenCandidates(struct);
  if (!areas.length) return { blocks: [text(stamp + 'Nothing to garden — no area has 3+ DORMANT cards (old, beyond its newest 8, AND peripheral/≤1 link). Anything still woven into the graph is protected. The brain is tidy.')] };

  if (!apply) {
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const body = areas.map(a => `## ${a.title}  (${a.candidates.length} dormant cards)\n` + a.candidates.map(c => `- ${flat(c.text).slice(0, 240)}`).join('\n')).join('\n\n');
    return { blocks: [text(stamp + `# 🌿 Gardener — ${areas.length} area(s) with DORMANT cards to consolidate\nThese are old, peripheral (≤1 link) cards only — hubs and still-referenced decisions were left untouched. For EACH area below, write ONE tight synthesis (3-6 sentences, plain prose, no headers) that preserves every still-relevant fact / decision / number and drops only repetition + play-by-play. Then call \`brain_garden\` again with \`apply:true\` and \`syntheses: [{ "title": "<area title EXACTLY as shown>", "synthesis": "<text>" }, …]\`. Originals are archived with audit arrows — nothing is deleted; one undo un-gardens.\n\n${body}`)] };
  }

  if (!Array.isArray(syntheses) || !syntheses.length) return err('apply:true needs syntheses:[{title, synthesis}, …] — run the dry run first (apply omitted) to get the areas + their cards.');
  try {
    const { buffer, stats } = await applyGarden(fs.readFileSync(file), { syntheses });
    const skippedNote = (stats.skipped && stats.skipped.length)
      ? `\n\n⚠️ Left untouched (faithfulness guard): ${stats.skipped.map(s => `"${s.title}" — ${s.reason}`).join('; ')}.`
      : '';
    if (!stats.synthCards) return { blocks: [text(`No areas consolidated — each synthesis \`title\` must match a dry-run area title exactly.${skippedNote}`)] };
    let out = buffer; try { out = (await tidyBrain(buffer)).buffer; } catch { /* keep apply result if tidy fails */ }
    await atomicWrite(file, out);
    return { blocks: [text(`🌿 Gardened ${stats.areas} area(s): ${stats.archived} old card(s) → ${stats.synthCards} synthesis card(s); originals archived with "consolidated into" arrows (any prose-dropped figures appended verbatim). Reopen the brain in the KLYPIX app to see it.${skippedNote}`)] };
  } catch (e) {
    return err(`Garden apply failed (brain unchanged): ${e.message}`);
  }
}

export async function opBrainConnect({ vault, canvas, apply = false, max = 24, threshold = 0.45, pairs = null, relationship = null, label = null, log = () => {} }) {
  const tgt = brainTarget(vault, canvas);
  if (tgt.ambiguous) return ambiguousBrainErr(tgt.ambiguous);
  if (!tgt.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}.`);
  const file = tgt.file;
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const byId = new Map(struct.cards.map(c => [c.id, c]));
  const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !/^archive$/i.test(c.area || ''));
  const linked = new Set(struct.connections.map(c => [c.fromId, c.toId].sort().join('|')));

  // ── Explicit-pairs mode ─────────────────────────────────────────────────────
  // Draw EXACTLY the given card-id pairs with a chosen relationship, bypassing the
  // auto-proposer. This is the persisted DISMISS path for a reconcile false
  // positive: pass relationship:"not_contradiction" and detectContradictions will
  // treat the pair as settled forever (the escape hatch a correction-cue false
  // positive — which has no stale card to retire — previously lacked).
  if (Array.isArray(pairs) && pairs.length) {
    const rel = typeof relationship === 'string' && relationship ? relationship : 'relates_to';
    const lbl = (typeof label === 'string' && label) ? label : (rel === 'not_contradiction' ? 'not a contradiction' : undefined);
    const explicit = pairs
      .filter(p => p && p.fromId && p.toId && byId.has(p.fromId) && byId.has(p.toId) && p.fromId !== p.toId)
      .map(p => ({ fromId: p.fromId, toId: p.toId, relationship: rel, ...(lbl ? { label: lbl } : {}) }));
    if (!explicit.length) return err('pairs needs [{fromId, toId}, …] where both ids are real cards in this brain (see the ids in brain_reconcile output).');
    const render2 = (e) => `- ${flat(byId.get(e.fromId)?.text)} ↔ ${flat(byId.get(e.toId)?.text)}  (${e.relationship}${e.label ? `: ${e.label}` : ''})`;
    if (!apply) return { blocks: [text(`# ${explicit.length} explicit connection(s) to draw\n_Re-run with apply:true to draw them.${rel === 'not_contradiction' ? ' These pairs will then be permanently dismissed as contradiction candidates.' : ''}_\n\n${explicit.map(render2).join('\n')}`)] };
    try {
      const { buffer, added } = await addBrainConnections(fs.readFileSync(file), explicit);
      await atomicWrite(file, buffer);
      return { blocks: [text(`✓ Drew ${added} connection(s)${rel === 'not_contradiction' ? ' — these pair(s) are now dismissed and will NOT resurface as brain_reconcile contradiction candidates' : ''}.\n\n${explicit.slice(0, added).map(render2).join('\n')}`)] };
    } catch (e) { return err(`Apply failed (brain unchanged): ${e.message}`); }
  }

  let edges = [];
  let mode = 'structural (shared tags + [[mentions]])';
  const pipe = await Promise.race([getEmbedder(log), new Promise(r => setTimeout(() => r(null), 20_000))]);
  if (pipe) {
    try {
      const vecs = await vectorsForBrain(pipe, file, struct.cards);
      const items = live.filter(c => vecs.get(c.id));
      for (const a of items) {
        const av = vecs.get(a.id);
        const sims = items
          .filter(b => b.id !== a.id)
          .map(b => ({ b, s: dot(av, vecs.get(b.id)), cross: (b.area || '') !== (a.area || '') }))
          .sort((x, y) => (y.s + (y.cross ? 0.03 : 0)) - (x.s + (x.cross ? 0.03 : 0)));
        let taken = 0;
        for (const { b, s } of sims) {
          if (s < threshold || taken >= 2) break;
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
  if (!chosen.length) return { blocks: [text(`Nothing to connect — no related-but-unlinked cards found (mode: ${mode}).`)] };

  const render = (e) => `- ${flat(byId.get(e.fromId)?.text)} ↔ ${flat(byId.get(e.toId)?.text)}${e.sim != null ? `  (${e.sim.toFixed(2)})` : e.why ? `  (${e.why})` : ''}`;
  if (!apply) {
    return { blocks: [text(`# ${chosen.length} suggested connection(s) · ${mode}\n_Review, then re-run with apply:true to draw them._\n\n${chosen.map(render).join('\n')}`)] };
  }
  try {
    const { buffer, added } = await addBrainConnections(fs.readFileSync(file), chosen);
    await atomicWrite(file, buffer);
    return { blocks: [text(`✓ Drew ${added} connection(s) into ${path.relative(vault, file)} (${mode}). Reopen the brain to see the new arrows.\n\n${chosen.slice(0, added).map(render).join('\n')}`)] };
  } catch (e) {
    return err(`Apply failed (brain unchanged): ${e.message}`);
  }
}

export async function opCreateCanvas({ vault, title, cards, connections, filename }) {
  if (!fs.existsSync(vault)) { try { fs.mkdirSync(vault, { recursive: true }); } catch { /* ignore */ } }
  try {
    const buf = await buildKlypix({ title, cards, connections });
    const name = filename ? safeName(vault, filename.replace(IS_CANVAS, '')) : safeName(vault, title);
    const out = path.join(vault, name);
    await atomicWrite(out, buf);
    let detail = '', struct;
    try { ({ struct } = await parseKlypix(buf)); detail = cardDetailBlock(struct); } catch { /* detail is optional */ }
    return {
      blocks: [text(`Created ${out} — ${cards.length} cards, ${(connections || []).length} connections. Open it in the KLYPIX app (Canvas → Open).${detail}`)],
      file: { name, buffer: buf }, struct,
    };
  } catch (e) {
    return err(`Create failed: ${e.message}`);
  }
}

export async function opAddToCanvas({ vault, canvas, cards, connections, via }) {
  const file = resolveCanvas(vault, canvas);
  if (!file) return err(`Canvas not found: ${canvas}`);
  try {
    const original = fs.readFileSync(file);
    let beforeIds = new Set();
    try { const b = await parseKlypix(original); beforeIds = new Set(b.struct.cards.map(c => c.id)); } catch { /* new/legacy → treat all as new */ }
    // Provenance: stamp WHICH agent wrote these cards (cursor / claude / cline / a2a).
    const stamped = via ? cards.map(c => ({ ...c, createdVia: via })) : cards;
    const buf = await appendToKlypix(original, { cards: stamped, connections });
    await atomicWrite(file, buf);
    let detail = '', struct;
    try {
      ({ struct } = await parseKlypix(buf));
      detail = cardDetailBlock(struct, new Set(struct.cards.map(c => c.id).filter(id => !beforeIds.has(id))));
    } catch { /* detail is optional */ }
    return {
      blocks: [text(`Added ${cards.length} card(s) to ${path.relative(vault, file)}. Reopen the canvas in the KLYPIX app to see them.${detail}`)],
      file: { name: path.basename(file), buffer: buf }, struct,
    };
  } catch (e) {
    return err(`Add failed: ${e.message}`);
  }
}

// brain_note — the DELIBERATE, marker-aware write every agent (not just the
// Claude-Code Stop hook) can make on demand. Routes through the SAME captureInto-
// Brain engine the hook uses, so supersede / resolve / close-link / dedup behave
// identically to a harvested 🧠 marker. The agent-neutral half of "the brain is an
// open file any agent reads AND writes": a hookless client (Cursor/Cline/Desktop)
// can now record a decision, ask an open question, mark a milestone, resolve a card,
// or correct one — with the full lifecycle, not just a flat append.
export async function opBrainNote({ vault, canvas, text: noteText, area, marker = '', closes, via }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  if (!noteText || !String(noteText).trim()) return err('brain_note needs a non-empty text.');
  if (!['', '?', '!', '✓', '~', '+'].includes(marker)) return err(`Invalid marker "${marker}" — use: (none)=decision · ?=open question · !=milestone · +=skill (reusable how-to) · ✓=resolve a matching card · ~=update a matching card.`);
  const input = noteToCaptureInput({ text: noteText, area, marker, closes: closes || '', createdVia: via || 'mcp' });
  try {
    const res = await captureIntoBrain(fs.readFileSync(file), input);
    let out = res.buffer; try { out = (await tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
    await atomicWrite(file, out);
    const s = res.stats || {};
    const bits = [`${s.added || 0} added`];
    for (const k of ['resolved', 'updated', 'merged', 'closed', 'superseded', 'linked']) if (s[k]) bits.push(`${s[k]} ${k}`);
    // Correction receipt — a correction-cue note superseded a card cross-area /
    // below the plain 0.6 bar; say WHAT was archived and how to undo, so the
    // widened match is always confirmable rather than silent.
    const corr = (Array.isArray(s.corrections) && s.corrections.length)
      ? `\n↩︎ correction supersede: ${s.corrections.map(c => `"${c.old}"${c.area ? ` [${c.area}]` : ''} (overlap ${c.overlap})`).join('; ')} — archived + arrowed to your note. If it grabbed the wrong card, restore it from Archive or re-run with marker "~".`
      : '';
    // Name the resolved brain explicitly (basename + how) so a write never lands
    // in a surprise file silently — the write-side twin of the read-op stamp.
    return { blocks: [text(`✓ brain_note → ${path.basename(file)} (via ${t.how}) · ${bits.join(' · ')}. Reopen the brain in the KLYPIX app to see it.${corr}`)] };
  } catch (e) {
    return err(`brain_note failed (brain unchanged): ${e.message}`);
  }
}

// ── brain_message — the MCP twin of the hook's 🧠 MSG marker ─────────────────
// A DELIBERATE one-time note to the OTHER live agent sessions on this project
// ("merged the hook refactor — rebase before you commit"), delivered once to each
// peer at its next prompt via the per-project coordination lane. Hook agents send
// these by emitting `🧠 MSG [to]: text`; this op gives HOOKLESS clients (Cursor /
// Cline / Windsurf / Desktop) the same send path. Ephemeral (24h), NOT a brain
// card — durable decisions go through brain_note.
//
// The lane primitives below MUST byte-match src/global-brain-hook.mjs (sha-16 of
// normBrainPath(brain), sessions/<key>.json layout, MSG_FRESH_MS, the wx-lockfile) —
// the hook is the READER of what we post. test/lane-message.mjs drives the REAL
// hook over a message posted by this op; if the two implementations drift, it fails.
const laneSha16 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const laneNormBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const LANE_MSG_FRESH_MS = 24 * 60 * 60 * 1000;   // messages expire after a day
const LANE_SESSION_FRESH_MS = 10 * 60 * 1000;    // a lane unseen for 10min is treated as ended
// Canonicalize (on-disk casing + symlinks) before hashing — the hook does the same,
// so a brain resolved via a differently-cased cwd/KLYPIX_BRAIN still lands in the
// hook's lane file instead of a silently-unread sibling.
const laneCanon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const laneFileFor = (brainAbs) => path.join(os.homedir(), '.claude', 'project-brain', 'sessions', `${laneSha16(laneNormBrainPath(laneCanon(brainAbs)))}.json`);
const laneSleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
function laneLock(lockPath, tries = 20, waitMs = 25) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* */ }
  for (let i = 0; i < tries; i++) {
    try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch (e) {
      if (e && e.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 15000) { fs.unlinkSync(lockPath); continue; } } catch { /* lost a race — retry */ }
      laneSleep(waitMs);
    }
  }
  return false;   // contended → write best-effort (same contract as the hook)
}

export async function opBrainMessage({ vault, canvas, text: msgText, to, via }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const txt = String(msgText || '').trim();
  if (!txt) return err('brain_message needs a non-empty text.');
  const laneFile = laneFileFor(t.file);
  const lock = laneFile + '.lock';
  const now = Date.now();
  const msg = {
    id: laneSha16('mcp|' + txt + '|' + now + '|' + Math.random()),
    from: via ? String(via).replace(/\s+/g, '-').slice(0, 24) : 'mcp',
    // cap + collapse the target hint too — an oversized `to` would bloat the lane
    // file every hook of every session re-reads for 24h (and matches no one anyway)
    to: String(to || 'all').replace(/\s+/g, ' ').trim().slice(0, 64) || 'all',
    text: txt.slice(0, 400), ts: now, seen: [],
  };
  const got = laneLock(lock);
  let live = 0;
  try {
    let data = {}; try { data = JSON.parse(fs.readFileSync(laneFile, 'utf8')); } catch { /* fresh lane */ }
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    live = sessions.filter(s => s && s.id && now - (s.lastSeen || 0) < LANE_SESSION_FRESH_MS).length;
    const kept = (Array.isArray(data.messages) ? data.messages : []).filter(m => m && now - (m.ts || 0) < LANE_MSG_FRESH_MS);
    kept.push(msg);
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, JSON.stringify({ sessions, messages: kept.slice(-30) }));
  } catch (e) {
    return err(`brain_message failed: ${e.message}`);
  } finally { if (got) { try { fs.unlinkSync(lock); } catch { /* */ } } }
  return { blocks: [text(`📨 posted to this project's coordination lane (to: ${msg.to}) — ${live} live hook-wired session(s) right now; each sees it once at its next prompt. Hookless clients can send but not receive. Ephemeral (24h), not a brain card — use brain_note for durable decisions.`)] };
}

// Re-export the format helpers the bins need for non-op work (init onboarding).
export { buildKlypixMap, parseKlypix };
