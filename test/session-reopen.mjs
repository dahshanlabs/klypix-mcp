// Reopen on the human's OK (1.91.0).
//
// THE contract under test (founder request 2026-10-04: a note to a closed
// session should not just wait up to 7 days — the human should be asked, with a
// button, whether to bring that session back now):
//   A. reopenCandidate picks exactly the session a note waits for, and refuses
//      everything else by name: unknown / ambiguous / self / live / a host
//      without a verified resume-by-id / an id unsafe for a script / no
//      DIRECTED note waiting / a double click / a fresh "Not now".
//   B. buildReopenLaunch opens a NEW, VISIBLE terminal per platform through a
//      script KLYPIX writes itself (no terminal argument parser sees the
//      command), in the session's folder, without the sender's identity in the
//      environment — and the first prompt is FIXED text, never the note.
//   C. launchReopen honours dry-run and reports failure with a manual fallback.
//   D. nativeReopenDialog maps every platform's answer to reopen / wait /
//      timeout / unavailable, and is off when asked to be.
//   E. Over a real MCP connection: the HUMAN's in-chat answer decides; "Not
//      now" is recorded and respected; a client without in-chat prompts and no
//      dialog gets the command to hand the human; brain_message offers the verb.
//
// Run:  node test/session-reopen.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  REOPEN_DECLINE_QUIET_MS,
  REOPEN_DECLINE_RETRY_MS,
  REOPEN_NUDGE,
  REOPEN_REPEAT_GUARD_MS,
  buildReopenLaunch,
  endSession,
  laneFileFor,
  launchReopen,
  listKnownSessions,
  nativeReopenDialog,
  postPresenceMessage,
  recordSessionReopen,
  reopenCandidate,
  reopenEnv,
  reopenQuestion,
  upsertSession,
} from '../src/agent-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, '..', 'bin', 'klypix-worker.mjs');
const MIN = 60_000;
const HOUR = 60 * MIN;

let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-reopen-'));
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));

// A session that was live, then closed: the directory remembers it.
const closeSession = ({ home, id, client, cwd = project, now, intent = 'add the order summary' }) => {
  openSession({ home, id, client, cwd, now: now - 5 * MIN, intent });
  endSession({ brainPath, id, home, now: now - 4 * MIN });
};
// SessionStart / UserPromptSubmit / McpTaskStart are the events that may revive an ended id.
function openSession({ home, id, client, cwd = project, now, intent = 'add the order summary' }) {
  return upsertSession({ brainPath, home, now, id, client, channel: client === 'claude-code' ? 'lifecycle' : 'mcp',
    event: 'UserPromptSubmit', logicalSessionId: id, identitySource: client === 'claude-code' ? 'claude-lifecycle' : 'mcp-request',
    intent, cwd });
}
const note = ({ home, from, to, now, text = 'payment step is done, in Payment.tsx' }) => postPresenceMessage({
  brainPath, home, now, from, to, text, allowKnownOfflineTarget: true,
});

