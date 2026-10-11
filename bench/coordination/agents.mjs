// Agents under test, plus the scripted oracle used by --dry-run.
//
// Isolation is part of fairness: the agent must see ONLY what the condition
// gave it.
//   claude  `claude -p` with --setting-sources project (no user hooks, no user
//           MCP servers), --strict-mcp-config (only the condition's servers),
//           a fixed --session-id, JSON output for cost/turns.
//   codex   `codex exec` with --ignore-user-config --ephemeral (no user
//           config, no saved session), MCP servers passed with -c overrides,
//           --json event stream for token usage.
//   oracle  no model: applies the scenario's correct answer when every fact
//           was delivered, its naive answer otherwise. It proves graders and
//           delivery mechanically, at zero cost.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROMPT_SUFFIX = 'Work only inside this repository. When you are done, commit your change on the current branch.';

export function composePrompt(task, addendum) {
  return [task, addendum, PROMPT_SUFFIX].filter(Boolean).join('\n\n');
}

function run(cmd, args, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 8e6) stdout = stdout.slice(-8e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-2e6); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    if (input != null) { child.stdin.write(input); }
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut: Date.now() - started >= timeoutMs }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err), durationMs: Date.now() - started, timedOut: false }); });
  });
}

const which = (name) => {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, `${name}${ext}`);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* */ }
    }
  }
  return null;
};

export const oracle = {
  id: 'oracle',
  label: 'Scripted oracle (no model)',
  available: () => true,
  async version() { return 'oracle'; },
  async run({ repo, scenario, delivered }) {
    const all = scenario.facts.every((f) => delivered.includes(f.id));
    (all ? scenario.oracle.good : scenario.oracle.naive)(repo);
    return { ok: true, costUsd: 0, tokens: null, turns: 0, durationMs: 0, note: all ? 'used the facts' : 'facts not delivered' };
  },
};

export const claude = {
  id: 'claude',
  label: 'Claude Code (headless)',
  available: () => !!which('claude'),
  async version() { const r = await run(which('claude'), ['--version'], { cwd: os.tmpdir(), env: process.env, timeoutMs: 20_000 }); return r.stdout.trim(); },
  async run({ repo, prompt, mcpServers = {}, sessionId, timeoutMs }) {
    const cfg = path.join(repo.dir, '..', `${path.basename(repo.dir)}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers }, null, 2));
    const allowed = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(node *)', 'Bash(npm test*)',
      ...Object.keys(mcpServers).map((name) => `mcp__${name}__*`)];
    const args = ['-p', prompt, '--output-format', 'json', '--session-id', sessionId,
      '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', cfg,
      '--permission-mode', 'acceptEdits', '--allowedTools', ...allowed];
    const r = await run(which('claude'), args, { cwd: repo.dir, env: process.env, timeoutMs });
    try { fs.rmSync(cfg, { force: true }); } catch { /* */ }
    let out = null;
    try { out = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()); } catch { out = null; }
    return {
      ok: r.code === 0 && !r.timedOut,
      costUsd: Number.isFinite(out?.total_cost_usd) ? out.total_cost_usd : null,
      tokens: out?.usage ? (Number(out.usage.input_tokens || 0) + Number(out.usage.output_tokens || 0) + Number(out.usage.cache_read_input_tokens || 0) + Number(out.usage.cache_creation_input_tokens || 0)) : null,
      turns: Number.isFinite(out?.num_turns) ? out.num_turns : null,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: r.code === 0 ? null : (r.stderr || r.stdout).slice(-600),
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

export const codex = {
  id: 'codex',
  label: 'OpenAI Codex CLI (exec)',
  available: () => !!which('codex'),
  async version() { const r = await run(which('codex'), ['--version'], { cwd: os.tmpdir(), env: process.env, timeoutMs: 20_000 }); return r.stdout.trim(); },
  async run({ repo, prompt, mcpServers = {}, timeoutMs }) {
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '-s', 'workspace-write', '-C', repo.dir, ...codexMcpOverrides(mcpServers), prompt];
    const r = await run(which('codex'), args, { cwd: repo.dir, env: process.env, timeoutMs });
    let tokens = null; let turns = 0;
    for (const line of r.stdout.split('\n')) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const usage = ev?.usage || ev?.msg?.usage || ev?.info?.total_token_usage;
      if (usage) tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) + Number(usage.cached_input_tokens || 0);
      if (/turn\.completed|task_complete/.test(String(ev?.type || ev?.msg?.type || ''))) turns++;
    }
    return {
      ok: r.code === 0 && !r.timedOut,
      costUsd: null,   // Codex reports tokens, not dollars
      tokens,
      turns: turns || null,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      error: r.code === 0 ? null : (r.stderr || r.stdout).slice(-600),
    };
  },
};

export const AGENTS = [oracle, claude, codex];
export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;
