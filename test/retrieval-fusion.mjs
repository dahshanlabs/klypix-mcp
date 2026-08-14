// Retrieval-fusion regression pins — the 1.70 "measured wave" (2026-08-14).
//
// Every assertion here pins a fusion behavior that was MEASURED as load-bearing
// on the frozen v2 question set (n=113 answerable) against the real 2,542-card
// brain: baseline MRR 0.456 · top-1 36% · recall@5 62% · recall@10 67%.
// Five candidate "improvements" were swept offline against cached production
// cosines and ALL measured at or below noise (±1 question), several actively
// regressing MRR/top-1 — so the behaviors below are kept ON PURPOSE, and any
// change to them must re-run the harness (scripts/brain-eval.mjs in the KLYPIX
// repo, frozen v2 set, --no-llm) before it ships:
//   · a title/tag lexical leg for non-anchor queries: recall@5 +1pp at best,
//     MRR 0.456→0.395 and top-1 36%→25% at useful weights — lexical evidence
//     sits on DISTRACTORS, not golds (1/43 failures had ≥2 precise gold hits);
//   · status-question recency prior: flat (63% stratum unchanged);
//   · stronger archived demotion (−0.2…−1.0): loses a multihop question —
//     archived cards can be gold;
//   · MMR near-dupe deferral in top-k: flat (2/7 near-misses had dupes);
//   · area-consensus prior (majority area of semantic top-10): flat to
//     negative (MRR −0.023 at weight 0.1).
// Graph expansion ceilings, also measured: gold connected to a top-10 hit in
// 2/43 failures; via wikilinks 0/43 (38 of 2,542 cards carry links).
// Conclusion on record: the fusion layer is saturated given the bi-encoder's
// rank order; CI-clearing recall gains must come from the embedding side, not
// from reweighting this function.
//
// Run:  node test/retrieval-fusion.mjs        (exit 0 = pass, 1 = fail)
import { rankForQuestion } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const card = (id, text, extra = {}) => ({ id, type: 'text', title: extra.title ?? id, text, tags: [], area: extra.area ?? 'Notes', createdAt: extra.createdAt ?? 1, ...extra });

// ── 1. No-anchor NL query: the lexical leg does NOT participate ──────────────
// The single most tempting "improvement" and the single most measured-harmful
// one. Fusion must follow the semantic order strictly; a card whose title
// contains EVERY query token must not displace a semantically better card,
// and the fused scores must be the bare RRF terms (no lexical addend, no
// hidden priors — the constants 100 and 61 are pinned numerically).
{
    const struct = {
        cards: [
            card('semtop', 'Relay: queued envelopes flush when the link returns.'),
            card('lexy', 'Notes: offline delivery resume disconnect notes.', { title: 'offline delivery resume disconnect' }),
        ],
        connections: [],
    };
    const r = rankForQuestion(struct, 'How does offline delivery resume once a disconnect ends?', {
        semantic: new Map([['semtop', 0.9], ['lexy', 0.85]]),
        k: 5,
    });
    ok(r.hits[0]?.card.id === 'semtop', 'no-anchor: semantic order wins over full-title lexical overlap');
    ok(r.hits[0]?.score === 100 / 61, 'no-anchor: top score is exactly 100/(61+0) — no lexical or prior addend');
    ok(r.hits[1]?.score === 100 / 62, 'no-anchor: runner-up score is exactly 100/(61+1) despite lex hits');
}

// ── 2. Exact-anchor query: the lexical leg DOES participate ──────────────────
// (The other half of the same contract; brain-ask pins the near-tie override,
// this pins the score arithmetic 15/(61+lexRank).)
{
    const struct = {
        cards: [
            card('near', 'Release: a deployment finished and health checks passed.'),
            card('exact', 'Release: PR #440 merged successfully into main.'),
        ],
        connections: [],
    };
    const r = rankForQuestion(struct, 'Did PR #440 merge?', {
        semantic: new Map([['near', 0.91], ['exact', 0.90]]),
        k: 2,
    });
    ok(r.hits[0]?.card.id === 'exact', 'anchor: exact identifier lets lexical rank participate');
    ok(r.hits[0]?.score === 100 / 62 + 15 / 61, 'anchor: fused score is exactly 100/(61+semRank) + 15/(61+lexRank)');
}

// ── 3. Semantic pool clamp: sem-only admission is bounded, lex admission isn't ─
// pool = max(200, min(400, k*8)); a semantic-only card at semRank >= pool is
// dropped, but ANY lexical match keeps a card regardless of its semantic rank.
{
    const cards = [];
    const semantic = new Map();
    for (let i = 0; i < 204; i++) {
        cards.push(card(`f${i}`, `Filler: zone${i} matter${i} detail.`, { title: `f${i}` }));
        semantic.set(`f${i}`, 0.9 - i * 0.001);
    }
    cards.push(card('lexcard', 'Widget: the gadget conveyor throughput fix.', { title: 'gadget conveyor' }));
    semantic.set('lexcard', 0.5);                          // semRank 204 — beyond the 200 pool
    const r = rankForQuestion({ cards, connections: [] }, 'how does the gadget conveyor operate?', { semantic, k: 1 });
    ok(r.total === 201, `pool: 200 sem-only survivors + 1 lex-admitted (total=${r.total}; 4 beyond-pool sem-only cards dropped)`);
}

