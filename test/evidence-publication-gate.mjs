import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareResultManifests,
  evaluationArtifactContract,
  evaluationArtifactJson,
  recordResultManifests,
  sha256ResultValue,
  validateResultManifest,
} from '../src/result-reconcile.mjs';
import {
  createPublicationReceipt,
  publicationEvidenceClaims,
  publicationReceiptHash,
  validateEvidenceOnlyGitDiff,
  verifyPublicationReceipt,
  verifyPublicationReceiptFile,
} from '../src/release-evidence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const fixtureRoot = path.join(os.tmpdir(), `klypix-evidence-gate-${process.pid}`);
const project = path.join(fixtureRoot, 'project');
const home = path.join(fixtureRoot, 'home');
fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(project, 'artifacts'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'publication evidence fixture');

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const gitCommit = 'a'.repeat(40);
const inputDetails = { corpus: 'fixture-v1', cases: 10 };
const configurationDetails = { evaluator: 'exact-v1', threshold: 0.9 };
const defaultMetrics = {
  accuracy: { value: 0.9, numerator: 9, count: 10, tolerance: 0, unit: 'ratio' },
};
const packageVersion = '1.67.0';
const evidencePrefix = `.release-evidence/v${packageVersion}/`;

const makeV2 = ({
  tag,
  claimKey = 'brain.evidence.publication-gate',
  runId = tag,
  metrics = defaultMetrics,
  evaluationName = 'shipping-evaluation',
  publicClaims,
  scopeFiles,
  scopeIntent,
} = {}) => {
  const reportPath = `${evidencePrefix}artifacts/${tag}.json`;
  const reportFile = path.join(project, reportPath);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const scope = {
    intent: scopeIntent || `verify evidence ${tag}`,
    files: [...(scopeFiles || [reportPath])].sort(),
  };
  const producer = 'test/evidence-publication-gate.mjs';
  const dirtyDigest = '0'.repeat(64);
  const evaluationMetrics = Object.fromEntries(
    Object.keys(metrics).sort().map((key) => [key, metrics[key]]),
  );
  fs.writeFileSync(reportFile, evaluationArtifactJson(evaluationArtifactContract({
    name: evaluationName,
    claimKey,
    scopeFingerprint: sha256ResultValue(scope),
    producer,
    runId,
    gitCommit,
    dirtyDigest,
    inputFingerprint: sha256ResultValue(inputDetails),
    configurationFingerprint: sha256ResultValue(configurationDetails),
    metrics: evaluationMetrics,
  })));
  const reportSha = hashFile(reportFile);
  const claims = publicClaims ?? [{
    key: 'brain.evidence.accuracy',
    metric: 'accuracy',
    value: metrics.accuracy.value,
    unit: 'ratio',
    statement: 'The verified fixture accuracy is 0.9.',
  }];
  return {
    schemaVersion: 2,
    claimKey,
    scope,
    report: { path: reportPath, sha256: reportSha },
    artifacts: [{ path: reportPath, sha256: reportSha, kind: 'evaluation-result' }],
    evaluations: [{
      name: evaluationName,
      artifact: { path: reportPath, sha256: reportSha },
      metricKeys: Object.keys(metrics),
    }],
    publicClaims: claims,
    provenance: {
      producer,
      runId,
      gitCommit,
      dirtyDigest,
    },
    input: { details: inputDetails, fingerprint: sha256ResultValue(inputDetails) },
    configuration: {
      details: configurationDetails,
      fingerprint: sha256ResultValue(configurationDetails),
    },
    metrics,
  };
};

const base = makeV2({ tag: 'base' });
const checkedBase = validateResultManifest(base, {
  projectRoot: project,
  declaredScope: base.scope,
  requireDeclaredScope: true,
});
ok(checkedBase.ok && checkedBase.publicationEligible === true,
  'schema-v2 verifies scope, artifacts, evaluations, and public claims as one publication-eligible unit');

const abbreviatedCommit = structuredClone(base);
abbreviatedCommit.provenance.gitCommit = 'a'.repeat(12);
ok(!validateResultManifest(abbreviatedCommit, { projectRoot: project }).ok,
  'schema-v2 rejects abbreviated or ref-like Git identities in portable evidence');

