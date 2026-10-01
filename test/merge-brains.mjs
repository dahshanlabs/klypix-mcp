// Concurrency-critical merge regressions found by the 2026-08-01 audit, the
// Stage-2 all-callers rules (deterministic twins E-1, receipt identities E-2,
// the option plumbing), and one truth table per option-mode option with its
// mutation checks (S2-B, S2-L, S2-N, S2-M, S2-V, S2-A, S2-X). Pure buffers only, except the git-driver agreement
// check, which runs the real driver on files under os.tmpdir().
//
// Every Stage-2 rule is also run through a FROZEN copy of the 1.86.3 engine
// (test/fixtures/engine-1.86.3) to prove the assertion catches the old
// behaviour — a test that passes on both engines proves nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildKlypix, parseKlypix, shard, itemSignature, isAgconfTwinId } from '../src/klypix-format.mjs';
import {
  mergeBrains, normalizeMergeOptions, MERGE_ENGINE_FEATURES, deletedByAbsence,
  twinIdFor, revivedIdFor, receiptIdentity, fullEntryRid, entryKind, isContentFreeReceipt,
  pickBinEntry, binEntryFor, contentFreeReceiptFor, PURGED_BODY, sameMeaning,
} from '../src/merge-brains.mjs';
import { listGraveyard } from '../src/brain-graveyard.mjs';
import * as OLD from './fixtures/engine-1.86.3/merge-brains.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const throwsType = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const base = await buildKlypix({
  title: 'merge concurrency',
  cards: [
    { id: 'txt_A', text: 'A — original' },
    { id: 'txt_B', text: 'B — delete target' },
  ],
});

const rezip = (zip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const readItem = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file(`items/${shard(id)}/${id}.json`);
  return f ? f.async('string') : null;
};
const changeItem = async (buffer, id, mutate) => {
  const { zip } = await parseKlypix(buffer);
  const itemPath = `items/${shard(id)}/${id}.json`;
  const item = JSON.parse(await zip.file(itemPath).async('string'));
  zip.file(itemPath, JSON.stringify(mutate(item)));
  return rezip(zip);
};
const setText = (buffer, id, content) => changeItem(buffer, id, (item) => ({ ...item, content }));

const removeItem = async (buffer, id) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.remove(`items/${shard(id)}/${id}.json`);
  canvas.order = (canvas.order || []).filter((itemId) => itemId !== id);
  if (canvas.positions) delete canvas.positions[id];
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
// Add (or overwrite) a live card, placed beside `nearId` when given.
const putItem = async (buffer, id, json, nearId = null) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.file(`items/${shard(id)}/${id}.json`, json);
  canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
  canvas.positions = canvas.positions || {};
  if (!canvas.order.includes(id)) canvas.order.push(id);
  const near = nearId ? canvas.positions[nearId] : null;
  canvas.positions[id] = { x: (near?.x || 0) + 24, y: (near?.y || 0) + 24, parentId: near?.parentId ?? null };
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
const liveIds = async (buffer) => (await parseKlypix(buffer)).canvas.order || [];
const twinsOf = async (buffer, k) => (await liveIds(buffer)).filter((id) => id.startsWith(`${k}__agconf_`));
const binIndex = async (buffer) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file('graveyard.json');
  return f ? JSON.parse(await f.async('string')).entries : {};
};

// G2: a missing baseline gives no evidence for choosing either divergent
// meaning. Both must survive, and the conflict must be explicit.
{
  const ours = await setText(base, 'txt_A', 'A — OURS on first sync');
  const theirs = await setText(base, 'txt_A', 'A — THEIRS on first sync');
  const result = await mergeBrains({ base: null, ours, theirs });
  const { struct } = await parseKlypix(result.buffer);
  const texts = struct.cards.map((card) => card.text || '');

  ok(texts.some((text) => text.includes('OURS on first sync')),
    'G2: null-base divergence keeps ours live');
  ok(texts.some((text) => text.includes('THEIRS on first sync')),
    'G2: null-base divergence preserves theirs as a conflict twin');
  ok(result.conflicts.some((conflict) => conflict.id === 'txt_A' && conflict.kind === 'content-no-base'),
    'G2: null-base divergence is reported, never silently resolved');
}

// G3: a touch timestamp and key-order rewrite do not turn an untouched survivor
// into delete-vs-edit. The explicit tombstone must be honored exactly once.
{
  const ours = await removeItem(base, 'txt_B');
  const theirs = await changeItem(base, 'txt_B', (item) => {
    const { content, ...rest } = item;
    return { updatedAt: 1900000000002, content, ...rest };
  });
  const result = await mergeBrains({ base, ours, theirs, deletedIds: ['txt_B'] });
  const { struct } = await parseKlypix(result.buffer);

  ok(!struct.cards.some((card) => card.id === 'txt_B'),
    'G3: delete vs semantic no-op honors the delete');
  ok(result.delta.removed.length === 1 && result.delta.removed[0] === 'txt_B',
    'G3: the delete receipt reports one honored delete');
  ok(result.conflicts.length === 0 && result.stats.removed === 1,
    'G3: no bogus conflict twin or negative delete accounting');
}

// G3b: editedAt is volatile like updatedAt — an edit-then-undo cycle (or two
// apps stamping at different moments) leaves content identical while the
// authored-edit stamp differs. On a null-base first sync (the exact shape that
// spawned the historical updatedAt twins) that must not create a conflict twin.
{
  const ours = await changeItem(base, 'txt_A', (item) => ({ ...item, editedAt: 1900000000001 }));
  const theirs = await changeItem(base, 'txt_A', (item) => ({ ...item, editedAt: 1900000000777 }));
  const result = await mergeBrains({ base: null, ours, theirs });
  const { struct } = await parseKlypix(result.buffer);

  ok(struct.cards.filter((card) => card.id === 'txt_A' || (card.text || '').includes('A — original')).length === 1,
    'G3b: editedAt-only divergence keeps a single card, no conflict twin');
  ok(result.conflicts.length === 0,
    'G3b: editedAt-only divergence is not reported as a conflict');
}

// G4: deletion provenance and type-aware previews survive the merge and are
// available before restore. Unknown callers stay unknown rather than being
// mislabeled as human.
{
  const ours = await removeItem(base, 'txt_B');
  const result = await mergeBrains({
    base,
    ours,
    theirs: base,
    deletedIds: ['txt_B'],
    deletedMeta: {
      txt_B: { initiator: 'user', cause: 'keyboard-delete', source: 'desktop', confidence: 'explicit' },
    },
  });
  const entries = await listGraveyard(result.buffer);
  const deleted = entries.find((entry) => entry.id === 'txt_B');

  ok(deleted?.deletion?.initiator === 'user' && deleted?.deletion?.cause === 'keyboard-delete',
    'G4: explicit deletion receipt persists with the buried item');
  ok(deleted?.summary?.type === 'text' && deleted?.summary?.label?.includes('delete target'),
    'G4: deleted item is type-aware and previewable before restore');
  const { struct: buriedStruct } = await parseKlypix(result.buffer);
  const indexed = buriedStruct.graveyard.find((entry) => entry.id === 'txt_B');
  ok(indexed?.summary?.type === 'text',
    'G4: preview summary is indexed so listing does not reopen every deleted item');

  const inferredResult = await mergeBrains({ base, ours, theirs: base, deletedIds: ['txt_B'] });
  const inferredEntries = await listGraveyard(inferredResult.buffer);
  const inferred = inferredEntries.find((entry) => entry.id === 'txt_B');
  ok(inferred?.deletion?.initiator === 'unknown' && inferred?.deletion?.confidence === 'inferred',
    'G4: missing provenance stays unknown instead of being guessed as human');
}

// ═════════════════════════════ Stage 2 ══════════════════════════════════════

// S2-O: options. Strict validation is the point — a misspelt key or a
// half-configured object must throw, never quietly run the union merge.
console.log('\n— S2-O options —');
{
  const DEFAULTS = { binMerge: 'union', theirsTrust: 'descendant', newOnBothSides: 'theirs', manifestMerge: 'theirs', adoptResolvedConflicts: false };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(same(normalizeMergeOptions(undefined), DEFAULTS) && same(normalizeMergeOptions(null), DEFAULTS) && same(normalizeMergeOptions({}), DEFAULTS),
    'O1: no options ⇒ the union defaults');
  ok(same(normalizeMergeOptions({ binMerge: undefined }), DEFAULTS), 'O2: an undefined value means the default');

  // The objects callers will pin (the KLYPIX core's MODE_OPTIONS, the driver's
  // DRIVER_OPTIONS) must validate — a renamed key would fail here first.
  const accepted = {
    'union explicitly': { binMerge: 'union' },
    'driver (3way)': { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true },
    'core descendant': { binMerge: 'receipts', theirsTrust: 'descendant', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true },
    'core exact': { binMerge: '3way', theirsTrust: 'descendant', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true },
    'core unverified': { binMerge: 'receipts', theirsTrust: 'unverified', newOnBothSides: 'twin', manifestMerge: 'ours', adoptResolvedConflicts: true },
    'receipts alone': { binMerge: 'receipts' },
  };
  for (const [name, o] of Object.entries(accepted)) {
    let got = null; try { got = normalizeMergeOptions(Object.freeze({ ...o })); } catch { /* reported below */ }
    ok(got && Object.entries(o).every(([k, v]) => got[k] === v), `O3: accepts ${name}`);
  }

  const refused = {
    'a string': 'receipts',
    'an array': ['receipts'],
    'a number': 3,
    'an unknown key': { binMerge: 'receipts', trust: 'descendant' },
    'a misspelt key': { binmerge: 'receipts' },
    'a wrong-case value': { binMerge: 'Receipts' },
    'a non-boolean flag': { binMerge: 'receipts', adoptResolvedConflicts: 'yes' },
    'union + newOnBothSides': { newOnBothSides: 'twin' },
    'union + manifestMerge': { binMerge: 'union', manifestMerge: 'ours' },
    'union + adoptResolvedConflicts': { adoptResolvedConflicts: true },
    'union + unverified': { theirsTrust: 'unverified' },
    'unverified + 3way': { binMerge: '3way', theirsTrust: 'unverified' },
  };
  for (const [name, o] of Object.entries(refused)) ok(throwsType(() => normalizeMergeOptions(o)), `O4: refuses ${name} (TypeError)`);

  const bad = await rejects(mergeBrains({ base, ours: base, theirs: base, options: { binmerge: 'receipts' } }));
  ok(bad instanceof TypeError, 'O5: mergeBrains itself validates (a misspelt key never runs union)');
  ok(!(await rejects(mergeBrains({ base, ours: base, theirs: base, options: {} }))), 'O6: an empty options object merges');

  // The feature table and the engine must agree: everything advertised runs,
  // and an option mode not advertised is REFUSED rather than run as union.
  const F = MERGE_ENGINE_FEATURES;
  ok(Object.isFrozen(F) && Object.isFrozen(F.options) && Object.values(F.options).every(Object.isFrozen), 'O7: the feature table is deeply frozen');
  ok(F.deterministicTwins === true && F.receiptIds === true && F.purgeReceipts === true, 'O8: E-1, E-2 and purge receipts are advertised');
  let advertisedRun = true;
  for (const mode of F.options.binMerge) {
    if (await rejects(mergeBrains({ base, ours: base, theirs: base, options: { binMerge: mode } }))) advertisedRun = false;
  }
  ok(advertisedRun, 'O9: every advertised binMerge value runs');
  ok(F.api === 2 && ['union', 'receipts', '3way'].every((m) => F.options.binMerge.includes(m)) && F.options.theirsTrust.includes('unverified'),
    'O10: api 2 advertises every option value (the option modes run)');
  let allRun = true;
  for (const [key, values] of Object.entries(F.options)) for (const value of values) {
    const o = key === 'binMerge' || value === normalizeMergeOptions({})[key] ? { [key]: value } : { binMerge: 'receipts', [key]: value };
    if (await rejects(mergeBrains({ base, ours: base, theirs: base, options: o }))) allRun = false;
  }
  ok(allRun, 'O11: every advertised value of every option runs');
  ok(F.revivedIds === true && F.restoreAsMerge === true && F.arrangeReceipts === true && F.revivalMap === true,
    'O12: every Stage 2 tool is advertised, now that each one runs (revived restores, history as a merge, arrange receipts, the revival map)');
}

// S2-I: identity. Truth tables for the entry kinds and identities every copy
// must agree on without talking.
console.log('\n— S2-I entry kinds and identities —');
{
  const kinds = [
    [undefined, 'F'], [null, 'F'], [{}, 'F'], [{ purged: false }, 'F'], [{ purged: 'true' }, 'F'],
    [{ restoredAs: 'txt_x' }, 'F'], [{ purged: true }, 'P'], [{ purged: true, restoredAs: '' }, 'P'],
    [{ purged: true, restoredAs: 7 }, 'P'], [{ purged: true, restoredAs: 'txt_x' }, 'R'],
  ];
  ok(kinds.every(([meta, want]) => entryKind(meta) === want), 'I1: entryKind truth table (only purged:true is a receipt; only a named restoredAs makes it R)');
  ok(kinds.every(([meta, want]) => isContentFreeReceipt(meta) === (want !== 'F')), 'I2: isContentFreeReceipt ⇔ P or R');

  const a = JSON.stringify({ type: 'text', content: 'alpha', updatedAt: 1 });
  const aTouched = JSON.stringify({ updatedAt: 99, editedAt: 5, content: 'alpha', type: 'text' });
  const b = JSON.stringify({ type: 'text', content: 'beta' });
  ok(/^r_[0-9a-f]{16}$/.test(fullEntryRid('txt_A', a)), 'I3: an F identity is r_ + 16 hex');
  ok(fullEntryRid('txt_A', a) === fullEntryRid('txt_A', aTouched), 'I4: F identity ignores volatile fields and key order');
  ok(fullEntryRid('txt_A', a) !== fullEntryRid('txt_A', b) && fullEntryRid('txt_A', a) !== fullEntryRid('txt_Z', a),
    'I5: F identity changes with content and with the card id');
  ok(receiptIdentity('txt_A', { deletedAt: 5 }, a) === fullEntryRid('txt_A', a), 'I6: a pre-rid F entry shares the identity a new one would mint');
  ok(receiptIdentity('txt_A', { rid: 'r_stored', deletedAt: 5 }, b) === 'r_stored', 'I7: a stored rid always wins');
  const stage1P = { deletedAt: 1000, purgedAt: 999, purged: true };
  const lp = receiptIdentity('txt_A', stage1P, PURGED_BODY);
  ok(/^lp_[0-9a-f]{16}$/.test(lp) && lp === receiptIdentity('txt_A', { ...stage1P }, null),
    'I8: a Stage-1 purge receipt (no rid) gets a stable lp_ identity from fields every copy holds');
  ok(lp !== receiptIdentity('txt_A', { ...stage1P, deletedAt: 1001 }, PURGED_BODY), 'I9: … which names that purge, not any purge of the card');

  const t0 = twinIdFor('txt_A', a);
  ok(t0 === twinIdFor('txt_A', aTouched) && t0 === twinIdFor('txt_A', a, 0), 'I10: a twin id depends on meaning only (slot 0 by default)');
  ok(/^txt_A__agconf_[0-9a-f]{12}$/.test(t0) && isAgconfTwinId(t0), 'I11: twin ids keep the __agconf_ shape every reader already knows');
  ok(new Set([0, 1, 2, 3].map((n) => twinIdFor('txt_A', a, n))).size === 4 && t0 !== twinIdFor('txt_A', b), 'I12: each slot and each value gets its own id');
  const rv = revivedIdFor('txt_9f3kq2', { deletedAt: 1 }, a);
  ok(/^txt_9f3kq2__r_[0-9a-f]{12}$/.test(rv) && rv === revivedIdFor('txt_9f3kq2', { deletedAt: 2 }, aTouched), 'I13: a revived id is deterministic per deletion identity');
  const rv2 = revivedIdFor(rv, { deletedAt: 1 }, a);
  ok(/^txt_9f3kq2__r_[0-9a-f]{12}$/.test(rv2) && rv2 !== rv, 'I14: reviving a revived card replaces the suffix instead of stacking it');
  ok(!isAgconfTwinId(rv) && shard(rv) === shard('txt_9f3kq2'), 'I15: a revived id is never mistaken for a twin, and shards with its root');
}

// S2-R: receipts. binEntryFor mints F; contentFreeReceiptFor mints P and R.
console.log('\n— S2-R receipts —');
{
  const SECRET = 'sk-live-short-secret';
  const json = JSON.stringify({ type: 'text', content: `pasted ${SECRET}` });
  const F = binEntryFor({ id: 'txt_S', json, pos: { x: 1, y: 2, parentId: 'ctn_1' }, area: 'Work', receipt: { initiator: 'user', cause: 'keyboard-delete' }, now: 1000 });
  ok(F.meta.rid === fullEntryRid('txt_S', json) && F.meta.deletedAt === 1000 && F.meta.deletion.initiator === 'user' && F.meta.area === 'Work',
    'R1: an F entry carries its content identity, clock, audit receipt and area');
  ok(F.json === json && entryKind(F.meta) === 'F', 'R2: … and keeps the bytes verbatim');

  const P1 = contentFreeReceiptFor('txt_S', F, { kind: 'purged', now: 500 });
  const P2 = contentFreeReceiptFor('txt_S', F, { kind: 'purged', now: 500 });
  ok(entryKind(P1) === 'P' && /^p_[0-9a-f]{16}$/.test(P1.rid) && P1.rid !== P2.rid, 'R3: a purge receipt has a RANDOM identity (two purges never share one)');
  ok(P1.deletedAt === 1001 && P1.purgedAt === 500, 'R4: its deletedAt is later than the entry it replaces, even on a slow clock');
  const pText = JSON.stringify(P1);
  ok(!pText.includes(SECRET) && !pText.includes('pasted') && !pText.includes(F.meta.rid.slice(2)) && P1.pos === undefined && P1.area === undefined,
    'R5: nothing of the content survives in a purge receipt — no text, no content hash, no position or area');
  ok(P1.deletion.initiator === 'user', 'R6: … but who deleted it does');

  const R = contentFreeReceiptFor('txt_S', F, { kind: 'restored', restoredAs: 'txt_S__r_000000000000', now: 2000 });
  ok(entryKind(R) === 'R' && R.rid === F.meta.rid && R.restoredAs === 'txt_S__r_000000000000' && R.restoredAt === 2000,
    'R7: a restore receipt keeps its entry identity and names where the card went');
  ok(!JSON.stringify(R).includes(SECRET), 'R8: … and holds no content either (it is live elsewhere)');
  ok(throwsType(() => contentFreeReceiptFor('txt_S', F, { kind: 'restored' })) && throwsType(() => contentFreeReceiptFor('txt_S', F, { kind: 'gone' })),
    'R9: a restore receipt without restoredAs, or an unknown kind, is refused');
  const legacy = contentFreeReceiptFor('txt_L', { meta: { deletedAt: 5, deletedBy: 'human' }, json }, { kind: 'purged', now: 6 });
  ok(legacy.deletion.confidence === 'legacy' && legacy.deletedBy === 'human', 'R10: a pre-audit entry keeps its legacy attribution');
  ok(entryKind(JSON.parse(PURGED_BODY)) === 'P' && JSON.parse(PURGED_BODY).content === '', 'R11: the placeholder body is an empty text card');
}

