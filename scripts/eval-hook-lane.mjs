#!/usr/bin/env node
// Measure the per-prompt hook lane — the retrieval every Claude Code session
// receives on every prompt — through the production primitives it is built
// from: splitQueryTokens → scoreCardsAgainstQuery (lexical, minScore 3, top 5)
// and, on a lexical miss, rankLexicalMissFallback over the prompt embedding.
// Nothing here re-implements a ranker: an eval must IMPORT the ranker or it
// measures a system that does not ship (2026-08-10 lesson, recorded in the
// brain and in scripts/eval-retrieval.mjs).
//
// VECTOR SPACE: ENRICHMENT-FREE, DELIBERATELY. A capture-pair set is built
// from the enrichment sidecar, so under production vectors every prompt is
// already embedded inside its own gold card — a leak that would make the
// semantic leg look perfect. Cards are embedded from their raw text through
// the production embedTexts (same model, pooling, query prefix and 1,500-char
// cap as vectorsForBrain) and the receipt says so. Lexical mode needs no model.
//
// STRATA: capture-pair (should recall its gold) and no-inject (should inject
// nothing). --sweep tabulates candidate admission rules for
// rankLexicalMissFallback (minTop, margin) across both strata on the
// lexical-miss rows, so the defaults the hook ships are chosen from data.
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

