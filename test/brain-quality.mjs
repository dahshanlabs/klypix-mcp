// Knowledge-quality regression suite (1.17.0) — acceptance tests for the
// 2026-07-02 field report's findings, at the format-engine level:
//   P1  capture: a correction-cue note supersedes its stale card ACROSS areas
//       at the widened 0.4 bar (and a plain cross-area decision still does NOT).
//   P1  recall: correctionOverlaysFor labels stale cards only through explicit
//       lifecycle identity edges; lexical similarity never asserts correction.
//   P4a close:   `closes:` resolves ALL covered twins, not the first match.
//   P4b merge:   a rephrased duplicate ❓ updates the existing open question.
//   P3  graph:   a captured card auto-links to a tag-sharing sibling (label 'auto').
//   P5/P9 repeat: work-verb stoplist + entity gate kill the observed FPs, keep the TP.
//   P6  scorer:  body score is length-normalized — long cards stop winning on bulk.
//   P8  detectContradictions surfaces the deferred-vs-CORRECTION pair first.
//   P9  garden:  #auto ship cards become dormant at 7d (hand-written at 14d).
//   + protect-list: single-target closes:, same-area supersede at 0.6.
//
// Run:  node test/brain-quality.mjs        (exit 0 = pass, 1 = fail)
import {
    buildKlypixMap, parseKlypix, captureIntoBrain, correctionOverlaysFor,
    detectRepeatWork, detectContradictions, scoreCardsAgainstQuery,
    selectGardenCandidates, queryTokens,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const STALE = 'Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 — agents run skills only in-session for now, executor postponed until real demand shows.';
const CORRECTION = 'CORRECTION (stale note resolved): off-cloud skill/brain execution is now WIRED, not deferred — the runner executes skills off-cloud since the connectivity arc.';

async function brainWith(areas) {
    return parseKlypix(await buildKlypixMap({ title: 'brain', areas }));
}
const liveCards = (struct) => struct.cards.filter(c => c.type !== 'container' && !/^archive$/i.test(c.area || ''));
const archived = (struct) => struct.cards.filter(c => c.type !== 'container' && /^archive$/i.test(c.area || ''));

// ── P1 capture-side: correction-cue supersede is cross-area at 0.4 ───────────
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Strategy', cards: [{ text: STALE }] }] });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: `Runtime: ${CORRECTION}\n#runtime`, area: 'Runtime' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.superseded === 1, `P1 capture: correction-cue supersedes cross-area (superseded=${stats.superseded})`);
    ok(stats.corrections.length === 1 && stats.corrections[0].overlap >= 0.4, 'P1 capture: widened match surfaced in stats.corrections (the confirmation receipt)');
    ok(archived(struct).some(c => /deferred ON PURPOSE/.test(c.text) && /↩/.test(c.text)), 'P1 capture: the stale card is archived with the ↩︎ stamp');
    ok(struct.connections.some(c => c.label === 'superseded by'), 'P1 capture: old→new "superseded by" arrow drawn');
}
// protect: the SAME cross-area decision WITHOUT a correction cue must NOT supersede
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Strategy', cards: [{ text: STALE }] }] });
    const plain = 'Runtime: off-cloud skill/brain execution is now wired, not deferred — the runner executes skills off-cloud since the connectivity arc.\n#runtime';
    const { stats } = await captureIntoBrain(buf, { cards: [{ text: plain, area: 'Runtime' }] });
    ok(stats.superseded === 0, 'protect: a plain cross-area decision still does NOT supersede (same-area 0.6 contract intact)');
}
// protect: same-area heavy overlap still supersedes at 0.6 (no cue needed)
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Auth', cards: [{ text: 'Auth: refresh tokens rotate every 30 days via the session store rotation job.' }] }] });
    const { stats } = await captureIntoBrain(buf, { cards: [{ text: 'Auth: refresh tokens rotate every 7 days via the session store rotation job.\n#auth', area: 'Auth' }] });
    ok(stats.superseded === 1, 'protect: same-area ≥0.6 supersede unchanged');
}

