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

function run(cli, args, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timedOut = false;
    const child = spawn(cli.command, [...cli.prefix, ...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 8e6) stdout = stdout.slice(-8e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-2e6); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdin.on('error', () => { /* the agent may exit before reading */ });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err), durationMs: Date.now() - started, timedOut }); });
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
    const all = scenario.facts.every((f) => delivered.includes(f.id));
    (all ? scenario.oracle.good : scenario.oracle.naive)(repo);
    return { ok: true, costUsd: 0, tokens: null, turns: 0, durationMs: 0, model: null, note: all ? 'used the facts' : 'facts not delivered' };
  },
};

/** Claude Code's permission list: the edit/test tools, plus every tool of each condition server. */
export function claudeAllowedTools(mcpServers = {}) {
  return ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(node *)', 'Bash(npm test*)',
    ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}

export function parseClaudeResult(stdout) {
  let out = null;
  try { out = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop()); } catch { out = null; }
  const u = out?.usage;
  const models = out?.modelUsage ? Object.keys(out.modelUsage) : [];
  return {
    costUsd: Number.isFinite(out?.total_cost_usd) ? out.total_cost_usd : null,
    tokens: u ? Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) : null,
    turns: Number.isFinite(out?.num_turns) ? out.num_turns : null,
    model: models.join('+') || null,
    resultError: out?.is_error ? String(out.subtype || out.result || 'error').slice(0, 300) : null,
    permissionDenials: Array.isArray(out?.permission_denials) ? out.permission_denials.length : null,
  };
}

export const claude = {
  id: 'claude',
  label: 'Claude Code (headless)',
  available: () => !!resolveCli('claude'),
  async version() {
    const r = await run(resolveCli('claude'), ['--version'], { cwd: os.tmpdir(), env: cleanAgentEnv(), timeoutMs: 30_000 });
    return r.stdout.trim();
  },
  async run({ repo, prompt, mcpServers = {}, sessionId, timeoutMs, model = null, maxBudgetUsd = null }) {
    const cfg = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers }, null, 2));
    const args = ['-p', '--output-format', 'json', '--session-id', sessionId, '--no-session-persistence',
      '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', cfg,
      '--permission-mode', 'acceptEdits', '--allowedTools', claudeAllowedTools(mcpServers).join(','),
      ...(model ? ['--model', model] : []),
      ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])];
    const r = await run(resolveCli('claude'), args, { cwd: repo.dir, env: cleanAgentEnv(), timeoutMs, input: prompt });
    try { fs.rmSync(cfg, { force: true }); } catch { /* */ }
    const p = parseClaudeResult(r.stdout);
    return {
      ok: r.code === 0 && !r.timedOut && !p.resultError,
      costUsd: p.costUsd, tokens: p.tokens, turns: p.turns, model: p.model, permissionDenials: p.permissionDenials,
      raw: { stdout: r.stdout, stderr: r.stderr },
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: r.code === 0 && !p.resultError ? null : (p.resultError || r.stderr || r.stdout).slice(-600),
    };
  },
};

const tomlString = (s) => JSON.stringify(String(s));
const tomlArray = (a) => `[${a.map(tomlString).join(', ')}]`;
const tomlInline = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`;

/** The condition's MCP servers as `codex -c key=value` overrides (values are TOML). */
export function codexMcpOverrides(mcpServers = {}) {
  return Object.entries(mcpServers).flatMap(([name, s]) => [
    '-c', `mcp_servers.${name}.command=${tomlString(s.command)}`,
    '-c', `mcp_servers.${name}.args=${tomlArray(s.args || [])}`,
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

export function parseCodexEvents(stdout) {
  let tokens = null; let turns = 0; let model = null; let failure = null;
  for (const line of String(stdout).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const type = String(ev?.type || ev?.msg?.type || '');
    const usage = ev?.usage || ev?.msg?.usage || ev?.info?.total_token_usage;
    if (usage) tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) + Number(usage.cached_input_tokens || 0);
    if (/turn\.completed|task_complete/.test(type)) turns++;
    if (/turn\.failed|^error$/.test(type)) failure = String(ev?.error?.message || ev?.message || type).slice(0, 300);
    const m = ev?.model || ev?.msg?.model || ev?.session?.model;
    if (typeof m === 'string' && m) model = m;
  }
  return { tokens, turns: turns || null, model, failure };
}

export const codex = {
  id: 'codex',
  label: 'OpenAI Codex CLI (exec)',
  available: () => !!resolveCli('codex'),
  async version() {
    const r = await run(resolveCli('codex'), ['--version'], { cwd: os.tmpdir(), env: cleanAgentEnv(), timeoutMs: 30_000 });
    return r.stdout.trim();
  },
  async run({ repo, prompt, mcpServers = {}, timeoutMs, model = null }) {
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '-s', 'workspace-write', '-C', repo.dir, ...(model ? ['-m', model] : []), ...codexPlatformOverrides(), ...codexMcpOverrides(mcpServers), '-'];
    const r = await run(resolveCli('codex'), args, { cwd: repo.dir, env: cleanAgentEnv(), timeoutMs, input: prompt });
    const p = parseCodexEvents(r.stdout);
    return {
      ok: r.code === 0 && !r.timedOut && !p.failure,
      costUsd: null,   // Codex reports tokens, not dollars
      // Codex's event stream does not name the model; the row records the pinned one.
      tokens: p.tokens, turns: p.turns, model: p.model || model,
      raw: { stdout: r.stdout, stderr: r.stderr },
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: r.code === 0 && !p.failure ? null : (p.failure || r.stderr || r.stdout).slice(-600),
    };
  },
};

export const AGENTS = [oracle, claude, codex];
export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;
