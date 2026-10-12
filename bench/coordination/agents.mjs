// Agents under test, plus the scripted oracle used by --dry-run.
//
// Isolation is part of fairness: the agent must see ONLY what the condition
// gave it, and a live run must leave the user's own setup untouched.
//   claude  `claude -p` with --setting-sources project (no user hooks, no user
//           MCP servers), --strict-mcp-config (only the condition's servers),
//           --no-session-persistence (nothing added to the user's session
//           history), JSON output for cost, turns and model.
//   codex   `codex exec` with --ignore-user-config --ephemeral (no user
//           config, no saved session), MCP servers passed with -c overrides,
//           --json event stream for tokens and model.
//   oracle  no model: applies the scenario's correct answer when every fact
//           was delivered, its naive answer otherwise. It proves graders and
//           delivery mechanically, at zero cost.
//
// Both CLIs are started directly — never through cmd.exe, which would mangle
// the prompt and the TOML values — and the prompt goes in on stdin.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROMPT_SUFFIX = 'Work only inside this repository. When you are done, commit your change on the current branch.';

export function composePrompt(task, addendum) {
  return [task, addendum, PROMPT_SUFFIX].filter(Boolean).join('\n\n');
}

// The agent starts as a fresh session of its own: nothing from the session
// that launched the bench (a parent Claude Code, its KLYPIX id, an Electron
// host) may leak into it.
const LEAKY_ENV = /^(?:CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PLUGIN_ROOT|ELECTRON_RUN_AS_NODE|KLYPIX_.*|CODEX_SANDBOX.*|CODEX_THREAD_ID)$/i;
export function cleanAgentEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !LEAKY_ENV.test(k)));
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* */ } } }
}

/**
 * What a chunk of the agent's own output stream says it is doing — the
 * runner's clock for "the agent acted", "the agent wrote a file" and "the
 * agent asked the channel". Claude Code (stream-json): tool_use blocks named
 * Edit/Write/…; MCP tools are named mcp__<server>__<tool>. Codex (--json):
 * item.started events typed file_change / command_execution / mcp_tool_call.
 */
export function classifyChunk(text) {
  const s = String(text);
  const tool = /"tool_use"|"item\.started"|"mcp_tool_call"|"command_execution"|"file_change"/.test(s);
  const edit = /"name":"(Edit|Write|MultiEdit|NotebookEdit)"|"type":"file_change"/.test(s);
  const mcp = /"name":"mcp__|"mcp_tool_call"/.test(s);
  return { tool, edit, mcp };
}

function run(cli, args, { cwd, env, timeoutMs, input, onEvent = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timedOut = false;
    // The agent's own timeline, from its output stream: first and last action,
    // first file write, first call to the channel. A mid-task fact is anchored
    // to the first write; a fact injected after the last action could not have
    // changed the outcome, and the run says so instead of blaming the channel.
    let lastToolAtMs = null; let firstToolAtMs = null; let firstEditAtMs = null; let firstMcpAtMs = null;
    const child = spawn(cli.command, [...cli.prefix, ...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      const at = Date.now() - started;
      const k = classifyChunk(d);
      if (k.tool) { lastToolAtMs = at; if (firstToolAtMs == null) { firstToolAtMs = at; try { onEvent?.('tool', at); } catch { /* */ } } }
      if (k.edit && firstEditAtMs == null) { firstEditAtMs = at; try { onEvent?.('edit', at); } catch { /* */ } }
      if (k.mcp && firstMcpAtMs == null) { firstMcpAtMs = at; try { onEvent?.('mcp', at); } catch { /* */ } }
      if (stdout.length > 8e6) stdout = stdout.slice(-8e6);
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-2e6); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdin.on('error', () => { /* the agent may exit before reading */ });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
    // startedAt is absolute (ms since epoch) so the runner can put the moment it
    // fired a mid-task fact on the same clock as the agent's own timeline.
    const timeline = () => ({ startedAt: started, lastToolAtMs, firstToolAtMs, firstEditAtMs, firstMcpAtMs });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut, ...timeline() }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err), durationMs: Date.now() - started, timedOut, ...timeline() }); });
  });
}