// ── P1 recall-side: similarity alone must never assert correction identity ──
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const stale = struct.cards.find(c => /deferred ON PURPOSE/.test(c.text || ''));
    const overlays = correctionOverlaysFor(struct, [stale]);
    ok(!overlays.has(stale.id), 'P1 recall: an un-edged lexical correction does NOT label the stale-looking card');
    const corr = struct.cards.find(c => /WIRED/.test(c.text || ''));
    ok(!correctionOverlaysFor(struct, [corr]).has(corr.id), 'P1 recall: the correction card itself gets no overlay');
}
// field regressions: shared vocabulary is not claim identity.
{
    const { struct } = await brainWith([
        { title: 'Release', cards: [{ text: 'Release: retrieval benchmark suite ships with the next brain core.' }] },
        { title: 'Canvas', cards: [{ text: 'Canvas: CORRECTION — large pasted images now downscale before decode.' }] },
        { title: 'Settings', cards: [{ text: 'Settings: file-search indexing is enabled for documents.' }] },
        { title: 'Security', cards: [{ text: 'Security: CORRECTION — updater signatures are verified before install.' }] },
    ]);
    const plain = struct.cards.filter(c => /benchmark suite|file-search indexing/.test(c.text || ''));
    ok(correctionOverlaysFor(struct, plain).size === 0, 'P1 precision: unrelated correction-cue cards attach zero overlays');
}
// edge variant: an explicit "superseded by" arrow wins and names the successor
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }, { text: 'Successor: the executor shipped and runs off-cloud skills.' }] },
    ]);
    const stale = struct.cards.find(c => /deferred ON PURPOSE/.test(c.text || ''));
    const succ = struct.cards.find(c => /Successor/.test(c.text || ''));
    struct.connections.push({ fromId: stale.id, toId: succ.id, label: 'superseded by', from: 'a', to: 'b' });
    const ov = correctionOverlaysFor(struct, [stale]).get(stale.id);
    ok(!!ov && ov.kind === 'edge' && ov.by.id === succ.id, 'P1 recall: a superseded-by edge swaps in the successor (kind=edge)');
}
// explicit chains resolve to the latest known truth, not an intermediate stale card
{
    const { struct } = await brainWith([{ title: 'Auth', cards: [
        { text: 'Auth: sessions were stored in redis.' },
        { text: 'Auth: sessions moved from redis to sqlite.' },
        { text: 'Auth: sessions now live in postgres.' },
    ] }]);
    const [redis, sqlite, postgres] = struct.cards.filter(c => c.type !== 'container');
    struct.connections.push(
        { fromId: redis.id, toId: sqlite.id, label: 'superseded by' },
        { fromId: sqlite.id, toId: postgres.id, label: 'superseded by' },
    );
    const ov = correctionOverlaysFor(struct, [redis]).get(redis.id);
    ok(ov?.by?.id === postgres.id, 'P1 recall: an explicit correction chain resolves to its latest successor');
}

// ── P4a: closes: resolves ALL covered twins ───────────────────────────────────
{
    const buf = await buildKlypixMap({
        title: 'brain', areas: [{
            title: 'Open questions', cards: [
                { text: '❓ Agent status is a dead field — remove or wire it?' },
                { text: '❓ agent status dead field — should we wire or drop it?' },
            ],
        }],
    });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: 'Ship: 🏁 wired the agent status field end-to-end closes-test\n#ship', area: 'Ship', closes: 'agent status dead field' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 2, `P4a: closes: resolved BOTH twins (closed=${stats.closed})`);
    ok(archived(struct).filter(c => /status/.test(c.text)).length === 2, 'P4a: both twins archived');
    ok(struct.connections.filter(c => c.label === 'closed by').length === 2, 'P4a: a "closed by" arrow per twin');
}
// protect-list regression: single-target closes: still works exactly as before
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Strategy', cards: [{ text: '❓ v1.2.0 staged as a github draft — when do we flip it live?' }] }] });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: 'Release: 🏁 flipped the draft live\n#release', area: 'Release', closes: 'v1.2.0 staged as a github draft' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 1, 'protect: single-target closes: fires once');
    ok(struct.connections.some(c => c.label === 'closed by'), 'protect: closed-by arrow drawn');
    ok(archived(struct).some(c => /github draft/.test(c.text) && /✅/.test(c.text)), 'protect: closed card stamped ✅ + archived');
}

