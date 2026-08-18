// hook-quiet — the unified quiet switch + ephemeral-checkout awareness
// (2026-08-18 field incident: automatic writers — git commit capture, Stop
// capture, AGENTS.md projection, harness reconcile, registry registration —
// write-touched ephemeral release worktrees and broke a real desktop release
// build; the registry held ~20 throwaway entries).
//
// Locks the whole contract:
//   A. KLYPIX_BRAIN_QUIET=1 / .klypix-brain-quiet (env wins, both directions)
//      silences EVERY writer that can touch a checkout; reads keep working.
//   B. Linked worktrees + OS-temp trees are ephemeral: commit capture and
//      registration skip them by default; KLYPIX_BRAIN_WORKTREE_CAPTURE=1
//      opts a tree back in. Skips leave baselines alone — nothing is lost.
//   C. Reconcile skips quiet/ephemeral projects and prunes dead/temp rows.
//   D. The AGENTS.md brief block is canonical + counter-stable: one builder
//      for both writers, and a capture that changes no headline changes no byte.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  brainQuiet,
  ephemeralCheckout,
  isLinkedWorktree,
  isTempPath,
  QUIET_MARKER,
} from '../src/brain-quiet.mjs';
import {
  pruneRegisteredProjects,
  readRegisteredProjectBrains,
  reconcileRegisteredProjects,
  registerProjectBrain,
} from '../src/mcp-auto-update.mjs';
import { auditProject, compactAgentsBrief, linkProject } from '../src/agent-rules.mjs';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { agentsBriefBlock, parseKlypix } from '../src/klypix-format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const base = path.join(os.tmpdir(), `klypix-hook-quiet-${process.pid}`);
fs.rmSync(base, { recursive: true, force: true });
const tmp = (name) => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
const REAL_TREE = { KLYPIX_BRAIN_WORKTREE_CAPTURE: '1' };

// ── A. brainQuiet: env wins in both directions, marker fills the gap ─────────
{
  const dir = tmp('quiet-flags');
  ok(brainQuiet({ projectDir: dir, env: {} }).quiet === false, 'A: no env, no marker → not quiet');
  for (const v of ['1', 'true', 'on', 'yes']) {
    ok(brainQuiet({ projectDir: dir, env: { KLYPIX_BRAIN_QUIET: v } }).quiet === true, `A: KLYPIX_BRAIN_QUIET=${v} → quiet`);
  }
  ok(brainQuiet({ projectDir: dir, env: { KLYPIX_BRAIN_QUIET: '1' } }).source === 'env', 'A: env quiet reports source=env');
  fs.writeFileSync(path.join(dir, QUIET_MARKER), 'release build in progress\n');
  const marked = brainQuiet({ projectDir: dir, env: {} });
  ok(marked.quiet === true && marked.source === 'marker', 'A: .klypix-brain-quiet marker → quiet (source=marker)');
  ok(brainQuiet({ projectDir: dir, env: { KLYPIX_BRAIN_QUIET: '0' } }).quiet === false,
    'A: KLYPIX_BRAIN_QUIET=0 overrides the marker (env wins in both directions)');
  fs.rmSync(path.join(dir, QUIET_MARKER), { force: true });
}

// ── B. ephemeral detection: temp dirs, linked worktrees, main checkouts ──────
{
  ok(isTempPath(path.join(os.tmpdir(), 'anything')) === true, 'B: a path under os.tmpdir() is temp');
  ok(isTempPath(os.homedir()) === false, 'B: the home directory is not temp');
  ok(isTempPath(path.join('/somewhere-else', 'child'), { tmpdir: '/somewhere' }) === false, 'B: a sibling prefix ("/somewhere-else") does not match temp');
  ok(isTempPath(path.join('/somewhere', 'child'), { tmpdir: '/somewhere' }) === true, 'B: injected tmpdir is honored');

  const repo = tmp('eph-repo');
  const wt = path.join(base, 'eph-wt');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@klypix.local']);
  git(['config', 'user.name', 'klypix-test']);
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'chore: seed']);
  git(['worktree', 'add', '-b', 'feat/eph', wt]);

  ok(isLinkedWorktree(repo) === false, 'B: a main checkout (.git directory) is not a linked worktree');
  ok(isLinkedWorktree(wt) === true, 'B: a linked worktree (.git file) is detected');
  ok(isLinkedWorktree(tmp('eph-plain')) === false, 'B: a non-repo directory is not a worktree (fail-open)');

  // Inject a foreign tmpdir so the fixtures (which live under the real tmpdir)
  // exercise the WORKTREE prong in isolation.
  const away = { tmpdir: path.join(base, 'not-the-tmpdir') };
  ok(ephemeralCheckout({ projectDir: repo, env: {}, ...away }).ephemeral === false, 'B: main checkout is not ephemeral');
  const wtVerdict = ephemeralCheckout({ projectDir: wt, env: {}, ...away });
  ok(wtVerdict.ephemeral === true && wtVerdict.reason === 'linked-worktree', 'B: linked worktree is ephemeral (reason=linked-worktree)');
  const tempVerdict = ephemeralCheckout({ projectDir: repo, env: {} });
  ok(tempVerdict.ephemeral === true && tempVerdict.reason === 'temp-dir', 'B: an OS-temp main checkout is ephemeral (reason=temp-dir)');
  ok(ephemeralCheckout({ projectDir: wt, env: REAL_TREE, ...away }).ephemeral === false,
    'B: KLYPIX_BRAIN_WORKTREE_CAPTURE=1 opts a worktree back in');
}

