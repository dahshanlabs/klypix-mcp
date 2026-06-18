#!/usr/bin/env node
// klypix-a2a — the A2A (Agent2Agent) FACE of KLYPIX.
//
// Where the MCP server (bin/klypix-mcp.mjs) lets ONE agent reach your canvases
// as tools, this exposes the SAME engine as an A2A peer: a discoverable remote
// agent that other agents (and A2A orchestrators) can delegate tasks to over the
// open A2A protocol. KLYPIX's role in a multi-agent stack is the shared, owned,
// multimodal MEMORY node — A2A moves the messages; `.klypix` holds the context.
//
// What makes this best-in-class for A2A specifically: most A2A agents return
// text. KLYPIX returns a portable, multimodal `.klypix` ARTIFACT (a FilePart the
// human owns and any model can re-open) — the spatial board itself, not a
// transcript of one.
//
// Spec surface (JSON-RPC 2.0 over HTTP, the interoperable A2A binding):
//   GET  /.well-known/agent-card.json   → the Agent Card (RFC 8615 discovery)
//   POST /                              → message/send · message/stream (SSE) ·
//                                         tasks/get · tasks/cancel
//
// Local-first: binds 127.0.0.1 by default (the file lives on your disk; no auth
// needed on loopback). Set --host 0.0.0.0 + a reverse proxy to expose it.
//
// Run:  node bin/klypix-a2a.mjs --vault "C:\\path\\to\\canvases" [--port 41241] [--host 127.0.0.1]
//   env: KLYPIX_VAULT, KLYPIX_A2A_PORT, KLYPIX_A2A_HOST

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  resolveVault, getEmbedder, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opCreateCanvas, opAddToCanvas,
} from '../src/klypix-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the package version across layouts: the published package (bin/ →
// ../package.json) and the desktop-bundled FLAT layout (~/.claude/project-brain/,
// ./package.json, which may carry no version) — degrade gracefully either way.
function readVersion() {
  for (const p of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, 'package.json')]) {
    try { const v = JSON.parse(fs.readFileSync(p, 'utf8')).version; if (v) return v; } catch { /* try next */ }
  }
  return '1.x';
}
const PKG = { version: readVersion() };
const log = (...a) => console.error('[klypix-a2a]', ...a);

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const VAULT = resolveVault(arg('--vault'));
const HOST = arg('--host') || process.env.KLYPIX_A2A_HOST || '127.0.0.1';
const PORT = parseInt(arg('--port') || process.env.KLYPIX_A2A_PORT || '41241', 10);

