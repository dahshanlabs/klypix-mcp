import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { semanticRuntimeEntryIfSafe as hookRuntimeSafe } from '../src/brain-semantic.mjs';
import { semanticRuntimeEntryIfSafe as workerRuntimeSafe } from '../src/semantic-memory.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-semantic-security-'));

function makeRuntime(sharpVersion, nesting = 'root') {
  const runtime = path.join(root, `${sharpVersion}-${nesting}`);
  const transformers = path.join(runtime, 'node_modules', '@huggingface', 'transformers');
  const sharp = nesting === 'package'
    ? path.join(transformers, 'node_modules', 'sharp')
    : nesting === 'entry'
      ? path.join(transformers, 'dist', 'node_modules', 'sharp')
      : path.join(runtime, 'node_modules', 'sharp');
  fs.mkdirSync(path.join(transformers, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(sharp, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(transformers, 'package.json'), JSON.stringify({
    name: '@huggingface/transformers', version: '4.2.0', main: 'dist/transformers.node.mjs',
  }));
  fs.writeFileSync(path.join(transformers, 'dist', 'transformers.node.mjs'), 'export {}');
  fs.writeFileSync(path.join(sharp, 'package.json'), JSON.stringify({
    name: 'sharp', version: sharpVersion, main: 'dist/index.cjs',
  }));
  fs.writeFileSync(path.join(sharp, 'dist', 'index.cjs'), 'module.exports = {}');
  return path.join(transformers, 'dist', 'transformers.node.mjs');
}

try {
  const stale = makeRuntime('0.34.5');
  const patched = makeRuntime('0.35.3');
  const newer = makeRuntime('0.36.0');
  const nestedStale = makeRuntime('0.34.5', 'package');
  const entryShadowedStale = makeRuntime('0.34.5', 'entry');
  for (const guard of [hookRuntimeSafe, workerRuntimeSafe]) {
    assert.equal(guard(stale), null, 'stale root sharp must be rejected');
    assert.equal(guard(nestedStale), null, 'stale sharp shadowed under Transformers must be rejected');
    assert.equal(guard(entryShadowedStale), null,
      'stale sharp shadowed beside the actual Transformers bundle entry must be rejected');
    assert.equal(guard(patched), patched, 'minimum patched sharp must be accepted');
    assert.equal(guard(newer), newer, 'newer compatible sharp must be accepted');
  }
  console.log('semantic runtime security gate: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
