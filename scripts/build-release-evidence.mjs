#!/usr/bin/env node
// Build the corroborated release-evidence bundle for the CURRENT version.
//
// The publish gate refuses a release whose evidence is a single unique run, so
// every version needs two INDEPENDENT qualification runs bound to one claim.
// Until now that bundle was hand-assembled per release, which is exactly the
// kind of step that is done slightly differently each time and then defended by
// nobody. This produces it mechanically from real `npm test` executions.
//
// Usage (from a CLEAN tree, on the source commit):
//   node scripts/build-release-evidence.mjs            # runs the suite twice
//   node scripts/build-release-evidence.mjs --runs 2   # explicit
//
// Then commit ONLY .release-evidence/v<version>/ as the evidence commit, and
// verify it exactly as the workflow will:
//   node scripts/verify-release-evidence.mjs --project . \
//     --receipt .release-evidence/v<v>/receipt.json \
//     --expectations .release-evidence/v<v>/expectations.json \
//     --package klypix-mcp --version <v> --git-commit <source> --require-corroborated
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createPublicationReceipt,
  publicationEvidenceClaims,
} from '../src/release-evidence.mjs';
import {
  evaluationArtifactContract,
  evaluationArtifactJson,
  recordResultManifests,
  sha256ResultValue,
  validateResultManifest,
} from '../src/result-reconcile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const BUNDLE = `.release-evidence/v${VERSION}/`;
const bundleDir = path.join(ROOT, '.release-evidence', `v${VERSION}`);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ---- preconditions ------------------------------------------------------
// The receipt binds a specific source commit. A dirty tree means the bytes
// that were tested are not the bytes that will be tagged, and the verifier
// rejects it anyway — fail here with a clearer message.
const status = git('status', '--porcelain');
const strayBundle = status.split('\n').filter(Boolean).every((l) => l.slice(3).startsWith('.release-evidence/'));
if (status && !strayBundle) die(`working tree is dirty — commit the source first:\n${status}`);

const SOURCE_COMMIT = git('rev-parse', 'HEAD');
if (fs.existsSync(bundleDir) && fs.readdirSync(bundleDir).length && !process.argv.includes('--force')) {
  die(`${BUNDLE} already exists. Delete it or pass --force to rebuild.`);
}

// A clean tree has no dirt; hash the (empty) porcelain output rather than
// hard-coding zeros, so a deliberate --force rebuild over a dirty tree still
// records a digest that actually distinguishes it.
const dirtyDigest = crypto.createHash('sha256').update(status || '').digest('hex');
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(2, Number(process.argv[runsArg + 1]) || 2) : 2;

