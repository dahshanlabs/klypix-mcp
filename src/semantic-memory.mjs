// Bounded semantic runtime for long-lived KLYPIX MCP/A2A workers.
//
// The deterministic brain core (parsing, lifecycle/correction overlays,
// time-travel, locks, and mutations) does not live here. This module owns only
// optional local neural retrieval so memory failures can always degrade to the
// lexical core without changing project truth.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const EMB_DIR = path.join(PB_DIR, 'embeddings');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const EMBEDDING_POOLING = 'cls';
export const EMBEDDING_CACHE_KEY = `${EMBEDDING_MODEL_ID}|q8|${EMBEDDING_POOLING}|query-instruction-v1`;

const rawMode = String(
  process.env.KLYPIX_SEMANTIC_MEMORY_MODE
  || process.env.KLYPIX_MEMORY_MODE
  || 'bounded',
).trim().toLowerCase();
const MODE = rawMode === 'legacy' ? 'legacy' : 'bounded';
const BOUNDED = MODE === 'bounded';

const intEnv = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
};
const EMBED_BATCH_SIZE = intEnv('KLYPIX_EMBED_BATCH_SIZE', 16, 1, 64);
const RERANK_BATCH_SIZE = intEnv('KLYPIX_RERANK_BATCH_SIZE', 4, 1, 32);
const MAX_INFERENCE_QUEUE = intEnv('KLYPIX_SEMANTIC_MAX_QUEUE', 16, 1, 256);
const idleRaw = process.env.KLYPIX_SEMANTIC_IDLE_MS;
const SEMANTIC_IDLE_MS = idleRaw === '0'
  ? 0
  : intEnv('KLYPIX_SEMANTIC_IDLE_MS', 10 * 60_000, 1_000, 60 * 60_000);
const CACHE_LOCK_TIMEOUT_MS = intEnv('KLYPIX_SEMANTIC_CACHE_LOCK_MS', 10 * 60_000, 1_000, 30 * 60_000);
const CACHE_LOCK_STALE_MS = Math.max(CACHE_LOCK_TIMEOUT_MS + 60_000, 15 * 60_000);

const counters = {
  inferenceCalls: 0,
  embedBatches: 0,
  rerankBatches: 0,
  tensorsDisposed: 0,
  queueRejected: 0,
  maxQueued: 0,
  cacheFilesMerged: 0,
  cacheWrites: 0,
  cacheLockWaits: 0,
  cacheLockTimeouts: 0,
  modelDisposals: 0,
  idleDisposals: 0,
  lastDisposeReason: null,
  highWaterRss: 0,
  highWaterExternal: 0,
  highWaterArrayBuffers: 0,
};
let inferenceTail = Promise.resolve();
let inferenceQueued = 0;
let inferenceActive = 0;
let embedderPromise = null;
let rerankerPromise = null;
const vectorBuildTails = new Map();
let semanticIdleTimer = null;
let semanticLeases = 0;
let lastSemanticActivityAt = Date.now();

const sampleMemory = () => {
  const m = process.memoryUsage();
  counters.highWaterRss = Math.max(counters.highWaterRss, m.rss);
  counters.highWaterExternal = Math.max(counters.highWaterExternal, m.external);
  counters.highWaterArrayBuffers = Math.max(counters.highWaterArrayBuffers, m.arrayBuffers || 0);
  return m;
};

export function semanticMemorySnapshot() {
  const memory = sampleMemory();
  return {
    mode: MODE,
    config: {
      embedBatchSize: BOUNDED ? EMBED_BATCH_SIZE : null,
      rerankBatchSize: BOUNDED ? RERANK_BATCH_SIZE : null,
      maxInferenceQueue: BOUNDED ? MAX_INFERENCE_QUEUE : null,
      prewarm: shouldPrewarmSemantic(),
      idleDisposeMs: BOUNDED ? SEMANTIC_IDLE_MS : null,
      embeddingModel: EMBEDDING_MODEL_ID,
      embeddingPooling: EMBEDDING_POOLING,
      rerankDefault: false,
    },
    queue: { active: inferenceActive, queued: inferenceQueued, leases: semanticLeases },
    counters: { ...counters },
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers || 0,
    },
  };
}

