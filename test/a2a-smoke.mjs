// End-to-end A2A smoke test: boot the server on a fixture vault, then exercise
// the real wire protocol — agent-card discovery, message/send (make_board +
// remember + recall), message/stream (SSE), tasks/get — and PROVE the returned
// .klypix artifact is a real canvas by parsing it back.
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeVault, seedBrain, seedRoadmap } from './_harness.mjs';
import { parseKlypix } from '../src/klypix-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'klypix-a2a.mjs');
const PORT = 41299;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }).on('error', reject);
  });
}
function rpc(method, params, { stream = false } = {}) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (stream) {
          const events = d.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data:\s*/, '')).result);
          resolve({ status: res.statusCode, events });
        } else resolve({ status: res.statusCode, json: JSON.parse(d) });
      });
    });
    req.on('error', reject); req.end(payload);
  });
}
const waitUp = async () => { for (let i = 0; i < 50; i++) { try { await get('/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('server never came up'); };

const vault = makeVault();
await seedBrain(vault);
await seedRoadmap(vault);

const srv = spawn(process.execPath, [BIN, '--vault', vault, '--port', String(PORT)], { stdio: ['ignore', 'inherit', 'inherit'] });
try {
  await waitUp();

  // 1. Agent Card discovery
  const card = (await get('/.well-known/agent-card.json')).json;
  ok(card.name?.includes('KLYPIX'), 'agent card served at /.well-known/agent-card.json');
  ok(card.capabilities?.streaming === true, 'card advertises streaming capability');
  ok(Array.isArray(card.skills) && card.skills.some(s => s.id === 'make_board'), 'card lists make_board skill');
  ok(card.url === `${BASE}/`, 'card url points at the JSON-RPC endpoint');
  ok(card.defaultOutputModes?.includes('application/vnd.klypix+zip'), 'card declares .klypix output mode');

  // 2. message/send → make_board (structured DataPart) returns a .klypix artifact
  const made = await rpc('message/send', {
    message: {
      kind: 'message', role: 'user', messageId: 'm1',
      parts: [{ kind: 'data', data: { skill: 'make_board', args: { title: 'a2a-built', cards: [{ text: 'Idea A' }, { text: 'Idea B' }], connections: [{ from: 0, to: 1 }] } } }],
    },
  });
  const task = made.json.result;
  ok(made.json.jsonrpc === '2.0' && task?.kind === 'task', 'message/send returns a JSON-RPC Task');
  ok(task.status?.state === 'completed', 'task state = completed');
  const filePart = task.artifacts?.[0]?.parts?.find(p => p.kind === 'file' && p.file?.mimeType === 'application/vnd.klypix+zip');
  ok(!!filePart?.file?.bytes, 'artifact carries a .klypix FilePart (base64 bytes)');

  // 3. PROVE the artifact is a real canvas: parse the bytes back
  if (filePart) {
    const { struct } = await parseKlypix(Buffer.from(filePart.file.bytes, 'base64'));
    ok(struct.title === 'a2a-built', 'returned artifact parses back to a real .klypix (title intact)');
    ok(struct.counts.cards >= 2 && struct.counts.connections >= 1, 'artifact has the cards + connection we sent');
  }

  // 4. remember (NL convenience) appends a card to the brain
  const remembered = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: 'Remember that A2A is the transport and .klypix is the memory.' }] },
  });
  ok(remembered.json.result?.status?.state === 'completed', 'remember (free-text) completes');
  ok(remembered.json.result?.metadata?.skill === 'remember', 'free-text routed to the remember skill');

  // 5. recall via message/stream (SSE) — MONOTONIC lifecycle: non-terminal Task → artifact → final
  const streamed = await rpc('message/stream', {
    message: { kind: 'message', role: 'user', messageId: 'm3', parts: [{ kind: 'text', text: 'What do we know about A2A?' }] },
  }, { stream: true });
  ok(streamed.events[0]?.kind === 'task', 'stream begins with the Task object');
  ok(streamed.events[0]?.status?.state === 'submitted', 'first streamed Task is NON-terminal (submitted) — no backward transition');
  ok(!streamed.events.some(e => e.kind === 'status-update' && e.final !== true && e.status?.state === 'working'), 'no spurious intermediate "working" update');
  const finals = streamed.events.filter(e => e.kind === 'status-update' && e.final === true);
  ok(finals.length === 1 && finals[0].status?.state === 'completed', 'exactly one final status-update, terminal state = completed');
  ok(/A2A/i.test(JSON.stringify(streamed.events)), 'recall surfaced the card mentioning A2A');

  // 6. tasks/get round-trips a stored task
  const got = await rpc('tasks/get', { id: task.id });
  ok(got.json.result?.id === task.id, 'tasks/get retrieves the stored task');

  // 7. input-required when a write lacks structured cards
  const bad = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm4', parts: [{ kind: 'data', data: { skill: 'make_board', args: { title: 'no cards' } } }] },
  });
  ok(bad.json.result?.status?.state === 'input-required', 'make_board without cards → input-required');

  // 8. method-not-found is a proper JSON-RPC error
  const nf = await rpc('does/notExist', {});
  ok(nf.json.error?.code === -32601, 'unknown method → JSON-RPC -32601');

  // 9. router fix — "what's in the X canvas" must READ, not LIST
  const routed = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm5', parts: [{ kind: 'text', text: "what's in the roadmap canvas?" }] },
  });
  ok(routed.json.result?.metadata?.skill === 'read_canvas', '"what\'s in the roadmap canvas" routes to read_canvas (not list)');

  // 10. vault-escape refusal — an absolute / traversal canvas ref is refused on the network face
  const escape = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm6', parts: [{ kind: 'data', data: { skill: 'read_canvas', args: { canvas: '../../../../../../etc/passwd' } } }] },
  });
  const escapeText = JSON.stringify(escape.json.result);
  ok(escape.json.result?.status?.state === 'failed' && /outside the vault/i.test(escapeText), 'vault-escaping canvas ref is refused');

  // 11. NL make_board text fallback — a free-text brief becomes cards
  const nlBoard = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm7', parts: [{ kind: 'text', text: 'make a board: Alpha; Beta; Gamma' }] },
  });
  ok(nlBoard.json.result?.status?.state === 'completed', 'NL "make a board: a; b; c" completes (text→cards fallback)');
  const nlFile = nlBoard.json.result?.artifacts?.[0]?.parts?.find(p => p.kind === 'file');
  if (nlFile) { const { struct } = await parseKlypix(Buffer.from(nlFile.file.bytes, 'base64')); ok(struct.counts.cards >= 3, 'NL board split into 3 cards'); }

  // 12. connection errors are clean (symmetry with cards) — input-required, not a raw ZodError dump
  const badConn = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm8', parts: [{ kind: 'data', data: { skill: 'make_board', args: { cards: [{ text: 'x' }], connections: [{ from: 0 }] } } }] },
  });
  ok(badConn.json.result?.status?.state === 'input-required' && !/ZodError/.test(JSON.stringify(badConn.json.result)), 'malformed connections → clean input-required (no ZodError dump)');

  // 13. input-required is RESUMABLE — reply with the taskId + cards continues the same task
  const step1 = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm9', parts: [{ kind: 'data', data: { skill: 'make_board', args: { title: 'resumed' } } }] },
  });
  const resumeId = step1.json.result?.id;
  const step2 = await rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: 'm10', taskId: resumeId, parts: [{ kind: 'data', data: { skill: 'make_board', args: { title: 'resumed', cards: [{ text: 'now with a card' }] } } }] },
  });
  ok(step2.json.result?.id === resumeId, 'continuation reply reuses the same taskId (resumable)');
  ok(step2.json.result?.status?.state === 'completed', 'resumed task completes');
  ok((step2.json.result?.history?.length ?? 0) >= 2, 'resumed task accumulated history');

  // 14. agent card advertises brain_connect (contract matches implementation)
  ok(card.skills.some(s => s.id === 'brain_connect'), 'agent card advertises the brain_connect skill');

} finally {
  srv.kill();
}
console.log(failures === 0 ? '\n✓ A2A E2E PASSED' : `\n✗ ${failures} A2A assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
