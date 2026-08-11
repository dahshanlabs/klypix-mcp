import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { laneFileFor, listActiveSessions } from '../src/agent-presence.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';
import {
  compareResultManifests,
  resultLedgerFileFor,
  sha256ResultValue,
  validateResultManifest,
} from '../src/result-reconcile.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const fixtureRoot = path.join(os.tmpdir(), `klypix-result-reconcile-${process.pid}`);
const project = path.join(fixtureRoot, 'project');
const home = path.join(fixtureRoot, 'home');
fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(project, 'artifacts'), { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'result reconciliation fixture');

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputDetails = {
  corpus: { sha256: '1'.repeat(64), cards: 2377 },
  questionSet: { sha256: '2'.repeat(64), count: 20 },
};
const defaultConfiguration = {
  ranker: 'rankForQuestion',
  rerank: false,
  candidates: 20,
  semantic: { model: 'bge-small-en-v1.5', pooling: 'cls', queryPrefix: true },
};
const defaultMetrics = {
  mrr: { value: 0.221, count: 20, tolerance: 0.002 },
  recallAt5: { value: 0.30, numerator: 6, count: 20, tolerance: 0 },
  recallAt10: { value: 0.35, numerator: 7, count: 20, tolerance: 0 },
  recallAt20: { value: 0.45, numerator: 9, count: 20, tolerance: 0 },
};

const makeManifest = ({ tag, metrics = defaultMetrics, configuration = defaultConfiguration } = {}) => {
  const reportPath = `artifacts/${tag}.json`;
  const reportFile = path.join(project, reportPath);
  fs.writeFileSync(reportFile, JSON.stringify({ tag, metrics, configuration }));
  return {
    schemaVersion: 1,
    claimKey: 'brain.retrieval.shipping-default',
    report: { path: reportPath, sha256: hashFile(reportFile) },
    provenance: {
      producer: 'test/result-reconcile.mjs',
      runId: tag,
      gitCommit: 'a'.repeat(40),
      dirtyDigest: '0'.repeat(64),
    },
    input: { fingerprint: sha256ResultValue(inputDetails), details: inputDetails },
    configuration: { fingerprint: sha256ResultValue(configuration), details: configuration },
    metrics,
  };
};

const base = makeManifest({ tag: 'base' });
const checkedBase = validateResultManifest(base, { projectRoot: project });
ok(checkedBase.ok, 'a complete manifest verifies report hash, provenance, and context fingerprints');

const unknownTopLevel = { ...base, publishable: true };
ok(!validateResultManifest(unknownTopLevel, { projectRoot: project }).ok,
  'unknown top-level fields fail closed at the schema-version boundary');

const coercedMetric = structuredClone(base);
coercedMetric.metrics.mrr.tolerance = null;
ok(!validateResultManifest(coercedMetric, { projectRoot: project }).ok,
  'metric validation rejects coercible non-number values');

const missingProvenance = structuredClone(base);
delete missingProvenance.provenance;
const invalid = validateResultManifest(missingProvenance, { projectRoot: project });
ok(!invalid.ok && invalid.errors.some((error) => error.includes('provenance')),
  'missing provenance is invalid instead of silently trusted');

const badReportHash = structuredClone(base);
badReportHash.report.sha256 = 'f'.repeat(64);
ok(!validateResultManifest(badReportHash, { projectRoot: project }).ok,
  'a report hash that does not match the artifact is invalid');

const tolerant = makeManifest({
  tag: 'tolerant',
  metrics: { ...defaultMetrics, mrr: { value: 0.222, count: 20, tolerance: 0.002 } },
});
const checkedTolerant = validateResultManifest(tolerant, { projectRoot: project });
ok(compareResultManifests(checkedBase.manifest, checkedTolerant.manifest).status === 'corroborated',
  'an explicitly tolerated MRR difference corroborates');