// S2-T: the bin's total order. Taking the maximum must not depend on arrival
// order or grouping — or three replicas re-upload forever — and no clock may
// ever decide whose content survives.
console.log('\n— S2-T bin entry total order —');
{
  const va = JSON.stringify({ type: 'text', content: 'version a' });
  const vb = JSON.stringify({ type: 'text', content: 'version b' });
  const Fa = binEntryFor({ id: 'k', json: va, now: 10 });
  const pool = [
    Fa,
    { meta: { ...Fa.meta, deletedAt: 99 }, json: va },                        // same deletion, other clock
    { meta: { deletedAt: 3, deletedBy: 'human' }, json: va },                 // pre-rid F
    binEntryFor({ id: 'k', json: vb, now: 5 }),
    { meta: contentFreeReceiptFor('k', Fa, { kind: 'restored', restoredAs: 'k__r_aaaaaaaaaaaa', now: 20 }), json: PURGED_BODY },
    { meta: contentFreeReceiptFor('k', binEntryFor({ id: 'k', json: vb }), { kind: 'restored', restoredAs: 'k__r_bbbbbbbbbbbb', now: 20 }), json: PURGED_BODY },
    { meta: contentFreeReceiptFor('k', Fa, { kind: 'purged', now: 30 }), json: PURGED_BODY },
    { meta: contentFreeReceiptFor('k', Fa, { kind: 'purged', now: 1 }), json: PURGED_BODY },
    { meta: { deletedAt: 40, purgedAt: 40, purged: true }, json: PURGED_BODY }, // Stage-1 P
  ];
  const key = (e) => JSON.stringify(e);
  let commutative = true, idempotent = true, associative = true, ranked = true;
  const rank = { F: 1, R: 2, P: 3 };
  for (const x of pool) {
    if (key(pickBinEntry('k', x, x)) !== key(x)) idempotent = false;
    for (const y of pool) {
      if (key(pickBinEntry('k', x, y)) !== key(pickBinEntry('k', y, x))) commutative = false;
      const w = pickBinEntry('k', x, y);
      if (rank[entryKind(w.meta)] !== Math.max(rank[entryKind(x.meta)], rank[entryKind(y.meta)])) ranked = false;
      for (const z of pool) {
        if (key(pickBinEntry('k', pickBinEntry('k', x, y), z)) !== key(pickBinEntry('k', x, pickBinEntry('k', y, z)))) associative = false;
      }
    }
  }
  ok(commutative, 'T1: commutative over every pair');
  ok(associative, 'T2: associative over every triple — the grouping of merges cannot change the bin');
  ok(idempotent, 'T3: idempotent');
  ok(ranked, 'T4: P beats R beats F');
  ok(pickBinEntry('k', null, Fa) === Fa && pickBinEntry('k', Fa, undefined) === Fa, 'T5: an absent side is not an entry');

  // Clocks: swap which F version was deleted "later". The new order keeps the
  // same content either way; 1.86.3's union (newer deletedAt wins) flips.
  const early = (json) => ({ meta: { deletedAt: 1, deletedBy: 'user' }, json });
  const late = (json) => ({ meta: { deletedAt: 2, deletedBy: 'user' }, json });
  const unionPick = (x, y) => (Number(y.meta.deletedAt) > Number(x.meta.deletedAt) ? y : x);   // the 1.86.3 rule
  ok(pickBinEntry('k', late(va), early(vb)).json === pickBinEntry('k', early(va), late(vb)).json,
    'T6: which F version the bin keeps never depends on a clock');
  ok(unionPick(late(va), early(vb)).json !== unionPick(early(va), late(vb)).json,
    'T6 mutation: the 1.86.3 newest-deletedAt rule lets the clock pick the content (the check catches it)');

  // The draft's rule (critic A q3): a restore beats the deletion it restored,
  // anything else goes to the newest. It cycles — F(i) > R(j) > F(j) > F(i) —
  // so the grouping of three merges picks different entries, and three
  // replicas re-upload forever. The same associativity check must catch it.
  const when = (e) => Number(e.meta.restoredAt ?? e.meta.deletedAt ?? 0);
  const restores = (r, f) => entryKind(r.meta) === 'R' && entryKind(f.meta) === 'F' && r.meta.rid === f.meta.rid;
  const draftPick = (x, y) => {
    const kx = entryKind(x.meta), ky = entryKind(y.meta);
    if (kx === 'P' || ky === 'P') return kx === 'P' ? x : y;
    if (restores(x, y)) return x;
    if (restores(y, x)) return y;
    return when(y) > when(x) ? y : x;
  };
  const Fi = binEntryFor({ id: 'k', json: va, now: 5 });
  const Fj = binEntryFor({ id: 'k', json: vb, now: 7 });
  const Rj = { meta: contentFreeReceiptFor('k', Fj, { kind: 'restored', restoredAs: 'k__r_cccccccccccc', now: 3 }), json: PURGED_BODY };
  let draftAssociative = true;
  for (const x of [Fi, Fj, Rj]) for (const y of [Fi, Fj, Rj]) for (const z of [Fi, Fj, Rj]) {
    if (key(draftPick(draftPick(x, y), z)) !== key(draftPick(x, draftPick(y, z)))) draftAssociative = false;
  }
  ok(!draftAssociative, "T7 mutation: the draft's rule cycles, and the associativity check catches it");
  const ours = (x, y) => pickBinEntry('k', x, y);
  ok(key(ours(ours(Fi, Rj), Fj)) === key(ours(Fi, ours(Rj, Fj))), 'T7: … the total order does not, on the same three entries');
}

// S2-E2: every entry a merge mints carries its identity, and the identity is
// the same whichever machine buried the card, whenever.
console.log('\n— S2-E2 receipt ids in the merge —');
{
  const ours = await removeItem(base, 'txt_B');
  const m1 = await mergeBrains({ base, ours, theirs: base, deletedIds: ['txt_B'] });
  await new Promise((r) => setTimeout(r, 5));
  const theirsTouched = await changeItem(base, 'txt_B', (item) => ({ ...item, updatedAt: 1900000000123 }));
  const m2 = await mergeBrains({ base, ours, theirs: theirsTouched, deletedIds: ['txt_B'] });
  const e1 = (await binIndex(m1.buffer)).txt_B, e2 = (await binIndex(m2.buffer)).txt_B;
  const bytes = await readItem(base, 'txt_B');
  ok(e1?.rid === fullEntryRid('txt_B', bytes), 'E2-1: a buried card carries rid = its content identity');
  ok(e1?.rid === e2?.rid, 'E2-2: two machines burying the same card (bytes differing only in volatile fields) mint the same rid');
  const listed = (await listGraveyard(m1.buffer)).find((e) => e.id === 'txt_B');
  ok(listed?.rid === e1?.rid && listed?.kind === 'deleted', 'E2-3: listGraveyard reports kind and rid');

  // Round-trip: the entry crosses another union merge verbatim.
  const m3 = await mergeBrains({ base, ours: m1.buffer, theirs: await setText(base, 'txt_A', 'A — edited elsewhere') });
  ok(JSON.stringify((await binIndex(m3.buffer)).txt_B) === JSON.stringify(e1), 'E2-4: the entry, rid included, survives a later merge byte-for-byte');

  // A pre-rid entry (buried by 1.86.3) lists with the identity a new one would mint.
  const old = await OLD.mergeBrains({ base, ours, theirs: base, deletedIds: ['txt_B'] });
  const oldEntry = (await binIndex(old.buffer)).txt_B;
  ok(oldEntry && oldEntry.rid === undefined, 'E2 mutation: 1.86.3 buries without an identity (the check catches it)');
  ok((await listGraveyard(old.buffer)).find((e) => e.id === 'txt_B')?.rid === e1?.rid,
    'E2-5: … and a 1.86.3 entry of the same bytes gets the same identity when read');
}

// S2-E1: deterministic twins. The same conflict merged twice — again on this
// machine, on another machine, or through the git driver — leaves ONE twin.
console.log('\n— S2-E1 deterministic twins —');
{
  const ours = await setText(base, 'txt_A', 'A — ours');
  const theirs = await setText(base, 'txt_A', 'A — theirs');
  const theirsA = await readItem(theirs, 'txt_A');
  const slot0 = twinIdFor('txt_A', theirsA, 0);

  const r1 = await mergeBrains({ base, ours, theirs });
  const r2 = await mergeBrains({ base, ours, theirs });
  const tw1 = await twinsOf(r1.buffer, 'txt_A'), tw2 = await twinsOf(r2.buffer, 'txt_A');
  ok(tw1.length === 1 && tw1[0] === slot0 && tw2[0] === slot0, 'D1: the twin lands in slot 0 = twinIdFor(card, preserved value) on every run');
  ok(sameMeaning(await readItem(r1.buffer, slot0), theirsA) && (await readItem(r1.buffer, 'txt_A')).includes('A — ours'),
    'D2: ours stays live on the card and theirs is the twin, as before');
  ok(r1.conflicts.length === 1 && r1.conflicts[0].twin === slot0 && r1.conflicts[0].kind === 'content' && !r1.conflicts[0].existing,
    'D3: the conflict record names the twin it minted');
  const o1 = await OLD.mergeBrains({ base, ours, theirs }), o2 = await OLD.mergeBrains({ base, ours, theirs });
  ok((await twinsOf(o1.buffer, 'txt_A'))[0] !== (await twinsOf(o2.buffer, 'txt_A'))[0], 'D mutation: 1.86.3 mints a different random twin each run (the check catches it)');

  // Idempotence: merge the already-resolved result against the same theirs.
  const again = await mergeBrains({ base, ours: r1.buffer, theirs });
  ok((await twinsOf(again.buffer, 'txt_A')).length === 1, 'D4: re-merging the same conflict keeps one twin');
  ok(again.conflicts.some((c) => c.twin === slot0 && c.existing === true), 'D5: … and says the twin already existed');
  const oldAgain = await OLD.mergeBrains({ base, ours: o1.buffer, theirs });
  ok((await twinsOf(oldAgain.buffer, 'txt_A')).length === 2, 'D4 mutation: 1.86.3 stacks a second twin of the same value');

  // Fold into an old RANDOM twin that already holds the value.
  const legacyTwin = 'txt_A__agconf_k3j2h1g0';
  const oursWithLegacy = await putItem(ours, legacyTwin, theirsA, 'txt_A');
  const folded = await mergeBrains({ base, ours: oursWithLegacy, theirs });
  const foldedTwins = await twinsOf(folded.buffer, 'txt_A');
  ok(foldedTwins.length === 1 && foldedTwins[0] === legacyTwin && folded.conflicts.some((c) => c.twin === legacyTwin && c.existing),
    'D6: a value already held by a live pre-1.87 random twin is not twinned again');

  // X1: a person edited the twin since. It is never overwritten and the value
  // is not twinned again — the edit descends from it.
  const oursEditedTwin = await setText(r1.buffer, slot0, 'A — theirs, then tidied by a person');
  const x1 = await mergeBrains({ base, ours: oursEditedTwin, theirs });
  ok((await twinsOf(x1.buffer, 'txt_A')).length === 1 && (await readItem(x1.buffer, slot0)).includes('tidied by a person'),
    'D7 (X1): an edited twin is kept as edited, and no second twin appears');
  ok(x1.conflicts.some((c) => c.twin === slot0 && c.existing && c.edited), 'D8 (X1): the conflict says the twin was edited');

  // X2: the slot is being deleted in THIS merge while the same value comes in
  // again. It needs a live home: the next slot, never the dying one.
  const oursNoTwin = await removeItem(r1.buffer, slot0);
  const theirsWithTwin = await putItem(theirs, slot0, theirsA, 'txt_A');
  const x2 = await mergeBrains({ base, ours: oursNoTwin, theirs: theirsWithTwin, deletedIds: [slot0] });
  const x2Twins = await twinsOf(x2.buffer, 'txt_A');
  const slot1 = twinIdFor('txt_A', theirsA, 1);
  ok(!x2Twins.includes(slot0) && x2Twins.includes(slot1) && sameMeaning(await readItem(x2.buffer, slot1), theirsA),
    'D9 (X2): a dying slot moves the value to slot 1, live');
  ok(x2.delta.removed.includes(slot0) && (await binIndex(x2.buffer))[slot0], 'D10 (X2): … and the deleted twin is buried as asked');

  // Dead slot: the twin is in the bin. The union merge never resurrects it and
  // never suppresses the value (only option modes may treat that as resolved).
  const x3 = await mergeBrains({ base, ours: x2.buffer, theirs: await setText(base, 'txt_A', 'A — theirs again, other text') });
  const bothBuried = await mergeBrains({ base, ours: await removeItem(x2.buffer, slot1), theirs: x2.buffer, deletedIds: [slot1] });
  const x3b = await mergeBrains({ base, ours: bothBuried.buffer, theirs });
  const x3bTwins = await twinsOf(x3b.buffer, 'txt_A');
  ok(!x3bTwins.includes(slot0) && !x3bTwins.includes(slot1) && x3bTwins.includes(twinIdFor('txt_A', theirsA, 2)),
    'D11: slots whose twins sit in the bin are skipped, never resurrected — the value lands in the next free slot');
  ok((await twinsOf(x3.buffer, 'txt_A')).length === 2, 'D12: a different value gets its own twin beside the first');

  // content-no-base twins are deterministic too.
  const nb1 = await mergeBrains({ base: null, ours, theirs });
  ok((await twinsOf(nb1.buffer, 'txt_A'))[0] === slot0 && nb1.conflicts[0].kind === 'content-no-base', 'D13: a null-base twin uses the same deterministic slot');

  // The git-driver path and the sync path agree: the driver (a separate
  // process, committed-absence tombstones and all) lands the same twin id as a
  // direct merge, and a sync after the driver adds nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-merge-twins-'));
  try {
    const [bp, ap, tp] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `${n}.klypix`));
    fs.writeFileSync(bp, base); fs.writeFileSync(ap, ours); fs.writeFileSync(tp, theirs);
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'klypix-merge-driver.mjs'), bp, ap, tp, 'brain.klypix'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const viaDriver = fs.readFileSync(ap);
    ok(JSON.stringify(await twinsOf(viaDriver, 'txt_A')) === JSON.stringify([slot0]), 'D14: the git driver mints the same twin id as a direct (sync) merge');
    const syncAfterDriver = await mergeBrains({ base, ours: viaDriver, theirs });
    const driverAfterSync = await mergeBrains({ base, ours: r1.buffer, theirs: viaDriver });
    ok((await twinsOf(syncAfterDriver.buffer, 'txt_A')).length === 1 && (await twinsOf(driverAfterSync.buffer, 'txt_A')).length === 1,
      'D15: merging the driver result with the sync result (either way round) keeps one twin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// S2-U: NO OPTIONS ⇒ 1.86.3. The desktop app's merge-on-save passes no options
// and renderer bytes that carry no bin; any behaviour change there beyond the
// twin ids and the rid would reach the human's cards. A seeded differential
// over app-save and sync shapes: both engines must agree on everything else.
// One deliberate exception, which these shapes never meet (no side re-points
// an edge here): an edge whose copy on our side names a card the merge
// removed, while theirs' copy names live cards, is kept from theirs where
// 1.86.3 dropped it (case B-E and table S2-L).
console.log('\n— S2-U no options ⇒ unchanged (differential against 1.86.3) —');
{
  const mulberry = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const movePos = async (buffer, id, dx) => {
    const { zip, canvas } = await parseKlypix(buffer);
    if (canvas.positions?.[id]) canvas.positions[id] = { ...canvas.positions[id], x: (canvas.positions[id].x || 0) + dx };
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  };
  const cardJson = (id, content) => JSON.stringify({ id, type: 'text', content, width: 240, height: 80 });

  const canon = async (res, known) => {
    const { zip, canvas, manifest } = await parseKlypix(res.buffer);
    const order = canvas.order || [];
    const items = {};
    for (const id of order) items[id] = await zip.file(`items/${shard(id)}/${id}.json`)?.async('string');
    const ren = new Map();
    for (const id of order) {
      if (known.has(id)) continue;
      const m = /^(.*)__agconf_[a-z0-9]+$/i.exec(id);
      if (m) ren.set(id, `${m[1]}__agconf_<${itemSignature(items[id])}>`);
    }
    const R = (id) => ren.get(id) ?? id;
    // The order and the zKeys are compared apart (U3, U4): since review round
    // 2 every merge writes one order whichever side is ours, where 1.86.3
    // listed theirs first.
    const ids = [...order].sort((a, b) => (R(a) < R(b) ? -1 : R(a) > R(b) ? 1 : 0));
    const placed = (id) => { const { zKey, zIndex, ...pos } = canvas.positions[id] || {}; return pos; };
    const bin = {};
    const gf = zip.file('graveyard.json');
    const entries = gf ? JSON.parse(await gf.async('string')).entries : {};
    for (const [id, meta] of Object.entries(entries)) {
      const { rid, deletedAt, ...rest } = meta;
      bin[id] = { meta: rest, body: await zip.file(`graveyard/${shard(id)}/${id}.json`)?.async('string') };
    }
    const { updatedAt, ...man } = manifest || {};
    const { revived, purgedCopies, ...stats } = res.stats;
    const { revived: dRevived, ...delta } = res.delta;
    return JSON.stringify({
      order: ids.map(R),
      items: Object.fromEntries(ids.map((id) => [R(id), items[id]])),
      positions: Object.fromEntries(ids.map((id) => [R(id), placed(id)])),
      connections: canvas.connections, lines: canvas.lines, strokes: canvas.strokes, settings: canvas.settings,
      view: canvas.view, nextGroupNumber: canvas.nextGroupNumber,
      bin, manifest: man, delta, stats,
      conflicts: res.conflicts.map((c) => ({ ...c, ...(c.twin ? { twin: R(c.twin) } : {}) })),
      assets: Object.keys(zip.files).filter((p) => p.startsWith('assets/')).sort(),
    });
  };

  const SEEDS = 60;
  let agree = 0, withTwins = 0, withRemovals = 0, withBins = 0;
  const disagreements = [], unsorted = [], rekeyed = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rnd = mulberry(seed * 7919);
    const pick = (p) => rnd() < p;
    const n = 4 + Math.floor(rnd() * 6);
    const cards = Array.from({ length: n }, (_, i) => ({ id: `txt_c${i}`, text: `card ${i} original` }));
    const connections = Array.from({ length: Math.floor(rnd() * n) }, () => ({ from: Math.floor(rnd() * n), to: Math.floor(rnd() * n) }));
    const b = await buildKlypix({ title: `diff ${seed}`, cards, connections });
    let ours = b, theirs = b;
    for (const { id } of cards) {
      if (pick(0.2)) ours = await setText(ours, id, `${id} ours edit ${seed}`);
      if (pick(0.2)) theirs = await setText(theirs, id, `${id} theirs edit ${seed}`);
      if (pick(0.08)) theirs = await changeItem(theirs, id, (item) => ({ ...item, updatedAt: 1900000000000 + seed }));
      if (pick(0.1)) ours = await movePos(ours, id, 40);
      if (pick(0.1)) theirs = await movePos(theirs, id, -40);
      if (pick(0.1)) ours = await removeItem(ours, id);
      else if (pick(0.08)) theirs = await removeItem(theirs, id);
    }
    for (let i = 0; i < Math.floor(rnd() * 3); i++) theirs = await putItem(theirs, `txt_t${i}`, cardJson(`txt_t${i}`, `agent card ${i}`));
    for (let i = 0; i < Math.floor(rnd() * 2); i++) ours = await putItem(ours, `txt_o${i}`, cardJson(`txt_o${i}`, `human card ${i}`));
    if (pick(0.3)) {   // S10: one new card on both sides, maybe re-serialized differently
      ours = await putItem(ours, 'txt_both', cardJson('txt_both', 'new on both'));
      theirs = await putItem(theirs, 'txt_both', cardJson('txt_both', pick(0.5) ? 'new on both' : 'new on both, agent wording'));
    }
    if (pick(0.3)) {   // theirs carries a bin from an earlier delete (an older engine minted it)
      const theirIds = (await liveIds(theirs)).filter((id) => id.startsWith('txt_c'));
      if (theirIds.length) {
        const victim = theirIds[Math.floor(rnd() * theirIds.length)];
        theirs = (await OLD.mergeBrains({ base: b, ours: await removeItem(theirs, victim), theirs, deletedIds: [victim] })).buffer;
      }
    }
    const noBase = pick(0.15);
    const deletedIds = noBase ? [] : await deletedByAbsence(b, ours);
    const deletedMeta = Object.fromEntries(deletedIds.filter(() => pick(0.5)).map((id) => [id, { initiator: 'user', cause: 'keyboard-delete', source: 'desktop', confidence: 'explicit' }]));
    const args = { base: noBase ? null : b, ours, theirs, deletedIds, deletedMeta };

    const known = new Set([...(await liveIds(b)), ...(await liveIds(ours)), ...(await liveIds(theirs))]);
    let newC, oldC, newRes = null;
    try { newRes = await mergeBrains(args); newC = await canon(newRes, known); } catch (e) { newC = `threw ${e.message}`; }
    if (newRes) {
      const { canvas } = await parseKlypix(newRes.buffer);
      const z = (canvas.order || []).map((id) => canvas.positions[id]?.zKey);
      if (!z.every((k, i) => typeof k === 'string' && (i === 0 || z[i - 1] < k))) unsorted.push(seed);
      const bPos = (await parseKlypix(b)).canvas.positions;
      for (const id of canvas.order || []) if (bPos[id]?.zKey && canvas.positions[id]?.zKey !== bPos[id].zKey) rekeyed.push(`${seed}:${id}`);
    }
    try { oldC = await canon(await OLD.mergeBrains(args), known); } catch (e) { oldC = `threw ${e.message}`; }
    if (newC === oldC) agree++; else disagreements.push(seed);
    const parsed = JSON.parse(newC.startsWith('threw') ? '{}' : newC);
    if ((parsed.conflicts || []).some((c) => c.twin)) withTwins++;
    if ((parsed.delta?.removed || []).length) withRemovals++;
    if (Object.keys(parsed.bin || {}).length) withBins++;
  }
  ok(agree === SEEDS, `U1: ${agree}/${SEEDS} seeded app-save/sync shapes merge identically to 1.86.3 modulo twin ids, rid and order${disagreements.length ? ` (differ: seeds ${disagreements.slice(0, 8).join(', ')})` : ''}`);
  ok(!unsorted.length, `U3: every merge writes its order sorted by zKey, each key once${unsorted.length ? ` (not: seeds ${unsorted.slice(0, 8).join(', ')})` : ''}`);
  ok(!rekeyed.length, `U4: a card that had a zKey keeps it${rekeyed.length ? ` (changed: ${rekeyed.slice(0, 8).join(', ')})` : ''}`);
  ok(withTwins >= 5 && withRemovals >= 5 && withBins >= 5, `U2: the differential exercised twins (${withTwins}), removals (${withRemovals}) and carried bins (${withBins})`);
}

