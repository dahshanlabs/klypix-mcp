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
//
// PURGE LEAVES A RECEIPT (Stage 2). A purge used to drop the entry outright.
// On a brain that syncs, that read as "this copy never had the delete": the
// next merge with a copy still holding the bytes (the cloud, a git branch)
// carried them straight back into the bin. So a purge now keeps the entry as
// a content-free receipt — no preview, no position, an empty placeholder body,
// a random identity — and every copy that meets it drops the bytes. The same
// receipt the KLYPIX desktop has written since 1.3.171. Receipts are not
// deleted cards: `list` can hide them, and restore refuses them.
import fs from 'fs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  parseKlypix, shard, summarizeGraveyardCard, entryKind, receiptIdentity,
  contentFreeReceiptFor, PURGED_BODY, revivedIdFor, twinIdFor, sameMeaning, itemSignature,
} from './klypix-format.mjs';

// Moved to klypix-format.mjs; the 1.86 merge engine and the API-5 KLYPIX sync
// core import it from here, and a mixed install must still link.
export { summarizeGraveyardCard };

export const DEFAULT_RETENTION_DAYS = 30;

const KIND_NAME = { F: 'deleted', P: 'purged', R: 'restored' };

/**
 * Deleted cards, newest first. Every entry carries `kind`
 * ('deleted' | 'purged' | 'restored') and its identity `rid`.
 * `receipts: 'hide'` leaves out the content-free receipts (P and R): they are
 * not cards anyone can restore, only the record that keeps a delete honest.
 * The default stays 'include' because desktop 1.3.171 filters them itself.
 */
