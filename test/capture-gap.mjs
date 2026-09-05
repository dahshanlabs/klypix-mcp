// Regression test for the UNCAPTURED-WORK NUDGE — the fix for the 2026-08-16
// field report, in which a multi-session workstream took a file format to a
// registered IANA media type (spec, schema fixes, merged PR, registration) and
// the brain recorded NONE of it, because capture is opt-in and the agent had
// been writing to its own private host memory directory instead. Nothing
// noticed that a session shipped while contributing zero cards.
//
// Three halves (the three things a first cut got wrong):
//   DECISION  — fires ONLY on "durable artifacts AND nothing anywhere recorded
//     the reasoning", with every suppressor working.
//   DRAFT     — the card is PRE-WRITTEN from the session's own artifacts, with
//     exactly one blank left (why it matters). Asking a drained session to
//     compose from scratch buys a one-line receipt, which is the half that was
//     never the problem.
//   PROVENANCE — silence requires THIS session to have captured. The first cut
//     used brain.klypix's mtime, so on a shared brain a PEER's card silenced the
//     session that shipped and said nothing — quiet in exactly the multi-agent
//     case the product is for.
//
// Plus E2E: the real Stop hook refuses the stop (exit 2) and hands over a draft.
//
// Run:  node test/capture-gap.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
    captureGapDecision, captureGapReason, draftCaptureMarker, inferArea, WHY_SLOT,
    looksLikeUnfilledDraft, readCaptureGapState, recordCaptureGapNudge, recordSessionCapture,
    sessionHasCaptured, recordTaskBaseline, readTaskBaseline, clearTaskBaseline,
    sessionCaptureReceipt, outcomeWasNudged, captureTranscriptWindow, recordTranscriptWindow,
} from '../src/capture-gap.mjs';

process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// ── DECISION ─────────────────────────────────────────────────────────────────
const SHIPPED = { shipped: ['merged PR #406'], env: {} };
ok(captureGapDecision(SHIPPED) !== null, 'shipped + nothing recorded → nudge');
ok(captureGapDecision({ ...SHIPPED, authored: 1 }) === null, 'an authored 🧠 marker → silent');
ok(captureGapDecision({ ...SHIPPED, commitCards: 1 }) === null, 'a rationale-bearing commit body IS capture → silent');
ok(captureGapDecision({ ...SHIPPED, sessionCaptured: true }) === null, 'THIS session already captured → silent');
ok(captureGapDecision({ ...SHIPPED, stopHookActive: true }) === null, 'stop_hook_active → silent (never loop)');
ok(captureGapDecision({ ...SHIPPED, alreadyNudged: true }) === null, 'once per session → silent on the second Stop');
ok(captureGapDecision({ ...SHIPPED, env: { KLYPIX_BRAIN_NUDGE: 'off' } }) === null, 'KLYPIX_BRAIN_NUDGE=off → silent');
ok(captureGapDecision({ ...SHIPPED, env: { KLYPIX_BRAIN_NUDGE: 'OFF' } }) === null, 'the opt-out is case-insensitive');

// Magnitude floor — a nudge that cries wolf gets switched off.
ok(captureGapDecision({ commitTotal: 1, env: {} }) === null, 'one commit alone → below the floor, silent');
ok(captureGapDecision({ filesTouched: 4, env: {} }) === null, 'a few edited files alone → below the floor, silent');
ok(captureGapDecision({ pushed: true, env: {} }) === null, 'a push with no commits of our own → silent');
ok(captureGapDecision({ commitTotal: 2, env: {} }) !== null, '≥2 undocumented commits → nudge');
ok(captureGapDecision({ commitTotal: 1, pushed: true, env: {} }) !== null, 'a commit that was pushed → nudge');
ok(captureGapDecision({ filesTouched: 6, env: {} }) !== null, '≥6 files edited and nothing recorded → nudge');

