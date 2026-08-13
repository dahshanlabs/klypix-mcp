import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_DESCRIPTOR_PATH = path.join(os.homedir(), '.klypix', 'remote-relay', 'desktop.json');

const PROVIDERS = new Set([
  'antigravity-agent', 'claude-code', 'codex', 'cursor-agent', 'gemini-cli',
  'grok-build', 'kimi-code', 'opencode', 'pi', 'qoder', 'mistral-vibe', 'unknown',
]);
const OPERATIONS = new Set([
  'send-text', 'send-message', 'attach-image', 'attach-file', 'interrupt',
  'approve', 'reject', 'close', 'archive', 'resume', 'open-provider',
]);
const ACTIVE_BINDING_OPERATIONS = new Set([
  'send-text', 'send-message', 'attach-image', 'attach-file', 'interrupt',
  'approve', 'reject', 'close', 'archive', 'resume',
]);
const ATTACHMENT_KINDS = new Set(['image', 'video', 'audio', 'document', 'file']);
const HARD_COMMAND_CACHE_LIMIT = 4096;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 100 * 1024 * 1024;
const HARD_SNAPSHOT_BYTE_BUDGET = 256 * 1024 * 1024;
const HARD_SNAPSHOT_ENTRY_LIMIT = 64;
const HARD_ACTION_TOMBSTONE_LIMIT = 8192;
const RETIRED_ACTION_FILTER_BYTES = 128 * 1024;
const SNAPSHOT_TTL_MS = 60_000;

function testOnlyLimit(name, hardLimit) {
  if (process.env.NODE_ENV !== 'test') return hardLimit;
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= hardLimit ? parsed : hardLimit;
}

// Tests may only LOWER these hard production limits, and only in a fresh
// NODE_ENV=test process. The seam cannot expand resource authority.
const SNAPSHOT_BYTE_BUDGET = testOnlyLimit(
  'KLYPIX_REMOTE_TEST_SNAPSHOT_BYTE_BUDGET', HARD_SNAPSHOT_BYTE_BUDGET,
);
const SNAPSHOT_ENTRY_LIMIT = testOnlyLimit(
  'KLYPIX_REMOTE_TEST_SNAPSHOT_ENTRY_LIMIT', HARD_SNAPSHOT_ENTRY_LIMIT,
);
const ACTION_TOMBSTONE_LIMIT = testOnlyLimit(
  'KLYPIX_REMOTE_TEST_ACTION_TOMBSTONE_LIMIT', HARD_ACTION_TOMBSTONE_LIMIT,
);
const COMMAND_CACHE_LIMIT = testOnlyLimit(
  'KLYPIX_REMOTE_TEST_COMMAND_CACHE_LIMIT', HARD_COMMAND_CACHE_LIMIT,
);
const commandCache = new Map();
const actionTombstones = new Map();
const retiredActionFilter = new Uint8Array(RETIRED_ACTION_FILTER_BYTES);
const orphanedSnapshotCleanups = new Set();
let snapshotBytesReserved = 0;
let snapshotEntriesReserved = 0;
let snapshotRoot = null;
let snapshotRootIdentity = null;
let snapshotExitHookInstalled = false;

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function realDirectory(value, code = 'KLYPIX_REMOTE_PROJECT_ROOT_INVALID') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || !path.isAbsolute(value)) {
    throw new Error(code);
  }
  try {
    const resolved = fs.realpathSync.native(value);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(code);
    return resolved;
  } catch (error) {
    if (error?.message === code) throw error;
    throw new Error(code);
  }
}

