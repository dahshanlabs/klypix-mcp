import {
  buildRuntimeReport,
  classifyHostProcess,
  classifyKlypixProcess,
  formatRuntimeReport,
  parseVaultArgument,
  sanitizeCommandLine,
} from '../src/runtime-inspector.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};

const proc = (pid, ppid, name, command, mb) => ({ pid, ppid, name, command, rssBytes: mb * 1024 * 1024 });
const rows = [
  proc(1, 0, 'codex.exe', 'codex.exe app-server', 220),
  proc(2, 1, 'cmd.exe', 'cmd.exe /c npx -y klypix-mcp --vault .', 6),
  proc(3, 2, 'node.exe', 'node npx-cli.js -y klypix-mcp --vault .', 38),
  proc(4, 3, 'node.exe', 'node node_modules/klypix-mcp/bin/klypix-mcp.mjs --vault .', 60),
  proc(5, 4, 'node.exe', 'node C:/brain/klypix-mcp-worker.mjs --vault .', 410),
  proc(6, 1, 'node.exe', 'node -e import(klypix-mcp-server.mjs) -- --vault E:/Repo', 62),
  proc(7, 6, 'node.exe', 'node C:/brain/klypix-mcp-worker.mjs --vault E:/Repo', 125),
  proc(8, 1, 'node.exe', 'node scripts/brain-eval.mjs --brain E:/Repo/brain.klypix', 700),
];

ok(classifyKlypixProcess(rows[3]) === 'supervisor', 'npx package entry is classified as a supervisor');
ok(classifyKlypixProcess(rows[4]) === 'worker', 'worker is classified independently');
ok(classifyKlypixProcess(rows[7]) === 'diagnostic', 'brain eval is excluded from MCP connection RAM');
ok(classifyHostProcess(rows[0]) === 'codex', 'host classification uses the real ancestor');
ok(classifyHostProcess(proc(9, 0, 'claude.exe', 'claude.exe', 100)) === 'claude', 'ambiguous Claude binaries stay honestly generic');
ok(parseVaultArgument('node worker.mjs --vault "E:/My Repo"') === 'E:/My Repo', 'quoted vault paths parse safely');
ok(!sanitizeCommandLine('node x --api-key=secret-value').includes('secret-value'), 'command-line secrets are redacted');

const sampledAt = Date.UTC(2026, 7, 4);
const report = buildRuntimeReport({
  processRows: rows,
  sampledAt,
  platform: 'win32',
  supervisorStates: [
    { pid: 4, updatedAt: new Date(sampledAt).toISOString(), lastHostMessageAt: new Date(sampledAt - 1_000).toISOString(), status: 'ready', clientInfo: { name: 'codex', version: '1' }, active: { pid: 5, version: '1.52.0' } },
    { pid: 6, updatedAt: new Date(sampledAt).toISOString(), status: 'ready', clientInfo: { name: 'codex', version: '1' }, active: { pid: 7, version: '1.52.0' } },
  ],
  runningServers: [
    { pid: 5, version: '1.52.0', vault: 'E:/Repo' },
    { pid: 7, version: '1.52.0', vault: 'E:/Repo' },
  ],
});

ok(report.passive && !report.mutated && !report.safety.automaticReapingEnabled, 'report is mutation-proof by contract');
ok(report.totals.connections === 2, 'one connection is built per supervisor');
ok(report.totals.workersMb === 535 && report.totals.supervisorsMb === 122, 'worker and supervisor RAM remain separate');
ok(report.totals.launchersMb === 44, 'npx launcher overhead is attributed once');
ok(report.totals.totalMb === 701, 'diagnostic and host RAM are excluded from MCP total');
ok(report.connections[0].host?.kind === 'codex', 'launcher chain resolves to its owning host');
ok(report.connections[0].initialized && report.connections[0].lastSeenAt, 'live initialization evidence is preserved for the app');
ok(report.connections[0].flags.includes('npx-launcher-chain'), 'avoidable launcher overhead is visible');
ok(report.connections[0].flags.includes('default-root') && report.connections[0].vault === 'E:/Repo', 'requested dot-root stays visible beside the resolved project');
ok(report.parallelConnectionGroups[0]?.verdict === 'parallel-not-proven-duplicate', 'parallel sessions are never mislabeled as duplicates');
ok(formatRuntimeReport(report).includes('no process was changed or terminated'), 'human report states the safety boundary');

console.log(failures ? `\n✗ ${failures} runtime-inspector assertion(s) failed` : '\n✓ runtime-inspector: all assertions passed');
process.exit(failures ? 1 : 0);
