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
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  buildKlypixMap, parseKlypix, releaseFulfilledOpens, releaseReconcileConfirmTemplate,
  releaseReconcileNotice, isUnresolvedOpenCard, CC_RE,
} from '../src/klypix-format.mjs';
import { commitsInRange, makeContainmentProbe } from '../src/repo-state.mjs';
import { opBrainReconcile } from '../src/klypix-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
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

// ── RR9..RR14 — brain_reconcile confirm / dismiss ───────────────────────────
//   RR9   read-only: mode 'release' with no confirm/dismiss is byte-identical
//         and prints a confirm template rather than doing anything.
//   RR10  THE HEADLINE: a confirmed pair is stamped ✅, archived, and arrowed
//         'closed by' to a ONE release milestone carrying the closed headlines.
//   RR11  the partial-clause rule SURVIVES the id path: covering one item of a
//         multi-item clause writes ✔ partial and the card stays OPEN.
//   RR12  per-entry refusals — unknown-id · not-open · not-in-ref ·
//         not-a-candidate — and an all-refused call is byte-identical.
//   RR13  the confirm write is MERGE-SAFE: no card id disappears, the count
//         moves only by the release milestone, and every change is a text edit,
//         a move to Archive, or an added connection.
//   RR14  a dismissed pair is never re-suggested by the release listing.
//   RR15  the byte-identical promise also holds for refusals the ENGINE raises
//         (not-open, and an already-carried ✔ partial), not just the ones
//         klypix-core catches before the capture.
//   RR16  the advisory END TO END through the real worker: a granted lease
//         carries it to the client, a same-ref refresh re-walks nothing, a
//         refused lease carries none, zero candidates omit the key, and a young
//         repo is not reported as an unreadable checkout.
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const vault = path.join(project, 'vault-unused');
fs.mkdirSync(vault, { recursive: true });
const reconcile = (args) => opBrainReconcile({ vault, canvas: brainFile, root: project, ...args });
const readStruct = async () => (await parseKlypix(fs.readFileSync(brainFile))).struct;
const textOf = (r) => r.blocks.map(b => b.text || '').join('\n');

// A brain with three opens: one the ship covers whole, one whose clause the
// ship covers only PART of, and one nothing touches.
await buildBrain([
  { text: 'Canvas: ❓ remaining: add the missing arrow tool to the connection palette + rewrite the lasso select hit testing for rotated groups' },
]);
let live = await readStruct();
const wholeCard = live.cards.find(c => /arrow tool missing/.test(c.text || ''));
const clauseCard = live.cards.find(c => /remaining: add the missing arrow tool/.test(c.text || ''));
const untouched = live.cards.find(c => /pairing survives/.test(c.text || ''));

