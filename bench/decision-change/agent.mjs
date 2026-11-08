import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { resolveCli, parseClaudeResult, claudeAllowedTools } from '../coordination/agents.mjs';
import { freshEnvironment } from './isolation.mjs';
import { preparePassiveAudit } from './passive-audit.mjs';

export const normalized = text => String(text || '').replace(/\s+/g, ' ').trim();

export function reservationUsd(limits) {
  for (const key of ['stageBudgetUsd', 'maxContextTokens', 'maxOutputTokens', 'inputWorstUsdPerMillion', 'outputUsdPerMillion']) {
    if (!Number.isFinite(limits?.[key]) || limits[key] <= 0) throw new Error(`Missing verified cost bound: ${key}`);
  }
  if (!limits.priceSource || !limits.model) throw new Error('A pinned model and official pricing source are required');
  // --max-budget-usd can finish one already-started request beyond its limit.
  // Input worst price must include the most expensive supported cache write.
  const geo = limits.geographyMultiplier ?? 1;
  if (!Number.isFinite(geo) || geo < 1) throw new Error('Invalid geography cost multiplier');
  return Math.ceil(100 * (limits.stageBudgetUsd + geo * (
    limits.maxContextTokens * limits.inputWorstUsdPerMillion / 1e6
    + limits.maxOutputTokens * limits.outputUsdPerMillion / 1e6))) / 100;
}

