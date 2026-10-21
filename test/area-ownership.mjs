// Area ownership + takeover (1.106.0) — the 2026-10-21 incident.
//
// A Claude Code session asked "what is remaining?" listed "iPhone 1.1.5 →
// press Release after Apple approves" as its own open work. Another session
// had taken the iOS work over the day before (klypix-ios #95 bumped iOS to
// 1.1.6). The brain held both cards, but nothing said WHICH SESSION wrote
// them, so the asking session trusted its memory of owning iOS.
//
//   AO1  card stamp: createdSession rides every writer (new card, ~ update,
//        ❓ merge), is parsed back, and a rewrite by an unstamped writer
//        clears it (a stale name is worse than none)
//   AO2  ownershipSessionsFromLane: live row wins, aliases join, status words
//   AO3  areaOwnership: owner = newest stamped card; the asker's takeovers
//        (newer card by another session, a handoff another session took);
//        Archive/Handoff areas own nothing; scope is honoured
//   AO4  ownerLabel / ownerIsActiveOther: no guessed state, the asker never
//        "holds" against itself, a gone owner past 24h says nothing
//   AO5  REGRESSION (incident shape): two sessions, iOS handed over → the
//        asker's status block carries ↪ [iOS] taken over by <other> and the
//        open iOS item carries 👤area held by <other>; the other session
//        sees "owner you"; an unstamped brain renders exactly as before
//   AO6  warnings are never budget-dropped (the v1.32.0 law)
//   AO7  the merge engine keeps the stamp (no-loss)
//   AO8  the real Stop hook stamps its own session on marker cards, and
//        leaves commit cards unstamped; the brief shows owners
//
// Run:  node test/area-ownership.mjs      (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildKlypixMap, parseKlypix, captureIntoBrain, noteToCaptureInput, statusContextToMarkdown, structToBrief,
  areaOwnership, ownershipSessionsFromLane, ownerLabel, ownerIsActiveOther, takeoverLines, cleanSessionId,
  OWNERSHIP_RECENT_MS, SESSION_ID_MAX,
} from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';

// AO9 child: brain_ask status mode end to end, HOME sandboxed by the parent
// (the presence lane lives under the home directory — never the real one).
if (process.env.KLYPIX_AO_CHILD === '1') {
  const semantic = await import('../src/semantic-memory.mjs');
  const { upsertSession } = await import('../src/agent-presence.mjs');
  const { opBrainAsk } = await import('../src/klypix-core.mjs');
  const brain = process.env.KLYPIX_AO_BRAIN;
  let b = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card for brain_ask ownership' }] }] });
  b = (await captureIntoBrain(b, { cards: [{ text: 'iOS: ❓ press Release after Apple approves iOS 1.1.5', area: 'iOS', createdVia: 'claude-code', createdSession: 'ask-asker-0001' }] })).buffer;
  await new Promise(r => setTimeout(r, 15));
  b = (await captureIntoBrain(b, { cards: [{ text: 'iOS: 🏁 klypix-ios #95 bumps the version to 1.1.6', area: 'iOS', createdVia: 'codex', createdSession: 'ask-other-0002' }] })).buffer;
  fs.writeFileSync(brain, b);
  upsertSession({ brainPath: brain, id: 'ask-other-0002', logicalSessionId: 'ask-other-0002', client: 'codex', intent: 'ship iOS 1.1.6', event: 'UserPromptSubmit', channel: 'lifecycle' });
  semantic.__semanticMemoryTest.installModels({ embedder: async (texts) => ({ dims: [texts.length, 2], data: Float32Array.from(texts.flatMap(() => [1, 0])), dispose() {} }) });
  const r = await opBrainAsk({ vault: path.dirname(brain), canvas: brain, question: 'what is remaining?', k: 3, sessionId: 'ask-asker-0001' });
  process.stdout.write(JSON.stringify({ text: r.blocks.map(x => x.text || '').join('\n') }));
  process.exit(0);
}

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const A = '19c1467a-f29a-4a38-90de-45b0c16a27ee';   // the asker (wrote iOS 1.1.5)
const B = 'caf5af36-4bc7-4259-8cde-d1f04dfb29c3';   // took iOS over (#95 → 1.1.6)
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

