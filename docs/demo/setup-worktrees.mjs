#!/usr/bin/env node
// Seeds the fictional demo repository (through setup.mjs) and adds ONE linked
// git worktree to it, for docs/demo/demo-worktrees.tape: Session A works in the
// primary checkout, Session B in the worktree, both declare src/auth/token.ts,
// and B receives the server's genuine exact-file-overlap heads-up — across two
// checkouts, because every linked worktree of a repository resolves to the one
// lane its primary checkout uses (agent-presence.mjs worktreeLaneIdentity
// follows git's commondir).
//
// Same public-asset rule as setup.mjs: "aurora" is fictional; nothing on screen
// is a real project or a real filename.
//
// Usage: node docs/demo/setup-worktrees.mjs [dir]
//   dir defaults to ./.demo-repo (gitignored); the worktree is created at
//   <dir>/.worktrees/rate-limits on branch feat/rate-limiting. Prints both paths.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const dir = path.resolve(process.argv[2] || path.join(repoRoot, '.demo-repo'));
execFileSync(process.execPath, [path.join(here, 'setup.mjs'), dir], { stdio: ['ignore', 'ignore', 'inherit'] });

const worktree = path.join(dir, '.worktrees', 'rate-limits');
fs.mkdirSync(path.dirname(worktree), { recursive: true });
// The worktree folder lives inside the primary checkout (the layout coding
// agents use); keep the primary's status clean without touching its tree.
fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.worktrees/\n');
execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/rate-limiting', worktree], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });

console.log(dir);
console.log(worktree);
