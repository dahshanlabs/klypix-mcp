#!/usr/bin/env node
// klypix-check — `npx klypix-mcp check <files...>`. One question for hooks and
// CI: is another LIVE session on this project declaring, or observed editing,
// any of these files right now? Read-only: it never writes to the lane, never
// registers itself as a session, never changes a brain.
//
//   npx klypix-mcp check src/App.tsx electron/main.ts     # exit 0 clear, 1 overlap, 2 cannot say
//   npx klypix-mcp check --json src/App.tsx               # machine-readable object, same exit codes
//   npx klypix-mcp check --quiet src/App.tsx              # exit code only
//   npx klypix-mcp check --project <dir> <files...>       # resolve against another checkout
//
// Exit codes (Concord's `concord check` contract):
//   0  no live peer declares or was observed editing any of the files
//   1  overlap — one line per (file, session), then one summary line.
//      A heads-up, not a lock: the hook author decides whether to stop.
//   2  could not answer (no brain.klypix, lane unreadable, no files given) —
//      the reason is printed so a hook can decide what "unknown" means to it.
//
// Files are project-relative or absolute. The project root is the folder of the
// brain.klypix found by walking up from the cwd (or --project). Overlap uses the
// same key normalisation and twin filtering brain_sync uses (findPresenceConflicts
// in src/mcp-presence.mjs), so a hook and the agent's own sync never disagree.
// A path a peer only OBSERVED editing (no declared scope) is marked `*`, exactly
// as brain_sync renders it. The calling session — KLYPIX_SESSION_ID — is excluded,
// together with its logical twin rows, so a hook inside that session never warns
// about the session's own work.
//
// `check` with only flags (`--staged`, `--base`, `--install-hook`, …) is the
// rules check in src/brain-rules.mjs; the dispatcher routes here only when at
// least one file is named.
import fs from 'fs';
import path from 'path';
import {
  findProjectBrain,
  listActiveSessions,
  readLaneStatus,
  sessionStatusLabel,
  shortestUniqueSessionPrefix,
} from '../src/agent-presence.mjs';
import { annotateConflictFiles, findPresenceConflicts, isLogicalTwin } from '../src/mcp-presence.mjs';

export const CHECK_SELF_ID = '__klypix-check__';
export const CHECK_SUMMARY_SUFFIX = 'a heads-up, not a lock';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export function parseCheckArgs(raw) {
  const argv = (raw[0] === 'check' && !isDir(path.resolve(raw[0]))) ? raw.slice(1) : raw;
  const out = { json: false, quiet: false, project: null, files: [], unknownFlags: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') out.json = true;
    else if (token === '--quiet' || token === '-q') out.quiet = true;
    else if (token === '--project') out.project = argv[++i] || null;
    else if (token.startsWith('--project=')) out.project = token.slice('--project='.length);
    else if (token === '--') { out.files.push(...argv.slice(i + 1)); break; }
    else if (token.startsWith('-') && token.length > 1) out.unknownFlags.push(token);
    else out.files.push(token);
  }
  return out;
}

// A file as the person typed it, made project-relative with forward slashes so
// the printed line and the JSON agree with what brain_sync shows peers.
const displayPath = (file, root) => {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  const outside = !rel || rel.startsWith('..') || path.isAbsolute(rel);
  return (outside ? abs : rel).replace(/\\/g, '/');
};

/**
 * Pure core: answer the overlap question for `files` against `sessions`.
 * Returns { status: 'clear' | 'overlap', files: [{ file, overlaps: [...] }], liveSessions }.
 * `selfId` (KLYPIX_SESSION_ID) and its logical twins are never peers.
 */
export function checkFiles({ files, sessions, projectRoot, selfId = '', now = Date.now() }) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const selfRow = selfId ? rows.find((row) => row.id === selfId) || null : null;
  const peers = rows.filter((row) => row.id !== CHECK_SELF_ID
    && !(selfId && row.id === selfId)
    && !(selfRow && isLogicalTwin(row, selfRow)));
  const shown = files.map((file) => displayPath(file, projectRoot));
  // A synthetic row standing in for the hook: declares exactly the files asked
  // about, so findPresenceConflicts applies its own key normalisation, the
  // completed-and-idle gate and the observed/declared distinction for us.
  const me = { id: CHECK_SELF_ID, cwd: projectRoot, files: shown, lastSeen: now };
  const conflicts = findPresenceConflicts([...peers, me], CHECK_SELF_ID, { projectRoot });
  const byFile = new Map(shown.map((file) => [file, []]));
  for (const conflict of conflicts) {
    const { files: marked } = annotateConflictFiles(conflict);
    for (const entry of marked) {
      const observed = entry.endsWith('*');
      const file = observed ? entry.slice(0, -1) : entry;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({
        session: conflict.id,
        sessionShort: shortestUniqueSessionPrefix(peers, conflict.id) || String(conflict.id),
        client: conflict.client || 'unknown',
        intent: conflict.intent || '',
        branch: conflict.branch || null,
        observed,
        status: sessionStatusLabel(peers.find((row) => row.id === conflict.id), now) || null,
      });
    }
  }
  const result = shown.map((file) => ({ file, overlaps: byFile.get(file) || [] }));
  const overlapping = result.filter((entry) => entry.overlaps.length).length;
  return {
    status: overlapping ? 'overlap' : 'clear',
    files: result,
    overlappingFiles: overlapping,
    liveSessions: peers.length,
  };
}

