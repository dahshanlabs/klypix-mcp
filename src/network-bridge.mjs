// KLYPIX network bridge — agents on other computers in the same project, over
// the KLYPIX network engine (dahshanlabs/klypix-network, a peer-to-peer team
// directory and message bus).
//
// The engine moves sessions and messages between computers; KLYPIX adds the
// project brain. This bridge does three things, all best-effort:
//   1. publish: tell the engine what THIS session shares with its project
//      (project key, declared intent, expected repo-relative files), via
//      `klypix-network status --klypix-json`, so teammates' KLYPIX tools see it.
//   2. read: list teammates' sessions in the SAME project (`who --json`) and map
//      them to remote presence rows, so the existing peer footer, brain_sync
//      peers and overlap warnings render them with no reader changes.
//   3. send: deliver a brain_message to a session on another computer
//      (`klypix-network send`).
//
// GOVERNING PROPERTIES (do not weaken):
//   * ADVISORY. Never blocks, never gates a write, never throws to the caller:
//     a missing engine, a stopped daemon or a slow call means no remote peers,
//     never a failed brain_sync. Every engine call has a short timeout.
//   * OPT-IN BY INSTALL. Nothing happens unless the engine is installed and
//     its daemon answers; KLYPIX_NETWORK=0 turns the bridge off entirely, and
//     plugin mode (KLYPIX_PLUGIN=1) never runs it.
//   * WHITELISTED PAYLOAD. Only the project key, the one-line intent and
//     repository-relative file keys leave this computer; the engine tidies the
//     same fields again on both ends.
//   * The `run` dependency is injectable so every rule is unit-testable
//     without the engine.
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const NETWORK_ROW_PREFIX = 'net:';
const CALL_TIMEOUT_MS = 2500;
const READ_CACHE_MS = 8_000;
const EXE = process.platform === 'win32' ? 'klypix-network.exe' : 'klypix-network';

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

export function bridgeEnabled(env = process.env) {
  // Plugin mode promises no code from outside the pinned package: no engine.
  if (String(env.KLYPIX_PLUGIN ?? '').trim() === '1') return false;
  return String(env.KLYPIX_NETWORK ?? '').trim() !== '0';
}

/** The engine binary: KLYPIX_NETWORK_BIN, then the install folder, then PATH. */
export function findNetworkBin({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.KLYPIX_NETWORK_BIN && exists(env.KLYPIX_NETWORK_BIN)) return env.KLYPIX_NETWORK_BIN;
  const installed = path.join(home, '.klypix', 'network', 'bin', EXE);
  if (exists(installed)) return installed;
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, EXE);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The project's key, the same on every computer: from the git remote when there
 * is one (host/owner/repo, case- and protocol-insensitive), else the folder name.
 */
export function projectKey({ root, readRemote = gitRemote } = {}) {
  const remote = readRemote(root);
  if (remote) {
    const canonical = String(remote).trim().toLowerCase()
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/^[^@/]+@/, '')
      .replace(/:(?!\d)/, '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (canonical) return `git:${sha16(canonical)}`;
  }
  return `dir:${sha16(path.basename(path.resolve(String(root || '.'))).toLowerCase())}`;
}

