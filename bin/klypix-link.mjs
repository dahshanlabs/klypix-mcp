#!/usr/bin/env node
// klypix-link — make THIS project's brain automatic for EVERY agent tool.
// `npx klypix-mcp install` gives Claude Code the brain via hooks; `link` extends the
// same automatic read+capture to Cursor, Cline, Windsurf, Copilot/VS Code, and any
// AGENTS.md-reading agent, by dropping each tool's native MCP config + rules file in
// the current project. Idempotent — re-run anytime to refresh. Project-scoped (cwd);
// touches only files inside the project. Reports what it did; exits non-zero on hard fail.
//
//   cd your-project && npx klypix-mcp link
//
// Synchronous top-level by design: the dispatcher does `await import(this); process.exit(0)`,
// so all work (and its logs) must complete during module evaluation, before exit.
import path from 'path';
import { linkProject } from '../src/agent-rules.mjs';

try {
  const dirArg = process.argv.slice(3).find(a => !a.startsWith('-'));
  const projectDir = path.resolve(dirArg || process.cwd());
  const { rules, mcp, hasBrain } = linkProject(projectDir);

  const mark = (a) => a === 'unchanged' ? '·' : a === 'skipped' ? '⚠' : '✓';
  console.log(`klypix — linking the brain to every agent tool in ${projectDir}\n`);
  console.log('  MCP server (so each tool can reach the brain):');
  for (const r of mcp) console.log(`    ${mark(r.action)} ${r.tool.padEnd(26)} ${r.file}${r.why ? '  (' + r.why + ')' : ''}`);
  console.log('\n  Rules (so each tool auto-reads + captures the brain):');
  for (const r of rules) console.log(`    ${mark(r.action)} ${r.tool.padEnd(26)} ${r.file}${r.why ? '  (' + r.why + ')' : ''}`);

  const changed = [...rules, ...mcp].filter(r => r.action && !['unchanged', 'skipped'].includes(r.action)).length;
  console.log(`\n✓ ${changed} file(s) written/updated — every agent opened in this project now reads + captures ./brain.klypix.`);
  console.log('  Cline & Windsurf MCP servers live in their global config; the rules file points them at the brain regardless.');
  if (!hasBrain) {
    console.log('\n⚠ No ./brain.klypix here yet — the rules reference it for when you create one.');
    console.log('  Make one in the KLYPIX app (Canvas → Save as brain) or with the create_canvas MCP tool.');
  }
} catch (e) {
  console.error(`✗ link failed: ${e?.message || e}`);
  process.exit(1);
}
