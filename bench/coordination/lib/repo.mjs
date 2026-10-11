// Git fixture helpers for the coordination bench. Every repo lives in a fresh
// directory under os.tmpdir(); nothing here touches a real project.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeTreeConflicts } from '../../../src/repo-state.mjs';

export function makeRepo(prefix = 'klypix-cobench-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { git('init', '-q', '-b', 'main'); } catch { git('init', '-q'); git('checkout', '-q', '-b', 'main'); }
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
  const commitAll = (message) => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { dir, git, write, read, commitAll, remove };
}

/** Run `node --test` on the given files inside the repo; returns { pass, output }. */
export function runNodeTests(dir, files, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8', timeout: timeoutMs });
  return { pass: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) };
}

/**
 * Test-merge two branches with the same primitive KLYPIX uses. A grader is not
 * a live sync: it waits as long as git needs (the sync's 1.5 s budget would
 * turn a slow machine into a false "no verdict").
 */
export function mergeConflictFiles(dir, branchA, branchB) {
  const res = mergeTreeConflicts(dir, branchA, branchB, { timeoutMs: 60_000 });
  return res ? res.files : null;
}

/** Commit whatever the agent left in the working tree, so its work is a branch tip. */
export function commitAgentWork(repo, message = 'agent work') {
  try { return repo.commitAll(message); } catch { return null; }
}
