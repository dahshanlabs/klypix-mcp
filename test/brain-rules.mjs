// brain-rules — deterministic project rules made from the brain's lessons.
//
// Every layer is exercised for real: rule kinds against real git repos
// (working tree, staged, range), the candidate → active → retired lifecycle
// with the human approval code and the brain mirror cards, allowances and the
// ledger, the opt-in git hooks (a blocked commit, a --no-verify bypass recorded
// by post-commit), the Claude Code hook lanes spawned as the real hook script
// (a denied Write, context for a missing registry entry, an EOL change caught
// after the edit), a Codex apply_patch payload, brain_sync's plan-time notice,
// lesson routing and the brain_rules tool. HOME and the global git config are
// sandboxed: nothing touches this machine's real install or settings.
//
// Run:  node test/brain-rules.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-rules-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
// Sandbox BEFORE the engine is imported: os.homedir() and git read these.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const GIT_GLOBAL = path.join(TMP, 'gitconfig');
fs.writeFileSync(GIT_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = GIT_GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.KLYPIX_RULES;
delete process.env.KLYPIX_RULES_OVERRIDE;
// The person's commands refuse inside an agent's shell; run as a person here,
// whoever runs the suite (this file is often run by an agent).
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CURSOR_SESSION_ID', 'CLINE_SESSION_ID', 'WINDSURF_SESSION_ID']) delete process.env[k];

const R = await import('../src/brain-rules.mjs');
const { buildKlypixMap, parseKlypix } = await import('../src/klypix-format.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

async function makeProject(name, lessons) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  const buf = await buildKlypixMap({ title: 'brain', kind: 'brain', areas: [{ title: 'Lessons', cards: lessons.map((text) => ({ text })) }] });
  fs.writeFileSync(path.join(dir, 'brain.klypix'), buf);
  const cards = (await parseKlypix(buf)).struct.cards.filter((c) => c.type !== 'container');
  const idOf = (needle) => cards.find((c) => String(c.text).includes(needle))?.id;
  return { dir, idOf };
}

const LESSONS = [
  '🛠️ Every new App.tsx route must also be added to `src/routes.ts` PRIVATE_ROUTES, or a direct link to it returns 404.',
  '🛠️ A new test file must be enumerated in `package.json` — a test not listed there never runs in CI.',
  '🛠️ Admin tests must import relatively: the root vitest has no `@/` alias.',
  '🛠️ `src/mixed.ts` is mixed CRLF/LF and a test pins its line endings — keep them.',
  '🛠️ Changes to `package-lock.json` are runner-impacting: they need the full cloud CI.',
  '🛠️ Always amend locally and push once to an open runner-impacting PR.',
  'Decided to keep the dashboard in one tab for now.',
];

const P = await makeProject('proj', LESSONS);
const cards = {
  routes: P.idOf('App.tsx route'), tests: P.idOf('enumerated'), relative: P.idOf('import relatively'),
  eol: P.idOf('mixed CRLF/LF'), lock: P.idOf('runner-impacting: they'),
};
ok(Object.values(cards).every(Boolean), 'the test brain holds the five lessons the rules cite');

write(P.dir, 'src/routes.ts', 'export const PRIVATE_ROUTES = new Set(["/a"]);\n');
write(P.dir, 'package.json', '{"scripts":{"test":"node --test src/a.test.ts"}}\n');
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\nthree\r\n');
write(P.dir, 'src/App.tsx', '<Route path="/a" />\n');
write(P.dir, '.gitignore', '');
git(P.dir, 'add', '-A');
git(P.dir, 'commit', '-qm', 'init');
const BASE = git(P.dir, 'rev-parse', 'HEAD').trim();

const RULES = [
  { id: 'private-routes', kind: 'listed-in', severity: 'block', why: 'A new route must be in PRIVATE_ROUTES or a direct link 404s.', fix: 'Add "{1}" to PRIVATE_ROUTES in {registry}.', source: { card: cards.routes }, files: ['src/App.tsx'], when: 'added-lines', pattern: '<Route path="(/[^"]+)"', registry: ['src/routes.ts'], needle: '"{1}"' },
  { id: 'tests-wired', kind: 'listed-in', severity: 'block', why: 'A test not listed in package.json never runs in CI.', fix: 'Add {file} to the test script in package.json.', source: { card: cards.tests }, files: ['src/**/*.test.ts'], when: 'added-files', registry: ['package.json'], needle: '{file}' },
  { id: 'admin-relative', kind: 'forbid-pattern', severity: 'block', why: 'The root vitest has no @/ alias, so the test fails to load.', fix: 'Import with a relative path (../lib/…).', source: { card: cards.relative }, files: ['admin/tests/**/*.test.ts'], pattern: "from '@/" },
  { id: 'mixed-eol', kind: 'preserve-eol', severity: 'block', why: 'A test pins this file\'s mixed line endings.', fix: 'Restore the original line endings of {file}.', source: { card: cards.eol }, files: ['src/mixed.ts'] },
  { id: 'lockfile-cloud', kind: 'cloud-required', severity: 'advise', why: 'Lockfile changes are runner-impacting.', fix: 'Push once; the full cloud CI must run.', source: { card: cards.lock }, files: ['package-lock.json'] },
];

// ── globs and validation ─────────────────────────────────────────────────────
ok(R.matchesGlobs(['*.test.ts'], 'a/b/c.test.ts') && !R.matchesGlobs(['src/*.ts'], 'src/a/b.ts') && R.matchesGlobs(['src/**/*.ts'], 'src/a/b.ts') && R.matchesGlobs(['src/**/*.ts'], 'src/b.ts') && R.matchesGlobs(['{a,b}/*.md'], 'b/x.md'),
  'globs: basename globs match anywhere, * stays in a segment, ** spans folders, {a,b} alternates');
const bad = R.validateRule({ id: 'X bad', kind: 'listed-in', why: '', fix: 'f', source: {}, files: ['<glob>'], registry: [] });
ok(!bad.ok && bad.errors.some((e) => e.includes('id')) && bad.errors.some((e) => e.includes('why')) && bad.errors.some((e) => e.includes('source.card')) && bad.errors.some((e) => e.includes('placeholder')) && bad.errors.some((e) => e.includes('registry')),
  'validation names every problem: id, why, source card, an unfinished draft placeholder, registry');
ok(!R.validateRule({ ...RULES[2], pattern: '(' }).ok, 'an invalid regex is refused when the rule is written, not when it runs');

// ── lifecycle: candidates are inert; promote needs the human's code ──────────
const brainIds = new Set((await parseKlypix(fs.readFileSync(path.join(P.dir, 'brain.klypix')))).struct.cards.map((c) => c.id));
const added = R.addCandidates(P.dir, RULES, { cardExists: (id) => brainIds.has(id), proposedBy: 'test' });
ok(added.ok && added.added.length === 5, 'five completed drafts are added as candidates');
ok(!R.addCandidates(P.dir, [{ ...RULES[0], id: 'ghost', source: { card: 'txt_doesnotexist' } }], { cardExists: (id) => brainIds.has(id) }).ok, 'a rule citing a card that is not in the brain is refused');
write(P.dir, 'src/App.tsx', '<Route path="/a" />\n<Route path="/b" />\n');
let res = R.runRules(R.activeRules(R.loadRulesDoc(P.dir)), R.gitDiffSource(P.dir, { mode: 'worktree' }));
ok(res.length === 0, 'candidates enforce nothing (no active rules yet)');
let refused = await R.promoteRules(P.dir, RULES.map((r) => r.id), 'deadbeef');
ok(!refused.ok && refused.reason === 'code' && /rules code promote/.test(refused.message), 'promote without the human\'s code is refused and says how to get it');
const review = R.lifecycleReview(P.dir, 'promote', RULES.map((r) => r.id));
ok(review.ok && /^[0-9a-f]{8}$/.test(review.code), 'the human review yields an 8-character code for exactly these rules');
const promoted = await R.promoteRules(P.dir, RULES.map((r) => r.id), review.code);
ok(promoted.ok && promoted.promoted.length === 5 && promoted.mirrored, 'with the code, all five become active and are mirrored into the brain');
const doc = R.loadRulesDoc(P.dir);
ok(doc.rules.every((r) => r.status === 'active' && r.approvedAt && r.mirrorCard), 'each active rule records when it was approved and its mirror card');
{
  const { struct } = await parseKlypix(fs.readFileSync(path.join(P.dir, 'brain.klypix')));
  const ruleCard = struct.cards.find((c) => c.id === doc.rules.find((r) => r.id === 'private-routes').mirrorCard);
  ok(ruleCard && /📏 Rule `private-routes` is active/.test(ruleCard.text) && ruleCard.area === 'Rules', 'the mirror card is visible in the brain\'s Rules area');
  ok((struct.connections || []).some((c) => c.fromId === cards.routes && c.toId === ruleCard?.id), 'the mirror card is linked from the lesson it came from');
}
ok(!R.addCandidates(P.dir, [{ ...RULES[0] }]).ok, 'an active rule cannot be silently overwritten by a new candidate with its id');

// ── each kind, against real diffs ────────────────────────────────────────────
write(P.dir, 'src/b.test.ts', 'test\n');
write(P.dir, 'admin/tests/x.test.ts', "import y from '@/lib/y';\nimport z from '../lib/z';\n");
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\r\nthree\r\nfour\r\n');
write(P.dir, 'package-lock.json', '{}\n');
const t0 = process.hrtime.bigint();
res = R.runRules(R.activeRules(R.loadRulesDoc(P.dir)), R.gitDiffSource(P.dir, { mode: 'worktree' }));
const worktreeMs = Number(process.hrtime.bigint() - t0) / 1e6;
const by = Object.fromEntries(res.map((r) => [r.rule.id, r]));
ok(by['private-routes'].status === 'fail' && by['private-routes'].findings[0].file === 'src/App.tsx' && by['private-routes'].findings[0].line === 2 && /"\/b"/.test(by['private-routes'].findings[0].fix),
  'listed-in (added lines): the new route at src/App.tsx:2 is missing from PRIVATE_ROUTES, and the fix names the exact entry');
ok(by['tests-wired'].status === 'fail' && by['tests-wired'].findings[0].file === 'src/b.test.ts', 'listed-in (added files): a new test file not listed in package.json');
ok(by['admin-relative'].status === 'fail' && by['admin-relative'].findings.length === 1 && by['admin-relative'].findings[0].line === 1, 'forbid-pattern: only the line importing @/ is flagged, with its line number');
ok(by['mixed-eol'].status === 'fail' && /mixed to crlf/.test(by['mixed-eol'].findings[0].found), 'preserve-eol: a mixed file flattened to CRLF is caught');
ok(by['lockfile-cloud'].status === 'advise', 'cloud-required: advisory, never a block');
const summary = R.summarizeResults(res);
ok(!summary.ok && summary.blocking === 4 && /Found: src\/App\.tsx:2/.test(summary.text) && /Why: {3}A new route/.test(summary.text) && /Fix: {3}Add "\/b"/.test(summary.text) && new RegExp(`lesson ${cards.routes}`).test(summary.text),
  'every message says what was found (file:line), why, how to fix, and which lesson');
console.log(`  (working-tree check of 5 rules over ${R.gitDiffSource(P.dir, { mode: 'worktree' }).files.length} changed files: ${worktreeMs.toFixed(1)} ms)`);

write(P.dir, 'src/routes.ts', 'export const PRIVATE_ROUTES = new Set(["/a", "/b"]);\n');
write(P.dir, 'package.json', '{"scripts":{"test":"node --test src/a.test.ts src/b.test.ts"}}\n');
write(P.dir, 'admin/tests/x.test.ts', "import y from '../lib/y';\n");
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\nthree\r\nfour\n');
res = R.runRules(R.activeRules(R.loadRulesDoc(P.dir)), R.gitDiffSource(P.dir, { mode: 'worktree' }));
ok(res.filter((r) => r.status === 'fail').length === 0, 'after the fixes (registry entries, a relative import, mixed endings kept) nothing blocks');
// A raw NUL deep inside a string literal leaves a file text, as git decides (AgentMug's
// managed-run-worker.ts has one at byte ~180,000); only a NUL in the first 8000 bytes is binary.
ok(R.eolStyle(Buffer.concat([Buffer.from('a\r\n'.repeat(3000)), Buffer.from('x\0y\n')])) === 'mixed' && R.eolStyle(Buffer.from('a\0b\r\n')) === 'binary',
  'eolStyle: a NUL past the first 8000 bytes does not make a file binary');
// Still "mixed" overall, but two untouched lines flipped: caught line by line.
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\r\nthree\nfour\n');
res = R.runRules(R.activeRules(R.loadRulesDoc(P.dir)), R.gitDiffSource(P.dir, { mode: 'worktree' }));
{
  const eol = res.find((r) => r.rule.id === 'mixed-eol');
  ok(eol?.status === 'fail' && /line ending of 2 lines it does not otherwise change \(lines 2, 3 of the committed file\)/.test(eol.findings[0].found),
    'preserve-eol: untouched lines whose endings flipped are caught even when the file stays mixed');
}
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\nthree\r\nfour\n');

// ── plan time: brain_sync ────────────────────────────────────────────────────
let planned = R.rulesForFiles(P.dir, ['src/App.tsx', 'admin/tests/new.test.ts', 'docs/readme.md']);
ok(planned.rules.map((r) => r.id).sort().join() === 'admin-relative,private-routes', 'rulesForFiles: only the rules whose files match the declared scope');
ok(R.rulesForFiles(P.dir, [path.join(P.dir, 'src', 'mixed.ts')]).rules.some((r) => r.id === 'mixed-eol' && /mixed CRLF\/LF today/.test(r.why)), 'preserve-eol shows at plan time only while the file is really mixed (absolute paths are accepted)');
ok(/KLYPIX project rules for the files in your scope/.test(R.formatRulesNotice(planned.rules)), 'the brain_sync notice names the rules, fixes and lessons');
{
  // The real brain_sync, end to end: declare a file a rule covers, get the rule back.
  const { createMcpPresence } = await import('../src/mcp-presence.mjs');
  const presence = createMcpPresence({
    server: { server: { getClientVersion: () => ({ name: 'rules-test', version: 'test' }) }, sendLoggingMessage: () => {} },
    initialVault: P.dir, env: { KLYPIX_SESSION_ID: 'rules-plan-session' }, home: HOME,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
  });
  const synced = presence.sync({ project: P.dir, phase: 'start', intent: 'add a dashboard route', files: ['src/App.tsx'] });
  const text = String(synced.text || '');
  if (process.env.DBG_SYNC) console.log('DBG', JSON.stringify(synced.structured?.rules), text.slice(-900));
  ok(synced.structured?.rules?.some((r) => r.id === 'private-routes' && r.card === cards.routes) && /KLYPIX project rules for the files in your scope/.test(text) && /Add "the new entry" to PRIVATE_ROUTES in src\/routes\.ts/.test(text) && !/\{1\}|\{registry\}/.test(text),
    'brain_sync: a session that declares src/App.tsx is told the route rule, its fix (templates filled) and its lesson before it edits');
  const other = createMcpPresence({
    server: { server: { getClientVersion: () => ({ name: 'rules-test', version: 'test' }) }, sendLoggingMessage: () => {} },
    initialVault: P.dir, env: { KLYPIX_SESSION_ID: 'rules-docs-session' }, home: HOME,
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
  });
  const quiet = other.sync({ project: P.dir, phase: 'start', intent: 'docs only', files: ['docs/readme.md'] });
  ok(!quiet.structured?.rules, 'brain_sync: no rules block when no declared file is covered');
}

// ── staged mode, the git hooks, a bypass recorded ────────────────────────────
write(P.dir, 'src/App.tsx', '<Route path="/a" />\n<Route path="/b" />\n<Route path="/c" />\n');
git(P.dir, 'add', '-A');
res = R.runRules(R.activeRules(R.loadRulesDoc(P.dir)), R.gitDiffSource(P.dir, { mode: 'staged' }));
ok(res.find((r) => r.rule.id === 'private-routes').findings.some((f) => /"\/c"/.test(f.fix)), 'staged mode: the index is checked (the /c route is not registered)');
const hooks = R.installRulesHooks(P.dir);
ok(hooks.ok && hooks.changed.sort().join() === 'post-commit,pre-commit,pre-push', 'the opt-in installer wires pre-commit, pre-push and post-commit');
ok(R.rulesHookStatus(P.dir).state === 'installed', 'hook status reads installed');
{
  // A hook manager (husky, lefthook) owns core.hooksPath: write nothing, say what to add.
  const H = path.join(TMP, 'husky-repo');
  fs.mkdirSync(H, { recursive: true });
  git(H, 'init', '-q');
  git(H, 'config', 'core.hooksPath', '.husky');
  const said = [];
  const code = await R.runRulesCli(['--install-hook'], { cwd: H, stdout: (s) => said.push(s), stderr: (s) => said.push(s), stdin: () => '' });
  ok(code === 1 && /core\.hooksPath \(\.husky\)/.test(said.join('')) && /--hook pre-commit "\$@" \|\| exit 1/.test(said.join('')) && !fs.existsSync(path.join(H, '.husky')),
    'with a hook manager on core.hooksPath, --install-hook writes nothing and prints the line to add to each hook');
}
let commit = spawnSync('git', ['commit', '-qm', 'add route c'], { cwd: P.dir, encoding: 'utf8' });
ok(commit.status !== 0 && /BLOCKED — project rule `private-routes`/.test(commit.stderr) && /rules allow/.test(commit.stderr), 'a real git commit is blocked by the pre-commit hook, with the rule message and the override route');
commit = spawnSync('git', ['commit', '-qm', 'add route c (bypass)', '--no-verify'], { cwd: P.dir, encoding: 'utf8' });
ok(commit.status === 0, 'git commit --no-verify still commits (the human\'s call)');
let events = R.readEvents(P.dir);
ok(events.some((e) => e.rule === 'private-routes' && e.event === 'override' && e.layer === 'post-commit'), 'post-commit recorded the bypass as an override in the ledger');
write(P.dir, 'src/App.tsx', '<Route path="/a" />\n<Route path="/b" />\n<Route path="/c" />\n<Route path="/off" />\n');
git(P.dir, 'add', '-A');
commit = spawnSync('git', ['commit', '-qm', 'add route off'], { cwd: P.dir, encoding: 'utf8', env: { ...process.env, KLYPIX_RULES: '0' } });
ok(commit.status === 0, 'KLYPIX_RULES=0 skips the check for one commit');
ok(R.readEvents(P.dir).filter((e) => e.rule === 'private-routes' && e.event === 'override' && e.layer === 'post-commit').length === 2, 'and post-commit still records that commit as a bypass');
{
  const { struct } = await parseKlypix(fs.readFileSync(path.join(P.dir, 'brain.klypix')));
  ok(struct.cards.some((c) => /landed although rule `private-routes` fails on it/.test(c.text || '')), 'the bypass is a visible card in the brain');
}

// ── allowance: an explicit, recorded override ────────────────────────────────
write(P.dir, 'src/App.tsx', '<Route path="/a" />\n<Route path="/b" />\n<Route path="/c" />\n<Route path="/public-landing" />\n');
git(P.dir, 'add', '-A');
const cli = (...args) => {
  const out = []; const err = [];
  return R.runRulesCli(args, { cwd: P.dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), stdin: () => '' }).then((code) => ({ code, out: out.join(''), err: err.join('') }));
};
let run = await cli('rules', 'allow', 'private-routes', '--reason', 'public landing page, not behind auth');
ok(run.code === 0 && /one hour/.test(run.out), 'rules allow: the human allows one rule for one hour, with a reason');
commit = spawnSync('git', ['commit', '-qm', 'public landing route'], { cwd: P.dir, encoding: 'utf8' });
ok(commit.status === 0, 'the allowed commit passes the pre-commit hook');
events = R.readEvents(P.dir);
ok(events.some((e) => e.rule === 'private-routes' && e.event === 'override' && e.reason === 'public landing page, not behind auth'), 'the allowance is recorded as an override with its reason');
{
  const { struct } = await parseKlypix(fs.readFileSync(path.join(P.dir, 'brain.klypix')));
  ok(struct.cards.some((c) => /Override of rule `private-routes`.*public landing page/.test((c.text || '').replace(/\s+/g, ' '))), 'the override and its reason are a card in the brain');
}
ok(R.readAllowances(P.dir).length === 0, 'the allowance is used up by the commit');

