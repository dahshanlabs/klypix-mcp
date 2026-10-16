// Automatic scope adoption (1.70.0 measured wave) — coordination as opt-out.
// When a session's HOST reports a file edit (Claude --live PostToolUse, Codex
// Pre/PostToolUse) and no DECLARED scope covers it, the presence row gains the
// path as observedFiles — distinct from declared files, never fabricated into
// a declaration. Locks in:
//   O1 — upsertSession: an undeclared observation lands in observedFiles AND
//        the legacy files[] union (pre-1.70 reader visibility).
//   O2 — a declared scope covers its observations (slash/case-folded): no
//        observed marker is ever added for a declared path.
//   O3 — a later declaration UPGRADES an earlier observation (marker dropped,
//        path kept in files[]).
//   O4 — observedFiles is LRU with cap 20; re-observation moves to the tail.
//   O5 — the completion guard (files:[] replace) clears DECLARED scope only;
//        observedFiles survive completion.
//   O6 — findPresenceConflicts widens to observed∪declared and reports the
//        per-side observed/declared distinction; annotateConflictFiles renders
//        the `*` + legend only when an observed claim exists.
//   O7 — snapshot honesty: an observed-only session is an active task, and
//        publicSession carries observedFiles.
//   O8 — the REAL Claude hook (--live) adopts an undeclared edit as observed,
//        skips declared-covered edits, and its peer footer states the
//        distinction in the both-edited warning.
//   O9 — the REAL Codex hook reports touched paths as observations (dual-
//        written for old readers, marked for new ones); a human turn resets
//        declared scope but keeps observations. It also attributes the payload
//        Codex really sends (tool_input.command) and resolves a relative patch
//        path against the session cwd.
//   O10 — the cross-PC relay carries observedFiles end to end (frame → accept
//        → upsertRemoteSessions), additive on the same wire version.
//   O13 — touchedFiles reads the apply_patch body from tool_input.command (the
//        official Codex hooks docs), keeps patch/input/content as fallbacks,
//        reads Add/Update/Delete/Move to headers, and never reads hunk text or
//        a Bash command as a header.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  laneFileFor,
  listActiveSessions,
  OBSERVED_FILES_CAP,
  upsertRemoteSessions,
  upsertSession,
} from '../src/agent-presence.mjs';
import {
  annotateConflictFiles,
  buildPresenceSnapshot,
  findPresenceConflicts,
} from '../src/mcp-presence.mjs';
import { acceptPresenceFrame, buildPresenceFrame } from '../src/presence-relay.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_HOOK = path.join(root, 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(root, 'src', 'codex-brain-hook.mjs');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = path.join(os.tmpdir(), 'klypix-observed-home');
const project = path.join(os.tmpdir(), 'klypix-observed-project');
for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({
  title: 'observed-scope fixture',
  kind: 'brain',
  areas: [{ title: 'Goal', cards: [{ text: 'observed scope adoption fixture seed' }] }],
}));
const now = 2_000_000_000_000;

// ── O1: undeclared observation → observedFiles + legacy files[] ─────────────
{
  const rows = upsertSession({
    brainPath, home, now, id: 'undeclared', client: 'codex',
    observedFiles: ['src/edited.ts'],
  });
  const row = rows.find((session) => session.id === 'undeclared');
  ok(Array.isArray(row.observedFiles) && row.observedFiles.includes('src/edited.ts'),
    'O1: an edit with no declared scope is adopted as observedFiles');
  ok(row.files.includes('src/edited.ts'),
    'O1: the observation also joins files[] so pre-1.70 readers keep overlap coverage');
}

// ── O2: declared scope covers its observations (fold-aware) ─────────────────
{
  upsertSession({
    brainPath, home, now, id: 'declared', client: 'claude-code',
    files: ['src/app.ts'],
  });
  const rows = upsertSession({
    brainPath, home, now: now + 1000, id: 'declared', client: 'claude-code',
    observedFiles: ['src\\App.ts'],
  });
  const row = rows.find((session) => session.id === 'declared');
  ok(!(row.observedFiles || []).length,
    'O2: a declared path never gains an observed marker (slash/case-folded coverage)');
  ok(row.files.length === 1 && row.files[0] === 'src/app.ts',
    'O2: the declared spelling stays the only files[] entry');
}

