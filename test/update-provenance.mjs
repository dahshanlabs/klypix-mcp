// Acceptance tests for client-side release verification (verify-before-install).
// All registry seams are injected fixtures; this test never contacts npm and
// never touches the user's brain. Locked policy:
//   - tarball hash must match registry dist.integrity;
//   - the npm attestation must exist and its SLSA provenance predicate must
//     name github.com/dahshanlabs/klypix-mcp;
//   - verification failure FAILS CLOSED (current version kept + visible
//     'verification-refused' receipt);
//   - registry-unreachable degrades to the updater's quiet contained path;
//   - KLYPIX_UPDATE_VERIFY=off is the (dangerous, documented) escape hatch.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  EXPECTED_REPO,
  updateVerificationEnabled,
  verifyAttestationDocument,
  verifyReleaseProvenance,
  verifySriIntegrity,
} from '../src/update-provenance.mjs';
import { autoUpdatePaths, inspectAutoUpdate, runAutoUpdateCheck } from '../src/mcp-auto-update.mjs';
import { inspect, render } from '../src/brain-doctor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-update-verify-'));
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`✓ ${message}`); }
  else { fail++; console.error(`✗ ${message}`); }
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const VERSION = '1.80.0';
const tarball = Buffer.from('fixture tarball bytes for klypix-mcp — deterministic');
const sha512b64 = crypto.createHash('sha512').update(tarball).digest('base64');
const sha512hex = crypto.createHash('sha512').update(tarball).digest('hex');
const integrity = `sha512-${sha512b64}`;
const TARBALL_URL = `https://registry.npmjs.org/klypix-mcp/-/klypix-mcp-${VERSION}.tgz`;

const slsaV1Statement = (overrides = {}) => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: `pkg:npm/klypix-mcp@${VERSION}`, digest: { sha512: sha512hex } }],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: { repository: 'https://github.com/dahshanlabs/klypix-mcp', ref: `refs/tags/v${VERSION}` },
      },
    },
    runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
  },
  ...overrides,
});
const attestationDoc = (statement, { predicateType = 'https://slsa.dev/provenance/v1' } = {}) => ({
  attestations: [{
    predicateType,
    bundle: {
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      },
    },
  }],
});
const seams = (overrides = {}) => ({
  env: {},
  fetchMeta: async () => ({ statusCode: 200, meta: { dist: { integrity, tarball: TARBALL_URL } } }),
  fetchTarballBytes: async () => ({ statusCode: 200, bytes: tarball }),
  fetchAttestationDoc: async () => ({ statusCode: 200, doc: attestationDoc(slsaV1Statement()) }),
  ...overrides,
});

