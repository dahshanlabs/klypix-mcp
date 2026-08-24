// Guard cards (2026-08-24) — the brain interrupts BEFORE a matching tool call.
//   G1  validateGuard accepts the honest grammar and rejects everything else
//   G2  compileGuards reads live cards only; lifecycle retires a guard for free
//   G3  evaluateGuards: AND-ed triggers, prefix paths, unverified-never-exempt
//   G4  the guard field round-trips writer → parse → compile
//   G5  sidecar keying: guardSidecarPathFor === the hook's own derivation
//   G6  E2E through the REAL hook: --prompt builds the sidecar; --guard warns
//       (once per session), denies on a verified block, degrades an unverifiable
//       block to warn, and stays silent for non-matching tools
//
// Run:  node test/guard-cards.mjs        (exit 0 = pass, 1 = fail)
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
    buildKlypixMap, parseKlypix,
    validateGuard, compileGuards, evaluateGuards, guardSidecarPathFor,
} from '../src/klypix-format.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// ── G1: validation ───────────────────────────────────────────────────────────
{
    const good = validateGuard({ when: { tool: 'Bash', command: '\\bgit\\s+push\\b' }, message: 'amend, do not re-push' });
    ok(good.ok && good.guard.severity === 'warn', 'G1: a tool+command guard validates, severity defaults to warn');
    const block = validateGuard({ when: { command: '\\bgit\\s+stash\\b', multiWorktree: true }, severity: 'block', message: 'stash is shared across worktrees' });
    ok(block.ok && block.guard.severity === 'block' && block.guard.when.multiWorktree === true,
        'G1: a block guard with the multiWorktree predicate validates');
    ok(!validateGuard({ when: { command: '([' }, message: 'x' }).ok, 'G1: an invalid regex source is rejected, not stored');
    ok(!validateGuard({ when: {}, message: 'x' }).ok, 'G1: an empty when is rejected — a guard must know its trigger');
    ok(!validateGuard({ when: { tool: 'Bash' } }).ok, 'G1: a missing message is rejected — the message IS the intervention');
    ok(!validateGuard({ when: { tool: 'Bash' }, severity: 'nuke', message: 'x' }).ok, 'G1: an unknown severity is rejected');
    ok(!validateGuard({ when: { tool: 'x'.repeat(300) }, message: 'x' }).ok, 'G1: an oversized pattern is rejected (ReDoS hygiene)');
    ok(!validateGuard({ when: { paths: [] }, message: 'x' }).ok, 'G1: empty paths array is rejected');
    ok(validateGuard({ when: { paths: ['artifacts\\runtime'] }, message: 'x' }).guard.when.paths[0] === 'artifacts/runtime',
        'G1: backslash path prefixes normalize to forward slashes');
}

// ── G2: compilation + lifecycle ──────────────────────────────────────────────
{
    const struct = {
        cards: [
            { id: 'a', type: 'text', area: 'CI', text: 'CI: 🛠️ never re-push', guard: { when: { command: 'git push' }, message: 'amend instead' } },
            { id: 'b', type: 'text', area: 'Archive', text: '🛠️ old', guard: { when: { command: 'x' }, message: 'retired' } },
            { id: 'c', type: 'text', area: 'CI', text: '🛠️ resolved ✅ done', guard: { when: { command: 'x' }, message: 'resolved' } },
            { id: 'd', type: 'text', area: 'CI', text: '🛠️ malformed', guard: { when: {}, message: 'invalid' } },
            { id: 'e', type: 'text', area: 'CI', text: 'plain card, no guard' },
        ],
    };
    const compiled = compileGuards(struct);
    ok(compiled.length === 1 && compiled[0].id === 'a', 'G2: only the live, valid guard compiles — archived/resolved/malformed are out');
}

