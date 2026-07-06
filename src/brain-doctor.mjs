// brain-doctor — the brain reads its OWN state and reports it as ONE fact.
// ============================================================================
// The audited gap: klypix had a dozen stamps and footers but no single surface that
// answers "is THIS brain current, are my hooks wired, is the harness projection in
// sync, and who else is live?". Liveness ("a process is up") was conflated with
// readiness ("fully wired + consistent"). This is that surface — a pure, read-only
// inspection over seams that already exist:
//
//   • VERSION   — the BAKED brain-core version (PKG_VERSION in the installed
//                 klypix-mcp-server.mjs) is the source of truth, because the install
//                 stamp's version key is channel-dependent (npm writes `brainVersion`,
//                 the desktop app writes `appVersion`). + the deploy `dirty` flag.
//   • HOOKS     — are all 4 Claude Code hooks actually wired (HOOK_MARK present)?
//                 SessionStart firing proves liveness; the other 3 prove readiness.
//   • TOOLS     — the discoverable MCP verb manifest (what the installed server
//                 REALLY registers) so a caller can't assume a phantom tool.
//   • PEERS     — live sessions on this project's brain (the alignment seam), so
//                 "who else is editing right now?" is answerable, not just footer-passive.
//   • HARNESS   — per-file projection drift (ok/stale/hand-edited/missing) via the
//                 versioned fence in agent-rules.
//
// Pure node builtins + agent-rules (both in the published package). Never throws on a
// missing seam — an absent file is a fact to report, not an error.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { auditProject, resolveVersion } from './agent-rules.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
// Same normalization the hook uses to key the sessions lane: forward slashes + a
// lowercased drive letter, so the CLI computes the SAME sessions filename the hook wrote.
const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

const HOOK_MARK = 'global-brain-hook';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'];
const SESSION_FRESH_MS = 10 * 60 * 1000;   // matches the hook's lane-freshness window

// ── VERSION layer ────────────────────────────────────────────────────────────
function inspectVersion(brainDir) {
  // The baked version in the DEPLOYED server is authoritative (channel-independent).
  const serverSrc = readText(path.join(brainDir, 'klypix-mcp-server.mjs'));
  const m = serverSrc && serverSrc.match(/const PKG_VERSION = '([^']+)'/);
  const baked = m ? m[1] : null;
  const stamp = readJson(path.join(brainDir, '.brain-version.json'), null);
  // The stamp's version is `brainVersion` (npm) OR `appVersion` (desktop app) — read both.
  const stampVersion = stamp ? (stamp.brainVersion || stamp.appVersion || null) : null;
  return {
    installed: !!serverSrc || !!stamp,
    baked,                                     // real brain-core version (or null if not deployed)
    channel: stamp?.via || null,               // 'npm' | 'app' | 'dev' | null
    stampVersion,                              // provenance only (namespace varies by channel)
    dirty: !!(stamp && stamp.dirty),
    dev: !!(stamp && stamp.dev),
    sourceSha: stamp?.sourceSha || null,
    installedAt: stamp?.installedAt || stamp?.deployedAt || null,
  };
}

