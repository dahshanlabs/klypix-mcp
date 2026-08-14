// intent-guard — the machine-turn intent guard (2026-08-07 AgentLit field
// incident: a harness-injected "<task-notification> <task-id>…" turn was stored
// verbatim as a session's declared intent). Covers:
//   1. deriveIntentFromPrompt() classification (the shared helper),
//   2. upsertSession()'s defense-in-depth (junk never lands, '' still clears),
//   3. brain_sync phase semantics (checkpoint keeps, start clears, complete clears),
//   4. PARITY: the global-brain-hook's duplicated copy behaves identically
//      (spawned as a real --prompt hook run against a temp home + project).
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  deriveIntentFromPrompt,
  laneFileFor,
  looksMachineTurn,
  sweepStaleTmpFiles,
  upsertSession,
} from '../src/agent-presence.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// ── 1. deriveIntentFromPrompt classification ─────────────────────────────────
const FIELD_JUNK = '<task-notification> <task-id>bwri2eaxv</task-id> <tool-use-id>toolu_01QPWUjmYU3A';
ok(deriveIntentFromPrompt('fix the login redirect bug') === 'fix the login redirect bug',
  'plain human text passes through');
ok(deriveIntentFromPrompt(FIELD_JUNK) === null,
  'the exact field junk (unterminated task-notification) is machine');
ok(deriveIntentFromPrompt('<task-notification><task-id>x</task-id>done</task-notification>') === null,
  'a complete task-notification block is machine');
ok(deriveIntentFromPrompt('<system-reminder>context stuff</system-reminder> please fix the save bug') === 'please fix the save bug',
  'a leading system-reminder is stripped, the human tail survives');
ok(deriveIntentFromPrompt('<command-name>/model</command-name> <command-message>model</command-message> <command-args>opus</command-args>') === null,
  'a slash-command wrapper with no human text is machine');
ok(deriveIntentFromPrompt('[SYSTEM NOTIFICATION - NOT USER INPUT] This is an automated event, not the user.') === null,
  'a SYSTEM NOTIFICATION-led turn is machine end to end');
ok(deriveIntentFromPrompt('why does <div> not render?') === 'why does <div> not render?',
  'a tag mid-sentence does not trip the guard');
ok(deriveIntentFromPrompt('<div class="x">pasted markup</div> why broken?') === null,
  'a tag-shaped START fails closed (previous intent kept, never junk)');
ok(deriveIntentFromPrompt('') === null && deriveIntentFromPrompt('   ') === null,
  'empty prompts derive to null');
ok(looksMachineTurn(FIELD_JUNK) === true && looksMachineTurn('') === false && looksMachineTurn('ship it') === false,
  'looksMachineTurn: junk yes, empty no (complete-clears must keep working), human no');

// ── 2. upsertSession defense-in-depth ────────────────────────────────────────
const home = path.join(os.tmpdir(), 'klypix-intent-guard-home');
const project = path.join(os.tmpdir(), 'klypix-intent-guard-project');
for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({
  title: 'intent guard fixture',
  kind: 'brain',
  areas: [{ title: 'Brain', cards: [{ text: 'fixture card' }] }],
}));

const now = 2_000_000_000_000;
upsertSession({ brainPath, home, now, id: 's1', client: 'claude-code', intent: 'build the parser' });
let rows = upsertSession({ brainPath, home, now: now + 1000, id: 's1', client: 'claude-code', intent: FIELD_JUNK });
ok(rows.find(r => r.id === 's1')?.intent === 'build the parser',
  'upsertSession refuses machine junk and keeps the previous intent');
rows = upsertSession({ brainPath, home, now: now + 2000, id: 's1', client: 'claude-code', intent: 'refactor the exporter' });
ok(rows.find(r => r.id === 's1')?.intent === 'refactor the exporter',
  'a real intent still updates normally after a junk attempt');
rows = upsertSession({ brainPath, home, now: now + 3000, id: 's1', client: 'claude-code', intent: '' });
ok(rows.find(r => r.id === 's1')?.intent === '',
  "an explicit empty intent still clears (brain_sync complete semantics)");

