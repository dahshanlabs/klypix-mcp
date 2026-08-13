// Capture write-failure discipline — the field failure class no other suite covers.
//
// .hook-health.jsonl recorded three real capture failures (2026-08-11/12):
// `EPERM: rename brain.klypix.tmp-* -> brain.klypix` — Windows rejects
// rename-over-open/readonly destinations while a desktop save, AV pass, or
// indexer briefly holds the brain. Before this suite's fixes, a single rename
// attempt threw, the batch was NOT queued (only lock-refusals queued), and a
// session's FINAL Stop lost its markers silently.
//
// Locked here:
//   • atomicWrite retries retryable rename errors (EPERM/EBUSY/EACCES) with
//     bounded backoff, succeeds when the hold clears, throws when it persists,
//     and never litters tmp files;
//   • a real hook capture whose brain WRITE fails exits 0, leaves the brain
//     untouched, queues its own batch durably, and a later capture drains it;
//   • when the brain lock AND the pending lock are both held (correlated —
//     the trigger is one desktop save), the batch lands in an orphan sidecar,
//     and a later capture drains AND deletes the orphan.
//
// Run:  node test/capture-write-failure.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { atomicWrite, buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
import { brainCaptureLockPath } from '../src/brain-write-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'src', 'global-brain-hook.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// ── Suite 1: atomicWrite bounded retry (in-process, deterministic) ───────────
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-awretry-'));
    const file = path.join(dir, 'canvas.klypix'); // NOT brain-named: keeps restore-point machinery out of a unit test
    const bufA = await buildKlypixMap({ title: 'c', areas: [{ title: 'A', cards: [{ text: 'first' }] }] });
    const bufB = await buildKlypixMap({ title: 'c', areas: [{ title: 'A', cards: [{ text: 'second' }] }] });
    fs.writeFileSync(file, bufA);

    const realRename = fs.renameSync;
    try {
        // Transient hold: first two renames throw EPERM, then the hold clears.
        let calls = 0;
        fs.renameSync = (...args) => {
            calls++;
            if (calls <= 2) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
            return realRename(...args);
        };
        await atomicWrite(file, bufB, { snapshot: false });
        ok(calls === 3, `transient EPERM: retried and succeeded on attempt 3 (got ${calls})`);
        const { struct } = await parseKlypix(fs.readFileSync(file));
        ok(struct.cards.some((c) => /second/.test(c.text)), 'transient EPERM: the retried write landed the new content');

        // Persistent hold: every rename throws → atomicWrite must give up and rethrow.
        let persistentCalls = 0;
        fs.renameSync = () => { persistentCalls++; const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
        let threw = null;
        try { await atomicWrite(file, bufA, { snapshot: false }); } catch (e) { threw = e; }
        ok(threw?.code === 'EPERM', 'persistent EPERM: rethrown to the caller after the backoff budget');
        ok(persistentCalls === 6, `persistent EPERM: bounded attempts (1 + 5 backoffs, got ${persistentCalls})`);

        // Non-retryable: fail once, immediately.
        let enoentCalls = 0;
        fs.renameSync = () => { enoentCalls++; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
        threw = null;
        try { await atomicWrite(file, bufA, { snapshot: false }); } catch (e) { threw = e; }
        ok(threw?.code === 'ENOENT' && enoentCalls === 1, `non-retryable code: exactly one attempt, no backoff (got ${enoentCalls})`);
    } finally {
        fs.renameSync = realRename;
    }
    const litter = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    ok(litter.length === 0, `no tmp litter after failed writes (found ${litter.length})`);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── Shared harness for the hook subprocess suites ────────────────────────────
const home = path.join(os.tmpdir(), 'klypix-wfail-home');
const proj = path.join(os.tmpdir(), 'klypix-wfail-proj');
for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
const brain = path.join(proj, 'brain.klypix');
fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));

const LOCK = brainCaptureLockPath(brain);
const lane = laneFileFor(brain, home);
const PENDING = path.join(home, '.claude', 'project-brain', 'pending', path.basename(lane).replace(/\.json$/, '.captures.json'));
const HEALTH = path.join(home, '.claude', 'project-brain', '.hook-health.jsonl');

