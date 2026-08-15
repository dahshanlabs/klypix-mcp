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
  ok('RA6 it instructs the reader to inform the user', /TELL THE USER/.test(warn));

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
  ok('RA3 the text says another session is working there',
    /another session is working/.test(releaseAncestryWarnings(withPeers).join('\n')));

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

  // ---- RA5 — unanswerable is null, never a guess ------------------------
  ok('RA5 an unknown ref returns null', releaseAncestry(repo, 'no/such/ref') === null);
  ok('RA5 an empty project dir returns null', releaseAncestry('', 'master') === null);
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-norepo-'));
  try {
    ok('RA5 a directory that is not a repo returns null', releaseAncestry(notARepo, 'master') === null);
  } finally { fs.rmSync(notARepo, { recursive: true, force: true }); }
  ok('RA5 warnings of null are empty, never a crash', releaseAncestryWarnings(null).length === 0);

  console.log(`✓ release ancestry — ${pass}/${pass} assertions`);
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp */ }
  try { fs.rmSync(`${repo}-origin.git`, { recursive: true, force: true }); } catch { /* temp */ }
}
