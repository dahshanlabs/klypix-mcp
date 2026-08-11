// Finding routing — a verified problem reaches whoever owns it.
//
// The incident that produced this lane (2026-08-01): an 8-agent documentation
// audit found four real defects in OTHER sessions' lanes, and all four reached
// their owners only because the founder happened to say "message them". The
// brain detected collisions; it had no notion of routing a FINDING to an owner.
//
// Three layers, and this file proves the two that are new:
//   • ROUTE   — src/finding-routing.mjs, a PURE module (crypto only). Table-driven:
//               given a lane snapshot + a finding, assert the chosen owner AND the
//               stated reason, including every case that must route to NOBODY.
//   • DELIVER — the draft render + the receipt (message.seen, which the lane has
//               always recorded and nothing ever showed).
// Plus R1–R8 from the founder's failure matrix, and a STRUCTURAL assertion that
// the routing path imports no brain-write API and no network.
//
// Run:  node test/finding-routing.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ROUTE_CONFIDENCE_FLOOR,
  ROUTE_FRESH_MS,
  buildFindingDrafts,
  classifyFinding,
  extractArtifactRefs,
  findingKey,
  mergeFindingDrafts,
  normalizeFileKey,
  pendingFindingDrafts,
  renderFindingDrafts,
  renderReceipt,
  renderReceiptSummary,
  routeFinding,
  routingCandidates,
  summarizeReceipts,
} from '../src/finding-routing.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const NOW = 1_760_000_000_000;
const fresh = (extra = {}) => ({ lastSeen: NOW - 30_000, startedAt: NOW - 600_000, branch: 'master', client: 'claude-code', ...extra });

// ── 0. Routing and exact-overlap detection agree on what a path IS ─────────
// The router decides ownership from a peer's declared `files`; findPresenceConflicts
// decides overlap from the same field with its OWN private normalizer. If the two
// ever disagree, a file a peer demonstrably "owns" (the overlap warning fires) is
// invisible to routing — a route that silently never happens, and a missing
// warning is invisible by construction. This asserts BEHAVIOURAL equivalence
// through the public surface, so it holds no matter how either side is written.
{
  const table = [
    ['src/Foo.ts', null, 'src/foo.ts'],
    ['src\\canvas\\Bar.tsx', null, 'src/canvas/bar.tsx'],
    ['./docs/A.md', null, 'docs/a.md'],
    ['E:/repo/src/Foo.ts', 'E:/repo', 'src/foo.ts'],
    ['E:\\repo\\src\\Foo.ts', 'E:/repo/', 'src/foo.ts'],
    ['/other/src/Foo.ts', 'E:/repo', '/other/src/foo.ts'],
    ['', null, ''],
  ];
  let same = true;
  for (const [input, root, expected] of table) {
    if (normalizeFileKey(input, root) !== expected) { same = false; console.log(`   ↳ ${input} (${root}) → ${normalizeFileKey(input, root)} ≠ ${expected}`); }
  }
  ok(same, '0.1: the router normalizes every path-shape row to the documented key');

  const { findPresenceConflicts } = await import('../src/mcp-presence.mjs');
  let agree = true;
  for (const [variant, root] of table) {
    if (!variant) continue;
    const canonical = 'src/Foo.ts';
    const sessions = [
      { id: 'me', ...fresh(), cwd: root || undefined, files: [canonical] },
      { id: 'peer', ...fresh(), cwd: root || undefined, files: [variant] },
    ];
    const overlapFires = findPresenceConflicts(sessions, 'me', { projectRoot: root || undefined }).length > 0;
    const routerMatches = normalizeFileKey(variant, root) === normalizeFileKey(canonical, root);
    if (overlapFires !== routerMatches) { agree = false; console.log(`   ↳ "${variant}" (root ${root}): overlap=${overlapFires} router=${routerMatches}`); }
  }
  ok(agree, '0.2: routing and the exact-overlap warning agree on every path variant (no silent drift)');
}