// ── A. reopenCandidate ────────────────────────────────────────────────────────
{
  const home = path.join(root, 'home-a');
  fs.mkdirSync(home, { recursive: true });
  const now = Date.now();
  const sender = 'claude-sender-0001';
  const codex = '019a5e7c-1234-7abc-9def-0123456789ab';
  upsertSession({ brainPath, home, now, id: sender, client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit',
    logicalSessionId: sender, identitySource: 'claude-lifecycle', intent: 'build the payment step' });
  // A broadcast that listed the session while it was live is not a reason to bring it back later.
  openSession({ home, id: codex, client: 'codex', now: now - 5 * MIN });
  const bc = postPresenceMessage({ brainPath, home, now: now - 5 * MIN, from: sender, to: 'all', text: 'fyi everyone' });
  ok(bc.posted && bc.message.candidateIds.includes(codex), 'A1 fixture: a broadcast lists the live Codex session');
  endSession({ brainPath, id: codex, home, now: now - 4 * MIN });

  let c = reopenCandidate({ brainPath, home, now, target: codex, selfIds: [sender] });
  ok(!c.ok && c.reason === 'no-waiting-note', 'A2 a broadcast still pending for a closed session is not a reason to reopen it ("no-waiting-note")');

  const posted = note({ home, from: sender, to: codex, now });
  ok(posted.posted && posted.queuedOffline, 'A3 fixture: a directed note to the closed session is queued');
  c = reopenCandidate({ brainPath, home, now, target: codex, selfIds: [sender] });
  ok(c.ok && c.hostKey === 'codex' && c.hostLabel === 'Codex', 'A3 the closed Codex session with a note waiting is reopenable');
  ok(c.command === `codex resume ${codex}` && c.cwd === project && c.cwdSource === 'session',
    'A3 it reopens with the host\'s own resume command, in the session\'s folder');
  ok(c.waitingNotes.length === 1 && c.waitingNotes[0].from === sender && c.state === 'closed',
    'A3 the candidate names the waiting note, its sender, and that the session closed');
  ok(reopenCandidate({ brainPath, home, now, target: codex.slice(0, 8), selfIds: [sender] }).ok,
    'A4 a unique 8-character prefix resolves to the session');

  closeSession({ home, id: '019a5e7c-9999-7abc-9def-0123456789ab', client: 'codex', now });
  ok(reopenCandidate({ brainPath, home, now, target: '019a5e7c', selfIds: [sender] }).reason === 'ambiguous-session',
    'A5 a prefix shared by two remembered sessions fails closed ("ambiguous-session")');
  ok(reopenCandidate({ brainPath, home, now, target: 'nobody-ever-0000', selfIds: [sender] }).reason === 'unknown-session',
    'A6 an id nobody remembers is "unknown-session"');
  ok(reopenCandidate({ brainPath, home, now, target: codex, selfIds: [codex] }).reason === 'self',
    'A7 a session cannot reopen itself');

  upsertSession({ brainPath, home, now, id: codex, client: 'codex', channel: 'mcp', event: 'McpTaskStart', logicalSessionId: codex, identitySource: 'mcp-request' });
  c = reopenCandidate({ brainPath, home, now, target: codex, selfIds: [sender] });
  ok(!c.ok && c.reason === 'live', 'A8 a session that is running is not reopened ("live") — it gets the note at its next action');
  endSession({ brainPath, id: codex, home, now });

  const cursor = 'cursor-chat-0000-1111';
  closeSession({ home, id: cursor, client: 'cursor', now });
  note({ home, from: sender, to: cursor, now });
  ok(reopenCandidate({ brainPath, home, now, target: cursor, selfIds: [sender] }).reason === 'unsupported-client',
    'A9 a host without a verified resume-by-id is never reopened');

  const evil = 'evil;calc-0000-0000';
  closeSession({ home, id: evil, client: 'codex', now });
  note({ home, from: sender, to: evil, now });
  ok(reopenCandidate({ brainPath, home, now, target: evil, selfIds: [sender] }).reason === 'unsafe-id',
    'A10 an id that is not identifier-safe never reaches a script');

  const gone = '019b0000-0000-7000-8000-00000000c0de';
  closeSession({ home, id: gone, client: 'claude-code', cwd: path.join(root, 'deleted-folder'), now });
  note({ home, from: sender, to: gone, now });
  c = reopenCandidate({ brainPath, home, now, target: gone, selfIds: [sender] });
  ok(c.ok && c.cwd === project && c.cwdSource === 'project' && c.command === `claude --resume ${gone}`,
    'A11 a folder that no longer exists falls back to the project root; Claude Code uses claude --resume');

  recordSessionReopen({ brainPath, home, now, sessionId: codex, outcome: 'reopened', via: 'in-chat', method: 'console', by: sender });
  ok(reopenCandidate({ brainPath, home, now: now + 30_000, target: codex, selfIds: [sender] }).reason === 'just-reopened',
    'A12 a second reopen inside the repeat guard is refused as a double click');
  ok(reopenCandidate({ brainPath, home, now: now + REOPEN_REPEAT_GUARD_MS + 1000, target: codex, selfIds: [sender] }).ok,
    'A12 after the guard it may be reopened again');

  const t0 = now + REOPEN_REPEAT_GUARD_MS + 2000;
  recordSessionReopen({ brainPath, home, now: t0, sessionId: codex, outcome: 'declined', via: 'in-chat', by: sender });
  ok(reopenCandidate({ brainPath, home, now: t0 + MIN, target: codex, selfIds: [sender] }).reason === 'recently-declined',
    'A13 right after "Not now" even an explicit ask is refused');
  ok(reopenCandidate({ brainPath, home, now: t0 + REOPEN_DECLINE_RETRY_MS + MIN, target: codex, selfIds: [sender] }).ok,
    'A13 an explicit ask is allowed again after the retry window');
  ok(reopenCandidate({ brainPath, home, now: t0 + HOUR, target: codex, selfIds: [sender], explicit: false }).reason === 'recently-declined'
    && reopenCandidate({ brainPath, home, now: t0 + REOPEN_DECLINE_QUIET_MS + MIN, target: codex, selfIds: [sender], explicit: false }).ok,
  'A13 an automatic offer stays quiet for the whole quiet window after "Not now"');
  ok(reopenCandidate({ brainPath, home, now: t0 + MIN, target: codex, selfIds: [sender], humanInitiated: true }).ok,
    'A13 the human typing the command themselves is never blocked by an earlier "Not now"');

  const lane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  ok(Array.isArray(lane.reopens) && lane.reopens.some((r) => r.outcome === 'declined' && r.sessionId === codex),
    'A14 the reopen log is an additive lane key');
  ok(Array.isArray(lane.sessions) && Array.isArray(lane.messages) && Array.isArray(lane.directory),
    'A14 recording a reopen preserves every other lane key');

  const known = listKnownSessions({ brainPath, home, now }).find((row) => row.id === codex);
  ok(known && known.waitingDirectedNotes === 1, 'A15 listKnownSessions counts the notes addressed to a session (waitingDirectedNotes)');

  const q = reopenQuestion(reopenCandidate({ brainPath, home, now: t0 + REOPEN_DECLINE_QUIET_MS + MIN, target: codex, selfIds: [sender] }),
    { senderLabel: 'Claude Code session claude-s', start: true, now: t0 + REOPEN_DECLINE_QUIET_MS + MIN });
  ok(/Codex session 019a5e7c/.test(q) && /add the order summary/.test(q) && /from Claude Code session claude-s/.test(q),
    'A16 the question names the host, the session, its last intent and who left the note');
  ok(/Reopen it now in a new terminal/.test(q) && q.includes(project) && /starts on the note right away/.test(q) && /stays queued/.test(q),
    'A16 the question says where it opens, that it starts on the note, and what happens if it waits');
  // each state carries its own verb: "was closed 2m ago" (1.91.0 read "is closed 2m ago"), "is not running (last seen …)"
  const base = { hostLabel: 'Codex', entry: { id: codex, intent: '' }, waitingNotes: [{}], cwd: '' };
  const closedQ = reopenQuestion({ ...base, endedAt: t0 }, { now: t0 + 2 * MIN });
  const quietQ = reopenQuestion({ ...base, lastSeen: t0 }, { now: t0 + 2 * MIN });
  ok(/ was closed 2m ago, and a note /.test(closedQ) && !/is closed/.test(closedQ), 'A17 a closed session reads "was closed 2m ago"');
  ok(/ is not running \(last seen 2m ago\), and a note /.test(quietQ), 'A17 a quiet session reads "is not running (last seen 2m ago)"');
}

