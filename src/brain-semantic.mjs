// brain-semantic — OPTIONAL on-device semantic lane for the project-brain hook.
//
// WHY a separate module: the hook's per-prompt recall is LEXICAL (keyword) — fast
// and bulletproof. Semantic (embedding) recall would understand paraphrase, but the
// hook is a ONE-SHOT process (no daemon allowed), so loading the 23MB MiniLM model
// costs ~550ms EVERY prompt — unacceptable on the common path. The measured-and-
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

const PB_DIR = path.join(os.homedir(), '.claude', 'project-brain');
const EMB_DIR = path.join(PB_DIR, 'embeddings');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Memoized within THIS process only (a one-shot hook run) — across prompts it
// reloads cold, which is exactly why we only pay it on a lexical miss.
let _embedder;
function getEmbedder() {
    if (_embedder !== undefined) return _embedder;
    _embedder = (async () => {
        let t;
        try { t = await import('@huggingface/transformers'); }
        catch {
            const base = path.join(PB_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers', 'dist');
            let last;
            for (const f of ['transformers.node.mjs', 'transformers.mjs']) {
                try { t = await import(new URL('file:///' + path.join(base, f).replace(/\\/g, '/')).href); last = null; break; }
                catch (e) { last = e; }
            }
            if (!t) throw last;
        }
        t.env.cacheDir = path.join(PB_DIR, 'hf-cache');
        return await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    })().catch(() => null);   // not installed / load fail → null → lexical fallback
    return _embedder;
}

async function embedTexts(pipe, texts) {
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    const vecs = [];
    for (let i = 0; i < n; i++) vecs.push(Array.from(out.data.slice(i * d, (i + 1) * d)));
    return vecs;
}
// Vectors are unit-normalized, so dot == cosine.
export const dot = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

// READ-ONLY card-vector cache — NEVER embeds or writes (embedding all cards in the
// per-prompt process is the multi-second stall we forbid). Reuses the SAME warm
// cache the MCP host fills, keyed sha1(path, slashes-only). The MCP keys WITHOUT
// lowercasing the drive letter, so a brain can have an `e:`-keyed and an `E:`-keyed
// cache file — try the drive-case variants so we hit whichever exists.
function readCachedVecs(brainPath, cards) {
    const slashed = String(brainPath).replace(/\\/g, '/');
    const variants = [...new Set([
        slashed,
        slashed.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':'),
        slashed.replace(/^([a-zA-Z]):/, (_m, d) => d.toUpperCase() + ':'),
    ])];
    let cache = null;
    for (const v of variants) {
        try { const c = JSON.parse(fs.readFileSync(path.join(EMB_DIR, sha1(v) + '.json'), 'utf8')); if (c && c.cards) { cache = c; break; } } catch { /* try next variant */ }
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
        const [qv] = await embedTexts(pipe, [q]);
        if (!qv) return null;
        return { qv, vecsMap, dot };
    } catch { return null; }
}
