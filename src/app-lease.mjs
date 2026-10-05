// app-lease — what klypix-mcp may know about the KLYPIX desktop app running on
// this PC, read from files the app writes, and the one canonical path rule both
// repositories hash.
//
// THE LEASE. A KLYPIX build that knows about AI tools writes
// %APPDATA%\klypix\agent-bridge\endpoint.json while it runs:
//   { v: 1, protocol: "klypix-app-bridge/1", pid, appVersion, startedAt,
//     access: "off" | "on", openFiles: [sha256(canonical path), …] }
// It holds no secret: reading it grants nothing. `openFiles` is the lease — the
// canvases KLYPIX has open right now. A canvas KLYPIX has open must not be
// rewritten by another program: its next save would replace the file, and an
// older KLYPIX drops cards it did not hold (KLYPIX keeps them from the build that
// writes this file on). A dead pid marks the file stale.
//
// THE CANONICAL PATH. resolve; realpath (native) when the file exists; '/' → '\';
// lowercase. The app's main process applies the SAME rule to every path its
// renderer reports before hashing, or a canvas opened through a junction, a
// `subst` drive or an 8.3 short name would hash differently on the two sides and
// the lease would silently miss. Pinned by test/fixtures/app-bridge-vectors.json,
// which the app mirrors byte-for-byte.
//
// This module is deliberately tiny and dependency-free (Node built-ins only):
// klypix-core, the worker's app tools and the klypix-append / klypix-write CLIs
// all import it, and none of them may pay for anything heavier.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const APP_BRIDGE_PROTOCOL = 'klypix-app-bridge/1';
// The first KLYPIX desktop build that writes endpoint.json AND keeps cards
// another program added to an open canvas. Named in the MAY_BE_OPEN sentence.
// Confirm against the desktop release that ships the lease before quoting it.
export const LEASE_SINCE_APP_VERSION = '1.3.177';

const BACKSLASH = String.fromCharCode(92);

// KLYPIX's own data folder (Electron userData). Overridable for tests and dev
// builds. When only the bridge folder is overridden, the data folder is its
// parent: the bridge folder lives inside it, so one override keeps a test fully
// away from the real %APPDATA%.
export function appDataDir() {
  if (process.env.KLYPIX_APP_DATA_DIR) return path.resolve(process.env.KLYPIX_APP_DATA_DIR);
  if (process.env.KLYPIX_APP_BRIDGE_DIR) return path.dirname(path.resolve(process.env.KLYPIX_APP_BRIDGE_DIR));
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'klypix');
}

export function bridgeDir() {
  if (process.env.KLYPIX_APP_BRIDGE_DIR) return path.resolve(process.env.KLYPIX_APP_BRIDGE_DIR);
  return path.join(appDataDir(), 'agent-bridge');
}

export const endpointPath = () => path.join(bridgeDir(), 'endpoint.json');

// The KLYPIX desktop app runs on Windows only. KLYPIX_APP_TOOLS=on makes any
// system behave like Windows here (tests on the Ubuntu CI).
export const appToolsPlatform = () => process.platform === 'win32' || process.env.KLYPIX_APP_TOOLS === 'on';

// Alive when we can signal it. EPERM = it exists but belongs to someone else:
// treated as alive, because the only thing this decides is whether to refuse a
// write, and refusing is the safe side.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Read endpoint.json. Never throws.
 *   status 'none'    — no file: KLYPIX is closed, or older than the build that writes it
 *   status 'live'    — a running KLYPIX wrote it (pid alive)
 *   status 'stale'   — the pid is gone (KLYPIX quit without cleaning up)
 *   status 'invalid' — the file exists but cannot be read as a lease
 * `endpoint` is the parsed object for 'live' and 'stale' only.
 */
export function readEndpoint() {
  let raw;
  try { raw = fs.readFileSync(endpointPath(), 'utf8'); }
  catch (error) { return { status: error?.code === 'ENOENT' ? 'none' : 'invalid', endpoint: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { status: 'invalid', endpoint: null }; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.openFiles)) return { status: 'invalid', endpoint: null };
  const endpoint = {
    v: parsed.v,
    protocol: typeof parsed.protocol === 'string' ? parsed.protocol : null,
    pid: Number(parsed.pid) || null,
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion.slice(0, 40) : null,
    startedAt: parsed.startedAt ?? null,
    access: parsed.access === 'on' ? 'on' : parsed.access === 'off' ? 'off' : 'unknown',
    openFiles: parsed.openFiles.filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase()),
  };
  return { status: pidAlive(endpoint.pid) ? 'live' : 'stale', endpoint };
}

