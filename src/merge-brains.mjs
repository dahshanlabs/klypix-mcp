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
//
// STAGE 2 (klypix-mcp 1.87) — rules that hold for EVERY caller, options or not:
//   • Conflict twins get DETERMINISTIC ids (twinIdFor: the conflicted card's id
//     plus a hash of the value being preserved). A random id meant the same
//     conflict merged twice — by the git driver and by Brain Sync, or on two
//     machines — left two twins of one value that never folded. Now a value
//     that already has a twin is never twinned again, and two transports that
//     resolve the same conflict land on the same card.
//   • Every bin entry the engine mints carries its identity (`rid`, see
//     receiptIdentity in klypix-format.mjs) — a name for the deletion that two
//     machines derive without talking, and that never orders anything.
// Everything else about a call WITHOUT options is 1.86.3's union, verbatim:
// the desktop app's merge-on-save sends renderer bytes that carry no bin, so
// any rule that read a missing bin as meaningful would delete the human's
// cards. Callers that DO carry a whole file (Brain Sync, the git driver) opt
// into the receipt-aware rules through `options` (normalizeMergeOptions).
//
// OPTION MODES (binMerge 'receipts' | '3way') — the bin is part of the merge:
//   • Fates first. Every id gets one fate — alive, tombstoned, killed by a bin
//     entry, or buried — BEFORE any value moves, so a value is never routed
//     onto a card the same merge is deleting (mergeOptionMode, pass A).
//   • One entry per card, chosen by the total order in pickBinEntry (P > R > F,
//     then content). Taking the base's entry too means "no receipt, no purge":
//     a bin a side merely lacks (a checkout, an old CLI purge) comes back.
//   • A live copy that meets a kill entry is classified, never just deleted:
//     a purge drops it (P-a); a restore sends it to where the card went; a
//     stale copy of exactly the deleted bytes drops; anything else is news the
//     deleter never saw and comes back under revivedIdFor — a NEW id, so no
//     receipt is contradicted and an older machine sees an ordinary add.
//   • A moved value never overwrites a live card: it matches one, or becomes
//     its deterministic twin.
//   • The merge proves itself: every removal of a live card leaves an entry
//     (E-12) and every moved value is live or its bytes are in the bin (E-13).

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  parseKlypix, shard, sameMeaning, itemSignature, twinIdFor, binEntryFor,
  entryKind, receiptIdentity, revivedIdFor, pickBinEntry,
} from './klypix-format.mjs';
import { generateKeyBetween } from 'fractional-indexing';

const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };
const ARCHIVE = /^archive$/i;

// The identity helpers live in klypix-format.mjs (one definition for every
// engine file and the KLYPIX core). Re-exported here because callers written
// against 1.86 — the git driver, the API-5 KLYPIX sync core — import them from
// this module, and the KLYPIX core reads the whole engine off this namespace.
export {
  sameMeaning, itemSignature, VOLATILE_ITEM_FIELDS, twinIdFor, revivedIdFor, receiptIdentity, entryKind,
  isContentFreeReceipt, pickBinEntry, PURGED_BODY, binEntryFor, contentFreeReceiptFor, fullEntryRid,
} from './klypix-format.mjs';
export { purgeGraveyard, restoreFromGraveyard, listGraveyard } from './brain-graveyard.mjs';

// ── Options (Stage 2) ────────────────────────────────────────────────────────
// A call with no options is the union merge above (app save, and every 1.86
// caller). `binMerge: 'receipts' | '3way'` ("option modes") switch to the
// receipt-aware bin merge; the other keys only mean anything in an option mode.
//
// Validation is strict on purpose. A misspelt key, or a half-configured
// object, would otherwise silently run union — and union reads a stale copy of
// a deleted card as live. So unknown keys, unknown values, and any non-default
// key combined with union all throw instead.
const OPTION_VALUES = Object.freeze({
  binMerge: Object.freeze(['union', 'receipts', '3way']),
  theirsTrust: Object.freeze(['descendant', 'unverified']),
  newOnBothSides: Object.freeze(['theirs', 'twin']),
  manifestMerge: Object.freeze(['theirs', '3way', 'ours']),
  adoptResolvedConflicts: Object.freeze([false, true]),
});
const OPTION_DEFAULTS = Object.freeze({
  binMerge: 'union', theirsTrust: 'descendant', newOnBothSides: 'theirs', manifestMerge: 'theirs', adoptResolvedConflicts: false,
});

/** What this engine can do — callers feature-check this rather than a version
 *  string, because installs mix file generations (a 1.87 driver beside a 1.86
 *  engine, a desktop bundle beside a dev-owned ~/.claude). Absent ⇒ ≤ 1.86.
 *  A flag turns true only when the thing it names runs: `revivedIds` also
 *  covers restoreFromGraveyard landing under a revived id, which is not built
 *  yet, so it stays false even though the merge already rescues edits that way. */
