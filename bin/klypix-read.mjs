#!/usr/bin/env node
// read-klypix — turn a .klypix (or legacy .any) file into structured markdown
// an AI agent can fully understand: every card's text, the connection graph,
// [[wikilinks]] + #tags, and a manifest of images/files (with extracted paths
// so the agent can read images with vision).
//
// This is the reference CLI behind the `read-klypix` Claude Code skill. The
// actual parsing lives in ./klypix-format.mjs (shared with write-klypix and the
// MCP server) so the format logic has exactly one home.
//
// Usage:
//   node scripts/read-klypix.mjs <file.klypix> [--assets <outDir>] [--json]
//     --assets <dir>  extract binary assets (images/files) into <dir>
//     --json          emit a structured JSON object instead of markdown

import fs from 'fs';
import path from 'path';
import { parseKlypix, structToMarkdown } from '../src/klypix-format.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const assetsDir = (() => { const i = args.indexOf('--assets'); return i >= 0 ? args[i + 1] : null; })();
const asJson = args.includes('--json');
if (!file) { console.error('Usage: node read-klypix.mjs <file.klypix> [--assets <dir>] [--json]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(2); }

let parsed;
try {
    parsed = await parseKlypix(fs.readFileSync(file));
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
const { struct, zip, assetPaths } = parsed;
// Fall back to the filename for the title when the file didn't store one.
if (!struct.title || struct.title === 'Untitled') {
    struct.title = path.basename(file).replace(/\.(klypix|any)$/i, '');
}

// Optionally extract binary assets so the agent can open images with vision.
if (assetsDir && assetPaths.length) {
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const p of assetPaths) {
        const bytes = await zip.file(p).async('nodebuffer');
        fs.writeFileSync(path.join(assetsDir, path.basename(p)), bytes);
    }
}

if (asJson) { console.log(JSON.stringify(struct, null, 2)); process.exit(0); }
console.log(structToMarkdown(struct, { assetsDir }));
