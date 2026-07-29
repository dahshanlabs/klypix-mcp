// Claim engine (Week 2-3): extractOpenClauses / findFulfillmentCandidates /
// statusContextToMarkdown / corpseRate — including a faithful reproduction of
// the 2026-07-23 field incident (a "remaining: web tray UI + next desktop
// release" clause that outlived its shipped-portal milestone).
import {
    extractOpenClauses, findFulfillmentCandidates, findStaleOpenCards, statusContextToMarkdown,
    corpseRate, splitQueryTokens, rankForQuestion, stemLight, fulfillmentOverlaysFor,
    buildKlypix, parseKlypix, captureIntoBrain, addBrainConnections,
} from '../src/klypix-format.mjs';

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

// ── 2026-07-29 incident geometry: verbose diagnostic ❓ vs terse fix 🏁 ───────
// The pair every prior reproduction shares (07-23, 07-25, 07-28): a forensic
// narrative ❓ whose whole-card token denominator can never reach the 0.6 flat
// bar against a tersely-worded fix milestone (0.21 measured live) — even
// though the two share the brain's rarest tokens. Locked here in the verbatim
// STORED (hard-wrapped) form, which also exercises the wrap-normalization.
const WRAPPED_INCIDENT_Q =
    'Release: ❓ PACKAGED LOCAL-AI\nREGRESSION FOUND 2026-07-28 in live\nv1.3.68: package.json excludes all\n'
    + 'node_modules/node-llama-cpp/llama/**\nas presumed dead C++ sources, but\nnode-llama-cpp 3.19.1 runtime reads\n'
    + 'llama/binariesGithubRelease.json even\nwith getLlama({build:\'never\'}).\nNarrow the prune to retain metadata\nand verify a packaged Local answer E2E.';
const TERSE_INCIDENT_M =
    'Release: 🏁 Local-AI dogfood fixes are source-complete: packaging retains node-llama-cpp binariesGithubRelease.json while excluding only the 32 MB git bundle';

// stemLight — the comparison-time morphology that made the pair visible.
ok(stemLight('excludes') === stemLight('excluding'), 'stemLight unifies excludes/excluding');
ok(stemLight('packaged') === stemLight('packaging'), 'stemLight unifies packaged/packaging');
ok(stemLight('retains') === stemLight('retained'), 'stemLight unifies retains/retained');
ok(stemLight('shipped') === stemLight('ships'), 'stemLight unifies shipped/ships');

// Imperative-ask cue: the ❓'s ask sentence becomes a claim clause; a 🏁's
// imperative prose stays exempt (open-shaped cards only).
{
    const cl = extractOpenClauses(WRAPPED_INCIDENT_Q);
    ok(cl.some(c => /^narrow the prune/i.test(c.clause)), 'imperative ask sentence extracts as a claim clause on a ❓ card');
    ok(extractOpenClauses('🏁 shipped it. Verify the rollout dashboards weekly.').length === 0, 'imperative prose on a 🏁 card is NOT a claim');
}

// findFulfillmentCandidates: the incident pair pairs via the anchor OR-path —
// suggestion-only by construction (never ✓-resolvable).
{
    const o = { id: 'iq1', type: 'text', area: 'Release', createdAt: D0, text: WRAPPED_INCIDENT_Q };
    const m = { id: 'im1', type: 'text', area: 'Release', createdAt: D0 + 86_400_000, text: TERSE_INCIDENT_M };
    const cands = findFulfillmentCandidates(mkStruct([o, m]), [m]);
    ok(cands.length >= 1, 'incident pair: verbose ❓ pairs with the terse fix 🏁');
    ok(cands.some(c => c.via === 'anchor'), 'incident pair: matched via rare-anchor OR-path (flat coverage below bar)');
    ok(cands.filter(c => c.via === 'anchor').every(c => c.resolvable === false), 'anchor-path candidates never suggest a ✓ (suggestion-only)');
}
// Anchor precision: 2 shared rare tokens pair SAME-area only; cross-area needs ≥3.
{
    const oR = { id: 'ap1', type: 'text', area: 'Release', createdAt: D0, text: '❓ quuxflux gadget frobnicator pipeline still failing on parse step' };
    const mSame = { id: 'ap2', type: 'text', area: 'Release', createdAt: D0 + 1000, text: 'Release: 🏁 quuxflux frobnicator repaired in the parser build' };
    const mCross = { id: 'ap3', type: 'text', area: 'iOS', createdAt: D0 + 1000, text: 'iOS: 🏁 quuxflux frobnicator repaired in the parser build' };
    ok(findFulfillmentCandidates(mkStruct([oR, mSame]), [mSame]).length >= 1, '2 rare anchors pair within the same area');
    ok(findFulfillmentCandidates(mkStruct([oR, mCross]), [mCross]).length === 0, '2 rare anchors do NOT pair across areas (needs 3)');
}
// findStaleOpenCards inherits the same geometry (SessionStart self-heal path)
// and honors dismissals.
{
    const o = { id: 'sq1', type: 'text', area: 'Release', createdAt: D0, text: WRAPPED_INCIDENT_Q };
    const m = { id: 'sm1', type: 'text', area: 'Release', createdAt: D0 + 86_400_000, text: TERSE_INCIDENT_M };
    const { gaps } = findStaleOpenCards(mkStruct([o, m]));
    ok(gaps.length === 1 && gaps[0].by.id === 'sm1', 'self-heal detector catches the incident pair via anchors');
    const dismissed = findStaleOpenCards(mkStruct([o, m], [{ fromId: 'sq1', toId: 'sm1', relationship: 'not_fulfilled' }]));
    ok(dismissed.gaps.length === 0, 'a not_fulfilled dismissal suppresses the self-heal pair too (parity)');
}