// ── B. buildReopenLaunch ──────────────────────────────────────────────────────
{
  const id = '019a5e7c-1234-7abc-9def-0123456789ab';
  const winFind = (name) => (name === 'wt.exe' ? 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' : null);
  const env = { PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: 'sender-thread', KLYPIX_SESSION_ID: 'sender',
    ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'C:\\cfg', ANTHROPIC_API_KEY: 'k', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  let plan = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: 'C:\\Work\\Shop 100% done\\', platform: 'win32', env, find: winFind, tmpDir: 'C:\\Temp', now: 1 });
  ok(plan.ok && plan.method === 'windows-terminal' && plan.file.endsWith('wt.exe'), 'B1 Windows opens a new Windows Terminal window when wt is present');
  ok(JSON.stringify(plan.args.slice(0, 4)) === JSON.stringify(['-w', 'new', 'cmd', '/k']) && plan.args[4] === plan.script.path && /\.cmd$/.test(plan.script.path),
    'B1 the terminal runs a script KLYPIX wrote — the command never passes through wt\'s ;-splitting parser');
  ok(plan.script.content.includes('cd /d "C:\\Work\\Shop 100%% done"') && !/done\\"/.test(plan.script.content),
    'B2 the folder is quoted, % is doubled (no variable expansion), and a trailing backslash cannot escape the quote');
  ok(plan.script.content.includes(`call codex resume ${id} "${REOPEN_NUDGE}"`), 'B3 the script resumes the exact id with the FIXED first prompt');
  ok(plan.script.content.includes('\r\n') && plan.script.content.startsWith('@echo off'), 'B3 the .cmd script has CRLF line endings');
  ok(!plan.script.content.includes('payment step'), 'B3 nothing another session wrote is ever typed into the reopened session');
  ok(!('CLAUDECODE' in plan.env) && !('CODEX_THREAD_ID' in plan.env) && !('KLYPIX_SESSION_ID' in plan.env) && !('ELECTRON_RUN_AS_NODE' in plan.env)
    && !('CLAUDE_CODE_ENTRYPOINT' in plan.env),
  'B4 the reopened session does not inherit the sender\'s identity or nested-session markers');
  ok(plan.env.PATH === 'C:\\bin' && plan.env.CLAUDE_CONFIG_DIR === 'C:\\cfg' && plan.env.ANTHROPIC_API_KEY === 'k',
    'B4 everything else (PATH, config dirs, keys) passes through');
  ok(reopenEnv({ CLAUDECODE: '1', Path: 'x' }).Path === 'x', 'B4 reopenEnv keeps unrelated keys verbatim');

  plan = buildReopenLaunch({ hostKey: 'claude-code', sessionId: id, cwd: 'C:\\Work', prompt: '', platform: 'win32', env, find: () => null, tmpDir: 'C:\\Temp', now: 2 });
  ok(plan.ok && plan.method === 'console' && plan.file === 'C:\\Windows\\system32\\cmd.exe' && plan.args[0] === '/k',
    'B5 without Windows Terminal a new console window is used');
  ok(plan.script.content.includes(`call claude --resume ${id}\r\n`), 'B5 "reopen quietly" passes no first prompt');
  plan = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: 'C:\\Work', platform: 'win32', env, find: winFind, tmpDir: 'C:\\Te;mp', now: 3 });
  ok(plan.method === 'console', 'B6 a temp path containing ; never goes to wt (falls back to the console window)');

  plan = buildReopenLaunch({ hostKey: 'claude-code', sessionId: id, cwd: "/Users/n/it's mine/", platform: 'darwin', env: { PATH: '/usr/bin' }, find: () => '/usr/bin/osascript', now: 4 });
  ok(plan.ok && plan.method === 'macos-terminal' && plan.script === null, 'B7 macOS opens a new Terminal window');
  ok(plan.env.KLYPIX_REOPEN_COMMAND === `cd '/Users/n/it'\\''s mine' && printf '%s\\n\\n' 'KLYPIX: reopening Claude Code 019a5e7c so it receives the note waiting for it.' && claude --resume ${id} '${REOPEN_NUDGE}'`,
    'B7 the command reaches Terminal through the environment, single-quote escaped (no AppleScript string escaping)');
  ok(plan.args.join(' ').includes('system attribute "KLYPIX_REOPEN_COMMAND"'), 'B7 AppleScript reads it with system attribute');

  plan = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: '/home/n/w', platform: 'linux', env: { PATH: '/usr/bin' }, find: () => '/usr/bin/x', now: 5 });
  ok(plan.ok && plan.method === 'manual' && plan.reason === 'no-display' && plan.manual.command === `codex resume ${id}` && plan.manual.cwd === '/home/n/w',
    'B8 Linux without a display opens nothing and hands back the manual command');
  plan = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: '/home/n/w', platform: 'linux', env: { PATH: '/usr/bin', DISPLAY: ':0' },
    find: (name) => (name === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null), tmpDir: '/tmp', now: 6 });
  ok(plan.ok && plan.method === 'linux-gnome-terminal' && plan.args[0] === '--' && plan.args[1] === plan.script.path && plan.script.mode === 0o700,
    'B9 Linux with a display uses the first terminal found, running an executable script');
  ok(plan.script.content.startsWith('#!/bin/sh\ncd \'/home/n/w\' && ') && plan.script.content.includes('exec "${SHELL:-/bin/sh}"'),
    'B9 the script cds into the folder and leaves a shell open afterwards');

  ok(buildReopenLaunch({ hostKey: 'cursor', sessionId: id, cwd: '/w', platform: 'linux', env: {} }).reason === 'unsupported-client',
    'B10 an unknown host has no launch');
  ok(buildReopenLaunch({ hostKey: 'codex', sessionId: 'a b', cwd: '/w', platform: 'linux', env: {} }).reason === 'unsafe-id',
    'B10 an unsafe id has no launch');
  ok(buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: '/w\nrm -rf ~', platform: 'linux', env: { DISPLAY: ':0' } }).reason === 'unsafe-script-input',
    'B10 a folder with a line break never reaches a script');
  ok(/^[A-Za-z0-9 ,.()_:/-]+$/.test(REOPEN_NUDGE) && !/["'%!^&|<>;\\]/.test(REOPEN_NUDGE),
    'B11 the fixed first prompt contains no character any shell or script treats specially');
}