// ── 1. What counts as a routable finding (decision 2, in code not prose) ────
{
  const owned = ['src/canvas/KlypixCanvas.tsx', 'docs/'];
  const C = (text, verified = true) => classifyFinding({ text, verified, ownedPaths: owned });

  ok(C('CLAUDE.md:135 names scripts/global-brain-hook.mjs as source of truth but that file is GENERATED').routable,
    '1.1 +: a verified finding naming a foreign file with a line number is routable');
  ok(C('the uninstall verb is documented as missing in README.md — false since 1.43.1').routable,
    '1.2 +: a foreign doc file is routable');
  ok(C('electron/cloudHandlers.ts registers the merge driver twice — the second call silently no-ops').routable,
    '1.3 +: a foreign source file with a defect claim is routable');

  ok(!C('CLAUDE.md:135 might be wrong about the source of truth').routable,
    '1.4 −: a HEDGED claim is a hunch wearing a filename — not routable');
  ok(C('CLAUDE.md:135 might be wrong about the source of truth').reason === 'hedged', '1.4b: and it says so');
  ok(!C('something feels off about the docs').routable, '1.5 −: a hunch with no artifact is NOT routable');
  ok(!C('src/canvas/KlypixCanvas.tsx leaks a listener on unmount').routable,
    '1.6 −: a finding about the session\'s OWN declared file is NOT routable (R4, filtered at source)');
  ok(!C('docs/KLYPIX_MCP.md is stale — it documents 6 of 18 tools').routable,
    '1.7 −: a file under an owned DIRECTORY is own-scope, not routable');
  ok(C('docs/KLYPIX_MCP.md is stale — it documents 6 of 18 tools').reason === 'own-scope', '1.7b: and it says own-scope, not no-defect');
  ok(!C('CLAUDE.md:135 names a GENERATED file as source of truth but it is not', false).routable,
    '1.8 −: an UNVERIFIED finding is never routable (the verify gate)');
  ok(C('CLAUDE.md:135 names global-brain-hook.mjs as source of truth but that file is GENERATED').reason === 'verified-foreign-artifact'
    && C('nothing here is broken as such').reason === 'no-artifact',
    '1.9: rejection carries a machine-readable reason (observability, not a silent no-op)');
  ok(!C('bumped klypix-mcp to 1.49.2 and it worked').routable,
    '1.10 −: a version string is not an artifact reference');
  ok(!C('see https://klypix.com/docs/index.html — the writeup is stale').routable,
    '1.11 −: a URL is not a routable artifact (stripped before extraction)');
  ok(!C('moved docs/architecture/notes.md into place and rebuilt').routable,
    '1.12 −: routine work naming a foreign file asserts no defect — not routable');
  ok(C('moved docs/architecture/notes.md into place and rebuilt').reason === 'no-defect-claim', '1.12b: and it says why');
  ok(C('Docs: AGENTS.md is pinned at v=1.39.2 behind a 1.49.x engine\n#docs #file-agents').claim
    === 'AGENTS.md is pinned at v=1.39.2 behind a 1.49.x engine',
    '1.13: the CLAIM strips the area prefix and the #file- tag line (identity is the defect, not our filing)');
}

// ── 2. Artifact extraction ──────────────────────────────────────────────────
{
  const refs = extractArtifactRefs('`CLAUDE.md:135` and docs/installation/uninstall.md#L24 plus AGENTS.md');
  ok(refs.length === 3, `2.1: three artifacts extracted (got ${refs.length})`);
  ok(refs.find((r) => r.key === 'claude.md')?.line === 135, '2.2: :NNN line suffix captured');
  ok(refs.find((r) => r.key === 'docs/installation/uninstall.md')?.line === 24, '2.3: #LNNN line suffix captured');
  ok(extractArtifactRefs('CLAUDE.md and CLAUDE.md:135').length === 1, '2.4: the same path is not double-counted');
  ok(extractArtifactRefs('CLAUDE.md and CLAUDE.md:135')[0].line === 135, '2.5: a later citation supplies the line the first mention lacked');
}