function boundProjectRoot(value) {
  const root = realDirectory(value);
  const bound = ['brain.klypix', 'brain.any'].some((name) => {
    try {
      const brain = fs.lstatSync(path.join(root, name));
      return brain.isFile() && !brain.isSymbolicLink();
    } catch { return false; }
  });
  if (!bound) throw new Error('KLYPIX_REMOTE_PROJECT_NOT_BOUND');
  return root;
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function retiredActionBits(actionIdentity) {
  const digest = createHash('sha256')
    .update('klypix-remote-retired-action:')
    .update(actionIdentity)
    .digest();
  const bitCount = RETIRED_ACTION_FILTER_BYTES * 8;
  return [0, 4, 8, 12].map((offset) => digest.readUInt32BE(offset) % bitCount);
}

function addRetiredAction(actionIdentity) {
  for (const bit of retiredActionBits(actionIdentity)) {
    retiredActionFilter[Math.floor(bit / 8)] |= 1 << (bit % 8);
  }
}

function mayBeRetiredAction(actionIdentity) {
  return retiredActionBits(actionIdentity).every((bit) => (
    retiredActionFilter[Math.floor(bit / 8)] & (1 << (bit % 8))
  ) !== 0);
}

function retireActionIdentity(actionIdentity, signature, code) {
  addRetiredAction(actionIdentity);
  if (actionTombstones.has(actionIdentity)) return;
  if (actionTombstones.size >= ACTION_TOMBSTONE_LIMIT) {
    actionTombstones.delete(actionTombstones.keys().next().value);
  }
  actionTombstones.set(actionIdentity, Object.freeze({ signature, code }));
}

function retiredActionError(actionIdentity) {
  const exact = actionTombstones.get(actionIdentity);
  if (exact) return exact.code;
  return mayBeRetiredAction(actionIdentity) ? 'KLYPIX_REMOTE_ACTION_RETIRED' : null;
}

function releaseSnapshotReservation(reservation) {
  if (!reservation || reservation.released) return;
  if (snapshotBytesReserved < reservation.bytes || snapshotEntriesReserved < 1) {
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_ACCOUNTING_INVALID');
  }
  reservation.released = true;
  snapshotBytesReserved -= reservation.bytes;
  snapshotEntriesReserved -= 1;
}

function snapshotRootState() {
  if (!snapshotRoot || !snapshotRootIdentity) return 'missing';
  try {
    const stat = fs.lstatSync(snapshotRoot, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      && sameFileObject(stat, snapshotRootIdentity) ? 'bound' : 'invalid';
  } catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'invalid'; }
}

function snapshotRootIsBound() {
  return snapshotRootState() === 'bound';
}

function removeSnapshotDirectory(directory) {
  const rootState = snapshotRootState();
  if (typeof directory !== 'string') return false;
  if (rootState === 'missing') {
    try { fs.lstatSync(directory); return false; }
    catch (error) { return error?.code === 'ENOENT'; }
  }
  if (rootState !== 'bound'
      || comparablePath(directory) === comparablePath(snapshotRoot)
      || !isWithinDirectory(snapshotRoot, directory)) return false;
  try {
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { return error?.code === 'ENOENT'; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    // Snapshot directories are made non-writable after construction. Restore
    // owner write permission only for their authenticated cleanup path.
    try { fs.chmodSync(directory, 0o700); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    try {
      fs.lstatSync(directory);
      return false;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }
  catch { return false; }
}

function cleanupCommandCacheEntry(
  actionIdentity,
  entry = commandCache.get(actionIdentity),
  retireCode = null,
) {
  if (!entry) return true;
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  const removed = !entry.snapshotDirectory || removeSnapshotDirectory(entry.snapshotDirectory);
  if (!removed) {
    // Keep the cache entry and reservation charged. A short unref'ed retry can
    // recover transient Windows handles; until then no byte authority is freed.
    entry.cleanupTimer = setTimeout(() => cleanupCommandCacheEntry(
      actionIdentity, entry, retireCode,
    ), 1_000);
    entry.cleanupTimer.unref?.();
    if (retireCode) retireActionIdentity(actionIdentity, entry.signature, retireCode);
    return false;
  }
  if (commandCache.get(actionIdentity) === entry) commandCache.delete(actionIdentity);
  releaseSnapshotReservation(entry.snapshotReservation);
  if (retireCode) retireActionIdentity(actionIdentity, entry.signature, retireCode);
  return true;
}

function retainOrphanedSnapshotCleanup(directory, reservation) {
  if (!directory || !reservation || reservation.released) return;
  const orphan = { directory, reservation, cleanupTimer: null };
  const retry = () => {
    if (removeSnapshotDirectory(directory)) {
      orphanedSnapshotCleanups.delete(orphan);
      releaseSnapshotReservation(reservation);
      return;
    }
    orphan.cleanupTimer = setTimeout(retry, 1_000);
    orphan.cleanupTimer.unref?.();
  };
  orphanedSnapshotCleanups.add(orphan);
  orphan.cleanupTimer = setTimeout(retry, 1_000);
  orphan.cleanupTimer.unref?.();
}

function retryOrphanedSnapshotCleanups() {
  for (const orphan of [...orphanedSnapshotCleanups]) {
    if (!removeSnapshotDirectory(orphan.directory)) continue;
    if (orphan.cleanupTimer) clearTimeout(orphan.cleanupTimer);
    orphanedSnapshotCleanups.delete(orphan);
    releaseSnapshotReservation(orphan.reservation);
  }
  return orphanedSnapshotCleanups.size === 0;
}

function cleanupAllSnapshots(retireCode = null) {
  let allEntriesRemoved = true;
  for (const [actionIdentity, entry] of commandCache) {
    if (entry.snapshotReservation
        && !cleanupCommandCacheEntry(actionIdentity, entry, retireCode)) allEntriesRemoved = false;
  }
  if (!retryOrphanedSnapshotCleanups()) allEntriesRemoved = false;
  const root = snapshotRoot;
  if (!root) return true;
  if (!allEntriesRemoved) return false;
  const rootState = snapshotRootState();
  if (rootState === 'missing') {
    snapshotRoot = null;
    snapshotRootIdentity = null;
    return true;
  }
  if (rootState !== 'bound') return false;
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }); }
  catch { return false; }
  try {
    fs.lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      snapshotRoot = null;
      snapshotRootIdentity = null;
      return true;
    }
  }
  return false;
}

