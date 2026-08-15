// Release-content coordination (1.72.0) — does this release leave finished
// work behind?
//
// Coordination in this engine had always been about files two sessions are
// editing RIGHT NOW. Nothing ever asked whether COMPLETED work was actually in
// the build being cut. On 2026-08-15 a desktop release was prepared from a
// branch that could not contain three finished commits, and the founder
// noticed, not the tooling — the same shape as the 1.3.107 regression, where
// the highest version number KLYPIX had ever produced was missing 211 commits
// and an entire feature.
//
//   RA1  a release cut FROM trunk is clean and says so.
//   RA2  an off-trunk release reports the trunk commits it would drop, with
//        their shas and subjects — the 1.3.107 class.
//   RA3  THE CASE TRUNK ALONE MISSES, and the reason this lives in the
//        coordination engine: work that has not reached trunk yet. A release
//        can be a perfect descendant of origin/master while a peer session sits
//        on a local branch holding the finished commits. Only the presence lane
//        knows which branches are live.
//   RA4  a commit subject containing the field separator, quotes, or unicode
//        does not corrupt the parse.
//   RA5  unanswerable questions return null rather than a guess — no git, an
//        unknown ref, no trunk and no peers.
//   RA6  the warning text names the commits AND tells the reader to inform the
//        user. A structured field a model can decline to mention is not a gate.
//   RA7  the release ref itself is never treated as its own source.
//   RA8  bounded: at most 8 commits listed, with an honest "…and N more".
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { releaseAncestry, releaseAncestryWarnings } from '../src/repo-state.mjs';

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-ancestry-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (msg, file = 'f.txt') => {
  fs.writeFileSync(path.join(repo, file), `${msg}\n${Date.now()}${Math.random()}`);
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo, stdio: 'pipe' });
  return git('rev-parse', '--short', 'HEAD');
};

