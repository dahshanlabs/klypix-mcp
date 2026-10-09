// merge-readings — a card's saved READING is derived data to the merge.
//
// KLYPIX saves what it reads from a card's file on the card (READING_ITEM_FIELDS
// in klypix-format.mjs: derivedText and its kind, source, sha, time and
// visuals) — a document's text since klypix-app #445, a video's or voice note's
// transcript before it. Two machines that read the same card between syncs
// write those fields independently, and a merge that counted them as content
// kept a conflict twin of the card, or brought back a card the other side had
// deleted. The rules, for every caller (the app save's union, Brain Sync's and
// the git driver's option modes, and the driver's own committed-absence check):
//   I   IDENTITIES are 1.94's, byte for byte: bin identities, conflict-twin
//       ids and revived ids still hash the card WITH its reading, so receipts
//       and twins older engines minted keep naming the same bytes; a copy is
//       checked against a stored rid with holdsEntryBytes, which also accepts
//       the copy with a reading KLYPIX made since;
//   R1  copies that differ only in their reading are ONE card: no twin, no
//       content conflict — and the copy written has the better reading,
//       whichever side holds it;
//   R2  two different current readings are picked from the values alone, so
//       every machine and both transports write the same one;
//   R3  a current document reading beats a stale one (derivedTextSha no longer
//       names the bytes the card holds);
//   R4  a reading-only change never beats a delete: the delete wins;
//   R5  a real edit against a delete keeps today's behaviour (no-loss);
//   R6  a real edit on one side and a reading on the other: one card — the
//       edit, with the reading carried over while it is of the card's bytes;
//   R7  a real conflict on a card that also carries readings is still a twin;
//   R8  a paid reading (a cloud video analysis) survives an edit made on the
//       other machine;
//   R9  of two new readings the better one is kept: visuals, then cloud, then
//       the longer text (a local audio-only transcript never beats a cloud
//       analysis of the frames);
//   R10 the bin checks that compare a copy with a stored rid (fold over a
//       restore, a purge reaching a restore's twin, the desktop's undone
//       delete) see a card with a reading as the bytes that rid names.
// The frozen 1.86.3 engine is run on the same inputs to prove the assertions
// see the old behaviour, the golden identity values below were computed by the
// 1.94.0 engine, and each new merge path is switched off in a mutant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildKlypix, parseKlypix, shard, itemSignature, meaningSignature, sameMeaning, twinIdFor, fullEntryRid, revivedIdFor,
  binEntryFor, contentFreeReceiptFor, PURGED_BODY, holdsEntryBytes, pickReadingCopy, carryReading,
  READING_ITEM_FIELDS, VOLATILE_ITEM_FIELDS,
} from '../src/klypix-format.mjs';
import { mergeBrains, MERGE_ENGINE_FEATURES } from '../src/merge-brains.mjs';
import * as OLD from './fixtures/engine-1.86.3/merge-brains.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// ── Fixture helpers (the shapes test/merge-brains.mjs uses) ──────────────────
const rezip = (zip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const itemPath = (id) => `items/${shard(id)}/${id}.json`;
// Add (or overwrite) a live card: an object, or item JSON exactly as given.
const putItem = async (buffer, id, value) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.file(itemPath(id), typeof value === 'string' ? value : JSON.stringify(value));
  canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
  canvas.positions = canvas.positions || {};
  if (!canvas.order.includes(id)) canvas.order.push(id);
  canvas.positions[id] = canvas.positions[id] || { x: 40 * canvas.order.length, y: 40, w: 240, h: 120, parentId: null };
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
const changeItem = async (buffer, id, mutate) => {
  const { zip } = await parseKlypix(buffer);
  const item = JSON.parse(await zip.file(itemPath(id)).async('string'));
  zip.file(itemPath(id), JSON.stringify(mutate(item)));
  return rezip(zip);
};
const removeItem = async (buffer, id) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.remove(itemPath(id));
  canvas.order = (canvas.order || []).filter((x) => x !== id);
  if (canvas.positions) delete canvas.positions[id];
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
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
const readItem = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file(itemPath(id));
  return f ? JSON.parse(await f.async('string')) : null;
};
const readRaw = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file(itemPath(id));
  return f ? f.async('string') : null;
};
const cardsOf = async (buffer, k) => ((await parseKlypix(buffer)).canvas.order || []).filter((id) => id === k || id.startsWith(`${k}__`));
const binHas = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file('graveyard.json');
  return !!(f && JSON.parse(await f.async('string')).entries?.[id]);
};
const readingOf = (item) => Object.fromEntries(READING_ITEM_FIELDS.filter((f) => item && item[f] !== undefined).map((f) => [f, item[f]]));
// Equal as data: object keys in any order, arrays in order.
const canon = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val));
const same = (a, b) => canon(a) === canon(b);

// One document card and one video card, as the app saves them.
const DOC = {
  type: 'file', fileName: 'contract.pdf', fileSize: 9, extension: 'pdf', mimeType: 'application/pdf',
  assetId: 'doc1.pdf', assetSha: 'sha-1', locked: false, createdAt: 1, createdBy: 'user', updatedAt: 1,
};
const VID = {
  type: 'video', fileName: 'demo.mp4', fileSize: 10, extension: 'mp4', mimeType: 'video/mp4',
  assetId: 'vid1.mp4', locked: false, createdAt: 1, createdBy: 'user', updatedAt: 1,
};
// A document reading as klypix-app #445 writes it: no time stamp.
const READ = { derivedText: 'The whole contract, clause by clause: payment in 45 days.', derivedTextKind: 'document-text', derivedTextSource: 'local', derivedTextSha: 'sha-1' };
// A reading of bytes the card no longer holds — LONGER than the current one, so
// only the "current first" rule (not the length rank) can keep READ over it.
const STALE = { derivedText: 'An older version of the contract, clause by clause, from before the payment terms were changed to 45 days.', derivedTextKind: 'document-text', derivedTextSource: 'local', derivedTextSha: 'sha-0' };
// Media readings carry their time: two machines never write the same one.
const transcript = (text, at) => ({ derivedText: text, derivedTextKind: 'video-transcript', derivedTextSource: 'local', derivedTextVisuals: false, derivedTextAt: at });
// A video card whose real content is its tag, with a cloud transcript unless told otherwise.
const TRANSCRIPT = { derivedText: 'Speaker explains the zebra rollout.', derivedTextKind: 'video-transcript', derivedTextSource: 'cloud', derivedTextVisuals: false, derivedTextAt: 1_760_000_000_000 };
const ANALYSIS = { derivedText: 'A presenter at a whiteboard shows the zebra rollout chart.', derivedTextKind: 'video-analysis', derivedTextSource: 'cloud', derivedTextVisuals: true, derivedTextAt: 1_760_000_100_000 };
const LOCAL = { derivedText: 'Hello, this is the zebra rollout.', derivedTextKind: 'video-transcript', derivedTextSource: 'local', derivedTextVisuals: false, derivedTextAt: 1_760_000_000_000 };
const Vr = (tag, r = TRANSCRIPT, extra = {}) => JSON.stringify({ type: 'video', fileName: 'demo.mp4', assetId: 'vid1.mp4', tags: [tag], ...extra, ...(r || {}) });

