// app-bridge-client — klypix-mcp's client of the KLYPIX app bridge (agent tool
// parity P1) against a fake bridge server in this process (test/_fake-app-
// bridge.mjs: the app's server.ts handshake and refusals, over a named pipe on
// Windows and a Unix socket elsewhere).
//
// What it proves:
//   - discovery re-reads endpoint.json on every call; a dead pid, a protocol
//     bump, access off and a stray pipe each give KLYPIX's own code, and access
//     off never even connects;
//   - a wrong token never gets a call through, and a server that cannot prove
//     itself receives NO tool arguments;
//   - a blocked tool gets BLOCKED from KLYPIX;
//   - the 45 s deadline (shortened here) returns still_reading for a read and
//     a non-committal answer for anything else; the host's cancel becomes a
//     bridge cancel;
//   - a restart (new token, new pipe) is picked up; a drop before the call is
//     retried once; a drop after a READ is re-sent once, after a WRITE never;
//   - clientInfo.name '../../x', 'Claude Desktop', 'claude-ai' give safe,
//     distinct keys;
//   - no token, pipe name or endpoint content appears in any result or event.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFakeApp, fakeStatus } from './_fake-app-bridge.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-'));
const dir = path.join(tmp, 'bridge');
process.env.KLYPIX_APP_BRIDGE_DIR = dir;
const { callApp, discoverApp, readBridgeToken, tokenDir, CLIENT_KEY } = await import('../src/app-bridge-client.mjs');

const events = [];
const outcomes = [];
const call = async (method, params = {}, opts = {}) => {
  const r = await callApp(method, params, { clientName: 'codex-mcp-client', clientVersion: '0.50.0', onEvent: (e) => events.push(e), ...opts });
  outcomes.push(r);
  return r;
};
const secretsOf = (app) => [app.token, app.pipe, fs.existsSync(path.join(dir, 'endpoint.json')) ? fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8') : null].filter(Boolean);
const seen = [];

// ── No KLYPIX at all ─────────────────────────────────────────────────────────
{
  const r = await call('status');
  ok(r.reached === false && r.outcome.ok === false && r.outcome.code === 'APP_NOT_RUNNING' && r.outcome.tell_user === 'This needs the KLYPIX app open on this PC. Open KLYPIX, then ask me again.',
    'no endpoint.json → APP_NOT_RUNNING with KLYPIX\'s sentence, nothing reached');
  ok(tokenDir() === path.resolve(dir), 'with KLYPIX_APP_BRIDGE_DIR set, the token is read from that folder too');
}

// ── A live fake KLYPIX ───────────────────────────────────────────────────────
let slowRelease = null;
const handlers = {
  status: async (_p, ctx) => fakeStatus(ctx),
  read_card_contents: async (p, { signal }) => {
    if (p.card_ids?.[0] === 'slow') {
      await new Promise((resolve) => { slowRelease = resolve; signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 8000); });
      return { ok: true, results: [], aborted: signal.aborted };
    }
    return { ok: true, canvas: 'Board', results: [{ card_id: p.card_ids?.[0], card_type: 'link', status: 'saved', paid_by: 'none', text: 'x' }], request_id: 'req_1' };
  },
  add_to_canvas: async (p) => ({ ok: true, canvas: 'Board', added: p.cards.length, card_ids: p.cards.map((_, i) => `txt_${i}`), connections: 0 }),
  show_in_klypix: async () => { await sleep(5000); return { ok: true }; },
};
const app = await startFakeApp({ dir, handlers });
seen.push(...secretsOf(app));
{
  const d = discoverApp();
  ok(d.state === 'ready' && d.access === 'on' && typeof d.pipe === 'string' && !JSON.stringify(d).includes(app.pipe), 'discovery finds the pipe, but it is not enumerable: serializing the target never carries it');
  ok(readBridgeToken() === app.token, 'the token is read from the token file');
  const r = await call('status');
  ok(r.reached === true && r.outcome.ok === true && r.outcome.mode === 'app' && r.outcome.selection?.[0] === 'txt_one', 'status: the handshake completes and KLYPIX answers (app mode)');
  const hello = app.log.hellos.at(-1);
  ok(hello.protocol === 'klypix-app-bridge/1' && hello.clientKey === 'codex-mcp-client' && hello.clientLabel === 'Codex' && hello.clientName === 'codex-mcp-client' && hello.clientVersion === '0.50.0',
    'hello carries the protocol, the strict key, the label, the raw name and the version');
}

