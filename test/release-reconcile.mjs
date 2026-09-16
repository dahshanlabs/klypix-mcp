// Release-cut reconcile (1.85.0) — when a release lease is granted, does
// anything still OPEN in the brain look like it already shipped in this ref?
//
// The advisory is the half that must never lie: it runs inside a brain_sync,
// so it is bounded, it writes nothing, and every candidate carries a
// `confirmable` flag that is deliberately conservative. With `ref` being the
// branch under cut, "contained in the ref" is TRUE BY CONSTRUCTION for every
// commit in the range — so containment alone is not evidence, and a coverage
// match only earns `confirmable` at cov ≥ 0.6 from a commit that has a real
// body (the same ≥12-char bar commitToCard has always used).
//
//   RR1  commitsInRange reads subject AND body AND timestamp, caps loudly, and
//        reports an unreadable range as 'unknown' rather than scanning history.
//   RR2  THE HEADLINE: the canvas card the release's commit covers is named,
//        with that sha and confirmable:true — and the iOS card is NOT.
//   RR3  a body-less commit ("fix: typo") never yields a confirmable candidate.
//   RR4  a card carrying its own #commit- tag is confirmable when that sha is
//        contained in the ref, and absent when it is not.
//   RR5  makeContainmentProbe caches per sha and answers FALSE past its budget —
//        a capped probe must never read as proof that work shipped.
//   RR6  the confirm template carries PLACEHOLDERS, never the candidate ids.
//   RR7  the three notice strings are the exact ones the spec fixed.
//   RR8  CC_RE has one definition: the hook's mirrored literal is identical.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
  buildKlypixMap, parseKlypix, releaseFulfilledOpens, releaseReconcileConfirmTemplate,
  releaseReconcileNotice, CC_RE,
} from '../src/klypix-format.mjs';
import { commitsInRange, makeContainmentProbe } from '../src/repo-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// ── fixture repo: v1.3.169 on master, release/1.3.170 carries the ship ───────
const project = path.join(os.tmpdir(), `klypix-release-reconcile-${process.pid}`);
if (!path.resolve(project).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${project}`);
fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
fs.mkdirSync(project, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: 'pipe' }).trim();
// The claim extractor requires the SHIP to post-date the CLAIM (a pre-existing
// milestone can never "fulfil" a newer goal), and buildKlypixMap stamps every
// card with Date.now(). A fixture therefore has to stamp its commits ahead of
// the brain it is reconciled against — an hour is plenty and keeps %ct real.
const AHEAD = new Date(Date.now() + 3600_000).toISOString();
const commit = (subject, body, file) => {
  fs.writeFileSync(path.join(project, file), `${subject}\n${Math.random()}`);
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], {
    cwd: project, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: AHEAD, GIT_COMMITTER_DATE: AHEAD },
  });
  return git('rev-parse', 'HEAD');
};

git('init', '-q', '-b', 'master');
git('config', 'user.email', 'test@klypix.local');
git('config', 'user.name', 'KLYPIX Test');
commit('chore: baseline', '', 'README.md');
git('tag', 'v1.3.169');
git('checkout', '-q', '-b', 'release/1.3.170');
const shipSha = commit(
  'feat(canvas): add the missing arrow tool to the connection palette',
  'Adds an arrow tool to the canvas connection palette so links can be drawn directly between cards.',
  'canvas.js',
);
const typoSha = commit('fix: typo', '', 'typo.txt');
const offRefSha = (() => {
  git('checkout', '-q', '-b', 'side');
  const sha = commit('feat(drive): quota banner', 'Shows the remaining Drive quota in the header.', 'drive.js');
  git('checkout', '-q', 'release/1.3.170');
  return sha;
})();

// ── fixture brain ───────────────────────────────────────────────────────────
const brainFile = path.join(project, 'brain.klypix');
const buildBrain = async (extraCards = []) => {
  const buf = await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Canvas', cards: [{ text: 'Canvas: ❓ arrow tool missing from the canvas connection palette' }, ...extraCards] },
      { title: 'iOS', cards: [{ text: 'iOS: ❓ pairing survives an account switch on the phone' }] },
    ],
  });
  fs.writeFileSync(brainFile, buf);
  const { struct } = await parseKlypix(fs.readFileSync(brainFile));
  return struct;
};

// ── RR1 — commitsInRange ────────────────────────────────────────────────────
const range = commitsInRange(project, 'v1.3.169', 'release/1.3.170');
ok(range.status === 'ok', 'RR1 a readable range reports ok');
ok(range.commits.length === 2, `RR1 the range carries both commits (got ${range.commits.length})`);
const ship = range.commits.find(c => c.sha === shipSha);
ok(!!ship && ship.subject.startsWith('feat(canvas):'), 'RR1 the subject survives');
ok(!!ship && ship.body.includes('connection palette'), 'RR1 the BODY survives (a subject alone rarely covers a claim)');
ok(!!ship && ship.ts > 0, 'RR1 the commit timestamp survives');
ok(!range.commits.some(c => c.sha === offRefSha), 'RR1 a commit on another branch is not in the range');
const capped = commitsInRange(project, 'v1.3.169', 'release/1.3.170', { max: 1 });
ok(capped.capped === true && capped.commits.length === 1, 'RR1 a capped scan says so rather than hiding it');
ok(commitsInRange(project, 'v1.3.169', 'refs/heads/does-not-exist').status === 'unknown', 'RR1 an unknown ref is unknown, not empty');
ok(commitsInRange(project, 'nope-not-a-tag', 'release/1.3.170').status === 'unknown', 'RR1 a bad baseline never falls back to the whole history');

// ── RR2/RR3 — coverage candidates ───────────────────────────────────────────
const struct = await buildBrain();
const contained = makeContainmentProbe(project, 'release/1.3.170');
const { candidates } = releaseFulfilledOpens(struct, range.commits, { ref: 'release/1.3.170', containedFn: contained });
const canvasCard = struct.cards.find(c => /arrow tool missing/.test(c.text || ''));
const iosCard = struct.cards.find(c => /pairing survives/.test(c.text || ''));
const canvasHit = candidates.find(c => c.openId === canvasCard.id);
ok(!!canvasHit, 'RR2 the canvas card the ship covers is named');
ok(!!canvasHit && canvasHit.by.sha === shipSha, 'RR2 the candidate names the commit that covers it');
ok(!!canvasHit && canvasHit.via === 'coverage' && canvasHit.confirmable === true, `RR2 a cov≥0.6 hit from a commit WITH a body is confirmable (via ${canvasHit && canvasHit.via}, cov ${canvasHit && canvasHit.cov})`);
ok(!!canvasHit && canvasHit.unconfirmed === true, 'RR2 every candidate is marked unconfirmed');
ok(!candidates.some(c => c.openId === iosCard.id), 'RR2 the unrelated iOS card is NOT named');
ok(!candidates.some(c => c.by.sha === typoSha && c.confirmable), 'RR3 a body-less "fix: typo" yields no confirmable candidate');

// ── RR4 — the card's own commit receipt ─────────────────────────────────────
const taggedStruct = await buildBrain([
  { text: `Canvas: ❓ lens overlay still freezes on the big brain\n#commit-${shipSha.slice(0, 7)}` },
  { text: `Canvas: ❓ folder cards still re-deflate their zips\n#commit-${offRefSha.slice(0, 7)}` },
]);
const tagged = releaseFulfilledOpens(taggedStruct, range.commits, { ref: 'release/1.3.170', containedFn: makeContainmentProbe(project, 'release/1.3.170') });
const lensCard = taggedStruct.cards.find(c => /lens overlay/.test(c.text || ''));
const folderCard = taggedStruct.cards.find(c => /re-deflate/.test(c.text || ''));
const lensHit = tagged.candidates.find(c => c.openId === lensCard.id);
ok(!!lensHit && lensHit.via === 'commit-tag' && lensHit.confirmable === true, 'RR4 a card whose own #commit- tag IS in the ref is a confirmable commit-tag candidate');
ok(!tagged.candidates.some(c => c.openId === folderCard.id), 'RR4 a card whose #commit- tag is NOT in the ref is absent');

