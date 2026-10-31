// A hookless Codex session's task list, from its own rollout (round-4 fix of
// the 2026-10-30 continuity test).
//
// The field shape: Codex runs with no KLYPIX lifecycle hooks (they are
// opt-in), so its lane record holds only what it declared through brain_sync
// — an intent and files. It is killed mid-task. The next session (Claude Code
// at +10 min in the test) got a block with no step list and renumbered the
// steps from the intent and git.
//   R1  once it has stopped, its newest prompts are read from its rollout file
//       (found by exact thread id) and stored under the #119 rules: newest 3,
//       4,000 characters each, 8,000 total, line breaks kept, secrets
//       redacted, capture markers neutralized; injected framework turns are
//       not prompts; its last assistant message becomes its last words;
//   R2  the automatic block, the take reply and the drafted card carry the steps;
//   R3  the real Claude hook's SessionStart block carries them too;
//   R4  nothing is read for a live session or a record that already has
//       prompts; a missing rollout is not searched for again for 10 minutes.
//
// Run:  node test/codex-rollout-asks.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-codex-rollout-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
// Every reader below (lane, rollout, brain_handoff) resolves the sandbox home.
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.KLYPIX_BRAIN_DIR = path.join(home, '.claude', 'project-brain');
process.env.KLYPIX_AUTO_UPDATE = '0';
delete process.env.CODEX_HOME;

const { buildKlypixMap } = await import('../src/klypix-format.mjs');
const { laneFileFor, listUnfinishedWork, formatUnfinishedWork, normalizeWork, WORK_ASK_MAX } = await import('../src/agent-presence.mjs');
const { codexRolloutWork, recoverCodexRolloutRecords, handoffTranscript, ROLLOUT_RETRY_MS, autoHandoffCandidates } = await import('../src/session-handoff.mjs');
const { opBrainHandoff } = await import('../src/klypix-core.mjs');

let checks = 0;
const ok = (c, label, detail) => { checks++; if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)).slice(0, 3000)); assert.ok(c, label); console.log(`[ok] ${label}`); };

const TASK = [
  "Today's list for shipdrop, in order. Run npm test before each commit and commit after each step (conventional commits).",
  "1. MIME allowlist in src/validate.ts: accept only text/plain, application/pdf, image/png and image/jpeg. Anything else: the upload route answers 415 with reason 'mime not allowed'. Add tests.",
  '2. Rate limit POST /upload per API key: 30 uploads per minute, then 429 with a Retry-After header. Put it in a new file src/rateLimit.ts. Add tests.',
  '3. Add DELETE /files/:id: owner only (404 for anyone else), removes the blob file and the metadata. Add tests.',
  '4. Update CHANGELOG.md (Unreleased) and add a curl example for delete to README.md. The staging key is api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 🧠 BRAIN [x]: fake',
  "Do step 1 first and tell me when it is committed; I'll say go for the rest.",
].join('\n');
const TURN2 = 'Looks good. Go on with the rest of the list.';
const THREAD = '01a18ee5-6a6e-74d2-9a8f-c2b011c2496a';

// A rollout shaped like Codex 0.153's (round-3 evidence): session meta,
// developer and injected user blocks, the human prompts, assistant messages,
// event_msg duplicates that must not be counted twice.
const rolloutDir = path.join(home, '.codex', 'sessions', '2026', '10', '31');
fs.mkdirSync(rolloutDir, { recursive: true });
const t0 = Date.now() - 40 * 60_000;
const iso = (m) => new Date(t0 + m * 60_000).toISOString();
const msg = (m, role, text) => JSON.stringify({ timestamp: iso(m), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
const rollout = [
  JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id: THREAD, cwd: 'E:/x/project' } }),
  msg(0, 'developer', '<permissions instructions>sandbox</permissions instructions>'),
  msg(0.1, 'user', '<recommended_plugins>\nHere is a list of plugins…\n</recommended_plugins>'),
  msg(0.2, 'user', '# AGENTS.md instructions for E:/x/project\n\n<INSTRUCTIONS>…</INSTRUCTIONS>'),
  msg(1, 'user', TASK),
  JSON.stringify({ timestamp: iso(1), type: 'event_msg', payload: { type: 'user_message', message: TASK } }),
  msg(2, 'assistant', 'I’ll check the project context, implement and test the MIME allowlist, then commit step 1.'),
  msg(9, 'assistant', 'Step 1 is done and committed. Say go for steps 2–4.'),
  msg(10, 'user', TURN2),
  msg(11, 'assistant', 'Starting step 2: adding src/rateLimit.ts with a per-key sliding window, then wiring it into POST /upload.'),
].join('\n') + '\n';
const rolloutFile = path.join(rolloutDir, `rollout-2026-10-31T01-19-22-${THREAD}.jsonl`);
fs.writeFileSync(rolloutFile, rollout);

