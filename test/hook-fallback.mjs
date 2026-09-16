// rankLexicalMissFallback — the per-prompt hook's second lane as a production
// primitive (1.86). Until now the ranking lived inline in the hook, so the one
// retrieval surface every session receives could not be measured by any
// harness. These pins lock the contract the hook and scripts/eval-hook-lane.mjs
// both depend on:
//
//   HF1  parity with the pre-1.86 inline ranking: cosine × 10 + 0.5 recency
//        bump, containers / archived / empty cards excluded, top-k by score.
//   HF2  the absolute floor behaves as it always did (a card below it is out).
//   HF3  `margin` is RELATIVE to the best cosine — the rule the field data can
//        actually fit (an absolute floor never trimmed once in 165 prompts).
//   HF4  `minTop` is an admission bar: a prompt whose best cosine is below it
//        injects NOTHING (the acknowledgement class), but topCos is still
//        reported so the health log can record what the lane saw.
//   HF5  defensive: missing vectors, garbage input, empty pool → empty result,
//        never a throw (the hook is a one-shot process with no retry).
import { rankLexicalMissFallback, lexicalMissFallbackEligible, HOOK_LEXICAL_MIN_SCORE, FALLBACK_MIN_CONTENT_TOKENS, splitQueryTokens } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (condition, label) => {
    console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
    if (!condition) failures++;
};