// ── P4b: rephrased duplicate ❓ merges instead of stacking ────────────────────
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Agent', cards: [{ text: '❓ Agent status is a dead field — remove or wire it?' }] }] });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: 'Agent: ❓ agent status is a dead field — should we wire or drop it?\n#agent', area: 'Agent' }] });
    const { struct } = await parseKlypix(buffer);
    const opens = liveCards(struct).filter(c => /❓/.test(c.text));
    ok(stats.merged === 1 && stats.added === 0, `P4b: duplicate ❓ merged, not added (merged=${stats.merged}, added=${stats.added})`);
    ok(opens.length === 1 && /wire or drop/.test(opens[0].text), 'P4b: ONE open question remains, carrying the newer wording');
}

// ── P3: structural auto-link at capture ───────────────────────────────────────
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Canvas', cards: [{ text: 'Canvas: zKeys must be deduped before REORDER.\n#file-canvasstore' }] }] });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: 'Perf: memoize the connection layer render pass.\n#perf #file-canvasstore', area: 'Perf' }] });
    const { struct } = await parseKlypix(buffer);
    const auto = struct.connections.filter(c => c.label === 'auto');
    ok(auto.length >= 1, `P3: new card auto-linked to its tag-sharing sibling (auto edges=${auto.length})`);
    ok(auto.length <= 2, 'P3: auto edges capped at 2 per card');
    ok(stats.linked >= 1, 'P3: auto links counted in stats.linked');
}

// ── P5/P9: repeat-detector precision ─────────────────────────────────────────
{
    const mk = (id, text, tags, createdAt = Date.now()) => ({ id, type: 'text', text, title: text.split('\n')[0], tags, area: 'Ship', parentId: 'ctn1', createdAt });
    const struct = {
        cards: [
            { id: 'ctn1', type: 'container', title: 'Ship' },
            mk('c1', 'Ship: 🏁 merged PR #850 connectivity arc\n#ship #auto', ['ship', 'auto']),
            mk('c2', 'Ship: 🏁 merged PR #9\n#ship #auto', ['ship', 'auto']),
            mk('c3', 'Release: 🏁 cut release v1.2.0 — connectivity arc best-in-class\n#release #auto', ['release', 'auto']),
            mk('c4', 'Ship: 🏁 per-phase model audit — Flash for tool turns, Claude for synthesis\n#ship', ['ship']),
        ],
        connections: [],
    };
    ok(detectRepeatWork(struct, queryTokens('deploy the release')).length === 0, 'P5: FP "deploy the release" no longer fires (verb stoplist)');
    ok(detectRepeatWork(struct, queryTokens('hand off a report on the connectivity release')).length === 0, 'P5: FP "hand off a report…" no longer fires');
    ok(detectRepeatWork(struct, queryTokens('redo the connectivity arc work')).length === 0, 'P9: #auto card without an entity-token match does not fire');
    const tp = detectRepeatWork(struct, queryTokens('audit which model each phase uses'));
    ok(tp.length === 1 && tp[0].card.id === 'c4', 'P5: TP "audit which model each phase uses" still fires on the hand-written card');
    ok(detectRepeatWork(struct, queryTokens('re-merge PR #850 connectivity arc')).some(r => r.card.id === 'c1'), 'P9: #auto card WITH an entity token (850) still fires');
}

// ── P6: log-length body-score normalization ──────────────────────────────────
{
    const pad = (n) => Array.from({ length: n }, (_, i) => `filler${i}`).join(' ');
    const struct = {
        cards: [
            { id: 's', type: 'text', text: `short card about flumtoken rotation and gronkfield checks ${pad(10)}`, title: 'short', tags: [], area: 'A', createdAt: Date.now() },
            { id: 'l', type: 'text', text: `long card about flumtoken rotation and gronkfield checks ${pad(600)}`, title: 'long', tags: [], area: 'A', createdAt: Date.now() },
        ],
        connections: [],
    };
    const ranked = scoreCardsAgainstQuery(struct, ['flumtoken', 'gronkfield', 'rotation'], { topK: 5, minScore: 0.5 });
    ok(ranked.length === 2 && ranked[0].card.id === 's', 'P6: at equal token coverage the short card outranks the 600-word card');
    ok(ranked[0].score > ranked[1].score, `P6: long card body hits are down-weighted (${ranked[1].score.toFixed(2)} < ${ranked[0].score.toFixed(2)})`);
}

