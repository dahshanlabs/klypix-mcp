// Concurrency-critical merge regressions found by the 2026-08-01 audit.
// Pure buffers only: no real brain, filesystem, network, or clock state.
import { buildKlypix, parseKlypix, shard } from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const base = await buildKlypix({
  title: 'merge concurrency',
  cards: [
    { id: 'txt_A', text: 'A — original' },
    { id: 'txt_B', text: 'B — delete target' },
  ],
});

const changeItem = async (buffer, id, mutate) => {
  const { zip } = await parseKlypix(buffer);
  const itemPath = `items/${shard(id)}/${id}.json`;
  const item = JSON.parse(await zip.file(itemPath).async('string'));
  zip.file(itemPath, JSON.stringify(mutate(item)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

const removeItem = async (buffer, id) => {
  const { zip, canvas } = await parseKlypix(buffer);
  zip.remove(`items/${shard(id)}/${id}.json`);
  canvas.order = (canvas.order || []).filter((itemId) => itemId !== id);
  if (canvas.positions) delete canvas.positions[id];
  zip.file('canvas.json', JSON.stringify(canvas));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

// G2: a missing baseline gives no evidence for choosing either divergent
// meaning. Both must survive, and the conflict must be explicit.
{
  const ours = await changeItem(base, 'txt_A', (item) => ({ ...item, content: 'A — OURS on first sync' }));
  const theirs = await changeItem(base, 'txt_A', (item) => ({ ...item, content: 'A — THEIRS on first sync' }));
  const result = await mergeBrains({ base: null, ours, theirs });
  const { struct } = await parseKlypix(result.buffer);
  const texts = struct.cards.map((card) => card.text || '');

  ok(texts.some((text) => text.includes('OURS on first sync')),
    'G2: null-base divergence keeps ours live');
  ok(texts.some((text) => text.includes('THEIRS on first sync')),
    'G2: null-base divergence preserves theirs as a conflict twin');
  ok(result.conflicts.some((conflict) => conflict.id === 'txt_A' && conflict.kind === 'content-no-base'),
    'G2: null-base divergence is reported, never silently resolved');
}

// G3: a touch timestamp and key-order rewrite do not turn an untouched survivor
// into delete-vs-edit. The explicit tombstone must be honored exactly once.
{
  const ours = await removeItem(base, 'txt_B');
  const theirs = await changeItem(base, 'txt_B', (item) => {
    const { content, ...rest } = item;
    return { updatedAt: 1900000000002, content, ...rest };
  });
  const result = await mergeBrains({ base, ours, theirs, deletedIds: ['txt_B'] });
  const { struct } = await parseKlypix(result.buffer);

  ok(!struct.cards.some((card) => card.id === 'txt_B'),
    'G3: delete vs semantic no-op honors the delete');
  ok(result.delta.removed.length === 1 && result.delta.removed[0] === 'txt_B',
    'G3: the delete receipt reports one honored delete');
  ok(result.conflicts.length === 0 && result.stats.removed === 1,
    'G3: no bogus conflict twin or negative delete accounting');
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-brains: all assertions passed');
process.exit(failures ? 1 : 0);