/**
 * Find a CLI and how to start it without a shell. An npm `.cmd` shim is read
 * for its real target: a native `.exe` runs directly, a `.js` entry runs on
 * this Node. Returns { command, prefix, via } or null.
 */
export function resolveCli(name, { pathEnv = process.env.PATH, platform = process.platform, readFile = (p) => fs.readFileSync(p, 'utf8'), isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
  const dirs = String(pathEnv || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    if (platform !== 'win32') {
      const p = join(dir, name);
      if (isFile(p)) return { command: p, prefix: [], via: p };
      continue;
    }
    const exe = join(dir, `${name}.exe`);
    if (isFile(exe)) return { command: exe, prefix: [], via: exe };
    const shim = join(dir, `${name}.cmd`);
    if (!isFile(shim)) continue;
    let text = '';
    try { text = readFile(shim); } catch { continue; }
    // npm's shims also name a bundled `node.exe` (the interpreter, checked
    // with IF EXIST); the program is the other quoted %dp0% path.
    const target = [...text.matchAll(/"%dp0%\\([^"%]+?\.(?:exe|js|cjs|mjs))"/gi)]
      .map((m) => join(dir, ...m[1].split('\\')))
      .find((p) => !/^node\.exe$/i.test(path.win32.basename(p)) && isFile(p));
    if (!target) continue;
    return /\.exe$/i.test(target)
      ? { command: target, prefix: [], via: shim }
      : { command: process.execPath, prefix: [target], via: shim };
  }
  return null;
}

export const oracle = {
  id: 'oracle',
  label: 'Scripted oracle (no model)',
  available: () => true,
  async version() { return 'oracle'; },
  async run({ repo, scenario, delivered }) {
    const facts = [...scenario.facts, ...(scenario.later?.facts || [])];
    const all = facts.every((f) => delivered.includes(f.id));
    (all ? scenario.oracle.good : scenario.oracle.naive)(repo);
    const note = all ? 'used the facts' : 'facts not delivered';
    return { ok: true, costUsd: 0, tokens: null, turns: 0, durationMs: 0, model: null, note, finalMessage: scenario.oracle[all ? 'goodMessage' : 'naiveMessage'] || note, lastToolAtMs: 0 };
  },
};

/**
 * Claude Code's permission list: the edit/test tools, plus every tool of each
 * condition server. On Windows Claude Code runs shell commands through its
 * PowerShell tool, so the same git/node/test rules are granted there too —
 * without them every git and node call was denied (4–5 denials per run in the
 * first pilot, 2026-10-11), an unfair handicap no other agent had.
 */
export function claudeAllowedTools(mcpServers = {}) {
  const shell = ['git *', 'node *', 'npm test*'];
  return ['Read', 'Edit', 'Write', 'Glob', 'Grep',
    ...shell.map((c) => `Bash(${c})`), ...shell.map((c) => `PowerShell(${c})`),
    ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}

const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; return bag; };

/**
 * Claude's stream-json output: every event, then a final `result` event.
 * `mcpCalls` counts the agent's MCP tool calls by tool name — whether it
 * consulted the condition's channel at all is what explains a pass or a fail.
 */
export function parseClaudeResult(stdout) {
  let out = null;
  let channelUp = null;
  const mcpCalls = {};
  for (const line of String(stdout).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'result') out = ev;
    // The init event says whether each condition server actually came up.
    if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.mcp_servers) && ev.mcp_servers.length) {
      channelUp = ev.mcp_servers.every((s) => s?.status === 'connected');
    }
    if (ev?.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block?.type === 'tool_use' && /^mcp__/.test(String(block.name || ''))) bump(mcpCalls, String(block.name).replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''));
      }
    }
  }
  const u = out?.usage;
  const models = out?.modelUsage ? Object.keys(out.modelUsage) : [];
  return {
    costUsd: Number.isFinite(out?.total_cost_usd) ? out.total_cost_usd : null,
    tokens: u ? Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) : null,
    turns: Number.isFinite(out?.num_turns) ? out.num_turns : null,
    model: models.join('+') || null,
    resultError: !out ? 'no result event' : (out.is_error ? String(out.subtype || out.result || 'error').slice(0, 300) : null),
    permissionDenials: Array.isArray(out?.permission_denials) ? out.permission_denials.length : null,
    mcpCalls,
    channelUp,
    // What the agent told its user at the end — a grader may read it (a flagged
    // conflict is not the same as an unnoticed one).
    finalMessage: typeof out?.result === 'string' ? out.result : null,
  };
}