export const semanticMemoryMode = () => MODE;
export const shouldPrewarmSemantic = () => MODE === 'legacy' || process.env.KLYPIX_SEMANTIC_PREWARM === '1';

const clearSemanticIdleTimer = () => {
  if (!semanticIdleTimer) return;
  clearTimeout(semanticIdleTimer);
  semanticIdleTimer = null;
};

const modelsLoaded = () => Boolean(embedderPromise || rerankerPromise);

async function disposeModelsUnlocked(reason = 'explicit') {
  clearSemanticIdleTimer();
  const embedder = await embedderPromise?.catch?.(() => null);
  const reranker = await rerankerPromise?.catch?.(() => null);
  if (BOUNDED) {
    try { await embedder?.dispose?.(); } catch { /* process recycle remains the final fallback */ }
    try { await reranker?.model?.dispose?.(); } catch { /* */ }
  }
  embedderPromise = null;
  rerankerPromise = null;
  counters.modelDisposals++;
  if (reason === 'idle') counters.idleDisposals++;
  counters.lastDisposeReason = reason;
  sampleMemory();
}

function enqueueMaintenance(fn) {
  const run = inferenceTail.catch(() => {}).then(async () => {
    inferenceActive++;
    try { return await fn(); }
    finally { inferenceActive--; }
  });
  inferenceTail = run.catch(() => {});
  return run;
}

function armSemanticIdleDisposal() {
  clearSemanticIdleTimer();
  if (!BOUNDED || SEMANTIC_IDLE_MS <= 0 || !modelsLoaded()) return;
  if (semanticLeases || inferenceActive || inferenceQueued) return;
  const remaining = Math.max(0, SEMANTIC_IDLE_MS - (Date.now() - lastSemanticActivityAt));
  semanticIdleTimer = setTimeout(() => {
    semanticIdleTimer = null;
    if (semanticLeases || inferenceActive || inferenceQueued || !modelsLoaded()) {
      armSemanticIdleDisposal();
      return;
    }
    enqueueMaintenance(async () => {
      if (semanticLeases || Date.now() - lastSemanticActivityAt < SEMANTIC_IDLE_MS || !modelsLoaded()) {
        armSemanticIdleDisposal();
        return;
      }
      await disposeModelsUnlocked('idle');
    }).catch(() => {});
  }, remaining);
  semanticIdleTimer.unref?.();
}

function acquireSemanticLease() {
  semanticLeases++;
  clearSemanticIdleTimer();
  let released = false;
  function release() {
    if (released) return;
    released = true;
    semanticLeases = Math.max(0, semanticLeases - 1);
    lastSemanticActivityAt = Date.now();
    armSemanticIdleDisposal();
  }
  return release;
}