// ── AO1 — the stamp on every writer ──────────────────────────────────────────
ok(cleanSessionId('  abc  ') === 'abc' && cleanSessionId(42) === '' && cleanSessionId('x'.repeat(400)).length === SESSION_ID_MAX, 'AO1 cleanSessionId trims, rejects non-strings, caps at SESSION_ID_MAX');
{
  const n = noteToCaptureInput({ text: '! shipped it', area: 'iOS', createdVia: 'codex', createdSession: B });
  ok(n.cards[0].createdSession === B && n.cards[0].createdVia === 'codex', 'AO1 noteToCaptureInput carries createdSession on a card');
  ok(noteToCaptureInput({ text: '~ amended', area: 'iOS', createdSession: B }).updates[0].createdSession === B, 'AO1 … and on a ~ update');
  ok(!('createdSession' in noteToCaptureInput({ text: 'no session', area: 'iOS' }).cards[0]), 'AO1 no session → no field (older shape kept)');
}
let buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card for the ownership suite' }] }] });
buf = (await captureIntoBrain(buf, { cards: [{ text: 'iOS: 🏁 iOS 1.1.5 build 78 submitted to App Review from release/1.1.5-store', area: 'iOS', createdVia: 'claude-code', createdSession: A }] })).buffer;
{
  const { struct } = await parseKlypix(buf);
  const c = struct.cards.find(x => /1\.1\.5 build 78/.test(x.text || ''));
  ok(c && c.createdSession === A, 'AO1 captureIntoBrain persists createdSession and parseKlypix reads it back');
  const seed = struct.cards.find(x => /seed card/.test(x.text || ''));
  ok(seed && !('createdSession' in seed), 'AO1 an unstamped card has no createdSession key at all');
}
buf = (await captureIntoBrain(buf, { updates: [{ area: 'iOS', text: 'iOS 1.1.5 build 78 submitted to App Review from release/1.1.5-store and waiting for review', createdVia: 'codex', createdSession: B }] })).buffer;
{
  const { struct } = await parseKlypix(buf);
  const c = struct.cards.find(x => /1\.1\.5 build 78/.test(x.text || ''));
  ok(c && c.createdSession === B, 'AO1 a ~ update by another session restamps the card (it rewrote createdAt too)');
}
buf = (await captureIntoBrain(buf, { updates: [{ area: 'iOS', text: 'iOS 1.1.5 build 78 submitted to App Review from release/1.1.5-store and waiting for review by Apple', createdVia: 'cli' }] })).buffer;
{
  const { struct } = await parseKlypix(buf);
  const c = struct.cards.find(x => /1\.1\.5 build 78/.test(x.text || ''));
  ok(c && !c.createdSession, 'AO1 a ~ update with no session CLEARS the stamp — the old one would name a session that did not write it');
}

// ── AO2 — presence rows ──────────────────────────────────────────────────────
const lane = {
  live: [
    { id: B, client: 'claude-code', intent: 'bump iOS to 1.1.6 for the AI switch', hostStatus: 'busy', hostStatusAt: NOW - 2 * 60_000, lastSeen: NOW },
    { id: 'conn-7', logicalSessionId: 'codex-990ec863', client: 'codex', intent: '', hostStatus: 'idle', hostStatusAt: NOW - 14 * 60_000, lastSeen: NOW },
    { id: A, client: 'claude-code', intent: 'what is remaining', hostStatus: 'busy', hostStatusAt: NOW, lastSeen: NOW, aliases: ['old-a-id'] },
  ],
  directory: [
    { id: B, client: 'claude-code', intent: 'older remembered intent', lastSeen: NOW - HOUR, aliases: ['b-alias'] },
    { id: 'codex-990ec863', client: 'codex', intent: 'remembered codex task', lastSeen: NOW - HOUR },
    { id: 'gone-1234', client: 'codex', intent: 'finished thing', lastSeen: NOW - 5 * HOUR, endedAt: NOW - 5 * HOUR },
    { id: 'quiet-5678', client: 'cursor', intent: 'x', lastSeen: NOW - 5 * HOUR },
    null, { nope: true },
  ],
};
const sessions = ownershipSessionsFromLane(lane, NOW);
const row = (id) => sessions.find(s => s.keys.includes(id.toLowerCase()));
ok(row(B)?.status === 'working' && row(B)?.live === true, 'AO2 a busy row stamped 2 min ago reads "working"');
ok(row(B)?.intent === 'bump iOS to 1.1.6 for the AI switch', 'AO2 the live intent wins over the remembered one');
ok(row('b-alias') === row(B), 'AO2 a directory alias joins the live row');
ok(row('codex-990ec863')?.status === 'idle 14m' && row('conn-7') === row('codex-990ec863'), 'AO2 a connection id and its logical id are one session ("idle 14m")');
ok(row('codex-990ec863')?.intent === 'remembered codex task', 'AO2 an empty live intent is filled from the directory');
ok(row('gone-1234')?.status === 'ended' && row('gone-1234')?.live === false, 'AO2 an ended directory entry reads "ended"');
ok(row('quiet-5678')?.status === 'not running', 'AO2 a quiet directory entry reads "not running"');
ok(sessions.length === 5, `AO2 malformed rows are skipped (${sessions.length} sessions)`);
ok(ownershipSessionsFromLane({ live: [{ id: 'k', live: true, status: 'idle 3m' }] }, NOW)[0].status === 'live', 'AO2 a live row with no host status reads "live"');
ok(ownershipSessionsFromLane({ directory: [{ id: 'k2', live: true, status: 'idle 3m' }] }, NOW)[0].status === 'idle 3m', 'AO2 a listKnownSessions entry keeps its own joined status');

