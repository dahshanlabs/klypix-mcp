// Live projection (1.104.0) — the machine-local half of the brain's state,
// written into the files the hosts load by themselves and never commit.
//
// THE contract under test (coordination bench rounds 2–3, 2026-10-12/13: the
// agent obeys the instruction file over the lane; the hosts read different
// surfaces; a note in a file outlives the work it protected):
//   A. RENDER — one bounded, deterministic block from the strings the hooks
//      already print (peers, unfinished work, keep-off verdicts); the keep-off
//      evidence survives the budget first; "nothing live" is said, not omitted.
//   B. FILES — CLAUDE.local.md gets the block (replaced in place, appended to a
//      person's own content, never duplicated), the clone excludes it from git
//      through .git/info/exclude (never a committed file), and the Codex global
//      file gets one section per project — AGENTS.override.md when it exists,
//      else AGENTS.md — with stale or surplus projects' sections pruned.
//   C. QUIET — the same content is not rewritten (the time stamp alone never
//      causes a write); a different content is.
//   D. SURFACES — the Claude SessionStart and Stop hooks and the Codex
//      SessionStart and Stop hooks all write both files, and what they write
//      is what they printed (the 📌 verdict, the peer).
//   E. REMOVAL — unlink strips the project's block from both files, deletes
//      CLAUDE.local.md only when nothing else is in it, and leaves other
//      projects' sections in the Codex file alone.
//
// Run:  node test/live-projection.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  LIVE_BUDGET_CHARS, LIVE_END, liveKey, renderLiveProjection, wrapLiveBlock, upsertLiveBlock, stripLiveBlocks,
  writeClaudeLocal, writeCodexGlobal, codexGlobalInstructionFile, pruneLiveSections, projectLive, removeLiveProjection,
  listLiveSections, hasLiveBlock, ensureLocalExcluded,
} from '../src/live-projection.mjs';
import { upsertSession, endSession } from '../src/agent-presence.mjs';
import { planUnlink, applyPlan } from '../src/uninstall.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(__dirname, '..', 'src', 'codex-brain-hook.mjs');
let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-liveproj-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

const makeRepo = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const git = (args) => String(execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const commit = (msg) => { git(['add', '-A']); git(['commit', '-q', '-m', msg]); return git(['rev-parse', '--short=7', 'HEAD']); };
  return { dir, git, write, commit };
};
const NOTE = '- Hands off lib/ledger.js please — Priya is mid-refactor on it.';
const notesFile = (line) => ['# Project notes', '', '## Heads-up', line, '', '## Log', '- 2026-10-01 Billing: amounts are dollars with cents.', ''].join('\n');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

