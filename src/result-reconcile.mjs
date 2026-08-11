// Fail-closed reconciliation for machine-readable task results.
//
// The presence lane answers "who is working where?". This adjacent, machine-
// local ledger answers the narrower completion question: "did another recent
// session publish a different answer for the same result claim?". The ledger is
// intentionally separate from brain cards: free-form prose and contradiction
// heuristics are useful memory, but they are not an evidence gate.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { laneFileFor } from './agent-presence.mjs';

export const RESULT_MANIFEST_SCHEMA_VERSION = 1;
export const RESULT_LEDGER_SCHEMA_VERSION = 1;
export const RESULT_RECEIPT_SCHEMA_VERSION = 1;
export const RESULT_LEDGER_FRESH_MS = 24 * 60 * 60 * 1000;

const CLAIM_KEY_RE = /^[a-z0-9][a-z0-9._:/-]{2,159}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^[a-f0-9]{7,64}$/;
const METRIC_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

const isPlainObject = (value) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);

function rejectUnknownKeys(raw, allowed, label, errors) {
  if (!isPlainObject(raw)) return;
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) errors.push(`unknown ${label} field(s): ${unknown.join(', ')}`);
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not valid result provenance');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic result provenance is not supported');
    seen.add(value);
    const out = value.map((item) => canonicalValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError('cyclic result provenance is not supported');
    seen.add(value);
    // A null-prototype accumulator makes every JSON key data. Assigning an
    // untrusted `__proto__` key to a normal object invokes its legacy setter,
    // silently dropping provenance from the canonical hash.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`undefined value at ${key}`);
      out[key] = canonicalValue(value[key], seen);
    }
    seen.delete(value);
    return out;
  }
  throw new TypeError(`unsupported result provenance value: ${typeof value}`);
}

export function stableResultJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256ResultValue(value) {
  return crypto.createHash('sha256').update(stableResultJson(value)).digest('hex');
}

const sha256File = (file) => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
};

const normalizedSha = (value) => String(value || '').trim().toLowerCase();

const pathInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function resolveReport(projectRoot, reportPath) {
  const value = String(reportPath || '').replace(/\\/g, '/').trim();
  if (!value) throw new Error('report.path is required');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('/')) {
    throw new Error('report.path must be project-relative');
  }
  const root = fs.realpathSync.native(path.resolve(projectRoot));
  const requested = path.resolve(root, value);
  let real;
  try { real = fs.realpathSync.native(requested); }
  catch { throw new Error(`report.path does not exist: ${value}`); }
  if (!pathInside(root, real)) throw new Error('report.path escapes the project root');
  if (!fs.statSync(real).isFile()) throw new Error('report.path must identify a file');
  return { path: value, file: real };
}

