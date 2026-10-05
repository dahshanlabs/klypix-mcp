// app-bridge-protocol — the wire protocol klypix-mcp speaks to the running
// KLYPIX desktop app (agent tool parity P1): `klypix-app-bridge/1`.
//
// The app side is electron/agentBridge/protocol.ts in the KLYPIX repository; its
// spec is docs/architecture/agent-tool-parity-2026-09-30/BRIDGE-PROTOCOL.md.
// Every number, proof, slug and label here is pinned by
// test/fixtures/app-bridge-vectors.json, which the app mirrors byte-for-byte
// (scripts/sync-bundled-mcp.mjs --check --strict) and checks against its own
// code, so the two sides cannot drift.
//
//   Framing   a 4-byte little-endian length, then that many bytes of UTF-8
//             JSON (one JSON-RPC 2.0 object). Client → app ≤ 1 MiB, app →
//             client ≤ 16 MiB (images ride in it).
//   Handshake mutual HMAC proof over a profile-local token the app writes at
//             every start; the token never crosses the pipe, and the client
//             checks the app's proof BEFORE it sends any tool arguments.
//   Who       clientKey = a strict slug of the raw MCP clientInfo.name (what
//             the app's block list and caps are keyed by); clientLabel = a
//             display name from a small shared map.
//
// Node built-ins only (crypto), no I/O: unit-testable, and safe for any file to
// import. The transport lives in app-bridge-client.mjs, where the pipe path is
// injectable (endpoint.json names it), so the Ubuntu CI runs the same logic over
// a Unix socket in a temp folder.
//
// NEVER log a frame body, the token or the pipe name.
import crypto from 'node:crypto';

export const BRIDGE_PROTOCOL = 'klypix-app-bridge/1';

/** A frame from the client (a request) is at most 1 MiB. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** A frame from the app (a response) is at most 16 MiB: images ride in it. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** The app closes a connection with no frame and nothing running for this long. */
export const IDLE_TIMEOUT_MS = 30_000;
/** The handshake (hello → auth) must finish this quickly, or the app closes. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Every call returns within this, whatever is still running. MCP SDK clients
 *  and Codex abort a tool call at 60 s and progress does not reset that. */
export const CALL_DEADLINE_MS = 45_000;
/** Connections one AI tool (clientKey) may hold at once, and in all. */
export const MAX_CONNECTIONS_PER_CLIENT = 8;
export const MAX_CONNECTIONS = 32;
/** How long a still-running read tells the AI tool to wait before asking again. */
export const RETRY_AFTER_SECONDS = 15;

/** What the app enforces (main's policy and caps), mirrored for messages and
 *  for klypix_status. The app is the authority; these only describe it. */
export const CAPS = Object.freeze({
  cloudPerToolPerDay: 20,
  cloudTotalPerDay: 40,
  maxCardsPerCall: 5,
  maxRunningPerTool: 3,
  showMinIntervalMs: 3000,
  maxShowCards: 50,
  maxAddCards: 50,
  maxImages: 8,
  maxImageBytes: 5 * 1024 * 1024,
  maxAnswerChars: 48_000,
});

/** The methods a client may call after the handshake. */
export const METHODS = Object.freeze(['status', 'read_canvas', 'read_card_contents', 'add_to_canvas', 'show_in_klypix', 'lens', 'cancel', 'ping']);

/** Who pays for a reading (founder decision D2, 2026-10-05). */
export const PAID_BY = Object.freeze(['none', 'ai_tool', 'own_gemini_key', 'included_ai']);

/** Where a card stands for the person right now, in a live read. */
export const VISIBILITY = Object.freeze(['shown', 'hidden_by_filter', 'inside_collapsed_box', 'off_screen']);

/** JSON-RPC error codes the transport uses. Tool outcomes (ACCESS_OFF,
 *  BLOCKED …) are RESULTS with ok:false, never these. */
export const RPC_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  AUTH_FAILED: -32001,
  PROTOCOL_MISMATCH: -32002,
  TOO_MANY_CONNECTIONS: -32003,
});