const empty = await buildKlypix({ title: 'reading merges', cards: [{ id: 'txt_A', text: 'A note' }] });
const base = await putItem(await putItem(empty, 'fil_doc', DOC), 'vid_1', VID);
// A machine's save: the patch, plus its own touch stamp (volatile).
const saved = (buffer, id, patch, stamp) => changeItem(buffer, id, (it) => ({ ...it, ...patch, updatedAt: stamp }));
// A side that deleted the card in KLYPIX: gone from the board, its bytes in the bin.
const deletedIn = async (buffer, id) => (await mergeBrains({ base: buffer, ours: await removeItem(buffer, id), theirs: buffer, deletedIds: [id] })).buffer;
// A side built from live cards and bin entries, beside one fixed anchor card.
const TEMPLATE = await buildKlypix({ title: 'reading bins', cards: [{ id: 'txt_anchor', text: 'anchor' }] });
const sideOf = async ({ live = {}, bin = {} } = {}) => {
  let b = TEMPLATE;
  for (const [id, v] of Object.entries(live)) b = await putItem(b, id, v);
  if (Object.keys(bin).length) b = await withBin(b, bin);
  return b;
};
const tagsOf = async (buffer) => {
  const { zip, canvas } = await parseKlypix(buffer);
  const out = [];
  for (const id of canvas.order || []) if (id !== 'txt_anchor') out.push(JSON.parse(await zip.file(itemPath(id)).async('string')).tags?.[0]);
  return out;
};

const MODES = [
  ['union (the app save)', undefined],
  ['receipts (Brain Sync)', { binMerge: 'receipts' }],
  ['3way (the git driver)', { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true }],
];
const OPTION_MODES = MODES.slice(1);
const merge = (args, options) => mergeBrains({ ...args, ...(options ? { options } : {}) });

// ── I: identities are 1.94's, byte for byte ─────────────────────────────────
// Golden values computed by klypix-mcp 1.94.0 (origin/master 40ef457) for these
// exact values: a receipt or a twin an older engine minted must name the same
// bytes here, reading and all.
{
  const docRead = JSON.stringify({ ...DOC, ...READ, updatedAt: 99 });
  ok(fullEntryRid('fil_doc', docRead) === 'r_c5da9ef2a9495742', 'I: a bin identity (fullEntryRid) of a card with a reading is 1.94\'s');
  ok(twinIdFor('fil_doc', docRead) === 'fil_doc__agconf_4227a79350b7', 'I: a conflict-twin id of a card with a reading is 1.94\'s');
  ok(revivedIdFor('fil_doc', { deletedAt: 1 }, docRead) === 'fil_doc__r_01e6793aeabb', 'I: a revived id from an entry with no stored rid is 1.94\'s');
  const F = binEntryFor({ id: 'vid_k', json: Vr('v5'), now: 1000 });
  ok(F.meta.rid === 'r_ba4bb4ed3931bc41' && revivedIdFor('vid_k', F.meta, Vr('v5')) === 'vid_k__r_25e0c84dea84' && twinIdFor('vid_k', Vr('v5')) === 'vid_k__agconf_5c871d119442',
    'I: an entry minted for a transcribed video, and the ids derived from it, are 1.94\'s');
  const plain = JSON.stringify(DOC);
  ok(itemSignature(plain) !== itemSignature(docRead) && fullEntryRid('fil_doc', plain) !== fullEntryRid('fil_doc', docRead),
    'I: an identity names exact bytes — the reading included, as before');
  ok(same(VOLATILE_ITEM_FIELDS, ['updatedAt', 'zIndex', 'editedAt']), 'I: the volatile list itself is unchanged');
}

// ── The comparator: meaning leaves the reading out ──────────────────────────
{
  ok(same(READING_ITEM_FIELDS, ['derivedText', 'derivedTextKind', 'derivedTextSource', 'derivedTextSha', 'derivedTextAt', 'derivedTextVisuals']),
    'the reading fields are the app\'s READING_FIELD_KEYS, all six');
  const plain = JSON.stringify(DOC);
  const read = JSON.stringify({ ...DOC, ...READ, updatedAt: 99 });
  const edited = JSON.stringify({ ...DOC, tags: ['contract'] });
  ok(sameMeaning(plain, read) && meaningSignature(plain) === meaningSignature(read), 'a copy that differs only in its reading means the same');
  ok(!READING_ITEM_FIELDS.some((f) => meaningSignature(read).includes(`"${f}"`)), 'the meaning signature holds no reading field');
  ok(!sameMeaning(plain, edited) && !sameMeaning(read, edited), 'a real edit still differs');
  const F = binEntryFor({ id: 'fil_doc', json: plain, now: 1 });
  ok(holdsEntryBytes('fil_doc', plain, F.meta.rid) && holdsEntryBytes('fil_doc', read, F.meta.rid) && !holdsEntryBytes('fil_doc', edited, F.meta.rid),
    'holdsEntryBytes: the entry\'s bytes, and those bytes with a reading made since — not an edit');
  const Fr = binEntryFor({ id: 'fil_doc', json: read, now: 1 });
  ok(holdsEntryBytes('fil_doc', read, Fr.meta.rid) && !holdsEntryBytes('fil_doc', JSON.stringify({ ...DOC, ...STALE }), Fr.meta.rid)
    && !holdsEntryBytes('fil_doc', read, undefined) && !holdsEntryBytes('fil_doc', null, Fr.meta.rid),
    'holdsEntryBytes: an entry minted with a reading names that reading; no rid or no copy is never a match');
  ok(MERGE_ENGINE_FEATURES.derivedReadings === true, 'the engine advertises the rule (callers feature-check it)');
}

