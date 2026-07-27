// agent-rules — make a project's brain.klypix AUTOMATIC for EVERY agent tool, not
// just Claude Code. Claude Code gets the brain via hooks (settings.json, see
// klypix-install). Other agents (Cursor, Cline, Windsurf, Copilot/VS Code, Gemini
// CLI, Aider, and the AGENTS.md cross-tool standard) have no hook system — so we
// drop their NATIVE files:
//
//   • an MCP server config  → the agent CAN reach the brain's tools
//   • a rules / instructions → the agent is TOLD to read the brain at task start and
//                              capture decisions, on every session, automatically
//
// Agent-neutral by construction: the brain DATA is one shared brain.klypix; this just
// teaches each tool to use it. Idempotent — owned files are rewritten wholesale; shared
// files (AGENTS.md, copilot-instructions.md, GEMINI.md) get a fenced block merged in
// place, never clobbering the user's own content. Pure fs/path; never throws for one bad
// target.
//
// DRIFT-AWARE (added 1.13.0): the managed fence now carries `v=<brainVersion>` +
// `hash=<contentHash>` so a projected block is CLASSIFIABLE without re-writing it —
// ok / stale (older brain) / hand-edited (content changed inside the block) / missing.
// `linkProject(dir, { check:true })` returns that audit without touching disk; it's what
// `npx klypix-mcp link --check` and `brain_doctor`'s harness layer read. Closes the
// audited "harness projection is write-once, drift is undetectable" gap.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The MCP launch entry (auto-propagation, part A) ──────────────────────────
// Reliability root-cause fix: an emitted `npx -y klypix-mcp` config runs whatever
// npx has WARM-CACHED — a publish never reaches it, so the running server silently
// lags the installed bundle (the 1.20.0 incident: doctor said current, the live
// server ran pre-1.20.0). Prefer the INSTALLED local bundle
// (~/.claude/project-brain/klypix-mcp-server.mjs): it is the SAME artifact the
// hooks + doctor use (one version, no npx cache, works offline) and the self-update
// hook keeps it current. Fall back to npx ONLY when the bundle isn't installed yet —
// first-run bootstrap; the very next link/install flips it to local.
export function localBundleServer(home = os.homedir()) {
  return path.join(home, '.claude', 'project-brain', 'klypix-mcp-server.mjs');
}

// Keep checked-in project MCP configs portable while still launching the
// installed, offline-safe bundle. `node -e` has no script pathname in argv, so
// insert a harmless placeholder before importing the server; the server can
// then keep reading its normal arguments from process.argv.slice(2).
export const LOCAL_BUNDLE_EVAL = [
  "process.argv.splice(1,0,'klypix-mcp-server.mjs');",
  "import(require('url').pathToFileURL(require('path').join(",
  "require('os').homedir(),'.claude','project-brain','klypix-mcp-server.mjs')).href)",
].join('');

export function mcpServerEntry({ vault = '.', withType = false, home } = {}) {
  let base;
  try {
    const local = localBundleServer(home);
    if (fs.statSync(local).isFile()) {
      base = { command: 'node', args: ['-e', LOCAL_BUNDLE_EVAL, '--', '--vault', vault] };
    }
  } catch { /* no local bundle yet → bootstrap via npx below */ }
  if (!base) base = { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', vault] };
  return withType ? { type: 'stdio', ...base } : base;
}

// Codex uses TOML rather than the JSON MCP shape used by the other clients.
// These helpers replace only KLYPIX-owned table sections, preserving comments,
// formatting, and every unrelated setting byte-for-byte. They intentionally do
// not serialize the whole document.
const CODEX_GLOBAL_START = '<!-- klypix-codex:start (managed by klypix-mcp) -->';
const CODEX_GLOBAL_END = '<!-- klypix-codex:end -->';
const CODEX_GLOBAL_RE = /<!-- klypix-codex:start \(managed by klypix-mcp\) -->[\s\S]*?<!-- klypix-codex:end -->\r?\n?/;
const CODEX_GLOBAL_BODY = [
  CODEX_GLOBAL_START,
  '## KLYPIX project brains',
  '',
  'When the current project contains `./brain.klypix`, treat it as the authoritative shared project memory.',
  'At task start, call `brain_sync` with the current project root in `project`, a one-sentence intent,',
  'and expected files before editing. This explicit root prevents cross-project routing in IDE hosts.',
  'It returns compact task-relevant memory plus active-task/message/file-overlap coordination.',
  'Update it when scope changes and call `brain_sync` with phase `"complete"` before the final response.',
  'Read `.claude/brain-brief.md` only when `brain_sync` says context is insufficient or the task asks',
  'for broad history/status; otherwise use `brain_ask` for deeper targeted retrieval.',
  'Capture durable decisions and milestones with `brain_note`. Never hand-edit `brain.klypix`.',
  'If the project has no `brain.klypix`, ignore this section.',
  CODEX_GLOBAL_END,
].join('\n');

const tomlKey = (value) => /^[A-Za-z0-9_-]+$/.test(String(value)) ? String(value) : JSON.stringify(String(value));
const tomlString = (value) => JSON.stringify(String(value));
const eolOf = (raw) => raw.includes('\r\n') ? '\r\n' : '\n';

function parseTomlDottedKey(source) {
  const out = [];
  let token = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    const s = token.trim();
    token = '';
    if (!s) return false;
    if (s.startsWith('"')) {
      try { out.push(JSON.parse(s)); } catch { return false; }
    } else if (s.startsWith("'")) {
      if (s.length < 2 || !s.endsWith("'")) return false;
      out.push(s.slice(1, -1));
    } else {
      if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
      out.push(s);
    }
    return true;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote === '"') {
      token += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      token += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; token += ch; continue; }
    if (ch === '.') { if (!push()) return null; continue; }
    token += ch;
  }
  if (quote || !push()) return null;
  return out;
}

