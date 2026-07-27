// Acceptance gauntlet for the auto-propagation reliability system (from the AgentMug
// 2026-07-04 spec — "publish ⇒ every user runs it, zero manual npx, reliably"):
//   A  local-bundle server  — the emitted MCP config prefers the installed bundle
//                             (node …/klypix-mcp-server.mjs), npx only as bootstrap.
//   D  atomic install       — real install lays a complete bundle, no torn/leftover
//                             files, .prev backup on re-install, .mcp.json migrated
//                             off npx, concurrent installs are idempotent (lock).
//   E  honest doctor        — a boot heartbeat lets doctor compare RUNNING vs
//                             installed; a stale live server reads DRIFTED, not ALIGNED.
//   B  self-update gating    — the pure decision: disabled / throttled / dev / offline /
//                             current all NO-OP; only a genuine newer npm acts.
//
// Hermetic: temp HOME/project per case, real `node bin/klypix-install.mjs`, no network.
// Run:  node test/autoprop.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mcpServerEntry } from '../src/agent-rules.mjs';
import { inspect } from '../src/brain-doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'bin', 'klypix-install.mjs');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } };
const tmp = (tag) => { const p = path.join(os.tmpdir(), 'klypix-autoprop-' + tag); rmrf(p); fs.mkdirSync(p, { recursive: true }); return p; };

// ── A — mcpServerEntry prefers the local bundle, falls back to npx ────────────
{
  const home = tmp('a-home');
  const bd = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(bd, { recursive: true });
  // No server file yet → bootstrap via npx.
  const npxEntry = mcpServerEntry({ vault: '/proj', home });
  ok(npxEntry.command === 'npx' && npxEntry.args.includes('klypix-mcp'), 'A: no local bundle → npx bootstrap entry');
  // Lay the server file → prefer local node launch.
  fs.writeFileSync(path.join(bd, 'klypix-mcp-server.mjs'), '// server');
  const localEntry = mcpServerEntry({ vault: '/proj', home });
  ok(localEntry.command === 'node' && localEntry.args[0] === '-e' && localEntry.args[1].includes('klypix-mcp-server.mjs'), 'A: local bundle present → portable node local-bundle entry (no npx cache)');
  ok(!JSON.stringify(localEntry).includes(home.replace(/\\/g, '/')), 'A: local-bundle entry does not leak a machine-specific home path');
  ok(localEntry.args.includes('/proj'), 'A: the --vault value is preserved');
  ok(mcpServerEntry({ vault: '.', withType: true, home }).type === 'stdio', 'A: withType adds the stdio type for VS Code-style configs');
  rmrf(home);
}

// ── B — shouldSelfUpdate pure gating (the risky lever, tested in isolation) ───
{
  // Import for the pure export ONLY — guard main() (it would process.exit(0) the test).
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';
  const { shouldSelfUpdate } = await import('../src/global-brain-hook.mjs');
  delete process.env.KLYPIX_BRAIN_NO_MAIN;   // don't leak into the install child procs below
  const now = 1_000_000_000_000, DAY = 86_400_000;
  ok(shouldSelfUpdate({ enabled: false, now, latest: '2.0.0', installed: '1.0.0' }).reason === 'disabled', 'B: KLYPIX_AUTO_UPDATE off → no update');
  ok(shouldSelfUpdate({ enabled: true, now, lastCheck: now - 1000, latest: '2.0.0', installed: '1.0.0' }).reason === 'throttled', 'B: within 24h TTL → throttled (no re-check)');
  ok(shouldSelfUpdate({ enabled: true, now, lastCheck: now - 2 * DAY, dev: true, latest: '2.0.0', installed: '1.0.0' }).reason === 'dev-owned', 'B: a dev deploy is never auto-updated');
  ok(shouldSelfUpdate({ enabled: true, now, lastCheck: now - 2 * DAY, latest: '(offline)', installed: '1.0.0' }).reason === 'unknown', 'B: offline/unknown latest → no-op (fail-open)');
  ok(shouldSelfUpdate({ enabled: true, now, lastCheck: now - 2 * DAY, latest: '1.0.0', installed: '1.0.0' }).reason === 'current', 'B: already current → no-op');
  const act = shouldSelfUpdate({ enabled: true, now, lastCheck: now - 2 * DAY, latest: '1.21.0', installed: '1.20.1' });
  ok(act.act === true && act.latest === '1.21.0', 'B: a genuinely newer npm version → self-update acts');
}

