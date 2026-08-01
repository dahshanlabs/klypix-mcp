// Cross-process advisory write lock shared by the MCP/A2A engine, desktop app,
// and lifecycle hooks. Atomic rename prevents torn ZIPs; this prevents two
// independent processes from both reading one base and letting the last rename
// erase the first writer's update.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STALE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function brainCaptureLockPath(brainPath) {
  const dir = path.dirname(path.resolve(brainPath));
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch { /* path.resolve fallback */ }
  return path.join(real, '.claude', 'brain-capture.lock');
}

async function acquire(lockPath, { tries, waitMs, staleMs }) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* reported as unlocked below */ }
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, token, 'utf8');
      fs.closeSync(fd);
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* another process changed the lock; retry normally */ }
      await wait(waitMs);
    }
  }
  return null;
}

const stillOwned = (lockPath, token) => {
  try { return fs.readFileSync(lockPath, 'utf8') === token; }
  catch { return false; }
};

/**
 * Run fn(locked) with exclusive ownership of lockPath. The callback always
 * runs so the CALLER chooses its failure policy; every brain mutation caller
 * must refuse when locked=false. Token-checked heartbeat/release means a stale
 * owner can never unlink a successor's lock after losing ownership.
 */
export async function withAdvisoryWriteLock(lockPath, fn, options = {}) {
  const tries = Number(options.tries) > 0 ? Number(options.tries) : 60;
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 60;
  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : DEFAULT_STALE_MS;
  const heartbeatMs = Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : DEFAULT_HEARTBEAT_MS;
  const token = await acquire(lockPath, { tries, waitMs, staleMs });
  let heartbeat = null;
  if (token) {
    heartbeat = setInterval(() => {
      if (!stillOwned(lockPath, token)) return;
      try { const now = new Date(); fs.utimesSync(lockPath, now, now); } catch { /* next owner/check detects it */ }
    }, heartbeatMs);
    heartbeat.unref?.();
  }
  try { return await fn(!!token); }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    if (token && stillOwned(lockPath, token)) {
      try { fs.unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
    }
  }
}

export function vaultCreateLockPath(vault) {
  return path.join(path.resolve(vault), '.klypix-create.lock');
}