// ══════════════════════ Stage 2 option modes ════════════════════════════════
// One truth table per option. Each row is a small three-way scene (base, ours,
// theirs, tombstones) and the expected outcome under EVERY value of that
// option, written as `live[…] bin[…] c[…]`:
//   live  the cards in the result (the fixed anchor card left out), id=content
//   bin   the result's recycle bin, id:KIND (F shows the buried content)
//   c     the conflict kinds reported
// Ids are shortened for reading: `txt_` is dropped, a revived id reads k′
// and a twin reads k~. The OFF column of every table is the old behaviour,
// so each table is its own mutation check: after the rows run, every rule is
// asserted to change at least one named row (flip the option ⇒ that row fails).
// Rules inside the option modes that are not options of their own are then
// switched off one at a time in a mutated copy of the engine (S2-X).

const TEMPLATE = await buildKlypix({ title: 'modes', cards: [{ id: 'txt_anchor', text: 'anchor' }] });
const cj = (id, text, extra = {}) => JSON.stringify({ id, type: 'text', content: text, width: 240, height: 80, ...extra });
const Fe = (id, text, now = 1000) => binEntryFor({ id, json: cj(id, text), now });
const Pe = (id, text, now = 2000) => ({ meta: contentFreeReceiptFor(id, Fe(id, text), { kind: 'purged', now }), json: PURGED_BODY });
const Re = (id, text, as, now = 2000) => ({ meta: contentFreeReceiptFor(id, Fe(id, text), { kind: 'restored', restoredAs: as, now }), json: PURGED_BODY });
const kRev = (text) => revivedIdFor('txt_k', Fe('txt_k', text).meta, cj('txt_k', text));   // where a delete of k(text) revives
const pj = (text) => JSON.stringify({ type: 'text', content: text, width: 240, height: 80 });   // a card as brains store it: no id inside
// A restore of k(text) as brains store cards, and the id that restore lands on.
const pFe = (id, text) => binEntryFor({ id, json: pj(text), now: 1000 });
const pRe = (id, text, as, now = 2000) => ({ meta: contentFreeReceiptFor(id, pFe(id, text), { kind: 'restored', restoredAs: as, now }), json: PURGED_BODY });
const kRestoredAs = (text) => revivedIdFor('txt_k', pFe('txt_k', text).meta, pj(text));
// A purge of k(text) as brains store cards (its rid is random, as a purge's is).
const pPe = (id, text, now = 2000) => ({ meta: contentFreeReceiptFor(id, pFe(id, text), { kind: 'purged', now }), json: PURGED_BODY });
// k restored as k′, then k′ deleted holding the same bytes and restored again as k″.
const kChain = (text) => {
  const k1 = kRestoredAs(text);
  const f1 = binEntryFor({ id: k1, json: pj(text), now: 1500 });
  const k2 = revivedIdFor(k1, f1.meta, pj(text));
  return { k1, k2, r1: pRe('txt_k', text, k1), r2: { meta: contentFreeReceiptFor(k1, f1, { kind: 'restored', restoredAs: k2, now: 2500 }), json: PURGED_BODY } };
};
const EDGE_ARGS = [];   // the B-E case, for its S2-X mutation
const PURGE_GROUPINGS = [];   // the B-P check, for its S2-X mutation
const REACH_ROOTS = [];       // the B-P2 check, for its S2-X mutation
const N9_CHECK = [];          // the N9 case, for its S2-X mutation
const CYCLE_CHECK = [];       // the B-C case, for its S2-X mutation
const TITLE_CHECK = [];       // the M6 case, for its S2-X mutation
const FOLD_OWN_CHECK = [];    // the B-F case, for its S2-X mutation
const ORDER_CHECK = [];       // the Z1 and Z2 cases, for their S2-X mutations

