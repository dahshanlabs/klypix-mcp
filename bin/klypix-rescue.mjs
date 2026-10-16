#!/usr/bin/env node
// `klypix-mcp rescue [list|show <n|id>|restore <n|id> [paths…]|prune]`
// The human surface for the rescue copies KLYPIX takes before a git command
// could discard uncommitted files (src/whose-rescue.mjs). A copy nobody can
// find is a copy nobody trusts, so `list` is the default, `show` says exactly
// what a copy holds and what it left out, and `restore` says what it changed
// and how to undo it — a restore first saves the files it is about to replace.
//
// A restore writes the working tree only. It never stages, commits, switches a
// branch or touches the git index.
//
// ARGV: process.argv.slice(2) — the standalone shape. The dispatcher
// (bin/klypix-worker.mjs runVerb) removes its own `rescue` token first.
import path from 'path';
import {
  listRescuesResult, showRescue, restoreRescue, pruneRescues,
  rescueRestoreCommand, RESCUE_KEEP, RESCUE_MAX_AGE_MS,
} from '../src/whose-rescue.mjs';

const USAGE = [
  'klypix-mcp rescue — copies of uncommitted files KLYPIX saved before a git command could discard them.',
  '',
  'Usage:',
  '  npx klypix-mcp rescue [list] [--all]               newest first (--all: every worktree of this repository)',
  '  npx klypix-mcp rescue show <n|id>                  what one copy holds, and what it left out',
  '  npx klypix-mcp rescue restore <n|id> [paths…]      write its files back (all, or the paths/folders named)',
  '  npx klypix-mcp rescue prune [--days 14] [--keep 50] [--dry-run]',
  '',
  'Flags: --repo <dir> (default: the current folder), --json, --other-worktree (restore a copy taken in another worktree here).',
  '<n> is the number `list` shows; an id may be shortened while it stays unique.',
  'A restore first saves the files it replaces as a new copy, so it can be undone the same way.',
  'It writes the working tree only: nothing is staged, committed or switched.',
].join('\n');

const raw = process.argv.slice(2);
if (raw.includes('--help') || raw.includes('-h')) { console.log(USAGE); process.exit(0); }

const VALUE_FLAGS = new Set(['--repo', '--days', '--keep']);
const BOOL_FLAGS = new Set(['--json', '--all', '--dry-run', '--other-worktree']);
const flags = {};
const positional = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '--') { positional.push(...raw.slice(i + 1)); break; }
  if (VALUE_FLAGS.has(a)) {
    if (i + 1 >= raw.length) { console.error(`klypix-mcp rescue: ${a} needs a value.\n\n${USAGE}`); process.exit(2); }
    flags[a] = raw[++i];
  } else if (BOOL_FLAGS.has(a)) flags[a] = true;
  else if (a.startsWith('-') && a.length > 1) { console.error(`klypix-mcp rescue: unknown flag ${a}\n\n${USAGE}`); process.exit(2); }
  else positional.push(a);
}
const ACTIONS = ['list', 'show', 'restore', 'prune'];
const action = ACTIONS.includes(positional[0]) ? positional.shift() : 'list';
if (action === 'list' && positional.length) {
  console.error(`klypix-mcp rescue: unknown command "${positional[0]}".\n\n${USAGE}`);
  process.exit(2);
}
const repoRoot = path.resolve(flags['--repo'] || process.cwd());
const json = Boolean(flags['--json']);
const out = (value) => console.log(JSON.stringify(value, null, 2));

const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const utc = (ts) => new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const SHOW = 12;
const listLines = (items, fmt) => {
  for (const x of items.slice(0, SHOW)) console.log(`  ${fmt(x)}`);
  if (items.length > SHOW) console.log(`  …and ${items.length - SHOW} more`);
};
const summary = (e) => {
  const absent = e.deleted.length ? ` (${e.deleted.length} absent)` : '';
  const left = e.skipped.length ? `, ${e.skipped.length} not included` : '';
  return `${plural(e.paths.length, 'file')}${absent}${left}`;
};

if (action === 'list') {
  const res = listRescuesResult({ repoRoot, allWorktrees: Boolean(flags['--all']) });
  if (!res.ok) { console.error(`klypix-mcp rescue: ${res.error}`); process.exit(1); }
  if (json) { out(res.rescues); process.exit(0); }
  if (!res.rescues.length) {
    console.log(`No rescue copies in ${res.top}${flags['--all'] ? '' : ' (this worktree)'}.`);
    if (res.elsewhere) console.log(`${plural(res.elsewhere, 'copy', 'copies')} taken in other worktrees of this repository: add --all.`);
    console.log('KLYPIX takes one before a git command could discard uncommitted files.');
    process.exit(0);
  }
  console.log(`Rescue copies in ${res.top}, newest first:`);
  // Numbers count this worktree's copies only — the same numbering `show <n>`
  // and `restore <n>` use — so a copy from another worktree gets none.
  let n = 0;
  for (const e of res.rescues) {
    const num = e.here ? String(++n) : '-';
    const where = e.here ? '' : `  [${e.worktree}]`;
    console.log(`  ${num.padStart(3)}  ${e.id}  ${ago(e.at).padEnd(9)} ${e.reason} · ${summary(e)}${where}`);
  }
  if (!flags['--all'] && res.elsewhere) console.log(`  (+${plural(res.elsewhere, 'copy', 'copies')} from other worktrees: add --all)`);
  console.log('');
  console.log('Show one:    npx klypix-mcp rescue show <n|id>');
  console.log('Restore one: npx klypix-mcp rescue restore <n|id> [paths…]');
  console.log('A restore saves the current files first, so it can be undone the same way.');
  process.exit(0);
}