// ── RR5 — containment probe budget ──────────────────────────────────────────
let probes = 0;
const countingGit = (args, cwd, timeoutMs) => {
  probes++;
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs || 4000 });
};
const counted = makeContainmentProbe(project, 'release/1.3.170', { execGit: countingGit });
ok(counted(shipSha) === true, 'RR5 a contained sha answers true');
const afterFirst = probes;
ok(counted(shipSha) === true && probes === afterFirst, 'RR5 the second ask of the same sha is cached (no new spawn)');
ok(counted(offRefSha) === false, 'RR5 a sha on another branch is NOT contained');
const budgeted = makeContainmentProbe(project, 'release/1.3.170', { execGit: countingGit, maxChecks: 0 });
ok(budgeted(shipSha) === false, 'RR5 past the probe budget the answer is FALSE — a capped check never reads as proof');

// ── RR6/RR7 — the strings the human sees ────────────────────────────────────
const tpl = releaseReconcileConfirmTemplate('release/1.3.170');
ok(tpl.tool === 'brain_reconcile' && tpl.args.mode === 'release' && tpl.args.ref === 'release/1.3.170', 'RR6 the template names the tool, mode and ref');
ok(JSON.stringify(tpl.args.confirm) === JSON.stringify([{ id: '<openId>', sha: '<sha>' }]), 'RR6 confirm is a PLACEHOLDER pair');
ok(!JSON.stringify(tpl).includes(canvasCard.id) && !JSON.stringify(tpl).includes(shipSha), 'RR6 the template contains no real id and no real sha');
ok(
  releaseReconcileNotice({ ref: 'release/1.3.170', sinceRef: 'v1.3.169', candidates: [{ confirmable: true }, { confirmable: true }, { confirmable: true }, { confirmable: false }, { confirmable: false }] })
  === 'KLYPIX release reconcile: 5 open card(s) look fulfilled by commits already in release/1.3.170 (3 confirmable) — verify each, then confirm with brain_reconcile mode:"release" ref:"release/1.3.170" confirm:[{ id, sha }] (or dismiss:[…]). Nothing was changed.',
  'RR7 the found notice is verbatim',
);
ok(
  releaseReconcileNotice({ ref: 'release/1.3.170', sinceRef: 'v1.3.169', candidates: [] })
  === 'KLYPIX release reconcile: no open cards look fulfilled by commits in release/1.3.170 since v1.3.169.',
  'RR7 the nothing-found notice is verbatim',
);
ok(
  releaseReconcileNotice({ ref: 'release/1.3.170', skipped: true })
  === 'KLYPIX release reconcile skipped: git history for release/1.3.170 could not be read.',
  'RR7 the skipped notice is verbatim',
);

// ── RR8 — one CC_RE ─────────────────────────────────────────────────────────
// The hook mirrors the literal rather than importing it (it loads the engine
// lazily, only when a brain exists, and a static import would pay the whole
// engine on every prompt). That mirror is only safe if it can never drift.
const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'global-brain-hook.mjs'), 'utf8');
const hookCC = /^const CC_RE = (.+);$/m.exec(hookSrc);
ok(!!hookCC, 'RR8 the hook still defines CC_RE on one line');
ok(!!hookCC && hookCC[1] === CC_RE.toString(), `RR8 the hook's CC_RE is identical to the engine's (${hookCC && hookCC[1]} vs ${CC_RE})`);

// ── advisory writes NOTHING ─────────────────────────────────────────────────
const before = fs.readFileSync(brainFile);
releaseFulfilledOpens(struct, range.commits, { ref: 'release/1.3.170', containedFn: contained });
ok(Buffer.compare(before, fs.readFileSync(brainFile)) === 0, 'the advisory leaves the brain byte-identical');

fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures ? `\n${failures} failure(s)` : '\n✓ release-reconcile: all assertions passed');
process.exit(failures ? 1 : 0);
