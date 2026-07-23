// Claim engine (Week 2-3): extractOpenClauses / findFulfillmentCandidates /
// statusContextToMarkdown / corpseRate — including a faithful reproduction of
// the 2026-07-23 field incident (a "remaining: web tray UI + next desktop
// release" clause that outlived its shipped-portal milestone).
import { extractOpenClauses, findFulfillmentCandidates, statusContextToMarkdown, corpseRate, splitQueryTokens, rankForQuestion } from '../src/klypix-format.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}`); } };

// ── extractOpenClauses ───────────────────────────────────────────────────────
{
    const cl = extractOpenClauses('drive: 🏁🏁 Phase 1 VERIFIED. remaining for full UX: web tray UI (design session) + next desktop release to put caps-writing on prod');
    ok(cl.length === 1, 'incident clause extracted');
    ok(cl[0].items.length === 2, 'multi-item clause split on + into 2 items');
    ok(/web tray/i.test(cl[0].items[0].text), 'first item is the web tray');
    ok(/desktop release/i.test(cl[0].items[1].text), 'second item is the desktop release');
}
ok(extractOpenClauses('we shipped everything, nothing else here').length === 0, 'no cue → no clauses');
ok(extractOpenClauses('next: wire the caps handshake; ship build 7').length === 1, 'next:-cue extracts; ;-split');
{
    const cl = extractOpenClauses('Pending / next queue:\nremaining: A\npending: fix the tray badge');
    ok(cl.length >= 2, 'multiple clauses on separate lines each extract');
}

// ── findFulfillmentCandidates — the incident, end to end ─────────────────────
const mkStruct = (cards, connections = []) => ({ cards, connections, counts: { cards: cards.length, connections: connections.length }, title: 't', format: 'klypix-v4' });
const D0 = Date.parse('2026-07-16');
{
    const openCard = { id: 'c1', type: 'text', area: 'drive', createdAt: D0, text: 'drive: Phase 1 verified end-to-end. remaining for full UX: web tray UI (design session, on driveApi/inboxTray contracts) + next desktop release to put caps-writing on prod' };
    const struct = mkStruct([openCard]);
    const mile = { id: 'm1', text: 'drive: 🏁 the Drive portal — klypix.com/drive shipped: web tray UI live via Vercel on the driveApi/inboxTray contracts', createdAt: D0 + 86_400_000 };
    const cands = findFulfillmentCandidates(struct, [mile]);
    ok(cands.length === 1, 'incident: portal milestone matches the web-tray claim');
    ok(cands.length && /web tray/i.test(cands[0].item), 'incident: the COVERED item is the web tray');
    ok(cands.length && cands[0].uncovered.some(u => /desktop release/i.test(u)), 'incident: receipt lists the UNCOVERED desktop-release remainder');
    // Partial approval safety: the receipt must carry the remainder, never claim full coverage.
    ok(cands.length && cands[0].cov >= 0.6, 'incident: coverage clears the bar');
}
{
    // A milestone OLDER than the claim must not fulfil it.
    const openCard = { id: 'c1', type: 'text', area: 'x', createdAt: D0, text: 'remaining: wire the web tray UI contracts properly' };
    const older = { id: 'm1', text: '🏁 web tray UI contracts wired and shipped', createdAt: D0 - 86_400_000 };
    ok(findFulfillmentCandidates(mkStruct([openCard]), [older]).length === 0, 'older milestone cannot fulfil a newer claim');
}
{
    // Skills / archived / already-resolved cards are never claim sources.
    const skill = { id: 's1', type: 'text', area: 'x', createdAt: D0, text: '🛠️ rule: remaining: always check the web tray UI contracts' };
    const arch = { id: 'a1', type: 'text', area: 'Archive', createdAt: D0, text: 'remaining: web tray UI contracts' };
    const done = { id: 'd1', type: 'text', area: 'x', createdAt: D0, text: 'remaining: web tray UI contracts ✅ 2026-07-20: done' };
    const mile = { id: 'm1', text: '🏁 web tray UI contracts shipped live', createdAt: D0 + 1000 };
    ok(findFulfillmentCandidates(mkStruct([skill, arch, done]), [mile]).length === 0, 'skills/archived/resolved cards produce no candidates');
}
{
    // A whole ❓ card (no prose clause) is itself a claim.
    const q = { id: 'q1', type: 'text', area: 'auth', createdAt: D0, text: '❓ periodic token refresh missing in main — access token dies after an hour of uptime' };
    const mile = { id: 'm1', text: 'auth: 🏁 periodic token refresh shipped in main — access token renews before expiry, uptime no longer kills it', createdAt: D0 + 1000 };
    const cands = findFulfillmentCandidates(mkStruct([q]), [mile]);
    ok(cands.length === 1, '❓ card without prose clause matches as a whole-card claim');
}
{
    // Generic one-token items must not spray matches.
    const openCard = { id: 'c1', type: 'text', area: 'x', createdAt: D0, text: 'remaining: docs + ship' };
    const mile = { id: 'm1', text: '🏁 shipped the completely unrelated frobnicator docs overhaul', createdAt: D0 + 1000 };
    const cands = findFulfillmentCandidates(mkStruct([openCard]), [mile]);
    ok(cands.length === 0, 'sub-2-token items are skipped (no generic spray)');
}