const ev = captureGapDecision({ shipped: ['merged PR #406'], commitTotal: 3, filesTouched: 7, env: {} });
const evText = ev.evidence.join(' · ');
ok(/merged PR #406/.test(evText), 'evidence names the ship');
ok(/3 new commits/.test(evText) && /no rationale body/.test(evText), 'evidence names the undocumented commits');
ok(/7 files edited/.test(evText), 'evidence names the edited files');

// ── DRAFT ────────────────────────────────────────────────────────────────────
const draft = draftCaptureMarker({
    shipped: ['merged PR #406'],
    commits: [{ subject: 'feat(format): register the media type with IANA' }, { subject: 'fix(schema): close 8 silent drift bugs' }],
    filesTouched: ['docs/SPEC.md', 'schema/agent.json', 'src/format/parse.ts'],
});
ok(draft.area === 'format', `area comes from the commit scope the author already wrote (got "${draft.area}")`);
ok(/merged PR #406/.test(draft.line), 'the draft pre-fills the ship');
ok(/register the media type with IANA/.test(draft.line), 'the draft pre-fills the commit subjects');
ok(/SPEC\.md/.test(draft.line), 'the draft pre-fills the files');
ok(draft.line.includes(WHY_SLOT), 'the draft leaves exactly ONE blank — why it matters');
ok(draft.line.split(WHY_SLOT).length === 2, 'the WHY slot appears once, not many times');
ok(/^🧠 BRAIN \[format\] !: /.test(draft.line), 'a ship drafts as a milestone marker, ready to paste verbatim');
ok(!/!:/.test(draftCaptureMarker({ commits: [{ subject: 'chore: tidy' }, { subject: 'chore: more' }] }).line),
   'a non-ship session drafts as a plain decision, not a milestone');

ok(inferArea({ commits: [{ subject: 'fix(canvas): x' }] }) === 'canvas', 'area: commit scope wins');
ok(inferArea({ filesTouched: ['src/canvas/a.ts', 'src/canvas/b.ts'] }) === 'canvas', 'area: src/ wrapper is skipped, the real dir wins');
ok(inferArea({}) === 'Ship', 'area: neutral fallback rather than an invented topic');

// A draft pasted back with its WHY slot still in it is a placeholder wearing a
// card's clothes — it would read to every future session as recorded reasoning,
// which is strictly worse than no card. The detector must match the slot this
// very module generates (the two would otherwise drift apart in silence).
ok(looksLikeUnfilledDraft(draft.line), 'an unfilled draft is detectable — the guard sentinel tracks the generated slot');
ok(!looksLikeUnfilledDraft(draft.line.replace(WHY_SLOT, 'it makes the spec a permanent public obligation')),
   'a FILLED draft is not flagged');
ok(!looksLikeUnfilledDraft('🧠 BRAIN [Auth]: switch to refresh tokens because sessions do not scale'),
   'an ordinary hand-written decision is never flagged');

const reason = captureGapReason({ ...ev, draft, mode: 'refuse' });
ok(/DRAFTED/.test(reason) && reason.includes(draft.line), 'the refusal hands over the drafted line itself');
ok(/harvests it/.test(reason), 'refuse mode tells the agent emitting the line is enough');
ok(/memory/.test(reason) && /NOT the project brain/.test(reason), 'the reason names the private-memory collision that caused the incident');
ok(/nothing durable/.test(reason), 'the reason lets a session end cleanly by saying there is nothing to keep');
const advice = captureGapReason({ ...ev, draft, mode: 'advise' });
ok(/brain_note/.test(advice) && !/Stop hook/.test(advice), 'advise mode (no lifecycle hook) points at brain_note instead');

// ── PROVENANCE (the per-session sidecar) ─────────────────────────────────────
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-gapstate-'));
    const file = path.join(dir, '.capture-gap.json');
    ok(sessionHasCaptured('s1', file) === false, 'unknown session has not captured');
    recordSessionCapture('s1', file);
    ok(sessionHasCaptured('s1', file) === true, 'a capture is remembered for the session that made it');
    ok(sessionHasCaptured('s2', file) === false, 'a PEER session is unaffected — this is the whole point of per-session provenance');
    recordCaptureGapNudge('s2', file);
    ok(readCaptureGapState(file).nudged.includes('s2'), 'a nudge is remembered so it fires once');
    ok(sessionHasCaptured('s2', file) === false, 'being nudged is not the same as having captured');
    recordSessionCapture('', file);
    ok(Object.keys(readCaptureGapState(file).captured).length === 1, 'an empty session id is ignored, not stored');

    recordTaskBaseline('s3', { head: 'abc123', project: dir }, file);
    ok(readTaskBaseline('s3')?.head === undefined, 'the baseline reader honours its own file argument');
    ok(readTaskBaseline('s3', file)?.head === 'abc123', 'a task baseline round-trips');
    ok(readCaptureGapState(file).captured.s1, 'writing a baseline preserves the capture receipts');
    clearTaskBaseline('s3', file);
    ok(readTaskBaseline('s3', file) === null, 'completing a task clears its baseline');
    fs.rmSync(dir, { recursive: true, force: true });
}

// Outcome receipts stay scoped, bounded, and never store transcript prose.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-outcomes-'));
    const file = path.join(dir, 'state.json');
    recordTaskBaseline('same', { head: 'aaa', project: dir }, file, 100);
    recordSessionCapture('same', file, 110, { project: dir, head: 'bbb' });
    ok(sessionCaptureReceipt('same', dir, file)?.head === 'bbb', 'capture checkpoints the observed HEAD');
    ok(sessionCaptureReceipt('peer', dir, file) === null, 'peer captures cannot cover this session');
    ok(sessionCaptureReceipt('same', path.join(dir, 'other'), file) === null, 'same session in another project has no capture receipt');
    recordCaptureGapNudge('same', file, 'outcome-a');
    ok(outcomeWasNudged('same', 'outcome-a', file), 'an outcome has its own reminder receipt');
    ok(!outcomeWasNudged('same', 'outcome-b', file), 'later outcomes remain nudgeable');
    const lines = ['private transcript line'];
    const first = captureTranscriptWindow('same', dir, lines, file, 120);
    recordTranscriptWindow('same', dir, first, file);
    ok(captureTranscriptWindow('same', dir, [...lines, 'new line'], file).start === 1, 'append-only reminder scan resumes after the prior outcome');
    ok(captureTranscriptWindow('same', dir, ['replacement'], file).start === 0, 'replacement transcript starts a fresh outcome');
    ok(!fs.readFileSync(file, 'utf8').includes('private transcript line'), 'reminder bookkeeping stores hashes, never transcript text');
    const crowded = readCaptureGapState(file);
    for (let i = 0; i < 305; i++) {
        crowded.receipts['prior-' + i] = { at: i, head: 'abc', project: dir };
        crowded.windows['prior-' + i] = { count: 1, digest: 'abc', at: i };
    }
    fs.writeFileSync(file, JSON.stringify(crowded));
    recordSessionCapture('newest', file, 600, { project: dir, head: 'abc' });
    recordTranscriptWindow('newest', dir, { count: 1, digest: 'abc', at: 600 }, file);
    const state = readCaptureGapState(file);
    ok(Object.keys(state.receipts).length === 300 && Object.keys(state.windows).length === 300, 'outcome receipt storage is bounded');
    fs.rmSync(dir, { recursive: true, force: true });
}
ok(captureGapDecision({ commitTotal: 3, commitCards: 1, env: {} }) !== null,
    'one rationale commit does not hide two undocumented commits');
