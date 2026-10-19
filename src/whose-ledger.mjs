// "Whose is this?" (1.103.0): the edit ledger.
//
// Before a risky git command KLYPIX has to say whose uncommitted work is at
// stake. The lane cannot answer that: `observedFiles` is an LRU of 20 paths
// with no time per file, and directory entries are rebuilt from a whitelist
// by older writers. So the edits live in a sidecar next to the lane,
// `sessions/<sha16>.edits` (the lane's own <sha16>, with `.json` replaced, the
// same convention as `.hostmap`; consumers that glob `sessions/*.json` never
// see it). One JSON object per line, appended without a lock by the Claude
// PostToolUse hook after every Edit, Write, MultiEdit and NotebookEdit:
//
//   {"v":1,"sid":"…","client":"claude-code","key":"src/tax.ts","at":1760609700000,
//    "blob":"<git blob id of the bytes the edit left>","blobLf":"<the same after CRLF→LF>"}
//   {"v":1,"kind":"clean","key":"src/tax.ts","at":1760609900000}
//
// Ownership is decided by BYTES, not by clocks (V1 scope, safety-B3 and S1).
// A session owns a dirty file only while the file still hashes to what that
// session's newest edit left. A `clean` record (the path was seen committed or
// discarded) retires every record before it. A change KLYPIX did not see is
// therefore never billed to the last session it did see, and nothing here
// compares edit times with commit times.
//
// IO is limited to the ledger file (append, read, tmp+rename rotation) and to
// the edited file (one read, to hash it; a few stats to find the repo root and
// canonical paths). No git and no lane lock, so the PostToolUse path costs one
// open, read, hash and append. Every export except hashBytes never throws:
// failure is `null`, an empty Map or `{ rotated: false }`.
//
// Rotation (past 512 KiB) and appends need no lock between them; rotations
// exclude each other with `<ledger>.rotate-lock`. Rotation
// copies new lines before the rename, again before each retry (on Windows a
// writer's open handle blocks the rename), and after the rename through a
// hard link to the old file. On POSIX, a writer that wrote through a handle
// opened before the rename sees that the path now names another file and
// appends its record again. A duplicate record is harmless.
//
// Known limits:
//   · any process of the same user can write this file, so a record is
//     evidence, not proof;
//   · on a filesystem without hard links or file ids (FAT, some network
//     shares) an append racing a rotation can still be lost;
//   · only edits made through the agents' edit tools are recorded.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LANE_RENAME_BACKOFF_MS, laneFileFor, sweepStaleTmpFiles } from './agent-presence.mjs';

export const LEDGER_VERSION = 1;
// Record lifetime: the lane directory's own window (DIRECTORY_FRESH_MS; the
// test pins the two together).
export const LEDGER_TTL_MS = 14 * 86400000;
export const LEDGER_MAX_BYTES = 512 * 1024;
// A larger file is still recorded, without a hash, so it can never be FOREIGN
// on byte evidence; it only gives context.
export const LEDGER_HASH_MAX_BYTES = 8 * 1024 * 1024;
// A key or id over these is dropped, never cut: a cut path names another file.
export const LEDGER_KEY_MAX = 1024;
export const LEDGER_SID_MAX = 160;
export const SAME_HOST_LABEL = 'your earlier conversation in this window';
export const OWNERSHIP_CLASSES = Object.freeze(['FOREIGN', 'SHARED', 'MINE', 'UNATTRIBUTED']);

const LEDGER_CLIENT_MAX = 40;
// A ledger that has not rotated for some reason is read from its tail only.
const READ_MAX_BYTES = 16 * 1024 * 1024;
const ROTATED_KIND = 'rotated';
const KNOWN_KINDS = new Set(['edit', 'clean', ROTATED_KIND]);
const FOREIGN_RECORD_MAX = 2048;
const HASH_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CRLF = Buffer.from('\r\n');
const NEWLINE = 0x0a;
// Windows: antivirus and indexers hold files for a moment. The rename codes
// and backoff are the lane's own (agent-presence renameWithRetry).
const APPEND_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const APPEND_BACKOFF_MS = Object.freeze([5, 15, 40]);
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};

// ── Where the ledger lives ───────────────────────────────────────────────────