// ── C. launchReopen ───────────────────────────────────────────────────────────
{
  const plan = buildReopenLaunch({ hostKey: 'codex', sessionId: 'abc-123', cwd: 'C:\\Work', platform: 'win32', env: { PATH: 'C:\\bin' }, find: () => null, tmpDir: 'C:\\Temp', now: 7 });
  let spawned = null; let written = null;
  const dry = launchReopen(plan, { env: { KLYPIX_REOPEN_LAUNCH: 'dry-run' }, spawnImpl: () => { spawned = 'x'; return 1; } });
  ok(dry.dryRun && !dry.launched && spawned === null, 'C1 KLYPIX_REOPEN_LAUNCH=dry-run starts nothing');
  const live = launchReopen(plan, { env: {}, writeFile: (file, content) => { written = { file, content }; },
    spawnImpl: (file, args, opts) => { spawned = { file, args, opts }; return 4242; } });
  ok(live.launched && live.pid === 4242 && written?.file === plan.script.path && written.content === plan.script.content,
    'C2 the script is written before the terminal starts');
  ok(spawned.file === plan.file && spawned.args === plan.args && spawned.opts.detached === true && spawned.opts.env === plan.env,
    'C2 the terminal is started detached with the stripped environment');
  const failed = launchReopen(plan, { env: {}, writeFile: () => {}, spawnImpl: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  ok(!failed.launched && /launch-failed:ENOENT/.test(failed.reason) && failed.manual?.command === 'codex resume abc-123',
    'C3 a terminal that cannot start is reported with the manual command');
  ok(!launchReopen({ ok: true, method: 'manual', manual: { cwd: '/w', command: 'codex resume x' } }).launched,
    'C4 a manual plan never launches');
}

// ── D. nativeReopenDialog ─────────────────────────────────────────────────────
{
  const fakeSpawn = (stdout, code) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { if (stdout) child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); });
    return child;
  };
  const ask = (platform, stdout, code, env = {}) => nativeReopenDialog({ message: 'Reopen?', platform, env: { DISPLAY: ':0', ...env },
    find: (name) => (name === 'zenity' ? '/usr/bin/zenity' : `/bin/${name}`), spawnImpl: fakeSpawn(stdout, code) });
  ok(await ask('win32', '6', 0) === 'reopen' && await ask('win32', '7', 0) === 'wait' && await ask('win32', '-1', 0) === 'timeout',
    'D1 Windows: Yes / No / gave up map to reopen / wait / timeout');
  ok(await ask('darwin', 'button returned:Reopen, gave up:false', 0) === 'reopen'
    && await ask('darwin', 'button returned:Not now, gave up:false', 0) === 'wait'
    && await ask('darwin', 'button returned:, gave up:true', 0) === 'timeout', 'D2 macOS: Reopen / Not now / gave up');
  ok(await ask('linux', '', 0) === 'reopen' && await ask('linux', '', 1) === 'wait' && await ask('linux', '', 5) === 'timeout',
    'D3 Linux zenity: exit 0 / 1 / 5');
  ok(await ask('win32', '6', 0, { KLYPIX_REOPEN_DIALOG: 'off' }) === 'unavailable', 'D4 KLYPIX_REOPEN_DIALOG=off disables the dialog');
  ok(await nativeReopenDialog({ message: 'x', platform: 'linux', env: {}, find: () => '/usr/bin/zenity', spawnImpl: fakeSpawn('', 0) }) === 'unavailable',
    'D5 no display, no dialog');
  ok(await nativeReopenDialog({ message: 'x', platform: 'win32', env: {}, find: () => null, spawnImpl: () => { throw new Error('spawn failed'); } }) === 'unavailable',
    'D6 a dialog that cannot start is "unavailable", never a throw');
  // D7: the Windows dialog runs an inline -Command, which no execution policy
  // governs, so it never asks PowerShell to bypass one.
  let winArgv = null;
  await nativeReopenDialog({ message: 'x', platform: 'win32', env: {}, find: () => null,
    spawnImpl: (file, args) => { winArgv = args; return fakeSpawn('7', 0)(); } });
  ok(Array.isArray(winArgv) && !winArgv.some((a) => /executionpolicy|bypass/i.test(String(a)))
    && winArgv[0] === '-NoProfile' && winArgv[1] === '-NonInteractive' && winArgv[2] === '-Command',
  `D7 Windows dialog argv: -NoProfile -NonInteractive -Command, no -ExecutionPolicy Bypass (got ${JSON.stringify((winArgv || []).slice(0, 3))})`);
}

