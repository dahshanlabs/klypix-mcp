// brain-graveyard — the recoverable bin for items deleted from a brain.
//
// WHY THIS AND NOT THE ARCHIVE CONTAINER. "Archived" in a KLYPIX brain is a
// containment fact: the card's parent is a container titled "Archive". Those
// cards are STILL in canvas.json's `order`, so they still render — this repo's
// own brain has 275 of them on the canvas right now. Routing deletes there
// would make a deleted card visibly reappear (and, because the merge's position
// comparator ignores parentId, reappear exactly where it was). It would also
// leak: `read_canvas` and `search_canvases` have no archive awareness at all,
// `brain_ask` includes archived cards by design, and the embedder embeds them.
//
// So a deleted card leaves `order` entirely and its bytes move to `graveyard/`,
// which `parseKlypix` reads into `struct.graveyard` and deliberately never
// merges into `struct.cards`. That one choice makes every leak impossible by
// construction rather than by remembering to filter in 30-odd call sites.
//
// PURGE STAYS AVAILABLE, AND HONEST. brain.klypix is git-tracked and syncs to
// collaborators, so "delete" is also the escape hatch for a pasted key or a
// personal detail. Purge removes the bytes from the working file — it cannot
// remove them from git history, and the caller is told so.
import fs from 'fs';
import JSZip from 'jszip';
import { parseKlypix, shard } from './klypix-format.mjs';

export const DEFAULT_RETENTION_DAYS = 30;

const compact = (value, max = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A bounded, type-aware description safe to show without restoring the item. */
export function summarizeGraveyardCard(card) {
  if (!card || typeof card !== 'object') return null;
  const type = compact(card.type, 32) || 'unknown';
  const text = compact(card.content || card.code || card.description || card.details);
  const title = compact(card.title || card.fileName || card.question || card.siteName || card.url, 180);
  const label = title || text;
  return {
    type,
    label,
    preview: text,
    ...(Number.isFinite(card.fileSize) ? { fileSize: Number(card.fileSize) } : {}),
    ...(card.extension ? { extension: compact(card.extension, 20) } : {}),
    ...(Number.isFinite(card.originalWidth) ? { width: Number(card.originalWidth) } : {}),
    ...(Number.isFinite(card.originalHeight) ? { height: Number(card.originalHeight) } : {}),
    ...(card.language ? { language: compact(card.language, 30) } : {}),
    ...(card.url ? { url: compact(card.url, 500) } : {}),
    ...(card.projectGraph?.counts ? {
      projectGraph: {
        nodes: Number(card.projectGraph.counts.nodes) || 0,
        edges: Number(card.projectGraph.counts.edges) || 0,
      },
    } : {}),
  };
}

/** Deleted cards, newest first. */
export async function listGraveyard(buf) {
  const { struct, zip } = await parseKlypix(buf);
  const result = [];
  for (const entry of (struct.graveyard || [])) {
    let card = null;
    let summary = entry.summary && typeof entry.summary === 'object' ? entry.summary : null;
    if (!summary) {
      try {
        const file = zip.file(`graveyard/${shard(entry.id)}/${entry.id}.json`);
        if (file) card = JSON.parse(await file.async('string'));
        summary = summarizeGraveyardCard(card);
      } catch { /* one damaged deleted item must not hide the rest of the bin */ }
    }
    result.push({
      ...entry,
      // Pre-audit entries only carried deletedBy:"human". That was a generic
      // merge stamp, not proof, so expose them honestly as legacy/unverified.
      deletion: entry.deletion && typeof entry.deletion === 'object'
        ? entry.deletion
        : { initiator: 'unknown', cause: 'legacy', source: 'legacy', confidence: 'legacy' },
      summary,
    });
  }
  return result;
}

async function readIndex(zip) {
  const f = zip.file('graveyard.json');
  if (!f) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(await f.async('string'));
    return { version: 1, entries: (parsed && parsed.entries) || {} };
  } catch { return { version: 1, entries: {} }; }
}

