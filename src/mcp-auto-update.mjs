// Host-neutral automatic updates for the standalone KLYPIX MCP runtime.
//
// Every MCP host starts the same stable supervisor. The supervisor launches this
// helper out-of-band, so update discovery never delays or breaks the stdio
// connection. A machine-wide stamp and lock make many concurrent Codex, Claude,
// Cursor, Cline, or generic MCP sessions behave like one updater.
//
// Safety contract:
//   - default on, with KLYPIX_AUTO_UPDATE=0|off|false|no as the explicit opt-out;
//   - one registry check per machine per 24 hours;
//   - stable, same-major releases only (a new major requires a manual install);
//   - npm installs an exact version and verifies the package's registry integrity;
//   - runtime installation is isolated; only after verification do we reconcile
//     KLYPIX-managed blocks/config entries in registered brain projects;
//   - project reconciliation preserves non-KLYPIX content, is per-file isolated,
//     and never turns a harness failure into a broken MCP runtime;
//   - installer commits .mcp-runtime.json last; the supervisor validates and
//     compatibility-gates the worker before a zero-restart hot-swap;
//   - offline, registry, npm, or filesystem failures are fail-open.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { brainQuiet, ephemeralCheckout, isTempPath } from './brain-quiet.mjs';

export const AUTO_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;
export const AUTO_UPDATE_WORKER_ARG = '--klypix-auto-update-worker';

const strictSemver = (value) => /^\d+\.\d+\.\d+$/.test(String(value || '').trim());
const parseSemver = (value) => {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
};
const compareSemver = (a, b) => {
  const aa = parseSemver(a), bb = parseSemver(b);
  if (!aa || !bb) return null;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
};
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged / already moved */ }
    throw error;
  }
};
const cleanError = (error) => String(error?.message || error || 'unknown error')
  .replace(/[\r\n]+/g, ' ')
  .slice(0, 240);

export function autoUpdateEnabled(env = process.env) {
  const value = String(env.KLYPIX_AUTO_UPDATE ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(value);
}

export function autoUpdatePaths(brainDir = path.join(os.homedir(), '.claude', 'project-brain')) {
  const root = path.resolve(brainDir);
  return {
    brainDir: root,
    stamp: path.join(root, '.autoupdate-check.json'),
    status: path.join(root, '.autoupdate-status.json'),
    lock: path.join(root, '.autoupdate.lock'),
    runtime: path.join(root, '.mcp-runtime.json'),
    version: path.join(root, '.brain-version.json'),
    registry: path.join(root, 'registry.json'),
    registryLock: path.join(root, '.registry.lock'),
  };
}

const normalizeBrainPath = (value) => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Register a project from any MCP host, not only Claude's lifecycle hook.
 * The small lock + atomic replace prevents concurrent brain_sync calls from
 * losing one another's projects. Failure is deliberately non-fatal: the next
 * task start retries registration.
 */
export function registerProjectBrain({
  brainPath,
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  now = Date.now(),
  env = process.env,
} = {}) {
  const candidate = path.resolve(String(brainPath || ''));
  if (!['brain.klypix', 'brain.any'].includes(path.basename(candidate).toLowerCase())) {
    return { registered: false, reason: 'invalid-brain-path' };
  }
  try {
    if (!fs.statSync(candidate).isFile()) return { registered: false, reason: 'missing-brain' };
  } catch { return { registered: false, reason: 'missing-brain' }; }
  // A quiet or ephemeral checkout is not an independent project (2026-08-18):
  // release worktrees self-registered on SessionStart until the machine
  // registry held ~20 throwaway entries, and the reconcile then write-touched
  // every one of them. Skips are marked `skipped: true` so callers with a
  // legacy fallback path know the refusal was deliberate, not a failure.
  // KLYPIX_BRAIN_WORKTREE_CAPTURE=1 opts a long-lived worktree back in.
  const projectDir = path.dirname(candidate);
  const quiet = brainQuiet({ projectDir, env });
  if (quiet.quiet) return { registered: false, skipped: true, reason: 'quiet' };
  const eph = ephemeralCheckout({ projectDir, env });
  if (eph.ephemeral) return { registered: false, skipped: true, reason: eph.reason };

  const files = autoUpdatePaths(brainDir);
  let token = null;
  for (let attempt = 0; attempt < 20 && !token; attempt++) {
    token = acquireLock(files.registryLock, Date.now(), 10_000);
    if (!token) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } catch { /* retry */ }
    }
  }
  if (!token) return { registered: false, reason: 'busy' };
  try {
    const current = readJson(files.registry) || { brains: [] };
    const byPath = new Map();
    for (const item of Array.isArray(current.brains) ? current.brains : []) {
      if (!item?.path) continue;
      const key = normalizeBrainPath(item.path);
      const prior = byPath.get(key);
      if (!prior || Number(item.lastSeen || 0) >= Number(prior.lastSeen || 0)) {
        byPath.set(key, { ...prior, ...item, path: path.resolve(item.path) });
      }
    }
    const key = normalizeBrainPath(candidate);
    byPath.set(key, {
      ...(byPath.get(key) || {}),
      path: candidate,
      project: path.basename(path.dirname(candidate)),
      lastSeen: now,
    });
    const brains = [...byPath.values()]
      .filter((item) => {
        try { return fs.statSync(item.path).isFile(); } catch { return false; }
      })
      .sort((a, b) => Number(a.lastSeen || 0) - Number(b.lastSeen || 0))
      .slice(-200);
    atomicJson(files.registry, { ...current, brains });
    return { registered: true, brainPath: candidate, projects: brains.length };
  } catch (error) {
    return { registered: false, reason: cleanError(error) };
  } finally {
    releaseLock(files.registryLock, token);
  }
}

