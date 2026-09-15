// Regression suite for the 2026-07-25 field incident: a "what is remaining?"
// answer reported ~12 of 20 live open items as if that were the whole list.
//
// Three independent defects stacked, each locked by assertions below:
//   T1  statusContextToMarkdown truncated to 9 of 27 opens and SILENTLY DROPPED
//       its own "…and N more" notice — the notice was emitted through the same
//       budget-guarded push it was warning about, so the moment it was needed it
//       disappeared. A one-third list rendered as a complete one, under a header
//       instructing the agent to answer from that section first.
//   T2  The area digest ran first and unbounded, spending 59% of the budget
//       before a single open card printed, so `maxOpen` never even bound.
//   T3  Lifecycle was re-derived from prose on every read, so a 🏁 milestone
//       whose BODY quoted "❓/🎯" ranked as an open question forever.
// Plus the tier-honesty invariant that generalizes all three: no surface may
// truncate a list without saying so.
//
// Run:  node test/status-completeness.mjs      (exit 0 = pass, 1 = fail)
import {
  buildKlypix, parseKlypix, statusContextToMarkdown, structToBrief, structToUltraBrief,
  isOpenCard, isSkillCard, isMilestoneCard, isUnresolvedOpenCard,
  openStatusSummary, openStatusHeader, narrowOpenStatusSummary, areaStatusDigest,
  insightsStatusToMarkdown, brainInsights, perAreaTableToMarkdown,
  serializeOpenStatusSummary, deserializeOpenStatusSummary,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// Extract exactly one section: everything under `heading` up to the next heading.
const section = (text, headingRe) => {
  const lines = String(text).split('\n');
  const i = lines.findIndex(l => headingRe.test(l));
  if (i < 0) return null;
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => /^#{1,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
};
const bulletsOf = (sec) => String(sec || '').split('\n').filter(l => /^- /.test(l));

// A brain with MANY verbose opens across MANY areas — the shape that starves
// the open tier. Long text is the point: terse cards never trigger the bug.
const LOREM = 'This card is deliberately verbose so that a character budget is spent quickly; the incident only reproduces when open cards are long enough to exhaust the tier before the list finishes rendering. ';
async function bigBrain({ opens = 24, areas = 16 } = {}) {
  const cards = [];
  for (let i = 0; i < areas; i++) {
    cards.push({ text: `Area${i}: 🏁 shipped milestone number ${i} for area ${i}. ${LOREM}`, area: `Area${i}` });
  }
  for (let i = 0; i < opens; i++) {
    cards.push({ text: `Area${i % areas}: ❓ open question number ${i} — unique-token-${i} needs a decision. ${LOREM}`, area: `Area${i % areas}` });
  }
  const buf = await buildKlypix({ title: 'regression', cards });
  const { struct } = await parseKlypix(buf);
  // buildKlypix does not thread `area` through containers in every shape; assert
  // on what actually parsed so the test can never silently measure nothing.
  return struct;
}

console.log('\n── T1/T2 · status view: complete, or honest about not being ──');
{
  const struct = await bigBrain({ opens: 24, areas: 16 });
  const opens = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim()).filter(isUnresolvedOpenCard);
  ok(opens.length >= 20, `fixture really has many opens (${opens.length})`);

  const md = statusContextToMarkdown(struct);
  const sec = section(md, /^## Open \(/);
  ok(sec != null, 'status view renders an Open section');
  const bullets = bulletsOf(sec);
  const notice = bullets.find(l => /and \d+ more open/.test(l));
  const shown = bullets.filter(l => !/and \d+ more open/.test(l)).length;

  // THE invariant. Either every open is listed, or the reader is told it isn't.
  ok(shown >= opens.length || !!notice,
    `no silent truncation: showed ${shown}/${opens.length}${notice ? ' + overflow notice' : ''}`);
  // The header count must be the TRUE total even when the body is cut.
  const hdr = /^## Open \((\d+)\)/m.exec(md);
  ok(hdr && Number(hdr[1]) === opens.length, `header states the true total (${hdr && hdr[1]} === ${opens.length})`);

  // T2: opens must not be starved by the digest. With a tight budget the digest
  // has to yield — the open list is the answer to a status question.
  const tight = statusContextToMarkdown(struct, { budgetChars: 1800 });
  const tSec = section(tight, /^## Open \(/);
  const tB = bulletsOf(tSec);
  const tNotice = tB.find(l => /and \d+ more open/.test(l));
  const tShown = tB.filter(l => !/and \d+ more open/.test(l)).length;
  ok(tShown > 0, `opens still render under a tight budget (${tShown})`);
  ok(tShown >= opens.length || !!tNotice, 'tight budget still cannot truncate silently');
}

console.log('\n── T1b · the notice survives even at an absurd budget ──');
{
  // The original bug in its purest form: shrink the budget until the content is
  // cut, and confirm the warning is NOT the thing that gets cut.
  const struct = await bigBrain({ opens: 30, areas: 20 });
  const opens = struct.cards.filter(c => c.type !== 'container').filter(isUnresolvedOpenCard);
  for (const budget of [200, 400, 800, 1200]) {
    const md = statusContextToMarkdown(struct, { budgetChars: budget });
    const sec = section(md, /^## Open \(/);
    if (sec == null) { ok(true, `budget ${budget}: no Open section rendered (acceptable)`); continue; }
    const b = bulletsOf(sec);
    const shown = b.filter(l => !/and \d+ more open/.test(l)).length;
    const notice = b.some(l => /and \d+ more open/.test(l));
    ok(shown >= opens.length || notice, `budget ${budget}: ${shown}/${opens.length} shown → ${notice ? 'notice present' : 'COMPLETE'}`);
  }
}

console.log('\n── T3 · lifecycle precedence: line 1 decides ──');
{
  const struct = (await parseKlypix(await buildKlypix({
    title: 'lifecycle', cards: [
      { text: 'Brain: 🏁 shipped the garden fix\n\nDetails: the bug was that garden was eating ❓ and 🎯 cards.' },
      { text: 'Brain: ❓ a genuinely open question about the next step' },
      { text: 'Brain: 🏁 shipped a thing\n\nIt also documents a 🛠 reusable rule for later.' },
      { text: 'Notes: a card with no glyph in line 1\nbut ❓ an open question on line 2' },
    ],
  }))).struct;
  const [mileWithGlyphInBody, realOpen, mileWithSkillInBody, markerBelowLine1] = struct.cards.filter(c => c.type !== 'container');

  ok(!isOpenCard(mileWithGlyphInBody), 'a 🏁 card quoting ❓/🎯 in its body is NOT open (the trap)');
  ok(isMilestoneCard(mileWithGlyphInBody), '…it is classified as a milestone instead');
  ok(isOpenCard(realOpen), 'a real ❓ card in line 1 is still open');
  // 🛠 is ADDITIVE and exempt from precedence — applying precedence to it
  // demoted 7 live skill cards to milestones, silently retiring 7 standing rules.
  ok(isSkillCard(mileWithSkillInBody), '🛠 anywhere still marks a skill (exempt from precedence)');
  ok(!isMilestoneCard(mileWithSkillInBody), '…and a skill is never counted as a milestone');
  // FALLBACK: line 1 with no state glyph must behave exactly as before, so a
  // brain that writes its marker under a title line is unaffected.
  ok(isOpenCard(markerBelowLine1), 'no glyph in line 1 → whole-text fallback (zero regression)');
}

console.log('\n── T4 · brief tiers never truncate silently ──');
{
  const struct = await bigBrain({ opens: 26, areas: 18 });
  const brief = structToBrief(struct);
  const all = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim());

  const openSec = section(brief, /^## Open questions & goals \(/);
  if (openSec != null) {
    const b = bulletsOf(openSec);
    const shown = b.filter(l => !/and \d+ more open/.test(l)).length;
    const notice = b.some(l => /and \d+ more open/.test(l));
    const total = all.filter(isOpenCard).length;
    ok(shown >= total || notice, `brief opens: ${shown}/${total} → ${notice ? 'honest' : 'complete'}`);
  }
  const miles = all.filter(isMilestoneCard);
  const mSec = section(brief, /^## Milestones/);
  if (mSec != null && miles.length > 8) {
    ok(/and \d+ older milestone/.test(mSec), `milestones tier declares its overflow (${miles.length} total)`);
  } else ok(true, 'milestones tier under cap (nothing to declare)');
}

console.log('\n── T5 · ONE honest open count (1.85.0) — header == flagged bullets, on every surface ──');
{
  // Fixture relative to the real clock so the >45 d bucket never drifts with
  // the calendar: one edge-hinted open, one dated-overdue open, one 60-day-old
  // open, one plain open — plus a ⤵-deferred card that ALSO carries a hint
  // edge (the exact geometry that let the header exceed the bullets) and a
  // ✅-resolved card that is not archived.
  const now = Date.now();
  const D = 86_400_000;
  const mkStruct = (cards, connections = []) => ({ cards, connections, counts: { cards: cards.length, connections: connections.length }, title: 't', format: 'klypix-v4' });
  const cards = [
    { id: 'o1', type: 'text', area: 'desktop', createdAt: now - 10 * D, text: 'desktop: ❓ the installer still needs the silent relaunch check' },
    { id: 'm1', type: 'text', area: 'desktop', createdAt: now - 2 * D, text: 'desktop: 🏁 installer silent relaunch check landed in the last cut' },
    { id: 'o2', type: 'text', area: 'iOS', createdAt: now - 10 * D, text: 'iOS: ❓ rotate the demo pairing key — due by 2020-01-01' },
    { id: 'o3', type: 'text', area: 'Website', createdAt: now - 60 * D, text: 'Website: ❓ the viewer lacks the compaction notice' },
    { id: 'o4', type: 'text', area: 'Brain', createdAt: now - 3 * D, text: 'Brain: ❓ the gardener skips orphan skills' },
    { id: 'd1', type: 'text', area: 'Brain', createdAt: now - 80 * D, text: 'Brain: ❓ ⤵ deferred until after the cut — revisit the lens palette' },
    { id: 'r1', type: 'text', area: 'Brain', createdAt: now - 80 * D, text: 'Brain: ❓ ✅ resolved — the palette question is settled' },
  ];
  const connections = [
    { fromId: 'o1', toId: 'm1', label: 'likely closed by' },
    { fromId: 'd1', toId: 'm1', label: 'likely closed by' },   // ⤵ card with a hint edge — must count NOWHERE
  ];
  const struct = mkStruct(cards, connections);
  const sum = openStatusSummary(struct, { now });
  const HEADER = '## Open (4) · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago';
  const BRIEF_HEADER = '## Open questions & goals (4 · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago)';

  ok(sum.open === 4 && sum.openIds.slice().sort().join() === 'o1,o2,o3,o4', `open = live ∧ !archived ∧ isUnresolvedOpenCard (${sum.open}: ${sum.openIds.join(',')})`);
  ok(sum.likelyDone === 1 && sum.likelyDoneById.has('o1') && !sum.likelyDoneById.has('d1'), 'likelyDone ∩ open: the ⤵-deferred card with a hint edge is NOT counted');
  ok([...sum.likelyDoneById.keys()].every(id => sum.openIds.includes(id)), 'likelyDoneById ⊆ openIds (mandatory intersection)');
  ok(sum.likelyDoneById.get('o1').via === 'edge' && sum.likelyDoneById.get('o1').byId === 'm1' && sum.likelyDoneById.get('o1').unconfirmed === true, 'an edge-sourced hint keeps its milestone id and stays unconfirmed (machine hint)');
  ok(sum.overdue === 1 && sum.overdueById.has('o2') && sum.overdueById.get('o2').date === '2020-01-01', 'overdue = findOverdueOpenCards ∩ open');
  ok(sum.untouched === 1 && sum.untouchedIds[0] === 'o3', 'created >45 d ago excludes likely-done and overdue cards');
  ok(sum.perArea.reduce((s, r) => s + r.likelyDone, 0) === sum.likelyDone && sum.perArea.reduce((s, r) => s + r.open, 0) === sum.open, 'perArea rows sum to the header numbers');
  ok(openStatusHeader(sum, 'status') === HEADER && openStatusHeader(sum, 'brief') === BRIEF_HEADER, 'one header grammar, two prefixes');
  ok(openStatusHeader({ open: 3, likelyDone: 0, overdue: 0, untouched: 0 }, 'status') === '## Open (3)', 'zero parts are omitted — a tidy brain reads "## Open (3)"');

  // status renderer: header, flags and area rows from the SAME summary
  const md = statusContextToMarkdown(struct, { now });
  ok(md.includes(HEADER), `status digest prints the honest header (${(md.match(/^## Open \(.*$/m) || ['none'])[0]})`);
  const b = bulletsOf(section(md, /^## Open \(/));
  ok(b.filter(l => /⏳likely-fulfilled/.test(l)).length === sum.likelyDone, `flagged ⏳ bullets (${b.filter(l => /⏳likely-fulfilled/.test(l)).length}) == header look-already-done (${sum.likelyDone})`);
  ok(b.filter(l => /⏳likely-fulfilled\?/.test(l)).length === 1, 'the machine hint renders hedged (⏳likely-fulfilled?)');
  ok(b.filter(l => /⏰OVERDUE/.test(l)).length === sum.overdue, 'flagged ⏰ bullets == header overdue');
  ok(!/revisit the lens palette/.test(md) && !/palette question is settled/.test(md), '⤵ / ✅ cards are neither listed nor counted');
  const areaRows = md.split('\n').filter(l => /^- .+ — .+ · \d+ open/.test(l) && / · latest /.test(l));
  const rowLookDone = areaRows.reduce((s, l) => s + (Number((/\((\d+) look done\)/.exec(l) || [])[1]) || 0), 0);
  // Website's only card is 60 d old, so the UNSCOPED digest treats that area as
  // dormant (activeDays 30) and prints 3 rows — the header still counts its
  // open (4); the By-area table below lists every area. Dormancy is a digest
  // rule, not a lifecycle one.
  ok(areaRows.length === 3 && rowLookDone === sum.likelyDone, `area-row "(K look done)" sums to the header (${rowLookDone}; ${areaRows.length} active-area rows)`);
  ok(areaStatusDigest(struct, { now, summary: sum, areas: ['Website'] }).some(l => /^- Website — no 🏁 yet · 1 open · latest /.test(l)), 'a NAMED dormant area still gets its row (scope bypasses dormancy)');
  ok(/^- desktop — .* · 1 open \(1 look done\) · latest /m.test(md), 'the desktop row reads "1 open (1 look done)"');
  ok(!/## By area/.test(md), 'statusContextToMarkdown itself never prints the By-area table (hook budget)');

  // a caller-supplied summary is honoured and narrowed — header never exceeds bullets
  const cached = statusContextToMarkdown(struct, { now, summary: sum });
  ok(cached.includes(HEADER), 'a caller-supplied summary renders the identical header');
  const narrowed = narrowOpenStatusSummary(sum, cards.filter(c => c.area === 'Brain' && isUnresolvedOpenCard(c)));
  ok(narrowed.open === 1 && narrowed.likelyDone === 0 && narrowed.overdue === 0 && narrowed.untouched === 0, 'narrowing to a scope drops every count outside it');

  // brief + ultra brief + insights: identical wording
  const brief = structToBrief(struct);
  ok(brief.includes(BRIEF_HEADER), `brief header (${(brief.match(/^## Open questions & goals .*$/m) || ['none'])[0]})`);
  ok(/## ⏳ Likely fulfilled[\s\S]*silent relaunch check[\s\S]*landed in the last cut/.test(brief) && !/⏳ Likely fulfilled[\s\S]*lens palette/.test(brief), 'brief ⏳ section lists the counted pair, never the deferred card');
  const ultra = structToUltraBrief(struct);
  ok(ultra.includes(BRIEF_HEADER), `ultra brief header (${(ultra.match(/^## Open questions & goals .*$/m) || ['none'])[0]})`);
  const ins = insightsStatusToMarkdown(areaStatusDigest(struct, { now, summary: sum }), brainInsights(struct), 't', { summary: sum });
  ok(ins.includes(HEADER), 'brain_insights status view prints the same header');
  const mileDay = new Date(now - 2 * D).toISOString().slice(0, 10);
  ok(/## By area \(4\)/.test(ins) && ins.includes(`- desktop — 1 open · 1 look done · last 🏁 ${mileDay}`), 'brain_insights status view carries the By-area table');
  ok(ins.includes('- Website — 1 open · 1 created >45 d ago') && ins.includes('- iOS — 1 open · 1 ⏰ overdue'), 'By-area rows carry the same parts as the header');
  ok(perAreaTableToMarkdown(sum, { cap: 2 }).includes('- …and 2 more area(s) — brain_ask for the whole brain'), 'By-area cap declares its overflow honestly');
  ok(perAreaTableToMarkdown(sum, { areas: ['Website'] }).includes('## By area (1)'), 'By-area table honours an area scope');

  // disk-cache codec: Maps round-trip; a wrong shape is a MISS, never a throw
  const back = deserializeOpenStatusSummary(JSON.parse(JSON.stringify(serializeOpenStatusSummary(sum))));
  ok(!!back && back.open === 4 && back.likelyDoneById.get('o1').byId === 'm1' && back.overdueById.get('o2').date === '2020-01-01', 'serialize → JSON → deserialize round-trips the maps');
  ok(deserializeOpenStatusSummary({ open: 4 }) === null && deserializeOpenStatusSummary('nope') === null && deserializeOpenStatusSummary(null) === null, 'shape mismatch deserializes to null (cache miss), never throws');
  ok(statusContextToMarkdown(struct, { now, summary: back }).includes(HEADER), 'a deserialized summary renders the identical header');
}

console.log(`\n${failures ? `✗ ${failures} FAILED` : '✓ status-completeness: all assertions passed'}`);
process.exit(failures ? 1 : 0);
