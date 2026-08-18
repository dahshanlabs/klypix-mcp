// Client-side release verification for the automatic updater.
//
// The publish side already attests SLSA provenance (the publish workflow
// refuses to go green unless the registry document carries
// dist.attestations.provenance — see .github/workflows/publish.yml). Until this
// module existed, NO adopter machine checked any of that before installing: a
// compromised npm publish (stolen token, hijacked maintainer account) would
// have auto-installed on every adopter machine within one 24h check cycle.
//
// verifyReleaseProvenance() closes that gap. Before mcp-auto-update.mjs hands a
// version to the installer it now proves, from the client:
//
//   (a) ARTIFACT INTEGRITY — the exact-version tarball downloads and its hash
//       matches the registry metadata's dist.integrity (the same value npm
//       itself enforces during install, so the bytes we verified are the bytes
//       npm will install — version metadata on the registry is immutable);
//   (b) PROVENANCE — the version's npm attestation document exists
//       (https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<version>),
//       carries a SLSA provenance predicate, its in-toto subject names this
//       exact package/version (and, when a sha512 digest is present, that
//       digest matches the verified tarball hash), and the predicate's source
//       repository is github.com/dahshanlabs/klypix-mcp.
//
// HONESTY NOTE (do not oversell this in docs or copy): this is existence +
// binding + source-repo verification of the attestation DOCUMENT, not a full
// sigstore cryptographic verification of its certificate chain (that would
// require the sigstore dependency tree, which this zero-heavy-deps runtime
// deliberately does not carry). It defeats the realistic attack — a token-theft
// publish, which produces NO provenance or provenance naming the WRONG repo —
// and it fails CLOSED, so an attacker must additionally compromise GitHub
// Actions OIDC publishing from the real repository to get past it.
//
// Failure policy (mirrors the updater's shape):
//   - reason 'refused'  → FAIL CLOSED: keep the current version, write a
//     visible refusal receipt (mcp-auto-update writes result
//     'verification-refused' into .autoupdate-status.json; brain_doctor
//     renders it loudly). Provenance indexing lag on a brand-new publish lands
//     here too — the next 24h cycle simply retries.
//   - reason 'network'  → the registry is unreachable/unhealthy: skip the
//     update quietly through the updater's existing contained-failure path.
//
// Escape hatch: KLYPIX_UPDATE_VERIFY=off|0|false|no disables verification.
// THIS IS DANGEROUS — it restores the pre-verification trust model where any
// npm publish is auto-installed unexamined. It exists only for emergency
// recovery (e.g. the attestation endpoint changes shape and refusals block a
// legitimate security fix); never set it ambiently.
//
// Every fetch seam is injectable so the full decision policy is unit-tested
// with fixtures — the tests never contact npm (same style as mcp-auto-update).

import crypto from 'crypto';
import https from 'https';

export const EXPECTED_REPO = 'github.com/dahshanlabs/klypix-mcp';
export const PACKAGE_NAME = 'klypix-mcp';
const REGISTRY_HOST = 'registry.npmjs.org';

const strictSemver = (value) => /^\d+\.\d+\.\d+$/.test(String(value || '').trim());
const cleanError = (error) => String(error?.message || error || 'unknown error')
  .replace(/[\r\n]+/g, ' ')
  .slice(0, 240);

