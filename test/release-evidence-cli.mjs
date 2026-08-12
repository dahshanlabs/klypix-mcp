import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  evaluationArtifactContract,
  evaluationArtifactJson,
  recordResultManifests,
  sha256ResultValue,
  validateResultManifest,
} from '../src/result-reconcile.mjs';
import {
  createPublicationReceipt,
  publicationEvidenceClaims,
} from '../src/release-evidence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(testDir, '..');
const fixtureRoot = path.join(os.tmpdir(), `klypix-release-evidence-cli-${process.pid}`);
const project = path.join(fixtureRoot, 'project');
const home = path.join(fixtureRoot, 'home');
const version = '1.67.0';
const bundlePrefix = `.release-evidence/v${version}/`;

const git = (args) => String(execFileSync('git', [
  '-c', 'user.name=KLYPIX Release Gate Test',
  '-c', 'user.email=release-gate-test@klypix.invalid',
  ...args,
], {
  cwd: project,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})).trim();

const runVerifier = (sourceCommit) => spawnSync(process.execPath, [
  path.join(project, 'scripts', 'verify-release-evidence.mjs'),
  '--project', project,
  '--receipt', `${bundlePrefix}receipt.json`,
  '--expectations', `${bundlePrefix}expectations.json`,
  '--package', 'klypix-mcp',
  '--version', version,
  '--git-commit', sourceCommit,
  '--require-corroborated',
], {
  cwd: project,
  encoding: 'utf8',
  windowsHide: true,
});

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