async function withInferenceSlot(label, fn) {
  if (!BOUNDED) return fn();
  if (inferenceQueued >= MAX_INFERENCE_QUEUE) {
    counters.queueRejected++;
    const error = new Error(`semantic inference queue saturated before ${label}`);
    error.code = 'KLYPIX_SEMANTIC_QUEUE_FULL';
    throw error;
  }
  inferenceQueued++;
  counters.maxQueued = Math.max(counters.maxQueued, inferenceQueued);
  const run = inferenceTail.catch(() => {}).then(async () => {
    inferenceQueued--;
    inferenceActive++;
    clearSemanticIdleTimer();
    lastSemanticActivityAt = Date.now();
    counters.inferenceCalls++;
    sampleMemory();
    try { return await fn(); }
    finally {
      inferenceActive--;
      lastSemanticActivityAt = Date.now();
      sampleMemory();
      armSemanticIdleDisposal();
    }
  });
  // A failed inference must not poison the queue for later lexical/semantic work.
  inferenceTail = run.catch(() => {});
  return run;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function disposeTensorTree(value, seen = new Set()) {
  if (!BOUNDED || value == null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (seen.has(value)) return;
  seen.add(value);
  // Transformers.js Tensor exposes dims/data plus dispose(). Do not call a
  // generic object's dispose method here: model/pipeline lifetimes are managed
  // separately and must survive across queries.
  const tensorLike = typeof value.dispose === 'function'
    && (Array.isArray(value.dims) || Object.prototype.hasOwnProperty.call(value, 'ort_tensor'));
  if (tensorLike) {
    try { value.dispose(); counters.tensorsDisposed++; } catch { /* best-effort; lexical fallback stays available */ }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) disposeTensorTree(item, seen);
    return;
  }
  for (const item of Object.values(value)) disposeTensorTree(item, seen);
}

async function loadTransformers() {
  try { return await import('@huggingface/transformers'); }
  catch {
    const base = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist');
    let lastErr;
    for (const f of ['transformers.node.mjs', 'transformers.mjs']) {
      try { return await import(new URL('file:///' + path.join(base, f).replace(/\\/g, '/')).href); }
      catch (error) { lastErr = error; }
    }
    throw lastErr;
  }
}

// Is the on-device runtime INSTALLED at all?
//
// A caller that gets no embedder cannot otherwise tell "warming up / queue
// saturated" (retry works) from "never installed" (retrying forever will not
// help). Those need opposite advice, and conflating them is why a lexical-only
// install can look like a slow one indefinitely — measured 2026-08-10, the
// lexical-only ranker scores recall@5 = 0% on the frozen human question set
// against ~30% with the runtime present, so this is not a cosmetic difference.
//
// Cheap on purpose: resolves the specifier and stats the fallback path. It
// never imports the library and never loads a model, so it is safe to call on
// every query. Mirrors loadTransformers()'s own resolution order — keep the two
// in step.
let runtimeInstalledCache = null;
export function semanticRuntimeInstalled() {
  if (runtimeInstalledCache !== null) return runtimeInstalledCache;
  let found = false;
  try {
    createRequire(import.meta.url).resolve('@huggingface/transformers');
    found = true;
  } catch {
    const base = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist');
    found = ['transformers.node.mjs', 'transformers.mjs'].some(f => {
      try { return fs.existsSync(path.join(base, f)); } catch { return false; }
    });
  }
  runtimeInstalledCache = found;
  return found;
}

// One honest sentence for a caller that fell back to lexical-only ranking.
// Returns null when semantic ranking actually ran, so callers can append it
// unconditionally.
export function semanticFallbackNotice(hadSemantic) {
  if (hadSemantic) return null;
  if (semanticRuntimeInstalled()) {
    return 'lexical only — the on-device semantic model is still warming or the queue is saturated; retry shortly for semantic ranking';
  }
  // Deliberately names no install command: there is no `--semantic` flag, and
  // bin/klypix-install.mjs skips @huggingface/transformers on purpose ("optional,
  // huge"). Inventing a command here would ship a wrong instruction to every
  // MCP host. State the fact and the location; let the caller decide.
  return 'LEXICAL ONLY — @huggingface/transformers is not present, so these are keyword matches with no semantic ranking. '
    + 'Measured on a real 2,377-card brain: recall@5 0% lexical vs ~30% with the runtime. Retrying will not help. '
    + `Semantic ranking activates once the runtime resolves, or is placed at ${path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers')}.`;
}

export function getEmbedder(log = () => {}) {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const t = await loadTransformers();
      t.env.cacheDir = path.join(PB_DIR, 'hf-cache');
      const pipe = await t.pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' });
      lastSemanticActivityAt = Date.now();
      queueMicrotask(armSemanticIdleDisposal);
      return pipe;
    })().catch((error) => {
      log('semantic unavailable (lexical fallback):', error?.message || error);
      return null;
    });
  }
  return embedderPromise;
}