function scanTomlMultiline(line, initial) {
  let state = initial;
  let i = 0;
  while (i < line.length) {
    if (state) {
      let at = line.indexOf(state, i);
      while (state === '"""' && at >= 0) {
        let slashes = 0;
        for (let j = at - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
        if (slashes % 2 === 0) break;
        at = line.indexOf(state, at + 3);
      }
      if (at < 0) return state;
      state = null;
      i = at + 3;
      continue;
    }
    const ch = line[i];
    if (ch === '#') break;
    const tri = line.slice(i, i + 3);
    if (tri === '"""' || tri === "'''") { state = tri; i += 3; continue; }
    if (ch === '"') {
      i++;
      let escaped = false;
      while (i < line.length) {
        const c = line[i++];
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      i = close < 0 ? line.length : close + 1;
      continue;
    }
    i++;
  }
  return state;
}

function scanTomlTables(raw) {
  const tables = [];
  const lines = raw.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  let offset = 0;
  let multiline = null;
  for (const fullLine of lines) {
    if (!fullLine) continue;
    const line = fullLine.replace(/(?:\r\n|\n|\r)$/, '').replace(/^\uFEFF/, '');
    if (!multiline) {
      const array = line.match(/^[ \t]*\[\[(.+)\]\][ \t]*(?:#.*)?$/);
      const table = array ? null : line.match(/^[ \t]*\[([^\[\]].*)\][ \t]*(?:#.*)?$/);
      const match = array || table;
      if (match) {
        const parts = parseTomlDottedKey(match[1].trim());
        if (!parts) return { ok: false, error: 'contains a table header KLYPIX cannot safely parse', tables: [] };
        tables.push({ start: offset, end: raw.length, parts, array: !!array });
      }
    }
    multiline = scanTomlMultiline(line, multiline);
    offset += fullLine.length;
  }
  if (multiline) return { ok: false, error: 'contains an unterminated multiline TOML string', tables: [] };
  for (let i = 0; i < tables.length - 1; i++) tables[i].end = tables[i + 1].start;
  return { ok: true, tables };
}

function parseTomlStringValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const m = value.match(/^"((?:\\.|[^"])*)"/);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
  }
  const m = value.match(/^'([^']*)'/);
  return m ? m[1] : null;
}

export function safeReadCodexConfig(configPath) {
  if (!exists(configPath)) return { ok: true, raw: '', servers: {} };
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (e) { return { ok: false, raw: '', servers: {}, error: `Can't read ${configPath}: ${e?.message || e}` }; }
  const scanned = scanTomlTables(raw);
  if (!scanned.ok) {
    return { ok: false, raw, servers: {}, error: `${path.basename(configPath)} ${scanned.error}. Fix it first - KLYPIX left it untouched.` };
  }
  const servers = {};
  for (const table of scanned.tables) {
    if (table.array || table.parts[0] !== 'mcp_servers' || table.parts.length < 2) continue;
    const name = String(table.parts[1]);
    if (servers[name]) continue; // nested .env/.tools table for an existing server
    const block = raw.slice(table.start, table.end);
    const commandLine = block.match(/^[ \t]*command[ \t]*=[ \t]*(.+)$/m);
    const command = commandLine ? parseTomlStringValue(commandLine[1]) : null;
    const cwdLine = block.match(/^[ \t]*cwd[ \t]*=[ \t]*(.+)$/m);
    const cwd = cwdLine ? parseTomlStringValue(cwdLine[1]) : null;
    const launchesKlypix = /(?:klypix-mcp-server\.mjs|(?:^|["'\s,])klypix-mcp(?:["'\s,]|$))/i.test(block)
      && !!command && /(?:^|[\\/])(node|node\.exe|npx|npx\.cmd|cmd|cmd\.exe)$/i.test(command);
    servers[name] = { command, cwd, launchesKlypix, raw: block };
  }
  return { ok: true, raw, servers, tables: scanned.tables };
}

function renderCodexMcpTable(name, entry, cwd) {
  const args = Array.isArray(entry?.args) ? entry.args.map(tomlString).join(', ') : '';
  const lines = [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(entry?.command || 'npx')}`,
    `args = [${args}]`,
  ];
  if (cwd) lines.push(`cwd = ${tomlString(cwd)}`);
  // A cold npx bootstrap can exceed Codex's 10 second default; local installs
  // start immediately, but the larger timeout is harmless and makes first use reliable.
  lines.push('startup_timeout_sec = 120');
  return lines.join('\n');
}

function writeCodexConfig(configPath, raw, next) {
  try {
    ensureDir(configPath);
    let backup;
    if (raw) {
      backup = configPath + '.klypix-bak';
      try { fs.writeFileSync(backup, raw, 'utf8'); } catch { backup = undefined; }
    }
    const tmp = configPath + '.klypix-tmp';
    fs.writeFileSync(tmp, next, 'utf8');
    const verify = safeReadCodexConfig(tmp);
    if (!verify.ok) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } return { ok: false, error: verify.error }; }
    fs.renameSync(tmp, configPath);
    return { ok: true, backup };
  } catch (e) {
    return { ok: false, error: `Couldn't write ${configPath}: ${e?.message || e}` };
  }
}

export function connectCodexMcpServer({ configPath, name = 'klypix-canvas', entry, cwd } = {}) {
  const parsed = safeReadCodexConfig(configPath);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const existingNames = Object.keys(parsed.servers).filter(k => /klypix/i.test(k));
  const chosen = existingNames[0] || name;
  const owned = (parsed.tables || []).filter(t => t.parts[0] === 'mcp_servers' && t.parts.length >= 2 && /klypix/i.test(String(t.parts[1])));
  const eol = eolOf(parsed.raw);
  const block = renderCodexMcpTable(chosen, entry, cwd).replace(/\n/g, eol);
  let next = parsed.raw;
  if (owned.length) {
    const firstStart = owned[0].start;
    for (const table of [...owned].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, table.start) + (table.start === firstStart ? block + eol + eol : '') + next.slice(table.end);
    }
  } else {
    const needsEol = next.length > 0 && !/[\r\n]$/.test(next);
    const spacer = next.trim() ? eol : '';
    next += (needsEol ? eol : '') + spacer + block + eol + eol;
  }
  if (next === parsed.raw) {
    return { ok: true, action: 'unchanged', name: chosen, path: configPath, otherServers: Object.keys(parsed.servers).filter(k => !/klypix/i.test(k)) };
  }
  const written = writeCodexConfig(configPath, parsed.raw, next);
  if (!written.ok) return written;
  return {
    ok: true,
    action: existingNames.length ? 'updated' : 'connected',
    name: chosen,
    path: configPath,
    backup: written.backup,
    otherServers: Object.keys(parsed.servers).filter(k => !/klypix/i.test(k)),
  };
}

export function disconnectCodexMcpServer({ configPath } = {}) {
  const parsed = safeReadCodexConfig(configPath);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const owned = (parsed.tables || []).filter(t => t.parts[0] === 'mcp_servers' && t.parts.length >= 2 && /klypix/i.test(String(t.parts[1])));
  if (!owned.length) return { ok: true, action: 'unchanged', path: configPath };
  let next = parsed.raw;
  for (const table of [...owned].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, table.start) + next.slice(table.end);
  }
  const written = writeCodexConfig(configPath, parsed.raw, next);
  if (!written.ok) return written;
  return {
    ok: true,
    action: 'disconnected',
    path: configPath,
    backup: written.backup,
    otherServers: Object.keys(parsed.servers).filter(k => !/klypix/i.test(k)),
  };
}

export function mergeCodexGlobalInstructions(home = os.homedir()) {
  const file = path.join(home, '.codex', 'AGENTS.md');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* fresh file */ }
  const eol = eolOf(raw);
  const block = CODEX_GLOBAL_BODY.replace(/\n/g, eol);
  const next = CODEX_GLOBAL_RE.test(raw)
    ? raw.replace(CODEX_GLOBAL_RE, block + eol)
    : (raw.trim() ? raw.replace(/\s*$/, '') + eol + eol + block + eol : block + eol);
  if (next === raw) return { ok: true, action: 'unchanged', path: file };
  try {
    ensureDir(file);
    let backup;
    if (raw) { backup = file + '.klypix-bak'; try { fs.writeFileSync(backup, raw, 'utf8'); } catch { backup = undefined; } }
    const tmp = file + '.klypix-tmp';
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, action: CODEX_GLOBAL_RE.test(raw) ? 'updated' : 'connected', path: file, backup };
  } catch (e) { return { ok: false, error: `Couldn't write ${file}: ${e?.message || e}` }; }
}