export function inspectClaude() {
  const cli = resolveCli('claude');
  if (!cli) return { available: false };
  const version = spawnSync(cli.command, [...cli.prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const auth = spawnSync(cli.command, [...cli.prefix, 'auth', 'status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  let status = {};
  try { status = JSON.parse(auth.stdout); } catch { /* no secrets or raw auth output in report */ }
  return { available: version.status === 0, version: String(version.stdout || '').trim(),
    loggedIn: status.loggedIn === true, authMethod: status.authMethod || null, apiProvider: status.apiProvider || null };
}

export function prepareClaudeHome(home, { credentialFile = null } = {}) {
  const config = path.join(home, '.claude');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  // Copy auth only, never the user's rules/settings/hooks/history. Contents are
  // never printed or embedded in any artifact. Caller owns and removes home.
  if (credentialFile) {
    const real = fs.realpathSync(home);
    const rel = path.relative(os.tmpdir(), real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)
      || !path.basename(path.dirname(real)).startsWith('klypix-decision-change-')) {
      throw new Error('Auth copy requires a fresh decision-change temp home');
    }
    if (process.platform === 'win32') {
      const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      if (!process.env.USERDOMAIN || !process.env.USERNAME) throw new Error('Cannot establish the owner for temporary auth ACL');
      const acl = spawnSync('icacls', [real, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'],
        { encoding: 'utf8', windowsHide: true });
      if (acl.status !== 0) throw new Error('Could not restrict the temporary authentication directory');
    } else fs.chmodSync(real, 0o700);
    fs.copyFileSync(credentialFile, path.join(config, '.credentials.json'));
    if (process.platform !== 'win32') fs.chmodSync(path.join(config, '.credentials.json'), 0o600);
    else {
      const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      const acl = spawnSync('icacls', [path.join(config, '.credentials.json'), '/inheritance:r', '/grant:r', `${account}:F`, 'SYSTEM:F'],
        { encoding: 'utf8', windowsHide: true });
      if (acl.status !== 0) throw new Error('Could not restrict the temporary authentication file');
    }
  }
  return freshEnvironment(home);
}

export function evidenceTracker(initialPolicy, { matches = text => normalized(text).includes(normalized(initialPolicy)) } = {}) {
  const calls = new Map(); const evidence = []; const responses = []; const events = [];
  return {
    evidence, responses, events,
    observe(event) {
      events.push(event);
      for (const block of event?.message?.content || []) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
        if (block.type !== 'tool_result') continue;
        const call = calls.get(block.tool_use_id);
        if (!call || /checkpoint/.test(call.name)) continue;
        const body = typeof block.content === 'string' ? block.content
          : (block.content || []).map(item => item.text || '').join('\n');
        const response = {
          tool: call.name, input: call.input, toolUseId: block.tool_use_id, text: body, isError: block.is_error === true, at: Date.now(),
        };
        responses.push(response);
        if (!response.isError && matches(body)) evidence.push(response);
      }
    },
  };
}

export function isNormalMemoryRetrieval(response) {
  if (/^mcp__/i.test(response?.tool || '')) {
    const name = response.tool.split('__').at(-1);
    if (name === 'brain_sync') return response.input?.include_context !== false;
    return /^(?:brain_ask|search(?:_.*)?|get_observations|timeline|retrieve(?:_.*)?)$/i.test(name);
  }
  if (/^Read$/i.test(response?.tool || '')) return /(?:^|[\\/])(?:CLAUDE\.md|AGENTS\.md|brain-brief\.md)$/i.test(response.input?.file_path || response.input?.path || '');
  return false;
}

export async function runClaudeStage({ approved, id, role, repoDir, home, prompt, sessionId,
  config = {}, ledger, limits, transcriptDir, timeoutMs = 300_000, onEvent = null, onAuditReady = null, preReserved = false }) {
  if (approved !== true) throw new Error('First paid run requires root budget review; no model call started');
  const cli = resolveCli('claude');
  if (!cli) throw new Error('Claude CLI unavailable');
  const audit = preparePassiveAudit({ home, repoDir, sessionId, settings: config.settings });
  onAuditReady?.(audit);
  const maximum = reservationUsd(limits);
  if (preReserved) {
    const prior = ledger.snapshot().reservations.find(r => r.id === id);
    if (!prior || prior.status !== 'reserved' || prior.maxCents < Math.ceil(maximum * 100)) throw new Error('Missing sufficient prepaid stage reservation');
    if (ledger.snapshot().halted) throw new Error('Budget accounting halted before prepaid stage start');
  } else ledger.reserve({ id, kind: `agent:${role}`, maxUsd: maximum,
    meta: { model: limits.model, stageBudgetUsd: limits.stageBudgetUsd, pricing: limits.priceSource, basis: 'CLI API-equivalent estimate; subscription invoice unknown' } });
  const mcpServers = config.mcpServers || {};
  fs.mkdirSync(transcriptDir, { recursive: true });
  const mcpFile = path.join(transcriptDir, `${id}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2));
  const settingsFile = path.join(transcriptDir, `${id}.settings.json`);
  fs.writeFileSync(settingsFile, JSON.stringify(audit.settings, null, 2));
  const stdoutFile = path.join(transcriptDir, `${id}.out.jsonl`);
  const stderrFile = path.join(transcriptDir, `${id}.err.txt`);
  const args = [...cli.prefix, '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', sessionId, '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', mcpFile,
    '--model', limits.model, '--effort', limits.effort || 'medium', '--max-budget-usd', String(limits.stageBudgetUsd),
    '--permission-mode', 'acceptEdits', '--allowedTools', claudeAllowedTools(mcpServers).join(','),
    '--disallowedTools', 'Agent,Task,WebSearch,WebFetch',
    '--settings', settingsFile, ...(config.claudeArgs || [])];
  const env = { ...freshEnvironment(home),
    ...config.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(limits.requestOutputLimitTokens || 4096), MCP_TIMEOUT: '120000',
    MCP_TOOL_TIMEOUT: '330000',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: limits.model, ANTHROPIC_SMALL_FAST_MODEL: limits.model,
    BENCH_DECISION_ROLE: role,
    GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const started = Date.now(); let stdout = ''; let stderr = ''; let pending = ''; let timedOut = false;
  const telemetryErrors = [];
  const observedResults = new Set();
  const result = await new Promise(resolve => {
    const child = spawn(cli.command, args, { cwd: repoDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const observeLine = line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch (error) { telemetryErrors.push(`Malformed stream JSON: ${error.message}`); return; }
      for (const block of event?.message?.content || []) if (block.type === 'tool_result') observedResults.add(block.tool_use_id);
      try { if (!telemetryErrors.length) onEvent?.(event); }
      catch (error) { telemetryErrors.push(`Event observer failed: ${error.message}`); }
    };
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); stdout += text; fs.appendFileSync(stdoutFile, text); pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        observeLine(line);
      }
    });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; fs.appendFileSync(stderrFile, text); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message }); });
    child.on('close', code => { clearTimeout(timer); if (pending.trim()) observeLine(pending); resolve({ code }); });
    child.stdin.end(prompt);
  });
  const parsed = parseClaudeResult(stdout);
  const usedModels = String(parsed.model || '').split('+').filter(Boolean);
  const unpricedModel = usedModels.some(model => model !== limits.model);
  if (Number.isFinite(parsed.costUsd)) ledger.settle(id, { actualUsd: parsed.costUsd,
    usage: { tokens: parsed.tokens, model: parsed.model, role } });
  else ledger.unknown(id, { reason: 'Claude did not report total_cost_usd; full reservation consumed, further spending halted' });
  if (unpricedModel) ledger.halt(`Unpriced side model appeared: ${parsed.model}`);
  let nativeAudit;
  try {
    nativeAudit = audit.read({ final: true });
    telemetryErrors.push(...nativeAudit.errors.map(error => error.error));
    const audited = new Set(nativeAudit.responses.map(response => response.toolUseId));
    for (const toolUseId of observedResults) if (!audited.has(toolUseId)) telemetryErrors.push(`Tool result lacks completed native batch audit: ${toolUseId}`);
  } catch (error) { telemetryErrors.push(`Native audit could not be read: ${error.message}`); }
  const auditDirectory = path.join(transcriptDir, `${id}.native-audit`);
  try { fs.cpSync(audit.dir, auditDirectory, { recursive: true, errorOnExist: true, force: false }); }
  catch (error) { telemetryErrors.push(`Native audit could not be preserved: ${error.message}`); }
  return { ...parsed, ok: result.code === 0 && !timedOut && !parsed.resultError && !unpricedModel && telemetryErrors.length === 0,
    budgetLimited: /max_budget|budget[_ -](?:usd|limit|exceeded)/i.test(parsed.resultError || ''),
    exitCode: result.code, timedOut, durationMs: Date.now() - started,
    stdoutFile, stderrFile, auditDirectory, sessionId, telemetryErrors,
    error: result.error || parsed.resultError || telemetryErrors[0] || (unpricedModel ? 'Unpriced side model appeared; review required before more paid work' : null), unpricedModel };
}
