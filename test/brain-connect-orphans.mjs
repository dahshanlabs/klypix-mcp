// Orphan-first graph gardening: dry-run receipts, additive apply, no archival.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addBrainConnections,
  brainInsights,
  buildKlypixMap,
  parseKlypix,
} from '../src/klypix-format.mjs';
import { opBrainConnect } from '../src/klypix-core.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};
const blockText = (result) => (result.blocks || []).map(block => block.text || '').join('\n');

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-orphan-connect-'));
const file = path.join(vault, 'brain.klypix');
try {
  let buffer = await buildKlypixMap({
    title: 'brain',
    areas: [{
      title: 'Decisions',
      cards: [
        { text: 'Auth: session rotation is implemented in the token service.\n#auth' },
        { text: 'Auth: token refresh is documented in the security guide.\n#auth' },
        { text: 'Auth: refresh failures emit a user-visible recovery receipt.\n#auth' },
        { text: 'Canvas: pencil smoothing uses a pressure-aware curve.\n#drawing' },
      ],
    }],
  });
  let { struct } = await parseKlypix(buffer);
  const cards = struct.cards.filter(card => card.type !== 'container');
  ({ buffer } = await addBrainConnections(buffer, [{ fromId: cards[0].id, toId: cards[1].id, relationship: 'relates_to' }]));
  fs.writeFileSync(file, buffer);

  ({ struct } = await parseKlypix(buffer));
  ok(brainInsights(struct).orphans.length === 2, 'orphan fixture starts with exactly two isolated decisions');

  // threshold=1 forces the deterministic structural fallback in this fixture.
  const dry = await opBrainConnect({ vault, scope: 'orphans', threshold: 1, max: 1 });
  const dryText = blockText(dry);
  ok(/Orphan receipt: 2 now → 1 projected/.test(dryText), 'dry run reports measured before→projected orphan counts');
  ok(/Additive only: no cards are archived or rewritten/.test(dryText), 'dry run states the reversible, non-archival contract');

  const applied = await opBrainConnect({ vault, scope: 'orphans', threshold: 1, max: 1, apply: true });
  const appliedText = blockText(applied);
  const after = (await parseKlypix(fs.readFileSync(file))).struct;
  ok(brainInsights(after).orphans.length === 1, 'apply repairs one reviewed orphan and leaves the unrelated orphan alone');
  ok(/Orphan receipt: 2 → 1 \(1 repaired\)/.test(appliedText), 'apply reports the measured after count');
  ok(after.cards.some(card => /pressure-aware curve/.test(card.text || '') && !/^archive$/i.test(card.area || '')),
    'apply never archives or rewrites the unrelated orphan');
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ brain-connect-orphans: all assertions passed');
