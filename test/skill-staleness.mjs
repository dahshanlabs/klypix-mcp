// 🛠️↔🏁 obsolescence (2026-08-01 field incident): a skill encoding a TEMPORARY
// limitation ("Chat has no tools") outlived the same-day milestone that removed
// it, kept its every-session resurfacing + ranking boost, and an agent asserted
// the dead limitation to the founder as current fact. These tests cover the
// extractor's precision gate (state claims yes, imperative advice never), the
// serve-time overlay in rankForQuestion, the capture-time receipt + persisted
// edge, the brief suffix, the dismissal path, and the closes: title-only
// retirement — including a faithful reproduction of the incident pair.
import {
    extractLimitationClaims, findSkillObsolescenceCandidates, obsolescenceOverlaysFor, formatCaptureReceipts,
    rankForQuestion, questionContextToMarkdown, structToBrief,
    buildKlypix, buildKlypixMap, parseKlypix, captureIntoBrain,
} from '../src/klypix-format.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}`); } };

// ── extractLimitationClaims — the precision gate ─────────────────────────────
// The REAL incident skill text (trimmed): a state claim inside a 🛠️.
const INCIDENT_SKILL = 'chat: 🛠️ stop chat from fabricating file/folder listings Chat (Gemini Flash) has no tools, but the system prompt claimed it could read the user\'s open files and documents -- so when asked to list Desktop/Downloads it invented a plausible but entirely fake listing instead of admitting it can\'t.';
{
    const claims = extractLimitationClaims(INCIDENT_SKILL);
    ok(claims.length >= 1, 'incident skill: state claim extracted');
    ok(claims.length && /has no tools/i.test(claims[0].clause), 'incident skill: the claim is the "has no tools" sentence');
}
ok(extractLimitationClaims('🛠️ never set backgroundThrottling:false — it breaks on-screen visibility detection').length === 0,
    'imperative advice ("never set X") is NOT a state claim');
ok(extractLimitationClaims('🛠️ always dedup zKeys before permuting; duplicates silently no-op').length === 0,
    'imperative advice ("always dedup") is NOT a state claim');
ok(extractLimitationClaims('🛠️ the exporter does not support rotated strokes on legacy files — flatten first before exporting anything').length === 1,
    '"does not support X" IS a state claim');
ok(extractLimitationClaims('🛠️ the chat dropdown returns mock streams for every non-Gemini model right now').length === 1,
    '"returns mock" IS a state claim');
ok(extractLimitationClaims('🛠️ cross-machine presence is not implemented — the lane is a file in the home directory').length === 1,
    '"not implemented" IS a state claim');
ok(extractLimitationClaims('short no').length === 0, 'tiny fragments never qualify');

// ── findSkillObsolescenceCandidates — the incident, end to end ───────────────
const mkStruct = (cards, connections = []) => ({ cards, connections, counts: { cards: cards.length, connections: connections.length }, title: 't', format: 'klypix-v4' });
const D0 = Date.parse('2026-07-17T08:00:00Z');
// The REAL fix milestone (trimmed) — landed the SAME DAY, hours later.
const INCIDENT_MILE = { id: 'm1', type: 'text', area: 'Chat', createdAt: D0 + 4 * 3600_000, text: 'chat: 🏁 native tool-use in chat -- list_directory Chat can now actually LIST A FOLDER inline instead of hallucinating a fake listing or bouncing the user to Agent mode. First read-only tool via Gemini function-calling in src/api/gemini.ts.' };
const skillCard = { id: 's1', type: 'text', area: 'Chat', createdAt: D0, text: INCIDENT_SKILL };
{
    const cands = findSkillObsolescenceCandidates(mkStruct([skillCard, INCIDENT_MILE]), [INCIDENT_MILE]);
    ok(cands.length === 1, 'incident: the tool-use milestone flags the has-no-tools skill');
    ok(cands.length && cands[0].skill.id === 's1' && /has no tools/i.test(cands[0].clause), 'incident: receipt names the skill and the dead clause');
}
{
    // ORDER GUARD: a rule written AFTER the ship is post-fix knowledge, never stale.
    const lateSkill = { ...skillCard, id: 's2', createdAt: D0 + 8 * 3600_000 };
    ok(findSkillObsolescenceCandidates(mkStruct([lateSkill, INCIDENT_MILE]), [INCIDENT_MILE]).length === 0,
        'a skill created after the milestone is never flagged');
}
{
    // DISMISSAL: a human not_fulfilled edge silences the pair forever.
    const conn = { id: 'c1', fromId: 's1', toId: 'm1', relationship: 'not_fulfilled' };
    ok(findSkillObsolescenceCandidates(mkStruct([skillCard, INCIDENT_MILE], [conn]), [INCIDENT_MILE]).length === 0,
        'not_fulfilled dismissal suppresses the candidate');
}
{
    // EVERGREEN GUARD: advice-only skills can never be flagged by ANY milestone.
    const advice = { id: 's3', type: 'text', area: 'Canvas', createdAt: D0, text: '🛠️ never white-stroke selected items — boost width/opacity instead so palette picks stay visible' };
    const mile = { id: 'm2', type: 'text', area: 'Canvas', createdAt: D0 + 1000, text: 'canvas: 🏁 selected items now boost width and opacity; white-stroke path fully removed from the palette' };
    ok(findSkillObsolescenceCandidates(mkStruct([advice, mile]), [mile]).length === 0,
        'an advice-only skill produces no candidates even under heavy overlap');
}