const unitlessMetric = structuredClone(base);
delete unitlessMetric.metrics.accuracy.unit;
ok(!validateResultManifest(unitlessMetric, { projectRoot: project }).ok,
  'schema-v2 requires an explicit unit on every evaluated metric');

const tooDeep = structuredClone(base);
let deepCursor = tooDeep.input.details;
for (let index = 0; index < 70; index++) {
  deepCursor.next = {};
  deepCursor = deepCursor.next;
}
tooDeep.input.fingerprint = '0'.repeat(64);
const tooDeepVerdict = validateResultManifest(tooDeep, { projectRoot: project });
ok(!tooDeepVerdict.ok && tooDeepVerdict.errors.some((error) => error.includes('depth limit')),
  'canonical evidence validation rejects adversarially deep structures before hashing');

const diffReceipt = `${evidencePrefix}receipt.json`;
const diffExpectations = `${evidencePrefix}expectations.json`;
const diffArtifact = `${evidencePrefix}artifacts/proof.json`;
const oid = 'b'.repeat(40);
const rawAdd = (file, status = 'A', newMode = '100644') => `:000000 ${newMode} ${'0'.repeat(40)} ${oid} ${status}\0${file}\0`;
const diffArtifactClaim = { path: diffArtifact, sha256: 'c'.repeat(64), kind: 'evaluation-result' };
const diffCommitted = [diffReceipt, diffExpectations, diffArtifact].map((file) => ({
  path: file,
  mode: '100644',
  oid,
  sha256: file === diffArtifact ? diffArtifactClaim.sha256 : 'd'.repeat(64),
}));
const validEvidenceDiff = validateEvidenceOnlyGitDiff(
  rawAdd(diffReceipt) + rawAdd(diffExpectations) + rawAdd(diffArtifact),
  {
    version: packageVersion,
    receiptPath: diffReceipt,
    expectationsPath: diffExpectations,
    expectedArtifacts: [diffArtifactClaim],
    committedFiles: diffCommitted,
  },
);
ok(validEvidenceDiff.ok, 'an immutable evidence bundle adds exactly its receipt, expectations, and artifacts as regular files');
const typeChangedEvidence = validateEvidenceOnlyGitDiff(
  rawAdd(diffReceipt, 'T') + rawAdd(diffExpectations) + rawAdd(diffArtifact),
  {
    version: packageVersion,
    receiptPath: diffReceipt,
    expectationsPath: diffExpectations,
    expectedArtifacts: [diffArtifactClaim],
    committedFiles: diffCommitted,
  },
);
ok(!typeChangedEvidence.ok
  && typeChangedEvidence.errors.some((error) => error.includes('forbidden git change type T')),
'a Git type/mode change is visible and blocked even when it targets the receipt path');
const renamedEvidence = validateEvidenceOnlyGitDiff(
  rawAdd(diffReceipt, 'R100') + rawAdd(diffExpectations) + rawAdd(diffArtifact),
  {
    version: packageVersion,
    receiptPath: diffReceipt,
    expectationsPath: diffExpectations,
    expectedArtifacts: [diffArtifactClaim],
    committedFiles: diffCommitted,
  },
);
ok(!renamedEvidence.ok
  && renamedEvidence.errors.some((error) => error.includes('forbidden git change type R100')),
'renames cannot masquerade as evidence-only additions');
const caseChangedEvidence = validateEvidenceOnlyGitDiff(
  rawAdd(diffReceipt.replace('receipt.json', 'Receipt.json')) + rawAdd(diffExpectations) + rawAdd(diffArtifact),
  {
    version: packageVersion,
    receiptPath: diffReceipt,
    expectationsPath: diffExpectations,
    expectedArtifacts: [diffArtifactClaim],
    committedFiles: diffCommitted,
  },
);
ok(!caseChangedEvidence.ok
  && caseChangedEvidence.errors.some((error) => error.includes('outside the exact evidence bundle')),
'evidence-only raw diff paths are exact-case, including on case-insensitive worktrees');
const executableEvidence = validateEvidenceOnlyGitDiff(
  rawAdd(diffReceipt, 'A', '100755') + rawAdd(diffExpectations) + rawAdd(diffArtifact),
  {
    version: packageVersion,
    receiptPath: diffReceipt,
    expectationsPath: diffExpectations,
    expectedArtifacts: [diffArtifactClaim],
    committedFiles: diffCommitted,
  },
);
ok(!executableEvidence.ok
  && executableEvidence.errors.some((error) => error.includes('not a regular 100644 file')),
'executable, symlink, and other non-100644 evidence modes are blocked');