// ── The better reading: pickReadingCopy ─────────────────────────────────────
{
  const none = JSON.stringify(DOC);
  const cur = JSON.stringify({ ...DOC, ...READ });
  const stale = JSON.stringify({ ...DOC, ...STALE });
  ok(pickReadingCopy(cur, none) === 'ours' && pickReadingCopy(none, cur) === 'theirs', 'pickReadingCopy: a current reading beats none, on either side');
  ok(pickReadingCopy(cur, stale) === 'ours' && pickReadingCopy(stale, cur) === 'theirs', 'pickReadingCopy: a current reading beats a stale one');
  ok(pickReadingCopy(JSON.stringify({ ...DOC, ...READ, updatedAt: 5 }), JSON.stringify({ ...DOC, ...READ, updatedAt: 6 })) === 'ours',
    'pickReadingCopy: the same reading (a volatile difference only) keeps ours, as before');
  const v = (r) => JSON.stringify({ ...VID, ...r });
  const pick = (a, b) => [pickReadingCopy(v(a), v(b)), pickReadingCopy(v(b), v(a))];
  ok(same(pick(ANALYSIS, LOCAL), ['ours', 'theirs']), 'rank: a cloud analysis of the frames beats a local audio-only transcript, either way round');
  ok(same(pick({ ...LOCAL, derivedTextKind: 'video-analysis', derivedTextVisuals: true }, TRANSCRIPT), ['ours', 'theirs']),
    'rank: visuals come first — a local analysis of the frames beats a cloud transcript');
  ok(same(pick(TRANSCRIPT, { ...TRANSCRIPT, derivedTextSource: 'local' }), ['ours', 'theirs']), 'rank: then a cloud reading beats a local one');
  ok(same(pick({ ...LOCAL, derivedText: `${LOCAL.derivedText} And the pricing.` }, LOCAL), ['ours', 'theirs']), 'rank: then the longer text');
  const a = transcript('one take', 111), b = transcript('two take', 222);
  ok(same(pick(a, b), ['ours', 'theirs']) || same(pick(a, b), ['theirs', 'ours']), 'rank: a full tie is broken from the values alone (the same reading either way round)');

  // The reviewer's symmetry fuzz: random readings and bases, either way round.
  let asym = 0, n = 0;
  const rnd = (s) => { let x = s; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; };
  const R = rnd(42);
  const mk = () => {
    const k = R();
    if (k < 0.2) return JSON.stringify({ type: 'file', assetId: 'a1', assetSha: 's1', fileName: 'x.pdf' });
    if (k < 0.5) return JSON.stringify({ type: 'file', assetId: 'a1', assetSha: 's1', fileName: 'x.pdf', derivedText: 't' + Math.floor(R() * 4), derivedTextKind: 'document-text', derivedTextSource: 'local', derivedTextSha: R() < 0.5 ? 's1' : 's0' });
    return JSON.stringify({ type: 'file', assetId: 'a1', assetSha: 's1', fileName: 'x.pdf', updatedAt: Math.floor(R() * 3), derivedText: 'm' + Math.floor(R() * 4), derivedTextKind: R() < 0.5 ? 'video-transcript' : 'video-analysis', derivedTextSource: R() < 0.5 ? 'cloud' : 'local', derivedTextAt: Math.floor(R() * 3) });
  };
  const rf = (j) => JSON.stringify(Object.fromEntries(READING_ITEM_FIELDS.map((f) => [f, JSON.parse(j)[f]])));
  for (let i = 0; i < 20000; i++) {
    const o = mk(), t = mk();
    const w1 = pickReadingCopy(o, t) === 'ours' ? o : t, w2 = pickReadingCopy(t, o) === 'ours' ? t : o;
    n++;
    if (rf(w1) !== rf(w2)) asym++;
  }
  ok(asym === 0, `rank: the same reading is written either way round (${asym} asymmetric of ${n} random pairs)`);
}

// ── carryReading: a reading travels over an edit only while it is of the bytes ─
{
  const docEdit = JSON.stringify({ ...DOC, tags: ['contract'] });
  const docRead = JSON.stringify({ ...DOC, ...READ });
  const carried = JSON.parse(carryReading(docEdit, docRead));
  ok(carried.tags?.[0] === 'contract' && same(readingOf(carried), READ), 'carryReading: the edit, with the other copy\'s document text (same bytes)');
  const repacked = JSON.stringify({ ...DOC, assetSha: 'sha-2', tags: ['contract'] });
  ok(carryReading(repacked, docRead) === repacked, 'carryReading: an edit that replaced the file leaves the old file\'s text behind');
  ok(same(readingOf(JSON.parse(carryReading(docEdit, JSON.stringify({ ...DOC, assetSha: 'sha-2', ...READ })))), READ),
    'carryReading: what counts is the winner\'s bytes — a reading of the bytes the edit holds travels, stale on the other copy or not');
  const vidEdit = Vr('renamed', null), vidRead = Vr('v0', ANALYSIS);
  ok(same(readingOf(JSON.parse(carryReading(vidEdit, vidRead))), ANALYSIS), 'carryReading: a video analysis goes over an edit of the same video');
  ok(carryReading(Vr('renamed', null, { assetSha: 'sha-new' }), vidRead) === Vr('renamed', null, { assetSha: 'sha-new' }), 'carryReading: not onto a card that now holds another video');
  ok(carryReading(Vr('renamed', ANALYSIS), Vr('v0', LOCAL)) === Vr('renamed', ANALYSIS), 'carryReading: the edit keeps its own reading when that one is better');
  ok(same(readingOf(JSON.parse(carryReading(Vr('renamed', LOCAL), vidRead))), ANALYSIS), 'carryReading: the better reading replaces the edit\'s poorer one');
  ok(carryReading(docEdit, JSON.stringify({ ...DOC, ...STALE })) === docEdit, 'carryReading: a stale reading never travels');
  // (A video donor with no asset of its own: only the type rule stops this one.)
  ok(carryReading(JSON.stringify({ type: 'text', content: 'x' }), JSON.stringify({ type: 'video', ...TRANSCRIPT })) === JSON.stringify({ type: 'text', content: 'x' }),
    'carryReading: never across card types');
}