// ── P8: detectContradictions surfaces the known stale pair FIRST ─────────────
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }, { text: 'Strategy: viewer parity roadmap Q3 — comments and follow mode next.' }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const pairs = detectContradictions(struct);
    ok(pairs.length >= 1, `P8: contradiction candidate found (${pairs.length})`);
    ok(pairs[0] && /WIRED/.test(pairs[0].fresh.text) && /deferred ON PURPOSE/.test(pairs[0].stale.text) && pairs[0].why === 'correction-cue',
        'P8: the deferred-vs-CORRECTION pair is the FIRST candidate, correction side = fresh');
    // settled pairs are excluded
    if (pairs[0]) {
        struct.connections.push({ fromId: pairs[0].stale.id, toId: pairs[0].fresh.id, label: 'superseded by' });
        ok(detectContradictions(struct).length === 0, 'P8: a pair settled by a supersede arrow is not re-flagged');
    } else { ok(false, 'P8: a pair settled by a supersede arrow is not re-flagged (skipped — no pair found)'); }
}
// polarity variant (no cue on either side)
{
    const struct = {
        cards: [
            { id: 'p1', type: 'text', text: 'Exporter: the PDF exporter pipeline is broken on rotated strokes and clipped frames.', title: 'a', tags: [], area: 'A', createdAt: 1000 },
            { id: 'p2', type: 'text', text: 'Exporter: the PDF exporter pipeline is fixed for rotated strokes and clipped frames.', title: 'b', tags: [], area: 'B', createdAt: 2000 },
        ],
        connections: [],
    };
    const pairs = detectContradictions(struct);
    ok(pairs.length === 1 && /polarity/.test(pairs[0].why) && pairs[0].fresh.id === 'p2', 'P8: polarity pair (broken↔fixed) detected, later card = fresh');
}

// ── P9: garden dormancy — #auto at 7d, hand-written at 14d ────────────────────
{
    const now = Date.now();
    const day = 86_400_000;
    const kid = (id, ageDays, tags) => ({ id, type: 'text', text: `Ship: 🏁 event ${id}\n#ship${tags.includes('auto') ? ' #auto' : ''}`, title: id, tags, area: 'Ship', parentId: 'ctn', createdAt: now - ageDays * day });
    const cards = [
        { id: 'ctn', type: 'container', title: 'Ship' },
        kid('a1', 8, ['ship', 'auto']), kid('a2', 8, ['ship', 'auto']), kid('a3', 8, ['ship', 'auto']),
        kid('h1', 8, ['ship']),
        ...Array.from({ length: 8 }, (_, i) => kid('new' + i, 1, ['ship'])),
    ];
    const areas = selectGardenCandidates({ cards, connections: [] }, { now });
    ok(areas.length === 1 && areas[0].candidates.length === 3, `P9 garden: three 8-day #auto cards are dormant (got ${areas.length ? areas[0].candidates.length : 0})`);
    ok(areas.length === 1 && !areas[0].candidates.some(c => c.id === 'h1'), 'P9 garden: the same-age hand-written card is NOT dormant (14d bar intact)');
}

// ── P1/P8 long-card reality (verbatim from the AgentLit field brain) ─────────
// This real pair remains a contradiction/reconcile candidate, but without an
// explicit lifecycle edge it must not become an asserted serve-time correction.
{
    const REAL_STALE = `❓ Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 Making file-embedded skills/brain RUN on desktop/CLI (not just travel as data) was the audit's highest-scored play (9/10) and the deepest moat — deferred deliberately because it's a DISTRIBUTION moat and the founder said to ignore distribution for now. Revisit when distribution is back on. Root cause: quickstart.ts InMemoryPersistenceAdapter.getLatestBlueprint (+ desktop/CLI FileAgentPersistence clones) drop blueprint.skills and file.brain; use_skill dead-ends at "Unknown tool" off-cloud. Fix = widen BlueprintRecord + ship portable file-backed use_skill/brain_lookup executors. #strategy`;
    const REAL_CORR = `Runtime: CORRECTION (stale note resolved): off-cloud self-skilling + agent-brain EXECUTION is now WIRED, not deferred. Verified in main 2026-06-24: desktop (artifacts/agentlit-desktop/src/lib/use-agent-runner.ts:197-204) and CLI (artifacts/agentlit-cli/src/index.ts) both register SaveSkillExecutor/UseSkillExecutor (+ BrainRemember/BrainLookup) against the .agent file via TauriAgentFileStore/FileAgentFileStore, with createLlmSkillVerifier(llm) running the SAME verify-before-keep judge on the user's own key. Portable executors live in artifacts/runtime/src/tools/self-skilling.ts. So a desktop/CLI agent LEARNS + REPLAYS skills locally, keys never leaving — on-thesis. The earlier "use_skill dead-ends at Unknown tool off-cloud / EXECUTION deferred" (2026-06-14/16) is OBSOLETE. #runtime`;
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: REAL_STALE }] },
        { title: 'Runtime', cards: [{ text: REAL_CORR }] },
    ]);
    const stale = struct.cards.find(c => /deferred ON PURPOSE/.test(c.text || ''));
    const ov = correctionOverlaysFor(struct, [stale]).get(stale.id);
    ok(!ov, 'P1 field: even a strong real-world lexical pair is proposal-only until explicitly linked');
    const pairs = detectContradictions(struct);
    ok(pairs.length >= 1 && pairs[0] && /is now WIRED/.test(pairs[0].fresh.text), 'P8 field: the REAL pair is the first contradiction candidate');
}

