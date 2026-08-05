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
// Local-only: binds loopback (the file lives on your disk; no auth is exposed).
// Non-loopback binds are refused until authentication, TLS, and cross-process
// write coordination exist together.
//
// Run:  node bin/klypix-a2a.mjs --vault "C:\\path\\to\\canvases" [--port 41241] [--host 127.0.0.1]
//   env: KLYPIX_VAULT, KLYPIX_A2A_PORT, KLYPIX_A2A_HOST

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  resolveVault, resolveCanvas, getEmbedder, shouldPrewarmSemantic, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opCreateCanvas, opAddToCanvas, opBrainNote,
} from '../src/klypix-core.mjs';
import { looksLikeSkill } from '../src/klypix-format.mjs';

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
const ALLOW_CROSS_PROJECT = process.argv.includes('--allow-cross-project');

const normalizedHostname = (value) => String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackHostname = (value) => ['127.0.0.1', 'localhost', '::1'].includes(normalizedHostname(value));
if (!isLoopbackHostname(HOST)) {
  console.error('[klypix-a2a] Refusing non-loopback --host. A2A is local-only until auth, TLS, and cross-process write locking ship together.');
  process.exit(2);
}

// ── OS-user auth boundary ────────────────────────────────────────────────────
// Loopback TCP is MACHINE-local, not OS-user-local: on a shared machine any
// other local user (or sandboxed process) can reach this port — and POST /
// includes brain WRITES, which land in every future session's context. A
// per-start bearer token stored under ~/.claude/project-brain (the SAME
// user-ACL boundary that already protects the coordination lane) restores the
// stated boundary: only a process that can read this user's home can mutate.
// KLYPIX_A2A_TOKEN overrides for shared-secret setups; --no-auth opts out
// explicitly (never silently).
const NO_AUTH = process.argv.includes('--no-auth') || process.env.KLYPIX_A2A_NO_AUTH === '1';
const TOKEN_FILE = path.join(os.homedir(), '.claude', 'project-brain', `.a2a-token-${PORT}`);
const TOKEN = (() => {
  if (NO_AUTH) return null;
  const fromEnv = String(process.env.KLYPIX_A2A_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e) {
    console.error(`[klypix-a2a] Could not write the auth token file (${e?.message || e}); refusing to start UNAUTHENTICATED. Set KLYPIX_A2A_TOKEN or pass --no-auth explicitly.`);
    process.exit(2);
  }
  return token;
})();
// Fingerprint (never the token) served on /health: a client verifies the server
// actually holds the token from THIS user's token file BEFORE sending it — so a
// port-squatting impostor can neither pass verification nor harvest the token.
const TOKEN_FINGERPRINT = TOKEN ? crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 16) : null;
function authorized(req) {
  if (!TOKEN) return true;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) return false;
  const presented = Buffer.from(m[1].trim());
  const expected = Buffer.from(TOKEN);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

