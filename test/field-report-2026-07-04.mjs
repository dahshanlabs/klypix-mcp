// Acceptance suite for the 2026-07-04 AgentLit heavy-usage field report — the five
// product findings that heavy real-world usage exposed, each proven at the seam it
// was fixed:
//   F1 open-question DATE decay — an overdue-dated ❓ is flagged in the brief.
//   F2 "awaits merge" drift     — a "PR #N awaits merge" card gets a merged-overlay
//                                 once a ship event records #N MERGED.
//   F3 cue-pair dismiss         — a false correction-cue contradiction is dismissed
//                                 forever via a not_contradiction edge.
//   F4 legacy raw-bash ship     — pre-v1.15 auto-capture residue is excluded from
//                                 repeat-matching (and surfaced for cleanup).
//   F5 session dedup            — a >1KB card never lands full-text twice in one
//                                 session (survives the injected-ledger eviction),
//                                 and a duplicate peer message shows once.
//
// F1-F4 are pure-engine tests; F5 drives the REAL --prompt hook end-to-end.
// Run:  node test/field-report-2026-07-04.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
    buildKlypixMap, parseKlypix,
    findOverdueOpenCards, parseDeadline, structToBrief, structToUltraBrief,
    mergeOverlaysFor,
    detectContradictions, addBrainConnections,
    isLegacyRawShipCard, findLegacyShipCards, detectRepeatWork,
} from '../src/klypix-format.mjs';
// (detectContradictions + mergeOverlaysFor reused across the F2/F4 precision cases below)

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const liveCards = (struct) => struct.cards.filter(c => c.type !== 'container' && !/^archive$/i.test(c.area || ''));
const NOW = Date.parse('2026-07-04T12:00:00Z');
const DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// F1 — overdue open-question date awareness
// ─────────────────────────────────────────────────────────────────────────────
{
    ok(parseDeadline('Rotate NPM_TOKEN before ~2026-07-03').date === '2026-07-03', 'F1 parse: a cue-anchored deadline ("before ~2026-07-03") is read');
    ok(parseDeadline('Shipped the feature on 2026-06-30 — all good') === null, 'F1 parse: a bare non-deadline date is NOT treated as a deadline (no false overdue)');

    const buf = await buildKlypixMap({
        title: 'brain', areas: [{
            title: 'Ops', cards: [
                { text: '❓ Rotate NPM_TOKEN before ~2026-07-03 — the publish token expires.' },
                { text: '❓ Decide the caching TTL by 2026-12-01 before the winter launch.' },
                { text: '❓ Should search be MCP-only or an A2A skill too?' },
            ],
        }],
    });
    const { struct } = await parseKlypix(buf);
    // stamp createdAt in the past so the cards are "live and aging", not future.
    for (const c of liveCards(struct)) c.createdAt = Date.parse('2026-06-20T00:00:00Z');
    const { overdue, total } = findOverdueOpenCards(struct, { now: NOW });
    ok(total === 1 && /NPM_TOKEN/.test(overdue[0].card.text), 'F1 finder: exactly the past-deadline ❓ is overdue (future/dateless ones are not)');
    ok(overdue[0].daysOverdue === 1, 'F1 finder: daysOverdue is computed from the deadline (1d past 2026-07-03 @ NOW 2026-07-04)');

    // The acceptance criterion: an overdue-dated ❓ is FLAGGED in the next brief.
    // (structToBrief uses real Date.now(); 2026-07-03 is already in the past at run time.)
    const brief = structToBrief(struct);
    ok(/⏰ OVERDUE/.test(brief) && /NPM_TOKEN/.test(brief), 'F1 brief: the overdue ❓ carries a ⏰ OVERDUE badge in the full brief');
    const ultra = structToUltraBrief(struct);
    ok(/⏰/.test(ultra), 'F1 ultra brief: the overdue ❓ is flagged in the preview tier too');
}

