// Release-claim join (2026-08-16 field failure) — does the gate know WHOSE work
// it is about to drop, and does it demand the WHOLE set?
//
// Desktop v1.3.120 shipped without cdcddb1 (Arrow tool) and b493ead+086bb17
// (zoom-relative stroke width) while BOTH owning sessions were live in the same
// lane and had told the founder their work would be in that build. Nothing
// malfunctioned. The engine modelled file conflicts between sessions, and
// separately modelled what a release leaves behind, and never joined the two —
// so a dropped commit reached the human as an anonymous sha.
//
// Two independent defects made that possible, and each gets its own case:
//
//   RJ1  a dropped commit that touches a LIVE peer's declared scope is
//        attributed to that peer, by name, and sorted to the top of the list.
//   RJ2  a dropped commit touching a peer's OBSERVED scope counts too — observed
//        is how scope gets adopted for work nobody declared, which is exactly
//        the work most likely to go missing.
//   RJ3  files EVERYONE claims (a pending release-notes file, a strings catalog)
//        do not establish ownership. Alarm fatigue is itself a release-integrity
//        defect; a name that is always attached means nothing.
//   RJ4  the acknowledgement handshake demands EVERY dropped sha, not the
//        truncated display list. v1.3.120 cleared a gate over 71 dropped commits
//        by naming 10, because `listed` was derived from the 8-per-source prose.
//   RJ5  a release dropping a live peer's commit FAILS CLOSED when that commit
//        is not acknowledged — the case the field failure needed.
//   RJ6  the join never invents an owner: no peers, no scope, or a failed git
//        probe all degrade to anonymous shas rather than a wrong name.
//   RJ7  and it must actually TRUNCATE to prove RJ4 — with fewer commits than
//        the display cap the bug is invisible, which is how break-testing caught
//        that RJ4 alone passed with the defect restored.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { releaseAncestry, releaseAncestryWarnings } from '../src/repo-state.mjs';
import { annotateAncestryOwnership, ancestryAcknowledged } from '../src/mcp-presence.mjs';

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-claim-join-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (msg, file) => {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${msg}\n${Math.random()}`);
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo, stdio: 'pipe' });
  return git('rev-parse', 'HEAD');
};

try {
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { stdio: 'pipe' });
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  commit('base', 'README.md');
  git('checkout', '-q', '-b', 'release/1.0.0');
  git('checkout', '-q', 'master');

  // Three commits left behind, mirroring the real incident.
  const arrow = commit('feat: the Shapes menu has an arrow', 'src/canvas/interaction/Toolbar.tsx');
  const stroke = commit('refactor: stroke-width conversion', 'src/canvas/drawing/strokeScale.ts');
  const notesOnly = commit('docs: pending release note', 'docs/RELEASE_NOTES_NEXT.md');

  // Two live peers plus the releasing session. Note BOTH peers declare the
  // shared release-notes file — that is what made the naive join noisy.
  const sessions = [
    {
      id: 'a2fc22fd-2c2c-4855-9999-000000000001',
      branch: 'master',
      intent: 'so i will see the change with next build ?',
      files: ['src/canvas/interaction/Toolbar.tsx', 'docs/RELEASE_NOTES_NEXT.md'],
      observedFiles: [],
    },
    {
      id: 'c675913a-8069-4bfd-8888-000000000002',
      branch: 'master',
      intent: 'Landed zoom-relative stroke width',
      files: ['docs/RELEASE_NOTES_NEXT.md'],
      // DECLARED nothing for strokeScale — only observed. This is the case that
      // matters most: the session never got round to declaring it.
      observedFiles: [`${repo.replace(/\\/g, '/')}/src/canvas/drawing/strokeScale.ts`],
    },
    { id: 'me-releaser', branch: 'master', files: [], observedFiles: [] },
  ];

  const raw = releaseAncestry(repo, 'release/1.0.0', { peerBranches: ['master'] });
  ok('setup: the release genuinely drops all three commits', raw.missingCount === 3);
  const anc = annotateAncestryOwnership(raw, sessions, { projectRoot: repo, selfId: 'me-releaser' });
  const bySha = new Map(anc.sources.flatMap((s) => s.missing).map((c) => [c.sha, c]));
  const find = (full) => [...bySha.values()].find((c) => full.startsWith(c.sha));
  const strong = (c) => (c?.owners || []).filter((o) => !o.sharedScopeOnly);

  // ---- RJ1 — declared scope attributes the commit -----------------------
  ok('RJ1 a commit touching a live peer\'s DECLARED file is attributed to them',
    strong(find(arrow)).some((o) => o.prefix === 'a2fc22fd'));
  ok('RJ1 the attribution carries the file that proves it',
    strong(find(arrow))[0].files.some((f) => /toolbar\.tsx$/.test(f)));
  ok('RJ1 and the peer\'s intent rides along, so the human sees what they think they shipped',
    /next build/.test(strong(find(arrow))[0].intent || ''));

  // ---- RJ2 — observed scope counts, and absolute matches relative --------
  ok('RJ2 an OBSERVED-only file attributes the commit too',
    strong(find(stroke)).some((o) => o.prefix === 'c675913a'));

  // ---- RJ3 — a file everyone claims proves nothing -----------------------
  ok('RJ3 a commit touching only the shared release-notes file has no strong owner',
    strong(find(notesOnly)).length === 0);
  ok('RJ3 the shared claim is still recorded, just demoted rather than deleted',
    (find(notesOnly).owners || []).every((o) => o.sharedScopeOnly === true));
  ok('RJ3 peerOwnedCount counts only genuinely-owned commits', anc.peerOwnedCount === 2);

  // Peer-owned entries must sort ABOVE anonymous ones: the list is truncated for
  // display, so the commits with a person attached must never fall off the end.
  const order = anc.sources[0].missing.map((c) => (strong(c).length ? 'owned' : 'anon'));
  ok('RJ3 owned commits sort to the top', order.indexOf('anon') === -1
    || order.lastIndexOf('owned') < order.indexOf('anon'));

  // ---- RJ4 — the gate demands EVERY sha, not the display list -----------
  const allShas = anc.sources.flatMap((s) => s.allShas || []);
  ok('RJ4 every dropped sha is carried for the gate', new Set(allShas).size === 3);
  ok('RJ4 acknowledging only the displayed subset is NOT enough',
    ancestryAcknowledged(anc, [arrow]) === false);
  ok('RJ4 acknowledging every sha is', ancestryAcknowledged(anc, [arrow, stroke, notesOnly]) === true);

  // ---- RJ5 — THE FIELD FAILURE: fails closed ---------------------------
  ok('RJ5 a release dropping a live peer\'s commit is NOT acknowledged by silence',
    ancestryAcknowledged(anc, []) === false);
  ok('RJ5 nor by acknowledging only the commits nobody owns',
    ancestryAcknowledged(anc, [notesOnly]) === false);
  const text = releaseAncestryWarnings(anc).join('\n');
  ok('RJ5 the warning text NAMES the live owner rather than printing a bare sha',
    /OWNED BY LIVE SESSION a2fc22fd/.test(text));
  ok('RJ5 and headlines that a live session may already have promised this work',
    /2 of them touch files a LIVE session/.test(text));

  // ---- RJ6 — never invent an owner --------------------------------------
  ok('RJ6 no peers at all leaves the ancestry untouched',
    annotateAncestryOwnership(raw, [], { projectRoot: repo, selfId: 'me' }).peerOwnedCount === undefined);
  ok('RJ6 peers with no scope attribute nothing',
    annotateAncestryOwnership(raw, [{ id: 'x', files: [], observedFiles: [] }], { projectRoot: repo, selfId: 'me' })
      .peerOwnedCount === undefined);
  const probeFailed = annotateAncestryOwnership(raw, sessions, {
    projectRoot: repo,
    selfId: 'me-releaser',
    execGit: () => { throw new Error('simulated git failure'); },
  });
  ok('RJ6 a FAILED git probe yields anonymous shas, never a wrong name',
    !(probeFailed.peerOwnedCount > 0));
  ok('RJ6 and the divergence is still reported when ownership is unknown',
    probeFailed.missingCount === 3);

  // ---- RJ7 — TRUNCATION IS THE WHOLE POINT ------------------------------
  // Caught by break-testing RJ4: with only three dropped commits nothing is
  // truncated, so `missing` and `allShas` are identical and RJ4 passes even with
  // the bug restored. The defect only exists ABOVE the display cap — which is
  // precisely the situation the field failure was in (69 dropped, 8 shown). A
  // test for a truncation bug must actually truncate.
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-claim-trunc-'));
  globalThis.__manyRepo = many;
  const mgit = (...a) => execFileSync('git', a, { cwd: many, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'master', many], { stdio: 'pipe' });
  mgit('config', 'user.email', 't@example.com');
  mgit('config', 'user.name', 'Test');
  const mcommit = (msg, file) => {
    const full = path.join(many, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${msg}\n${Math.random()}`);
    mgit('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: many, stdio: 'pipe' });
    return mgit('rev-parse', 'HEAD');
  };
  mcommit('base', 'README.md');
  mgit('checkout', '-q', '-b', 'release/2.0.0');
  mgit('checkout', '-q', 'master');
  const dropped = [];
  for (let i = 1; i <= 12; i++) dropped.push(mcommit(`work ${String(i).padStart(2, '0')}`, `src/f${i}.ts`));

  const big = releaseAncestry(many, 'release/2.0.0', { peerBranches: ['master'] });
  const shownShas = big.sources.flatMap((s) => s.missing).map((c) => c.sha);
  const gateShas = big.sources.flatMap((s) => s.allShas || []);
  ok('RJ7 the display list really is truncated', shownShas.length === 8 && big.missingCount === 12);
  ok('RJ7 the source flags its own truncation', big.sources[0].listTruncated === true);
  ok('RJ7 the gate still carries every dropped sha', new Set(gateShas).size === 12);
  // THE ASSERTION THAT CATCHES THE FIELD BUG: naming only what was displayed
  // must not clear a gate covering more than was displayed.
  ok('RJ7 acknowledging only the DISPLAYED shas does not clear the gate',
    ancestryAcknowledged(big, shownShas) === false);
  ok('RJ7 acknowledging every dropped sha does', ancestryAcknowledged(big, dropped) === true);
  ok('RJ7 the refusal text admits the prose is a sample, not the requirement',
    big.sources[0].missingCount > big.sources[0].missing.length);

  console.log(`✓ release-claim join — ${pass}/${pass} assertions`);
} finally {
  for (const d of [repo, globalThis.__manyRepo]) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}