ok(captureGapDecision({ commitTotal: 3, commitCards: 3, env: {} }) === null,
    'an outcome covered by rationale commits stays silent');
ok(/cause/.test(WHY_SLOT) && /attempts rejected/.test(WHY_SLOT) && /working solution/.test(WHY_SLOT)
    && /verification/.test(WHY_SLOT) && /ONLY where observed/.test(WHY_SLOT),
    'solution draft asks for grounded experience and omits unknown parts');
ok(/never invent/.test(captureGapReason({ draft })), 'draft instructs against invented rationale or test results');
const untrustedDraft = draftCaptureMarker({ area: 'Unsafe]\n[other', commits: [{ subject: 'fix: literal $(do-not-run)\nsecond line' }] });
ok(!untrustedDraft.line.includes('\n') && !/\[other\]/.test(untrustedDraft.line), 'artifact facts and area cannot inject extra draft lines');
ok(untrustedDraft.line.includes('$(do-not-run)'), 'command-shaped artifact prose stays literal data in the review draft');

// ── E2E — the real hook ──────────────────────────────────────────────────────
const home = path.join(os.tmpdir(), `klypix-gap-home-${process.pid}`);
const proj = path.join(os.tmpdir(), `klypix-gap-proj-${process.pid}`);
for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, 'brain.klypix'),
    await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));

const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.KLYPIX_BRAIN_NO_MAIN;

const TXT = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const SHELL = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
let runN = 0;
// Returns {code, stderr}. The hook exits 0 by contract; exit 2 is the ONE
// deliberate exception this test exists to lock. spawnSync, not execFileSync,
// because the hook says things on stderr while STILL exiting 0 (the
// unfilled-draft refusal is exactly that shape) and execFileSync only surfaces
// stderr when the process fails.
function runStop(transcript, sessionId, extraInput = {}) {
    const tp = path.join(home, `t-${runN++}.jsonl`);
    fs.writeFileSync(tp, transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [HOOK, '--capture'], {
        cwd: proj, env, encoding: 'utf8',
        input: JSON.stringify({ session_id: sessionId, transcript_path: tp, ...extraInput }),
    });
    return { code: r.status, stderr: String(r.stderr || '') };
}