// ── AO3 — areaOwnership on a hand-built struct ───────────────────────────────
const card = (id, area, text, at, sid, extra = {}) => ({ id, type: 'text', area, text: `${area}: ${text}`, createdAt: at, ...(sid ? { createdSession: sid } : {}), createdVia: 'claude-code', ...extra });
const struct = {
  title: 'brain', format: 'klypix-v4', counts: { cards: 0, connections: 0 }, connections: [],
  cards: [
    card('c1', 'iOS', '🏁 iOS 1.1.5 submitted to App Review', NOW - 36 * HOUR, A),
    card('c2', 'iOS', '❓ press Release after Apple approves 1.1.5', NOW - 35 * HOUR, A),
    card('c3', 'iOS', '🏁 klypix-ios #95 bumps MARKETING_VERSION to 1.1.6', NOW - 26 * HOUR, B),
    card('c4', 'Billing', '❓ pick the payment provider', NOW - 10 * HOUR, A),
    card('c5', 'Billing', 'Paddle chosen pending written confirmation', NOW - 9 * HOUR, 'old-a-id'),   // the asker under an alias
    card('c6', 'Docs', '❓ rewrite the README intro', NOW - 3 * HOUR, 'quiet-5678'),
    card('c7', 'Archive', 'archived note', NOW, B),
    card('c8', 'Handoff', '❓ 🤝 HANDOFF — some handoff', NOW, B),
    card('c9', 'Notes', 'unstamped newer card', NOW, null),
  ],
};
const own = areaOwnership(struct, { sessions, askerId: A });
ok(own.attributed === 6, `AO3 stamped cards outside Archive/Handoff are counted (${own.attributed})`);
ok(own.byArea.get('iOS')?.owner.sessionId === B, 'AO3 iOS owner = the session with the newest stamped card (B)');
ok(own.byArea.get('Billing')?.owner.sessionId === 'old-a-id', 'AO3 Billing owner = the asker, under its alias');
ok(!own.byArea.has('Archive') && !own.byArea.has('Handoff') && !own.byArea.has('Notes'), 'AO3 Archive, Handoff and unstamped areas own nothing');
const ios = own.takeovers.find(t => t.area === 'iOS');
ok(ios && ios.kind === 'newer-card' && ios.other.sessionId === B && ios.session === row(B), 'AO3 iOS is a takeover for the asker, joined to B\'s presence row');
ok(!own.takeovers.some(t => t.area === 'Billing'), 'AO3 an area the asker still leads (alias included) is no takeover');
ok(!own.takeovers.some(t => t.area === 'Docs'), 'AO3 an area the asker never wrote in is no takeover');
ok(areaOwnership(struct, { sessions, askerId: B }).takeovers.length === 0, 'AO3 the session that took over sees no takeover');
ok(areaOwnership(struct, { sessions }).takeovers.length === 0, 'AO3 no asker → owners only, no takeovers');
ok([...areaOwnership(struct, { sessions, askerId: A, areas: ['Billing'] }).byArea.keys()].join() === 'Billing', 'AO3 an area scope narrows the owners');
ok(areaOwnership(null).attributed === 0 && areaOwnership({ cards: 'x' }).takeovers.length === 0, 'AO3 malformed input → empty result, no throw');
{
  // Explicit handover: A's handoff taken by B, while A still leads Billing.
  const h = { ...card('h1', 'Archive', '❓ 🤝 HANDOFF — finish billing', NOW - 2 * HOUR, A), handoff: { v: 1, state: 'taken', title: 'finish billing', from: { client: 'Claude Code', sessionId: A }, taken: { client: 'Codex', sessionId: 'codex-990ec863', at: NOW - HOUR } } };
  const o2 = areaOwnership({ ...struct, cards: [...struct.cards, h] }, { sessions, askerId: A });
  const ho = o2.takeovers.find(t => t.kind === 'handoff');
  ok(ho && ho.title === 'finish billing' && ho.other.sessionId === 'codex-990ec863', 'AO3 a handoff the asker wrote and another session took is a takeover');
  ok(o2.takeovers.some(t => t.kind === 'handed-area' && t.area === 'Billing'), 'AO3 … and the areas the asker still leads are marked handed');
  ok(o2.byArea.get('Billing').handedTo?.sessionId === 'codex-990ec863', 'AO3 the Billing owner row names who it was handed to');
  const lines = takeoverLines(o2);
  ok(lines.some(l => /your handoff “finish billing” was taken by Codex codex-99/.test(l) && /\(areas: Billing\)/.test(l)), 'AO3 the handoff line names its areas');
  ok(areaOwnership({ ...struct, cards: [...struct.cards, h] }, { sessions, askerId: 'codex-990ec863' }).takeovers.length === 0, 'AO3 the taker sees no takeover');
  // A handoff taken BEFORE the owner wrote again is history.
  const early = { ...h, handoff: { ...h.handoff, taken: { ...h.handoff.taken, at: NOW - 20 * HOUR } } };
  ok(!areaOwnership({ ...struct, cards: [...struct.cards, early] }, { sessions, askerId: A }).byArea.get('Billing').handedTo, 'AO3 a handoff taken before the owner wrote again does not hand the area over');
  // Same session on both sides (resume) is no handover.
  const self = { ...h, handoff: { ...h.handoff, taken: { client: 'Claude Code', sessionId: 'old-a-id', at: NOW } } };
  ok(!areaOwnership({ ...struct, cards: [...struct.cards, self] }, { sessions, askerId: A }).takeovers.some(t => t.kind === 'handoff'), 'AO3 taking your own handoff (an alias of you) is no takeover');
}