function ensureSnapshotRoot(projectRoot) {
  if (snapshotRoot) {
    if (!snapshotRootIsBound()) {
      // Never rotate to a new root while paths or reservations owned by the
      // previous root remain. That would make cleanup unreachable.
      if (!cleanupAllSnapshots('KLYPIX_REMOTE_ACTION_INVALID')) {
        throw new Error('KLYPIX_REMOTE_SNAPSHOT_CLEANUP_FAILED');
      }
    }
  }
  if (!snapshotRoot) {
    const randomPrefix = `klypix-mcp-remote-${randomBytes(24).toString('hex')}-`;
    const created = fs.mkdtempSync(path.join(os.tmpdir(), randomPrefix));
    try {
      fs.chmodSync(created, 0o700);
      const stat = fs.lstatSync(created);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid');
      snapshotRoot = fs.realpathSync.native(created);
      snapshotRootIdentity = fs.lstatSync(snapshotRoot, { bigint: true });
    } catch {
      try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* best effort */ }
      if (snapshotRoot && comparablePath(snapshotRoot) === comparablePath(created)) {
        snapshotRoot = null;
        snapshotRootIdentity = null;
      }
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_ROOT_INVALID');
    }
    if (!snapshotExitHookInstalled) {
      snapshotExitHookInstalled = true;
      process.once('exit', () => cleanupAllSnapshots());
    }
  }
  if (isWithinDirectory(projectRoot, snapshotRoot)) {
    if (!cleanupAllSnapshots('KLYPIX_REMOTE_ACTION_INVALID')) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_CLEANUP_FAILED');
    }
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_ROOT_INVALID');
  }
  return snapshotRoot;
}

function oldestSnapshotCacheEntry() {
  for (const [actionIdentity, entry] of commandCache) {
    if (entry.snapshotReservation && !entry.snapshotReservation.released) {
      return { actionIdentity, entry };
    }
  }
  return null;
}

function reserveSnapshotResources(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > SNAPSHOT_BYTE_BUDGET) {
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT');
  }
  retryOrphanedSnapshotCleanups();
  while (snapshotEntriesReserved >= SNAPSHOT_ENTRY_LIMIT
      || snapshotBytesReserved + bytes > SNAPSHOT_BYTE_BUDGET) {
    const oldest = oldestSnapshotCacheEntry();
    if (!oldest) throw new Error('KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT');
    if (!cleanupCommandCacheEntry(
      oldest.actionIdentity, oldest.entry, 'KLYPIX_REMOTE_ACTION_EVICTED',
    )) throw new Error('KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT');
  }
  if (snapshotEntriesReserved >= SNAPSHOT_ENTRY_LIMIT
      || snapshotBytesReserved + bytes > SNAPSHOT_BYTE_BUDGET) {
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT');
  }
  const reservation = { bytes, released: false };
  snapshotBytesReserved += bytes;
  snapshotEntriesReserved += 1;
  return reservation;
}

function createSnapshotDirectory(projectRoot) {
  const root = ensureSnapshotRoot(projectRoot);
  for (let attempt = 0; attempt < 4; attempt++) {
    const directory = path.join(root, randomBytes(24).toString('hex'));
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      const canonical = fs.realpathSync.native(directory);
      if (!isWithinDirectory(root, canonical) || isWithinDirectory(projectRoot, canonical)) {
        removeSnapshotDirectory(canonical);
        throw new Error('KLYPIX_REMOTE_SNAPSHOT_ROOT_INVALID');
      }
      return canonical;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      const partialExists = (() => {
        try { fs.lstatSync(directory); return true; } catch { return false; }
      })();
      if (partialExists && !removeSnapshotDirectory(directory)) {
        const cleanupError = new Error('KLYPIX_REMOTE_SNAPSHOT_CLEANUP_FAILED');
        Object.defineProperty(cleanupError, 'snapshotDirectory', { value: directory });
        throw cleanupError;
      }
      if (error?.message === 'KLYPIX_REMOTE_SNAPSHOT_ROOT_INVALID') throw error;
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_CREATE_FAILED');
    }
  }
  throw new Error('KLYPIX_REMOTE_SNAPSHOT_CREATE_FAILED');
}

function identityKey(identity) {
  if (!identity
      || typeof identity.machineId !== 'string' || identity.machineId.length < 1
      || !PROVIDERS.has(identity.provider)
      || typeof identity.externalSessionId !== 'string' || identity.externalSessionId.length < 1) return null;
  return JSON.stringify([identity.machineId, identity.provider, identity.externalSessionId]);
}

function scopedSession(session, projectRoot) {
  const localPath = session?.project?.localPath;
  const projectId = session?.project?.projectId;
  if (typeof localPath !== 'string' || typeof projectId !== 'string' || !projectId.startsWith('local:')) return false;
  try {
    const canonicalLocalPath = realDirectory(localPath, 'KLYPIX_REMOTE_SESSION_PROJECT_INVALID');
    return projectId === `local:${comparablePath(canonicalLocalPath)}`
      && isWithinDirectory(projectRoot, canonicalLocalPath)
      && identityKey(session.identity) !== null;
  } catch {
    return false;
  }
}

async function projectSessions(projectRoot, requestOptions) {
  const parsed = await requestRemote('GET', '/v1/sessions', undefined, requestOptions);
  if (!Array.isArray(parsed.sessions)) throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
  return parsed.sessions.filter((session) => scopedSession(session, projectRoot));
}

function stableCommandId(namespace, actionIdentity) {
  const identity = typeof actionIdentity === 'string' ? actionIdentity.trim() : '';
  if (!identity || identity.length > 512 || /[\u0000-\u001f]/.test(identity)) {
    throw new Error('KLYPIX_REMOTE_ACTION_IDENTITY_INVALID');
  }
  const digest = createHash('sha256')
    .update(`klypix-remote-command:${namespace}:`)
    .update(identity)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function normalizedActionIdentity(actionIdentity) {
  const identity = typeof actionIdentity === 'string' ? actionIdentity.trim() : '';
  // Validation stays centralized in stableCommandId so all command-derived ids
  // use exactly the same accepted identity grammar.
  stableCommandId('validate', identity);
  return identity;
}

function sameFileObject(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.ino !== BigInt(0);
}

function sourceVersion(stat) {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  });
}