export const MERGE_ENGINE_FEATURES = Object.freeze({
  api: 2,                            // absent ⇒ 1. Bump only when an option's meaning changes.
  deterministicTwins: true,          // E-1, every caller
  receiptIds: true,                  // E-2, every caller
  purgeReceipts: true,               // purgeGraveyard leaves a content-free receipt
  revivedIds: false,                 // restores and rescued edits land under revivedIdFor
  restoreAsMerge: false,             // history restore as a merge
  arrangeReceipts: false,            // arrangeBrain buries what it collapses
  revivalMap: false,                 // brainDelta/revivalMap for the live watcher
  options: OPTION_VALUES,
});

/**
 * Validate a caller's options and fill the defaults. Exported so callers can
 * pin their frozen option objects in a test: a renamed key then fails a test
 * instead of silently running union.
 * @returns {{binMerge:string, theirsTrust:string, newOnBothSides:string, manifestMerge:string, adoptResolvedConflicts:boolean}}
 */
export function normalizeMergeOptions(options) {
  const o = options == null ? {} : options;
  if (typeof o !== 'object' || Array.isArray(o)) throw new TypeError('mergeBrains: options must be an object');
  for (const k of Object.keys(o)) {
    if (!Object.prototype.hasOwnProperty.call(OPTION_VALUES, k)) throw new TypeError(`mergeBrains: unknown option '${k}'`);
  }
  const opt = { ...OPTION_DEFAULTS };
  for (const k of Object.keys(o)) if (o[k] !== undefined) opt[k] = o[k];
  for (const [k, v] of Object.entries(opt)) {
    if (!OPTION_VALUES[k].includes(v)) throw new TypeError(`mergeBrains: options.${k} must be one of ${JSON.stringify(OPTION_VALUES[k])}`);
  }
  if (opt.binMerge === 'union') {
    const stray = Object.keys(OPTION_DEFAULTS).filter(k => k !== 'binMerge' && opt[k] !== OPTION_DEFAULTS[k]);
    if (stray.length) throw new TypeError(`mergeBrains: options ${stray.join(', ')} need binMerge 'receipts' or '3way'`);
  }
  if (opt.theirsTrust === 'unverified' && opt.binMerge !== 'receipts') {
    throw new TypeError("mergeBrains: theirsTrust 'unverified' needs binMerge 'receipts'");
  }
  return opt;
}

// Immediate parent of a twin id — greedy, so `k__agconf_a__agconf_b` indexes
// under `k__agconf_a` (a twin of a twin is that twin's, not the root's).
const TWIN_PARENT_RE = /^(.*)__agconf_[a-z0-9]+$/i;
// Deterministic slots tried before the (never-lose) random fallback.
const TWIN_SLOTS = 16;
// A value moved by an option-mode merge follows a chain of deleted cards at most
// this far before it lands (real chains are a few steps; the rest is a cycle).
const ROUTE_STEPS = 32;
const REVIVED_TAIL_RE = /(__r_[0-9a-f]{12})+$/;
const stripRevived = (id) => String(id).replace(REVIVED_TAIL_RE, '');
const sha12 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

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
// The comparator itself — sameMeaning, itemSignature and the VOLATILE field
// list (updatedAt, zIndex, editedAt) — lives in klypix-format.mjs since 1.87,
// so the bin identity (receiptIdentity) and twin ids hash exactly the meaning
// this merge compares.

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
const parentTitle = (side, pos) => {
  const pid = pos?.parentId; if (!pid) return '';
  return String(side.titleById.get(pid) || '');
};

// POSITION + parent for a card both sides may have moved (descendant trust):
// human spatial intent wins; a hook's move or archive applies only if ours did
// not move or re-parent the card.
function descendantPosition(O, T, B, id) {
  const oP = O.positions[id], tP = T.positions[id], bP = (B && B.positions[id]) || null;
  const oMoved = oP && (!bP || !samePos(oP, bP));
  const finalXY = oMoved ? oP : (tP || oP);

  let parentId;
  const oParentChg = oP && (!bP || !sameParent(oP, bP));
  const tParentChg = tP && (!bP || !sameParent(tP, bP));
  if (oParentChg) parentId = oP.parentId ?? null;
  else if (tParentChg) parentId = tP.parentId ?? null;
  else parentId = (finalXY?.parentId ?? oP?.parentId ?? tP?.parentId ?? null);

  return { pos: { ...(finalXY || oP || tP || {}), parentId }, tP, tParentChg };
}