// ── 3. Table-driven routing: chosen owner AND stated reason ─────────────────
// Acceptance gate 1. Every row asserts the verdict, the target, and that the
// reason NAMES the evidence — the line that turns a wrong route into a
// two-second dismissal instead of a lost turn (R8).
{
  const lane = [
    { id: 'me-0000', ...fresh(), files: ['src/canvas/KlypixCanvas.tsx'], intent: 'canvas lens rework' },
    { id: 'owner-11', ...fresh(), files: ['CLAUDE.md', 'docs/KLYPIX_MCP.md'], intent: 'doc audit follow-ups' },
    { id: 'nearby-2', ...fresh(), files: ['docs/architecture/git-diff-and-merge.md'], intent: 'merge driver docs' },
    { id: 'stale-33', ...fresh({ lastSeen: NOW - 3 * 60 * 60 * 1000 }), files: ['AGENTS.md'], intent: 'config fences' },
  ];
  const R = (p, text = 'verified defect') => routeFinding({ finding: { path: p, text }, sessions: lane, selfId: 'me-0000', now: NOW });

  const exact = R('CLAUDE.md');
  ok(exact.verdict === 'routed' && exact.targets[0].id === 'owner-11', '3.1: exact declared-file match routes to the declaring session');
  ok(exact.confidence === 1 && /declared `claude\.md`/.test(exact.reason), '3.2: reason NAMES the declared file (confidence 1.00)');
  ok(/confidence 1\.00/.test(exact.reason), '3.3: reason states the numeric confidence');

  const dir = R('docs/architecture/git-merge-driver-notes.md');
  ok(dir.verdict === 'routed' && dir.targets[0].id === 'nearby-2' && dir.confidence === 0.6,
    '3.4: a sibling file in a declared directory routes at 0.60 (the floor)');
  ok(/same directory/.test(dir.reason), '3.5: the directory reason says it is a NEIGHBOUR, not the file');

  const none = R('electron/main.ts');
  ok(none.verdict === 'nobody' && !none.targets.length, '3.6: a path nobody declared routes to NOBODY (R1)');
  ok(/no live session declared electron\/main\.ts/.test(none.reason), '3.7: the nobody verdict SAYS what it looked for');

  const stale = R('AGENTS.md');
  ok(stale.verdict === 'nobody', '3.8: a session that has not heartbeated in 3h is not a routing target (R6)');

  ok(routingCandidates({ sessions: lane, selfId: 'me-0000', now: NOW }).length === 2,
    '3.9: freshness-gating leaves exactly the live peers as candidates');
}

// ── 4. R2 — two sessions declare the same file: BOTH, never a silent pick ───
{
  const lane = [
    { id: 'me-0000', ...fresh(), files: ['src/a.ts'], intent: 'mine' },
    { id: 'twin-a1', ...fresh({ lastSeen: NOW - 10_000 }), files: ['CLAUDE.md'], intent: 'doc pass' },
    { id: 'twin-b2', ...fresh({ lastSeen: NOW - 90_000 }), files: ['CLAUDE.md'], intent: 'other doc pass' },
  ];
  const r = routeFinding({ finding: { path: 'CLAUDE.md', text: 'x' }, sessions: lane, selfId: 'me-0000', now: NOW });
  ok(r.verdict === 'contested', '4.1: two equal claimants produce a CONTESTED verdict, not a coin flip');
  ok(r.targets.length === 2 && r.targets.map((t) => t.id).sort().join() === 'twin-a1,twin-b2', '4.2: both claimants are listed');
  ok(/CONTESTED, 2 sessions/.test(r.reason), '4.3: the reason line says it is contested');
  const rendered = renderFindingDrafts([{ ...r, id: 'k', path: 'CLAUDE.md', line: 135, text: 'names a GENERATED file as source of truth', area: 'Docs', seenCount: 1 }]);
  ok((rendered.match(/send → /g) || []).length === 2, '4.4: a contested draft renders ONE send line per claimant');
  ok(/send to both or neither, do not guess/.test(rendered), '4.5: the contested draft tells the human not to guess');
}

// ── 5. Confidence floor — silence beats a wrong guess ───────────────────────
{
  const lane = [
    { id: 'me-0000', ...fresh(), files: ['src/a.ts'], intent: 'routing the finding lane' },
    { id: 'weak-111', ...fresh(), files: ['unrelated/x.ts'], intent: 'routing the finding lane too' },
  ];
  const r = routeFinding({ finding: { path: 'CLAUDE.md', text: 'routing lane defect' }, sessions: lane, selfId: 'me-0000', now: NOW });
  ok(r.verdict === 'nobody', '5.1: branch+intent coincidence alone (0.35) never clears the floor');
  ok(r.confidence < ROUTE_CONFIDENCE_FLOOR && /too weak to address/.test(r.reason),
    '5.2: the sub-floor rejection is REPORTED (deliberate silence, not a silent no-op)');
  ok(ROUTE_CONFIDENCE_FLOOR === 0.6, '5.3: the floor is exactly the declared-dir score — dir matches route, coincidence never does');
}