// ── the person's side refuses inside an agent's shell ────────────────────────
{
  const asAgent = (env, ...args) => {
    const out = []; const err = [];
    return R.runRulesCli(args, { cwd: P.dir, env: { ...process.env, ...env }, stdout: (s) => out.push(s), stderr: (s) => err.push(s), stdin: () => '' }).then((code) => ({ code, out: out.join(''), err: err.join('') }));
  };
  const coded = await asAgent({ CLAUDECODE: '1' }, 'rules', 'code', 'retire', 'private-routes');
  ok(coded.code === 1 && !/[0-9a-f]{8}/.test(coded.out) && /own terminal/.test(coded.err) && /Claude Code/.test(coded.err), 'rules code refuses in a Claude Code shell and prints no approval code');
  const allowed = await asAgent({ CODEX_THREAD_ID: 't-1' }, 'rules', 'allow', 'private-routes', '--reason', 'agent wants it');
  ok(allowed.code === 1 && /person's decision/.test(allowed.err) && R.readAllowances(P.dir).length === 0, 'rules allow refuses in a Codex shell and writes no allowance');
  const human = await asAgent({}, 'rules', 'code', 'retire', 'private-routes');
  ok(human.code === 0 && /^[0-9a-f]{8}\s*$/.test(human.out), 'the same command in the person\'s own terminal prints the code');
  // A one-commit override named in the environment is honoured, and says who set it.
  write(P.dir, 'src/App.tsx', '<Route path="/a" />\n<Route path="/b" />\n<Route path="/c" />\n<Route path="/public-landing" />\n<Route path="/beta" />\n');
  git(P.dir, 'add', '-A');
  const overridden = spawnSync('git', ['commit', '-qm', 'beta route'], { cwd: P.dir, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', KLYPIX_RULES_OVERRIDE: 'private-routes: beta page ships behind a flag' } });
  ok(overridden.status === 0, 'KLYPIX_RULES_OVERRIDE="<rule>: <reason>" lets one commit through');
  const ev = R.readEvents(P.dir).filter((e) => e.rule === 'private-routes' && e.event === 'override' && e.reason === 'beta page ships behind a flag');
  ok(ev.length === 1 && /Claude Code agent's shell/.test(ev[0].by || ''), 'that override is recorded, naming the agent shell it was set in');
}

// ── pre-push range ───────────────────────────────────────────────────────────
run = await cli('check', '--range', `${BASE}..HEAD`, '--json');
const json = JSON.parse(run.out);
ok(run.code === 1 && json.results.find((r) => r.id === 'private-routes').findings.length >= 1, 'check --range: the unregistered routes in the pushed commits are reported (exit 1)');

// ── edit time: the Claude Code hook lanes, spawned for real ──────────────────
const hookScript = path.join(ROOT, 'src', 'global-brain-hook.mjs');
const runHook = (flag, input) => spawnSync(process.execPath, [hookScript, flag], { cwd: P.dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, KLYPIX_AUTO_UPDATE: '0' } });
let hook = runHook('--guard', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(P.dir, 'admin', 'tests', 'y.test.ts'), content: "import a from '@/lib/a';\n" } });
let payload = JSON.parse(hook.stdout || '{}');
ok(payload.hookSpecificOutput?.permissionDecision === 'deny' && /admin\/tests\/y\.test\.ts:1/.test(payload.hookSpecificOutput.permissionDecisionReason) && /Fix: {3}Import with a relative path/.test(payload.hookSpecificOutput.permissionDecisionReason),
  'PreToolUse (Claude Code): a Write that adds a forbidden line is denied, with file:line, why and fix');
hook = runHook('--guard', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(P.dir, 'admin', 'tests', 'y.test.ts'), content: "import a from '../lib/a';\n" } });
ok(!hook.stdout || !/deny/.test(hook.stdout), 'the corrected Write is not denied');
hook = runHook('--guard', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(P.dir, 'src', 'App.tsx'), old_string: '<Route path="/a" />', new_string: '<Route path="/a" />\n<Route path="/settings" />' } });
payload = JSON.parse(hook.stdout || '{}');
ok(!payload.hookSpecificOutput?.permissionDecision && /"\/settings"/.test(payload.hookSpecificOutput?.additionalContext || ''), 'an Edit adding an unregistered route is not denied (the registry edit may come next) but gets the rule as context');
hook = runHook('--guard', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(P.dir, 'src', 'App.tsx'), old_string: '<Route path="/a" />', new_string: '<Route path="/a" />\n<Route path="/settings" />' } });
ok(!hook.stdout, 'the same context is shown once per session');
hook = runHook('--guard', { session_id: 's1', tool_name: 'MultiEdit', tool_input: { file_path: path.join(P.dir, 'admin', 'tests', 'x.test.ts'), edits: [{ old_string: "import y from '../lib/y';", new_string: "import y from '@/lib/y';" }] } });
ok(/"permissionDecision":"deny"/.test(hook.stdout || ''), 'MultiEdit is covered too');
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\r\nthree\r\nfour\r\n');
hook = runHook('--live', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(P.dir, 'src', 'mixed.ts'), old_string: 'x', new_string: 'y' } });
payload = JSON.parse(hook.stdout || '{}');
ok(payload.decision === 'block' && /mixed to crlf/.test(payload.reason || ''), 'PostToolUse: an edit that flattened a mixed file is fed back to the agent at once');
write(P.dir, 'src/mixed.ts', 'one\r\ntwo\nthree\r\nfour\n');

