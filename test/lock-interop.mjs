// Write-lock INTEROP — the cross-writer contention paths no other suite covers.
//
// test/concurrent-writes.mjs proves the ENGINE serializes against itself. This
// suite proves the writers that used to sit OUTSIDE the lock protocol now obey
// one shared contract on one brain:
//   • the Stop hook REFUSES to write while the lock is held, queues its batch
//     durably, and a later capture drains the queue under the lock (the
//     2026-08-05 audit's #1 lost-update path: "lock-timeout — wrote best-effort");
//   • brain-note (CLI) refuses on a held lock and steals a genuinely stale one;
//   • append-klypix (CLI) refuses on a held lock;
//   • hook + brain-note + append racing concurrently all land — no lost update.
//
// Run:  node test/lock-interop.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
import { brainCaptureLockPath } from '../src/brain-write-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'src', 'global-brain-hook.mjs');
const NOTE = path.join(ROOT, 'src', 'brain-note.mjs');
const APPEND = path.join(ROOT, 'bin', 'klypix-append.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const home = path.join(os.tmpdir(), 'klypix-lockinterop-home');
const proj = path.join(os.tmpdir(), 'klypix-lockinterop-proj');
for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
const brain = path.join(proj, 'brain.klypix');
fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));

const LOCK = brainCaptureLockPath(brain);
const lane = laneFileFor(brain, home);
const PENDING = path.join(home, '.claude', 'project-brain', 'pending', path.basename(lane).replace(/\.json$/, '.captures.json'));

const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
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
const holdLock = () => { fs.mkdirSync(path.dirname(LOCK), { recursive: true }); fs.writeFileSync(LOCK, 'interop-test-holder', { flag: 'wx' }); };
const dropLock = () => { try { fs.unlinkSync(LOCK); } catch { /* */ } };

try {
  // ── 1. Stop hook: held lock → refuse + queue, brain untouched ─────────────
  holdLock();
  let hookErr = '';
  try { runHookCapture([TXT('🧠 BRAIN [Goal]: alpha decision — the interop suite exists')], 'sess-a'); }
  catch (e) { hookErr = String(e.stderr || e.message || e); }
  // execFileSync captures stderr on success too — re-run pattern: hook exits 0.
  let cards = await brainCards();
  ok(!cards.some((t) => t.includes('alpha decision')), 'hook capture under a held lock leaves the brain untouched');
  const queued = (() => { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return []; } })();
  ok(Array.isArray(queued) && queued.length === 1 && JSON.stringify(queued).includes('alpha decision'), 'the refused batch is queued durably in the pending sidecar');

  // ── 2. Drain: lock released → an EMPTY capture lands the queued batch ─────
  dropLock();
  runHookCapture([TXT('nothing to capture this turn')], 'sess-b');
  cards = await brainCards();
  ok(cards.some((t) => t.includes('alpha decision')), 'the next capture drains the queued batch into the brain');
  const drained = (() => { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return []; } })();
  ok(Array.isArray(drained) && drained.length === 0, 'a landed batch is cleared from the queue (no double-capture)');

  // ── 3. brain-note CLI: held lock → refuse (exit 1), stale lock → steal ────
  holdLock();
  let noteFailed = false; let noteMsg = '';
  try { execFileSync(process.execPath, [NOTE, 'beta decision from the CLI', '--area', 'Goal', brain], { cwd: proj, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { noteFailed = true; noteMsg = String(e.stderr || ''); }
  cards = await brainCards();
  ok(noteFailed && /refused|lock/i.test(noteMsg) && !cards.some((t) => t.includes('beta decision')), 'brain-note refuses on a held lock and leaves the brain unchanged');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(LOCK, old, old);   // genuinely stale now
  execFileSync(process.execPath, [NOTE, 'beta decision from the CLI', '--area', 'Goal', brain], { cwd: proj, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  cards = await brainCards();
  ok(cards.some((t) => t.includes('beta decision')), 'brain-note steals a genuinely stale lock and writes');
  ok(!fs.existsSync(LOCK), 'the stolen lock is cleaned up after the write');

  // ── 4. append-klypix CLI: held lock → refuse ──────────────────────────────
  holdLock();
  const additionPath = path.join(home, 'addition.json');
  fs.writeFileSync(additionPath, JSON.stringify({ cards: [{ text: 'gamma card via append' }] }));
  let appendFailed = false; let appendMsg = '';
  try { execFileSync(process.execPath, [APPEND, brain, additionPath], { cwd: proj, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { appendFailed = true; appendMsg = String(e.stderr || ''); }
  cards = await brainCards();
  ok(appendFailed && /refused|lock/i.test(appendMsg) && !cards.some((t) => t.includes('gamma card')), 'append-klypix refuses on a held lock and leaves the file unchanged');
  dropLock();

  // ── 5. All three writers CONCURRENTLY on one brain → nothing lost ─────────
  const spawnP = (args, input) => new Promise((resolve) => {
    const child = execFile(process.execPath, args, { cwd: proj, env, encoding: 'utf8' }, () => resolve());
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
  const tp = path.join(home, 't-conc.jsonl');
  fs.writeFileSync(tp, JSON.stringify(TXT('🧠 BRAIN [Goal]: delta decision from the hook')) + '\n');
  await Promise.all([
    spawnP([HOOK, '--capture'], JSON.stringify({ session_id: 'sess-c', transcript_path: tp })),
    spawnP([NOTE, 'epsilon decision from a second writer', '--area', 'Goal', brain]),
    spawnP([APPEND, brain, additionPath]),
  ]);
  cards = await brainCards();
  ok(cards.some((t) => t.includes('delta decision')), 'concurrent race: the hook capture survived');
  ok(cards.some((t) => t.includes('epsilon decision')), 'concurrent race: the brain-note write survived');
  ok(cards.some((t) => t.includes('gamma card')), 'concurrent race: the append write survived');
} finally {
  dropLock();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} lock-interop assertion(s) failed` : '\n✓ lock-interop: all assertions passed');
process.exit(failures ? 1 : 0);
