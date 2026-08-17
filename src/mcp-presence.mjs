// Hookless, agent-neutral presence over the MCP connection lifecycle.
//
// Connecting the KLYPIX MCP server is already an explicit user authorization.
// Every stdio server process therefore registers one live session, heartbeats
// while the connection is open, and removes only its own MCP channel on close.
// Host hooks may enrich the same session id with prompt/file detail, but are not
// required for truthful active-session counts or pull-based message delivery.
import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import {
  codexToolActionId,
  declareReleaseLease,
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  freeReleaseLease,
  laneFileFor,
  listActiveSessions,
  messageDeliveryReceipt,
  messageDecayInfo,
  peekMessages,
  pinLaneIdentity,
  neutralizeMarkers,
  postPresenceMessage,
  readReleaseClaims,
  readReleaseLease,
  receiveMessages,
  retireFulfilledClaims,
  stakeReleaseClaim,
  withdrawReleaseClaim,
  refreshReleaseLease,
  rekeySessionIdentity,
  rotateEndedSessionIdentity,
  removeSession,
  sessionDeliveryReachability,
  shortestUniqueSessionPrefix,
  switchMcpSessionIdentity,
  upsertSession,
} from './agent-presence.mjs';
// ONE definition of the file key. Exact-overlap detection (here) and finding
// ROUTING (there) must agree byte for byte — a file "owned" by a peer under one
// normalizer and not the other is a route that silently never happens. The
// canonical copy lives in the pure module because that one is import-restricted
// (crypto only), so it can never grow a dependency this file would inherit.
import { normalizeFileKey } from './finding-routing.mjs';
import { cmpSemver3, collectRepoState, commitFiles, deleteCommittedClaim, readCommittedClaims, releaseAncestry, releaseAncestryWarnings, repoStateWarnings, settleClaimsAgainstRef, writeCommittedClaim } from './repo-state.mjs';
import { recordResultManifests } from './result-reconcile.mjs';

export const MCP_HEARTBEAT_MS = 60_000;
export const MCP_INBOX_POLL_MS = 3_000;
// Turn-end vs task-end (2026-08-14 wave): a phase "complete" carrying no result
// evidence, landing this soon after the worker's task start with NO intervening
// checkpoint, is mechanically indistinguishable from a per-turn sign-off (the
// tool instruction reads per-turn to Codex). Such a complete is downgraded to a
// scope-preserving checkpoint instead of wiping declared intent/files mid-task.
export const PREMATURE_COMPLETE_WINDOW_MS = 3 * 60 * 1000;

// Standard MCP server instructions are the approval-free awareness path. Hosts
// that surface InitializeResult.instructions to the model learn the same
// contract as Codex's managed AGENTS.md block; neither path executes local
// commands or crosses Codex's hook-trust boundary.
export const KLYPIX_MCP_INSTRUCTIONS = [
  'KLYPIX is the shared project brain for repositories containing ./brain.klypix.',
  'At the start of each task, call brain_sync with the current project root, a one-sentence intent, and any expected files before editing; the explicit project root keeps separate repositories on separate brains even when an MCP host launches servers from its own install directory.',
  'A session that never calls brain_sync appears to every peer as a connection with no declared scope — sync early so concurrent sessions can coordinate with you.',
  'Use its active-task, message, and file-overlap report to coordinate concurrent work.',
  'A coordination note is not consumed merely because it was offered: after a later independent KLYPIX action acknowledges the offer, call brain_message_receipt with its exact message id and offer token only when you actually incorporated it into your work. If you do not, a further independent action auto-consumes the note without a receipt — which records activity, not uptake — so the sender is told it was auto-consumed rather than acted on. Sending an explicit receipt is what makes your uptake visible to them.',
  'Call brain_sync again when your file scope materially changes, and with phase "complete" before your final response.',
  'When a task publishes a quantified or otherwise machine-checkable claim, include its validated result manifest in the completion sync; conflicting or incomparable peer results retain the task scope until reconciled.',
  'A session preparing a RELEASE of the project should declare it by adding releaseIntent {version, ref} to brain_sync: the first declarer takes an exclusive lease every peer sees, and a second declarer gets a hard conflict naming the holder.',
  'Do not read the full brain brief unless brain_sync says its compact context is insufficient or the task asks for broad history/status; use brain_ask for deeper retrieval.',
  'Capture only durable decisions or milestones with brain_note.',
  'Never hand-edit brain.klypix. If the current project has no brain.klypix, ignore this workflow.',
].join(' ');

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const EXACT_FILE_MAX_CHARS = 512;
const EXACT_FILE_MAX_COUNT = 20;
const GLOB_FILE_CHARS = new Set(['*', '?', '[', ']', '{', '}']);

const fileScopeError = (index, code, message, value) => ({
  index,
  code,
  message,
  ...(typeof value === 'string' ? { file: value.slice(0, EXACT_FILE_MAX_CHARS) } : {}),
});

const pathIsInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
};