export function readRegisteredProjectBrains(brainDir = path.join(os.homedir(), '.claude', 'project-brain')) {
  const registry = readJson(autoUpdatePaths(brainDir).registry);
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(registry?.brains) ? registry.brains : []) {
    if (!item?.path) continue;
    const brainPath = path.resolve(item.path);
    const key = normalizeBrainPath(brainPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ brainPath, projectDir: path.dirname(brainPath), project: item.project || path.basename(path.dirname(brainPath)) });
  }
  return out;
}

async function loadInstalledAgentRules(brainDir, version) {
  const file = path.join(path.resolve(brainDir), 'agent-rules.mjs');
  if (!fs.existsSync(file)) throw new Error('installed agent-rules.mjs is missing');
  // Query-bust because this helper may have loaded the pre-update module before
  // the installer atomically replaced it. The newly verified runtime must
  // project its own instructions, never the prior version's cached module.
  return import(`${pathToFileURL(file).href}?harness=${encodeURIComponent(version || 'current')}-${Date.now()}`);
}

/**
 * Registry hygiene (2026-08-18): drop entries whose brain no longer exists or
 * whose project sits in the OS temp dir — throwaway checkouts must not keep a
 * durable registry row (or a reconcile visit) after registration stopped
 * accepting them. Locked + atomic like every other registry write; a busy lock
 * simply skips pruning until the next pass (fail-open).
 */
export function pruneRegisteredProjects({
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  now = Date.now(),
  env = process.env,
} = {}) {
  const files = autoUpdatePaths(brainDir);
  // KLYPIX_BRAIN_WORKTREE_CAPTURE=1 declares this machine's temp trees real
  // projects — keep their rows too, or every pass would prune what the next
  // sync re-registers. Missing brains are always pruned.
  const keepTemp = ['1', 'true', 'on', 'yes'].includes(String(env?.KLYPIX_BRAIN_WORKTREE_CAPTURE ?? '').trim().toLowerCase());
  const prunable = (item) => {
    if (!item?.path) return true;
    if (!keepTemp && isTempPath(path.dirname(path.resolve(item.path)))) return true;
    try { return !fs.statSync(path.resolve(item.path)).isFile(); } catch { return true; }
  };
  const current = readJson(files.registry);
  const brains = Array.isArray(current?.brains) ? current.brains : [];
  if (!brains.some(prunable)) return { pruned: 0 };
  const token = acquireLock(files.registryLock, now, 10_000);
  if (!token) return { pruned: 0, reason: 'busy' };
  try {
    const locked = readJson(files.registry) || {};
    const lockedBrains = Array.isArray(locked.brains) ? locked.brains : [];
    const kept = lockedBrains.filter((item) => !prunable(item));
    if (kept.length !== lockedBrains.length) atomicJson(files.registry, { ...locked, brains: kept });
    return { pruned: lockedBrains.length - kept.length };
  } catch (error) {
    return { pruned: 0, reason: cleanError(error) };
  } finally {
    releaseLock(files.registryLock, token);
  }
}

