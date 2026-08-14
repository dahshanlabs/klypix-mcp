// Mechanical repo-state context (2026-08-14 bundle-currency incident).
//
// Two near-misses on the same day proved that release-critical git state must
// be STRUCTURED DATA in every sync response, not recall an agent may or may
// not exercise in time: a desktop release was almost built against a sibling
// source checkout sitting on a feature branch at an UNPUBLISHED version, and a
// whole release train shipped from an off-trunk branch because nothing made
// branch state visible at the moment of action. The only gate that caught the
// first incident lived in ONE consumer repo's prebuild script — invisible to
// every MCP client. This module is the host-neutral engine home for that
// knowledge: it runs inside the server, so a Codex, Cursor, Cline, or Desktop
// session is exactly as protected as a Claude one (no hook required).
//
// Contract:
//   • collectRepoState(projectDir) → { branch, headShort, packageVersion,
//     tagsAtHead, isReleaseTag, aheadBehindOrigin, siblings[], durationMs }
//     or null. Null means "no usable git state" — callers OMIT the block.
//   • Zero network: every signal is a local git read (the upstream comparison
//     uses the local tracking ref — never a fetch).
//   • Never throws. Detached HEAD, no git, no tags, no package.json, no remote
//     all degrade to nulls/empties or to omission of the whole block.
//   • Bounded: short per-spawn timeouts, at most MAX_SIBLINGS sibling repos,
//     and a 60s per-process cache so repeated brain_syncs stay cheap — the
//     first sync of a session pays the git spawns, the rest hit the cache.
//   • Stateless on disk: unlike observeShipDrift this keeps NO baseline file,
//     so a fresh session on an already-drifted repo still sees the drift, and
//     the ship-observation baseline is never perturbed.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// Same shape as the presence-side gitBranch / resolveAuthor probes: short
// timeout, stderr discarded, failure is data (null), never an exception.
const GIT_TIMEOUT_MS = 1500;
// The incident shape is ONE bundled core next to ONE source checkout; three is
// already generous. A monorepo with dozens of packages/* must not turn every
// sync into a git storm.
const MAX_SIBLINGS = 3;
const MAX_PACKAGE_ENTRIES = 40;
const MAX_TAGS_AT_HEAD = 8;
const CACHE_MS = 60_000;

// resolved projectDir → { at, state } (state may be null — "not a repo" is
// worth caching too, or every sync in a non-git project re-pays the spawn).
const repoStateCache = new Map();

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  });
}

const makeGit = (execGit) => (cwd, args) => {
  try {
    const out = execGit(args, cwd);
    return typeof out === 'string' ? out.trim() : null;
  } catch {
    return null;   // no git on PATH, not a repo, timeout — all the same: no data
  }
};

function readPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!pkg || typeof pkg !== 'object') return null;
    return {
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : null,
      version: typeof pkg.version === 'string' && pkg.version ? pkg.version : null,
    };
  } catch {
    return null;   // not an npm project / unreadable — fields stay null
  }
}