const clientWord = (client) => {
  const key = String(client || '').toLowerCase();
  if (key === 'claude-code' || key === 'claude') return 'Claude Code';
  if (key === 'codex') return 'Codex';
  if (key === 'cursor') return 'Cursor';
  if (!key || key === 'unknown' || key === 'mcp') return 'agent';
  return key.replace(/(^|[-_ ])([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`);
};

export function renderCheck(report) {
  const lines = [];
  for (const entry of report.files) {
    for (const hit of entry.overlaps) {
      const parts = [
        `${entry.file}${hit.observed ? '*' : ''}`,
        '',
        `${clientWord(hit.client)} ${hit.sessionShort}`,
      ];
      const tail = [];
      if (hit.intent) tail.push(hit.intent);
      if (hit.branch) tail.push(`branch ${hit.branch}`);
      lines.push(`${parts.join(' ')}${tail.length ? ` · ${tail.join(' · ')}` : ''}`);
    }
  }
  if (report.files.some((entry) => entry.overlaps.some((hit) => hit.observed))) {
    lines.push('(* = observed from live edits, scope not declared)');
  }
  const n = report.overlappingFiles;
  lines.push(`KLYPIX: ${n} file(s) overlap with a live session — ${CHECK_SUMMARY_SUFFIX}`);
  return lines.join('\n');
}

export function runCheck(raw, { cwd = process.cwd(), env = process.env, home, now = Date.now() } = {}) {
  const args = parseCheckArgs(raw);
  const base = { command: 'check', files: args.files };
  const cannot = (reason, extra = {}) => ({ exit: 2, json: { ...base, status: 'unknown', exit: 2, reason, ...extra }, text: `KLYPIX: cannot answer — ${reason}`, quiet: args.quiet, isJson: args.json });
  if (args.unknownFlags.length) return cannot(`unknown flag ${args.unknownFlags[0]}`);
  if (!args.files.length) return cannot('no files given (usage: klypix-mcp check [--json] [--quiet] <files...>)');
  const projectDir = path.resolve(cwd, args.project || '.');
  const brainPath = findProjectBrain(projectDir);
  if (!brainPath) return cannot(`no brain.klypix found above ${projectDir.replace(/\\/g, '/')}`, { project: null, brain: null });
  const projectRoot = path.dirname(brainPath);
  const lane = readLaneStatus({ brainPath, home });
  const place = { project: projectRoot.replace(/\\/g, '/'), brain: brainPath.replace(/\\/g, '/') };
  if (!lane.ok) return cannot(`session lane unreadable (${lane.reason})`, { ...place, lane: lane.file });
  const sessions = lane.missing ? [] : listActiveSessions({ brainPath, home, now });
  const report = checkFiles({ files: args.files, sessions, projectRoot, selfId: String(env.KLYPIX_SESSION_ID || ''), now });
  const exit = report.status === 'overlap' ? 1 : 0;
  return {
    exit,
    json: { ...base, ...place, status: report.status, exit, liveSessions: report.liveSessions, overlappingFiles: report.overlappingFiles, files: report.files },
    text: exit ? renderCheck(report) : `KLYPIX: no live session is working on ${report.files.length === 1 ? report.files[0].file : `these ${report.files.length} files`}`,
    quiet: args.quiet,
    isJson: args.json,
  };
}

// Top level, like the other sub-bins: the dispatcher splices its verb out and
// `await import()`s this file, so all work completes during module evaluation.
{
  const result = runCheck(process.argv.slice(2));
  if (!result.quiet) {
    if (result.isJson) process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
    else if (result.exit === 2) process.stderr.write(`${result.text}\n`);
    else process.stdout.write(`${result.text}\n`);
  }
  process.exit(result.exit);
}