// ── E — brain_doctor compares RUNNING vs installed (behavioral truth) ─────────
function seedInstalledBrain(home, bakedVersion) {
  const bd = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(bd, { recursive: true });
  fs.writeFileSync(path.join(bd, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '${bakedVersion}';\n`);
  fs.writeFileSync(path.join(bd, '.brain-version.json'), JSON.stringify({ brainVersion: bakedVersion, via: 'npm', dirty: false }));
  return bd;
}
const ALIVE = process.pid;          // a genuinely-alive pid for registry entries
const DEAD = 2147483646;            // a pid that does not exist → pruned by liveness
const reg = (bd, servers) => fs.writeFileSync(path.join(bd, '.running-servers.json'), JSON.stringify({ servers }));
const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
const REUSED_ISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
{
  // CLI mode: a live server whose version < installed → RUNNING drift (the incident).
  const home = tmp('e-stale'); const bd = seedInstalledBrain(home, '1.20.1');
  reg(bd, [{ pid: ALIVE, version: '1.19.0', vault: '/x', bootedAt: NOW_ISO }]);
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'drift' && r.running.matchesInstalled === false, 'E: a LIVE server v1.19 ≠ installed v1.20.1 → RUNNING drift (the stale-server incident)');
  ok(r.verdict === 'DRIFTED' && r.actions.some(a => /reconnect/i.test(a)), 'E: stale live server → verdict DRIFTED + /mcp reconnect action');
  rmrf(home);
}
{
  // An ALIVE reused PID without a renewable MCP heartbeat is pruned within
  // minutes, so an unrelated same-day process cannot create false CLI drift.
  const home = tmp('e-aged'); const bd = seedInstalledBrain(home, '1.21.0');
  reg(bd, [{ pid: ALIVE, version: '1.10.0', vault: '/reused', bootedAt: REUSED_ISO }]);
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'unknown', 'E: an alive reused PID without a fresh heartbeat is rejected → not a false DRIFT');
  rmrf(home);
}
{
  // A genuinely long-running MCP worker remains current through lastSeenAt,
  // independent of its old boot timestamp.
  const home = tmp('e-heartbeat'); const bd = seedInstalledBrain(home, '1.21.0');
  reg(bd, [{ pid: ALIVE, version: '1.21.0', vault: '/live', bootedAt: OLD_ISO, lastSeenAt: NOW_ISO }]);
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'ok', 'E: a renewable heartbeat preserves a genuinely long-running MCP server');
  rmrf(home);
}
{
  // self mode is PHANTOM-PROOF: a stale peer server is registered, but the caller
  // (brain_doctor AS the MCP tool) reports ITS OWN version — not the phantom.
  const home = tmp('e-phantom'); const bd = seedInstalledBrain(home, '1.21.0');
  reg(bd, [{ pid: ALIVE, version: '1.19.0', vault: '/peer', bootedAt: new Date().toISOString() }]);   // a live PHANTOM peer
  const r = inspect({ home, projectDir: home, self: { pid: 424242, version: '1.21.0' } });
  ok(r.running.self === true && r.running.version === '1.21.0' && r.running.matchesInstalled === true, 'E: self mode reports the CALLER’s own server (1.21.0), never the phantom peer (1.19.0)');
  ok(r.layers.running === 'ok', 'E: the caller’s server matches installed → RUNNING ok despite a stale peer in the registry');
  ok((r.running.others || []).some(s => s.version === '1.19.0'), 'E: the stale peer is still surfaced as an "other" live server (visible, not hidden)');
  rmrf(home);
}
{
  // dead pids are pruned; a matching live server → ok.
  const home = tmp('e-prune'); const bd = seedInstalledBrain(home, '1.21.0');
  reg(bd, [{ pid: DEAD, version: '1.10.0', bootedAt: new Date(0).toISOString() }, { pid: ALIVE, version: '1.21.0', bootedAt: new Date().toISOString() }]);
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'ok' && r.running.matchesInstalled === true, 'E: a DEAD-pid stale entry is pruned; the live matching server → RUNNING ok');
  rmrf(home);
}
{
  // registry absent → falls back to the legacy single-file heartbeat (transition compat).
  const home = tmp('e-legacy'); const bd = seedInstalledBrain(home, '1.21.0');
  fs.writeFileSync(path.join(bd, '.running-version.json'), JSON.stringify({ version: '1.21.0', pid: ALIVE, bootedAt: new Date().toISOString() }));
  const r = inspect({ home, projectDir: home });
  ok(r.running.known === true && r.running.version === '1.21.0', 'E: no registry → a LIVE-pid legacy .running-version.json is still read (transition compat)');
  rmrf(home);
}
{
  // 1.21.2 fix: a legacy single-file heartbeat from a DEAD server must NOT be trusted —
  // else its leftover file reads as a live stale server forever (a phantom).
  const home = tmp('e-legacy-dead'); const bd = seedInstalledBrain(home, '1.21.1');
  fs.writeFileSync(path.join(bd, '.running-version.json'), JSON.stringify({ version: '1.21.0', pid: DEAD, bootedAt: new Date().toISOString() }));
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'unknown', 'E: a DEAD-pid legacy heartbeat is NOT trusted → no phantom stale-server DRIFT');
  rmrf(home);
}
{
  const home = tmp('e-unknown'); seedInstalledBrain(home, '1.21.0');   // no registry, no legacy file
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'unknown', 'E: no heartbeat at all → RUNNING unknown (reconnect prompt), NOT drift');
  ok(!(r.drifted && r.layers.running === 'drift'), 'E: unknown running does not by itself force DRIFTED');
  rmrf(home);
}

// ── D — real atomic install: complete bundle, migration, no leftovers, .prev, lock ──
{
  const home = tmp('e-supervisor'); const bd = seedInstalledBrain(home, '1.39.0');
  fs.appendFileSync(path.join(bd, 'klypix-mcp-server.mjs'), 'runMcpSupervisor();\n');
  fs.writeFileSync(path.join(bd, 'mcp-supervisor.mjs'), '// supervisor');
  reg(bd, [{ pid: ALIVE, version: '1.39.0', bootedAt: NOW_ISO }]);
  let r = inspect({ home, projectDir: home });
  ok(r.layers.supervisor === 'pending-reconnect' && r.actions.some(a => /reconnect once/.test(a)),
    'E: a legacy live session gets one explicit reconnect-to-supervisor action');
  const states = path.join(bd, '.supervisors');
  fs.mkdirSync(states, { recursive: true });
  fs.writeFileSync(path.join(states, `${ALIVE}.json`), JSON.stringify({
    pid: ALIVE,
    status: 'ready',
    active: { pid: ALIVE, version: '1.39.0' },
    hotReloads: 2,
  }));
  r = inspect({ home, projectDir: home });
  ok(r.layers.supervisor === 'ok' && r.supervisors.active && r.supervisors.live[0].hotReloads === 2,
    'E: doctor reports a live zero-restart supervisor and its hot-swap count');
  rmrf(home);
}

function runInstall(home, projectCwd, args = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  return execFileSync(process.execPath, [INSTALL, ...args], { cwd: projectCwd, env, encoding: 'utf8' });
}
{
  const home = tmp('d-home');
  const proj = tmp('d-proj');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-test"\n\n# obsolete global KLYPIX table\n[mcp_servers.klypix-canvas]\ncommand = "node"\nargs = ["old/klypix-mcp-server.mjs", "--vault", "."]\n\n# keep this server\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n');
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# Personal Codex instructions\n');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'fixture');
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.codex', 'config.toml'),
    'model = "gpt-project"\n\n[mcp_servers.project-docs]\nurl = "https://project.example.test/mcp"\n');
  // an EXISTING stale config (the migration subject)
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] } } }, null, 2));
  runInstall(home, proj);
  const bd = path.join(home, '.claude', 'project-brain');
  for (const f of ['global-brain-hook.mjs', 'klypix-format.mjs', 'klypix-core.mjs', 'klypix-mcp-server.mjs', 'klypix-mcp-worker.mjs', 'mcp-supervisor.mjs', 'klypix-conformance.mjs', 'agent-rules.mjs', 'brain-doctor.mjs', 'agent-presence.mjs', 'mcp-presence.mjs', 'codex-brain-hook.mjs', 'codex-hooks.mjs']) {
    ok(fs.existsSync(path.join(bd, f)), `D: installed ${f}`);
  }
  ok(fs.existsSync(path.join(bd, 'node_modules', 'jszip')), 'D: runtime deps (jszip) copied');
  ok(fs.readdirSync(bd).every(f => !f.endsWith('.klypix-new')), 'D: no half-written .klypix-new leftovers (atomic rename completed)');
  const stamp = JSON.parse(fs.readFileSync(path.join(bd, '.brain-version.json'), 'utf8'));
  ok(stamp.brainVersion === PKG_VERSION, `D: stamp brainVersion == package v${PKG_VERSION}`);
  const runtime = JSON.parse(fs.readFileSync(path.join(bd, '.mcp-runtime.json'), 'utf8'));
  ok(runtime.protocol === 1 && runtime.version === PKG_VERSION && runtime.worker === 'klypix-mcp-worker.mjs',
    'D: atomic runtime pointer targets the replaceable worker');
  ok(Object.entries(runtime.files).every(([name, expected]) =>
    fs.existsSync(path.join(bd, name))
    && crypto.createHash('sha256').update(fs.readFileSync(path.join(bd, name))).digest('hex') === expected),
  'D: runtime pointer hashes verify every staged file');
  const installedAudit = inspect({ home, projectDir: proj });
  ok(installedAudit.tools.count === new Set(installedAudit.tools.names).size,
    'D: doctor reports the exact unique tool count when App and fallback registrations share a name');
  const baked = fs.readFileSync(path.join(bd, 'klypix-mcp-server.mjs'), 'utf8');
  ok(new RegExp(`const PKG_VERSION = '${PKG_VERSION.replace(/\./g, '\\.')}'`).test(baked), 'D: server has the baked version (flat layout has no package.json)');
  // migration: the project .mcp.json flipped npx → local node, with a backup.
  const mcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  ok(mcp.mcpServers['klypix-canvas'].command === 'node'
    && mcp.mcpServers['klypix-canvas'].args[0] === '-e'
    && mcp.mcpServers['klypix-canvas'].args[1].includes('klypix-mcp-server.mjs'),
  'D: existing .mcp.json migrated npx → portable local bundle');
  ok(fs.existsSync(path.join(proj, '.mcp.json.klypix-bak')), 'D: the original .mcp.json was backed up before migration');
  // settings.json wired 4 hooks
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'].every(e => Array.isArray(settings.hooks?.[e])), 'D: all 4 Claude Code hooks wired');
  const globalCodexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  ok(!globalCodexConfig.includes('[mcp_servers.klypix-canvas]'), 'D: obsolete wrong-vault global Codex KLYPIX entry is removed');
  ok(globalCodexConfig.includes('model = "gpt-test"') && globalCodexConfig.includes('[mcp_servers.docs]'), 'D: global Codex cleanup preserves user settings + sibling servers');
  const codexConfig = fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8');
  const boundProject = proj.replace(/\\/g, '/');
  ok(codexConfig.includes('[mcp_servers.klypix-canvas]')
    && codexConfig.includes(`"--vault", ${JSON.stringify(boundProject)}`)
    && codexConfig.includes(`cwd = ${JSON.stringify(boundProject)}`),
  'D: Codex project MCP is mechanically bound to the exact project root');
  ok(codexConfig.includes('model = "gpt-project"') && codexConfig.includes('[mcp_servers.project-docs]'), 'D: project Codex config preserves user settings + sibling servers');
  const codexAgents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  ok(codexAgents.includes('# Personal Codex instructions') && codexAgents.includes('klypix-codex:start'), 'D: Codex global guidance is fence-merged with personal instructions');
  ok(codexAgents.includes('brain_sync') && codexAgents.includes('expected files') && codexAgents.includes('current project root'),
    'D: Codex guidance supplies host-independent project/task/file synchronization');
  ok(fs.existsSync(path.join(home, '.codex', 'config.toml.klypix-bak'))
    && fs.existsSync(path.join(proj, '.codex', 'config.toml.klypix-bak')), 'D: Codex config changes get rollback backups');
  ok(!fs.existsSync(path.join(home, '.codex', 'hooks.json')),
    'D: default install does not create trust-gated Codex hooks');
  runInstall(home, proj, ['--codex-hooks']);
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'PostToolUse', 'SessionEnd'].every((event) =>
    codexHooks.hooks?.[event]?.some((group) =>
      group.hooks?.some((hook) => hook.command?.includes('codex-brain-hook.mjs')))),
  'D: explicit --codex-hooks wires all 6 enhanced-awareness hooks');

  // A project-owned, repo-relative node server is already portable. Reinstall
  // must not replace it with a machine-specific ~/.claude path.
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'klypix-canvas': { command: 'node', args: ['scripts/klypix-mcp-server.mjs', '--vault', '.'] },
    },
  }, null, 2));

  // re-install → .prev backup of the prior scripts is created
  runInstall(home, proj);
  ok(fs.existsSync(path.join(bd, '.prev', 'global-brain-hook.mjs')), 'D: re-install snapshots the prior scripts to .prev/ (rollback)');
  ok(JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8')).mcpServers['klypix-canvas'].args[0] === 'scripts/klypix-mcp-server.mjs',
    'D: reinstall preserves a portable project-owned node server');
  ok((fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.klypix-canvas\]/g) || []).length === 1, 'D: Codex project MCP registration stays idempotent on re-install');
  ok((fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8').match(/klypix-codex:start/g) || []).length === 1, 'D: Codex global guidance stays idempotent on re-install');
  ok((fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8').match(/codex-brain-hook\.mjs/g) || []).length === 6, 'D: Codex presence hooks stay idempotent on re-install');
  ok(!fs.existsSync(path.join(bd, '.install.lock')), 'D: the install lock is released after completion');

  // concurrency: two installs at once are idempotent (lock serializes; no torn state)
  const env = { ...process.env, HOME: home, USERPROFILE: home }; delete env.KLYPIX_BRAIN_NO_MAIN;
  const { execFile } = await import('child_process');
  const run = () => new Promise(res => execFile(process.execPath, [INSTALL], { cwd: proj, env }, (e) => res(e ? 1 : 0)));
  const [a, b] = await Promise.all([run(), run()]);
  ok(a === 0 && b === 0, 'D: two concurrent installs both succeed (lock serializes them)');
  ok(fs.existsSync(path.join(bd, 'global-brain-hook.mjs')) && fs.readdirSync(bd).every(f => !f.endsWith('.klypix-new')), 'D: after concurrent installs the bundle is intact, no leftovers');
  ok(!fs.existsSync(path.join(bd, '.install.lock')), 'D: no lock leaked after concurrent installs');
  rmrf(home); rmrf(proj);
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ autoprop: all assertions passed');
process.exit(failures ? 1 : 0);