/** `~/.claude/project-brain/sessions/<sha16>.edits`, the lane's <sha16> (laneFileFor). */
export function ledgerFileFor(brainPath, home) {
  if (typeof brainPath !== 'string' || !brainPath) return null;
  try { return laneFileFor(brainPath, home || undefined).replace(/\.json$/, '.edits'); }
  catch { return null; }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const isWin = (platform) => platform === 'win32';
const pathFor = (platform) => (isWin(platform) ? path.win32 : path.posix);

// Windows: accept the spellings other tools hand over: MSYS and Git Bash
// (/e/x), Cygwin (/cygdrive/e/x) and the \\?\ long-path prefix.
function nativeInput(value, platform) {
  let s = String(value);
  if (!isWin(platform)) return s;
  const long = /^[\\/]{2}\?[\\/](UNC[\\/])?/i.exec(s);
  if (long) s = (long[1] ? '\\\\' : '') + s.slice(long[0].length);
  const msys = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)/.exec(s);
  if (msys) s = `${msys[1].toUpperCase()}:${s.slice(msys[0].length) || '/'}`;
  return s;
}

// The comparison fold for a repo-relative path. '/' separators and NFC
// everywhere; lowercase on Windows only, where the filesystem ignores case.
// A backslash is a separator on Windows and an ordinary name character on
// POSIX, so it is converted only on Windows.
function normalizeKey(key, platform = process.platform) {
  let s = String(key ?? '');
  if (isWin(platform)) s = s.replace(/\\/g, '/');
  s = s.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').normalize('NFC');
  return isWin(platform) ? s.toLowerCase() : s;
}

function insideRel(P, root, abs) {
  const rel = P.relative(root, abs);
  if (!rel || P.isAbsolute(rel)) return null;                 // the root itself, or another drive
  if (rel === '..' || rel.startsWith(`..${P.sep}`)) return null; // `..name` is a real file inside
  return rel;
}

// realpath of a path that may not exist (a deleted file): canonicalize the
// nearest existing ancestor and put the missing tail back.
function realpathLoose(p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 128; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

/**
 * Repo-relative key for a path: '/' separators, NFC, lowercased on win32;
 * null when the path is outside `repoRoot` (or is the root itself). A relative
 * path is taken as relative to `repoRoot`, as git status paths are. When the
 * plain spellings disagree (a junction, a symlink, an 8.3 name), the canonical
 * paths are compared before giving up. `platform` exists for tests.
 */
export function fileKey(repoRoot, absOrRelPath, { platform = process.platform } = {}) {
  try {
    if (typeof repoRoot !== 'string' || !repoRoot || typeof absOrRelPath !== 'string' || !absOrRelPath) return null;
    if (repoRoot.includes('\0') || absOrRelPath.includes('\0')) return null;
    const P = pathFor(platform);
    const root = P.resolve(nativeInput(repoRoot, platform));
    const abs = P.resolve(root, nativeInput(absOrRelPath, platform));
    let rel = insideRel(P, root, abs);
    if (rel === null && platform === process.platform) {
      const rootReal = realpathLoose(root);
      const absReal = rootReal && realpathLoose(abs);
      if (absReal) rel = insideRel(P, rootReal, absReal);
    }
    if (rel === null) return null;
    return normalizeKey(rel, platform) || null;
  } catch { return null; }
}

/** Nearest ancestor of `start` holding `.git` (a directory, or a worktree's file); null if none. */
export function findRepoRoot(start) {
  try {
    if (typeof start !== 'string' || !start) return null;
    let dir = path.resolve(nativeInput(start, process.platform));
    try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); }
    catch { dir = path.dirname(dir); }
    for (let i = 0; i < 256; i++) {
      try { fs.statSync(path.join(dir, '.git')); return dir; }
      catch { /* keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* fall through */ }
  return null;
}

// ── Hashes ───────────────────────────────────────────────────────────────────

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  throw new TypeError('hashBytes expects a Buffer, Uint8Array, ArrayBuffer or string');
}

const gitBlobId = (bytes) => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Git blob ids (sha1 of "blob <len>\0" + bytes) of the raw bytes and of the
 * bytes with each CRLF turned into LF. The second is what `git hash-object`
 * stores for a CRLF text file under core.autocrlf=true or a `text` attribute,
 * so a file whose line endings a checkout rewrote still matches its edit.
 * Throws a TypeError on input that is not bytes: a hash that silently came
 * back null would read as "file deleted".
 */
export function hashBytes(buf) {
  const bytes = toBytes(buf);
  const blob = gitBlobId(bytes);
  const first = bytes.indexOf(CRLF);
  if (first === -1) return { blob, blobLf: blob };
  let count = 0;
  for (let i = first; i !== -1; i = bytes.indexOf(CRLF, i + 2)) count++;
  const lf = Buffer.allocUnsafe(bytes.length - count);
  let w = 0;
  let r = 0;
  for (let i = first; i !== -1; i = bytes.indexOf(CRLF, i + 2)) {
    w += bytes.copy(lf, w, r, i);
    r = i + 1; // drop the CR, keep the LF
  }
  bytes.copy(lf, w, r);
  return { blob, blobLf: gitBlobId(lf) };
}

