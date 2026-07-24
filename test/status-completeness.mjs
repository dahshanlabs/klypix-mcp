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
  buildKlypix, parseKlypix, statusContextToMarkdown, structToBrief,
  isOpenCard, isSkillCard, isMilestoneCard, isUnresolvedOpenCard,
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

console.log(`\n${failures ? `✗ ${failures} FAILED` : '✓ status-completeness: all assertions passed'}`);
process.exit(failures ? 1 : 0);
