// canvas-groups — reading-order boxes for create_canvas / write-klypix (1.83.0).
//
// WHY: the BFS grid follows arrows, not reading order. The founder's 27-step App
// Review checklist (2026-09-05) rendered with step 1 at the bottom-left, Part 2's
// steps scattered and arrows crossing the whole board — unreadable for the
// person it was written for. `groups` renders each part as a titled container
// with its cards stacked IN THE ORDER GIVEN, boxes left-to-right.
//
// Contract pinned here:
//   • each group → one container item whose title is the group title
//   • member cards carry parentId = that container, and sit INSIDE its box
//   • kids stack top-to-bottom in spec order (y strictly increasing, one column)
//   • `columns` splits column-major (finish column 1, then column 2)
//   • boxes never overlap; loose cards form a band ABOVE the boxes
//   • a card's inline `group:` routes it the same way
//   • an unknown member ref throws (loud), never silently drops the step
//   • a spec WITHOUT groups is unchanged: no container, same card count
//
// Run:  node test/canvas-groups.mjs        (exit 0 = pass, 1 = fail)
import { buildKlypix, parseKlypix } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const step = (n, extra = '') => ({ id: `s${n}`, text: `${n}. Step ${n}${extra}\nDo the thing for step ${n}, then check the result before moving on.` });

const spec = {
    title: 'checklist',
    cards: [
        { id: 'goal', heading: true, text: 'Goal\nGet approved.' },
        { id: 'link', text: 'Apple page\nhttps://example.com/submission' },
        ...[1, 2, 3, 4, 5].map(n => step(n)),
        ...[6, 7, 8].map(n => step(n)),
        { id: 'inline', text: 'Inline member\nRouted by the card field.', group: 'Part 2 · Send' },
        { id: 'risk', color: '#ef4444', text: 'Never delete the demo account' },
    ],
    connections: [
        { from: 'goal', to: 's1', relationship: 'leads_to' },
        { from: 's1', to: 's2', relationship: 'leads_to' },
        { from: 's2', to: 's3', relationship: 'leads_to' },
        { from: 's8', to: 's1', relationship: 'relates_to' }, // a back-arrow BFS would have followed
        { from: 'link', to: 's6', relationship: 'relates_to' },
    ],
    groups: [
        { title: 'Part 1 · Prepare', cards: ['s1', 's2', 's3', 's4', 's5'] },
        { title: 'Part 2 · Send', cards: ['s6', 's7', 's8'], color: '#3b82f6' },
    ],
};

const buf = await buildKlypix(spec);
const { struct, isV4 } = await parseKlypix(buf);
ok(isV4 === true, 'grouped canvas is a v4 .klypix');

const containers = struct.cards.filter(c => c.type === 'container');
const byTitle = new Map(containers.map(c => [c.title, c]));
ok(containers.length === 2, `two groups → two containers (got ${containers.length})`);
ok(byTitle.has('Part 1 · Prepare') && byTitle.has('Part 2 · Send'), 'container titles are the group titles');

// Geometry from canvas.json (parse exposes pos only; read positions directly).
import JSZip from 'jszip';
const zip = await JSZip.loadAsync(buf);
const canvas = JSON.parse(await zip.file('canvas.json').async('string'));
const P = canvas.positions;
const idOf = (title) => struct.cards.find(c => c.title === title || (c.text || '').startsWith(title))?.id;
const c1 = byTitle.get('Part 1 · Prepare'), c2 = byTitle.get('Part 2 · Send');

const inside = (kid, ctn) => {
    const k = P[kid], b = P[ctn];
    return k.x >= b.x && k.y >= b.y && k.x + k.w <= b.x + b.w + 0.5 && k.y + k.h <= b.y + b.h + 0.5;
};
const part1 = ['s1', 's2', 's3', 's4', 's5'];
ok(part1.every(id => P[id].parentId === c1.id), 'Part 1 members carry parentId of their container');
ok(part1.every(id => inside(id, c1.id)), 'Part 1 members sit inside their box');
ok(part1.every((id, i) => i === 0 || P[id].y > P[part1[i - 1]].y), 'Part 1 members stack top-to-bottom in spec order (not BFS order)');
ok(part1.every(id => P[id].x === P['s1'].x), 'single-column group: every member shares one x');