const withBin = async (buffer, bin) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file('graveyard.json');
  const entries = f ? JSON.parse(await f.async('string')).entries : {};
  for (const [id, e] of Object.entries(bin)) {
    entries[id] = e.meta;
    zip.file(`graveyard/${shard(id)}/${id}.json`, e.json);
  }
  zip.file('graveyard.json', JSON.stringify({ version: 1, entries }));
  return rezip(zip);
};
const withManifest = async (buffer, patch) => {
  const { zip, manifest } = await parseKlypix(buffer);
  zip.file('manifest.json', JSON.stringify({ ...manifest, ...patch }));
  return rezip(zip);
};
const withPos = async (buffer, id, patch) => {
  const { zip, canvas } = await parseKlypix(buffer);
  canvas.positions[id] = { ...canvas.positions[id], ...patch };
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
// A side: live cards as { id: text | json }, a bin as { id: entry }.
const side = async ({ live = {}, bin = {}, manifest = null } = {}) => {
  let b = TEMPLATE;
  for (const [id, v] of Object.entries(live)) b = await putItem(b, id, v.startsWith('{') ? v : cj(id, v));
  if (Object.keys(bin).length) b = await withBin(b, bin);
  if (manifest) b = await withManifest(b, manifest);
  return b;
};

const short = (id) => id.replace(/^txt_/, '').replace(/__r_[0-9a-f]{12}/g, '′').replace(/__agconf_[0-9a-z]+/gi, '~');
const summarize = async (res, { withX = false, withEdges = false } = {}) => {
  const { zip, canvas } = await parseKlypix(res.buffer);
  const liveParts = [];
  for (const id of canvas.order || []) {
    if (id === 'txt_anchor') continue;
    const item = JSON.parse(await zip.file(`items/${shard(id)}/${id}.json`).async('string'));
    liveParts.push(`${short(id)}=${item.content}${withX ? `@${canvas.positions[id]?.x}` : ''}`);
  }
  const binParts = [];
  for (const [id, meta] of Object.entries(await binIndex(res.buffer))) {
    const kind = entryKind(meta);
    const body = kind === 'F' ? JSON.parse(await zip.file(`graveyard/${shard(id)}/${id}.json`).async('string')).content : '';
    binParts.push(`${short(id)}:${kind}${kind === 'F' ? `(${body})` : ''}`);
  }
  const kinds = [...new Set(res.conflicts.map((c) => c.kind))].sort();
  // e[…]: the edges, id:from->to (con_ dropped from the id).
  const edges = withEdges ? ` e[${(canvas.connections || []).map((c) => `${String(c.id).replace(/^con_/, '')}:${short(c.fromId)}->${short(c.toId)}`).sort().join(' ')}]` : '';
  return `live[${liveParts.sort().join(' ')}] bin[${binParts.sort().join(' ')}] c[${kinds.join(' ')}]${edges}`;
};

// Run one table: every row under every value of `option`. Returns
// observed[row][value] so the mutation check can compare columns.
const runTable = async (tag, option, values, rows, fixed = {}, view = {}) => {
  const observed = {};
  for (const row of rows) {
    const args = await row.args();
    observed[row.name] = {};
    for (const value of values) {
      const options = option === 'binMerge' && value === 'union' ? {} : { ...fixed, [option]: value };
      let got;
      try { got = await summarize(await mergeBrains({ ...args, options }), view); } catch (e) { got = `threw ${e.message}`; }
      observed[row.name][value] = got;
      const want = row.want[value];
      ok(got === want, `${tag} ${row.name} [${option}=${JSON.stringify(value)}] → ${want}${got === want ? '' : `   (got ${got})`}`);
    }
  }
  return observed;
};
// The table's own mutation check: running the OFF value must break the
// expectation of each row that proves the rule.
const offBreaks = (tag, observed, rows, on, off, provers) => {
  for (const name of provers) {
    const row = rows.find((r) => r.name === name);
    ok(row && observed[name][off] !== row.want[on],
      `${tag} mutation: ${JSON.stringify(off)} instead of ${JSON.stringify(on)} fails row ${name}`);
  }
};

const k0 = 'txt_k';

// ── S2-B binMerge (E-3, E-4, E-11, purge and restore receipts) ──────────────
// union is 1.86.3's bin (newest deletedAt wins, the bin never looks at the
// base); receipts and 3way are the fates → routing → content merge. The two
// option values differ in exactly one cell: B8, a committed revert.
console.log('\n— S2-B binMerge truth table —');
const B_ROWS = [
  {
    name: 'B1 stale copy of exactly the deleted bytes',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await side({ bin: { txt_k: Fe(k0, 'v0') } }) }),
    want: {
      union: 'live[k=v0] bin[] c[]',
      receipts: 'live[] bin[k:F(v0)] c[]',
      '3way': 'live[] bin[k:F(v0)] c[]',
    },
  },
  {
    name: 'B2 edit made after the delete (base had the card)',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v1' } }), theirs: await side({ bin: { txt_k: Fe(k0, 'v0') } }) }),
    want: {
      union: 'live[k=v1] bin[] c[]',
      receipts: 'live[k′=v1] bin[k:F(v0)] c[]',
      '3way': 'live[k′=v1] bin[k:F(v0)] c[]',
    },
  },
  {
    // R5: the base lags (here: no base at all). 1.86.3 cannot prove the edit
    // and lets the delete win — the edit is lost.
    name: 'B3 edit-beats-delete without a base',
    args: async () => ({ base: null, ours: await side({ bin: { txt_k: Fe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v1' } }) }),
    want: {
      union: 'live[] bin[k:F(v0)] c[]',
      receipts: 'live[k′=v1] bin[k:F(v0)] c[]',
      '3way': 'live[k′=v1] bin[k:F(v0)] c[]',
    },
  },
  {
    name: 'B4 purge vs an edited copy (P-a)',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ bin: { txt_k: Pe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v1 + secret' } }) }),
    want: {
      union: 'live[k=v1 + secret] bin[] c[delete-vs-edit]',
      receipts: 'live[] bin[k:P] c[purge-vs-edit]',
      '3way': 'live[] bin[k:P] c[purge-vs-edit]',
    },
  },
  {
    // An older machine deleted the same card later (or has a fast clock):
    // newest-deletedAt would bring the purged bytes back.
    name: 'B5 purge beats a later-stamped full entry',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ bin: { txt_k: Pe(k0, 'v0', 2000) } }), theirs: await side({ bin: { txt_k: Fe(k0, 'v0', 9e12) } }) }),
    want: {
      union: 'live[] bin[k:F(v0)] c[]',
      receipts: 'live[] bin[k:P] c[]',
      '3way': 'live[] bin[k:P] c[]',
    },
  },
  {
    name: 'B6 a restore reaches a machine that still holds the entry',
    args: async () => ({
      base: await side({ bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ bin: { txt_k: Fe(k0, 'v0') } }),
      theirs: await side({ live: { [kRev('v0')]: cj(kRev('v0'), 'v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
    }),
    want: {
      union: 'live[k′=v0] bin[k:R] c[]',
      receipts: 'live[k′=v0] bin[k:R] c[]',
      '3way': 'live[k′=v0] bin[k:R] c[]',
    },
  },
  {
    // R1: the other machine edited k before the restore arrived. 1.86.3 keeps
    // both lineages live and drops the receipt; the copy must follow the card.
    name: 'B7 a restore meets an edited copy of the old id',
    args: async () => ({
      base: await side({ live: { txt_k: 'v0' } }),
      ours: await side({ live: { txt_k: 'v1' } }),
      theirs: await side({ live: { [kRev('v0')]: cj(kRev('v0'), 'v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
    }),
    want: {
      union: 'live[k=v1 k′=v0] bin[] c[]',
      receipts: 'live[k′=v0 k′~=v1] bin[k:R] c[revived]',
      '3way': 'live[k′=v0 k′~=v1] bin[k:R] c[revived]',
    },
  },
  {
    // The one cell where the transports differ: in git, bringing back the
    // exact deleted bytes over a base that holds that deletion is a committed
    // revert; on path L it is a stale copy.
    name: 'B8 exact deleted bytes over a base that holds the deletion',
    args: async () => ({ base: await side({ bin: { txt_k: Fe(k0, 'v0') } }), ours: await side({ bin: { txt_k: Fe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v0' } }) }),
    want: {
      union: 'live[] bin[k:F(v0)] c[]',
      receipts: 'live[] bin[k:F(v0)] c[]',
      '3way': 'live[k′=v0] bin[k:F(v0)] c[]',
    },
  },
  {
    // R3: both sides are checkouts from before the entry existed. No receipt,
    // no purge: the base's entry comes back.
    name: 'B9 an entry both sides merely lack returns from the base',
    args: async () => ({ base: await side({ bin: { txt_k: Fe(k0, 'v0') } }), ours: await side(), theirs: await side() }),
    want: {
      union: 'live[] bin[] c[]',
      receipts: 'live[] bin[k:F(v0)] c[]',
      '3way': 'live[] bin[k:F(v0)] c[]',
    },
  },
  {
    name: 'B10 tombstone for a card gone from both sides (E-11)',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side(), theirs: await side(), deletedIds: [k0] }),
    want: {
      union: 'live[] bin[] c[]',
      receipts: 'live[] bin[k:F(v0)] c[]',
      '3way': 'live[] bin[k:F(v0)] c[]',
    },
  },
  {
    // q2b: ours' edit of k routes to the restored k′, which this same merge
    // deletes. Fates come first, so the edit moves on to a fresh revival
    // instead of being buried with k′'s old bytes.
    name: 'B11 a value routed onto a card this merge deletes moves on',
    args: async () => {
      const k1 = kRev('v0');
      return {
        base: await side({ live: { [k1]: cj(k1, 'v0') }, bin: { txt_k: Re(k0, 'v0', k1) } }),
        ours: await side({ live: { txt_k: 'v1' } }),
        theirs: await side({ bin: { txt_k: Re(k0, 'v0', k1), [k1]: binEntryFor({ id: k1, json: cj(k1, 'v0'), now: 3000 }) } }),
        deletedIds: [k1],
      };
    },
    want: {
      union: 'live[k=v1] bin[k′:F(v0)] c[]',
      receipts: 'live[k′=v1] bin[k:R k′:F(v0)] c[]',
      '3way': 'live[k′=v1] bin[k:R k′:F(v0)] c[]',
    },
  },
  {
    // q1: someone edited the revived card; a second rescued edit arrives. A
    // moved value never overwrites a live card — it becomes its twin.
    name: 'B12 a rescued edit never overwrites the live revived card',
    args: async () => ({
      base: await side({ live: { txt_k: 'v0' } }),
      ours: await side({ live: { txt_k: 'v1' } }),
      theirs: await side({ live: { [kRev('v0')]: cj(kRev('v0'), 'v2 sibling edit') }, bin: { txt_k: Fe(k0, 'v0') } }),
    }),
    want: {
      union: 'live[k=v1 k′=v2 sibling edit] bin[] c[]',
      receipts: 'live[k′=v2 sibling edit k′~=v1] bin[k:F(v0)] c[revived]',
      '3way': 'live[k′=v2 sibling edit k′~=v1] bin[k:F(v0)] c[revived]',
    },
  },
  {
    // Both sides hold k live over a base that deleted it: each copy is judged
    // on its own. Receipts: the stale copy drops, the edit revives. 3way: the
    // stale copy is a revert too, so both come back (one card + one twin).
    name: 'B13 both sides live: a stale copy and an edit',
    args: async () => ({ base: await side({ bin: { txt_k: Fe(k0, 'v0') } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await side({ live: { txt_k: 'v1' } }) }),
    want: {
      union: 'live[k=v1] bin[] c[]',
      receipts: 'live[k′=v1] bin[k:F(v0)] c[]',
      '3way': 'live[k′=v0 k′~=v1] bin[k:F(v0)] c[revived]',
    },
  },
  {
    name: 'B14 a purge outranks the delete-vs-edit rescue',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ bin: { txt_k: Pe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v1' } }), deletedIds: [k0] }),
    want: {
      union: 'live[k=v1] bin[] c[delete-vs-edit]',
      receipts: 'live[] bin[k:P] c[purge-vs-edit]',
      '3way': 'live[] bin[k:P] c[purge-vs-edit]',
    },
  },
  {
    // A person resolved this conflict by deleting its twin; re-merging the old
    // conflict must not bring the twin back (option modes only).
    name: 'B15 a twin deleted since the base is not re-minted',
    args: async () => {
      const x = twinIdFor(k0, cj(k0, 'v2'));
      return {
        base: await side({ live: { txt_k: 'v0' } }),
        ours: await side({ live: { txt_k: 'v1' }, bin: { [x]: binEntryFor({ id: x, json: cj(k0, 'v2') }) } }),
        theirs: await side({ live: { txt_k: 'v2' } }),
      };
    },
    want: {
      union: 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
      receipts: 'live[k=v1] bin[k~:F(v2)] c[content]',
      '3way': 'live[k=v1] bin[k~:F(v2)] c[content]',
    },
  },
  {
    // Found by the simulator's soak (seed 60466). Theirs buried the twin that
    // held v2 while putting v2 on the card itself (a history restore); ours
    // edited the card since. Theirs did not reject v2 — it is theirs' text —
    // so the new conflict keeps it beside the card instead of suppressing it.
    name: 'B25 a twin buried by the side that kept its value on the card is no resolution',
    args: async () => {
      const x = twinIdFor(k0, cj(k0, 'v2'));
      return {
        base: await side({ live: { txt_k: 'v0' } }),
        ours: await side({ live: { txt_k: 'v1' } }),
        theirs: await side({ live: { txt_k: 'v2' }, bin: { [x]: binEntryFor({ id: x, json: cj(k0, 'v2') }) } }),
      };
    },
    // (k~ twice: slot 0 is dead, so the twin takes slot 1 — both shorten to k~.)
    want: {
      union: 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
      receipts: 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
      '3way': 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
    },
  },
  {
    // A restore does not always land at revivedIdFor(k): it walks past cards
    // deleted since and lands beside newer text. Only restoredAs finds it.
    // (Plain card JSON: a real card holds no id of its own, so the restored
    // card holds exactly the value ours' edit was made on — the edit lands on
    // it, no twin.)
    name: 'B17 a copy follows a restore that landed elsewhere',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v0') } }),
      ours: await side({ live: { txt_k: pj('v1') } }),
      theirs: await side({ live: { txt_elsewhere: pj('v0') }, bin: { txt_k: Re(k0, 'v0', 'txt_elsewhere') } }),
    }),
    want: {
      union: 'live[elsewhere=v0 k=v1] bin[] c[]',
      receipts: 'live[elsewhere=v1] bin[k:R] c[]',
      '3way': 'live[elsewhere=v1] bin[k:R] c[]',
    },
  },
  {
    // Found by the simulator's soak: a machine on 1.3.171 put the old id back
    // (its union dropped the restore receipt) after the card was restored and
    // then edited. The stale copy routes to the restored card and matches the
    // value it held at the base; the edit made on top of that value wins.
    // (Plain card JSON: a real card holds no id of its own, so the stale copy
    // and the restored card are the same value.)
    name: 'B18 a stale copy of a card restored and edited since (theirs edited it)',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
      ours: await side({ live: { [kRev('v0')]: pj('v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
      theirs: await side({ live: { txt_k: pj('v0'), [kRev('v0')]: pj('v1') } }),
    }),
    want: { union: 'live[k′=v1] bin[k:R] c[]', receipts: 'live[k′=v1] bin[k:R] c[]', '3way': 'live[k′=v1] bin[k:R] c[]' },
  },
  {
    name: 'B19 a stale copy of a card restored and edited since (ours edited it)',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
      ours: await side({ live: { [kRev('v0')]: pj('v2') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
      theirs: await side({ live: { txt_k: pj('v0'), [kRev('v0')]: pj('v0') } }),
    }),
    want: { union: 'live[k′=v2] bin[k:R] c[]', receipts: 'live[k′=v2] bin[k:R] c[]', '3way': 'live[k′=v2] bin[k:R] c[]' },
  },
  {
    name: 'B20 a stale copy matching a twin of the restored card that was edited since',
    args: async () => {
      const kR = kRev('v0');
      const x = twinIdFor(kR, pj('v0'));
      return {
        base: await side({ live: { [kR]: pj('v1'), [x]: pj('v0') }, bin: { txt_k: Re(k0, 'v0', kR) } }),
        ours: await side({ live: { [kR]: pj('v1'), [x]: pj('v2') }, bin: { txt_k: Re(k0, 'v0', kR) } }),
        theirs: await side({ live: { txt_k: pj('v0'), [kR]: pj('v1'), [x]: pj('v0') } }),
      };
    },
    want: { union: 'live[k′=v1 k′~=v2] bin[k:R] c[]', receipts: 'live[k′=v1 k′~=v2] bin[k:R] c[]', '3way': 'live[k′=v1 k′~=v2] bin[k:R] c[]' },
  },
  {
    // Found by the simulator's soak (seed 10153): a machine checked out a file
    // older than a sync that moved an edit of k to k′. It holds k′'s value
    // under k, and only absence tombstoned k′ — that copy is k′, not a delete.
    name: 'B21 a checkout older than a move holds the card under its earlier id',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ live: { txt_k: pj('v1') } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      deletedIds: [kRev('v0')],
    }),
    want: { union: 'live[k=v1] bin[k′:F(v1)] c[]', receipts: 'live[k′=v1] bin[k:F(v0)] c[]', '3way': 'live[k′=v1] bin[k:F(v0)] c[]' },
  },
  {
    // The same file, but its own bin deletes k′: a person did, and it holds.
    name: 'B22 a side that deletes the moved card keeps the delete, whatever its earlier id holds',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ live: { txt_k: pj('v1') }, bin: { [kRev('v0')]: binEntryFor({ id: kRev('v0'), json: pj('v1'), now: 1500 }) } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      deletedIds: [kRev('v0')],
    }),
    want: { union: 'live[k=v1] bin[k′:F(v1)] c[]', receipts: 'live[] bin[k:F(v0) k′:F(v1)] c[]', '3way': 'live[] bin[k:F(v0) k′:F(v1)] c[]' },
  },
  {
    // An older value under the earlier id is not the card as the base holds
    // it: the checkout took k′'s later text away (a delete of it, as for any
    // card the older file lacks) and its own text comes back beside it.
    name: 'B23 a checkout older than an edit made after the move',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v2') }, bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ live: { txt_k: pj('v1') } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v2') }, bin: { txt_k: Fe(k0, 'v0') } }),
      deletedIds: [kRev('v0')],
    }),
    // (k′ twice: the landing is k′'s own revived id, which the summary also shortens to k′.)
    want: { union: 'live[k=v1] bin[k′:F(v2)] c[]', receipts: 'live[k′=v1] bin[k:F(v0) k′:F(v2)] c[]', '3way': 'live[k′=v1] bin[k:F(v0) k′:F(v2)] c[]' },
  },
  {
    // Found by the simulator's soak (seed 50647), against the first version of
    // B21's rule: ours deleted k′ (absence), and theirs is a cloud a stale
    // upload rolled back to k's copy of the same text. The side that lacks k′
    // and holds nothing deleted it; the stale copy must not cancel that.
    name: 'B24 a delete stands when only the other side holds the card under its earlier id',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ bin: { txt_k: Fe(k0, 'v0') } }),
      theirs: await side({ live: { txt_k: pj('v1') } }),
      deletedIds: [kRev('v0')],
    }),
    want: { union: 'live[] bin[k:F(v0)] c[]', receipts: 'live[] bin[k:F(v0) k′:F(v1)] c[]', '3way': 'live[] bin[k:F(v0) k′:F(v1)] c[]' },
  },
  {
    // Found by the simulator's soak (I9, seed 126): ours edited k (v9 → v15)
    // while a sync elsewhere revived k's v9 at k′. k′ still holds exactly what
    // ours edited: the edit lands on it (it was twinned beside it).
    name: 'B26 an edit lands on the card it moved to when that card still holds the value it was made on',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v9') } }),
      ours: await side({ live: { txt_k: pj('v15') } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v9') }, bin: { txt_k: Fe(k0, 'v0') } }),
    }),
    want: { union: 'live[k=v15 k′=v9] bin[] c[]', receipts: 'live[k′=v15] bin[k:F(v0)] c[]', '3way': 'live[k′=v15] bin[k:F(v0)] c[]' },
  },
  {
    // The simulator's soak (I9, seed 80642): ours' base holds k deleted (v0),
    // yet ours holds k live with v1 — a tab with no watcher typed into it and
    // the app save kept the edit. Elsewhere k was restored as k′, still v0.
    // The edit stays beside k′ as a twin, both texts kept: what the copy was
    // made on is known only from a LIVE base value. The bin's bytes are what
    // the deleter last held, and a tab can hold an older text than that —
    // folding on them overwrote a version nobody saw replaced (row B33).
    name: 'B28 an edit of a card the base holds deleted stays beside its restore (the bin cannot say what it was made on)',
    args: async () => ({
      base: await side({ bin: { txt_k: binEntryFor({ id: k0, json: pj('v0'), now: 1000 }) } }),
      ours: await side({ live: { txt_k: pj('v1') } }),
      theirs: await side({ live: { txt_elsewhere: pj('v0') }, bin: { txt_k: Re(k0, 'v0', 'txt_elsewhere') } }),
    }),
    want: { union: 'live[elsewhere=v0 k=v1] bin[] c[]', receipts: 'live[elsewhere=v0 elsewhere~=v1] bin[k:R] c[revived]', '3way': 'live[elsewhere=v0 elsewhere~=v1] bin[k:R] c[revived]' },
  },
  {
    // Found by the proposals review (round 2) against B28's first rule, which
    // read "made on" from the base's bin bytes: A edited k (v0 → v1) and then
    // deleted it; elsewhere k was restored, holding v1; a tab with no watcher
    // still held v0 and typed v2 into it, and the app save kept k live. The
    // restore still holds the bin's bytes, so the fold put v2 over v1 — and v1
    // was then live nowhere and in no bin, with no conflict reported.
    name: 'B33 an edit typed into an older text than the one deleted stays beside its restore',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v1') } }),
      ours: await side({ live: { txt_k: pj('v2') } }),
      theirs: await side({ live: { [kRestoredAs('v1')]: pj('v1') }, bin: { txt_k: pRe(k0, 'v1', kRestoredAs('v1')) } }),
    }),
    want: { union: 'live[k=v2 k′=v1] bin[] c[]', receipts: 'live[k′=v1 k′~=v2] bin[k:R] c[revived]', '3way': 'live[k′=v1 k′~=v2] bin[k:R] c[revived]' },
  },
  {
    // The landing was edited since the value ours' edit was made on: a real
    // conflict, both kept.
    name: 'B27 an edit beside a card edited since stays a twin',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v9') } }),
      ours: await side({ live: { txt_k: pj('v15') } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v12') }, bin: { txt_k: Fe(k0, 'v0') } }),
    }),
    want: { union: 'live[k=v15 k′=v12] bin[] c[]', receipts: 'live[k′=v12 k′~=v15] bin[k:F(v0)] c[revived]', '3way': 'live[k′=v12 k′~=v15] bin[k:F(v0)] c[revived]' },
  },
  {
    // Found on copies of the real brains (review round 2): ours restored k
    // from its bin (k′, and a receipt naming it) while theirs, which never saw
    // the restore, purged k. P beats R — and k′, holding the very bytes the
    // purge was for, stayed live with nobody told. A purge wins over every
    // copy (P-a): it follows the restore and k′ dies under a receipt derived
    // from the purge. k′ still holds exactly the restored bytes, so nothing
    // was typed into it, but the person who restored it watches it leave
    // their board (review round 3, c7b): purge-reached-restore tells them.
    name: 'B29 a purge reaches a restore the purging machine never saw (P-a)',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
      ours: await side({ live: { [kRestoredAs('v0')]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0')) } }),
      theirs: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
    }),
    want: { union: 'live[k′=v0] bin[k:P] c[]', receipts: 'live[] bin[k:P k′:P] c[purge-reached-restore]', '3way': 'live[] bin[k:P k′:P] c[purge-reached-restore]' },
  },
  {
    // The same, the other way round: the purge is ours.
    name: 'B30 a purge reaches a restore the other side made',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
      ours: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
      theirs: await side({ live: { [kRestoredAs('v0')]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0')) } }),
    }),
    want: { union: 'live[k′=v0] bin[k:R] c[]', receipts: 'live[] bin[k:P k′:P] c[purge-reached-restore]', '3way': 'live[] bin[k:P k′:P] c[purge-reached-restore]' },
  },
  {
    // An edit of the restored card goes with it (P-a: edited or not), and is
    // reported: it survives in that machine's restore point.
    name: 'B31 a purge reaches a restore edited since',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
      ours: await side({ live: { [kRestoredAs('v0')]: pj('v1 typed after the restore') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0')) } }),
      theirs: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
    }),
    want: { union: 'live[k′=v1 typed after the restore] bin[k:P] c[]', receipts: 'live[] bin[k:P k′:P] c[purge-vs-edit]', '3way': 'live[] bin[k:P k′:P] c[purge-vs-edit]' },
  },
  {
    // The landing was itself deleted and restored again (k → k′ → k″): the
    // purge follows the chain, and k′'s own receipt goes too (it named the
    // purged bytes). k″ holds those bytes untouched: the restorer is told.
    // (k′ and k″ both shorten to k′.)
    name: 'B32 a purge follows a restore chain',
    args: async () => {
      const c = kChain('v0');
      return {
        base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
        ours: await side({ live: { [c.k2]: pj('v0') }, bin: { txt_k: c.r1, [c.k1]: c.r2 } }),
        theirs: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
      };
    },
    want: { union: 'live[k′=v0] bin[k:P k′:R] c[]', receipts: 'live[] bin[k:P k′:P k′:P] c[purge-reached-restore]', '3way': 'live[] bin[k:P k′:P k′:P] c[purge-reached-restore]' },
  },
  {
    // The same chain, but k′ was edited before it was deleted, so k″ came
    // back holding that edit: not the purged card's bytes. It goes (P-a),
    // and is reported — the purging machine never saw that text.
    name: 'B34 a purge follows a restore chain through an edited card, and says so',
    args: async () => {
      const k1 = kRestoredAs('v0');
      const f1 = binEntryFor({ id: k1, json: pj('v1 edited before the second delete'), now: 1500 });
      const k2 = revivedIdFor(k1, f1.meta, pj('v1 edited before the second delete'));
      const r2 = { meta: contentFreeReceiptFor(k1, f1, { kind: 'restored', restoredAs: k2, now: 2500 }), json: PURGED_BODY };
      return {
        base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
        ours: await side({ live: { [k2]: pj('v1 edited before the second delete') }, bin: { txt_k: pRe(k0, 'v0', k1), [k1]: r2 } }),
        theirs: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
      };
    },
    want: {
      union: 'live[k′=v1 edited before the second delete] bin[k:P k′:R] c[]',
      receipts: 'live[] bin[k:P k′:P k′:P] c[purge-vs-edit]',
      '3way': 'live[] bin[k:P k′:P k′:P] c[purge-vs-edit]',
    },
  },
  {
    // P-a for a value that moves (review round 2: no row isolated it). Theirs
    // deleted k; a merge rescued an edit of it to k′, where that delete
    // revives, and a person then purged k′. Ours edited k without seeing any
    // of it: the edit routes to k′ and drops with the purge, reported (it
    // survives in ours' restore point).
    name: 'B35 an edit routed onto a permanently deleted card drops, and says so',
    args: async () => {
      const kR = kRestoredAs('v0');
      const fR = binEntryFor({ id: kR, json: pj('k′ text'), now: 2000 });
      return {
        base: await side({ live: { txt_k: pj('v0') } }),
        ours: await side({ live: { txt_k: pj('v1 with a pasted secret') } }),
        theirs: await side({ bin: { txt_k: pFe(k0, 'v0'), [kR]: { meta: contentFreeReceiptFor(kR, fR, { kind: 'purged', now: 3000 }), json: PURGED_BODY } } }),
      };
    },
    want: {
      union: 'live[k=v1 with a pasted secret] bin[k′:P] c[]',
      receipts: 'live[] bin[k:F(v0) k′:P] c[purge-vs-edit]',
      '3way': 'live[] bin[k:F(v0) k′:P] c[purge-vs-edit]',
    },
  },
  {
    // B22's shape with theirs' copy of k′ edited since the base: ours holds k′
    // under its earlier id k, but its own bin deletes k′, so the tombstone
    // stands (the item-13 exception needs a side holding no such entry), and
    // theirs' edit keeps k′ alive; ours' copy goes beside it.
    name: 'B36 a side that holds the moved card under its earlier id but deleted it keeps the delete-vs-edit',
    args: async () => ({
      base: await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }),
      ours: await side({ live: { txt_k: pj('v1') }, bin: { [kRev('v0')]: binEntryFor({ id: kRev('v0'), json: pj('v1'), now: 1500 }) } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v2') }, bin: { txt_k: Fe(k0, 'v0') } }),
      deletedIds: [kRev('v0')],
    }),
    want: {
      union: 'live[k=v1 k′=v2] bin[] c[delete-vs-edit]',
      receipts: 'live[k′=v2 k′~=v1] bin[k:F(v0)] c[delete-vs-edit revived]',
      '3way': 'live[k′=v2 k′~=v1] bin[k:F(v0)] c[delete-vs-edit revived]',
    },
  },
  {
    // A moved value meets a deleted card whose entry is a restore receipt
    // that landed somewhere other than its revival id: it follows restoredAs
    // (spec 2.3 route: R → restoredAs), and lands on the value it was made on.
    name: 'B37 a moved value follows a restore receipt to where the restore landed',
    args: async () => {
      const kR = kRestoredAs('v0');
      const fR = binEntryFor({ id: kR, json: pj('v0'), now: 1500 });
      const rR = { meta: contentFreeReceiptFor(kR, fR, { kind: 'restored', restoredAs: 'txt_elsewhere', now: 2500 }), json: PURGED_BODY };
      return {
        base: await side({ live: { txt_k: pj('v0') } }),
        ours: await side({ live: { txt_k: pj('v1') } }),
        theirs: await side({ live: { txt_elsewhere: pj('v0') }, bin: { txt_k: pFe(k0, 'v0'), [kR]: rR } }),
      };
    },
    want: {
      union: 'live[elsewhere=v0 k=v1] bin[k′:R] c[]',
      receipts: 'live[elsewhere=v1] bin[k:F(v0) k′:R] c[]',
      '3way': 'live[elsewhere=v1] bin[k:F(v0) k′:R] c[]',
    },
  },
  {
    // A twin deleted BEFORE the base resolved an earlier conflict, not this
    // one: the new conflict keeps theirs' value (in the next slot).
    name: 'B38 a twin deleted before the base does not suppress a new conflict',
    args: async () => {
      const x = twinIdFor(k0, cj(k0, 'v2'));
      const ex = binEntryFor({ id: x, json: cj(k0, 'v2') });
      return {
        base: await side({ live: { txt_k: 'v0' }, bin: { [x]: ex } }),
        ours: await side({ live: { txt_k: 'v1' }, bin: { [x]: ex } }),
        theirs: await side({ live: { txt_k: 'v2' } }),
      };
    },
    want: {
      union: 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
      receipts: 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
      '3way': 'live[k=v1 k~=v2] bin[k~:F(v2)] c[content]',
    },
  },
  {
    // Item 16 for a value of OURS: our rescued edit needs a twin beside k′,
    // whose slot ours itself buried holding that value. Only the other side's
    // deletion resolves the conflict, so the twin is minted in the next slot.
    name: 'B39 our value is never suppressed by a twin only our own bin deleted',
    args: async () => {
      const kR = kRestoredAs('v0');
      const x = twinIdFor(kR, pj('v1'));
      return {
        base: await side({ live: { txt_k: pj('v0') } }),
        ours: await side({ live: { txt_k: pj('v1') }, bin: { [x]: binEntryFor({ id: x, json: pj('v1'), now: 1500 }) } }),
        theirs: await side({ live: { [kR]: pj('v2') }, bin: { txt_k: pFe(k0, 'v0') } }),
      };
    },
    want: {
      union: 'live[k=v1 k′=v2] bin[k′~:F(v1)] c[]',
      receipts: 'live[k′=v2 k′~=v1] bin[k:F(v0) k′~:F(v1)] c[revived]',
      '3way': 'live[k′=v2 k′~=v1] bin[k:F(v0) k′~:F(v1)] c[revived]',
    },
  },
  {
    // A side's own entry for a card it holds live is malformed (spec 2.2) and
    // never kills the card.
    name: 'B40 a side\'s own entry for its own live card is ignored',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v0') } }),
      ours: await side({ live: { txt_k: pj('v0') }, bin: { txt_k: pFe(k0, 'v0') } }),
      theirs: await side({ live: { txt_k: pj('v0') } }),
    }),
    want: { union: 'live[k=v0] bin[] c[]', receipts: 'live[k=v0] bin[] c[]', '3way': 'live[k=v0] bin[] c[]' },
  },
  {
    // An edit a merge rescued from k's delete lives at k′ (where that delete
    // revives), with no receipt naming it; ours, holding it live, then purged
    // k. The purge does not reach it — deliberately, for now: see the P-a
    // note in mergeOptionMode (no link survives the bytes without a hash of
    // them, and an age purge would take live work). Pinned so a change to
    // that is a decision, not an accident.
    name: 'B41 a purge does not reach an edit a merge rescued from the delete',
    args: async () => {
      const kR = kRestoredAs('v0');
      return {
        base: await side({ live: { [kR]: pj('v1') }, bin: { txt_k: pFe(k0, 'v0') } }),
        ours: await side({ live: { [kR]: pj('v1') }, bin: { txt_k: pPe(k0, 'v0') } }),
        theirs: await side({ live: { [kR]: pj('v1') }, bin: { txt_k: pFe(k0, 'v0') } }),
      };
    },
    want: { union: 'live[k′=v1] bin[k:P] c[]', receipts: 'live[k′=v1] bin[k:P] c[]', '3way': 'live[k′=v1] bin[k:P] c[]' },
  },
  {
    // B26 with ours holding the revival too (it met the sync that made k′,
    // yet its old copy of k carries the edit): k′ holds exactly what the edit
    // was made on, on both sides, so the edit lands on it rather than beside
    // it (convergence review, round 2).
    name: 'B42 an edit lands on the card it moved to when both sides hold that card at the value it was made on',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v9') } }),
      ours: await side({ live: { txt_k: pj('v15'), [kRev('v0')]: pj('v9') } }),
      theirs: await side({ live: { [kRev('v0')]: pj('v9') }, bin: { txt_k: Fe(k0, 'v0') } }),
    }),
    want: { union: 'live[k=v15 k′=v9] bin[] c[]', receipts: 'live[k′=v15] bin[k:F(v0)] c[]', '3way': 'live[k′=v15] bin[k:F(v0)] c[]' },
  },
  {
    // Review round 3 (c1, C1a): ours restored k (it landed at k′), typed v1
    // into k′ and deleted it, so v1 sat in ours' Deleted cards, restorable.
    // Theirs, which saw none of it, purged k. The purge reaches k′ and its
    // receipt replaces that entry (P-a takes the purged text and what was
    // built on it), but the person who typed v1 was told nothing. It is now
    // reported, as an edited landing on the board is (B31). The other way
    // round is checked below.
    name: 'B43 a purge reaches a restore landing deleted after an edit, and says so',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
      ours: await side({ bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0')), [kRestoredAs('v0')]: binEntryFor({ id: kRestoredAs('v0'), json: pj('v1 typed after the restore, then deleted'), now: 1500 }) } }),
      theirs: await side({ bin: { txt_k: pPe(k0, 'v0') } }),
    }),
    want: {
      union: 'live[] bin[k:P k′:F(v1 typed after the restore, then deleted)] c[]',
      receipts: 'live[] bin[k:P k′:P] c[purge-vs-edit]',
      '3way': 'live[] bin[k:P k′:P] c[purge-vs-edit]',
    },
  },
  {
    // Nothing in any bin: the option modes are the familiar 3-way.
    name: 'B16 no bins anywhere: an ordinary content conflict',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v1' } }), theirs: await side({ live: { txt_k: 'v2' } }) }),
    want: {
      union: 'live[k=v1 k~=v2] bin[] c[content]',
      receipts: 'live[k=v1 k~=v2] bin[] c[content]',
      '3way': 'live[k=v1 k~=v2] bin[] c[content]',
    },
  },
];
{
  const observed = await runTable('B', 'binMerge', ['union', 'receipts', '3way'], B_ROWS);
  offBreaks('B', observed, B_ROWS, 'receipts', 'union', [
    'B1 stale copy of exactly the deleted bytes', 'B2 edit made after the delete (base had the card)',
    'B3 edit-beats-delete without a base', 'B4 purge vs an edited copy (P-a)', 'B5 purge beats a later-stamped full entry',
    'B7 a restore meets an edited copy of the old id', 'B9 an entry both sides merely lack returns from the base',
    'B10 tombstone for a card gone from both sides (E-11)', 'B14 a purge outranks the delete-vs-edit rescue',
    'B17 a copy follows a restore that landed elsewhere',
    'B29 a purge reaches a restore the purging machine never saw (P-a)', 'B30 a purge reaches a restore the other side made',
    'B31 a purge reaches a restore edited since', 'B32 a purge follows a restore chain',
    'B34 a purge follows a restore chain through an edited card, and says so',
    'B35 an edit routed onto a permanently deleted card drops, and says so',
    'B37 a moved value follows a restore receipt to where the restore landed',
    'B43 a purge reaches a restore landing deleted after an edit, and says so',
  ]);
  offBreaks('B', observed, B_ROWS, '3way', 'receipts', ['B8 exact deleted bytes over a base that holds the deletion']);

  // An edge both sides hold, after a sync elsewhere revived the card it
  // starts from (the edit went to k′ and theirs' edge follows it) while ours
  // still has k untouched, which the core tombstones: the edge follows the
  // card. Taking ours, the dangling filter dropped it and the other machine
  // put it back a round later (found by the KLYPIX simulator's soak).
  {
    const kR = kRev('v0');
    const withEdge = async (buf, from) => {
      const { zip, canvas } = await parseKlypix(buf);
      canvas.connections = [{ id: 'con_e', fromId: from, toId: 'txt_anchor', relationship: 'relates_to' }];
      zip.file('canvas.json', JSON.stringify(canvas));
      return rezip(zip);
    };
    const eArgs = async () => ({
      base: await withEdge(await side({ live: { txt_k: pj('v0') } }), 'txt_k'),
      ours: await withEdge(await side({ live: { txt_k: pj('v0') } }), 'txt_k'),
      theirs: await withEdge(await side({ live: { [kR]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }), kR),
      deletedIds: ['txt_k'],
    });
    const edgeFrom = async (res) => (await parseKlypix(res.buffer)).canvas.connections?.find((c) => c.id === 'con_e')?.fromId ?? null;
    for (const binMerge of ['receipts', '3way']) {
      ok(await edgeFrom(await mergeBrains({ ...(await eArgs()), options: { binMerge } })) === kR,
        `B-E (${binMerge}): an edge both sides hold follows the card to its revived id, over our copy that points at the retired id`);
    }
    // The app save (no options) meets the same shape whenever it tombstones the
    // tab's stale copy of a card the disk moved; 1.86.3 dropped the edge there.
    ok(await edgeFrom(await mergeBrains(await eArgs())) === kR, 'B-E (union): with no options the edge follows the card too (1.86.3 dropped it)');
    ok(await edgeFrom(await OLD.mergeBrains(await eArgs())) === null, 'B-E (union) bite: the 1.86.3 engine drops that edge');
    EDGE_ARGS.push(eArgs);
  }

  // Both ends of one edge move, on different sides: ours rescues its edit of
  // k1 (theirs deleted it) and theirs rescues its edit of k2 (ours deleted it).
  // Each side re-points only its own copy of the edge; the edge follows both.
  {
    const edge = async (buf, from, to) => {
      const { zip, canvas } = await parseKlypix(buf);
      canvas.connections = [{ id: 'con_both', fromId: from, toId: to, relationship: 'relates_to' }];
      zip.file('canvas.json', JSON.stringify(canvas));
      return rezip(zip);
    };
    const F = (id, text) => binEntryFor({ id, json: pj(text), now: 1000 });
    const k1R = revivedIdFor('txt_k1', F('txt_k1', 'a0').meta, pj('a0'));
    const k2R = revivedIdFor('txt_k2', F('txt_k2', 'b0').meta, pj('b0'));
    const args = async () => ({
      base: await edge(await side({ live: { txt_k1: pj('a0'), txt_k2: pj('b0') } }), 'txt_k1', 'txt_k2'),
      ours: await edge(await side({ live: { txt_k1: pj('a1') }, bin: { txt_k2: F('txt_k2', 'b0') } }), 'txt_k1', 'txt_k2'),
      theirs: await edge(await side({ live: { txt_k2: pj('b1') }, bin: { txt_k1: F('txt_k1', 'a0') } }), 'txt_k1', 'txt_k2'),
    });
    for (const binMerge of ['receipts', '3way']) {
      const res = await mergeBrains({ ...(await args()), options: { binMerge } });
      const c = (await parseKlypix(res.buffer)).canvas.connections?.find((x) => x.id === 'con_both');
      ok(c?.fromId === k1R && c?.toId === k2R, `B-E2 (${binMerge}): an edge whose ends moved on different sides follows both (${c ? `${c.fromId}->${c.toId}` : 'dropped'})`);
    }
    EDGE_ARGS.push(args);
  }

  // Detail the table's strings cannot show.
  const b2 = await mergeBrains({ ...(await B_ROWS[1].args()), options: { binMerge: 'receipts' } });
  ok(b2.delta.revived.length === 1 && b2.delta.revived[0].id === k0 && b2.delta.revived[0].as === kRev('v0') &&
    b2.delta.revived[0].via === 'edit' && b2.delta.revived[0].side === 'ours', 'B2: the rescue lands at revivedIdFor(k, its entry) and is reported in delta.revived');
  ok(b2.delta.removed.includes(k0) && !b2.delta.added.length && b2.stats.revived === 1, 'B2: k counts as removed, the landing is not an add');
  const b4 = await mergeBrains({ ...(await B_ROWS[3].args()), options: { binMerge: 'receipts' } });
  ok(b4.stats.purgedCopies === 1 && b4.conflicts.some((c) => c.kind === 'purge-vs-edit' && c.id === k0 && c.side === 'theirs'), 'B4: the dropped copy is counted and named');
  const b4zip = (await parseKlypix(b4.buffer)).zip;
  let leaked = false;
  for (const p of Object.keys(b4zip.files)) if (!b4zip.files[p].dir && (await b4zip.file(p).async('string')).includes('secret')) leaked = true;
  ok(!leaked, 'B4: nothing of the purged copy is anywhere in the result');
  const b4stale = await mergeBrains({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ bin: { txt_k: Pe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v0' } }), options: { binMerge: 'receipts' } });
  ok(!b4stale.conflicts.length && b4stale.stats.purgedCopies === 1, 'B4: a purge dropping an UNCHANGED copy is the purge working, not a conflict');
  const b11 = await mergeBrains({ ...(await B_ROWS[10].args()), options: { binMerge: 'receipts' } });
  const b11as = b11.delta.revived.find((r) => r.id === k0)?.as;
  ok(b11as && b11as !== kRev('v0') && (await liveIds(b11.buffer)).includes(b11as), 'B11: the edit lands at a NEW revival, not on the deleted k′');
  const b8 = await mergeBrains({ ...(await B_ROWS[7].args()), options: { binMerge: '3way' } });
  ok(b8.delta.revived[0]?.via === 'resurrection', 'B8: the 3way revival is reported as a resurrection');
  const b15 = await mergeBrains({ ...(await B_ROWS[14].args()), options: { binMerge: 'receipts' } });
  ok(b15.conflicts.some((c) => c.suppressed === 'deleted-twin'), 'B15: the suppressed twin is reported, not silent');
  // B42 with ours' copy of k′ edited (v11): the fold never puts the moved
  // edit over other text this side holds at the landing. All three texts stay.
  {
    const ownCase = async (engine) => {
      const res = await engine.mergeBrains({
        base: await side({ live: { txt_k: pj('v9') } }),
        ours: await side({ live: { txt_k: pj('v15'), [kRev('v0')]: pj('v11') } }),
        theirs: await side({ live: { [kRev('v0')]: pj('v9') }, bin: { txt_k: Fe(k0, 'v0') } }),
        options: { binMerge: 'receipts', newOnBothSides: 'twin' },
      });
      return summarize(res);
    };
    const got = await ownCase({ mergeBrains });
    ok(['v9', 'v11', 'v15'].every((v) => got.includes(`=${v}`)), `B-F: an edit moving onto a card that holds other text of its own side's keeps all three (${got})`);
    FOLD_OWN_CHECK.push(ownCase);
  }
  // A routing cycle (k's restore names a, a's names k) lands at an id derived
  // from the value, which every machine computes alike.
  {
    const cycleCase = async (engine) => {
      const fa = binEntryFor({ id: 'txt_a', json: pj('a0'), now: 1200 });
      const res = await engine.mergeBrains({
        base: await side({ live: { txt_k: pj('v0') } }),
        ours: await side({ live: { txt_k: pj('v1') } }),
        theirs: await side({ bin: { txt_k: pRe(k0, 'v0', 'txt_a'), txt_a: { meta: contentFreeReceiptFor('txt_a', fa, { kind: 'restored', restoredAs: 'txt_k', now: 2600 }), json: PURGED_BODY } } }),
        options: { binMerge: 'receipts' },
      });
      const want = `txt_k__r_${createHash('sha256').update(`cycle\ntxt_k\n${itemSignature(pj('v1'))}`).digest('hex').slice(0, 12)}`;
      return res.delta.revived.some((r) => r.id === k0 && r.as === want) && (await liveIds(res.buffer)).includes(want);
    };
    ok(await cycleCase({ mergeBrains }), 'B-C: a value whose route cycles lands at the value-derived cycle id');
    CYCLE_CHECK.push(cycleCase);
  }
  // B33 the other way round: the restore is ours, the typed copy theirs.
  {
    const r = B_ROWS.find((x) => x.name.startsWith('B33'));
    const a = await r.args();
    for (const binMerge of ['receipts', '3way']) {
      const got = await summarize(await mergeBrains({ base: a.base, ours: a.theirs, theirs: a.ours, options: { binMerge } }));
      ok(got === 'live[k′=v1 k′~=v2] bin[k:R] c[revived]', `B33 swapped (${binMerge}): v1 and v2 both survive (${got})`);
    }
  }

  // P-a reaching a restore (B29–B32): what the strings cannot show.
  {
    const kR = kRestoredAs('v0');
    const purge = pPe(k0, 'v0');
    const restored = await side({ live: { [kR]: pj('v0 secret') }, bin: { txt_k: pRe(k0, 'v0 secret', kR) } });
    const base29 = await side({ bin: { txt_k: pFe(k0, 'v0 secret') } });
    const purged29 = await side({ bin: { txt_k: { meta: contentFreeReceiptFor(k0, pFe(k0, 'v0 secret'), { kind: 'purged', now: 2000 }), json: PURGED_BODY } } });
    const kS = kRestoredAs('v0 secret');
    const restoredS = await side({ live: { [kS]: pj('v0 secret') }, bin: { txt_k: pRe(k0, 'v0 secret', kS) } });
    const r = await mergeBrains({ base: base29, ours: restoredS, theirs: purged29, options: { binMerge: 'receipts' } });
    const bin = await binIndex(r.buffer);
    const pk = bin[k0], pl = bin[kS];
    const want = `p_${createHash('sha256').update(`${pk?.rid}\n${kS}`).digest('hex').slice(0, 16)}`;
    ok(entryKind(pl ?? {}) === 'P' && pl.rid === want && pl.purgedWith === k0 && pl.deletedAt === pk.deletedAt && pl.purgedAt === pk.purgedAt
      && JSON.stringify(pl.deletion) === JSON.stringify(pk.deletion),
      'B29: the landing\'s receipt is derived from the purge — its rid hashes the purge\'s rid with the landing, its stamps are the purge\'s');
    ok(r.stats.purgedCopies === 1 && r.delta.removed.includes(kS) && !r.delta.revived.length, 'B29: the dropped copy is counted, the landing is removed, nothing moves');
    const zip29 = (await parseKlypix(r.buffer)).zip;
    let leaked29 = false;
    for (const p of Object.keys(zip29.files)) if (!zip29.files[p].dir && (await zip29.file(p).async('string')).includes('secret')) leaked29 = true;
    ok(!leaked29, 'B29: nothing of the purged text is anywhere in the result (the restore receipt\'s content-derived rid included)');
    // The machine that restored meets the result (it never saw the purge): one round.
    const stale = await mergeBrains({ base: base29, ours: restoredS, theirs: r.buffer, options: { binMerge: 'receipts' } });
    ok(await summarize(stale) === await summarize(r) && JSON.stringify(await binIndex(stale.buffer)) === JSON.stringify(bin),
      'B29: the restoring machine meeting the result writes the same receipts — no second round');
    const b31 = await mergeBrains({ ...(await B_ROWS.find((x) => x.name.startsWith('B31')).args()), options: { binMerge: 'receipts' } });
    ok(b31.conflicts.some((c) => c.kind === 'purge-vs-edit' && c.id === kR && c.side === 'ours' && c.purgedWith === k0),
      'B31: the dropped edit is reported against the landing, naming the purge that reached it');
    // B43 both ways round, in both option modes: the edit the purge took from
    // Deleted cards is reported once, against the landing, naming the purge,
    // and counted; nothing of it is left in the file. A landing deleted
    // holding exactly the bytes the restore put back is the purge working:
    // nothing to say, nothing counted.
    const swap = (a) => ({ ...a, ours: a.theirs, theirs: a.ours });
    const b43 = await B_ROWS.find((x) => x.name.startsWith('B43')).args();
    const b43same = { ...b43, ours: await side({ bin: { txt_k: pRe(k0, 'v0', kR), [kR]: binEntryFor({ id: kR, json: pj('v0'), now: 1500 }) } }) };
    for (const binMerge of ['receipts', '3way']) {
      for (const [label, a] of [['ours restored', b43], ['theirs restored', swap(b43)]]) {
        const r43 = await mergeBrains({ ...a, options: { binMerge } });
        const told = r43.conflicts.filter((c) => c.kind === 'purge-vs-edit');
        const z43 = (await parseKlypix(r43.buffer)).zip;
        let kept43 = false;
        for (const p of Object.keys(z43.files)) if (!z43.files[p].dir && (await z43.file(p).async('string')).includes('typed after the restore')) kept43 = true;
        ok(await summarize(r43) === B_ROWS.find((x) => x.name.startsWith('B43')).want[binMerge] && told.length === 1 && told[0].id === kR
          && told[0].side === 'bin' && told[0].purgedWith === k0 && r43.stats.purgedCopies === 1 && !kept43,
        `B43 (${binMerge}, ${label}): the edit the purge took from Deleted cards is reported against the landing, counted, and gone`);
      }
      for (const [label, a] of [['ours restored', b43same], ['theirs restored', swap(b43same)]]) {
        const r43 = await mergeBrains({ ...a, options: { binMerge } });
        ok(await summarize(r43) === 'live[] bin[k:P k′:P] c[]' && r43.stats.purgedCopies === 0,
          `B43 (${binMerge}, ${label}): a landing deleted holding exactly the restored bytes is the purge working — nothing reported`);
      }
    }
    // B29 both ways round (B30 is its mirror): the restored card that leaves
    // the board untouched is reported once, against the side that held it,
    // naming the purge, with no twin, and counted.
    for (const binMerge of ['receipts', '3way']) {
      const b29 = await B_ROWS.find((x) => x.name.startsWith('B29')).args();
      for (const [held, a] of [['ours', b29], ['theirs', swap(b29)]]) {
        const r29 = await mergeBrains({ ...a, options: { binMerge } });
        const told = r29.conflicts.filter((c) => c.kind === 'purge-reached-restore');
        ok(await summarize(r29) === B_ROWS.find((x) => x.name.startsWith('B29')).want[binMerge] && r29.conflicts.length === 1 && told.length === 1
          && told[0].id === kR && told[0].side === held && told[0].purgedWith === k0 && !('twin' in told[0]) && r29.stats.purgedCopies === 1,
        `B29 (${binMerge}, restored on ${held}): the untouched restore the purge took is reported against ${held}, naming the purge, no twin, counted`);
      }
    }
    // A foreign purge never reaches our restore (q6), ours reaches a foreign one.
    const unv = { binMerge: 'receipts', theirsTrust: 'unverified' };
    const r1 = await mergeBrains({ base: await side({ bin: { txt_k: pFe(k0, 'v0') } }), ours: await side({ live: { [kR]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kR) } }), theirs: await side({ bin: { txt_k: purge } }), options: unv });
    ok((await liveIds(r1.buffer)).includes(kR), 'B29 (unverified): a purge only theirs holds never reaches our restore');
    const r2 = await mergeBrains({ base: await side({ bin: { txt_k: pFe(k0, 'v0') } }), ours: await side({ bin: { txt_k: purge } }), theirs: await side({ live: { [kR]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kR) } }), options: unv });
    ok(!(await liveIds(r2.buffer)).includes(kR) && entryKind((await binIndex(r2.buffer))[kR] ?? {}) === 'P', 'B30 (unverified): our own purge reaches theirs\' restore');
    // Two machines purged k (two random rids) while a third restored it: every
    // grouping of the three merges keeps the same receipts, the derived one
    // included — it is derived from the purge that wins, never from one a
    // merge in between happened to see.
    const R3 = await side({ live: { [kR]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kR) } });
    const P1 = await side({ bin: { txt_k: pPe(k0, 'v0') } }), P2 = await side({ bin: { txt_k: pPe(k0, 'v0') } });
    const groupingsAgree = async (engine) => {
      const mm = async (o, t) => (await engine.mergeBrains({ base: null, ours: o, theirs: t, options: { binMerge: 'receipts' } })).buffer;
      const bins3 = async (b) => JSON.stringify(Object.entries(await binIndex(b)).map(([id, e]) => [id, entryKind(e), e.rid, e.purgedWith ?? null]).sort());
      const g = [await mm(await mm(P1, R3), P2), await mm(P1, await mm(R3, P2)), await mm(await mm(P2, P1), R3), await mm(R3, await mm(P2, P1))];
      const gb = await Promise.all(g.map(bins3));
      return gb.every((x) => x === gb[0]) && gb[0].includes(kR) && !(await Promise.all(g.map(liveIds))).some((ids) => ids.includes(kR));
    };
    ok(await groupingsAgree({ mergeBrains }),
      'B-P: two purges of one card and a restore of it — every grouping keeps the same receipts and purges the landing');
    PURGE_GROUPINGS.push(groupingsAgree);

    // Two purges reach one landing (review round 3): k restored as k1, k1
    // deleted and restored again as k2 on Y while X purged k1, and Z purged
    // k. Both roots reach k2; the receipt k2 gets is the one the total order
    // picks — the same whichever side is ours, never the one a loop met first.
    const fk = pFe(k0, 'v0');
    const k1 = revivedIdFor(k0, fk.meta, pj('v0'));
    const f1 = binEntryFor({ id: k1, json: pj('v0'), now: 2500 });
    const k2 = revivedIdFor(k1, f1.meta, pj('v0'));
    const rec = (id, e, kind, now, extra = {}) => ({ meta: contentFreeReceiptFor(id, e, { kind, now, ...extra }), json: PURGED_BODY });
    const baseR = await side({ bin: { [k0]: rec(k0, fk, 'restored', 2000, { restoredAs: k1 }), [k1]: f1 } });
    const purgedXZ = await side({ bin: { [k1]: rec(k1, f1, 'purged', 3100), [k0]: rec(k0, fk, 'purged', 3200) } });
    const restoredY = await side({ live: { [k2]: pj('v0') }, bin: { [k0]: rec(k0, fk, 'restored', 2000, { restoredAs: k1 }), [k1]: rec(k1, f1, 'restored', 3000, { restoredAs: k2 }) } });
    const rootsAgree = async (engine) => {
      const binOf = async (o, t) => {
        const r = await engine.mergeBrains({ base: baseR, ours: o, theirs: t, options: { binMerge: 'receipts' } });
        const b = await binIndex(r.buffer);
        return { live: (await liveIds(r.buffer)).includes(k2), bin: JSON.stringify(Object.entries(b).map(([id, e]) => [id, entryKind(e), e.rid, e.purgedWith ?? null]).sort()), k2: b[k2] };
      };
      const a = await binOf(purgedXZ, restoredY), b = await binOf(restoredY, purgedXZ);
      return a.bin === b.bin && !a.live && !b.live && entryKind(a.k2 ?? {}) === 'P';
    };
    ok(await rootsAgree({ mergeBrains }),
      'B-P2: two purges reaching one restore landing — the same receipt whichever side is ours, and the landing is purged');
    REACH_ROOTS.push(rootsAgree);
  }

  // Determinism and idempotence: the same inputs give the same bytes-level
  // result, and merging the result again changes nothing.
  let stable = true, quiet = true;
  for (const row of B_ROWS) {
    const args = await row.args();
    for (const binMerge of ['receipts', '3way']) {
      const r1 = await mergeBrains({ ...args, options: { binMerge } });
      const r2 = await mergeBrains({ ...args, options: { binMerge } });
      if (await summarize(r1) !== await summarize(r2) || JSON.stringify(await liveIds(r1.buffer)) !== JSON.stringify(await liveIds(r2.buffer))) stable = false;
      const again = await mergeBrains({ base: r1.buffer, ours: r1.buffer, theirs: r1.buffer, options: { binMerge } });
      if ((await summarize(again)).replace(/ c\[.*\]$/, '') !== (await summarize(r1)).replace(/ c\[.*\]$/, '')) quiet = false;
    }
  }
  ok(stable, 'B: every row gives the same ids on every run (no clock, no randomness)');
  ok(quiet, 'B: re-merging any result with itself is a no-op');

  // The grouping of merges cannot change the bin (q3): three replicas each
  // hold a different entry for k.
  const X = await side({ bin: { txt_k: Fe(k0, 'va') } });
  const Y = await side({ bin: { txt_k: Re(k0, 'va', kRev('va')) }, live: { [kRev('va')]: cj(kRev('va'), 'va') } });
  const Z = await side({ bin: { txt_k: Pe(k0, 'va') } });
  const m = async (o, t) => (await mergeBrains({ base: null, ours: o, theirs: t, options: { binMerge: 'receipts' } })).buffer;
  const left = await m(await m(X, Y), Z), right = await m(X, await m(Y, Z)), swapped = await m(Z, await m(Y, X));
  const binOf = async (b) => JSON.stringify(Object.entries(await binIndex(b)).map(([id, e]) => [id, entryKind(e), e.rid]).sort());
  ok(await binOf(left) === await binOf(right) && await binOf(right) === await binOf(swapped) && (await binOf(left)).includes('"P"'),
    'B: ((X·Y)·Z), (X·(Y·Z)) and (Z·(Y·X)) keep the same entry — the purge');
  ok((await Promise.all([left, right, swapped].map(async (b) => entryKind((await binIndex(b))[kRev('va')] ?? {}) === 'P' && !(await liveIds(b)).includes(kRev('va'))))).every(Boolean),
    'B: … and in every grouping the purge reaches Y\'s restore of k');
}

// ── S2-L links (edges) whose card moved under the other side's copy ──────────
// Every mode, the app save's union included: an edge both sides hold takes
// theirs' copy when ours' names a card this merge removed and theirs' names
// cards that live. The strings add e[id:from->to]. Found on a copy of the real
// brain: the app save, tombstoning the tab's stale copy of a card the disk had
// moved, took the tab's copy of the card's edge and dropped it as dangling —
// 12 of 12 edges of rescued cards, 5 that an arrange elsewhere had re-pointed.
console.log('\n— S2-L edges that followed a moved card —');
const withEdges = async (buf, edges) => {
  const { zip, canvas } = await parseKlypix(buf);
  canvas.connections = edges.map(([id, fromId, toId]) => ({ id, fromId, toId, relationship: 'relates_to' }));
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
const L_ROWS = [
  {
    // A sync moved k's edit to k′ and re-pointed its edge; ours still holds k
    // untouched, and the app save's tombstone (staleCopiesOf) removes it.
    name: 'L1 an edge the disk re-pointed onto a revived card survives the stale copy\'s tombstone',
    args: async () => ({
      base: await withEdges(await side({ live: { txt_k: pj('v0') } }), [['con_e', 'txt_k', 'txt_anchor']]),
      ours: await withEdges(await side({ live: { txt_k: pj('v0') } }), [['con_e', 'txt_k', 'txt_anchor']]),
      theirs: await withEdges(await side({ live: { [kRev('v0')]: pj('v1') }, bin: { txt_k: Fe(k0, 'v0') } }), [['con_e', kRev('v0'), 'txt_anchor']]),
      deletedIds: ['txt_k'],
    }),
    want: {
      union: 'live[k′=v1] bin[k:F(v0)] c[] e[e:k′->anchor]',
      receipts: 'live[k′=v1] bin[k:F(v0)] c[] e[e:k′->anchor]',
      '3way': 'live[k′=v1] bin[k:F(v0)] c[] e[e:k′->anchor]',
    },
  },
  {
    // An arrange elsewhere buried duplicate d2 into d1 and re-pointed d2's
    // edge onto d1; ours still holds both, and the save tombstones d2.
    name: 'L2 an edge an arrange re-pointed onto the survivor survives the duplicate\'s tombstone',
    args: async () => ({
      base: await withEdges(await side({ live: { txt_d1: pj('dup'), txt_d2: pj('dup') } }), [['con_a', 'txt_d2', 'txt_anchor']]),
      ours: await withEdges(await side({ live: { txt_d1: pj('dup'), txt_d2: pj('dup') } }), [['con_a', 'txt_d2', 'txt_anchor']]),
      theirs: await withEdges(await side({ live: { txt_d1: pj('dup') }, bin: { txt_d2: binEntryFor({ id: 'txt_d2', json: pj('dup'), now: 1000, extra: { mergedInto: 'txt_d1' } }) } }), [['con_a', 'txt_d1', 'txt_anchor']]),
      deletedIds: ['txt_d2'],
    }),
    want: {
      union: 'live[d1=dup] bin[d2:F(dup)] c[] e[a:d1->anchor]',
      receipts: 'live[d1=dup] bin[d2:F(dup)] c[] e[a:d1->anchor]',
      '3way': 'live[d1=dup] bin[d2:F(dup)] c[] e[a:d1->anchor]',
    },
  },
  {
    // Both copies name the removed card: nothing to follow, the edge goes.
    name: 'L3 an edge whose every copy names a removed card is still dropped',
    args: async () => ({
      base: await withEdges(await side({ live: { txt_k: pj('v0') } }), [['con_e', 'txt_k', 'txt_anchor']]),
      ours: await withEdges(await side({ live: { txt_k: pj('v0') } }), [['con_e', 'txt_k', 'txt_anchor']]),
      theirs: await withEdges(await side({ bin: { txt_k: Fe(k0, 'v0') } }), [['con_e', 'txt_k', 'txt_anchor']]),
      deletedIds: ['txt_k'],
    }),
    want: { union: 'live[] bin[k:F(v0)] c[] e[]', receipts: 'live[] bin[k:F(v0)] c[] e[]', '3way': 'live[] bin[k:F(v0)] c[] e[]' },
  },
  {
    // Ours' copy names live cards: ours wins, as it always has.
    name: 'L4 our copy of an edge that lives still wins',
    args: async () => ({
      base: await withEdges(await side({ live: { txt_a: pj('a'), txt_b: pj('b'), txt_c: pj('c') } }), [['con_x', 'txt_a', 'txt_b']]),
      ours: await withEdges(await side({ live: { txt_a: pj('a'), txt_b: pj('b'), txt_c: pj('c') } }), [['con_x', 'txt_a', 'txt_c']]),
      theirs: await withEdges(await side({ live: { txt_a: pj('a'), txt_b: pj('b'), txt_c: pj('c') } }), [['con_x', 'txt_a', 'txt_b']]),
    }),
    want: { union: 'live[a=a b=b c=c] bin[] c[] e[x:a->c]', receipts: 'live[a=a b=b c=c] bin[] c[] e[x:a->c]', '3way': 'live[a=a b=b c=c] bin[] c[] e[x:a->c]' },
  },
];
{
  await runTable('L', 'binMerge', ['union', 'receipts', '3way'], L_ROWS, {}, { withEdges: true });
  // The 1.86.3 engine: the union column of L1 and L2 drops the edge.
  for (const name of ['L1', 'L2']) {
    const row = L_ROWS.find((r) => r.name.startsWith(name));
    const old = await summarize(await OLD.mergeBrains(await row.args()), { withEdges: true });
    ok(old !== row.want.union && / e\[\]$/.test(old), `L bite: the 1.86.3 engine drops the edge of row ${row.name} (${old})`);
  }
}

// ── S2-N newOnBothSides (E-5) ─────────────────────────────────────────────────
console.log('\n— S2-N newOnBothSides truth table —');
const N_ROWS = [
  {
    name: 'N1 new on both, same meaning',
    args: async () => ({ base: TEMPLATE, ours: await side({ live: { txt_n: cj('txt_n', 'same', { updatedAt: 1 }) } }), theirs: await side({ live: { txt_n: cj('txt_n', 'same', { updatedAt: 2 }) } }) }),
    want: { theirs: 'live[n=same] bin[] c[]', twin: 'live[n=same] bin[] c[]' },
  },
  {
    name: 'N2 new on both, diverged',
    args: async () => ({ base: TEMPLATE, ours: await side({ live: { txt_n: 'ours wording' } }), theirs: await side({ live: { txt_n: 'theirs wording' } }) }),
    want: { theirs: 'live[n=theirs wording] bin[] c[]', twin: 'live[n=ours wording n~=theirs wording] bin[] c[content-new-both]' },
  },
  {
    name: 'N3 diverged with no base at all',
    args: async () => ({ base: null, ours: await side({ live: { txt_n: 'ours wording' } }), theirs: await side({ live: { txt_n: 'theirs wording' } }) }),
    want: { theirs: 'live[n=ours wording n~=theirs wording] bin[] c[content-no-base]', twin: 'live[n=ours wording n~=theirs wording] bin[] c[content-no-base]' },
  },
  {
    name: 'N4 new on one side only',
    args: async () => ({ base: TEMPLATE, ours: TEMPLATE, theirs: await side({ live: { txt_n: 'agent card' } }) }),
    want: { theirs: 'live[n=agent card] bin[] c[]', twin: 'live[n=agent card] bin[] c[]' },
  },
  {
    // Found by the simulator's soak (I9, seed 172): both sides restored k from
    // one deletion (so both landed on the same k′, new on both since the
    // base) and theirs edited it since. The restore receipt names the bytes
    // it put back; ours still holds them, so theirs' text is an edit, not a
    // conflict (k′ kept the old text and the edit went beside it).
    name: 'N5 a card both sides restored from one deletion takes the edit made on it since',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v0') } }),
      ours: await side({ live: { [kRestoredAs('v0')]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2000) } }),
      theirs: await side({ live: { [kRestoredAs('v0')]: pj('v3') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2500) } }),
    }),
    want: { theirs: 'live[k′=v3] bin[k:R] c[]', twin: 'live[k′=v3] bin[k:R] c[]' },
  },
  {
    // The same with the edit on our side — which 'theirs' alone would drop.
    name: 'N6 the same, with the edit on our side',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v0') } }),
      ours: await side({ live: { [kRestoredAs('v0')]: pj('v3') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2000) } }),
      theirs: await side({ live: { [kRestoredAs('v0')]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2500) } }),
    }),
    want: { theirs: 'live[k′=v3] bin[k:R] c[]', twin: 'live[k′=v3] bin[k:R] c[]' },
  },
  {
    // Found by the certifying soak (seed 179 and 8 more): ours restored k
    // (k′, its receipt in ours' bin). A machine with no base after a crash
    // still held a stale k = v2 and met a cloud where k was deleted with v8:
    // it rescued v2 to revivedIdFor(k, F(v8)) — the very id ours' restore
    // uses — and holds only the deletion. Theirs never restored k, so its v2
    // is no edit of the restored bytes: both texts stay (taking it lost v8).
    name: 'N8 a value rescued to the id a restore uses is no edit of the restored bytes',
    args: async () => ({
      base: await side({ bin: { txt_k: pFe(k0, 'v8') } }),
      ours: await side({ live: { [kRestoredAs('v8')]: pj('v8') }, bin: { txt_k: pRe(k0, 'v8', kRestoredAs('v8')) } }),
      theirs: await side({ live: { [kRestoredAs('v8')]: pj('v2') }, bin: { txt_k: pFe(k0, 'v8') } }),
    }),
    want: { theirs: 'live[k′=v2] bin[k:R] c[]', twin: 'live[k′=v8 k′~=v2] bin[k:R] c[content-new-both]' },
  },
  {
    // Both sides edited the restored card: a real conflict.
    name: 'N7 a card both sides restored and both edited is new on both',
    args: async () => ({
      base: await side({ live: { txt_k: pj('v0') } }),
      ours: await side({ live: { [kRestoredAs('v0')]: pj('v3') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2000) } }),
      theirs: await side({ live: { [kRestoredAs('v0')]: pj('v4') }, bin: { txt_k: pRe(k0, 'v0', kRestoredAs('v0'), 2500) } }),
    }),
    want: { theirs: 'live[k′=v4] bin[k:R] c[]', twin: 'live[k′=v3 k′~=v4] bin[k:R] c[content-new-both]' },
  },
];
{
  for (const binMerge of ['receipts', '3way']) {
    const observed = await runTable(`N(${binMerge})`, 'newOnBothSides', ['theirs', 'twin'], N_ROWS, { binMerge });
    offBreaks(`N(${binMerge})`, observed, N_ROWS, 'twin', 'theirs', ['N2 new on both, diverged']);
  }
  const args = await N_ROWS[1].args();
  const r1 = await mergeBrains({ ...args, options: { binMerge: 'receipts', newOnBothSides: 'twin' } });
  const x = twinIdFor('txt_n', cj('txt_n', 'theirs wording'));
  ok((await liveIds(r1.buffer)).includes(x), 'N2: the twin is the deterministic slot for theirs\' value');
  const r2 = await mergeBrains({ base: args.base, ours: r1.buffer, theirs: args.theirs, options: { binMerge: 'receipts', newOnBothSides: 'twin' } });
  ok((await twinsOf(r2.buffer, 'txt_n')).length === 1, 'N2: re-merging the same pair keeps one twin (idempotent)');
  // N8 the other way round: the rescued value is ours, the restore theirs.
  const n8 = await N_ROWS.find((x) => x.name.startsWith('N8')).args();
  for (const binMerge of ['receipts', '3way']) {
    const got = await summarize(await mergeBrains({ base: n8.base, ours: n8.theirs, theirs: n8.ours, options: { binMerge, newOnBothSides: 'twin' } }));
    ok(got === 'live[k′=v2 k′~=v8] bin[k:R] c[content-new-both]', `N8 swapped (${binMerge}): the restored v8 and the rescued v2 both survive (${got})`);
  }
  // Found by the certifying soak (seed 78, a fleet with a legacy machine): a
  // stale copy of the old id routed through the restore receipt arrived at
  // k′ by matching the copy that holds the restored bytes, and theirs had
  // edited its own restore there. Taking theirs' text replaced the copy the
  // moved value had arrived at, and the merge threw (E-13). A value this merge
  // moved to the card keeps the card's copy; theirs' edit stays beside it.
  const n9 = async (engine) => {
    const kR = kRestoredAs('v0');
    const a = {
      base: await side({ bin: { txt_k: pFe(k0, 'v0') } }),
      ours: await side({ live: { txt_k: pj('v0'), [kR]: pj('v0') }, bin: { txt_k: pRe(k0, 'v0', kR) } }),
      theirs: await side({ live: { [kR]: pj('v3') }, bin: { txt_k: pRe(k0, 'v0', kR) } }),
    };
    const out = [];
    for (const binMerge of ['receipts', '3way']) {
      try { out.push(await summarize(await engine.mergeBrains({ ...a, options: { binMerge, newOnBothSides: 'twin' } }))); } catch (e) { out.push(`threw ${e.message}`); }
    }
    return out;
  };
  const n9got = await n9({ mergeBrains });
  ok(n9got.every((g) => g === 'live[k′=v0 k′~=v3] bin[k:R] c[content-new-both]'), `N9: a value moved onto a restore keeps it; the edit made on the restore stays beside it, nothing lost and no throw (${n9got.join(' | ')})`);
  N9_CHECK.push(n9);
}