// ── B. brain-git-hook: skips quiet + ephemeral trees, loses nothing ──────────
{
  const repo = tmp('git-hook-repo');
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@klypix.local']);
  git(['config', 'user.name', 'klypix-test']);
  fs.writeFileSync(path.join(repo, 'brain.klypix'), await buildKlypixMap({
    title: 'quiet fixture', kind: 'brain',
    areas: [{ title: 'Fixes', cards: [{ text: 'seed card' }] }],
  }));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'chore: seed']);
  const hook = path.join(root, 'src', 'brain-git-hook.mjs');
  const run = (env) => execFileSync(process.execPath, [hook, repo],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: { ...process.env, ...env } });
  run(REAL_TREE);                                        // baseline to HEAD
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');
  git(['add', '.']);
  git(['commit', '-m', 'feat(quiet): capture-worthy change with a rationale body\n\nThe rationale body is long enough to satisfy the capture gate.']);

  const before = fs.readFileSync(path.join(repo, 'brain.klypix'));
  run({});                                               // DEFAULT env: repo is under os.tmpdir() → ephemeral skip
  ok(fs.readFileSync(path.join(repo, 'brain.klypix')).equals(before),
    'B: the git hook does not write a brain in an ephemeral checkout by default');

  fs.writeFileSync(path.join(repo, QUIET_MARKER), '');
  run(REAL_TREE);                                        // opted in, but QUIET marker present
  ok(fs.readFileSync(path.join(repo, 'brain.klypix')).equals(before),
    'B: the quiet marker beats the worktree opt-in (quiet is checked first)');
  fs.rmSync(path.join(repo, QUIET_MARKER), { force: true });

  run(REAL_TREE);                                        // opted in, not quiet → the skipped commit still lands
  const { struct } = await parseKlypix(fs.readFileSync(path.join(repo, 'brain.klypix')));
  ok((struct.cards || []).some((c) => /capture-worthy change/.test(String(c.text || ''))),
    'B: a skipped range re-scans once opted back in — the skip loses nothing');
}

// ── A. global-brain-hook Stop capture: quiet = read-only no-op ───────────────
{
  const repo = tmp('stop-repo');
  const home = tmp('stop-home');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'brain.klypix'), await buildKlypixMap({
    title: 'stop fixture', kind: 'brain',
    areas: [{ title: 'Decisions', cards: [{ text: 'seed decision' }] }],
  }));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'),
    '# Project law\n\n<!-- klypix-brain-brief:start -->\nplaceholder\n<!-- klypix-brain-brief:end -->\n');
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '🧠 BRAIN [Decisions]: quiet mode must gate every checkout writer' }] },
  }) + '\n');
  const hook = path.join(root, 'src', 'global-brain-hook.mjs');
  const runCapture = (env) => execFileSync(process.execPath, [hook, '--capture'], {
    cwd: repo,
    input: JSON.stringify({ session_id: 'hook-quiet-session', transcript_path: transcript }),
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', ...env },
  });

  const brainBefore = fs.readFileSync(path.join(repo, 'brain.klypix'));
  const agentsBefore = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  runCapture({ KLYPIX_BRAIN_QUIET: '1' });
  ok(fs.readFileSync(path.join(repo, 'brain.klypix')).equals(brainBefore),
    'A: a quiet Stop capture leaves brain.klypix byte-identical');
  ok(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8') === agentsBefore,
    'A: a quiet Stop capture leaves AGENTS.md byte-identical');
  ok(!fs.existsSync(path.join(repo, '.claude', 'brain-capture-state.json')),
    'A: a quiet Stop capture advances no capture state (markers stay re-gatherable)');

  runCapture({});                                        // not quiet → the same marker lands now
  const { struct } = await parseKlypix(fs.readFileSync(path.join(repo, 'brain.klypix')));
  // tidy line-wraps card text — normalize whitespace before matching content.
  ok((struct.cards || []).some((c) => /gate every checkout writer/.test(String(c.text || '').replace(/\s+/g, ' '))),
    'A: removing quiet captures the marker the quiet run skipped — nothing lost');
  const agentsAfter = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  ok(/compact fallback only — auto-refreshed from brain\.klypix/.test(agentsAfter),
    'D: the capture-refreshed AGENTS.md block carries the ONE canonical comment line');
  const { struct: after } = await parseKlypix(fs.readFileSync(path.join(repo, 'brain.klypix')));
  ok(agentsAfter.includes(agentsBriefBlock(after)),
    'D: the hook-written block is byte-identical to the canonical builder (no writer ping-pong)');
}

