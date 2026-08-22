// Plan-shaped cards ↔ 🏁 (2026-08-23, AgentLit "Capability Forge" incident).
//
// A proposal written WITHOUT a ❓ glyph, built the SAME DAY under a RENAMED
// 🏁 ("Capability Forge proposal" → "🏁 Capability builder shipped"), kept
// rendering as current intent; a session answered "it's only a proposal" about
// a live feature. The real pair measured lexical coverage 0.20 with ZERO rare
// anchors (it is renamed) and BGE cosine 0.81 — so the fix is embedding-first,
// and this suite reproduces that exact geometry with an injected similarity
// oracle (no model needed). It pins:
//   • the classifier: plan cues in, ship pins / glyphs / corrections out
//   • pairing: the incident pair pairs; an unrelated later 🏁 does not; a
//     dismissal edge wins; an older 🏁 never "fulfils" a newer plan; near-tie
//     → earliest ship wins
//   • brain_ask: hedged ⏳ POSSIBLY BUILT overlay, the ship lifted above the
//     plan it fulfilled, brain-wide fallback when the ship is not in the hit
//     set, nothing under as_of, history never deleted
//   • self-heal: plan cards listed separately as "look BUILT"
//   • claims: a lexically strong plan→ship pair reaches the shared extractor
//   • arrange: an identical __agconf twin of an archived original collapses
//     across areas; a twin with DIFFERENT text (a real conflict) survives
//
// Run:  node test/plan-fulfillment.mjs        (exit 0 = pass, 1 = fail)
import {
    isPlanCard, planFulfillmentFor, rankForQuestion, questionContextToMarkdown,
    findStaleOpenCards, findFulfillmentCandidates, PLAN_PAIR_SIM_BRAIN, PLAN_PAIR_SIM_ANSWER,
    buildKlypixMap, parseKlypix, arrangeBrain, shard,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const T = (s) => Date.parse(s);
const card = (id, area, text, createdAt, extra = {}) => ({ id, type: 'text', title: null, text, tags: [], area, createdAt, parentId: null, ...extra });
const mkStruct = (cards, connections = []) => ({ cards, connections, counts: { cards: cards.length, connections: connections.length }, title: 'brain', format: 'klypix-v4' });

// ── The incident, faithfully shaped ─────────────────────────────────────────
const PLAN = card('txt_plan', 'Product',
    'Product: Capability Forge proposal (2026-08-03): when a worker lacks a capability, spawn a sandboxed coding agent to build and verify a versioned executable tool plus optional MCP-App UI, preview it for approval, then merge it into the portable .agent. Key boundary: code can create logic/UI but cannot bypass missing OAuth, credentials, or user permission. Closest product threat is Replit Agent 4 (isolated parallel builds, live artifact previews, approval before merging).',
    T('2026-08-03T10:26:00Z'));
const SHIP1 = card('txt_ship1', 'Product',
    'Product: 🏁 Capability builder v1 implemented on isolated branch feat/autonomous-capability-builder at 6e432f6: authenticated runs only suggest gaps; owner-started durable Python builds use provider-neutral harness/E2B adapters, bounded repair plus static/sandbox/skill verification, preview and source review, draft-safe promotion, immutable undo, and .agent export contract.',
    T('2026-08-03T11:57:00Z'));
const SHIP2 = card('txt_ship2', 'Release',
    'Release: 🏁 Capability builder shipped live 2026-08-03 via PR #435 / main 4f7a87f; Railway deployment succeeded after idempotent schema apply, production health and auth guard passed, live bundle contains Build capability/Add to worker/egress-disabled UI, post-merge CI passed.',
    T('2026-08-03T12:40:00Z'));
const UNRELATED = card('txt_faq', 'Website',
    'Website: 🏁 FAQ v2 pushed (95ceb29): four strength-forward Q&As now lead the honest comparison page, pricing footnote moved under the table.',
    T('2026-08-05T09:00:00Z'));
const OLDER_SHIP = card('txt_old', 'Product',
    'Product: 🏁 Capability builder prototype demoed to the founder: sandboxed coding agent builds a tool, preview, approval, merge into the worker.',
    T('2026-08-01T09:00:00Z'));
// Vocabulary padding: in a tiny brain EVERY shared word is "rare" (the anchor
// oracle's df ceiling is max(2, 2% of live cards)), so sandbox/agent/preview/
// approval would count as rare anchors and the lexical bar would pair the
// incident on its own — which the real 716-card brain does NOT do (measured:
// cov 0.20, anchors ≤ 1, serveTimeAccepts=false). These cards give the shared
// vocabulary a realistic document frequency so the fixture keeps the real
// geometry: embeddings are what pair the RENAMED ship, lexical alone cannot.
const NOISE = [
    card('txt_n1', 'Auth', 'Auth: refresh tokens rotate every 30 days via the session store rotation job for tenant isolation.', T('2026-07-01T00:00:00Z')),
    card('txt_n2', 'UI', 'UI: the settings panel uses a nine-tab sidebar layout with keyboard navigation.', T('2026-07-02T00:00:00Z')),
    card('txt_n3', 'Release', 'Release: 🏁 v0.9 tagged and published to npm with provenance; changelog regenerated.', T('2026-07-03T00:00:00Z')),
    card('txt_v0', 'Notes', 'Ops: the sandbox preview for every agent build needs approval before merge; a worker tool build is isolated and verified in the sandbox.', T('2026-07-04T00:00:00Z')),
    card('txt_v1', 'Notes', 'QA: agent preview approval merge flow — every capability tool build runs in the sandbox with verification and isolated review.', T('2026-07-05T00:00:00Z')),
    card('txt_v2', 'Notes', 'Docs: how a worker gains a capability: build the tool, preview, approval, merge; the sandboxed agent verifies the build and the review.', T('2026-07-06T00:00:00Z')),
    card('txt_v3', 'Notes', 'Support: isolated builds, live previews, approval before merging — the agent sandbox flow for worker capability tools, verified.', T('2026-07-07T00:00:00Z')),
];
// Injected card↔card cosine oracle — the measured incident values.
const SIM = { 'txt_plan|txt_ship1': 0.811, 'txt_plan|txt_ship2': 0.804, 'txt_plan|txt_faq': 0.74, 'txt_plan|txt_old': 0.83 };
const pairSim = (a, b) => SIM[`${a}|${b}`] ?? SIM[`${b}|${a}`] ?? 0.2;

// ── Classifier ───────────────────────────────────────────────────────────────
ok(isPlanCard(PLAN), 'classifier: "Capability Forge proposal (…)" is a plan card');
ok(!isPlanCard(SHIP1) && !isPlanCard(SHIP2), 'classifier: 🏁 cards are never plans');
ok(isPlanCard(card('c1', 'Canvas agent', 'Canvas agent: Slash-command rework — PLAN ONLY, not built (2026-06-13). Root cause: the nine commands share one parser.', 1)), 'classifier: "PLAN ONLY, not built" is a plan (negated ship pin stays a plan cue)');
ok(isPlanCard(card('c2', 'Release', 'Release: v1.3.88 PLANNED — payload = six unreleased master commits since 62384b7: Project Map stall-based timeout + folder retry.', 1)), 'classifier: "vX PLANNED — payload" is a plan');
ok(isPlanCard(card('c3', 'Chat', 'Chat: Scoped ASK design founder-approved (2026-08-01): ASK gains an optional per-conversation project scope.', 1)), 'classifier: "design founder-approved" is a plan');
ok(isPlanCard(card('c4', 'Canvas UX', 'Canvas UX: Founder direction 2026-08-01: ZIP extraction should default to the canvas, creating a real editable folder card.', 1)), 'classifier: "should default to" is a plan');
ok(!isPlanCard(card('c5', 'Roadmap', 'Roadmap: Mac Phase-1 native-shell layer BUILT + syntax-verified (2026-07-18) on branch feat/mac — a plan for phase 2 follows.', 1)), 'classifier: a BUILT card is an event, not a plan (ship pin wins; the area word "Roadmap" is stripped, not a cue)');
ok(!isPlanCard(card('c6', 'Product', 'Product: CORRECTION: Capability Forge is BUILT, not a proposal — supersedes the 2026-08-03 proposal card.', 1)), 'classifier: a correction-cue card is never a plan');
ok(!isPlanCard(card('c7', 'Brain', 'Brain: 🛠️ always write the plan down before the proposal review, never after.', 1)), 'classifier: a 🛠️ skill is never a plan');
ok(!isPlanCard(card('c8', 'Product', 'Product: ❓ proposal: should the worker spawn a coding agent?', 1)), 'classifier: a ❓ card keeps its own (open) lifecycle');
ok(!isPlanCard(card('c9', 'Runtime', 'Runtime: Model routing FINAL state (founder, 2026-07-03): Architect = fable, Worker = sonnet; the pushback step runs twice.', 1)), 'classifier: a settled state card without a future-work cue is not a plan');
ok(!isPlanCard(card('c10', 'Canvas', 'Canvas: Flowchart Phases 2–6 SHIPPED (f4fbeea, plan doc d56c899). Mermaid flowchart cards render natively.', 1)), 'classifier: "SHIPPED (…, plan doc …)" is an event');
ok(!isPlanCard({ id: 'img', type: 'image', text: 'proposal.png', area: 'Product', createdAt: 1 }), 'classifier: media cards carry no lifecycle');

// ── Pairing ──────────────────────────────────────────────────────────────────
{
    const struct = mkStruct([PLAN, SHIP1, SHIP2, UNRELATED, ...NOISE]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim, scope: 'brain' });
    const h = hints.get(PLAN.id);
    ok(!!h, 'pairing: the incident plan pairs brain-wide at the strict tier (cosine 0.81 + coverage corroboration)');
    ok(h && (h.byId === SHIP1.id || h.byId === SHIP2.id), `pairing: it pairs with a Capability-builder ship, not the FAQ card (got ${h && h.byId})`);
    ok(h && h.kind === 'plan' && h.unconfirmed === true && /builder/i.test(h.by), 'pairing: the hint is kind:plan, unconfirmed, and names the ship');
    ok(h && h.byId === SHIP1.id, 'pairing: near-tie (0.811 vs 0.804) breaks toward the EARLIEST ship');
    ok(h && typeof h.sim === 'number' && h.sim >= PLAN_PAIR_SIM_BRAIN, 'pairing: the receipt carries the cosine that cleared the bar');
}
{
    const struct = mkStruct([PLAN, UNRELATED, ...NOISE]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim, scope: 'brain' });
    ok(!hints.has(PLAN.id), 'pairing: an unrelated later 🏁 at cosine 0.74 does NOT pair brain-wide (no false "built")');
}
{
    const struct = mkStruct([PLAN, OLDER_SHIP, ...NOISE]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim, scope: 'brain' });
    ok(!hints.has(PLAN.id), 'pairing: a 🏁 OLDER than the plan never fulfils it, however similar');
}
{
    const struct = mkStruct([PLAN, SHIP1, ...NOISE], [{ fromId: PLAN.id, toId: SHIP1.id, relationship: 'not_fulfilled', label: 'not fulfilled' }]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim, scope: 'brain' });
    ok(!hints.has(PLAN.id), 'pairing: a human not_fulfilled dismissal wins over the similarity oracle');
}
{
    const struct = mkStruct([PLAN, SHIP1, ...NOISE]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim: null, scope: 'brain' });
    ok(!hints.has(PLAN.id), 'pairing: lexical-only cannot pair the RENAMED incident (cov 0.20, no rare anchors) — which is why the tiers are embedding-first');
}
{
    const struct = mkStruct([PLAN, SHIP1, ...NOISE]);
    const hints = planFulfillmentFor(struct, [PLAN], { pairSim: (a, b) => (a === PLAN.id && b === SHIP1.id) ? 0.79 : 0.1, scope: 'brain' });
    ok(!hints.has(PLAN.id), `pairing: brain tier refuses cosine below PLAN_PAIR_SIM_BRAIN (${PLAN_PAIR_SIM_BRAIN}) — the measured false-pair band`);
    const answer = planFulfillmentFor(struct, [PLAN], { pairSim: (a, b) => (a === PLAN.id && b === SHIP1.id) ? 0.79 : 0.1, scope: 'answer' });
    ok(answer.has(PLAN.id), `pairing: the in-answer tier (question-constrained) accepts the same pair at ≥ ${PLAN_PAIR_SIM_ANSWER}`);
}
ok(planFulfillmentFor(mkStruct([SHIP1, SHIP2]), [SHIP1], { pairSim, scope: 'brain' }).size === 0, 'pairing: a 🏁 handed in as a "plan" yields nothing (classifier gate inside)');
{
    // A measured cosine VETOES the lexical fallback: a lexically strong pair the
    // embedding measured as not-near-duplicate must not pair brain-wide (the
    // KLYPIX sweep's false pairs all came through anchors at 0.64–0.74).
    const planned = card('txt_rel_plan', 'Release', 'Release: v1.3.88 PLANNED — payload: project map stall-based timeout, folder round-trip retry, annotated image decode fix, drive inbox badge.', T('2026-08-06T08:00:00Z'));
    const published = card('txt_rel_ship', 'Release', 'Release: 🏁 v1.3.88 PUBLISHED and LIVE — project map stall-based timeout, folder round-trip retry, annotated image decode fix, drive inbox badge all shipped at 100% rollout.', T('2026-08-06T20:00:00Z'));
    const struct = mkStruct([planned, published, ...NOISE]);
    const noVec = planFulfillmentFor(struct, [planned], { pairSim: null, scope: 'brain' });
    ok(noVec.get(planned.id)?.byId === published.id && noVec.get(planned.id)?.via === 'coverage', 'pairing/veto: with NO vectors the strict lexical fallback still pairs a coverage-grade plan→ship');
    const lowSim = planFulfillmentFor(struct, [planned], { pairSim: () => 0.70, scope: 'brain' });
    ok(!lowSim.has(planned.id), 'pairing/veto: the SAME lexically strong pair is refused brain-wide once a cosine below the bar is measured');
    const missingVec = planFulfillmentFor(struct, [planned], { pairSim: () => null, scope: 'brain' });
    ok(missingVec.get(planned.id)?.byId === published.id, 'pairing/veto: a pair with no vector for either card (cache miss) keeps the lexical fallback');
    const answer = planFulfillmentFor(struct, [planned], { pairSim: () => 0.70, scope: 'answer' });
    ok(answer.get(planned.id)?.byId === published.id, 'pairing/veto: the question-constrained answer tier keeps lexical acceptance');
}
{
    // Twin rows collapse in the self-heal list; the original's id is preferred.
    const twin = { ...PLAN, id: `${PLAN.id}__agconf_ab12cd` };
    const struct = mkStruct([twin, PLAN, SHIP1, SHIP2, ...NOISE]);
    const r = findStaleOpenCards(struct, { max: 5, pairSim: (a, b) => pairSim(a.replace(/__agconf_.*$/, ''), b.replace(/__agconf_.*$/, '')) });
    ok(r.plansTotal === 1 && r.plans[0].open.id === PLAN.id, `self-heal: an identical __agconf twin collapses to ONE row under the original's id (got ${r.plansTotal}: ${r.plans.map(p => p.open.id).join(',')})`);
}

