// brain-graveyard — a human delete keeps the card recoverable instead of
// destroying it, WITHOUT the card leaking back into the brain.
//
// The design exists because the obvious approach is wrong: routing deletes to
// the Archive container would make them reappear, since archived cards are only
// re-parented and stay in canvas.json's `order` (this repo's own brain renders
// 275 of them today). So the load-bearing assertions here are the NEGATIVE ones
// — a buried card must be absent from `order`, `positions`, `struct.cards`, the
// card count, and every text surface derived from them.
//
// Stage 2 (1.88): "Delete permanently" leaves a CONTENT-FREE RECEIPT instead
// of dropping the entry, so a copy that still holds the bytes cannot carry
// them back. The load-bearing assertions for that are negative too: the secret
// is nowhere in the file, and a merge with a stale copy does not return it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import JSZip from 'jszip';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import {
  parseKlypix, structToMarkdown, structToBrief, shard, PURGED_BODY, entryKind, fullEntryRid,
  contentFreeReceiptFor, summarizeGraveyardCard as summarizeFromFormat, revivedIdFor, twinIdFor,
} from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';
import {
  listGraveyard, purgeGraveyard, readGraveyardCard, restoreFromGraveyard, summarizeGraveyardCard,
} from '../src/brain-graveyard.mjs';
import * as OLD_GY from './fixtures/engine-1.86.3/brain-graveyard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
ok(Number(bin[0].deletedAt) > 0
  && bin[0].deletedBy === 'unknown'
  && bin[0].deletion?.initiator === 'unknown'
  && bin[0].deletion?.cause === 'unclassified'
  && bin[0].deletion?.source === 'merge'
  && bin[0].deletion?.confidence === 'inferred',
'with a deletedAt stamp and an honest unknown/inferred audit receipt when no author evidence was supplied');
ok(String(bin[0].preview || '').includes('oops pasted'), 'and a preview so a human can identify it');
const full = await readGraveyardCard(after, victim.id);
ok(String(full?.content || '').includes(SECRET), 'the full text is retrievable for review before restore/purge');

// ── restore brings it back under its revived id, once, and leaves a receipt ──
// The raw entry and body, as every machine holding this delete sees them.
const rawBin = async (buf, id) => {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('graveyard.json');
  const meta = f ? JSON.parse(await f.async('string')).entries[id] : undefined;
  const b = zip.file(`graveyard/${shard(id)}/${id}.json`);
  return { meta, body: b ? await b.async('string') : null };
};
const deleted = await rawBin(after, victim.id);
const landing = revivedIdFor(victim.id, deleted.meta, deleted.body);
const res = await restoreFromGraveyard(after, [victim.id]);
const { struct: restoredStruct } = await parseKlypix(res.buffer);
const restoredIds = (await idsOf(res.buffer)).order;
ok(res.restored.length === 1 && res.restored[0].restoredAs === landing,
  'restore brings the card back under the id its delete revives to — one every machine computes alike');
ok(!restoredIds.includes(victim.id) && restoredIds.filter(id => id === landing).length === 1,
  'the old id stays deleted, and the card is live exactly once under the new one');
ok(restoredStruct.cards.some(c => c.id === landing && String(c.text).includes(SECRET)), 'with its text intact');
const afterRestore = await listGraveyard(res.buffer);
const rReceipt = afterRestore.find(e => e.id === victim.id);
ok(afterRestore.length === 1 && rReceipt?.kind === 'restored' && rReceipt?.restoredAs === landing
  && (await listGraveyard(res.buffer, { receipts: 'hide' })).length === 0,
  'the entry becomes a restore receipt naming where the card went — no deleted card is left in the bin');
ok((await rawBin(res.buffer, victim.id)).body === PURGED_BODY, 'and the bin drops the bytes, which are live again');

// A second restore of the same id is refused and names where the card is.
const again = await restoreFromGraveyard(res.buffer, [victim.id]);
ok(again.restored.length === 0 && again.skipped[0]?.reason === `already restored as ${landing}`,
  'restoring twice is refused, not duplicated, and says where the card is');

