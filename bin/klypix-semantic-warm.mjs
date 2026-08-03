#!/usr/bin/env node
// One detached, best-effort cache migration after a compatible core update.
// It runs only when the optional semantic runtime already exists, processes
// registered brains sequentially, and never changes brain content.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseKlypix } from '../src/klypix-format.mjs';
import { readRegisteredProjectBrains } from '../src/mcp-auto-update.mjs';
import {
  EMBEDDING_CACHE_KEY,
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
const startedAt = Date.now();
let lock = null;

const atomicJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

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

  const registered = readRegisteredProjectBrains(brainDir).map(item => item.brainPath);
  const candidates = [...new Set([explicitBrain ? path.resolve(explicitBrain) : null, ...registered].filter(Boolean))]
    .filter(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
  if (!candidates.length) {
    atomicJson(statusFile, { protocol: 1, result: 'no-registered-brains', modelKey: EMBEDDING_CACHE_KEY, completedAt: new Date().toISOString() });
  } else {
    const pipe = await getEmbedderForUse(() => {}, 5 * 60_000);
    if (!pipe) {
      atomicJson(statusFile, { protocol: 1, result: 'semantic-unavailable', modelKey: EMBEDDING_CACHE_KEY, completedAt: new Date().toISOString() });
    } else {
      let warmed = 0, failed = 0, cards = 0;
      for (const file of candidates) {
        try {
          const { struct } = await parseKlypix(fs.readFileSync(file));
          const vectors = await vectorsForBrain(pipe, file, struct.cards);
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
