// Post-verified-fix rule DRAFTS (capture-coverage closer, 2026-07-17).
// The founder-surfaced gap: a fix is only recallable if a marker was emitted, and a
// trap-shaped fix that lands as a PLAIN note only resurfaces on a phrasing match —
// not every session like a 🛠️ rule. The closer: when a session MAKES + VERIFIES a
// trap-shaped fix, the Stop hook DRAFTS a candidate 🛠️ rule (a per-project sidecar,
// NEVER a brain card) that the read paths surface with a one-line `+` promote marker.
// No blind auto-capture: draft-only, gated by a VERIFY signal + a ≤2/session cap.
//
// Two layers, mirroring ship-capture.mjs + brain-quality.mjs:
//   • PURE:  looksLikeTrap() — the classifier (positives / negatives / glyph guards).
//   • E2E:   the REAL hook (--capture / --prompt / --full) over synthetic transcripts
//            in a hermetic HOME/project — asserts the sidecar + the surfaced footer.
//
// Run:  node test/rule-drafts.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, looksLikeTrap } from '../src/klypix-format.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// ── PURE: looksLikeTrap classifier ───────────────────────────────────────────
// Positives — real hard-won fix shapes (from the KLYPIX field brain) that read as
// traps but carry no strong imperative cue, so looksLikeSkill would MISS them.
ok(looksLikeTrap('the fix was to project along the diagonal, not max(scaleX,scaleY)'), 'trap+: "the fix was … , not …"');
ok(looksLikeTrap('root cause was a race condition in the capture lock'), 'trap+: "root cause … race condition"');
ok(looksLikeTrap('dedup zKeys before REORDER — duplicates silently no-op'), 'trap+: "silently"');
ok(looksLikeTrap('scattered imports → require()+TDZ; broke Alt+Space'), 'trap+: "TDZ" / "broke"');
ok(looksLikeTrap('Windows Electron restart needs taskkill; Ctrl+C leaves a zombie process'), 'trap+: "zombie"');
ok(looksLikeTrap('never white-stroke selected elements; boost width instead'), 'trap+: contrast "never"');
ok(looksLikeTrap('the exporter breaks on rotated strokes; the culprit was a stale transform'), 'trap+: "breaks" / "culprit" / "stale"');
ok(looksLikeTrap('scattered imports broke Alt+Space on startup'), 'trap+: "broke <thing>" (real breakage) still fires');
// broke/breaks/broken + a decomposition preposition = a refactor milestone, NOT a trap.
ok(!looksLikeTrap('broke App.tsx into 13 hooks'), 'trap-: "broke X into Y" is decomposition, not a failure');
ok(!looksLikeTrap('broke out the retry logic into its own module'), 'trap-: "broke out … into" is decomposition');
// Negatives — one-time events / plain decisions with no trap shape.
ok(!looksLikeTrap('shipped v1.3.48 with the consolidated desktop build'), 'trap-: a plain ship/milestone');
ok(!looksLikeTrap('switched the SFU to LiveKit for the in-canvas huddle'), 'trap-: a plain design decision (no cue)');
ok(!looksLikeTrap('released v1.2.3 to npm via the OIDC workflow'), 'trap-: an event pin ("released v…") is not a trap');
// Glyph guards — already-classified cards are never re-drafted.
ok(!looksLikeTrap('🛠️ always keep electron imports at the top of main.ts'), 'trap-: already a 🛠️ skill');
ok(!looksLikeTrap('❓ should we drop the agent status field or wire it?'), 'trap-: already an ❓ open question');
ok(!looksLikeTrap('🏁 cut release v9.0.0 — never mind'), 'trap-: a 🏁 milestone (even with a stray "never")');

// ── E2E hermetic runner ──────────────────────────────────────────────────────
const TXT = (text) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
const BASH = (id, command) => ({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } });

// A persistent hermetic project: fresh HOME + project dir, a seeded brain + throttled
// npm-currency cache (→ zero network), and helpers to run the REAL hook in any mode,
// reset the dedup state (simulate a fresh session hitting the same trap), seed the
// drafts sidecar, and read it back. Mirrors ship-capture.mjs's isolation contract.
async function makeProject(tag) {
  const home = path.join(os.tmpdir(), 'klypix-drafts-home-' + tag);
  const proj = path.join(os.tmpdir(), 'klypix-drafts-proj-' + tag);
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
  const brainHome = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(brainHome, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '1.15.0', checkedAt: Date.now() }));
  const draftsFile = path.join(proj, '.claude', 'brain-rule-drafts.json');
  const seedFile = path.join(proj, '.claude', 'brain-capture-state.json');
  const seedBrain = async (areas) => fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: areas || [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
  await seedBrain();
  const run = (mode, { transcript = [], sessionId = 'sess-' + tag, prompt } = {}) => {
    const tp = path.join(home, `transcript-${Math.abs(mode.length + (prompt || '').length)}-${sessionId}.jsonl`);
    fs.writeFileSync(tp, transcript.map(e => JSON.stringify(e)).join('\n') + '\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    const input = { session_id: sessionId, transcript_path: tp, ...(prompt !== undefined ? { prompt } : {}) };
    return execFileSync(process.execPath, [HOOK, mode], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });
  };
  return {
    home, proj,
    run,
    drafts: () => { try { return JSON.parse(fs.readFileSync(draftsFile, 'utf8')).drafts || []; } catch { return []; } },
    draftsFileExists: () => fs.existsSync(draftsFile),
    seedDrafts: (arr) => fs.writeFileSync(draftsFile, JSON.stringify({ drafts: arr }, null, 2)),
    resetSeen: () => { try { fs.rmSync(seedFile, { force: true }); } catch { /* */ } },
    seedBrain,
    cleanup: () => { for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

const TRAP_MARKER = '🧠 BRAIN [Canvas]: the corner-resize math broke on tiny wobble; the fix was to project along the diagonal, not max(scaleX,scaleY)';

// ── C1: a verified trap fix is DRAFTED (seed, area, seenCount) ────────────────
{
  const P = await makeProject('c1');
  P.run('--capture', { transcript: [TXT(TRAP_MARKER), BASH('t1', 'npm test')] });
  const d = P.drafts();
  ok(d.length === 1, `C1: one draft created from the verified trap fix (got ${d.length})`);
  ok(d[0] && d[0].area === 'Canvas', 'C1: draft carries the [Canvas] area');
  ok(d[0] && /diagonal/.test(d[0].text) && /corner-resize/.test(d[0].text) && !/^Canvas:/.test(d[0].text), 'C1: seed is the rule body, area prefix stripped');
  ok(d[0] && d[0].seenCount === 1, 'C1: seenCount starts at 1');
  P.cleanup();
}

// ── C2: NO verify signal → NO draft (the "AND verifies" gate) ─────────────────
{
  const P = await makeProject('c2');
  P.run('--capture', { transcript: [TXT(TRAP_MARKER)] });   // marker only, no test/build/commit
  ok(P.drafts().length === 0, 'C2: an un-verified trap fix is NOT drafted (verify gate holds)');
  P.cleanup();
}

// ── C3: the SAME trap re-fixed (fresh session) bumps seenCount, never stacks ──
{
  const P = await makeProject('c3');
  P.run('--capture', { transcript: [TXT(TRAP_MARKER), BASH('t1', 'npm run build')] });
  ok(P.drafts().length === 1 && P.drafts()[0].seenCount === 1, 'C3: first fix → 1 draft, seenCount 1');
  P.resetSeen();   // simulate a later session hitting the same trap (marker dedup reset)
  P.run('--capture', { transcript: [TXT(TRAP_MARKER), BASH('t2', 'vitest run')] });
  const d = P.drafts();
  ok(d.length === 1, `C3: recurrence does NOT stack a duplicate draft (got ${d.length})`);
  ok(d[0] && d[0].seenCount === 2, `C3: recurrence bumps seenCount to 2 (got ${d[0] && d[0].seenCount})`);
  P.cleanup();
}

// ── C4: a trap ALSO promoted to a 🛠️ skill THIS batch is NOT double-drafted ───
{
  const P = await makeProject('c4');
  const skill = '🧠 BRAIN [Canvas] +: corner-resize math must project along the diagonal, not max scaleX scaleY — it broke on tiny wobble';
  P.run('--capture', { transcript: [TXT(TRAP_MARKER), TXT(skill), BASH('t1', 'npm test')] });
  ok(P.drafts().length === 0, 'C4: a fix promoted to a standing skill in the same batch is not also left as a draft');
  P.cleanup();
}

// ── C5: a captured 🛠️ skill RETIRES a matching pre-existing draft (approval) ──
{
  const P = await makeProject('c5');
  P.run('--capture', { transcript: [TXT(TRAP_MARKER), BASH('t1', 'npm test')] });
  ok(P.drafts().length === 1, 'C5: pre-existing draft present');
  P.resetSeen();
  const skill = '🧠 BRAIN [Canvas] +: corner-resize math must project along the diagonal, not max scaleX scaleY — it broke on tiny wobble';
  P.run('--capture', { transcript: [TXT(skill), BASH('t2', 'npm test')] });
  ok(P.drafts().length === 0, 'C5: promoting the rule (+ marker) retires the matching draft (approval detection)');
  P.cleanup();
}

// ── C6: anti-spam — ≤ 2 NEW drafts per Stop even with 3 trap fixes ────────────
{
  const P = await makeProject('c6');
  const traps = [
    '🧠 BRAIN [Auth]: the refresh flow silently threw on an empty token list — root cause was a null deref',
    '🧠 BRAIN [Canvas]: the render leaks memory when a container unmounts mid-drag',
    '🧠 BRAIN [Export]: the exporter breaks on rotated strokes; the culprit was a stale transform matrix',
  ];
  P.run('--capture', { transcript: [...traps.map(TXT), BASH('t1', 'npm test')] });
  ok(P.drafts().length === 2, `C6: three verified trap fixes → at most 2 drafts (got ${P.drafts().length})`);
  P.cleanup();
}

// ── C7: a plain NON-trap decision (with a verify) is NOT drafted ──────────────
{
  const P = await makeProject('c7');
  P.run('--capture', { transcript: [TXT('🧠 BRAIN [Infra]: switched the SFU to LiveKit for the in-canvas huddle'), BASH('t1', 'npm test')] });
  ok(P.drafts().length === 0, 'C7: a non-trap plain decision is not drafted (looksLikeTrap gate)');
  P.cleanup();
}

// ── C8: a terse trap seed (<3 significant tokens) is NOT drafted (un-retireable) ─
{
  const P = await makeProject('c8');
  P.run('--capture', { transcript: [TXT('🧠 BRAIN [Fixes]: the fix broke on TDZ'), BASH('t1', 'npm test')] });
  ok(P.drafts().length === 0, 'C8: a seed with <3 significant tokens is not drafted (would be un-retireable + too generic)');
  P.cleanup();
}

// ── C9: a Stop that captures only a skill (no draft) writes NO empty sidecar ───
{
  const P = await makeProject('c9');
  P.run('--capture', { transcript: [TXT('🧠 BRAIN [Infra] +: always run sync:mcp before brain:deploy'), BASH('t1', 'npm test')] });
  ok(!P.draftsFileExists(), 'C9: a skill-only Stop does not create an empty {drafts:[]} sidecar (no repo pollution)');
  P.cleanup();
}

// ── C10: the footer surfaces the HOTTEST recurring draft first (sorted, not insertion) ─
{
  const P = await makeProject('c10');
  const now = Date.now();
  P.seedDrafts([
    { id: 'cold1', area: 'A', text: 'first cold draft about token rotation cadence', firstSeen: now, lastSeen: now, seenCount: 1 },
    { id: 'cold2', area: 'B', text: 'second cold draft about render culling budget', firstSeen: now, lastSeen: now, seenCount: 1 },
    { id: 'cold3', area: 'C', text: 'third cold draft about export matrix handling', firstSeen: now, lastSeen: now, seenCount: 1 },
    { id: 'hot', area: 'Canvas', text: 'the diagonal projection resize trap keeps recurring', firstSeen: now, lastSeen: now, seenCount: 4 },
  ]);
  const out = P.run('--full', { sessionId: 'c10sess' });
  ok(/⭐ recurred 4×/.test(out), 'C10: the hot recurring draft (seenCount 4, 4th inserted) is surfaced with its ⭐ escalation');
  ok(/diagonal projection resize trap/.test(out), 'C10: the hot draft is in the top-3 display (sorted ahead of the cold ones)');
  P.cleanup();
}

// ── C11: a draft ignored across MAX_SURFACINGS distinct sessions decays (stops nagging) ─
{
  const P = await makeProject('c11');
  const now = Date.now();
  P.seedDrafts([{ id: 'kd', area: 'Canvas', text: 'the decaying draft about a resize wobble corner case', firstSeen: now, lastSeen: now, seenCount: 1 }]);
  let surfaced = 0;
  for (let i = 0; i < 5; i++) { if (/Draft rule\(s\)/.test(P.run('--prompt', { prompt: 'continue', sessionId: 'decay-sess-' + i }))) surfaced++; }
  ok(surfaced === 5, `C11: the draft surfaces across the first 5 distinct sessions (got ${surfaced})`);
  const out6 = P.run('--prompt', { prompt: 'continue', sessionId: 'decay-sess-6' });
  ok(!/Draft rule\(s\)/.test(out6), 'C11: after 5 ignored surfacings the draft DECAYS — a 6th session is not nagged');
  P.cleanup();
}

// ── R1: the per-prompt footer surfaces a promote marker, once per session ─────
{
  const P = await makeProject('r1');
  P.seedDrafts([{ id: 'k1', area: 'Canvas', text: 'corner-resize must project along the diagonal, not max scaleX scaleY', firstSeen: Date.now(), lastSeen: Date.now(), seenCount: 1 }]);
  const out1 = P.run('--prompt', { prompt: 'ok continue', sessionId: 'r1sess' });
  ok(/Draft rule\(s\) from a verified fix/.test(out1), 'R1: per-prompt footer surfaces the pending draft');
  ok(/promote →.*🧠 BRAIN \[Canvas\] \+:/.test(out1), 'R1: footer includes a ready-to-emit + promote marker');
  const out2 = P.run('--prompt', { prompt: 'ok continue', sessionId: 'r1sess' });   // SAME session
  ok(!/Draft rule\(s\)/.test(out2), 'R1: same session does NOT re-nag (shown-once-per-session)');
  const out3 = P.run('--prompt', { prompt: 'ok continue', sessionId: 'r1sess-other' }); // NEW session
  ok(/Draft rule\(s\)/.test(out3), 'R1: a new session DOES re-surface the still-pending draft');
  P.cleanup();
}

// ── R2: a draft covered by a LIVE 🛠️ skill is filtered out (approved away) ────
{
  const P = await makeProject('r2');
  await P.seedBrain([{ title: 'Canvas', cards: [{ text: '🛠️ corner-resize math must project along the diagonal, not max scaleX scaleY (broke on tiny wobble)' }] }]);
  P.seedDrafts([{ id: 'k1', area: 'Canvas', text: 'corner-resize must project along the diagonal, not max scaleX scaleY', firstSeen: Date.now(), lastSeen: Date.now(), seenCount: 1 }]);
  const out = P.run('--prompt', { prompt: 'ok continue', sessionId: 'r2sess' });
  ok(!/Draft rule\(s\)/.test(out), 'R2: a draft already covered by a live 🛠️ skill is not surfaced');
  P.cleanup();
}

// ── R3: the SessionStart --full brief carries the draft footer (markShown=false) ─
{
  const P = await makeProject('r3');
  P.seedDrafts([{ id: 'k1', area: 'Canvas', text: 'corner-resize must project along the diagonal, not max scaleX scaleY', firstSeen: Date.now(), lastSeen: Date.now(), seenCount: 2 }]);
  const out = P.run('--full', { sessionId: 'r3sess' });
  ok(/Draft rule\(s\) from a verified fix/.test(out), 'R3: the full brief includes the draft nudge');
  ok(/⭐ recurred 2×/.test(out), 'R3: a recurring draft (seenCount≥2) is escalated in the footer');
  P.cleanup();
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ rule-drafts: all assertions passed');
process.exit(failures ? 1 : 0);