const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.KLYPIX_BRAIN_NO_MAIN;

const TXT = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
let runN = 0;
function runHookCapture(transcript, sessionId) {
    const tp = path.join(home, `t-${runN++}.jsonl`);
    fs.writeFileSync(tp, transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return execFileSync(process.execPath, [HOOK, '--capture'], {
        cwd: proj, env, encoding: 'utf8',
        input: JSON.stringify({ session_id: sessionId, transcript_path: tp }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
async function brainCards() {
    const { struct } = await parseKlypix(fs.readFileSync(brain));
    return (struct.cards || []).map((c) => String(c.text || ''));
}
const readPending = () => { try { const d = JSON.parse(fs.readFileSync(PENDING, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };
const orphanFiles = () => {
    try { return fs.readdirSync(path.dirname(PENDING)).filter((n) => n.startsWith(path.basename(PENDING) + '.orphan-') && !/\.tmp-/.test(n)); }
    catch { return []; }
};
// Make the brain's rename-over fail for a subprocess: readonly FILE blocks
// MoveFileEx(REPLACE_EXISTING) on Windows (EPERM — the exact field error);
// readonly DIR blocks the tmp write on POSIX (EACCES — same retryable class).
const blockBrainWrites = () => { if (process.platform === 'win32') fs.chmodSync(brain, 0o444); else fs.chmodSync(proj, 0o555); };
const unblockBrainWrites = () => { if (process.platform === 'win32') fs.chmodSync(brain, 0o666); else fs.chmodSync(proj, 0o755); };

// ── Suite 2: hook write-failure → own batch queued → later capture drains ────
{
    blockBrainWrites();
    let exitedZero = true;
    try { runHookCapture([TXT('🧠 BRAIN [Goal]: write-failure marker survives via the queue')], 's-wfail-1'); }
    catch { exitedZero = false; }
    unblockBrainWrites();
    ok(exitedZero, 'write-blocked capture still exits 0 (the hook contract)');
    const cardsAfterFail = await brainCards();
    ok(!cardsAfterFail.some((t) => /write-failure marker/.test(t)), 'blocked write left the brain untouched');
    const queued = readPending();
    ok(queued.some((b) => (b.cards || []).some((c) => /write-failure marker/.test(String(c.text || '')))), 'own batch was QUEUED durably on write failure');
    let health = '';
    try { health = fs.readFileSync(HEALTH, 'utf8'); } catch { /* */ }
    ok(/write failed/.test(health) && /QUEUED durably/.test(health), 'health log tells the truth: write failed, batch queued');

    runHookCapture([TXT('no markers this time')], 's-wfail-2');
    const cardsAfterDrain = await brainCards();
    ok(cardsAfterDrain.some((t) => /write-failure marker/.test(t)), 'next capture drained the queued batch into the brain');
    ok(readPending().length === 0, 'queue cleared only after the durable write');
}

// ── Suite 3: brain lock + pending lock both held → orphan sidecar → drain ────
{
    fs.writeFileSync(LOCK, 'held-by-test');                     // hook refuses the brain write
    fs.mkdirSync(path.dirname(PENDING), { recursive: true });
    fs.writeFileSync(PENDING + '.lock', 'held-by-test');        // RMW queue path contended too
    runHookCapture([TXT('🧠 BRAIN [Goal]: orphan fallback marker')], 's-orphan-1');
    ok(orphanFiles().length === 1, `orphan sidecar created when both locks were held (got ${orphanFiles().length})`);
    ok(!readPending().some((b) => (b.cards || []).some((c) => /orphan fallback/.test(String(c.text || '')))), 'contended main queue file was NOT blind-written');
    fs.unlinkSync(LOCK);
    fs.unlinkSync(PENDING + '.lock');

    runHookCapture([TXT('still no markers')], 's-orphan-2');
    const cards = await brainCards();
    ok(cards.some((t) => /orphan fallback marker/.test(t)), 'orphan batch drained into the brain');
    ok(orphanFiles().length === 0, 'drained orphan file deleted only after the durable write');
}

for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* win32 lingering handles */ } }
console.log(failures === 0 ? '\n✓ capture-write-failure: all assertions passed' : `\n✗ capture-write-failure: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
