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
import fs from 'fs';
import path from 'path';
import { compactAgentsBrief, linkProject } from '../src/agent-rules.mjs';

// ARGV: this file is BOTH `klypix-link` (its own published bin) and the target of
// `klypix-mcp link` (the dispatcher splices its verb out of process.argv before
// importing us — see bin/klypix-worker.mjs runVerb). slice(2) is therefore the ONE
// correct shape for both. It used to be slice(3), which is right only via the
// dispatcher: as a standalone bin `klypix-link --check` silently dropped --check
// and WROTE all 14 managed files with exit 0, and `klypix-link <dir>` wrote into
// the cwd instead of <dir>. The strip below is belt-and-braces for a dispatcher
// that did not splice, and it refuses to eat a project folder actually named
// ./link.
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

try {
  const raw = process.argv.slice(2);
  const args = (raw[0] === 'link' && !isDir(path.resolve(raw[0]))) ? raw.slice(1) : raw;
  const check = args.includes('--check');
  const dirArg = args.find(a => !a.startsWith('-'));
  const projectDir = path.resolve(dirArg || process.cwd());
  const { rules, mcp, hasBrain, version } = linkProject(projectDir, { check });
  const compactBrief = await compactAgentsBrief(projectDir, { check });

  if (check) {
    // Audit-only: classify, report, exit 1 on any drift.
    const mark = (s) => s === 'ok' ? '✓' : '⚠';
    console.log(`klypix — auditing the brain projection in ${projectDir} (brain v${version})\n`);
    console.log('  MCP server config:');
    for (const r of mcp) console.log(`    ${mark(r.status)} ${r.tool.padEnd(26)} ${r.file} — ${r.status.toUpperCase()}${r.why ? ' (' + r.why + ')' : ''}`);
    console.log('\n  Rules / instructions:');
    for (const r of rules) console.log(`    ${mark(r.status)} ${r.tool.padEnd(26)} ${r.file} — ${r.status.toUpperCase()}${r.stampedVersion ? ' (stamped v' + r.stampedVersion + ')' : ''}`);
    if (compactBrief.status !== 'skipped') {
      console.log(`    ${mark(compactBrief.status)} ${'AGENTS.md compact fallback'.padEnd(26)} AGENTS.md — ${compactBrief.status.toUpperCase()}${compactBrief.bytes ? ` (${compactBrief.bytes} bytes)` : ''}`);
    }
    const briefDrift = ['stale', 'error'].includes(compactBrief.status) ? [compactBrief] : [];
    const drift = [...rules, ...mcp, ...briefDrift].filter(r => r.status !== 'ok' && r.status !== 'skipped');
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
  if (compactBrief.status !== 'skipped') {
    console.log(`    ${mark(compactBrief.action)} ${'AGENTS.md compact fallback'.padEnd(26)} AGENTS.md${compactBrief.bytes ? `  (${compactBrief.bytes} bytes)` : ''}`);
  }

  const changed = [...rules, ...mcp, compactBrief].filter(r => r.action && !['unchanged', 'skipped'].includes(r.action)).length;
  // A SKIPPED target is not wired (invalid MCP JSON left untouched, or a Codex
  // TOML write that failed). Write mode used to filter those out of the count,
  // print the blanket "every agent … now reads + captures" line anyway, and exit
  // 0 — while `--check` on the same project correctly reported drift and exited 1.
  // Report the truth and fail, so the two modes agree.
  const skipped = [...rules, ...mcp].filter(r => r.action === 'skipped');
  const managed = rules.length + mcp.length;
  if (skipped.length) {
    console.log(`\n✗ ${skipped.length} target(s) could not be wired:`);
    for (const r of skipped) console.log(`    ⚠ ${r.tool.padEnd(26)} ${r.file}${r.why ? ' — ' + r.why : ''}`);
    console.log(`\n  wired ${managed - skipped.length} of ${managed} managed file(s) (${changed} written/updated this run).`);
    console.log('  Fix the file(s) above (or move them aside) and re-run `npx klypix-mcp link`.');
    process.exit(1);
  }
  console.log(`\n✓ ${changed} file(s) written/updated — every agent opened in this project now reads + captures ./brain.klypix.`);
  console.log('  Codex, Cline, Gemini/Antigravity, Cursor, and VS Code get project MCP configs; Windsurf uses its global MCP plus project rules.');
  console.log('  Verify anytime with `npx klypix-mcp link --check` (or `npx klypix-mcp doctor`).');
  if (!hasBrain) {
    console.log('\n⚠ No ./brain.klypix here yet — the rules reference it for when you create one.');
    console.log('  Make one in the KLYPIX app (Canvas → Save as brain) or with the create_canvas MCP tool.');
  }
} catch (e) {
  console.error(`✗ link failed: ${e?.message || e}`);
  process.exit(1);
}