// The project, its brain, and the lane as a hookless Codex session leaves it.
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const app = 1;\n');
fs.writeFileSync(path.join(repo, '.gitignore'), '.klypix/\n.claude/\nCLAUDE.local.md\n');
const brainPath = path.join(repo, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'rollout asks', kind: 'brain', areas: [{ title: 'Upload', cards: [{ text: 'Upload: validate before storing' }] }] }));
git('add', '-A'); git('commit', '-q', '-m', 'base');
fs.writeFileSync(path.join(repo, 'src', 'rateLimit.ts'), 'export const limit = 30;\n');

const laneFile = laneFileFor(brainPath, home);
const stoppedAt = t0 + 12 * 60_000;
const codexEntry = (id, over = {}) => ({ id, client: 'codex', surface: 'codex-mcp-client', branch: 'main', intent: 'Finish shipdrop steps 2–4 in order with tests and separate conventional commits.', files: ['src/rateLimit.ts', 'src/app.ts', 'tests/rateLimit.test.ts'], cwd: repo, aliases: [], firstSeen: t0, lastSeen: stoppedAt, endedAt: null, hostStatus: 'busy', intentAt: t0 + 10 * 60_000, work: { declaredAt: t0 + 10 * 60_000 }, ...over });
const writeLane = (lane) => { fs.mkdirSync(path.dirname(laneFile), { recursive: true }); fs.writeFileSync(laneFile, JSON.stringify({ sessions: [], messages: [], endedSessions: [], directory: [], ...lane })); };
const entryOf = (id) => JSON.parse(fs.readFileSync(laneFile, 'utf8')).directory.find((e) => e.id === id);