/** Reconcile every registered project (or an explicit brain subset). */
export async function reconcileRegisteredProjects({
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  version = null,
  brainPaths = null,
  rules = null,
  env = process.env,
} = {}) {
  const requested = Array.isArray(brainPaths)
    ? brainPaths.map((brainPath) => ({
      brainPath: path.resolve(brainPath),
      projectDir: path.dirname(path.resolve(brainPath)),
      project: path.basename(path.dirname(path.resolve(brainPath))),
    }))
    : readRegisteredProjectBrains(brainDir);
  // Registry-driven passes also prune dead/temp rows on sight, so the machine
  // registry converges instead of accumulating one entry per throwaway tree.
  const pruneReceipt = Array.isArray(brainPaths) ? null : pruneRegisteredProjects({ brainDir, env });
  const unique = [];
  const seen = new Set();
  for (const item of requested.slice(0, 200)) {
    const key = normalizeBrainPath(item.brainPath);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const summary = { checked: unique.length, updated: 0, unchanged: 0, failed: 0, skipped: 0, projects: [] };
  if (pruneReceipt?.pruned) summary.pruned = pruneReceipt.pruned;
  if (!unique.length) return summary;
  let projector;
  try { projector = rules || await loadInstalledAgentRules(brainDir, version); }
  catch (error) {
    summary.failed = unique.length;
    summary.projects = unique.map((item) => ({ project: item.project, status: 'failed', error: cleanError(error) }));
    return summary;
  }

  for (const item of unique) {
    const brainName = path.basename(item.brainPath).toLowerCase();
    const projectLock = path.join(
      path.resolve(brainDir),
      '.harness-locks',
      `${crypto.createHash('sha1').update(normalizeBrainPath(item.brainPath)).digest('hex').slice(0, 16)}.lock`,
    );
    let projectToken = null;
    try {
      if (!['brain.klypix', 'brain.any'].includes(brainName) || !fs.statSync(item.brainPath).isFile()) {
        summary.skipped++;
        summary.projects.push({ project: item.project, status: 'skipped', reason: 'brain-missing' });
        continue;
      }
      // Never write-touch a quiet or ephemeral checkout (2026-08-18): a release
      // worktree restamped by this pass mid-build dirtied the tree and broke a
      // real desktop release. Quiet = KLYPIX_BRAIN_QUIET=1 or a
      // .klypix-brain-quiet marker in the project root (env wins); ephemeral =
      // linked git worktree or OS-temp tree. Reads elsewhere are unaffected.
      const quiet = brainQuiet({ projectDir: item.projectDir, env });
      if (quiet.quiet) {
        summary.skipped++;
        summary.projects.push({ project: item.project, status: 'skipped', reason: 'quiet' });
        continue;
      }
      const eph = ephemeralCheckout({ projectDir: item.projectDir, env });
      if (eph.ephemeral) {
        summary.skipped++;
        summary.projects.push({ project: item.project, status: 'skipped', reason: eph.reason });
        continue;
      }
      for (let attempt = 0; attempt < 20 && !projectToken; attempt++) {
        projectToken = acquireLock(projectLock, Date.now(), 2 * 60 * 1000);
        if (!projectToken) {
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch { /* retry */ }
        }
      }
      if (!projectToken) {
        summary.skipped++;
        summary.projects.push({ project: item.project, status: 'skipped', reason: 'busy' });
        continue;
      }
      const before = projector.auditProject(item.projectDir, { version });
      if (before.ok) {
        summary.unchanged++;
        summary.projects.push({ project: item.project, status: 'unchanged' });
        continue;
      }
      const written = projector.linkProject(item.projectDir, { version });
      if (typeof projector.compactAgentsBrief === 'function') {
        await projector.compactAgentsBrief(item.projectDir);
      }
      const after = projector.auditProject(item.projectDir, { version });
      const changed = [...written.rules, ...written.mcp]
        .filter((entry) => !['unchanged', 'skipped'].includes(entry.action)).length;
      if (!after.ok) {
        summary.failed++;
        summary.projects.push({
          project: item.project,
          status: 'partial',
          changed,
          drift: after.drift.map((entry) => ({ file: entry.file, status: entry.status, why: entry.why })).slice(0, 20),
        });
      } else {
        summary.updated++;
        summary.projects.push({ project: item.project, status: 'updated', changed });
      }
    } catch (error) {
      summary.failed++;
      summary.projects.push({ project: item.project, status: 'failed', error: cleanError(error) });
    } finally {
      if (projectToken) releaseLock(projectLock, projectToken);
    }
  }
  return summary;
}

export function readInstalledRuntime(brainDir, fallbackVersion = null) {
  const files = autoUpdatePaths(brainDir);
  const runtime = readJson(files.runtime);
  const stamp = readJson(files.version);
  const runtimeVersion = strictSemver(runtime?.version) ? String(runtime.version) : null;
  const stampedVersion = strictSemver(stamp?.brainVersion || stamp?.appVersion)
    ? String(stamp.brainVersion || stamp.appVersion)
    : null;
  return {
    version: runtimeVersion || stampedVersion || (strictSemver(fallbackVersion) ? String(fallbackVersion) : null),
    managed: runtime?.protocol === 1 && !!runtimeVersion,
    dev: runtime?.dev === true || stamp?.dev === true,
    channel: runtime?.channel || stamp?.via || null,
  };
}

export function inspectAutoUpdate(brainDir, { now = Date.now(), env = process.env } = {}) {
  const files = autoUpdatePaths(brainDir);
  const stamp = readJson(files.stamp);
  const status = readJson(files.status);
  const lastCheck = Number(stamp?.lastCheck);
  const enabled = autoUpdateEnabled(env);
  const dueAt = Number.isFinite(lastCheck) ? lastCheck + AUTO_UPDATE_TTL_MS : null;
  return {
    enabled,
    lastCheck: Number.isFinite(lastCheck) ? lastCheck : null,
    lastCheckAt: Number.isFinite(lastCheck) ? new Date(lastCheck).toISOString() : null,
    due: enabled && (!Number.isFinite(lastCheck) || now >= dueAt),
    dueAt: dueAt ? new Date(dueAt).toISOString() : null,
    result: status?.result || null,
    currentVersion: status?.currentVersion || null,
    latestVersion: status?.latestVersion || null,
    installedVersion: status?.installedVersion || null,
    lastUpdatedAt: status?.lastUpdatedAt || null,
    error: status?.error || null,
    harness: status?.harness || null,
  };
}

/**
 * Start the detached updater when this machine is due.
 *
 * Safe to call from both the stable supervisor and the replaceable worker:
 * the shared stamp prevents unnecessary children and the helper lock collapses
 * the remaining cross-process race.
 */
export function spawnAutoUpdateHelper({
  brainDir = path.join(os.homedir(), '.claude', 'project-brain'),
  currentVersion = null,
  env = process.env,
  spawnProcess = spawn,
} = {}) {
  if (!autoUpdateEnabled(env) || env.KLYPIX_MCP_AUTO_UPDATE_CHILD === '1') return null;
  if (!inspectAutoUpdate(brainDir, { env }).due) return null;
  try {
    const helper = fileURLToPath(import.meta.url);
    const child = spawnProcess(process.execPath, [helper, AUTO_UPDATE_WORKER_ARG], {
      // Do not hold the managed directory as this detached process's cwd.
      // This matters for ephemeral/test homes on Windows and is cleaner for
      // uninstallers; the installer receives its exact target through env.
      cwd: os.tmpdir(),
      env: {
        ...env,
        KLYPIX_MCP_AUTO_UPDATE_DIR: path.resolve(brainDir),
        KLYPIX_MCP_AUTO_UPDATE_CURRENT: String(currentVersion || ''),
        KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => { /* fail-open: the MCP transport remains healthy */ });
    child.unref();
    return child;
  } catch { return null; }
}

function acquireLock(lockFile, now, staleMs = AUTO_UPDATE_LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ protocol: 1, token, pid: process.pid, acquiredAt: now }));
      fs.closeSync(fd);
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      try {
        const lock = readJson(lockFile);
        const acquiredAt = Number(lock?.acquiredAt || fs.statSync(lockFile).mtimeMs);
        if ((now - acquiredAt) > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch { /* raced with another helper */ }
      return null;
    }
  }
  return null;
}

