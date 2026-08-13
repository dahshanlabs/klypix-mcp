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

export const LEGACY_RESULT_MANIFEST_SCHEMA_VERSION = 1;
export const RESULT_MANIFEST_SCHEMA_VERSION = 2;
export const RESULT_LEDGER_SCHEMA_VERSION = 1;
export const RESULT_RECEIPT_SCHEMA_VERSION = 2;
export const EVALUATION_ARTIFACT_SCHEMA_VERSION = 1;
export const RESULT_LEDGER_FRESH_MS = 24 * 60 * 60 * 1000;

const CLAIM_KEY_RE = /^[a-z0-9][a-z0-9._:/-]{2,159}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^[a-f0-9]{7,64}$/;
const GIT_FULL_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const METRIC_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const KIND_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9._/%-]{0,31}$/;

const isPlainObject = (value) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);

function rejectUnknownKeys(raw, allowed, label, errors) {
  if (!isPlainObject(raw)) return;
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) errors.push(`unknown ${label} field(s): ${unknown.join(', ')}`);
}

function canonicalValue(value, seen = new Set(), state = { depth: 0, nodes: 0 }) {
  state.nodes++;
  if (state.nodes > 100_000) throw new TypeError('result provenance exceeds the 100000-node limit');
  if (state.depth > 64) throw new TypeError('result provenance exceeds the 64-level depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not valid result provenance');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic result provenance is not supported');
    seen.add(value);
    state.depth++;
    try { return value.map((item) => canonicalValue(item, seen, state)); }
    finally { state.depth--; seen.delete(value); }
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError('cyclic result provenance is not supported');
    seen.add(value);
    // A null-prototype accumulator makes every JSON key data. Assigning an
    // untrusted `__proto__` key to a normal object invokes its legacy setter,
    // silently dropping provenance from the canonical hash.
    const out = Object.create(null);
    state.depth++;
    try {
      for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) throw new TypeError(`undefined value at ${key}`);
        out[key] = canonicalValue(value[key], seen, state);
      }
      return out;
    } finally { state.depth--; seen.delete(value); }
  }
  throw new TypeError(`unsupported result provenance value: ${typeof value}`);
}

export function stableResultJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256ResultValue(value) {
  return crypto.createHash('sha256').update(stableResultJson(value)).digest('hex');
}

