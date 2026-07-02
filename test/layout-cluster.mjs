// Geometry regression suite for the cluster layout (1.18.0). The old shelf-grid
// rendered a 400-card brain as a single unreadable strip; these assertions pin
// the new contract:
//   • containers never overlap (with margin), children stay inside their box
//   • a 40-card area is a squarish tile, not a 1-column skyscraper
//   • the whole map's bounding box is map-shaped, not strip-shaped
//   • connected areas sit closer than unconnected ones
//   • 📌 Focus anchors the center; Archive sits on the rim
//   • the layout is deterministic (tidy twice → identical positions)
//
// Run:  node test/layout-cluster.mjs        (exit 0 = pass, 1 = fail)
import { buildKlypixMap, parseKlypix, tidyBrain, addBrainConnections } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const card = (i, extra = '') => ({ text: `Decision ${i}${extra}: we chose approach ${i} because of latency and rollout constraints measured in the field over several weeks.` });

// Fixture: one big area (40 cards), two mid areas that are heavily connected to
// each other, two unrelated small areas, Focus, and Archive.
const buf0 = await buildKlypixMap({
    title: 'brain',
    areas: [
        { title: 'Big', cards: Array.from({ length: 40 }, (_, i) => card(i, ' big')) },
        { title: 'Alpha', cards: Array.from({ length: 6 }, (_, i) => card(i, ' alpha')) },
        { title: 'Beta', cards: Array.from({ length: 6 }, (_, i) => card(i, ' beta')) },
        { title: 'Gamma', cards: Array.from({ length: 5 }, (_, i) => card(i, ' gamma')) },
        { title: 'Delta', cards: Array.from({ length: 5 }, (_, i) => card(i, ' delta')) },
        { title: '📌 Focus', cards: [{ text: 'Ship the cluster layout first.' }] },
        { title: 'Archive', cards: Array.from({ length: 8 }, (_, i) => card(i, ' old')) },
    ],
});
// Wire Alpha↔Beta tightly (5 edges); Gamma/Delta stay unlinked.
const { struct: s0 } = await parseKlypix(buf0);
const of = (area) => s0.cards.filter(c => c.type !== 'container' && c.area === area).map(c => c.id);
const [al, be] = [of('Alpha'), of('Beta')];
const { buffer: buf1 } = await addBrainConnections(buf0, Array.from({ length: 5 }, (_, i) => ({ fromId: al[i], toId: be[i] })));

const { buffer: tidied } = await tidyBrain(buf1);
const { struct, canvas } = await parseKlypix(tidied);
const pos = canvas.positions;
const ctns = struct.cards.filter(c => c.type === 'container');
const boxOf = (c) => ({ ...pos[c.id] });
const cx = (b) => b.x + b.w / 2, cy = (b) => b.y + b.h / 2;
const centerDist = (a, b) => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
const byTitle = (t) => ctns.find(c => (c.title || '').toLowerCase().includes(t));