// ── E. Over a real MCP connection ─────────────────────────────────────────────
{
  const home = path.join(root, 'home-e');
  fs.mkdirSync(home, { recursive: true });
  const now = Date.now();
  const me = 'reopen-test-sender-01';
  const codex = '019c0000-aaaa-7bbb-8ccc-0000000000e1';
  closeSession({ home, id: codex, client: 'codex', now });
  note({ home, from: me, to: codex, now, text: 'checkout tests are green, merge when ready' });

  const connect = async ({ elicitation, answer }) => {
    const client = new Client({ name: 'reopen-test', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: {} } : {} });
    const asked = [];
    if (elicitation) client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params); return answer(request.params); });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [WORKER, '--vault', project],
      env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_SESSION_ID: me,
        KLYPIX_REOPEN_LAUNCH: 'dry-run', KLYPIX_REOPEN_DIALOG: 'off' },
      stderr: 'ignore',
    });
    await client.connect(transport);
    return { client, asked };
  };
  const reopen = (client, args = {}) => client.callTool({ name: 'brain_reopen', arguments: { session: codex.slice(0, 12), project, ...args } });

  let { client, asked } = await connect({ elicitation: true, answer: (params) => ({ action: 'accept', content: { choice: params.requestedSchema.properties.choice.enum[0] } }) });
  const names = (await client.listTools()).tools.map((t) => t.name);
  ok(names.includes('brain_reopen'), 'E1 brain_reopen is a registered MCP tool');
  let result = await reopen(client);
  ok(asked.length === 1 && /Reopen it now in a new terminal/.test(asked[0].message) && asked[0].requestedSchema?.properties?.choice?.enum?.length === 3,
    'E2 the HUMAN is asked in chat (MCP elicitation) with Reopen-and-act / Reopen-quietly / Not now');
  ok(result.structuredContent?.status === 'dry-run' && result.structuredContent?.method && result.structuredContent?.command === `codex resume ${codex}`,
    'E2 on "Reopen it and let it act on the note" the session is opened (dry run here) with its resume command');
  await client.close();

  ({ client, asked } = await connect({ elicitation: true, answer: () => ({ action: 'accept', content: { choice: 'Not now — let the note wait' } }) }));
  // The dry-run above is not a reopen, so the repeat guard does not apply; the human now says no.
  result = await reopen(client);
  ok(result.structuredContent?.status === 'declined' && /Not now/.test(result.content[0].text) && /stays queued/.test(result.content[0].text),
    'E3 "Not now" opens nothing and says the note stays queued');
  const again = await reopen(client);
  ok(again.structuredContent?.status === 'refused' && again.structuredContent?.reason === 'recently-declined' && asked.length === 1,
    'E4 asking again right after "Not now" is refused without bothering the human a second time');
  await client.close();

  // A client with no in-chat prompts and no dialog available: the human gets the command.
  const quiet = 'reopen-test-sender-02';
  const codex2 = '019c0000-bbbb-7bbb-8ccc-0000000000e2';
  closeSession({ home, id: codex2, client: 'codex', now });
  note({ home, from: me, to: codex2, now });
  ({ client } = await connect({ elicitation: false }));
  result = await client.callTool({ name: 'brain_reopen', arguments: { session: codex2, project } });
  ok(result.structuredContent?.status === 'manual' && result.content[0].text.includes(`codex resume ${codex2}`) && /nothing was opened/.test(result.content[0].text),
    'E5 with no way to ask the human, nothing opens and the command is handed back');
  result = await client.callTool({ name: 'brain_reopen', arguments: { session: 'nobody-0000-0000', project } });
  ok(result.structuredContent?.status === 'refused' && result.structuredContent?.reason === 'unknown-session' && result.isError !== true,
    'E6 a refusal is an answer, not a tool error');

  // brain_message to a closed session offers the verb.
  const codex3 = '019c0000-cccc-7bbb-8ccc-0000000000e3';
  closeSession({ home, id: codex3, client: 'codex', now });
  result = await client.callTool({ name: 'brain_message', arguments: { to: codex3, text: 'rebase on master before you push' } });
  const text = result.content.map((b) => b.text || '').join('\n');
  ok(/Queued for Codex/.test(text) && text.includes(`call brain_reopen with session "${codex3}"`) && /opens nothing unless they say yes/.test(text),
    'E7 a note queued for a closed Codex session offers brain_reopen — and says the human decides');
  void quiet;
  await client.close();
}

