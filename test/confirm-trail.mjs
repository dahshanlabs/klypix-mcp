// Confirmation trail (2026-09-29) — a FULL resolve settles the dashed 'likely
// closed by' hint on its card, on EVERY resolve channel, with honest actor
// grading in hintVia.
//
// The field finding this locks: hintVia:'human' was written only inside the
// id-addressed confirm branch, whose only producer is brain_reconcile confirm —
// while the channel agents actually use (the ✓ marker) archived the card and
// left its hint dangling forever (56 dashed hints from already-archived cards
// on the real KLYPIX brain). The fix routes the text-✓ full resolve through the
// same settle helper, unambiguous-only, with hintVia:'resolve' — NEVER 'human',
// because a terminal marker is agent-emittable.
//
//   CT1  text-✓ full resolve on a single-hint card → the edge becomes a solid
//        'closed by' with hintVia:'resolve' (not 'human'), reported in
//        stats.settledHints, no second arrow minted.
//   CT2  multi-hint ambiguous → every hint stays dashed (never guess).
//   CT3  a dismissed pair is untouched (and blocks the settle entirely).
//   CT4  a partial resolve relabels nothing — the card stays open and hedged.
//   CT5  idempotent on re-run: no double relabel, no extra edge.
//   CT6  the id-addressed confirm (byId) still writes hintVia:'human' — both
//        the relabel-in-place and the minted-edge halves (regression).
//   CT7  the byId-less path NEVER mints an edge on a hint-less card.
//   CT8  multi-hint with a DOMINANT coverage winner (≥0.5 and ≥1.5× runner-up)
//        settles exactly that one.
//   CT9  an all-refused brain_reconcile call leaves the brain byte-identical
//        (existing invariant, re-asserted here because this change touches the
//        same branch).
//   CT10 brain_reconcile mode:"claims" confirm {id, milestoneId} end-to-end:
//        archives, relabels with hintVia:'human', and shadows a
//        reconcile-confirm judgment into the provenance sidecar.
//   CT11 the advisory copy steers to the id-addressed confirm: klypix-core's
//        claims section and the hook's stale-gap footer both prefill
//        brain_reconcile mode:"claims" confirm calls (source-pinned).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

// Fresh temp HOME before any src import: every sidecar / lock this test causes
// must land under the temp dir, never the real profile.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-confirm-trail-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { buildKlypix, parseKlypix, captureIntoBrain, addBrainConnections } = await import('../src/klypix-format.mjs');
const { opBrainReconcile } = await import('../src/klypix-core.mjs');
const { readJudgments } = await import('../src/provenance.mjs');

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-confirm-trail-proj-'));

