// Portable, fail-closed publication evidence.
//
// A result ledger receipt is machine-local coordination evidence. This module
// turns its verified schema-v2 manifests into a commit-bound receipt that a
// release workflow can check against independently supplied expectations. The
// receipt never gets to define its own expected version, commit, artifacts, or
// public claims; the caller must supply each of those release inputs.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  compareResultManifests,
  RESULT_MANIFEST_SCHEMA_VERSION,
  RESULT_RECEIPT_SCHEMA_VERSION,
  resultArtifactFingerprint,
  resultConfigurationFingerprint,
  resultEvaluationFingerprint,
  resultInputFingerprint,
  resultPublicClaimsFingerprint,
  resultScopeFingerprint,
  sha256ResultValue,
  stableResultJson,
  validateResultManifest,
} from './result-reconcile.mjs';

export const PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_BLOB_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const isPlainObject = (value) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);

const rejectUnknown = (raw, allowed, label, errors) => {
  if (!isPlainObject(raw)) return;
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) errors.push(`unknown ${label} field(s): ${unknown.join(', ')}`);
};

function normalizeRelativePath(raw, label, errors) {
  if (typeof raw !== 'string') {
    errors.push(`${label} must be a string`);
    return '';
  }
  const value = raw.replace(/\\/g, '/').trim();
  if (!value || value.length > 512 || value.includes('\0')
    || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('/')) {
    errors.push(`${label} must be a bounded project-relative path`);
    return '';
  }
  if (/[*?\[\]{}]/.test(value)) {
    errors.push(`${label} must be an exact path, not a glob`);
    return '';
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || value.endsWith('/')) {
    errors.push(`${label} must use canonical project-relative form`);
    return '';
  }
  return value;
}

const receiptBody = (receipt) => {
  const { receiptHash: _receiptHash, ...body } = receipt;
  return body;
};

export const publicationReceiptHash = (receipt) => sha256ResultValue(receiptBody(receipt));

const checkedHash = (value, label, errors) => {
  try { return sha256ResultValue(value); }
  catch (error) {
    errors.push(`${label} cannot be canonically hashed: ${error?.message || error}`);
    return '';
  }
};

export const releaseEvidencePrefix = (version) => `.release-evidence/v${version}/`;