const KLYPIX_MIME = 'application/vnd.klypix+zip';
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ── Agent Card ───────────────────────────────────────────────────────────────
// Published at /.well-known/agent-card.json so any A2A client can discover what
// KLYPIX can do and where to delegate. `url` is the JSON-RPC service endpoint.
function agentCard(publicUrl) {
  const skills = [
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
      description: 'Append a decision or cards (with optional connections) to an existing .klypix, preserving every existing item and position. The durable, cross-session memory a multi-agent run keeps writing to. Pass a "marker" in args for the full lifecycle: ""=decision · "?"=open question · "!"=milestone · "+"=🛠️ skill · "✓"=resolve a match · "~"=update a match.',
      tags: ['memory', 'append', 'write', 'brain', 'lifecycle'],
      examples: ['Remember that we chose Postgres over Mongo', 'Add a card with this finding to the roadmap canvas'],
      inputModes: ['text/plain', 'application/json'],
      outputModes: [KLYPIX_MIME, 'text/plain'],
    },
    {
      id: 'learn_skill',
      name: 'Learn a reusable skill (how-to / gotcha)',
      description: 'Record a 🛠️ SKILL — a reusable how-to, gotcha, or convention ("always dedup zKeys before REORDER") that should resurface every session and never age out, distinct from a one-time decision. Routes through the capture engine with the "+" marker. A delegating agent uses this to teach the shared brain how work is done here, so every future agent inherits it. Plain "remember" auto-promotes to a skill when the text reads as a general rule.',
      tags: ['memory', 'skill', 'how-to', 'procedure', 'brain', 'learn'],
      examples: ['Learn this gotcha: never set backgroundThrottling false — it breaks visibility detection', 'Remember the convention: Electron main imports must stay at top'],
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
    ...(ALLOW_CROSS_PROJECT ? [{
      id: 'search_all_brains',
      name: 'Search every project brain on this machine',
      description: 'Cross-project memory search across every registered brain.klypix (semantic + lexical). Optional as_of date for a point-in-time query.',
      tags: ['memory', 'search', 'cross-project'],
      examples: ['What did I decide about auth in any project?'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    }] : []),
    {
      id: 'brain_connect',
      name: 'Repair orphaned brain cards (connect related cards)',
      description: 'Propose related links for orphaned decision/milestone cards by default, with a before→projected receipt; apply draws only additive, removable connections and never archives or rewrites cards. Pass scope:"all" for deliberate whole-graph densification.',
      tags: ['brain', 'graph', 'connect', 'memory'],
      examples: ['Connect the related cards in my project brain'],
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain'],
    },
  ];
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
    skills,
    securitySchemes: {},
    security: [],
    supportsAuthenticatedExtendedCard: false,
  };
}

// ── Skill execution ──────────────────────────────────────────────────────────
// Each skill maps to one core op. Args come from a structured DataPart
// (deterministic — what an orchestrator sends) or are inferred from text.
const a2aCardSchema = cardSchema.extend({
  text: z.string().max(20_000, 'card text must be 20,000 characters or fewer'),
});
const cardsArg = z.array(a2aCardSchema).min(1).max(500);
const connsArg = z.array(connSchema).max(1_000).optional();

// Compatibility spellings accepted by the dispatcher but deliberately omitted
// from the Agent Card. The smoke test asserts every switch case is either
// advertised or named here, so this cannot silently drift again.
const ALIASES = Object.freeze({
  search_canvases: 'recall',
  create_canvas: 'make_board',
  add_to_canvas: 'remember',
});

// Engine operations intentionally not exposed over unauthenticated HTTP. The
// smoke test asserts every exported op is either wired or carries a reason here.
const DELIBERATELY_UNWIRED = Object.freeze({
  opBrainTaskContext: 'cross-session task context is MCP-only; A2A has no authenticated presence identity',
  opBrainAsk: 'brain recall stays on the smaller audited A2A surface until a named client needs it',
  opBrainChallenge: 'deferred until the frozen A2A surface is deliberately expanded',
  opCanvasView: 'requires structured DataPart output before it can preserve the spatial render spec',
  opBrainLens: 'not part of the frozen A2A preview surface',
  opBrainReconcile: 'wire-supplied roots can traverse host directories; keep MCP-only',
  opBrainGarden: 'apply requires an out-of-band human approval code and must never be weakened for A2A',
  opBrainMessage: 'send-only machine-local messaging has no receivable A2A half',
});

