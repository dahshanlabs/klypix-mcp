// DECLARED vs QUOTED lifecycle glyphs — the 2026-09-15 unresolvable-card bug.
//
// The RESOLVE guard's intent has always been "a ✓ closes opens and claims,
// never a pure milestone". Its TEST was "does 🏁 appear anywhere in the text",
// so a decision card that merely QUOTES the glyph was unresolvable by any ✓:
// on the real brain, "Brain: The 🏁-doesn't-close-❓ gap …" (txt_4ixgcxz1) had
// to be closed with an explicit `closes:` target, and every ✓ aimed at it
// silently minted a junk fallback milestone instead.
//
//   L1  declaredLifecycleGlyph: prefix position wins, a mid-sentence mention
//       declares nothing, and a headline with no glyph at all falls back to the
//       first body line that declares one (lifecycleScope's own fallback).
//   L2  THE HEADLINE: a card that QUOTES 🏁 is a ✓ candidate; a card that
//       DECLARES 🏁 is still refused.
//   L3  the refused milestone is genuinely refused — the old guard is not
//       weakened, only made precise.
//   L4  the 🛠 guard stays whole-text ON PURPOSE (narrowing it would retire
//       standing rules), and the read-side classifiers are unchanged.
//   L5  areas compare with lifecycle glyphs stripped: a ✓ written for area
//       "Canvas UX" matches cards in the area "Canvas UX ✅".
import {
  declaredLifecycleGlyph, sameAreaKey, isSkillCard, isMilestoneCard, isOpenCard,
  buildKlypixMap, buildKlypix, parseKlypix, captureIntoBrain,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ── L1 — the helper ─────────────────────────────────────────────────────────
ok(declaredLifecycleGlyph('Release: 🏁 v1.3.170 shipped') === '🏁', 'L1 a glyph after the Area: prefix is declared');
ok(declaredLifecycleGlyph('🏁 v1.3.170 shipped') === '🏁', 'L1 a bare leading glyph is declared');
ok(declaredLifecycleGlyph('Canvas: ❓ the arrow tool is missing') === '❓', 'L1 an open question declares ❓');
ok(declaredLifecycleGlyph('Brain: The 🏁-doesn\'t-close-❓ gap in the resolve loop') === null,
  'L1 THE BUG: a headline that quotes glyphs mid-sentence declares NONE');
ok(declaredLifecycleGlyph('Brain: a plain decision with no glyph at all') === null, 'L1 no glyph anywhere is null');
ok(declaredLifecycleGlyph('Release v1.3.170\n🏁 the staged-update swap shipped') === '🏁',
  'L1 a headline with NO glyph falls back to the first body line that declares one');
ok(declaredLifecycleGlyph('Brain: The 🏁 gap\n🏁 this is a body milestone line') === null,
  'L1 a quoting headline is the card\'s declaration — the body scan is the no-glyph fallback only');
ok(declaredLifecycleGlyph('') === null && declaredLifecycleGlyph(null) === null, 'L1 empty input is null, never a throw');
ok(declaredLifecycleGlyph({ text: 'Canvas: 🛠️ never white-stroke a selected item' }) === '🛠',
  'L1 it accepts a card object as well as a string');
// A DOUBLE `Area:` prefix is a live shape (brain.klypix carries 5 cards reading
// `iOS: iOS: 🏁 …`). Stripping once left `iOS: 🏁 …`, which declares nothing, so
// real milestones lost the RESOLVE guard and a ✓ could archive the very 🏁 that
// fulfilled its claim — the incident the guard exists for, in reverse.
ok(declaredLifecycleGlyph('iOS: iOS: 🏁 x') === '🏁', 'L1 a DOUBLE Area: prefix still declares its glyph');
ok(declaredLifecycleGlyph('iOS: iOS: 🏁 Phone self-chat deletion scroll fix SHIPPED to TestFlight — commit eb3d457') === '🏁',
  'L1 …on the real headline shape');
// …and the stripping stays bounded: it may not eat a prose headline.
ok(declaredLifecycleGlyph('Brain: the fix: the gap: 🏁 buried four colons deep') === null,
  'L1 the repeated strip is bounded — it cannot chew through prose to find a glyph');

// ── L4 — the read-side classifiers are deliberately untouched ───────────────
{
  const quotesSkill = { type: 'text', text: 'Brain: the 🛠 skill guard tests the whole card text, not the prefix' };
  ok(isSkillCard(quotesSkill) === true,
    'L4 isSkillCard still matches a quoted 🛠 — over-inclusion is the SAFE direction for a standing rule');
  ok(declaredLifecycleGlyph(quotesSkill) === null, 'L4 …while the write-side helper correctly says it declares nothing');
  const bodyMile = { type: 'text', text: 'Release v1.3.170\n🏁 the staged-update swap shipped' };
  ok(isMilestoneCard(bodyMile) === true, 'L4 isMilestoneCard is unchanged for a body-line milestone');
  ok(isOpenCard({ type: 'text', text: 'Canvas: ❓ still open' }) === true, 'L4 isOpenCard is unchanged');
}

// ── L2 / L3 — the RESOLVE guard, end to end ─────────────────────────────────
{
  const QUOTER = 'Brain: The 🏁-doesn\'t-close-❓ gap in the resolve candidate loop needs a prefix test';
  const MILE = 'Brain: 🏁 the resolve candidate loop prefix test shipped in the engine';
  const buf = await buildKlypix({ title: 'lifecycle', cards: [{ text: QUOTER }, { text: MILE }] });
  const { struct: s0 } = await parseKlypix(buf);
  const quoterId = s0.cards.find(c => /doesn/.test(flat(c.text))).id;
  const mileId = s0.cards.find(c => /^Brain: 🏁/.test(flat(c.text))).id;

  const res = await captureIntoBrain(buf, {
    resolutions: [{ text: 'the 🏁-doesn\'t-close-❓ gap in the resolve candidate loop needs a prefix test' }],
  });
  const { struct: s1 } = await parseKlypix(res.buffer);
  const quoter = s1.cards.find(c => c.id === quoterId);
  const mile = s1.cards.find(c => c.id === mileId);
  ok(res.stats.resolved === 1, `L2 THE HEADLINE: the quoting card IS a ✓ candidate (resolved ${res.stats.resolved})`);
  ok(/^archive$/i.test(quoter.area || ''), 'L2 and it is actually archived');
  ok(!/^archive$/i.test(mile.area || ''), 'L3 the card that DECLARES 🏁 is still refused — the guard is precise, not weakened');
  ok(!res.stats.added, 'L2 no junk fallback milestone was minted (the old failure mode)');
}
{
  // The guard still holds when the ✓ text is a near-tie with the milestone
  // itself — the review-traced case the original guard was written for.
  const MILE = 'Release: 🏁 shipped the staged-update swap with rollback on a failed rename';
  const buf = await buildKlypix({ title: 'guard', cards: [{ text: MILE }] });
  const res = await captureIntoBrain(buf, {
    resolutions: [{ text: 'shipped the staged-update swap with rollback on a failed rename' }],
  });
  const { struct } = await parseKlypix(res.buffer);
  ok(!res.stats.resolved, 'L3 a ✓ that echoes a declared milestone still resolves nothing');
  ok(!struct.cards.some(c => /^archive$/i.test(c.area || '') && c.type !== 'container'), 'L3 the milestone is not archived');
}
{
  // L3b — the same guard, on the DOUBLE-prefixed shape the engine itself writes.
  // 2026-09-16 review: `iOS: iOS: 🏁 …` lost the guard after 6623577 (one strip
  // left `iOS: 🏁 …`, which declares nothing), so a ✓ archived the very 🏁 that
  // fulfilled its claim. Five such cards are live on brain.klypix.
  const MILE = 'iOS: iOS: 🏁 Phone self-chat deletion scroll fix SHIPPED to TestFlight — commit eb3d457';
  const buf = await buildKlypix({ title: 'double-prefix', cards: [{ text: MILE }] });
  const res = await captureIntoBrain(buf, {
    resolutions: [{ text: 'phone self-chat deletion scroll fix shipped to testflight build 28' }],
  });
  const { struct } = await parseKlypix(res.buffer);
  ok(!res.stats.resolved, `L3b a DOUBLE-prefixed milestone is still refused by a ✓ (resolved ${res.stats.resolved || 0})`);
  ok(!struct.cards.some(c => /^archive$/i.test(c.area || '') && c.type !== 'container'),
    'L3b THE REGRESSION: it is not archived and not ✅-stamped');
}

// ── L5 — glyph-tolerant area comparison ─────────────────────────────────────
ok(sameAreaKey('Canvas UX', 'Canvas UX ✅') === true, 'L5 an area title decorated with ✅ is the same area');
ok(sameAreaKey('canvas ux', 'Canvas  UX') === true, 'L5 case and spacing do not split an area');
ok(sameAreaKey('Canvas UX', 'Canvas') === false, 'L5 but a genuinely different area still differs');
{
  const buf = await buildKlypixMap({
    title: 'areas',
    areas: [{ title: 'Canvas UX ✅', cards: [{ text: 'Canvas UX: ❓ the capsule header clips its auto-fit text at 30% zoom' }] }],
  });
  const { struct: s0 } = await parseKlypix(buf);
  const target = s0.cards.find(c => /capsule header clips/.test(flat(c.text)));
  ok(target.area === 'Canvas UX ✅', 'L5 the fixture really has a glyph in its area title');
  const res = await captureIntoBrain(buf, {
    resolutions: [{ area: 'Canvas UX', text: 'the capsule header clips its auto-fit text at 30% zoom' }],
  });
  const { struct } = await parseKlypix(res.buffer);
  ok(res.stats.resolved === 1, `L5 THE FIX: a ✓ written with area "Canvas UX" matches the card in "Canvas UX ✅" (resolved ${res.stats.resolved})`);
  ok(/^archive$/i.test((struct.cards.find(c => c.id === target.id) || {}).area || ''), 'L5 and the card is archived');
}

console.log(failures ? `\n${failures} failure(s)` : '\n✓ lifecycle-prefix: all assertions passed');
process.exit(failures ? 1 : 0);
