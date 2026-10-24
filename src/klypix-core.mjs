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
import { execFileSync } from 'child_process';
import { prepareBrainEvidence, inspectCardEvidence, formatCardEvidence } from './brain-evidence.mjs';
import { looksLikeUnfilledDraft } from './capture-gap.mjs';
import { z } from 'zod';
import {
  parseKlypix, buildKlypix, buildKlypixMap, appendToKlypix, structToMarkdown,
  brainInsights, insightsToMarkdown, insightsAreasToMarkdown, insightsStatusToMarkdown,
  areaStatusDigest, addBrainConnections, proposeStructuralConnections, atomicWrite,
  findUnrecordedMigrations, captureIntoBrain, tidyBrain, noteToCaptureInput, liftLeadingMarker,
  selectGardenCandidates, applyGarden, detectContradictions,
  findDuplicatePartialNotes, collapseDuplicatePartialNotes,
  rankForQuestion, splitAskWords, questionContextToMarkdown, findLegacyShipCards,
  challengeBrain, challengeContextToMarkdown, buildRenderSpec, structToBrief,
  brainLensData, lensToMarkdown, deathDateOfCard,
  statusContextToMarkdown, findFulfillmentCandidates, findStaleOpenCards, releaseFulfilledOpens, openStatusSummary, perAreaTableToMarkdown,
  splitQueryTokens, scoreCardsAgainstQuery, correctionOverlaysFor, supersededByNote, currentGuidanceFor, currentGuidancePrefix,
  isFastDecayCard, isUnresolvedOpenCard, isSkillCard, validateGuard, guardSidecarPathFor, ensureGuardSidecar, DECAY_STALE_MS, formatDecayAge,
  isPlanCard, planFulfillmentFor, PLAN_PAIR_SIM_BRAIN, isAgconfTwinId,
  readPendingShips, clearPendingShips, pendingShipCards, formatCaptureReceipts, parseVerifySuffix, amendmentFirst, rewriteCardById, handoffTitle,
  scopeLockedView, scopeLockLine, derivedReading, readManifestCheap, escapeInstructionLines,
  lessonsForFiles, checkRuleSpec, RULE_CANDIDATE_PREFIX, parseMarkerSuffixText, unwrapCardText,
} from './klypix-format.mjs';
import {
  leaseVerdict, readEndpoint, pathHash, canvasWriteLockPath, tellUser, LEASE_SINCE_APP_VERSION,
} from './app-lease.mjs';
import { LIMITS, assetBytes, dataUrlImage, fitImage, imageSkipReason, locateAsset, mb } from './card-files.mjs';
import { findProjectBrain, neutralizeMarkers, postPresenceMessage, resolveMessageTarget, readReleaseLease, listActiveSessions, listKnownSessions, sessionStatusLabel, stampSessionWork, listUnfinishedWork, formatUnfinishedWork, formatCheckoutLines, resumeCommandFor } from './agent-presence.mjs';
import { normalizeHandoffInput, renderHandoffCard, handoffMachineField, parseHandoffCard, listOpenHandoffCards, formatHandoffCards, isHandoffLine1, HANDOFF_REASONS, clientWord as handoffClientWord, autoHandoffCandidates, draftHandoffFromWork, inspectHandoffFreshness, formatHandoffFreshness } from './session-handoff.mjs';
import { collectRepoState, commitsInRange, makeContainmentProbe } from './repo-state.mjs';

import { brainCaptureLockPath, vaultCreateLockPath, withAdvisoryWriteLock } from './brain-write-lock.mjs';
// Plugin mode helpers (KLYPIX_PLUGIN=1). A namespace import: every bundle that
// ships this engine ships mcp-auto-update.mjs beside it, and a missing export
// (older copy mid-install) degrades to normal mode instead of failing to link.
import * as autoUpdateLib from './mcp-auto-update.mjs';
import {
  dot, embedTexts, getEmbedder, getEmbedderForUse, withRerankerForUse,
  rerankHits, semanticFallbackNotice, semanticMemorySnapshot,
  semanticRuntimeInstalled, shouldPrewarmSemantic, vectorsForBrain,
  cachedVectorsForBrain, startBrainPreparation, preparationNotice,
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
  group: z.string().optional().describe('Put this card inside the titled box of that name (created if missing), in card order. Alternative to listing it in `groups`.'),
});
export const connSchema = z.object({
  from: z.union([z.number(), z.string()]).describe('Source card: index (0-based), title, or id.'),
  to: z.union([z.number(), z.string()]).describe('Target card: index, title, or id.'),
  relationship: z.string().optional().describe('leads_to|depends_on|relates_to|conflicts_with|supports|questions|costs|blocks'),
  label: z.string().optional(),
});
// Groups (2026-09-05): a titled box whose cards stack top-to-bottom IN THE ORDER
// GIVEN, boxes left-to-right. The plain grid follows arrows, not reading order,
// which scatters step 1 far from step 2 — for anything a reader follows in
// sequence, put the cards in groups.
export const groupSchema = z.object({
  title: z.string().describe('Box header, e.g. "Part 1 · Get ready". Also the card\'s area.'),
  cards: z.array(z.union([z.number(), z.string()])).min(1).describe('Member cards IN READING ORDER — index (0-based), title, or id. They stack top-to-bottom inside the box.'),
  color: z.string().optional().describe('Hex border color for the box (default emerald).'),
  columns: z.number().int().min(1).max(4).optional().describe('Split a long list into N columns, filled top-to-bottom then next column. Default 1 (2 when more than 12 cards).'),
  width: z.number().int().min(200).max(640).optional().describe('Card width inside the box in px (default 340). Use ~520 for long prose cards so they do not become skyscrapers.'),
});

// ── Vault discovery / resolution ─────────────────────────────────────────────
export const IS_CANVAS = /\.(klypix|any)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', '$Recycle.Bin', 'Windows']);
const MAX_FILES = 400;
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

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

// The title KLYPIX shows for a canvas file (manifest.title), read cheaply from
// the ZIP's central directory and cached by path + size + mtime, so resolving a
// name never inflates a whole canvas. Legacy .any files (no manifest) → null.
const titleCache = new Map();
export function canvasTitleOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = path.resolve(file);
  const hit = titleCache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.title;
  const manifest = readManifestCheap(file);
  const title = manifest && typeof manifest.title === 'string' && manifest.title.trim() ? manifest.title.trim() : null;
  if (titleCache.size > 2000) titleCache.clear();
  titleCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, title });
  return title;
}

// Resolve a user-supplied canvas reference: absolute path, vault-relative path,
// a bare filename (matched against the walked list, case-insensitively), and —
// when no file name matches — the title KLYPIX shows (manifest.title), first
// exactly, then ignoring case. Two canvases with that title are ambiguous: the
// caller gets both paths instead of a guess.
//   → { file } · { ambiguous: [paths] } · { file: null }
export function resolveCanvasDetailed(vault, ref) {
  if (!ref || typeof ref !== 'string') return { file: null };
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return { file: ref };
  const rel = path.join(vault, ref);
  if (fs.existsSync(rel)) return { file: rel };
  const all = walkVault(vault);
  const want = path.basename(ref).toLowerCase();
  const byName = all.filter(f => path.basename(f).toLowerCase() === want
    || path.basename(f).toLowerCase() === want + '.klypix'
    || path.basename(f).toLowerCase() === want + '.any');
  if (byName.length) return { file: byName[0] };
  const wanted = ref.trim();
  if (!wanted) return { file: null };
  const titled = all.map(f => ({ f, title: canvasTitleOf(f) })).filter(x => x.title);
  for (const same of [(t) => t === wanted, (t) => t.toLowerCase() === wanted.toLowerCase()]) {
    const matches = titled.filter(x => same(x.title)).map(x => x.f);
    if (matches.length === 1) return { file: matches[0] };
    if (matches.length > 1) return { ambiguous: matches };
  }
  return { file: null };
}

export function resolveCanvas(vault, ref) {
  return resolveCanvasDetailed(vault, ref).file || null;
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

// The result envelope's error half (P0 agent parity): the first line states the
// outcome, the LAST line is KLYPIX's one sentence for the person, and the
// structured half carries the code. Only KLYPIX speaks in tell_user.
function notFoundResult(ref, vault, ambiguous = null) {
  const sentence = tellUser('NOT_FOUND');
  const first = ambiguous
    ? `More than one canvas is titled "${ref}" — pass one of these paths:\n${ambiguous.map(p => `  - ${p}`).join('\n')}`
    : `Canvas not found: ${ref} (vault: ${vault}). Names match a file name or the title KLYPIX shows.`;
  return {
    blocks: [text(first), text(`Tell the user: ${sentence}`)],
    isError: true,
    structured: { ok: false, mode: 'file', code: 'NOT_FOUND', tell_user: sentence, ...(ambiguous ? { candidates: ambiguous } : {}) },
  };
}

const ymdOf = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : null);

/**
 * The images of a canvas's photo cards, IN CARD ORDER, each tied to its card,
 * sized for what AI apps accept in ONE tool result (src/card-files.mjs):
 *   • the original when it fits its share of `budget` (base64 characters);
 *   • otherwise a smaller copy of a JPEG (the app never saves a smaller copy of
 *     a photo in the file — its thumbnail is rebuilt on open);
 *   • otherwise not attached, with the plain reason, so the caller can point the
 *     AI at read_card_contents (which also hands over the original's path).
 * Scope-locked cards never appear (callers pass the visible cards).
 * → { attached: [{ cardId, name, data, mime, path, bytes, downscaled, width?, height? }],
 *     notAttached: [{ cardId, name, reason, bytes? }] }
 */
export async function canvasImages(parsed, visibleCards, { max = 4, budget = LIMITS.imageResultBudget, onlyIds = null } = {}) {
  const items = parsed?.items || {};
  const wanted = [];
  for (const c of visibleCards || []) {
    if (onlyIds && !onlyIds.has(c.id)) continue;
    const it = items[c.id];
    if (!it) continue;
    const imageFile = it.type === 'file' && !it.isFolder && IMG_RE.test(`.${String(it.extension || '').toLowerCase()}`);
    if (it.type !== 'image' && !imageFile) continue;
    wanted.push({ c, it });
  }
  const attached = [];
  const notAttached = [];
  let remaining = Math.max(0, budget);
  for (let i = 0; i < wanted.length; i++) {
    const { c, it } = wanted[i];
    const name = c.title || it.fileName || 'image';
    if (attached.length >= max) { notAttached.push({ cardId: c.id, name, reason: 'count' }); continue; }
    let buf = null;
    let where = null;
    const got = it.assetId ? await assetBytes(parsed, it.assetId) : { missing: true };
    if (got.buf) { buf = got.buf; where = locateAsset(parsed, it.assetId); }
    else if (typeof it.src === 'string' && it.src.startsWith('data:image/')) { buf = dataUrlImage(it.src); where = `${c.id}.inline`; }
    if (!buf) {
      notAttached.push({ cardId: c.id, name, reason: got.tooLarge ? 'too-large' : it.phoneAsset ? 'phone' : 'missing', ...(got.size ? { bytes: got.size } : {}) });
      continue;
    }
    const share = Math.floor(remaining / Math.max(1, Math.min(wanted.length - i, max - attached.length)));
    if (share < LIMITS.minImageB64) { notAttached.push({ cardId: c.id, name, reason: 'budget', bytes: buf.length }); continue; }
    const fit = await fitImage(buf, share);
    if (!fit.ok) { notAttached.push({ cardId: c.id, name, reason: fit.reason, mime: fit.mime, bytes: buf.length }); continue; }
    remaining -= fit.data.length;
    attached.push({ cardId: c.id, name, data: fit.data, mime: fit.mime, path: where, bytes: buf.length, downscaled: fit.downscaled, ...(fit.downscaled ? { width: fit.width, height: fit.height } : {}) });
  }
  return { attached, notAttached };
}

/** Back-compatible shape: just the attached images (thumbnail is always false now). */
export async function cardImages(parsed, visibleCards, { max = 8, onlyIds = null, budget } = {}) {
  const { attached } = await canvasImages(parsed, visibleCards, { max, onlyIds, ...(budget != null ? { budget } : {}) });
  return attached.map(a => ({ ...a, thumbnail: false }));
}

export async function opListCanvases({ vault }) {
  const files = walkVault(vault);
  if (files.length === 0) {
    return { blocks: [text(`No .klypix/.any files found under vault: ${vault}\nSet --vault or KLYPIX_VAULT to your canvas folder.`)] };
  }
  // "open in KLYPIX" comes from the lease a running KLYPIX writes (app-lease.mjs).
  // No lease → nothing is marked; it never guesses.
  const lease = readEndpoint();
  const openHashes = lease.status === 'live' && lease.endpoint ? new Set(lease.endpoint.openFiles) : new Set();
  const rows = [];
  let openCount = 0;
  for (const f of files) {
    try {
      const { struct } = await parseKlypix(fs.readFileSync(f));
      const st = fs.statSync(f);
      const open = openHashes.size && openHashes.has(pathHash(f));
      if (open) openCount++;
      rows.push(`- ${path.relative(vault, f)} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections · ${new Date(st.mtimeMs).toISOString().slice(0, 10)}${open ? ' · open in KLYPIX' : ''}`);
    } catch {
      rows.push(`- ${path.relative(vault, f)} — (unreadable)`);
    }
  }
  const note = openCount ? `\n\n${openCount} of these ${openCount === 1 ? 'is' : 'are'} open in KLYPIX right now: add_to_canvas refuses ${openCount === 1 ? 'it' : 'them'} until the tab is closed.` : '';
  return { blocks: [text(`# Canvases in ${vault}\n\nRead one by its title or file name.\n\n${rows.join('\n')}${note}`)] };
}

