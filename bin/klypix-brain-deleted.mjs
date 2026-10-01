#!/usr/bin/env node
// `klypix-mcp brain-deleted [list|restore <id…>|purge] [--brain <path>]`
// The recycle bin for a brain: cards a human deleted are kept recoverable
// instead of destroyed. Standalone: node bin/klypix-brain-deleted.mjs <args>
//
// Receipts (1.88): "Delete permanently" keeps a content-free receipt in the bin
// so every other copy of the brain drops the card too (see brain-graveyard.mjs).
// Receipts are not deleted cards — `list` hides them, restore refuses them, and
// `list <id>` names what happened to one.
//
// Every write re-reads the brain INSIDE the capture lock and refuses when the
// lock is held: reading outside it and writing later would silently roll back
// a capture (or a desktop save) that landed in between.
import fs from 'fs';
import path from 'path';
import { listGraveyard, purgeGraveyard, readGraveyardCard, restoreFromGraveyard, DEFAULT_RETENTION_DAYS } from '../src/brain-graveyard.mjs';
import { atomicWrite } from '../src/klypix-format.mjs';
import { brainCaptureLockPath, withAdvisoryWriteLock } from '../src/brain-write-lock.mjs';
import { snapshotBrain } from '../src/brain-history.mjs';

const argv = process.argv.slice(2).filter((a) => a !== 'brain-deleted');
const action = ['list', 'restore', 'purge'].includes(argv[0]) ? argv.shift() : 'list';
const brainIdx = argv.indexOf('--brain');
const brainPath = path.resolve(brainIdx >= 0 && argv[brainIdx + 1] ? argv.splice(brainIdx, 2)[1] : 'brain.klypix');
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv.splice(i, 2)[1] ?? '') : null; };
const olderThan = flag('--older-than');
const all = argv.includes('--all');
const ids = argv.filter((a) => !a.startsWith('-'));

if (!fs.existsSync(brainPath)) { console.error(`No brain at ${brainPath}.`); process.exit(1); }

const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000));
  if (!ts) return 'unknown';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

// Read-modify-write under the capture lock. `mutate(buf)` returns
// { buffer?, ...report }; no buffer means nothing to write.
async function lockedWrite(reason, mutate, { forceSnapshot = false } = {}) {
  return withAdvisoryWriteLock(brainCaptureLockPath(brainPath), async (locked) => {
    if (!locked) return { busy: true };
    const report = await mutate(fs.readFileSync(brainPath));
    if (!report.buffer) return report;
    if (forceSnapshot) {
      // The one irreversible action gets a restore point that no throttle may
      // skip, taken inside the lock so it holds exactly the bytes replaced.
      try { snapshotBrain(brainPath, { reason, force: true }); } catch { /* best-effort by contract */ }
      await atomicWrite(brainPath, report.buffer, { reason, snapshot: false });
    } else {
      await atomicWrite(brainPath, report.buffer, { reason });
    }
    return report;
  });
}
const refuseBusy = () => {
  console.error('The brain is busy (another writer holds the capture lock) — retry in a moment. Nothing written.');
  process.exit(1);
};

