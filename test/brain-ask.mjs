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

// ── review: as_of must NOT import a FUTURE correction into a past answer ─────
{
    const struct = {
        cards: [
            { id: 'ctn', type: 'container', title: 'Auth' },
            { id: 'a', type: 'text', text: 'Auth: auth uses supabase magic-links for passwordless login.', title: 'a', tags: [], area: 'Auth', parentId: 'ctn', createdAt: Date.parse('2026-01-10') },
            { id: 'b', type: 'text', text: 'Auth: CORRECTION — dropped magic-links, moved to OAuth for auth login.', title: 'b', tags: [], area: 'Auth', parentId: 'ctn', createdAt: Date.parse('2026-05-01') },
        ],
        connections: [{ fromId: 'a', toId: 'b', label: 'superseded by' }],
    };
    const past = rankForQuestion(struct, 'how does auth login work?', { as_of: '2026-02-01', now: Date.parse('2026-07-01') });
    const aHit = past.hits.find(h => h.card.id === 'a');
    ok(!!aHit && aHit.correction == null, 'review-as_of: a then-live card carries NO future correction in a time-travel answer');
    ok(!past.hits.some(h => h.card.id === 'b'), 'review-as_of: the future correction card itself is not surfaced');
    const md = questionContextToMarkdown('how does auth work?', past, { as_of: '2026-02-01' });
    // (the header instruction always mentions "CORRECTED"; assert no per-card STALE banner)
    ok(!/this card is STALE/.test(md) && /magic-links/.test(md), 'review-as_of: the markdown answers with the then-current fact, no anachronistic correction banner');
    // sanity: WITHOUT as_of, the present correction DOES surface
    const nowR = rankForQuestion(struct, 'how does auth login work?', { now: Date.parse('2026-07-01') });
    const aNow = nowR.hits.find(h => h.card.id === 'a');
    ok(aNow && aNow.correction && /OAuth/.test(aNow.correction.by.text), 'review-as_of: present-day ask still surfaces the correction (no regression)');
}
// ── review: a card live-then-but-archived-now is not mislabeled as history ───
{
    const struct = {
        cards: [
            { id: 'ctn', type: 'container', title: 'DB' },
            { id: 'ctnA', type: 'container', title: 'Archive' },
            { id: 'old', type: 'text', text: '↩︎ superseded 2026-03-01\nDB: sessions stored in redis for fast expiry lookups.', title: 'a', tags: [], area: 'Archive', parentId: 'ctnA', createdAt: Date.parse('2025-12-01') },
        ],
        connections: [],
    };
    // At 2026-01-01 the redis card was the LIVE truth (archived only on 2026-03-01).
    const past = rankForQuestion(struct, 'where are sessions stored?', { as_of: '2026-01-01', now: Date.parse('2026-07-01') });
    const h = past.hits.find(x => x.card.id === 'old');
    ok(!!h && h.archived === false, 'review-as_of: a then-live (now-archived) card is NOT flagged archived at as_of');
    const md = questionContextToMarkdown('where are sessions?', past, { as_of: '2026-01-01' });
    ok(!/⛔ archived/.test(md), 'review-as_of: no "archived/superseded" banner on a card that was live then');
    // after its death it must NOT surface for a later as_of
    const later = rankForQuestion(struct, 'where are sessions stored?', { as_of: '2026-04-01', now: Date.parse('2026-07-01') });
    ok(!later.hits.some(x => x.card.id === 'old'), 'review-as_of: past its 2026-03-01 death, the card is excluded from a 2026-04 answer');
}
// ── review: an UNDATED archived card can't be time-travelled → excluded ──────
{
    const struct = {
        cards: [
            { id: 'ctnA', type: 'container', title: 'Archive' },
            { id: 'u', type: 'text', text: 'Payments: we used stripe for the billing integration.', title: 'u', tags: [], area: 'Archive', parentId: 'ctnA', createdAt: Date.parse('2025-11-01') },
        ],
        connections: [],
    };
    const r = rankForQuestion(struct, 'what payments provider did we use?', { as_of: '2026-02-01', now: Date.parse('2026-07-01') });
    ok(r.hits.length === 0, 'review-as_of: an archived card with no dated retirement is excluded from time-travel (can\'t prove it was live then)');
    // but present-day ask still shows it (as history)
    const nowR = rankForQuestion(struct, 'what payments provider did we use?', { now: Date.parse('2026-07-01') });
    ok(nowR.hits.some(h => h.card.id === 'u' && h.archived), 'review-as_of: present-day ask still surfaces it, flagged archived');
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