// One brain with every geometry the settle rule distinguishes.
const CARDS = [
  { text: 'Canvas: ❓ capsule header auto-fit is broken when collapsing grouped containers', area: 'Canvas' },
  { text: 'Canvas: 🏁 capsule header auto-fit fixed for collapsed grouped containers, shipped', area: 'Canvas' },
  { text: 'Sync: ❓ the operation log replay drops trailing batches during reconnect handshakes', area: 'Sync' },
  { text: 'Sync: 🏁 operation log replay hardened against dropped batches', area: 'Sync' },
  { text: 'Sync: 🏁 reconnect handshake rewritten with resumable cursors', area: 'Sync' },
  { text: 'Drive: ❓ upload receipts never reach the phone inbox after a pairing rotation', area: 'Drive' },
  { text: 'Drive: 🏁 pairing rotation keeps the phone inbox receipts flowing', area: 'Drive' },
  { text: 'Perf: ❓ remaining: warm the vector cache during startup preload + compress the embed queue backlog', area: 'Perf' },
  { text: 'Perf: 🏁 startup preload now warms the vector cache before first ask', area: 'Perf' },
  { text: 'Index: ❓ the crawler skips symlinked folders during vector indexing sweeps', area: 'Index' },
  { text: 'Index: 🏁 crawler follows symlinked folders during vector indexing sweeps safely', area: 'Index' },
  { text: 'Index: 🏁 sweep scheduler rebalanced for large roots', area: 'Index' },
  { text: 'Notes: ❓ the export dialog forgets its last chosen folder between sessions', area: 'Notes' },
];
// open3↔mile3 gets its hint AND its dismissal at build time, WRITTEN AS TWO
// INDEPENDENT EDGES: addBrainConnections would relabel the hint to
// '↩ dismissed hint' on the spot, but older builds (and merges) left brains
// where both coexist — exactly the case the settle's dismissed-pair guard is
// for (fulfillmentOverlaysFor doctrine: a dismissal WINS even when both edges
// coexist on the pair).
const built = await buildKlypix({ title: 'confirm-trail fixture', cards: CARDS, connections: [
  { from: 5, to: 6, relationship: 'relates_to', label: 'likely closed by' },
  { from: 5, to: 6, relationship: 'not_fulfilled' },
] });
let buf = Buffer.from(built.buffer ?? built);
let { struct } = await parseKlypix(buf);
const idOf = (needle) => (struct.cards.find(c => (c.text || '').includes(needle)) || {}).id;
const open1 = idOf('capsule header auto-fit is broken');
const mile1 = idOf('capsule header auto-fit fixed');
const open2 = idOf('replay drops trailing batches');
const mile2a = idOf('replay hardened against dropped batches');
const mile2b = idOf('reconnect handshake rewritten');
const open3 = idOf('upload receipts never reach the phone inbox');
const mile3 = idOf('pairing rotation keeps the phone inbox');
const open4 = idOf('warm the vector cache during startup preload +');
const mile4 = idOf('startup preload now warms the vector cache');
const open5 = idOf('crawler skips symlinked folders');
const mile5a = idOf('crawler follows symlinked folders');
const mile5b = idOf('sweep scheduler rebalanced');
const open6 = idOf('export dialog forgets its last chosen folder');
ok([open1, mile1, open2, mile2a, mile2b, open3, mile3, open4, mile4, open5, mile5a, mile5b, open6].every(Boolean),
  'fixture: every card resolved to an id');

// Dashed hints + one human dismissal, exactly as the engine draws them.
const hinted = await addBrainConnections(buf, [
  { fromId: open1, toId: mile1, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  { fromId: open2, toId: mile2a, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  { fromId: open2, toId: mile2b, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  { fromId: open4, toId: mile4, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  { fromId: open5, toId: mile5a, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  { fromId: open5, toId: mile5b, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
]);
buf = hinted.buffer;

const pairEdges = (canvas, a, b) => (canvas.connections || []).filter(cn =>
  (cn.fromId === a && cn.toId === b) || (cn.fromId === b && cn.toId === a));
const areaOf = async (buffer, id) => ((await parseKlypix(buffer)).struct.cards.find(c => c.id === id) || {}).area || '';

// ── CT1 — text-✓ full resolve settles the single unambiguous hint ───────────
const r1 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'capsule header auto-fit fixed when collapsing grouped containers' }],
});
{
  const { canvas, struct: s } = await parseKlypix(r1.buffer);
  ok(/^archive$/i.test((s.cards.find(c => c.id === open1) || {}).area || ''), 'CT1: the resolved card is archived');
  const pair = pairEdges(canvas, open1, mile1);
  ok(pair.length === 1, 'CT1: still exactly one edge on the pair — nothing minted');
  ok(pair[0].label === 'closed by' && pair[0].style === 'solid', 'CT1: the dashed hint became a solid "closed by"');
  ok(pair[0].hintVia === 'resolve', 'CT1: hintVia records the marker channel ("resolve"), which is agent-emittable');
  ok(pair[0].hintVia !== 'human', 'CT1: the text-✓ path NEVER claims the human grade');
  const settle = (r1.stats.settledHints || []).find(x => x.fromId === open1 && x.toId === mile1);
  ok(!!settle && settle.via === 'resolve' && settle.action === 'relabeled', 'CT1: the settle is reported in stats.settledHints for the provenance shadow');
  ok(!!settle && typeof settle.fromText === 'string' && settle.fromText.includes('capsule header'), 'CT1: settledHints carries the card texts for key-joining');
}
buf = r1.buffer;

// ── CT2 — multi-hint ambiguous: never guess ─────────────────────────────────
const r2 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'operation log replay no longer drops trailing batches during reconnect handshakes' }],
});
{
  const { canvas, struct: s } = await parseKlypix(r2.buffer);
  ok(/^archive$/i.test((s.cards.find(c => c.id === open2) || {}).area || ''), 'CT2: the card itself still resolves and archives');
  ok(pairEdges(canvas, open2, mile2a).every(cn => cn.label === 'likely closed by')
    && pairEdges(canvas, open2, mile2b).every(cn => cn.label === 'likely closed by'),
    'CT2: with two live hints and no dominant coverage, BOTH stay dashed');
  ok(!(r2.stats.settledHints || []).some(x => x.fromId === open2), 'CT2: no settle event is reported');
}
buf = r2.buffer;