// ── G3: evaluation ───────────────────────────────────────────────────────────
{
    const guards = compileGuards({ cards: [
        { id: 'push', type: 'text', area: 'CI', text: '🛠️ g', guard: { when: { tool: 'Bash', command: '\\bgit\\s+push\\b', paths: ['artifacts/runtime'] }, message: 'runner-impacting' } },
        { id: 'stash', type: 'text', area: 'Git', text: '🛠️ g', guard: { when: { command: '\\bgit\\s+stash\\b', multiWorktree: true }, severity: 'block', message: 'shared stash' } },
    ] });
    const hit = evaluateGuards(guards, { toolName: 'Bash', command: 'git push origin main', files: ['artifacts/runtime/agent.ts'], worktreeCount: 1 });
    ok(hit.length === 1 && hit[0].guard.id === 'push' && hit[0].unverified.length === 0,
        'G3: tool+command+paths all matching fires the guard, fully verified');
    ok(evaluateGuards(guards, { toolName: 'Bash', command: 'git push', files: ['src/other.ts'], worktreeCount: 1 }).length === 0,
        'G3: a non-matching path prefix means no fire');
    ok(evaluateGuards(guards, { toolName: 'Read', command: '', files: null, worktreeCount: null }).length === 0,
        'G3: a non-matching tool means no fire');
    const unv = evaluateGuards(guards, { toolName: 'Bash', command: 'git push', files: null, worktreeCount: 1 });
    ok(unv.length === 1 && unv[0].unverified.includes('paths'),
        'G3: unavailable path input reports UNVERIFIED — never a silent exemption');
    const wt = evaluateGuards(guards, { toolName: 'Bash', command: 'git stash pop', files: [], worktreeCount: 3 });
    ok(wt.length === 1 && wt[0].guard.id === 'stash' && wt[0].unverified.length === 0,
        'G3: the multiWorktree predicate fires at count 3');
    ok(evaluateGuards(guards, { toolName: 'Bash', command: 'git stash', files: [], worktreeCount: 1 }).length === 0,
        'G3: the multiWorktree predicate stays quiet in a single-worktree repo');
    const wtUnv = evaluateGuards(guards, { toolName: 'Bash', command: 'git stash', files: [], worktreeCount: null });
    ok(wtUnv.length === 1 && wtUnv[0].unverified.includes('worktreeCount'),
        'G3: an unknown worktree count is UNVERIFIED, not exempt');
    ok(Array.isArray(evaluateGuards([{ id: 'bad', when: { tool: '(' }, severity: 'warn', message: 'x' }], { toolName: 'Bash' })),
        'G3: a corrupt guard entry never throws out of the evaluator');
}

// ── G4: writer → parse → compile round-trip ──────────────────────────────────
{
    const buf = await buildKlypixMap({
        title: 'guard fixture',
        areas: [{ title: 'CI', cards: [{
            text: 'CI: 🛠️ never push twice to a runner-impacting PR — amend locally, push once',
            guard: { when: { tool: 'Bash', command: '\\bgit\\s+push\\b' }, message: 'Runner-impacting: amend locally and push once.' },
        }] }],
    });
    const { struct } = await parseKlypix(buf);
    const card = struct.cards.find((c) => c.guard);
    ok(!!card && card.guard.when.command === '\\bgit\\s+push\\b',
        'G4: the guard field survives the writer and is exposed by parseKlypix');
    ok(compileGuards(struct).length === 1, 'G4: the parsed struct compiles back to one guard');
}

// ── G5: sidecar keying parity with the hook ──────────────────────────────────
{
    const brain = 'E:\\Some\\Project\\brain.klypix';
    const norm = String(brain).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
    const hookFormula = path.join(os.homedir(), '.claude', 'project-brain',
        `.guards-${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)}.json`);
    ok(guardSidecarPathFor(brain) === hookFormula,
        'G5: guardSidecarPathFor matches the hook\'s own sha1-16(normalized) derivation');
}