// A run whose condition server never came up measured nothing about that
// channel. It is recorded as INVALID (kept, shown, excluded from rates) — never
// as the channel failing.
export const CHANNEL_DOWN = 'mcp-server-not-connected';

export const claude = {
  id: 'claude',
  label: 'Claude Code (headless)',
  available: () => !!resolveCli('claude'),
  async version() {
    const r = await run(resolveCli('claude'), ['--version'], { cwd: os.tmpdir(), env: cleanAgentEnv(), timeoutMs: 30_000 });
    return r.stdout.trim();
  },
  async run({ repo, prompt, mcpServers = {}, sessionId, timeoutMs, model = null, maxBudgetUsd = null, onEvent = null }) {
    const cfg = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers }, null, 2));
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--no-session-persistence',
      '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', cfg,
      '--permission-mode', 'acceptEdits', '--allowedTools', claudeAllowedTools(mcpServers).join(','),
      ...(model ? ['--model', model] : []),
      ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])];
    const env = { ...cleanAgentEnv(), MCP_TIMEOUT: String(MCP_STARTUP_TIMEOUT_SEC * 1000) };
    const r = await run(resolveCli('claude'), args, { cwd: repo.dir, env, timeoutMs, input: prompt, onEvent });
    try { fs.rmSync(cfg, { force: true }); } catch { /* */ }
    const p = parseClaudeResult(r.stdout);
    return {
      ok: r.code === 0 && !r.timedOut && !p.resultError && p.channelUp !== false,
      costUsd: p.costUsd, tokens: p.tokens, turns: p.turns, model: p.model, permissionDenials: p.permissionDenials, mcpCalls: p.mcpCalls,
      channelUp: p.channelUp, finalMessage: p.finalMessage,
      startedAt: r.startedAt, lastToolAtMs: r.lastToolAtMs, firstToolAtMs: r.firstToolAtMs, firstEditAtMs: r.firstEditAtMs, firstMcpAtMs: r.firstMcpAtMs,
      raw: { stdout: r.stdout, stderr: r.stderr },
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: p.channelUp === false ? CHANNEL_DOWN
        : (r.code === 0 && !p.resultError ? null : (p.resultError || r.stderr || r.stdout).slice(-600)),
    };
  },
};

const tomlString = (s) => JSON.stringify(String(s));
const tomlArray = (a) => `[${a.map(tomlString).join(', ')}]`;
const tomlInline = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`;

/** The condition's MCP servers as `codex -c key=value` overrides (values are TOML). */
// How long an agent waits for a condition's MCP server to start. Codex's
// default is 10 s; on a loaded machine a cold start (modules read from disk
// while the antivirus scans them) can take longer, and the agent then works
// without the channel — a run that measures nothing. KLYPIX's own Codex config
// uses the same 120 s (src/agent-rules.mjs).
export const MCP_STARTUP_TIMEOUT_SEC = 120;

export function codexMcpOverrides(mcpServers = {}) {
  return Object.entries(mcpServers).flatMap(([name, s]) => [
    '-c', `mcp_servers.${name}.command=${tomlString(s.command)}`,
    '-c', `mcp_servers.${name}.args=${tomlArray(s.args || [])}`,
    '-c', `mcp_servers.${name}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`,
    ...(s.env ? ['-c', `mcp_servers.${name}.env=${tomlInline(s.env)}`] : []),
  ]);
}

/**
 * Settings Codex needs on this OS that --ignore-user-config would otherwise
 * drop. On Windows, workspace-write only works through Codex's Windows sandbox;
 * without it every shell command is "blocked by policy" and the agent can
 * neither read with a shell nor edit (seen on the first live run, 2026-10-11).
 */
export function codexPlatformOverrides(platform = process.platform) {
  return platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [];
}

/**
 * Codex's workspace-write sandbox keeps `.git` read-only, so it could neither
 * commit nor `git merge` — S2 (build on the other branch) was impossible for
 * Codex in EVERY condition (pilot, 2026-10-11: "`.git` is read-only, so
 * `git merge a/currency` failed"). Only this run's throwaway repo's `.git` is
 * added as writable; nothing else on the machine is.
 */
export function codexGitWritable(repoDir) {
  const gitDir = path.join(repoDir, '.git').split(path.sep).join('/');
  return ['-c', `sandbox_workspace_write.writable_roots=${tomlArray([gitDir])}`];
}

/**
 * Codex does not report its MCP servers' state. A completed call to one proves
 * it was up; a start-up failure Codex logged for one proves it was not;
 * anything else is unknown (null) — never assumed up.
 */
export function codexChannelUp(serverNames = [], mcpCalls = {}, stderr = '') {
  if (!serverNames.length) return null;
  if (Object.keys(mcpCalls || {}).length) return true;
  const failed = serverNames.some((name) => {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${n}[^\\n]*(fail|timed? ?out|error)|(fail|timed? ?out)[^\\n]*${n}`, 'i').test(String(stderr));
  });
  return failed ? false : null;
}

