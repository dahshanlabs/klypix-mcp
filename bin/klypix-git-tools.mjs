#!/usr/bin/env node
// klypix-git-tools — the GitHub lane: three verbs that put the brain where
// dev teams actually live (the repo and the PR page).
//
//   git-driver [install|status] [repo]   register the card-level .klypix merge
//                                        driver for a repo, zero-command
//   diff [ref] [--brain <path>] [--full] readable brain diff vs a git ref
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

// Dependencies first: klypix-format ← brain-graveyard ← merge-brains ← driver.
// Each file is swapped in atomically, so at every moment the set on disk can
// link — a new merge-brains beside an old klypix-format is the one mix that
// cannot (it imports names the old file lacks).
const ENGINE_FILES = ['klypix-format.mjs', 'brain-graveyard.mjs', 'merge-brains.mjs', 'klypix-merge-driver.mjs'];
const ENGINE_DEPS = ['jszip', 'fractional-indexing'];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Make sure the INSTALLED runtime can actually run the driver: the four
// engine files plus their two runtime deps. This is deliberately a
// light provision — it never touches hooks or servers; the full installer
// remains `npx klypix-mcp install`.
//
// Never a downgrade. The same files arrive from the full installer, the
// desktop bundle and auto-update; an older `npx klypix-mcp git-driver install`
// (or a pinned devDependency) must not put its engine under a newer one. So
// the files are copied only when the install gate says this package may
// install (brainInstallDecision — the same rule the full installer uses), and
// then always as the whole set.
async function ensureDriverRuntime() {
  const provisioned = [];
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  const { brainInstallDecision } = await import(new URL('../src/install-version.mjs', import.meta.url).href);
  const pkg = readJson(path.join(HERE, '..', 'package.json'));
  const stamp = readJson(path.join(BRAIN_DIR, '.brain-version.json'));
  const runtime = readJson(path.join(BRAIN_DIR, '.mcp-runtime.json'));
  const decision = brainInstallDecision({ candidateVersion: pkg?.version, stamp, runtime });
  const result = { provisioned };
  if (decision.action === 'preserve') {
    const owner = decision.reason === 'dev-owned' ? 'a dev deploy' : `v${decision.installedVersion}${stamp?.via ? ` (via ${stamp.via})` : ''}`;
    result.kept = `kept the engine installed by ${owner}; this package is v${decision.candidateVersion}`;
    const missing = ENGINE_FILES.filter((f) => !fs.existsSync(path.join(BRAIN_DIR, f)));
    if (missing.length) result.missing = missing;
  } else {
    // Only files that differ are written, so what is on disk afterwards is
    // exactly this package's set.
    for (const f of ENGINE_FILES) {
      const dest = path.join(BRAIN_DIR, f);
      const body = fs.readFileSync(path.join(SRC, f), 'utf8');
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === body) continue;
      const tmp = `${dest}.klypix-new-${process.pid}`;
      fs.writeFileSync(tmp, body);
      try { fs.renameSync(tmp, dest); }
      catch (err) { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
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
  return result;
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

  const { provisioned, kept, missing } = await ensureDriverRuntime();
  let already = false;
  try { already = (await gitText(toplevel, 'config', '--get', 'merge.klypix.driver')) === driverCmd; } catch { /* unset */ }
  if (!already) {
    await git(toplevel, ['config', 'merge.klypix.name', 'KLYPIX brain merge (3-way, card by card)']);
    await git(toplevel, ['config', 'merge.klypix.driver', driverCmd]);
  }
  let gaState = 'present';
  if (!gaHasRule) {
    const rule = `${gaText && !gaText.endsWith('\n') ? '\n' : ''}# .klypix brains merge card by card via the KLYPIX 3-way driver\n# (per-machine registration: npx klypix-mcp git-driver install).\n${DRIVER_ATTR_RULE}\n`;
    fs.appendFileSync(gaPath, rule);
    gaState = 'added';
  }
  console.log(`✓ ${already ? 'Already registered' : 'Registered'} the .klypix merge driver for ${toplevel}`);
  console.log(`    driver: ${driverPath}${provisioned.length ? `  (provisioned: ${provisioned.join(', ')})` : ''}`);
  if (kept) console.log(`    engine: ${kept}`);
  if (missing?.length) console.log(`    ! the installed engine is missing ${missing.join(', ')} — repair it with: npx klypix-mcp@latest install`);
  console.log(`    .gitattributes rule: ${gaState}${gaState === 'added' ? ' — commit it so every teammate\'s clone routes .klypix merges here' : ''}`);
  console.log('  Teammates run the same command once per machine; unregistered machines fall back to a normal conflict.');
}

// ── diff ────────────────────────────────────────────────────────────────────

const stableJson = (value) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v, 2);

// Review decisions, not canvas styling. Keep other fields (including evidence,
// authorship, locks and lifecycle metadata) visible rather than silently losing
// a meaningful edit to an unfamiliar card type.
const DIFF_DISPLAY_FIELDS = new Set([
  'id', 'updatedAt', 'editedAt', 'zIndex', 'zKey', 'x', 'y', 'w', 'h',
  'width', 'height', 'rotation', 'fontSize', 'fontFamily', 'fontStyle', 'fontWeight',
  'textAlign', 'verticalAlign', 'textDecoration', 'heading', 'border',
  'color', 'textColor', 'backgroundColor', 'borderColor', 'borderWidth',
  'opacity', 'collapsed', 'authoredWidth', 'authoredInParent',
]);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const longestRun = (text, pattern, floor) => {
  let length = floor;
  for (const match of text.matchAll(pattern)) length = Math.max(length, match[0].length);
  return length;
};

// A card can itself contain fences, HTML and Markdown headings. A fence longer
// than anything in its body keeps every byte inert on the PR page.
const literalBlock = (value) => {
  const text = String(value);
  const ticks = longestRun(text, /`+/g, 2), tildes = longestRun(text, /~+/g, 2);
  const fence = ticks <= tildes ? '`'.repeat(ticks + 1) : '~'.repeat(tildes + 1);
  return `${fence}text\n${text}\n${fence}`;
};
const inlineLiteral = (value) => {
  const text = String(value).replace(/[\r\n]/g, ' ');
  const fence = '`'.repeat(longestRun(text, /`+/g, 0) + 1);
  return `${fence} ${text} ${fence}`;
};
const shellQuote = (value) => process.platform === 'win32'
  ? `'${String(value).replace(/'/g, "''")}'`
  : `'${String(value).replace(/'/g, "'\"'\"'")}'`;

async function brainDiff() {
  const ref = positional[0] || 'HEAD';
  const full = args.includes('--full');
  const brain = findBrain(flag('--brain'));
  if (!brain) { console.error('No brain.klypix found (searched upward from cwd; use --brain <path>).'); process.exit(1); }
  const toplevel = await repoToplevel(path.dirname(brain));
  if (!toplevel) { console.error(`Brain is not inside a git repository: ${brain}`); process.exit(1); }
  const rel = path.relative(toplevel, brain).replace(/\\/g, '/');

  const { format } = await loadEngine();
  const current = fs.readFileSync(brain);

  // An invalid revision is an error, not evidence that every card is new.
  const commit = await gitText(toplevel, 'rev-parse', '--verify', `${ref}^{commit}`);
  let baseBuf = null;
  try { baseBuf = Buffer.from(await git(toplevel, ['show', `${commit}:${rel}`], { encoding: 'buffer' })); }
  catch { baseBuf = null; }

  const out = [`### 🧠 Brain diff — ${inlineLiteral(rel)} vs ${inlineLiteral(ref)}`, ''];
  const completeCommand = () => literalBlock(`npx klypix-mcp diff ${shellQuote(commit)} --brain ${shellQuote(rel)} --full`);
  const [baseParsed, curParsed] = await Promise.all([
    baseBuf?.length ? format.parseKlypix(baseBuf) : null, format.parseKlypix(current),
  ]);
  // A lock in EITHER version applies to the whole comparison. Otherwise adding
  // a lock would leak the former body as a removal (and unlocking would leak it
  // as an addition). --full changes truncation only, never this boundary.
  const hidden = new Set();
  for (const parsed of [baseParsed, curParsed]) {
    if (parsed) for (const id of format.scopeLockState(parsed.items).hiddenIds) hidden.add(id);
  }
  if (hidden.size) out.push(`_${hidden.size} card(s) withheld: inside an AI-hidden box in at least one compared version. Their bodies, metadata and connected relationships are omitted._`, '');
  const cardMap = async (parsed) => {
    if (!parsed) return { map: new Map(), connections: new Map() };
    const { zip, canvas, struct } = parsed;
    const areas = new Map(struct.cards.filter(c => c.type === 'container').map(c => [c.id, c.title || '']));
    const ids = [...new Set([...(Array.isArray(canvas.order) ? canvas.order : []), ...Object.keys(canvas.positions || {})])].sort(compareText);
    const m = new Map();
    for (const id of ids) {
      if (hidden.has(id)) continue;
      const f = zip.file(`items/${format.shard(id)}/${id}.json`);
      if (!f) throw new Error(`cannot review missing card ${id}`);
      const item = JSON.parse(await f.async('string'));
      const meaningful = Object.fromEntries(Object.entries(item).filter(([key]) => !DIFF_DISPLAY_FIELDS.has(key)));
      // Moving into Archive changes lifecycle even when the words do not.
      meaningful.parentId = canvas.positions?.[id]?.parentId || null;
      if (meaningful.parentId) meaningful.area = areas.get(meaningful.parentId) || '';
      const { content, ...metadata } = meaningful;
      m.set(id, { id, sig: stableJson(meaningful), body: content == null ? '' : typeof content === 'string' ? content : stableJson(content), metadata });
    }
    const connections = new Map();
    for (const cn of (canvas.connections || [])) {
      if (hidden.has(cn.fromId) || hidden.has(cn.toId)) continue;
      const semantic = { fromId: cn.fromId, toId: cn.toId, label: cn.label || '', relationship: cn.relationship || '' };
      const key = stableJson(semantic);
      connections.set(key, semantic);
    }
    return { map: m, connections };
  };

  const [baseSide, curSide] = await Promise.all([cardMap(baseParsed), cardMap(curParsed)]);
  const added = [], updated = [], removed = [];
  for (const [id, cur] of curSide.map) {
    const prev = baseSide.map.get(id);
    if (!prev) added.push({ id, after: cur });
    else if (prev.sig !== cur.sig) updated.push({ id, before: prev, after: cur });
  }
  for (const [id, prev] of baseSide.map) {
    if (!curSide.map.has(id)) removed.push({ id, before: prev });
  }
  const addedLinks = [...curSide.connections.keys()].filter(k => !baseSide.connections.has(k)).sort(compareText);
  const removedLinks = [...baseSide.connections.keys()].filter(k => !curSide.connections.has(k)).sort(compareText);

  if (!added.length && !updated.length && !removed.length && !addedLinks.length && !removedLinks.length) {
    out.push('No card-level changes.');
  } else {
    const entryCap = full ? Infinity : 20;
    let remaining = full ? Infinity : 32000;
    let truncated = false;
    const renderValue = (value) => {
      const text = String(value);
      const count = Math.min(text.length, remaining, full ? Infinity : 4500);
      remaining -= count;
      if (count < text.length) truncated = true;
      return `${literalBlock(text.slice(0, count))}${count < text.length ? `\n_Truncated: ${text.length - count} character(s) omitted._` : ''}`;
    };
    const renderCards = (title, entries) => {
      if (!entries.length) return;
      out.push(`**${title} (${entries.length})**`, '');
      for (const entry of entries.slice(0, entryCap)) {
        out.push(`#### Card ${inlineLiteral(entry.id)}`, '');
        for (const [label, side] of [['Before', entry.before], ['After', entry.after]]) {
          if (!side) continue;
          out.push(`**${label}**`, '', renderValue(side.body), '');
          out.push(`**${label} metadata**`, '', renderValue(stableJson(side.metadata)), '');
        }
      }
      if (entries.length > entryCap) {
        truncated = true;
        out.push(`_${entries.length - entryCap} more ${title.toLowerCase()} card(s) omitted._`, '');
      }
    };
    const renderLinks = (title, entries) => {
      if (!entries.length) return;
      out.push(`**${title} (${entries.length})**`, '');
      for (const entry of entries.slice(0, entryCap)) out.push(renderValue(entry), '');
      if (entries.length > entryCap) { truncated = true; out.push(`_${entries.length - entryCap} more relationship(s) omitted._`, ''); }
    };
    out.push(`**${added.length} added · ${updated.length} updated · ${removed.length} removed**`, '');
    renderCards('Added', added);
    renderCards('Updated', updated);
    renderCards('Removed', removed);
    renderLinks('Relationships added', addedLinks);
    renderLinks('Relationships removed', removedLinks);
    if (truncated) {
      out.push('**This preview is truncated.** From the repository root, print the complete diff (or redirect it to a file):', '',
        completeCommand());
    }
  }
  const rendered = out.join('\n');
  // Host comment limits count the fencing and labels too. Adversarial bodies
  // with long runs of BOTH fence characters can roughly double their rendered
  // size; never ship an oversized preview that GitHub simply refuses to post.
  if (!full && rendered.length > 56000) {
    console.log([out[0], '', `**${added.length} added · ${updated.length} updated · ${removed.length} removed**`,
      `${addedLinks.length} relationship(s) added · ${removedLinks.length} removed.`,
      hidden.size ? `${hidden.size} AI-hidden card(s) withheld from both versions.` : '', '',
      '**This preview is truncated:** rendered content exceeds the display limit. From the repository root, print the complete diff (or redirect it to a file):', '',
      completeCommand()].filter(Boolean).join('\n\n'));
  } else console.log(rendered);
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
  const { struct } = format.scopeLockedView(await format.parseKlypix(fs.readFileSync(brain)));

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
