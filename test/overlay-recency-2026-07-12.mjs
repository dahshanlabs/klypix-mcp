// Field report 2026-07-12 (KLYPIX brain audit) — stale-correction poisoning:
//   • recall/ask served a June "deploy did NOT stick" correction as the CURRENT
//     truth for July version questions (probe verdict: WRONG), and
//   • a 07-11 audit correction overlaid the 07-12 R1 cards that superseded it —
//     older facts "correcting" newer cards, steering synthesis BACKWARD.
// Guards under test:
//   G1 correctionOverlaysFor: a cue STRICTLY older than the card never overlays it
//   G2 correctionOverlaysFor: equal/unknown timestamps keep the overlay (compat)
//   G3 correctionOverlaysFor: 🛠️ skills never get a cue overlay (standing reference)
//   G4 correctionOverlaysFor: a not_contradiction edge dismisses the cue pair
//   G5 detectContradictions: cue older than counterpart → presumption inverts
//   G6 detectContradictions: 🛠️ skill is never the "likely STALE" side of a cue pair
import { buildKlypixMap, parseKlypix, correctionOverlaysFor, detectContradictions } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const STALE = 'Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 — agents run skills only in-session for now, executor postponed until real demand shows.';
const CORRECTION = 'CORRECTION (stale note resolved): off-cloud skill/brain execution is now WIRED, not deferred — the runner executes skills off-cloud since the connectivity arc.';

async function brainWith(areas) {
    return parseKlypix(await buildKlypixMap({ title: 'brain', areas }));
}
const find = (struct, re) => struct.cards.find(c => re.test(c.text || ''));

// ── G1 + G2: recency guard on the cue overlay ────────────────────────────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const card = find(struct, /deferred ON PURPOSE/);
    const cue = find(struct, /WIRED/);

    cue.createdAt = 1000; card.createdAt = 2000;   // cue is OLDER than the card
    ok(!correctionOverlaysFor(struct, [card]).has(card.id), 'G1: a cue strictly older than the card does NOT overlay it');

    cue.createdAt = 3000; card.createdAt = 2000;   // cue is NEWER — classic case
    const newer = correctionOverlaysFor(struct, [card]).get(card.id);
    ok(!!newer && newer.kind === 'cue' && /WIRED/.test(newer.by.text), 'G1: a newer cue still overlays (classic direction intact)');

    cue.createdAt = 2000; card.createdAt = 2000;   // same capture batch
    ok(correctionOverlaysFor(struct, [card]).has(card.id), 'G2: equal timestamps keep the overlay (compat)');

    delete cue.createdAt;                           // unknown stamp — can't judge
    ok(correctionOverlaysFor(struct, [card]).has(card.id), 'G2: unknown cue timestamp keeps the overlay (compat)');
}

// ── G3: skills never get a cue overlay ───────────────────────────────────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: `🛠️ ${STALE}` }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const skill = find(struct, /deferred ON PURPOSE/);
    const cue = find(struct, /WIRED/);
    cue.createdAt = 3000; skill.createdAt = 2000;   // even a NEWER cue
    ok(!correctionOverlaysFor(struct, [skill]).has(skill.id), 'G3: a 🛠️ skill card never gets a cue overlay');
    // …but an explicit superseded-by edge still swaps in the successor (deliberate beats lexical)
    struct.connections.push({ fromId: skill.id, toId: cue.id, label: 'superseded by' });
    const ov = correctionOverlaysFor(struct, [skill]).get(skill.id);
    ok(!!ov && ov.kind === 'edge', 'G3: an explicit superseded-by edge on a skill still yields an edge overlay');
}

// ── G4: not_contradiction dismissal blocks the cue overlay ───────────────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const card = find(struct, /deferred ON PURPOSE/);
    const cue = find(struct, /WIRED/);
    cue.createdAt = 3000; card.createdAt = 2000;
    ok(correctionOverlaysFor(struct, [card]).has(card.id), 'G4 precondition: overlay attaches before the dismissal');
    struct.connections.push({ fromId: card.id, toId: cue.id, relationship: 'not_contradiction', label: 'not a contradiction' });
    ok(!correctionOverlaysFor(struct, [card]).has(card.id), 'G4: a not_contradiction edge dismisses the cue overlay');
}

// ── G5: detectContradictions inverts the presumption for an older cue ────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const card = find(struct, /deferred ON PURPOSE/);
    const cue = find(struct, /WIRED/);

    cue.createdAt = 3000; card.createdAt = 2000;   // classic: cue newer
    let pairs = detectContradictions(struct);
    let hit = pairs.find(p => p.why.startsWith('correction-cue'));
    ok(!!hit && hit.fresh.id === cue.id && hit.stale.id === card.id, 'G5: newer cue is still the presumed truth (classic)');

    cue.createdAt = 1000; card.createdAt = 2000;   // inverted: cue older
    pairs = detectContradictions(struct);
    hit = pairs.find(p => p.why.startsWith('correction-cue'));
    ok(!!hit && hit.fresh.id === card.id && hit.stale.id === cue.id, 'G5: an older cue is presumed SUPERSEDED by the newer card (inverted)');
    ok(!!hit && /presumed superseded/.test(hit.why), 'G5: the inversion is named in `why`');
}

// ── G6: a 🛠️ skill is never the "likely STALE" side of a cue pair ────────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: `🛠️ ${STALE}` }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const pairs = detectContradictions(struct);
    ok(!pairs.some(p => p.why.startsWith('correction-cue')), 'G6: cue-vs-skill pair is skipped (skills are standing reference)');
}

// ── G7: the skill shield covers BOTH directions of the inversion ──────────────
// (review 2026-07-12: a 🛠️ skill whose own text carries a cue token — e.g. a
// skill documenting the CORRECTION convention — became cueC; when older than a
// matching plain card the inversion put the SKILL on the likely-STALE side.)
{
    const { struct } = await brainWith([
        { title: 'Runtime', cards: [{ text: `🛠️ ${CORRECTION}` }] },   // skill that carries the cue
        { title: 'Strategy', cards: [{ text: STALE }] },
    ]);
    const skillCue = find(struct, /WIRED/);
    const plain = find(struct, /deferred ON PURPOSE/);
    skillCue.createdAt = 1000; plain.createdAt = 2000;                  // cue older → inversion would fire
    const pairs = detectContradictions(struct);
    ok(!pairs.some(p => p.why.startsWith('correction-cue')), 'G7: an inverted pair whose cue card is a 🛠️ skill is skipped (skill never labeled STALE)');
    // …and a skill as the FRESH side of an inverted pair is fine to surface:
    // (plain cue older than a newer plain card still inverts — sanity re-check)
    skillCue.createdAt = 3000; plain.createdAt = 2000;                  // cue newer → classic, stale side = plain card
    const classic = detectContradictions(struct).find(p => p.why === 'correction-cue');
    ok(!!classic && classic.stale.id === plain.id, 'G7: classic direction with a skill-cue still surfaces the PLAIN card as stale');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
