// Whose is this? (1.104.0) — the hooks end to end on a REAL git repository.
//
// Session A (Codex) leaves uncommitted work; session B (Claude Code) runs git
// commands through the real global-brain-hook.mjs (--live PostToolUse records
// B's edits, --guard PreToolUse decides). The contract:
//   W1  a sweeping command that would carry A's work is DENIED, naming A, and
//       hands B the narrow command for B's own files;
//   W2  B committing only its own files passes untouched;
//   W3  naming A's file explicitly (also through an earlier `git add` in the
//       same chain) is denied;
//   W4  a discarding command asks a human (rescue copy saved first) and is
//       denied when no human can answer;
//   W5  `git status` tells B which dirty files are A's (anti-stall context);
//   W6  shadow mode only logs and shows context; off says nothing;
//   W7  nobody else's edits → the hook says nothing (fast path);
//   W8  from a subfolder the check still finds the brain;
//   W9  once A's work is committed, it no longer counts as A's.
//   W10 once A has STOPPED, a sweep gets context (a continuing session may finish
//       and commit A's leftovers); a discard still asks.
//
// Run:  node test/whose-hook.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import { upsertSession, endSession, listActiveSessions } from '../src/agent-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
let checks = 0;
const ok = (c, label, detail) => { checks++; if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500)); assert.ok(c, label); console.log(`[ok] ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-whose-hook-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
const git = (...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
write('src/tax.js', 'export const rate = 0.1;\n');
write('src/mine.js', 'export const x = 1;\n');
write('src/deep/keep.js', 'export const k = 1;\n');
write('.gitignore', '.klypix/\n');
fs.writeFileSync(path.join(repo, 'brain.klypix'), await buildKlypixMap({ title: 'whose test', kind: 'brain', areas: [{ title: 'Billing', cards: [{ text: 'Billing: rates live in src/tax.js' }] }] }));
git('add', '-A'); git('commit', '-q', '-m', 'base');

const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0' };
delete env.KLYPIX_WHOSE; delete env.KLYPIX_SESSION_ID;
const hook = (mode, input, extraEnv = {}) => {
  const out = execFileSync(process.execPath, [HOOK, mode], { cwd: input.cwd || repo, env: { ...env, ...extraEnv }, encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] });
  try { return out.trim() ? JSON.parse(out) : null; } catch { return { raw: out }; }
};
const A = '01a0ece0-aaaa-7852-acb5-0e0bea0742c9';   // Codex
const B = 'b91b1d19-bbbb-4d9a-a620-741ff2e8fada';   // Claude Code
const bash = (command, extra = {}) => ({ session_id: B, tool_name: 'Bash', tool_input: { command }, cwd: repo, permission_mode: 'default', hook_event_name: 'PreToolUse', ...extra });
const decision = (r) => r?.hookSpecificOutput?.permissionDecision || (r?.hookSpecificOutput?.additionalContext ? 'context' : null);
const reason = (r) => r?.hookSpecificOutput?.permissionDecisionReason || r?.hookSpecificOutput?.additionalContext || '';

try {
  // W7 first: nobody else has edits yet.
  write('src/mine.js', 'export const x = 2;\n');
  hook('--live', { session_id: B, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'mine.js') }, cwd: repo, hook_event_name: 'PostToolUse' });
  ok(hook('--guard', bash('git add -A && git commit -m wip')) === null, 'W7 with only my own edits the guard says nothing');

  // A (Codex) edits tax.js — recorded the way the Codex hook records it.
  write('src/tax.js', 'export const rate = 0.15; // A: new rate, not finished\n');
  const whose = await import('../src/whose.mjs');
  const prevHome = process.env.HOME; const prevUP = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  const n = await whose.recordEdits({ brainPath: path.join(repo, 'brain.klypix'), sid: A, client: 'codex', cwd: repo, files: ['src/tax.js'], home });
  process.env.HOME = prevHome; process.env.USERPROFILE = prevUP;
  ok(n === 1, 'setup: Codex edit of src/tax.js recorded in the ledger');
  const brainPath = path.join(repo, 'brain.klypix');
  upsertSession({ brainPath, home, id: A, client: 'codex', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: A, identitySource: 'codex-lifecycle', intent: 'new tax rate', files: ['src/tax.js'] });

  // W1
  const sweep = hook('--guard', bash('git add -A && git commit -m wip'));
  ok(decision(sweep) === 'deny' && /src\/tax\.js/.test(reason(sweep)) && /Codex session 01a0ece0/.test(reason(sweep)) && /git add -- src\/mine\.js/.test(reason(sweep)), 'W1 `git add -A` with Codex\'s uncommitted work is denied, naming Codex and giving my narrow command', sweep);
  const commitAll = hook('--guard', bash('git commit -am wip'));
  ok(decision(commitAll) === 'deny', 'W1 `git commit -am` is denied too', commitAll);
  const ps = hook('--guard', { ...bash('git add . ; git commit -m wip'), tool_name: 'PowerShell' });
  ok(decision(ps) === 'deny', 'W1 the PowerShell tool is covered', ps);

  // W2
  const narrow = hook('--guard', bash('git add -- src/mine.js && git commit -m "mine"'));
  ok(narrow === null || decision(narrow) === 'context', 'W2 committing only my own file is not blocked', narrow);

  // W3
  const named = hook('--guard', bash('git add src/tax.js'));
  ok(decision(named) === 'deny' && /tax\.js/.test(reason(named)), 'W3 naming Codex\'s file explicitly is denied', named);
  const chained = hook('--guard', bash('git add src/mine.js src/tax.js && git commit -m x'));
  ok(decision(chained) === 'deny', 'W3 an explicit add of Codex\'s file earlier in the chain is denied', chained);

  // W4
  const reset = hook('--guard', bash('git reset --hard'));
  ok(decision(reset) === 'ask' && /rescue copy/i.test(reason(reset)) && /npx klypix-mcp rescue restore/.test(reason(reset)), 'W4 `git reset --hard` asks the human, with a rescue copy saved first', reset);
  ok(git('for-each-ref', '--format=%(refname)', 'refs/klypix/rescue/').split('\n').filter(Boolean).length >= 1, 'W4 the rescue copy exists as a git ref');
  ok(fs.readFileSync(path.join(repo, 'src', 'tax.js'), 'utf8').includes('0.15'), 'W4 nothing in the working tree changed');
  const resetBypass = hook('--guard', bash('git checkout -- src/tax.js', { permission_mode: 'bypassPermissions' }));
  ok(decision(resetBypass) === 'deny' && /tell the human/.test(reason(resetBypass)), 'W4 with no human to ask (bypass), a discard is denied', resetBypass);
  const stash = hook('--guard', bash('git stash'));
  ok(decision(stash) === 'ask' && /stash away/.test(reason(stash)), 'W4 `git stash` asks too', stash);

  // W5
  const status = hook('--guard', bash('git status'));
  ok(decision(status) === 'context' && /another session/.test(reason(status)) && /tax\.js/.test(reason(status)), 'W5 `git status` tells me which dirty files are another session\'s', status);

  // W6
  const shadow = hook('--guard', bash('git add -A'), { KLYPIX_WHOSE: 'shadow' });
  ok(decision(shadow) === 'context' && /shadow mode/.test(reason(shadow)), 'W6 shadow mode shows context only', shadow);
  ok(fs.existsSync(path.join(home, '.claude', 'project-brain', 'whose-decisions.jsonl')), 'W6 shadow mode logs the would-be decision');
  const off = hook('--guard', bash('git add -A'), { KLYPIX_WHOSE: 'off' });
  ok(off === null, 'W6 off says nothing', off);

  // W8
  const sub = hook('--guard', bash('git add -A', { cwd: path.join(repo, 'src', 'deep') }));
  ok(decision(sub) === 'deny', 'W8 from a subfolder the guard still finds the brain and denies', sub);

  // W10: once Codex has STOPPED, its leftovers may be finished by whoever continues: a sweep gets context, not a deny; a discard still asks.
  endSession({ brainPath, home, id: A });
  const stoppedSweep = hook('--guard', bash('git add -A && git commit -m continue'));
  ok(decision(stoppedSweep) === 'context' && /has stopped/.test(reason(stoppedSweep)) && /continuing that session/.test(reason(stoppedSweep)), "W10 a stopped session's leftovers: a sweep gets context (finish them if you are continuing its work), not a deny", stoppedSweep);
  const stoppedReset = hook('--guard', bash('git reset --hard'));
  ok(decision(stoppedReset) === 'ask', "W10 discarding a stopped session's leftovers still asks the human", stoppedReset);

  // W9: A commits its work; it is no longer A's uncommitted work.
  git('add', 'src/tax.js'); git('commit', '-q', '-m', 'A: new rate');
  const after = hook('--guard', bash('git add -A && git commit -m mine'));
  ok(after === null || decision(after) === 'context', 'W9 once Codex committed its file, my sweep is no longer blocked', after);

  // W11: Claude Code's SessionEnd hook (--end) takes the session off the lane at once.
  const C2 = 'c2c2c2c2-dddd-4eee-8fff-000000000011';
  upsertSession({ brainPath, home, id: C2, client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', logicalSessionId: C2, identitySource: 'claude-lifecycle', intent: 'about to be cut off', files: ['src/mine.js'] });
  ok(listActiveSessions({ brainPath, home }).some((r) => r.id === C2), 'W11 setup: the session is live on the lane');
  hook('--end', { session_id: C2, cwd: path.join(repo, 'src'), hook_event_name: 'SessionEnd', reason: 'other' });
  ok(!listActiveSessions({ brainPath, home }).some((r) => r.id === C2), 'W11 SessionEnd (--end) takes the session off the lane immediately, found from a subfolder');

  console.log(`\nwhose-hook: all ${checks} assertions passed`);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }
}