function gitRemote(root) {
  try {
    const out = spawnSync('git', ['-C', String(root), 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', timeout: 1500, windowsHide: true });
    return out.status === 0 ? out.stdout.trim() : null;
  } catch { return null; }
}

/** Repository-relative, forward slashes, nothing absolute or climbing out. */
export function wireFiles(files, root) {
  const rootKey = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    let f = String(file || '').replace(/\\/g, '/').trim();
    if (rootKey && f.toLowerCase().startsWith(rootKey + '/')) f = f.slice(rootKey.length + 1);
    f = f.replace(/^\.\//, '');
    if (!f || f.startsWith('/') || /^[a-z]:/i.test(f) || f.includes(':') || f.split('/').includes('..')) continue;
    if (!out.includes(f)) out.push(f);
    if (out.length === 50) break;
  }
  return out;
}

function defaultRun(bin, args, { timeout = CALL_TIMEOUT_MS } = {}) {
  try {
    const out = spawnSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true, env: process.env });
    return { ok: out.status === 0, stdout: out.stdout || '', stderr: out.stderr || '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error?.message || error) };
  }
}

/** Map the engine's directory to remote presence rows for this project. */
export function remoteRows(directory, key) {
  const rows = [];
  if (!directory || !Array.isArray(directory.sessions)) return rows;
  const ownMachine = `${directory.person}/${directory.machine}`;
  for (const s of directory.sessions) {
    if (!s || s.is_me) continue;
    const machine = `${s.person}/${s.machine}`;
    if (machine === ownMachine) continue;          // this computer's sessions are already local rows
    if (!s.klypix || s.klypix.project !== key) continue;
    if (s.status === 'offline') continue;
    rows.push({
      id: `${NETWORK_ROW_PREFIX}${s.address}`,
      machine: `net:${sha16(machine)}`,
      host: `${s.person} · ${s.machine}`,
      client: s.agent || 'unknown',
      surface: null,
      branch: s.branch ?? null,
      intent: String(s.klypix.intent || s.doing || '').slice(0, 160),
      files: Array.isArray(s.klypix.files) ? s.klypix.files.slice(0, 50) : [],
      address: s.address,
      via: 'network',
    });
  }
  return rows;
}

/**
 * One bridge per MCP worker. `sync()` publishes this session's project context
 * and returns teammates' rows for the same project; it never throws.
 */
export function createNetworkBridge({ env = process.env, home = os.homedir(), run = defaultRun, bin = undefined, now = () => Date.now(), readRemote } = {}) {
  let resolved = bin;
  let lastPublished = '';
  let cache = { at: 0, key: '', rows: [] };
  const engine = () => {
    if (!bridgeEnabled(env)) return null;
    if (resolved === undefined) resolved = findNetworkBin({ env, home });
    return resolved;
  };
  return {
    available: () => Boolean(engine()),
    sync({ root, intent = '', files = [] } = {}) {
      const exe = engine();
      if (!exe || !root) return { ok: false, rows: [], reason: exe ? 'no-root' : 'no-engine' };
      try {
        const key = projectKey({ root, ...(readRemote ? { readRemote } : {}) });
        const context = JSON.stringify({ project: key, intent: String(intent || '').slice(0, 160), files: wireFiles(files, root) });
        if (context !== lastPublished) {
          const published = run(exe, ['status', '--klypix-json', context]);
          if (published.ok) lastPublished = context;
        }
        const t = now();
        if (cache.key === key && t - cache.at < READ_CACHE_MS) return { ok: true, rows: cache.rows, cached: true };
        const who = run(exe, ['who', '--json']);
        if (!who.ok) return { ok: false, rows: [], reason: 'who-failed' };
        const rows = remoteRows(JSON.parse(who.stdout), key);
        cache = { at: t, key, rows };
        return { ok: true, rows };
      } catch (error) {
        return { ok: false, rows: [], reason: `error:${String(error?.message || error).slice(0, 80)}` };
      }
    },
    /** Deliver a note to a teammate's session; `address` comes from a network row. */
    send({ address, text }) {
      const exe = engine();
      if (!exe) return { ok: false, reason: 'no-engine' };
      if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(@[a-z0-9._-]+)?$/i.test(String(address || ''))) {
        return { ok: false, reason: 'bad-address' };
      }
      const body = String(text || '').trim();
      if (!body) return { ok: false, reason: 'empty' };
      const out = run(exe, ['send', String(address), body.slice(0, 8000)], { timeout: 5000 });
      return out.ok ? { ok: true } : { ok: false, reason: (out.stderr || 'send-failed').trim().slice(0, 200) };
    },
  };
}
