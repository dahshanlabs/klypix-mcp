// E2E acceptance tests through the REAL hook (1.17.0) — hermetic: temp HOME +
// temp project per case, no network, no git repo needed.
//   P2 — SessionStart stdout is the ULTRA tier: ≤2,000 chars, Focus + open
//        questions inside it, full brief written to .claude/brain-brief.md
//        (and --full still prints everything).
//   P1 — recall never serves a stale card alone: a prompt lexically matching
//        the stale card injects the correction, labeled, and demotes the stale
//        text to a headline.
//   P6 — a card injected full-text once renders as an "already shown" headline
//        on the next prompt of the same session.
//   P7 — the peer-session block names the coordination mechanism (brain_message).
//   P9 — auto-harvested ship cards carry the #auto tag.
//
// Run:  node test/brief-and-recall.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const STALE = 'Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 — agents run skills only in-session for now, executor postponed until real demand shows.';
const CORRECTION = 'CORRECTION (stale note resolved): off-cloud skill/brain execution is now WIRED, not deferred — the runner executes skills off-cloud since the connectivity arc.';

function fixture(tag) {
    const home = path.join(os.tmpdir(), 'klypix-quality-home-' + tag);
    const proj = path.join(os.tmpdir(), 'klypix-quality-proj-' + tag);
    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    // throttle the Stop-hook npm-currency refresh so no test makes a network call
    fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.npm-currency.json'),
        JSON.stringify({ pkg: 'klypix-mcp', latest: '1.17.0', checkedAt: Date.now() }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    const run = (args, input) => execFileSync(process.execPath, [HOOK, ...args], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });
    const cleanup = () => { for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true }); };
    return { home, proj, run, cleanup };
}

// ── P2: ultra brief on SessionStart ──────────────────────────────────────────
{
    const f = fixture('brief');
    const decisions = Array.from({ length: 30 }, (_, i) => ({ text: `Decision ${i}: we chose approach ${i} for subsystem ${i} because of latency, memory, and rollout constraints measured in the field.` }));
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: '📌 Focus', cards: [{ text: 'Ship the quality release first — everything else waits.' }] },
            { title: 'Open questions', cards: [{ text: '❓ Do we need a second reviewer for hook changes?' }, { text: '❓ Should the exporter keep legacy v2 support?' }] },
            { title: 'Milestones', cards: [{ text: '🏁 v1.0 shipped to npm with provenance.' }] },
            { title: 'History', cards: decisions },
        ],
    }));
    const out = f.run([], { session_id: 'sess-brief' });
    ok(out.length <= 2000, `P2: SessionStart stdout ≤ 2,000 chars (got ${out.length})`);
    ok(out.includes('Ship the quality release first'), 'P2: Focus card fully inside the ultra tier');
    ok(out.includes('second reviewer for hook changes'), 'P2: open questions inside the ultra tier');
    ok(out.includes('.claude/brain-brief.md'), 'P2: the full-brief path is stated');
    const briefFile = path.join(f.proj, '.claude', 'brain-brief.md');
    ok(fs.existsSync(briefFile), 'P2: full brief written to .claude/brain-brief.md');
    const brief = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
    ok(brief.includes('Capture markers') && brief.includes('Milestones'), 'P2: full brief carries the legend + milestones (the tiers the preview loses)');
    ok(brief.length > out.length, 'P2: the file is the big one, stdout is the small one');
    const full = f.run(['--full'], { session_id: 'sess-brief' });
    ok(full.length > 2000 && full.includes('Capture markers'), 'P2: --full still prints everything to stdout');
    f.cleanup();
}

// ── P1: recall never serves the stale card alone ─────────────────────────────
{
    const f = fixture('recall');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Strategy', cards: [{ text: STALE }] },
            { title: 'Runtime', cards: [{ text: CORRECTION }] },
        ],
        connections: [{ from: STALE, to: CORRECTION, label: 'superseded by' }],
    }));
    const out = f.run(['--prompt'], { session_id: 'sess-recall', prompt: 'so is off-cloud skill execution still deferred on purpose? plan around the executor' });
    ok(/CORRECTED — current:/.test(out) && /WIRED/.test(out), 'P1: the correction is injected FIRST, labeled as current');
    ok(!out.includes('executor postponed until real demand shows'), 'P1: the stale card body is NOT injected full-text (headline only)');
    ok(/STALE card/.test(out), 'P1: the stale match is explicitly flagged as stale');
    f.cleanup();
}

