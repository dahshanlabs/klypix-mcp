// Quick restart (round-4 fix of the 2026-10-30 continuity test).
//
// The field shape: a Claude Code or Codex session is killed with its process
// tree (taskkill /T /F). A new session starts 30 seconds later. Before this
// fix the dead session still read as LIVE — for 90 s (Claude: the host-declared
// pid waited out a grace window) or for the whole TTL (Codex: only guessed
// pids, never probed) — so brain_sync called it a blocking conflict, the edit
// guard said "leave them alone", and the new session stood down.
//
//   Q1  a Claude-shaped row (host-declared pid + MCP owner, both gone) is
//       stopped 30 s after the kill: not live, listed as unfinished work;
//   Q2  a Codex-shaped row (guessed pids + the recorded hostTreePid, all gone)
//       is stopped 30 s after the kill;
//   Q3  a live session is never freed: host alive, MCP owner alive, a probe
//       that cannot say, a row from an older build (no hostTreePid), a
//       lifecycle-only row, a stale MCP channel, a foreign machine, a cloud
//       row, a row written 2 s ago — each keeps today's rule;
//   Q4  resolveHostTreePid: the supervisor tells a supervised worker who
//       launched it; an unsupervised worker uses its own parent;
//   Q5  end to end through the real Claude hook: the next session's
//       SessionStart lists the killed session as unfinished work (not as a
//       live peer), and the guard calls its files "left by a session that has
//       stopped", not "leave them alone"; a live peer in the same lane is
//       still protected.
//
// Run:  node test/quick-restart.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  DEAD_TREE_SETTLE_MS, MACHINE_ID, isDeadHostRow, isDeadHostTreeRow, laneFileFor,
  listActiveSessions, listUnfinishedWork, upsertSession,
} from '../src/agent-presence.mjs';
import { createMcpPresence, resolveHostTreePid } from '../src/mcp-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
let checks = 0;
const ok = (c, label, detail) => { checks++; if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)).slice(0, 3000)); assert.ok(c, label); console.log(`[ok] ${label}`); };
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;

const D1 = deadPid(); const D2 = deadPid(); const D3 = deadPid();
const ALIVE = process.pid;
const now = Date.now();
const KILL = now - 30_000;

const claudeRow = (over = {}) => ({
  id: '9da94336-8bf2-493f-a0e8-9ed6d984158f', client: 'claude-code', machine: MACHINE_ID,
  hostPid: D1, hostPidSource: 'env', lastSeen: KILL,
  channels: ['lifecycle', 'mcp'], channelSeen: { lifecycle: KILL, mcp: KILL - 50_000 },
  channelOwners: { lifecycle: D3, mcp: D2 }, hostStatus: 'busy', hostStatusAt: KILL, ...over,
});
const codexRow = (over = {}) => ({
  id: '01a18ee5-6a6e-74d2-9a8f-c2b011c2496a', client: 'codex', machine: MACHINE_ID,
  hostPid: D1, hostPidSource: 'ppid', hostTreePid: D3, lastSeen: KILL,
  channels: ['mcp'], channelSeen: { mcp: KILL }, channelOwners: { mcp: D2 }, hostStatus: 'busy', hostStatusAt: KILL, ...over,
});

// ── Q1/Q2: the killed shapes are stopped at +30 s ───────────────────────────
ok(isDeadHostTreeRow(claudeRow(), now) && isDeadHostRow(claudeRow(), now), 'Q1 Claude shape: host-declared pid and MCP owner both gone → stopped 30 s after the kill (was: live for 90 s)');
ok(isDeadHostTreeRow(codexRow(), now) && isDeadHostRow(codexRow(), now), 'Q2 Codex shape: guessed host pid, recorded hostTreePid and MCP owner all gone → stopped 30 s after the kill (was: live for the whole TTL)');
ok(isDeadHostRow(claudeRow({ hostPidSource: 'ppid', hostTreePid: D1, channelOwners: { mcp: D2 } }), now), 'Q2 hibernated shape (supervisor wrote hostPid as a guess, hostTreePid = host) → stopped');