// ── S2-M manifestMerge (E-7) ──────────────────────────────────────────────────
console.log('\n— S2-M manifestMerge truth table —');
{
  const titled = (title, extra = {}) => withManifest(TEMPLATE, { title, ...extra });
  const titleOf = async (res) => {
    const { manifest } = await parseKlypix(res.buffer);
    const c = res.conflicts.find((x) => x.kind === 'title' || x.kind === 'title-no-base');
    return `${manifest.title}${c ? ` !${c.kind}` : ''}${manifest.cloud ? ` cloud=${manifest.cloud.id}` : ''}`;
  };
  const M_ROWS = [
    { name: 'M1 nobody renamed', o: 'A', t: 'A', b: 'A', want: { theirs: 'A', '3way': 'A', ours: 'A' } },
    { name: 'M2 only theirs renamed', o: 'A', t: 'T', b: 'A', want: { theirs: 'T', '3way': 'T', ours: 'A' } },
    { name: 'M3 only ours renamed', o: 'O', t: 'A', b: 'A', want: { theirs: 'A', '3way': 'O', ours: 'O' } },
    { name: 'M4 both renamed, differently', o: 'O', t: 'T', b: 'A', want: { theirs: 'T', '3way': 'O !title', ours: 'O' } },
    { name: 'M5 both renamed alike', o: 'N', t: 'N', b: 'A', want: { theirs: 'N', '3way': 'N', ours: 'N' } },
    { name: 'M6 differ with no base', o: 'O', t: 'T', b: null, want: { theirs: 'T', '3way': 'T !title-no-base', ours: 'O' } },
    { name: 'M7 a stamp only ours carries survives', o: 'A', t: 'A', b: 'A', oCloud: { id: 'c1' }, want: { theirs: 'A cloud=c1', '3way': 'A cloud=c1', ours: 'A cloud=c1' } },
    { name: 'M8 a stamp both carry, differently', o: 'A', t: 'A', b: 'A', oCloud: { id: 'c-ours' }, tCloud: { id: 'c-theirs' }, want: { theirs: 'A cloud=c-theirs', '3way': 'A cloud=c-theirs', ours: 'A cloud=c-ours' } },
  ];
  const observed = {};
  for (const row of M_ROWS) {
    observed[row.name] = {};
    const base = row.b == null ? null : await titled(row.b);
    const ours = await titled(row.o, row.oCloud ? { cloud: row.oCloud } : {});
    const theirs = await titled(row.t, row.tCloud ? { cloud: row.tCloud } : {});
    for (const value of ['theirs', '3way', 'ours']) {
      const got = await titleOf(await mergeBrains({ base, ours, theirs, options: { binMerge: 'receipts', manifestMerge: value } }));
      observed[row.name][value] = got;
      ok(got === row.want[value], `M ${row.name} [manifestMerge="${value}"] → ${row.want[value]}${got === row.want[value] ? '' : `   (got ${got})`}`);
    }
  }
  offBreaks('M', observed, M_ROWS, '3way', 'theirs', ['M3 only ours renamed', 'M4 both renamed, differently', 'M6 differ with no base']);
  offBreaks('M', observed, M_ROWS, '3way', 'ours', ['M2 only theirs renamed']);
  // M6: with no base, theirs' title is taken and ours' is what the conflict
  // reports, so a machine meeting the shared copy adopts it.
  const noBase = async (engine) => engine.mergeBrains({ base: null, ours: await titled('O'), theirs: await titled('T'), options: { binMerge: 'receipts', manifestMerge: '3way' } });
  const m6 = (await noBase({ mergeBrains })).conflicts.find((c) => c.kind === 'title-no-base');
  ok(m6?.kept === 'theirs' && m6.ours === 'O' && m6.theirs === 'T', 'M6: the no-base title conflict says theirs was kept and names ours');
  TITLE_CHECK.push(async (engine) => titleOf(await noBase(engine)));
  const union = await titleOf(await mergeBrains({ base: await titled('A'), ours: await titled('O'), theirs: await titled('A') }));
  ok(union === 'A', 'M: no options keeps 1.86.3\'s theirs-first title (app save is unchanged)');
}

