// brain-history — restore points for a project brain.
//
// WHY THE BRAIN AND NOT EVERY CANVAS. A normal canvas is authored and observed
// by one human: they made every mark, so losing one is a mistake they can see
// and redo. A brain is CO-OWNED and mostly written while nobody is watching —
// hooks, the MCP server, commit capture and peers on other machines all append
// to it unattended. So a human can destroy work they never saw arrive, and an
// agent can destroy work the human never saved. Undo does not span that: it
// lives in one renderer session, and the writers here are separate processes.
//
// WHAT WAS AND WAS NOT ALREADY SAFE (audited 2026-08-07):
//   safe      merge / git-driver union .............. lossless by contract + tests
//   safe      tidy / arrange ......................... lossless by contract
//   safe      brain_garden ........................... archives, approval-gated
//   safe      concurrent writers ..................... advisory lock + queue
//   safe      torn or corrupt write .................. atomicWrite parse-validates
//   UNSAFE    human deletes a card, then saves ....... persisted, irreversible
//   UNSAFE    multi-select delete .................... same, larger
//   UNSAFE    destructive edit of a card's text ...... same
//   UNSAFE    the .klypix file deleted outright ...... nothing to fall back to
//   UNSAFE    an external tool overwrites the file ... no prior copy
//   UNSAFE    a stale machine's sync lands backwards . no prior copy
// Every UNSAFE row is one sentence: the file's previous bytes are gone. So the
// primitive is not a confirmation dialog (people click through those, and the
// brain NEEDS deletion to stay correctable) — it is keeping the previous bytes.
//
// DESIGN RULES, each one earned from a way this could make things worse:
//   • MACHINE-LOCAL, never beside the brain. A `.klypix-history/` in the repo
//     would land in git, in the merge driver's path, in cloud sync, and in
//     everyone's diffs. Restore points are undo, not project content.
//   • NEVER BLOCK A WRITE. Every entry point is best-effort and swallows its
//     own errors: a full disk must not stop the brain from saving.
//   • DEDUPED BY CONTENT. Identical bytes are never stored twice.
//   • SHRINK IS ALWAYS INTERESTING. Routine writes throttle; a write that makes
//     the brain measurably SMALLER is the exact accident this exists for and is
//     never throttled.
//   • BOUNDED. Newest N plus one per day, so it cannot grow without limit.
//   • RESTORE IS ITSELF REVERSIBLE. Restoring first snapshots what is there now.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const KEEP_NEWEST = 20;
const KEEP_DAILY_DAYS = 14;
const THROTTLE_MS = 60 * 1000;
// A write that shrinks the file by more than this is treated as a deletion
// signal and bypasses the throttle. ZIP size tracks card count closely enough
// for a heuristic, and being wrong here only costs one extra snapshot.
const SHRINK_RATIO = 0.02;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function canonPath(p) {
  try { return (fs.realpathSync.native || fs.realpathSync)(p); }
  catch { return path.resolve(p); }
}

