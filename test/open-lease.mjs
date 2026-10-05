// open-lease — P0 agent parity: never lose an AI tool's cards on a canvas that
// is open in KLYPIX.
//
// A running KLYPIX (the build that writes the lease) lists the canvases it has
// open in endpoint.json. Every klypix-mcp writer — add_to_canvas, the
// klypix-append CLI, the klypix-write CLI — refuses such a canvas and leaves its
// bytes untouched (OPEN_IN_APP); a dead pid is a stale lease and the write goes
// ahead; with no lease at all on Windows (KLYPIX closed, or a build from before
// the lease) the write goes ahead and the reply ends with the MAY_BE_OPEN step.
// Project brains are unaffected: KLYPIX merges them. Ordinary canvases lock in
// the profile, so no `.claude` folder ever appears beside them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-open-lease-'));
const home = path.join(tmp, 'home');
const vault = path.join(tmp, 'vault');
const bridge = path.join(tmp, 'appdata', 'agent-bridge');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(bridge, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.KLYPIX_APP_BRIDGE_DIR = bridge;
delete process.env.KLYPIX_APP_TOOLS;

const { buildPlainCanvas } = await import('./_parity-fixture.mjs');
const { buildKlypixMap, parseKlypix } = await import('../src/klypix-format.mjs');
const { opAddToCanvas } = await import('../src/klypix-core.mjs');
const { pathHash, canvasWriteLockPath, APP_BRIDGE_PROTOCOL } = await import('../src/app-lease.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const childEnv = () => ({ ...process.env, HOME: home, USERPROFILE: home, KLYPIX_APP_BRIDGE_DIR: bridge });
const lastText = (r) => [...(r.blocks || [])].reverse().find(b => b.kind === 'text')?.text || '';

const canvas = await buildPlainCanvas(vault);
// The brain sits in its own project folder: a brain's folder lock legitimately
// creates <folder>/.claude, and that must not be confused with the canvas's.
const brain = path.join(vault, 'project', 'brain.klypix');
fs.mkdirSync(path.dirname(brain), { recursive: true });
fs.writeFileSync(brain, await buildKlypixMap({ title: 'lease brain', kind: 'brain', areas: [{ title: 'Base', cards: [{ text: 'base card' }] }] }));

const endpoint = path.join(bridge, 'endpoint.json');
const writeLease = (pid, files) => fs.writeFileSync(endpoint, JSON.stringify({
  v: 1, protocol: APP_BRIDGE_PROTOCOL, pid, appVersion: '1.3.177', startedAt: new Date().toISOString(), access: 'off', openFiles: files.map(pathHash),
}));
const deadPid = (() => { const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }); return r.pid; })();
const additionFile = path.join(tmp, 'addition.json');
fs.writeFileSync(additionFile, JSON.stringify({ cards: [{ text: 'card from klypix-append' }] }));
const specFile = path.join(tmp, 'spec.json');
fs.writeFileSync(specFile, JSON.stringify({ title: 'Replacement', cards: [{ text: 'replacement card' }] }));
const append = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'klypix-append.mjs'), canvas, additionFile], { encoding: 'utf8', env: childEnv() });
const write = (...extra) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'klypix-write.mjs'), specFile, '--out', canvas, ...extra], { encoding: 'utf8', env: childEnv() });

// ── 1. A live lease naming the canvas: every writer refuses, bytes unchanged ──
{
  writeLease(process.pid, [canvas, brain]);
  const before = fs.readFileSync(canvas);
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'should not land' }], via: 'codex' });
  ok(r.isError === true && r.structured?.ok === false && r.structured?.code === 'OPEN_IN_APP', 'add_to_canvas refuses a canvas open in KLYPIX (OPEN_IN_APP, isError)');
  ok(lastText(r).startsWith("Tell the user: 'Plain board' is open in KLYPIX. Close its tab"), `the last line is KLYPIX's sentence for the user (got: ${lastText(r)})`);
  ok(fs.readFileSync(canvas).equals(before), 'add_to_canvas wrote nothing');
  const a = append();
  ok(a.status === 1 && /OPEN_IN_APP/.test(a.stderr) && /Tell the user: 'Plain board' is open in KLYPIX/.test(a.stderr), 'klypix-append refuses it too');
  ok(fs.readFileSync(canvas).equals(before), 'klypix-append wrote nothing');
  const w = write('--force');
  ok(w.status === 1 && /OPEN_IN_APP/.test(w.stderr), 'klypix-write --force refuses to replace an open canvas');
  ok(fs.readFileSync(canvas).equals(before), 'klypix-write wrote nothing');

  // Brains are the exception: KLYPIX merges them and shows the cards live.
  const b = await opAddToCanvas({ vault, canvas: brain, cards: [{ text: 'brain card while open' }], via: 'codex' });
  const { struct } = await parseKlypix(fs.readFileSync(brain));
  ok(!b.isError && struct.cards.some(c => String(c.text).includes('brain card while open')), 'a project brain open in KLYPIX is still written (brains merge)');
  ok(lastText(b).includes('It appears in the brain if it is open in KLYPIX'), 'the brain reply says where it appears, not "reopen"');
}

