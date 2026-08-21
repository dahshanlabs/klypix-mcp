// Concurrency-critical merge regressions found by the 2026-08-01 audit.
// Pure buffers only: no real brain, filesystem, network, or clock state.
import { buildKlypix, parseKlypix, shard } from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';
import { listGraveyard } from '../src/brain-graveyard.mjs';

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

// G3b: editedAt is volatile like updatedAt — an edit-then-undo cycle (or two
// apps stamping at different moments) leaves content identical while the
// authored-edit stamp differs. On a null-base first sync (the exact shape that
// spawned the historical updatedAt twins) that must not create a conflict twin.
{
  const ours = await changeItem(base, 'txt_A', (item) => ({ ...item, editedAt: 1900000000001 }));
  const theirs = await changeItem(base, 'txt_A', (item) => ({ ...item, editedAt: 1900000000777 }));
  const result = await mergeBrains({ base: null, ours, theirs });
  const { struct } = await parseKlypix(result.buffer);

  ok(struct.cards.filter((card) => card.id === 'txt_A' || (card.text || '').includes('A — original')).length === 1,
    'G3b: editedAt-only divergence keeps a single card, no conflict twin');
  ok(result.conflicts.length === 0,
    'G3b: editedAt-only divergence is not reported as a conflict');
}

// G4: deletion provenance and type-aware previews survive the merge and are
// available before restore. Unknown callers stay unknown rather than being
// mislabeled as human.
{
  const ours = await removeItem(base, 'txt_B');
  const result = await mergeBrains({
    base,
    ours,
    theirs: base,
    deletedIds: ['txt_B'],
    deletedMeta: {
      txt_B: { initiator: 'user', cause: 'keyboard-delete', source: 'desktop', confidence: 'explicit' },
    },
  });
  const entries = await listGraveyard(result.buffer);
  const deleted = entries.find((entry) => entry.id === 'txt_B');

  ok(deleted?.deletion?.initiator === 'user' && deleted?.deletion?.cause === 'keyboard-delete',
    'G4: explicit deletion receipt persists with the buried item');
  ok(deleted?.summary?.type === 'text' && deleted?.summary?.label?.includes('delete target'),
    'G4: deleted item is type-aware and previewable before restore');
  const { struct: buriedStruct } = await parseKlypix(result.buffer);
  const indexed = buriedStruct.graveyard.find((entry) => entry.id === 'txt_B');
  ok(indexed?.summary?.type === 'text',
    'G4: preview summary is indexed so listing does not reopen every deleted item');

  const inferredResult = await mergeBrains({ base, ours, theirs: base, deletedIds: ['txt_B'] });
  const inferredEntries = await listGraveyard(inferredResult.buffer);
  const inferred = inferredEntries.find((entry) => entry.id === 'txt_B');
  ok(inferred?.deletion?.initiator === 'unknown' && inferred?.deletion?.confidence === 'inferred',
    'G4: missing provenance stays unknown instead of being guessed as human');
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-brains: all assertions passed');
process.exit(failures ? 1 : 0);