// ── AO4 — labels and "held by" ───────────────────────────────────────────────
ok(ownerLabel(own.byArea.get('iOS').owner) === 'Claude Code caf5af36 (working: “bump iOS to 1.1.6 for the AI switch”)', 'AO4 label: client, short id, state, live intent');
ok(ownerLabel(own.byArea.get('iOS').owner, { withIntent: false }) === 'Claude Code caf5af36 (working)', 'AO4 label without intent');
ok(ownerLabel({ sessionId: 'zzzzzzzz-1', client: 'codex', session: null }) === 'Codex zzzzzzzz (not in the session list)', 'AO4 a stamp the lane does not know says so');
ok(ownerLabel({ sessionId: 'zzzzzzzz-1', client: 'codex', session: null }, { lane: false }) === 'Codex zzzzzzzz', 'AO4 no lane passed → no state at all, never a guessed one');
ok(ownerIsActiveOther(own.byArea.get('iOS'), { askerId: A, now: NOW })?.sessionId === B, 'AO4 iOS is held by B for the asker (B is live)');
ok(ownerIsActiveOther(own.byArea.get('Billing'), { askerId: A, now: NOW }) === null, 'AO4 the asker never holds against itself (alias included)');
ok(ownerIsActiveOther(own.byArea.get('Docs'), { askerId: A, now: NOW })?.sessionId === 'quiet-5678', 'AO4 a not-running owner that wrote 3h ago still holds (inside 24h)');
ok(ownerIsActiveOther(own.byArea.get('Docs'), { askerId: A, now: NOW + OWNERSHIP_RECENT_MS }) === null, 'AO4 … and past 24h it says nothing');