const shipped = runStop([TXT('Merging the format PR now.'), SHELL('t1', 'gh pr merge 406 --squash')], 's-gap-1');
ok(shipped.code === 2, `a shipping session that recorded nothing refuses the stop (exit ${shipped.code}, want 2)`);
ok(/UNCAPTURED WORK/.test(shipped.stderr), 'the refusal reason reaches the model on stderr');
ok(/merged PR #406/.test(shipped.stderr), 'the reason names the ship it observed');
ok(/🧠 BRAIN \[/.test(shipped.stderr) && shipped.stderr.includes(WHY_SLOT),
   'the refusal hands over a ready-to-emit DRAFT, not homework');

const again = runStop([TXT('Nothing durable here.'), SHELL('t2', 'gh pr merge 407 --squash')], 's-gap-1');
ok(again.code === 2, `a NEW ship in the same session is a new outcome (exit ${again.code}, want 2)`);
const replay = runStop([TXT('Nothing durable here.'), SHELL('t2', 'gh pr merge 407 --squash')], 's-gap-1');
ok(replay.code === 0, 'replaying unchanged work does not repeat the outcome reminder');

const active = runStop([TXT('still nothing'), SHELL('t3', 'gh pr merge 408 --squash')], 's-gap-2', { stop_hook_active: true });
ok(active.code === 0, `stop_hook_active suppresses the nudge (exit ${active.code}, want 0)`);

const captured = runStop([TXT('🧠 BRAIN [Format]: registered application/vnd.agentmug.agent+json with IANA — the spec is now a permanent obligation.'), SHELL('t4', 'gh pr merge 409 --squash')], 's-gap-3');
ok(captured.code === 0, `a session that captured is never nudged (exit ${captured.code}, want 0)`);
// ...and that capture is remembered, so a LATER turn of the same session that
// ships in silence still stays quiet — without letting a peer's write do it.
ok(sessionHasCaptured('s-gap-3', path.join(home, '.claude', 'project-brain', '.capture-gap.json')),
   'an authored capture writes this session\'s receipt');
const laterTurn = runStop([TXT('shipping the follow-up'), SHELL('t5', 'gh pr merge 410 --squash')], 's-gap-3');
ok(laterTurn.code === 2, `an earlier capture does not hide a later outcome (exit ${laterTurn.code}, want 2)`);
const appendHistory = [TXT('🧠 BRAIN [Format]: initial rationale worth retaining for this test.'), SHELL('history1', 'gh pr merge 510 --squash')];
runStop(appendHistory, 's-gap-history');
const appended = runStop([...appendHistory, TXT('shipping follow-up silently'), SHELL('history2', 'gh pr merge 511 --squash')], 's-gap-history');
ok(appended.code === 2, 'an old marker in an append-only transcript cannot silence a new ship');
const appendedAgain = runStop([...appendHistory, TXT('shipping follow-up silently'), SHELL('history2', 'gh pr merge 511 --squash'), TXT('No further durable detail.')], 's-gap-history');
ok(appendedAgain.code === 0, 'a reply to an outcome reminder without new artifacts stays quiet');

// A PEER writing the shared brain must NOT buy silence for a session that
// shipped and said nothing — the defect the mtime-based first cut had.
fs.writeFileSync(path.join(proj, 'brain.klypix'),
    await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'a peer session wrote this just now' }] }] }));
const peerWrote = runStop([TXT('shipping, saying nothing'), SHELL('t6', 'gh pr merge 411 --squash')], 's-gap-peer');
ok(peerWrote.code === 2, `a peer's brain write does NOT silence this session's gap (exit ${peerWrote.code}, want 2)`);

const quiet = runStop([TXT('just answered a question')], 's-gap-4');
ok(quiet.code === 0, `a session with no artifacts exits 0 as always (exit ${quiet.code}, want 0)`);

