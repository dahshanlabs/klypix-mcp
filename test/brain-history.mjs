// brain-history — restore points for a co-owned brain. Covers every loss
// scenario the 2026-08-07 audit found unprotected, and the rules that keep the
// protection from becoming a problem of its own (repo pollution, unbounded
// growth, a snapshot failure blocking a save, an unparseable restore).
//
// Stage 2 (1.87): a restore is a MERGE, not a file copy — see the E-9 section.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import JSZip from 'jszip';
import { generateKeyBetween } from 'fractional-indexing';
import {
  historyDirFor,
  listBrainHistory,
  pruneBrainHistory,
  restoreBrainSnapshot,
  snapshotBrain,
} from '../src/brain-history.mjs';
import { atomicWrite, parseKlypix, shard, revivedIdFor, entryKind, PURGED_BODY } from '../src/klypix-format.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { mergeBrains, restoreSnapshotAsMerge } from '../src/merge-brains.mjs';
import { purgeGraveyard, restoreFromGraveyard } from '../src/brain-graveyard.mjs';
import { brainCaptureLockPath, withAdvisoryWriteLock } from '../src/brain-write-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = path.join(os.tmpdir(), 'klypix-history-home');
const project = path.join(os.tmpdir(), 'klypix-history-project');
for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
const brain = path.join(project, 'brain.klypix');

const brainWith = async (n) => buildKlypixMap({
  title: 'history fixture',
  kind: 'brain',
  areas: [{
    title: 'Work',
    cards: Array.from({ length: n }, (_, i) => ({ text: `card number ${i} with enough text to matter` })),
  }],
});

fs.writeFileSync(brain, await brainWith(12));

// ── snapshot basics ──────────────────────────────────────────────────────────
let t = 1_800_000_000_000;
const s1 = snapshotBrain(brain, { home, now: t, reason: 'test' });
ok(s1.saved === true, 'the first write snapshots the current bytes');
ok(historyDirFor(brain, home).startsWith(path.join(home, '.claude', 'project-brain', 'history')),
  'restore points live under the machine-local brain dir, never beside the brain');
ok(!fs.existsSync(path.join(project, '.klypix-history')) && fs.readdirSync(project).join() === 'brain.klypix',
  'the project directory gains NOTHING — no repo pollution, nothing for git or the merge driver to see');

const s2 = snapshotBrain(brain, { home, now: t + 1000, reason: 'test' });
ok(s2.saved === false && s2.skipped === 'unchanged', 'identical bytes are never stored twice');

fs.writeFileSync(brain, await brainWith(13));
const s3 = snapshotBrain(brain, { home, now: t + 2000, reason: 'test' });
ok(s3.saved === false && s3.skipped === 'throttled',
  'a routine write within the throttle window does not pile up restore points');

// The rule that matters: a write that SHRINKS the brain is the accident this
// exists for, and it must never be throttled away.
const beforeShrink = listBrainHistory(brain, { home }).length;
const bigNow = fs.statSync(brain).size;
const s4 = snapshotBrain(brain, { home, now: t + 3000, reason: 'app-save', nextBytes: Math.floor(bigNow * 0.5) });
ok(s4.saved === true && s4.shrinking === true,
  'a write that shrinks the brain ALWAYS snapshots, throttle or not (the deletion case)');
ok(listBrainHistory(brain, { home }).length === beforeShrink + 1, 'the shrink snapshot is actually on disk');

