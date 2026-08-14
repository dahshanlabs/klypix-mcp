// 2026-08-14 wave — mechanical presence liveness + identity rendering:
//   L1 — dead-host sweep: a row whose host-DECLARED ('env') pid is provably
//        dead is swept from the lane on the next touch, after a grace window;
//        alive pids, 'ppid' guesses, foreign machines and cloud rows are never
//        probed (TTL remains their only rule).
//   L2 — endSession also sweeps an unadopted transport twin whose
//        logicalSessionId names the ended identity, while sparing bystanders.
//   L3 — footer twin merge: rows sharing an exact logical id render as ONE
//        session; a pid-correlated mcp-only orphan folds only when exactly one
//        anchored candidate exists (ambiguity fails open); connection counts
//        stay honest.
//   L4 — git-style unique id prefixes in the peer footer: same-window UUIDv7
//        ids grow past the 8-char floor until unambiguous.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEAD_HOST_GRACE_MS,
  endSession,
  formatPresenceMessage,
  isDeadHostRow,
  isProcessAlive,
  laneFileFor,
  listActiveSessions,
  MACHINE_ID,
  mergePresenceRows,
  upsertSession,
} from '../src/agent-presence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-presence-liveness-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');

try {
  // ── L1: dead-host sweep ────────────────────────────────────────────────────
  // A real, provably-dead pid: spawnSync only returns after the child exited.
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  ok(isProcessAlive(process.pid) === true, 'L1: the probe reports this process alive');
  ok(isProcessAlive(deadPid) === false, 'L1: the probe reports an exited child dead');
  ok(isProcessAlive('not-a-pid') === null && isProcessAlive(0) === null,
    'L1: an unknown/invalid pid is "cannot say", never "dead"');

  const t0 = 2_400_000_000_000;
  upsertSession({
    brainPath, home, now: t0, id: 'dead-env-host', client: 'codex', channel: 'lifecycle',
    hostPid: deadPid, hostPidSource: 'env', intent: 'ghost work',
  });
  upsertSession({
    brainPath, home, now: t0, id: 'alive-env-host', client: 'codex', channel: 'lifecycle',
    hostPid: process.pid, hostPidSource: 'env',
  });
  upsertSession({
    brainPath, home, now: t0, id: 'dead-ppid-guess', client: 'codex', channel: 'lifecycle',
    hostPid: deadPid, hostPidSource: 'ppid',
  });
  const withinGrace = listActiveSessions({ brainPath, home, now: t0 + 1000 });
  ok(withinGrace.some((row) => row.id === 'dead-env-host'),
    'L1: within the grace window even a dead-host row is kept (no exit-race flap)');
  ok(withinGrace.find((row) => row.id === 'dead-env-host')?.machine === MACHINE_ID
    && withinGrace.find((row) => row.id === 'dead-env-host')?.hostPidSource === 'env',
  'L1: the writer stamps machine + hostPid provenance so readers can scope the probe');
  const pastGrace = listActiveSessions({ brainPath, home, now: t0 + DEAD_HOST_GRACE_MS + 1000 });
  ok(!pastGrace.some((row) => row.id === 'dead-env-host'),
    'L1: past the grace window a dead env-declared host row is gone');
  ok(pastGrace.some((row) => row.id === 'alive-env-host'),
    'L1: an alive env-declared host row survives the probe');
  ok(pastGrace.some((row) => row.id === 'dead-ppid-guess'),
    'L1: a ppid-GUESSED pid is never probed — TTL remains its only rule');

  // The sweep persists: any session's sync rewrites the lane without the corpse.
  upsertSession({
    brainPath, home, now: t0 + DEAD_HOST_GRACE_MS + 2000, id: 'sweeper', client: 'codex', channel: 'lifecycle',
  });
  const laneRaw = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  ok(!laneRaw.sessions.some((row) => row.id === 'dead-env-host')
    && laneRaw.sessions.some((row) => row.id === 'alive-env-host'),
  'L1: a peer sync SWEEPS the dead row from the lane file itself');

  // Probe scoping: foreign machine / cloud rows / unknown provenance are exempt.
  const aged = t0 + DEAD_HOST_GRACE_MS + 5000;
  ok(isDeadHostRow({ machine: 'other-machine', hostPid: deadPid, hostPidSource: 'env', lastSeen: t0 }, aged) === false,
    'L1: a row from another machine is never probed (foreign pid namespace)');
  ok(isDeadHostRow({ machine: MACHINE_ID, via: 'cloud', hostPid: deadPid, hostPidSource: 'env', lastSeen: t0 }, aged) === false,
    'L1: a cloud-relayed row is never probed');
  ok(isDeadHostRow({ machine: MACHINE_ID, hostPid: deadPid, lastSeen: t0 }, aged) === false,
    'L1: a row without declared pid provenance is never probed (legacy rows keep TTL)');
  // Adversarial-review hardening (2026-08-14): an unproven death must never
  // sweep. Only ESRCH is proof; an undecidable probe result keeps the row.
  ok(isDeadHostRow({ machine: MACHINE_ID, hostPid: 424242, hostPidSource: 'env', lastSeen: t0 }, aged, () => null) === false,
    'L1: an undecidable probe ("cannot say") never sweeps — TTL remains the rule');
  ok(DEAD_HOST_GRACE_MS > 60_000,
    'L1: the grace window exceeds the 60s MCP heartbeat interval, so an actively-heartbeating session can never be probed even under a wrongly-declared host pid');

  // ── L2: endSession sweeps the unadopted logical twin ───────────────────────
  const t1 = t0 + 120_000;
  upsertSession({
    brainPath, home, now: t1, id: 'thread-ended', client: 'codex', channel: 'lifecycle',
    logicalSessionId: 'thread-ended',
  });
  upsertSession({
    brainPath, home, now: t1, id: 'mcp-4242-twin', client: 'codex', channel: 'mcp',
    logicalSessionId: 'thread-ended',
  });
  upsertSession({
    brainPath, home, now: t1, id: 'bystander-thread', client: 'codex', channel: 'lifecycle',
    logicalSessionId: 'bystander-thread',
  });
  const ended = endSession({ brainPath, home, now: t1 + 10, id: 'thread-ended' });
  ok(ended.ok === true, 'L2: SessionEnd succeeds');
  const afterEnd = listActiveSessions({ brainPath, home, now: t1 + 20 });
  ok(!afterEnd.some((row) => row.id === 'mcp-4242-twin'),
    'L2: the unadopted mcp twin (logicalSessionId == ended id) is swept with its session');
  ok(afterEnd.some((row) => row.id === 'bystander-thread'),
    'L2: a session with its own logical identity survives another session\'s end');

  // ── L3: footer twin merge ──────────────────────────────────────────────────
  const T = 2_500_000_000_000;
  const life = {
    id: '019ff22f-aaaa-7000-8000-000000000001', client: 'codex', channels: ['lifecycle'],
    logicalSessionId: '019ff22f-aaaa-7000-8000-000000000001', machine: 'm1', hostPid: 700,
    lastSeen: T, intent: 'lifecycle scope', intentAt: T,
  };
  const logicalTwin = {
    id: 'mcp-720-abc', client: 'codex', channels: ['mcp'],
    logicalSessionId: '019ff22f-aaaa-7000-8000-000000000001', machine: 'm1', hostPid: 700, lastSeen: T,
  };
  const orphan = { id: 'mcp-720-def', client: 'codex', channels: ['mcp'], machine: 'm1', hostPid: 700, lastSeen: T };
  const self = { id: 'self-session', client: 'claude-code', channels: ['lifecycle'], logicalSessionId: 'self-session', lastSeen: T };
  const merged = mergePresenceRows([life, logicalTwin, orphan, self]);
  ok(merged.length === 2, 'L3: logical-id twin AND single-candidate pid orphan fold into one session');
  const codexGroup = merged.find((group) => group.primary.id === life.id);
  ok(codexGroup?.rows.length === 3 && codexGroup.channels.includes('lifecycle') && codexGroup.channels.includes('mcp'),
    'L3: the folded group keeps every transport channel (twins count toward the session)');
  const text = formatPresenceMessage([life, logicalTwin, orphan, self], 'self-session', { now: T });
  ok(text.includes('2 active sessions') && text.includes('4 connections'),
    'L3: the count line reports logical sessions AND does not understate connections');
  ok(text.includes('1 other') && text.includes('3 connections') && text.includes('lifecycle scope'),
    'L3: the peer line shows one merged session with its connection count and intent');

  // Ambiguity fails open: two anchored codex sessions under one host pid.
  const life2 = {
    id: '019ff22f-bbbb-7000-8000-000000000002', client: 'codex', channels: ['lifecycle'],
    logicalSessionId: '019ff22f-bbbb-7000-8000-000000000002', machine: 'm1', hostPid: 700, lastSeen: T,
  };
  const ambiguous = mergePresenceRows([life, life2, orphan, self]);
  ok(ambiguous.length === 4,
    'L3: a pid shared by TWO anchored sessions leaves the orphan separate (fail open — Codex threads share a desktop pid)');
  // A different specifically-known client also vetoes the fold.
  const foreignClientOrphan = { ...orphan, id: 'mcp-720-xyz', client: 'cursor' };
  ok(mergePresenceRows([life, foreignClientOrphan, self]).length === 3,
    'L3: a concretely different client never folds into another client\'s session');

  // ── L4: unique prefix growth in the footer ─────────────────────────────────
  const shared = '0199aaaabbbbccccdddd';
  const peerA = { id: `${shared}-alpha`, client: 'codex', channels: ['lifecycle'], logicalSessionId: `${shared}-alpha`, lastSeen: T, intent: 'first shared-prefix task', intentAt: T };
  const peerB = { id: `${shared}-beta`, client: 'codex', channels: ['lifecycle'], logicalSessionId: `${shared}-beta`, lastSeen: T, intent: 'second shared-prefix task', intentAt: T };
  const prefixText = formatPresenceMessage([peerA, peerB, self], 'self-session', { now: T });
  ok(prefixText.includes(`- ${shared}-a:`) && prefixText.includes(`- ${shared}-b:`),
    'L4: same-window ids grow past the 8-char floor until each prefix is unique');
  ok(!prefixText.includes(`- ${shared.slice(0, 8)}:`),
    'L4: the old ambiguous fixed 8-char slice is gone');

  console.log(failures ? `\n[x] ${failures} presence-liveness assertion(s) failed` : '\n[ok] presence-liveness: all assertions passed');
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(failures ? 1 : 0);
