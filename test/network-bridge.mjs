// KLYPIX network bridge — unit tests with a fake engine. Covers what crosses
// computers (whitelist), project matching, caching, sending, and that a peer on
// another computer lands in the lane and triggers the SAME overlap warning a
// local peer would.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { laneFileFor, listActiveSessions, upsertRemoteSessions, upsertSession, purgeRemotePresence } from '../src/agent-presence.mjs';
import { createMcpPresence, findPresenceConflicts } from '../src/mcp-presence.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import { createNetworkBridge, projectKey, remoteRows, wireFiles, bridgeEnabled, NETWORK_ROW_PREFIX } from '../src/network-bridge.mjs';
import { buildPresenceFrame } from '../src/presence-relay.mjs';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error?.stack || error}`); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''}\n  got ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };

const KEY = projectKey({ root: '/r', readRemote: () => 'git@github.com:Acme/Api.git' });
const directory = (sessions) => ({ team: 'vibes', person: 'alex', machine: 'mbp', machines: [], invite_line: null, sessions });
const remote = (over = {}) => ({
  address: 'alice/api-claude', name: 'api-claude', person: 'alice', machine: 'xps', agent: 'claude-code', cwd: '~/api',
  repo: 'acme/api', branch: 'feat/auth', status: 'busy', since: 1, doing: 'JWT middleware', tier: 'push', unread: 0, is_me: false,
  klypix: { project: KEY, intent: 'Rework token refresh', files: ['src/auth.ts'] }, ...over,
});

check('the same repository gives the same project key however it is cloned', () => {
  const forms = ['git@github.com:Acme/Api.git', 'https://github.com/acme/api', 'https://user@github.com/acme/api.git/', 'ssh://git@github.com/acme/api.git'];
  const keys = forms.map((r) => projectKey({ root: '/x', readRemote: () => r }));
  ok(keys.every((k) => k === keys[0] && k.startsWith('git:')), JSON.stringify(keys));
  ok(projectKey({ root: '/x', readRemote: () => 'git@github.com:acme/web.git' }) !== keys[0], 'another repo differs');
  ok(projectKey({ root: 'E:/work/KLYPIX', readRemote: () => null }).startsWith('dir:'), 'no remote: folder name');
});

check('only repository-relative files leave the computer', () => {
  eq(wireFiles(['E:/work/api/src/a.ts', 'src\\b.ts', './c.ts', 'C:/Users/me/secret.txt', '/etc/passwd', '../up.txt', 'src/a.ts', 'x:y'], 'E:/work/api'),
    ['src/a.ts', 'src/b.ts', 'c.ts']);
  eq(wireFiles(Array.from({ length: 80 }, (_, i) => `f${i}.ts`), '/r').length, 50);
});

check('only teammates on other computers in the same project become rows', () => {
  const rows = remoteRows(directory([
    remote(),
    remote({ address: 'alex/web-codex', person: 'alex', machine: 'mbp', is_me: false }),      // this computer
    remote({ address: 'bob/x', person: 'bob', is_me: true }),                                  // me
    remote({ address: 'carol/y', person: 'carol', klypix: { project: 'git:other', intent: '', files: [] } }),
    remote({ address: 'dan/z', person: 'dan', klypix: undefined }),                            // no KLYPIX context
    remote({ address: 'erin/w', person: 'erin', status: 'offline' }),
  ]), KEY);
  eq(rows.map((r) => r.id), [`${NETWORK_ROW_PREFIX}alice/api-claude`]);
  eq(rows[0].via, 'network');
  eq(rows[0].files, ['src/auth.ts']);
  eq(rows[0].intent, 'Rework token refresh');
  ok(!JSON.stringify(rows[0]).includes('~/api'), 'no working directory crosses into the row');
});

check('sync publishes once per change, caches reads, and never throws', () => {
  const calls = [];
  let t = 1000;
  const run = (bin, args) => {
    calls.push(args[0]);
    if (args[0] === 'who') return { ok: true, stdout: JSON.stringify(directory([remote()])) };
    return { ok: true, stdout: '' };
  };
  const bridge = createNetworkBridge({ env: {}, bin: 'kn', run, now: () => t, readRemote: () => 'git@github.com:acme/api.git' });
  const a = bridge.sync({ root: '/r', intent: 'Fix login', files: ['src/login.ts'] });
  eq(a.rows.length, 1);
  bridge.sync({ root: '/r', intent: 'Fix login', files: ['src/login.ts'] });   // same context, cached read
  eq(calls, ['status', 'who'], 'one publish, one read');
  t += 9_000;
  bridge.sync({ root: '/r', intent: 'Fix signup', files: ['src/login.ts'] });
  eq(calls, ['status', 'who', 'status', 'who']);
  const broken = createNetworkBridge({ env: {}, bin: 'kn', run: () => { throw new Error('boom'); } });
  eq(broken.sync({ root: '/r' }).ok, false);
  const bad = createNetworkBridge({ env: {}, bin: 'kn', run: (b, args) => args[0] === 'who' ? { ok: true, stdout: 'not json' } : { ok: true } });
  eq(bad.sync({ root: '/r' }).ok, false);
});

check('no engine or KLYPIX_NETWORK=0 means nothing runs', () => {
  let ran = false;
  const off = createNetworkBridge({ env: { KLYPIX_NETWORK: '0' }, bin: 'kn', run: () => { ran = true; return { ok: true }; } });
  eq(off.sync({ root: '/r' }).reason, 'no-engine');
  const none = createNetworkBridge({ env: {}, bin: null, run: () => { ran = true; return { ok: true }; } });
  eq(none.sync({ root: '/r' }).reason, 'no-engine');
  ok(!ran, 'the engine is never called');
  ok(bridgeEnabled({}) && !bridgeEnabled({ KLYPIX_NETWORK: '0' }));
});

check('send refuses anything but a session address, and passes the text as one argument', () => {
  const seen = [];
  const bridge = createNetworkBridge({ env: {}, bin: 'kn', run: (b, args) => { seen.push(args); return { ok: true }; } });
  eq(bridge.send({ address: 'alice/api-claude', text: 'I am editing src/auth.ts' }).ok, true);
  eq(seen[0], ['send', 'alice/api-claude', 'I am editing src/auth.ts']);
  for (const address of ['*', 'alice/*', 'repo:acme/api', '--from=x', 'alice api', '']) {
    eq(bridge.send({ address, text: 'x' }).ok, false, address);
  }
  eq(bridge.send({ address: 'alice/api-claude', text: '  ' }).reason, 'empty');
});

check('a teammate on another computer lands in the lane and triggers the overlap warning', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-bridge-'));
  const brainPath = path.join(home, 'proj', 'brain.klypix');
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  upsertSession({ brainPath, id: 'me-1', client: 'claude-code', intent: 'Change auth', files: ['src/auth.ts'], home, now: 1_000 });
  const rows = remoteRows(directory([remote()]), KEY);
  const written = upsertRemoteSessions({ brainPath, rows, machineId: 'local-machine', home, now: 1_000 });
  ok(written.laneWriteOk !== false, 'lane written');
  const sessions = listActiveSessions({ brainPath, home, now: 1_500 });
  const peer = sessions.find((s) => s.id === rows[0].id);
  ok(peer && peer.via === 'network' && peer.networkAddress === 'alice/api-claude', JSON.stringify(peer));
  const conflicts = findPresenceConflicts(sessions, 'me-1');
  ok(conflicts.some((c) => c.id === rows[0].id), `overlap warning: ${JSON.stringify(conflicts)}`);
  eq(buildPresenceFrame(peer, { machineId: 'local-machine' }), null, 'a network row is never re-broadcast');
  const purged = purgeRemotePresence({ brainPath, home, now: 2_000 });
  ok(purged.purgedSessions >= 1 && !purged.sessions.some((s) => s.via === 'network'), 'purge removes network rows too');
  fs.rmSync(home, { recursive: true, force: true });
});

// ── Wired paths: brain_sync (presence heartbeat) and brain_message ─────────
const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);

const sandbox = async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-wired-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-wired-proj-'));
  fs.writeFileSync(path.join(proj, 'brain.klypix'),
    await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
  return { home, proj, brainPath: path.join(proj, 'brain.klypix') };
};
const fakeServer = () => ({ server: { getClientVersion: () => ({ name: 'claude-code', version: 'test' }) }, sendLoggingMessage() {} });

checkAsync('brain_sync shows a teammate on another computer and warns about the shared file', async () => {
  const { home, proj } = await sandbox();
  const synced = [];
  const bridge = {
    available: () => true,
    sync: (ctx) => { synced.push(ctx); return { ok: true, rows: remoteRows(directory([remote()]), KEY) }; },
    send: () => ({ ok: true }),
  };
  const presence = createMcpPresence({
    server: fakeServer(), initialVault: proj, env: { KLYPIX_SESSION_ID: 'me-wired' }, home,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {}, networkBridge: bridge,
  });
  presence.start();
  const out = presence.sync({ phase: 'start', intent: 'Change auth', files: ['src/auth.ts'] });
  ok(synced.some((c) => c.intent === 'Change auth' && c.files.includes('src/auth.ts')), `published own context: ${JSON.stringify(synced)}`);
  ok(out.conflicts.some((c) => String(c.id).startsWith(NETWORK_ROW_PREFIX) && c.files.includes('src/auth.ts')),
    `overlap warning names the remote session: ${JSON.stringify(out.conflicts)}`);
  presence.stop?.();
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
});

checkAsync('a broken bridge never breaks brain_sync', async () => {
  const { home, proj } = await sandbox();
  const presence = createMcpPresence({
    server: fakeServer(), initialVault: proj, env: { KLYPIX_SESSION_ID: 'me-broken' }, home,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
    networkBridge: { available: () => true, sync: () => { throw new Error('engine exploded'); }, send: () => ({ ok: false }) },
  });
  presence.start();
  const out = presence.sync({ phase: 'start', intent: 'Solo work', files: ['a.ts'] });
  ok(out && out.conflicts.length === 0, 'sync completed without remote peers');
  presence.stop?.();
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
});

checkAsync('brain_message: direct notes and broadcasts reach other computers through the engine', async () => {
  const { home, proj, brainPath } = await sandbox();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const prevCwd = process.cwd();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(proj);
    const { opBrainMessage } = await import('../src/klypix-core.mjs');
    upsertSession({ brainPath, id: 'me-sender', client: 'claude-code', channel: 'mcp', home });
    upsertRemoteSessions({ brainPath, rows: remoteRows(directory([remote()]), KEY), machineId: 'local-machine', home });
    const netId = `${NETWORK_ROW_PREFIX}alice/api-claude`;
    const sent = [];
    const networkSend = (m) => { sent.push(m); return { ok: true }; };

    const direct = await opBrainMessage({ vault: proj, text: 'I am editing src/auth.ts', to: netId, from: 'me-sender', networkSend });
    ok(!direct.isError && /KLYPIX network/.test(direct.blocks[0].text), direct.blocks[0].text);
    eq(sent, [{ address: 'alice/api-claude', text: 'I am editing src/auth.ts' }]);

    const solo = await opBrainMessage({ vault: proj, text: 'heads up', to: 'all', from: 'me-sender', networkSend });
    ok(!solo.isError && /other computers/.test(solo.blocks[0].text), `broadcast with only a remote peer: ${solo.blocks[0].text}`);

    upsertSession({ brainPath, id: 'local-peer-1', client: 'codex', channel: 'mcp', home });
    const both = await opBrainMessage({ vault: proj, text: 'rebase please', to: 'all', from: 'me-sender', networkSend });
    ok(!both.isError && /Also sent over KLYPIX network/.test(both.blocks[0].text), `local + remote: ${both.blocks[0].text}`);
    const lane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
    ok(lane.messages.every((m) => !(m.candidateIds || []).includes(netId)), 'no local-lane note is ever addressed to a remote row');

    const failing = await opBrainMessage({ vault: proj, text: 'x', to: netId, from: 'me-sender', networkSend: () => ({ ok: false, reason: 'daemon down' }) });
    ok(failing.isError && /could not deliver/.test(failing.blocks[0].text), 'a failed send is a refusal, not a silent success');

    const noEngine = await opBrainMessage({ vault: proj, text: 'local only', to: 'local-peer-1', from: 'me-sender' });
    ok(!noEngine.isError, 'without the engine brain_message is the local one');
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
  }
});

check('plugin mode never runs the engine', () => {
  ok(!bridgeEnabled({ KLYPIX_PLUGIN: '1' }));
  const plugin = createNetworkBridge({ env: { KLYPIX_PLUGIN: '1' }, bin: 'kn', run: () => { throw new Error('ran'); } });
  eq(plugin.sync({ root: '/r' }).reason, 'no-engine');
});

for (const [name, fn] of asyncChecks) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error?.stack || error}`); }
}

if (failed) { console.error(`${failed} network-bridge check(s) failed`); process.exit(1); }
console.log('network-bridge: all checks passed');