const NOW = Date.parse('2026-09-16T12:00:00Z');
const day = 86_400_000;
const card = (id, text, extra = {}) => ({ id, type: 'text', text, area: 'Area', createdAt: NOW - 90 * day, ...extra });
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (...v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
// Query along the x axis; cosines are then simply the cards' x components.
const qv = unit(1, 0, 0);
const struct = {
    cards: [
        card('best', 'Relay: queued envelopes flush when the link returns.'),
        card('near', 'Relay: the outbox replays after reconnect.'),
        card('fresh', 'Relay: a fresh note about reconnect ordering.', { createdAt: NOW - 2 * day }),
        card('far', 'Auth: token refresh happens at app start.'),
        card('arch', 'Relay: an archived relay note.', { area: 'Archive' }),
        card('box', 'Container', { type: 'container' }),
        card('blank', '   '),
        card('novec', 'Relay: a card that was never embedded.'),
    ],
    connections: [],
};
const vecsMap = new Map([
    ['best', unit(0.80, 0.60, 0)],
    ['near', unit(0.76, 0.65, 0)],
    ['fresh', unit(0.74, 0.67, 0)],
    ['far', unit(0.40, 0.92, 0)],
    ['arch', unit(0.99, 0.14, 0)],
    ['box', unit(0.99, 0.14, 0)],
    ['blank', unit(0.99, 0.14, 0)],
]);
const sem = { qv, vecsMap, dot };
const cosOf = (id) => dot(qv, vecsMap.get(id));

// ── HF1 — parity with the inline ranking ────────────────────────────────────
{
    const r = rankLexicalMissFallback(struct, sem, { topK: 5, now: NOW });
    const ids = r.hits.map(h => h.card.id);
    ok(!ids.includes('arch') && !ids.includes('box') && !ids.includes('blank') && !ids.includes('novec'),
        'HF1: archived, container, blank and never-embedded cards are excluded');
    ok(ids[0] === 'best', 'HF1: the best cosine ranks first');
    ok(ids[1] === 'fresh' && ids[2] === 'near',
        `HF1: the +0.5 recency bump lifts a fresh card above a slightly closer stale one (${ids.join(',')})`);
    ok(Math.abs(r.hits[0].score - cosOf('best') * 10) < 1e-9, 'HF1: score is cosine × 10 for a stale card');
    ok(Math.abs(r.hits[1].score - (cosOf('fresh') * 10 + 0.5)) < 1e-9, 'HF1: score is cosine × 10 + 0.5 for a fresh card');
    ok(r.pool === 4 && Math.abs(r.topCos - cosOf('best')) < 1e-9, `HF1: pool counts rankable cards (${r.pool}) and topCos is the best cosine`);
    ok(rankLexicalMissFallback(struct, sem, { topK: 2, now: NOW }).hits.length === 2, 'HF1: topK caps the result');
}

// ── HF2 — absolute floor ────────────────────────────────────────────────────
{
    const r = rankLexicalMissFallback(struct, sem, { floor: 0.5, now: NOW });
    ok(!r.hits.some(h => h.card.id === 'far') && r.hits.length === 3, 'HF2: a card below the absolute floor is dropped');
    ok(rankLexicalMissFallback(struct, sem, { floor: 0.99, now: NOW }).hits.length === 0, 'HF2: a floor above every cosine yields no hits');
}

// ── HF3 — relative margin ───────────────────────────────────────────────────
{
    const wide = rankLexicalMissFallback(struct, sem, { margin: 0.10, now: NOW });
    const tight = rankLexicalMissFallback(struct, sem, { margin: 0.03, now: NOW });
    ok(wide.hits.length === 3 && tight.hits.length === 1 && tight.hits[0].card.id === 'best',
        `HF3: margin keeps only cards within it of the best cosine (0.10 → ${wide.hits.length}, 0.03 → ${tight.hits.length})`);
    ok(rankLexicalMissFallback(struct, sem, { margin: 0.10, floor: 0.78, now: NOW }).hits.length === 1,
        'HF3: margin and floor compose — the stricter bar wins');
}

// ── HF4 — admission bar ─────────────────────────────────────────────────────
{
    const shut = rankLexicalMissFallback(struct, sem, { minTop: 0.9, now: NOW });
    ok(shut.hits.length === 0 && Math.abs(shut.topCos - cosOf('best')) < 1e-9 && shut.pool === 4,
        'HF4: a best cosine below minTop injects nothing but still reports topCos and pool');
    ok(rankLexicalMissFallback(struct, sem, { minTop: 0.7, now: NOW }).hits.length === 4, 'HF4: a best cosine above minTop ranks normally (all four rankable cards clear the default floor)');
}

// ── HF5 — never throws ──────────────────────────────────────────────────────
{
    const empties = [
        rankLexicalMissFallback(null, sem),
        rankLexicalMissFallback(struct, null),
        rankLexicalMissFallback(struct, { qv, vecsMap: new Map(), dot }),
        rankLexicalMissFallback({ cards: [] }, sem),
        rankLexicalMissFallback(struct, { qv: null, vecsMap, dot }),
    ];
    ok(empties.every(r => Array.isArray(r.hits) && r.hits.length === 0 && r.topCos === null && r.pool === 0),
        'HF5: garbage or empty input yields the empty result, never a throw');
}

// ── HF6 — the two measured bars ─────────────────────────────────────────────
// Pinned numerically: the 2026-09-16 sweep chose them, and the harness reads
// them from the engine, so a silent change here would change what it measures.
{
    ok(HOOK_LEXICAL_MIN_SCORE === 4, 'HF6: the lexical bar is 4 — one title word alone no longer injects');
    ok(FALLBACK_MIN_CONTENT_TOKENS === 4, 'HF6: the fallback needs four content tokens');
    const content = (s) => splitQueryTokens(s).content;
    ok(!lexicalMissFallbackEligible(content('do all solutions best in class')), 'HF6: "do all solutions best in class" (3 content tokens) skips the fallback');
    ok(!lexicalMissFallbackEligible(content('continue where needed')), 'HF6: "continue where needed" skips the fallback');
    ok(!lexicalMissFallbackEligible(content('1 & 2 done , what now')), 'HF6: an acknowledgement skips the fallback');
    ok(lexicalMissFallbackEligible(content('i pressed restart and nothing appears , why')), 'HF6: a real four-token prompt is eligible');
    ok(lexicalMissFallbackEligible(content('why the message not appear .. regarding the folder features what are they to be tested ?')), 'HF6: a real question is eligible');
    ok(lexicalMissFallbackEligible(['a', 'b'], { minContentTokens: 2 }) && !lexicalMissFallbackEligible(null) && !lexicalMissFallbackEligible(['', ' ']),
        'HF6: the bar is configurable and garbage input is ineligible, never a throw');
}

if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
console.log('\n✓ hook-fallback: all assertions passed');
