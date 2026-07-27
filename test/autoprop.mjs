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
  ok(localEntry.command === 'node' && localEntry.args[0].endsWith('klypix-mcp-server.mjs'), 'A: local bundle present → node local-bundle entry (no npx cache)');
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
const OLD_ISO = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();   // >24h → aged out
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
  // review fix (medium): an ALIVE-pid but AGED-OUT stale entry (reused-PID phantom) is
  // pruned, so it can't produce a false DRIFT in CLI doctor.
  const home = tmp('e-aged'); const bd = seedInstalledBrain(home, '1.21.0');
  reg(bd, [{ pid: ALIVE, version: '1.10.0', vault: '/reused', bootedAt: OLD_ISO }]);
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'unknown', 'E: an alive-pid but >24h-old entry (reused-PID phantom) is aged out → not a false DRIFT');
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
function runInstall(home, projectCwd) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  return execFileSync(process.execPath, [INSTALL], { cwd: projectCwd, env, encoding: 'utf8' });
}
{
  const home = tmp('d-home');
  const proj = tmp('d-proj');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-test"\n\n# keep this server\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n');
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# Personal Codex instructions\n');
  // an EXISTING stale config (the migration subject)
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] } } }, null, 2));
  runInstall(home, proj);
  const bd = path.join(home, '.claude', 'project-brain');
  for (const f of ['global-brain-hook.mjs', 'klypix-format.mjs', 'klypix-core.mjs', 'klypix-mcp-server.mjs', 'agent-rules.mjs', 'brain-doctor.mjs', 'agent-presence.mjs', 'codex-brain-hook.mjs', 'codex-hooks.mjs']) {
    ok(fs.existsSync(path.join(bd, f)), `D: installed ${f}`);
  }
  ok(fs.existsSync(path.join(bd, 'node_modules', 'jszip')), 'D: runtime deps (jszip) copied');
  ok(fs.readdirSync(bd).every(f => !f.endsWith('.klypix-new')), 'D: no half-written .klypix-new leftovers (atomic rename completed)');
  const stamp = JSON.parse(fs.readFileSync(path.join(bd, '.brain-version.json'), 'utf8'));
  ok(stamp.brainVersion === PKG_VERSION, `D: stamp brainVersion == package v${PKG_VERSION}`);
  const baked = fs.readFileSync(path.join(bd, 'klypix-mcp-server.mjs'), 'utf8');
  ok(new RegExp(`const PKG_VERSION = '${PKG_VERSION.replace(/\./g, '\\.')}'`).test(baked), 'D: server has the baked version (flat layout has no package.json)');
  // migration: the project .mcp.json flipped npx → local node, with a backup.
  const mcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  ok(mcp.mcpServers['klypix-canvas'].command === 'node' && mcp.mcpServers['klypix-canvas'].args[0].endsWith('klypix-mcp-server.mjs'), 'D: existing .mcp.json migrated npx → local bundle');
  ok(fs.existsSync(path.join(proj, '.mcp.json.klypix-bak')), 'D: the original .mcp.json was backed up before migration');
  // settings.json wired 4 hooks
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'].every(e => Array.isArray(settings.hooks?.[e])), 'D: all 4 Claude Code hooks wired');
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  ok(codexConfig.includes('[mcp_servers.klypix-canvas]') && codexConfig.includes('klypix-mcp-server.mjs'), 'D: Codex native MCP server wired to the installed local bundle');
  ok(codexConfig.includes('model = "gpt-test"') && codexConfig.includes('[mcp_servers.docs]'), 'D: Codex config preserves user settings + sibling servers');
  const codexAgents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  ok(codexAgents.includes('# Personal Codex instructions') && codexAgents.includes('klypix-codex:start'), 'D: Codex global guidance is fence-merged with personal instructions');
  ok(fs.existsSync(path.join(home, '.codex', 'config.toml.klypix-bak')), 'D: Codex config gets a rollback backup');
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'SessionEnd'].every((event) =>
    codexHooks.hooks?.[event]?.some((group) =>
      group.hooks?.some((hook) => hook.command?.includes('codex-brain-hook.mjs')))),
  'D: all 5 Codex live-presence hooks wired');

  // re-install → .prev backup of the prior scripts is created
  runInstall(home, proj);
  ok(fs.existsSync(path.join(bd, '.prev', 'global-brain-hook.mjs')), 'D: re-install snapshots the prior scripts to .prev/ (rollback)');
  ok((fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.klypix-canvas\]/g) || []).length === 1, 'D: Codex MCP registration stays idempotent on re-install');
  ok((fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8').match(/klypix-codex:start/g) || []).length === 1, 'D: Codex global guidance stays idempotent on re-install');
  ok((fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8').match(/codex-brain-hook\.mjs/g) || []).length === 5, 'D: Codex presence hooks stay idempotent on re-install');
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