// ── the primary scenario, end to end: delete cards, save, get them back ──────
{
  const twelve = await brainWith(12);
  fs.writeFileSync(brain, twelve);
  snapshotBrain(brain, { home, now: t + 10_000, reason: 'app-save', force: true });
  const full = (await parseKlypix(fs.readFileSync(brain))).struct.cards.length;

  // The human deletes most of the cards and saves.
  fs.writeFileSync(brain, await brainWith(2));
  const wrecked = (await parseKlypix(fs.readFileSync(brain))).struct.cards.length;
  ok(wrecked < full, `fixture: the destructive save really removed cards (${full} → ${wrecked})`);

  const points = listBrainHistory(brain, { home });
  const restored = await restoreBrainSnapshot(brain, points[0].id, { home, now: t + 11_000, parse: parseKlypix });
  const after = (await parseKlypix(fs.readFileSync(brain))).struct.cards.length;
  ok(restored.ok && after === full,
    `an accidental mass-delete is fully recoverable (${wrecked} → ${after} cards)`);
  ok(Boolean(restored.safetyId),
    'the restore snapshotted the state it replaced — restoring is itself undoable');
  const undo = await restoreBrainSnapshot(brain, restored.safetyId, { home, now: t + 12_000, parse: parseKlypix });
  const afterUndo = (await parseKlypix(fs.readFileSync(brain))).struct.cards.length;
  ok(undo.ok && afterUndo === wrecked, 'and that undo actually returns the replaced state');
}

// ── the brain file itself is deleted ─────────────────────────────────────────
{
  fs.writeFileSync(brain, await brainWith(9));
  snapshotBrain(brain, { home, now: t + 20_000, reason: 'test', force: true });
  fs.rmSync(brain);
  const points = listBrainHistory(brain, { home });
  ok(points.length > 0, 'restore points survive deletion of the brain file itself (they are not stored beside it)');
  const res = await restoreBrainSnapshot(brain, points[0].id, { home, now: t + 21_000, parse: parseKlypix });
  ok(res.ok && fs.existsSync(brain), 'a deleted brain can be recreated from a restore point');
}

// ── a corrupt restore point must not replace a working brain ─────────────────
{
  const good = await brainWith(5);
  fs.writeFileSync(brain, good);
  const dir = historyDirFor(brain, home);
  const corruptId = `${t + 30_000}-deadbeef`;
  fs.writeFileSync(path.join(dir, `${corruptId}.klypix`), Buffer.from('not a zip at all'));
  const res = await restoreBrainSnapshot(brain, corruptId, { home, now: t + 31_000, parse: parseKlypix });
  ok(!res.ok && /does not parse/.test(res.error || ''), 'restoring a corrupt point is refused, with a reason');
  ok(Buffer.compare(fs.readFileSync(brain), good) === 0, 'and the working brain is left untouched');
  fs.rmSync(path.join(dir, `${corruptId}.klypix`));
}

// ── retention is bounded ─────────────────────────────────────────────────────
{
  const dir = historyDirFor(brain, home);
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.klypix')) fs.rmSync(path.join(dir, f));
  const day = 24 * 60 * 60 * 1000;
  // 30 points today (only 20 survive) + one per day going back 30 days (only
  // the last 14 days survive).
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `${t + i * 1000}-${String(i).padStart(8, '0')}.klypix`), Buffer.from(`x${i}`));
  for (let d = 1; d <= 30; d++) fs.writeFileSync(path.join(dir, `${t - d * day}-${String(d).padStart(7, 'a')}0.klypix`), Buffer.from(`d${d}`));
  const removed = pruneBrainHistory(brain, { home, now: t });
  const left = listBrainHistory(brain, { home });
  // Ceiling = newest 20 + one per distinct day in the window. The window spans
  // today plus the 14 preceding days, so 15 days, and the two sets can be
  // disjoint: 35 is the true maximum, not 34.
  ok(removed > 0 && left.length <= 20 + 15,
    `retention is bounded: ${left.length} kept, ${removed} pruned (cap = newest 20 + one/day across 15 days)`);
  ok(left.some((e) => e.ts < t - 10 * day),
    'points from more than ten days ago still exist — a slow-burn accident is still recoverable');
  ok(!left.some((e) => e.ts < t - 15 * day),
    'and nothing older than the daily window is retained');
}