// ── serve-time: rankForQuestion carries the overlay into the answer ──────────
{
    const struct = mkStruct([skillCard, INCIDENT_MILE]);
    const { hits } = rankForQuestion(struct, 'does chat have tools — can chat act or is it talk only?', { k: 6 });
    const sh = hits.find(h => h.card.id === 's1');
    ok(!!sh, 'serve: the limitation skill ranks for the limitation-phrased question');
    ok(sh && sh.obsolescence && sh.obsolescence.byId === 'm1', 'serve: the skill hit carries the obsolescence overlay naming the fix');
    const md = questionContextToMarkdown('does chat have tools?', { hits, total: hits.length }, { mode: 'lexical' });
    ok(/RULE MAY BE OBSOLETE/.test(md), 'serve: markdown renders the RULE MAY BE OBSOLETE hedge');
    ok(/trust the newer card/i.test(md), 'serve: the hedge instructs trusting the newer card for current capability');
}
{
    // Persisted-edge path: overlay applies even when the milestone missed the hit set.
    const conn = { id: 'c2', fromId: 's1', toId: 'm1', label: 'may obsolete' };
    const struct = mkStruct([skillCard, INCIDENT_MILE], [conn]);
    const map = obsolescenceOverlaysFor(struct, [skillCard]);
    ok(map.has('s1') && map.get('s1').unconfirmed === true, 'persisted machine edge reads back as a hedged overlay');
}

// ── brief: the skills tier carries the staleness suffix ──────────────────────
{
    const struct = mkStruct([skillCard, INCIDENT_MILE]);
    const brief = structToBrief(struct);
    ok(/a newer 🏁 may have removed this limitation/.test(brief), 'brief: flagged skill carries the ⚠️ suffix');
}
{
    const advice = { id: 's3', type: 'text', area: 'Canvas', createdAt: D0, text: '🛠️ never white-stroke selected items — boost width/opacity instead' };
    const brief = structToBrief(mkStruct([advice, INCIDENT_MILE]));
    ok(!/a newer 🏁 may have removed this limitation/.test(brief), 'brief: evergreen advice stays unflagged');
}

// ── capture-time: receipt + persisted edge, and the skill survives ───────────
{
    const buf = await buildKlypixMap({
        title: 'brain',
        areas: [{ title: 'Chat', cards: [{ text: INCIDENT_SKILL, createdAt: D0 }] }],
    });
    const res = await captureIntoBrain(buf, { cards: [{ text: 'Chat: 🏁 native tool-use in chat shipped — list_directory via Gemini function-calling; chat can now list a folder inline with real tools', area: 'Chat' }] });
    ok(Array.isArray(res.stats.skillStale) && res.stats.skillStale.length >= 1, 'capture: 🏁 over a live limitation-skill raises a skillStale receipt');
    ok(res.stats.skillStale.length && /~/.test(res.stats.skillStale[0].marker), 'capture: the receipt carries a ready-to-fill ~ amendment');
    const { struct } = await parseKlypix(res.buffer);
    const skill = struct.cards.find(c => /has no tools/i.test(c.text || ''));
    ok(skill && !/^archive$/i.test(skill.area || ''), 'capture: the skill was NOT archived (retirement stays human)');
    // The incident pair is ANCHOR-grade (cov 0.44) — and anchor-grade rides the
    // receipt ONLY, mirroring T6: persisting a guess promotes it toward settled
    // truth, so only coverage-grade earns an edge (1.43.0 design, kept).
    ok(!(struct.connections || []).some(cn => cn.label === 'may obsolete'), 'capture: anchor-grade never persists an edge (receipt only)');
}
{
    // COVERAGE-grade pair → the dashed amber edge IS persisted.
    const buf = await buildKlypixMap({
        title: 'brain',
        areas: [{ title: 'Export', cards: [{ text: '🛠️ the exporter does not support rotated strokes on legacy canvases — flatten before exporting', createdAt: D0 }] }],
    });
    const res = await captureIntoBrain(buf, { cards: [{ text: 'Export: 🏁 exporter now ships rotated strokes support on legacy canvases end to end — no flatten step needed', area: 'Export' }] });
    ok(res.stats.skillStale.length >= 1 && !res.stats.skillStale[0].via, 'capture: tight clause reaches coverage grade');
    const { struct } = await parseKlypix(res.buffer);
    const edge = (struct.connections || []).find(cn => cn.label === 'may obsolete');
    ok(!!edge, 'capture: coverage-grade pair persists the dashed may-obsolete edge');
    const skill = struct.cards.find(c => /does not support rotated/i.test(c.text || ''));
    ok(skill && !/^archive$/i.test(skill.area || ''), 'capture: coverage-grade still never archives the skill');
}