// ── Record hygiene ───────────────────────────────────────────────────────────

const normId = (value) => String(value ?? '').trim().toLowerCase();

function cleanSid(sid) {
  if (typeof sid !== 'string') return null;
  const s = sid.trim();
  return s && s.length <= LEDGER_SID_MAX ? s : null;
}

function cleanClient(client) {
  const s = typeof client === 'string' ? client.trim() : '';
  return s ? s.slice(0, LEDGER_CLIENT_MAX) : 'unknown';
}

function cleanHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.trim().toLowerCase();
  return HASH_RE.test(h) ? h : null;
}

function cleanTime(now) {
  const t = Number(now);
  return Number.isFinite(t) && t > 0 ? t : null;
}

// One known record (edit or clean) in canonical shape, or null. Built from
// known fields only: lines come from a file any same-user process can write.
function normalizeRecord(obj, platform) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.v !== LEDGER_VERSION) return null;
  if (typeof obj.at !== 'number' || !Number.isFinite(obj.at) || obj.at <= 0) return null;
  if (typeof obj.key !== 'string') return null;
  const key = normalizeKey(obj.key, platform);
  if (!key || key.length > LEDGER_KEY_MAX) return null;
  if (obj.kind === 'clean') return { v: LEDGER_VERSION, kind: 'clean', key, at: obj.at };
  if (obj.kind !== undefined && obj.kind !== 'edit') return null;
  const sid = cleanSid(obj.sid);
  if (!sid) return null;
  return { v: LEDGER_VERSION, sid, client: cleanClient(obj.client), key, at: obj.at, blob: cleanHash(obj.blob), blobLf: cleanHash(obj.blobLf) };
}

// A record written by a NEWER build (a later version or a kind this one does
// not know). Rotation keeps the newest of each instead of erasing what it
// cannot read.
const isForeignRecord = (obj) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Number.isInteger(obj.v) && obj.v >= LEDGER_VERSION
  && typeof obj.at === 'number' && Number.isFinite(obj.at)
  && (obj.v > LEDGER_VERSION || (typeof obj.kind === 'string' && !KNOWN_KINDS.has(obj.kind)));

// ── Reading ──────────────────────────────────────────────────────────────────

function parseObject(line) {
  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  try { return asObject(JSON.parse(line)); }
  catch {
    // A writer that died mid-line leaves a fragment, and the next record can
    // sit on the same line. Our records start with {"v": and a JSON string
    // never contains a raw quote, so the last such opening is a record start.
    const at = line.lastIndexOf('{"v":');
    if (at <= 0) return null;
    try { return asObject(JSON.parse(line.slice(at))); }
    catch { return null; }
  }
}

function parseLines(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line.trim()) continue;
    const obj = parseObject(line);
    if (obj) out.push(obj);
  }
  return out;
}

// Read from `start` to end of file, at most `max` bytes (a file that keeps
// growing while it is read must not be read forever).
function readRange(fd, start, sizeHint = 0, max = Infinity) {
  const chunks = [];
  let total = 0;
  let chunkSize = Math.min(Math.max(sizeHint + 1, 4096), 1 << 20);
  while (total < max) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, max - total));
    const n = fs.readSync(fd, chunk, 0, chunk.length, start + total);
    if (!n) break;
    chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
    total += n;
    chunkSize = 1 << 20;
  }
  return Buffer.concat(chunks, total);
}

function readLedgerText(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > READ_MAX_BYTES ? size - READ_MAX_BYTES : 0;
    let buf = readRange(fd, start, size - start, size - start + (1 << 20));
    if (start > 0) {
      const nl = buf.indexOf(NEWLINE);
      buf = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    }
    return buf.toString('utf8');
  } catch { return ''; }
  finally { try { fs.closeSync(fd); } catch { /* best effort */ } }
}

function ttlFloor(now, ttlMs) {
  const t = Number(now);
  const ttl = Number(ttlMs);
  const nowMs = Number.isFinite(t) ? t : Date.now();
  return ttl >= 0 ? nowMs - ttl : nowMs - LEDGER_TTL_MS; // Infinity keeps everything
}

const byAt = (a, b) => a.at - b.at; // Array#sort is stable: equal times keep file order

/**
 * Map<key, records> with each list oldest→newest (by `at`; equal times keep
 * file order). Records older than `ttlMs` are dropped; torn, garbage and
 * unknown lines are skipped; a partly written last line (an append in flight)
 * is simply not there yet.
 */
