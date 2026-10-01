// The hook-lane harness (1.86) — the first measurement of the retrieval every
// Claude Code session receives on every prompt. Locks:
//
//   HL1  build-hook-eval-set turns a sidecar into two strata: capture-pair
//        (gate passed, live gold found) and no-inject (gate failed), skipping
//        orphans whose card is gone, with a receipt naming brain + sidecar.
//   HL2  eval-hook-lane runs the SAME lane sequence the hook runs (1.87
//        unified policy) — status digest, token derivation, then the WORDS
//        lane (rankHookWords at HOOK_WORDS_BAR; lexical mode has no model, the
//        hook's exact no-model degradation) — through the production exports,
//        and reports per-stratum recall / injection with strict and twin-aware
//        golds. Bars are read from the engine, never restated by the harness.
//   HL3  receipts: inputs hashed, prompt text omitted by default, output must
//        be a new file, a changed input is refused.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypix, parseKlypix, HOOK_WORDS_BAR, HOOK_MODEL_MIN_TOKENS, HOOK_FUSED_SHOW_BAR } from '../src/klypix-format.mjs';
import { enrichmentFileFor, enrichmentKeyFor } from '../src/enrichment.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(here, '..');
const run = (script, args) => spawnSync(process.execPath, [path.join(engine, 'scripts', script), ...args], { encoding: 'utf8' });
const lastJson = (stdout) => JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop());

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-hook-lane-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-hook-lane-proj-'));
try {
  const panBody = 'Pan = dedicated hand tool in toolbar (H, next to Select, Space+drag kept); Zoom = −/+ steppers added to the status-bar % cluster';
  const authBody = 'Token refresh happens only at app start, never on a timer, so a long session can expire silently';
  const goneBody = 'A decision whose card was later deleted so its sidecar entry is an orphan for the builder';
  const built = await buildKlypix({ title: 'hook-lane fixture', cards: [
    { text: `Canvas UX: 🏁 ${panBody}\n#canvas-ux #file-toolbar`, area: 'Canvas UX' },
    { text: `Canvas UX: 🏁 ${panBody}\n#canvas-ux #file-toolbar`, area: 'Canvas UX' },   // a text twin, as merge twins are
    { text: `Auth: ${authBody}\n#auth`, area: 'Auth' },
    { text: 'Release: 🏁 v1.3.162 published and live at 100% rollout\n#release', area: 'Release' },
  ] });
  const brain = path.join(project, 'brain.klypix');
  fs.writeFileSync(brain, Buffer.from(built.buffer ?? built));
  const { struct } = await parseKlypix(fs.readFileSync(brain));
  const panIds = struct.cards.filter((card) => String(card.text).includes('dedicated hand tool')).map((card) => card.id);
  const authId = struct.cards.find((card) => String(card.text).includes('Token refresh')).id;
  ok(panIds.length === 2, 'fixture: the pan decision exists as two text twins');

  // A legacy (pre-gate) sidecar with real prompts, an acknowledgement, a
  // console echo, and an orphaned body.
  const sidecar = enrichmentFileFor(brain, home);
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(sidecar, JSON.stringify({ v: 1, entries: {
    [enrichmentKeyFor(panBody)]: { q: ['where did the pan hand tool and the zoom steppers end up in the toolbar?', 'ok do them'], ts: now },
    [enrichmentKeyFor(authBody)]: { q: ['what is remaining?', 'why does a long session expire without any refresh of the token?'], ts: now },
    [enrichmentKeyFor(goneBody)]: { q: ['why was the orphaned decision made in the first place and by whom?'], ts: now },
    [enrichmentKeyFor('a body that only ever had console output recorded against it, long enough to key')]: { q: ['> klypix@1.3.127 release:register ✔ releases row registered'], ts: now },
  } }));

  // ── HL1 — the builder ─────────────────────────────────────────────────
  const setFile = path.join(project, 'hook-prompts.json');
  const b = run('build-hook-eval-set.mjs', ['--brain', brain, '--out', setFile, '--engine', engine, '--home', home]);
  ok(b.status === 0, `HL1: builder exits 0 (${(b.stderr || '').trim().slice(0, 200)})`);
  const bj = lastJson(b.stdout);
  // "what is remaining?" is a status question: no card-specific vocabulary, so
  // the gate files it under no-inject — the hook answers those from the
  // computed digest, never from a card.
  ok(bj.capturePair === 2 && bj.noInject === 3 && bj.orphan === 1, `HL1: 2 capture-pairs, 3 no-inject, 1 orphan (${JSON.stringify(bj)})`);
  const set = JSON.parse(fs.readFileSync(setFile, 'utf8'));
  ok(set.tier === 'hook-lane-capture-pair' && typeof set.brainSha256 === 'string' && typeof set.sidecarSha256 === 'string', 'HL1: the set carries brain + sidecar receipts');
  const panQ = set.questions.find((q) => /pan hand tool/.test(q.q));
  ok(panQ && panQ.strategy === 'capture-pair' && panQ.goldIds.length === 2 && panQ.goldIds.every((id) => panIds.includes(id)),
    'HL1: a capture-pair lists EVERY live card carrying the body (both twins) as gold');
  ok(set.questions.some((q) => q.strategy === 'no-inject' && q.reason === 'low-content' && q.q === 'ok do them'), 'HL1: the acknowledgement lands in no-inject with its reason');
  ok(set.questions.some((q) => q.strategy === 'no-inject' && q.reason === 'console'), 'HL1: the console echo lands in no-inject');
  ok(!set.questions.some((q) => /orphaned decision/.test(q.q)), 'HL1: an orphan (card gone) is skipped, never a gold-less capture-pair');
  ok(/never bundle or publish/i.test(set.limitations), 'HL1: the set says it is private');
  const again = run('build-hook-eval-set.mjs', ['--brain', brain, '--out', setFile, '--engine', engine, '--home', home]);
  ok(again.status !== 0, 'HL1: the builder refuses to overwrite an existing set');

  // ── HL2 — the lane sequence, lexical mode ─────────────────────────────
  const outFile = path.join(project, 'hook-lane.json');
  const e = run('eval-hook-lane.mjs', ['--brain', brain, '--prompts', setFile, '--out', outFile, '--engine', engine, '--mode', 'lexical', '--sweep']);
  ok(e.status === 0, `HL2: eval exits 0 (${(e.stderr || '').trim().slice(0, 300)})`);
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const rowFor = (needle) => report.rows.find((row) => set.questions[row.index] && new RegExp(needle).test(set.questions[row.index].q));
  const pan = rowFor('pan hand tool');
  ok(pan && pan.lane === 'words-shown' && pan.rankStrict === 1 && pan.injected >= 1,
    `HL2: a prompt sharing title/body words with its card is a words-lane show at rank 1 (${JSON.stringify({ lane: pan?.lane, rank: pan?.rankStrict })})`);
  const status = rowFor('what is remaining');
  ok(status && status.lane === 'status-digest' && status.injected === 0, 'HL2: a strong status question takes the digest lane and injects no cards — as the hook does');
  const ack = rowFor('^ok do them$');
  ok(ack && ack.injected === 0, `HL2: the acknowledgement injects nothing in lexical mode (lane ${ack?.lane})`);
  const authRow = rowFor('long session expire');
  ok(authRow && authRow.strategy === 'capture-pair' && authRow.twinGold.includes(authId), 'HL2: gold sets are recorded per row (strict and twin-aware)');
  ok(report.summary.capturePair.n === 2 && report.summary.noInject.n === 3, `HL2: strata counted (${report.summary.capturePair.n}/${report.summary.noInject.n})`);
  ok(report.summary.capturePair.systemRecallAt5.strict >= 33 && report.summary.capturePair.systemRecallAt5.twinAware >= report.summary.capturePair.systemRecallAt5.strict,
    `HL2: system recall@5 is reported strict and twin-aware (${JSON.stringify(report.summary.capturePair.systemRecallAt5)})`);
  // The console echo carries one rare title word ("release"). In a TINY brain
  // (N=4) a single rare title word is worth TITLE_BOOST in near-unit idf, so
  // evidence (2.2) clears the 1.8 bar and the Release card shows — a known
  // small-N property of the rarity units; on the real brain "release" is
  // common and worth far less. The sweep shows the bar dependence: at +0.6
  // over shipping the same row goes silent.
  const echo = rowFor('release:register');
  ok(echo && echo.lane === 'words-shown' && echo.wordsEvidence >= HOOK_WORDS_BAR && echo.wordsEvidence < HOOK_WORDS_BAR + 0.6,
    `HL2: one rare title word clears the bar at N=4 (evidence ${echo?.wordsEvidence}) and the sweep records the bar that silences it`);
  const highBar = report.summary.wordsBarSweep.table.find((r) => r.bar > echo.wordsEvidence);
  ok(highBar && highBar.noInjectZeroRate === 100 && report.summary.wordsBarSweep.table.some((r) => r.shipping),
    `HL2: the words-bar sweep brackets the shipping bar and shows the echo silenced above its evidence (${JSON.stringify(highBar)})`);
  ok(report.configuration.words.evidenceBar === HOOK_WORDS_BAR && report.configuration.model.minUniqueContentTokens === HOOK_MODEL_MIN_TOKENS
    && report.configuration.model.showBar === HOOK_FUSED_SHOW_BAR,
    'HL2: the configuration carries the engine\'s measured bars, not restated constants');
  ok(report.summary.noInject.zeroInjectedRate === 67, `HL2: no-inject zero rate reflects the echo's small-N show (${report.summary.noInject.zeroInjectedRate}%)`);
  ok(report.configuration.words.ranker === 'rankHookWords' && report.configuration.model.ranker === 'rankHookFused',
    'HL2: the configuration names the production rankers');

  // ── HL3 — receipts and refusals ───────────────────────────────────────
  ok(report.inputs.brainSha256 && report.inputs.promptsSha256 && report.inputs.enrichment.used === false && /leak/i.test(report.inputs.enrichment.reason),
    'HL3: inputs are hashed and the enrichment-free space is declared with its reason');
  ok(!report.rows.some((row) => 'q' in row), 'HL3: private prompt text is omitted from the report by default');
  ok(report.configuration.sourceHashes['klypix-format.mjs'] && report.configuration.sourceHashes['brain-semantic.mjs'], 'HL3: engine source files are fingerprinted');
  const dup = run('eval-hook-lane.mjs', ['--brain', brain, '--prompts', setFile, '--out', outFile, '--engine', engine]);
  ok(dup.status !== 0, 'HL3: an existing output file is refused');
  const withText = run('eval-hook-lane.mjs', ['--brain', brain, '--prompts', setFile, '--out', path.join(project, 'with-text.json'), '--engine', engine, '--include-text']);
  ok(withText.status === 0 && JSON.parse(fs.readFileSync(path.join(project, 'with-text.json'), 'utf8')).rows.some((row) => typeof row.q === 'string'),
    'HL3: --include-text opts the prompt text back in for failure analysis');

  if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
  console.log('\n✓ eval-hook-lane: all assertions passed');
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
  try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* temp */ }
}
