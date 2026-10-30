// Small identity (1.109.0): subagent child ids, the model stamp, the role label.
//
//   S1  helpers: a child id is derived from the host's agent id, deterministic,
//       and parsed back; roles and model ids are cleaned; a model the host did
//       not report is "unknown", never a guess.
//   S2  presence: role and model are additive on a lane row; an old row with
//       neither still reads; a declared '' clears the role.
//   S3  a subagent entry can be written only for an id the host reported.
//   S4  the Claude Code hooks end to end: SessionStart records the model,
//       SubagentStart creates the child and hands it its id, a subagent's edit
//       lands on its child entry, a sibling editing the same file is warned,
//       SubagentStop keeps the transcript, and the parent's Stop captures the
//       subagent's marker under the child id with the model each transcript
//       entry names.
//   S5  handoffs: "for: <role>", the writer's model and role round-trip; an
//       old card without them still parses; cards for the reader's role are
//       offered first.
//   S6  the MCP server over stdio: brain_sync role shows to peers; a
//       subagent's brain_sync lands on its child entry and leaves the parent's
//       task alone; an id the host never reported falls back to the parent and
//       says so; brain_note stamps "unknown" for a model the host did not send.
//
// Run:  node test/small-identity.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import {
  childIdentity, formatSubagents, identityStamp, laneFileFor, listActiveSessions, mergeSubagent,
  normalizeModel, normalizeRole, normalizeSubagents, parseChildRef, rolesMatch, siblingSubagentsOnFile,
  stampableRowModel, subagentShortId, upsertSession, upsertSubagent, SUBAGENT_ENDED_KEEP_MS,
} from '../src/agent-presence.mjs';
import { formatHandoffCards, handoffMachineField, normalizeHandoffInput, parseHandoffCard, renderHandoffCard } from '../src/session-handoff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const WORKER = path.join(__dirname, '..', 'bin', 'klypix-worker.mjs');
let checks = 0;
const says = (card, phrase) => String(card?.text || '').replace(/\s+/g, ' ').includes(phrase);
const ok = (c, label, detail) => {
  checks++;
  if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000));
  assert.ok(c, label);
  console.log(`[ok] ${label}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-small-identity-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });

// ── S1 helpers ───────────────────────────────────────────────────────────────
{
  const a = subagentShortId('agent-abc123');
  ok(/^sub-[0-9a-f]{6}$/.test(a) && a === subagentShortId('agent-abc123') && a !== subagentShortId('agent-abc124'),
    'S1 a child id is sub-<6 hex>, the same for the same host agent id and different for another');
  ok(subagentShortId(a) === a, 'S1 an already short id is kept as it is');
  ok(childIdentity('7ff6f074-aaaa-bbbb', 'agent-abc123') === `7ff6f074/${a}`, 'S1 the full child id is <parent 8>/sub-<6 hex>');
  ok(parseChildRef(`7ff6f074/${a}`)?.short === a && parseChildRef(a)?.parent === '' && parseChildRef('reviewer') === null && parseChildRef('sub-xyz') === null,
    'S1 a child id parses back; anything else is refused');
  ok(normalizeRole('  Security  reviewer ') === 'Security reviewer' && normalizeRole('a·b|c<d>') === 'a b c d' && normalizeRole('x'.repeat(80)).length === 40,
    'S1 a role is trimmed, field separators and markup are removed, and it is capped at 40 characters');
  ok(rolesMatch('Reviewer', ' reviewer ') && !rolesMatch('', '') && !rolesMatch('reviewer', 'builder'), 'S1 roles match case-insensitively; an empty role matches nothing');
  ok(normalizeModel('claude-opus-5') === 'claude-opus-5' && normalizeModel('<synthetic>') === null && normalizeModel('') === null && normalizeModel('a b') === null,
    'S1 a model id is kept as the host wrote it; a synthetic or malformed one is no model');
  const stamp = identityStamp({ session: 's1', tool: 'codex' });
  ok(stamp.model === 'unknown' && stamp.tool === 'codex' && !('agent' in stamp) && !('role' in stamp), 'S1 a stamp without a reported model says "unknown"');
  const now = Date.now();
  ok(stampableRowModel({ model: 'gpt-5.5', modelSource: 'codex-hook', modelAt: now }, now) === 'gpt-5.5', 'S1 a per-event host report (Codex hook) can be stamped');
  ok(stampableRowModel({ model: 'claude-opus-5', modelSource: 'transcript', modelAt: now }, now) === null
    && stampableRowModel({ model: 'claude-opus-5', modelSource: 'session-start', modelAt: now }, now) === null,
  'S1 a Claude Code row model is never stamped on an MCP-written card (a /model switch between turns is not reported to the server)');
  ok(stampableRowModel({ model: 'gpt-5.5', modelSource: 'codex-hook', modelAt: now - 10 * 60_000 }, now) === null, 'S1 a stale per-event report is not stamped');

  let list = mergeSubagent([], { id: 'agent-1', agentType: 'Explore', start: true }, now);
  list = mergeSubagent(list, { id: 'agent-1', addFiles: ['src/a.js', 'src/a.js'] }, now + 1);
  list = mergeSubagent(list, { id: 'agent-2', agentType: 'general-purpose', start: true, addFiles: ['src/a.js'] }, now + 2);
  ok(list.length === 2 && list[0].files.length === 1 && list[0].agentType === 'Explore', 'S1 subagent entries merge by id, files dedupe');
  const row = { id: 'parent-session-1', subagents: list };
  ok(siblingSubagentsOnFile(row, subagentShortId('agent-1'), 'SRC/A.JS', now + 3).map((e) => e.id).join() === subagentShortId('agent-2'),
    'S1 a sibling on the same file is found (case-folded)');
  list = mergeSubagent(list, { id: 'agent-1', end: true }, now + 4);
  ok(normalizeSubagents(list, now + 5).find((e) => e.id === subagentShortId('agent-1')).endedAt > 0
    && normalizeSubagents(list, now + 4 + SUBAGENT_ENDED_KEEP_MS + 1).every((e) => e.id !== subagentShortId('agent-1')),
  'S1 a finished subagent stays listed for a while, then drops out');
  const line = formatSubagents({ id: 'parent-session-1', subagents: list }, now + 5);
  ok(line.startsWith('subagents: ') && line.includes(`parent-s/${subagentShortId('agent-1')} (Explore, finished) src/a.js`) && line.includes(`parent-s/${subagentShortId('agent-2')} (general-purpose) src/a.js`),
    'S1 presence prints each subagent with its type, state and files', line);
}

// ── S2 / S3 presence rows ────────────────────────────────────────────────────
{
  const proj = path.join(root, 'proj-s2');
  fs.mkdirSync(proj, { recursive: true });
  const brainPath = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brainPath, await buildKlypixMap({ title: 's2', kind: 'brain', areas: [{ title: 'A', cards: [{ text: 'A: one' }] }] }));
  // An OLD row, written the way a pre-1.109 writer did (no role, no model).
  upsertSession({ brainPath, id: 'old-row-session', client: 'claude-code', intent: 'old work', home });
  let rows = listActiveSessions({ brainPath, home });
  ok(rows.find((r) => r.id === 'old-row-session') && !('role' in rows[0]) && !('modelSource' in rows[0]), 'S2 an old row without role or model still reads, and gains neither');
  upsertSession({ brainPath, id: 'codex-row', client: 'codex', model: 'gpt-5.5', modelSource: 'codex-hook', role: 'Reviewer', home });
  rows = listActiveSessions({ brainPath, home });
  const codex = rows.find((r) => r.id === 'codex-row');
  ok(codex.role === 'Reviewer' && codex.model === 'gpt-5.5' && codex.modelSource === 'codex-hook' && codex.modelAt > 0, 'S2 role, model, model source and time land on the row');
  upsertSession({ brainPath, id: 'codex-row', client: 'codex', home });
  ok(listActiveSessions({ brainPath, home }).find((r) => r.id === 'codex-row').role === 'Reviewer', 'S2 a later touch without a role keeps it');
  upsertSession({ brainPath, id: 'codex-row', client: 'codex', role: '', home });
  ok(!('role' in listActiveSessions({ brainPath, home }).find((r) => r.id === 'codex-row')), 'S2 a declared empty role clears it');

  const refused = upsertSubagent({ brainPath, parentId: 'codex-row', patch: { id: 'sub-abcdef', intent: 'x' }, requireKnown: true, home });
  ok(refused.ok === false && refused.reason === 'subagent-unknown', 'S3 a subagent id the host never reported is refused');
  const started = upsertSubagent({ brainPath, parentId: 'codex-row', patch: { id: 'agent-9', agentType: 'Plan', start: true }, home });
  ok(started.ok && started.childId === `codex-ro/${subagentShortId('agent-9')}`, 'S3 a reported subagent gets its entry and child id');
  const updated = upsertSubagent({ brainPath, parentId: 'codex-row', patch: { id: subagentShortId('agent-9'), intent: 'plan the work', addFiles: ['src/x.js'] }, requireKnown: true, home });
  ok(updated.ok && updated.entry.intent === 'plan the work' && updated.entry.files.includes('src/x.js'), 'S3 the known child accepts an intent and files');
}

// ── S4 hooks end to end ──────────────────────────────────────────────────────
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'src', 'shared.js'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, '.gitignore'), '.klypix/\n.claude/\n');
const brainPath = path.join(repo, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'identity test', kind: 'brain', areas: [{ title: 'Core', cards: [{ text: 'Core: the base card' }] }] }));
git('add', '-A'); git('commit', '-q', '-m', 'base');

const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0' };
delete env.KLYPIX_SESSION_ID; delete env.CLAUDE_PID;
const hook = (mode, input) => {
  const r = spawnSync(process.execPath, [HOOK, ...(mode ? [mode] : [])], { cwd: repo, env, encoding: 'utf8', input: JSON.stringify(input) });
  const out = String(r.stdout || '').trim();
  let json = null;
  try { json = out.startsWith('{') ? JSON.parse(out) : null; } catch { json = null; }
  return { status: r.status, out, json, err: String(r.stderr || '') };
};
const P = '7ff6f074-1111-4222-8333-944445555666';
const row = () => listActiveSessions({ brainPath, home }).find((r) => r.id === P);
const transcriptDir = path.join(root, 'transcripts');
const mainTranscript = path.join(transcriptDir, `${P}.jsonl`);
fs.mkdirSync(path.join(transcriptDir, P, 'subagents'), { recursive: true });
fs.writeFileSync(mainTranscript, '');
{
  const r = hook('', { session_id: P, cwd: repo, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5', transcript_path: mainTranscript });
  ok(row()?.model === 'claude-opus-5' && row()?.modelSource === 'session-start', 'S4 SessionStart records the model the host reported, with its source', r.err);
  hook('', { session_id: P, cwd: repo, hook_event_name: 'SessionStart', source: 'clear', transcript_path: mainTranscript });
  ok(row()?.model === 'claude-opus-5', 'S4 a SessionStart without a model (after /clear) does not erase or invent one');

  const A1 = 'agent-aaaa1111', A2 = 'agent-bbbb2222';
  const s1 = subagentShortId(A1), s2 = subagentShortId(A2);
  const started = hook('--subagent-start', { session_id: P, cwd: repo, hook_event_name: 'SubagentStart', agent_id: A1, agent_type: 'Explore', transcript_path: mainTranscript });
  const ctx = started.json?.hookSpecificOutput?.additionalContext || '';
  ok(started.json?.hookSpecificOutput?.hookEventName === 'SubagentStart' && ctx.includes(`7ff6f074/${s1}`) && ctx.includes(`agent: "${s1}"`),
    'S4 SubagentStart hands the subagent its child id and how to pass it to brain_sync', started.out || started.err);
  ok(row()?.subagents?.some((e) => e.id === s1 && e.agentType === 'Explore' && !e.endedAt), 'S4 SubagentStart writes a live child entry on the parent row');
  hook('--subagent-start', { session_id: P, cwd: repo, hook_event_name: 'SubagentStart', agent_id: A2, agent_type: 'general-purpose', transcript_path: mainTranscript });

  const edit = (agentId, file) => ({ session_id: P, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, file), old_string: 'a', new_string: 'b' }, ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}), transcript_path: mainTranscript });
  hook('--live', edit(A1, 'src/shared.js'));
  ok(row()?.subagents?.find((e) => e.id === s1)?.files?.includes('src/shared.js') && row()?.files?.includes('src/shared.js'),
    'S4 a subagent edit lands on its child entry and, as before, on the parent row');
  ok(!row()?.subagents?.find((e) => e.id === s2)?.files?.length, 'S4 the sibling subagent does not get that file');

  const guard = hook('--guard', { ...edit(A2, 'src/shared.js'), hook_event_name: 'PreToolUse' });
  const guardCtx = guard.json?.hookSpecificOutput?.additionalContext || '';
  ok(guard.json?.hookSpecificOutput?.permissionDecision === undefined && guardCtx.includes(`7ff6f074/${s1}`) && /warning, not a lock/.test(guardCtx),
    'S4 a sibling about to edit the same file is warned (context only, never a denial)', guard.out);
  const quiet = hook('--guard', { ...edit(null, 'src/shared.js'), hook_event_name: 'PreToolUse' });
  ok(!/another subagent/.test(quiet.out), 'S4 the main thread gets no sibling warning');

  // The subagent's own transcript: a marker in a reply made by a named model.
  const subTranscript = path.join(transcriptDir, P, 'subagents', `agent-${A1}.jsonl`);
  fs.writeFileSync(subTranscript, [
    JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Look at the parser.' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(), uuid: 'sub-u1', message: { role: 'assistant', model: 'claude-haiku-5', content: [{ type: 'text', text: 'Done.\n🧠 BRAIN [Core]: the parser keeps one pass per file so subagents cannot double count' }] } }),
  ].join('\n') + '\n');
  hook('--subagent-stop', { session_id: P, cwd: repo, hook_event_name: 'SubagentStop', agent_id: A1, agent_type: 'Explore', agent_transcript_path: subTranscript, last_assistant_message: 'Done.', transcript_path: mainTranscript, stop_hook_active: false });
  const ended = row()?.subagents?.find((e) => e.id === s1);
  ok(ended?.endedAt > 0 && path.resolve(ended.transcript) === path.resolve(subTranscript) && ended.model === 'claude-haiku-5',
    'S4 SubagentStop closes the entry and keeps its transcript and the model it ran on', ended);

  // The parent's own turn, then Stop.
  fs.writeFileSync(mainTranscript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the parser please' }, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: 'assistant', uuid: 'main-u1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Fixed.\n🧠 BRAIN [Core]: the main session chose a streaming parser for large inputs' }] } }),
  ].join('\n') + '\n');
  const stop = hook('--capture', { session_id: P, cwd: repo, hook_event_name: 'Stop', transcript_path: mainTranscript, stop_hook_active: false });
  const { struct } = await parseKlypix(fs.readFileSync(brainPath));
  const mainCard = struct.cards.find((c) => says(c, 'streaming parser'));
  const subCard = struct.cards.find((c) => says(c, 'one pass per file'));
  ok(mainCard?.capturedBy?.session === P && mainCard.capturedBy.model === 'claude-opus-5' && mainCard.capturedBy.tool === 'claude-code' && !mainCard.capturedBy.agent,
    'S4 a main-lane marker is stamped with the session, the tool and the model its transcript entry names', { card: mainCard, err: stop.err.slice(0, 600) });
  ok(subCard?.capturedBy?.agent === `7ff6f074/${s1}` && subCard.capturedBy.agentType === 'Explore' && subCard.capturedBy.model === 'claude-haiku-5' && subCard.capturedBy.session === P,
    'S4 a subagent marker lands with the child id, its type and its own model', { card: subCard, err: stop.err.slice(0, 600) });
  ok(row()?.model === 'claude-opus-5' && row()?.modelSource === 'transcript', 'S4 Stop refreshes the row model from the newest main-lane reply');
  const again = hook('--capture', { session_id: P, cwd: repo, hook_event_name: 'Stop', transcript_path: mainTranscript, stop_hook_active: false });
  const { struct: struct2 } = await parseKlypix(fs.readFileSync(brainPath));
  ok(struct2.cards.filter((c) => says(c, 'one pass per file')).length === 1, 'S4 a later Stop does not capture the subagent marker twice', again.err.slice(0, 400));

  // A transcript path outside the parent's folder is never read.
  const outside = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'x', content: [{ type: 'text', text: '🧠 BRAIN [Core]: planted outside the transcript folder' }] } }) + '\n');
  hook('--subagent-start', { session_id: P, cwd: repo, hook_event_name: 'SubagentStart', agent_id: 'agent-out', agent_type: 'Plan' });
  hook('--subagent-stop', { session_id: P, cwd: repo, hook_event_name: 'SubagentStop', agent_id: 'agent-out', agent_type: 'Plan', agent_transcript_path: outside });
  hook('--capture', { session_id: P, cwd: repo, hook_event_name: 'Stop', transcript_path: mainTranscript, stop_hook_active: false });
  const { struct: struct3 } = await parseKlypix(fs.readFileSync(brainPath));
  ok(!struct3.cards.some((c) => says(c, 'planted outside')), 'S4 a subagent transcript outside the parent transcript folder is not read');
}

// ── S5 handoffs ──────────────────────────────────────────────────────────────
{
  const v = normalizeHandoffInput({ title: 'Review the parser', task: 'Check the streaming parser change.', next: ['read the diff', 'run the tests'], for: ' Reviewer ' });
  ok(v.ok && v.value.forRole === 'Reviewer', 'S5 a handoff takes an optional role addressee');
  const from = { client: 'claude-code', sessionId: 'aaaabbbb-cccc', model: 'claude-opus-5', role: 'builder' };
  const text = renderHandoffCard(v.value, { from, at: Date.UTC(2026, 9, 30, 12, 0) });
  ok(/From: Claude Code aaaabbbb · 2026-10-30 12:00 UTC · model claude-opus-5 · role builder · for Reviewer/.test(text.replace(/\n(?!\w+:|\d|-|#)/g, ' ')),
    'S5 the From line names the writer\'s model and role and the addressee', text);
  const machine = handoffMachineField(v.value, { from, at: 1 });
  ok(machine.for === 'Reviewer' && machine.from.model === 'claude-opus-5' && machine.from.role === 'builder', 'S5 the machine field carries them too');
  const parsed = parseHandoffCard({ id: 'h1', text: `Handoff: ❓ ${text}`, handoff: machine });
  ok(parsed.forRole === 'Reviewer' && parsed.from.model === 'claude-opus-5' && parsed.from.role === 'builder', 'S5 they parse back from the machine field');
  const prose = parseHandoffCard({ id: 'h1b', text: `Handoff: ❓ ${text}` });
  ok(prose.forRole === 'Reviewer' && prose.from.model === 'claude-opus-5' && prose.from.sessionId === 'aaaabbbb', 'S5 and from the prose alone', prose);
  const unknownModel = renderHandoffCard(v.value, { from: { client: 'claude-code', sessionId: 'aaaabbbb', model: 'unknown' }, at: 1 });
  ok(!/model unknown/.test(unknownModel) && handoffMachineField(v.value, { from: { client: 'claude-code', sessionId: 'x' }, at: 1 }).from.model === 'unknown',
    'S5 an unreported model is "unknown" in the machine field and left out of the prose');
  const old = parseHandoffCard({ id: 'h2', text: 'Handoff: ❓ 🤝 HANDOFF — Old work\nFrom: Codex 0199aaaa · 2026-10-01 09:00 UTC · reason: other\nTask: old\nNext:\n1. go on\n#handoff' });
  ok(old.forRole === '' && old.from.model === '' && old.from.sessionId === '0199aaaa' && old.next[0] === 'go on', 'S5 a card written before 1.109 parses as before');
  const now = Date.now();
  const cards = [
    { ...parseHandoffCard({ id: 'new-general', text: 'Handoff: ❓ 🤝 HANDOFF — General\nFrom: Codex 0199bbbb\nTask: t\nNext:\n1. n\n#handoff' }), at: now - 1000 },
    { ...parsed, id: 'old-review', at: now - 60_000 },
  ];
  const forReviewer = formatHandoffCards(cards, { now, role: 'reviewer' });
  ok(forReviewer.indexOf('[old-review]') < forReviewer.indexOf('[new-general]') && /for: Reviewer \(your role\)/.test(forReviewer) && /addressed to your role "reviewer" first/.test(forReviewer),
    'S5 a card addressed to the reader\'s role is offered first and says so', forReviewer);
  const forOthers = formatHandoffCards(cards, { now });
  ok(forOthers.indexOf('[new-general]') < forOthers.indexOf('[old-review]') && /for: Reviewer/.test(forOthers) && !/your role/.test(forOthers),
    'S5 a session without that role still sees it, newest first, marked with its addressee');
}

// ── S6 MCP server over stdio ─────────────────────────────────────────────────
{
  const proj = path.join(root, 'proj-s6');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 's6', kind: 'brain', areas: [{ title: 'Core', cards: [{ text: 'Core: a card' }] }] }));
  const S = 'claude-parent-s6-0001';
  const client = new Client({ name: 'claude-code', version: 'small-identity-test' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [WORKER, '--vault', proj],
    cwd: proj,
    env: { ...env, KLYPIX_SESSION_ID: S, KLYPIX_MCP_INBOX_POLL_MS: '60000' },
    stderr: 'pipe',
  });
  const textOf = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
  try {
    await client.connect(transport);
    const started = await client.callTool({ name: 'brain_sync', arguments: { project: proj, phase: 'start', intent: 'parent builds the parser', files: ['src/parser.js'], role: 'builder' } });
    const parentRow = () => listActiveSessions({ brainPath: brain, home }).find((r) => r.id === S);
    ok(started.isError !== true && parentRow()?.role === 'builder' && parentRow()?.intent === 'parent builds the parser', 'S6 brain_sync role lands on the session row', textOf(started));

    upsertSession({ brainPath: brain, id: 'peer-reviewer-session', client: 'codex', intent: 'review the parser', files: ['src/other.js'], role: 'reviewer', model: 'gpt-5.5', modelSource: 'codex-hook', event: 'McpTaskStart', home });
    const seen = await client.callTool({ name: 'brain_sync', arguments: { phase: 'checkpoint' } });
    ok(/role reviewer/.test(textOf(seen)) && /model gpt-5\.5/.test(textOf(seen)), 'S6 peers show another session\'s role and reported model', textOf(seen));

    const bogus = await client.callTool({ name: 'brain_sync', arguments: { phase: 'checkpoint', agent: 'sub-abcdef', intent: 'pretend child' } });
    ok(/did not record this call under "sub-abcdef"/.test(textOf(bogus)) && /recorded under the parent session/.test(textOf(bogus)) && bogus.structuredContent?.subagent?.status === 'not-recorded',
      'S6 an id the host never reported is not accepted, and the reply says the call went to the parent', textOf(bogus));

    const child = upsertSubagent({ brainPath: brain, parentId: S, patch: { id: 'agent-s6', agentType: 'Explore', start: true }, home });
    const short = subagentShortId('agent-s6');
    const before = parentRow();
    const childSync = await client.callTool({ name: 'brain_sync', arguments: { phase: 'start', agent: short, intent: 'explore the tokenizer', files: ['src/tokenizer.js', 'src/parser.js'], role: 'explorer' } });
    const after = parentRow();
    const entry = after?.subagents?.find((e) => e.id === short);
    ok(child.ok && childSync.isError !== true && childSync.structuredContent?.subagent?.id === `claude-p/${short}` && entry?.intent === 'explore the tokenizer' && entry.role === 'explorer' && entry.files.includes('src/tokenizer.js'),
      'S6 a subagent\'s brain_sync lands on its child entry', textOf(childSync));
    ok(after.intent === before.intent && JSON.stringify(after.files) === JSON.stringify(before.files) && after.role === 'builder',
      'S6 the parent\'s intent, files and role are unchanged by its subagent');
    const childDone = await client.callTool({ name: 'brain_sync', arguments: { phase: 'complete', agent: short } });
    ok(/done with its task/.test(textOf(childDone)) && parentRow().subagents.find((e) => e.id === short).files.length === 0 && parentRow().intent === before.intent,
      'S6 the subagent can complete its own task without completing the parent\'s');

    const note = await client.callTool({ name: 'brain_note', arguments: { text: 'the parser keeps a byte cursor', area: 'Core' } });
    const { struct } = await parseKlypix(fs.readFileSync(brain));
    const card = struct.cards.find((c) => says(c, 'byte cursor'));
    ok(note.isError !== true && card?.capturedBy?.session === S && card.capturedBy.model === 'unknown' && card.capturedBy.role === 'builder',
      'S6 brain_note stamps the session and role, and "unknown" for a model the host did not report with the call', card);

    const wrote = await client.callTool({ name: 'brain_handoff', arguments: { action: 'write', title: 'Review the tokenizer', task: 'Look over the tokenizer change.', next: ['read src/tokenizer.js'], for: 'reviewer' } });
    const { struct: s2 } = await parseKlypix(fs.readFileSync(brain));
    const h = s2.cards.find((c) => c.handoff && c.handoff.title === 'Review the tokenizer');
    ok(wrote.isError !== true && h?.handoff?.for === 'reviewer' && h.handoff.from.model === 'unknown' && h.handoff.from.role === 'builder', 'S6 brain_handoff for: lands on the card with the writer\'s role', textOf(wrote));
  } finally {
    await client.close().catch(() => {});
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n✓ small-identity: all ${checks} assertions passed`);
