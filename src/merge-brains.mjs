#!/usr/bin/env node
// merge-brains — the pure, provable core of the desktop-app<->hooks brain
// concurrency fix. A 3-way UNION-by-stable-id reconcile of two .klypix brains
// that share a common ancestor, designed so that a merge never drops a card a
// person did not delete (the one deliberate exception, in the option modes: a
// permanently deleted card's copies, edited or not — P-a, below).
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
//   • Content conflict (both edited the same card) keeps BOTH texts:
//     the human's stays live on the card, the agent's is preserved as a linked
//     twin card — never silently dropped.
//   • zKeys are de-collided (duplicate keys silently no-op in the app reducer),
//     and the order is the cards by zKey, then id — the same whichever side
//     is ours, so git and Brain Sync stop rewriting each other's order.
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
// STAGE 2 (klypix-mcp 1.89) — rules that hold for EVERY caller, options or not:
//   • Conflict twins get DETERMINISTIC ids (twinIdFor: the conflicted card's id
//     plus a hash of the value being preserved). A random id meant the same
//     conflict merged twice — by the git driver and by Brain Sync, or on two
//     machines — left two twins of one value that never folded. Now a value
//     that already has a twin is never twinned again, and two transports that
//     resolve the same conflict land on the same card.
//   • Every bin entry the engine mints carries its identity (`rid`, see
//     receiptIdentity in klypix-format.mjs) — a name for the deletion that two
//     machines derive without talking, and that never orders anything.
//   • An edge both sides hold takes theirs' copy when ours' names a card this
//     merge removed and theirs' names cards that live: the app save, which
//     tombstones the tab's stale copy of a card the disk moved, otherwise
//     dropped the edge the disk had re-pointed. Ours' copy would dangle, so
//     this only keeps an edge 1.86.3 lost.
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
//   • A purge reaches the restores of its card the purging machine never saw:
//     every landing a restore receipt names dies under a receipt derived from
//     the purge (P-a: a purge wins over every copy). Text typed into a
//     landing goes too, on the board or in Deleted cards, and is reported
//     (purge-vs-edit); a restored card that leaves the board untouched is
//     reported too (purge-reached-restore), so the person who restored it
//     is told.
//   • A moved value never overwrites a live card: it matches one, or becomes
//     its deterministic twin.
//   • A tie between the two sides is broken from the values alone, never by
//     "ours". In these modes ours is only this machine, so ours-first gave a
//     different answer on every machine; with two ways to sync one brain (git
//     and Brain Sync) the repo and the cloud ended up holding opposite
//     answers, and the machines relayed them back and forth for ever. So,
//     for a value BOTH sides changed:
//       – a card both sides moved, or put into different containers, or
//         re-stacked: one place, one container, one stacking key
//         (descendantPosition — with a base; with none, ours as ever);
//       – a title both renamed, an arrow, line, stroke, setting or embedded
//         file both changed: one value (pickThreeWay; the bytes themselves
//         for a file). One changed on one side only wins wherever it was
//         made: the base says which side that is — or holds no such value,
//         and then the two are picked between as a tie.
//     A first conflict between two new texts is unchanged: ours stays on the
//     card and theirs goes to its twin; the next merge anywhere then agrees.
//   • A card never settles on the text of its own live conflict twin. Where
//     the two sides show different texts on a card and a twin beside it holds
//     one of them, the OTHER stays on the card (nothing else holds it); where
//     twins hold both, one of the two by the texts alone. This is more than a
//     tie-break: it also keeps a change ONE side made off the card when that
//     change is the twin's text, and says so (`change-held-in-twin`). Pass C
//     says why, and how the desktop lets a person take that text. ("Holds" is
//     the whole card's meaning — sameMeaning — not its text alone: a twin that
//     differs from the card's new value in any other field does not hold it,
//     and the change lands.)
//   • A card is never left under a container that is not on the board: it
//     follows a container this merge moved to a new id, else goes where the
//     other side has it, else to the top level (a line or a stroke: the moved
//     container, or the top level). Nor in a loop of containers (each side
//     nested one group into the other): the loop is opened at one member, the
//     same one on every machine.
//   • A conflict twin the desktop buried as SETTLED (its card had been made to
//     say what it held; receipt cause conflict-settled) whose settle a merge
//     undoes is reported (`settle-undone`): the settling side's base predated
//     the conflict (the twin came by the other transport, or a base write
//     failed), so its choice read as unchanged and the other side's text as a
//     one-sided change. The card goes back to that text and the chosen one is
//     in Deleted cards. Only the merge that buries the still-live copy says
//     so; if that merge runs on the machine that never settled, the settling
//     machine then takes the other text as an ordinary one-sided change, with
//     no notice. (Reading the settle as that side's change of the card, so
//     that both texts stay, is a new merge rule: Stage 3.)
//   • Arrows, lines and strokes are written in id order, and of two arrows
//     that mean the same the one with the smaller id stays: theirs-first
//     wrote a different array on every machine, and git and Brain Sync then
//     rewrote each other's file for ever.
//   • A moved value whose landing is a conflict copy is also offered to the
//     card that copy stands beside (one step up, the fold's own guards): a
//     restore that finds the card's revival live lands beside it, its
//     receipt names the copy, and an edit made on the revival's text ended
//     as a copy of the copy. A card a fold rewrote holds the folded value for
//     every later question of the same merge, and a card a value arrived at
//     is never folded over (certifying soak, seed 98381; review 8).
//   • A purge of a card that was itself a restore's landing reaches a twin
//     of it holding exactly the bytes that restore put back: the same
//     deletion restored on another machine, landed as a copy because an edit
//     the deleter never saw had taken the id (seed 98843). Never a twin the
//     purging side itself holds, live or in its own Deleted cards. The
//     purge does not follow the restore further (the mirror, a chain, a copy
//     of a copy, an edited copy): the LIMITS listed above `rootRestores`.
//   • A routed value counts as "seen and edited away" only by a twin that
//     held it at the base; a slot merely taken by other text is skipped, and
//     a resolution is never adopted from a twin a fold has just rewritten.
//   STILL OPEN with two transports on one brain (git and Brain Sync): a value
//   only ONE side changed is decided from that transport's base, and the two
//   do not share one. Two values of one field that pass each other between
//   the transports are enough (no third value, no driver merge): a card's
//   place, container or stacking key, an arrow label, a stroke, a setting,
//   the title or an embedded file's bytes can then be handed back and forth,
//   each machine relaying one transport's value into the other; so can a
//   card's text once its conflict twin is gone (deleted or settled) while the
//   two transports still hold different texts. Nothing is lost (both values
//   are live, one in the repo and one in the cloud). It ends when each
//   transport is brought to rest in turn — every machine syncs until none
//   writes, then every machine pulls and pushes until none merges; syncing
//   twice is not enough on its own. Closing it needs an edit counter kept in
//   the file (Stage 3).
//   • The merge proves itself: every removal of a live card leaves an entry
//     (E-12) and every moved value is live or its bytes are in the bin (E-13).

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  parseKlypix, shard, sameMeaning, itemSignature, twinIdFor, binEntryFor,
  entryKind, receiptIdentity, revivedIdFor, pickBinEntry, contentFreeReceiptFor, PURGED_BODY, fullEntryRid,
  pickThreeWay, canonicalFirst, pickReadingCopy,
} from './klypix-format.mjs';
import { generateKeyBetween } from 'fractional-indexing';

const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };

// One order for every merge, whichever side is ours. canvas.order lists the
// cards bottom to top; the app draws by zKey (sorted per parent) and keeps
// order in step with it. An order built from one side's list first came out
// different by orientation: git's driver (ours = this checkout) and Brain Sync
// wrote opposite orders and each rewrote the other's file on every round. So
// the cards go by zKey, then id; a card with no usable zKey (a twin minted in
// the merge, a file from before zKeys) goes on top, by its old zIndex, then id.
// A key that has to be made (missing, invalid, or a duplicate — the app
// silently no-ops a reorder over duplicates) lands between its neighbours, so
// the result is sorted by zKey and the next merge leaves it as it is.
// `ids` may repeat; `posOf(id)` is the card's position before the heal.
function canonicalZOrder(ids, posOf) {
  const zOf = (id) => { const z = posOf(id)?.zKey; return z && isValidZKey(z) ? z : null; };
  const zIndexOf = (id) => { const n = posOf(id)?.zIndex; return Number.isFinite(n) ? n : Infinity; };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byZ = (a, b) => {
    const za = zOf(a), zb = zOf(b);
    if (za !== zb) return za == null ? 1 : zb == null ? -1 : cmp(za, zb);
    if (za == null) { const d = zIndexOf(a) - zIndexOf(b); if (d) return d; }
    return cmp(a, b);
  };
  const order = [...new Set(ids)].sort(byZ);
  const keys = new Map();
  const used = new Set();
  let last = null;
  order.forEach((id, i) => {
    let z = zOf(id);
    if (z == null || used.has(z) || (last != null && z <= last)) {
      let next = null;
      for (let j = i + 1; j < order.length; j++) {
        const k = zOf(order[j]);
        if (k == null) break;
        if (last == null || k > last) { next = k; break; }
      }
      z = generateKeyBetween(last, next);
    }
    used.add(z); last = z; keys.set(id, z);
  });
  return { order, keyOf: (id) => keys.get(id) };
}
const ARCHIVE = /^archive$/i;

