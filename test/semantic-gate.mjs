// semantic-gate — the deploy-gate of the OPTIONAL on-device semantic lane,
// enforced (2026-07-29). A one-shot hook process must NEVER load the embedding
// model when there are no cached card vectors to rank against: the lane never
// embeds cards, so an empty cache means there is nothing to score — and
// importing transformers (which resolves from ANY ambient node_modules, e.g. a
// dev repo's) spins onnxruntime worker threads whose teardown races the hook's
// process.exit(0). On Windows/Node 24 that race aborts the whole hook process
// (libuv "!(handle->flags & UV_HANDLE_CLOSING)" in src/win/async.c) — exactly
// how test/lane-message.mjs used to crash on machines with transformers
// installed. Proves: empty cache → semanticVecs resolves null FAST (the model
// budget is never entered), and the never-throw contract holds.
// Run:  node test/semantic-gate.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// Hermetic home BEFORE the import — brain-semantic derives its cache dirs from
// os.homedir() at module load.
const home = path.join(os.tmpdir(), 'klypix-semantic-gate-home');
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home; process.env.USERPROFILE = home;

try {
  const { semanticVecs } = await import('../src/brain-semantic.mjs');
  const struct = { cards: [{ id: 'c1', text: 'ship the uploader' }, { id: 'c2', text: 'fix the reducer' }] };
  const t0 = Date.now();
  const res = await semanticVecs(path.join(home, 'brain.klypix'), struct, 'what changed in the uploader?', { timeoutMs: 30_000 });
  const elapsed = Date.now() - t0;
  ok(res === null, 'empty vector cache → null (pure-lexical fallback)');
  ok(elapsed < 2000,
    `empty-cache miss returns fast (${elapsed}ms) — the 30s model budget was never entered, so no transformers import / onnx worker threads in a one-shot hook`);
  ok(await semanticVecs('', null, '', {}) === null, 'garbage input → null, never a throw');
  ok(await semanticVecs(path.join(home, 'brain.klypix'), struct, '   ', { timeoutMs: 30_000 }) === null, 'blank query → null before any cache or model work');
} catch (e) {
  console.error('✗ suite crashed:', (e && e.stack) || e);
  failures++;
} finally {
  process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
}
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ semantic-gate: all assertions passed');
process.exit(failures ? 1 : 0);