// ── E-1: deterministic twin slots ─────────────────────────────────────────────
// A value to preserve as a twin of card k goes, in order:
//   1. nowhere new, if a live twin of k already means the same (old random
//      twins included) — the conflict was resolved before, maybe elsewhere;
//   2. into slot n = twinIdFor(k, v, n), the first slot that is
//      free        → mint it;
//      alive       → it was minted from v; if it now says something else a
//                    person edited it, and v is already represented;
//      dying       → a person is deleting that twin in THIS merge — the value
//                    still needs a live home, so try the next slot;
//      dead (bin)  → next slot (never overwrite or resurrect a buried card) —
//                    except that an option mode may call the value resolved
//                    (`suppressDeleted`: a person deleted that very twin since
//                    the base, so re-merging the old conflict must not bring
//                    it back);
//   3. a random id after TWIN_SLOTS slots — never lose a value.
// One index per merge (immediate parent → twin ids), so this stays linear on a
// brain with thousands of simultaneous conflicts. `liveValues(x)` and
// `slotState(x)` describe the merge's own cards; twins minted here are tracked
// by the placer itself.
function makeTwinPlacer({ seedIds, liveValues, slotState, suppressDeleted = null }) {
  const index = new Map();
  const extras = [];                 // twins minted by this merge, in mint order
  const extraById = new Map();
  const indexTwin = (id) => {
    const m = TWIN_PARENT_RE.exec(id);
    if (!m) return;
    if (!index.has(m[1])) index.set(m[1], new Set());
    index.get(m[1]).add(id);
  };
  for (const id of seedIds) indexTwin(id);
  const valuesOf = (x) => (extraById.has(x) ? [extraById.get(x).json] : liveValues(x));
  const stateOf = (x) => (extraById.has(x) ? 'alive' : slotState(x));
  const holds = (x, v) => valuesOf(x).some((val) => sameMeaning(val, v));
  const mint = (x, k, v, srcPos) => {
    const ex = { id: x, json: v, srcPos, of: k };
    extras.push(ex); extraById.set(x, ex); indexTwin(x);
    return { twin: x };
  };
  const place = (k, v, srcPos) => {
    for (const x of (index.get(k) || [])) if (holds(x, v)) return { twin: x, existing: true };
    for (let n = 0; n < TWIN_SLOTS; n++) {
      const x = twinIdFor(k, v, n);
      const state = stateOf(x);
      if (state === 'alive') return { twin: x, existing: true, ...(holds(x, v) ? {} : { edited: true }) };
      if (state === 'free') return mint(x, k, v, srcPos);
      if (state === 'dead' && suppressDeleted && suppressDeleted(x, v)) return { twin: x, suppressed: 'deleted-twin' };
    }
    let x;
    do x = `${k}__agconf_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`; while (stateOf(x) !== 'free');
    return mint(x, k, v, srcPos);
  };
  return { place, extras, holds, twinsOf: (k) => [...(index.get(k) || [])] };
}

/**
 * mergeBrains — 3-way merge of two brains sharing ancestor `base`.
 * @param {{base?:Buffer|null, ours:Buffer, theirs:Buffer, deletedIds?:string[], deletedMeta?:Record<string,object>, options?:object}} args
 *   base      = on-disk struct snapshotted when the app opened (null → pure union).
 *   ours      = the app's in-memory brain (what the human is saving).
 *   theirs    = the current on-disk brain, re-read INSIDE the lock (has hook captures).
 *   deletedIds= explicit tombstones. The union merge drops a live card ONLY for these.
 *   deletedMeta= bounded per-id audit receipts (initiator/cause/source/confidence).
 *   options   = see normalizeMergeOptions; omitted ⇒ the union merge.
 * @returns {Promise<{buffer:Buffer, delta:{added:string[],updated:string[],archived:string[],removed:string[],revived:object[]}, conflicts:object[], stats:object}>}
 */
export async function mergeBrains({ base = null, ours, theirs, deletedIds = [], deletedMeta = {}, options = {} }) {
  const opt = normalizeMergeOptions(options);
  if (!ours || !theirs) throw new Error('mergeBrains needs both ours and theirs buffers');
  const B = await loadSide(base);
  const O = await loadSide(ours);
  const T = await loadSide(theirs);
  const del = new Set(deletedIds);
  const run = opt.binMerge === 'union'
    ? mergeUnion(B, O, T, del, deletedMeta)
    : mergeOptionMode(B, O, T, del, deletedMeta, opt);
  return finishMerge(B, O, T, opt, run);
}

