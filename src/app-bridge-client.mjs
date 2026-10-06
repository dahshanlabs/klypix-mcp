// app-bridge-client — klypix-mcp's side of the KLYPIX app bridge (agent tool
// parity P1). An AI tool's klypix-mcp reaches the running KLYPIX desktop app
// over a per-user named pipe, and KLYPIX runs the same code as the person's
// click: its readers, keys, consents, caps, freeze and undo all apply.
//
// Protocol: app-bridge-protocol.mjs (spec in the KLYPIX repository,
// docs/architecture/agent-tool-parity-2026-09-30/BRIDGE-PROTOCOL.md).
//
// WHAT THIS CLIENT DOES ON EVERY CALL THAT NEEDS THE APP (and never before:
// it touches nothing at MCP server startup — Codex gives a server 10 s to start)
//   1. Re-read %APPDATA%\klypix\agent-bridge\endpoint.json (KLYPIX_APP_BRIDGE_DIR
//      overrides). Missing, unreadable or its pid dead → APP_NOT_RUNNING.
//   2. Its protocol differs → APP_UPDATE_REQUIRED.
//   3. access "off" (then the app has no pipe at all) → ACCESS_OFF. Nothing is
//      attempted.
//   4. Read the token file (64 lowercase hex, rotated at every app start) from
//      the machine-local profile (%LOCALAPPDATA%, see tokenDir). Missing or
//      malformed → ACCESS_OFF.
//   5. Connect to the pipe endpoint.json names, run the mutual-proof handshake,
//      and VERIFY THE APP'S PROOF BEFORE ANY TOOL ARGUMENT LEAVES THIS PROCESS.
//      A peer that cannot prove it holds the token is not KLYPIX: it gets nothing.
//   6. On AUTH_FAILED or a connection that drops before the call was sent
//      (KLYPIX restarted and rotated its token or pipe), re-read both files once,
//      reconnect once, retry once. A read is re-sent after a drop; a write
//      (add_to_canvas) and show_in_klypix never are, so nothing lands twice.
//
// DEADLINES. Every call answers within 45 s (MCP SDK clients and Codex abort a
// tool call at 60 s, and progress does not reset that). A read still running
// at the deadline comes back as `still_reading` with `retry_after_seconds`; the
// read keeps going in KLYPIX and a repeat call with the same arguments attaches
// to it (the app keys reads by tool, canvas, sorted card ids and refresh). The
// host's cancel (the MCP request's AbortSignal) becomes a bridge `cancel`.
//
// SECRETS. The token, the pipe name, endpoint.json's contents and frame bodies
// are never logged and never returned: the pipe rides on a non-enumerable
// property, the token never leaves this module, and `onEvent` (diagnostics)
// receives coarse event names only.
//
// One connection per call: the handshake costs a few milliseconds locally, and
// a fresh connection is what makes "re-read endpoint.json on every call" true.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bridgeDir, pidAlive } from './app-lease.mjs';
import {
  BRIDGE_PROTOCOL, CALL_DEADLINE_MS, HANDSHAKE_TIMEOUT_MS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, NONCE_HEX,
  RETRY_AFTER_SECONDS, RPC_ERRORS, TOKEN_HEX, FrameDecoder, clientKeyFromName, clientLabelFor, encodeFrame,
  isAllowedPipePath, isResponse, newNonce, proofC, proofS, proofsMatch, rpcRequest, sentenceFor,
} from './app-bridge-protocol.mjs';

export * from './app-bridge-protocol.mjs';

export const ENDPOINT_FILE = 'endpoint.json';
export const TOKEN_FILE = 'token';

/** Reads only: these may be re-sent after a connection dropped mid-call. */
const RESEND_SAFE = new Set(['status', 'read_canvas', 'read_card_contents', 'lens', 'ping']);
/** The app's per-read wait is kept under the client's deadline by this much. */
const WAIT_MARGIN_S = 5;
/** After a host cancel, how long to wait for the app's cancel answer. */
const CANCEL_GRACE_MS = 1000;