const scopeMismatch = validateResultManifest(base, {
  projectRoot: project,
  declaredScope: { intent: base.scope.intent, files: [`${evidencePrefix}artifacts/not-the-report.json`] },
  requireDeclaredScope: true,
});
ok(!scopeMismatch.ok && scopeMismatch.errors.some((error) => error.includes('scope.files')),
  'active task scope mismatch fails closed');

const missingActiveScope = validateResultManifest(base, {
  projectRoot: project,
  requireDeclaredScope: true,
});
ok(!missingActiveScope.ok && missingActiveScope.errors.some((error) => error.includes('active declared task scope')),
  'schema-v2 cannot be accepted at task completion without the actual active scope');

const badHash = structuredClone(base);
badHash.artifacts[0].sha256 = 'f'.repeat(64);
badHash.evaluations[0].artifact.sha256 = 'f'.repeat(64);
ok(!validateResultManifest(badHash, { projectRoot: project }).ok,
  'an artifact hash mismatch is rejected even when internal declarations agree');

const semanticTamper = makeV2({ tag: 'semantic-tamper' });
const semanticTamperFile = path.join(project, semanticTamper.report.path);
const forgedMetrics = {
  accuracy: { value: 0.1, numerator: 1, count: 10, tolerance: 0, unit: 'ratio' },
};
fs.writeFileSync(semanticTamperFile, evaluationArtifactJson(evaluationArtifactContract({
  name: semanticTamper.evaluations[0].name,
  claimKey: semanticTamper.claimKey,
  scopeFingerprint: sha256ResultValue(semanticTamper.scope),
  producer: semanticTamper.provenance.producer,
  runId: semanticTamper.provenance.runId,
  gitCommit,
  dirtyDigest: semanticTamper.provenance.dirtyDigest,
  inputFingerprint: semanticTamper.input.fingerprint,
  configurationFingerprint: semanticTamper.configuration.fingerprint,
  metrics: forgedMetrics,
})));
const semanticTamperHash = hashFile(semanticTamperFile);
semanticTamper.report.sha256 = semanticTamperHash;
semanticTamper.artifacts[0].sha256 = semanticTamperHash;
semanticTamper.evaluations[0].artifact.sha256 = semanticTamperHash;
const semanticTamperVerdict = validateResultManifest(semanticTamper, { projectRoot: project });
ok(!semanticTamperVerdict.ok
  && semanticTamperVerdict.errors.some((error) => error.includes('does not exactly bind')),
'a forged artifact with a correct SHA but different metric values fails the semantic evaluation contract');

const oversizedEvaluation = makeV2({ tag: 'oversized-evaluation' });
const oversizedFile = path.join(project, oversizedEvaluation.report.path);
fs.writeFileSync(oversizedFile, Buffer.alloc((1024 * 1024) + 1, 0x20));
const oversizedHash = hashFile(oversizedFile);
oversizedEvaluation.report.sha256 = oversizedHash;
oversizedEvaluation.artifacts[0].sha256 = oversizedHash;
oversizedEvaluation.evaluations[0].artifact.sha256 = oversizedHash;
const oversizedVerdict = validateResultManifest(oversizedEvaluation, { projectRoot: project });
ok(!oversizedVerdict.ok && oversizedVerdict.errors.some((error) => error.includes('1 MiB contract limit')),
  'evaluation artifact reads are bounded before semantic parsing or comparison');

const missingArtifact = structuredClone(base);
missingArtifact.artifacts[0].path = `${evidencePrefix}artifacts/missing.json`;
missingArtifact.evaluations[0].artifact.path = `${evidencePrefix}artifacts/missing.json`;
missingArtifact.scope.files = [`${evidencePrefix}artifacts/missing.json`];
ok(!validateResultManifest(missingArtifact, { projectRoot: project }).ok,
  'a missing material artifact fails verification');