export function readLedger({ brainPath, home, now = Date.now(), ttlMs = LEDGER_TTL_MS, platform = process.platform } = {}) {
  const out = new Map();
  try {
    const file = ledgerFileFor(brainPath, home);
    if (!file) return out;
    const floor = ttlFloor(now, ttlMs);
    for (const obj of parseLines(readLedgerText(file))) {
      const rec = normalizeRecord(obj, platform);
      if (!rec || rec.at < floor) continue;
      const list = out.get(rec.key);
      if (list) list.push(rec);
      else out.set(rec.key, [rec]);
    }
  } catch { /* a reader never throws: what parsed is returned */ }
  for (const list of out.values()) list.sort(byAt);
  return out;
}

// ── Writing ──────────────────────────────────────────────────────────────────

// One write per call, on an O_APPEND handle (FILE_APPEND_DATA on Windows), so
// concurrent writers never interleave inside a record. If the file does not
// end in a newline (a writer died mid-line), the batch starts on a new line so
// the fragment cannot swallow it.
const appendRecords = (file, records) => appendRaw(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));

// Does the open handle still belong to the file the path names? (Cannot tell:
// say yes.)
function handleIsPath(fd, file) {
  try {
    const a = fs.fstatSync(fd, { bigint: true });
    const b = fs.statSync(file, { bigint: true });
    return (a.ino === 0n && b.ino === 0n) || (a.ino === b.ino && a.dev === b.dev);
  } catch { return true; }
}

function appendRaw(file, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  let rewrites = 0;
  for (let attempt = 0; ; attempt++) {
    let fd = null;
    try {
      try { fd = fs.openSync(file, 'a+'); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fd = fs.openSync(file, 'a+');
      }
      const size = fs.fstatSync(fd).size;
      let bytes = payload;
      if (size > 0) {
        const last = Buffer.alloc(1);
        if (fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NEWLINE) bytes = Buffer.concat([Buffer.from('\n'), payload]);
      }
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      // POSIX: a rotation renamed its compacted file over the ledger after
      // this handle was opened, so these bytes went to the old file. Write
      // them again: a duplicate record is harmless, a lost one is not.
      if (rewrites < 2 && !handleIsPath(fd, file)) { rewrites++; continue; }
      return true;
    } catch (error) {
      if (!APPEND_RETRY_CODES.has(error?.code) || attempt >= APPEND_BACKOFF_MS.length) return false;
      sleepSync(APPEND_BACKOFF_MS[attempt]);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    }
  }
}