// ── Review attack cases (2026-07-23 adversarial pass — must stay dead) ───────
ok(extractOpenClauses('style { left: 12px; top: 4px } to pin it').length === 0, 'CSS left: is not a claim (bare left cue removed)');
ok(extractOpenClauses("await client.messages.create({ model: 'claude-opus-4', max_tokens: 4096 })").length === 0, 'JS await…create({model:…}) is not a claim (immediate-colon rule)');
ok(extractOpenClauses('he left the meeting at 15:30 sharp today').length === 0, 'clock time after left is not a claim');
{
    const cl = extractOpenClauses('pending: https://github.com/dahshanlabs/klypix-app review of it');
    const toks = cl.length ? [...cl[0].items[0].tokens] : [];
    ok(!toks.includes('https') && !toks.includes('github'), 'URL boilerplate stripped from claim tokens');
}
{
    const cl = extractOpenClauses('remaining: " → "From this canvas" copy tweak');
    const toks = cl.length ? [...cl[0].items[0].tokens] : [];
    ok(!toks.includes('from') && !toks.includes('this'), 'stopwords stripped from claim tokens (dogfood noise class)');
}
{
    // The incident's TRUE card shape — a 🏁 card with a remaining: tail — must be a claim source.
    const mixed = { id: 'mx1', type: 'text', area: 'drive', createdAt: D0, text: 'drive: 🏁🏁 Phase 1 VERIFIED end-to-end. remaining for full UX: web tray UI on the driveApi contracts + next desktop release' };
    const mile = { id: 'mm1', text: 'drive: 🏁 web tray UI shipped live on the driveApi contracts via Vercel', createdAt: D0 + 1000 };
    const cands = findFulfillmentCandidates(mkStruct([mixed]), [mile]);
    ok(cands.length === 1, '🏁 card with a remaining: tail IS a claim source (incident true shape)');
    ok(cands.length && cands[0].uncovered.length === 1, 'its uncovered remainder is reported');
}
{
    // Dismissal: a not_fulfilled edge permanently suppresses the pair; an existing hint edge is not re-added.
    const o = { id: 'o9', type: 'text', area: 'x', createdAt: D0, text: 'remaining: wire the phone inbox drain routing paths' };
    const m = { id: 'm9', type: 'text', area: 'x', createdAt: D0 + 1000, text: '🏁 phone inbox drain routing paths wired and shipped' };
    ok(findFulfillmentCandidates(mkStruct([o, m], [{ fromId: 'o9', toId: 'm9', relationship: 'not_fulfilled' }]), [m]).length === 0, 'not_fulfilled dismissal suppresses the pair forever');
    ok(findFulfillmentCandidates(mkStruct([o, m], [{ fromId: 'o9', toId: 'm9', label: 'likely closed by' }]), [m]).length === 0, 'an existing hint edge is never re-suggested');
    ok(findFulfillmentCandidates(mkStruct([m]), [{ ...m }]).length === 0, 'a milestone never fulfils its own clause (self-match guard)');
}
{
    // ✓ safety: short items are flagged non-resolvable so no junk-🏁-spawning marker is suggested.
    const o = { id: 'o8', type: 'text', area: 'x', createdAt: D0, text: 'remaining: caps handshake wiring' };
    const m = { id: 'm8', type: 'text', area: 'x', createdAt: D0 + 1000, text: '🏁 caps handshake wiring landed everywhere today' };
    const cands = findFulfillmentCandidates(mkStruct([o]), [m]);
    ok(cands.length === 1 && cands[0].resolvable === false, 'a 3-token item is marked non-resolvable (below the ✓ matcher floor)');
}
ok(splitQueryTokens('what is remaining for klypix?').strong === true, 'incident query is STRONG status-shaped');
ok(splitQueryTokens('remove the TODO: refactor header logic in App.tsx').strong === false, 'work prompt with an incidental TODO is NOT strong (keeps targeted recall)');