// ── Adversarial-review regressions (1.17.0 review: 21 confirmed findings) ────
// (D) casual lowercase prose must NOT fire the cross-area correction supersede
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Strategy', cards: [{ text: STALE }] }] });
    const casual = 'Runtime: the old approach was wrong — off-cloud skill brain execution is wired now, not deferred like before\n#runtime';
    const { stats } = await captureIntoBrain(buf, { cards: [{ text: casual, area: 'Runtime' }] });
    ok(stats.superseded === 0, 'review-D: lowercase "was wrong" prose does NOT fire the cross-area supersede (uppercase cue only)');
}
// (B) closes: and ✓ must never archive a 🛠 skill
{
    const buf = await buildKlypixMap({
        title: 'brain', areas: [{
            title: 'Agent', cards: [
                { text: '❓ Agent status is a dead field — remove or wire it?' },
                { text: '🛠️ Gotcha: the agent status dead field must never be read before init.' },
            ],
        }],
    });
    const { buffer, stats } = await captureIntoBrain(buf, { cards: [{ text: 'Ship: 🏁 wired the agent status field\n#ship', area: 'Ship', closes: 'agent status dead field' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 1, `review-B: closes: took the ❓ only (closed=${stats.closed})`);
    ok(liveCards(struct).some(c => /🛠/.test(c.text)), 'review-B: the 🛠 skill is still LIVE (never archived by closes:)');
    const { stats: s2, buffer: b2 } = await captureIntoBrain(buffer, { resolutions: [{ area: '', text: 'agent status dead field handled everywhere' }] });
    const { struct: st2 } = await parseKlypix(b2);
    ok(liveCards(st2).some(c => /🛠/.test(c.text)), `review-B: ✓ resolution also leaves the skill live (resolved=${s2.resolved})`);
}
// (C) #auto is provenance, not topic — no auto-edges between unrelated ship cards
{
    const buf = await buildKlypixMap({
        title: 'brain', areas: [
            { title: 'Ship', cards: [{ text: 'Ship: 🏁 merged PR #1\n#ship #auto' }] },
            { title: 'Release', cards: [{ text: 'Release: 🏁 cut release v9.0.0\n#release #auto' }] },
        ],
    });
    const { buffer } = await captureIntoBrain(buf, { cards: [{ text: 'Docs: 🏁 published the handbook\n#docs #auto', area: 'Docs' }] });
    const { struct } = await parseKlypix(buffer);
    ok(struct.connections.filter(c => c.label === 'auto').length === 0, 'review-C: the shared #auto tag draws NO auto-links between unrelated harvested cards');
}
// (G) a too-generic close target collapses to the single best match
{
    const areas = [{ title: 'Sandbox', cards: Array.from({ length: 6 }, (_, i) => ({ text: `sandbox concern ${i} — the runner quota and approval dialog behavior for case ${i}` })) }];
    const buf = await buildKlypixMap({ title: 'brain', areas });
    const { stats } = await captureIntoBrain(buf, { cards: [{ text: 'Ship: 🏁 sandbox hardening pass\n#ship', area: 'Ship', closes: 'sandbox' }] });
    ok(stats.closed === 1, `review-G: a generic 7-char target archives exactly ONE best match, not a 4-card sweep (closed=${stats.closed})`);
}
// (I) polarity matching is word-level: deadline/delivery never flag dead↔live; blocked↔unblocked CAN fire
{
    const struct = {
        cards: [
            { id: 'd1', type: 'text', text: 'Ops: the export deadline for the delivery report is friday with the ops crew handling review', title: 'a', tags: [], area: 'Ops', createdAt: 1000 },
            { id: 'd2', type: 'text', text: 'Ops: the export pipeline is live for the delivery report with the ops crew handling review', title: 'b', tags: [], area: 'Ops', createdAt: 2000 },
            { id: 'b1', type: 'text', text: 'Auth: the signup flow is blocked on the vendor api review process for new tenants', title: 'c', tags: [], area: 'Auth', createdAt: 1000 },
            { id: 'b2', type: 'text', text: 'Auth: the signup flow is unblocked after the vendor api review process for new tenants', title: 'd', tags: [], area: 'Auth', createdAt: 2000 },
        ],
        connections: [],
    };
    const pairs = detectContradictions(struct);
    ok(!pairs.some(p => /deadline|delivery/.test(p.stale.text) && /dead|live/.test(p.why)), 'review-I: deadline/delivery no longer fake a dead↔live polarity pair');
    ok(pairs.some(p => /blocked ↔ unblocked/.test(p.why)), 'review-I: blocked↔unblocked now fires (substring made it impossible before)');
    // (E) a deliberate connection dismisses a POLARITY pair…
    struct.connections.push({ fromId: 'b1', toId: 'b2', relationship: 'relates_to' });
    ok(!detectContradictions(struct).some(p => /blocked/.test(p.why)), 'review-E: a deliberate relates_to edge dismisses the polarity pair (the documented dismissal now works)');
}
// (E') …but a cue pair is NOT dismissed by a mere link — only by retiring the stale card
{
    const { struct } = await brainWith([
        { title: 'Strategy', cards: [{ text: STALE }] },
        { title: 'Runtime', cards: [{ text: CORRECTION }] },
    ]);
    const stale = struct.cards.find(c => /deferred ON PURPOSE/.test(c.text || ''));
    const corr = struct.cards.find(c => /WIRED/.test(c.text || ''));
    struct.connections.push({ fromId: corr.id, toId: stale.id, relationship: 'relates_to' });
    ok(detectContradictions(struct).length === 1, 'review-E: a relates_to link does NOT dismiss a correction-cue pair');
}
// (H) a terse deliberate correction (3 subject tokens after cue-strip) still supersedes
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Config', cards: [{ text: 'Config: the vault default resolution uses the global folder setting always for brains' }] }] });
    const { stats } = await captureIntoBrain(buf, { cards: [{ text: 'Runtime: CORRECTION: the vault default resolution was WRONG — use cwd\n#runtime', area: 'Runtime' }] });
    ok(stats.superseded === 1, `review-H: a terse correction (3 subject tokens) fires the supersede (superseded=${stats.superseded})`);
}

// ── P8 at the tool level: opBrainReconcile mode='contradictions' ─────────────
{
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { opBrainReconcile } = await import('../src/klypix-core.mjs');
    const vault = path.join(os.tmpdir(), 'klypix-quality-reconcile-vault');
    fs.rmSync(vault, { recursive: true, force: true });
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Strategy', cards: [{ text: STALE }] },
            { title: 'Runtime', cards: [{ text: CORRECTION }] },
        ],
    }));
    const r = await opBrainReconcile({ vault, mode: 'contradictions' });
    const txt = (r.blocks || []).map(b => b.text || '').join('\n');
    ok(/⚔️ 1 contradiction candidate/.test(txt), 'P8 tool: brain_reconcile mode=contradictions surfaces the pair');
    ok(/likely STALE\s+\[Strategy\]/.test(txt) && /likely CURRENT\s+\[Runtime\]/.test(txt), 'P8 tool: stale/current sides labeled with their areas');
    const rAll = await opBrainReconcile({ vault, mode: 'all' });
    const txtAll = (rAll.blocks || []).map(b => b.text || '').join('\n');
    ok(/⚔️/.test(txtAll), 'P8 tool: default mode=all includes the contradictions pass');
    ok(!/<ISERROR>/.test(txtAll) && !rAll.isError, 'P8 tool: mode=all with no migrations dir is not an error');
    fs.rmSync(vault, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brain-quality: all assertions passed');
process.exit(failures ? 1 : 0);
