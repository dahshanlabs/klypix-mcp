// Evidence is provenance, not a truth verdict. Capture snapshots the WORKING
// file; HEAD identifies the repository revision but does not certify dirty bytes.
// Verification text is inert data. No caller-provided command is ever executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['file', 'pr', 'url', 'commit', 'run']);
const INPUT_FIELDS = new Set(['kind', 'ref', 'oid', 'verifiedAt']);
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const READ_BUDGET = Symbol('brain-evidence-read-budget');
const flat = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// Permit line anchors, but require portable project-relative file paths at the
// API boundary. Check the nearest existing ancestor to catch missing paths below
// a junction/symlink too. Read-side legacy invalid paths become unverified.
export function resolveEvidenceFile(projectRoot, ref) {
  if (typeof ref !== 'string' || !ref.trim() || /[\x00-\x1f\x7f]/.test(ref)) return null;
  const clean = ref.trim().replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.includes(':')
      || clean.split('/').some(part => !part || part === '.' || part === '..') || /[*?\[\]]/.test(clean)) return null;
  if (!projectRoot) return null;
  const root = path.resolve(projectRoot), target = path.resolve(root, clean);
  if (!inside(root, target)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    let ancestor = target;
    while (!fs.existsSync(ancestor) && ancestor !== root) {
      // existsSync follows symlinks; lstat catches a dangling link.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) return null; } catch { /* missing */ }
      ancestor = path.dirname(ancestor);
    }
    const real = fs.realpathSync(ancestor);
    if (real !== realRoot && !inside(realRoot, real)) return null;
    return { target, relative: clean };
  } catch { return null; }
}

function readSnapshot(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { status: 'unverified' };
    // Bound the read even if another process grows the file after stat.
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, stat.size + 1));
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const after = fs.fstatSync(fd);
      if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return { status: 'unverified' };
      return { status: 'read', sha256: crypto.createHash('sha256').update(buffer.subarray(0, count)).digest('hex') };
    } finally { fs.closeSync(fd); }
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unverified' }; }
}

function git(root, args, timeout = 500) {
  if (timeout <= 0) return null;
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: Math.max(1, Math.min(500, timeout)), maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return null; }
}

function workingTreeStatus(root, relative, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'unverified';
  try {
    execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--quiet', 'HEAD', '--', relative], {
      cwd: root, timeout: Math.max(1, Math.min(500, remaining)), stdio: 'ignore', windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return 'unchanged';
  } catch (error) { return error.status === 1 ? 'changed' : 'unverified'; }
}

