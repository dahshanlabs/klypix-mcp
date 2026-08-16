// 1.70.0 measured wave — the exclusive RELEASE LEASE in brain_sync.
// Locks in:
//   RL1 — first declarer takes the lease: brain_sync releaseIntent {version,
//         ref} on start/checkpoint records an exclusive per-project lease in
//         the lane file; structured.releaseLease.status 'taken' names the
//         holder, and the response text carries the one-line footer.
//   RL2 — hard conflict: a SECOND session declaring release intent for the
//         same project gets structured.releaseLease {status:'conflict',
//         severity:'blocking'} naming the holder + version + ref, and the
//         sync prose says so; the holder's lease is untouched.
//   RL3 — every peer's sync footer gains one line while a lease is active:
//         "release in preparation: vX from <ref> (session <prefix>)"; the
//         structured block reads status 'held'.
//   RL4 — checkpoint refresh: a plain holder checkpoint (no releaseIntent)
//         advances the ~2h TTL.
//   RL5 — freed by phase complete: a REAL completion releases the lease and a
//         rival can then take it.
//   RL6 — expiry: an unrefreshed lease past its TTL stops binding anyone even
//         while the holder session row stays live; the next declarer reclaims
//         it with reclaimed:'expired'.
//   RL7 — dead-holder sweep: when the holder is no longer a live lane session
//         (TTL pruning / dead-host sweep via pruneSessions), the lease frees
//         with zero cooperation; the next declarer reclaims with
//         reclaimed:'dead-holder'. A non-holder can never free a LIVE lease.
//   RL8 — fail-closed input: a malformed releaseIntent rejects the whole sync
//         with mutation:'none' and changes no lease state.
//   RL9 — zero-config advisory: with NO declarations, a checkout whose
//         packageVersion is AHEAD of the last released tag surfaces a soft
//         releaseAdvisory (repoState.latestReleaseTag is the baseline); an
//         aligned checkout stays silent; an active lease suppresses it.
//   RL10 — additive: schemaVersion stays 1 and the releaseLease /
//         releaseAdvisory keys are simply absent when nothing applies.
//   RL5b — (review fix) a REAL completion frees the lease even when the
//         completion sync still carries releaseIntent (the declaration is
//         ignored, the free is not); a non-holder's completion declaration
//         can never free a live peer's lease; a DEFERRED completion (premature
//         complete, no checkpoint) keeps the lease.
//   RL11 — (review fix) a holder whose lease lapsed (TTL passed with no
//         checkpoint) is told 'lease-lost' on its next sync instead of the
//         record being pruned silently.
//
// Run:  node test/release-lease.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  RELEASE_LEASE_TTL_MS,
  declareReleaseLease,
  freeReleaseLease,
  laneFileFor,
  readReleaseLease,
  refreshReleaseLease,
  releaseLeaseVerdict,
  upsertSession,
} from '../src/agent-presence.mjs';
import { createMcpPresence, validateReleaseIntent } from '../src/mcp-presence.mjs';
import { collectRepoState } from '../src/repo-state.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// PID-scoped fixtures so parallel workers never share lanes.
const home = path.join(os.tmpdir(), `klypix-release-lease-home-${process.pid}`);
const project = path.join(os.tmpdir(), `klypix-release-lease-project-${process.pid}`);
const deadProject = path.join(os.tmpdir(), `klypix-release-lease-dead-${process.pid}`);
const unitProject = path.join(os.tmpdir(), `klypix-release-lease-unit-${process.pid}`);
const completeProject = path.join(os.tmpdir(), `klypix-release-lease-complete-${process.pid}`);
const lostProject = path.join(os.tmpdir(), `klypix-release-lease-lost-${process.pid}`);
const aheadRepo = path.join(os.tmpdir(), `klypix-release-lease-ahead-${process.pid}`);
const alignedRepo = path.join(os.tmpdir(), `klypix-release-lease-aligned-${process.pid}`);
for (const target of [home, project, deadProject, unitProject, completeProject, lostProject, aheadRepo, alignedRepo]) {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
for (const target of [project, deadProject, unitProject, completeProject, lostProject]) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'brain.klypix'), 'fixture');
}

const timer = () => ({ unref() {} });
const clock = { value: Date.parse('2026-08-14T10:00:00Z') };
const makePresence = (sessionId) => createMcpPresence({
  server: {},
  initialVault: project,
  env: { KLYPIX_SESSION_ID: sessionId },
  home,
  now: () => clock.value,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});

