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
  try { const cb = resolveCanvas(vault, 'brain') || resolveCanvas(vault, 'brain.klypix'); if (cb) curKey = path.resolve(cb).replace(/\\/g, '/').toLowerCase(); } catch { /* no current brain */ }
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

export async function opBrainInsights({ vault, canvas, staleDays }) {
  const file = resolveCanvas(vault, canvas || 'brain') || resolveCanvas(vault, 'brain.klypix');
  if (!file) return err(`No brain canvas found in ${vault}. Pass canvas: "<name>", or run \`npx klypix-mcp init\` to create one.`);
  try {
    const { struct } = await parseKlypix(fs.readFileSync(file));
    const ins = brainInsights(struct, staleDays ? { staleDays } : {});
    return { blocks: [text(insightsToMarkdown(ins, struct.title))] };
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
export async function opBrainReconcile({ vault, canvas, root }) {
  const file = resolveCanvas(vault, canvas || 'brain') || resolveCanvas(vault, 'brain.klypix');
  if (!file) return err(`No brain canvas found in ${vault}. Pass canvas: "<name>".`);
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  // Migrations live in the CODE repo (usually beside brain.klypix), not in a
  // separate canvas vault — so default the root to the brain file's folder.
  const repoRoot = root ? path.resolve(root) : path.dirname(file);
  const files = collectMigrationFiles(repoRoot);
  if (!files.length) return { blocks: [text(`No migration files under ${repoRoot} (looked in: ${MIGRATION_DIRS.join(', ')}). Nothing to reconcile.`)] };
  const { gaps, total } = findUnrecordedMigrations(struct, files, { max: 20 });
  if (!gaps.length) return { blocks: [text(`✓ All ${files.length} migration(s) under ${path.basename(repoRoot)} are referenced by a brain card — no unrecorded rollouts.`)] };
  const lines = gaps.map(g => `- \`${g.path}\` — committed, but no brain card mentions it. If applied to prod, record it:\n    \`🧠 BRAIN [DB] !: migration ${g.file.replace(/\.sql$/i, '')} applied to prod ev: ${g.path}\``);
  const more = total > gaps.length ? `\n\n…and ${total - gaps.length} more.` : '';
  return { blocks: [text(`# ⚠️ ${total} migration(s) committed but unrecorded in the brain\n_The brain can't see prod — it flags migrations that are in git but unmentioned, so you can confirm the rollout. It never asserts a migration was applied. To dismiss one without applying, record any card that names it (e.g. "committed, not applied")._\n\n${lines.join('\n')}${more}`)] };
}

export async function opBrainConnect({ vault, canvas, apply = false, max = 24, threshold = 0.45, log = () => {} }) {
  const file = resolveCanvas(vault, canvas || 'brain') || resolveCanvas(vault, 'brain.klypix');
  if (!file) return err(`No brain canvas found in ${vault}.`);
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const byId = new Map(struct.cards.map(c => [c.id, c]));
  const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !/^archive$/i.test(c.area || ''));
  const linked = new Set(struct.connections.map(c => [c.fromId, c.toId].sort().join('|')));

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
      blocks: [text(`Created ${out} — ${cards.length} cards, ${(connections || []).length} connections. Open it in KLYPIX (Canvas → Open).${detail}`)],
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
      blocks: [text(`Added ${cards.length} card(s) to ${path.relative(vault, file)}. Reopen the canvas in KLYPIX to see them.${detail}`)],
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
  const file = resolveCanvas(vault, canvas || 'brain') || resolveCanvas(vault, 'brain.klypix');
  if (!file) return err(`No brain canvas found in ${vault}. Pass canvas: "<name>".`);
  if (!noteText || !String(noteText).trim()) return err('brain_note needs a non-empty text.');
  if (!['', '?', '!', '✓', '~'].includes(marker)) return err(`Invalid marker "${marker}" — use: (none)=decision · ?=open question · !=milestone · ✓=resolve a matching card · ~=update a matching card.`);
  const input = noteToCaptureInput({ text: noteText, area, marker, closes: closes || '', createdVia: via || 'mcp' });
  try {
    const res = await captureIntoBrain(fs.readFileSync(file), input);
    let out = res.buffer; try { out = (await tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
    await atomicWrite(file, out);
    const s = res.stats || {};
    const bits = [`${s.added || 0} added`];
    for (const k of ['resolved', 'updated', 'closed', 'superseded', 'linked']) if (s[k]) bits.push(`${s[k]} ${k}`);
    return { blocks: [text(`✓ brain_note → ${path.relative(vault, file)} (${bits.join(' · ')}). Reopen the brain in KLYPIX to see it.`)] };
  } catch (e) {
    return err(`brain_note failed (brain unchanged): ${e.message}`);
  }
}

// Re-export the format helpers the bins need for non-op work (init onboarding).
export { buildKlypixMap, parseKlypix };
