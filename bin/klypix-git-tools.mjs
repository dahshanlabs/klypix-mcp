#!/usr/bin/env node
// klypix-git-tools — the GitHub lane: three verbs that put the brain where
// dev teams actually live (the repo and the PR page).
//
//   git-driver [install|status] [repo]   register the lossless .klypix merge
//                                        driver for a repo, zero-command
//   diff [ref] [--brain <path>]          readable brain diff vs a git ref
//   pr-brief [baseRef] [--brain <path>]  brain cards touching the files
//                                        changed since baseRef (PR comment)
//
// Design rules inherited from the engine:
//   • ONE merge engine — the driver rides src/merge-brains.mjs verbatim.
//   • The registered driver path is the INSTALLED runtime
//     (~/.claude/project-brain) — stable across npx cache evictions; this
//     module self-provisions the four engine files + their two deps there
//     when missing, without running the full hook installer.
//   • A truncated list must NEVER render as complete: every capped section
//     emits its "…and N more" through an unguarded push.
//   • Failure is a calm, specific message + non-zero exit — never a stack.

// SHAPE: this is a LIB — the worker dispatcher splices the verb out of argv
// before importing a verb bin (see runVerb), so each verb has a THIN bin
// (klypix-git-driver.mjs / klypix-diff.mjs / klypix-pr-brief.mjs) that calls
// run(<verb>, argv.slice(2)) here. Standalone `node <bin> …` works identically.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
// Overridable for tests (temp dirs only — never point tests at the real one).
const BRAIN_DIR = process.env.KLYPIX_BRAIN_DIR || path.join(os.homedir(), '.claude', 'project-brain');

let args = [];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
let positional = [];

const git = (cwd, gitArgs, opts = {}) => new Promise((resolve, reject) => {
  execFile('git', gitArgs, { cwd, timeout: 15000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, ...opts },
    (err, stdout) => err ? reject(err) : resolve(stdout));
});
const gitText = async (cwd, ...a) => String(await git(cwd, a)).trim();

async function repoToplevel(startDir) {
  try { return await gitText(startDir, 'rev-parse', '--show-toplevel'); }
  catch { return null; }
}

function findBrain(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    return fs.existsSync(p) ? p : null;
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const p = path.join(dir, 'brain.klypix');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Card text is stored CANVAS-WRAPPED (single \n ≈ visual line breaks), so a
// naive first-line is ~35 chars of a sentence. Join the first paragraph back
// into prose and cap it.
const firstLine = (t) => {
  const para = String(t || '').split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').trim();
  return para.length > 110 ? `${para.slice(0, 110)}…` : para;
};

async function loadEngine() {
  const format = await import(new URL('../src/klypix-format.mjs', import.meta.url).href);
  const merge = await import(new URL('../src/merge-brains.mjs', import.meta.url).href);
  return { format, merge };
}

// ── git-driver ──────────────────────────────────────────────────────────────

const ENGINE_FILES = ['klypix-merge-driver.mjs', 'merge-brains.mjs', 'klypix-format.mjs', 'brain-graveyard.mjs'];
const ENGINE_DEPS = ['jszip', 'fractional-indexing'];

// Make sure the INSTALLED runtime can actually run the driver: the four
// engine files plus their two runtime deps. This is deliberately a
// light provision — it never touches hooks or servers; the full installer
// remains `npx klypix-mcp install`.
function ensureDriverRuntime() {
  const provisioned = [];
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  for (const f of ENGINE_FILES) {
    const dest = path.join(BRAIN_DIR, f);
    const srcFile = path.join(SRC, f);
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== fs.readFileSync(srcFile, 'utf8')) {
      fs.copyFileSync(srcFile, dest);
      provisioned.push(f);
    }
  }
  const requireHere = createRequire(import.meta.url);
  // Modern packages fence `exports`, so `<dep>/package.json` may not resolve —
  // resolve the MAIN entry instead and walk up to the package root.
  const depRootOf = (dep) => {
    let p = path.dirname(requireHere.resolve(dep));
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(p, 'package.json');
      try {
        if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).name === dep) return p;
      } catch { /* keep walking */ }
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
    throw new Error(`cannot locate package root for dependency "${dep}"`);
  };
  const destMods = path.join(BRAIN_DIR, 'node_modules');
  // Deps are provisioned as their RECURSIVE closure (jszip alone pulls pako,
  // lie, readable-stream, …) — everything resolves from the local install, so
  // this stays offline and deterministic. Nested (unhoisted) deps resolve via
  // a require scoped to their parent package.
  const provisionDep = (dep, fromDir, seen) => {
    if (seen.has(dep)) return;
    seen.add(dep);
    let root;
    try { root = depRootOf(dep); }
    catch {
      const scoped = createRequire(path.join(fromDir, 'package.json'));
      let p = path.dirname(scoped.resolve(dep));
      while (p !== path.dirname(p) && !fs.existsSync(path.join(p, 'package.json'))) p = path.dirname(p);
      root = p;
    }
    const destDir = path.join(destMods, dep);
    if (!fs.existsSync(destDir)) {
      // Exclude only node_modules NESTED INSIDE the package (the closure walk
      // provisions those flat) — judged relative to the package root, because
      // the source root itself lives under a node_modules path.
      fs.cpSync(root, destDir, {
        recursive: true,
        filter: (s) => !path.relative(root, s).split(path.sep).includes('node_modules'),
      });
      provisioned.push(`node_modules/${dep}`);
    }
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* leaf */ }
    for (const child of Object.keys(pkg.dependencies || {})) provisionDep(child, root, seen);
  };
  const seen = new Set();
  for (const dep of ENGINE_DEPS) provisionDep(dep, path.join(HERE, '..'), seen);
  return provisioned;
}

