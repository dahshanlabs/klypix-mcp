#!/usr/bin/env node
// One detached, best-effort preparation of brains for search by meaning: after
// an install or a compatible core update (every registered brain), or started
// by a question on a brain that is not ready yet (--brain <file> --only: that
// brain alone). It runs at below-normal priority, reports progress to the
// status file while it works (brainPreparationStatus reads it), refreshes its
// lock so a long run is never taken for a dead one, and never changes brain
// content.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseKlypix } from '../src/klypix-format.mjs';
import { readRegisteredProjectBrains } from '../src/mcp-auto-update.mjs';
import {
  EMBEDDING_CACHE_KEY,
  cachedVectorsForBrain,
  disposeSemanticModels,
  getEmbedderForUse,
  vectorsForBrain,
} from '../src/semantic-memory.mjs';

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const brainDir = path.resolve(arg('brain-dir', path.join(os.homedir(), '.claude', 'project-brain')));
const lockFile = path.join(brainDir, '.semantic-update-warm.lock');
const statusFile = path.join(brainDir, '.semantic-update-warm.json');
const explicitBrain = arg('brain');
const onlyExplicit = process.argv.includes('--only');
const startedAt = Date.now();
let lock = null;

const atomicJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

// A background job: never compete with the person's own work for the CPU.
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best-effort */ }

try {
  fs.mkdirSync(brainDir, { recursive: true });
  try {
    lock = fs.openSync(lockFile, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(lockFile).mtimeMs > 30 * 60_000; } catch { stale = true; }
    if (!stale) process.exit(0);
    try { fs.unlinkSync(lockFile); } catch { process.exit(0); }
    lock = fs.openSync(lockFile, 'wx');
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt, modelKey: EMBEDDING_CACHE_KEY }));

  const registered = onlyExplicit && explicitBrain ? [] : readRegisteredProjectBrains(brainDir).map(item => item.brainPath);
  const candidates = [...new Set([explicitBrain ? path.resolve(explicitBrain) : null, ...registered].filter(Boolean))]
    .filter(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
  if (!candidates.length) {
    // Nothing to prepare yet, but fetch the model now (~33 MB, once) so the
    // first question on a new brain does not pay for the download.
    let model = 'unavailable';
    try { model = (await getEmbedderForUse(() => {}, 5 * 60_000)) ? 'downloaded' : 'unavailable'; } catch { /* the first question fetches it */ }
    atomicJson(statusFile, { protocol: 1, result: 'no-registered-brains', model, modelKey: EMBEDDING_CACHE_KEY, completedAt: new Date().toISOString() });
  } else {
    const pipe = await getEmbedderForUse(() => {}, 5 * 60_000);
    if (!pipe) {
      atomicJson(statusFile, { protocol: 1, result: 'semantic-unavailable', modelKey: EMBEDDING_CACHE_KEY, completedAt: new Date().toISOString() });
    } else {
      let warmed = 0, failed = 0, cards = 0;
      for (const file of candidates) {
        try {
          const { struct } = await parseKlypix(fs.readFileSync(file));
          const brainStarted = new Date().toISOString();
          let lastReport = 0;
          const report = ({ done, total }, force = false) => {
            if (!force && Date.now() - lastReport < 3_000) return;
            lastReport = Date.now();
            try { atomicJson(statusFile, { protocol: 1, result: 'preparing', modelKey: EMBEDDING_CACHE_KEY, brain: file, done, total, startedAt: brainStarted, updatedAt: new Date().toISOString() }); } catch { /* advisory */ }
            try { const now = new Date(); fs.utimesSync(lockFile, now, now); } catch { /* advisory */ }
          };
          let alreadyReady = 0;
          try { alreadyReady = cachedVectorsForBrain(file, struct.cards).size; } catch { /* starts from zero */ }
          report({ done: alreadyReady, total: struct.cards.filter(c => c.type !== 'container' && String(c.text || '').trim()).length }, true);
          const vectors = await vectorsForBrain(pipe, file, struct.cards, { maxEmbed: Infinity, onProgress: report });
          warmed++;
          cards += vectors.size;
        } catch { failed++; }
      }
      atomicJson(statusFile, {
        protocol: 1,
        result: failed ? (warmed ? 'partial' : 'failed') : 'ready',
        modelKey: EMBEDDING_CACHE_KEY,
        brains: candidates.length,
        warmed,
        failed,
        cards,
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      });
    }
  }
} catch {
  // Background migration is fail-open: a later brain_ask can still warm lazily.
} finally {
  try { await disposeSemanticModels(); } catch { /* */ }
  try { if (lock != null) fs.closeSync(lock); } catch { /* */ }
  try { fs.unlinkSync(lockFile); } catch { /* */ }
}

// onnxruntime can retain background handles after model disposal on Windows.
// This is a detached one-shot migration, so terminate deterministically after
// every cache/status write and cleanup has completed.
process.exit(0);