// ── HOOKS (readiness) layer ──────────────────────────────────────────────────
function inspectHooks(home) {
  const settings = readJson(path.join(home, '.claude', 'settings.json'), null);
  const wiredFor = (evt) => {
    const groups = settings?.hooks?.[evt];
    return Array.isArray(groups) && groups.some(g => Array.isArray(g?.hooks)
      && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
  };
  const present = !!settings;
  const wired = present ? HOOK_EVENTS.filter(wiredFor) : [];
  const missing = present ? HOOK_EVENTS.filter(e => !wired.includes(e)) : HOOK_EVENTS.slice();
  return { settingsPresent: present, wired, missing };
}

// ── TOOLS (discoverable manifest) layer ──────────────────────────────────────
function inspectTools(brainDir, pkgRoot) {
  // Prefer the DEPLOYED server (what this machine's brain actually exposes); fall back
  // to the running package's server file. Regex the registration list — no import, no
  // spawning the stdio server.
  const candidates = [path.join(brainDir, 'klypix-mcp-server.mjs'), path.join(pkgRoot, 'bin', 'klypix-mcp.mjs')];
  for (const f of candidates) {
    const src = readText(f);
    if (!src) continue;
    const names = [];
    const re = /server\.registerTool\(\s*['"]([^'"]+)['"]/g;
    let mm; while ((mm = re.exec(src))) names.push(mm[1]);
    if (names.length) return { names, count: names.length, source: f === candidates[0] ? 'deployed' : 'package', hash: sha(names.slice().sort().join(',')).slice(0, 8) };
  }
  return { names: [], count: 0, source: null, hash: null };
}

// ── RUNNING layer (behavioral truth, not a baked stamp) ──────────────────────
// The baked-file VERSION layer certifies whatever install last wrote — NOT the
// process actually answering MCP tool calls (an npx-spawned server serves its warm
// cache, which can lag the install). Servers record {pid, version, vault} into a
// per-pid REGISTRY (.running-servers.json) on boot; comparing to the baked version
// surfaces the "stamp says current, live server is stale" incident as DRIFT.
//
// Per-pid matters: MCP servers are per-session, so a single shared value is last-
// writer-wins and could report a DIFFERENT session's server (a phantom). Two modes:
//   • self (brain_doctor called AS the MCP tool, inside a server): report THAT
//     process's version — authoritative for the caller, never a phantom.
//   • CLI (separate process): enumerate every LIVE server (dead pids pruned); drift
//     if ANY live server ≠ installed, so a multi-version machine is visible, not hidden.
const RUNNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // bound a reused-PID phantom (see isAlivePid)
// Alive ONLY if we can signal it: ESRCH (dead) and EPERM (another user's process,
// never our MCP server) both count as NOT a live server of ours — narrows the
// reused-PID phantom; the age ceiling bounds the same-user-reuse remainder.
const isAlivePid = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function inspectRunning(brainDir, baked, now, self) {
  const ageMin = (b) => { const m = b ? Math.round((now - Date.parse(b)) / 60000) : null; return Number.isFinite(m) ? m : null; };
  const freshAge = (b) => { const t = Date.parse(b); return !Number.isFinite(t) || (now - t) < RUNNING_MAX_AGE_MS; };
  const fmt = (s) => ({ pid: s.pid || null, version: s.version, vault: s.vault || null, ageMin: ageMin(s.bootedAt) });
  // Live servers from the registry (prune dead pids + aged-out phantoms); fall back
  // to the legacy single-file heartbeat only if the registry is absent/empty.
  let live = [];
  const reg = readJson(path.join(brainDir, '.running-servers.json'), null);
  if (reg && Array.isArray(reg.servers)) live = reg.servers.filter(s => s && s.version && isAlivePid(s.pid) && freshAge(s.bootedAt));
  if (!live.length) {
    // Legacy single-file heartbeat (a still-running pre-registry server). Trust it
    // ONLY if its pid is alive + fresh — a dead server's leftover file must never
    // read as a live stale server (that would be the very phantom this fix prevents).
    const legacy = readJson(path.join(brainDir, '.running-version.json'), null);
    if (legacy && legacy.version && isAlivePid(legacy.pid) && freshAge(legacy.bootedAt)) live = [{ pid: legacy.pid || null, version: legacy.version, bootedAt: legacy.bootedAt || null }];
  }
  // self mode — report the CALLER's own process (definitive, phantom-proof).
  if (self && self.version) {
    return {
      known: true, self: true, version: self.version, pid: self.pid || null,
      matchesInstalled: baked ? cmpSemver(self.version, baked) === 0 : null,
      others: live.filter(s => s.pid !== self.pid).map(fmt),   // other live servers, for visibility
    };
  }
  // CLI mode — no single "mine"; report the live set.
  if (!live.length) return { known: false, self: false, version: null, matchesInstalled: null, servers: [] };
  const servers = live.map(fmt);
  const versions = [...new Set(servers.map(s => s.version))];
  return {
    known: true, self: false,
    version: versions.length === 1 ? versions[0] : versions.join(', '),
    matchesInstalled: baked ? servers.every(s => cmpSemver(s.version, baked) === 0) : null,
    servers,
  };
}

// ── PEERS (alignment) layer ──────────────────────────────────────────────────
function inspectPeers(brainDir, brainPath, now) {
  const file = path.join(brainDir, 'sessions', `${sha(normBrainPath(brainPath))}.json`);
  const data = readJson(file, null);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const live = sessions.filter(s => s && now - (s.lastSeen || 0) < SESSION_FRESH_MS)
    .map(s => ({ id: String(s.id || '').slice(0, 8), branch: s.branch || null, intent: s.intent || '', files: Array.isArray(s.files) ? s.files : [], lastSeenMin: Math.round((now - (s.lastSeen || 0)) / 60000) }));
  return { file, live, count: live.length };
}

/**
 * Inspect this machine's brain (+ a project's harness projection) as one report.
 * @param {{ projectDir?: string, home?: string, now?: number, npmLatest?: string|null }} [opts]
 */
export function inspect(opts = {}) {
  const home = opts.home || os.homedir();
  const projectDir = opts.projectDir || process.cwd();
  const now = opts.now || Date.now();
  const brainDir = path.join(home, '.claude', 'project-brain');
  const brainPath = path.join(projectDir, 'brain.klypix');
  const hasBrain = fs.existsSync(brainPath) || fs.existsSync(path.join(projectDir, 'brain.any'));

  const version = inspectVersion(brainDir);
  const running = inspectRunning(brainDir, version.baked, now, opts.self);
  const hooks = inspectHooks(home);
  const tools = inspectTools(brainDir, PKG_ROOT);
  const peers = inspectPeers(brainDir, brainPath, now);

  // Harness drift only counts toward the verdict for a real brain project; auditProject
  // against the BAKED brain version (the deployed truth) when available.
  const harnessVer = version.baked || resolveVersion();
  const harness = hasBrain ? auditProject(projectDir, { version: harnessVer }) : { files: [], drift: [], ok: true, version: harnessVer };

  // npm currency (caller fetches it; we just compare to the baked truth).
  const npm = (opts.npmLatest && !String(opts.npmLatest).startsWith('('))
    ? { latest: opts.npmLatest, matches: version.baked ? cmpSemver(opts.npmLatest, version.baked) <= 0 : null }
    : (opts.npmLatest ? { latest: opts.npmLatest, matches: null } : null);

  // ── verdict ──────────────────────────────────────────────────────────────
  const layers = {
    version: version.installed ? ((version.dirty || (npm && npm.matches === false)) ? 'drift' : 'ok') : 'absent',
    // RUNNING drifts when the live server's version ≠ the installed bundle — the
    // stale-server incident. Unknown (server not booted since the heartbeat shipped)
    // is NOT drift; it's a reconnect prompt.
    running: !running.known ? 'unknown' : (running.matchesInstalled === false ? 'drift' : 'ok'),
    hooks: !hooks.settingsPresent ? 'absent' : (hooks.missing.length ? 'drift' : 'ok'),
    harness: hasBrain ? (harness.ok ? 'ok' : 'drift') : 'n/a',
  };
  const drifted = Object.values(layers).filter(s => s === 'drift').length;
  const verdict = !version.installed ? 'NOT-INSTALLED' : (drifted ? 'DRIFTED' : 'ALIGNED');

  // ── one reconciliation block ──────────────────────────────────────────────
  const actions = [];
  if (!version.installed) actions.push('npx klypix-mcp install   # no brain installed on this machine');
  else {
    if (version.dirty) actions.push('node scripts/deploy-brain.mjs   # running uncommitted (dirty) hook code — commit + re-deploy');
    if (npm && npm.matches === false) actions.push(`npx klypix-mcp install   # installed brain v${version.baked} < npm latest v${npm.latest}`);
    if (running.matchesInstalled === false) actions.push(`/mcp reconnect (or restart the session)   # LIVE server v${running.version} ≠ installed v${version.baked} — the running MCP server is stale`);
    if (hooks.missing.length) actions.push(`npx klypix-mcp install   # half-wired: hooks not active — ${hooks.missing.join(', ')}`);
    if (hasBrain && !harness.ok) actions.push('npx klypix-mcp link      # harness configs drifted — re-project managed blocks');
  }

  return { verdict, layers, drifted, version, running, hooks, tools, peers, harness, npm, project: { dir: projectDir, brainPath, hasBrain }, brainDir, actions };
}

// One-line drift summary (empty when clean) — for a footer / status line.
export function driftLine(r) {
  if (r.verdict === 'ALIGNED') return '';
  const bits = [];
  if (!r.version.installed) return 'brain NOT installed — run `npx klypix-mcp install`';
  if (r.version.dirty) bits.push('dirty deploy');
  if (r.npm && r.npm.matches === false) bits.push(`v${r.version.baked}<${r.npm.latest}`);
  if (r.running && r.running.matchesInstalled === false) bits.push(`live server v${r.running.version}≠installed v${r.version.baked} (/mcp reconnect)`);
  if (r.hooks.missing.length) bits.push(`${r.hooks.missing.length} hook(s) unwired`);
  if (r.project.hasBrain && !r.harness.ok) bits.push(`${r.harness.drift.length} harness file(s) drifted`);
  return bits.length ? `⚠️ brain DRIFTED: ${bits.join(' · ')}` : '';
}

// ── human report ──────────────────────────────────────────────────────────────
const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', rst: '\x1b[0m', bold: '\x1b[1m' };
export function render(r, opts = {}) {
  const color = opts.color !== false;
  const c = color ? C : new Proxy({}, { get: () => '' });
  const ok = color ? '✅' : '[ok]', warn = color ? '⚠️ ' : '[!]';
  const L = [];
  const head = r.verdict === 'ALIGNED' ? `${ok} ALIGNED` : r.verdict === 'NOT-INSTALLED' ? `${warn}NOT INSTALLED` : `${warn}DRIFTED (${r.drifted} layer${r.drifted === 1 ? '' : 's'})`;
  L.push(`${c.bold}# brain_doctor${c.rst}  —  ${head}`);
  L.push('');

  // VERSION
  const vmark = r.layers.version === 'ok' ? ok : r.layers.version === 'absent' ? warn : warn;
  L.push(`${vmark} ${c.bold}VERSION${c.rst}  brain core ${c.bold}v${r.version.baked || '(not deployed)'}${c.rst}${r.version.channel ? ` ${c.dim}via ${r.version.channel}${c.rst}` : ''}${r.version.dev ? `  ${c.yel}dev${c.rst}` : ''}`);
  if (r.version.dirty) L.push(`        ${c.red}DIRTY — running uncommitted hook code (source ${String(r.version.sourceSha || '?').slice(0, 12)})${c.rst}`);
  if (r.npm) L.push(`        npm latest v${r.npm.latest}  ${r.npm.matches === false ? c.yel + '⚠ installed brain is behind' + c.rst : r.npm.matches === true ? c.grn + '✓ current' + c.rst : c.dim + '(no baked version to compare)' + c.rst}`);

  // RUNNING (behavioral truth — the live MCP server(s), not the baked file)
  if (r.running) {
    const run = r.running;
    const who = run.self ? "this session's " : (run.servers && run.servers.length > 1 ? `${run.servers.length} ` : '');
    const rm = run.matchesInstalled === false ? warn : ok;
    if (!run.known) L.push(`${ok} ${c.bold}RUNNING${c.rst}  ${c.dim}live server version unknown — no server has booted since the heartbeat shipped; /mcp reconnect to populate${c.rst}`);
    else if (run.matchesInstalled === false) L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${c.red}${who}live MCP server v${run.version} ≠ installed v${r.version.baked} — STALE; /mcp reconnect${c.rst}`);
    else L.push(`${rm} ${c.bold}RUNNING${c.rst}  ${who}live MCP server v${run.version} ✓ matches installed`);
    // Multi-session visibility: list other live servers (self mode) or the full set
    // (CLI mode when >1) so a phantom / a stale peer server is never hidden.
    const extra = run.self ? (run.others || []) : (run.servers && run.servers.length > 1 ? run.servers : []);
    for (const s of extra) L.push(`        ${c.dim}· ${run.self ? 'other' : 'server'} pid ${s.pid ?? '?'} · v${s.version}${s.vault ? ' · ' + s.vault : ''}${s.ageMin != null ? ` (booted ${s.ageMin}m ago)` : ''}${c.rst}`);
  }

  // HOOKS
  const hmark = r.layers.hooks === 'ok' ? ok : warn;
  if (!r.hooks.settingsPresent) L.push(`${hmark} ${c.bold}HOOKS${c.rst}    no ~/.claude/settings.json found`);
  else if (r.hooks.missing.length) L.push(`${hmark} ${c.bold}HOOKS${c.rst}    half-wired — missing: ${c.yel}${r.hooks.missing.join(', ')}${c.rst}  ${c.dim}(liveness up, readiness no)${c.rst}`);
  else L.push(`${hmark} ${c.bold}HOOKS${c.rst}    all 4 wired: ${r.hooks.wired.join(', ')}`);

  // TOOLS
  L.push(`${ok} ${c.bold}TOOLS${c.rst}    ${r.tools.count} MCP verb(s)${r.tools.hash ? ` ${c.dim}[#${r.tools.hash}, ${r.tools.source}]${c.rst}` : ''}${r.tools.count ? `: ${c.dim}${r.tools.names.join(', ')}${c.rst}` : ''}`);

  // PEERS
  if (!r.peers.count) L.push(`${ok} ${c.bold}PEERS${c.rst}    solo — no other live session ${c.dim}(the brain is shared, NOT live-merged)${c.rst}`);
  else {
    L.push(`${warn}${c.bold}PEERS${c.rst}    ${r.peers.count} live ${c.dim}(shared, NOT live-merged — coordinate before committing)${c.rst}`);
    for (const p of r.peers.live) L.push(`        · ${p.id}${p.branch ? ' @' + p.branch : ''}${p.intent ? ` “${p.intent.slice(0, 50)}”` : ''} ${c.dim}(${p.lastSeenMin}m ago)${c.rst}`);
  }

  // HARNESS
  if (!r.project.hasBrain) L.push(`${c.dim}· HARNESS  no ./brain.klypix in ${r.project.dir} — projection n/a${c.rst}`);
  else {
    const cmark = r.layers.harness === 'ok' ? ok : warn;
    if (r.harness.ok) L.push(`${cmark} ${c.bold}HARNESS${c.rst}  all ${r.harness.files.length} projected file(s) in sync`);
    else {
      L.push(`${cmark} ${c.bold}HARNESS${c.rst}  ${r.harness.drift.length} of ${r.harness.files.length} drifted:`);
      for (const h of r.harness.drift) L.push(`        · ${h.file} — ${c.yel}${h.status.toUpperCase()}${c.rst}${h.stampedVersion ? ` (stamped v${h.stampedVersion})` : ''}`);
    }
  }

  if (r.actions.length) {
    L.push('');
    L.push(`${c.bold}reconcile:${c.rst}`);
    for (const a of r.actions) L.push('  ' + a);
  }
  return L.join('\n');
}

// ── cross-project / cross-channel audit (--all) ─────────────────────────────────
// Superset of the legacy scripts/brain-doctor.mjs: every registered brain on this
// machine + its .mcp.json vault wiring (the SS2-class trap: a foreign absolute vault).
export function inspectAll(opts = {}) {
  const home = opts.home || os.homedir();
  const brainDir = path.join(home, '.claude', 'project-brain');
  const reg = readJson(path.join(brainDir, 'registry.json'), null);
  const brains = (Array.isArray(reg?.brains) ? reg.brains : []).filter(b => b && b.path);
  let drift = 0;
  const out = [];
  for (const b of brains) {
    const exists = fs.existsSync(b.path);
    const dir = path.dirname(b.path);
    const proj = b.project || path.basename(dir);
    let vault = '(none → defaults)', vaultOk = true;
    const cfg = readJson(path.join(dir, '.mcp.json'), null);
    if (cfg) {
      const args = cfg?.mcpServers?.['klypix-canvas']?.args || [];
      const vi = args.indexOf('--vault');
      vault = vi >= 0 ? args[vi + 1] : '(none → defaults)';
      const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
      vaultOk = vault === '.' || (vi >= 0 && norm(path.resolve(dir, vault)) === norm(dir));
      if (!vaultOk) drift++;
    }
    if (!exists) drift++;
    out.push({ project: proj, path: b.path, exists, vault, vaultOk, hasMcp: !!cfg });
  }
  return { brains: out, drift };
}