function readForHash(file, maxBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) {
    if (error?.code === 'EISDIR') return { state: 'directory' };
    return { state: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return { state: 'directory' };
    if (st.size > maxBytes) return { state: 'large' };
    const bytes = readRange(fd, 0, st.size, maxBytes + 1);
    return bytes.length > maxBytes ? { state: 'large' } : { state: 'ok', bytes };
  } catch (error) {
    return { state: error?.code === 'EISDIR' ? 'directory' : 'unreadable' };
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * Hash `absPath` as it is now and append {v:1,sid,client,key,at,blob,blobLf}.
 * A missing, unreadable or over-cap file is recorded with null hashes (the
 * session touched it; nothing can match its bytes). Returns the record, or null
 * when nothing was written: bad arguments, a path outside the repo or inside
 * `.git`, a directory, or a failed append. `repoRoot` should be the git top
 * level of the repo the BRAIN belongs to; when absent, the nearest ancestor of
 * the brain with `.git` is used, then the brain's directory. Never the edited
 * file's own repo: a file in a sibling repo would be keyed relative to that
 * repo and collide with a same-named path here, and a file in a nested
 * worktree (`.worktrees/x/src/a.ts`) would pose as `src/a.ts`. A file outside
 * the brain's repo is not recorded. Never throws.
 */
export function recordEdit({ brainPath, home, sid, client, repoRoot, absPath, now = Date.now(), maxHashBytes = LEDGER_HASH_MAX_BYTES } = {}) {
  try {
    const id = cleanSid(sid);
    const at = cleanTime(now);
    const file = ledgerFileFor(brainPath, home);
    if (!id || at === null || !file || typeof absPath !== 'string' || !absPath || absPath.includes('\0')) return null;
    const platform = process.platform;
    const given = typeof repoRoot === 'string' && repoRoot ? repoRoot : null;
    const target = path.resolve(given ? nativeInput(given, platform) : process.cwd(), nativeInput(absPath, platform));
    const brainDir = path.dirname(path.resolve(nativeInput(brainPath, platform)));
    const root = given || findRepoRoot(brainDir) || brainDir;
    const key = fileKey(root, target);
    if (!key || key.length > LEDGER_KEY_MAX || /(?:^|\/)\.git(?:\/|$)/.test(key)) return null;
    const cap = Number(maxHashBytes) >= 0 ? Number(maxHashBytes) : LEDGER_HASH_MAX_BYTES;
    const read = readForHash(target, cap);
    if (read.state === 'directory') return null;
    const hash = read.state === 'ok' ? hashBytes(read.bytes) : null;
    const record = {
      v: LEDGER_VERSION,
      sid: id,
      client: cleanClient(client),
      key,
      at,
      blob: hash ? hash.blob : null,
      blobLf: hash ? hash.blobLf : null,
    };
    return appendRecords(file, [record]) ? record : null;
  } catch { return null; }
}

/**
 * Append {v:1,kind:'clean',key,at}: the path was seen clean (committed or
 * discarded), so only records after it count. `keys` (an array) writes one
 * record per distinct key in a single append and returns the array written;
 * `key` returns the record or null. Never throws.
 */
export function recordClean({ brainPath, home, key, keys, now = Date.now(), platform = process.platform } = {}) {
  const batch = keys !== undefined;
  try {
    const file = ledgerFileFor(brainPath, home);
    const at = cleanTime(now);
    if (!file || at === null) return batch ? [] : null;
    const records = [];
    const seen = new Set();
    for (const raw of batch ? (Array.isArray(keys) ? keys : []) : [key]) {
      if (typeof raw !== 'string') continue;
      const k = normalizeKey(raw, platform);
      if (!k || k.length > LEDGER_KEY_MAX || seen.has(k)) continue;
      seen.add(k);
      records.push({ v: LEDGER_VERSION, kind: 'clean', key: k, at });
    }
    if (!records.length || !appendRecords(file, records)) return batch ? [] : null;
    return batch ? records : records[0];
  } catch { return batch ? [] : null; }
}

// ── Rotation ─────────────────────────────────────────────────────────────────

function rotationHeaderBytes(head) {
  const nl = head.indexOf(NEWLINE);
  if (nl <= 0) return 0;
  try {
    const obj = JSON.parse(head.subarray(0, nl).toString('utf8'));
    return obj && obj.v === LEDGER_VERSION && obj.kind === ROTATED_KIND && Number(obj.bytes) > 0 ? Number(obj.bytes) : 0;
  } catch { return 0; }
}

// What a rotation keeps: within the TTL, the latest clean per key plus each
// session's newest record after it. That is all ownership() reads, so its
// answers do not change (the test checks this on random ledgers).
function compactLines(text, { floor, platform }) {
  const groups = new Map();
  const newer = new Map();
  let pos = 0;
  let parsed = 0;
  for (const obj of parseLines(text)) {
    parsed++;
    pos++;
    const rec = normalizeRecord(obj, platform);
    if (rec) {
      if (rec.at < floor) continue;
      const list = groups.get(rec.key);
      if (list) list.push({ rec, pos });
      else groups.set(rec.key, [{ rec, pos }]);
      continue;
    }
    if (isForeignRecord(obj) && obj.at >= floor) {
      const line = JSON.stringify(obj);
      if (line.length <= FOREIGN_RECORD_MAX) newer.set(JSON.stringify([obj.v, obj.kind ?? null, obj.key ?? null, obj.sid ?? null]), { rec: obj, line, pos });
    }
  }
  const keep = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.rec.at - b.rec.at || a.pos - b.pos);
    let cleanAt = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].rec.kind === 'clean') { cleanAt = i; break; }
    if (cleanAt >= 0) keep.push(list[cleanAt]);
    const newest = new Map();
    for (let i = cleanAt + 1; i < list.length; i++) {
      if (list[i].rec.kind !== 'clean') newest.set(normId(list[i].rec.sid), list[i]);
    }
    keep.push(...newest.values());
  }
  keep.push(...newer.values());
  keep.sort((a, b) => a.rec.at - b.rec.at || a.pos - b.pos);
  return { body: keep.map((item) => `${item.line || JSON.stringify(item.rec)}\n`).join(''), kept: keep.length, dropped: parsed - keep.length };
}

const fileIdentity = (stat) => ({ ino: stat.ino, dev: stat.dev });
// Does `file` still name the file we opened? (No file ids on this filesystem:
// assume yes; the rename is then the only guard.)
function stillSameFile(identity, file) {
  try {
    const now = fs.statSync(file, { bigint: true });
    if (identity.ino === 0n && now.ino === 0n) return true;
    return identity.ino === now.ino && identity.dev === now.dev;
  } catch { return false; }
}