// ── Serve-time ❓↔🏁 pairing inside the answer's own hit set ─────────────────
{
    const o = { id: 'sv1', type: 'text', area: 'Release', createdAt: D0, text: 'Release: ❓ packaged local answers fail — binariesgithubrelease metadata json missing from the asar bundle', tags: [], links: [] };
    const m = { id: 'sv2', type: 'text', area: 'Release', createdAt: D0 + 86_400_000, text: 'Release: 🏁 packaging retains binariesgithubrelease metadata json in the asar bundle', tags: [], links: [] };
    const { hits } = rankForQuestion(mkStruct([o, m]), 'packaged local answers asar bundle', { k: 5 });
    const oh = hits.find(h => h.card.id === 'sv1');
    ok(!!(oh && oh.fulfillment), 'serve-time: co-ranked ❓ gets a fulfillment hint with NO persisted edge');
    ok(!!(oh && oh.fulfillment && oh.fulfillment.unconfirmed === true), 'serve-time hint is flagged unconfirmed (hedged render)');
    const { hits: hits2 } = rankForQuestion(mkStruct([o, m], [{ fromId: 'sv1', toId: 'sv2', relationship: 'not_fulfilled' }]), 'packaged local answers asar bundle', { k: 5 });
    const oh2 = hits2.find(h => h.card.id === 'sv1');
    ok(!(oh2 && oh2.fulfillment), 'serve-time pairing respects a not_fulfilled dismissal');
    // An OLDER milestone must never serve-time-pair with a newer open card.
    const { hits: hits3 } = rankForQuestion(mkStruct([{ ...o, createdAt: D0 + 172_800_000 }, m]), 'packaged local answers asar bundle', { k: 5 });
    const oh3 = hits3.find(h => h.card.id === 'sv1');
    ok(!(oh3 && oh3.fulfillment), 'serve-time pairing requires the milestone to post-date the open card');
}

// statusContextToMarkdown: serve-time augmentation flags an edge-less pair with
// the hedged '?' variant, never the confirmed flag.
{
    const o = { id: 'st1', type: 'text', area: 'Release', createdAt: Date.now() - 2 * 86_400_000, text: 'Release: ❓ packaged local answers fail — binariesgithubrelease metadata json missing from the asar bundle' };
    const m = { id: 'st2', type: 'text', area: 'Release', createdAt: Date.now() - 3_600_000, text: 'Release: 🏁 packaging retains binariesgithubrelease metadata json in the asar bundle' };
    const md = statusContextToMarkdown(mkStruct([o, m]));
    ok(/⏳likely-fulfilled\?/.test(md), 'status open-list flags the edge-less pair as ⏳likely-fulfilled? (unconfirmed)');
}

// ── captureIntoBrain persists detection as edges (2026-07-29) ────────────────
// A pair the self-heal detector can see must survive as a dashed edge after any
// capture — prose-only detection died with the SessionStart that printed it.
{
    const buf = await buildKlypix({
        title: 'hint-fixture',
        cards: [{ text: 'Release: ❓ caps handshake wiring for the drive portal still open', area: 'Release' }],
    });
    await new Promise(r => setTimeout(r, 20));    // the fulfilling 🏁 must post-date the ❓
    const res = await captureIntoBrain(buf, {
        cards: [{ text: 'Release: 🏁 caps handshake wiring for the drive portal shipped', area: 'Release' }],
    });
    const { struct } = await parseKlypix(res.buffer);
    const q = struct.cards.find(c => /caps handshake wiring.*still open/s.test(c.text || ''));
    const f = struct.cards.find(c => /🏁.*caps handshake wiring/s.test(c.text || ''));
    const edge = (struct.connections || []).find(cn => cn.label === 'likely closed by' && q && f && cn.fromId === q.id && cn.toId === f.id);
    ok(!!edge, 'capture persists a dashed likely-closed-by edge for the detected pair');
}

