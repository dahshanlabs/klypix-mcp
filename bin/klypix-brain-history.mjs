#!/usr/bin/env node
// `klypix-mcp brain-history [list|restore <id>|prune] [--brain <path>]`
// The human surface for brain restore points. Protection nobody can see is
// protection nobody trusts, so `list` is the default and it says plainly what
// each point would give back.
import fs from 'fs';
import path from 'path';
import { listBrainHistory, pruneBrainHistory, restoreBrainSnapshot, historyDirFor } from '../src/brain-history.mjs';

const argv = process.argv.slice(2).filter((a) => a !== 'brain-history');
const action = ['list', 'restore', 'prune'].includes(argv[0]) ? argv.shift() : 'list';
const brainIdx = argv.indexOf('--brain');
const brainPath = path.resolve(brainIdx >= 0 && argv[brainIdx + 1] ? argv.splice(brainIdx, 2)[1] : 'brain.klypix');
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
  console.log('Restoring snapshots the current file first, so it is itself undoable.');
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
  console.error('Usage: npx klypix-mcp brain-history restore <id> [--brain <path>]');
  console.error('Run `npx klypix-mcp brain-history list` to see the ids.');
  process.exit(2);
}
const { parseKlypix } = await import('../src/klypix-format.mjs');
const res = await restoreBrainSnapshot(brainPath, id, { parse: parseKlypix });
if (!res.ok) { console.error(`Restore failed: ${res.error}`); process.exit(1); }
console.log(`Restored ${brainPath} from ${res.restoredFrom} (${kb(res.bytes)}).`);
if (res.safetyId) console.log(`The state you just replaced was saved as ${res.safetyId} — undo with: npx klypix-mcp brain-history restore ${res.safetyId}`);
console.log('If the app has this brain OPEN, close and reopen the tab: its in-memory copy is now older than disk and a save would merge it back.');
