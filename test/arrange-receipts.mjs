// arrange-receipts — E-8 (Stage 2, 1.89). Arrange collapses duplicate cards
// and containers. It used to REMOVE the losers and nothing else, which no other
// copy of the brain could see: the next Brain Sync or git merge read the
// absence as nothing and carried every duplicate back. And the survivor was
// picked by connections, child count and file order — all of which differ per
// machine — so two machines arranging the same duplicates each kept a
// different copy and buried the other's.
//
// Now each loser goes to Deleted cards with its bytes and a receipt naming the
// card it merged into, and the survivor is decided by content and ids alone.
// The load-bearing checks are the cross-copy ones: a stale copy cannot bring
// the duplicates back, and two machines converge on one card.
//
// Run:  node test/arrange-receipts.mjs        (exit 0 = pass, 1 = fail)
import JSZip from 'jszip';
import { generateKeyBetween } from 'fractional-indexing';
import {
    buildKlypixMap, parseKlypix, arrangeBrain, shard, entryKind, contentFreeReceiptFor, PURGED_BODY,
} from '../src/klypix-format.mjs';
import { mergeBrains, MERGE_ENGINE_FEATURES } from '../src/merge-brains.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '[ok]' : '[x]'} ${label}`); if (!cond) failures++; };

// The options every whole-file transport (the git driver, Brain Sync) merges with.
const OPTS = { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true };
const itemPath = (id) => `items/${shard(id)}/${id}.json`;
const binPath = (id) => `graveyard/${shard(id)}/${id}.json`;

