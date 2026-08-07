// brain-graveyard — a human delete keeps the card recoverable instead of
// destroying it, WITHOUT the card leaking back into the brain.
//
// The design exists because the obvious approach is wrong: routing deletes to
// the Archive container would make them reappear, since archived cards are only
// re-parented and stay in canvas.json's `order` (this repo's own brain renders
// 275 of them today). So the load-bearing assertions here are the NEGATIVE ones
// — a buried card must be absent from `order`, `positions`, `struct.cards`, the
// card count, and every text surface derived from them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { parseKlypix, structToMarkdown, structToBrief } from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';
import { listGraveyard, purgeGraveyard, readGraveyardCard, restoreFromGraveyard } from '../src/brain-graveyard.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const SECRET = 'sk-live-DO-NOT-KEEP-THIS-abcdef123456';
const base = await buildKlypixMap({
  title: 'graveyard fixture',
  kind: 'brain',
  areas: [{
    title: 'Work',
    cards: [
      { text: 'keep me one — a normal live decision' },
      { text: `oops pasted a credential: ${SECRET}` },
      { text: 'keep me two — another live decision' },
    ],
  }],
});

const idsOf = async (buf) => {
  const zip = await JSZip.loadAsync(buf);
  const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
  return { order: canvas.order, positions: canvas.positions };
};
const cardWith = async (buf, needle) => {
  const { struct } = await parseKlypix(buf);
  return struct.cards.find(c => String(c.text || '').includes(needle));
};

const victim = await cardWith(base, SECRET);
ok(Boolean(victim), 'fixture: the card to delete exists');

// ── the delete: an honored tombstone buries the bytes ────────────────────────
const merged = await mergeBrains({ base, ours: base, theirs: base, deletedIds: [victim.id] });
const after = merged.buffer;
const { struct: afterStruct } = await parseKlypix(after);
const { order, positions } = await idsOf(after);

ok(!order.includes(victim.id), 'the deleted card is GONE from canvas.order — it cannot render');
ok(!(victim.id in positions), 'and gone from positions');
ok(!afterStruct.cards.some(c => c.id === victim.id), 'and absent from struct.cards');
ok(afterStruct.counts.cards === order.length, 'the card count matches order — a deleted card is not counted');
ok(merged.delta.removed.includes(victim.id), 'the merge still reports it as removed (delta semantics unchanged)');

// The leak surfaces the archive approach would have broken.
ok(!structToMarkdown(afterStruct).includes(SECRET),
  'read_canvas output does NOT contain the deleted text (the archive route would have leaked it)');
ok(!structToBrief(afterStruct).includes(SECRET), 'the brief does not contain it either');
ok(afterStruct.cards.filter(c => /keep me/.test(String(c.text || ''))).length === 2,
  'the live cards are untouched');

// ── but the bytes are recoverable ────────────────────────────────────────────
const bin = await listGraveyard(after);
ok(bin.length === 1 && bin[0].id === victim.id, 'the deleted card is in the bin, exactly once');
ok(Number(bin[0].deletedAt) > 0 && bin[0].deletedBy === 'human', 'with a deletedAt stamp and an author');
ok(String(bin[0].preview || '').includes('oops pasted'), 'and a preview so a human can identify it');
const full = await readGraveyardCard(after, victim.id);
ok(String(full?.content || '').includes(SECRET), 'the full text is retrievable for review before restore/purge');

// ── restore puts it back, once ───────────────────────────────────────────────
const res = await restoreFromGraveyard(after, [victim.id]);
const { struct: restoredStruct } = await parseKlypix(res.buffer);
const restoredIds = (await idsOf(res.buffer)).order;
ok(res.restored.length === 1 && restoredIds.includes(victim.id), 'restore returns the card to the canvas');
ok(restoredStruct.cards.some(c => c.id === victim.id && String(c.text).includes(SECRET)), 'with its text intact');
ok((await listGraveyard(res.buffer)).length === 0, 'and removes it from the bin — never in both places');
ok(restoredIds.filter(id => id === victim.id).length === 1, 'exactly one copy — no duplicate on restore');

