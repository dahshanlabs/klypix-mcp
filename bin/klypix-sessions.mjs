#!/usr/bin/env node
// klypix-sessions — `npx klypix-mcp sessions`. The human side of "reopen on your
// OK": the recent agent sessions of THIS project that are not running, which of
// them have notes waiting, and a one-word way to bring one back so its notes
// reach it.
//
//   npx klypix-mcp sessions                       # list (this project)
//   npx klypix-mcp sessions --json                # the same, machine-readable
//   npx klypix-mcp sessions reopen <id>           # reopen it in a new terminal; it starts on the note
//   npx klypix-mcp sessions reopen <id> --quiet   # reopen it, but let it wait for you
//   npx klypix-mcp sessions ... --project <dir> | --dry-run
//
// Typing `reopen` IS the human's yes, so there is no second prompt here. Only a
// Claude Code or Codex session that has a note waiting can be reopened — KLYPIX
// reopens a conversation so a note can reach it; it does not start agents.
import fs from 'fs';
import path from 'path';
import {
  buildReopenLaunch,
  findProjectBrain,
  launchReopen,
  listKnownSessions,
  recordSessionReopen,
  reopenCandidate,
  REOPEN_NUDGE,
} from '../src/agent-presence.mjs';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const raw = process.argv.slice(2);
const argv = (raw[0] === 'sessions' && !isDir(path.resolve(raw[0]))) ? raw.slice(1) : raw;
const has = (flag) => argv.includes(flag);
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const projectDir = path.resolve(val('--project') || process.cwd());
const brainPath = findProjectBrain(projectDir);
const word = (client) => {
  const key = String(client || '').toLowerCase();
  if (key === 'claude-code' || key === 'claude') return 'Claude Code';
  if (key === 'codex') return 'Codex';
  return key ? key.replace(/(^|[-_ ])([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`) : 'Unknown';
};

if (!brainPath) {
  console.error(`No project brain (brain.klypix) at or above ${projectDir} — run this in the project folder, or pass --project <dir>.`);
  process.exit(1);
}

if (argv[0] === 'reopen') {
  const target = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
  if (!target) {
    console.error('Usage: npx klypix-mcp sessions reopen <session id or 8+ character prefix> [--quiet] [--dry-run]');
    process.exit(2);
  }
  const candidate = reopenCandidate({ brainPath, target, humanInitiated: true });
  if (!candidate.ok) {
    const who = candidate.entry ? `${word(candidate.entry.client)} ${String(candidate.entry.id).slice(0, 8)}` : `"${target}"`;
    const why = {
      'unknown-session': `no session KLYPIX remembers in this project matches ${who}`,
      'ambiguous-session': `${who} matches more than one session — use more characters of its id`,
      live: `${who} is running${candidate.statusLabel ? ` (${candidate.statusLabel})` : ''}; it gets its notes at its next action`,
      'unsupported-client': `${who} cannot be reopened by KLYPIX (only Claude Code and Codex have a verified resume-by-id)`,
      'unsafe-id': `${who} has an id that cannot be passed to a terminal safely`,
      'no-waiting-note': `no note is waiting for ${who} — KLYPIX reopens a session only so a note can reach it`,
      'just-reopened': `${who} was reopened moments ago — look for its terminal window`,
    }[candidate.reason] || `${who} cannot be reopened (${candidate.reason})`;
    console.error(`Not reopened: ${why}.`);
    process.exit(1);
  }
  const plan = buildReopenLaunch({ hostKey: candidate.hostKey, sessionId: candidate.entry.id, cwd: candidate.cwd, prompt: has('--quiet') ? '' : REOPEN_NUDGE });
  const launch = launchReopen(plan, { env: has('--dry-run') ? { ...process.env, KLYPIX_REOPEN_LAUNCH: 'dry-run' } : process.env });
  const label = `${candidate.hostLabel} ${candidate.entry.id.slice(0, 8)}`;
  if (launch.dryRun) {
    console.log(`Dry run: would reopen ${label} via ${plan.method} in ${candidate.cwd} with ${candidate.command}${has('--quiet') ? '' : ' (and let it act on the note)'}.`);
    process.exit(0);
  }
  if (!launch.launched) {
    recordSessionReopen({ brainPath, sessionId: candidate.entry.id, outcome: 'manual', via: 'cli', method: plan.method || null });
    console.error(`Could not open a terminal here (${plan.reason || launch.reason || 'unknown'}). Run it yourself:\n  cd ${JSON.stringify(candidate.cwd)}\n  ${candidate.command}`);
    process.exit(1);
  }
  recordSessionReopen({ brainPath, sessionId: candidate.entry.id, outcome: 'reopened', via: 'cli', method: plan.method });
  const notes = candidate.waitingNotes.length;
  console.log(`🔓 Reopened ${label} in a new terminal (${candidate.cwd}) with ${candidate.command}${has('--quiet') ? ' — it waits for you' : ' — it starts on the note'}. ${notes === 1 ? 'Its waiting note is' : `Its ${notes} waiting notes are`} delivered at its first action.`);
  process.exit(0);
}

const now = Date.now();
const rows = listKnownSessions({ brainPath, now }).filter((row) => !row.live);
if (has('--json')) {
  console.log(JSON.stringify({ project: path.dirname(brainPath), brain: brainPath, sessions: rows.map((row) => ({
    id: row.id, client: row.client, intent: row.intent, status: row.status, lastSeen: row.lastSeen,
    endedAt: row.endedAt || null, waitingNotes: row.waitingDirectedNotes, waitingBroadcasts: row.waitingNotes - row.waitingDirectedNotes,
    cwd: row.cwd || null, reopenable: Boolean(row.resumeCommand) && row.waitingDirectedNotes > 0, resumeCommand: row.resumeCommand || null,
  })) }, null, 2));
  process.exit(0);
}
if (!rows.length) {
  console.log('No recent sessions of this project are closed. (Live sessions: npx klypix-mcp doctor.)');
  process.exit(0);
}
const waiting = rows.filter((row) => row.waitingDirectedNotes > 0);
console.log(`Recent sessions of ${path.basename(path.dirname(brainPath))} that are not running (${rows.length}${waiting.length ? `, ${waiting.length} with notes waiting` : ''}):`);
for (const row of rows.slice(0, 20)) {
  const n = row.waitingDirectedNotes;
  const note = n ? ` · 📬 ${n} note${n === 1 ? '' : 's'} waiting` : '';
  console.log(`  ${row.id.slice(0, 8)}  ${word(row.client).padEnd(11)} ${String(row.status).padEnd(18)}${note}${row.intent ? `  “${row.intent.slice(0, 70)}”` : ''}`);
}
const first = waiting.find((row) => row.resumeCommand);
if (first) console.log(`\nReopen one so its notes reach it:  npx klypix-mcp sessions reopen ${first.id.slice(0, 8)}${waiting.length > 1 ? '   (any id above with notes waiting)' : ''}`);
process.exit(0);