// Rotations exclude each other with a lock file (appends never take it). The
// identity checks below cannot do it alone: the check and the rename are two
// steps, and a rotation that ran to completion between them, plus any append
// to its new file, would be overwritten by the slower one's tmp. A lock older
// than ROTATE_LOCK_STALE_MS belongs to a process that died; it is taken over
// by renaming it aside (only one taker can win that rename).
const ROTATE_LOCK_STALE_MS = 60 * 1000;

function lockToken(lock) {
  try { return fs.readFileSync(lock, 'utf8'); } catch { return null; }
}

function takeRotateLock(file) {
  const lock = `${file}.rotate-lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const create = () => {
    const fd = fs.openSync(lock, 'wx');
    try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
    return { lock, token };
  };
  try { return create(); }
  catch (error) { if (error?.code !== 'EEXIST') return null; }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= ROTATE_LOCK_STALE_MS) return null;
    const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.renameSync(lock, aside);
    // Between our stat and our rename another taker may have put a fresh lock
    // there: give it back.
    if (Date.now() - fs.statSync(aside).mtimeMs <= ROTATE_LOCK_STALE_MS) {
      try { fs.linkSync(aside, lock); } catch { /* someone holds it already */ }
      try { fs.unlinkSync(aside); } catch { /* best effort */ }
      return null;
    }
    try { fs.unlinkSync(aside); } catch { /* best effort */ }
    return create();
  } catch { return null; }
}

function releaseRotateLock(held) {
  if (!held) return;
  // Only our own: a lock taken over after we went stale is someone else's now.
  if (lockToken(held.lock) === held.token) { try { fs.unlinkSync(held.lock); } catch { /* best effort */ } }
}

/**
 * Past `maxBytes`, rewrite the ledger with only what ownership() reads (the
 * newest record per (key, session) and the latest clean per key, within the
 * TTL) through a tmp file and a rename. Lines appended while it works are
 * copied over before the rename, again before every rename retry (Windows
 * refuses to rename over a file another process holds open, so a blocked
 * rename means an append was in progress), and once more after it, read
 * through a hard link to the old file. If another rotation replaced the file
 * first, this one leaves it alone ('raced'); while another rotation holds the
 * rotation lock, this one does nothing ('busy').
 * A header line remembers the compacted size, and the next rotation waits
 * until the file has doubled, so a ledger that is legitimately larger than
 * `maxBytes` is not rewritten on every call. `_seams` ({ afterRead, beforeRename }) is for tests.
 * Never throws.
 */
export function rotateLedgerIfLarge({ brainPath, home, maxBytes = LEDGER_MAX_BYTES, now = Date.now(), ttlMs = LEDGER_TTL_MS, platform = process.platform, _seams = null } = {}) {
  const file = ledgerFileFor(brainPath, home);
  if (!file) return { rotated: false, reason: 'no-ledger' };
  let fd = null;
  let tmp = null;
  let link = null;
  let held = null;
  try {
    let size;
    try { size = fs.statSync(file).size; }
    catch (error) { return { rotated: false, reason: error?.code === 'ENOENT' ? 'missing' : 'stat-failed' }; }
    const limit = Number(maxBytes) > 0 ? Number(maxBytes) : LEDGER_MAX_BYTES;
    if (size <= limit) return { rotated: false, reason: 'small', bytes: size };
    fd = fs.openSync(file, 'r');
    const identity = fileIdentity(fs.fstatSync(fd, { bigint: true }));
    const head = Buffer.alloc(Math.min(512, size));
    const previous = rotationHeaderBytes(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)));
    if (previous > 0 && size <= Math.max(limit, 2 * previous)) return { rotated: false, reason: 'recently-rotated', bytes: size };
    fs.closeSync(fd);
    fd = null;
    held = takeRotateLock(file);
    if (!held) return { rotated: false, reason: 'busy', bytes: size };
    // Under the lock, look again: a rotation that finished just before we took
    // it has replaced the file we measured.
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd, { bigint: true });
    if (!(identity.ino === 0n && st.ino === 0n) && (st.ino !== identity.ino || st.dev !== identity.dev)) return { rotated: false, reason: 'raced', bytes: size };
    size = Number(st.size);

    const raw = readRange(fd, 0, size);
    let readTo = raw.lastIndexOf(NEWLINE) + 1; // a line still being written is read during catch-up
    const { body, kept, dropped } = compactLines(raw.subarray(0, readTo).toString('utf8'), { floor: ttlFloor(now, ttlMs), platform });
    const stamp = cleanTime(now) ?? Date.now();
    const header = `${JSON.stringify({ v: LEDGER_VERSION, kind: ROTATED_KIND, at: stamp, bytes: Buffer.byteLength(body) })}\n`;
    const suffix = () => `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    tmp = `${file}.tmp-${suffix()}`;
    fs.writeFileSync(tmp, header + body);
    if (typeof _seams?.afterRead === 'function') _seams.afterRead();

    // Copy the complete lines appended to the old file since our last read.
    // A partial last line is an append in flight: it is copied after the
    // rename, when its writer is done.
    const catchUp = (handle) => {
      const more = readRange(handle, readTo);
      const cut = more.lastIndexOf(NEWLINE) + 1;
      if (cut > 0) {
        fs.appendFileSync(tmp, more.subarray(0, cut));
        readTo += cut;
      }
    };
    catchUp(fd);
    // From here the old file is read by name, never through a held handle
    // (Windows refuses to rename over a file that any process holds open). A
    // second name, a hard link, keeps the old file readable after the rename,
    // so the lines that reach it at the last moment are still copied.
    fs.closeSync(fd);
    fd = null;
    try {
      link = `${file}.tmp-${suffix()}`;
      fs.linkSync(file, link);
      if (!stillSameFile(identity, link)) return { rotated: false, reason: 'raced', bytes: size };
    } catch { link = null; }
    // Copy new lines from the old file; false when the name no longer leads
    // to it (only possible without the link).
    const readOld = () => {
      const handle = fs.openSync(link || file, 'r');
      try {
        const opened = fs.fstatSync(handle, { bigint: true });
        if (identity.ino !== 0n && (opened.ino !== identity.ino || opened.dev !== identity.dev)) return false;
        catchUp(handle);
        return true;
      } finally { fs.closeSync(handle); }
    };
    for (let attempt = 0; ; attempt++) {
      // Another process rotated first: its file is the ledger now, leave it.
      if (!stillSameFile(identity, file) || !readOld()) return { rotated: false, reason: 'raced', bytes: size };
      if (typeof _seams?.beforeRename === 'function') _seams.beforeRename(attempt);
      try {
        fs.renameSync(tmp, file);
        tmp = null;
        break;
      } catch (error) {
        // Windows: a writer has the ledger open right now. Its line is copied
        // on the next attempt.
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= LANE_RENAME_BACKOFF_MS.length) throw error;
        sleepSync(LANE_RENAME_BACKOFF_MS[attempt]);
      }
    }
    if (link) {
      // Everything that reached the old file after our last read, partial
      // last line included (it gets its own line; a garbage line is skipped by
      // readers, and its writer appends the record again, see appendRaw).
      const handle = fs.openSync(link, 'r');
      let late;
      try { late = readRange(handle, readTo); }
      finally { fs.closeSync(handle); }
      if (late.length) appendRaw(file, late[late.length - 1] === NEWLINE ? late : Buffer.concat([late, Buffer.from('\n')]));
    }
    sweepStaleTmpFiles(path.dirname(file));
    let after = null;
    try { after = fs.statSync(file).size; } catch { /* reported as null */ }
    return { rotated: true, reason: 'rotated', bytesBefore: size, bytesAfter: after, kept, dropped };
  } catch (error) {
    return { rotated: false, reason: `failed:${String(error?.code || error?.message || 'unknown').slice(0, 60)}` };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    if (link) { try { fs.unlinkSync(link); } catch { /* best effort */ } }
    releaseRotateLock(held);
  }
}

