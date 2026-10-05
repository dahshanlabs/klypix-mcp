#!/usr/bin/env node
// append-klypix — add cards (+ optional connections) to an EXISTING .klypix,
// preserving every existing item and its position. The CLI twin of the MCP
// server's add_to_canvas; both use appendToKlypix() in ./klypix-format.mjs.
//
// This is what lets a canvas be a *living* brain: read it, then append new
// decisions/findings as connected cards without rebuilding or moving anything.
//
// Usage:
//   node scripts/append-klypix.mjs <file.klypix> <addition.json>
//   echo '<addition>' | node scripts/append-klypix.mjs <file.klypix>
//
// addition:
//   { "cards": [{ "text": "...", "heading"?, "color"?, "group"?, "border"? }],
//     "connections": [{ "from": <idx|title>, "to": <idx|title>, "relationship"? }] }
//   from/to may reference a NEW card (by index in this addition, or its title)
//   or an EXISTING card already on the canvas (by its title). New cards land in
//   a column just to the right of the current content, stacked on top.
//
// Like add_to_canvas it honours the KLYPIX lease (src/app-lease.mjs): a canvas
// that is open in KLYPIX is refused and left byte-identical (project brains are
// the exception — KLYPIX merges them), and on Windows with no lease file it
// writes and prints the step that keeps the cards if the canvas IS open.

import fs from 'fs';
import path from 'path';
import { appendToKlypix, atomicWrite, readManifestCheap } from '../src/klypix-format.mjs';
import { brainCaptureLockPath, withAdvisoryWriteLock } from '../src/brain-write-lock.mjs';
import { canvasWriteLockPath, leaseVerdict, tellUser, LEASE_SINCE_APP_VERSION } from '../src/app-lease.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const additionPath = args.filter(a => !a.startsWith('--'))[1];
if (!file) { console.error('Usage: node append-klypix.mjs <file.klypix> <addition.json>'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(2); }

let addition;
try {
    const raw = additionPath ? fs.readFileSync(additionPath, 'utf8') : fs.readFileSync(0, 'utf8');
    addition = JSON.parse(raw);
} catch (e) { console.error('Addition is not valid JSON:', e.message); process.exit(2); }

// A project brain: by file name, or by the manifest's explicit kind (a renamed brain).
const manifest = readManifestCheap(file);
const isBrain = /^brain\.(klypix|any)$/i.test(path.basename(file)) || manifest?.kind === 'brain';
const title = (manifest && typeof manifest.title === 'string' && manifest.title.trim()) || path.basename(file).replace(/\.(klypix|any)$/i, '');

// Read-modify-write under the SAME cross-process lock as the MCP engine:
// brains share the hooks' and desktop app's folder lock; an ordinary canvas
// locks in the profile, so no `.claude` folder appears beside it. Racing them
// unlocked is silent last-writer-wins loss. The callback only RETURNS — exiting
// inside it would skip the lock's release.
const outcome = await withAdvisoryWriteLock(isBrain ? brainCaptureLockPath(file) : canvasWriteLockPath(file), async (locked) => {
    if (!locked) return { status: 'busy' };
    const verdict = isBrain ? { action: 'write' } : leaseVerdict(file);
    if (verdict.action === 'refuse') return { status: 'open' };
    let buf;
    try {
        buf = await appendToKlypix(fs.readFileSync(file), addition);
    } catch (e) { return { status: 'failed', message: e.message, code: e.code }; }
    await atomicWrite(file, buf, { isBrain, restorePoint: !isBrain, reason: 'klypix-append' });
    return { status: 'written', warn: verdict.action === 'warn' };
}, { tries: 100, waitMs: 60 });

if (outcome.status === 'busy') {
    console.error('append-klypix refused (file unchanged): the write lock is held by another writer — retry in a moment.');
    process.exit(1);
}
if (outcome.status === 'open') {
    console.error(`append-klypix refused (file unchanged): '${title}' is open in KLYPIX right now (code OPEN_IN_APP).`);
    console.error(`Tell the user: ${tellUser('OPEN_IN_APP', { canvas: title })}`);
    process.exit(1);
}
if (outcome.status === 'failed') {
    console.error(outcome.message);
    if (outcome.code === 'SCOPE_LOCKED' || outcome.code === 'FROZEN') console.error(`Tell the user: ${tellUser(outcome.code)}`);
    process.exit(1);
}
const cardCount = Array.isArray(addition.cards) ? addition.cards.length : 0;
const connCount = Array.isArray(addition.connections) ? addition.connections.length : 0;
console.log(`Appended ${cardCount} card(s), ${connCount} connection(s) to ${file}.`);
console.log(isBrain
    ? `It appears in the brain if it is open in KLYPIX (inside OneDrive or Dropbox, when you next open it). Verify: node scripts/read-klypix.mjs "${file}"`
    : `They appear when the canvas is next opened in KLYPIX. Verify: node scripts/read-klypix.mjs "${file}"`);
if (outcome.warn) console.log(`Tell the user: ${tellUser('MAY_BE_OPEN', { canvas: title, version: LEASE_SINCE_APP_VERSION })}`);