// ── G6: E2E through the real hook ────────────────────────────────────────────
{
    const home = path.join(os.tmpdir(), 'klypix-guard-home');
    const proj = path.join(os.tmpdir(), 'klypix-guard-proj');
    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.npm-currency.json'),
        JSON.stringify({ pkg: 'klypix-mcp', latest: '1.80.0', checkedAt: Date.now() }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    const run = (args, input) => execFileSync(process.execPath, [HOOK, ...args],
        { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });

    const brainFile = path.join(proj, 'brain.klypix');
    fs.writeFileSync(brainFile, await buildKlypixMap({
        title: 'brain',
        areas: [{ title: 'CI', cards: [
            {
                text: 'CI: 🛠️ never push twice to a runner-impacting PR — amend locally, push once',
                guard: { when: { tool: 'Bash', command: '\\bgit\\s+push\\b' }, message: 'Runner-impacting push — amend locally and push ONCE.' },
            },
            {
                text: 'Git: 🛠️ never rewrite history on shared branches',
                guard: { when: { tool: 'Bash', command: '\\bgit\\s+push\\s+[^\\n]*--force' }, severity: 'block', message: 'Force-push to a shared branch is blocked by a standing rule.' },
            },
            {
                text: 'Git: 🛠️ stash is shared across worktrees',
                guard: { when: { command: '\\bgit\\s+stash\\b', multiWorktree: true }, severity: 'block', message: 'git stash is shared across worktrees.' },
            },
        ] }],
    }));

    // The --prompt lane (warm struct) builds the sidecar.
    run(['--prompt'], { session_id: 'sess-g', prompt: 'ship the release safely please' });
    const sidecarPath = guardSidecarPathFor(brainFile, home);
    ok(fs.existsSync(sidecarPath), 'G6: the --prompt lane compiled the guard sidecar');
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    ok(sidecar.guards.length === 3, 'G6: all three guards compiled into the sidecar');

    // Warn guard fires with the message…
    const warnOut = run(['--guard'], { session_id: 'sess-g', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    const warn = JSON.parse(warnOut);
    ok(/Runner-impacting push/.test(warn.hookSpecificOutput?.additionalContext || '')
        && warn.hookSpecificOutput?.hookEventName === 'PreToolUse'
        && warn.hookSpecificOutput?.permissionDecision === undefined,
    'G6: a warn guard injects additionalContext and does NOT carry a permission decision');
    // …once per session…
    ok(run(['--guard'], { session_id: 'sess-g', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }).trim() === '',
        'G6: the same warn is silent on the second matching call in one session');
    ok(/Runner-impacting push/.test(run(['--guard'], { session_id: 'sess-h', tool_name: 'Bash', tool_input: { command: 'git push origin main' } })),
        'G6: a different session gets its own first warning');

    // A verified block DENIES with the card named in the reason.
    const deny = JSON.parse(run(['--guard'], { session_id: 'sess-g', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }));
    ok(deny.hookSpecificOutput?.permissionDecision === 'deny'
        && /Force-push/.test(deny.hookSpecificOutput?.permissionDecisionReason || '')
        && /guard card/.test(deny.hookSpecificOutput?.permissionDecisionReason || ''),
    'G6: a verified block guard denies, and the reason names the card so a wrong block is correctable');

    // An UNVERIFIABLE block (worktree count unknown — fixture is not a git repo)
    // degrades to warn and says what it could not verify. Never a silent allow,
    // never a false deny.
    const degraded = JSON.parse(run(['--guard'], { session_id: 'sess-g', tool_name: 'Bash', tool_input: { command: 'git stash' } }));
    ok(degraded.hookSpecificOutput?.permissionDecision === undefined
        && /degraded to warn/.test(degraded.hookSpecificOutput?.additionalContext || '')
        && /worktreeCount/.test(degraded.hookSpecificOutput?.additionalContext || ''),
    'G6: a block guard with an unverifiable predicate degrades to warn and names the missing input');

    // Non-matching tools and absent sidecars stay silent.
    ok(run(['--guard'], { session_id: 'sess-g', tool_name: 'Read', tool_input: { file_path: 'x.ts' } }).trim() === '',
        'G6: a non-matching tool produces no output at all');
    fs.rmSync(sidecarPath, { force: true });
    ok(run(['--guard'], { session_id: 'sess-g', tool_name: 'Bash', tool_input: { command: 'git push' } }).trim() === '',
        'G6: a missing sidecar is the true exemption — silent no-op');

    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ guard-cards: all assertions passed');
process.exit(failures ? 1 : 0);
