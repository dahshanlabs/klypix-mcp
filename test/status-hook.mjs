// Hook E2E for the area-scoped status digest (1.85.0) — through the REAL hooks
// (Claude Code lane AND Codex lane), hermetic: temp HOME + temp project per
// case, no network, no git repo needed.
//
//   H1  the founder prompt "do i need to update the desk ? ios ? or web ?" gets
//       the 📊 computed digest, SCOPED to desktop, iOS, Website — the Brain and
//       Chat/Window opens are NOT in it ('win' never matches 'Chat/Window').
//   H2  the identical repeat in the same session is the one-line
//       'unchanged since' pointer, not another ~5k chars.
//   H3  "anything remaining for the brain" scopes to Brain.
//   H4  an Arabic status question scopes too ("ماذا بقي للديسكتوب؟").
//   H5  coding-question negatives ("update the desktop installer to 1.3.163",
//       "do I need to update the lockfile after adding a dependency?") get NO 📊.
//   H6  the Codex lane renders the SAME '## Open (N) …' header and scope line
//       for the same brain and prompt, dedups the repeat, and stays silent on
//       the negatives — one detector, one renderer, two hosts.
//   H7  ONE honest open count (change 4): the header reads
//       '## Open (4) · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago'
//       and each number is backed by exactly that many flagged bullets; a
//       ⤵-deferred card with a hint edge counts nowhere; area rows fold
//       '(K look done)' in; the first prompt MISSES the summary cache and writes
//       the {mtimeMs, size, summary} record.
//   H8  the second status prompt, the Codex lane and SessionStart all HIT that
//       record (env-gated trace: no detector run) and print the same numbers —
//       heal line, ultra brief header, brief file header, ⏳ section.
//   H9  a corrupt or shape-mismatched cache file is a MISS: the digest still
//       prints, the file is valid JSON afterwards.
//   H10 same mtimeMs, different size ⇒ miss (append-only saves); tmp + rename
//       leaves no temp file behind.
//
// Run:  node test/status-hook.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { buildKlypixMap, parseKlypix, cachedOpenStatusSummary, statusSummaryCachePathFor } from '../src/klypix-format.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(ROOT, 'src', 'codex-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

function fixture(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-status-hook-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-status-hook-proj-'));
  fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
  // throttle the npm-currency refresh so no test makes a network call
  fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.npm-currency.json'),
    JSON.stringify({ pkg: 'klypix-mcp', latest: '1.85.0', checkedAt: Date.now() }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off', ...extraEnv };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const run = (args, input) => execFileSync(process.execPath, [HOOK, ...args], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });
  const runCodex = (input) => {
    const out = execFileSync(process.execPath, [CODEX_HOOK], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ cwd: proj, ...input }) });
    if (!out.trim()) return '';
    try { return JSON.parse(out).systemMessage || ''; } catch { return out; }
  };
  const cleanup = () => { for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } };
  return { home, proj, run, runCodex, cleanup };
}