// brain_sync coordinates exact FILE ownership. Accepting directories, globs,
// absolute paths, or alternate spellings (./x, x//y, x\\y) makes two sessions
// describe the same file with different keys and silently defeats the warning.
// Validate before ANY task/result/presence mutation; missing future files are
// valid, but their nearest existing parent must still resolve inside the project.
export function validateExactFileScope(files, { projectRoot } = {}) {
  if (!Array.isArray(files)) {
    return {
      ok: false,
      files: [],
      errors: [fileScopeError(null, 'files-not-array', '`files` must be an array of exact project-relative file paths')],
    };
  }
  if (files.length > EXACT_FILE_MAX_COUNT) {
    return {
      ok: false,
      files: [],
      errors: [fileScopeError(null, 'files-too-many', `\`files\` may contain at most ${EXACT_FILE_MAX_COUNT} exact paths`)],
    };
  }

  const root = path.resolve(projectRoot || process.cwd());
  let realRoot = root;
  try { realRoot = fs.realpathSync.native(root); } catch { /* a not-yet-created project has lexical containment only */ }
  const errors = [];
  const seen = new Map();

  for (let index = 0; index < files.length; index++) {
    const value = files[index];
    if (typeof value !== 'string') {
      errors.push(fileScopeError(index, 'file-not-string', `files[${index}] must be a string`, value));
      continue;
    }
    if (!value.length || !value.trim()) {
      errors.push(fileScopeError(index, 'file-empty', `files[${index}] must not be empty`, value));
      continue;
    }
    if (value.length > EXACT_FILE_MAX_CHARS) {
      errors.push(fileScopeError(index, 'file-too-long', `files[${index}] exceeds ${EXACT_FILE_MAX_CHARS} characters`, value));
      continue;
    }
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push(fileScopeError(index, 'file-noncanonical', `files[${index}] must not contain surrounding whitespace or control characters`, value));
      continue;
    }
    if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      errors.push(fileScopeError(index, 'file-absolute', `files[${index}] must be relative to the project root`, value));
      continue;
    }
    if (/^[A-Za-z]:/.test(value)) {
      errors.push(fileScopeError(index, 'file-noncanonical', `files[${index}] must not use a drive-relative path`, value));
      continue;
    }
    if (value.endsWith('/') || value.endsWith('\\')) {
      errors.push(fileScopeError(index, 'file-trailing-slash', `files[${index}] names a directory-like path; supply an exact file`, value));
      continue;
    }
    if (value.includes('\\') || value !== path.posix.normalize(value)
      || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      const escaping = value.split('/').includes('..');
      errors.push(fileScopeError(index, escaping ? 'file-escapes-project' : 'file-noncanonical',
        `files[${index}] must use canonical forward-slash project-relative form`, value));
      continue;
    }
    if ([...value].some((character) => GLOB_FILE_CHARS.has(character))) {
      errors.push(fileScopeError(index, 'file-glob-like', `files[${index}] must name one exact file, not a glob-like pattern`, value));
      continue;
    }

    const folded = value.toLowerCase();
    if (seen.has(folded)) {
      errors.push(fileScopeError(index, 'file-duplicate',
        `files[${index}] duplicates files[${seen.get(folded)}] after case folding`, value));
      continue;
    }
    seen.set(folded, index);

    const target = path.resolve(root, ...value.split('/'));
    if (!pathIsInside(root, target)) {
      errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves outside the project root`, value));
      continue;
    }

    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        errors.push(fileScopeError(index, 'file-is-directory', `files[${index}] is an existing directory; supply exact files within it`, value));
        continue;
      }
      const realTarget = fs.realpathSync.native(target);
      if (!pathIsInside(realRoot, realTarget)) {
        errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves through a link outside the project root`, value));
      }
      continue;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        errors.push(fileScopeError(index, 'file-unverifiable', `files[${index}] could not be verified (${error?.code || 'filesystem error'})`, value));
        continue;
      }
      if (error?.code === 'ENOTDIR') {
        errors.push(fileScopeError(index, 'file-parent-not-directory', `files[${index}] has an existing parent that is not a directory`, value));
        continue;
      }
    }

    // The file may be created later. Resolve the nearest existing parent so an
    // existing symlink cannot turn that future path into an out-of-project file.
    let ancestor = path.dirname(target);
    while (pathIsInside(root, ancestor)) {
      try {
        const stat = fs.statSync(ancestor);
        if (!stat.isDirectory()) {
          errors.push(fileScopeError(index, 'file-parent-not-directory', `files[${index}] has an existing parent that is not a directory`, value));
        } else if (!pathIsInside(realRoot, fs.realpathSync.native(ancestor))) {
          errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves through a link outside the project root`, value));
        }
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
          errors.push(fileScopeError(index, 'file-unverifiable', `files[${index}] parent could not be verified (${error?.code || 'filesystem error'})`, value));
          break;
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  return { ok: errors.length === 0, files: errors.length ? [] : [...files], errors };
}

// releaseIntent: { version, ref } — a session's declared intent to prepare a
// RELEASE of this project. Validated fail-closed before any sync mutation
// (client-neutral: the worker's Zod schema is a convenience, not the guard).
// Version must be semver-shaped (optional leading v, bounded prerelease/build
// suffix); ref is any bounded, control-character-free git ref name.
const RELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,40})?$/;
export function validateReleaseIntent(value) {
  if (value === undefined || value === null) return { provided: false, ok: true };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { provided: true, ok: false, errors: ['releaseIntent must be an object of the form { version, ref }'] };
  }
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const errors = [];
  if (!version || version.length > 64 || !RELEASE_VERSION_RE.test(version)) {
    errors.push('releaseIntent.version must be a semver-shaped version string (for example "1.70.0")');
  }
  if (!ref || ref.length > 200 || /[\u0000-\u001f\u007f\s]/.test(ref)) {
    errors.push('releaseIntent.ref must be a nonempty bounded git ref (branch or tag) with no whitespace or control characters');
  }
  // acknowledge: the commits this release KNOWINGLY leaves behind. Optional,
  // and only ever consulted when the ancestry gate found something — see
  // ancestryAcknowledged. Bounded like every other caller-supplied list.
  let acknowledge = [];
  if (value.acknowledge !== undefined && value.acknowledge !== null) {
    if (!Array.isArray(value.acknowledge)) {
      errors.push('releaseIntent.acknowledge must be an array of commit shas the release deliberately leaves behind');
    } else {
      acknowledge = [...new Set(value.acknowledge
        .filter((s) => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[0-9a-f]{4,40}$/.test(s)))];
      // NEVER silently slice (2026-08-17 review blocker, verified by execution).
      // The old `.slice(0, 64)` combined with a gate that demands EVERY dropped
      // sha meant any release leaving >64 commits behind — the v1.3.120 field
      // case was 71 — could never be acknowledged: the caller echoed the full
      // acknowledgeRequired list, the validator quietly kept 64, the gate
      // demanded them all, and the refusal named no cap. An agent obeying the
      // instructions verbatim looped forever. The bound now exceeds the
      // ancestry scan cap (500 per source, two sources), and overflowing it is
      // a LOUD error naming the number — a divergence that large should be
      // resolved, not acknowledged.
      if (acknowledge.length > 1024) {
        errors.push(`releaseIntent.acknowledge carries ${acknowledge.length} shas — the limit is 1024. A divergence this size should be resolved (merge or rebase the ref) rather than acknowledged away.`);
      }
    }
  }
  if (errors.length) return { provided: true, ok: false, errors };
  return { provided: true, ok: true, version: version.replace(/^v/i, ''), ref, acknowledge };
}

/**
 * Validate the releaseClaim input — the durable "my commits ride the next
 * build" promise. Fail-closed like releaseIntent: a malformed claim must
 * never half-sync, and never silently stake less than the caller asked
 * (the 1.74.0 acknowledge-slice lesson, applied at the door).
 * Shapes: { shas: [...], note? } stakes/extends; { withdraw: [...] } trims
 * ({ withdraw: [] } or { withdraw: true } clears the whole claim).
 */
export function validateReleaseClaim(value) {
  if (value === undefined || value === null) return { provided: false, ok: true };
  const errors = [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { provided: true, ok: false, errors: ['releaseClaim must be an object: { shas: [...], note? } to stake, { withdraw: [...] } to withdraw'] };
  }
  const hasStake = value.shas !== undefined;
  const hasWithdraw = value.withdraw !== undefined;
  if (hasStake === hasWithdraw) {
    errors.push('releaseClaim needs exactly one of `shas` (stake) or `withdraw`');
  }
  const parseShas = (raw, field) => {
    if (!Array.isArray(raw)) { errors.push(`releaseClaim.${field} must be an array of commit shas`); return []; }
    const clean = [...new Set(raw
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^[0-9a-f]{4,40}$/.test(x)))];
    if (raw.length && !clean.length) errors.push(`releaseClaim.${field} contained no valid shas (4-40 hex chars each)`);
    if (clean.length > 20) errors.push(`releaseClaim.${field} carries ${clean.length} shas — the limit is 20; claim the branch-defining commits, not the whole history`);
    return clean;
  };
  let shas = [];
  let withdrawShas = [];
  let withdrawAll = false;
  if (hasStake) shas = parseShas(value.shas, 'shas');
  if (hasWithdraw) {
    if (value.withdraw === true || (Array.isArray(value.withdraw) && !value.withdraw.length)) withdrawAll = true;
    else if (value.withdraw === false) errors.push('releaseClaim.withdraw: false does nothing — omit the field to keep the claim, or pass true / [] to withdraw it entirely');
    else withdrawShas = parseShas(value.withdraw, 'withdraw');
  }
  const note = typeof value.note === 'string' ? value.note.replace(/\s+/g, ' ').trim().slice(0, 160) : null;
  if (value.publish !== undefined && typeof value.publish !== 'boolean') {
    errors.push('releaseClaim.publish must be a boolean');
  }
  if (errors.length) return { provided: true, ok: false, errors };
  return { provided: true, ok: true, stake: hasStake, shas, withdraw: hasWithdraw, withdrawShas, withdrawAll, note, publish: value.publish === true };
}

/**
 * Does this acknowledgement actually name what the release would drop?
 *
 * The whole point of the handshake is that a session cannot take the lease
 * without REPRODUCING the shas it is choosing to leave behind — and a model
 * that has to reproduce them has, in practice, had to read and relay them.
 * Nothing in MCP can force an agent to speak to its human; the closest
 * available thing is to make silence insufficient to proceed.
 *
 * Prefix-tolerant in both directions so a caller may echo the short shas we
 * printed or the full ones from their own `git log`.
 */
/**
 * JOIN the leave-behind set to the presence table.
 *
 * The engine modelled "which files are two sessions editing right now" and,
 * separately, "what would this release drop", and never connected them. So a
 * dropped commit reached the human as an anonymous sha even when its author was
 * live in the same lane, had declared the exact files, and had already told the
 * human the work would be in that build.
 *
 * Field case, desktop v1.3.120 (2026-08-16): cdcddb1 and 086bb17 touch
 * Toolbar.tsx / StrokePanel.tsx / useCanvasInteraction.ts, all DECLARED by a
 * live session; b493ead touches strokeScale.ts, OBSERVED on another. Both were
 * dropped, both owners were online, and the refusal named neither. A sha with a
 * name attached is a different conversation from a sha without one.
 *
 * Declared scope and observed scope both count: observed is how the engine
 * adopts scope for work a session never got round to declaring, and the whole
 * point here is to catch work whose owner never said the right thing.
 *
 * Bounded and fail-open-to-anonymous: if the git probe cannot run we return the
 * ancestry untouched. Never invent an owner — a wrong name is worse than none.
 */
export function annotateAncestryOwnership(ancestry, sessions, { projectRoot, selfId, execGit } = {}) {
  if (!ancestry || !Array.isArray(ancestry.sources) || !ancestry.sources.length) return ancestry;
  const peers = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id !== selfId);
  if (!peers.length || !projectRoot) return ancestry;

  // Probe the FULL dropped set (bounded by commitFiles' own max), not the
  // 8-per-source display list. Probing only the display meant a live peer's
  // dropped commit at recency rank ≥9 stayed anonymous, peerOwnedCount
  // undercounted the headline, and "owned commits sort to the top" was
  // unimplementable — all four pre-release reviews converged on this
  // (2026-08-17). Newest-first within each source so the bound spends itself
  // on the commits someone is most likely waiting for.
  const shas = ancestry.sources.flatMap((s) => (
    Array.isArray(s.allShas) && s.allShas.length ? s.allShas : (s.missing || []).map((c) => c.sha)
  )).filter(Boolean);
  if (!shas.length) return ancestry;
  let touched;
  try {
    touched = commitFiles(projectRoot, shas, execGit ? { execGit } : {});
  } catch {
    return ancestry;                      // probe failed — anonymous, never wrong
  }
  if (!touched || !touched.size) return ancestry;

  // Declared ∪ observed, normalized against the project root so an absolute
  // path from one session matches a repo-relative one from another.
  const scopeOf = (peer) => new Set([
    ...(Array.isArray(peer.files) ? peer.files : []),
    ...(Array.isArray(peer.observedFiles) ? peer.observedFiles : []),
  ].map((f) => normalizeFileKey(f, projectRoot)).filter(Boolean));
  const peerScopes = peers.map((p) => ({ peer: p, scope: scopeOf(p) })).filter((e) => e.scope.size);
  if (!peerScopes.length) return ancestry;

  // SHARED FILES DO NOT ESTABLISH OWNERSHIP. Some paths are touched by everyone
  // — a pending release-notes file, a strings catalog, a barrel index. If a
  // commit's only overlap with a session is one of those, calling that session
  // its owner is noise, and this codebase already records that alarm fatigue is
  // itself a release-integrity defect. Ownership therefore requires at least one
  // file that is NOT in most peers' scope; commits whose overlap is entirely
  // shared are still reported, just not promoted or counted as peer-owned.
  // The RELEASING session's own scope counts toward "shared", though it can
  // never be an owner: with a single scoped peer the old threshold of 2 was
  // unreachable, so a universal file (the pending release-notes doc, a strings
  // catalog) that both the peer and the releaser had declared made the peer
  // "owner" of every commit touching it (2026-08-17 review catch).
  const self = (Array.isArray(sessions) ? sessions : []).find((s) => s && s.id === selfId);
  const selfScope = self ? scopeOf(self) : new Set();
  const claimCount = new Map();
  for (const { scope } of peerScopes) {
    for (const key of scope) claimCount.set(key, (claimCount.get(key) || 0) + 1);
  }
  for (const key of selfScope) claimCount.set(key, (claimCount.get(key) || 0) + 1);
  const sharedThreshold = Math.max(2, Math.ceil((peerScopes.length + (selfScope.size ? 1 : 0)) / 2));
  const isShared = (key) => (claimCount.get(key) || 0) >= sharedThreshold;

  const lookup = (sha) => {
    const key = String(sha || '').toLowerCase();
    for (const [full, entry] of touched) if (full.startsWith(key) || key.startsWith(full)) return entry;
    return null;
  };

  const ownersFor = (sha) => {
    const entry = lookup(sha);
    if (!entry || !entry.files || !entry.files.length) return { owners: null, entry };
    const keys = entry.files.map((f) => normalizeFileKey(f, projectRoot)).filter(Boolean);
    const owners = peerScopes
      .map(({ peer, scope }) => {
        const overlap = keys.filter((k) => scope.has(k));
        if (!overlap.length) return null;
        const distinctive = overlap.filter((k) => !isShared(k));
        return {
          sessionId: peer.id,
          prefix: String(peer.id).slice(0, 8),
          branch: peer.branch || null,
          intent: peer.intent ? String(peer.intent).slice(0, 120) : null,
          // Lead with the files that actually identify this owner.
          files: [...distinctive, ...overlap.filter((k) => isShared(k))].slice(0, 4),
          sharedScopeOnly: distinctive.length === 0,
        };
      })
      .filter(Boolean);
    if (!owners.length) return { owners: null, entry };
    const strong = owners.filter((o) => !o.sharedScopeOnly);
    return { owners: [...strong, ...owners.filter((o) => o.sharedScopeOnly)], strong: strong.length > 0, entry };
  };

  let peerOwnedCount = 0;
  const sources = ancestry.sources.map((source) => {
    const displayed = new Map((source.missing || []).map((c) => [String(c.sha || '').toLowerCase(), c]));
    const annotated = (source.missing || []).map((commit) => {
      const { owners, strong } = ownersFor(commit.sha);
      if (!owners) return commit;
      if (strong) peerOwnedCount++;
      return { ...commit, owners };
    });
    // PROMOTE strong-owned commits that fell outside the display into it: the
    // whole point of the join is that a commit with a live owner must never be
    // invisible. Their subject comes from the same bounded git probe. Bounded to
    // the display cap so a pathological lane cannot flood the refusal.
    const promoted = [];
    const candidateShas = Array.isArray(source.allShas) && source.allShas.length
      ? source.allShas : [];
    for (const full of candidateShas) {
      if (promoted.length >= 8) break;
      const isDisplayed = [...displayed.keys()].some((short) => full.startsWith(short) || short.startsWith(full));
      if (isDisplayed) continue;
      const { owners, strong, entry } = ownersFor(full);
      if (!owners || !strong) continue;
      peerOwnedCount++;
      promoted.push({ sha: full.slice(0, 9), subject: (entry && entry.subject) || '', owners, promoted: true });
    }
    // Peer-owned commits sort to the TOP: they are the ones with a person
    // attached, and the list is truncated for display, so they must not be the
    // entries that fall off the bottom.
    const strongOwned = (c) => Array.isArray(c.owners) && c.owners.some((o) => !o.sharedScopeOnly);
    const ordered = [
      ...annotated.filter(strongOwned),
      ...promoted,
      ...annotated.filter((c) => !strongOwned(c)),
    ];
    return { ...source, missing: ordered };
  });
  return { ...ancestry, sources, peerOwnedCount };
}

export function ancestryAcknowledged(ancestry, acknowledge = []) {
  if (!ancestry) return true;
  if (ancestry.isDescendant || ancestry.status === 'ok') return true;
  // WHICH unknowns block, and which do not — the line matters in both
  // directions, and getting it wrong is expensive either way.
  //
  // BLOCKS. 'target-unresolved' means we ARE in a git repo and the ref you
  // named is not in it: the cheapest bypass in the whole design was a mistyped
  // or invented ref name, which used to return null and grant the lease in
  // silence. 'unnameable' means a divergence exists whose commits could not be
  // listed — an empty list must never satisfy the gate.
  //
  // DOES NOT BLOCK. A project with no git at all, or a repo with no trunk and
  // no peer to compare against, is not an unanswered question — it is a
  // MEANINGLESS one. Blocking there would stop a designer's brain in a plain
  // folder, or a brand-new repo with a single branch, from ever declaring a
  // release. That is a false positive of exactly the kind that teaches people
  // to ignore the gate.
  if (ancestry.status === 'unnameable') return false;
  if (ancestry.status === 'unknown') return ancestry.reason !== 'target-unresolved';
  // THE COMPLETE SET, never the display list. `missing` is the 8-per-source the
  // prose names; `allShas` is everything the release drops. Deriving the
  // requirement from `missing` is what let desktop v1.3.120 clear a gate over 71
  // dropped commits by naming 10 — and the 61 it never had to name included the
  // two features live sessions had promised the founder would be in that build.
  // The contract is that the lease cannot be taken without REPRODUCING the shas;
  // reproducing a truncated sample is not that contract.
  // `allShas` is absent on ancestry objects built by an older engine, so fall
  // back to the display list rather than vacuously passing.
  const required = (ancestry.sources || []).flatMap((s) => (
    Array.isArray(s.allShas) && s.allShas.length
      ? s.allShas
      : (s.missing || []).map((c) => c.sha)
  )).map((s) => String(s || '').toLowerCase()).filter(Boolean);
  const listed = [...new Set(required)];
  if (!listed.length) return false;
  const given = (acknowledge || []).map((s) => String(s || '').toLowerCase()).filter(Boolean);
  return listed.every((sha) => given.some((g) => g.startsWith(sha) || sha.startsWith(g)));
}

const canonicalPathKey = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// Node 18 exposes bigint dev/ino on every supported platform. Together with
// lstat identity (the junction/symlink object) and realpath identity (its
// target), this detects both a link retarget and an atomic file replacement.
// Do not include size/mtime: an in-place brain edit is not a routing change.
const filesystemIdentity = (target, { link = false } = {}) => {
  const stat = link
    ? fs.lstatSync(target, { bigint: true })
    : fs.statSync(target, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeNs]
    .map((value) => String(value))
    .join(':');
};

const directProjectBrain = (projectRoot) => {
  for (const name of ['brain.klypix', 'brain.any']) {
    const candidate = path.join(projectRoot, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const realRoot = fs.realpathSync.native(projectRoot);
      const realBrain = fs.realpathSync.native(candidate);
      if (canonicalPathKey(path.dirname(realBrain)) !== canonicalPathKey(realRoot)) {
        return { ok: false, reason: 'project-brain-escapes-root', brainPath: null };
      }
      return {
        ok: true,
        brainPath: candidate,
        realRoot,
        realBrain,
        binding: Object.freeze({
          lexicalProject: path.resolve(projectRoot),
          canonicalProject: path.resolve(realRoot),
          lexicalBrain: path.resolve(candidate),
          canonicalBrain: path.resolve(realBrain),
          projectLinkIdentity: filesystemIdentity(projectRoot, { link: true }),
          projectObjectIdentity: filesystemIdentity(projectRoot),
          brainLinkIdentity: filesystemIdentity(candidate, { link: true }),
          brainObjectIdentity: filesystemIdentity(candidate),
        }),
      };
    } catch { /* try the alternate direct brain filename */ }
  }
  return { ok: false, reason: 'project-brain-missing', brainPath: null };
};

const sameProjectBinding = (binding) => {
  try {
    if (!binding || typeof binding !== 'object') return false;
    if (canonicalPathKey(fs.realpathSync.native(binding.lexicalProject))
      !== canonicalPathKey(binding.canonicalProject)) return false;
    if (canonicalPathKey(fs.realpathSync.native(binding.lexicalBrain))
      !== canonicalPathKey(binding.canonicalBrain)) return false;
    if (canonicalPathKey(path.dirname(binding.lexicalBrain))
      !== canonicalPathKey(binding.lexicalProject)) return false;
    if (canonicalPathKey(path.dirname(binding.canonicalBrain))
      !== canonicalPathKey(binding.canonicalProject)) return false;
    if (!fs.statSync(binding.lexicalProject).isDirectory()
      || !fs.statSync(binding.lexicalBrain).isFile()) return false;
    return filesystemIdentity(binding.lexicalProject, { link: true }) === binding.projectLinkIdentity
      && filesystemIdentity(binding.lexicalProject) === binding.projectObjectIdentity
      && filesystemIdentity(binding.lexicalBrain, { link: true }) === binding.brainLinkIdentity
      && filesystemIdentity(binding.lexicalBrain) === binding.brainObjectIdentity;
  } catch {
    return false;
  }
};

const syncPreflightFailure = ({ status, reason, requestedProject, errors = [] }) => {
  const invalidProject = status !== 'invalid-scope';
  const guidance = invalidProject
    ? 'Supply the nonempty absolute path of the exact existing project root that directly contains brain.klypix or brain.any.'
    : 'Use unique canonical forward-slash paths to individual files (for example `src/app.ts`); missing future files are allowed.';
  const headline = invalidProject
    ? 'KLYPIX project routing was not changed because `project` is not an exact project-brain root.'
    : 'KLYPIX task scope was not changed because `files` is not an exact-file declaration.';
  return {
    sessions: [],
    messages: [],
    notice: '',
    conflicts: [],
    resultConflicts: [],
    alertsQueued: [],
    laneWriteOk: null,
    laneWriteSkippedReason: status,
    deliveryWriteOk: null,
    deliveryWriteSkippedReason: status,
    isError: true,
    structured: {
      schemaVersion: 1,
      status,
      reason,
      requestedProject: requestedProject || null,
      ...(errors.length ? { errors } : {}),
      mutation: 'none',
      identityMutation: 'none',
      deliveryMutation: 'none',
      timingMs: { coordination: 0 },
    },
    text: [
      headline,
      ...errors.slice(0, 20).map((error) => `- ${error.message}`),
      guidance,
    ].join('\n'),
  };
};

// File-key normalization. `root` (optional) is the project root the two rows share
// — passing it folds an ABSOLUTE declaration and a REPO-RELATIVE one onto the same
// key. Without it, one session declaring "E:/repo/src/App.tsx" and another
// declaring "src/App.tsx" never matched, so the overlap warning silently never
// fired for the commonest mixed pair (2026-07-30 hardening). Defensive by design:
// a path that cannot be placed under `root` keeps the previous (absolute,
// lowercased) key, so an unrelated file still compares as itself and a
// declaration is never dropped.

// HISTORICAL RATIONALE BELOW IS SUPERSEDED by the explicit-ID rule that
// follows it; hostPid is retained only as transport ownership metadata.

// TWIN recognition: one logical session can (still) appear as two lane rows —
// its lifecycle id and an mcp-<pid> id — whenever id adoption failed. Rows that
// share a hostPid belong to ONE host process; treating the twin as a peer would
// raise a "blocking" file conflict against the session itself and queue it an
// overlap alert. Suppression is explicit (suspectedTwin), never silent.
//
// hostPid ALONE is not identity (2026-07-30 hardening). A pid number is only
// unique per machine and per moment: a lane read from a synced/shared home, or a
// recycled pid whose previous host died inside the 10-minute freshness window,
// made two UNRELATED sessions suppress each other's overlap warnings — and a
// MISSING warning is invisible, so nothing surfaced the mistake. Two extra
// discriminators are required, both drawn from fields the lane row already
// carries (see agent-presence.mjs upsertSession):
//   machine — must match when BOTH rows carry it. Absent on rows written by an
//             older build or by the lifecycle hook, so absence must not un-suppress
//             a genuine twin; it degrades to the previous behaviour.
//   client  — must match when BOTH are specifically known. 'mcp'/'unknown' are
//             placeholders (getClientVersion() is optional), so a generic value on
//             either side stays compatible. This is what separates a codex row from
//             a claude-code row that collided on one pid.
// A host pid is a process/container fact, never a logical-session identity.
// Codex intentionally runs independent threads below one desktop pid, so
// pid-based twin suppression hid real peers and real conflicts. Only an
// explicit host-provided logical id may pair otherwise-distinct rows. Missing
// ids fail open as distinct sessions.
export const isLogicalTwin = (peer, me) => Boolean(
  peer && me
  && peer.id !== me.id
  && compact(peer.logicalSessionId)
  && compact(me.logicalSessionId)
  && compact(peer.logicalSessionId) === compact(me.logicalSessionId),
);
// Compatibility export: matching hostPid/machine/client is now deliberately
// insufficient. Consumers should migrate to isLogicalTwin.
export const isSuspectedTwin = isLogicalTwin;

// A COMPLETED task's surviving observations are history, not a live claim
// (1.70.0 review-caught): the completion guard clears DECLARED scope exactly so
// peers stop coordinating against finished work, and MCP heartbeats keep the
// row alive for the whole host-process lifetime — without this gate a session
// that completed hours ago kept rendering as an active task and a BLOCKING
// conflict source through its observed markers. The markers stay on the ROW
// (the edits are real; doctor/forensics keep them); only the live read
// surfaces ignore them once the task is complete-and-idle. Revival is cheap
// and automatic: a new McpTaskStart clears completedAt (agent-presence), a
// fresh human prompt does the same in the lifecycle hook, and any fresh
// declaration or intent makes the session non-idle again.
const completedIdleSession = (session) => Boolean(session?.completedAt)
  && !compact(session?.intent)
  && !(Array.isArray(session?.files) && session.files.length);
const liveObservedFiles = (session) => (completedIdleSession(session)
  ? []
  : (Array.isArray(session?.observedFiles) ? session.observedFiles : []));

export function findPresenceConflicts(sessions, selfId, { projectRoot } = {}) {
  const active = Array.isArray(sessions) ? sessions : [];
  const me = active.find((session) => session.id === selfId);
  if (!me) return [];
  // The lane is per-brain, so every row in it shares one project root; this
  // session's own cwd is that root (mcp-presence sets it to dirname(brain.klypix),
  // and brain_sync's explicit `project` flows into it).
  const root = projectRoot || me.cwd || null;
  // Automatic scope adoption (1.70.0): overlap is computed over the UNION of a
  // session's declared files and its host-OBSERVED edits (row.observedFiles —
  // written by the lifecycle hooks when an edit lands outside any declared
  // scope). A session that never called brain_sync still collides for real.
  // The observed/declared distinction is preserved per path so every warning
  // can state the confidence of each side's claim: an observed path is a real
  // edit but an unconfirmed boundary; a declared path is an owned scope.
  const scopeEntries = (session) => {
    // completedIdleSession gate: a finished task's leftover observations are
    // not a live overlap claim (see the helper above findPresenceConflicts).
    const observed = liveObservedFiles(session);
    const observedKeys = new Set(observed
      .map((file) => normalizeFileKey(file, root))
      .filter(Boolean));
    const entries = new Map();
    for (const file of [
      ...(Array.isArray(session?.files) ? session.files : []),
      ...observed,
    ]) {
      const key = normalizeFileKey(file, root);
      if (!key || entries.has(key)) continue;
      entries.set(key, {
        display: String(file || '').replace(/\\/g, '/'),
        observed: observedKeys.has(key),
      });
    }
    return entries;
  };
  const mine = scopeEntries(me);
  if (!mine.size) return [];
  const conflicts = [];
  for (const peer of active) {
    if (peer.id === selfId) continue;
    if (isSuspectedTwin(peer, me)) continue;   // own twin row — a session cannot conflict with itself
    const theirs = scopeEntries(peer);
    const overlapKeys = [...theirs.keys()].filter((key) => mine.has(key));
    if (!overlapKeys.length) continue;
    const overlap = overlapKeys.map((key) => mine.get(key).display);
    conflicts.push({
      id: peer.id,
      client: peer.client,
      surface: peer.surface || null,
      branch: peer.branch || null,
      intent: peer.intent || '',
      files: overlap,
      kind: 'exact-file',
      severity: 'blocking',
      sameWorktree: normalizeFileKey(peer.cwd) === normalizeFileKey(me.cwd),
      // ADDITIVE (1.70.0): which overlapping paths each side only OBSERVED
      // (adopted from live edits) rather than declared. Renderers use these to
      // state claim confidence; absent/empty means every claim was declared.
      peerObservedFiles: overlapKeys.filter((key) => theirs.get(key).observed).map((key) => mine.get(key).display),
      selfObservedFiles: overlapKeys.filter((key) => mine.get(key).observed).map((key) => mine.get(key).display),
    });
  }
  return conflicts;
}

// Shared annotation for conflict renders: mark each overlapping path whose
// claim (on either side) was observed rather than declared, and say what the
// mark means exactly once. Returns { files: [...], legend } — legend is ''
// when every claim was declared, keeping pre-1.70 output byte-identical.
export function annotateConflictFiles(conflict) {
  const observed = new Set([
    ...(Array.isArray(conflict?.peerObservedFiles) ? conflict.peerObservedFiles : []),
    ...(Array.isArray(conflict?.selfObservedFiles) ? conflict.selfObservedFiles : []),
  ]);
  const files = (Array.isArray(conflict?.files) ? conflict.files : [])
    .map((file) => (observed.has(file) ? `${file}*` : file));
  const legend = files.some((file) => file.endsWith('*'))
    ? ' (* = observed from live edits, scope not declared)'
    : '';
  return { files, legend };
}

const isTaskSession = (session) =>
  Boolean(compact(session?.intent)
    || (Array.isArray(session?.files) && session.files.length)
    // Automatic scope adoption: a session that never declared anything but has
    // host-observed edits has a KNOWN (if unconfirmed) scope — surface it as an
    // active task instead of burying it as "scope unknown". Completed-and-idle
    // sessions are exempt (liveObservedFiles): their observations are history,
    // and counting them re-promoted every finished task to "active" for the
    // rest of the host process's life.
    || liveObservedFiles(session).length > 0);

const publicSession = (session, now) => {
  const transport = session?.transport && typeof session.transport === 'object'
    ? Object.fromEntries(Object.entries(session.transport).slice(0, 4).map(([channel, value]) => [
      String(channel).slice(0, 32),
      { status: String(value?.status || 'unknown').slice(0, 40) },
    ]))
    : {};
  return {
    id: String(session?.id || ''),
    client: session?.client || 'unknown',
    surface: session?.surface || null,
    branch: session?.branch || null,
    intent: session?.intent || '',
    intentAgeMs: session?.intentAt ? Math.max(0, now - Number(session.intentAt)) : null,
    intentSource: session?.intentSource || null,
    files: Array.isArray(session?.files) ? session.files : [],
    // ADDITIVE (1.70.0): paths adopted from this session's live edits with no
    // declared scope covering them — real edits, unconfirmed boundaries.
    observedFiles: Array.isArray(session?.observedFiles) ? session.observedFiles : [],
    ageMs: Math.max(0, now - Number(session?.lastSeen || now)),
    deliveryReachability: session?.deliveryReachability || sessionDeliveryReachability(session),
    transport,
  };
};

// Freshness floor for "is this undeclared connection actually WORKING?".
// Only real prompt/tool work stamps activityAt; heartbeats deliberately
// preserve it, so a fresh stamp means work, not merely a live socket.
const UNDECLARED_ACTIVE_MS = 10 * 60 * 1000;

// How much of the ~2h release lease must remain before the HOLDER is warned.
// 25 minutes is longer than a full desktop candidate build + verify, so a
// holder who sees the warning still has time to finish or refresh rather than
// losing the lease mid-release.
const RELEASE_LEASE_WARN_MS = 25 * 60 * 1000;
const isUndeclaredActive = (session, now) =>
  !isTaskSession(session)
  && Number(session?.activityAt || 0) > 0
  && now - Number(session.activityAt) < UNDECLARED_ACTIVE_MS;

export function buildPresenceSnapshot(sessions, selfId, { now = Date.now() } = {}) {
  const connected = Array.isArray(sessions) ? sessions : [];
  const self = connected.find((session) => session.id === selfId) || null;
  // A session's own twin rows are IT, not peers or background connections.
  const others = connected.filter((session) => session.id !== selfId && !isSuspectedTwin(session, self));
  const twinCount = connected.length - 1 - others.length;
  const tasks = others.filter(isTaskSession);
  // 1.71.0 — "background" conflated two very different things: a connection
  // sitting idle, and a session actively editing this repo that never declared
  // a scope. Only the second one falsifies the coordination promise, because a
  // peer reading this snapshot cannot see the work it is doing. Doctor has
  // drawn that line since 1.70; the sync response buried it in one number.
  const undeclaredActive = others.filter((session) => isUndeclaredActive(session, now));
  return {
    connectionCount: connected.length - Math.max(0, twinCount),
    activeTaskCount: tasks.length + (self && isTaskSession(self) ? 1 : 0),
    // Retained verbatim for every existing reader: idle + undeclared-active.
    backgroundConnectionCount: others.length - tasks.length,
    // ADDITIVE: the subset that is provably working without declaring scope.
    undeclaredActiveCount: undeclaredActive.length,
    idleConnectionCount: Math.max(0, others.length - tasks.length - undeclaredActive.length),
    suspectedTwinCount: Math.max(0, twinCount),
    self: self ? publicSession(self, now) : null,
    peers: tasks.map((session) => publicSession(session, now)),
    // Named, not just counted — a peer can address them with brain_message.
    undeclaredActive: undeclaredActive.map((session) => publicSession(session, now)),
  };
}

export function formatTaskPresence(snapshot, now = Date.now()) {
  const taskWord = snapshot.activeTaskCount === 1 ? 'task' : 'tasks';
  const connectionWord = snapshot.connectionCount === 1 ? 'connection' : 'connections';
  // The undeclared-ACTIVE count is stated separately and first among the
  // caveats: it is the only figure here that means "work you cannot see".
  const unseen = Number(snapshot.undeclaredActiveCount || 0);
  const idle = Number(snapshot.idleConnectionCount ?? snapshot.backgroundConnectionCount ?? 0);
  const caveats = [];
  if (unseen) caveats.push(`${unseen} working WITHOUT declared scope — real edits you cannot see`);
  if (idle) caveats.push(`${idle} connected but idle`);
  const lines = [
    `KLYPIX task presence: ${snapshot.activeTaskCount} active ${taskWord} across ${snapshot.connectionCount} live ${connectionWord}`
      + (caveats.length ? ` (${caveats.join('; ')})` : '') + '.',
  ];
  if (unseen) {
    lines.push(`⚠ Overlap detection covers DECLARED scope only, so ${unseen === 1 ? 'that session is' : 'those sessions are'} invisible to it.`
      + ' Treat a clean conflict report as incomplete, and coordinate directly (brain_message) before touching shared files.');
  }
  if (!snapshot.peers.length) {
    lines.push('No other DECLARED task is active; connections that never called brain_sync are not listed here — they may still be working (see the connection count above).');
    return lines.join('\n');
  }
  lines.push('Other active tasks:');
  // UUIDv7 peers started in the same window share a long time prefix — grow
  // each shown id (git short-hash style, floor 12) until it names one session.
  const prefixRows = [snapshot.self, ...snapshot.peers].filter(Boolean);
  let anyObservedShown = false;
  for (const peer of snapshot.peers.slice(0, 8)) {
    const intentAgeMin = peer.intentAgeMs !== null ? Math.round(peer.intentAgeMs / 60_000) : null;
    const heartbeatMin = Math.round(peer.ageMs / 60_000);
    const intentAge = intentAgeMin !== null && intentAgeMin - heartbeatMin > 3 ? ` (intent set ${intentAgeMin}m ago)` : '';
    // Scope = declared ∪ observed; a `*` marks a path this peer was only
    // OBSERVED editing (automatic scope adoption — no declaration made).
    const observedKeys = new Set((peer.observedFiles || []).map((file) => normalizeFileKey(file)));
    const scope = [...new Set([...(peer.files || []), ...(peer.observedFiles || [])])];
    const shownScope = scope.slice(0, 4).map((file) => {
      if (!observedKeys.has(normalizeFileKey(file))) return file;
      anyObservedShown = true;
      return `${file}*`;
    });
    const details = [
      peer.client,
      peer.deliveryReachability && peer.deliveryReachability !== 'connected'
        ? `delivery ${peer.deliveryReachability}` : null,
      peer.branch ? `branch ${peer.branch}` : null,
      peer.intent ? `"${String(peer.intent).slice(0, 90)}"${intentAge}` : null,
      scope.length ? shownScope.join(', ') + (scope.length > 4 ? ` (+${scope.length - 4} more)` : '') : null,
    ].filter(Boolean);
    const shortId = shortestUniqueSessionPrefix(prefixRows, peer.id, 12) || String(peer.id).slice(0, 12);
    lines.push(`- ${shortId}: ${details.join(' | ')}`);
  }
  // v1.32.0 law: a truncated list must never render as a complete one.
  if (snapshot.peers.length > 8) lines.push(`- …and ${snapshot.peers.length - 8} more active task(s) not listed — brain_doctor shows all.`);
  if (anyObservedShown) lines.push('* = observed from that session\'s live edits (scope not declared) — real overlap, unconfirmed boundary.');
  lines.push(`Point-in-time as of ${new Date(now).toISOString().slice(11, 16)}Z — re-sync before acting on it.`);
  return lines.join('\n');
}

export function normalizeMcpClient(name) {
  const value = compact(name).toLowerCase();
  if (!value) return 'mcp';
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('cline')) return 'cline';
  if (value.includes('windsurf')) return 'windsurf';
  if (value.includes('antigravity')) return 'antigravity';
  return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'mcp';
}

const LOGICAL_ID_MAX = 160;
const LOGICAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const boundedIdentityId = (value) => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > LOGICAL_ID_MAX || !LOGICAL_ID_RE.test(id)) return null;
  return id;
};

const requestActionId = (extra, turnMetadata, { toolName, toolInput } = {}) => {
  // A later MCP request is an independent model action even when it belongs to
  // the same Codex turn: the model received the prior tool result before it
  // chose the next call. Keep the turn id for traceability, but include the
  // request/progress id so brain_sync → brain_message_receipt can acknowledge
  // and consume in one turn. Same-call double transitions are prevented by the
  // worker's single decorator (brain_sync is never decorated a second time).
  const turnId = boundedIdentityId(turnMetadata?.turn_id);
  const sharedToolAction = codexToolActionId({
    turnId,
    toolUseId: turnMetadata?.tool_use_id,
    toolName,
    toolInput,
  });
  if (sharedToolAction) return sharedToolAction;
  const rawRequestId = extra?.requestId ?? extra?._meta?.progressToken ?? extra?.progressToken;
  const requestId = (typeof rawRequestId === 'string' || typeof rawRequestId === 'number')
    ? String(rawRequestId).trim().slice(0, LOGICAL_ID_MAX)
    : '';
  if (turnId && requestId) return `codex-turn:${turnId}:request:${requestId}`;
  if (turnId) return `codex-turn:${turnId}`;
  return requestId ? `mcp-request:${requestId}` : '';
};

const parseCodexTurnMetadata = (value) => {
  if (value === undefined) return { value: null, error: '' };
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value, error: '' };
  if (typeof value !== 'string' || value.length > 16_384) {
    return { value: null, error: 'x-codex-turn-metadata is not a bounded object' };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: 'x-codex-turn-metadata is not an object' };
    }
    return { value: parsed, error: '' };
  } catch {
    return { value: null, error: 'x-codex-turn-metadata is not valid JSON' };
  }
};

// Resolve a logical session only from Codex's host-authored MCP metadata. A
// turn_id/requestId identifies an ACTION, never a session. All independently
// supplied session candidates must agree; disagreement fails closed so a
// malformed request cannot rekey presence or consume another session's inbox.
export function resolveRequestIdentity(extra, { client, toolName, toolInput } = {}) {
  const normalizedClient = normalizeMcpClient(client);
  const meta = extra?._meta && typeof extra._meta === 'object' ? extra._meta : {};
  const parsedTurn = parseCodexTurnMetadata(meta['x-codex-turn-metadata']);
  const actionId = requestActionId(extra, parsedTurn.value, { toolName, toolInput });
  if (normalizedClient !== 'codex') {
    return { ok: true, status: 'ignored-non-codex', id: null, actionId };
  }
  if (parsedTurn.error) {
    return { ok: false, status: 'invalid', id: null, actionId, diagnostic: parsedTurn.error };
  }

  const rawCandidates = [];
  if (Object.prototype.hasOwnProperty.call(meta, 'threadId')) {
    rawCandidates.push(['threadId', meta.threadId]);
  }
  for (const key of ['session_id', 'thread_id']) {
    if (parsedTurn.value && Object.prototype.hasOwnProperty.call(parsedTurn.value, key)) {
      rawCandidates.push([`x-codex-turn-metadata.${key}`, parsedTurn.value[key]]);
    }
  }
  if (!rawCandidates.length) return { ok: true, status: 'absent', id: null, actionId };

  const candidates = rawCandidates.map(([source, value]) => ({
    source,
    id: boundedIdentityId(value),
  }));
  if (candidates.some((candidate) => !candidate.id)) {
    return {
      ok: false,
      status: 'invalid',
      id: null,
      actionId,
      diagnostic: 'Codex request identity contains an invalid or unbounded session id',
    };
  }
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (ids.size !== 1) {
    return {
      ok: false,
      status: 'mismatch',
      id: null,
      actionId,
      diagnostic: 'Codex request threadId/session_id/thread_id disagree',
    };
  }
  return {
    ok: true,
    status: 'resolved',
    id: candidates[0].id,
    actionId,
    source: 'mcp-request',
  };
}

function resolveMcpSessionSeed({
  env = process.env,
  pid = process.pid,
  nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  const logicalEnvKeys = [
    'KLYPIX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CURSOR_SESSION_ID',
    'CLINE_SESSION_ID',
    'WINDSURF_SESSION_ID',
  ];
  for (const key of logicalEnvKeys) {
    const id = boundedIdentityId(env?.[key]);
    if (id) return { id, logicalSessionId: id, identitySource: 'host-env' };
  }
  const connectionId = boundedIdentityId(env?.KLYPIX_MCP_CONNECTION_ID);
  if (connectionId) return { id: connectionId, logicalSessionId: null, identitySource: null };
  return { id: `mcp-${pid}-${nonce}`, logicalSessionId: null, identitySource: null };
}

export function resolveMcpSessionId({
  env = process.env,
  pid = process.pid,
  nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  return resolveMcpSessionSeed({ env, pid, nonce }).id;
}

// A result submission changes the completion contract for the CURRENT logical
// task: after malformed/conflicting evidence, a result-less retry must not be a
// bypass. Keep that one bit outside worker memory so hot reload, crash recovery,
// and hibernation cannot erase it. File existence is the fail-closed state; the
// payload is diagnostic only, so even a crash during the write leaves a safe
// marker. A fresh phase:start is the explicit boundary that clears it.
export function resultClaimMarkerFileFor(brainPath, sessionId, home) {
  if (!brainPath || !sessionId) return null;
  const lane = laneFileFor(brainPath, home);
  const sessionKey = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
  return lane.replace(/\.json$/, `.result-claim-${sessionKey}.pending`);
}

function readResultClaimPending({ brainPath, sessionId, home }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  try {
    fs.statSync(file);
    return { ok: true, pending: true, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, pending: false, file };
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-read-failed' };
  }
}

function markResultClaimPending({ brainPath, sessionId, home, at = Date.now() }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ schemaVersion: 1, sessionId: String(sessionId), pendingAt: at }));
    try { fs.fsyncSync(fd); } catch { /* existence is already fail-closed */ }
    return { ok: true, pending: true, file, created: true };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // File existence is the fail-closed semantic. Even an unusual existing
      // filesystem object at this exact private marker path preserves the
      // completion obligation; payload shape is deliberately non-authoritative.
      return { ok: true, pending: true, file, created: false };
    }
    // If creation succeeded but writing the diagnostic payload failed, the
    // marker still carries the required semantic and is therefore a success.
    try {
      if (fs.statSync(file)) return { ok: true, pending: true, file, created: true };
    } catch { /* report the original failure below */ }
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-write-failed' };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* */ }
  }
}

function clearResultClaimPending({ brainPath, sessionId, home }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  try {
    fs.unlinkSync(file);
    return { ok: true, pending: false, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, pending: false, file };
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-clear-failed' };
  }
}

// The host-pid this server belongs to (Claude Code exports CLAUDE_PID to every
// child process). Used for the hostmap rotation below and for twin recognition.
export function resolveHostPid(env = process.env) {
  const pid = Number(env?.CLAUDE_PID || env?.KLYPIX_HOST_PID || 0);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// Hostmap: the lifecycle hook writes `<lane>.hostmap.json` mapping its host
// process pid → the CURRENT session id on every prompt. A spawn-time env id
// goes stale when the MCP server outlives /clear or a resume (the server
// process persists; the session id rotates) — re-reading the hostmap on every
// touch keeps the adopted id current with zero agent cooperation.
function hostmapSessionState({ brainPath, hostPid, home, now = Date.now() } = {}) {
  if (!brainPath || !hostPid) return { status: 'absent', id: null };
  try {
    const file = laneFileFor(brainPath, home).replace(/\.json$/, '.hostmap');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = map && typeof map === 'object' ? map[String(hostPid)] : null;
    if (!entry || !compact(entry.sessionId)) return { status: 'absent', id: null };
    if (now - Number(entry.ts || 0) > 10 * 60 * 1000) return { status: 'stale', id: null };   // stale mapping — host gone
    const mapped = compact(entry.sessionId).slice(0, 160);
    // The lifecycle writer updates hostmap + lane as two atomic files. If the
    // second rename fails, the sidecar can briefly be ahead. Adopt only once a
    // matching live lifecycle row for this host pid exists; otherwise an MCP
    // touch would create a blank B while A still owns the real lifecycle scope.
    const row = listActiveSessions({ brainPath, home, now }).find((session) => session.id === mapped);
    if (!row || !Array.isArray(row.channels) || !row.channels.includes('lifecycle')
      || Number(row.hostPid || 0) !== Number(hostPid)) {
      return { status: 'sidecar-ahead', id: mapped };
    }
    return { status: 'ready', id: mapped };
  } catch { return { status: 'unavailable', id: null }; }
}

export function hostmapSessionId(options = {}) {
  const resolved = hostmapSessionState(options);
  return resolved.status === 'ready' ? resolved.id : null;
}

function gitBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * The branch THIS SESSION is actually on — the neutral-vendor fix.
 *
 * Until 1.72.0 every MCP host reported the branch of the VAULT directory,
 * because the seam records `cwd: path.dirname(brainPath)`. Only Claude Code
 * and hooked Codex — the two hosts with lifecycle hooks — supplied a true
 * per-session branch, so the product was measurably better on those two. For a
 * layer whose entire claim is that every coding agent is served equally, that
 * asymmetry is the one defect that cannot be argued away.
 *
 * The MCP server is launched BY the host, so its own process.cwd() is the
 * workspace the user opened for every host that sets it — Cursor, Cline,
 * Windsurf, VS Code, Codex, Kimi, OpenCode, and anything else that speaks MCP,
 * with no hook and no host-specific code. A host that launches from its own
 * install directory simply yields no branch there, and the vault answer stands
 * exactly as before: strictly more signal, never less.
 *
 * Deliberately NOT written into the presence row's `cwd`. That field is
 * session IDENTITY, and the overlap matcher normalizes declared file paths
 * against it — moving it would silently change which files count as the same
 * file, which is a far larger blast radius than this fix is worth.
 */
const hostCwdBranch = (vaultDir) => {
  let hostCwd = null;
  try { hostCwd = process.cwd(); } catch { hostCwd = null; }
  if (hostCwd && path.resolve(hostCwd) !== path.resolve(vaultDir || '')) {
    const fromHost = gitBranch(hostCwd);
    if (fromHost) return fromHost;
  }
  return gitBranch(vaultDir);
};

const peerFingerprint = (sessions, selfId) => (Array.isArray(sessions) ? sessions : [])
  .filter((session) => session.id !== selfId)
  .map((session) => [
    session.id,
    session.client,
    session.branch,
    session.intent,
    ...(Array.isArray(session.files) ? session.files : []),
    ...(Array.isArray(session.observedFiles) ? session.observedFiles : []),
  ].join('|'))
  .sort()
  .join('\n');

export function createMcpPresence({
  server,
  initialVault,
  env = process.env,
  home,
  heartbeatMs = MCP_HEARTBEAT_MS,
  inboxPollMs = MCP_INBOX_POLL_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  // Narrow fault-injection seam for durability regressions. Production never
  // supplies it; keeping the injected surface at the semantic marker writer
  // avoids monkey-patching global fs methods in concurrent tests.
  markResultClaimPendingFn = markResultClaimPending,
  // Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B): the
  // injected engine surface ({ classifyDecay, decayStaleMs, decayMessageStamp,
  // formatDecayAge } from klypix-format.mjs) that lets every MCP delivery
  // surface — pollInbox logging, touch/decorateToolResult notices, brain_sync
  // text + structured messages — stamp a stale build/deploy message as LAST
  // KNOWN. Injection (not an import) keeps this file builtin-only; absent or
  // partial (old bundle), delivery degrades to unstamped — never a throw.
  decay = {},
} = {}) {
  const seedIdentity = resolveMcpSessionSeed({ env });
  let sessionId = seedIdentity.id;
  let logicalSessionId = seedIdentity.logicalSessionId;
  let identitySource = seedIdentity.identitySource;
  const hostPid = resolveHostPid(env);
  // Best-available pid for lane-row correlation (2026-08-14 wave): a host that
  // declares no CLAUDE_PID/KLYPIX_HOST_PID (Codex today) still has a direct
  // parent, and that pid lets readers group this worker's row with its
  // lifecycle sibling. Provenance rides along: 'env' pids are host-declared and
  // safe to liveness-probe; a 'ppid' guess may be a transient wrapper, so the
  // dead-host sweep never probes it — correlation only. The hostmap path keeps
  // using ONLY the env pid (a guessed pid must never adopt a hostmap identity).
  const laneHostPid = hostPid
    || (Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null);
  const laneHostPidSource = hostPid ? 'env' : (laneHostPid ? 'ppid' : null);
  const effectiveInboxPollMs = Number(env?.KLYPIX_MCP_INBOX_POLL_MS)
    || Number(inboxPollMs)
    || MCP_INBOX_POLL_MS;
  let vault = path.resolve(initialVault || process.cwd());
  let brainPath = null;
  let brainLaneIdentity = null;
  let currentProjectBinding = null;
  let timer = null;
  let inboxTimer = null;
  let started = false;
  let lastPeers = '';
  let taskStartedAt = 0;
  // Turn-end heuristic input: has this task generation seen an explicit
  // checkpoint? A model that checkpoints treats the task as multi-step, so its
  // later complete is a deliberate task boundary, not a per-turn sign-off.
  let checkpointSinceTaskStart = false;
  let resultClaimsPending = false;
  let syncNudgeShown = false;
  let modelActionSequence = 0;
  const sentTexts = new Set();
  const notifiedConflicts = new Set();
  const announcedMessageIds = new Set();
  // Public preflight objects are capabilities, never the authority itself.
  // All trusted fields live only in these private WeakMaps so property mutation,
  // cloning, or replay cannot redirect a later sync.
  const pendingSyncPreflights = new WeakMap();
  const consumedSyncPreflights = new WeakMap();
  const authorizedSyncPreflights = new WeakMap();
  const syncInputKey = ({ project, projectProvided = project !== undefined, files, phase = 'checkpoint' } = {}) => JSON.stringify({
    projectProvided: Boolean(projectProvided),
    project: projectProvided ? project : null,
    files: files === undefined ? null : files,
    phase: ['start', 'checkpoint', 'complete'].includes(phase) ? phase : 'checkpoint',
  });

  // Semantic validation belongs before request-identity adoption. In
  // particular, an explicit project is a routing authority, not a cwd hint:
  // never resolve a relative value and never walk upward from the supplied
  // directory. The opaque token lets sync consume this exact checked snapshot
  // instead of repeating filesystem validation after identity has changed.
  const preflightSync = ({ project, projectProvided = project !== undefined, files, phase = 'checkpoint' } = {}) => {
    let requestedVault;
    let resultBrainPath;

    let projectBinding = null;
    if (projectProvided) {
      if (typeof project !== 'string' || !project.length || project.length > 4_096
        || project !== project.trim() || /[\u0000-\u001f\u007f]/.test(project)) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-empty-or-noncanonical',
            requestedProject: typeof project === 'string' ? project.slice(0, 512) : null,
          }),
        };
      }
      if (!path.isAbsolute(project)) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-not-absolute',
            requestedProject: project.slice(0, 512),
          }),
        };
      }
      requestedVault = path.resolve(project);
      try {
        if (!fs.statSync(requestedVault).isDirectory()) {
          return {
            ok: false,
            report: syncPreflightFailure({
              status: 'invalid-project',
              reason: 'project-not-directory',
              requestedProject: requestedVault,
            }),
          };
        }
      } catch {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-not-existing-directory',
            requestedProject: requestedVault,
          }),
        };
      }
      const directBrain = directProjectBrain(requestedVault);
      if (!directBrain.ok) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: directBrain.reason,
            requestedProject: requestedVault,
          }),
        };
      }
      projectBinding = directBrain.binding;
      // Route only through the canonical objects captured above. A later
      // retarget of the caller's junction/symlink cannot redirect lane hashing,
      // result ledgers, registry writes, or brain reads after validation.
      requestedVault = projectBinding.canonicalProject;
      resultBrainPath = projectBinding.canonicalBrain;
    } else {
      requestedVault = vault;
      resultBrainPath = started && requestedVault === vault
        ? brainPath
        : findProjectBrain(requestedVault);
      if (resultBrainPath) {
        const directBrain = directProjectBrain(path.dirname(resultBrainPath));
        if (directBrain.ok) {
          projectBinding = directBrain.binding;
          resultBrainPath = projectBinding.canonicalBrain;
        }
      }
    }

    let declaredFiles = files;
    if (files !== undefined) {
      const checkedScope = validateExactFileScope(files, {
        projectRoot: resultBrainPath ? path.dirname(resultBrainPath) : requestedVault,
      });
      if (!checkedScope.ok) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-scope',
            reason: 'invalid-file-scope',
            requestedProject: requestedVault,
            errors: checkedScope.errors,
          }),
        };
      }
      declaredFiles = checkedScope.files;
    }

    const capability = Object.freeze({ ok: true });
    pendingSyncPreflights.set(capability, Object.freeze({
      inputKey: syncInputKey({ project, projectProvided, files, phase }),
      projectProvided,
      requestedVault,
      resultBrainPath,
      declaredFiles: declaredFiles === undefined ? undefined : Object.freeze([...declaredFiles]),
      projectBinding,
      laneIdentity: projectBinding?.canonicalBrain || resultBrainPath || null,
      requestedProject: projectProvided ? project : requestedVault,
    }));
    return capability;
  };

  const consumeSyncPreflight = (preflight, input = {}) => {
    const snapshot = preflight && typeof preflight === 'object'
      ? pendingSyncPreflights.get(preflight)
      : null;
    if (!snapshot) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: 'preflight-capability-invalid-or-replayed',
        }),
      };
    }
    pendingSyncPreflights.delete(preflight);
    if (snapshot.inputKey !== syncInputKey(input)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: 'preflight-input-changed',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    if (snapshot.projectBinding && !sameProjectBinding(snapshot.projectBinding)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'project-changed',
          reason: 'project-or-brain-identity-changed-after-preflight',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    const consumed = Object.freeze({ ok: true });
    consumedSyncPreflights.set(consumed, snapshot);
    return consumed;
  };

  const revalidateConsumedSyncPreflight = (preflight, input = {}) => {
    const snapshot = preflight && typeof preflight === 'object'
      ? consumedSyncPreflights.get(preflight)
      : null;
    if (!snapshot || snapshot.inputKey !== syncInputKey(input)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: snapshot ? 'preflight-input-changed' : 'preflight-capability-invalid-or-replayed',
          requestedProject: snapshot?.requestedProject,
        }),
      };
    }
    consumedSyncPreflights.delete(preflight);
    if (snapshot.projectBinding && !sameProjectBinding(snapshot.projectBinding)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'project-changed',
          reason: 'project-or-brain-identity-changed-after-preflight',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    // This is the final, one-shot authorization point. The snapshot routes by
    // canonical project/brain paths, so retargeting the caller's lexical link
    // after authorization cannot redirect the operation. In particular, the
    // worker can now adopt request identity without needing an unsafe inverse
    // lane operation if a later lexical-path check observes a change.
    const authorized = Object.freeze({ ok: true });
    authorizedSyncPreflights.set(authorized, snapshot);
    return authorized;
  };

  const verifyProjectBinding = (binding) => !binding || sameProjectBinding(binding);
  const verifyCurrentProjectBinding = () => verifyProjectBinding(currentProjectBinding);
  const refreshCurrentProjectBinding = () => {
    if (!currentProjectBinding) return { ok: true, status: 'not-bound' };
    try {
      // Never start from the lexical path: if the project directory was
      // replaced with a junction, following it would "refresh" trust onto the
      // attacker-selected target. The captured canonical root itself must still
      // be the same directory object; only the direct brain file may have been
      // atomically replaced by a managed KLYPIX write.
      if (filesystemIdentity(currentProjectBinding.canonicalProject)
        !== currentProjectBinding.projectObjectIdentity) {
        return { ok: false, status: 'project-changed' };
      }
      if (canonicalPathKey(fs.realpathSync.native(currentProjectBinding.lexicalProject))
        !== canonicalPathKey(currentProjectBinding.canonicalProject)) {
        return { ok: false, status: 'project-changed' };
      }
      const refreshed = directProjectBrain(currentProjectBinding.canonicalProject);
      if (!refreshed.ok
        || canonicalPathKey(refreshed.binding.canonicalProject)
          !== canonicalPathKey(currentProjectBinding.canonicalProject)
        || path.basename(refreshed.binding.canonicalBrain)
          !== path.basename(currentProjectBinding.canonicalBrain)) {
        return { ok: false, status: 'project-changed' };
      }
      currentProjectBinding = Object.freeze({
        ...refreshed.binding,
        // Retain the caller's exact lexical root so later retargeting remains
        // observable; the refreshed brain identity comes only from canonical root.
        lexicalProject: currentProjectBinding.lexicalProject,
        lexicalBrain: path.join(
          currentProjectBinding.lexicalProject,
          path.basename(refreshed.binding.canonicalBrain),
        ),
        projectLinkIdentity: currentProjectBinding.projectLinkIdentity,
      });
      brainLaneIdentity = currentProjectBinding.canonicalBrain;
      pinLaneIdentity(brainPath, brainLaneIdentity);
      return { ok: true, status: 'refreshed' };
    } catch {
      return { ok: false, status: 'project-changed' };
    }
  };

  // Session-id rotation: the id is resolved once at spawn, but this server
  // process outlives /clear and session resume — the hook-written hostmap is
  // re-checked on every touch so the lane row follows the CURRENT session id
  // instead of silently mislabeling every later conversation (2026-07-29 audit).
  const adoptHostSession = (stamp, targetBrainPath = brainPath, {
    requireDestinationClaim = false,
    verifyBinding: verifyBindingFn = null,
  } = {}) => {
    try {
      if (!targetBrainPath || !hostPid) return { ok: true, status: 'not-applicable' };
      // Codex has many logical threads below one desktop parent. Its hostmap is
      // ambiguous by construction; only request metadata may rekey it.
      const info = clientInfo();
      if (verifyBindingFn && !verifyBindingFn()) {
        return { ok: false, status: 'project-changed', reason: 'project-or-brain-identity-changed-during-host-callback' };
      }
      if (info.client === 'codex') return { ok: true, status: 'not-applicable', clientInfo: info };
      const hostIdentity = hostmapSessionState({ brainPath: targetBrainPath, hostPid, home, now: stamp });
      if (verifyBindingFn && !verifyBindingFn()) {
        return { ok: false, status: 'project-changed', reason: 'project-or-brain-identity-changed-before-host-adoption' };
      }
      if (hostIdentity.status === 'sidecar-ahead') {
        return { ok: false, status: 'sidecar-ahead', mappedId: hostIdentity.id };
      }
      const mapped = hostIdentity.status === 'ready' ? hostIdentity.id : null;
      if (!mapped || mapped === sessionId) {
        return { ok: true, status: mapped ? 'current' : hostIdentity.status, clientInfo: info };
      }
      const previous = sessionId;
      const priorClaim = readResultClaimPending({ brainPath: targetBrainPath, sessionId: previous, home });
      const sameProject = targetBrainPath === brainPath;
      if (requireDestinationClaim
        || (sameProject && resultClaimsPending)
        || priorClaim.pending
        || !priorClaim.ok) {
        const destinationClaim = readResultClaimPending({
          brainPath: targetBrainPath,
          sessionId: mapped,
          home,
        });
        let migrated;
        try {
          migrated = markResultClaimPendingFn({ brainPath: targetBrainPath, sessionId: mapped, home, at: stamp });
        } catch (error) {
          migrated = { ok: false, reason: error?.code || error?.message || 'marker-write-threw' };
        }
        // The marker writer is an injected/fallible preparation callback. It may
        // yield to host code, so revalidate the exact project+brain objects before
        // committing either the source-marker clear or the lane identity change.
        // A marker created only for this aborted preparation is safe to unwind;
        // never attempt an inverse lane rekey after mutation has begun.
        if (verifyBindingFn && !verifyBindingFn()) {
          if (migrated?.created === true && destinationClaim.ok && !destinationClaim.pending) {
            clearResultClaimPending({ brainPath: targetBrainPath, sessionId: mapped, home });
          }
          return {
            ok: false,
            status: 'project-changed',
            mappedId: mapped,
            reason: 'project-or-brain-identity-changed-during-result-claim-preparation',
          };
        }
        if (!migrated.ok) {
          return {
            ok: false,
            status: 'result-claim-migration-failed',
            mappedId: mapped,
            reason: migrated.reason || 'marker-write-failed',
          };
        }
        if (priorClaim.ok) {
          // Destination-first: failure to clear the old marker leaves a safe
          // duplicate, never a missing obligation on the adopted identity.
          clearResultClaimPending({ brainPath: targetBrainPath, sessionId: previous, home });
        }
      }
      sessionId = mapped;
      logicalSessionId = mapped;
      identitySource = 'lifecycle-hostmap';
      // The old row's mcp channel is ours — release it so the lane never holds
      // two rows for one logical session longer than a single touch interval.
      removeSession({
        brainPath: targetBrainPath,
        id: previous,
        channel: 'mcp',
        expectedPid: process.pid,
        home,
        now: stamp,
      });
      lastPeers = '';
      return { ok: true, status: 'adopted', previous, sessionId, brainPath: targetBrainPath, clientInfo: info };
    } catch {
      // Ordinary hostmap I/O remains best-effort. A positively identified
      // sidecar-ahead state is returned above and must never be swallowed.
      return { ok: true, status: 'unavailable' };
    }
  };

  // A host can rotate its logical session id (/clear, resume) before the next
  // heartbeat. Message sending needs the current id BEFORE it snapshots target
  // recipients, so expose a read/identity refresh that does not consume inbox
  // messages or create a second delivery transition in the same tool action.
  const adoptRequestIdentity = (extra, { toolName, toolInput, verifyBinding: verifyBindingFn = null } = {}) => {
    const stamp = now();
    const hostIdentity = adoptHostSession(stamp, brainPath, { verifyBinding: verifyBindingFn });
    if (hostIdentity?.ok === false) {
      const sidecarAhead = hostIdentity.status === 'sidecar-ahead';
      return {
        ok: false,
        status: hostIdentity.status || 'hostmap-adoption-failed',
        id: null,
        actionId: codexToolActionId(extra, { toolName, toolInput }),
        sessionId,
        diagnostic: sidecarAhead
          ? `KLYPIX identity safety check deferred this action: lifecycle identity ${hostIdentity.mappedId || 'unknown'} is staged in the host sidecar but its exact live lifecycle row is not committed yet. No handler, presence identity, or queued-message delivery changed.`
          : `KLYPIX identity safety check deferred this action: durable result-claim state could not move to lifecycle identity ${hostIdentity.mappedId || 'unknown'} (${hostIdentity.reason || 'migration failed'}). No handler, presence identity, lane, or queued-message delivery changed.`,
      };
    }
    const info = hostIdentity.clientInfo || clientInfo();
    if (verifyBindingFn && !verifyBindingFn()) {
      return {
        ok: false,
        status: 'project-changed',
        id: null,
        actionId: codexToolActionId(extra, { toolName, toolInput }),
        sessionId,
        diagnostic: 'KLYPIX identity safety check deferred this action because the project or brain object changed during the host callback. No request identity or queued-message delivery changed.',
      };
    }
    const resolved = resolveRequestIdentity(extra, {
      client: info.client,
      toolName,
      toolInput,
    });
    if (!resolved.ok) {
      return {
        ...resolved,
        sessionId,
        diagnostic: `KLYPIX identity safety check deferred this action: ${resolved.diagnostic}. No presence identity or queued-message delivery changed.`,
      };
    }
    if (!resolved.id) return { ...resolved, sessionId, clientInfo: info };
    if (resolved.id === sessionId) {
      logicalSessionId = resolved.id;
      identitySource = 'mcp-request';
      return { ...resolved, status: 'current', sessionId, clientInfo: info };
    }

    const previous = sessionId;
    if (brainPath) {
      let rotation;
      try {
        rotation = rotateEndedSessionIdentity({
          brainPath,
          fromId: previous,
          toId: resolved.id,
          client: info.client,
          surface: info.surface,
          cwd: path.dirname(brainPath),
          hostPid: laneHostPid,
          hostPidSource: laneHostPidSource,
          home,
          now: stamp,
          expectedPid: process.pid,
        });
      } catch (error) {
        rotation = { ok: false, reason: error?.message || 'identity-rotation-threw' };
      }
      if (rotation?.ok === true) {
        // This is a new conversation, not a continuation of A. Leave A's
        // durable result marker keyed to A and reset only worker-local state.
        sessionId = resolved.id;
        logicalSessionId = resolved.id;
        identitySource = 'mcp-request';
        resultClaimsPending = false;
        taskStartedAt = 0;
        checkpointSinceTaskStart = false;
        lastPeers = '';
        sentTexts.clear();
        notifiedConflicts.clear();
        announcedMessageIds.clear();
        return { ...resolved, status: 'rotated-after-end', sessionId, clientInfo: info };
      }
      if (rotation?.reason !== 'source-not-ended') {
        return {
          ok: false,
          status: 'rotation-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: ended-session rotation could not be verified (${rotation?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
        };
      }

      // Once this worker already holds an exact host-authored logical id, a
      // different exact request id is a new conversation even if lifecycle
      // SessionEnd(A) is still in flight. Provisional rekey semantics would
      // incorrectly move A's scope, aliases, authorship, and message audience
      // onto B. Switch only this MCP channel under the lane lock instead.
      const previousWasExact = logicalSessionId === previous
        && ['mcp-request', 'host-env'].includes(String(identitySource || ''));
      if (previousWasExact) {
        let switched;
        try {
          switched = switchMcpSessionIdentity({
            brainPath,
            fromId: previous,
            toId: resolved.id,
            client: info.client,
            surface: info.surface,
            cwd: path.dirname(brainPath),
            hostPid: laneHostPid,
            hostPidSource: laneHostPidSource,
            home,
            now: stamp,
            expectedPid: process.pid,
          });
        } catch (error) {
          switched = { ok: false, reason: error?.message || 'identity-switch-threw' };
        }
        if (switched?.ok !== true) {
          return {
            ok: false,
            status: 'switch-failed',
            id: null,
            actionId: resolved.actionId,
            sessionId,
            diagnostic: `KLYPIX identity safety check deferred this action: the live session switch could not be recorded (${switched?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
          };
        }
        sessionId = resolved.id;
        logicalSessionId = resolved.id;
        identitySource = 'mcp-request';
        resultClaimsPending = false;
        taskStartedAt = 0;
        checkpointSinceTaskStart = false;
        lastPeers = '';
        sentTexts.clear();
        notifiedConflicts.clear();
        announcedMessageIds.clear();
        return { ...resolved, status: 'switched-live-session', sessionId, clientInfo: info };
      }
    }
    const priorClaim = brainPath
      ? readResultClaimPending({ brainPath, sessionId: previous, home })
      : { ok: true, pending: resultClaimsPending };
    if (brainPath && (resultClaimsPending || priorClaim.pending || !priorClaim.ok)) {
      const destinationClaim = readResultClaimPending({ brainPath, sessionId: resolved.id, home });
      let marker;
      try {
        marker = markResultClaimPendingFn({
          brainPath,
          sessionId: resolved.id,
          home,
          at: stamp,
        });
      } catch (error) {
        marker = { ok: false, reason: error?.code || error?.message || 'marker-write-threw' };
      }
      // Identity migration has a strict prepare/commit boundary: the fallible
      // destination marker completes first, then the exact binding is checked,
      // and only then may rekeySessionIdentity mutate the lane. If the callback
      // retargeted a junction, unwind only our freshly-created preparation marker.
      if (verifyBindingFn && !verifyBindingFn()) {
        if (marker?.created === true && destinationClaim.ok && !destinationClaim.pending) {
          clearResultClaimPending({ brainPath, sessionId: resolved.id, home });
        }
        return {
          ok: false,
          status: 'project-changed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: 'KLYPIX identity safety check deferred this action because the project or brain object changed during result-claim preparation. No presence identity, lane, or queued-message delivery changed.',
        };
      }
      if (!marker.ok) {
        return {
          ok: false,
          status: 'rekey-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: result-claim state could not be migrated (${marker.reason}). No presence identity or queued-message delivery changed.`,
        };
      }
    }

    if (brainPath) {
      let rekey;
      try {
        rekey = rekeySessionIdentity({
          brainPath,
          fromId: previous,
          toId: resolved.id,
          home,
          now: stamp,
          expectedPid: process.pid,
        });
      } catch (error) {
        rekey = { ok: false, reason: error?.message || 'identity-rekey-threw' };
      }
      if (rekey?.ok !== true) {
        return {
          ok: false,
          status: 'rekey-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: the presence lane could not be rekeyed (${rekey?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
        };
      }
      if ((resultClaimsPending || priorClaim.pending || !priorClaim.ok) && priorClaim.ok) {
        // Destination was written first (fail-closed); source is removed only
        // after the atomic lane rekey succeeds. A failed unlink leaves a safe,
        // stale duplicate marker rather than losing the completion obligation.
        clearResultClaimPending({ brainPath, sessionId: previous, home });
      }
    }

    sessionId = resolved.id;
    logicalSessionId = resolved.id;
    identitySource = 'mcp-request';
    lastPeers = '';
    announcedMessageIds.clear();
    return { ...resolved, status: 'adopted', sessionId, clientInfo: info };
  };

  const refreshIdentity = () => {
    adoptHostSession(now());
    return sessionId;
  };

  const clientInfo = () => {
    let version = {};
    try { version = server?.server?.getClientVersion?.() || {}; } catch { /* optional */ }
    return {
      client: normalizeMcpClient(version.name),
      surface: compact(version.name) || 'mcp',
    };
  };

  const sendNotice = (message) => {
    if (!message || typeof server?.sendLoggingMessage !== 'function') return false;
    Promise.resolve(server.sendLoggingMessage({
      level: 'info',
      logger: 'klypix-presence',
      data: message,
    })).catch(() => {});
    return true;
  };

  // Best-effort proactive path: MCP logging notifications can surface an
  // overlap while the older session is still working. This deliberately PEEKS
  // instead of acknowledging. Hosts are allowed to hide logging notifications,
  // so the same warning remains unread and is guaranteed to arrive in-band on
  // the next KLYPIX tool result / brain_sync call.
  const pollInbox = () => {
    if (!brainPath) return [];
    const identity = adoptHostSession(now());
    if (identity?.ok === false) return [];
    const pending = peekMessages({
      brainPath,
      sessionId,
      ignoreTexts: [...sentTexts],
      home,
      now: now(),
    }).filter((message) => !announcedMessageIds.has(message.id));
    if (!pending.length) return [];
    if (sendNotice(formatReceivedMessages(pending, now(), decay, sessionId))) {
      for (const message of pending) announcedMessageIds.add(message.id);
      while (announcedMessageIds.size > 100) {
        announcedMessageIds.delete(announcedMessageIds.values().next().value);
      }
    }
    return pending;
  };

  const touch = ({
    event = 'McpHeartbeat',
    includePresence = false,
    includeSolo = false,
    deliverMessages = false,
    intent,
    files,
    replaceFiles = false,
    actionId = '',
    hostIdentityPrepared = false,
    clientInfoPrepared = null,
    branchPrepared,
  } = {}) => {
    if (!brainPath) return { sessions: [], messages: [], notice: '', laneWriteOk: null, laneWriteSkippedReason: 'no-lane' };
    const stamp = now();
    const identity = hostIdentityPrepared
      ? { ok: true, status: 'prepared' }
      : adoptHostSession(stamp);
    if (identity?.ok === false) {
      return {
        sessions: listActiveSessions({ brainPath, home, now: stamp }),
        messages: [],
        notice: '',
        laneWriteOk: false,
        laneWriteSkippedReason: `identity-${identity.status || 'adoption-failed'}`,
        deliveryWriteOk: false,
        deliveryWriteSkippedReason: `identity-${identity.status || 'adoption-failed'}`,
      };
    }
    const { client, surface } = clientInfoPrepared || clientInfo();
    const sessions = upsertSession({
      brainPath,
      id: sessionId,
      client,
      surface,
      branch: branchPrepared !== undefined
        ? branchPrepared
        : hostCwdBranch(path.dirname(brainPath)),
      intent,
      intentSource: intent !== undefined ? 'declared' : null,
      files,
      replaceFiles,
      event,
      channel: 'mcp',
      cwd: path.dirname(brainPath),
      hostPid: laneHostPid,
      hostPidSource: laneHostPidSource,
      logicalSessionId,
      identitySource,
      home,
      now: stamp,
    });
    let messages = [];
    let deliveryWriteOk = null;
    let deliveryWriteSkippedReason = null;
    if (deliverMessages && sessions?.laneWriteOk === false) {
      // Identity/presence mutation did not land, so do not advance a receipt in
      // a separate lock acquisition and pretend the overall action was durable.
      deliveryWriteOk = false;
      deliveryWriteSkippedReason = 'presence-lane-write-failed';
    } else if (deliverMessages) {
      try {
        messages = receiveMessages({
          brainPath,
          sessionId,
          ignoreTexts: [...sentTexts],
          home,
          now: stamp,
          actionId,
        });
        deliveryWriteOk = messages?.deliveryWriteOk ?? null;
        deliveryWriteSkippedReason = messages?.deliveryWriteSkippedReason ?? null;
      } catch (error) {
        messages = [];
        deliveryWriteOk = false;
        deliveryWriteSkippedReason = `write-failed:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`;
      }
    }
    if (deliverMessages) sentTexts.clear();

    const nextPeers = peerFingerprint(sessions, sessionId);
    const presenceChanged = nextPeers !== lastPeers;
    lastPeers = nextPeers;
    const presence = (includePresence || presenceChanged)
      ? formatPresenceMessage(sessions, sessionId, { includeSolo, now: stamp })
      : '';
    const notice = [
      presence,
      formatReceivedMessages(messages, stamp, decay, sessionId),
    ].filter(Boolean).join('\n\n');
    if (notice) sendNotice(notice);
    // Additive, non-breaking: surface whether this touch's lane write actually
    // landed (agent-presence.mjs withWriteVerdict). A lock timeout returns a
    // read-only peer snapshot that does NOT include this heartbeat, and that used
    // to be indistinguishable from a successful write. null = unknown (an older
    // bundled agent-presence.mjs that does not stamp the verdict).
    return {
      sessions,
      messages,
      notice,
      laneWriteOk: sessions?.laneWriteOk ?? null,
      laneWriteSkippedReason: sessions?.laneWriteSkippedReason ?? null,
      deliveryWriteOk,
      deliveryWriteSkippedReason,
    };
  };

  const stop = ({ sessionId: stopSessionId = sessionId } = {}) => {
    if (timer) clearIntervalFn(timer);
    if (inboxTimer) clearIntervalFn(inboxTimer);
    timer = null;
    inboxTimer = null;
    if (brainPath) removeSession({
      brainPath,
      id: stopSessionId,
      channel: 'mcp',
      expectedPid: process.pid,
      home,
      now: now(),
    });
    brainPath = null;
    brainLaneIdentity = null;
    currentProjectBinding = null;
    started = false;
    lastPeers = '';
    announcedMessageIds.clear();
  };

  const start = (nextVault = vault, details = {}, validatedSelection = null) => {
    const resolved = path.resolve(nextVault || vault);
    const selectedBrainPath = validatedSelection && Object.prototype.hasOwnProperty.call(validatedSelection, 'brainPath')
      ? validatedSelection.brainPath
      : undefined;
    if (started && resolved === vault
      && (selectedBrainPath === undefined || selectedBrainPath === brainPath)) {
      // Same reason as the sync() adoption above: a reconnect to the vault we
      // are already on must still re-adopt the freshly validated binding, or a
      // brain rewritten since the last bind leaves this connection guarded by a
      // dead inode.
      if (validatedSelection?.projectBinding) currentProjectBinding = validatedSelection.projectBinding;
      return touch({ event: 'McpReconnect', includePresence: true });
    }
    if (started) stop({
      sessionId: validatedSelection?.sourceSessionId || sessionId,
    });
    vault = resolved;
    brainPath = selectedBrainPath === undefined ? findProjectBrain(vault) : selectedBrainPath;
    if (!brainPath) return { sessions: [], messages: [], notice: '' };
    brainLaneIdentity = validatedSelection?.laneIdentity || brainPath;
    currentProjectBinding = validatedSelection?.projectBinding || null;
    pinLaneIdentity(brainPath, brainLaneIdentity);
    started = true;
    const first = touch({
      event: details.event || 'McpInitialize',
      includePresence: true,
      includeSolo: details.includeSolo === true,
      deliverMessages: details.deliverMessages === true,
      intent: details.intent,
      files: details.files,
      replaceFiles: details.replaceFiles === true,
      hostIdentityPrepared: details.hostIdentityPrepared === true,
      clientInfoPrepared: details.clientInfoPrepared || null,
      branchPrepared: details.branchPrepared,
      // Forward the action identity (2026-08-14 review): without it, every
      // server instance's FIRST sync advanced delivery receipts with
      // actionId '' — records got no offered/acknowledgedActionId, breaking
      // same-action dedupe and the lease's third-action evidence.
      actionId: details.actionId || '',
    });
    // Consume the write verdict (1.52.0 plumbed it; nothing read it): a
    // contended lane skips the write, and ~3 skipped heartbeats in a row used
    // to make a LIVE session read as dead to every peer, silently. One
    // immediate same-tick retry clears transient contention; persistent
    // failure is surfaced through the server's logging channel.
    let missedLaneWrites = 0;
    timer = setIntervalFn(() => {
      let beat = touch();
      if (beat?.laneWriteOk === false) beat = touch();   // one quick retry
      if (beat?.laneWriteOk !== false) { missedLaneWrites = 0; return; }
      missedLaneWrites++;
      if (missedLaneWrites >= 3) {
        try { server?.server?.sendLoggingMessage?.({ level: 'warning', data: `KLYPIX presence heartbeat skipped ${missedLaneWrites}× (lane contended) — peers may briefly see this session as idle.` }); } catch { /* logging is best-effort */ }
        missedLaneWrites = 0;
      }
    }, Math.max(5_000, Number(heartbeatMs) || MCP_HEARTBEAT_MS));
    inboxTimer = setIntervalFn(
      () => pollInbox(),
      Math.max(250, effectiveInboxPollMs),
    );
    timer?.unref?.();
    inboxTimer?.unref?.();
    return first;
  };

  const sync = ({
    project,
    intent,
    files,
    phase = 'checkpoint',
    results,
    releaseIntent,
    releaseClaim,
    deliverMessages = true,
    include_context,
    actionId = '',
    preflight,
    requestIdentity,
  } = {}) => {
    const syncStartedAt = Date.now();
    const nextPhase = ['start', 'checkpoint', 'complete'].includes(phase) ? phase : 'checkpoint';
    const completing = nextPhase === 'complete';
    // Release intent is validated fail-closed BEFORE any mutation (same
    // contract as project/file preflight): a malformed declaration must not
    // half-sync and silently skip the lease it asked for.
    const releaseIntentChecked = validateReleaseIntent(releaseIntent);
    if (releaseIntentChecked.provided && !releaseIntentChecked.ok) {
      const report = syncPreflightFailure({
        status: 'invalid-release-intent',
        reason: 'release-intent-malformed',
        requestedProject: typeof project === 'string' ? project.slice(0, 512) : null,
      });
      report.structured.phase = nextPhase;
      report.structured.errors = releaseIntentChecked.errors.map((message) => ({ message }));
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      report.text = [
        'KLYPIX release intent was rejected; no task, lease, presence, or message state changed.',
        ...releaseIntentChecked.errors.map((error) => `- ${error}`),
        'Supply releaseIntent as { version: "X.Y.Z", ref: "<git branch or tag>" }.',
      ].join('\n');
      return report;
    }
    const releaseClaimChecked = validateReleaseClaim(releaseClaim);
    if (releaseClaimChecked.provided && !releaseClaimChecked.ok) {
      const report = syncPreflightFailure({
        status: 'invalid-release-claim',
        reason: 'release-claim-malformed',
        requestedProject: typeof project === 'string' ? project.slice(0, 512) : null,
      });
      report.structured.phase = nextPhase;
      report.structured.errors = releaseClaimChecked.errors.map((message) => ({ message }));
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      report.text = [
        'KLYPIX release claim was rejected; no task, lease, claim, presence, or message state changed.',
        ...releaseClaimChecked.errors.map((error) => `- ${error}`),
        'Supply releaseClaim as { shas: ["<sha>", ...], note?: "why it matters" } to stake, or { withdraw: [...] } to withdraw.',
      ].join('\n');
      return report;
    }
    const preflightInput = {
      project,
      projectProvided: project !== undefined,
      files,
      phase: nextPhase,
    };
    let checkedPreflight = null;
    if (preflight && typeof preflight === 'object' && authorizedSyncPreflights.has(preflight)) {
      checkedPreflight = authorizedSyncPreflights.get(preflight);
      authorizedSyncPreflights.delete(preflight);
      if (checkedPreflight.inputKey !== syncInputKey(preflightInput)) {
        checkedPreflight = {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-preflight',
            reason: 'preflight-input-changed',
          }),
        };
      } else if (checkedPreflight.projectBinding
        && !sameProjectBinding(checkedPreflight.projectBinding)) {
        checkedPreflight = {
          ok: false,
          report: syncPreflightFailure({
            status: 'project-changed',
            reason: 'project-or-brain-identity-changed-after-authorization',
            requestedProject: checkedPreflight.requestedProject,
          }),
        };
      }
    } else {
      const candidate = preflight || preflightSync(preflightInput);
      if (!candidate.ok) checkedPreflight = candidate;
      else {
        const consumed = consumedSyncPreflights.has(candidate)
          ? candidate
          : consumeSyncPreflight(candidate, preflightInput);
        if (!consumed.ok) checkedPreflight = consumed;
        else {
          const authorized = revalidateConsumedSyncPreflight(consumed, preflightInput);
          if (!authorized.ok) checkedPreflight = authorized;
          else {
            checkedPreflight = authorizedSyncPreflights.get(authorized);
            authorizedSyncPreflights.delete(authorized);
          }
        }
      }
    }
    if (!checkedPreflight || checkedPreflight.ok === false) {
      const report = checkedPreflight?.report || syncPreflightFailure({
        status: 'invalid-preflight',
        reason: 'preflight-capability-invalid-or-replayed',
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    const {
      requestedVault,
      resultBrainPath,
      declaredFiles,
      projectBinding,
      laneIdentity,
    } = checkedPreflight;
    if (resultBrainPath && laneIdentity) pinLaneIdentity(resultBrainPath, laneIdentity);
    const verifiedBinding = () => verifyProjectBinding(projectBinding);
    const switchingProject = Boolean(started && resultBrainPath && resultBrainPath !== brainPath);
    const bindingTargetProject = Boolean(resultBrainPath && (!started || resultBrainPath !== brainPath));
    let sourceSessionIdForStop = switchingProject ? sessionId : null;
    let targetHostIdentityAdopted = false;
    let preparedClientInfo = requestIdentity?.clientInfo || null;
    // Request metadata is resolved (purely) by the worker before this call, but
    // committed only after the exact target project capability is authorized.
    // This prevents invalid brain_sync routing from rekeying the current lane.
    if (requestIdentity?.ok === false) {
      const report = syncPreflightFailure({
        status: requestIdentity.status || 'invalid-request-identity',
        reason: requestIdentity.diagnostic || requestIdentity.status || 'invalid-request-identity',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (requestIdentity?.id && clientInfo().client !== 'codex') {
      const report = syncPreflightFailure({
        status: 'invalid-request-identity',
        reason: 'logical request identity is accepted only from Codex host metadata',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (started && resultBrainPath && resultBrainPath === brainPath) {
      const hostAdoption = adoptHostSession(now(), brainPath, { verifyBinding: verifiedBinding });
      if (hostAdoption?.ok === false) {
        const durationMs = Math.max(0, Date.now() - syncStartedAt);
        return {
          sessions: [],
          messages: [],
          notice: '',
          conflicts: [],
          resultConflicts: [],
          alertsQueued: [],
          laneWriteOk: null,
          laneWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          deliveryWriteOk: null,
          deliveryWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          isError: true,
          structured: {
            schemaVersion: 1,
            status: hostAdoption.status || 'identity-adoption-failed',
            phase: nextPhase,
            reason: hostAdoption.reason || hostAdoption.status || 'identity-adoption-failed',
            requestedProject: checkedPreflight.requestedProject || requestedVault,
            mutation: 'none',
            identityMutation: 'none',
            deliveryMutation: 'none',
            timingMs: { coordination: durationMs },
          },
          text: `KLYPIX identity safety check deferred brain_sync before task, result, lane, registry, or message mutation (${hostAdoption.reason || hostAdoption.status || 'identity adoption failed'}). Retry after the exact lifecycle identity and durable result-claim state are available.`,
        };
      }
      preparedClientInfo = hostAdoption.clientInfo || preparedClientInfo;
    }
    if (bindingTargetProject) {
      // Cross-project routing must establish the target lane's exact lifecycle
      // identity before task timestamps, result markers/ledgers, or stop(A).
      // Unlike a same-project rotation, A's worker-local result obligation does
      // not belong to B; adoptHostSession therefore consults only B's durable
      // source marker when targetBrainPath differs from the current brain.
      const hostAdoption = adoptHostSession(now(), resultBrainPath, {
        requireDestinationClaim: results !== undefined,
        verifyBinding: verifiedBinding,
      });
      if (hostAdoption?.ok === false) {
        const durationMs = Math.max(0, Date.now() - syncStartedAt);
        return {
          sessions: [], messages: [], notice: '', conflicts: [], resultConflicts: [], alertsQueued: [],
          laneWriteOk: null,
          laneWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          deliveryWriteOk: null,
          deliveryWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          isError: true,
          structured: {
            schemaVersion: 1,
            status: hostAdoption.status || 'identity-adoption-failed',
            phase: nextPhase,
            reason: hostAdoption.reason || hostAdoption.status || 'identity-adoption-failed',
            requestedProject: checkedPreflight.requestedProject || requestedVault,
            mutation: 'none',
            identityMutation: 'none',
            deliveryMutation: 'none',
            timingMs: { coordination: durationMs },
          },
          text: `KLYPIX identity safety check deferred brain_sync before task, result, lane, registry, or message mutation (${hostAdoption.reason || hostAdoption.status || 'identity adoption failed'}). Retry after the target project's exact lifecycle identity and durable result-claim state are available.`,
        };
      }
      targetHostIdentityAdopted = hostAdoption.status === 'adopted';
      preparedClientInfo = hostAdoption.clientInfo || preparedClientInfo;
      if (switchingProject && targetHostIdentityAdopted) {
        sourceSessionIdForStop = hostAdoption.previous;
      }
    }
    if (requestIdentity?.id && requestIdentity.id !== sessionId) {
      // After target routing is authorized, use the existing adoption machinery
      // against the still-bound lane. Codex never consults a lifecycle hostmap;
      // all fallible target-host gating has already completed above.
      const adopted = adoptRequestIdentity({
        _meta: { threadId: requestIdentity.id },
      }, {
        toolName: 'brain_sync',
        toolInput: { project, files, phase: nextPhase },
        verifyBinding: verifiedBinding,
      });
      if (adopted?.ok === false) {
        const report = syncPreflightFailure({
          status: adopted.status || 'request-identity-adoption-failed',
          reason: adopted.diagnostic || adopted.status || 'request-identity-adoption-failed',
          requestedProject: checkedPreflight.requestedProject || requestedVault,
        });
        report.structured.phase = nextPhase;
        // Adoption failure paths are designed fail-closed before lane mutation.
        report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
        return report;
      }
      if (switchingProject && !targetHostIdentityAdopted) {
        sourceSessionIdForStop = sessionId;
      }
    }
    // All host/client callbacks that can run before coordination mutation have
    // completed. Guard the exact directory+brain objects one final time here;
    // every later lane/marker/ledger lookup is pinned to laneIdentity and cannot
    // be redirected by a lexical junction retarget.
    if (!preparedClientInfo) preparedClientInfo = clientInfo();
    const preparedBranch = resultBrainPath
      ? hostCwdBranch(path.dirname(resultBrainPath))
      : null;
    if (!verifiedBinding()) {
      const report = syncPreflightFailure({
        status: 'project-changed',
        reason: 'project-or-brain-identity-changed-before-sync-mutation',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (bindingTargetProject) {
      // Result obligations are project-local durable state, not a property of
      // this long-lived worker process. A checkpoint/complete A -> B switch
      // derives the in-memory bit from B only after every fallible host callback
      // and the final binding guard. Never clear A's marker here.
      const targetClaim = readResultClaimPending({
        brainPath: resultBrainPath,
        sessionId,
        home,
      });
      resultClaimsPending = targetClaim.pending || !targetClaim.ok;
    }
    if (nextPhase === 'start') {
      taskStartedAt = now();
      checkpointSinceTaskStart = false;
      notifiedConflicts.clear();
    } else if (!taskStartedAt && !completing) {
      taskStartedAt = now();
    }
    if (nextPhase === 'checkpoint') checkpointSinceTaskStart = true;
    const hasDefinedResults = results !== undefined;
    let resultReconciliation = null;
    let completionBlocked = false;
    let resultSubmissionRejected = false;
    const stateConflicts = [];
    // Capture the authoritative lane declaration before result reconciliation
    // or completion can mutate it. Schema-v2 evidence must prove the scope the
    // session actually declared; accepting a caller-supplied scope would let a
    // result manifest self-attest to different files or a different intent.
    const activeCompletionScope = completing && resultBrainPath
      ? listActiveSessions({ brainPath: resultBrainPath, home, now: now() })
        .find((session) => session.id === sessionId)
      : null;

    if (nextPhase === 'start') {
      if (!resultBrainPath) resultClaimsPending = false;
      else {
        const reset = clearResultClaimPending({ brainPath: resultBrainPath, sessionId, home });
        resultClaimsPending = reset.ok ? false : true;
        if (!reset.ok) stateConflicts.push({
          kind: 'result-claim-state-write-failed',
          severity: 'blocking',
          reason: `could not clear the prior task's durable result-claim marker (${reset.reason})`,
        });
      }
    }

    if (hasDefinedResults) {
      resultClaimsPending = true;
      const marked = markResultClaimPendingFn({
        brainPath: resultBrainPath,
        sessionId,
        home,
        at: now(),
      });
      if (!marked.ok) stateConflicts.push({
        kind: 'result-claim-state-write-failed',
        severity: 'blocking',
        reason: `could not persist the pending result claim (${marked.reason})`,
      });
      if (!completing) {
        resultSubmissionRejected = true;
        resultReconciliation = {
          ok: false,
          status: 'needs-reconciliation',
          ledgerWriteOk: null,
          claims: [],
          conflicts: [{
            kind: 'result-manifest-wrong-phase',
            severity: 'blocking',
            reason: 'result manifests are accepted only with phase "complete"; resubmit them on completion',
          }],
        };
      } else {
        // Reconcile BEFORE the completion touch. That touch deliberately clears
        // task intent/files; doing it first would make an invalid or conflicting
        // result look complete even if the later evidence check failed.
        resultReconciliation = recordResultManifests({
          brainPath: resultBrainPath,
          projectRoot: resultBrainPath ? path.dirname(resultBrainPath) : requestedVault,
          sessionId,
          sessionAliases: activeCompletionScope
            ? [activeCompletionScope.logicalSessionId, ...(activeCompletionScope.aliases || [])]
            : [],
          declaredScope: activeCompletionScope
            ? { intent: activeCompletionScope.intent || '', files: activeCompletionScope.files || [] }
            : undefined,
          results,
          home,
          now: now(),
        });
        completionBlocked = resultReconciliation?.ok !== true || !marked.ok;
      }
    } else if (completing) {
      const durable = resultBrainPath
        ? readResultClaimPending({ brainPath: resultBrainPath, sessionId, home })
        : { ok: true, pending: resultClaimsPending };
      resultClaimsPending = resultClaimsPending || durable.pending || !durable.ok;
      if (!durable.ok) stateConflicts.push({
        kind: 'result-claim-state-read-failed',
        severity: 'blocking',
        reason: `could not verify whether this task owes result evidence (${durable.reason})`,
      });
    }
    if (completing && !hasDefinedResults && resultClaimsPending) {
      // Once this task has declared a result claim, omitting evidence on a retry
      // cannot bypass a prior invalid/conflicting submission. A fresh `start` is
      // the explicit boundary that returns to the legacy no-result contract.
      resultReconciliation = {
        ok: false,
        status: 'needs-reconciliation',
        ledgerWriteOk: null,
        claims: [],
        conflicts: [{
          kind: 'result-manifest-required',
          severity: 'blocking',
          reason: 'this task previously submitted a result claim; resubmit corrected evidence',
        }],
      };
      completionBlocked = true;
    }
    // (d) Turn-end vs task-end (2026-08-14 wave). The tool instruction "call
    // brain_sync with phase complete before your final response" reads PER TURN
    // to some hosts, so a model may complete moments after declaring scope —
    // wiping intent/files while the task is still mid-flight, leaving the
    // session scope-less to every peer until the next prompt or tool event. A
    // complete with NO result evidence, arriving within
    // PREMATURE_COMPLETE_WINDOW_MS of this worker's task start with NO
    // intervening checkpoint, downgrades to a scope-PRESERVING checkpoint and
    // says why. A complete carrying results, following a checkpoint, or on a
    // mature task keeps full completion semantics, and the blocked
    // needs-reconciliation path above always wins (a deferral must never let a
    // completion bypass result reconciliation).
    const completionDeferred = completing && !completionBlocked
      && !hasDefinedResults && !resultClaimsPending
      && taskStartedAt > 0
      && now() - taskStartedAt < PREMATURE_COMPLETE_WINDOW_MS
      && !checkpointSinceTaskStart
      && Boolean(activeCompletionScope
        && (compact(activeCompletionScope.intent) || (activeCompletionScope.files || []).length));
    const clearCompletionScope = completing && !completionBlocked && !completionDeferred;
    const priorCompletionScope = clearCompletionScope ? activeCompletionScope : null;
    const shouldDeliverMessages = deliverMessages !== false && include_context !== false;
    const details = {
      event: clearCompletionScope
        ? 'McpTaskComplete'
        : (nextPhase === 'start' ? 'McpTaskStart' : 'McpTaskCheckpoint'),
      includePresence: true,
      includeSolo: true,
      deliverMessages: shouldDeliverMessages,
      actionId: actionId || `brain-sync:${process.pid}:${++modelActionSequence}`,
      // Intent semantics by phase (2026-08-07 — a checkpoint sync carrying an
      // empty intent used to DECLARE that emptiness, masking the session as
      // sync-silent for every peer): 'complete' clears deliberately; 'start' is
      // a task boundary, so a missing intent clears the OLD task's intent
      // rather than inheriting it; 'checkpoint' with a missing/empty intent
      // keeps the previous declaration — it is a progress ping, not a recant.
      intent: clearCompletionScope ? ''
        : (completing ? undefined
          : (compact(intent) ? intent : (nextPhase === 'start' ? '' : undefined))),
      // A phase:start is a hard task boundary. Omitting files must clear the
      // prior task's scope instead of accidentally inheriting it.
      files: clearCompletionScope ? []
        : (completing ? undefined : (nextPhase === 'start' ? (declaredFiles ?? []) : declaredFiles)),
      replaceFiles: clearCompletionScope || nextPhase === 'start',
      // The exact target lifecycle identity was checked above. Re-running a
      // fallible hostmap read after task/result mutation (or after stop(A))
      // would reopen the transaction window this sync just closed.
      hostIdentityPrepared: Boolean(resultBrainPath),
      clientInfoPrepared: preparedClientInfo,
      branchPrepared: preparedBranch,
    };
    // Adopt the preflight's binding on BOTH arms, not just the start() arm.
    // A same-project re-sync takes touch(), which never reassigns — so the
    // guard kept comparing a binding whose brain inode had already been retired
    // by an atomic write (every managed brain write is writeFileSync+rename, so
    // ANY write by anyone, including this session's own Stop hook, mints a new
    // inode). The result was a permanent deadlock: brain_sync succeeded and
    // reported the right project while every other verb was rejected, and the
    // only refresh path was itself gated behind the failing check. This binding
    // was already validated three times earlier in THIS call (preflightSync →
    // consumeSyncPreflight → revalidateConsumedSyncPreflight), so adopting it is
    // strictly more current than retaining the stale one and grants no new
    // authority — the canonical-root and escape checks already ran on it.
    if (projectBinding) currentProjectBinding = projectBinding;
    let report = started && requestedVault === vault && resultBrainPath === brainPath
      ? touch(details)
      : start(requestedVault, details, {
        brainPath: resultBrainPath,
        sourceSessionId: sourceSessionIdForStop,
        laneIdentity,
        projectBinding,
      });
    const resultConflicts = [...(resultReconciliation?.conflicts || []), ...stateConflicts];
    // A completion write that did not land is not completion. The old scope is
    // still authoritative in the lane, so retain it and say so explicitly.
    if (completing && report?.laneWriteOk === false) {
      completionBlocked = true;
      resultConflicts.push({
        kind: 'presence-lane-write-failed',
        severity: 'blocking',
        reason: report.laneWriteSkippedReason || 'presence lane write did not land',
      });
    }
    if (completing && hasDefinedResults && !completionBlocked) {
      // The obligation ends only after BOTH evidence reconciliation and the
      // presence completion write land. Clearing this marker earlier let a
      // worker restart turn a contended lane write into a result-less bypass.
      const cleared = clearResultClaimPending({ brainPath: resultBrainPath, sessionId, home });
      if (cleared.ok) resultClaimsPending = false;
      else {
        completionBlocked = true;
        resultConflicts.push({
          kind: 'result-claim-state-write-failed',
          severity: 'blocking',
          reason: `validated evidence was recorded but its pending marker could not be cleared (${cleared.reason})`,
        });
        // The task row was already cleared one line of state earlier. Restore
        // its exact prior declaration so the error response remains truthful.
        report = touch({
          event: 'McpTaskCheckpoint',
          includePresence: true,
          includeSolo: true,
          deliverMessages: false,
          intent: priorCompletionScope?.intent || '',
          files: priorCompletionScope?.files || [],
          replaceFiles: true,
        });
        if (report?.laneWriteOk === false) resultConflicts.push({
          kind: 'presence-lane-write-failed',
          severity: 'blocking',
          reason: report.laneWriteSkippedReason || 'task scope restoration did not land after result-claim state failure',
        });
      }
    }
    // A deferred (turn-end) complete keeps the task open — its conflict-alert
    // dedupe state must survive with it; only a REAL completion resets it.
    if (clearCompletionScope) {
      notifiedConflicts.clear();
    }
    if (!brainPath) {
      const blocked = (completing && completionBlocked) || resultSubmissionRejected;
      return {
        ...report,
        conflicts: [],
        resultConflicts,
        isError: blocked,
        structured: {
          schemaVersion: 1,
          status: blocked ? 'needs-reconciliation' : 'idle',
          phase: nextPhase,
          reason: 'no-project-brain',
          requestedProject: requestedVault,
          ...(resultReconciliation ? { resultReconciliation: {
            status: resultReconciliation.status,
            claims: resultReconciliation.claims || [],
            ledgerWriteOk: resultReconciliation.ledgerWriteOk ?? null,
            machineLocal: true,
            ...(resultReconciliation.receipt ? { receipt: resultReconciliation.receipt } : {}),
            ...(resultReconciliation.receiptHash ? { receiptHash: resultReconciliation.receiptHash } : {}),
          } } : {}),
          ...(resultConflicts.length ? { resultConflicts } : {}),
        },
        text: blocked
          ? `KLYPIX completion needs reconciliation: no writable project brain/result lane was available at ${requestedVault}. The task scope was not cleared.`
          : `KLYPIX Context Gateway is idle: no brain.klypix was found at or above ${requestedVault}.`,
      };
    }

    const stamp = now();
    const conflicts = findPresenceConflicts(report.sessions, sessionId);
    const snapshot = buildPresenceSnapshot(report.sessions, sessionId, { now: stamp });
    const alertsQueued = [];
    if (!completing) {
      for (const peer of conflicts) {
        // Explicit arrow: normalizeFileKey now takes an optional `root` second
        // argument, so a bare `.map(normalizeFileKey)` would hand it the array
        // INDEX as the project root.
        const filesKey = peer.files.map((file) => normalizeFileKey(file)).sort().join('|');
        const key = `${peer.id}|${filesKey}`;
        if (notifiedConflicts.has(key)) continue;
        notifiedConflicts.add(key);
        const annotated = annotateConflictFiles(peer);
        const queued = postPresenceMessage({
          brainPath,
          from: sessionId,
          to: peer.id,
          text: `Automatic KLYPIX overlap alert: ${shortestUniqueSessionPrefix(report.sessions, sessionId, 12) || String(sessionId).slice(0, 12)}`
            + `${compact(intent) ? ` plans "${compact(intent).slice(0, 110)}"` : ' synchronized a task'}`
            + ` and reports the same file(s): ${annotated.files.join(', ')}${annotated.legend}. Coordinate before editing.`,
          dedupeKey: `overlap|${sessionId}|${peer.id}|${taskStartedAt}|${filesKey}`,
          home,
          now: stamp,
        });
        if (queued.posted) alertsQueued.push({ peerId: peer.id, files: peer.files });
      }
    }

    const conflictText = conflicts.length
      ? [
        'KLYPIX exact file-overlap warning:',
        ...conflicts.map((peer) => {
          const annotated = annotateConflictFiles(peer);
          return `- ${shortestUniqueSessionPrefix(report.sessions, peer.id, 12) || String(peer.id).slice(0, 12)}${peer.intent ? ` "${String(peer.intent).slice(0, 80)}"` : ''}: ${annotated.files.join(', ')}${annotated.legend}`;
        }),
        alertsQueued.length
          ? 'The earlier peer was automatically queued an exact-once overlap alert; coordinate ownership before editing.'
          : 'Coordinate ownership before editing the overlapping files.',
      ].join('\n')
      : 'No exact file overlap is currently reported by another synchronized task.';
    // Mechanical repo-state (2026-08-14 bundle-currency incident): branch, tag
    // and version truth plus bundled-mirror drift, collected IN THE SERVER so
    // every MCP client — Claude, Codex, Cursor, Cline, Desktop — gets equal
    // protection with no hook. Derived from the verified brainPath (never raw
    // caller input, per the pinned-binding guard above); any git failure
    // degrades to omitting the block; a 60s per-process cache keeps repeated
    // syncs cheap. Stateless — it never touches the observeShipDrift baseline,
    // so a fresh session on an already-drifted repo still sees the drift.
    const repoState = completing ? null : collectRepoState(path.dirname(brainPath));
    const repoStateWarning = repoStateWarnings(repoState).join('\n');
    // ── Release lease (1.70.0 measured wave) ────────────────────────────────
    // Exclusive per-project release-preparation coordination, riding the lane
    // file and its existing liveness rules (agent-presence.mjs). Semantics:
    //   declare (start/checkpoint) → take or hard-conflict; holder re-declare
    //   refreshes. A plain checkpoint from the holder refreshes the ~2h TTL. A
    //   REAL completion (not a deferred turn-end, not a blocked one) frees it.
    //   Expiry and the dead-session sweep free it without any cooperation.
    // Every peer's sync while a lease is active gains one footer line; with no
    // lease but a checkout AHEAD of the last released tag, a zero-config soft
    // advisory names the gap. All response fields are additive (schema 1).
    let releaseLease = null;
    let releaseText = '';
    let releaseFooterLine = '';
    let releaseAdvisory = null;
    let releaseAdvisoryText = '';
    let workAtRisk = null;
    let workAtRiskText = '';
    let releaseClaimResult = null;
    let committedClaimProblems = [];
    {
      const leaseStamp = now();
      let outcome = null;
      // ── Release CLAIM: the durable "my commits ride the next build" ──────
      // Executed BEFORE any releaseIntent gating in the same call, so a
      // stake+declare combination sees its own fresh claim — symmetric with
      // every other session's, deliberately.
      if (releaseClaimChecked.provided) {
        const selfRow = (report.sessions || []).find((s) => s?.id === sessionId) || {};
        releaseClaimResult = releaseClaimChecked.withdraw
          ? withdrawReleaseClaim({
            brainPath,
            sessionId,
            shas: releaseClaimChecked.withdrawAll ? [] : releaseClaimChecked.withdrawShas,
            home,
            now: leaseStamp,
          })
          : stakeReleaseClaim({
            brainPath,
            sessionId,
            client: (preparedClientInfo || {}).client || selfRow.client || 'unknown',
            logicalSessionId: selfRow.logicalSessionId || null,
            branch: selfRow.branch || null,
            shas: releaseClaimChecked.shas,
            note: releaseClaimChecked.note,
            home,
            now: leaseStamp,
          });
        // publish:true makes the promise TRAVEL: the claim is also written as
        // .klypix/claims/<owner>.json in the project, which the session commits
        // like any other file — from then on every clone's release gate reads
        // it, it is reviewable in a PR, and its whole history is auditable.
        // The write is derived from the OWNER id, so a session can only ever
        // occupy (or delete) its own slot.
        if (releaseClaimChecked.publish && releaseClaimResult?.ok) {
          try {
            if (releaseClaimChecked.withdraw) {
              const removed = deleteCommittedClaim(path.dirname(brainPath), sessionId);
              if (removed) releaseClaimResult = { ...releaseClaimResult, unpublished: removed.relPath };
            } else if (releaseClaimResult.claim) {
              const written = writeCommittedClaim(path.dirname(brainPath), releaseClaimResult.claim);
              releaseClaimResult = { ...releaseClaimResult, published: written.relPath };
            }
          } catch (err) {
            releaseClaimResult = { ...releaseClaimResult, publishError: String(err?.message || err).slice(0, 120) };
          }
        }
      }
      // Set when the holder's own sync arrived with the lease already close to
      // lapsing; reported after the refresh so the holder learns the habit that
      // protects them, not merely that nothing broke this time.
      let nearExpiryBeforeRefreshMs = null;
      if (releaseIntentChecked.provided && completing) {
        // The DECLARATION is ignored on completion, but a REAL completion must
        // still free a lease this session holds — a holder who kept attaching
        // releaseIntent to every sync (the natural refresh pattern) must not
        // leave the lease squatting until expiry just because the final sync
        // carried it too. A non-holder's freed attempt is 'not-holder' and the
        // ignored notice stands.
        outcome = { ok: false, status: 'ignored-on-complete' };
        if (clearCompletionScope) {
          const freed = freeReleaseLease({ brainPath, sessionId, home, now: leaseStamp });
          if (freed.status === 'released') outcome = freed;
        }
      } else if (releaseIntentChecked.provided) {
        // ── THE HANDSHAKE (1.72.0) ────────────────────────────────────────
        // Before a lease is granted, ask the one question nothing used to ask:
        // would this release leave finished work behind? If it would, REFUSE —
        // and require the next attempt to name, sha by sha, exactly what it is
        // choosing to drop.
        //
        // A warning attached to a granted lease is one a model may relay or may
        // not; the founder's correction was that the USER has to be informed.
        // MCP has no channel to a human, so the strongest honest mechanism is
        // to make silence insufficient: a session that cannot proceed without
        // reproducing the missing commits has, in practice, had to surface them.
        //
        // Only a NEW declaration is ANCESTRY-gated. A holder refreshing the
        // same ref is never re-blocked on ancestry — that would be an obstacle,
        // not a gate — and a deliberate off-trunk hotfix is one acknowledged
        // call away. CLAIMS are the one exception: they settle on every
        // declaration, because a claim staked after the lease was taken is
        // exactly the promise the window between lease and build would
        // otherwise swallow; acknowledgements persist on the lease so the
        // holder re-litigates only what is genuinely NEW.
        const existingLease = readReleaseLease({ brainPath, home, now: leaseStamp });
        // recipientKey is module-private in agent-presence; the same normalization
        // (trim + 160-char bound) reproduced here rather than widening its surface.
        const holderKey = (v) => String(v || '').trim().slice(0, 160);
        // EXEMPT THE REF, NOT THE HOLDER. Exempting whoever held the lease let a
        // session declare a clean ref, take the lease, then re-declare pointing
        // at a DIRTY one and sail through — the gate exempted them for being the
        // holder. What deserves exemption is re-declaring the SAME ref that was
        // already gated; anything else is a new release decision.
        const sameRefAsHeld = !!existingLease
          && holderKey(existingLease.holderId) === holderKey(sessionId)
          && String(existingLease.ref || '') === String(releaseIntentChecked.ref || '');
        let gateAncestry = null;
        if (!sameRefAsHeld) {
          try {
            const peerBranches = [
              ...new Set((report.sessions || [])
                .filter((s) => s?.id !== sessionId)
                .map((s) => String(s?.branch || '').trim())
                .filter(Boolean)),
            ];
            gateAncestry = releaseAncestry(path.dirname(brainPath), releaseIntentChecked.ref, { peerBranches });
            // Attach the live owner of every dropped commit BEFORE the gate
            // decides, so a refusal can say whose work this is rather than
            // handing the human a list of anonymous shas.
            gateAncestry = annotateAncestryOwnership(gateAncestry, report.sessions, {
              projectRoot: path.dirname(brainPath),
              selfId: sessionId,
            });
          } catch {
            // A probe that throws is not an all-clear either.
            gateAncestry = { status: 'unknown', reason: 'git-unavailable', ref: releaseIntentChecked.ref, isDescendant: false, missingCount: 0, sources: [], missing: [] };
          }
        }
        // ── STAKED CLAIMS gate — settled on EVERY declaration, including a
        // holder's same-ref refresh. Ancestry compares trunk and LIVE peer
        // branches; a claim covers exactly the hole that leaves: a commit whose
        // owner has closed their session and whose branch nobody is on any
        // more. A claim staked AFTER the lease was taken must still gate the
        // next sync, or the window between lease and build is where a promise
        // goes to die. Per-sha probe failures inside the settlement BLOCK
        // (missing), never pass; only a catastrophic throw degrades to empty,
        // and ancestry still stands guard on that path.
        let claimSettlement = [];
        committedClaimProblems = [];
        try {
          const laneClaims = readReleaseClaims({ brainPath, home, now: leaseStamp });
          // COMMITTED claims ride the repository itself — a teammate's promise
          // arrives with ordinary `git pull`, and this gate reads it on every
          // clone with zero infrastructure. Malformed files are surfaced, not
          // skipped: a gate input that silently drops entries is the recurring
          // defect this whole subsystem exists to end.
          const committed = readCommittedClaims(path.dirname(brainPath), { now: leaseStamp });
          committedClaimProblems = committed.problems;
          if (committed.truncated) committedClaimProblems = [...committedClaimProblems, { file: 'directory', problem: 'claim directory exceeds the scan cap; entries beyond it were NOT settled' }];
          // Dedupe: a lane claim and a committed claim from the SAME owner with
          // the same shas are one promise, not two. Lane wins (fresher TTL).
          const claimKey = (c) => `${c.ownerId}|${[...c.shas].sort().join(',')}`;
          const laneOwners = new Set(laneClaims.map(claimKey));
          const committedByKey = new Map(committed.claims.map((c) => [claimKey(c), c]));
          // When a lane claim and a committed file are the same promise, the
          // lane entry wins (fresher TTL) but must CARRY the file marker —
          // otherwise fulfilment retires the lane copy and strands the file,
          // and every clone keeps refusing on a promise already kept.
          const merged = [
            ...laneClaims.map((c) => {
              const twin = committedByKey.get(claimKey(c));
              return twin ? { ...c, committed: twin.committed } : c;
            }),
            ...committed.claims.filter((c) => !laneOwners.has(claimKey(c))),
          ];
          if (merged.length) {
            claimSettlement = settleClaimsAgainstRef(path.dirname(brainPath), releaseIntentChecked.ref, merged);
          }
        } catch { claimSettlement = []; }
        const unmetClaims = claimSettlement.filter((entry) => !entry.contained);
        const claimShasRequired = [...new Set(unmetClaims
          .flatMap((entry) => [...entry.missing, ...entry.unresolvable, ...entry.unverified])
          .map((sha) => String(sha).toLowerCase()))];
        // The holder's PERSISTED acknowledgements count too (review blocker B1):
        // a refresh checkpoint re-attaching the same releaseIntent must not be
        // refused over a claim the holder already acknowledged at grant time.
        // A claim staked SINCE then still gates — its shas are in no lease
        // record — which is exactly the window the settle-on-every-declaration
        // rule exists for.
        const leaseAcks = sameRefAsHeld && Array.isArray(existingLease?.acknowledgedShas)
          ? existingLease.acknowledgedShas : [];
        const ackGiven = [...new Set([
          ...(releaseIntentChecked.acknowledge || []),
          ...leaseAcks,
        ].map((g) => String(g).toLowerCase()))];
        const claimsAcknowledged = claimShasRequired
          .every((sha) => ackGiven.some((g) => sha.startsWith(g) || g.startsWith(sha)));
        const ancestryBlocks = gateAncestry && !gateAncestry.isDescendant
          && !ancestryAcknowledged(gateAncestry, ackGiven);
        const claimsRefuse = claimShasRequired.length > 0 && !claimsAcknowledged;
        if (ancestryBlocks || claimsRefuse) {
          outcome = {
            ok: false,
            status: ancestryBlocks ? 'ancestry-unacknowledged' : 'claims-unacknowledged',
            ancestry: gateAncestry
              || { status: 'ok', ref: releaseIntentChecked.ref, isDescendant: true, missingCount: 0, sources: [], missing: [] },
            unmetClaims,
            // The refusal headline must not lie to a HOLDER: their held lease
            // was not revoked — it just was not refreshed by this sync, and it
            // lapses at TTL unless the new claim is acknowledged.
            holderRefusal: sameRefAsHeld,
          };
        } else {
          outcome = declareReleaseLease({
            brainPath,
            sessionId,
            version: releaseIntentChecked.version,
            ref: releaseIntentChecked.ref,
            client: (preparedClientInfo || {}).client || 'unknown',
            home,
            now: leaseStamp,
            acknowledgedShas: ackGiven,
          });
          if (gateAncestry && !gateAncestry.isDescendant) outcome = { ...outcome, acknowledgedAncestry: gateAncestry };
          if (unmetClaims.length) outcome = { ...outcome, acknowledgedClaims: unmetClaims };
          if (claimSettlement.length) outcome = { ...outcome, claimSettlement };
        }
      } else if (clearCompletionScope) {
        const freed = freeReleaseLease({ brainPath, sessionId, home, now: leaseStamp });
        if (freed.status === 'released') outcome = freed;
      } else if (!completing) {
        // Snapshot BEFORE the refresh. A holder's sync refreshes the lease, so
        // by the time we report, expiry has already moved out and "expiring
        // soon" is never true — yet the risk was real a millisecond earlier.
        // The field failure was a holder who ran a 40-minute build with no
        // sync in it and lost the lease silently; the useful moment to say so
        // is the sync that arrives while the clock is still low.
        const preRefresh = readReleaseLease({ brainPath, home, now: leaseStamp });
        if (preRefresh && preRefresh.holderId === sessionId && preRefresh.expiresAt) {
          const leftBefore = Math.max(0, preRefresh.expiresAt - leaseStamp);
          if (leftBefore <= RELEASE_LEASE_WARN_MS) nearExpiryBeforeRefreshMs = leftBefore;
        }
        const refreshed = refreshReleaseLease({ brainPath, sessionId, home, now: leaseStamp });
        // 'lease-lost' = THIS session held the lease but it lapsed (TTL passed
        // with no checkpoint). Surfacing it beats silent pruning: a holder who
        // believes they still own release preparation must be told they don't.
        if (refreshed.status === 'refreshed' || refreshed.status === 'lease-lost') outcome = refreshed;
      }
      const active = readReleaseLease({ brainPath, home, now: leaseStamp });
      const prefixFor = (id) =>
        shortestUniqueSessionPrefix(report.sessions, id, 12) || String(id).slice(0, 12);
      const holderBlock = active ? {
        sessionId: active.holderId,
        sessionPrefix: prefixFor(active.holderId),
        client: active.holderClient,
        version: active.version,
        ref: active.ref,
        takenAt: active.takenAt,
        refreshedAt: active.refreshedAt,
        expiresAt: active.expiresAt,
      } : null;
      if (outcome?.status === 'ancestry-unacknowledged' || outcome?.status === 'claims-unacknowledged') {
        const anc = outcome.ancestry;
        // Staked-claim requirement rides the SAME refusal and the SAME
        // acknowledge array: one gate, one handshake, whichever half tripped.
        const unmetClaims = Array.isArray(outcome.unmetClaims) ? outcome.unmetClaims : [];
        const claimShas = [...new Set(unmetClaims
          .flatMap((entry) => [...entry.missing, ...entry.unresolvable, ...entry.unverified])
          .map((sha) => String(sha).toLowerCase()))];
        const claimLines = unmetClaims.map((entry) => {
          const c = entry.claim;
          const ageDays = Math.max(0, Math.round((leaseStamp - (c.stakedAt || leaseStamp)) / 86_400_000));
          const parts = [];
          if (entry.missing.length) parts.push(`${entry.missing.length} NOT in ${releaseIntentChecked.ref}: ${entry.missing.slice(0, 4).map((x) => x.slice(0, 9)).join(', ')}${entry.missing.length > 4 ? ` +${entry.missing.length - 4}` : ''}`);
          if (entry.unresolvable.length) parts.push(`${entry.unresolvable.length} unresolvable (history rewritten? owner must re-stake): ${entry.unresolvable.slice(0, 3).map((x) => x.slice(0, 9)).join(', ')}`);
          if (entry.unverified.length) parts.push(`${entry.unverified.length} unverified (probe budget)`);
          const provenance = c.committed ? ` [committed: ${c.committed.file} — travels with the repo, withdraw by deleting the file in a commit]` : '';
          return neutralizeMarkers(`STAKED CLAIM UNMET — session ${String(c.ownerId).slice(0, 8)} (${c.ownerClient}${c.branch ? `, ${c.branch}` : ''}) staked ${ageDays}d ago${c.note ? `: "${c.note}"` : ''} — ${parts.join(' · ')}. The owner may no longer be live; this claim is their voice.${provenance}`);
        });
        // The COMPLETE set the gate will demand, not the subset the prose names.
        // These two used to be the same list, which is how a release dropping 71
        // commits was acknowledged by naming 10. The prose still shows 8 per
        // source — a wall of 71 shas teaches people to skim — but the requirement
        // is now honest about its own size, and the text below says both numbers.
        const shas = [...new Set((anc.sources || []).flatMap((s) => (
          Array.isArray(s.allShas) && s.allShas.length
            ? s.allShas
            : (s.missing || []).map((c) => c.sha)
        )).map((s) => String(s || '')).filter(Boolean))];
        // PREFIX-tolerant, both directions (2026-08-17 review catch, verified by
        // execution): the prose shows abbreviated `%h` shas while allShas are
        // full 40-char, so an exact Set.has never matched and the honesty NOTE
        // claimed "only 0 spelled out above" on every refusal — the one sentence
        // added for honesty contradicted the sha list directly above it.
        const namedInProse = [...new Set((anc.sources || [])
          .flatMap((s) => s.missing || []).map((c) => String(c.sha || '').toLowerCase()).filter(Boolean))];
        const unnamed = shas.filter((s) => {
          const full = String(s).toLowerCase();
          return !namedInProse.some((p) => full.startsWith(p) || p.startsWith(full));
        }).length;
        releaseLease = {
          status: 'refused',
          kind: 'release-would-leave-work-behind',
          severity: 'blocking',
          requested: { version: releaseIntentChecked.version, ref: releaseIntentChecked.ref },
          ancestry: {
            trunk: anc.trunk,
            ref: anc.ref,
            missingCount: anc.missingCount,
            sources: anc.sources,
          },
          // Exactly what the retry must echo. Named so a caller never has to
          // guess the shape of the second call. NEVER populated on the
          // 'unnameable' path: the gate refuses that status unconditionally, so
          // listing shas there instructs an acknowledge that can never succeed
          // (2026-08-17 review catch — the primary fix renders bare shas at the
          // source so 'unnameable' now truly means no shas at all; this guard is
          // the belt to that suspender).
          acknowledgeRequired: [...new Set([...(anc.status === 'unnameable' ? [] : shas), ...claimShas])],
          ...(unmetClaims.length ? { stakedClaims: unmetClaims.map((entry) => ({
            owner: String(entry.claim.ownerId).slice(0, 8),
            ownerClient: entry.claim.ownerClient,
            branch: entry.claim.branch,
            note: entry.claim.note,
            stakedAt: entry.claim.stakedAt,
            missing: entry.missing,
            unresolvable: entry.unresolvable,
            unverified: entry.unverified,
          })) } : {}),
        };
        const claimsOnlyImperative = (!(anc && !anc.isDescendant) && unmetClaims.length)
          ? [
            '',
            'WHAT THIS MEANS FOR THE USER: the branch history is clean, but a session STAKED A CLAIM that specific commits must ride this release, and they are not in it. That session may have already told the user this work would ship — the claim is the only voice it has left.',
            'Say this to them in your own words, naming the claim(s) above, BEFORE going any further.',
          ]
          : [];
        releaseText = [
          outcome.holderRefusal
            ? 'KLYPIX release refresh REFUSED — a claim staked SINCE your lease was granted is unmet. Your held lease was NOT revoked, but this sync did NOT refresh it: acknowledge the claim below or the lease lapses at its ~2h TTL.'
            : 'KLYPIX release lease REFUSED — the lease was not taken. No release state changed.',
          '',
          ...releaseAncestryWarnings(anc),
          ...(claimLines.length ? ['', ...claimLines] : []),
          ...(committedClaimProblems.length ? [
            '',
            `⚠ ${committedClaimProblems.length} committed claim file(s) could NOT be settled and are NOT covered by this gate: ${committedClaimProblems.slice(0, 3).map((p) => `${p.file} (${p.problem})`).join('; ')}${committedClaimProblems.length > 3 ? ` +${committedClaimProblems.length - 3} more` : ''}. Fix or remove them — an unreadable promise protects nobody.`,
          ] : []),
          ...claimsOnlyImperative,
          '',
          // Deliberately NOT a ready-to-paste call. Pre-rendering the exact
          // retry made the bypass the easiest thing on screen — an agent could
          // copy it and never say a word to anyone. The shas are listed above;
          // reproducing them is the work, and the work is the point.
          ((anc.status !== 'unnameable' && shas.length) || claimShas.length)
            ? [
              `To proceed anyway, re-send releaseIntent with an "acknowledge" array naming each of the ${new Set([...(anc.status === 'unnameable' ? [] : shas), ...claimShas]).size} sha(s) in acknowledgeRequired.`,
              unnamed
                ? `NOTE: only ${shas.length - unnamed} of those ${shas.length} are spelled out above — ${unnamed} more are in acknowledgeRequired and are NOT shown in this text. Read them before you decide; the prose is a sample, the requirement is the whole set.`
                : '',
              'Only do that after the user has been told and has decided.',
            ].filter(Boolean).join(' ')
            : 'This release cannot be acknowledged automatically — the missing work could not be listed. Resolve it with the user before continuing.',
        ].join('\n');
      } else if (outcome?.status === 'conflict') {
        const holder = outcome.holder;
        const holderPrefix = prefixFor(holder.holderId);
        releaseLease = {
          status: 'conflict',
          kind: 'release-lease-held',
          severity: 'blocking',
          requested: { version: releaseIntentChecked.version, ref: releaseIntentChecked.ref },
          holder: {
            sessionId: holder.holderId,
            sessionPrefix: holderPrefix,
            client: holder.holderClient,
            version: holder.version,
            ref: holder.ref,
            takenAt: holder.takenAt,
            refreshedAt: holder.refreshedAt,
            expiresAt: holder.expiresAt,
          },
        };
        releaseText = `KLYPIX release-lease conflict: session ${holderPrefix} already holds the EXCLUSIVE release lease for this project — v${holder.version} from ${holder.ref}. Your releaseIntent (v${releaseIntentChecked.version} from ${releaseIntentChecked.ref}) was NOT granted. Coordinate with the holder; the lease frees on their real completion, on its ~2h expiry without checkpoints, or when their session ends.`;
      } else if (outcome?.status === 'ignored-on-complete') {
        releaseLease = { status: 'ignored-on-complete', ...(holderBlock ? { holder: holderBlock } : {}) };
        releaseText = 'KLYPIX releaseIntent was ignored: declare it with phase "start" or "checkpoint", not on completion (completion FREES a held lease).';
      } else if (outcome && outcome.ok === false) {
        releaseLease = { status: 'declare-failed', reason: outcome.status };
        releaseText = `KLYPIX release lease was not recorded (${outcome.status}); no lease state changed. Retry on the next sync.`;
      } else if (outcome?.status === 'taken' || outcome?.status === 'refreshed') {
        // ── Claim settlement on a GRANTED lease ──────────────────────────
        // Fulfilled claims retire (their shas are in the ref — the promise is
        // kept, with a courtesy note to the owner). Acknowledged-away claims
        // STAY STAKED — the work still is not shipping — and their owners are
        // notified NOW, at declare time, not after the build exists: today the
        // releaser sees the OWNED-BY warning but the owner learns only when
        // the installer is missing their feature (founder-surfaced 2026-08-17).
        const fulfilledClaims = (outcome.claimSettlement || []).filter((entry) => entry.contained);
        const awayClaims = Array.isArray(outcome.acknowledgedClaims) ? outcome.acknowledgedClaims : [];
        let claimsNotified = 0;
        const retiredFiles = [];
        if (fulfilledClaims.length) {
          try {
            retireFulfilledClaims({
              brainPath,
              fulfilled: fulfilledClaims.map((entry) => ({ ownerId: entry.claim.ownerId, shas: entry.claim.shas })),
              home,
              now: leaseStamp,
            });
          } catch { /* retirement is best-effort; a live claim re-settles next declare */ }
          for (const entry of fulfilledClaims) {
            if (entry.claim.committed) {
              // The file lives in the WORKING TREE — deleting it here and
              // committing the deletion alongside the release is the repo-side
              // twin of lane retirement. If the delete fails the claim simply
              // re-settles as contained next time; never fatal.
              const removed = deleteCommittedClaim(path.dirname(brainPath), entry.claim.ownerId);
              if (removed) retiredFiles.push(removed.relPath);
            }
          }
          for (const entry of fulfilledClaims) {
            if (entry.claim.ownerId === sessionId) continue;
            const posted = postPresenceMessage({
              brainPath,
              from: sessionId,
              // Logical identity preferred: a revived session matches it directly,
              // and a SINGLE candidate keeps the receipt denominator honest.
              to: entry.claim.ownerLogicalId || entry.claim.ownerId,
              text: `Your staked release claim is FULFILLED: v${releaseIntentChecked.version} declared from ${releaseIntentChecked.ref} CONTAINS your ${entry.claim.shas.length} claimed commit(s) (${entry.claim.shas.slice(0, 3).map((x) => x.slice(0, 9)).join(', ')}${entry.claim.shas.length > 3 ? '…' : ''}). The claim is retired.`,
              allowOfflineTarget: true,
              dedupeKey: `claim-fulfilled|${entry.claim.ownerId}|${releaseIntentChecked.version}`,
              home,
              now: leaseStamp,
            });
            if (posted.posted) claimsNotified++;
          }
        }
        const notifiedOwners = new Set();
        for (const entry of awayClaims) {
          if (entry.claim.ownerId === sessionId) continue;
          notifiedOwners.add(entry.claim.ownerId);
          const gone = [...entry.missing, ...entry.unresolvable, ...entry.unverified];
          const posted = postPresenceMessage({
            brainPath,
            from: sessionId,
            to: entry.claim.ownerLogicalId || entry.claim.ownerId,
            text: `Release v${releaseIntentChecked.version} from ${releaseIntentChecked.ref} was declared ACKNOWLEDGING AWAY your claimed commit(s) ${gone.slice(0, 4).map((x) => String(x).slice(0, 9)).join(', ')}${gone.length > 4 ? ` +${gone.length - 4}` : ''} — they will NOT be in this build. Your claim stays staked for the next release.`,
            allowOfflineTarget: true,
            dedupeKey: `claim-away|${entry.claim.ownerId}|${releaseIntentChecked.version}|${releaseIntentChecked.ref}`,
            home,
            now: leaseStamp,
          });
          if (posted.posted) claimsNotified++;
        }
        // LIVE owners named by the ancestry annotation get the same courtesy —
        // their commits were acknowledged away too, they just never staked.
        const ancOwners = new Map();
        for (const src of (outcome.acknowledgedAncestry?.sources || [])) {
          for (const c of (src.missing || [])) {
            for (const o of (c.owners || [])) {
              if (o.sharedScopeOnly || !o.sessionId || o.sessionId === sessionId) continue;
              if (notifiedOwners.has(o.sessionId)) continue;
              const cur = ancOwners.get(o.sessionId) || [];
              if (cur.length < 4) cur.push(`${c.sha} ${String(c.subject || '').slice(0, 60)}`.trim());
              ancOwners.set(o.sessionId, cur);
            }
          }
        }
        for (const [ownerId, commits] of ancOwners) {
          const posted = postPresenceMessage({
            brainPath,
            from: sessionId,
            to: ownerId,
            text: `Release v${releaseIntentChecked.version} from ${releaseIntentChecked.ref} was declared ACKNOWLEDGING AWAY commit(s) of yours: ${commits.join(' · ')} — they will NOT be in this build. Stake a releaseClaim if they must ride the next one.`,
            allowOfflineTarget: true,
            dedupeKey: `anc-away|${ownerId}|${releaseIntentChecked.version}|${releaseIntentChecked.ref}`,
            home,
            now: leaseStamp,
          });
          if (posted.posted) claimsNotified++;
        }
        releaseLease = {
          status: outcome.status,
          ...(outcome.reclaimed ? { reclaimed: outcome.reclaimed } : {}),
          ...(holderBlock ? { holder: holderBlock } : {}),
          ...(fulfilledClaims.length ? { claimsFulfilled: fulfilledClaims.length } : {}),
          ...(awayClaims.length ? { claimsAcknowledgedAway: awayClaims.length } : {}),
          ...(claimsNotified ? { claimOwnersNotified: claimsNotified } : {}),
        };
        if (releaseIntentChecked.provided) {
          releaseText = outcome.status === 'taken'
            ? `KLYPIX release lease taken: this session now EXCLUSIVELY holds release preparation for v${releaseIntentChecked.version} from ${releaseIntentChecked.ref}${outcome.reclaimed ? ` (reclaimed: the previous lease was ${outcome.reclaimed === 'expired' ? 'expired' : 'held by a session that is no longer live'})` : ''}. Checkpoints refresh the ~2h lease; phase "complete" frees it.`
            : `KLYPIX release lease refreshed: v${releaseIntentChecked.version} from ${releaseIntentChecked.ref}.`;
          if (fulfilledClaims.length || awayClaims.length) {
            releaseText += ` Claims: ${fulfilledClaims.length} fulfilled${awayClaims.length ? `, ${awayClaims.length} ACKNOWLEDGED AWAY (their owners were queued a notification — the work is NOT in this build)` : ''}.`;
            if (retiredFiles.length) {
              releaseText += ` Retired committed claim file(s): ${retiredFiles.join(', ')} — commit the deletion with the release so every clone sees the promise as kept.`;
            }
          }
        }
      } else if (outcome?.status === 'lease-lost') {
        releaseLease = { status: 'lease-lost', reason: outcome.reason || null };
        releaseText = 'KLYPIX release lease lost: the exclusive release lease this session held expired without a checkpoint inside its ~2h TTL and has been cleared. If the release is still in preparation, re-declare it with releaseIntent { version, ref }.';
      } else if (outcome?.status === 'released') {
        releaseLease = {
          status: 'released',
          released: { version: outcome.lease?.version || null, ref: outcome.lease?.ref || null },
        };
        releaseText = `KLYPIX release lease freed: completion released the exclusive release lease (v${outcome.lease?.version} from ${outcome.lease?.ref}).`;
      } else if (active) {
        releaseLease = { status: 'held', holder: holderBlock };
        // The holder must never learn about expiry by noticing the footer
        // vanished — which is exactly what happened in the field on
        // 2026-08-16, mid-release-build. The 'lease-lost' message this design
        // relies on is UNREACHABLE in any project that has peers: a non-holder's
        // sync meets the expired lease first, prunes it (status 'stale-pruned',
        // write:true, lease:null) and is told nothing, so the holder's next sync
        // takes the no-lease fast path and never reaches the lease-lost branch.
        // Warning while the lease still EXISTS is therefore the last moment the
        // holder can still act on it, and it needs no cross-session state.
      }
      // Holder-facing expiry telemetry, attached to whichever branch produced
      // the block. Always reporting expiresInMs is half the fix on its own: the
      // holder can see the clock instead of inferring it from a footer.
      if (releaseLease && holderBlock && holderBlock.sessionId === sessionId && holderBlock.expiresAt) {
        releaseLease.expiresInMs = Math.max(0, holderBlock.expiresAt - leaseStamp);
        if (nearExpiryBeforeRefreshMs !== null) {
          releaseLease.expiringSoon = true;
          releaseLease.nearExpiryBeforeRefreshMs = nearExpiryBeforeRefreshMs;
          releaseText = `KLYPIX release lease expires in ~${Math.max(1, Math.round(nearExpiryBeforeRefreshMs / 60000))} min — refreshed by this sync. Only a brain_sync from THIS session refreshes it, so a long build with no sync in it will let the lease lapse, and a peer then prunes it without telling you.`;
        }
      }
      // ── Would this release leave finished work behind? (1.72.0) ──────────
      // Coordination in this engine had always been about files two sessions
      // are editing RIGHT NOW. Nothing ever asked whether finished work was
      // actually IN the build being cut — so on 2026-08-15 a release was
      // prepared from a branch that could not contain three completed commits,
      // and the FOUNDER noticed, not the tooling.
      //
      // It rides the LEASE because that is the one moment a release announces
      // itself, and it is reported at blocking severity so the declaring
      // session cannot take the lease and stay quiet: the founder's own
      // correction was "at least the user should be informed/asked about it".
      // Advisory in effect, unmissable in delivery — a hotfix cut from a tag is
      // legitimate, so the human decides, but never unknowingly.
      if (active && releaseIntentChecked.provided && (outcome?.status === 'taken' || outcome?.status === 'refreshed')) {
        try {
          const peerBranches = [
            ...new Set((report.sessions || [])
              .filter((s) => s?.id !== sessionId)
              .map((s) => String(s?.branch || '').trim())
              .filter(Boolean)),
          ];
          const ancestry = releaseAncestry(path.dirname(brainPath), active.ref, { peerBranches });
          // Only a genuinely DIRTY ancestry is worth repeating on a granted
          // lease. An unknown that the gate deliberately chose not to block on
          // (no git, nothing to compare) must not leak a scary CHECK COULD NOT
          // RUN line into every sync of a plain-folder project — that is the
          // alarm fatigue this whole design is trying to avoid.
          const warnings = ancestry && ancestry.status !== 'unknown' ? releaseAncestryWarnings(ancestry) : [];
          if (warnings.length) {
            releaseLease = {
              ...releaseLease,
              ancestry: {
                kind: 'release-would-leave-work-behind',
                severity: 'blocking',
                trunk: ancestry.trunk,
                ref: ancestry.ref,
                missingCount: ancestry.missingCount,
                sources: ancestry.sources,
              },
            };
            releaseText = `${releaseText}\n\n${warnings.join('\n')}`;
          }
        } catch { /* a git probe must never break a sync */ }
      }
      if (active) {
        releaseFooterLine = `release in preparation: v${active.version} from ${active.ref} (session ${prefixFor(active.holderId)})`;
        // ── THE THIRD QUESTION (1.72.0) ──────────────────────────────────
        // The ancestry gate protects the session CUTTING the release. This is
        // its mirror, for everyone else: "is my finished work going to make it
        // into the build somebody is preparing right now?"
        //
        // Unpushed commits are the common way the answer is no, and the
        // situation is invisible from both sides — the releaser cannot see a
        // branch that was never pushed, and the author has no reason to think
        // about a release they are not cutting. Both halves of the 2026-08-15
        // miss are this, seen from the two ends.
        //
        // Free: aheadBehindOrigin is already collected. Advisory, and only
        // while a release is genuinely in flight, so it can never become
        // ambient noise.
        const ahead = Number(repoState?.aheadBehindOrigin?.ahead || 0);
        const holderIsSelf = holderBlock && holderBlock.sessionId === sessionId;
        if (!completing && ahead > 0 && !holderIsSelf) {
          workAtRisk = {
            kind: 'unpushed-work-during-release',
            aheadCount: ahead,
            upstream: repoState.aheadBehindOrigin.upstream,
            branch: repoState.branch || null,
            release: { version: active.version, ref: active.ref },
          };
          workAtRiskText = `KLYPIX work-at-risk: a release is being prepared right now (v${active.version} from ${active.ref}), and this checkout has ${ahead} commit(s) on ${repoState.branch || 'HEAD'} that are NOT pushed to ${repoState.aheadBehindOrigin.upstream}. Work that never reached the remote cannot be in that build. If any of it belongs in v${active.version}, say so to the user and coordinate with the release session now (brain_message) — after the cut is far more expensive than before it.`;
        }
      } else if (!completing && repoState?.packageVersion && repoState?.latestReleaseTag?.version
        && cmpSemver3(repoState.packageVersion, repoState.latestReleaseTag.version) > 0) {
        // Zero-config visibility: nobody declared anything, but this checkout's
        // package version is AHEAD of every release tag — release preparation
        // is mechanically in progress. Soft advisory only, never blocking.
        releaseAdvisory = {
          kind: 'checkout-ahead-of-last-release',
          packageVersion: repoState.packageVersion,
          latestReleaseTag: repoState.latestReleaseTag,
        };
        releaseAdvisoryText = `KLYPIX release advisory: this checkout's package version ${repoState.packageVersion} is ahead of the last released tag ${repoState.latestReleaseTag.tag}${repoState.branch ? ` (branch ${repoState.branch})` : ''} and no release lease is declared. If a release is in preparation, declare it: brain_sync { releaseIntent: { version, ref } } takes the exclusive release lease and tells every peer.`;
      }
    }
    const durationMs = Math.max(0, Date.now() - syncStartedAt);
    const messagesText = formatReceivedMessages(report.messages, stamp, decay, sessionId);
    const structured = {
      schemaVersion: 1,
      status: completing
        ? (completionBlocked ? 'needs-reconciliation'
          : (completionDeferred ? 'complete-deferred' : 'complete'))
        : 'active',
      phase: nextPhase,
      project: path.dirname(brainPath),
      brain: brainPath,
      self: snapshot.self,
      counts: {
        connections: snapshot.connectionCount,
        activeTasks: snapshot.activeTaskCount,
        backgroundConnections: snapshot.backgroundConnectionCount,
        // 1.71.0 — the half of `backgroundConnections` that is actually
        // WORKING. A caller that reports "no conflicts" while this is non-zero
        // is reporting an incomplete search, not a clear one.
        undeclaredActive: snapshot.undeclaredActiveCount,
        idleConnections: snapshot.idleConnectionCount,
      },
      peers: snapshot.peers,
      conflicts,
      messages: report.messages.map((message) => {
        // Raw structured path gets the same decay verdict as the rendered
        // text: a consumer reading structured.messages directly must see the
        // LAST-KNOWN marking, not re-derive it (additive fields, schema 1).
        const decayInfo = messageDecayInfo(message, stamp, decay);
        const receipt = messageDeliveryReceipt(message, sessionId);
        return {
          id: message.id,
          from: message.from,
          text: message.text,
          ts: message.ts,
          ...(receipt ? {
            deliveryState: receipt.deliveryState,
            offerToken: receipt.offerToken,
          } : {}),
          ...(decayInfo ? { lastKnown: true, age: decayInfo.age, stampText: decayInfo.stampText } : {}),
        };
      }),
      alertsQueued,
      // Additive (schema 1): the machine-readable record of WHY a complete was
      // downgraded to a scope-preserving checkpoint (turn-end heuristic).
      ...(completionDeferred ? {
        completionDeferred: {
          reason: 'premature-complete-no-results',
          sinceTaskStartMs: Math.max(0, stamp - taskStartedAt),
          scopeRetained: true,
        },
      } : {}),
      // Additive (schema 1): downstream renderers keep parsing self.branch and
      // peers[].branch exactly as before; repoState is the machine-readable
      // release-state contract the advisory prose merely mirrors.
      ...(repoState ? { repoState } : {}),
      // Additive (schema 1): the exclusive release-preparation lease — grant /
      // refresh / conflict / release outcome plus the current holder — and the
      // zero-config checkout-ahead advisory when nothing is declared.
      ...(releaseLease ? { releaseLease } : {}),
      // Additive: outcome of a releaseClaim stake/withdraw carried in THIS call.
      ...(releaseClaimResult ? { releaseClaim: releaseClaimResult } : {}),
      ...(releaseAdvisory ? { releaseAdvisory } : {}),
      ...(workAtRisk ? { workAtRisk } : {}),
      ...(resultReconciliation ? { resultReconciliation: {
        status: resultReconciliation.status,
        claims: resultReconciliation.claims || [],
        ledgerWriteOk: resultReconciliation.ledgerWriteOk ?? null,
        ledgerFreshMs: resultReconciliation.ledgerFreshMs || null,
        machineLocal: true,
        ...(resultReconciliation.receipt ? { receipt: resultReconciliation.receipt } : {}),
        ...(resultReconciliation.receiptHash ? { receiptHash: resultReconciliation.receiptHash } : {}),
      } } : {}),
      ...(resultConflicts.length ? { resultConflicts } : {}),
      delivery: {
        proactive: 'mcp-logging-best-effort-preview',
        modelContext: shouldDeliverMessages ? 'supported-klypix-action' : 'deferred',
        stateMachine: 'pending -> offered -> acknowledged -> consumed (auto-lease on the next independent action, or explicit receipt) | failed',
        acknowledgement: 'a later independent supported action followed an offer; a further independent action auto-consumes the lease, and explicit token-bound brain_message_receipt records the stronger acted-on-it claim',
        retention: 'machine-local; 24h TTL and bounded lane capacity; expiry fails only never-delivered or offered-once records — an acknowledged note retires as delivered-unconfirmed, never as failed',
        writeOk: shouldDeliverMessages ? report.deliveryWriteOk : null,
        ...(report.deliveryWriteSkippedReason ? { writeFailure: report.deliveryWriteSkippedReason } : {}),
      },
      timingMs: { coordination: durationMs },
    };
    const resultText = completing && completionBlocked
      ? [
        'KLYPIX completion needs reconciliation; the task intent/files remain active.',
        ...resultConflicts.slice(0, 8).map((conflict) => {
          const where = [conflict.claimKey, conflict.metric].filter(Boolean).join(' / ');
          return `- ${conflict.kind}${where ? ` (${where})` : ''}${conflict.reason ? `: ${conflict.reason}` : ''}`;
        }),
      ].join('\n')
      : resultSubmissionRejected
        ? [
          'KLYPIX result submission rejected; task scope remains active.',
          ...resultConflicts.slice(0, 8).map((conflict) => `- ${conflict.kind}${conflict.reason ? `: ${conflict.reason}` : ''}`),
        ].join('\n')
      : completing && resultReconciliation
        ? `KLYPIX result reconciliation: ${resultReconciliation.status}; completion evidence was recorded in the machine-local project ledger.`
        : '';
    const deliveryWarning = shouldDeliverMessages && report.deliveryWriteOk === false
      ? `KLYPIX message delivery was deferred safely: ${report.deliveryWriteSkippedReason || 'the receipt write did not land'}. No queued note was reported as delivered; retry on the next KLYPIX action.`
      : '';
    const deferralText = completionDeferred
      ? 'KLYPIX completion deferred: this complete carried no results and arrived moments after task start with no intervening checkpoint, so it reads as turn-end, not task-end. The declared intent/files were RETAINED for peers. When the task is truly finished, complete again after a checkpoint (or include a result manifest) to clear the scope.'
      : '';
    const text = [
      `KLYPIX Context Gateway: session ${sessionId} · phase ${nextPhase} · coordination ${durationMs}ms.`,
      deferralText,
      resultText,
      releaseClaimResult
        ? (releaseClaimResult.ok
          ? `KLYPIX release claim ${releaseClaimResult.status}${releaseClaimResult.published ? ` — PUBLISHED to ${releaseClaimResult.published}: commit that file so the claim travels with the repo (every clone's release gate reads it; reviewable in PRs)` : ''}${releaseClaimResult.unpublished ? ` — committed file ${releaseClaimResult.unpublished} deleted; commit the deletion to withdraw it everywhere` : ''}${releaseClaimResult.publishError ? ` — WARNING: the lane claim stands but the committed file failed: ${releaseClaimResult.publishError}` : ''}${releaseClaimResult.claim ? `: ${releaseClaimResult.claim.shas.length} sha(s) staked — every future releaseIntent must contain them or acknowledge them BY NAME, even after this session ends (expires ${Math.round((releaseClaimResult.claim.expiresAt - syncStartedAt) / 86_400_000)}d)` : ''}${releaseClaimResult.status === 'trimmed' || releaseClaimResult.status === 'withdrawn' ? ` (${releaseClaimResult.remaining ?? 0} sha(s) remain staked)` : ''}.`
          : `KLYPIX release claim FAILED (${releaseClaimResult.status}${releaseClaimResult.limit ? `, limit ${releaseClaimResult.limit}` : ''}) — nothing was staked or withdrawn. ${releaseClaimResult.status === 'claims-full' ? 'The lane holds its maximum of staked claims; withdraw a stale one or raise it with the maintainers.' : ''}`)
        : '',
      releaseText,
      formatTaskPresence(snapshot, stamp),
      messagesText,
      deliveryWarning,
      conflictText,
      repoStateWarning,
      releaseAdvisoryText,
      workAtRiskText,
      // The one-line footer every peer sees while any release lease is active.
      releaseFooterLine,
    ].filter(Boolean).join('\n\n');
    return {
      ...report,
      snapshot,
      conflicts,
      resultConflicts,
      alertsQueued,
      structured,
      text,
      isError: (completing && completionBlocked) || resultSubmissionRejected,
    };
  };

  const decorateToolResult = (result, {
    actionId = '',
    deliverMessages = true,
    verifyBinding: verifyBindingFn = null,
    clientInfoPrepared = null,
  } = {}) => {
    if (verifyBindingFn && !verifyBindingFn()) return result;
    if (!started) start(vault);
    const { sessions, notice, deliveryWriteOk, deliveryWriteSkippedReason } = touch({
      event: 'McpToolUse',
      deliverMessages: deliverMessages !== false,
      actionId: actionId || `mcp-tool:${process.pid}:${++modelActionSequence}`,
      hostIdentityPrepared: Boolean(clientInfoPrepared),
      clientInfoPrepared,
    });
    // Mechanical brain_sync nudge (once per server session): the "call
    // brain_sync first" contract was instructions-only — zero enforcement —
    // which is why Claude sessions sat sync-silent while Codex's gateway
    // declared scope automatically (2026-07-29 audit). If this session's own
    // row still has no intent AND no files after a real KLYPIX tool call,
    // say so once, in-band, where the agent actually reads it.
    let nudge = '';
    if (!syncNudgeShown && brainPath) {
      const self = (sessions || []).find((session) => session.id === sessionId);
      if (self && !isTaskSession(self)) {
        syncNudgeShown = true;
        nudge = 'KLYPIX presence: this session has not declared its task — peers see it as a connection with no scope. Call brain_sync {intent, files} so concurrent sessions can coordinate with you.';
      }
    }
    const deliveryWarning = deliveryWriteOk === false
      ? `KLYPIX message delivery was deferred safely: ${deliveryWriteSkippedReason || 'the receipt write did not land'}. No queued note was reported as delivered; retry on the next KLYPIX action.`
      : '';
    const extra = [notice, deliveryWarning, nudge].filter(Boolean).join('\n\n');
    if (!extra || !result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: extra }],
    };
  };

  const noteSent = (text) => {
    const value = compact(text).toLowerCase();
    if (value) sentTexts.add(value);
  };

  return {
    get id() { return sessionId; },   // getter — hostmap rotation can change it mid-life
    start,
    stop,
    touch,
    pollInbox,
    sync,
    preflightSync,
    consumeSyncPreflight,
    revalidateConsumedSyncPreflight,
    resolveRequestIdentity: (extra, options = {}) => resolveRequestIdentity(extra, {
      ...options,
      client: clientInfo().client,
    }),
    verifyCurrentProjectBinding,
    refreshCurrentProjectBinding,
    adoptRequestIdentity,
    refreshIdentity,
    noteSent,
    decorateToolResult,
    get brainPath() { return brainPath; },
    get vault() { return vault; },
    // The session's own declared intent (or ''), read fresh from the lane —
    // the enrichment question source for MCP-side brain_note captures.
    get declaredIntent() {
      try {
        const row = listActiveSessions(brainPath).find((s) => s.id === sessionId);
        return String(row?.intent || '').slice(0, 240);
      } catch { return ''; }
    },
  };
}