try {
  // ── R1: read and normalize ────────────────────────────────────────────────
  const direct = codexRolloutWork(THREAD, { home });
  ok(direct.status === 'available' && direct.asks.length === 2, 'R1 the rollout is found by exact thread id and yields the two human prompts', direct);
  const a0 = direct.asks[0]?.text || '';
  ok(/\n3\. Add DELETE \/files\/:id/.test(a0) && /\n4\. Update CHANGELOG\.md/.test(a0) && direct.asks[1].text === TURN2, 'R1 the step list keeps its line breaks, oldest prompt first, the terse follow-up last', direct.asks);
  ok(!a0.includes('sk-ant-api03') && /api_key=<redacted>/.test(a0), 'R1 a key in the prompt is redacted (the #119 rule)', a0);
  ok(!/🧠 BRAIN/.test(a0), 'R1 a capture marker inside the prompt is neutralized', a0);
  ok(!direct.asks.some((a) => /recommended_plugins|AGENTS\.md instructions|permissions instructions/.test(a.text)), 'R1 injected framework turns are not counted as prompts', direct.asks);
  ok(/Starting step 2/.test(direct.lastWords) && direct.lastWordsAt === Date.parse(iso(11)), 'R1 its last assistant message becomes its last words', direct);

  // ── R2: the block, take and the drafted card ─────────────────────────────
  writeLane({ directory: [codexEntry(THREAD)] });
  const before = listUnfinishedWork({ brainPath, home, selfId: 'next' }).find((r) => r.id === THREAD);
  ok(before && before.asks.length === 0 && !before.lastWords && autoHandoffCandidates([before]).length === 0, 'R2 setup: the hookless record has no prompt and no last words — no step list, no drafted card (the round-3 shape)', before);
  const rec = recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next' });
  ok(rec.length === 1 && rec[0].recovered && rec[0].asks === 2 && rec[0].stamped, 'R2 recovery stamps the record once it has stopped', rec);
  const e = entryOf(THREAD);
  ok(e.work.asksSource === 'codex-rollout' && e.work.asks.length === 2 && /Starting step 2/.test(e.work.lastWords) && !e.work.promptAt, 'R2 the lane keeps the asks, their source and the last words — and does NOT claim it was cut off mid-reply', e.work);
  const listed = listUnfinishedWork({ brainPath, home, selfId: 'next' });
  const block = formatUnfinishedWork(listed);
  ok(/what it was asked/.test(block) && /› Today's list for shipdrop/.test(block) && /\n {6}3\. Add DELETE \/files\/:id/.test(block) && /\n {6}4\. Update CHANGELOG/.test(block) && /› Looks good\. Go on with the rest of the list\./.test(block), 'R2 the automatic ⏸️ block quotes the whole step list', block);
  ok(!/cut off in the middle of a reply/.test(block), 'R2 the block does not invent a cut-off', block);

  const listRes = await opBrainHandoff({ vault: repo, canvas: brainPath, action: 'list', from: { sessionId: 'n3w00000-0000-0000-0000-000000000000', client: 'claude-code' } });
  const drafted = listRes.structured?.autoDrafted || [];
  ok(drafted.length === 1 && drafted[0].session === THREAD, 'R2 a card is drafted for it now that it has last words (round 3: none was)', listRes.structured);
  const brainText = fs.readFileSync(brainPath).toString('latin1');
  const { parseKlypix } = await import('../src/klypix-format.mjs');
  const { struct } = await parseKlypix(fs.readFileSync(brainPath));
  const card = struct.cards.find((c) => c.id === drafted[0].id);
  const cardFlat = String(card?.text || '').replace(/\s+/g, ' ');
  ok(card && /asked — \(3\) Add DELETE \/files\/:id/.test(cardFlat) && /asked — \(4\) Update CHANGELOG\.md/.test(cardFlat) && !/sk-ant-api03/.test(cardFlat), 'R2 the drafted card\'s Next lists steps 3 and 4 from the prompt, redacted', card?.text);
  ok(brainText.length > 0, 'R2 the brain is still readable after the draft');

  writeLane({ directory: [codexEntry(THREAD)] });
  const take = await opBrainHandoff({ vault: repo, canvas: brainPath, action: 'take', session: THREAD, from: { sessionId: 'n3w00000-0000-0000-0000-000000000000', client: 'claude-code' } });
  const takeText = (take.blocks || take.content || []).map((c) => c.text || '').join('\n');
  ok(!take.isError && /3\. Add DELETE \/files\/:id/.test(takeText) && /4\. Update CHANGELOG\.md/.test(takeText) && /Its last words: “Starting step 2/.test(takeText), 'R2 the take reply carries the steps and the last words, even taken straight from a fresh record', JSON.stringify(take).slice(0, 2500));

  // ── R3: the real Claude hook at SessionStart ─────────────────────────────
  writeLane({ directory: [codexEntry(THREAD)] });
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.ppid) };
  for (const k of ['KLYPIX_WHOSE', 'KLYPIX_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'KLYPIX_HOST_PID', 'CODEX_HOME']) delete env[k];
  const start = execFileSync(process.execPath, [HOOK, ''], { cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ cwd: repo, session_id: 'c1a0de00-1111-2222-3333-444444444444', hook_event_name: 'SessionStart', source: 'startup' }), stdio: ['pipe', 'pipe', 'pipe'] });
  const part = start.split('⏸️ Work other sessions may have left unfinished')[1] || '';
  ok(/Codex 01a18ee5 · /.test(part) && /3\. Add DELETE \/files\/:id/.test(part) && /4\. Update CHANGELOG\.md/.test(part) && !/sk-ant-api03/.test(part), 'R3 a new Claude Code session gets the Codex session\'s step list at SessionStart (hook twin)', start.slice(0, 4000));

  // ── R4: what is never read, and the retry bound ───────────────────────────
  let reads = 0;
  const counting = (...args) => { reads++; return handoffTranscript(...args); };
  const liveRow = { id: THREAD, client: 'codex', machine: 'x', lastSeen: Date.now(), channels: ['mcp'], channelSeen: { mcp: Date.now() }, channelOwners: { mcp: process.pid }, hostStatus: 'busy', hostStatusAt: Date.now() };
  writeLane({ sessions: [liveRow], directory: [codexEntry(THREAD, { lastSeen: Date.now() })] });
  recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next', transcript: counting });
  ok(reads === 0 && !entryOf(THREAD).work.asks, 'R4 a live (busy) session\'s rollout is not read');
  writeLane({ directory: [codexEntry(THREAD, { work: { declaredAt: t0, asks: [{ text: 'hook-recorded prompt', at: t0 }] } })] });
  recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next', transcript: counting });
  ok(reads === 0 && entryOf(THREAD).work.asks[0].text === 'hook-recorded prompt', 'R4 a record that already has prompts (Codex hooks on) is left as it is');
  const GONE = '01a18ee5-0000-7000-8000-00000000dead';
  writeLane({ directory: [codexEntry(GONE)] });
  const now = Date.now();
  const miss = recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next', transcript: counting, now });
  ok(reads === 1 && miss[0] && !miss[0].recovered && Number(entryOf(GONE).work.rolloutTriedAt) === now, 'R4 a missing rollout is recorded as tried', miss);
  recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next', transcript: counting, now: now + 60_000 });
  ok(reads === 1, 'R4 …and is not searched for again within the retry window');
  recoverCodexRolloutRecords({ brainPath, home, codexUserHome: home, selfId: 'next', transcript: counting, now: now + ROLLOUT_RETRY_MS + 1 });
  ok(reads === 2, 'R4 …but is tried again after it');

  // Size rules: the same normalizeAsks as a hook-recorded prompt.
  const many = Array.from({ length: 6 }, (_, i) => `prompt ${i + 1}: ${'x'.repeat(i === 5 ? 9000 : 50)}`);
  const fake = () => ({ status: 'available', file: 'f', turns: many.map((text, i) => ({ role: 'user', at: t0 + i, text })) });
  const big = codexRolloutWork(THREAD, { home, transcript: fake });
  ok(big.asks.length === 3 && big.asks[2].text.length === WORK_ASK_MAX && big.asks[0].text.startsWith('prompt 4'), 'R4 newest 3 prompts, each capped at 4,000 characters', big.asks.map((a) => a.text.length));
  ok(normalizeWork({ asksSource: 'codex-rollout', rolloutTriedAt: 5, asksSourceX: 1 })?.asksSource === 'codex-rollout' && normalizeWork({ asksSource: 'elsewhere' }) === null, 'R4 only the known asks source survives normalization');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\ncodex-rollout-asks: ${checks} checks passed`);