function validateContextBlock(raw, label, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be an object with details and fingerprint`);
    return null;
  }
  rejectUnknownKeys(raw, new Set(['details', 'fingerprint']), label, errors);
  if (!isPlainObject(raw.details) || Object.keys(raw.details).length === 0) {
    errors.push(`${label}.details must be a non-empty object`);
    return null;
  }
  let details;
  let expected;
  try {
    details = canonicalValue(raw.details);
    expected = sha256ResultValue(details);
  } catch (error) {
    errors.push(`${label}.details is not canonical JSON: ${error?.message || error}`);
    return null;
  }
  const fingerprint = normalizedSha(raw.fingerprint);
  if (typeof raw.fingerprint !== 'string' || !SHA256_RE.test(fingerprint)) {
    errors.push(`${label}.fingerprint must be a SHA-256 hex digest`);
  }
  else if (fingerprint !== expected) errors.push(`${label}.fingerprint does not match ${label}.details`);
  return { fingerprint, details };
}

function validateMetrics(raw, errors) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    errors.push('metrics must be a non-empty object');
    return null;
  }
  if (Object.keys(raw).length > 64) errors.push('metrics may contain at most 64 entries');
  const metrics = {};
  for (const name of Object.keys(raw).sort()) {
    const metric = raw[name];
    if (!METRIC_KEY_RE.test(name)) errors.push(`invalid metric key: ${name}`);
    if (!isPlainObject(metric)) {
      errors.push(`metrics.${name} must be an object`);
      continue;
    }
    rejectUnknownKeys(metric, new Set(['value', 'count', 'tolerance', 'numerator']), `metrics.${name}`, errors);
    const value = metric.value;
    const count = metric.count;
    const tolerance = metric.tolerance;
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`metrics.${name}.value must be finite`);
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) errors.push(`metrics.${name}.count must be a positive integer`);
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
      errors.push(`metrics.${name}.tolerance must be an explicit non-negative number`);
    }
    let numerator;
    if (metric.numerator !== undefined) {
      numerator = metric.numerator;
      if (typeof numerator !== 'number' || !Number.isInteger(numerator)
        || numerator < 0 || (Number.isInteger(count) && numerator > count)) {
        errors.push(`metrics.${name}.numerator must be an integer between 0 and count`);
      } else if (Number.isFinite(value) && Number.isInteger(count)
        && Math.abs(value - (numerator / count)) > 1e-12) {
        errors.push(`metrics.${name}.value must exactly equal numerator/count`);
      }
    }
    metrics[name] = {
      value,
      count,
      tolerance,
      ...(metric.numerator !== undefined ? { numerator } : {}),
    };
  }
  return metrics;
}

export function validateResultManifest(raw, { projectRoot, verifyReport = true } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['result manifest must be an object'], manifest: null };
  }
  const allowedTopLevel = new Set([
    'schemaVersion', 'claimKey', 'report', 'provenance', 'input', 'configuration', 'metrics',
  ]);
  const unknownTopLevel = Object.keys(raw).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length) {
    errors.push(`unknown top-level result field(s): ${unknownTopLevel.sort().join(', ')}`);
  }
  if (raw.schemaVersion !== RESULT_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RESULT_MANIFEST_SCHEMA_VERSION}`);
  }
  const claimKey = typeof raw.claimKey === 'string' ? raw.claimKey.trim() : '';
  if (typeof raw.claimKey !== 'string' || !CLAIM_KEY_RE.test(claimKey)) {
    errors.push('claimKey must be a stable lowercase key (3-160 characters)');
  }

  let report = null;
  if (!isPlainObject(raw.report)) {
    errors.push('report must be an object with project-relative path and sha256');
  } else {
    rejectUnknownKeys(raw.report, new Set(['path', 'sha256']), 'report', errors);
    const declaredHash = normalizedSha(raw.report.sha256);
    if (typeof raw.report.path !== 'string') errors.push('report.path must be a string');
    if (typeof raw.report.sha256 !== 'string' || !SHA256_RE.test(declaredHash)) {
      errors.push('report.sha256 must be a SHA-256 hex digest');
    }
    try {
      if (verifyReport) {
        if (!projectRoot) throw new Error('project root is required to verify report.path');
        const resolved = resolveReport(projectRoot, raw.report.path);
        const actualHash = sha256File(resolved.file);
        if (SHA256_RE.test(declaredHash) && actualHash !== declaredHash) {
          errors.push('report.sha256 does not match the report file');
        }
        report = { path: resolved.path, sha256: declaredHash };
      } else {
        const reportPath = String(raw.report.path || '').replace(/\\/g, '/').trim();
        if (!reportPath) errors.push('report.path is required');
        report = { path: reportPath, sha256: declaredHash };
      }
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  let provenance = null;
  if (!isPlainObject(raw.provenance)) {
    errors.push('provenance must be an object');
  } else {
    rejectUnknownKeys(raw.provenance, new Set(['producer', 'runId', 'gitCommit', 'dirtyDigest']), 'provenance', errors);
    const producer = typeof raw.provenance.producer === 'string' ? raw.provenance.producer.trim() : '';
    const runId = typeof raw.provenance.runId === 'string' ? raw.provenance.runId.trim() : '';
    const gitCommit = typeof raw.provenance.gitCommit === 'string'
      ? raw.provenance.gitCommit.trim().toLowerCase() : '';
    const dirtyDigest = normalizedSha(raw.provenance.dirtyDigest);
    if (typeof raw.provenance.producer !== 'string' || !producer || producer.length > 160) {
      errors.push('provenance.producer is required (max 160 characters)');
    }
    if (typeof raw.provenance.runId !== 'string' || !runId || runId.length > 160) {
      errors.push('provenance.runId is required (max 160 characters)');
    }
    if (typeof raw.provenance.gitCommit !== 'string' || !GIT_COMMIT_RE.test(gitCommit)) {
      errors.push('provenance.gitCommit must be a 7-64 character hex commit id');
    }
    if (typeof raw.provenance.dirtyDigest !== 'string' || !SHA256_RE.test(dirtyDigest)) {
      errors.push('provenance.dirtyDigest must be a SHA-256 hex digest');
    }
    provenance = { producer, runId, gitCommit, dirtyDigest };
  }

  const input = validateContextBlock(raw.input, 'input', errors);
  const configuration = validateContextBlock(raw.configuration, 'configuration', errors);
  const metrics = validateMetrics(raw.metrics, errors);
  if (errors.length) return { ok: false, errors, manifest: null };

  const manifest = {
    schemaVersion: RESULT_MANIFEST_SCHEMA_VERSION,
    claimKey,
    report,
    provenance,
    input,
    configuration,
    metrics,
  };
  return {
    ok: true,
    errors: [],
    manifest,
    manifestHash: sha256ResultValue(manifest),
  };
}

export const resultInputFingerprint = (manifest) => String(manifest?.input?.fingerprint || '');
export const resultConfigurationFingerprint = (manifest) => String(manifest?.configuration?.fingerprint || '');

export function compareResultManifests(left, right) {
  if (!left || !right || left.claimKey !== right.claimKey) return { status: 'unrelated', conflicts: [] };
  const conflicts = [];
  if (resultInputFingerprint(left) !== resultInputFingerprint(right)) {
    conflicts.push({
      kind: 'input-fingerprint-mismatch',
      severity: 'blocking',
      left: resultInputFingerprint(left),
      right: resultInputFingerprint(right),
    });
  }
  if (resultConfigurationFingerprint(left) !== resultConfigurationFingerprint(right)) {
    conflicts.push({
      kind: 'configuration-fingerprint-mismatch',
      severity: 'blocking',
      left: resultConfigurationFingerprint(left),
      right: resultConfigurationFingerprint(right),
    });
  }
  if (conflicts.length) return { status: 'incomparable', conflicts };

  const leftNames = Object.keys(left.metrics || {}).sort();
  const rightNames = Object.keys(right.metrics || {}).sort();
  if (leftNames.join('\n') !== rightNames.join('\n')) {
    return {
      status: 'incomparable',
      conflicts: [{
        kind: 'metric-set-mismatch',
        severity: 'blocking',
        left: leftNames,
        right: rightNames,
      }],
    };
  }

  let incomparable = false;
  for (const name of leftNames) {
    const a = left.metrics[name];
    const b = right.metrics[name];
    if (a.count !== b.count) {
      conflicts.push({ kind: 'metric-count-mismatch', severity: 'blocking', metric: name, left: a.count, right: b.count });
      continue;
    }
    if (a.tolerance !== b.tolerance) {
      incomparable = true;
      conflicts.push({
        kind: 'metric-tolerance-mismatch',
        severity: 'blocking',
        metric: name,
        left: a.tolerance,
        right: b.tolerance,
      });
      continue;
    }
    const aHasNumerator = Object.hasOwn(a, 'numerator');
    const bHasNumerator = Object.hasOwn(b, 'numerator');
    if (aHasNumerator !== bHasNumerator) {
      incomparable = true;
      conflicts.push({ kind: 'metric-contract-mismatch', severity: 'blocking', metric: name });
      continue;
    }
    if (aHasNumerator && a.numerator !== b.numerator) {
      conflicts.push({
        kind: 'metric-numerator-mismatch',
        severity: 'blocking',
        metric: name,
        left: a.numerator,
        right: b.numerator,
      });
      continue;
    }
    if (Math.abs(a.value - b.value) > a.tolerance) {
      conflicts.push({
        kind: 'metric-value-mismatch',
        severity: 'blocking',
        metric: name,
        left: a.value,
        right: b.value,
        tolerance: a.tolerance,
      });
    }
  }
  if (conflicts.length) return { status: incomparable ? 'incomparable' : 'conflict', conflicts };
  return { status: 'corroborated', conflicts: [] };
}

export function reconcileResults(submitted, existing) {
  const conflicts = [];
  const claims = [];
  let corroborated = false;
  for (const manifest of submitted || []) {
    const peers = (existing || []).filter((entry) => (entry.manifest || entry)?.claimKey === manifest.claimKey);
    let claimStatus = peers.length ? 'corroborated' : 'unique';
    for (const peer of peers) {
      const comparison = compareResultManifests(manifest, peer.manifest || peer);
      if (comparison.status === 'conflict' || comparison.status === 'incomparable') {
        claimStatus = comparison.status;
        for (const conflict of comparison.conflicts) {
          conflicts.push({
            claimKey: manifest.claimKey,
            peerSessionId: peer.sessionId || null,
            peerRunId: (peer.manifest || peer)?.provenance?.runId || null,
            peerManifestHash: peer.manifestHash || null,
            ...conflict,
          });
        }
      }
    }
    if (claimStatus === 'corroborated') corroborated = true;
    claims.push({ claimKey: manifest.claimKey, status: claimStatus, peerCount: peers.length });
  }
  return {
    ok: conflicts.length === 0,
    status: conflicts.length ? 'needs-reconciliation' : (corroborated ? 'corroborated' : 'unique'),
    claims,
    conflicts,
  };
}

export function resultLedgerFileFor(brainPath, home) {
  return laneFileFor(brainPath, home).replace(/\.json$/i, '.results.json');
}

const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort */ }
};

