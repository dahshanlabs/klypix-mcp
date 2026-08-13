// brain-semantic — OPTIONAL on-device semantic lane for the project-brain hook.
//
// WHY a separate module: the hook's per-prompt recall is LEXICAL (keyword) — fast
// and bulletproof. Semantic (embedding) recall would understand paraphrase, but the
// hook is a ONE-SHOT process (no daemon allowed), so loading an embedding model
// on EVERY prompt is unacceptable on the common path. The measured-and-
// verified design is therefore: run semantic ONLY when lexical found nothing (the
// paraphrase / keyword-miss case, where you'd otherwise get zero recall), pay the
// cost just there, timeout-bounded, and read-only.
//
// CONTRACT (mirrors the hook): never throw → returns null on ANY failure; never
// blocks beyond `timeoutMs`; NEVER embeds cards in-process (embedding all cards is
// a 10s–195s stall — we read whatever the MCP host already warmed and embed ONLY
// the short query). Transformers is a DYNAMIC, OPTIONAL import — this module's only
// static deps are node builtins, so the hook gains zero new static deps and stays a
// no-op until the user runs the one-click semantic install.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';

const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const EMB_DIR = path.join(PB_DIR, 'embeddings');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// Keep these values byte-identical to semantic-memory.mjs. The one-shot hook is
// intentionally standalone, so it does not import the long-lived runtime merely
// to read configuration.
export const HOOK_EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const HOOK_EMBEDDING_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const HOOK_EMBEDDING_POOLING = 'cls';
export const HOOK_EMBEDDING_CACHE_KEY = `${HOOK_EMBEDDING_MODEL_ID}|q8|${HOOK_EMBEDDING_POOLING}|query-instruction-v1`;
const MIN_SAFE_SHARP_VERSION = [0, 35, 3];