const numericConflict = makeManifest({
  tag: 'numeric-conflict',
  metrics: {
    ...defaultMetrics,
    recallAt5: { value: 0.20, numerator: 4, count: 20, tolerance: 0 },
    recallAt20: { value: 0.50, numerator: 10, count: 20, tolerance: 0 },
  },
});
const checkedConflict = validateResultManifest(numericConflict, { projectRoot: project });
const numericComparison = compareResultManifests(checkedBase.manifest, checkedConflict.manifest);
ok(numericComparison.status === 'conflict'
  && numericComparison.conflicts.some((conflict) => conflict.metric === 'recallAt5')
  && numericComparison.conflicts.some((conflict) => conflict.metric === 'recallAt20'),
'the incident-shaped 20/35/50 versus 30/35/45 disagreement is a blocking numeric conflict');

const reranked = makeManifest({
  tag: 'reranked',
  configuration: { ...defaultConfiguration, rerank: true },
});
const checkedReranked = validateResultManifest(reranked, { projectRoot: project });
const configurationComparison = compareResultManifests(checkedBase.manifest, checkedReranked.manifest);
ok(configurationComparison.status === 'incomparable'
  && configurationComparison.conflicts.some((conflict) => conflict.kind === 'configuration-fingerprint-mismatch'),
'reranked and shipping-default evidence is incomparable under one public claim key');

const fakeServer = (name) => ({
  server: { getClientVersion: () => ({ name, version: 'test' }) },
  sendLoggingMessage() {},
});
const timer = () => ({ unref() {} });
const clock = 2_100_000_000_000;
const presence = (id, offset = 0) => createMcpPresence({
  server: fakeServer('codex'),
  initialVault: project,
  env: { KLYPIX_SESSION_ID: id },
  home,
  now: () => clock + offset,
  setIntervalFn: timer,
  clearIntervalFn() {},
});

const mcpA = presence('result-session-a');
mcpA.start();
mcpA.sync({ phase: 'start', intent: 'publish shipping retrieval metrics', files: ['a.txt'] });
const unique = mcpA.sync({ phase: 'complete', results: [base] });
const uniqueSelf = unique.sessions.find((session) => session.id === 'result-session-a');
ok(unique.structured.status === 'complete'
  && unique.structured.resultReconciliation?.status === 'unique'
  && unique.structured.resultReconciliation?.receipt?.claims[0]?.submitted?.runId === 'base'
  && /^[a-f0-9]{64}$/.test(unique.structured.resultReconciliation?.receiptHash || '')
  && uniqueSelf?.intent === '' && uniqueSelf?.files?.length === 0
  && fs.existsSync(resultLedgerFileFor(brainPath, home)),
'a unique valid result records evidence and clears task scope');

const mcpB = presence('result-session-b', 1);
mcpB.start();
mcpB.sync({ phase: 'start', intent: 'independently verify retrieval metrics', files: ['b.txt'] });
const blocked = mcpB.sync({ phase: 'complete', results: [numericConflict] });
const blockedSelf = blocked.sessions.find((session) => session.id === 'result-session-b');
ok(blocked.isError === true
  && blocked.structured.status === 'needs-reconciliation'
  && blocked.structured.resultConflicts.some((conflict) => conflict.metric === 'recallAt5')
  && blockedSelf?.intent === 'independently verify retrieval metrics'
  && blockedSelf?.files?.includes('b.txt'),
'a peer numeric conflict fails closed and retains the submitting task scope');

const omittedRetry = mcpB.sync({ phase: 'complete' });
ok(omittedRetry.isError === true
  && omittedRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required')
  && omittedRetry.sessions.find((session) => session.id === 'result-session-b')?.files?.includes('b.txt'),
'a task cannot bypass a prior result conflict by retrying completion without its manifest');

const corroborating = makeManifest({ tag: 'corroborating' });
const resolved = mcpB.sync({ phase: 'complete', results: [corroborating] });
const resolvedSelf = resolved.sessions.find((session) => session.id === 'result-session-b');
ok(resolved.structured.status === 'complete'
  && resolved.structured.resultReconciliation?.status === 'corroborated'
  && resolved.structured.resultReconciliation?.receipt?.claims[0]?.compared
    ?.some((run) => run.runId === 'base' && /^[a-f0-9]{64}$/.test(run.manifestHash))
  && resolvedSelf?.intent === '' && resolvedSelf?.files?.length === 0,
'a corrected corroborating result returns a portable peer receipt and then clears scope');