// ── R1: a reading on one side only — one card, and it keeps the reading ─────
{
  const readOne = await saved(base, 'fil_doc', READ, 1000);
  const untouched = await saved(base, 'fil_doc', {}, 2000);    // the other machine only re-saved
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours read it', readOne, untouched], ['theirs read it', untouched, readOne]]) {
      const r = await merge({ base, ours, theirs }, options);
      const card = await readItem(r.buffer, 'fil_doc');
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0, `R1 ${name}, ${label}: one card, no conflict`);
      ok(same(readingOf(card), READ), `R1 ${name}, ${label}: the card keeps the current reading`);
      if (label === 'theirs read it') ok(r.delta.updated.includes('fil_doc'), `R1 ${name}, ${label}: reported as updated from theirs`);
    }
  }
  // First sync (no base): the shape that used to twin every card.
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours read it', readOne, untouched], ['theirs read it', untouched, readOne]]) {
      const r = await merge({ base: null, ours, theirs }, options);
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0 && same(readingOf(await readItem(r.buffer, 'fil_doc')), READ),
        `R1 ${name}, no base, ${label}: one card, no content-no-base conflict, the reading kept`);
    }
  }
  // Both machines read the same bytes: identical fields, one card (klypix-app #445's own case).
  const readTwo = await saved(base, 'fil_doc', READ, 3000);
  for (const [name, options] of MODES) {
    const r = await merge({ base, ours: readOne, theirs: readTwo }, options);
    ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0, `R1 ${name}: the same document read on both machines is one card`);
  }
  // The 1.86.3 engine counted the reading as content: proof the checks see it.
  const old = await OLD.mergeBrains({ base: null, ours: readOne, theirs: untouched });
  ok((await cardsOf(old.buffer, 'fil_doc')).length === 2 && old.conflicts.some((c) => c.id === 'fil_doc' && c.kind === 'content-no-base'),
    'R1 control: the 1.86.3 engine twinned a card whose only difference was its reading');
}

// ── R2: two different current readings — one card, the same one everywhere ─
{
  const a = await saved(base, 'vid_1', transcript('Take one: the zebra feature.', 1_800_000_000_000), 1000);
  const b = await saved(base, 'vid_1', transcript('Take two: the zebra feature, again.', 1_800_000_999_000), 2000);
  const kept = [];
  for (const [name, options] of MODES) {
    for (const [ours, theirs] of [[a, b], [b, a]]) {
      for (const baseBuf of [base, null]) {
        const r = await merge({ base: baseBuf, ours, theirs }, options);
        ok(same(await cardsOf(r.buffer, 'vid_1'), ['vid_1']) && r.conflicts.length === 0,
          `R2 ${name}${baseBuf ? '' : ', no base'}, ${ours === a ? 'a/b' : 'b/a'}: two machines' transcripts are one card, no conflict`);
        kept.push(JSON.stringify(readingOf(await readItem(r.buffer, 'vid_1'))));
      }
    }
  }
  ok(new Set(kept).size === 1, 'R2: every mode, both orientations, with and without a base keep the SAME reading (no ours-first relay between git and Brain Sync)');
  const old = await OLD.mergeBrains({ base, ours: a, theirs: b });
  ok((await cardsOf(old.buffer, 'vid_1')).length === 2 && old.conflicts.some((c) => c.id === 'vid_1' && c.kind === 'content'),
    'R2 control: the 1.86.3 engine kept a twin of a card two machines had transcribed');
}

// ── R3: a current reading beats a stale one, whichever side holds it ─────────
{
  const atBase = await saved(base, 'fil_doc', STALE, 500);       // the base already holds the stale reading
  const stale = await saved(atBase, 'fil_doc', {}, 1000);
  const fresh = await saved(atBase, 'fil_doc', READ, 2000);
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours current', fresh, stale], ['theirs current', stale, fresh]]) {
      const r = await merge({ base: atBase, ours, theirs }, options);
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0 && same(readingOf(await readItem(r.buffer, 'fil_doc')), READ),
        `R3 ${name}, ${label}: one card, and the current reading wins over the stale one`);
    }
    const nb = await merge({ base: null, ours: await saved(base, 'fil_doc', STALE, 1), theirs: await saved(base, 'fil_doc', READ, 2) }, options);
    ok(same(readingOf(await readItem(nb.buffer, 'fil_doc')), READ) && nb.conflicts.length === 0, `R3 ${name}, no base: the current reading wins`);
  }
}