const DRIVER_ATTR_RULE = '*.klypix merge=klypix -text';

async function gitDriver() {
  const sub = positional[0] && !fs.existsSync(positional[0]) ? positional[0] : 'install';
  const repoArg = positional.find(p => fs.existsSync(p)) || process.cwd();
  const toplevel = await repoToplevel(repoArg);
  if (!toplevel) { console.error(`Not a git repository: ${repoArg}`); process.exit(1); }

  const driverPath = path.join(BRAIN_DIR, 'klypix-merge-driver.mjs');
  const driverCmd = `node "${driverPath.replace(/\\/g, '/')}" %O %A %B %P`;
  const gaPath = path.join(toplevel, '.gitattributes');
  const gaText = fs.existsSync(gaPath) ? fs.readFileSync(gaPath, 'utf8') : '';
  const gaHasRule = /merge=klypix/.test(gaText);

  if (sub === 'status') {
    let configured = '';
    try { configured = await gitText(toplevel, 'config', '--get', 'merge.klypix.driver'); } catch { /* unset */ }
    const runtimeOk = ENGINE_FILES.every(f => fs.existsSync(path.join(BRAIN_DIR, f)));
    console.log(`repo:          ${toplevel}`);
    console.log(`driver config: ${configured || '(not registered)'}`);
    console.log(`.gitattributes rule: ${gaHasRule ? 'present' : 'missing'}`);
    console.log(`installed runtime:   ${runtimeOk ? BRAIN_DIR : 'missing — run: npx klypix-mcp git-driver install'}`);
    process.exit(configured && gaHasRule && runtimeOk ? 0 : 1);
  }

  const provisioned = ensureDriverRuntime();
  let already = false;
  try { already = (await gitText(toplevel, 'config', '--get', 'merge.klypix.driver')) === driverCmd; } catch { /* unset */ }
  if (!already) {
    await git(toplevel, ['config', 'merge.klypix.name', 'KLYPIX lossless brain merge (union by card id)']);
    await git(toplevel, ['config', 'merge.klypix.driver', driverCmd]);
  }
  let gaState = 'present';
  if (!gaHasRule) {
    const rule = `${gaText && !gaText.endsWith('\n') ? '\n' : ''}# .klypix brains merge losslessly via the KLYPIX 3-way union driver\n# (per-machine registration: npx klypix-mcp git-driver install).\n${DRIVER_ATTR_RULE}\n`;
    fs.appendFileSync(gaPath, rule);
    gaState = 'added';
  }
  console.log(`✓ ${already ? 'Already registered' : 'Registered'} the .klypix merge driver for ${toplevel}`);
  console.log(`    driver: ${driverPath}${provisioned.length ? `  (provisioned: ${provisioned.join(', ')})` : ''}`);
  console.log(`    .gitattributes rule: ${gaState}${gaState === 'added' ? ' — commit it so every teammate\'s clone routes .klypix merges here' : ''}`);
  console.log('  Teammates run the same command once per machine; unregistered machines fall back to a normal conflict.');
}