export function getReranker(log = () => {}) {
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      const t = await loadTransformers();
      t.env.cacheDir = path.join(PB_DIR, 'hf-cache');
      const tokenizer = await t.AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
      const model = await t.AutoModelForSequenceClassification.from_pretrained(
        'Xenova/ms-marco-MiniLM-L-6-v2',
        { dtype: 'q8' },
      );
      lastSemanticActivityAt = Date.now();
      queueMicrotask(armSemanticIdleDisposal);
      return { tokenizer, model };
    })().catch((error) => {
      log('reranker unavailable (no rerank):', error?.message || error);
      return null;
    });
  }
  return rerankerPromise;
}

export const getEmbedderForUse = async (log = () => {}, timeoutMs = 20_000) => {
  const loaded = BOUNDED
    ? await withInferenceSlot('embedder-load', () => withTimeout(getEmbedder(log), timeoutMs))
    : await withTimeout(getEmbedder(log), timeoutMs);
  if (!loaded || !BOUNDED) return loaded;
  // Do not hand callers a long-lived reference to a pipeline that idle disposal
  // may retire. The facade resolves the current generation at invocation time,
  // so a post-idle query transparently reloads the exact same model.
  return async (...args) => {
    const release = acquireSemanticLease();
    try {
      const current = await getEmbedder(log);
      if (!current) throw new Error('semantic embedder is unavailable');
      return await current(...args);
    } finally {
      release();
    }
  };
};

export const withRerankerForUse = async (log = () => {}, timeoutMs = 8_000, fn = async value => value) => {
  const loaded = BOUNDED
    ? await withInferenceSlot('reranker-load', () => withTimeout(getReranker(log), timeoutMs))
    : await withTimeout(getReranker(log), timeoutMs);
  if (!loaded) return null;
  if (!BOUNDED) return fn(loaded);
  const release = acquireSemanticLease();
  try {
    // Resolve the current generation only after acquiring the lease. Idle
    // disposal can never retire this model until the complete callback ends.
    const current = await getReranker(log);
    return current ? await fn(current) : null;
  } finally {
    release();
  }
};

async function embedBatch(pipe, texts, kind = 'passage') {
  let output = null;
  try {
    const inputs = kind === 'query' ? texts.map(text => `${EMBEDDING_QUERY_PREFIX}${text}`) : texts;
    output = await pipe(inputs, { pooling: EMBEDDING_POOLING, normalize: true });
    const [n, d] = output?.dims || [];
    if (!Number.isInteger(n) || !Number.isInteger(d) || n !== texts.length || d <= 0 || !output?.data) {
      throw new Error('semantic embedder returned an invalid tensor shape');
    }
    const vectors = [];
    for (let i = 0; i < n; i++) vectors.push(Array.from(output.data.slice(i * d, (i + 1) * d)));
    return vectors;
  } finally {
    disposeTensorTree(output);
  }
}

export async function embedTexts(pipe, texts, { kind = 'passage' } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  const batchSize = BOUNDED ? EMBED_BATCH_SIZE : list.length;
  const vectors = [];
  for (let offset = 0; offset < list.length; offset += batchSize) {
    const batch = list.slice(offset, offset + batchSize);
    counters.embedBatches++;
    const part = BOUNDED
      ? await withInferenceSlot('embedding', () => embedBatch(pipe, batch, kind))
      : await embedBatch(pipe, batch, kind);
    vectors.push(...part);
  }
  return vectors;
}

export const dot = (a, b) => {
  let score = 0;
  const n = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i++) score += a[i] * b[i];
  return score;
};

export function canonicalBrainKey(brainPath) {
  let key = path.resolve(String(brainPath)).replace(/\\/g, '/');
  // Windows drive letters are case-insensitive; the old exact-string key made
  // E:/... and e:/... duplicate full vector caches. Preserve all other casing
  // because macOS/Linux projects can live on case-sensitive filesystems.
  if (/^[A-Z]:/.test(key)) key = key[0].toLowerCase() + key.slice(1);
  return key;
}

