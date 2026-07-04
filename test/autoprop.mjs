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
{
  const home = tmp('e-stale'); const bd = seedInstalledBrain(home, '1.20.1');
  fs.writeFileSync(path.join(bd, '.running-version.json'), JSON.stringify({ version: '1.19.0', pid: 1, bootedAt: new Date(0).toISOString() }));
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'drift' && r.running.matchesInstalled === false, 'E: running v1.19 ≠ installed v1.20.1 → RUNNING drift (the exact stale-server incident)');
  ok(r.verdict === 'DRIFTED', 'E: a stale live server makes the verdict DRIFTED, not a false ALIGNED');
  ok(r.actions.some(a => /reconnect/i.test(a)), 'E: the reconcile action tells the agent to /mcp reconnect');
  rmrf(home);
}
{
  const home = tmp('e-match'); const bd = seedInstalledBrain(home, '1.20.1');
  fs.writeFileSync(path.join(bd, '.running-version.json'), JSON.stringify({ version: '1.20.1', pid: 1, bootedAt: new Date().toISOString() }));
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'ok' && r.running.matchesInstalled === true, 'E: running == installed → RUNNING ok');
  rmrf(home);
}
{
  const home = tmp('e-unknown'); seedInstalledBrain(home, '1.20.1');   // no .running-version.json
  const r = inspect({ home, projectDir: home });
  ok(r.layers.running === 'unknown', 'E: no heartbeat yet → RUNNING unknown (reconnect prompt), NOT drift');
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
  // an EXISTING stale config (the migration subject)
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] } } }, null, 2));
  runInstall(home, proj);
  const bd = path.join(home, '.claude', 'project-brain');
  for (const f of ['global-brain-hook.mjs', 'klypix-format.mjs', 'klypix-core.mjs', 'klypix-mcp-server.mjs', 'agent-rules.mjs', 'brain-doctor.mjs']) {
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

  // re-install → .prev backup of the prior scripts is created
  runInstall(home, proj);
  ok(fs.existsSync(path.join(bd, '.prev', 'global-brain-hook.mjs')), 'D: re-install snapshots the prior scripts to .prev/ (rollback)');
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