const canonicalPath = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
function pathInside(root, target) {
  const norm = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  const rel = path.relative(norm(canonicalPath(root)), norm(canonicalPath(target)));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
// Resolve the EFFECTIVE ref first (including fuzzy title lookup and symlinks),
// validate that resolved file, then pass the same absolute path to the engine.
// Missing refs may continue only when their would-be path stays inside the vault
// so the engine can return its normal "not found" result without path leakage.
function confinedCanvas(ref) {
  if (ref == null || String(ref).trim() === '') return { ok: true, canvas: ref };
  const raw = String(ref);
  const file = resolveCanvas(VAULT, raw);
  const effective = file || path.resolve(VAULT, raw);
  if (!pathInside(VAULT, effective)) return { ok: false };
  return { ok: true, canvas: file ? canonicalPath(file) : raw };
}
const refusedCanvas = (ref) => ({
  blocks: [{ kind: 'text', text: `Refused: canvas "${String(ref).slice(0, 160)}" resolves outside the vault configured for this server.` }],
  isError: true,
});
const finiteNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function runSkill(skill, args, text, via) {
  skill = ALIASES[skill] || skill;
  switch (skill) {
    case 'list_canvases':
      return await opListCanvases({ vault: VAULT });
    case 'read_canvas': {
      const requested = args.canvas ?? extractCanvas(text) ?? text.trim();
      const target = confinedCanvas(requested);
      if (!target.ok) return refusedCanvas(requested);
      return await opReadCanvas({ vault: VAULT, canvas: target.canvas });
    }
    case 'recall':
      return await opSearchCanvases({ vault: VAULT, query: args.query ?? text.trim() });
    case 'search_all_brains':
      if (!ALLOW_CROSS_PROJECT) return { blocks: [{ kind: 'text', text: 'Cross-project search is disabled on this A2A server. Restart with --allow-cross-project to opt in.' }], isError: true };
      return await opSearchAllBrains({ vault: VAULT, query: args.query ?? text.trim(), as_of: args.as_of, log });
    case 'brain_insights': {
      const target = confinedCanvas(args.canvas);
      if (!target.ok) return refusedCanvas(args.canvas);
      return await opBrainInsights({ vault: VAULT, canvas: target.canvas, staleDays: args.staleDays });
    }
    case 'brain_connect': {
      const target = confinedCanvas(args.canvas);
      if (!target.ok) return refusedCanvas(args.canvas);
      const max = Math.max(1, Math.min(200, Math.floor(finiteNumber(args.max, 24))));
      const threshold = args.threshold == null
        ? null
        : Math.max(0.3, Math.min(1, finiteNumber(args.threshold, 0.55)));
      const scope = args.scope === 'all' ? 'all' : 'orphans';
      return await opBrainConnect({ vault: VAULT, canvas: target.canvas, apply: args.apply === true, max, threshold, scope, log });
    }
    case 'make_board':
    {
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
    case 'learn_skill': {
      // Route through the brain's CAPTURE ENGINE (full lifecycle + markers, incl.
      // 🛠️ skills) when: the caller passed a marker, asked for learn_skill, or the
      // text reads as a reusable rule (auto-skill from the flow — the same
      // classifier the Claude-Code hook uses). Otherwise: flat multi-card append.
      let marker = String(args.marker || '').trim();
      if (skill === 'learn_skill') marker = '+';
      const single = (!args.cards && text.trim()) ? stripVerb(text) : null;
      if (!marker && single && looksLikeSkill(single)) marker = '+';   // NL "remember this gotcha: always…" → skill
      if (marker) {
        const noteText = single ?? (Array.isArray(args.cards) && args.cards[0]?.text) ?? '';
        if (!String(noteText).trim()) return needInput('Nothing to capture — send text or a card to remember.');
        if (String(noteText).length > 20_000) return needInput('Captured text must be 20,000 characters or fewer.');
        const requested = args.canvas ?? 'brain';
        const target = confinedCanvas(requested);
        if (!target.ok) return refusedCanvas(requested);
        return await opBrainNote({ vault: VAULT, canvas: target.canvas, text: noteText, area: args.area, marker, closes: args.closes, via });
      }
      // NL convenience: a bare "remember: X" becomes a single card on the brain.
      const cards = args.cards ?? (text.trim() ? [{ text: stripVerb(text) }] : null);
      const parsed = cardsArg.safeParse(cards);
      if (!parsed.success) {
        return needInput('remember needs at least one card. Send text to capture, or a DataPart `{"skill":"remember","args":{"canvas":"brain","cards":[{"text":"…"}]}}`.');
      }
      const conns = connsArg.safeParse(args.connections);
      if (!conns.success) return needInput('connections must be `[{ "from": <index|title>, "to": <index|title> }]`.');
      const requested = args.canvas ?? 'brain';
      const target = confinedCanvas(requested);
      if (!target.ok) return refusedCanvas(requested);
      return await opAddToCanvas({ vault: VAULT, canvas: target.canvas, cards: parsed.data, connections: conns.data, via });
    }
    default:
      return { blocks: [{ kind: 'text', text: `Unknown skill: ${skill}` }], isError: true };
  }
}
const needInput = (msg) => ({ inputRequired: true, blocks: [{ kind: 'text', text: msg }] });

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
  if (/\b(learn (this|a) skill|teach the brain|remember the (convention|rule|gotcha)|this is a (gotcha|pitfall|footgun))\b/.test(t) || /\bskill:/i.test(text)) return { skill: 'learn_skill', args: {} };
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
// Core block[] (+ optional file) → A2A Part[], honoring the caller's negotiated
// output modes. A text-only caller must never receive a `.klypix` FilePart.
function blocksToParts(result, acceptedOutputModes) {
  const accepted = Array.isArray(acceptedOutputModes) ? new Set(acceptedOutputModes) : null;
  const allows = (mime) => !accepted || accepted.has(mime) || accepted.has('*/*');
  const parts = [];
  for (const b of result.blocks || []) {
    if (b.kind === 'image') {
      const mime = b.mime || 'image/png';
      if (allows(mime)) parts.push({ kind: 'file', file: { name: b.name || 'image.png', mimeType: mime, bytes: b.data } });
    } else if (allows('text/plain')) parts.push({ kind: 'text', text: b.text });
  }
  if (result.file && allows(KLYPIX_MIME)) {
    parts.push({ kind: 'file', file: { name: result.file.name, mimeType: KLYPIX_MIME, bytes: Buffer.from(result.file.buffer).toString('base64') } });
  }
  return parts;
}

const TASK_MAX_COUNT = 100;
const TASK_MAX_BYTES = 256 * 1024 * 1024;
const TASK_TTL_MS = 60 * 60 * 1000;
const tasks = new Map(); // id → { task, bytes, touchedAt, resume }
let retainedTaskBytes = 0;
const taskBytes = (task) => {
  try { return Buffer.byteLength(JSON.stringify(task)); } catch { return 0; }
};
function deleteTask(id) {
  const old = tasks.get(id);
  if (!old) return;
  retainedTaskBytes -= old.bytes;
  tasks.delete(id);
}
function pruneTasks(at = Date.now()) {
  for (const [id, entry] of tasks) {
    if (at - entry.touchedAt > TASK_TTL_MS) deleteTask(id);
  }
  while (tasks.size > TASK_MAX_COUNT || retainedTaskBytes > TASK_MAX_BYTES) {
    const oldest = tasks.keys().next().value;
    if (oldest == null) break;
    deleteTask(oldest);
  }
}
function getTaskEntry(id) {
  if (!id) return null;
  pruneTasks();
  const entry = tasks.get(id);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  tasks.delete(id); tasks.set(id, entry); // LRU touch
  return entry;
}
function storeTask(task, resume) {
  deleteTask(task.id);
  const entry = { task, bytes: taskBytes(task), touchedAt: Date.now(), resume };
  tasks.set(task.id, entry);
  retainedTaskBytes += entry.bytes;
  pruneTasks();
}

function a2aVia(userMessage, data) {
  const claimed = userMessage.metadata?.agentName ?? data?.agentName ?? 'anonymous';
  const raw = String(claimed).slice(0, 256).trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'anonymous';
  return `a2a:${slug.slice(0, 24)}`;
}
function continuationArgs(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  if (data.args && typeof data.args === 'object' && !Array.isArray(data.args)) return data.args;
  const { skill: _skill, agentName: _agentName, ...rest } = data;
  return rest;
}

async function buildTask(userMessage, configuration = {}) {
  // A2A multi-turn continuation: if the client replies with the taskId of an
  // input-required task, resume it (stable id + contextId + accumulated history)
  // instead of minting an unrelated new task.
  const priorEntry = userMessage.taskId ? getTaskEntry(userMessage.taskId) : null;
  const prior = priorEntry?.task;
  const resuming = !!prior && prior.status.state === 'input-required';
  const id = resuming ? prior.id : uuid();
  const contextId = userMessage.contextId || prior?.contextId || uuid();
  const text = partsToText(userMessage.parts);
  const data = dataPart(userMessage.parts);
  const via = a2aVia(userMessage, data);
  let { skill, args } = routeIntent(text, data);
  if (resuming && typeof data?.skill !== 'string') {
    skill = priorEntry.resume.skill;
    args = { ...(priorEntry.resume.args || {}), ...continuationArgs(data) };
  }

  let result;
  try { result = await runSkill(skill, args || {}, text, via); }
  catch (e) { result = { blocks: [{ kind: 'text', text: `Skill "${skill}" failed: ${e.message}` }], isError: true }; }

  const state = result.isError ? 'failed' : result.inputRequired ? 'input-required' : 'completed';
  const acceptedOutputModes = configuration?.acceptedOutputModes;
  const resultParts = blocksToParts(result, acceptedOutputModes);
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
          : resultParts,
      },
    },
    artifacts: state === 'completed' && resultParts.length
      ? [{ artifactId: uuid(), name: result.file?.name || `${skill}-result`, parts: resultParts }]
      : [],
    history: resuming ? [...prior.history, userMessage] : [userMessage],
    metadata: { skill },
  };
  storeTask(task, { skill, args: args || {} });
  return task;
}

