// git-tools — the GitHub lane's proof: git-driver / diff / pr-brief against a
// REAL temp git repo, with the driver runtime provisioned into a FAKE brain
// dir (KLYPIX_BRAIN_DIR) — the npx-stranger path end to end, including the
// crown assertion: a genuine `git merge` that unions two sides' brain cards
// through the provisioned driver.
//
// SAFETY: every write lands in os.tmpdir() (repo + brain dir + HOME-ish bits);
// the real ~/.claude/project-brain and the real project are never touched.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildKlypixMap, appendToKlypix, parseKlypix, buildKlypix, shard,
  binEntryFor, contentFreeReceiptFor, PURGED_BODY, entryKind,
} from '../src/klypix-format.mjs';
import { normalizeMergeOptions } from '../src/merge-brains.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'klypix-mcp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-git-tools-'));
const REPO = path.join(TMP, 'repo');
const FAKE_BRAIN_DIR = path.join(TMP, 'brain-runtime');

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '[ok]' : '[x]'} ${label}`);
  if (!cond) failures++;
};

const ENV = { ...process.env, KLYPIX_BRAIN_DIR: FAKE_BRAIN_DIR };
const run = (args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MCP, ...args], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── fixture repo: a brain with a tagged card, committed ─────────────────────
fs.mkdirSync(REPO, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'tools@test.local');
git('config', 'user.name', 'git tools test');
const base = await buildKlypixMap({
  title: 'tools brain', kind: 'brain',
  areas: [{ title: 'Area', cards: [
    { text: 'Decision about the app shell — never remove the always-mount. #file-appmain #dir-src' },
    { text: 'Unrelated note with a LONGER tag #file-appmain-extra' },
  ] }],
});
fs.writeFileSync(path.join(REPO, 'brain.klypix'), base);
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'AppMain.ts'), 'export const x = 1;\n');
git('add', '-A');
git('commit', '-qm', 'base');

console.log('\n— git-driver install (stranger repo, empty runtime) —');
{
  const r = run(['git-driver', 'install']);
  ok(r.code === 0, 'exits 0');
  ok(/Registered the \.klypix merge driver/.test(r.out), 'reports registration');
  ok(/provisioned/.test(r.out), 'provisioned the runtime into the empty brain dir');
  const cfg = git('config', '--get', 'merge.klypix.driver');
  ok(cfg.includes('klypix-merge-driver.mjs') && cfg.includes(FAKE_BRAIN_DIR.replace(/\\/g, '/')), 'git config points at the installed runtime');
  ok(/merge=klypix/.test(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8')), '.gitattributes rule written');
  for (const f of ['klypix-merge-driver.mjs', 'merge-brains.mjs', 'klypix-format.mjs', 'brain-graveyard.mjs']) {
    ok(fs.existsSync(path.join(FAKE_BRAIN_DIR, f)), `runtime has ${f}`);
  }
  ok(fs.existsSync(path.join(FAKE_BRAIN_DIR, 'node_modules', 'jszip')), 'runtime has jszip dep');
  const again = run(['git-driver', 'install']);
  ok(/Already registered/.test(again.out), 'second run is idempotent');
  const status = run(['git-driver', 'status']);
  ok(status.code === 0, 'status exits 0 when fully registered');
}

console.log('\n— git-driver install never downgrades the installed engine —');
{
  // The same four files arrive from the full installer, the desktop bundle and
  // auto-update. An older `npx klypix-mcp git-driver install` must not put its
  // engine under a newer one: the gate is the full installer's own rule.
  const DIR = path.join(TMP, 'brain-runtime-gate');
  const FILES = ['klypix-format.mjs', 'brain-graveyard.mjs', 'merge-brains.mjs', 'klypix-merge-driver.mjs'];
  const SENTINEL = '// engine written by another install\n';
  const envFor = { env: { ...process.env, KLYPIX_BRAIN_DIR: DIR } };
  const stampWith = (s) => fs.writeFileSync(path.join(DIR, '.brain-version.json'), JSON.stringify(s));
  const allSentinel = () => FILES.every((f) => fs.readFileSync(path.join(DIR, f), 'utf8') === SENTINEL);
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(DIR, f), SENTINEL);

  stampWith({ brainVersion: '99.0.0', via: 'npm' });
  const newer = run(['git-driver', 'install'], envFor);
  ok(newer.code === 0 && allSentinel() && /kept the engine installed by v99\.0\.0 \(via npm\)/.test(newer.out),
    'a newer installed engine is kept, and the output says whose it is');

  stampWith({ brainVersion: '1.0.0', via: 'dev', dev: true });
  const dev = run(['git-driver', 'install'], envFor);
  ok(dev.code === 0 && allSentinel() && /kept the engine installed by a dev deploy/.test(dev.out),
    'a dev-owned engine is kept');

  stampWith({ brainVersion: '99.0.0', via: 'npm' });
  fs.rmSync(path.join(DIR, 'merge-brains.mjs'));
  const gap = run(['git-driver', 'install'], envFor);
  ok(gap.code === 0 && !fs.existsSync(path.join(DIR, 'merge-brains.mjs')) && /missing merge-brains\.mjs/.test(gap.out),
    'a newer install missing a file is reported, never filled with an older file');

  stampWith({ brainVersion: '1.0.0', via: 'npm' });
  const older = run(['git-driver', 'install'], envFor);
  const current = FILES.every((f) => fs.readFileSync(path.join(DIR, f), 'utf8') === fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
  ok(older.code === 0 && current && /provisioned: klypix-format\.mjs, brain-graveyard\.mjs, merge-brains\.mjs, klypix-merge-driver\.mjs/.test(older.out),
    'an older engine is replaced as one set, dependencies first');
  ok(!fs.readdirSync(DIR).some((f) => f.includes('.klypix-new')), 'each file is swapped in atomically, no temp file left');
}
git('add', '-A');
git('commit', '-qm', 'driver attributes');

console.log('\n— crown assertion: real git merge unions through the provisioned runtime —');
{
  git('checkout', '-qb', 'dev-b');
  const b = await appendToKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')), { cards: [{ text: 'CARD FROM B side' }] });
  fs.writeFileSync(path.join(REPO, 'brain.klypix'), b);
  git('commit', '-qam', 'b card');
  git('checkout', '-q', 'main');
  const a = await appendToKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')), { cards: [{ text: 'CARD FROM A side' }] });
  fs.writeFileSync(path.join(REPO, 'brain.klypix'), a);
  git('commit', '-qam', 'a card');
  execFileSync('git', ['merge', 'dev-b', '-m', 'merged'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { struct } = await parseKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')));
  const titles = struct.cards.map(c => (c.title || c.text || '').split('\n')[0]);
  ok(titles.some(t => t.startsWith('CARD FROM A')) && titles.some(t => t.startsWith('CARD FROM B')),
    'both sides survive a real git merge in a stranger repo');
}

console.log('\n— diff: semantic, prose titles, truthful counts —');
{
  const r = run(['diff', 'HEAD~2']);
  ok(r.code === 0, 'exits 0');
  ok(/Brain diff/.test(r.out), 'has the header');
  ok(/CARD FROM A/.test(r.out) && /CARD FROM B/.test(r.out), 'lists both added cards');
  const m = r.out.match(/(\d+) added · (\d+) updated/);
  ok(!!m && Number(m[1]) >= 2, 'added count includes the new cards');
  ok(!!m && Number(m[2]) <= 2, `updated count is semantic, not byte-noise (got ${m && m[2]})`);
}

console.log('\n— pr-brief: tag-matched context, boundary-safe —');
{
  fs.appendFileSync(path.join(REPO, 'src', 'AppMain.ts'), 'export const y = 2;\n');
  git('commit', '-qam', 'touch AppMain');
  const r = run(['pr-brief', 'HEAD~1']);
  ok(r.code === 0, 'exits 0');
  ok(/Brain context for this PR/.test(r.out), 'has the header');
  ok(/src\/AppMain\.ts/.test(r.out), 'names the changed file');
  ok(/never remove the always-mount/.test(r.out), 'surfaces the tagged decision');
  ok(!/LONGER tag/.test(r.out), 'tag boundary holds — #file-appmain-extra does not match AppMain.ts');
}
{
  fs.writeFileSync(path.join(REPO, 'untagged.md'), 'nothing references this\n');
  git('add', '-A');
  git('commit', '-qm', 'untagged file');
  const r = run(['pr-brief', 'HEAD~1']);
  ok(/No brain cards reference/.test(r.out), 'no-match path says so honestly');
}

// ── E-10: the driver merges bins 3-way, like Brain Sync ─────────────────────
// Each case runs the REAL driver the way git does (ancestor, ours, theirs on
// disk; the result written over ours), so what is tested is what a merge
// commit will contain.
console.log('\n— E-10: the driver asks for the bin-aware rules —');
{
  const DRIVER = path.join(ROOT, 'src', 'klypix-merge-driver.mjs');
  const src = fs.readFileSync(DRIVER, 'utf8').replace(/\r/g, '');
  const lit = src.match(/const DRIVER_OPTIONS = Object\.freeze\((\{[\s\S]*?\})\);/);
  const pinned = lit ? new Function(`return (${lit[1]});`)() : null;
  let valid = false;
  try { normalizeMergeOptions(pinned); valid = true; } catch { /* reported below */ }
  ok(valid && pinned?.binMerge === '3way' && pinned?.newOnBothSides === 'twin' && pinned?.manifestMerge === '3way',
    'the options the installed driver passes are the ones the engine validates (read from its source)');
  ok(/const DRIVER_OPTIONS_API = 2;/.test(src), 'the driver advertises options api 2 for brain_doctor');

  const cj = (id, text) => JSON.stringify({ id, type: 'text', content: text, width: 240, height: 80 });
  const rezip = (zip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const putCard = async (buf, id, text) => {
    const { zip, canvas } = await parseKlypix(buf);
    zip.file(`items/${shard(id)}/${id}.json`, cj(id, text));
    canvas.order = [...new Set([...(canvas.order || []), id])];
    canvas.positions = { ...(canvas.positions || {}), [id]: { x: 40, y: 40, parentId: null } };
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  };
  const dropCard = async (buf, id) => {
    const { zip, canvas } = await parseKlypix(buf);
    zip.remove(`items/${shard(id)}/${id}.json`);
    canvas.order = (canvas.order || []).filter((x) => x !== id);
    delete canvas.positions?.[id];
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  };
  const withEntry = async (buf, id, meta, body) => {
    const { zip } = await parseKlypix(buf);
    const f = zip.file('graveyard.json');
    const entries = f ? JSON.parse(await f.async('string')).entries : {};
    entries[id] = meta;
    zip.file(`graveyard/${shard(id)}/${id}.json`, body);
    zip.file('graveyard.json', JSON.stringify({ version: 1, entries }));
    return rezip(zip);
  };
  const withTitle = async (buf, title) => {
    const { zip, manifest } = await parseKlypix(buf);
    zip.file('manifest.json', JSON.stringify({ ...manifest, title }));
    return rezip(zip);
  };
  const entries = async (buf) => {
    const { zip } = await parseKlypix(buf);
    const f = zip.file('graveyard.json');
    return f ? JSON.parse(await f.async('string')).entries : {};
  };
  const live = async (buf) => (await parseKlypix(buf)).canvas.order || [];
  const textOf = async (buf, id) => {
    const f = (await parseKlypix(buf)).zip.file(`items/${shard(id)}/${id}.json`);
    return f ? JSON.parse(await f.async('string')).content : null;
  };
  const DIR = fs.mkdtempSync(path.join(TMP, 'driver-'));
  const drive = (driver, O, A, B) => {
    const [o, a, b] = ['o', 'a', 'b'].map((n) => path.join(DIR, `${n}.klypix`));
    fs.writeFileSync(o, O); fs.writeFileSync(a, A); fs.writeFileSync(b, B);
    try {
      execFileSync(process.execPath, [driver, o, a, b, 'brain.klypix'], { stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out: fs.readFileSync(a) };
    } catch (e) { return { code: e.status ?? 1, out: null, err: String(e.stderr || '') }; }
  };

  const seed = await buildKlypix({ title: 'driver bins', cards: [{ id: 'txt_anchor', text: 'anchor' }] });
  const SECRET = 'sk-driver-secret-123';

  // A purge made on one branch reaches the merge from either side, and the
  // purged bytes are nowhere in the result.
  const F = binEntryFor({ id: 'txt_k', json: cj('txt_k', SECRET), now: 1000 });
  const deletedBase = await withEntry(seed, 'txt_k', F.meta, F.json);
  const purged = await withEntry(seed, 'txt_k', contentFreeReceiptFor('txt_k', F, { kind: 'purged', now: 2000 }), PURGED_BODY);
  for (const [label, A, B] of [['ours', purged, deletedBase], ['theirs', deletedBase, purged]]) {
    const r = drive(DRIVER, deletedBase, A, B);
    const e = r.out ? (await entries(r.out))['txt_k'] : null;
    const leaked = r.out ? r.out.includes(Buffer.from(SECRET)) || (await textOf(r.out, 'txt_k')) === SECRET : true;
    ok(r.code === 0 && e && entryKind(e) === 'P' && !leaked, `a purge made on ${label} survives the git merge and its bytes are gone`);
  }

  // A card created on both branches with different text keeps both.
  {
    const A = await putCard(seed, 'txt_n', 'N — written on branch A');
    const B = await putCard(seed, 'txt_n', 'N — written on branch B');
    const r = drive(DRIVER, seed, A, B);
    const ids = r.out ? await live(r.out) : [];
    const twin = ids.find((id) => id.startsWith('txt_n__agconf_'));
    ok(r.code === 0 && (await textOf(r.out, 'txt_n')) === 'N — written on branch A' && twin && (await textOf(r.out, twin)) === 'N — written on branch B',
      'a card new on both branches with different text keeps both (ours live, theirs as a twin)');
  }

  // A title renamed on one branch is not lost to the other's unchanged title.
  {
    const O = await withTitle(seed, 'Original title');
    const r = drive(DRIVER, O, await withTitle(O, 'Renamed on A'), O);
    ok(r.code === 0 && (await parseKlypix(r.out)).manifest.title === 'Renamed on A', 'a title renamed on one branch survives the merge');
  }

  // A committed absence leaves a receipt saying where it came from.
  {
    const O = await putCard(seed, 'txt_gone', 'deleted on branch A, untouched on B');
    const r = drive(DRIVER, O, await dropCard(O, 'txt_gone'), O);
    const e = r.out ? (await entries(r.out))['txt_gone'] : null;
    ok(r.code === 0 && !(await live(r.out)).includes('txt_gone') && e?.deletion?.cause === 'git-committed-absence' && e?.deletion?.source === 'git-merge-driver',
      'a delete inferred from a committed absence is buried with a git-merge-driver receipt');
  }

  // An older engine beside this driver (mixed install generations): the
  // driver must still merge, with that engine's own rules, instead of failing
  // into a manual binary conflict.
  {
    const FIX = path.join(ROOT, 'test', 'fixtures', 'engine-1.86.3');
    const MIX = fs.mkdtempSync(path.join(FIX, '.mix-'));
    try {
      fs.writeFileSync(path.join(MIX, 'merge-brains.mjs'), "export * from '../merge-brains.mjs';\n");
      fs.writeFileSync(path.join(MIX, 'klypix-format.mjs'), "export * from '../../../../src/klypix-format.mjs';\n");
      fs.copyFileSync(DRIVER, path.join(MIX, 'klypix-merge-driver.mjs'));
      const A = await putCard(seed, 'txt_a', 'from A');
      const B = await putCard(seed, 'txt_b', 'from B');
      const r = drive(path.join(MIX, 'klypix-merge-driver.mjs'), seed, A, B);
      const ids = r.out ? await live(r.out) : [];
      ok(r.code === 0 && ids.includes('txt_a') && ids.includes('txt_b'),
        `beside a 1.86.3 engine the driver still merges (with its rules)${r.err ? ` — ${r.err.slice(0, 160)}` : ''}`);
    } finally {
      fs.rmSync(MIX, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures ? `[x] ${failures} assertion(s) failed` : '[ok] git-tools: all assertions passed'}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
