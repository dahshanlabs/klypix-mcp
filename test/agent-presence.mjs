import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatPresenceMessage,
  laneFileFor,
  listActiveSessions,
  removeSession,
  SESSION_FRESH_MS,
  upsertSession,
} from '../src/agent-presence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'src', 'codex-brain-hook.mjs');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = path.join(os.tmpdir(), 'klypix-presence-home');
const project = path.join(os.tmpdir(), 'klypix-presence-project');
for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');

const now = 2_000_000_000_000;
upsertSession({
  brainPath,
  home,
  now,
  id: 'claude-session',
  client: 'claude-code',
  branch: 'main',
  intent: 'keep the existing capture path stable',
});
const two = upsertSession({
  brainPath,
  home,
  now: now + 1000,
  id: 'codex-session',
  client: 'codex',
  surface: 'desktop',
  model: 'gpt-test',
  branch: 'feat/presence',
  intent: 'wire agent-neutral presence',
  files: ['src/agent-presence.mjs'],
});
ok(two.length === 2, 'shared lane contains Claude Code and Codex together');
ok(two.find((session) => session.id === 'codex-session')?.model === 'gpt-test',
  'agent-neutral session metadata is preserved');

const summary = formatPresenceMessage(two, 'codex-session', { includeSolo: true, now: now + 1000 });
ok(summary.includes('2 active sessions') && summary.includes('Claude Code 1') && summary.includes('Codex 1'),
  'presence summary reports the all-host count and mix');
ok(summary.includes('claude-s') && summary.includes('keep the existing capture path stable'),
  'presence summary identifies the other active session');

const soloSummary = formatPresenceMessage([two.find((session) => session.id === 'codex-session')],
  'codex-session', { includeSolo: true, now: now + 1000 });
ok(soloSummary.includes('recent chat rows are history, not active sessions'),
  'solo summary distinguishes chat history from lifecycle presence');

const pruned = listActiveSessions({ brainPath, home, now: now + SESSION_FRESH_MS + 2000 });
ok(pruned.length === 0, 'crashed sessions expire after the presence TTL');

upsertSession({ brainPath, home, now, id: 'one', client: 'codex' });
removeSession({ brainPath, home, now: now + 1, id: 'one' });
ok(!listActiveSessions({ brainPath, home, now: now + 1 }).some((session) => session.id === 'one'),
  'SessionEnd semantics remove a session immediately');

fs.rmSync(path.dirname(laneFileFor(brainPath, home)), { recursive: true, force: true });
const env = { ...process.env, HOME: home, USERPROFILE: home };
const runHook = (input) => execFileSync(process.execPath, [hook], {
  cwd: project,
  env,
  encoding: 'utf8',
  input: JSON.stringify(input),
});

const startOutput = runHook({
  session_id: 'codex-real-a',
  cwd: project,
  hook_event_name: 'SessionStart',
  model: 'gpt-test',
});
const startJson = JSON.parse(startOutput);
ok(startJson.continue === true && /1 active session/.test(startJson.systemMessage),
  'real Codex SessionStart hook publishes and returns truthful awareness');

const promptOutput = runHook({
  session_id: 'codex-real-b',
  cwd: project,
  hook_event_name: 'UserPromptSubmit',
  prompt: 'work on a different file',
});
const promptJson = JSON.parse(promptOutput);
ok(/2 active sessions/.test(promptJson.systemMessage) && /codex-r/.test(promptJson.systemMessage),
  'a second real Codex hook sees the first active session');

runHook({
  session_id: 'codex-real-b',
  cwd: project,
  hook_event_name: 'PostToolUse',
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Update File: src/example.mjs\n@@\n-old\n+new\n' },
});
const live = listActiveSessions({ brainPath, home });
ok(live.find((session) => session.id === 'codex-real-b')?.files.includes('src/example.mjs'),
  'PostToolUse records touched files without reading a transcript');

runHook({
  session_id: 'codex-real-a',
  cwd: project,
  hook_event_name: 'SessionEnd',
});
ok(!listActiveSessions({ brainPath, home }).some((session) => session.id === 'codex-real-a'),
  'real Codex SessionEnd removes the session immediately');

for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] agent-presence: all assertions passed');
process.exit(failures ? 1 : 0);