const escapingArtifact = structuredClone(base);
escapingArtifact.artifacts[0].path = '../outside.json';
escapingArtifact.evaluations[0].artifact.path = '../outside.json';
escapingArtifact.scope.files = ['../outside.json'];
ok(!validateResultManifest(escapingArtifact, { projectRoot: project }).ok,
  'artifact and scope paths cannot escape the project root');

const duplicateArtifact = structuredClone(base);
duplicateArtifact.artifacts.push({ ...duplicateArtifact.artifacts[0] });
ok(!validateResultManifest(duplicateArtifact, { projectRoot: project }).ok,
  'duplicate artifact paths fail closed');

const badEvaluation = structuredClone(base);
badEvaluation.evaluations[0].metricKeys = ['undeclaredMetric'];
ok(!validateResultManifest(badEvaluation, { projectRoot: project }).ok,
  'evaluation outputs must bind only declared metrics and cover the complete metric set');

const badPublicClaim = structuredClone(base);
badPublicClaim.publicClaims[0].value = 0.8;
ok(!validateResultManifest(badPublicClaim, { projectRoot: project }).ok,
  'a public metric claim must exactly match its verified metric');

const badPublicUnit = structuredClone(base);
badPublicUnit.publicClaims[0].unit = 'percent';
ok(!validateResultManifest(badPublicUnit, { projectRoot: project }).ok,
  'a public metric claim unit must exactly match the evaluated metric unit');

let symlinkExercised = false;
try {
  const targetPath = path.join(project, evidencePrefix, 'artifacts', 'symlink-target.json');
  const linkPath = path.join(project, evidencePrefix, 'artifacts', 'symlink-report.json');
  fs.writeFileSync(targetPath, '{"safe":true}');
  fs.symlinkSync(targetPath, linkPath, 'file');
  const linked = makeV2({ tag: 'linked-template' });
  const linkedSha = hashFile(targetPath);
  const linkedPath = `${evidencePrefix}artifacts/symlink-report.json`;
  linked.scope.files = [linkedPath];
  linked.report = { path: linkedPath, sha256: linkedSha };
  linked.artifacts = [{ path: linkedPath, sha256: linkedSha, kind: 'evaluation-result' }];
  linked.evaluations[0].artifact = { path: linkedPath, sha256: linkedSha };
  const linkedResult = validateResultManifest(linked, { projectRoot: project });
  symlinkExercised = true;
  ok(!linkedResult.ok && linkedResult.errors.some((error) => error.includes('symbolic link')),
    'artifact verification rejects symbolic links instead of trusting their target');
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
  console.log('[ok] symbolic-link adversarial case skipped because this Windows account cannot create test symlinks');
}

const alternateEvaluation = makeV2({ tag: 'alternate-eval', evaluationName: 'different-evaluation' });
const checkedAlternate = validateResultManifest(alternateEvaluation, { projectRoot: project });
ok(compareResultManifests(checkedBase.manifest, checkedAlternate.manifest).status === 'incomparable',
  'two results with different evaluation contracts are incomparable, not silently merged');

const toleranceScopeFiles = [`${evidencePrefix}artifacts/tolerance.json`];
const toleranceA = makeV2({
  tag: 'tolerance',
  runId: 'tolerance-a',
  metrics: { score: { value: 0.9, count: 100, tolerance: 0.02, unit: 'ratio' } },
  publicClaims: [],
  scopeFiles: toleranceScopeFiles,
  scopeIntent: 'compare tolerance-bound evaluations',
});
const checkedToleranceA = validateResultManifest(toleranceA, { projectRoot: project });
const toleranceB = makeV2({
  tag: 'tolerance',
  runId: 'tolerance-b',
  metrics: { score: { value: 0.91, count: 100, tolerance: 0.02, unit: 'ratio' } },
  publicClaims: [],
  scopeFiles: toleranceScopeFiles,
  scopeIntent: 'compare tolerance-bound evaluations',
});
const checkedToleranceB = validateResultManifest(toleranceB, { projectRoot: project });
ok(checkedToleranceA.ok && checkedToleranceB.ok
  && compareResultManifests(checkedToleranceA.manifest, checkedToleranceB.manifest).status === 'corroborated',
'evaluation integrity fingerprints bind each actual value without making within-tolerance results incomparable');