// ── S2-Z one order, whichever side is ours ────────────────────────────────────
// Review round 2 (convergence #5): the merge listed theirs' order first, so for
// two cards added at the same height on two machines git's driver (ours = this
// checkout) and Brain Sync wrote opposite orders, and each rewrote the other's
// file on every round. Every merge now writes the cards by zKey, then id.
console.log('\n— S2-Z one order whichever side is ours —');
{
  const withPos = async (buffer, id, patch) => {
    const { zip, canvas } = await parseKlypix(buffer);
    canvas.positions[id] = { ...canvas.positions[id], ...patch };
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  };
  const shapeOf = async (buffer) => {
    const { canvas } = await parseKlypix(buffer);
    return (canvas.order || []).map((id) => `${id.replace(/^txt_/, '')}@${canvas.positions[id]?.zKey}`).join(' ');
  };
  const sortedByZ = async (buffer) => {
    const { canvas } = await parseKlypix(buffer);
    const z = (canvas.order || []).map((id) => canvas.positions[id]?.zKey);
    return z.every((k, i) => typeof k === 'string' && (i === 0 || z[i - 1] < k));
  };
  const OB = await buildKlypix({ title: 'order', cards: [{ id: 'txt_a', text: 'a' }, { id: 'txt_b', text: 'b' }] });   // a@a0 b@a1
  const added = async (id, zKey) => withPos(await putItem(OB, id, cj(id, id)), id, { zKey });
  const MODES = [['union', undefined], ['receipts', { binMerge: 'receipts' }]];
  const both = async (engine, x, y, options) => [
    await shapeOf((await engine.mergeBrains({ base: OB, ours: x, theirs: y, ...(options ? { options } : {}) })).buffer),
    await shapeOf((await engine.mergeBrains({ base: OB, ours: y, theirs: x, ...(options ? { options } : {}) })).buffer),
  ];

  // Z1: each machine adds a card on top — both get the key a2. Either way
  // round, one order and one set of keys; merged again, nothing moves.
  const onX = await added('txt_x', 'a2'), onY = await added('txt_y', 'a2');
  const o1 = async (engine) => {
    const got = [];
    for (const [, options] of MODES) got.push(...await both(engine, onX, onY, options));
    return got;
  };
  const O1_WANT = 'a@a0 b@a1 x@a2 y@a3';
  const o1got = await o1({ mergeBrains });
  ok(o1got.every((g) => g === O1_WANT), `Z1: two cards added on top on two machines merge to one order either way round, in every mode → ${O1_WANT}${o1got.every((g) => g === O1_WANT) ? '' : `   (got ${o1got.join(' | ')})`}`);
  const once = (await mergeBrains({ base: OB, ours: onX, theirs: onY })).buffer;
  const again = await shapeOf((await mergeBrains({ base: once, ours: once, theirs: once })).buffer);
  ok(again === O1_WANT, `Z1: a merge of the result leaves its order as it is${again === O1_WANT ? '' : `   (got ${again})`}`);
  ORDER_CHECK.push(async (engine) => (await o1(engine)).every((g) => g === O1_WANT));

  // Z2: both add a card between a and b (the key a0V on both). The second
  // one's new key goes between its neighbours: b keeps a1 (an append after
  // a0V would have made a1 again and pushed b's key along).
  const midX = await added('txt_x', 'a0V'), midY = await added('txt_y', 'a0V');
  const o2 = async (engine) => {
    const got = [];
    for (const [, options] of MODES) got.push(...await both(engine, midX, midY, options));
    return got;
  };
  const o2got = await o2({ mergeBrains });
  const O2_WANT = 'a@a0 x@a0V y@a0l b@a1';
  const o2ok = (g) => g === O2_WANT;
  ok(o2got.every(o2ok), `Z2: a key made for a duplicate lands between its neighbours, and b keeps a1 → ${O2_WANT}${o2got.every(o2ok) ? '' : `   (got ${o2got.join(' | ')})`}`);
  ORDER_CHECK.push(async (engine) => (await o2(engine)).every(o2ok));

  // Z3: a conflict twin minted in the merge has no key: it goes on top, and
  // the result is still sorted by zKey.
  const twinRes = await mergeBrains({ base: OB, ours: await setText(onX, 'txt_a', 'a on x'), theirs: await setText(onY, 'txt_a', 'a on y') });
  const twinShape = await shapeOf(twinRes.buffer);
  ok(await sortedByZ(twinRes.buffer) && /^a@a0 b@a1 x@a2 y@a3 a__agconf_\w+@a4$/.test(twinShape), `Z3: a twin minted in the merge goes on top, keyed after the rest${/a__agconf_/.test(twinShape) ? '' : `   (got ${twinShape})`}`);

  // Z4: a history restore writes the same order a merge does — a snapshot
  // whose order disagrees with its keys comes back sorted by zKey.
  const { restoreSnapshotAsMerge } = await import('../src/merge-brains.mjs');
  const reversed = await (async () => {
    const { zip, canvas } = await parseKlypix(OB);
    canvas.order = [...canvas.order].reverse();
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  })();
  const restored = await shapeOf((await restoreSnapshotAsMerge({ current: OB, snapshot: reversed, now: 5000 })).buffer);
  ok(restored === 'a@a0 b@a1', `Z4: a history restore writes its order sorted by zKey${restored === 'a@a0 b@a1' ? '' : `   (got ${restored})`}`);
}