/** The canonical path both repositories hash (see the header). */
export function canonicalCanvasPath(p) {
  const input = String(p || '');
  // A Windows path is resolved with Windows rules on every system, so the
  // shared vector (a C:/… path) gives the same answer on the Ubuntu CI.
  const windowsShaped = /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith(BACKSLASH + BACKSLASH);
  let resolved = (process.platform === 'win32' || windowsShaped) ? path.win32.resolve(input) : path.resolve(input);
  try {
    if (fs.existsSync(resolved)) resolved = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch { /* keep the resolved path */ }
  return resolved.split('/').join(BACKSLASH).toLowerCase();
}

export const pathHash = (p) => crypto.createHash('sha256').update(canonicalCanvasPath(p), 'utf8').digest('hex');

/** Is this canvas open in a running KLYPIX right now? */
export function isOpenInApp(p, lease = readEndpoint()) {
  if (lease.status !== 'live' || !lease.endpoint) return false;
  return lease.endpoint.openFiles.includes(pathHash(p));
}

/**
 * What a file writer must do before it rewrites `file` (a canvas that is not a
 * project brain — brains merge and are never refused).
 *   'refuse' — KLYPIX has it open: write nothing (OPEN_IN_APP)
 *   'warn'   — KLYPIX on this PC cannot say (no lease file): write, and tell the
 *              person to close and reopen its tab if it is open (MAY_BE_OPEN)
 *   'write'  — safe: KLYPIX is closed (stale lease), or it does not have this file open
 */
export function leaseVerdict(file, lease = readEndpoint()) {
  if (isOpenInApp(file, lease)) return { action: 'refuse', code: 'OPEN_IN_APP', lease };
  if ((lease.status === 'none' || lease.status === 'invalid') && appToolsPlatform()) return { action: 'warn', code: 'MAY_BE_OPEN', lease };
  return { action: 'write', code: null, lease };
}

// The cross-process write lock for a canvas that is NOT a project brain. Brains
// keep `<folder>/.claude/brain-capture.lock` (shared with the hooks and the
// app); an ordinary canvas usually sits on the Desktop or in Documents, where
// creating a `.claude` folder beside it would be visible clutter. So ordinary
// canvases lock in the profile, keyed by the same canonical-path hash as the
// lease: one identity for "this canvas" everywhere.
export function canvasWriteLockPath(file, home = os.homedir()) {
  return path.join(home, '.claude', 'project-brain', 'locks', `${pathHash(file)}.lock`);
}

// Where KLYPIX keeps a space made on the iPhone once it is opened on this PC.
// list_canvases skips AppData, so klypix_status looks here by name.
export const sharedCanvasesDir = () => path.join(appDataDir(), 'shared-canvases');

/**
 * The canvas folder KLYPIX's Settings chose (Settings → Project → Project files
 * folder), which the app also passes as --vault when it connects an AI tool.
 * Unset → the app uses the Desktop.
 */
export function appVaultSetting() {
  let chosen = '';
  try {
    const v = JSON.parse(fs.readFileSync(path.join(appDataDir(), 'vault-settings.json'), 'utf8'))?.vaultPath;
    if (typeof v === 'string') chosen = v.trim();
  } catch { /* no settings file: the app falls back to the Desktop */ }
  if (chosen) return { path: chosen, source: 'settings' };
  return { path: path.join(os.homedir(), 'Desktop'), source: 'default-desktop' };
}

// ── What KLYPIX says to the person ───────────────────────────────────────────
// Only KLYPIX speaks in tell_user: every sentence comes from this table, never
// from card, page, reel or file text. app-tools.mjs re-exports it; it lives here
// so the small CLIs can use it without loading the engine.
export const TELL_USER = {
  // P0 wording: the second clause of the plan's sentence ("or allow {tool} in
  // KLYPIX") names a switch that only exists once the app bridge ships, so it is
  // added back with it rather than sending a person looking for it today.
  OPEN_IN_APP: "'{canvas}' is open in KLYPIX. Close its tab, then ask me again. Otherwise KLYPIX's next save would drop my changes.",
  MAY_BE_OPEN: "If '{canvas}' is open in KLYPIX, close its tab and open it again now: KLYPIX versions before {version} drop cards another program adds to an open canvas.",
  NOT_FOUND: "I can't find that canvas. Tell me its name as KLYPIX shows it, or its file path.",
  SCOPE_LOCKED: 'Those cards are inside a box you locked from AI tools in KLYPIX.',
  FROZEN: 'Some cards are frozen in KLYPIX, so I left them as they are.',
  NOT_READ: 'Select the card in KLYPIX and press Enter (Read contents). After the canvas saves, ask me again.',
  APP_NOT_RUNNING: 'This needs the KLYPIX app open on this PC. Open KLYPIX, then ask me again.',
  UNSUPPORTED_PLATFORM: 'The KLYPIX app runs on Windows only; I can still work with saved canvases.',
  // Type-aware variants of NOT_READ: Read contents (Enter) works on link cards
  // only, so a photo, a video or a file card needs a different human step.
  NOT_READ_IMAGE: 'Right-click the photo in KLYPIX and choose Extract text (OCR). After the canvas saves, ask me again.',
  NOT_READ_MEDIA: "Open the canvas in KLYPIX and ask KLYPIX's AI about that card; KLYPIX saves what it reads on the card. After the canvas saves, ask me again.",
  NOT_READ_DOCUMENT: "KLYPIX does not save the text of a document card yet, so I can't read it from the saved canvas. Open it in KLYPIX if you need its text.",
};

export function tellUser(code, vars = {}) {
  const template = TELL_USER[code];
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => (vars[key] != null ? String(vars[key]) : match));
}