// ── AO5 — REGRESSION: the incident through the real capture path ─────────────
{
  let b2 = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card for the incident replay' }] }] });
  b2 = (await captureIntoBrain(b2, { cards: [
    { text: 'iOS: 🏁 iOS 1.1.5 (build 78) was submitted to App Review on 2026-10-19 from release/1.1.5-store', area: 'iOS', createdVia: 'claude-code', createdSession: A },
    { text: 'iOS: ❓ press Release in App Store Connect after Apple approves iOS 1.1.5', area: 'iOS', createdVia: 'claude-code', createdSession: A },
  ] })).buffer;
  await new Promise(r => setTimeout(r, 15));   // B's card is strictly newer
  b2 = (await captureIntoBrain(b2, { cards: [
    { text: 'iOS: 🏁 klypix-ios #95 (2ebd25d) bumps MARKETING_VERSION to 1.1.6; 1.1.5 was already with App Review', area: 'iOS', createdVia: 'claude-code', createdSession: B },
  ] })).buffer;
  const { struct: s2 } = await parseKlypix(b2);
  const now = Date.now();
  const lane2 = ownershipSessionsFromLane({ live: [
    { id: A, client: 'claude-code', intent: 'what is remaining', hostStatus: 'busy', hostStatusAt: now, lastSeen: now },
    { id: B, client: 'claude-code', intent: 'bump iOS to 1.1.6', hostStatus: 'idle', hostStatusAt: now - 30 * 60_000, lastSeen: now },
  ] }, now);
  const mdA = statusContextToMarkdown(s2, { budgetChars: 5200, now, sessions: lane2, askerId: A });
  ok(/_Owner = the session with the newest card in an area. 👤 = another session holds that area .*report the item as being handled in that session, not as yours to do/.test(mdA), 'AO5 the status header instructs: 👤 items are reported as being handled in that session');
  ok(/## ↪ Taken over from you \(1\)/.test(mdA), 'AO5 the asker gets the ↪ section');
  ok(/- ↪ \[iOS\] taken over by Claude Code caf5af36 \(idle 30m: “bump iOS to 1\.1\.6”\) since your last note here/.test(mdA), 'AO5 ↪ [iOS] names the session that took it, its state and intent');
  ok(/theirs \d{4}-\d\d-\d\d \d\d:\d\dZ: “🏁 klypix-ios #95/.test(mdA) && /report this area’s items as handled there, not as yours/.test(mdA), 'AO5 … quotes the newer card and says how to report it');
  const openLine = mdA.split('\n').find(l => /press Release in App Store Connect/.test(flat(l)));
  ok(openLine && /👤area held by Claude Code caf5af36 \(idle 30m\)/.test(openLine), `AO5 the open 1.1.5 item is flagged 👤area held by B (${(openLine || '').slice(0, 90)}…)`);
  ok(/- iOS — .* · owner Claude Code caf5af36 \(idle 30m/.test(mdA), 'AO5 the iOS digest row names its owner');
  const mdB = statusContextToMarkdown(s2, { budgetChars: 5200, now, sessions: lane2, askerId: B });
  ok(!/↪ Taken over/.test(mdB) && /- iOS — .* · owner you \(this session\)/.test(mdB) && !/👤/.test(mdB.split('## Open')[1] || ''), 'AO5 the session that took over sees "owner you" and no ↪ / 👤');
  // An unstamped brain renders byte-for-byte as before (backward compatible).
  const { struct: s0 } = await parseKlypix(buf);
  const bare = JSON.parse(JSON.stringify(s0)); for (const c of bare.cards) delete c.createdSession;
  const plain = statusContextToMarkdown(bare, { budgetChars: 5200, now });
  ok(!/Owner|owner |↪|👤/.test(plain), 'AO5 an unstamped brain shows no owner, ↪ or 👤 text');
  ok(plain === statusContextToMarkdown(bare, { budgetChars: 5200, now, sessions: lane2, askerId: A }), 'AO5 … and passing a lane changes nothing when no card is stamped');
}

// ── AO6 — warnings are never budget-dropped ──────────────────────────────────
{
  const many = { ...struct, cards: [...struct.cards] };
  for (let i = 0; i < 12; i++) {
    many.cards.push(card(`m${i}`, `Area${i}`, `asker note ${i}`, NOW - 30 * HOUR, A));
    many.cards.push(card(`n${i}`, `Area${i}`, `❓ other session open ${i}`, NOW - 2 * HOUR, B));
  }
  const md = statusContextToMarkdown(many, { budgetChars: 300, now: NOW, sessions, askerId: A });
  const shown = (md.match(/^- ↪ /gm) || []).length;
  ok(/_Owner = the session/.test(md), 'AO6 the ownership instruction survives a 300-char budget');
  ok(shown === 8 && /…and 5 more taken-over area\(s\)/.test(md), `AO6 the ↪ list shows 8 and an honest overflow line for the other 5 (${shown} shown)`);
  // Open cards are shortened or cut by the budget with an honest overflow
  // line (pre-existing rule); every open line that IS shown keeps its flag.
  const openLines = (md.split('## Open')[1] || '').split('\n').filter(l => /other session open/.test(l));
  ok(openLines.every(l => /👤area held by/.test(l)), `AO6 every shown open item in a held area keeps its 👤 flag (${openLines.length} shown)`);
  const roomy = statusContextToMarkdown(many, { budgetChars: 9000, now: NOW, sessions, askerId: A });
  ok((roomy.match(/👤area held by Claude Code caf5af36/g) || []).length >= 12, 'AO6 with room, all 12 held opens carry the flag');
}

// ── AO7 — the merge engine keeps the stamp ───────────────────────────────────
{
  const base = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'merge seed card for ownership' }] }] });
  const ours = (await captureIntoBrain(base, { cards: [{ text: 'iOS: 🏁 ours shipped the build', area: 'iOS', createdSession: A }] })).buffer;
  const theirs = (await captureIntoBrain(base, { cards: [{ text: 'Release: 🏁 theirs cut the release', area: 'Release', createdSession: B }] })).buffer;
  const merged = await mergeBrains({ base, ours, theirs });
  const { struct: sm } = await parseKlypix(merged.buffer);
  const o = sm.cards.find(c => /ours shipped/.test(c.text || ''));
  const t = sm.cards.find(c => /theirs cut/.test(c.text || ''));
  ok(o?.createdSession === A && t?.createdSession === B, 'AO7 a three-way merge keeps both sides\' createdSession');
}

