// Crowd safeguards — evidence lineage, independent first pass, preserved
// dissent. Every KLYPIX file of this test lives in a throwaway home: HOME,
// USERPROFILE and KLYPIX_BRAIN_DIR are pointed there BEFORE any module loads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-crowd-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.KLYPIX_BRAIN_DIR = path.join(home, '.claude', 'project-brain');
process.env.KLYPIX_AUTO_UPDATE = '0';
delete process.env.KLYPIX_PLUGIN;

const { buildKlypixMap, parseKlypix } = await import('../src/klypix-format.mjs');
const { opBrainNote, opBrainAsk, opBrainTaskContext } = await import('../src/klypix-core.mjs');
const C = await import('../src/crowd-safeguards.mjs');
const { opBrainReview, crowdSyncText, withHitLineage } = await import('../src/crowd-review.mjs');

let n = 0;
const check = (cond, label) => { assert.ok(cond, label); n++; console.log(`✓ ${label}`); };
const brain = path.join(project, 'brain.klypix');
const git = (...a) => execFileSync('git', a, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const note = (args) => opBrainNote({ vault: project, canvas: brain, via: 'test', ...args });
const read = async () => (await parseKlypix(fs.readFileSync(brain))).struct;
const live = (s) => s.cards.filter((c) => c.type !== 'container' && !/^archive$/i.test(c.area || ''));
const textOf = (r) => r.blocks.map((b) => b.text).join('\n');

try {
  // ── normalizeCrowdNote / parseLineage (pure) ────────────────────────────
  const n1 = C.normalizeCrowdNote('Objection: caching per user leaks data across tenants\nsource: docs/tenancy.md\nrechecked: read src/cache.ts at HEAD', { date: '2026-10-30' });
  check(n1.kind === 'objection' && n1.text.startsWith('⚖️ OBJECTION: caching'), 'an "Objection:" lead becomes a ⚖️ OBJECTION card');
  check(/↳ source: docs\/tenancy\.md/.test(n1.text) && /✔ re-checked 2026-10-30: read src\/cache\.ts at HEAD/.test(n1.text), 'trailing source:/rechecked: lines become lineage lines');
  const p1 = C.parseLineage('Area: claim text that is long enough\n↳ source: commit abc123\n↳ restates: Earlier\ncard title\n✔ re-checked 2026-10-30: ran the\ntests\n#area');
  check(p1.sources[0] === 'commit abc123' && p1.restates[0] === 'Earlier card title' && p1.rechecks[0].what === 'ran the tests' && p1.rechecks[0].date === '2026-10-30', 'lineage lines are read back even when the stored card is hard-wrapped');
  check(C.normalizeCrowdNote('A plain decision about sources: none here').text === 'A plain decision about sources: none here', 'a plain note is untouched');
  check(C.sameClaim('Builds: the release script lives in tools/release.sh and must run from the repo root', 'Reminder — run tools/release.sh from the repo root, it is the release script'), 'two wordings about the same named file are one claim');
  check(!C.sameClaim('Builds: the release script lives in tools/release.sh', 'Builds: tools/release.sh was replaced, use npm run release instead'), 'a card that declares a change is a new claim, not a restatement');
  check(!C.sameClaim('Search: index rebuilds nightly at 02:00 UTC', 'Auth: tokens expire after 30 minutes'), 'unrelated cards are not one claim');

  // ── A real brain: lineage ────────────────────────────────────────────────
  git('init', '-q'); git('config', 'user.name', 'Crowd Test'); git('config', 'user.email', 'crowd@example.test'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(project, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tools', 'release.sh'), 'echo v1\n');
  git('add', '-A'); git('commit', '-qm', 'fixture');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Project', cards: [{ text: 'Project brain started.' }] }] }));
  const old = await opBrainAsk({ vault: project, canvas: brain, question: 'how do we release?' });
  check(!old.isError, 'an old brain with none of the new lines still answers');

  const root = await note({ text: 'The release script lives in tools/release.sh and must run from the repo root, never from tools/.', area: 'Builds', evidence: [{ kind: 'file', ref: 'tools/release.sh' }] });
  check(!root.isError, 'the original claim is captured with its file evidence');
  fs.writeFileSync(path.join(project, 'tools', 'release.sh'), 'echo v2 # rewritten\n');
  await note({ text: 'Reminder from the hotfix: run tools/release.sh from the repo root — that is the release script.', area: 'Ops' });
  await note({ text: 'Release checklist says tools/release.sh, from the root of the repo; confirmed in review.', area: 'Review' });
  let s = await read();
  const rootCard = live(s).find((c) => /never from tools/.test(c.text));
  check(!!rootCard, 'the original card is still live (different areas: no supersede)');
  const lin = C.lineageFor(s, rootCard, { evidenceStatus: () => 'changed' });
  check(lin && lin.statedBy === 3 && lin.restatements.length === 2 && lin.rechecks.length === 0, `one claim stated by 3 cards: 1 original + 2 restatements, 0 re-checks (got ${lin && `${lin.statedBy}/${lin.restatements.length}/${lin.rechecks.length}`})`);
  check(lin.sources.length === 1 && /tools\/release\.sh/.test(lin.sources[0]), 'the one recorded source is the original card\'s evidence');
  const f = C.formatLineage(lin);
  check(/1 recorded source/.test(f) && /2 restatements/.test(f) && /re-checked against code\/evidence 0×/.test(f) && /Repetition is not corroboration/.test(f) && /changed/.test(f), 'the lineage line says "1 source, restated 2×, re-checked 0×" and the source status');

  await note({ text: 'Release: tools/release.sh still runs from the repo root.\nrechecked: read tools/release.sh at HEAD and ran it from the root', area: 'Ops' });
  s = await read();
  const lin2 = C.lineageFor(s, live(s).find((c) => /never from tools/.test(c.text)));
  check(lin2.rechecks.length === 1 && lin2.restatements.length === 2 && /ran it from the root/.test(lin2.rechecks[0].what), 'a re-check is counted apart from the restatements, with what was checked');

  const ask = textOf(await opBrainAsk({ vault: project, canvas: brain, question: 'Where is the release script and where must it run from?' }));
  check(/🧬 Lineage:/.test(ask) && /re-checked against code\/evidence 1×/.test(ask), 'brain_ask shows the claim\'s lineage once');
  check((ask.match(/🧬 Lineage:/g) || []).length === 1, 'the lineage of one claim is printed once, not once per restating card');

  // ── brain_sync: the lineage rides ON the context hits (structuredContent) ─
  // Claude Code shows the model only structuredContent, so a line printed only
  // in the text block never reached the agent (crowd bench round 1). Every
  // restated claim among the hits brain_sync already returns gets its line,
  // whatever the intent's wording and whether or not files were declared.
  s = await read();
  const claimIds = live(s).filter((c) => /tools\/release\.sh/.test(c.text)).map((c) => c.id);
  const unrelated = await crowdSyncText({ brainPath: brain, sessionId: 's-lineage', intent: 'ship it', files: [], hitIds: claimIds });
  const hl = unrelated.hitLineage;
  check(claimIds.every((id) => typeof hl[id] === 'string'), `every hit of a restated claim carries a lineage entry with an unrelated intent and no files (${Object.keys(hl).length}/${claimIds.length})`);
  check(/🧬 Lineage:/.test(hl[claimIds[0]]) && /Repetition is not corroboration/.test(hl[claimIds[0]]), 'the first hit of the claim carries the whole lineage line');
  check(claimIds.slice(1).every((id) => /^🧬 Same claim as /.test(hl[id]) && hl[id].length < 200), 'the claim\'s other hits carry a short pointer, so the claim is said once');
  check(Object.values(hl).filter((v) => /🧬 Lineage:/.test(v)).length === 1, 'one claim, one full lineage line across the hits');
  check(/re-checked it/.test(Object.values(hl).join('\n')), 'the re-checking card is labelled as the re-check, not as a restatement');
  check(unrelated.data?.lineage?.[0]?.line === hl[claimIds[0]], 'crowd.lineage[] carries the same line as data, for structured-only hosts');
  const ctx = withHitLineage({ mode: 'x', hits: claimIds.map((id) => ({ id, area: 'A', text: 't', score: 1 })) }, hl);
  check(ctx.hits.every((h) => h.lineage === hl[h.id]) && Object.keys(ctx.hits[0]).indexOf('lineage') === Object.keys(ctx.hits[0]).indexOf('text') + 1, 'withHitLineage puts the line on each hit right after its text');
  const untouched = { mode: 'x', hits: [{ id: 'nope', text: 't' }] };
  check(withHitLineage(untouched, {}) === untouched, 'no lineage: the context object is returned unchanged');
  const none = await crowdSyncText({ brainPath: brain, sessionId: 's-lineage', intent: 'ship it', files: [], hitIds: [] });
  check(!none.data?.lineage && !Object.keys(none.hitLineage).length, 'no hits and no matching words or files: no lineage (bounded to what sync already returns)');
  check(C.SYNC_LINEAGE_MAX === 5, 'at most 5 claim lineages per brain_sync');

  // ── Preserved dissent ───────────────────────────────────────────────────
  const obj = await note({ text: 'Objection: do not cache /api/profile responses for an hour — profile edits would not show for up to an hour and support tickets will follow.', area: 'Caching' });
  check(!obj.isError, 'an objection is captured');
  // Later sessions agree with the position the objection argues against.
  await note({ text: 'Cache /api/profile responses for an hour; the profile endpoint is hot and an hour of caching is fine for profile responses.', area: 'Caching' });
  await note({ text: 'Agreed: cache /api/profile responses for one hour — profile endpoint caching approved.', area: 'Caching' });
  s = await read();
  const objs = C.openObjections(s, { topic: 'add caching to the /api/profile endpoint' });
  check(objs.length === 1 && objs[0].laterAgreeing >= 1, `brain_sync-style lookup surfaces it with the later agreeing cards counted (${objs[0]?.laterAgreeing})`);
  check(/Agreement is not a resolution/.test(C.formatObjections(objs)), 'the objection block says a later majority does not close it');
  await note({ text: '/api/profile responses cached for an hour', area: 'Caching', marker: '✓' });
  s = await read();
  const stillOpen = s.cards.filter(C.isOpenObjection);
  check(stillOpen.length === 1, 'the objection is still open after three later agreeing cards and a fuzzy ✓ that shares its words');
  const askObj = textOf(await opBrainAsk({ vault: project, canvas: brain, question: 'Should we cache the /api/profile endpoint responses?' }));
  check(/⚖️ Open objection/.test(askObj), 'brain_ask carries the open objection');
  const sync = await crowdSyncText({ brainPath: brain, sessionId: 's-plain', intent: 'cache /api/profile responses', files: [] });
  check(/⚖️ Open objection/.test(sync.text) && sync.data?.objections?.length === 1, 'the brain_sync crowd block carries the open objection');
  check(/closes:/.test(sync.data?.objectionsNote || ''), 'crowd.objectionsNote carries how to answer an objection, for structured-only hosts');
  // A decision that LINKS the objection closes it.
  const objTitle = stillOpen[0].text.replace(/^[^:\n]{1,40}:\s*/u, '').split('\n')[0].slice(0, 70);
  const closed = await note({ text: 'Profile responses: cache for 60 s and purge on edit, so edits show at once.', area: 'Caching', closes: objTitle, evidence: [{ kind: 'pr', ref: 'PR#12' }] });
  check(!closed.isError, 'a decision with closes: and evidence is captured');
  s = await read();
  check(s.cards.filter(C.isOpenObjection).length === 0, 'a recorded decision that links the objection closes it');

  // ── Independent first pass ──────────────────────────────────────────────
  await note({ text: 'Assessment: the queue retry design is sound; keep max 5 attempts in lib/queue.js.', area: 'Review' });
  await note({ text: 'Objection: queue retry design in lib/queue.js retries poison messages forever after a crash.', area: 'Review' });
  await note({ text: 'Queue retry design: lib/queue.js uses max 5 attempts with jitter.', area: 'Queue' });
  const sid = 'session-independent';
  const start = await opBrainReview({ vault: project, canvas: brain, action: 'start', topic: 'queue retry design in lib/queue.js', sessionId: sid });
  check(!start.isError && start.structured.withheld === 2, `start withholds the 2 peer opinions on the topic (got ${start.structured?.withheld})`);
  check(/does not enforce/.test(textOf(start)), 'start states the honest limit: KLYPIX controls only what it returns');
  const during = textOf(await opBrainAsk({ vault: project, canvas: brain, question: 'what do we know about the queue retry design in lib/queue.js?', sessionId: sid }));
  check(!/sound; keep max 5/.test(during) && !/poison messages/.test(during), 'brain_ask leaves the peer assessment and objection out during the pass');
  check(/max 5 attempts with jitter/.test(during), 'the plain decision (a fact) stays visible during the pass');
  check(/withheld/.test(during), 'brain_ask says how many cards it withheld');
  const tc = await opBrainTaskContext({ vault: project, canvas: brain, intent: 'review the queue retry design in lib/queue.js', cardFilter: C.withholdFilter(brain, sid) });
  check(!JSON.stringify(tc.context.hits).includes('poison'), 'brain_sync\'s task context leaves the objection out during the pass');
  const syncHeld = await crowdSyncText({ brainPath: brain, sessionId: sid, intent: 'review the queue retry design in lib/queue.js' });
  check(/Independent first pass open/.test(syncHeld.text) && !/poison/.test(syncHeld.text), 'the brain_sync crowd block announces the pass and shows no withheld text');
  const other = textOf(await opBrainAsk({ vault: project, canvas: brain, question: 'what do we know about the queue retry design in lib/queue.js?', sessionId: 'someone-else' }));
  check(/poison messages/.test(other), 'another session without a pass still sees everything');
  const sub = await opBrainReview({ vault: project, canvas: brain, action: 'submit', assessment: 'Queue retry design in lib/queue.js: 5 attempts is fine but there is no dead-letter path; add one.', sessionId: sid });
  check(!sub.isError && sub.structured.peers.length === 2, 'submit records the assessment and reveals the 2 peer opinions');
  s = await read();
  check(live(s).filter(C.isAssessmentCard).length === 2, 'two sessions\' assessments on one topic are two cards (neither supersedes the other)');
  const after = textOf(await opBrainAsk({ vault: project, canvas: brain, question: 'what do we know about the queue retry design in lib/queue.js?', sessionId: sid }));
  check(/poison messages/.test(after), 'after submitting, the session sees peer opinions again');
  const status = await opBrainReview({ vault: project, canvas: brain, action: 'status', sessionId: sid });
  check(status.structured.open === false, 'status reports the pass finished');

  // ── Sandbox check: nothing was written outside the throwaway home ───────
  check(fs.existsSync(path.join(home, '.claude', 'project-brain', 'crowd')), 'review state lives under the sandboxed KLYPIX_BRAIN_DIR');
  console.log(`\ncrowd-safeguards: ${n} checks passed`);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* */ }
}