async function edit(buf, fn) {
    const zip = await JSZip.loadAsync(buf);
    const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
    await fn(zip, canvas);
    zip.file('canvas.json', JSON.stringify(canvas));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const topZ = (canvas) => Object.values(canvas.positions).map((p) => p.zKey).filter(Boolean).sort().pop() || null;
const setField = (buf, id, patch) => edit(buf, async (zip) => {
    const j = JSON.parse(await zip.file(itemPath(id)).async('string'));
    zip.file(itemPath(id), JSON.stringify({ ...j, ...patch }));
});
const cloneAs = (buf, fromId, newId, patch = {}, parentId) => edit(buf, async (zip, canvas) => {
    const j = JSON.parse(await zip.file(itemPath(fromId)).async('string'));
    zip.file(itemPath(newId), JSON.stringify({ ...j, ...patch }));
    const p = canvas.positions[fromId];
    canvas.positions[newId] = { ...p, x: (p.x || 0) + 400, zKey: generateKeyBetween(topZ(canvas), null), ...(parentId !== undefined ? { parentId } : {}) };
    canvas.order.push(newId);
});
const connect = (buf, id, fromId, toId) => edit(buf, async (zip, canvas) => {
    canvas.connections = [...(canvas.connections || []), { id, fromId, toId, relationship: 'relates_to', label: '' }];
});
const reorder = (buf, fn) => edit(buf, async (zip, canvas) => { canvas.order = fn(canvas.order); });
const itemJson = async (buf, id) => (await JSZip.loadAsync(buf)).file(itemPath(id))?.async('string') ?? null;
async function binOf(buf) {
    const zip = await JSZip.loadAsync(buf);
    const index = zip.file('graveyard.json');
    const entries = index ? JSON.parse(await index.async('string')).entries || {} : {};
    const body = async (id) => { const f = zip.file(binPath(id)); return f ? f.async('string') : null; };
    return { entries, body };
}
const liveOf = async (buf) => (await parseKlypix(buf)).struct.cards;
const countText = async (buf, needle) => (await liveOf(buf)).filter((c) => String(c.text || '').includes(needle)).length;

// ── fixture ──────────────────────────────────────────────────────────────────
// Work holds a decision duplicated three times and a neighbour; a second
// "Work" container (W2, younger) holds one card of its own. Every tiebreak a
// broken rule could fall back to points AWAY from the right survivor: the
// oldest copy (D2) has the LARGEST id, is never the most connected, and is
// last in machine A's file order.
let common = await buildKlypixMap({
    title: 'arrange fixture',
    kind: 'brain',
    areas: [
        { title: 'Work', cards: [{ text: 'Work: the duplicated decision' }, { text: 'Work: a neighbour card' }] },
        { title: 'Other', cards: [{ text: 'Other: something else entirely' }] },
    ],
});
const at0 = await liveOf(common);
const D0 = at0.find((c) => String(c.text).includes('duplicated decision')).id;
const N0 = at0.find((c) => String(c.text).includes('neighbour card')).id;
const WORK = at0.find((c) => c.type === 'container' && c.title === 'Work').id;
const OTHER = at0.find((c) => c.type === 'container' && c.title === 'Other').id;
const D1 = 'txt_00_dup_copy', D2 = 'txt_zz_dup_copy', W2 = 'ctn_second_work', W2C = 'txt_only_in_second_work';
common = await setField(common, D0, { createdAt: 2000 });
common = await setField(common, WORK, { createdAt: 1000 });
common = await cloneAs(common, D0, D1, { createdAt: 3000 });
common = await cloneAs(common, D0, D2, { createdAt: 1000 });
common = await cloneAs(common, WORK, W2, { createdAt: 5000 }, null);
common = await cloneAs(common, N0, W2C, { content: 'Work: only in the second Work', createdAt: 5000 }, W2);
ok((await countText(common, 'duplicated decision')) === 3 && [D0, D1, D2].sort()[2] === D2 && [D0, D1, D2].sort()[0] === D1,
    'fixture: three copies of one decision (the oldest has the largest id), one Work container too many');

// Machine A: the youngest copy (also the smallest id) is the most connected.
// Machine B: another copy is, and its order lists everything the other way round.
const preA = await connect(common, 'cn_a', D1, N0);
const preB = await reorder(await connect(common, 'cn_b', D0, OTHER), (o) => [...o].reverse());

const A = await arrangeBrain(preA);
const B = await arrangeBrain(preB);

// ── the survivor: content and ids only ──────────────────────────────────────
const groupOf = (r) => r.stats.collapsedCards.find((g) => [D0, D1, D2].includes(g.kept));
const keptA = groupOf(A)?.kept, keptB = groupOf(B)?.kept;
ok(keptA === D2 && keptB === D2,
    `E-8: the oldest copy survives on both machines — not the most connected, not the first in file order (A kept ${keptA}, B kept ${keptB})`);
ok(A.stats.mergedContainers[0]?.kept === WORK && B.stats.mergedContainers[0]?.kept === WORK,
    'E-8: the oldest duplicate container survives, whatever holds the most children');
ok(JSON.stringify([...A.stats.buried].sort()) === JSON.stringify([D0, D1, W2].sort())
    && JSON.stringify([...B.stats.buried].sort()) === JSON.stringify([D0, D1, W2].sort()),
    'E-8: both machines bury the same losers — every collapsed card and container, listed in stats.buried');

// ── the burial: bytes plus a receipt naming the survivor ────────────────────
{
    const bin = await binOf(A.buffer);
    let exact = true;
    for (const [loser, into] of [[D0, D2], [D1, D2], [W2, WORK]]) {
        const e = bin.entries[loser];
        const good = e && entryKind(e) === 'F' && e.mergedInto === into
            && e.deletion?.cause === 'brain-arrange' && e.deletion?.source === 'klypix-mcp'
            && (await bin.body(loser)) === (await itemJson(preA, loser));
        if (!good) { exact = false; console.log(`    ${loser}: ${JSON.stringify(e)}`); }
    }
    ok(exact, 'E-8: each loser is in Deleted cards with its own original bytes, mergedInto its survivor, cause brain-arrange');
    const live = await liveOf(A.buffer);
    ok(!live.some((c) => [D0, D1, W2].includes(c.id)), 'E-8: and none of them is live');
    ok(live.find((c) => c.id === W2C)?.parentId === WORK, 'E-8: the collapsed container\'s card moved into the surviving one');
    const before = await liveOf(preA);
    ok(live.filter((c) => c.type === 'text').length === before.filter((c) => c.type === 'text').length - 2,
        'E-8: the text-card count drops by exactly the two duplicates');
    ok(live.some((c) => c.id === D2)
        && (await parseKlypix(A.buffer)).struct.connections.some((cn) => cn.fromId === D2 && cn.toId === N0),
    'E-8: the loser\'s edge re-points onto the survivor');
}

// ── every copy converges ─────────────────────────────────────────────────────
{
    // A stale copy from before the arrange cannot bring the duplicates back.
    let sticks = true;
    for (const [ours, theirs] of [[A.buffer, preA], [preA, A.buffer]]) {
        const m = await mergeBrains({ base: preA, ours, theirs, options: OPTS });
        if ((await countText(m.buffer, 'duplicated decision')) !== 1 || (await liveOf(m.buffer)).some((c) => c.id === W2)) sticks = false;
    }
    ok(sticks, 'E-8: a sync or git merge with a copy from before the arrange keeps one copy, both directions');

    // Mutation: the same arrange without its receipts is undone by that merge.
    const stripped = await edit(A.buffer, async (zip) => {
        zip.remove('graveyard.json');
        for (const id of [D0, D1, W2]) zip.remove(binPath(id));
    });
    const back = await mergeBrains({ base: preA, ours: stripped, theirs: preA, options: OPTS });
    ok((await countText(back.buffer, 'duplicated decision')) > 1,
        'E-8 mutation: without the receipts, that same merge carries the duplicates back');

    // Two machines that arranged with different edges and orders converge on
    // one live copy, no twins, both machines' edges kept.
    const both = await mergeBrains({ base: common, ours: A.buffer, theirs: B.buffer, options: OPTS });
    const live = await liveOf(both.buffer);
    const conns = (await parseKlypix(both.buffer)).struct.connections;
    ok((await countText(both.buffer, 'duplicated decision')) === 1 && live.some((c) => c.id === D2)
        && !live.some((c) => /__agconf_/.test(c.id)),
    'E-8: two machines arranging with different edges converge on one live copy, no twins');
    ok(conns.some((cn) => cn.fromId === D2 && cn.toId === N0) && conns.some((cn) => cn.fromId === D2 && cn.toId === OTHER),
        'E-8: and both machines\' edges end up on the survivor');
}

// ── survivor scoring ─────────────────────────────────────────────────────────
{
    // A revived id beats the id it revived, even when that old id is older:
    // the old id is deleted on some copy, so keeping it would bury the revival.
    const R = `${D2}__r_0123456789ab`;
    const fx = await cloneAs(common, D2, R, { createdAt: 9000 });
    const r = await arrangeBrain(fx);
    const g = r.stats.collapsedCards.find((x) => x.kept === R || x.removed.includes(R));
    ok(g?.kept === R && g.removed.includes(D2), `E-8: a revived id survives over the id it revived (kept ${g?.kept})`);

    // Same age: the smallest id, in any file order.
    let tie = common;
    for (const id of [D0, D1, D2]) tie = await setField(tie, id, { createdAt: 7777 });
    const t1 = await arrangeBrain(tie);
    const t2 = await arrangeBrain(await reorder(tie, (o) => [...o].reverse()));
    ok(groupOf(t1)?.kept === D1 && groupOf(t2)?.kept === D1, 'E-8: copies of the same age keep the smallest id, whatever the file order');

    // Containers: the oldest survives even when it holds the fewest cards.
    const older = await setField(common, W2, { createdAt: 500 });
    const rc = await arrangeBrain(older);
    ok(rc.stats.mergedContainers[0]?.kept === W2 && (await liveOf(rc.buffer)).find((c) => c.id === N0)?.parentId === W2,
        'E-8: the oldest duplicate container survives even holding fewer cards, and the others move into it');
}

// ── the bin it finds ─────────────────────────────────────────────────────────
{
    // Entries already in the bin are untouched.
    const withBin = (await mergeBrains({ base: preA, ours: preA, theirs: preA, deletedIds: [N0] })).buffer;
    const was = await binOf(withBin);
    const r = await arrangeBrain(withBin);
    const now = await binOf(r.buffer);
    ok(JSON.stringify(now.entries[N0]) === JSON.stringify(was.entries[N0]) && (await now.body(N0)) === (await was.body(N0)),
        'E-8: an entry already in Deleted cards is left exactly as it was');

    // A loser whose id already carries a purge receipt keeps the receipt: the
    // purge named its fate, and its bytes must not come back into the bin.
    const purged = await edit(preA, async (zip) => {
        const entry = contentFreeReceiptFor(D1, { meta: { deletedAt: 1 }, json: '{}' }, { kind: 'purged', now: 2 });
        zip.file('graveyard.json', JSON.stringify({ version: 1, entries: { [D1]: entry } }));
        zip.file(binPath(D1), PURGED_BODY);
    });
    const rp = await arrangeBrain(purged);
    const bp = await binOf(rp.buffer);
    ok(entryKind(bp.entries[D1]) === 'P' && (await bp.body(D1)) === PURGED_BODY && !(await liveOf(rp.buffer)).some((c) => c.id === D1),
        'E-8: a loser that already has a purge receipt keeps it, bytes stay out');

    // A caller names itself in the receipt.
    const cli = await arrangeBrain(preA, { deletion: { initiator: 'unknown', cause: 'brain-arrange', source: 'klypix-brain-cli', confidence: 'explicit' } });
    ok((await binOf(cli.buffer)).entries[D1]?.deletion?.source === 'klypix-brain-cli', 'E-8: the caller\'s receipt source is recorded');

    // An unreadable bin index stops the arrange instead of being overwritten.
    const corrupt = await edit(preA, async (zip) => { zip.file('graveyard.json', 'not json at all'); });
    let threw = '';
    try { await arrangeBrain(corrupt); } catch (err) { threw = String(err?.message || err); }
    ok(/unreadable/.test(threw), 'E-8: an unreadable Deleted cards index aborts the arrange rather than overwrite it');
}

ok(MERGE_ENGINE_FEATURES.arrangeReceipts === true, 'E-8: the engine advertises arrange receipts');

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] arrange-receipts: all assertions passed');
process.exit(failures ? 1 : 0);
