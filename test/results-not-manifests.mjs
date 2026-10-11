// `results` is for machine-checkable manifests only (1.99.0).
//
// Seen on the first live coordination-bench run (Codex, 2026-10-11): a
// premature complete was deferred with "…(or include a result manifest)", so
// Codex re-sent complete with `results: { outcome, checks }`. That entered the
// fail-closed evidence contract and locked the task: every later result-less
// complete was refused as "result-manifest-required", and the finished task
// stayed active to every peer.
//   R1 — the deferral no longer invites a manifest; it says checkpoint, then complete.
//   R2 — a summary object is refused for that call (results-not-manifests), scope retained.
//   R3 — the plain retry completes at once and clears the scope (no lock, no second deferral).
//   R4 — prose (a string) behaves the same.
//   R5 — anything EVIDENCE-SHAPED keeps the full contract: a malformed manifest
//        object still locks the task, so a result-less retry stays blocked.
//   R6 — the shape rule itself, and the tool description says "never a summary".
// Run:  node test/results-not-manifests.mjs   (exit 0 = pass)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { laneFileFor } from '../src/agent-presence.mjs';
import { createMcpPresence, isEvidenceShapedResults } from '../src/mcp-presence.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-results-shape-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');
const fakeServer = { server: { getClientVersion: () => ({ name: 'codex', version: 'test' }) }, sendLoggingMessage() {} };
let clock = 2_700_000_000_000;
const worker = (id) => createMcpPresence({
  server: fakeServer, initialVault: project, env: { KLYPIX_SESSION_ID: id }, home,
  now: () => clock, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
});
const laneRow = (id) => JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8')).sessions.find((row) => row.id === id);
const kinds = (res) => (res.structured?.resultConflicts || []).map((c) => c.kind);

try {
  // ── R1–R3: Codex's exact sequence ─────────────────────────────────────────
  {
    const mcp = worker('codex-like');
    mcp.start();
    mcp.sync({ phase: 'start', intent: 'Add migration 002 to the deploy plan', files: ['scripts/deploy.js'] });
    clock += 36_000;
    const deferred = mcp.sync({ phase: 'complete', files: ['scripts/deploy.js'] });
    ok(deferred.structured?.status === 'complete-deferred' && !/include a result manifest/.test(deferred.text)
      && /phase "checkpoint", then "complete" again/.test(deferred.text) && /never a summary/.test(deferred.text),
    'R1: a premature complete is deferred, and the advice is checkpoint-then-complete — never "include a result manifest"');

    clock += 4_000;
    const summary = mcp.sync({ phase: 'complete', results: { outcome: 'deploy.js now runs backfill before 002', checks: ['node assert passed'] } });
    ok(summary.isError === true && kinds(summary).includes('results-not-manifests') && /WITHOUT results/.test(summary.text),
      'R2: a summary object is refused for that call, and the answer says to complete again without results');
    ok(!!laneRow('codex-like')?.intent, 'R2: the task scope is retained after the refused summary');

    clock += 3_000;
    const retry = mcp.sync({ phase: 'complete' });
    ok(retry.isError !== true && retry.structured?.status === 'complete' && !kinds(retry).length,
      'R3: the plain retry completes at once — no evidence lock, no second premature deferral');
    ok(!laneRow('codex-like')?.intent, 'R3: and the finished task no longer shows as active to peers');
  }

  // ── R4: prose behaves the same ────────────────────────────────────────────
  {
    const mcp = worker('prose');
    mcp.start();
    mcp.sync({ phase: 'start', intent: 'prose results', files: ['a.txt'] });
    clock += 2_000;
    const prose = mcp.sync({ phase: 'complete', results: 'All done, tests pass.' });
    clock += 1_000;
    const retry = mcp.sync({ phase: 'complete' });
    ok(prose.isError === true && kinds(prose).includes('results-not-manifests') && retry.structured?.status === 'complete',
      'R4: prose in `results` is refused once, and the plain retry completes');
  }

  // ── R5: evidence-shaped stays fail-closed ─────────────────────────────────
  {
    const mcp = worker('evidence-shaped');
    mcp.start();
    mcp.sync({ phase: 'start', intent: 'malformed manifest', files: ['b.txt'] });
    mcp.sync({ phase: 'checkpoint' });
    clock += 2_000;
    const bad = mcp.sync({ phase: 'complete', results: { claimKey: 'brain.core.x', metrics: {} } });
    clock += 1_000;
    const retry = mcp.sync({ phase: 'complete' });
    ok(bad.isError === true && !kinds(bad).includes('results-not-manifests')
      && retry.isError === true && kinds(retry).includes('result-manifest-required'),
    'R5: a malformed manifest (it has manifest fields) still locks the task — the evidence contract is unchanged');
  }

  // ── R6: the rule and the description ──────────────────────────────────────
  ok(isEvidenceShapedResults([]) && isEvidenceShapedResults([{}]) && isEvidenceShapedResults({ claimKey: 'k' }) && isEvidenceShapedResults({ schemaVersion: 1 })
    && !isEvidenceShapedResults({ outcome: 'x' }) && !isEvidenceShapedResults('done') && !isEvidenceShapedResults(null) && !isEvidenceShapedResults(7),
  'R6: arrays and objects with a manifest field are evidence; summaries, prose and null are not');
  const worker_src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'klypix-worker.mjs'), 'utf8');
  ok(/`results` is ONLY for such manifests, never a summary of the work/.test(worker_src), 'R6: the brain_sync description says results is never a summary');
} finally {
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* */ }
}

console.log(failures ? `\n${failures} results-shape check(s) FAILED` : '\nall results-shape checks passed');
process.exit(failures ? 1 : 0);
