// Search by meaning by default (1.97.0): who gets it, what is trimmed, and —
// the part a person feels — preparing a brain never holds a question.
//
// The model-touching half runs in a child process with HOME/USERPROFILE in a
// temp dir and a fake embedder: no model, no network, never the live
// ~/.claude/project-brain.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

if (process.env.KLYPIX_PREP_TEST_CHILD === '1') {
  const semantic = await import('../src/semantic-memory.mjs');
  const brain = process.env.KLYPIX_PREP_TEST_BRAIN;
  const cards = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, type: 'text', text: `card number ${i} about topic ${i % 7}`, createdAt: 1_000 + i }));
  const embeddedIds = [];
  const pipe = async (texts) => {
    for (const t of texts) embeddedIds.push(t);
    return { dims: [texts.length, 3], data: Float32Array.from(texts.flatMap((_, i) => [1, i + 1, 0.5])), dispose() {} };
  };
  const out = {};
  const s1 = {};
  const m1 = await semantic.vectorsForBrain(pipe, brain, cards, { stats: s1 });
  out.first = { size: m1.size, stats: s1, newestFirst: embeddedIds.slice(0, 3) };
  const progress = [];
  const s2 = {};
  const m2 = await semantic.vectorsForBrain(pipe, brain, cards, { maxEmbed: Infinity, stats: s2, onProgress: (p) => progress.push(p) });
  out.full = { size: m2.size, stats: s2, progressLast: progress.at(-1) };
  const embDir = path.join(os.homedir(), '.claude', 'project-brain', 'embeddings');
  const cacheFile = fs.readdirSync(embDir).filter(f => f.endsWith('.json')).map(f => path.join(embDir, f))[0];
  out.saved = Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).cards).length;
  // A preparation holds the lock: a question must not wait for it.
  const more = [...cards, ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: 'text', text: `new card ${i}`, createdAt: 9_000 + i }))];
  fs.writeFileSync(`${cacheFile}.lock`, JSON.stringify({ pid: 1, at: Date.now() }));
  const s3 = {};
  const t0 = Date.now();
  const m3 = await semantic.vectorsForBrain(pipe, brain, more, { stats: s3 });
  out.busy = { ms: Date.now() - t0, size: m3.size, stats: s3 };
  fs.unlinkSync(`${cacheFile}.lock`);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const { semanticInstallDecision, pruneSemanticRuntime, SEMANTIC_RUNTIME_MANIFEST } = await import('../src/semantic-install.mjs');

// ── Who gets it ─────────────────────────────────────────────────────────────
const base = { optOut: false, flag: false, runtimeOnly: false, plugin: false, present: false, ci: false, tty: true };
ok(semanticInstallDecision(base) === 'install', 'a person at a terminal gets search by meaning by default');
ok(semanticInstallDecision({ ...base, tty: false }) === 'skip-noninteractive', 'no terminal (scripts, agents, the test suite): not without --semantic');
ok(semanticInstallDecision({ ...base, tty: false, flag: true }) === 'install', '--semantic turns it on anywhere');
ok(semanticInstallDecision({ ...base, ci: true }) === 'skip-ci', 'CI: not without --semantic');
ok(semanticInstallDecision({ ...base, flag: true, optOut: true }) === 'skip-optout', '--no-semantic / KLYPIX_SEMANTIC=0 wins');
ok(semanticInstallDecision({ ...base, flag: true, plugin: true }) === 'skip-plugin', 'plugin mode never downloads it');
ok(semanticInstallDecision({ ...base, runtimeOnly: true }) === 'skip-runtime-only', 'an auto-update never adds a 150 MB download on its own');
ok(semanticInstallDecision({ ...base, present: true }) === 'present', 'already installed: nothing to do');
ok(SEMANTIC_RUNTIME_MANIFEST.dependencies['@huggingface/transformers'] === '4.2.0' && SEMANTIC_RUNTIME_MANIFEST.dependencies.sharp === '0.35.5', 'pins match the desktop app (transformers 4.2.0, sharp 0.35.5)');

// ── What is trimmed ─────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-prep-'));
const touch = (rel, bytes = 1000) => { const p = path.join(root, 'sem', 'node_modules', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); };
touch('onnxruntime-web/dist/ort.wasm', 5000);
for (const plat of ['win32/x64', 'win32/arm64', 'linux/x64', 'linux/arm64', 'darwin/arm64']) touch(`onnxruntime-node/bin/napi-v6/${plat}/onnxruntime.node`, 2000);
touch('@huggingface/transformers/package.json', 10);
const freed = pruneSemanticRuntime(path.join(root, 'sem'), 'win32', 'x64');
const has = (rel) => fs.existsSync(path.join(root, 'sem', 'node_modules', rel));
ok(has('onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.node'), 'prune keeps the running platform and architecture');
ok(!has('onnxruntime-node/bin/napi-v6/win32/arm64') && !has('onnxruntime-node/bin/napi-v6/linux') && !has('onnxruntime-node/bin/napi-v6/darwin'), 'prune removes other platforms and architectures');
ok(!has('onnxruntime-web') && has('@huggingface/transformers/package.json'), 'prune removes the browser build Node never loads, and nothing else');
ok(freed === 5000 + 4 * 2000, `prune reports what it freed (${freed} bytes)`);
touch('onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime.node', 2000);
pruneSemanticRuntime(path.join(root, 'sem'), 'freebsd', 'x64');
ok(has('onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime.node') && has('onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.node'), 'on a platform the tree has no binary for, nothing native is removed');

