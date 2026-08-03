// Hermetic regression suite for the long-lived semantic memory runtime.
// No model/network/disk cache is used: fake tensors prove batching, queueing,
// disposal, rollback mode, rerank ordering, and Windows cache-key identity.
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const previous = {
  mode: process.env.KLYPIX_SEMANTIC_MEMORY_MODE,
  batch: process.env.KLYPIX_EMBED_BATCH_SIZE,
  rerankBatch: process.env.KLYPIX_RERANK_BATCH_SIZE,
  queue: process.env.KLYPIX_SEMANTIC_MAX_QUEUE,
};

try {
  process.env.KLYPIX_SEMANTIC_MEMORY_MODE = 'bounded';
  process.env.KLYPIX_EMBED_BATCH_SIZE = '2';
  process.env.KLYPIX_RERANK_BATCH_SIZE = '2';
  process.env.KLYPIX_SEMANTIC_MAX_QUEUE = '16';
  const bounded = await import(`../src/semantic-memory.mjs?bounded=${Date.now()}`);

  let disposeCount = 0;
  const batches = [];
  const pipe = async (texts) => {
    batches.push([...texts]);
    const data = Float32Array.from(texts.flatMap((_, index) => [index + 1, index + 2, index + 3]));
    return { dims: [texts.length, 3], data, dispose: () => { disposeCount++; } };
  };
  const vectors = await bounded.embedTexts(pipe, ['a', 'b', 'c', 'd', 'e']);
  ok(JSON.stringify(batches.map((batch) => batch.length)) === '[2,2,1]', 'bounded mode micro-batches embeddings');
  ok(vectors.length === 5 && vectors.every((vector) => vector.length === 3), 'micro-batching preserves output cardinality and shape');
  ok(disposeCount === 3, 'every returned embedding tensor is explicitly disposed after copying');
  ok(!bounded.shouldPrewarmSemantic(), 'bounded mode does not eagerly load a model per MCP session');

  let active = 0, maxActive = 0;
  const queuedPipe = async (texts) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await wait(15);
    active--;
    return { dims: [texts.length, 1], data: Float32Array.from(texts.map(() => 1)), dispose() {} };
  };
  await Promise.all([
    bounded.embedTexts(queuedPipe, ['one']),
    bounded.embedTexts(queuedPipe, ['two']),
    bounded.embedTexts(queuedPipe, ['three']),
  ]);
  ok(maxActive === 1, 'bounded mode serializes native inference inside one worker');

  let inputDisposed = 0, logitsDisposed = 0;
  const rerankBatchSizes = [];
  const scoreByText = { A: 0.2, B: 0.9, C: -0.1 };
  const inputTensor = (length) => ({ dims: [length, 2], data: new BigInt64Array(length * 2), dispose: () => { inputDisposed++; } });
  const rr = {
    tokenizer: (_questions, options) => {
      const texts = options.text_pair;
      rerankBatchSizes.push(texts.length);
      return { input_ids: inputTensor(texts.length), attention_mask: inputTensor(texts.length), scores: texts.map((text) => scoreByText[text]) };
    },
    model: async (inputs) => ({ logits: { dims: [inputs.scores.length, 1], data: Float32Array.from(inputs.scores), dispose: () => { logitsDisposed++; } } }),
  };
  const hits = [{ id: 'a', card: { text: 'A' } }, { id: 'b', card: { text: 'B' } }, { id: 'c', card: { text: 'C' } }];
  const reranked = await bounded.rerankHits(rr, 'question', hits);
  ok(reranked.map((hit) => hit.id).join('') === 'bac', 'bounded reranking preserves score ordering');
  ok(JSON.stringify(rerankBatchSizes) === '[2,1]', 'bounded mode micro-batches cross-encoder reranking');
  ok(inputDisposed === 4 && logitsDisposed === 2, 'every reranker input and output tensor is explicitly disposed');

  if (process.platform === 'win32') {
    ok(
      bounded.canonicalBrainKey('E:\\Repo\\brain.klypix') === bounded.canonicalBrainKey('e:\\Repo\\brain.klypix'),
      'Windows drive-letter variants share one vector-cache identity',
    );
  } else {
    ok(true, 'Windows drive-letter cache identity test skipped on non-Windows');
  }
  const boundedSnapshot = bounded.semanticMemorySnapshot();
  ok(boundedSnapshot.mode === 'bounded' && boundedSnapshot.counters.tensorsDisposed >= 6, 'runtime exposes content-free memory/disposal telemetry');

  process.env.KLYPIX_SEMANTIC_MEMORY_MODE = 'legacy';
  process.env.KLYPIX_EMBED_BATCH_SIZE = '2';
  const legacy = await import(`../src/semantic-memory.mjs?legacy=${Date.now()}`);
  let legacyDisposals = 0, legacyCalls = 0;
  const legacyPipe = async (texts) => {
    legacyCalls++;
    return {
      dims: [texts.length, 1],
      data: Float32Array.from(texts.map(() => 1)),
      dispose: () => { legacyDisposals++; },
    };
  };
  await legacy.embedTexts(legacyPipe, ['a', 'b', 'c', 'd', 'e']);
  ok(legacy.semanticMemoryMode() === 'legacy' && legacy.shouldPrewarmSemantic(), 'legacy flag restores the original eager lifecycle');
  ok(legacyCalls === 1 && legacyDisposals === 0, 'legacy rollback restores one unbounded batch and original tensor ownership');
} catch (error) {
  console.error('✗ suite crashed:', error?.stack || error);
  failures++;
} finally {
  if (previous.mode == null) delete process.env.KLYPIX_SEMANTIC_MEMORY_MODE;
  else process.env.KLYPIX_SEMANTIC_MEMORY_MODE = previous.mode;
  if (previous.batch == null) delete process.env.KLYPIX_EMBED_BATCH_SIZE;
  else process.env.KLYPIX_EMBED_BATCH_SIZE = previous.batch;
  if (previous.rerankBatch == null) delete process.env.KLYPIX_RERANK_BATCH_SIZE;
  else process.env.KLYPIX_RERANK_BATCH_SIZE = previous.rerankBatch;
  if (previous.queue == null) delete process.env.KLYPIX_SEMANTIC_MAX_QUEUE;
  else process.env.KLYPIX_SEMANTIC_MAX_QUEUE = previous.queue;
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ memory-runtime: all assertions passed');
process.exit(failures ? 1 : 0);