if (action === 'list') {
  const buf = fs.readFileSync(brainPath);
  const everything = await listGraveyard(buf, { receipts: 'include' });
  // A receipt asked for by id: say what happened to it rather than "not found".
  for (const e of everything) {
    if (!ids.includes(e.id) || e.kind === 'deleted') continue;
    console.log(e.kind === 'restored'
      ? `  ${e.id}   restored as ${e.restoredAs} ${ago(e.restoredAt || e.deletedAt)} — it is live under that id`
      : `  ${e.id}   permanently deleted ${ago(e.purgedAt || e.deletedAt)} — its text is gone from this file (an image or file attached to it is not)`);
  }
  const entries = everything.filter((e) => e.kind === 'deleted');
  if (!entries.length) {
    console.log(`Nothing deleted from ${path.basename(brainPath)}.`);
    console.log('Cards you delete from a brain are kept here, recoverable, instead of destroyed.');
    process.exit(0);
  }
  console.log(`${entries.length} deleted card(s) in ${path.basename(brainPath)} — newest first\n`);
  for (const e of entries) {
    const full = ids.includes(e.id) ? await readGraveyardCard(buf, e.id) : null;
    const label = e.summary?.label || e.preview || `(${e.summary?.type || 'unknown'} item)`;
    const audit = e.deletion?.confidence === 'legacy'
      ? 'legacy source unverified'
      : `${e.deletion?.initiator || 'unknown'} via ${e.deletion?.cause || 'unclassified'}`;
    console.log(`  ${e.id}   ${ago(e.deletedAt).padEnd(9)} ${e.area ? `[${e.area}] ` : ''}${label}   <${audit}>`);
    if (full?.content) console.log(`\n${String(full.content).split('\n').map((l) => `      ${l}`).join('\n')}\n`);
    else if (full) console.log(`\n      ${JSON.stringify(e.summary || { type: full.type || 'unknown' })}\n`);
  }
  console.log(`\nFull text:  npx klypix-mcp brain-deleted list <id> --brain "${brainPath}"`);
  console.log(`Restore:    npx klypix-mcp brain-deleted restore <id>`);
  console.log(`Purge:      npx klypix-mcp brain-deleted purge --older-than ${DEFAULT_RETENTION_DAYS}d   (or: purge <id>, purge --all)`);
  process.exit(0);
}

if (action === 'restore') {
  if (!ids.length) { console.error('Usage: brain-deleted restore <id…>   (ids from `brain-deleted list`)'); process.exit(2); }
  const res = await lockedWrite('graveyard-restore', async (buf) => {
    const r = await restoreFromGraveyard(buf, ids);
    return r.restored.length ? r : { restored: [], skipped: r.skipped };
  });
  if (res.busy) refuseBusy();
  if (!res.restored.length) {
    for (const s of res.skipped) console.error(`  ${s.id}: ${s.reason}`);
    console.error('Nothing restored.');
    process.exit(1);
  }
  for (const r of res.restored) {
    const as = r.restoredAs && r.restoredAs !== r.id ? ` as ${r.restoredAs}` : '';
    console.log(r.already
      ? `${r.id} is already back${as}`
      : `Restored ${r.id}${as}${r.reparented ? ' (its container is gone — placed at the canvas root)' : ''}`);
  }
  for (const s of res.skipped) console.log(`Skipped ${s.id}: ${s.reason}`);
  console.log('If the app has this brain OPEN, close and reopen the tab so it sees the restored card.');
  process.exit(0);
}

// purge
if (!ids.length && !all && !olderThan) {
  console.error(`Usage: brain-deleted purge --older-than ${DEFAULT_RETENTION_DAYS}d | purge <id…> | purge --all`);
  console.error('Purge is permanent. A restore point is written first (npx klypix-mcp brain-history list).');
  process.exit(2);
}
const days = olderThan ? Number(String(olderThan).replace(/d$/i, '')) : null;
if (olderThan && !Number.isFinite(days)) { console.error(`--older-than expects days, e.g. --older-than ${DEFAULT_RETENTION_DAYS}d`); process.exit(2); }
const res = await lockedWrite('graveyard-purge', async (buf) => {
  const r = await purgeGraveyard(buf, {
    // --all means every deleted card; receipts hold nothing left to purge.
    ids: ids.length ? ids : (all ? (await listGraveyard(buf, { receipts: 'hide' })).map((e) => e.id) : null),
    olderThanDays: ids.length || all ? null : days,
  });
  return r.purged.length ? r : { purged: [] };
}, { forceSnapshot: true });
if (res.busy) refuseBusy();
if (!res.purged.length) { console.log('Nothing matched — nothing purged.'); process.exit(0); }
console.log(`Purged ${res.purged.length} deleted card(s) permanently from ${path.basename(brainPath)}.`);
console.log('The delete itself is kept as a receipt with no content, so copies that sync with this version or later drop the card too.');
console.log('An edit of it that a merge kept as a separate card elsewhere is not removed: purge that card as well.');
console.log('Not its attachments: an image or file a purged card held stays in the brain\'s assets, in this file and every copy.');
console.log('Note: this removes them from the file, not from git history — a secret committed earlier is still in past commits.');
console.log(`The pre-purge state is a restore point, and the only undo: npx klypix-mcp brain-history list --brain "${brainPath}"`);
