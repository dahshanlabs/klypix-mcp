// ✔ partial notes are written ONCE — the 2026-09-15 live data incident.
//
// A FULL ✓ resolve is idempotent because it archives its card: the marker
// never matches again. A PARTIAL ✓ is not — the card stays LIVE by design,
// which is the whole point of the partial-clause rule — and the Claude-Code
// hook re-pushes every ✓ marker still visible in the transcript at every Stop,
// on the documented promise that a resolve is idempotent. So the same note was
// appended on every turn end, forever. Measured in E:\ANTIGRAVITY\KLYPIX\
// brain.klypix: one card carried 85 ✔ partial lines (5 distinct notes),
// three others 31 / 9 / 9.
//
//   P1  the note identity is the BODY — not the date, not the " — still open:"
//       tail (which drifts as earlier notes change the clause scan), and it
//       survives the hard wrapping rewriteCard applies to every card.
//   P2  THE HEADLINE: capturing the same partial twice leaves the card
//       unchanged the second time and reports `partialSkipped`.
//   P3  a DIFFERENT partial note on the same card still lands — the guard is
//       de-duplication, not suppression.
//   P4  the id-addressed path (brain_reconcile confirm) carries the same guard.
//   P5  the repair collapses existing damage to the earliest note per body,
//       removes nothing else, and is idempotent.
//   P6  brain_garden repair:"duplicate-partials" is dry-run by default.
//   P7  THE 2026-09-16 REVIEW BLOCKER: a body carrying a token wider than the
//       card (brainCPL()=37 — a file path, URL, sha or [[wikilink]], i.e. most
//       of this brain's prose) is wrapped MID-WORD, which put a space inside the
//       stored key that the marker body never had. P2's plain-words fixture is
//       why the suite was green while three captures left three notes.
//   P8  and the prefix tolerance does not swallow a genuinely SHORTER new note.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  buildKlypix, parseKlypix, captureIntoBrain, partialNoteKey, partialNoteRuns, hasPartialNote,
  findDuplicatePartialNotes, collapseDuplicatePartialNotes,
} from '../src/klypix-format.mjs';
import { opBrainGarden } from '../src/klypix-core.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const countNotes = (text) => partialNoteRuns(text).length;