// The landing walk: a landing id already live with the same text means the
// card is already back; one live with other text takes the card as a twin.
{
  const { zip, canvas } = await parseKlypix(after);
  const put = async (text) => {
    const z = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
    const item = JSON.parse(deleted.body);
    z.file(`items/${shard(landing)}/${landing}.json`, JSON.stringify({ ...item, content: text ?? item.content }));
    const c = { ...canvas, order: [...canvas.order, landing], positions: { ...canvas.positions, [landing]: { x: 5, y: 5, parentId: null } } };
    z.file('canvas.json', JSON.stringify(c));
    return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  const same = await restoreFromGraveyard(await put(null), [victim.id]);
  const sameOrder = (await idsOf(same.buffer)).order;
  ok(same.restored[0]?.already === true && same.restored[0]?.restoredAs === landing && sameOrder.filter(id => id === landing).length === 1,
    'a landing id already live with the same text: the card is already back, no second copy');
  const other = await restoreFromGraveyard(await put('someone else wrote here since'), [victim.id]);
  const twin = other.restored[0]?.restoredAs;
  ok(twin === twinIdFor(landing, deleted.body) && (await idsOf(other.buffer)).order.includes(landing) && (await idsOf(other.buffer)).order.includes(twin),
    'a landing id live with other text keeps that text and takes the restored card beside it as a twin');

  // A landing id with a bin entry of its own: a merge rescued an edit of the
  // card there, and a person deleted that since. Landing on it would put back
  // a card every other copy holds a deletion for, and they would delete it
  // again; the walk follows the entry to that card's own revival instead. A
  // restore receipt there sends it on to where that card went.
  const rescued = await put('an edit a merge rescued there');
  const gone = (await mergeBrains({ base: rescued, ours: rescued, theirs: rescued, deletedIds: [landing] })).buffer;
  const atLanding = await rawBin(gone, landing);
  const next = revivedIdFor(landing, atLanding.meta, atLanding.body);
  const brought = (await restoreFromGraveyard(gone, [landing])).buffer;
  const walks = async (restore) => {
    const f = await restore(gone, [victim.id]);
    const r = await restore(brought, [victim.id]);
    const fOrder = (await idsOf(f.buffer)).order;
    return f.restored[0]?.restoredAs === next && fOrder.includes(next) && !fOrder.includes(landing)
      && String(atLanding.body).includes('rescued')
      && r.restored[0]?.restoredAs === twinIdFor(next, deleted.body);
  };
  ok(await walks(restoreFromGraveyard),
    "a landing id with its own bin entry is never landed on: a delete there is followed to that card's revival, a restore receipt to where it went");
  // The same restore through a copy of the bin tools without that step.
  const MUT = path.join(ROOT, 'test', `.mutants-gy-${process.pid}`);
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'brain-graveyard.mjs'), 'utf8');
    const find = "as = entryKind(next) === 'R' ? String(next.restoredAs) : revivedIdFor(as, next, await binBody(as));";
    fs.mkdirSync(MUT, { recursive: true });
    fs.writeFileSync(path.join(MUT, 'brain-graveyard.mjs'), src.replace(find, 'return { as, already: false };').replaceAll("from './", "from '../../src/"));
    const M = src.split(find).length === 2 ? await import(pathToFileURL(path.join(MUT, 'brain-graveyard.mjs')).href) : null;
    ok(M && !(await walks(M.restoreFromGraveyard)), 'mutation: a walk that stops at a landing with its own entry fails that check');
  } finally {
    fs.rmSync(MUT, { recursive: true, force: true });
  }
}

// A card and its container restored in the same call: the card finds its
// container where the container landed.
{
  const containerId = (await idsOf(base)).positions[victim.id]?.parentId;
  const both = (await mergeBrains({ base, ours: base, theirs: base, deletedIds: [victim.id, containerId] })).buffer;
  for (const [label, order] of [['card first', [victim.id, containerId]], ['container first', [containerId, victim.id]]]) {
    const r = await restoreFromGraveyard(both, order);
    const at = Object.fromEntries(r.restored.map(x => [x.id, x.restoredAs]));
    const { positions: pos } = await idsOf(r.buffer);
    ok(Boolean(containerId) && r.restored.length === 2 && pos[at[victim.id]]?.parentId === at[containerId] && r.restored.every(x => !x.reparented),
      `a card restored with its container (${label}) is placed back inside the container where it landed`);
  }
}

// ── a merge never empties another machine's bin ──────────────────────────────
{
  const mergedAgain = await mergeBrains({ base, ours: after, theirs: base });
  ok((await listGraveyard(mergedAgain.buffer)).length === 1,
    "a peer who still has the card live does not resurrect it, and does not empty the other side's bin");
  const peerOrder = (await idsOf(mergedAgain.buffer)).order;
  ok(!peerOrder.includes(victim.id),
    'and the delete SURVIVES the merge — the tombstoned card stays out of the brain');
}

