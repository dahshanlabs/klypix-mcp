// Continuity after a hard stop (1.109) — the three faults the 2026-10-30
// continuity test found, end to end through the real hooks.
//
// The field shape: a Claude Code session is given a four-step list in its
// prompt and is KILLED mid-task (taskkill /T /F — no Stop, no SessionEnd
// hook). A fresh session — Claude Code or Codex — is told only "continue".
//   K1  the prompt is recorded when it is SUBMITTED, with its line breaks and
//       all four steps (not 240 characters), secrets redacted, and the
//       session's own commit is recorded when the commit command returns —
//       so a session killed during its FIRST reply still has a record;
//   K2  that session's host process is gone: it is not live, even though its
//       last "busy" stamp is fresh, and it is listed as unfinished work at
//       once — "cut off in the middle of a reply", with what it was asked;
//       a session whose host is alive is NOT freed (control);
//   K3  the edit guard calls a dead session's files "left by a session that
//       has stopped … yours to finish", never "another session's work —
//       leave them alone"; a live owner's files still get "leave them alone";
//   K4  the Codex hook records the ask at submit too, and a Stop clears "cut off";
//   K5  the drafted handoff card and the take reply carry the steps;
//   K6  transcript discovery: a missing root is "unavailable", never
//       "incomplete"; a big projects folder is probed by exact name;
//   K7  redaction and size bounds.
//
// Run:  node test/continuity-after-kill.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  laneFileFor, listActiveSessions, listUnfinishedWork, formatUnfinishedWork, normalizeWork, mergeWork, redactSecretsInText,
  WORK_ASK_MAX, WORK_ASKS_MAX, WORK_ASKS_TOTAL_MAX, workCutOff, hasWorkEvidence,
} from '../src/agent-presence.mjs';
import { autoHandoffCandidates, draftHandoffFromWork, handoffTranscript, claudeProjectRoots, normalizeHandoffInput, renderHandoffCard, parseHandoffCard } from '../src/session-handoff.mjs';
import { opBrainHandoff } from '../src/klypix-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(__dirname, '..', 'src', 'codex-brain-hook.mjs');
const MIN = 60_000;
let checks = 0;
const ok = (c, label, detail) => { checks++; if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)).slice(0, 3000)); assert.ok(c, label); console.log(`[ok] ${label}`); };

const TASK = [
  "Today's list for shipdrop, in order. Run npm test before each commit and commit after each step (conventional commits).",
  "1. MIME allowlist in src/validate.ts: accept only text/plain, application/pdf, image/png and image/jpeg. Anything else: the upload route answers 415 with reason 'mime not allowed'. Add tests.",
  '2. Rate limit POST /upload per API key: 30 uploads per minute, then 429 with a Retry-After header. Put it in a new file src/rateLimit.ts. Add tests.',
  '3. Add DELETE /files/:id: owner only (404 for anyone else), removes the blob file and the metadata. Add tests.',
  '4. Update CHANGELOG.md (Unreleased) and add a curl example for delete to README.md. The staging key is api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
].join('\n');

