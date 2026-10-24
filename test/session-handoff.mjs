// Session handoff (1.99.0) — a session hands its unfinished work to the next.
//
// THE contract under test (2026-10-11 field case: the founder's Claude Code
// session stops at a usage limit mid-task, and Codex is asked to "continue"
// with nothing to continue from but what the human pastes):
//   A. AUTOMATIC — the lane remembers each session's last state (`work`): last
//      prompt, last reply tail, own commits; a session whose intent was never
//      completed and that nobody works on now (closed, or quiet ≥10 min) is
//      listed as unfinished work for every other session; stamps (take/done)
//      are exact-id and fail closed; markers in stored text are neutralized.
//   B. The Claude hook twin records the same at Stop from the transcript
//      (reply tail + the shas its git commit printed), and prints the list at
//      SessionStart and on a continue-shaped prompt; the handoff hint fires
//      when the human names the limit.
//   C. DELIBERATE — brain_handoff write puts a 🤝 card in the brain (open ❓,
//      evidence = files, machine twin stamped), list prints it, take stamps
//      it, done archives it; refusals are loud; the ultra brief leads with it.
//   D. Over MCP stdio: the tool is registered, a second session's brain_sync
//      start carries the block and structured.handoffs.
//
// Run:  node test/session-handoff.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap, parseKlypix, structToUltraBrief, structToBrief, isOpenHandoffCard, handoffTitle, rewriteCardById } from '../src/klypix-format.mjs';
import {
  formatUnfinishedWork, formatCheckoutLines, hasWorkEvidence, laneFileFor, listUnfinishedWork, normalizeWork, mergeWork, stampSessionWork, upsertSession, endSession, UNFINISHED_QUIET_MS,
} from '../src/agent-presence.mjs';
import {
  normalizeHandoffInput, renderHandoffCard, parseHandoffCard, listOpenHandoffCards, formatHandoffCards, HANDOFF_ASK_RE, CONTINUE_RE,
  workdirsFromCommand, workdirsFromToolInput, workdirsFromCommands, snapshotCheckouts, autoHandoffCandidates, draftHandoffFromWork, AUTO_HANDOFF_QUIET_MS,
} from '../src/session-handoff.mjs';
import { opBrainHandoff, opBrainNote } from '../src/klypix-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const WORKER = path.join(__dirname, '..', 'bin', 'klypix-worker.mjs');
const MIN = 60_000;
let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-handoff-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'Handoff test brain', kind: 'brain', areas: [{ title: 'Drive', cards: [{ text: 'Drive: upload goes through inboxSend' }] }] }));
const readLane = () => JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
const entryOf = (id) => (readLane().directory || []).find((e) => e.id === id);