try {
  // ── RL8 first (validator is pure; run before any lane state exists) ────────
  ok(validateReleaseIntent(undefined).provided === false, 'RL8: absent releaseIntent is simply not provided');
  ok(validateReleaseIntent({ version: 'v1.70.0', ref: 'core/1.70-measured-wave' }).ok === true
    && validateReleaseIntent({ version: 'v1.70.0', ref: 'x' }).version === '1.70.0',
  'RL8: a v-prefixed semver is accepted and normalized');
  ok(validateReleaseIntent({ version: 'not-a-version', ref: 'main' }).ok === false, 'RL8: a non-semver version is rejected');
  ok(validateReleaseIntent({ version: '1.2.3', ref: 'has space' }).ok === false, 'RL8: a ref with whitespace is rejected');
  ok(validateReleaseIntent('1.2.3@main').ok === false, 'RL8: a non-object releaseIntent is rejected');

  const holder = makePresence('release-holder-session');
  const badSync = holder.sync({
    project,
    intent: 'attempt a malformed release declaration',
    phase: 'start',
    releaseIntent: { version: 'one-point-seventy', ref: 'core/1.70' },
  });
  ok(badSync.isError === true
    && badSync.structured?.status === 'invalid-release-intent'
    && badSync.structured?.mutation === 'none',
  'RL8: a malformed releaseIntent rejects the sync fail-closed with mutation none');
  ok(readReleaseLease({ brainPath: path.join(project, 'brain.klypix'), home, now: clock.value }) === null,
    'RL8: the rejected declaration recorded no lease');

  // ── RL1: first declarer takes the lease ────────────────────────────────────
  const taken = holder.sync({
    project,
    intent: 'prepare the 1.70.0 release',
    phase: 'start',
    releaseIntent: { version: '1.70.0', ref: 'core/1.70-measured-wave' },
  });
  ok(taken.structured?.schemaVersion === 1, 'RL1: schemaVersion stays 1 (additive fields only)');
  ok(taken.structured?.releaseLease?.status === 'taken', 'RL1: the first declarer takes the lease');
  ok(taken.structured?.releaseLease?.holder?.version === '1.70.0'
    && taken.structured?.releaseLease?.holder?.ref === 'core/1.70-measured-wave'
    && taken.structured?.releaseLease?.holder?.sessionId === 'release-holder-session',
  'RL1: the structured holder names session + version + ref');
  ok(typeof taken.structured?.releaseLease?.holder?.expiresAt === 'number'
    && taken.structured.releaseLease.holder.expiresAt === clock.value + RELEASE_LEASE_TTL_MS,
  'RL1: the lease carries the ~2h expiry');
  ok(taken.text.includes('release in preparation: v1.70.0 from core/1.70-measured-wave (session '),
    'RL1: the response text carries the one-line release footer');
  ok(taken.text.includes('release lease taken'), 'RL1: the grant is stated in prose');

  // ── RL2: a second declarer gets a structured hard conflict ─────────────────
  clock.value += 60_000;
  const rival = makePresence('release-rival-session');
  const conflicted = rival.sync({
    project,
    intent: 'also try to cut a release',
    phase: 'start',
    releaseIntent: { version: '1.70.1', ref: 'rival/branch' },
  });
  const conflict = conflicted.structured?.releaseLease;
  ok(conflict?.status === 'conflict' && conflict?.severity === 'blocking' && conflict?.kind === 'release-lease-held',
    'RL2: the second declarer gets a blocking structured conflict');
  ok(conflict?.holder?.sessionId === 'release-holder-session'
    && conflict?.holder?.version === '1.70.0'
    && conflict?.holder?.ref === 'core/1.70-measured-wave',
  'RL2: the conflict names the holder + version + ref');
  ok(conflict?.requested?.version === '1.70.1' && conflict?.requested?.ref === 'rival/branch',
    'RL2: the conflict echoes what was requested');
  ok(conflicted.text.includes('release-lease conflict')
    && conflicted.text.includes('v1.70.0 from core/1.70-measured-wave'),
  'RL2: the sync prose states the conflict and the holder');
  const afterConflict = readReleaseLease({ brainPath: path.join(project, 'brain.klypix'), home, now: clock.value });
  ok(afterConflict?.holderId === 'release-holder-session' && afterConflict?.version === '1.70.0',
    'RL2: the holder lease is untouched by the refused declaration');

  // ── RL3: every peer footer gains the line ──────────────────────────────────
  clock.value += 30_000;
  const peer = makePresence('release-peer-session');
  const peerSync = peer.sync({ project, intent: 'unrelated refactor', phase: 'start' });
  ok(peerSync.structured?.releaseLease?.status === 'held'
    && peerSync.structured.releaseLease.holder?.sessionId === 'release-holder-session',
  'RL3: a non-declaring peer sees the lease as held, with the holder named');
  ok(peerSync.text.includes('release in preparation: v1.70.0 from core/1.70-measured-wave (session '),
    'RL3: the peer footer carries the release-in-preparation line');

  // ── RL4: a plain holder checkpoint refreshes the TTL ───────────────────────
  clock.value += 30 * 60 * 1000;
  const refreshed = holder.sync({ project, intent: 'release build running', phase: 'checkpoint' });
  ok(refreshed.structured?.releaseLease?.status === 'refreshed',
    'RL4: a holder checkpoint without releaseIntent refreshes the lease');
  const afterRefresh = readReleaseLease({ brainPath: path.join(project, 'brain.klypix'), home, now: clock.value });
  ok(afterRefresh?.refreshedAt === clock.value && afterRefresh?.expiresAt === clock.value + RELEASE_LEASE_TTL_MS,
    'RL4: the TTL restarts from the checkpoint');
  const rivalCheckpoint = rival.sync({ project, intent: 'still waiting', phase: 'checkpoint' });
  ok(rivalCheckpoint.structured?.releaseLease?.status === 'held',
    'RL4: a NON-holder checkpoint never refreshes or steals the lease');

  // ── RL5: freed by real completion; a rival can then take it ────────────────
  clock.value += 60_000;
  const completed = holder.sync({ project, phase: 'complete' });
  ok(completed.structured?.status === 'complete', 'RL5: the holder completion is a real completion');
  ok(completed.structured?.releaseLease?.status === 'released'
    && completed.structured.releaseLease.released?.version === '1.70.0',
  'RL5: completion frees the lease and says which release it released');
  ok(!completed.text.includes('release in preparation:'),
    'RL5: the footer line disappears once the lease is freed');
  clock.value += 1000;
  const rivalTakes = rival.sync({
    project,
    intent: 'now cut the rival release',
    phase: 'checkpoint',
    releaseIntent: { version: '1.70.1', ref: 'rival/branch' },
  });
  ok(rivalTakes.structured?.releaseLease?.status === 'taken'
    && rivalTakes.structured.releaseLease.holder?.sessionId === 'release-rival-session',
  'RL5: after the free, the next declarer takes the lease');

  // ── RL7 (MCP level): dead holder frees the lease with zero cooperation ─────
  const deadBrain = path.join(deadProject, 'brain.klypix');
  const deadHolder = createMcpPresence({
    server: {},
    initialVault: deadProject,
    env: { KLYPIX_SESSION_ID: 'dead-holder-session' },
    home,
    now: () => clock.value,
    setIntervalFn: timer,
    clearIntervalFn: () => {},
  });
  const deadTaken = deadHolder.sync({
    project: deadProject,
    intent: 'start a release, then vanish',
    phase: 'start',
    releaseIntent: { version: '3.0.0', ref: 'main' },
  });
  ok(deadTaken.structured?.releaseLease?.status === 'taken', 'RL7: the doomed holder takes its lease first');
  clock.value += 11 * 60 * 1000;   // past every session-freshness window; lease TTL (2h) not reached
  ok(readReleaseLease({ brainPath: deadBrain, home, now: clock.value }) === null,
    'RL7: with no live lane row answering for the holder, the lease stops binding');
  const survivor = createMcpPresence({
    server: {},
    initialVault: deadProject,
    env: { KLYPIX_SESSION_ID: 'surviving-session' },
    home,
    now: () => clock.value,
    setIntervalFn: timer,
    clearIntervalFn: () => {},
  });
  const reclaimed = survivor.sync({
    project: deadProject,
    intent: 'take over the stalled release',
    phase: 'start',
    releaseIntent: { version: '3.0.0', ref: 'main' },
  });
  ok(reclaimed.structured?.releaseLease?.status === 'taken'
    && reclaimed.structured.releaseLease.reclaimed === 'dead-holder',
  'RL7: the next declarer reclaims a dead holder\'s lease, and the reclaim reason is surfaced');

  // ── RL6 + RL7 tail (unit level, injected clock) ────────────────────────────
  const unitBrain = path.join(unitProject, 'brain.klypix');
  const t0 = clock.value + 60 * 60 * 1000;
  upsertSession({ brainPath: unitBrain, id: 'exp-holder', channel: 'mcp', event: 'McpTaskStart', home, now: t0 });
  const unitTaken = declareReleaseLease({
    brainPath: unitBrain, sessionId: 'exp-holder', version: '2.0.0', ref: 'main', home, now: t0,
  });
  ok(unitTaken.ok === true && unitTaken.status === 'taken', 'RL6: unit declare takes the lease');
  const t1 = t0 + RELEASE_LEASE_TTL_MS + 60_000;
  upsertSession({ brainPath: unitBrain, id: 'exp-holder', channel: 'mcp', event: 'McpToolUse', home, now: t1 });
  ok(readReleaseLease({ brainPath: unitBrain, home, now: t1 }) === null,
    'RL6: past the TTL the lease stops binding even while the holder row is still live');
  const lane = JSON.parse(fs.readFileSync(laneFileFor(unitBrain, home), 'utf8'));
  const expiredVerdict = releaseLeaseVerdict(lane.releaseLease, lane.sessions, t1);
  ok(expiredVerdict?.status === 'expired', 'RL6: the verdict names expiry, not a dead holder');
  const reclaimExpired = declareReleaseLease({
    brainPath: unitBrain, sessionId: 'exp-rival', version: '2.0.1', ref: 'main', home, now: t1,
  });
  ok(reclaimExpired.ok === true && reclaimExpired.status === 'taken' && reclaimExpired.reclaimed === 'expired',
    'RL6: the next declarer reclaims an expired lease with the reason surfaced');
  upsertSession({ brainPath: unitBrain, id: 'exp-rival', channel: 'mcp', event: 'McpTaskStart', home, now: t1 });
  const foreignFree = freeReleaseLease({ brainPath: unitBrain, sessionId: 'someone-else', home, now: t1 + 1000 });
  ok(foreignFree.ok === true && foreignFree.status === 'not-holder'
    && readReleaseLease({ brainPath: unitBrain, home, now: t1 + 1000 })?.holderId === 'exp-rival',
  'RL7: a non-holder can never free a LIVE peer\'s lease');
  const holderRefresh = refreshReleaseLease({ brainPath: unitBrain, sessionId: 'exp-rival', home, now: t1 + 1000 });
  ok(holderRefresh.ok === true && holderRefresh.status === 'refreshed'
    && holderRefresh.lease.expiresAt === t1 + 1000 + RELEASE_LEASE_TTL_MS,
  'RL4: unit refresh restarts the TTL for the live holder');
  const holderFree = freeReleaseLease({ brainPath: unitBrain, sessionId: 'exp-rival', home, now: t1 + 2000 });
  ok(holderFree.ok === true && holderFree.status === 'released'
    && readReleaseLease({ brainPath: unitBrain, home, now: t1 + 2000 }) === null,
  'RL5: unit free releases the holder\'s lease');

  // ── RL5b: a REAL completion frees the lease even when the completion sync
  //          still carries releaseIntent (the natural holder pattern is to
  //          attach it to every sync); a NON-holder attaching it on complete
  //          gets the ignored notice and the lease is untouched ──────────────
  const mkPresenceFor = (vault, sessionId) => createMcpPresence({
    server: {},
    initialVault: vault,
    env: { KLYPIX_SESSION_ID: sessionId },
    home,
    now: () => clock.value,
    setIntervalFn: timer,
    clearIntervalFn: () => {},
  });
  const completeBrain = path.join(completeProject, 'brain.klypix');
  const stickyHolder = mkPresenceFor(completeProject, 'sticky-holder-session');
  const stickyIntent = { version: '4.0.0', ref: 'main' };
  ok(stickyHolder.sync({ project: completeProject, intent: 'release 4.0.0', phase: 'start', releaseIntent: stickyIntent })
    .structured?.releaseLease?.status === 'taken', 'RL5b: the sticky holder takes its lease');
  clock.value += 1000;
  const stickyRival = mkPresenceFor(completeProject, 'sticky-rival-session');
  const rivalCompletes = stickyRival.sync({
    project: completeProject, phase: 'complete', releaseIntent: { version: '4.0.1', ref: 'other' },
  });
  ok(rivalCompletes.structured?.releaseLease?.status === 'ignored-on-complete'
    && readReleaseLease({ brainPath: completeBrain, home, now: clock.value })?.holderId === 'sticky-holder-session',
  'RL5b: a NON-holder completing with releaseIntent is ignored and cannot free the holder\'s lease');
  // A checkpoint first, so the completion is REAL (the premature-complete
  // guard defers a start→complete with no checkpoint in between — and a
  // deferred completion must NOT free the lease).
  clock.value += 60_000;
  stickyHolder.sync({ project: completeProject, intent: 'release build green', phase: 'checkpoint' });
  clock.value += 60_000;
  const stickyCompleted = stickyHolder.sync({ project: completeProject, phase: 'complete', releaseIntent: stickyIntent });
  ok(stickyCompleted.structured?.status === 'complete', 'RL5b: the sticky completion is a real completion');
  ok(stickyCompleted.structured?.releaseLease?.status === 'released'
    && stickyCompleted.structured.releaseLease.released?.version === '4.0.0',
  'RL5b: a real completion frees the lease even when the completion sync still carries releaseIntent');
  ok(readReleaseLease({ brainPath: completeBrain, home, now: clock.value }) === null,
    'RL5b: no lease record survives the sticky completion');

  // ── RL11: a holder whose lease lapses (TTL passed, no checkpoint) is TOLD
  //          on its next sync instead of the record being pruned silently ────
  const lostBrain = path.join(lostProject, 'brain.klypix');
  const lapsedHolder = mkPresenceFor(lostProject, 'lapsed-holder-session');
  ok(lapsedHolder.sync({ project: lostProject, intent: 'release then stall', phase: 'start', releaseIntent: { version: '5.0.0', ref: 'main' } })
    .structured?.releaseLease?.status === 'taken', 'RL11: the lapsing holder takes its lease first');
  clock.value += RELEASE_LEASE_TTL_MS + 60_000;
  const lapsedSync = lapsedHolder.sync({ project: lostProject, intent: 'back after a long stall', phase: 'checkpoint' });
  ok(lapsedSync.structured?.releaseLease?.status === 'lease-lost'
    && lapsedSync.structured.releaseLease.reason === 'expired',
  'RL11: the returning holder is told its lease was lost, with the reason');
  ok(lapsedSync.text.includes('release lease lost'), 'RL11: the loss is stated in prose');
  ok(readReleaseLease({ brainPath: lostBrain, home, now: clock.value }) === null,
    'RL11: the lapsed record is pruned by the same sync');

  // ── RL9: zero-config soft advisory from repoState ──────────────────────────
  let gitAvailable = true;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { git(os.tmpdir(), '--version'); } catch { gitAvailable = false; }
  if (!gitAvailable) {
    console.log('[skip] RL9: git is not available on PATH — advisory scenario skipped');
  } else {
    const initRepo = (dir, name, version, tag) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'brain.klypix'), 'fixture');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2));
      // Explicit branch name: the fixtures declare releaseIntent.ref 'main',
      // and since 1.72.0 a ref that does not resolve is REFUSED (naming a
      // nonexistent ref was the cheapest bypass in the gate). git init's default
      // branch varies by version and user config, so pin it.
      git(dir, 'init', '-b', 'main');
      git(dir, '-c', 'user.email=release-lease@test', '-c', 'user.name=release-lease-test',
        '-c', 'commit.gpgsign=false', 'add', '-A');
      git(dir, '-c', 'user.email=release-lease@test', '-c', 'user.name=release-lease-test',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'init');
      if (tag) git(dir, 'tag', tag);
    };
    initRepo(aheadRepo, 'lease-ahead-pkg', '1.1.0', 'v1.0.0');
    initRepo(alignedRepo, 'lease-aligned-pkg', '1.1.0', 'v1.1.0');

    const aheadState = collectRepoState(aheadRepo, { cacheMs: 0 });
    ok(aheadState?.latestReleaseTag?.tag === 'v1.0.0' && aheadState?.latestReleaseTag?.version === '1.0.0',
      'RL9: repoState carries the latest release tag as the baseline (additive field)');

    const aheadPresence = createMcpPresence({
      server: {},
      initialVault: aheadRepo,
      env: { KLYPIX_SESSION_ID: 'advisory-session' },
      home,
      now: () => clock.value,
      setIntervalFn: timer,
      clearIntervalFn: () => {},
    });
    const advisory = aheadPresence.sync({ project: aheadRepo, intent: 'ordinary work on an ahead checkout', phase: 'start' });
    ok(advisory.structured?.releaseAdvisory?.kind === 'checkout-ahead-of-last-release'
      && advisory.structured.releaseAdvisory.packageVersion === '1.1.0'
      && advisory.structured.releaseAdvisory.latestReleaseTag?.tag === 'v1.0.0',
    'RL9: an undeclared ahead-of-tag checkout surfaces the structured soft advisory');
    ok(advisory.text.includes('KLYPIX release advisory')
      && advisory.text.includes('ahead of the last released tag v1.0.0'),
    'RL9: the advisory rides the text channel');
    const declaredNow = aheadPresence.sync({
      project: aheadRepo,
      intent: 'now declared',
      phase: 'checkpoint',
      releaseIntent: { version: '1.1.0', ref: 'main' },
    });
    ok(declaredNow.structured?.releaseLease?.status === 'taken'
      && !declaredNow.structured?.releaseAdvisory
      && declaredNow.text.includes('release in preparation: v1.1.0 from main (session '),
    'RL9: once a lease is active the advisory yields to the footer');

    const alignedPresence = createMcpPresence({
      server: {},
      initialVault: alignedRepo,
      env: { KLYPIX_SESSION_ID: 'aligned-session' },
      home,
      now: () => clock.value,
      setIntervalFn: timer,
      clearIntervalFn: () => {},
    });
    const aligned = alignedPresence.sync({ project: alignedRepo, intent: 'work on a released checkout', phase: 'start' });
    ok(!aligned.structured?.releaseAdvisory && !aligned.structured?.releaseLease,
      'RL9+RL10: an aligned checkout with no lease gets neither advisory nor lease block');
  }

  // ── RL10: additive on a plain project with no lease ────────────────────────
  const plain = peer.sync({ project, intent: 'plain sync after everything settled', phase: 'checkpoint' });
  ok(plain.structured?.schemaVersion === 1
    && (plain.structured?.releaseLease === undefined
      || ['held'].includes(plain.structured.releaseLease.status) === false
      || Boolean(plain.structured.releaseLease.holder)),
  'RL10: schemaVersion stays 1 on ordinary syncs');

  // ── RL12: the HOLDER is warned BEFORE the lease lapses ─────────────────────
  // Field failure 2026-08-16: a coordinator lost the lease mid-release-build and
  // only noticed because the "release in preparation" line vanished from an
  // unrelated render. The design's 'lease-lost' message cannot reach a holder in
  // any project with peers — a non-holder's sync meets the expired lease first,
  // prunes it ('stale-pruned', write:true) and is told nothing, after which the
  // holder's sync takes the no-lease fast path. So the warning has to arrive
  // while the lease still EXISTS. RL11 covers lease-lost on a solo project,
  // which is why this gap survived.
  const warnProject = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-lease-warn-'));
  fs.writeFileSync(path.join(warnProject, 'brain.klypix'), fs.readFileSync(path.join(project, 'brain.klypix')));
  const warnHolder = createMcpPresence({
    server: {}, initialVault: warnProject, env: { KLYPIX_SESSION_ID: 'warn-holder' },
    home, now: () => clock.value, setIntervalFn: timer, clearIntervalFn: () => {},
  });
  const declared = warnHolder.sync({
    project: warnProject, phase: 'start', intent: 'cut the release',
    releaseIntent: { version: '9.9.9', ref: 'release/9.9.9' },
  });
  ok(declared.structured?.releaseLease?.status === 'taken', 'RL12a: holder takes the lease');

  const freshCheck = warnHolder.sync({ project: warnProject, phase: 'checkpoint', intent: 'still building' });
  ok(freshCheck.structured?.releaseLease?.expiringSoon !== true,
    'RL12b: a fresh lease is NOT flagged as expiring');

  // Wind to inside the warning window but BEFORE expiry — the last moment the
  // holder can still act.
  clock.value += RELEASE_LEASE_TTL_MS - (10 * 60 * 1000);
  const nearly = warnHolder.sync({ project: warnProject, phase: 'checkpoint', intent: 'still building' });
  const lease = nearly.structured?.releaseLease;
  ok(lease?.expiringSoon === true, 'RL12c: the holder IS warned while the lease still exists (the regression guard)');
  ok(typeof lease?.expiresInMs === 'number' && lease.expiresInMs > 0,
    'RL12d: the holder is told how long is left, not merely that it is soon');
  ok(/expires in ~\d+ min/.test(nearly.text || ''),
    'RL12e: the warning rides the text channel the holder actually reads');

  try { fs.rmSync(warnProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
} finally {
  for (const target of [home, project, deadProject, unitProject, completeProject, lostProject, aheadRepo, alignedRepo]) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
  }
}

if (failures) {
  console.error(`\n${failures} release-lease check(s) failed`);
  process.exit(1);
}
console.log('\nAll release-lease checks passed');
