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
//   R1  copies that differ only in their reading are ONE card: no twin, no
//       content conflict — and the copy written is the one whose reading is
//       current, whichever side holds it;
//   R2  two different current readings are picked from the values alone, so
//       every machine and both transports write the same one;
//   R3  a current document reading beats a stale one (derivedTextSha no longer
//       names the bytes the card holds);
//   R4  a reading-only change never beats a delete: the delete wins;
//   R5  a real edit against a delete keeps today's behaviour (no-loss);
//   R6  a real edit on one side and a reading on the other: one card, the edit;
//   R7  a real conflict on a card that also carries readings is still a twin.
// The frozen 1.86.3 engine is run on the same inputs to prove the assertions
// see the old behaviour, and the reading pick is switched off in mutants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildKlypix, parseKlypix, shard, itemSignature, sameMeaning, twinIdFor, fullEntryRid, pickReadingCopy,
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
const putItem = async (buffer, id, obj) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.file(itemPath(id), JSON.stringify(obj));
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
const readItem = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file(itemPath(id));
  return f ? JSON.parse(await f.async('string')) : null;
};
const cardsOf = async (buffer, k) => ((await parseKlypix(buffer)).canvas.order || []).filter((id) => id === k || id.startsWith(`${k}__`));
const binHas = async (buffer, id) => {
  const { zip } = await parseKlypix(buffer);
  const f = zip.file('graveyard.json');
  return !!(f && JSON.parse(await f.async('string')).entries?.[id]);
};
const readingOf = (item) => Object.fromEntries(READING_ITEM_FIELDS.filter((f) => item && item[f] !== undefined).map((f) => [f, item[f]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
// A reading of bytes the card no longer holds.
const STALE = { derivedText: 'An older version of the contract.', derivedTextKind: 'document-text', derivedTextSource: 'local', derivedTextSha: 'sha-0' };
// Media readings carry their time: two machines never write the same one.
const transcript = (text, at) => ({ derivedText: text, derivedTextKind: 'video-transcript', derivedTextSource: 'local', derivedTextVisuals: false, derivedTextAt: at });

const empty = await buildKlypix({ title: 'reading merges', cards: [{ id: 'txt_A', text: 'A note' }] });
const base = await putItem(await putItem(empty, 'fil_doc', DOC), 'vid_1', VID);
// A machine's save: the patch, plus its own touch stamp (volatile).
const saved = (buffer, id, patch, stamp) => changeItem(buffer, id, (it) => ({ ...it, ...patch, updatedAt: stamp }));
// A side that deleted the card in KLYPIX: gone from the board, its bytes in the bin.
const deletedIn = async (buffer, id) => (await mergeBrains({ base: buffer, ours: await removeItem(buffer, id), theirs: buffer, deletedIds: [id] })).buffer;

const MODES = [
  ['union (the app save)', undefined],
  ['receipts (Brain Sync)', { binMerge: 'receipts' }],
  ['3way (the git driver)', { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true }],
];
const merge = (args, options) => mergeBrains({ ...args, ...(options ? { options } : {}) });

// ── The comparator ───────────────────────────────────────────────────────────
{
  ok(same(READING_ITEM_FIELDS, ['derivedText', 'derivedTextKind', 'derivedTextSource', 'derivedTextSha', 'derivedTextAt', 'derivedTextVisuals']),
    'the reading fields are the app\'s READING_FIELD_KEYS, all six');
  ok(same(VOLATILE_ITEM_FIELDS, ['updatedAt', 'zIndex', 'editedAt']), 'the volatile list itself is unchanged');
  const plain = JSON.stringify(DOC);
  const read = JSON.stringify({ ...DOC, ...READ, updatedAt: 99 });
  const edited = JSON.stringify({ ...DOC, tags: ['contract'] });
  ok(sameMeaning(plain, read) && itemSignature(plain) === itemSignature(read), 'a copy that differs only in its reading means the same');
  ok(!READING_ITEM_FIELDS.some((f) => itemSignature(read).includes(`"${f}"`)), 'the signature holds no reading field');
  ok(!sameMeaning(plain, edited) && !sameMeaning(read, edited), 'a real edit still differs');
  ok(twinIdFor('fil_doc', plain) === twinIdFor('fil_doc', read) && fullEntryRid('fil_doc', plain) === fullEntryRid('fil_doc', read),
    'a twin id and a bin identity name the card\'s meaning, not its reading');
  ok(MERGE_ENGINE_FEATURES.derivedReadings === true, 'the engine advertises the rule (callers feature-check it)');

  const none = JSON.stringify(DOC);
  const cur = JSON.stringify({ ...DOC, ...READ });
  const stale = JSON.stringify({ ...DOC, ...STALE });
  ok(pickReadingCopy(cur, none) === 'ours' && pickReadingCopy(none, cur) === 'theirs', 'pickReadingCopy: a current reading beats none, on either side');
  ok(pickReadingCopy(cur, stale) === 'ours' && pickReadingCopy(stale, cur) === 'theirs', 'pickReadingCopy: a current reading beats a stale one');
  ok(pickReadingCopy(JSON.stringify({ ...DOC, ...READ, updatedAt: 5 }), JSON.stringify({ ...DOC, ...READ, updatedAt: 6 })) === 'ours',
    'pickReadingCopy: the same reading (a volatile difference only) keeps ours, as before');
  const a = JSON.stringify({ ...VID, ...transcript('one take', 111) });
  const b = JSON.stringify({ ...VID, ...transcript('another take', 222) });
  ok((pickReadingCopy(a, b) === 'ours') === (pickReadingCopy(b, a) === 'theirs'), 'pickReadingCopy: two current readings are picked from the values alone (the same copy either way round)');
  ok(pickReadingCopy(a, b, a) === 'theirs' && pickReadingCopy(b, a, a) === 'ours',
    'pickReadingCopy: with a base, the new reading one side made wins over the one both held');
  ok(pickReadingCopy(a, JSON.stringify(VID), a) === 'ours', 'pickReadingCopy: a current reading is kept over a copy that lacks it, even when the base had it too');
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
  for (const [name, options] of MODES.slice(1)) {
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
    for (const [name, options] of MODES.slice(1)) {
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

// ── R6: a real edit on one side, a reading on the other — one card, the edit ─
{
  const edited = await saved(base, 'fil_doc', { tags: ['contract'] }, 1000);
  const read = await saved(base, 'fil_doc', READ, 2000);
  for (const [name, options] of MODES) {
    for (const [label, ours, theirs] of [['ours edited', edited, read], ['theirs edited', read, edited]]) {
      const r = await merge({ base, ours, theirs }, options);
      ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && r.conflicts.length === 0 && (await readItem(r.buffer, 'fil_doc'))?.tags?.[0] === 'contract',
        `R6 ${name}, ${label}: one card, no conflict, the edit kept`);
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

// ── Foreign bytes (theirsTrust 'unverified') never replace our card ─────────
{
  const r = await mergeBrains({ base: null, ours: base, theirs: await saved(base, 'fil_doc', READ, 2000), options: { binMerge: 'receipts', theirsTrust: 'unverified' } });
  ok(same(await cardsOf(r.buffer, 'fil_doc'), ['fil_doc']) && same(readingOf(await readItem(r.buffer, 'fil_doc')), {}),
    'unverified: a reading in foreign bytes neither twins the card nor replaces ours');
}

// ── Mutants: switch the reading pick off — R1 must fail ──────────────────────
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
    const union = await mutant('union-pick', '        side = pickReadingCopy(O.items[id], T.items[id], baseItem(id));', "        side = 'ours';");
    ok(!!union && await keepsReading({ mergeBrains }) && !(await keepsReading(union)), 'X union: without the reading pick, the reading theirs made is lost (R1 fails)');
    const option = await mutant('option-pick', '        side = pickReadingCopy(O.items[id], T.items[id], cb);', "        side = 'ours';");
    ok(!!option && await keepsReading({ mergeBrains }, { binMerge: 'receipts' }) && !(await keepsReading(option, { binMerge: 'receipts' })),
      'X option modes: without the reading pick, the reading theirs made is lost (R1 fails)');
  } finally {
    fs.rmSync(MUT_DIR, { recursive: true, force: true });
  }
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-readings: all assertions passed');
process.exit(failures ? 1 : 0);
