// format-guard — the engine's forward-compat ceiling (Brain Sync failure F7).
// A .klypix stamped by a FUTURE format version must refuse to parse, loudly;
// current-version files must be untouched by the guard. Matters because every
// downstream writer (merge, arrange, capture) trusts parseKlypix's output, and
// with brains syncing between machines mixed versions are a guaranteed state.
import JSZip from 'jszip';
import { __resetAuthorCache, buildKlypixMap, parseKlypix, resolveAuthor } from '../src/klypix-format.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const base = await buildKlypixMap({
  title: 'guard brain', kind: 'brain',
  areas: [{ title: 'A', cards: [{ text: 'a card' }] }],
});

// current version parses
const parsed = await parseKlypix(base);
ok(parsed.isV4 === true && parsed.struct.cards.some(c => (c.title || c.text || '').includes('a card')),
  'current-version brain parses normally');

// tamper the manifest to a future version → must throw with an update message
const zip = await JSZip.loadAsync(base);
const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
manifest.version = 9;
zip.file('manifest.json', JSON.stringify(manifest));
const future = await zip.generateAsync({ type: 'nodebuffer' });

let threw = null;
try { await parseKlypix(future); } catch (e) { threw = e; }
ok(!!threw, 'future-format brain refuses to parse');
ok(threw && /newer format \(v9\)/.test(threw.message), 'refusal names the future version');
ok(threw && /Update KLYPIX/i.test(threw.message), 'refusal tells the user the way out (update)');

// legacy files (no manifest) are untouched by the guard — reachability check:
// a zip with only canvas.json still routes to the legacy path, not the guard.
const legacyZip = new JSZip();
legacyZip.file('canvas.json', JSON.stringify({ version: 3, items: [], connections: [] }));
const legacy = await legacyZip.generateAsync({ type: 'nodebuffer' });
let legacyOk = true;
try { await parseKlypix(legacy); } catch { legacyOk = false; }
ok(legacyOk, 'legacy manifest-less file still parses (guard is v4-manifest-scoped)');

// ── Author identity on cards (team attribution, 2026-08-01) ────────────────
// Cards must carry WHOSE agent wrote them — same identity source as the dev's
// commits (git user.name), KLYPIX_AUTHOR overriding, additive field.
{
  __resetAuthorCache();
  process.env.KLYPIX_AUTHOR = 'Test Sara';
  ok(resolveAuthor() === 'Test Sara', 'KLYPIX_AUTHOR override wins');

  const authored = await buildKlypixMap({
    title: 'authored brain', kind: 'brain',
    areas: [{ title: 'A', cards: [{ text: 'attributed card' }] }],
  });
  const zip2 = await JSZip.loadAsync(authored);
  let sawAuthor = 0;
  for (const p of Object.keys(zip2.files)) {
    if (!p.startsWith('items/') || zip2.files[p].dir) continue;
    const item = JSON.parse(await zip2.file(p).async('string'));
    if (item.type === 'text' && item.author === 'Test Sara') sawAuthor++;
  }
  ok(sawAuthor > 0, 'text cards carry author identity (WHOSE agent, not just createdBy: agent)');

  // still parses like any brain — the field is additive
  const reparsed = await parseKlypix(authored);
  ok(reparsed.isV4, 'authored brain parses normally (field is additive)');

  __resetAuthorCache();
  delete process.env.KLYPIX_AUTHOR;
  // With no override the resolver must still return SOMETHING or null — never throw.
  let resolved = 'unset';
  try { resolved = resolveAuthor(); } catch { resolved = 'THREW'; }
  ok(resolved !== 'THREW', 'author resolution never throws (git/OS fallbacks degrade to null)');
  __resetAuthorCache();
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] format-guard: all assertions passed');
process.exit(failures ? 1 : 0);