// Numeric 3-part compare (same policy as klypix-format's ship observer, which
// keeps its copy module-private). Prerelease suffixes are deliberately NOT
// ordered here — callers compare exact strings first, so "1.2.3-beta" vs
// "1.2.3" lands in the ahead branch rather than pretending alignment.
// Exported (1.70.0): the release-lease advisory in mcp-presence compares the
// checkout's packageVersion against latestReleaseTag with the same policy.
export const cmpSemver3 = (a, b) => {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

// A version counts as released when a tag names it: v<version> or <version>
// (the spec forms), plus the changesets/lerna "<name>@<version>" convention
// this package's own SAFE_TAG_RE already acknowledges.
const releaseTagNames = (name, version) => {
  const names = [`v${version}`, String(version)];
  if (name) names.push(`${name}@${version}`);
  return names;
};

// One repo's release-critical state. Returns null when the directory yields no
// git identity at all (not a repo / git missing) — the caller omits it.
function repoStateForDir(git, dir) {
  const branchRaw = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRaw === null) return null;
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;   // null = detached
  const headShort = git(dir, ['rev-parse', '--short', 'HEAD']) || null;
  const pkg = readPackage(dir);
  const tagsRaw = git(dir, ['tag', '--points-at', 'HEAD']);
  const allTagsAtHead = tagsRaw
    ? tagsRaw.split('\n').map((t) => t.trim()).filter(Boolean)
    : [];
  // The response payload is capped, but the RELEASE verdict must scan the full
  // list: `git tag --points-at` emits lexicographically, so eight junk tags
  // sorting before v<version> would otherwise flip a genuinely released HEAD
  // to "untagged" — and the installer's released-tag guard refuses on that.
  const tagsAtHead = allTagsAtHead.slice(0, MAX_TAGS_AT_HEAD);
  const isReleaseTag = Boolean(pkg?.version
    && allTagsAtHead.some((tag) => releaseTagNames(pkg.name, pkg.version).includes(tag)));
  // OFFLINE ahead/behind: the local tracking ref only. Counts can be stale
  // relative to the real remote — that is the honest offline answer, and a
  // stale count still exposes "this checkout diverged from what it tracks".
  let aheadBehindOrigin = null;
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  if (upstream) {
    const counts = git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    const match = counts ? counts.match(/^(\d+)\s+(\d+)$/) : null;
    if (match) {
      aheadBehindOrigin = { upstream, ahead: Number(match[1]), behind: Number(match[2]) };
    }
  }
  return {
    branch,
    headShort,
    packageVersion: pkg?.version || null,
    tagsAtHead,
    isReleaseTag,
    aheadBehindOrigin,
  };
}

// Released means "a tag anywhere in the repo names this version" — not only at
// HEAD, because a checkout routinely moves past the commit it tagged while the
// version itself stays published.
function versionReleased(git, dir, name, version) {
  const out = git(dir, ['tag', '--list', ...releaseTagNames(name, version)]);
  return out === null ? null : out.length > 0;
}

