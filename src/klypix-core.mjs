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
  brainInsights, insightsToMarkdown, insightsAreasToMarkdown, insightsStatusToMarkdown,
  areaStatusDigest, addBrainConnections, proposeStructuralConnections, atomicWrite,
  findUnrecordedMigrations, captureIntoBrain, tidyBrain, noteToCaptureInput,
  selectGardenCandidates, applyGarden, detectContradictions,
  rankForQuestion, questionContextToMarkdown, findLegacyShipCards,
  challengeBrain, challengeContextToMarkdown, buildRenderSpec, structToBrief,
  brainLensData, lensToMarkdown, deathDateOfCard,
  statusContextToMarkdown, findFulfillmentCandidates,
  splitQueryTokens, scoreCardsAgainstQuery, correctionOverlaysFor,
  isFastDecayCard, isUnresolvedOpenCard, isSkillCard, validateGuard, DECAY_STALE_MS, formatDecayAge,
  isPlanCard, planFulfillmentFor, PLAN_PAIR_SIM_BRAIN, isAgconfTwinId,
  readPendingShips, clearPendingShips, pendingShipCards, formatCaptureReceipts,
} from './klypix-format.mjs';
import { findProjectBrain, postPresenceMessage } from './agent-presence.mjs';
import { brainCaptureLockPath, vaultCreateLockPath, withAdvisoryWriteLock } from './brain-write-lock.mjs';
import {
  dot, embedTexts, getEmbedder, getEmbedderForUse, withRerankerForUse,
  rerankHits, semanticFallbackNotice, semanticMemorySnapshot,
  semanticRuntimeInstalled, shouldPrewarmSemantic, vectorsForBrain,
  cachedVectorsForBrain,
} from './semantic-memory.mjs';