// ── S2-V theirsTrust (E-6) ────────────────────────────────────────────────────
// 'unverified' is for foreign bytes with no proven ancestry (Stage 3): nothing
// theirs holds may delete, overwrite or move one of our cards.
console.log('\n— S2-V theirsTrust truth table —');
const V_ROWS = [
  {
    name: 'V1 only theirs edited',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await side({ live: { txt_k: 'v1' } }) }),
    want: { descendant: 'live[k=v1@24] bin[] c[]', unverified: 'live[k=v0@24 k~=v1@48] bin[] c[content-unverified]' },
  },
  {
    name: 'V2 a purge only theirs holds (q6)',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await side({ bin: { txt_k: Pe(k0, 'v0') } }) }),
    want: { descendant: 'live[] bin[k:P] c[]', unverified: 'live[k=v0@24] bin[] c[]' },
  },
  {
    name: 'V3 a full entry only theirs holds',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await side({ bin: { txt_k: Fe(k0, 'v0') } }) }),
    want: { descendant: 'live[] bin[k:F(v0)] c[]', unverified: 'live[k=v0@24] bin[] c[]' },
  },
  {
    name: 'V4 a restore only theirs holds',
    args: async () => ({
      base: await side({ live: { txt_k: 'v0' } }),
      ours: await side({ live: { txt_k: 'v1' } }),
      theirs: await side({ live: { [kRev('v0')]: cj(kRev('v0'), 'v0') }, bin: { txt_k: Re(k0, 'v0', kRev('v0')) } }),
    }),
    want: { descendant: 'live[k′=v0@24 k′~=v1@48] bin[k:R] c[revived]', unverified: 'live[k=v1@24 k′=v0@24] bin[] c[]' },
  },
  {
    name: 'V5 only theirs moved the card',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: await withPos(await side({ live: { txt_k: 'v0' } }), k0, { x: 900 }) }),
    want: { descendant: 'live[k=v0@900] bin[] c[]', unverified: 'live[k=v0@24] bin[] c[]' },
  },
  {
    name: 'V6 a card only theirs added',
    args: async () => ({ base: TEMPLATE, ours: TEMPLATE, theirs: await side({ live: { txt_n: 'foreign card' } }) }),
    want: { descendant: 'live[n=foreign card@24] bin[] c[]', unverified: 'live[n=foreign card@24] bin[] c[]' },
  },
  {
    name: 'V7 theirs lacks our card with no receipt',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'v0' } }), theirs: TEMPLATE }),
    want: { descendant: 'live[k=v0@24] bin[] c[]', unverified: 'live[k=v0@24] bin[] c[]' },
  },
  {
    name: 'V8 our own purge still drops their stale copy',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ bin: { txt_k: Pe(k0, 'v0') } }), theirs: await side({ live: { txt_k: 'v0' } }) }),
    want: { descendant: 'live[] bin[k:P] c[]', unverified: 'live[] bin[k:P] c[]' },
  },
  {
    name: 'V9 theirs\' entry never replaces ours',
    args: async () => ({ base: TEMPLATE, ours: await side({ bin: { txt_k: Fe(k0, 'v-ours') } }), theirs: await side({ bin: { txt_k: Pe(k0, 'v0') } }) }),
    want: { descendant: 'live[] bin[k:P] c[]', unverified: 'live[] bin[k:F(v-ours)] c[]' },
  },
];
{
  const observed = await runTable('V', 'theirsTrust', ['descendant', 'unverified'], V_ROWS, { binMerge: 'receipts' }, { withX: true });
  offBreaks('V', observed, V_ROWS, 'unverified', 'descendant', [
    'V1 only theirs edited', 'V2 a purge only theirs holds (q6)', 'V3 a full entry only theirs holds',
    'V4 a restore only theirs holds', 'V5 only theirs moved the card', 'V9 theirs\' entry never replaces ours',
  ]);
  // Assets: under 'unverified' our bytes win a path both carry.
  const withAsset = async (b, bytes) => { const { zip } = await parseKlypix(b); zip.file('assets/img_1', Buffer.from(bytes)); return rezip(zip); };
  const [ao, at] = [await withAsset(TEMPLATE, 'ours bytes'), await withAsset(TEMPLATE, 'theirs bytes')];
  const assetOf = async (res) => (await parseKlypix(res.buffer)).zip.file('assets/img_1').async('string');
  ok(await assetOf(await mergeBrains({ base: TEMPLATE, ours: ao, theirs: at, options: { binMerge: 'receipts' } })) === 'theirs bytes' &&
    await assetOf(await mergeBrains({ base: TEMPLATE, ours: ao, theirs: at, options: { binMerge: 'receipts', theirsTrust: 'unverified' } })) === 'ours bytes',
  'V10: a shared asset path takes theirs\' bytes when descendant, ours when unverified');
}

// ── S2-A adoptResolvedConflicts (E-1b) ────────────────────────────────────────
// The same conflict resolved on the other side first (git, or another
// machine): its twin already holds our text. Adopting that resolution keeps
// both texts live without a second, redundant twin.
console.log('\n— S2-A adoptResolvedConflicts truth table —');
const A_ROWS = [
  {
    name: 'A1 theirs resolved it the other way round',
    args: async () => {
      const y = twinIdFor(k0, cj(k0, 'O1'));
      return { base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'O1' } }), theirs: await side({ live: { txt_k: 'T1', [y]: cj(k0, 'O1') } }) };
    },
    want: { false: 'live[k=O1 k~=O1 k~=T1] bin[] c[content]', true: 'live[k=T1 k~=O1] bin[] c[content]' },
  },
  {
    name: 'A2 both resolved it, in opposite orientations (pinned residual)',
    args: async () => {
      const x = twinIdFor(k0, cj(k0, 'T1')), y = twinIdFor(k0, cj(k0, 'O1'));
      return { base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'O1', [x]: cj(k0, 'T1') } }), theirs: await side({ live: { txt_k: 'T1', [y]: cj(k0, 'O1') } }) };
    },
    want: { false: 'live[k=O1 k~=O1 k~=T1] bin[] c[content]', true: 'live[k=O1 k~=O1 k~=T1] bin[] c[content]' },
  },
  {
    name: 'A3 theirs resolved it, but ours deleted that twin since',
    args: async () => {
      const y = twinIdFor(k0, cj(k0, 'O1'));
      return {
        base: await side({ live: { txt_k: 'v0', [y]: cj(k0, 'O1') } }),
        ours: await side({ live: { txt_k: 'O1' } }),
        theirs: await side({ live: { txt_k: 'T1', [y]: cj(k0, 'O1') } }),
        deletedIds: [y],
      };
    },
    want: { false: 'live[k=O1 k~=T1] bin[k~:F(O1)] c[content]', true: 'live[k=O1 k~=T1] bin[k~:F(O1)] c[content]' },
  },
  {
    name: 'A4 an unresolved conflict',
    args: async () => ({ base: await side({ live: { txt_k: 'v0' } }), ours: await side({ live: { txt_k: 'O1' } }), theirs: await side({ live: { txt_k: 'T1' } }) }),
    want: { false: 'live[k=O1 k~=T1] bin[] c[content]', true: 'live[k=O1 k~=T1] bin[] c[content]' },
  },
];
{
  for (const binMerge of ['receipts', '3way']) {
    const observed = await runTable(`A(${binMerge})`, 'adoptResolvedConflicts', [false, true], A_ROWS, { binMerge });
    offBreaks(`A(${binMerge})`, observed, A_ROWS, true, false, ['A1 theirs resolved it the other way round']);
  }
  const a1 = await mergeBrains({ ...(await A_ROWS[0].args()), options: { binMerge: '3way', adoptResolvedConflicts: true } });
  ok(a1.conflicts.some((c) => c.adopted === true && c.keptLive === 'theirs') && a1.delta.updated.includes(k0),
    'A1: the adoption is reported and counts as an update of k');
}