// Key on the canonical path with the drive letter lowercased, matching the
// presence lane's convention so both agree about what "the same brain" means.
export function historyKeyFor(brainPath) {
  const norm = canonPath(brainPath).replace(/\\/g, '/').replace(/^([a-z]):/i, (m, d) => `${d.toLowerCase()}:`);
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export function historyDirFor(brainPath, home = os.homedir()) {
  return path.join(home, '.claude', 'project-brain', 'history', historyKeyFor(brainPath));
}

const SNAP_RE = /^(\d+)-([0-9a-f]{8})\.klypix$/;

function readEntries(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = SNAP_RE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    try { bytes = fs.statSync(full).size; } catch { continue; }
    out.push({ id: name.replace(/\.klypix$/, ''), ts: Number(m[1]), sha8: m[2], bytes, file: full });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Restore points for a brain, newest first. Works even if the brain is gone. */
export function listBrainHistory(brainPath, { home = os.homedir() } = {}) {
  const dir = historyDirFor(brainPath, home);
  const entries = readEntries(dir);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')); } catch { /* optional */ }
  return entries.map((e) => ({ ...e, reason: meta?.reasons?.[e.id] || null }));
}

// Newest N, plus the OLDEST surviving snapshot of each of the last KEEP_DAILY_DAYS
// days. Keeping the oldest-of-day (not the newest) is deliberate: after a slow
// accident you want the state BEFORE that day's edits, not after them.
function selectDoomed(entries, now) {
  const keep = new Set(entries.slice(0, KEEP_NEWEST).map((e) => e.id));
  const dayFloor = now - KEEP_DAILY_DAYS * 24 * 60 * 60 * 1000;
  const oldestPerDay = new Map();
  for (const e of entries) {
    if (e.ts < dayFloor) continue;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const prev = oldestPerDay.get(day);
    if (!prev || e.ts < prev.ts) oldestPerDay.set(day, e);
  }
  for (const e of oldestPerDay.values()) keep.add(e.id);
  return entries.filter((e) => !keep.has(e.id));
}

export function pruneBrainHistory(brainPath, { home = os.homedir(), now = Date.now() } = {}) {
  const dir = historyDirFor(brainPath, home);
  const doomed = selectDoomed(readEntries(dir), now);
  let removed = 0;
  for (const e of doomed) {
    try { fs.unlinkSync(e.file); removed++; } catch { /* raced */ }
  }
  if (removed) {
    try {
      const metaPath = path.join(dir, 'source.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const e of doomed) delete meta.reasons?.[e.id];
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch { /* metadata is a convenience */ }
  }
  return removed;
}

/**
 * True when a snapshot right now would be suppressed by the throttle. Callers
 * use this to decide whether it is worth computing an accurate "does this write
 * remove cards?" answer: outside the window a snapshot happens regardless, so
 * nobody should pay to find out.
 */
export function wouldThrottle(brainPath, { home = os.homedir(), now = Date.now() } = {}) {
  const entries = readEntries(historyDirFor(brainPath, home));
  return Boolean(entries.length) && now - entries[0].ts < THROTTLE_MS;
}

/**
 * Snapshot the brain's CURRENT on-disk bytes before something replaces them.
 * Call immediately BEFORE a write. Never throws.
 *
 * `nextBytes` (the size about to be written) enables the shrink rule — pass it
 * whenever the caller knows it; without it every eligible write is snapshotted,
 * which is safe, just chattier.
 *
 * `bytes` snapshots a version that never reached the disk instead: the app's
 * unsaved tab, when a purge made elsewhere drops a card the tab had edited
 * (P-a — the edit survives in this machine's restore point, as a Brain Sync's
 * does in its pre-merge snapshot).
 */
export function snapshotBrain(brainPath, { home = os.homedir(), reason = 'write', nextBytes = null, now = Date.now(), force = false, bytes = null } = {}) {
  try {
    let buf;
    if (bytes) buf = Buffer.from(bytes);
    else try { buf = fs.readFileSync(brainPath); } catch { return { saved: false, skipped: 'no-current-file' }; }
    if (!buf.length) return { saved: false, skipped: 'empty' };

    const dir = historyDirFor(brainPath, home);
    const entries = readEntries(dir);
    const sha = sha256(buf);
    const sha8 = sha.slice(0, 8);

    // Content dedup: the newest snapshot already holds these exact bytes.
    if (entries.length && entries[0].sha8 === sha8 && entries[0].bytes === buf.length) {
      return { saved: false, skipped: 'unchanged' };
    }

    // Shrink beats throttle — a write that removes content is the whole point.
    const shrinking = nextBytes != null && buf.length > 0
      && (buf.length - nextBytes) / buf.length > SHRINK_RATIO;
    if (!force && !shrinking && entries.length && now - entries[0].ts < THROTTLE_MS) {
      return { saved: false, skipped: 'throttled' };
    }

    fs.mkdirSync(dir, { recursive: true });
    const id = `${now}-${sha8}`;
    const dest = path.join(dir, `${id}.klypix`);
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, dest); }
    catch (err) {
      try { fs.renameSync(tmp, dest); }
      catch { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
    }

    // Remember where this came from (so `list` can name it even after the
    // project moves) and why each point exists.
    try {
      const metaPath = path.join(dir, 'source.json');
      let meta = { path: canonPath(brainPath), reasons: {} };
      try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch { /* first write */ }
      meta.path = canonPath(brainPath);
      meta.reasons = { ...(meta.reasons || {}), [id]: shrinking ? `${reason}+shrink` : reason };
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch { /* metadata is a convenience, never a blocker */ }

    pruneBrainHistory(brainPath, { home, now });
    return { saved: true, id, path: dest, bytes: buf.length, shrinking };
  } catch (err) {
    return { saved: false, skipped: 'error', error: String(err?.message || err) };
  }
}

function replaceFile(brainPath, buf) {
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  const tmp = `${brainPath}.restore-tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  try { fs.renameSync(tmp, brainPath); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
}

// The merge engine and the shared lock load LAZILY, each on its own. This
// module is itself loaded lazily by klypix-format, and a static import that
// failed (an old install missing a file) would take restore points down
// everywhere. "The import worked" is not the test either: a 1.86 merge-brains
// loads fine and has no restore merge, so the feature flag decides.
async function loadRestoreMerge() {
  let eng = null;
  let lock = null;
  try { eng = await import(new URL('./merge-brains.mjs', import.meta.url)); } catch { /* older or partial install */ }
  try { lock = await import(new URL('./brain-write-lock.mjs', import.meta.url)); } catch { /* older or partial install */ }
  const ready = typeof eng?.restoreSnapshotAsMerge === 'function'
    && eng.MERGE_ENGINE_FEATURES?.restoreAsMerge === true
    && typeof lock?.withAdvisoryWriteLock === 'function'
    && typeof lock?.brainCaptureLockPath === 'function';
  return ready ? { eng, lock } : null;
}

/**
 * Put a restore point back. Snapshots the CURRENT file first (reason
 * 'pre-restore') so a restore is never the destructive act. Verifies the
 * snapshot still parses as a canvas before touching anything, if a parser is
 * supplied — a corrupt restore point must not replace a working brain.
 *
 * A restore is a MERGE, not a file copy (mode 'merge'). Replacing the file
 * would make every card written since the snapshot vanish with no trace, and
 * Brain Sync, the git driver and the open app would then read those absences
 * as deletes of cards nobody deleted — or bring deleted cards back as if they
 * were new. So the snapshot's cards come back (under a new id when the old id
 * has a deletion on record), later cards go to Deleted cards with a receipt
 * saying why, and permanently deleted cards stay deleted unless
 * `includePurged`. It runs under the brain's shared write lock.
 *
 * Whole-file writes remain for two cases: the brain file is gone ('recreate'),
 * or this install has no restore merge ('whole-file').
 */
export async function restoreBrainSnapshot(brainPath, id, { home = os.homedir(), now = Date.now(), parse = null, includePurged = false } = {}) {
  const dir = historyDirFor(brainPath, home);
  const entry = readEntries(dir).find((e) => e.id === id || e.id.startsWith(id));
  if (!entry) return { ok: false, error: `no restore point matching "${id}"` };
  let buf;
  try { buf = fs.readFileSync(entry.file); } catch (err) { return { ok: false, error: `unreadable restore point: ${err?.message || err}` }; }
  if (typeof parse === 'function') {
    try { await parse(buf); }
    catch (err) { return { ok: false, error: `restore point does not parse as a canvas: ${err?.message || err}` }; }
  }

  const exists = fs.existsSync(brainPath);
  const merger = exists ? await loadRestoreMerge() : null;
  // The undo point. When the brain already equals the newest restore point,
  // snapshotBrain dedups and saves nothing, and that newest point IS the undo.
  const takeSafety = () => {
    const s = snapshotBrain(brainPath, { home, reason: 'pre-restore', now, force: true });
    return s.id || (s.skipped === 'unchanged' ? readEntries(dir)[0]?.id : null) || null;
  };

  if (!merger) {
    const safetyId = takeSafety();
    try { replaceFile(brainPath, buf); }
    catch (err) { return { ok: false, error: `write failed: ${err?.message || err}`, safetyId }; }
    return { ok: true, mode: exists ? 'whole-file' : 'recreate', restoredFrom: entry.id, bytes: buf.length, safetyId };
  }

  const { eng, lock } = merger;
  // Out here, so a lock that throws still reports whatever undo point was taken.
  let safetyId = null;
  try {
    return await lock.withAdvisoryWriteLock(lock.brainCaptureLockPath(brainPath), async (locked) => {
      if (!locked) {
        return { ok: false, error: 'busy: another writer holds the brain lock; nothing was changed, try again in a moment', safetyId: null };
      }
      // Inside the lock, so the undo point is exactly the state this merge
      // starts from — no writer can slip in between the two.
      safetyId = takeSafety();
      let current;
      try { current = fs.readFileSync(brainPath); }
      catch (err) { return { ok: false, error: `the brain could not be read: ${err?.message || err}`, safetyId }; }
      let res;
      try { res = await eng.restoreSnapshotAsMerge({ current, snapshot: buf, includePurged, now }); }
      catch (err) { return { ok: false, error: `restore merge failed, nothing was changed: ${err?.message || err}`, safetyId }; }
      try { replaceFile(brainPath, res.buffer); }
      catch (err) { return { ok: false, error: `write failed: ${err?.message || err}`, safetyId }; }
      return {
        ok: true,
        mode: 'merge',
        restoredFrom: entry.id,
        bytes: res.buffer.length,
        safetyId,
        reverted: res.reverted,
        restored: res.restored,
        revived: res.revived,
        buried: res.buried,
        keptPurged: res.keptPurged,
      };
    });
  } catch (err) {
    return { ok: false, error: `restore failed: ${err?.message || err}`, safetyId };
  }
}