function sameSourceVersion(first, second) {
  return sameFileObject(first, second)
    && first.size === second.size
    && first.birthtimeNs === second.birthtimeNs
    && first.ctimeNs === second.ctimeNs
    && first.mtimeNs === second.mtimeNs;
}

function openContainedAttachment(sourcePath, projectRoot) {
  if (!path.isAbsolute(sourcePath)) throw new Error('KLYPIX_REMOTE_ATTACHMENT_PATH_INVALID');
  if (!isWithinDirectory(projectRoot, path.resolve(sourcePath))) {
    throw new Error('KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try { descriptor = fs.openSync(sourcePath, flags); }
  catch { throw new Error('KLYPIX_REMOTE_ATTACHMENT_INVALID'); }
  try {
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorStat.isFile() || descriptorStat.ino === BigInt(0)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_INVALID');
    }
    if (descriptorStat.size <= 0n || descriptorStat.size > BigInt(MAX_ATTACHMENT_BYTES)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_SIZE_INVALID');
    }
    const namedStat = fs.lstatSync(sourcePath, { bigint: true });
    if (namedStat.isSymbolicLink() || !namedStat.isFile() || !sameFileObject(descriptorStat, namedStat)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
    const resolvedPath = fs.realpathSync.native(sourcePath);
    if (!isWithinDirectory(projectRoot, resolvedPath)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT');
    }
    const resolvedStat = fs.lstatSync(resolvedPath, { bigint: true });
    if (resolvedStat.isSymbolicLink() || !resolvedStat.isFile()
        || !sameFileObject(descriptorStat, resolvedStat)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
    return { descriptor, sourcePath, resolvedPath, projectRoot, descriptorStat };
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* already invalid */ }
    if (String(error?.message ?? '').startsWith('KLYPIX_REMOTE_')) throw error;
    throw new Error('KLYPIX_REMOTE_ATTACHMENT_INVALID');
  }
}

function assertSourceStillBound(source) {
  try {
    const descriptorStat = fs.fstatSync(source.descriptor, { bigint: true });
    if (!sameSourceVersion(source.descriptorStat, descriptorStat)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
    const namedStat = fs.lstatSync(source.sourcePath, { bigint: true });
    if (namedStat.isSymbolicLink() || !namedStat.isFile()
        || !sameFileObject(descriptorStat, namedStat)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
    const resolvedPath = fs.realpathSync.native(source.sourcePath);
    if (!isWithinDirectory(source.projectRoot, resolvedPath)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT');
    }
    if (comparablePath(resolvedPath) !== comparablePath(source.resolvedPath)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('KLYPIX_REMOTE_')) throw error;
    throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
  }
}

function readDescriptorContent(descriptor, writeChunk, byteLimit = MAX_ATTACHMENT_BYTES) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0 || byteLimit > MAX_ATTACHMENT_BYTES) {
    throw new Error('KLYPIX_REMOTE_ATTACHMENT_SIZE_INVALID');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  for (;;) {
    const remaining = byteLimit - total + 1;
    const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), total);
    if (count === 0) break;
    total += count;
    if (total > byteLimit) throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    if (writeChunk) writeChunk(buffer, count, total - count);
    hash.update(buffer.subarray(0, count));
  }
  if (total <= 0) throw new Error('KLYPIX_REMOTE_ATTACHMENT_SIZE_INVALID');
  return { byteSize: total, contentDigest: hash.digest('hex') };
}

function writeAll(descriptor, buffer, count, position) {
  let written = 0;
  while (written < count) {
    const next = fs.writeSync(descriptor, buffer, written, count - written, position + written);
    if (next <= 0) throw new Error('KLYPIX_REMOTE_SNAPSHOT_CREATE_FAILED');
    written += next;
  }
}

function snapshotAttachment(source, snapshotDirectory, index) {
  const snapshotPath = path.join(snapshotDirectory, `${index}-${randomBytes(24).toString('hex')}.snapshot`);
  let snapshotDescriptor;
  try {
    snapshotDescriptor = fs.openSync(snapshotPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    const expectedSize = Number(source.descriptorStat.size);
    const copied = readDescriptorContent(
      source.descriptor,
      (buffer, count, position) => writeAll(snapshotDescriptor, buffer, count, position),
      expectedSize,
    );
    assertSourceStillBound(source);
    const confirmed = readDescriptorContent(source.descriptor, undefined, expectedSize);
    assertSourceStillBound(source);
    if (confirmed.byteSize !== copied.byteSize || confirmed.contentDigest !== copied.contentDigest) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_CHANGED');
    }
    fs.fsyncSync(snapshotDescriptor);
    const snapshotReadback = readDescriptorContent(snapshotDescriptor, undefined, expectedSize);
    const snapshotStat = fs.fstatSync(snapshotDescriptor, { bigint: true });
    if (!snapshotStat.isFile() || snapshotStat.ino === BigInt(0)
        || snapshotStat.size !== BigInt(copied.byteSize)
        || snapshotReadback.byteSize !== copied.byteSize
        || snapshotReadback.contentDigest !== copied.contentDigest) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_CREATE_FAILED');
    }
    fs.chmodSync(snapshotPath, 0o400);
    fs.closeSync(snapshotDescriptor);
    snapshotDescriptor = undefined;
    return {
      path: snapshotPath,
      directory: snapshotDirectory,
      byteSize: copied.byteSize,
      contentDigest: copied.contentDigest,
      device: snapshotStat.dev.toString(),
      inode: snapshotStat.ino.toString(),
    };
  } catch (error) {
    if (snapshotDescriptor !== undefined) {
      try { fs.closeSync(snapshotDescriptor); } catch { /* preserve the original failure */ }
    }
    let partialRemoved = false;
    try {
      fs.unlinkSync(snapshotPath);
      partialRemoved = true;
    } catch (unlinkError) {
      if (unlinkError?.code === 'ENOENT') partialRemoved = true;
    }
    if (!partialRemoved) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_CLEANUP_FAILED');
    }
    if (String(error?.message ?? '').startsWith('KLYPIX_REMOTE_')) throw error;
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_CREATE_FAILED');
  }
}