// ── 4. Archived demotion is a NUDGE (−0.1 fused ≈ 4 ranks), not a burial ─────
// Stronger demotion was measured to lose gold (archived cards can be the
// answer). Pin both edges: an archived semantic-top loses an adjacent tie,
// but still outranks clearly weaker live cards.
{
    const cards = [card('arch', 'Old: the exporter used the legacy queue.', { area: 'Archive' })];
    for (let i = 1; i <= 5; i++) cards.push(card(`live${i}`, `Live: note number ${i} on unrelated matters.`));
    const semantic = new Map([['arch', 0.95]]);
    for (let i = 1; i <= 5; i++) semantic.set(`live${i}`, 0.95 - i * 0.01);
    const r = rankForQuestion({ cards, connections: [] }, 'Which queue did the exporter use historically?', { semantic, k: 6 });
    const order = r.hits.map(h => h.card.id);
    ok(order[0] === 'live1', 'archived: demotion drops an archived card below an adjacent live rank');
    ok(order.indexOf('arch') === 3, `archived: −0.1 in fused space ≈ 4 ranks exactly (position ${order.indexOf('arch')}, expected 3)`);
    ok(r.hits.find(h => h.card.id === 'arch')?.archived === true, 'archived: the hit is flagged, never hidden');
}

// ── 5. Skill boost is DEAD in the semantic path ──────────────────────────────
// The +1 🛠 boost (and recency/archived−1.5) are lexical-only-path boosts; in
// fused space they must not move rank (the eval's numbers assume this).
{
    const struct = {
        cards: [
            card('plain', 'Build: the bundler emits commonjs for electron main.'),
            card('skill', '🛠 Skill: always strip ELECTRON_RUN_AS_NODE before spawning.'),
        ],
        connections: [],
    };
    const r = rankForQuestion(struct, 'how is the electron main bundle produced?', {
        semantic: new Map([['plain', 0.9], ['skill', 0.89]]),
        k: 2,
    });
    ok(r.hits[0]?.card.id === 'plain' && r.hits[1]?.score === 100 / 62, 'semantic path: 🛠 gets no +1 — fused score is bare RRF');
}

// ── 6. Overlays never move rank order ────────────────────────────────────────
// Corrections/fulfillment attach to already-ranked hits; the eval measures rank
// only, so an overlay change must be invisible to recall@k. Pin: adding a
// correction edge attaches the overlay but leaves the hit order byte-identical.
{
    const mk = () => ({
        cards: [
            card('stale', 'Auth: sessions live in redis for fast expiry.', { createdAt: Date.parse('2026-01-01') }),
            card('fresh', 'Auth: CORRECTION — sessions moved to postgres for durability.', { createdAt: Date.parse('2026-05-01') }),
        ],
        connections: [],
    });
    const semantic = () => new Map([['stale', 0.92], ['fresh', 0.91]]);
    const before = rankForQuestion(mk(), 'where do sessions live?', { semantic: semantic(), k: 5 });
    const withEdge = mk();
    withEdge.connections.push({ fromId: 'stale', toId: 'fresh', label: 'superseded by' });
    const after = rankForQuestion(withEdge, 'where do sessions live?', { semantic: semantic(), k: 5 });
    ok(before.hits.map(h => h.card.id).join(',') === after.hits.map(h => h.card.id).join(','),
        'overlays: a correction edge changes NOTHING about hit order');
    ok(after.hits.find(h => h.card.id === 'stale')?.correction != null,
        'overlays: …while the stale hit still carries its live correction');
    ok(before.hits.every((h, i) => h.score === after.hits[i].score),
        'overlays: fused scores are untouched by overlay work');
}

// ── 7. Status-vocab quarantine holds in the semantic path ────────────────────
{
    const struct = { cards: [card('a', 'Exporter: the csv exporter ships next sprint.')], connections: [] };
    const r = rankForQuestion(struct, 'what is still remaining on the exporter?', {
        semantic: new Map([['a', 0.8]]), k: 5,
    });
    ok(!r.tokens.includes('remaining'), 'status: "remaining" is quarantined out of content tokens');
    ok(r.statusShaped === true && r.statusStrong === true, 'status: the question is recognized as status-shaped (strong)');
    ok(r.hits[0]?.card.id === 'a', 'status: retrieval still runs on the content tokens');
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ retrieval-fusion: all assertions passed');
process.exit(failures ? 1 : 0);