try {
  // ── A. Render ─────────────────────────────────────────────────────────────
  {
    const dir = path.join(root, 'render-proj');
    const peers = [{ id: 'abcdef12-3456', client: 'codex', intent: 'Rework invoice totals', files: ['lib/invoice.js', 'lib/tax.js'] }];
    const lock = '📌 Notes in this project\'s instruction files — …\n- “Hands off lib/ledger.js” (AGENTS.md:4)\n  → lib/ledger.js: NO WORK FOUND — nothing holds it.';
    const unfinished = '⏸️ Work other sessions may have left unfinished (1)\n- Claude Code deadbeef · “Fix rounding” · ended · last active 2h ago';
    const a = renderLiveProjection({ projectDir: dir, now: 1760000000000, peers, lockNotesText: lock, unfinishedText: unfinished });
    const b = renderLiveProjection({ projectDir: dir, now: 1760000000000, peers, lockNotesText: lock, unfinishedText: unfinished });
    ok(a === b && a.startsWith('## KLYPIX live — render-proj on this PC · as of 2025-10-09T08:53Z'), 'A1 one input renders one text, headed by the project and the minute');
    ok(a.includes('Codex abcdef12 · “Rework invoice totals” · files: lib/invoice.js, lib/tax.js') && a.includes('lib/ledger.js: NO WORK FOUND') && a.includes('Claude Code deadbeef'), 'A2 the peer, the keep-off verdict and the unfinished work are all in it');
    ok(a.includes('brain_sync') && a.includes('not committed') && a.includes('session start and stop'), 'A3 it says what it is: a snapshot, local, brain_sync is the live source');
    const empty = renderLiveProjection({ projectDir: dir, now: 1760000000000 });
    ok(empty.includes('No other live session') && empty.includes('No keep-off note') && empty.includes('No unfinished work'), 'A4 nothing live is said in words, so an older snapshot is replaced, not left standing');
    const longLock = lock + '\n' + '- “another note about lib/x.js” (AGENTS.md:9)\n  → lib/x.js: UNKNOWN — the evidence check is incomplete.\n'.repeat(40);
    const longUnf = unfinished + '\n' + '- Codex 01234567 · “yet another stopped session with a long intent line” · ended\n'.repeat(60);
    const big = renderLiveProjection({ projectDir: dir, now: 1760000000000, peers, lockNotesText: longLock, unfinishedText: longUnf });
    ok(big.length <= LIVE_BUDGET_CHARS + 200 && big.includes('lib/ledger.js: NO WORK FOUND') && big.includes('cut for size'), 'A5 the block is bounded, says it was cut, and the first keep-off verdict survives the cut');
    const blk = wrapLiveBlock(liveKey(dir), 'body', { at: 1760000000000, projectDir: dir });
    ok(blk.startsWith(`<!-- klypix-live:start key=${liveKey(dir)} at=2025-10-09T08:53:20.000Z project="`) && blk.endsWith(`\nbody\n${LIVE_END}`), 'A6 the marker carries the key, the time and the project path; the end marker is fixed');
    const once = upsertLiveBlock('# Mine\n\nkeep this\n', liveKey(dir), blk);
    const twice = upsertLiveBlock(once, liveKey(dir), wrapLiveBlock(liveKey(dir), 'body2', { at: 1760000001000, projectDir: dir }));
    ok(once.startsWith('# Mine\n\nkeep this\n\n<!-- klypix-live:start') && twice.includes('body2') && !twice.includes('\nbody\n') && (twice.match(/klypix-live:start/g) || []).length === 1, 'A7 the block is appended after the person\'s text, then replaced in place, never duplicated');
    ok(stripLiveBlocks(twice, liveKey(dir)) === '# Mine\n\nkeep this\n', 'A8 stripping the block gives the person\'s file back');
  }

  // ── B/C. Files ────────────────────────────────────────────────────────────
  {
    const r = makeRepo('files');
    r.write('lib/ledger.js', 'x\n');
    r.write('AGENTS.md', notesFile(NOTE));
    r.commit('base');
    const codexFile = path.join(home, '.codex', 'AGENTS.md');
    const t0 = 1760000000000;
    const first = projectLive({ projectDir: r.dir, now: t0, home, peers: [{ id: 'peer0001-aaaa', client: 'claude-code', intent: 'Docs' }], lockNotesText: '📌 x\n  → lib/ledger.js: NO WORK FOUND', unfinishedText: '' });
    ok(first.claude.action === 'created' && first.codex.action === 'created' && hasLiveBlock(read(path.join(r.dir, 'CLAUDE.local.md')), r.dir) && hasLiveBlock(read(codexFile), r.dir), 'B1 both files are created with this project\'s block');
    ok(['excluded', 'already-excluded', 'already-ignored'].includes(first.claude.excluded) && read(path.join(r.dir, '.git', 'info', 'exclude')).includes('CLAUDE.local.md'), 'B2 the clone excludes CLAUDE.local.md through .git/info/exclude');
    ok(!r.git(['status', '--porcelain']).split('\n').some((l) => l.includes('CLAUDE.local.md')), 'B3 git status does not list it');
    ok(ensureLocalExcluded(r.dir) === 'already-ignored' || ensureLocalExcluded(r.dir) === 'already-excluded', 'B4 a second exclude is a no-op');
    const stampA = read(codexFile).match(/ at=([^ ]+)/)[1];
    const again = projectLive({ projectDir: r.dir, now: t0 + 600000, home, peers: [{ id: 'peer0001-aaaa', client: 'claude-code', intent: 'Docs' }], lockNotesText: '📌 x\n  → lib/ledger.js: NO WORK FOUND', unfinishedText: '' });
    ok(again.claude.action === 'unchanged' && again.codex.action === 'unchanged' && read(codexFile).match(/ at=([^ ]+)/)[1] === stampA, 'C1 the same content ten minutes later is not rewritten — the stamp alone never causes a write');
    const changed = projectLive({ projectDir: r.dir, now: t0 + 600000, home, peers: [], lockNotesText: '📌 x\n  → lib/ledger.js: IN USE — live session Codex 01234567', unfinishedText: '' });
    ok(changed.claude.action === 'updated' && changed.codex.action === 'updated' && read(codexFile).includes('IN USE') && !read(codexFile).includes('NO WORK FOUND'), 'C2 a changed verdict rewrites both files in place');
    // A person's own CLAUDE.local.md keeps its content.
    const r2 = makeRepo('own-local');
    r2.write('CLAUDE.local.md', '# My sandbox\n- staging URL: http://localhost:9999\n');
    r2.commit('base');
    projectLive({ projectDir: r2.dir, now: t0, home });
    const own = read(path.join(r2.dir, 'CLAUDE.local.md'));
    ok(own.startsWith('# My sandbox\n- staging URL: http://localhost:9999\n') && hasLiveBlock(own, r2.dir), 'B5 a person\'s own CLAUDE.local.md keeps its lines; the block is added after them');
    // The Codex global file holds one section per project, pruned when stale or surplus.
    const sections = listLiveSections(read(codexFile));
    ok(sections.length === 2 && sections.every((s) => s.project) && new Set(sections.map((s) => s.key)).size === 2, 'B6 the Codex global file carries one section per project, each naming its path');
    const stale = wrapLiveBlock('0000000000000001', 'old', { at: t0 - 2 * 24 * 3600 * 1000, projectDir: path.join(root, 'gone') });
    fs.writeFileSync(codexFile, read(codexFile) + '\n' + stale + '\n');
    projectLive({ projectDir: r.dir, now: t0 + 700000, home, peers: [{ id: 'x1', client: 'codex' }] });
    ok(!read(codexFile).includes('key=0000000000000001') && listLiveSections(read(codexFile)).length === 2, 'B7 a section older than a day from another project is pruned on the next write');
    let crowded = read(codexFile);
    for (let i = 2; i < 12; i++) crowded += '\n' + wrapLiveBlock(`00000000000000${String(i).padStart(2, '0')}`, `p${i}`, { at: t0 + i * 1000, projectDir: path.join(root, `p${i}`) }) + '\n';
    const pruned = pruneLiveSections(crowded, { keep: liveKey(r.dir), now: t0 + 800000 });
    const left = listLiveSections(pruned.text);
    ok(left.length === 8 && left.some((s) => s.key === liveKey(r.dir)) && !left.some((s) => s.key === '0000000000000002'), 'B8 beyond the cap the oldest other sections go first; the writing project always stays');
    // AGENTS.override.md wins when the person has one (Codex loads only that file globally).
    const override = path.join(home, '.codex', 'AGENTS.override.md');
    fs.writeFileSync(override, '# my codex rules\n');
    ok(codexGlobalInstructionFile(home) === override, 'B9 with an override file present, that is the Codex global file');
    const w = writeCodexGlobal(r.dir, 'ov', { now: t0, home });
    ok(w.path === override && hasLiveBlock(read(override), r.dir) && read(override).startsWith('# my codex rules\n'), 'B10 the section goes into the override file, after the person\'s rules');
    fs.unlinkSync(override);
    // A failed write is an action word, never a throw.
    const bad = writeClaudeLocal(r.dir, 'body', { file: path.join(r.dir, 'no-such-dir', 'x', 'CLAUDE.local.md') + path.sep });
    ok(bad.action === 'failed' && typeof bad.error === 'string', 'B11 an unwritable target reports failed instead of throwing');
  }

  // ── D. Surfaces (the real hooks) ──────────────────────────────────────────
  {
    const r = makeRepo('surfaces');
    r.write('lib/ledger.js', 'export function roundCents(a) { return Math.floor(a * 100) / 100; }\n');
    r.write('AGENTS.md', notesFile(NOTE));
    r.commit('ledger: base');
    fs.writeFileSync(path.join(r.dir, 'brain.klypix'), await buildKlypixMap({ title: 'Live projection test brain', kind: 'brain', areas: [{ title: 'Billing', cards: [{ text: 'Billing: amounts are dollars with cents' }] }] }));
    const brainPath = path.join(r.dir, 'brain.klypix');
    const codexFile = path.join(home, '.codex', 'AGENTS.md');
    const local = path.join(r.dir, 'CLAUDE.local.md');
    // A live peer on the lane, so the snapshot has someone to name.
    upsertSession({ brainPath, home, id: 'peer-live-0001', client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: 'peer-live-0001', identitySource: 'codex-lifecycle', intent: 'Rework invoice totals', files: ['lib/invoice.js'], hostStatus: 'busy', hostStatusAt: Date.now() });
    const hookEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KLYPIX_AUTO_UPDATE: '0' };
    delete hookEnv.KLYPIX_SESSION_ID;
    const start = execFileSync(process.execPath, [HOOK], { cwd: r.dir, env: hookEnv, encoding: 'utf8', input: JSON.stringify({ session_id: 'live-hook-0001', cwd: r.dir }), stdio: ['pipe', 'pipe', 'pipe'] });
    ok(start.includes('lib/ledger.js: NO WORK FOUND'), 'D0 the Claude SessionStart hook printed the 📌 verdict (precondition)');
    const localText = read(local);
    ok(localText && hasLiveBlock(localText, r.dir) && localText.includes('lib/ledger.js: NO WORK FOUND') && localText.includes('Codex peer-liv') && localText.includes('lib/invoice.js'), 'D1 Claude SessionStart wrote CLAUDE.local.md with the same verdict and the live peer');
    ok(read(codexFile) && hasLiveBlock(read(codexFile), r.dir) && read(codexFile).includes('lib/ledger.js: NO WORK FOUND'), 'D2 …and the Codex global file');
    ok(!r.git(['status', '--porcelain']).split('\n').some((l) => l.includes('CLAUDE.local.md')), 'D3 the clone does not show CLAUDE.local.md as untracked');
    // Stop: the hook's --capture path refreshes it too (no transcript needed for the projection).
    fs.unlinkSync(local);
    execFileSync(process.execPath, [HOOK, '--capture'], { cwd: r.dir, env: hookEnv, encoding: 'utf8', input: JSON.stringify({ session_id: 'live-hook-0001', cwd: r.dir, transcript_path: path.join(r.dir, 'no-transcript.jsonl') }), stdio: ['pipe', 'pipe', 'pipe'] });
    ok(hasLiveBlock(read(local) || '', r.dir), 'D4 the Claude Stop hook writes it again');
    // Codex hooks.
    const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|KLYPIX)/.test(k)));
    fs.unlinkSync(local);
    fs.unlinkSync(codexFile);
    const cx = execFileSync(process.execPath, [CODEX_HOOK], { cwd: r.dir, env: { ...workerEnv, HOME: home, USERPROFILE: home }, encoding: 'utf8', input: JSON.stringify({ cwd: r.dir, session_id: 'live-codex-0002', hook_event_name: 'SessionStart' }) });
    const cxText = (() => { try { const o = JSON.parse(cx || '{}'); return o.hookSpecificOutput?.additionalContext || o.systemMessage || ''; } catch { return ''; } })();
    ok(cxText.includes('lib/ledger.js: NO WORK FOUND'), 'D5 the Codex SessionStart hook printed the 📌 verdict (precondition)');
    ok(hasLiveBlock(read(local) || '', r.dir) && read(local).includes('lib/ledger.js: NO WORK FOUND') && hasLiveBlock(read(codexFile) || '', r.dir), 'D6 Codex SessionStart wrote both files with the same verdict');
    fs.unlinkSync(local);
    execFileSync(process.execPath, [CODEX_HOOK], { cwd: r.dir, env: { ...workerEnv, HOME: home, USERPROFILE: home }, encoding: 'utf8', input: JSON.stringify({ cwd: r.dir, session_id: 'live-codex-0002', hook_event_name: 'Stop', last_assistant_message: 'Done for now.' }) });
    ok(hasLiveBlock(read(local) || '', r.dir), 'D7 the Codex Stop hook writes it again');
    endSession({ brainPath, home, id: 'peer-live-0001' });
    endSession({ brainPath, home, id: 'live-codex-0002' });
  }

  // ── E. Removal ────────────────────────────────────────────────────────────
  {
    const r = makeRepo('removal');
    r.write('AGENTS.md', '# notes\n');
    r.commit('base');
    const other = makeRepo('other');
    const codexFile = path.join(home, '.codex', 'AGENTS.md');
    projectLive({ projectDir: r.dir, now: Date.now(), home });
    projectLive({ projectDir: other.dir, now: Date.now(), home });
    const res = removeLiveProjection(r.dir, { home });
    ok(res.claude === 'file-removed' && !fs.existsSync(path.join(r.dir, 'CLAUDE.local.md')), 'E1 unlink deletes CLAUDE.local.md when the block was all it held');
    ok(res.codex === 'section-removed' && !hasLiveBlock(read(codexFile), r.dir) && hasLiveBlock(read(codexFile), other.dir), 'E2 …and strips only this project\'s section from the Codex file');
    fs.writeFileSync(path.join(r.dir, 'CLAUDE.local.md'), '# mine\n');
    projectLive({ projectDir: r.dir, now: Date.now(), home });
    const res2 = removeLiveProjection(r.dir, { home });
    ok(res2.claude === 'block-removed' && read(path.join(r.dir, 'CLAUDE.local.md')) === '# mine\n', 'E3 with the person\'s own lines present, only the block goes');
    // The uninstaller's project plan knows the block. The uninstaller resolves
    // the Codex home itself (CODEX_HOME, else ~/.codex), so point it at ours.
    projectLive({ projectDir: r.dir, now: Date.now(), home });
    const plan = planUnlink(r.dir);
    const item = plan.items.find((i) => i.rel === 'CLAUDE.local.md');
    ok(item && item.kind === 'live-block' && item.action === 'strip-block', 'E4 planUnlink lists the live block as a strip, never a blind delete');
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(home, '.codex');
    let results;
    try { results = applyPlan({ items: [item], root: r.dir }); } finally { if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome; }
    ok(results[0].result.ok && read(path.join(r.dir, 'CLAUDE.local.md')) === '# mine\n' && !hasLiveBlock(read(codexFile), r.dir), 'E5 applying it removes the block from both files');
    ok(planUnlink(r.dir).items.find((i) => i.rel === 'CLAUDE.local.md').action === 'none', 'E6 a second plan finds nothing to do');
  }
  console.log(`\nlive-projection: ${checks} checks passed`);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }
}
