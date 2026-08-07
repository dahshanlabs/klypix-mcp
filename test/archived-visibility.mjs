// archived-visibility — an archived card must never read as current fact.
//
// "Archived" is containment: the card's parent container is titled "Archive".
// ~32 read paths honour that. Three did not, and they are high-traffic:
//   • structToMarkdown (= read_canvas) rendered archived cards IDENTICALLY to
//     live ones and never printed `area` at all — so a superseded, consolidated
//     or retired decision was byte-for-byte indistinguishable from the current
//     one, on the surface an agent reads to learn a project.
//   • opSearchCanvases printed matches with no archived marker.
//   • struct.counts.cards counts containers AND archived, and several headers
//     print it raw — KLYPIX's own brain announced "2013 cards" for 1605 live.
// Matching stays recall-first on purpose (an archived card can be the right
// answer to "what did we try?"); the fix is LABELLING, not hiding.
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { parseKlypix, structToMarkdown } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const LIVE = 'the current decision: ship the emerald accent';
const DEAD = 'the abandoned decision: ship the purple accent';

// Fixture: two areas, one of them literally titled "Archive".
const buf = await buildKlypixMap({
  title: 'archived visibility fixture',
  kind: 'brain',
  areas: [
    { title: 'Design', cards: [{ text: LIVE }] },
    { title: 'Archive', cards: [{ text: DEAD }] },
  ],
});

const { struct } = await parseKlypix(buf);
const live = struct.cards.find(c => String(c.text || '').includes(LIVE));
const dead = struct.cards.find(c => String(c.text || '').includes(DEAD));
ok(Boolean(live) && Boolean(dead), 'fixture: both cards parse');
ok(dead.area === 'Archive' && live.area === 'Design', 'fixture: one card really is in Archive');

// ── counts tell the truth ────────────────────────────────────────────────────
const n = struct.counts;
ok(n.archived === 1, `counts.archived reports the archived card (got ${n.archived})`);
ok(n.containers === 2, `counts.containers reports the two area containers (got ${n.containers})`);
ok(n.live === n.cards - n.containers - n.archived,
  `counts.live is cards minus containers minus archived (${n.live} = ${n.cards} - ${n.containers} - ${n.archived})`);
ok(n.cards === struct.cards.length,
  'counts.cards keeps its old meaning — every item in order — so existing readers do not shift');

// ── read_canvas labels it ────────────────────────────────────────────────────
const md = structToMarkdown(struct);
ok(md.includes(DEAD), 'read_canvas still SHOWS the archived card (history is part of a canvas dump)');
// A card's own heading is the `###` line that carries its title text.
const headingFor = (needle) => md.split('\n').find(l => l.startsWith('###') && l.includes(needle.slice(0, 40)));
const deadHeading = headingFor(DEAD);
const liveHeading = headingFor(LIVE);
ok(Boolean(deadHeading) && deadHeading.includes('⛔ archived'),
  `the archived card's heading carries the ⛔ archived marker (got: ${deadHeading})`);
ok(Boolean(liveHeading) && !liveHeading.includes('⛔'),
  `the live card is NOT marked (got: ${liveHeading})`);
ok(Boolean(liveHeading) && liveHeading.includes('[Design]'),
  'and a live card now shows its area, which read_canvas never printed before');
ok(/\d+ live cards/.test(md.split('\n')[1]) && md.split('\n')[1].includes('1 archived'),
  `the header reports live and archived separately (got: ${md.split('\n')[1]})`);
ok(md.includes('Read them as history, not as the current state'),
  'a reader is told, once and plainly, how to treat the marked cards');

// A canvas with NO archive keeps a clean header and gains no noise.
{
  const plain = await buildKlypixMap({ title: 'plain', areas: [{ title: 'Work', cards: [{ text: 'only live things here' }] }] });
  const { struct: ps } = await parseKlypix(plain);
  const pmd = structToMarkdown(ps);
  ok(ps.counts.archived === 0 && !pmd.includes('⛔'), 'a canvas with nothing archived gains no marker and no warning');
  ok(!pmd.split('\n')[1].includes('archived'), 'and its header does not mention archiving at all');
}

// ── search_canvases labels it ────────────────────────────────────────────────
{
  const vault = path.join(os.tmpdir(), 'klypix-archived-visibility-vault');
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain.klypix'), buf);
  const { opSearchCanvases } = await import('../src/klypix-core.mjs');
  const res = await opSearchCanvases({ vault, query: 'accent' });
  const text = res?.blocks?.[0]?.text || res?.content?.[0]?.text || JSON.stringify(res);
  ok(text.includes(DEAD.slice(0, 30)) && text.includes(LIVE.slice(0, 30)),
    'search still matches BOTH cards — recall-first is unchanged');
  // A hit's own line is the bullet carrying its title.
  const bulletFor = (needle) => text.split('\n').find(l => l.startsWith('- [') && l.includes(needle.slice(0, 40)));
  const deadLine = bulletFor(DEAD);
  const liveLine = bulletFor(LIVE);
  ok(Boolean(deadLine) && deadLine.includes('⛔ archived'),
    `the archived hit is labelled in search results (got: ${deadLine})`);
  ok(Boolean(liveLine) && !liveLine.includes('⛔'), `the live hit is not labelled (got: ${liveLine})`);
  ok(/\d+ live cards/.test(text), `the search header reports live cards (got a header without it? ${!/\d+ live cards/.test(text)})`);
  fs.rmSync(vault, { recursive: true, force: true });
}

// ── the ~32 paths that already excluded archive still do ─────────────────────
{
  const { structToBrief, scoreCardsAgainstQuery } = await import('../src/klypix-format.mjs');
  const brief = structToBrief(struct);
  ok(!brief.includes(DEAD), 'the brief still excludes archived cards entirely');
  const hits = scoreCardsAgainstQuery(struct, ['accent'], { topK: 5, minScore: 1 });
  ok(!hits.some(h => String(h.card.text || '').includes(DEAD)),
    'per-prompt recall still refuses to inject an archived card');
}

process.exit(failures ? 1 : 0);
