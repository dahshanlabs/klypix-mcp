// Current-first corrections (1.98.0).
//
// Agents followed a withdrawn rule in 77% of tries unless its replacement was
// made prominent (arXiv 2608.25553). These checks lock that a superseded card
// is never served without its replacement in front of it:
//   C1 — brain_ask, both cards ranked: ONE block, current truth first, the stale
//        words after it as "history only", the current text printed once.
//   C2 — brain_ask, only the stale card ranked: the replacement text still comes
//        BEFORE the stale words.
//   C3 — status: the ⚠️CORRECTED flag carries the current card's words.
//   C4 — read_canvas: the stale card's own heading names its replacement.
//   C5 — search_canvases: a stale hit names its replacement.
// Run:  node test/current-first.mjs   (exit 0 = pass)
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addBrainConnections,
  buildKlypixMap,
  parseKlypix,
  questionContextToMarkdown,
  rankForQuestion,
  statusContextToMarkdown,
  structToMarkdown,
  supersededByNote,
} from '../src/klypix-format.mjs';
import { opSearchCanvases } from '../src/klypix-core.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const count = (hay, needle) => hay.split(needle).length - 1;

const STALE = 'Off-cloud skill execution deferred ON PURPOSE — the runner is postponed until demand shows.';
const CURRENT = 'Runtime: CORRECTION: off-cloud skill execution is now WIRED, not deferred — the runner executes skills off-cloud.';

// ── C1: both ranked → one current-first block ───────────────────────────────
{
  const struct = (await parseKlypix(await buildKlypixMap({ title: 'brain', areas: [
    { title: 'Strategy', cards: [{ text: STALE }] },
    { title: 'Runtime', cards: [{ text: CURRENT }] },
  ] }))).struct;
  const stale = struct.cards.find((c) => /deferred ON PURPOSE/.test(c.text || ''));
  const current = struct.cards.find((c) => /now WIRED/.test(c.text || ''));
  struct.connections.push({ fromId: stale.id, toId: current.id, label: 'superseded by' });
  const r = rankForQuestion(struct, 'is off-cloud skill execution deferred or wired?');
  ok(r.hits.some((h) => h.card.id === stale.id) && r.hits.some((h) => h.card.id === current.id), 'C1: precondition — both the stale and the current card rank');
  const md = questionContextToMarkdown('is off-cloud skill execution deferred?', r);
  ok(/✅ CURRENT \(supersedes an older card\)/.test(md), 'C1: the pair renders as one ✅ CURRENT block');
  ok(md.indexOf('now WIRED') !== -1 && md.indexOf('now WIRED') < md.indexOf('deferred ON PURPOSE'), 'C1: the current truth is printed BEFORE the stale words');
  ok(count(md, 'now WIRED') === 1, 'C1: the current card is printed once, not twice');
  ok(/↩︎ superseded \[Strategy\] .* \(do NOT act on it — history only\): Off-cloud skill execution deferred/.test(md), 'C1: the stale words follow, labelled history only, with their original area');
  ok(/⚠️ CORRECTED/.test(md) && /current truth is/.test(md), 'C1: the CORRECTED / "current truth is" tokens readers rely on are kept');
}

// ── C2: only the stale card in the answer → replacement still first ─────────
{
  const staleCard = { id: 's', type: 'text', text: STALE, area: 'Archive', createdAt: Date.parse('2026-06-01') };
  const currentCard = { id: 'c', type: 'text', text: CURRENT, area: 'Runtime', createdAt: Date.parse('2026-07-01') };
  const md = questionContextToMarkdown('q', { hits: [{ card: staleCard, archived: true, correction: { kind: 'edge', by: currentCard } }], total: 1 });
  ok(/⚠️ CORRECTED — this card is STALE; the current truth is:\n.*now WIRED/.test(md), 'C2: the replacement text comes right under the CORRECTED line');
  ok(md.indexOf('now WIRED') < md.indexOf('deferred ON PURPOSE') && /↩︎ stale text \(do NOT act on it — history only\)/.test(md),
    'C2: the stale words come after it, labelled history only');
}

// ── C3: status flag names the current card ──────────────────────────────────
{
  const struct = {
    cards: [
      { id: 'q', type: 'text', text: 'Auth: ❓ should login keep the cookie session?', area: 'Auth', createdAt: Date.parse('2026-09-01') },
      { id: 'd', type: 'text', text: 'Auth: login uses tokens now, the cookie session is gone.', area: 'Auth', createdAt: Date.parse('2026-10-01') },
    ],
    connections: [{ fromId: 'q', toId: 'd', label: 'superseded by' }],
  };
  const md = statusContextToMarkdown(struct, { now: Date.parse('2026-10-11') });
  ok(/⚠️CORRECTED → current: “Auth: login uses tokens now/.test(md), 'C3: the status flag carries the current card\'s words, not a bare flag');
}

// ── C4: read_canvas heading names the replacement ───────────────────────────
{
  let buf = await buildKlypixMap({ title: 'brain', kind: 'brain', areas: [
    { title: 'Auth', cards: [{ text: 'Auth: login uses tokens now.' }] },
    { title: 'Archive', cards: [{ text: '↩︎ superseded 2026-10-01\nAuth: login keeps a cookie session.' }] },
  ] });
  let { struct } = await parseKlypix(buf);
  const old = struct.cards.find((c) => /cookie session/.test(c.text || ''));
  const cur = struct.cards.find((c) => /tokens now/.test(c.text || ''));
  buf = (await addBrainConnections(buf, [{ fromId: old.id, toId: cur.id, label: 'superseded by' }])).buffer;
  ({ struct } = await parseKlypix(buf));
  const md = structToMarkdown(struct);
  ok(new RegExp(`id ${old.id}  ⛔ archived — superseded by “Auth: login uses tokens now\\.” \\(${cur.id}\\)`).test(md),
    'C4: the archived card\'s own heading names its replacement and its id');
  ok(supersededByNote(null) === '' && supersededByNote({ by: { id: 'x', text: 'a'.repeat(200) } }, 20).endsWith('…” (x)'), 'C4: the shared note is empty without an overlay and truncates long text');

  // ── C5: search_canvases names the replacement on a stale hit ─────────────
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-current-first-'));
  fs.writeFileSync(path.join(vault, 'brain.klypix'), buf);
  const res = await opSearchCanvases({ vault, query: 'cookie' });
  const text = res.blocks.map((b) => b.text || '').join('\n');
  ok(/⛔ archived/.test(text) && /↪ superseded by “Auth: login uses tokens now\.”/.test(text) && /read that card for the current state/.test(text),
    'C5: search_canvases shows a stale hit with its replacement named');
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} current-first check(s) FAILED` : '\nall current-first checks passed');
process.exit(failures ? 1 : 0);