// ── Union mode (no options: app save, every 1.86 caller) ──────────────────────
// 1.86.3's loop verbatim; the only differences are E-1 (twins placed after the
// loop, by deterministic slot) and E-2 (buried cards carry their identity).
function mergeUnion(B, O, T, del, deletedMeta) {
  const baseItem = (id) => (B && B.items[id]) || null;
  const allIds = new Set([...O.ids, ...T.ids]);
  const merged = new Map();          // id -> { json, pos }
  const conflicts = [];
  // `revived` stays empty in the union merge; option modes fill it.
  const delta = { added: [], updated: [], archived: [], removed: [], revived: [] };
  // Twins are decided AFTER the loop (E-1): whether a slot is free, taken by a
  // live twin, or held by a card this same merge deletes is only known once
  // every id's fate is. Each request keeps its conflict record in place so the
  // conflicts list reads in the same order as it always has.
  const twinRequests = [];           // { k, v, srcPos, record }

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
    // E-2: minted through binEntryFor, so the entry carries its identity (rid).
    graveyard[id] = binEntryFor({
      id, json, pos,
      area: (O.titleById.get(pos?.parentId) || T.titleById.get(pos?.parentId) || null),
      receipt: deletedMeta?.[id],
    });
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
        const record = { id, kind: 'content', keptLive: 'ours', twin: null };
        conflicts.push(record);
        twinRequests.push({ k: id, v: T.items[id], srcPos: T.positions[id] || O.positions[id], record });
      } else if (tChg && !oChg) { json = T.items[id]; side = 'theirs'; delta.updated.push(id); }
      else if (!inB && diverged) {
        if (!B) {
          // With NO baseline we cannot prove which meaning is newer or whether
          // the two copies descended from one another. Choosing either side is
          // silent loss on first Brain Sync / an empty-ancestor git merge.
          // Keep ours live and materialize theirs as a twin, exactly like a
          // normal two-sided edit: convergence is not enough if one meaning dies.
          json = O.items[id]; side = 'ours';
          const record = { id, kind: 'content-no-base', keptLive: 'ours', twin: null };
          conflicts.push(record);
          twinRequests.push({ k: id, v: T.items[id], srcPos: T.positions[id] || O.positions[id], record });
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

    const { pos, tP, tParentChg } = descendantPosition(O, T, B, id);
    // Detect a hook archive-move for the delta receipt.
    if (side === 'theirs' && tParentChg && ARCHIVE.test(parentTitle(T, tP))) delta.archived.push(id);

    merged.set(id, { json, pos });
  }

  const removedSet = new Set(delta.removed);
  const twins = makeTwinPlacer({
    seedIds: allIds,
    liveValues: (x) => (merged.has(x) ? [merged.get(x).json] : []),
    slotState: (x) => {
      if (merged.has(x)) return 'alive';
      if ((O.items[x] != null || T.items[x] != null) && removedSet.has(x)) return 'dying';
      return graveyard[x] ? 'dead' : 'free';
    },
  });
  for (const req of twinRequests) Object.assign(req.record, twins.place(req.k, req.v, req.srcPos));

  // Every id that survived on either side (minus honored deletes) must be in
  // the result — 1.86.3's superset check, unchanged.
  const survivors = new Set();
  for (const S of [O, T]) for (const id of S.ids) if (!removedSet.has(id)) survivors.add(id);
  return { merged, extras: twins.extras, conflicts, delta, bin: Object.entries(graveyard), survivors, purgedCopies: 0, verify: null };
}

