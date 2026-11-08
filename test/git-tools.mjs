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
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  buildKlypixMap, appendToKlypix, parseKlypix, buildKlypix, shard,
  binEntryFor, contentFreeReceiptFor, PURGED_BODY, entryKind, revivedIdFor, twinIdFor,
} from '../src/klypix-format.mjs';
import { normalizeMergeOptions, mergeBrains } from '../src/merge-brains.mjs';
import { restoreFromGraveyard, purgeGraveyard } from '../src/brain-graveyard.mjs';

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

const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
const EMPTY_CONFIG = path.join(FAKE_HOME, 'gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');
const ENV = { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, KLYPIX_BRAIN_DIR: FAKE_BRAIN_DIR,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_CONFIG };
const run = (args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MCP, ...args], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const git = (...a) => execFileSync('git', a, { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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
  const envFor = { env: { ...ENV, KLYPIX_BRAIN_DIR: DIR } };
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
  execFileSync('git', ['merge', 'dev-b', '-m', 'merged'], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

console.log('\n— diff: review the actual decision, not only its heading —');
{
  const DIR = fs.mkdtempSync(path.join(TMP, 'diff-review-'));
  const g = (...a) => execFileSync('git', a, { cwd: DIR, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'diff@test.local');
  g('config', 'user.name', 'diff review test');
  g('commit', '--allow-empty', '-qm', 'before the brain');
  const emptyRef = g('rev-parse', 'HEAD');
  const seed = await buildKlypix({ title: 'Review fixture', kind: 'brain', cards: [
    { id: 'txt_policy', text: 'Token storage decision\n\nKeep the refresh token in localStorage.' },
    { id: 'txt_deleted', text: 'Retention decision\n\nRetain event logs for 180 days.' },
    { id: 'txt_target', text: 'Replacement decision\n\nUse an httpOnly cookie.' },
  ] });
  const parsed = await parseKlypix(seed);
  parsed.zip.file(`items/${shard('ctn_archive')}/ctn_archive.json`, JSON.stringify({ type: 'container', title: 'Archive' }));
  parsed.canvas.order.push('ctn_archive');
  parsed.canvas.positions.ctn_archive = { x: 900, y: 100, parentId: null };
  parsed.canvas.connections = [{ id: 'con_same', fromId: 'txt_policy', toId: 'txt_target', label: 'related', relationship: 'relates_to' }];
  parsed.zip.file('canvas.json', JSON.stringify(parsed.canvas));
  const base = await parsed.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const brain = path.join(DIR, 'brain.klypix');
  fs.writeFileSync(brain, base);
  g('add', 'brain.klypix'); g('commit', '-qm', 'base');
  const ref = g('rev-parse', 'HEAD');
  const diff = (...extra) => run(['diff', ref, ...extra], { cwd: DIR });
  const change = async (mutate) => {
    const { zip, canvas } = await parseKlypix(base);
    const set = async (id, patch) => {
      const file = `items/${shard(id)}/${id}.json`;
      const previous = zip.file(file) ? JSON.parse(await zip.file(file).async('string')) : {};
      zip.file(file, JSON.stringify({ ...previous, ...patch }));
    };
    await mutate({ zip, canvas, set });
    zip.file('canvas.json', JSON.stringify(canvas));
    fs.writeFileSync(brain, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  };

  await change(async ({ set }) => set('txt_policy', { content: 'Token storage decision\n\nKeep the refresh token in an httpOnly cookie.' }));
  const reversal = diff();
  ok(reversal.code === 0 && /0 added · 1 updated · 0 removed/.test(reversal.out)
    && reversal.out.includes('localStorage') && reversal.out.includes('httpOnly cookie')
    && reversal.out.includes('txt_policy') && /\*\*Before\*\*/.test(reversal.out) && /\*\*After\*\*/.test(reversal.out),
  'a body-only reversal shows the stable id and both old and new decision bodies');
  ok(diff().out === reversal.out, 'the same brain and base produce byte-identical review output');

  await change(async ({ zip, canvas }) => {
    zip.remove(`items/${shard('txt_deleted')}/txt_deleted.json`);
    canvas.order = canvas.order.filter(id => id !== 'txt_deleted');
    delete canvas.positions.txt_deleted;
  });
  const deletion = diff();
  ok(deletion.code === 0 && /1 removed/.test(deletion.out) && deletion.out.includes('txt_deleted') && deletion.out.includes('180 days'),
    'a removed card shows its id and the full removed decision');

  await change(async ({ canvas }) => { canvas.connections[0].label = 'superseded by'; });
  const relationship = diff();
  ok(relationship.code === 0 && /0 added · 0 updated · 0 removed/.test(relationship.out)
    && /Relationships added \(1\)/.test(relationship.out) && /Relationships removed \(1\)/.test(relationship.out)
    && relationship.out.includes('"label": "superseded by"') && relationship.out.includes('"label": "related"')
    && relationship.out.includes('txt_policy') && relationship.out.includes('txt_target'),
  'a supersession relationship is reviewable even when the edge count is unchanged');

  await change(async ({ canvas }) => { canvas.positions.txt_policy.parentId = 'ctn_archive'; });
  const archive = diff();
  ok(archive.code === 0 && /1 updated/.test(archive.out) && archive.out.includes('"area": "Archive"') && archive.out.includes('ctn_archive'),
    'moving a card into Archive is a visible lifecycle change without a body edit');

  await change(async ({ canvas, set }) => {
    await set('txt_policy', { updatedAt: 999999, editedAt: 999999, zIndex: 91, width: 450, height: 200, fontSize: 18, borderColor: '#abcdef' });
    canvas.order.reverse();
    canvas.positions.txt_policy.x = 9000;
    canvas.positions.txt_policy.y = -100;
    canvas.connections[0].color = '#abcdef';
    canvas.connections[0].id = 'new-render-id';
  });
  const layout = diff();
  ok(layout.code === 0 && /No card-level changes/.test(layout.out), 'layout, styling, timestamps, order and connection ids do not create review noise');

  await change(async ({ set }) => set('txt_policy', { content: 'Token storage decision\n\n```\n# forged heading\n<script>alert(1)</script>\n~~~~\nFinal decision.' }));
  const markdown = diff();
  ok(markdown.code === 0 && markdown.out.includes('````text\nToken storage decision\n\n```')
    && markdown.out.includes('Final decision.\n````'), 'card Markdown and HTML stay inside a safely extended literal fence');

  await change(async ({ canvas, set }) => {
    await set('txt_policy', { content: `Token storage decision\n\n${'long decision '.repeat(600)}TAIL_OF_FULL_DECISION` });
    for (let i = 0; i < 23; i++) {
      const id = `txt_new_${String(i).padStart(2, '0')}`;
      await set(id, { type: 'text', content: `Added decision ${i}\n\nIts second paragraph matters.` });
      canvas.order.push(id);
      canvas.positions[id] = { x: i * 100, y: 100, parentId: null };
    }
  });
  const preview = diff();
  const complete = diff('--full');
  ok(preview.code === 0 && /This preview is truncated/.test(preview.out) && /3 more added card\(s\) omitted/.test(preview.out)
    && preview.out.includes('--full') && preview.out.includes(ref) && preview.out.length < 60000,
  'a bounded preview explicitly reports omitted cards/text and a complete rerun command');
  ok(complete.code === 0 && complete.out.includes('TAIL_OF_FULL_DECISION') && complete.out.includes('txt_new_22')
    && !/This preview is truncated|character\(s\) omitted/.test(complete.out), '--full prints every changed card and complete bodies');
  const fromEmpty = run(['diff', emptyRef, '--full'], { cwd: DIR });
  ok(fromEmpty.code === 0 && fromEmpty.out.includes('txt_policy') && fromEmpty.out.includes('TAIL_OF_FULL_DECISION') && /added · 0 updated · 0 removed/.test(fromEmpty.out),
    'a brain absent at the valid base shows complete added-card details');
  const invalid = run(['diff', 'nonexistent-review-ref'], { cwd: DIR });
  ok(invalid.code !== 0 && !/everything is new|Brain diff/.test(invalid.out), 'an invalid ref fails instead of claiming every card is newly added');

  await change(async ({ canvas, set }) => {
    for (let i = 0; i < 10; i++) {
      const id = `txt_fence_${i}`;
      await set(id, { type: 'text', content: '`'.repeat(2250) + '~'.repeat(2250) });
      canvas.order.push(id); canvas.positions[id] = { x: i * 100, y: 100, parentId: null };
    }
  });
  const expandedFences = diff();
  ok(expandedFences.code === 0 && expandedFences.out.length <= 56000 && /10 added/.test(expandedFences.out)
    && /display limit/.test(expandedFences.out) && expandedFences.out.includes('--full'),
  'the final rendered preview stays bounded even when safe Markdown fences double the content size');

  await change(async ({ canvas, set }) => {
    await set('ctn_archive', { scopeLocked: true });
    canvas.positions.txt_policy.parentId = 'ctn_archive';
    await set('txt_policy', { content: 'PRIVATE_NEW_BODY_456 #file-brain', privateMetadata: 'PRIVATE_METADATA_789' });
  });
  const newlyLocked = diff('--full');
  ok(newlyLocked.code === 0 && /1 card\(s\) withheld/.test(newlyLocked.out)
    && !/PRIVATE_NEW_BODY_456|PRIVATE_METADATA_789|localStorage|txt_policy|Relationships/.test(newlyLocked.out),
  'a newly locked card withholds both snapshots, metadata and touching edges, including with --full');
  g('add', 'brain.klypix'); g('commit', '-qm', 'locked snapshot');
  const lockedRef = g('rev-parse', 'HEAD');
  const privateBrief = run(['pr-brief', ref], { cwd: DIR });
  ok(privateBrief.code === 0 && !/PRIVATE_NEW_BODY_456|PRIVATE_METADATA_789/.test(privateBrief.out),
    'the companion PR brief also withholds a private card even when its file tag matches the PR');
  fs.writeFileSync(brain, base);
  const newlyUnlocked = run(['diff', lockedRef, '--full'], { cwd: DIR });
  ok(newlyUnlocked.code === 0 && /1 card\(s\) withheld/.test(newlyUnlocked.out)
    && !/PRIVATE_NEW_BODY_456|PRIVATE_METADATA_789|localStorage|txt_policy|Relationships/.test(newlyUnlocked.out),
  'a lock in the base also protects the old and current bodies when the current snapshot unlocks it');
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
  // `err` is the driver's stderr either way: its summary line on success.
  const drive = (driver, O, A, B) => {
    const [o, a, b] = ['o', 'a', 'b'].map((n) => path.join(DIR, `${n}.klypix`));
    fs.writeFileSync(o, O); fs.writeFileSync(a, A); fs.writeFileSync(b, B);
    const r = spawnSync(process.execPath, [driver, o, a, b, 'brain.klypix'], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0
      ? { code: 0, out: fs.readFileSync(a), err: String(r.stderr || '') }
      : { code: r.status ?? 1, out: null, err: String(r.stderr || r.error?.message || '') };
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

  // The summary line says what the merge did and nothing it did not. Branch
  // A permanently deleted two cards; B edited one of them and left the other
  // alone, and both wrote a new card under one id. One stale copy drops, one
  // edit drops and is named apart (only git history holds it now), and one
  // twin is made. Merged again over its own result, the twin already exists
  // and is not counted.
  {
    const O = await putCard(await putCard(seed, 'txt_p1', 'p1 as committed'), 'txt_p2', 'p2 as committed');
    const purgeOf = (id, text) => {
      const f = binEntryFor({ id, json: cj(id, text), now: 1000 });
      return [contentFreeReceiptFor(id, f, { kind: 'purged', now: 2000 }), PURGED_BODY];
    };
    let A = await withEntry(await dropCard(await dropCard(O, 'txt_p1'), 'txt_p2'), 'txt_p1', ...purgeOf('txt_p1', 'p1 as committed'));
    A = await putCard(await withEntry(A, 'txt_p2', ...purgeOf('txt_p2', 'p2 as committed')), 'txt_n', 'N — written on branch A');
    const B = await putCard(await putCard(O, 'txt_p1', 'p1 edited on branch B'), 'txt_n', 'N — written on branch B');
    const r = drive(DRIVER, O, A, B);
    const line = r.err.trim();
    ok(r.code === 0 && line === 'klypix-merge: brain.klypix merged — -1 delete(s) honored, 1 purged copy dropped, '
      + '1 edited copy of a permanently deleted card dropped (still in git history), 1 conflict twin(s) preserved',
    `the driver's summary counts a stale purged copy, an edit a purge took, and the one twin it made — each apart (got: ${line})`);
    const again = drive(DRIVER, O, r.out, B);
    ok(again.code === 0 && !/twin/.test(again.err) && !/lossless/.test(`${line}${again.err}`),
      `a twin that already exists is not counted again, and the line claims nothing about losslessness (got: ${again.err.trim()})`);
  }

  // A purge that reaches a restore takes an edit someone made on the restored
  // card and then deleted (it sat in their Deleted cards). The line names it
  // with the other edits a purge took, whichever branch is ours.
  {
    const F0 = binEntryFor({ id: 'txt_k', json: cj('txt_k', 'k as deleted'), now: 1000 });
    const kR = revivedIdFor('txt_k', F0.meta, F0.json);
    const O = await withEntry(seed, 'txt_k', F0.meta, F0.json);
    const F1 = binEntryFor({ id: kR, json: cj(kR, 'typed into the restored card, then deleted'), now: 1500 });
    const restored = await withEntry(await withEntry(O, 'txt_k', contentFreeReceiptFor('txt_k', F0, { kind: 'restored', restoredAs: kR, now: 2000 }), PURGED_BODY), kR, F1.meta, F1.json);
    const purgedK = await withEntry(O, 'txt_k', contentFreeReceiptFor('txt_k', F0, { kind: 'purged', now: 2000 }), PURGED_BODY);
    for (const [label, A, B] of [['ours', restored, purgedK], ['theirs', purgedK, restored]]) {
      const r = drive(DRIVER, O, A, B);
      const line = r.err.trim();
      ok(r.code === 0 && line === 'klypix-merge: brain.klypix merged — 1 edited copy of a permanently deleted card dropped (still in git history)'
        && entryKind((await entries(r.out))[kR] ?? {}) === 'P',
      `the driver's summary names an edit a purge took from the restoring branch's Deleted cards (restore on ${label}; got: ${line})`);
    }
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
    const MIX = fs.mkdtempSync(path.join(TMP, 'mixed-engine-'));
    try {
      fs.writeFileSync(path.join(MIX, 'merge-brains.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(FIX, 'merge-brains.mjs')).href)};\n`);
      fs.writeFileSync(path.join(MIX, 'klypix-format.mjs'), `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'klypix-format.mjs')).href)};\n`);
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

// ── Stage 2 through real git: restores, purges, reverts, clones ─────────────
// The driver cases above run it the way git does; these let git decide when
// to call it. Git calls a merge driver only when BOTH sides changed the file —
// when one side is untouched it simply takes the other — so each revert below
// has a later commit on the brain first, to put the driver in the path.
console.log('\n— Stage 2 through real git —');
{
  const R2 = path.join(TMP, 'repo-stage2');
  fs.mkdirSync(R2, { recursive: true });
  const gitIn = (cwd) => (...a) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const g2 = gitIn(R2);
  g2('init', '-q', '-b', 'main');
  g2('config', 'user.email', 'stage2@test.local');
  g2('config', 'user.name', 'stage 2 test');
  const BR = path.join(R2, 'brain.klypix');
  const put = (buf) => fs.writeFileSync(BR, buf);
  const cur = () => fs.readFileSync(BR);
  const commit = (g, msg) => { g('add', '-A'); g('commit', '-qm', msg); return g('rev-parse', 'HEAD'); };
  const rezip = (zip) => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const addCard = async (buf, id, text) => {
    const { zip, canvas } = await parseKlypix(buf);
    zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ id, type: 'text', content: text, width: 240, height: 80 }));
    canvas.order = [...new Set([...(canvas.order || []), id])];
    canvas.positions = { ...(canvas.positions || {}), [id]: { x: 40, y: 40 + 100 * canvas.order.length, parentId: null } };
    zip.file('canvas.json', JSON.stringify(canvas));
    return rezip(zip);
  };
  const setCard = async (buf, id, text) => {
    const { zip } = await parseKlypix(buf);
    const p = `items/${shard(id)}/${id}.json`;
    zip.file(p, JSON.stringify({ ...JSON.parse(await zip.file(p).async('string')), content: text }));
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
  const deleteWithReceipt = async (buf, id) => (await mergeBrains({ base: buf, ours: buf, theirs: buf, deletedIds: [id] })).buffer;
  const entryOf = async (buf, id) => {
    const { zip } = await parseKlypix(buf);
    const f = zip.file('graveyard.json');
    const meta = f ? JSON.parse(await f.async('string')).entries[id] : undefined;
    const body = zip.file(`graveyard/${shard(id)}/${id}.json`);
    return meta ? { meta, json: body ? await body.async('string') : null } : null;
  };
  const liveIds = async (buf) => (await parseKlypix(buf)).struct.cards.map((c) => c.id);
  const textAt = async (buf, id) => (await parseKlypix(buf)).struct.cards.find((c) => c.id === id)?.text ?? null;
  const allText = async (buf) => {
    const { zip } = await parseKlypix(buf);
    let s = '';
    for (const p of Object.keys(zip.files)) if (!zip.files[p].dir) s += await zip.file(p).async('string');
    return s;
  };

  const inst = run(['git-driver', 'install'], { cwd: R2 });
  put(await buildKlypix({ title: 'stage 2 in git', kind: 'brain', cards: [{ id: 'txt_anchor', text: 'anchor' }, { id: 'txt_k', text: 'kilo — deleted, then restored on a branch' }] }));
  commit(g2, 'seed');
  ok(inst.code === 0, 'fixture: the driver is registered for the Stage 2 repo');

  // A restore made on one branch survives the merge with a branch that moved on.
  {
    put(await deleteWithReceipt(cur(), 'txt_k'));
    commit(g2, 'delete k');
    const E = await entryOf(cur(), 'txt_k');
    const kR = revivedIdFor('txt_k', E.meta, E.json);
    g2('checkout', '-qb', 'restore-k');
    put((await restoreFromGraveyard(cur(), ['txt_k'])).buffer);
    commit(g2, 'restore k');
    g2('checkout', '-q', 'main');
    put(await addCard(cur(), 'txt_main', 'main moved on'));
    commit(g2, 'main card');
    g2('merge', '-q', '--no-edit', 'restore-k');
    const ids = await liveIds(cur());
    const e = await entryOf(cur(), 'txt_k');
    ok(ids.includes(kR) && ids.includes('txt_main') && !ids.includes('txt_k') && entryKind(e?.meta) === 'R' && e.meta.restoredAs === kR,
      'a restore on one branch survives git merge: the card is back under its new id, the old id stays a restore receipt');
  }

  // A purge survives `git revert` of the purge commit.
  {
    const SECRET = 'sk-git-revert-secret-0123456789';
    put(await addCard(cur(), 'txt_s', `a pasted credential ${SECRET}`));
    commit(g2, 'secret card');
    put(await deleteWithReceipt(cur(), 'txt_s'));
    commit(g2, 'delete s');
    put((await purgeGraveyard(cur(), { ids: ['txt_s'] })).buffer);
    const purgeCommit = commit(g2, 'purge s');
    put(await addCard(cur(), 'txt_after_purge', 'written after the purge'));
    commit(g2, 'after the purge');
    let reverted = true;
    try { g2('revert', '--no-edit', purgeCommit); } catch { reverted = false; }
    ok(reverted && entryKind((await entryOf(cur(), 'txt_s'))?.meta) === 'P' && !(await allText(cur())).includes(SECRET),
      'git revert of a purge merges through the driver and stays purged: the secret is nowhere in the file');
  }

  // `git revert` of a delete brings the card back — under a revived id, so
  // every copy that holds the delete agrees with it.
  {
    put(await addCard(cur(), 'txt_d', 'delta — deleted, then the delete reverted'));
    commit(g2, 'd card');
    put(await deleteWithReceipt(cur(), 'txt_d'));
    const deleteCommit = commit(g2, 'delete d');
    const E = await entryOf(cur(), 'txt_d');
    put(await addCard(cur(), 'txt_after_delete', 'written after the delete'));
    commit(g2, 'after the delete');
    let reverted = true;
    try { g2('revert', '--no-edit', deleteCommit); } catch { reverted = false; }
    const dR = revivedIdFor('txt_d', E.meta, E.json);
    const ids = await liveIds(cur());
    ok(reverted && ids.includes(dR) && !ids.includes('txt_d') && /delta — deleted, then the delete reverted/.test(await textAt(cur(), dR) || ''),
      'git revert of a delete brings the card back under its revived id, the old id still deleted');
  }

  // A card removed on both branches with no receipt is buried from the ancestor.
  {
    put(await addCard(cur(), 'txt_e', 'echo — removed on both branches, no receipt'));
    commit(g2, 'e card');
    const baseJson = await (await parseKlypix(cur())).zip.file(`items/${shard('txt_e')}/txt_e.json`).async('string');
    g2('checkout', '-qb', 'drop-a');
    put(await addCard(await dropCard(cur(), 'txt_e'), 'txt_only_a', 'only on a'));
    commit(g2, 'drop e on a');
    g2('checkout', '-q', 'main');
    g2('checkout', '-qb', 'drop-b');
    put(await addCard(await dropCard(cur(), 'txt_e'), 'txt_only_b', 'only on b'));
    commit(g2, 'drop e on b');
    g2('merge', '-q', '--no-edit', 'drop-a');
    const e = await entryOf(cur(), 'txt_e');
    const ids = await liveIds(cur());
    ok(!ids.includes('txt_e') && ids.includes('txt_only_a') && ids.includes('txt_only_b')
      && entryKind(e?.meta) === 'F' && e.json === baseJson && e.meta.deletion?.cause === 'git-committed-absence',
    'a card removed on both branches without a receipt is buried from the ancestor, with a receipt saying so');
    g2('checkout', '-q', 'main');
  }

  // The same conflict merged in two clones lands on the same twin id.
  {
    put(await addCard(cur(), 'txt_c', 'charlie — before both edits'));
    commit(g2, 'c card');
    g2('checkout', '-qb', 'edit-x');
    put(await setCard(cur(), 'txt_c', 'charlie — edited on x'));
    commit(g2, 'x');
    g2('checkout', '-q', 'main');
    g2('checkout', '-qb', 'edit-y');
    put(await setCard(cur(), 'txt_c', 'charlie — edited on y'));
    const yJson = await (await parseKlypix(cur())).zip.file(`items/${shard('txt_c')}/txt_c.json`).async('string');
    commit(g2, 'y');
    g2('checkout', '-q', 'main');
    const R3 = path.join(TMP, 'repo-stage2-clone');
    execFileSync('git', ['clone', '-q', R2, R3], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const g3 = gitIn(R3);
    g3('config', 'user.email', 'clone@test.local');
    g3('config', 'user.name', 'stage 2 clone');
    run(['git-driver', 'install'], { cwd: R3 });
    g2('checkout', '-q', 'edit-x');
    g2('merge', '-q', '--no-edit', 'edit-y');
    g3('checkout', '-q', '-b', 'edit-x', 'origin/edit-x');
    g3('merge', '-q', '--no-edit', 'origin/edit-y');
    const twinsIn = async (file) => (await liveIds(fs.readFileSync(file))).filter((id) => id.startsWith('txt_c__agconf_'));
    const t2 = await twinsIn(BR);
    const t3 = await twinsIn(path.join(R3, 'brain.klypix'));
    ok(t2.length === 1 && JSON.stringify(t2) === JSON.stringify(t3) && t2[0] === twinIdFor('txt_c', yJson, 0),
      'the same conflict merged in two clones lands on one twin id in both');
  }
}

console.log(`\n${failures ? `[x] ${failures} assertion(s) failed` : '[ok] git-tools: all assertions passed'}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
