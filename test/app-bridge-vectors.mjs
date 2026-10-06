// app-bridge-vectors — the facts klypix-mcp and the KLYPIX desktop app must
// agree on to talk over the app bridge (agent tool parity P1), pinned by
// test/fixtures/app-bridge-vectors.json. The app mirrors that file byte-for-byte
// (scripts/sync-bundled-mcp.mjs --check --strict) and its own
// electron/agentBridge/agentBridgeVectors.test.ts checks the same sections
// against the app's protocol.ts, discovery.ts, policy.ts and grants.ts. If both
// pass, the two implementations frame, prove, slug and label identically.
//
// The fixture is never edited to make a failing computation pass: a mismatch
// means one side changed the protocol, and both repositories move together.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_PROTOCOL, CALL_DEADLINE_MS, CAPS, CLIENT_KEY, CLIENT_LABELS, CODE_SENTENCES, FrameDecoder, FrameError, HANDSHAKE_TIMEOUT_MS,
  CAP_KINDS, ENDPOINT_FEATURES, MAX_CALLS_PER_CONNECTION, MAX_QUEUED_WRITE_BYTES, METHOD_PARAMS, PIN_SKIPPED, RPC_ERRORS,
  IDLE_TIMEOUT_MS, MAX_CONNECTIONS, MAX_CONNECTIONS_PER_CLIENT, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, METHODS, PAID_BY, VISIBILITY,
  clientKeyFromName, clientLabelFor, encodeFrame, isAllowedPipePath, proofC, proofS, proofsMatch, sentenceFor,
} from '../src/app-bridge-protocol.mjs';
import { APP_BRIDGE_PROTOCOL, pathHash } from '../src/app-lease.mjs';
import { ENDPOINT_FILE, TOKEN_FILE } from '../src/app-bridge-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const BS = String.fromCharCode(92);

const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'app-bridge-vectors.json'), 'utf8').replace(/\r/g, ''));

// ── The protocol, the files, the limits ─────────────────────────────────────
ok(v.protocol === BRIDGE_PROTOCOL && BRIDGE_PROTOCOL === APP_BRIDGE_PROTOCOL, `one protocol name in the fixture, the client and the lease reader (${BRIDGE_PROTOCOL})`);
ok(v.discovery.dirEnv === 'KLYPIX_APP_BRIDGE_DIR' && v.discovery.endpointFile === ENDPOINT_FILE && v.discovery.tokenFile === TOKEN_FILE,
  'discovery: KLYPIX_APP_BRIDGE_DIR, endpoint.json, token');
ok(v.discovery.defaultDir === `%APPDATA%${BS}klypix${BS}agent-bridge` && v.discovery.tokenDefaultDir === `%LOCALAPPDATA%${BS}klypix${BS}agent-bridge`,
  'endpoint.json lives in the roaming profile, the token in the machine-local one');
ok(v.framing.lengthPrefix === 'uint32le' && v.framing.encoding === 'utf8-json'
  && v.framing.maxRequestBytes === MAX_REQUEST_BYTES && v.framing.maxResponseBytes === MAX_RESPONSE_BYTES
  && v.framing.idleTimeoutMs === IDLE_TIMEOUT_MS && v.framing.handshakeTimeoutMs === HANDSHAKE_TIMEOUT_MS
  && v.framing.callDeadlineMs === CALL_DEADLINE_MS && v.framing.maxConnectionsPerClient === MAX_CONNECTIONS_PER_CLIENT
  && v.framing.maxConnections === MAX_CONNECTIONS, 'framing limits match the client (1 MiB up, 16 MiB down, 45 s per call)');
ok(JSON.stringify(v.methods) === JSON.stringify([...METHODS]), `the methods match (${METHODS.join(', ')})`);
ok(Object.entries(v.caps).every(([k, n]) => CAPS[k] === n) && Object.keys(CAPS).length === Object.keys(v.caps).length, 'the caps match (20 per tool, 40 in all, 5 cards a call, 3 running)');
ok(JSON.stringify(v.paidBy) === JSON.stringify([...PAID_BY]) && JSON.stringify(v.visibility) === JSON.stringify([...VISIBILITY]), 'paid_by and visibility vocabularies match');