// ── D. brief-block stability: counter drift changes no byte ──────────────────
{
  const cards = (n, prefix) => Array.from({ length: n }, (_, i) => ({ text: `${prefix} note ${i + 1}` }));
  const mk = (extra) => buildKlypixMap({
    title: 'stability', kind: 'brain',
    areas: [
      { title: 'Notes', cards: cards(22 + extra, 'routine') },
      { title: 'Open questions', cards: [{ text: '❓ Should the brief embed counters?' }] },
    ],
  });
  const a = (await parseKlypix(await mk(0))).struct;
  const b = (await parseKlypix(await mk(0))).struct;
  const c = (await parseKlypix(await mk(1))).struct;   // +1 card in an area — headline-invisible
  ok(agentsBriefBlock(a) === agentsBriefBlock(b), 'D: same brain → byte-identical block (deterministic)');
  ok(agentsBriefBlock(a) === agentsBriefBlock(c),
    'D: one more area card (counter drift only) → byte-identical block, so AGENTS.md is not rewritten');
  ok(!/\b22 cards\b|\b23 cards\b/.test(agentsBriefBlock(a)), 'D: the block carries no exact volatile card count');
  ok(/❓ Should the brief embed counters\?/.test(agentsBriefBlock(a)), 'D: open questions still surface in the block');
}

// ── B/C. registration + registry hygiene ─────────────────────────────────────
{
  const brainDir = tmp('registry-home');
  const proj = tmp('registry-proj');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'fixture');

  const skipped = registerProjectBrain({ brainPath: path.join(proj, 'brain.klypix'), brainDir });
  ok(skipped.registered === false && skipped.skipped === true && skipped.reason === 'temp-dir',
    'B: registration refuses an OS-temp checkout by default (skipped, reason=temp-dir)');
  ok(!fs.existsSync(path.join(brainDir, 'registry.json')), 'B: a refused registration writes no registry file');

  const quiet = registerProjectBrain({ brainPath: path.join(proj, 'brain.klypix'), brainDir, env: { ...REAL_TREE, KLYPIX_BRAIN_QUIET: '1' } });
  ok(quiet.skipped === true && quiet.reason === 'quiet', 'A: a quiet tree never registers (reason=quiet)');

  const accepted = registerProjectBrain({ brainPath: path.join(proj, 'brain.klypix'), brainDir, env: REAL_TREE });
  ok(accepted.registered === true, 'B: KLYPIX_BRAIN_WORKTREE_CAPTURE=1 registers the tree as a real project');

  // Prune: a dead row goes; with the opt-in env the live temp row stays.
  const deadPath = path.join(os.homedir(), `klypix-missing-${process.pid}`, 'brain.klypix');
  const regFile = path.join(brainDir, 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  reg.brains.push({ path: deadPath, project: 'ghost', lastSeen: 1 });
  fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
  const keepTempReceipt = pruneRegisteredProjects({ brainDir, env: REAL_TREE });
  const keptRows = JSON.parse(fs.readFileSync(regFile, 'utf8')).brains;
  ok(keepTempReceipt.pruned === 1 && keptRows.length === 1 && keptRows[0].path.includes('registry-proj'),
    'C: prune removes a row whose brain no longer exists and keeps the opted-in live row');
  const defaultReceipt = pruneRegisteredProjects({ brainDir });
  ok(defaultReceipt.pruned === 1 && JSON.parse(fs.readFileSync(regFile, 'utf8')).brains.length === 0,
    'C: with default env, prune also removes OS-temp rows (throwaway checkouts leave no durable row)');
}