// The HIGHEST release-shaped tag anywhere in the repo (v1.2.3 / 1.2.3 /
// <name>@1.2.3) → { tag, version } or null. This is the "last released"
// baseline the zero-config release advisory compares packageVersion against:
// a checkout sitting at a HIGHER version than any release tag is release
// preparation in progress, whether or not anyone declared it. One bounded
// spawn; a junk-tag flood is capped rather than scanned forever.
const MAX_TAG_SCAN = 2000;
function latestReleaseTag(git, dir, name) {
  const out = git(dir, ['tag', '--list']);
  if (!out) return null;
  let best = null;
  for (const line of out.split('\n').slice(0, MAX_TAG_SCAN)) {
    const tag = line.trim();
    if (!tag) continue;
    let version = null;
    const plain = /^v?(\d+\.\d+\.\d+)$/.exec(tag);
    if (plain) version = plain[1];
    else if (name && tag.startsWith(`${name}@`)) {
      const candidate = tag.slice(name.length + 1);
      if (/^\d+\.\d+\.\d+$/.test(candidate)) version = candidate;
    }
    if (!version) continue;
    if (!best || cmpSemver3(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

// Zero-config bundled-mirror detection — the exact incident geometry:
// <projectRoot>/packages/<dirname>/package.json (the bundled mirror) paired by
// PACKAGE NAME with <projectRoot>/../<dirname>/ (the source checkout the
// bundle-sync would copy from). Read-only outside the project root: one
// package.json read plus the same bounded git probes as the root repo.
function detectSiblings(git, projectDir) {
  const siblings = [];
  const packagesDir = path.join(projectDir, 'packages');
  let entries = [];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return siblings;   // no packages/ dir — the common case, one cheap readdir
  }
  const parent = path.dirname(projectDir);
  let scanned = 0;
  for (const entry of entries) {
    if (siblings.length >= MAX_SIBLINGS || scanned >= MAX_PACKAGE_ENTRIES) break;
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    scanned += 1;
    const mirror = readPackage(path.join(packagesDir, entry.name));
    if (!mirror?.name || !mirror.version) continue;
    const siblingDir = path.join(parent, entry.name);
    const siblingPkg = readPackage(siblingDir);
    // Same package name is the pairing proof — a coincidentally-named folder
    // next door must not generate drift verdicts about an unrelated project.
    if (!siblingPkg?.name || siblingPkg.name !== mirror.name) continue;
    const state = repoStateForDir(git, siblingDir);
    if (!state || !state.packageVersion) continue;   // no git identity → no verdict
    let drift;
    if (state.packageVersion === mirror.version) {
      drift = 'aligned';
    } else if (cmpSemver3(state.packageVersion, mirror.version) < 0) {
      drift = 'mirror-ahead';
    } else {
      // Ahead (or an equal-numeric prerelease difference). Whether the
      // sibling's version is PUBLISHED is the incident's hinge: a tag lookup
      // failure reads as untagged on purpose — when release state cannot be
      // confirmed, the safe verdict is the one that warns.
      const released = versionReleased(git, siblingDir, siblingPkg.name, state.packageVersion);
      drift = released === true ? 'sibling-ahead-released' : 'sibling-ahead-untagged';
    }
    siblings.push({
      name: siblingPkg.name,
      dir: siblingDir,
      ...state,
      mirrorVersion: mirror.version,
      drift,
    });
  }
  return siblings;
}

/**
 * Collect the release-critical git state for a project root plus any bundled
 * sibling mirrors. Returns null (callers omit the block) when the root yields
 * no git state. `execGit` / `cacheMs` / `now` are test seams only — production
 * callers pass just the directory.
 */
export function collectRepoState(projectDir, {
  execGit = defaultExecGit,
  cacheMs = CACHE_MS,
  now = Date.now,
} = {}) {
  if (!projectDir) return null;
  let dir;
  try {
    dir = path.resolve(String(projectDir));
  } catch {
    return null;
  }
  const startedAt = now();
  const hit = repoStateCache.get(dir);
  if (hit && cacheMs > 0 && startedAt - hit.at < cacheMs) return hit.state;
  const git = makeGit(execGit);
  let state = null;
  try {
    const root = repoStateForDir(git, dir);
    if (root) {
      state = {
        ...root,
        // Additive (1.70.0): the release baseline for the zero-config release
        // advisory. Root repo only — siblings keep their per-version probe.
        latestReleaseTag: latestReleaseTag(git, dir, readPackage(dir)?.name || null),
        siblings: detectSiblings(git, dir),
        durationMs: Math.max(0, now() - startedAt),
      };
    }
  } catch {
    state = null;   // belt-and-braces: no probe failure may fail a sync
  }
  repoStateCache.set(dir, { at: startedAt, state });
  return state;
}

// One advisory line per sibling whose working tree is ahead at an UNRELEASED
// version — the exact 2026-08-14 shape. Prose is the courtesy channel; the
// structured block is the contract (renderers must parse repoState, not this).
export function repoStateWarnings(repoState) {
  return (repoState?.siblings || [])
    .filter((sibling) => sibling.drift === 'sibling-ahead-untagged')
    .map((sibling) => `KLYPIX repo-state warning: sibling checkout ${sibling.dir}`
      + ` (${sibling.name} ${sibling.packageVersion}${sibling.branch ? `, branch ${sibling.branch}` : ''})`
      + ` is ahead of the bundled packages/${sibling.name} mirror (${sibling.mirrorVersion})`
      + ' and its version has NO release tag — a bundle sync or build from this state would ship'
      + ` an unreleased ${sibling.name}. Verify release state before building.`);
}
