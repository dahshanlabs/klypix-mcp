// Cross-process regression for the model-aware semantic vector cache.
// Two workers race the same cold brain: one embeds while the other waits, then
// both read the same complete atomic cache. No model or network is involved.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

if (process.env.KLYPIX_CACHE_TEST_CHILD === '1') {
  const semantic = await import(`../src/semantic-memory.mjs?child=${process.pid}`);
  let embedCalls = 0;
  const pipe = async (texts) => {
    embedCalls++;
    await new Promise(resolve => setTimeout(resolve, 250));
    return {
      dims: [texts.length, 3],
      data: Float32Array.from(texts.flatMap((_, index) => [1, index + 1, 0.5])),
      dispose() {},
    };
  };
  const cards = [
    { id: 'one', type: 'text', text: `Release cache concurrency decision one${process.env.KLYPIX_CACHE_TEST_VARIANT || ''}.` },
    { id: 'two', type: 'text', text: 'Release cache concurrency decision two.' },
  ];
  const vectors = await semantic.vectorsForBrain(pipe, process.env.KLYPIX_CACHE_TEST_BRAIN, cards);
  process.stdout.write(JSON.stringify({ embedCalls, vectors: vectors.size }));
  process.exit(vectors.size === 2 ? 0 : 1);
}

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-sem-cache-'));
const brain = path.join(root, 'project', 'brain.klypix');
fs.mkdirSync(path.dirname(brain), { recursive: true });
fs.writeFileSync(brain, 'cache identity only');
const script = fileURLToPath(import.meta.url);

const run = (variant = '') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      KLYPIX_CACHE_TEST_CHILD: '1',
      KLYPIX_CACHE_TEST_BRAIN: brain,
      KLYPIX_CACHE_TEST_VARIANT: variant,
      KLYPIX_SEMANTIC_MEMORY_MODE: 'bounded',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', code => code === 0
    ? resolve(JSON.parse(stdout))
    : reject(new Error(`cache child exited ${code}: ${stderr || stdout}`)));
});

try {
  const results = await Promise.all([run(), run()]);
  ok(results.every(result => result.vectors === 2), 'both racing workers receive the complete vector set');
  ok(results.reduce((sum, result) => sum + result.embedCalls, 0) === 1, 'cross-process lock embeds a cold brain only once');
  const refreshed = await run('-updated');
  ok(refreshed.embedCalls === 1 && refreshed.vectors === 2, 'atomic cache replacement succeeds when one card changes');
  const embeddingDir = path.join(root, '.claude', 'project-brain', 'embeddings');
  const files = fs.readdirSync(embeddingDir);
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  ok(jsonFiles.length === 1 && !files.some(file => /\.(?:lock|tmp)$/.test(file)), 'atomic cache commit leaves one JSON and no lock/temp debris');
  const cache = JSON.parse(fs.readFileSync(path.join(embeddingDir, jsonFiles[0]), 'utf8'));
  ok(cache.modelKey === 'Xenova/bge-small-en-v1.5|q8|cls|query-instruction-v1', 'cache identity includes the exact BGE model and pooling contract');
  if (process.platform === 'win32') {
    const rawKey = brain.replace(/\\/g, '/');
    const alias = path.join(embeddingDir, `${crypto.createHash('sha1').update(rawKey).digest('hex')}.json`);
    const canonical = path.join(embeddingDir, jsonFiles[0]);
    if (alias !== canonical) {
      fs.writeFileSync(alias, JSON.stringify({ v: 1, cards: { legacy: { h: 'old', v: [1] } } }));
      const before = fs.readFileSync(canonical);
      const reused = await run('-updated');
      ok(reused.embedCalls === 0, 'a stale drive-case MiniLM alias does not invalidate the canonical BGE cache');
      ok(before.equals(fs.readFileSync(canonical)), 'legacy alias coexistence causes zero canonical cache rewrite');
    }
  }
} catch (error) {
  console.error(error?.stack || error);
  failures++;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ semantic-cache: all assertions passed');
process.exit(failures ? 1 : 0);
