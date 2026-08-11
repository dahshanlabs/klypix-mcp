// Shared install-version policy for every klypix-mcp delivery channel.
// App versions and timestamps are provenance only; Brain Core semver is the
// sole payload identity used by the never-downgrade gate.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseBrainVersion(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = SEMVER.exec(raw);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^(0|[1-9]\d*)$/.test(part)
      ? { numeric: true, value: BigInt(part) }
      : { numeric: false, value: part }))
    : [];
  return {
    raw,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < count; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (!left) return -1;
    if (!right) return 1;
    if (left.numeric && right.numeric && left.value !== right.value) return left.value > right.value ? 1 : -1;
    if (left.numeric !== right.numeric) return left.numeric ? -1 : 1;
    if (left.value !== right.value) return String(left.value) > String(right.value) ? 1 : -1;
  }
  return 0;
}

export function compareBrainVersions(a, b) {
  const left = parseBrainVersion(a);
  const right = parseBrainVersion(b);
  if (!left || !right) return null;
  return compareParsed(left, right);
}

export function highestInstalledBrainVersion({ stamp, runtime } = {}) {
  const candidates = [stamp?.brainVersion, runtime?.version]
    .map(parseBrainVersion)
    .filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((highest, candidate) => compareParsed(candidate, highest) > 0 ? candidate : highest).raw;
}

export function brainInstallDecision({ candidateVersion, stamp, runtime, force = false } = {}) {
  const candidate = parseBrainVersion(candidateVersion);
  if (!candidate) return { action: 'refuse', reason: 'invalid-candidate', candidateVersion: String(candidateVersion || '') };
  if (force) return { action: 'install', reason: 'forced', candidateVersion: candidate.raw };
  if (stamp?.dev === true) return { action: 'preserve', reason: 'dev-owned', candidateVersion: candidate.raw };
  const installedVersion = highestInstalledBrainVersion({ stamp, runtime });
  if (!installedVersion) return { action: 'install', reason: 'unknown-installed', candidateVersion: candidate.raw };
  if (compareBrainVersions(installedVersion, candidate.raw) > 0) {
    return { action: 'preserve', reason: 'newer-installed', installedVersion, candidateVersion: candidate.raw };
  }
  return {
    action: 'install',
    reason: compareBrainVersions(installedVersion, candidate.raw) === 0 ? 'self-heal' : 'upgrade',
    installedVersion,
    candidateVersion: candidate.raw,
  };
}
