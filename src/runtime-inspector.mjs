// Passive, content-free runtime attribution for KLYPIX MCP.
//
// This module never sends MCP requests, reads a brain, loads a model, or mutates
// a process. It joins OS process metadata to the supervisor/running-version
// receipts KLYPIX already writes so RAM can be discussed per connection instead
// of by misleading Task Manager group names.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const MB = 1024 * 1024;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundMb = (bytes) => Math.round((number(bytes) / MB) * 10) / 10;
const slash = (value) => String(value || '').replace(/\\/g, '/');

const SECRET_VALUE = /(api[-_]?key|authorization|bearer|password|secret|token)(\s*[:=]\s*|\s+)([^\s"']+)/ig;
export const sanitizeCommandLine = (value) => String(value || '')
  .replace(SECRET_VALUE, (_all, key, separator) => `${key}${separator}<redacted>`)
  .slice(0, 2_000);

const commandOf = (process) => sanitizeCommandLine(process?.command || process?.commandLine || '');
const basename = (value) => path.basename(String(value || '').replace(/^"|"$/g, '')).toLowerCase();

export function classifyKlypixProcess(process) {
  const command = slash(commandOf(process)).toLowerCase();
  if (/\b(brain-eval|klypix-ram-canary|memory-soak|klypix-conformance)\.(mjs|js)\b/.test(command)) return 'diagnostic';
  if (/\b(klypix-mcp-worker|klypix-worker)\.(mjs|js)\b/.test(command)) return 'worker';
  if (/\bklypix-mcp-server\.(mjs|js)\b/.test(command)
      || /\/klypix-mcp\/bin\/klypix-mcp\.mjs\b/.test(command)) return 'supervisor';
  if (/\bklypix-mcp\b/.test(command)
      && (/\bnpx(?:\.cmd)?\b/.test(command) || /\bnpx-cli\.js\b/.test(command) || /\bcmd(?:\.exe)?\b/.test(command))) return 'launcher';
  return 'other';
}

export function classifyHostProcess(process) {
  const name = basename(process?.name || process?.executable || '');
  const command = slash(commandOf(process)).toLowerCase();
  if (name === 'codex.exe' || /(^|[ /])codex(?:\.exe)?\b/.test(command)) return 'codex';
  if (/claude-code|@anthropic-ai\/claude-code/.test(command)) return 'claude-code';
  // Claude Desktop and the native Claude Code binary can both appear as
  // claude.exe on Windows. Do not invent precision unless MCP clientInfo or
  // the command line gives us authoritative product identity.
  if (name === 'claude.exe') return 'claude';
  if (name === 'cursor.exe' || /\/cursor(?:\.exe)?\b/.test(command)) return 'cursor';
  if (name === 'code.exe' || /\/code(?:\.exe)?\b/.test(command)) return 'vscode';
  if (name.includes('windsurf') || /windsurf/.test(command)) return 'windsurf';
  if (name.includes('antigravity') || /antigravity/.test(command)) return 'antigravity';
  if (name.includes('idea') || name.includes('webstorm') || name.includes('pycharm') || /jetbrains/.test(command)) return 'jetbrains';
  if (name.includes('chatgpt') || /chatgpt/.test(command)) return 'chatgpt';
  return 'unknown';
}

export function parseVaultArgument(commandLine) {
  const command = String(commandLine || '');
  const match = command.match(/(?:^|\s)--vault(?:=|\s+)("[^"]+"|'[^']+'|[^\s]+)/i);
  return match ? match[1].replace(/^['"]|['"]$/g, '') : null;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
};

export function readRuntimeReceipts(brainDir) {
  const root = path.resolve(brainDir || path.join(os.homedir(), '.claude', 'project-brain'));
  const supervisorDir = path.join(root, '.supervisors');
  let supervisorFiles = [];
  try { supervisorFiles = fs.readdirSync(supervisorDir).filter((name) => name.endsWith('.json')); } catch { /* absent */ }
  const supervisors = supervisorFiles
    .map((name) => readJson(path.join(supervisorDir, name), null))
    .filter(Boolean);
  const running = readJson(path.join(root, '.running-servers.json'), { servers: [] });
  return {
    brainDir: root,
    supervisors,
    runningServers: Array.isArray(running?.servers) ? running.servers : [],
  };
}

function normalizeProcess(raw) {
  return {
    pid: number(raw?.pid ?? raw?.ProcessId),
    ppid: number(raw?.ppid ?? raw?.ParentProcessId),
    name: String(raw?.name ?? raw?.Name ?? ''),
    executable: String(raw?.executable ?? raw?.ExecutablePath ?? ''),
    command: sanitizeCommandLine(raw?.command ?? raw?.CommandLine ?? ''),
    rssBytes: number(raw?.rssBytes ?? raw?.WorkingSetSize),
  };
}

const WINDOWS_PROCESS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$items = @(Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    pid = [int]$_.ProcessId',
  '    ppid = [int]$_.ParentProcessId',
  '    name = [string]$_.Name',
  '    executable = [string]$_.ExecutablePath',
  '    command = [string]$_.CommandLine',
  '    rssBytes = [double]$_.WorkingSetSize',
  '  }',
  '})',
  '$items | ConvertTo-Json -Compress',
].join('\n');

export function readProcessSnapshot({ platform = process.platform, exec = execFileSync } = {}) {
  if (platform === 'win32') {
    const stdout = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * MB, windowsHide: true,
    });
    const parsed = JSON.parse(String(stdout || '[]').replace(/^\uFEFF/, '') || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeProcess).filter((item) => item.pid > 0);
  }

  const stdout = exec('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * MB,
  });
  return String(stdout || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    const command = match[4];
    const first = command.match(/^"([^"]+)"|^(\S+)/);
    return normalizeProcess({
      pid: match[1], ppid: match[2], rssBytes: number(match[3]) * 1024,
      name: basename(first?.[1] || first?.[2] || ''), command,
    });
  }).filter(Boolean);
}