// ── Wrong token: no call ever goes through ───────────────────────────────────
{
  app.state.serverToken = 'f'.repeat(64);
  const callsBefore = app.log.calls.length;
  const r = await call('read_card_contents', { canvas: 'Board', card_ids: ['lnk_1'] });
  ok(r.reached === false && r.outcome.code === 'AUTH_FAILED' && /did not accept/.test(r.outcome.tell_user), 'a token KLYPIX does not hold → AUTH_FAILED (after one re-read and retry)');
  ok(app.log.calls.length === callsBefore && app.log.events.filter(e => e === 'auth-failed').length === 2, 'KLYPIX saw two failed proofs and not a single call frame');
  app.state.serverToken = null;
}

// ── A squatter that cannot prove itself gets NO arguments ────────────────────
{
  app.state.squatter = true;
  const r = await call('add_to_canvas', { canvas: 'Board', cards: [{ text: 'SECRET-PAYLOAD-NEVER-SENT' }] });
  ok(r.reached === false && r.outcome.code === 'APP_UNVERIFIED', 'a server whose proof does not match → APP_UNVERIFIED');
  ok(app.log.leaked.length === 0 && !JSON.stringify(app.log).includes('SECRET-PAYLOAD-NEVER-SENT'), 'the squatter received no tool arguments at all (the proof is checked first)');
  app.state.squatter = false;
}

// ── Access off: no pipe, no connection ───────────────────────────────────────
{
  await app.setAccess(false);
  const before = app.log.connections;
  const r = await call('status');
  ok(r.reached === false && r.outcome.code === 'ACCESS_OFF' && r.outcome.tell_user.startsWith('AI tools are turned off in KLYPIX'), 'access off → ACCESS_OFF with KLYPIX\'s sentence');
  ok(app.log.connections === before, 'and no connection was attempted (KLYPIX has no pipe while access is off)');
  await app.setAccess(true);
  seen.push(...secretsOf(app));
}

// ── Blocked ──────────────────────────────────────────────────────────────────
{
  app.block('codex-mcp-client');
  const r = await call('read_card_contents', { canvas: 'Board', card_ids: ['lnk_1'] });
  ok(r.reached === true && r.outcome.ok === false && r.outcome.code === 'BLOCKED' && r.outcome.tell_user.startsWith('You blocked Codex in KLYPIX'), 'a blocked tool gets BLOCKED from KLYPIX itself');
  const other = await call('status', {}, { clientName: 'Claude Desktop' });
  ok(other.outcome.ok === true, 'another tool is unaffected by that block');
  app.block('codex-mcp-client', false);
}

// ── Stale endpoint, protocol bump, stray pipe ────────────────────────────────
{
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const ep = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ ...ep, pid: Number(dead.stdout) }));
  let r = await call('status');
  ok(r.reached === false && r.outcome.code === 'APP_NOT_RUNNING', 'a stale endpoint.json (dead pid) → APP_NOT_RUNNING');
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ ...ep, protocol: 'klypix-app-bridge/2' }));
  r = await call('status');
  ok(r.reached === false && r.outcome.code === 'APP_UPDATE_REQUIRED', 'another protocol → APP_UPDATE_REQUIRED');
  const stray = process.platform === 'win32' ? `${String.fromCharCode(92).repeat(2)}.${String.fromCharCode(92)}pipe${String.fromCharCode(92)}spoolss` : 'relative.sock';
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ ...ep, pipe: stray }));
  const before = app.log.connections;
  r = await call('status');
  ok(r.reached === false && r.outcome.code === 'APP_UNVERIFIED' && app.log.connections === before, 'a pipe that is not a KLYPIX bridge pipe is never connected to');
  app.writeEndpoint();
}