// ── closes: retires a skill ONLY by title naming, never by token sweep ───────
{
    // buildKlypixMap derives a card's title from its text, so the "name" a human
    // would use is a substring of that derived title.
    const buf = await buildKlypixMap({
        title: 'brain',
        areas: [{ title: 'Chat', cards: [{ text: INCIDENT_SKILL, createdAt: D0 }] }],
    });
    // Token-overlap closes (no title match) must NOT touch the skill.
    const swept = await captureIntoBrain(buf, { cards: [{ text: 'Chat: 🏁 chat listings shipped for folders', area: 'Chat', closes: 'chat fake folder listing tools prompt' }] });
    ok(swept.stats.closed === 0, 'closes: token overlap alone never archives a 🛠️');
    // Naming it (a ≥10-char span of its title) IS the deliberate human act — it archives.
    const named = await captureIntoBrain(buf, { cards: [{ text: 'Chat: 🏁 chat tools shipped; rule retired deliberately', area: 'Chat', closes: 'stop chat from fabricating' }] });
    ok(named.stats.closed === 1, 'closes: naming the skill title retires it');
}


// ── 1.45.1: cues from the FIRST real-world miss (the presence-bugs card) ─────
// The day after 1.45.0 shipped, the 🛠️ "Two SILENT presence bugs" card kept
// reading as settled law a full session after ab10688 fixed all three claims —
// because "compares hostPid ALONE", "only lowercases+slash-normalizes" and
// "indistinguishable from success" matched no cue. Each addition is anchored
// to this incident; the advice-guard fixtures prove precision survived.
const PRESENCE_SKILL = 'Brain: 🛠️ Two SILENT presence bugs: isSuspectedTwin compares hostPid ALONE, so two unrelated sessions suppress each other. normalizeFileKey only lowercases and slash-normalizes, so an absolute and a relative declaration never match and the overlap warning silently misses. upsertSession returns listActiveSessions on lock failure, making a dropped heartbeat indistinguishable from success.';
{
    const claims = extractLimitationClaims(PRESENCE_SKILL);
    ok(claims.length >= 2, `presence miss: state claims now extract (got ${claims.length})`);
    ok(claims.some(c => /hostpid alone/i.test(c.clause)), 'presence miss: "compares hostPid ALONE" is a claim');
    ok(claims.some(c => /silently misses|only lowercases/i.test(c.clause)), 'presence miss: the normalizeFileKey claim extracts');
}
{
    const skill = { id: 'ps1', type: 'text', area: 'Brain', createdAt: D0, text: PRESENCE_SKILL };
    const fix = { id: 'pm1', type: 'text', area: 'Brain', createdAt: D0 + 1000, text: 'Brain: 🏁 presence hardening shipped — normalizeFileKey folds absolute and relative declarations onto one key via the session root, isSuspectedTwin requires machine and client agreement beyond hostPid, and a lane lock failure returns an explicit lane-locked verdict instead of success.' };
    const cands = findSkillObsolescenceCandidates(mkStruct([skill, fix]), [fix]);
    ok(cands.length >= 1, 'presence miss: the hardening milestone now flags the stale presence skill');
}
// Precision re-checks: evergreen advice with adjacent vocabulary stays silent.
ok(extractLimitationClaims('🛠️ NEVER put an absolute path in a committed .mcp.json — a container rewrites it and the breakage is silent').length === 0,
    'advice with "silent" vocabulary is still not a state claim');
ok(extractLimitationClaims('🛠️ always dedup zKeys before permuting; duplicates silently no-op').length === 0,
    '"silently no-op" advice stays unflagged (no-op is not in the cue verbs)');

// ── formatCaptureReceipts — host-neutral parity (MCP + CLI = the hook) ───────
{
    const stats = {
        fulfillCandidates: [{ item: 'wire the caps handshake', cov: 0.7, uncovered: ['ship build 7'], marker: null }],
        skillStale: [{ skill: 'the exporter does not support rotated strokes', clause: 'does not support rotated strokes', cov: 0.8, marker: '🧠 BRAIN [Export] ~: exporter — CORRECTION: <what this ship changed>' }],
    };
    const lines = formatCaptureReceipts(stats);
    ok(lines.length === 2, 'receipts: one line per candidate class');
    ok(/likely fulfilled/.test(lines[0]) && /does NOT cover/.test(lines[0]), 'receipts: fulfillment line carries the uncovered remainder');
    ok(/rule may be obsolete/.test(lines[1]) && /~/.test(lines[1]), 'receipts: staleness line carries the ~ amendment');
    ok(formatCaptureReceipts({}).length === 0, 'receipts: empty stats → no lines');
}

console.log(`
${fail ? '❌' : '✅'} skill-staleness: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