const findWorker = (supervisor, processes, state) => {
  const statePid = number(state?.active?.pid);
  if (statePid) return processes.get(statePid) || null;
  return [...processes.values()].find((item) => item.ppid === supervisor.pid && classifyKlypixProcess(item) === 'worker') || null;
};

function ancestorChain(start, processes, limit = 12) {
  const out = [];
  const seen = new Set([start?.pid]);
  let cursor = start;
  while (cursor?.ppid && out.length < limit) {
    const parent = processes.get(cursor.ppid);
    if (!parent || seen.has(parent.pid)) break;
    seen.add(parent.pid);
    out.push(parent);
    cursor = parent;
  }
  return out;
}

export function buildRuntimeReport({
  processRows = [], supervisorStates = [], runningServers = [], sampledAt = Date.now(), platform = process.platform,
} = {}) {
  const processes = new Map(processRows.map(normalizeProcess).filter((item) => item.pid > 0).map((item) => [item.pid, item]));
  const states = new Map((supervisorStates || []).filter(Boolean).map((state) => [number(state.pid), state]));
  const running = new Map((runningServers || []).filter(Boolean).map((server) => [number(server.pid), server]));
  const supervisors = [...processes.values()].filter((item) => classifyKlypixProcess(item) === 'supervisor');
  const workers = [...processes.values()].filter((item) => classifyKlypixProcess(item) === 'worker');
  const usedWorkers = new Set();
  const connections = [];

  const addConnection = (supervisor, worker, state, legacy = false) => {
    if (worker) usedWorkers.add(worker.pid);
    const ancestors = ancestorChain(supervisor || worker, processes);
    const host = ancestors.find((item) => classifyHostProcess(item) !== 'unknown') || null;
    const launchers = ancestors.filter((item) => classifyKlypixProcess(item) === 'launcher');
    const serverReceipt = worker ? running.get(worker.pid) : null;
    const requestedVault = parseVaultArgument(worker?.command)
      || parseVaultArgument(supervisor?.command)
      || null;
    const vault = serverReceipt?.vault || requestedVault || null;
    const processIds = [...new Set([
      supervisor?.pid,
      worker?.pid,
      ...launchers.map((item) => item.pid),
    ].filter(Boolean))];
    const rssBytes = processIds.reduce((sum, pid) => sum + number(processes.get(pid)?.rssBytes), 0);
    const flags = [];
    if (legacy) flags.push('legacy-direct-worker');
    if (!state && supervisor) flags.push('missing-supervisor-receipt');
    if (launchers.length) flags.push('npx-launcher-chain');
    if (!requestedVault || requestedVault === '.') flags.push('default-root');
    if (!host) flags.push('host-unattributed');
    connections.push({
      id: state?.connectionId || `pid-${supervisor?.pid || worker?.pid}`,
      client: state?.clientInfo?.name || (host ? classifyHostProcess(host) : 'unknown'),
      clientVersion: state?.clientInfo?.version || null,
      initialized: Boolean(state?.clientInfo?.name || state?.lastHostMessageAt),
      lastSeenAt: state?.lastHostMessageAt || null,
      host: host ? { pid: host.pid, kind: classifyHostProcess(host), name: host.name } : null,
      supervisor: supervisor ? {
        pid: supervisor.pid,
        rssMb: roundMb(supervisor.rssBytes),
        status: state?.status || 'unreported',
        version: state?.active?.version || null,
      } : null,
      worker: worker ? {
        pid: worker.pid,
        rssMb: roundMb(worker.rssBytes),
        version: serverReceipt?.version || state?.active?.version || null,
      } : null,
      launcher: {
        pids: launchers.map((item) => item.pid),
        rssMb: roundMb(launchers.reduce((sum, item) => sum + number(item.rssBytes), 0)),
      },
      vault,
      requestedVault,
      rssMb: roundMb(rssBytes),
      flags,
      processIds,
    });
  };

  for (const supervisor of supervisors) {
    const state = states.get(supervisor.pid) || null;
    addConnection(supervisor, findWorker(supervisor, processes, state), state, false);
  }
  for (const worker of workers) {
    if (usedWorkers.has(worker.pid)) continue;
    addConnection(null, worker, null, true);
  }

  const counted = new Set(connections.flatMap((item) => item.processIds));
  const roleTotals = { workersMb: 0, supervisorsMb: 0, launchersMb: 0 };
  for (const pid of counted) {
    const item = processes.get(pid);
    const role = classifyKlypixProcess(item);
    if (role === 'worker') roleTotals.workersMb += roundMb(item.rssBytes);
    else if (role === 'supervisor') roleTotals.supervisorsMb += roundMb(item.rssBytes);
    else if (role === 'launcher') roleTotals.launchersMb += roundMb(item.rssBytes);
  }
  for (const key of Object.keys(roleTotals)) roleTotals[key] = Math.round(roleTotals[key] * 10) / 10;

  const groups = new Map();
  for (const item of connections) {
    const key = [item.host?.pid || 'unknown', item.client, slash(item.vault || '.')].join('|').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.id);
  }
  const parallelConnectionGroups = [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, connectionIds]) => ({ key, connectionIds, verdict: 'parallel-not-proven-duplicate' }));

  const totalMb = Math.round((roleTotals.workersMb + roleTotals.supervisorsMb + roleTotals.launchersMb) * 10) / 10;
  return {
    schemaVersion: 1,
    sampledAt: new Date(sampledAt).toISOString(),
    platform,
    passive: true,
    mutated: false,
    totals: { connections: connections.length, ...roleTotals, totalMb },
    connections: connections.sort((a, b) => b.rssMb - a.rssMb),
    parallelConnectionGroups,
    safety: {
      automaticReapingEnabled: false,
      eligibleToReap: 0,
      reason: 'A live process tree proves ownership, not logical-session redundancy. No process is killed without an authoritative closed-connection receipt.',
    },
  };
}