// The MCP and A2A faces prewarm through this protocol-neutral module. Bounded
// mode is lazy; setting KLYPIX_SEMANTIC_MEMORY_MODE=legacy restores the exact
// eager lifecycle without changing any tool contract.
export { getEmbedder, semanticMemorySnapshot, shouldPrewarmSemantic };

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
//   2. nearest brain.klypix / brain.any at-or-above the launch cwd — the
//      project brain (coding agents may launch from a project subdirectory)
//   3. <vault>/brain.klypix (exact) — when the vault itself is the brain's home
//   4. a SINGLE brain.klypix found by walking the vault; if MORE THAN ONE exists
//      we REFUSE to guess (returns { ambiguous }) instead of silently taking one.
export function resolveDefaultBrain(vault) {
  const ex = (p) => { try { return p && fs.existsSync(p) ? path.resolve(p) : null; } catch { return null; } };
  let f;
  if ((f = ex(process.env.KLYPIX_BRAIN))) return { file: f, how: 'env (KLYPIX_BRAIN)' };
  if ((f = findProjectBrain(process.cwd()))) {
    const how = path.dirname(f) === path.resolve(process.cwd()) ? 'project cwd' : 'project ancestor';
    return { file: f, how };
  }
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

// ── On-device semantic memory (bounded, local, self-healing) ─────────────────
// Neural lifecycle and resource ownership live in semantic-memory.mjs. The
// deterministic correction-aware core below remains independently available.
const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// Death-date reads go through the ONE shared reader in klypix-format —
// this file used to carry a divergent local regex (missing the bare
// "↩ superseded" variant AND the gardener's "⤵ consolidated" stamp), so
// cross-brain as_of was silently stricter than brain_ask as_of (2026-07-23).

// ── On-device cross-encoder reranker (brain_ask, opt-in experiment) ──────────
// RETIRED as a default after the 2026-08-10 harness fix. The "recall@5 15%→40%"
// that once justified it here was measured in a vector space the product does
// not use (mean-pooled, unprefixed queries — the broken pre-fix harness).
// Re-measured with the PRODUCTION embedder on the frozen human-paraphrase set:
// the single BGE pass scores recall@5 30% / MRR 0.22; adding the reranker DROPS
// that to 25% / 0.167 and costs ~3.5s/query. It still scores (question, card)
// pairs jointly with full token interaction; keep it reachable for experiments
// via KLYPIX_RERANK=1 (opt-IN — off by default; see the gate below).

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
      // Matching stays recall-first (an archived card CAN be the right answer to
      // "what did we try?"), but an archived hit is now labelled. Unlabelled, a
      // superseded or retired decision read exactly like a current one.
      const isArchived = (c) => /^archive$/i.test(c.area || '');
      const n = struct.counts;
      const head = `## ${rel} — "${struct.title}" · ${n.live ?? n.cards} live cards${n.archived ? `, ${n.archived} archived` : ''}, ${n.connections} connections${nameMatch && !matched.length ? '  (name/title match)' : ''}`;
      const body = matched.slice(0, 8).map(c => {
        const pos = (c.pos && c.pos.x != null) ? ` @(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '';
        const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
        const arch = isArchived(c) ? ' ⛔ archived' : '';
        return `- [${c.type}] "${c.title || '(card)'}" (${c.id})${pos}${tags}${arch}\n    ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
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

  // Queue saturation (KLYPIX_SEMANTIC_QUEUE_FULL) must degrade to lexical, not
  // error — this tool's own description promises "degrades cleanly".
  let pipe = null;
  try { pipe = await getEmbedderForUse(log, 20_000); } catch { /* saturated/unavailable → lexical only */ }
  let qv = null;
  if (pipe) { try { [qv] = await embedTexts(pipe, [q], { kind: 'query' }); } catch { /* lexical only */ } }

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
        const died = isArchived ? deathDateOfCard(c) : null;
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
  // Never say "warming — retry" to someone who simply has not installed the
  // runtime: for them that advice is wrong forever, and their results are the
  // measured recall@5 = 0% lexical path rather than a slow good one.
  const mode = qv ? 'semantic+lexical (on-device)' : semanticFallbackNotice(false);
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
// Fast, bounded task context for brain_sync. Unlike brain_ask, this path never
// loads an embedding model or reranker: one MCP call should coordinate peers
// AND provide enough current project memory to begin work without making every
// Codex session read the full generated brief.
export async function opBrainTaskContext({
  vault,
  canvas,
  intent,
  files = [],
  k = 5,
  budgetChars = 2800,
}) {
  const startedAt = Date.now();
  const task = String(intent || '').replace(/\s+/g, ' ').trim();
  const scopedFiles = (Array.isArray(files) ? files : [])
    .map((file) => String(file || '').replace(/\\/g, '/').trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!task && !scopedFiles.length) {
    return {
      blocks: [text('Task context: no intent or files were supplied, so no brain cards were retrieved.')],
      context: { mode: 'lexical-fast', hits: [], sufficient: false, durationMs: Date.now() - startedAt },
    };
  }
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) {
    return {
      blocks: [text('Task context unavailable: no project brain was found.')],
      context: { mode: 'lexical-fast', hits: [], sufficient: false, durationMs: Date.now() - startedAt },
    };
  }
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(t.file))); }
  catch (e) { return err(`Task context read failed: ${e.message}`); }

  const generic = new Set(['src', 'app', 'lib', 'components', 'component', 'scripts', 'public', 'test', 'tests', 'electron']);
  const fileTerms = scopedFiles.flatMap((file) => {
    const parts = file.toLowerCase().split('/').filter(Boolean);
    const base = (parts.pop() || '').replace(/\.[a-z0-9]+$/i, '');
    return [base, ...parts.filter((part) => part.length >= 3 && !generic.has(part))];
  });
  const split = splitQueryTokens(`${task} ${fileTerms.join(' ')}`);
  const tokens = [...new Set(split.content)];
  const hitLimit = Math.max(1, Math.min(8, Number(k) || 5));
  // Score a wider pool once so a newly captured, relevant open gap cannot be
  // crowded out by older high-frequency area vocabulary. This exact failure
  // made the founder repeat yesterday's A→B→C researcher finding: after its
  // false closure was repaired, generic historical "Brain" cards still filled
  // the top five. A fresh open is promoted only when it already clears a real
  // lexical floor; recency never turns an unrelated card into a match.
  // The ranker already scores/sorts the whole live set. Keep every qualifying
  // candidate for the recency guard; truncating to 64 here recreated the exact
  // crowd-out bug whenever 64 historical cards scored above a fresh open gap.
  const candidatePool = scoreCardsAgainstQuery(struct, tokens, {
    topK: Math.max(64, struct.cards?.length || 0),
    minScore: 2,
  });
  const recentOpenCutoff = Date.now() - 3 * 86_400_000;
  const recentOpen = candidatePool
    .filter((hit) => hit.score >= 3
      && isUnresolvedOpenCard(hit.card)
      && Number(hit.card.createdAt || 0) >= recentOpenCutoff)
    .slice(0, 2);
  const hits = [];
  const hitIds = new Set();
  for (const hit of [...recentOpen, ...candidatePool]) {
    if (!hit?.card?.id || hitIds.has(hit.card.id)) continue;
    hitIds.add(hit.card.id);
    hits.push(hit);
    if (hits.length >= hitLimit) break;
  }
  const recentOpenIds = new Set(recentOpen.map((hit) => hit.card.id));
  let overlays = new Map();
  try { overlays = correctionOverlaysFor(struct, hits.map((hit) => hit.card)); }
  catch { /* context remains useful without overlays */ }
  // Plan→🏁 hints (2026-08-23): a recalled PLAN/PROPOSAL whose feature a newer
  // 🏁 appears to have shipped. Brain-wide (the ship card is usually renamed
  // and not in this hit set), embedding-first from the READ-ONLY warm vector
  // cache — this fast path never loads the model — strict lexical bars when
  // no cache exists. Only paid when a plan-shaped card is among the hits.
  let planHints = new Map();
  try {
    const planCards = hits.map((hit) => hit.card).filter((card) => isPlanCard(card));
    if (planCards.length) {
      let pairSim = null;
      try {
        const vecs = cachedVectorsForBrain(t.file, struct.cards);
        if (vecs && vecs.size) pairSim = (a, b) => { const va = vecs.get(a), vb = vecs.get(b); return va && vb ? dot(va, vb) : null; };
      } catch { pairSim = null; }
      planHints = planFulfillmentFor(struct, planCards, { pairSim, scope: 'brain' });
    }
  } catch { planHints = new Map(); }

  const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const clip = (value, limit) => {
    const clean = flat(value);
    return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
  };
  // Decay-aware status (2026-07-28 post-mortem): a fast-decay build/deploy
  // claim >6h old is stamped ⏱️ LAST KNOWN at the ENTRY level, so every
  // brain_sync host (Codex included — this is its only context surface, it
  // never calls statusContextToMarkdown) gets the warning from the engine,
  // not from model judgment. Best-effort: classification failure → no stamp.
  const nowTs = Date.now();
  const entries = hits.map((hit) => {
    const correction = overlays.get(hit.card.id)?.by || null;
    const plan = planHints.get(hit.card.id) || null;
    let decayAge = null;
    try {
      const ageMs = (hit.card.createdAt || 0) > 0 ? nowTs - hit.card.createdAt : 0;
      if (ageMs > DECAY_STALE_MS && isFastDecayCard(hit.card)) decayAge = formatDecayAge(ageMs);
    } catch { decayAge = null; }
    return {
      id: hit.card.id,
      area: flat(hit.card.area) || 'Notes',
      text: clip(hit.card.text, 420),
      score: Number(hit.score.toFixed(2)),
      correctedBy: correction ? clip(correction.text, 420) : null,
      ...(recentOpenIds.has(hit.card.id) ? { recentOpen: true } : {}),
      ...(decayAge ? { lastKnown: true, age: decayAge } : {}),
      ...(plan ? { possiblyBuilt: { by: clip(plan.by, 200), byId: plan.byId, ...(plan.sim != null ? { sim: plan.sim } : {}) } } : {}),
    };
  });
  const maxChars = Math.max(800, Math.min(5000, Number(budgetChars) || 2800));
  // Standing rules (2026-08-24 audit): 🛠️ skills are "apply every session",
  // but the ranker's `score <= 0` gate drops a zero-overlap rule BEFORE its +1
  // skill boost applies — so the capsule delivered task hits and zero standing
  // rules, and the rule that would have warned the founder about a same-day
  // billing trap never reached any session. This block is UNCONDITIONAL:
  // relevance-ordered when the ranker scored a rule, newest-first otherwise,
  // deduped against the hit list, and prepended so the maxChars tail-cut can
  // never be the reason a rule silently vanished.
  const skillPool = struct.cards.filter((c) => c.type !== 'container'
    && !/^archive$/i.test(c.area || '') && isSkillCard(c));
  const scoreById = new Map(candidatePool.map((hit) => [hit.card.id, hit.score]));
  const standing = skillPool
    .filter((c) => !hitIds.has(c.id))
    .sort((a, b) => (scoreById.get(b.id) || 0) - (scoreById.get(a.id) || 0)
      || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 3);
  const lines = [
    `## Compact task context (${entries.length} relevant brain card${entries.length === 1 ? '' : 's'} · lexical-fast)`,
  ];
  if (standing.length) {
    lines.push(`### 🛠️ Standing rules (${skillPool.length} in the brain — apply always; full set in the brief)`);
    for (const c of standing) lines.push(`- [${flat(c.area) || 'Notes'}] ${clip(c.text, 220)}`);
  }
  if (!entries.length) {
    lines.push('No high-confidence task-specific card matched. Continue from repository evidence; use brain_ask only if deeper project history is needed.');
  } else {
    for (const entry of entries) {
      if (entry.correctedBy) lines.push(`- [${entry.area}] CURRENT CORRECTION: ${entry.correctedBy}`);
      // The LAST KNOWN stamp is a PREFIX: the final .slice(0, maxChars) can cut
      // a line's tail, and the warning must never be the part that gets cut
      // (v1.32.0 law — a claim may truncate, its warning may not).
      const stamp = entry.lastKnown ? ` ⏱️ LAST KNOWN (${entry.age} old — verify live before reporting):` : '';
      const openStamp = entry.recentOpen ? ' ❓ RECENT OPEN:' : '';
      // Same prefix discipline as LAST KNOWN: the hint can never be the part a
      // budget cut removes. It names the ship so the reader can verify it.
      const planStamp = entry.possiblyBuilt ? ` ⏳ POSSIBLY BUILT (a newer 🏁 appears to ship this plan: “${entry.possiblyBuilt.by}” — verify before treating it as only a plan/proposal):` : '';
      lines.push(`- [${entry.area}]${entry.correctedBy ? ' superseded context:' : ''}${openStamp}${stamp}${planStamp} ${entry.text}`);
      if (lines.join('\n').length >= maxChars) break;
    }
    lines.push('This is a bounded start-of-task capsule, not the whole brain; use brain_ask for broad status/history questions.');
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  return {
    blocks: [text(lines.join('\n').slice(0, maxChars))],
    context: {
      mode: 'lexical-fast',
      hits: entries,
      ...(standing.length ? {
        standingRules: standing.map((c) => ({ id: c.id, area: flat(c.area) || 'Notes', text: clip(c.text, 220) })),
      } : {}),
      sufficient: entries.length > 0,
      durationMs,
      brain: path.basename(t.file),
    },
  };
}

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
  let semantic = null, mode = 'lexical', cardVecs = null;
  try {
    const pipe = await getEmbedderForUse(log, 20_000);
    if (pipe) {
      const [qv] = await embedTexts(pipe, [q], { kind: 'query' });
      const vecs = await vectorsForBrain(pipe, t.file, struct.cards);
      if (qv && vecs && vecs.size) { semantic = new Map(); for (const [id, v] of vecs) semantic.set(id, dot(qv, v)); cardVecs = vecs; mode = 'semantic+lexical (on-device)'; }
    }
  } catch { semantic = null; cardVecs = null; }
  // Parity with search_all_brains (8445e9c): never say "warming — retry" to a
  // host with no runtime installed — for them that advice is wrong forever and
  // their results are the measured recall@5 = 0% lexical path. The full notice
  // is a SEPARATE advisory line: gluing three sentences and a filesystem path
  // into the "N matched, X ranking" header garbled every lexical-only answer
  // (2026-08-14 review), and later "+ rerank"/"+ status-mode" suffixes would
  // have landed mid-sentence.
  let fallbackNotice = null;
  if (!semantic) {
    fallbackNotice = semanticFallbackNotice(false);
    if (fallbackNotice) mode = fallbackNotice.startsWith('LEXICAL ONLY') ? 'lexical-only (no semantic runtime)' : 'lexical (semantic warming)';
  }
  const kk = Math.max(1, Math.min(20, k || 10));
  const timeTravel = asOfTs != null;
  // Cross-encoder rerank is OPT-IN. On the frozen human/paraphrase set it made
  // BGE top-5 recall worse (30%→25%) and added ~3.5s/query. Keep the reversible
  // escape hatch for experiments, but the best measured experience is the single
  // BGE pass. Suppressed under as_of either way.
  const wantRerank = !timeTravel && process.env.KLYPIX_RERANK === '1';
  // Card↔card cosine for the serve-time ❓↔🏁 pairing pass — the same on-device
  // vectors that rank the question, reused; null degrades pairing to its
  // lexical anchor/coverage fallback (works on every host, embeddings or not).
  const pairSim = cardVecs ? (a, b) => { const va = cardVecs.get(a), vb = cardVecs.get(b); return va && vb ? dot(va, vb) : null; } : null;
  const result = rankForQuestion(struct, q, { semantic, k: wantRerank ? Math.max(kk, 50) : kk, as_of: timeTravel ? as_of : null, pairSim });
  if (wantRerank && result.hits.length > 1) {
    try {
      const reranked = await withRerankerForUse(log, 8_000, rr => rerankHits(rr, q, result.hits));
      if (reranked) { result.hits = reranked; mode += ' + rerank'; }
    } catch { /* keep the pre-rerank order */ }
    result.hits = result.hits.slice(0, kk);
  }
  // STATUS MODE (T7, 2026-07-23): a status-shaped question ("what is
  // remaining?") gets the COMPUTED current-state section prepended — per-area
  // digest, opens with overdue/corrected/likely-fulfilled flags, newest 🏁s.
  // The lexical hits stay below as supporting context. Suppressed under as_of
  // (time-travel answers stay deterministic ranked-card answers).
  // STRONG shape only: a work request that merely mentions 'pending'/'TODO'
  // must keep its ranked answer (review fix); the phrase-shaped "what is
  // remaining?" gets the computed section.
  // Decay-aware stamps (⏱️ LAST KNOWN + VERIFY probe on >6h build/deploy
  // claims) ride IN the renderer — statusContextToMarkdown stamps internally,
  // so this call inherits them with no options needed (now defaults inside).
  let statusMd = '';
  if (result.statusStrong && !timeTravel) {
    try { statusMd = statusContextToMarkdown(struct); mode += ' + status-mode'; } catch { statusMd = ''; }
  }
  const noticeMd = fallbackNotice ? `> ${fallbackNotice}\n\n` : '';
  return { blocks: [text(stamp + noticeMd + statusMd + questionContextToMarkdown(q, result, { mode, as_of: timeTravel ? as_of : null }))] };
}

