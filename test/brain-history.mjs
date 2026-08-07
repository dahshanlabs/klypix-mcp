// brain-history — restore points for a co-owned brain. Covers every loss
// scenario the 2026-08-07 audit found unprotected, and the rules that keep the
// protection from becoming a problem of its own (repo pollution, unbounded
// growth, a snapshot failure blocking a save, an unparseable restore).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  historyDirFor,
  listBrainHistory,
  pruneBrainHistory,
  restoreBrainSnapshot,
  snapshotBrain,
} from '../src/brain-history.mjs';
import { atomicWrite, parseKlypix } from '../src/klypix-format.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

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

process.exit(failures ? 1 : 0);