// ── brain_ask: overlay + demotion + brain-wide fallback + as_of ──────────────
const Q = 'what is Capability Forge and is it built?';
{
    const struct = mkStruct([PLAN, SHIP1, SHIP2, UNRELATED, ...NOISE]);
    const semantic = new Map([[PLAN.id, 0.75], [SHIP1.id, 0.70], [SHIP2.id, 0.69], [UNRELATED.id, 0.40], ['txt_n1', 0.1], ['txt_n2', 0.1], ['txt_n3', 0.2]]);
    const r = rankForQuestion(struct, Q, { semantic, k: 6, pairSim });
    const ids = r.hits.map(h => h.card.id);
    const planHit = r.hits.find(h => h.card.id === PLAN.id);
    ok(!!planHit, 'ask: the proposal is still retrieved (history is never hidden)');
    ok(planHit && planHit.fulfillment && planHit.fulfillment.kind === 'plan' && planHit.fulfillment.byId === SHIP1.id, 'ask: the proposal carries a kind:plan fulfillment hint naming the builder ship');
    ok(ids.indexOf(SHIP1.id) === ids.indexOf(PLAN.id) - 1, `ask: the ship is lifted to directly above the plan it fulfilled (order ${ids.join(' > ')})`);
    ok(ids.indexOf(SHIP1.id) < ids.indexOf(PLAN.id), 'ask: the newest truth wins the slot');
    const md = questionContextToMarkdown(Q, r, { mode: 'test' });
    ok(/⏳ POSSIBLY BUILT/.test(md), 'ask: the markdown renders the hedged POSSIBLY BUILT overlay');
    ok(/Capability builder v1 implemented/.test(md), 'ask: the overlay names the ship card');
    ok(/Do NOT answer "only a proposal"/.test(md), 'ask: the overlay tells the reader not to answer "only a proposal"');
    ok(/VERIFY against the repo/.test(md) && /not_fulfilled/.test(md), 'ask: the overlay demands verification and offers the dismissal');
    ok(md.indexOf('Capability builder v1 implemented') < md.indexOf('Capability Forge proposal'), 'ask: the ship renders before the proposal');
}
{
    // Brain-wide fallback: the ship did NOT match the question (k=1 → only the plan is a hit).
    const struct = mkStruct([PLAN, SHIP1, SHIP2, ...NOISE]);
    const semantic = new Map([[PLAN.id, 0.8], [SHIP1.id, 0.2], [SHIP2.id, 0.2]]);
    const r = rankForQuestion(struct, Q, { semantic, k: 1, pairSim });
    ok(r.hits.length === 1 && r.hits[0].card.id === PLAN.id, 'ask/fallback: only the plan is in the hit set');
    ok(r.hits[0].fulfillment && r.hits[0].fulfillment.byId === SHIP1.id, 'ask/fallback: the plan is still paired against the whole brain (renamed ship absent from the answer)');
    const md = questionContextToMarkdown(Q, r, { mode: 'test' });
    ok(/POSSIBLY BUILT/.test(md) && /Capability builder/.test(md), 'ask/fallback: the hint carries the ship even though it is not a hit');
}
{
    const struct = mkStruct([PLAN, SHIP1, SHIP2, ...NOISE]);
    const semantic = new Map([[PLAN.id, 0.75], [SHIP1.id, 0.70], [SHIP2.id, 0.69]]);
    const r = rankForQuestion(struct, Q, { semantic, k: 6, pairSim, as_of: '2026-08-10' });
    ok(r.hits.every(h => !h.fulfillment), 'ask/as_of: time-travel answers carry no plan overlay (a hint is a present-tense fact)');
    const md = questionContextToMarkdown(Q, r, { mode: 'test', as_of: '2026-08-10' });
    ok(!/POSSIBLY BUILT/.test(md), 'ask/as_of: nothing renders as possibly built');
}
{
    // No ship exists → no overlay, no reorder (genuinely unbuilt plans stay plain).
    const struct = mkStruct([PLAN, UNRELATED, ...NOISE]);
    const semantic = new Map([[PLAN.id, 0.75], [UNRELATED.id, 0.5]]);
    const r = rankForQuestion(struct, Q, { semantic, k: 6, pairSim });
    ok(r.hits[0].card.id === PLAN.id && !r.hits[0].fulfillment, 'ask/negative: a plan with no matching later 🏁 renders plain and keeps its rank');
}
{
    // A lexical-only host (no embeddings anywhere): nothing pairs for the renamed
    // incident, nothing breaks, and the existing ❓ path is untouched.
    const struct = mkStruct([PLAN, SHIP1, SHIP2, ...NOISE]);
    const r = rankForQuestion(struct, Q, { k: 6 });
    ok(r.hits.length >= 1, 'ask/lexical-host: still answers');
    ok(r.hits.every(h => !h.fulfillment || h.fulfillment.kind !== 'plan' || h.fulfillment.via !== 'embed'), 'ask/lexical-host: no embedding-tier plan hint without vectors');
}