try {
  // ── pure helpers ───────────────────────────────────────────────────────────
  {
    const good = verifySriIntegrity(tarball, integrity);
    const bad = verifySriIntegrity(Buffer.from('tampered bytes'), integrity);
    const junk = verifySriIntegrity(tarball, 'md5-not-a-real-sri');
    ok(good.ok && good.algorithm === 'sha512' && good.actualHex === sha512hex, 'SRI check accepts the exact published bytes');
    ok(!bad.ok && bad.algorithm === 'sha512', 'SRI check rejects tampered bytes');
    ok(!junk.ok && junk.algorithm === null, 'an unusable SRI string is a rejection, never a pass');
    ok(updateVerificationEnabled({}) && !updateVerificationEnabled({ KLYPIX_UPDATE_VERIFY: 'off' }),
      'verification defaults ON; KLYPIX_UPDATE_VERIFY=off is the only way to disable it');
  }

  {
    const verdict = verifyAttestationDocument(attestationDoc(slsaV1Statement()), {
      version: VERSION, tarballSha512Hex: sha512hex,
    });
    ok(verdict.ok && verdict.repo === EXPECTED_REPO, 'a real SLSA v1 provenance document verifies to the expected repo');
    const v02 = verifyAttestationDocument(attestationDoc(slsaV1Statement({
      predicateType: 'https://slsa.dev/provenance/v0.2',
      predicate: { invocation: { configSource: { uri: `git+https://github.com/dahshanlabs/klypix-mcp@refs/tags/v${VERSION}` } } },
    }), { predicateType: 'https://slsa.dev/provenance/v0.2' }), { version: VERSION, tarballSha512Hex: sha512hex });
    ok(v02.ok, 'the older SLSA v0.2 configSource shape also verifies (parse both generations)');
    const foreign = verifyAttestationDocument(attestationDoc(slsaV1Statement({
      predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/attacker/klypix-mcp' } } } },
    })), { version: VERSION, tarballSha512Hex: sha512hex });
    ok(!foreign.ok && /attacker/.test(foreign.error), 'provenance from a foreign repository is refused, naming the impostor');
    const wrongSubject = verifyAttestationDocument(attestationDoc(slsaV1Statement({
      subject: [{ name: `pkg:npm/klypix-mcp@${VERSION}`, digest: { sha512: 'f'.repeat(128) } }],
    })), { version: VERSION, tarballSha512Hex: sha512hex });
    ok(!wrongSubject.ok && /digest/.test(wrongSubject.error), 'a provenance subject bound to DIFFERENT bytes is refused (substitution attack)');
    const garbage = verifyAttestationDocument({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: '%%%not-base64-json%%%' } } }] }, { version: VERSION });
    ok(!garbage.ok, 'an unparseable attestation payload is refused, never crashes the verifier');
    ok(!verifyAttestationDocument({ attestations: [] }, { version: VERSION }).ok
      && !verifyAttestationDocument(null, { version: VERSION }).ok,
    'an empty or missing attestation list is refused (defensive parse)');
  }

  // ── the decision: verifyReleaseProvenance ──────────────────────────────────
  {
    const good = await verifyReleaseProvenance(VERSION, seams());
    ok(good.ok === true && good.repo === EXPECTED_REPO && good.integrity === integrity,
      'happy path: integrity + attestation + repo all verify');

    const tampered = await verifyReleaseProvenance(VERSION, seams({
      fetchTarballBytes: async () => ({ statusCode: 200, bytes: Buffer.from('evil replacement bytes') }),
    }));
    ok(tampered.ok === false && tampered.reason === 'refused' && /hash/.test(tampered.error),
      'a tarball that does not match dist.integrity is REFUSED (fail closed)');

    const noAttestation = await verifyReleaseProvenance(VERSION, seams({
      fetchAttestationDoc: async () => ({ statusCode: 404, doc: null }),
    }));
    ok(noAttestation.ok === false && noAttestation.reason === 'refused' && /no attestation/.test(noAttestation.error),
      'a version with NO attestation (the token-theft signature) is REFUSED');

    const offRegistry = await verifyReleaseProvenance(VERSION, seams({
      fetchMeta: async () => ({ statusCode: 200, meta: { dist: { integrity, tarball: 'https://evil.example.com/klypix-mcp.tgz' } } }),
    }));
    ok(offRegistry.ok === false && offRegistry.reason === 'refused' && /off-registry/.test(offRegistry.error),
      'metadata pointing the download off-registry is REFUSED');

    const bareMeta = await verifyReleaseProvenance(VERSION, seams({
      fetchMeta: async () => ({ statusCode: 200, meta: { dist: {} } }),
    }));
    ok(bareMeta.ok === false && bareMeta.reason === 'refused',
      'metadata with nothing to verify against is REFUSED, never waved through');

    const offlineMeta = await verifyReleaseProvenance(VERSION, seams({
      fetchMeta: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); },
    }));
    const registryDown = await verifyReleaseProvenance(VERSION, seams({
      fetchAttestationDoc: async () => ({ statusCode: 503, doc: null }),
    }));
    ok(offlineMeta.ok === false && offlineMeta.reason === 'network'
      && registryDown.ok === false && registryDown.reason === 'network',
    'unreachable/unhealthy registry classifies as network (quiet skip), not refusal');

    let fetched = false;
    const disabled = await verifyReleaseProvenance(VERSION, seams({
      env: { KLYPIX_UPDATE_VERIFY: 'off' },
      fetchMeta: async () => { fetched = true; return { statusCode: 200, meta: null }; },
    }));
    ok(disabled.ok === true && /disabled/.test(disabled.skipped) && !fetched,
      'KLYPIX_UPDATE_VERIFY=off skips verification explicitly and does no fetches (escape hatch)');

    const badVersion = await verifyReleaseProvenance('1.2.3 && whoami', seams());
    ok(badVersion.ok === false && badVersion.reason === 'refused', 'a non-semver version is refused before any fetch');
  }

  // ── updater integration: runAutoUpdateCheck ────────────────────────────────
  const scenario = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const writeRuntime = (dir, version) => {
    fs.writeFileSync(path.join(dir, '.mcp-runtime.json'), JSON.stringify({ protocol: 1, version, worker: 'worker.mjs' }));
    fs.writeFileSync(path.join(dir, '.brain-version.json'), JSON.stringify({ brainVersion: version, via: 'npm' }));
  };

  {
    const dir = scenario('refused-fails-closed');
    writeRuntime(dir, '1.4.0');
    let installs = 0;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 100_000,
      fetchLatest: async () => VERSION,
      verifyRelease: async () => ({ ok: false, reason: 'refused', error: `no attestation exists for klypix-mcp@${VERSION}` }),
      installVersion: async () => { installs++; },
    });
    const status = JSON.parse(fs.readFileSync(autoUpdatePaths(dir).status, 'utf8'));
    const diagnostic = inspectAutoUpdate(dir, { now: 100_001 });
    ok(result.result === 'verification-refused' && installs === 0, 'a refused verification NEVER installs — current version kept');
    ok(status.result === 'verification-refused' && /REFUSED/.test(status.error) && /kept v1\.4\.0/.test(status.error),
      'the refusal receipt is durable and says what was kept and why');
    ok(diagnostic.result === 'verification-refused' && !fs.existsSync(autoUpdatePaths(dir).lock),
      'the refusal is inspectable after the fact and the machine lock is released');
  }

  {
    const dir = scenario('network-quiet-skip');
    writeRuntime(dir, '1.4.0');
    let installs = 0;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 200_000,
      fetchLatest: async () => VERSION,
      verifyRelease: async () => ({ ok: false, reason: 'network', error: 'attestation endpoint unreachable: offline' }),
      installVersion: async () => { installs++; },
    });
    ok(result.result === 'failed' && installs === 0 && /unreachable/.test(result.error),
      'registry-unreachable mid-verification degrades to the existing quiet contained-failure path');
  }

  {
    const dir = scenario('verified-installs');
    writeRuntime(dir, '1.4.0');
    let verifiedVersion = null;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 300_000,
      fetchLatest: async () => VERSION,
      verifyRelease: async (version) => { verifiedVersion = version; return { ok: true, integrity, repo: EXPECTED_REPO }; },
      installVersion: async (version, { brainDir }) => writeRuntime(brainDir, version),
    });
    const status = JSON.parse(fs.readFileSync(autoUpdatePaths(dir).status, 'utf8'));
    ok(result.result === 'updated' && verifiedVersion === VERSION, 'a verified release installs — verification runs on the exact version');
    ok(/provenance verified/.test(status.verification || '') && new RegExp(EXPECTED_REPO).test(status.verification || ''),
      'the success receipt records what was verified');
  }

  {
    const dir = scenario('escape-hatch-audited');
    writeRuntime(dir, '1.4.0');
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 400_000,
      env: { KLYPIX_UPDATE_VERIFY: 'off' },
      fetchLatest: async () => VERSION,
      installVersion: async (version, { brainDir }) => writeRuntime(brainDir, version),
    });
    const status = JSON.parse(fs.readFileSync(autoUpdatePaths(dir).status, 'utf8'));
    ok(result.result === 'updated' && /SKIPPED/.test(status.verification || ''),
      'the escape hatch still installs but leaves an auditable SKIPPED receipt');
  }

  {
    const dir = scenario('current-never-verifies');
    writeRuntime(dir, VERSION);
    let verifies = 0;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 500_000,
      fetchLatest: async () => VERSION,
      verifyRelease: async () => { verifies++; return { ok: true }; },
      reconcileProjects: async () => ({ checked: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, projects: [] }),
    });
    ok(result.result === 'current' && verifies === 0, 'a current runtime does no verification work (no install → no gate)');
  }

  // ── the refusal is VISIBLE: brain_doctor renders it loudly ─────────────────
  {
    const home = scenario('doctor-home');
    const project = scenario('doctor-project');
    const brainDir = path.join(home, '.claude', 'project-brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, '.brain-version.json'), JSON.stringify({ brainVersion: '1.4.0', via: 'npm' }));
    fs.writeFileSync(autoUpdatePaths(brainDir).status, JSON.stringify({
      protocol: 1,
      result: 'verification-refused',
      currentVersion: '1.4.0',
      latestVersion: VERSION,
      error: `update to v${VERSION} REFUSED: no attestation exists for klypix-mcp@${VERSION} — kept v1.4.0`,
    }));
    fs.writeFileSync(autoUpdatePaths(brainDir).stamp, JSON.stringify({ protocol: 1, lastCheck: Date.now() }));
    const report = inspect({ home, projectDir: project, fmtLib: null, env: {} });
    const text = render(report, { color: false });
    ok(report.layers.autoUpdate === 'warning' && report.readinessWarnings.some((w) => /REFUSED/.test(w)),
      'a refused update is a readiness warning — the machine never renders all-clear');
    ok(report.verdict === 'PARTIAL', 'the doctor verdict downgrades to PARTIAL on a refused update');
    ok(/REFUSED by release verification/.test(text) && /attestations\/klypix-mcp@1\.80\.0/.test(text),
      'the doctor renders the refusal receipt with a hand-verification pointer');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n✓ update-provenance: ${pass} assertions passed`);
