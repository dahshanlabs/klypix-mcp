// Verify the DESKTOP-BUNDLED MCP server (the flat scripts/klypix-mcp-server.mjs
// the installer copies to ~/.claude/project-brain) is behavior-identical to the
// canonical baseline. Drives the bundled file through the same tool sequence and
// diffs against test/baseline.json — proving the sync produced a faithful copy
// that boots and behaves the same in its flat layout.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeVault, seedBrain, seedRoadmap, driveServer } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'baseline.json');
// The bundled server lives in the desktop repo (a sibling of this standalone repo).
const BUNDLED = process.argv[2]
  || process.env.KLYPIX_BUNDLED_SERVER
  || path.resolve(__dirname, '..', '..', 'KLYPIX', 'scripts', 'klypix-mcp-server.mjs');

if (!fs.existsSync(BUNDLED)) { console.error(`✗ bundled server not found: ${BUNDLED}`); process.exit(2); }
if (!fs.existsSync(BASELINE)) { console.error('✗ baseline.json missing — run `node test/snapshot.mjs baseline` first.'); process.exit(2); }

const vault = makeVault();
await seedBrain(vault);
await seedRoadmap(vault);
const result = await driveServer(vault, BUNDLED);
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

let diffs = 0;
for (const k of new Set([...Object.keys(base), ...Object.keys(result)])) {
  if (base[k] !== result[k]) {
    diffs++;
    console.log(`\n✗ DIFF [${k}]\n--- baseline ---\n${base[k] ?? '(absent)'}\n--- bundled  ---\n${result[k] ?? '(absent)'}`);
  }
}
console.log(diffs === 0
  ? `✓ BUNDLED PARITY: all ${Object.keys(result).length} tool outputs identical to canonical baseline (${path.basename(BUNDLED)})`
  : `\n✗ ${diffs} difference(s) — bundled server diverges from baseline.`);
process.exit(diffs === 0 ? 0 : 1);