// ── What KLYPIX says to the person ───────────────────────────────────────────
// The English sentence for every code the app (or this client, on the app's
// behalf) can return. `{tool}` is the AI tool's label, `{canvas}` a canvas
// title. The first block is the app's CODE_SENTENCES (protocol.ts), verbatim;
// the second the per-card sentences its readers use (src/agentBridge/
// readers.ts RESULT_SENTENCES); the last the few only this client can say
// (the app never got the request). Only KLYPIX speaks in tell_user: no
// sentence here is ever built from card, page, reel or file text.
export const CODE_SENTENCES = Object.freeze({
  ACCESS_OFF: 'AI tools are turned off in KLYPIX (Settings → Project). Turn them on there, then ask me again.',
  BLOCKED: 'You blocked {tool} in KLYPIX. Unblock it in Settings → Project if you want me to continue.',
  APP_NOT_RUNNING: 'This needs the KLYPIX app open on this PC. Open KLYPIX, then ask me again.',
  APP_UPDATE_REQUIRED: 'KLYPIX needs an update before I can use it. Update KLYPIX, then ask me again.',
  NOT_READY: 'KLYPIX is still starting. Ask me again in a moment.',
  NEEDS_APP: 'That needs the canvas open in KLYPIX. Open it there, then ask me again.',
  NOT_FOUND: "I can't find that canvas. Tell me its name as KLYPIX shows it, or its file path.",
  SCOPE_LOCKED: 'Those cards are inside a box you locked from AI tools in KLYPIX.',
  FROZEN: 'Some cards are frozen in KLYPIX, so I left them as they are.',
  BUSY: 'You or a collaborator are editing that card, so I left it.',
  NOT_READ: 'Select the card in KLYPIX and press Enter (Read contents). After the canvas saves, ask me again.',
  NO_AI: 'To read videos and links, KLYPIX needs your Gemini key (Settings → AI) or for you to sign in for included AI.',
  QUOTA: "KLYPIX's included AI could not take this one (daily limit or size). Your own Gemini key in Settings → AI avoids that limit.",
  DAILY_CAP: "{tool} used today's 20 video readings in KLYPIX. Ask again tomorrow, or read the card in KLYPIX yourself.",
  PRIVATE_POST: 'That post is not public, so KLYPIX could only read its caption and cover picture.',
  TOO_LARGE: "That video is too large for KLYPIX's AI to watch in full, so the reading is partial.",
  RATE_LIMITED: 'KLYPIX is handling several requests from {tool} already. Ask me again in a few seconds.',
  BAD_REQUEST: 'KLYPIX could not understand that request.',
  UNKNOWN_METHOD: 'KLYPIX does not offer that to AI tools.',
  FAILED: 'KLYPIX could not finish that. Try again, or do it in KLYPIX.',
  // Per-card sentences (readers.ts RESULT_SENTENCES).
  NOT_EMBEDDED: 'That card points to a file on this PC instead of carrying it, so KLYPIX does not open it for AI tools. Drop the file onto the canvas to embed it, then ask me again.',
  CONSENT_NEEDED: 'KLYPIX could read only the caption and cover picture. To let it watch reels, read one reel yourself in KLYPIX (Read contents) once and allow the video helper.',
  UNSUPPORTED: 'KLYPIX has no reader for this kind of card.',
  // Only this client says these: the app never received the request.
  APP_UNVERIFIED: 'Something other than KLYPIX answered on KLYPIX\'s connection, so I sent it nothing. Quit and reopen KLYPIX, then ask me again.',
  APP_NO_ANSWER: 'KLYPIX stopped answering before it confirmed. Check the canvas in KLYPIX before you ask me again.',
});

/** KLYPIX's sentence for a code, with {tool} / {canvas} filled in. */
export function sentenceFor(code, vars = {}) {
  const template = CODE_SENTENCES[code];
  if (!template) return '';
  return template
    .replace(/\{tool\}/g, () => vars.tool || 'this AI tool')
    .replace(/\{canvas\}/g, () => vars.canvas || 'that canvas');
}

// ── Framing ──────────────────────────────────────────────────────────────────
export class FrameError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'FrameError';
    this.kind = kind; // 'TOO_LARGE' | 'MALFORMED' | 'HTTP'
  }
}

/** One message → one frame. Throws FrameError('TOO_LARGE') past `maxBytes`. */
export function encodeFrame(message, maxBytes = MAX_REQUEST_BYTES) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) throw new FrameError('TOO_LARGE', `frame of ${body.length} bytes exceeds ${maxBytes}`);
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Anything that starts like an HTTP request (or a TLS hello) is not a bridge
// peer. The app closes on it; so does this client.
const HTTP_STARTS = ['GET ', 'POST', 'PUT ', 'HEAD', 'DELE', 'OPTI', 'PATC', 'CONN', 'TRAC', 'HTTP', 'PRI '];

/** Splits a byte stream into decoded JSON objects. Throws FrameError on an
 *  oversized frame, a body that is not a JSON object, or an HTTP-looking
 *  start; the caller closes the connection. */
export class FrameDecoder {
  constructor(maxBytes = MAX_RESPONSE_BYTES) {
    this.maxBytes = maxBytes;
    this.buf = Buffer.alloc(0);
    this.sawFirst = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.sawFirst && this.buf.length >= 4) {
      this.sawFirst = true;
      const head = this.buf.subarray(0, 4).toString('latin1');
      if (HTTP_STARTS.includes(head) || this.buf[0] === 0x16) throw new FrameError('HTTP', 'not a bridge peer');
    }
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.maxBytes) throw new FrameError('TOO_LARGE', `frame of ${len} bytes exceeds ${this.maxBytes}`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { throw new FrameError('MALFORMED', 'frame is not JSON'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new FrameError('MALFORMED', 'frame is not a JSON object');
      out.push(msg);
    }
    return out;
  }

  /** Bytes held for an incomplete frame. */
  get pending() { return this.buf.length; }
}

