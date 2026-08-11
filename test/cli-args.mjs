// CLI ARGV CONTRACT + presence-correctness regression suite.
//
// Why this file exists: until 2026-07-30 NO test in the suite spawned a bin, which
// is exactly why a P0 survived to v1.43.1 — `bin/klypix-link.mjs` parsed
// `process.argv.slice(3)`, correct only behind the `klypix-mcp link` dispatcher.
// Run as its own published bin (`npx -p klypix-mcp klypix-link --check`) the flag
// was DROPPED: it wrote all 14 managed project files and exited 0, so a CI drift
// gate rewrote the working tree and passed unconditionally, and
// `klypix-link <dir>` wrote into the cwd instead of <dir>.
//
// The load-bearing assertions here are:
//   A  `--check` creates ZERO files (tree hash unchanged), exits 1 on drift, 0 clean.
//   B  a positional directory argument is honoured; the cwd is left untouched.
//   C  PARITY — standalone bin and dispatcher produce identical stdout, exit code
//      and on-disk result for every verb. This catches the whole class, not one bug.
//   D  write mode fails loudly when a managed target could not be wired.
//   E-I every other bin that was touched still honours its flags.
//   J-L the two silent presence bugs found while specifying the team plane.
//
// Hermetic: temp fixtures under the OS temp dir, a throwaway HOME and
// KLYPIX_MCP_INSTALL_DIR for every spawn (never the developer's real ~/.claude).
// Run:  node test/cli-args.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findPresenceConflicts, isSuspectedTwin } from '../src/mcp-presence.mjs';
import { laneFileFor, upsertSession } from '../src/agent-presence.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (name) => path.join(REPO, 'bin', name);
const MCP = BIN('klypix-mcp.mjs');
const LINK = BIN('klypix-link.mjs');
const DOCTOR = BIN('klypix-doctor.mjs');
const CONFORMANCE = BIN('klypix-conformance.mjs');
const INSTALL = BIN('klypix-install.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } };
const tmp = (tag) => {
  const p = path.join(os.tmpdir(), `klypix-cliargs-${tag}`);
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

// Content-addressed tree snapshot: the ONLY honest way to assert "--check wrote
// nothing" is that every path and every byte is identical afterwards.
const walk = (dir, base, out) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) { out.push(`${rel}/`); walk(full, base, out); }
    else if (entry.isFile()) out.push(`${rel} ${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`);
  }
  return out;
};
const snap = (dir) => walk(dir, dir, []).join('\n');

const HOME_ROOT = tmp('home');
const run = (args, { cwd = REPO, home = HOME_ROOT, timeout = 60_000 } = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    input: '',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KLYPIX_MCP_INSTALL_DIR: path.join(home, 'bundle'),
      KLYPIX_AUTO_UPDATE: '0',
    },
  });
  return {
    code: result.status,
    out: String(result.stdout || ''),
    err: String(result.stderr || ''),
  };
};

// ── A — `--check` from the STANDALONE bin audits; it must never write ─────────
{
  const project = tmp('a-project');
  const before = snap(project);
  const audit = run([LINK, '--check'], { cwd: project });
  ok(snap(project) === before, 'A: `klypix-link --check` created ZERO files (tree hash unchanged)');
  ok(audit.code === 1, 'A: `klypix-link --check` exits 1 on drift (usable as a CI gate)');
  ok(/auditing the brain projection/.test(audit.out), 'A: `--check` prints the AUDIT banner, not the write banner');
  ok(!/file\(s\) written\/updated/.test(audit.out), 'A: `--check` never claims files were written');

  // …and exits 0 once the projection is in sync.
  const write = run([LINK], { cwd: project });
  ok(write.code === 0 && /14 file\(s\) written\/updated/.test(write.out), 'A: write mode projects all 14 managed files');
  const clean = run([LINK, '--check'], { cwd: project });
  ok(clean.code === 0 && /in sync — all 14 managed file\(s\)/.test(clean.out), 'A: `--check` exits 0 when the projection is clean');
  const rewrite = run([LINK], { cwd: project });
  ok(/0 file\(s\) written\/updated/.test(rewrite.out), 'A: a second write run is idempotent (0 files written)');
}