export async function opReadCanvas({ vault, canvas }) {
  const resolved = resolveCanvasDetailed(vault, canvas);
  if (!resolved.file) return notFoundResult(canvas, vault, resolved.ambiguous);
  const file = resolved.file;
  try {
    const parsed = await parseKlypix(fs.readFileSync(file));
    // Scope lock: cards inside a box a person locked from AI tools are not
    // printed, not searched, and their images are not attached.
    const view = scopeLockedView(parsed);
    const blocks = [text(structToMarkdown(view.struct, { parsed, lockedBoxes: view.boxes, mcp: true }))];
    // Return photo cards as actual image blocks so a vision-capable model SEES
    // them — the whole point of a multimodal canvas. In card order, each after
    // the card it belongs to, and sized for what AI apps accept in ONE result
    // (Claude Desktop refuses a tool result over 1 MB): originals when they fit,
    // a smaller copy of a large JPEG otherwise, never a silent failure.
    const markdownChars = blocks[0].text.length;
    const { attached, notAttached } = await canvasImages(parsed, view.struct.cards, {
      max: 4, budget: Math.min(LIMITS.imageResultBudget, Math.max(0, 900_000 - markdownChars)),
    });
    for (const img of attached) {
      blocks.push(text(`Image for card ${img.cardId} '${img.name}'${img.downscaled ? ` (a smaller copy, ${img.width}×${img.height} px, of the ${mb(img.bytes)} original — read_card_contents gives the original's file path)` : ''}`));
      blocks.push({ kind: 'image', data: img.data, mime: img.mime, name: img.path });
    }
    if (attached.length > 0) blocks.push(text(`\n(${attached.length} image${attached.length > 1 ? 's' : ''} from this canvas ${attached.length > 1 ? 'are' : 'is'} attached above, each after the card it belongs to — read ${attached.length > 1 ? 'them' : 'it'} directly.)`));
    if (notAttached.length > 0) {
      const why = (n) => (n.reason === 'phone' ? 'an iPhone photo whose bytes are not stored in this canvas file'
        : n.reason === 'missing' ? 'its bytes are not in this canvas file' : imageSkipReason(n.reason, n.mime));
      blocks.push(text(`Not attached here: ${notAttached.map(n => `card ${n.cardId} '${n.name}' (${why(n)})`).join('; ')}. Call read_card_contents with those card ids to get each photo (and its original's file path).`));
    }
    return { blocks, struct: view.struct };
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
    let parsed;
    try { parsed = await parseKlypix(fs.readFileSync(f)); } catch { continue; }
    // Scope lock: a locked box's cards never match, and never show.
    const { struct } = scopeLockedView(parsed);
    const items = parsed.items || {};
    const rel = path.relative(vault, f);
    let saved = null;
    try { saved = ymdOf(fs.statSync(f).mtimeMs); } catch { /* */ }
    const nameMatch = hit(struct.title) || hit(rel);
    const readingOf = (c) => derivedReading(items[c.id]);
    const itemTags = (c) => (Array.isArray(items[c.id]?.tags) ? items[c.id].tags.map(String) : []);
    const inReading = (c) => { const r = readingOf(c); return !!r && hit(r.text); };
    const matched = struct.cards.filter(c =>
      hit(c.title) ||
      hit(c.text) ||
      (c.tags || []).some(t => hit('#' + t)) ||
      itemTags(c).some(t => hit('#' + t) || hit(t)) ||
      inReading(c));
    if (nameMatch || matched.length) {
      // Matching stays recall-first (an archived card CAN be the right answer to
      // "what did we try?"), but an archived hit is now labelled. Unlabelled, a
      // superseded or retired decision read exactly like a current one.
      const isArchived = (c) => /^archive$/i.test(c.area || '');
      const n = struct.counts;
      const head = `## ${rel} — "${struct.title}" · ${n.live ?? n.cards} live cards${n.archived ? `, ${n.archived} archived` : ''}, ${n.connections} connections${saved ? ` · saved ${saved}` : ''}${nameMatch && !matched.length ? '  (name/title match)' : ''}`;
      // A stale hit names its replacement (1.98.0) — never a bare "archived".
      let successors = new Map();
      try { successors = correctionOverlaysFor(struct, matched.slice(0, 8)); } catch { successors = new Map(); }
      const body = matched.slice(0, 8).map(c => {
        const pos = (c.pos && c.pos.x != null) ? ` @(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '';
        const allTags = [...new Set([...(c.tags || []), ...itemTags(c)])];
        const tags = allTags.length ? ' ' + allTags.map(t => '#' + t).join(' ') : '';
        const arch = isArchived(c) ? ' ⛔ archived' : '';
        const it = items[c.id] || {};
        const date = ymdOf(it.editedAt) || ymdOf(it.createdAt);
        const ownText = String(c.text || '').replace(/\s+/g, ' ').slice(0, 240);
        const reading = readingOf(c);
        // A match found only in KLYPIX's saved reading says so, and shows the
        // reading (escaped — it is reel/page/file text, not instructions).
        const fromReading = reading && !hit(c.title) && !hit(c.text) && hit(reading.text)
          ? `\n    in KLYPIX's saved reading: ${escapeInstructionLines(reading.text.replace(/\s+/g, ' ').slice(0, 240))}`
          : '';
        const replaced = successors.has(c.id)
          ? `\n    ↪ ${supersededByNote(successors.get(c.id))} — read that card for the current state`
          : '';
        return `- [${c.type}] "${c.title || '(card)'}" (${c.id})${pos}${date ? ` · ${date}` : ''}${tags}${arch}\n    ${escapeInstructionLines(ownText)}${fromReading}${replaced}`;
      }).join('\n');
      hits.push(matched.length ? `${head}\n${body}` : head);
    }
  }
  return { blocks: [text(hits.length ? `# Matches for "${query}"\n\n${hits.join('\n\n')}` : `No matches for "${query}" in ${vault}.`)] };
}

export async function opSearchAllBrains({ vault, query, as_of, log = () => {} }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return err('Provide a non-empty query.');
  // Plugin mode registers projects in its own machine-state folder
  // (KLYPIX_PLUGIN_DATA); it reads that list AND the shared one other KLYPIX
  // sessions on this machine maintain. Reads only.
  const registries = [path.join(PB_DIR, 'registry.json')];
  if (typeof autoUpdateLib.pluginDataDir === 'function' && autoUpdateLib.pluginDataDir()) {
    registries.unshift(path.join(autoUpdateLib.pluginDataDir(), 'registry.json'));
  }
  let brains = [];
  const seenBrains = new Set();
  for (const reg of registries) {
    let listed = [];
    try { listed = (JSON.parse(fs.readFileSync(reg, 'utf8')).brains || []).filter(b => b && b.path); } catch { /* no registry yet */ }
    for (const b of listed) {
      const resolved = path.resolve(String(b.path));
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seenBrains.has(key)) continue;
      seenBrains.add(key);
      brains.push(b);
    }
  }
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
    if (qv) { try { const r = await questionVectors(pipe, b.path, struct.cards); vecs = r.usable ? r.vecs : null; } catch { /* lexical for this brain */ } }
    // Replacement per stale card (1.98.0), only when this brain HAS lifecycle
    // edges; skipped under as_of (a correction is a present-day fact).
    let successors = new Map();
    if (asOfTs == null && (struct.connections || []).some(cn => cn.label === 'superseded by' || cn.label === 'closed by')) {
      try { successors = correctionOverlaysFor(struct, struct.cards); } catch { successors = new Map(); }
    }
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
      scored.push({ score, sem, cur: isCur, project: b.project || path.basename(path.dirname(b.path)), area: c.area, c, successor: successors.get(c.id) || null });
    }
  }
  if (!scored.length) return { blocks: [text(`No matches for "${query}" across ${brains.length} registered brain(s).`)] };
  scored.sort((a, b2) => b2.score - a.score);
  const top = scored.slice(0, 20);
  const lines = top.map(h => {
    const when = h.c.createdAt ? new Date(h.c.createdAt).toISOString().slice(0, 10) : '';
    return `- ${h.cur ? '★ ' : ''}[${h.project}${h.area ? ' › ' + h.area : ''}] ${when} ${String(h.c.text || '').replace(/\s+/g, ' ').slice(0, 240)}${h.successor ? `\n    ↪ ${supersededByNote(h.successor)}` : ''}`;
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
// Per-card lesson parsing kept across calls (one map per brain file; the
// worker is long-lived and brain_sync runs often). Keys include the card's
// text length and edit stamp, so an edited card is re-read.
const LESSON_CACHES = new Map();
function lessonCacheFor(file) {
  let cache = LESSON_CACHES.get(file);
  if (!cache) {
    if (LESSON_CACHES.size > 8) LESSON_CACHES.clear();
    cache = new Map();
    LESSON_CACHES.set(file, cache);
  }
  return cache;
}

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
  // Lessons for the declared files (1.107): the lessons that NAME these files
  // (a path, a file name, a glob, a folder, a rule candidate's globs) lead,
  // ahead of the word-matched hits. Before this, declared files were turned
  // into words only, and a lesson naming the very folder ranked 58th.
  let fileLessons = [];
  if (scopedFiles.length) {
    try { fileLessons = lessonsForFiles(struct, scopedFiles, { limit: 4, cache: lessonCacheFor(t.file) }); }
    catch { fileLessons = []; }
  }
  // A merge-engine conflict twin is the same card twice: one slot per original.
  const rootOf = (id) => String(id || '').replace(/(__agconf_[a-z0-9]+)+$/i, '');
  const shownRoots = new Set(fileLessons.map((lesson) => rootOf(lesson.card.id)));
  const hits = [];
  const hitIds = new Set();
  for (const hit of [...recentOpen, ...candidatePool]) {
    if (!hit?.card?.id || hitIds.has(hit.card.id) || shownRoots.has(rootOf(hit.card.id))) continue;
    hitIds.add(hit.card.id);
    shownRoots.add(rootOf(hit.card.id));
    hits.push(hit);
    if (hits.length >= hitLimit) break;
  }
  const recentOpenIds = new Set(recentOpen.map((hit) => hit.card.id));
  const skillPool = struct.cards.filter((c) => c.type !== 'container'
    && !/^archive$/i.test(c.area || '') && isSkillCard(c));
  const scoreById = new Map(candidatePool.map((hit) => [hit.card.id, hit.score]));
  const standing = [];
  for (const c of skillPool
    .filter((card) => !hitIds.has(card.id))
    .sort((a, b) => (scoreById.get(b.id) || 0) - (scoreById.get(a.id) || 0)
      || (b.createdAt || 0) - (a.createdAt || 0))) {
    if (shownRoots.has(rootOf(c.id))) continue;
    shownRoots.add(rootOf(c.id));
    standing.push(c);
    if (standing.length >= 3) break;
  }
  let overlays = new Map();
  try { overlays = currentGuidanceFor(struct, [...fileLessons.map((lesson) => lesson.card), ...hits.map((hit) => hit.card), ...standing]); }
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
  const evidenceCache = new Map();
  const evidenceFor = card => inspectCardEvidence(card, { projectRoot: path.dirname(t.file), cache: evidenceCache });
  const entries = hits.map((hit) => {
    const correction = overlays.get(hit.card.id)?.correction?.by || null;
    const obsolescence = overlays.get(hit.card.id)?.obsolescence || null;
    const plan = planHints.get(hit.card.id) || null;
    let decayAge = null;
    try {
      const ageMs = (hit.card.createdAt || 0) > 0 ? nowTs - hit.card.createdAt : 0;
      if (ageMs > DECAY_STALE_MS && isFastDecayCard(hit.card)) decayAge = formatDecayAge(ageMs);
    } catch { decayAge = null; }
    return {
      id: hit.card.id,
      evidence: evidenceFor(hit.card),
      area: flat(hit.card.area) || 'Notes',
      // Newest amendment first, as in the hook's previews: a thin ~ is appended
      // UNDER the claim it corrects, and 420 characters of a long card never
      // reached it (review 2026-09-18, third round).
      text: clip(unwrapCardText(amendmentFirst(hit.card.text)), 420),
      score: Number(hit.score.toFixed(2)),
      correctedBy: correction ? clip(correction.text, 420) : null,
      ...(correction ? { correctedById: correction.id } : {}),
      ...(obsolescence ? { possiblyObsolete: { by: clip(obsolescence.by, 100), byId: obsolescence.byId, unconfirmed: true } } : {}),
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
  const lines = [
    `## Compact task context (${entries.length} relevant brain card${entries.length === 1 ? '' : 's'} · lexical-fast)`,
  ];
  if (fileLessons.length) {
    lines.push(`### 📂 Lessons for your files (${fileLessons.length})`);
    for (const lesson of fileLessons) {
      lines.push(`- [${flat(lesson.card.area) || 'Notes'}] (for ${lesson.file} · names \`${lesson.via}\`) ${currentGuidancePrefix(overlays.get(lesson.card.id))}${clip(unwrapCardText(amendmentFirst(lesson.card.text)), 260)}`);
    }
  }
  if (standing.length) {
    lines.push(`### 🛠️ Standing rules (${skillPool.length} in the brain — heed correction and review warnings; full set in the brief)`);
    for (const c of standing) {
      lines.push(`- [${flat(c.area) || 'Notes'}] ${currentGuidancePrefix(overlays.get(c.id))}${clip(unwrapCardText(c.text), 220)}`);

    }
  }
  if (!entries.length) {
    if (!fileLessons.length) lines.push('No high-confidence task-specific card matched. Continue from repository evidence; use brain_ask only if deeper project history is needed.');
  } else {
    for (const entry of entries) {
      const guidanceStamp = entry.correctedBy
        ? ` CURRENT CORRECTION: [${entry.correctedById}] ${entry.correctedBy} — superseded context:`
        : entry.possiblyObsolete ? ` ${currentGuidancePrefix({ obsolescence: entry.possiblyObsolete })}` : '';
      // The LAST KNOWN stamp is a PREFIX: the final .slice(0, maxChars) can cut
      // a line's tail, and the warning must never be the part that gets cut
      // (v1.32.0 law — a claim may truncate, its warning may not).
      const stamp = entry.lastKnown ? ` ⏱️ LAST KNOWN (${entry.age} old — verify live before reporting):` : '';
      const openStamp = entry.recentOpen ? ' ❓ RECENT OPEN:' : '';
      // Same prefix discipline as LAST KNOWN: the hint can never be the part a
      // budget cut removes. It names the ship so the reader can verify it.
      const planStamp = entry.possiblyBuilt ? ` ⏳ POSSIBLY BUILT (a newer 🏁 appears to ship this plan: “${entry.possiblyBuilt.by}” — verify before treating it as only a plan/proposal):` : '';
      lines.push(`- [${entry.area}]${guidanceStamp}${openStamp}${stamp}${planStamp} ${entry.text}`);

      if (lines.join('\n').length >= maxChars) break;
    }
    lines.push('This is a bounded start-of-task capsule, not the whole brain; use brain_ask for broad status/history questions.');
  }
  // Optional evidence must never displace the rules or retrieved task facts.
  // Keep complete, identified blocks only; full metadata remains structured.
  for (const item of [...entries, ...standing.map(c => ({ id: c.id, evidence: evidenceFor(c) }))]) {
    const evidence = formatCardEvidence(item.evidence, { maxChars: 420 });
    if (!evidence) continue;
    const block = 'Recorded evidence [' + item.id + ']:\n' + evidence;
    if (lines.join('\n').length + block.length + 1 <= maxChars) lines.push(block);
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  return {
    blocks: [text(lines.join('\n').slice(0, maxChars))],
    context: {
      mode: 'lexical-fast',
      hits: entries,
      ...(standing.length ? {
        standingRules: standing.map((c) => {
          const guidance = overlays.get(c.id);
          return { id: c.id, area: flat(c.area) || 'Notes', text: clip(c.text, 220), evidence: evidenceFor(c),
            ...(guidance?.correction ? { correctedBy: clip(guidance.correction.by.text, 420), correctedById: guidance.correction.by.id } : {}),
            ...(guidance?.obsolescence ? { possiblyObsolete: { ...guidance.obsolescence, unconfirmed: true } } : {}),
          };
        }),
      } : {}),
      ...(fileLessons.length ? {
        fileLessons: fileLessons.map((lesson) => ({
          id: lesson.card.id,
          area: flat(lesson.card.area) || 'Notes',
          text: clip(unwrapCardText(amendmentFirst(lesson.card.text)), 420),
          match: lesson.tier,
          file: lesson.file,
          via: lesson.via,
          ...(lesson.card.ruleDraft ? { ruleCandidate: lesson.card.ruleDraft.spec } : {}),
        })),
      } : {}),
      sufficient: entries.length > 0 || fileLessons.length > 0,
      durationMs,
      brain: path.basename(t.file),
    },
  };
}

// Card meanings for a question, never waiting on a preparation (1.97.0): at
// most a few seconds of embedding inline; whatever is still missing is handed
// to the background preparation (startBrainPreparation) and the answer says
// so (preparationNotice). Meaning ranking is used once at least
// MEANING_READY_SHARE of the cards are ready — below that the keyword path
// covers every card, which a mostly-unprepared meaning ranking would not.
const MEANING_READY_SHARE = 0.5;
async function questionVectors(pipe, file, cards) {
  const stats = {};
  const vecs = await vectorsForBrain(pipe, file, cards, { stats });
  if (stats.pending > 0) startBrainPreparation(file);
  const usable = Boolean(vecs && vecs.size) && (!stats.wanted || stats.ready / stats.wanted >= MEANING_READY_SHARE);
  return { vecs, stats, usable };
}

export async function opBrainAsk({ vault, canvas, question, as_of, k = 10, log = () => {} }) {
  // A last line `Also: <words>` is the caller's guess at the card's wording; it
  // joins the meaning query only (splitAskWords in klypix-format.mjs).
  const { question: q, words } = splitAskWords(question);
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
  let semantic = null, mode = 'lexical', cardVecs = null, prep = null;
  try {
    const pipe = await getEmbedderForUse(log, 20_000);
    if (pipe) {
      const [qv] = await embedTexts(pipe, [words ? `${q}\n${words}` : q], { kind: 'query' });
      const { vecs, stats, usable } = await questionVectors(pipe, t.file, struct.cards);
      prep = stats;
      if (qv && usable) { semantic = new Map(); for (const [id, v] of vecs) semantic.set(id, dot(qv, v)); cardVecs = vecs; mode = `semantic+lexical (on-device)${words ? ' + your Also words' : ''}`; }
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
    if (prep?.pending > 0) mode = 'lexical (preparing search by meaning)';
    if (words) mode += ' + your Also words';
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
  const result = rankForQuestion(struct, q, { semantic, k: wantRerank ? Math.max(kk, 50) : kk, as_of: timeTravel ? as_of : null, pairSim, words });
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
    // Area scope (1.85.0): rankForQuestion HAS the struct and resolved the
    // prompt's area families to exact titles; null keeps the whole-brain render.
    // ONE count (1.85.0): the summary computed here feeds the renderer's header
    // and flags AND the per-area table appended below — one detector run, one
    // set of numbers. The table is an MCP-only surface (the hook digest's area
    // rows already carry the counts and its budget cannot afford a twin).
    try {
      const summary = openStatusSummary(struct, { pairSim });
      statusMd = statusContextToMarkdown(struct, { areas: result.areas || null, summary });
      const table = perAreaTableToMarkdown(summary, { cap: 12, areas: result.areas || null });
      if (table) statusMd += table + '\n';
      mode += ' + status-mode';
    } catch { statusMd = ''; }
  }
  // While the brain is still being prepared, that is the one thing to say: the
  // runtime IS installed, so the "warming — retry" fallback line would only
  // repeat it less precisely.
  const prepNotice = preparationNotice(t.file, prep, { usedMeaning: Boolean(semantic) });
  const noticeMd = prepNotice ? `> ${prepNotice}\n\n` : (fallbackNotice ? `> ${fallbackNotice}\n\n` : '');
  const evidenceCache = new Map();
  const evidenceForCard = (card) => formatCardEvidence(inspectCardEvidence(card, { projectRoot: path.dirname(t.file), cache: evidenceCache }));
  return { blocks: [text(stamp + noticeMd + statusMd + questionContextToMarkdown(q, result, { mode, as_of: timeTravel ? as_of : null, evidenceForCard }))] };
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
      const { vecs, usable } = await questionVectors(pipe, t.file, struct.cards);
      if (qv && usable) { semantic = new Map(); for (const [id, v] of vecs) semantic.set(id, dot(qv, v)); mode = 'semantic+lexical (on-device)'; }
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
  const { canvas: canvasJson, zip } = parsed;
  // Scope lock in BOTH places this tool reads: the render spec walks the raw
  // order + item files, and the summary walks the struct.
  const { struct, hiddenIds, boxes } = scopeLockedView(parsed);
  const renderSpec = await buildRenderSpec({ struct, canvas: canvasJson, zip }, { hiddenIds });
  const stamp = brainStamp(t.file, struct, t.how);
  const summary = `${stamp}Rendered “${struct.title}” — ${renderSpec.items.length} items · ${renderSpec.connections.length} connections`
    + `${renderSpec.counts.truncated ? ` · ${renderSpec.counts.truncated} truncated for budget` : ''}`
    + `${renderSpec.counts.strokes ? ` · ${renderSpec.counts.strokes} ink strokes not shown` : ''}\n\n`
    + boxes.map(box => `> 🔒 ${scopeLockLine(box)}\n\n`).join('')
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
    // ONE count (1.85.0): the status view prints the same honest open header as
    // the hook digest and brain_ask, plus the per-area table — from one summary.
    const summary = view === 'status' ? openStatusSummary(struct) : null;
    const body = view === 'areas'
      ? insightsAreasToMarkdown(ins, struct.title)
      : view === 'status'
        ? insightsStatusToMarkdown(areaStatusDigest(struct, { summary }), ins, struct.title, { summary })
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
// ── Release-cut reconcile context (1.85.0) ──────────────────────────────────
// The commits a release ref carries since the last one, joined to the open
// cards they look like they fulfilled. Shared by the read-only listing and the
// confirm path so a confirm can only ever accept a pair the listing SHOWED.
function releaseReconcileContext(file, struct, { root, ref, sinceRef } = {}) {
  const projectDir = root ? path.resolve(root) : path.dirname(file);
  let leaseRef = '', version = '';
  try {
    const lease = readReleaseLease({ brainPath: file });
    if (lease) { leaseRef = String(lease.ref || ''); version = String(lease.version || ''); }
  } catch { /* no lane / no lease — ref falls back below */ }
  const target = String(ref || leaseRef || 'HEAD').trim();
  let base = String(sinceRef || '').trim();
  if (!base) { try { base = collectRepoState(projectDir)?.latestReleaseTag?.tag || ''; } catch { base = ''; } }
  const range = commitsInRange(projectDir, base, target);
  if (range.status !== 'ok') return { ok: false, reason: range.reason || 'git-unreadable', ref: target, sinceRef: base, projectDir, version };
  const containedFn = makeContainmentProbe(projectDir, target);
  const { candidates, truncated } = releaseFulfilledOpens(struct, range.commits, { ref: target, containedFn });
  return {
    ok: true, ref: target, sinceRef: base, projectDir, version, containedFn,
    commits: range.commits, scanCapped: range.capped, candidates, truncated,
  };
}

export async function opBrainReconcile({ vault, canvas, root, mode = 'all', ref = '', sinceRef = '', confirm = [], dismiss = [], note = '', log = () => {} }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(file, struct, t.how);
  const sections = [];

  // (0) CONFIRM / DISMISS — the ONLY write path in this verb, and only on the
  // two evidence-bearing modes. Everything else below reads and changes
  // nothing. A call whose every entry is refused leaves the brain byte-identical.
  const confirmList = Array.isArray(confirm) ? confirm.filter(e => e && typeof e === 'object' && e.id) : [];
  const dismissList = Array.isArray(dismiss) ? dismiss.filter(e => e && typeof e === 'object' && e.openId) : [];
  if (confirmList.length || dismissList.length) {
    if (mode !== 'claims' && mode !== 'release') {
      return err(`confirm/dismiss are honoured on mode "claims" (card evidence) and mode "release" (commit evidence) only — mode "${mode}" is read-only.`);
    }
    return applyBrainReconcile({ file, how: t.how, mode, root, ref, sinceRef, confirm: confirmList, dismiss: dismissList, note });
  }

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
        // The id-addressed confirm is the PREFERRED channel (2026-09-29): it
        // names exact ids, so the settle relabels the hint 'closed by' and the
        // confirmation trail is recorded — the bare ✓ marker resolves by prose
        // match and stays the human-typed fallback.
        + ((!c.uncovered.length && c.resolvable)
            ? `   · confirm: \`brain_reconcile mode:"claims" confirm:[{ id:"${c.open.id}", milestoneId:"${c.milestone.id}" }]\`\n`
              + `   · human-typed fallback: \`🧠 BRAIN [${c.open.area || 'Notes'}] ✓: ${flat(c.item).slice(0, 80)}\``
            : `   · no ✓ suggested (${c.uncovered.length ? 'partial — the card stays open; a ✓ would engage the partial-resolve path only after full coverage' : 'item too short to resolve safely'}) — verify by hand`));
      sections.push(`# ⏳ ${cands.length} open claim(s) a later milestone likely fulfilled\n_Candidates with receipts — nothing was changed, nothing auto-archives. A confirm is only suggested for FULLY covered claims — prefer the id-addressed \`brain_reconcile\` call (it settles the hint edge and records the confirmation trail); the ✓ marker is the human-typed fallback. Dismiss a wrong hint permanently: \`brain_connect\` with \`pairs:[{fromId:<open id>, toId:<milestone id>}]\` and \`relationship:"not_fulfilled"\` — it will never be re-suggested._\n\n${lines.join('\n')}`);
    } else if (mode === 'claims') {
      sections.push('✓ No fulfilled-claim candidates — no live open clause is covered by a later milestone.');
    }
  }

  // (1e) RELEASE (1.85.0) — the same question asked of a BUILD instead of a
  // card: which open cards look fulfilled by the commits this release ref
  // already carries? Read-only like every sibling; the confirm path above is
  // the only thing that writes. `confirmable` is conservative on purpose —
  // with ref being the branch under cut, containment is true by construction,
  // so a coverage match needs cov ≥ 0.6 from a commit with a real body before
  // it may be confirmed at all.
  if (mode === 'release') {
    const ctx = releaseReconcileContext(file, struct, { root, ref, sinceRef });
    if (!ctx.ok) {
      sections.push(`⚠️ Release reconcile could not read git history for ${ctx.ref}${ctx.sinceRef ? ` since ${ctx.sinceRef}` : ''} (${ctx.reason}). Nothing was changed. Pass an explicit \`ref\` (and \`sinceRef\`) this checkout can resolve.`);
    } else if (!ctx.candidates.length) {
      sections.push(`✓ No open card looks fulfilled by the ${ctx.commits.length} commit(s) in ${ctx.ref}${ctx.sinceRef ? ` since ${ctx.sinceRef}` : ''}.`);
    } else {
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const confirmable = ctx.candidates.filter(c => c.confirmable).length;
      const lines = ctx.candidates.map((c, i) =>
        `${i + 1}. [${c.area || '?'}] (id ${c.openId}) ${flat(c.headline).slice(0, 120)}\n`
        + `   · via ${c.via}${c.cov != null ? ` · coverage ${c.cov}` : ''} · commit ${c.by.sha.slice(0, 7)} ${flat(c.by.subject).slice(0, 90)}\n`
        + (c.confirmable
          ? `   · confirm: \`brain_reconcile mode:"release" ref:"${ctx.ref}" confirm:[{ id:"${c.openId}", sha:"${c.by.sha.slice(0, 7)}" }]\``
          : '   · NOT confirmable (anchor-grade, or the commit carries no body) — read it and close by hand if it really shipped'));
      sections.push(`# 🚢 ${ctx.candidates.length} open card(s) look fulfilled by commits already in ${ctx.ref} (${confirmable} confirmable)\n`
        + `_Scanned ${ctx.commits.length} commit(s)${ctx.scanCapped ? ' (SCAN CAPPED — older commits were not read)' : ''}${ctx.sinceRef ? ` since ${ctx.sinceRef}` : ''}. Nothing was changed. Verify each against the commit, then confirm the pairs you checked — the ids below are NOT prefilled into one call on purpose. Dismiss a wrong hint with \`dismiss:[{ openId, cardId }]\`. Covering one item of a multi-item clause writes \`✔ partial\` and keeps the card OPEN unless you pass \`whole:true\`._\n\n${lines.join('\n')}`
        + (ctx.truncated ? '\n\n…more candidates than the cap; confirm these, then re-run.' : ''));
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
            if (pipe) {
              const stats = {};
              vecs = await vectorsForBrain(pipe, file, struct.cards, { stats });
              if (stats.pending > 0) startBrainPreparation(file);
            }
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

// ── brain_reconcile confirm / dismiss (1.85.0) ──────────────────────────────
// The retroactive sweeps have always been suggestion-only, and every retirement
// had to be re-typed as a fuzzy ✓ marker — which is how 34 open cards on the
// real brain stayed open for weeks while their milestones sat right beside them.
// This is the confirm half: the agent NAMES the pairs it verified and they are
// resolved by id, so nothing is matched by prose and nothing is closed in bulk.
//
// Two evidence kinds, because the two gaps are different:
//   claims   { id, milestoneId } — a live milestone card plus an existing
//            'likely closed by' edge or a CURRENT findStaleOpenCards gap on that
//            exact pair. No git needed. Measured: 0 of the 34 likely-done
//            milestones on the real brain carry a #commit- tag, so this — not
//            the release variant — is the path that closes that incident.
//   release  { id, sha } — the open card's own contained commit receipt, or a
//            sha that was LISTED as a coverage candidate at cov ≥ 0.6. The
//            listing gate is what stops "contained is true by construction"
//            from being mistaken for evidence.
//
// Three invariants: the partial-clause rule survives (a strict subset of a
// multi-item clause writes `✔ partial` and keeps the card OPEN unless
// `whole:true`); a call whose every entry is refused writes NOTHING; and the
// write is merge-safe by construction — it edits card text, moves cards to
// Archive and ADDS connections/milestones, and never removes a card or an id.
const RECONCILE_REFUSALS = {
  'unknown-id': () => 'unknown-id',
  'not-open': () => 'not-open (card is a milestone, skill, deferred, or already archived)',
  'no-card-evidence': () => 'no-card-evidence (no likely-closed-by link or coverage between this card and that milestone)',
  'not-in-ref': (ref) => `not-in-ref (the card carries no commit contained in ${ref})`,
  'not-a-candidate': () => 'not-a-candidate (that commit was never listed as covering this card; name a listed pair)',
  'no-dismiss-target': () => 'no-dismiss-target (a dismissal is an edge between two cards — pass cardId)',
};
// Provenance judgments (2026-09-29) — best-effort shadow of confirm/dismiss
// verdicts into the machine-local sidecar (src/provenance.mjs), so a verdict
// keeps WHO decided and THROUGH WHICH SURFACE instead of evaporating into a
// bare edge. Lazy + never-throw: a missing or unwritable sidecar costs a
// training label, never the brain write it shadows.
async function recordProvenance(file, entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  try {
    const prov = await import('./provenance.mjs');
    prov.recordJudgments(file, entries);
  } catch { /* additive signal only */ }
}

async function applyBrainReconcile({ file, how, mode, root, ref, sinceRef, confirm, dismiss, note }) {
  return withCanvasWriteLock(file, async () => {
    let struct;
    try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const refused = [];
    const resolutions = [];
    const dismissEdges = [];
    const closedShas = [];
    let ctx = null;

    if (mode === 'release') {
      ctx = releaseReconcileContext(file, struct, { root, ref, sinceRef });
      if (!ctx.ok) return err(`brain_reconcile release could not read git history for ${ctx.ref} (${ctx.reason}) — nothing was changed. Pass an explicit ref (and sinceRef) this checkout can resolve.`);
    }
    // Card evidence for mode 'claims': an existing hint/confirmed edge on the
    // pair, or a CURRENT gap. The union matters — findStaleOpenCards suppresses
    // pairs that already carry an edge, so neither half alone is the answer.
    let gapPairs = null;
    const claimsEvidence = (openId, mileId) => {
      for (const cn of struct.connections || []) {
        const pair = (cn.fromId === openId && cn.toId === mileId) || (cn.fromId === mileId && cn.toId === openId);
        if (pair && (cn.label === 'likely closed by' || cn.label === 'closed by')) return true;
      }
      if (!gapPairs) {
        gapPairs = new Set();
        try {
          for (const g of findStaleOpenCards(struct, { max: Infinity }).gaps || []) {
            if (g?.open?.id && g?.by?.id) gapPairs.add(`${g.open.id}|${g.by.id}`);
          }
        } catch { /* no gaps readable — edges still stand as evidence */ }
      }
      return gapPairs.has(`${openId}|${mileId}`);
    };

    for (const entry of confirm) {
      const id = String(entry.id);
      const card = byId.get(id);
      if (!card || card.type === 'container' || !(card.text || '').trim()) { refused.push({ id, reason: 'unknown-id' }); continue; }
      if (mode === 'claims') {
        const mile = byId.get(String(entry.milestoneId || ''));
        if (!mile || /^archive$/i.test(mile.area || '') || !claimsEvidence(id, mile.id)) { refused.push({ id, reason: 'no-card-evidence' }); continue; }
        resolutions.push({ id, byId: mile.id, whole: entry.whole === true, text: flat(mile.text).replace(/^[^:\n]{1,40}:\s*/, '').slice(0, 160) });
        continue;
      }
      // mode 'release'
      const listed = ctx.candidates.filter(c => c.openId === id);
      const own = listed.find(c => c.via === 'commit-tag' || c.via === 'commit-evidence' || c.via === 'edge');
      const sha = String(entry.sha || '').trim().toLowerCase();
      let chosen = null;
      if (sha) {
        if (!ctx.containedFn(sha)) { refused.push({ id, reason: 'not-in-ref' }); continue; }
        chosen = listed.find(c => c.by.sha.startsWith(sha) || sha.startsWith(c.by.sha));
        if (!chosen || !chosen.confirmable) { refused.push({ id, reason: 'not-a-candidate' }); continue; }
      } else if (own) {
        chosen = own;
      } else {
        refused.push({ id, reason: 'not-in-ref' }); continue;
      }
      const commit = ctx.commits.find(c => c.sha === chosen.by.sha);
      resolutions.push({
        id, whole: entry.whole === true,
        ...(chosen.by.cardId ? { byId: chosen.by.cardId } : {}),
        text: flat(commit ? commit.subject : chosen.by.subject).slice(0, 160),
        __sha: chosen.by.sha,
      });
      closedShas.push(chosen.by.sha);
    }

    for (const entry of dismiss) {
      const openId = String(entry.openId);
      const open = byId.get(openId);
      if (!open) { refused.push({ id: openId, reason: 'unknown-id' }); continue; }
      let target = String(entry.cardId || '');
      if (!target && mode === 'release' && ctx) {
        const listed = ctx.candidates.find(c => c.openId === openId && c.by.cardId);
        if (listed) target = listed.by.cardId;
      }
      if (!target || !byId.has(target)) { refused.push({ id: openId, reason: 'no-dismiss-target' }); continue; }
      dismissEdges.push({ fromId: openId, toId: target, relationship: 'not_fulfilled' });
    }

    // Nothing applies → NOTHING is written. An all-refused call must leave the
    // brain byte-identical (sha256-asserted in test/release-reconcile.mjs).
    if (!resolutions.length && !dismissEdges.length) {
      return { blocks: [text(reconcileReceipt({ file, how, mode, ref: ctx?.ref || ref, confirmed: 0, partial: 0, dismissed: 0, refused, details: [], note }))] };
    }

    let buf = fs.readFileSync(file);
    let outcomes = [];
    let settledHints = [];
    try {
      if (resolutions.length) {
        const res = await captureIntoBrain(buf, { resolutions });
        buf = res.buffer;
        outcomes = res.stats?.idResolutions || [];
        settledHints = res.stats?.settledHints || [];
        for (const o of outcomes) if (o.outcome === 'refused') refused.push({ id: o.id, reason: o.reason });
        const archivedIds = res.stats?.idArchived || [];
        // ONE milestone per release confirm, carrying the closed headlines so it
        // is retrievable evidence rather than an empty receipt. mode 'claims'
        // mints nothing — the existing milestone IS the target.
        if (mode === 'release' && archivedIds.length) {
          const shorts = [...new Set(closedShas.map(s => s.slice(0, 7)))];
          const heads = archivedIds.map(id => flat(byId.get(id)?.text || '').replace(/^[^:\n]{1,40}:\s*/, '').slice(0, 90));
          const body = heads.map(h => `- ${h}`).join('\n').slice(0, 400);
          const version = ctx?.version ? `v${ctx.version} ` : '';
          const milestone = {
            text: `Release: 🏁 ${version}(${ctx.ref}) closed ${archivedIds.length} open card(s) — reconciled against commits ${shorts.join(', ')}\n${body}\n#release #auto #release-reconcile ${shorts.map(s => `#commit-${s}`).join(' ')}`,
            area: 'Release', createdVia: 'release-reconcile', borderColor: 'rgba(59,130,246,0.8)',
            evidence: [...new Set(closedShas)].map(s => ({ kind: 'commit', ref: s })),
            // Pass 2 draws the solid 'closed by' arrow from every card this
            // confirm archived — the same field a `closes:` target would fill.
            __closesIds: archivedIds,
          };
          const mres = await captureIntoBrain(buf, { cards: [milestone] });
          buf = mres.buffer;
        }
      }
      if (dismissEdges.length) {
        const dres = await addBrainConnections(buf, dismissEdges);
        buf = dres.buffer;
      }
      // "A call whose every entry is refused leaves the brain byte-identical"
      // has to hold for refusals the ENGINE raises too, not just the ones the
      // checks above catch (2026-09-16 review). Confirming the same pair twice
      // reports `1 refused … — not-open` the second time, yet captureIntoBrain
      // hands back a re-serialized buffer and tidy + atomicWrite changed the
      // file's sha256 for nothing. A ✔ partial the card already carried is the
      // same case: it is a skip, not an application.
      const applied = dismissEdges.length > 0
        || outcomes.some(o => o.outcome === 'archived' || (o.outcome === 'partial' && !o.skipped));
      if (applied) {
        try { buf = (await tidyBrain(buf)).buffer; } catch { /* keep the capture result if tidy fails */ }
        await atomicWrite(file, buf);
        // Shadow what LANDED into the provenance sidecar. Actor is
        // 'agent-listing-bound' — the strongest attainable grade here: confirm
        // structurally accepts only pairs the served listing showed. A byId
        // settle IS the reconcile-confirm record; only the byId-less settles
        // (release confirms whose evidence carried no milestone card) surface
        // separately as hint-settle. Own try — the write above LANDED, so a
        // shadow failure must never reach the "brain unchanged" catch below.
        try {
        const provEntries = [];
        const resById = new Map(resolutions.map(r => [r.id, r]));
        for (const o of outcomes) {
          if (o.outcome !== 'archived') continue;
          const r = resById.get(o.id) || {};
          provEntries.push({
            kind: 'pair', direction: 'fulfills', verdict: 'yes', source: 'reconcile-confirm', actor: 'agent-listing-bound',
            from: { id: o.id, text: byId.get(o.id)?.text || '' },
            to: r.byId ? { id: r.byId, text: byId.get(r.byId)?.text || '' } : { text: r.text || '' },
          });
        }
        for (const e of dismissEdges) {
          provEntries.push({
            kind: 'pair', direction: 'fulfills', verdict: 'no', source: 'reconcile-dismiss', actor: 'agent-listing-bound',
            from: { id: e.fromId, text: byId.get(e.fromId)?.text || '' },
            to: { id: e.toId, text: byId.get(e.toId)?.text || '' },
          });
        }
        for (const s of settledHints) {
          if (s.via !== 'resolve') continue;
          provEntries.push({
            kind: 'pair', direction: 'closes', verdict: 'yes', source: 'hint-settle', actor: 'agent-listing-bound',
            from: { id: s.fromId, text: s.fromText || '' },
            to: { id: s.toId, text: s.toText || '' },
          });
        }
        await recordProvenance(file, provEntries);
        } catch { /* additive signal only — the reconcile itself succeeded */ }
      }
    } catch (e) {
      return err(`brain_reconcile ${mode} failed (brain unchanged): ${e.message}`);
    }
    const confirmed = outcomes.filter(o => o.outcome === 'archived').length;
    const partial = outcomes.filter(o => o.outcome === 'partial');
    const details = partial.map(o => (o.skipped
      ? `partial: ${o.id} — this ✔ partial note was already on the card; nothing was re-stamped`
      : `partial: ${o.id} — one clause item covered; ✔ partial noted, card stays open (pass whole:true to archive it)`));
    return { blocks: [text(reconcileReceipt({
      file, how, mode, ref: ctx?.ref || ref, confirmed, partial: partial.length,
      dismissed: dismissEdges.length, refused, details, note,
      closedBy: mode === 'release' ? `🏁 ${ctx?.version ? `v${ctx.version}` : ctx?.ref}` : 'their milestones',
    }))] };
  }, { brain: true });
}
function reconcileReceipt({ file, how, mode, ref, confirmed, partial, dismissed, refused, details, note, closedBy = 'their milestones' }) {
  const head = `✓ brain_reconcile ${mode} → ${path.basename(file)} (via ${how})`
    + ` · ${confirmed} confirmed (archived, closed by ${closedBy})`
    + ` · ${partial} partial (clause struck, card kept open)`
    + ` · ${dismissed} dismissed`
    + ` · ${refused.length} refused${refused.length ? `: ${refused.map(r => `${r.id} — ${r.reason}`).join(' · ')}` : ''}`;
  const lines = [
    ...details,
    ...refused.map(r => `refused: ${r.id} — ${(RECONCILE_REFUSALS[r.reason] || (() => r.reason))(ref || 'the release ref')}`),
  ];
  const tail = note ? `\nnote: ${String(note).slice(0, 400)}` : '';
  return head + (lines.length ? `\n${lines.join('\n')}` : '') + tail;
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

// Every canvas write takes a cross-process lock, not only brains. Brains keep
// the folder lock the hooks and the desktop app share
// (<folder>/.claude/brain-capture.lock). An ordinary canvas locks in the
// profile (~/.claude/project-brain/locks/<sha256 of its canonical path>.lock)
// through the same protocol: acquiring the folder lock creates a `.claude`
// folder, which would appear beside a canvas on the Desktop or in Documents.
const withCanvasWriteLock = (file, fn, { brain = false } = {}) =>
  withWriteLock(path.resolve(file), () => {
    if (!brain) return withAdvisoryWriteLock(canvasWriteLockPath(file), (locked) => locked ? fn() : lockBusy('Canvas'));
    return withAdvisoryWriteLock(brainCaptureLockPath(file), (locked) => locked ? fn() : lockBusy('Brain'));
  });

// Creation serializes on the VAULT, not the file: `safeName` picks a name by
// probing the directory, so two concurrent creates of the same title would both
// see the name free and the second would overwrite the first. Creates are rare;
// serializing them per-vault costs nothing real.
const withVaultCreateLock = (vault, fn) => withWriteLock('vault:' + path.resolve(vault), () =>
  withAdvisoryWriteLock(vaultCreateLockPath(vault), (locked) => locked ? fn() : lockBusy('Canvas creation'))
);

export async function opBrainGarden({ vault, canvas, apply = false, syntheses, approve = '', repair = '' }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const stamp = brainStamp(file, struct, t.how);

  // ── repair: "duplicate-partials" ──────────────────────────────────────────
  // The cleanup half of the 2026-09-15 ✔-partial incident. A partial resolve
  // leaves its card LIVE by design, so a re-pushed ✓ marker re-appended the same
  // note on every turn end until the engine guard landed; cards already damaged
  // need the repeats collapsed. Dry-run first like every other pass here, and
  // deliberately NOT behind the garden approval code: that code exists because
  // gardening ARCHIVES cards, and this deletes nothing — every removed line is a
  // repeat of one that stays, keeping the earliest date. Idempotent: a second
  // run finds nothing.
  if (repair) {
    if (repair !== 'duplicate-partials') return err(`Unknown repair "${repair}" — the only repair is "duplicate-partials" (collapse repeated ✔ partial notes on a card to the earliest one).`);
    const found = findDuplicatePartialNotes(struct);
    if (!found.total) return { blocks: [text(stamp + '✓ No card carries a repeated ✔ partial note — nothing to repair.')] };
    const rows = found.cards.map(c => `- (id ${c.id}) [${c.area || '?'}] ${c.total} ✔ partial line(s), ${c.distinct} distinct → ${c.duplicates} would be removed\n    ${c.headline}`);
    const more = found.total > found.cards.length ? `\n\n…and ${found.total - found.cards.length} more card(s).` : '';
    if (!apply) {
      return { blocks: [text(stamp + `# 🧹 ${found.total} card(s) carry repeated ✔ partial notes — ${found.notes} duplicate note(s)\n_Nothing was changed. Each repeat is byte-identical in substance to one that stays; the repair keeps the FIRST (earliest-dated) note per distinct body and removes the rest. Nothing is archived and no card is deleted. Re-run with \`apply:true\` to repair. Cause: a ✓ that only PARTIALLY resolves a card leaves it live, so a marker re-pushed at every turn end re-appended the same note — the engine now skips a note it already carries, so this list cannot grow again._\n\n${rows.join('\n')}${more}`)] };
    }
    return withCanvasWriteLock(file, async () => {
      try {
        const { buffer, stats } = await collapseDuplicatePartialNotes(fs.readFileSync(file));
        if (!stats.cards) return { blocks: [text('✓ Nothing to repair — no card carries a repeated ✔ partial note.')] };
        await atomicWrite(file, buffer);
        return { blocks: [text(`🧹 Repaired ${stats.cards} card(s): ${stats.notes} duplicate ✔ partial note(s) removed, the earliest of each kept. Nothing was archived or deleted. It appears in the brain if it is open in KLYPIX (inside OneDrive or Dropbox, when you next open it).`)] };
      } catch (e) {
        return err(`Repair failed (brain unchanged): ${e.message}`);
      }
    }, { brain: true });
  }

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
      return { blocks: [text(`🌿 Gardened ${stats.areas} area(s): ${stats.archived} old card(s) → ${stats.synthCards} synthesis card(s); originals archived with "consolidated into" arrows (any prose-dropped figures appended verbatim). It appears in the brain if it is open in KLYPIX (inside OneDrive or Dropbox, when you next open it).${skippedNote}`)] };
    } catch (e) {
      return err(`Garden apply failed (brain unchanged): ${e.message}`);
    }
  }, { brain: true });
}

export async function opBrainConnect({ vault, canvas, apply = false, max = 24, threshold = null, scope = 'orphans', pairs = null, relationship = null, label = null, via = '', log = () => {} }) {
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
        // A dismissal is a durable human-adjacent NO — shadow it into the
        // provenance sidecar with its surface and client, because the edge
        // itself carries no actor/session/timestamp (the 19 legacy dismissals
        // across both brains are unattributable for exactly this reason).
        // Own try: the edges above LANDED, so a shadow failure must never
        // surface as "Apply failed (brain unchanged)".
        try {
          await recordProvenance(file, explicit.slice(0, added)
            .filter((e) => e.relationship === 'not_fulfilled' || e.relationship === 'not_contradiction')
            .map((e) => ({
              kind: 'pair',
              direction: e.relationship === 'not_contradiction' ? 'contradicts' : 'fulfills',
              verdict: 'no', source: 'connect-dismiss', actor: 'agent', client: via,
              from: { id: e.fromId, text: byId.get(e.fromId)?.text || '' },
              to: { id: e.toId, text: byId.get(e.toId)?.text || '' },
            })));
        } catch { /* additive signal only — the dismissal itself landed */ }
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
      const stats = {};
      const vecs = await vectorsForBrain(pipe, file, struct.cards, { stats });
      if (stats.pending > 0) startBrainPreparation(file);
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

export async function opCreateCanvas({ vault, title, cards, connections, groups, filename, via }) {
  if (!fs.existsSync(vault)) { try { fs.mkdirSync(vault, { recursive: true }); } catch { /* ignore */ } }
  // Locked on the VAULT: safeName picks a free name by probing the directory, so
  // two concurrent creates of the same title would both see it free and the second
  // atomicWrite would silently replace the first canvas.
  return withVaultCreateLock(vault, async () => {
    try {
      // Provenance: WHICH AI tool made these cards (the MCP client's name), the
      // same stamp add_to_canvas writes — KLYPIX shows it as the card's chip.
      const stamped = via ? (cards || []).map(c => ({ ...c, createdVia: via })) : cards;
      const buf = await buildKlypix({ title, cards: stamped, connections, groups });
      const name = filename ? safeName(vault, filename.replace(IS_CANVAS, '')) : safeName(vault, title);
      const out = path.join(vault, name);
      await atomicWrite(out, buf);
      let detail = '', struct;
      try { ({ struct } = await parseKlypix(buf)); detail = cardDetailBlock(struct); } catch { /* detail is optional */ }
      const groupNote = Array.isArray(groups) && groups.length ? `, ${groups.length} group box${groups.length === 1 ? '' : 'es'}` : '';
      return {
        blocks: [text(`Created ${out} — ${cards.length} cards, ${(connections || []).length} connections${groupNote}. Open it in the KLYPIX app (Canvas → Open).${detail}`)],
        file: { name, buffer: buf }, struct,
      };
    } catch (e) {
      return err(`Create failed: ${e.message}`);
    }
  });
}

export async function opAddToCanvas({ vault, canvas, cards, connections, via }) {
  const resolved = resolveCanvasDetailed(vault, canvas);
  if (!resolved.file) return notFoundResult(canvas, vault, resolved.ambiguous);
  const file = resolved.file;
  const failed = (message, extra = {}) => ({ blocks: [text(message)], isError: true, structured: { ok: false, mode: 'file', ...extra } });
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
    // The lease (app-lease.mjs): a canvas KLYPIX has OPEN is never rewritten —
    // the app's next save would replace the file, and KLYPIX builds before the
    // lease drop cards they did not hold. Brains are exempt: KLYPIX merges them
    // and shows an agent's brain cards live. Checked inside the lock, right
    // before the read, so the window in which KLYPIX could open the file
    // between check and write is as small as this process can make it.
    const verdict = isBrain ? { action: 'write', code: null } : leaseVerdict(file);
    const shownTitle = canvasTitleOf(file) || path.basename(file).replace(IS_CANVAS, '');
    if (verdict.action === 'refuse') {
      const sentence = tellUser('OPEN_IN_APP', { canvas: shownTitle });
      return {
        blocks: [
          text(`Nothing was written: '${shownTitle}' is open in KLYPIX right now, and KLYPIX's next save would replace the file.`),
          text(`Tell the user: ${sentence}`),
        ],
        isError: true,
        structured: { ok: false, mode: 'file', code: 'OPEN_IN_APP', tell_user: sentence, canvas: file },
      };
    }
    try {
      const original = fs.readFileSync(file);
      let beforeIds = new Set();
      try { const b = await parseKlypix(original); beforeIds = new Set(b.struct.cards.map(c => c.id)); } catch { /* new/legacy → treat all as new */ }
      // Provenance: stamp WHICH agent wrote these cards (cursor / claude / cline / a2a).
      const stamped = via ? cards.map(c => ({ ...c, createdVia: via })) : cards;
      let buf;
      try {
        buf = await appendToKlypix(original, { cards: stamped, connections });
      } catch (e) {
        // A group naming a box the person locked from AI tools, or froze:
        // refused before anything was written.
        if (e?.code === 'SCOPE_LOCKED' || e?.code === 'FROZEN') {
          const sentence = tellUser(e.code);
          return {
            blocks: [text(`Nothing was written: ${e.message}`), text(`Tell the user: ${sentence}`)],
            isError: true,
            structured: { ok: false, mode: 'file', code: e.code, tell_user: sentence, canvas: file },
          };
        }
        throw e;
      }
      // Restore point before the bytes are replaced: brains always, an ordinary
      // canvas too (machine-local, size-capped; `npx klypix-mcp brain-history`).
      await atomicWrite(file, buf, { isBrain, restorePoint: !isBrain, reason: 'add_to_canvas' });
      let detail = '', struct, cardIds = [], boxIds = [];
      try {
        ({ struct } = await parseKlypix(buf));
        const fresh = struct.cards.filter(c => !beforeIds.has(c.id));
        cardIds = fresh.filter(c => c.type !== 'container').map(c => c.id);
        boxIds = fresh.filter(c => c.type === 'container').map(c => c.id);
        detail = cardDetailBlock(struct, new Set(fresh.map(c => c.id)));
      } catch { /* detail is optional */ }
      const title = struct?.title || shownTitle;
      const seen = isBrain
        ? 'It appears in the brain if it is open in KLYPIX (inside OneDrive or Dropbox, when you next open it).'
        : 'They appear when the canvas is next opened in KLYPIX.';
      const blocks = [text(`Added ${cards.length} card${cards.length === 1 ? '' : 's'} to '${title}'. ${seen}${detail}`)];
      const structured = { ok: true, mode: 'file', canvas: file, card_ids: cardIds, ...(boxIds.length ? { box_ids: boxIds } : {}) };
      // KLYPIX on this PC cannot say whether it has the canvas open (no lease:
      // closed, or a build from before the lease) — written, with the one step
      // that keeps the cards if it IS open.
      if (verdict.action === 'warn') {
        const sentence = tellUser('MAY_BE_OPEN', { canvas: title, version: LEASE_SINCE_APP_VERSION });
        blocks.push(text(`Tell the user: ${sentence}`));
        Object.assign(structured, { code: 'MAY_BE_OPEN', tell_user: sentence });
      }
      return { blocks, structured, file: { name: path.basename(file), buffer: buf }, struct };
    } catch (e) {
      return failed(`Add failed: ${e.message}`);
    }
  }, { brain: isBrain });
}

// The tracked files of a project, for checking a `rule` (checkRuleSpec). null
// when the folder is not a git checkout — then only the shape is checked.
function trackedFilesOf(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
  } catch { return null; }
}

// brain_note's input schema is frozen (test/tool-schema-freeze.mjs), so a
// rule-ready lesson rides its text as the marker grammar's `rule:` suffix —
// the same words a 🧠 BRAIN marker uses. Only that segment leaves the text;
// any other suffix on the line stays where it was.
function takeRuleSuffix(noteText) {
  const lines = String(noteText || '').replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1];
  const { rule } = parseMarkerSuffixText(last);
  if (!rule) return { text: noteText, rule: '' };
  const esc = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  lines[lines.length - 1] = last.replace(new RegExp(`\\s+rule:\\s*${esc}(?=\\s+(?:closes|ev|verify|q|Closes):|\\s*$)`), '');
  return { text: lines.join('\n'), rule };
}

// brain_note — the DELIBERATE, marker-aware write every agent (not just the
// Claude-Code Stop hook) can make on demand. Routes through the SAME captureInto-
// Brain engine the hook uses, so supersede / resolve / close-link / dedup behave
// identically to a harvested 🧠 marker. The agent-neutral half of "the brain is an
// open file any agent reads AND writes": a hookless client (Cursor/Cline/Desktop)
// can now record a decision, ask an open question, mark a milestone, resolve a card,
// or correct one — with the full lifecycle, not just a flat append.
export async function opBrainNote({ vault, canvas, text: noteText, area, marker = '', closes, via, evidence, verify, guard = null, rule = '', enrichmentQuestion = '' }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  if (!noteText || !String(noteText).trim()) return err('brain_note needs a non-empty text.');
  ({ marker, text: noteText } = liftLeadingMarker(marker, noteText));
  if (looksLikeUnfilledDraft(noteText)) return err('Complete or discard the draft rationale before capturing it; the brain cannot record an unfilled WHY THIS MATTERS placeholder.');
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
  // Rule-ready lesson (1.107): the rule is checked against this checkout and
  // lands as the card's visible `⚙ rule candidate:` line. FAIL-LOUD like a
  // guard. A candidate only — brain_rules adds it, a person approves it.
  let ruleSpec = String(rule || '').replace(/[\r\n]+/g, ' ').trim();
  if (!ruleSpec) ({ text: noteText, rule: ruleSpec } = takeRuleSuffix(noteText));
  if (ruleSpec) {
    if (!['', '+', '!'].includes(marker)) return err("rule rides a new lesson card — a decision, a '+' skill or a '!' milestone — not ?, ✓ or ~.");
    const v = checkRuleSpec(ruleSpec, trackedFilesOf(path.dirname(file)));
    if (!v.ok) return err(`Invalid rule: ${v.reason}`);
    if (marker === '') marker = '+';
    noteText = `${String(noteText).trim()}\n${RULE_CANDIDATE_PREFIX} ${ruleSpec}`;
  }
  const metadata = prepareBrainEvidence({ projectRoot: path.dirname(file), evidence, verify, marker, text: noteText, deriveVerify: parseVerifySuffix });
  if (!metadata.ok) return err(`Invalid brain note metadata: ${metadata.error}`);
  const input = noteToCaptureInput({ text: noteText, area, marker, closes: closes || '', evidence: metadata.evidence, verify: metadata.verify, guard: guardField, createdVia: via || 'mcp' });
  // Deliver any queued out-of-session ship observations on THIS write. The
  // Claude Stop hook is not the only writer — an MCP-only or Codex-driven
  // project would otherwise queue observations that never drain (2026-07-29
  // review, CONFIRMED). Cards ride the same capture batch, so they also pass
  // through the fulfillment cross-check. Queue is cleared only after the write.
  const projectDir = path.dirname(file);
  // Plugin mode keeps that queue outside the project (pluginShipObsPaths).
  const shipQueue = typeof autoUpdateLib.isPluginMode === 'function' && autoUpdateLib.isPluginMode()
    && typeof autoUpdateLib.pluginShipObsPaths === 'function'
    ? { paths: autoUpdateLib.pluginShipObsPaths(projectDir) }
    : {};
  // The pending-ships drain reads a queue, folds it into THIS batch and clears it
  // only after the write — so it has to sit inside the lock too, or two concurrent
  // notes both drain the same queue and one batch of ship cards is lost with the
  // write that carried it.
  return withCanvasWriteLock(file, async () => {
  let pendingShips = [];
  try { pendingShips = readPendingShips(projectDir, shipQueue); } catch { pendingShips = []; }
  if (pendingShips.length) {
    for (const c of pendingShipCards(pendingShips, {})) {
      input.cards.push({ text: `${c.area}: 🏁 ${c.summary}\n#${String(c.area).toLowerCase()} #auto`, area: c.area, createdVia: 'ship-observed', borderColor: 'rgba(59,130,246,0.8)' });
    }
  }
  try {
    const res = await captureIntoBrain(fs.readFileSync(file), input);
    let out = res.buffer; try { out = (await tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
    await atomicWrite(file, out);
    if (pendingShips.length) clearPendingShips(projectDir, shipQueue);   // durable now — safe to consume
    // Question enrichment (1.77): the caller session's declared intent is the
    // natural-language question that produced this card — recorded to the
    // retrieval sidecar so brain_ask finds the card in the asker's vocabulary.
    // Additive: any failure costs recall, never the write above.
    // Accepts one string or a list (1.86: the caller's authored `question` plus
    // the declared intent); the sidecar's quality gate drops what carries no
    // askable vocabulary, so passing both never records junk.
    const enrichmentQuestions = (Array.isArray(enrichmentQuestion) ? enrichmentQuestion : [enrichmentQuestion])
      .map((q) => String(q || '').trim()).filter(Boolean);
    // A ~ that rewrote or amended its card counts too (1.86.1): the sidecar
    // joins the question to whichever card holds the note's text.
    if (enrichmentQuestions.length && ((res.stats?.added || 0) + (res.stats?.updated || 0)) > 0) {
      try {
        const enrich = await import('./enrichment.mjs');
        enrich.recordEnrichment(file, enrichmentQuestions.map((question) => ({ body: noteText, question })));
      } catch { /* sidecar unavailable — additive signal only */ }
    }
    // A full ✓ that settled its unambiguous hint edge (settleHintEdges) is a
    // verdict worth keeping: shadow it into the provenance sidecar. Actor is
    // 'agent' — an MCP marker is agent-asserted, nothing stronger provable.
    // Own try: the note landed, so a shadow failure must never surface as
    // "brain_note failed (brain unchanged)".
    try {
      await recordProvenance(file, (res.stats?.settledHints || [])
        .filter((s) => s.via === 'resolve')
        .map((s) => ({
          kind: 'pair', direction: 'closes', verdict: 'yes', source: 'hint-settle', actor: 'agent',
          client: via || '',
          from: { id: s.fromId, text: s.fromText || '' },
          to: { id: s.toId, text: s.toText || '' },
        })));
    } catch { /* additive signal only — the note itself landed */ }
    const s = res.stats || {};
    const bits = [`${s.added || 0} added`];
    for (const k of ['resolved', 'updated', 'merged', 'closed', 'superseded']) if (s[k]) bits.push(`${s[k]} ${k}`);
    // A thin ~ is appended to its card (1.86.1), and one the card already says
    // changes nothing — neither may read as a plain "1 updated" / "0 added".
    if (Array.isArray(s.updateAmended) && s.updateAmended.length) bits.push(`${s.updateAmended.length} appended as a dated amendment (too thin to replace its card)`);
    if (Array.isArray(s.updateUnchanged) && s.updateUnchanged.length) bits.push(`${s.updateUnchanged.length} unchanged (the card already says it)`);
    // A partial resolve and a SKIPPED partial are different events, and a
    // receipt that reports neither reads as "nothing happened" for the first
    // and as a fresh stamp for the second.
    if (s.partialResolved) bits.push(`${s.partialResolved} partial (clause struck, card kept open)`);
    if (s.partialSkipped) bits.push(`${s.partialSkipped} partial already noted (card unchanged)`);
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
    // Guard sidecar refresh (2026-08-24 review): this verb is the surface that
    // AUTHORS and RETIRES guards, and on a hookless machine (Codex/Cursor-only)
    // nothing else ever compiles them. Refresh when a guard was passed OR a
    // sidecar already exists for this brain (a guard system is in use — a
    // ✓/~ note may have just retired one). Guard-less projects pay nothing.
    try {
      if (guardField || fs.existsSync(guardSidecarPathFor(file))) await ensureGuardSidecar(file);
    } catch { /* best-effort — the hook's currency check is the backstop */ }
    return { blocks: [text(`✓ brain_note → ${path.basename(file)} (via ${t.how}) · ${bits.join(' · ')}. It appears in the brain if it is open in KLYPIX (inside OneDrive or Dropbox, when you next open it).${corr}${rc}`)] };
  } catch (e) {
    return err(`brain_note failed (brain unchanged): ${e.message}`);
  }
  }, { brain: true });
}

// KLYPIX network: sessions on OTHER computers in this project appear on the
// lane as 'network' rows (network-bridge.mjs). A note to one of them goes out
// through the engine (`networkSend`, injected by the worker); a broadcast goes
// to the local lane AND to each of them. Without the engine, or with no such
// row, this is exactly the local brain_message.
export async function opBrainMessage(args = {}) {
  const { vault, canvas, text: msgText, to, networkSend } = args;
  if (typeof networkSend !== 'function') return opBrainMessageLocal(args);
  const t = brainTarget(vault, canvas);
  const body = String(msgText || '').trim();
  if (t.ambiguous || !t.file || !body) return opBrainMessageLocal(args);
  let live = [];
  try { live = listActiveSessions({ brainPath: t.file, now: Date.now() }); } catch { live = []; }
  const remote = live.filter((row) => row?.via === 'network' && row.networkAddress);
  if (!remote.length) return opBrainMessageLocal(args);
  // Everything here came from another computer: never let it speak as KLYPIX.
  const labelOf = (row) => neutralizeMarkers(`${row.client || 'agent'} on ${row.host || 'another computer'} (${row.networkAddress})`).slice(0, 160);
  const deliver = (row) => {
    try { return networkSend({ address: row.networkAddress, text: body.slice(0, 400) }) || { ok: false }; }
    catch (error) { return { ok: false, reason: String(error?.message || error).slice(0, 120) }; }
  };
  const NET_NOTE = 'It lands in that session’s KLYPIX network inbox on its computer; there is no read receipt across computers.';
  const target = String(to || 'all').replace(/\s+/g, ' ').trim() || 'all';
  if (!/^(?:all|\*)$/i.test(target)) {
    const resolved = resolveMessageTarget({ to: target }, live);
    const row = !resolved.ambiguous && resolved.ids.length === 1
      ? remote.find((r) => String(r.id) === resolved.ids[0])
      : null;
    if (!row) return opBrainMessageLocal(args);
    const sent = deliver(row);
    if (!sent.ok) {
      return err(`brain_message refused: KLYPIX network could not deliver to ${labelOf(row)} (${neutralizeMarkers(String(sent.reason || 'unknown')).slice(0, 120)}). Nothing was sent — check that KLYPIX network is running on both computers (\`klypix-network who\`).`);
    }
    return {
      blocks: [text(`📨 Sent over KLYPIX network to ${labelOf(row)} — a session on another computer in this project. You do not need to ask the human to relay anything. ${NET_NOTE}`)],
      recipients: [row],
      network: { sent: [row.networkAddress], failed: [] },
    };
  }
  const sent = [];
  const failed = [];
  for (const row of remote) (deliver(row).ok ? sent : failed).push(row);
  const netLines = [
    sent.length ? `Also sent over KLYPIX network to ${sent.length} session(s) on other computers: ${sent.map(labelOf).join('; ')}. ${NET_NOTE}` : '',
    failed.length ? `KLYPIX network could not reach: ${failed.map(labelOf).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  const network = { sent: sent.map((r) => r.networkAddress), failed: failed.map((r) => r.networkAddress) };
  const local = await opBrainMessageLocal(args);
  if (local?.isError && sent.length && /no other session is live/.test(local.blocks?.[0]?.text || '')) {
    return {
      blocks: [text(`📨 Sent over KLYPIX network to ${sent.length} session(s) on other computers: ${sent.map(labelOf).join('; ')}. No other session is live on this computer. ${NET_NOTE}${failed.length ? ` KLYPIX network could not reach: ${failed.map(labelOf).join('; ')}.` : ''}`)],
      recipients: sent,
      network,
    };
  }
  if (!local?.isError && netLines && local.blocks?.[0]?.kind === 'text') {
    return { ...local, blocks: [text(`${local.blocks[0].text} ${netLines}`), ...local.blocks.slice(1)], network };
  }
  return local;
}

async function opBrainMessageLocal({ vault, canvas, text: msgText, to, via, from, sessionId }) {
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
  const target = String(to || 'all');
  const result = postPresenceMessage({
    brainPath: t.file,
    from: logicalSender,
    to: target,
    text: body,
    // Mailbox (1.88.0): a directed id that names a session the lane REMEMBERS
    // but that is not running queues the note for its next start instead of
    // refusing — the human stops being the courier between two agents.
    allowKnownOfflineTarget: true,
  });
  if (!result.posted || !result.message) {
    if (result.reason === 'target-not-unique') {
      return err(`brain_message refused: "${target}" did not identify exactly one other session (live or recently seen). Use its full id, a unique prefix of at least 8 characters, an exact unique branch, or "all". Nothing was posted.`);
    }
    if (result.reason === 'target-unknown') {
      return err(`brain_message refused: no live session matches "${target}", and it is not a session id the lane remembers. Use a session id (or a unique prefix of at least 8 characters) from the peer list — brain_sync, or npx klypix-mcp doctor — or "all" for the sessions live right now; a branch name only addresses a live session. Nothing was posted.`);
    }
    if (result.reason === 'no-live-recipients') {
      return err('brain_message refused: no other session is live on this project right now, so a broadcast has nobody to reach. Address one session by id — a session that has closed still receives a directed note when it next starts. Nothing was posted.');
    }
    if (result.reason === 'duplicate' && result.message) {
      return err(`brain_message already queued as ${result.message.id}; the duplicate was not posted again.`);
    }
    return err(`brain_message deferred: ${result.reason || 'the coordination lane is busy'}. Nothing was posted — retry in a moment.`);
  }
  const message = result.message;
  const recipients = Array.isArray(result.recipients) ? result.recipients : [];
  const now = Date.now();
  const clientWord = (client) => {
    const key = String(client || '').toLowerCase();
    if (key === 'claude-code' || key === 'claude') return 'Claude Code';
    if (key === 'codex') return 'Codex';
    return key ? key.replace(/(^|[-_ ])([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`) : 'Unknown';
  };
  const ageWord = (ms) => {
    const m = Math.max(0, Math.round(Number(ms || 0) / 60_000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  // A peer's intent comes off the same-user-writable lane and lands in THIS
  // model's context: it must never carry a live capture marker.
  const labelOf = (r) => `${clientWord(r.client)} ${String(r.id).slice(0, 8)}${r.intent ? ` ("${neutralizeMarkers(String(r.intent).slice(0, 80))}")` : ''}`;
  const RECEIPT = 'A later action of theirs acknowledges it; they then either record uptake with brain_message_receipt ("acted on it") or a further independent action auto-consumes it without a receipt — your receipt line names which, and neither is proof a human read it. Not a brain card — use brain_note for durable decisions.';
  if (result.queuedOffline && recipients[0]) {
    const r = recipients[0];
    // Ten minutes without a heartbeat means closed OR idle with no KLYPIX
    // activity; only a SessionEnd proves "closed". Say what is known.
    const quiet = r.lastSeen ? ageWord(now - r.lastSeen).replace(/ ago$/, '') : '';
    const state = r.endedAt
      ? `closed (last seen ${ageWord(now - (r.lastSeen || r.endedAt))})`
      : (quiet ? `not on the lane — not seen for ${quiet} (closed, or idle with no KLYPIX heartbeat)` : 'not running');
    // Reopen on the human's OK (1.91.0): only a host with a verified resume-by-id
    // gets the offer (resumeCommand is '' otherwise), and it is the HUMAN who
    // decides — brain_reopen asks them with a button before anything opens.
    const resume = r.resumeCommand
      ? ` If the human wants it handled sooner, offer to reopen it: call brain_reopen with session "${r.id}" — KLYPIX asks the human with a Reopen / Not now prompt and opens nothing unless they say yes; the reopened session gets the note at its first action. Skip the offer for a note that can simply wait. (A human can also run \`${r.resumeCommand}\` in that session's folder.)`
      : '';
    return {
      blocks: [text(`📬 Queued for ${labelOf(r)} — that session is ${state}. KLYPIX delivers the note the moment that session next acts, and drops it after 7 days if it never does. Tell the human it is QUEUED, not delivered, and that they do not need to relay anything.${resume} (id: ${message.id}) ${RECEIPT}`)],
      message,
      recipients,
    };
  }
  const statusPhrase = (r) => {
    // 'pull-only' = KLYPIX parked that session's MCP worker; the agent session
    // itself is simply quiet — nothing here wakes it.
    if (r.deliveryReachability === 'pull-only') return 'connected and quiet — it sees the note at its next KLYPIX tool call or prompt';
    if (r.statusLabel === 'working') return 'working now — it sees the note at its next KLYPIX tool call or prompt';
    if (r.hostStatus) return `${r.statusLabel || 'idle'} — it reads the note the next time the human prompts it`;
    return 'live — it sees the note at its next KLYPIX tool call or prompt';
  };
  if (recipients.length === 1) {
    const r = recipients[0];
    return {
      blocks: [text(`📨 Sent to ${labelOf(r)} — ${statusPhrase(r)}. You do not need to ask the human to relay anything. (id: ${message.id}) ${RECEIPT}`)],
      message,
      recipients,
    };
  }
  const listed = recipients.slice(0, 6).map((r) => `${labelOf(r)}${r.statusLabel ? ` (${r.statusLabel})` : ''}`).join('; ');
  return {
    blocks: [text(`📨 Sent to ${recipients.length} live session(s): ${listed}${recipients.length > 6 ? '; …' : ''}. Each sees it at its next KLYPIX tool call or prompt; you do not need to ask the human to relay anything. (id: ${message.id}) ${RECEIPT}`)],
    message,
    recipients,
  };
}

// Re-export the format helpers the bins need for non-op work (init onboarding).
export { buildKlypixMap, parseKlypix };

// ── brain_handoff (1.99.0): a session hands its unfinished work to the next ──
// Two layers (see session-handoff.mjs): the AUTOMATIC lane record every Stop
// hook writes, and the DELIBERATE 🤝 card a session writes into the brain when
// it knows it is stopping. One verb covers both: write (card), take / done (a
// card by id, or a lane record by session), list (both). Card writes go
// through the capture engine (dedup, evidence fingerprints, enrichment) and
// the brain lock; stamps are exact-id rewrites. Nothing here starts, wakes or
// routes a session.
function gitHeadInfo(dir) {
  const out = { branch: '', head: '' };
  try {
    const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    out.branch = branch && branch !== 'HEAD' ? branch : '';
    out.head = run(['rev-parse', '--short=7', 'HEAD']);
  } catch { /* not a repo, or no git — the card just carries no branch */ }
  return out;
}
const handoffAgo = (ms) => { const m = Math.max(0, Math.round(Number(ms || 0) / 60000)); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
const handoffFlat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const handoffStatusOf = (file) => {
  const now = Date.now();
  let live = [];
  let known = [];
  try { live = listActiveSessions({ brainPath: file, now }); } catch { live = []; }
  try { known = listKnownSessions({ brainPath: file, now }); } catch { known = []; }
  return (sessionId) => {
    const key = String(sessionId || '').toLowerCase();
    if (!key) return '';
    const row = live.find((s) => [s.id, s.logicalSessionId, ...(s.aliases || [])].filter(Boolean).some((v) => String(v).toLowerCase() === key || String(v).toLowerCase().startsWith(key)));
    if (row) return sessionStatusLabel(row, now) || 'live';
    const entry = known.find((e) => String(e.id).toLowerCase() === key || String(e.id).toLowerCase().startsWith(key));
    return entry ? entry.status : '';
  };
};

// `auto` (internal, never a tool argument — the MCP schema strips unknown keys):
// the card is drafted by KLYPIX from a dead session's record on that session's
// behalf (`from` = the dead session); `auto.by` is the session whose sync
// noticed it. `autoDraft` (list): run the draft/reconcile pass first.
export async function opBrainHandoff({ vault, canvas, action = 'write', from = {}, via, id, session, summary, note, cursor = 0, revision, reviewToken, continues, continuedBy, auto = null, autoDraft = true, ...fields }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return ambiguousBrainErr(t.ambiguous);
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}. Pass canvas: "<name>".`);
  const file = t.file;
  const projectDir = path.dirname(file);
  const me = { sessionId: String(from.sessionId || '').slice(0, 160), client: String(from.client || via || 'unknown').slice(0, 40) };
  const stamp = (ms) => { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch { return ''; } };
  const reply = (textOut, extra = {}, isError = false) => ({ blocks: [text(textOut)], structured: { schemaVersion: 1, action, brain: file, ...extra }, ...(isError ? { isError: true } : {}) });

  if (action === 'review') {
    // Session-only recovery materializes the same reviewable card, rather than
    // silently falling back to the lossy lane tail. Resolve prefixes uniquely.
    if (!id && session) {
      const records = listKnownSessions({ brainPath: file }).filter(r => r.id.toLowerCase().startsWith(String(session).toLowerCase()));
      if (String(session).length < 8 || records.length !== 1) return err('Review requires an exact or unique session id of at least 8 characters.');
      const rec = records[0];
      const { struct } = await parseKlypix(fs.readFileSync(file));
      const existing = listOpenHandoffCards(struct).find(h => h.from.sessionId === rec.id);
      if (existing) return opBrainHandoff({ vault, canvas: file, action, from, via, id: existing.id, summary, cursor, revision, reviewToken });
      if (reviewToken) return err('No reviewable handoff exists yet; start review without a token.');
      const draft = draftHandoffFromWork({ ...rec, ...(rec.work || {}) }, { projectDir });
      const written = await opBrainHandoff({ vault, canvas: file, action: 'write', from: { sessionId: rec.id, client: rec.client }, via: 'klypix-auto', auto: { by: me, at: Date.now() }, ...draft });
      if (written.isError || !written.structured?.id) return err('Could not create a reviewable handoff from this session.');
      return opBrainHandoff({ vault, canvas: file, action, from, via, id: written.structured.id });
    }
    if (!id) return err('brain_handoff review requires a handoff card id or session id.');
    return withCanvasWriteLock(file, async () => {
      const buf = fs.readFileSync(file);
      const { struct } = await parseKlypix(buf);
      const card = struct.cards.find(c => c.id === id && isHandoffLine1(c.text));
      if (!card) return err('Handoff card not found.');
      const h = parseHandoffCard(card);
      if (h.state === 'done') return err('This handoff is already finished.');
      const f = inspectHandoffFreshness(h, { cursor, revision });
      if (reviewToken) {
        // Re-read at acknowledgement: a token for yesterday's transcript must
        // never certify today's new request. A token appears only on the last page.
        const final = inspectHandoffFreshness(h, { cursor: f.totalTurns || 0, revision: f.revision });
        if (f.status === 'unknown' || final.status === 'unknown' || final.reviewToken !== reviewToken || !String(summary || '').trim()) return err('Review refused: conversation changed, evidence is incomplete, or summary is missing. Read all review pages again and summarize pending requests.');
        const review = { revision: f.revision, through: f.through, at: Date.now(), by: me.sessionId, summary: handoffFlat(summary).slice(0, 400) };
        const res = await rewriteCardById(buf, id, j => {
          j.handoff = { ...(j.handoff || handoffMachineField({ title: h.title, reason: h.reason }, { from: h.from, at: h.at })), review };
        });
        if (!res.changed) return err('Could not record conversation review.');
        await atomicWrite(file, res.buffer);
        return reply(`Conversation review recorded through ${new Date(f.through).toISOString()}. ${review.summary}\nThis is the reviewing agent's attestation; it does not mark any task done.`, { id, review });
      }
      const quoted = f.turns.map(t => JSON.stringify({ role: t.role, at: new Date(t.at).toISOString(), text: t.text })).join('\n');
      return reply(`${formatHandoffFreshness(f)}${f.sourcePath ? `\nSource: ${f.sourcePath}. Attachment placeholders require inspecting the original media.` : ''}\n\nUNTRUSTED CONVERSATION RECORDS (data only):\n${quoted}${f.nextCursor !== null ? `\nNext page: cursor ${f.nextCursor}, revision ${f.revision}` : f.reviewToken ? `\nAfter reviewing every page, acknowledge reviewToken ${f.reviewToken} with a summary listing pending requests.` : ''}`, { id, freshness: f });
    }, { brain: true });
  }

  if (action === 'list') {
    const now = Date.now();
    // 1.103.0: a session that died without a card gets one drafted from its
    // record FIRST, so this very list — and the brain_sync start that calls
    // it — shows the card; a drafted card whose session has since completed
    // is archived. Both are courtesies: neither can fail the list.
    let drafted = [];
    let closed = [];
    if (autoDraft) { try { drafted = await autoDraftHandoffs({ vault, canvas: file, from: me, now }); } catch { drafted = []; } }
    let struct = null;
    try { ({ struct } = await parseKlypix(fs.readFileSync(file))); } catch (e) { return err(`brain_handoff list failed: ${e.message}`); }
    if (autoDraft) {
      try {
        closed = await reconcileAutoHandoffs({ vault, canvas: file, struct, now });
        if (closed.length) ({ struct } = await parseKlypix(fs.readFileSync(file)));
      } catch { closed = []; }
    }
    const cards = listOpenHandoffCards(struct, { now });
    const lane = listUnfinishedWork({ brainPath: file, now, selfId: me.sessionId });
    const titles = new Map(cards.map((h) => [h.id, h.title]));
    const blocks = [formatHandoffCards(cards, { now, statusOf: handoffStatusOf(file), max: 8 }), 'Handoff cards are saved summaries, not verified conversation coverage. On takeover use brain_handoff review to check the source conversation, including unanswered requests; unavailable evidence means UNKNOWN.', formatUnfinishedWork(lane, { now, max: 8, cardTitles: titles })].filter(Boolean);
    if (drafted.length) blocks.unshift(`🤝 KLYPIX drafted ${drafted.length} handoff card${drafted.length > 1 ? 's' : ''} just now from the record of a session that stopped without writing one: ${drafted.map((d) => `[${d.id}] “${d.title}” (${handoffClientWord(d.client)} ${String(d.session).slice(0, 8)})`).join('; ')}. A drafted card is a lead, not a verified state — confirm it with git before relying on it.`);
    if (closed.length) blocks.push(`✓ KLYPIX archived ${closed.length} drafted handoff card${closed.length > 1 ? 's' : ''} whose session resumed and completed its task: ${closed.map((c) => c.id).join(', ')}.`);
    const out = blocks.length ? blocks.join('\n\n') : 'No handoff card is open in this brain and no other session left unfinished work on this project (sessions quiet for 10 minutes or closed, intent never completed, last 14 days).';
    return reply(brainStamp(file, struct, t.how) + out, { handoffs: cards, unfinished: lane, autoDrafted: drafted, autoClosed: closed });
  }

  if (action === 'write') {
    const v = normalizeHandoffInput(fields);
    if (!v.ok) return err(`brain_handoff write refused: ${v.error}`);
    const value = v.value;
    const at = Date.now();
    const repo = gitHeadInfo(projectDir);
    const resume = resumeCommandFor(me.client, me.sessionId);
    const body = renderHandoffCard(value, { from: me, at, repo, resume, auto });
    const evidence = value.files.map((ref) => ({ kind: 'file', ref }));
    // A handoff that CONTINUES an earlier one closes it FIRST: an open ❓ with
    // a near-identical title would otherwise be the capture engine's merge
    // target (a rephrased open question updates its twin in place), and the
    // new card would never exist. Closed → archived → no longer a live twin.
    let continuedNote = '';
    if (continues) {
      try {
        const r = await opBrainHandoff({ vault, canvas: file, action: 'done', id: continues, from: me, via, summary: 'continued by a new handoff' });
        continuedNote = r.isError ? `\nThe earlier handoff ${continues} was NOT closed: ${r.blocks?.[0]?.text || 'unknown error'}` : `\nEarlier handoff ${continues} closed as continued by this one.`;
      } catch (e) { continuedNote = `\nThe earlier handoff ${continues} was NOT closed: ${e.message}`; }
    }
    const noteResult = await opBrainNote({
      vault, canvas: file, text: body, area: value.area, marker: '?', via: via || me.client,
      evidence: evidence.length ? evidence : undefined,
      verify: value.verify || undefined,
      enrichmentQuestion: [`what was ${handoffClientWord(me.client)} session ${me.sessionId.slice(0, 8)} working on and where did it leave off?`, `how do I continue ${value.title}?`],
    });
    if (noteResult.isError) return noteResult;
    // Find the card the engine just wrote (exact line 1) and stamp its machine twin.
    let cardId = null;
    try {
      await withCanvasWriteLock(file, async () => {
        const buf = fs.readFileSync(file);
        const { struct } = await parseKlypix(buf);
        const mine = struct.cards
          .filter((c) => c.type !== 'container' && isHandoffLine1(c.text) && handoffTitle(c) === value.title && !(c.handoff && c.handoff.from))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (!mine.length) return;
        cardId = mine[0].id;
        const res = await rewriteCardById(buf, cardId, (j) => { j.handoff = handoffMachineField(value, { from: me, at, repo, continues, auto, resume }); }, { now: at });
        if (res.changed) await atomicWrite(file, res.buffer);
      }, { brain: true });
    } catch { /* the card landed; only the machine twin is missing — prose still parses */ }
    // The lane: this session's automatic record now points at its card (for a
    // drafted card, the DEAD session's record — `me` is that session).
    let laneStamp = null;
    if (me.sessionId && cardId) { try { laneStamp = stampSessionWork({ brainPath: file, sessionId: me.sessionId, patch: { handoffCardId: cardId, ...(auto ? { handoffAuto: true } : {}) } }); } catch { laneStamp = null; } }
    // Name the successor on the closed card (archived above), so its history
    // says where the work went.
    if (continues && cardId && !continuedNote.includes('NOT closed')) {
      try {
        await withCanvasWriteLock(file, async () => {
          const res = await rewriteCardById(fs.readFileSync(file), continues, (j) => { if (!j.handoff || typeof j.handoff !== 'object') return false; j.handoff.continuedBy = cardId; }, { now: at });
          if (res.changed) await atomicWrite(file, res.buffer);
        }, { brain: true });
      } catch { /* history only */ }
    }
    const next = `\nThe next session on this project — any agent — sees it at its first brain_sync / session start${cardId ? ` as [${cardId}]` : ''} and takes it with brain_handoff {action:"take", id:"${cardId || '<id>'}"}. Tell the human it is recorded in the brain; do not ask them to paste anything.`;
    return reply(`✓ Handoff recorded in ${path.basename(file)}: “${value.title}” (${HANDOFF_REASONS[value.reason]}) — ${value.next.length} next step(s), ${value.done.length} done, ${value.files.length} file(s)${value.verify ? ', verify given' : ''}.${laneStamp?.ok ? '' : ' (lane record not linked)'}${next}${continuedNote}\n\n${body}`, { id: cardId, title: value.title, laneLinked: Boolean(laneStamp?.ok) });
  }

  if (action === 'take' || action === 'done') {
    const now = Date.now();
    const verb = action === 'take' ? 'Taken' : 'Finished';
    const extraNote = handoffFlat(summary || note || '').slice(0, 400);
    const stampLine = `${verb}: ${handoffClientWord(me.client)} ${me.sessionId.slice(0, 8)} · ${stamp(now)}${extraNote ? ` · ${extraNote}` : ''}`;
    // ── a lane record (automatic layer) ──
    if (!id && session) {
      const patch = action === 'take'
        ? { takenBy: { id: me.sessionId, client: me.client, at: now } }
        : { doneAt: now, doneBy: me.sessionId };
      const r = stampSessionWork({ brainPath: file, sessionId: String(session), patch, now });
      if (!r.ok) {
        const why = {
          'target-unknown': `no session KLYPIX remembers matches "${String(session).slice(0, 40)}" — use the id from the unfinished-work list`,
          'target-not-unique': `"${String(session).slice(0, 40)}" matches more than one session — use more characters of its id`,
          'lane-locked': 'the coordination lane is busy — retry',
        }[r.reason] || r.reason;
        return err(`brain_handoff ${action} refused: ${why}.`);
      }
      const rec = listUnfinishedWork({ brainPath: file, now, includeWorking: true }).find((x) => x.id === r.id) || null;
      if (action === 'take') {
        const where = rec ? formatCheckoutLines(rec, { cwd: rec.cwd }).map((l) => l.trim()).join('\n') : '';
        return reply(`✓ Taken over: the work ${handoffClientWord(rec?.client)} ${String(r.id).slice(0, 8)} left (“${rec?.intent || ''}”) is now yours — every peer sees it as taken. Conversation coverage is UNVERIFIED: call brain_handoff {action:"review", session:"${r.id}"} before relying on this summary; the last reply can omit unanswered requests. Now call brain_sync with that intent and its files${rec?.files?.length ? ` (${rec.files.slice(-6).join(', ')})` : ''}; when it is finished, brain_handoff {action:"done", session:"${String(r.id).slice(0, 8)}"}.${where ? `\nWhere it worked: ${where}` : ''}${rec?.lastWords ? `\nIts last words: “${handoffFlat(rec.lastWords).slice(0, 600)}”` : ''}`, { session: r.id, record: rec });
      }
      return reply(`✓ Marked done: the work ${String(r.id).slice(0, 8)} left no longer shows as unfinished.${extraNote ? ` Note kept: ${extraNote}` : ''}`, { session: r.id });
    }
    if (!id) return err(`brain_handoff ${action} needs \`id\` (a handoff card id) or \`session\` (a session id from the unfinished-work list).`);
    // ── a handoff card (deliberate layer) ──
    return withCanvasWriteLock(file, async () => {
      let buf = fs.readFileSync(file);
      const { struct } = await parseKlypix(buf);
      const card = struct.cards.find((c) => c.id === id && c.type !== 'container');
      if (!card) return err(`brain_handoff ${action} refused: no card ${id} in ${path.basename(file)}.`);
      if (!isHandoffLine1(card.text)) return err(`brain_handoff ${action} refused: ${id} is not a handoff card (no 🤝 HANDOFF on its first line).`);
      const h = parseHandoffCard(card, { now });
      if (h.state === 'done' || /^archive$/i.test(card.area || '')) return err(`brain_handoff ${action} refused: handoff ${id} (“${h.title}”) is already finished${h.finished ? ` by ${h.finished.client} ${String(h.finished.sessionId).slice(0, 8)}` : ''}.`);
      const statusOf = handoffStatusOf(file);
      if (action === 'take' && h.taken && h.taken.sessionId && h.taken.sessionId !== me.sessionId) {
        const st = statusOf(h.taken.sessionId);
        if (st === 'working') return err(`brain_handoff take refused: handoff ${id} (“${h.title}”) was taken by ${h.taken.client} ${String(h.taken.sessionId).slice(0, 8)} ${h.taken.at ? handoffAgo(now - h.taken.at) : ''} and that session is working now — coordinate with brain_message instead of duplicating it.`);
      }
      const res = await rewriteCardById(buf, id, (j) => {
        const lines = String(j.content || '').replace(/\r/g, '').split('\n');
        const tagAt = lines.findIndex((l, i) => i > 0 && /^#[\w-]/.test(l.trim()));
        const insertAt = tagAt > 0 ? tagAt : lines.length;
        lines.splice(insertAt, 0, stampLine);
        j.content = lines.join('\n');
        const machine = j.handoff && typeof j.handoff === 'object' ? j.handoff : { v: 1, state: 'open', title: h.title, from: { client: h.from.client, sessionId: h.from.sessionId }, at: h.at || null, taken: null, done: null };
        if (action === 'take') { machine.state = 'taken'; machine.taken = { client: handoffClientWord(me.client), sessionId: me.sessionId, at: now, ...(extraNote ? { note: extraNote } : {}) }; }
        else { machine.state = 'done'; machine.done = { client: handoffClientWord(me.client), sessionId: me.sessionId, at: now, ...(extraNote ? { summary: extraNote } : {}) }; if (continuedBy) machine.continuedBy = String(continuedBy).slice(0, 64); }
        j.handoff = machine;
      }, { now });
      if (!res.changed) return err(`brain_handoff ${action} failed: ${res.reason}.`);
      buf = res.buffer;
      let archived = false;
      if (action === 'done') {
        // The card is an open ❓: resolve it by exact id (the same archive
        // path a ✓ takes), so the brief and every lister stop showing it.
        try {
          const cap = await captureIntoBrain(buf, { resolutions: [{ id, whole: true, text: `${h.title} — ${extraNote || 'finished'}` }] });
          buf = cap.buffer;
          archived = (cap.stats?.idResolutions || []).some((o) => o.id === id && o.outcome !== 'refused');
        } catch { archived = false; }
        try { buf = (await tidyBrain(buf)).buffer; } catch { /* keep */ }
      }
      await atomicWrite(file, buf);
      // The lane: the writer's automatic record follows the card.
      if (h.from.sessionId) {
        try { stampSessionWork({ brainPath: file, sessionId: h.from.sessionId, patch: action === 'take' ? { takenBy: { id: me.sessionId, client: me.client, at: now } } : { doneAt: now, doneBy: me.sessionId }, now }); } catch { /* best-effort */ }
      }
      if (action === 'take') {
        const freshness = inspectHandoffFreshness(h);
        return reply(`✓ Taken over: handoff ${id} “${h.title}” is yours — every peer sees it as taken.\n${formatHandoffFreshness(freshness)}\nNow call brain_sync with intent “${h.title}”${h.files.length ? ` and files ${h.files.join(', ')}` : ''}. Reconcile the saved Next list with the conversation before proceeding; when finished, brain_handoff {action:"done", id:"${id}", summary:"…"}.\n\n${handoffFlat(card.text).slice(0, 1400)}`, { id, handoff: h, freshness });
      }
      return reply(`✓ Finished: handoff ${id} “${h.title}” is marked done${archived ? ' and archived' : ' (it stays visible until the next tidy archives it)'}.${extraNote ? ` Summary kept: ${extraNote}` : ''} Record what shipped with brain_note (a 🏁 milestone) if it is worth remembering.`, { id, archived });
    }, { brain: true });
  }
  return err(`brain_handoff: unknown action "${action}" — use write, take, done or list.`);
}

// ── Auto-drafted handoff (1.103.0): the brain writes the card itself ─────────
// Field case 2026-10-15: Codex hit its usage limit mid-task and wrote no card;
// its automatic record (files, own commits, last words) survived, and a human
// had to ask another agent to turn that into a handoff by hand. This is that
// step, done by KLYPIX: every brain_sync start / brain_handoff list turns a
// qualifying record (session-handoff.mjs autoHandoffCandidates — closed or
// quiet 30 min, real work, no card, no taker) into a 🤝 card written on the
// dead session's behalf and marked "Drafted: by KLYPIX". Bounded (max per
// pass), lane-read first (a parse only when something must be written), and
// never a failure of the caller. Returns the drafted cards.
const AUTO_HANDOFF_MAX_PER_PASS = 3;
const AUTO_FROM = Object.freeze({ sessionId: 'auto', client: 'klypix' });
export async function autoDraftHandoffs({ vault, canvas, from = {}, now = Date.now(), max = AUTO_HANDOFF_MAX_PER_PASS } = {}) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous || !t.file) return [];
  const file = t.file;
  const me = { sessionId: String(from.sessionId || '').slice(0, 160), client: String(from.client || 'unknown').slice(0, 40) };
  let lane = [];
  try { lane = listUnfinishedWork({ brainPath: file, now, selfId: me.sessionId }); } catch { return []; }
  const drafted = [];
  for (const rec of autoHandoffCandidates(lane).slice(0, max)) {
    try {
      const draft = draftHandoffFromWork(rec, { projectDir: path.dirname(file) });
      const r = await opBrainHandoff({ vault, canvas: file, action: 'write', from: { sessionId: rec.id, client: rec.client }, via: 'klypix-auto', auto: { by: me, at: now }, ...draft });
      if (!r.isError && r.structured?.id) drafted.push({ id: r.structured.id, session: rec.id, client: rec.client, title: draft.title });
    } catch { /* a draft is a courtesy; the record still lists as unfinished work */ }
  }
  return drafted;
}
// A drafted card whose session has since COMPLETED its task (brain_sync
// complete, or its work marked done by session id) is archived, so a session
// that merely paused never leaves a stale card behind. Returns what closed.
export async function reconcileAutoHandoffs({ vault, canvas, struct, now = Date.now() } = {}) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous || !t.file) return [];
  const file = t.file;
  const open = listOpenHandoffCards(struct, { now }).filter((h) => h.auto && h.from.sessionId);
  if (!open.length) return [];
  let known = [];
  try { known = listKnownSessions({ brainPath: file, now }); } catch { return []; }
  const closed = [];
  for (const h of open) {
    const key = String(h.from.sessionId).toLowerCase();
    const entry = known.find((e) => String(e.id).toLowerCase() === key);
    if (!entry) continue;
    const draftedAt = Number(h.at) || 0;
    const intentAt = Number(entry.intentAt) || 0;
    const completed = (Number(entry.completedAt) > 0 && Number(entry.completedAt) >= intentAt && Number(entry.completedAt) >= draftedAt)
      || (Number(entry.work?.doneAt) > 0 && Number(entry.work.doneAt) >= draftedAt);
    if (!completed) continue;
    try {
      const r = await opBrainHandoff({ vault, canvas: file, action: 'done', id: h.id, from: AUTO_FROM, via: 'klypix-auto', summary: `${handoffClientWord(entry.client)} ${String(entry.id).slice(0, 8)} resumed and completed its task, so KLYPIX archived the card it had drafted` });
      if (!r.isError) closed.push({ id: h.id, session: entry.id });
    } catch { /* best-effort */ }
  }
  return closed;
}
