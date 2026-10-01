// Session mailbox (1.88.0) — every session gets a door with a mailbox.
//
// THE contract under test (2026-09-30 field case: Codex could not reach a
// Claude session that had closed, and the human became the courier):
//   1. the lane REMEMBERS every exactly-identified session for two weeks
//      (the directory) — provisional connection ids are never remembered;
//   2. a directed note to a session that is NOT running is QUEUED for that id
//      (7d) instead of refused, and the sender is told which — with the resume
//      command a human could paste; an unknown id is 'target-unknown', an
//      ambiguous one still fails closed, a broadcast still needs a live peer;
//   3. the queued note is delivered the moment the session is back, marked as
//      left while it was away; a live note keeps its 24h, a queued one its 7d;
//   4. rows carry a host status ("working" / "idle 14m") that every renderer
//      and the send receipt use;
//   5. the Claude hook twin (global-brain-hook.mjs) does the same for the
//      `🧠 MSG` marker — including a next-prompt receipt saying sent / queued /
//      refused, and "📨 your note waiting" + status in the peer footer.
//
// Run:  node test/session-mailbox.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  DIRECTORY_FRESH_MS,
  MESSAGE_OFFLINE_FRESH_MS,
  endSession,
  formatPresenceMessage,
  formatReceivedMessages,
  laneFileFor,
  listActiveSessions,
  listKnownSessions,
  messageDeliveryState,
  postPresenceMessage,
  receiveMessages,
  resumeCommandFor,
  sessionStatusLabel,
  upsertSession,
} from '../src/agent-presence.mjs';
import { renderReceiptSummary, summarizeReceipts } from '../src/finding-routing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };

