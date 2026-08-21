#!/usr/bin/env node
// merge-brains — the pure, provable core of the desktop-app<->hooks brain
// concurrency fix. A 3-way UNION-by-stable-id reconcile of two .klypix brains
// that share a common ancestor, designed so that NO CARD CAN BE LOST.
//
// Why this exists: the desktop app used to SAVE the brain with a blind full-file
// overwrite, clobbering any card the Claude Code hooks captured after the app
// opened. This replaces overwrite with union: the app re-reads the disk copy
// INSIDE the capture lock and merges, so a hook capture written after open is
// always kept — even if the lock is missed (union is non-destructive).
//
// HARDENED against the adversarial design review (data-loss blockers):
//   • Deletes are honored ONLY via explicit tombstones (deletedIds) — a card
//     merely ABSENT from `ours` is NEVER inferred as a delete (that absence can
//     be a deferred/gated renderer apply, not a deletion). This is the fix for
//     the "false-delete clobber" + "delete-by-absence" blockers.
//   • assets/ entries are UNIONed by path (else theirs-only images ship blank).
//   • Content conflict (both edited the same card) keeps BOTH texts losslessly:
//     the human's stays live on the card, the agent's is preserved as a linked
//     twin card — never silently dropped.
//   • zKeys are de-collided (duplicate keys silently no-op in the app reducer).
//   • Post-merge SUPERSET VERIFICATION: the result is asserted to contain every
//     surviving id from both sides; the function throws rather than return a
//     buffer that lost a card.
//
// Pure + dependency-light: reads via the shared parseKlypix, so it stays correct
// as the format evolves. CANONICAL HOME: klypix-mcp/src (moved 2026-08-01 so the
// git merge driver is npm-distributable to ANY repo — supersedes the old
// "APP-maintained, edit in KLYPIX scripts/" note). The KLYPIX app bundles this
// file back via sync-bundled-mcp exactly like klypix-format.mjs, and its
// brainEngine/deploy paths keep loading it unchanged. Edit it HERE — the app
// copy is GENERATED. It flattens into ~/.claude/project-brain on install, where
// jszip + fractional-indexing already live.

import JSZip from 'jszip';
import { parseKlypix, shard } from './klypix-format.mjs';
import { summarizeGraveyardCard } from './brain-graveyard.mjs';
import { generateKeyBetween } from 'fractional-indexing';

const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };
const rand = () => Math.random().toString(36).slice(2, 10);
const ARCHIVE = /^archive$/i;

const DELETION_INITIATORS = new Set(['user', 'agent', 'system', 'peer', 'unknown']);
const DELETION_CONFIDENCE = new Set(['explicit', 'inferred', 'legacy']);
const boundedToken = (value, fallback, max = 64) => {
  const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return clean ? clean.slice(0, max) : fallback;
};

// Deletion receipts cross renderer, IPC, merge, git and cloud boundaries. Keep
// the persisted shape deliberately small and vocabulary-like: enough to answer
// "who/what removed this?", never an unbounded action payload or device secret.
function sanitizeDeletionReceipt(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const initiator = DELETION_INITIATORS.has(r.initiator) ? r.initiator : 'unknown';
  const confidence = DELETION_CONFIDENCE.has(r.confidence) ? r.confidence : 'inferred';
  const cause = boundedToken(r.cause, 'unclassified');
  const source = boundedToken(r.source, 'merge', 40);
  const triggerCause = r.triggerCause ? boundedToken(r.triggerCause, '', 64) : '';
  return {
    initiator,
    cause,
    source,
    confidence,
    ...(triggerCause ? { triggerCause } : {}),
  };
}