// ── O3: a later declaration upgrades an earlier observation ─────────────────
{
  upsertSession({
    brainPath, home, now, id: 'upgrade', client: 'codex',
    observedFiles: ['src/x.ts', 'src/y.ts'],
  });
  const rows = upsertSession({
    brainPath, home, now: now + 1000, id: 'upgrade', client: 'codex',
    files: ['src/x.ts'],
  });
  const row = rows.find((session) => session.id === 'upgrade');
  ok(row.observedFiles.length === 1 && row.observedFiles[0] === 'src/y.ts',
    'O3: declaring an observed path drops its observed marker (claim upgraded, not duplicated)');
  ok(row.files.includes('src/x.ts') && row.files.includes('src/y.ts'),
    'O3: files[] keeps both the declared path and the still-observed one');
}

// ── O4: LRU semantics with the 20 cap ───────────────────────────────────────
{
  for (let i = 0; i < 25; i++) {
    upsertSession({
      brainPath, home, now: now + i, id: 'lru', client: 'codex',
      observedFiles: [`src/f${i}.ts`],
    });
  }
  // Re-observe an early survivor: it must move to the tail, not duplicate.
  upsertSession({
    brainPath, home, now: now + 100, id: 'lru', client: 'codex',
    observedFiles: ['src/f7.ts'],
  });
  const row = listActiveSessions({ brainPath, home, now: now + 200 })
    .find((session) => session.id === 'lru');
  ok(row.observedFiles.length === OBSERVED_FILES_CAP,
    `O4: observedFiles caps at ${OBSERVED_FILES_CAP} (got ${row.observedFiles.length})`);
  ok(!row.observedFiles.includes('src/f0.ts') && !row.observedFiles.includes('src/f4.ts'),
    'O4: the oldest observations are evicted first');
  ok(row.observedFiles[row.observedFiles.length - 1] === 'src/f7.ts'
    && row.observedFiles.filter((file) => file === 'src/f7.ts').length === 1,
    'O4: a re-observation moves to the LRU tail without duplicating');
}

// ── O5: the completion guard never clears observedFiles ─────────────────────
{
  upsertSession({
    brainPath, home, now, id: 'completer', client: 'claude-code',
    intent: 'ship the thing', files: ['src/declared.ts'],
  });
  upsertSession({
    brainPath, home, now: now + 1000, id: 'completer', client: 'claude-code',
    observedFiles: ['src/drifted.ts'],
  });
  // The brain_sync completion touch: intent '' + files [] with replaceFiles.
  const rows = upsertSession({
    brainPath, home, now: now + 2000, id: 'completer', client: 'claude-code',
    intent: '', files: [], replaceFiles: true, event: 'McpTaskComplete',
  });
  const row = rows.find((session) => session.id === 'completer');
  ok(row.files.length === 0,
    'O5: completion clears the DECLARED scope');
  ok(row.observedFiles.length === 1 && row.observedFiles[0] === 'src/drifted.ts',
    'O5: completion never clears observedFiles — the observed edit is still real in the worktree');
  ok(Number(row.completedAt) === now + 2000,
    'O5: the completion boundary itself still lands');
}