// ── B — a positional directory is honoured; the cwd is NOT written ────────────
{
  const cwd = tmp('b-cwd');
  const target = tmp('b-target');
  const cwdBefore = snap(cwd);
  const write = run([LINK, target], { cwd });
  ok(write.code === 0, 'B: `klypix-link <dir>` succeeds');
  ok(snap(cwd) === cwdBefore, 'B: the CWD received nothing — the positional directory is not dropped');
  ok(fs.existsSync(path.join(target, '.mcp.json')) && fs.existsSync(path.join(target, 'AGENTS.md')),
    'B: the NAMED directory received the managed files');
  const audit = run([LINK, target, '--check'], { cwd });
  ok(audit.out.includes(target), 'B: `<dir> --check` audits the NAMED directory, not the cwd');
  ok(audit.code === 0, 'B: auditing the just-written directory is clean');
}

// ── C — PARITY: standalone bin === dispatcher, for every DIRECT verb ──────────
// This is the assertion that catches the whole class rather than one instance.
{
  const project = tmp('c-project');
  const viaBin = run([LINK, '--check'], { cwd: project });
  const viaDispatcher = run([MCP, 'link', '--check'], { cwd: project });
  ok(viaBin.out === viaDispatcher.out, 'C: link --check — stdout is byte-identical from the bin and the dispatcher');
  ok(viaBin.code === viaDispatcher.code, 'C: link --check — exit code is identical from the bin and the dispatcher');

  // Write mode into the SAME target twice (same absolute path → comparable bytes).
  const target = tmp('c-target');
  run([LINK, target], { cwd: project });
  const fromBin = snap(target);
  rmrf(target); fs.mkdirSync(target, { recursive: true });
  run([MCP, 'link', target], { cwd: project });
  const fromDispatcher = snap(target);
  ok(fromBin === fromDispatcher && fromBin.length > 0,
    'C: link write — the bin and the dispatcher produce a byte-identical projection');
}