// Revision 2 / 2b sections.
ok(JSON.stringify(v.discovery.endpointFeatures) === JSON.stringify([...ENDPOINT_FEATURES]), 'endpoint.json carries features ["bridge"]');
ok(v.framing.maxCallsPerConnection === MAX_CALLS_PER_CONNECTION && v.framing.maxQueuedWriteBytes === MAX_QUEUED_WRITE_BYTES, 'at most 4 calls in flight per connection; backpressure at 32 MiB');
ok(v.rpcErrors.tooManyCalls === RPC_ERRORS.TOO_MANY_CALLS && v.rpcErrors.authFailed === RPC_ERRORS.AUTH_FAILED && v.rpcErrors.protocolMismatch === RPC_ERRORS.PROTOCOL_MISMATCH
  && v.rpcErrors.tooManyConnections === RPC_ERRORS.TOO_MANY_CONNECTIONS, 'the JSON-RPC error codes match (TOO_MANY_CALLS -32004 included)');
ok(JSON.stringify(v.params) === JSON.stringify(METHOD_PARAMS), 'the parameters main forwards per method match');
ok(JSON.stringify(v.capKinds) === JSON.stringify([...CAP_KINDS]) && JSON.stringify(v.pinSkipped) === JSON.stringify([...PIN_SKIPPED]), 'cap kinds (tool, total) and pin_skipped reasons match');

// ── Frames ──────────────────────────────────────────────────────────────────
for (const f of v.frames) {
  ok(encodeFrame(f.message).toString('hex') === f.hex, `frame ${JSON.stringify(f.message)} encodes to the pinned bytes`);
  const back = new FrameDecoder().push(Buffer.from(f.hex, 'hex'));
  ok(back.length === 1 && JSON.stringify(back[0]) === JSON.stringify(f.message), '  and decodes back');
}
{
  // Split across chunks, two in one chunk, and every refusal the app makes too.
  const a = encodeFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const b = encodeFrame({ jsonrpc: '2.0', id: 2, result: { ok: false } });
  const d = new FrameDecoder();
  const out = [...d.push(a.subarray(0, 3)), ...d.push(Buffer.concat([a.subarray(3), b]))];
  ok(out.length === 2 && out[1].id === 2 && d.pending === 0, 'a stream split mid-frame and two frames in one chunk decode exactly');
  const throws = (buf, kind, max) => { try { new FrameDecoder(max).push(buf); return false; } catch (e) { return e instanceof FrameError && e.kind === kind; } };
  const big = Buffer.alloc(4); big.writeUInt32LE(MAX_RESPONSE_BYTES + 1, 0);
  ok(throws(big, 'TOO_LARGE'), 'a frame over 16 MiB is refused before it is buffered');
  ok(throws(Buffer.from('GET / HTTP/1.1\r\n'), 'HTTP'), 'an HTTP-looking start is refused');
  const notObj = encodeFrame([1, 2]);
  ok(throws(notObj, 'MALFORMED'), 'a body that is not a JSON object is refused');
  let tooBig = false;
  try { encodeFrame({ x: 'y'.repeat(MAX_REQUEST_BYTES) }); } catch (e) { tooBig = e.kind === 'TOO_LARGE'; }
  ok(tooBig, 'the client never sends a request over 1 MiB');
}

// ── Handshake proofs ────────────────────────────────────────────────────────
{
  const h = v.handshake;
  ok(h.tokenHex === '07'.repeat(32) && h.nonceS === 'a'.repeat(32) && h.nonceC === 'b'.repeat(32) && h.clientKey === 'codex', 'the handshake vector is the plan\'s (token 32 × 0x07, nonces a/b, codex)');
  ok(proofC(h.tokenHex, h.nonceS, h.nonceC, h.clientKey) === h.proofC && h.proofC === 'f6c618fb7228a2c755023c975c2b7209212df4dab6d22e223f9b325f943f2cda', 'proofC matches');
  ok(proofS(h.tokenHex, h.nonceC, h.nonceS, h.clientKey) === h.proofS && h.proofS === 'b31c00f53349512a11e2d878e920b7dea51396c137ccff2472f1f19cd0705afc', 'proofS matches');
  ok(proofsMatch(h.proofS, h.proofS) && !proofsMatch(h.proofS, h.proofC) && !proofsMatch(h.proofS, h.proofS.toUpperCase()) && !proofsMatch(h.proofS, undefined),
    'proof comparison accepts only the exact lowercase proof');
}