// ─────────────────────────────────────────────────────────────────────────────
// F2 — "awaits merge" → merged-overlay from a harvested ship event
// ─────────────────────────────────────────────────────────────────────────────
{
    const buf = await buildKlypixMap({
        title: 'brain', areas: [
            { title: 'Roadmap', cards: [
                { text: 'Roadmap: PR #7 awaits founder merge — the folder-lens change is code-complete.' },
                { text: 'Roadmap: PR #9 awaits founder merge — still open, no ship yet.' },
            ] },
            { title: 'Ship', cards: [{ text: 'Ship: 🏁 merged PR #7\n#ship #auto' }] },
        ],
    });
    const { struct } = await parseKlypix(buf);
    const cards = liveCards(struct);
    const awaiting7 = cards.find(c => /PR #7 awaits/.test(c.text));
    const awaiting9 = cards.find(c => /PR #9 awaits/.test(c.text));
    const mergeCard = cards.find(c => /merged PR #7/.test(c.text));
    const ov = mergeOverlaysFor(struct, cards);
    ok(ov.has(awaiting7.id) && ov.get(awaiting7.id).num === '7', 'F2: "PR #7 awaits merge" gets a merged-overlay from the harvested ship event');
    ok(!ov.has(awaiting9.id), 'F2: "PR #9 awaits merge" (no ship event) gets NO overlay');
    ok(!ov.has(mergeCard.id), 'F2: the merge ship card itself is not overlaid');
}
// F2 precision (2026-07-04 field): the cue must be ADJACENT to the PR ref, so a card
// that only cites #N as an example (with an unrelated "awaits merge" elsewhere) does
// NOT over-trigger.
{
    const buf = await buildKlypixMap({ title: 'brain', areas: [
        { title: 'Notes', cards: [{ text: 'Notes: we copied the retry pattern from PR #7 (a good example). Unrelatedly, the whole epic still awaits a merge window next sprint.' }] },
        { title: 'Ship', cards: [{ text: 'Ship: 🏁 merged PR #7\n#ship #auto' }] },
    ] });
    const { struct } = await parseKlypix(buf);
    const cards = liveCards(struct);
    const exampleCard = cards.find(c => /example/.test(c.text));
    ok(!mergeOverlaysFor(struct, cards).has(exampleCard.id), 'F2 precision: a card citing #7 only as an EXAMPLE (awaits-cue far from the ref) is NOT overlaid');

    const buf2 = await buildKlypixMap({ title: 'brain', areas: [
        { title: 'Roadmap', cards: [{ text: 'Roadmap: the folder-lens work is code-complete; PR #7 awaits founder merge.' }] },
        { title: 'Ship', cards: [{ text: 'Ship: 🏁 merged PR #7\n#ship #auto' }] },
    ] });
    const { struct: s2 } = await parseKlypix(buf2);
    const c2 = liveCards(s2);
    const adj = c2.find(c => /folder-lens/.test(c.text));
    ok(mergeOverlaysFor(s2, c2).has(adj.id), 'F2 precision: "PR #7 awaits founder merge" (cue adjacent to the ref) STILL fires');
}

// ─────────────────────────────────────────────────────────────────────────────
// F3 — correction-cue false positive is dismissible (persisted) via not_contradiction
// ─────────────────────────────────────────────────────────────────────────────
{
    // Two live cards that share heavy vocabulary but do NOT truly contradict — one
    // carries a CORRECTION cue, so detectContradictions flags a correction-cue pair
    // (the observed false positive). There is no stale card to retire, so the ONLY
    // way to clear it is a deliberate dismissal.
    const A = 'CORRECTION: the settings panel tab naming now uses the canonical label map, not the legacy inline strings scattered across the header components and dropdown menus.';
    const B = 'The settings panel tab naming label map loads from the header components and dropdown menus, kept alongside the canonical inline strings for legacy compatibility.';
    const buf = await buildKlypixMap({ title: 'brain', areas: [
        { title: 'UI', cards: [{ text: A }] },
        { title: 'UX', cards: [{ text: B }] },
    ] });
    const { struct } = await parseKlypix(buf);
    const pairs = detectContradictions(struct);
    ok(pairs.length === 1 && pairs[0].why === 'correction-cue', 'F3: the correction-cue false positive is flagged as a contradiction candidate');

    // Dismiss it: draw a not_contradiction edge between the two cards, then re-check.
    const [a, b] = liveCards(struct);
    const { buffer, added } = await addBrainConnections(buf, [{ fromId: a.id, toId: b.id, relationship: 'not_contradiction' }]);
    ok(added === 1, 'F3: a not_contradiction edge is accepted (relationship is in the allowed set)');
    const { struct: struct2 } = await parseKlypix(buffer);
    ok(struct2.connections.some(c => c.relationship === 'not_contradiction'), 'F3: the dismissal edge persists in the brain');
    const pairs2 = detectContradictions(struct2);
    ok(pairs2.length === 0, 'F3: the dismissed cue pair never reappears in reconcile output (the acceptance criterion)');
}

// ─────────────────────────────────────────────────────────────────────────────
// F4 — legacy raw-bash ship cards excluded from repeat-matching + surfaced
// ─────────────────────────────────────────────────────────────────────────────
{
    ok(isLegacyRawShipCard('Ship: 🏁 merged PR #850 — auto-captured (`cd /c/Users/foo/8db42`)') === true, 'F4 detect: an "auto-captured (`cd …`)" ship card is legacy');
    ok(isLegacyRawShipCard('Release: 🏁 merged PR #238886') === true, 'F4 detect: a 6+ digit "PR #238886" (path-scraped) is legacy');
    ok(isLegacyRawShipCard('Ship: 🏁 merged PR #286') === false, 'F4 detect: a CLEAN "merged PR #286" is NOT legacy');
    ok(isLegacyRawShipCard('Release: 🏁 published to npm klypix-mcp 1.19.0') === false, 'F4 detect: a clean release card is NOT legacy');

    // A legacy card and a CLEAN card that both match the same query — only the clean
    // one may be offered as a repeat candidate. (Proves the guard, not just scoring.)
    const legacy = 'Deploy: 🏁 installer-pipeline merged PR #238886 — auto-captured (`gh pr merge`) for the agentmug-installer rollout\n#deploy #installer';
    const clean = 'Deploy: 🏁 installer-pipeline shipped the agentmug-installer rollout end to end\n#deploy #installer';
    const query = ['installer-pipeline', 'agentmug-installer', 'rollout'];

    const legacyOnly = await parseKlypix(await buildKlypixMap({ title: 'brain', areas: [{ title: 'Deploy', cards: [{ text: legacy }] }] }));
    ok(detectRepeatWork(legacyOnly.struct, query).length === 0, 'F4 repeat: a legacy raw-bash ship card is NEVER offered as a repeat candidate');

    const cleanOnly = await parseKlypix(await buildKlypixMap({ title: 'brain', areas: [{ title: 'Deploy', cards: [{ text: clean }] }] }));
    ok(detectRepeatWork(cleanOnly.struct, query).length === 1, 'F4 repeat: a CLEAN ship card with the same tokens IS still offered (guard is signature-based, not blanket)');

    const both = await parseKlypix(await buildKlypixMap({ title: 'brain', areas: [{ title: 'Deploy', cards: [{ text: legacy }, { text: clean }] }] }));
    const { total } = findLegacyShipCards(both.struct);
    ok(total === 1, 'F4 cleanup: findLegacyShipCards surfaces the legacy card (and only it) for one-time tidy');

    // F4 completeness (2026-07-04 field): legacy cards poison RECONCILE too — a legacy
    // raw-bash card sharing heavy vocab with a CORRECTION card must not become a
    // contradiction candidate.
    const corr = 'CORRECTION: the installer-pipeline rollout for agentmug now uses the signed artifact, not the auto-captured merge path scattered across the deploy scripts.';
    const legacyDupe = 'Deploy: 🏁 merged PR #238886 — auto-captured (`cd /c/Users/x/agentmug`) installer-pipeline rollout deploy path scattered across scripts\n#deploy';
    const recon = await parseKlypix(await buildKlypixMap({ title: 'brain', areas: [
        { title: 'Ops', cards: [{ text: corr }] },
        { title: 'Deploy', cards: [{ text: legacyDupe }] },
    ] }));
    ok(detectContradictions(recon.struct).length === 0, 'F4 reconcile: a legacy raw-bash ship card is excluded from contradiction candidates (no reconcile poison)');
}

// ─────────────────────────────────────────────────────────────────────────────
// F5 — session dedup: a >1KB card never full-text twice (E2E through the real hook)
// ─────────────────────────────────────────────────────────────────────────────
{
    const tag = 'f5';
    const home = path.join(os.tmpdir(), 'klypix-fr-home-' + tag);
    const proj = path.join(os.tmpdir(), 'klypix-fr-proj-' + tag);
    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
    const brainHome = path.join(home, '.claude', 'project-brain');
    fs.mkdirSync(brainHome, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '9.9.9', checkedAt: Date.now() }));

    // A BIG (>1KB) card whose SENTINEL sits well past the 110-char headline cut, so
    // it appears ONLY when the card is injected full-text.
    const SENTINEL = 'ZZUNIQUEENDSENTINELZZ';
    const filler = 'the widget-pipeline-config coordinates the batching stages and retry budget across the render tiers. '.repeat(14);
    const bigText = `WidgetArea: widget-pipeline-config is the central batching config for the render pipeline. ${filler} Final note: ${SENTINEL}.`;
    fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: [{ title: 'WidgetArea', cards: [{ text: bigText }] }] }));

    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    const runPrompt = (prompt) => execFileSync(process.execPath, [HOOK, '--prompt'], {
        cwd: proj, env, encoding: 'utf8',
        input: JSON.stringify({ session_id: 'sess-' + tag, prompt }),
    });

    const q = 'tell me about the widget-pipeline-config batching';
    const run1 = runPrompt(q);
    ok(run1.includes(SENTINEL), 'F5a run 1: the big card is injected full-text the first time (sentinel present)');
    ok(bigText.replace(/\s+/g, ' ').length > 1000, 'F5a: the fixture card is genuinely >1KB');

    // Simulate a long session: EVICT the big card from the 100-cap `injected` set
    // (fill it with dummies) but keep it in `injectedBig`. The sticky big-ledger must
    // still collapse it — this is the exact eviction the 3× full-text bug hit.
    const sessionsDir = path.join(brainHome, 'sessions');
    const laneFile = fs.readdirSync(sessionsDir).map(f => path.join(sessionsDir, f)).find(f => f.endsWith('.json'));
    ok(!!laneFile, 'F5a: the hook wrote a coordination lane on run 1');
    const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
    const meSess = lane.sessions.find(s => s.id === 'sess-' + tag);
    const bigId = (meSess.injectedBig || [])[0];
    ok(!!bigId, 'F5a: the big card id was recorded in the sticky injectedBig ledger');
    meSess.injected = Array.from({ length: 100 }, (_, i) => 'txt_dummy' + i);   // evict bigId from the 100-cap set
    // add a duplicate peer message (two ids, identical text) from ANOTHER session
    const DUP = 'heads up: rebasing master now, hold your push';
    lane.messages = [
        { id: 'm1', from: 'peerAAAA', to: 'all', text: DUP, ts: Date.now(), seen: [] },
        { id: 'm2', from: 'peerBBBB', to: 'all', text: DUP, ts: Date.now(), seen: [] },
        { id: 'm3', from: 'peerCCCC', to: 'all', text: 'Edit src/API.ts before release', ts: Date.now(), seen: [] },
        { id: 'm4', from: 'peerDDDD', to: 'all', text: 'Edit src/api.ts before release', ts: Date.now(), seen: [] },
    ];
    fs.writeFileSync(laneFile, JSON.stringify(lane));

    const run2 = runPrompt(q);
    ok(!run2.includes(SENTINEL), 'F5a run 2: the big card is NOT re-injected full-text after injected-ledger eviction (sticky big-ledger collapses it)');
    ok(/already shown this session/.test(run2), 'F5a run 2: the big card renders as a "(already shown this session)" headline');
    const dupCount = run2.split(DUP).length - 1;
    ok(dupCount === 1, `F5b: a duplicate peer message text appears exactly once in one injection (saw ${dupCount})`);
    ok(run2.includes('peerAAAA') && run2.includes('peerBBBB'),
      'F5b: the one grouped instruction preserves attribution to both sending sessions');
    ok(run2.includes('message_id `m1`') && run2.includes('message_id `m2`'),
      'F5b: every grouped duplicate exposes its own explicitly consumable receipt id');
    ok(run2.includes('Edit src/API.ts before release') && run2.includes('Edit src/api.ts before release'),
      'F5b: the real hook preserves case-distinct path instructions while grouping exact duplicates');

    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ field-report-2026-07-04: all assertions passed');
process.exit(failures ? 1 : 0);