function acquireLock(lockFile, { tries = 30, waitMs = 20, staleMs = 30_000 } = {}) {
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); }
  catch { return false; }
  for (let i = 0; i < tries; i++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch { /* raced with the lock owner */ }
      sleepSync(waitMs);
    }
  }
  return false;
}

const releaseLock = (lockFile) => {
  try { fs.unlinkSync(lockFile); }
  catch { /* best effort */ }
};

function readLedger(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(value) || value.schemaVersion !== RESULT_LEDGER_SCHEMA_VERSION || !Array.isArray(value.entries)) {
      throw new Error('result ledger has an unsupported schema');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: RESULT_LEDGER_SCHEMA_VERSION, entries: [] };
    throw error;
  }
}

function writeLedgerAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, payload);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.renameSync(tmp, file); }
    catch { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw error; }
  }
}

const invalidResult = (kind, detail, extras = {}) => ({
  ok: false,
  status: 'needs-reconciliation',
  ledgerWriteOk: extras.ledgerWriteOk ?? null,
  claims: extras.claims || [],
  conflicts: [{ kind, severity: 'blocking', ...detail }],
});

export function recordResultManifests({
  brainPath,
  projectRoot,
  sessionId,
  results,
  home,
  now = Date.now(),
  freshMs = RESULT_LEDGER_FRESH_MS,
} = {}) {
  if (!brainPath || !projectRoot || !sessionId) {
    return invalidResult('result-ledger-unavailable', { reason: 'missing brain, project root, or session id' });
  }
  if (!Array.isArray(results) || results.length === 0 || results.length > 8) {
    return invalidResult('invalid-result-submission', { reason: 'results must contain 1-8 manifests' });
  }

  const manifests = [];
  const manifestHashes = [];
  const validationConflicts = [];
  const seenClaims = new Set();
  for (let index = 0; index < results.length; index++) {
    const checked = validateResultManifest(results[index], { projectRoot, verifyReport: true });
    if (!checked.ok) {
      validationConflicts.push({
        kind: 'invalid-result-manifest',
        severity: 'blocking',
        resultIndex: index,
        errors: checked.errors,
      });
      continue;
    }
    if (seenClaims.has(checked.manifest.claimKey)) {
      validationConflicts.push({
        kind: 'duplicate-result-claim',
        severity: 'blocking',
        resultIndex: index,
        claimKey: checked.manifest.claimKey,
      });
      continue;
    }
    seenClaims.add(checked.manifest.claimKey);
    manifests.push(checked.manifest);
    manifestHashes.push(checked.manifestHash);
  }
  if (validationConflicts.length) {
    return {
      ok: false,
      status: 'needs-reconciliation',
      ledgerWriteOk: null,
      claims: manifests.map((manifest) => ({ claimKey: manifest.claimKey, status: 'invalid', peerCount: 0 })),
      conflicts: validationConflicts,
    };
  }

  const ledgerFile = resultLedgerFileFor(brainPath, home);
  const lockFile = `${ledgerFile}.lock`;
  if (!acquireLock(lockFile)) {
    return invalidResult('result-ledger-write-failed', { reason: 'result ledger is locked' }, { ledgerWriteOk: false });
  }
  try {
    const data = readLedger(ledgerFile);
    const freshEntries = data.entries.filter((entry) => entry?.sessionId && entry?.manifest
      && now - Number(entry.recordedAt || 0) < freshMs);
    const submittedClaims = new Set(manifests.map((manifest) => manifest.claimKey));
    const peerEntries = [];
    const peerValidationConflicts = [];
    for (const entry of freshEntries) {
      if (entry.sessionId === sessionId || !submittedClaims.has(entry.manifest?.claimKey)) continue;
      const checked = validateResultManifest(entry.manifest, { projectRoot, verifyReport: true });
      if (!checked.ok) {
        peerValidationConflicts.push({
          kind: 'peer-result-invalid',
          severity: 'blocking',
          claimKey: entry.manifest?.claimKey || null,
          peerSessionId: entry.sessionId,
          peerRunId: entry.manifest?.provenance?.runId || null,
          peerManifestHash: entry.manifestHash || null,
          errors: checked.errors,
        });
      } else {
        peerEntries.push({
          ...entry,
          manifest: checked.manifest,
          manifestHash: checked.manifestHash,
        });
      }
    }

    const reconciliation = reconcileResults(manifests, peerEntries);
    if (peerValidationConflicts.length) {
      reconciliation.ok = false;
      reconciliation.status = 'needs-reconciliation';
      reconciliation.conflicts.push(...peerValidationConflicts);
    }
    const kept = freshEntries.filter((entry) => !(entry.sessionId === sessionId
      && submittedClaims.has(entry.manifest?.claimKey)));
    for (let index = 0; index < manifests.length; index++) {
      kept.push({
        sessionId: String(sessionId),
        recordedAt: now,
        claimKey: manifests[index].claimKey,
        manifestHash: manifestHashes[index],
        manifest: manifests[index],
      });
    }
    const receipt = {
      schemaVersion: RESULT_RECEIPT_SCHEMA_VERSION,
      generatedAt: now,
      status: reconciliation.status,
      machineLocal: true,
      ledgerFreshMs: freshMs,
      claims: manifests.map((manifest, index) => ({
        claimKey: manifest.claimKey,
        status: reconciliation.claims.find((claim) => claim.claimKey === manifest.claimKey)?.status || 'unique',
        submitted: {
          runId: manifest.provenance.runId,
          manifestHash: manifestHashes[index],
          reportSha256: manifest.report.sha256,
          inputFingerprint: manifest.input.fingerprint,
          configurationFingerprint: manifest.configuration.fingerprint,
        },
        compared: peerEntries
          .filter((entry) => entry.manifest.claimKey === manifest.claimKey)
          .map((entry) => ({
            runId: entry.manifest.provenance.runId,
            manifestHash: entry.manifestHash,
            reportSha256: entry.manifest.report.sha256,
            inputFingerprint: entry.manifest.input.fingerprint,
            configurationFingerprint: entry.manifest.configuration.fingerprint,
          }))
          .sort((a, b) => a.runId.localeCompare(b.runId) || a.manifestHash.localeCompare(b.manifestHash)),
      })),
      // Session ids are machine-local diagnostics. The portable receipt keeps
      // peer run ids + hashes instead, so it can be committed beside a report.
      conflicts: reconciliation.conflicts.map(({ peerSessionId, ...conflict }) => conflict),
    };
    const receiptHash = sha256ResultValue(receipt);
    writeLedgerAtomic(ledgerFile, JSON.stringify({
      schemaVersion: RESULT_LEDGER_SCHEMA_VERSION,
      updatedAt: now,
      entries: kept.slice(-80),
    }));
    return {
      ...reconciliation,
      ledgerWriteOk: true,
      ledgerFreshMs: freshMs,
      machineLocal: true,
      receipt,
      receiptHash,
    };
  } catch (error) {
    return invalidResult('result-ledger-write-failed', {
      reason: error?.message || String(error),
    }, { ledgerWriteOk: false });
  } finally {
    releaseLock(lockFile);
  }
}