function writeIndex(zip, index) {
  if (Object.keys(index.entries).length) zip.file('graveyard.json', JSON.stringify(index));
  else zip.remove('graveyard.json');
}

/**
 * Put a deleted card back into the brain. It returns to `order` (so it renders
 * again) at its recorded position, and leaves the bin — a card must never be in
 * both, or the next restore would duplicate it.
 *
 * Its former parent may itself be gone; in that case the card is restored to
 * the canvas root rather than into a dangling container.
 */
export async function restoreFromGraveyard(buf, ids) {
  const zip = await JSZip.loadAsync(buf);
  const index = await readIndex(zip);
  const canvasFile = zip.file('canvas.json');
  if (!canvasFile) throw new Error('Not a .klypix canvas — missing canvas.json');
  const canvas = JSON.parse(await canvasFile.async('string'));
  canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
  canvas.positions = canvas.positions || {};
  const liveIds = new Set(canvas.order);

  const restored = [], skipped = [];
  for (const rawId of ids) {
    const id = String(rawId);
    const entry = index.entries[id];
    const file = zip.file(`graveyard/${shard(id)}/${id}.json`);
    if (!entry || !file) { skipped.push({ id, reason: 'not in the bin' }); continue; }
    if (liveIds.has(id)) { skipped.push({ id, reason: 'already in the brain' }); continue; }

    zip.file(`items/${shard(id)}/${id}.json`, await file.async('string'));
    const pos = entry.pos || { x: 0, y: 0 };
    // Re-parent only if the container still exists — a card must never point at
    // a container that was itself deleted, which would make it unreachable.
    const parentAlive = entry.parentId && liveIds.has(entry.parentId);
    canvas.positions[id] = {
      x: Number(pos.x) || 0, y: Number(pos.y) || 0,
      ...(pos.w != null ? { w: pos.w } : {}), ...(pos.h != null ? { h: pos.h } : {}),
      zIndex: canvas.order.length,
      parentId: parentAlive ? entry.parentId : null,
    };
    canvas.order.push(id);
    liveIds.add(id);
    zip.remove(`graveyard/${shard(id)}/${id}.json`);
    delete index.entries[id];
    restored.push({ id, reparented: Boolean(entry.parentId) && !parentAlive });
  }

  zip.file('canvas.json', JSON.stringify(canvas));
  writeIndex(zip, index);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await parseKlypix(buffer);          // never hand back an unreadable brain
  return { buffer, restored, skipped };
}

/**
 * Permanently remove entries from the bin. `olderThanDays` purges by age;
 * explicit `ids` purge regardless of age (the secret-was-pasted case).
 */
export async function purgeGraveyard(buf, { ids = null, olderThanDays = null, now = Date.now() } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const index = await readIndex(zip);
  const cutoff = olderThanDays != null ? now - olderThanDays * 24 * 60 * 60 * 1000 : null;

  const target = [];
  for (const [id, meta] of Object.entries(index.entries)) {
    if (ids) { if (ids.includes(id)) target.push(id); continue; }
    if (cutoff != null && Number(meta?.deletedAt || 0) < cutoff) target.push(id);
  }
  for (const id of target) {
    zip.remove(`graveyard/${shard(id)}/${id}.json`);
    delete index.entries[id];
  }
  writeIndex(zip, index);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await parseKlypix(buffer);
  return { buffer, purged: target };
}

/** Read a buried card's full text — so `list` can show more than a preview. */
export async function readGraveyardCard(buf, id) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file(`graveyard/${shard(String(id))}/${String(id)}.json`);
  if (!f) return null;
  try { return JSON.parse(await f.async('string')); } catch { return null; }
}

/** Convenience for CLI/desktop callers that work in files rather than buffers. */
export const readBrain = (p) => fs.readFileSync(p);