// ── Q3: a live session is never freed ────────────────────────────────────────
ok(!isDeadHostRow(claudeRow({ hostPid: ALIVE }), now), 'Q3 host still running → live');
ok(!isDeadHostRow(claudeRow({ channelOwners: { mcp: ALIVE } }), now), 'Q3 a dead host pid but a running MCP worker (a wrongly-declared CLAUDE_PID / KLYPIX_HOST_PID) → live');
ok(!isDeadHostRow(codexRow({ hostTreePid: ALIVE }), now), 'Q3 Codex host still running while its MCP pair died → live');
ok(!isDeadHostRow(codexRow({ hostPid: ALIVE }), now), 'Q3 Codex supervisor still running → live');
ok(!isDeadHostTreeRow(claudeRow(), now, (pid) => (pid === D2 ? null : false)), 'Q3 a probe that cannot say (null) for any pid → not stopped by the new rule');
ok(!isDeadHostRow(codexRow({ hostTreePid: undefined }), now), 'Q3 a Codex row from an older build (no hostTreePid, guessed pids only) keeps today\'s TTL rule');
ok(!isDeadHostTreeRow(claudeRow({ channels: ['lifecycle'], channelSeen: { lifecycle: KILL }, channelOwners: { lifecycle: D3 } }), now)
  && !isDeadHostRow(claudeRow({ channels: ['lifecycle'], channelSeen: { lifecycle: KILL }, channelOwners: { lifecycle: D3 } }), now),
'Q3 a lifecycle-only row (no MCP owner to cross-check) keeps the 90 s grace');
ok(isDeadHostRow(claudeRow({ channels: ['lifecycle'], channelSeen: { lifecycle: now - 120_000 }, channelOwners: { lifecycle: D3 }, lastSeen: now - 120_000 }), now),
  'Q3 …and is still swept by the old rule once the grace has passed (unchanged)');
ok(!isDeadHostTreeRow(claudeRow({ channelSeen: { lifecycle: KILL, mcp: now - 4 * 60_000 } }), now), 'Q3 a stale MCP channel (no heartbeat for 3+ min) is not used as a witness');
ok(!isDeadHostRow(claudeRow({ machine: 'another-machine' }), now) && !isDeadHostRow(claudeRow({ machine: undefined }), now), 'Q3 a row from another machine (or with no machine) is never probed');
ok(!isDeadHostRow(codexRow({ via: 'cloud' }), now) && !isDeadHostRow(codexRow({ via: 'network' }), now), 'Q3 cloud / network rows are never probed');
ok(!isDeadHostRow(claudeRow({ lastSeen: now - 2_000 }), now) && DEAD_TREE_SETTLE_MS <= 10_000, 'Q3 a row written 2 s ago is left to settle (the window is short: a restart at +10 s already sees it stopped)');
ok(!isDeadHostRow(claudeRow({ hostPid: D2, channelOwners: { mcp: D2 } }), now), 'Q3 one pid alone (host = owner) is not enough evidence');

// ── Q4: who launched the supervisor ──────────────────────────────────────────
ok(resolveHostTreePid({ KLYPIX_MCP_SUPERVISED: '1', KLYPIX_MCP_HOST_TREE_PID: '4242' }, 99) === 4242, 'Q4 a supervised worker records the pid its supervisor passed');
ok(resolveHostTreePid({ KLYPIX_MCP_SUPERVISED: '1' }, 99) === null, 'Q4 a supervised worker under an older supervisor records nothing (its ppid is the supervisor, not the host)');
ok(resolveHostTreePid({}, 99) === 99, 'Q4 an unsupervised worker records its own parent');
const supSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-supervisor.mjs'), 'utf8');
ok(/KLYPIX_MCP_HOST_TREE_PID: String\(this\.parentPid\)/.test(supSrc) && /hostTreePid: this\.parentPid/.test(supSrc), 'Q4 the supervisor passes its parent to the worker and records it while hibernated');