// ── Handshake ────────────────────────────────────────────────────────────────
// The token is 32 random bytes stored as 64 lowercase hex characters; the HMAC
// key is the raw bytes. Nonces are 32 lowercase hex characters, fresh per
// connection. Proofs HMAC the ASCII concatenation and are lowercase hex.
//
//   C→S hello     { protocol, clientKey, clientLabel, clientName, clientVersion, nonceC }
//   S→C challenge { type:"challenge", protocol, nonceS, features }
//   C→S auth      { proofC = HMAC(token, "C" + nonceS + nonceC + clientKey) }
//   S→C ok        { type:"ok", proofS = HMAC(token, "S" + nonceC + nonceS + clientKey), access, blocked }
export const TOKEN_HEX = /^[0-9a-f]{64}$/;
export const NONCE_HEX = /^[0-9a-f]{32}$/;
export const CLIENT_KEY = /^[a-z0-9_-][a-z0-9._-]{0,31}$/;

export const newNonce = () => crypto.randomBytes(16).toString('hex');

function hmac(tokenHex, message) {
  if (!TOKEN_HEX.test(String(tokenHex || ''))) throw new Error('bad token');
  return crypto.createHmac('sha256', Buffer.from(tokenHex, 'hex')).update(message, 'ascii').digest('hex');
}

export const proofC = (tokenHex, nonceS, nonceC, clientKey) => hmac(tokenHex, `C${nonceS}${nonceC}${clientKey}`);
export const proofS = (tokenHex, nonceC, nonceS, clientKey) => hmac(tokenHex, `S${nonceC}${nonceS}${clientKey}`);

/** Constant-time comparison of two lowercase-hex proofs. */
export function proofsMatch(expected, got) {
  if (typeof got !== 'string' || !/^[0-9a-f]{64}$/.test(got) || typeof expected !== 'string' || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
}

// ── Who is calling ───────────────────────────────────────────────────────────
// Do NOT reuse mcp-presence's normalizeMcpClient here: it maps every name that
// contains "claude" to claude-code, which would give Claude Desktop and Claude
// Code one block-list entry and one daily cap.

/** The strict slug of a raw MCP clientInfo.name: lowercase; runs outside
 *  [a-z0-9._-] become '-'; at most 32 characters; no leading '.'; 'mcp' when
 *  nothing is left. It never contains a path separator. */
export function clientKeyFromName(raw) {
  let s = typeof raw === 'string' ? raw.toLowerCase() : '';
  s = s.replace(/[^a-z0-9._-]+/g, '-');
  s = s.replace(/^[.]+/, '');
  s = s.slice(0, 32);
  s = s.replace(/^[.]+/, '');
  return s || 'mcp';
}

/** Known hosts, in order; the first match wins (vectors: labelPatterns). */
export const CLIENT_LABELS = Object.freeze([
  [/codex/i, 'Codex'],
  [/claude[\s_-]*code/i, 'Claude Code'],
  [/^claude[\s_-]*ai$|claude[\s_-]*desktop/i, 'Claude Desktop'],
  [/cursor/i, 'Cursor'],
  [/cline/i, 'Cline'],
  [/windsurf/i, 'Windsurf'],
  [/antigravity/i, 'Antigravity'],
  [/^iphone$/i, 'iPhone'],
]);

const cp = (n) => String.fromCharCode(n);
// Control characters and bidi overrides never reach a label.
const UNSAFE = new RegExp(`[${cp(0x00)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x200e)}${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`, 'g');

/** The display label for a raw client name: a known host's name, else the raw
 *  name cleaned and cut to 64 characters, else 'AI tool'. */
export function clientLabelFor(raw) {
  if (typeof raw !== 'string') return 'AI tool';
  const name = raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return 'AI tool';
  for (const [re, label] of CLIENT_LABELS) if (re.test(name)) return label;
  return name.length > 64 ? `${name.slice(0, 63)}…` : name;
}

// ── Messages ─────────────────────────────────────────────────────────────────
export const rpcRequest = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

export function isResponse(msg) {
  return !!msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && Object.prototype.hasOwnProperty.call(msg, 'id')
    && (Object.prototype.hasOwnProperty.call(msg, 'result') || (msg.error && typeof msg.error === 'object'));
}

/** Where a pipe may live. On Windows only a KLYPIX bridge pipe
 *  (\\.\pipe\klypix-agent-…): endpoint.json is a per-user file, but a client
 *  that would connect to any pipe it names is a client a stray file can point
 *  at a printer spooler. Elsewhere (the CI runs this over a Unix socket) an
 *  absolute socket path. Even so, nothing is sent before the peer proves it
 *  holds the token except the hello (a nonce, the tool's key and label). */
const BS = cp(92);
const WIN_PIPE_PREFIX = `${BS}${BS}.${BS}pipe${BS}klypix-agent-`;
export function isAllowedPipePath(pipe, platform = process.platform) {
  if (typeof pipe !== 'string' || !pipe || pipe.length > 300 || pipe.includes(cp(0))) return false;
  if (platform === 'win32') {
    if (!pipe.startsWith(WIN_PIPE_PREFIX)) return false;
    return /^[A-Za-z0-9._-]{1,128}$/.test(pipe.slice(WIN_PIPE_PREFIX.length));
  }
  return pipe.startsWith('/');
}
