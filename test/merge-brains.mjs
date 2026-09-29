// Concurrency-critical merge regressions found by the 2026-08-01 audit, and the
// Stage-2 all-callers rules (deterministic twins E-1, receipt identities E-2,
// the option plumbing). Pure buffers only, except the git-driver agreement
// check, which runs the real driver on files under os.tmpdir().
//
// Every Stage-2 rule is also run through a FROZEN copy of the 1.86.3 engine
// (test/fixtures/engine-1.86.3) to prove the assertion catches the old
// behaviour — a test that passes on both engines proves nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
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
  let unadvertisedRefused = true;
  for (const mode of ['receipts', '3way'].filter((m) => !F.options.binMerge.includes(m))) {
    const e = await rejects(mergeBrains({ base, ours: base, theirs: base, options: { binMerge: mode } }));
    if (!e || !/not available/.test(e.message)) unadvertisedRefused = false;
  }
  ok(unadvertisedRefused, 'O10: an option mode this build does not advertise is refused, never run as union');
  ok((F.api >= 2) === F.options.binMerge.includes('receipts'), 'O11: api 2 is claimed exactly when option modes run');
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
      order: order.map(R),
      items: Object.fromEntries(order.map((id) => [R(id), items[id]])),
      positions: Object.fromEntries(order.map((id) => [R(id), canvas.positions[id]])),
      connections: canvas.connections, lines: canvas.lines, strokes: canvas.strokes, settings: canvas.settings,
      view: canvas.view, nextGroupNumber: canvas.nextGroupNumber,
      bin, manifest: man, delta, stats,
      conflicts: res.conflicts.map((c) => ({ ...c, ...(c.twin ? { twin: R(c.twin) } : {}) })),
      assets: Object.keys(zip.files).filter((p) => p.startsWith('assets/')).sort(),
    });
  };

  const SEEDS = 60;
  let agree = 0, withTwins = 0, withRemovals = 0, withBins = 0;
  const disagreements = [];
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
    let newC, oldC;
    try { newC = await canon(await mergeBrains(args), known); } catch (e) { newC = `threw ${e.message}`; }
    try { oldC = await canon(await OLD.mergeBrains(args), known); } catch (e) { oldC = `threw ${e.message}`; }
    if (newC === oldC) agree++; else disagreements.push(seed);
    const parsed = JSON.parse(newC.startsWith('threw') ? '{}' : newC);
    if ((parsed.conflicts || []).some((c) => c.twin)) withTwins++;
    if ((parsed.delta?.removed || []).length) withRemovals++;
    if (Object.keys(parsed.bin || {}).length) withBins++;
  }
  ok(agree === SEEDS, `U1: ${agree}/${SEEDS} seeded app-save/sync shapes merge identically to 1.86.3 modulo twin ids and rid${disagreements.length ? ` (differ: seeds ${disagreements.slice(0, 8).join(', ')})` : ''}`);
  ok(withTwins >= 5 && withRemovals >= 5 && withBins >= 5, `U2: the differential exercised twins (${withTwins}), removals (${withRemovals}) and carried bins (${withBins})`);
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-brains: all assertions passed');
process.exit(failures ? 1 : 0);