// ── Deadline → still_reading; repeat attaches ────────────────────────────────
{
  const t0 = Date.now();
  const r = await call('read_card_contents', { canvas: 'Board', card_ids: ['slow'], wait_seconds: 40 }, { deadlineMs: 1500 });
  const took = Date.now() - t0;
  ok(r.reached === true && r.outcome.ok === true && r.outcome.status === 'still_reading' && r.outcome.retry_after_seconds === 15 && took < 3000,
    `a read past the deadline returns still_reading with retry_after_seconds (${took} ms)`);
  const sent = app.log.calls.filter(c => c.method === 'read_card_contents').at(-1);
  ok(sent.params.wait_seconds === 5, `KLYPIX is asked to answer before the client's deadline (wait_seconds ${sent.params.wait_seconds})`);
  slowRelease?.();
  const w = await call('show_in_klypix', { canvas: 'Board' }, { deadlineMs: 1200 });
  ok(w.reached === true && w.outcome.ok === false && w.outcome.code === 'APP_NO_ANSWER', 'a non-read past the deadline says KLYPIX did not confirm (never claims success)');
}

// ── Cancel → bridge cancel ───────────────────────────────────────────────────
{
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const r = await call('read_card_contents', { canvas: 'Board', card_ids: ['slow'] }, { signal: ctl.signal });
  await sleep(100);
  const cancel = app.log.cancels.at(-1);
  ok(r.outcome.code === 'CANCELLED' && cancel && cancel.found === true && cancel.target === 10, 'the host\'s cancel becomes a bridge cancel for that exact call');
  const pre = new AbortController(); pre.abort();
  const callsBefore = app.log.calls.length;
  const r2 = await call('status', {}, { signal: pre.signal });
  ok(r2.outcome.code === 'CANCELLED' && app.log.calls.length === callsBefore, 'a call already cancelled sends nothing');
}

// ── Restart, drops, reconnect once ───────────────────────────────────────────
{
  const oldToken = app.token;
  await app.restart();
  seen.push(...secretsOf(app));
  const r = await call('status');
  ok(app.token !== oldToken && r.outcome.ok === true, 'after KLYPIX restarts (new token, new pipe) the next call re-reads both files and works');

  // The app restarted between our read of the token and our proof: AUTH_FAILED,
  // re-read, retry once — and it goes through.
  app.state.serverToken = 'e'.repeat(64);
  app.state.onAuthFailed = () => { app.state.token = app.state.serverToken; app.state.serverToken = null; app.writeToken(); app.state.onAuthFailed = null; };
  const r2 = await call('status');
  ok(r2.reached === true && r2.outcome.ok === true, 'a token rotated mid-call: AUTH_FAILED once, then the re-read token works');

  app.state.dropBeforeChallenge = 1;
  const r3 = await call('status');
  ok(r3.outcome.ok === true, 'a connection dropped before the call is retried once');

  app.state.dropAfterCall = 1;
  const reads = app.log.calls.filter(c => c.method === 'read_card_contents').length;
  const r4 = await call('read_card_contents', { canvas: 'Board', card_ids: ['lnk_2'] });
  ok(r4.outcome.ok === true && app.log.calls.filter(c => c.method === 'read_card_contents').length === reads + 2, 'a read dropped after it was sent is re-sent once (reads are safe to repeat)');

  app.state.dropAfterCall = 1;
  const adds = app.log.calls.filter(c => c.method === 'add_to_canvas').length;
  const r5 = await call('add_to_canvas', { canvas: 'Board', cards: [{ text: 'once' }] });
  ok(r5.reached === true && r5.outcome.code === 'APP_NO_ANSWER' && app.log.calls.filter(c => c.method === 'add_to_canvas').length === adds + 1,
    'a write dropped after it was sent is NEVER re-sent: APP_NO_ANSWER, check the canvas');
}

