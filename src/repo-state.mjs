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

function defaultExecGit(args, cwd, timeoutMs) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // Most probes are rev-parse-fast; patch-id work needs its own budget.
    timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : GIT_TIMEOUT_MS,
  });
}

const makeGit = (execGit) => (cwd, args, timeoutMs) => {
  try {
    const out = execGit(args, cwd, timeoutMs);
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

// Trunk candidates, most-authoritative first. The remote tracking ref beats a
// local branch: a local `master` can itself be stale, and the question a
// release must answer is "does this carry everything the TEAM has landed".
const TRUNK_REFS = ['origin/master', 'origin/main', 'master', 'main'];
const MAX_MISSING_LISTED = 8;
// git cherry has no --max-count, so a pathological divergence is bounded here
// rather than parsed forever.
const MAX_CHERRY_SCAN = 500;
// Measured 670ms on a real 200-commit divergence; the shared 1500ms budget was
// already failing intermittently and reporting the release as clean.
const CHERRY_TIMEOUT_MS = 10_000;
const UNIT_SEP = '';

/**
 * Would this release leave finished work behind?
 *
 * The recorded rule is "never ship a build that is not a descendant of trunk —
 * the check is ANCESTRY, not version number", and it exists because desktop
 * 1.3.107 was the highest version number KLYPIX had ever produced while missing
 * 211 trunk commits and an entire feature. A higher number on an off-trunk
 * branch is perfect camouflage.
 *
 * Until now that rule lived only as a card — recall, which works exactly as
 * often as somebody exercises it. On 2026-08-15 nobody did: three finished
 * commits sat on master while a release was cut from a branch that could never
 * contain them, and the FOUNDER caught it, not the tooling. Coordination in
 * this engine has always been about files two sessions are editing RIGHT NOW;
 * nothing ever asked whether finished work was actually IN the build. This is
 * that missing axis.
 *
 * Advisory data, never a refusal — a hotfix cut from a tag is a legitimate
 * off-trunk release. The caller decides; this only makes it impossible to be
 * unaware.
 *
 * @returns {null|{trunk, ref, isDescendant, missingCount, missing:Array<{sha,subject}>}}
 *   null when the question cannot be answered (no git, no trunk, unknown ref).
 */
export function releaseAncestry(projectDir, ref, { execGit = defaultExecGit, peerBranches = [] } = {}) {
  const git = makeGit(execGit);
  const dir = String(projectDir || '');
  if (!dir) return { status: 'unknown', reason: 'no-project-dir', isDescendant: false, missingCount: 0, sources: [], missing: [] };
  const target = String(ref || '').trim() || 'HEAD';
  const shaOf = (r) => git(dir, ['rev-parse', '--verify', `${r}^{commit}`]);
  const resolves = (r) => shaOf(r) !== null;
  // A gate that cannot run must SAY SO. Returning null here made "the ref does
  // not exist" and "git timed out" indistinguishable from "clean" — and the
  // caller granted the lease silently, which an agent could trigger with a
  // single mistyped ref name. Unknown is now its own state, and the gateway
  // treats it as blocking.
  if (git(dir, ['rev-parse', '--git-dir']) === null) {
    return { status: 'unknown', reason: 'git-unavailable', ref: target, isDescendant: false, missingCount: 0, sources: [], missing: [] };
  }
  const targetSha = shaOf(target);
  if (targetSha === null) {
    return { status: 'unknown', reason: 'target-unresolved', ref: target, isDescendant: false, missingCount: 0, sources: [], missing: [] };
  }

  // ALL trunk candidates, not the first that resolves. First-match-wins picked
  // origin/master in every normal clone and therefore NEVER compared LOCAL
  // master — which is exactly where the 2026-08-15 commits sat, unpushed. The
  // feature was blind to its own motivating incident for any session without a
  // live peer on that branch. Local trunk ahead of a release ref is precise,
  // not heuristic, so this adds no squash-merge noise beyond what origin/master
  // already carries. `origin/HEAD` is probed too, so a repo whose trunk is
  // `develop` or `trunk` is not left with no gate at all.
  const trunkRefs = TRUNK_REFS.filter(resolves);
  const originHead = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && !trunkRefs.includes(originHead) && resolves(originHead)) trunkRefs.push(originHead);
  const trunk = trunkRefs[0] || null;

  // WHY PEER BRANCHES, and not trunk alone — learned the hard way on
  // 2026-08-15. The trunk check alone said release/1.3.113 was fine: it IS a
  // descendant of origin/master. But origin/master was 214 commits behind the
  // LOCAL master where the finished work actually sat, unpushed. Trunk ancestry
  // catches the 1.3.107 class (a branch forked off trunk long ago); it cannot
  // catch work that has not reached trunk yet.
  //
  // The presence lane is the only thing that knows which branches are live,
  // which is precisely why this belongs in the coordination engine and not in
  // one repo's prebuild script. A prebuild gate can only see refs; the lane
  // sees WHO IS WORKING WHERE.
  const seen = new Set();
  const candidates = [];
  const trunkSet = new Set(trunkRefs);
  for (const r of [...trunkRefs, ...peerBranches]) {
    const name = String(r || '').trim();
    if (!name || name === target || seen.has(name)) continue;
    // Unresolvable refs are dropped; SAME-SHA refs are deliberately kept. A
    // release branch cut from trunk and declared immediately is the single most
    // common legitimate case, and dropping the equal ref left zero candidates —
    // which the new "cannot answer" path then refused. Kept, the ancestry check
    // finds it is trivially an ancestor, contributes no source, and the release
    // reads clean, which is the truth.
    if (shaOf(name) === null) continue;
    seen.add(name);
    candidates.push({ ref: name, kind: trunkSet.has(name) ? 'trunk' : 'peer-branch' });
  }

  // NO third source, deliberately — and this is a decision, not an omission.
  // A scan of recently-committed local branches was built and MEASURED against
  // this repo: it produced 30-62 "missing" commits across 6-14 branches, most of
  // them work already squash-merged into trunk under different SHAs. Ancestry
  // cannot see through a squash, so the heuristic manufactures false positives
  // at exactly the moment someone is trying to ship — and this project has the
  // scar for that: five consecutive releases reported red over perfect publishes,
  // and the recorded lesson is that alarm fatigue is itself a release-integrity
  // defect. Trunk and live-peer branches are both PRECISE (no false positives by
  // construction), so the gate keeps only those. The cost is stated honestly in
  // the doc comment above rather than papered over with a noisy proxy.

  if (!candidates.length) {
    return { status: 'unknown', reason: 'no-comparable-refs', ref: target, trunk, isDescendant: false, missingCount: 0, sources: [], missing: [] };
  }

  const sources = [];
  const claimed = new Set();   // shas already attributed to an earlier source
  for (const cand of candidates) {
    // `merge-base --is-ancestor` exits 0/1, and makeGit turns a non-zero exit
    // into null — so null here means "not an ancestor", not "unknown".
    if (git(dir, ['merge-base', '--is-ancestor', cand.ref, target]) !== null) continue;
    // `git cherry` INSTEAD OF `rev-list`, and this is the single most important
    // line in the module. rev-list compares SHAS, so it reported as "missing"
    // every commit that had been rebased, cherry-picked, or squash-merged into
    // the target under a new sha — measured on the real repo, that was 30-62
    // false positives across 6-14 branches, and it forced an otherwise-good
    // source to be deleted rather than tuned.
    //
    // `git cherry <target> <source>` compares PATCH-IDs: `+` means the change
    // genuinely is not there, `-` means an equivalent change already is.
    // Verified on real repos: it sees through a rebase, a cherry-pick, and a
    // single-commit squash. It does NOT see through a squash of several commits
    // into one (the combined diff cannot match any individual patch-id) — an
    // honest, documented residue rather than a silent one.
    //
    // It also fixes the merge over-count for free: where rev-list said 2 for a
    // divergence carrying one real change plus its merge commit, cherry says 1.
    // Count and listing now come from the SAME source, so they can no longer
    // disagree in the caller's favour — which is what let a merge-only
    // divergence satisfy the handshake with an empty list.
    //
    // TIMEOUT DISCIPLINE, learned the hard way one commit before this shipped:
    // patch-id computation is far slower than the rev-parse probes this module
    // was built around, and at the shared 1500ms budget `git cherry` returned
    // null on the real repo — which the loop read as "nothing missing" and the
    // gate reported the release as CLEAN. A false negative here is strictly
    // worse than every false positive this module has ever produced, so cherry
    // gets its own budget AND a failure is never allowed to mean "clean".
    const cherry = git(dir, ['cherry', target, cand.ref], CHERRY_TIMEOUT_MS);
    let count;
    let shown;
    let approximate = false;
    if (cherry !== null) {
      const missingShas = cherry.split('\n')
        .filter((l) => l.startsWith('+ '))
        .map((l) => l.slice(2).trim())
        .filter(Boolean)
        .slice(0, MAX_CHERRY_SCAN);
      count = missingShas.length;
      if (count <= 0) continue;              // every change is already present
      shown = missingShas.slice(0, MAX_MISSING_LISTED);
    } else {
      // FALL BACK, never skip. rev-list is sha-based so it over-reports
      // rebases and squashes, but over-reporting is a conversation and
      // under-reporting is a lost feature. The source is marked approximate so
      // the text can say the equivalence check could not run.
      const countRaw = git(dir, ['rev-list', '--count', `${target}..${cand.ref}`]);
      count = Number(countRaw);
      if (!Number.isFinite(count) || count <= 0) continue;
      approximate = true;
      const fallbackLog = git(dir, ['log', `--max-count=${MAX_MISSING_LISTED}`, '--format=%H', `${target}..${cand.ref}`]);
      shown = (fallbackLog || '').split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (!shown.length) continue;
    // One bounded call for the subjects of just what will be shown.
    const log = git(dir, ['log', '--no-walk', `--format=%h%x1f%s`, ...shown]);
    const parsed = (log || '').split('\n').filter(Boolean).map((line) => {
      const sep = line.indexOf(UNIT_SEP);
      return sep < 0
        ? { sha: line.trim(), subject: '' }
        : { sha: line.slice(0, sep).trim(), subject: line.slice(sep + 1).slice(0, 120) };
    });
    // Trunk and a peer sitting on trunk are the DEFAULT configuration, so the
    // same commits would otherwise be counted twice and demanded twice. Each
    // sha is attributed to the first source that reports it.
    const missing = parsed.filter((c) => c.sha && !claimed.has(c.sha));
    for (const c of missing) claimed.add(c.sha);
    if (!missing.length && count > 0 && parsed.length) continue;   // wholly duplicated source
    // `approximate` = the patch-id equivalence check could not run for this
    // source, so the list may include work that is already present under a
    // different sha. Carried on the source so the text can say so rather than
    // asserting a precision it does not have.
    sources.push({ ...cand, missingCount: count, missing, ...(approximate ? { approximate: true } : {}) });
  }

  if (!sources.length) {
    return { status: 'ok', trunk, ref: target, isDescendant: true, missingCount: 0, sources: [], missing: [] };
  }
  const missingCount = sources.reduce((n, s) => n + s.missingCount, 0);
  const listed = sources.flatMap((s) => s.missing);
  return {
    // A divergence we can count but cannot NAME is still a refusal — the caller
    // must not be able to acknowledge an empty list.
    status: listed.length ? 'dirty' : 'unnameable',
    trunk,
    ref: target,
    isDescendant: false,
    missingCount,
    sources,
    // Flattened for the common case of one diverged source.
    missing: listed.slice(0, MAX_MISSING_LISTED),
  };
}

/**
 * The half that actually matters: lines a HUMAN reads.
 *
 * Founder's correction, verbatim — "at least the user should be
 * informed/asked about it". A structured field only a model consumes is not a
 * gate, because a model can decline to mention it. These strings ride the
 * release-lease response at blocking severity, so a session cannot take the
 * lease and stay quiet about what the release would drop.
 */
export function releaseAncestryWarnings(ancestry) {
  if (!ancestry || ancestry.isDescendant) return [];

  // A gate that could not run is a finding, not a pass. Silence here was how a
  // mistyped ref, a missing git, or a 1.5s timeout turned the whole check off
  // while looking exactly like a clean release.
  if (ancestry.status === 'unknown') {
    const why = {
      'git-unavailable': 'git could not be read in this project',
      'target-unresolved': `the ref "${ancestry.ref}" does not exist here`,
      'no-comparable-refs': 'there is no trunk or peer branch to compare against',
      'no-project-dir': 'no project directory was supplied',
    }[ancestry.reason] || ancestry.reason || 'the check could not run';
    return [
      `RELEASE CHECK COULD NOT RUN — ${why}.`,
      'This is not an all-clear: nothing was verified about what this release would leave out.',
      'Tell the user, and check by hand that the release branch contains everything it should.',
    ];
  }

  const { ref, missingCount, sources } = ancestry;
  const named = sources.flatMap((s) => s.missing).length;
  const lines = [
    `RELEASE WOULD LEAVE WORK BEHIND — ${missingCount} finished commit(s) already exist that this release does not include.`,
  ];
  for (const s of sources) {
    lines.push(s.kind === 'trunk'
      ? `  ${s.missingCount} commit(s) on ${s.ref} (the main line) are not in ${ref}:`
      : `  ${s.missingCount} commit(s) on ${s.ref} — a branch someone is working on right now — are not in ${ref}:`);
    for (const c of s.missing) lines.push(`    · ${c.sha} ${c.subject}`);
    if (s.missingCount > s.missing.length) lines.push(`    · …and ${s.missingCount - s.missing.length} more not listed`);
    if (s.approximate) {
      lines.push('    (this list is approximate — the equivalence check could not run, so some of');
      lines.push('     these may already be in the release under a different commit id)');
    }
  }
  if (!named) {
    lines.push('  (none of them could be listed individually — they are merge commits; inspect the range by hand)');
  }
  lines.push('');
  lines.push('WHAT THIS MEANS FOR THE USER: if this release is built now, that work will not be in it,');
  lines.push('and nobody will notice until someone looks for a feature that is missing.');
  lines.push('Say this to them in your own words, listing what is above, BEFORE going any further.');
  return lines;
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
