#!/usr/bin/env node
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  releaseEvidencePrefix,
  validateEvidenceOnlyGitDiff,
  verifyPublicationReceiptFile,
} from '../src/release-evidence.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProject = path.resolve(scriptDir, '..');

function usage() {
  console.log(`Usage: node scripts/verify-release-evidence.mjs [options]

Fail-closed publication gate for a checked-out release commit.

Options:
  --project <dir>         Project root (default: repository containing this script)
  --receipt <path>       Committed publication receipt JSON
  --expectations <path>  Committed JSON with independently reviewed artifacts/publicClaims
  --package <name>       Expected package name (default: package.json)
  --version <version>    Expected version (default: package.json)
  --git-commit <sha>     Evidence target commit (required; receipt lives in a later evidence-only commit)
  --require-corroborated Require peer-corroborated rather than unique evidence
  --help                  Show this help

--receipt, --expectations, and --git-commit are required. The checked-out
commit may differ from the target only by the immutable versioned evidence
bundle: receipt, expectations, and the exact expected artifact files.`);
}

function parseArgs(argv) {
  const out = { requireCorroborated: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') out.help = true;
    else if (arg === '--require-corroborated') out.requireCorroborated = true;
    else if (['--project', '--receipt', '--expectations', '--package', '--version', '--git-commit'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      out[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function readJsonInside(projectRoot, file, label, { maxBytes }) {
  const root = fs.realpathSync.native(projectRoot);
  const requested = path.resolve(root, file);
  const relative = path.relative(root, requested).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the project root`);
  }
  let cursor = root;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} may not traverse a symbolic link`);
  }
  const stat = fs.statSync(requested);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte verification limit`);
  const bytes = fs.readFileSync(requested);
  if (bytes.length !== stat.size) throw new Error(`${label} changed size while it was being read`);
  return { relative, value: JSON.parse(bytes.toString('utf8')), bytes, file: requested };
}

function committedFileProof(projectRoot, commit, file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const listing = String(execFileSync('git', ['ls-tree', '-z', commit, '--', file], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  }));
  const entries = listing.split('\0').filter(Boolean);
  if (entries.length !== 1) throw new Error(`expected exactly one committed tree entry for ${file}`);
  const match = /^([0-7]{6}) blob ([a-f0-9]+)\t(.+)$/.exec(entries[0]);
  if (!match || match[3] !== file) throw new Error(`committed tree path or type does not exactly match ${file}`);
  const [, mode, oid] = match;
  const sizeText = String(execFileSync('git', ['cat-file', '-s', oid], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024,
  })).trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`committed blob size is invalid for ${file}`);
  if (size > maxBytes) throw new Error(`committed file exceeds the ${maxBytes}-byte verification limit: ${file}`);
  const bytes = execFileSync('git', ['cat-file', 'blob', oid], {
    cwd: projectRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: maxBytes + 64 * 1024,
  });
  if (bytes.length !== size) throw new Error(`committed blob changed size while it was being read: ${file}`);
  return {
    path: file,
    mode,
    oid,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.receipt || !args.expectations || !args.gitCommit) {
    throw new Error('--receipt, --expectations, and --git-commit are required');
  }
  const projectRoot = fs.realpathSync.native(path.resolve(args.project || defaultProject));
  const packageJson = readJsonInside(projectRoot, 'package.json', 'package.json', {
    maxBytes: 1024 * 1024,
  }).value;
  const expectedVersion = args.version || packageJson.version;
  const bundlePrefix = releaseEvidencePrefix(expectedVersion);
  const receipt = readJsonInside(projectRoot, args.receipt, 'publication receipt', {
    maxBytes: 8 * 1024 * 1024,
  });
  const expectations = readJsonInside(projectRoot, args.expectations, 'expectations file', {
    maxBytes: 1024 * 1024,
  });
  if (receipt.relative !== `${bundlePrefix}receipt.json`) {
    throw new Error(`--receipt must be exactly ${bundlePrefix}receipt.json`);
  }
  if (expectations.relative !== `${bundlePrefix}expectations.json`) {
    throw new Error(`--expectations must be exactly ${bundlePrefix}expectations.json`);
  }
  const trackedFiles = execFileSync('git', ['ls-files'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  const tracked = new Set(trackedFiles.map((file) => file.replace(/\\/g, '/')));
  if (!tracked.has(expectations.relative)) {
    throw new Error('expectations file is not tracked by the checked-out commit');
  }
  if (!tracked.has(receipt.relative)) {
    throw new Error('publication receipt is not tracked by the checked-out commit');
  }
  const committedReceipt = committedFileProof(projectRoot, 'HEAD', receipt.relative, {
    maxBytes: 8 * 1024 * 1024,
  });
  const committedExpectations = committedFileProof(projectRoot, 'HEAD', expectations.relative, {
    maxBytes: 1024 * 1024,
  });
  if (!committedExpectations.bytes.equals(expectations.bytes)) {
    throw new Error('expectations file content differs from the checked-out commit');
  }
  const committedReceiptSha256 = committedReceipt.sha256;
  if (!expectations.value || typeof expectations.value !== 'object' || Array.isArray(expectations.value)) {
    throw new Error('expectations file must be an object');
  }
  const allowedExpectationKeys = new Set(['artifacts', 'publicClaims']);
  const unknownExpectationKeys = Object.keys(expectations.value)
    .filter((key) => !allowedExpectationKeys.has(key));
  if (unknownExpectationKeys.length) {
    throw new Error(`unknown expectations field(s): ${unknownExpectationKeys.sort().join(', ')}`);
  }
  const suppliedGitCommit = String(args.gitCommit).trim().toLowerCase();
  const gitCommit = String(execFileSync('git', ['rev-parse', '--verify', `${suppliedGitCommit}^{commit}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim().toLowerCase();
  if (suppliedGitCommit !== gitCommit) {
    throw new Error('--git-commit must be the full resolved commit object id, not an abbreviation or ref');
  }
  const checkedOutCommit = String(execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim().toLowerCase();
  if (gitCommit === checkedOutCommit) {
    throw new Error('the receipt cannot be self-committed into its target commit; use a later evidence-only commit');
  }
  const checkedOutParents = String(execFileSync('git', ['rev-list', '--parents', '-n', '1', checkedOutCommit], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024,
  })).trim().toLowerCase().split(/\s+/);
  if (checkedOutParents.length !== 2) {
    throw new Error('the checked-out release must be one evidence commit with exactly one parent');
  }
  if (checkedOutParents[1] !== gitCommit) {
    throw new Error('the evidence target must be the sole parent of the checked-out release commit');
  }
  // Deliberately no --diff-filter: type/mode changes (T), renames, deletes,
  // and any future Git status must reach the fail-closed parser below.
  const changedSinceTarget = String(execFileSync(
    'git',
    ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', `${gitCommit}..${checkedOutCommit}`],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
  ));
  const expectedBundlePaths = [
    receipt.relative,
    expectations.relative,
    ...(Array.isArray(expectations.value.artifacts)
      ? expectations.value.artifacts.map((artifact) => artifact?.path)
      : []),
  ];
  const treeBundlePaths = String(execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--name-only', checkedOutCommit, '--', bundlePrefix],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
  )).split('\0').filter(Boolean);
  const expectedBundleSet = new Set(expectedBundlePaths);
  const extraBundlePaths = treeBundlePaths.filter((file) => !expectedBundleSet.has(file));
  const missingBundlePaths = expectedBundlePaths.filter((file) => !treeBundlePaths.includes(file));
  if (extraBundlePaths.length || missingBundlePaths.length || new Set(treeBundlePaths).size !== treeBundlePaths.length) {
    throw new Error([
      extraBundlePaths.length ? `unexpected committed evidence bundle file(s): ${extraBundlePaths.join(', ')}` : '',
      missingBundlePaths.length ? `missing committed evidence bundle file(s): ${missingBundlePaths.join(', ')}` : '',
      new Set(treeBundlePaths).size !== treeBundlePaths.length ? 'duplicate committed evidence bundle paths' : '',
    ].filter(Boolean).join('; '));
  }
  const committedFiles = expectedBundlePaths.map((file) => {
    const known = file === receipt.relative ? committedReceipt
      : file === expectations.relative ? committedExpectations
        : committedFileProof(projectRoot, checkedOutCommit, file);
    const { bytes: _bytes, ...proof } = known;
    return proof;
  });
  const evidenceDiff = validateEvidenceOnlyGitDiff(changedSinceTarget, {
    version: expectedVersion,
    receiptPath: receipt.relative,
    expectationsPath: expectations.relative,
    expectedArtifacts: expectations.value.artifacts,
    committedFiles,
  });
  if (!evidenceDiff.ok) throw new Error(evidenceDiff.errors.join('; '));
  const status = String(execFileSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  if (status) throw new Error('publication worktree must be clean');
  const verdict = verifyPublicationReceiptFile(receipt.file, {
    projectRoot,
    expectedPackageName: args.package || packageJson.name,
    expectedVersion,
    expectedGitCommit: gitCommit,
    expectedArtifacts: expectations.value.artifacts,
    expectedPublicClaims: expectations.value.publicClaims,
    trackedFiles,
    committedReceiptSha256,
    requireCorroborated: args.requireCorroborated,
  });
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'blocked',
    errors: [error?.message || String(error)],
  }, null, 2));
  process.exitCode = 1;
}
