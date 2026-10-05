#!/usr/bin/env node
// write-klypix — assemble a real .klypix canvas from a simple JSON spec.
// The reverse of read-klypix. The build logic (content-aware sizing, BFS
// layout, v4 ZIP output) lives in ./klypix-format.mjs (shared with the MCP
// server) so it has exactly one home.
//
// Usage:
//   node scripts/write-klypix.mjs <spec.json> [--out <file.klypix>] [--force]
//   cat spec.json | node scripts/write-klypix.mjs --out board.klypix
//
// Spec:
//   { "title": "...", "cards": [{ "text": "...", "heading"?, "color"?, "group"? }],
//     "connections": [{ "from": 0, "to": 1, "relationship"? }],
//     "groups": [{ "title": "Part 1", "cards": [0, 1, 2], "color"?, "columns"?, "width"? }] }
//   from/to (and group members) reference a card by INDEX, id, or its title
//   (first line). relationship ∈ leads_to | depends_on | relates_to |
//   conflicts_with | supports | questions | costs | blocks.
//   groups: anything read IN ORDER (steps, phases, sections) — each becomes a
//   titled box with its cards stacked in the order listed, boxes left-to-right.
//   Loose cards keep the connection-driven grid, as a band above the boxes.
//
// It never replaces an existing file unless you pass --force, and even then
// not a canvas that is open in KLYPIX (the KLYPIX lease, src/app-lease.mjs).

import fs from 'fs';
import path from 'path';
import { buildKlypix, atomicWrite, readManifestCheap } from '../src/klypix-format.mjs';
import { leaseVerdict, tellUser, LEASE_SINCE_APP_VERSION } from '../src/app-lease.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outArg = outIdx >= 0 ? args[outIdx + 1] : null;
const force = args.includes('--force');
// The spec path is the first POSITIONAL arg that isn't a flag AND isn't the
// value consumed by --out (else `--out x.klypix` with stdin spec mis-reads x as
// the spec). null → read the spec from stdin.
const specPath = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) || null;

let spec;
try {
    const raw = specPath ? fs.readFileSync(specPath, 'utf8') : fs.readFileSync(0, 'utf8');
    spec = JSON.parse(raw);
} catch (e) { console.error('Spec is not valid JSON:', e.message); process.exit(2); }

let buf;
try {
    buf = await buildKlypix(spec);
} catch (e) { console.error(e.message); process.exit(2); }

const outPath = outArg || `${(spec.title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled'}.klypix`;
let mayBeOpen = null;
if (fs.existsSync(outPath)) {
    // Replacing a canvas is destructive: every card on it is gone. Say so and
    // stop unless the caller asked for it.
    if (!force) {
        console.error(`write-klypix refused (file unchanged): ${outPath} already exists. Pass --force to replace it, or choose another --out.`);
        process.exit(1);
    }
    const existing = readManifestCheap(outPath);
    const shown = (existing && typeof existing.title === 'string' && existing.title.trim()) || path.basename(outPath).replace(/\.(klypix|any)$/i, '');
    const verdict = leaseVerdict(outPath);
    if (verdict.action === 'refuse') {
        console.error(`write-klypix refused (file unchanged): '${shown}' is open in KLYPIX right now (code OPEN_IN_APP).`);
        console.error(`Tell the user: ${tellUser('OPEN_IN_APP', { canvas: shown })}`);
        process.exit(1);
    }
    if (verdict.action === 'warn') mayBeOpen = shown;
}
await atomicWrite(outPath, buf);
const cardCount = spec.cards.length;
const connCount = Array.isArray(spec.connections) ? spec.connections.length : 0;
const groupCount = Array.isArray(spec.groups) ? spec.groups.length : 0;
console.log(`Wrote ${outPath} — ${cardCount} cards, ${connCount} connections${groupCount ? `, ${groupCount} group box${groupCount === 1 ? '' : 'es'}` : ''}.`);
console.log(`Open it in the KLYPIX app (Canvas → Open), or verify: node scripts/read-klypix.mjs "${outPath}"`);
if (mayBeOpen) console.log(`Tell the user: ${tellUser('MAY_BE_OPEN', { canvas: mayBeOpen, version: LEASE_SINCE_APP_VERSION })}`);