// ── E8. The same in-chat answer through the SUPERVISOR real hosts launch ─────
// Elicitation is a server-to-client request: the supervisor must relay the
// worker's request to the host and route the human's answer back.
{
  const home = path.join(root, 'home-e8');
  fs.mkdirSync(home, { recursive: true });
  const now = Date.now();
  const me = 'reopen-test-sender-08';
  const codex = '019c0000-dddd-7bbb-8ccc-0000000000e8';
  closeSession({ home, id: codex, client: 'codex', now });
  note({ home, from: me, to: codex, now });
  const client = new Client({ name: 'reopen-supervised', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  const asked = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(request.params);
    return { action: 'accept', content: { choice: request.params.requestedSchema.properties.choice.enum[1] } };
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs'), '--vault', project],
    env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_SESSION_ID: me,
      KLYPIX_REOPEN_LAUNCH: 'dry-run', KLYPIX_REOPEN_DIALOG: 'off' },
    stderr: 'ignore',
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'brain_reopen', arguments: { session: codex, project } });
  ok(asked.length === 1 && result.structuredContent?.status === 'dry-run' && /would (open|be handed)/.test(result.content[0].text),
    'E8 through the supervisor: the worker\'s prompt reaches the host and the human\'s answer comes back');
  await client.close();
}

