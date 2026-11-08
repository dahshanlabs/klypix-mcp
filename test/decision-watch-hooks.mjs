// Real hook/worker processes, fake host payloads. No model, credentials, live
// brain, installed runtime or user configuration is used. All writes are below
// this one newly-created temporary root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decision-hooks-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const config = path.join(home, 'gitconfig'); fs.writeFileSync(config, '');
for (const name of Object.keys(process.env)) if (/^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI|KLYPIX|XDG_|GIT_)/i.test(name)) delete process.env[name];
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  TEMP: root, TMP: root, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local'), XDG_CACHE_HOME: path.join(home, '.cache'),
  KLYPIX_AUTO_UPDATE: '0', KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_APP_TOOLS: 'off',
  KLYPIX_APP_BRIDGE_DIR: path.join(root, 'bridge'), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' });
const stateDir = path.join(home, '.claude', 'project-brain');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
const originalCwd = process.cwd(); process.chdir(root);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildKlypixMap, parseKlypix, shard } = await import('../src/klypix-format.mjs');
const { syncDecisionWatch, decisionSnapshot } = await import('../src/decision-watch.mjs');
const { decisionChangesAtBoundary, decisionWatchPath } = await import('../src/decision-watch-boundary.mjs');
const { listActiveSessions, upsertSession } = await import('../src/agent-presence.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; console.log(`[ok] ${message}`); };
const clients = [];
async function fixture(name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const file = path.join(dir, 'brain.klypix');
  const bytes = await buildKlypixMap({ title: 'Hook decision fixture', kind: 'brain', areas: [
    { title: 'Pricing', cards: [{ text: 'Pricing rounding decision\nRound tax per invoice line. OLD_POLICY_713.' }] },
    { title: 'Other', cards: [{ text: 'Calendar pages contain twenty entries.' }] },
    { title: 'Guards', cards: [
      { text: '🛠️ A warning for the review command.', guard: { when: { tool: 'Bash', command: '^echo review$' }, message: 'EXISTING_WARN_713' } },
      { text: '🛠️ Refuse the forbidden fixture command.', guard: { when: { tool: 'Bash', command: '^echo forbidden$' }, severity: 'block', message: 'EXISTING_DENY_713' } },
    ] },
  ] });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(dir, 'invoice.txt'), 'unmodified');
  const parsed = await parseKlypix(bytes);
  const card = parsed.struct.cards.find(c => c.text?.includes('OLD_POLICY_713'));
  return { dir, file, card: card.id, parent: card.parentId,
    other: parsed.struct.cards.find(c => c.text?.includes('Calendar')).id };
}
async function mutate(p, { edits = {}, edges, layout = false } = {}) {
  const parsed = await parseKlypix(fs.readFileSync(p.file));
  for (const [id, patch] of Object.entries(edits)) {
    const file = `items/${shard(id)}/${id}.json`;
    const item = JSON.parse(await parsed.zip.file(file).async('string'));
    parsed.zip.file(file, JSON.stringify({ ...item, ...patch }));
  }
  if (edges) parsed.canvas.connections = edges;
  if (layout) parsed.canvas.positions[p.card].x += 100;
  parsed.zip.file('canvas.json', JSON.stringify(parsed.canvas));
  fs.writeFileSync(p.file, await parsed.zip.generateAsync({ type: 'nodebuffer' }));
}
function hook(p, client, sid, event, extra = {}) {
  const claude = client === 'claude-code';
  const args = claude ? [event === 'UserPromptSubmit' ? '--prompt' : '--guard'] : [];
  const text = execFileSync(process.execPath, [path.join(repo, 'src', claude ? 'global-brain-hook.mjs' : 'codex-brain-hook.mjs'), ...args], {
    cwd: p.dir, env: { ...process.env, ...(claude ? { CLAUDE_PID: String(process.pid) } : {}) },
    input: JSON.stringify({ session_id: sid, hook_event_name: event, cwd: p.dir, ...extra }),
    encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (event === 'UserPromptSubmit' && claude) return { text };
  return text.trim() ? JSON.parse(text) : {};
}
async function connect(p, name, sid) {
  const client = new Client({ name, version: 'decision-hook-test' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'bin/klypix-worker.mjs'), '--vault', p.dir], cwd: p.dir,
    env: { ...process.env, KLYPIX_TOOLS: 'all', ...(name === 'claude-code' ? { CLAUDE_PID: String(process.pid) } : {}) }, stderr: 'pipe' });
  await client.connect(transport); clients.push(client);
  return args => client.callTool({ name: 'brain_sync', arguments: { project: p.dir, ...args },
    ...(name === 'codex' ? { _meta: { threadId: sid } } : {}) });
}
const payload = command => ({ tool_name: 'Bash', tool_input: { command } });
const context = output => output.hookSpecificOutput?.additionalContext || '';
const row = (p, sid) => listActiveSessions({ brainPath: p.file }).find(s => s.id === sid);