// ── Q6: an inherited CLAUDE_PID is not written as this session's host ──────
// (round-4 field case: the MCP server of a Claude Code launched from a shell
// that already carried another Claude's CLAUDE_PID inherits that outer pid,
// which outlives the session and pinned its row live.)
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-qr-env-'));
  const project = path.join(temp, 'project');
  const qhome = path.join(temp, 'home');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(qhome, { recursive: true });
  fs.writeFileSync(path.join(project, 'brain.klypix'), 'test');
  const rowFor = (envExtra, id) => {
    const p = createMcpPresence({
      server: { server: { getClientVersion: () => ({ name: 'claude-code' }) }, sendLoggingMessage() {} },
      initialVault: project, home: qhome,
      env: { KLYPIX_SESSION_ID: id, KLYPIX_MCP_SUPERVISED: '1', ...envExtra },
      setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
    });
    p.start(project);
    p.sync({ phase: 'start', intent: 'q6' });
    return listActiveSessions({ brainPath: path.join(project, 'brain.klypix'), home: qhome }).find((r) => r.id === id || r.logicalSessionId === id);
  };
  const inherited = rowFor({ CLAUDE_PID: String(ALIVE), KLYPIX_MCP_HOST_TREE_PID: '4242' }, 'q6-inherited-0001');
  ok(inherited && inherited.hostTreePid === 4242 && Number(inherited.hostPid) !== ALIVE && inherited.hostPidSource !== 'env', 'Q6 a CLAUDE_PID that is not the MCP launcher is not recorded as the host-declared pid', inherited);
  const trusted = rowFor({ CLAUDE_PID: '4343', KLYPIX_MCP_HOST_TREE_PID: '4343' }, 'q6-trusted-0002');
  ok(trusted && trusted.hostPid === 4343 && trusted.hostPidSource === 'env' && trusted.hostTreePid === 4343, 'Q6 a CLAUDE_PID that IS the MCP launcher is recorded as host-declared, as before', trusted);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Q5: end to end through the lane writer, the readers and the real hook ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-quick-restart-'));