function releaseLock(lockFile, token) {
  try {
    const lock = readJson(lockFile);
    if (lock?.token === token) fs.unlinkSync(lockFile);
  } catch { /* a stale-lock recovery may already have removed it */ }
}

export function fetchLatestStableVersion({
  timeoutMs = 8000,
  request = https.get,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = request('https://registry.npmjs.org/klypix-mcp/latest', {
      headers: {
        accept: 'application/json',
        'user-agent': 'klypix-mcp-auto-update',
      },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 128 * 1024) req.destroy(new Error('npm registry response was too large'));
      });
      response.on('end', () => {
        try {
          const version = JSON.parse(body)?.version;
          if (!strictSemver(version)) throw new Error(`invalid stable version ${JSON.stringify(version)}`);
          resolve(String(version));
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`npm registry timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

export function installExactRuntime(version, {
  brainDir,
  timeoutMs = 10 * 60 * 1000,
  spawnProcess = spawn,
} = {}) {
  if (!strictSemver(version)) return Promise.reject(new Error(`refusing invalid update version ${JSON.stringify(version)}`));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    let child;
    try {
      let command = 'npx';
      let args = ['-y', `klypix-mcp@${version}`, 'install', '--runtime-only'];
      if (process.platform === 'win32') {
        // .cmd files require a shell on Windows, but Node 24 correctly warns
        // that shell:true concatenates arguments. Invoke npm's JS entry with
        // this exact Node binary instead: no quoting ambiguity, no shell, and
        // the strict-semver gate above leaves no command-injection surface.
        const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
        if (fs.existsSync(npxCli)) {
          command = process.execPath;
          args = [npxCli, ...args];
        } else {
          // Portable fallback for unusual Windows Node layouts. The only
          // interpolated value is strict x.y.z semver.
          command = process.env.ComSpec || 'cmd.exe';
          args = ['/d', '/s', '/c', `npx -y klypix-mcp@${version} install --runtime-only`];
        }
      }
      child = spawnProcess(command, args, {
        cwd: brainDir,
        env: {
          ...process.env,
          KLYPIX_MCP_INSTALL_DIR: brainDir,
          KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
        },
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* */ }
      finish(new Error(`npm install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`npm installer exited ${code ?? signal ?? 'unknown'}`));
    });
  });
}