// ── review-A/F: corrector ranked FIRST must still demote the stale hit ──────
{
    const f = fixture('corrfirst');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Strategy', cards: [{ text: STALE }] },
            { title: 'Runtime', cards: [{ text: CORRECTION }] },
        ],
        connections: [{ from: STALE, to: CORRECTION, label: 'superseded by' }],
    }));
    // Prompt shares more tokens with the CORRECTION card → it outranks the stale one.
    const prompt = 'the runner executes skills off-cloud since the connectivity arc — wired or deferred? plan the executor rollout';
    const first = f.run(['--prompt'], { session_id: 'sess-corrfirst', prompt });
    ok(/STALE card/.test(first), 'review-A: stale hit is labeled STALE even when its corrector renders first as its own hit');
    ok(!first.includes('executor postponed until real demand shows'), 'review-A: stale card body is never injected full-text');
    const second = f.run(['--prompt'], { session_id: 'sess-corrfirst', prompt });
    ok(!/CORRECTED — current: Runtime: CORRECTION/.test(second) || /already shown this session/.test(second),
        'review-F: the corrector full text is not re-paid on the next prompt of the same session');
    ok(/STALE card/.test(second), 'review-F: the stale labeling persists on re-hits');
    f.cleanup();
}

// ── P6: injected-set — full text once, headline after ────────────────────────
{
    const f = fixture('dedup');
    const LONGCARD = 'Sync design: the op-log compaction keeps the newest five thousand operations and folds older ones into the base blob checkpoint; readers replay from the checkpoint so truncation is invisible; the ceiling forces a base push every fifteen hundred edits throttled to thirty seconds.';
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain', areas: [{ title: 'Sync', cards: [{ text: LONGCARD }] }],
    }));
    const prompt = 'tune the op-log compaction checkpoint ceiling for sync';
    const first = f.run(['--prompt'], { session_id: 'sess-dedup', prompt });
    ok(first.includes('base push every fifteen hundred edits'), 'P6: first hit renders the card full-text');
    const second = f.run(['--prompt'], { session_id: 'sess-dedup', prompt });
    ok(second.includes('(already shown this session)'), 'P6: second hit renders the "already shown" headline');
    ok(!second.includes('base push every fifteen hundred edits'), 'P6: second hit does NOT re-pay the full card');
    const third = f.run(['--prompt'], { session_id: 'sess-other', prompt });
    ok(third.includes('base push every fifteen hundred edits'), 'P6: a DIFFERENT session still gets the full text (per-session set)');
    f.cleanup();
}

// ── P7: peer block names brain_message ───────────────────────────────────────
{
    const f = fixture('peers');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed' }] }],
    }));
    f.run(['--prompt'], { session_id: 'sess-peer-a', prompt: 'zzz nothing matches this one' });   // registers lane A
    const out = f.run(['--prompt'], { session_id: 'sess-peer-b', prompt: 'zzz nothing matches this one' });
    ok(/Other live session\(s\)/.test(out), 'P7: peer block present for the second session');
    ok(out.includes('brain_message') && out.includes('🧠 MSG'), 'P7: the peer block NAMES the mechanism (🧠 MSG + brain_message)');
    f.cleanup();
}

// ── P9: harvested ship cards carry #auto ─────────────────────────────────────
{
    const f = fixture('auto');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed' }] }],
    }));
    const transcript = path.join(f.home, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't0', input: { command: 'gh pr merge 286 --squash' } }] } }) + '\n');
    f.run(['--capture'], { session_id: 'sess-auto', transcript_path: transcript });
    const { struct } = await parseKlypix(fs.readFileSync(path.join(f.proj, 'brain.klypix')));
    const ship = struct.cards.find(c => /merged PR #286/.test(c.text || ''));
    ok(!!ship, 'P9: ship event captured');
    ok(!!ship && (ship.tags || []).includes('auto'), 'P9: ship card carries the #auto tag');
    f.cleanup();
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brief-and-recall: all assertions passed');
process.exit(failures ? 1 : 0);