// ── 2. klypix-write never replaces an existing file without --force ──────────
{
  fs.rmSync(endpoint, { force: true });
  writeLease(deadPid, [canvas]);
  const before = fs.readFileSync(canvas);
  const w = write();
  ok(w.status === 1 && /already exists/.test(w.stderr) && fs.readFileSync(canvas).equals(before), 'klypix-write refuses to overwrite an existing file without --force');
}

// ── 3. A dead pid is a stale lease: the writers go ahead ─────────────────────
{
  writeLease(deadPid, [canvas]);
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'landed after KLYPIX quit' }], via: 'codex' });
  ok(!r.isError && r.structured?.ok === true && r.structured?.mode === 'file' && !r.structured?.code, 'add_to_canvas writes when the lease pid is dead, with no warning');
  ok(Array.isArray(r.structured?.card_ids) && r.structured.card_ids.length === 1, 'and returns the new card id');
  ok(r.blocks[0].text.startsWith("Added 1 card to 'Plain board'. They appear when the canvas is next opened in KLYPIX."), 'the reply says when the cards appear, not "reopen"');
  const a = append();
  ok(a.status === 0, `klypix-append writes when the lease is stale (${a.stderr.trim()})`);
  const { struct } = await parseKlypix(fs.readFileSync(canvas));
  ok(struct.cards.some(c => c.text === 'landed after KLYPIX quit') && struct.cards.some(c => c.text === 'card from klypix-append'), 'both cards are in the file');
  const w = write('--force');
  ok(w.status === 0 && !/Tell the user/.test(w.stdout), 'klypix-write --force replaces it when the lease is stale');
  await buildPlainCanvas(vault); // restore the fixture for the next block
}

// ── 4. No lease at all on Windows: write, and end with MAY_BE_OPEN ────────────
{
  fs.rmSync(endpoint, { force: true });
  process.env.KLYPIX_APP_TOOLS = 'on'; // behave like Windows on any system
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'written with no lease' }], via: 'codex' });
  ok(!r.isError && r.structured?.ok === true && r.structured?.code === 'MAY_BE_OPEN', 'with no endpoint.json the write succeeds, flagged MAY_BE_OPEN (ok stays true)');
  ok(lastText(r).startsWith("Tell the user: If 'Plain board' is open in KLYPIX, close its tab and open it again now: KLYPIX versions before"), `the reply ends with the MAY_BE_OPEN sentence (got: ${lastText(r)})`);
  const a = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'klypix-append.mjs'), canvas, additionFile], { encoding: 'utf8', env: { ...childEnv(), KLYPIX_APP_TOOLS: 'on' } });
  ok(a.status === 0 && /Tell the user: If 'Plain board' is open in KLYPIX/.test(a.stdout), 'klypix-append prints the same step');
  delete process.env.KLYPIX_APP_TOOLS;
  if (process.platform !== 'win32') {
    const quiet = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'no warning off Windows' }] });
    ok(!quiet.isError && !quiet.structured?.code, 'off Windows (where KLYPIX cannot run) there is nothing to warn about');
  }
}

// ── 5. Ordinary canvases lock in the profile; no `.claude` folder beside them ─
{
  const lock = canvasWriteLockPath(canvas, home);
  ok(lock.startsWith(path.join(home, '.claude', 'project-brain', 'locks')), 'the lock path is under ~/.claude/project-brain/locks/');
  ok(fs.existsSync(path.dirname(lock)), 'add_to_canvas created that locks folder (it took the lock)');
  ok(!fs.existsSync(path.join(vault, '.claude')), 'no .claude folder appeared beside the canvas');
  // Hold the profile lock: add_to_canvas must wait on exactly that path and refuse.
  fs.writeFileSync(lock, 'held-by-test');
  const before = fs.readFileSync(canvas);
  const held = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'blocked by the lock' }] });
  ok(held.isError === true && /lock/i.test(held.blocks[0].text) && fs.readFileSync(canvas).equals(before), 'a held profile lock blocks the write (the path really is the lock)');
  fs.rmSync(lock, { force: true });
  ok(fs.existsSync(path.join(vault, '.claude')) === false, 'still no .claude folder beside the canvas after klypix-append');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ open-lease: all assertions passed');
process.exit(failures ? 1 : 0);
