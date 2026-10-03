// Acceptance tests for the host-neutral MCP updater. All registry and installer
// seams are injected; this test never contacts npm or changes the user's brain.
// Fixtures are literal JSON written into temp dirs — never read from ~/.claude.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  AUTO_UPDATE_HARNESS_REFRESH_MS,
  AUTO_UPDATE_POLL_MS,
  AUTO_UPDATE_RECHECK_FLOOR_MS,
  AUTO_UPDATE_RETRY_MS,
  AUTO_UPDATE_TTL_MS,
  __test,
  autoUpdateDecision,
  autoUpdatePaths,
  autoUpdateSchedule,
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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEAD_PID = 2147483646;   // no such process: the owner of an abandoned lock
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
const writeRuntime = (dir, version, { dev = false, channel, installedAt } = {}) => {
  fs.writeFileSync(path.join(dir, '.mcp-runtime.json'), JSON.stringify({
    protocol: 1,
    version,
    worker: 'worker.mjs',
    dev,
    ...(channel ? { channel } : {}),
    ...(installedAt ? { installedAt } : {}),
  }));
  fs.writeFileSync(path.join(dir, '.brain-version.json'), JSON.stringify({
    brainVersion: version,
    dev,
    via: channel || (dev ? 'dev' : 'npm'),
    ...(installedAt ? { installedAt } : {}),
  }));
};
const readStamp = (dir) => JSON.parse(fs.readFileSync(autoUpdatePaths(dir).stamp, 'utf8'));
const readStatus = (dir) => JSON.parse(fs.readFileSync(autoUpdatePaths(dir).status, 'utf8'));
const installAs = (options) => async (version, { brainDir }) => writeRuntime(brainDir, version, options);
const noFetch = async () => { throw new Error('must not contact npm'); };
const noInstall = async () => { throw new Error('must not install'); };
// Policy checks name enabled/force explicitly: sandboxed suite runs set
// KLYPIX_AUTO_UPDATE=0, which would otherwise turn every case into 'disabled'.
const check = (options) => runAutoUpdateCheck({ enabled: true, force: false, currentVersion: null, ...options });
// The view a spawner gets, with the opt-out env neutralised for the same reason.
const view = (dir, now) => inspectAutoUpdate(dir, { now, env: {} });
const fakeChild = () => {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
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
    const first = await check(options);
    const second = await check({ ...options, now: 100_001 });
    ok(first.result === 'current' && fetches === 1 && installs === 0, 'current runtime checks npm once and does not install');
    ok(second.result === 'throttled' && fetches === 1, 'machine-wide 6h schedule throttles later sessions');
  }

  {
    const dir = scenario('compatible-update');
    writeRuntime(dir, '1.4.0');
    let exact = null;
    const result = await check({
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
    const result = await check({
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
      // The registrations above are stamped 10-30 ms after the epoch; reconcile
      // on the same clock so the 14-day stale-registration filter keeps them.
      now: 40,
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
    const result = await check({
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
    const result = await check({
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
    const result = await check({
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
    const result = await check({
      brainDir: dir,
      now: 500_000,
      fetchLatest: async () => { fetched = true; return '1.9.1'; },
    });
    ok(result.result === 'dev-owned' && !fetched, 'a developer-owned runtime is never overwritten');
  }

  {
    const dir = scenario('offline');
    writeRuntime(dir, '1.9.0');
    const result = await check({
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
    // A LIVE owner (this test process): since A8 a dead owner's lock is taken over.
    fs.writeFileSync(autoUpdatePaths(dir).lock, JSON.stringify({
      protocol: 1,
      token: 'other',
      pid: process.pid,
      acquiredAt: 700_000,
    }));
    let fetched = false;
    const result = await check({
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
      return fakeChild();
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

  // ── 2026-10-03: identity-aware schedule, cadence, backoff, hold, lock ──────

  {
    // A6 — cadence.
    ok(AUTO_UPDATE_TTL_MS === 6 * HOUR, 'A6: one scheduled registry check per machine per 6 h');
    ok(AUTO_UPDATE_POLL_MS === 10 * MINUTE && AUTO_UPDATE_POLL_MS <= 15 * MINUTE, 'A6: spawners poll the schedule every 10 min (local reads only)');
    const dir = scenario('ttl-boundary');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 6, 0, 0);
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.4.0' });
    // Literal 6 h, not the constant: the boundary itself is what is pinned.
    ok(!view(dir, t + 6 * HOUR - 1).due, 'A6: not due 1 ms before lastCheck + 6 h');
    const atTtl = view(dir, t + 6 * HOUR);
    ok(atTtl.due && atTtl.dueReason === 'interval', 'A6: due exactly at lastCheck + 6 h');
    const worker = fs.readFileSync(path.join(HERE, '..', 'bin', 'klypix-worker.mjs'), 'utf8').replace(/\r/g, '');
    const namespace = worker.match(/import \* as (\w+) from '\.\.\/src\/mcp-auto-update\.mjs';/)?.[1];
    ok(!!namespace && worker.includes(
      `setInterval(checkForCoreUpdate, Math.max(60_000, Number(${namespace}.AUTO_UPDATE_POLL_MS) || 60 * 60 * 1000))`),
    'A6: the worker polls at AUTO_UPDATE_POLL_MS through a namespace member with a 60-min fallback');
  }

  {
    // This PC on 2026-10-02: a dev-owned check did nothing, then an npm install
    // made the runtime npm-owned — and a 24 h stamp hid that for a day.
    const dir = scenario('dev-then-npm');
    writeRuntime(dir, '1.8.0', { dev: true });
    const t0 = Date.parse('2026-10-02T05:19:23.580Z');
    let fetched = false;
    const devResult = await check({ brainDir: dir, now: t0, fetchLatest: async () => { fetched = true; return '1.9.1'; } });
    ok(devResult.result === 'dev-owned' && !fetched, 'A5: a dev-owned runtime is recorded without fetching');
    ok(readStatus(dir).identity?.dev === true && readStamp(dir).failures === 0
      && readStamp(dir).nextCheckAt === t0 + AUTO_UPDATE_TTL_MS,
    'A2/A7: the dev-owned result records the identity it evaluated and a terminal 6 h stamp');
    writeRuntime(dir, '1.9.0', { channel: 'npm' });
    const after = view(dir, t0 + HOUR);
    ok(after.due && after.dueReason === 'install-changed' && after.stale && after.staleReason === 'left-dev-ownership',
      'A3: leaving dev ownership makes the check due at once and marks the old result stale');
    let installedVersion = null;
    const updated = await check({
      brainDir: dir,
      now: t0 + HOUR,
      fetchLatest: async () => '1.9.1',
      installVersion: async (version, { brainDir }) => { installedVersion = version; writeRuntime(brainDir, version); },
    });
    ok(updated.result === 'updated' && installedVersion === '1.9.1', 'A3: the re-opened check installs the pending release');
  }

  {
    // `npx -y klypix-mcp@latest install --force` over a dev deploy of the SAME
    // version: no version moved, only ownership — the schedule must re-open.
    const dir = scenario('dev-to-npm-same-version');
    writeRuntime(dir, '1.9.0', { dev: true });
    const t = Date.UTC(2026, 9, 3, 6, 30, 0);
    await check({ brainDir: dir, now: t, fetchLatest: noFetch });
    writeRuntime(dir, '1.9.0', { channel: 'npm' });
    const after = view(dir, t + 10 * MINUTE);
    ok(after.due && after.dueReason === 'install-changed' && after.staleReason === 'left-dev-ownership',
      'A3: returning a dev-owned runtime to npm at the same version re-opens the schedule');
  }

  {
    // Literal copies of this PC's files on 2026-10-02 (legacy, pre-identity).
    const dir = scenario('legacy-live-state');
    const files = autoUpdatePaths(dir);
    fs.writeFileSync(files.stamp, '{"protocol":1,"lastCheck":1790918363580,"checkedAt":"2026-10-02T05:19:23.580Z"}\n');
    fs.writeFileSync(files.status, '{"protocol":1,"result":"dev-owned","checkedAt":"2026-10-02T05:19:23.580Z","currentVersion":"1.86.0"}\n');
    fs.writeFileSync(files.runtime, '{"protocol":1,"version":"1.88.0","worker":"klypix-mcp-worker.mjs","channel":"npm","installedAt":"2026-10-02T14:39:15.704Z","files":{}}\n');
    fs.writeFileSync(files.version, '{"brainVersion":"1.88.0","via":"npm","dirty":false,"installedAt":"2026-10-02T14:39:15.704Z"}');
    const live = view(dir, Date.parse('2026-10-02T14:45:00.000Z'));
    ok(live.due && live.dueReason === 'install-changed' && live.stale && live.staleReason === 'left-dev-ownership',
      'A2: a legacy dev-owned status next to npm receipts is stale and due minutes after the install');
  }

  {
    // The pre-host-neutral hook wrote a bare {lastCheck} and no status: a
    // stamp nothing can attribute counts as changed ONCE, after the floor.
    const dir = scenario('unusable-status');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 6, 45, 0);
    fs.writeFileSync(autoUpdatePaths(dir).stamp, JSON.stringify({ lastCheck: t }));
    const atFloor = view(dir, t + AUTO_UPDATE_RECHECK_FLOOR_MS);
    ok(!view(dir, t + MINUTE).due && atFloor.due && atFloor.dueReason === 'install-changed',
      'A3: a legacy stamp with no usable status counts as changed once, after the floor');
    await check({ brainDir: dir, now: t + AUTO_UPDATE_RECHECK_FLOOR_MS, fetchLatest: async () => '1.4.0' });
    ok(!view(dir, t + 2 * AUTO_UPDATE_RECHECK_FLOOR_MS).due, 'A3: … and only once: the recorded identity takes over');
  }

  {
    const dir = scenario('recheck-floor');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 7, 0, 0);
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.4.0' });
    writeRuntime(dir, '1.4.1');   // installed by something other than the helper
    const early = view(dir, t + MINUTE);
    const atFloor = view(dir, t + AUTO_UPDATE_RECHECK_FLOOR_MS);
    ok(!early.due && early.dueReason === 'install-changed' && early.stale && early.staleReason === 'version-increased',
      'A3: an install change 1 min after a check waits for the 5-min floor');
    ok(atFloor.due && atFloor.dueReason === 'install-changed', 'A3: … and is due at lastCheck + 5 min');
    let launches = 0;
    const spawnProcess = () => { launches++; return fakeChild(); };
    ok(spawnAutoUpdateHelper({ brainDir: dir, env: {}, spawnProcess, now: t + MINUTE }) === null && launches === 0,
      'A3: spawners launch nothing before the floor');
    ok(!!spawnAutoUpdateHelper({ brainDir: dir, env: {}, spawnProcess, now: t + AUTO_UPDATE_RECHECK_FLOOR_MS }) && launches === 1,
      'A3: spawners launch the helper once the install change is due');
  }

  {
    const dir = scenario('no-self-trigger');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 8, 0, 0);
    const result = await check({ brainDir: dir, now: t, fetchLatest: async () => '1.5.0', installVersion: installAs() });
    const later = view(dir, t + 6 * MINUTE);
    ok(result.result === 'updated' && readStatus(dir).identity?.version === '1.5.0' && readStamp(dir).identity?.version === '1.5.0',
      'A2: an update records the VERIFIED identity in the status and the stamp');
    ok(!later.due && !later.stale && later.dueReason === 'interval', "A3: the helper's own install never reads as a change (no self-trigger)");
  }

  {
    const dir = scenario('desktop-reinstall');
    writeRuntime(dir, '1.4.0', { channel: 'npm', installedAt: '2026-10-03T07:00:00.000Z' });
    const t = Date.UTC(2026, 9, 3, 9, 0, 0);
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.4.0' });
    // The desktop installer self-heals at an EQUAL version on every launch.
    writeRuntime(dir, '1.4.0', { channel: 'app', installedAt: '2026-10-03T09:02:00.000Z' });
    const later = view(dir, t + 6 * MINUTE);
    ok(!later.due && !later.stale && later.installedIdentity?.channel === 'app',
      'A1: channel and installedAt are display-only — an equal-version desktop re-install triggers nothing');
  }

  {
    const dir = scenario('unreadable-receipt');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 10, 0, 0);
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.4.0' });
    fs.writeFileSync(autoUpdatePaths(dir).runtime, '{"protocol":1,"version":"1.4');   // a non-atomic writer, mid-write
    const torn = view(dir, t + 6 * MINUTE);
    ok(torn.installedIdentity?.unknown === true && !torn.stale && !torn.due,
      'A1: a receipt that exists but cannot be read is unknown, never a change');
    let fetched = false, installed = false;
    const forced = await check({
      brainDir: dir,
      now: t + 7 * MINUTE,
      force: true,
      fetchLatest: async () => { fetched = true; return '1.5.0'; },
      installVersion: async () => { installed = true; },
    });
    ok(forced.result === 'failed' && /unreadable/.test(forced.error) && !fetched && !installed,
      'A1: the helper never fetches or installs over receipts it cannot read');
  }

  {
    const dir = scenario('unmanaged-ahead-schedule');
    const t = Date.UTC(2026, 9, 3, 11, 0, 0);
    const result = await check({ brainDir: dir, currentVersion: '1.6.0', now: t, fetchLatest: async () => '1.5.2', installVersion: noInstall });
    ok(result.result === 'ahead' && readStatus(dir).identity?.version === null,
      "A1: the recorded identity comes from the receipts only, never the caller's version");
    const plus6 = view(dir, t + 6 * MINUTE);
    const plus60 = view(dir, t + 60 * MINUTE);
    ok(!plus6.due && !plus60.due && !plus6.stale && !plus60.stale,
      "A1: an unmanaged 'ahead' run is not due at +6 min or +60 min (no npm query per poll)");
    writeRuntime(dir, '1.5.2');   // then the released runtime is installed by hand
    const managedNow = view(dir, t + 61 * MINUTE);
    ok(managedNow.due && managedNow.dueReason === 'install-changed' && managedNow.staleReason === 'became-managed',
      'A3: unmanaged → managed re-opens the schedule');
  }

  {
    const dir = scenario('downgrade-hold');
    writeRuntime(dir, '1.9.0');
    const t = Date.UTC(2026, 9, 3, 12, 0, 0);
    const installs = [];
    const install = async (version, { brainDir }) => { installs.push(version); writeRuntime(brainDir, version); };
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.9.1', installVersion: install });
    writeRuntime(dir, '1.9.0');   // npx -y klypix-mcp@1.9.0 install --runtime-only --force
    const soon = view(dir, t + 6 * MINUTE);
    ok(!soon.due && soon.stale && soon.staleReason === 'manual-downgrade',
      'A3: a deliberate --force downgrade is not due at +6 min (reported as manual-downgrade)');
    const held = await check({ brainDir: dir, now: t + AUTO_UPDATE_TTL_MS, fetchLatest: async () => '1.9.1', installVersion: install });
    ok(held.result === 'held' && readStatus(dir).hold?.version === '1.9.1' && installs.length === 1,
      'A4: the next scheduled check holds the rolled-back-from version instead of re-installing it');
    ok(view(dir, t + AUTO_UPDATE_TTL_MS + MINUTE).decision === 'held', 'A5: the doctor/hook view states the same hold');
    const again = await check({ brainDir: dir, now: t + 2 * AUTO_UPDATE_TTL_MS, fetchLatest: async () => '1.9.1', installVersion: install });
    ok(again.result === 'held' && installs.length === 1, 'A4: the hold survives later checks');
    const newer = await check({ brainDir: dir, now: t + 3 * AUTO_UPDATE_TTL_MS, fetchLatest: async () => '1.9.2', installVersion: install });
    ok(newer.result === 'updated' && installs.at(-1) === '1.9.2' && !readStatus(dir).hold,
      'A4: a newer publish installs normally and clears the hold');
  }

  {
    const dir = scenario('hold-force');
    writeRuntime(dir, '1.9.0');
    const t = Date.UTC(2026, 9, 3, 13, 0, 0);
    const installs = [];
    const install = async (version, { brainDir }) => { installs.push(version); writeRuntime(brainDir, version); };
    await check({ brainDir: dir, now: t, fetchLatest: async () => '1.9.1', installVersion: install });
    writeRuntime(dir, '1.9.0');
    await check({ brainDir: dir, now: t + AUTO_UPDATE_TTL_MS, fetchLatest: async () => '1.9.1', installVersion: install });
    const forced = await check({ brainDir: dir, now: t + AUTO_UPDATE_TTL_MS + MINUTE, force: true, fetchLatest: async () => '1.9.1', installVersion: install });
    ok(forced.result === 'updated' && installs.at(-1) === '1.9.1' && installs.length === 2 && !readStatus(dir).hold,
      'A4: KLYPIX_AUTO_UPDATE_FORCE=1 bypasses the hold');
  }

  {
    const table = [
      [{ version: '1.9.0', managed: true, dev: true }, '2.0.0', null, 'dev-owned'],
      [{ version: '1.9.0', managed: true, dev: false }, '2.0.0', null, 'major-blocked'],
      [{ version: '1.9.0', managed: false, dev: false }, '2.0.0', null, 'major-blocked'],
      [{ version: '1.4.0', managed: true, dev: false }, '1.5.0', null, 'install'],
      [{ version: '1.5.0', managed: true, dev: false }, '1.5.0', null, 'current'],
      [{ version: '1.5.0', managed: false, dev: false }, '1.5.0', null, 'install'],
      [{ version: null, managed: false, dev: false }, '1.5.0', null, 'install'],
      [{ version: '1.6.0', managed: false, dev: false }, '1.5.2', null, 'ahead'],
      [{ version: '2.0.0', managed: true, dev: false }, '1.9.0', null, 'ahead'],
      [{ version: '1.8.0', managed: true, dev: false }, '1.9.0', { version: '1.9.0' }, 'held'],
      [{ version: '1.8.0', managed: true, dev: false }, '1.9.1', { version: '1.9.0' }, 'install'],
      [{ version: '1.8.0', managed: true, dev: false }, 'not-semver', null, 'unknown'],
      [{ unknown: true }, '1.9.0', null, 'unknown'],
    ];
    const wrong = table.filter(([installed, latestVersion, hold, expected]) =>
      autoUpdateDecision({ installed, latestVersion, hold }) !== expected);
    ok(wrong.length === 0, `A5: autoUpdateDecision table — dev, major (managed or not), install, current, bootstrap, ahead, held, unknown${wrong.length ? ` (wrong: ${JSON.stringify(wrong)})` : ''}`);
    const dir = scenario('unmanaged-major');
    let installed = false;
    const result = await check({
      brainDir: dir,
      currentVersion: '1.9.0',
      now: Date.UTC(2026, 9, 3, 14, 0, 0),
      fetchLatest: async () => '2.0.0',
      installVersion: async () => { installed = true; },
    });
    ok(result.result === 'major-blocked' && !installed, 'A5: the major gate applies to an unmanaged (direct-package) runtime too');
  }

  {
    const dir = scenario('change-respects-backoff');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 15, 0, 0);
    await check({ brainDir: dir, now: t, fetchLatest: async () => { throw new Error('offline'); } });
    writeRuntime(dir, '1.4.1');
    const during = view(dir, t + 6 * MINUTE);
    const atRetry = view(dir, t + AUTO_UPDATE_RETRY_MS[0]);
    ok(!during.due && during.failures === 1 && during.dueReason === 'retry' && during.stale,
      'A3: an install change never bypasses a pending failure backoff');
    ok(atRetry.due, 'A3: … the retry still runs at its backoff time');
  }

  {
    const dir = scenario('total-scheduler');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 16, 0, 0);
    const files = autoUpdatePaths(dir);
    const matching = { result: 'current', currentVersion: '1.4.0', identity: { version: '1.4.0', managed: true, dev: false } };
    const cases = [
      ['lastCheck 1e20', { lastCheck: 1e20 }, matching, 'invalid-stamp'],
      ['lastCheck two days ahead', { lastCheck: t + 2 * DAY }, matching, 'invalid-stamp'],
      ["nextCheckAt 'x'", { lastCheck: t - MINUTE, nextCheckAt: 'x' }, matching, 'invalid-stamp'],
      ['nextCheckAt two days ahead', { lastCheck: t - MINUTE, nextCheckAt: t + 2 * DAY }, matching, 'invalid-stamp'],
      ['failures -1', { lastCheck: t - 7 * HOUR, failures: -1 }, matching, 'interval'],
      ['status identity null', { lastCheck: t - 7 * HOUR }, { result: 'current', currentVersion: '1.4.0', identity: null }, 'interval'],
      ["stamp '[]'", [], matching, 'invalid-stamp'],
    ];
    for (const [label, stamp, status, reason] of cases) {
      fs.writeFileSync(files.stamp, JSON.stringify(stamp));
      fs.writeFileSync(files.status, JSON.stringify(status));
      let seen = null, spawned = null, threw = null;
      try {
        seen = view(dir, t);
        spawned = spawnAutoUpdateHelper({ brainDir: dir, env: {}, now: t, spawnProcess: fakeChild });
      } catch (error) { threw = error; }
      ok(!threw && seen?.due && seen.dueReason === reason && !!spawned && !seen.scheduleError,
        `A3: ${label} never throws from inspect/spawn and is due (${reason})`);
    }
    fs.writeFileSync(files.stamp, JSON.stringify({ lastCheck: t - MINUTE, failures: 0, nextCheckAt: t + 6 * HOUR }));
    fs.writeFileSync(files.status, JSON.stringify(matching));
    fs.writeFileSync(files.lock, JSON.stringify({ protocol: 1, token: 'future', pid: process.pid, acquiredAt: t + 2 * DAY }));
    const futureLock = view(dir, t);
    ok(futureLock.due && futureLock.dueReason === 'invalid-stamp' && futureLock.inProgress === null,
      'A3: a lock dated more than a day ahead is invalid, not an owner');
    fs.rmSync(files.lock, { force: true });
    let threw = null;
    try {
      autoUpdateSchedule();
      autoUpdateSchedule({ stamp: { lastCheck: 'soon', failures: 'many' }, status: 42, installed: 'x', lock: { acquiredAt: -5 }, now: NaN, ttlMs: -1 });
      autoUpdateSchedule({ stamp: { lastCheck: t, nextCheckAt: t }, status: { identity: { version: 7 } }, installed: { version: 'x' }, now: t });
    } catch (error) { threw = error; }
    ok(!threw, 'A3: autoUpdateSchedule is total over arbitrary input');
  }

  {
    const dir = scenario('in-progress');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 17, 0, 0);
    const files = autoUpdatePaths(dir);
    const writeLock = (pid, acquiredAt) => fs.writeFileSync(files.lock, JSON.stringify({ protocol: 1, token: `${pid}-holder`, pid, acquiredAt }));
    writeLock(process.pid, t - MINUTE);
    const live = view(dir, t);
    let launches = 0;
    const spawned = spawnAutoUpdateHelper({ brainDir: dir, env: {}, now: t, spawnProcess: () => { launches++; return fakeChild(); } });
    ok(!live.due && live.inProgress?.pid === process.pid && spawned === null && launches === 0,
      'A3: not due while a live helper holds the lock — spawners stop launching helpers that would only be busy');
    writeLock(DEAD_PID, t - MINUTE);
    ok(view(dir, t).due && view(dir, t).inProgress === null, 'A3: a lock left by a dead helper does not hold the schedule');
    writeLock(process.pid, t - 3 * HOUR);
    ok(view(dir, t).due, 'A3: a live-looking owner older than 2 h no longer holds it (pid reuse / hung backstop)');
  }

  {
    const dir = scenario('pre-stamp');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 18, 0, 0);
    let seen = null;
    const result = await check({
      brainDir: dir,
      now: t,
      fetchLatest: async () => { seen = readStamp(dir); return '1.5.0'; },
      installVersion: async () => { throw new Error('EPERM: rename .mcp-runtime.json'); },
    });
    ok(seen?.failures === 1 && seen.nextCheckAt === t + AUTO_UPDATE_RETRY_MS[0] && seen.inProgress?.pid === process.pid,
      'A7: before any network call the attempt is stamped as FAILED (+15 min, inProgress)');
    const status = readStatus(dir);
    ok(result.result === 'failed' && status.latestVersion === '1.5.0' && status.attempt === 1
      && status.nextRetryAt === new Date(t + AUTO_UPDATE_RETRY_MS[0]).toISOString(),
    'A7: a failed install keeps the fetched latestVersion, the attempt number and the retry time');
    ok(readStamp(dir).failures === 1 && readStamp(dir).inProgress === null, 'A7: the failed outcome keeps the incremented count');
    const recovered = await check({ brainDir: dir, now: t + AUTO_UPDATE_RETRY_MS[0], fetchLatest: async () => '1.5.0', installVersion: installAs() });
    ok(recovered.result === 'updated' && readStamp(dir).failures === 0
      && readStamp(dir).nextCheckAt === t + AUTO_UPDATE_RETRY_MS[0] + AUTO_UPDATE_TTL_MS,
    'A7: a terminal outcome resets failures to 0 and schedules now + 6 h');
  }

  {
    // A helper that DIES after the pre-stamp (sleep, shutdown, AV, the npx
    // timeout) must escalate, never retry every 15 min forever. Real child
    // processes: each one exits inside fetchLatest, leaving its lock behind.
    const dir = scenario('dying-helper');
    writeRuntime(dir, '1.4.0');
    const driver = path.join(root, 'dying-helper-driver.mjs');
    const moduleUrl = pathToFileURL(path.join(HERE, '..', 'src', 'mcp-auto-update.mjs')).href;
    // The child records what it saw with a synchronous file write: stdout to a
    // pipe is not guaranteed to flush before process.exit().
    fs.writeFileSync(driver, [
      "import fs from 'fs';",
      `import { autoUpdatePaths, runAutoUpdateCheck } from ${JSON.stringify(moduleUrl)};`,
      'const [dir, now, observed] = [process.argv[2], Number(process.argv[3]), process.argv[4]];',
      'await runAutoUpdateCheck({',
      '  brainDir: dir, now, enabled: true, force: false, currentVersion: null,',
      '  fetchLatest: async () => { fs.copyFileSync(autoUpdatePaths(dir).stamp, observed); process.exit(9); },',
      '});',
    ].join('\n'));
    let t = Date.UTC(2026, 9, 3, 19, 0, 0);
    const intervals = [];
    const earlyDue = [];
    const onTimeDue = [];
    for (let round = 1; round <= 5; round++) {
      const observed = path.join(root, `dying-helper-round-${round}.json`);
      const run = spawnSync(process.execPath, [driver, dir, String(t), observed], { encoding: 'utf8', timeout: 60_000 });
      let stamp = null;
      try { stamp = JSON.parse(fs.readFileSync(observed, 'utf8')); } catch { /* reported below */ }
      if (run.status !== 9 || stamp?.failures !== round) {
        ok(false, `A7: helper round ${round} died after its pre-stamp (exit ${run.status}, ${String(run.stderr || '').slice(0, 160)})`);
        break;
      }
      intervals.push(stamp.nextCheckAt - stamp.lastCheck);
      earlyDue.push(view(dir, stamp.nextCheckAt - 1).due);
      onTimeDue.push(view(dir, stamp.nextCheckAt).due);
      t = stamp.nextCheckAt;
    }
    ok(JSON.stringify(intervals) === JSON.stringify([15 * MINUTE, HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR]),
      `A7: a helper that dies after the pre-stamp escalates 15m → 1h → 4h → 6h (${intervals.map((ms) => `${ms / MINUTE}m`).join(' → ')})`);
    ok(intervals.length === 5 && intervals.every((ms, i) => i === 0 || ms >= intervals[i - 1]), 'A7: the backoff never shrinks');
    ok(earlyDue.length === 5 && earlyDue.every((due) => !due) && onTimeDue.every(Boolean),
      "A7: each retry is due on time and not a moment early — the dead helper's lock never blocks it");
  }

  {
    const dir = scenario('lock-semantics');
    writeRuntime(dir, '1.9.0');
    const t = Date.UTC(2026, 9, 3, 20, 0, 0);
    const files = autoUpdatePaths(dir);
    const writeLock = (pid, acquiredAt) => fs.writeFileSync(files.lock, JSON.stringify({ protocol: 1, token: `${pid}-holder`, pid, acquiredAt }));
    writeLock(DEAD_PID, t - 1000);
    const taken = await check({ brainDir: dir, now: t, fetchLatest: async () => '1.9.0' });
    ok(taken.result === 'current' && !fs.existsSync(files.lock), 'A8: a lock whose owner pid is dead is taken over at once');
    writeLock(process.pid, t - 1000);
    const live = await check({ brainDir: dir, now: t, force: true, fetchLatest: noFetch });
    ok(live.result === 'busy', 'A8: a live owner keeps its lock');
    const EPERM_PID = 4242424;
    const realKill = process.kill;
    process.kill = (pid, signal) => {
      if (pid === EPERM_PID) { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; }
      return realKill.call(process, pid, signal);
    };
    try {
      writeLock(EPERM_PID, t - 1000);
      const eperm = await check({ brainDir: dir, now: t, force: true, fetchLatest: noFetch });
      ok(eperm.result === 'busy', 'A8: EPERM from kill(pid, 0) counts as alive');
    } finally { process.kill = realKill; }
    writeLock(process.pid, t - 3 * HOUR);
    const hung = await check({ brainDir: dir, now: t, force: true, fetchLatest: async () => '1.9.0' });
    ok(hung.result === 'current', 'A8: a live-looking owner older than 2 h is taken over (pid reuse / hung backstop)');
  }

  {
    const dir = scenario('awaited-finalize');
    writeRuntime(dir, '1.4.0');
    const t = Date.UTC(2026, 9, 3, 21, 0, 0);
    const files = autoUpdatePaths(dir);
    let lockDuringReconcile = null;
    await check({
      brainDir: dir,
      now: t,
      fetchLatest: async () => '1.5.0',
      installVersion: installAs(),
      reconcileProjects: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lockDuringReconcile = fs.existsSync(files.lock);
        return { checked: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, projects: [] };
      },
    });
    ok(lockDuringReconcile === true && !fs.existsSync(files.lock),
      'A9: the machine lock is held through the harness pass and the status write, then released');
    const broken = scenario('status-write-fails');
    writeRuntime(broken, '1.4.0');
    fs.mkdirSync(autoUpdatePaths(broken).status);   // every rename onto the status path now fails
    let outcome = null, rejected = null;
    try {
      outcome = await check({ brainDir: broken, now: t, fetchLatest: async () => '1.5.0', installVersion: installAs() });
    } catch (error) { rejected = error; }
    ok(!rejected && outcome?.result === 'updated' && !!outcome.recordError,
      'A9: a failed status write after a good install is reported, never thrown');
    ok(readStamp(broken).failures === 1 && readStamp(broken).inProgress === null,
      'A9: an unrecorded outcome keeps the attempt counted, so the next check redoes it');
  }

  {
    const dir = scenario('atomic-json');
    const target = path.join(dir, 'status.json');
    const realRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (from, to) => {
      attempts++;
      if (attempts <= 2) { const error = new Error('EPERM: simulated reader hold'); error.code = 'EPERM'; throw error; }
      return realRename.call(fs, from, to);
    };
    let threw = null;
    try { __test.atomicJson(target, { committed: true }); }
    catch (error) { threw = error; }
    finally { fs.renameSync = realRename; }
    ok(!threw && attempts === 3 && JSON.parse(fs.readFileSync(target, 'utf8')).committed === true,
      'A10: a transient EPERM on the rename is outlasted and the file is committed');
    attempts = 0;
    fs.renameSync = () => { attempts++; const error = new Error('ENOENT: gone'); error.code = 'ENOENT'; throw error; };
    threw = null;
    try { __test.atomicJson(target, { committed: false }); }
    catch (error) { threw = error; }
    finally { fs.renameSync = realRename; }
    ok(threw?.code === 'ENOENT' && attempts === 1 && fs.readdirSync(dir).every((name) => !name.endsWith('.tmp')),
      'A10: a non-retryable error is rethrown at once and the staged tmp is removed');
  }

  {
    const dir = scenario('dev-deploy-race');
    writeRuntime(dir, '1.9.0');
    const result = await check({
      brainDir: dir,
      now: Date.UTC(2026, 9, 3, 22, 0, 0),
      fetchLatest: async () => '1.9.1',
      // brain:deploy (dev:true, no install lock) lands during the fetch window.
      installVersion: installAs({ dev: true }),
    });
    ok(result.result === 'dev-owned' && readStatus(dir).identity?.dev === true
      && readStamp(dir).identity?.dev === true && readStamp(dir).failures === 0,
    'A11: a dev deploy that wins the race is recorded as dev-owned, never updated');
  }

  {
    const dir = scenario('harness-gating');
    writeRuntime(dir, '1.5.2');
    const t = Date.UTC(2026, 9, 4, 0, 0, 0);
    const passes = [];
    let hash = 'aaaa1111';
    let latest = '1.5.2';
    const run = (now, extra = {}) => check({
      brainDir: dir,
      now,
      fetchLatest: async () => latest,
      installVersion: installAs(),
      loadRules: async () => ({ INSTRUCTIONS_HASH: hash }),
      reconcileProjects: async ({ version }) => {
        passes.push({ now, version });
        return { checked: 1, updated: 0, unchanged: 1, failed: 0, skipped: 0, projects: [] };
      },
      ...extra,
    });
    await run(t);
    await run(t + AUTO_UPDATE_TTL_MS);
    ok(passes.length === 1 && readStatus(dir).harness?.checkedAt === new Date(t).toISOString()
      && readStatus(dir).harness?.instructionsHash === 'aaaa1111',
    'A12: an unchanged runtime does not re-run the harness pass at every 6 h check (the last receipt is kept)');
    hash = 'bbbb2222';
    await run(t + 2 * AUTO_UPDATE_TTL_MS);
    ok(passes.length === 2, 'A12: changed managed instructions re-run the pass');
    await run(t + 3 * AUTO_UPDATE_TTL_MS);
    await run(t + 2 * AUTO_UPDATE_TTL_MS + AUTO_UPDATE_HARNESS_REFRESH_MS);
    ok(passes.length === 3, 'A12: an otherwise unchanged runtime is re-checked once a day');
    writeRuntime(dir, '1.5.3');   // installed by hand: identity changed
    latest = '1.5.3';
    const changedAt = t + 2 * AUTO_UPDATE_TTL_MS + AUTO_UPDATE_HARNESS_REFRESH_MS + AUTO_UPDATE_RECHECK_FLOOR_MS;
    await run(changedAt);
    ok(passes.length === 4 && passes.at(-1).version === '1.5.3', 'A12: a changed installed identity re-runs the pass');
    latest = '1.5.4';
    await run(changedAt + AUTO_UPDATE_TTL_MS);
    ok(passes.length === 5 && passes.at(-1).version === '1.5.4', 'A12: an install by the helper always runs the pass');
  }

  {
    const dir = scenario('stale-registrations');
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    const fresh = path.join(dir, 'fresh');
    const stale = path.join(dir, 'stale');
    for (const project of [fresh, stale]) {
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, 'brain.klypix'), 'placeholder brain');
    }
    registerProjectBrain({ brainPath: path.join(fresh, 'brain.klypix'), brainDir: dir, now: now - DAY });
    registerProjectBrain({ brainPath: path.join(stale, 'brain.klypix'), brainDir: dir, now: now - 15 * DAY });
    const rules = { auditProject, compactAgentsBrief, linkProject };
    const bulk = await reconcileRegisteredProjects({ brainDir: dir, version: '1.5.2', now, rules });
    ok(bulk.checked === 2 && bulk.updated === 1 && bulk.skipped === 1
      && bulk.projects.find((item) => item.project === 'stale')?.reason === 'stale-registration'
      && bulk.skippedReasons?.['stale-registration'] === 1
      && !fs.existsSync(path.join(stale, 'AGENTS.md')),
    'A12: the bulk pass skips registrations unseen for 14 days and reports them as stale-registration');
    const named = await reconcileRegisteredProjects({ brainDir: dir, version: '1.5.2', now, rules, brainPaths: [path.join(stale, 'brain.klypix')] });
    ok(named.updated === 1 && fs.existsSync(path.join(stale, 'AGENTS.md')),
      "A12: a project named explicitly (brain_sync's own) is reconciled however old its registration");
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
        // This spawns the REAL installer from the source checkout, which is
        // only tagged at release commits — acknowledge the released-tag
        // deploy guard (its own behavior is locked by test/released-tag-guard.mjs).
        KLYPIX_MCP_ALLOW_UNTAGGED: '1',
      },
      encoding: 'utf8',
      // This spawns the REAL installer, which copies the engine plus ~106
      // dependency packages: measured at 71s on the reference machine, so a
      // 120s ceiling left under 50s of headroom and turned any busy machine
      // into a red suite. The failure was also silent-by-shape — `result` was
      // never inspected, so a timeout surfaced as an ENOENT on the manifest
      // read below instead of "the installer did not finish".
      // 2026-08-14: 300s ETIMEDOUT twice in a row on a machine running six
      // concurrent agent sessions (AV scanning every copied package). The
      // ceiling exists only to catch a HUNG installer, not to race ambient
      // load — 600s still catches hangs and stops red suites nobody caused.
      timeout: 600_000,
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