/**
 * Run one serialized update check.
 *
 * The fetch/install functions are injectable so the full policy can be tested
 * without touching a user's machine or contacting npm.
 */
export async function runAutoUpdateCheck({
  brainDir = process.env.KLYPIX_MCP_AUTO_UPDATE_DIR
    || path.join(os.homedir(), '.claude', 'project-brain'),
  currentVersion = process.env.KLYPIX_MCP_AUTO_UPDATE_CURRENT || null,
  enabled = autoUpdateEnabled(),
  force = process.env.KLYPIX_AUTO_UPDATE_FORCE === '1',
  now = Date.now(),
  ttlMs = AUTO_UPDATE_TTL_MS,
  fetchLatest = fetchLatestStableVersion,
  installVersion = installExactRuntime,
  reconcileProjects = reconcileRegisteredProjects,
} = {}) {
  const files = autoUpdatePaths(brainDir);
  if (!enabled) return { checked: false, result: 'disabled' };

  const prior = readJson(files.stamp);
  const priorCheck = Number(prior?.lastCheck);
  if (!force && Number.isFinite(priorCheck) && (now - priorCheck) < ttlMs) {
    return { checked: false, result: 'throttled', lastCheck: priorCheck };
  }

  const token = acquireLock(files.lock, now);
  if (!token) return { checked: false, result: 'busy' };
  try {
    // Another helper may have completed between the first read and lock acquisition.
    const lockedPrior = readJson(files.stamp);
    const lockedPriorCheck = Number(lockedPrior?.lastCheck);
    if (!force && Number.isFinite(lockedPriorCheck) && (now - lockedPriorCheck) < ttlMs) {
      return { checked: false, result: 'throttled', lastCheck: lockedPriorCheck };
    }

    const installed = readInstalledRuntime(files.brainDir, currentVersion);
    const checkedAt = new Date(now).toISOString();
    atomicJson(files.stamp, { protocol: 1, lastCheck: now, checkedAt });

    const finalize = async (status, harnessVersion) => {
      let harness;
      try {
        harness = await reconcileProjects({
          brainDir: files.brainDir,
          version: harnessVersion || installed.version,
        });
      } catch (error) {
        harness = {
          checked: 0,
          updated: 0,
          unchanged: 0,
          failed: 1,
          skipped: 0,
          projects: [],
          error: cleanError(error),
        };
      }
      const complete = { ...status, harness };
      atomicJson(files.status, complete);
      return { checked: true, ...complete };
    };

    if (installed.dev) {
      const status = {
        protocol: 1,
        result: 'dev-owned',
        checkedAt,
        currentVersion: installed.version,
      };
      atomicJson(files.status, status);
      return { checked: true, ...status };
    }

    try {
      const latestVersion = await fetchLatest();
      if (!strictSemver(latestVersion)) throw new Error(`registry returned invalid stable version ${JSON.stringify(latestVersion)}`);
      const comparison = installed.version ? compareSemver(latestVersion, installed.version) : null;
      const currentMajor = parseSemver(installed.version)?.[0];
      const latestMajor = parseSemver(latestVersion)?.[0];

      if (installed.managed && currentMajor != null && latestMajor !== currentMajor) {
        const status = {
          protocol: 1,
          result: 'major-blocked',
          checkedAt,
          currentVersion: installed.version,
          latestVersion,
          error: `major update v${installed.version} → v${latestVersion} requires a manual install`,
        };
        return finalize(status, installed.version);
      }

      // A direct-package launch bootstraps a managed runtime when it is equal
      // to or behind npm. A local package newer than the registry is a
      // development/pre-publish run and must never be silently downgraded.
      const needsInstall = installed.managed
        ? comparison === null || comparison > 0
        : comparison === null || comparison >= 0;
      if (!needsInstall) {
        const status = {
          protocol: 1,
          result: comparison < 0 ? 'ahead' : 'current',
          checkedAt,
          currentVersion: installed.version,
          latestVersion,
        };
        return finalize(status, installed.version);
      }

      await installVersion(latestVersion, { brainDir: files.brainDir });
      const verified = readInstalledRuntime(files.brainDir);
      if (!verified.managed || compareSemver(verified.version, latestVersion) !== 0) {
        throw new Error(`installer completed but managed runtime is v${verified.version || 'unknown'}, expected v${latestVersion}`);
      }
      const completedAt = new Date().toISOString();
      const status = {
        protocol: 1,
        result: installed.managed ? 'updated' : 'bootstrapped',
        checkedAt,
        currentVersion: installed.version,
        latestVersion,
        installedVersion: verified.version,
        lastUpdatedAt: completedAt,
      };
      return finalize(status, verified.version);
    } catch (error) {
      const status = {
        protocol: 1,
        result: 'failed',
        checkedAt,
        currentVersion: installed.version,
        error: cleanError(error),
      };
      atomicJson(files.status, status);
      return { checked: true, ...status };
    }
  } finally {
    releaseLock(files.lock, token);
  }
}

if (process.argv.includes(AUTO_UPDATE_WORKER_ARG)) {
  await runAutoUpdateCheck();
}

export const __test = {
  compareSemver,
  strictSemver,
  acquireLock,
  releaseLock,
};
