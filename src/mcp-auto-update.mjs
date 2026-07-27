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
//   - runtime-only install: no host settings or project files are rewritten;
//   - installer commits .mcp-runtime.json last; the supervisor validates and
//     compatibility-gates the worker before a zero-restart hot-swap;
//   - offline, registry, npm, or filesystem failures are fail-open.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { spawn } from 'child_process';

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
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
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
  };
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
  };
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
      child = spawnProcess('npx', ['-y', `klypix-mcp@${version}`, 'install', '--runtime-only'], {
        cwd: brainDir,
        env: {
          ...process.env,
          KLYPIX_MCP_INSTALL_DIR: brainDir,
          KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
        },
        stdio: 'ignore',
        shell: process.platform === 'win32',
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
        atomicJson(files.status, status);
        return { checked: true, ...status };
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
        atomicJson(files.status, status);
        return { checked: true, ...status };
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
      atomicJson(files.status, status);
      return { checked: true, ...status };
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