// ── D — write mode fails loudly when a managed target could not be wired ──────
{
  const project = tmp('d-project');
  fs.writeFileSync(path.join(project, '.mcp.json'), '{ not json');
  const write = run([LINK], { cwd: project });
  ok(write.code === 1, 'D: write mode exits 1 when a managed target was skipped (was: 0 with a success banner)');
  ok(/could not be wired/.test(write.out), 'D: the skipped target is named with its reason');
  ok(!/every agent opened in this project now reads \+ captures/.test(write.out),
    'D: the blanket "every agent now reads + captures" claim is withheld when a target is unwired');
  ok(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8') === '{ not json',
    'D: the unparseable file is left untouched');
}

// ── E — doctor honours its flags from BOTH invocation shapes ──────────────────
{
  const project = tmp('e-project');
  const parse = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
  const viaBin = run([DOCTOR, '--json', '--project', project]);
  const viaDispatcher = run([MCP, 'doctor', '--json', '--project', project]);
  const a = parse(viaBin);
  const b = parse(viaDispatcher);
  ok(a && b, 'E: doctor --json emits JSON from the bin and the dispatcher');
  ok(a?.project?.dir === project, 'E: doctor --project <dir> is honoured by the standalone bin');
  ok(b?.project?.dir === project, 'E: doctor --project <dir> is honoured through the dispatcher');
  ok(a?.verdict === b?.verdict && viaBin.code === viaDispatcher.code,
    'E: doctor reports the same verdict and exit code from both shapes');
}

// ── F — conformance honours --json from source and the installed bundle ──────
// test/conformance.mjs covers the dispatcher shape. The installed-copy assertion
// also pins the flatten + staged-file closure used by the published flat bundle.
{
  const r = run([CONFORMANCE, '--json'], { timeout: 120_000 });
  let report = null;
  try { report = JSON.parse(r.out); } catch { /* reported below */ }
  ok(report !== null, 'F: `klypix-conformance --json` honours --json (stdout parses as JSON)');
  ok(report?.ok === true, 'F: the standalone conformance run passes');

  const project = tmp('f-installed-project');
  const home = tmp('f-installed-home');
  const install = run([INSTALL, '--runtime-only'], { cwd: project, home, timeout: 180_000 });
  const installedBin = path.join(home, 'bundle', 'klypix-conformance.mjs');
  ok(install.code === 0 && fs.existsSync(installedBin),
    'F: runtime-only install stages the flat-bundle conformance command');
  const installed = run([installedBin, '--json'], { cwd: project, home, timeout: 120_000 });
  let installedReport = null;
  try { installedReport = JSON.parse(installed.out); } catch { /* reported below */ }
  ok(installedReport !== null,
    'F: installed `klypix-conformance --json` stdout parses as JSON');
  ok(installed.code === 0 && installedReport?.ok === true,
    'F: installed flat-bundle conformance run passes');
}

// ── G — install honours its flags from BOTH shapes (runtime-only: no host writes) ──
{
  const mark = /runtime-only update: host settings and project files were preserved/;
  const homeA = tmp('g-home-bin');
  const homeB = tmp('g-home-dispatch');
  const project = tmp('g-project');
  const viaBin = run([INSTALL, '--runtime-only'], { cwd: project, home: homeA, timeout: 180_000 });
  const viaDispatcher = run([MCP, 'install', '--runtime-only'], { cwd: project, home: homeB, timeout: 180_000 });
  ok(viaBin.code === 0 && mark.test(viaBin.out), 'G: `klypix-install --runtime-only` honours the flag');
  ok(viaDispatcher.code === 0 && mark.test(viaDispatcher.out), 'G: `klypix-mcp install --runtime-only` honours the flag');
  const list = (home) => {
    const dir = path.join(home, 'bundle');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort().join(',') : '';
  };
  ok(list(homeA) && list(homeA) === list(homeB), 'G: both shapes stage the same bundle scripts');

  const bundleDir = path.join(homeA, 'bundle');
  const unresolvedSrcImports = fs.readdirSync(bundleDir)
    .filter((file) => file.endsWith('.mjs'))
    .flatMap((file) => {
      const executable = fs.readFileSync(path.join(bundleDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return [...executable.matchAll(/['"](\.\.\/src\/[^'"]+\.mjs)['"]/g)]
        .map((match) => `${file}: ${match[1]}`);
    });
  ok(unresolvedSrcImports.length === 0,
    'G: installed executable modules contain no unresolved ../src/*.mjs imports');

  // The flat bundle stages the worker but NOT the link/doctor/install bins, so its
  // dispatch used to die with a raw ERR_MODULE_NOT_FOUND stack trace.
  const bundleServer = path.join(homeA, 'bundle', 'klypix-mcp-server.mjs');
  if (fs.existsSync(bundleServer)) {
    const bundleBench = run([bundleServer, 'bench', '--quick', '--json'], {
      cwd: project, home: homeA, timeout: 180_000,
    });
    let benchReport = null;
    try { benchReport = JSON.parse(bundleBench.out); } catch { /* reported below */ }
    ok(benchReport?.mode === 'quick' && benchReport?.scenarios?.concurrentWriters,
      'G: installed dispatcher resolves the lazy bench import and runs the quick benchmark');
    const bundleLink = run([bundleServer, 'link', '--check'], { cwd: project, home: homeA });
    ok(bundleLink.code === 2 && /not available in this installed bundle/.test(bundleLink.err),
      'G: a verb absent from the flat bundle fails with a real message and exit 2, not a stack trace');
  } else {
    ok(false, 'G: the runtime-only install staged klypix-mcp-server.mjs');
  }
}

// ── H — the dispatcher can no longer succeed silently on an unknown verb ──────
{
  const help = run([MCP, '--help']);
  ok(help.code === 0 && /Verbs:/.test(help.out), 'H: `--help` prints the verb list and exits 0');
  // `uninstall` was this test's example of an unknown verb, and it also asserted
  // the usage said no uninstall existed — both froze a claim that was FALSE from
  // 1.43.1 onward (bin/klypix-uninstall.mjs shipped as a published bin, reachable
  // only as `npx -p klypix-mcp klypix-uninstall`). Wired into the dispatcher
  // 2026-08-01; the unknown-verb guard is now proven with a verb that really is
  // unknown, and the usage must ADVERTISE uninstall rather than deny it.
  const unknown = run([MCP, 'definitely-not-a-verb']);
  ok(unknown.code === 2 && /unknown command "definitely-not-a-verb"/.test(unknown.err),
    'H: an unknown verb exits 2 with a message (was: exit 0, zero output)');
  ok(/^\s*uninstall\s/m.test(help.out),
    'H: the usage advertises the uninstall verb (it exists — do not re-freeze the old denial)');
  const uninstallCheck = run([MCP, 'uninstall', '--check']);
  ok(uninstallCheck.code === 0 && /removal|inventory|STRIP|KEEP/i.test(uninstallCheck.out + uninstallCheck.err),
    'H: `klypix-mcp uninstall --check` reaches the removal tool and reports without writing');
  // A dash token is a SERVER launch (`--vault <dir>`), never a verb — the guard
  // must not swallow it. The server blocks on stdio, so a short timeout is
  // expected; the assertion is only that the guard did not reject it.
  const server = run([MCP, '--vault', tmp('h-vault')], { timeout: 2500 });
  ok(!/unknown command/.test(server.err), 'H: `--vault <dir>` still reaches the stdio server (the guard ignores flags)');
}

// ── I — the read/append/write bins still parse their own argv ─────────────────
{
  const usage = run([BIN('klypix-read.mjs')]);
  ok(usage.code === 2 && /Usage: node read-klypix/.test(usage.err), 'I: klypix-read still reports usage and exits 2 with no file');
  const missing = run([BIN('klypix-read.mjs'), path.join(os.tmpdir(), 'klypix-cliargs-nope.klypix')]);
  ok(missing.code === 2 && /File not found/.test(missing.err), 'I: klypix-read still resolves its positional argument');
}

// ── J — twin suppression needs machine + client, not a bare pid ───────────────
// A pid number is unique only per machine and per moment. Suppressing an overlap
// warning on hostPid ALONE means two unrelated sessions silence each other, and a
// MISSING warning is invisible — nothing surfaces the mistake.
{
  const now = Date.now();
  const row = (extra) => ({ files: ['src/App.tsx'], cwd: '/proj', lastSeen: now, ...extra });
  const lane = [
    row({ id: 'me-mcp', hostPid: 111, machine: 'm1', client: 'claude-code' }),
    row({ id: 'me-lifecycle', hostPid: 111, machine: 'm1', client: 'claude-code' }),
    row({ id: 'other-machine', hostPid: 111, machine: 'm2', client: 'claude-code' }),
    row({ id: 'other-tool', hostPid: 111, machine: 'm1', client: 'codex' }),
  ];
  const ids = findPresenceConflicts(lane, 'me-mcp').map((c) => c.id).sort();
  ok(ids.join(',') === 'other-machine,other-tool',
    'J: a same-pid row on ANOTHER machine, and a same-pid row from another TOOL, both still raise the overlap');
  ok(!findPresenceConflicts(lane, 'me-mcp').some((c) => c.id === 'me-lifecycle'),
    'J: the session\'s own twin row is still suppressed');

  ok(isSuspectedTwin({ hostPid: 7, machine: 'm1', client: 'codex' }, { hostPid: 7, machine: 'm1', client: 'codex' }),
    'J: same machine + same client + same pid = twin');
  ok(!isSuspectedTwin({ hostPid: 7, machine: 'm1', client: 'codex' }, { hostPid: 7, machine: 'm2', client: 'codex' }),
    'J: a different machine is NOT a twin, even on the same pid');
  ok(!isSuspectedTwin({ hostPid: 7, machine: 'm1', client: 'codex' }, { hostPid: 7, machine: 'm1', client: 'claude-code' }),
    'J: a different host tool is NOT a twin, even on the same pid');
  // Backwards compatibility: rows written by an older build, or by the Claude Code
  // lifecycle hook, carry no `machine` / no `client`. Unknown must degrade to the
  // previous behaviour — never un-suppress a genuine twin.
  ok(isSuspectedTwin({ hostPid: 7 }, { hostPid: 7 }), 'J: legacy rows (no machine, no client) still suppress as before');
  ok(isSuspectedTwin({ hostPid: 7, machine: 'm1', client: 'claude-code' }, { hostPid: 7, client: 'mcp' }),
    'J: a placeholder client (getClientVersion unavailable) stays compatible');
  ok(!isSuspectedTwin({ hostPid: 7, machine: 'm1' }, { hostPid: 8, machine: 'm1' }), 'J: different pids are never twins');
}

// ── K — file keys are compared REPO-RELATIVE, so mixed declarations match ─────
// One session declaring "E:/repo/src/App.tsx" and another declaring "src/App.tsx"
// never matched before — on the product's headline feature, locally, today.
{
  const now = Date.now();
  const lane = [
    { id: 'me', hostPid: 1, machine: 'm1', client: 'claude-code', cwd: 'E:/repo', files: ['E:/repo/src/App.tsx'], lastSeen: now },
    { id: 'peer-relative', hostPid: 2, machine: 'm1', client: 'codex', cwd: 'E:/repo', files: ['src/App.tsx'], lastSeen: now },
  ];
  const conflicts = findPresenceConflicts(lane, 'me');
  ok(conflicts.length === 1 && conflicts[0].id === 'peer-relative',
    'K: an ABSOLUTE self declaration matches a REPO-RELATIVE peer declaration');
  ok(conflicts[0]?.files?.[0] === 'E:/repo/src/App.tsx',
    'K: the warning still reports the path as THIS session declared it');

  const variants = [
    { id: 'me', hostPid: 1, machine: 'm1', client: 'claude-code', cwd: 'E:/repo', files: ['src/App.tsx'], lastSeen: now },
    { id: 'p-backslash', hostPid: 2, machine: 'm1', client: 'codex', cwd: 'E:/repo', files: ['E:\\repo\\src\\App.tsx'], lastSeen: now },
    { id: 'p-dotslash', hostPid: 3, machine: 'm1', client: 'cursor', cwd: 'E:/repo', files: ['./src/App.tsx'], lastSeen: now },
    { id: 'p-drivecase', hostPid: 4, machine: 'm1', client: 'cline', cwd: 'E:/repo', files: ['e:/repo/src/app.tsx'], lastSeen: now },
    { id: 'p-elsewhere', hostPid: 5, machine: 'm1', client: 'codex', cwd: 'E:/repo', files: ['D:/other/src/App.tsx'], lastSeen: now },
  ];
  const matched = findPresenceConflicts(variants, 'me').map((c) => c.id).sort();
  ok(matched.join(',') === 'p-backslash,p-dotslash,p-drivecase',
    'K: backslash / ./ prefix / drive-letter case all fold onto the same key');
  ok(!matched.includes('p-elsewhere'),
    'K: DEFENSIVE — a path that cannot be placed under the root keeps its own key and does not false-match');

  // An explicit project root (what brain_sync already receives) overrides the row.
  const explicit = findPresenceConflicts([
    { id: 'me', hostPid: 1, machine: 'm1', client: 'claude-code', cwd: '/somewhere/else', files: ['E:/repo/src/App.tsx'], lastSeen: now },
    { id: 'peer', hostPid: 2, machine: 'm1', client: 'codex', cwd: 'E:/repo', files: ['src/App.tsx'], lastSeen: now },
  ], 'me', { projectRoot: 'E:/repo' });
  ok(explicit.length === 1, 'K: an explicit projectRoot is honoured');
}

// ── L — a dropped lane heartbeat is distinguishable from a written one ────────
{
  const home = tmp('l-home');
  const projectDir = tmp('l-project');
  const brainPath = path.join(projectDir, 'brain.klypix');
  fs.writeFileSync(brainPath, 'placeholder — only the lane key is derived from this path');
  const now = Date.now();

  const wrote = upsertSession({ brainPath, home, now, id: 'writer', client: 'codex', channel: 'mcp' });
  ok(Array.isArray(wrote) && wrote.laneWriteOk === true, 'L: a successful upsert reports laneWriteOk === true');
  ok(wrote.some((s) => s.id === 'writer'), 'L: the return shape is still a plain array of sessions');
  ok(JSON.stringify(wrote) === JSON.stringify([...wrote]),
    'L: the verdict is NON-enumerable — JSON output and spread are unchanged (no consumer breaks)');
  ok(wrote.find((s) => s.id === 'writer')?.machine,
    'L: the lane row now carries a machine identity (what scopes hostPid)');

  const laneFile = laneFileFor(brainPath, home);
  fs.writeFileSync(`${laneFile}.lock`, 'held by a test');
  try {
    const blocked = upsertSession({ brainPath, home, now: now + 1, id: 'blocked', client: 'codex', channel: 'mcp' });
    ok(blocked.laneWriteOk === false && blocked.laneWriteSkippedReason === 'lane-locked',
      'L: a lock timeout reports laneWriteOk === false with a reason (was: indistinguishable from success)');
    ok(Array.isArray(blocked) && !blocked.some((s) => s.id === 'blocked'),
      'L: the fallback is an honest read-only snapshot that does NOT contain the unwritten row');
  } finally {
    rmrf(`${laneFile}.lock`);
  }

  const noLane = upsertSession({ brainPath: null, home, now, id: 'x' });
  ok(noLane.laneWriteOk === false && noLane.laneWriteSkippedReason === 'no-brain-or-id',
    'L: a missing brain path is reported as a distinct non-write reason');
}

console.log(failures
  ? `\n✗ ${failures} cli-args assertion(s) failed`
  : '\n✓ cli-args: all assertions passed');
process.exit(failures ? 1 : 0);