export function removeCodexGlobalInstructions(home = os.homedir()) {
  const file = path.join(home, '.codex', 'AGENTS.md');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, action: 'unchanged', path: file }; }
  if (!CODEX_GLOBAL_RE.test(raw)) return { ok: true, action: 'unchanged', path: file };
  const next = raw.replace(CODEX_GLOBAL_RE, '').replace(/^\s+|\s+$/g, (m, offset) => offset === 0 ? '' : '\n');
  try {
    const backup = file + '.klypix-bak';
    try { fs.writeFileSync(backup, raw, 'utf8'); } catch { /* best effort */ }
    const tmp = file + '.klypix-tmp';
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, action: 'disconnected', path: file, backup };
  } catch (e) { return { ok: false, error: `Couldn't write ${file}: ${e?.message || e}` }; }
}

export function codexGlobalInstructionsInstalled(home = os.homedir()) {
  try { return CODEX_GLOBAL_RE.test(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')); }
  catch { return false; }
}

const sha8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

// The klypix-mcp version this projection was written from — stamped into the fence so a
// later session can tell a stale block (older brain) from a hand-edited one. Read from
// package.json walking up from this file (the flat ~/.claude runtime has no versioned
// package.json, but `link` always runs from the npm package, where it does). Overridable
// via linkProject(dir, { version }).
export function resolveVersion() {
  let dir = HERE;
  for (; ;) {
    try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; if (v) return v; } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

// Keep the hook-generated fallback block in AGENTS.md bounded. MCP-aware agents
// get task-ranked context from brain_sync; this block exists only for agents
// that have neither MCP context nor lifecycle hooks. `link` calls this after it
// updates the managed instruction fence so existing adopters shed oversized
// query-blind briefs immediately instead of waiting for a later capture hook.
export async function compactAgentsBrief(projectDir, { check = false, budgetChars = 3200 } = {}) {
  const dir = path.resolve(projectDir || process.cwd());
  const agentsFile = path.join(dir, 'AGENTS.md');
  const brainFile = ['brain.klypix', 'brain.any']
    .map((name) => path.join(dir, name))
    .find((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
  if (!brainFile || !fs.existsSync(agentsFile)) return { status: 'skipped', action: 'skipped', reason: 'no brain/AGENTS.md' };
  const raw = fs.readFileSync(agentsFile, 'utf8');
  const start = '<!-- klypix-brain-brief:start -->';
  const end = '<!-- klypix-brain-brief:end -->';
  const re = /<!-- klypix-brain-brief:start -->[\s\S]*?<!-- klypix-brain-brief:end -->/;
  if (!re.test(raw)) return { status: 'skipped', action: 'skipped', reason: 'no generated brief block' };
  try {
    const { parseKlypix, structToUltraBrief } = await import('./klypix-format.mjs');
    const { struct } = await parseKlypix(fs.readFileSync(brainFile));
    const brief = structToUltraBrief(struct, {
      briefPath: '.claude/brain-brief.md',
      budgetChars: Math.max(1200, Math.min(5000, Number(budgetChars) || 3200)),
    }).trim();
    const block = `${start}\n<!-- compact fallback only; brain_sync supplies task-ranked context -->\n${brief}\n${end}`;
    const next = raw.replace(re, block);
    if (next === raw) return { status: 'ok', action: 'unchanged', bytes: Buffer.byteLength(block) };
    if (check) return { status: 'stale', action: 'check', bytes: Buffer.byteLength(block) };
    fs.writeFileSync(agentsFile, next, 'utf8');
    return { status: 'ok', action: 'updated', bytes: Buffer.byteLength(block) };
  } catch (error) {
    return { status: 'error', action: 'error', reason: error?.message || String(error) };
  }
}

// The one canonical instruction every agent gets. Tool-and-CLI dual so it works whether
// or not the agent has the klypix-canvas MCP wired.
const BRAIN_INSTRUCTIONS = `## KLYPIX project brain

This project has a **spatial brain** at \`./brain.klypix\` — the living memory of its
decisions, open questions, and findings (the shared human↔agent memory for this repo).
Treat it as authoritative project context, and as **the place project knowledge lives** so it
survives across sessions, agents, and context resets.

**At the start of a task — read it** so you know the project's state and past decisions:
- first call \`brain_sync\` with this project's absolute root path in \`project\`, a one-sentence task
  intent, and the files you expect to touch. The explicit root keeps each repository on its own brain
  even when an IDE launches MCP servers from the IDE installation directory.
  It returns a compact task-relevant memory capsule, meaningful active-task peers, one-time messages,
  exact file-overlap warnings, and automatic late-arrival alerts without host hooks.
  Call it again when your file scope materially changes, and with phase \`"complete"\` before your final response.
- do NOT automatically read the full \`.claude/brain-brief.md\`; open it only when \`brain_sync\`
  says its compact context is insufficient or the task asks for broad project history/status.
- with the \`klypix-canvas\` MCP server: to **answer a question** from the brain ("what did we decide about X?", "where did Y land?"), call \`brain_ask\` — it ranks the whole brain, includes superseded history, and surfaces the current truth for any corrected card. Use \`search_canvases\` for a raw keyword lookup, \`read_canvas\` (canvas: \`"brain"\`) for the whole thing, or \`brain_insights\` for the load-bearing cards.
- or via CLI: \`npx klypix-read brain.klypix\`

**When you make a real decision, finding, or milestone — capture it HERE** so it persists for the next session/agent:
- with MCP: call \`brain_note\` with a one-line decision, or
- emit a marker line in your output: \`🧠 BRAIN [Area]: <one-line decision>\`, or
- via CLI: \`echo "🧠 BRAIN [Area]: <decision>" | npx klypix-append brain.klypix\`

Capture **sparingly** — real decisions / milestones / open questions / reusable gotchas, not routine
steps — and capture it **at the moment you decide** (a one-line marker inline), not batched or left in
a scratch file to rot. Link related cards with \`[[other-card]]\`. To **correct a stale card**, include
the word \`CORRECTION\` (or "was WRONG" / "OBSOLETE" — UPPERCASE, the deliberate signal) in the
decision — capture then supersedes the stale card across ALL areas (archived with an arrow + a
receipt, restorable if wrong). Suspect stale facts survive somewhere? Run \`brain_reconcile\` — it
surfaces contradiction candidates to confirm.

**Memory routing (important).** If your host has its OWN memory/notes store, that is for *user*
preferences and how to work with this person — keep using it for that. But **project** knowledge
(decisions, milestones, open questions, gotchas) belongs in THIS brain: it is the shared, portable
memory the whole team and every agent reads, not a private scratchpad only you can see. Never let a
project decision live *only* in your host's memory or a scratch file — put it here so the next
session/agent has it.

**Working alongside other live sessions?** Send a one-time coordination note with the
\`brain_message\` MCP tool ("merged the hook refactor — rebase before you commit"). Sessions with
a KLYPIX presence adapter (Claude Code, Codex, and any MCP client) see it once through their
lifecycle adapter or on the next \`brain_sync\` / KLYPIX tool call. Use
\`brain_doctor\` for the all-host active-session count; saved/recent chats are history, not presence.
Notes are ephemeral (24h), NOT brain cards — durable decisions still go through \`brain_note\`.

**Don't** hand-edit \`brain.klypix\` (it's a packaged canvas — use the tools) or dump file contents into it; capture the *decision*, not the file.`;

// Content fingerprint of the canonical instructions — stamped into the fence so a
// hand-edit INSIDE the block (body != what its hash claims) is detectable.
const INSTRUCTIONS_HASH = sha8(BRAIN_INSTRUCTIONS);

const FENCE_END = '<!-- klypix-brain:end -->';
// Versioned + hashed start marker. The attrs are between `start` and the closing `-->`,
// so the BROAD FENCE_RE (which matches any start…end) still replaces an OLD unstamped
// block on the next `link` — the upgrade is idempotent.
const fenceStart = (ver) => `<!-- klypix-brain:start v=${ver} hash=${INSTRUCTIONS_HASH} (managed by klypix-mcp — re-run \`npx klypix-mcp link\`) -->`;
const FENCE_RE = /<!--\s*klypix-brain:start[\s\S]*?klypix-brain:end\s*-->/;
// Capturing parse: v=(group1) hash=(group2) inner-body(group3). Attrs optional so a
// legacy unstamped block parses too (version/hash come back undefined → treated as stale).
const FENCE_PARSE_RE = /<!--\s*klypix-brain:start(?:\s+v=([0-9][0-9.]*))?(?:\s+hash=([0-9a-f]+))?[\s\S]*?-->([\s\S]*?)<!--\s*klypix-brain:end\s*-->/;

const fencedBlock = (ver) => `${fenceStart(ver)}\n${BRAIN_INSTRUCTIONS}\n${FENCE_END}`;

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const ensureDir = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });

// Parse a managed block out of arbitrary file text → { version, hash, body } | null.
function parseFence(text) {
  const m = String(text || '').match(FENCE_PARSE_RE);
  if (!m) return null;
  return { version: m[1] || null, hash: m[2] || null, body: m[3] || '' };
}

// Classify a projected fenced file WITHOUT writing (the drift audit). THE single
// source of truth for both check AND write: fenceMerge/writeDedicated skip a file
// IFF this says 'ok', so classify-ok ⇔ link-unchanged can never disagree (the 1.16
// adversarial review found three ways they used to: an unrepairable hand-edited
// stamp, an invisible frontmatter strip, and a check-ok-but-link-downgrades skew).
//   missing      — file absent, or present but carries no managed block
//   hand-edited  — block body no longer matches the hash it was stamped with; or
//                   (owned dedicated files) anything OUTSIDE the fence drifted —
//                   e.g. a stripped `alwaysApply:`/`trigger:` frontmatter, which
//                   silently disables the rule in Cursor/Windsurf
//   ok           — block body is EXACTLY what we'd project today AND the stamp is
//                   consistent with it — regardless of the stamped version. CONTENT
//                   is the contract, the stamp is provenance: a version-only bump
//                   must NOT re-drift every adopter into a re-link treadmill. A
//                   self-consistent block stamped NEWER than the running brain is
//                   also 'ok' (and link leaves it alone — never downgrade).
//   stale        — block body differs from today's instructions AND was stamped from
//                   an older brain (or is a legacy unstamped block) → re-link refreshes
const STAMP_RE = /<!--\s*klypix-brain:start[\s\S]*?-->/;
function classifyFenced(file, version, frontmatter = null) {
  if (!exists(file)) return { status: 'missing' };
  const raw = fs.readFileSync(file, 'utf8');
  const fence = parseFence(raw);
  if (!fence) return { status: 'missing' };
  if (fence.hash && sha8(fence.body.trim()) !== fence.hash) return { status: 'hand-edited', stampedVersion: fence.version };
  const bodyCurrent = sha8(fence.body.trim()) === INSTRUCTIONS_HASH;
  const stampConsistent = !fence.hash || fence.hash === INSTRUCTIONS_HASH;
  if (bodyCurrent && stampConsistent) {
    // Owned dedicated files are OURS wholesale — frontmatter included. Compare the
    // whole file modulo the stamp line so a frontmatter strip/flip reads as drift.
    if (frontmatter !== null) {
      const norm = (s) => String(s).replace(STAMP_RE, '<STAMP>').replace(/\r\n/g, '\n').trim();
      const expected = (frontmatter ? frontmatter + '\n' : '') + fencedBlock(version) + '\n';
      if (norm(raw) !== norm(expected)) return { status: 'hand-edited', stampedVersion: fence.version || null, why: 'frontmatter/layout drifted' };
    }
    return { status: 'ok', stampedVersion: fence.version || null };
  }
  if (!fence.version) return { status: 'stale', stampedVersion: null };
  if (cmpSemver(fence.version, version) < 0) return { status: 'stale', stampedVersion: fence.version };
  return { status: 'ok', stampedVersion: fence.version };
}

// Shared markdown (AGENTS.md, copilot-instructions.md, GEMINI.md): merge our fenced
// block in place, preserving the user's own prose outside the fence.
function fenceMerge(file, version) {
  // Zero-touch IFF the audit says 'ok' (same classifier, so check and write can
  // never disagree): current+consistent block → byte-identical file, no stamp-only
  // churn; a hand-edited stamp or stale body falls through and gets rebuilt.
  if (classifyFenced(file, version).status === 'ok') return { action: 'unchanged' };
  let cur = '';
  let had = false;
  if (exists(file)) { cur = fs.readFileSync(file, 'utf8'); had = true; }
  const block = fencedBlock(version);
  let next;
  let action;
  if (FENCE_RE.test(cur)) { next = cur.replace(FENCE_RE, block); action = 'updated'; }
  else if (cur.trim()) { next = cur.replace(/\s*$/, '') + '\n\n' + block + '\n'; action = 'merged'; }
  else { next = block + '\n'; action = had ? 'merged' : 'created'; }
  if (next === cur) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, next, 'utf8');
  return { action };
}

// Owned dedicated rules file: rewrite wholesale (optional frontmatter for always-apply).
function writeDedicated(file, frontmatter, version) {
  // Zero-touch IFF the audit says 'ok' — which for owned dedicated files includes
  // the frontmatter (a stripped alwaysApply/trigger MUST be repaired, not skipped).
  if (classifyFenced(file, version, frontmatter || '').status === 'ok') return { action: 'unchanged' };
  const had = exists(file);
  const body = (frontmatter ? frontmatter + '\n' : '') + fencedBlock(version) + '\n';
  ensureDir(file); fs.writeFileSync(file, body, 'utf8');
  return { action: had ? 'updated' : 'created' };
}

// Project-level MCP config: add the klypix-canvas server, preserving any sibling servers.
// wrapKey differs by tool: Cursor/Claude use "mcpServers"; VS Code uses "servers".
function mergeMcpJson(file, wrapKey, withType, projectDir) {
  // Prefer the installed local bundle (no npx warm-cache staleness); npx only as a
  // first-run bootstrap. Migrating an existing npx entry → local is exactly the
  // desync fix, so a re-link (or the self-update install) heals stale configs.
  // These files are natively project-scoped and commonly committed. Keep their
  // vault portable; brain_sync's explicit `project` field is the second routing
  // guard if a host nevertheless launches from an unexpected directory.
  const entry = mcpServerEntry({ vault: '.', withType });
  let cfg = {};
  if (exists(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) { try { cfg = JSON.parse(raw); } catch { return { action: 'skipped', why: 'invalid JSON — left untouched' }; } }
  }
  if (!cfg[wrapKey] || typeof cfg[wrapKey] !== 'object' || Array.isArray(cfg[wrapKey])) cfg[wrapKey] = {};
  const before = JSON.stringify(cfg[wrapKey]['klypix-canvas']);
  cfg[wrapKey]['klypix-canvas'] = entry;
  if (JSON.stringify(cfg[wrapKey]['klypix-canvas']) === before) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { action: before === undefined ? 'created' : 'updated' };
}

// Check-only classifier for an MCP json: is the klypix-canvas server wired AND does
// its entry still actually launch klypix-mcp? Presence alone isn't enough — a hand-edit
// that mangles the command/args (so the server never starts) reads as "wired" but is
// broken. We DON'T strict-hash the entry: a customized `--vault <path>` is legitimate,
// so only the invocation (npx/node … klypix-mcp …) must survive; if it doesn't, that's
// drift the user needs to re-`link`.
function classifyMcp(file, wrapKey, projectDir) {
  if (!exists(file)) return { status: 'missing' };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); }
  catch { return { status: 'hand-edited', why: 'invalid JSON' }; }
  const entry = cfg?.[wrapKey]?.['klypix-canvas'];
  if (!entry) return { status: 'missing' };
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const launches = (entry.command === 'npx' || entry.command === 'node') && args.some(a => a.includes('klypix-mcp'));
  const vaultIndex = args.indexOf('--vault');
  const vaultArg = vaultIndex >= 0 ? args[vaultIndex + 1] : null;
  const expected = path.resolve(projectDir);
  const bound = vaultArg === '.'
    || (!!vaultArg && path.isAbsolute(vaultArg) && path.resolve(vaultArg) === expected);
  if (!launches) return { status: 'hand-edited', why: 'entry no longer launches klypix-mcp' };
  if (!bound) return { status: 'hand-edited', why: `entry points outside this project (${expected})` };
  return { status: 'ok' };
}