function verifySnapshot(snapshot) {
  let descriptor;
  try {
    const stat = fs.lstatSync(snapshot.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
        || stat.dev.toString() !== snapshot.device || stat.ino.toString() !== snapshot.inode
        || stat.size !== BigInt(snapshot.byteSize)
        || (process.platform !== 'win32' && (Number(stat.mode) & 0o222) !== 0)) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_INVALID');
    }
    const canonical = fs.realpathSync.native(snapshot.path);
    if (!isWithinDirectory(snapshot.directory, canonical)
        || !snapshotRoot || !isWithinDirectory(snapshotRoot, canonical)) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_INVALID');
    }
    descriptor = fs.openSync(snapshot.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openStat = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileObject(stat, openStat)) throw new Error('KLYPIX_REMOTE_SNAPSHOT_INVALID');
    const content = readDescriptorContent(descriptor, undefined, snapshot.byteSize);
    if (content.byteSize !== snapshot.byteSize || content.contentDigest !== snapshot.contentDigest) {
      throw new Error('KLYPIX_REMOTE_SNAPSHOT_INVALID');
    }
  } catch (error) {
    if (error?.message === 'KLYPIX_REMOTE_SNAPSHOT_INVALID') throw error;
    throw new Error('KLYPIX_REMOTE_SNAPSHOT_INVALID');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* verification already completed */ }
    }
  }
}

function verifyCachedCommandSnapshots(actionIdentity) {
  const entry = commandCache.get(actionIdentity);
  if (!entry) throw new Error('KLYPIX_REMOTE_ACTION_INVALID');
  try { entry.snapshots.forEach(verifySnapshot); }
  catch (error) {
    cleanupCommandCacheEntry(actionIdentity, entry, 'KLYPIX_REMOTE_ACTION_INVALID');
    throw error;
  }
}

function cloneCommand(command) {
  return JSON.parse(JSON.stringify(command));
}

async function responseTooLarge(response, controller, reader) {
  controller.abort();
  try {
    if (reader) await reader.cancel('KLYPIX_REMOTE_RESPONSE_TOO_LARGE');
    else await response.body?.cancel('KLYPIX_REMOTE_RESPONSE_TOO_LARGE');
  } catch { /* abort already tore down the transport */ }
  throw new Error('KLYPIX_REMOTE_RESPONSE_TOO_LARGE');
}

async function readBoundedResponse(response, controller) {
  if (!response.body) return '';
  if (typeof response.body.getReader !== 'function') throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) await responseTooLarge(response, controller, reader);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function isProcessAlive(processId) {
  try { process.kill(processId, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function readBoundedDescriptor(descriptor) {
  const buffer = Buffer.allocUnsafe(MAX_DESCRIPTOR_BYTES + 1);
  let total = 0;
  for (;;) {
    const count = fs.readSync(
      descriptor, buffer, total, buffer.length - total, total,
    );
    if (count === 0) break;
    total += count;
    if (total > MAX_DESCRIPTOR_BYTES) throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  }
  if (total <= 0) throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  return Buffer.from(buffer.subarray(0, total));
}

function descriptorPathBinding(descriptorPath, descriptorStat) {
  const namedStat = fs.lstatSync(descriptorPath, { bigint: true });
  if (!namedStat.isFile() || namedStat.isSymbolicLink()
      || !sameFileObject(descriptorStat, namedStat)) {
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  }
  const canonicalPath = fs.realpathSync.native(descriptorPath);
  const canonicalStat = fs.lstatSync(canonicalPath, { bigint: true });
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()
      || !sameFileObject(descriptorStat, canonicalStat)) {
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  }
  return canonicalPath;
}

export function readRemoteDescriptor(descriptorPath = DEFAULT_DESCRIPTOR_PATH) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      descriptorPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  }
  try {
    const initialStat = fs.fstatSync(descriptor, { bigint: true });
    if (!initialStat.isFile() || initialStat.ino === BigInt(0)
        || initialStat.size <= BigInt(0)
        || initialStat.size > BigInt(MAX_DESCRIPTOR_BYTES)) {
      throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
    }
    const initialPath = descriptorPathBinding(descriptorPath, initialStat);
    const firstRead = readBoundedDescriptor(descriptor);
    const middleStat = fs.fstatSync(descriptor, { bigint: true });
    const secondRead = readBoundedDescriptor(descriptor);
    const finalStat = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = descriptorPathBinding(descriptorPath, finalStat);
    if (!sameSourceVersion(initialStat, middleStat)
        || !sameSourceVersion(initialStat, finalStat)
        || comparablePath(initialPath) !== comparablePath(finalPath)
        || !firstRead.equals(secondRead)) {
      throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
    }
    const value = JSON.parse(secondRead.toString('utf8'));
    if (value?.attachmentIntegrity !== undefined
        && value.attachmentIntegrity !== 'sha256-v1') {
      throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
    }
    if (value?.schema !== 1
        || !Number.isSafeInteger(value.processId) || value.processId <= 0
        || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535
        || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(value.token)
        || typeof value.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.instanceId)
        || !isProcessAlive(value.processId)) {
      throw new Error('KLYPIX_REMOTE_DESCRIPTOR_STALE');
    }
    return Object.freeze({ ...value, descriptorPath });
  } catch (error) {
    if (error instanceof SyntaxError
        || error?.message === 'KLYPIX_REMOTE_DESCRIPTOR_INVALID'
        || error?.message === 'KLYPIX_REMOTE_DESCRIPTOR_STALE') throw error;
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  } finally {
    try { fs.closeSync(descriptor); } catch { /* the descriptor is no longer usable */ }
  }
}

