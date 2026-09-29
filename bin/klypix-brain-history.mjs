#!/usr/bin/env node
// `klypix-mcp brain-history [list|restore <id> [--include-purged]|prune] [--brain <path>]`
// The human surface for brain restore points. Protection nobody can see is
// protection nobody trusts, so `list` is the default and it says plainly what
// each point would give back, and `restore` says what it changed.
import fs from 'fs';
import path from 'path';
import { listBrainHistory, pruneBrainHistory, restoreBrainSnapshot, historyDirFor } from '../src/brain-history.mjs';

const argv = process.argv.slice(2).filter((a) => a !== 'brain-history');
const action = ['list', 'restore', 'prune'].includes(argv[0]) ? argv.shift() : 'list';
const brainIdx = argv.indexOf('--brain');
const brainPath = path.resolve(brainIdx >= 0 && argv[brainIdx + 1] ? argv.splice(brainIdx, 2)[1] : 'brain.klypix');
const includePurged = argv.includes('--include-purged');
const positional = argv.filter((a) => !a.startsWith('-'));

const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;

// Card counts make a restore point meaningful ("this one still has the 14 cards
// you deleted"). Parsing ≤20 small zips is fine for a human-invoked command;
// a parse failure degrades to size only rather than failing the listing.
async function cardCount(file) {
  try {
    const { parseKlypix } = await import('../src/klypix-format.mjs');
    const { struct } = await parseKlypix(fs.readFileSync(file));
    return struct?.cards?.length ?? null;
  } catch { return null; }
}

if (action === 'list') {
  const entries = listBrainHistory(brainPath);
  if (!entries.length) {
    console.log(`No restore points for ${brainPath}.`);
    console.log(`They are written automatically before each brain write, to ${historyDirFor(brainPath)}.`);
    process.exit(0);
  }
  const liveExists = fs.existsSync(brainPath);
  const liveCards = liveExists ? await cardCount(brainPath) : null;
  console.log(`Restore points for ${brainPath}${liveExists ? '' : '  (the brain itself is MISSING — restore will recreate it)'}`);
  if (liveCards != null) console.log(`current: ${liveCards} cards, ${kb(fs.statSync(brainPath).size)}\n`);
  for (const e of entries) {
    const cards = await cardCount(e.file);
    const delta = cards != null && liveCards != null ? cards - liveCards : null;
    const deltaText = delta == null ? '' : delta > 0 ? `  (+${delta} cards vs now)` : delta < 0 ? `  (${delta} cards vs now)` : '  (same card count)';
    console.log(`  ${e.id}   ${ago(e.ts).padEnd(9)} ${String(cards ?? '?').padStart(5)} cards  ${kb(e.bytes).padStart(8)}${e.reason ? `  [${e.reason}]` : ''}${deltaText}`);
  }
  console.log(`\nRestore: npx klypix-mcp brain-history restore <id> --brain "${brainPath}"`);
  console.log("A restore brings that point's cards back and moves cards added since to Deleted cards.");
  console.log('It snapshots the current file first, so it is itself undoable.');
  process.exit(0);
}

if (action === 'prune') {
  const removed = pruneBrainHistory(brainPath);
  console.log(`Pruned ${removed} restore point(s) beyond the retention window (newest 20 + one per day for 14 days).`);
  process.exit(0);
}

// restore
const id = positional[0];
if (!id) {
  console.error('Usage: npx klypix-mcp brain-history restore <id> [--include-purged] [--brain <path>]');
  console.error('Run `npx klypix-mcp brain-history list` to see the ids.');
  process.exit(2);
}
const { parseKlypix } = await import('../src/klypix-format.mjs');
const res = await restoreBrainSnapshot(brainPath, id, { parse: parseKlypix, includePurged });
if (!res.ok) { console.error(`Restore failed: ${res.error}`); process.exit(1); }

const SHOW = 10;
const listIds = (ids, fmt = (x) => x) => {
  for (const x of ids.slice(0, SHOW)) console.log(`    ${fmt(x)}`);
  if (ids.length > SHOW) console.log(`    …and ${ids.length - SHOW} more`);
};
if (res.mode === 'merge') {
  const { reverted = [], restored = [], revived = [], buried = [], keptPurged = [] } = res;
  // Ids alone mean nothing to a person: show each card's first words, from the
  // live card or from its Deleted cards entry.
  const text = new Map();
  try {
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    for (const c of struct.cards || []) text.set(c.id, String(c.text || c.title || ''));
    for (const g of struct.graveyard || []) if (!text.has(g.id)) text.set(g.id, String(g.preview || ''));
  } catch { /* ids only */ }
  const said = (id) => {
    const s = (text.get(id) || '').replace(/\s+/g, ' ').trim();
    return s ? `${id}  "${s.length > 60 ? `${s.slice(0, 59)}…` : s}"` : id;
  };
  console.log(`Restored ${brainPath} from ${res.restoredFrom} (${kb(res.bytes)}), merged into the brain as it is now:`);
  if (reverted.length) {
    console.log(`  ${reverted.length} card(s) set back to how they were then:`);
    listIds(reverted, said);
  }
  if (restored.length) {
    console.log(`  ${restored.length} card(s) that had left with no record came back:`);
    listIds(restored, said);
  }
  if (revived.length) {
    console.log(`  ${revived.length} card(s) back from Deleted cards, under new ids so every copy agrees the old ones were deleted:`);
    listIds(revived, (r) => (r.already ? `${said(r.as)} (already back)` : said(r.as)));
  }
  if (buried.length) {
    console.log(`  ${buried.length} card(s) added since that point moved to Deleted cards:`);
    listIds(buried, said);
    console.log(`    Bring one back: npx klypix-mcp brain-deleted restore <id> --brain "${brainPath}"`);
  }
  if (keptPurged.length) {
    console.log(`  ${keptPurged.length} permanently deleted card(s) kept out:`);
    listIds(keptPurged);
    console.log('    Add --include-purged to bring them back too (under new ids).');
  }
  if (!reverted.length && !restored.length && !buried.length && !keptPurged.length && revived.every((r) => r.already)) {
    console.log('  The brain already matched that point; nothing changed.');
  }
} else if (res.mode === 'recreate') {
  console.log(`The brain file was missing. Recreated ${brainPath} from ${res.restoredFrom} (${kb(res.bytes)}).`);
} else {
  console.log(`Restored ${brainPath} from ${res.restoredFrom} (${kb(res.bytes)}).`);
  console.warn('Warning: the merge engine installed beside this command is older, so this restore replaced the whole file.');
  console.warn('Brain Sync and git will read the cards it removed as deletes. Update with: npx klypix-mcp install');
}
if (res.safetyId) console.log(`The state you just replaced was saved as ${res.safetyId} — undo with: npx klypix-mcp brain-history restore ${res.safetyId}`);
console.log('If the app has this brain OPEN, close and reopen the tab: its in-memory copy is now older than disk and a save would merge it back.');