const mcpG = presence('result-session-g', 6);
mcpG.start();
mcpG.sync({ phase: 'start', intent: 'compare a reranked experiment', files: ['g.txt'] });
const incomparableCompletion = mcpG.sync({ phase: 'complete', results: [reranked] });
ok(incomparableCompletion.isError === true
  && incomparableCompletion.structured.resultConflicts
    .some((conflict) => conflict.kind === 'configuration-fingerprint-mismatch')
  && incomparableCompletion.sessions.find((session) => session.id === 'result-session-g')?.files?.includes('g.txt'),
'an incomparable rerank configuration blocks completion and retains scope');

const mcpC = presence('result-session-c', 2);
mcpC.start();
mcpC.sync({ phase: 'start', intent: 'attempt incomplete evidence', files: ['c.txt'] });
const invalidCompletion = mcpC.sync({ phase: 'complete', results: [missingProvenance] });
const invalidSelf = invalidCompletion.sessions.find((session) => session.id === 'result-session-c');
ok(invalidCompletion.isError === true
  && invalidCompletion.structured.resultConflicts.some((conflict) => conflict.kind === 'invalid-result-manifest')
  && invalidSelf?.intent === 'attempt incomplete evidence' && invalidSelf?.files?.includes('c.txt'),
'invalid evidence fails closed before the completion touch and retains scope');

const mcpD = presence('result-session-d', 3);
mcpD.start();
mcpD.sync({ phase: 'start', intent: 'exercise lane contention', files: ['d.txt'] });
const presenceLane = laneFileFor(brainPath, home);
fs.writeFileSync(`${presenceLane}.lock`, 'held-by-test');
const laneBlocked = mcpD.sync({ phase: 'complete' });
fs.unlinkSync(`${presenceLane}.lock`);
const laneSelf = listActiveSessions({ brainPath, home, now: clock + 3 })
  .find((session) => session.id === 'result-session-d');
ok(laneBlocked.isError === true
  && laneBlocked.structured.status === 'needs-reconciliation'
  && laneBlocked.structured.resultConflicts.some((conflict) => conflict.kind === 'presence-lane-write-failed')
  && laneSelf?.intent === 'exercise lane contention' && laneSelf?.files?.includes('d.txt'),
'a failed completion lane write cannot report complete or erase the prior scope');

const mcpF = presence('result-session-f', 5);
mcpF.start();
mcpF.sync({ phase: 'start', intent: 'exercise result-ledger contention', files: ['f.txt'] });
const lockManifest = { ...makeManifest({ tag: 'ledger-lock' }), claimKey: 'brain.retrieval.lock-test' };
const resultLedger = resultLedgerFileFor(brainPath, home);
fs.writeFileSync(`${resultLedger}.lock`, 'held-by-test');
const ledgerBlocked = mcpF.sync({ phase: 'complete', results: [lockManifest] });
fs.unlinkSync(`${resultLedger}.lock`);
ok(ledgerBlocked.isError === true
  && ledgerBlocked.structured.resultConflicts.some((conflict) => conflict.kind === 'result-ledger-write-failed')
  && ledgerBlocked.sessions.find((session) => session.id === 'result-session-f')?.files?.includes('f.txt'),
'a contended result ledger fails closed before scope clearing');

const mcpE = presence('result-session-e', 4);
mcpE.start();
mcpE.sync({ phase: 'start', intent: 'legacy no-result task', files: ['e.txt'] });
const legacy = mcpE.sync({ phase: 'complete' });
ok(legacy.structured.status === 'complete' && legacy.isError !== true,
  'completion without a result claim preserves the existing backward-compatible path');

for (const client of [mcpA, mcpB, mcpC, mcpD, mcpE, mcpF, mcpG]) client.stop();
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] result-reconcile: all assertions passed');
if (failures) process.exitCode = 1;
