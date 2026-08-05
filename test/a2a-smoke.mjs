// Adversarial A2A wire-protocol gate. This boots the real HTTP server and
// proves discovery, portable artifacts, write serialization, target confinement,
// browser/Host boundaries, continuation semantics, output negotiation, terminal
// streaming, and dispatcher/engine drift contracts.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath } from 'url';
import { makeVault, seedBrain, seedRoadmap } from './_harness.mjs';
import { parseKlypix } from '../src/klypix-format.mjs';
import { opAddToCanvas } from '../src/klypix-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'klypix-a2a.mjs');
const CORE = path.join(ROOT, 'src', 'klypix-core.mjs');
const PORT = 41299;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = 'a2a-smoke-test-token';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function request({ path: requestPath = '/', method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + requestPath, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function getJson(p, headers) {
  const response = await request({ path: p, headers });
  return { ...response, json: JSON.parse(response.body) };
}
async function rpc(method, params, { stream = false, headers = {} } = {}) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params });
  const response = await request({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}`, ...headers },
    body: payload,
  });
  if (stream) {
    const events = response.body.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data:\s*/, '')).result);
    return { ...response, events };
  }
  return { ...response, json: JSON.parse(response.body) };
}
const waitUp = async () => {
  for (let i = 0; i < 50; i++) {
    try { await getJson('/health'); return; } catch { await sleep(100); }
  }
  throw new Error('server never came up');
};
const dataMessage = (messageId, skill, args, extra = {}) => ({
  kind: 'message', role: 'user', messageId, ...extra,
  parts: [{ kind: 'data', data: { skill, args } }],
});

const vault = makeVault();
await seedBrain(vault);
await seedRoadmap(vault);
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-a2a-outside-'));
const outsideCanvas = path.join(outsideDir, 'outside.klypix');
fs.copyFileSync(path.join(vault, 'roadmap.klypix'), outsideCanvas);

let serverStderr = '';
const srv = spawn(process.execPath, [BIN, '--vault', vault, '--port', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, KLYPIX_A2A_TOKEN: TEST_TOKEN } });
srv.stderr.setEncoding('utf8');
srv.stderr.on('data', chunk => { serverStderr += chunk; });

try {
  await waitUp();

  // 1. Discovery + health privacy + default-surface contract.
  const cardResponse = await getJson('/.well-known/agent-card.json');
  const card = cardResponse.json;
  ok(card.name?.includes('KLYPIX'), 'agent card served at /.well-known/agent-card.json');
  ok(card.protocolVersion === '0.3.0', 'agent card states A2A protocol v0.3.0');
  ok(card.capabilities?.streaming === true, 'agent card advertises streaming');
  ok(card.url === `${BASE}/`, 'agent card URL uses the validated loopback Host');
  ok(card.defaultOutputModes?.includes('application/vnd.klypix+zip'), 'agent card declares .klypix output');
  ok(card.skills.some(s => s.id === 'brain_connect'), 'agent card advertises brain_connect');
  ok(!card.skills.some(s => s.id === 'search_all_brains'), 'cross-project search is absent by default');
  const health = await getJson('/health');
  ok(!Object.hasOwn(health.json, 'vault') && !health.body.includes(vault), '/health does not disclose the vault path');

  // 1b. OS-user auth boundary: POST requires the bearer token; /health serves a
  // fingerprint (never the token) so clients can verify the server pre-send.
  const noAuth = await rpc('message/send', { message: dataMessage('noauth', 'list_canvases', {}) }, { headers: { Authorization: '' } });
  ok(noAuth.status === 401, 'POST without the bearer token is rejected 401');
  const badAuth = await rpc('message/send', { message: dataMessage('badauth', 'list_canvases', {}) }, { headers: { Authorization: 'Bearer wrong-token' } });
  ok(badAuth.status === 401, 'POST with a wrong token is rejected 401');
  const expectedFp = crypto.createHash('sha256').update(TEST_TOKEN).digest('hex').slice(0, 16);
  ok(health.json.auth?.scheme === 'bearer' && health.json.auth?.tokenFingerprint === expectedFp, '/health carries the bearer fingerprint (anti-squat verification), never the token');
  ok(!health.body.includes(TEST_TOKEN), '/health never leaks the token itself');

  // 2. Browser/DNS-rebind boundary and strict JSON request shape.
  const foreign = await rpc('message/send', { message: dataMessage('origin', 'list_canvases', {}) }, { headers: { Origin: 'https://evil.example' } });
  ok(foreign.status === 403, 'foreign Origin is rejected before JSON-RPC dispatch');
  ok(!Object.hasOwn(foreign.headers, 'access-control-allow-origin'), 'responses expose no wildcard CORS header');
  const poisonedHost = await rpc('message/send', { message: dataMessage('host', 'list_canvases', {}) }, { headers: { Host: 'evil.example' } });
  ok(poisonedHost.status === 403, 'non-loopback Host header is rejected');
  const plain = await request({ method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TEST_TOKEN}` }, body: '{}' });
  ok(plain.status === 415, 'POST requires Content-Type: application/json');
  const tooLarge = await request({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` }, body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }) });
  ok(tooLarge.status === 413, 'request bodies over 1 MiB are rejected cleanly');

  // 3. Portable board artifact round-trip.
  const made = await rpc('message/send', {
    message: dataMessage('make', 'make_board', { title: 'a2a-built', cards: [{ text: 'Idea A' }, { text: 'Idea B' }], connections: [{ from: 0, to: 1 }] }),
  });
  const madeTask = made.json.result;
  ok(madeTask?.kind === 'task' && madeTask.status?.state === 'completed', 'make_board returns a completed A2A Task');
  const filePart = madeTask.artifacts?.[0]?.parts?.find(p => p.kind === 'file' && p.file?.mimeType === 'application/vnd.klypix+zip');
  ok(!!filePart?.file?.bytes, 'make_board returns the .klypix FilePart');
  if (filePart?.file?.bytes) {
    const { struct } = await parseKlypix(Buffer.from(filePart.file.bytes, 'base64'));
    ok(struct.title === 'a2a-built', 'returned artifact parses with its title intact');
    ok(struct.counts.cards >= 2 && struct.counts.connections >= 1, 'returned artifact preserves cards + connection');
  }

  // 4. Normal-canvas append + untrusted provenance namespace.
  const appendText = 'A2A normal-canvas append regression';
  const appended = await rpc('message/send', {
    message: dataMessage('append', 'remember', { canvas: 'roadmap', cards: [{ text: appendText }] }, { metadata: { agentName: 'claude-code' } }),
  });
  ok(appended.json.result?.status?.state === 'completed', 'normal-canvas remember completes');
  let roadmap = (await parseKlypix(fs.readFileSync(path.join(vault, 'roadmap.klypix')))).struct;
  const appendedCard = roadmap.cards.find(c => c.text === appendText);
  ok(!!appendedCard, 'normal-canvas append round-trips on disk');
  ok(appendedCard?.createdVia === 'a2a:claude-code', 'claimed agentName is visibly namespaced as untrusted A2A provenance');

  // 5. Concurrent HTTP handlers stay correct up to the explicit in-flight cap.
  const parallelN = 4;
  const beforeParallel = roadmap.counts.cards;
  const writes = await Promise.all(Array.from({ length: parallelN }, (_, i) => rpc('message/send', {
    message: dataMessage(`parallel-${i}`, 'remember', { canvas: 'roadmap', cards: [{ text: `parallel-write-${i}` }] }),
  })));
  ok(writes.every(r => r.json.result?.status?.state === 'completed'), `${parallelN} parallel writes all report completed`);
  roadmap = (await parseKlypix(fs.readFileSync(path.join(vault, 'roadmap.klypix')))).struct;
  const persistedParallel = roadmap.cards.filter(c => /^parallel-write-\d+$/.test(c.text || '')).length;
  ok(roadmap.counts.cards === beforeParallel + parallelN && persistedParallel === parallelN, `${parallelN}/${parallelN} parallel writes persist — no lost update`);

  // The original engine defect was visible to MCP/CLI too, so retain the exact
  // high-N in-process regression independently of the HTTP concurrency cap.
  const engineN = 40;
  const beforeEngine = roadmap.counts.cards;
  const engineWrites = await Promise.all(Array.from({ length: engineN }, (_, i) => opAddToCanvas({
    vault, canvas: 'roadmap', cards: [{ text: `engine-parallel-${i}` }], via: 'test:concurrency',
  })));
  ok(engineWrites.every(result => !result.isError), `${engineN} parallel core writes all report success`);
  roadmap = (await parseKlypix(fs.readFileSync(path.join(vault, 'roadmap.klypix')))).struct;
  const persistedEngine = roadmap.cards.filter(c => /^engine-parallel-\d+$/.test(c.text || '')).length;
  ok(roadmap.counts.cards === beforeEngine + engineN && persistedEngine === engineN, `${engineN}/${engineN} parallel core writes persist — permanent lost-update regression gate`);

  // 6. Validate the effective text-derived ref, not only args.canvas.
  const escape = await rpc('message/send', {
    message: {
      kind: 'message', role: 'user', messageId: 'escape',
      parts: [
        { kind: 'data', data: { skill: 'read_canvas', args: {} } },
        { kind: 'text', text: outsideCanvas },
      ],
    },
  });
  const escapeText = JSON.stringify(escape.json.result);
  ok(escape.json.result?.status?.state === 'failed' && /outside the vault/i.test(escapeText), 'text-part absolute canvas outside the vault is refused');

  // 7. Cross-project search stays inaccessible unless the operator opted in.
  const crossProject = await rpc('message/send', { message: dataMessage('cross-project', 'search_all_brains', { query: 'auth' }) });
  ok(crossProject.json.result?.status?.state === 'failed' && /disabled/i.test(JSON.stringify(crossProject.json.result)), 'explicit cross-project search is rejected by default');

  // 8. Resumption remembers the original skill even when continuation is plain text.
  const step1 = await rpc('message/send', {
    message: dataMessage('resume-1', 'make_board', { title: 'resumed-plain-text' }),
  });
  const resumeId = step1.json.result?.id;
  ok(step1.json.result?.status?.state === 'input-required', 'make_board without cards requests input');
  const step2 = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'resume-2', taskId: resumeId, parts: [{ kind: 'text', text: 'Alpha; Beta' }] },
  });
  ok(step2.json.result?.id === resumeId, 'plain-text continuation reuses the original taskId');
  ok(step2.json.result?.metadata?.skill === 'make_board' && step2.json.result?.status?.state === 'completed', 'plain-text continuation resumes the original skill');
  const resumedFile = step2.json.result?.artifacts?.[0]?.parts?.find(p => p.kind === 'file');
  if (resumedFile?.file?.bytes) {
    const { struct } = await parseKlypix(Buffer.from(resumedFile.file.bytes, 'base64'));
    ok(struct.title === 'resumed-plain-text' && struct.counts.cards >= 2, 'resumed task preserves prior args and accepts new text');
  } else ok(false, 'resumed task returns its board artifact');

  // 9. Output negotiation removes file parts for text-only clients.
  const textOnly = await rpc('message/send', {
    message: dataMessage('text-only', 'make_board', { title: 'text-only', cards: [{ text: 'No file part' }] }),
    configuration: { acceptedOutputModes: ['text/plain'] },
  });
  ok(textOnly.json.result?.status?.state === 'completed', 'text-only negotiated task completes');
  ok(!JSON.stringify(textOnly.json.result?.artifacts || []).includes('application/vnd.klypix+zip'), 'acceptedOutputModes text/plain suppresses .klypix FileParts');

  // 10. Streaming is monotonic and terminates even when malformed input throws
  // after SSE headers are committed.
  const streamed = await rpc('message/stream', {
    message: { kind: 'message', role: 'user', messageId: 'stream-ok', parts: [{ kind: 'text', text: 'What do we know about A2A?' }] },
  }, { stream: true });
  ok(streamed.events[0]?.kind === 'task' && streamed.events[0]?.status?.state === 'submitted', 'stream begins with one non-terminal submitted Task');
  const finals = streamed.events.filter(e => e.kind === 'status-update' && e.final === true);
  ok(finals.length === 1 && finals[0].status?.state === 'completed', 'successful stream emits exactly one final:true terminal status');
  const thrownStream = await rpc('message/stream', {
    message: { kind: 'message', role: 'user', messageId: 'stream-throw', parts: [null] },
  }, { stream: true });
  const thrownFinals = thrownStream.events.filter(e => e?.kind === 'status-update' && e.final === true);
  ok(thrownFinals.length === 1 && thrownFinals[0].status?.state === 'failed', 'forced stream exception still emits one final:true failed status');

  // 11. Stored tasks round-trip.
  const got = await rpc('tasks/get', { id: madeTask.id });
  ok(got.json.result?.id === madeTask.id, 'tasks/get retrieves a retained task');
  const nf = await rpc('does/notExist', {});
  ok(nf.json.error?.code === -32601, 'unknown method returns JSON-RPC -32601');

  // 12. Input bounds fail cleanly rather than allocating unbounded work.
  const tooManyCards = await rpc('message/send', {
    message: dataMessage('too-many-cards', 'make_board', { cards: Array.from({ length: 501 }, (_, i) => ({ text: `card-${i}` })) }),
  });
  ok(tooManyCards.json.result?.status?.state === 'input-required', '501 cards exceed the A2A max(500) bound');
  const tooLongCard = await rpc('message/send', {
    message: dataMessage('too-long-card', 'make_board', { cards: [{ text: 'x'.repeat(20_001) }] }),
  });
  ok(tooLongCard.json.result?.status?.state === 'input-required', 'card text over 20,000 chars is rejected');

  // 13. Drift gates: no hidden case labels and no silently forgotten core ops.
  const a2aSource = fs.readFileSync(BIN, 'utf8');
  const coreSource = fs.readFileSync(CORE, 'utf8');
  const advertised = new Set([...a2aSource.matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]));
  const aliasesBlock = /const ALIASES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(a2aSource)?.[1] || '';
  const aliases = new Set([...aliasesBlock.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]));
  const cases = [...a2aSource.matchAll(/case\s+'([^']+)'/g)].map(m => m[1]);
  ok(cases.every(name => advertised.has(name) || aliases.has(name)), 'every runSkill case is advertised or documented in ALIASES');
  const exportedOps = new Set([...coreSource.matchAll(/export async function (op[A-Za-z0-9]+)/g)].map(m => m[1]));
  const wiredOps = new Set([...a2aSource.matchAll(/return await (op[A-Za-z0-9]+)/g)].map(m => m[1]));
  const unwiredBlock = /const DELIBERATELY_UNWIRED = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(a2aSource)?.[1] || '';
  const unwiredOps = new Set([...unwiredBlock.matchAll(/^\s*(op[A-Za-z0-9]+):\s*'[^']+'/gm)].map(m => m[1]));
  const accounted = [...exportedOps].every(name => wiredOps.has(name) || unwiredOps.has(name));
  const noGhosts = [...unwiredOps].every(name => exportedOps.has(name));
  ok(accounted && noGhosts, 'every klypix-core op is wired or listed in DELIBERATELY_UNWIRED with a reason');

  // 14. The executable refuses a non-loopback bind, not merely its docs.
  const unsafe = spawn(process.execPath, [BIN, '--vault', vault, '--port', '41300', '--host', '0.0.0.0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const [unsafeCode] = await once(unsafe, 'exit');
  ok(unsafeCode === 2, 'non-loopback --host is refused at startup');
} finally {
  if (srv.exitCode == null) {
    srv.kill();
    await Promise.race([once(srv, 'exit'), sleep(2000)]);
  }
  fs.rmSync(outsideDir, { recursive: true, force: true });
}

if (failures && serverStderr) console.error(`\nA2A server stderr:\n${serverStderr}`);
console.log(failures === 0 ? '\n✓ A2A ADVERSARIAL E2E PASSED' : `\n✗ ${failures} A2A assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