const differentPublicMetrics = {
  accuracy: { value: 0.8, numerator: 8, count: 10, tolerance: 0, unit: 'ratio' },
};
const alternatePublic = makeV2({
  tag: 'alternate-public',
  metrics: differentPublicMetrics,
  publicClaims: [{
    key: 'brain.evidence.accuracy',
    metric: 'accuracy',
    value: 0.8,
    unit: 'ratio',
    statement: 'The verified fixture accuracy is 0.8.',
  }],
});
const checkedAlternatePublic = validateResultManifest(alternatePublic, { projectRoot: project });
const publicComparison = compareResultManifests(checkedBase.manifest, checkedAlternatePublic.manifest);
ok(['conflict', 'incomparable'].includes(publicComparison.status)
  && publicComparison.conflicts.some((conflict) => conflict.kind === 'public-claim-mismatch'),
'contradictory public metric claims are explicit blocking conflicts');

const peerA = makeV2({ tag: 'peer-a', claimKey: 'brain.evidence.peer-artifact', runId: 'same-run' });
const peerB = makeV2({ tag: 'peer-b', claimKey: 'brain.evidence.peer-artifact', runId: 'same-run' });
const firstPeer = recordResultManifests({
  brainPath,
  projectRoot: project,
  sessionId: 'evidence-peer-a',
  declaredScope: peerA.scope,
  results: [peerA],
  home,
  now: 2_100_000_000_000,
});
const secondPeer = recordResultManifests({
  brainPath,
  projectRoot: project,
  sessionId: 'evidence-peer-b',
  declaredScope: peerB.scope,
  results: [peerB],
  home,
  now: 2_100_000_000_001,
});
ok(firstPeer.ok && !secondPeer.ok
  && secondPeer.conflicts.some((conflict) => conflict.kind === 'run-artifact-mismatch'),
'a peer result cannot silently replace conflicting artifacts for the same claim and run');

const releaseScopeFiles = [
  `${evidencePrefix}artifacts/release.json`,
  `${evidencePrefix}artifacts/release-peer.json`,
];
const releaseScopeIntent = 'independently verify release evidence';
const releaseManifest = makeV2({
  tag: 'release',
  claimKey: 'brain.evidence.release',
  scopeFiles: releaseScopeFiles,
  scopeIntent: releaseScopeIntent,
});
const releaseResult = recordResultManifests({
  brainPath,
  projectRoot: project,
  sessionId: 'release-evidence-session',
  declaredScope: releaseManifest.scope,
  results: [releaseManifest],
  home,
  now: 2_100_000_000_100,
});
const checkedRelease = validateResultManifest(releaseManifest, { projectRoot: project });
const created = createPublicationReceipt({
  projectRoot: project,
  packageName: 'klypix-mcp',
  version: '1.67.0',
  gitCommit,
  resultReceipt: releaseResult.receipt,
  resultReceiptHash: releaseResult.receiptHash,
  manifests: [{ manifest: checkedRelease.manifest, manifestHash: checkedRelease.manifestHash }],
  generatedAt: 2_100_000_000_200,
});
ok(releaseResult.ok && releaseResult.receipt?.publicationEligible === true && created.ok,
  'a verified v2 completion produces a commit-bindable publication receipt');

const expected = publicationEvidenceClaims([checkedRelease.manifest]);
const receiptRelative = `${evidencePrefix}receipt.json`;
const trackedPublicationFiles = [receiptRelative, ...expected.artifacts.map((artifact) => artifact.path)];
const receiptDir = path.join(project, evidencePrefix);
fs.mkdirSync(receiptDir, { recursive: true });
const receiptFile = path.join(receiptDir, 'receipt.json');
fs.writeFileSync(receiptFile, JSON.stringify(created.receipt, null, 2));
const committedReceiptSha256 = hashFile(receiptFile);
const eligible = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(eligible.ok && eligible.status === 'eligible',
  'publication eligibility requires independent commit, version, artifact, public-claim, and tracked-receipt inputs');