// Candidate admission rules for the sweep. `null` = the shipping value.
const SWEEP_MIN_TOP = [null, 0.50, 0.55, 0.60, 0.65, 0.70];
const SWEEP_MARGIN = [null, 0.02, 0.04, 0.06, 0.08];
// Lexical bars: a title/tag hit scores 3, a body hit ≤1, recency +0.5, skill
// +1 — so 3 (shipping) is ONE title word, 4 needs a title word plus something,
// 6 needs two title/tag words. Swept on every stratum in every mode.
const SWEEP_LEXICAL_MIN = [3, 4, 5, 6, 8];

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) { console.log(usage); return; }
  const moduleFile = (name) => path.join(args.engine, 'src', name);
  const lib = await import(pathToFileURL(moduleFile('klypix-format.mjs')).href);
  for (const name of ['splitQueryTokens', 'scoreCardsAgainstQuery', 'rankLexicalMissFallback', 'parseKlypix']) {
    if (typeof lib[name] !== 'function') throw new Error(`Engine at ${args.engine} has no ${name} export — measure a 1.86+ engine.`);
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
  // reads is what this harness measures (an older engine reports its own 3).
  const LEX_MIN = Number.isFinite(lib.HOOK_LEXICAL_MIN_SCORE) ? lib.HOOK_LEXICAL_MIN_SCORE : 3;
  const eligible = typeof lib.lexicalMissFallbackEligible === 'function' ? lib.lexicalMissFallbackEligible : () => true;
  const configuration = { mode: args.mode, lexical: { ranker: 'scoreCardsAgainstQuery', topK: 5, minScore: LEX_MIN }, fallback: { ranker: 'rankLexicalMissFallback', topK: 5, defaults: 'engine', minContentTokens: Number.isFinite(lib.FALLBACK_MIN_CONTENT_TOKENS) ? lib.FALLBACK_MIN_CONTENT_TOKENS : null }, engineCommit: commit, sourceHashes };
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
      if (!pipe) throw new Error('Production semantic runtime unavailable; refusing to label a lexical fallback as a semantic result.');
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
      if (split.strong) { rows.push({ ...row, excluded: null, lane: 'status-digest', injected: 0, lexHitIds: [], fallbackHitIds: [] }); continue; }
      if (!tokens.length) { rows.push({ ...row, excluded: null, lane: 'no-tokens', injected: 0, lexHitIds: [], fallbackHitIds: [] }); continue; }
      const lexHits = lib.scoreCardsAgainstQuery(struct, tokens, { topK: 5, minScore: LEX_MIN });
      const lexHitIds = lexHits.map((hit) => hit.card.id);
      const lexRankStrict = lexHitIds.findIndex((id) => valid.includes(id));
      const lexRankTwin = lexHitIds.findIndex((id) => goldSet.has(id));
      const lexSweep = {};
      if (args.sweep) {
        for (const bar of [...new Set([LEX_MIN, ...SWEEP_LEXICAL_MIN])].sort((a, b) => a - b)) {
          const ids = lib.scoreCardsAgainstQuery(struct, tokens, { topK: 5, minScore: bar }).map((hit) => hit.card.id);
          lexSweep[bar] = { injected: ids.length, hitTwin: ids.some((id) => goldSet.has(id)) };
        }
      }
      const out = { ...row, excluded: null, lexHitIds, lexRankStrict: lexRankStrict < 0 ? null : lexRankStrict + 1, lexRankTwin: lexRankTwin < 0 ? null : lexRankTwin + 1, lexTopScore: lexHits.length ? round(lexHits[0].score) : null, lexTopText: lexHits.length ? flat(lexHits[0].card.text).slice(0, 90) : null, ...(args.sweep ? { lexSweep } : {}) };
      if (lexHits.length) { rows.push({ ...out, lane: 'lexical', injected: lexHits.length, fallbackHitIds: [] }); continue; }
      // Prompt-side admission, exactly as the hook applies it: too few content
      // tokens and the semantic guess is skipped (the hook logs `sem-skipped`).
      if (!eligible(tokens)) { rows.push({ ...out, lane: 'fallback-skipped', injected: 0, fallbackHitIds: [] }); continue; }
      if (!vecsMap) { rows.push({ ...out, lane: 'lexical-miss', injected: 0, fallbackHitIds: [] }); continue; }
      // The hook lowercases the derived human text before embedding the query
      // (brain-semantic.semanticVecs) — mirrored, so the space is the same.
      const [qv] = await runtime.embedTexts(pipe, [question.q.toLowerCase().trim()], { kind: 'query' });
      if (!qv) throw new Error(`Query vector unavailable at ${index}.`);
      const sem = { qv, vecsMap, dot };
      const fallback = lib.rankLexicalMissFallback(struct, sem, { topK: 5 });
      const fallbackHitIds = fallback.hits.map((hit) => hit.card.id);
      const fbRankStrict = fallbackHitIds.findIndex((id) => valid.includes(id));
      const fbRankTwin = fallbackHitIds.findIndex((id) => goldSet.has(id));
      // Where the gold sits in the full cosine order, for the failure signature.
      let goldCos = null, goldRankByCos = null;
      if (goldSet.size) {
        for (const id of goldSet) { const v = vecsMap.get(id); if (v) { const c = dot(qv, v); if (goldCos == null || c > goldCos) goldCos = c; } }
        if (goldCos != null) { let above = 0; for (const [id, v] of vecsMap) { if (!goldSet.has(id) && dot(qv, v) > goldCos) above++; } goldRankByCos = above + 1; }
      }
      const sweep = {};
      if (args.sweep) {
        for (const minTop of SWEEP_MIN_TOP) for (const margin of SWEEP_MARGIN) {
          const r = lib.rankLexicalMissFallback(struct, sem, { topK: 5, minTop, margin });
          const ids = r.hits.map((hit) => hit.card.id);
          sweep[`minTop=${minTop ?? 'ship'}|margin=${margin ?? 'ship'}`] = { injected: ids.length, hitTwin: ids.some((id) => goldSet.has(id)) };
        }
      }
      rows.push({ ...out, lane: 'fallback', injected: fallbackHitIds.length, fallbackHitIds, fbRankStrict: fbRankStrict < 0 ? null : fbRankStrict + 1, fbRankTwin: fbRankTwin < 0 ? null : fbRankTwin + 1, topCos: round(fallback.topCos), pool: fallback.pool, goldCos: round(goldCos), goldRankByCos, ...(args.sweep ? { sweep } : {}) });
      if ((index + 1) % 25 === 0) console.error(`Evaluated ${index + 1}/${questions.length}`);
    }

    // ── Summary ──────────────────────────────────────────────────────────
    const usable = rows.filter((row) => !row.excluded);
    const pairs = usable.filter((row) => row.strategy === 'capture-pair');
    const noInject = usable.filter((row) => row.strategy === 'no-inject');
    const retrieved = (subset, key) => subset.filter((row) => row[key] != null && row[key] <= 5).length;
    const lanes = (subset) => Object.fromEntries([...new Set(subset.map((row) => row.lane))].sort().map((lane) => [lane, subset.filter((row) => row.lane === lane).length]));
    const misses = pairs.filter((row) => row.lane === 'fallback' || row.lane === 'lexical-miss');
    const systemHit = (row, key) => (row.lane === 'lexical' ? row[`lexRank${key}`] : row.lane === 'fallback' ? row[`fbRank${key}`] : null);
    const summary = {
      capturePair: {
        n: pairs.length, lanes: lanes(pairs),
        lexicalHitRate: pct(pairs.filter((row) => row.lane === 'lexical').length, pairs.length),
        lexicalRecallAt5: { strict: pct(retrieved(pairs, 'lexRankStrict'), pairs.length), twinAware: pct(retrieved(pairs, 'lexRankTwin'), pairs.length) },
        systemRecallAt5: { strict: pct(pairs.filter((row) => { const r = systemHit(row, 'Strict'); return r != null && r <= 5; }).length, pairs.length), twinAware: pct(pairs.filter((row) => { const r = systemHit(row, 'Twin'); return r != null && r <= 5; }).length, pairs.length) },
        fallbackOnMisses: { n: misses.length, measured: misses.filter((row) => row.lane === 'fallback').length, recallAt5TwinAware: pct(misses.filter((row) => row.fbRankTwin != null && row.fbRankTwin <= 5).length, misses.filter((row) => row.lane === 'fallback').length), goldRankByCosMedian: quantile(misses.map((row) => row.goldRankByCos).filter(Number.isFinite), 0.5), goldBeyondPool: misses.filter((row) => row.lane === 'fallback' && row.fbRankTwin == null).length },
        injectedMean: round(mean(pairs.map((row) => row.injected)), 2),
        topCos: { mean: round(mean(pairs.filter((row) => row.lane === 'fallback').map((row) => row.topCos))), p10: round(quantile(pairs.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.1)), p50: round(quantile(pairs.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.5)), p90: round(quantile(pairs.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.9)) },
        goldCos: { p10: round(quantile(misses.map((row) => row.goldCos).filter(Number.isFinite), 0.1)), p50: round(quantile(misses.map((row) => row.goldCos).filter(Number.isFinite), 0.5)), p90: round(quantile(misses.map((row) => row.goldCos).filter(Number.isFinite), 0.9)) },
      },
      noInject: {
        n: noInject.length, lanes: lanes(noInject), byReason: Object.fromEntries([...new Set(noInject.map((row) => row.reason))].map((reason) => [reason, noInject.filter((row) => row.reason === reason).length])),
        zeroInjectedRate: pct(noInject.filter((row) => row.injected === 0).length, noInject.length),
        injectedMean: round(mean(noInject.map((row) => row.injected)), 2),
        topCos: { mean: round(mean(noInject.filter((row) => row.lane === 'fallback').map((row) => row.topCos))), p10: round(quantile(noInject.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.1)), p50: round(quantile(noInject.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.5)), p90: round(quantile(noInject.filter((row) => row.lane === 'fallback').map((row) => row.topCos), 0.9)) },
      },
      excluded: rows.filter((row) => row.excluded).length,
    };
    if (args.sweep) {
      // Lexical bar sweep — every row that reached retrieval (not status, not
      // token-less). Recall counts the gold appearing in the lexical top-5 at
      // that bar; no-inject counts prompts that would inject nothing.
      const reached = (subset) => subset.filter((row) => row.lexSweep);
      const pairLex = reached(pairs), noLex = reached(noInject);
      const lexTable = [...new Set([LEX_MIN, ...SWEEP_LEXICAL_MIN])].sort((a, b) => a - b).map((bar) => ({
        minScore: bar,
        capturePairHitRate: pct(pairLex.filter((row) => row.lexSweep[bar].injected > 0).length, pairLex.length),
        capturePairRecallAt5: pct(pairLex.filter((row) => row.lexSweep[bar].hitTwin).length, pairLex.length),
        capturePairInjectedMean: round(mean(pairLex.map((row) => row.lexSweep[bar].injected)), 2),
        noInjectZeroRate: pct(noLex.filter((row) => row.lexSweep[bar].injected === 0).length, noLex.length),
        noInjectInjectedMean: round(mean(noLex.map((row) => row.lexSweep[bar].injected)), 2),
      }));
      summary.lexicalSweep = { capturePairRows: pairLex.length, noInjectRows: noLex.length, table: lexTable };
      console.error('\nlexical minScore | pair hit% | pair recall@5 | pair inj | no-inject zero% | no-inject inj');
      for (const r of lexTable) console.error(`${String(r.minScore).padEnd(17)}| ${String(r.capturePairHitRate ?? '-').padStart(9)} | ${String(r.capturePairRecallAt5 ?? '-').padStart(13)} | ${String(r.capturePairInjectedMean ?? '-').padStart(8)} | ${String(r.noInjectZeroRate ?? '-').padStart(15)} | ${String(r.noInjectInjectedMean ?? '-').padStart(13)}`);
    }
    if (args.sweep && args.mode === 'semantic') {
      const pairFb = pairs.filter((row) => row.lane === 'fallback');
      const noFb = noInject.filter((row) => row.lane === 'fallback');
      const table = [];
      for (const minTop of SWEEP_MIN_TOP) for (const margin of SWEEP_MARGIN) {
        const key = `minTop=${minTop ?? 'ship'}|margin=${margin ?? 'ship'}`;
        const keepRecall = pct(pairFb.filter((row) => row.sweep?.[key]?.hitTwin).length, pairFb.length);
        const pairInjected = round(mean(pairFb.map((row) => row.sweep?.[key]?.injected ?? 0)), 2);
        const noZero = pct(noFb.filter((row) => (row.sweep?.[key]?.injected ?? 0) === 0).length, noFb.length);
        const noInjected = round(mean(noFb.map((row) => row.sweep?.[key]?.injected ?? 0)), 2);
        table.push({ rule: key, minTop, margin, capturePairFallbackRecallAt5: keepRecall, capturePairInjectedMean: pairInjected, noInjectZeroRate: noZero, noInjectInjectedMean: noInjected });
      }
      summary.sweep = { capturePairFallbackRows: pairFb.length, noInjectFallbackRows: noFb.length, table };
      console.error('\nrule                          | pair recall@5 | pair inj | no-inject zero% | no-inject inj');
      for (const r of table) console.error(`${r.rule.padEnd(30)}| ${String(r.capturePairFallbackRecallAt5 ?? '-').padStart(13)} | ${String(r.capturePairInjectedMean ?? '-').padStart(8)} | ${String(r.noInjectZeroRate ?? '-').padStart(15)} | ${String(r.noInjectInjectedMean ?? '-').padStart(13)}`);
    }
    for (const [file, expected] of [[args.brain, inputs.brainSha256], [args.prompts, inputs.promptsSha256]]) {
      if (hash(fs.readFileSync(file)) !== expected) throw new Error('An input changed during evaluation; result rejected. Use an immutable snapshot.');
    }
    for (const name of sourceFiles) if (optionalFileHash(moduleFile(name)) !== sourceHashes[name]) throw new Error('An engine file changed during evaluation; result rejected.');
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'Per-prompt hook lane retrieval on a capture-pair proxy set (prompt → the card that capture produced) plus a no-inject stratum. Measures which cards the lane would inject, not agent task success. Private prompt text is omitted unless --include-text.', inputs, configuration, summary, durationMs: Math.round(performance.now() - started), rows };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output: args.out, mode: args.mode, capturePair: summary.capturePair, noInject: summary.noInject, excluded: summary.excluded }));
  } finally {
    if (runtime && typeof runtime.disposeSemanticModels === 'function') await runtime.disposeSemanticModels();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