export async function listGraveyard(buf, { receipts = 'include' } = {}) {
  if (receipts !== 'include' && receipts !== 'hide') throw new TypeError(`listGraveyard: receipts must be 'include' or 'hide'`);
  const { struct, zip } = await parseKlypix(buf);
  const result = [];
  for (const entry of (struct.graveyard || [])) {
    const kind = entryKind(entry);
    if (receipts === 'hide' && kind !== 'F') continue;
    let body = null;
    try {
      const file = zip.file(`graveyard/${shard(entry.id)}/${entry.id}.json`);
      // Only an F entry without a stored rid needs its bytes for the identity.
      const needsBody = (kind === 'F' && !entry.rid) || !(entry.summary && typeof entry.summary === 'object');
      if (file && needsBody) body = await file.async('string');
    } catch { /* one damaged deleted item must not hide the rest of the bin */ }
    let summary = entry.summary && typeof entry.summary === 'object' ? entry.summary : null;
    if (!summary && body != null) {
      try { summary = summarizeGraveyardCard(JSON.parse(body)); } catch { /* shown without a preview */ }
    }
    const { id, ...meta } = entry;
    result.push({
      ...entry,
      kind: KIND_NAME[kind],
      rid: receiptIdentity(id, meta, body),
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

// How far a restore follows a chain of deleted cards before it gives up and
// lands at an id derived from the value itself (real chains are a few steps).
const LANDING_STEPS = 32;
const REVIVED_TAIL_RE = /(__r_[0-9a-f]{12})+$/;

/**
 * Put deleted cards back into the brain, each under the id its delete revives
 * to, and leave a restore receipt where it was.
 *
 * WHY A NEW ID (Stage 2). A restore used to bring the card back under its old
 * id and drop the entry. On a brain that syncs, the other copies still held the
 * delete for that id, so the next merge deleted the restored card again. Now
 * the old id stays deleted everywhere: the card lands under `revivedIdFor` —
 * the same id the merge uses when it rescues a deleted card, so two machines
 * restoring the same card land on one id — and the entry becomes a restore
 * receipt that says where the card went (`restoredAs`). The bytes leave the
 * bin, because they are live again. Older machines just see an ordinary add.
 *
 * The landing walk is the merge's own chain: a landing id that is itself
 * deleted follows that entry (a restore receipt to its `restoredAs`, a delete
 * to its own revival); a landing id already live with the same text means the
 * card is already back; one live with other text takes the card beside it as a
 * conflict twin. So a restore never lands on an id that has its own bin entry,
 * and never overwrites newer text.
 *
 * A parent that is live, or restored in the same call, keeps its child; a
 * parent that is gone sends the card to the canvas root rather than into a
 * dangling container. Receipts are refused, with the reason: a purge receipt
 * holds no card, and a restore receipt's card is already live.
 * @returns {Promise<{buffer:Buffer, restored:Array<{id:string, restoredAs:string, reparented:boolean, already?:boolean}>, skipped:Array<{id:string, reason:string}>}>}
 */
export async function restoreFromGraveyard(buf, ids, { now = Date.now() } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const index = await readIndex(zip);
  const canvasFile = zip.file('canvas.json');
  if (!canvasFile) throw new Error('Not a .klypix canvas — missing canvas.json');
  const canvas = JSON.parse(await canvasFile.async('string'));
  canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
  canvas.positions = canvas.positions || {};
  const liveIds = new Set(canvas.order);
  const itemAt = async (x) => {
    const f = zip.file(`items/${shard(x)}/${x}.json`);
    return f ? f.async('string') : null;
  };
  const binBody = async (x) => {
    const f = zip.file(`graveyard/${shard(x)}/${x}.json`);
    return f ? f.async('string') : null;
  };
  // Cards placed by this call, so a later card in the same call sees them live.
  const planned = new Map();          // landing id -> body
  const liveJson = async (x) => (planned.has(x) ? planned.get(x) : itemAt(x));

  const landingFor = async (id, entry, body) => {
    let as = revivedIdFor(id, entry, body);
    for (let step = 0; step < LANDING_STEPS; step++) {
      if (liveIds.has(as) || planned.has(as)) {
        if (sameMeaning(await liveJson(as), body)) return { as, already: true };
        as = twinIdFor(as, body);
        continue;
      }
      const next = index.entries[as];
      if (!next) return { as, already: false };
      as = entryKind(next) === 'R' ? String(next.restoredAs) : revivedIdFor(as, next, await binBody(as));
    }
    // A cycle, or a chain longer than any real history: an id derived from the
    // value itself, which every machine computes alike.
    const sig = createHash('sha256').update(`cycle\n${id}\n${itemSignature(body) ?? ''}`).digest('hex').slice(0, 12);
    return { as: `${String(id).replace(REVIVED_TAIL_RE, '')}__r_${sig}`, already: false };
  };

  const restored = [], skipped = [], landings = [];
  for (const rawId of ids) {
    const id = String(rawId);
    const entry = index.entries[id];
    const body = entry ? await binBody(id) : null;
    if (!entry || body == null) { skipped.push({ id, reason: 'not in the bin' }); continue; }
    const kind = entryKind(entry);
    if (kind === 'P') { skipped.push({ id, reason: 'deleted permanently' }); continue; }
    if (kind === 'R') { skipped.push({ id, reason: `already restored as ${entry.restoredAs}` }); continue; }
    if (liveIds.has(id)) { skipped.push({ id, reason: 'already in the brain' }); continue; }
    const { as, already } = await landingFor(id, entry, body);
    if (!already) planned.set(as, body);
    landings.push({ id, entry, body, as, already });
  }

  const landedAt = new Map(landings.map((l) => [l.id, l.as]));
  for (const { id, entry, body, as, already } of landings) {
    let reparented = false;
    if (!already) {
      zip.file(`items/${shard(as)}/${as}.json`, body);
      const pos = entry.pos || { x: 0, y: 0 };
      // A parent restored in this same call is found where it landed.
      const parent = entry.parentId
        ? (liveIds.has(entry.parentId) ? entry.parentId : (landedAt.get(entry.parentId) ?? null))
        : null;
      reparented = Boolean(entry.parentId) && !parent;
      canvas.positions[as] = {
        x: Number(pos.x) || 0, y: Number(pos.y) || 0,
        ...(pos.w != null ? { w: pos.w } : {}), ...(pos.h != null ? { h: pos.h } : {}),
        zIndex: canvas.order.length,
        parentId: parent,
      };
      canvas.order.push(as);
      liveIds.add(as);
    }
    index.entries[id] = contentFreeReceiptFor(id, { meta: entry, json: body }, { kind: 'restored', restoredAs: as, now });
    zip.file(`graveyard/${shard(id)}/${id}.json`, PURGED_BODY);
    restored.push({ id, restoredAs: as, reparented, ...(already ? { already: true } : {}) });
  }

  zip.file('canvas.json', JSON.stringify(canvas));
  writeIndex(zip, index);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await parseKlypix(buffer);          // never hand back an unreadable brain
  return { buffer, restored, skipped };
}

/**
 * Delete bin entries permanently. `olderThanDays` purges by age; explicit
 * `ids` purge regardless of age (the secret-was-pasted case).
 *
 * The card's bytes, preview, summary, position and area go; the entry stays as
 * a content-free purge receipt (see the header) so every other copy of this
 * brain drops the card too. Receipts are skipped: they hold nothing to purge,
 * and an age purge must not keep restamping them.
 */
export async function purgeGraveyard(buf, { ids = null, olderThanDays = null, now = Date.now() } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const index = await readIndex(zip);
  const cutoff = olderThanDays != null ? now - olderThanDays * 24 * 60 * 60 * 1000 : null;
  const wanted = ids ? new Set(ids.map(String)) : null;

  const target = [];
  for (const [id, meta] of Object.entries(index.entries)) {
    if (entryKind(meta) !== 'F') continue;
    if (wanted) { if (wanted.has(id)) target.push(id); continue; }
    if (cutoff != null && Number(meta?.deletedAt || 0) < cutoff) target.push(id);
  }
  if (!target.length) return { buffer: buf, purged: target };
  for (const id of target) {
    const file = zip.file(`graveyard/${shard(id)}/${id}.json`);
    const json = file ? await file.async('string') : null;
    index.entries[id] = contentFreeReceiptFor(id, { meta: index.entries[id], json }, { kind: 'purged', now });
    zip.file(`graveyard/${shard(id)}/${id}.json`, PURGED_BODY);
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