// ── 6. R5 — dedupe by content hash across turns ─────────────────────────────
{
  const a = findingKey({ path: 'CLAUDE.md', text: 'names a GENERATED file as source of truth' });
  const b = findingKey({ path: 'CLAUDE.md', text: 'Names   a GENERATED file, as source of truth!' });
  const c = findingKey({ path: 'AGENTS.md', text: 'names a GENERATED file as source of truth' });
  const d = findingKey({ path: 'CLAUDE.md', text: 'Docs: names a GENERATED file as source of truth\n#docs #file-claude' });
  ok(a === b, '6.1: punctuation/whitespace/case variants hash to the SAME finding');
  ok(a !== c, '6.2: the same text about a different path is a DIFFERENT finding');
  ok(a === d, '6.2b: the area prefix and tag line are not part of the finding identity');
  // The same defect cited with and without a line number is ONE finding for the
  // peer who must act on it; including the line minted two drafts telling the
  // same story twice.
  const withLine = findingKey({ path: 'CLAUDE.md', text: 'names a GENERATED file as source of truth', line: 135 });
  const otherLine = findingKey({ path: 'CLAUDE.md', text: 'names a GENERATED file as source of truth', line: 900 });
  ok(a === withLine && withLine === otherLine, '6.2c: the line number is evidence, not identity — same claim + path = one draft');

  const first = [{ id: a, path: 'CLAUDE.md', text: 't', firstSeen: NOW, lastSeen: NOW, seenCount: 1, verdict: 'routed', confidence: 1, targets: [], reason: 'r' }];
  const again = mergeFindingDrafts(first, [{ ...first[0], firstSeen: NOW + 1000, lastSeen: NOW + 1000, seenCount: 1 }], { now: NOW + 1000 });
  ok(again.drafts.length === 1, '6.3: re-detecting the same finding does not stack a second draft');
  ok(again.drafts[0].seenCount === 2, '6.4: recurrence BUMPS the count instead');
  ok(again.added === 0, '6.5: a bump does not consume the per-session new-draft budget');
}

// ── 7. R3/R1 — the owner goes offline; the 3am no-owner case ───────────────
{
  const held = [{ id: 'k1', path: 'CLAUDE.md', text: 'defect', area: 'Docs', firstSeen: NOW - 86_400_000, lastSeen: NOW - 86_400_000, seenCount: 1, shownSessions: [], verdict: 'routed', confidence: 1, targets: [{ id: 'gone-111', signal: 'declared-file', evidence: 'claude.md', lastSeenMs: 0 }], reason: 'declared `claude.md`; active now · confidence 1.00' }];
  const rerouted = mergeFindingDrafts(held, [], {
    now: NOW,
    reroute: (d) => routeFinding({ finding: { path: d.path, text: d.text }, sessions: [{ id: 'me-0000', ...fresh(), files: ['src/a.ts'] }], selfId: 'me-0000', now: NOW }),
  });
  ok(rerouted.drafts[0].verdict === 'nobody', '7.1: a draft whose owner went offline is RE-ROUTED to nobody, never rendered as live (R3)');

  const found = mergeFindingDrafts(rerouted.drafts, [], {
    now: NOW,
    reroute: (d) => routeFinding({ finding: { path: d.path, text: d.text }, sessions: [{ id: 'me-0000', ...fresh(), files: ['src/a.ts'] }, { id: 'late-222', ...fresh(), files: ['CLAUDE.md'] }], selfId: 'me-0000', now: NOW }),
  });
  ok(found.drafts[0].verdict === 'routed' && found.drafts[0].targets[0].id === 'late-222',
    '7.2: a HELD no-owner finding is re-offered the moment a matching session appears (R1)');

  const orphanRender = renderFindingDrafts([{ ...held[0], verdict: 'nobody', targets: [], reason: 'no live session declared claude.md' }]);
  ok(/no live session owns this path/.test(orphanRender) && /🧠 BRAIN \[Docs\]/.test(orphanRender),
    '7.3: a no-owner draft says it is HELD and offers a brain_note instead — it does not evaporate (R1)');
  ok(!/send → /.test(orphanRender), '7.4: a no-owner draft renders NO send line — nothing is addressed to nobody');
}