// ── Semantic item comparison (2026-08-01 field fix) ─────────────────────────
// A raw byte compare of item JSON was the change detector, on the assumption
// that "unchanged cards keep byte-identical JSON". That assumption DIED the
// day cards gained touch metadata: `updatedAt` is restamped whenever a card is
// written, so two sides holding the SAME card with the SAME text differ in
// bytes — and every first real sync spawned __agconf conflict twins for cards
// nobody edited (field-proven on the founder's pump-doctor brain: 5 twins,
// differing field list = ["updatedAt"] exactly).
//
// The fix is the same discipline the sync core and the brain diff already use:
// compare PARSED MEANING with volatile/derived fields stripped, key-sorted so
// two writers' key orders can't fake a difference. Byte-compare survives as the
// fallback for anything unparseable — a malformed item must never crash a merge.
//
// VOLATILE = written by the act of saving, not by a human/agent decision:
//   updatedAt — touch timestamp        zIndex — display order derived from zKey
//   editedAt  — the desktop app's authored-edit stamp (2026-08-22): advances on
//               content-level edits only, but an edit-then-undo cycle leaves the
//               content identical while the stamp differs — exactly the
//               same-meaning-different-bytes shape that spawned the updatedAt
//               twins above. A card whose only difference is WHEN it was last
//               edited has not diverged.
// Everything else (content, colors, geometry, evidence, author…) stays load-
// bearing: a real edit to any of them is still a real conflict.
const VOLATILE_ITEM_FIELDS = ['updatedAt', 'zIndex', 'editedAt'];

const sortedStable = (v) => JSON.stringify(v, (_k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]))
    : val);

function itemSignature(json) {
  if (json == null) return null;
  try {
    const obj = JSON.parse(json);
    for (const f of VOLATILE_ITEM_FIELDS) delete obj[f];
    return sortedStable(obj);
  } catch {
    return json;                      // unparseable → byte identity, as before
  }
}

/** True when two item JSON strings mean the same thing (volatile fields aside).
 *  EXPORTED as the single definition of "did this card actually change" — the
 *  git merge driver and the Brain Sync core both decide committed-absence
 *  tombstones with it, so all three transports agree on what an edit is. */
export const sameMeaning = (a, b) => {
  if (a === b) return true;           // fast path: byte-identical
  if (a == null || b == null) return false;
  return itemSignature(a) === itemSignature(b);
};

// Load one .klypix buffer into a flat, comparison-friendly shape. Item JSON is
// kept VERBATIM (the merge must write back exactly what a side held); whether
// two versions actually differ is decided by sameMeaning(), never by these
// bytes — see its note on volatile fields.
async function loadSide(buf) {
  if (!buf) return null;
  const { zip, canvas, manifest, struct } = await parseKlypix(buf);
  const order = Array.isArray(canvas.order) ? canvas.order : [];
  const positions = canvas.positions || {};
  const items = {};                 // id -> raw item JSON string (verbatim bytes)
  const idSet = new Set(order.length ? order : Object.keys(positions));
  for (const id of idSet) {
    const f = zip.file(`items/${shard(id)}/${id}.json`);
    items[id] = f ? await f.async('string') : null;
  }
  const assets = {};                // "assets/<id>" -> nodebuffer
  for (const p of Object.keys(zip.files)) {
    if (p.startsWith('assets/') && !zip.files[p].dir) assets[p] = await zip.file(p).async('nodebuffer');
  }
  const titleById = new Map(struct.cards.map(c => [c.id, c.title || '']));
  // Graveyard: deleted-but-recoverable cards. Carried verbatim so a merge never
  // empties another machine's bin, and so the bytes a tombstone removes from
  // `order` are preserved rather than destroyed.
  const graveyard = {};             // id -> { meta, json }
  for (const e of (struct.graveyard || [])) {
    const f = zip.file(`graveyard/${shard(e.id)}/${e.id}.json`);
    const { id, ...meta } = e;
    graveyard[e.id] = { meta, json: f ? await f.async('string') : null };
  }
  return {
    order, positions, items, assets, manifest, graveyard,
    connections: Array.isArray(canvas.connections) ? canvas.connections : [],
    lines: Array.isArray(canvas.lines) ? canvas.lines : [],
    strokes: Array.isArray(canvas.strokes) ? canvas.strokes : [],
    settings: canvas.settings || {},
    nextGroupNumber: Number(canvas.nextGroupNumber) || 1,   // top-level key, NOT settings
    view: canvas.view || null,
    titleById,
    ids: idSet,
  };
}