// ── O6: conflicts widen to observed∪declared, with the distinction ──────────
{
  const sessions = [
    { id: 'me-declared', cwd: project, files: ['src/shared.ts'] },
    { id: 'peer-observed', cwd: project, files: ['src/shared.ts'], observedFiles: ['src/shared.ts'] },
    { id: 'peer-observed-only', cwd: project, files: [], observedFiles: ['src/shared.ts'] },
    { id: 'peer-declared', cwd: project, files: ['src/shared.ts'] },
  ];
  const conflicts = findPresenceConflicts(sessions, 'me-declared', { projectRoot: project });
  ok(conflicts.length === 3,
    `O6: overlap warns over observed∪declared, including an observed-ONLY peer (got ${conflicts.length})`);
  const observedOnly = conflicts.find((conflict) => conflict.id === 'peer-observed-only');
  ok(observedOnly && observedOnly.files.includes('src/shared.ts')
    && observedOnly.peerObservedFiles.includes('src/shared.ts')
    && observedOnly.selfObservedFiles.length === 0,
    'O6: the conflict states WHOSE claim is observed (peer) vs declared (self)');
  const declared = conflicts.find((conflict) => conflict.id === 'peer-declared');
  ok(declared && declared.peerObservedFiles.length === 0,
    'O6: a declared-vs-declared conflict carries no observed annotation');
  const annotatedObserved = annotateConflictFiles(observedOnly);
  ok(annotatedObserved.files.join() === 'src/shared.ts*' && /observed from live edits/.test(annotatedObserved.legend),
    'O6: an observed claim renders starred with the one-line legend');
  const annotatedDeclared = annotateConflictFiles(declared);
  ok(annotatedDeclared.files.join() === 'src/shared.ts' && annotatedDeclared.legend === '',
    'O6: declared-only conflicts render byte-identical to pre-1.70 output');
  // The observed side must warn even when the OBSERVER is "me".
  const reverse = findPresenceConflicts(sessions, 'peer-observed-only', { projectRoot: project });
  ok(reverse.length === 3 && reverse.every((conflict) => conflict.selfObservedFiles.includes('src/shared.ts')),
    'O6: an undeclared session still sees the overlap from its own observed side');
}

// ── O7: snapshot honesty for observed-only sessions ─────────────────────────
{
  const sessions = [
    { id: 'self-row', lastSeen: now },
    { id: 'observed-task', lastSeen: now, observedFiles: ['src/quiet.ts'] },
    { id: 'idle-row', lastSeen: now },
  ];
  const snapshot = buildPresenceSnapshot(sessions, 'self-row', { now });
  ok(snapshot.activeTaskCount === 1 && snapshot.backgroundConnectionCount === 1,
    'O7: a session with only observed edits surfaces as an active task, not "scope unknown"');
  const peer = snapshot.peers.find((session) => session.id === 'observed-task');
  ok(peer && Array.isArray(peer.observedFiles) && peer.observedFiles.includes('src/quiet.ts'),
    'O7: publicSession carries observedFiles for renderers');
}

// ── O8: the REAL Claude hook adopts undeclared edits as observed ────────────
{
  const hookHome = path.join(os.tmpdir(), 'klypix-observed-hookhome');
  const hookProj = path.join(os.tmpdir(), 'klypix-observed-hookproj');
  for (const dir of [hookHome, hookProj]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(hookProj, { recursive: true });
  fs.writeFileSync(path.join(hookProj, 'brain.klypix'), await buildKlypixMap({
    title: 'brain', kind: 'brain',
    areas: [{ title: 'Goal', cards: [{ text: 'hook fixture seed' }] }],
  }));
  const env = { ...process.env, HOME: hookHome, USERPROFILE: hookHome, CLAUDE_PID: '41414' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runHook = (args, input) => execFileSync(process.execPath, [CLAUDE_HOOK, ...args], {
    cwd: hookProj, env, encoding: 'utf8', input: JSON.stringify(input),
  });
  runHook(['--prompt'], { session_id: 'sess-obs', prompt: 'observe scope adoption' });
  const sessionsDir = path.join(hookHome, '.claude', 'project-brain', 'sessions');
  const laneFile = fs.readdirSync(sessionsDir).map((f) => path.join(sessionsDir, f)).find((f) => f.endsWith('.json'));
  runHook(['--live'], {
    session_id: 'sess-obs',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(hookProj, 'src', 'undeclared.ts') },
  });
  let lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  let row = lane.sessions.find((s) => s.id === 'sess-obs');
  ok(Array.isArray(row.observedFiles) && row.observedFiles.includes('src/undeclared.ts'),
    'O8: --live adopts an undeclared edit into observedFiles');
  ok(row.files.includes('src/undeclared.ts'),
    'O8: --live still unions the edit into files[] for pre-1.70 readers');
  // Declare a scope directly on the row (as brain_sync would), then edit it:
  // a covered edit must NOT gain an observed marker.
  row.files = [...row.files, 'src/covered.ts'];
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  runHook(['--live'], {
    session_id: 'sess-obs',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(hookProj, 'src', 'covered.ts') },
  });
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  row = lane.sessions.find((s) => s.id === 'sess-obs');
  ok(!row.observedFiles.includes('src/covered.ts'),
    'O8: an edit already covered by the declared scope never fabricates an observed marker');
  // Peer footer: a peer DECLARING the file this session only OBSERVED edits
  // must warn with the distinction stated.
  lane.sessions.push({
    id: 'peer-declares', pid: 999999, client: 'codex', branch: null,
    intent: 'peer task', files: ['src/undeclared.ts'], lastSeen: Date.now(),
    startedAt: Date.now(),
  });
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const footerOut = runHook(['--prompt'], { session_id: 'sess-obs', prompt: 'footer check' });
  ok(/both edited: src\/undeclared\.ts\*/.test(footerOut)
    && /observed from live edits, scope not declared/.test(footerOut),
    'O8: the peer footer warning marks the observed claim and explains the mark');
  fs.rmSync(hookHome, { recursive: true, force: true });
  fs.rmSync(hookProj, { recursive: true, force: true });
}