function failedStreamTask(userMessage, error) {
  const id = uuid();
  const contextId = userMessage?.contextId || uuid();
  const message = String(error?.message || error || 'Unknown stream failure').slice(0, 500);
  const task = {
    kind: 'task', id, contextId,
    status: {
      state: 'failed', timestamp: now(),
      message: { kind: 'message', role: 'agent', messageId: uuid(), taskId: id, contextId, parts: [{ kind: 'text', text: `Stream failed: ${message}` }] },
    },
    artifacts: [], history: userMessage ? [userMessage] : [], metadata: { skill: 'unknown' },
  };
  storeTask(task, { skill: 'unknown', args: {} });
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
    const task = await buildTask(msg, params?.configuration);
    return sendJson(res, 200, rpcOk(id, task));
  }

  if (method === 'message/stream') {
    const msg = params?.message;
    if (!msg || !Array.isArray(msg.parts)) return sendJson(res, 200, rpcErr(id, -32602, 'Invalid params: message.parts required'));
    // SSE with a MONOTONIC A2A lifecycle: a non-terminal Task first, then (only
    // for completed work) the artifact, then exactly ONE terminal status-update
    // with final:true. No backward state transitions. Each event is wrapped as a
    // JSON-RPC response carrying the request id (the A2A streaming binding).
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event) => res.write(`data: ${JSON.stringify(rpcOk(id, event))}\n\n`);
    try {
      const task = await buildTask(msg, params?.configuration);
      send({ ...task, status: { state: 'submitted', timestamp: now() }, artifacts: [] }); // 1. non-terminal Task
      if (task.status.state === 'completed' && task.artifacts.length) send(artifactUpdate(task)); // 2. artifact (completed only)
      send(statusUpdate(task, true));                                                    // 3. single terminal status (final:true)
    } catch (e) {
      // Headers have already been sent; the A2A stream must still terminate with
      // one final:true status rather than leaving the client hanging forever.
      log('stream error', e);
      send(statusUpdate(failedStreamTask(msg, e), true));
    } finally {
      res.end();
    }
    return;
  }

  if (method === 'tasks/get') {
    const t = getTaskEntry(params?.id)?.task;
    return t ? sendJson(res, 200, rpcOk(id, t)) : sendJson(res, 200, rpcErr(id, -32001, 'Task not found'));
  }

  if (method === 'tasks/cancel') {
    const entry = getTaskEntry(params?.id);
    const t = entry?.task;
    if (!t) return sendJson(res, 200, rpcErr(id, -32001, 'Task not found'));
    // Terminal tasks can't be canceled; ours complete synchronously.
    if (['completed', 'failed', 'canceled'].includes(t.status.state)) return sendJson(res, 200, rpcErr(id, -32002, `Task not cancelable (state: ${t.status.state})`));
    t.status = { state: 'canceled', timestamp: now() };
    storeTask(t, entry.resume);
    return sendJson(res, 200, rpcOk(id, t));
  }

  return sendJson(res, 200, rpcErr(id, -32601, `Method not found: ${method}`));
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function parsedAuthority(raw) {
  try { return new URL(`http://${String(raw || '')}`); } catch { return null; }
}
function allowedHostHeader(raw) {
  const parsed = parsedAuthority(raw);
  return !!parsed && isLoopbackHostname(parsed.hostname) && !parsed.username && !parsed.password;
}
function allowedOrigin(origin, hostHeader) {
  if (!origin) return true; // normal server-to-server A2A clients send no Origin
  try {
    const source = new URL(String(origin));
    const target = parsedAuthority(hostHeader);
    return source.protocol === 'http:' && !!target
      && normalizedHostname(source.hostname) === normalizedHostname(target.hostname)
      && (source.port || '80') === (target.port || '80');
  } catch { return false; }
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

const server = http.createServer((req, res) => {
  const hostHeader = req.headers.host;
  if (!allowedHostHeader(hostHeader)) return sendJson(res, 403, { error: 'Forbidden Host header.' });
  if (!allowedOrigin(req.headers.origin, hostHeader)) return sendJson(res, 403, { error: 'Foreign browser origins are not allowed.' });

  const url = new URL(req.url, `http://${hostHeader}`);
  const publicUrl = `http://${hostHeader}/`;

  if (req.method === 'OPTIONS') {
    return sendJson(res, 405, { error: 'CORS preflight is not supported; use a server-to-server A2A client.' });
  }

  // Agent Card discovery (RFC 8615). Serve the current + legacy well-known paths.
  if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
    return sendJson(res, 200, agentCard(publicUrl));
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, {
      name: 'klypix-a2a', version: PKG.version, agentCard: `${publicUrl}.well-known/agent-card.json`,
      auth: TOKEN
        ? { scheme: 'bearer', tokenFile: TOKEN_FILE, tokenFingerprint: TOKEN_FINGERPRINT }
        : { scheme: 'none' },
    });
  }

  if (req.method === 'POST') {
    if (!authorized(req)) {
      return sendJson(res, 401, rpcErr(null, -32001, `Unauthorized. Read the bearer token (same OS user) from ${TOKEN_FILE} and send "Authorization: Bearer <token>"; verify the server first via GET /health tokenFingerprint.`));
    }
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return sendJson(res, 415, rpcErr(null, -32600, 'Content-Type must be application/json.'));
    }
    // Byte-accurate body cap (count bytes, not UTF-16 code units) + bail before
    // retaining an over-size payload. Keep consuming the socket, but discard it.
    let size = 0; let tooLarge = false; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', async () => {
      if (tooLarge) return sendJson(res, 413, rpcErr(null, -32600, 'Request body exceeds the 1 MiB limit.'));
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 200, rpcErr(null, -32700, 'Parse error')); }
      if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 200, rpcErr(body?.id ?? null, -32004, 'Server busy; retry shortly.'));
      inFlight++;
      try { await handleRpc(body, res); }
      catch (e) { log('rpc error', e); if (!res.headersSent) sendJson(res, 200, rpcErr(body?.id ?? null, -32603, `Internal error: ${e.message}`)); else res.end(); }
      finally { inFlight--; }
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
server.maxConnections = 16;

server.listen(PORT, HOST, () => {
  log(`ready · vault=${VAULT}`);
  log(TOKEN ? `auth: bearer (token file ${TOKEN_FILE} · fingerprint ${TOKEN_FINGERPRINT})` : 'auth: NONE (--no-auth) — any local process, including other OS users, can write');
  log(`agent card: http://${HOST}:${PORT}/.well-known/agent-card.json`);
  log(`A2A endpoint (JSON-RPC): http://${HOST}:${PORT}/`);
  // Bounded mode is lazy; legacy mode is the exact eager-prewarm rollback path.
  if (shouldPrewarmSemantic()) {
    getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
  } else {
    log('semantic lazy · bounded memory runtime');
  }
});
