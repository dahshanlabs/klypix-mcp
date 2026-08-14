import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'klypix-worker.mjs');
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
ok(checkedBase.publicationEligible === false,
  'legacy schema-v1 evidence remains valid for reconciliation but is explicitly non-publication-eligible');

const prototypeKeyDetails = JSON.parse('{"safe":1,"__proto__":{"variant":"A"}}');
ok(sha256ResultValue(prototypeKeyDetails) !== sha256ResultValue({ safe: 1 }),
  'canonical provenance hashing preserves __proto__ as data instead of dropping it');

const unknownTopLevel = { ...base, publishable: true };
ok(!validateResultManifest(unknownTopLevel, { projectRoot: project }).ok,
  'unknown top-level fields fail closed at the schema-version boundary');

const unknownNested = structuredClone(base);
unknownNested.configuration.shippingDefault = true;
ok(!validateResultManifest(unknownNested, { projectRoot: project }).ok,
  'unknown nested manifest fields fail closed instead of disappearing during normalization');

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
const presence = (id, offset = 0, envExtra = {}) => createMcpPresence({
  server: fakeServer('codex'),
  initialVault: project,
  env: { KLYPIX_SESSION_ID: id, ...envExtra },
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

const mcpBRestart = presence('result-session-b', 7);
mcpBRestart.start();
const restartRetry = mcpBRestart.sync({ phase: 'complete' });
ok(restartRetry.isError === true
  && restartRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required')
  && restartRetry.sessions.find((session) => session.id === 'result-session-b')?.files?.includes('b.txt'),
'the pending evidence requirement survives a replacement worker process and still retains scope');

const corroborating = makeManifest({ tag: 'corroborating' });
const resolved = mcpBRestart.sync({ phase: 'complete', results: [corroborating] });
const resolvedSelf = resolved.sessions.find((session) => session.id === 'result-session-b');
ok(resolved.structured.status === 'complete'
  && resolved.structured.resultReconciliation?.status === 'corroborated'
  && resolved.structured.resultReconciliation?.receipt?.claims[0]?.compared
    ?.some((run) => run.runId === 'base' && /^[a-f0-9]{64}$/.test(run.manifestHash))
  && resolvedSelf?.intent === '' && resolvedSelf?.files?.length === 0,
'a corrected corroborating result returns a portable peer receipt and then clears scope');

// A provisional MCP identity may record a conflicting run before Codex request
// metadata reveals the exact thread id. Rekey retains the provisional id as an
// alias; the corrected exact-id retry must migrate/exclude that old run rather
// than treating its own evidence as an independent conflicting peer.
const provisionalId = 'mcp-result-provisional';
const exactResultId = '019ff22f-d710-7093-b76b-14f0b1fade00';
const rekeyedResults = createMcpPresence({
  server: fakeServer('codex'),
  initialVault: project,
  env: { KLYPIX_MCP_CONNECTION_ID: provisionalId },
  home,
  now: () => clock + 20,
  setIntervalFn: timer,
  clearIntervalFn() {},
});
rekeyedResults.start();
rekeyedResults.sync({ phase: 'start', intent: 'verify rekeyed result evidence', files: ['a.txt'] });
const provisionalConflict = rekeyedResults.sync({ phase: 'complete', results: [numericConflict] });
ok(provisionalConflict.isError === true
  && provisionalConflict.structured.resultConflicts.some((conflict) => conflict.metric === 'recallAt5'),
  'a provisional result conflict is durably recorded before exact identity adoption');
const adoptedResultId = rekeyedResults.adoptRequestIdentity({
  _meta: {
    threadId: exactResultId,
    'x-codex-turn-metadata': {
      session_id: exactResultId,
      thread_id: exactResultId,
      turn_id: 'result-rekey-turn',
    },
  },
}, { toolName: 'brain_sync', toolInput: { phase: 'complete' } });
ok(adoptedResultId.status === 'adopted' && rekeyedResults.id === exactResultId,
  'the provisional result session adopts the exact Codex thread id');
const correctedAfterRekey = rekeyedResults.sync({ phase: 'complete', results: [corroborating] });
const rekeyLedger = JSON.parse(fs.readFileSync(resultLedgerFileFor(brainPath, home), 'utf8'));
ok(correctedAfterRekey.isError !== true
  && correctedAfterRekey.structured.resultReconciliation?.status === 'corroborated'
  && !(correctedAfterRekey.structured.resultConflicts || [])
    .some((conflict) => conflict.peerRunId === 'numeric-conflict')
  && !rekeyLedger.entries.some((entry) => entry.sessionId === provisionalId),
  'post-rekey correction excludes and migrates its own provisional ledger evidence');
rekeyedResults.stop();

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

const mcpK = presence('result-session-k', 12);
mcpK.start();
mcpK.sync({ phase: 'start', intent: 'persist evidence through completion-lane contention', files: ['k.txt'] });
const validLaneManifest = { ...makeManifest({ tag: 'valid-lane-lock' }), claimKey: 'brain.retrieval.valid-lane-lock' };
fs.writeFileSync(`${presenceLane}.lock`, 'held-by-test');
const validLaneBlocked = mcpK.sync({ phase: 'complete', results: [validLaneManifest] });
fs.unlinkSync(`${presenceLane}.lock`);
const mcpKRestart = presence('result-session-k', 13);
mcpKRestart.start();
const validLaneRetry = mcpKRestart.sync({ phase: 'complete' });
ok(validLaneBlocked.isError === true
  && validLaneBlocked.structured.resultConflicts.some((conflict) => conflict.kind === 'presence-lane-write-failed')
  && validLaneRetry.isError === true
  && validLaneRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required'),
'a valid result whose presence completion write fails still requires evidence after worker restart');

const mcpE = presence('result-session-e', 4);
mcpE.start();
mcpE.sync({ phase: 'start', intent: 'legacy no-result task', files: ['e.txt'] });
// The intervening checkpoint marks a deliberate multi-step task; without it a
// result-less complete this close to start is downgraded by the turn-end guard
// (test/completion-guard.mjs) instead of exercising the legacy path.
mcpE.sync({ phase: 'checkpoint' });
const legacy = mcpE.sync({ phase: 'complete' });
ok(legacy.structured.status === 'complete' && legacy.isError !== true,
  'completion without a result claim preserves the existing backward-compatible path');

const mcpH = presence('result-session-h', 8);
mcpH.start();
mcpH.sync({ phase: 'start', intent: 'reject an empty result envelope', files: ['h.txt'] });
const emptyResults = mcpH.sync({ phase: 'complete', results: [] });
const emptyRetry = mcpH.sync({ phase: 'complete' });
ok(emptyResults.isError === true
  && emptyResults.structured.resultConflicts.some((conflict) => conflict.kind === 'invalid-result-submission')
  && emptyRetry.isError === true
  && emptyRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required'),
'an explicitly empty results array fails closed and cannot be retried as a legacy result-less task');

const mcpI = presence('result-session-i', 9);
mcpI.start();
mcpI.sync({ phase: 'start', intent: 'reject evidence on a checkpoint', files: ['i.txt'] });
const wrongPhase = mcpI.sync({ phase: 'checkpoint', results: [base] });
const wrongPhaseRetry = mcpI.sync({ phase: 'complete' });
ok(wrongPhase.isError === true
  && wrongPhase.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-wrong-phase')
  && wrongPhaseRetry.isError === true
  && wrongPhaseRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required'),
'results on a non-complete phase are rejected and create a durable evidence obligation');

const mcpJ = presence('result-session-j-before-rotation', 10, { KLYPIX_HOST_PID: '4242' });
mcpJ.start();
mcpJ.sync({ phase: 'start', intent: 'retain evidence across host session rotation', files: ['j.txt'] });
mcpJ.sync({ phase: 'complete', results: [missingProvenance] });
const rotatedId = 'result-session-j-after-rotation';
const switchedJ = mcpJ.adoptRequestIdentity({
  _meta: {
    threadId: rotatedId,
    'x-codex-turn-metadata': { session_id: rotatedId, thread_id: rotatedId, turn_id: 'result-turn-j' },
  },
});
mcpJ.sync({ phase: 'checkpoint' });
const mcpJBRestart = presence(rotatedId, 11);
mcpJBRestart.start();
const freshConversationCompletion = mcpJBRestart.sync({ phase: 'complete' });
const mcpJARestart = presence('result-session-j-before-rotation', 14);
mcpJARestart.start();
const priorConversationRetry = mcpJARestart.sync({ phase: 'complete' });
ok(switchedJ.status === 'switched-live-session'
  && freshConversationCompletion.isError !== true
  && freshConversationCompletion.structured.status === 'complete'
  && priorConversationRetry.isError === true
  && priorConversationRetry.structured.resultConflicts.some((conflict) => conflict.kind === 'result-manifest-required'),
'an exact request-id switch starts a clean conversation while the prior task evidence marker stays bound to A across restart');

// Production boundary regression: the real worker's public Zod schema must let
// unknown nested manifest fields reach the authoritative in-handler validator.
// Before this test, the SDK returned JSON-RPC -32602 first and the next call
// silently completed without evidence because no pending marker had been set.
const realHome = path.join(fixtureRoot, 'real-worker-home');
fs.mkdirSync(realHome, { recursive: true });
const realClient = new Client({ name: 'result-real-worker-test', version: '1.0.0' }, { capabilities: {} });
const realTransport = new StdioClientTransport({
  command: process.execPath,
  args: [workerPath, '--vault', project],
  cwd: project,
  env: {
    ...process.env,
    HOME: realHome,
    USERPROFILE: realHome,
    KLYPIX_SESSION_ID: 'result-real-worker',
    KLYPIX_AUTO_UPDATE: '0',
  },
  stderr: 'pipe',
});
try {
  await realClient.connect(realTransport);
  await realClient.callTool({
    name: 'brain_sync',
    arguments: { project, phase: 'checkpoint', intent: 'real worker malformed evidence', files: ['real.txt'], include_context: false },
  });
  const realInvalid = await realClient.callTool({
    name: 'brain_sync',
    arguments: { project, phase: 'complete', results: [unknownNested], include_context: false },
  });
  const realRetry = await realClient.callTool({
    name: 'brain_sync',
    arguments: { project, phase: 'complete', include_context: false },
  });
  ok(realInvalid.isError === true
    && realInvalid.structuredContent?.resultConflicts?.some((conflict) => conflict.kind === 'invalid-result-manifest')
    && realRetry.isError === true
    && realRetry.structuredContent?.resultConflicts?.some((conflict) => conflict.kind === 'result-manifest-required'),
  'the real worker routes unknown nested fields through fail-closed validation and persists the block');
} finally {
  await realClient.close().catch(() => {});
}

for (const client of [mcpA, mcpB, mcpBRestart, mcpC, mcpD, mcpE, mcpF, mcpG, mcpH, mcpI, mcpJ, mcpJARestart, mcpJBRestart, mcpK, mcpKRestart]) client.stop();
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] result-reconcile: all assertions passed');
if (failures) process.exitCode = 1;