// ── statusContextToMarkdown ──────────────────────────────────────────────────
{
    const cards = [
        { id: 'ar1', type: 'container', title: 'drive', text: null },
        { id: 'o1', type: 'text', area: 'drive', parentId: 'ar1', createdAt: Date.now() - 86_400_000, text: '❓ ghost tray still to build' },
        { id: 'm1', type: 'text', area: 'drive', parentId: 'ar1', createdAt: Date.now() - 2 * 86_400_000, text: 'drive: 🏁 portal shipped' },
    ];
    const md = statusContextToMarkdown(mkStruct(cards, [{ fromId: 'o1', toId: 'm1', label: 'likely closed by' }]));
    ok(/Computed current state/.test(md), 'status markdown renders header');
    ok(/⏳likely-fulfilled/.test(md), 'open item carries the ⏳ flag from its edge');
    ok(/Newest milestones/.test(md), 'milestone section renders');
}

// ── status shape + quarantine sanity ─────────────────────────────────────────
ok(splitQueryTokens('what is remaining for klypix?').statusShaped === true, 'incident query is status-shaped');
ok(splitQueryTokens('how does the sync status indicator work?').content.includes('status'), 'status kept as a subject token');

// ── corpseRate ───────────────────────────────────────────────────────────────
{
    const corpse = { id: 'x1', type: 'text', area: 'Archive', createdAt: D0, text: '↩︎ superseded 2026-07-16\nremaining work for the drive portal web tray contracts and vercel deploy pipeline' };
    const succ = { id: 'x2', type: 'text', area: 'drive', createdAt: D0 + 1000, text: 'drive: 🏁 drive portal web tray contracts shipped — vercel deploy pipeline live' };
    const struct = mkStruct([corpse, succ], [{ fromId: 'x1', toId: 'x2', label: 'superseded by' }]);
    const r = corpseRate(struct);
    ok(r.pairs === 1, 'corpseRate mines the supersede pair');
    ok(r.rate === 0, 'healthy ranking: successor outranks the corpse (rate 0)');
}

// ── rankForQuestion carries fulfillment overlays ─────────────────────────────
{
    const cards = [
        { id: 'o1', type: 'text', area: 'drive', createdAt: D0, text: '❓ web tray contracts still open for the drive portal work', tags: [], links: [] },
        { id: 'm1', type: 'text', area: 'drive', createdAt: D0 + 1000, text: 'drive: 🏁 web tray contracts shipped for the drive portal', tags: [], links: [] },
    ];
    const struct = mkStruct(cards, [{ fromId: 'o1', toId: 'm1', label: 'likely closed by' }]);
    const { hits } = rankForQuestion(struct, 'web tray contracts drive portal', { k: 5 });
    const openHit = hits.find(h => h.card.id === 'o1');
    ok(!!(openHit && openHit.fulfillment), 'recalled open card carries its fulfillment overlay');
}

console.log(fail ? `✗ ${fail} assertion(s) failed` : '✓ claim-engine: all assertions passed');
process.exit(fail ? 1 : 0);
