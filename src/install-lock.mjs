import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const INSTALL_LOCK_FILENAME = '.install.lock';

const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};

function readLock(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const value = JSON.parse(raw);
    return { raw, value, mtimeMs: fs.statSync(lockFile).mtimeMs };
  } catch {
    try { return { raw: null, value: null, mtimeMs: fs.statSync(lockFile).mtimeMs }; }
    catch { return null; }
  }
}

function processAppearsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function lockOwnerPid(observed) {
  const structured = Number(observed?.value?.pid);
  if (Number.isInteger(structured) && structured > 0) return structured;
  const legacy = Number(String(observed?.raw || '').split(':', 1)[0]);
  return Number.isInteger(legacy) && legacy > 0 ? legacy : null;
}

function removeIfStillStale(lockFile, observed, now, staleMs) {
  if (!observed || now - Number(observed.value?.acquiredAt || observed.mtimeMs || now) <= staleMs) return false;
  const ownerPid = lockOwnerPid(observed);
  if (ownerPid && processAppearsAlive(ownerPid)) return false;
  const abandoned = `${lockFile}.abandoned-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const current = readLock(lockFile);
    if (!current || current.raw !== observed.raw || current.mtimeMs !== observed.mtimeMs) return false;
    fs.renameSync(lockFile, abandoned);
    const moved = readLock(abandoned);
    if (!moved || moved.raw !== observed.raw || moved.mtimeMs !== observed.mtimeMs) {
      if (!fs.existsSync(lockFile)) fs.renameSync(abandoned, lockFile);
      return false;
    }
    fs.unlinkSync(abandoned);
    return true;
  } catch { return false; }
}

export function acquireInstallLockSync(brainDir, { tries = 120, waitMs = 50, staleMs = 300_000 } = {}) {
  const lockFile = path.join(brainDir, INSTALL_LOCK_FILENAME);
  const token = `${process.pid}:${crypto.randomUUID()}`;
  try { fs.mkdirSync(brainDir, { recursive: true }); } catch { /* reported by open below */ }
  for (let attempt = 0; attempt < tries; attempt++) {
    let fd = null;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ protocol: 1, pid: process.pid, token, acquiredAt: Date.now() }));
      } finally { fs.closeSync(fd); fd = null; }
      return { lockFile, token };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* */ }
        try { fs.unlinkSync(lockFile); } catch { /* */ }
      }
      if (error?.code !== 'EEXIST') return null;
      if (removeIfStillStale(lockFile, readLock(lockFile), Date.now(), staleMs)) continue;
      sleepSync(waitMs);
    }
  }
  return null;
}

export function releaseInstallLockSync(lock) {
  if (!lock?.lockFile || !lock?.token) return false;
  const released = `${lock.lockFile}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const current = readLock(lock.lockFile);
    if (current?.value?.token !== lock.token) return false;
    fs.renameSync(lock.lockFile, released);
    const moved = readLock(released);
    if (moved?.value?.token === lock.token) {
      fs.unlinkSync(released);
      return true;
    }
    if (!fs.existsSync(lock.lockFile)) fs.renameSync(released, lock.lockFile);
    return false;
  } catch { return false; }
}