// ── A. Engine: directory, offline queue, expiry, delivery, status ─────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-mailbox-'));
try {
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const brainPath = path.join(project, 'brain.klypix');
  fs.writeFileSync(brainPath, 'fixture');
  const readLane = () => JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  const laneMessage = (id) => readLane().messages.find((m) => m.id === id);

  const now = 2_300_000_000_000;
  const sender = 'sender-session-0001';
  const owner = '0abcdef0-1111-2222-3333-444444444444';   // the Claude session that owns the films
  const codexOwner = '01a0f13e-2f0e-7650-9465-7a573fed3140';
  const liveSender = (at) => upsertSession({ brainPath, home, now: at, id: sender, client: 'codex', channel: 'mcp',
    event: 'McpTaskStart', logicalSessionId: sender, identitySource: 'mcp-request', intent: 'voice-over package' });

  // A1 — an exactly-identified session is remembered, with what it owns.
  upsertSession({ brainPath, home, now, id: owner, client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit',
    logicalSessionId: owner, identitySource: 'claude-lifecycle', intent: 'render the four social films',
    files: ['admin/films/social/make.cjs'], observedFiles: ['admin/films/social/vo-kit/READY.json'], branch: 'master' });
  let entry = readLane().directory.find((e) => e.id === owner);
  ok(entry && entry.client === 'claude-code' && entry.intent === 'render the four social films',
    'A1 the directory remembers an exactly-identified session with its client and intent');
  ok(entry.files.includes('admin/films/social/make.cjs') && entry.files.includes('admin/films/social/vo-kit/READY.json'),
    'A1 the directory entry carries declared and observed scope');
  ok(entry.hostStatus === 'busy' && readLane().sessions.find((s) => s.id === owner).hostStatus === 'busy',
    'A1 a prompt event stamps hostStatus busy on the row and the directory');

  // A2 — a provisional MCP connection id is not a door.
  upsertSession({ brainPath, home, now, id: 'mcp-4242-abc123', client: 'codex', channel: 'mcp', event: 'McpHeartbeat' });
  ok(!readLane().directory.some((e) => e.id === 'mcp-4242-abc123'), 'A2 a provisional connection id is never remembered');

  // A3 — status words.
  ok(sessionStatusLabel(readLane().sessions.find((s) => s.id === owner), now) === 'working', 'A3 busy renders as "working"');
  upsertSession({ brainPath, home, now: now + MIN, id: owner, client: 'claude-code', channel: 'lifecycle', event: 'Stop' });
  const idleRow = readLane().sessions.find((s) => s.id === owner);
  ok(idleRow.hostStatus === 'idle' && sessionStatusLabel(idleRow, now + 15 * MIN) === 'idle 14m',
    'A3 Stop stamps idle and the label carries the idle age');
  upsertSession({ brainPath, home, now: now + 2 * MIN, id: owner, client: 'claude-code', channel: 'mcp', event: 'McpHeartbeat' });
  ok(readLane().sessions.find((s) => s.id === owner).hostStatus === 'idle', 'A3 a heartbeat keeps the previous status');
  ok(formatPresenceMessage(listActiveSessions({ brainPath, home, now: now + 3 * MIN }), sender, { now: now + 3 * MIN })
    .includes('Claude Code | idle 2m'), 'A3 the presence block shows the peer status');
  // An MCP-only host never stamps idle: a busy stamp is believed for ten minutes only.
  ok(sessionStatusLabel({ hostStatus: 'busy', hostStatusAt: now }, now + 9 * MIN) === 'working'
    && sessionStatusLabel({ hostStatus: 'busy', hostStatusAt: now }, now + 11 * MIN) === 'idle 11m',
    'A3 "working" ages out after ten minutes without a new stamp');

  // A4 — a live directed send names the recipient and its state.
  liveSender(now + 3 * MIN);
  const live = postPresenceMessage({ brainPath, home, now: now + 3 * MIN, from: sender, to: owner.slice(0, 8), text: 'kit is ready', allowKnownOfflineTarget: true });
  ok(live.posted && !live.queuedOffline && live.recipients[0].id === owner && live.recipients[0].live
    && live.recipients[0].client === 'claude-code' && live.recipients[0].statusLabel === 'idle 2m',
    'A4 a live directed send reports the recipient, its client and its status');
  ok(!laneMessage(live.message.id).offline && laneMessage(live.message.id).expiresAt === now + 3 * MIN + MESSAGE_OFFLINE_FRESH_MS,
    'A4 a live DIRECTED note is not marked offline but is kept 7 days (its session may close before acting)');

  // A5 — the owner closes (no SessionEnd — a Claude session just stops heartbeating).
  const gone = now + 40 * MIN;
  liveSender(gone);
  ok(!listActiveSessions({ brainPath, home, now: gone }).some((s) => s.id === owner), 'A5 the owner row has aged out of the lane');
  const queued = postPresenceMessage({ brainPath, home, now: gone, from: sender, to: owner.slice(0, 8), text: 'VO kit not exported — please finish and drop READY.json', allowKnownOfflineTarget: true });
  ok(queued.posted && queued.queuedOffline === true && queued.message.candidateIds.length === 1 && queued.message.candidateIds[0] === owner,
    'A5 a note to a remembered session that is not running is QUEUED for its exact id');
  ok(queued.message.offline.target.id === owner && queued.message.expiresAt === gone + MESSAGE_OFFLINE_FRESH_MS,
    'A5 the queued note records its target and a 7-day deadline');
  ok(queued.recipients[0].live === false && /^not seen for \d+m$/.test(queued.recipients[0].statusLabel)
    && queued.recipients[0].resumeCommand === `claude --resume ${owner}`,
    `A5 the sender learns how long the session has been quiet and how a human could reopen it (${queued.recipients[0].statusLabel})`);
  ok(resumeCommandFor('claude-code', 'x; rm -rf ~') === '' && resumeCommandFor('codex', '$(curl evil)') === '',
    'A5 a resume command is only ever built from an identifier-shaped id');
  ok(resumeCommandFor('codex', codexOwner) === `codex resume ${codexOwner}` && resumeCommandFor('cursor', 'x') === '',
    'A5 resume commands exist only for hosts whose resume-by-id was verified');

  // A6–A10 — refusals stay honest.
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: owner.slice(0, 8), text: 'compat' }).reason === 'target-not-unique',
    'A6 without the mailbox flag the old refusal is unchanged');
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: 'nobody-knows-this-one', text: 'x', allowKnownOfflineTarget: true }).reason === 'target-unknown',
    'A7 an id nobody has seen is target-unknown, never a silent queue');
  for (const dup of ['dupdup00-1111-2222-3333-444444444444', 'dupdup00-5555-6666-7777-888888888888']) {
    upsertSession({ brainPath, home, now: now + MIN, id: dup, client: 'claude-code', channel: 'lifecycle', event: 'SessionStart', logicalSessionId: dup, identitySource: 'claude-lifecycle' });
  }
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: 'dupdup00', text: 'x', allowKnownOfflineTarget: true }).reason === 'target-not-unique',
    'A8 an ambiguous prefix over the directory fails closed');
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: sender, text: 'x', allowKnownOfflineTarget: true }).reason === 'target-not-unique',
    'A9 a session cannot queue a note to itself');
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: 'all', text: 'x', allowKnownOfflineTarget: true }).reason === 'no-live-recipients',
    'A10 a broadcast still needs a live peer — the mailbox is directed only');
  ok(postPresenceMessage({ brainPath, home, now: gone, from: sender, to: 'ALL', text: 'x', allowKnownOfflineTarget: true }).reason === 'no-live-recipients',
    'A10 "ALL" is a broadcast too — never target-unknown / target-not-unique');
  // The machine path (release-claim notices) keeps its 1.87 semantics: an exact
  // id split across two live rows is still queued to that id, not refused.
  for (const conn of ['split-conn-a-0001', 'split-conn-b-0002']) {
    upsertSession({ brainPath, home, now: gone, id: conn, client: 'codex', channel: 'mcp', event: 'McpHeartbeat', logicalSessionId: 'split-logical-id-0009', identitySource: 'mcp-request' });
  }
  const machine = postPresenceMessage({ brainPath, home, now: gone, from: sender, to: 'split-logical-id-0009', text: 'claim fulfilled', allowOfflineTarget: true });
  ok(machine.posted && machine.message.candidateIds.length === 1 && machine.message.candidateIds[0] === 'split-logical-id-0009',
    'A10 the machine-addressed path still queues an exact id that is split across two live rows');

  // A11 — the sender's receipt says "waiting", not "0 of 1".
  const receiptsNow = summarizeReceipts({ messages: readLane().messages, sessions: readLane().sessions, selfId: sender, now: gone + MIN });
  const waitingReceipt = receiptsNow.receipts.find((r) => r.id === queued.message.id);
  ok(waitingReceipt.queuedOffline === true && waitingReceipt.offlineTarget.id === owner, 'A11 summarizeReceipts exposes the queued target');
  const waitingLine = renderReceiptSummary({ receipts: [waitingReceipt] });
  ok(/waiting — that session was not on the lane when you sent it/.test(waitingLine) && /delivered the moment that session next acts/.test(waitingLine),
    `A11 the receipt line says the note is waiting (${waitingLine})`);
  // The three ways a queued note ends unconsumed are different facts.
  const synthetic = (extra) => ({ receipts: [{ ...waitingReceipt, failed: 1, ...extra }] });
  ok(/dropped when the lane was full/.test(renderReceiptSummary(synthetic({ deadLetterReason: 'lane-capacity-overflow', failedReasons: ['lane-capacity-overflow (never delivered)'] }))),
    'A11 an overflow eviction is reported as a full lane, not as an expiry');
  ok(/shown once to that session after it came back/.test(renderReceiptSummary(synthetic({ deadLetterReason: 'expired-before-consumption', failedReasons: ['expired-before-consumption (offered once, unconfirmed)'] }))),
    'A11 a note that was shown once and then expired says so');

  // A12 — the owner comes back: the note is offered on its first action.
  const back = gone + 2 * HOUR;
  upsertSession({ brainPath, home, now: back, id: owner, client: 'claude-code', channel: 'lifecycle', event: 'SessionStart', logicalSessionId: owner, identitySource: 'claude-lifecycle' });
  // Two notes are due: the live one from A4 the owner never got to see, and
  // the queued one — pending-first ordering offers both on this action.
  const offered = receiveMessages({ brainPath, home, now: back, sessionId: owner, actionId: 'owner-start-1' });
  ok(offered.some((m) => m.id === queued.message.id) && messageDeliveryState(laneMessage(queued.message.id), owner) === 'offered',
    'A12 the queued note is offered on the owner\'s first action after it starts again');
  const rendered = formatReceivedMessages(offered, back, {}, owner);
  ok(/VO kit not exported/.test(rendered) && /left while this session was not running\): VO kit not exported/.test(rendered)
    && !/left while this session was not running\): kit is ready/.test(rendered),
    'A12 only the note that waited is marked as left while the session was away');
  ok(readLane().directory.find((e) => e.id === owner).endedAt === null, 'A12 a live touch clears any closed mark');

  // A13 — a closed (SessionEnd) Codex thread is a door too, stamped closed.
  upsertSession({ brainPath, home, now: gone + 5 * MIN, id: codexOwner, client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: codexOwner, identitySource: 'codex-lifecycle', intent: 'prepare the voice-over package' });
  endSession({ brainPath, home, now: gone + 6 * MIN, id: codexOwner });
  ok(readLane().directory.find((e) => e.id === codexOwner)?.endedAt === gone + 6 * MIN, 'A13 SessionEnd stamps the directory entry closed');
  liveSender(gone + 7 * MIN);
  const queued2 = postPresenceMessage({ brainPath, home, now: gone + 7 * MIN, from: sender, to: codexOwner.slice(0, 8), text: 'timing kit changed — re-read the brief', allowKnownOfflineTarget: true });
  ok(queued2.posted && queued2.queuedOffline && queued2.recipients[0].statusLabel === 'closed' && queued2.recipients[0].resumeCommand === `codex resume ${codexOwner}`,
    'A13 a note to a closed Codex thread is queued and the sender gets the resume command');
  const known = listKnownSessions({ brainPath, home, now: back });
  const knownCodex = known.find((k) => k.id === codexOwner);
  ok(knownCodex && knownCodex.live === false && knownCodex.status === 'closed' && knownCodex.waitingNotes === 1,
    'A13 listKnownSessions shows the closed thread with one note waiting');
  ok(known.find((k) => k.id === owner)?.live === true, 'A13 listKnownSessions marks the revived owner live');

  // A14 — expiry: a broadcast dies at 24h; every DIRECTED note is kept 7 days,
  // whether its session was away at send time or closes after.
  const liveNote = postPresenceMessage({ brainPath, home, now: back, from: sender, to: owner, text: 'directed note at the moment of return', allowKnownOfflineTarget: true });
  ok(liveNote.posted && !liveNote.queuedOffline, 'A14 the owner is live again, so a new directed note is a live note');
  const shout = postPresenceMessage({ brainPath, home, now: back, from: sender, to: 'ALL', text: 'broadcast at the moment of return', allowKnownOfflineTarget: true });
  ok(shout.posted && shout.message.to === 'all' && shout.message.expiresAt === undefined && shout.message.candidateIds.includes(owner),
    'A14 "ALL" posts a broadcast stored as "all" with the 24h rule');
  liveSender(back + 25 * HOUR);
  ok(Boolean(laneMessage(shout.message.id).deadLetter)
    && !laneMessage(liveNote.message.id).deadLetter && !laneMessage(liveNote.message.id).retiredAt
    && !laneMessage(queued2.message.id).deadLetter && !laneMessage(queued2.message.id).retiredAt,
    'A14 at 25h the broadcast has expired while both directed notes are still kept');
  liveSender(gone + 7 * DAY + HOUR);
  const expired = laneMessage(queued2.message.id);
  ok(expired.deadLetter?.reason === 'expired-before-consumption', 'A14 a queued note expires after 7 days');
  const expiredSummary = summarizeReceipts({ messages: readLane().messages, sessions: readLane().sessions, selfId: sender, now: gone + 7 * DAY + HOUR, ttlMs: 30 * DAY });
  const expiredLine = renderReceiptSummary({ receipts: [expiredSummary.receipts.find((r) => r.id === queued2.message.id)] });
  ok(/not delivered — that session \(closed/.test(expiredLine), `A14 the expired receipt names the closed session (${expiredLine})`);

  // A15 — the directory forgets after two weeks.
  liveSender(now + DIRECTORY_FRESH_MS + 2 * DAY);
  ok(!readLane().directory.some((e) => e.id === codexOwner), 'A15 entries older than two weeks are pruned');
  console.log('\n[ok] engine: directory, offline queue, expiry, delivery, status');
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ── B. Hook twin, in-process: touchSession + postMessages + messageFooter ─────
const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-mailbox-hook-'));
const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NO_MAIN: process.env.KLYPIX_BRAIN_NO_MAIN, CLAUDE_PID: process.env.CLAUDE_PID };
const prevCwd = process.cwd();
try {
  const projectB = path.join(homeB, 'project');
  fs.mkdirSync(projectB, { recursive: true });
  fs.writeFileSync(path.join(projectB, 'brain.klypix'), 'fixture');
  process.env.HOME = homeB;
  process.env.USERPROFILE = homeB;
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';
  process.env.CLAUDE_PID = '424243';
  process.chdir(projectB);
  const hookUrl = new URL('../src/global-brain-hook.mjs', import.meta.url);
  hookUrl.searchParams.set('mailbox-test', String(Date.now()));
  const { SESSIONS_FILE, messageFooter, postMessages, touchSession } = await import(hookUrl.href);
  const readLaneB = () => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  const ownerB = 'b0b0b0b0-1111-2222-3333-444444444444';
  const senderB = 'claude-sender-session-0002';

  touchSession(ownerB, { intent: 'social films', branch: 'master', humanPrompt: true, hostStatus: 'busy' });
  let laneB = readLaneB();
  ok(laneB.directory.some((e) => e.id === ownerB && e.client === 'claude-code' && e.hostStatus === 'busy')
    && laneB.sessions.find((s) => s.id === ownerB).hostStatus === 'busy',
    'B1 the hook remembers its session in the directory and stamps busy');
  touchSession(ownerB, { hostStatus: 'idle' });
  ok(readLaneB().sessions.find((s) => s.id === ownerB).hostStatus === 'idle', 'B2 a Stop-shaped touch stamps idle');

  // The owner closes: its row ages out (rewrite the heartbeat 31 minutes back).
  laneB = readLaneB();
  for (const s of laneB.sessions) {
    if (s.id !== ownerB) continue;
    s.lastSeen = Date.now() - 31 * MIN;
    s.channelSeen = { lifecycle: Date.now() - 31 * MIN };
  }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(laneB));
  touchSession(senderB, { intent: 'coordinate the films', branch: 'master', humanPrompt: true, hostStatus: 'busy' });
  ok(!readLaneB().sessions.some((s) => s.id === ownerB), 'B3 the owner row is gone from the live lane');
  const marker = (id, to, text) => ({ id, from: senderB, to, text, ts: Date.now(), seen: [], deliveryVersion: 3, deliveries: [] });
  const posted = postMessages([marker('mailbox-hook-1', ownerB.slice(0, 8), 'the timing kit changed — re-read the brief')]);
  ok(posted.ok && posted.posted === 1 && posted.outcomes?.[0]?.status === 'queued-offline'
    && posted.outcomes[0].recipient.id === ownerB && posted.outcomes[0].recipient.resumeCommand === `claude --resume ${ownerB}`,
    'B3 a 🧠 MSG to a remembered closed session is queued and the outcome names the resume command');
  const stored = readLaneB().messages.find((m) => m.id === 'mailbox-hook-1');
  ok(stored?.offline?.target?.id === ownerB && Number(stored.expiresAt) > Date.now() + 6 * DAY,
    'B3 the hook stores the same offline shape and 7-day deadline as the engine');
  const unknown = postMessages([marker('mailbox-hook-2', 'never-seen-session', 'x')]);
  ok(unknown.ok === false && unknown.reason === 'target-unknown', 'B4 an id nobody has seen is target-unknown on the hook lane too');

  // The owner comes back: its first prompt-shaped action offers the note.
  touchSession(ownerB, { branch: 'master', hostStatus: 'idle' });
  const footer = messageFooter(ownerB, undefined, {}, 'owner-back-action-1');
  ok(footer.includes('the timing kit changed') && footer.includes('left while this session was not running'),
    'B5 the revived session is offered the queued note, marked as left while it was away');
  console.log('\n[ok] hook twin: directory, queued 🧠 MSG, delivery on return');
} finally {
  process.chdir(prevCwd);
  process.env.HOME = prevEnv.HOME;
  process.env.USERPROFILE = prevEnv.USERPROFILE;
  if (prevEnv.NO_MAIN === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = prevEnv.NO_MAIN;
  if (prevEnv.CLAUDE_PID === undefined) delete process.env.CLAUDE_PID; else process.env.CLAUDE_PID = prevEnv.CLAUDE_PID;
  fs.rmSync(homeB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ── C. The REAL hook: Stop-time receipts on the next prompt, peer-footer status ─
const homeC = path.join(os.tmpdir(), `klypix-mailbox-real-${process.pid}`);
const projC = path.join(homeC, 'project');
fs.rmSync(homeC, { recursive: true, force: true });
fs.mkdirSync(path.join(homeC, '.claude', 'project-brain'), { recursive: true });
fs.mkdirSync(projC, { recursive: true });
try {
  const brainC = path.join(projC, 'brain.klypix');
  fs.writeFileSync(brainC, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
  const laneC = laneFileFor(brainC, homeC);
  const env = { ...process.env, HOME: homeC, USERPROFILE: homeC, KLYPIX_BRAIN_NUDGE: 'off' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  delete env.CLAUDE_PID;
  let seq = 0;
  const prompt = (sid) => execFileSync(process.execPath, [HOOK, '--prompt'], {
    cwd: projC, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, event_id: `mailbox-real-${++seq}`, prompt: 'continue the films' }),
  });
  const capture = (sid, transcript) => execFileSync(process.execPath, [HOOK, '--capture'], {
    cwd: projC, env, encoding: 'utf8', input: JSON.stringify({ session_id: sid, transcript_path: transcript }),
  });
  const ownerC = 'c0c0c0c0-1111-2222-3333-444444444444';
  const senderC = 'claude-sender-real-0003';

  prompt(ownerC);                       // the owner is live and remembered
  const laneNow = JSON.parse(fs.readFileSync(laneC, 'utf8'));
  for (const s of laneNow.sessions) {   // …then closes (heartbeat aged out)
    if (s.id !== ownerC) continue;
    s.lastSeen = Date.now() - 31 * MIN;
    s.channelSeen = { lifecycle: Date.now() - 31 * MIN };
  }
  fs.writeFileSync(laneC, JSON.stringify(laneNow));
  prompt(senderC);
  const transcript = path.join(homeC, 'sender-transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    uuid: 'assistant-event-mailbox-1',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `🧠 MSG [${ownerC.slice(0, 8)}]: VO kit not exported — please finish and drop READY.json` }] },
  }) + '\n');
  capture(senderC, transcript);
  const afterCapture = JSON.parse(fs.readFileSync(laneC, 'utf8'));
  const realNote = afterCapture.messages.find((m) => m.text.includes('VO kit not exported'));
  ok(realNote?.offline?.target?.id === ownerC && realNote.candidateIds[0] === ownerC,
    'C1 the Stop hook queues a 🧠 MSG for a remembered session that is not running');
  const senderNext = prompt(senderC);
  ok(senderNext.includes('Your notes to other sessions') && /QUEUED/.test(senderNext) && senderNext.includes(`claude --resume ${ownerC}`),
    'C1 the sender\'s next prompt says the note is QUEUED and shows the resume command');
  ok(!prompt(senderC).includes('Your notes to other sessions'), 'C1 the receipt is shown once');

  // The owner's window is back and working (a tool call), but has not been
  // prompted yet: its row is live, the note is still pending.
  execFileSync(process.execPath, [HOOK, '--live'], {
    cwd: projC, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: ownerC, tool_name: 'Edit', tool_input: { file_path: path.join(projC, 'src', 'films.ts') } }),
  });
  const senderView = prompt(senderC);
  ok(/session c0c0c0c0[^\n]*working[^\n]*📨 your note waiting/.test(senderView),
    'C2 the peer footer shows the owner working with the sender\'s note still waiting');
  const ownerBack = prompt(ownerC);      // delivered on the owner's first prompt
  ok(ownerBack.includes('VO kit not exported') && ownerBack.includes('left while this session was not running'),
    'C2 the revived owner receives the queued note on its first prompt');
  ok(!prompt(senderC).includes('your note waiting'),
    'C2 once the note has been offered it is no longer shown as waiting');
  console.log('\n[ok] real hook: queued marker, next-prompt receipt, delivery on return, peer status');
} finally {
  fs.rmSync(homeC, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n[ok] session-mailbox: all ${checks} assertions passed`);