// ── Preparing never holds a question (sandboxed child) ──────────────────────
const home = path.join(root, 'home');
const brain = path.join(root, 'project', 'brain.klypix');
fs.mkdirSync(path.dirname(brain), { recursive: true });
fs.writeFileSync(brain, 'cache identity only');
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
  env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_PREP_TEST_CHILD: '1', KLYPIX_PREP_TEST_BRAIN: brain },
  encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
});
let out = null;
try { out = JSON.parse(child.stdout); } catch { console.error({ status: child.status, stderr: String(child.stderr || '').slice(-2000) }); }
ok(!!out, 'the sandboxed preparation run completed');
if (out) {
  ok(out.first.size === 32 && out.first.stats.embedded === 32 && out.first.stats.pending === 68, `a question embeds at most 32 cards inline and reports the rest as pending (${JSON.stringify(out.first.stats)})`);
  ok(out.first.newestFirst[0].includes('card number 99') && out.first.newestFirst[1].includes('card number 98'), 'newest cards are prepared first');
  ok(out.full.size === 100 && out.full.stats.pending === 0 && out.full.stats.embedded === 68, 'the background preparation finishes the rest, re-embedding nothing');
  ok(out.full.progressLast && out.full.progressLast.done === 100 && out.full.progressLast.total === 100, 'it reports progress as it goes');
  ok(out.saved === 100, 'and the result is saved for every later question');
  ok(out.busy.ms < 8_000, `a question while a preparation holds the lock answers in ${out.busy.ms} ms instead of waiting up to 10 min`);
  ok(out.busy.size === 100 && out.busy.stats.busy === true && out.busy.stats.pending === 10, 'it answers from what is already prepared and reports the new cards as pending');
}

// ── The sentence an answer carries while preparing ──────────────────────────
const semantic = await import('../src/semantic-memory.mjs');
const statusFile = path.join(root, 'status.json');
const now = Date.parse('2026-10-11T10:00:00Z');
fs.writeFileSync(statusFile, JSON.stringify({ result: 'preparing', brain, done: 1200, total: 3670, startedAt: '2026-10-11T09:57:00Z', updatedAt: '2026-10-11T09:59:30Z' }));
const live = semantic.brainPreparationStatus(brain, { now, statusFile });
ok(live && live.done === 1200 && live.total === 3670 && live.remainingMs > 0, 'the live progress is read for this brain');
ok(semantic.brainPreparationStatus(path.join(root, 'other.klypix'), { now, statusFile }) === null, 'another brain\'s progress is not reported as this one\'s');
ok(semantic.brainPreparationStatus(brain, { now: now + 10 * 60_000, statusFile }) === null, 'a run that stopped reporting is not shown as running');
const notice = semantic.preparationNotice(brain, { wanted: 3670, ready: 900, pending: 2770 }, { usedMeaning: false, now: Date.now() });
ok(/^Getting this brain ready for search by meaning: 900 of 3,670 cards so far, about \d+ min left\. This answer used keyword search/.test(notice), `the answer says how far along it is: "${notice}"`);
ok(semantic.preparationNotice(brain, { wanted: 10, ready: 10, pending: 0 }) === null, 'a ready brain carries no notice');

// ── Starting it ─────────────────────────────────────────────────────────────
const calls = [];
const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
const t0 = 5_000_000;
ok(semantic.startBrainPreparation(brain, { spawnFn: fakeSpawn, now: t0 }) === true, 'a pending brain starts a background preparation');
ok(calls.length === 1 && calls[0].args.includes('--only') && calls[0].args.includes(path.resolve(brain)) && calls[0].opts.detached === true, 'for that brain only, detached');
ok(semantic.EMBED_BATCH_DEFAULT === 1, 'one card per call by default: measured fastest and lightest (41–49 ms a card, ~305 MB peak)');
ok(semantic.startBrainPreparation(brain, { spawnFn: fakeSpawn, now: t0 + 10_000 }) === false && calls.length === 1, 'not again within a minute');
process.env.KLYPIX_PLUGIN = '1';
ok(semantic.startBrainPreparation(path.join(root, 'b2.klypix'), { spawnFn: fakeSpawn, now: t0 }) === false, 'never in plugin mode');
delete process.env.KLYPIX_PLUGIN;

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ semantic-preparation: all assertions passed');
process.exit(failures ? 1 : 0);
