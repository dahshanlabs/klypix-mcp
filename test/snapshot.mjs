// Capture (or compare) normalized MCP tool outputs. Run with `baseline` to save
// the pre-refactor snapshot, then with no arg to diff the current code against it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeVault, seedBrain, seedRoadmap, driveServer } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(__dirname, 'baseline.json');
const mode = process.argv[2];

const vault = makeVault();
await seedBrain(vault);
await seedRoadmap(vault);
const result = await driveServer(vault);

if (mode === 'baseline') {
  fs.writeFileSync(SNAP, JSON.stringify(result, null, 2));
  console.log('✓ baseline saved:', SNAP);
  console.log('labels:', Object.keys(result).join(', '));
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
let diffs = 0;
for (const k of new Set([...Object.keys(base), ...Object.keys(result)])) {
  if (base[k] !== result[k]) {
    diffs++;
    console.log(`\n✗ DIFF [${k}]`);
    console.log('--- baseline ---\n' + (base[k] ?? '(absent)'));
    console.log('--- current  ---\n' + (result[k] ?? '(absent)'));
  }
}
if (diffs === 0) console.log('✓ PARITY: all', Object.keys(result).length, 'tool outputs identical to baseline.');
else console.log(`\n✗ ${diffs} difference(s) vs baseline.`);
process.exit(diffs === 0 ? 0 : 1);