// ── C. reconcile: skips quiet/ephemeral projects, prunes on sight ────────────
{
  const brainDir = tmp('reconcile-home');
  const proj = tmp('reconcile-proj');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'fixture');
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Keep me\n');
  registerProjectBrain({ brainPath: path.join(proj, 'brain.klypix'), brainDir, env: REAL_TREE });
  const rules = { auditProject, compactAgentsBrief, linkProject };
  // The quiet marker is test scaffolding, not project content — exclude it.
  const snapshot = () => fs.readdirSync(proj).filter((f) => f !== QUIET_MARKER).sort().join('|')
    + '::' + fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');

  const before = snapshot();
  const skippedRun = await reconcileRegisteredProjects({ brainDir, version: '1.5.2', rules });
  ok(skippedRun.skipped >= 1 && skippedRun.projects.some((p) => p.reason === 'temp-dir'),
    'C: a registry-driven reconcile skips an OS-temp project (reason=temp-dir)');
  ok(snapshot() === before, 'C: the skipped project is not write-touched at all');
  ok(JSON.parse(fs.readFileSync(path.join(brainDir, 'registry.json'), 'utf8')).brains.length === 0
    && skippedRun.pruned === 1,
    'C: the same pass prunes the temp row on sight (receipt carries pruned=1)');

  registerProjectBrain({ brainPath: path.join(proj, 'brain.klypix'), brainDir, env: REAL_TREE });
  fs.writeFileSync(path.join(proj, QUIET_MARKER), '');
  const quietRun = await reconcileRegisteredProjects({ brainDir, version: '1.5.2', rules, env: REAL_TREE });
  ok(quietRun.skipped === 1 && quietRun.projects[0]?.reason === 'quiet' && snapshot() === before,
    'A: a quiet marker stops the reconcile from touching the project (and does not prune its row)');
  fs.rmSync(path.join(proj, QUIET_MARKER), { force: true });

  const realRun = await reconcileRegisteredProjects({ brainDir, version: '1.5.2', rules, env: REAL_TREE });
  const converged = realRun.projects[0];
  ok(realRun.checked === 1 && ['updated', 'unchanged', 'partial'].includes(converged?.status),
    'C: with the opt-in env the same project reconciles normally (zero behavior change when opted in)');

  // Explicit brainPaths (the per-sync path brain_sync uses) honors the same skips.
  fs.writeFileSync(path.join(proj, QUIET_MARKER), '');
  const explicitRun = await reconcileRegisteredProjects({
    brainDir, version: '1.5.2', rules, env: REAL_TREE,
    brainPaths: [path.join(proj, 'brain.klypix')],
  });
  ok(explicitRun.skipped === 1 && explicitRun.projects[0]?.reason === 'quiet',
    'A: the explicit per-sync reconcile path honors the quiet marker too');
  fs.rmSync(path.join(proj, QUIET_MARKER), { force: true });
}

// ── A. projection writers: linkProject + compactAgentsBrief go quiet ─────────
{
  const proj = tmp('link-proj');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'fixture');
  fs.writeFileSync(path.join(proj, QUIET_MARKER), '');
  const res = linkProject(proj, { version: '1.5.2' });
  ok(res.quiet === true && [...res.rules, ...res.mcp].every((f) => f.action === 'skipped'),
    'A: a write-mode link in a quiet tree skips every target and says why');
  ok(!fs.existsSync(path.join(proj, 'AGENTS.md')) && !fs.existsSync(path.join(proj, '.cursor')),
    'A: the quiet link created no files');
  const audit = auditProject(proj, { version: '1.5.2' });
  ok(audit.files.length > 0 && audit.ok === false,
    'A: the read-only audit still runs in a quiet tree (reads are allowed)');

  fs.writeFileSync(path.join(proj, 'AGENTS.md'),
    '# Law\n\n<!-- klypix-brain-brief:start -->\nold\n<!-- klypix-brain-brief:end -->\n');
  const compactQuiet = await compactAgentsBrief(proj);
  ok(compactQuiet.action === 'skipped' && /quiet/.test(compactQuiet.reason || '')
    && /\nold\n/.test(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8')),
    'A: compactAgentsBrief refuses to rewrite AGENTS.md in a quiet tree');
  fs.rmSync(path.join(proj, QUIET_MARKER), { force: true });
}

fs.rmSync(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall green');
process.exit(failures ? 1 : 0);