try {
  const p = await fixture('claude'); const sid = 'native-claude-decision-test';
  const noWatch = await decisionChangesAtBoundary({ brainPath: p.file, sessionId: sid,
    session: { id: sid, scopeGeneration: 1, scopeStartedAt: 100 } });
  ok(noWatch.status === 'not-watching' && !fs.existsSync(decisionWatchPath(p.file, sid)), 'no-watch boundary creates no baseline or state');
  hook(p, 'claude-code', sid, 'UserPromptSubmit', { prompt: 'Implement invoice pricing rounding.' });
  const sync = await connect(p, 'claude-code', sid);
  const start = await sync({ phase: 'start', intent: 'Implement invoice pricing rounding', files: ['invoice.txt'] });
  ok(start.structuredContent.self.id === sid && start.structuredContent.decisionChanges.watched > 0,
    'real Claude lifecycle hostmap and MCP share the native session; capsule watches automatically');
  const firstTask = row(p, sid);
  const untouched = hook(p, 'claude-code', sid, 'PreToolUse', payload('echo inspect'));
  ok(!context(untouched).includes('Decision changes'), 'unchanged Claude boundary is quiet');
  const cached = await decisionChangesAtBoundary({ brainPath: p.file, sessionId: sid, session: firstTask });
  ok(cached.cached === true && cached.status === 'unchanged', 'unchanged watch uses small-state/stat fast path');
  await mutate(p, { layout: true, edits: { [p.other]: { content: 'Calendar pages contain thirty entries.' } } });
  ok(!context(hook(p, 'claude-code', sid, 'PreToolUse', payload('echo inspect'))).includes('Decision changes'), 'layout and unwatched text changes do not alert');
  await mutate(p, { edits: { [p.card]: { content: 'Pricing rounding decision\nRound once on subtotal. NEW_POLICY_713.' } } });
  const stateFile = decisionWatchPath(p.file, sid);
  const beforeWrongIdentity = fs.readFileSync(stateFile, 'utf8');
  ok(!context(hook(p, 'claude-code', 'other-session', 'PreToolUse', payload('echo inspect'))).includes('OLD_POLICY_713'), 'another native session cannot receive the watched body');
  ok(!context(hook(p, 'claude-code', sid, 'PreToolUse', { ...payload('echo inspect'), agent_id: 'child-agent' })).includes('OLD_POLICY_713')
    && fs.readFileSync(stateFile, 'utf8') === beforeWrongIdentity, 'Claude child payload neither borrows nor mutates its parent watch');
  const warning = hook(p, 'claude-code', sid, 'PreToolUse', payload('echo review'));
  ok(context(warning).includes('EXISTING_WARN_713') && context(warning).includes('OLD_POLICY_713') && context(warning).includes('NEW_POLICY_713')
    && context(warning).includes('PENDING REVIEW') && !warning.hookSpecificOutput.permissionDecision,
  'real Claude guard composes old/current decision warning with existing advisory, without denying');
  ok(fs.readFileSync(path.join(p.dir, 'invoice.txt'), 'utf8') === 'unmodified', 'warning is offered at a harmless boundary before the test performs its later edit');
  fs.writeFileSync(path.join(p.dir, 'invoice.txt'), 'later implementation action');
  const repeat = context(hook(p, 'claude-code', sid, 'PreToolUse', payload('echo inspect')));
  ok(repeat.includes('PENDING REVIEW') && !repeat.includes('OLD_POLICY_713') && repeat.length < 400, 'subsequent pending boundary is compact and does not infer adoption');
  const denied = hook(p, 'claude-code', sid, 'PreToolUse', payload('echo forbidden'));
  ok(denied.hookSpecificOutput.permissionDecision === 'deny' && denied.hookSpecificOutput.permissionDecisionReason.includes('EXISTING_DENY_713'), 'existing guard deny retains precedence and reason');
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok(!JSON.stringify(stored.boundary).includes('POLICY_713'), 'fast-path cache stores no decision bodies');
  const parent = (await parseKlypix(fs.readFileSync(p.file))).struct.cards.find(c => c.id === p.card).parentId;
  await mutate(p, { edits: { [parent]: { scopeLocked: true }, [p.card]: { content: 'PRIVATE_NOW_713' } } });
  const hidden = context(hook(p, 'claude-code', sid, 'PreToolUse', payload('echo inspect')));
  ok(hidden.includes('withheld') && !/OLD_POLICY_713|NEW_POLICY_713|PRIVATE_NOW_713/.test(hidden), 'privacy lock invalidates cached pending state and withholds both bodies');
  ok(!fs.readFileSync(stateFile, 'utf8').includes('OLD_POLICY_713'), 'privacy recheck removes cached old body from the watch');
  await sync({ phase: 'checkpoint', include_context: false });
  const done = await sync({ phase: 'complete', include_context: false });
  ok(done.structuredContent.status === 'complete' && done.structuredContent.decisionChanges.pending > 0, 'completion releases scope while pending remains explicit');
  const completedBytes = fs.readFileSync(stateFile, 'utf8');
  ok(!context(hook(p, 'claude-code', sid, 'PreToolUse', payload('echo inspect'))).includes('Decision changes')
    && fs.readFileSync(stateFile, 'utf8') === completedBytes, 'late hook does not revive or mutate a completed task');

  const c = await fixture('codex'); const codexSid = 'native-codex-decision-test';
  hook(c, 'codex', codexSid, 'UserPromptSubmit', { prompt: 'Implement invoice pricing rounding.' });
  const codexSync = await connect(c, 'codex', codexSid);
  const codexStart = await codexSync({ phase: 'start', intent: 'Implement invoice pricing rounding', files: ['invoice.txt'] });
  ok(codexStart.structuredContent.self.id === codexSid && codexStart.structuredContent.decisionChanges.watched > 0,
    'Codex host-authored thread metadata matches native hook identity without a session override');
  const oldTask = row(c, codexSid);
  await mutate(c, { edits: { [c.other]: { content: 'Aggregate the fiscal base once. SUCCESSOR_713.' } },
    edges: [{ id: 'correction', fromId: c.card, toId: c.other, label: 'superseded by' }] });
  const codexNotice = hook(c, 'codex', codexSid, 'PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'echo inspect' }, tool_use_id: 'inspect-1' });
  ok(codexNotice.continue === true && codexNotice.hookSpecificOutput.hookEventName === 'PostToolUse'
    && context(codexNotice).includes('OLD_POLICY_713') && context(codexNotice).includes('SUCCESSOR_713')
    && context(codexNotice).includes(c.card) && context(codexNotice).includes(c.other),
  'existing Codex post-tool envelope offers explicit supersession before a later action');
  const pre = hook(c, 'codex', codexSid, 'PreToolUse', { tool_name: 'apply_patch', tool_input: { patch: '' }, tool_use_id: 'edit-2' });
  ok(pre.continue === true && context(pre).includes('PENDING REVIEW') && !context(pre).includes('SUCCESSOR_713'), 'Codex pre-tool uses the same pending state, with no blocking decision');
  const current = await codexSync({ phase: 'checkpoint' });
  const change = current.structuredContent.decisionChanges.changes[0];
  await codexSync({ phase: 'checkpoint', decision_reviews: [{ change_id: change.change_id, revision: change.revision,
    outcome: 'adapted', note: 'Checked the fixture implementation.' }] });
  ok(!context(hook(c, 'codex', codexSid, 'PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'echo inspect' } })).includes('PENDING REVIEW'), 'explicit current-revision agent report clears the reminder');
  await codexSync({ phase: 'start', intent: 'Start another invoice task', files: ['invoice.txt'] });
  const currentBytes = fs.readFileSync(decisionWatchPath(c.file, codexSid), 'utf8');
  const stale = await syncDecisionWatch({ brainPath: c.file, sessionId: codexSid,
    taskGeneration: oldTask.scopeGeneration, taskStartedAt: oldTask.scopeStartedAt, existingOnly: true });
  ok(stale.status === 'not-watching' && fs.readFileSync(decisionWatchPath(c.file, codexSid), 'utf8') === currentBytes,
    'delayed prior-task boundary cannot overwrite a newer task baseline');
  const corruptFile = decisionWatchPath(c.file, codexSid); fs.writeFileSync(corruptFile, '{bad');
  const corrupt = context(hook(c, 'codex', codexSid, 'PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'echo inspect' } }));
  ok(corrupt.includes('UNKNOWN') && fs.readFileSync(corruptFile, 'utf8') === '{bad', 'corrupt watch remains intact and produces UNKNOWN');

  // Preserve the existing ownership fallback too: adding decision context must
  // not hide the ownership advisory or replace a prior ask/deny decision.
  const o = await fixture('ownership'); const ownerSid = 'native-owner-test';
  const git = (...args) => execFileSync('git', ['-C', o.dir, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false'); git('add', '--', 'brain.klypix', 'invoice.txt'); git('commit', '-q', '-m', 'fixture');
  hook(o, 'claude-code', ownerSid, 'UserPromptSubmit', { prompt: 'Implement invoice pricing rounding.' });
  const owner = row(o, ownerSid);
  const parsedOwner = await parseKlypix(fs.readFileSync(o.file));
  await syncDecisionWatch({ brainPath: o.file, sessionId: ownerSid, taskGeneration: owner.scopeGeneration,
    taskStartedAt: owner.scopeStartedAt, served: [decisionSnapshot(parsedOwner.struct.cards.find(c => c.id === o.card))] });
  fs.writeFileSync(path.join(o.dir, 'invoice.txt'), 'peer unfinished edit');
  const whose = await import('../src/whose.mjs');
  await whose.recordEdits({ brainPath: o.file, sid: 'peer-owner-test', client: 'codex', cwd: o.dir, files: ['invoice.txt'], home });
  upsertSession({ brainPath: o.file, home, id: 'peer-owner-test', client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit',
    logicalSessionId: 'peer-owner-test', identitySource: 'codex-lifecycle', intent: 'Change invoice', files: ['invoice.txt'] });
  await mutate(o, { edits: { [o.card]: { content: 'Pricing now uses the combined subtotal. OWNER_CURRENT_713.' } } });
  const ownershipNotice = context(hook(o, 'claude-code', ownerSid, 'PreToolUse', payload('git status')));
  ok(ownershipNotice.includes('invoice.txt') && ownershipNotice.includes('OWNER_CURRENT_713'), 'decision alert preserves the prior ownership advisory fallback');
  const ownershipAsk = hook(o, 'claude-code', ownerSid, 'PreToolUse', payload('git reset --hard'));
  ok(ownershipAsk.hookSpecificOutput.permissionDecision === 'ask' && /rescue copy/i.test(ownershipAsk.hookSpecificOutput.permissionDecisionReason),
    'existing ownership ask remains unchanged while a decision review is pending');
  const race = await fixture('retrieval-race');
  const raceParsed = await parseKlypix(fs.readFileSync(race.file));
  const servedBeforeWrite = decisionSnapshot(raceParsed.struct.cards.find(c => c.id === race.card));
  await mutate(race, { edits: { [race.other]: { content: servedBeforeWrite.text } },
    edges: [{ id: 'same-body-replacement', fromId: race.card, toId: race.other, label: 'superseded by' }] });
  await syncDecisionWatch({ brainPath: race.file, sessionId: 'race-session', taskGeneration: 1, taskStartedAt: 100,
    served: [servedBeforeWrite] });
  const raceNotice = await decisionChangesAtBoundary({ brainPath: race.file, sessionId: 'race-session',
    session: { id: 'race-session', scopeGeneration: 1, scopeStartedAt: 100 } });
  ok(raceNotice.pending === 1 && raceNotice.changes[0].kind === 'superseded',
    'a replacement racing with capsule baseline cannot be cached unchanged even when both bodies match');
  console.log(`\n${checks} native-boundary assertions passed. Fixtures: ${root}`);
} finally {
  for (const client of clients) await client.close();
  process.chdir(originalCwd);
}