const part2 = ['s6', 's7', 's8', 'inline'];
ok(part2.every(id => P[id].parentId === c2.id), 'Part 2 members incl. the inline `group:` card carry parentId');
ok(P['inline'].y > P['s8'].y, 'inline `group:` card is appended AFTER the listed members');
ok(struct.cards.find(c => c.id === 'inline')?.area === 'Part 2 · Send', 'parsed struct reports the inline card\'s area = its box title');

// Boxes do not overlap and Part 2 is to the RIGHT of Part 1 (spec order).
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
ok(!overlap(P[c1.id], P[c2.id]), 'the two boxes do not overlap');
ok(P[c2.id].x > P[c1.id].x, 'boxes run left-to-right in spec order');

// Loose cards (goal, link, risk) sit ABOVE the boxes, with no parent.
const loose = ['goal', 'link', 'risk'];
ok(loose.every(id => P[id].parentId === null), 'loose cards have no parent');
const looseBottom = Math.max(...loose.map(id => P[id].y + P[id].h));
ok(Math.min(P[c1.id].y, P[c2.id].y) >= looseBottom, 'boxes start below the loose band');

// Connections survive grouping untouched.
ok(struct.connections.length === spec.connections.length, `all ${spec.connections.length} connections kept`);

// Border color: explicit on Part 2, default emerald on Part 1.
const item = async (id) => JSON.parse(await zip.file(Object.keys(zip.files).find(k => k.endsWith(`/${id}.json`))).async('string'));
ok((await item(c2.id)).borderColor === '#3b82f6' && (await item(c1.id)).borderColor === '#10b981', 'group color → container borderColor (default emerald)');

// Column-major split preserves reading order: 7 cards, 2 columns → 4 then 3.
const specCols = {
    title: 'cols',
    cards: [1, 2, 3, 4, 5, 6, 7].map(n => step(n)),
    groups: [{ title: 'Long', cards: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], columns: 2 }],
};
const bufCols = await buildKlypix(specCols);
const canvasCols = JSON.parse(await (await JSZip.loadAsync(bufCols)).file('canvas.json').async('string'));
const Q = canvasCols.positions;
ok(Q['s1'].x === Q['s4'].x && Q['s5'].x > Q['s4'].x, 'columns:2 fills column-major — s1..s4 in column 1, s5 starts column 2');
ok(Q['s4'].y > Q['s3'].y && Q['s5'].y === Q['s1'].y, 'column 2 starts at the top again (reading order: finish a column, then the next)');

// Width option widens the cards.
const bufWide = await buildKlypix({ title: 'wide', cards: [step(1)], groups: [{ title: 'W', cards: ['s1'], width: 520 }] });
const W = JSON.parse(await (await JSZip.loadAsync(bufWide)).file('canvas.json').async('string')).positions;
ok(W['s1'].w === 520, 'group width sets the member card width');

// Unknown ref is loud.
let threw = null;
try { await buildKlypix({ title: 'bad', cards: [step(1)], groups: [{ title: 'X', cards: ['nope'] }] }); } catch (e) { threw = e.message; }
ok(/does not match any card/.test(threw || ''), `unknown group member throws a clear error (${threw ? 'threw' : 'did not throw'})`);

// No groups → unchanged shape (regression guard for every existing caller).
const plain = await buildKlypix({ title: 'plain', cards: [step(1), step(2)], connections: [{ from: 0, to: 1 }] });
const plainStruct = (await parseKlypix(plain)).struct;
ok(plainStruct.cards.length === 2 && !plainStruct.cards.some(c => c.type === 'container'), 'a spec without groups produces no container and the same card count');

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall green');
process.exit(failures ? 1 : 0);
