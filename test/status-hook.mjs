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
//
// Run:  node test/status-hook.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap } from '../src/klypix-format.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(ROOT, 'src', 'codex-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-status-hook-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-status-hook-proj-'));
  fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
  // throttle the npm-currency refresh so no test makes a network call
  fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.npm-currency.json'),
    JSON.stringify({ pkg: 'klypix-mcp', latest: '1.85.0', checkedAt: Date.now() }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
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

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ status-hook: all assertions passed');
process.exit(failures ? 1 : 0);
