// git-capture-install — wire the agent-neutral commit-capture hook
// (brain-git-hook.mjs) into a repo's git hooks, so rationale-bearing
// feat/fix/perf commits card into ./brain.klypix from ANY agent (Cursor, Cline,
// Codex, a human terminal), on ANY branch — at commit time. The hook installs
// into the COMMON hooks dir, so it fires in linked worktrees too, but its
// runtime SKIPS ephemeral checkouts (linked worktrees / OS-temp trees) and
// quiet trees by default — see brain-quiet.mjs (opt a worktree back in with
// KLYPIX_BRAIN_WORKTREE_CAPTURE=1).
//
// Why this exists (2026-08-07 field diagnosis): brain-git-hook.mjs shipped for
// months but was installed NOWHERE — the desktop's installer path had zero UI
// call sites and no CLI verb existed. The only live commit capture was the
// Claude Code Stop hook, which walks `prev..HEAD` in the session's checkout —
// commits authored on another worktree's branch were invisible to it (the
// AgentLit `94b0b6b` incident). A post-commit hook fires in whatever worktree
// the commit happens in, closing worktree, branch, AND foreign-agent blindness
// with the SAME high-signal gates (feat|fix|perf + rationale body ≥ 12 chars)
// — this is NOT blind auto-capture.
//
// Contract: never touch a hook we don't own. Our lines live between marker
// comments; a foreign non-sh hook is reported, not modified. Removal is exact:
// only the managed block goes.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOOK_NAMES = ['post-commit', 'post-merge'];
const MARK_START = '# >>> klypix-brain capture >>>';
const MARK_END = '# <<< klypix-brain capture <<<';

const gitOut = (repoDir, args) => {
  try {
    return execFileSync('git', args, {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    }).trim();
  } catch { return null; }
};

// Prefer the machine-global deployed engine (stable across repo moves and the
// path every other brain component already runs from); fall back to the sibling
// copy for repo-checkout use. An EPHEMERAL npx cache is never an acceptable
// target: the path is baked into a hook that must keep working for years, and
// npm evicts the cache — the hook would silently stop capturing (review-caught).
const EPHEMERAL_RE = /[\\/](_npx|_cacache|npm-cache[\\/]_)/i;
export function resolveHookScript(home = os.homedir()) {
  const deployed = path.join(home, '.claude', 'project-brain', 'brain-git-hook.mjs');
  if (fs.existsSync(deployed)) return deployed;
  const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), 'brain-git-hook.mjs');
  if (fs.existsSync(sibling) && !EPHEMERAL_RE.test(sibling)) return sibling;
  return null;   // nothing durable to point at — callers report 'no-engine'
}

// Single-quote for sh: immune to $, backticks and double quotes in the path
// (review-caught: a metacharacter path was an sh-injection into an every-commit
// hook). Embedded single quotes use the standard '\'' dance.
const shq = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

function managedBlock(hookScript) {
  const script = shq(hookScript);
  return [
    `${MARK_START} (managed by klypix-mcp — remove: npx klypix-mcp git-hook remove)`,
    // [ -f ]: an uninstalled/evicted engine bundle degrades to a silent no-op
    // instead of per-commit stderr noise (review-caught). command -v: a GUI git
    // client without node on PATH must not fail the commit. No cwd argument:
    // git runs hooks from the top of the CURRENT working tree and node's own
    // process.cwd() is a proper native path in every sh flavor — passing
    // "$(pwd)" handed node an MSYS/POSIX path under some git-for-windows setups.
    `[ -f ${script} ] && command -v node >/dev/null 2>&1 && node ${script} || true`,
    MARK_END,
  ].join('\n');
}

// `git-hook remove` writes this marker so SessionStart auto-install respects
// the human's decision instead of silently re-wiring next session
// (review-caught: remove didn't stick). Explicit install clears it.
const OPTOUT_REL = path.join('.claude', 'git-capture-optout');
export function gitCaptureOptedOut(repoDir) {
  return fs.existsSync(path.join(repoDir, OPTOUT_REL));
}

function hookFileState(file, hookScript) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { state: 'absent', raw: null }; }
  if (raw.includes(MARK_START)) {
    const current = raw.includes(managedBlock(hookScript));
    return { state: current ? 'ours' : 'ours-stale', raw };
  }
  const firstLine = raw.split('\n', 1)[0] || '';
  const shCompatible = !firstLine.startsWith('#!') || /\b(sh|bash|dash|zsh)\b/.test(firstLine);
  return { state: shCompatible ? 'foreign-sh' : 'foreign', raw };
}

const canonDir = (p) => {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return path.resolve(p); }
};

export function gitCaptureHookStatus(repoDir, { home = os.homedir() } = {}) {
  const commonDir = gitOut(repoDir, ['rev-parse', '--git-common-dir']);
  if (!commonDir) return { state: 'no-git', hooks: {} };
  if (gitOut(repoDir, ['config', 'core.hooksPath'])) return { state: 'custom-hookspath', hooks: {} };
  // Containment: the hook runs from the worktree TOP and looks for
  // ./brain.klypix there. A brain nested deeper in a larger repo can never be
  // captured by this hook — installing would mutate the enclosing repo's hooks
  // for nothing and report a false green (review-caught).
  const top = gitOut(repoDir, ['rev-parse', '--show-toplevel']);
  if (top && canonDir(top) !== canonDir(repoDir)) return { state: 'nested-brain', hooks: {}, worktreeTop: top };
  const hooksDir = path.resolve(repoDir, commonDir, 'hooks');
  const hookScript = resolveHookScript(home);
  // No durable engine path to bake into a hook (running straight from an npx
  // cache with no installed bundle) — say so rather than wiring a hook that
  // dies at the next cache eviction.
  if (!hookScript) return { state: 'no-engine', hooksDir, hookScript: null, hooks: {} };
  const hooks = {};
  for (const name of HOOK_NAMES) hooks[name] = hookFileState(path.join(hooksDir, name), hookScript).state;
  const states = Object.values(hooks);
  const state = states.every((s) => s === 'ours') ? 'installed'
    : states.some((s) => s === 'foreign') ? 'foreign'
      : states.every((s) => s === 'absent') ? 'absent'
        : 'partial';
  return { state, hooksDir, hookScript, hooks };
}