// ---- the qualification runs --------------------------------------------
// Each run is a real, complete `npm test`. Corroboration means two independent
// executions agreed — not one execution copied twice.
function qualify(tag) {
  process.stderr.write(`  ${tag}: running the full suite…\n`);
  const started = Date.now();
  const res = spawnSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const passed = res.status === 0;
  // The suite chain is `node test/a.mjs && node test/b.mjs && …`; its length is
  // the number of suites that had to pass for exit 0.
  const suites = String(pkg.scripts.test || '').split('&&').filter((s) => /node\s+test\//.test(s)).length;
  process.stderr.write(`  ${tag}: ${passed ? 'PASS' : 'FAIL'} · ${suites} suites · ${Math.round((Date.now() - started) / 1000)}s\n`);
  if (!passed) {
    fs.writeFileSync(path.join(os.tmpdir(), `klypix-release-${tag}.log`), out);
    die(`${tag} failed — evidence must never be built from a red suite. Log: ${path.join(os.tmpdir(), `klypix-release-${tag}.log`)}`);
  }
  return { suites };
}

const claimKey = `brain.core.v${VERSION}.release`;
const scope = {
  intent: `qualify klypix-mcp v${VERSION} for publication`,
  files: Array.from({ length: RUNS }, (_, i) => `${BUNDLE}artifacts/run-${String.fromCharCode(97 + i)}.json`),
};
const scopeFingerprint = sha256ResultValue(scope);
const inputDetails = { suite: 'npm test (full chain)', cases: 1 };
const configurationDetails = { command: 'npm test', policy: 'corroborated', node: process.version.replace(/^v/, '') };
const inputFingerprint = sha256ResultValue(inputDetails);
const configurationFingerprint = sha256ResultValue(configurationDetails);

fs.mkdirSync(path.join(bundleDir, 'artifacts'), { recursive: true });

const manifests = [];
for (let i = 0; i < RUNS; i++) {
  const tag = `run-${String.fromCharCode(97 + i)}`;
  const { suites } = qualify(tag);
  const metrics = {
    suite_pass: { value: 1, numerator: 1, count: 1, tolerance: 0, unit: 'ratio' },
    suites_passed: { value: 1, numerator: suites, count: suites, tolerance: 0, unit: 'ratio' },
  };
  const provenance = {
    producer: 'scripts/build-release-evidence.mjs (real npm-test execution)',
    runId: `klypix-mcp-${VERSION}-qualification-${tag}`,
    gitCommit: SOURCE_COMMIT,
    dirtyDigest,
  };
  const reportPath = `${BUNDLE}artifacts/${tag}.json`;
  const reportFile = path.join(ROOT, ...reportPath.split('/'));
  fs.writeFileSync(reportFile, evaluationArtifactJson(evaluationArtifactContract({
    name: 'full-suite-qualification',
    claimKey,
    scopeFingerprint,
    producer: provenance.producer,
    runId: provenance.runId,
    gitCommit: provenance.gitCommit,
    dirtyDigest,
    inputFingerprint,
    configurationFingerprint,
    metrics,
  })));
  const reportSha = hashFile(reportFile);
  manifests.push({
    schemaVersion: 2,
    claimKey,
    scope,
    report: { path: reportPath, sha256: reportSha },
    artifacts: [{ path: reportPath, sha256: reportSha, kind: 'evaluation-result' }],
    evaluations: [{
      name: 'full-suite-qualification',
      artifact: { path: reportPath, sha256: reportSha },
      metricKeys: ['suite_pass', 'suites_passed'],
    }],
    publicClaims: [],
    provenance,
    input: { details: inputDetails, fingerprint: inputFingerprint },
    configuration: { details: configurationDetails, fingerprint: configurationFingerprint },
    metrics,
  });
}

// ---- reconcile, then bind ----------------------------------------------
// Each run is recorded as an independent session; the LAST receipt carries the
// corroborated verdict across all of them.
const brainPath = ['brain.klypix', 'brain.any'].map((n) => path.join(ROOT, n)).find(fs.existsSync)
  || path.join(ROOT, 'brain.klypix');
let recorded = null;
manifests.forEach((manifest, i) => {
  recorded = recordResultManifests({
    brainPath,
    projectRoot: ROOT,
    sessionId: `release-qualification-${String.fromCharCode(97 + i)}`,
    declaredScope: scope,
    results: [manifest],
  });
});

const validated = manifests.map((m) => validateResultManifest(m, { projectRoot: ROOT }));
for (const [i, v] of validated.entries()) {
  if (!v.manifest) die(`run-${String.fromCharCode(97 + i)} manifest is invalid: ${JSON.stringify(v.errors || v)}`);
}
if (recorded?.receipt?.status !== 'corroborated') {
  die(`evidence is "${recorded?.receipt?.status}", not corroborated — the publish gate would reject it`);
}

const last = validated[validated.length - 1];
const created = createPublicationReceipt({
  projectRoot: ROOT,
  packageName: pkg.name,
  version: VERSION,
  gitCommit: SOURCE_COMMIT,
  resultReceipt: recorded.receipt,
  resultReceiptHash: recorded.receiptHash,
  manifests: [{ manifest: last.manifest, manifestHash: last.manifestHash }],
});
const expected = publicationEvidenceClaims(validated.map((v) => v.manifest));

fs.writeFileSync(path.join(bundleDir, 'receipt.json'), JSON.stringify(created.receipt, null, 2));
fs.writeFileSync(path.join(bundleDir, 'expectations.json'), JSON.stringify({
  artifacts: expected.artifacts,
  publicClaims: expected.publicClaims,
}, null, 2));

console.log(`\n✓ ${BUNDLE} built from ${RUNS} independent full-suite runs (status: ${recorded.receipt.status})`);
console.log(`  source commit ${SOURCE_COMMIT}`);
console.log('\nNext:');
console.log(`  git add -- ${BUNDLE} && git commit -m "release: add corroborated ${VERSION} evidence"`);
console.log(`  node scripts/verify-release-evidence.mjs --project . --receipt ${BUNDLE}receipt.json \\`);
console.log(`    --expectations ${BUNDLE}expectations.json --package ${pkg.name} --version ${VERSION} \\`);
console.log(`    --git-commit ${SOURCE_COMMIT} --require-corroborated`);