export function prepareBrainEvidence({ projectRoot, evidence, verify, marker = '', text = '' } = {}) {
  const bad = error => ({ ok: false, error });
  if (marker === '✓' && (evidence !== undefined || verify !== undefined)) {
    return bad('A resolve marker archives existing evidence. To record new evidence, write a milestone with closes, or amend the card with marker ~.');
  }
  if (verify !== undefined && (typeof verify !== 'string' || verify.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(verify))) {
    return bad('verify must be a string of at most 2000 characters; it is recorded, never executed.');
  }
  if (marker === '~' && typeof verify === 'string' && !verify.trim() && /(?:^|\s)verify:\s*[^\n\s]/i.test(String(text))) {
    return bad('To clear verification, remove the inline verify: suffix from the amended text too.');
  }
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.length > 16)) return bad('evidence must be an array of at most 16 references.');
  const normalized = [];
  // Validate EVERY entry before any snapshot work (and, at the callers, before
  // taking the write lock or draining pending capture queues).
  for (const [index, item] of (evidence || []).entries()) {
    const prefix = `evidence[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad(`${prefix} must be an object.`);
    if (Object.keys(item).some(key => !INPUT_FIELDS.has(key))) return bad(`${prefix} has an unknown field; use kind, ref, optional oid and verifiedAt.`);
    if (!KINDS.has(item.kind)) return bad(`${prefix}.kind must be file, pr, url, commit, or run.`);
    if (typeof item.ref !== 'string' || !item.ref.trim() || item.ref.length > 1000 || /[\x00-\x1f\x7f]/.test(item.ref)) return bad(`${prefix}.ref must be a non-empty single-line string of at most 1000 characters.`);
    if (item.oid !== undefined && (item.kind !== 'file' || typeof item.oid !== 'string' || !SHA_RE.test(item.oid))) return bad(`${prefix}.oid must be a full 40- or 64-character file blob hash.`);
    if (item.verifiedAt !== undefined && (typeof item.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(item.verifiedAt) || !Number.isFinite(Date.parse(item.verifiedAt)) || new Date(item.verifiedAt).toISOString().slice(0, 10) !== item.verifiedAt.slice(0, 10))) return bad(`${prefix}.verifiedAt must be an ISO date or UTC timestamp (caller-reported, not independently verified).`);
    if (item.kind === 'file' && !resolveEvidenceFile(projectRoot, item.ref)) return bad(`${prefix}.ref must be a safe project-relative file path (no traversal, absolute paths, or links outside the project).`);
    if (item.kind === 'url') {
      try { const url = new URL(item.ref); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return bad(`${prefix}.ref must be an HTTP(S) URL without credentials.`); }
      catch { return bad(`${prefix}.ref must be an HTTP(S) URL without credentials.`); }
    }
    normalized.push({ ...item, ref: item.ref.trim(), ...(item.oid ? { oid: item.oid.toLowerCase() } : {}) });
  }
  const now = new Date().toISOString();
  const revision = normalized.some(item => item.kind === 'file') ? git(projectRoot, ['rev-parse', '--verify', 'HEAD']) : null;
  for (const item of normalized) {
    item.capturedAt = now;
    if (item.kind !== 'file') continue;
    const file = resolveEvidenceFile(projectRoot, item.ref);
    const snapshot = file ? readSnapshot(file.target) : { status: 'unverified' };
    if (snapshot.sha256) { item.sha256 = snapshot.sha256; item.sourceBasis = 'working-tree'; }
    if (revision && SHA_RE.test(revision)) item.headRevision = revision;
  }
  return { ok: true, ...(evidence !== undefined ? { evidence: normalized } : {}), ...(verify !== undefined ? { verify: verify.trim() } : {}) };
}

export function inspectCardEvidence(card, { projectRoot, cache = new Map(), maxRefs = 4, budgetMs = 150 } = {}) {
  // One shared cache is one response budget. Never pay refs * git-timeout on
  // brain_sync's fast path. Local synchronous filesystem probes cannot be
  // interrupted mid-call, but no additional probe starts after this deadline.
  if (!cache.has(READ_BUDGET)) cache.set(READ_BUDGET, { deadline: Date.now() + Math.max(0, Math.min(1000, Number.isFinite(budgetMs) ? budgetMs : 150)), probes: 0 });
  const budget = cache.get(READ_BUDGET);
  const limit = Math.max(1, Math.min(16, Number(maxRefs) || 4));
  const refs = Array.isArray(card?.evidence) ? card.evidence : [];
  const sources = refs.slice(0, limit).map(item => {
    const source = { kind: flat(item?.kind).slice(0, 20), ref: flat(item?.ref).slice(0, 1000), status: 'unverified' };
    if (typeof item?.capturedAt === 'string') source.capturedAt = flat(item.capturedAt).slice(0, 30);
    if (typeof item?.verifiedAt === 'string') source.reportedVerifiedAt = flat(item.verifiedAt).slice(0, 30);
    if (typeof item?.headRevision === 'string' && SHA_RE.test(item.headRevision)) source.headRevision = item.headRevision;
    if (source.kind !== 'file') return source;
    if (Date.now() >= budget.deadline || budget.probes >= 24) { source.reason = 'inspection budget exhausted'; return source; }
    const file = resolveEvidenceFile(projectRoot, source.ref);
    if (!file) return source;
    const key = `${path.resolve(projectRoot)}\0${file.relative}`;
    if (!cache.has(key)) {
      if (Date.now() >= budget.deadline) { source.reason = 'inspection budget exhausted'; return source; }
      budget.probes++;
      cache.set(key, readSnapshot(file.target));
    }
    const current = cache.get(key);
    if (current.status !== 'read') { source.status = current.status; return source; }
    if (typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) && item.sourceBasis === 'working-tree') {
      source.basis = 'captured working file';
      source.status = current.sha256 === item.sha256 ? 'source-unchanged' : 'changed';
      return source;
    }
    // Legacy hooks stamped HEAD blobs. Check both HEAD and local dirtiness;
    // matching HEAD alone can conceal uncommitted changes. No repo/no git means
    // unverified, never missing or unchanged by inference.
    if (typeof item.oid === 'string' && SHA_RE.test(item.oid)) {
      const gitKey = `${key}\0legacy`;
      if (!cache.has(gitKey)) {
        const oid = git(projectRoot, ['rev-parse', '--verify', `HEAD:${file.relative}`], budget.deadline - Date.now());
        const working = oid ? workingTreeStatus(projectRoot, file.relative, budget.deadline) : 'unverified';
        cache.set(gitKey, { oid, working });
      }
      const legacy = cache.get(gitKey);
      source.basis = 'recorded HEAD blob and current working file';
      source.status = !legacy.oid ? 'unverified'
        : legacy.oid !== item.oid || legacy.working === 'changed' ? 'changed'
        : legacy.working === 'unchanged' ? 'source-unchanged' : 'unverified';
    }
    return source;
  });
  return {
    sources,
    omitted: Math.max(0, refs.length - sources.length),
    verify: typeof card?.verify === 'string' && card.verify.trim() ? { text: card.verify.trim().slice(0, 2000), status: 'not-executed' } : null,
    recordedVia: flat(card?.createdVia).slice(0, 80) || null,
    recordedAt: Number.isFinite(card?.createdAt) && Math.abs(card.createdAt) <= 8.64e15 ? new Date(card.createdAt).toISOString() : null,
  };
}

export function formatCardEvidence(summary, { maxChars = 700 } = {}) {
  if (!summary?.sources?.length && !summary?.verify) return '';
  const lines = ['Evidence (current source status is not claim verification):'];
  if (summary.recordedVia) lines.push(`Recorded via ${flat(summary.recordedVia)}${summary.recordedAt ? ` at ${summary.recordedAt}` : ''}.`);
  if (summary.verify) lines.push(`Recorded verification text (not executed):\n${summary.verify.text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}`);
  for (const source of summary.sources) lines.push(`- ${source.status}: ${source.ref}${source.basis ? ` (${source.basis})` : ''}${source.reason ? ` (${source.reason})` : ''}${source.capturedAt ? `; captured ${source.capturedAt}` : ''}${source.headRevision ? `; HEAD ${source.headRevision.slice(0, 12)} (revision only)` : ''}${source.reportedVerifiedAt ? `; caller reported verification ${source.reportedVerifiedAt}` : ''}`);
  if (summary.omitted) lines.push(`- ${summary.omitted} more reference(s) omitted.`);
  const value = lines.join('\n'), limit = Math.max(160, Math.min(4000, Number(maxChars) || 700));
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
