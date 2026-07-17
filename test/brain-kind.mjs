// manifest.kind === 'brain' — the explicit brain flag. Detection contract:
// kind OR brain.* filename; the flag survives renames and is retro-stamped by
// every brain-only write path. Run: node test/brain-kind.mjs (exit 0 = pass).
import { buildKlypix, buildKlypixMap, parseKlypix, tidyBrain, arrangeBrain, appendIntoContainers, addBrainConnections } from '../src/klypix-format.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const kindOf = async (buf) => (await parseKlypix(buf)).manifest?.kind ?? null;

console.log('K1 builders:');
{
    const plain = await buildKlypix({ title: 'not a brain', cards: [{ text: 'just a note' }] });
    ok(await kindOf(plain) === null, 'plain buildKlypix does NOT stamp kind');
    const brain = await buildKlypix({ title: 'b', kind: 'brain', cards: [{ text: 'x' }] });
    ok(await kindOf(brain) === 'brain', 'buildKlypix kind:"brain" stamps the manifest');
    const map = await buildKlypixMap({ title: 'm', kind: 'brain', areas: [{ title: 'A', cards: [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }] }], connections: [] });
    ok(await kindOf(map) === 'brain', 'buildKlypixMap kind:"brain" stamps the manifest');
    const plainMap = await buildKlypixMap({ title: 'm2', areas: [{ title: 'A', cards: [{ text: 'one' }] }], connections: [] });
    ok(await kindOf(plainMap) === null, 'plain buildKlypixMap does NOT stamp');
}

console.log('\nK2 retro-stamp on brain-only writes (and NOT on generic append):');
{
    const un = await buildKlypixMap({ title: 'legacy brain', areas: [{ title: 'Eng', cards: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }], connections: [] });
    ok(await kindOf(un) === null, 'fixture starts unstamped (legacy brain)');
    const tidied = await tidyBrain(un);
    ok(await kindOf(tidied.buffer) === 'brain', 'tidyBrain retro-stamps kind');
    const arranged = await arrangeBrain(un);
    ok(await kindOf(arranged.buffer) === 'brain', 'arrangeBrain retro-stamps kind');
    // generic append must NOT decide a canvas is a brain
    const appended = await appendIntoContainers(un, { cards: [{ text: 'appended note', area: 'Eng' }] });
    ok(await kindOf(appended) === null, 'appendIntoContainers does NOT stamp (generic canvases stay generic)');
    // …but appending to an already-stamped brain preserves the flag
    const appended2 = await appendIntoContainers(tidied.buffer, { cards: [{ text: 'second note', area: 'Eng' }] });
    ok(await kindOf(appended2) === 'brain', 'append preserves an existing kind flag');
    // brain_connect stamps too
    const { struct } = await parseKlypix(tidied.buffer);
    const texts = struct.cards.filter(c => c.type === 'text');
    const linked = await addBrainConnections(tidied.buffer, [{ fromId: texts[0].id, toId: texts[1].id, relationship: 'relates_to' }]);
    ok(await kindOf(linked.buffer) === 'brain', 'addBrainConnections keeps/stamps kind');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