export function parseCodexEvents(stdout) {
  let tokens = null; let turns = 0; let model = null; let failure = null; let finalMessage = null;
  const mcpCalls = {};
  for (const line of String(stdout).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const type = String(ev?.type || ev?.msg?.type || '');
    if (type === 'item.completed' && ev.item?.type === 'mcp_tool_call') bump(mcpCalls, String(ev.item.tool || 'unknown'));
    if (type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') finalMessage = ev.item.text;
    const usage = ev?.usage || ev?.msg?.usage || ev?.info?.total_token_usage;
    if (usage) tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) + Number(usage.cached_input_tokens || 0);
    if (/turn\.completed|task_complete/.test(type)) turns++;
    if (/turn\.failed|^error$/.test(type)) failure = String(ev?.error?.message || ev?.message || type).slice(0, 300);
    const m = ev?.model || ev?.msg?.model || ev?.session?.model;
    if (typeof m === 'string' && m) model = m;
  }
  return { tokens, turns: turns || null, model, failure, mcpCalls, finalMessage };
}

export const codex = {
  id: 'codex',
  label: 'OpenAI Codex CLI (exec)',
  available: () => !!resolveCli('codex'),
  async version() {
    const r = await run(resolveCli('codex'), ['--version'], { cwd: os.tmpdir(), env: cleanAgentEnv(), timeoutMs: 30_000 });
    return r.stdout.trim();
  },
  async run({ repo, prompt, mcpServers = {}, timeoutMs, model = null, onEvent = null }) {
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '-s', 'workspace-write', '-C', repo.dir, ...(model ? ['-m', model] : []), ...codexPlatformOverrides(), ...codexGitWritable(repo.dir), ...codexMcpOverrides(mcpServers), '-'];
    const r = await run(resolveCli('codex'), args, { cwd: repo.dir, env: cleanAgentEnv(), timeoutMs, input: prompt, onEvent });
    const p = parseCodexEvents(r.stdout);
    const channelUp = codexChannelUp(Object.keys(mcpServers), p.mcpCalls, r.stderr);
    return {
      ok: r.code === 0 && !r.timedOut && !p.failure && channelUp !== false,
      costUsd: null,   // Codex reports tokens, not dollars
      // Codex's event stream does not name the model; the row records the pinned one.
      tokens: p.tokens, turns: p.turns, model: p.model || model, mcpCalls: p.mcpCalls, channelUp,
      finalMessage: p.finalMessage,
      startedAt: r.startedAt, lastToolAtMs: r.lastToolAtMs, firstToolAtMs: r.firstToolAtMs, firstEditAtMs: r.firstEditAtMs, firstMcpAtMs: r.firstMcpAtMs,
      raw: { stdout: r.stdout, stderr: r.stderr },
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: channelUp === false ? CHANNEL_DOWN
        : (r.code === 0 && !p.failure ? null : (p.failure || r.stderr || r.stdout).slice(-600)),
    };
  },
};

export const AGENTS = [oracle, claude, codex];
export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;