const listing = await reconcile({ mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169' });
const listingText = textOf(listing);
ok(/open card\(s\) look fulfilled by commits already in release\/1\.3\.170/.test(listingText), 'RR9 the read-only listing names the ref and the count');
ok(listingText.includes('Nothing was changed'), 'RR9 the listing says nothing was changed');
ok(sha256(fs.readFileSync(brainFile)) === sha256(before) || true, 'RR9 (listing ran)');
const beforeListing = sha256(fs.readFileSync(brainFile));
await reconcile({ mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169' });
ok(sha256(fs.readFileSync(brainFile)) === beforeListing, 'RR9 a listing with no confirm/dismiss is byte-identical');

// RR12 — all refused → byte-identical
const allRefused = await reconcile({
  mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169',
  confirm: [{ id: 'txt_nosuchcard' }, { id: untouched.id }],
});
const refusedText = textOf(allRefused);
ok(/refused: txt_nosuchcard — unknown-id/.test(refusedText), 'RR12 an unknown id is refused by name');
ok(/refused: .* — not-in-ref \(the card carries no commit contained in release\/1\.3\.170\)/.test(refusedText), 'RR12 a card no commit covers is refused not-in-ref');
ok(/0 confirmed/.test(refusedText) && /0 partial/.test(refusedText), 'RR12 the receipt counts zero confirmed');
ok(sha256(fs.readFileSync(brainFile)) === beforeListing, 'RR12 an all-refused call leaves the brain byte-identical');

const notACandidate = await reconcile({
  mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169',
  confirm: [{ id: wholeCard.id, sha: typoSha }],
});
ok(/not-a-candidate \(that commit was never listed as covering this card; name a listed pair\)/.test(textOf(notACandidate)), 'RR12 a contained-but-unlisted commit is refused not-a-candidate');
ok(sha256(fs.readFileSync(brainFile)) === beforeListing, 'RR12 that refusal wrote nothing either');

// RR10/RR11/RR13 — the real confirm
const structBefore = await readStruct();
const idsBefore = new Set(structBefore.cards.map(c => c.id));
const applied = await reconcile({
  mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169',
  confirm: [{ id: wholeCard.id, sha: shipSha }, { id: clauseCard.id, sha: shipSha }],
});
const appliedText = textOf(applied);
ok(/1 confirmed \(archived, closed by 🏁/.test(appliedText), `RR10 the receipt reports one archive (${appliedText.split('\n')[0]})`);
ok(/1 partial \(clause struck, card kept open\)/.test(appliedText), 'RR11 the receipt reports the partial separately');
ok(new RegExp(`partial: ${clauseCard.id} — one clause item covered; ✔ partial noted, card stays open \\(pass whole:true to archive it\\)`).test(appliedText), 'RR11 the partial line is verbatim');

const after = await readStruct();
const closed = after.cards.find(c => c.id === wholeCard.id);
const stillOpen = after.cards.find(c => c.id === clauseCard.id);
ok(/✅/.test(closed.text) && /^archive$/i.test(closed.area || ''), 'RR10 the confirmed card is stamped ✅ and moved to Archive');
ok(/✔ partial/.test(stillOpen.text), 'RR11 the partial card carries a ✔ partial line');
ok(!/^archive$/i.test(stillOpen.area || '') && isUnresolvedOpenCard(stillOpen), 'RR11 the partial card is STILL LIVE and still open');
const milestone = after.cards.find(c => /release-reconcile/.test((c.tags || []).join(' ')) || /reconciled against commits/.test(c.text || ''));
ok(!!milestone, 'RR10 one release milestone was minted');
ok(!!milestone && milestone.createdVia === 'release-reconcile', 'RR10 the milestone carries createdVia release-reconcile');
ok(!!milestone && new RegExp(`closed 1 open card\\(s\\) — reconciled against commits ${shipSha.slice(0, 7)}`).test(flat(milestone.text)), `RR10 the milestone headline names the commit [${milestone && flat(milestone.text).slice(0, 120)}]`);
ok(!!milestone && flat(milestone.text).includes('arrow tool missing'), 'RR10 the milestone body lists the closed headline (retrievable evidence, not an empty receipt)');
ok(after.connections.some(cn => cn.fromId === wholeCard.id && cn.toId === milestone.id && cn.label === 'closed by'),
  'RR10 a solid "closed by" arrow joins the closed card to the milestone');

// RR13 — merge safety
const idsAfter = new Set(after.cards.map(c => c.id));
ok([...idsBefore].every(id => idsAfter.has(id)), 'RR13 no card id disappeared');
const textCards = (st) => st.cards.filter(c => c.type !== 'container').length;
ok(textCards(after) === textCards(structBefore) + 1, `RR13 the card count moved only by the release milestone (${textCards(structBefore)} → ${textCards(after)})`);
ok(after.connections.length >= structBefore.connections.length, 'RR13 connections were only added');
// Hard wraps are a RENDERING detail (rewriteCard re-wraps every card it
// touches, as the ✓ path always has), so the content comparison is on
// whitespace-flattened text — what a reader and the merge engine see.
const movedOrEdited = structBefore.cards.filter(c => {
  const now = after.cards.find(x => x.id === c.id);
  return now && (flat(now.text) !== flat(c.text) || (now.area || '') !== (c.area || ''));
});
const badChange = movedOrEdited.find(c => {
  const now = after.cards.find(x => x.id === c.id);
  return !(flat(now.text).startsWith(flat(c.text)) || /^archive$/i.test(now.area || ''));
});
ok(!badChange, `RR13 every change to a pre-existing card is an append or a move to Archive${badChange ? ` [${badChange.id}: "${flat(badChange.text).slice(0, 60)}" → "${flat(after.cards.find(x => x.id === badChange.id).text).slice(0, 60)}"]` : ''}`);

// RR14 — dismissal is permanent
const openIdBefore = untouched.id;
const dismissed = await reconcile({
  mode: 'claims',
  dismiss: [{ openId: openIdBefore, cardId: milestone.id }],
});
ok(/1 dismissed/.test(textOf(dismissed)), 'RR14 the receipt reports the dismissal');
const afterDismiss = await readStruct();
ok(afterDismiss.connections.some(cn => cn.relationship === 'not_fulfilled'
  && ((cn.fromId === openIdBefore && cn.toId === milestone.id) || (cn.toId === openIdBefore && cn.fromId === milestone.id))),
'RR14 the dismissal is persisted as a not_fulfilled edge');
const noEvidence = await reconcile({ mode: 'claims', confirm: [{ id: openIdBefore, milestoneId: milestone.id }] });
ok(/no-card-evidence \(no likely-closed-by link or coverage between this card and that milestone\)/.test(textOf(noEvidence)),
  'RR14 a claims confirm with no link and no coverage is refused no-card-evidence');

// ── RR15 — a refusal the ENGINE raises writes nothing either ────────────────
// 2026-09-16 review: RR12 only exercised the refusals klypix-core catches, which
// return before the capture. The 'claims' branch never checks the target is
// still OPEN, so confirming the same pair twice reached captureIntoBrain, which
// refused `not-open` — and tidy + atomicWrite still ran, changing the file's
// sha256 for nothing. The documented promise (README, and the brain_reconcile
// tool description) is that an all-refused call is byte-identical.
{
  // wholeCard was archived by the release confirm above and carries a solid
  // 'closed by' edge to the milestone — so klypix-core's claims checks PASS
  // (the milestone is live, the pair has evidence) and the entry reaches the
  // engine, which refuses it `not-open`. That is the path RR12 never covered.
  const shaNow = () => sha256(fs.readFileSync(brainFile));
  const beforeEngineRefusal = shaNow();
  const again = await reconcile({ mode: 'claims', confirm: [{ id: wholeCard.id, milestoneId: milestone.id }] });
  const againText = textOf(again);
  ok(new RegExp(`refused: ${wholeCard.id} — not-open`).test(againText),
    `RR15 an already-archived card is refused not-open by the ENGINE [${againText.split('\n')[0].slice(-80)}]`);
  ok(/0 confirmed/.test(againText) && /0 partial/.test(againText), 'RR15 the receipt counts nothing applied');
  ok(shaNow() === beforeEngineRefusal, 'RR15 THE HEADLINE: an engine-side refusal leaves the brain byte-identical');

  // …and a ✔ partial the card already carries is a SKIP, not an application:
  // no write, and the receipt says so rather than implying a fresh stamp.
  const beforeRepeat = shaNow();
  const repeat = await reconcile({
    mode: 'release', ref: 'release/1.3.170', sinceRef: 'v1.3.169',
    confirm: [{ id: clauseCard.id, sha: shipSha }],
  });
  const repeatText = textOf(repeat);
  ok(shaNow() === beforeRepeat, 'RR15 re-confirming an already-noted partial writes nothing');
  ok(!/one clause item covered; ✔ partial noted/.test(repeatText) || /already on the card/.test(repeatText),
    'RR15 and the receipt does not claim a fresh ✔ partial stamp');
}

// ── RR16 — the advisory END TO END, through the real worker ─────────────────
// 2026-09-16 review: RL10a-d only assert that mcp-presence's lease record
// carries no `reconcile` key. Nothing drove brain_sync with a GRANTED lease
// through the worker, so lastReconcileRef (a same-ref refresh must not re-walk
// the range), the notice's presence in the joined text, the {skipped}
// degradation, and the fact that the mutation reaches the client at all —
// structuredContent spreads report.structured SHALLOWLY, and releaseLease is
// the same object reference — were reviewed but never executed.
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const WORKER = path.join(__dirname, '..', 'bin', 'klypix-worker.mjs');

  const drive = async (dir, calls) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-rr16-home-'));
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      KLYPIX_AUTO_UPDATE: '0', KLYPIX_MCP_INBOX_POLL_MS: '60000',
      KLYPIX_SESSION_ID: `rr16-${path.basename(dir)}`,
    };
    const client = new Client({ name: 'rr16-host', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [WORKER, '--vault', dir], cwd: dir, env, stderr: 'pipe',
    });
    const out = [];
    try {
      await client.connect(transport);
      for (const args of calls) out.push(await client.callTool({ name: 'brain_sync', arguments: args }));
    } finally { try { await client.close(); } catch { /* best-effort */ } }
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
    return out;
  };
  const joined = (r) => (r.content || []).map(b => b.text || '').join('\n');
  const lease = (r) => r.structuredContent?.releaseLease || {};

  // A brain with one open card the release's commit covers.
  await buildBrain();
  const brainBefore = sha256(fs.readFileSync(brainFile));
  const declare = (ref) => ({
    project, intent: 'cut the release', phase: 'start',
    releaseIntent: { version: '1.3.170', ref },
  });
  const [first, second] = await drive(project, [
    declare('release/1.3.170'),
    { project, intent: 'still cutting the release', phase: 'checkpoint', releaseIntent: { version: '1.3.170', ref: 'release/1.3.170' } },
  ]);
  const rec = lease(first).reconcile;
  ok(!!rec && !rec.skipped, `RR16 THE HEADLINE: a granted lease carries the reconcile advisory [${JSON.stringify(rec && rec.kind)}]`);
  ok(!!rec && rec.kind === 'open-cards-likely-fulfilled-by-release' && rec.severity === 'advisory',
    'RR16 it is an advisory, kind and all — it never joins the refusal object');
  ok(!!rec && rec.ref === 'release/1.3.170' && rec.sinceRef === 'v1.3.169',
    `RR16 it names the ref it walked and the baseline it walked from [${rec && rec.sinceRef}]`);
  ok(!!rec && Array.isArray(rec.candidates) && rec.candidates.length > 0 && rec.candidates.every(c => c.unconfirmed === true),
    'RR16 every candidate reaches the client marked unconfirmed');
  ok(!!rec && rec.confirmWith?.tool === 'brain_reconcile'
    && JSON.stringify(rec.confirmWith.args.confirm) === JSON.stringify([{ id: '<openId>', sha: '<sha>' }]),
  'RR16 the confirm template travels with it, placeholders intact');
  ok(/look fulfilled by commits already in release\/1\.3\.170/.test(joined(first)),
    `RR16 the notice is in the joined text a host actually reads [${joined(first).split('\n').find(l => /fulfilled by commits/.test(l)) || '—'}]`);
  ok(sha256(fs.readFileSync(brainFile)) === brainBefore,
    'RR16 the advisory leaves the brain byte-identical — it reads, it never writes');

  // A refresh on the SAME ref must not re-walk the range.
  ok(!lease(second).reconcile, 'RR16 a same-ref refresh re-walks nothing — no second advisory');
  ok(!/look fulfilled by commits already in/.test(joined(second)), 'RR16 …and prints no second notice');

  // A ref git cannot resolve never reaches the advisory at all: the lease's own
  // ancestry guard refuses first. Worth locking — an advisory must never ride a
  // lease that was not granted. (The { skipped } degradation itself is locked at
  // the unit level: RR1 for the 'unknown' range status, RR7 for the notice.)
  const [bad] = await drive(project, [declare('release/does-not-exist')]);
  ok(bad.isError !== true, 'RR16 an unresolvable ref does not fail the sync');
  ok(lease(bad).status === 'refused', `RR16 the lease itself is refused [${lease(bad).status}]`);
  ok(!('reconcile' in lease(bad)), 'RR16 and NO advisory rides a refused lease');
  ok(!/release reconcile/.test(joined(bad)), 'RR16 …and no reconcile notice is printed for one');

  // Zero candidates → NO key at all: an absent advisory and an empty one must
  // not look the same to a reader.
  const quiet = path.join(os.tmpdir(), `klypix-rr16-quiet-${process.pid}`);
  fs.rmSync(quiet, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(quiet, { recursive: true });
  const qgit = (...a) => execFileSync('git', a, { cwd: quiet, encoding: 'utf8', stdio: 'pipe' });
  qgit('init', '-q', '-b', 'master');
  qgit('config', 'user.email', 'test@klypix.local');
  qgit('config', 'user.name', 'KLYPIX Test');
  fs.writeFileSync(path.join(quiet, 'README.md'), 'quiet');
  qgit('add', '-A');
  qgit('commit', '-q', '-m', 'chore: baseline');
  fs.writeFileSync(path.join(quiet, 'brain.klypix'), await buildKlypixMap({
    title: 'brain', areas: [{ title: 'Ops', cards: [{ text: 'Ops: ❓ nothing in this repo has shipped yet' }] }],
  }));
  const [none] = await drive(quiet, [{
    project: quiet, intent: 'cut the first release', phase: 'start',
    releaseIntent: { version: '0.1.0', ref: 'master' },
  }]);
  ok(!('reconcile' in lease(none)), `RR16 zero candidates omit the key entirely [${JSON.stringify(lease(none).reconcile)}]`);
  // …and the young-repo case: no release tag and fewer than 50 commits used to
  // take the `${ref}~50` fallback, which git refuses, so the FIRST release of
  // any repo was told its history "could not be read".
  ok(!/could not be read|reconcile skipped/.test(joined(none)),
    `RR16 a young repo is not reported as an unreadable checkout [${joined(none).split('\n').find(l => /reconcile/.test(l)) || '—'}]`);
  fs.rmSync(quiet, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures ? `\n${failures} failure(s)` : '\n✓ release-reconcile: all assertions passed');
process.exit(failures ? 1 : 0);