const KLYPIX_MIME = 'application/vnd.klypix+zip';
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ── Agent Card ───────────────────────────────────────────────────────────────
// Published at /.well-known/agent-card.json so any A2A client can discover what
// KLYPIX can do and where to delegate. `url` is the JSON-RPC service endpoint.
function agentCard(publicUrl) {
  return {
    protocolVersion: '0.3.0',
    name: 'KLYPIX Canvas — agent-neutral spatial memory',
    description:
      'The shared, human-owned memory node for a multi-agent stack. Delegate tasks to read, search, ' +
      'and write a portable .klypix canvas (cards + a connection graph + images), and get back the ' +
      'spatial board itself as a multimodal artifact — local-first, model-neutral, no lab in the loop.',
    url: publicUrl,
    version: PKG.version,
    provider: { organization: 'Dahshan Labs', url: 'https://klypix.com' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json', KLYPIX_MIME, 'image/png'],
    skills: [
      {
        id: 'make_board',
        name: 'Turn a brief into a spatial board',
        description: 'Create a new .klypix canvas from cards + connections and return the board as a portable file artifact the human owns and any model can re-open.',
        tags: ['canvas', 'create', 'memory', 'spatial', 'artifact'],
        examples: ['Turn this plan into a board', 'Make a mind-map of these notes'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: [KLYPIX_MIME, 'text/plain'],
      },
      {
        id: 'remember',
        name: 'Remember into the canvas / brain',
        description: 'Append a decision or cards (with optional connections) to an existing .klypix, preserving every existing item and position. The durable, cross-session memory a multi-agent run keeps writing to.',
        tags: ['memory', 'append', 'write', 'brain'],
        examples: ['Remember that we chose Postgres over Mongo', 'Add a card with this finding to the roadmap canvas'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: [KLYPIX_MIME, 'text/plain'],
      },
      {
        id: 'recall',
        name: 'Recall context from the canvases',
        description: 'Search card text, titles, and #tags across every canvas in the vault and return the matching cards — the shared blackboard a delegating agent reads before acting.',
        tags: ['memory', 'search', 'recall', 'read'],
        examples: ['What do we know about the auth design?', 'Find cards mentioning rate limits'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
      {
        id: 'read_canvas',
        name: 'Read a canvas (cards, graph, and images)',
        description: 'Read one canvas as structured markdown — every card, the connection graph, [[wikilinks]], #tags — plus its images returned as file parts so a vision model SEES them.',
        tags: ['read', 'canvas', 'multimodal', 'vision'],
        examples: ['Summarize the canvas roadmap', 'Read the board called SS2'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain', 'image/png'],
      },
      {
        id: 'list_canvases',
        name: 'List the canvases in the vault',
        description: 'List every .klypix / .any canvas with card and connection counts.',
        tags: ['list', 'discover'],
        examples: ['What canvases are available?'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
      {
        id: 'brain_insights',
        name: 'What matters in the brain',
        description: 'Structural read of a brain.klypix: load-bearing hub cards, orphaned decisions, stale open questions, and area sizes. Use to orient before a planning task.',
        tags: ['insights', 'brain', 'review'],
        examples: ['What am I forgetting in the project brain?'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
      {
        id: 'search_all_brains',
        name: 'Search every project brain on this machine',
        description: 'Cross-project memory search across every registered brain.klypix (semantic + lexical). Optional as_of date for a point-in-time query.',
        tags: ['memory', 'search', 'cross-project'],
        examples: ['What did I decide about auth in any project?'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
      {
        id: 'brain_connect',
        name: 'Densify the brain graph (connect related cards)',
        description: 'Find genuinely related but unlinked cards and propose (or, with apply, draw) connections — semantic when the on-device model is present, else shared tags + [[mentions]]. Additive; never deletes.',
        tags: ['brain', 'graph', 'connect', 'memory'],
        examples: ['Connect the related cards in my project brain'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain'],
      },
    ],
    securitySchemes: {},
    security: [],
    supportsAuthenticatedExtendedCard: false,
  };
}

// ── Skill execution ──────────────────────────────────────────────────────────
// Each skill maps to one core op. Args come from a structured DataPart
// (deterministic — what an orchestrator sends) or are inferred from text.
const cardsArg = z.array(cardSchema).min(1);
const connsArg = z.array(connSchema).optional();

async function runSkill(skill, args, text, via) {
  // Network trust boundary: resolveCanvas honors absolute / `..` refs (fine for
  // the trusted MCP stdio face) — but THIS is an HTTP listener, so refuse any
  // canvas ref that resolves outside the vault before it reaches the engine.
  if (args && args.canvas != null && !vaultContained(args.canvas)) {
    return { blocks: [{ kind: 'text', text: `Refused: canvas "${args.canvas}" resolves outside the vault. The A2A face only serves canvases inside ${VAULT}.` }], isError: true };
  }
  switch (skill) {
    case 'list_canvases':
      return await opListCanvases({ vault: VAULT });
    case 'read_canvas':
      return await opReadCanvas({ vault: VAULT, canvas: args.canvas ?? extractCanvas(text) ?? text.trim() });
    case 'recall':
    case 'search_canvases':
      return await opSearchCanvases({ vault: VAULT, query: args.query ?? text.trim() });
    case 'search_all_brains':
      return await opSearchAllBrains({ vault: VAULT, query: args.query ?? text.trim(), as_of: args.as_of, log });
    case 'brain_insights':
      return await opBrainInsights({ vault: VAULT, canvas: args.canvas, staleDays: args.staleDays });
    case 'brain_connect':
      return await opBrainConnect({ vault: VAULT, canvas: args.canvas, apply: args.apply, max: args.max, threshold: args.threshold, log });
    case 'make_board':
    case 'create_canvas': {
      // Structured cards (DataPart) are preferred; otherwise split a free-text
      // brief into one card per line/item so NL "make a board: a; b; c" works.
      const cards = args.cards ?? (text.trim() ? briefToCards(text) : null);
      const parsed = cardsArg.safeParse(cards && cards.length ? cards : null);
      if (!parsed.success) {
        return needInput('make_board needs cards. Send a DataPart `{"skill":"make_board","args":{"title":"…","cards":[{"text":"…"}],"connections":[{"from":0,"to":1}]}}`, or a brief with one item per line.');
      }
      const conns = connsArg.safeParse(args.connections);
      if (!conns.success) return needInput('connections must be `[{ "from": <index|title>, "to": <index|title> }]`.');
      return await opCreateCanvas({ vault: VAULT, title: args.title ?? 'Untitled board', cards: parsed.data, connections: conns.data, filename: args.filename });
    }
    case 'remember':
    case 'add_to_canvas': {
      // NL convenience: a bare "remember: X" becomes a single card on the brain.
      const cards = args.cards ?? (text.trim() ? [{ text: stripVerb(text) }] : null);
      const parsed = cardsArg.safeParse(cards);
      if (!parsed.success) {
        return needInput('remember needs at least one card. Send text to capture, or a DataPart `{"skill":"remember","args":{"canvas":"brain","cards":[{"text":"…"}]}}`.');
      }
      const conns = connsArg.safeParse(args.connections);
      if (!conns.success) return needInput('connections must be `[{ "from": <index|title>, "to": <index|title> }]`.');
      return await opAddToCanvas({ vault: VAULT, canvas: args.canvas ?? 'brain', cards: parsed.data, connections: conns.data, via });
    }
    default:
      return { blocks: [{ kind: 'text', text: `Unknown skill: ${skill}` }], isError: true };
  }
}
const needInput = (msg) => ({ inputRequired: true, blocks: [{ kind: 'text', text: msg }] });

// The network face refuses canvas refs that resolve outside the vault (absolute
// paths or `..` traversal). A bare title resolves under the vault → allowed.
function vaultContained(ref) {
  if (ref == null || ref === '') return true;
  const root = path.resolve(VAULT);
  const resolved = path.resolve(VAULT, String(ref));
  return resolved === root || resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep);
}

// ── Intent routing (fallback when no structured skill is given) ──────────────
const STOP = /^(the|a|an|this|that|my|our|on|in|of|to|what|whats|it|is|are|all)$/i;
function extractCanvas(text) {
  const s = String(text || '');
  // "canvas roadmap" / "board called X" / "named X"
  let m = /(?:canvas|board|called|named)\s+["“]?([\w.\-]{2,40})["”]?/i.exec(s);
  if (m && !STOP.test(m[1])) return m[1].trim();
  // "roadmap canvas" / "the X board" — the name BEFORE the keyword
  m = /["“]?([\w.\-]{2,40})["”]?\s+(?:canvas|board)\b/i.exec(s);
  if (m && !STOP.test(m[1])) return m[1].trim();
  return null;
}
function stripVerb(text) {
  return String(text || '').replace(/^\s*(please\s+)?(remember|note|capture|log|add a card[:,]?|record)\b[:,]?\s*/i, '').trim() || String(text || '').trim();
}
// Split a free-text brief into atomic cards (one per line / `;` / bullet, or a
// comma list when there are no line breaks). Lossy — a DataPart is preferred.
function briefToCards(text) {
  let body = String(text || '').replace(/^.*?\b(board|canvas|mind ?map|map|diagram)\b[:\-—\s]*/i, '').trim();
  if (!body) body = String(text || '').trim();
  let parts = body.split(/\r?\n|;|·|•|•/).map(s => s.trim()).filter(s => s.length > 1);
  if (parts.length < 2 && /,/.test(body)) parts = body.split(',').map(s => s.trim()).filter(s => s.length > 1);
  return parts.map(s => ({ text: s.replace(/^[-*\d.)\]\s]+/, '').trim() })).filter(c => c.text);
}
function routeIntent(text, dataArgs) {
  if (dataArgs && dataArgs.skill) return { skill: dataArgs.skill, args: dataArgs.args || dataArgs };
  const t = String(text || '').toLowerCase();
  const named = extractCanvas(text);
  if (/\b(make|build|create|draw|turn .* into).{0,30}(board|canvas|mind ?map|map|diagram)\b/.test(t)) return { skill: 'make_board', args: {} };
  if (/\b(remember|note this|capture this|log that|record that|add a card)\b/.test(t)) return { skill: 'remember', args: {} };
  // An explicit read verb OR a specific named canvas → read it. Checked BEFORE
  // list so "what's on the roadmap canvas" reads that canvas, not the vault index.
  if (named || /\b(read|open|summari[sz]e|show)\b.{0,30}\b(canvas|board)\b/.test(t)) return { skill: 'read_canvas', args: {} };
  // list = discovery intent with NO specific canvas named.
  if (/\b(list|all|available|which|what)\b.{0,20}\bcanvas(es)?\b/.test(t)) return { skill: 'list_canvases', args: {} };
  if (/\b(insight|what matters|hubs?|orphan|stale|forgetting|review the brain)\b/.test(t)) return { skill: 'brain_insights', args: {} };
  if (/\b(across|all brains|other projects?|any project)\b/.test(t)) return { skill: 'search_all_brains', args: {} };
  return { skill: 'recall', args: {} }; // safest default: "what do we know about X"
}

// ── Message / Part / Task helpers (A2A shapes) ───────────────────────────────
function partsToText(parts) {
  return (parts || []).filter(p => p.kind === 'text' || typeof p.text === 'string').map(p => p.text).join('\n').trim();
}
function dataPart(parts) {
  const p = (parts || []).find(p => p.kind === 'data' && p.data);
  return p ? p.data : null;
}
// Core block[] (+ optional file) → A2A Part[].
function blocksToParts(result) {
  const parts = [];
  for (const b of result.blocks || []) {
    if (b.kind === 'image') parts.push({ kind: 'file', file: { name: b.name || 'image.png', mimeType: b.mime || 'image/png', bytes: b.data } });
    else parts.push({ kind: 'text', text: b.text });
  }
  if (result.file) {
    parts.push({ kind: 'file', file: { name: result.file.name, mimeType: KLYPIX_MIME, bytes: Buffer.from(result.file.buffer).toString('base64') } });
  }
  return parts;
}

const tasks = new Map(); // id → task (in-memory; local-first single user)

async function buildTask(userMessage) {
  // A2A multi-turn continuation: if the client replies with the taskId of an
  // input-required task, resume it (stable id + contextId + accumulated history)
  // instead of minting an unrelated new task.
  const prior = userMessage.taskId ? tasks.get(userMessage.taskId) : null;
  const resuming = !!prior && prior.status.state === 'input-required';
  const id = resuming ? prior.id : uuid();
  const contextId = userMessage.contextId || prior?.contextId || uuid();
  const text = partsToText(userMessage.parts);
  const data = dataPart(userMessage.parts);
  const via = userMessage.metadata?.agentName || data?.agentName || 'a2a';
  const { skill, args } = routeIntent(text, data);

  let result;
  try { result = await runSkill(skill, args || {}, text, via); }
  catch (e) { result = { blocks: [{ kind: 'text', text: `Skill "${skill}" failed: ${e.message}` }], isError: true }; }

  const state = result.isError ? 'failed' : result.inputRequired ? 'input-required' : 'completed';
  const task = {
    kind: 'task',
    id,
    contextId,
    status: {
      state,
      timestamp: now(),
      message: {
        kind: 'message', role: 'agent', messageId: uuid(), taskId: id, contextId,
        parts: state === 'completed'
          ? [{ kind: 'text', text: `Done via skill "${skill}".` }]
          : blocksToParts(result),
      },
    },
    artifacts: state === 'completed'
      ? [{ artifactId: uuid(), name: result.file?.name || `${skill}-result`, parts: blocksToParts(result) }]
      : [],
    history: resuming ? [...prior.history, userMessage] : [userMessage],
    metadata: { skill },
  };
  tasks.set(id, task);
  return task;
}

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function statusUpdate(task, final) {
  const status = { state: final ? task.status.state : 'working', timestamp: now() };
  // Surface the terminal message (error text / input-required prompt / done note)
  // on the final event so a client that only reads the last update still sees it.
  if (final && task.status.message) status.message = task.status.message;
  return { kind: 'status-update', taskId: task.id, contextId: task.contextId, status, final };
}
function artifactUpdate(task) {
  return { kind: 'artifact-update', taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0], append: false, lastChunk: true };
}

async function handleRpc(body, res) {
  const { id, method, params } = body || {};
  if (!method) return sendJson(res, 200, rpcErr(id ?? null, -32600, 'Invalid Request: missing method'));

  if (method === 'message/send') {
    const msg = params?.message;
    if (!msg || !Array.isArray(msg.parts)) return sendJson(res, 200, rpcErr(id, -32602, 'Invalid params: message.parts required'));
    const task = await buildTask(msg);
    return sendJson(res, 200, rpcOk(id, task));
  }

  if (method === 'message/stream') {
    const msg = params?.message;
    if (!msg || !Array.isArray(msg.parts)) return sendJson(res, 200, rpcErr(id, -32602, 'Invalid params: message.parts required'));
    // SSE with a MONOTONIC A2A lifecycle: a non-terminal Task first, then (only
    // for completed work) the artifact, then exactly ONE terminal status-update
    // with final:true. No backward state transitions. Each event is wrapped as a
    // JSON-RPC response carrying the request id (the A2A streaming binding).
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const send = (event) => res.write(`data: ${JSON.stringify(rpcOk(id, event))}\n\n`);
    const task = await buildTask(msg);
    send({ ...task, status: { state: 'submitted', timestamp: now() }, artifacts: [] }); // 1. non-terminal Task
    if (task.status.state === 'completed' && task.artifacts.length) send(artifactUpdate(task)); // 2. artifact (completed only)
    send(statusUpdate(task, true));                                                    // 3. single terminal status (final:true)
    return res.end();
  }

  if (method === 'tasks/get') {
    const t = tasks.get(params?.id);
    return t ? sendJson(res, 200, rpcOk(id, t)) : sendJson(res, 200, rpcErr(id, -32001, 'Task not found'));
  }

  if (method === 'tasks/cancel') {
    const t = tasks.get(params?.id);
    if (!t) return sendJson(res, 200, rpcErr(id, -32001, 'Task not found'));
    // Terminal tasks can't be canceled; ours complete synchronously.
    if (['completed', 'failed', 'canceled'].includes(t.status.state)) return sendJson(res, 200, rpcErr(id, -32002, `Task not cancelable (state: ${t.status.state})`));
    t.status = { state: 'canceled', timestamp: now() };
    return sendJson(res, 200, rpcOk(id, t));
  }

  return sendJson(res, 200, rpcErr(id, -32601, `Method not found: ${method}`));
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST + ':' + PORT}`);
  const publicUrl = `http://${req.headers.host || `${HOST}:${PORT}`}/`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  // Agent Card discovery (RFC 8615). Serve the current + legacy well-known paths.
  if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
    return sendJson(res, 200, agentCard(publicUrl));
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, { name: 'klypix-a2a', version: PKG.version, vault: VAULT, agentCard: `${publicUrl}.well-known/agent-card.json` });
  }

  if (req.method === 'POST') {
    // Byte-accurate body cap (count bytes, not UTF-16 code units) + bail before
    // buffering an over-size chunk.
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 50_000_000) return req.destroy(); chunks.push(c); });
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 200, rpcErr(null, -32700, 'Parse error')); }
      try { await handleRpc(body, res); }
      catch (e) { log('rpc error', e); if (!res.headersSent) sendJson(res, 200, rpcErr(body?.id ?? null, -32603, `Internal error: ${e.message}`)); else res.end(); }
    });
    return;
  }

  sendJson(res, 404, rpcErr(null, -32601, 'Not found'));
});

// Defense-in-depth socket timeouts (cheap; matters if anyone exposes this past
// the loopback default without a fronting proxy — guards slow-loris).
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  log(`ready · vault=${VAULT}`);
  log(`agent card: http://${HOST}:${PORT}/.well-known/agent-card.json`);
  log(`A2A endpoint (JSON-RPC): http://${HOST}:${PORT}/`);
  // Pre-warm the on-device embedder so the first cross-project search is semantic.
  getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
});