const MAX_NAME = 128;
const MAX_VERSION = 32;

/**
 * Where KLYPIX keeps the token: %LOCALAPPDATA%\klypix\agent-bridge — the
 * machine-local profile, never the roaming one (a roaming profile is copied to
 * a server at sign-out), so it is NOT beside endpoint.json (%APPDATA%). The
 * KLYPIX_APP_BRIDGE_DIR override (tests, dev builds) moves both files into
 * that one folder.
 */
export function tokenDir(env = process.env) {
  if (env.KLYPIX_APP_BRIDGE_DIR) return path.resolve(env.KLYPIX_APP_BRIDGE_DIR);
  const local = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'klypix', 'agent-bridge');
}

/** The token KLYPIX wrote at its last bridge start, or null. Never logged. */
export function readBridgeToken(dir = tokenDir()) {
  try {
    const t = fs.readFileSync(path.join(dir, TOKEN_FILE), 'ascii').trim();
    return TOKEN_HEX.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * What endpoint.json says right now. Never throws and never connects.
 *   → { state, appVersion, access, protocol }
 *   state: 'not_running' | 'update_required' | 'access_off' | 'unverified' | 'ready'
 * The pipe rides as a NON-enumerable property (`target.pipe`), so serializing
 * or logging this object can never carry it.
 */
export function discoverApp({ platform = process.platform } = {}) {
  const base = (state, extra = {}) => ({ state, appVersion: null, access: 'unknown', protocol: null, ...extra });
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(bridgeDir(), ENDPOINT_FILE), 'utf8')); }
  catch { return base('not_running'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base('not_running');
  if (!pidAlive(raw.pid)) return base('not_running');
  const appVersion = typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 40) : null;
  const protocol = typeof raw.protocol === 'string' ? raw.protocol.slice(0, 64) : null;
  if (protocol !== BRIDGE_PROTOCOL) return base('update_required', { appVersion, protocol });
  // A KLYPIX that writes the lease but has no bridge (no "bridge" feature)
  // needs an update; telling its user to turn on a switch it lacks would mislead.
  if (!Array.isArray(raw.features) || !raw.features.includes('bridge')) return base('update_required', { appVersion, protocol });
  const access = raw.access === 'on' ? 'on' : 'off';
  if (access !== 'on' || typeof raw.pipe !== 'string' || !raw.pipe) return base('access_off', { appVersion, protocol, access: 'off' });
  if (!isAllowedPipePath(raw.pipe, platform)) return base('unverified', { appVersion, protocol, access });
  const target = base('ready', { appVersion, protocol, access });
  Object.defineProperty(target, 'pipe', { value: raw.pipe, enumerable: false });
  return target;
}

const DISCOVERY_CODES = { not_running: 'APP_NOT_RUNNING', update_required: 'APP_UPDATE_REQUIRED', access_off: 'ACCESS_OFF', unverified: 'APP_UNVERIFIED' };