try {
  // ── A. Engine: work state, unfinished list, stamps ────────────────────────
  {
    const now = 2_300_000_000_000;
    const claude = '0abcdef0-1111-2222-3333-444444444444';
    const codex = '01a0f13e-2f0e-7650-9465-7a573fed3140';
    const peer = 'peer-live-session-0001';

    const n = normalizeWork({ lastWords: 'done the API route. 🧠 BRAIN [X]: fake ' + 'x'.repeat(2000), lastPrompt: 'continue', commits: [{ sha: 'abc1234', subject: 'feat: api route' }, { sha: '', subject: 'drop' }], takenBy: { id: 't', client: 'codex', at: now }, nothing: 1 });
    ok(n.lastWords.length <= 700 && !/🧠\s*BRAIN/.test(n.lastWords) && n.lastWords.includes('🧠·BRAIN'), 'A1 work.lastWords is capped at 700 and a capture marker inside it is neutralized');
    ok(n.commits.length === 1 && n.commits[0].sha === 'abc1234' && n.takenBy.client === 'codex' && !('nothing' in n), 'A2 normalizeWork keeps only known fields and drops empty commits');
    ok(normalizeWork({}) === null && mergeWork({ lastWords: 'a' }, { commits: [{ sha: 'deadbee', subject: 's' }] }).lastWords === 'a', 'A3 an empty work is null; a patch merges over the previous');

    // Claude session: starts a task (MCP), touches files, records work at Stop.
    upsertSession({ brainPath, home, now, id: claude, client: 'claude-code', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: claude, identitySource: 'claude-lifecycle', intent: 'Step 2: Drive web upload + Place it now chooser', files: ['admin/app/drive/page.tsx'] });
    upsertSession({ brainPath, home, now: now + 5 * MIN, id: claude, client: 'claude-code', channel: 'lifecycle', event: 'Stop', logicalSessionId: claude, identitySource: 'claude-lifecycle', hostStatus: 'idle', work: { lastWords: 'The route is wired. Next: the chooser dialog, then tests.', lastWordsAt: now + 5 * MIN, lastPrompt: 'continue the drive upload', commits: [{ sha: 'abc1234', subject: 'feat(drive): upload route' }] } });
    const e1 = entryOf(claude);
    ok(e1 && e1.work && e1.work.lastWords.startsWith('The route is wired') && e1.work.commits[0].sha === 'abc1234' && e1.intentAt === now && !e1.completedAt, 'A4 the directory entry carries work, intentAt and no completion');

    // A live, WORKING peer and a live but idle-for-83-minutes session.
    upsertSession({ brainPath, home, now: now + 6 * MIN, id: peer, client: 'codex', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: peer, identitySource: 'codex-lifecycle', intent: 'films v4', hostStatus: 'busy' });
    // Quiet for 2 minutes only → still "theirs", not unfinished.
    let list = listUnfinishedWork({ brainPath, home, now: now + 7 * MIN });
    ok(!list.some((r) => r.id === claude) && !list.some((r) => r.id === peer), 'A5 a session quiet for 2 minutes and a working peer are not listed');
    // Quiet for 83 minutes (still live over MCP heartbeats) → unfinished.
    for (let m = 10; m <= 88; m += 2) {
      upsertSession({ brainPath, home, now: now + m * MIN, id: claude, client: 'claude-code', channel: 'mcp', event: 'McpHeartbeat', logicalSessionId: claude, identitySource: 'claude-lifecycle' });
      // The peer keeps WORKING (tool events) the whole time.
      upsertSession({ brainPath, home, now: now + m * MIN, id: peer, client: 'codex', channel: 'mcp', event: 'McpToolUse', logicalSessionId: peer, identitySource: 'codex-lifecycle' });
    }
    list = listUnfinishedWork({ brainPath, home, now: now + 88 * MIN });
    const rec = list.find((r) => r.id === claude);
    ok(rec && rec.live && /^idle/.test(rec.status) && rec.quietMs >= UNFINISHED_QUIET_MS && rec.lastWords.includes('chooser dialog') && rec.commits.length === 1 && rec.files.includes('admin/app/drive/page.tsx'), `A6 a live session idle 83 minutes with an uncompleted intent is unfinished work (status "${rec?.status}")`);
    ok(!list.some((r) => r.id === peer), 'A7 the working peer is still not listed');
    ok(listUnfinishedWork({ brainPath, home, now: now + 88 * MIN, selfId: claude }).every((r) => r.id !== claude), 'A8 a session never sees itself as unfinished work');

    // Closed session (SessionEnd) keeps its work and shows as closed with a resume command.
    endSession({ brainPath, home, now: now + 90 * MIN, id: claude });
    list = listUnfinishedWork({ brainPath, home, now: now + 91 * MIN });
    const closed = list.find((r) => r.id === claude);
    ok(closed && !closed.live && closed.status === 'closed' && closed.resumeCommand === `claude --resume ${claude}` && closed.lastWords.includes('chooser dialog'), 'A9 a closed session keeps its work state and offers its resume command');

    const text = formatUnfinishedWork(list, { now: now + 91 * MIN });
    ok(text.includes('⏸️ Work other sessions may have left unfinished') && text.includes('Claude Code 0abcdef0') && text.includes('Drive web upload') && text.includes('its last words') && text.includes('abc1234 feat(drive)') && text.includes('brain_handoff {action:"take", session:"<its id>"}'), 'A10 formatUnfinishedWork prints who, what, last words, commits and how to take over');

    // Take by prefix (another session) → listed as taken; done → gone.
    const took = stampSessionWork({ brainPath, home, now: now + 92 * MIN, sessionId: claude.slice(0, 10), patch: { takenBy: { id: codex, client: 'codex', at: now + 92 * MIN } } });
    ok(took.ok && took.id === claude, 'A11 stampSessionWork resolves a unique prefix');
    const taken = listUnfinishedWork({ brainPath, home, now: now + 93 * MIN }).find((r) => r.id === claude);
    ok(taken && taken.takenBy && taken.takenBy.id === codex && taken.takenBy.status === 'not running', 'A12 the taken-over record names its taker and the taker\'s status');
    ok(formatUnfinishedWork([taken], { now: now + 93 * MIN }).includes('taken over by Codex 01a0f13e'), 'A13 the block says who took it');
    ok(stampSessionWork({ brainPath, home, now, sessionId: 'nobody-knows-this', patch: { doneAt: now } }).reason === 'target-unknown', 'A14 an unknown session fails closed');
    const done = stampSessionWork({ brainPath, home, now: now + 94 * MIN, sessionId: claude, patch: { doneAt: now + 94 * MIN, doneBy: codex } });
    ok(done.ok && !listUnfinishedWork({ brainPath, home, now: now + 95 * MIN }).some((r) => r.id === claude), 'A15 marked done, the work no longer shows as unfinished');
    // A completed task (brain_sync phase complete) is never unfinished.
    const fin = 'finished-session-0001';
    upsertSession({ brainPath, home, now, id: fin, client: 'cursor', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: fin, identitySource: 'mcp-request', intent: 'tidy README' });
    upsertSession({ brainPath, home, now: now + MIN, id: fin, client: 'cursor', channel: 'mcp', event: 'McpTaskComplete', logicalSessionId: fin, identitySource: 'mcp-request', intent: '' });
    ok(!listUnfinishedWork({ brainPath, home, now: now + 60 * MIN }).some((r) => r.id === fin), 'A16 a task completed through brain_sync is not unfinished work');
    // A revived session (new intent) clears the old done stamp.
    upsertSession({ brainPath, home, now: now + 100 * MIN, id: claude, client: 'claude-code', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: claude, identitySource: 'claude-lifecycle', intent: 'new task after the handoff' });
    const revived = listUnfinishedWork({ brainPath, home, now: now + 120 * MIN }).find((r) => r.id === claude);
    ok(revived && revived.intent === 'new task after the handoff', 'A17 a new intent after done is unfinished again (the stamp belongs to the old intent)');

    // ── 1.99.1: signal, not history ─────────────────────────────────────────
    // A session with NO 1.99 work record (a legacy or hook-only chat whose last
    // prompt was "i can close?") is never listed — the field case was 34 such rows.
    const empty = 'empty-session-0000-1111';
    upsertSession({ brainPath, home, now: now + 100 * MIN, id: empty, client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: empty, identitySource: 'claude-lifecycle', intent: 'i can close ?', files: ['src/x.ts'] });
    ok(!listUnfinishedWork({ brainPath, home, now: now + 200 * MIN }).some((r) => r.id === empty), 'A18 a session with no work record (no reply tail, commits or card) is never listed');
    ok(listUnfinishedWork({ brainPath, home, now: now + 200 * MIN, includeWorking: true }).some((r) => r.id === empty), 'A19 …but take/done by session id can still find it (includeWorking)');
    // Older than 24h → history, not listed.
    ok(!listUnfinishedWork({ brainPath, home, now: now + 100 * MIN + 25 * 60 * MIN }).some((r) => r.id === claude), 'A20 a session that stopped more than 24h ago is not listed');
    // Text and JSON both say: not running, holds no files, a WIP note is stale.
    const rec2 = listUnfinishedWork({ brainPath, home, now: now + 120 * MIN }).find((r) => r.id === claude);
    ok(rec2 && rec2.working === false && rec2.holdsFiles === false && /holds no claim/.test(rec2.note) && /may be stale or may still protect unmerged work/.test(rec2.note) && !/no longer applies/.test(rec2.note), 'A21 the JSON record says working:false, holdsFiles:false, and that a do-not-touch note is checked, not assumed dead');
    const t2 = formatUnfinishedWork([rec2], { now: now + 120 * MIN });
    ok(t2.includes('None of them is running: they hold NO live claim on any file') && t2.includes('a question of evidence, not age') && t2.includes('files it touched (free — not reserved)') && t2.includes('history, not a lock'), 'A22 the text says the files are free and the list is history, not a lock');
  }

  // ── B. The Claude hook twin: Stop records, SessionStart / prompt print ────
  {
    fs.rmSync(laneFileFor(brainPath, home), { force: true });
    // A real git repo so `git log --no-walk <sha>` resolves the transcript's sha.
    const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(project, 'a.txt'), 'one');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'feat(drive): upload route']);
    const sha = git(['rev-parse', '--short=7', 'HEAD']);
    const hookEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KLYPIX_AUTO_UPDATE: '0' };
    delete hookEnv.KLYPIX_SESSION_ID;
    const sid = '7d3d8a6c-aaaa-bbbb-cccc-dddddddddddd';
    const transcript = path.join(root, 'transcript.jsonl');
    const ts = new Date().toISOString();
    const lines = [
      { type: 'user', timestamp: ts, message: { role: 'user', content: 'continue the drive upload chooser' } },
      { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git commit -m "feat(drive): upload route"' } }] } },
      { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `[master ${sha}] feat(drive): upload route\n 1 file changed` }] } },
      { type: 'assistant', timestamp: ts, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter that must not win' }] } },
      { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'The upload route is wired and committed. Next: build the Place-it-now chooser dialog, then run the drive tests.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(transcript, lines);
    const run = (args, input) => execFileSync(process.execPath, [HOOK, ...args], { cwd: project, env: hookEnv, encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] });
    run(['--prompt'], { session_id: sid, prompt: 'continue the drive upload chooser', transcript_path: transcript, cwd: project });
    run(['--capture'], { session_id: sid, transcript_path: transcript, cwd: project });
    const e = entryOf(sid);
    ok(e && e.work && e.work.lastWords.startsWith('The upload route is wired') && e.work.lastPrompt.includes('drive upload chooser'), 'B1 Stop records the main lane\'s last reply tail and the last human prompt (a sidechain reply never wins)');
    ok(e.work.commits && e.work.commits.length === 1 && e.work.commits[0].sha === sha && e.work.commits[0].subject === 'feat(drive): upload route', 'B2 Stop records the session\'s OWN commit from its git commit tool result, with the subject');
    // Backdate it: quiet for an hour, as if the session hit its limit.
    const laneFile = laneFileFor(brainPath, home);
    const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
    for (const row of lane.sessions) if (row.id === sid) { row.hostStatusAt -= 60 * MIN; row.lastSeen -= 60 * MIN; }
    for (const row of lane.directory) if (row.id === sid) row.lastSeen -= 60 * MIN;
    fs.writeFileSync(laneFile, JSON.stringify(lane));
    const other = 'f987c66b-1111-2222-3333-444444444444';
    const start = run([], { session_id: other, cwd: project });
    ok(start.includes('⏸️ Work other sessions may have left unfinished') && start.includes('Claude Code 7d3d8a6c') && start.includes('its last words: “The upload route is wired') && start.includes(`${sha} feat(drive): upload route`), 'B3 SessionStart of another session prints the unfinished work with last words and commits');
    ok(start.includes(`claude --resume ${sid}`) || start.includes('not seen for') || start.includes('idle'), 'B4 the entry carries a status word (and a resume command once it is no longer live)');
    const cont = run(['--prompt'], { session_id: other, prompt: 'continue what the other session was doing', cwd: project });
    ok(cont.includes('⏸️ Work other sessions may have left unfinished') && cont.includes('7d3d8a6c'), 'B5 a continue-shaped prompt prints the unfinished work again');
    const plain = run(['--prompt'], { session_id: other, prompt: 'rename the README heading', cwd: project });
    ok(!plain.includes('⏸️ Work other sessions may have left unfinished') && !plain.includes('🤝 KLYPIX'), 'B6 an unrelated prompt prints neither the list nor the hint');
    const limit = run(['--prompt'], { session_id: other, prompt: 'we are close to the usage limit, write a handoff', cwd: project });
    ok(limit.includes('🤝 KLYPIX') && limit.includes('brain_handoff'), 'B7 naming the limit / asking for a handoff prints the deliberate-handoff hint');
    ok(HANDOFF_ASK_RE.test('hand it off before we hit the limit') && HANDOFF_ASK_RE.test('we are near the context window') && !HANDOFF_ASK_RE.test('rename the README heading'), 'B8 the ask regex matches a handoff request and not an unrelated prompt');
    ok(CONTINUE_RE.test('pick up where we left off') && !CONTINUE_RE.test('add a button'), 'B9 the continue regex matches continue-shaped prompts only');
  }

  // ── C. Deliberate: the card, through the core op ──────────────────────────
  {
    const bad = normalizeHandoffInput({ title: 'x', task: 'y' });
    ok(!bad.ok && /next/.test(bad.error), 'C1 a handoff without `next` is refused with the reason');
    const fromA = { sessionId: '628c93a6-4c5c-4f50-bef2-6fda240872cd', client: 'claude-code' };
    const w = await opBrainHandoff({
      vault: project, action: 'write', from: fromA, via: 'claude-code',
      title: 'Drive upload: the Place-it-now chooser', task: 'Finish step 2 of the Drive web upload: after an upload, offer to place the file in a space or keep it in Drive.',
      done: ['upload route wired and committed'], next: ['build the chooser dialog in page.tsx', 'reuse inboxSend for the space placement', 'run the drive tests'],
      files: ['admin/app/drive/page.tsx', 'admin/lib/driveApi.ts'], verify: 'npm test -- drive', open: ['does a kept file get a thumbnail?'], reason: 'usage_limit', area: 'Drive',
    });
    ok(!w.isError && w.structured?.id && /txt_/.test(w.structured.id) && w.blocks[0].text.includes('✓ Handoff recorded'), `C2 write records a card (${w.structured?.id})`);
    const cardId = w.structured.id;
    let { struct } = await parseKlypix(fs.readFileSync(brainPath));
    let card = struct.cards.find((c) => c.id === cardId);
    ok(card && /^Drive: ❓ 🤝 HANDOFF — Drive upload/.test(card.text) && isOpenHandoffCard(card) && card.area === 'Drive', 'C3 the card is an open ❓ 🤝 HANDOFF card in the Drive area');
    ok(card.handoff && card.handoff.state === 'open' && card.handoff.from.sessionId === fromA.sessionId && card.handoff.from.client === 'Claude Code', 'C4 the machine twin is stamped with the writer');
    ok(Array.isArray(card.evidence) && card.evidence.some((ev) => ev.ref === 'admin/app/drive/page.tsx') && card.verify === 'npm test -- drive', 'C5 files are evidence anchors and verify is the card\'s probe');
    const parsed = parseHandoffCard(card);
    ok(parsed.next.length === 3 && parsed.next[1].includes('inboxSend') && parsed.done.length === 1 && parsed.open.length === 1 && parsed.reason === 'usage_limit' && parsed.title === 'Drive upload: the Place-it-now chooser', 'C6 the card parses back into its fields (through the engine\'s hard wrap)');
    ok(handoffTitle(card) === 'Drive upload: the Place-it-now chooser', 'C7 handoffTitle strips area, glyphs and the HANDOFF word');
    const ultra = structToUltraBrief(struct);
    ok(ultra.includes('## 🤝 Open handoff (1)') && ultra.includes(`[${cardId}]`) && ultra.includes('next: build the chooser dialog') && ultra.indexOf('🤝 Open handoff') < ultra.indexOf('Open questions'), 'C8 the ultra brief leads with the handoff, before the opens list');
    ok(structToBrief(struct).includes('## 🤝 Open handoffs (1)'), 'C9 the full brief has the handoffs section');
    const l1 = await opBrainHandoff({ vault: project, action: 'list', from: { sessionId: 'other-1', client: 'codex' } });
    ok(l1.blocks[0].text.includes('🤝 Handoff card left in the brain') && l1.blocks[0].text.includes('left by Claude Code 628c93a6') && l1.blocks[0].text.includes('next: 1) build the chooser dialog') && l1.structured.handoffs.length === 1, 'C10 list prints the card with who/next/files');
    // Take by a Codex session; a second taker is told; done archives.
    const fromB = { sessionId: '01a0f13e-2f0e-7650-9465-7a573fed3140', client: 'codex' };
    const tk = await opBrainHandoff({ vault: project, action: 'take', id: cardId, from: fromB, via: 'codex' });
    ok(!tk.isError && tk.blocks[0].text.includes('✓ Taken over') && tk.blocks[0].text.includes('brain_sync with intent “Drive upload: the Place-it-now chooser”'), 'C11 take hands the card over with the next brain_sync spelled out');
    ({ struct } = await parseKlypix(fs.readFileSync(brainPath)));
    card = struct.cards.find((c) => c.id === cardId);
    ok(card.handoff.state === 'taken' && card.handoff.taken.sessionId === fromB.sessionId && /\nTaken: Codex 01a0f13e · /.test(card.text) && isOpenHandoffCard(card), 'C12 the card says who took it, in prose and machine field, and stays open');
    ok((await opBrainHandoff({ vault: project, action: 'list', from: { sessionId: 'other-2' } })).blocks[0].text.includes('taken by Codex 01a0f13e'), 'C13 list shows the taker');
    ok((await opBrainHandoff({ vault: project, action: 'take', id: 'txt_nope', from: fromB })).isError, 'C14 take of an unknown id is refused');
    const dn = await opBrainHandoff({ vault: project, action: 'done', id: cardId, from: fromB, via: 'codex', summary: 'chooser shipped in PR #999' });
    ok(!dn.isError && dn.structured.archived === true, 'C15 done archives the card');
    ({ struct } = await parseKlypix(fs.readFileSync(brainPath)));
    card = struct.cards.find((c) => c.id === cardId);
    ok(card && /^archive$/i.test(card.area || '') && card.handoff.state === 'done' && card.handoff.done.summary === 'chooser shipped in PR #999' && !isOpenHandoffCard(card), 'C16 the archived card carries the finisher and summary');
    ok(!structToUltraBrief(struct).includes('🤝 Open handoff') && listOpenHandoffCards(struct).length === 0, 'C17 a finished handoff leaves the brief and the list');
    const again = await opBrainHandoff({ vault: project, action: 'done', id: cardId, from: fromB });
    ok(again.isError && /already finished/.test(again.blocks[0].text), 'C18 done twice is refused loudly');
    // A handoff that continues an earlier one closes it.
    const first = await opBrainHandoff({ vault: project, action: 'write', from: fromA, title: 'Films v4 chapter 3', task: 'Cut chapter 3.', next: ['render'], reason: 'end_of_session' });
    const second = await opBrainHandoff({ vault: project, action: 'write', from: fromB, title: 'Films v4 chapter 3 (continued)', task: 'Finish chapter 3.', next: ['grade', 'publish'], continues: first.structured.id });
    ({ struct } = await parseKlypix(fs.readFileSync(brainPath)));
    const firstCard = struct.cards.find((c) => c.id === first.structured.id);
    ok(!second.isError && second.blocks[0].text.includes('closed as continued') && firstCard.handoff.state === 'done' && firstCard.handoff.continuedBy === second.structured.id && listOpenHandoffCards(struct).length === 1, 'C19 `continues` closes the earlier handoff and names its successor');
    ok(formatHandoffCards(listOpenHandoffCards(struct)).includes('Films v4 chapter 3 (continued)'), 'C20 formatHandoffCards prints the open one');
    // rewriteCardById refuses unknown ids and leaves the brain byte-identical.
    const before = fs.readFileSync(brainPath);
    const r = await rewriteCardById(before, 'txt_missing', (j) => { j.content += 'x'; });
    ok(!r.changed && r.reason === 'unknown-id' && r.buffer === before, 'C21 rewriteCardById on an unknown id changes nothing');
    renderHandoffCard; opBrainNote; // referenced for completeness
  }

  // ── F. Auto-drafted handoff (1.103.0): the brain writes the card itself ──
  // Field case 2026-10-15: Codex hit its usage limit mid-task and never wrote
  // a card; a human had to ask another agent to turn the automatic record into
  // one. Now the next session's list / brain_sync start does that, marked.
  {
    // F1–F2: a path chunked by the ~37-column card wrap is rebuilt, never split
    // into two "files" (the card KLYPIX wrote by hand that day listed
    // "…/lib/managed-" and "run-worker.ts" as two files no agent could open).
    const wrappedText = [
      'Handoff: ❓ 🤝 HANDOFF — Stop recovery',
      'From: Codex 01a13570 · 2026-10-15 20:04 UTC · reason: usage limit',
      'Task: fix it.',
      'Next:',
      '1. read the diff',
      'Files: artifacts/api-server/src/lib/managed-',
      'run-worker.ts,',
      'artifacts/agentforge/src/lib/run-stat',
      'us.ts',
      'Verify: git -C C:/w/facts status --porcelain',
      '#handoff',
    ].join('\n');
    const p1 = parseHandoffCard({ id: 'txt_wrap', text: wrappedText, area: 'Handoff' });
    ok(p1.files.length === 2 && p1.files[0] === 'artifacts/api-server/src/lib/managed-run-worker.ts' && p1.files[1] === 'artifacts/agentforge/src/lib/run-status.ts', `F1 a wrapped Files line is rebuilt into whole paths (${p1.files.join(' | ')})`);
    const p2 = parseHandoffCard({ id: 'txt_ev', text: wrappedText, area: 'Handoff', evidence: [{ kind: 'file', ref: 'artifacts/api-server/src/lib/managed-run-worker.ts' }, { kind: 'file', ref: 'artifacts/agentforge/src/lib/run-status.ts' }, { kind: 'url', ref: 'https://x' }] });
    ok(p2.files.length === 2 && p2.files.includes('artifacts/agentforge/src/lib/run-status.ts'), 'F2 the card\'s file evidence anchors (never wrapped) are the files when present');
    // F3: the gate — strict on purpose.
    const base = { intent: 'Fix the managed-run Stop recovery', files: ['a.ts'], lastWords: 'Edge cases folded in.', commits: [], handoffCardId: null, takenBy: null, state: 'stopped', quietMs: 12 * MIN };
    const cands = autoHandoffCandidates([
      { ...base, id: 'app', intent: 'This is an app-generated request for a suggested next user message.', quietMs: 90 * MIN },
      { ...base, id: 'lunch' },
      { ...base, id: 'quiet', quietMs: AUTO_HANDOFF_QUIET_MS },
      { ...base, id: 'ended', state: 'ended', quietMs: null, files: [], lastWords: '', commits: [{ sha: 'abc1234', subject: 'fix: x' }] },
      { ...base, id: 'bare', state: 'ended', lastWords: '', commits: [] },
      { ...base, id: 'carded', quietMs: 90 * MIN, handoffCardId: 'txt_x' },
      { ...base, id: 'taken', quietMs: 90 * MIN, takenBy: { id: 't' } },
    ]).map((r) => r.id);
    ok(cands.join(',') === 'quiet,ended', `F3 only a closed session with commits, or one quiet ≥30 min with files and a reply tail, qualifies — never an app turn, a lunch break, a bare record, a carded or a taken one (${cands.join(',')})`);
    // F4: the draft is honest by construction.
    const d = draftHandoffFromWork({ id: 'x', client: 'codex', intent: 'Fix the managed-run Stop recovery', cwd: 'C:/w/facts', files: ['artifacts/api-server/src/lib/managed-run-worker.ts'], lastPrompt: 'resume unfinished work', lastWords: 'Both edge cases are folded in. Next: run the suites.', commits: [{ sha: '7fcf976', subject: 'test: supply optional receipt' }] });
    ok(d.reason === 'interrupted' && d.title === 'Fix the managed-run Stop recovery' && d.done[0] === 'committed 7fcf976 test: supply optional receipt' && d.next.length === 2 && /in C:\/w\/facts: git status, then git diff on the files below \(its own commits are under Done\)/.test(d.next[0]) && /^git -C "C:\/w\/facts" status --porcelain -- artifacts\/api-server/.test(d.verify) && d.lastWords.startsWith('Both edge cases') && d.task.includes('resume unfinished work'), 'F4 draftHandoffFromWork: reason interrupted, Done = its commits only, Next = confirm with git first, verify on its files, last words verbatim');
    // F5: end to end, in process — a Codex session that stopped 35 minutes ago
    // with real work and no card; another session's list drafts the card.
    const realLane = () => JSON.parse(fs.readFileSync(laneFileFor(brainPath), 'utf8'));
    const realEntry = (id) => (realLane().directory || []).find((e) => e.id === id);
    fs.rmSync(laneFileFor(brainPath), { force: true });
    const dead = 'codex-dead-session-0099';
    const t0 = Date.now() - 35 * MIN;
    upsertSession({ brainPath, now: t0, id: dead, client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: dead, identitySource: 'codex-lifecycle', intent: 'Fix the managed-run Stop recovery', files: ['artifacts/api-server/src/lib/managed-run-worker.ts', 'artifacts/agentforge/src/lib/run-status.ts'], cwd: project, work: { lastPrompt: 'resume unfinished work', lastWords: 'Both edge cases are folded into the fix and the tests. Next: run the managed-run suites.', lastWordsAt: t0, commits: [{ sha: '7fcf976', subject: 'test: supply optional receipt to image route fixtures' }] } });
    const noticer = { sessionId: 'claude-noticer-0100', client: 'claude-code' };
    const l1 = await opBrainHandoff({ vault: project, action: 'list', from: noticer, via: 'claude-code' });
    const drafted = l1.structured?.autoDrafted || [];
    ok(!l1.isError && drafted.length === 1 && drafted[0].session === dead && /^txt_/.test(drafted[0].id) && l1.blocks[0].text.includes('KLYPIX drafted 1 handoff card just now'), `F5 another session's list drafts a card for the dead session and says so (${drafted[0]?.id})`);
    const autoId = drafted[0].id;
    let { struct: s5 } = await parseKlypix(fs.readFileSync(brainPath));
    const autoCard = s5.cards.find((c) => c.id === autoId);
    const h5 = parseHandoffCard(autoCard);
    const unwrapped = String(autoCard?.text || '').replace(/\s+/g, ' ');
    ok(autoCard && isOpenHandoffCard(autoCard) && / Drafted: by KLYPIX from the session's own record/.test(unwrapped) && /reason: interrupted — stopped without a handoff Drafted:/.test(unwrapped) && h5.auto === true && h5.reason === 'interrupted' && h5.from.sessionId === dead && h5.from.client === 'Codex' && autoCard.handoff?.auto?.by?.sessionId === noticer.sessionId, 'F6 the card is an open 🤝 on the dead session\'s behalf: Drafted: line, reason interrupted, machine twin names who noticed');
    ok(h5.files.length === 2 && h5.files.includes('artifacts/agentforge/src/lib/run-status.ts') && h5.done[0].includes('7fcf976') && h5.lastWords.startsWith('Both edge cases') && h5.lastWords.includes('Next∶ run the managed-run suites') && h5.next.length === 2 && /git/.test(h5.next[0]) && h5.resume === `codex resume ${dead}`, 'F7 it carries the files, the commit, the last words verbatim, a confirm-with-git first step and the resume command');
    ok(realEntry(dead)?.work?.handoffCardId === autoId && realEntry(dead).work.handoffAuto === true, 'F8 the dead session\'s lane record points at the drafted card and is marked auto');
    const u8 = listUnfinishedWork({ brainPath, selfId: noticer.sessionId }).find((r) => r.id === dead);
    ok(u8 && u8.handoffAuto === true && formatUnfinishedWork([u8], { cardTitles: new Map([[autoId, h5.title]]) }).includes('KLYPIX drafted a handoff card from this record (the session wrote none)'), 'F9 the unfinished-work list says KLYPIX drafted it, not that the session left it');
    ok(formatHandoffCards([h5]).includes('drafted by KLYPIX from the record of Codex codex-de') && formatHandoffCards([h5]).includes('verify its state with git first') && formatHandoffCards([h5]).includes('its last words: “Both edge cases'), 'F10 the handoff block says it was drafted, tells the reader to verify, and quotes the last words');
    const l2 = await opBrainHandoff({ vault: project, action: 'list', from: noticer, via: 'claude-code' });
    ok((l2.structured?.autoDrafted || []).length === 0 && l2.structured.handoffs.filter((h) => h.id === autoId).length === 1, 'F11 a second list drafts nothing again — one card per dead session');
    // F12: a DELIBERATE handoff on the same task from another session keeps
    // its own card — the drafted one must not swallow it (merge-on-capture).
    const w12 = await opBrainHandoff({ vault: project, action: 'write', from: { sessionId: 'claude-finisher-0101', client: 'claude-code' }, via: 'claude-code', title: 'Fix the managed-run Stop recovery', task: 'Finish and ship the Stop recovery fix.', next: ['run the suites', 'open the PR'], files: ['artifacts/api-server/src/lib/managed-run-worker.ts'], reason: 'usage_limit' });
    ({ struct: s5 } = await parseKlypix(fs.readFileSync(brainPath)));
    ok(!w12.isError && w12.structured.id && w12.structured.id !== autoId && listOpenHandoffCards(s5).filter((h) => [autoId, w12.structured.id].includes(h.id)).length === 2 && !parseHandoffCard(s5.cards.find((c) => c.id === w12.structured.id)).auto, 'F12 a deliberate handoff with the same title lands as its OWN card beside the drafted one');
    // F13: the dead session comes back and completes its task → the drafted
    // card is archived at the next pass; the deliberate one stays open.
    upsertSession({ brainPath, now: Date.now(), id: dead, client: 'codex', channel: 'mcp', event: 'McpTaskComplete', logicalSessionId: dead, identitySource: 'codex-lifecycle', intent: '' });
    const l3 = await opBrainHandoff({ vault: project, action: 'list', from: noticer, via: 'claude-code' });
    ({ struct: s5 } = await parseKlypix(fs.readFileSync(brainPath)));
    const closedCard = s5.cards.find((c) => c.id === autoId);
    ok((l3.structured?.autoClosed || []).some((c) => c.id === autoId) && l3.blocks[0].text.includes('archived 1 drafted handoff card') && closedCard && /^archive$/i.test(closedCard.area || '') && closedCard.handoff.state === 'done' && /resumed and completed its task/.test(closedCard.handoff.done.summary) && listOpenHandoffCards(s5).some((h) => h.id === w12.structured.id), 'F13 when the session completes its task, KLYPIX archives the card it drafted — the deliberate card stays');
    await opBrainHandoff({ vault: project, action: 'done', id: w12.structured.id, from: { sessionId: 'claude-finisher-0101', client: 'claude-code' }, summary: 'shipped' });
    fs.rmSync(laneFileFor(brainPath), { force: true });
  }

  // ── D. Over MCP stdio: registered, and brain_sync start carries it ────────
  {
    // The worker must not adopt THIS test's real host session through an
    // inherited CLAUDE_PID / hostmap — strip every host identity variable.
    const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|KLYPIX)/.test(k)));
    const connect = async (me) => {
      const client = new Client({ name: 'handoff-test', version: '1.0.0' }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [WORKER, '--vault', project],
        env: { ...workerEnv, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_SESSION_ID: me, KLYPIX_APP_TOOLS: 'off' },
        stderr: 'ignore',
      });
      await client.connect(transport);
      return client;
    };
    const a = await connect('mcp-session-aaaa-0001');
    const names = (await a.listTools()).tools.map((t) => t.name);
    ok(names.includes('brain_handoff'), 'D1 brain_handoff is a registered MCP tool');
    const tool = (await a.listTools()).tools.find((t) => t.name === 'brain_handoff');
    ok(tool.inputSchema.properties.action?.enum?.join(',') === 'write,take,done,list,review,capture' && tool.annotations.destructiveHint === false, 'D2 the schema names the six actions including conversation review and capture and is non-destructive');
    await a.callTool({ name: 'brain_sync', arguments: { project, intent: 'Drive upload chooser, step 2', files: ['admin/app/drive/page.tsx'], phase: 'start' } });
    const capture = await a.callTool({ name: 'brain_handoff', arguments: { project, action: 'capture', turns: [{ id: 'request-1', role: 'user', at: Date.now(), text: 'Also verify the last followup' }] } });
    ok(!capture.isError && capture.structuredContent?.captured?.added === 1, 'D2a capture records observed turns over real MCP stdio');
    const w = await a.callTool({ name: 'brain_handoff', arguments: { project, action: 'write', title: 'Drive upload chooser (MCP)', task: 'Finish the chooser.', next: ['dialog', 'tests'], files: ['admin/app/drive/page.tsx'], reason: 'context_limit' } });
    ok(!w.isError && w.structuredContent?.id && w.content[0].text.includes('✓ Handoff recorded'), 'D3 write over stdio records the card and returns its id');
    const review = await a.callTool({ name: 'brain_handoff', arguments: { project, action: 'review', id: w.structuredContent.id } });
    ok(review.structuredContent?.freshness?.coverage === 'captured-only' && review.content[0].text.includes('UNKNOWN'), 'D3a stdio review finds captured evidence and retains unknown full coverage');
    const laneEntry = entryOf('mcp-session-aaaa-0001');
    ok(laneEntry?.work?.handoffCardId === w.structuredContent.id, 'D4 the writer\'s lane record points at its card');
    await a.close();
    const b = await connect('mcp-session-bbbb-0002');
    const sync = await b.callTool({ name: 'brain_sync', arguments: { project, intent: 'continue the drive upload chooser', phase: 'start' } });
    const text = sync.content[0].text;
    ok(text.includes('🤝 Handoff card') && text.includes('Drive upload chooser (MCP)') && text.includes('brain_handoff {action:"take", id:"<card id>"}'), 'D5 a second session\'s brain_sync start carries the handoff block');
    ok(sync.structuredContent?.handoffs?.cards >= 1 && sync.structuredContent.handoffs.handoffs.some((h) => h.id === w.structuredContent.id), 'D6 structured.handoffs names the card');
    const take = await b.callTool({ name: 'brain_handoff', arguments: { project, action: 'take', id: w.structuredContent.id } });
    ok(!take.isError && take.content[0].text.includes('✓ Taken over'), 'D7 take over stdio');
    const done = await b.callTool({ name: 'brain_handoff', arguments: { project, action: 'done', id: w.structuredContent.id, summary: 'done' } });
    ok(!done.isError && done.structuredContent?.archived === true, 'D8 done over stdio archives');
    const nothing = await b.callTool({ name: 'brain_sync', arguments: { project, intent: 'something else', phase: 'checkpoint' } });
    ok(!nothing.content[0].text.includes('🤝 Handoff card'), 'D9 a checkpoint prints no handoff block');
    await b.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    await b.close();

    // 1.99.1 (bench S5): an automatic lane record is history, not a lock. It
    // rides brain_sync start only for a continue-shaped intent or a file
    // overlap, and then says the files are free — in text AND JSON.
    const t0 = Date.now() - 30 * MIN;
    const ended = 'ended-codex-session-0042';
    upsertSession({ brainPath, home, now: t0, id: ended, client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: ended, identitySource: 'codex-lifecycle', intent: 'Rewrite lib/report.js', files: ['lib/report.js'], work: { lastWords: 'WIP, do not touch lib/report.js', lastWordsAt: t0 } });
    const c = await connect('mcp-session-cccc-0003');
    const unrelated = await c.callTool({ name: 'brain_sync', arguments: { project, intent: 'fix the README typo', files: ['README.md'], phase: 'start' } });
    ok(!unrelated.content[0].text.includes('may have left unfinished') && !(unrelated.structuredContent?.handoffs?.sessions || []).length, 'D10 an unrelated task does not get the automatic list');
    await c.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    const overlap = await c.callTool({ name: 'brain_sync', arguments: { project, intent: 'add a total row to the report', files: ['lib/report.js'], phase: 'start' } });
    const ov = overlap.structuredContent?.handoffs?.sessions?.find((s) => s.id === ended);
    ok(overlap.content[0].text.includes('hold NO live claim on any file') && ov && ov.state === 'ended' && ov.working === false && ov.holdsFiles === false, 'D11 a task touching the same file sees it — as ended, holding no files, in text and JSON');
    await c.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    const cont = await c.callTool({ name: 'brain_sync', arguments: { project, intent: 'continue what the codex session was doing', phase: 'start' } });
    ok(cont.content[0].text.includes('Rewrite lib/report.js') && cont.content[0].text.includes('files it touched (free — not reserved)'), 'D12 a continue-shaped task sees it with its last words');
    await c.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    await c.close();

    // D13–D15 (1.103.0): over stdio, a brain_sync start drafts the card for a
    // session that died with real work, announces it, flags it in the JSON —
    // and the session's NEXT tool is not rejected (the draft replaced the
    // brain file; the binding is refreshed, as after any managed write).
    const deadMcp = 'codex-dead-mcp-session-0077';
    const tDead = Date.now() - 40 * MIN;
    upsertSession({ brainPath, home, now: tDead, id: deadMcp, client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: deadMcp, identitySource: 'codex-lifecycle', intent: 'Port the billing export to the new API', files: ['src/billing/port.ts'], work: { lastWords: 'Port compiles; the integration test is still red.', lastWordsAt: tDead, commits: [{ sha: '9e8d7c6', subject: 'feat(billing): port export' }] } });
    const dd = await connect('claude-after-dead-0078');
    const ds = await dd.callTool({ name: 'brain_sync', arguments: { project, intent: 'continue what codex left on the billing export', phase: 'start' } });
    const dsText = ds.content[0].text;
    const dsDrafted = ds.structuredContent?.handoffs?.autoDrafted || [];
    ok(!ds.isError && dsDrafted.length === 1 && dsDrafted[0].session === deadMcp && dsText.includes('KLYPIX drafted 1 handoff card just now') && dsText.includes('Port the billing export to the new API') && dsText.includes('verify its state with git first'), 'D13 a brain_sync start drafts the dead Codex session\'s card and announces it as drafted');
    ok(ds.structuredContent.handoffs.handoffs.some((h) => h.id === dsDrafted[0].id && h.auto === true && h.reason === 'interrupted'), 'D14 structured.handoffs flags the drafted card (auto:true, reason interrupted)');
    const after = await dd.callTool({ name: 'brain_handoff', arguments: { project, action: 'list' } });
    ok(!after.isError && after.structuredContent?.status !== 'project-changed' && after.content[0].text.includes(dsDrafted[0].id), 'D15 the next tool call still works — the drafted write did not break the project binding');
    ok(entryOf(deadMcp)?.work?.handoffCardId === dsDrafted[0].id && entryOf(deadMcp).work.handoffAuto === true, 'D16 the worker\'s lane record for the dead session points at the drafted card, marked auto');
    await dd.callTool({ name: 'brain_handoff', arguments: { project, action: 'done', id: dsDrafted[0].id, summary: 'ported' } });
    await dd.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    await dd.close();

    // ── E. Universal (1.99.1): not only Claude Code ─────────────────────────
    // E1–E4: an MCP-only host (Cursor, Gemini CLI, VS Code — no hooks at all)
    // declares a task through brain_sync and stops without completing it. The
    // declaration IS the work record, so the next session finds it.
    const cursor = await connect('cursor-session-eeee-0005');
    await cursor.callTool({ name: 'brain_sync', arguments: { project, intent: 'Add CSV export to the billing page', files: ['src/billing/export.ts'], phase: 'start' } });
    await cursor.close();
    const cursorEntry = entryOf('cursor-session-eeee-0005');
    ok(cursorEntry?.work?.declaredAt > 0, 'E1 a brain_sync-declared task stamps declaredAt on the session record (any MCP host)');
    const later = Date.now() + 15 * MIN;
    const mcpOnly = listUnfinishedWork({ brainPath, home, now: later }).find((r) => r.id === 'cursor-session-eeee-0005');
    ok(mcpOnly && mcpOnly.intent === 'Add CSV export to the billing page' && mcpOnly.files.includes('src/billing/export.ts'), 'E2 a hookless MCP session that stopped mid-task is listed as unfinished work');
    const finisher = await connect('cursor-session-ffff-0006');
    await finisher.callTool({ name: 'brain_sync', arguments: { project, intent: 'Tidy the docs index', files: ['docs/index.md'], phase: 'start' } });
    // A checkpoint between start and complete — brain_sync defers a completion
    // that follows its start with no work in between (premature-complete guard).
    await finisher.callTool({ name: 'brain_sync', arguments: { project, phase: 'checkpoint', files: ['docs/index.md'] } });
    await finisher.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    await finisher.close();
    ok(!listUnfinishedWork({ brainPath, home, now: later }).some((r) => r.id === 'cursor-session-ffff-0006'), 'E3 the same host that completed its task is not listed');

    // E4–E7: Codex through its REAL lifecycle hook.
    const codexHook = path.join(__dirname, '..', 'src', 'codex-brain-hook.mjs');
    const runCodex = (input) => execFileSync(process.execPath, [codexHook], { cwd: project, env: { ...workerEnv, HOME: home, USERPROFILE: home }, encoding: 'utf8', input: JSON.stringify({ cwd: project, ...input }) });
    const cx = 'codex-thread-limit-0007';
    runCodex({ session_id: cx, hook_event_name: 'SessionStart' });
    runCodex({ session_id: cx, hook_event_name: 'UserPromptSubmit', prompt: 'build the invoice PDF generator' });
    runCodex({ session_id: cx, hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: 'git commit -m "feat(invoice): pdf layout"' }, tool_response: { output: '[main 1a2b3c4] feat(invoice): pdf layout\n 2 files changed', exit_code: 0 } });
    runCodex({ session_id: cx, hook_event_name: 'Stop', last_assistant_message: 'Layout is committed. Next: totals table, then the tests in test/invoice.test.ts.' });
    const cxEntry = entryOf(cx);
    ok(cxEntry?.work?.lastWords?.startsWith('Layout is committed') && cxEntry.work.lastPrompt === 'build the invoice PDF generator', 'E4 Codex Stop records its last reply and the last prompt');
    ok(cxEntry.work.commits?.[0]?.sha === '1a2b3c4' && cxEntry.work.commits[0].subject === 'feat(invoice): pdf layout', 'E5 Codex records its OWN commit from the git commit tool output');
    runCodex({ session_id: cx, hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: 'git commit -m "feat(invoice): totals"' }, tool_response: { output: '[main 5d6e7f8] feat(invoice): totals' } });
    ok(entryOf(cx).work.commits.map((x) => x.sha).join(',') === '1a2b3c4,5d6e7f8', 'E6 a second Codex commit is appended, not replacing the first');
    const hint = JSON.parse(runCodex({ session_id: cx, hook_event_name: 'UserPromptSubmit', prompt: 'we are near the usage limit, hand it off' }) || '{}');
    ok(/brain_handoff/.test(hint.hookSpecificOutput?.additionalContext || hint.systemMessage || ''), 'E7 Codex gets the write-a-handoff hint when the human names the limit');
    // E8: Codex hits its limit — 15 quiet minutes — and a fresh Claude session
    // asked to continue sees the Codex work.
    {
      const lf = laneFileFor(brainPath, home);
      const lane = JSON.parse(fs.readFileSync(lf, 'utf8'));
      const back = (v) => (Number(v) ? Number(v) - 15 * MIN : v);
      for (const row of lane.sessions || []) if (row.id === cx || row.logicalSessionId === cx) Object.assign(row, { lastSeen: back(row.lastSeen), hostStatusAt: back(row.hostStatusAt), activityAt: back(row.activityAt), hostStatus: 'idle' });
      for (const row of lane.directory || []) if (row.id === cx) row.lastSeen = back(row.lastSeen);
      fs.writeFileSync(lf, JSON.stringify(lane));
    }
    const cl = await connect('claude-after-codex-0008');
    const pick = await cl.callTool({ name: 'brain_sync', arguments: { project, intent: 'continue what codex was doing on the invoice', phase: 'start' } });
    const pickText = pick.content[0].text;
    const afterHeader = pickText.slice(pickText.indexOf('may have left unfinished'));
    const firstRecord = afterHeader.split('\n').find((l) => l.startsWith('- ')) || '';
    ok(pickText.includes('1a2b3c4 feat(invoice): pdf layout') && pickText.includes('Layout is committed') && firstRecord.startsWith('- Codex codex-th') && pickText.includes('most relevant first'), `E8 asked to continue "what codex was doing on the invoice", a Claude session gets the Codex work FIRST — commits, last words (first: ${firstRecord.slice(0, 60)})`);
    await cl.callTool({ name: 'brain_sync', arguments: { project, phase: 'complete' } });
    await cl.close();
  }

  // ── F. Where it worked (1.103.0): workdirs + checkouts ───────────────────
  // Field case 2026-10-15: Codex hit its usage limit with a fix UNCOMMITTED on a
  // branch in a side checkout (C:\w\facts) that `git worktree list` in the
  // project does not show. Last words, files and commits were all recorded —
  // and the next session still searched for an hour. The record now names the
  // checkout, its branch and its uncommitted paths.
  {
    const dirKey = (d) => path.resolve(String(d)).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const sameDir = (a, b) => dirKey(a) === dirKey(b);
    // F1–F3: the pure parsers.
    const parsed = workdirsFromCommand('cd C:/w/facts && git status; git -C E:/other/repo log -1; text(await tools.exec_command({cmd:"pnpm test","workdir":"C:/w/facts"})); pushd /srv/app\nSet-Location -LiteralPath D:\\x\\y\\');
    ok(parsed.length === 4 && parsed[0] === 'C:/w/facts' && parsed.includes('/srv/app') && parsed.includes('D:\\x\\y') && parsed.includes('E:/other/repo'), `F1 workdirsFromCommand finds cd / pushd / Set-Location / git -C / a workdir key, once each (${parsed.join(' | ')})`);
    ok(workdirsFromCommand('ls -la && npm test').length === 0 && workdirsFromCommand('cd src && ls').length === 0, 'F2 a command with no absolute directory, or a relative cd, yields nothing');
    const fromTool = workdirsFromToolInput({ command: ['bash', '-lc', 'cd /x/y && ls'], workdir: 'C:\\w\\facts\\' });
    ok(fromTool[0] === 'C:\\w\\facts' && fromTool[1] === '/x/y', 'F3 workdirsFromToolInput takes the explicit workdir first, then the command text');
    const many = workdirsFromCommands(['cd /a', 'cd /b', 'cd /c', 'cd /a', 'cd /d', 'cd /e', 'cd /gone'], { isDirectory: (d) => d !== '/gone' });
    ok(many.join(',') === '/b,/c,/a,/d,/e'.split(',').slice(-4).join(',') && !many.includes('/gone'), `F4 workdirsFromCommands keeps the 4 newest existing directories, re-use moves to the tail (${many.join(',')})`);

    // F5–F8: a real snapshot — the project checkout reports only this session's
    // files; a side checkout reports its whole status; a non-git dir is skipped.
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const mkRepo = (name, files) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, ['init', '-q']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test']);
      git(dir, ['config', 'commit.gpgsign', 'false']);
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', 'init']);
      return dir;
    };
    const projF = mkRepo('projF', { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const side = mkRepo('side', { 'f1.txt': 'one', 'f2.txt': 'two' });
    git(side, ['checkout', '-q', '-b', 'codex/managed-stop-recovery']);
    fs.writeFileSync(path.join(projF, 'a.txt'), 'a-edited');          // touched by this session
    fs.writeFileSync(path.join(projF, 'b.txt'), 'b-edited-by-a-peer'); // NOT this session's
    fs.writeFileSync(path.join(side, 'f1.txt'), 'changed');
    fs.writeFileSync(path.join(side, 'f2.txt'), 'changed');
    fs.writeFileSync(path.join(side, 'new.txt'), 'new');
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    const snap = snapshotCheckouts({ dirs: [projF, side, path.join(side, '.'), path.join(root, 'plain'), path.join(root, 'missing')], projectDir: projF, sessionFiles: ['a.txt'] });
    const shared = snap.find((c) => c.shared);
    const sideEntry = snap.find((c) => !c.shared);
    ok(snap.length === 2 && shared && sameDir(shared.dir, projF) && shared.changed === 1 && shared.paths.join() === 'a.txt', `F5 the project checkout reports only the files this session touched (${JSON.stringify(shared?.paths)})`);
    ok(sideEntry && sameDir(sideEntry.dir, side) && sideEntry.branch === 'codex/managed-stop-recovery' && /^[0-9a-f]{12}$/.test(sideEntry.head) && sideEntry.changed === 3 && sideEntry.paths.includes('new.txt') && sideEntry.paths.includes('f1.txt') && !sideEntry.statusUnknown, `F6 a separate checkout reports branch, head and its whole uncommitted status (${sideEntry?.changed} changed)`);
    ok(snapshotCheckouts({ dirs: [projF], projectDir: projF, sessionFiles: ['c.txt'] }).length === 0, 'F7 a project checkout with none of this session\'s files dirty is not reported (a shared dirty tree is not its work)');
    const slow = snapshotCheckouts({ dirs: [side], projectDir: projF, runGit: (cwd, argv, ms) => { if (argv[0] === 'status') throw new Error('timeout'); return execFileSync('git', ['--literal-pathspecs', ...argv], { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'ignore'] }); } });
    ok(slow.length === 1 && slow[0].statusUnknown === true && slow[0].changed === 0 && formatCheckoutLines({ checkouts: slow }).join('\n').includes('git status unavailable'), 'F8 a git status that does not answer leaves statusUnknown, never a false "clean"');

    // F9–F11: the record — caps, merge, evidence, text.
    const big = normalizeWork({ workdirs: ['/1', '/2', '/3', '/4', '/5', '/6'], checkouts: [{ dir: 'C:/w/facts', branch: 'x', head: '186b6c0b1234', changed: 20, paths: Array.from({ length: 20 }, (_v, i) => `p${i}.ts`), shared: false }, { dir: '' }, 'junk', ...Array.from({ length: 5 }, (_v, i) => ({ dir: `/c${i}` }))] });
    ok(big.workdirs.join(',') === '/3,/4,/5,/6' && big.checkouts.length === 4 && big.checkouts[0].paths.length === 12 && big.checkouts[0].changed === 20 && big.checkouts[0].head === '186b6c0b1234', 'F9 normalizeWork caps workdirs at 4 (newest), checkouts at 4, paths at 12 while keeping the true changed count, and drops junk');
    const merged = mergeWork({ workdirs: ['/a'], lastWords: 'x' }, { addWorkdirs: ['/b', '/a'] });
    ok(merged.workdirs.join(',') === '/b,/a' && merged.lastWords === 'x' && !('addWorkdirs' in merged), 'F10 addWorkdirs appends and de-duplicates (re-use moves to the tail)');
    ok(hasWorkEvidence({ checkouts: [{ dir: '/x', changed: 2, paths: ['a'] }] }) && !hasWorkEvidence({ checkouts: [{ dir: '/x', changed: 0, paths: [] }] }), 'F11 uncommitted changes in a checkout are work evidence; a clean one alone is not');
    const facts = { dir: 'C:/w/facts', branch: 'codex/managed-stop-recovery', head: '186b6c0b4d3e', changed: 11, paths: ['artifacts/api-server/src/lib/managed-run-worker.ts', 'artifacts/api-server/src/routes/runs.ts'], shared: false, at: Date.now() };
    const linesF = formatCheckoutLines({ checkouts: [facts, { dir: 'E:/ANTIGRAVITY/AgentLit', changed: 1, paths: ['README.md'], shared: true }], workdirs: ['C:/w/facts', 'D:/elsewhere', 'E:/ANTIGRAVITY/AgentLit'] }, { cwd: 'E:/ANTIGRAVITY/AgentLit' });
    ok(linesF[0].includes('worked in a separate checkout: C:/w/facts (branch codex/managed-stop-recovery @ 186b6c0b4d3e; 11 uncommitted: artifacts/api-server/src/lib/managed-run-worker.ts, artifacts/api-server/src/routes/runs.ts …and 9 more)') && linesF[0].includes('git worktree list may not show it'), `F12 a separate checkout is named in full with branch, head and its uncommitted paths (${linesF[0].slice(0, 80)}…)`);
    ok(linesF[1] === '  uncommitted in the project checkout (files this session touched): README.md' && linesF[2] === '  also ran commands in: D:/elsewhere', 'F13 the project checkout line names only this session\'s files; a non-git workdir is listed too, cwd is not repeated');

    // F14: a session that recorded ONLY uncommitted work (cut off before any
    // reply tail) is listed, and the list names the checkout.
    const now = 2_400_000_000_000;
    const cut = '01a13570-659e-7331-b5d2-1fbf41caaffe';
    upsertSession({ brainPath, home, now, id: cut, client: 'codex', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: cut, identitySource: 'codex-lifecycle', intent: 'fix managed-run Stop recovery', cwd: 'E:/ANTIGRAVITY/AgentLit' });
    upsertSession({ brainPath, home, now: now + MIN, id: cut, client: 'codex', channel: 'lifecycle', event: 'Stop', logicalSessionId: cut, identitySource: 'codex-lifecycle', hostStatus: 'idle', work: { workdirs: ['C:/w/facts'], checkouts: [facts] } });
    const cutRec = listUnfinishedWork({ brainPath, home, now: now + 30 * MIN }).find((r) => r.id === cut);
    ok(cutRec && cutRec.checkouts.length === 1 && cutRec.checkouts[0].dir === 'C:/w/facts' && cutRec.workdirs.join() === 'C:/w/facts', 'F14 a session whose only evidence is uncommitted work in a side checkout is listed, with the checkout in its JSON record');
    const cutText = formatUnfinishedWork([cutRec], { now: now + 30 * MIN });
    ok(cutText.includes('worked in a separate checkout: C:/w/facts (branch codex/managed-stop-recovery') && cutText.indexOf('worked in a separate checkout') < cutText.indexOf('If the human asks'), 'F15 the unfinished-work block prints where it worked');
    // In-process, the core op resolves the lane under os.homedir(): point it at
    // the test home for this one call (the stdio worker gets HOME via env).
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    let tk2;
    try { tk2 = await opBrainHandoff({ vault: project, action: 'take', session: cut.slice(0, 8), from: { sessionId: 'taker-0001', client: 'claude-code' }, via: 'claude-code' }); }
    finally { for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    ok(!tk2.isError && tk2.blocks[0].text.includes('Where it worked: worked in a separate checkout: C:/w/facts') && tk2.structured.record.checkouts[0].changed === 11, `F16 taking the work over names the checkout in the reply and the record (${tk2.isError ? tk2.blocks[0].text.slice(0, 120) : 'ok'})`);

    // F17–F18: the Claude hook twin records it at Stop and prints it at SessionStart.
    const hookEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KLYPIX_AUTO_UPDATE: '0' };
    delete hookEnv.KLYPIX_SESSION_ID;
    const sidF = 'c0ffee00-aaaa-bbbb-cccc-000000000001';
    const transcriptF = path.join(root, 'transcript-f.jsonl');
    const tsF = new Date().toISOString();
    const J = (l) => JSON.stringify(l) + '\n';
    fs.writeFileSync(transcriptF, J({ type: 'user', timestamp: tsF, message: { role: 'user', content: 'fix the stop recovery in the side checkout' } }));
    const runF = (args, input) => execFileSync(process.execPath, [HOOK, ...args], { cwd: project, env: hookEnv, encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] });
    runF(['--prompt'], { session_id: sidF, prompt: 'fix the stop recovery in the side checkout', transcript_path: transcriptF, cwd: project });
    fs.writeFileSync(path.join(project, 'a.txt'), 'edited by the cut-off session');
    fs.appendFileSync(transcriptF, [
      { type: 'assistant', timestamp: tsF, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'Bash', input: { command: `cd ${side} && git status --short` } }] } },
      { type: 'user', timestamp: tsF, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: ' M f1.txt' }] } },
      { type: 'assistant', timestamp: tsF, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'f2', name: 'Edit', input: { file_path: path.join(project, 'a.txt'), old_string: 'x', new_string: 'y' } }] } },
      { type: 'user', timestamp: tsF, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f2', content: 'ok' }] } },
      { type: 'assistant', timestamp: tsF, message: { role: 'assistant', content: [{ type: 'text', text: 'Both edge cases are in the fix now; closing the gap before release.' }] } },
    ].map(J).join(''));
    runF(['--capture'], { session_id: sidF, transcript_path: transcriptF, cwd: project });
    const eF = entryOf(sidF);
    const eSide = (eF?.work?.checkouts || []).find((c) => !c.shared);
    const eShared = (eF?.work?.checkouts || []).find((c) => c.shared);
    ok(eF?.work?.workdirs?.some((d) => sameDir(d, side)) && eSide && sameDir(eSide.dir, side) && eSide.branch === 'codex/managed-stop-recovery' && eSide.changed === 3, `F17 the Claude Stop hook records the side checkout its Bash moved into, with branch and uncommitted count (${eSide?.changed})`);
    ok(eShared && eShared.paths.join() === 'a.txt', 'F18 …and, for the shared project checkout, only the file this session edited');
    {
      const lf = laneFileFor(brainPath, home);
      const lane = JSON.parse(fs.readFileSync(lf, 'utf8'));
      for (const row of lane.sessions) if (row.id === sidF) { row.hostStatusAt -= 60 * MIN; row.lastSeen -= 60 * MIN; }
      for (const row of lane.directory) if (row.id === sidF) row.lastSeen -= 60 * MIN;
      fs.writeFileSync(lf, JSON.stringify(lane));
    }
    const startF = runF([], { session_id: 'c0ffee00-aaaa-bbbb-cccc-000000000002', cwd: project });
    ok(startF.includes('worked in a separate checkout:') && startF.toLowerCase().includes(dirKey(side).split('/').pop()) && startF.includes('uncommitted in the project checkout (files this session touched): a.txt'), 'F19 SessionStart of the next Claude session prints where the cut-off session worked (hook twin)');

    // F20: the Codex hook records a tool call's workdir and snapshots it at Stop.
    const codexHook = path.join(__dirname, '..', 'src', 'codex-brain-hook.mjs');
    const workerEnvF = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|KLYPIX)/.test(k)));
    const runCodexF = (input) => execFileSync(process.execPath, [codexHook], { cwd: project, env: { ...workerEnvF, HOME: home, USERPROFILE: home }, encoding: 'utf8', input: JSON.stringify({ cwd: project, ...input }) });
    const cxF = 'codex-thread-side-checkout-0009';
    runCodexF({ session_id: cxF, hook_event_name: 'SessionStart' });
    runCodexF({ session_id: cxF, hook_event_name: 'UserPromptSubmit', prompt: 'finish the stop recovery fix' });
    runCodexF({ session_id: cxF, hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: ['pwsh', '-c', 'pnpm test'], workdir: side }, tool_response: { output: 'ok', exit_code: 0 } });
    ok(entryOf(cxF)?.work?.workdirs?.some((d) => sameDir(d, side)), 'F20 the Codex hook records the workdir of a tool call');
    runCodexF({ session_id: cxF, hook_event_name: 'Stop', last_assistant_message: 'Review found one more case; closing it before release.' });
    const cxSide = (entryOf(cxF)?.work?.checkouts || []).find((c) => !c.shared);
    ok(cxSide && sameDir(cxSide.dir, side) && cxSide.changed === 3 && cxSide.branch === 'codex/managed-stop-recovery', `F21 at Stop the Codex hook snapshots that checkout: branch and uncommitted count (${cxSide?.changed})`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n✓ session-handoff: all ${checks} assertions passed`);
