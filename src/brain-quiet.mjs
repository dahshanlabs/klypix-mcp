// brain-quiet — ONE opt-out that every automatic brain writer honors.
//
// Field diagnosis (2026-08-18): four independent writers can touch a checkout's
// files without a human asking — the git commit-capture hook, the Claude Stop
// capture, the AGENTS.md brief/managed-block projection, and the auto-update
// harness reconcile. Each had at best its own partial switch
// (KLYPIX_GIT_CAPTURE only gates the INSTALLER, not the hook run), so an
// ephemeral release worktree got its brain.klypix appended to and its AGENTS.md
// restamped mid-build — a dirty tree that broke a real desktop release.
//
// This module is the single decision every writer asks:
//   • KLYPIX_BRAIN_QUIET=1  → quiet (env always wins; =0 force-disables the marker)
//   • a `.klypix-brain-quiet` file in the project root → quiet
// Quiet means: reads are allowed, ALL writes into that checkout are skipped
// silently with a single debug line. Nothing else changes.
//
// It also answers "is this checkout ephemeral?" for the writers that must not
// treat a linked git worktree or an OS-temp-dir tree as an independent project
// (commit capture, registry registration). Detection is fail-open: no git, an
// odd layout, or any error reads as a NORMAL project — behavior for normal
// projects is byte-identical.
//
// Deliberately dependency-free and synchronous so the sync writers
// (registerProjectBrain, linkProject) can consult it, and cheap for the hot
// paths: a main checkout (`.git` is a DIRECTORY) is classified with zero
// subprocesses; only a `.git` FILE (worktree or submodule) pays one short git
// call to tell the two apart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const QUIET_ENV = 'KLYPIX_BRAIN_QUIET';
export const QUIET_MARKER = '.klypix-brain-quiet';
export const WORKTREE_OVERRIDE_ENV = 'KLYPIX_BRAIN_WORKTREE_CAPTURE';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * Is this checkout quiet? { quiet, source: 'env' | 'marker' | null }.
 * Env wins in BOTH directions: =1 forces quiet, =0 overrides a marker file
 * (so one shell can act on a tree whose marker other processes keep honoring).
 * Never throws.
 */
export function brainQuiet({ projectDir = process.cwd(), env = process.env } = {}) {
  const raw = String(env?.[QUIET_ENV] ?? '').trim().toLowerCase();
  if (TRUTHY.has(raw)) return { quiet: true, source: 'env' };
  if (FALSY.has(raw)) return { quiet: false, source: 'env' };
  try {
    if (fs.existsSync(path.join(path.resolve(String(projectDir || '.')), QUIET_MARKER))) {
      return { quiet: true, source: 'marker' };
    }
  } catch { /* unreadable dir → not quiet (fail-open) */ }
  return { quiet: false, source: null };
}

const norm = (p) => {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Is this path the OS temp dir or inside it? Pure string check, never throws. */
export function isTempPath(p, { tmpdir = os.tmpdir() } = {}) {
  if (!p) return false;
  const target = norm(p);
  const temp = norm(tmpdir);
  return target === temp || target.startsWith(temp + path.sep);
}

/**
 * Is this directory a LINKED git worktree (not the main checkout)?
 * Fast path: `.git` as a directory ⇒ main checkout, zero subprocesses.
 * `.git` as a file ⇒ worktree or submodule — ask git: a linked worktree's
 * --git-dir differs from its --git-common-dir; a submodule's do not.
 * Any failure ⇒ false (fail-open: treat as a normal project).
 */
export function isLinkedWorktree(projectDir) {
  const dir = path.resolve(String(projectDir || '.'));
  let stat;
  try { stat = fs.statSync(path.join(dir, '.git')); } catch { return false; } // not a repo root
  if (stat.isDirectory()) return false;                                       // main checkout
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    const [gitDir, commonDir] = out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!gitDir || !commonDir) return false;
    return norm(path.resolve(dir, gitDir)) !== norm(path.resolve(dir, commonDir));
  } catch { return false; }
}

/**
 * Should ephemeral-checkout writers (commit capture, registry registration)
 * skip this tree? Ephemeral ⇔ linked worktree OR under the OS temp dir —
 * unless KLYPIX_BRAIN_WORKTREE_CAPTURE=1 declares the tree a real project.
 * Returns { ephemeral, reason: 'linked-worktree' | 'temp-dir' | null }.
 */
export function ephemeralCheckout({ projectDir = process.cwd(), env = process.env, tmpdir = os.tmpdir() } = {}) {
  if (TRUTHY.has(String(env?.[WORKTREE_OVERRIDE_ENV] ?? '').trim().toLowerCase())) {
    return { ephemeral: false, reason: null };
  }
  try {
    if (isTempPath(projectDir, { tmpdir })) return { ephemeral: true, reason: 'temp-dir' };
    if (isLinkedWorktree(projectDir)) return { ephemeral: true, reason: 'linked-worktree' };
  } catch { /* fail-open */ }
  return { ephemeral: false, reason: null };
}

/** The one-line breadcrumb quiet/ephemeral skips print. Never throws. */
export function quietSkipLine(what, why) {
  const hint = why === 'env' ? `${QUIET_ENV}=1`
    : why === 'marker' ? QUIET_MARKER
      : why === 'temp-dir' ? 'OS temp dir'
        : why === 'linked-worktree' ? `linked worktree (opt in: ${WORKTREE_OVERRIDE_ENV}=1)`
          : String(why || 'quiet');
  return `[brain] quiet: skipped ${what} (${hint})\n`;
}