export function updateVerificationEnabled(env = process.env) {
  const value = String(env.KLYPIX_UPDATE_VERIFY ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(value);
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
// Resolves {statusCode, bytes} for any response the server produced; rejects
// ONLY on transport-level failure (DNS, refused, timeout) so the caller can
// separate "registry unreachable" (skip quietly) from "registry answered with
// something we refuse" (fail closed).
function httpsBytes(url, {
  timeoutMs = 15_000,
  maxBytes = 512 * 1024,
  request = https.get,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.1',
        'user-agent': 'klypix-mcp-update-verify',
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        bytes: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

/** Exact-version registry metadata: {statusCode, meta} (meta null unless 200 + valid JSON). */
export async function fetchVersionMetadata(version, { packageName = PACKAGE_NAME, timeoutMs, request } = {}) {
  const { statusCode, bytes } = await httpsBytes(
    `https://${REGISTRY_HOST}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    { timeoutMs, request, maxBytes: 512 * 1024 },
  );
  if (statusCode !== 200) return { statusCode, meta: null };
  try { return { statusCode, meta: JSON.parse(bytes.toString('utf8')) }; }
  catch { return { statusCode, meta: null }; }
}

/** The published tarball itself: {statusCode, bytes}. */
export async function fetchTarball(url, { timeoutMs = 60_000, maxBytes = 30 * 1024 * 1024, request } = {}) {
  return httpsBytes(url, { timeoutMs, maxBytes, request });
}

/** npm attestation document for <pkg>@<version>: {statusCode, doc}. */
export async function fetchAttestations(version, { packageName = PACKAGE_NAME, timeoutMs, request } = {}) {
  const { statusCode, bytes } = await httpsBytes(
    `https://${REGISTRY_HOST}/-/npm/v1/attestations/${encodeURIComponent(`${packageName}@${version}`)}`,
    { timeoutMs, request, maxBytes: 4 * 1024 * 1024 },
  );
  if (statusCode !== 200) return { statusCode, doc: null };
  try { return { statusCode, doc: JSON.parse(bytes.toString('utf8')) }; }
  catch { return { statusCode, doc: null }; }
}

// ── Integrity (SRI) ──────────────────────────────────────────────────────────
/**
 * Compare a byte buffer against an SRI string ("sha512-<base64>", possibly
 * several space-separated entries). Returns {ok, algorithm, expectedHex,
 * actualHex} — ok false with algorithm null means the SRI string itself was
 * unusable (which the caller must treat as a refusal, never a pass).
 */
export function verifySriIntegrity(bytes, integrity) {
  const entries = String(integrity || '').trim().split(/\s+/).filter(Boolean);
  // Prefer the strongest digest present (SRI semantics); npm publishes sha512.
  const order = ['sha512', 'sha384', 'sha256', 'sha1'];
  const parsed = [];
  for (const entry of entries) {
    const match = entry.match(/^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/);
    if (match) parsed.push({ algorithm: match[1], b64: match[2] });
  }
  parsed.sort((a, b) => order.indexOf(a.algorithm) - order.indexOf(b.algorithm));
  const pick = parsed[0];
  if (!pick || !Buffer.isBuffer(bytes)) return { ok: false, algorithm: null, expectedHex: null, actualHex: null };
  let expectedHex;
  try { expectedHex = Buffer.from(pick.b64, 'base64').toString('hex'); }
  catch { return { ok: false, algorithm: pick.algorithm, expectedHex: null, actualHex: null }; }
  const actualHex = crypto.createHash(pick.algorithm).update(bytes).digest('hex');
  return { ok: !!expectedHex && actualHex === expectedHex, algorithm: pick.algorithm, expectedHex, actualHex };
}

// ── Provenance document ──────────────────────────────────────────────────────
const normalizeRepo = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^git\+/, '')
  .replace(/^https?:\/\//, '')
  .replace(/\.git(?=$|[@#?])/, '')
  .replace(/[@#?].*$/, '')     // strip "@refs/tags/v1.2.3" / fragment / query
  .replace(/\/+$/, '');

/** Pull every plausible source-repository claim out of a SLSA predicate (v1 and v0.2 shapes). */
function predicateRepoCandidates(predicate) {
  const out = [];
  const push = (value) => { if (typeof value === 'string' && value.trim()) out.push(value); };
  if (!predicate || typeof predicate !== 'object') return out;
  // SLSA v1 (what npm OIDC trusted publishing emits today).
  push(predicate?.buildDefinition?.externalParameters?.workflow?.repository);
  for (const dep of Array.isArray(predicate?.buildDefinition?.resolvedDependencies)
    ? predicate.buildDefinition.resolvedDependencies : []) push(dep?.uri);
  // SLSA v0.2 (older npm provenance).
  push(predicate?.invocation?.configSource?.uri);
  for (const material of Array.isArray(predicate?.materials) ? predicate.materials : []) push(material?.uri);
  return out;
}

/**
 * Verify the attestation DOCUMENT (parse defensively — every field is
 * attacker-influenced input until proven otherwise):
 *   - at least one attestation carries a SLSA provenance predicateType;
 *   - its DSSE payload decodes to an in-toto statement;
 *   - the statement's subject names this package@version, and any sha512
 *     subject digest matches the independently verified tarball hash;
 *   - the predicate's source repository normalizes to expectedRepo.
 * Returns {ok, repo, predicateType} or {ok:false, error}.
 */
export function verifyAttestationDocument(doc, {
  packageName = PACKAGE_NAME,
  version,
  tarballSha512Hex = null,
  expectedRepo = EXPECTED_REPO,
} = {}) {
  const attestations = Array.isArray(doc?.attestations) ? doc.attestations : [];
  if (!attestations.length) return { ok: false, error: 'attestation document carries no attestations' };
  const wanted = normalizeRepo(expectedRepo);
  let sawProvenance = false;
  let lastError = 'no SLSA provenance attestation found';
  for (const attestation of attestations) {
    try {
      const predicateType = String(attestation?.predicateType || '');
      if (!/slsa\.dev\/provenance/i.test(predicateType)) continue;
      sawProvenance = true;
      const payloadB64 = attestation?.bundle?.dsseEnvelope?.payload;
      if (typeof payloadB64 !== 'string' || !payloadB64) { lastError = 'provenance attestation has no DSSE payload'; continue; }
      const statement = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      // Subject binding: the provenance must be ABOUT this artifact — the
      // wrong-subject case is a real substitution attack, not a formality.
      const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
      const subject = subjects.find((s) => String(s?.name || '').includes(packageName));
      if (!subject) { lastError = `provenance subject does not name ${packageName}`; continue; }
      if (version && String(subject.name || '').includes('@') && !String(subject.name).includes(`@${version}`)) {
        lastError = `provenance subject ${String(subject.name).slice(0, 80)} does not name version ${version}`;
        continue;
      }
      const subjectSha512 = String(subject?.digest?.sha512 || '').toLowerCase();
      if (tarballSha512Hex && subjectSha512 && subjectSha512 !== String(tarballSha512Hex).toLowerCase()) {
        lastError = 'provenance subject sha512 digest does not match the verified tarball';
        continue;
      }
      const candidates = predicateRepoCandidates(statement?.predicate);
      const matched = candidates.find((candidate) => {
        const repo = normalizeRepo(candidate);
        return repo === wanted || repo.startsWith(`${wanted}/`);
      });
      if (!matched) {
        lastError = candidates.length
          ? `provenance names ${normalizeRepo(candidates[0]).slice(0, 120) || 'an unrecognizable repository'}, expected ${wanted}`
          : 'provenance predicate names no source repository';
        continue;
      }
      return { ok: true, repo: normalizeRepo(matched), predicateType };
    } catch (error) {
      lastError = `unparseable provenance attestation: ${cleanError(error)}`;
    }
  }
  return { ok: false, error: sawProvenance ? lastError : 'no SLSA provenance attestation found' };
}

// ── The decision ─────────────────────────────────────────────────────────────
/**
 * Verify a release before the updater may install it.
 *
 * @returns {Promise<
 *   {ok: true, skipped?: string, integrity?: string, repo?: string, predicateType?: string}
 * | {ok: false, reason: 'refused'|'network', error: string}>}
 */
export async function verifyReleaseProvenance(version, {
  env = process.env,
  packageName = PACKAGE_NAME,
  expectedRepo = EXPECTED_REPO,
  fetchMeta = fetchVersionMetadata,
  fetchTarballBytes = fetchTarball,
  fetchAttestationDoc = fetchAttestations,
} = {}) {
  if (!updateVerificationEnabled(env)) return { ok: true, skipped: 'disabled-by-KLYPIX_UPDATE_VERIFY' };
  if (!strictSemver(version)) return { ok: false, reason: 'refused', error: `refusing to verify invalid version ${JSON.stringify(version)}` };

  // (1) Exact-version metadata → dist.integrity + dist.tarball.
  let metaResult;
  try { metaResult = await fetchMeta(version, { packageName }); }
  catch (error) { return { ok: false, reason: 'network', error: `registry metadata unreachable: ${cleanError(error)}` }; }
  if (metaResult?.statusCode !== 200) {
    return { ok: false, reason: 'network', error: `registry metadata returned HTTP ${metaResult?.statusCode ?? 'unknown'}` };
  }
  const dist = metaResult?.meta?.dist;
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity : null;
  const tarballUrl = typeof dist?.tarball === 'string' ? dist.tarball : null;
  if (!integrity || !tarballUrl) {
    return { ok: false, reason: 'refused', error: 'registry metadata carries no dist.integrity/dist.tarball to verify against' };
  }
  // The artifact must come from the registry we resolved metadata from — a
  // metadata document pointing the download elsewhere is itself a red flag.
  let tarballHost = null;
  try { tarballHost = new URL(tarballUrl).host; } catch { tarballHost = null; }
  if (tarballHost !== REGISTRY_HOST || !tarballUrl.startsWith('https://')) {
    return { ok: false, reason: 'refused', error: `dist.tarball points off-registry (${String(tarballHost || tarballUrl).slice(0, 120)})` };
  }

  // (2) Download and hash the tarball against dist.integrity.
  let tarballResult;
  try { tarballResult = await fetchTarballBytes(tarballUrl); }
  catch (error) { return { ok: false, reason: 'network', error: `tarball unreachable: ${cleanError(error)}` }; }
  if (tarballResult?.statusCode !== 200 || !Buffer.isBuffer(tarballResult?.bytes)) {
    return { ok: false, reason: 'network', error: `tarball download returned HTTP ${tarballResult?.statusCode ?? 'unknown'}` };
  }
  const sri = verifySriIntegrity(tarballResult.bytes, integrity);
  if (!sri.ok) {
    return {
      ok: false,
      reason: 'refused',
      error: sri.algorithm
        ? `tarball ${sri.algorithm} hash does not match registry dist.integrity`
        : 'registry dist.integrity is not a usable SRI string',
    };
  }
  const tarballSha512Hex = sri.algorithm === 'sha512'
    ? sri.actualHex
    : crypto.createHash('sha512').update(tarballResult.bytes).digest('hex');

  // (3) The attestation must exist and its provenance must point at our repo.
  let attResult;
  try { attResult = await fetchAttestationDoc(version, { packageName }); }
  catch (error) { return { ok: false, reason: 'network', error: `attestation endpoint unreachable: ${cleanError(error)}` }; }
  if (attResult?.statusCode === 404) {
    // FAIL CLOSED: a legitimate release of this package always attests (the
    // publish workflow verifies it on the registry before going green). A
    // fresh publish whose attestation is still indexing lands here too — the
    // next 24h cycle retries; a token-theft publish stays refused forever.
    return { ok: false, reason: 'refused', error: `no attestation exists for ${packageName}@${version}` };
  }
  if (attResult?.statusCode !== 200 || !attResult?.doc) {
    return { ok: false, reason: 'network', error: `attestation endpoint returned HTTP ${attResult?.statusCode ?? 'unknown'}` };
  }
  const verdict = verifyAttestationDocument(attResult.doc, {
    packageName,
    version,
    tarballSha512Hex,
    expectedRepo,
  });
  if (!verdict.ok) return { ok: false, reason: 'refused', error: verdict.error };
  return { ok: true, integrity, repo: verdict.repo, predicateType: verdict.predicateType };
}

export const __test = {
  normalizeRepo,
  predicateRepoCandidates,
  httpsBytes,
};