async function requestRemote(method, route, body, options = {}, beforeFetch = null) {
  let descriptor;
  try { descriptor = readRemoteDescriptor(options.descriptorPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('KLYPIX_DESKTOP_NOT_RUNNING');
    if (error instanceof SyntaxError) throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    beforeFetch?.(descriptor);
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${descriptor.port}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: encodedBody,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await responseTooLarge(response, controller);
    }
    const text = await readBoundedResponse(response, controller);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID'); }
    if (!response.ok || parsed?.ok !== true) throw new Error(String(parsed?.code || 'KLYPIX_REMOTE_REQUEST_REJECTED'));
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('KLYPIX_REMOTE_REQUEST_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function remoteStatus({ projectRoot, ...options } = {}) {
  boundProjectRoot(projectRoot);
  const status = (await requestRemote('GET', '/v1/status', undefined, options)).status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
  // The relay status is machine-global. Expose only operational health flags to
  // a project-scoped MCP; counts, warnings and paired-device identifiers could
  // reveal activity from unrelated projects or devices.
  return Object.freeze({
    serviceRunning: status.serviceRunning === true,
    trayResident: status.trayResident === true,
    localDiscovery: status.localDiscovery === true,
    providerHooks: status.providerHooks === true,
    providerHooksConfigured: status.providerHooksConfigured === true,
    remoteCommands: status.remoteCommands === true,
    networkRelay: status.networkRelay === true,
    contentSharing: status.contentSharing === true,
    paired: status.paired === true,
  });
}

export async function remoteSessions({ projectRoot, ...options } = {}) {
  return projectSessions(boundProjectRoot(projectRoot), options);
}

export async function remoteActions({ projectRoot, ...options } = {}) {
  const canonicalRoot = boundProjectRoot(projectRoot);
  const sessions = await projectSessions(canonicalRoot, options);
  const allowed = new Set(sessions.map((session) => identityKey(session.identity)).filter(Boolean));
  const parsed = await requestRemote('GET', '/v1/actions', undefined, options);
  if (!Array.isArray(parsed.actions)) throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
  return parsed.actions.filter((action) => {
    const key = identityKey(action?.identity);
    return key !== null && allowed.has(key);
  });
}

function resolveAttachments(attachments = [], projectRoot, actionIdentity, createSnapshots) {
  if (!Array.isArray(attachments) || attachments.length > 25) throw new Error('KLYPIX_REMOTE_ATTACHMENTS_INVALID');
  if (attachments.length === 0) {
    return {
      postedAttachments: [], fingerprints: [], snapshots: [],
      snapshotDirectory: null, snapshotReservation: null,
    };
  }
  const canonicalRoot = boundProjectRoot(projectRoot);
  let snapshotDirectory = null;
  let snapshotReservation = null;
  let total = 0;
  const sources = [];
  const postedAttachments = [];
  const fingerprints = [];
  const snapshots = [];
  try {
    attachments.forEach((attachment, index) => {
      if (!attachment || typeof attachment.path !== 'string' || !ATTACHMENT_KINDS.has(attachment.kind)) {
        throw new Error('KLYPIX_REMOTE_ATTACHMENT_INVALID');
      }
      const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType.length <= 128
        ? attachment.mimeType : 'application/octet-stream';
      const source = openContainedAttachment(attachment.path, canonicalRoot);
      source.index = index;
      source.kind = attachment.kind;
      source.mimeType = mimeType;
      source.fileName = path.basename(source.resolvedPath);
      sources.push(source);
      const expectedSize = Number(source.descriptorStat.size);
      total += expectedSize;
      if (total > MAX_ATTACHMENTS_BYTES) {
        throw new Error('KLYPIX_REMOTE_ATTACHMENTS_TOO_LARGE');
      }
    });

    if (createSnapshots) {
      // Reserve the full immutable footprint before creating or copying a
      // single byte. A growing source is bounded by its reserved fstat size.
      snapshotReservation = reserveSnapshotResources(total);
      snapshotDirectory = createSnapshotDirectory(canonicalRoot);
    }

    for (const source of sources) {
      const expectedSize = Number(source.descriptorStat.size);
        let content;
        let snapshot = null;
        if (createSnapshots) {
          snapshot = snapshotAttachment(source, snapshotDirectory, source.index);
          content = { byteSize: snapshot.byteSize, contentDigest: snapshot.contentDigest };
          snapshots.push(snapshot);
        } else {
          content = readDescriptorContent(source.descriptor, undefined, expectedSize);
          assertSourceStillBound(source);
        }
        const id = stableCommandId(`attachment-${source.index}`, actionIdentity);
        fingerprints.push({
          id,
          kind: source.kind,
          fileName: source.fileName,
          mimeType: source.mimeType,
          byteSize: content.byteSize,
          contentDigest: content.contentDigest,
          sourcePath: comparablePath(source.resolvedPath),
          sourceVersion: sourceVersion(source.descriptorStat),
        });
        if (snapshot) {
          postedAttachments.push({
            id,
            kind: source.kind,
            path: snapshot.path,
            fileName: source.fileName,
            mimeType: source.mimeType,
            byteSize: content.byteSize,
            contentDigest: content.contentDigest,
          });
        }
    }
    if (snapshotDirectory) fs.chmodSync(snapshotDirectory, 0o500);
    return {
      postedAttachments, fingerprints, snapshots, snapshotDirectory, snapshotReservation,
    };
  } catch (error) {
    const cleanupDirectory = snapshotDirectory ?? error?.snapshotDirectory ?? null;
    const removed = !cleanupDirectory || removeSnapshotDirectory(cleanupDirectory);
    if (removed) releaseSnapshotReservation(snapshotReservation);
    else retainOrphanedSnapshotCleanup(cleanupDirectory, snapshotReservation);
    throw error;
  } finally {
    for (const source of sources) {
      try { fs.closeSync(source.descriptor); } catch { /* validation owns the failure */ }
    }
  }
}

export function buildRemoteCommand(input, now = Date.now(), actionIdentity = input?.actionIdentity, projectRoot = input?.projectRoot) {
  if (!input || !PROVIDERS.has(input.provider) || !OPERATIONS.has(input.operation)) {
    throw new Error('KLYPIX_REMOTE_COMMAND_INVALID');
  }
  for (const [label, value, max] of [
    ['machine', input.machineId, 256], ['session', input.externalSessionId, 512],
    ['receipt', input.capabilityReceiptId, 256], ['binding', input.bindingId, 256],
  ]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`KLYPIX_REMOTE_${label.toUpperCase()}_INVALID`);
  }
  if (!Number.isSafeInteger(now)) throw new Error('KLYPIX_REMOTE_COMMAND_TIME_INVALID');
  const normalizedAction = normalizedActionIdentity(actionIdentity);
  const cached = commandCache.get(normalizedAction);
  const retired = retiredActionError(normalizedAction);
  if (retired) throw new Error(retired);
  const canonicalRoot = projectRoot === undefined ? null : boundProjectRoot(projectRoot);
  if (cached?.command.expiresAt <= now) {
    cleanupCommandCacheEntry(normalizedAction, cached, 'KLYPIX_REMOTE_ACTION_EXPIRED');
    throw new Error('KLYPIX_REMOTE_ACTION_EXPIRED');
  }
  let resolvedAttachments;
  let snapshotRetained = false;
  try {
    resolvedAttachments = resolveAttachments(input.attachments, canonicalRoot, normalizedAction, !cached);
    const id = stableCommandId('id', normalizedAction);
    const idempotencyKey = stableCommandId('idempotency', normalizedAction);
    const payload = {};
    const signaturePayload = {};
    if (typeof input.text === 'string') {
      payload.text = input.text;
      signaturePayload.text = input.text;
    }
    if (resolvedAttachments.postedAttachments.length) {
      payload.attachments = resolvedAttachments.postedAttachments;
    }
    if (resolvedAttachments.fingerprints.length) {
      signaturePayload.attachments = resolvedAttachments.fingerprints;
    }
    if (input.replaceDraft !== undefined) {
      payload.replaceDraft = input.replaceDraft;
      signaturePayload.replaceDraft = input.replaceDraft;
    }
    const stableBase = {
      id,
      idempotencyKey,
      identity: {
        machineId: input.machineId,
        provider: input.provider,
        externalSessionId: input.externalSessionId,
      },
      operation: input.operation,
      capabilityReceiptId: input.capabilityReceiptId,
      bindingId: input.bindingId,
      ...(input.requestDigest ? { requestDigest: input.requestDigest } : {}),
    };
    const stable = {
      ...stableBase,
      ...(Object.keys(payload).length ? { payload } : {}),
    };
    const signatureCommand = {
      ...stableBase,
      ...(Object.keys(signaturePayload).length ? { payload: signaturePayload } : {}),
    };
    const signature = createHash('sha256').update(JSON.stringify({
      projectRoot: canonicalRoot ? comparablePath(canonicalRoot) : null,
      command: signatureCommand,
    })).digest('hex');
    if (cached) {
      if (cached.signature !== signature) throw new Error('KLYPIX_REMOTE_ACTION_CONTENT_CHANGED');
      try { cached.snapshots.forEach(verifySnapshot); }
      catch (error) {
        cleanupCommandCacheEntry(normalizedAction, cached, 'KLYPIX_REMOTE_ACTION_INVALID');
        throw error;
      }
      return cloneCommand(cached.command);
    }
    const command = { ...stable, issuedAt: now, expiresAt: now + SNAPSHOT_TTL_MS };
    while (commandCache.size >= COMMAND_CACHE_LIMIT) {
      const oldestAction = commandCache.keys().next().value;
      const removed = cleanupCommandCacheEntry(
        oldestAction, commandCache.get(oldestAction), 'KLYPIX_REMOTE_ACTION_EVICTED',
      );
      if (!removed || commandCache.size >= COMMAND_CACHE_LIMIT) {
        // A retained entry still owns its timer, command bytes and (possibly)
        // snapshot reservation. Never admit another entry until deletion has
        // actually freed the slot; the finally block cleans this new build.
        throw new Error('KLYPIX_REMOTE_COMMAND_RESOURCE_LIMIT');
      }
    }
    const entry = {
      signature,
      command: cloneCommand(command),
      snapshots: resolvedAttachments.snapshots,
      snapshotDirectory: resolvedAttachments.snapshotDirectory,
      snapshotReservation: resolvedAttachments.snapshotReservation,
      cleanupTimer: null,
    };
    commandCache.set(normalizedAction, entry);
    entry.cleanupTimer = setTimeout(
      () => cleanupCommandCacheEntry(
        normalizedAction, entry, 'KLYPIX_REMOTE_ACTION_EXPIRED',
      ), SNAPSHOT_TTL_MS,
    );
    entry.cleanupTimer.unref?.();
    snapshotRetained = true;
    return command;
  } finally {
    if (resolvedAttachments?.snapshotDirectory && !snapshotRetained) {
      const removed = removeSnapshotDirectory(resolvedAttachments.snapshotDirectory);
      if (removed) releaseSnapshotReservation(resolvedAttachments.snapshotReservation);
      else retainOrphanedSnapshotCleanup(
        resolvedAttachments.snapshotDirectory, resolvedAttachments.snapshotReservation,
      );
    } else if (resolvedAttachments?.snapshotReservation && !snapshotRetained) {
      releaseSnapshotReservation(resolvedAttachments.snapshotReservation);
    }
  }
}

export async function remoteCommand(input, options = {}) {
  if (!input || !PROVIDERS.has(input.provider) || !OPERATIONS.has(input.operation)) {
    throw new Error('KLYPIX_REMOTE_COMMAND_INVALID');
  }
  const {
    projectRoot, actionIdentity, now = Date.now(), ...requestOptions
  } = options;
  const canonicalRoot = boundProjectRoot(projectRoot);
  const sessions = await projectSessions(canonicalRoot, requestOptions);
  const requestedIdentity = identityKey({
    machineId: input.machineId,
    provider: input.provider,
    externalSessionId: input.externalSessionId,
  });
  const session = sessions.find((candidate) => identityKey(candidate.identity) === requestedIdentity);
  if (!requestedIdentity || !session) throw new Error('KLYPIX_REMOTE_SESSION_OUT_OF_SCOPE');

  if (input.operation === 'approve' || input.operation === 'reject') {
    if (typeof input.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.requestDigest)) {
      throw new Error('KLYPIX_REMOTE_REQUEST_DIGEST_REQUIRED');
    }
    const parsedActions = await requestRemote('GET', '/v1/actions', undefined, requestOptions);
    if (!Array.isArray(parsedActions.actions)) throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID');
    const pending = parsedActions.actions.find((action) => identityKey(action?.identity) === requestedIdentity
      && action.status === 'pending'
      && action.requestDigest === input.requestDigest
      && Array.isArray(action.options)
      && action.options.some((option) => option?.operation === input.operation));
    if (!pending) throw new Error('KLYPIX_REMOTE_PENDING_REQUEST_NOT_AUTHORIZED');
  }

  const capability = session.capabilities?.[input.operation];
  const activeBinding = session.ownership?.status === 'active' ? session.ownership.activeBinding : null;
  if (!capability
      || capability.operation !== input.operation
      || capability.available !== true
      || capability.receiptId !== input.capabilityReceiptId
      || capability.bindingId !== input.bindingId
      || (ACTIVE_BINDING_OPERATIONS.has(input.operation) && activeBinding?.id !== input.bindingId)
      || !Number.isFinite(capability.expiresAt)
      || capability.expiresAt <= now) {
    throw new Error('KLYPIX_REMOTE_CAPABILITY_NOT_AUTHORIZED');
  }

  const command = buildRemoteCommand(input, now, actionIdentity, canonicalRoot);
  const normalizedAction = normalizedActionIdentity(actionIdentity);
  const hasAttachments = Array.isArray(command.payload?.attachments)
    && command.payload.attachments.length > 0;
  return (await requestRemote(
    'POST', '/v1/commands', command, requestOptions,
    // This is the final synchronous step before fetch. Desktop receives the
    // verified SHA-256 too and must reject a path whose reopened bytes differ.
    (descriptor) => {
      if (hasAttachments && descriptor.attachmentIntegrity !== 'sha256-v1') {
        throw new Error('KLYPIX_REMOTE_ATTACHMENT_INTEGRITY_UNSUPPORTED');
      }
      verifyCachedCommandSnapshots(normalizedAction);
    },
  )).receipt;
}