// ── containers never overlap ──────────────────────────────────────────────────
{
    let bad = 0;
    for (let i = 0; i < ctns.length; i++) for (let j = i + 1; j < ctns.length; j++) {
        const a = boxOf(ctns[i]), b = boxOf(ctns[j]);
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad++;
    }
    ok(bad === 0, `no container overlaps (${ctns.length} containers, ${bad} collisions)`);
}
// ── children inside their container, no sibling overlaps ────────────────────
{
    let outside = 0, sibOverlap = 0;
    for (const ctn of ctns) {
        const b = boxOf(ctn);
        const kids = struct.cards.filter(c => c.parentId === ctn.id).map(c => pos[c.id]);
        for (const k of kids) if (k.x < b.x || k.y < b.y || k.x + k.w > b.x + b.w + 1 || k.y + k.h > b.y + b.h + 1) outside++;
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i], c = kids[j];
            if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) sibOverlap++;
        }
    }
    ok(outside === 0, `every card sits inside its container (${outside} escapees)`);
    ok(sibOverlap === 0, `no sibling card overlaps (${sibOverlap})`);
}
// ── the big area is a tile, not a skyscraper ─────────────────────────────────
{
    const big = boxOf(byTitle('big'));
    const ratio = big.h / big.w;
    ok(ratio <= 2.5 && ratio >= 0.3, `40-card area is squarish (h/w=${ratio.toFixed(2)}, was ~12+ as one column)`);
}
// ── the map is a map, not a strip ─────────────────────────────────────────────
{
    const xs = ctns.map(boxOf);
    const minX = Math.min(...xs.map(b => b.x)), maxX = Math.max(...xs.map(b => b.x + b.w));
    const minY = Math.min(...xs.map(b => b.y)), maxY = Math.max(...xs.map(b => b.y + b.h));
    const aspect = (maxY - minY) / (maxX - minX);
    ok(aspect > 0.2 && aspect < 5, `overall bounding box is map-shaped (h/w=${aspect.toFixed(2)})`);
}
// ── connectivity drives proximity ─────────────────────────────────────────────
{
    const a = boxOf(byTitle('alpha')), b = boxOf(byTitle('beta'));
    const pairDists = [];
    for (let i = 0; i < ctns.length; i++) for (let j = i + 1; j < ctns.length; j++) pairDists.push(centerDist(boxOf(ctns[i]), boxOf(ctns[j])));
    pairDists.sort((x, y) => x - y);
    const median = pairDists[Math.floor(pairDists.length / 2)];
    ok(centerDist(a, b) <= median, `the 5-edge Alpha↔Beta pair is closer than the median pair (${Math.round(centerDist(a, b))} ≤ ${Math.round(median)})`);
}
// ── Focus anchors the center, Archive sits on the rim ────────────────────────
{
    const boxesNoArc = ctns.filter(c => !/^archive$/i.test(c.title || '')).map(boxOf);
    const mx = boxesNoArc.reduce((s, b) => s + cx(b), 0) / boxesNoArc.length;
    const my = boxesNoArc.reduce((s, b) => s + cy(b), 0) / boxesNoArc.length;
    const dTo = (b) => Math.hypot(cx(b) - mx, cy(b) - my);
    const focus = boxOf(byTitle('focus'));
    const dists = boxesNoArc.map(dTo).sort((x, y) => x - y);
    ok(dTo(focus) <= dists[Math.floor(dists.length / 2)], `📌 Focus is central (d=${Math.round(dTo(focus))}, median=${Math.round(dists[Math.floor(dists.length / 2)])})`);
    const arc = boxOf(byTitle('archive'));
    ok(dTo(arc) >= dists[dists.length - 1], `Archive is on the rim (d=${Math.round(dTo(arc))} ≥ max non-archive ${Math.round(dists[dists.length - 1])})`);
}
// ── deterministic: tidy of a tidied brain is a fixed point ───────────────────
{
    const { buffer: again } = await tidyBrain(tidied);
    const { canvas: c2 } = await parseKlypix(again);
    const same = Object.keys(pos).every(id => {
        const a = pos[id], b = c2.positions[id];
        return b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    });
    ok(same, 'tidy is deterministic (second pass → identical positions)');
}
// ── membership steering preserved ─────────────────────────────────────────────
{
    const focusKids = struct.cards.filter(c => c.parentId === byTitle('focus').id);
    ok(focusKids.length === 1 && /cluster layout/.test(focusKids[0].text), 'Focus membership untouched by the re-flow');
}