// ── F. Real Windows windows (opt-in: KLYPIX_REOPEN_E2E=1) ─────────────────────
// Opens two real windows for a moment, with a FAKE `codex` first on PATH — no
// real agent starts. Proves cmd's own parsing of the script KLYPIX writes
// (folder, id, quoted first prompt) and that Windows Terminal runs it.
if (process.platform === 'win32' && process.env.KLYPIX_REOPEN_E2E === '1') {
  const { execFileSync } = await import('node:child_process');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-reopen-fake-'));
  const work = path.join(fake, 'Shop 100% (x86) work');
  fs.mkdirSync(work);
  const marker = path.join(fake, 'marker.txt');
  fs.writeFileSync(path.join(fake, 'codex.cmd'), '@echo off\r\n>"%KLYPIX_E2E_MARKER%" echo ARGS=%*\r\n>>"%KLYPIX_E2E_MARKER%" cd\r\nexit\r\n');
  const env = { ...process.env, PATH: `${fake};${process.env.PATH}`, KLYPIX_E2E_MARKER: marker, KLYPIX_SESSION_ID: 'must-not-leak' };
  const id = 'e2e00000-1111-2222-3333-444444444444';
  const plan = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: work, platform: 'win32', env, find: () => null });
  const launched = launchReopen(plan, { env: {} });
  const waitFor = async (file, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('\n')) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  const seen = await waitFor(marker, 15_000);
  const text = seen ? fs.readFileSync(marker, 'utf8') : '';
  try { if (launched.pid) execFileSync('taskkill', ['/PID', String(launched.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already closed */ }
  ok(launched.launched && seen, 'F1 a real console window opened and ran the script');
  ok(text.includes(`ARGS=resume ${id} "${REOPEN_NUDGE}"`), 'F1 cmd received the exact id and the quoted first prompt');
  ok(text.split(/\r?\n/)[1]?.trim().toLowerCase() === work.toLowerCase(), 'F1 it ran in the session folder (spaces, %, parentheses intact)');

  const wt = buildReopenLaunch({ hostKey: 'codex', sessionId: id, cwd: work, platform: 'win32', env });
  if (wt.method === 'windows-terminal') {
    const marker2 = path.join(fake, 'marker-wt.txt');
    // Same plan, harmless body: Windows Terminal may start the tab from its own
    // environment, so the fake codex is not guaranteed to be first on PATH there.
    const plan2 = { ...wt, script: { ...wt.script, content: `@echo off\r\ncd /d "${work.replace(/%/g, '%%')}"\r\n>"${marker2}" cd\r\nexit\r\n` } };
    const launched2 = launchReopen(plan2, { env: {} });
    const seen2 = await waitFor(marker2, 15_000);
    ok(launched2.launched && seen2 && fs.readFileSync(marker2, 'utf8').trim().toLowerCase() === work.toLowerCase(),
      'F2 a real Windows Terminal window opened, ran the script in the session folder, and closed');
  } else {
    console.log('[skip] F2 Windows Terminal is not installed here');
  }
  fs.rmSync(fake, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n✓ session-reopen: ${checks} checks passed`);
