// Acceptance tests for the host-neutral MCP updater. All registry and installer
// seams are injected; this test never contacts npm or changes the user's brain.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import {
  autoUpdatePaths,
  installExactRuntime,
  inspectAutoUpdate,
  readRegisteredProjectBrains,
  reconcileRegisteredProjects,
  registerProjectBrain,
  runAutoUpdateCheck,
  spawnAutoUpdateHelper,
} from '../src/mcp-auto-update.mjs';
import { auditProject, compactAgentsBrief, linkProject } from '../src/agent-rules.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-auto-update-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`✓ ${message}`); }
  else { fail++; console.error(`✗ ${message}`); }
};
const scenario = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const writeRuntime = (dir, version, { dev = false } = {}) => {
  fs.writeFileSync(path.join(dir, '.mcp-runtime.json'), JSON.stringify({
    protocol: 1,
    version,
    worker: 'worker.mjs',
    dev,
  }));
  fs.writeFileSync(path.join(dir, '.brain-version.json'), JSON.stringify({
    brainVersion: version,
    dev,
    via: dev ? 'dev' : 'npm',
  }));
};

try {
  {
    const dir = scenario('disabled');
    let fetched = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      enabled: false,
      fetchLatest: async () => { fetched = true; return '1.1.0'; },
    });
    ok(result.result === 'disabled' && !fetched, 'opt-out performs no registry or install work');
  }

  {
    const dir = scenario('current-and-throttle');
    writeRuntime(dir, '1.4.0');
    let fetches = 0, installs = 0;
    const options = {
      brainDir: dir,
      now: 100_000,
      fetchLatest: async () => { fetches++; return '1.4.0'; },
      installVersion: async () => { installs++; },
    };
    const first = await runAutoUpdateCheck(options);
    const second = await runAutoUpdateCheck({ ...options, now: 100_001 });
    ok(first.result === 'current' && fetches === 1 && installs === 0, 'current runtime checks npm once and does not install');
    ok(second.result === 'throttled' && fetches === 1, 'machine-wide 24h stamp throttles later sessions');
  }

  {
    const dir = scenario('compatible-update');
    writeRuntime(dir, '1.4.0');
    let exact = null;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 200_000,
      fetchLatest: async () => '1.5.2',
      installVersion: async (version, { brainDir }) => {
        exact = version;
        writeRuntime(brainDir, version);
      },
    });
    const status = JSON.parse(fs.readFileSync(autoUpdatePaths(dir).status, 'utf8'));
    ok(result.result === 'updated' && exact === '1.5.2', 'new compatible release installs by exact immutable version');
    ok(status.installedVersion === '1.5.2' && !fs.existsSync(autoUpdatePaths(dir).lock), 'successful update is verified, receipted, and unlocks');
  }

  {
    const dir = scenario('current-reconciles-harness');
    writeRuntime(dir, '1.5.2');
    let reconciledVersion = null;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 250_000,
      fetchLatest: async () => '1.5.2',
      reconcileProjects: async ({ version }) => {
        reconciledVersion = version;
        return { checked: 2, updated: 1, unchanged: 1, failed: 0, skipped: 0, projects: [] };
      },
    });
    const diagnostic = inspectAutoUpdate(dir, { now: 250_001 });
    ok(result.result === 'current' && reconciledVersion === '1.5.2', 'a current runtime still repairs registered project harnesses automatically');
    ok(diagnostic.harness?.updated === 1 && diagnostic.harness?.unchanged === 1, 'automatic harness reconciliation leaves a durable diagnostic receipt');
  }

  {
    const dir = scenario('registered-project-reconciliation');
    const projectA = path.join(dir, 'project-a');
    const projectB = path.join(dir, 'project-b');
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, 'brain.klypix'), 'placeholder brain');
    }
    fs.writeFileSync(path.join(projectA, 'AGENTS.md'), '# Human project law\n\nKeep this paragraph.\n');
    fs.mkdirSync(path.join(projectB, '.cline'), { recursive: true });
    fs.writeFileSync(path.join(projectB, '.cline', 'mcp.json'), '{ invalid-json');

    const a = registerProjectBrain({ brainPath: path.join(projectA, 'brain.klypix'), brainDir: dir, now: 10 });
    const b = registerProjectBrain({ brainPath: path.join(projectB, 'brain.klypix'), brainDir: dir, now: 20 });
    registerProjectBrain({ brainPath: path.join(projectA, 'brain.klypix'), brainDir: dir, now: 30 });
    const registered = readRegisteredProjectBrains(dir);
    const receipt = await reconcileRegisteredProjects({
      brainDir: dir,
      version: '1.5.2',
      rules: { auditProject, compactAgentsBrief, linkProject },
    });
    const humanAgents = fs.readFileSync(path.join(projectA, 'AGENTS.md'), 'utf8');
    const pendingDirs = [dir];
    const tempLeaks = [];
    while (pendingDirs.length) {
      const current = pendingDirs.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) pendingDirs.push(full);
        else if (entry.name.endsWith('.klypix-tmp')) tempLeaks.push(full);
      }
    }
    ok(a.registered && b.registered && registered.length === 2, 'all MCP hosts share one locked, de-duplicated project registry');
    ok(receipt.checked === 2 && receipt.updated === 1 && receipt.failed === 1, 'one malformed host config is isolated while every other project/file still converges');
    ok(auditProject(projectA, { version: '1.5.2' }).ok, 'a registered drifted project reaches all projected harness targets without a manual link');
    ok(humanAgents.startsWith('# Human project law\n\nKeep this paragraph.') && /klypix-brain:start v=1\.5\.2/.test(humanAgents), 'automatic repair preserves human AGENTS.md content outside the managed fence');
    ok(fs.readFileSync(path.join(projectB, '.cline', 'mcp.json'), 'utf8') === '{ invalid-json'
      && receipt.projects.find((item) => item.project === 'project-b')?.status === 'partial',
    'an invalid human-owned JSON file is left untouched and reported as partial');
    ok(tempLeaks.length === 0, 'atomic harness writes leave no staged temp files behind');
  }

  {
    const dir = scenario('bootstrap');
    let installed = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      currentVersion: '1.5.2',
      now: 300_000,
      fetchLatest: async () => '1.5.2',
      installVersion: async (version, { brainDir }) => {
        installed = true;
        writeRuntime(brainDir, version);
      },
    });
    ok(result.result === 'bootstrapped' && installed, 'a direct-package MCP launch bootstraps the managed runtime once');
  }

  {
    const dir = scenario('unpublished-dev-package');
    let installed = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      currentVersion: '1.6.0',
      now: 350_000,
      fetchLatest: async () => '1.5.2',
      installVersion: async () => { installed = true; },
    });
    ok(result.result === 'ahead' && !installed, 'an unpublished direct-package build is never downgraded from npm');
  }

  {
    const dir = scenario('major-boundary');
    writeRuntime(dir, '1.9.0');
    let installed = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 400_000,
      fetchLatest: async () => '2.0.0',
      installVersion: async () => { installed = true; },
    });
    ok(result.result === 'major-blocked' && !installed, 'automatic updater stops at a major-version trust boundary');
  }

  {
    const dir = scenario('dev-owned');
    writeRuntime(dir, '1.9.0', { dev: true });
    let fetched = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 500_000,
      fetchLatest: async () => { fetched = true; return '1.9.1'; },
    });
    ok(result.result === 'dev-owned' && !fetched, 'a developer-owned runtime is never overwritten');
  }

  {
    const dir = scenario('offline');
    writeRuntime(dir, '1.9.0');
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 600_000,
      fetchLatest: async () => { throw new Error('offline'); },
    });
    const diagnostic = inspectAutoUpdate(dir, { now: 600_001 });
    ok(result.result === 'failed' && diagnostic.error === 'offline', 'offline failure is contained and exposed as a diagnostic receipt');
  }

  {
    const dir = scenario('lock');
    writeRuntime(dir, '1.9.0');
    fs.writeFileSync(autoUpdatePaths(dir).lock, JSON.stringify({
      protocol: 1,
      token: 'other',
      pid: 123,
      acquiredAt: 700_000,
    }));
    let fetched = false;
    const result = await runAutoUpdateCheck({
      brainDir: dir,
      now: 700_001,
      fetchLatest: async () => { fetched = true; return '1.9.1'; },
    });
    ok(result.result === 'busy' && !fetched, 'concurrent host sessions collapse behind one machine lock');
  }

  {
    const dir = scenario('worker-trigger');
    let launch = null;
    const fakeSpawn = (command, args, options) => {
      launch = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    };
    const child = spawnAutoUpdateHelper({
      brainDir: dir,
      currentVersion: '1.5.2',
      env: {},
      spawnProcess: fakeSpawn,
    });
    ok(!!child && launch?.command === process.execPath
      && launch.options.env.KLYPIX_MCP_AUTO_UPDATE_CURRENT === '1.5.2',
    'replaceable workers can activate the detached updater behind an older supervisor');
    ok(launch.options.cwd === os.tmpdir(), 'detached checks do not hold the managed directory as their cwd');
    ok(spawnAutoUpdateHelper({
      brainDir: dir,
      env: { KLYPIX_AUTO_UPDATE: '0' },
      spawnProcess: () => { throw new Error('must not launch'); },
    }) === null, 'worker and supervisor triggers both honor the opt-out');
  }

  {
    const dir = scenario('safe-installer-spawn');
    let launch = null;
    await installExactRuntime('1.5.2', {
      brainDir: dir,
      spawnProcess: (command, args, options) => {
        launch = { command, args, options };
        const child = new EventEmitter();
        child.kill = () => {};
        setTimeout(() => child.emit('exit', 0, null), 0);
        return child;
      },
    });
    ok(launch.options.shell === false
      && launch.args.some((arg) => arg === 'klypix-mcp@1.5.2'),
    'exact-version installer never concatenates package input through a shell');
    let rejected = false;
    try {
      await installExactRuntime('1.5.2 & whoami', {
        brainDir: dir,
        spawnProcess: () => { throw new Error('must not spawn'); },
      });
    } catch { rejected = true; }
    ok(rejected, 'non-semver package input is rejected before process creation');
  }

  {
    const dir = scenario('runtime-only-installer');
    const home = path.join(dir, 'home');
    const brainDir = path.join(home, '.claude', 'project-brain');
    const project = path.join(dir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const projectConfig = path.join(project, '.mcp.json');
    fs.writeFileSync(projectConfig, '{"sentinel":"unchanged"}\n');
    const result = spawnSync(process.execPath, [
      path.join(HERE, '..', 'bin', 'klypix-install.mjs'),
      '--runtime-only',
    ], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KLYPIX_MCP_INSTALL_DIR: brainDir,
      },
      encoding: 'utf8',
      // This spawns the REAL installer, which copies the engine plus ~106
      // dependency packages: measured at 71s on the reference machine, so a
      // 120s ceiling left under 50s of headroom and turned any busy machine
      // into a red suite. The failure was also silent-by-shape — `result` was
      // never inspected, so a timeout surfaced as an ENOENT on the manifest
      // read below instead of "the installer did not finish".
      timeout: 300_000,
    });
    ok(result.status === 0, `real runtime-only installer exits 0 (status ${result.status}${result.error ? `, ${result.error.message}` : ''})`);
    const runtime = JSON.parse(fs.readFileSync(path.join(brainDir, '.mcp-runtime.json'), 'utf8'));
    const flatWorker = fs.readFileSync(path.join(brainDir, 'klypix-mcp-worker.mjs'), 'utf8');
    ok(result.status === 0 && fs.existsSync(path.join(brainDir, 'mcp-auto-update.mjs')), 'real runtime-only installer stages the updater and managed runtime atomically');
    ok(fs.readFileSync(projectConfig, 'utf8') === '{"sentinel":"unchanged"}\n'
      && !fs.existsSync(path.join(home, '.claude', 'settings.json')),
    'automatic runtime install preserves project config and host settings');
    ok(Object.prototype.hasOwnProperty.call(runtime.files, 'mcp-auto-update.mjs'), 'runtime integrity manifest covers the updater helper');
    ok(flatWorker.includes("from './mcp-auto-update.mjs'"), 'flattened worker keeps a valid local updater import');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n✓ mcp-auto-update: ${pass} assertions passed`);