const openHeader = (s) => (String(s).match(/^## Open \(\d+\).*$/m) || [''])[0];
const scopeLine = (s) => (String(s).match(/^_Scoped to: .*$/m) || [''])[0];

const f = fixture();
try {
  fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'desktop', cards: [{ text: '❓ DESKCARD: the installer still needs the silent relaunch check' }] },
      { title: 'iOS', cards: [{ text: '❓ IOSCARD: pairing must survive an account switch' }] },
      { title: 'Website', cards: [{ text: '❓ WEBCARD: the viewer lacks the compaction notice' }] },
      { title: 'Brain', cards: [{ text: '❓ BRAINCARD: the gardener skips orphan skills' }] },
      { title: 'Chat/Window', cards: [{ text: '❓ WINDOWCARD: overlay maximize bounds drift' }] },
      { title: 'Milestones', cards: [{ text: '🏁 v1.84.0 shipped to npm with provenance.' }] },
    ],
  }));
  const FOUNDER = 'do i need to update the desk ? ios ? or web ?';

  // ── H1 / H2 — Claude lane, founder prompt + repeat ─────────────────────────
  const first = f.run(['--prompt'], { session_id: 'sess-status-1', prompt: FOUNDER });
  ok(/📊 Computed current state/.test(first), 'H1: founder prompt injects the 📊 computed digest');
  ok(/_Scoped to: desktop, iOS, Website \(3 of 6 areas · 3 open\)/.test(first), `H1: digest is scoped to desktop, iOS, Website (${scopeLine(first) || 'no scope line'})`);
  ok(/DESKCARD/.test(first) && /IOSCARD/.test(first) && /WEBCARD/.test(first), 'H1: the three scoped open cards are in the digest');
  ok(!/BRAINCARD/.test(first), 'H1: the Brain open is NOT in the scoped digest');
  ok(!/WINDOWCARD/.test(first), "H1: the Chat/Window open is NOT in it ('win' never matches 'Window')");
  ok(/^## Open \(3\)/m.test(first), `H1: open header counts the scoped opens (${openHeader(first)})`);
  ok(!/## By area/.test(first), 'H1: no duplicate By-area table in the hook digest (budget)');
  const second = f.run(['--prompt'], { session_id: 'sess-status-1', prompt: FOUNDER });
  ok(/📊 Current state — unchanged since the digest shown earlier this session/.test(second), 'H2: identical repeat → one-line pointer');
  ok(!/DESKCARD/.test(second), 'H2: the repeat does not re-inject the cards');

  // ── H3 — a different scope in the same session is a NEW digest ───────────
  const brainOnly = f.run(['--prompt'], { session_id: 'sess-status-1', prompt: 'anything remaining for the brain' });
  ok(/📊 Computed current state/.test(brainOnly) && /_Scoped to: Brain \(1 of 6 areas · 1 open\)/.test(brainOnly), `H3: "anything remaining for the brain" scopes to Brain (${scopeLine(brainOnly) || 'no scope line'})`);
  ok(/BRAINCARD/.test(brainOnly) && !/DESKCARD/.test(brainOnly), 'H3: only the Brain open renders');

  // ── H4 — Arabic status question, clitic-prefixed area ────────────────────
  const arabic = f.run(['--prompt'], { session_id: 'sess-status-ar', prompt: 'ماذا بقي للديسكتوب؟' });
  ok(/📊 Computed current state/.test(arabic) && /_Scoped to: desktop \(1 of 6 areas · 1 open\)/.test(arabic), `H4: Arabic question scopes to desktop (${scopeLine(arabic) || 'no scope line'})`);
  const unscopedAr = f.run(['--prompt'], { session_id: 'sess-status-ar2', prompt: 'ما تبقى' });
  ok(/📊 Computed current state/.test(unscopedAr) && !/Scoped to:/.test(unscopedAr) && /^## Open \(5\)/m.test(unscopedAr), 'H4: "ما تبقى" → whole-brain digest');

  // ── H5 — negatives: no digest ────────────────────────────────────────────
  for (const neg of ['update the desktop installer to 1.3.163', 'do I need to update the lockfile after adding a dependency?', 'should we bump zod to v4?']) {
    const out = f.run(['--prompt'], { session_id: 'sess-status-neg', prompt: neg });
    ok(!/📊/.test(out), `H5: no 📊 digest for "${neg}"`);
  }

  // ── H6 — Codex lane parity ───────────────────────────────────────────────
  const cx1 = f.runCodex({ session_id: 'codex-status-1', hook_event_name: 'UserPromptSubmit', prompt: FOUNDER });
  ok(/📊 Computed current state/.test(cx1), 'H6: Codex lane injects the 📊 computed digest');
  ok(openHeader(cx1) !== '' && openHeader(cx1) === openHeader(first), `H6: Codex header equals the Claude header (${openHeader(cx1)})`);
  ok(scopeLine(cx1) !== '' && scopeLine(cx1) === scopeLine(first), 'H6: Codex scope line equals the Claude scope line');
  ok(/DESKCARD/.test(cx1) && !/BRAINCARD/.test(cx1) && !/WINDOWCARD/.test(cx1), 'H6: Codex digest carries the same scoped cards');
  const cx2 = f.runCodex({ session_id: 'codex-status-1', hook_event_name: 'UserPromptSubmit', prompt: FOUNDER });
  ok(/unchanged since the digest shown earlier this session/.test(cx2) && !/DESKCARD/.test(cx2), 'H6: Codex repeat → one-line pointer');
  for (const neg of ['update the desktop installer to 1.3.163', 'do I need to update the lockfile after adding a dependency?']) {
    const out = f.runCodex({ session_id: 'codex-status-neg', hook_event_name: 'UserPromptSubmit', prompt: neg });
    ok(!/📊/.test(out), `H6: Codex lane — no 📊 digest for "${neg}"`);
  }
} finally {
  f.cleanup();
}

// ── H7–H10 — ONE honest open count (brainCore change 4) ─────────────────────
// A brain whose opens exercise every header part: one open a milestone likely
// closed (persisted hint edge), one overdue, one created >45 d ago, one plain
// — plus a ⤵-deferred card carrying a hint edge (must count NOWHERE) and a
// ✅-stamped one (resolved, not open). Expected everywhere:
//   ## Open (4) · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago
// backdate(): buildKlypixMap stamps every card `now`, so the >45 d card is
// aged by rewriting its item JSON inside the zip (what the desktop would have
// written) — the struct is parsed from the file exactly as the hook sees it.
async function backdate(buf, marker, days) {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files)) {
    if (!/^items\/.*\.json$/.test(name)) continue;
    const item = JSON.parse(await zip.file(name).async('string'));
    if (typeof item.content === 'string' && item.content.includes(marker)) {
      item.createdAt = Date.now() - days * 86_400_000;
      zip.file(name, JSON.stringify(item));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
const HEADER = '## Open (4) · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago';
const BRIEF_HEADER = '## Open questions & goals (4 · 1 look already done · 1 ⏰ overdue · 1 created >45 d ago)';
// The engine appends 'hit'/'miss' to this file on every summary-cache read —
// the env-gated counter that proves the second prompt never ran the detector.
const TRACE = path.join(os.tmpdir(), `klypix-status-trace-${process.pid}.log`);
const g = fixture({ KLYPIX_STATUS_CACHE_TRACE: TRACE });
const traceLines = () => { try { return fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const resetTrace = () => { try { fs.unlinkSync(TRACE); } catch { /* absent */ } };
try {
  const DONE = '❓ DONECARD: the installer still needs the silent relaunch check';
  const SHIP = '🏁 SHIPCARD: installer silent relaunch check landed in the last cut';
  const built = await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'desktop', cards: [{ text: DONE }, { text: SHIP }] },
      { title: 'iOS', cards: [{ text: '❓ LATECARD: rotate the demo pairing key — due by 2020-01-01' }] },
      { title: 'Website', cards: [{ text: '❓ OLDCARD: the viewer lacks the compaction notice' }] },
      { title: 'Brain', cards: [
        { text: '❓ FRESHCARD: the gardener skips orphan skills' },
        { text: '❓ DEFERCARD: ⤵ deferred until after the cut — revisit the lens palette' },
        { text: '❓ SETTLEDCARD: ✅ resolved — the palette question is settled' },
      ] },
    ],
    connections: [
      { from: DONE, to: SHIP, label: 'likely closed by' },
      { from: '❓ DEFERCARD: ⤵ deferred until after the cut — revisit the lens palette', to: SHIP, label: 'likely closed by' },
    ],
  });
  const brainFile = path.join(g.proj, 'brain.klypix');
  fs.writeFileSync(brainFile, await backdate(built, 'OLDCARD', 60));
  const cacheFile = statusSummaryCachePathFor(brainFile, g.home);
  const STATUS_Q = 'what is remaining?';

  // ── H7 — the header, its parts, and the bullets that back each number ────
  resetTrace();
  const s1 = g.run(['--prompt'], { session_id: 'sess-count-1', prompt: STATUS_Q });
  ok(openHeader(s1) === HEADER, `H7: hook digest header is honest (${openHeader(s1) || 'no header'})`);
  const bullets = s1.split('\n').filter(l => /^- \[/.test(l));
  ok(bullets.filter(l => /⏳likely-fulfilled\?/.test(l)).length === 1 && /DONECARD/.test(bullets.find(l => /⏳likely-fulfilled\?/.test(l)) || ''), 'H7: exactly ONE bullet carries ⏳likely-fulfilled? and it is the edge-hinted card (machine hint stays hedged)');
  ok(bullets.filter(l => /⏰OVERDUE/.test(l)).length === 1 && /LATECARD/.test(bullets.find(l => /⏰OVERDUE/.test(l)) || ''), 'H7: exactly ONE bullet carries ⏰OVERDUE and it is the dated card');
  ok(!/DEFERCARD/.test(s1) && !/SETTLEDCARD/.test(s1), 'H7: the ⤵-deferred and ✅-resolved cards are neither listed nor counted (likelyDone ∩ open)');
  ok(/^- desktop — .* · 1 open \(1 look done\) · latest /m.test(s1), 'H7: the desktop area row folds "(1 look done)" into its open count');
  ok(!/## By area/.test(s1), 'H7: still no By-area table in the hook digest (budget)');
  ok(traceLines().includes('miss') && fs.existsSync(cacheFile), 'H7: the first status prompt MISSES the summary cache and writes the record');
  let rec = null; try { rec = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { rec = null; }
  const st = fs.statSync(brainFile);
  ok(!!rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size && Array.isArray(rec.summary?.openIds) && rec.summary.openIds.length === 4, 'H7: the record is keyed on {mtimeMs, size} and carries the 4 open ids');

  // ── H8 — the second status prompt reads the cache (no detector run) ──────
  resetTrace();
  const s2 = g.run(['--prompt'], { session_id: 'sess-count-2', prompt: 'what is left?' });
  ok(openHeader(s2) === HEADER, 'H8: a second status prompt prints the same header');
  ok(traceLines().includes('hit') && !traceLines().includes('miss'), `H8: …and it is a cache HIT — findStaleOpenCards did not run (${traceLines().join(',') || 'no trace'})`);
  // Codex lane: same brain, same record, same numbers.
  resetTrace();
  const cx = g.runCodex({ session_id: 'codex-count-1', hook_event_name: 'UserPromptSubmit', prompt: STATUS_Q });
  ok(openHeader(cx) === HEADER, `H8: the Codex lane prints the identical header (${openHeader(cx) || 'no header'})`);
  ok(traceLines().includes('hit') && !traceLines().includes('miss'), 'H8: the Codex lane read the SAME cache record (hit, no miss)');
  ok(/^- desktop — .* · 1 open \(1 look done\) · latest /m.test(cx), 'H8: Codex area row carries the same "(1 look done)"');
  // SessionStart: heal line and both brief tiers quote the same numbers.
  resetTrace();
  const ss = g.run([], { session_id: 'sess-count-start' });
  ok(/🔧 Self-heal: 1 open card\(s\) look already done \(the same 1 counted in the status header\)/.test(ss), 'H8: SessionStart heal line quotes the header\'s look-already-done count');
  ok(ss.includes(BRIEF_HEADER), `H8: the ultra brief header carries the same parts (${(ss.match(/^## Open questions & goals .*$/m) || ['no header'])[0]})`);
  let briefFile = ''; try { briefFile = fs.readFileSync(path.join(g.proj, '.claude', 'brain-brief.md'), 'utf8'); } catch { briefFile = ''; }
  ok(briefFile.includes(BRIEF_HEADER), 'H8: the full brief file carries the same header');
  // Section-scoped: the deferred card legitimately appears elsewhere in the
  // brief (a ⤵ is a recent decision), so the negative must not scan past
  // the ⏳ section's own bullets.
  const likelySec = briefFile.split(/^## /m).find(s => s.startsWith('⏳ Likely fulfilled')) || '';
  ok(/DONECARD[\s\S]*SHIPCARD/.test(likelySec) && !/DEFERCARD/.test(likelySec), 'H8: the brief\'s ⏳ section lists the counted pair and not the deferred card');
  ok(traceLines().includes('hit'), 'H8: SessionStart read the cached record too (one detector run per brain edit)');

  // ── H9 — a corrupt cache file is ignored and rewritten ───────────────────
  fs.writeFileSync(cacheFile, '{"mtimeMs": 1, "size": ');
  resetTrace();
  const s3 = g.run(['--prompt'], { session_id: 'sess-count-3', prompt: STATUS_Q });
  ok(/📊 Computed current state/.test(s3) && openHeader(s3) === HEADER, 'H9: a corrupt cache file still yields the digest with the honest header');
  ok(traceLines().includes('miss'), 'H9: …as a MISS (parse failure is a miss, never a throw)');
  let fixed = null; try { fixed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { fixed = null; }
  ok(!!fixed && Array.isArray(fixed.summary?.openIds), 'H9: the file is valid JSON with a summary afterwards (rewritten)');
  // Shape mismatch (valid JSON, wrong record) is a miss as well.
  fs.writeFileSync(cacheFile, JSON.stringify({ mtimeMs: st.mtimeMs, size: st.size, summary: { open: 4 } }));
  resetTrace();
  const s4 = g.run(['--prompt'], { session_id: 'sess-count-4', prompt: STATUS_Q });
  ok(openHeader(s4) === HEADER && traceLines().includes('miss'), 'H9: a shape-mismatched record (no openIds) is a miss and the header is still honest');

  // ── H10 — same mtimeMs, different size ⇒ miss (append-only saves) ────────
  {
    const { struct } = await parseKlypix(fs.readFileSync(brainFile));
    const good = cachedOpenStatusSummary(struct, { brainPath: brainFile, cacheFile });
    ok(good.cached === true, 'H10: in-process read of the rewritten record is a hit');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    fs.writeFileSync(cacheFile, JSON.stringify({ ...raw, size: raw.size + 1 }));
    const sizeMiss = cachedOpenStatusSummary(struct, { brainPath: brainFile, cacheFile });
    ok(sizeMiss.cached === false && sizeMiss.summary.open === 4, 'H10: same mtimeMs, different size ⇒ MISS (recomputed, same numbers)');
    const again = cachedOpenStatusSummary(struct, { brainPath: brainFile, cacheFile });
    ok(again.cached === true && again.summary.likelyDone === 1 && again.summary.overdue === 1 && again.summary.untouched === 1, 'H10: the rewrite is a hit again with identical parts');
    const tmpLeft = fs.readdirSync(path.dirname(cacheFile)).filter(f => /\.status\.json\.tmp-/.test(f));
    ok(tmpLeft.length === 0, 'H10: no tmp file left behind (tmp + rename)');
  }
} finally {
  g.cleanup();
  resetTrace();
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ status-hook: all assertions passed');
process.exit(failures ? 1 : 0);