const dir = path.join(os.tmpdir(), `klypix-partial-notes-${process.pid}`);
if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${dir}`);
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
fs.mkdirSync(dir, { recursive: true });

// ── P1 — the note identity ──────────────────────────────────────────────────
ok(partialNoteKey('✔ partial 2026-09-15: ship the arrow tool') === 'ship the arrow tool', 'P1 the date is not part of the identity');
ok(partialNoteKey('✔ partial 2026-09-15: ship the arrow tool — still open: lasso hit testing') === 'ship the arrow tool',
  'P1 the " — still open:" tail is not part of the identity (it drifts between passes)');
ok(partialNoteKey('✔ partial 2026-09-15: ship the arrow tool') === partialNoteKey('✔ partial 2026-10-02: Ship   the  arrow   tool'),
  'P1 whitespace and case are normalized');
{
  // A note as it is actually STORED: hard-wrapped across several lines.
  const wrapped = 'Canvas: ❓ remaining: A + B\n#canvas\n✔ partial 2026-09-15: ship the arrow tool for\nthe connection palette — still open:\nlasso hit testing';
  const runs = partialNoteRuns(wrapped);
  ok(runs.length === 1, `P1 a wrapped note reads as ONE note, not three (got ${runs.length})`);
  ok(runs[0].key === 'ship the arrow tool for the connection palette', `P1 the wrapped body is rejoined [${runs[0].key}]`);
  ok(hasPartialNote(wrapped, 'ship the arrow tool for the connection palette'), 'P1 hasPartialNote sees through the wrapping');
  ok(!hasPartialNote(wrapped, 'rewrite the lasso hit testing for rotated groups'), 'P1 a different note is not mistaken for it');
}

// ── the fixture: a live card with a two-item clause ─────────────────────────
const CLAUSE = 'Canvas: ❓ remaining: ship the arrow tool for the connection palette + rewrite the lasso hit testing for rotated groups';
const seed = async () => buildKlypix({ title: 'partials', cards: [{ text: CLAUSE, area: 'Canvas' }] });
const idOf = async (buf) => (await parseKlypix(buf)).struct.cards.find(c => /remaining: ship the arrow/.test(flat(c.text))).id;

// ── P2 — the same partial twice ─────────────────────────────────────────────
{
  // No `area` on the marker: buildKlypix writes loose cards with no container,
  // so an area-scoped ✓ would filter every candidate out before matching.
  const marker = { text: 'ship the arrow tool for the connection palette' };
  const seeded = await seed();
  const seededId = await idOf(seeded);
  const first = await captureIntoBrain(seeded, { resolutions: [marker] });
  const { struct: s1 } = await parseKlypix(first.buffer);
  const card1 = s1.cards.find(c => c.id === seededId);
  ok(first.stats.partialResolved === 1, 'P2 the first pass writes the partial note');
  ok(countNotes(card1.text) === 1, 'P2 exactly one ✔ partial note after the first pass');
  ok(!/^archive$/i.test(card1.area || ''), 'P2 the partially-resolved card is still live (unchanged behaviour)');

  const second = await captureIntoBrain(first.buffer, { resolutions: [marker] });
  const { struct: s2 } = await parseKlypix(second.buffer);
  const card2 = s2.cards.find(c => c.id === card1.id);
  ok(second.stats.partialSkipped === 1, 'P2 the second pass reports partialSkipped');
  ok(!second.stats.partialResolved, 'P2 the second pass does NOT count a fresh partial resolve');
  ok(countNotes(card2.text) === 1, `P2 THE HEADLINE: still exactly one ✔ partial note (got ${countNotes(card2.text)})`);
  ok(flat(card2.text) === flat(card1.text), 'P2 the card content is unchanged by the repeat');

  // And a marker repeated INSIDE one batch, which is how a transcript tail
  // carrying the same ✓ twice actually arrives.
  const seeded2 = await seed();
  const seeded2Id = await idOf(seeded2);
  const batch = await captureIntoBrain(seeded2, { resolutions: [marker, marker, marker] });
  const { struct: sb } = await parseKlypix(batch.buffer);
  const cb = sb.cards.find(c => c.id === seeded2Id);
  ok(countNotes(cb.text) === 1, `P2 three copies in ONE batch still write one note (got ${countNotes(cb.text)})`);
  ok(batch.stats.partialSkipped === 2, 'P2 the two repeats in the batch are counted as skipped');

  // ── P3 — a different partial still lands ─────────────────────────────────
  const other = await captureIntoBrain(second.buffer, {
    resolutions: [{ text: 'rewrite the lasso hit testing for rotated groups' }],
  });
  const { struct: s3 } = await parseKlypix(other.buffer);
  const card3 = s3.cards.find(c => c.id === card1.id);
  ok(countNotes(card3.text) === 2 || /^archive$/i.test(card3.area || ''),
    `P3 a genuinely different resolution still changes the card (notes ${countNotes(card3.text)}, area ${card3.area})`);
}

// ── P4 — the id-addressed path carries the same guard ───────────────────────
{
  const buf = await seed();
  const id = await idOf(buf);
  const first = await captureIntoBrain(buf, { resolutions: [{ id, text: 'ship the arrow tool for the connection palette' }] });
  ok((first.stats.idResolutions || []).some(r => r.outcome === 'partial' && !r.skipped), 'P4 the id path writes the partial note');
  const second = await captureIntoBrain(first.buffer, { resolutions: [{ id, text: 'ship the arrow tool for the connection palette' }] });
  ok(second.stats.partialSkipped === 1, 'P4 the id path skips the repeat');
  ok((second.stats.idResolutions || []).some(r => r.id === id && r.outcome === 'partial' && r.skipped === true),
    'P4 the receipt says the partial was SKIPPED, not freshly stamped');
  const { struct: sA } = await parseKlypix(first.buffer);
  const { struct: sB } = await parseKlypix(second.buffer);
  ok(flat(sA.cards.find(c => c.id === id).text) === flat(sB.cards.find(c => c.id === id).text), 'P4 the card is byte-equal in substance after the repeat');
}

// ── P5 — the repair for cards already damaged ───────────────────────────────
{
  // A card in the shape the field produced: one body repeated many times, plus
  // a second distinct body also repeated.
  const damaged = ['Canvas: ❓ remaining: A + B', '#canvas']
    .concat(Array.from({ length: 5 }, (_, i) => `✔ partial 2026-09-${10 + i}: ship the arrow tool for the connection palette — still open: lasso hit testing`))
    .concat(Array.from({ length: 3 }, (_, i) => `✔ partial 2026-09-${20 + i}: rewrite the lasso hit testing`))
    .join('\n');
  const file = path.join(dir, 'brain.klypix');
  fs.writeFileSync(file, await buildKlypix({ title: 'brain', cards: [{ text: damaged, area: 'Canvas' }, { text: 'Canvas: 🏁 v1.3.170 shipped', area: 'Canvas' }] }));
  const { struct } = await parseKlypix(fs.readFileSync(file));
  const found = findDuplicatePartialNotes(struct);
  ok(found.total === 1, `P5 the damaged card is found, and only it (${found.total})`);
  ok(found.cards[0].total === 8 && found.cards[0].distinct === 2 && found.cards[0].duplicates === 6,
    `P5 the receipt counts 8 notes / 2 distinct / 6 removable (got ${JSON.stringify(found.cards[0] && [found.cards[0].total, found.cards[0].distinct, found.cards[0].duplicates])})`);

  const before = fs.readFileSync(file);
  const { buffer, stats } = await collapseDuplicatePartialNotes(before);
  ok(stats.cards === 1 && stats.notes === 6, `P5 the repair removes exactly the 6 repeats (${stats.cards} card, ${stats.notes} notes)`);
  const { struct: after } = await parseKlypix(buffer);
  const repaired = after.cards.find(c => /remaining: A/.test(c.text || ''));
  ok(countNotes(repaired.text) === 2, `P5 two notes survive, one per distinct body (got ${countNotes(repaired.text)})`);
  ok(/2026-09-10/.test(repaired.text) && /2026-09-20/.test(repaired.text), 'P5 the EARLIEST date of each body is the one kept');
  ok(!/2026-09-14/.test(repaired.text) && !/2026-09-22/.test(repaired.text), 'P5 the later repeats are gone');
  ok(flat(repaired.text).startsWith('Canvas: ❓ remaining: A + B'), 'P5 the card body itself is untouched');
  ok(after.cards.length === (await parseKlypix(before)).struct.cards.length, 'P5 no card was added or removed');

  const again = await collapseDuplicatePartialNotes(buffer);
  ok(again.stats.cards === 0 && again.stats.notes === 0, 'P5 the repair is idempotent — a second run finds nothing');
  ok(findDuplicatePartialNotes(after).total === 0, 'P5 and the detector agrees');

  // ── P6 — the brain_garden surface ─────────────────────────────────────────
  fs.writeFileSync(file, before);
  const dry = await opBrainGarden({ vault: dir, canvas: file, repair: 'duplicate-partials' });
  const dryText = dry.blocks.map(b => b.text || '').join('\n');
  ok(/carry repeated ✔ partial notes/.test(dryText), 'P6 the dry run names the problem');
  ok(/6 duplicate note\(s\)/.test(dryText), 'P6 the dry run counts what would be removed');
  ok(/Nothing was changed/.test(dryText), 'P6 the dry run says so');
  ok(sha256(fs.readFileSync(file)) === sha256(before), 'P6 the dry run leaves the brain byte-identical');

  const applied = await opBrainGarden({ vault: dir, canvas: file, repair: 'duplicate-partials', apply: true });
  ok(/Repaired 1 card\(s\): 6 duplicate ✔ partial note\(s\) removed/.test(applied.blocks.map(b => b.text || '').join('\n')), 'P6 apply reports what it did');
  ok(findDuplicatePartialNotes((await parseKlypix(fs.readFileSync(file))).struct).total === 0, 'P6 apply really repaired the file');
  const rerun = await opBrainGarden({ vault: dir, canvas: file, repair: 'duplicate-partials' });
  ok(/Nothing to repair|No card carries a repeated/.test(rerun.blocks.map(b => b.text || '').join('\n')), 'P6 a second dry run finds nothing');

  const bad = await opBrainGarden({ vault: dir, canvas: file, repair: 'not-a-repair' });
  ok(bad.isError === true, 'P6 an unknown repair name is refused, never silently ignored');
}

// ── P7 — a note body carrying an OVER-WIDTH token ───────────────────────────
// The 2026-09-16 review blocker. Cards are stored hard-wrapped at brainCPL()=37
// and wrapText breaks a token longer than that MID-WORD, with no space. The run
// rejoin then puts a space inside the token, so the stored key could never equal
// the marker body and the "already noted" guard did nothing — for exactly the
// prose this brain is made of (file paths, URLs, shas, [[wikilinks]]). Three
// captures of one marker used to leave THREE identical notes; the plain-words
// fixture in P2 is why the suite was green.
{
  // The note BODY carries the over-width token; the clause items stay plain, so
  // this fixture isolates the identity bug and nothing else.
  const PATHY = 'ship the arrow tool in src/canvas/interaction/ConnectionPaletteOverlay.tsx';
  ok(PATHY.split(/\s+/).some(t => t.length > 37), 'P7 the fixture really does carry a token wider than the card');
  const CLAUSE7 = 'Canvas: ❓ remaining: ship the arrow tool + rewrite the lasso hit testing for rotated groups';
  const buf0 = await buildKlypix({ title: 'partials-wide', cards: [{ text: CLAUSE7, area: 'Canvas' }] });
  const id7 = (await parseKlypix(buf0)).struct.cards.find(c => /remaining: ship the arrow/.test(flat(c.text))).id;
  const marker = { text: PATHY };

  const p1 = await captureIntoBrain(buf0, { resolutions: [marker] });
  const c1 = (await parseKlypix(p1.buffer)).struct.cards.find(c => c.id === id7);
  ok(p1.stats.partialResolved === 1 && countNotes(c1.text) === 1, 'P7 the first pass writes exactly one note');
  // The seam is the cause: the rejoined run carries a space the body never had.
  ok(partialNoteRuns(c1.text)[0].key.replace(/\s+/g, '') === partialNoteKey(PATHY).replace(/\s+/g, '')
    && partialNoteRuns(c1.text)[0].key !== partialNoteKey(PATHY),
    'P7 the stored key differs from the body by WHITESPACE ONLY (the mid-word wrap seam)');

  const p2 = await captureIntoBrain(p1.buffer, { resolutions: [marker] });
  const c2 = (await parseKlypix(p2.buffer)).struct.cards.find(c => c.id === id7);
  const p3 = await captureIntoBrain(p2.buffer, { resolutions: [marker] });
  const c3 = (await parseKlypix(p3.buffer)).struct.cards.find(c => c.id === id7);
  ok(p2.stats.partialSkipped === 1 && p3.stats.partialSkipped === 1, 'P7 passes 2 and 3 report partialSkipped');
  ok(!p2.stats.partialResolved && !p3.stats.partialResolved, 'P7 neither repeat counts as a fresh partial resolve');
  ok(countNotes(c3.text) === 1, `P7 THE HEADLINE: still exactly ONE ✔ partial note after three captures (got ${countNotes(c3.text)})`);
  ok(flat(c3.text) === flat(c1.text) && flat(c2.text) === flat(c1.text), 'P7 the card is unchanged by the repeats');

  // Same body, one batch — the in-batch mirror must agree with the disk copy.
  const bufB = await buildKlypix({ title: 'partials-wide-batch', cards: [{ text: CLAUSE7, area: 'Canvas' }] });
  const idB = (await parseKlypix(bufB)).struct.cards.find(c => /remaining: ship the arrow/.test(flat(c.text))).id;
  const batch = await captureIntoBrain(bufB, { resolutions: [marker, marker, marker] });
  const cB = (await parseKlypix(batch.buffer)).struct.cards.find(c => c.id === idB);
  ok(countNotes(cB.text) === 1 && batch.stats.partialSkipped === 2,
    `P7 three copies in ONE batch write one note (notes ${countNotes(cB.text)}, skipped ${batch.stats.partialSkipped})`);

  // And the id-addressed path (brain_reconcile confirm) inherits it.
  const bufI = await buildKlypix({ title: 'partials-wide-id', cards: [{ text: CLAUSE7, area: 'Canvas' }] });
  const idI = (await parseKlypix(bufI)).struct.cards.find(c => /remaining: ship the arrow/.test(flat(c.text))).id;
  const i1 = await captureIntoBrain(bufI, { resolutions: [{ id: idI, text: PATHY }] });
  const i2 = await captureIntoBrain(i1.buffer, { resolutions: [{ id: idI, text: PATHY }] });
  ok(i2.stats.partialSkipped === 1, 'P7 the id path skips the repeat too');
  ok(countNotes((await parseKlypix(i2.buffer)).struct.cards.find(c => c.id === idI).text) === 1,
    'P7 and leaves one note on the card');
}

// ── P8 — a SHORTER new note is not swallowed by a longer existing one ───────
// The prefix tolerance exists only for the in-batch mirror of a 100-char
// truncation. At the old ≥20 bar it also matched a genuinely different, shorter
// resolution that happened to share a prefix — reported as a skip while nothing
// was recorded, which is silent loss.
{
  const longNote = '✔ partial 2026-09-15: spooled the big assets to userData in eight megabyte chunks so nothing is base64';
  const card = `Canvas: ❓ remaining: spool the assets + drop the base64 encoder\n${longNote}`;
  ok(hasPartialNote(card, 'spooled the big assets to userData in eight megabyte chunks so nothing is base64'),
    'P8 the note it really carries is still recognised');
  ok(!hasPartialNote(card, 'spooled the big assets to userData'),
    'P8 a shorter, genuinely different body is NOT counted as already noted');
}

fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures ? `\n${failures} failure(s)` : '\n✓ partial-notes: all assertions passed');
process.exit(failures ? 1 : 0);