// ── CT3 — a dismissed pair is untouched ─────────────────────────────────────
const r3 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'upload receipts reach the phone inbox after a pairing rotation again' }],
});
{
  const { canvas } = await parseKlypix(r3.buffer);
  const pair = pairEdges(canvas, open3, mile3);
  ok(pair.some(cn => cn.label === 'likely closed by') && pair.some(cn => cn.relationship === 'not_fulfilled'),
    'CT3: the dismissed pair keeps both its dashed hint and its dismissal edge');
  ok(!pair.some(cn => cn.label === 'closed by'), 'CT3: a human dismissal is never overridden by a ✓');
  ok(!(r3.stats.settledHints || []).some(x => x.fromId === open3), 'CT3: no settle event on a dismissed pair');
}
buf = r3.buffer;

// ── CT4 — a partial resolve relabels nothing ────────────────────────────────
const r4 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'warm the vector cache during startup preload' }],
});
{
  const { canvas, struct: s } = await parseKlypix(r4.buffer);
  const card = s.cards.find(c => c.id === open4);
  ok(!!card && /✔ partial/.test(card.text) && !/^archive$/i.test(card.area || ''), 'CT4: the clause card stays live with a ✔ partial note');
  ok(pairEdges(canvas, open4, mile4).every(cn => cn.label === 'likely closed by'), 'CT4: its hint stays dashed — a partly-done card is not closed');
  ok(!(r4.stats.settledHints || []).some(x => x.fromId === open4), 'CT4: no settle event on a partial');
}
buf = r4.buffer;

// ── CT5 — idempotent on re-run ──────────────────────────────────────────────
const r5 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'capsule header auto-fit fixed when collapsing grouped containers' }],
});
{
  const { canvas } = await parseKlypix(r5.buffer);
  const pair = pairEdges(canvas, open1, mile1);
  ok(pair.length === 1 && pair[0].label === 'closed by' && pair[0].hintVia === 'resolve',
    'CT5: re-running the same ✓ neither doubles the edge nor re-relabels it');
  ok(!(r5.stats.settledHints || []).length, 'CT5: the re-run reports zero settle events');
}
buf = r5.buffer;

// ── CT8 — dominant coverage settles exactly one of several hints ────────────
const r8 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'crawler follows symlinked folders during vector indexing sweeps' }],
});
{
  const { canvas } = await parseKlypix(r8.buffer);
  const winner = pairEdges(canvas, open5, mile5a);
  const loser = pairEdges(canvas, open5, mile5b);
  ok(winner.length === 1 && winner[0].label === 'closed by' && winner[0].hintVia === 'resolve',
    'CT8: the dominant-coverage hint (≥0.5 and ≥1.5× runner-up) is settled');
  ok(loser.every(cn => cn.label === 'likely closed by'), 'CT8: the runner-up hint stays dashed');
  const settles = (r8.stats.settledHints || []).filter(x => x.fromId === open5);
  ok(settles.length === 1 && settles[0].toId === mile5a, 'CT8: exactly one settle event, naming the winner');
}
buf = r8.buffer;

