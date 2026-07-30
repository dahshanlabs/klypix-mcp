#!/usr/bin/env node
// klypix-uninstall — remove klypix-mcp, completely and safely.
//
// Until 1.43.1 there was NO removal command. Uninstalling meant hand-editing
// ~/.claude/settings.json, ~/.codex/config.toml, ~/.codex/hooks.json and
// ~/.codex/AGENTS.md, deleting ~/.claude/project-brain, and deleting or un-fencing
// 14 files in every linked project. A tool you cannot cleanly remove is a tool
// people do not install — this closes that gap.
//
//   npx -p klypix-mcp klypix-uninstall --check        # machine-global: what WOULD go
//   npx -p klypix-mcp klypix-uninstall --yes          # machine-global: remove it
//   npx -p klypix-mcp klypix-uninstall unlink --check # this project's 14 managed files
//   npx -p klypix-mcp klypix-uninstall unlink --yes
//   npx -p klypix-mcp klypix-uninstall --all --yes    # both (machine + this project)
//
// It ALWAYS prints the full inventory before it acts, it backs up every file with
// content before touching it, it removes only klypix-owned content (your prose,
// your sibling MCP servers and your other hooks survive), and it NEVER deletes a
// .klypix / .any canvas — brain.klypix is your data.
//
// EXIT CODES (no silent partial success):
//   0  nothing left to remove, or --yes completed with everything removed
//   1  --check/--dry-run and something remains; or --yes finished with blocked items
//   2  something remains and --yes was not given (refusing to act unconfirmed)
//   3  usage error
//
// ARGV: parsed from process.argv.slice(2) — the ONE shape that is correct both as
// its own published bin and behind a dispatcher that splices its verb out (see
// bin/klypix-worker.mjs runVerb). It is deliberately NOT slice(3): that is the bug
// that made `klypix-link --check` drop its flag and WRITE 14 files with exit 0. In
// an uninstaller the same bug would DELETE when asked to preview, so the leading
// subcommand token is stripped only when it is not an actual directory of that name.
import path from 'path';
import {
  planUnlink, planUninstall, applyPlan, pending, blocked, findBackups, purgeBackups,
} from '../src/uninstall.mjs';

const USAGE = [
  'klypix-uninstall — remove klypix-mcp from this machine and/or this project.',
  '',
  'Usage:',
  '  klypix-uninstall [--check|--dry-run] [--yes] [flags]      machine-global removal',
  '  klypix-uninstall unlink [dir] [--check|--dry-run] [--yes] project-local removal (14 managed files)',
  '',
  'Flags:',
  '  --check, --dry-run   print exactly what WOULD be removed, touch nothing, exit 1 if anything remains',
  '  --yes, -y            actually remove (the inventory is printed first either way)',
  '  --all                with the machine-global form, also unlink the project directory',
  '  --sidecars           (unlink) also delete <project>/.claude runtime caches/logs',
  '  --keep-registry      keep ~/.claude/project-brain/registry.json (cross-project brain registry)',
  '  --keep-semantic      keep ~/.claude/project-brain/semantic/ (the on-device model; npm cannot re-download it)',
  '  --purge-backups      also delete the .klypix-bak restore points this command leaves behind',
  '',
  'It never deletes brain.klypix or any .klypix/.any canvas. Managed blocks are removed',
  'from shared files; everything you wrote around them survives.',
].join('\n');

const KNOWN = new Set([
  '--check', '--dry-run', '--yes', '-y', '--all', '--sidecars',
  '--keep-registry', '--keep-semantic', '--purge-backups', '--help', '-h',
]);

const raw = process.argv.slice(2);
let mode = 'uninstall';
// `unlink` / `uninstall` here are SUBCOMMANDS of this bin, not a dispatcher verb,
// so a bare leading token always selects the mode. klypix-link.mjs additionally
// statSync-guards its token because there the token and the mode coincide and
// eating a folder named ./link would silently retarget the write; here the guard
// would do the OPPOSITE damage — it would flip `unlink` into a MACHINE-GLOBAL run
// just because a ./unlink folder happened to exist next to you. A project really
// named `unlink` stays addressable by path: `klypix-uninstall unlink ./unlink`.
if (raw.length && (raw[0] === 'unlink' || raw[0] === 'uninstall')) mode = raw.shift();
const args = raw;

if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const unknown = args.filter((a) => a.startsWith('-') && !KNOWN.has(a));
if (unknown.length) { console.error(`klypix-uninstall: unknown flag ${unknown.join(', ')}\n\n${USAGE}`); process.exit(3); }

const check = args.includes('--check') || args.includes('--dry-run');
const yes = args.includes('--yes') || args.includes('-y');
if (check && yes) { console.error('klypix-uninstall: --check and --yes are mutually exclusive.\n\n' + USAGE); process.exit(3); }
const all = args.includes('--all');
const sidecars = args.includes('--sidecars');
const keepRegistry = args.includes('--keep-registry');
const keepSemantic = args.includes('--keep-semantic');
const purge = args.includes('--purge-backups');
const dirArg = args.find((a) => !a.startsWith('-'));
const projectDir = path.resolve(dirArg || process.cwd());

