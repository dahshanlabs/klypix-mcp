#!/usr/bin/env node
// Measure the per-prompt hook lane — the retrieval every Claude Code session
// receives on every prompt — through the production primitives it is built
// from. Since 1.87 that is the UNIFIED two-lane policy ("unified balanced",
// bench-selected 2026-09-28 on a dev/held-out split of real founder prompts):
//   splitQueryTokens → strong status prompts keep the digest; a prompt with
//   HOOK_MODEL_MIN_TOKENS+ unique content tokens takes the MODEL lane
//   (rankHookFused: cosine + rarity over the warm vector cache) when vectors
//   exist, else the WORDS lane (rankHookWords: BM25-idf rarity with an
//   evidence bar) decides. Nothing here re-implements a ranker: an eval must
//   IMPORT the ranker or it measures a system that does not ship (2026-08-10
//   lesson, recorded in the brain and in scripts/eval-retrieval.mjs). The
//   bars come FROM the engine (lib.HOOK_WORDS_BAR, lib.HOOK_FUSED_SHOW_BAR,
//   lib.HOOK_MODEL_MIN_TOKENS), never restated here.
//
// VECTOR SPACE: ENRICHMENT-FREE, DELIBERATELY. A capture-pair set is built
// from the enrichment sidecar, so under production vectors every prompt is
// already embedded inside its own gold card — a leak that would make the
// semantic leg look perfect. Cards are embedded from their raw text through
// the production embedTexts (same model, pooling, query prefix and 1,500-char
// cap as vectorsForBrain) and the receipt says so. Lexical mode needs no model
// and measures the words lane alone (the hook's exact no-model degradation).
//
// STRATA: capture-pair (should recall its gold) and no-inject (should inject
// nothing). --sweep re-thresholds the recorded evidence over grids around the
// shipping HOOK_WORDS_BAR and HOOK_FUSED_SHOW_BAR — bar changes never change
// ROUTING, so the sweep is exact without re-ranking.
//
// Usage: node scripts/eval-hook-lane.mjs --brain PATH --prompts PATH --out PATH
//          [--engine DIR] [--mode lexical|semantic] [--sweep] [--vector-cache PATH] [--include-text]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'node scripts/eval-hook-lane.mjs --brain PATH --prompts PATH --out PATH [--engine DIR] [--mode lexical|semantic] [--sweep] [--vector-cache PATH] [--include-text]';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha1 = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const quantile = (values, q) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]; };
const pct = (numerator, count) => (count ? Math.round((100 * numerator) / count) : null);
const optionalFileHash = (file) => { try { return hash(fs.readFileSync(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function options(argv) {
  const result = { engine: root, mode: 'lexical', sweep: false, includeText: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return null;
    if (argv[i] === '--sweep') { result.sweep = true; continue; }
    if (argv[i] === '--include-text') { result.includeText = true; continue; }
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!['brain', 'prompts', 'out', 'engine', 'mode', 'vectorCache'].includes(key) || !argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
    result[key] = argv[++i];
  }
  if (!result.brain || !result.prompts || !result.out || !['lexical', 'semantic'].includes(result.mode)) throw new Error(usage);
  for (const key of ['brain', 'prompts', 'out', 'engine', 'vectorCache']) if (result[key]) result[key] = path.resolve(result[key]);
  if ([result.brain, result.prompts].some((file) => file.toLowerCase() === result.out.toLowerCase()) || fs.existsSync(result.out)) throw new Error('Output must be a new file, separate from the inputs.');
  return result;
}

// Sweep grids are OFFSETS from the shipping bars (read from the engine at
// runtime), so the tables always bracket what actually ships.
const WORDS_BAR_OFFSETS = [-0.6, -0.3, 0, +0.3, +0.6];
const FUSED_BAR_OFFSETS = [-0.10, -0.05, 0, +0.05, +0.10];

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) { console.log(usage); return; }
  const moduleFile = (name) => path.join(args.engine, 'src', name);
  const lib = await import(pathToFileURL(moduleFile('klypix-format.mjs')).href);
  for (const name of ['splitQueryTokens', 'rankHookWords', 'rankHookFused', 'parseKlypix']) {
    if (typeof lib[name] !== 'function') throw new Error(`Engine at ${args.engine} has no ${name} export — measure a 1.87+ engine.`);
  }
  const brainBytes = fs.readFileSync(args.brain);
  const promptBytes = fs.readFileSync(args.prompts);
  const spec = JSON.parse(promptBytes.toString('utf8'));
  const questions = Array.isArray(spec) ? spec : spec.questions;
  if (!Array.isArray(questions) || !questions.length) throw new Error('Prompt set must contain questions.');
  const { struct } = await lib.parseKlypix(brainBytes);
  const cards = new Map(struct.cards.map((card) => [card.id, card]));
  const live = struct.cards.filter((card) => card.type !== 'container' && (card.text || '').trim());
  const textTwins = new Map();   // flat text → ids (merge twins share text; a twin in the hits is the same answer)
  for (const card of live) { const key = flat(card.text); if (!textTwins.has(key)) textTwins.set(key, []); textTwins.get(key).push(card.id); }
  const sourceFiles = ['klypix-format.mjs', 'semantic-memory.mjs', 'brain-semantic.mjs', 'enrichment.mjs'];
  const sourceHashes = Object.fromEntries(sourceFiles.map((name) => [name, optionalFileHash(moduleFile(name))]));
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* hashes identify the engine */ }
  const inputs = { brainSha256: hash(brainBytes), promptsSha256: hash(promptBytes), cards: struct.cards.length, liveCards: live.length, prompts: questions.length, enrichment: { used: false, reason: 'leakage guard: capture-pair prompts are themselves enrichment entries for their gold cards, so cards are embedded from raw text' } };
  // The shipping bars come FROM the engine, never restated here: what the hook
  // reads is what this harness measures.
  const WORDS_BAR = lib.HOOK_WORDS_BAR;
  const FUSED_BAR = lib.HOOK_FUSED_SHOW_BAR;
  const MODEL_MIN = lib.HOOK_MODEL_MIN_TOKENS;
  if (![WORDS_BAR, FUSED_BAR, MODEL_MIN].every(Number.isFinite)) throw new Error('Engine exports no unified-lane bars.');
  const configuration = {
    mode: args.mode,
    words: { ranker: 'rankHookWords', topK: 5, evidenceBar: WORDS_BAR },
    model: { ranker: 'rankHookFused', topK: 5, showBar: FUSED_BAR, minUniqueContentTokens: MODEL_MIN, idfWeight: Number.isFinite(lib.HOOK_FUSED_IDF_WEIGHT) ? lib.HOOK_FUSED_IDF_WEIGHT : null },
    engineCommit: commit, sourceHashes,
  };
  const wordsBars = WORDS_BAR_OFFSETS.map((d) => round(WORDS_BAR + d, 3));
  const fusedBars = FUSED_BAR_OFFSETS.map((d) => round(FUSED_BAR + d, 3));
  const started = performance.now();
  let runtime = null;
  const rows = [];
  try {
    // ── Optional semantic leg: production embedder, raw-text vectors ──────
    let vecsMap = null, dot = null, pipe = null, cacheFile = null, cacheDoc = null;
    if (args.mode === 'semantic') {
      runtime = await import(pathToFileURL(moduleFile('semantic-memory.mjs')).href);
      configuration.embedding = { model: runtime.EMBEDDING_MODEL_ID, pooling: runtime.EMBEDDING_POOLING, queryPrefix: runtime.EMBEDDING_QUERY_PREFIX, cacheKey: runtime.EMBEDDING_CACHE_KEY, cardTextCap: 1500, queryLowercased: true };
      const log = (...items) => console.error('[embed]', ...items);
      pipe = typeof runtime.getEmbedderForUse === 'function'
        ? await runtime.getEmbedderForUse(log, 120_000)
        : await Promise.race([runtime.getEmbedder(log), new Promise((resolve) => setTimeout(() => resolve(null), 120_000))]);
      if (!pipe) throw new Error('Production semantic runtime unavailable; refusing to label a words-lane fallback as a model-lane result.');
      dot = runtime.dot;
      // Vector cache keyed by the production contract + sha1(text): re-runs
      // and sweeps must not pay the full-brain embed twice.
      cacheFile = args.vectorCache;
      cacheDoc = { contract: runtime.EMBEDDING_CACHE_KEY, vecs: {} };
      if (cacheFile) { try { const loaded = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (loaded?.contract === cacheDoc.contract && loaded.vecs) cacheDoc = loaded; } catch { /* cold cache */ } }
      const inputsByCard = live.map((card) => ({ card, text: String(card.text).slice(0, 1500) }));
      const missing = inputsByCard.filter(({ text }) => !cacheDoc.vecs[sha1(text)]);
      console.error(`[embed] ${live.length} live cards · ${missing.length} to embed (raw text, enrichment-free) · ${live.length - missing.length} from cache`);
      const BATCH = 64;
      for (let i = 0; i < missing.length; i += BATCH) {
        const slice = missing.slice(i, i + BATCH);
        const vectors = await runtime.embedTexts(pipe, slice.map(({ text }) => text), { kind: 'passage' });
        slice.forEach(({ text }, j) => { if (vectors[j]) cacheDoc.vecs[sha1(text)] = Array.from(vectors[j]); });
        if ((i / BATCH) % 5 === 4 || i + BATCH >= missing.length) console.error(`[embed] ${Math.min(i + BATCH, missing.length)}/${missing.length}`);
      }
      if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cacheDoc)); }
      vecsMap = new Map();
      for (const { card, text } of inputsByCard) { const v = cacheDoc.vecs[sha1(text)]; if (v) vecsMap.set(card.id, v); }
    }

    // ── Per prompt: the exact lane sequence the hook runs ────────────────
    for (const [index, question] of questions.entries()) {
      if (typeof question?.q !== 'string' || !question.q.trim()) throw new Error(`Prompt ${index} has no text.`);
      const strategy = question.strategy === 'no-inject' ? 'no-inject' : 'capture-pair';
      const goldIds = Array.isArray(question.goldIds) ? question.goldIds : (question.cardId ? [question.cardId] : []);
      if (strategy === 'capture-pair' && !goldIds.length) throw new Error(`Prompt ${index} is a capture-pair without gold ids.`);
      const surviving = goldIds.filter((id) => cards.has(id));
      const pinned = question.goldTexts;
      const valid = surviving.filter((id) => !pinned || flat(cards.get(id).text) === flat(pinned[goldIds.indexOf(id)]));
      const goldSet = new Set(valid);
      for (const id of valid) for (const twin of textTwins.get(flat(cards.get(id).text)) || []) goldSet.add(twin);   // twin-aware gold
      const row = { index, strategy, reason: question.reason || null, promptSha256: hash(question.q), ...(args.includeText ? { q: question.q } : {}), goldIds, missingGoldIds: goldIds.filter((id) => !cards.has(id)), driftedGoldIds: surviving.filter((id) => !valid.includes(id)), strictGold: valid, twinGold: [...goldSet] };
      if (strategy === 'capture-pair' && !valid.length) { rows.push({ ...row, excluded: surviving.length ? 'all-surviving-golds-drifted' : 'all-golds-missing' }); continue; }
      const split = lib.splitQueryTokens(question.q);
      const tokens = [...new Set(split.content)];
      row.tokens = tokens.length;
      row.statusShaped = Boolean(split.statusShaped);
      if (split.strong) { rows.push({ ...row, excluded: null, lane: 'status-digest', injected: 0, shownIds: [] }); continue; }
      if (!tokens.length) { rows.push({ ...row, excluded: null, lane: 'no-tokens', injected: 0, shownIds: [] }); continue; }
      // WORDS lane — always computed: it is the decision for every prompt the
      // model lane does not take, and its evidence feeds the bar sweep.
      const words = lib.rankHookWords(struct, tokens, { topK: 5 });
      const wordsHitIds = words.hits.map((hit) => hit.card.id);
      const out = {
        ...row, excluded: null,
        wordsEvidence: round(words.evidence), wordsTop: round(words.top), wordsSpecificity: round(words.specificity),
        wordsHitIds,
        wordsRankStrict: (wordsHitIds.findIndex((id) => valid.includes(id)) + 1) || null,
        wordsRankTwin: (wordsHitIds.findIndex((id) => goldSet.has(id)) + 1) || null,
      };
      // MODEL lane — the hook's gate: unique content tokens at the bar AND a
      // query vector AND any warm card vector (pool > 0). Lexical mode has no
      // model, so every prompt degrades to the words lane — the hook's exact
      // behaviour on a machine with no embedder.
      let decided = null;
      if (args.mode === 'semantic' && tokens.length >= MODEL_MIN) {
        out.modelEligible = true;
        const [qv] = await runtime.embedTexts(pipe, [question.q.toLowerCase().trim()], { kind: 'query' });
        if (!qv) throw new Error(`Query vector unavailable at ${index}.`);
        const sem = { qv, vecsMap, dot };
        const fused = lib.rankHookFused(struct, sem, tokens, { topK: 5 });
        if (fused.hits.length) {
          const fusedHitIds = fused.hits.map((hit) => hit.card.id);
          out.fusedBest = round(fused.best);
          out.fusedPool = fused.pool;
          out.fusedHitIds = fusedHitIds;
          out.fusedRankStrict = (fusedHitIds.findIndex((id) => valid.includes(id)) + 1) || null;
          out.fusedRankTwin = (fusedHitIds.findIndex((id) => goldSet.has(id)) + 1) || null;
          // Gold's place in the full cosine order, for the failure signature.
          if (goldSet.size) {
            let goldCos = null;
            for (const id of goldSet) { const v = vecsMap.get(id); if (v) { const c = dot(qv, v); if (goldCos == null || c > goldCos) goldCos = c; } }
            if (goldCos != null) { let above = 0; for (const [id, v] of vecsMap) { if (!goldSet.has(id) && dot(qv, v) > goldCos) above++; } out.goldCos = round(goldCos); out.goldRankByCos = above + 1; }
          }
          decided = fused.best >= FUSED_BAR
            ? { lane: 'model-shown', shownIds: fusedHitIds }
            : { lane: 'model-silent', shownIds: [] };
        }
        // fused.hits empty = no vector-bearing cards → the words lane decides.
      }
      if (!decided) {
        decided = (words.hits.length && words.evidence >= WORDS_BAR)
          ? { lane: 'words-shown', shownIds: wordsHitIds }
          : { lane: 'words-silent', shownIds: [] };
      }
      const shownIds = decided.shownIds;
      rows.push({
        ...out, lane: decided.lane, injected: shownIds.length, shownIds,
        rankStrict: (shownIds.findIndex((id) => valid.includes(id)) + 1) || null,
        rankTwin: (shownIds.findIndex((id) => goldSet.has(id)) + 1) || null,
      });
      if ((index + 1) % 25 === 0) console.error(`Evaluated ${index + 1}/${questions.length}`);
    }

    // ── Summary ──────────────────────────────────────────────────────────
    const usable = rows.filter((row) => !row.excluded);
    const pairs = usable.filter((row) => row.strategy === 'capture-pair');
    const noInject = usable.filter((row) => row.strategy === 'no-inject');
    const lanes = (subset) => Object.fromEntries([...new Set(subset.map((row) => row.lane))].sort().map((lane) => [lane, subset.filter((row) => row.lane === lane).length]));
    const dist = (values) => ({ n: values.length, p10: round(quantile(values, 0.1)), p50: round(quantile(values, 0.5)), p90: round(quantile(values, 0.9)) });
    const summary = {
      capturePair: {
        n: pairs.length, lanes: lanes(pairs),
        systemRecallAt5: {
          strict: pct(pairs.filter((row) => row.rankStrict != null && row.rankStrict <= 5).length, pairs.length),
          twinAware: pct(pairs.filter((row) => row.rankTwin != null && row.rankTwin <= 5).length, pairs.length),
        },
        shownPct: pct(pairs.filter((row) => row.injected > 0).length, pairs.length),
        answeredButNothingShownPct: pct(pairs.filter((row) => row.injected === 0).length, pairs.length),
        injectedMean: round(mean(pairs.map((row) => row.injected)), 2),
        modelLanePct: pct(pairs.filter((row) => row.lane === 'model-shown' || row.lane === 'model-silent').length, pairs.length),
        wordsEvidence: dist(pairs.map((row) => row.wordsEvidence).filter(Number.isFinite)),
        fusedBest: dist(pairs.map((row) => row.fusedBest).filter(Number.isFinite)),
        goldRankByCosMedian: quantile(pairs.map((row) => row.goldRankByCos).filter(Number.isFinite), 0.5),
      },
      noInject: {
        n: noInject.length, lanes: lanes(noInject), byReason: Object.fromEntries([...new Set(noInject.map((row) => row.reason))].map((reason) => [reason, noInject.filter((row) => row.reason === reason).length])),
        zeroInjectedRate: pct(noInject.filter((row) => row.injected === 0).length, noInject.length),
        injectedMean: round(mean(noInject.map((row) => row.injected)), 2),
        wordsEvidence: dist(noInject.map((row) => row.wordsEvidence).filter(Number.isFinite)),
        fusedBest: dist(noInject.map((row) => row.fusedBest).filter(Number.isFinite)),
      },
      excluded: rows.filter((row) => row.excluded).length,
    };
    if (args.sweep) {
      // Bars never change routing, so re-thresholding the recorded evidence is
      // the exact sweep. Words table: rows the WORDS lane decided (bar moves
      // change their show/silence). Fused table: rows the MODEL lane decided.
      const wordsRows = (subset) => subset.filter((row) => row.lane === 'words-shown' || row.lane === 'words-silent');
      const fusedRows = (subset) => subset.filter((row) => row.lane === 'model-shown' || row.lane === 'model-silent');
      const wp = wordsRows(pairs), wn = wordsRows(noInject);
      const wordsTable = wordsBars.map((bar) => ({
        bar, shipping: bar === WORDS_BAR,
        capturePairShownPct: pct(wp.filter((row) => row.wordsHitIds.length && row.wordsEvidence >= bar).length, wp.length),
        capturePairRecallAt5: pct(wp.filter((row) => row.wordsHitIds.length && row.wordsEvidence >= bar && row.wordsRankTwin != null && row.wordsRankTwin <= 5).length, wp.length),
        noInjectZeroRate: pct(wn.filter((row) => !(row.wordsHitIds.length && row.wordsEvidence >= bar)).length, wn.length),
        noInjectInjectedMean: round(mean(wn.map((row) => (row.wordsHitIds.length && row.wordsEvidence >= bar) ? row.wordsHitIds.length : 0)), 2),
      }));
      summary.wordsBarSweep = { capturePairRows: wp.length, noInjectRows: wn.length, table: wordsTable };
      console.error('\nwords bar | pair shown% | pair recall@5 | no-inject zero% | no-inject inj');
      for (const r of wordsTable) console.error(`${String(r.bar).padEnd(10)}| ${String(r.capturePairShownPct ?? '-').padStart(11)} | ${String(r.capturePairRecallAt5 ?? '-').padStart(13)} | ${String(r.noInjectZeroRate ?? '-').padStart(15)} | ${String(r.noInjectInjectedMean ?? '-').padStart(13)}`);
      if (args.mode === 'semantic') {
        const fp = fusedRows(pairs), fn = fusedRows(noInject);
        const fusedTable = fusedBars.map((bar) => ({
          bar, shipping: bar === FUSED_BAR,
          capturePairShownPct: pct(fp.filter((row) => row.fusedBest >= bar).length, fp.length),
          capturePairRecallAt5: pct(fp.filter((row) => row.fusedBest >= bar && row.fusedRankTwin != null && row.fusedRankTwin <= 5).length, fp.length),
          noInjectZeroRate: pct(fn.filter((row) => !(row.fusedBest >= bar)).length, fn.length),
          noInjectInjectedMean: round(mean(fn.map((row) => (row.fusedBest >= bar) ? row.fusedHitIds.length : 0)), 2),
        }));
        summary.fusedBarSweep = { capturePairRows: fp.length, noInjectRows: fn.length, table: fusedTable };
        console.error('\nfused bar | pair shown% | pair recall@5 | no-inject zero% | no-inject inj');
        for (const r of fusedTable) console.error(`${String(r.bar).padEnd(10)}| ${String(r.capturePairShownPct ?? '-').padStart(11)} | ${String(r.capturePairRecallAt5 ?? '-').padStart(13)} | ${String(r.noInjectZeroRate ?? '-').padStart(15)} | ${String(r.noInjectInjectedMean ?? '-').padStart(13)}`);
      }
    }
    for (const [file, expected] of [[args.brain, inputs.brainSha256], [args.prompts, inputs.promptsSha256]]) {
      if (hash(fs.readFileSync(file)) !== expected) throw new Error('An input changed during evaluation; result rejected. Use an immutable snapshot.');
    }
    for (const name of sourceFiles) if (optionalFileHash(moduleFile(name)) !== sourceHashes[name]) throw new Error('An engine file changed during evaluation; result rejected.');
    const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), scope: 'Per-prompt hook lane retrieval on a capture-pair proxy set (prompt → the card that capture produced) plus a no-inject stratum. Measures which cards the unified lane would inject, not agent task success. Private prompt text is omitted unless --include-text.', inputs, configuration, summary, durationMs: Math.round(performance.now() - started), rows };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output: args.out, mode: args.mode, capturePair: summary.capturePair, noInject: summary.noInject, excluded: summary.excluded }));
  } finally {
    if (runtime && typeof runtime.disposeSemanticModels === 'function') await runtime.disposeSemanticModels();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
