// Hermetic regression suite for the long-lived semantic memory runtime.
// No model/network/disk cache is used: fake tensors prove batching, queueing,
// disposal, rollback mode, rerank ordering, and Windows cache-key identity.
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 5_000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return predicate();
};

const previous = {
  mode: process.env.KLYPIX_SEMANTIC_MEMORY_MODE,
  batch: process.env.KLYPIX_EMBED_BATCH_SIZE,
  rerankBatch: process.env.KLYPIX_RERANK_BATCH_SIZE,
  queue: process.env.KLYPIX_SEMANTIC_MAX_QUEUE,
  idle: process.env.KLYPIX_SEMANTIC_IDLE_MS,
};

try {
  process.env.KLYPIX_SEMANTIC_MEMORY_MODE = 'bounded';
  process.env.KLYPIX_EMBED_BATCH_SIZE = '2';
  process.env.KLYPIX_RERANK_BATCH_SIZE = '2';
  process.env.KLYPIX_SEMANTIC_MAX_QUEUE = '16';
  process.env.KLYPIX_SEMANTIC_IDLE_MS = '1000';
  const bounded = await import(`../src/semantic-memory.mjs?bounded=${Date.now()}`);

  let disposeCount = 0;
  const batches = [];
  const pipeOptions = [];
  const pipe = async (texts, options) => {
    batches.push([...texts]);
    pipeOptions.push(options);
    const data = Float32Array.from(texts.flatMap((_, index) => [index + 1, index + 2, index + 3]));
    return { dims: [texts.length, 3], data, dispose: () => { disposeCount++; } };
  };
  const vectors = await bounded.embedTexts(pipe, ['a', 'b', 'c', 'd', 'e']);
  ok(JSON.stringify(batches.map((batch) => batch.length)) === '[2,2,1]', 'bounded mode micro-batches embeddings');
  ok(vectors.length === 5 && vectors.every((vector) => vector.length === 3), 'micro-batching preserves output cardinality and shape');
  ok(disposeCount === 3, 'every returned embedding tensor is explicitly disposed after copying');
  await bounded.embedTexts(pipe, ['where is the release?'], { kind: 'query' });
  ok(
    batches.at(-1)?.[0] === `${bounded.EMBEDDING_QUERY_PREFIX}where is the release?`
      && pipeOptions.every(options => options?.pooling === 'cls' && options?.normalize === true),
    'BGE query instruction and CLS pooling are applied without prefixing passages',
  );
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

  bounded.__semanticMemoryTest.installModels({ reranker: rr });
  let leaseSeen = false;
  const leasedOrder = await bounded.withRerankerForUse(() => {}, 1000, async current => {
    leaseSeen = current === rr && bounded.semanticMemorySnapshot().queue.leases === 1;
    return bounded.rerankHits(current, 'question', hits);
  });
  ok(leaseSeen && leasedOrder.map(hit => hit.id).join('') === 'bac', 'reranker generation stays leased for the complete scoring callback');
  ok(bounded.semanticMemorySnapshot().queue.leases === 0, 'reranker lease releases only after scoring completes');
  bounded.__semanticMemoryTest.clearIdleTimer();

  if (process.platform === 'win32') {
    ok(
      bounded.canonicalBrainKey('E:\\Repo\\brain.klypix') === bounded.canonicalBrainKey('e:\\Repo\\brain.klypix'),
      'Windows drive-letter variants share one vector-cache identity',
    );
  } else {
    ok(true, 'Windows drive-letter cache identity test skipped on non-Windows');
  }
  const boundedSnapshot = bounded.semanticMemorySnapshot();
  ok(
    boundedSnapshot.mode === 'bounded'
      && boundedSnapshot.config.embeddingModel === 'Xenova/bge-small-en-v1.5'
      && boundedSnapshot.config.embeddingPooling === 'cls'
      && boundedSnapshot.config.rerankDefault === false
      && boundedSnapshot.counters.tensorsDisposed >= 6,
    'runtime exposes content-free BGE configuration and memory/disposal telemetry',
  );
  const hookConfig = await import(`../src/brain-semantic.mjs?config=${Date.now()}`);
  ok(
    hookConfig.HOOK_EMBEDDING_CACHE_KEY === bounded.EMBEDDING_CACHE_KEY,
    'one-shot hook and long-lived worker accept only the same model-aware vector cache',
  );

  let embedderDisposed = 0, rerankerDisposed = 0;
  bounded.__semanticMemoryTest.installModels({
    embedder: { dispose: async () => { embedderDisposed++; } },
    reranker: { model: { dispose: async () => { rerankerDisposed++; } } },
  });
  bounded.__semanticMemoryTest.armIdleDisposal();
  const idleDisposed = await waitFor(() => embedderDisposed === 1 && rerankerDisposed === 1);
  const disposedSnapshot = bounded.semanticMemorySnapshot();
  ok(idleDisposed, 'idle disposal retires both optional model generations');
  ok(disposedSnapshot.counters.idleDisposals >= 1 && disposedSnapshot.counters.lastDisposeReason === 'idle', 'idle disposal is observable without brain content');
  bounded.__semanticMemoryTest.clearIdleTimer();

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
  if (previous.idle == null) delete process.env.KLYPIX_SEMANTIC_IDLE_MS;
  else process.env.KLYPIX_SEMANTIC_IDLE_MS = previous.idle;
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ memory-runtime: all assertions passed');
process.exit(failures ? 1 : 0);