// Install or refresh the managed block. Foreign sh-compatible hooks get the
// block APPENDED (their lines run first, ours never exits non-zero); foreign
// non-sh hooks are skipped and reported. Idempotent.
export function installGitCaptureHook(repoDir, { home = os.homedir() } = {}) {
  const status = gitCaptureHookStatus(repoDir, { home });
  if (['no-git', 'custom-hookspath', 'nested-brain', 'no-engine'].includes(status.state)) {
    return { ok: false, reason: status.state, changed: [], skipped: [] };
  }
  // Explicit install = the human opting back in — clear any remove-marker.
  try { fs.unlinkSync(path.join(repoDir, OPTOUT_REL)); } catch { /* none */ }
  const block = managedBlock(status.hookScript);
  const changed = [], skipped = [];
  fs.mkdirSync(status.hooksDir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(status.hooksDir, name);
    const { state, raw } = hookFileState(file, status.hookScript);
    let next = null;
    if (state === 'absent') next = `#!/bin/sh\n${block}\n`;
    else if (state === 'ours-stale') {
      next = raw.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
      if (!next.includes(block)) next = null;   // markers mangled — refuse to guess
    } else if (state === 'foreign-sh') next = raw.replace(/\n*$/, '\n') + block + '\n';
    else if (state === 'foreign') { skipped.push(name); continue; }
    if (next === null) { if (state !== 'ours') skipped.push(name); continue; }
    // LF endings are load-bearing: git's sh rejects CRLF shebangs.
    fs.writeFileSync(file, next.replace(/\r\n/g, '\n'), 'utf8');
    try { fs.chmodSync(file, 0o755); } catch { /* Windows — irrelevant */ }
    changed.push(name);
  }
  return { ok: true, changed, skipped, hooksDir: status.hooksDir };
}

export function removeGitCaptureHook(repoDir, { home = os.homedir() } = {}) {
  const status = gitCaptureHookStatus(repoDir, { home });
  if (!status.hooksDir) return { ok: false, reason: status.state, changed: [] };
  // Make the removal STICK: SessionStart auto-install honors this marker, so a
  // human's `git-hook remove` is a durable decision, not a one-session pause.
  try {
    fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, OPTOUT_REL),
      'The commit-capture git hook was removed on purpose (npx klypix-mcp git-hook remove).\n'
      + 'Sessions will NOT auto-reinstall it while this file exists. Opt back in: npx klypix-mcp git-hook install\n');
  } catch { /* marker is best-effort; removal below still happens */ }
  const changed = [];
  for (const name of HOOK_NAMES) {
    const file = path.join(status.hooksDir, name);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!raw.includes(MARK_START)) continue;
    const stripped = raw.replace(new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`), '\n');
    const residue = stripped.replace(/^#!\/bin\/sh\n?/, '').trim();
    if (residue) fs.writeFileSync(file, stripped, 'utf8');
    else fs.unlinkSync(file);   // nothing but our scaffold — leave no husk
    changed.push(name);
  }
  return { ok: true, changed };
}

// Session-start convenience: install when safe (fresh repo or our own stale
// block), refresh silently, and NEVER touch a foreign hook — that case is left
// for doctor to surface. Returns a one-line notice only on a real transition.
//
// Consent posture: this writes an executable file into the repo's .git/hooks
// without a prompt, so it is deliberately bounded — only files we fully own,
// only a repo whose top holds this brain, a one-line announcement on the first
// install, a removal that STICKS (.claude/git-capture-optout), and a machine
// kill switch (KLYPIX_GIT_CAPTURE=0) for anyone who wants none of it.
export function ensureGitCaptureHook(repoDir, { home = os.homedir(), env = process.env } = {}) {
  if (/^(0|false|off|no)$/i.test(String(env?.KLYPIX_GIT_CAPTURE || ''))) {
    return { changed: false, state: 'disabled', notice: '' };
  }
  if (gitCaptureOptedOut(repoDir)) return { changed: false, state: 'opted-out', notice: '' };
  const status = gitCaptureHookStatus(repoDir, { home });
  if (['installed', 'no-git', 'custom-hookspath', 'nested-brain', 'no-engine'].includes(status.state)) {
    return { changed: false, state: status.state, notice: '' };
  }
  // Auto-install writes only files we fully own: every target must be absent or
  // carry our markers. ANY foreign hook (even sh-compatible) defers to the
  // explicit CLI — silently editing someone's custom hook is not a session
  // side-effect. `npx klypix-mcp git-hook install` chains those deliberately.
  if (Object.values(status.hooks).some((s) => s === 'foreign' || s === 'foreign-sh')) {
    return { changed: false, state: status.state, notice: '' };
  }
  const firstInstall = Object.values(status.hooks).every((s) => s === 'absent');
  const res = installGitCaptureHook(repoDir, { home });
  if (!res.ok || !res.changed.length) return { changed: false, state: status.state, notice: '' };
  return {
    changed: true,
    state: 'installed',
    notice: firstInstall
      ? '\n🔧 Installed the git commit-capture hook (post-commit/post-merge) — rationale-bearing feat/fix/perf commits from ANY agent, branch, or worktree now card into the brain. Remove: `npx klypix-mcp git-hook remove`.'
      : '',
  };
}
