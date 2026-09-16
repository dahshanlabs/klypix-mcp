// The `closes:` title fast-path can no longer archive the wrong card.
//
// Card titles are the first line of PROSE, so a great many of them are the bare
// area stub ("Canvas UX:"). The old comparison ran `wantTitle.startsWith(ct)`
// on unnormalized strings, which matched every one of those stubs; simulated
// against the real brain on 2026-09-15 the target
// "Brain: The 🏁-doesn't-close-❓ gap" produced 21 live matches. Past 4 matches
// the code took `matches.slice(0, 1)` — `matches[0]` in ITERATION ORDER —
// stamped it cov 1.00 and archived it with no warning. That is silent loss.
//
//   C1  both sides normalize the same way: [[brackets]], the `Area:` prefix and
//       a leading lifecycle glyph are stripped before anything is compared.
//   C2  a bare area stub can never match by prefix (the ≥10 floor), so a full
//       title closes exactly its own card.
//   C3  THE HEADLINE: a target that still matches too many cards archives
//       NOTHING and returns a receipt naming the top candidates.
//   C4  ties break on coverage then on the longer overlap — never on iteration
//       order, and the choice is stable across runs.
//   C5  the guards that already existed are intact: a 🛠 skill still retires
//       only by being NAMED, and an exact short title still closes.
import {
  buildKlypixMap, parseKlypix, captureIntoBrain, closeTargetKey, formatCaptureReceipts,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const archived = (struct) => struct.cards.filter(c => c.type !== 'container' && /^archive$/i.test(c.area || ''));

// ── C1 — one normalizer, both sides ─────────────────────────────────────────
ok(closeTargetKey('[[Canvas UX: the arrow tool]]') === 'canvas ux: the arrow tool'.replace('canvas ux: ', ''),
  `C1 the wikilink brackets and the Area: prefix are stripped [${closeTargetKey('[[Canvas UX: the arrow tool]]')}]`);
ok(closeTargetKey('Brain: 🏁 the staged-update swap') === 'the staged-update swap', 'C1 a leading lifecycle glyph is stripped');
ok(closeTargetKey('Canvas UX:') === '', 'C1 a BARE area stub normalizes to nothing at all');
ok(closeTargetKey('  The   arrow tool  ') === 'the arrow tool', 'C1 whitespace is collapsed and case folded');

// ── the fixture: three bare stubs, one full title, one skill ────────────────
const seed = () => buildKlypixMap({
  title: 'brain',
  areas: [
    {
      title: 'Canvas UX',
      cards: [
        { text: 'Canvas UX: the capsule header auto-fit is the thing to watch at low zoom' },
        { text: 'Canvas UX: lasso hit testing still misses rotated groups' },
        { text: 'Canvas UX: the lens overlay mounts a decoration div per card' },
      ],
    },
    {
      title: 'Brain',
      cards: [
        { text: 'Brain: The 🏁-doesn\'t-close-❓ gap in the resolve candidate loop needs a prefix test' },
        { text: 'Brain: 🛠️ never fuzzy-retire a standing rule — name it in closes: or leave it alone' },
      ],
    },
  ],
});

// ── C2 — a full title closes exactly its own card ───────────────────────────
{
  const buf = await seed();
  const { struct: s0 } = await parseKlypix(buf);
  const wanted = s0.cards.find(c => /doesn/.test(flat(c.text)));
  const { stats, buffer } = await captureIntoBrain(buf, {
    cards: [{ text: 'Brain: 🏁 the resolve loop now tests the lifecycle PREFIX\n#brain', area: 'Brain', closes: 'The 🏁-doesn\'t-close-❓ gap in the resolve candidate loop needs a prefix test' }],
  });
  const { struct } = await parseKlypix(buffer);
  ok(stats.closed === 1, `C2 a full title closes exactly one card (closed=${stats.closed})`);
  ok(archived(struct).length === 1 && archived(struct)[0].id === wanted.id, 'C2 and it is the RIGHT card');
  ok(!(stats.closeRefused || []).length, 'C2 no refusal — a precise target is honoured');
  ok(struct.connections.some(cn => cn.fromId === wanted.id && cn.label === 'closed by'), 'C2 the closed-by arrow is drawn');
}

// ── C3 — the bare-stub reproduction ─────────────────────────────────────────
// The exact field shape: several cards whose TITLE is the bare area stub
// ("Brain:", because the card's first line is the area prefix alone), plus one
// card with a real title. `wantTitle.startsWith(ct)` matched every stub, and
// past four matches the old code archived matches[0] in iteration order.
{
  const buf = await buildKlypixMap({
    title: 'brain',
    areas: [{
      title: 'Brain',
      cards: [
        ...Array.from({ length: 5 }, (_, i) => ({ text: `Brain:\nan ordinary decision number ${i} that happens to start with the area prefix on its own line` })),
        { text: 'Brain: the resolve candidate loop needs a lifecycle prefix test\nbecause a quoted glyph is not a declaration' },
      ],
    }],
  });
  const { struct: s0 } = await parseKlypix(buf);
  const stubs = s0.cards.filter(c => (c.title || '').trim() === 'Brain:');
  const real = s0.cards.find(c => /resolve candidate loop/.test(flat(c.text)));
  const liveBefore = s0.cards.filter(c => c.type !== 'container').length;
  ok(stubs.length === 5, `C3 the fixture really has 5 bare "Brain:" stub titles (${stubs.length})`);

  const many = await captureIntoBrain(buf, {
    cards: [{ text: 'Brain: 🏁 the prefix test shipped\n#brain', area: 'Brain', closes: 'Brain: the resolve candidate loop needs a lifecycle prefix test' }],
  });
  const { struct } = await parseKlypix(many.buffer);
  const gone = archived(struct);
  ok(gone.length === 1, `C3 THE HEADLINE: exactly one card is archived, not an arbitrary one of six (${gone.length})`);
  ok(gone.length === 1 && gone[0].id === real.id, 'C3 and it is the card the target actually names');
  ok(!stubs.some(s => /^archive$/i.test((struct.cards.find(c => c.id === s.id) || {}).area || '')), 'C3 not one bare stub was swept');
  ok(struct.cards.filter(c => c.type !== 'container').length === liveBefore + 1, 'C3 the note itself is still captured as an ordinary card');
}
{
  // The same shape with enough matches to trip the >4 refusal, and the receipt
  // that has to come with it.
  const buf = await buildKlypixMap({
    title: 'brain',
    areas: [{
      title: 'Sandbox',
      cards: Array.from({ length: 6 }, (_, i) => ({ text: `sandbox runner concern ${i} — quota and approval dialog behaviour for case ${i}` })),
    }],
  });
  const { stats, buffer } = await captureIntoBrain(buf, {
    cards: [{ text: 'Sandbox: 🏁 hardening pass\n#sandbox', area: 'Sandbox', closes: 'sandbox' }],
  });
  const { struct } = await parseKlypix(buffer);
  ok(!archived(struct).length, 'C3 six matches on a 7-char target archive nothing');
  ok((stats.closeRefused || []).length === 1, 'C3 the refusal is recorded');
  const ref = (stats.closeRefused || [])[0] || { total: 0, candidates: [] };
  ok(ref.total === 6 && ref.candidates.length === 5, `C3 the receipt reports the real count and the top 5 (${ref.total}/${ref.candidates.length})`);
  ok(ref.candidates.length > 0 && ref.candidates.every(c => c.id && typeof c.cov === 'number'), 'C3 every candidate carries an id and its coverage');
  const printed = formatCaptureReceipts(stats).join('\n');
  ok(/NOTHING was archived/.test(printed) && /Name a longer target/.test(printed), 'C3 the refusal reaches the printed receipt with the remedy');
  ok(ref.candidates.length > 0 && ref.candidates.every(c => printed.includes(c.id)), 'C3 the printed receipt names the candidate ids so one can be closed by id');
}

// ── C4 — deterministic ordering, never iteration order ──────────────────────
{
  // Two cards the target covers, one of them much more specifically. Running
  // the same capture twice must pick the same card both times.
  const mk = () => buildKlypixMap({
    title: 'brain',
    areas: [{
      title: 'Drive',
      cards: [
        { text: 'Drive: the quota banner in the header shows the remaining allowance' },
        { text: 'Drive: the quota banner in the header shows the remaining allowance and its reset date' },
      ],
    }],
  });
  const run = async () => {
    const { stats, buffer } = await captureIntoBrain(await mk(), {
      cards: [{ text: 'Drive: 🏁 quota banner shipped\n#drive', area: 'Drive', closes: 'the quota banner in the header shows the remaining allowance' }],
    });
    const { struct } = await parseKlypix(buffer);
    return { closed: stats.closed || 0, picked: archived(struct).map(c => flat(c.text)).sort() };
  };
  const a = await run();
  const b = await run();
  ok(a.closed >= 1, `C4 a specific target still closes (closed=${a.closed})`);
  ok(JSON.stringify(a.picked) === JSON.stringify(b.picked), 'C4 two identical runs archive the same card(s) — the choice is not iteration order');
}

// ── C5 — the pre-existing guards are intact ─────────────────────────────────
{
  const buf = await seed();
  // A MID-SENTENCE span of the skill's title: not the title, not a prefix of
  // it. The skill branch refuses the contains path and never reaches token
  // coverage at all (review-B's trap: a rule must be NAMED, not brushed past).
  const { stats, buffer } = await captureIntoBrain(buf, {
    cards: [{ text: 'Brain: 🏁 fuzzy retirement removed\n#brain', area: 'Brain', closes: 'name it in closes: or leave it alone' }],
  });
  const { struct } = await parseKlypix(buffer);
  const skill = struct.cards.find(c => /🛠/.test(String(c.text || '')));
  ok(!/^archive$/i.test(skill.area || ''), `C5 a 🛠 skill is not swept by a mid-sentence span of its title (closed=${stats.closed || 0})`);

  const named = await captureIntoBrain(buf, {
    cards: [{ text: 'Brain: 🏁 fuzzy retirement removed\n#brain', area: 'Brain', closes: 'never fuzzy-retire a standing rule — name it in closes: or leave it alone' }],
  });
  const { struct: sn } = await parseKlypix(named.buffer);
  const namedSkill = sn.cards.find(c => /🛠/.test(String(c.text || '')));
  ok(/^archive$/i.test(namedSkill.area || ''), 'C5 …but NAMING it exactly still retires it — the documented escape hatch survives');
}

console.log(failures ? `\n${failures} failure(s)` : '\n✓ close-link-safety: all assertions passed');
process.exit(failures ? 1 : 0);