const samePos = (a, b) => !!a && !!b &&
  a.x === b.x && a.y === b.y && (a.w ?? null) === (b.w ?? null) && (a.h ?? null) === (b.h ?? null);
const sameParent = (a, b) => (a?.parentId ?? null) === (b?.parentId ?? null);

/**
 * mergeBrains — 3-way union of two brains sharing ancestor `base`.
 * @param {{base?:Buffer|null, ours:Buffer, theirs:Buffer, deletedIds?:string[], deletedMeta?:Record<string,object>}} args
 *   base      = on-disk struct snapshotted when the app opened (null → pure union).
 *   ours      = the app's in-memory brain (what the human is saving).
 *   theirs    = the current on-disk brain, re-read INSIDE the lock (has hook captures).
 *   deletedIds= explicit tombstones. ONLY these can drop a live card.
 *   deletedMeta= bounded per-id audit receipts (initiator/cause/source/confidence).
 * @returns {Promise<{buffer:Buffer, delta:{added:string[],updated:string[],archived:string[],removed:string[]}, conflicts:object[], stats:object}>}
 */
export async function mergeBrains({ base = null, ours, theirs, deletedIds = [], deletedMeta = {} }) {
  if (!ours || !theirs) throw new Error('mergeBrains needs both ours and theirs buffers');
  const B = await loadSide(base);
  const O = await loadSide(ours);
  const T = await loadSide(theirs);
  const del = new Set(deletedIds);

  const baseItem = (id) => (B && B.items[id]) || null;
  const basePos = (id) => (B && B.positions[id]) || null;
  const parentTitle = (side, pos) => {
    const pid = pos?.parentId; if (!pid) return '';
    return String(side.titleById.get(pid) || '');
  };

  const allIds = new Set([...O.ids, ...T.ids]);
  const merged = new Map();          // id -> { json, pos }
  const extras = [];                 // conflict-twin cards to append
  const conflicts = [];
  const delta = { added: [], updated: [], archived: [], removed: [] };

  // ── Graveyard (2026-08-07) ───────────────────────────────────────────────
  // An honored tombstone still REMOVES the card from the brain — `order`,
  // `positions` and `struct.cards` are unchanged, so every read surface, the
  // renderer and the no-loss invariant keep their exact current semantics. What
  // changes is that the BYTES are moved to `graveyard/` instead of destroyed,
  // making the delete recoverable. Deliberately NOT the Archive container:
  // archived cards are only re-parented, so they still sit in `order` and still
  // render — a deleted card put there would visibly reappear in place.
  const graveyard = {};
  for (const src of [T, O]) if (src?.graveyard) for (const [gid, g] of Object.entries(src.graveyard)) {
    // Union, never prune: one machine emptying its bin must not empty another's.
    if (!graveyard[gid] || Number(g.meta?.deletedAt || 0) > Number(graveyard[gid].meta?.deletedAt || 0)) graveyard[gid] = g;
  }
  const buryCard = (id) => {
    if (graveyard[id]) return;                       // already buried — keep the original stamp
    const json = O.items[id] ?? T.items[id] ?? null;
    if (json == null) return;                        // nothing to preserve
    const pos = O.positions[id] || T.positions[id] || null;
    let summary = null;
    try { summary = summarizeGraveyardCard(JSON.parse(json)); } catch { /* damaged item remains restorable */ }
    const preview = summary?.preview || '';
    const deletion = sanitizeDeletionReceipt(deletedMeta?.[id]);
    graveyard[id] = {
      meta: {
        deletedAt: Date.now(),       // `now` below is declared later in this scope
        // Flat field retained for older readers; `deletion` is authoritative.
        deletedBy: deletion.initiator,
        deletion,
        area: (O.titleById.get(pos?.parentId) || T.titleById.get(pos?.parentId) || null),
        parentId: pos?.parentId ?? null,
        pos: pos ? { x: pos.x, y: pos.y, w: pos.w ?? null, h: pos.h ?? null } : null,
        preview,
        ...(summary ? { summary } : {}),
      },
      json,
    };
  };

  for (const id of allIds) {
    const inO = O.items[id] != null, inT = T.items[id] != null;
    const inB = baseItem(id) != null;

    // ── Explicit human delete (tombstone) — the ONLY path that drops a card ──
    if (del.has(id)) {
      // A save restamps volatile metadata (updatedAt/zIndex), and JSON writers
      // may reorder keys. Those byte differences are not edits. Tombstone
      // handling must use the SAME semantic comparator as the content branch
      // below or a delete-vs-untouched card becomes a bogus conflict twin.
      const theirsChanged = inT && inB && !sameMeaning(T.items[id], baseItem(id));
      if (inT && theirsChanged) {
        // delete-vs-edit: the human deleted it but a hook edited it after open →
        // KEEP theirs (never lose the hook's new info); record the conflict.
        conflicts.push({ id, kind: 'delete-vs-edit', kept: 'theirs' });
        // fall through to keep from theirs below
      } else {
        buryCard(id);                // keep the bytes; the card still leaves the brain
        delta.removed.push(id);
        continue;                    // honored delete
      }
    }
    // ── The bin is a DURABLE tombstone (2026-08-07) ────────────────────────
    // Before it existed, `deletedIds` was a per-call argument that was consumed
    // and thrown away, so a delete could not cross machines: sync with a peer
    // who still had the card and it came straight back, because "absent from
    // ours" alone is deliberately never a delete. A graveyard entry is not mere
    // absence — it is a recorded human deletion — so it is honored here.
    //
    // The delete-vs-edit rule is unchanged and still wins: if the other side
    // EDITED the card after our deletion, their information is newer than our
    // intent, so the card comes back live and leaves the bin. Without a base we
    // cannot prove an edit, so the deletion stands (conservative: a resurrected
    // card is visible and re-deletable; a lost one is not).
    if (graveyard[id] && !inO) {
      const theirsChangedSinceBase = inT && inB && !sameMeaning(T.items[id], baseItem(id));
      if (inT && theirsChangedSinceBase) {
        conflicts.push({ id, kind: 'delete-vs-edit', kept: 'theirs' });
        delete graveyard[id];        // resurrected — never in the brain AND the bin
      } else {
        delta.removed.push(id);      // the deletion propagates
        continue;
      }
    }
    // Live on our side ⇒ not deleted. Covers a restore and a re-add.
    if (graveyard[id] && inO) delete graveyard[id];

    if (!inO && !inT) continue;

    // ── Choose CONTENT ──────────────────────────────────────────────────────
    let json, side;
    if (inO && inT) {
      // Change + divergence are judged by MEANING, not bytes (see sameMeaning):
      // a restamped `updatedAt` is not an edit, and two copies of one card that
      // differ only in volatile fields are not in conflict.
      const oChg = !inB || !sameMeaning(O.items[id], baseItem(id));
      const tChg = !inB || !sameMeaning(T.items[id], baseItem(id));
      const diverged = !sameMeaning(O.items[id], T.items[id]);
      if (inB && oChg && tChg && diverged) {
        // GENUINE content conflict: a card that EXISTED at open, edited differently
        // on both sides → human stays live, agent version preserved as a twin.
        json = O.items[id]; side = 'ours';
        const twinId = `${id}__agconf_${rand()}`;
        extras.push({ id: twinId, json: T.items[id], srcPos: T.positions[id] || O.positions[id], of: id });
        conflicts.push({ id, kind: 'content', keptLive: 'ours', twin: twinId });
      } else if (tChg && !oChg) { json = T.items[id]; side = 'theirs'; delta.updated.push(id); }
      else if (!inB && diverged) {
        if (!B) {
          // With NO baseline we cannot prove which meaning is newer or whether
          // the two copies descended from one another. Choosing either side is
          // silent loss on first Brain Sync / an empty-ancestor git merge.
          // Keep ours live and materialize theirs as a twin, exactly like a
          // normal two-sided edit: convergence is not enough if one meaning dies.
          json = O.items[id]; side = 'ours';
          const twinId = `${id}__agconf_${rand()}`;
          extras.push({ id: twinId, json: T.items[id], srcPos: T.positions[id] || O.positions[id], of: id });
          conflicts.push({ id, kind: 'content-no-base', keptLive: 'ours', twin: twinId });
        } else {
          // The base EXISTS but this id is new since it: the same new agent card
          // can be present on both sides after live-apply and re-serialized with
          // slightly different bytes. It is one card, not a conflict — keep the
          // disk/agent bytes and never create the historical duplicate twin.
          json = T.items[id]; side = 'theirs';
        }
      }
      else { json = O.items[id]; side = 'ours'; }
    } else if (inT) {
      json = T.items[id]; side = 'theirs';
      if (!inB) delta.added.push(id);            // agent added since open — the anti-clobber core
    } else {
      json = O.items[id]; side = 'ours';
    }

    // ── Choose POSITION + parent (human spatial intent wins; hook archive
    //    applies only if the human didn't move/re-parent the card) ───────────
    const oP = O.positions[id], tP = T.positions[id], bP = basePos(id);
    const oMoved = oP && (!bP || !samePos(oP, bP));
    const finalXY = oMoved ? oP : (tP || oP);

    let parentId;
    const oParentChg = oP && (!bP || !sameParent(oP, bP));
    const tParentChg = tP && (!bP || !sameParent(tP, bP));
    if (oParentChg) parentId = oP.parentId ?? null;
    else if (tParentChg) parentId = tP.parentId ?? null;
    else parentId = (finalXY?.parentId ?? oP?.parentId ?? tP?.parentId ?? null);

    const pos = { ...(finalXY || oP || tP || {}), parentId };
    // Detect a hook archive-move for the delta receipt.
    if (side === 'theirs' && tParentChg && ARCHIVE.test(parentTitle(T, tP))) delta.archived.push(id);

    merged.set(id, { json, pos });
  }

  // ── Conflict twins: place beside their source card, own valid zKey ─────────
  for (const ex of extras) {
    const src = ex.srcPos || {};
    merged.set(ex.id, { json: ex.json, pos: { x: (src.x || 0) + 24, y: (src.y || 0) + 24, w: src.w, h: src.h, parentId: src.parentId ?? null } });
  }

  // ── Order + zKey heal (de-collide: duplicate zKeys silently no-op in-app) ──
  const order = [];
  const seen = new Set();
  for (const id of [...T.order, ...O.order, ...extras.map(e => e.id)]) {
    if (merged.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  }
  // Any merged id not in either order[] (defensive) — append.
  for (const id of merged.keys()) if (!seen.has(id)) { seen.add(id); order.push(id); }

  const usedZ = new Set();
  let lastZ = null;
  for (const id of order) {
    const rec = merged.get(id);
    let z = rec.pos.zKey;
    if (!z || !isValidZKey(z) || usedZ.has(z)) z = generateKeyBetween(lastZ, null);
    usedZ.add(z); lastZ = z;
    rec.pos = { ...rec.pos, zKey: z, zIndex: order.indexOf(id) };
  }

  // ── Union connections / lines / strokes by id; drop dangling connections ──
  const byId = (arr) => { const m = new Map(); for (const x of arr) if (x && x.id) m.set(x.id, x); return m; };
  const connMap = new Map([...byId(T.connections), ...byId(O.connections)]);
  const liveIds = new Set(order);
  // Collapse EXACT duplicate edges (same endpoints + relationship + label,
  // different ids). Connection deletes have no tombstone, so an arrange/de-dup
  // that dropped a redundant edge in-app used to see it resurrected from disk
  // by this union — as a byte-identical twin arrow. Never meaningful to keep.
  const seenEdge = new Set();
  const connections = [...connMap.values()].filter(c => {
    if (!(liveIds.has(c.fromId) && liveIds.has(c.toId))) return false;
    const k = `${c.fromId}|${c.toId}|${c.relationship || ''}|${c.label || ''}`;
    if (seenEdge.has(k)) return false;
    seenEdge.add(k);
    return true;
  });
  const lines = [...new Map([...byId(T.lines), ...byId(O.lines)]).values()];
  const strokes = [...new Map([...byId(T.strokes), ...byId(O.strokes)]).values()];

  // ── Union assets by path (theirs preferred, then ours, then base) ─────────
  const assets = {};
  for (const src of [B, O, T]) if (src) for (const [p, bytes] of Object.entries(src.assets)) assets[p] = bytes;

  // ── Build merged zip ──────────────────────────────────────────────────────
  const zip = new JSZip();
  const now = Date.now();
  for (const id of order) zip.file(`items/${shard(id)}/${id}.json`, merged.get(id).json);
  for (const [p, bytes] of Object.entries(assets)) zip.file(p, bytes);

  // Graveyard: card bytes under graveyard/, metadata in one index. Written only
  // when non-empty so a brain that has never had a delete keeps a byte-identical
  // shape. Nothing here is reachable from `order`, so nothing here can render,
  // be searched, be embedded, or be counted.
  const graveyardEntries = {};
  for (const [gid, g] of Object.entries(graveyard)) {
    if (g?.json == null) continue;
    zip.file(`graveyard/${shard(gid)}/${gid}.json`, g.json);
    graveyardEntries[gid] = g.meta || {};
  }
  if (Object.keys(graveyardEntries).length) {
    zip.file('graveyard.json', JSON.stringify({ version: 1, entries: graveyardEntries }));
  }

  const positions = {};
  for (const id of order) positions[id] = merged.get(id).pos;

  // Per-field manifest UNION, theirs-precedence: theirs still wins every field
  // it carries (the original semantics — disk/hook-side stamps survive an app
  // save), but a field only OURS has is no longer dropped. Concretely: the
  // cloud-link stamp (manifest.cloud) added on the local side must survive a
  // merge against an older cloud copy that predates the link.
  const manifest = { format: 'klypix', version: 4, ...(O.manifest || {}), ...(T.manifest || {}) };
  manifest.updatedAt = new Date(now).toISOString();
  manifest.stats = { ...(manifest.stats || {}), itemCount: order.length, assetCount: Object.keys(assets).length };
  zip.file('manifest.json', JSON.stringify(manifest));

  const canvasJson = {
    version: 4,
    view: O.view || T.view || { panX: 0, panY: 0, zoom: 0.7 },   // human's viewport
    order, connections, lines, strokes,
    nextGroupNumber: Math.max(1, ...[O, T].map(s => Number(s.nextGroupNumber) || 1)),
    positions,
    settings: { ...(T.settings || {}), ...(O.settings || {}) },
  };
  zip.file('canvas.json', JSON.stringify(canvasJson));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // ── SUPERSET VERIFICATION — prove no card was lost ─────────────────────────
  // Every id that survived on either side (minus honored deletes) MUST be in the
  // result; every asset path from either side MUST be present. Throw otherwise.
  const survivors = new Set();
  for (const id of O.ids) if (!delta.removed.includes(id)) survivors.add(id);
  for (const id of T.ids) if (!delta.removed.includes(id)) survivors.add(id);
  const resultIds = new Set(order);
  const missing = [...survivors].filter(id => !resultIds.has(id));
  if (missing.length) throw new Error(`mergeBrains INVARIANT VIOLATED — dropped ${missing.length} card(s): ${missing.slice(0, 5).join(', ')}`);
  const wantAssets = new Set([...Object.keys(O.assets), ...Object.keys(T.assets)]);
  const missingAssets = [...wantAssets].filter(p => !(p in assets));
  if (missingAssets.length) throw new Error(`mergeBrains INVARIANT VIOLATED — dropped ${missingAssets.length} asset(s): ${missingAssets.slice(0, 3).join(', ')}`);
  // Re-parse to guarantee the buffer round-trips (never ship an unreadable brain).
  await parseKlypix(buffer);

  const stats = {
    ours: O.ids.size, theirs: T.ids.size, base: B ? B.ids.size : 0,
    merged: order.length, conflicts: conflicts.length,
    added: delta.added.length, updated: delta.updated.length,
    archived: delta.archived.length, removed: delta.removed.length,
    assets: Object.keys(assets).length,
  };
  return { buffer, delta, conflicts, stats };
}

/**
 * Human deletions inferred SAFELY for the merge-on-SAVE path: ids present in the
 * open-snapshot BASE but absent from OURS (the full current app state at save).
 * Sound precisely because base is FROZEN at open — a card the agent added after
 * open is never in base, so this returns ONLY cards the human actually removed,
 * and can never mistake an un-applied agent card for a deletion. Feed the result
 * to mergeBrains({...deletedIds}). NOTE: a card the human deletes that the AGENT
 * added mid-session isn't in base → not returned here (it re-unions until the
 * next reopen folds it into base); persisting that stricter case needs explicit
 * renderer tombstones, a later increment. NEVER use this for the live watcher,
 * where absence≠delete.
 */
export async function deletedByAbsence(baseBuf, oursBuf) {
  if (!baseBuf || !oursBuf) return [];
  const [b, o] = await Promise.all([parseKlypix(baseBuf), parseKlypix(oursBuf)]);
  const oIds = new Set(o.struct.cards.map((c) => c.id));
  return b.struct.cards.map((c) => c.id).filter((id) => !oIds.has(id));
}

/**
 * Delta for the LIVE agent→human watcher: the cards ADDED to `newBuf` since the
 * frozen open-snapshot `baseBuf`, with each added card's raw item JSON + position
 * so the renderer can build it with its normal v4 deserializer. Added-only by
 * design — a new id can never clobber a human's in-progress edit, and the renderer
 * applies it idempotently, so re-sending the full accumulated added-set every time
 * lets a briefly-gated tab catch up without any ack/queue. (Updates/removes
 * reconcile on the next save/reopen — safe, since the merge never loses.)
 */
export async function brainDelta(baseBuf, newBuf) {
  const empty = { added: [], updated: [], removed: [], items: {}, positions: {}, connections: [], manifest: null };
  if (!baseBuf || !newBuf) return empty;
  const [b, n] = await Promise.all([parseKlypix(baseBuf), parseKlypix(newBuf)]);
  const baseIds = new Set(b.struct.cards.map((c) => c.id));
  const newIds = new Set(n.struct.cards.map((c) => c.id));
  const bPos = (b.canvas && b.canvas.positions) || {};
  const nPos = (n.canvas && n.canvas.positions) || {};
  const posKey = (p) => (p ? JSON.stringify([p.x, p.y, p.w, p.h, p.parentId ?? null]) : '');   // ignore zKey/zIndex noise
  const raw = async (zip, id) => { const f = zip.file(`items/${shard(id)}/${id}.json`); return f ? f.async('string') : null; };

  const added = [...newIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !newIds.has(id));
  const updated = [];
  for (const id of newIds) {
    if (!baseIds.has(id)) continue;
    const [bStr, nStr] = await Promise.all([raw(b.zip, id), raw(n.zip, id)]);
    if (bStr !== nStr || posKey(bPos[id]) !== posKey(nPos[id])) updated.push(id);
  }

  const items = {}, positions = {};
  for (const id of [...added, ...updated]) {
    const s = await raw(n.zip, id);
    if (s) items[id] = s;
    if (nPos[id]) positions[id] = nPos[id];
  }
  const baseConn = new Set((b.canvas && b.canvas.connections || []).map((c) => c.id));
  const connections = (n.canvas && n.canvas.connections || []).filter((c) => c && c.id && !baseConn.has(c.id));
  return { added, updated, removed, items, positions, connections, manifest: n.manifest || null };
}

export default mergeBrains;