const sha256File = (file, { maxBytes = 64 * 1024 * 1024 } = {}) => {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte verification limit`);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (read <= 0) throw new Error('file changed or became unreadable during hashing');
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw new Error('file changed size during hashing');
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

const normalizedSha = (value) => String(value || '').trim().toLowerCase();

const pathInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function normalizedProjectPath(raw, label = 'path') {
  if (typeof raw !== 'string') throw new Error(`${label} must be a string`);
  const value = raw.replace(/\\/g, '/').trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.length > 512) throw new Error(`${label} is too long`);
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('/')) {
    throw new Error(`${label} must be project-relative`);
  }
  if (/[*?\[\]{}]/.test(value)) throw new Error(`${label} must be an exact file path, not a glob`);
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`${label} escapes the project root`);
  }
  if (normalized !== value || value.endsWith('/')) {
    throw new Error(`${label} must use canonical project-relative form`);
  }
  return value;
}

function resolveProjectFile(projectRoot, rawPath, label = 'path') {
  const value = normalizedProjectPath(rawPath, label);
  if (!projectRoot) throw new Error('project root is required to verify project files');
  const root = fs.realpathSync.native(path.resolve(projectRoot));
  let cursor = root;
  for (const segment of value.split('/')) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch { throw new Error(`${label} does not exist: ${value}`); }
    if (stat.isSymbolicLink()) throw new Error(`${label} may not traverse a symbolic link: ${value}`);
  }
  const requested = path.resolve(root, ...value.split('/'));
  if (!pathInside(root, requested)) throw new Error(`${label} escapes the project root`);
  const real = fs.realpathSync.native(requested);
  if (!pathInside(root, real)) throw new Error(`${label} escapes the project root`);
  if (!fs.statSync(real).isFile()) throw new Error(`${label} must identify a file`);
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

function validateMetrics(raw, errors, { requireUnit = false } = {}) {
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
    rejectUnknownKeys(metric, new Set(['value', 'count', 'tolerance', 'numerator', 'unit']), `metrics.${name}`, errors);
    const value = metric.value;
    const count = metric.count;
    const tolerance = metric.tolerance;
    const unit = typeof metric.unit === 'string' ? metric.unit.trim() : '';
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`metrics.${name}.value must be finite`);
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) errors.push(`metrics.${name}.count must be a positive integer`);
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
      errors.push(`metrics.${name}.tolerance must be an explicit non-negative number`);
    }
    if (requireUnit && (typeof metric.unit !== 'string' || !UNIT_RE.test(unit))) {
      errors.push(`metrics.${name}.unit must be a stable unit key`);
    } else if (!requireUnit && metric.unit !== undefined
      && (typeof metric.unit !== 'string' || !UNIT_RE.test(unit))) {
      errors.push(`metrics.${name}.unit must be a stable unit key when supplied`);
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
      ...(metric.unit !== undefined || requireUnit ? { unit } : {}),
      ...(metric.numerator !== undefined ? { numerator } : {}),
    };
  }
  return metrics;
}

export function evaluationArtifactContract({
  name,
  claimKey,
  scopeFingerprint,
  producer,
  runId,
  gitCommit,
  dirtyDigest,
  inputFingerprint,
  configurationFingerprint,
  metrics,
} = {}) {
  return {
    schemaVersion: EVALUATION_ARTIFACT_SCHEMA_VERSION,
    evaluation: name,
    claimKey,
    scopeFingerprint,
    provenance: { producer, runId, gitCommit, dirtyDigest },
    inputFingerprint,
    configurationFingerprint,
    metrics,
  };
}

// Evaluation artifacts use one canonical UTF-8 JSON line. This deliberately
// rejects duplicate JSON keys, parser-dependent representations, hidden extra
// fields, and a report whose declared SHA is valid but whose metric payload is
// unrelated to the values in the signed result manifest.
export const evaluationArtifactJson = (contract) => `${stableResultJson(contract)}\n`;

function validateReport(raw, { projectRoot, verifyFiles }, errors) {
  if (!isPlainObject(raw)) {
    errors.push('report must be an object with project-relative path and sha256');
    return null;
  }
  rejectUnknownKeys(raw, new Set(['path', 'sha256']), 'report', errors);
  const declaredHash = normalizedSha(raw.sha256);
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(declaredHash)) {
    errors.push('report.sha256 must be a SHA-256 hex digest');
  }
  try {
    const resolved = verifyFiles
      ? resolveProjectFile(projectRoot, raw.path, 'report.path')
      : { path: normalizedProjectPath(raw.path, 'report.path') };
    if (verifyFiles && SHA256_RE.test(declaredHash) && sha256File(resolved.file) !== declaredHash) {
      errors.push('report.sha256 does not match the report file');
    }
    return { path: resolved.path, sha256: declaredHash };
  } catch (error) {
    errors.push(error?.message || String(error));
    return null;
  }
}

function normalizedScope(raw, label, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be an object with intent and files`);
    return null;
  }
  rejectUnknownKeys(raw, new Set(['intent', 'files']), label, errors);
  const intent = typeof raw.intent === 'string' ? raw.intent.trim() : '';
  if (typeof raw.intent !== 'string' || !intent || intent.length > 1_000) {
    errors.push(`${label}.intent is required (max 1000 characters)`);
  } else if (raw.intent !== intent) {
    errors.push(`${label}.intent must be in canonical trimmed form`);
  }
  if (!Array.isArray(raw.files) || raw.files.length > 256) {
    errors.push(`${label}.files must be an array of at most 256 exact project-relative paths`);
    return { intent, files: [] };
  }
  const files = [];
  const seen = new Set();
  for (let index = 0; index < raw.files.length; index++) {
    try {
      const file = normalizedProjectPath(raw.files[index], `${label}.files[${index}]`);
      const key = file.toLowerCase();
      if (seen.has(key)) errors.push(`${label}.files contains a duplicate path: ${file}`);
      else {
        seen.add(key);
        files.push(file);
      }
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return { intent, files };
}

export function normalizeDeclaredResultScope(raw) {
  const errors = [];
  const scope = normalizedScope(raw, 'declaredScope', errors);
  return {
    ok: errors.length === 0,
    errors,
    scope: errors.length ? null : scope,
    ...(errors.length ? {} : { fingerprint: sha256ResultValue(scope) }),
  };
}

function validateArtifacts(raw, { projectRoot, verifyFiles }, errors) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
    errors.push('artifacts must contain 1-64 material artifact declarations');
    return [];
  }
  const artifacts = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      errors.push(`artifacts[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(item, new Set(['path', 'sha256', 'kind']), `artifacts[${index}]`, errors);
    const sha256 = normalizedSha(item.sha256);
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    if (typeof item.sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      errors.push(`artifacts[${index}].sha256 must be a SHA-256 hex digest`);
    }
    if (typeof item.kind !== 'string' || !KIND_RE.test(kind)) {
      errors.push(`artifacts[${index}].kind must be a stable lowercase key`);
    }
    try {
      const resolved = verifyFiles
        ? resolveProjectFile(projectRoot, item.path, `artifacts[${index}].path`)
        : { path: normalizedProjectPath(item.path, `artifacts[${index}].path`) };
      const key = resolved.path.toLowerCase();
      if (seen.has(key)) errors.push(`artifacts contains a duplicate path: ${resolved.path}`);
      else seen.add(key);
      if (verifyFiles && SHA256_RE.test(sha256) && sha256File(resolved.file) !== sha256) {
        errors.push(`artifacts[${index}].sha256 does not match the artifact file`);
      }
      artifacts.push({ path: resolved.path, sha256, kind });
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return artifacts;
}

function validateEvaluations(raw, {
  artifacts,
  metrics,
  projectRoot,
  verifyFiles,
  provenance,
  input,
  configuration,
  claimKey,
  scope,
}, errors) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    errors.push('evaluations must contain 1-32 evaluation output bindings');
    return [];
  }
  const artifactMap = new Map(artifacts.map((item) => [item.path.toLowerCase(), item]));
  const evaluations = [];
  const names = new Set();
  const coveredMetrics = new Set();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      errors.push(`evaluations[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(item, new Set(['name', 'artifact', 'metricKeys', 'resultFingerprint']), `evaluations[${index}]`, errors);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (typeof item.name !== 'string' || !CLAIM_KEY_RE.test(name)) {
      errors.push(`evaluations[${index}].name must be a stable lowercase key`);
    } else if (names.has(name)) errors.push(`evaluations contains a duplicate name: ${name}`);
    else names.add(name);

    let artifact = null;
    if (!isPlainObject(item.artifact)) {
      errors.push(`evaluations[${index}].artifact must contain path and sha256`);
    } else {
      rejectUnknownKeys(item.artifact, new Set(['path', 'sha256']), `evaluations[${index}].artifact`, errors);
      try {
        const artifactPath = normalizedProjectPath(item.artifact.path, `evaluations[${index}].artifact.path`);
        const sha256 = normalizedSha(item.artifact.sha256);
        if (typeof item.artifact.sha256 !== 'string' || !SHA256_RE.test(sha256)) {
          errors.push(`evaluations[${index}].artifact.sha256 must be a SHA-256 hex digest`);
        }
        const declared = artifactMap.get(artifactPath.toLowerCase());
        if (!declared || declared.sha256 !== sha256) {
          errors.push(`evaluations[${index}].artifact must exactly reference a declared artifact`);
        }
        artifact = { path: artifactPath, sha256 };
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }

    const metricKeys = [];
    const localMetrics = new Set();
    if (!Array.isArray(item.metricKeys) || item.metricKeys.length === 0 || item.metricKeys.length > 64) {
      errors.push(`evaluations[${index}].metricKeys must contain 1-64 metric keys`);
    } else {
      for (const metric of item.metricKeys) {
        if (typeof metric !== 'string' || !METRIC_KEY_RE.test(metric)) {
          errors.push(`evaluations[${index}].metricKeys contains an invalid metric key`);
        } else if (localMetrics.has(metric)) {
          errors.push(`evaluations[${index}].metricKeys contains a duplicate: ${metric}`);
        } else {
          localMetrics.add(metric);
          metricKeys.push(metric);
          if (coveredMetrics.has(metric)) {
            errors.push(`evaluations bind metric more than once: ${metric}`);
          }
          coveredMetrics.add(metric);
          if (!Object.hasOwn(metrics || {}, metric)) {
            errors.push(`evaluations[${index}] references an undeclared metric: ${metric}`);
          }
        }
      }
    }
    metricKeys.sort();
    const evaluationMetrics = Object.create(null);
    for (const metric of metricKeys) {
      if (Object.hasOwn(metrics || {}, metric)) evaluationMetrics[metric] = metrics[metric];
    }
    const contract = evaluationArtifactContract({
      name,
      claimKey,
      scopeFingerprint: scope ? sha256ResultValue(scope) : '',
      producer: provenance?.producer || '',
      runId: provenance?.runId || '',
      gitCommit: provenance?.gitCommit || '',
      dirtyDigest: provenance?.dirtyDigest || '',
      inputFingerprint: input?.fingerprint || '',
      configurationFingerprint: configuration?.fingerprint || '',
      metrics: evaluationMetrics,
    });
    const resultFingerprint = sha256ResultValue(contract);
    if (item.resultFingerprint !== undefined
      && (typeof item.resultFingerprint !== 'string'
        || normalizedSha(item.resultFingerprint) !== resultFingerprint)) {
      errors.push(`evaluations[${index}].resultFingerprint does not match the declared metric contract`);
    }
    if (artifact) {
      const declared = artifactMap.get(artifact.path.toLowerCase());
      if (declared && declared.kind !== 'evaluation-result') {
        errors.push(`evaluations[${index}].artifact kind must be evaluation-result`);
      }
      if (verifyFiles) {
        try {
          const resolved = resolveProjectFile(projectRoot, artifact.path, `evaluations[${index}].artifact.path`);
          const stat = fs.statSync(resolved.file);
          if (stat.size > 1024 * 1024) throw new Error(`evaluations[${index}].artifact exceeds the 1 MiB contract limit`);
          const actual = fs.readFileSync(resolved.file, 'utf8');
          const expected = evaluationArtifactJson(contract);
          if (actual !== expected) {
            throw new Error(`evaluations[${index}].artifact content does not exactly bind its declared metrics and provenance`);
          }
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
    }
    evaluations.push({ name, artifact, metricKeys, resultFingerprint });
  }
  const uncovered = Object.keys(metrics || {}).filter((name) => !coveredMetrics.has(name)).sort();
  if (uncovered.length) errors.push(`evaluations do not bind metric(s): ${uncovered.join(', ')}`);
  evaluations.sort((a, b) => a.name.localeCompare(b.name));
  return evaluations;
}

function validatePublicClaims(raw, metrics, errors) {
  if (!Array.isArray(raw) || raw.length > 64) {
    errors.push('publicClaims must be an array of at most 64 metric claims (empty when none)');
    return [];
  }
  const publicClaims = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      errors.push(`publicClaims[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(item, new Set(['key', 'metric', 'value', 'unit', 'statement']), `publicClaims[${index}]`, errors);
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const metric = typeof item.metric === 'string' ? item.metric.trim() : '';
    const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
    const statement = typeof item.statement === 'string' ? item.statement.trim() : '';
    if (typeof item.key !== 'string' || !CLAIM_KEY_RE.test(key)) {
      errors.push(`publicClaims[${index}].key must be a stable lowercase key`);
    } else if (seen.has(key)) errors.push(`publicClaims contains a duplicate key: ${key}`);
    else seen.add(key);
    if (typeof item.metric !== 'string' || !METRIC_KEY_RE.test(metric) || !Object.hasOwn(metrics || {}, metric)) {
      errors.push(`publicClaims[${index}].metric must reference a declared metric`);
    }
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      errors.push(`publicClaims[${index}].value must be finite`);
    } else if (metrics?.[metric] && item.value !== metrics[metric].value) {
      errors.push(`publicClaims[${index}].value must exactly equal metrics.${metric}.value`);
    }
    if (typeof item.unit !== 'string' || !UNIT_RE.test(unit)) {
      errors.push(`publicClaims[${index}].unit must be a stable unit key`);
    } else if (metrics?.[metric] && unit !== metrics[metric].unit) {
      errors.push(`publicClaims[${index}].unit must exactly equal metrics.${metric}.unit`);
    }
    if (typeof item.statement !== 'string' || !statement || statement.length > 500 || item.statement !== statement) {
      errors.push(`publicClaims[${index}].statement is required in canonical trimmed form (max 500 characters)`);
    }
    publicClaims.push({ key, metric, value: item.value, unit, statement });
  }
  publicClaims.sort((a, b) => a.key.localeCompare(b.key));
  return publicClaims;
}

export function validateResultManifest(raw, {
  projectRoot,
  verifyReport = true,
  declaredScope,
  requireDeclaredScope = false,
} = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['result manifest must be an object'], manifest: null, publicationEligible: false };
  }
  const schemaVersion = raw.schemaVersion;
  const v2 = schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION;
  const legacy = schemaVersion === LEGACY_RESULT_MANIFEST_SCHEMA_VERSION;
  const allowedTopLevel = new Set([
    'schemaVersion', 'claimKey', 'report', 'provenance', 'input', 'configuration', 'metrics',
    ...(v2 ? ['scope', 'artifacts', 'evaluations', 'publicClaims'] : []),
  ]);
  const unknownTopLevel = Object.keys(raw).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length) {
    errors.push(`unknown top-level result field(s): ${unknownTopLevel.sort().join(', ')}`);
  }
  if (!v2 && !legacy) {
    errors.push(`schemaVersion must be ${LEGACY_RESULT_MANIFEST_SCHEMA_VERSION} (legacy) or ${RESULT_MANIFEST_SCHEMA_VERSION}`);
  }
  const claimKey = typeof raw.claimKey === 'string' ? raw.claimKey.trim() : '';
  if (typeof raw.claimKey !== 'string' || !CLAIM_KEY_RE.test(claimKey)) {
    errors.push('claimKey must be a stable lowercase key (3-160 characters)');
  }

  const report = validateReport(raw.report, { projectRoot, verifyFiles: verifyReport }, errors);
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
    if (typeof raw.provenance.gitCommit !== 'string'
      || !(v2 ? GIT_FULL_COMMIT_RE : GIT_COMMIT_RE).test(gitCommit)) {
      errors.push(v2
        ? 'provenance.gitCommit must be a full 40- or 64-character commit object id'
        : 'provenance.gitCommit must be a 7-64 character hex commit id');
    }
    if (typeof raw.provenance.dirtyDigest !== 'string' || !SHA256_RE.test(dirtyDigest)) {
      errors.push('provenance.dirtyDigest must be a SHA-256 hex digest');
    }
    provenance = { producer, runId, gitCommit, dirtyDigest };
  }

  const input = validateContextBlock(raw.input, 'input', errors);
  const configuration = validateContextBlock(raw.configuration, 'configuration', errors);
  const metrics = validateMetrics(raw.metrics, errors, { requireUnit: v2 });
  let scope;
  let artifacts;
  let evaluations;
  let publicClaims;
  if (v2) {
    scope = normalizedScope(raw.scope, 'scope', errors);
    artifacts = validateArtifacts(raw.artifacts, { projectRoot, verifyFiles: verifyReport }, errors);
    evaluations = validateEvaluations(raw.evaluations, {
      artifacts,
      metrics,
      projectRoot,
      verifyFiles: verifyReport,
      provenance,
      input,
      configuration,
      claimKey,
      scope,
    }, errors);
    publicClaims = validatePublicClaims(raw.publicClaims, metrics, errors);
    if (report && !artifacts.some((artifact) => artifact.path.toLowerCase() === report.path.toLowerCase()
      && artifact.sha256 === report.sha256)) {
      errors.push('report must exactly reference one declared artifact');
    }
    const scopeFiles = new Set((scope?.files || []).map((file) => file.toLowerCase()));
    const unscopedArtifacts = artifacts.filter((artifact) => !scopeFiles.has(artifact.path.toLowerCase()));
    if (unscopedArtifacts.length) {
      errors.push(`material artifact(s) missing from scope.files: ${unscopedArtifacts.map((item) => item.path).join(', ')}`);
    }
    if (declaredScope !== undefined) {
      const actual = normalizeDeclaredResultScope(declaredScope);
      if (!actual.ok) {
        errors.push(...actual.errors.map((error) => `actual ${error}`));
      } else {
        if (scope?.intent !== actual.scope.intent) errors.push('scope.intent does not match the active declared task intent');
        if ((scope?.files || []).join('\n') !== actual.scope.files.join('\n')) {
          errors.push('scope.files do not exactly match the active declared task files');
        }
      }
    } else if (requireDeclaredScope) {
      errors.push('active declared task scope is required to verify a schema-v2 result');
    }
  }
  if (errors.length) return { ok: false, errors, manifest: null, publicationEligible: false };

  const manifest = {
    schemaVersion,
    claimKey,
    report,
    provenance,
    input,
    configuration,
    metrics,
    ...(v2 ? { scope, artifacts, evaluations, publicClaims } : {}),
  };
  return {
    ok: true,
    errors: [],
    manifest,
    manifestHash: sha256ResultValue(manifest),
    publicationEligible: v2,
  };
}

export const resultInputFingerprint = (manifest) => String(manifest?.input?.fingerprint || '');
export const resultConfigurationFingerprint = (manifest) => String(manifest?.configuration?.fingerprint || '');
export const resultScopeFingerprint = (manifest) => manifest?.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION
  ? sha256ResultValue(manifest.scope) : '';
export const resultArtifactFingerprint = (manifest) => manifest?.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION
  ? sha256ResultValue(manifest.artifacts) : '';
export const resultEvaluationFingerprint = (manifest) => manifest?.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION
  ? sha256ResultValue((manifest.evaluations || []).map(({ name, metricKeys }) => ({ name, metricKeys }))) : '';
export const resultPublicClaimsFingerprint = (manifest) => manifest?.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION
  ? sha256ResultValue(manifest.publicClaims || []) : '';

export function compareResultManifests(left, right) {
  if (!left || !right || left.claimKey !== right.claimKey) return { status: 'unrelated', conflicts: [] };
  const conflicts = [];
  if (left.schemaVersion !== right.schemaVersion) {
    return {
      status: 'incomparable',
      conflicts: [{
        kind: 'manifest-schema-mismatch',
        severity: 'blocking',
        left: left.schemaVersion,
        right: right.schemaVersion,
      }],
    };
  }
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

  if (left.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION) {
    let incomparableV2 = false;
    if (resultScopeFingerprint(left) !== resultScopeFingerprint(right)) {
      incomparableV2 = true;
      conflicts.push({
        kind: 'scope-fingerprint-mismatch',
        severity: 'blocking',
        left: resultScopeFingerprint(left),
        right: resultScopeFingerprint(right),
      });
    }
    if (left.provenance?.gitCommit !== right.provenance?.gitCommit) {
      incomparableV2 = true;
      conflicts.push({
        kind: 'git-commit-mismatch',
        severity: 'blocking',
        left: left.provenance?.gitCommit || '',
        right: right.provenance?.gitCommit || '',
      });
    }
    if (left.provenance?.dirtyDigest !== right.provenance?.dirtyDigest) {
      incomparableV2 = true;
      conflicts.push({
        kind: 'dirty-state-mismatch',
        severity: 'blocking',
        left: left.provenance?.dirtyDigest || '',
        right: right.provenance?.dirtyDigest || '',
      });
    }
    if (resultEvaluationFingerprint(left) !== resultEvaluationFingerprint(right)) {
      incomparableV2 = true;
      conflicts.push({
        kind: 'evaluation-contract-mismatch',
        severity: 'blocking',
        left: resultEvaluationFingerprint(left),
        right: resultEvaluationFingerprint(right),
      });
    }
    const leftClaims = left.publicClaims || [];
    const rightClaims = right.publicClaims || [];
    const leftClaimKeys = leftClaims.map((claim) => claim.key);
    const rightClaimKeys = rightClaims.map((claim) => claim.key);
    if (leftClaimKeys.join('\n') !== rightClaimKeys.join('\n')) {
      incomparableV2 = true;
      conflicts.push({
        kind: 'public-claim-set-mismatch',
        severity: 'blocking',
        left: leftClaimKeys,
        right: rightClaimKeys,
      });
    } else {
      for (let index = 0; index < leftClaims.length; index++) {
        if (stableResultJson(leftClaims[index]) !== stableResultJson(rightClaims[index])) {
          conflicts.push({
            kind: 'public-claim-mismatch',
            severity: 'blocking',
            publicClaim: leftClaims[index].key,
            left: leftClaims[index],
            right: rightClaims[index],
          });
        }
      }
    }
    if (left.provenance?.runId === right.provenance?.runId
      && resultArtifactFingerprint(left) !== resultArtifactFingerprint(right)) {
      conflicts.push({
        kind: 'run-artifact-mismatch',
        severity: 'blocking',
        runId: left.provenance?.runId || '',
        left: resultArtifactFingerprint(left),
        right: resultArtifactFingerprint(right),
      });
    }
    if (conflicts.length) return { status: incomparableV2 ? 'incomparable' : 'conflict', conflicts };
  }

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
    if (a.unit !== b.unit) {
      incomparable = true;
      conflicts.push({
        kind: 'metric-unit-mismatch',
        severity: 'blocking',
        metric: name,
        left: a.unit || null,
        right: b.unit || null,
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
  sessionAliases = [],
  declaredScope,
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
    const checked = validateResultManifest(results[index], {
      projectRoot,
      verifyReport: true,
      declaredScope,
      requireDeclaredScope: results[index]?.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION,
    });
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
    const ownSessionIds = new Set([sessionId, ...(Array.isArray(sessionAliases) ? sessionAliases : [])]
      .map((value) => String(value || '').trim()).filter(Boolean));
    // Presence rekey keeps the provisional id as an explicit alias on the
    // canonical row. Migrate matching ledger entries under this ledger lock so
    // a corrected post-rekey submission can never compare against its own old
    // provisional run as if it came from an independent peer.
    const migratedEntries = data.entries.filter((entry) => entry?.sessionId && entry?.manifest
      && now - Number(entry.recordedAt || 0) < freshMs)
      .map((entry) => ownSessionIds.has(String(entry.sessionId))
        ? { ...entry, sessionId: String(sessionId) }
        : entry);
    const latestBySessionClaim = new Map();
    for (const entry of migratedEntries) {
      const key = `${entry.sessionId}\0${entry.manifest?.claimKey || entry.claimKey || ''}`;
      const prior = latestBySessionClaim.get(key);
      if (!prior || Number(entry.recordedAt || 0) >= Number(prior.recordedAt || 0)) {
        latestBySessionClaim.set(key, entry);
      }
    }
    const freshEntries = [...latestBySessionClaim.values()];
    const submittedClaims = new Set(manifests.map((manifest) => manifest.claimKey));
    const peerEntries = [];
    const peerValidationConflicts = [];
    for (const entry of freshEntries) {
      if (ownSessionIds.has(String(entry.sessionId)) || !submittedClaims.has(entry.manifest?.claimKey)) continue;
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
    const kept = freshEntries.filter((entry) => !(ownSessionIds.has(String(entry.sessionId))
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
      publicationEligible: reconciliation.ok
        && manifests.every((manifest) => manifest.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION),
      machineLocal: true,
      ledgerFreshMs: freshMs,
      claims: manifests.map((manifest, index) => ({
        claimKey: manifest.claimKey,
        status: reconciliation.claims.find((claim) => claim.claimKey === manifest.claimKey)?.status || 'unique',
        submitted: {
          manifestSchemaVersion: manifest.schemaVersion,
          runId: manifest.provenance.runId,
          gitCommit: manifest.provenance.gitCommit,
          manifestHash: manifestHashes[index],
          reportSha256: manifest.report.sha256,
          inputFingerprint: manifest.input.fingerprint,
          configurationFingerprint: manifest.configuration.fingerprint,
          ...(manifest.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION ? {
            scopeFingerprint: resultScopeFingerprint(manifest),
            artifactFingerprint: resultArtifactFingerprint(manifest),
            evaluationFingerprint: resultEvaluationFingerprint(manifest),
            publicClaimsFingerprint: resultPublicClaimsFingerprint(manifest),
          } : {}),
        },
        compared: peerEntries
          .filter((entry) => entry.manifest.claimKey === manifest.claimKey)
          .map((entry) => ({
            manifest: entry.manifest,
            runId: entry.manifest.provenance.runId,
            manifestSchemaVersion: entry.manifest.schemaVersion,
            gitCommit: entry.manifest.provenance.gitCommit,
            manifestHash: entry.manifestHash,
            reportSha256: entry.manifest.report.sha256,
            inputFingerprint: entry.manifest.input.fingerprint,
            configurationFingerprint: entry.manifest.configuration.fingerprint,
            ...(entry.manifest.schemaVersion === RESULT_MANIFEST_SCHEMA_VERSION ? {
              scopeFingerprint: resultScopeFingerprint(entry.manifest),
              artifactFingerprint: resultArtifactFingerprint(entry.manifest),
              evaluationFingerprint: resultEvaluationFingerprint(entry.manifest),
              publicClaimsFingerprint: resultPublicClaimsFingerprint(entry.manifest),
            } : {}),
          }))
          .sort((a, b) => a.runId.localeCompare(b.runId) || a.manifestHash.localeCompare(b.manifestHash))
          .slice(0, 32),
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