try {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'src', 'agent-presence.mjs'), path.join(project, 'src', 'agent-presence.mjs'));
  fs.copyFileSync(path.join(sourceRoot, 'src', 'result-reconcile.mjs'), path.join(project, 'src', 'result-reconcile.mjs'));
  fs.copyFileSync(path.join(sourceRoot, 'src', 'release-evidence.mjs'), path.join(project, 'src', 'release-evidence.mjs'));
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts', 'verify-release-evidence.mjs'),
    path.join(project, 'scripts', 'verify-release-evidence.mjs'),
  );
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'klypix-mcp',
    version,
    type: 'module',
  }, null, 2));
  fs.writeFileSync(path.join(project, 'brain.klypix'), 'release evidence CLI integration fixture');

  git(['init', '--quiet']);
  git(['add', '--', 'package.json', 'brain.klypix', 'src', 'scripts']);
  git(['commit', '--quiet', '-m', 'source']);
  const sourceCommit = git(['rev-parse', 'HEAD']).toLowerCase();

  const scope = {
    intent: 'independently verify the committed release evidence CLI',
    files: [
      `${bundlePrefix}artifacts/run-a.json`,
      `${bundlePrefix}artifacts/run-b.json`,
    ],
  };
  const inputDetails = { suite: 'release-evidence-cli', cases: 1 };
  const configurationDetails = { command: 'node scripts/verify-release-evidence.mjs', policy: 'corroborated' };
  const metrics = {
    gate_pass: { value: 1, numerator: 1, count: 1, tolerance: 0, unit: 'ratio' },
  };
  const makeManifest = (tag) => {
    const reportPath = `${bundlePrefix}artifacts/${tag}.json`;
    const reportFile = path.join(project, ...reportPath.split('/'));
    const provenance = {
      producer: 'test/release-evidence-cli.mjs',
      runId: tag,
      gitCommit: sourceCommit,
      dirtyDigest: '0'.repeat(64),
    };
    const evaluation = evaluationArtifactContract({
      name: 'release-gate-integration',
      claimKey: 'brain.release-evidence.cli',
      scopeFingerprint: sha256ResultValue(scope),
      producer: provenance.producer,
      runId: provenance.runId,
      gitCommit: provenance.gitCommit,
      dirtyDigest: provenance.dirtyDigest,
      inputFingerprint: sha256ResultValue(inputDetails),
      configurationFingerprint: sha256ResultValue(configurationDetails),
      metrics,
    });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, evaluationArtifactJson(evaluation));
    const reportSha = hashFile(reportFile);
    return {
      schemaVersion: 2,
      claimKey: 'brain.release-evidence.cli',
      scope,
      report: { path: reportPath, sha256: reportSha },
      artifacts: [{ path: reportPath, sha256: reportSha, kind: 'evaluation-result' }],
      evaluations: [{
        name: 'release-gate-integration',
        artifact: { path: reportPath, sha256: reportSha },
        metricKeys: ['gate_pass'],
      }],
      publicClaims: [],
      provenance,
      input: { details: inputDetails, fingerprint: sha256ResultValue(inputDetails) },
      configuration: {
        details: configurationDetails,
        fingerprint: sha256ResultValue(configurationDetails),
      },
      metrics,
    };
  };

  const firstManifest = makeManifest('run-a');
  const secondManifest = makeManifest('run-b');
  const brainPath = path.join(project, 'brain.klypix');
  const first = recordResultManifests({
    brainPath,
    projectRoot: project,
    sessionId: 'release-cli-a',
    declaredScope: scope,
    results: [firstManifest],
    home,
    now: 2_100_000_001_000,
  });
  const second = recordResultManifests({
    brainPath,
    projectRoot: project,
    sessionId: 'release-cli-b',
    declaredScope: scope,
    results: [secondManifest],
    home,
    now: 2_100_000_001_100,
  });
  const checkedFirst = validateResultManifest(firstManifest, { projectRoot: project });
  const checkedSecond = validateResultManifest(secondManifest, { projectRoot: project });
  const created = createPublicationReceipt({
    projectRoot: project,
    packageName: 'klypix-mcp',
    version,
    gitCommit: sourceCommit,
    resultReceipt: second.receipt,
    resultReceiptHash: second.receiptHash,
    manifests: [{ manifest: checkedSecond.manifest, manifestHash: checkedSecond.manifestHash }],
    generatedAt: 2_100_000_001_200,
  });
  const expected = publicationEvidenceClaims([checkedFirst.manifest, checkedSecond.manifest]);
  const bundleDir = path.join(project, ...bundlePrefix.split('/').filter(Boolean));
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'receipt.json'), JSON.stringify(created.receipt, null, 2));
  fs.writeFileSync(path.join(bundleDir, 'expectations.json'), JSON.stringify({
    artifacts: expected.artifacts,
    publicClaims: expected.publicClaims,
  }, null, 2));
  git(['add', '--', bundlePrefix]);
  git(['commit', '--quiet', '-m', 'release evidence']);

  const eligible = runVerifier(sourceCommit);
  let eligibleOutput = null;
  try { eligibleOutput = JSON.parse(eligible.stdout); } catch { /* asserted below */ }
  if (eligible.status !== 0) console.error(eligible.stderr || eligible.stdout);
  ok(first.ok && second.ok && second.status === 'corroborated' && created.ok,
    'the integration fixture produces peer-corroborated schema-v2 release evidence');
  ok(eligible.status === 0 && eligibleOutput?.ok === true && eligibleOutput?.status === 'eligible',
    'the real verifier accepts exactly one closed evidence-only commit over its source parent');

  fs.writeFileSync(path.join(bundleDir, 'undeclared.txt'), 'not declared by expectations');
  git(['add', '--', `${bundlePrefix}undeclared.txt`]);
  git(['commit', '--quiet', '--amend', '--no-edit']);
  const openBundle = runVerifier(sourceCommit);
  if (openBundle.status === 0) console.error(openBundle.stdout);
  ok(openBundle.status !== 0 && openBundle.stderr.includes('unexpected committed evidence bundle file'),
    'the real verifier rejects undeclared files already committed inside the version bundle');

  git(['commit', '--quiet', '--allow-empty', '-m', 'extra evidence layer']);
  const indirectTarget = runVerifier(sourceCommit);
  if (indirectTarget.status === 0) console.error(indirectTarget.stdout);
  ok(indirectTarget.status !== 0 && indirectTarget.stderr.includes('sole parent'),
    'the real verifier requires the target source commit to be the sole direct parent');
} catch (error) {
  console.error(error?.stack || error);
  failures++;
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n[x] release-evidence-cli: ${failures} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\n[ok] release-evidence-cli: all assertions passed');
}
