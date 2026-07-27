// Acceptance tests for the host-neutral MCP updater. All registry and installer
// seams are injected; this test never contacts npm or changes the user's brain.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  autoUpdatePaths,
  inspectAutoUpdate,
  runAutoUpdateCheck,
} from '../src/mcp-auto-update.mjs';

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
      timeout: 120_000,
    });
    const runtime = JSON.parse(fs.readFileSync(path.join(brainDir, '.mcp-runtime.json'), 'utf8'));
    ok(result.status === 0 && fs.existsSync(path.join(brainDir, 'mcp-auto-update.mjs')), 'real runtime-only installer stages the updater and managed runtime atomically');
    ok(fs.readFileSync(projectConfig, 'utf8') === '{"sentinel":"unchanged"}\n'
      && !fs.existsSync(path.join(home, '.claude', 'settings.json')),
    'automatic runtime install preserves project config and host settings');
    ok(Object.prototype.hasOwnProperty.call(runtime.files, 'mcp-auto-update.mjs'), 'runtime integrity manifest covers the updater helper');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n✓ mcp-auto-update: ${pass} assertions passed`);
