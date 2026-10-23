#!/usr/bin/env node
// brain-rules-proof — what would project rules have caught, and what did the
// misses cost? A re-runnable backtest over a repository's real GitHub Actions
// history. Read-only toward GitHub and toward the local checkout.
//
//   node scripts/brain-rules-proof.mjs --gh dahshanlabs/AgentMug \
//     --local <checkout> --clone <scratch clone> --cache <scratch dir> \
//     --since 2026-09-23 --until 2026-10-22 \
//     --rules docs/brain-rules-proof/agentmug.rules.json [--rules …] \
//     --signatures docs/brain-rules-proof/signatures.json \
//     --log-workflows CI [--log-workflows …] [--per-commit] --out result.json
//
// Method (docs/brain-checks-proof.md states it, so every number can be checked):
//   * runs: every Actions run created in the window, listed in 7-day slices
//     (the API caps one filtered list at 1,000 runs), with the jobs of every
//     attempt (filter=all);
//   * cost: per job, whole minutes rounded up from started/completed, times
//     the runner's list price (Linux $0.006, Windows $0.010, macOS $0.062 a
//     minute). A job with no steps never ran (a budget block) and costs 0.
//     Included free minutes are not subtracted;
//   * rules: at every PR commit an Actions run checked, the rules run on
//     merge-base(commit, base branch as that run saw it)..commit — the change
//     `klypix-mcp check --base` would have shown before that push. A listed-in
//     finding whose registry did not exist yet is reported apart, not counted;
//   * ground truth: failed job logs of the --log-workflows workflows are
//     searched for each rule's failure signature (signatures.json); every hit
//     keeps its log line as evidence;
//   * prevented: a failed CI run whose log carries the signature of a block
//     rule that fires at the run's commit. Its cost counts every attempt;
//   * silent rules (no signature: the mistake does not fail CI) are judged at
//     each merged PR's last commit and against today's default branch;
//   * --per-commit: every PR commit that touches a rule's files is also
//     checked on its own (what the pre-commit hook sees), to count early alarms.
//
// The clone is `git clone --shared --no-checkout` of the local checkout (no
// object copy, no working tree); only the clone fetches, through gh's
// credential helper. API answers and gzipped job logs are cached in --cache,
// so a re-run with new rules or signatures reads nothing from GitHub again.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(execFile);
const R = await import(new URL('../src/brain-rules.mjs', import.meta.url).href);

const argv = process.argv.slice(2);
const one = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };
const many = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
const GH = one('--gh');
const LOCAL = one('--local');
const CLONE = one('--clone');
const CACHE = one('--cache');
const SINCE = one('--since');
const UNTIL = one('--until', new Date().toISOString().slice(0, 10));
const OUT = one('--out');
const LOG_WORKFLOWS = new Set(many('--log-workflows'));
const CONCURRENCY = Math.max(1, Number(one('--concurrency', 4)));
const PER_COMMIT = argv.includes('--per-commit');
if (!GH || !LOCAL || !CLONE || !CACHE || !SINCE || !OUT) {
  console.error('usage: see the header of scripts/brain-rules-proof.mjs');
  process.exit(2);
}

const PRICE = { linux: 0.006, windows: 0.010, macos: 0.062, 'self-hosted': 0 };
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;
const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const jsonLines = (text) => String(text || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const day = (iso) => String(iso || '').slice(0, 10);

async function gh(args, { encoding = 'utf8' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await pexec('gh', args, { encoding, maxBuffer: 512 * 1024 * 1024, windowsHide: true })).stdout;
    } catch (error) {
      if (attempt >= 3 || /HTTP 40[34]|HTTP 410/.test(String(error.stderr || error.message))) throw error;
      await sleep(2000 * (attempt + 1));
    }
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}
fs.mkdirSync(path.join(CACHE, 'logs'), { recursive: true });
async function cachedJson(name, make) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = await make();
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

// ── rules and signatures ─────────────────────────────────────────────────────
const rules = many('--rules').flatMap((file) => {
  const doc = R.validateRulesDoc(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!doc.ok) { console.error(`${file}: ${doc.errors.join('; ')}`); process.exit(2); }
  return doc.rules.map((r) => ({ ...r, status: 'active', set: path.basename(file) }));
});
const ruleById = new Map(rules.map((r) => [r.id, r]));
const sigFile = one('--signatures');
const signatures = sigFile
  ? Object.entries(JSON.parse(fs.readFileSync(sigFile, 'utf8')))
    .filter(([id]) => ruleById.has(id))
    .map(([id, list]) => ({ id, res: list.map((s) => new RegExp(s)) }))
  : [];