// ── Client names → safe, distinct keys ───────────────────────────────────────
{
  const keys = [];
  for (const name of ['../../x', 'Claude Desktop', 'claude-ai']) {
    await call('status', {}, { clientName: name });
    keys.push(app.log.hellos.at(-1).clientKey);
  }
  ok(keys[0] === '-..-x' && keys[1] === 'claude-desktop' && keys[2] === 'claude-ai', `the three names give the vector keys (${keys.join(', ')})`);
  ok(new Set(keys).size === 3 && keys.every(k => CLIENT_KEY.test(k) && !k.includes('/') && !k.includes(String.fromCharCode(92)) && !k.startsWith('.')),
    'all distinct, all strict slugs: none can name a path');
  ok(app.log.hellos.at(-2).clientLabel === 'Claude Desktop' && app.log.hellos.at(-1).clientLabel === 'Claude Desktop', 'both Claude Desktop spellings get the label Claude Desktop, under different keys');
}

// ── Nothing secret anywhere ──────────────────────────────────────────────────
{
  const everything = JSON.stringify(outcomes) + JSON.stringify(events);
  const leaks = [...new Set(seen)].filter(s => everything.includes(s));
  ok(leaks.length === 0, `no token, pipe name or endpoint.json content appears in any result or event (${outcomes.length} results, ${events.length} events checked)`);
  ok(events.every(e => /^[a-z-]+$/.test(e)), `events are coarse names only (${[...new Set(events)].join(', ')})`);
}

// ── show_in_klypix never starts KLYPIX beside a running one ──────────────────
{
  process.env.KLYPIX_APP_TOOLS = 'on';
  const { buildPlainCanvas } = await import('./_parity-fixture.mjs');
  const { showInKlypix } = await import('../src/app-tools.mjs');
  const vault = path.join(tmp, 'vault');
  const board = await buildPlainCanvas(vault);
  const launched = [];
  const launch = (file) => { launched.push(file); return true; };
  await app.setAccess(false); // running, access off
  const r1 = await showInKlypix({ vault, canvas: 'Plain board', bring_to_front: true, client: { name: 'codex' }, launch });
  ok(r1.isError === true && r1.structuredContent.code === 'ACCESS_OFF' && launched.length === 0,
    'KLYPIX running with access off: show_in_klypix returns ACCESS_OFF and never launches KLYPIX, even with bring_to_front');
  await app.setAccess(true);
  const r2 = await showInKlypix({ vault, canvas: 'Plain board', card_ids: ['txt_one'], bring_to_front: true, client: { name: 'codex' }, launch });
  ok(launched.length === 0 && app.log.calls.at(-1)?.method === 'show_in_klypix', 'KLYPIX running with access on: the request goes over the bridge, the file association is never used');
  ok(!r2.isError && r2.structuredContent.mode === 'app' && r2.structuredContent.launched_app === false && r2.structuredContent.brought_to_front === false,
    '  and KLYPIX\'s answer says it neither launched nor came to the front');
  await app.quit();
  const r3 = await showInKlypix({ vault, canvas: 'Plain board', client: { name: 'codex' }, launch });
  ok(r3.isError === true && r3.structuredContent.code === 'APP_NOT_RUNNING' && launched.length === 0, 'KLYPIX closed, no bring_to_front: APP_NOT_RUNNING, nothing launched');
  const r4 = await showInKlypix({ vault, canvas: 'Plain board', bring_to_front: true, client: { name: 'codex' }, launch });
  const r5 = await showInKlypix({ vault, canvas: 'Plain board', bring_to_front: true, client: { name: 'codex' }, launch });
  if (/^[a-z]:[\\/]/i.test(board)) {
    ok(r4.structuredContent.launched_app === true && launched.length === 1 && path.resolve(launched[0]) === path.resolve(board),
      'KLYPIX closed and bring_to_front: the canvas file is opened through its association, once');
    ok(r5.isError === true && r5.structuredContent.code === 'APP_NOT_RUNNING' && launched.length === 1, 'a second ask within 30 s launches nothing');
  } else {
    ok(r4.isError === true && launched.length === 0 && r5.isError === true, 'off Windows nothing is ever launched (no drive-letter canvas path)');
  }
  delete process.env.KLYPIX_APP_TOOLS;
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ app-bridge-client: all assertions passed');
process.exit(failures ? 1 : 0);