// ── Ownership ────────────────────────────────────────────────────────────────

function idSet(ids) {
  const list = typeof ids === 'string' ? [ids] : (ids && typeof ids[Symbol.iterator] === 'function' ? [...ids] : []);
  return new Set(list.filter((v) => typeof v === 'string' && v.trim()).map(normId));
}

function hashSet(hash) {
  const out = new Set();
  if (typeof hash === 'string') {
    const h = cleanHash(hash);
    if (h) out.add(h);
  } else if (hash && typeof hash === 'object') {
    for (const h of [cleanHash(hash.blob), cleanHash(hash.blobLf)]) if (h) out.add(h);
  }
  return out;
}

function indexLedger(ledger, platform) {
  const index = new Map();
  const entries = ledger instanceof Map ? [...ledger.entries()] : (ledger && typeof ledger === 'object' ? Object.entries(ledger) : []);
  for (const [rawKey, list] of entries) {
    if (!Array.isArray(list)) continue;
    const key = normalizeKey(rawKey, platform);
    const records = list.filter((r) => r && typeof r === 'object' && Number.isFinite(Number(r.at)));
    const prev = index.get(key);
    index.set(key, prev ? prev.concat(records) : records);
  }
  for (const list of index.values()) list.sort((a, b) => Number(a.at) - Number(b.at));
  return index;
}

const ownerView = (s) => ({ sid: s.rec.sid, client: s.rec.client || 'unknown', at: s.rec.at });