// The projection map — the single source of truth shared by WRITE (linkProject) and
// CHECK (auditProject), so the two can never disagree about what's projected where.
function targets(projectDir) {
  const j = (...p) => path.join(projectDir, ...p);
  return {
    rules: [
      { tool: 'Codex / AGENTS.md standard', file: j('AGENTS.md'), kind: 'merge' },
      { tool: 'Cursor', file: j('.cursor', 'rules', 'klypix-brain.mdc'), kind: 'dedicated', frontmatter: '---\ndescription: KLYPIX project brain — read at task start, capture decisions\nalwaysApply: true\n---' },
      { tool: 'Windsurf', file: j('.windsurf', 'rules', 'klypix-brain.md'), kind: 'dedicated', frontmatter: '---\ntrigger: always_on\n---' },
      { tool: 'Cline', file: j('.clinerules', 'klypix-brain.md'), kind: 'dedicated', frontmatter: '' },
      { tool: 'GitHub Copilot', file: j('.github', 'copilot-instructions.md'), kind: 'merge' },
      // Added 1.13.0 — close the "not generated at all" coverage gap the audit flagged.
      { tool: 'Gemini CLI', file: j('GEMINI.md'), kind: 'merge' },
      { tool: 'Aider', file: j('CONVENTIONS.md'), kind: 'dedicated', frontmatter: '' },
      // Added 1.29.1 — Antigravity (Gemini IDE) reads .agents/AGENTS.md; the desktop
      // app already writes it (projectBrainConnect.ts), this adds CLI audit coverage.
      // kind:'merge' so the fenced block coexists with any existing content.
      { tool: 'Antigravity', file: j('.agents', 'AGENTS.md'), kind: 'merge' },
    ],
    mcp: [
      { tool: 'Codex', file: j('.codex', 'config.toml'), format: 'toml' },
      { tool: 'Claude Code', file: j('.mcp.json'), wrapKey: 'mcpServers', withType: false },
      { tool: 'Cursor', file: j('.cursor', 'mcp.json'), wrapKey: 'mcpServers', withType: false },
      { tool: 'Cline', file: j('.cline', 'mcp.json'), wrapKey: 'mcpServers', withType: false },
      { tool: 'Gemini CLI / Antigravity', file: j('.gemini', 'settings.json'), wrapKey: 'mcpServers', withType: false },
      { tool: 'VS Code (Copilot/Continue)', file: j('.vscode', 'mcp.json'), wrapKey: 'servers', withType: true },
    ],
  };
}

