import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import { enrichmentFileFor, recordEnrichment, ENRICHMENT_TTL_MS } from '../src/enrichment.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-retrieval-eval-'));
const script = fileURLToPath(new URL('../scripts/eval-retrieval.mjs', import.meta.url));
try {
  const brain = path.join(tmp, 'brain.klypix');
  const questions = path.join(tmp, 'questions.json');
  const out = path.join(tmp, 'result.json');
  const bytes = await buildKlypixMap({ title: 'evaluation fixture', areas: [{ title: 'Auth', cards: [{ text: 'Auth: refresh token rotation uses a seven day interval for tenant isolation.' }] }] });
  fs.writeFileSync(brain, bytes);
  const { struct } = await parseKlypix(bytes);
  const card = struct.cards.find(item => /seven day/.test(item.text));
  const q = { q: 'How does auth refresh token rotation work?', strategy: 'paraphrase', goldIds: [card.id], goldTexts: [card.text] };
  fs.writeFileSync(questions, JSON.stringify({ version: 2, questions: [q, { ...q, goldIds: ['removed-card'] }, { ...q, goldTexts: ['obsolete pinned text'] }, { q: 'zqxv fictional measurement?', strategy: 'unanswerable', goldIds: [], goldTexts: [] }] }));
  const run = (...more) => spawnSync(process.execPath, [script, '--brain', brain, '--questions', questions, '--out', out, ...more], { encoding: 'utf8', timeout: 30_000 });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(report.configuration.mode, 'lexical');
  assert.equal(report.inputs.enrichment.used, false);
  assert.equal(report.summary.recallAt1.numerator, 1);
  assert.equal(report.summary.recallAt1.count, 1);
  assert.equal(report.summary.excluded, 2);
  assert.equal(report.summary.unknownZeroHits.count, 1);
  assert.equal(report.rows[1].excluded, 'all-golds-missing');
  assert.equal(report.rows[2].excluded, 'all-surviving-golds-drifted');
  assert.match(report.inputs.brainSha256, /^[a-f0-9]{64}$/);
  assert.match(report.configuration.sourceHashes['klypix-format.mjs'], /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(brain), bytes, 'evaluation cannot modify the brain');
  assert.ok(!fs.readFileSync(out, 'utf8').includes('seven day interval'), 'report omits source contents');
  const saved = fs.readFileSync(out);
  result = run();
  assert.notEqual(result.status, 0, 'existing evidence must not be overwritten');
  assert.deepEqual(fs.readFileSync(out), saved);
  result = spawnSync(process.execPath, [script, '--brain', brain, '--questions', questions, '--out', brain], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(brain), bytes);
  fs.writeFileSync(questions, JSON.stringify({ questions: [{ ...q, goldTexts: [] }] }));
  result = run('--out', path.join(tmp, 'invalid.json'));
  assert.notEqual(result.status, 0, 'invalid gold pin shape fails closed');
  assert.ok(!fs.existsSync(path.join(tmp, 'invalid.json')));
  // Exercise the semantic evaluator without downloading a model: only the
  // inference calls are stubbed. Enrichment reading/TTL and the ranker use the
  // production implementations, with sidecars confined to this test's temp home.
  const engine = path.join(tmp, 'engine'), testHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(engine, 'src'), { recursive: true });
  const formatUrl = new URL('../src/klypix-format.mjs', import.meta.url).href;
  const enrichmentUrl = new URL('../src/enrichment.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(engine, 'src', 'klypix-format.mjs'), 'export * from ' + JSON.stringify(formatUrl) + ';\n');
  fs.writeFileSync(path.join(engine, 'src', 'klypix-core.mjs'), '// Semantic inference fixture; not a production benchmark.\n');
  const enrichmentSource = [
    'import { enrichmentFileFor as file, readEnrichment as read, recordEnrichment as record } from ' + JSON.stringify(enrichmentUrl) + ';',
    'const home = ' + JSON.stringify(testHome) + ';',
    'export const enrichmentFileFor = brain => file(brain, home);',
    'export const readEnrichment = (brain, options = {}) => read(brain, { ...options, home });',
    'export const recordEnrichment = (brain, items) => record(brain, items, { home });',
  ].join('\n');
  fs.writeFileSync(path.join(engine, 'src', 'enrichment.mjs'), enrichmentSource);
  const observed = path.join(tmp, 'observed-enrichment.json');
  fs.writeFileSync(path.join(engine, 'src', 'semantic-memory.mjs'), [
    "import fs from 'node:fs';",
    "import { readEnrichment, recordEnrichment, enrichmentFileFor } from './enrichment.mjs';",
    "export const EMBEDDING_MODEL_ID='fixture', EMBEDDING_POOLING='cls', EMBEDDING_QUERY_PREFIX='query: ', EMBEDDING_CACHE_KEY='fixture';",
    'export const getEmbedderForUse = async () => ({});',
    'export async function vectorsForBrain(pipe, brain, cards) {',
    "  if (process.env.KLYPIX_EVAL_TEST_MUTATION === 'write') recordEnrichment(brain, [{ body: cards.find(c => c.type === 'text').text, question: 'Mutation during evaluation must invalidate the receipt.' }]);",
    "  if (process.env.KLYPIX_EVAL_TEST_MUTATION === 'delete') fs.unlinkSync(enrichmentFileFor(brain));",
    "  if (process.env.KLYPIX_EVAL_TEST_MUTATION === 'source') fs.appendFileSync(new URL('./enrichment.mjs', import.meta.url), '\\n// changed during evaluation\\n');",
    '  fs.writeFileSync(' + JSON.stringify(observed) + ', JSON.stringify(readEnrichment(brain)));',
    '  return new Map(cards.map(c => [c.id, [1]]));',
    '}',
    'export const embedTexts = async () => [[1]];',
    'export const dot = () => 1;',
    'export const disposeSemanticModels = async () => {};',
  ].join('\n'));
  fs.writeFileSync(questions, JSON.stringify({ questions: [q] }));
  const semanticRun = (name, mutation = '') => {
    const destination = path.join(tmp, name + '.json');
    const child = spawnSync(process.execPath, [script, '--brain', brain, '--questions', questions, '--out', destination, '--engine', engine, '--mode', 'semantic'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, KLYPIX_EVAL_TEST_MUTATION: mutation },
    });
    return { ...child, destination };
  };
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  let semanticResult = semanticRun('semantic-absent');
  assert.equal(semanticResult.status, 0, semanticResult.stderr);
  const absent = JSON.parse(fs.readFileSync(semanticResult.destination, 'utf8'));
  assert.equal(absent.inputs.enrichment.sidecarState, 'absent');
  assert.equal(absent.inputs.enrichment.sidecarSha256, null);
  assert.equal(absent.inputs.enrichment.effectiveEntries, 0);
  assert.equal(absent.inputs.enrichment.effectiveSha256, sha(fs.readFileSync(observed)));
  assert.match(absent.configuration.sourceHashes['enrichment.mjs'], /^[a-f0-9]{64}$/);

  // Absent -> present during inference must fail too, not merely edits to a
  // pre-existing sidecar. No result file may survive either invalid run.
  semanticResult = semanticRun('semantic-appeared', 'write');
  assert.notEqual(semanticResult.status, 0, 'new enrichment during inference invalidates an absent-state receipt');
  assert.match(semanticResult.stderr, /enrichment.*changed/i);
  assert.ok(!fs.existsSync(semanticResult.destination));
  const sidecar = enrichmentFileFor(brain, testHome);
  fs.unlinkSync(sidecar);
  recordEnrichment(brain, [{ body: card.text, question: 'Private current wording used by the actual vector builder.' }], { home: testHome });
  const activeRecord = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  // The enrichment sidecar is JSON, not a packaged brain. A distinct expired
  // key verifies effective-entry pinning differs from raw-byte pinning.
  activeRecord.entries['expired separate prefix for fixture'] = { q: ['expired private input'], ts: Date.now() - ENRICHMENT_TTL_MS - 60_000 };
  fs.writeFileSync(sidecar, JSON.stringify(activeRecord));
  const sidecarBytes = fs.readFileSync(sidecar);
  semanticResult = semanticRun('semantic-present');
  assert.equal(semanticResult.status, 0, semanticResult.stderr);
  const present = JSON.parse(fs.readFileSync(semanticResult.destination, 'utf8'));
  assert.equal(present.inputs.enrichment.sidecarState, 'present');
  assert.equal(present.inputs.enrichment.sidecarSha256, sha(sidecarBytes));
  assert.equal(present.inputs.enrichment.effectiveEntries, 1, 'expired entries are excluded using the production reader');
  assert.equal(present.inputs.enrichment.effectiveSha256, sha(fs.readFileSync(observed)), 'receipt pins the effective entries consumed by vectorsForBrain');
  assert.notEqual(present.inputs.enrichment.effectiveSha256, absent.inputs.enrichment.effectiveSha256);
  assert.ok(!fs.readFileSync(semanticResult.destination, 'utf8').includes('Private current wording'), 'receipt omits private enrichment text');
  assert.deepEqual(fs.readFileSync(sidecar), sidecarBytes, 'reading the frozen enrichment leaves it unchanged');
  semanticResult = semanticRun('semantic-mutated', 'write');
  assert.notEqual(semanticResult.status, 0, 'changed enrichment during inference invalidates the receipt');
  assert.ok(!fs.existsSync(semanticResult.destination));
  semanticResult = semanticRun('semantic-deleted', 'delete');
  assert.notEqual(semanticResult.status, 0, 'deleted enrichment during inference invalidates the receipt');
  assert.ok(!fs.existsSync(semanticResult.destination));
  fs.writeFileSync(sidecar, JSON.stringify({ v: 1, entries: {} }));
  semanticResult = semanticRun('semantic-present-empty');
  assert.equal(semanticResult.status, 0, semanticResult.stderr);
  const empty = JSON.parse(fs.readFileSync(semanticResult.destination, 'utf8'));
  assert.equal(empty.inputs.enrichment.sidecarState, 'present', 'an empty file remains distinguishable from an absent file');
  assert.equal(empty.inputs.enrichment.effectiveSha256, absent.inputs.enrichment.effectiveSha256);
  assert.notEqual(empty.inputs.enrichment.sidecarSha256, absent.inputs.enrichment.sidecarSha256);
  semanticResult = semanticRun('semantic-source-changed', 'source');
  assert.notEqual(semanticResult.status, 0, 'changing the production enrichment implementation invalidates source pinning');
  assert.ok(!fs.existsSync(semanticResult.destination));
  console.log('PASS: production retrieval evaluation pins corpus, questions, engine and effective enrichment; preserves inputs and rejects changed, overwritten or invalid receipts.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