// END TO END: pasting the draft back UNFILLED must not bank a placeholder card,
// and the session must be told why. Pasting it FILLED must capture normally —
// the draft is only worth offering if the filled form actually round-trips
// through the very marker parser the hook uses.
{
    const brainPath = path.join(proj, 'brain.klypix');
    // Card text is stored WRAPPED — the engine inserts newlines to fit the card
    // frame, mid-phrase. Any multi-word assertion has to flatten whitespace
    // first, or it matches nothing and passes vacuously.
    const flat = (s) => String(s).replace(/\s+/g, ' ');
    const cardsIn = async () => {
        const { parseKlypix } = await import('../src/klypix-format.mjs');
        const { struct } = await parseKlypix(fs.readFileSync(brainPath));
        return (struct.cards || []).map((c) => flat(c.text || ''));
    };
    const unfilled = runStop([TXT(draft.line)], 's-gap-unfilled');
    ok(!(await cardsIn()).some((t) => t.includes('WHY THIS MATTERS: <')),
       'a draft pasted back UNFILLED is refused — no placeholder card is banked');
    ok(/WHY THIS MATTERS/.test(unfilled.stderr) && /placeholder/i.test(unfilled.stderr),
       'the session is told exactly why the unfilled draft was dropped');

    const filledLine = draft.line.replace(WHY_SLOT, 'the registration is permanent and binds every future schema change');
    runStop([TXT(filledLine)], 's-gap-filled');
    ok((await cardsIn()).some((t) => /permanent and binds every future schema change/.test(t)),
       'the FILLED draft round-trips through the real marker parser into a real card');
}

// MCP completion: task boundaries and a capture's HEAD checkpoint, exercised
// through the real worker. git arguments are arrays; no draft text is executed.
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-outcome-mcp-'));
    const project = path.join(root, 'project'), workerHome = path.join(root, 'home');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(workerHome, { recursive: true });
    fs.writeFileSync(path.join(project, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: [{ title: 'Test', cards: [{ text: 'fixture' }] }] }));
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.name', 'Outcome test'); git('config', 'user.email', 'outcome@example.test');
    git('add', 'brain.klypix'); git('commit', '-qm', 'fixture');
    let commit = 0;
    const land = (body = '') => {
        fs.writeFileSync(path.join(project, 'work.txt'), String(++commit));
        git('add', 'work.txt');
        git('commit', '-qm', 'fix: outcome ' + commit, ...(body ? ['-m', body] : []));
    };
    const client = new Client({ name: 'outcome-test', version: '1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(path.dirname(HOOK), '..', 'bin', 'klypix-worker.mjs'), '--vault', project], cwd: project,
        env: { ...process.env, HOME: workerHome, USERPROFILE: workerHome, KLYPIX_SESSION_ID: 'outcome-test', KLYPIX_AUTO_UPDATE: '0' }, stderr: 'pipe' });
    const text = (r) => r.content?.map(c => c.text || '').join('\n') || '';
    const sync = (phase) => client.callTool({ name: 'brain_sync', arguments: { project, phase, ...(phase === 'start' ? { intent: 'Test outcome capture', files: ['work.txt'], include_context: false } : {}) } });
    const note = () => client.callTool({ name: 'brain_note', arguments: { area: 'Test', text: 'Earlier verified outcome ' + commit + ': record why this result matters for future tasks.' } });
    try {
        await client.connect(transport);
        await sync('start'); await note(); land(); land();
        ok(/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: early note cannot hide two later commits in the same task');
        ok(!/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: repeated completion without new work stays quiet');
        await sync('start'); land(); land();
        ok(/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: the next task in the same session remains nudgeable');
        await sync('start'); land(); land(); await note();
        ok(!/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: a successful note after the commits covers that outcome');
        await sync('start'); land('The causal change is documented here so future work can reuse the fix.'); land('The verification and applicability are documented for this second outcome.');
        ok(!/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: rationale-bearing commits remain valid capture');
        await sync('start'); land('One rationale exists but it does not describe the following fixes.'); land(); land();
        ok(/UNCAPTURED WORK/.test(text(await sync('complete'))), 'MCP: one rationale commit does not cover two later undocumented commits');
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// The gap is also durably observable, per-project, for anyone auditing later.
const healthDir = path.join(home, '.claude', 'project-brain', 'health');
const health = fs.existsSync(healthDir)
    ? fs.readdirSync(healthDir).map((f) => fs.readFileSync(path.join(healthDir, f), 'utf8')).join('\n') : '';
ok(/capture-gap/.test(health), 'the nudge leaves a health-log breadcrumb');
ok(/"drafted":true/.test(health), 'the breadcrumb records that a draft was offered');

console.log(failures === 0 ? '\n✓ capture-gap: all assertions passed' : `\n✗ capture-gap: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
