// Git fixture helpers for the coordination bench. Every repo lives in a fresh
// directory under os.tmpdir(); nothing here touches a real project.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  // A condition that changed nothing must leave no trace: an empty "other
  // session touched the notes" commit is a cue the agent could read.
  const commitIfChanged = (message) => { git('add', '-A'); if (!git('status', '--porcelain')) return null; git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { dir, git, write, read, commitAll, commitIfChanged, remove };
}

/**
 * Run a small ESM snippet against a module of the repo and capture stdout —
 * graders judge BEHAVIOUR with it (how many times a sender was called, what a
 * formatter returned) instead of grepping the agent's source for words.
 * `body` runs with the imported module bound to `m` and must write to stdout.
 */
export const PROBE_MARK = '@@KLYPIX_PROBE@@';
export function runNodeProbe(dir, moduleRel, body, { timeoutMs = 30_000 } = {}) {
  const url = pathToFileURL(path.join(dir, moduleRel)).href;
  // The module under test runs in this process, so anything it prints must
  // never be read as the grader's answer (one console.log inside a retry loop
  // used to turn a call count into NaN). Console is silenced before the
  // import, and the body reports ONCE through __out(value): a marked line
  // that only the last marker counts for.
  const code = [
    "for (const k of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table']) console[k] = () => {};",
    `const __out = (v) => process.stdout.write('\\n' + ${JSON.stringify(PROBE_MARK)} + JSON.stringify(v) + '\\n');`,
    `import(${JSON.stringify(url)}).then(async (m) => { ${body} }).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });`,
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: timeoutMs });
  const out = String(r.stdout || '');
  const at = out.lastIndexOf(PROBE_MARK);
  let value; let found = false;
  if (at >= 0) { try { value = JSON.parse(out.slice(at + PROBE_MARK.length).split('\n')[0]); found = true; } catch { found = false; } }
  return { ok: r.status === 0 && found, value, stderr: String(r.stderr || '').slice(-500) };
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