// ── diff ────────────────────────────────────────────────────────────────────

function renderCardList(title, entries, cap = 20) {
  if (!entries.length) return [];
  const lines = [`**${title} (${entries.length})**`];
  for (const e of entries.slice(0, cap)) lines.push(`- ${e}`);
  // Truncation notice is NEVER subject to the cap it reports.
  if (entries.length > cap) lines.push(`- …and ${entries.length - cap} more`);
  lines.push('');
  return lines;
}

async function brainDiff() {
  const ref = positional[0] || 'HEAD';
  const brain = findBrain(flag('--brain'));
  if (!brain) { console.error('No brain.klypix found (searched upward from cwd; use --brain <path>).'); process.exit(1); }
  const toplevel = await repoToplevel(path.dirname(brain));
  if (!toplevel) { console.error(`Brain is not inside a git repository: ${brain}`); process.exit(1); }
  const rel = path.relative(toplevel, brain).replace(/\\/g, '/');

  const { format, merge } = await loadEngine();
  const current = fs.readFileSync(brain);

  let baseBuf = null;
  try { baseBuf = Buffer.from(await git(toplevel, ['show', `${ref}:${rel}`], { encoding: 'buffer' })); }
  catch { baseBuf = null; }

  const out = [`### 🧠 Brain diff — \`${rel}\` vs \`${ref}\``, ''];
  if (!baseBuf || baseBuf.length === 0) {
    const { struct } = await format.parseKlypix(current);
    out.push(`The brain does not exist at \`${ref}\` — everything is new here (${struct.cards.length} cards).`);
    console.log(out.join('\n'));
    return;
  }

  // SEMANTIC diff, never byte diff: .klypix re-serialization is deliberately
  // non-reproducible (zip metadata, zIndex renumbering), so comparing raw item
  // bytes reports the whole brain as "updated" (live-reproduced: 1308 false
  // updates over 8 commits). Parse both sides and compare key-sorted JSON with
  // display-derived fields stripped — the same discipline as the sync core.
  const stable = (v) => JSON.stringify(v, (_k, val) =>
    (val && typeof val === 'object' && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map(x => [x, val[x]]))
      : val);
  const cardMap = async (buf) => {
    const { zip, canvas } = await format.parseKlypix(buf);
    const ids = [...new Set([...(Array.isArray(canvas.order) ? canvas.order : []), ...Object.keys(canvas.positions || {})])];
    const m = new Map();
    for (const id of ids) {
      const f = zip.file(`items/${format.shard(id)}/${id}.json`);
      if (!f) continue;
      try {
        const item = JSON.parse(await f.async('string'));
        m.set(id, {
          sig: stable({ ...item, zIndex: undefined }),
          title: firstLine(item.content || item.title || '') || `\`${id}\``,
        });
      } catch { /* unreadable item — skip rather than mis-report */ }
    }
    return { map: m, connections: Array.isArray(canvas.connections) ? canvas.connections.length : 0 };
  };
  void merge; // brainDelta stays the live-apply engine; diff is semantic by design

  const [baseSide, curSide] = await Promise.all([cardMap(baseBuf), cardMap(current)]);
  const added = [], updated = [], removed = [];
  for (const [id, cur] of curSide.map) {
    const prev = baseSide.map.get(id);
    if (!prev) added.push(cur.title);
    else if (prev.sig !== cur.sig) updated.push(cur.title);
  }
  for (const [id, prev] of baseSide.map) {
    if (!curSide.map.has(id)) removed.push(prev.title);
  }
  const connDelta = curSide.connections - baseSide.connections;

  if (!added.length && !updated.length && !removed.length && !connDelta) {
    out.push('No card-level changes.');
  } else {
    out.push(`**${added.length} added · ${updated.length} updated · ${removed.length} removed**`, '');
    out.push(...renderCardList('Added', added));
    out.push(...renderCardList('Updated', updated));
    out.push(...renderCardList('Removed', removed));
    if (connDelta) out.push(`_${connDelta > 0 ? '+' : ''}${connDelta} connection(s)._`);
  }
  console.log(out.join('\n'));
}