export function inspectKlypixRuntime({ brainDir, platform = process.platform, exec = execFileSync, sampledAt = Date.now() } = {}) {
  const receipts = readRuntimeReceipts(brainDir);
  const processRows = readProcessSnapshot({ platform, exec });
  return buildRuntimeReport({
    processRows,
    supervisorStates: receipts.supervisors,
    runningServers: receipts.runningServers,
    sampledAt,
    platform,
  });
}

export function formatRuntimeReport(report) {
  const t = report?.totals || {};
  const lines = [
    `KLYPIX RUNTIME V2 — PASSIVE — ${report?.sampledAt || ''}`,
    `Connections ${t.connections || 0} · workers ${t.workersMb || 0} MB · supervisors ${t.supervisorsMb || 0} MB · launchers ${t.launchersMb || 0} MB · total ${t.totalMb || 0} MB`,
    '',
  ];
  for (const item of report?.connections || []) {
    const host = item.host ? `${item.host.kind}:${item.host.pid}` : 'host:unknown';
    const processBits = [
      item.supervisor ? `supervisor ${item.supervisor.pid}/${item.supervisor.rssMb}MB` : null,
      item.worker ? `worker ${item.worker.pid}/${item.worker.rssMb}MB` : null,
      item.launcher?.pids?.length ? `launcher ${item.launcher.rssMb}MB` : null,
    ].filter(Boolean).join(' · ');
    lines.push(`${item.client} · ${host} · ${item.vault || '(default root)'} · ${item.rssMb} MB`);
    lines.push(`  ${processBits}${item.flags?.length ? ` · flags: ${item.flags.join(', ')}` : ''}`);
  }
  if (report?.parallelConnectionGroups?.length) {
    lines.push('', `Parallel groups: ${report.parallelConnectionGroups.length} (visibility only; none is called a duplicate without a logical-session receipt).`);
  }
  lines.push('', 'Safety: passive only; no process was changed or terminated.');
  return lines.join('\n');
}