// ── Review fixes (2026-07-29 adversarial pass over the 1.43.0 diff) ──────────
// Each of these reproduces a CONFIRMED finding and must stay dead.

// F1 · A dismissal must SURVIVE STORAGE. The REL allowlist silently coerced
// not_fulfilled → relates_to, so every settled-set check was dead in production
// since 1.31.0: the tool said "Drew 1 connection(s)" and the dismissed hint came
// back on the next render, forever. Tests passed only because fixtures fabricate
// the connection object and never round-trip it through the writer.
{
    const buf = await buildKlypix({
        title: 'dismiss-fixture',
        cards: [{ text: 'x: ❓ caps handshake wiring still open' }, { text: 'x: 🏁 caps handshake wiring shipped' }],
    });
    const { struct: s0 } = await parseKlypix(buf);
    const [a, b] = s0.cards.filter(c => c.type !== 'container');
    const res = await addBrainConnections(buf, [{ fromId: a.id, toId: b.id, relationship: 'not_fulfilled' }]);
    ok(res.added === 1, 'a not_fulfilled dismissal is accepted by the writer');
    const { struct: s1 } = await parseKlypix(res.buffer);
    ok((s1.connections || []).some(c => c.relationship === 'not_fulfilled'), 'the dismissal survives storage as not_fulfilled (not coerced to relates_to)');
    // …and end-to-end: a stored dismissal suppresses the serve-time hint.
    const { hits } = rankForQuestion(s1, 'caps handshake wiring', { k: 5 });
    const oh = hits.find(h => h.card.id === a.id);
    ok(!(oh && oh.fulfillment), 'a ROUND-TRIPPED dismissal actually suppresses the hint');
}
// F2 · A dismissal must not be pair-deduped away by the very hint it dismisses.
{
    const buf = await buildKlypix({
        title: 'dismiss-after-hint',
        cards: [{ text: 'y: ❓ phone inbox drain routing still open' }, { text: 'y: 🏁 phone inbox drain routing shipped' }],
    });
    const { struct: s0 } = await parseKlypix(buf);
    const [a, b] = s0.cards.filter(c => c.type !== 'container');
    const hinted = await addBrainConnections(buf, [{ fromId: a.id, toId: b.id, relationship: 'relates_to', label: 'likely closed by' }]);
    const dismissed = await addBrainConnections(hinted.buffer, [{ fromId: a.id, toId: b.id, relationship: 'not_fulfilled' }]);
    ok(dismissed.added === 1, 'a dismissal is recorded even when a hint edge already occupies the pair');
    const { struct: s2 } = await parseKlypix(dismissed.buffer);
    ok(!(s2.connections || []).some(c => c.label === 'likely closed by'), 'the dismissed machine hint is retired, not left rendering');
    ok(fulfillmentOverlaysFor(s2, s2.cards.filter(c => c.type !== 'container')).size === 0, 'no overlay survives the dismissal');
    // A second identical dismissal is still deduped.
    const again = await addBrainConnections(dismissed.buffer, [{ fromId: a.id, toId: b.id, relationship: 'not_fulfilled' }]);
    ok(again.added === 0, 'a duplicate dismissal is deduped');
}
// F3 · A persisted machine hint stays HEDGED. One capture used to promote a
// suggestion to the confirmed "⏳ LIKELY FULFILLED" tier.
{
    const o = { id: 'h1', type: 'text', area: 'x', createdAt: D0, text: 'x: ❓ caps handshake wiring for the drive portal still open' };
    const m = { id: 'h2', type: 'text', area: 'x', createdAt: D0 + 1000, text: 'x: 🏁 caps handshake wiring for the drive portal shipped' };
    const ov = fulfillmentOverlaysFor(mkStruct([o, m], [{ fromId: 'h1', toId: 'h2', label: 'likely closed by' }]), [o]);
    ok(ov.get('h1')?.unconfirmed === true, 'a machine-written hint edge renders as unconfirmed, not settled truth');
}
// F4 · Anchor precision: the area-name prefix every stored card carries is
// shared BY CONSTRUCTION and can never be evidence; rarity is relative to
// corpus size. Probe from the review: an SSO ship "fulfilling" a changelog ❓.
{
    const o = { id: 'p1', type: 'text', area: 'Release', createdAt: D0, text: 'Release: ❓ decide the changelog format for enterprise customers before launch' };
    const m = { id: 'p2', type: 'text', area: 'Release', createdAt: D0 + 1000, text: 'Release: 🏁 enterprise SSO login shipped to production' };
    ok(findStaleOpenCards(mkStruct([o, m])).gaps.length === 0, 'area prefix + one topic word does NOT pair unrelated cards');
    ok(findFulfillmentCandidates(mkStruct([o, m]), [m]).length === 0, '…and the capture-side matcher agrees');
}
// F5 · stemLight collisions must not mint anchors (state↔stats, notes↔noting).
// The stems genuinely collide; the raw-word guard is what stops the collision
// from becoming EVIDENCE. Fixtures share nothing but the colliding words.
ok(stemLight('state') === stemLight('stats'), 'stemLight DOES collide state/stats (documented)');
ok(stemLight('notes') === stemLight('noting'), 'stemLight DOES collide notes/noting (documented)');
{
    const o = { id: 'c1', type: 'text', area: 'Canvas', createdAt: D0, text: 'Canvas: ❓ undo discards rotation state plus authored notes' };
    const m = { id: 'c2', type: 'text', area: 'Canvas', createdAt: D0 + 1000, text: 'Canvas: 🏁 cost stats panel shipped, noting hourly spend' };
    ok(findStaleOpenCards(mkStruct([o, m])).gaps.length === 0, '…but the raw-word guard stops two collisions from pairing the cards');
    ok(findFulfillmentCandidates(mkStruct([o, m]), [m]).length === 0, '…on the capture side too');
    // Real morphology still counts as the same word.
    ok(stemLight('excludes') === stemLight('excluding'), 'genuine variants still unify (excludes/excluding)');
}
// F6 · A "remaining:" clause must stop at a SENTENCE boundary, or unwrapping
// lets it swallow following DONE sentences and suggest a ✓ for untouched work.
{
    const t = 'QA: ❓ remaining: mobile safari test matrix. Desktop test matrix shipped in the v2 rollout already.';
    const cl = extractOpenClauses(t);
    const first = cl.find(c => /mobile safari/i.test(c.clause));
    ok(!!first && !/desktop/i.test(first.clause), 'the claim clause stops at the period, not at paragraph end');
    const o = { id: 'q1', type: 'text', area: 'QA', createdAt: D0, text: t };
    const m = { id: 'q2', type: 'text', area: 'QA', createdAt: D0 + 1000, text: 'QA: 🏁 desktop test matrix shipped in the v2 rollout' };
    const cands = findFulfillmentCandidates(mkStruct([o, m]), [m]);
    ok(!cands.some(c => c.resolvable && /mobile safari/i.test(c.item)), 'no ✓ is suggested for the untouched mobile-safari item');
}
// F7 · Serve-time coverage needs a minimum claim size: a 2-token ❓ is trivially
// "covered" by any milestone reusing its words, cross-area, at cov 1.0.
{
    const o = { id: 's1', type: 'text', area: 'Release', createdAt: Date.now() - 2 * 86_400_000, text: 'Release: ❓ npm publish?' };
    const m = { id: 's2', type: 'text', area: 'Docs', createdAt: Date.now() - 3_600_000, text: 'Docs: 🏁 nightly job publishes release notes to the wiki' };
    const md = statusContextToMarkdown(mkStruct([o, m]));
    ok(!/⏳likely-fulfilled/.test(md), 'a 2-token open card is never flagged fulfilled by word reuse alone');
}
// F8 · Anchor-grade evidence is NEVER persisted as an edge — it stays
// serve-time-only so being wrong about it costs nothing beyond one render.
{
    const buf = await buildKlypix({
        title: 'anchor-no-persist',
        cards: [{ text: 'Release: ❓ quuxflux frobnicator pipeline still failing on the parse step for large inputs', area: 'Release' }],
    });
    await new Promise(r => setTimeout(r, 20));
    const res = await captureIntoBrain(buf, { cards: [{ text: 'Release: 🏁 quuxflux frobnicator repaired inside the parser build', area: 'Release' }] });
    const { struct } = await parseKlypix(res.buffer);
    ok(!(struct.connections || []).some(c => c.label === 'likely closed by'), 'an anchor-grade pair leaves no persisted hint edge');
}

console.log(fail ? `✗ ${fail} assertion(s) failed` : '✓ claim-engine: all assertions passed');
process.exit(fail ? 1 : 0);