// ── GitHub: runs (+ jobs of every attempt) and pull requests ────────────────
const repoInfo = JSON.parse(await gh(['api', `repos/${GH}`]));
const DEFAULT = repoInfo.default_branch;
const slices = [];
for (let t = Date.parse(`${SINCE}T00:00:00Z`); t <= Date.parse(`${UNTIL}T00:00:00Z`); t += 7 * 86_400_000) {
  const end = Math.min(t + 6 * 86_400_000, Date.parse(`${UNTIL}T00:00:00Z`));
  slices.push(`${day(new Date(t).toISOString())}..${day(new Date(end).toISOString())}`);
}
const RUN_FIELDS = '.workflow_runs[] | {id, name, event, head_sha, head_branch, conclusion, run_attempt, created_at, prs: [.pull_requests[] | {number, base: .base.sha}]}';
const JOB_FIELDS = '.jobs[] | {id, name, conclusion, started_at, completed_at, labels, run_attempt, steps: (.steps | length), failedSteps: [.steps[] | select(.conclusion == "failure") | .name]}';
const runs = await cachedJson(`runs-${SINCE}-${UNTIL}.json`, async () => {
  const byId = new Map();
  for (const slice of slices) {
    const got = jsonLines(await gh(['api', '--paginate', `repos/${GH}/actions/runs?per_page=100&created=${slice}`, '--jq', RUN_FIELDS]));
    if (got.length >= 1000) throw new Error(`slice ${slice} hit the 1,000-run cap; use smaller slices`);
    for (const r of got) byId.set(r.id, r);
    log(`runs ${slice}: ${got.length}`);
  }
  const list = [...byId.values()];
  let done = 0;
  await pool(list, CONCURRENCY, async (run) => {
    run.jobs = jsonLines(await gh(['api', '--paginate', `repos/${GH}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, '--jq', JOB_FIELDS]));
    if (++done % 100 === 0) log(`jobs: ${done}/${list.length} runs`);
  });
  return list;
});
const PR_FIELDS = '.[] | {number, head_ref: .head.ref, head_sha: .head.sha, base_sha: .base.sha, merged_at, created_at, updated_at, closed_at}';
const prs = await cachedJson(`prs-${SINCE}-${UNTIL}.json`, async () =>
  jsonLines(await gh(['api', '--paginate', `repos/${GH}/pulls?state=all&per_page=100&sort=updated&direction=desc`, '--jq', PR_FIELDS]))
    .filter((p) => p.updated_at >= SINCE));
log(`${runs.length} runs, ${prs.length} pull requests updated since ${SINCE}`);

// ── cost ─────────────────────────────────────────────────────────────────────
const osOf = (labels) => {
  const l = (labels || []).join(' ').toLowerCase();
  if (/self-hosted/.test(l)) return 'self-hosted';
  if (/windows/.test(l)) return 'windows';
  if (/macos|xcode/.test(l)) return 'macos';
  return 'linux';
};
const runnerLabels = new Map();
for (const run of runs) {
  for (const job of run.jobs || []) {
    const secs = job.started_at && job.completed_at ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000 : 0;
    job.os = osOf(job.labels);
    job.minutes = job.steps > 0 && secs > 0 ? Math.ceil(secs / 60) : 0;
    job.cost = job.minutes * PRICE[job.os];
    const key = (job.labels || []).join(',');
    runnerLabels.set(key, (runnerLabels.get(key) || 0) + job.minutes);
  }
  run.minutes = sum(run.jobs || [], (j) => j.minutes);
  run.cost = sum(run.jobs || [], (j) => j.cost);
  const attempts = new Map();
  for (const job of run.jobs || []) {
    const a = attempts.get(job.run_attempt) || { failed: false, cost: 0 };
    a.failed ||= job.conclusion === 'failure' && job.steps > 0;
    a.cost += job.cost;
    attempts.set(job.run_attempt, a);
  }
  run.failedAttempts = [...attempts.values()].filter((a) => a.failed).length;
  run.failedAttemptCost = sum([...attempts.values()].filter((a) => a.failed), (a) => a.cost);
  run.budgetBlocked = (run.jobs || []).some((j) => j.conclusion === 'failure' && j.steps === 0);
}

// ── PR ↔ run mapping ─────────────────────────────────────────────────────────
const prsByBranch = new Map();
for (const p of prs) prsByBranch.set(p.head_ref, [...(prsByBranch.get(p.head_ref) || []), p]);
for (const run of runs) {
  run.pr = run.prs?.[0]?.number ?? null;
  run.baseHint = run.prs?.[0]?.base ?? null;
  if (!run.pr && run.head_branch && run.head_branch !== DEFAULT) {
    const match = (prsByBranch.get(run.head_branch) || []).find((p) => p.created_at <= run.created_at && (!p.closed_at || p.closed_at >= run.created_at));
    if (match) run.pr = match.number;
  }
}
const prRuns = runs.filter((r) => r.pr && r.head_branch !== DEFAULT);
const prNumbers = new Set(prRuns.map((r) => r.pr));

// ── the clone ────────────────────────────────────────────────────────────────
const GIT_AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const git = (args, opts = {}) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
  cwd: CLONE, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...opts,
});
const gitTry = (args, opts) => { try { return git(args, opts); } catch { return null; } };
if (!fs.existsSync(path.join(CLONE, '.git'))) {
  log(`cloning ${LOCAL} → ${CLONE} (--shared --no-checkout)`);
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', LOCAL, CLONE], { stdio: 'ignore', windowsHide: true });
}
if (gitTry(['remote', 'get-url', 'gh']) === null) git(['remote', 'add', 'gh', `https://github.com/${GH}.git`]);
log(`fetching ${DEFAULT} and ${prs.length} PR heads from GitHub`);
git([...GIT_AUTH, 'fetch', '-q', '--no-tags', 'gh', `+refs/heads/${DEFAULT}:refs/remotes/gh/${DEFAULT}`], { timeout: 30 * 60_000 });
for (let i = 0; i < prs.length; i += 50) {
  const specs = prs.slice(i, i + 50).map((p) => `+refs/pull/${p.number}/head:refs/remotes/gh-pr/${p.number}`);
  if (gitTry([...GIT_AUTH, 'fetch', '-q', '--no-tags', 'gh', ...specs], { timeout: 30 * 60_000 }) === null) log(`fetch of PR heads ${i}..${i + 50} failed`);
}
function presentCommits(shas) {
  const list = [...new Set(shas.filter(Boolean))];
  if (!list.length) return new Set();
  const out = git(['cat-file', '--batch-check'], { input: `${list.map((s) => `${s}^{commit}`).join('\n')}\n` }).split('\n');
  return new Set(list.filter((_, i) => /^[0-9a-f]{40} commit /.test(out[i] || '')));
}
const wanted = [...prRuns.flatMap((r) => [r.head_sha, r.baseHint]), ...prs.flatMap((p) => [p.head_sha, p.base_sha])];
let present = presentCommits(wanted);
const missing = [...new Set(wanted.filter((s) => s && !present.has(s)))];
for (let i = 0; i < missing.length; i += 40) gitTry([...GIT_AUTH, 'fetch', '-q', '--no-tags', 'gh', ...missing.slice(i, i + 40)], { timeout: 10 * 60_000 });
if (missing.length) present = presentCommits(wanted);
log(`${missing.length} commits were not local; ${new Set(wanted.filter((s) => s && !present.has(s))).size} still unavailable (force-pushed away)`);

// The base branch as a run saw it: the PR's base sha the run recorded, else the
// first-parent default-branch commit current when the run started.
const mainLog = git(['log', '--first-parent', '--format=%H %ct', `refs/remotes/gh/${DEFAULT}`, `--since=${new Date(Date.parse(SINCE) - 365 * 86_400_000).toISOString()}`])
  .trim().split('\n').map((l) => { const [sha, t] = l.split(' '); return { sha, t: Number(t) }; });
const mainAt = (iso) => { const t = Date.parse(iso) / 1000; return (mainLog.find((c) => c.t <= t) || mainLog.at(-1))?.sha || null; };
const mergeBases = new Map();
const mergeBase = (a, b) => {
  const key = `${a} ${b}`;
  if (!mergeBases.has(key)) mergeBases.set(key, String(gitTry(['merge-base', a, b]) || '').trim() || null);
  return mergeBases.get(key);
};
function baseFor(sha, hint, iso) {
  if (!present.has(sha)) return null;
  for (const candidate of [hint && present.has(hint) ? hint : null, mainAt(iso)]) {
    if (!candidate) continue;
    const mb = mergeBase(sha, candidate);
    if (mb && mb !== sha) return mb;
  }
  return null;
}

// ── rules at every PR commit ─────────────────────────────────────────────────
// A listed-in finding whose every lacking registry is missing at that commit
// predates the registry, so the lesson could not have applied yet.
const predatesRegistry = (rule, finding) => rule.kind === 'listed-in'
  && String(finding.found.split(' is not in ')[1] || '').split(', ').every((part) => part.endsWith('(that file is missing)'));
const evaluations = new Map();
function evaluate(base, head) {
  const key = `${base}..${head}`;
  if (!evaluations.has(key)) {
    try {
      const diff = R.gitDiffSource(CLONE, { mode: 'range', base, head });
      const fired = [];
      const preRegistry = [];
      for (const x of R.runRules(rules, diff)) {
        const real = x.findings.filter((f) => !predatesRegistry(x.rule, f));
        if (real.length < x.findings.length) preRegistry.push({ id: x.rule.id, findings: x.findings.length - real.length });
        if (real.length) fired.push({ id: x.rule.id, severity: x.rule.severity, status: x.status, findings: real.map((f) => ({ file: f.file, line: f.line, found: f.found })) });
      }
      evaluations.set(key, { files: diff.files.length, fired, preRegistry });
    } catch (error) {
      evaluations.set(key, { error: String(error.message || error).slice(0, 200), fired: [], preRegistry: [] });
    }
  }
  return evaluations.get(key);
}
let evaluated = 0;
for (const run of prRuns) {
  run.base = baseFor(run.head_sha, run.baseHint, run.created_at);
  run.check = run.base ? evaluate(run.base, run.head_sha) : null;
  if (++evaluated % 200 === 0) log(`rules: ${evaluated}/${prRuns.length} PR runs`);
}
const firedAt = (run, id) => Boolean(run.check?.fired?.some((f) => f.id === id));
log(`rules evaluated at ${evaluations.size} distinct PR changes`);

// ── failed logs: ground truth ────────────────────────────────────────────────
const cleanLine = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 240);
async function jobLog(jobId) {
  const file = path.join(CACHE, 'logs', `${jobId}.txt.gz`);
  if (fs.existsSync(file)) return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const bytes = await gh(['api', `repos/${GH}/actions/jobs/${jobId}/logs`], { encoding: 'buffer' });
  fs.writeFileSync(file, zlib.gzipSync(bytes));
  return bytes.toString('utf8');
}
const failedJobs = runs.filter((r) => LOG_WORKFLOWS.has(r.name))
  .flatMap((run) => (run.jobs || []).filter((j) => j.conclusion === 'failure' && j.steps > 0).map((job) => ({ run, job })));
log(`reading ${failedJobs.length} failed job logs`);
await pool(failedJobs, CONCURRENCY, async ({ run, job }) => {
  let text;
  try { text = await jobLog(job.id); } catch { job.logUnavailable = true; return; }
  job.hits = {};
  for (const sig of signatures) {
    if (!sig.res.some((re) => re.test(text))) continue;
    const line = text.split('\n').find((l) => sig.res.some((re) => re.test(l)));
    job.hits[sig.id] = cleanLine(line || '');
  }
  run.hits = { ...(run.hits || {}), ...job.hits };
});

// ── merged PRs: silent rules, and whether the default branch fixed it later ─
const mainNow = `refs/remotes/gh/${DEFAULT}`;
const shown = new Map();
const fileOnMain = (file) => { if (!shown.has(file)) shown.set(file, gitTry(['show', `${mainNow}:${file}`])); return shown.get(file); };
function fixedOnMain(id, finding) {
  const rule = ruleById.get(id);
  if (rule.kind === 'listed-in') {
    const needle = (finding.found.match(/but `([^`]+)` is not in/) || [])[1];
    if (!needle) return null;
    const holds = (reg) => String(fileOnMain(reg) || '').includes(needle);
    return rule.registryMode === 'any' ? rule.registry.some(holds) : rule.registry.every(holds);
  }
  if (rule.kind === 'forbid-pattern') {
    const text = fileOnMain(finding.file);
    if (text === null) return true;
    return !new RegExp(rule.pattern, String(rule.flags || '').replace(/[^imsu]/g, '')).test(text);
  }
  return null;
}
const merged = prs.filter((p) => p.merged_at && day(p.merged_at) >= SINCE && day(p.merged_at) <= UNTIL);
const mergedFindings = [];
for (const p of merged) {
  const base = baseFor(p.head_sha, p.base_sha, new Date(Date.parse(p.merged_at) - 1000).toISOString());
  p.check = base ? evaluate(base, p.head_sha) : null;
  for (const f of p.check?.fired || []) {
    if (f.severity === 'advise') continue;
    mergedFindings.push({ pr: p.number, merged: day(p.merged_at), rule: f.id, findings: f.findings.map((x) => ({ ...x, fixedOnMainToday: fixedOnMain(f.id, x) })) });
  }
}

// ── per commit: what the pre-commit hook would have seen ────────────────────
const perCommit = [];
if (PER_COMMIT) {
  const blocking = rules.filter((r) => r.severity !== 'advise');
  const touches = (file) => blocking.some((r) => R.matchesGlobs(r.files, file) && !R.matchesGlobs(r.exclude, file));
  for (const p of prs) {
    const base = baseFor(p.head_sha, p.base_sha, p.merged_at || p.closed_at || p.updated_at);
    if (!base) continue;
    const text = gitTry(['log', '--no-merges', '--reverse', '--format=@%H %P', '--name-only', `${base}..${p.head_sha}`]) || '';
    const commits = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('@')) { const [sha, parent] = line.slice(1).split(' '); commits.push({ sha, parent, files: [] }); }
      else if (line.trim() && commits.length) commits.at(-1).files.push(line.trim());
    }
    const atHead = evaluate(base, p.head_sha);
    for (const c of commits.filter((x) => x.parent && x.files.some(touches))) {
      for (const f of evaluate(c.parent, c.sha).fired.filter((x) => x.severity !== 'advise')) {
        perCommit.push({ pr: p.number, commit: c.sha.slice(0, 7), rule: f.id, findings: f.findings.length, stillAtPrHead: atHead.fired.some((h) => h.id === f.id) });
      }
    }
  }
}

// ── the numbers ──────────────────────────────────────────────────────────────
const byWorkflow = {};
for (const run of runs) {
  const w = (byWorkflow[run.name] ||= { runs: 0, failedRuns: 0, failedAttempts: 0, reRuns: 0, minutes: 0, cost: 0, failedAttemptCost: 0, budgetBlockedRuns: 0, costByOs: {} });
  w.runs++;
  if (run.conclusion === 'failure') w.failedRuns++;
  w.failedAttempts += run.failedAttempts;
  w.reRuns += Math.max(0, (run.run_attempt || 1) - 1);
  w.minutes += run.minutes;
  w.cost += run.cost;
  w.failedAttemptCost += run.failedAttemptCost;
  if (run.budgetBlocked) w.budgetBlockedRuns++;
  for (const j of run.jobs || []) w.costByOs[j.os] = (w.costByOs[j.os] || 0) + j.cost;
}
for (const w of Object.values(byWorkflow)) {
  w.cost = round(w.cost); w.failedAttemptCost = round(w.failedAttemptCost);
  for (const k of Object.keys(w.costByOs)) w.costByOs[k] = round(w.costByOs[k]);
}
const failedSteps = {};
for (const { run, job } of failedJobs) {
  const key = `${run.name} › ${job.name} › ${(job.failedSteps || [])[0] || '(no step)'}`;
  const s = (failedSteps[key] ||= { jobs: 0, cost: 0, explainedBy: {} });
  s.jobs++; s.cost += job.cost;
  for (const id of Object.keys(job.hits || {})) s.explainedBy[id] = (s.explainedBy[id] || 0) + 1;
}
for (const s of Object.values(failedSteps)) s.cost = round(s.cost);

const preventable = prRuns.filter((run) => LOG_WORKFLOWS.has(run.name) && run.failedAttempts > 0
  && Object.keys(run.hits || {}).some((id) => ruleById.get(id).severity === 'block' && firedAt(run, id)));
const preventableShas = new Set(preventable.map((r) => r.head_sha));
const sameCommitRuns = prRuns.filter((r) => preventableShas.has(r.head_sha));

const perRule = {};
for (const rule of rules) {
  const fired = prRuns.filter((r) => firedAt(r, rule.id));
  const withSig = runs.filter((r) => (r.hits || {})[rule.id]).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const distinct = new Map();
  for (const run of fired) {
    for (const f of run.check.fired.find((x) => x.id === rule.id).findings) {
      const key = `${f.file}|${f.found}`;
      const d = distinct.get(key) || { file: f.file, line: f.line, found: f.found, prs: new Set(), runs: 0, ciPassed: 0, ciFailed: 0, firstSeen: run.created_at };
      d.prs.add(run.pr); d.runs++;
      if (LOG_WORKFLOWS.has(run.name)) { if (run.conclusion === 'success') d.ciPassed++; if (run.failedAttempts) d.ciFailed++; }
      if (run.created_at < d.firstSeen) d.firstSeen = run.created_at;
      distinct.set(key, d);
    }
  }
  perRule[rule.id] = {
    set: rule.set, kind: rule.kind, severity: rule.severity, card: rule.source.card,
    prRunsFired: fired.length,
    prsFired: [...new Set(fired.map((r) => r.pr))].sort((a, b) => a - b),
    preRegistryRuns: prRuns.filter((r) => r.check?.preRegistry?.some((x) => x.id === rule.id)).length,
    signature: signatures.some((s) => s.id === rule.id),
    runsWithSignature: withSig.map((r) => ({ run: r.id, workflow: r.name, pr: r.pr, branch: r.pr ? null : r.head_branch, sha: r.head_sha.slice(0, 7), created: r.created_at, attempts: r.run_attempt, checked: Boolean(r.check), ruleFired: r.check ? firedAt(r, rule.id) : null, evidence: r.hits[rule.id], cost: round(r.cost) })),
    distinctFindings: [...distinct.values()].map((d) => ({ ...d, prs: [...d.prs].sort((a, b) => a - b) })).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)),
    mergedWithFinding: mergedFindings.filter((m) => m.rule === rule.id),
    perCommit: perCommit.filter((c) => c.rule === rule.id),
  };
}
const ciRuns = runs.filter((r) => LOG_WORKFLOWS.has(r.name));
const summary = {
  repo: GH, private: repoInfo.private, window: `${SINCE}..${UNTIL}`, defaultBranch: DEFAULT,
  runs: runs.length, minutes: sum(runs, (r) => r.minutes), cost: round(sum(runs, (r) => r.cost)),
  prRuns: prRuns.length, prs: prNumbers.size, prCost: round(sum(prRuns, (r) => r.cost)),
  costPerPr: prNumbers.size ? round(sum(prRuns, (r) => r.cost) / prNumbers.size) : null,
  mergedPrs: merged.length,
  ciWorkflows: [...LOG_WORKFLOWS], ciRuns: ciRuns.length, ciCost: round(sum(ciRuns, (r) => r.cost)),
  ciFailedAttempts: sum(ciRuns, (r) => r.failedAttempts), ciFailedAttemptCost: round(sum(ciRuns, (r) => r.failedAttemptCost)),
  ciReRuns: sum(ciRuns, (r) => Math.max(0, (r.run_attempt || 1) - 1)),
  budgetBlockedRuns: runs.filter((r) => r.budgetBlocked).length,
  failedJobLogs: failedJobs.length, failedJobLogsUnavailable: failedJobs.filter((x) => x.job.logUnavailable).length,
  prRunsChecked: prRuns.filter((r) => r.check).length, prRunsUnavailable: prRuns.filter((r) => !r.check).length,
  distinctChangesChecked: evaluations.size,
  perCommitAlarms: perCommit.length,
  preventable: {
    runs: preventable.map((r) => ({ run: r.id, workflow: r.name, pr: r.pr, sha: r.head_sha.slice(0, 7), attempts: r.run_attempt, rules: Object.keys(r.hits).filter((id) => firedAt(r, id)), cost: round(r.cost) })),
    cost: round(sum(preventable, (r) => r.cost)),
    failedAttemptCost: round(sum(preventable, (r) => r.failedAttemptCost)),
    upperBoundAllRunsAtThoseCommits: round(sum(sameCommitRuns, (r) => r.cost)),
  },
  runnerLabelsMinutes: Object.fromEntries([...runnerLabels.entries()].sort((a, b) => b[1] - a[1])),
};
fs.writeFileSync(OUT, `${JSON.stringify({ summary, byWorkflow, failedSteps, perRule, method: 'scripts/brain-rules-proof.mjs header' }, null, 2)}\n`);
log(`wrote ${OUT}`);
console.log(JSON.stringify(summary, null, 2));