function cacheCandidates(brainPath) {
  const raw = String(brainPath).replace(/\\/g, '/');
  const canonical = canonicalBrainKey(brainPath);
  const variants = [
    canonical,
    raw,
    raw.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':'),
    raw.replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ':'),
  ];
  return [...new Set(variants)].map((key) => ({ key, file: path.join(EMB_DIR, sha1(key) + '.json') }));
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function withCrossProcessCacheLock(brainPath, fn) {
  const file = cacheCandidates(brainPath)[0].file;
  const lockFile = `${file}.lock`;
  fs.mkdirSync(EMB_DIR, { recursive: true });
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  let handle = null;
  let waited = false;
  while (!handle) {
    try {
      handle = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now(), modelKey: EMBEDDING_CACHE_KEY }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!waited) { counters.cacheLockWaits++; waited = true; }
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > CACHE_LOCK_STALE_MS) { fs.unlinkSync(lockFile); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) {
        counters.cacheLockTimeouts++;
        const timeout = new Error(`semantic cache lock timed out for ${path.basename(brainPath)}`);
        timeout.code = 'KLYPIX_SEMANTIC_CACHE_BUSY';
        throw timeout;
      }
      await wait(75);
    }
  }
  try { return await fn(); }
  finally {
    try { fs.closeSync(handle); } catch { /* */ }
    try { fs.unlinkSync(lockFile); } catch { /* stale cleanup handles leftovers */ }
  }
}

function writeCacheAtomic(file, cache) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* cache is best-effort */ }
  }
}

function readCache(brainPath, desiredHashes) {
  if (!BOUNDED) {
    const key = String(brainPath).replace(/\\/g, '/');
    const file = path.join(EMB_DIR, sha1(key) + '.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.modelKey === EMBEDDING_CACHE_KEY) return { file, cache: parsed, dirty: false };
      return { file, cache: { v: 2, modelKey: EMBEDDING_CACHE_KEY, cards: {} }, dirty: true };
    } catch { return { file, cache: { v: 2, modelKey: EMBEDDING_CACHE_KEY, cards: {} }, dirty: false }; }
  }
  const candidates = cacheCandidates(brainPath);
  const file = candidates[0].file;
  const cache = { v: 2, modelKey: EMBEDDING_CACHE_KEY, cards: {} };
  let found = 0;
  let canonicalValid = false;
  let canonicalStale = false;
  let mergedFromAlias = false;
  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(candidate.file, 'utf8')); }
    catch { continue; }
    if (!parsed?.cards) continue;
    const canonical = candidate.file === file;
    if (parsed.modelKey !== EMBEDDING_CACHE_KEY) {
      if (canonical) canonicalStale = true;
      continue;
    }
    if (canonical) canonicalValid = true;
    found++;
    for (const [id, entry] of Object.entries(parsed.cards)) {
      if (!entry?.v || entry.h !== desiredHashes.get(id)) continue;
      if (!cache.cards[id]) {
        cache.cards[id] = entry;
        if (!canonical) mergedFromAlias = true;
      }
    }
  }
  if (found > 1) counters.cacheFilesMerged += found;
  return {
    file,
    cache,
    // A stale legacy alias is harmless once the canonical BGE cache is valid.
    // Rewrite only when the canonical file itself is stale/missing or an alias
    // contributes a card the canonical cache did not already contain.
    dirty: canonicalStale || (!canonicalValid && found > 0) || mergedFromAlias,
  };
}

