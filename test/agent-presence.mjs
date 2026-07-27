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
import {
  buildPresenceSnapshot,
  createMcpPresence,
  KLYPIX_MCP_INSTRUCTIONS,
} from '../src/mcp-presence.mjs';

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

upsertSession({ brainPath, home, now, id: 'merged', client: 'codex', channel: 'mcp' });
upsertSession({ brainPath, home, now: now + 1, id: 'merged', client: 'codex', channel: 'lifecycle' });
let merged = listActiveSessions({ brainPath, home, now: now + 1 }).find((session) => session.id === 'merged');
ok(merged?.channels?.length === 2, 'MCP and lifecycle adapters merge into one logical session');
removeSession({ brainPath, home, now: now + 2, id: 'merged', channel: 'mcp' });
merged = listActiveSessions({ brainPath, home, now: now + 2 }).find((session) => session.id === 'merged');
ok(merged?.channels?.length === 1 && merged.channels[0] === 'lifecycle',
  'closing MCP preserves a still-live lifecycle channel');
removeSession({ brainPath, home, now: now + 3, id: 'merged', channel: 'lifecycle' });
ok(!listActiveSessions({ brainPath, home, now: now + 3 }).some((session) => session.id === 'merged'),
  'logical session disappears after its final presence channel closes');

fs.rmSync(path.dirname(laneFileFor(brainPath, home)), { recursive: true, force: true });

const fakeServer = (name) => {
  const notices = [];
  return {
    notices,
    server: { getClientVersion: () => ({ name, version: 'test' }) },
    sendLoggingMessage: (message) => { notices.push(message); },
  };
};
const timer = () => ({ unref() {} });
const mcpA = createMcpPresence({
  server: fakeServer('codex-mcp-client'),
  initialVault: project,
  env: { KLYPIX_SESSION_ID: 'mcp-a' },
  home,
  now: () => now,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
const mcpBServer = fakeServer('cursor');
const mcpB = createMcpPresence({
  server: mcpBServer,
  initialVault: project,
  env: { KLYPIX_SESSION_ID: 'mcp-b-full-session' },
  home,
  now: () => now + 1,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
const queuedLane = laneFileFor(brainPath, home);
fs.mkdirSync(path.dirname(queuedLane), { recursive: true });
fs.writeFileSync(queuedLane, JSON.stringify({
  sessions: [],
  messages: [{
    id: 'queued-message',
    from: 'test-seed',
    to: 'mcp-b-full-session',
    text: 'queued before MCP initialization',
    ts: now,
    seen: [],
  }],
}));
mcpA.start();
const mcpBStart = mcpB.start();
ok(mcpBStart.sessions.length === 2 && mcpBStart.notice.includes('2 active sessions'),
  'a second authorized MCP connection automatically sees the first');
ok(!mcpBStart.notice.includes('queued before MCP initialization'),
  'MCP initialization does not consume a peer message through best-effort logging');
ok(KLYPIX_MCP_INSTRUCTIONS.includes('call brain_sync') && KLYPIX_MCP_INSTRUCTIONS.includes('before editing'),
  'standard MCP server instructions teach approval-free smart synchronization');
const syncA = mcpA.sync({
  phase: 'start',
  intent: 'implement the shared runtime',
  files: ['src/mcp-presence.mjs'],
});
ok(syncA.text.includes('phase start')
  && syncA.structured.counts.activeTasks === 1
  && syncA.structured.counts.backgroundConnections === 1
  && syncA.structured.peers.length === 0,
  'brain_sync publishes task intent while hiding idle MCP connections from the task-peer list');
const syncB = mcpB.sync({
  phase: 'start',
  intent: 'review the shared runtime',
  files: ['src\\mcp-presence.mjs', 'README.md'],
});
ok(syncB.conflicts.length === 1
  && syncB.conflicts[0].files.includes('src/mcp-presence.mjs')
  && syncB.text.includes('file-overlap warning')
  && syncB.text.includes('queued before MCP initialization')
  && syncB.alertsQueued.length === 1
  && syncB.structured.counts.activeTasks === 2,
  'brain_sync delivers queued messages, returns structured task peers, and flags exact overlap across path separators');
const decorated = mcpA.decorateToolResult({ content: [{ type: 'text', text: 'tool result' }] });
ok(decorated.content.some((block) => block.text?.includes('Automatic KLYPIX overlap alert')),
  'a later conflicting task automatically alerts the earlier peer on its next KLYPIX action');
const repeatB = mcpB.sync({
  phase: 'checkpoint',
  intent: 'review the shared runtime',
  files: ['src/mcp-presence.mjs'],
});
ok(repeatB.alertsQueued.length === 0,
  'automatic overlap alerts are exact-once within a task instead of spamming every checkpoint');
const snapshot = buildPresenceSnapshot(repeatB.sessions, 'mcp-b-full-session', { now: now + 1 });
ok(snapshot.activeTaskCount === 2 && snapshot.peers.length === 1 && snapshot.backgroundConnectionCount === 0,
  'task presence is structurally separated from raw connection presence');
const completed = mcpB.sync({ phase: 'complete' });
const completedSession = completed.sessions.find((session) => session.id === 'mcp-b-full-session');
ok(completedSession?.intent === '' && completedSession?.files?.length === 0,
  'brain_sync completion clears stale task intent and expected files while the connection remains live');
mcpB.stop();
ok(listActiveSessions({ brainPath, home, now: now + 2 }).length === 1,
  'closing one MCP connection removes only that live session');
mcpA.stop();
ok(listActiveSessions({ brainPath, home, now: now + 2 }).length === 0,
  'closing the final MCP connection leaves no phantom sessions');

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