// ── brain_challenge — the adversarial brain ───────────────────────────────────
// surface: given a PROPOSED decision, argue back with receipts (deterministic
// contradictions, 🛠 standing rules, tried-and-reversed chains, open-question
// collisions). READ-ONLY — parse → analyze → render; never writes. Semantic
// ranking is best-effort exactly like opBrainAsk (degrades to lexical).
export async function opBrainChallenge({ vault, canvas, claim, k = 8, via, log = () => {} }) {
  const q = String(claim || '').trim();
  if (!q) return err('brain_challenge needs a claim — the proposed decision to argue against.');
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(t.file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(t.file, struct, t.how);
  let semantic = null, mode = 'lexical';
  try {
    const pipe = await getEmbedderForUse(log, 20_000);
    if (pipe) {
      const [qv] = await embedTexts(pipe, [q], { kind: 'query' });
      const vecs = await vectorsForBrain(pipe, t.file, struct.cards);
      if (qv && vecs && vecs.size) { semantic = new Map(); for (const [id, v] of vecs) semantic.set(id, dot(qv, v)); mode = 'semantic+lexical (on-device)'; }
    }
  } catch { semantic = null; }
  const result = challengeBrain(struct, q, { semantic, k: Math.max(1, Math.min(20, k || 8)) });
  return { blocks: [text(stamp + challengeContextToMarkdown(q, result, { mode, via }))] };
}

// ── canvas_view — the whiteboard-in-chat MCP App ──────────────────────────────
// surface: parse a canvas (default: the project brain) into a budgeted render
// spec. In an MCP Apps host the spec drives the self-contained canvas-view
// iframe (declared in bin); in any other host the text summary alone is a
// useful answer. READ-ONLY. The `structured` field is lifted to the tool
// result's structuredContent by the bin handler.
export async function opCanvasView({ vault, canvas }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No canvas found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  let parsed;
  try { parsed = await parseKlypix(fs.readFileSync(t.file)); } catch (e) { return err(`Read failed: ${e.message}`); }
  const { struct, canvas: canvasJson, zip } = parsed;
  const renderSpec = await buildRenderSpec({ struct, canvas: canvasJson, zip });
  const stamp = brainStamp(t.file, struct, t.how);
  const summary = `${stamp}Rendered “${struct.title}” — ${renderSpec.items.length} items · ${renderSpec.connections.length} connections`
    + `${renderSpec.counts.truncated ? ` · ${renderSpec.counts.truncated} truncated for budget` : ''}`
    + `${renderSpec.counts.strokes ? ` · ${renderSpec.counts.strokes} ink strokes not shown` : ''}\n\n`
    + structToBrief(struct, { maxRecent: 10, maxMilestones: 4, maxConnections: 0, maxSkills: 6 });
  return { blocks: [text(summary)], structured: { renderSpec } };
}

// ── Brain lens (machine-readable views: the desktop Lenses' data twin) ───────
// One structured payload per view so agents AND product surfaces (web viewer,
// iOS) render the same picture from the same source: freshness buckets,
// provenance channels, 7-day activity, birth-order timeline (the Replay
// spine), orrery neighborhood, and open-❓ triage. Read-only by construction.
export async function opBrainLens({ vault, canvas, view = 'all', root, staleDays, limit, structured: wantStructured = false }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const VIEWS = new Set(['all', 'freshness', 'provenance', 'activity', 'timeline', 'orrery', 'unresolved']);
  const v = VIEWS.has(String(view)) ? String(view) : 'all';
  try {
    const { struct } = await parseKlypix(fs.readFileSync(t.file));
    const lens = brainLensData(struct, {
      ...(root ? { root } : {}),
      ...(Number(staleDays) > 0 ? { staleDays: Number(staleDays) } : {}),
      ...(Number(limit) > 0 ? { limit: Number(limit) } : {}),
    });
    // Timeline events are the one unbounded field — included only when the
    // caller explicitly asks for the timeline view (products replaying).
    const structured = v === 'timeline'
      ? lens
      : { ...lens, timeline: { ...lens.timeline, events: [] } };
    // The machine-readable payload is OPT-IN, because it was view-independent:
    // `freshness`, whose text is 659 chars, shipped the same ~50KB object as
    // `all`, and `timeline` shipped ~146KB — every call, to every host, whether
    // or not anything consumed it. No tool here declares an outputSchema, so it
    // was never contractual; a product that wants the data asks for it.
    const out = { blocks: [text(brainStamp(t.file, struct, t.how) + lensToMarkdown(lens, v))] };
    if (wantStructured) out.structured = { lens: structured, view: v };
    return out;
  } catch (e) {
    return err(`Lens failed: ${e.message}`);
  }
}

export async function opBrainInsights({ vault, canvas, staleDays, view = 'full' }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>", or run \`npx klypix-mcp init\` to create one.`);
  try {
    const { struct } = await parseKlypix(fs.readFileSync(t.file));
    const ins = brainInsights(struct, staleDays ? { staleDays } : {});
    // 'areas' and 'status' are ORIENTATION views — a category map an agent reads
    // before deciding what to retrieve. Both are a fraction of the full report,
    // and 'status' is the first time areaStatusDigest is reachable from any MCP
    // host rather than only through the Claude-Code prompt hook.
    const body = view === 'areas'
      ? insightsAreasToMarkdown(ins, struct.title)
      : view === 'status'
        ? insightsStatusToMarkdown(areaStatusDigest(struct), ins, struct.title)
        : insightsToMarkdown(ins, struct.title);
    return { blocks: [text(brainStamp(t.file, struct, t.how) + body)] };
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
export async function opBrainReconcile({ vault, canvas, root, mode = 'all', log = () => {} }) {
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

  // (1c) CLAIMS (T9, 2026-07-23) — the retroactive fulfillment sweep: live
  // "remaining:/next:/pending:" prose clauses AND ❓/🎯 cards reconciled
  // against LATER live 🏁 milestones via the ONE shared claim extractor. This
  // is how corpses that predate the capture-time cross-check get found (the
  // incident card sat fulfilled-but-open for a week). Receipts show the
  // covered item AND the uncovered remainder so partial fulfillment can never
  // be approved whole. Suggestion-only — every retirement is a human ✓.
  if (mode === 'all' || mode === 'claims') {
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const miles = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c) && /🏁/.test(c.text) && !/❓|🎯/.test(c.text));
    const cands = findFulfillmentCandidates(struct, miles, { maxPerMilestone: 2 }).slice(0, 12);
    if (cands.length) {
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const lines = cands.map((c, i) =>
        `${i + 1}. [${c.open.area || '?'}] (id ${c.open.id}) claim: “${flat(c.item).slice(0, 100)}” · coverage ${c.cov}\n`
        + `   · likely fulfilled by [${c.milestone.area || '?'}] ${flat(c.milestone.text).slice(0, 140)}\n`
        + (c.uncovered.length ? `   · ⚠️ PARTIAL — does NOT cover: ${c.uncovered.map(u => `“${flat(u).slice(0, 60)}”`).join(' · ')}\n` : '')
        + ((!c.uncovered.length && c.resolvable)
            ? `   · confirm: \`🧠 BRAIN [${c.open.area || 'Notes'}] ✓: ${flat(c.item).slice(0, 80)}\``
            : `   · no ✓ suggested (${c.uncovered.length ? 'partial — the card stays open; a ✓ would engage the partial-resolve path only after full coverage' : 'item too short to resolve safely'}) — verify by hand`));
      sections.push(`# ⏳ ${cands.length} open claim(s) a later milestone likely fulfilled\n_Candidates with receipts — nothing was changed, nothing auto-archives. A ✓ is only suggested for FULLY covered claims. Dismiss a wrong hint permanently: \`brain_connect\` with \`pairs:[{fromId:<open id>, toId:<milestone id>}]\` and \`relationship:"not_fulfilled"\` — it will never be re-suggested._\n\n${lines.join('\n')}`);
    } else if (mode === 'claims') {
      sections.push('✓ No fulfilled-claim candidates — no live open clause is covered by a later milestone.');
    }
  }

  // (1d) PLANS (2026-08-23, AgentLit incident) — plan / proposal / "design
  // decided" cards that never carried a ❓, reconciled against LATER live 🏁
  // milestones — embedding-first (the ship is usually RENAMED, so lexical
  // coverage alone misses it: the incident pair measured cov 0.20, 0 anchors,
  // cosine 0.81), strict lexical bars when no vectors exist. The retroactive
  // plan-vs-shipped sweep: every hit is a suggestion with its receipt; the ✓
  // is a human act and archives the plan as fulfilled HISTORY (still
  // retrievable, flagged) — nothing is deleted or hidden.
  // Mode 'all' (the default) stays READ-ONLY and side-effect free: cached
  // vectors only — no model load, no cross-process cache lock, no cache write
  // (review 2026-08-23). Only an explicit mode:"plans" may embed, with the
  // bounded model load; a cold cache is reported as such, never as "no model".
  if (mode === 'all' || mode === 'plans') {
    try {
      const isArchived = (c) => /^archive$/i.test(c.area || '');
      const textCards = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim());
      const planCards = textCards.filter(c => !isArchived(c) && isPlanCard(c));
      if (!planCards.length) {
        if (mode === 'plans') sections.push('✓ No plan-shaped cards (proposal / planned / design decided …) are live — nothing to reconcile against the ships.');
      } else {
        let vecs = null, embedErr = null;
        try { vecs = cachedVectorsForBrain(file, struct.cards); } catch { vecs = null; }
        const installed = (() => { try { return semanticRuntimeInstalled(); } catch { return false; } })();
        const cold = !vecs || vecs.size < Math.ceil(0.5 * textCards.length);
        if (mode === 'plans' && cold && installed) {
          try {
            const pipe = await getEmbedderForUse(log, 20_000);
            if (pipe) vecs = await vectorsForBrain(pipe, file, struct.cards);
          } catch (e) { embedErr = e; }
        }
        let pairSim = null, how;
        if (vecs && vecs.size) {
          pairSim = (a, b) => { const va = vecs.get(a), vb = vecs.get(b); return va && vb ? dot(va, vb) : null; };
          how = `on-device embedding ≥ ${PLAN_PAIR_SIM_BRAIN} + lexical corroboration (${vecs.size} of ${textCards.length} cards vectorized), lexical strict bars for the rest`;
        } else if (!installed) {
          how = 'lexical strict bars (no on-device model installed — coverage ≥ 0.6 or rare shared anchors)';
        } else if (mode === 'plans') {
          how = `lexical strict bars (embedding unavailable${embedErr ? `: ${embedErr.code || embedErr.message}` : ' — model still warming or the inference queue is saturated; retry shortly'})`;
        } else {
          how = 'lexical strict bars (vector cache cold — run brain_ask once, or mode:"plans", to vectorize this brain)';
        }
        const hints = planFulfillmentFor(struct, planCards, { pairSim, scope: 'brain' });
        if (!hints.size) {
          if (mode === 'plans') sections.push(`✓ No plan/proposal card looks built by a later milestone (${planCards.length} plan-shaped card(s) checked · ${how}).`);
        } else {
          const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const byId = new Map(struct.cards.map(c => [c.id, c]));
          // Identical-text twins (pre-1.49 merge residue) collapse to one row,
          // the original's id preferred — a brain awaiting its Arrange heal
          // must not list the same plan twice.
          const byText = new Map();
          for (const [id, h] of hints) {
            const plan = byId.get(id), by = byId.get(h.byId);
            if (!plan || !by) continue;
            const k = String(plan.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const prev = byText.get(k);
            if (!prev || (isAgconfTwinId(prev.plan.id) && !isAgconfTwinId(plan.id))) byText.set(k, { plan, by, h });
          }
          const all = [...byText.values()].sort((a, b) => ((b.h.sim ?? 0) + b.h.cov) - ((a.h.sim ?? 0) + a.h.cov));
          const rows = all.slice(0, 20);
          const lines = rows.map((r, i) =>
            `${i + 1}. [${r.plan.area || '?'}] (id ${r.plan.id}) PLAN: ${flat(r.plan.text).slice(0, 150)}\n`
            + `   · looks BUILT by [${r.by.area || '?'}] (id ${r.by.id}) ${flat(r.by.text).slice(0, 150)}\n`
            + `   · receipt: ${r.h.sim != null ? `sim ${r.h.sim} · ` : ''}coverage ${r.h.cov} · via ${r.h.via}\n`
            + `   · if built: \`🧠 BRAIN [${r.plan.area || 'Notes'}] ✓: ${flat(r.plan.text).replace(/^[^:\n]{1,40}:\s*/, '').slice(0, 80)}\` · if not: brain_connect pairs:[{fromId:"${r.plan.id}", toId:"${r.by.id}"}] relationship:"not_fulfilled"`);
          const more = all.length > rows.length ? `\n\n…and ${all.length - rows.length} more.` : '';
          sections.push(`# 🧩 ${all.length} plan/proposal card(s) a later 🏁 appears to have BUILT\n_Suggestions with receipts (${how}) — nothing was changed. These cards read as plans, so recall keeps serving them as current intent ("it's only a proposal") while the feature is live. VERIFY each against the repo, then confirm with the ✓ marker (archives the plan as fulfilled history — it stays retrievable, flagged) or add \`closes: <plan title>\` to the milestone; dismiss a wrong pair permanently with the brain_connect call shown._\n\n${lines.join('\n')}${more}`);
        }
      }
    } catch { /* best-effort section — the rest of reconcile stands */ }
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
// HUMAN GATE (2026-07-23, hardened same day after adversarial review): apply
// used to be a bare flag the dry-run TEXT invited the agent to set — a
// model-proposes-model-approves loop with zero human in it. Apply now requires
// `approve: "<code>"` derived from the exact candidate set + day, and the code
// is deliberately NOT printed in the dry-run response — the HUMAN obtains it
// out-of-band by running `npx klypix-mcp garden-code` in the project (or via
// the app's Brain Health pill) and pastes it into chat after reviewing the
// plan. An agent that never showed the human the plan never gets the code.
// Stale approvals die when the selection or the day changes.
export const gardenApprovalCode = (areas) =>
  sha1(areas.map(a => a.candidates.map(c => c.id).sort().join(',')).sort().join('|') + '|' + new Date().toISOString().slice(0, 10)).slice(0, 8);

// ── in-process write serialization ──────────────────────────────────────────
// EVERY write below is read-modify-write: read the file, append/merge/tidy, write
// it back. Two callers that interleave inside ONE process both read the same
// pre-write bytes, and the second rename wins — so the first caller's cards are
// gone while its result still says "added". `atomicWrite` is rename-atomic: it
// prevents a TORN file, never a LOST UPDATE. Measured before this landed: five
// parallel opAddToCanvas calls reported five successes and left ONE card on disk;
// the same five run serially left five. That is silent loss in the subsystem whose
// promise is lossless merge.
//
// The A2A face is what made it reachable — node:http serves requests concurrently
// — but the defect is here in the engine, so the MCP server and every CLI bin
// inherit the fix.
//
// The promise chain is layer 1 (within this server). Layer 2 below joins the
// SAME cross-process `.claude/brain-capture.lock` used by the desktop app and
// lifecycle hooks, so separate MCP/A2A servers cannot race each other or those
// writers. Both layers are required: a rename is atomic but read-modify-write
// is not.
const writeChains = new Map();   // resolved lowercased path → tail promise

function withWriteLock(key, fn) {
  const k = String(key).toLowerCase();
  const prev = writeChains.get(k) || Promise.resolve();
  // Run regardless of how the predecessor settled: one caller's failed write must
  // not fail the next. Two separate callbacks, NOT `.then(fn, fn)` — that form
  // passes the previous result/error in as fn's first argument.
  const run = prev.then(() => fn(), () => fn());
  // Store a settled-either-way tail so a rejection here is never unhandled.
  const tail = run.then(() => {}, () => {});
  writeChains.set(k, tail);
  // Prune once we are the last link, so a long-lived server cannot retain one
  // entry per canvas path forever. If a newer caller already replaced the tail,
  // leave it alone — that chain is still live.
  tail.then(() => { if (writeChains.get(k) === tail) writeChains.delete(k); });
  return run;
}

// Writes to an existing canvas serialize on that canvas. Different files stay
// fully parallel.
const lockBusy = (kind) => err(
  `${kind} write was not applied because another process held the project write lock past the safety budget. ` +
  'Nothing was overwritten; retry the same operation.'
);

const withCanvasWriteLock = (file, fn, { brain = false } = {}) =>
  withWriteLock(path.resolve(file), () => {
    if (!brain) return fn();
    return withAdvisoryWriteLock(brainCaptureLockPath(file), (locked) => locked ? fn() : lockBusy('Brain'));
  });

// Creation serializes on the VAULT, not the file: `safeName` picks a name by
// probing the directory, so two concurrent creates of the same title would both
// see the name free and the second would overwrite the first. Creates are rare;
// serializing them per-vault costs nothing real.
const withVaultCreateLock = (vault, fn) => withWriteLock('vault:' + path.resolve(vault), () =>
  withAdvisoryWriteLock(vaultCreateLockPath(vault), (locked) => locked ? fn() : lockBusy('Canvas creation'))
);

export async function opBrainGarden({ vault, canvas, apply = false, syntheses, approve = '' }) {
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
    return { blocks: [text(stamp + `# 🌿 Gardener — ${areas.length} area(s) with DORMANT cards to consolidate\nThese are old, peripheral (≤1 link) cards only — hubs and still-referenced decisions were left untouched. For EACH area below, write ONE tight synthesis (3-6 sentences, plain prose, no headers) that preserves every still-relevant fact / decision / number and drops only repetition + play-by-play.\n\n⚠️ HUMAN APPROVAL REQUIRED — this pass ARCHIVES cards, and the approval code is NOT given to you. Show the human this plan (areas + card list + your syntheses) and ask them to run \`npx klypix-mcp garden-code\` in this project; they will paste an 8-character code into chat if — and only if — they approve. Then call \`brain_garden\` again with \`apply:true\`, \`syntheses: [{ "title": "<area title EXACTLY as shown>", "synthesis": "<text>" }, …]\` and \`approve: "<their code>"\`. Never guess or fabricate the code. Originals are archived with audit arrows — nothing is deleted; one undo un-gardens.\n\n${body}`)] };
  }

  if (!Array.isArray(syntheses) || !syntheses.length) return err('apply:true needs syntheses:[{title, synthesis}, …] — run the dry run first (apply omitted) to get the areas + their cards.');
  if (String(approve || '').trim() !== gardenApprovalCode(areas)) {
    return err('Garden apply requires HUMAN approval: show the human the dry-run plan + your syntheses, then ask them to run `npx klypix-mcp garden-code` in this project and paste the 8-character code — pass it as approve:"<code>". The code is never shown to you directly. (It changes when the candidate set or the day changes — if it expired, re-run the dry run and re-confirm.)');
  }
  return withCanvasWriteLock(file, async () => {
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
  }, { brain: true });
}

export async function opBrainConnect({ vault, canvas, apply = false, max = 24, threshold = null, scope = 'orphans', pairs = null, relationship = null, label = null, log = () => {} }) {
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
    return withCanvasWriteLock(file, async () => {
      try {
        const { buffer, added } = await addBrainConnections(fs.readFileSync(file), explicit);
        await atomicWrite(file, buffer);
        return { blocks: [text(`✓ Drew ${added} connection(s)${rel === 'not_contradiction' ? ' — these pair(s) are now dismissed and will NOT resurface as brain_reconcile contradiction candidates' : ''}.\n\n${explicit.slice(0, added).map(render2).join('\n')}`)] };
      } catch (e) { return err(`Apply failed (brain unchanged): ${e.message}`); }
    }, { brain: true });
  }

  // Graph gardening is orphan-first by default. It is additive and dry-run-first:
  // no card is archived, rewritten, or silently linked. `scope:"all"` preserves
  // the broader historical densification mode for deliberate use.
  const normalizedScope = scope === 'all' ? 'all' : 'orphans';
  const orphanIds = new Set(brainInsights(struct).orphans.map(card => card.id));
  const beforeOrphans = orphanIds.size;
  if (normalizedScope === 'orphans' && !beforeOrphans) {
    return { blocks: [text('Nothing to connect — this brain has no orphaned decision/milestone cards.')] };
  }
  const effectiveThreshold = Number.isFinite(Number(threshold))
    ? Math.max(0, Math.min(1, Number(threshold)))
    : (normalizedScope === 'orphans' ? 0.55 : 0.45);
  let edges = [];
  let mode = 'structural (shared tags + [[mentions]])';
  // Queue saturation must degrade to the structural mode, never a hard error.
  let pipe = null;
  try { pipe = await getEmbedderForUse(log, 20_000); } catch { /* saturated/unavailable → structural */ }
  if (pipe) {
    try {
      const vecs = await vectorsForBrain(pipe, file, struct.cards);
      const items = live.filter(c => vecs.get(c.id));
      const sources = normalizedScope === 'orphans' ? items.filter(c => orphanIds.has(c.id)) : items;
      for (const a of sources) {
        const av = vecs.get(a.id);
        const sims = items
          .filter(b => b.id !== a.id)
          .map(b => ({ b, s: dot(av, vecs.get(b.id)), cross: (b.area || '') !== (a.area || '') }))
          .sort((x, y) => (y.s + (orphanIds.has(y.b.id) ? 0.02 : 0) + (y.cross ? 0.01 : 0))
            - (x.s + (orphanIds.has(x.b.id) ? 0.02 : 0) + (x.cross ? 0.01 : 0)));
        let taken = 0;
        for (const { b, s } of sims) {
          if (s < effectiveThreshold || taken >= 2) break;
          const key = [a.id, b.id].sort().join('|');
          if (linked.has(key)) continue;
          linked.add(key);
          edges.push({ fromId: a.id, toId: b.id, sim: s, why: orphanIds.has(b.id) ? 'semantic · two orphans' : 'semantic · orphan to graph' });
          taken++;
        }
      }
      edges.sort((x, y) => y.sim - x.sim);
      mode = `semantic (on-device, threshold ${effectiveThreshold.toFixed(2)})`;
    } catch (e) { mode = `structural (semantic failed: ${e.message})`; }
  }
  if (!edges.length) {
    edges = proposeStructuralConnections(struct)
      .filter(e => normalizedScope === 'all' || orphanIds.has(e.fromId) || orphanIds.has(e.toId));
    if (!mode.startsWith('structural')) mode = `structural (no semantic matches ≥${effectiveThreshold.toFixed(2)})`;
  }
  const chosen = edges.slice(0, max);
  if (!chosen.length) return { blocks: [text(`Nothing to connect — no related-but-unlinked ${normalizedScope === 'orphans' ? 'orphan cards' : 'cards'} found (mode: ${mode}).`)] };

  const repairedIds = new Set();
  for (const edge of chosen) {
    if (orphanIds.has(edge.fromId)) repairedIds.add(edge.fromId);
    if (orphanIds.has(edge.toId)) repairedIds.add(edge.toId);
  }
  const projectedOrphans = Math.max(0, beforeOrphans - repairedIds.size);

  const render = (e) => `- ${flat(byId.get(e.fromId)?.text)} ↔ ${flat(byId.get(e.toId)?.text)}${e.sim != null ? `  (${e.sim.toFixed(2)}${e.why ? ` · ${e.why}` : ''})` : e.why ? `  (${e.why})` : ''}`;
  if (!apply) {
    const receipt = normalizedScope === 'orphans'
      ? `Orphan receipt: ${beforeOrphans} now → ${projectedOrphans} projected (${repairedIds.size} repaired if every reviewed edge is applied).`
      : `Scope: all live cards (${beforeOrphans} current orphans).`;
    return { blocks: [text(`# ${chosen.length} suggested connection(s) · ${mode}\n_${receipt} Review every pair, then re-run with apply:true to draw them. Additive only: no cards are archived or rewritten._\n\n${chosen.map(render).join('\n')}`)] };
  }
  return withCanvasWriteLock(file, async () => {
  try {
    const { buffer, added } = await addBrainConnections(fs.readFileSync(file), chosen);
    await atomicWrite(file, buffer);
    let afterOrphans = projectedOrphans;
    try { afterOrphans = brainInsights((await parseKlypix(buffer)).struct).orphans.length; } catch { /* projected receipt remains honest fallback */ }
    const receipt = normalizedScope === 'orphans'
      ? ` Orphan receipt: ${beforeOrphans} → ${afterOrphans} (${Math.max(0, beforeOrphans - afterOrphans)} repaired).`
      : '';
    return { blocks: [text(`✓ Drew ${added} additive connection(s) into ${path.relative(vault, file)} (${mode}).${receipt} No cards were archived or rewritten; each arrow remains removable in KLYPIX.\n\n${chosen.slice(0, added).map(render).join('\n')}`)] };
  } catch (e) {
    return err(`Apply failed (brain unchanged): ${e.message}`);
  }
  }, { brain: true });
}

export async function opCreateCanvas({ vault, title, cards, connections, filename }) {
  if (!fs.existsSync(vault)) { try { fs.mkdirSync(vault, { recursive: true }); } catch { /* ignore */ } }
  // Locked on the VAULT: safeName picks a free name by probing the directory, so
  // two concurrent creates of the same title would both see it free and the second
  // atomicWrite would silently replace the first canvas.
  return withVaultCreateLock(vault, async () => {
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
  });
}

export async function opAddToCanvas({ vault, canvas, cards, connections, via }) {
  const file = resolveCanvas(vault, canvas);
  if (!file) return err(`Canvas not found: ${canvas}`);
  // add_to_canvas is generic, so infer the document kind before choosing the
  // cross-process layer. Filename is the legacy signal; manifest.kind keeps a
  // renamed brain protected. The actual read-modify-write still happens only
  // after both locks are held below.
  let isBrain = /^brain\.(klypix|any)$/i.test(path.basename(file));
  if (!isBrain) {
    try { isBrain = (await parseKlypix(fs.readFileSync(file))).manifest?.kind === 'brain'; }
    catch { /* the inner operation will report the parse failure */ }
  }
  // The read MUST be inside the lock: reading first and appending later is exactly
  // the interleaving that loses the other writer's cards.
  return withCanvasWriteLock(file, async () => {
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
  }, { brain: isBrain });
}

// brain_note — the DELIBERATE, marker-aware write every agent (not just the
// Claude-Code Stop hook) can make on demand. Routes through the SAME captureInto-
// Brain engine the hook uses, so supersede / resolve / close-link / dedup behave
// identically to a harvested 🧠 marker. The agent-neutral half of "the brain is an
// open file any agent reads AND writes": a hookless client (Cursor/Cline/Desktop)
// can now record a decision, ask an open question, mark a milestone, resolve a card,
// or correct one — with the full lifecycle, not just a flat append.
export async function opBrainNote({ vault, canvas, text: noteText, area, marker = '', closes, via, guard = null, enrichmentQuestion = '' }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  if (!noteText || !String(noteText).trim()) return err('brain_note needs a non-empty text.');
  if (!['', '?', '!', '✓', '~', '+'].includes(marker)) return err(`Invalid marker "${marker}" — use: (none)=decision · ?=open question · !=milestone · +=skill (reusable how-to) · ✓=resolve a matching card · ~=update a matching card.`);
  // Guard cards (2026-08-24): a guard is authored on a '+' skill (or amended
  // via '~'). Validation is FAIL-LOUD — a malformed guard is an error naming
  // the defect, never a silently-dropped field (the exact bug class this
  // subsystem's audit found in the evidence/verify plumbing).
  let guardField = null;
  if (guard !== null && guard !== undefined) {
    if (marker !== '+' && marker !== '~') return err("guard rides a '+' skill card (or a '~' amendment of one) — pass marker: '+' with the guard.");
    const v = validateGuard(guard);
    if (!v.ok) return err(`Invalid guard: ${v.reason}`);
    guardField = v.guard;
  }
  const input = noteToCaptureInput({ text: noteText, area, marker, closes: closes || '', guard: guardField, createdVia: via || 'mcp' });
  // Deliver any queued out-of-session ship observations on THIS write. The
  // Claude Stop hook is not the only writer — an MCP-only or Codex-driven
  // project would otherwise queue observations that never drain (2026-07-29
  // review, CONFIRMED). Cards ride the same capture batch, so they also pass
  // through the fulfillment cross-check. Queue is cleared only after the write.
  const projectDir = path.dirname(file);
  // The pending-ships drain reads a queue, folds it into THIS batch and clears it
  // only after the write — so it has to sit inside the lock too, or two concurrent
  // notes both drain the same queue and one batch of ship cards is lost with the
  // write that carried it.
  return withCanvasWriteLock(file, async () => {
  let pendingShips = [];
  try { pendingShips = readPendingShips(projectDir); } catch { pendingShips = []; }
  if (pendingShips.length) {
    for (const c of pendingShipCards(pendingShips, {})) {
      input.cards.push({ text: `${c.area}: 🏁 ${c.summary}\n#${String(c.area).toLowerCase()} #auto`, area: c.area, createdVia: 'ship-observed', borderColor: 'rgba(59,130,246,0.8)' });
    }
  }
  try {
    const res = await captureIntoBrain(fs.readFileSync(file), input);
    let out = res.buffer; try { out = (await tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
    await atomicWrite(file, out);
    if (pendingShips.length) clearPendingShips(projectDir);   // durable now — safe to consume
    // Question enrichment (1.77): the caller session's declared intent is the
    // natural-language question that produced this card — recorded to the
    // retrieval sidecar so brain_ask finds the card in the asker's vocabulary.
    // Additive: any failure costs recall, never the write above.
    if (enrichmentQuestion && (res.stats?.added || 0) > 0) {
      try {
        const enrich = await import('./enrichment.mjs');
        enrich.recordEnrichment(file, [{ body: noteText, question: enrichmentQuestion }]);
      } catch { /* sidecar unavailable — additive signal only */ }
    }
    const s = res.stats || {};
    const bits = [`${s.added || 0} added`];
    for (const k of ['resolved', 'updated', 'merged', 'closed', 'superseded']) if (s[k]) bits.push(`${s[k]} ${k}`);
    if (s.reAdopted) bits.push(`${s.reAdopted} re-adopted`);
    if (s.linked) bits.push(`${s.linked} linked`);
    // Correction receipt — a correction-cue note superseded a card cross-area /
    // below the plain 0.6 bar; say WHAT was archived and how to undo, so the
    // widened match is always confirmable rather than silent.
    const corr = (Array.isArray(s.corrections) && s.corrections.length)
      ? `\n↩︎ correction supersede: ${s.corrections.map(c => `"${c.old}"${c.area ? ` [${c.area}]` : ''} (overlap ${c.overlap})`).join('; ')} — archived + arrowed to your note. If it grabbed the wrong card, restore it from Archive or re-run with marker "~".`
      : '';
    // Name the resolved brain explicitly (basename + how) so a write never lands
    // in a surprise file silently — the write-side twin of the read-op stamp.
    // Host-neutral capture receipts (2026-08-01): Codex/Cursor/Cline capture
    // through THIS verb, not the Claude Stop hook — without these lines the
    // write-side ⏳/⚠️ nudges existed only on one host brand.
    const receipts = formatCaptureReceipts(s);
    const rc = receipts.length ? `\n${receipts.join('\n')}` : '';
    return { blocks: [text(`✓ brain_note → ${path.basename(file)} (via ${t.how}) · ${bits.join(' · ')}. Reopen the brain in the KLYPIX app to see it.${corr}${rc}`)] };
  } catch (e) {
    return err(`brain_note failed (brain unchanged): ${e.message}`);
  }
  }, { brain: true });
}

export async function opBrainMessage({ vault, canvas, text: msgText, to, via, from, sessionId }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const body = String(msgText || '').trim();
  if (!body) return err('brain_message needs a non-empty text.');

  // The worker supplies its logical presence id. Older protocol faces that only
  // know a client label receive a deterministic compatibility identity rather
  // than minting a different sender on every call.
  const logicalSender = String(from || sessionId || '').trim().slice(0, 160)
    || `legacy-${crypto.createHash('sha1').update(`${t.file}|${String(via || 'mcp').toLowerCase()}`).digest('hex').slice(0, 16)}`;
  const result = postPresenceMessage({
    brainPath: t.file,
    from: logicalSender,
    to: String(to || 'all'),
    text: body,
  });
  if (!result.posted || !result.message) {
    if (result.reason === 'target-not-unique') {
      return err('brain_message refused: the target did not identify exactly one other live session. Use its full id, a unique prefix of at least 8 characters, an exact unique branch, or "all". Nothing was posted.');
    }
    if (result.reason === 'duplicate' && result.message) {
      return err(`brain_message already queued as ${result.message.id}; the duplicate was not posted again.`);
    }
    return err(`brain_message deferred: ${result.reason || 'the coordination lane is busy'}. Nothing was posted — retry in a moment.`);
  }
  const message = result.message;
  const candidates = Array.isArray(message.candidateIds) ? message.candidateIds.length : 0;
  return {
    blocks: [text(`📨 queued in this project's coordination lane (to: ${message.to}; id: ${message.id}) — ${candidates} live target session(s) were snapshotted. Delivery is pending until a supported lifecycle/MCP action offers it into model-visible context, and it replays until the offer is acknowledged. AFTER acknowledgement it retires one of two ways: the receiver calls brain_message_receipt with the exact message id and offer token ("acted on it"), or a further independent action AUTO-CONSUMES it without any receipt. Your receipt line names which. Auto-consumption is not proof the note was acted on, and no path here is proof a human read it. Not a brain card — use brain_note for durable project decisions.`)],
    message,
  };
}

// Re-export the format helpers the bins need for non-op work (init onboarding).
export { buildKlypixMap, parseKlypix };