// One connection, one call. Resolves to { kind, … }; never rejects.
function attempt({ pipe, token, key, label, name, version, method, params, deadline, signal, cancelRequestId = null }) {
  return new Promise((resolve) => {
    const CALL_ID = 10;
    const CANCEL_ID = 11;
    const CANCEL_JOB_ID = 12;
    const cancelAnswers = new Set();
    let settled = false;
    let stage = 'connect';
    let sent = false;
    let timer = null;
    let socket = null;
    const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
    const nonceC = newNonce();
    let nonceS = '';
    const remaining = () => deadline - Date.now();
    const arm = (ms, onFire) => { if (timer) clearTimeout(timer); timer = setTimeout(onFire, Math.max(0, ms)); };
    const onAbort = () => {
      if (settled) return;
      if (stage === 'call' && sent) {
        stage = 'cancelling';
        try { socket.write(encodeFrame(rpcRequest(CANCEL_ID, 'cancel', { id: CALL_ID }))); } catch { /* closing anyway */ }
        // A repeat of a read that already answered still_reading is attached to
        // that read: stop the read itself too, by its request_id (Revision 2b;
        // only the tool that started it may).
        if (cancelRequestId) {
          try { socket.write(encodeFrame(rpcRequest(CANCEL_JOB_ID, 'cancel', { request_id: cancelRequestId }))); } catch { /* closing anyway */ }
        }
        arm(Math.min(CANCEL_GRACE_MS, Math.max(0, remaining())), () => finish({ kind: 'cancelled', sent }));
      } else {
        finish({ kind: 'cancelled', sent });
      }
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { socket?.destroy(); } catch { /* gone */ }
      resolve(r);
    };
    if (signal?.aborted) { finish({ kind: 'cancelled', sent: false }); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const write = (msg) => socket.write(encodeFrame(msg, MAX_REQUEST_BYTES));
    // Connect + handshake within the app's own handshake window.
    arm(Math.min(HANDSHAKE_TIMEOUT_MS, remaining()), () => finish({ kind: stage === 'connect' ? 'connect_failed' : 'handshake_timeout', sent }));
    try { socket = net.connect(pipe); } catch { finish({ kind: 'connect_failed', sent: false }); return; }
    socket.once('connect', () => {
      if (settled) return;
      stage = 'hello';
      try {
        write(rpcRequest(1, 'hello', {
          protocol: BRIDGE_PROTOCOL, clientKey: key, clientLabel: label,
          clientName: name.slice(0, MAX_NAME), clientVersion: version.slice(0, MAX_VERSION), nonceC,
        }));
      } catch { finish({ kind: 'closed_before_send', sent: false }); }
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      let msgs;
      try { msgs = decoder.push(chunk); }
      catch { finish({ kind: sent ? 'closed_after_send' : 'bad_frame', sent }); return; }
      for (const m of msgs) {
        if (settled) return;
        if (!isResponse(m)) { finish({ kind: sent ? 'closed_after_send' : 'bad_frame', sent }); return; }
        if (stage === 'hello') {
          if (m.id !== 1) { finish({ kind: 'bad_frame', sent }); return; }
          if (m.error) {
            const code = m.error.code;
            finish({ kind: code === RPC_ERRORS.PROTOCOL_MISMATCH ? 'protocol_mismatch' : code === RPC_ERRORS.TOO_MANY_CONNECTIONS ? 'too_many' : 'refused', sent });
            return;
          }
          const r = m.result || {};
          if (r.type !== 'challenge' || typeof r.nonceS !== 'string' || !NONCE_HEX.test(r.nonceS) || (r.protocol !== undefined && r.protocol !== BRIDGE_PROTOCOL)) {
            finish({ kind: 'unverified', sent });
            return;
          }
          nonceS = r.nonceS;
          stage = 'auth';
          try { write(rpcRequest(2, 'auth', { proofC: proofC(token, nonceS, nonceC, key) })); }
          catch { finish({ kind: 'closed_before_send', sent }); }
        } else if (stage === 'auth') {
          if (m.id !== 2) { finish({ kind: 'bad_frame', sent }); return; }
          if (m.error) { finish({ kind: m.error.code === RPC_ERRORS.AUTH_FAILED ? 'auth_failed' : 'refused', sent }); return; }
          const r = m.result || {};
          // The one check that matters: a peer that cannot prove it holds the
          // token is a squatter, and it gets no tool arguments.
          if (r.type !== 'ok' || !proofsMatch(proofS(token, nonceC, nonceS, key), r.proofS)) { finish({ kind: 'unverified', sent }); return; }
          stage = 'call';
          let frame;
          try { frame = encodeFrame(rpcRequest(CALL_ID, method, params), MAX_REQUEST_BYTES); }
          catch { finish({ kind: 'too_large', sent }); return; }
          socket.write(frame);
          sent = true;
          arm(remaining(), () => finish({ kind: 'deadline', sent: true }));
        } else if (stage === 'call' || stage === 'cancelling') {
          if (m.id === CALL_ID) {
            if (stage === 'cancelling') { finish({ kind: 'cancelled', sent: true }); return; }
            if (m.error) { finish({ kind: m.error.code === RPC_ERRORS.TOO_MANY_CALLS ? 'too_many' : 'call_error', sent: true }); return; }
            finish({ kind: 'result', sent: true, result: m.result });
            return;
          }
          if (stage === 'cancelling' && (m.id === CANCEL_ID || m.id === CANCEL_JOB_ID)) {
            cancelAnswers.add(m.id);
            // Wait for both cancels when both were sent (the job cancel is the
            // one that stops an attached read).
            if (!cancelRequestId || cancelAnswers.size >= 2) { finish({ kind: 'cancelled', sent: true }); return; }
          }
        }
      }
    });
    socket.on('error', () => finish({ kind: stage === 'connect' ? 'connect_failed' : sent ? 'closed_after_send' : 'closed_before_send', sent }));
    socket.on('close', () => finish({ kind: stage === 'connect' ? 'connect_failed' : sent ? 'closed_after_send' : 'closed_before_send', sent }));
  });
}

// Reads KLYPIX is still running for this process, by the same key the app
// attaches on: tool, canvas, sorted card ids, refresh. The canvas is the
// resolved path this client always sends, compared case-insensitively.
const READ_JOB_TTL_MS = 30 * 60_000;
const readJobs = new Map();
function readJobKey(clientKey, params) {
  const ids = [...new Set(Array.isArray(params.card_ids) ? params.card_ids.map(String) : [])].sort();
  return JSON.stringify([clientKey, String(params.canvas ?? '').replace(/\//g, '\\').toLowerCase(), ids, params.refresh === true]);
}
function sweepReadJobs(now = Date.now()) {
  for (const [k, v] of readJobs) if (now - v.at > READ_JOB_TTL_MS) readJobs.delete(k);
}

/** The app's answer as an outcome object (it always is one; guard anyway). */
function normalizeOutcome(result, tool) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, mode: 'app', code: 'FAILED', tell_user: sentenceFor('FAILED', { tool }) };
  return { ...result, ok: result.ok === true, mode: 'app' };
}

/**
 * Call one bridge method on the running KLYPIX app.
 *   options: { clientName, clientVersion, signal, deadlineMs (≤ 45 s), deadlineAt, platform, onEvent }
 *   → { reached, outcome }
 * `reached` is true when KLYPIX itself (proven by the handshake) received the
 * request; `outcome` is then its answer (or still_reading at the deadline).
 * When `reached` is false, nothing reached KLYPIX and `outcome` is this
 * client's refusal on its behalf (APP_NOT_RUNNING, ACCESS_OFF, …), so a caller
 * can fall back to file mode.
 */
export async function callApp(method, params = {}, options = {}) {
  const name = typeof options.clientName === 'string' ? options.clientName : '';
  const version = typeof options.clientVersion === 'string' ? options.clientVersion : '';
  const key = clientKeyFromName(name);
  const label = clientLabelFor(name);
  const tool = label;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const budget = Math.max(1000, Math.min(CALL_DEADLINE_MS, Number(options.deadlineMs) || CALL_DEADLINE_MS));
  const deadline = Number.isFinite(options.deadlineAt) ? Math.min(options.deadlineAt, Date.now() + CALL_DEADLINE_MS) : Date.now() + budget;
  const refuse = (code, extra = {}) => ({ reached: false, outcome: { ok: false, mode: 'app', code, tell_user: sentenceFor(code, { tool }), ...extra } });
  let sendParams = params && typeof params === 'object' ? params : {};
  if (method === 'read_card_contents') {
    // KLYPIX answers `still_reading` at its own wait, which must come before
    // this client's deadline.
    const room = Math.floor((deadline - Date.now()) / 1000) - WAIT_MARGIN_S;
    const asked = Number(sendParams.wait_seconds) || 40;
    sendParams = { ...sendParams, wait_seconds: Math.max(5, Math.min(asked, 45, room)) };
  }

  // A read that answered still_reading keeps running in KLYPIX under its
  // request_id; a repeat call attaches to it. Remember that id per read, so a
  // host cancel of the repeat stops the read itself (cancel { request_id }).
  const jobKey = method === 'read_card_contents' ? readJobKey(key, sendParams) : null;
  sweepReadJobs();
  const runningRequestId = jobKey ? readJobs.get(jobKey)?.requestId || null : null;

  let last = null;
  for (let round = 0; round < 2; round++) {
    const target = discoverApp({ platform: options.platform });
    if (target.state !== 'ready') return refuse(DISCOVERY_CODES[target.state] || 'APP_NOT_RUNNING');
    const token = readBridgeToken();
    if (!token) return refuse('ACCESS_OFF');
    if (Date.now() >= deadline) break;
    const r = await attempt({ pipe: target.pipe, token, key, label, name, version, method, params: sendParams, deadline, signal: options.signal, cancelRequestId: runningRequestId });
    last = r.kind;
    switch (r.kind) {
      case 'result': {
        const outcome = normalizeOutcome(r.result, tool);
        if (jobKey) {
          if (outcome.status === 'still_reading' && typeof outcome.request_id === 'string') readJobs.set(jobKey, { requestId: outcome.request_id, at: Date.now() });
          else readJobs.delete(jobKey);
        }
        return { reached: true, outcome };
      }
      case 'call_error':
        onEvent('call-error');
        return { reached: true, outcome: { ok: false, mode: 'app', code: 'FAILED', tell_user: sentenceFor('FAILED', { tool }) } };
      case 'deadline':
        onEvent('deadline');
        if (method === 'read_card_contents') {
          return { reached: true, outcome: { ok: true, mode: 'app', status: 'still_reading', retry_after_seconds: RETRY_AFTER_SECONDS, results: [] } };
        }
        return { reached: true, outcome: { ok: false, mode: 'app', code: 'APP_NO_ANSWER', tell_user: sentenceFor('APP_NO_ANSWER', { tool }) } };
      case 'cancelled':
        if (jobKey && r.sent) readJobs.delete(jobKey);
        return { reached: r.sent, outcome: { ok: false, mode: 'app', code: 'CANCELLED' } };
      case 'protocol_mismatch':
        return refuse('APP_UPDATE_REQUIRED');
      case 'unverified':
        onEvent('unverified');
        return refuse('APP_UNVERIFIED');
      case 'too_many':
        return refuse('RATE_LIMITED');
      case 'too_large':
        return refuse('BAD_REQUEST', { tell_user: 'That request is too large for KLYPIX (over 1 MiB). Send fewer or shorter cards.' });
      case 'closed_after_send':
        if (RESEND_SAFE.has(method) && round === 0) { onEvent('reconnect'); continue; }
        return { reached: true, outcome: { ok: false, mode: 'app', code: 'APP_NO_ANSWER', tell_user: sentenceFor('APP_NO_ANSWER', { tool }) } };
      default:
        // auth_failed · connect_failed · closed_before_send · handshake_timeout ·
        // bad_frame · refused: KLYPIX may have restarted (new token, new pipe).
        // Re-read both files and reconnect, once.
        onEvent(r.kind === 'auth_failed' ? 'auth-failed' : 'reconnect');
        continue;
    }
  }
  if (last === 'auth_failed') return refuse('AUTH_FAILED', { tell_user: 'KLYPIX did not accept this AI tool\'s connection. Quit and reopen KLYPIX, then ask me again.' });
  if (last === 'closed_after_send') return { reached: true, outcome: { ok: false, mode: 'app', code: 'APP_NO_ANSWER', tell_user: sentenceFor('APP_NO_ANSWER', { tool }) } };
  return refuse('APP_NOT_RUNNING');
}

/** The tool's identity as this client sends it (for messages and tests). */
export function clientIdentity(clientName) {
  const name = typeof clientName === 'string' ? clientName : '';
  return { key: clientKeyFromName(name), label: clientLabelFor(name) };
}