// ── CT7 — a hint-less card never gets a minted edge from the byId-less path ──
const r7 = await captureIntoBrain(buf, {
  resolutions: [{ text: 'the export dialog now remembers its last chosen folder between sessions' }],
});
{
  const { canvas, struct: s } = await parseKlypix(r7.buffer);
  ok(/^archive$/i.test((s.cards.find(c => c.id === open6) || {}).area || ''), 'CT7: the hint-less card still archives');
  ok(!(canvas.connections || []).some(cn => cn.label === 'closed by' && (cn.fromId === open6 || cn.toId === open6)),
    'CT7: the byId-less settle NEVER mints a new edge');
}
buf = r7.buffer;

// ── CT6 — the id-addressed confirm keeps its human grade (regression) ────────
{
  // Fresh mini-brain: one hinted pair (relabel half) + one bare pair (mint half).
  const b2 = await buildKlypix({ title: 'byid fixture', cards: [
    { text: 'A: ❓ the byid relabel target stays perfectly open for now', area: 'A' },
    { text: 'A: 🏁 the byid relabel evidence milestone shipped cleanly', area: 'A' },
    { text: 'B: ❓ the byid mint target has no hint edge at all yet', area: 'B' },
    { text: 'B: 🏁 the byid mint evidence milestone shipped cleanly too', area: 'B' },
  ] });
  let buf2 = Buffer.from(b2.buffer ?? b2);
  const s2 = (await parseKlypix(buf2)).struct;
  const gid = (needle) => (s2.cards.find(c => (c.text || '').includes(needle)) || {}).id;
  const aOpen = gid('relabel target'), aMile = gid('relabel evidence');
  const bOpen = gid('mint target'), bMile = gid('mint evidence');
  buf2 = (await addBrainConnections(buf2, [
    { fromId: aOpen, toId: aMile, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  ])).buffer;
  const rc = await captureIntoBrain(buf2, { resolutions: [
    { id: aOpen, byId: aMile, text: 'the relabel target is done' },
    { id: bOpen, byId: bMile, text: 'the mint target is done' },
  ] });
  const { canvas: c2 } = await parseKlypix(rc.buffer);
  const aPair = pairEdges(c2, aOpen, aMile);
  const bPair = pairEdges(c2, bOpen, bMile);
  ok(aPair.length === 1 && aPair[0].label === 'closed by' && aPair[0].hintVia === 'human',
    'CT6: an id-addressed confirm relabels in place with hintVia:"human" — the earned grade');
  ok(bPair.length === 1 && bPair[0].label === 'closed by' && bPair[0].hintVia === 'human' && bPair[0].relationship === 'relates_to',
    'CT6: with no existing hint the confirmed edge is minted exactly as before');
  ok((rc.stats.settledHints || []).filter(x => x.via === 'human').length === 2,
    'CT6: both id-addressed settles are reported with via:"human"');
}

// ── CT9 + CT10 — brain_reconcile end to end, with the provenance shadow ──────
{
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-confirm-trail-mcp-'));
  const brainFile = path.join(proj2, 'brain.klypix');
  const b3 = await buildKlypix({ title: 'reconcile fixture', cards: [
    { text: 'Relay: ❓ the screenshot relay consent record is not honoured by the canvas agent', area: 'Relay' },
    { text: 'Relay: 🏁 the canvas agent now honours the screenshot relay consent record', area: 'Relay' },
  ] });
  fs.writeFileSync(brainFile, Buffer.from(b3.buffer ?? b3));
  const s3 = (await parseKlypix(fs.readFileSync(brainFile))).struct;
  const rOpen = (s3.cards.find(c => /consent record is not honoured/.test(c.text || '')) || {}).id;
  const rMile = (s3.cards.find(c => /now honours the screenshot relay/.test(c.text || '')) || {}).id;
  const withHint = await addBrainConnections(fs.readFileSync(brainFile), [
    { fromId: rOpen, toId: rMile, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  ]);
  fs.writeFileSync(brainFile, withHint.buffer);

  // CT9 — all refused → byte-identical (and no judgment recorded).
  const before = sha256(fs.readFileSync(brainFile));
  const refused = await opBrainReconcile({ vault: proj2, canvas: brainFile, mode: 'claims',
    confirm: [{ id: 'txt_nosuchcard', milestoneId: rMile }, { id: rOpen, milestoneId: 'txt_alsomissing' }] });
  const refusedText = refused.blocks.map(b => b.text || '').join('\n');
  ok(/0 confirmed/.test(refusedText) && /2 refused/.test(refusedText), 'CT9: every entry is refused and counted');
  ok(sha256(fs.readFileSync(brainFile)) === before, 'CT9: an all-refused call leaves the brain byte-identical');
  ok(readJudgments(brainFile).length === 0, 'CT9: a refused call records no judgment');

  // CT10 — the real confirm.
  const applied = await opBrainReconcile({ vault: proj2, canvas: brainFile, mode: 'claims',
    confirm: [{ id: rOpen, milestoneId: rMile }] });
  const appliedText = applied.blocks.map(b => b.text || '').join('\n');
  ok(/1 confirmed/.test(appliedText), 'CT10: the confirm applies');
  const { canvas: c3, struct: s3b } = await parseKlypix(fs.readFileSync(brainFile));
  ok(/^archive$/i.test((s3b.cards.find(c => c.id === rOpen) || {}).area || ''), 'CT10: the open card is archived');
  const rPair = pairEdges(c3, rOpen, rMile).filter(cn => cn.label === 'closed by');
  ok(rPair.length === 1 && rPair[0].hintVia === 'human', 'CT10: the settled edge carries hintVia:"human" (listing-bound confirm)');
  const judgments = readJudgments(brainFile);
  const confirmRec = judgments.find(j => j.source === 'reconcile-confirm');
  ok(!!confirmRec && confirmRec.verdict === 'yes' && confirmRec.actor === 'agent-listing-bound'
    && confirmRec.from.id === rOpen && confirmRec.to.id === rMile,
    'CT10: the confirm is shadowed into the provenance sidecar with exact ids and the listing-bound actor');
  ok(!judgments.some(j => j.actor === 'human-ui'), 'CT10: nothing claims the reserved human-ui grade');
}

// ── CT11 — the advisory copy steers to the id-addressed channel ──────────────
{
  const stripCr = (s) => s.replace(/\r/g, '');
  const core = stripCr(fs.readFileSync(new URL('../src/klypix-core.mjs', import.meta.url), 'utf8'));
  const hook = stripCr(fs.readFileSync(new URL('../src/global-brain-hook.mjs', import.meta.url), 'utf8'));
  ok(/brain_reconcile mode:"claims" confirm:\[\{ id:"\$\{c\.open\.id\}", milestoneId:"\$\{c\.milestone\.id\}" \}\]/.test(core),
    'CT11: the claims advisory prefills the id-addressed confirm with REAL ids');
  ok(/human-typed fallback: \\`🧠 BRAIN \[/.test(core.replace(/\\/g, '\\')) || /human-typed fallback/.test(core),
    'CT11: the ✓ marker stays as the human-typed fallback in the claims advisory');
  ok(/brain_reconcile mode:"claims" confirm:\[\{ id:"\$\{g\.open\.id\}", milestoneId:"\$\{g\.by\.id\}" \}\]/.test(hook),
    'CT11: the stale-gap footer prefills the id-addressed confirm per gap');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* temp */ }
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ confirm-trail: all assertions passed');
process.exit(failures ? 1 : 0);