// A second restore of the same id is a no-op, not a duplicate.
const again = await restoreFromGraveyard(res.buffer, [victim.id]);
ok(again.restored.length === 0 && again.skipped.length === 1, 'restoring twice is refused, not duplicated');

// ── a merge never empties another machine's bin ──────────────────────────────
{
  const mergedAgain = await mergeBrains({ base, ours: after, theirs: base });
  ok((await listGraveyard(mergedAgain.buffer)).length === 1,
    "a peer who still has the card live does not resurrect it, and does not empty the other side's bin");
  const peerOrder = (await idsOf(mergedAgain.buffer)).order;
  ok(!peerOrder.includes(victim.id),
    'and the delete SURVIVES the merge — the tombstoned card stays out of the brain');
}

// ── purge is permanent, and available for the secret case ────────────────────
{
  const purged = await purgeGraveyard(after, { ids: [victim.id] });
  ok(purged.purged.length === 1 && (await listGraveyard(purged.buffer)).length === 0, 'purge empties the bin');
  const zip = await JSZip.loadAsync(purged.buffer);
  const leftovers = Object.keys(zip.files).filter(p => p.startsWith('graveyard/') && !zip.files[p].dir);
  ok(leftovers.length === 0, 'and removes the card bytes from the archive entirely');
  const raw = purged.buffer.toString('latin1');
  ok(!raw.includes(SECRET), 'the secret is no longer anywhere in the file');
}

// ── retention purge by age ───────────────────────────────────────────────────
{
  const zip = await JSZip.loadAsync(after);
  const idx = JSON.parse(await zip.file('graveyard.json').async('string'));
  idx.entries[victim.id].deletedAt = Date.now() - 60 * 24 * 60 * 60 * 1000;   // 60 days ago
  zip.file('graveyard.json', JSON.stringify(idx));
  const aged = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const kept = await purgeGraveyard(aged, { olderThanDays: 90 });
  ok(kept.purged.length === 0, 'a 60-day-old deletion survives a 90-day retention purge');
  const swept = await purgeGraveyard(aged, { olderThanDays: 30 });
  ok(swept.purged.length === 1, 'and is purged by a 30-day retention');
}

// ── a brain that never had a delete keeps its exact shape ────────────────────
{
  const untouched = await mergeBrains({ base, ours: base, theirs: base });
  const zip = await JSZip.loadAsync(untouched.buffer);
  ok(!zip.file('graveyard.json') && !Object.keys(zip.files).some(p => p.startsWith('graveyard/')),
    'no graveyard entries are written for a brain with no deletions');
  const { struct } = await parseKlypix(untouched.buffer);
  ok(Array.isArray(struct.graveyard) && struct.graveyard.length === 0,
    'and struct.graveyard is an empty array, never undefined');
}

// ── delete-vs-edit still keeps the card LIVE (unchanged contract) ────────────
{
  const editedZip = await JSZip.loadAsync(base);
  const ip = Object.keys(editedZip.files).find(p => p.includes(victim.id));
  const j = JSON.parse(await editedZip.file(ip).async('string'));
  j.content = `${j.content}\nan agent appended this after the human deleted it`;
  editedZip.file(ip, JSON.stringify(j));
  const theirsEdited = await editedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const m = await mergeBrains({ base, ours: base, theirs: theirsEdited, deletedIds: [victim.id] });
  const o = (await idsOf(m.buffer)).order;
  ok(o.includes(victim.id) && m.conflicts.some(c => c.kind === 'delete-vs-edit'),
    'delete-vs-edit still KEEPS the agent-edited card live — the bin never swallows fresh info');
  ok((await listGraveyard(m.buffer)).length === 0, 'and nothing is buried in that case');
}

process.exit(failures ? 1 : 0);