// ── SessionStart self-heal: plan cards listed separately ─────────────────────
{
    const struct = mkStruct([PLAN, SHIP1, SHIP2, UNRELATED, ...NOISE]);
    const r = findStaleOpenCards(struct, { max: 5, pairSim });
    ok(Array.isArray(r.plans) && r.plansTotal === 1 && r.plans[0].open.id === PLAN.id && r.plans[0].by.id === SHIP1.id, 'self-heal: the plan is listed as "looks BUILT" with its ship');
    ok(r.total === 0 && r.gaps.length === 0, 'self-heal: the ❓ report is untouched (no open cards here)');
    const r2 = findStaleOpenCards(struct, { max: 5 });
    ok(r2.plansTotal === 0 && Array.isArray(r2.plans), 'self-heal: without vectors the renamed pair stays unlisted (strict lexical bars), shape intact');
}

// ── Shared claim extractor: a lexically strong plan→ship pair ────────────────
{
    const planned = card('txt_rel_plan', 'Release', 'Release: v1.3.88 PLANNED — payload: project map stall-based timeout, folder round-trip retry, annotated image decode fix, drive inbox badge.', T('2026-08-06T08:00:00Z'));
    const published = card('txt_rel_ship', 'Release', 'Release: 🏁 v1.3.88 PUBLISHED and LIVE — project map stall-based timeout, folder round-trip retry, annotated image decode fix, drive inbox badge all shipped at 100% rollout.', T('2026-08-06T20:00:00Z'));
    const struct = mkStruct([planned, published, ...NOISE]);
    const cands = findFulfillmentCandidates(struct, [published]);
    const c = cands.find(x => x.open.id === planned.id);
    ok(!!c, 'claims: a plan card is a whole-card claim source for the shared extractor');
    ok(c && c.kind === 'plan' && c.cov >= 0.6, `claims: the candidate is kind:plan at coverage grade (cov ${c && c.cov})`);
}