// ── Option modes (binMerge 'receipts' | '3way') ───────────────────────────────
// Three passes, in this order on purpose:
//   A  FATES — every id (live anywhere, in any bin, or in the base) gets exactly
//      one: alive, dead by tombstone, dead by a kill entry, or buried. Live
//      copies that meet a kill entry are classified: DROP or MOVE.
//   B  ROUTING — each MOVE follows the chain of deleted cards (a restore's
//      restoredAs, a deletion's revived id) until it reaches a free id (lands
//      there), a live card (matches it or becomes its twin), or the very bytes
//      that were deleted (drops). Fates are final before this starts, so a
//      value can never be folded into a card the same merge buries.
//   C  CONTENT — the familiar 3-way over the ids still alive.
// No clock decides anything: entries are chosen by pickBinEntry's total
// order, ids are derived from content and receipt identity, and moves run in
// a fixed order (ours, then theirs, each by source id). The same inputs give
// the same bytes through Brain Sync and through the git driver (F8).
function mergeOptionMode(B, O, T, del, deletedMeta, opt) {
  // '3way' without a base has no committed ancestor to read a revert from:
  // it behaves exactly as 'receipts'.
  const threeWay = opt.binMerge === '3way' && !!B;
  // 'unverified': theirs is foreign bytes with no proven ancestry. Nothing it
  // holds may delete, overwrite or move one of our cards — its news arrives as
  // twins and adds only.
  const unverified = opt.theirsTrust === 'unverified';
  const live = (S, id) => !!S && S.items[id] != null;
  const baseItem = (id) => (B && B.items[id]) || null;
  const titleOf = (pid) => (pid ? (O.titleById.get(pid) || T.titleById.get(pid) || B?.titleById.get(pid) || null) : null);
  const conflicts = [];
  const delta = { added: [], updated: [], archived: [], removed: [], revived: [] };
  // Routing rewrites a side's order, positions and edges (a value that lands
  // under a new id takes its predecessor's place and connections), so work on
  // copies — never on what parseKlypix handed back.
  for (const S of [O, T]) {
    S.order = [...S.order];
    S.positions = { ...S.positions };
    S.connections = S.connections.map((c) => ({ ...c }));
  }

  // ── Entries (E-3) ─────────────────────────────────────────────────────────
  // An entry whose body is missing counts as absent (the writer drops those).
  const eOf = (S, id) => { const e = S?.graveyard?.[id]; return e && e.json != null ? e : null; };
  const maxEntry = (id, list) => list.reduce((w, e) => (e ? pickBinEntry(id, w, e) : w), null);
  // The entry a dead card ends with. The base's own entry counts: "no receipt,
  // no purge" — an entry a side merely LACKS (a git checkout of an older file,
  // a ≤1.86 CLI purge that dropped it) comes back instead of vanishing.
  // Unverified: a foreign bin never replaces an entry we or the base hold.
  const eAll = (id) => (unverified
    ? (maxEntry(id, [eOf(O, id), eOf(B, id)]) ?? eOf(T, id))
    : maxEntry(id, [eOf(O, id), eOf(T, id), eOf(B, id)]));
  // The entry that can kill a card live on some side. A side's own entry for
  // its own live card is malformed and ignored; under 'unverified' a foreign
  // entry never kills a card we hold (q6: a foreign purge is not our delete).
  const eKill = (id) => maxEntry(id, [
    live(O, id) ? null : eOf(O, id),
    (live(T, id) || (unverified && live(O, id))) ? null : eOf(T, id),
    live(B, id) ? null : eOf(B, id),
  ]);

  // ── Pass A: fates ─────────────────────────────────────────────────────────
  const fate = new Map();            // id -> { alive, why, entry?, wasLive? }
  const moves = [];                  // { S, side, from, v, target, via }
  const drops = [];                  // { S, side, from, v, at, kind: 'F'|'P', chain? }
  const purgeVsEdit = (side, id, v, at = id) => {
    // Only a copy that says something the base did not (or a copy of a card the
    // base never had) is news being lost; a stale copy dropping is the purge
    // working. The edit survives in that machine's restore point.
    if (!live(B, id) || !sameMeaning(v, B.items[id])) conflicts.push({ id, kind: 'purge-vs-edit', side, ...(at !== id ? { at } : {}) });
  };
  const classify = (S, side, id, v, E) => {
    const kind = entryKind(E.meta);
    if (kind === 'P') {
      // P-a: delete-permanently is for secrets, and an edited copy usually
      // still holds the secret. Every live copy drops, edited or not.
      drops.push({ S, side, from: id, v, at: id, kind: 'P' });
      purgeVsEdit(side, id, v);
      return;
    }
    // A restore: the card lives on at restoredAs; this copy follows it there.
    if (kind === 'R') { moves.push({ S, side, from: id, v, target: E.meta.restoredAs, via: 'restore' }); return; }
    if (sameMeaning(v, E.json)) {
      // Exactly what was deleted. On path L that is a stale copy (a checkout,
      // a machine that never saw the delete) and the delete holds. In git
      // history (3way) with the base holding this very deletion, a side that
      // brought the bytes back committed a revert — it comes back, as k′.
      const eb = eOf(B, id);
      if (threeWay && !live(B, id) && eb && receiptIdentity(id, eb.meta, eb.json) === receiptIdentity(id, E.meta, E.json)) {
        moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'resurrection' });
        return;
      }
      drops.push({ S, side, from: id, v, at: id, kind: 'F' });
      return;
    }
    // Different from what was deleted: an edit the deleter never saw (R5).
    // It must not die with the delete, and must not contradict the receipt.
    moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'edit' });
  };

  const allIds = new Set([
    ...O.ids, ...T.ids, ...(B ? B.ids : []),
    ...Object.keys(O.graveyard), ...Object.keys(T.graveyard), ...(B ? Object.keys(B.graveyard) : []),
  ]);
  for (const id of allIds) {
    const lo = live(O, id), lt = live(T, id);
    if (del.has(id)) {
      let E = eAll(id);
      const purged = !!E && entryKind(E.meta) === 'P';
      // T3: today's delete-vs-edit — theirs edited the card after the delete
      // was decided, so theirs is kept. A purge outranks it (P-a).
      if (lt && live(B, id) && !sameMeaning(T.items[id], B.items[id]) && !purged) {
        fate.set(id, { alive: true, why: 'delete-vs-edit' });
        conflicts.push({ id, kind: 'delete-vs-edit', kept: 'theirs' });
        continue;
      }
      if (!E) {
        // E-11: a tombstone for a card gone from both sides is buried from the
        // base's bytes, so the delete still leaves a recoverable entry.
        const json = O.items[id] ?? T.items[id] ?? baseItem(id) ?? null;
        if (json == null) continue;                  // nothing here, nothing to bury
        const pos = O.positions[id] || T.positions[id] || (B && B.positions[id]) || null;
        E = binEntryFor({ id, json, pos, area: titleOf(pos?.parentId), receipt: deletedMeta?.[id] });
      }
      // T1/T2: the tombstone holds. A live value here is the deleted version
      // or an older one (a tombstone only comes from "untouched here, deleted
      // there"), so it is buried with the entry — except under a purge, where
      // each copy is dropped and reported like any other.
      fate.set(id, { alive: false, why: 'tombstone', entry: E, wasLive: lo || lt });
      delta.removed.push(id);
      if (purged) {
        if (lo) classify(O, 'ours', id, O.items[id], E);
        if (lt) classify(T, 'theirs', id, T.items[id], E);
      }
      continue;
    }
    if (lo || lt) {
      const E = eKill(id);
      if (!E) { fate.set(id, { alive: true, why: 'live' }); continue; }
      // K: some bin says this card is gone. Each live copy is judged on its
      // own — two stale copies both drop, two edits both move.
      fate.set(id, { alive: false, why: 'receipt', entry: E, wasLive: true });
      delta.removed.push(id);
      if (lo) classify(O, 'ours', id, O.items[id], E);
      if (lt) classify(T, 'theirs', id, T.items[id], E);
      continue;
    }
    const E = eAll(id);
    if (E) fate.set(id, { alive: false, why: 'buried', entry: E });
  }

  // ── Pass B: routing ───────────────────────────────────────────────────────
  const landed = new Set();
  const liveValuesAt = (x) => {
    if (!fate.get(x)?.alive) return [];
    const out = [];
    if (live(O, x)) out.push(O.items[x]);
    if (live(T, x)) out.push(T.items[x]);
    return out;
  };
  const twins = makeTwinPlacer({
    seedIds: [...O.ids, ...T.ids],
    liveValues: liveValuesAt,
    slotState: (x) => {
      const f = fate.get(x);
      if (!f) return 'free';
      if (f.alive) return 'alive';
      return (live(O, x) || live(T, x)) ? 'dying' : 'dead';
    },
    // A twin a person deleted since the base, holding this very value: the
    // conflict was resolved by deleting it (critic A §8). Never in union mode.
    suppressDeleted: (x, v) => {
      const e = fate.get(x)?.entry;
      return !!e && entryKind(e.meta) === 'F' && sameMeaning(e.json, v) && !!(eOf(O, x) || eOf(T, x)) && !eOf(B, x);
    },
  });
  const repoint = (S, from, to) => {
    for (const c of S.connections) { if (c.fromId === from) c.fromId = to; if (c.toId === from) c.toId = to; }
    for (const [cid, p] of Object.entries(S.positions)) if (p && p.parentId === from) S.positions[cid] = { ...p, parentId: to };
  };
  const arrive = (mv, as) => {
    repoint(mv.S, mv.from, as);
    delta.revived.push({ id: mv.from, as, side: mv.side, via: mv.via });
  };
  const landFresh = (mv, t) => {
    const S = mv.S;
    S.items[t] = mv.v;
    S.positions[t] = { ...(S.positions[mv.from] || {}) };
    const at = S.order.indexOf(mv.from);
    if (at >= 0) S.order[at] = t; else S.order.push(t);
    fate.set(t, { alive: true, why: 'landed' });
    landed.add(t);
    arrive(mv, t);
  };
  // A moved value NEVER overwrites a live card (the draft's p8a fold lost a
  // sibling's edit that way): it matches the card or one of its twins, or it
  // becomes a new deterministic twin.
  const landIntoAlive = (mv, t) => {
    if (twins.holds(t, mv.v)) return arrive(mv, t);
    for (const x of twins.twinsOf(t)) if (twins.holds(x, mv.v)) return arrive(mv, x);
    const r = twins.place(t, mv.v, mv.S.positions[mv.from] || O.positions[t] || T.positions[t]);
    conflicts.push({ id: t, kind: 'revived', keptLive: 'ours', from: mv.from, side: mv.side, ...r });
    if (r.suppressed) { drops.push({ ...mv, at: r.twin, kind: 'F', chain: true }); return; }
    arrive(mv, r.twin);
  };
  const route = (mv) => {
    let t = mv.target;
    const seen = new Set([mv.from]);
    for (let step = 0; step < ROUTE_STEPS && !seen.has(t); step++) {
      seen.add(t);
      const f = fate.get(t);
      if (!f) return landFresh(mv, t);
      if (f.alive) return landIntoAlive(mv, t);
      // A dead target: its own entry decides, and the chain goes on.
      const E = f.entry;
      const kind = entryKind(E.meta);
      if (kind === 'P') {
        drops.push({ ...mv, at: t, kind: 'P', chain: true });
        purgeVsEdit(mv.side, mv.from, mv.v, t);
        return;
      }
      if (kind === 'R') { t = E.meta.restoredAs; continue; }
      // Deleted with these very bytes: the deleter saw exactly this value.
      if (sameMeaning(mv.v, E.json)) { drops.push({ ...mv, at: t, kind: 'F', chain: true }); return; }
      t = revivedIdFor(t, E.meta, E.json);
    }
    // A cycle, or a chain longer than any real history: land at an id derived
    // from the value itself, which every machine computes alike.
    const c = `${stripRevived(mv.from)}__r_${sha12(`cycle\n${mv.from}\n${itemSignature(mv.v)}`)}`;
    return fate.get(c)?.alive ? landIntoAlive(mv, c) : landFresh(mv, c);
  };
  const bySource = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  for (const mv of [...moves.filter((m) => m.side === 'ours').sort(bySource), ...moves.filter((m) => m.side === 'theirs').sort(bySource)]) route(mv);

  // ── Pass C: content, over the ids still alive ─────────────────────────────
  const merged = new Map();
  const twinOf = (k, v, srcPos, kind) => conflicts.push({ id: k, kind, keptLive: 'ours', ...twins.place(k, v, srcPos) });
  // E-1b: S holds a live twin of k whose value is `val` — the conflict was
  // already resolved on S's side, with `val` kept beside the card.
  const liveTwinHolding = (S, k, val) =>
    twins.twinsOf(k).find((x) => fate.get(x)?.alive && live(S, x) && sameMeaning(S.items[x], val)) ?? null;
  for (const [id, f] of fate) {
    if (!f.alive) continue;
    const inO = live(O, id), inT = live(T, id);
    if (!inO && !inT) continue;
    const cb = baseItem(id);
    const srcPos = T.positions[id] || O.positions[id];
    let json, side;
    if (inO && inT) {
      const oChg = !cb || !sameMeaning(O.items[id], cb);
      const tChg = !cb || !sameMeaning(T.items[id], cb);
      const diverged = !sameMeaning(O.items[id], T.items[id]);
      if (cb && oChg && tChg && diverged) {
        // E-1b: theirs already resolved this very conflict the other way round
        // (its twin holds our text) and ours has not — adopt that resolution
        // instead of twinning a second time. Both texts stay live.
        const adoptTwin = opt.adoptResolvedConflicts ? liveTwinHolding(T, id, O.items[id]) : null;
        if (adoptTwin && !liveTwinHolding(O, id, T.items[id])) {
          json = T.items[id]; side = 'theirs'; delta.updated.push(id);
          conflicts.push({ id, kind: 'content', keptLive: 'theirs', twin: adoptTwin, adopted: true });
        } else {
          json = O.items[id]; side = 'ours';
          twinOf(id, T.items[id], srcPos, 'content');
        }
      } else if (tChg && !oChg) {
        if (unverified) {
          // A one-sided edit from foreign bytes may be older than ours, not
          // newer — unordered, so it is kept beside the card, never over it.
          json = O.items[id]; side = 'ours';
          twinOf(id, T.items[id], srcPos, 'content-unverified');
        } else { json = T.items[id]; side = 'theirs'; delta.updated.push(id); }
      } else if (!cb && diverged) {
        if (!B) {
          json = O.items[id]; side = 'ours';
          twinOf(id, T.items[id], srcPos, 'content-no-base');
        } else if (landed.has(id) || opt.newOnBothSides === 'twin' || unverified) {
          // E-5 (R6): new on both sides since the base and diverged. Two
          // machines wrote different things under one id; taking theirs
          // (S10, the app-save rule) would lose ours silently.
          json = O.items[id]; side = 'ours';
          twinOf(id, T.items[id], srcPos, 'content-new-both');
        } else { json = T.items[id]; side = 'theirs'; }
      } else { json = O.items[id]; side = 'ours'; }
    } else if (inT) {
      json = T.items[id]; side = 'theirs';
      if (!cb && !landed.has(id)) delta.added.push(id);   // landed ids are reported in delta.revived
    } else {
      json = O.items[id]; side = 'ours';
    }

    let pos;
    if (unverified) {
      // Ours-first: a foreign move or re-parent is unordered against ours.
      const oP = O.positions[id], tP = T.positions[id];
      pos = { ...(oP || tP || {}), parentId: oP ? (oP.parentId ?? null) : (tP?.parentId ?? null) };
    } else {
      const r = descendantPosition(O, T, B, id);
      pos = r.pos;
      if (side === 'theirs' && r.tParentChg && ARCHIVE.test(parentTitle(T, r.tP))) delta.archived.push(id);
    }
    merged.set(id, { json, pos });
  }

  const removedSet = new Set(delta.removed);
  const survivors = new Set();
  for (const S of [O, T]) for (const id of S.ids) if (live(S, id) && !removedSet.has(id)) survivors.add(id);
  for (const t of landed) survivors.add(t);
  const bin = [...fate].filter(([, f]) => !f.alive && f.entry).map(([id, f]) => [id, f.entry]);

  // ── E-12 / E-13: the merge proves itself before anything is written ───────
  const verify = ({ resultIds, written, valueAt }) => {
    const unreceipted = delta.removed.filter((id) => fate.get(id)?.wasLive && !written[id]);
    if (unreceipted.length) throw new Error(`mergeBrains INVARIANT VIOLATED — removed ${unreceipted.length} card(s) without a receipt: ${unreceipted.slice(0, 5).join(', ')}`);
    const binHolds = (at, v) => {
      const e = fate.get(at)?.entry;
      return !!(written[at] && e && entryKind(e.meta) === 'F' && sameMeaning(e.json, v));
    };
    const resultTwins = new Map();
    for (const id of resultIds) { const m = TWIN_PARENT_RE.exec(id); if (m) (resultTwins.get(m[1]) || resultTwins.set(m[1], []).get(m[1])).push(id); }
    const liveAt = (as, v) => resultIds.has(as) &&
      (sameMeaning(valueAt(as), v) || (resultTwins.get(as) || []).some((x) => sameMeaning(valueAt(x), v)));
    const arrived = new Map(delta.revived.map((r) => [`${r.side}\n${r.id}`, r.as]));
    const chainDrop = new Map(drops.filter((d) => d.chain).map((d) => [`${d.side}\n${d.from}`, d]));
    for (const mv of moves) {
      const key = `${mv.side}\n${mv.from}`;
      if (arrived.has(key) && liveAt(arrived.get(key), mv.v)) continue;
      const d = chainDrop.get(key);
      if (d && (d.kind === 'P' || binHolds(d.at, mv.v))) continue;
      throw new Error(`mergeBrains INVARIANT VIOLATED — a moved value of ${mv.from} is neither live nor in the bin`);
    }
    for (const d of drops) {
      if (d.chain || d.kind === 'P') continue;
      if (!binHolds(d.at, d.v)) throw new Error(`mergeBrains INVARIANT VIOLATED — dropped ${d.from} without its bytes in the bin`);
    }
  };

  const purgedCopies = drops.filter((d) => d.kind === 'P').length;
  return { merged, extras: twins.extras, conflicts, delta, bin, survivors, purgedCopies, verify };
}