// ── purge is permanent, available for the secret case, and leaves a receipt ──
{
  const purged = await purgeGraveyard(after, { ids: [victim.id] });
  ok(purged.purged.length === 1 && (await listGraveyard(purged.buffer, { receipts: 'hide' })).length === 0,
    'purge empties the bin of deleted cards');
  const zip = await JSZip.loadAsync(purged.buffer);
  const leftovers = Object.keys(zip.files).filter(p => p.startsWith('graveyard/') && !zip.files[p].dir && !p.endsWith('graveyard.json'));
  const bodies = await Promise.all(leftovers.map(p => zip.file(p).async('string')));
  ok(bodies.length === 1 && bodies[0] === PURGED_BODY, "and the card's bytes are replaced by the empty placeholder");
  const raw = purged.buffer.toString('latin1');
  ok(!raw.includes(SECRET), 'the secret is no longer anywhere in the file');
  const inflated = await Promise.all(Object.keys(zip.files).filter(p => !zip.files[p].dir).map(p => zip.file(p).async('string')));
  ok(!inflated.some(t => t.includes(SECRET) || t.includes('oops pasted')), 'nor in any inflated entry — no preview, summary or text survives');

  const listed = await listGraveyard(purged.buffer);
  const receipt = listed.find(e => e.id === victim.id);
  ok(listed.length === 1 && receipt?.kind === 'purged' && receipt?.purged === true, 'the entry stays as a purge receipt (listed with receipts included)');
  ok(/^p_[0-9a-f]{16}$/.test(receipt?.rid || '') && receipt.rid !== fullEntryRid(victim.id, await readGraveyardCard(after, victim.id).then(JSON.stringify)),
    'with a random identity — not a hash of the purged content, which a short secret would not survive');
  const beforeMeta = (await listGraveyard(after)).find(e => e.id === victim.id);
  ok(receipt.deletedAt > beforeMeta.deletedAt && receipt.pos === undefined && receipt.area === undefined && receipt.preview === '',
    'newer than the entry it replaces (so older engines keep it), with no position, area or preview');
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

// ═════════════════════════════ Stage 2 receipts ═════════════════════════════

// ── purge receipts: idempotent, skipped by age purges, refused by restore ─────
{
  const purged = await purgeGraveyard(after, { ids: [victim.id] });
  const second = await purgeGraveyard(purged.buffer, { ids: [victim.id] });
  ok(second.purged.length === 0 && second.buffer === purged.buffer,
    'purging a receipt again is a no-op (nothing to purge, never restamped)');

  const zip = await JSZip.loadAsync(purged.buffer);
  const idx = JSON.parse(await zip.file('graveyard.json').async('string'));
  const stamp = JSON.stringify(idx.entries[victim.id]);
  idx.entries[victim.id].deletedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  zip.file('graveyard.json', JSON.stringify(idx));
  const agedReceipt = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const aged = await purgeGraveyard(agedReceipt, { olderThanDays: 30 });
  ok(aged.purged.length === 0, 'an age purge leaves receipts alone, however old');
  ok(stamp !== JSON.stringify(idx.entries[victim.id]) && (await listGraveyard(aged.buffer)).length === 1, 'and never drops them');

  const refused = await restoreFromGraveyard(purged.buffer, [victim.id]);
  ok(refused.restored.length === 0 && refused.skipped[0]?.reason === 'deleted permanently',
    'restore refuses a purge receipt — it would come back as an empty card');
  ok(!(await parseKlypix(refused.buffer)).canvas.order.includes(victim.id), 'and the brain is unchanged');

  // A restore receipt (written by a 1.88 restore, or a desktop) is refused too.
  const rZip = await JSZip.loadAsync(after);
  const rIdx = JSON.parse(await rZip.file('graveyard.json').async('string'));
  const body = await rZip.file(`graveyard/${shard(victim.id)}/${victim.id}.json`).async('string');
  rIdx.entries[victim.id] = contentFreeReceiptFor(victim.id, { meta: rIdx.entries[victim.id], json: body }, { kind: 'restored', restoredAs: `${victim.id}__r_0123456789ab` });
  rZip.file('graveyard.json', JSON.stringify(rIdx));
  rZip.file(`graveyard/${shard(victim.id)}/${victim.id}.json`, PURGED_BODY);
  const withR = await rZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const rRefused = await restoreFromGraveyard(withR, [victim.id]);
  ok(rRefused.restored.length === 0 && rRefused.skipped[0]?.reason === `already restored as ${victim.id}__r_0123456789ab`,
    'restore refuses a restore receipt and names where the card went');
  const rListed = (await listGraveyard(withR)).find(e => e.id === victim.id);
  ok(rListed?.kind === 'restored' && rListed?.rid === fullEntryRid(victim.id, body), 'a restore receipt lists as restored, keeping its entry identity');
  ok((await purgeGraveyard(withR, { ids: [victim.id] })).purged.length === 0, 'purge skips a restore receipt');
}

// ── listGraveyard: kinds, identities, hide/include ───────────────────────────
{
  const purged = (await purgeGraveyard(after, { ids: [victim.id] })).buffer;
  const liveCard = (await parseKlypix(purged)).struct.cards.find(c => /keep me one/.test(String(c.text || '')));
  const both = (await mergeBrains({ base: purged, ours: purged, theirs: purged, deletedIds: [liveCard.id] })).buffer;
  const inc = await listGraveyard(both);
  const hide = await listGraveyard(both, { receipts: 'hide' });
  ok(inc.length === 2 && hide.length === 1 && hide[0].id === liveCard.id && hide[0].kind === 'deleted',
    "list hides receipts on request ('include' stays the default for desktop 1.3.171, which filters them itself)");
  const bytes = await readGraveyardCard(both, liveCard.id);
  ok(hide[0].rid === fullEntryRid(liveCard.id, JSON.stringify(bytes)), 'a deleted card lists with its content identity');
  let threw = false; try { await listGraveyard(both, { receipts: 'none' }); } catch (e) { threw = e instanceof TypeError; }
  ok(threw, 'an unknown receipts mode is refused');
  ok(summarizeGraveyardCard === summarizeFromFormat, 'summarizeGraveyardCard is still exported from brain-graveyard (1.86 engines and the API-5 core import it there)');
}

// ── a purge survives merges with copies that still hold the bytes (R2) ───────
{
  const purged = (await purgeGraveyard(after, { ids: [victim.id] })).buffer;
  const stale = after;   // another machine: the card deleted, the bytes still in its bin
  const staleLive = base; // a machine that never saw the delete at all
  for (const [label, args] of [
    ['purged copy as ours, stale bin as theirs', { base, ours: purged, theirs: stale }],
    ['stale bin as ours, purged copy as theirs', { base, ours: stale, theirs: purged }],
  ]) {
    const m = await mergeBrains(args);
    const kind = entryKind((await listGraveyard(m.buffer)).find(e => e.id === victim.id));
    ok(kind === 'P' && !m.buffer.toString('latin1').includes(SECRET) && !(await readGraveyardCard(m.buffer, victim.id))?.content,
      `R2: ${label} — the receipt wins and the bytes do not come back`);
  }
  const m = await mergeBrains({ base, ours: purged, theirs: staleLive });
  ok(!(await parseKlypix(m.buffer)).canvas.order.includes(victim.id) && entryKind((await listGraveyard(m.buffer)).find(e => e.id === victim.id)) === 'P',
    'R2: against a copy that still shows the card live, the receipt holds and the card stays deleted');
  const oldPurged = (await OLD_GY.purgeGraveyard(after, { ids: [victim.id] })).buffer;
  const oldMerge = await mergeBrains({ base, ours: oldPurged, theirs: stale });
  ok(String((await readGraveyardCard(oldMerge.buffer, victim.id))?.content || '').includes(SECRET),
    'R2 mutation: the 1.86.3 purge drops the entry, and the stale bin carries the secret straight back (the check catches it)');
}

// ── a restore survives merges with copies that still hold the delete (R1) ────
// Machine A restores; machine B still holds the delete. Whatever path meets
// them — Brain Sync (3-way, or without a base), the git driver's options, or
// the app's own save (union, no options) — the card stays live under its new
// id and the old id stays a receipt, so it is never deleted a second time.
{
  const restoredA = (await restoreFromGraveyard(after, [victim.id])).buffer;
  const staleB = after;
  for (const [label, args] of [
    ['3-way, restored copy as ours', { base: after, ours: restoredA, theirs: staleB, options: { binMerge: '3way' } }],
    ['3-way, restored copy as theirs', { base: after, ours: staleB, theirs: restoredA, options: { binMerge: '3way' } }],
    ['no base (receipts)', { base: null, ours: staleB, theirs: restoredA, options: { binMerge: 'receipts' } }],
    ['app save (union, no options)', { base: after, ours: restoredA, theirs: staleB }],
  ]) {
    const m = await mergeBrains(args);
    const ord = (await idsOf(m.buffer)).order;
    const e = (await listGraveyard(m.buffer)).find(x => x.id === victim.id);
    ok(ord.includes(landing) && !ord.includes(victim.id) && e?.kind === 'restored',
      `R1: ${label} — the restored card stays live and the old delete stays a receipt`);
  }
  const restoredB = (await restoreFromGraveyard(after, [victim.id])).buffer;
  const both = await mergeBrains({ base: after, ours: restoredA, theirs: restoredB, options: { binMerge: '3way' } });
  const ord = (await idsOf(both.buffer)).order;
  ok(ord.filter(id => id === landing).length === 1 && !ord.some(id => id.startsWith(`${landing}__agconf_`)),
    'R1: two machines restoring the same card converge on one live copy, with no conflict twin');
  const oldRestored = (await OLD_GY.restoreFromGraveyard(after, [victim.id])).buffer;
  const om = await mergeBrains({ base: after, ours: oldRestored, theirs: staleB, options: { binMerge: '3way' } });
  ok(!(await idsOf(om.buffer)).order.includes(victim.id),
    'R1 mutation: a 1.86.3-style restore (old id, entry dropped) is deleted again by the copy that still holds the delete — the check catches it');
}

// ── the CLI round-trip (bin/klypix-brain-deleted.mjs) ────────────────────────
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-gy-cli-'));
  const HOME = path.join(TMP, 'home');
  fs.mkdirSync(HOME, { recursive: true });
  const brain = path.join(TMP, 'brain.klypix');
  fs.writeFileSync(brain, after);
  const env = { ...process.env, USERPROFILE: HOME, HOME };
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'bin', 'klypix-brain-deleted.mjs'), ...args, '--brain', brain], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  try {
    const listed = cli('list');
    ok(listed.code === 0 && listed.out.includes(victim.id), 'CLI: list shows the deleted card');

    const p = cli('purge', victim.id);
    ok(p.code === 0 && /Purged 1 deleted card/.test(p.out) && /kept as a receipt/.test(p.out), 'CLI: purge <id> purges and says the receipt is kept');
    const onDisk = fs.readFileSync(brain);
    ok(!onDisk.toString('latin1').includes(SECRET) && entryKind((await listGraveyard(onDisk)).find(e => e.id === victim.id)) === 'P',
      'CLI: the file now holds a purge receipt and not the secret');
    const history = fs.existsSync(path.join(HOME, '.claude')) ? fs.readdirSync(path.join(HOME, '.claude'), { recursive: true }) : [];
    ok(history.some(f => String(f).endsWith('.klypix')), 'CLI: a restore point was taken first (under the test HOME)');

    const after2 = cli('list');
    ok(after2.code === 0 && /Nothing deleted/.test(after2.out) && !after2.out.includes(victim.id), 'CLI: list hides the receipt');
    const one = cli('list', victim.id);
    ok(/permanently deleted/.test(one.out), 'CLI: list <id> on a receipt says it was permanently deleted');
    const r = cli('restore', victim.id);
    ok(r.code === 1 && /deleted permanently/.test(r.out) && /Nothing restored/.test(r.out), 'CLI: restore refuses a purge receipt, with the reason');
    const again = cli('purge', victim.id);
    ok(again.code === 0 && /Nothing matched/.test(again.out), 'CLI: purging it again matches nothing');

    // --all means every DELETED card: a new delete is purged, the receipt untouched.
    const liveCard = (await parseKlypix(fs.readFileSync(brain))).struct.cards.find(c => /keep me two/.test(String(c.text || '')));
    const cur = fs.readFileSync(brain);
    fs.writeFileSync(brain, (await mergeBrains({ base: cur, ours: cur, theirs: cur, deletedIds: [liveCard.id] })).buffer);
    const receiptBefore = JSON.stringify((await listGraveyard(fs.readFileSync(brain))).find(e => e.id === victim.id));
    const all = cli('purge', '--all');
    const binAfter = await listGraveyard(fs.readFileSync(brain));
    ok(all.code === 0 && /Purged 1 deleted card/.test(all.out) && binAfter.every(e => e.kind === 'purged')
      && JSON.stringify(binAfter.find(e => e.id === victim.id)) === receiptBefore,
      'CLI: purge --all purges every deleted card and leaves existing receipts exactly as they were');

    // The capture lock: a held lock refuses the write rather than racing it.
    const lock = path.join(TMP, '.claude', 'brain-capture.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'held-by-test');
    const bytesBefore = fs.readFileSync(brain);
    const busy = cli('restore', liveCard.id);
    ok(busy.code === 1 && /busy/.test(busy.out) && fs.readFileSync(brain).equals(bytesBefore), 'CLI: a held capture lock refuses the write and leaves the file alone');
    fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] brain-graveyard: all assertions passed');
process.exit(failures ? 1 : 0);
