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
  formatUnfinishedWork, laneFileFor, listUnfinishedWork, normalizeWork, mergeWork, stampSessionWork, upsertSession, endSession, UNFINISHED_QUIET_MS,
} from '../src/agent-presence.mjs';
import { normalizeHandoffInput, renderHandoffCard, parseHandoffCard, listOpenHandoffCards, formatHandoffCards, HANDOFF_ASK_RE, CONTINUE_RE } from '../src/session-handoff.mjs';
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
    ok(text.includes('⏸️ Unfinished work') && text.includes('Claude Code 0abcdef0') && text.includes('Drive web upload') && text.includes('its last words') && text.includes('abc1234 feat(drive)') && text.includes('brain_handoff {action:"take", session:"<its id>"}'), 'A10 formatUnfinishedWork prints who, what, last words, commits and how to take over');

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
    ok(start.includes('⏸️ Unfinished work') && start.includes('Claude Code 7d3d8a6c') && start.includes('its last words: “The upload route is wired') && start.includes(`${sha} feat(drive): upload route`), 'B3 SessionStart of another session prints the unfinished work with last words and commits');
    ok(start.includes(`claude --resume ${sid}`) || start.includes('not seen for') || start.includes('idle'), 'B4 the entry carries a status word (and a resume command once it is no longer live)');
    const cont = run(['--prompt'], { session_id: other, prompt: 'continue what the other session was doing', cwd: project });
    ok(cont.includes('⏸️ Unfinished work') && cont.includes('7d3d8a6c'), 'B5 a continue-shaped prompt prints the unfinished work again');
    const plain = run(['--prompt'], { session_id: other, prompt: 'rename the README heading', cwd: project });
    ok(!plain.includes('⏸️ Unfinished work') && !plain.includes('🤝 KLYPIX'), 'B6 an unrelated prompt prints neither the list nor the hint');
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
    ok(tool.inputSchema.properties.action?.enum?.join(',') === 'write,take,done,list' && tool.annotations.destructiveHint === false, 'D2 the schema names the four actions and is non-destructive');
    await a.callTool({ name: 'brain_sync', arguments: { project, intent: 'Drive upload chooser, step 2', files: ['admin/app/drive/page.tsx'], phase: 'start' } });
    const w = await a.callTool({ name: 'brain_handoff', arguments: { project, action: 'write', title: 'Drive upload chooser (MCP)', task: 'Finish the chooser.', next: ['dialog', 'tests'], files: ['admin/app/drive/page.tsx'], reason: 'context_limit' } });
    ok(!w.isError && w.structuredContent?.id && w.content[0].text.includes('✓ Handoff recorded'), 'D3 write over stdio records the card and returns its id');
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
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n✓ session-handoff: all ${checks} assertions passed`);