// ── The shared tail: twins, order, zKeys, edges, assets, bin, manifest ────────
async function finishMerge(B, O, T, opt, run) {
  const { merged, extras, conflicts, delta, bin, survivors, purgedCopies, verify } = run;

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
  order.forEach((id, i) => {
    const rec = merged.get(id);
    let z = rec.pos.zKey;
    if (!z || !isValidZKey(z) || usedZ.has(z)) z = generateKeyBetween(lastZ, null);
    usedZ.add(z); lastZ = z;
    rec.pos = { ...rec.pos, zKey: z, zIndex: i };
  });

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

  // ── Union assets by path (later sources win: theirs, then ours, over base).
  // Under 'unverified' our own bytes win over foreign ones.
  const assets = {};
  const assetSources = opt.theirsTrust === 'unverified' ? [B, T, O] : [B, O, T];
  for (const src of assetSources) if (src) for (const [p, bytes] of Object.entries(src.assets)) assets[p] = bytes;

  // ── Build merged zip ──────────────────────────────────────────────────────
  const zip = new JSZip();
  const now = Date.now();
  for (const id of order) zip.file(`items/${shard(id)}/${id}.json`, merged.get(id).json);
  for (const [p, bytes] of Object.entries(assets)) zip.file(p, bytes);

  // Graveyard: card bytes under graveyard/, metadata in one index. Written only
  // when non-empty so a brain that has never had a delete keeps a byte-identical
  // shape. Nothing here is reachable from `order`, so nothing here can render,
  // be searched, be embedded, or be counted. A card is never in the brain AND
  // the bin.
  const graveyardEntries = {};
  for (const [gid, g] of bin) {
    if (g?.json == null || liveIds.has(gid)) continue;
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
  // 'ours' flips the precedence (foreign bytes never rename or re-stamp us).
  const manifest = opt.manifestMerge === 'ours'
    ? { format: 'klypix', version: 4, ...(T.manifest || {}), ...(O.manifest || {}) }
    : { format: 'klypix', version: 4, ...(O.manifest || {}), ...(T.manifest || {}) };
  if (opt.manifestMerge === '3way') {
    // E-7 (R7): theirs-first loses a rename made on our side. The title is a
    // 3-way decision: whichever side changed it since the base wins; if both
    // changed it (or there is no base to tell), ours stays and theirs is reported.
    const tO = O.manifest?.title, tT = T.manifest?.title;
    if (tO !== undefined && tT !== undefined && tO !== tT) {
      const tB = B ? B.manifest?.title : undefined;
      if (B && tB === tO) manifest.title = tT;
      else {
        manifest.title = tO;
        if (!(B && tB === tT)) conflicts.push({ id: null, kind: B ? 'title' : 'title-no-base', kept: 'ours', ours: tO, theirs: tT });
      }
    }
  }
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
  const missing = [...survivors].filter(id => !liveIds.has(id));
  if (missing.length) throw new Error(`mergeBrains INVARIANT VIOLATED — dropped ${missing.length} card(s): ${missing.slice(0, 5).join(', ')}`);
  if (verify) verify({ resultIds: liveIds, written: graveyardEntries, valueAt: (id) => merged.get(id)?.json ?? null });
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
    revived: delta.revived.length, purgedCopies,
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