// ── R4: a reading-only change never beats a delete ───────────────────────────
{
  const read = await saved(base, 'fil_doc', READ, 1000);
  // Union (the app save): the tab tombstones the card while the disk copy was read.
  {
    const r = await mergeBrains({ base, ours: await removeItem(base, 'fil_doc'), theirs: read, deletedIds: ['fil_doc'] });
    ok((await cardsOf(r.buffer, 'fil_doc')).length === 0 && r.delta.removed.includes('fil_doc') && await binHas(r.buffer, 'fil_doc') && r.conflicts.length === 0,
      'R4 union, tombstone vs a read copy: the delete wins, the card goes to the bin, no delete-vs-edit');
    const old = await OLD.mergeBrains({ base, ours: await removeItem(base, 'fil_doc'), theirs: read, deletedIds: ['fil_doc'] });
    ok((await cardsOf(old.buffer, 'fil_doc')).length === 1 && old.conflicts.some((c) => c.kind === 'delete-vs-edit'),
      'R4 control: the 1.86.3 engine kept the card, calling the reading an edit');
  }
  // Union: our bin already holds the delete, the disk copy was read since.
  {
    const r = await mergeBrains({ base, ours: await deletedIn(base, 'fil_doc'), theirs: read });
    ok((await cardsOf(r.buffer, 'fil_doc')).length === 0 && await binHas(r.buffer, 'fil_doc') && r.conflicts.length === 0,
      'R4 union, a delete in our bin vs a read copy: the delete propagates');
  }
  // Option modes: the bin decides, either way round.
  for (const [name, options] of OPTION_MODES) {
    for (const [label, ours, theirs] of [['ours deleted', await deletedIn(base, 'fil_doc'), read], ['theirs deleted', read, await deletedIn(base, 'fil_doc')]]) {
      const r = await merge({ base, ours, theirs }, options);
      ok((await cardsOf(r.buffer, 'fil_doc')).length === 0 && r.delta.revived.length === 0 && await binHas(r.buffer, 'fil_doc')
        && !r.conflicts.some((c) => /delete|edit/.test(c.kind)), `R4 ${name}, ${label}: a read copy is a stale copy — the delete wins, nothing is revived`);
    }
  }
  // The git driver's committed-absence check (its own sameMeaning call).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-merge-readings-'));
  try {
    for (const [label, oursBuf, theirsBuf] of [['ours deleted', await removeItem(base, 'fil_doc'), read], ['theirs deleted', read, await removeItem(base, 'fil_doc')]]) {
      const [bp, ap, tp] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `${n}.klypix`));
      fs.writeFileSync(bp, base); fs.writeFileSync(ap, oursBuf); fs.writeFileSync(tp, theirsBuf);
      execFileSync(process.execPath, [path.join(ROOT, 'src', 'klypix-merge-driver.mjs'), bp, ap, tp, 'brain.klypix'], { stdio: ['ignore', 'pipe', 'pipe'] });
      ok((await cardsOf(fs.readFileSync(ap), 'fil_doc')).length === 0, `R4 git driver, ${label}: a committed delete of a card the other branch only read is honored`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── R5: a real edit against a delete keeps today's behaviour ─────────────────
{
  const edited = await saved(base, 'fil_doc', { tags: ['contract'] }, 1000);
  const editedAndRead = await saved(base, 'fil_doc', { tags: ['contract'], ...READ }, 1000);
  for (const [label, theirs] of [['an edit', edited], ['an edit and a reading', editedAndRead]]) {
    const r = await mergeBrains({ base, ours: await removeItem(base, 'fil_doc'), theirs, deletedIds: ['fil_doc'] });
    const card = await readItem(r.buffer, 'fil_doc');
    ok(card?.tags?.[0] === 'contract' && r.conflicts.some((c) => c.id === 'fil_doc' && c.kind === 'delete-vs-edit'),
      `R5 union, tombstone vs ${label}: the edited card is kept and the conflict reported (no-loss)`);
    for (const [name, options] of OPTION_MODES) {
      const o = await merge({ base, ours: await deletedIn(base, 'fil_doc'), theirs }, options);
      const back = o.delta.revived.find((x) => x.id === 'fil_doc');
      const revived = back ? await readItem(o.buffer, back.as) : null;
      ok(!!back && revived?.tags?.[0] === 'contract' && await binHas(o.buffer, 'fil_doc'),
        `R5 ${name}, a delete in the bin vs ${label}: the edit comes back under its revived id, the delete stays recorded`);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-merge-readings-'));
  try {
    const [bp, ap, tp] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `${n}.klypix`));
    fs.writeFileSync(bp, base); fs.writeFileSync(ap, await removeItem(base, 'fil_doc')); fs.writeFileSync(tp, edited);
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'klypix-merge-driver.mjs'), bp, ap, tp, 'brain.klypix'], { stdio: ['ignore', 'pipe', 'pipe'] });
    ok((await readItem(fs.readFileSync(ap), 'fil_doc'))?.tags?.[0] === 'contract', 'R5 git driver: a committed delete against a real edit keeps the edit, as before');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── R6: a real edit on one side, a reading on the other ──────────────────────
{
  const edited = await saved(base, 'fil_doc', { tags: ['contract'] }, 1000);
  const read = await saved(base, 'fil_doc', READ, 2000);
  const written = [];
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours edited', edited, read], ['theirs edited', read, edited]]) {
      const r = await merge({ base, ours, theirs }, options);
      const card = await readItem(r.buffer, 'fil_doc');
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0 && card?.tags?.[0] === 'contract' && same(readingOf(card), READ),
        `R6 ${name}, ${label}: one card, no conflict — the edit, with the reading carried over (same bytes)`);
      if (label === 'ours edited') ok(r.delta.updated.includes('fil_doc'), `R6 ${name}, ours edited: the reading carried from theirs is reported as updated`);
      written.push(await readRaw(r.buffer, 'fil_doc'));
    }
  }
  ok(new Set(written).size === 1, 'R6: every mode and both orientations write the same bytes');
  // An edit that replaced the file: the old file's text does not travel.
  const repacked = await saved(base, 'fil_doc', { assetSha: 'sha-2', tags: ['contract'] }, 1000);
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours repacked', repacked, read], ['theirs repacked', read, repacked]]) {
      const r = await merge({ base, ours, theirs }, options);
      const card = await readItem(r.buffer, 'fil_doc');
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && card?.assetSha === 'sha-2' && same(readingOf(card), {}),
        `R6 ${name}, ${label}: the new file wins and the old file's text is left behind`);
    }
  }
  const old = await OLD.mergeBrains({ base, ours: edited, theirs: read });
  ok((await cardsOf(old.buffer, 'fil_doc')).length === 2, 'R6 control: the 1.86.3 engine twinned an edit against a reading');
}

// ── R7: a real conflict on a card with readings is still a twin (no-loss) ────
{
  const ours = await saved(base, 'fil_doc', { tags: ['ours'], ...READ }, 1000);
  const theirs = await saved(base, 'fil_doc', { tags: ['theirs'], ...READ }, 2000);
  for (const [name, options] of MODES) {
    const r = await merge({ base, ours, theirs }, options);
    const ids = await cardsOf(r.buffer, 'fil_doc');
    const tags = (await Promise.all(ids.map((id) => readItem(r.buffer, id)))).map((c) => c?.tags?.[0]).sort();
    ok(ids.length === 2 && same(tags, ['ours', 'theirs']) && r.conflicts.some((c) => c.id === 'fil_doc' && c.kind === 'content'),
      `R7 ${name}: both edits survive (the card and its twin), and the conflict is reported`);
  }
}