const corroboratingManifest = makeV2({
  tag: 'release-peer',
  claimKey: 'brain.evidence.release',
  runId: 'release-peer-run',
  scopeFiles: releaseScopeFiles,
  scopeIntent: releaseScopeIntent,
});
const corroboratingResult = recordResultManifests({
  brainPath,
  projectRoot: project,
  sessionId: 'release-evidence-peer-session',
  declaredScope: corroboratingManifest.scope,
  results: [corroboratingManifest],
  home,
  now: 2_100_000_000_300,
});
const checkedCorroborating = validateResultManifest(corroboratingManifest, { projectRoot: project });
const corroboratedCreated = createPublicationReceipt({
  projectRoot: project,
  packageName: 'klypix-mcp',
  version: '1.67.0',
  gitCommit,
  resultReceipt: corroboratingResult.receipt,
  resultReceiptHash: corroboratingResult.receiptHash,
  manifests: [{
    manifest: checkedCorroborating.manifest,
    manifestHash: checkedCorroborating.manifestHash,
  }],
  generatedAt: 2_100_000_000_400,
});
const corroboratedFile = receiptFile;
fs.writeFileSync(corroboratedFile, JSON.stringify(corroboratedCreated.receipt, null, 2));
const corroboratedFileHash = hashFile(corroboratedFile);
const corroboratedExpected = publicationEvidenceClaims([
  checkedRelease.manifest,
  checkedCorroborating.manifest,
]);
const corroboratedTracked = [receiptRelative, ...corroboratedExpected.artifacts.map((artifact) => artifact.path)];
const corroboratedVerdict = verifyPublicationReceipt(corroboratedCreated.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: corroboratedExpected.artifacts,
  expectedPublicClaims: corroboratedExpected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: corroboratedTracked,
  committedReceiptSha256: corroboratedFileHash,
  requireCorroborated: true,
});
ok(corroboratingResult.status === 'corroborated'
  && corroboratedCreated.ok && corroboratedVerdict.ok,
'requireCorroborated accepts a distinct peer run only after validating its embedded manifest and every summary binding');

const forgedEmptyPeer = structuredClone(corroboratedCreated.receipt);
forgedEmptyPeer.resultReceipt.claims[0].compared = [{}];
forgedEmptyPeer.resultReceiptHash = sha256ResultValue(forgedEmptyPeer.resultReceipt);
forgedEmptyPeer.receiptHash = publicationReceiptHash(forgedEmptyPeer);
fs.writeFileSync(corroboratedFile, JSON.stringify(forgedEmptyPeer, null, 2));
const forgedEmptyVerdict = verifyPublicationReceipt(forgedEmptyPeer, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: corroboratedExpected.artifacts,
  expectedPublicClaims: corroboratedExpected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: corroboratedTracked,
  committedReceiptSha256: hashFile(corroboratedFile),
  requireCorroborated: true,
});
ok(!forgedEmptyVerdict.ok
  && forgedEmptyVerdict.errors.some((error) => error.includes('complete peer binding object')),
'requireCorroborated rejects a hash-consistent receipt containing a forged empty peer binding');

const excessivePeers = structuredClone(corroboratedCreated.receipt);
excessivePeers.resultReceipt.claims[0].compared = Array.from(
  { length: 33 },
  () => structuredClone(corroboratedCreated.receipt.resultReceipt.claims[0].compared[0]),
);
excessivePeers.resultReceiptHash = sha256ResultValue(excessivePeers.resultReceipt);
excessivePeers.receiptHash = publicationReceiptHash(excessivePeers);
fs.writeFileSync(corroboratedFile, JSON.stringify(excessivePeers, null, 2));
const excessivePeersVerdict = verifyPublicationReceipt(excessivePeers, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: packageVersion,
  expectedGitCommit: gitCommit,
  expectedArtifacts: corroboratedExpected.artifacts,
  expectedPublicClaims: corroboratedExpected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: corroboratedTracked,
  committedReceiptSha256: hashFile(corroboratedFile),
  requireCorroborated: true,
});
ok(!excessivePeersVerdict.ok
  && excessivePeersVerdict.errors.some((error) => error.includes('exceeds 32 peers')),
'corroboration receipt validation bounds peer evidence before expanding embedded manifests');