// ── 8. R7 — a draft never approved ages out silently, and stops nagging ────
{
  const old = [{ id: 'k1', path: 'a.md', text: 't', firstSeen: NOW - 22 * 86_400_000, lastSeen: NOW - 22 * 86_400_000, seenCount: 1, shownSessions: [] }];
  ok(mergeFindingDrafts(old, [], { now: NOW }).drafts.length === 0, '8.1: a draft past the 21-day TTL is dropped, silently (R7)');
  ok(pendingFindingDrafts([{ id: 'k', path: 'a.md', text: 't', lastSeen: NOW, shownSessions: ['s1', 's2', 's3', 's4', 's5'] }], { now: NOW }).length === 0,
    '8.2: a draft ignored across 5 distinct sessions stops surfacing well before the TTL (no infinite nag)');
  ok(pendingFindingDrafts([{ id: 'k', path: 'a.md', text: 't', lastSeen: NOW, shownSessions: ['s1'] }], { sid: 's1', now: NOW }).length === 0,
    '8.3: a session is not re-nagged with a draft it was already shown');
  ok(pendingFindingDrafts([{ id: 'k', path: 'a.md', text: 't', lastSeen: NOW, shownSessions: ['s1'] }], { sid: 's2', now: NOW }).length === 1,
    '8.4: a NEW session still sees it');
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, path: `p${i}.md`, text: 't', firstSeen: NOW, lastSeen: NOW, seenCount: 1 }));
  ok(mergeFindingDrafts([], many, { now: NOW }).added === 2, '8.5: at most 2 NEW drafts per session (anti-spam cap)');
}

