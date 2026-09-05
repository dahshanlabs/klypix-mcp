#!/usr/bin/env node
// Evaluate a frozen project question set through the actual production ranker
// and semantic runtime. This measures evidence retrieval, not agent task success.
// Private brains/question sets are supplied by the caller and never bundled.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'node scripts/eval-retrieval.mjs --brain PATH --questions PATH --out PATH [--engine PATH] [--mode lexical|semantic]';
function options(argv) {
  const result = { engine: root, mode: 'lexical' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (argv[i] === '--help') return null;
    if (!['brain', 'questions', 'out', 'engine', 'mode'].includes(key) || !argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
    result[key] = argv[++i];
  }
  if (!result.brain || !result.questions || !result.out || !['lexical', 'semantic'].includes(result.mode)) throw new Error(usage);
  for (const key of ['brain', 'questions', 'out', 'engine']) result[key] = path.resolve(result[key]);
  if ([result.brain, result.questions].some(file => file.toLowerCase() === result.out.toLowerCase()) || fs.existsSync(result.out)) throw new Error('Output must be a new file, separate from the inputs.');
  return result;
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) { console.log(usage); return; }
  const brainBytes = fs.readFileSync(args.brain);
  const questionBytes = fs.readFileSync(args.questions);
  const spec = JSON.parse(questionBytes.toString('utf8'));
  const questions = Array.isArray(spec) ? spec : spec.questions;
  if (!Array.isArray(questions) || !questions.length) throw new Error('Question set must contain questions.');
  const moduleFile = (name) => path.join(args.engine, 'src', name);
  const lib = await import(pathToFileURL(moduleFile('klypix-format.mjs')).href);
  const { struct } = await lib.parseKlypix(brainBytes);
  const cards = new Map(struct.cards.map(card => [card.id, card]));
  const inputs = { brainSha256: hash(brainBytes), questionsSha256: hash(questionBytes), cards: struct.cards.length, authoredQuestions: questions.length };
  const sourceFiles = ['klypix-format.mjs', 'semantic-memory.mjs', 'klypix-core.mjs'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(name => [name, hash(fs.readFileSync(moduleFile(name)))]));
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* hashes remain sufficient to identify source bytes */ }
  const rows = [];
  let runtime = null, pipe = null, vectors = null;
  const started = performance.now();
  const configuration = { mode: args.mode, ranker: 'rankForQuestion', k: 20, rerank: false, engineCommit: commit, sourceHashes };
  try {
    if (args.mode === 'semantic') {
      runtime = await import(pathToFileURL(moduleFile('semantic-memory.mjs')).href);
      configuration.embedding = { model: runtime.EMBEDDING_MODEL_ID, pooling: runtime.EMBEDDING_POOLING, queryPrefix: runtime.EMBEDDING_QUERY_PREFIX, cacheKey: runtime.EMBEDDING_CACHE_KEY };
      pipe = await runtime.getEmbedderForUse((...items) => console.error(...items), 20_000);
      if (!pipe) throw new Error('Production semantic runtime unavailable; refusing to label a lexical fallback as a semantic result.');
      vectors = await runtime.vectorsForBrain(pipe, args.brain, struct.cards);
      if (!vectors?.size) throw new Error('Production card vectors unavailable.');
    }
    const pairSim = vectors ? (a, b) => vectors.has(a) && vectors.has(b) ? runtime.dot(vectors.get(a), vectors.get(b)) : null : null;
    for (const [index, question] of questions.entries()) {
      if (typeof question?.q !== 'string' || !question.q.trim()) throw new Error(`Question ${index} has no query.`);
      const ids = question.goldIds || (question.cardId ? [question.cardId] : []);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error(`Question ${index} has malformed gold IDs.`);
      const unanswerable = question.strategy === 'unanswerable';
      if (unanswerable && ids.length) throw new Error(`Question ${index} mixes unknown-answer and gold IDs.`);
      if (!unanswerable && !ids.length) throw new Error(`Question ${index} requires gold IDs or an explicit unanswerable label.`);
      const surviving = ids.filter(id => cards.has(id));
      const pinned = question.goldTexts;
      if (pinned !== undefined && (!Array.isArray(pinned) || pinned.length !== ids.length || pinned.some(text => typeof text !== 'string'))) throw new Error(`Question ${index} has malformed pinned gold text.`);
      const valid = surviving.filter(id => !pinned || flat(cards.get(id).text) === flat(pinned[ids.indexOf(id)]));
      const row = { index, strategy: question.strategy || 'unspecified', questionSha256: hash(question.q), goldIds: ids, missingGoldIds: ids.filter(id => !cards.has(id)), driftedGoldIds: surviving.filter(id => !valid.includes(id)) };
      if (!unanswerable && !valid.length) {
        rows.push({ ...row, excluded: surviving.length ? 'all-surviving-golds-drifted' : 'all-golds-missing' });
        continue;
      }
      const queryStarted = performance.now();
      let semantic = null;
      if (pipe) {
        const [qv] = await runtime.embedTexts(pipe, [question.q], { kind: 'query' });
        if (!qv) throw new Error(`Query vector unavailable at ${index}.`);
        semantic = new Map([...vectors].map(([id, vector]) => [id, runtime.dot(qv, vector)]));
      }
      const result = lib.rankForQuestion(struct, question.q, { semantic, pairSim, k: 20, as_of: question.as_of || null });
      const hits = result.hits || [];
      const rank = hits.findIndex(hit => valid.includes(hit.card.id));
      rows.push({ ...row, excluded: null, unanswerable, rank: rank < 0 ? null : rank + 1, hitIds: hits.map(hit => hit.card.id), topScore: hits.length ? (hits[0].score ?? hits[0].s ?? null) : null, correctionIds: hits.filter(hit => hit.correction).map(hit => hit.correction.by.id), durationMs: Math.round((performance.now() - queryStarted) * 100) / 100 });
      if ((index + 1) % 20 === 0) console.error(`Evaluated ${index + 1}/${questions.length}`);
    }
    const answered = rows.filter(row => !row.excluded && !row.unanswerable);
    const unknown = rows.filter(row => row.unanswerable);
    if (!answered.length) throw new Error('No unchanged answerable golds remain; refresh the frozen set explicitly.');
    const count = answered.length;
    const retrievalAt = k => answered.filter(row => row.rank !== null && row.rank <= k).length;
    const metric = (numerator, n = count) => ({ numerator, count: n, value: n ? numerator / n : null });
    const summary = { recallAt1: metric(retrievalAt(1)), recallAt5: metric(retrievalAt(5)), recallAt10: metric(retrievalAt(10)), recallAt20: metric(retrievalAt(20)), mrr: answered.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / count, excluded: rows.filter(row => row.excluded).length, unknownZeroHits: metric(unknown.filter(row => !row.hitIds.length).length, unknown.length), byStrategy: Object.fromEntries([...new Set(answered.map(row => row.strategy))].map(strategy => { const subset = answered.filter(row => row.strategy === strategy); return [strategy, metric(subset.filter(row => row.rank !== null && row.rank <= 5).length, subset.length)]; })) };
    for (const [file, expected] of [[args.brain, inputs.brainSha256], [args.questions, inputs.questionsSha256], ...sourceFiles.map(name => [moduleFile(name), sourceHashes[name]])]) {
      if (hash(fs.readFileSync(file)) !== expected) throw new Error('An input or engine file changed during evaluation; result rejected. Use an immutable snapshot.');
    }
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'Frozen project evidence retrieval only; not LLM answer accuracy or agent task success. Unknown-answer labels require human revalidation as the corpus evolves.', inputs, configuration, summary, durationMs: Math.round(performance.now() - started), rows };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output: args.out, ...summary, mode: args.mode }));
  } finally {
    if (runtime) await runtime.disposeSemanticModels();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