const inconsistentStatus = structuredClone(corroboratedCreated.receipt);
inconsistentStatus.resultReceipt.claims[0].status = 'unique';
inconsistentStatus.resultReceiptHash = sha256ResultValue(inconsistentStatus.resultReceipt);
inconsistentStatus.receiptHash = publicationReceiptHash(inconsistentStatus);
fs.writeFileSync(corroboratedFile, JSON.stringify(inconsistentStatus, null, 2));
const inconsistentStatusVerdict = verifyPublicationReceipt(inconsistentStatus, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: corroboratedExpected.artifacts,
  expectedPublicClaims: corroboratedExpected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: corroboratedTracked,
  committedReceiptSha256: hashFile(corroboratedFile),
  requireCorroborated: true,
});
ok(!inconsistentStatusVerdict.ok
  && inconsistentStatusVerdict.errors.some((error) => error.includes('inconsistent with per-claim status')),
'requireCorroborated rejects top-level corroborated status when the per-claim status is inconsistent');

fs.writeFileSync(receiptFile, JSON.stringify(created.receipt, null, 2));

const wrongCommit = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: 'b'.repeat(40),
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(!wrongCommit.ok && wrongCommit.errors.some((error) => error.includes('gitCommit')),
  'publication is blocked when the checked-out commit differs from the receipt');

const wrongArtifactExpectations = structuredClone(expected.artifacts);
wrongArtifactExpectations[0].sha256 = 'f'.repeat(64);
const wrongArtifact = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: wrongArtifactExpectations,
  expectedPublicClaims: expected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(!wrongArtifact.ok && wrongArtifact.errors.some((error) => error.includes('artifact claims')),
  'publication is blocked when independently expected artifact claims differ');

const wrongPublicExpectations = structuredClone(expected.publicClaims);
wrongPublicExpectations[0].statement = 'A different public statement.';
const wrongPublic = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: wrongPublicExpectations,
  receiptPath: receiptRelative,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(!wrongPublic.ok && wrongPublic.errors.some((error) => error.includes('public metric claims')),
  'publication is blocked when independently expected public wording differs');

const untracked = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: [],
  committedReceiptSha256,
});
ok(!untracked.ok && untracked.errors.some((error) => error.includes('not tracked')),
  'an untracked receipt cannot authorize publication');

const untrackedArtifact = verifyPublicationReceipt(created.receipt, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  receiptPath: receiptRelative,
  trackedFiles: [receiptRelative],
  committedReceiptSha256,
});
ok(!untrackedArtifact.ok && untrackedArtifact.errors.some((error) => error.includes('artifact(s) are not tracked')),
  'an untracked evaluation artifact cannot authorize publication');

const fileVerdict = verifyPublicationReceiptFile(receiptFile, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(fileVerdict.ok, 'the file API verifies a checked-out, tracked receipt without trusting its path or contents');

fs.writeFileSync(receiptFile, `${JSON.stringify(created.receipt, null, 2)}\n`);
const dirtyReceiptVerdict = verifyPublicationReceiptFile(receiptFile, {
  projectRoot: project,
  expectedPackageName: 'klypix-mcp',
  expectedVersion: '1.67.0',
  expectedGitCommit: gitCommit,
  expectedArtifacts: expected.artifacts,
  expectedPublicClaims: expected.publicClaims,
  trackedFiles: trackedPublicationFiles,
  committedReceiptSha256,
});
ok(!dirtyReceiptVerdict.ok
  && dirtyReceiptVerdict.errors.some((error) => error.includes('differs from the checked-out commit')),
'a worktree-modified receipt cannot authorize publication even when parsed JSON is semantically identical');

const legacy = structuredClone(releaseManifest);
legacy.schemaVersion = 1;
delete legacy.scope;
delete legacy.artifacts;
delete legacy.evaluations;
delete legacy.publicClaims;
const checkedLegacy = validateResultManifest(legacy, { projectRoot: project });
const legacyReceipt = createPublicationReceipt({
  projectRoot: project,
  packageName: 'klypix-mcp',
  version: '1.67.0',
  gitCommit,
  resultReceipt: releaseResult.receipt,
  resultReceiptHash: releaseResult.receiptHash,
  manifests: [{ manifest: checkedLegacy.manifest, manifestHash: checkedLegacy.manifestHash }],
});
ok(checkedLegacy.ok && !checkedLegacy.publicationEligible && !legacyReceipt.ok,
  'legacy schema-v1 results remain reconcilable but can never open the publication gate');

if (!symlinkExercised) {
  // The permission-dependent branch printed its own successful skip line.
}
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] evidence-publication-gate: all assertions passed');
if (failures) process.exitCode = 1;