// ── review: one new cross-area arrow must NOT reshuffle the map ──────────────
// (the full-pass degree ordering did exactly that: 45/45 containers teleported
// ~4.4k px on one wikilink — incremental anchoring is the fix)
{
    const { struct: s1 } = await parseKlypix(tidied);
    const g = s1.cards.find(c => c.type !== 'container' && c.area === 'Gamma');
    const d = s1.cards.find(c => c.type !== 'container' && c.area === 'Delta');
    const { buffer: linked } = await addBrainConnections(tidied, [{ fromId: g.id, toId: d.id }]);
    const { buffer: retidied } = await tidyBrain(linked);
    const { canvas: c2 } = await parseKlypix(retidied);
    let movedCtns = 0, maxShift = 0;
    for (const c of ctns) {
        const p0 = pos[c.id], p1 = c2.positions[c.id];
        const dd = Math.hypot(p0.x - p1.x, p0.y - p1.y);
        if (dd > 1) { movedCtns++; maxShift = Math.max(maxShift, dd); }
    }
    ok(movedCtns === 0, `review-stability: a new cross-area arrow moves ZERO containers (moved=${movedCtns}, max=${Math.round(maxShift)}px)`);
}
// ── review: a human-nested container never becomes a 300×40 husk ─────────────
{
    const buf = await buildKlypixMap({
        title: 'brain', areas: [
            { title: 'Parent', cards: [card(0, ' parent')] },
            { title: 'Nested', cards: Array.from({ length: 5 }, (_, i) => card(i, ' nested')) },
        ],
    });
    const parsed = await parseKlypix(buf);
    const pId = parsed.struct.cards.find(c => c.type === 'container' && c.title === 'Parent').id;
    const nId = parsed.struct.cards.find(c => c.type === 'container' && c.title === 'Nested').id;
    parsed.canvas.positions[nId] = { ...parsed.canvas.positions[nId], parentId: pId };   // the human nests an area
    parsed.zip.file('canvas.json', JSON.stringify(parsed.canvas));
    const nested = await parsed.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const { buffer: t } = await tidyBrain(nested);
    const { struct: s, canvas: c } = await parseKlypix(t);
    const nBox = c.positions[nId];
    ok(nBox.parentId == null, 'review-nested: hand-nested container is promoted to a first-class area');
    ok(nBox.h > 100 && nBox.w >= 300, `review-nested: no 300×40 husk (got ${Math.round(nBox.w)}×${Math.round(nBox.h)})`);
    const kids = s.cards.filter(x => x.parentId === nId).map(x => c.positions[x.id]);
    ok(kids.length === 5 && kids.every(k => k.x >= nBox.x && k.y >= nBox.y && k.x + k.w <= nBox.x + nBox.w + 1 && k.y + k.h <= nBox.y + nBox.h + 1),
        'review-nested: all 5 children sit inside their promoted container');
}
// ── review: the layout stamp survives a round-trip and gates the full pass ───
{
    const { canvas: c } = await parseKlypix(tidied);
    ok(c.settings && c.settings.brainLayout === 'cluster-v1', 'review: tidied brain carries the cluster-v1 layout stamp');
}

// ── render contract: the app must HONOR the masonry (not re-derive from a
// frozen anchor). ContainerItem re-derives a child's x/y from
// `authoredInParent` and scales children off the container's `authoredW/H`,
// EARLY-RETURNING only when authoredW is absent. So tidy must strip those
// frozen baselines from everything it lays out — else the masonry we write is
// ignored at render and containers auto-grow into skyscrapers (the 1.18.0
// field bug). This reads the raw item JSONs the app actually consumes.
{
    const { zip: z2, struct: s2, canvas: cv2 } = await parseKlypix(tidied);
    const rawById = new Map();
    for (const [pth, entry] of Object.entries(z2.files)) {
        if (entry.dir || !/^items\/.+\.json$/.test(pth)) continue;
        const id = pth.split('/').pop().replace(/\.json$/, '');
        try { rawById.set(id, JSON.parse(await entry.async('string'))); } catch { /* skip */ }
    }
    const laidCtns = s2.cards.filter(c => c.type === 'container');
    const ctnWithAnchor = laidCtns.filter(c => { const j = rawById.get(c.id) || {}; return j.authoredW != null || j.authoredH != null; });
    ok(ctnWithAnchor.length === 0, `render: no laid-out container keeps a frozen authoredW/H baseline (${ctnWithAnchor.length} leaked → would scale children off a stale size)`);
    const childWithAnchor = s2.cards.filter(c => c.type !== 'container' && c.parentId && (rawById.get(c.id) || {}).authoredInParent != null);
    ok(childWithAnchor.length === 0, `render: no in-container card keeps an authoredInParent anchor (${childWithAnchor.length} leaked → app would snap it back to its old spot)`);
    // With anchors gone, the app early-returns and renders our file positions
    // verbatim → the container's stored height IS the masonry height, so the
    // skyscraper aspect (65:1 on the field brain) cannot recur.
    const worst = Math.max(...laidCtns.map(c => { const p = cv2.positions[c.id]; return p.h / p.w; }));
    ok(worst <= 3, `render: worst container aspect is a tile, not a strip (h/w=${worst.toFixed(1)})`);
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ layout-cluster: all assertions passed');
process.exit(failures ? 1 : 0);
