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
//   { "cards": [{ "text": "...", "heading"?, "color"? }],
//     "connections": [{ "from": <idx|title>, "to": <idx|title>, "relationship"? }] }
//   from/to may reference a NEW card (by index in this addition, or its title)
//   or an EXISTING card already on the canvas (by its title). New cards land in
//   a column just to the right of the current content, stacked on top.

import fs from 'fs';
import { appendToKlypix, atomicWrite } from '../src/klypix-format.mjs';

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

let buf;
try {
    buf = await appendToKlypix(fs.readFileSync(file), addition);
} catch (e) { console.error(e.message); process.exit(1); }

await atomicWrite(file, buf);
const cardCount = Array.isArray(addition.cards) ? addition.cards.length : 0;
const connCount = Array.isArray(addition.connections) ? addition.connections.length : 0;
console.log(`Appended ${cardCount} card(s), ${connCount} connection(s) to ${file}.`);
console.log(`Reopen it in KLYPIX, or verify: node scripts/read-klypix.mjs "${file}"`);