// ── R8: a paid reading survives an edit made on the other machine ───────────
{
  const b8 = await sideOf({ live: { vid_k: Vr('v0', null) } });
  const renamed = await sideOf({ live: { vid_k: Vr('v0-renamed', null) } });
  const analysed = await sideOf({ live: { vid_k: Vr('v0', ANALYSIS) } });
  const replaced = await sideOf({ live: { vid_k: Vr('v0-renamed', null, { assetSha: 'sha-new-video' }) } });
  const written = [];
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours renamed', renamed, analysed], ['theirs renamed', analysed, renamed]]) {
      const r = await merge({ base: b8, ours, theirs }, options);
      const card = await readItem(r.buffer, 'vid_k');
      ok((await cardsOf(r.buffer, 'vid_k')).length === 1 && r.conflicts.length === 0 && card?.tags?.[0] === 'v0-renamed' && same(readingOf(card), ANALYSIS),
        `R8 ${name}, ${label}: the rename and the cloud video analysis are both kept`);
      written.push(await readRaw(r.buffer, 'vid_k'));
    }
    for (const [label, ours, theirs] of [['ours replaced the video', replaced, analysed], ['theirs replaced the video', analysed, replaced]]) {
      const r = await merge({ base: b8, ours, theirs }, options);
      const card = await readItem(r.buffer, 'vid_k');
      ok(card?.assetSha === 'sha-new-video' && same(readingOf(card), {}), `R8 ${name}, ${label}: an analysis of the old video does not travel to the new one`);
    }
  }
  ok(new Set(written).size === 1, 'R8: every mode and both orientations write the same bytes');
}

// ── R9: of two new readings the better one is kept ───────────────────────────
{
  const b9 = await sideOf({ live: { vid_k: Vr('v0', null) } });
  const local = await sideOf({ live: { vid_k: Vr('v0', LOCAL) } });
  const cloud = await sideOf({ live: { vid_k: Vr('v0', ANALYSIS) } });
  for (const [name, options] of MODES) {
    for (const baseBuf of [b9, null]) {
      for (const [label, ours, theirs] of [['ours local', local, cloud], ['ours cloud', cloud, local]]) {
        const r = await merge({ base: baseBuf, ours, theirs }, options);
        const card = await readItem(r.buffer, 'vid_k');
        ok((await cardsOf(r.buffer, 'vid_k')).length === 1 && same(readingOf(card), ANALYSIS),
          `R9 ${name}${baseBuf ? '' : ', no base'}, ${label}: the cloud analysis of the frames is kept, not the local audio-only transcript`);
      }
    }
  }
}

// ── R10: bin checks against a stored rid see a card with a reading ───────────
// B47 (an edit folded over the bytes a restore put back is reported), with a
// reading on the card and the receipt minted exactly as 1.94 mints it.
{
  const F = binEntryFor({ id: 'vid_k', json: Vr('v5'), now: 1000 });
  const as = revivedIdFor('vid_k', F.meta, Vr('v5'));
  const R = { meta: contentFreeReceiptFor('vid_k', F, { kind: 'restored', restoredAs: as, now: 2000 }), json: PURGED_BODY };
  const b = await sideOf({ live: { vid_k: Vr('v5') } });
  const ours = await sideOf({ live: { vid_k: Vr('v1') } });
  const theirs = await sideOf({ live: { [as]: Vr('v5') }, bin: { vid_k: R } });
  // The same, restored without a reading; KLYPIX transcribed the restored card since.
  const F0 = binEntryFor({ id: 'vid_k', json: Vr('v5', null), now: 1000 });
  const as0 = revivedIdFor('vid_k', F0.meta, Vr('v5', null));
  const R0 = { meta: contentFreeReceiptFor('vid_k', F0, { kind: 'restored', restoredAs: as0, now: 2000 }), json: PURGED_BODY };
  const b0 = await sideOf({ live: { vid_k: Vr('v5', null) } });
  const ours0 = await sideOf({ live: { vid_k: Vr('v1', null) } });
  const theirs0 = await sideOf({ live: { [as0]: Vr('v5') }, bin: { vid_k: R0 } });
  for (const [name, options] of OPTION_MODES) {
    const r = await merge({ base: b, ours, theirs }, options);
    ok(r.conflicts.some((c) => c.kind === 'fold-over-restore' && c.id === as), `R10 ${name}: B47 with a reading and a 1.94 receipt — the fold over the restored bytes is reported`);
    const r0 = await merge({ base: b0, ours: ours0, theirs: theirs0 }, options);
    ok(r0.conflicts.some((c) => c.kind === 'fold-over-restore' && c.id === as0), `R10 ${name}: B47 when KLYPIX read the restored card since — still reported`);
  }
}
// A purge reaches the twin of a restore's landing that holds exactly the
// restored bytes (B44), with a reading on the card.
{
  for (const [label, restored, twinValue] of [['the entry holds the reading', Vr('v0'), Vr('v0')], ['a reading made on the twin since', Vr('v0', null), Vr('v0')]]) {
    const F = binEntryFor({ id: 'vid_k', json: restored, now: 1000 });
    const kp = revivedIdFor('vid_k', F.meta, restored);
    const R = { meta: contentFreeReceiptFor('vid_k', F, { kind: 'restored', restoredAs: kp, now: 2000 }), json: PURGED_BODY };
    const P = { meta: contentFreeReceiptFor('vid_k', F, { kind: 'purged', now: 2000 }), json: PURGED_BODY };
    const tw = twinIdFor(kp, restored);
    const b = await sideOf({ bin: { vid_k: F } });
    const ours = await sideOf({ live: { [kp]: Vr('vS stale rescued'), [tw]: twinValue }, bin: { vid_k: R } });
    const theirs = await sideOf({ bin: { vid_k: P } });
    for (const [name, options] of OPTION_MODES) {
      const r = await merge({ base: b, ours, theirs }, options);
      ok(!(await tagsOf(r.buffer)).includes('v0') && r.conflicts.some((c) => c.kind === 'purge-reached-restore'),
        `R10 ${name}, ${label}: the purge takes the twin holding the purged bytes, and says so`);
    }
  }
}
// A purge that reaches a restore's landing takes the landing's own bin entry
// too; only an entry holding something other than the restored bytes is an
// edit lost (purge-vs-edit, side 'bin'). A reading KLYPIX made since is not one.
{
  const F = binEntryFor({ id: 'vid_k', json: Vr('v0', null), now: 1000 });
  const kp = revivedIdFor('vid_k', F.meta, Vr('v0', null));
  const R = { meta: contentFreeReceiptFor('vid_k', F, { kind: 'restored', restoredAs: kp, now: 2000 }), json: PURGED_BODY };
  const P = { meta: contentFreeReceiptFor('vid_k', F, { kind: 'purged', now: 2000 }), json: PURGED_BODY };
  for (const [label, landing, reported] of [['the restored bytes with a reading made since', Vr('v0'), false], ['an edit typed into the landing', Vr('v0-typed'), true]]) {
    const F2 = binEntryFor({ id: kp, json: landing, now: 3000 });
    for (const [name, options] of OPTION_MODES) {
      const r = await merge({ base: await sideOf({ bin: { vid_k: F } }), ours: await sideOf({ bin: { vid_k: R, [kp]: F2 } }), theirs: await sideOf({ bin: { vid_k: P } }) }, options);
      ok(r.conflicts.some((c) => c.kind === 'purge-vs-edit' && c.side === 'bin') === reported,
        `R10 ${name}: a purge takes a restore landing's bin entry holding ${label} — ${reported ? 'reported as an edit lost' : 'not reported as an edit'}`);
    }
  }
}
// The desktop's undone delete (klypix-app brainSave.ts undoneDeletes): it reads
// a copy as the restored bytes when fullEntryRid(id, copy) === the receipt's
// rid, and only then hands its union save the agreed copy as the base — which
// is what keeps an edit made after the undo.
{
  const F = binEntryFor({ id: 'vid_k', json: Vr('v5'), now: 1000 });
  ok(fullEntryRid('vid_k', Vr('v5')) === F.meta.rid, 'R10 undone delete: the app\'s own check still recognises the restored copy, reading and all');
  ok(holdsEntryBytes('vid_k', Vr('v5'), F.meta.rid) && !holdsEntryBytes('vid_k', Vr('v1-edited-after-undo'), F.meta.rid),
    'R10 undone delete: holdsEntryBytes — the restored copy yes, an edited one no');
  const F0 = binEntryFor({ id: 'vid_k', json: Vr('v5', null), now: 1000 });
  ok(fullEntryRid('vid_k', Vr('v5')) !== F0.meta.rid && holdsEntryBytes('vid_k', Vr('v5'), F0.meta.rid),
    'R10 undone delete: holdsEntryBytes also accepts the restored copy with a reading made since (the app can switch to it)');
  const as = revivedIdFor('vid_k', F.meta, Vr('v5'));
  const ours = await sideOf({ live: { [as]: Vr('v1-edited-after-undo') } });
  const theirs = await sideOf({ live: { [as]: Vr('v5') } });
  const agreed = await mergeBrains({ base: await sideOf({ live: { [as]: Vr('v5') } }), ours, theirs });
  ok(same(await tagsOf(agreed.buffer), ['v1-edited-after-undo']) && agreed.conflicts.length === 0,
    'R10 undone delete: with the agreed copy as its base, the union save keeps the edit made after the undo');
  const blind = await mergeBrains({ base: await sideOf({}), ours, theirs });
  ok(!(await tagsOf(blind.buffer)).includes('v1-edited-after-undo') || blind.conflicts.length > 0,
    'R10 undone delete control: without the agreed copy the edit is not recognised as the later one — why the rid must match');
}