const home = path.join(root, 'home');
const repo = path.join(root, 'repo');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
try {
  const git = (...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'log.ts'), 'export const log = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.klypix/\n.claude/\nCLAUDE.local.md\n');
  const brainPath = path.join(repo, 'brain.klypix');
  fs.writeFileSync(brainPath, await buildKlypixMap({ title: 'quick restart', kind: 'brain', areas: [{ title: 'Upload', cards: [{ text: 'Upload: validate before storing' }] }] }));
  git('add', '-A'); git('commit', '-q', '-m', 'base');

  // The killed Claude session and a live peer, recorded through the real hook
  // (prompt + edits: the guard's edits ledger), then given the MCP channel the
  // worker writes: the killed session's MCP owner is gone, the peer's is alive.
  const KILLED = claudeRow().id;
  const PEER = 'a11ce000-1111-2222-3333-444444444444';
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_HOME: path.join(home, '.codex') };
  for (const k of ['KLYPIX_WHOSE', 'KLYPIX_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'KLYPIX_HOST_PID', 'CLAUDE_PID']) delete env[k];
  const hook = (mode, input, pid) => execFileSync(process.execPath, [HOOK, mode], { cwd: repo, env: { ...env, CLAUDE_PID: String(pid) }, encoding: 'utf8', input: JSON.stringify({ cwd: repo, ...input }), stdio: ['pipe', 'pipe', 'pipe'] });
  const edit = (sid, pid, rel, text) => { fs.writeFileSync(path.join(repo, rel), text); hook('--live', { session_id: sid, tool_name: 'Write', tool_input: { file_path: path.join(repo, rel) }, hook_event_name: 'PostToolUse' }, pid); };
  hook('--prompt', { session_id: KILLED, prompt: 'Today\'s list:\n1. MIME allowlist\n2. Rate limit\n3. DELETE /files/:id\n4. CHANGELOG + README', hook_event_name: 'UserPromptSubmit' }, D1);
  edit(KILLED, D1, 'src/rateLimit.ts', 'export const limit = 30; // half-written\n');
  edit(KILLED, D1, 'src/app.ts', 'export const app = 2;\n');
  hook('--prompt', { session_id: PEER, prompt: 'Refactor the logger', hook_event_name: 'UserPromptSubmit' }, ALIVE);
  edit(PEER, ALIVE, 'src/log.ts', 'export const log = 2; // peer in progress\n');
  const laneFile = laneFileFor(brainPath, home);
  const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const t = Date.now();
  for (const row of lane.sessions) {
    const killed = row.id === KILLED;
    const at = t - (killed ? 30_000 : 20_000);
    row.lastSeen = at; row.hostStatusAt = at; row.activityAt = at;
    row.channelSeen = { ...(row.channelSeen || {}), lifecycle: at, mcp: at - 10_000 };
    row.channels = Object.keys(row.channelSeen);
    row.channelOwners = { ...(row.channelOwners || {}), mcp: killed ? D2 : ALIVE };
  }
  for (const e of lane.directory) if (e.id === KILLED) e.lastSeen = t - 30_000;
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const laneText = JSON.stringify(lane);

  const live = listActiveSessions({ brainPath, home });
  ok(!live.some((r) => r.id === KILLED) && live.some((r) => r.id === PEER), 'Q5 engine: 30 s after the kill the killed session is not live; the live peer is', live.map((r) => r.id));
  const unfinished = listUnfinishedWork({ brainPath, home, selfId: 'n3w00000-0000-0000-0000-000000000000' });
  ok(unfinished.some((r) => r.id === KILLED && r.state === 'ended') && !unfinished.some((r) => r.id === PEER), 'Q5 engine: it is listed as unfinished work at once; the live peer is not', unfinished.map((r) => [r.id, r.state]));

  // A lane write by another session must drop the dead row, not resurrect it.
  upsertSession({ brainPath, home, id: 'writer-0000', client: 'codex', channel: 'lifecycle', intent: 'touch' });
  const after = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  ok(!after.sessions.some((r) => r.id === KILLED) && after.sessions.some((r) => r.id === PEER) && after.directory.some((e) => e.id === KILLED), 'Q5 the next lane write sweeps the dead row and keeps its record (directory) and the live peer', after.sessions.map((r) => r.id));

  // Put the lane back (the write above swept it) and drive the real Claude hook.
  fs.writeFileSync(laneFile, laneText);
  const NEXT = 'b0b0b0b0-5555-6666-7777-888888888888';
  const start = hook('', { session_id: NEXT, hook_event_name: 'SessionStart', source: 'startup' }, process.ppid);
  const unfinishedPart = start.split('⏸️ Work other sessions may have left unfinished')[1] || '';
  ok(/Claude Code 9da94336 · /.test(unfinishedPart) && /3\. DELETE \/files\/:id/.test(unfinishedPart), 'Q5 hook: the next session\'s SessionStart lists the killed session as unfinished work, with its step list', start.slice(0, 4000));
  ok(!/Claude Code a11ce000 · /.test(unfinishedPart), 'Q5 hook: the live peer is not listed as unfinished', start.slice(0, 4000));
  const guardRaw = hook('--guard', { session_id: NEXT, tool_name: 'Bash', tool_input: { command: 'git status' }, permission_mode: 'default', hook_event_name: 'PreToolUse' }, process.ppid);
  const guard = guardRaw.trim() ? JSON.parse(guardRaw) : {};
  const text = guard?.hookSpecificOutput?.permissionDecisionReason || guard?.hookSpecificOutput?.additionalContext || '';
  ok(/left by a session that has stopped/.test(text) && /src\/rateLimit\.ts — Claude Code session 9da94336/.test(text), 'Q5 guard: the killed session\'s files are "left by a session that has stopped" (was: "leave them alone")', text);
  const leave = text.split('KLYPIX: these uncommitted files were left')[0];
  ok(/leave them alone/.test(leave) && /src\/log\.ts/.test(leave) && !/rateLimit|app\.ts/.test(leave), 'Q5 guard: the live peer\'s file still gets "leave them alone", and only that file', text);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\nquick-restart: ${checks} checks passed`);
