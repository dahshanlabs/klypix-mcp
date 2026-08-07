#!/usr/bin/env node
// `klypix-mcp git-hook [install|remove|status] [repo]` — wire the agent-neutral
// commit-capture hook (brain-git-hook.mjs) into a repo, so rationale-bearing
// feat/fix/perf commits from ANY agent/branch/worktree card into ./brain.klypix
// at commit time. Standalone use: node bin/klypix-git-hook.mjs <args>
import path from 'path';
import { gitCaptureHookStatus, installGitCaptureHook, removeGitCaptureHook } from '../src/git-capture-install.mjs';

const args = process.argv.slice(2).filter((a) => a !== 'git-hook');
const action = ['install', 'remove', 'status'].includes(args[0]) ? args[0] : 'status';
const repo = path.resolve(process.cwd(), args.find((a, i) => i > 0 || !['install', 'remove', 'status'].includes(a)) || '.');

const describe = (s) => `state: ${s.state}${s.hooksDir ? `\nhooks dir: ${s.hooksDir}` : ''}${s.hooks && Object.keys(s.hooks).length
  ? '\n' + Object.entries(s.hooks).map(([n, st]) => `  ${n}: ${st}`).join('\n') : ''}`;

if (action === 'status') {
  const s = gitCaptureHookStatus(repo);
  console.log(describe(s));
  if (s.state === 'custom-hookspath') console.log('core.hooksPath is set — add the managed block to that hooks dir yourself, or unset it and re-run.');
  if (s.state === 'foreign') console.log('A non-sh hook occupies the slot — not touched. Chain it manually or convert it to sh.');
  process.exit(s.state === 'installed' ? 0 : 1);
} else if (action === 'install') {
  const r = installGitCaptureHook(repo);
  if (!r.ok) { console.error(`Not installed: ${r.reason}.`); process.exit(1); }
  console.log(r.changed.length ? `Installed/updated: ${r.changed.join(', ')} in ${r.hooksDir}` : 'Already current — nothing to change.');
  if (r.skipped.length) console.log(`Skipped (non-sh foreign hook, not touched): ${r.skipped.join(', ')}`);
  process.exit(0);
} else {
  const r = removeGitCaptureHook(repo);
  if (!r.ok) { console.error(`Nothing removed: ${r.reason}.`); process.exit(1); }
  console.log(r.changed.length ? `Removed the managed block from: ${r.changed.join(', ')}` : 'No managed block found — nothing to remove.');
  process.exit(0);
}