// ── AO8 — the real Stop hook + brief ─────────────────────────────────────────
{
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
  const MK = String.fromCodePoint(0x1F9E0) + ' BRAIN';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-ao-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-ao-proj-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    const brainFile = path.join(proj, 'brain.klypix');
    fs.writeFileSync(brainFile, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain') };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    let n = 0;
    const stop = (text, sid) => {
      const tp = path.join(home, `t-${n++}.jsonl`);
      fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
      return spawnSync(process.execPath, [HOOK, '--capture'], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: sid, transcript_path: tp, stop_hook_active: true }) });
    };
    const r1 = stop(`${MK} [iOS]: ! iOS 1.1.5 build 78 submitted to App Review from the store branch`, 'sess-asker-0001');
    const r2 = stop(`${MK} [iOS]: ! klypix-ios pull 95 bumps the marketing version to 1.1.6 for the AI switch`, 'sess-other-0002');
    const { struct: sh } = await parseKlypix(fs.readFileSync(brainFile));
    const c1 = sh.cards.find(c => /build 78 submitted/.test(flat(c.text)));
    const c2 = sh.cards.find(c => /marketing version to 1\.1\.6/.test(flat(c.text)));
    ok(c1?.createdSession === 'sess-asker-0001', `AO8 the Stop hook stamps its own session on a marker card (exit ${r1.status})`);
    ok(c2?.createdSession === 'sess-other-0002', `AO8 … and another session's Stop stamps that session (exit ${r2.status})`);
    const brief = structToBrief(sh, { sessions: ownershipSessionsFromLane({ live: [{ id: 'sess-other-0002', client: 'claude-code', hostStatus: 'idle', hostStatusAt: Date.now(), lastSeen: Date.now() }] }), askerId: 'sess-asker-0001' });
    ok(/## Area status \(computed — newest 🏁 \+ open count \+ owner = the session with the newest card per active area\)/.test(brief), 'AO8 the brief\'s area header names the owner column');
    ok(/- iOS — .* · owner Claude Code sess-oth/.test(brief) && /## ↪ Taken over from you \(1\)/.test(brief), 'AO8 the brief shows the owner and the asker\'s takeover');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

// ── AO9 — brain_ask status mode carries the same view ────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-ao-ask-'));
  try {
    const brain = path.join(root, 'project', 'brain.klypix');
    fs.mkdirSync(path.dirname(brain), { recursive: true });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HOME: root, USERPROFILE: root, KLYPIX_BRAIN_DIR: path.join(root, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0', KLYPIX_AO_CHILD: '1', KLYPIX_AO_BRAIN: brain },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    let out = null;
    try { out = JSON.parse(child.stdout); } catch { console.error({ status: child.status, stderr: String(child.stderr || '').slice(-1500) }); }
    const text = out ? out.text : '';
    ok(/↪ \[iOS\] taken over by Codex ask-othe \(/.test(text), 'AO9 brain_ask status mode gives the asker its ↪ line, joined to the live lane');
    ok(/👤area held by Codex ask-othe/.test(text), 'AO9 … and flags the open iOS item');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall area-ownership checks passed');
process.exit(failures ? 1 : 0);