// ── atomicWrite wiring: the engine choke point snapshots on its own ──────────
{
  const dir2 = path.join(os.tmpdir(), 'klypix-history-project2');
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.mkdirSync(dir2, { recursive: true });
  const brain2 = path.join(dir2, 'brain.klypix');
  const plain2 = path.join(dir2, 'notes.klypix');
  fs.writeFileSync(brain2, await brainWith(6));
  fs.writeFileSync(plain2, await brainWith(6));
  const before = listBrainHistory(brain2, {}).length;
  await atomicWrite(brain2, await brainWith(7));
  ok(listBrainHistory(brain2, {}).length === before + 1,
    'atomicWrite snapshots a brain automatically — every agent/hook/MCP write is covered');
  await atomicWrite(plain2, await brainWith(7));
  ok(listBrainHistory(plain2, {}).length === 0,
    'a normal canvas gets NO restore points (deliberate: one human, observed work)');
  // buildKlypixMap emits an area/title card alongside the requested ones, so
  // assert the RELATIONSHIP (7-card fixture > 6-card fixture) rather than a
  // literal count that silently encodes the fixture's own shape.
  const parsed = await parseKlypix(fs.readFileSync(brain2));
  const six = (await parseKlypix(await brainWith(6))).struct.cards.length;
  ok(parsed.struct.cards.length === six + 1, 'and the write itself still landed correctly');
  fs.rmSync(historyDirFor(brain2, os.homedir()), { recursive: true, force: true });
}

// ── the field scenario: a deleting save INSIDE the throttle window ───────────
// Verification against a copy of the real 1,980-card KLYPIX brain caught this
// twice. An agent capture writes (and snapshots). Seconds later — still inside
// the throttle window — a save removes 400 cards. If that write is throttled,
// the state containing the agent's card is never captured. Two "cheap" shrink
// signals both failed here: byte size (re-zipping changed compression, so the
// smaller brain produced a BIGGER file) and item-file count (the ids leave
// canvas.json's `order` while their item files linger as orphans). Only
// `order.length` is the real card set.
{
  const dir4 = path.join(os.tmpdir(), 'klypix-history-project4');
  fs.rmSync(dir4, { recursive: true, force: true });
  fs.mkdirSync(dir4, { recursive: true });
  const brain4 = path.join(dir4, 'brain.klypix');
  fs.rmSync(historyDirFor(brain4, os.homedir()), { recursive: true, force: true });
  fs.writeFileSync(brain4, await brainWith(40));

  await atomicWrite(brain4, await brainWith(41), { reason: 'agent-capture' });
  const afterCapture = listBrainHistory(brain4, {}).length;
  ok(afterCapture === 1, 'the agent write leaves one restore point');

  // Immediately (throttle window is wide open), drop cards from `order` while
  // deliberately LEAVING their item files behind — the exact shape that fooled
  // the item-count check.
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(brain4));
  const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
  const kept = canvas.order.length - 20;
  canvas.order = canvas.order.slice(0, kept);
  zip.file('canvas.json', JSON.stringify(canvas));
  const wrecked = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await atomicWrite(brain4, wrecked, { reason: 'app-save' });

  const points = listBrainHistory(brain4, {});
  ok(points.length === afterCapture + 1,
    'a card-removing save is NEVER throttled away — it gets its own restore point');
  const restored = await restoreBrainSnapshot(brain4, points[0].id, { parse: parseKlypix });
  const back = (await parseKlypix(fs.readFileSync(brain4))).struct.cards.length;
  const expected = (await parseKlypix(await brainWith(41))).struct.cards.length;
  ok(restored.ok && back === expected,
    'restoring returns the pre-delete state, agent card included');
  fs.rmSync(historyDirFor(brain4, os.homedir()), { recursive: true, force: true });
}