export function validateEvidenceOnlyGitDiff(rawDiff, {
  version,
  receiptPath,
  expectationsPath,
  expectedArtifacts,
  committedFiles,
} = {}) {
  const errors = [];
  if (!VERSION_RE.test(String(version || ''))) errors.push('version must be an exact semantic version');
  const prefix = releaseEvidencePrefix(version);
  const receipt = normalizeRelativePath(receiptPath, 'receiptPath', errors);
  const expectations = normalizeRelativePath(expectationsPath, 'expectationsPath', errors);
  if (receipt !== `${prefix}receipt.json`) errors.push(`receiptPath must be exactly ${prefix}receipt.json`);
  if (expectations !== `${prefix}expectations.json`) {
    errors.push(`expectationsPath must be exactly ${prefix}expectations.json`);
  }
  const artifacts = normalizeExpectedArtifacts(expectedArtifacts, errors);
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(`${prefix}artifacts/`)) {
      errors.push(`publication artifact must be inside ${prefix}artifacts/: ${artifact.path}`);
    }
  }
  const expectedPaths = [receipt, expectations, ...artifacts.map((artifact) => artifact.path)].filter(Boolean);
  const expectedSet = new Set(expectedPaths);
  if (expectedSet.size !== expectedPaths.length) errors.push('evidence bundle paths must be unique');
  const changed = [];
  const fields = String(rawDiff || '').split('\0');
  if (fields.at(-1) === '') fields.pop();
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z][0-9]*)$/.exec(header);
    if (!match) {
      errors.push(`git raw diff record ${changed.length + 1} has an invalid header`);
      break;
    }
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const rawPath = fields[index++];
    if (rawPath === undefined) {
      errors.push(`git raw diff record ${changed.length + 1} is missing its path`);
      break;
    }
    const changedPath = normalizeRelativePath(rawPath, `git raw diff record ${changed.length + 1} path`, errors);
    changed.push({ status, path: changedPath, oldMode, newMode, oldOid, newOid });
    if (status !== 'A') errors.push(`evidence-only bundle contains forbidden git change type ${status}`);
    if (oldMode !== '000000' || !/^0+$/.test(oldOid)) {
      errors.push(`evidence bundle entry existed in the target commit: ${changedPath}`);
    }
    if (newMode !== '100644') errors.push(`evidence bundle entry is not a regular 100644 file: ${changedPath}`);
    if (!GIT_BLOB_RE.test(newOid)) errors.push(`evidence bundle entry has an invalid committed blob id: ${changedPath}`);
    if (changedPath && !expectedSet.has(changedPath)) {
      errors.push(`checked-out commit differs from the evidence target outside the exact evidence bundle: ${changedPath}`);
    }
  }
  const actualPaths = changed.map((entry) => entry.path);
  for (const expected of expectedPaths) {
    if (!actualPaths.includes(expected)) errors.push(`evidence bundle is missing added file: ${expected}`);
  }
  if (new Set(actualPaths).size !== actualPaths.length) errors.push('git raw diff contains duplicate evidence paths');

  if (!Array.isArray(committedFiles)) errors.push('committedFiles blob proof is required');
  else {
    const byPath = new Map();
    for (const entry of committedFiles) {
      if (byPath.has(entry?.path)) errors.push(`duplicate committed blob proof for ${entry?.path}`);
      else byPath.set(entry?.path, entry);
      if (!expectedSet.has(entry?.path)) errors.push(`unexpected committed blob proof for ${entry?.path}`);
    }
    const artifactHashes = new Map(artifacts.map((artifact) => [artifact.path, artifact.sha256]));
    for (const change of changed) {
      const committed = byPath.get(change.path);
      if (!isPlainObject(committed)) {
        errors.push(`missing committed blob proof for ${change.path}`);
        continue;
      }
      rejectUnknown(committed, new Set(['path', 'mode', 'oid', 'sha256']), `committedFiles ${change.path}`, errors);
      if (committed.mode !== '100644' || committed.mode !== change.newMode) {
        errors.push(`committed mode does not match raw diff for ${change.path}`);
      }
      if (committed.oid !== change.newOid || !GIT_BLOB_RE.test(String(committed.oid || ''))) {
        errors.push(`committed blob id does not match raw diff for ${change.path}`);
      }
      if (!SHA256_RE.test(String(committed.sha256 || ''))) {
        errors.push(`committed content SHA-256 is invalid for ${change.path}`);
      }
      const artifactSha = artifactHashes.get(change.path);
      if (artifactSha && committed.sha256 !== artifactSha) {
        errors.push(`committed artifact content does not match expected SHA-256 for ${change.path}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, changed };
}

function normalizeExpectedArtifacts(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 512) {
    errors.push('expectedArtifacts must independently declare 1-512 publication evidence artifacts');
    return [];
  }
  const out = [];
  const seen = new Map();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      errors.push(`expectedArtifacts[${index}] must be an object`);
      continue;
    }
    rejectUnknown(item, new Set(['path', 'sha256', 'kind']), `expectedArtifacts[${index}]`, errors);
    const artifactPath = normalizeRelativePath(item.path, `expectedArtifacts[${index}].path`, errors);
    const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    if (!SHA256_RE.test(sha256)) errors.push(`expectedArtifacts[${index}].sha256 must be a SHA-256 digest`);
    if (!kind) errors.push(`expectedArtifacts[${index}].kind is required`);
    const key = artifactPath.toLowerCase();
    if (key && seen.has(key)) errors.push(`expectedArtifacts contains a duplicate path: ${artifactPath}`);
    else if (key) seen.set(key, true);
    out.push({ path: artifactPath, sha256, kind });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function normalizeExpectedPublicClaims(raw, errors) {
  if (!Array.isArray(raw) || raw.length > 512) {
    errors.push('expectedPublicClaims must be an independently supplied array (empty when none)');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      errors.push(`expectedPublicClaims[${index}] must be an object`);
      continue;
    }
    rejectUnknown(item, new Set(['key', 'metric', 'value', 'unit', 'statement']), `expectedPublicClaims[${index}]`, errors);
    const normalized = {
      key: typeof item.key === 'string' ? item.key.trim() : '',
      metric: typeof item.metric === 'string' ? item.metric.trim() : '',
      value: item.value,
      unit: typeof item.unit === 'string' ? item.unit.trim() : '',
      statement: typeof item.statement === 'string' ? item.statement.trim() : '',
    };
    if (!normalized.key || !normalized.metric || !normalized.unit || !normalized.statement
      || typeof normalized.value !== 'number' || !Number.isFinite(normalized.value)) {
      errors.push(`expectedPublicClaims[${index}] is incomplete`);
    }
    if (seen.has(normalized.key)) errors.push(`expectedPublicClaims contains a duplicate key: ${normalized.key}`);
    seen.add(normalized.key);
    out.push(normalized);
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

export function publicationEvidenceClaims(manifests) {
  const errors = [];
  const artifacts = new Map();
  const publicClaims = new Map();
  for (const manifest of manifests || []) {
    for (const artifact of manifest.artifacts || []) {
      const key = artifact.path.toLowerCase();
      const prior = artifacts.get(key);
      if (prior && stableResultJson(prior) !== stableResultJson(artifact)) {
        errors.push(`conflicting artifact declaration across results: ${artifact.path}`);
      } else if (!prior) artifacts.set(key, artifact);
    }
    for (const claim of manifest.publicClaims || []) {
      const prior = publicClaims.get(claim.key);
      if (prior && stableResultJson(prior) !== stableResultJson(claim)) {
        errors.push(`conflicting public claim declaration across results: ${claim.key}`);
      } else if (!prior) publicClaims.set(claim.key, claim);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    artifacts: [...artifacts.values()].sort((a, b) => a.path.localeCompare(b.path)),
    publicClaims: [...publicClaims.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function validateEmbeddedManifests(raw, { projectRoot }, errors) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    errors.push('manifests must contain 1-8 embedded schema-v2 results');
    return [];
  }
  const manifests = [];
  const claims = new Set();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!isPlainObject(entry)) {
      errors.push(`manifests[${index}] must contain manifest and manifestHash`);
      continue;
    }
    rejectUnknown(entry, new Set(['manifest', 'manifestHash']), `manifests[${index}]`, errors);
    const checked = validateResultManifest(entry.manifest, { projectRoot, verifyReport: true });
    if (!checked.ok) {
      errors.push(...checked.errors.map((error) => `manifests[${index}]: ${error}`));
      continue;
    }
    if (!checked.publicationEligible || checked.manifest.schemaVersion !== RESULT_MANIFEST_SCHEMA_VERSION) {
      errors.push(`manifests[${index}] is legacy evidence and is not publication eligible`);
    }
    const manifestHash = typeof entry.manifestHash === 'string' ? entry.manifestHash.trim().toLowerCase() : '';
    if (!SHA256_RE.test(manifestHash) || manifestHash !== checked.manifestHash) {
      errors.push(`manifests[${index}].manifestHash does not match the normalized manifest`);
    }
    if (claims.has(checked.manifest.claimKey)) {
      errors.push(`manifests contains a duplicate claimKey: ${checked.manifest.claimKey}`);
    }
    claims.add(checked.manifest.claimKey);
    manifests.push({ manifest: checked.manifest, manifestHash: checked.manifestHash });
  }
  manifests.sort((a, b) => a.manifest.claimKey.localeCompare(b.manifest.claimKey));
  return manifests;
}

function receiptManifestBinding(manifest, manifestHash, gitCommit) {
  return {
    manifestSchemaVersion: RESULT_MANIFEST_SCHEMA_VERSION,
    runId: manifest.provenance.runId,
    gitCommit,
    manifestHash,
    reportSha256: manifest.report.sha256,
    inputFingerprint: resultInputFingerprint(manifest),
    configurationFingerprint: resultConfigurationFingerprint(manifest),
    scopeFingerprint: resultScopeFingerprint(manifest),
    artifactFingerprint: resultArtifactFingerprint(manifest),
    evaluationFingerprint: resultEvaluationFingerprint(manifest),
    publicClaimsFingerprint: resultPublicClaimsFingerprint(manifest),
  };
}

const RECEIPT_BINDING_KEYS = new Set([
  'manifestSchemaVersion', 'runId', 'gitCommit', 'manifestHash', 'reportSha256',
  'inputFingerprint', 'configurationFingerprint', 'scopeFingerprint',
  'artifactFingerprint', 'evaluationFingerprint', 'publicClaimsFingerprint',
]);

function validateResultReceipt(
  resultReceipt,
  resultReceiptHash,
  manifests,
  gitCommit,
  errors,
  { requireCorroborated, projectRoot },
) {
  const peerManifests = [];
  if (!isPlainObject(resultReceipt)) {
    errors.push('resultReceipt must be a portable reconciliation receipt');
    return { peerManifests };
  }
  rejectUnknown(resultReceipt, new Set([
    'schemaVersion', 'generatedAt', 'status', 'publicationEligible', 'machineLocal',
    'ledgerFreshMs', 'claims', 'conflicts',
  ]), 'resultReceipt', errors);
  const normalizedHash = typeof resultReceiptHash === 'string' ? resultReceiptHash.trim().toLowerCase() : '';
  const actualResultReceiptHash = checkedHash(resultReceipt, 'resultReceipt', errors);
  if (!SHA256_RE.test(normalizedHash) || normalizedHash !== actualResultReceiptHash) {
    errors.push('resultReceiptHash does not match resultReceipt');
  }
  if (resultReceipt.schemaVersion !== RESULT_RECEIPT_SCHEMA_VERSION) {
    errors.push(`resultReceipt.schemaVersion must be ${RESULT_RECEIPT_SCHEMA_VERSION}`);
  }
  if (resultReceipt.publicationEligible !== true || !['unique', 'corroborated'].includes(resultReceipt.status)
    || (Array.isArray(resultReceipt.conflicts) && resultReceipt.conflicts.length > 0)) {
    errors.push('resultReceipt is not a conflict-free publication-eligible verdict');
  }
  if (requireCorroborated && resultReceipt.status !== 'corroborated') {
    errors.push('publication policy requires corroborated result evidence');
  }
  if (resultReceipt.machineLocal !== true) errors.push('resultReceipt.machineLocal must be true');
  if (!Number.isSafeInteger(resultReceipt.generatedAt) || resultReceipt.generatedAt <= 0) {
    errors.push('resultReceipt.generatedAt must be a positive integer timestamp');
  }
  if (typeof resultReceipt.ledgerFreshMs !== 'number' || !Number.isFinite(resultReceipt.ledgerFreshMs)
    || resultReceipt.ledgerFreshMs <= 0) {
    errors.push('resultReceipt.ledgerFreshMs must be positive');
  }
  if (!Array.isArray(resultReceipt.conflicts) || resultReceipt.conflicts.length !== 0) {
    errors.push('resultReceipt.conflicts must be an explicit empty array');
  }
  if (!Array.isArray(resultReceipt.claims) || resultReceipt.claims.length !== manifests.length) {
    errors.push('resultReceipt.claims must exactly cover embedded manifests');
    return { peerManifests };
  }
  const claimStatuses = [];
  for (const entry of manifests) {
    const manifest = entry.manifest;
    const claim = resultReceipt.claims.find((item) => item?.claimKey === manifest.claimKey);
    const submitted = claim?.submitted;
    if (!claim || !isPlainObject(submitted)) {
      errors.push(`resultReceipt is missing claim binding: ${manifest.claimKey}`);
      continue;
    }
    rejectUnknown(claim, new Set(['claimKey', 'status', 'submitted', 'compared']), `resultReceipt claim ${manifest.claimKey}`, errors);
    if (!['unique', 'corroborated'].includes(claim.status)) {
      errors.push(`resultReceipt claim ${manifest.claimKey} has an invalid status`);
    }
    claimStatuses.push(claim.status);
    let compared = [];
    if (!Array.isArray(claim.compared)) {
      errors.push(`resultReceipt claim ${manifest.claimKey}.compared must be an array`);
    } else {
      compared = claim.compared;
      if (compared.length > 32) {
        errors.push(`resultReceipt claim ${manifest.claimKey}.compared exceeds 32 peers`);
        compared = compared.slice(0, 32);
      }
    }
    if (claim.status === 'unique' && compared.length !== 0) {
      errors.push(`resultReceipt claim ${manifest.claimKey} is unique but includes peer evidence`);
    }
    if (claim.status === 'corroborated' && compared.length === 0) {
      errors.push(`resultReceipt claim ${manifest.claimKey} is corroborated but has no peer evidence`);
    }
    if (requireCorroborated && (claim.status !== 'corroborated' || compared.length === 0)) {
      errors.push(`resultReceipt claim ${manifest.claimKey} lacks corroborating peer evidence`);
    }
    rejectUnknown(submitted, RECEIPT_BINDING_KEYS, `resultReceipt claim ${manifest.claimKey}.submitted`, errors);
    const expected = receiptManifestBinding(manifest, entry.manifestHash, gitCommit);
    for (const [key, value] of Object.entries(expected)) {
      if (submitted[key] !== value) errors.push(`resultReceipt claim ${manifest.claimKey} has a mismatched ${key}`);
    }

    const peerRuns = new Set();
    const peerHashes = new Set();
    for (let index = 0; index < compared.length; index++) {
      const peer = compared[index];
      const label = `resultReceipt claim ${manifest.claimKey}.compared[${index}]`;
      if (!isPlainObject(peer) || Object.keys(peer).length === 0) {
        errors.push(`${label} must be a complete peer binding object`);
        continue;
      }
      rejectUnknown(peer, new Set([...RECEIPT_BINDING_KEYS, 'manifest']), label, errors);
      if (!isPlainObject(peer.manifest)) {
        errors.push(`${label}.manifest must embed the peer result manifest`);
        continue;
      }
      const checkedPeer = validateResultManifest(peer.manifest, {
        projectRoot,
        verifyReport: true,
      });
      if (!checkedPeer.ok || !checkedPeer.publicationEligible) {
        errors.push(`${label}.manifest is not verified schema-v2 evidence: ${checkedPeer.errors.join('; ')}`);
        continue;
      }
      peerManifests.push(checkedPeer.manifest);
      if (checkedPeer.manifest.claimKey !== manifest.claimKey) {
        errors.push(`${label}.manifest claimKey does not match ${manifest.claimKey}`);
      }
      const expectedPeer = receiptManifestBinding(checkedPeer.manifest, checkedPeer.manifestHash, gitCommit);
      for (const [key, value] of Object.entries(expectedPeer)) {
        if (peer[key] !== value) errors.push(`${label} has a mismatched ${key}`);
      }
      if (peer.runId === submitted.runId) errors.push(`${label}.runId must be independent from the submitted run`);
      if (peerRuns.has(peer.runId)) errors.push(`${label}.runId duplicates another peer binding`);
      if (peerHashes.has(peer.manifestHash)) errors.push(`${label}.manifestHash duplicates another peer binding`);
      peerRuns.add(peer.runId);
      peerHashes.add(peer.manifestHash);
      const comparison = compareResultManifests(manifest, checkedPeer.manifest);
      if (comparison.status !== 'corroborated') {
        errors.push(`${label}.manifest does not corroborate the submitted result (${comparison.status})`);
      }
    }
  }
  const expectedStatus = claimStatuses.every((status) => status === 'unique') ? 'unique' : 'corroborated';
  if (resultReceipt.status !== expectedStatus) {
    errors.push(`resultReceipt status ${resultReceipt.status} is inconsistent with per-claim status ${expectedStatus}`);
  }
  return { peerManifests };
}

export function createPublicationReceipt({
  projectRoot,
  packageName,
  version,
  gitCommit,
  resultReceipt,
  resultReceiptHash,
  manifests,
  generatedAt = Date.now(),
} = {}) {
  const errors = [];
  const normalizedManifests = validateEmbeddedManifests(manifests, { projectRoot }, errors);
  const commit = typeof gitCommit === 'string' ? gitCommit.trim().toLowerCase() : '';
  if (!PACKAGE_NAME_RE.test(String(packageName || ''))) errors.push('packageName is invalid');
  if (!VERSION_RE.test(String(version || ''))) errors.push('version must be an exact semantic version');
  if (!GIT_COMMIT_RE.test(commit)) errors.push('gitCommit must be a full 40- or 64-character commit object id');
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) errors.push('generatedAt must be a positive integer timestamp');
  if (normalizedManifests.some((entry) => entry.manifest.provenance.gitCommit !== commit)) {
    errors.push('every result manifest provenance.gitCommit must match the publication commit');
  }
  const resultReceiptProof = validateResultReceipt(resultReceipt, resultReceiptHash, normalizedManifests, commit, errors, {
    requireCorroborated: false,
    projectRoot,
  });
  const evidence = publicationEvidenceClaims([
    ...normalizedManifests.map((entry) => entry.manifest),
    ...resultReceiptProof.peerManifests,
  ]);
  errors.push(...evidence.errors);
  if (errors.length) return { ok: false, errors, receipt: null };
  const receipt = {
    schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    package: { name: packageName, version },
    gitCommit: commit,
    generatedAt,
    resultReceipt,
    resultReceiptHash: resultReceiptHash.toLowerCase(),
    manifests: normalizedManifests,
  };
  receipt.receiptHash = checkedHash(receiptBody(receipt), 'publication receipt', errors);
  if (errors.length) return { ok: false, errors, receipt: null };
  return { ok: true, errors: [], receipt };
}

export function verifyPublicationReceipt(receipt, {
  projectRoot,
  expectedPackageName,
  expectedVersion,
  expectedGitCommit,
  expectedArtifacts,
  expectedPublicClaims,
  receiptPath,
  trackedFiles,
  committedReceiptSha256,
  requireCorroborated = false,
} = {}) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    return { ok: false, status: 'blocked', errors: ['publication receipt must be an object'] };
  }
  rejectUnknown(receipt, new Set([
    'schemaVersion', 'package', 'gitCommit', 'generatedAt', 'resultReceipt',
    'resultReceiptHash', 'manifests', 'receiptHash',
  ]), 'publication receipt', errors);
  if (receipt.schemaVersion !== PUBLICATION_RECEIPT_SCHEMA_VERSION) {
    errors.push(`publication receipt schemaVersion must be ${PUBLICATION_RECEIPT_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(receipt.package)) errors.push('publication receipt package must be an object');
  else rejectUnknown(receipt.package, new Set(['name', 'version']), 'publication package', errors);

  const expectedCommit = typeof expectedGitCommit === 'string' ? expectedGitCommit.trim().toLowerCase() : '';
  if (!projectRoot) errors.push('projectRoot is required');
  if (!PACKAGE_NAME_RE.test(String(expectedPackageName || ''))) errors.push('expectedPackageName is required and must be valid');
  if (!VERSION_RE.test(String(expectedVersion || ''))) errors.push('expectedVersion is required and must be an exact semantic version');
  if (!GIT_COMMIT_RE.test(expectedCommit)) {
    errors.push('expectedGitCommit is required and must be a full 40- or 64-character commit object id');
  }
  if (receipt.package?.name !== expectedPackageName) errors.push('receipt package name does not match the release input');
  if (receipt.package?.version !== expectedVersion) errors.push('receipt version does not match the release input');
  if (receipt.gitCommit !== expectedCommit) errors.push('receipt gitCommit does not match the release input');
  if (!Number.isSafeInteger(receipt.generatedAt) || receipt.generatedAt <= 0) {
    errors.push('receipt generatedAt must be a positive integer timestamp');
  }
  const declaredReceiptHash = typeof receipt.receiptHash === 'string' ? receipt.receiptHash.trim().toLowerCase() : '';
  const actualReceiptHash = checkedHash(receiptBody(receipt), 'publication receipt', errors);
  if (!SHA256_RE.test(declaredReceiptHash) || declaredReceiptHash !== actualReceiptHash) {
    errors.push('receiptHash does not match the publication receipt body');
  }

  const normalizedReceiptPath = normalizeRelativePath(receiptPath, 'receiptPath', errors);
  let tracked = null;
  if (!Array.isArray(trackedFiles)) errors.push('trackedFiles proof from the checked-out commit is required');
  else {
    tracked = new Set(trackedFiles.map((file) => String(file).replace(/\\/g, '/').trim()));
    if (normalizedReceiptPath && !tracked.has(normalizedReceiptPath)) {
      errors.push('publication receipt is not tracked by the checked-out commit');
    }
  }
  const committedHash = typeof committedReceiptSha256 === 'string'
    ? committedReceiptSha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(committedHash)) {
    errors.push('committedReceiptSha256 proof from the checked-out commit is required');
  }
  if (projectRoot && normalizedReceiptPath) {
    try {
      const root = fs.realpathSync.native(path.resolve(projectRoot));
      let cursor = root;
      for (const segment of normalizedReceiptPath.split('/')) {
        cursor = path.join(cursor, segment);
        if (fs.lstatSync(cursor).isSymbolicLink()) {
          throw new Error('publication receipt file may not traverse a symbolic link');
        }
      }
      const bytes = fs.readFileSync(cursor);
      const worktreeHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (SHA256_RE.test(committedHash) && worktreeHash !== committedHash) {
        errors.push('publication receipt content differs from the checked-out commit');
      }
      const worktreeReceipt = JSON.parse(bytes.toString('utf8'));
      if (stableResultJson(worktreeReceipt) !== stableResultJson(receipt)) {
        errors.push('publication receipt object does not match receiptPath');
      }
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  const manifests = validateEmbeddedManifests(receipt.manifests, { projectRoot }, errors);
  if (manifests.some((entry) => entry.manifest.provenance.gitCommit !== expectedCommit)) {
    errors.push('result manifest provenance does not match the release commit');
  }
  const resultReceiptProof = validateResultReceipt(
    receipt.resultReceipt,
    receipt.resultReceiptHash,
    manifests,
    expectedCommit,
    errors,
    { requireCorroborated, projectRoot },
  );
  const evidence = publicationEvidenceClaims([
    ...manifests.map((entry) => entry.manifest),
    ...resultReceiptProof.peerManifests,
  ]);
  errors.push(...evidence.errors);
  const bundlePrefix = releaseEvidencePrefix(expectedVersion);
  if (normalizedReceiptPath !== `${bundlePrefix}receipt.json`) {
    errors.push(`publication receipt must be exactly ${bundlePrefix}receipt.json`);
  }
  const outsideBundle = evidence.artifacts
    .filter((artifact) => !artifact.path.startsWith(`${bundlePrefix}artifacts/`));
  if (outsideBundle.length) {
    errors.push(`publication artifact(s) must be inside ${bundlePrefix}artifacts/: ${outsideBundle.map((item) => item.path).join(', ')}`);
  }
  if (tracked) {
    const untrackedArtifacts = evidence.artifacts
      .filter((artifact) => !tracked.has(artifact.path));
    if (untrackedArtifacts.length) {
      errors.push(`verified publication artifact(s) are not tracked by the checked-out commit: ${untrackedArtifacts.map((item) => item.path).join(', ')}`);
    }
  }
  const normalizedArtifacts = normalizeExpectedArtifacts(expectedArtifacts, errors);
  const normalizedClaims = normalizeExpectedPublicClaims(expectedPublicClaims, errors);
  if (stableResultJson(normalizedArtifacts) !== stableResultJson(evidence.artifacts)) {
    errors.push('verified artifact claims do not exactly match independently supplied release expectations');
  }
  if (stableResultJson(normalizedClaims) !== stableResultJson(evidence.publicClaims)) {
    errors.push('verified public metric claims do not exactly match independently supplied release expectations');
  }
  return {
    ok: errors.length === 0,
    status: errors.length ? 'blocked' : 'eligible',
    errors,
    receiptHash: declaredReceiptHash || null,
    manifestHashes: manifests.map((entry) => entry.manifestHash),
    artifacts: evidence.artifacts,
    publicClaims: evidence.publicClaims,
  };
}

export function verifyPublicationReceiptFile(receiptFile, options = {}) {
  const errors = [];
  const projectRoot = options.projectRoot;
  let receipt;
  let relative = '';
  try {
    if (!projectRoot) throw new Error('projectRoot is required');
    const root = fs.realpathSync.native(path.resolve(projectRoot));
    const requested = path.resolve(receiptFile);
    relative = path.relative(root, requested).replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('publication receipt file must be inside projectRoot');
    }
    let cursor = root;
    for (const segment of relative.split('/')) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('publication receipt file may not traverse a symbolic link');
    }
    const stat = fs.statSync(requested);
    if (stat.size > 8 * 1024 * 1024) throw new Error('publication receipt exceeds the 8 MiB verification limit');
    receipt = JSON.parse(fs.readFileSync(requested, 'utf8'));
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  if (errors.length) return { ok: false, status: 'blocked', errors };
  return verifyPublicationReceipt(receipt, { ...options, receiptPath: relative });
}