function findPackageManifest(entryPath, expectedName) {
    let dir = path.dirname(entryPath);
    while (dir !== path.dirname(dir)) {
        try {
            const manifestPath = path.join(dir, 'package.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest?.name === expectedName) return { manifestPath, manifest };
        } catch { /* keep walking */ }
        dir = path.dirname(dir);
    }
    return null;
}

function isSafeSharpVersion(version) {
    const parts = String(version || '').split('.').slice(0, 3).map(Number);
    if (parts.length !== 3 || parts.some(part => !Number.isInteger(part) || part < 0)) return false;
    for (let i = 0; i < MIN_SAFE_SHARP_VERSION.length; i++) {
        if (parts[i] !== MIN_SAFE_SHARP_VERSION[i]) return parts[i] > MIN_SAFE_SHARP_VERSION[i];
    }
    return true;
}

export function semanticRuntimeEntryIfSafe(transformersEntry) {
    try {
        const transformers = findPackageManifest(transformersEntry, '@huggingface/transformers');
        if (!transformers) return null;
        // Resolve from the exact executable bundle entry. Resolving from the
        // package manifest misses a Sharp installation shadowed under dist/
        // even though that is the copy the ESM bundle itself will import.
        const sharpEntry = createRequire(transformersEntry).resolve('sharp');
        const sharp = findPackageManifest(sharpEntry, 'sharp');
        return sharp && isSafeSharpVersion(sharp.manifest.version) ? transformersEntry : null;
    } catch { return null; }
}

function ambientTransformersEntryIfSafe() {
    try {
        const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
        return semanticRuntimeEntryIfSafe(entry);
    } catch { return null; }
}

// Memoized within THIS process only (a one-shot hook run) — across prompts it
// reloads cold, which is exactly why we only pay it on a lexical miss.
let _embedder;
function getEmbedder() {
    if (_embedder !== undefined) return _embedder;
    _embedder = (async () => {
        let t;
        const ambientEntry = ambientTransformersEntryIfSafe();
        if (ambientEntry) {
            try { t = await import('@huggingface/transformers'); } catch { /* try owned runtime */ }
        }
        if (!t) {
            const base = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist');
            let last;
            for (const f of ['transformers.node.mjs', 'transformers.mjs']) {
                const entry = path.join(base, f);
                if (!semanticRuntimeEntryIfSafe(entry)) continue;
                try { t = await import(new URL('file:///' + entry.replace(/\\/g, '/')).href); last = null; break; }
                catch (e) { last = e; }
            }
            if (!t) throw last || new Error('semantic runtime rejected: sharp must be >=0.35.3');
        }
        t.env.cacheDir = path.join(PB_DIR, 'hf-cache');
        return await t.pipeline('feature-extraction', HOOK_EMBEDDING_MODEL_ID, { dtype: 'q8' });
    })().catch(() => null);   // not installed / load fail → null → lexical fallback
    return _embedder;
}

async function embedQueries(pipe, texts) {
    let out = null;
    try {
        const instructed = texts.map(text => `${HOOK_EMBEDDING_QUERY_PREFIX}${text}`);
        out = await pipe(instructed, { pooling: HOOK_EMBEDDING_POOLING, normalize: true });
        const [n, d] = out.dims;
        const vecs = [];
        for (let i = 0; i < n; i++) vecs.push(Array.from(out.data.slice(i * d, (i + 1) * d)));
        return vecs;
    } finally {
        try { out?.dispose?.(); } catch { /* one-shot process exit remains the fallback */ }
    }
}
// Vectors are unit-normalized, so dot == cosine.
export const dot = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

// READ-ONLY card-vector cache — NEVER embeds or writes (embedding all cards in the
// per-prompt process is the multi-second stall we forbid). Reuses the SAME warm
// cache the MCP host fills. Current workers canonicalize absolute Windows paths
// to a lowercase drive letter; legacy caches used raw drive casing, so probe both
// identities while accepting only the exact current modelKey.
function readCachedVecs(brainPath, cards) {
    const slashed = String(brainPath).replace(/\\/g, '/');
    const resolved = path.resolve(String(brainPath)).replace(/\\/g, '/');
    const variants = [...new Set([
        resolved.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':'),
        resolved,
        slashed,
        slashed.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':'),
        slashed.replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ':'),
    ])];
    let cache = null;
    for (const v of variants) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(EMB_DIR, sha1(v) + '.json'), 'utf8'));
            if (c?.modelKey === HOOK_EMBEDDING_CACHE_KEY && c.cards) { cache = c; break; }
        } catch { /* try next variant */ }
    }
    const map = new Map();
    if (cache && cache.cards) for (const c of cards) { const e = cache.cards[c.id]; if (e && e.v) map.set(c.id, e.v); }
    return map;
}

// Entry point: embed the QUERY (needs the model) + read cached card vectors.
// Returns { qv, vecsMap, dot } or null (not installed / timeout / any failure →
// the hook keeps its exact lexical behavior). NEVER throws, NEVER embeds cards.
export async function semanticVecs(brainPath, struct, query, { timeoutMs = 1200 } = {}) {
    try {
        const q = String(query || '').toLowerCase().trim();
        if (!q) return null;
        // Deploy-gate, ENFORCED (2026-07-29): read the warm card-vector cache
        // BEFORE any model work. This lane never embeds cards, so with no cached
        // vectors there is nothing to rank against — and importing transformers
        // here would spin onnxruntime worker threads inside a ONE-SHOT hook that
        // process.exit(0)s the moment retrieval returns. On Windows (Node 24)
        // that exit-vs-thread-teardown race aborts the whole hook process
        // (libuv "!(handle->flags & UV_HANDLE_CLOSING)" in async.c), because
        // `import('@huggingface/transformers')` resolves from ANY ambient
        // node_modules (a dev repo's) even where the semantic install is absent.
        // Empty cache → pure-lexical, zero model load, zero threads.
        const vecsMap = readCachedVecs(brainPath, (struct && struct.cards) || []);
        if (!vecsMap.size) return null;
        const pipe = await Promise.race([getEmbedder(), new Promise(r => setTimeout(() => r(null), timeoutMs))]);
        if (!pipe) return null;
        const [qv] = await embedQueries(pipe, [q]);
        if (!qv) return null;
        return { qv, vecsMap, dot };
    } catch { return null; }
}
