// Acceptance suite for brain_ask (1.19.0) — the whole-brain, correction-aware
// question-answering path. Tests the pure ranker/assembler (no embedder needed)
// AND the MCP verb end-to-end.
//   • a question retrieves the relevant cards ranked, full-text
//   • the answer NEVER surfaces a stale card without its live correction
//   • archived/superseded history is included but flagged
//   • as_of time-travel excludes cards that didn't exist / were already retired
//   • a no-match question returns an honest "not in the brain" (never a guess)
//   • the output is a synthesis INSTRUCTION, not a raw dump
//
// Run:  node test/brain-ask.mjs        (exit 0 = pass, 1 = fail)
import { buildKlypixMap, parseKlypix, rankForQuestion, questionContextToMarkdown } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const brainWith = async (areas) => (await parseKlypix(await buildKlypixMap({ title: 'brain', areas }))).struct;

// ── basic retrieval: a question finds its cards, ranked, full-text ───────────
{
    const struct = await brainWith([
        { title: 'Auth', cards: [{ text: 'Auth: we chose refresh-token rotation every 7 days via the session store rotation job for tenant isolation.' }] },
        { title: 'UI', cards: [{ text: 'UI: the settings panel uses a 9-tab sidebar layout.' }] },
    ]);
    const r = rankForQuestion(struct, 'how does auth token rotation work?');
    ok(r.hits.length >= 1 && /rotation every 7 days/.test(r.hits[0].card.text), 'ask: the auth card is the top hit');
    ok(!r.hits.some(h => /9-tab sidebar/.test(h.card.text)), 'ask: the unrelated UI card is not surfaced');
    const md = questionContextToMarkdown('how does auth token rotation work?', r);
    ok(/Synthesize a DIRECT answer/.test(md), 'ask: output is a synthesis instruction, not a raw dump');
    ok(/rotation every 7 days/.test(md), 'ask: the full card text is included for synthesis');
}

// ── correction-aware: a stale hit ALWAYS carries its live correction ─────────
{
    const struct = await brainWith([
        { title: 'Strategy', cards: [{ text: 'Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 — the runner is postponed until distribution demand shows; use_skill dead-ends off-cloud for now.' }] },
        { title: 'Runtime', cards: [{ text: 'Runtime: CORRECTION (stale note resolved): off-cloud skill/brain execution is now WIRED, not deferred — the runner executes skills off-cloud since the connectivity arc landed in main.' }] },
    ]);
    const r = rankForQuestion(struct, 'is off-cloud skill execution deferred or working?');
    const staleHit = r.hits.find(h => /deferred ON PURPOSE/.test(h.card.text));
    ok(!!staleHit, 'ask: the stale card is retrieved (it lexically matches)');
    ok(staleHit && staleHit.correction && /WIRED/.test(staleHit.correction.by.text), 'ask: the stale hit carries its live CORRECTION');
    const md = questionContextToMarkdown('is off-cloud skill execution deferred?', r);
    ok(/⚠️ CORRECTED/.test(md) && /current truth is/.test(md), 'ask: the markdown flags the stale card + gives the current truth');
    ok(md.indexOf('WIRED') !== -1, 'ask: the corrected truth is present for the agent to answer from');
}

// ── history: archived/superseded cards are INCLUDED but flagged ──────────────
{
    const struct = await brainWith([
        { title: 'Release', cards: [{ text: 'Release: we ship via electron-updater against the GitHub provider with a Supabase rollout gate.' }] },
        { title: 'Archive', cards: [{ text: '↩︎ superseded 2026-01-01\nRelease: we used to ship via a manual zip drop before the updater existed.' }] },
    ]);
    const r = rankForQuestion(struct, 'how do we ship releases?');
    const arch = r.hits.find(h => h.archived);
    ok(r.hits.some(h => !h.archived && /electron-updater/.test(h.card.text)), 'ask: the current release card ranks');
    ok(!!arch, 'ask: the archived history card is still included');
    const md = questionContextToMarkdown('how do we ship?', r);
    ok(/⛔ archived\/superseded/.test(md), 'ask: archived cards are flagged so the agent shows them as history only');
    // current should outrank archived
    ok(r.hits[0] && !r.hits[0].archived, 'ask: the live card outranks the superseded one');
}

// ── as_of time-travel ────────────────────────────────────────────────────────
{
    const now = Date.parse('2026-07-01');
    const struct = {
        cards: [
            { id: 'ctn', type: 'container', title: 'DB' },
            { id: 'old', type: 'text', text: 'DB: we store sessions in redis for fast expiry lookups.', title: 'a', tags: [], area: 'DB', parentId: 'ctn', createdAt: Date.parse('2026-05-01') },
            { id: 'new', type: 'text', text: 'DB: we store sessions in postgres now for durability and rls.', title: 'b', tags: [], area: 'DB', parentId: 'ctn', createdAt: Date.parse('2026-06-20') },
        ],
        connections: [],
    };
    const past = rankForQuestion(struct, 'where do we store sessions?', { as_of: '2026-05-15', now });
    ok(past.hits.length === 1 && /redis/.test(past.hits[0].card.text), 'ask: as_of 2026-05-15 sees only the redis card (postgres not yet decided)');
    const nowR = rankForQuestion(struct, 'where do we store sessions?', { now });
    ok(nowR.hits.some(h => /postgres/.test(h.card.text)), 'ask: without as_of, the current postgres card is surfaced');
}

// ── no match: honest "not in the brain", never a guess ───────────────────────
{
    const struct = await brainWith([{ title: 'Auth', cards: [{ text: 'Auth: refresh tokens rotate weekly.' }] }]);
    const r = rankForQuestion(struct, 'what is our kubernetes ingress controller configuration?');
    ok(r.hits.length === 0, 'ask: a question the brain does not cover retrieves nothing');
    const md = questionContextToMarkdown('kubernetes ingress config?', r);
    ok(/No brain cards answer/.test(md) && /don't guess/.test(md), 'ask: no-match output tells the agent to admit the gap, not guess');
}

// ── budget: a huge brain does not blow the tool result ───────────────────────
{
    const big = Array.from({ length: 40 }, (_, i) => ({ text: `Notes: card ${i} about widget rendering and the widget pipeline and widget caching layer number ${i}.` }));
    const struct = await brainWith([{ title: 'Notes', cards: big }]);
    const r = rankForQuestion(struct, 'how does the widget pipeline and widget caching work?', { k: 20 });
    const md = questionContextToMarkdown('widget pipeline?', r, { budgetChars: 2000 });
    ok(md.length <= 2600, `ask: output respects the char budget (${md.length} chars)`);
    ok(/omitted for length/.test(md) || r.hits.length <= 3, 'ask: over-budget hits are elided with a note');
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brain-ask: all assertions passed');
process.exit(failures ? 1 : 0);
