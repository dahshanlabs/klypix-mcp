import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  brainInstallDecision,
  compareBrainVersions,
  highestInstalledBrainVersion,
  parseBrainVersion,
} from '../src/install-version.mjs';
import { acquireInstallLockSync, releaseInstallLockSync } from '../src/install-lock.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};

ok(parseBrainVersion('1.66.0')?.raw === '1.66.0', 'stable Brain Core semver parses');
ok(compareBrainVersions('1.66.0-beta.2', '1.66.0-beta.11') < 0, 'numeric prerelease identifiers compare numerically');
ok(compareBrainVersions('1.66.0', '1.66.0-rc.1') > 0, 'stable release sorts above prerelease');
ok(compareBrainVersions('01.66.0', '1.66.0') === null, 'invalid semver is rejected instead of coerced');

ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { brainVersion: '1.67.0' } }).action === 'preserve',
  'newer npm/app stamp is preserved');
ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { brainVersion: '1.66.0' } }).reason === 'self-heal',
  'equal version is allowed to self-heal');
ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { brainVersion: '1.65.0' } }).reason === 'upgrade',
  'older version is upgraded');
ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { brainVersion: '1.65.0', appVersion: '99.0.0', via: 'app' } }).action === 'install',
  'appVersion provenance cannot block a Brain Core upgrade');
ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { brainVersion: '1.0.0', dev: true } }).reason === 'dev-owned',
  'dev-owned runtime is preserved');
ok(brainInstallDecision({ candidateVersion: 'not-a-version', stamp: { brainVersion: '1.0.0' } }).action === 'refuse',
  'invalid candidate fails closed');
ok(highestInstalledBrainVersion({ stamp: { brainVersion: '1.65.0' }, runtime: { version: '1.67.0' } }) === '1.67.0',
  'highest valid stamp/runtime version wins');
ok(brainInstallDecision({ candidateVersion: '1.66.0', stamp: { appVersion: '1.3.999', via: 'app' }, runtime: { version: '1.67.0' } }).action === 'preserve',
  'legacy app-only stamp falls back to the committed runtime version');

const installerSource = fs.readFileSync(new URL('../bin/klypix-install.mjs', import.meta.url), 'utf8');
ok(installerSource.indexOf('const installLock = acquireInstallLockSync(BRAIN_DIR)')
  < installerSource.indexOf('const decision = brainInstallDecision('),
  'the real npm installer acquires the shared lock before reading its version verdict');

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-install-lock-'));
try {
  const first = acquireInstallLockSync(lockDir, { tries: 1 });
  const second = acquireInstallLockSync(lockDir, { tries: 1, waitMs: 1 });
  ok(Boolean(first) && second === null, 'shared install lock serializes contenders');
  const lockFile = path.join(lockDir, '.install.lock');
  const replacement = { protocol: 1, pid: 999999, token: 'replacement-owner', acquiredAt: Date.now() };
  fs.writeFileSync(lockFile, JSON.stringify(replacement));
  ok(releaseInstallLockSync(first) === false && fs.existsSync(lockFile), 'an old owner cannot release a replacement owner\'s lock');
} finally {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-install-race-'));
try {
  const newerInstaller = acquireInstallLockSync(raceDir, { tries: 1 });
  ok(Boolean(newerInstaller), 'newer installer owns the shared commit boundary');
  ok(acquireInstallLockSync(raceDir, { tries: 1, waitMs: 1 }) === null,
    'queued older installer cannot read or write through the held boundary');
  const committedStamp = { brainVersion: '1.67.0', via: 'npm' };
  const committedRuntime = { version: '1.67.0' };
  releaseInstallLockSync(newerInstaller);
  const olderInstaller = acquireInstallLockSync(raceDir, { tries: 1 });
  const queuedDecision = brainInstallDecision({ candidateVersion: '1.66.0', stamp: committedStamp, runtime: committedRuntime });
  ok(Boolean(olderInstaller) && queuedDecision.action === 'preserve',
    'an older installer re-checking after the lock preserves the newer committed runtime');
  releaseInstallLockSync(olderInstaller);
} finally {
  fs.rmSync(raceDir, { recursive: true, force: true });
}

const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-install-stale-'));
try {
  const lockFile = path.join(staleDir, '.install.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ protocol: 1, pid: 999999, token: 'dead-owner', acquiredAt: 1 }));
  const reclaimed = acquireInstallLockSync(staleDir, { tries: 2, waitMs: 1, staleMs: 1 });
  ok(Boolean(reclaimed), 'a stale lock whose owner is gone can be reclaimed');
  releaseInstallLockSync(reclaimed);
  fs.writeFileSync(lockFile, JSON.stringify({ protocol: 1, pid: process.pid, token: 'live-owner', acquiredAt: 1 }));
  ok(acquireInstallLockSync(staleDir, { tries: 1, waitMs: 1, staleMs: 1 }) === null,
    'an old-looking lock is never stolen from a live owner');
} finally {
  fs.rmSync(staleDir, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} install-version assertion(s) failed` : '\n✓ install-version policy: all assertions passed');
process.exit(failures ? 1 : 0);