// ── Foreign bytes (theirsTrust 'unverified') never replace or feed our card ──
{
  const r = await mergeBrains({ base: null, ours: base, theirs: await saved(base, 'fil_doc', READ, 2000), options: { binMerge: 'receipts', theirsTrust: 'unverified' } });
  ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && same(readingOf(await readItem(r.buffer, 'fil_doc')), {}),
    'unverified: a reading in foreign bytes neither twins the card nor replaces ours');
  const ours = await saved(base, 'fil_doc', { tags: ['contract'] }, 1000);
  const u = await mergeBrains({ base, ours, theirs: await saved(base, 'fil_doc', READ, 2000), options: { binMerge: 'receipts', theirsTrust: 'unverified' } });
  const card = await readItem(u.buffer, 'fil_doc');
  ok(card?.tags?.[0] === 'contract' && same(readingOf(card), {}), 'unverified: a foreign reading is not carried onto our edit');
}

// ── Mutants: switch each new merge path off — its case must fail ─────────────
{
  const MUT_DIR = path.join(ROOT, 'test', `.mutants-readings-${process.pid}`);
  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'merge-brains.mjs'), 'utf8').replace(/\r/g, '');
  const mutant = async (name, find, replace) => {
    if (SRC.split(find).length !== 2) return null;
    fs.mkdirSync(MUT_DIR, { recursive: true });
    const file = path.join(MUT_DIR, `${name}.mjs`);
    fs.writeFileSync(file, SRC.replace(find, replace).replaceAll("from './", "from '../../src/"));
    return import(pathToFileURL(file).href);
  };
  try {
    const readOne = await saved(base, 'fil_doc', READ, 1000);
    const untouched = await saved(base, 'fil_doc', {}, 2000);
    const keepsReading = async (engine, options) => {
      const r = await engine.mergeBrains({ base, ours: untouched, theirs: readOne, ...(options ? { options } : {}) });
      return same(readingOf(await readItem(r.buffer, 'fil_doc')), READ);
    };
    const edited = await saved(base, 'fil_doc', { tags: ['contract'] }, 1000);
    const carries = async (engine, options, oursEdited) => {
      const r = await engine.mergeBrains({ base, ours: oursEdited ? edited : readOne, theirs: oursEdited ? readOne : edited, ...(options ? { options } : {}) });
      return same(readingOf(await readItem(r.buffer, 'fil_doc')), READ);
    };
    const pickU = await mutant('union-pick', 'so a reading theirs made is kept.\n        side = pickReadingCopy(O.items[id], T.items[id]);', "so a reading theirs made is kept.\n        side = 'ours';");
    ok(!!pickU && await keepsReading({ mergeBrains }) && !(await keepsReading(pickU)), 'X union pick off: the reading theirs made is lost (R1 fails)');
    const pickO = await mutant('option-pick', 'so there ours stays.\n        side = pickReadingCopy(O.items[id], T.items[id]);', "so there ours stays.\n        side = 'ours';");
    ok(!!pickO && await keepsReading({ mergeBrains }, { binMerge: 'receipts' }) && !(await keepsReading(pickO, { binMerge: 'receipts' })),
      'X option-mode pick off: the reading theirs made is lost (R1 fails)');
    const carryUT = await mutant('union-carry-theirs', "} else if (tChg && !oChg) { json = carryReading(T.items[id], O.items[id]); side = 'theirs';", "} else if (tChg && !oChg) { json = T.items[id]; side = 'theirs';");
    ok(!!carryUT && await carries({ mergeBrains }, undefined, false) && !(await carries(carryUT, undefined, false)), 'X union carry off (theirs edited): our reading is lost (R6 fails)');
    const carryUO = await mutant('union-carry-ours', "        json = carryReading(O.items[id], T.items[id]); side = 'ours';\n        if (json !== O.items[id]) delta.updated.push(id);\n      }\n    } else if (inT) {",
      "        json = O.items[id]; side = 'ours';\n        if (json !== O.items[id]) delta.updated.push(id);\n      }\n    } else if (inT) {");
    ok(!!carryUO && await carries({ mergeBrains }, undefined, true) && !(await carries(carryUO, undefined, true)), 'X union carry off (ours edited): theirs\' reading is lost (R6 fails)');
    const carryOT = await mutant('option-carry-theirs', "        } else { json = carryReading(T.items[id], O.items[id]); side = 'theirs'; delta.updated.push(id); }\n      } else if (!cb && diverged && B && !unverified && editsItsRestore(id)) {",
      "        } else { json = T.items[id]; side = 'theirs'; delta.updated.push(id); }\n      } else if (!cb && diverged && B && !unverified && editsItsRestore(id)) {");
    ok(!!carryOT && await carries({ mergeBrains }, { binMerge: 'receipts' }, false) && !(await carries(carryOT, { binMerge: 'receipts' }, false)),
      'X option-mode carry off (theirs edited): our reading is lost (R6 fails)');
    const carryOO = await mutant('option-carry-ours', "      } else if (!unverified) {\n        // Ours changed the card and theirs did not: ours' copy, with the\n        // reading theirs holds carried over while it is still of these bytes.\n        json = carryReading(O.items[id], T.items[id]); side = 'ours';",
      "      } else if (!unverified) {\n        // Ours changed the card and theirs did not: ours' copy, with the\n        // reading theirs holds carried over while it is still of these bytes.\n        json = O.items[id]; side = 'ours';");
    ok(!!carryOO && await carries({ mergeBrains }, { binMerge: 'receipts' }, true) && !(await carries(carryOO, { binMerge: 'receipts' }, true)),
      'X option-mode carry off (ours edited): theirs\' reading is lost (R6 fails)');
    // asRestored back to an exact-rid compare: B47 with a reading made since goes silent.
    const F0 = binEntryFor({ id: 'vid_k', json: Vr('v5', null), now: 1000 });
    const as0 = revivedIdFor('vid_k', F0.meta, Vr('v5', null));
    const R0 = { meta: contentFreeReceiptFor('vid_k', F0, { kind: 'restored', restoredAs: as0, now: 2000 }), json: PURGED_BODY };
    const b47 = { base: await sideOf({ live: { vid_k: Vr('v5', null) } }), ours: await sideOf({ live: { vid_k: Vr('v1', null) } }), theirs: await sideOf({ live: { [as0]: Vr('v5') }, bin: { vid_k: R0 } }), options: { binMerge: 'receipts' } };
    const reports = async (engine) => (await engine.mergeBrains(b47)).conflicts.some((c) => c.kind === 'fold-over-restore');
    const exactRid = await mutant('exact-rid', '.some(([d, rid]) => holdsEntryBytes(d, v, rid));', '.some(([d, rid]) => fullEntryRid(d, v) === rid);');
    ok(!!exactRid && await reports({ mergeBrains }) && !(await reports(exactRid)), 'X exact-rid restore check: a fold over a restored card KLYPIX read since goes unreported (R10 fails)');
    // The purge's three rid checks, each back to an exact compare.
    const Fp = binEntryFor({ id: 'vid_k', json: Vr('v0', null), now: 1000 });
    const kp = revivedIdFor('vid_k', Fp.meta, Vr('v0', null));
    const Rp = { meta: contentFreeReceiptFor('vid_k', Fp, { kind: 'restored', restoredAs: kp, now: 2000 }), json: PURGED_BODY };
    const Pp = { meta: contentFreeReceiptFor('vid_k', Fp, { kind: 'purged', now: 2000 }), json: PURGED_BODY };
    const reachArgs = { base: await sideOf({ bin: { vid_k: Fp } }), ours: await sideOf({ live: { [kp]: Vr('vS stale rescued'), [twinIdFor(kp, Vr('v0', null))]: Vr('v0') }, bin: { vid_k: Rp } }), theirs: await sideOf({ bin: { vid_k: Pp } }), options: { binMerge: 'receipts' } };
    const reachesTwin = async (engine) => { const r = await engine.mergeBrains(reachArgs); return !(await tagsOf(r.buffer)).includes('v0') && r.conflicts.some((c) => c.kind === 'purge-reached-restore'); };
    const twinExact = await mutant('twin-exact', 'copies.every((v) => holdsEntryBytes(c.from, v, c.rid))', 'copies.every((v) => fullEntryRid(c.from, v) === c.rid)');
    ok(!!twinExact && await reachesTwin({ mergeBrains }) && !(await reachesTwin(twinExact)), 'X exact-rid purge reach: the twin holding the purged bytes (read since) stays live (R10 fails)');
    const reportExact = await mutant('report-exact', 'if (!holdsEntryBytes(via.from, v, via.rid)) conflicts.push(', 'if (fullEntryRid(via.from, v) !== via.rid) conflicts.push(');
    ok(!!reportExact && await reachesTwin({ mergeBrains }) && !(await reachesTwin(reportExact)), 'X exact-rid purge report: a reached copy KLYPIX read since is called an edit lost (R10 fails)');
    const binArgs = { base: await sideOf({ bin: { vid_k: Fp } }), ours: await sideOf({ bin: { vid_k: Rp, [kp]: binEntryFor({ id: kp, json: Vr('v0'), now: 3000 }) } }), theirs: await sideOf({ bin: { vid_k: Pp } }), options: { binMerge: 'receipts' } };
    const binEditReported = async (engine) => (await engine.mergeBrains(binArgs)).conflicts.some((c) => c.kind === 'purge-vs-edit' && c.side === 'bin');
    const typedExact = await mutant('typed-exact', '!(via.rid && holdsEntryBytes(via.from, F.json, via.rid))', '!(via.rid && fullEntryRid(via.from, F.json) === via.rid)');
    ok(!!typedExact && !(await binEditReported({ mergeBrains })) && await binEditReported(typedExact), 'X exact-rid bin check: a landing\'s entry read since is reported as an edit lost (R10 fails)');
  } finally {
    fs.rmSync(MUT_DIR, { recursive: true, force: true });
  }
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-readings: all assertions passed');
process.exit(failures ? 1 : 0);