const MARK = { none: '·', blocked: '⚠' };
const mark = (action) => MARK[action] || '→';
const VERB = {
  'delete-file': 'DELETE FILE',
  'delete-dir': 'DELETE DIR',
  'strip-block': 'STRIP BLOCK',
  'strip-entry': 'STRIP ENTRY',
  none: 'nothing to remove',
  blocked: 'BLOCKED',
};

function printPlan(plan, title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(Math.min(78, title.length + 8)));
  for (const item of plan.items) {
    console.log(`  ${mark(item.action)} ${String(item.label).padEnd(26)} ${item.rel.padEnd(34)} ${VERB[item.action] || item.action}`);
    if (item.why && item.action !== 'none') console.log(`      ${item.why}`);
  }
  for (const note of plan.notes || []) console.log(`  ℹ ${note}`);
}

function printResults(results) {
  let removed = 0;
  let failed = 0;
  const backups = [];
  for (const r of results) {
    const res = r.result;
    if (res.action === 'none') continue;
    if (!res.ok) { failed++; console.error(`  ✗ ${String(r.label).padEnd(26)} ${r.rel} — ${res.error}`); continue; }
    removed++;
    console.log(`  ✓ ${String(r.label).padEnd(26)} ${r.rel} — ${VERB[res.action] || res.action}${res.backup ? ` (backup: ${path.basename(res.backup)})` : ''}${res.kept?.length ? ` (kept: ${res.kept.join(', ')})` : ''}`);
    if (res.backup) backups.push(res.backup);
  }
  return { removed, failed, backups };
}

const plans = [];
if (mode === 'unlink') {
  plans.push({ plan: planUnlink(projectDir, { sidecars }), title: `klypix — project-local removal in ${projectDir}` });
} else {
  plans.push({ plan: planUninstall({ keepRegistry, keepSemantic }), title: 'klypix — machine-global removal' });
  if (all) plans.push({ plan: planUnlink(projectDir, { sidecars }), title: `klypix — project-local removal in ${projectDir}` });
}

for (const { plan, title } of plans) printPlan(plan, title);

const totalPending = plans.reduce((n, p) => n + pending(p.plan).length, 0);
const totalBlocked = plans.reduce((n, p) => n + blocked(p.plan).length, 0);
const existingBackups = plans.flatMap(({ plan }) => findBackups(plan));

if (check) {
  console.log('');
  if (existingBackups.length) console.log(`  ℹ ${existingBackups.length} .klypix-bak restore point(s) exist — they are yours, not removed (use --purge-backups).`);
  if (!totalPending) { console.log('✓ nothing to remove — klypix is not installed here (or has already been removed).'); process.exit(0); }
  console.log(`✗ ${totalPending} item(s) still present${totalBlocked ? ` (${totalBlocked} BLOCKED — cannot be removed automatically)` : ''}.`);
  console.log('  DRY RUN — nothing was changed. Re-run with --yes to remove them.');
  process.exit(1);
}

if (!totalPending) {
  console.log('\n✓ nothing to remove — klypix is not installed here (or has already been removed).');
  if (purge && existingBackups.length) {
    const gone = plans.flatMap(({ plan }) => purgeBackups(plan));
    console.log(`✓ removed ${gone.length} .klypix-bak restore point(s).`);
  }
  process.exit(0);
}

if (!yes) {
  console.log(`\n${totalPending} item(s) would be removed. Nothing has been changed.`);
  console.log('  Re-run with --yes to remove them, or --check for the same preview as a CI gate.');
  process.exit(2);
}

console.log('\nremoving:');
let removed = 0;
let failed = 0;
const madeBackups = [];
for (const { plan } of plans) {
  const r = printResults(applyPlan(plan));
  removed += r.removed;
  failed += r.failed;
  madeBackups.push(...r.backups);
}

if (purge) {
  const gone = plans.flatMap(({ plan }) => purgeBackups(plan));
  console.log(`✓ removed ${gone.length} .klypix-bak restore point(s).`);
} else if (madeBackups.length) {
  console.log(`\n  ℹ ${madeBackups.length} .klypix-bak restore point(s) were written next to the files that changed.`);
  console.log('    Delete them when you are satisfied (or re-run with --purge-backups).');
}

console.log('');
console.log('  ℹ No .klypix / .any canvas was touched. brain.klypix is your data and stays.');
if (failed) {
  console.error(`✗ removed ${removed} item(s); ${failed} could NOT be removed (listed above) — fix those by hand and re-run.`);
  process.exit(1);
}
console.log(`✓ removed ${removed} item(s). Re-run with --check to confirm nothing remains.`);
if (mode !== 'unlink') {
  console.log('  The npm package itself is separate: `npm uninstall -g klypix-mcp`, or clear the npx cache entry.');
  console.log('  Each project you ran `link` in still has its 14 managed files — remove them with `klypix-uninstall unlink <dir> --yes`.');
}
process.exit(0);