// ── a snapshot failure must never block a write ──────────────────────────────
{
  const dir3 = path.join(os.tmpdir(), 'klypix-history-project3');
  fs.rmSync(dir3, { recursive: true, force: true });
  fs.mkdirSync(dir3, { recursive: true });
  const brain3 = path.join(dir3, 'brain.klypix');
  fs.writeFileSync(brain3, await brainWith(4));
  // Point the history at a path that cannot be a directory, so every snapshot
  // attempt throws inside the module.
  const blocked = path.join(dir3, 'blocker');
  fs.writeFileSync(blocked, 'not a directory');
  const res = snapshotBrain(brain3, { home: blocked, now: t, force: true });
  ok(res.saved === false && res.skipped === 'error', 'a snapshot that cannot be written reports, never throws');
  let wrote = true;
  const fiveCards = (await parseKlypix(await brainWith(5))).struct.cards.length;
  try { await atomicWrite(brain3, await brainWith(5)); } catch { wrote = false; }
  ok(wrote && (await parseKlypix(fs.readFileSync(brain3))).struct.cards.length === fiveCards,
    'and the brain write still succeeds — protection never costs a save');
  fs.rmSync(historyDirFor(brain3, os.homedir()), { recursive: true, force: true });
}

// ── E-9: a restore is a MERGE, not a file copy ───────────────────────────────
// Copying the point's bytes over the file made every card written since vanish
// with no record, and put deleted cards back under ids other copies hold a
// deletion for. Brain Sync and git then undid the restore card by card: the
// added cards came back from any other copy, the revived ones were deleted
// again. As a merge, cards added since go to Deleted cards with a receipt,
// deleted cards come back under the id their delete revives to, purged cards
// stay out, and every copy converges on the result.
{
  const itemPath = (id) => `items/${shard(id)}/${id}.json`;
  const editZip = async (buf, fn) => {
    const zip = await JSZip.loadAsync(buf);
    const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
    await fn(zip, canvas);
    zip.file('canvas.json', JSON.stringify(canvas));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  const setText = (buf, id, content) => editZip(buf, async (zip) => {
    const item = JSON.parse(await zip.file(itemPath(id)).async('string'));
    zip.file(itemPath(id), JSON.stringify({ ...item, content }));
  });
  // An old writer that drops a card and leaves nothing behind.
  const wipe = (buf, id) => editZip(buf, async (zip, canvas) => {
    canvas.order = canvas.order.filter((x) => x !== id);
    delete canvas.positions[id];
    zip.remove(itemPath(id));
  });
  const addCard = (buf, id, content, parentId) => editZip(buf, async (zip, canvas) => {
    const top = Object.values(canvas.positions).map((p) => p.zKey).filter(Boolean).sort().pop() || null;
    zip.file(itemPath(id), JSON.stringify({ type: 'text', createdAt: 1, createdBy: 'agent', content }));
    canvas.order.push(id);
    canvas.positions[id] = { x: 96, y: 900, w: 280, h: 47, zKey: generateKeyBetween(top, null), zIndex: canvas.order.length - 1, parentId };
  });
  const binOf = async (buf) => {
    const zip = await JSZip.loadAsync(buf);
    const index = zip.file('graveyard.json');
    const entries = index ? JSON.parse(await index.async('string')).entries || {} : {};
    const body = async (id) => { const f = zip.file(`graveyard/${shard(id)}/${id}.json`); return f ? f.async('string') : null; };
    return { entries, body };
  };
  const allText = async (buf) => {
    const zip = await JSZip.loadAsync(buf);
    let s = '';
    for (const p of Object.keys(zip.files)) if (!zip.files[p].dir && !p.startsWith('assets/')) s += await zip.file(p).async('string');
    return s;
  };
  const liveOf = async (buf) => (await parseKlypix(buf)).struct.cards.map((c) => ({ id: c.id, text: String(c.text || '') }));
  const OPTS = { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true };

  const dir5 = path.join(os.tmpdir(), 'klypix-history-project5');
  fs.rmSync(dir5, { recursive: true, force: true });
  fs.mkdirSync(dir5, { recursive: true });
  const brain5 = path.join(dir5, 'brain.klypix');
  const SECRET = 'sk-live-HISTORY-SECRET-0123456789';
  const point = await buildKlypixMap({
    title: 'restore merge fixture',
    kind: 'brain',
    areas: [{
      title: 'Work',
      cards: [
        { text: 'alpha: the decision as it was' },
        { text: 'bravo: deleted later, unchanged' },
        { text: 'charlie: as it was before the edit' },
        { text: 'delta: wiped later by an old writer' },
        { text: `echo: a pasted credential ${SECRET}` },
      ],
    }],
  });
  const cardsAtPoint = await liveOf(point);
  const idOf = (needle) => cardsAtPoint.find((c) => c.text.includes(needle))?.id;
  const [A, B, C, D, P] = ['alpha:', 'bravo:', 'charlie:', 'delta:', 'echo:'].map(idOf);
  ok([A, B, C, D, P].every(Boolean), 'E-9 fixture: five cards at the restore point');
  const work = JSON.parse(await (await JSZip.loadAsync(point)).file('canvas.json').async('string')).positions[A].parentId;

  fs.writeFileSync(brain5, point);
  const pointSnap = snapshotBrain(brain5, { home, now: t + 40_000, reason: 'test', force: true });

  // After the point: A edited; C edited and then deleted; B deleted as it was;
  // P deleted and purged; D wiped with no record; N captured.
  let pre = await setText(point, A, 'alpha: EDITED after the point');
  pre = await setText(pre, C, 'charlie: EDITED after the point');
  pre = (await mergeBrains({ base: pre, ours: pre, theirs: pre, deletedIds: [B, C, P] })).buffer;
  pre = (await purgeGraveyard(pre, { ids: [P] })).buffer;
  pre = await wipe(pre, D);
  const N = 'txt_captured_after_the_point';
  pre = await addCard(pre, N, 'november: captured after the point', work);
  fs.writeFileSync(brain5, pre);

  const binPre = await binOf(pre);
  ok(entryKind(binPre.entries[B]) === 'F' && entryKind(binPre.entries[C]) === 'F' && entryKind(binPre.entries[P]) === 'P'
    && !binPre.entries[D] && (await liveOf(pre)).some((c) => c.id === N),
  'E-9 fixture: B and C deleted with bytes, P purged, D gone without a record, N added');
  const expectB = revivedIdFor(B, binPre.entries[B], await binPre.body(B));
  const expectC = revivedIdFor(C, binPre.entries[C], await binPre.body(C));

  const res = await restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 41_000, parse: parseKlypix });
  const out = fs.readFileSync(brain5);
  const live = await liveOf(out);
  const textAt = (id) => live.find((c) => c.id === id)?.text ?? null;
  const bin = await binOf(out);

  ok(res.ok && res.mode === 'merge', 'E-9: restore runs as a merge under the brain lock, not a file copy');
  ok(res.reverted.includes(A) && textAt(A)?.includes('as it was') && !live.some((c) => c.text.includes('alpha: EDITED')),
    'E-9: a card edited since the point is set back (a restore still reverts edits)');
  ok(res.restored.includes(D) && textAt(D)?.includes('delta:'),
    'E-9: a card that left with no record comes back under its own id');
  const rb = res.revived.find((r) => r.id === B);
  ok(rb?.as === expectB && !rb.already && textAt(expectB)?.includes('bravo:') && textAt(B) === null,
    'E-9: a card deleted since comes back under the id its delete revives to; the old id stays deleted everywhere');
  ok(entryKind(bin.entries[B]) === 'R' && bin.entries[B].restoredAs === expectB && (await bin.body(B)) === PURGED_BODY,
    'E-9: its entry becomes a restore receipt pointing there, and the bytes leave the bin (they are live again)');
  const rc = res.revived.find((r) => r.id === C);
  ok(rc?.as === expectC && textAt(expectC)?.includes('as it was before the edit'),
    'E-9: a card edited and then deleted comes back as it was at the point');
  ok(entryKind(bin.entries[C]) === 'F' && (await bin.body(C))?.includes('charlie: EDITED after the point'),
    'E-9: and the newer text it was deleted with stays in Deleted cards, recoverable');
  ok(res.keptPurged.includes(P) && !live.some((c) => c.text.includes(SECRET)) && entryKind(bin.entries[P]) === 'P',
    'E-9: a purged card stays out, and its purge receipt stays');
  ok(!(await allText(out)).includes(SECRET),
    'E-9: the purged text is nowhere in the file — the point still holds it, the restore does not carry it back');
  ok(res.buried.includes(N) && textAt(N) === null,
    'E-9: a card added since the point moves to Deleted cards');
  const eN = bin.entries[N];
  ok(entryKind(eN) === 'F' && eN.deletion?.cause === 'history-restore' && eN.deletion?.initiator === 'user'
    && (await bin.body(N))?.includes('november:'),
  'E-9: with its bytes and a receipt saying a history restore moved it');
  const lost = (await liveOf(pre)).filter((c) => textAt(c.id) === null && entryKind(bin.entries[c.id]) !== 'F');
  ok(lost.length === 0, `E-9: every card live before the restore is live after it or in Deleted cards with its bytes${lost.length ? ` (lost: ${lost.map((c) => c.id).join(', ')})` : ''}`);

  // The bin restore and the history restore agree: C's newer text, restored
  // from the bin, lands beside the card the history restore brought back.
  const fromBin = await restoreFromGraveyard(out, [C]);
  const liveBin = await liveOf(fromBin.buffer);
  ok(liveBin.some((c) => c.text.includes('charlie: EDITED after the point')) && liveBin.some((c) => c.text.includes('charlie: as it was before the edit')),
    'E-9: restoring the newer text from Deleted cards afterwards keeps both versions');

  // Every copy converges: Brain Sync or git merging the restored file with a
  // copy from before the restore keeps the restore, in both directions.
  const sticks = async (restored) => {
    for (const [ours, theirs] of [[restored, pre], [pre, restored]]) {
      const texts = (await liveOf((await mergeBrains({ base: pre, ours, theirs, options: OPTS })).buffer)).map((c) => c.text);
      const good = !texts.some((x) => x.includes('november:'))
        && texts.some((x) => x.includes('bravo:'))
        && texts.some((x) => x.includes('alpha: the decision as it was'))
        && !texts.some((x) => x.includes('alpha: EDITED'))
        && !texts.some((x) => x.includes(SECRET));
      if (!good) return false;
    }
    return true;
  };
  ok(await sticks(out), 'E-9: a sync or git merge with a copy from before the restore keeps the restore, both directions');
  ok(!(await sticks(point)),
    'E-9 mutation: the old whole-file restore is undone by that same merge (the added card returns, the revived one is deleted again)');

  // Two machines restoring the same point land every card on the same id.
  const m1 = await restoreSnapshotAsMerge({ current: pre, snapshot: point, now: t + 50_000 });
  const m2 = await restoreSnapshotAsMerge({ current: pre, snapshot: point, now: t + 60_000 });
  const both = await mergeBrains({ base: pre, ours: m1.buffer, theirs: m2.buffer, options: OPTS });
  const ids1 = (await liveOf(m1.buffer)).map((c) => c.id).sort();
  const idsBoth = (await liveOf(both.buffer)).map((c) => c.id).sort();
  ok(JSON.stringify(ids1) === JSON.stringify(idsBoth) && !idsBoth.some((id) => id.includes('__agconf_')),
    'E-9: two machines restoring the same point converge on one copy of each card, no twins');

  // Restoring the same point again changes nothing.
  const again = await restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 42_000, parse: parseKlypix });
  ok(again.ok && again.mode === 'merge' && again.buried.length === 0 && again.reverted.length === 0
    && again.restored.length === 0 && again.revived.length > 0 && again.revived.every((r) => r.already),
  'E-9: restoring the same point twice changes nothing the second time');

  // A card already back under its new id and edited since: the restore sets
  // that incarnation back, and reports it.
  fs.writeFileSync(brain5, await setText(fs.readFileSync(brain5), expectB, 'bravo: EDITED once it was back'));
  const third = await restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 42_500, parse: parseKlypix });
  const liveThird = await liveOf(fs.readFileSync(brain5));
  ok(third.ok && third.reverted.includes(expectB) && third.revived.find((r) => r.id === B)?.already === true
    && liveThird.find((c) => c.id === expectB)?.text.includes('bravo: deleted later, unchanged'),
  'E-9: a card already back under its new id is set back there, and reported as set back');

  // The restore is itself undoable: what it moved aside comes back.
  const undo = await restoreBrainSnapshot(brain5, res.safetyId, { home, now: t + 43_000, parse: parseKlypix });
  const afterUndo = await liveOf(fs.readFileSync(brain5));
  ok(undo.ok && afterUndo.some((c) => c.text.includes('november:')) && afterUndo.some((c) => c.text.includes('alpha: EDITED')),
    'E-9: undoing the restore brings back what it moved aside');

  // --include-purged is the one deliberate way back for a purged card.
  fs.writeFileSync(brain5, pre);
  const withPurged = await restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 44_000, parse: parseKlypix, includePurged: true });
  const wpBuf = fs.readFileSync(brain5);
  const rp = withPurged.revived.find((r) => r.id === P);
  ok(withPurged.ok && rp && rp.as !== P && (await liveOf(wpBuf)).some((c) => c.id === rp.as && c.text.includes(SECRET)),
    'E-9: --include-purged brings a purged card back, deliberately, under a new id');
  ok(entryKind((await binOf(wpBuf)).entries[P]) === 'P',
    'E-9: and the purge receipt stays, so every other copy still drops the old id');

  // Another writer holds the lock: refuse, change nothing.
  fs.writeFileSync(brain5, pre);
  const busy = await withAdvisoryWriteLock(brainCaptureLockPath(brain5), async (locked) => (locked
    ? restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 45_000, parse: parseKlypix })
    : null));
  ok(busy && !busy.ok && /^busy/.test(busy.error || '') && Buffer.compare(fs.readFileSync(brain5), pre) === 0,
    'E-9: while another writer holds the brain lock, restore refuses and changes nothing');

  // A missing brain has nothing to merge into: recreated as-is.
  fs.rmSync(brain5);
  const rec = await restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 46_000, parse: parseKlypix });
  ok(rec.ok && rec.mode === 'recreate' && Buffer.compare(fs.readFileSync(brain5), point) === 0,
    'E-9: a missing brain is recreated from the point as-is');

  // Mixed installs: beside a 1.86.3 engine, or none, restore keeps working as
  // the whole-file write and says so.
  const FIX = path.join(root, 'test', 'fixtures', 'engine-1.86.3');
  const LOCK_SHIM = "export * from '../../../../src/brain-write-lock.mjs';\n";
  for (const [label, files] of [
    ['a 1.86.3 merge engine', { 'merge-brains.mjs': "export * from '../merge-brains.mjs';\n", 'brain-write-lock.mjs': LOCK_SHIM }],
    ['no merge engine at all', { 'brain-write-lock.mjs': LOCK_SHIM }],
  ]) {
    const MIX = fs.mkdtempSync(path.join(FIX, '.hist-'));
    try {
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(MIX, f), body);
      fs.copyFileSync(path.join(root, 'src', 'brain-history.mjs'), path.join(MIX, 'brain-history.mjs'));
      const H = await import(pathToFileURL(path.join(MIX, 'brain-history.mjs')).href);
      fs.writeFileSync(brain5, pre);
      const r = await H.restoreBrainSnapshot(brain5, pointSnap.id, { home, now: t + 47_000, parse: parseKlypix });
      ok(r.ok && r.mode === 'whole-file' && Buffer.compare(fs.readFileSync(brain5), point) === 0,
        `E-9: beside ${label}, restore still works as the whole-file write, and says so`);
    } finally {
      fs.rmSync(MIX, { recursive: true, force: true });
    }
  }
  fs.rmSync(dir5, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