// ── Codex: apply_patch payloads (warnings — Codex cannot deny) ───────────────
const patch = ['*** Begin Patch', '*** Add File: admin/tests/z.test.ts', "+import q from '@/lib/q';", '*** Update File: src/App.tsx', '@@', ' <Route path="/a" />', '+<Route path="/codex" />', '*** End Patch'].join('\n');
const codex = R.preToolUseDecision(P.dir, 'apply_patch', { command: patch }, { sessionId: 'c1', host: 'codex' });
ok(codex?.deny && /admin\/tests\/z\.test\.ts:1/.test(codex.deny), 'Codex apply_patch: the added forbidden line is found with its line number');
const diff = R.proposedEditDiff(P.dir, 'apply_patch', { command: patch });
ok(diff.files.map((f) => `${f.status}:${f.path}`).join() === 'A:admin/tests/z.test.ts,M:src/App.tsx' && diff.added.get('src/App.tsx')[0].text === '<Route path="/codex" />', 'apply_patch parsing: added files, updated files and their added lines');

// ── lifecycle: stats, suggestions, false alarms, retire ──────────────────────
run = await cli('rules', 'false-alarm', 'private-routes', '--reason', 'marketing routes are public');
ok(run.code === 0, 'a person can record a false alarm');
R.appendEvents(P.dir, [{ rule: 'private-routes', event: 'override', layer: 'commit', reason: 'x' }, { rule: 'private-routes', event: 'override', layer: 'commit', reason: 'y' }]);
const later = Date.now() + 40 * 86_400_000;
const stats = R.ruleStats(P.dir, { now: later });
const pr = stats.stats.find((s) => s.id === 'private-routes');
ok(pr.blocks >= 1 && pr.overrides >= 3 && pr.falseAlarms === 1, `per-rule counts: blocks ${pr.blocks}, overrides ${pr.overrides}, false alarms ${pr.falseAlarms}`);
ok(stats.suggestions.some((s) => s.id === 'private-routes' && /overridden or marked a false alarm/.test(s.why)), 'an often-overridden rule is suggested for narrowing or retirement');
ok(stats.suggestions.some((s) => s.id === 'lockfile-cloud' && /has not fired in 30 days/.test(s.why)), 'a rule that never fired is suggested for retirement after 30 days');
refused = await R.retireRules(P.dir, ['private-routes'], '00000000');
ok(!refused.ok && /lift the block itself/.test(refused.message), 'retire without the code is refused — a blocked session cannot lift its own block');
const retireCode = R.lifecycleReview(P.dir, 'retire', ['private-routes']).code;
const retired = await R.retireRules(P.dir, ['private-routes'], retireCode, { reason: 'routes are generated now' });
ok(retired.ok && R.loadRulesDoc(P.dir).rules.find((r) => r.id === 'private-routes').status === 'retired', 'with the code the rule is retired (kept in the file, with its reason)');
ok(!R.activeRules(R.loadRulesDoc(P.dir)).some((r) => r.id === 'private-routes'), 'a retired rule no longer enforces');

