#!/usr/bin/env node
// klypix-doctor — `npx klypix-mcp doctor`. The brain's self-check: is THIS machine's
// brain current, are the 4 Claude Code hooks wired, what verbs does it expose, who else
// is live on this project's brain, and is the harness projection in sync? ONE fact, ONE
// reconcile block. Read-only (never writes). Exits 0 = ALIGNED, 1 = DRIFTED — so it
// doubles as a pre-commit / CI readiness gate.
//
//   npx klypix-mcp doctor              # this project + this machine's brain
//   npx klypix-mcp doctor --npm        # also fetch npm 'latest' and flag a stale brain
//   npx klypix-mcp doctor --all        # + every registered brain on this machine + vault wiring
//   npx klypix-mcp doctor --project <dir> | --json | --no-color
//
// Synchronous-ish top-level by design: the dispatcher does `await import(this);
// process.exit(...)`, so all work completes during module evaluation.
import path from 'path';
import { execSync } from 'child_process';
import { inspect, render, inspectAll } from '../src/brain-doctor.mjs';

try {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const color = !has('--no-color') && process.stdout.isTTY !== false;
  const projectDir = path.resolve(val('--project') || process.cwd());

  let npmLatest = null;
  if (has('--npm')) {
    try { npmLatest = execSync('npm view klypix-mcp version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim(); }
    catch { npmLatest = '(offline)'; }
  }

  const report = inspect({ projectDir, npmLatest });

  if (has('--json')) {
    const all = has('--all') ? inspectAll() : undefined;
    console.log(JSON.stringify({ ...report, ...(all ? { crossProject: all } : {}) }, null, 2));
    process.exit(report.verdict === 'DRIFTED' ? 1 : 0);
  }

  console.log(render(report, { color }));

  let extraDrift = 0;
  if (has('--all')) {
    const all = inspectAll();
    extraDrift = all.drift;
    const dim = color ? '\x1b[2m' : '', red = color ? '\x1b[31m' : '', grn = color ? '\x1b[32m' : '', rst = color ? '\x1b[0m' : '';
    console.log(`\n# registered brains (${all.brains.length})`);
    for (const b of all.brains) {
      const tag = b.exists ? grn + '●' + rst : red + '○ missing' + rst;
      const v = !b.hasMcp ? dim + 'no .mcp.json (global config)' + rst : b.vaultOk ? grn + `vault ✓ (${b.vault})` + rst : red + `vault ⚠ ${b.vault} — not this project!` + rst;
      console.log(`  ${tag} ${b.project} · ${v}\n      ${dim}${b.path}${rst}`);
    }
  }

  const drifted = report.verdict === 'DRIFTED' || extraDrift > 0;
  console.log(drifted ? (color ? '\x1b[33m' : '') + `\n✗ drift found — see reconcile above.` + (color ? '\x1b[0m' : '')
    : report.verdict === 'NOT-INSTALLED' ? '\n• brain not installed on this machine.'
      : (color ? '\x1b[32m' : '') + '\n✓ aligned.' + (color ? '\x1b[0m' : ''));
  process.exit(drifted ? 1 : 0);
} catch (e) {
  console.error(`✗ doctor failed: ${e?.message || e}`);
  process.exit(1);
}