// A pid that provably belonged to a process that has exited.
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }); return r.pid; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-continuity-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
write('src/app.ts', 'export const app = 1;\n');
write('src/validate.ts', 'export const v = 1;\n');
write('.gitignore', '.klypix/\n.claude/\n');
const brainPath = path.join(repo, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'continuity test', kind: 'brain', areas: [{ title: 'Upload', cards: [{ text: 'Upload: validate before storing' }] }] }));
git('add', '-A'); git('commit', '-q', '-m', 'base');

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
for (const k of ['KLYPIX_WHOSE', 'KLYPIX_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'KLYPIX_HOST_PID']) delete baseEnv[k];
const hook = (mode, input, extraEnv = {}) => execFileSync(process.execPath, [HOOK, mode], { cwd: repo, env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', input: JSON.stringify({ cwd: repo, ...input }), stdio: ['pipe', 'pipe', 'pipe'] });
const hookJson = (mode, input, extraEnv) => { const out = hook(mode, input, extraEnv); try { return out.trim() ? JSON.parse(out) : null; } catch { return { raw: out }; } };
const laneFile = laneFileFor(brainPath, home);
const readLane = () => JSON.parse(fs.readFileSync(laneFile, 'utf8'));
const entryOf = (id) => (readLane().directory || []).find((e) => e.id === id);
const reason = (r) => r?.hookSpecificOutput?.permissionDecisionReason || r?.hookSpecificOutput?.additionalContext || r?.raw || '';
// The kill: no Stop, no SessionEnd. Age the rows as if `ms` had passed since.
const ageSession = (id, ms) => {
  const lane = readLane();
  const shift = (o, keys) => { for (const k of keys) if (Number(o?.[k]) > 0) o[k] -= ms; };
  for (const row of lane.sessions || []) if (row.id === id || row.logicalSessionId === id) {
    shift(row, ['lastSeen', 'hostStatusAt', 'activityAt', 'intentAt', 'startedAt', 'scopeStartedAt']);
    if (row.channelSeen) for (const ch of Object.keys(row.channelSeen)) row.channelSeen[ch] -= ms;
    if (row.work) shift(row.work, ['promptAt', 'replyEndedAt', 'lastWordsAt']);
    if (row.work?.asks) for (const a of row.work.asks) shift(a, ['at']);
  }
  for (const e of lane.directory || []) if (e.id === id) {
    shift(e, ['lastSeen', 'firstSeen', 'intentAt']);
    if (e.work) shift(e.work, ['promptAt', 'replyEndedAt', 'lastWordsAt']);
    if (e.work?.asks) for (const a of e.work.asks) shift(a, ['at']);
  }
  fs.writeFileSync(laneFile, JSON.stringify(lane));
};

try {
  // ── K1: the cut-off session records its ask, its edits and its commit ─────
  const DEAD = '79977411-78ba-4ed7-af25-ea7cfe3baa1e';
  const dead = { CLAUDE_PID: String(deadPid()) };
  hook('--prompt', { session_id: DEAD, prompt: TASK, hook_event_name: 'UserPromptSubmit' }, dead);
  write('src/validate.ts', 'export const v = 2; // mime allowlist\n');
  hook('--live', { session_id: DEAD, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'validate.ts') }, hook_event_name: 'PostToolUse' }, dead);
  git('add', 'src/validate.ts'); git('commit', '-q', '-m', 'feat(validate): MIME allowlist');
  const sha = git('rev-parse', '--short=7', 'HEAD');
  hook('--live', { session_id: DEAD, tool_name: 'Bash', tool_input: { command: 'git add src/validate.ts && git commit -m "feat(validate): MIME allowlist"' }, tool_response: { stdout: `[main ${sha}] feat(validate): MIME allowlist\n 1 file changed, 1 insertion(+)`, stderr: '', interrupted: false }, hook_event_name: 'PostToolUse' }, dead);
  write('src/rateLimit.ts', 'export const limit = 30; // half-written\n');
  hook('--live', { session_id: DEAD, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'rateLimit.ts') }, hook_event_name: 'PostToolUse' }, dead);
  write('src/app.ts', 'export const app = 2; // wiring the limiter\n');
  hook('--live', { session_id: DEAD, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'app.ts') }, hook_event_name: 'PostToolUse' }, dead);
  // …and here the process tree is killed: no --capture (Stop), no --end.

  const e1 = entryOf(DEAD);
  const ask = e1?.work?.asks?.[0]?.text || '';
  ok(e1 && e1.work && e1.work.asks?.length === 1 && ask.length > 240 && /\n3\. Add DELETE \/files\/:id/.test(ask) && /\n4\. Update CHANGELOG\.md/.test(ask), 'K1 the prompt is recorded at submit, before any reply ends: all four steps, line breaks kept (was cut at 240 characters)', e1);
  ok(!ask.includes('sk-ant-api03') && /api_key=<redacted>/.test(ask), 'K1 a key in the prompt is redacted before it is stored', ask);
  ok(e1.work.commits?.length === 1 && e1.work.commits[0].sha === sha && /MIME allowlist/.test(e1.work.commits[0].subject), 'K1 its own commit is recorded when the commit command returns, not only at Stop', e1.work);
  ok(['src/rateLimit.ts', 'src/app.ts'].every((f) => e1.files.includes(f)) && workCutOff(e1.work) && hasWorkEvidence(e1.work), 'K1 its files are recorded and the record says it is mid-reply (cut off) — evidence of work on its own', e1);

  // A live control session in the same project: alive host, also never stopped.
  const LIVE = 'a11ce000-1111-2222-3333-444444444444';
  const alive = { CLAUDE_PID: String(process.pid) };
  hook('--prompt', { session_id: LIVE, prompt: 'Refactor the logger.\n1. move it to src/log.ts\n2. add tests', hook_event_name: 'UserPromptSubmit' }, alive);
  write('src/log.ts', 'export const log = 1;\n');
  hook('--live', { session_id: LIVE, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'log.ts') }, hook_event_name: 'PostToolUse' }, alive);

  // ── K2: two minutes later — the dead host is not live; the work is listed ──
  ageSession(DEAD, 2 * MIN);
  ageSession(LIVE, 2 * MIN);
  const lane0 = readLane();
  const deadRow = (lane0.sessions || []).find((r) => r.id === DEAD);
  ok(deadRow && deadRow.hostStatus === 'busy' && deadRow.hostPidSource === 'env', 'K2 setup: the killed session still carries a fresh "busy" stamp and a host-declared pid', deadRow);
  const live = listActiveSessions({ brainPath, home });
  ok(!live.some((r) => r.id === DEAD) && live.some((r) => r.id === LIVE), 'K2 a session whose host process is gone is not live; one whose host is alive stays live', live.map((r) => r.id));
  const unfinished = listUnfinishedWork({ brainPath, home, selfId: 'n3w5e551-0000-0000-0000-000000000000' });
  const rec = unfinished.find((r) => r.id === DEAD);
  ok(rec && rec.cutOff === true && rec.state === 'ended' && rec.asks.length === 1 && rec.commits[0].sha === sha, 'K2 the killed session is listed as unfinished work at once (not after the 10-minute quiet window), cut off, with its ask and commit', unfinished);
  ok(!unfinished.some((r) => r.id === LIVE), 'K2 the live session (busy, host alive) is NOT listed — its files are not freed', unfinished.map((r) => r.id));
  const block = formatUnfinishedWork(unfinished);
  ok(/cut off in the middle of a reply/.test(block) && /what it was asked/.test(block) && /› Today's list for shipdrop/.test(block) && /\n {6}3\. Add DELETE \/files\/:id/.test(block) && /\n {6}4\. Update CHANGELOG/.test(block), 'K2 the ⏸️ block says it was cut off and quotes the whole step list, one step per line', block);

  const NEXT = 'b0b0b0b0-5555-6666-7777-888888888888';
  // A different live host than the control session (same host = same window).
  const nextHost = { CLAUDE_PID: String(process.ppid) };
  const start = hook('', { session_id: NEXT, hook_event_name: 'SessionStart', source: 'startup' }, nextHost);
  ok(start.includes('⏸️ Work other sessions may have left unfinished') && start.includes('Claude Code 79977411') && /cut off in the middle of a reply/.test(start) && /3\. Add DELETE \/files\/:id/.test(start) && /4\. Update CHANGELOG\.md/.test(start) && start.includes(`${sha} feat(validate): MIME allowlist`), 'K2 the next Claude Code session gets the block at SessionStart (hook twin): cut off, all four steps, its commit', start.slice(0, 4000));
  ok(!/Claude Code a11ce000 · /.test(start), 'K2 the live control session is not in the next session\'s unfinished list', start.slice(0, 3000));

  // ── K3: the edit guard frees a dead session's files, never a live one's ──
  const st = hookJson('--guard', { session_id: NEXT, tool_name: 'Bash', tool_input: { command: 'git status' }, permission_mode: 'default', hook_event_name: 'PreToolUse' }, nextHost);
  const text = reason(st);
  ok(/left by a session that has stopped/.test(text) && /src\/rateLimit\.ts — Claude Code session 79977411/.test(text) && /yours to finish and commit/.test(text), 'K3 `git status` calls the killed session\'s files "left by a session that has stopped … yours to finish"', st);
  ok(/another session's work \(that session is running\) — leave them alone/.test(text) && /src\/log\.ts — Claude Code session a11ce000/.test(text) && !/src\/rateLimit\.ts[^\n]*\n[^\n]*leave them alone/.test(text), 'K3 the live session\'s file still gets "leave them alone" — and only that file', text);
  const leaveBlock = text.split('KLYPIX: these uncommitted files were left')[0];
  ok(!/rateLimit|app\.ts/.test(leaveBlock), 'K3 no dead-session file appears under "leave them alone"', text);
  const sweep = hookJson('--guard', { session_id: NEXT, tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "feat: rate limit"' }, permission_mode: 'default', hook_event_name: 'PreToolUse' }, nextHost);
  ok(sweep?.hookSpecificOutput?.permissionDecision === 'deny' && /src\/log\.ts/.test(reason(sweep)) && !/src\/rateLimit\.ts/.test(reason(sweep).split('Commit only your own files')[0]), 'K3 a sweep is still denied for the LIVE session\'s file only', sweep);

  // ── K4: the Codex hook records the ask at submit; Stop clears "cut off" ──
  const CX = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
  const codex = (input) => execFileSync(process.execPath, [CODEX_HOOK], { cwd: repo, env: baseEnv, encoding: 'utf8', input: JSON.stringify({ cwd: repo, session_id: CX, ...input }), stdio: ['pipe', 'pipe', 'pipe'] });
  codex({ hook_event_name: 'UserPromptSubmit', prompt: TASK });
  let ec = entryOf(CX);
  ok(ec?.work?.asks?.length === 1 && /\n3\. Add DELETE/.test(ec.work.asks[0].text) && !ec.work.asks[0].text.includes('sk-ant-api03') && workCutOff(ec.work), 'K4 Codex: the prompt is recorded at submit with all its steps, redacted, and reads as mid-reply until a Stop', ec);
  codex({ hook_event_name: 'Stop', last_assistant_message: 'Step 1 is committed.' });
  ec = entryOf(CX);
  ok(!workCutOff(ec.work) && Number(ec.work.replyEndedAt) > 0 && ec.work.lastWords === 'Step 1 is committed.', 'K4 Codex: a finished reply clears "cut off"', ec.work);
  codex({ hook_event_name: 'UserPromptSubmit', prompt: 'Looks good. Go on with the rest of the list.' });
  ec = entryOf(CX);
  ok(ec.work.asks.length === 2 && /\n4\. Update CHANGELOG/.test(ec.work.asks[0].text) && ec.work.asks[1].text === 'Looks good. Go on with the rest of the list.' && workCutOff(ec.work), 'K4 a terse follow-up ("go on") does not erase the step list it refers to', ec.work);

  // ── K5: the drafted card and the take reply carry what is left ───────────
  ok(autoHandoffCandidates([rec]).length === 1, 'K5 a cut-off session with files qualifies for a drafted card even with no reply tail', rec);
  const draft = draftHandoffFromWork(rec, { projectDir: repo });
  const norm = normalizeHandoffInput(draft);
  ok(norm.ok && /cut off in the middle of a reply/.test(draft.task) && draft.next.some((s) => /\(3\) Add DELETE \/files\/:id/.test(s)) && draft.next.some((s) => /\(4\) Update CHANGELOG/.test(s)) && /^Confirm the state/.test(draft.next[0]) && /^Read its last words/.test(draft.next.at(-1)), 'K5 the drafted card says it was cut off and lists every step it was asked for, between "confirm with git" and the last step', draft);
  const card = { id: 'txt_x', text: renderHandoffCard(norm.value, { from: { client: 'claude-code', sessionId: DEAD } }) };
  const parsed = parseHandoffCard(card);
  ok(parsed.next.length === draft.next.length && parsed.next.some((s) => /\(3\) Add DELETE/.test(s)), 'K5 the card round-trips: every step is still its own Next item', parsed.next);
  process.env.HOME = home; process.env.USERPROFILE = home;   // in-process ops resolve the lane from os.homedir()
  const taken = await opBrainHandoff({ vault: repo, action: 'take', session: DEAD, from: { sessionId: NEXT, client: 'claude-code' }, via: 'claude-code' });
  const takeText = taken.blocks?.map((b) => b.text).join('\n') || '';
  ok(!taken.isError && /what it was asked/.test(takeText) && /3\. Add DELETE/.test(takeText) && /4\. Update CHANGELOG/.test(takeText), 'K5 brain_handoff take hands over the step list too', takeText.slice(0, 2000));

  // ── K6: transcript discovery (bug 4) ─────────────────────────────────────
  const sid = '0f0e0d0c-0b0a-0908-0706-050403020100';
  ok(handoffTranscript(sid, 'claude-code', { home: path.join(root, 'nohome') }).reason === 'Transcript unavailable on this machine', 'K6 no ~/.claude/projects on this machine is "unavailable", never "discovery incomplete"');
  const projects = path.join(root, 'cfg', 'projects');
  fs.mkdirSync(path.join(projects, 'E--busy'), { recursive: true });
  for (let i = 0; i < 13000; i++) fs.writeFileSync(path.join(projects, 'E--busy', `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl`), '');
  fs.mkdirSync(path.join(projects, 'E--tmp-project'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'E--tmp-project', `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: TASK } }) + '\n');
  const tr = handoffTranscript(sid, 'claude-code', { home: path.join(root, 'nohome'), roots: [projects] });
  ok(tr.status === 'available' && tr.turns.length === 1 && /3\. Add DELETE/.test(tr.turns[0].text), 'K6 a projects folder holding 13,000 other transcripts no longer exhausts discovery: the exact file is found', tr.reason || tr.status);
  const roots = claudeProjectRoots(os.homedir(), { CLAUDE_CONFIG_DIR: path.join(root, 'cfg') });
  ok(roots[0] === path.resolve(projects) && roots.includes(path.resolve(os.homedir(), '.claude', 'projects')), 'K6 CLAUDE_CONFIG_DIR is searched first (the host keeps transcripts there), the home folder too', roots);
  ok(claudeProjectRoots(path.join(root, 'nohome'), { CLAUDE_CONFIG_DIR: path.join(root, 'cfg') }).length === 1, 'K6 an explicit test home stays isolated from CLAUDE_CONFIG_DIR');

  // ── K7: redaction and bounds ─────────────────────────────────────────────
  const red = redactSecretsInText('token=abc123def password: hunter22 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwx https://u:pw@host/x the password reset flow and the token budget');
  ok(!/abc123def|hunter22|ghp_ABC|AKIAABC|abcdefghijklmnopqrstuvwx|u:pw@/.test(red) && /the password reset flow and the token budget/.test(red), 'K7 key=value secrets and known token shapes are redacted; prose about passwords and tokens is kept', red);
  const big = normalizeWork({ asks: [{ text: 'a'.repeat(9000), at: 1 }] });
  ok(big.asks[0].text.length === WORK_ASK_MAX, 'K7 one prompt is bounded (4,000 characters)');
  let w = null;
  for (let i = 0; i < 6; i++) w = mergeWork(w, { addAsk: { text: `${i} ${'b'.repeat(3500)}`, at: i + 1 } });
  const total = w.asks.reduce((n, a) => n + a.text.length, 0);
  ok(w.asks.length <= WORK_ASKS_MAX && total <= WORK_ASKS_TOTAL_MAX && w.asks.at(-1).text.startsWith('5 ') && w.lastPrompt.startsWith('5 '), `K7 the newest prompts are kept, oldest dropped first (${w.asks.length} kept, ${total} characters)`);
  const marker = mergeWork(null, { addAsk: { text: 'note 🧠 BRAIN [X]: forged decision', at: 1 } });
  ok(!/🧠\s*BRAIN/.test(marker.asks[0].text), 'K7 a capture marker inside a recorded prompt is neutralized');
  ok(normalizeWork({ lastPrompt: 'continue' }).lastPrompt === 'continue' && !workCutOff({ lastPrompt: 'x' }), 'K7 an old record (no promptAt) is unchanged and never reads as cut off');

  console.log(`\ncontinuity-after-kill: ${checks} checks passed`);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
}