// ── O9: the REAL Codex hook — observations, not declarations ────────────────
{
  const codexHome = path.join(os.tmpdir(), 'klypix-observed-codexhome');
  const codexProj = path.join(os.tmpdir(), 'klypix-observed-codexproj');
  for (const dir of [codexHome, codexProj]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(codexProj, { recursive: true });
  const codexBrain = path.join(codexProj, 'brain.klypix');
  fs.writeFileSync(codexBrain, await buildKlypixMap({
    title: 'codex brain', kind: 'brain',
    areas: [{ title: 'Goal', cards: [{ text: 'codex fixture seed' }] }],
  }));
  const env = { ...process.env, HOME: codexHome, USERPROFILE: codexHome };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runCodex = (input, cwd = codexProj) => execFileSync(process.execPath, [CODEX_HOOK], {
    cwd, env, encoding: 'utf8', input: JSON.stringify(input),
  });
  runCodex({
    session_id: 'codex-obs', cwd: codexProj, hook_event_name: 'PostToolUse',
    turn_id: 'turn-1', tool_name: 'apply_patch',
    tool_input: { patch: '*** Update File: src/touched.mjs\n@@\n-old\n+new\n' },
  });
  let row = listActiveSessions({ brainPath: codexBrain, home: codexHome })
    .find((session) => session.id === 'codex-obs');
  ok(row.observedFiles.includes('src/touched.mjs') && row.files.includes('src/touched.mjs'),
    'O9: a Codex tool edit is recorded as an OBSERVATION (and dual-written for old readers)');
  // A human prompt is a task boundary: declared scope resets, observations stay.
  runCodex({
    session_id: 'codex-obs', cwd: codexProj, hook_event_name: 'UserPromptSubmit',
    prompt: 'start the next task',
  });
  row = listActiveSessions({ brainPath: codexBrain, home: codexHome })
    .find((session) => session.id === 'codex-obs');
  ok(row.files.length === 0 && row.observedFiles.includes('src/touched.mjs'),
    'O9: a human turn resets declared scope but keeps what was actually observed');
  // A second session declaring the same file gets the overlap WARNING with
  // the observed mark on the first session's claim. (Claims discipline
  // 2026-08-24: the banner says WARNING — the lane is advisory, continue:true —
  // and this assertion locks the honest wording the same way agent-presence does.)
  const warnOut = runCodex({
    session_id: 'codex-obs-b', cwd: codexProj, hook_event_name: 'PreToolUse',
    turn_id: 'turn-2', tool_name: 'apply_patch',
    tool_input: { patch: '*** Update File: src/touched.mjs\n@@\n-old\n+other\n' },
  });
  const warnJson = JSON.parse(warnOut);
  ok(/WARNING — exact-file overlap/.test(warnJson.systemMessage)
    && !/BLOCKING/.test(warnJson.systemMessage)
    && /src\/touched\.mjs\*/.test(warnJson.systemMessage)
    && /observed from live edits, scope not declared/.test(warnJson.systemMessage),
    'O9: the Codex overlap warning states the observed/declared confidence — and never claims to BLOCK');
  // The payload Codex really sends (2026-10-16). The official hooks docs say
  // "Bash and apply_patch use tool_input.command"; the `{ patch }` fixtures
  // above use the key the hook read before, kept as a fallback. Before the
  // fix this exact payload recorded no file at all.
  const patchOf = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
  runCodex({
    session_id: 'codex-doc', cwd: codexProj, hook_event_name: 'PostToolUse',
    turn_id: 'turn-doc', tool_name: 'apply_patch', tool_use_id: 'call-doc',
    tool_input: { command: patchOf('*** Update File: src/before.mjs', '*** Move to: src/after.mjs', '@@', '-old', '+new') },
    tool_response: 'Success. Updated the following files:\nM src/after.mjs\n',
  });
  row = listActiveSessions({ brainPath: codexBrain, home: codexHome })
    .find((session) => session.id === 'codex-doc');
  ok((row?.observedFiles || []).includes('src/before.mjs') && (row?.observedFiles || []).includes('src/after.mjs'),
    'O9: an apply_patch sent as tool_input.command is observed, and a rename touches both the old and the new path');
  // The hook prints nothing when it has nothing to say, so parse defensively.
  const parseHookOutput = (out) => { try { return JSON.parse(out); } catch { return {}; } };
  const docWarn = parseHookOutput(runCodex({
    session_id: 'codex-doc-b', cwd: codexProj, hook_event_name: 'PreToolUse',
    turn_id: 'turn-doc-b', tool_name: 'apply_patch', tool_use_id: 'call-doc-b',
    tool_input: { command: patchOf('*** Update File: src/after.mjs', '@@', '-new', '+mine') },
  }));
  ok(/WARNING — exact-file overlap/.test(docWarn.systemMessage || '')
    && /src\/after\.mjs\*/.test(docWarn.systemMessage || '')
    && docWarn.continue === true
    && docWarn.hookSpecificOutput?.permissionDecision === undefined,
    'O9: a tool_input.command PreToolUse warns on the overlap, advisory only (no permission decision)');
  // A session started in a subfolder: Codex applies the patch from its cwd,
  // and findProjectBrain walks UP from there to the brain's folder.
  const subDir = path.join(codexProj, 'admin');
  fs.mkdirSync(subDir, { recursive: true });
  runCodex({
    session_id: 'codex-sub', cwd: subDir, hook_event_name: 'PostToolUse',
    turn_id: 'turn-sub', tool_name: 'apply_patch', tool_use_id: 'call-sub',
    tool_input: { command: patchOf('*** Update File: package.json', '@@', '-a', '+b') },
  }, subDir);
  row = listActiveSessions({ brainPath: codexBrain, home: codexHome })
    .find((session) => session.id === 'codex-sub');
  ok((row?.observedFiles || []).includes('admin/package.json') && !(row?.observedFiles || []).includes('package.json'),
    'O9: a relative patch path resolves against the session cwd, not the brain folder above it');
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(codexProj, { recursive: true, force: true });
}

// ── O10: cross-PC relay carries the distinction ─────────────────────────────
{
  const frame = buildPresenceFrame({
    id: 'remote-1', client: 'codex', intent: 'remote work',
    files: ['src/decl.ts'], observedFiles: ['src/obs.ts'],
  }, { machineId: 'machine-a', root: null, now });
  ok(Array.isArray(frame.observedFiles) && frame.observedFiles.includes('src/obs.ts'),
    'O10: the wire frame carries observedFiles (additive, same wire version)');
  const accepted = acceptPresenceFrame(frame, { machineId: 'machine-b', now });
  ok(accepted && accepted.observedFiles.includes('src/obs.ts'),
    'O10: the receiving machine accepts the observed lane');
  upsertRemoteSessions({
    brainPath, rows: [{ ...accepted, via: 'cloud' }], machineId: 'machine-b', home, now,
  });
  const remote = listActiveSessions({ brainPath, home, now: now + 1000 })
    .find((session) => session.id === 'remote-1');
  ok(remote && (remote.observedFiles || []).includes('src/obs.ts'),
    'O10: the remote lane row preserves observedFiles for local conflict detection');
  // The frame is a full snapshot: a later frame with NO observations (the
  // remote task completed — the sender gates the wire on completed-idle) must
  // CLEAR the mirror, not let `...previous` pin the stale markers forever
  // (remote rows carry no completedAt, so nothing local could retire them).
  const clearedFrame = buildPresenceFrame({
    id: 'remote-1', client: 'codex', intent: '', files: [],
    observedFiles: ['src/obs.ts'], completedAt: now + 1500,
  }, { machineId: 'machine-a', root: null, now: now + 1500 });
  ok(Array.isArray(clearedFrame.observedFiles) && clearedFrame.observedFiles.length === 0,
    'O10: a completed-idle sender puts no observations on the wire');
  upsertRemoteSessions({
    brainPath, rows: [{ ...acceptPresenceFrame(clearedFrame, { machineId: 'machine-b', now: now + 1500 }), via: 'cloud' }],
    machineId: 'machine-b', home, now: now + 1500,
  });
  const cleared = listActiveSessions({ brainPath, home, now: now + 2000 })
    .find((session) => session.id === 'remote-1');
  ok(cleared && !(cleared.observedFiles || []).length,
    'O10: an empty observed snapshot CLEARS the local mirror (replace, not merge)');
}

// ── O11: a COMPLETED-idle session's observations are history, not a claim ───
// The markers survive on the ROW (O5 — the edits are real, forensics keep
// them), but MCP heartbeats keep the row alive for the whole host-process
// lifetime, so the live read surfaces must stop treating them as an active
// scope once the task completed: no active-task promotion, no BLOCKING
// conflict, no observed lane on the relay wire. A new task start revives all
// three (completedAt clears on McpTaskStart / fresh human prompt).
{
  upsertSession({
    brainPath, home, now, id: 'finished', client: 'claude-code',
    intent: 'ship it', event: 'McpTaskStart', cwd: project,
  });
  upsertSession({
    brainPath, home, now: now + 1000, id: 'finished', client: 'claude-code',
    observedFiles: ['src/legacy.ts'],
  });
  upsertSession({
    brainPath, home, now: now + 2000, id: 'finished', client: 'claude-code',
    intent: '', files: [], replaceFiles: true, event: 'McpTaskComplete',
  });
  const rows = upsertSession({
    brainPath, home, now: now + 3000, id: 'after', client: 'codex',
    intent: 'next task', files: ['src/legacy.ts'], cwd: project,
  });
  const finishedRow = rows.find((session) => session.id === 'finished');
  ok((finishedRow.observedFiles || []).includes('src/legacy.ts'),
    'O11: the completed row still CARRIES its observations (O5 unchanged)');
  const conflicts = findPresenceConflicts(rows, 'after', { projectRoot: project });
  ok(!conflicts.some((conflict) => conflict.id === 'finished'),
    'O11: a completed-idle session\'s observations raise no BLOCKING conflict');
  const snapshot = buildPresenceSnapshot(rows, 'after', { now: now + 3000 });
  ok(!snapshot.peers.some((peer) => peer.id === 'finished'),
    'O11: a completed-idle session is not promoted back to an active task');
  const idleFrame = buildPresenceFrame(finishedRow, { machineId: 'machine-a', root: null, now: now + 3000 });
  ok(Array.isArray(idleFrame.observedFiles) && idleFrame.observedFiles.length === 0,
    'O11: the relay wire (which has no completedAt) sends no observations for a completed-idle session');
  // Revival: the next task start makes the session's observations live again.
  const revived = upsertSession({
    brainPath, home, now: now + 4000, id: 'finished', client: 'claude-code',
    intent: 'follow-up task', event: 'McpTaskStart',
  });
  const revivedConflicts = findPresenceConflicts(revived, 'after', { projectRoot: project });
  ok(revivedConflicts.some((conflict) => conflict.id === 'finished'
    && conflict.peerObservedFiles.includes('src/legacy.ts')),
    'O11: a new task start revives the observed lane (completedAt cleared)');
}

// ── O12: cap pressure evicts observations, never declarations ───────────────
// files[] is capped at 20; before the fix an observation flood pushed DECLARED
// files off the row (peers lost blocking coverage of declared work) and a
// later re-edit of the evicted path re-entered it as observed — rendering an
// owned scope as `*`-unconfirmed.
{
  upsertSession({
    brainPath, home, now, id: 'flooded', client: 'claude-code',
    intent: 'wide refactor', event: 'McpTaskStart',
    files: ['src/d1.ts', 'src/d2.ts', 'src/d3.ts', 'src/d4.ts', 'src/d5.ts'],
  });
  for (let i = 0; i < 18; i++) {
    upsertSession({
      brainPath, home, now: now + 10 + i, id: 'flooded', client: 'claude-code',
      observedFiles: [`src/o${i}.ts`],
    });
  }
  const rows = upsertSession({
    brainPath, home, now: now + 100, id: 'flooded', client: 'claude-code',
    observedFiles: ['src/d1.ts'],
  });
  const row = rows.find((session) => session.id === 'flooded');
  ok(['src/d1.ts', 'src/d2.ts', 'src/d3.ts', 'src/d4.ts', 'src/d5.ts']
    .every((file) => row.files.includes(file)),
    'O12: every DECLARED file survives an observation flood in files[]');
  ok(!(row.observedFiles || []).includes('src/d1.ts'),
    'O12: a re-edit of a declared file never re-labels it as observed');
  ok(row.files.length <= 20,
    `O12: the files[] cap still holds (got ${row.files.length})`);
}

// ── O13: Codex apply_patch attribution reads where Codex sends the patch ────
// Official Codex hooks docs (https://learn.chatgpt.com/docs/hooks): tool_input
// is "Tool-specific input. Bash and apply_patch use tool_input.command", and
// apply_patch hook input "still reports tool_name: "apply_patch"". Until
// 2026-10-16 touchedFiles read only patch/input/content, so every real Codex
// edit was attributed to no file. touchedFiles is path-only, so these call the
// pure export directly; the real hook end to end is in O9.
{
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';   // pure exports only; every child env above deletes it
  const codexHook = await import('../src/codex-brain-hook.mjs');
  delete process.env.KLYPIX_BRAIN_NO_MAIN;
  ok(typeof codexHook.touchedFiles === 'function', 'O13: touchedFiles is exported for direct checks');
  const touched = typeof codexHook.touchedFiles === 'function' ? codexHook.touchedFiles : () => null;
  const proj = path.join(os.tmpdir(), 'klypix-observed-o13');   // never created: nothing here touches disk
  const patchOf = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
  const update = (file) => patchOf(`*** Update File: ${file}`, '@@', '-old', '+new');
  const payload = (toolInput, extra = {}) => ({
    session_id: 'codex-o13', hook_event_name: 'PostToolUse', turn_id: 'turn-o13',
    tool_name: 'apply_patch', tool_use_id: 'call-o13', cwd: proj, tool_input: toolInput, ...extra,
  });
  const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

  ok(same(touched(payload({ command: update('src/a.mjs') }), proj), ['src/a.mjs']),
    'O13: the documented payload (tool_input.command) is attributed');
  ok(same(touched(payload({ command: patchOf(
    '*** Add File: src/new.mjs', '+export const fresh = true;',
    '*** Update File: src/old-name.mjs', '*** Move to: src/new-name.mjs', '@@', '-a', '+b',
    '*** Delete File: src/gone.mjs',
  ) }), proj), ['src/new.mjs', 'src/old-name.mjs', 'src/new-name.mjs', 'src/gone.mjs']),
    'O13: Add, Update, Move to and Delete headers are all read (a rename touches the old and the new path)');
  ok(same(touched(payload({ command: update('src/from-command.mjs'), patch: update('src/from-patch.mjs') }), proj),
    ['src/from-command.mjs']),
    'O13: tool_input.command is read first, before the old keys');
  for (const key of ['patch', 'input', 'content']) {
    ok(same(touched(payload({ [key]: update(`src/legacy-${key}.mjs`) }), proj), [`src/legacy-${key}.mjs`]),
      `O13: the old "${key}" key still works as a fallback`);
  }
  ok(same(touched(payload(update('src/raw.mjs')), proj), ['src/raw.mjs']),
    'O13: a bare-string tool_input is read as the patch itself');
  ok(same(touched(payload({ command: ['apply_patch', update('src/argv.mjs')] }), proj), ['src/argv.mjs']),
    'O13: an argv-style command array is searched for the patch');
  ok(same(touched(payload({ command: update('src/crlf.mjs').replace(/\n/g, '\r\n') }), proj), ['src/crlf.mjs']),
    'O13: a CRLF patch gives clean paths (no trailing carriage return)');
  ok(same(touched(payload({ command: patchOf(
    '*** Update File: src/real.mjs', '@@',
    ' *** Update File: src/context-line.mjs',
    '-*** Delete File: src/removed-line.mjs',
    '+*** Add File: src/added-line.mjs',
    '+*** Move to: src/moved-line.mjs',
  ) }), proj), ['src/real.mjs']),
    'O13: hunk text that only looks like a header is never read as one');
  ok(same(touched(payload({ command: patchOf('*** Update File:', '@@', '-a', '+b') }), proj), []),
    'O13: an empty header never takes the next line as its path');
  ok(same(touched(payload({ command: `cat > notes.md <<'EOF'\n${update('src/not-an-edit.mjs')}EOF\n` },
    { tool_name: 'Bash' }), proj), []),
    'O13: a Bash command that only contains patch text attributes nothing (the tool-name gate is unchanged)');
  ok(same(touched(payload({ command: update('src/alias.mjs') }, { tool_name: 'Edit' }), proj), ['src/alias.mjs']),
    'O13: the Edit/Write matcher aliases are still read');
  // Paths. Codex applies a patch from the session cwd and findProjectBrain
  // walks UP from it, so a relative path resolves against that cwd; absolute
  // paths inside the project become relative; anything outside drops.
  ok(same(touched(payload({ command: update('package.json') }, { cwd: path.join(proj, 'admin') }), proj),
    ['admin/package.json']),
    'O13: a relative path resolves against the session cwd, not the brain folder above it');
  ok(same(touched(payload({ command: update('package.json') }, { cwd: undefined }), proj), ['package.json']),
    'O13: with no cwd in the payload, a relative path resolves against the project (the old behaviour)');
  ok(same(touched(payload({ command: patchOf(
    `*** Update File: ${path.join(proj, 'src', 'abs.mjs')}`, '@@', '-a', '+b',
    '*** Update File: ../outside.mjs', '@@', '-a', '+b',
    `*** Update File: ${path.join(os.tmpdir(), 'klypix-elsewhere', 'x.mjs')}`, '@@', '-a', '+b',
  ) }), proj), ['src/abs.mjs']),
    'O13: an absolute path inside the project is made relative; paths outside it are dropped');
  if (process.platform === 'win32') {
    const otherDrive = `${/^[zZ]/.test(proj) ? 'Y' : 'Z'}:/elsewhere/notes.md`;
    ok(same(touched(payload({ command: update(otherDrive) }), proj), []),
      'O13: a path on another drive is outside the project (dropped, never recorded as a drive path)');
  }
  ok(same(touched(payload({ command: update('docs/release notes/ملاحظات.md') }), proj), ['docs/release notes/ملاحظات.md']),
    'O13: a path with spaces and non-ASCII letters is kept exactly');
  ok(same(touched(payload({ path: 'src/p.mjs' }, { tool_name: 'mcp__fs__write_file' }), proj), ['src/p.mjs']),
    'O13: path-like keys are still read (unchanged)');
}

for (const dir of [home, project]) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] observed-scope: all assertions passed');
if (failures) process.exit(1);