const relFile = (projectDir, abs) => path.relative(projectDir, abs).replace(/\\/g, '/');

/**
 * Wire a project so EVERY agent tool reads + captures its brain automatically — or,
 * with { check:true }, AUDIT the projection without touching disk.
 * @param {string} projectDir absolute project root (holds ./brain.klypix)
 * @param {{ version?: string, check?: boolean }} [opts]
 * @returns {{ rules: Array, mcp: Array, hasBrain: boolean, version: string, check: boolean }}
 */
export function linkProject(projectDir, opts = {}) {
  const version = opts.version || resolveVersion();
  const check = !!opts.check;
  const t = targets(projectDir);
  const hasBrain = exists(path.join(projectDir, 'brain.klypix')) || exists(path.join(projectDir, 'brain.any'));

  const rules = t.rules.map((r) => {
    const file = relFile(projectDir, r.file);
    if (check) return { tool: r.tool, file, ...classifyFenced(r.file, version, r.kind === 'dedicated' ? (r.frontmatter || '') : null) };
    const res = r.kind === 'merge' ? fenceMerge(r.file, version) : writeDedicated(r.file, r.frontmatter, version);
    return { tool: r.tool, file, ...res };
  });

  const boundProject = path.resolve(projectDir).replace(/\\/g, '/');
  // Codex needs an exact machine-local path because its app/extension currently
  // ignores relative project cwd for MCP. Other hosts use their native
  // project-scoped configs plus brain_sync's explicit project fallback.
  const mcp = t.mcp.map((m) => {
    const file = relFile(projectDir, m.file);
    if (m.format === 'toml') {
      if (check) {
        const parsed = safeReadCodexConfig(m.file);
        if (!parsed.ok) return { tool: m.tool, file, status: 'hand-edited', why: parsed.error };
        const name = Object.keys(parsed.servers).find(k => /klypix/i.test(k));
        const entry = name ? parsed.servers[name] : null;
        const vaultMatch = entry?.raw?.match(/^[ \t]*args[ \t]*=[ \t]*\[[\s\S]*?["']--vault["'][ \t]*,[ \t]*["']([^"']+)["']/m);
        const configuredVault = vaultMatch?.[1] || null;
        const bound = !!configuredVault
          && path.isAbsolute(configuredVault)
          && path.resolve(configuredVault) === path.resolve(projectDir)
          && !!entry?.cwd
          && path.isAbsolute(entry.cwd)
          && path.resolve(entry.cwd) === path.resolve(projectDir);
        return {
          tool: m.tool,
          file,
          status: entry ? (entry.launchesKlypix && bound ? 'ok' : 'hand-edited') : 'missing',
          why: entry && !entry.launchesKlypix
            ? 'entry no longer launches klypix-mcp'
            : entry && !bound
              ? `Codex MCP is not explicitly bound to this project (${boundProject})`
              : undefined,
        };
      }
      const boundEntry = mcpServerEntry({ vault: boundProject });
      const res = connectCodexMcpServer({ configPath: m.file, entry: boundEntry, cwd: boundProject });
      return res.ok ? { tool: m.tool, file, ...res } : { tool: m.tool, file, action: 'skipped', why: res.error };
    }
    if (check) return { tool: m.tool, file, ...classifyMcp(m.file, m.wrapKey, projectDir) };
    return { tool: m.tool, file, ...mergeMcpJson(m.file, m.wrapKey, m.withType, projectDir) };
  });

  return { rules, mcp, hasBrain, version, check };
}

/**
 * Check-only harness audit (no writes) — the harness layer of brain_doctor / the body
 * of `npx klypix-mcp link --check`. Rolls the per-file classification into drift sets.
 * @returns {{ files, drift, unprojected, ok, version }}
 */
export function auditProject(projectDir, opts = {}) {
  const { rules, mcp, version } = linkProject(projectDir, { ...opts, check: true });
  const files = [...rules, ...mcp];
  const ACTIONABLE = new Set(['missing', 'stale', 'hand-edited']);
  const drift = files.filter((f) => ACTIONABLE.has(f.status));
  return { files, drift, ok: drift.length === 0, version };
}

export { BRAIN_INSTRUCTIONS, INSTRUCTIONS_HASH, FENCE_RE, parseFence, cmpSemver };