// ── pr-brief ────────────────────────────────────────────────────────────────

// The brain's own evidence-tag convention: #file-<slug> where slug is the
// basename minus its last extension, lowercased, non-alphanumerics folded to
// hyphens. Tag matches only (precision over recall — a PR comment that spams
// unrelated cards teaches people to ignore it).
function fileSlug(p) {
  const base = path.basename(p).replace(/\.[^.]+$/, '');
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function prBrief() {
  const baseRef = positional[0] || 'HEAD~1';
  const brain = findBrain(flag('--brain'));
  if (!brain) { console.error('No brain.klypix found (searched upward from cwd; use --brain <path>).'); process.exit(1); }
  const toplevel = await repoToplevel(path.dirname(brain));
  if (!toplevel) { console.error(`Brain is not inside a git repository: ${brain}`); process.exit(1); }

  let changed = [];
  try {
    changed = String(await git(toplevel, ['diff', '--name-only', `${baseRef}...HEAD`]))
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`git diff against "${baseRef}" failed: ${String(e.message || e).split('\n')[0]}`);
    process.exit(1);
  }
  if (!changed.length) { console.log('_No changed files — no brain context to attach._'); return; }

  const { format } = await loadEngine();
  const { struct } = await format.parseKlypix(fs.readFileSync(brain));

  const perFile = new Map();   // file -> [card first lines]
  let total = 0;
  for (const file of changed) {
    const slug = fileSlug(file);
    if (!slug) continue;
    const tag = `#file-${slug}`;
    const hits = [];
    for (const card of struct.cards) {
      const text = String(card.text || card.title || '');
      const idx = text.indexOf(tag);
      if (idx < 0) continue;
      // Tag boundary: the next char must not extend the slug (avoids
      // #file-use matching #file-usechat).
      const after = text[idx + tag.length];
      if (after && /[a-z0-9-]/.test(after)) continue;
      hits.push(firstLine(text));
      if (hits.length >= 3) break;   // cap per file; total notice below
    }
    if (hits.length) { perFile.set(file, hits); total += hits.length; }
  }

  if (!perFile.size) {
    console.log(`_No brain cards reference the ${changed.length} changed file(s)._`);
    return;
  }

  const out = [`### 🧠 Brain context for this PR`, '',
    `Decisions and findings already recorded about the files this PR touches (${perFile.size} of ${changed.length} changed files have brain context):`, ''];
  let printed = 0;
  const FILE_CAP = 12;
  let fileIdx = 0;
  for (const [file, hits] of perFile) {
    if (fileIdx >= FILE_CAP) break;
    fileIdx++;
    out.push(`**\`${file}\`**`);
    for (const h of hits) { out.push(`- ${h}`); printed++; }
    out.push('');
  }
  if (perFile.size > FILE_CAP) out.push(`…and ${perFile.size - FILE_CAP} more file(s) with brain context.`);
  out.push(`_From \`${path.relative(toplevel, brain).replace(/\\/g, '/')}\` — the project's shared brain. ${printed} card(s) shown._`);
  console.log(out.join('\n'));
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function run(verb, rawArgs) {
  args = Array.isArray(rawArgs) ? rawArgs : [];
  positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--brain');
  try {
    if (verb === 'git-driver') await gitDriver();
    else if (verb === 'diff') await brainDiff();
    else if (verb === 'pr-brief') await prBrief();
    else { console.error(`klypix-git-tools: unknown verb "${verb}"`); process.exit(2); }
  } catch (e) {
    console.error(`${verb} failed: ${String(e?.message || e).split('\n')[0]}`);
    process.exit(1);
  }
}