async function vectorsForBrainUnlocked(pipe, brainPath, cards) {
  const want = cards.filter((card) => card.type !== 'container' && (card.text || '').trim());
  const desiredHashes = new Map(want.map((card) => [card.id, sha1(String(card.text))]));
  const loaded = readCache(brainPath, desiredHashes);
  const { file, cache } = loaded;
  let dirty = loaded.dirty;
  const missing = want.filter((card) => cache.cards[card.id]?.h !== desiredHashes.get(card.id));
  if (missing.length) {
    const vectors = await embedTexts(pipe, missing.map((card) => String(card.text).slice(0, 1500)));
    missing.forEach((card, index) => {
      cache.cards[card.id] = { h: desiredHashes.get(card.id), v: vectors[index] };
    });
    dirty = true;
  }
  const live = new Set(want.map((card) => card.id));
  for (const id of Object.keys(cache.cards)) {
    if (!live.has(id)) { delete cache.cards[id]; dirty = true; }
  }
  if (dirty) {
    try {
      fs.mkdirSync(EMB_DIR, { recursive: true });
      writeCacheAtomic(file, cache);
      counters.cacheWrites++;
    } catch { /* disk cache is best-effort; in-memory result remains correct */ }
  }
  const map = new Map();
  for (const card of want) {
    const entry = cache.cards[card.id];
    if (entry?.v) map.set(card.id, entry.v);
  }
  return map;
}

export async function vectorsForBrain(pipe, brainPath, cards) {
  if (!BOUNDED) return vectorsForBrainUnlocked(pipe, brainPath, cards);
  const key = canonicalBrainKey(brainPath);
  const previous = vectorBuildTails.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => withCrossProcessCacheLock(
    brainPath,
    () => vectorsForBrainUnlocked(pipe, brainPath, cards),
  ));
  vectorBuildTails.set(key, run);
  try { return await run; }
  finally { if (vectorBuildTails.get(key) === run) vectorBuildTails.delete(key); }
}

async function scoreRerankBatch(rr, question, hits, startIndex) {
  const texts = hits.map((hit) => String(hit.card?.text || '').slice(0, 1500));
  let inputs = null;
  let outputs = null;
  try {
    inputs = rr.tokenizer(new Array(texts.length).fill(String(question)), {
      text_pair: texts,
      padding: true,
      truncation: true,
    });
    outputs = await rr.model(inputs);
    const logits = outputs?.logits;
    if (!logits?.data || logits.data.length < hits.length) throw new Error('reranker returned invalid logits');
    const scores = Array.from(logits.data.slice(0, hits.length), Number);
    return hits.map((hit, index) => ({ hit, score: scores[index], index: startIndex + index }));
  } finally {
    const seen = new Set();
    disposeTensorTree(outputs, seen);
    disposeTensorTree(inputs, seen);
  }
}

export async function rerankHits(rr, question, hits) {
  if (!hits.length) return [];
  if (!BOUNDED) {
    counters.rerankBatches++;
    const scored = await scoreRerankBatch(rr, question, hits, 0);
    return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.hit);
  }
  const scored = [];
  for (let offset = 0; offset < hits.length; offset += RERANK_BATCH_SIZE) {
    const batch = hits.slice(offset, offset + RERANK_BATCH_SIZE);
    counters.rerankBatches++;
    const part = await withInferenceSlot(
      'reranking',
      () => scoreRerankBatch(rr, question, batch, offset),
    );
    scored.push(...part);
  }
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.hit);
}

export async function disposeSemanticModels() {
  clearSemanticIdleTimer();
  return enqueueMaintenance(() => disposeModelsUnlocked('explicit'));
}

// Hermetic lifecycle hooks for the memory regression suite. Production callers
// use only the public load/query/dispose surface above.
export const __semanticMemoryTest = {
  installModels({ embedder = null, reranker = null } = {}) {
    embedderPromise = embedder ? Promise.resolve(embedder) : null;
    rerankerPromise = reranker ? Promise.resolve(reranker) : null;
    lastSemanticActivityAt = Date.now();
  },
  forceIdleDisposal() {
    return enqueueMaintenance(() => disposeModelsUnlocked('idle'));
  },
  armIdleDisposal: armSemanticIdleDisposal,
  clearIdleTimer: clearSemanticIdleTimer,
};