// ── lessons → rule / instruction / note ──────────────────────────────────────
const { struct: brainNow } = await parseKlypix(fs.readFileSync(path.join(P.dir, 'brain.klypix')));
const routed = R.proposeFromCards(brainNow.cards, { existing: [] });
const routeOf = (needle) => routed.proposals.find((p) => p.excerpt.includes(needle))?.route;
ok(routeOf('App.tsx route') === 'rule' && routeOf('enumerated in') === 'rule' && routeOf('import relatively') === 'rule' && routeOf('mixed CRLF/LF') === 'rule' && routeOf('package-lock.json') === 'rule',
  'the five checkable lessons route to rule');
ok(routeOf('amend locally') === 'instruction', 'an imperative a diff cannot test routes to instruction');
ok(routeOf('Decided to keep the dashboard') === undefined || routeOf('Decided to keep the dashboard') === 'note', 'a decision without an imperative is never a rule');
ok(routed.proposals.find((p) => p.excerpt.includes('App.tsx route'))?.draft?.source?.card === cards.routes, 'each rule draft cites its lesson card');
ok(!routed.proposals.some((p) => /📏 Rule|Override of rule|False alarm/.test(p.excerpt)), 'the Rules area itself is never proposed back as lessons');

// ── the brain_rules tool ─────────────────────────────────────────────────────
let tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'status' });
ok(!tool.isError && /4 active · 0 candidate · 1 retired/.test(tool.blocks[0].text) && /git hooks: installed/.test(tool.blocks[0].text), 'status: counts by lifecycle state and the hook state');
tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'add', rules: [{ id: 'no-console', kind: 'forbid-pattern', severity: 'warn', why: 'Logs leak tokens.', fix: 'Use the logger.', source: { card: cards.relative }, files: ['src/**/*.ts'], pattern: 'console\\.log\\(' }] });
ok(!tool.isError && /rules code promote no-console/.test(tool.blocks[0].text), 'add: a candidate, with the human step spelled out');
write(P.dir, 'src/log.ts', 'console.log(token);\n');
tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'check', includeCandidates: true });
ok(tool.structured.results.some((r) => r.id === 'no-console' && r.ruleStatus === 'candidate' && r.findings.length === 1), 'check include_candidates: what a candidate would catch, before anyone approves it');
tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'check' });
ok(!tool.structured.results.some((r) => r.id === 'no-console'), 'a plain check ignores candidates');
tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'add', rules: [{ id: 'x2', kind: 'forbid-pattern', why: 'w', fix: 'f', source: { card: cards.relative }, files: ['a'], pattern: 'b' }], pluginMode: true });
ok(tool.isError && /plugin mode/.test(tool.blocks[0].text), 'plugin mode refuses to write .klypix/rules.json');
tool = await R.brainRulesTool({ projectRoot: P.dir, action: 'propose', query: 'enumerated' });
ok(!tool.isError && /\[rule \(already in rules\.json\)\]/.test(tool.blocks[0].text), 'propose returns routed lessons, and says when a lesson already has its rule');