// ── Who is calling ──────────────────────────────────────────────────────────
for (const { name, key } of v.clientKeys) {
  const got = clientKeyFromName(name);
  ok(got === key && CLIENT_KEY.test(got) && !got.includes('/') && !got.includes(BS) && !got.startsWith('.') && got.length <= 32,
    `clientKey(${JSON.stringify(name)}) = ${JSON.stringify(key)} — a safe slug (got ${JSON.stringify(got)})`);
}
{
  const keys = new Set(['Claude Desktop', 'claude-ai', 'claude-code', 'Claude Code'].map(clientKeyFromName));
  ok(keys.has('claude-desktop') && keys.has('claude-ai') && keys.has('claude-code') && keys.size === 3,
    'Claude Desktop, claude-ai and Claude Code get distinct keys (normalizeMcpClient would collapse them)');
}
ok(JSON.stringify(CLIENT_LABELS.map(([re, label]) => [re.source, re.flags, label])) === JSON.stringify(v.labelPatterns), 'the label map is the shared one, in order');
for (const { name, label } of v.clientLabels) ok(clientLabelFor(name) === label, `clientLabel(${JSON.stringify(name)}) = ${JSON.stringify(label)}`);
ok(clientLabelFor(`evil${String.fromCharCode(0x202e)}name${String.fromCharCode(7)}`) === 'evil name', 'bidi overrides and control characters never reach a label');
ok(clientLabelFor('x'.repeat(90)).length === 64, 'an unknown long name is cut to 64 characters');

// ── The lease vector is still here (P0) ─────────────────────────────────────
ok(Array.isArray(v.canonicalPath?.vectors) && v.canonicalPath.vectors.every(x => pathHash(x.input) === x.sha256), 'the canonical-path vector the lease uses is kept and holds');

// ── Codes the client speaks ─────────────────────────────────────────────────
ok(CODE_SENTENCES.ACCESS_OFF === 'AI tools are turned off in KLYPIX (Settings → Project). Turn them on there, then ask me again.'
  && CODE_SENTENCES.BLOCKED === 'You blocked {tool} in KLYPIX. Unblock it in Settings → Project if you want me to continue.',
'ACCESS_OFF and BLOCKED say what the founder decided (D1, 2026-10-05)');
ok(sentenceFor('DAILY_CAP', { tool: 'Codex' }) === "Codex used today's 20 video readings in KLYPIX. Ask again tomorrow, or read the card in KLYPIX yourself."
  && sentenceFor('DAILY_CAP', { tool: 'Codex', cap: 'total' }).startsWith("AI tools used today's 40 video readings"),
'DAILY_CAP has distinct sentences for this tool\'s cap and the cap all AI tools share');
ok(!('NOT_ALLOWED' in CODE_SENTENCES) && !('WAITING_FOR_USER' in CODE_SENTENCES) && !('DENIED' in CODE_SENTENCES), 'no pairing codes survive in P1');
ok(Object.values(CODE_SENTENCES).every(s => !/never forgets|every agent|all coding agents|end-to-end/i.test(s)), 'no sentence makes a banned claim');

// ── Where a client may connect ──────────────────────────────────────────────
ok(isAllowedPipePath(`${BS}${BS}.${BS}pipe${BS}klypix-agent-0123456789abcdef0123456789abcdef`, 'win32'), 'a KLYPIX bridge pipe is allowed on Windows');
ok(!isAllowedPipePath(`${BS}${BS}.${BS}pipe${BS}spoolss`, 'win32') && !isAllowedPipePath(`${BS}${BS}.${BS}pipe${BS}klypix-agent-x${BS}..${BS}y`, 'win32') && !isAllowedPipePath('C:/x.sock', 'win32'),
  'any other pipe, a path inside one, or a file is refused on Windows');
ok(isAllowedPipePath('/tmp/k/b1.sock', 'linux') && !isAllowedPipePath('rel.sock', 'linux'), 'elsewhere (tests over a Unix socket) only an absolute socket path');

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ app-bridge-vectors: all assertions passed');
process.exit(failures ? 1 : 0);