try {
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  commit('base');
  // A real remote tracking ref, so origin/master is a genuine trunk candidate.
  // OUTSIDE the working tree: a bare repo nested inside it becomes tracked
  // content, and its refs then block every checkout.
  const originDir = `${repo}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', originDir], { stdio: 'pipe' });
  git('remote', 'add', 'origin', originDir);
  git('push', '-q', '-u', 'origin', 'master');

  // ---- RA1 — the normal case -------------------------------------------
  git('checkout', '-q', '-b', 'release/1.0.0');
  const clean = releaseAncestry(repo, 'release/1.0.0');
  ok('RA1 a release cut from trunk is a descendant', clean?.isDescendant === true);
  ok('RA1 and reports status ok', clean.status === 'ok');
  ok('RA1 nothing is missing', clean.missingCount === 0);
  ok('RA1 and it produces no warnings', releaseAncestryWarnings(clean).length === 0);

  // ---- RA2 — the 1.3.107 class: trunk moved on, release did not ---------
  git('checkout', '-q', 'master');
  const dropped1 = commit('feat: a whole feature the release would lose');
  const dropped2 = commit('fix: a data-corruption fix the release would lose');
  git('push', '-q', 'origin', 'master');

  const offTrunk = releaseAncestry(repo, 'release/1.0.0');
  ok('RA2 an off-trunk release is not a descendant', offTrunk.isDescendant === false);
  ok('RA2 it counts what would be dropped', offTrunk.missingCount === 2);
  ok('RA2 the source is named as trunk', offTrunk.sources[0].kind === 'trunk');
  const shas = offTrunk.missing.map((c) => c.sha);
  ok('RA2 both commits are identified', shas.includes(dropped1) && shas.includes(dropped2));
  ok('RA2 subjects survive', offTrunk.missing.some((c) => /whole feature/.test(c.subject)));

  // ---- RA6 — the text a human reads -------------------------------------
  const warn = releaseAncestryWarnings(offTrunk).join('\n');
  ok('RA6 it leads with the consequence', /RELEASE WOULD LEAVE WORK BEHIND/.test(warn));
  ok('RA6 it names the count', /2 finished commit/.test(warn));
  ok('RA6 it lists the shas', warn.includes(dropped1));
  ok('RA6 it instructs the reader to inform the user', /Say this to them in your own words/.test(warn));
  ok('RA6 it explains the CONSEQUENCE, not just the fact', /will not be in it/.test(warn));
  ok('RA6 it warns the loss would go unnoticed', /nobody will notice/.test(warn));

  // ---- RA3 — the case trunk alone misses --------------------------------
  // Reset so the release IS a perfect descendant of origin/master, then put the
  // finished work on a peer's local branch that was never pushed. This is
  // exactly the 2026-08-15 miss: the trunk check passed and the work was still
  // going to be left behind.
  git('checkout', '-q', 'release/1.0.0');
  git('merge', '-q', 'origin/master', '-m', 'merge trunk');
  const viaTrunkOnly = releaseAncestry(repo, 'release/1.0.0');
  ok('RA3 trunk alone now reports the release as clean', viaTrunkOnly.isDescendant === true);

  git('checkout', '-q', '-b', 'peer-work', 'origin/master');
  const unpushed = commit('feat: finished work sitting on a peer branch');
  git('checkout', '-q', 'release/1.0.0');

  const stillClean = releaseAncestry(repo, 'release/1.0.0');
  ok('RA3 without peer branches the miss is invisible — the bug, reproduced', stillClean.isDescendant === true);

  const withPeers = releaseAncestry(repo, 'release/1.0.0', { peerBranches: ['peer-work'] });
  ok('RA3 WITH the live peer branch the miss is caught', withPeers.isDescendant === false);
  ok('RA3 it counts the peer commit', withPeers.missingCount === 1);
  ok('RA3 the source is labelled a peer branch', withPeers.sources[0].kind === 'peer-branch');
  ok('RA3 and names it', withPeers.sources[0].ref === 'peer-work');
  ok('RA3 the commit is identified', withPeers.missing[0].sha === unpushed);
  ok('RA3 the text says someone is working on that branch right now',
    /someone is working on right now/.test(releaseAncestryWarnings(withPeers).join('\n')));

  // ---- RA7 — a ref is never its own source ------------------------------
  const selfRef = releaseAncestry(repo, 'peer-work', { peerBranches: ['peer-work', 'peer-work'] });
  ok('RA7 the release ref is excluded from its own sources',
    !(selfRef?.sources || []).some((s) => s.ref === 'peer-work'));

  // ---- RA4 — hostile commit subjects ------------------------------------
  git('checkout', '-q', 'peer-work');
  const nasty = commit('fix: "quoted"  separator, emoji 🧠 and — dashes');
  git('checkout', '-q', 'release/1.0.0');
  const parsed = releaseAncestry(repo, 'release/1.0.0', { peerBranches: ['peer-work'] });
  const found = parsed.missing.find((c) => c.sha === nasty);
  ok('RA4 a subject containing the separator still parses to the right sha', !!found);
  ok('RA4 and keeps its text', /quoted/.test(found.subject));
  ok('RA4 every sha is a plausible short sha, never a fragment of a subject',
    parsed.missing.every((c) => /^[0-9a-f]{6,40}$/.test(c.sha)));

  // ---- RA8 — bounded ----------------------------------------------------
  git('checkout', '-q', 'peer-work');
  for (let i = 0; i < 12; i++) commit(`chore: filler ${i}`);
  git('checkout', '-q', 'release/1.0.0');
  const many = releaseAncestry(repo, 'release/1.0.0', { peerBranches: ['peer-work'] });
  ok('RA8 the full count is honest', many.missingCount >= 14);
  ok('RA8 the listing is capped at 8', many.sources[0].missing.length === 8);
  ok('RA8 and the remainder is stated, never silently dropped',
    /…and \d+ more/.test(releaseAncestryWarnings(many).join('\n')));

  // ---- RA5 — "cannot answer" is its own state, and it FAILS CLOSED --------
  // Returning null here made "the ref does not exist" and "git timed out"
  // indistinguishable from "clean", and the caller granted the lease silently.
  // An agent could trigger it with a single mistyped ref name.
  const unknownRef = releaseAncestry(repo, 'no/such/ref');
  ok('RA5 an unknown ref is reported as unknown, never as clean', unknownRef.status === 'unknown');
  ok('RA5 it names the reason', unknownRef.reason === 'target-unresolved');
  ok('RA5 it is NOT a descendant — silence must not read as a pass', unknownRef.isDescendant === false);
  const unknownWarn = releaseAncestryWarnings(unknownRef).join('\n');
  ok('RA5 it says the check could not run', /COULD NOT RUN/.test(unknownWarn));
  ok('RA5 and explicitly denies being an all-clear', /not an all-clear/.test(unknownWarn));
  ok('RA5 an empty project dir is unknown', releaseAncestry('', 'master').status === 'unknown');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-norepo-'));
  try {
    ok('RA5 a directory that is not a repo is unknown', releaseAncestry(notARepo, 'master').status === 'unknown');
  } finally { fs.rmSync(notARepo, { recursive: true, force: true }); }
  ok('RA5 warnings of null are empty, never a crash', releaseAncestryWarnings(null).length === 0);

  // ---- RA9 — EVERY trunk candidate, not the first that resolves ----------
  // First-match-wins picked origin/master in any normal clone and therefore
  // never compared LOCAL master — which is exactly where the 2026-08-15
  // commits sat, unpushed. The feature was blind to its own motivating
  // incident for any session with no live peer on that branch.
  git('checkout', '-q', 'master');
  const localOnly = commit('feat: committed locally and never pushed');
  git('checkout', '-q', 'release/1.0.0');
  git('merge', '-q', 'origin/master', '-m', 'merge remote trunk');
  const bothTrunks = releaseAncestry(repo, 'release/1.0.0');
  ok('RA9 a release level with origin/master is still dirty vs LOCAL master',
    bothTrunks.status === 'dirty');
  ok('RA9 the local commit is named with NO peer branches supplied',
    bothTrunks.sources.some((s) => s.missing.some((c) => c.sha === localOnly)));
  ok('RA9 local master is labelled trunk, not a peer branch',
    bothTrunks.sources.find((s) => s.ref === 'master')?.kind === 'trunk');

  // ---- RA12 — a sha is demanded ONCE, not once per source ----------------
  // trunk plus a peer sitting on trunk is the DEFAULT configuration.
  const deduped = releaseAncestry(repo, 'release/1.0.0', { peerBranches: ['master', 'master'] });
  const allShas = deduped.sources.flatMap((s) => s.missing.map((c) => c.sha));
  ok('RA12 no sha is listed twice across sources', new Set(allShas).size === allShas.length);

  // ---- RA11 — a merge-only divergence cannot be acknowledged away --------
  // --count always included merges while the listing used --no-merges, so a
  // divergence made only of merges reported missingCount > 0 with nothing
  // listed — and an empty list opened the gate with no acknowledgement.
  const mrepo = globalThis.__mrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-merge-'));
  const mg = (...args) => execFileSync('git', args, { cwd: mrepo, encoding: 'utf8', stdio: 'pipe' });
  const mcommit = (msg) => {
    fs.writeFileSync(path.join(mrepo, `${msg.replace(/\W/g, '')}.txt`), msg);
    mg('add', '-A'); execFileSync('git', ['commit', '-q', '-m', msg], { cwd: mrepo, stdio: 'pipe' });
  };
  mg('init', '-q', '-b', 'master'); mg('config', 'user.email', 't@e.com'); mg('config', 'user.name', 'T');
  mcommit('base');
  mg('checkout', '-q', '-b', 'side'); mcommit('side work');
  mg('checkout', '-q', 'master');
  mg('checkout', '-q', '-b', 'release/2.0.0');
  mg('checkout', '-q', 'master');
  execFileSync('git', ['merge', '--no-ff', '-q', 'side', '-m', 'merge side'], { cwd: mrepo, stdio: 'pipe' });
  const mergeOnly = releaseAncestry(mrepo, 'release/2.0.0');
  ok('RA11 a divergence is detected', mergeOnly.status !== 'ok');
  ok('RA11 merges are now LISTED, so the listing is a subset of the count',
    mergeOnly.status === 'dirty' && mergeOnly.missing.length > 0);
  ok('RA11 the count and the listing agree in the user\'s favour',
    mergeOnly.missing.length <= mergeOnly.missingCount);

  // ---- RA13 — a ref at the same sha as the release is CLEAN, not unknown --
  // Cutting a release branch from trunk and declaring immediately is the most
  // common legitimate case; dropping the equal ref left zero candidates and
  // the new cannot-answer path then refused it.
  const freshRepo = globalThis.__freshRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-fresh-'));
  const fg = (...args) => execFileSync('git', args, { cwd: freshRepo, encoding: 'utf8', stdio: 'pipe' });
  fg('init', '-q', '-b', 'master'); fg('config', 'user.email', 't@e.com'); fg('config', 'user.name', 'T');
  fs.writeFileSync(path.join(freshRepo, 'f.txt'), 'x'); fg('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: freshRepo, stdio: 'pipe' });
  fg('checkout', '-q', '-b', 'release/1.0.0');
  const justCut = releaseAncestry(freshRepo, 'release/1.0.0');
  ok('RA13 a branch just cut from trunk reads clean', justCut.status === 'ok' && justCut.isDescendant === true);
  ok('RA13 and produces no warnings', releaseAncestryWarnings(justCut).length === 0);

  console.log(`✓ release ancestry — ${pass}/${pass} assertions`);
} finally {
  for (const d of [repo, , globalThis.__mrepo, globalThis.__freshRepo]) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  }
  try { fs.rmSync(`${repo}-origin.git`, { recursive: true, force: true }); } catch { /* temp */ }
}
