#!/usr/bin/env node
// klypix-link — make THIS project's brain automatic for EVERY agent tool.
// `npx klypix-mcp install` gives Claude Code hooks and wires Codex globally; `link`
// extends the same automatic read+capture per project to Codex, Cursor, Cline,
// Windsurf, Copilot/VS Code, Gemini CLI, Aider, and any AGENTS.md-reading agent,
// by dropping each tool's native MCP config +
// rules file in the current project. Idempotent — re-run anytime to refresh. The managed
// block carries the brain version + a content hash, so:
//
//   npx klypix-mcp link            # (re)project every managed block (write)
//   npx klypix-mcp link --check    # AUDIT only — classify each file ok/stale/hand-edited/
//                                  # missing WITHOUT writing; exits 1 on drift (CI/pre-commit gate)
//
// Project-scoped (cwd); touches only files inside the project. Reports what it did;
// exits non-zero on hard fail / on detected drift in --check.
//
// Synchronous top-level by design: the dispatcher does `await import(this); process.exit(0)`,
// so all work (and its logs) must complete during module evaluation, before exit.
import path from 'path';
import { linkProject } from '../src/agent-rules.mjs';

try {
  const args = process.argv.slice(3);
  const check = args.includes('--check');
  const dirArg = args.find(a => !a.startsWith('-'));
  const projectDir = path.resolve(dirArg || process.cwd());
  const { rules, mcp, hasBrain, version } = linkProject(projectDir, { check });

  if (check) {
    // Audit-only: classify, report, exit 1 on any drift.
    const mark = (s) => s === 'ok' ? '✓' : '⚠';
    console.log(`klypix — auditing the brain projection in ${projectDir} (brain v${version})\n`);
    console.log('  MCP server config:');
    for (const r of mcp) console.log(`    ${mark(r.status)} ${r.tool.padEnd(26)} ${r.file} — ${r.status.toUpperCase()}${r.why ? ' (' + r.why + ')' : ''}`);
    console.log('\n  Rules / instructions:');
    for (const r of rules) console.log(`    ${mark(r.status)} ${r.tool.padEnd(26)} ${r.file} — ${r.status.toUpperCase()}${r.stampedVersion ? ' (stamped v' + r.stampedVersion + ')' : ''}`);
    const drift = [...rules, ...mcp].filter(r => r.status !== 'ok');
    if (!drift.length) { console.log(`\n✓ in sync — all ${rules.length + mcp.length} managed file(s) match brain v${version}.`); process.exit(0); }
    console.log(`\n✗ ${drift.length} file(s) drifted (stale / hand-edited / missing) — run \`npx klypix-mcp link\` to re-project.`);
    process.exit(1);
  }

  const mark = (a) => a === 'unchanged' ? '·' : a === 'skipped' ? '⚠' : '✓';
  console.log(`klypix — linking the brain to every agent tool in ${projectDir} (brain v${version})\n`);
  console.log('  MCP server (so each tool can reach the brain):');
  for (const r of mcp) console.log(`    ${mark(r.action)} ${r.tool.padEnd(26)} ${r.file}${r.why ? '  (' + r.why + ')' : ''}`);
  console.log('\n  Rules (so each tool auto-reads + captures the brain):');
  for (const r of rules) console.log(`    ${mark(r.action)} ${r.tool.padEnd(26)} ${r.file}${r.why ? '  (' + r.why + ')' : ''}`);

  const changed = [...rules, ...mcp].filter(r => r.action && !['unchanged', 'skipped'].includes(r.action)).length;
  console.log(`\n✓ ${changed} file(s) written/updated — every agent opened in this project now reads + captures ./brain.klypix.`);
  console.log('  Codex gets .codex/config.toml + AGENTS.md; Cline & Windsurf use their global MCP config plus project rules.');
  console.log('  Verify anytime with `npx klypix-mcp link --check` (or `npx klypix-mcp doctor`).');
  if (!hasBrain) {
    console.log('\n⚠ No ./brain.klypix here yet — the rules reference it for when you create one.');
    console.log('  Make one in the KLYPIX app (Canvas → Save as brain) or with the create_canvas MCP tool.');
  }
} catch (e) {
  console.error(`✗ link failed: ${e?.message || e}`);
  process.exit(1);
}
