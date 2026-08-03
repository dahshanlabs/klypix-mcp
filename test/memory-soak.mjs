// Opt-in real-model soak for Phase-1 release qualification.
// Run with:
//   KLYPIX_MEMORY_SOAK_BRAIN=/abs/brain.klypix npm run test:memory:soak
// Optional: KLYPIX_MEMORY_SOAK_CALLS=10 KLYPIX_MEMORY_MAX_RSS_MB=750
import fs from 'fs';
import path from 'path';
import { opBrainAsk, semanticMemorySnapshot } from '../src/klypix-core.mjs';
import { disposeSemanticModels } from '../src/semantic-memory.mjs';

const brain = process.env.KLYPIX_MEMORY_SOAK_BRAIN
  ? path.resolve(process.env.KLYPIX_MEMORY_SOAK_BRAIN)
  : null;
if (!brain || !fs.existsSync(brain)) {
  console.error('Set KLYPIX_MEMORY_SOAK_BRAIN to an existing brain.klypix file.');
  process.exit(2);
}

const clamp = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
};
const calls = clamp(process.env.KLYPIX_MEMORY_SOAK_CALLS, 10, 2, 1000);
const maxRssMb = clamp(process.env.KLYPIX_MEMORY_MAX_RSS_MB, 750, 100, 16_384);
const maxGrowthMb = clamp(process.env.KLYPIX_MEMORY_MAX_GROWTH_MB, 100, 10, 4096);
const deadlineMs = clamp(process.env.KLYPIX_MEMORY_SOAK_TIMEOUT_MS, 300_000, 30_000, 3_600_000);
const questions = [
  'What is the current project focus and why?',
  'Which correction changed an earlier decision?',
  'What multi-agent coordination guarantees exist?',
  'What remains open for reliability and release?',
  'What rules must future agents preserve?',
];
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const samples = [];
let failures = 0;
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ event: 'timeout', deadlineMs }));
  process.exit(124);
}, deadlineMs);

try {
  for (let index = 0; index < calls; index++) {
    const started = Date.now();
    const result = await opBrainAsk({
      vault: path.dirname(brain),
      canvas: brain,
      question: questions[index % questions.length],
      k: 10,
    });
    global.gc?.();
    const snapshot = semanticMemorySnapshot();
    const sample = {
      call: index + 1,
      ms: Date.now() - started,
      ok: !result.isError,
      rssMb: mb(snapshot.memory.rss),
      heapUsedMb: mb(snapshot.memory.heapUsed),
      externalMb: mb(snapshot.memory.external),
      arrayBuffersMb: mb(snapshot.memory.arrayBuffers),
      mode: snapshot.mode,
      embedBatches: snapshot.counters.embedBatches,
      rerankBatches: snapshot.counters.rerankBatches,
      disposed: snapshot.counters.tensorsDisposed,
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
    if (!sample.ok) failures++;
  }
  const peak = Math.max(...samples.map((sample) => sample.rssMb));
  // Native inference engines populate reusable arenas over their first several
  // calls. Treat the first half as warm-up, then fail only if the post-warm-up
  // high-water mark keeps rising materially. Every raw sample is still emitted.
  const warmStart = Math.max(1, Math.floor(samples.length / 2));
  const warmBase = samples[warmStart].rssMb;
  const steadyPeak = Math.max(...samples.slice(warmStart).map((sample) => sample.rssMb));
  const growth = Math.round((steadyPeak - warmBase) * 10) / 10;
  const summary = {
    event: 'summary',
    calls,
    peakRssMb: peak,
    steadyGrowthMb: growth,
    warmStartCall: warmStart + 1,
    maxRssMb,
    maxGrowthMb,
  };
  console.log(JSON.stringify(summary));
  if (peak > maxRssMb) { console.error(`Peak RSS ${peak} MB exceeded ${maxRssMb} MB`); failures++; }
  if (growth > maxGrowthMb) { console.error(`Post-warm-up growth ${growth} MB exceeded ${maxGrowthMb} MB`); failures++; }
} catch (error) {
  console.error(error?.stack || error);
  failures++;
} finally {
  clearTimeout(watchdog);
  await disposeSemanticModels();
}

// onnxruntime can retain background handles after model disposal on Windows;
// this is an isolated qualification process, so terminate deterministically.
process.exit(failures ? 1 : 0);