// ── a broken rules file enforces nothing and says so ─────────────────────────
fs.writeFileSync(path.join(P.dir, '.klypix', 'rules.json'), '{ not json');
run = await cli('check');
ok(run.code === 2 && /is invalid/.test(run.err), 'an invalid rules file is reported (exit 2), never silently half-enforced');
const hookRun = spawnSync('git', ['commit', '-qm', 'broken rules', '--allow-empty'], { cwd: P.dir, encoding: 'utf8' });
ok(hookRun.status === 0, 'the pre-commit hook does not block commits because the rules file is broken (it reports, and enforcement resumes when fixed)');

// ── speed on a larger diff ───────────────────────────────────────────────────
const Q = await makeProject('speed', LESSONS);
write(Q.dir, 'src/routes.ts', 'export const PRIVATE_ROUTES = new Set([]);\n');
write(Q.dir, 'package.json', '{}\n');
git(Q.dir, 'add', '-A'); git(Q.dir, 'commit', '-qm', 'init');
fs.mkdirSync(path.join(Q.dir, '.klypix'), { recursive: true });
fs.writeFileSync(path.join(Q.dir, '.klypix', 'rules.json'), JSON.stringify({ schemaVersion: 1, rules: RULES.map((r) => ({ ...r, status: 'active', source: { card: 'txt_x123' } })) }));
for (let i = 0; i < 300; i++) write(Q.dir, `src/mod${i}/file${i}.ts`, Array.from({ length: 40 }, (_, j) => `export const v${j} = ${j};`).join('\n') + '\n');
git(Q.dir, 'add', '-A');
const t1 = process.hrtime.bigint();
const big = R.runRules(R.activeRules(R.loadRulesDoc(Q.dir)), R.gitDiffSource(Q.dir, { mode: 'staged' }));
const bigMs = Number(process.hrtime.bigint() - t1) / 1e6;
ok(big.every((r) => r.status === 'pass') && bigMs < 5000, `a 300-file / 12,000-line staged diff is checked in ${bigMs.toFixed(0)} ms (diff read included)`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ brain-rules: all assertions passed');
process.exit(failures ? 1 : 0);