// ── 9. R8 — a wrong route must be dismissible in two seconds ───────────────
{
  const draft = {
    id: 'k', path: 'CLAUDE.md', line: 135, area: 'Docs', seenCount: 1,
    text: 'names scripts/global-brain-hook.mjs as source of truth, but that file is GENERATED — editing it breaks prebuild',
    verdict: 'routed', confidence: 1,
    targets: [{ id: 'owner-11', signal: 'declared-file', evidence: 'claude.md', lastSeenMs: 20_000 }],
    reason: 'owner-11 — declared `claude.md`; active now · confidence 1.00',
  };
  const out = renderFindingDrafts([draft]);
  ok(/why: owner-11 — declared `claude\.md`/.test(out), '9.1: every draft renders the "why this session" line');
  ok(/send → `🧠 MSG \[owner-11\]: CLAUDE\.md:135 —/.test(out), '9.2: the send line is ONE paste and leads with the artifact');
  ok(/not yours\? ignore\./.test(out), '9.3: the message body itself tells a wrong recipient to drop it');
  ok(/nothing was written to the brain/.test(out), '9.4: the block states that nothing was written and nothing was sent');
  ok(!/auto-?sen/i.test(out), '9.5: the surface never implies anything was sent automatically');
}

// ── 10. Durable delivery receipts (acceptance gate 3) ──────────────────────
{
  const sessions = [
    { id: 'me-0000', ...fresh() },
    { id: 'peer-aaa', ...fresh({ startedAt: NOW - 900_000 }) },
    { id: 'peer-bbb', ...fresh({ startedAt: NOW - 900_000 }) },
    { id: 'later-cc', ...fresh({ startedAt: NOW - 10_000 }) },   // started AFTER the send
  ];
  const messages = [
    {
      id: 'm1', from: 'me-0000', to: 'all', text: 'broadcast note', ts: NOW - 600_000,
      candidateIds: ['peer-aaa', 'peer-bbb'], deliveryVersion: 2,
      deliveries: [{ recipientId: 'peer-aaa', state: 'acknowledged', offeredAt: NOW - 590_000, acknowledgedAt: NOW - 580_000 }],
    },
    { id: 'm2', from: 'peer-aaa', to: 'all', text: 'not mine', ts: NOW - 500_000, seen: [] },
  ];
  const s = summarizeReceipts({ messages, sessions, selfId: 'me-0000', now: NOW });
  ok(s.sent === 1, '10.1: only THIS session\'s own sent notes get a receipt');
  const r = s.receipts[0];
  ok(r.acknowledged === 1 && r.read === 1 && r.candidates === 2,
    '10.2: only later-action acknowledgement counts; the compatibility read alias means the same thing');
  ok(r.pendingIds.join() === 'peer-bbb', '10.3: pending peers are named by id-prefix — a name you can chase');
  ok(/acknowledged 1 of 2 · unresolved peer-bbb/.test(renderReceipt(r)), '10.4: the rendered receipt is exact and honest');

  const allRead = summarizeReceipts({ messages: [{
    id: 'm', from: 'me-0000', to: 'all', text: 't', ts: NOW - 60_000,
    candidateIds: ['peer-aaa', 'peer-bbb'], deliveryVersion: 2,
    deliveries: ['peer-aaa', 'peer-bbb'].map((recipientId) => ({ recipientId, state: 'acknowledged', acknowledgedAt: NOW - 30_000 })),
  }], sessions, selfId: 'me-0000', now: NOW });
  ok(/model-context delivery acknowledged by all 2 target peer\(s\).*not human-read/.test(renderReceipt(allRead.receipts[0])),
    '10.5: all-target wording names model-context acknowledgement and disclaims human reading');

  const alone = summarizeReceipts({ messages: [{ id: 'm', from: 'me-0000', to: 'all', text: 't', ts: NOW - 60_000, seen: [] }], sessions: [{ id: 'me-0000', ...fresh() }], selfId: 'me-0000', now: NOW });
  ok(/queued with no live target snapshot/.test(renderReceipt(alone.receipts[0])),
    '10.6: with no live peer it reports a targetless pending queue, never a false acknowledgement');

  const directed = summarizeReceipts({ messages: [{ id: 'm', from: 'me-0000', to: 'peer-bbb', text: 't', ts: NOW - 60_000, seen: [] }], sessions, selfId: 'me-0000', now: NOW });
  ok(directed.receipts[0].candidates === 1 && directed.receipts[0].pendingIds.join() === 'peer-bbb',
    '10.7: a DIRECTED note has a denominator of its target, not of everyone');
  ok(/acknowledged 0 of 1.*unresolved peer-bbb/.test(renderReceipt(directed.receipts[0])) && !/acknowledged by all/.test(renderReceipt(directed.receipts[0])),
    '10.8: an undelivered directed note never implies delivery (R3)');
  ok(/Your last note \(10m ago\): acknowledged 1 of 2 · unresolved peer-bbb\./.test(renderReceiptSummary(s)),
    '10.9: the compact receipt is one honest, text-free line for SessionStart and brain_doctor');
  ok(!renderReceiptSummary({ sent: 0, receipts: [] }),
    '10.10: no sent note produces no automatic receipt noise');

  const snapshotted = summarizeReceipts({
    messages: [{
      id: 'm-snapshot', from: 'me-0000', to: 'all', text: 't', ts: NOW - 60_000,
      candidateIds: ['peer-aaa', 'gone-xyz'], seen: ['later-cc'], deliveryVersion: 2,
      deliveries: [{ recipientId: 'peer-aaa', state: 'acknowledged', acknowledgedAt: NOW - 30_000 }],
    }],
    sessions, selfId: 'me-0000', now: NOW,
  }).receipts[0];
  ok(snapshotted.candidates === 2 && snapshotted.read === 1 && snapshotted.pendingIds.join() === 'gone-xyz',
    '10.11: send-time audience survives peer exit and later viewers never inflate the numerator');

  const legacy = summarizeReceipts({
    messages: [{
      id: 'm-legacy', from: 'me-0000', to: 'peer-aaa', text: 'legacy', ts: NOW - 60_000,
      candidateIds: ['peer-aaa'], seen: ['peer-aaa'],
    }],
    sessions, selfId: 'me-0000', now: NOW,
  }).receipts[0];
  ok(legacy.acknowledged === 0 && legacy.offered === 1
    && /offered 1, awaiting later-action ack.*unresolved peer-aaa/.test(renderReceipt(legacy)),
  '10.12: historical seen[] migrates to offered and never becomes a false acknowledgement');

  const deadLetter = summarizeReceipts({
    messages: [{
      id: 'm-dead', from: 'me-0000', to: 'all', text: 'expired', ts: NOW - 60_000,
      candidateIds: [], deadLetter: { state: 'failed', reason: 'expired-before-acknowledgement', at: NOW },
    }],
    sessions, selfId: 'me-0000', now: NOW,
  }).receipts[0];
  ok(/delivery failed \(expired before acknowledgement\)/.test(renderReceipt(deadLetter)),
    '10.13: TTL/cap terminalization stays visible as a dead-letter reason');
}

// ── 11. End-to-end draft construction from captured cards ─────────────────
{
  const cards = [
    { area: 'Docs', text: 'Docs: CLAUDE.md:135 names scripts/global-brain-hook.mjs as source of truth but that file is GENERATED — an agent obeying it breaks prebuild\n#docs #file-claude' },
    { area: 'Canvas', text: 'Canvas: src/canvas/KlypixCanvas.tsx leaks a listener on every tab switch' },
    { area: 'Idle', text: 'Idle: something feels off' },
  ];
  const lane = [
    { id: 'me-0000', ...fresh(), files: ['src/canvas/KlypixCanvas.tsx'] },
    { id: 'owner-11', ...fresh(), files: ['CLAUDE.md'] },
  ];
  const { drafts, rejected } = buildFindingDrafts({
    cards, verified: true, ownedPaths: ['src/canvas/KlypixCanvas.tsx'], sessions: lane, selfId: 'me-0000', now: NOW,
  });
  ok(drafts.length === 1, `11.1: exactly the foreign verified finding becomes a draft (got ${drafts.length})`);
  ok(drafts[0].targets[0].id === 'owner-11' && drafts[0].line === 135, '11.2: it is routed to the declaring session, with the cited line');
  ok(rejected.some((r) => r.reason === 'own-scope') && rejected.some((r) => r.reason === 'no-defect-claim'),
    '11.3: own-scope and hunch cards are rejected with a stated reason');
  ok(buildFindingDrafts({ cards, verified: false, ownedPaths: [], sessions: lane, selfId: 'me-0000', now: NOW }).drafts.length === 0,
    '11.4: with no verify signal, nothing is drafted at all');
  ok(!JSON.stringify(drafts).includes('doc audit follow-ups'), '11.5: a draft carries no peer text — metadata only');
}

// ── 12. Structural: the routing path writes nothing and reaches nothing ────
// Acceptance gate 4. This is the property that makes every failure above cheap:
// routing writes nothing to the brain and blocks nothing, so its worst failure
// is a missing or misaddressed suggestion.
{
  const raw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'finding-routing.mjs'), 'utf8');
  // Scan CODE, not prose: this module's own comments necessarily NAME the things
  // it must not do ("no fs, no net, no child_process"), and a scanner that reads
  // a promise as a violation can never be satisfied.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const imports = [...src.matchAll(/^import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === 'crypto', `12.1: the routing module imports ONLY node:crypto (got ${imports.join(', ') || 'none'})`);
  ok(!/\bfs\.|writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/.test(src), '12.2: no filesystem write anywhere in the routing path');
  ok(!/\bfetch\(|https?:\/\/|net\.|http\.|WebSocket|XMLHttpRequest|execFileSync|spawn|child_process/.test(src),
    '12.3: no network and no subprocess in the routing path');
  ok(!/addToCanvas|appendCard|buildKlypixMap|saveKlypix|writeBrain|brain_note|postPresenceMessage|upsertSession/.test(src),
    '12.4: no brain-write or lane-write API is reachable from the routing path');
  ok(ROUTE_FRESH_MS === 10 * 60 * 1000, '12.5: the routing freshness gate equals the lane\'s own SESSION_FRESH_MS');
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ finding-routing: all assertions passed');
process.exit(failures ? 1 : 0);