function classifyKey(records, hash, sideOf) {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) if (records[i].kind === 'clean') { start = i + 1; break; }
  const bySession = new Map();
  for (let i = start; i < records.length; i++) {
    const r = records[i];
    if (r.kind === 'clean' || typeof r.sid !== 'string' || !r.sid.trim()) continue;
    bySession.set(normId(r.sid), { rec: r, pos: i }); // later wins: each session's newest record
  }
  const sessions = [...bySession.values()].sort((a, b) => b.pos - a.pos).map((s) => ({ ...s, side: sideOf(s.rec.sid) }));
  const mine = sessions.filter((s) => s.side !== 'other');
  const others = sessions.filter((s) => s.side === 'other');
  const touched = mine.length > 0;
  const labelled = (result, hits) => (hits.every((s) => s.side === 'same-host') ? { ...result, label: SAME_HOST_LABEL } : result);

  // Deleted: the session with the newest record owns the deletion.
  if (hash === null) {
    if (!sessions.length) return { cls: 'UNATTRIBUTED', owners: [], self: false, also: [] };
    const top = sessions[0];
    if (top.side !== 'other') return labelled({ cls: 'MINE', owners: [ownerView(top)], self: true, also: others.map(ownerView) }, [top]);
    return { cls: 'FOREIGN', owners: [ownerView(top)], self: touched, also: others.filter((s) => s !== top).map(ownerView) };
  }

  const current = hashSet(hash);
  const matches = (s) => current.size > 0 && [cleanHash(s.rec.blob), cleanHash(s.rec.blobLf)].some((h) => h && current.has(h));
  const mineHit = mine.filter(matches);
  const otherHit = others.filter(matches);
  // Both sides left these exact bytes: a guess either way, so context only.
  if (otherHit.length && mineHit.length) return { cls: 'SHARED', owners: others.map(ownerView), self: true, also: [] };
  if (otherHit.length) return { cls: 'FOREIGN', owners: otherHit.map(ownerView), self: touched, also: others.filter((s) => !otherHit.includes(s)).map(ownerView) };
  if (mineHit.length) return labelled({ cls: 'MINE', owners: mineHit.map(ownerView), self: true, also: others.map(ownerView) }, mineHit);
  if (others.length) return { cls: 'SHARED', owners: others.map(ownerView), self: touched, also: [] };
  return { cls: 'UNATTRIBUTED', owners: [], self: touched, also: [] };
}

/**
 * Who owns each dirty file. Pure: reads nothing but its arguments.
 *
 * dirty: [{ key, hash: {blob, blobLf} | null }]: `null` means the file is
 * deleted. A missing or unusable hash means "not hashed" and can never be
 * FOREIGN. Only records after the key's latest clean count, and only each
 * session's newest one:
 *   · its blob or blobLf equals a current hash ("current" evidence): MINE
 *     when the session is self, adopted or same-host (same-host is labelled
 *     SAME_HOST_LABEL), FOREIGN when it is another session; when both sides
 *     match, SHARED;
 *   · nothing matches but another session has a record: SHARED (context);
 *   · otherwise UNATTRIBUTED;
 *   · deleted: the session with the newest record; FOREIGN only when it is
 *     not self, adopted or same-host.
 * → Map<dirty key, { cls, owners: [{sid, client, at}] newest first, self,
 *   label?, also }>. `self`: a self/adopted/same-host session has a record
 *   since the clean. `also`: other sessions with records since the clean that
 *   are not in `owners` (their edits may be in the file too).
 * Session ids compare case-insensitively; keys fold like fileKey on `platform`.
 */
export function ownership({ ledger, dirty, selfIds = [], adoptedIds = [], sameHostIds = [], platform = process.platform } = {}) {
  const result = new Map();
  let index;
  try { index = indexLedger(ledger, platform); }
  catch { index = new Map(); }
  const self = idSet(selfIds);
  const adopted = idSet(adoptedIds);
  const sameHost = idSet(sameHostIds);
  const sideOf = (sid) => {
    const id = normId(sid);
    if (self.has(id)) return 'self';
    if (adopted.has(id)) return 'adopted';
    if (sameHost.has(id)) return 'same-host';
    return 'other';
  };
  for (const entry of Array.isArray(dirty) ? dirty : []) {
    if (!entry || typeof entry.key !== 'string' || !entry.key) continue;
    try {
      const records = index.get(normalizeKey(entry.key, platform)) || [];
      result.set(entry.key, classifyKey(records, entry.hash, sideOf));
    } catch {
      result.set(entry.key, { cls: 'UNATTRIBUTED', owners: [], self: false, also: [] });
    }
  }
  return result;
}