// ── arrange: identical __agconf twins collapse across areas ──────────────────
{
    const buf = await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Product', cards: [{ text: 'Product: live card that stays.' }] },
            { title: 'Archive', cards: [{ text: '↩︎ superseded 2026-08-22 Product: Capability Forge proposal: spawn a sandboxed coding agent to build a tool.' }] },
        ],
    });
    const p = await parseKlypix(buf);
    const product = p.struct.cards.find(c => c.type === 'container' && c.title === 'Product');
    const orig = p.struct.cards.find(c => c.type === 'text' && /Forge proposal/.test(c.text));
    const live = p.struct.cards.find(c => c.type === 'text' && /stays/.test(c.text));
    const clone = async (id, twinId, mutate = (j) => j) => {
        const itemPath = `items/${shard(id)}/${id}.json`;
        const json = JSON.parse(await p.zip.file(itemPath).async('string'));
        p.zip.file(`items/${shard(twinId)}/${twinId}.json`, JSON.stringify(mutate(json)));
        p.canvas.positions[twinId] = { ...p.canvas.positions[id], parentId: product.id, x: (p.canvas.positions[id].x || 0) + 400 };
        p.canvas.order = [...(p.canvas.order || []), twinId];
    };
    // identical twin of the ARCHIVED original, living in Product (the AgentLit zombie)
    await clone(orig.id, `${orig.id}__agconf_zz1`);
    // a twin with DIFFERENT text — a genuine two-sided edit record — must survive
    await clone(live.id, `${live.id}__agconf_zz2`, (j) => ({ ...j, content: 'Product: live card that stays — THEIR edit.' }));
    // the REAL zombie shape: the twin carries the original's PRE-retirement text
    // (the original gained "↩︎ superseded <date>\n" after the twin was born)
    await clone(orig.id, `${orig.id}__agconf_zz3`, (j) => ({ ...j, content: String(j.content).replace(/^↩︎ superseded \d{4}-\d{2}-\d{2}\s*/u, '') }));
    // the symmetric shape: the TWIN carries a "✅ closed by" stamp the bare original lacks — the stamped copy must survive
    await clone(live.id, `${live.id}__agconf_zz4`, (j) => ({ ...j, content: `${j.content}\n✅ 2026-07-28: closed by → the live card shipped` }));
    p.zip.file('canvas.json', JSON.stringify(p.canvas));
    const twinned = await p.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const before = (await parseKlypix(twinned)).struct.cards;
    ok(before.some(c => c.id === `${orig.id}__agconf_zz1`) && before.some(c => c.id === `${live.id}__agconf_zz2`), 'arrange fixture: both twins exist before');
    const { buffer, stats } = await arrangeBrain(twinned);
    const after = (await parseKlypix(buffer)).struct.cards;
    ok(!after.some(c => c.id === `${orig.id}__agconf_zz1`), 'arrange: the identical twin of the archived original is collapsed ACROSS areas');
    ok(after.some(c => c.id === orig.id), 'arrange: the original (archived) survives as the group survivor');
    ok(after.some(c => c.id === `${live.id}__agconf_zz2`), 'arrange: a twin with DIFFERENT text (a real conflict record) survives');
    ok(stats.collapsedCards.some(g => g.kept === orig.id && g.removed.includes(`${orig.id}__agconf_zz1`)), 'arrange: the receipt names the survivor and the removed twin');
    ok(!after.some(c => c.id === `${orig.id}__agconf_zz3`), 'arrange: a twin carrying the original\'s PRE-retirement text (the real zombie) is folded');
    ok(after.some(c => c.id === orig.id && /↩︎ superseded/.test(c.text)), 'arrange: the stamped original survives with its retirement record intact');
    ok(!after.some(c => c.id === live.id) && after.some(c => c.id === `${live.id}__agconf_zz4` && /✅ 2026-07-28: closed by/.test(c.text)), 'arrange: when only the TWIN carries a ✅ stamp, the stamped copy survives (lifecycle record kept)');
    ok(after.filter(c => c.type === 'text').length === before.filter(c => c.type === 'text').length - 3, 'arrange: exactly the three identical twins were removed, nothing else');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall plan-fulfillment checks passed');
process.exit(failures ? 1 : 0);