// ── 3. brain_sync phase semantics ────────────────────────────────────────────
const timer = () => ({ unref() {} });
const fakeServer = { getClientVersion: () => ({ name: 'test-host', version: 't' }), sendLoggingMessage: () => {} };
let clock = now + 10_000;
const mcp = createMcpPresence({
  server: fakeServer,
  initialVault: project,
  env: { KLYPIX_SESSION_ID: 'sync-sess' },
  home,
  now: () => clock,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
mcp.start();
mcp.sync({ phase: 'start', intent: 'wire the exporter', files: ['src/export.mjs'] });
const laneFile = laneFileFor(brainPath, home);
const laneRow = () => JSON.parse(fs.readFileSync(laneFile, 'utf8')).sessions.find(s => s.id === 'sync-sess');
ok(laneRow().intent === 'wire the exporter', 'phase start declares the intent');
clock += 1000;
mcp.sync({ phase: 'checkpoint' });
ok(laneRow().intent === 'wire the exporter',
  'a checkpoint without intent KEEPS the declaration (no more declared-empty masking)');
clock += 1000;
mcp.sync({ phase: 'checkpoint', intent: '' });
ok(laneRow().intent === 'wire the exporter',
  'a checkpoint with an explicitly empty intent also keeps the declaration');
clock += 1000;
mcp.sync({ phase: 'start' });
ok(laneRow().intent === '',
  'a NEW task start without intent clears the old declaration (task boundary honesty)');
clock += 1000;
mcp.sync({ phase: 'start', intent: 'second task' });
clock += 1000;
// A checkpoint marks this as a deliberate multi-step task, so the following
// complete is a true task boundary. (A complete with no results, no checkpoint,
// moments after start is downgraded to a scope-preserving checkpoint — the
// turn-end guard, covered in test/completion-guard.mjs.)
mcp.sync({ phase: 'checkpoint' });
clock += 1000;
mcp.sync({ phase: 'complete' });
ok(laneRow().intent === '' && (laneRow().files || []).length === 0,
  'phase complete clears intent and files');

// ── 4. tmp sweep ─────────────────────────────────────────────────────────────
const laneDir = path.dirname(laneFile);
const staleTmp = path.join(laneDir, 'x.json.tmp-123-abc123');
const staleReceipt = path.join(laneDir, 'y.json.12345.tmp');
const freshTmp = path.join(laneDir, 'z.json.tmp-999-zzz999');
fs.writeFileSync(staleTmp, 'x'); fs.writeFileSync(staleReceipt, 'y'); fs.writeFileSync(freshTmp, 'z');
const old = Date.now() - 60 * 60 * 1000;
fs.utimesSync(staleTmp, new Date(old), new Date(old));
fs.utimesSync(staleReceipt, new Date(old), new Date(old));
const swept = sweepStaleTmpFiles(laneDir, { force: true });
ok(swept >= 2 && !fs.existsSync(staleTmp) && !fs.existsSync(staleReceipt) && fs.existsSync(freshTmp),
  'the janitor removes stale tmp orphans (both naming schemes) and spares fresh ones');

// ── 4b. cloud-relayed rows honor the same guard ──────────────────────────────
{
  const { upsertRemoteSessions } = await import('../src/agent-presence.mjs');
  upsertRemoteSessions({
    brainPath, home, now: now + 20_000,
    rows: [{ id: 'remote-1', machine: 'other-machine', via: 'cloud', client: 'codex', intent: 'port the exporter' }],
  });
  const rows2 = upsertRemoteSessions({
    brainPath, home, now: now + 21_000,
    rows: [{ id: 'remote-1', machine: 'other-machine', via: 'cloud', client: 'codex', intent: FIELD_JUNK }],
  });
  ok(rows2.find(r => r.id === 'remote-1')?.intent === 'port the exporter',
    'a peer machine relaying junk intent cannot overwrite a good remote declaration');
}

// ── 5. PARITY: the global-brain-hook twin, spawned for real ──────────────────
// The guard is deliberately DUPLICATED (the hook takes no sibling static
// imports). Pin the two copies against each other by extracting the source
// region from both files — behavior tests below can pass while the copies drift
// on an input neither test covers, which is exactly how twins rot.
{
  const extract = (file) => {
    // Strip CR first — the working copy may be CRLF, and an end-marker miss
    // would silently compare far more than the guard (caught in review).
    const src = fs.readFileSync(path.join(root, 'src', file), 'utf8').replace(/\r/g, '');
    const start = src.indexOf('const MACHINE_TAGS');
    const endMark = src.indexOf('return text;\n', start);
    if (start < 0 || endMark < 0) return null;
    return src.slice(start, endMark)
      .replace(/^\s*\/\/.*$/gm, '')       // comments may differ in wording
      .replace(/^export /gm, '')          // one copy exports, one is local
      .replace(/\s+/g, ' ')
      .trim();
  };
  const a = extract('agent-presence.mjs');
  const b = extract('global-brain-hook.mjs');
  // Both must be FOUND (a null means the markers moved — the pin would then
  // pass vacuously on a===b===null, the classic dead-parity-test failure).
  ok(Boolean(a) && Boolean(b) && a.length > 400 && a.length < 4000,
    'PARITY PIN: the guard region is locatable and plausibly sized in both files');
  ok(a === b,
    'PARITY PIN: the intent-guard source is identical in agent-presence.mjs and global-brain-hook.mjs');
}

const hookPath = path.join(root, 'src', 'global-brain-hook.mjs');
const hookHome = path.join(os.tmpdir(), 'klypix-intent-guard-hookhome');
fs.rmSync(hookHome, { recursive: true, force: true });
fs.mkdirSync(hookHome, { recursive: true });
const hookEnv = {
  ...process.env,
  HOME: hookHome, USERPROFILE: hookHome,
  // isolate from any real machine state
  KLYPIX_AUTO_UPDATE: '0',
};
const runHook = (args, input) => execFileSync(process.execPath, [hookPath, ...args], {
    cwd: project,
    input: JSON.stringify(input),
    env: hookEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
const runPromptHook = (prompt, sid, transcriptPath) => runHook(['--prompt'], {
  session_id: sid,
  prompt,
  ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
});
const hookLane = laneFileFor(brainPath, hookHome);
runPromptHook('polish the exporter edge cases', 'hook-sess');
let hookRows = JSON.parse(fs.readFileSync(hookLane, 'utf8')).sessions;
ok(hookRows.find(r => r.id === 'hook-sess')?.intent === 'polish the exporter edge cases',
  'hook --prompt: a human prompt becomes the lane intent (spawned end-to-end)');
runPromptHook(FIELD_JUNK, 'hook-sess');
hookRows = JSON.parse(fs.readFileSync(hookLane, 'utf8')).sessions;
const hookRow = hookRows.find(r => r.id === 'hook-sess');
ok(hookRow?.intent === 'polish the exporter edge cases',
  'hook --prompt PARITY: the field junk never replaces the human intent');
ok(Number(hookRow?.activityAt || 0) > 0,
  'hook --prompt: a machine turn still stamps activity (session is working, not idle)');

// ── 6. Completion is a hard scope-generation boundary ──────────────────────
// Claude Stop scans an append-only transcript. Once brain_sync completes the
// task, that scan must not re-add historical paths; a later human prompt opens
// a fresh generation and live write observations union only that active work.
{
  const sid = 'hook-scope-generation';
  const transcript = path.join(project, 'scope-generation.jsonl');
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(hookHome, '.claude', 'project-brain'), { recursive: true });
  fs.writeFileSync(path.join(hookHome, '.claude', 'project-brain', '.npm-currency.json'), JSON.stringify({
    pkg: 'klypix-mcp', latest: 'test', checkedAt: Date.now(),
  }));
  const editEntry = (id, file, timestamp) => JSON.stringify({
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path.join(project, file) } }],
    },
  }) + '\n';
  const liveEdit = (file) => runHook(['--live'], {
    session_id: sid,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(project, file) },
  });
  const readScopeRow = () => JSON.parse(fs.readFileSync(laneFileFor(brainPath, hookHome), 'utf8'))
    .sessions.find((row) => row.id === sid);

  runPromptHook('first scoped task', sid, transcript);
  fs.appendFileSync(transcript, editEntry('old-1', 'src/old-task.mjs', new Date().toISOString()));
  liveEdit('src/old-task.mjs');
  let scopeRow = readScopeRow();
  ok(scopeRow?.files?.includes('src/old-task.mjs') && Number(scopeRow?.scopeGeneration || 0) === 1,
    'scope boundary: first human prompt opens generation 1 and live edits populate its file union');
  ok(Number.isInteger(scopeRow?.channelOwners?.lifecycle) && scopeRow.channelOwners.lifecycle > 0,
    'scope parity: the duplicated Claude writer records the lifecycle channel owner PID');

  const scopeMcp = createMcpPresence({
    server: fakeServer,
    initialVault: project,
    env: { KLYPIX_SESSION_ID: sid },
    home: hookHome,
    now: () => Date.now(),
    setIntervalFn: timer,
    clearIntervalFn: () => {},
  });
  scopeMcp.start();
  scopeMcp.sync({ phase: 'complete' });
  scopeRow = readScopeRow();
  const completedGeneration = scopeRow.scopeGeneration;
  const completedAt = scopeRow.completedAt;
  ok(Number(completedAt) > 0 && scopeRow.intent === '' && scopeRow.files.length === 0,
    'scope boundary: brain_sync complete clears active scope and stamps completedAt');

  runHook(['--capture'], { session_id: sid, transcript_path: transcript });
  scopeRow = readScopeRow();
  ok(scopeRow.completedAt === completedAt && scopeRow.scopeGeneration === completedGeneration
    && scopeRow.files.length === 0,
  'scope boundary: the later Claude Stop cannot resurrect historical transcript paths');

  runPromptHook('second scoped task', sid, transcript);
  scopeRow = readScopeRow();
  ok(scopeRow.completedAt === null && scopeRow.scopeGeneration === completedGeneration + 1
    && scopeRow.files.length === 0,
  'scope boundary: the next human prompt opens a fresh generation with empty scope');
  fs.appendFileSync(transcript, editEntry('new-1', 'src/new-a.mjs', new Date().toISOString()));
  liveEdit('src/new-a.mjs');
  fs.appendFileSync(transcript, editEntry('new-2', 'src/new-b.mjs', new Date().toISOString()));
  liveEdit('src/new-b.mjs');
  runHook(['--capture'], { session_id: sid, transcript_path: transcript });
  scopeRow = readScopeRow();
  ok(scopeRow.files.includes('src/new-a.mjs') && scopeRow.files.includes('src/new-b.mjs')
    && !scopeRow.files.includes('src/old-task.mjs'),
  'scope boundary: active-work observations union across the fresh task without historical leakage');
  scopeMcp.stop();
}

process.exit(failures ? 1 : 0);