// The identity helpers live in klypix-format.mjs (one definition for every
// engine file and the KLYPIX core). Re-exported here because callers written
// against 1.86 — the git driver, the API-5 KLYPIX sync core — import them from
// this module, and the KLYPIX core reads the whole engine off this namespace.
export {
  sameMeaning, itemSignature, VOLATILE_ITEM_FIELDS, READING_ITEM_FIELDS, twinIdFor, revivedIdFor, receiptIdentity, entryKind,
  isContentFreeReceipt, pickBinEntry, PURGED_BODY, binEntryFor, contentFreeReceiptFor, fullEntryRid,
  pickThreeWay, pickReadingCopy,
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
 *  string, because installs mix file generations (a 1.89 driver beside a 1.86
 *  engine, a desktop bundle beside a dev-owned ~/.claude). Absent ⇒ ≤ 1.88
 *  (1.88.0 is the session mailbox alone: no Stage 2 engine).
 *  A flag turns true only when the thing it names runs. */
export const MERGE_ENGINE_FEATURES = Object.freeze({
  api: 3,                            // absent ⇒ 1. Bump only when an option's meaning changes. (2 was never published: the option modes before sideFreeTies.)
  deterministicTwins: true,          // E-1, every caller
  receiptIds: true,                  // E-2, every caller
  purgeReceipts: true,               // purgeGraveyard leaves a content-free receipt
  revivedIds: true,                  // restores (restoreFromGraveyard) and rescued edits land under revivedIdFor
  restoreAsMerge: true,              // history restore as a merge (restoreSnapshotAsMerge, E-9)
  arrangeReceipts: true,             // arrangeBrain buries what it collapses, survivor from content and ids (E-8)
  revivalMap: true,                  // revivalMap, and brainDelta's lastKnown/collectLive, for the live watcher
  sideFreeTies: true,                // option modes: a tie between two sides is broken from the values alone (pickThreeWay)
  derivedReadings: true,             // every caller: a card's saved reading (READING_ITEM_FIELDS) is no part of its meaning — no twin, no conflict, a delete wins — and of two copies that mean the same the one with the current reading is written (pickReadingCopy)
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
// list (updatedAt, zIndex, editedAt) — lives in klypix-format.mjs since 1.89,
// so the bin identity (receiptIdentity) and twin ids hash exactly the meaning
// this merge compares.
//
// A card's saved READING (READING_ITEM_FIELDS: derivedText and its kind,
// source, sha, time and visuals — a document's text, a transcript) is stripped
// there too: it is derived from the card's bytes and made again when missing.
// Two machines that read one card between syncs wrote those fields
// independently, and counted as content they kept a conflict twin of the card
// (a media reading's time stamp alone did it), or brought back a card the
// other side had deleted (a reading counted as the edit the deleter never saw).
// Now a reading-only difference is one card and a reading never beats a
// delete. Which of two such copies is written is still decided — the reading is
// what AI tools are served, and git and Brain Sync compare it — by
// pickReadingCopy: the current reading, the same copy whichever side is ours.

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
// `canonical` (the option modes: Brain Sync and the git driver, where "ours"
// is just this machine) AND a base to say who moved anything — with none,
// every test below is true by construction and the board became a per-card
// mixture of the two copies, matching neither (review round 5). When BOTH
// sides moved the card to different places,
// or into different containers, the winner is picked from the two places
// alone (placeFirst), the same on every machine. Ours-first kept each
// machine's own place on its machine; with git and Brain Sync on one brain
// the repo and the cloud then held opposite places and the machines swapped
// them on every round (review round 3). The app save keeps ours-first: there
// ours is the person at the open tab.
const placeFirst = (a, b) => {
  const ka = [a.x ?? 0, a.y ?? 0, a.w ?? -1, a.h ?? -1], kb = [b.x ?? 0, b.y ?? 0, b.w ?? -1, b.h ?? -1];
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
  return canonicalFirst(String(a.parentId ?? ''), String(b.parentId ?? ''));
};
function descendantPosition(O, T, B, id, canonical = false) {
  const oP = O.positions[id], tP = T.positions[id], bP = (B && B.positions[id]) || null;
  // The stacking key (which card is in front) is its own 3-way decision in
  // the option modes. It rode with the place: a card brought to the front and
  // not moved kept the OTHER side's key in every merge — the cloud's in a
  // sync, the repo's in a git merge — so the two never agreed.
  const zKeyed = (pos) => {
    if (!(canonical && B && oP && tP) || oP.zKey === tP.zKey) return pos;
    // A key that is absent or unusable is not a choice: the side holding a
    // usable one keeps it (read as a value, a missing key won the pick and
    // the card was re-minted on top). With none, the order below mints one.
    const usable = (p) => typeof p.zKey === 'string' && isValidZKey(p.zKey);
    const z = usable(oP) && usable(tP) ? pickThreeWay(oP.zKey, tP.zKey, bP && usable(bP) ? bP.zKey : undefined)
      : usable(oP) ? oP.zKey : usable(tP) ? tP.zKey : null;
    if (z == null) { const { zKey, ...rest } = pos; return rest; }
    return { ...pos, zKey: z };
  };
  const oMoved = oP && (!bP || !samePos(oP, bP));
  const oParentChg = oP && (!bP || !sameParent(oP, bP));
  const tParentChg = tP && (!bP || !sameParent(tP, bP));
  let finalXY = oMoved ? oP : (tP || oP);
  if (canonical && B && oP && tP) {
    const tMoved = !bP || !samePos(tP, bP);
    const parentClash = oParentChg && tParentChg && !sameParent(oP, tP);
    const placeClash = oMoved && tMoved && !samePos(oP, tP);
    if (parentClash || placeClash) {
      const win = placeFirst(oP, tP) ? oP : tP;
      // Two containers: the card goes whole to one of them. Two places in
      // one container: the place is the winner's, the parent 3-way as ever.
      if (parentClash) return { pos: zKeyed({ ...win, parentId: win.parentId ?? null }), tP, tParentChg };
      finalXY = win;
    }
  }

  let parentId;
  if (oParentChg) parentId = oP.parentId ?? null;
  else if (tParentChg) parentId = tP.parentId ?? null;
  else parentId = (finalXY?.parentId ?? oP?.parentId ?? tP?.parentId ?? null);

  return { pos: zKeyed({ ...(finalXY || oP || tP || {}), parentId }), tP, tParentChg };
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
//   3. a random id after TWIN_SLOTS slots, so the value still has a home.
// One index per merge (immediate parent → twin ids), so this stays linear on a
// brain with thousands of simultaneous conflicts. `liveValues(x)` and
// `slotState(x)` describe the merge's own cards; twins minted here are tracked
// by the placer itself.
function makeTwinPlacer({ seedIds, liveValues, slotState, suppressDeleted = null, keptValues = null, heldAtBase = null, saysElseThere = null, rewrittenHere = null }) {
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
  // `side`: the side whose copy holds `v` ('ours' | 'theirs'), when known.
  // `strict` (a content conflict's twin): a twin both sides hold with different
  // texts is being decided by this very merge, so only what it holds AFTER
  // the merge counts as a home for v (`keptValues`). Read from either side, a
  // copy one side had rewritten still "held" the text the merge was about to
  // replace in it, and that text ended on no card, in no twin and in no bin
  // (review round 6).
  const place = (k, v, srcPos, side = null, strict = false, routed = false) => {
    const has = (x) => (strict && keptValues && !extraById.has(x) ? keptValues(x).some((val) => sameMeaning(val, v)) : holds(x, v));
    for (const x of (index.get(k) || [])) if (has(x)) return { twin: x, existing: true };
    for (let n = 0; n < TWIN_SLOTS; n++) {
      const x = twinIdFor(k, v, n);
      const state = stateOf(x);
      if (state === 'alive') {
        if (has(x)) return { twin: x, existing: true };
        // A slot this very merge rewrote (a moved value folded onto it) says
        // something else because of this merge, not because a person saw v
        // and edited it away: v still needs a home.
        if (rewrittenHere && rewrittenHere(x)) continue;
        // A ROUTED value (a moved copy the deleter never saw) counts as seen
        // only by a twin that held it at the base: that copy was edited by
        // someone who had it in front of them. A slot that merely happens to
        // be taken by other text proves nothing, and the value needs a home
        // (the merge refused itself otherwise, E-13: review 9, fuzz).
        if (routed && !(heldAtBase && heldAtBase(x, v))) continue;
        // It says something else: a person edited it and v counts as seen —
        // unless the edit was made since the base (the base's copy still held
        // v), or the very side that shows v on the card holds this slot with
        // another text: then v is on no twin, and still needs a home.
        if (strict && ((heldAtBase && heldAtBase(x, v)) || (saysElseThere && saysElseThere(x, v, side)))) continue;
        return { twin: x, existing: true, edited: true };
      }
      if (state === 'free') return mint(x, k, v, srcPos);
      if (state === 'dead' && suppressDeleted && suppressDeleted(x, v, side)) return { twin: x, suppressed: 'deleted-twin' };
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
        // KEEP theirs (the hook's text is newer than the delete); record the conflict.
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
      // differ only in volatile or reading fields are not in conflict.
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
      else if (!diverged) {
        // One card: the copies differ in volatile and reading fields at most.
        // The one with the current reading is written (pickReadingCopy) — the
        // same copy whichever side is ours, so a reading theirs made is kept.
        side = pickReadingCopy(O.items[id], T.items[id], baseItem(id));
        json = side === 'ours' ? O.items[id] : T.items[id];
        if (side === 'theirs') delta.updated.push(id);
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
    // The app save too: a slot twin the tab rewrote does not hold the text the
    // disk's card brings (1.86.3 minted a copy; the slot rule dropped it).
    heldAtBase: (x, v) => !!B && B.items[x] != null && sameMeaning(B.items[x], v),
    saysElseThere: (x, v) => T.items[x] != null && !sameMeaning(T.items[x], v),
    slotState: (x) => {
      if (merged.has(x)) return 'alive';
      if ((O.items[x] != null || T.items[x] != null) && removedSet.has(x)) return 'dying';
      return graveyard[x] ? 'dead' : 'free';
    },
  });
  for (const req of twinRequests) Object.assign(req.record, twins.place(req.k, req.v, req.srcPos, null, true));

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
  // A receipt an earlier merge derived for a purge that reached a restore is
  // not read once this merge derives that card's receipt afresh (`reached`,
  // below): the purge that wins NOW decides it, or a merge in between that
  // saw a losing purge would leave its choice behind, and the grouping of
  // merges would change the bin.
  const reached = new Map();         // card id -> { entry, root, from, rid }: a purge that reached this restore
  const eOf = (S, id) => {
    const e = S?.graveyard?.[id];
    if (!e || e.json == null) return null;
    return reached.has(id) && typeof e.meta?.purgedWith === 'string' ? null : e;
  };
  const maxEntry = (id, list) => list.reduce((w, e) => (e ? pickBinEntry(id, w, e) : w), null);
  // The entry a dead card ends with. The base's own entry counts: "no receipt,
  // no purge" — an entry a side merely LACKS (a git checkout of an older file,
  // a ≤1.88 CLI purge that dropped it) comes back instead of vanishing.
  // Unverified: a foreign bin never replaces an entry we or the base hold.
  const ownAll = (id) => (unverified
    ? (maxEntry(id, [eOf(O, id), eOf(B, id)]) ?? eOf(T, id))
    : maxEntry(id, [eOf(O, id), eOf(T, id), eOf(B, id)]));
  // The entry that can kill a card live on some side. A side's own entry for
  // its own live card is malformed and ignored; under 'unverified' a foreign
  // entry never kills a card we hold (q6: a foreign purge is not our delete).
  const ownKill = (id) => maxEntry(id, [
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
      // A restore the purge reached: its receipt names the bytes it put back,
      // so a copy holding anything else was edited since — whatever the base
      // knew of the card (the purging machine never saw it at all) — and is
      // reported as purge-vs-edit. A copy still holding exactly those bytes
      // is the purge working, but it is a card someone chose to bring back,
      // and it leaves their board with nothing restorable behind and, when
      // their base never held it, no delete anyone can see: it is reported
      // as purge-reached-restore, against the side that held it, with no
      // twin. Both are counted in purgedCopies.
      const via = reached.get(id);
      if (via && via.rid && E === via.entry) {
        if (fullEntryRid(via.from, v) !== via.rid) conflicts.push({ id, kind: 'purge-vs-edit', side, purgedWith: via.root });
        else conflicts.push({ id, kind: 'purge-reached-restore', side, purgedWith: via.root });
      } else purgeVsEdit(side, id, v);
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

  // ── P-a reaches a restore the purging machine never saw ──────────────────
  // Machine A restores k from its bin (the card lands at k′, and A's receipt
  // for k names it) while machine B, which never saw that restore, purges k.
  // P beats R, so the bin keeps the purge for k — and k′, which has no entry
  // of its own, stayed live with the very bytes the purge was for, and nobody
  // was told. A purge wins over every copy, and a restore's landing is a copy
  // of the card: the purge follows every restore receipt any side holds for
  // k, on through a landing that was itself deleted and restored, and each
  // landing dies under a receipt of its own. That receipt is DERIVED, never
  // minted: its rid hashes the purge's own rid (random, so nothing of the
  // content) with the landing, and its stamps are the purge's, so every
  // replica and both transports write the same entry and a re-merge changes
  // nothing. A conflict twin of a landing is followed only when it holds
  // exactly the bytes the restore put back (below): a rescue of an older
  // text can take the landing's id and leave the restored bytes in a twin
  // beside it, and that twin is the purged card. A twin holding other text
  // is someone's text kept beside the card, and stays. Nor is an edit a
  // merge rescued from the delete followed (it lands on that same revival
  // id, and no receipt names it): only the deleted bytes lead there, so
  // whether a purge reached it would depend on which copies a merge
  // happened to meet (a purge receipt must not carry a hash of them); and
  // the purging machine usually holds that card live and works on it, so a
  // purge, an age purge included, would take live work with it.
  const purgeOf = (k) => {
    const e = ownAll(k);
    // Only a purge someone made: a derived receipt is the reach of its own root.
    if (!e || entryKind(e.meta) !== 'P' || typeof e.meta.purgedWith === 'string') return null;
    // A foreign purge never kills our card (q6): under 'unverified', only a
    // purge we or the base hold reaches a restore.
    return unverified && !eOf(O, k) && !eOf(B, k) ? null : e;
  };
  const receiptFollowing = (root, P, landing) => {
    const m = P.meta || {};
    const meta = {
      rid: `p_${createHash('sha256').update(`${receiptIdentity(root, m, P.json)}\n${landing}`).digest('hex').slice(0, 16)}`,
      deletedAt: m.deletedAt, deletedBy: m.deletedBy, deletion: m.deletion,
      purged: true, purgedAt: m.purgedAt, purgedWith: root,
      preview: '', summary: { type: 'purged', label: 'Permanently deleted', preview: '' },
    };
    for (const key of Object.keys(meta)) if (meta[key] === undefined) delete meta[key];
    return { meta, json: PURGED_BODY };
  };
  // Two purges can reach one landing (two cards restored onto one chain, or
  // two machines that purged the same card): the total order picks, so the
  // choice does not depend on which root this loop meets first.
  const reach = (landing, root, P, from, rid) => {
    const entry = receiptFollowing(root, P, landing);
    const had = reached.get(landing);
    if (!had || pickBinEntry(landing, had.entry, entry) === entry) reached.set(landing, { entry, root, from, rid });
  };
  for (const k of allIds) {
    const P = purgeOf(k);
    if (!P) continue;
    const seen = new Set([k]);
    // [card, the rid of the restore of k its chain began with]. A copy is the
    // purge working only while it holds k's own bytes — the ones that first
    // restore put back. Down the chain, a landing restored from an edit of the
    // card holds news the purging machine never saw, and is reported.
    const queue = [[k, null]];
    while (queue.length && seen.size <= ROUTE_STEPS) {
      const [x, first] = queue.shift();
      for (const S of [O, T, B]) {
        const r = eOf(S, x);
        if (!r || entryKind(r.meta) !== 'R' || seen.has(String(r.meta.restoredAs))) continue;
        const y = String(r.meta.restoredAs);
        const rid = first ?? receiptIdentity(x, r.meta, r.json);
        seen.add(y);
        queue.push([y, rid]);
        reach(y, k, P, k, rid);
      }
    }
  }
  // A receipt an earlier merge derived travels on its own once the restore
  // receipt it followed has been replaced: re-derive it from the purge that
  // wins now (see eOf).
  for (const S of [O, T, B]) for (const [y, e] of Object.entries(S?.graveyard || {})) {
    const root = e?.meta?.purgedWith;
    if (typeof root !== 'string' || e.json == null) continue;
    const P = purgeOf(root);
    if (P) reach(y, root, P, null, null);
  }
  // A conflict twin of a reached landing holding exactly the bytes the
  // restore put back is the purged card too: a rescue of an older text took
  // the landing's id and the restored bytes went to a twin beside it (N8),
  // so killing the landing alone left the very text the purge was for on the
  // board. The purge takes that twin, under a receipt derived the same way.
  // Every side holding the twin must hold those bytes; a twin holding
  // anything else is someone's text and stays (see the note above). A twin an
  // earlier merge reached already travels under its derived receipt; knowing
  // the bytes lets its copies be judged as the landing's are. A twin no side
  // holds live is judged by the bytes its Deleted-cards entries hold: deleted
  // holding the restored bytes, it kept the very text the purge was for in
  // every copy's bin, for anyone to restore (review round 4).
  // The purged card can ITSELF be a restore's landing: a person restored k
  // (it landed at k′), deleted that card again and purged it. On another
  // machine the same deletion was restored too, and landed as a copy beside
  // k′ because an edit the deleter never saw had taken the id (the very case
  // above, with the purge made one step later). No receipt chain leads from
  // k′ to that copy: the purge of k′ took the edit living at k′ and left the
  // restored bytes — the text the purge was for — live in the copy
  // (certifying soak, seed 98843). So a purged id that a restore receipt
  // names as its landing stands for that restore here: a twin of it holding
  // exactly the bytes that restore put back is the purged card.
  //   • Never a twin the purging side itself holds — live, or deleted in its
  //     own Deleted cards (any full entry there, whatever its bytes): its
  //     person usually had that card in front of them and kept it, or
  //     deleted it without purging it. Not always: the other machine's
  //     deleted copy can reach the purger's bin by sync before the purge, and
  //     then the purger meant exactly that text; the merge cannot tell the
  //     two apart, and the text stays restorable there (a LIMIT, below).
  //   • Under 'unverified' a foreign receipt widens nothing: only ours and
  //     the base's are read.
  // What this reach takes with the twin: its Deleted-cards entry too, when
  // no side holds it live and every entry holds those bytes (the purged text
  // must not stay restorable); and a twin of the purged id that someone typed
  // independently with exactly the same bytes (indistinguishable).
  // LIMITS (pinned: the mirror, the chain and a resized copy by K15L; a copy
  // the purging side holds by K15d and K15h; the copy of a copy by none):
  // the purge does not follow the restore any further than that twin. It
  // does not reach
  //   - the other machine's restore when the purged card was itself the COPY
  //     (the other restore is then the card);
  //   - the other machine's copy of an EARLIER restore, when the purged card
  //     was restored, deleted and restored again (the older walk reaches the
  //     landings DOWN a receipt chain from the purged id, not the other
  //     copies of the restores above it);
  //   - a copy of a copy (the slot beside the card held other text when the
  //     restore landed), or a purged card that is itself such a copy;
  //   - a copy that was resized or edited since;
  //   - a copy the purging side itself holds, live or in its own Deleted
  //     cards (whatever bytes that entry holds): the text then stays on every
  //     machine, not only on the other one, and stays restorable where it is
  //     deleted.
  // A wider reach that walked the receipts was tried and withdrawn (review
  // 10): what it reached depended on which of two restore receipts had kept
  // the bin's one slot. Closing these needs a durable mark on the purge
  // itself (Stage 3).
  const ownsPurge = (S, k) => { const e = S?.graveyard?.[k]; return !!e && entryKind(e.meta) === 'P'; };
  const rootRestores = new Map();    // a purged landing -> [{ root, from, rid }] of the restores that landed there
  for (const S of (unverified ? [O, B] : [O, T, B])) for (const [x, e] of Object.entries(S?.graveyard || {})) {
    if (!e || entryKind(e.meta) !== 'R') continue;
    const k = String(e.meta.restoredAs);
    if (!purgeOf(k)) continue;
    const rid = receiptIdentity(x, e.meta, e.json);
    const list = rootRestores.get(k) || rootRestores.set(k, []).get(k);
    if (!list.some((c) => c.from === x && c.rid === rid)) list.push({ root: k, from: x, rid });
  }
  for (const list of rootRestores.values()) list.sort((p, q) => (`${p.from}\n${p.rid}` < `${q.from}\n${q.rid}` ? -1 : 1));
  const reachedTwins = [];
  for (const x of new Set([...O.ids, ...T.ids, ...Object.keys(O.graveyard), ...Object.keys(T.graveyard)])) {
    const parent = TWIN_PARENT_RE.exec(x)?.[1];
    if (!parent || reached.get(x)?.rid) continue;
    const liveCopies = [O, T].filter((S) => live(S, x)).map((S) => S.items[x]);
    const copies = liveCopies.length ? liveCopies
      : [O, T].map((S) => eOf(S, x)).filter((e) => e && entryKind(e.meta) === 'F').map((e) => e.json);
    if (!copies.length) continue;
    const reachedVia = reached.get(parent);
    // ...kept: the purging side holds this twin live, or holds it deleted in
    // its OWN Deleted cards (a full entry: it deleted the copy, it did not
    // purge it — that text is restorable and nobody purged it; replaced by a
    // derived purge receipt it was on no card and in no bin, and nothing was
    // said: review 11, M1).
    const ownsFullEntry = (S) => { const e = S?.graveyard?.[x]; return !!e && entryKind(e.meta) === 'F'; };
    const keptByPurger = (root) => [O, T].some((S) => ownsPurge(S, root) && (live(S, x) || ownsFullEntry(S)));
    const via = [...(reachedVia?.rid ? [reachedVia] : []), ...(rootRestores.get(parent) || []).filter((c) => !keptByPurger(c.root))]
      .find((c) => copies.every((v) => fullEntryRid(c.from, v) === c.rid));
    if (via) reachedTwins.push([x, via]);
  }
  for (const [x, via] of reachedTwins) {
    const had = reached.get(x);
    if (had && had.root === via.root) reached.set(x, { ...had, from: via.from, rid: via.rid });
    else reach(x, via.root, purgeOf(via.root), via.from, via.rid);
  }
  const eAll = (id) => maxEntry(id, [ownAll(id), reached.get(id)?.entry]);
  const eKill = (id) => maxEntry(id, [ownKill(id), reached.get(id)?.entry]);

  // A side that lacks a card only because it holds the card's base value under
  // the id the card moved from (a checkout of a file older than the move) has
  // not deleted it: that copy IS the card, and routing takes it there. Absence
  // alone made the tombstone; the side's own bin would say otherwise (a person
  // deleting the card leaves an entry, and a file old enough to hold the
  // earlier id holds no such entry). The chain is read in the base, where the
  // side last saw the card. EVERY side lacking the card must hold it so: a
  // side that lacks it and holds nothing deleted it, and a stale copy on the
  // other side (a cloud a stale upload rolled back) must not cancel that.
  const heldUnderEarlierId = new Set();
  if (B) {
    const holds = new Map();         // card id -> Set of sides ('O' | 'T') holding it under an earlier id
    const baseLanding = (k, v) => {
      const seen = new Set([k]);
      let t = k;
      for (let step = 0; step < ROUTE_STEPS; step++) {
        const e = eOf(B, t);
        if (!e) return null;
        const kind = entryKind(e.meta);
        if (kind === 'P') return null;
        t = kind === 'R' ? e.meta.restoredAs : sameMeaning(v, e.json) ? null : revivedIdFor(t, e.meta, e.json);
        if (!t || seen.has(t)) return null;
        seen.add(t);
        if (live(B, t)) return t;
      }
      return null;
    };
    for (const [S, side] of [[O, 'O'], [T, 'T']]) for (const k of S.ids) {
      if (!live(S, k) || live(B, k)) continue;
      const t = baseLanding(k, S.items[k]);
      if (t && !live(S, t) && !eOf(S, t) && sameMeaning(S.items[k], B.items[t])) (holds.get(t) || holds.set(t, new Set()).get(t)).add(side);
    }
    for (const [t, sides] of holds) {
      if ((live(O, t) || sides.has('O')) && (live(T, t) || sides.has('T'))) heldUnderEarlierId.add(t);
    }
  }
  for (const id of allIds) {
    const lo = live(O, id), lt = live(T, id);
    if (del.has(id) && !heldUnderEarlierId.has(id)) {
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

  // A purge that reaches a restore reaches the landing's own bin entry too.
  // The person who restored the card may have typed into it and then deleted
  // it: that text sits in their Deleted cards, restorable, and the receipt the
  // purge derives for the landing replaces it. It goes (P-a: the purge takes
  // the purged text and every copy built on it), but the purging machine
  // never saw that text, and the person who typed it would lose it with
  // nobody told — so it is reported and counted, like an edited landing still
  // on the board. An entry holding exactly the bytes the restore put back is
  // the purge working. Only an entry a side still holds counts: one only the
  // base holds was taken by an earlier merge, which said so then.
  let binEditsPurged = 0;
  for (const [y, via] of reached) {
    if (fate.get(y)?.entry !== via.entry) continue;
    const typedInto = [O, T].some((S) => {
      const F = live(S, y) ? null : eOf(S, y);
      return !!F && entryKind(F.meta) === 'F' && !(via.rid && fullEntryRid(via.from, F.json) === via.rid);
    });
    if (!typedInto) continue;
    conflicts.push({ id: y, kind: 'purge-vs-edit', side: 'bin', purgedWith: via.root }); binEditsPurged++;
  }

  // ── Pass B: routing ───────────────────────────────────────────────────────
  const landed = new Set();
  // A card a moved value folded onto holds THAT value after this merge, and
  // only that: the text it replaced is gone from it. Every later question
  // "does x hold v" must hear so. Read from the sides' copies, a folded card
  // still "held" the text the fold had just replaced: a second value arrived
  // at it and was on no card (the merge refused itself, E-13), and a conflict
  // was kept "in" a twin a fold had rewritten, its text then on no card, in
  // no twin and in no bin (review 8, S1 and S2; both older than the fold's
  // step up to the card a landing stands beside).
  const folded = new Map();          // landing id -> the move whose value it takes
  const liveValuesAt = (x) => {
    if (!fate.get(x)?.alive) return [];
    const fold = folded.get(x);
    if (fold) return [fold.v];
    const out = [];
    if (live(O, x)) out.push(O.items[x]);
    if (live(T, x)) out.push(T.items[x]);
    return out;
  };
  const twins = makeTwinPlacer({
    seedIds: [...O.ids, ...T.ids],
    liveValues: liveValuesAt,
    // What a twin holds after this merge: both copies equal → that value;
    // one side changed it since the base → that side's; both did, or nothing
    // says → both stay live somewhere.
    keptValues: (x) => {
      if (!fate.get(x)?.alive) return [];
      if (folded.has(x)) return [folded.get(x).v];
      const lo = live(O, x), lt = live(T, x);
      if (lo && lt && !sameMeaning(O.items[x], T.items[x])) {
        const bx = baseItem(x);
        // (theirs unverified: its one-sided change is not taken on trust,
        // so both stay; ours' one-sided change stands in both trust modes.)
        if (bx && !unverified && sameMeaning(O.items[x], bx)) return [T.items[x]];
        if (bx && sameMeaning(T.items[x], bx)) return [O.items[x]];
        return [O.items[x], T.items[x]];
      }
      return lo ? [O.items[x]] : lt ? [T.items[x]] : [];
    },
    heldAtBase: (x, v) => !!B && B.items[x] != null && sameMeaning(B.items[x], v),
    saysElseThere: (x, v, side) => { const S = side === 'ours' ? O : T; return live(S, x) && !sameMeaning(S.items[x], v); },
    rewrittenHere: (x) => folded.has(x),
    slotState: (x) => {
      const f = fate.get(x);
      if (!f) return 'free';
      if (f.alive) return 'alive';
      return (live(O, x) || live(T, x)) ? 'dying' : 'dead';
    },
    // A twin a person deleted since the base, holding this very value: the
    // conflict was resolved by deleting it (critic A §8). Never in union mode.
    // The resolution is the OTHER side's — the side that kept its own text on
    // the card. A side that buried the twin while holding this very value on
    // the card itself (a history restore that put it back there) did not
    // reject it, and suppressing it would lose it (KLYPIX soak, seed 60466).
    suppressDeleted: (x, v, side) => {
      const e = fate.get(x)?.entry;
      if (!e || entryKind(e.meta) !== 'F' || !sameMeaning(e.json, v) || eOf(B, x)) return false;
      if (side === 'theirs') return !!eOf(O, x);
      if (side === 'ours') return !!eOf(T, x);
      return !!(eOf(O, x) || eOf(T, x));
    },
  });
  // A restore receipt names the bytes it put back (its rid is the identity of
  // the deletion it undid, minted from those bytes), so a copy of the card it
  // landed on can be checked against them: card id -> [deleted id, rid].
  const restoredBytes = new Map();
  const restoredHere = new Map([[O, new Set()], [T, new Set()]]);   // side -> the cards its OWN bin says it restored
  for (const S of [O, T, B]) for (const [d, e] of Object.entries(S?.graveyard || {})) {
    const at = e?.meta && entryKind(e.meta) === 'R' ? e.meta.restoredAs : null;
    if (typeof at !== 'string' || typeof e.meta.rid !== 'string') continue;
    (restoredBytes.get(at) || restoredBytes.set(at, []).get(at)).push([d, e.meta.rid]);
    restoredHere.get(S)?.add(at);
  }
  const asRestored = (id, v) => (restoredBytes.get(id) || []).some(([d, rid]) => fullEntryRid(d, v) === rid);
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
  // A moved value NEVER overwrites a live card holding something it has not
  // seen (the draft's p8a fold lost a sibling's edit that way): it matches the
  // card or one of its twins, or it becomes a new deterministic twin. One case
  // is no conflict at all: the landing, on the other side, still holds exactly
  // the value this side's edit was made on (its base value of the id it moves
  // from), and this side either does not hold the landing or holds that same
  // value there (it met the revival too, and only its old copy carries the
  // edit). The edit then lands on the card, as a one-sided change does in the
  // 3-way — twinning it left an edit of the card's own text beside it (the
  // KLYPIX soak's I9: an edit of a card a sync had meanwhile revived or a
  // person restored). Never over other text of this side's own at the landing,
  // and never from foreign bytes.
  // A card a moved value ARRIVED at because it already holds that value must
  // keep holding it: a later move of this merge never folds over it (two old
  // ids routed to one card, one carrying the card's text and one an edit of
  // it: the fold displaced the text the first had just been matched to, and
  // the merge refused itself, E-13 - review 8, S2).
  // (A twin of that card holding the same value may still take a fold: if
  // the card then loses the value in the content pass, the value is placed
  // as a routed one there — `arrivedWith` — whichever order the moves ran in.
  // Holding those twins too blocked correct folds and only worked in one
  // order: review 11 S1, review 12.)
  const heldFor = new Set();
  const arriveAtHolder = (mv, x) => { heldFor.add(x); return arrive(mv, x); };
  const landIntoAlive = (mv, t) => {
    if (twins.holds(t, mv.v)) return arriveAtHolder(mv, t);
    for (const x of twins.twinsOf(t)) if (twins.holds(x, mv.v)) return arriveAtHolder(mv, x);
    const other = mv.side === 'ours' ? T : O;
    // What this side's copy was made on: the id's value at the base, and only
    // that. When the base holds the id deleted, its bin bytes are what the
    // deleter last held, not what this copy was typed into: a tab with no
    // watcher, or an old tool, can carry an older text than the one deleted.
    // Folding onto a landing that still holds those bytes would put this edit
    // over a version nobody here saw it replace, and that version would then
    // be live nowhere and in no bin. Without a base value the edit stays a
    // twin beside the landing: both texts kept.
    const madeOn = baseItem(mv.from);
    // Only onto a card the other side already held — never onto a value this
    // merge landed a moment ago (that value would then be lost, E-13).
    const takes = (x) => !unverified && madeOn != null && !landed.has(x) && !heldFor.has(x) && (!live(mv.S, x) || sameMeaning(mv.S.items[x], madeOn)) && live(other, x) && !folded.has(x) && sameMeaning(other.items[x], madeOn);
    // The landing can itself be a conflict COPY. A restore that finds the
    // card's revival live (an edit the deleter never saw came back first)
    // lands beside it, and the restore's receipt names that copy. An edit of
    // the old id made on the text the revival holds then belongs on the
    // revival: routed to the receipt's landing alone, it ended as a copy of
    // the restore's copy, beside the very text it was typed on (certifying
    // soak, seed 98381: card v6, restored copy v2, the edit v6 → v8 a copy of
    // the copy). So when the landing does not take the value, the card it
    // stands beside is asked the same two questions: does it already hold
    // the value (another machine's merge put it there), and would the edit
    // land on it as a one-sided change. One step up only; the same guards.
    const beside = TWIN_PARENT_RE.exec(t)?.[1] ?? null;
    const besideAlive = !!beside && !!fate.get(beside)?.alive;
    // "Already holds the value" counts only if the card still does once the
    // content pass has decided it: a side's copy the other side edited away,
    // or one a new-on-both-sides rule other than 'twin' drops, is no home
    // (the value then stays a copy beside the landing, as before).
    const willHold = (x) => {
      if (!twins.holds(x, mv.v)) return false;
      if (folded.has(x) || !live(O, x) || !live(T, x) || sameMeaning(O.items[x], T.items[x])) return true;
      // The two sides show different texts there. Only a one-sided change is
      // decided here; where both changed, or nothing says who did, the
      // content pass keeps one on the card and looks for a home for the
      // other — which may be "a twin someone edited since" (no home at all:
      // review 9, M3, the merge refused itself). The value then stays a copy
      // beside its landing, as it did before the step up.
      const bx = baseItem(x);
      if (!bx || unverified) return false;
      if (sameMeaning(O.items[x], bx)) return sameMeaning(T.items[x], mv.v);
      if (sameMeaning(T.items[x], bx)) return sameMeaning(O.items[x], mv.v);
      return false;
    };
    if (!takes(t) && besideAlive && willHold(beside)) return arriveAtHolder(mv, beside);
    const at = takes(t) ? t : (besideAlive && takes(beside) ? beside : null);
    if (at) {
      // The landing's text goes, as the text an edit replaces always does —
      // but when a RESTORE put it there, the bin holds only that restore's
      // content-free receipt, so this is its last copy. The merge cannot tell
      // an edit typed onto it from a version history restore that put an
      // OLDER text back on this side's card (both read as "my base held that
      // value, I hold this one"), and in the second case the restored text
      // ends up live nowhere and in no bin. Whichever it is, the merge
      // reports it, and the person who restored the card keeps it in their
      // restore point (the app takes one on this report, as it does for a
      // purged edit; no desktop surface shows the report itself yet).
      // Found by the certifying soak, seed 93325; before this it was silent.
      // ...unless those bytes are still recoverable: a bin entry somewhere in
      // this merge holds them — the restore's own entry survived because a
      // side still held it, say, or ANOTHER card's entry holds the same text
      // (a conflict copy a history restore buried: soak seed 100383). Then
      // nothing is at stake and nothing is said.
      const displaced = other.items[at];
      if (asRestored(at, displaced) && ![...fate.values()].some((f) => f.entry && entryKind(f.entry.meta) === 'F' && sameMeaning(f.entry.json, displaced))) {
        conflicts.push({ id: at, kind: 'fold-over-restore', keptLive: mv.side, from: mv.from, side: mv.side, restored: displaced });
      }
      folded.set(at, mv);
      return arrive(mv, at);
    }
    const r = twins.place(t, mv.v, mv.S.positions[mv.from] || O.positions[t] || T.positions[t], mv.side, false, true);
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
  // Every content twin holds theirs' text (ours stays live on the card).
  // A value a move of this merge ARRIVED with at k (it matched what k holds
  // on one side), which then loses k's content decision, is placed as a
  // routed value: a slot merely taken by other text is no proof anyone saw
  // it. Whether a fold of the same merge had already taken the twin that
  // also held it depends on the order the moves run in; counted as seen, the
  // value was on no card and the merge refused itself in one orientation
  // (review 12: K14m with the carrier routed after the fold).
  const arrivedWith = (k, v) => delta.revived.some((r) => r.as === k && moves.some((m) => m.from === r.id && m.side === r.side && sameMeaning(m.v, v)));
  const twinOf = (k, v, srcPos, kind) => conflicts.push({ id: k, kind, keptLive: 'ours', ...twins.place(k, v, srcPos, 'theirs', true, arrivedWith(k, v)) });
  // E-1b: S holds a live twin of k whose value is `val` — the conflict was
  // already resolved on S's side, with `val` kept beside the card.
  // (A twin a moved value folded onto holds that value now, not S's: adopting
  // "their twin holds our text" over it left our text nowhere — review 9, M2.)
  const liveTwinHolding = (S, k, val) =>
    twins.twinsOf(k).find((x) => fate.get(x)?.alive && !folded.has(x) && live(S, x) && sameMeaning(S.items[x], val)) ?? null;
  // ...and that twin still holds `val` after this merge: the other side lacks
  // it or holds the same there, and no moved value lands on it.
  const keptBeside = (S, other, k, val) =>
    twins.twinsOf(k).find((x) => fate.get(x)?.alive && !folded.has(x) && !landed.has(x) && live(S, x) && sameMeaning(S.items[x], val)
      && (!live(other, x) || sameMeaning(other.items[x], val))) ?? null;
  // The other side's text is an edit of the restored bytes only when that
  // side restored the card itself: a rescue of an older text lands on the
  // very id a restore of that deletion uses (both come from revivedIdFor), and
  // a machine with no receipt for it holds a stale value, not an edit. Nor
  // when a value this merge moved has arrived there (landed, or matched the
  // copy holding the restored bytes): replacing that copy loses it.
  const arrivedAt = new Set(delta.revived.map((r) => r.as));
  const editsItsRestore = (id) => {
    if (arrivedAt.has(id)) return false;
    const o = asRestored(id, O.items[id]), t = asRestored(id, T.items[id]);
    return o !== t && restoredHere.get(o ? T : O).has(id);
  };
  for (const [id, f] of fate) {
    if (!f.alive) continue;
    const inO = live(O, id), inT = live(T, id);
    if (!inO && !inT) continue;
    const cb = baseItem(id);
    const srcPos = T.positions[id] || O.positions[id];
    let json, side;
    const fold = folded.get(id);
    if (fold) {
      json = fold.v; side = fold.side;
      if (side === 'theirs') delta.updated.push(id);
    } else if (inO && inT) {
      const oChg = !cb || !sameMeaning(O.items[id], cb);
      const tChg = !cb || !sameMeaning(T.items[id], cb);
      const diverged = !sameMeaning(O.items[id], T.items[id]);
      // A text of this card that a twin beside it holds too (on either side,
      // and still after this merge) is safe wherever the card goes.
      const besideO = diverged && !unverified && (keptBeside(T, O, id, O.items[id]) || keptBeside(O, T, id, O.items[id]));
      const besideT = diverged && !unverified && (keptBeside(O, T, id, T.items[id]) || keptBeside(T, O, id, T.items[id]));
      // The two sides show different texts on the card, and a conflict twin
      // beside it already holds one of them, or each. Then which text shows on
      // the card is decided from the texts and the twins alone — the same on
      // every machine, in both transports, whatever the base says:
      //   • both texts stand in twins: one of the two, by the texts alone
      //     (nothing is at stake whichever shows);
      //   • one of them stands in a twin: the OTHER stays on the card — it is
      //     the text nothing else holds, and a card settling on its own
      //     twin's text would leave that one in no copy at all.
      // Left to the base and to "ours", git and Brain Sync each settled it
      // their own way (one saw a conflict, the other a one-sided change), the
      // repo and the cloud held opposite cards, and the machines swapped them
      // on every round, for ever (review round 3; 59 of 600 fleets).
      //
      // What this costs is one act: changing a card to say exactly what its
      // live conflict twin says does not stick while the twin lives — the
      // text it replaced comes back on the card. To the merge that act and a
      // transport handing the twin's text round again are the same input
      // (review round 5), so the act has to be made visible another way: the
      // desktop buries the twin in the same save (its settledTwinsOf), which
      // IS the person saying "I take that version", and then no rule fires.
      // Any other writer is told: the refused change is reported
      // (`change-held-in-twin`), never silent, and both texts stay on the
      // board — the card's, and the twin's.
      const bothBeside = besideO && besideT;
      if (besideO || besideT) {
        const oursStays = bothBeside ? canonicalFirst(itemSignature(O.items[id]), itemSignature(T.items[id])) : besideT;
        // A change one side alone made to the card, which the plain 3-way
        // would have taken, and which this keeps off the card. With no base
        // nothing says who changed what: the side whose text is not on the
        // card is told, as ever (its text is in the twin).
        const refused = cb ? (oursStays ? (tChg && !oChg) : (oChg && !tChg)) : true;
        if (oursStays) {
          json = O.items[id]; side = 'ours';
          // Both sides changed it and theirs' text was already in a twin: a
          // conflict settled without a new twin — reported, as the mirror
          // case (theirs on the card, ours in its twin) is.
          if (cb && oChg && tChg && !refused) conflicts.push({ id, kind: 'content', keptLive: 'ours', twin: keptBeside(O, T, id, T.items[id]) ?? keptBeside(T, O, id, T.items[id]), existing: true });
        } else {
          json = T.items[id]; side = 'theirs'; delta.updated.push(id);
          // E-1b's report: the driver names a conflict it took as settled elsewhere.
          if (opt.adoptResolvedConflicts && cb && oChg && tChg && !besideT) conflicts.push({ id, kind: 'content', keptLive: 'theirs', twin: liveTwinHolding(T, id, O.items[id]) ?? liveTwinHolding(O, id, O.items[id]), adopted: true });
        }
        if (refused) {
          const lost = oursStays ? T.items[id] : O.items[id];
          conflicts.push({
            id, kind: 'change-held-in-twin', keptLive: oursStays ? 'ours' : 'theirs', refused: oursStays ? 'theirs' : 'ours',
            twin: keptBeside(O, T, id, lost) ?? keptBeside(T, O, id, lost), existing: true,
          });
        }
      } else if (cb && oChg && tChg && diverged) {
        // E-1b: theirs already resolved this very conflict the other way round
        // (its twin holds our text) and ours has not — adopt that resolution
        // instead of twinning a second time. Both texts stay live.
        const adoptTwin0 = opt.adoptResolvedConflicts ? liveTwinHolding(T, id, O.items[id]) : null;
        // ...and only if this merge leaves our text in that twin: ours did not change the twin since.
        const adoptTwin = adoptTwin0 && (!live(O, adoptTwin0) || sameMeaning(O.items[adoptTwin0], T.items[adoptTwin0])) ? adoptTwin0 : null;
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
      } else if (!cb && diverged && B && !unverified && editsItsRestore(id)) {
        // One restore made on both sides — the same deletion, so the same id —
        // is new on both since the base, yet its receipt names the bytes it
        // came back with: the side still holding them has not touched the
        // card, so the other side's text is an edit of it, not a conflict.
        // (With no base, both are kept as ever: such a copy may be a revert.)
        if (asRestored(id, O.items[id])) { json = T.items[id]; side = 'theirs'; delta.updated.push(id); }
        else { json = O.items[id]; side = 'ours'; }
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
      } else if (!diverged && !unverified) {
        // One card: the copies differ in volatile and reading fields at most.
        // The one with the current reading is written (pickReadingCopy),
        // decided from the copies and the base alone — never "ours", or git
        // and Brain Sync would hand two readings back and forth. Foreign bytes
        // (unverified) never replace our card, so there ours stays.
        side = pickReadingCopy(O.items[id], T.items[id], cb);
        json = side === 'ours' ? O.items[id] : T.items[id];
        if (side === 'theirs') delta.updated.push(id);
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
      const r = descendantPosition(O, T, B, id, true);
      pos = r.pos;
      if (side === 'theirs' && r.tParentChg && ARCHIVE.test(parentTitle(T, r.tP))) delta.archived.push(id);
    }
    merged.set(id, { json, pos });
  }

  // A conflict twin a person SETTLED (the desktop buried it because its card
  // had been made to say what it held: receipt cause conflict-settled) whose
  // settle this merge undoes: the settling side's base predated the conflict
  // (the twin came by the other transport, or a base write failed), so its
  // choice read as "unchanged", the other side's text as a one-sided change,
  // and the card goes back to it — the chosen text is then in Deleted cards
  // only. That is SAID (`settle-undone`), never silent (review round 6); the
  // merge itself is unchanged. `keptLive` names the side whose text the card
  // keeps: the OTHER side settled (the caller words it by direction — on the
  // side that never settled, the card does not change). Said only by the
  // merge that buries the copy (it was live on the other side), and only
  // while the settling side — the one that holds the receipt and no live
  // copy — still shows the settled text: a card its person edited on since
  // is not a settle undone, whatever the other side's card says.
  // NOT said: when the side that never settled merges first, the settling
  // machine later receives the other text as an ordinary one-sided change
  // (the copy is live on neither side by then, and one merge cannot tell it
  // from a later edit). STILL OPEN, with the edit counter (Stage 3).
  for (const [x, f] of fate) {
    if (f.alive || !f.wasLive || !f.entry || entryKind(f.entry.meta) !== 'F' || f.entry.meta?.deletion?.cause !== 'conflict-settled') continue;
    const k = TWIN_PARENT_RE.exec(x)?.[1];
    const card = k ? merged.get(k) : null;
    if (!card || sameMeaning(card.json, f.entry.json)) continue;
    const settler = [[O, 'ours'], [T, 'theirs']].find(([S]) => !live(S, x) && eOf(S, x)?.meta?.deletion?.cause === 'conflict-settled' && live(S, k) && sameMeaning(S.items[k], f.entry.json));
    if (settler) conflicts.push({ id: k, kind: 'settle-undone', keptLive: settler[1] === 'ours' ? 'theirs' : 'ours', twin: x, existing: true });
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
    // A value that matched its landing, where the landing held that very value
    // at the base and the merge keeps an edit made on top of it: a stale copy,
    // superseded by someone who saw it (an old machine put the old id back
    // after the card was restored and then edited).
    const supersededAt = (as, v) => resultIds.has(as) && baseItem(as) != null && sameMeaning(baseItem(as), v);
    for (const mv of moves) {
      const key = `${mv.side}\n${mv.from}`;
      if (arrived.has(key) && (liveAt(arrived.get(key), mv.v) || supersededAt(arrived.get(key), mv.v))) continue;
      const d = chainDrop.get(key);
      if (d && (d.kind === 'P' || binHolds(d.at, mv.v))) continue;
      throw new Error(`mergeBrains INVARIANT VIOLATED — a moved value of ${mv.from} is neither live nor in the bin`);
    }
    for (const d of drops) {
      if (d.chain || d.kind === 'P') continue;
      if (!binHolds(d.at, d.v)) throw new Error(`mergeBrains INVARIANT VIOLATED — dropped ${d.from} without its bytes in the bin`);
    }
  };

  // Every copy a purge dropped: live copies, and the edits it took from a bin.
  const purgedCopies = drops.filter((d) => d.kind === 'P').length + binEditsPurged;
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

  // ── Order + zKey heal: one order whichever side is ours (canonicalZOrder) ──
  const listed = [...T.order, ...O.order, ...extras.map(e => e.id), ...merged.keys()].filter((id) => merged.has(id));
  const { order, keyOf } = canonicalZOrder(listed, (id) => merged.get(id).pos);
  order.forEach((id, i) => {
    const rec = merged.get(id);
    rec.pos = { ...rec.pos, zKey: keyOf(id), zIndex: i };
  });

  // ── Union connections / lines / strokes by id; drop dangling connections ──
  const byId = (arr) => { const m = new Map(); for (const x of arr) if (x && x.id) m.set(x.id, x); return m; };
  // The option modes write arrows, lines and strokes in id order. Theirs-first
  // (theirs' ids, then ours-only) is a different array on every machine: with
  // git and Brain Sync on one brain each rewrote the file the other wrote, on
  // every round, after each machine had drawn ONE new arrow (review round 6).
  const inIdOrder = (xs) => (opt.binMerge !== 'union' ? xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : xs);
  const liveIds = new Set(order);
  const tConn = byId(T.connections);
  const connMap = new Map(tConn);
  // Ours wins an edge both sides hold — not when ours still points at a card
  // this merge removed while theirs already points at cards that live. A
  // revival re-points the edges of the side it came from, and an arrange
  // re-points a buried duplicate's edges onto its survivor; the other side's
  // copy of the edge still names the old card. Taking ours, the dangling
  // filter below dropped the edge: in Brain Sync the other machine put it
  // back a round later, and the app save (union), which tombstones the tab's
  // stale copy of a card the disk moved, lost it for good. Ours' copy dangles
  // there whatever we pick, so in union mode this only keeps an edge 1.86.3
  // dropped.
  const endsLive = (c) => liveIds.has(c.fromId) && liveIds.has(c.toId);
  for (const [id, c] of byId(O.connections)) {
    const t = tConn.get(id);
    connMap.set(id, t && !endsLive(c) && endsLive(t) ? t : c);
  }
  // The option modes, with a base and bytes whose ancestry is known: an
  // arrow both sides and the base hold is decided 3-way — a change made on one
  // side wins wherever it was made, and one both sides changed is picked from
  // the two values alone (pickThreeWay). Ours-first lost the other branch's
  // relabel in a git merge, and kept each machine's own label on its machine.
  // Never a value that would dangle (a revival re-points only its own side).
  const threeWay = opt.binMerge !== 'union' && !!B && opt.theirsTrust !== 'unverified';
  const pickById = (key) => {
    const o = byId(O[key]), t = byId(T[key]), b = byId(B[key]);
    const out = new Map();
    // (An id the base never held is new on both sides: a tie, like any other.)
    for (const [id, ov] of o) if (t.has(id)) out.set(id, pickThreeWay(ov, t.get(id), b.get(id)));
    return out;
  };
  if (threeWay) for (const [id, v] of pickById('connections')) if (endsLive(v)) connMap.set(id, v);
  // And an end a move retired follows its card to where it went, whichever
  // side moved it: the two ends of one edge can move on different sides (each
  // side re-points only its own copy), and then neither copy pointed at both
  // live cards and the edge was dropped (found on a copy of the real brain).
  const movedTo = new Map();
  if (opt.binMerge !== 'union') {
    for (const r of run.delta?.revived || []) if (!movedTo.has(r.id) && liveIds.has(r.as)) movedTo.set(r.id, r.as);
    if (movedTo.size) for (const [id, c] of connMap) {
      const from = liveIds.has(c.fromId) ? c.fromId : (movedTo.get(c.fromId) ?? c.fromId);
      const to = liveIds.has(c.toId) ? c.toId : (movedTo.get(c.toId) ?? c.toId);
      if (from !== c.fromId || to !== c.toId) connMap.set(id, { ...c, fromId: from, toId: to });
    }
  }
  // Collapse EXACT duplicate edges (same endpoints + relationship + label,
  // different ids). Connection deletes have no tombstone, so an arrange/de-dup
  // that dropped a redundant edge in-app used to see it resurrected from disk
  // by this union — as a byte-identical twin arrow. Never meaningful to keep.
  const seenEdge = new Set();
  const connections = inIdOrder([...connMap.values()]).filter(c => {
    if (!(liveIds.has(c.fromId) && liveIds.has(c.toId))) return false;
    const k = `${c.fromId}|${c.toId}|${c.relationship || ''}|${c.label || ''}`;
    if (seenEdge.has(k)) return false;
    seenEdge.add(k);
    return true;
  });
  const unionById = (key) => {
    const m = new Map([...byId(T[key]), ...byId(O[key])]);
    if (threeWay) for (const [id, v] of pickById(key)) m.set(id, v);
    return inIdOrder([...m.values()]);
  };
  // A line or a stroke drawn inside a container that is not on the board
  // (deleted on the other side) is drawn nowhere, like a card: it follows a
  // container this merge moved, else goes to the top level.
  const onBoard = (d) => (d && d.parentId != null && !liveIds.has(d.parentId)) ? { ...d, parentId: movedTo.get(d.parentId) ?? null } : d;
  const lines = unionById('lines').map(onBoard);
  const strokes = unionById('strokes').map(onBoard);

  // ── Union assets by path (later sources win: theirs, then ours, over base).
  // Under 'unverified' our own bytes win over foreign ones.
  const assets = {};
  const assetSources = opt.theirsTrust === 'unverified' ? [B, T, O] : [B, O, T];
  for (const src of assetSources) if (src) for (const [p, bytes] of Object.entries(src.assets)) assets[p] = bytes;
  // The option modes, with a base: an embedded file keeps its path when it is
  // repacked, so one path can hold different bytes on the two sides. Decided
  // 3-way like an arrow — bytes one side alone changed win wherever that was,
  // and bytes both sides changed are picked from the two alone, and reported
  // (a file has no twin: the other version stays only in the other copy's
  // history). Theirs-first handed a file repacked on our side back to its old
  // bytes while its card, merged on its own, went on naming the new ones.
  if (threeWay) for (const [p, ob] of Object.entries(O.assets)) {
    const tb = T.assets[p], bb = B.assets[p];
    if (!tb || Buffer.compare(ob, tb) === 0) continue;
    if (bb && Buffer.compare(tb, bb) === 0) assets[p] = ob;
    else if (bb && Buffer.compare(ob, bb) === 0) assets[p] = tb;
    else {
      const ours = Buffer.compare(ob, tb) > 0;
      assets[p] = ours ? ob : tb;
      conflicts.push({ id: null, kind: 'asset', path: p, kept: ours ? 'ours' : 'theirs' });
    }
  }
  // With no base nothing says who repacked a file: the bytes are picked as
  // ever (theirs'; ours' when theirs is unverified) —
  // but SAID, so the machine whose bytes go keeps a restore point and the
  // driver's summary names it (a first sync replaced a repacked file with the
  // cloud's older bytes and told nobody).
  if (!B && opt.binMerge !== 'union') for (const [p, ob] of Object.entries(O.assets)) {
    const tb = T.assets[p];
    if (tb && Buffer.compare(ob, tb) !== 0) conflicts.push({ id: null, kind: 'asset', path: p, kept: Buffer.compare(assets[p], ob) === 0 ? 'ours' : 'theirs' });
  }

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

  // A card never keeps a container that is not on the board as its parent:
  // the board is drawn from the top level down, so such a card is in the file
  // and on no screen (one side moved it into a container the other side
  // deleted). It follows a container this merge moved to another id; else it
  // goes where the other side has it, if that container lives; else to the
  // top level.
  const positions = {};
  for (const id of order) {
    const pos = merged.get(id).pos;
    const pid = pos?.parentId ?? null;
    if (pid == null || liveIds.has(pid)) { positions[id] = pos; continue; }
    const other = movedTo.get(pid)
      ?? [O.positions[id]?.parentId, T.positions[id]?.parentId].find((x) => x != null && x !== pid && liveIds.has(x)) ?? null;
    positions[id] = { ...pos, parentId: other };
  }
  // Nor inside a loop of containers. Each side nested one group into the
  // other: two one-sided moves, so both win, and nothing in a loop is
  // reachable from the top level — the two groups left the board with
  // everything in them. A loop is opened at one member, picked from the ids
  // alone (the same on every machine): it goes to the top level, and the
  // other nesting stands.
  const reachesTop = new Set();
  for (const id of order) {
    const path = [], on = new Set();
    let cur = id;
    while (cur != null && !reachesTop.has(cur) && !on.has(cur)) { on.add(cur); path.push(cur); cur = positions[cur]?.parentId ?? null; }
    if (cur != null && on.has(cur)) {
      const open = path.slice(path.indexOf(cur)).sort()[0];
      positions[open] = { ...positions[open], parentId: null };
    }
    for (const x of path) reachesTop.add(x);
  }

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
    // changed it, one is kept and the other reported. With no base to tell,
    // theirs is taken, as for every other manifest field, and ours reported:
    // keeping ours, every machine that met the shared copy (Brain Sync's
    // cloud) without a base pushed its own title back over it, and the
    // copies took turns instead of converging.
    const tO = O.manifest?.title, tT = T.manifest?.title;
    if (tO !== undefined && tT !== undefined && tO !== tT) {
      const tB = B ? B.manifest?.title : undefined;
      if (!B) {
        manifest.title = tT;
        conflicts.push({ id: null, kind: 'title-no-base', kept: 'theirs', ours: tO, theirs: tT });
      } else if (tB === tO) manifest.title = tT;
      else if (tB === tT) manifest.title = tO;
      else {
        // Both renamed it, differently: one of the two by the names alone
        // (ours-first kept each machine's own title on its machine), and the
        // other reported.
        const ours = canonicalFirst(String(tO), String(tT));
        manifest.title = ours ? tO : tT;
        conflicts.push({ id: null, kind: 'title', kept: ours ? 'ours' : 'theirs', ours: tO, theirs: tT });
      }
    }
  }
  manifest.updatedAt = new Date(now).toISOString();
  manifest.stats = { ...(manifest.stats || {}), itemCount: order.length, assetCount: Object.keys(assets).length };
  zip.file('manifest.json', JSON.stringify(manifest));

  // Settings: ours over theirs, key by key; in the option modes a key all
  // three hold is decided 3-way like the arrows above.
  const settings = { ...(T.settings || {}), ...(O.settings || {}) };
  if (threeWay) {
    const [oS, tS, bS] = [O.settings || {}, T.settings || {}, B.settings || {}];
    // (A key the base never held is new on both sides: a tie, like any other.)
    for (const k of Object.keys(settings)) if (k in oS && k in tS) settings[k] = pickThreeWay(oS[k], tS[k], bS[k]);
  }
  const canvasJson = {
    version: 4,
    view: O.view || T.view || { panX: 0, panY: 0, zoom: 0.7 },   // human's viewport
    order, connections, lines, strokes,
    nextGroupNumber: Math.max(1, ...[O, T].map(s => Number(s.nextGroupNumber) || 1)),
    positions,
    settings,
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
 * restoreSnapshotAsMerge — put a restore point back WITHOUT replacing the file
 * (E-9). A whole-file restore made every card added since the snapshot vanish
 * with no receipt, so Brain Sync read it as deletes and a copy that still held
 * those cards brought them back or lost them depending on who synced first.
 * As a merge, the result is the snapshot's canvas, and:
 *   • a card live in both takes the snapshot's value (the restore still
 *     reverts edits — that is what a restore is for);
 *   • a card deleted since the snapshot comes back under the id its delete
 *     revives to (the chain the sync merge and the bin restore use), so the
 *     old id stays deleted everywhere; its entry becomes a restore receipt only
 *     when the snapshot's bytes are exactly the deleted ones, otherwise the
 *     newer deleted bytes stay in the bin, recoverable;
 *   • a card purged since stays out unless `includePurged` (a purge is the
 *     secret-was-pasted case; bringing it back must be deliberate);
 *   • a card live now but absent from the snapshot is BURIED with a receipt —
 *     recoverable, and a delete every other copy honours.
 * `reverted` lists the live ids whose value the restore changed (a card's
 * current incarnation included); `revived[].already` marks a card that was
 * back under that id before.
 * @returns {Promise<{buffer:Buffer, reverted:string[], restored:string[], revived:{id:string,as:string,already?:boolean}[], buried:string[], keptPurged:string[]}>}
 */
export async function restoreSnapshotAsMerge({
  current, snapshot,
  receipt = { initiator: 'user', cause: 'history-restore', source: 'klypix-mcp', confidence: 'explicit' },
  includePurged = false, now = Date.now(),
}) {
  const C = await loadSide(current);
  const S = await loadSide(snapshot);
  if (!C || !S) throw new Error('restoreSnapshotAsMerge: current and snapshot are both required');
  const liveIn = (side, id) => side.ids.has(id) && side.items[id] != null;
  // loadSide falls back to positions for a file whose order is empty.
  const sOrder = S.order.length ? S.order : [...S.ids];
  const cOrder = C.order.length ? C.order : [...C.ids];

  const idMap = new Map();          // snapshot id -> result id
  const values = new Map();         // result id -> item JSON
  const reverted = [], restored = [], revived = [], keptPurged = [];
  const bin = new Map(Object.entries(C.graveyard).map(([id, g]) => [id, { ...g }]));
  // A landing already taken in the result: the same meaning there is the same
  // card; anything else goes to the first usable twin slot, then a random id —
  // never over a value already placed. A slot is unusable when it holds another
  // value today (that would overwrite it) or has a deletion on record (every
  // other copy would delete the card again).
  const take = (id, v) => {
    if (!values.has(id)) { values.set(id, v); return id; }
    if (sameMeaning(values.get(id), v)) return id;
    for (let n = 0; n < TWIN_SLOTS; n++) {
      const at = twinIdFor(id, v, n);
      if (values.has(at)) { if (sameMeaning(values.get(at), v)) return at; continue; }
      if (C.graveyard[at] || (liveIn(C, at) && !sameMeaning(C.items[at], v))) continue;
      values.set(at, v);
      return at;
    }
    let at;
    do at = `${id}__agconf_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    while (values.has(at) || liveIn(C, at) || C.graveyard[at]);
    values.set(at, v);
    return at;
  };

  // Two passes. Cards that exist as themselves — live in both, or with no
  // trace today — hold their own ids first; only then do deleted-since cards
  // follow their chains, so a chain can never push a card off its own id.
  const deletedSince = [];
  for (const k of sOrder) {
    if (!liveIn(S, k)) continue;
    const vS = S.items[k];
    if (liveIn(C, k)) {
      if (!sameMeaning(C.items[k], vS)) reverted.push(k);
      idMap.set(k, take(k, vS));
    } else if (!C.graveyard[k]) {
      idMap.set(k, take(k, vS));
      restored.push(k);
    } else {
      deletedSince.push(k);
    }
  }
  for (const k of deletedSince) {
    const vS = S.items[k];
    const E = C.graveyard[k];
    // Deleted since: follow the chain to k's current incarnation or a free id.
    let at = k, purged = false, settled = false;
    for (let step = 0; step < ROUTE_STEPS; step++) {
      if (at !== k && liveIn(C, at)) { settled = true; break; }
      const e = C.graveyard[at];
      if (!e) { settled = true; break; }
      const kind = entryKind(e.meta);
      if (kind === 'P' && !includePurged) { purged = true; break; }
      at = kind === 'R' ? String(e.meta.restoredAs) : revivedIdFor(at, e.meta, e.json);
    }
    if (purged) { keptPurged.push(k); continue; }
    // A cycle, or a chain longer than any real history: the same value-derived
    // id the sync merge lands on, so the two agree.
    if (!settled) at = `${stripRevived(k)}__r_${sha12(`cycle\n${k}\n${itemSignature(vS)}`)}`;
    const landed = take(at, vS);
    idMap.set(k, landed);
    // `already`: the card was back under that id before this restore, which
    // only sets its value — and says so in `reverted` when that changed it.
    const already = liveIn(C, landed);
    if (already && !sameMeaning(C.items[landed], vS)) reverted.push(landed);
    revived.push({ id: k, as: landed, ...(already ? { already: true } : {}) });
    if (entryKind(E.meta) === 'F' && sameMeaning(vS, E.json)) {
      bin.set(k, { meta: contentFreeReceiptFor(k, E, { kind: 'restored', restoredAs: landed, now }), json: PURGED_BODY });
    }
  }

  // Cards live now that the result does not carry are buried, with a receipt.
  const buried = [];
  const resultIds = new Set(values.keys());
  for (const id of cOrder) {
    if (!liveIn(C, id) || resultIds.has(id)) continue;
    const pos = C.positions[id] || null;
    bin.set(id, binEntryFor({ id, json: C.items[id], pos, area: C.titleById.get(pos?.parentId) || null, receipt, now }));
    buried.push(id);
  }
  // The snapshot's own entries fill ids today's copy has no record of.
  for (const [id, g] of Object.entries(S.graveyard)) {
    if (!bin.has(id) && !liveIn(C, id) && !resultIds.has(id)) bin.set(id, g);
  }

  // Canvas from the snapshot, re-pointed through the id map.
  const mapId = (id) => (id == null ? null : (idMap.get(id) ?? (resultIds.has(id) ? id : null)));
  const restoredIds = [];
  const sourceOf = new Map();       // result id -> the snapshot id it came from
  for (const k of sOrder) {
    const r = idMap.get(k);
    if (r && !sourceOf.has(r)) { sourceOf.set(r, k); restoredIds.push(r); }
  }
  // The same order a merge writes (canonicalZOrder), so the first sync after a
  // restore does not rewrite the file only to reorder it.
  const { order, keyOf } = canonicalZOrder(restoredIds, (r) => S.positions[sourceOf.get(r)]);
  const positions = {};
  order.forEach((r, i) => {
    const p = S.positions[sourceOf.get(r)] || {};
    positions[r] = { ...p, parentId: mapId(p.parentId ?? null), zKey: keyOf(r), zIndex: i };
  });
  const live = new Set(order);
  const seenEdge = new Set();
  const connections = [];
  for (const c of S.connections) {
    const fromId = mapId(c.fromId), toId = mapId(c.toId);
    if (!live.has(fromId) || !live.has(toId)) continue;
    const key = `${fromId}|${toId}|${c.relationship || ''}|${c.label || ''}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    connections.push({ ...c, fromId, toId });
  }

  const zip = new JSZip();
  for (const r of order) zip.file(`items/${shard(r)}/${r}.json`, values.get(r));
  const assets = { ...C.assets, ...S.assets };
  for (const [p, bytes] of Object.entries(assets)) zip.file(p, bytes);
  const entries = {};
  for (const [id, g] of bin) {
    if (live.has(id) || g?.json == null) continue;
    zip.file(`graveyard/${shard(id)}/${id}.json`, g.json);
    entries[id] = g.meta || {};
  }
  if (Object.keys(entries).length) zip.file('graveyard.json', JSON.stringify({ version: 1, entries }));
  const manifest = { format: 'klypix', version: 4, ...(S.manifest || {}) };
  for (const key of ['cloud', 'kind']) if (C.manifest?.[key] !== undefined) manifest[key] = C.manifest[key];
  manifest.updatedAt = new Date(now).toISOString();
  manifest.stats = { ...(manifest.stats || {}), itemCount: order.length, assetCount: Object.keys(assets).length };
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('canvas.json', JSON.stringify({
    version: 4, view: S.view || C.view || { panX: 0, panY: 0, zoom: 0.7 },
    order, connections, lines: S.lines, strokes: S.strokes,
    nextGroupNumber: Math.max(1, Number(S.nextGroupNumber) || 1, Number(C.nextGroupNumber) || 1),
    positions, settings: S.settings || {},
  }));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Nothing may vanish. Every card live now is live — with its own value, or
  // the snapshot's where the restore says so (`reverted`) — or in the bin with
  // ITS bytes. Every card live in the snapshot is live or deliberately kept
  // out (purged). Today's bin survives: an entry leaves only when its card is
  // live today (the live copy wins, as in every merge) or it has no bytes.
  const revertedIds = new Set(reverted);
  const lostNow = cOrder.filter((id) => liveIn(C, id) && (live.has(id)
    ? !(sameMeaning(values.get(id), C.items[id]) || revertedIds.has(id))
    : !(entries[id] && entries[id].purged !== true && sameMeaning(bin.get(id)?.json, C.items[id]))));
  if (lostNow.length) throw new Error(`restoreSnapshotAsMerge INVARIANT VIOLATED — ${lostNow.length} current card(s) overwritten or not buried with their bytes: ${lostNow.slice(0, 5).join(', ')}`);
  const lostBin = Object.entries(C.graveyard).filter(([id, g]) => g?.json != null && !liveIn(C, id) && !entries[id]).map(([id]) => id);
  if (lostBin.length) throw new Error(`restoreSnapshotAsMerge INVARIANT VIOLATED — ${lostBin.length} bin entr(ies) dropped: ${lostBin.slice(0, 5).join(', ')}`);
  const kept = new Set(keptPurged);
  // Live is not enough: the card's landing must hold ITS value, or a later
  // landing overwrote it.
  const lostSnap = sOrder.filter((k) => liveIn(S, k) && !kept.has(k)
    && !(live.has(idMap.get(k)) && sameMeaning(values.get(idMap.get(k)), S.items[k])));
  if (lostSnap.length) throw new Error(`restoreSnapshotAsMerge INVARIANT VIOLATED — ${lostSnap.length} snapshot card(s) not restored: ${lostSnap.slice(0, 5).join(', ')}`);
  await parseKlypix(buffer);
  return { buffer, reverted, restored, revived, buried, keptPurged };
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

// ── revivalMap (§2.7): where did the cards the app last saw go? ─────────────
// A watcher showing a brain keeps, for every id, the last JSON it saw while
// that id was live. When a write moves a card's value to another id — a Brain
// Sync revival, a git-driver merge, a bin or history restore — the old id
// leaves the file with an entry in its bin, and this follows that entry the
// way the merge routes a value (route() above), in the new file only:
//   purged                         → dropped
//   restored                       → on to its restoredAs
//   deleted with this very value   → dropped (the deleter saw it)
//   deleted with other bytes       → on to revivedIdFor
// At a live id t: t holding the same meaning is the card (revived {id, as: t});
// else a live twin of t holding it is (the merge placed it beside t); else
// nothing — the value went nowhere this file can show, and it is not reported.
// So a pair never points at a card holding different content, and a renderer
// that follows it can never overwrite another machine's edit.
async function revivalMapOf(file, lastKnown) {
  const { liveIds, liveJson, binMeta, binBody } = file;
  const revived = [], dropped = [];
  let twinsByParent = null;
  const twinsOf = (t) => {
    if (!twinsByParent) {
      twinsByParent = new Map();
      for (const id of liveIds) {
        const m = TWIN_PARENT_RE.exec(id);
        if (!m) continue;
        if (!twinsByParent.has(m[1])) twinsByParent.set(m[1], []);
        twinsByParent.get(m[1]).push(id);
      }
    }
    return twinsByParent.get(t) || [];
  };
  const landAt = async (k, v, t) => {
    if (!liveIds.has(t)) return false;
    if (sameMeaning(await liveJson(t), v)) { revived.push({ id: k, as: t }); return true; }
    for (const x of [...twinsOf(t)].sort()) {
      if (sameMeaning(await liveJson(x), v)) { revived.push({ id: k, as: x }); return true; }
    }
    // One step up, as the merge does (landIntoAlive): the landing is a copy
    // standing beside a card, and the value went onto that card.
    const beside = TWIN_PARENT_RE.exec(t)?.[1];
    if (beside && liveIds.has(beside) && sameMeaning(await liveJson(beside), v)) { revived.push({ id: k, as: beside }); return true; }
    // ...or, when the content pass kept another text on that card, into a twin of it.
    if (beside && liveIds.has(beside)) for (const x of [...twinsOf(beside)].sort()) {
      if (x !== t && sameMeaning(await liveJson(x), v)) { revived.push({ id: k, as: x }); return true; }
    }
    return true;   // live, but nothing here holds the value: report nothing
  };
  const entries = lastKnown instanceof Map ? lastKnown.entries() : Object.entries(lastKnown || {});
  for (const [k, v] of entries) {
    if (liveIds.has(k) || !binMeta(k)) continue;
    const seen = new Set();
    let t = k, settled = false;
    for (let step = 0; step < ROUTE_STEPS && !seen.has(t); step++) {
      seen.add(t);
      if (t !== k && liveIds.has(t)) { await landAt(k, v, t); settled = true; break; }
      const meta = binMeta(t);
      if (!meta) { settled = true; break; }            // a free id: the value went nowhere here
      const kind = entryKind(meta);
      if (kind === 'P') { dropped.push(k); settled = true; break; }
      if (kind === 'R') { t = String(meta.restoredAs); continue; }
      const body = await binBody(t);
      if (sameMeaning(v, body)) { dropped.push(k); settled = true; break; }
      t = revivedIdFor(t, meta, body);
    }
    if (!settled) await landAt(k, v, `${stripRevived(k)}__r_${sha12(`cycle\n${k}\n${itemSignature(v)}`)}`);
  }
  return { revived, dropped };
}

// The file view revivalMapOf reads, over one parse.
function fileViewOf(parsed, readLive) {
  const liveIds = new Set(parsed.struct.cards.map((c) => c.id));
  const metaById = new Map((parsed.struct.graveyard || []).map(({ id, ...meta }) => [id, meta]));
  return {
    liveIds,
    liveJson: readLive,
    binMeta: (id) => metaById.get(id) || null,
    binBody: async (id) => { const f = parsed.zip.file(`graveyard/${shard(id)}/${id}.json`); return f ? f.async('string') : null; },
  };
}

/**
 * Where the cards in `lastKnown` (Map id → the last item JSON seen while that
 * id was live) went in `newBuf`: `revived` pairs {id, as} for a value now
 * living under another id, `dropped` ids whose deletion is on record. An id
 * still live, or gone with no bin entry, is in neither.
 * @returns {Promise<{revived:{id:string,as:string}[], dropped:string[]}>}
 */
export async function revivalMap(newBuf, lastKnown) {
  if (!newBuf || !lastKnown) return { revived: [], dropped: [] };
  const n = await parseKlypix(newBuf);
  const read = async (id) => { const f = n.zip.file(`items/${shard(id)}/${id}.json`); return f ? f.async('string') : null; };
  return revivalMapOf(fileViewOf(n, read), lastKnown);
}

/**
 * What changed between two brain files, for the live watcher. Unchanged shape
 * unless asked: `lastKnown` (see revivalMap) adds `revived` and `dropped`, with
 * the item and position of every revived `as` included in `items`/`positions`;
 * `collectLive` adds `live` (Map id → raw item JSON of newBuf) so the watcher
 * can refresh what it knows from the same read.
 */
export async function brainDelta(baseBuf, newBuf, { lastKnown = null, collectLive = false } = {}) {
  const empty = { added: [], updated: [], removed: [], items: {}, positions: {}, connections: [], manifest: null };
  if (!baseBuf || !newBuf) return empty;
  const [b, n] = await Promise.all([parseKlypix(baseBuf), parseKlypix(newBuf)]);
  const baseIds = new Set(b.struct.cards.map((c) => c.id));
  const newIds = new Set(n.struct.cards.map((c) => c.id));
  const bPos = (b.canvas && b.canvas.positions) || {};
  const nPos = (n.canvas && n.canvas.positions) || {};
  const posKey = (p) => (p ? JSON.stringify([p.x, p.y, p.w, p.h, p.parentId ?? null]) : '');   // ignore zKey/zIndex noise
  const raw = async (zip, id) => { const f = zip.file(`items/${shard(id)}/${id}.json`); return f ? f.async('string') : null; };
  // Each new-side item is inflated once, whichever of the passes below reads it.
  const nRaw = new Map();
  const rawN = async (id) => { if (!nRaw.has(id)) nRaw.set(id, await raw(n.zip, id)); return nRaw.get(id); };

  const added = [...newIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !newIds.has(id));
  const updated = [];
  for (const id of newIds) {
    if (!baseIds.has(id)) continue;
    const [bStr, nStr] = await Promise.all([raw(b.zip, id), rawN(id)]);
    if (bStr !== nStr || posKey(bPos[id]) !== posKey(nPos[id])) updated.push(id);
  }

  const items = {}, positions = {};
  for (const id of [...added, ...updated]) {
    const s = await rawN(id);
    if (s) items[id] = s;
    if (nPos[id]) positions[id] = nPos[id];
  }
  const baseConn = new Set((b.canvas && b.canvas.connections || []).map((c) => c.id));
  const connections = (n.canvas && n.canvas.connections || []).filter((c) => c && c.id && !baseConn.has(c.id));
  const out = { added, updated, removed, items, positions, connections, manifest: n.manifest || null };
  if (lastKnown) {
    const { revived, dropped } = await revivalMapOf(fileViewOf(n, rawN), lastKnown);
    for (const { as } of revived) {
      const s = await rawN(as);
      if (s && !items[as]) items[as] = s;
      if (nPos[as] && !positions[as]) positions[as] = nPos[as];
    }
    out.revived = revived;
    out.dropped = dropped;
  }
  if (collectLive) {
    const live = new Map();
    for (const id of newIds) { const s = await rawN(id); if (s != null) live.set(id, s); }
    out.live = live;
  }
  return out;
}

export default mergeBrains;
