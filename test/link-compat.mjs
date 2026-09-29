// link-compat — mixed install generations (Stage 2, 1.87). The engine files
// reach ~/.claude/project-brain from four channels (full install, desktop
// bundle, auto-update, `git-driver install`), each renames files one at a
// time, and an interrupted or partial update leaves a mix on disk. Every mix
// that can occur must still LINK and merge — a link failure in the git driver
// is a manual binary conflict for every .klypix merge, and one in the engine
// stops Brain Sync. Each case assembles a directory exactly as it would sit on
// disk, then imports or runs what is there.
//
// Covered elsewhere: a 1.87 driver beside a 1.86.3 engine (git-tools E-10);
// 1.87 brain-history beside a 1.86.3 engine or none (brain-history E-9). The
// KLYPIX desktop's API-5 sync core beside this engine is tested in the KLYPIX
// repo, where that core lives.
//
// Run:  node test/link-compat.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildKlypix, parseKlypix, shard } from '../src/klypix-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'engine-1.86.3');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '[ok]' : '[x]'} ${label}`); if (!cond) failures++; };

// The directories live under the repo so 'jszip' and friends resolve the way
// they do beside a real install's node_modules.
const MIXES = [];
const mix = (files) => {
  const dir = fs.mkdtempSync(path.join(FIX, '.link-'));
  MIXES.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
};
const NEW = (name) => `export * from '../../../../src/${name}';\n`;
// The frozen 1.86.3 files import the live klypix-format through a fixed path;
// on disk they imported their sibling, which is what these mixes must model.
const OLD = (name) => fs.readFileSync(path.join(FIX, name), 'utf8')
  .replace(/'\.\.\/\.\.\/\.\.\/src\/klypix-format\.mjs'/g, "'./klypix-format.mjs'");
const OLD_DRIVER = fs.readFileSync(path.join(FIX, 'klypix-merge-driver.mjs'), 'utf8');

const rezip = (zip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const withCard = async (buf, id, text) => {
  const { zip, canvas } = await parseKlypix(buf);
  zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ type: 'text', content: text }));
  canvas.order = [...(canvas.order || []), id];
  canvas.positions = { ...(canvas.positions || {}), [id]: { x: 40, y: 40 * canvas.order.length, parentId: null } };
  zip.file('canvas.json', JSON.stringify(canvas));
  return rezip(zip);
};
const liveIds = async (buf) => (await parseKlypix(buf)).struct.cards.map((c) => c.id);
const base = await buildKlypix({ title: 'link compat', cards: [{ id: 'txt_anchor', text: 'anchor' }] });
const ours = await withCard(base, 'txt_ours', 'written on ours');
const theirs = await withCard(base, 'txt_theirs', 'written on theirs');
const unionOk = async (buf) => { const ids = await liveIds(buf); return ids.includes('txt_ours') && ids.includes('txt_theirs') && ids.includes('txt_anchor'); };

const runDriver = (dir) => {
  const [o, a, b] = ['o', 'a', 'b'].map((n) => path.join(dir, `${n}.klypix`));
  fs.writeFileSync(o, base); fs.writeFileSync(a, ours); fs.writeFileSync(b, theirs);
  try {
    execFileSync(process.execPath, [path.join(dir, 'klypix-merge-driver.mjs'), o, a, b, 'brain.klypix'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: fs.readFileSync(a) };
  } catch (e) { return { code: e.status ?? 1, out: null, err: String(e.stderr || '').split('\n').find((l) => /Error/.test(l)) || '' }; }
};

try {
  // The rename order is klypix-format, brain-graveyard, merge-brains, driver
  // (bin/klypix-install.mjs, bin/klypix-git-tools.mjs). Each prefix of it is a
  // state an interrupted update can leave behind; the last one is also what an
  // older `git-driver install` leaves when it rewrites only its own driver. (The
  // all-1.86.3 state needs the 1.86.3 klypix-format, which is not vendored —
  // that state is simply the old release.)
  const states = [
    ['klypix-format renamed', { 'klypix-format.mjs': NEW('klypix-format.mjs'), 'brain-graveyard.mjs': OLD('brain-graveyard.mjs'), 'merge-brains.mjs': OLD('merge-brains.mjs'), 'klypix-merge-driver.mjs': OLD_DRIVER }],
    ['klypix-format and brain-graveyard renamed', { 'klypix-format.mjs': NEW('klypix-format.mjs'), 'brain-graveyard.mjs': NEW('brain-graveyard.mjs'), 'merge-brains.mjs': OLD('merge-brains.mjs'), 'klypix-merge-driver.mjs': OLD_DRIVER }],
    ['all but the driver renamed (the 1.86.3 driver asks for union rules)', { 'klypix-format.mjs': NEW('klypix-format.mjs'), 'brain-graveyard.mjs': NEW('brain-graveyard.mjs'), 'merge-brains.mjs': NEW('merge-brains.mjs'), 'klypix-merge-driver.mjs': OLD_DRIVER }],
  ];
  for (const [label, files] of states) {
    const dir = mix(files);
    let linked = false, merged = false, err = '';
    try {
      const eng = await import(pathToFileURL(path.join(dir, 'merge-brains.mjs')).href);
      linked = typeof eng.mergeBrains === 'function';
      merged = await unionOk((await eng.mergeBrains({ base, ours, theirs })).buffer);
    } catch (e) { err = String(e?.message || e).slice(0, 160); }
    const r = runDriver(dir);
    ok(linked && merged && r.code === 0 && await unionOk(r.out),
      `mid-update, ${label}: the engine links and merges, and the git driver runs${err || r.err ? ` (${err || r.err})` : ''}`);
  }

  // The 1.87 set, complete: the engine advertises what brain-history and the
  // KLYPIX core feature-check before using it.
  {
    const dir = mix({ 'klypix-format.mjs': NEW('klypix-format.mjs'), 'brain-graveyard.mjs': NEW('brain-graveyard.mjs'), 'merge-brains.mjs': NEW('merge-brains.mjs'), 'klypix-merge-driver.mjs': fs.readFileSync(path.join(ROOT, 'src', 'klypix-merge-driver.mjs'), 'utf8') });
    const eng = await import(pathToFileURL(path.join(dir, 'merge-brains.mjs')).href);
    const r = runDriver(dir);
    ok(eng.MERGE_ENGINE_FEATURES?.api === 2 && eng.MERGE_ENGINE_FEATURES.restoreAsMerge === true && r.code === 0 && await unionOk(r.out),
      'the complete 1.87 set links, advertises api 2, and its driver merges');
  }
} finally {
  for (const dir of MIXES) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] link-compat: all assertions passed');
process.exit(failures ? 1 : 0);
