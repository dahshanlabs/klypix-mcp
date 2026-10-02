// revival-map — §2.7 (Stage 2, 1.89). An app showing a brain holds cards by id.
// When a write moves a card's value to another id (a restore, a Brain Sync or
// git merge that rescues an edit, a merge that routes a stale copy to where a
// restored card went) the old id leaves the file with an entry in its bin.
// revivalMap follows that entry the way the merge routes a value, so the app
// can move its card to the new id instead of showing it twice or losing it.
//
// The load-bearing negative: a pair never points at a card holding DIFFERENT
// content — a renderer that followed it would overwrite another machine's edit.
//
// Run:  node test/revival-map.mjs        (exit 0 = pass, 1 = fail)
import JSZip from 'jszip';
import { buildKlypix, parseKlypix, shard, revivedIdFor, twinIdFor } from '../src/klypix-format.mjs';
import { mergeBrains, revivalMap, brainDelta, MERGE_ENGINE_FEATURES } from '../src/merge-brains.mjs';
import { restoreFromGraveyard, purgeGraveyard } from '../src/brain-graveyard.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '[ok]' : '[x]'} ${label}`); if (!cond) failures++; };
const OPTS = { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true };
const itemPath = (id) => `items/${shard(id)}/${id}.json`;

async function edit(buf, fn) {
    const zip = await JSZip.loadAsync(buf);
    const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
    await fn(zip, canvas);
    zip.file('canvas.json', JSON.stringify(canvas));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const itemJson = async (buf, id) => (await JSZip.loadAsync(buf)).file(itemPath(id))?.async('string') ?? null;
const setText = (buf, id, content) => edit(buf, async (zip) => {
    const j = JSON.parse(await zip.file(itemPath(id)).async('string'));
    zip.file(itemPath(id), JSON.stringify({ ...j, content }));
});
const wipe = (buf, id) => edit(buf, async (zip, canvas) => {
    canvas.order = canvas.order.filter((x) => x !== id);
    delete canvas.positions[id];
    zip.remove(itemPath(id));
});
async function entryOf(buf, id) {
    const zip = await JSZip.loadAsync(buf);
    const meta = JSON.parse(await zip.file('graveyard.json').async('string')).entries[id];
    const json = await zip.file(`graveyard/${shard(id)}/${id}.json`)?.async('string');
    return { meta, json };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const K = 'txt_k', OTHER = 'txt_other';
const X0 = await buildKlypix({
    title: 'revival map', kind: 'brain',
    cards: [{ id: K, text: 'kilo — the card the app is showing' }, { id: OTHER, text: 'another card' }],
});
const vK = await itemJson(X0, K);
const X1 = (await mergeBrains({ base: X0, ours: X0, theirs: X0, deletedIds: [K] })).buffer;   // k deleted, bytes vK
const kR = revivedIdFor(K, (await entryOf(X1, K)).meta, (await entryOf(X1, K)).json);
const X2 = (await restoreFromGraveyard(X1, [K])).buffer;                                     // k restored as kR

// ── the outcomes ─────────────────────────────────────────────────────────────
{
    const r = await revivalMap(X2, new Map([[K, vK]]));
    ok(same(r, { revived: [{ id: K, as: kR }], dropped: [] }), 'a card restored from the bin is followed to its new id');
}
{
    const r = await revivalMap(X1, new Map([[K, vK]]));
    ok(same(r, { revived: [], dropped: [K] }), 'a card deleted with exactly the value the app holds is dropped');
}
{
    const P = (await purgeGraveyard(X1, { ids: [K] })).buffer;
    const r = await revivalMap(P, new Map([[K, vK]]));
    ok(same(r, { revived: [], dropped: [K] }), 'a purged card is dropped');
}
{
    // The app holds an edit the deleter never saw; a 3-way merge rescues it
    // under the id the delete revives to.
    const edited = await setText(X0, K, 'kilo — EDITED where the delete was not seen');
    const vE = await itemJson(edited, K);
    const m = (await mergeBrains({ base: X0, ours: edited, theirs: X1, options: OPTS })).buffer;
    const r = await revivalMap(m, new Map([[K, vE]]));
    ok(same(r, { revived: [{ id: K, as: kR }], dropped: [] }) && (await itemJson(m, kR)) === vE,
        'an edit rescued from a delete is followed to where the merge landed it');
}
{
    // One machine restored k (as kR); another edited k without seeing either.
    // kR still holds exactly the value that edit was made on, so the merge
    // lands the edit on kR (no conflict) — and the map points at kR.
    const editedB = await setText(X0, K, 'kilo — EDITED on the machine that never saw the delete');
    const vB = await itemJson(editedB, K);
    const m = (await mergeBrains({ base: X0, ours: X2, theirs: editedB, options: OPTS })).buffer;
    ok((await itemJson(m, kR)) === vB && same(await revivalMap(m, new Map([[K, vB]])), { revived: [{ id: K, as: kR }], dropped: [] }),
        'an edit of exactly what the restored card holds lands on it, and is followed there');
}
{
    // The restored card was edited too (other text): the merge keeps the edit
    // of k beside it as kR's deterministic twin — and the map points there.
    const editedB = await setText(X0, K, 'kilo — EDITED on the machine that never saw the delete');
    const vB = await itemJson(editedB, K);
    const restoredThenEdited = await setText(X2, kR, 'kilo — edited after the restore');
    const vR = await itemJson(restoredThenEdited, kR);
    const m = (await mergeBrains({ base: X0, ours: restoredThenEdited, theirs: editedB, options: OPTS })).buffer;
    const twin = twinIdFor(kR, vB, 0);
    const toTwin = await revivalMap(m, new Map([[K, vB]]));
    const toCard = await revivalMap(m, new Map([[K, vR]]));
    ok((await itemJson(m, twin)) === vB && same(toTwin, { revived: [{ id: K, as: twin }], dropped: [] }),
        'a value routed beside a card holding other text is followed to its twin');
    ok((await itemJson(m, kR)) === vR, 'and the restored card keeps its own edit');
    ok(same(toCard, { revived: [], dropped: [] }) || toCard.revived.every((x) => x.as === kR), 'and a value the card holds is never pointed at the twin');
}

// ── the negatives ────────────────────────────────────────────────────────────
{
    const edited = await setText(X2, kR, 'kilo — edited after the restore, somewhere else');
    const r = await revivalMap(edited, new Map([[K, vK]]));
    ok(same(r, { revived: [], dropped: [] }),
        'never a pair to a card holding different content: the app\'s stale value is not reported at all');
}
{
    ok(same(await revivalMap(X0, new Map([[K, vK]])), { revived: [], dropped: [] }), 'a card still live is not reported');
    ok(same(await revivalMap(await wipe(X0, K), new Map([[K, vK]])), { revived: [], dropped: [] }),
        'a card gone with no bin entry is not reported (nothing on record to follow)');
    ok(same(await revivalMap(X2, { [K]: vK }), { revived: [{ id: K, as: kR }], dropped: [] }), 'lastKnown may be a plain object');
}
{
    // A restore receipt pointing back at itself is a cycle, not a hang.
    const loop = await edit(X2, async (zip) => {
        const idx = JSON.parse(await zip.file('graveyard.json').async('string'));
        idx.entries[K] = { ...idx.entries[K], restoredAs: K };
        zip.file('graveyard.json', JSON.stringify(idx));
    });
    const r = await revivalMap(loop, new Map([[K, vK]]));
    ok(same(r, { revived: [], dropped: [] }), 'a receipt cycle ends without a pair');
}

// ── brainDelta ───────────────────────────────────────────────────────────────
{
    const plain = await brainDelta(X1, X2);
    ok(same(Object.keys(plain), ['added', 'updated', 'removed', 'items', 'positions', 'connections', 'manifest']),
        'brainDelta without options keeps its old shape exactly');

    // kR is unchanged between these two files, yet the app needs its item to
    // move the card there.
    const later = await setText(X2, OTHER, 'another card, edited later');
    const d = await brainDelta(X2, later, { lastKnown: new Map([[K, vK]]) });
    ok(same(d.revived, [{ id: K, as: kR }]) && same(d.dropped, []) && d.items[kR] === await itemJson(later, kR)
        && d.positions[kR] && !d.added.includes(kR) && !d.updated.includes(kR),
    'with lastKnown it adds revived and dropped, and carries each revived card\'s item and position');

    const withLive = await brainDelta(X2, later, { collectLive: true });
    const ids = (await parseKlypix(later)).struct.cards.map((c) => c.id);
    let exact = withLive.live instanceof Map && withLive.live.size === ids.length;
    for (const id of ids) if (withLive.live.get(id) !== await itemJson(later, id)) exact = false;
    ok(exact && !('revived' in withLive), 'collectLive adds every live card\'s raw JSON, and nothing else changes');
}

ok(MERGE_ENGINE_FEATURES.revivalMap === true, 'the engine advertises the revival map');

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] revival-map: all assertions passed');
process.exit(failures ? 1 : 0);