// ── S2-X rules that are not options, switched off in a mutated engine ────────
// Each mutant is the real engine source with ONE rule changed (the target
// text must exist exactly once, so a refactor cannot silently retire a
// mutation). The named row — or the named invariant — must then fail.
console.log('\n— S2-X mutation checks (one rule off at a time) —');
{
  const MUT_DIR = path.join(ROOT, 'test', `.mutants-${process.pid}`);
  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'merge-brains.mjs'), 'utf8');
  const mutant = async (name, find, replace) => {
    if (SRC.split(find).length !== 2) return null;
    fs.mkdirSync(MUT_DIR, { recursive: true });
    const file = path.join(MUT_DIR, `${name}.mjs`);
    fs.writeFileSync(file, SRC.replace(find, replace).replaceAll("from './", "from '../../src/"));
    return import(pathToFileURL(file).href);
  };
  const rowOf = (name) => B_ROWS.find((r) => r.name.startsWith(name)) || V_ROWS.find((r) => r.name.startsWith(name)) || N_ROWS.find((r) => r.name.startsWith(name)) || L_ROWS.find((r) => r.name.startsWith(name));
  const runWith = async (engine, rowName, options, view = {}) => {
    const row = rowOf(rowName);
    try { return await summarize(await engine.mergeBrains({ ...(await row.args()), options }), view); } catch (e) { return `threw ${e.message}`; }
  };
  const MUTATIONS = [
    {
      rule: 'P-a (a purge drops every live copy)',
      find: "      drops.push({ S, side, from: id, v, at: id, kind: 'P' });",
      replace: "      moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'edit' }); return;",
      row: 'B4', options: { binMerge: 'receipts' },
    },
    {
      rule: 'edit-beats-delete (R5: an unseen edit revives)',
      find: "    moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'edit' });",
      replace: "    drops.push({ S, side, from: id, v, at: id, kind: 'F' });",
      row: 'B3', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a stale copy of the deleted bytes drops',
      find: "      drops.push({ S, side, from: id, v, at: id, kind: 'F' });",
      replace: "      moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'edit' });",
      row: 'B1', options: { binMerge: 'receipts' },
    },
    {
      rule: 'the 3way resurrection cell (a committed revert comes back)',
      find: '      if (threeWay && !live(B, id) && eb &&',
      replace: '      if (false && !live(B, id) && eb &&',
      row: 'B8', options: { binMerge: '3way' },
    },
    {
      rule: 'the resurrection cell is 3way only (path L keeps the delete)',
      find: '      if (threeWay && !live(B, id) && eb &&',
      replace: '      if (!live(B, id) && eb &&',
      row: 'B8', options: { binMerge: 'receipts' },
    },
    {
      rule: 'the total order picks the entry (no clock)',
      find: '  const maxEntry = (id, list) => list.reduce((w, e) => (e ? pickBinEntry(id, w, e) : w), null);',
      replace: '  const maxEntry = (id, list) => list.reduce((w, e) => (e ? (!w || Number(e.meta?.deletedAt || 0) > Number(w.meta?.deletedAt || 0) ? e : w) : w), null);',
      row: 'B5', options: { binMerge: 'receipts' },
    },
    {
      rule: 'no receipt, no purge (the base\'s entry counts)',
      find: '    : maxEntry(id, [eOf(O, id), eOf(T, id), eOf(B, id)]));',
      replace: '    : maxEntry(id, [eOf(O, id), eOf(T, id)]));',
      row: 'B9', options: { binMerge: 'receipts' },
    },
    {
      rule: 'E-11 (a tombstone buries from the base\'s bytes)',
      find: '        const json = O.items[id] ?? T.items[id] ?? baseItem(id) ?? null;',
      replace: '        const json = O.items[id] ?? T.items[id] ?? null;',
      row: 'B10', options: { binMerge: 'receipts' },
    },
    {
      rule: 'fates before routing (a dead target is never landed on)',
      find: '      if (f.alive) return landIntoAlive(mv, t);',
      replace: '      if (true) return landIntoAlive(mv, t);',
      row: 'B11', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a purge outranks delete-vs-edit',
      find: '      if (lt && live(B, id) && !sameMeaning(T.items[id], B.items[id]) && !purged) {',
      replace: '      if (lt && live(B, id) && !sameMeaning(T.items[id], B.items[id])) {',
      row: 'B14', options: { binMerge: 'receipts' },
    },
    {
      rule: 'an edge follows the card that moved, over a copy pointing at the retired id',
      find: '    connMap.set(id, t && !endsLive(c) && endsLive(t) ? t : c);',
      replace: '    connMap.set(id, c);',
      edge: true,
    },
    {
      rule: 'union too: an edge the disk re-pointed survives the stale copy\'s tombstone',
      find: '    connMap.set(id, t && !endsLive(c) && endsLive(t) ? t : c);',
      replace: "    connMap.set(id, opt.binMerge !== 'union' && t && !endsLive(c) && endsLive(t) ? t : c);",
      row: 'L1', options: {}, key: 'union', view: { withEdges: true },
    },
    {
      rule: 'an edge end follows a move made on the other side',
      find: "    if (movedTo.size) for (const [id, c] of connMap) {",
      replace: '    if (false) for (const [id, c] of connMap) {',
      edge2: true,
    },
    {
      rule: 'a stale copy of a card restored and edited since is superseded, not lost',
      find: '(liveAt(arrived.get(key), mv.v) || supersededAt(arrived.get(key), mv.v))',
      replace: 'liveAt(arrived.get(key), mv.v)',
      row: 'B18', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a side holding the card under its earlier id has not deleted it',
      find: '    if (del.has(id) && !heldUnderEarlierId.has(id)) {',
      replace: '    if (del.has(id)) {',
      row: 'B21', options: { binMerge: 'receipts' },
    },
    {
      rule: 'every side lacking the card must hold it under its earlier id',
      find: "      if ((live(O, t) || sides.has('O')) && (live(T, t) || sides.has('T'))) heldUnderEarlierId.add(t);",
      replace: '      heldUnderEarlierId.add(t);',
      row: 'B24', options: { binMerge: 'receipts' },
    },
    {
      rule: 'an edit of exactly what the landing holds lands on it',
      find: "    if (!unverified && madeOn != null && !landed.has(t) && (!live(mv.S, t) || sameMeaning(mv.S.items[t], madeOn)) && live(other, t) && !folded.has(t) && sameMeaning(other.items[t], madeOn)) {",
      replace: '    if (false) {',
      row: 'B26', options: { binMerge: 'receipts' },
    },
    {
      rule: 'what a copy was made on comes from a live base value, never from bin bytes',
      find: '    const madeOn = baseItem(mv.from);',
      replace: "    const madeOn = baseItem(mv.from) ?? (eOf(B, mv.from) && entryKind(eOf(B, mv.from).meta) === 'F' ? eOf(B, mv.from).json : null);",
      row: 'B33', options: { binMerge: 'receipts' },
    },
    {
      rule: "the side still holding a restore's bytes has not edited the card",
      find: '      } else if (!cb && diverged && B && !unverified && editsItsRestore(id)) {',
      replace: '      } else if (false) {',
      row: 'N5', options: { binMerge: 'receipts', newOnBothSides: 'twin' }, key: 'twin',
    },
    {
      rule: 'only a side that restored the card itself edited its restore',
      find: '    return o !== t && restoredHere.get(o ? T : O).has(id);',
      replace: '    return o !== t;',
      row: 'N8', options: { binMerge: 'receipts', newOnBothSides: 'twin' }, key: 'twin',
    },
    {
      rule: 'a value moved onto a restore is never replaced by the other side\'s edit',
      find: '    if (arrivedAt.has(id)) return false;',
      replace: '',
      n9: true,
    },
    {
      rule: 'a restore sends the copy after the card',
      find: "    if (kind === 'R') { moves.push({ S, side, from: id, v, target: E.meta.restoredAs, via: 'restore' }); return; }",
      replace: '',
      row: 'B17', options: { binMerge: 'receipts' },
    },
    {
      rule: 'twins a person deleted since the base stay deleted',
      find: "      if (state === 'dead' && suppressDeleted && suppressDeleted(x, v, side)) return { twin: x, suppressed: 'deleted-twin' };",
      replace: '',
      row: 'B15', options: { binMerge: 'receipts' },
    },
    {
      rule: 'only the side that kept its own text resolves a conflict by deleting the twin',
      find: "      if (side === 'theirs') return !!eOf(O, x);",
      replace: "      if (side === 'theirs') return !!(eOf(O, x) || eOf(T, x));",
      row: 'B25', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a purge reaches a restore the purging machine never saw (P-a)',
      find: '        reach(y, k, P, k, rid);',
      replace: '',
      row: 'B29', options: { binMerge: 'receipts' },
    },
    {
      rule: "a chain's landing is judged against the purged card's own bytes",
      find: '        reach(y, k, P, k, rid);',
      replace: '        reach(y, k, P, x, receiptIdentity(x, r.meta, r.json));',
      row: 'B34', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a restored card a purge takes untouched is reported to the side that held it',
      find: "        else conflicts.push({ id, kind: 'purge-reached-restore', side, purgedWith: via.root });",
      replace: '',
      row: 'B29', options: { binMerge: 'receipts' },
    },
    {
      rule: 'an edit a purge takes from a landing in Deleted cards is reported',
      find: "    conflicts.push({ id: y, kind: 'purge-vs-edit', side: 'bin', purgedWith: via.root }); binEditsPurged++;",
      replace: '',
      row: 'B43', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a derived receipt is derived again from the purge that wins now',
      find: '    if (P) reach(y, root, P, null, null);',
      replace: '',
      groupings: true,
    },
    {
      rule: 'a value routed onto a permanently deleted card drops (P-a)',
      find: "        drops.push({ ...mv, at: t, kind: 'P', chain: true });",
      replace: '        return landFresh(mv, revivedIdFor(t, E.meta, E.json));',
      row: 'B35', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a side whose own bin deletes the landing does not hold it under an earlier id',
      find: 'if (t && !live(S, t) && !eOf(S, t) && sameMeaning(S.items[k], B.items[t]))',
      replace: 'if (t && !live(S, t) && sameMeaning(S.items[k], B.items[t]))',
      row: 'B36', options: { binMerge: 'receipts' },
    },
    {
      rule: 'routing follows a restore receipt to where the restore landed',
      find: "      if (kind === 'R') { t = E.meta.restoredAs; continue; }",
      replace: "      if (kind === 'R') { t = revivedIdFor(t, E.meta, E.json); continue; }",
      row: 'B37', options: { binMerge: 'receipts' },
    },
    {
      rule: 'only a twin deleted since the base resolves a conflict',
      find: "      if (!e || entryKind(e.meta) !== 'F' || !sameMeaning(e.json, v) || eOf(B, x)) return false;",
      replace: "      if (!e || entryKind(e.meta) !== 'F' || !sameMeaning(e.json, v)) return false;",
      row: 'B38', options: { binMerge: 'receipts' },
    },
    {
      rule: 'a value of ours is suppressed only by a twin theirs deleted',
      find: "      if (side === 'ours') return !!eOf(T, x);",
      replace: "      if (side === 'ours') return !!(eOf(O, x) || eOf(T, x));",
      row: 'B39', options: { binMerge: 'receipts' },
    },
    {
      rule: "a side's own entry for its own live card never kills it",
      find: '    live(O, id) ? null : eOf(O, id),',
      replace: '    eOf(O, id),',
      row: 'B40', options: { binMerge: 'receipts' },
    },
    {
      rule: 'the fold also lands an edit when its own side holds the landing at the value it was made on',
      find: '(!live(mv.S, t) || sameMeaning(mv.S.items[t], madeOn))',
      replace: '!live(mv.S, t)',
      row: 'B42', options: { binMerge: 'receipts' },
    },
    {
      rule: 'the fold never overwrites other text its own side holds at the landing',
      find: '(!live(mv.S, t) || sameMeaning(mv.S.items[t], madeOn))',
      replace: 'true',
      foldOwn: true,
    },
    {
      rule: 'one order whichever side is ours (the cards by zKey, then id)',
      find: '  const order = [...new Set(ids)].sort(byZ);',
      replace: '  const order = [...new Set(ids)];',
      order: 0,
    },
    {
      rule: 'a key made for a duplicate lands between its neighbours',
      find: '      z = generateKeyBetween(last, next);',
      replace: '      z = generateKeyBetween(last, null);',
      order: 1,
    },
    {
      rule: 'two purges reaching one landing: the total order picks its receipt',
      find: '    if (!had || pickBinEntry(landing, had.entry, entry) === entry) reached.set(landing, { entry, root, from, rid });',
      replace: '    if (!had) reached.set(landing, { entry, root, from, rid });',
      roots: true,
    },
    {
      rule: 'with no base, the title is theirs',
      find: '        manifest.title = tT;',
      replace: '        manifest.title = tO;',
      title: true,
    },
    {
      rule: 'a routing cycle lands at an id derived from the value',
      find: '    const c = `${stripRevived(mv.from)}__r_${sha12(`cycle\\n${mv.from}\\n${itemSignature(mv.v)}`)}`;',
      replace: '    const c = `${stripRevived(mv.from)}__r_${sha12(`cycle\\n${mv.from}`)}`;',
      cycle: true,
    },
    {
      rule: 'unverified: a foreign entry never kills our card',
      find: '    (live(T, id) || (unverified && live(O, id))) ? null : eOf(T, id),',
      replace: '    live(T, id) ? null : eOf(T, id),',
      row: 'V2', options: { binMerge: 'receipts', theirsTrust: 'unverified' }, view: { withX: true },
    },
    {
      rule: 'unverified: a one-sided foreign edit is twinned',
      find: '        if (unverified) {',
      replace: '        if (false) {',
      row: 'V1', options: { binMerge: 'receipts', theirsTrust: 'unverified' }, view: { withX: true },
    },
  ];
  for (const m of MUTATIONS) {
    const engine = await mutant(`m${MUTATIONS.indexOf(m)}`, m.find, m.replace);
    if (!engine) { ok(false, `X mutation target for "${m.rule}" is missing from src/merge-brains.mjs`); continue; }
    if (m.groupings) {
      const agree = await PURGE_GROUPINGS[0](engine);
      ok(!agree, `X "${m.rule}" off ⇒ check B-P's groupings disagree${!agree ? '' : ' — THEY DID NOT'}`);
      continue;
    }
    if (m.foldOwn) {
      let got;
      try { got = await FOLD_OWN_CHECK[0](engine); } catch (e) { got = `threw ${e.message}`; }
      const kept = ['v9', 'v11', 'v15'].every((v) => got.includes(`=${v}`));
      ok(!kept, `X "${m.rule}" off ⇒ check B-F fails${!kept ? ` (mutant: ${got})` : ' — IT DID NOT'}`);
      continue;
    }
    if (m.roots) {
      let held;
      try { held = await REACH_ROOTS[0](engine); } catch { held = false; }
      ok(!held, `X "${m.rule}" off ⇒ check B-P2 fails${!held ? '' : ' — IT DID NOT'}`);
      continue;
    }
    if (m.order != null) {
      let held;
      try { held = await ORDER_CHECK[m.order](engine); } catch { held = false; }
      ok(!held, `X "${m.rule}" off ⇒ case Z${m.order + 1} fails${!held ? '' : ' — IT DID NOT'}`);
      continue;
    }
    if (m.title) {
      const got = await TITLE_CHECK[0](engine);
      ok(got !== 'T !title-no-base', `X "${m.rule}" off ⇒ row M6 fails${got !== 'T !title-no-base' ? ` (mutant: ${got})` : ' — IT DID NOT'}`);
      continue;
    }
    if (m.cycle) {
      const held = await CYCLE_CHECK[0](engine);
      ok(!held, `X "${m.rule}" off ⇒ check B-C fails${!held ? '' : ' — IT DID NOT'}`);
      continue;
    }
    if (m.n9) {
      const got = await N9_CHECK[0](engine);
      const broke = got.some((g) => g !== 'live[k′=v0 k′~=v3] bin[k:R] c[content-new-both]');
      ok(broke, `X "${m.rule}" off ⇒ case N9 fails${broke ? ` (mutant: ${got.join(' | ')})` : ' — IT DID NOT'}`);
      continue;
    }
    if (m.edge2) {
      const res = await engine.mergeBrains({ ...(await EDGE_ARGS[1]()), options: { binMerge: 'receipts' } });
      const c = (await parseKlypix(res.buffer)).canvas.connections?.find((x) => x.id === 'con_both');
      ok(!c, `X "${m.rule}" off ⇒ case B-E2 loses the edge${!c ? '' : ' — IT DID NOT'}`);
      continue;
    }
    if (m.edge) {
      const from = async (eng) => (await parseKlypix((await eng.mergeBrains({ ...(await EDGE_ARGS[0]()), options: { binMerge: 'receipts' } })).buffer))
        .canvas.connections?.find((c) => c.id === 'con_e')?.fromId ?? null;
      const real = await from({ mergeBrains }), got = await from(engine);
      ok(real !== null && got === null, `X "${m.rule}" off ⇒ case B-E loses the edge${got === null ? '' : ' — IT DID NOT'}`);
      continue;
    }
    const row = rowOf(m.row);
    const want = row.want[m.key ?? (m.options.theirsTrust === 'unverified' ? 'unverified' : m.options.binMerge)];
    const real = await runWith({ mergeBrains }, m.row, m.options, m.view);
    const got = await runWith(engine, m.row, m.options, m.view);
    ok(real === want && got !== want, `X "${m.rule}" off ⇒ row ${row.name} fails${got !== want ? ` (mutant: ${got})` : ' — IT DID NOT'}`);
  }

  // The invariants are load-bearing: break the merge underneath them and the
  // merge must THROW rather than write the damage.
  const e12 = await mutant('e12',
    '  const bin = [...fate].filter(([, f]) => !f.alive && f.entry).map(([id, f]) => [id, f.entry]);',
    "  const bin = [...fate].filter(([, f]) => !f.alive && f.entry && f.why !== 'receipt').map(([id, f]) => [id, f.entry]);");
  ok(e12 && /INVARIANT VIOLATED — removed 1 card\(s\) without a receipt/.test(await runWith(e12, 'B1', { binMerge: 'receipts' })),
    'X E-12: a merge that removes a live card without writing its entry throws');
  // The draft's p8a fold: a moved value folded into a live card it does not match.
  const e13 = await mutant('e13', '    if (twins.holds(t, mv.v)) return arrive(mv, t);', '    return arrive(mv, t);');
  ok(e13 && /INVARIANT VIOLATED — a moved value of txt_k is neither live nor in the bin/.test(await runWith(e13, 'B12', { binMerge: 'receipts' })),
    'X E-13: a merge that folds a rescued edit into a card holding other text throws');
  const e13drop = await mutant('e13drop',
    "    moves.push({ S, side, from: id, v, target: revivedIdFor(id, E.meta, E.json), via: 'edit' });",
    "    drops.push({ S, side, from: id, v, at: id, kind: 'F' });");
  ok(e13drop && /INVARIANT VIOLATED — dropped txt_k without its bytes in the bin/.test(await runWith(e13drop, 'B2', { binMerge: 'receipts' })),
    'X E-13: a merge that drops an edit whose bytes are not in the bin throws');

  fs.rmSync(MUT_DIR, { recursive: true, force: true });
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-brains: all assertions passed');
process.exit(failures ? 1 : 0);