if (action === 'show') {
  if (!positional[0]) { console.error(`Usage: npx klypix-mcp rescue show <n|id>\n\n${USAGE}`); process.exit(2); }
  const res = showRescue({ repoRoot, id: positional[0] });
  if (json) { out(res); process.exit(res.ok ? 0 : 1); }
  if (!res.ok) { console.error(`klypix-mcp rescue: ${res.error}`); process.exit(1); }
  console.log(`Rescue ${res.id} — ${res.reason}`);
  console.log(`  taken     ${ago(res.at)} (${utc(res.at)})${res.sid ? ` by session ${res.sid}` : ''}`);
  console.log(`  on        ${res.branch || 'a detached HEAD'}${res.head ? ` @ ${res.head.slice(0, 10)}` : ' (no commit yet)'}${res.worktree ? `, in ${res.worktree}` : ''}${res.here ? '' : '  — ANOTHER worktree'}`);
  console.log(`  git       ${res.ref} (commit ${res.commit.slice(0, 10)})`);
  console.log(`\n${plural(res.files.length, 'file')}; ${res.stat.added} line(s) added and ${res.stat.removed} removed against that HEAD:`);
  const width = Math.min(48, Math.max(...res.files.map((f) => f.path.length), 4));
  listLines(res.files, (f) => {
    const lines = f.binary ? 'binary' : f.change === 'deleted' || f.change === 'absent' ? '' : `+${f.added} -${f.removed}`;
    return `${f.change.padEnd(12)} ${f.path.padEnd(width)} ${lines}`.trimEnd();
  });
  if (res.skipped.length) {
    console.log('\nNot included:');
    listLines(res.skipped, (s) => `${s.path} (${s.why})`);
  }
  console.log(`\nRestore:     ${rescueRestoreCommand(res.id)} [paths…]`);
  console.log(`Or with git: ${res.head ? `git diff ${res.commit.slice(0, 10)}^ ${res.commit.slice(0, 10)}` : `git show ${res.commit.slice(0, 10)}`}`);
  process.exit(0);
}

if (action === 'restore') {
  if (!positional[0]) {
    console.error('Usage: npx klypix-mcp rescue restore <n|id> [paths…]');
    console.error('Run `npx klypix-mcp rescue list` to see the copies.');
    process.exit(2);
  }
  const [id, ...paths] = positional;
  const res = restoreRescue({
    repoRoot, id, paths: paths.length ? paths : null, sid: 'cli', cwd: process.cwd(),
    allowOtherWorktree: Boolean(flags['--other-worktree']),
  });
  if (json) { out(res); process.exit(res.ok && !res.skipped?.length ? 0 : 1); }
  if (!res.ok) {
    console.error(`Restore failed: ${res.error}`);
    if (res.skipped?.length) listLines(res.skipped, (s) => `${s.path} — ${s.why}`);
    process.exit(1);
  }
  const written = res.restored.filter((p) => !res.deleted.includes(p));
  if (res.restored.length) {
    console.log(`Restored ${plural(res.restored.length, 'path')} from rescue ${res.from}:`);
    listLines(written, (p) => p);
    if (res.deleted.length) listLines(res.deleted, (p) => `removed ${p} (it did not exist when the copy was taken)`);
  } else console.log(`Nothing needed writing from rescue ${res.from}.`);
  if (res.unchanged.length) {
    console.log('Already as in the copy:');
    listLines(res.unchanged, (p) => p);
  }
  if (res.skipped.length) {
    console.log('Left as it is:');
    listLines(res.skipped, (s) => `${s.path} — ${s.why}`);
  }
  if (res.backupId) {
    console.log(`\nWhat was there before is saved as ${res.backupId}. Undo this restore: ${rescueRestoreCommand(res.backupId)}`);
  }
  console.log('Only the working tree changed: nothing was staged or committed. `git status` shows the result.');
  process.exit(res.skipped.length ? 1 : 0);
}

// prune
const days = flags['--days'] != null ? Number(flags['--days']) : RESCUE_MAX_AGE_MS / 86400000;
const keep = flags['--keep'] != null ? Number(flags['--keep']) : RESCUE_KEEP;
if (!Number.isFinite(days) || days < 0 || !Number.isInteger(keep) || keep < 0) {
  console.error(`klypix-mcp rescue prune: --days takes a number of days and --keep a whole number.\n\n${USAGE}`);
  process.exit(2);
}
const res = pruneRescues({ repoRoot, keep, maxAgeMs: days * 86400000, dryRun: Boolean(flags['--dry-run']) });
if (json) { out(res); process.exit(res.ok ? 0 : 1); }
if (!res.ok) { console.error(`klypix-mcp rescue: ${res.error}`); process.exit(1); }
const rule = `older than ${days} day(s), keeping the newest ${keep} of each worktree`;
if (flags['--dry-run']) {
  const would = res.wouldDelete || [];
  console.log(would.length ? `Would prune ${plural(would.length, 'copy', 'copies')} ${rule}:` : `Nothing to prune (${rule}).`);
  listLines(would, (x) => x);
  console.log('DRY RUN — nothing was deleted.');
} else {
  console.log(res.deleted.length ? `Pruned ${plural(res.deleted.length, 'copy', 'copies')} ${rule}; ${res.kept} remain.` : `Nothing to prune (${rule}); ${res.kept} kept.`);
}
process.exit(0);
