// `npx klypix-mcp check <files...>` — the exit-code answer for hooks and CI.
// Locks the contract: 0 = no live session declares or was observed editing any
// named file; 1 = overlap, one line per (file, session) and one summary line
// that calls itself a heads-up, not a lock; 2 = cannot answer, with the reason.
// Also: --json shape, --quiet silence, stale rows ignored, the calling session
// (KLYPIX_SESSION_ID) excluded, observed edits marked `*`, dispatcher parity
// with the sub-bin, read-only (lane bytes unchanged), and `check` with flags
// only still reaching the rules check.
// Run:  node test/check-command.mjs      (exit 0 = pass, 1 = fail)
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { laneFileFor, upsertSession } from '../src/agent-presence.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(root, 'bin', 'klypix-mcp.mjs');
const CHECK = path.join(root, 'bin', 'klypix-check.mjs');

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

// Everything under a scratch dir INSIDE the checkout: HOME / USERPROFILE /
// KLYPIX_BRAIN_DIR all point there so nothing touches this machine's live brain.
const scratch = path.join(root, '.tmp-check-command');
fs.rmSync(scratch, { recursive: true, force: true });
const home = path.join(scratch, 'home');
const project = path.join(scratch, 'project');
const noBrain = path.join(scratch, 'no-brain');
for (const dir of [home, path.join(project, 'src'), noBrain]) fs.mkdirSync(dir, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, await buildKlypixMap({
  title: 'check-command fixture',
  kind: 'brain',
  areas: [{ title: 'Brain', cards: [{ text: 'seed decision for the check fixture.' }] }],
}));
fs.writeFileSync(path.join(project, 'src', 'save.ts'), 'export const x = 1;\n');

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: home };
for (const key of ['KLYPIX_SESSION_ID', 'KLYPIX_MCP_CONNECTION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID']) delete baseEnv[key];
const run = (args, { cwd = project, env = {} } = {}) => {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// ── exit 2: cannot answer ────────────────────────────────────────────────────
{
  const r = run([MCP, 'check', 'src/save.ts'], { cwd: noBrain });
  ok(r.code === 2 && /no brain\.klypix/.test(r.err) && r.out === '',
    `2: no brain.klypix above the cwd → exit 2, reason on stderr (got ${r.code}: ${r.err.trim()})`);
  const j = parse(run([MCP, 'check', '--json', 'src/save.ts'], { cwd: noBrain }).out);
  ok(j?.status === 'unknown' && j?.exit === 2 && /no brain/.test(j?.reason || ''),
    '2: --json without a brain → { status: "unknown", exit: 2, reason }');
  const none = run([CHECK], { cwd: project });
  ok(none.code === 2 && /no files given/.test(none.err), '2: the sub-bin with no files → exit 2 "no files given"');
  const flag = run([CHECK, '--bogus', 'src/save.ts']);
  ok(flag.code === 2 && /unknown flag --bogus/.test(flag.err), '2: an unknown flag → exit 2 naming it');
}

// ── exit 0: brain, no lane yet ───────────────────────────────────────────────
{
  const r = run([MCP, 'check', 'src/save.ts']);
  ok(r.code === 0 && /no live session is working on src\/save\.ts/.test(r.out),
    `0: brain present, nobody has been here → exit 0 (got ${r.code}: ${r.out.trim()})`);
  ok(!fs.existsSync(laneFileFor(brainPath, home)), '0: the check created NO lane file (read-only)');
}

// ── seed the lane: two live sessions, one stale ──────────────────────────────
const now = Date.now();
upsertSession({
  brainPath, home, now, id: 'claude-aaaa-1111-2222-333333333333', client: 'claude-code', branch: 'feat/save',
  intent: 'fix the save path', intentSource: 'declared', files: ['src/save.ts'], cwd: project,
});
upsertSession({
  brainPath, home, now, id: 'codex-bbbb-4444-5555-666666666666', client: 'codex', branch: 'master',
  intent: 'wire the settings panel', intentSource: 'declared', observedFiles: ['src/App.tsx'], cwd: project,
});
upsertSession({
  brainPath, home, now: now - 20 * 60 * 1000, id: 'stale-cccc-7777-8888-999999999999', client: 'codex',
  intent: 'long gone', files: ['src/stale.ts'], cwd: project,
});
const laneFile = laneFileFor(brainPath, home);
const laneBefore = fs.readFileSync(laneFile);

// ── exit 0: live sessions, but not on these files ────────────────────────────
{
  const r = run([MCP, 'check', 'src/other.ts', 'README.md']);
  ok(r.code === 0 && /no live session is working on these 2 files/.test(r.out),
    `0: live peers elsewhere → exit 0 (got ${r.code}: ${r.out.trim()})`);
  const stale = run([MCP, 'check', 'src/stale.ts']);
  ok(stale.code === 0, '0: a row last seen 20 minutes ago is not a live session');
}

// ── exit 1: declared overlap ─────────────────────────────────────────────────
{
  const r = run([MCP, 'check', 'src/save.ts']);
  const lines = r.out.trim().split('\n');
  ok(r.code === 1, `1: a live peer declares the file → exit 1 (got ${r.code})`);
  ok(lines.length === 2, `1: one line per (file, session) plus the summary (got ${lines.length})`);
  ok(/^src\/save\.ts {2}Claude Code claude-a/.test(lines[0]), `1: line = "<file>  <client> <id-short> …" (got "${lines[0]}")`);
  ok(/· fix the save path · branch feat\/save$/.test(lines[0]), '1: the line carries the intent and the branch');
  ok(lines[1] === 'KLYPIX: 1 file(s) overlap with a live session — a heads-up, not a lock',
    `1: the summary line says heads-up, not a lock (got "${lines[1]}")`);
  ok(!/\*/.test(lines[0]), '1: a DECLARED path carries no * mark');
}

// ── exit 1: observed (undeclared) overlap is marked * ────────────────────────
{
  const r = run([MCP, 'check', 'src/App.tsx']);
  ok(r.code === 1 && /^src\/App\.tsx\* {2}Codex codex-b/m.test(r.out),
    `1: an OBSERVED edit counts and is marked * (got ${r.code}: ${r.out.split('\n')[0]})`);
  ok(/\(\* = observed from live edits, scope not declared\)/.test(r.out), '1: the * legend is printed once');
}

// ── paths: absolute, case, backslashes resolve to the same key ───────────────
{
  const abs = run([MCP, 'check', path.join(project, 'src', 'save.ts')]);
  ok(abs.code === 1 && /^src\/save\.ts /.test(abs.out), '1: an absolute path is resolved against the project root and printed relative');
  const cased = run([MCP, 'check', 'SRC\\Save.TS']);
  ok(cased.code === 1, '1: case and backslashes do not hide an overlap (same normalisation as brain_sync)');
  const two = run([MCP, 'check', 'src/save.ts', 'src/App.tsx', 'src/other.ts']);
  ok(two.code === 1 && /KLYPIX: 2 file\(s\) overlap/.test(two.out), '1: the summary counts overlapping FILES, not sessions or lines');
}

// ── --json shape ─────────────────────────────────────────────────────────────
{
  const r = run([MCP, 'check', '--json', 'src/save.ts', 'src/App.tsx', 'src/other.ts']);
  const j = parse(r.out);
  ok(r.code === 1 && j && j.command === 'check' && j.status === 'overlap' && j.exit === 1,
    '--json: { command: "check", status: "overlap", exit: 1 }');
  ok(j?.liveSessions === 2 && j?.overlappingFiles === 2, `--json: liveSessions=2 overlappingFiles=2 (got ${j?.liveSessions}/${j?.overlappingFiles})`);
  ok(Array.isArray(j?.files) && j.files.length === 3 && j.files[2].file === 'src/other.ts' && j.files[2].overlaps.length === 0,
    '--json: every asked file is listed, clear ones with an empty overlaps array');
  const hit = j?.files?.[0]?.overlaps?.[0];
  ok(hit && hit.session === 'claude-aaaa-1111-2222-333333333333' && hit.client === 'claude-code'
    && hit.intent === 'fix the save path' && hit.branch === 'feat/save' && hit.observed === false,
    '--json: an overlap row = { session, client, intent, branch, observed }');
  ok(j?.files?.[1]?.overlaps?.[0]?.observed === true, '--json: the observed edit says observed: true');
  ok(j?.project === project.replace(/\\/g, '/') && j?.brain === brainPath.replace(/\\/g, '/'), '--json: names the project root and the brain');
  const clear = parse(run([MCP, 'check', '--json', 'src/other.ts']).out);
  ok(clear?.status === 'clear' && clear?.exit === 0, '--json: a clear answer is { status: "clear", exit: 0 }');
}

// ── --quiet prints nothing, exit code intact ─────────────────────────────────
{
  const r = run([MCP, 'check', '--quiet', 'src/save.ts']);
  ok(r.code === 1 && r.out === '' && r.err === '', '--quiet: exit 1 with no output');
  const q2 = run([MCP, 'check', '-q', 'src/save.ts'], { cwd: noBrain });
  ok(q2.code === 2 && q2.out === '' && q2.err === '', '--quiet: exit 2 is silent too (the hook decides)');
}

// ── the calling session is not a peer ────────────────────────────────────────
{
  const r = run([MCP, 'check', 'src/save.ts'], { env: { KLYPIX_SESSION_ID: 'claude-aaaa-1111-2222-333333333333' } });
  ok(r.code === 0, 'self: KLYPIX_SESSION_ID excludes the calling session from the answer');
  const other = run([MCP, 'check', 'src/save.ts'], { env: { KLYPIX_SESSION_ID: 'codex-bbbb-4444-5555-666666666666' } });
  ok(other.code === 1, 'self: a different caller still sees the overlap');
}

// ── dispatcher parity + read-only ────────────────────────────────────────────
{
  const viaBin = run([CHECK, 'src/save.ts', 'src/App.tsx']);
  const viaDispatcher = run([MCP, 'check', 'src/save.ts', 'src/App.tsx']);
  ok(viaBin.out === viaDispatcher.out && viaBin.code === viaDispatcher.code,
    'parity: the sub-bin and `klypix-mcp check` print byte-identical output with the same exit code');
  ok(Buffer.compare(fs.readFileSync(laneFile), laneBefore) === 0, 'read-only: the lane bytes are unchanged after every check');
}

// ── `check` with flags only is still the rules check ─────────────────────────
{
  const r = run([MCP, 'check', '--json', '--base', 'origin/main']);
  ok(!/no files given/.test(r.err) && parse(r.out)?.command !== 'check',
    '`check --base origin/main` (flags only) routes to the rules check, not the overlap check');
}

// ── exit 2: lane unreadable ──────────────────────────────────────────────────
{
  fs.writeFileSync(laneFile, '{ not json');
  const r = run([MCP, 'check', 'src/save.ts']);
  ok(r.code === 2 && /lane unreadable/.test(r.err), `2: a corrupt lane → exit 2 "lane unreadable" (got ${r.code}: ${r.err.trim()})`);
  const j = parse(run([MCP, 'check', '--json', 'src/save.ts']).out);
  ok(j?.status === 'unknown' && /lane unreadable/.test(j?.reason || ''), '2: --json carries the lane reason');
  ok(fs.readFileSync(laneFile, 'utf8') === '{ not json', '2: the corrupt lane is left exactly as found (never repaired or rewritten)');
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n[x] ${failures} check-command assertion(s) failed` : '\n[ok] check-command: all assertions passed');
process.exit(failures ? 1 : 0);
