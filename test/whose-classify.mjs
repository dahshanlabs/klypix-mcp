// "Whose is this?" classifier (klypix-mcp 1.103.0): table test for src/whose-classify.mjs.
//
// The classifier is pure, so almost every check is one command in and one expected reading out.
// The table covers every tier; the false-positive guards (quotes, comments, echo/printf strings,
// commit messages, here-docs, git help); chains (&&, ||, ;, |, newlines); git -C, -c k=v, cd
// tracking and env-assignment prefixes; the PowerShell dialect (backtick escapes, both quote styles,
// `;` chains, the `&` call operator, here-strings); nested shells; and the chain simulation
// (stagedBeforeCommit). After the table:
//   R1 the result contract (fields, types, strongest, staging keys, determinism, the gate)
//   R2 purity: the module imports only node:path and reads no process state but the platform
//   R3 the embedded option tables still match the local git's own `git <verb> -h` (strict on the
//      Git version they were generated from, informational on any other)
//
// Run: node test/whose-classify.mjs   (exit 0 = pass). The only thing it writes is a throwaway git
// repository under os.tmpdir() for R3, removed at the end.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { classifyCommand, TIERS, tierRank, mentionsGit, GIT_OPTION_SPECS, GIT_HIDDEN_OPTION_SPECS } from '../src/whose-classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BS = String.fromCharCode(92);
const LDQ = String.fromCharCode(0x201c);
const RDQ = String.fromCharCode(0x201d);

let pass = 0;
let fail = 0;
const ok = (condition, label, detail) => {
  if (condition) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
};

// ── the table ───────────────────────────────────────────────────────────────
// expect keys: ok, strongest, steps (count), gitCount, step (first git step, partial), git (every
// git step in order, partial), staged (stagedBeforeCommit, exact), reason / noReason (regex over
// reasons), dialect. Partial step keys compare exactly, except flags (must include) and noFlags
// (must not include).
const CASES = [];
const C = (label, command, expect, opts = {}) => CASES.push({ label, command, expect, dialect: 'dialect' in opts ? opts.dialect : 'posix', platform: opts.platform ?? 'win32' });
const PS = { dialect: 'powershell' };

// A — READ and SAFE
C('status is READ', 'git status', { ok: true, strongest: 'READ', step: { sub: 'status', tier: 'READ', git: true } });
C('status with porcelain options is READ', 'git status --porcelain=v1 -z -uall', { strongest: 'READ' });
C('diff --stat is READ', 'git diff --stat', { strongest: 'READ', step: { sub: 'diff' } });
C('diff --cached is READ', 'git diff --cached', { strongest: 'READ' });
C('log --oneline is SAFE', 'git log --oneline -5', { strongest: 'SAFE', step: { sub: 'log', tier: 'SAFE' } });
C('log --stat is READ', 'git log --stat -3', { strongest: 'READ' });
C('show --name-only is READ', 'git show --name-only HEAD', { strongest: 'READ' });
C('log -S value is data, not --stat', 'git log -S "--stat" --oneline', { strongest: 'SAFE' });
C('ls-files -m is READ', 'git ls-files -m', { strongest: 'READ' });
C('plain ls-files is SAFE', 'git ls-files', { strongest: 'SAFE', step: { sub: 'ls-files' } });
C('fetch is SAFE', 'git fetch origin', { ok: true, strongest: 'SAFE' });
C('push is SAFE', 'git push origin main', { strongest: 'SAFE', step: { sub: 'push' } });
C('branch -D is SAFE', 'git branch -D old', { strongest: 'SAFE' });
C('git help reset is SAFE', 'git help reset', { ok: true, strongest: 'SAFE', step: { sub: 'help', tier: 'SAFE' } });
C('reset --hard -h is SAFE', 'git reset --hard -h', { ok: true, strongest: 'SAFE', step: { sub: 'reset', tier: 'SAFE' } });
C('reset --hard --help is SAFE', 'git reset --hard --help', { strongest: 'SAFE' });
C('git --version is SAFE', 'git --version', { ok: true, strongest: 'SAFE', step: { sub: null } });
C('bare git is SAFE', 'git', { ok: true, strongest: 'SAFE', gitCount: 1, step: { sub: null } });
C('a non-git command has no git step', 'ls -la', { ok: true, strongest: 'SAFE', steps: 1, gitCount: 0 });
C('git grep pattern is data', 'git grep "git add -A"', { strongest: 'SAFE', gitCount: 1, step: { sub: 'grep' } });
C('log --grep value is data', 'git log --grep="reset --hard"', { strongest: 'SAFE' });
C('--no-pager diff is READ', 'git --no-pager diff', { strongest: 'READ', step: { flags: ['--no-pager'] } });
C('apply is SAFE', 'git apply fix.patch', { strongest: 'SAFE' });
C('mv is SAFE', 'git mv a.ts b.ts', { strongest: 'SAFE' });
C('an empty command', '', { ok: true, steps: 0, strongest: 'SAFE', staged: {} });
C('log --format value is data', "git log --format='%h git reset --hard'", { strongest: 'SAFE', gitCount: 1 });

// B — add
C('add -A sweeps the whole tree', 'git add -A', { ok: true, strongest: 'SWEEP', step: { sub: 'add', tier: 'SWEEP', scope: 'all', paths: null, flags: ['--all'] } });
C('add . sweeps', 'git add .', { strongest: 'SWEEP', step: { scope: 'all', paths: ['.'] } });
C('add :/ sweeps', 'git add :/', { strongest: 'SWEEP' });
C('add -u sweeps tracked files', 'git add -u', { strongest: 'SWEEP', step: { scope: 'tracked', paths: null } });
C('add --all sweeps', 'git add --all', { strongest: 'SWEEP', step: { scope: 'all' } });
C('add -- a.ts is EXPLICIT', 'git add -- a.ts', { ok: true, strongest: 'EXPLICIT', step: { tier: 'EXPLICIT', scope: 'paths', paths: ['a.ts'] } });
C('add a.ts b.ts is EXPLICIT', 'git add a.ts b.ts', { strongest: 'EXPLICIT', step: { paths: ['a.ts', 'b.ts'] } });
C('add -n . is a dry run', 'git add -n .', { strongest: 'SAFE' });
C('add -p is interactive', 'git add -p', { strongest: 'SAFE' });
C('add -N is intent only', 'git add -N a.ts', { strongest: 'SAFE' });
C('add src/ (a directory) sweeps', 'git add src/', { strongest: 'SWEEP', step: { paths: ['src/'] } });
C('quoted glob reaches git: broad', "git add 'src/*.ts'", { ok: true, strongest: 'SWEEP', step: { paths: ['src/*.ts'] } });
C('unquoted glob is expanded by the shell: unverified', 'git add *.ts', { ok: false, strongest: 'SWEEP', step: { ok: false } });
C('$FILES pathspec is unverified', 'git add $FILES', { ok: false, step: { tier: 'SWEEP' }, reason: /\$FILES is only known/ });
C('"$f" pathspec is unverified', 'git add "$f"', { ok: false });
C('add --renormalize sweeps tracked', 'git add --renormalize', { strongest: 'SWEEP', step: { scope: 'tracked' } });
C('add -f of one file stays EXPLICIT', 'git add -f build/out.js', { strongest: 'EXPLICIT', step: { flags: ['--force'] } });
C('add -f . sweeps, ignored files included', 'git add -f .', { strongest: 'SWEEP', step: { flags: ['--force'] } });
C('add --pathspec-from-file is unverified', 'git add --pathspec-from-file=list.txt', { ok: false, strongest: 'SWEEP' });
C('add -A limited to a file is EXPLICIT', 'git add -A -- a.ts', { strongest: 'EXPLICIT', step: { paths: ['a.ts'] } });
C('git stage is add', 'git stage -A', { strongest: 'SWEEP', step: { sub: 'add' } });
C('add with nothing adds nothing', 'git add', { strongest: 'SAFE', step: { sub: 'add' } });
C('exclusion pathspec keeps the sweep', "git add -A -- . ':(exclude,literal)src/tax.ts'", { strongest: 'SWEEP', step: { paths: ['.', ':(exclude,literal)src/tax.ts'] } });
C(':(literal) [token] path is EXPLICIT', "git add ':(literal)admin/app/ai/[token]/route.ts'", { strongest: 'EXPLICIT' });
C('[token] without literal magic is a glob', "git add 'admin/app/ai/[token]/route.ts'", { strongest: 'SWEEP' });
C('--literal-pathspecs makes brackets literal', "git --literal-pathspecs add 'a[b].txt'", { strongest: 'EXPLICIT', step: { flags: ['--literal-pathspecs'] } });
C('brace expansion is expanded', 'git add src/{a,b}.ts', { ok: true, strongest: 'EXPLICIT', step: { paths: ['src/a.ts', 'src/b.ts'] } });
C('add -u src/ sweeps tracked in scope', 'git add -u src/', { strongest: 'SWEEP', step: { scope: 'tracked', paths: ['src/'] } });
C('only an exclusion: git starts from the whole tree', "git add ':!secret.txt'", { strongest: 'SWEEP' });
C('path with spaces', 'git add -- "path with spaces.txt"', { strongest: 'EXPLICIT', step: { paths: ['path with spaces.txt'] } });
C('unicode path', "git add 'données/été.txt'", { ok: true, strongest: 'EXPLICIT', step: { paths: ['données/été.txt'] } });
C('add .. sweeps the parent', 'git add ..', { strongest: 'SWEEP' });
C('add -A $(…) runs ls-files and is unverified', 'git add -A $(git ls-files -m)', { ok: false, git: [{ sub: 'ls-files', tier: 'READ' }, { sub: 'add', tier: 'SWEEP', ok: false }] });

// C — commit
C('plain commit sweeps the shared index', 'git commit -m "fix"', { ok: true, strongest: 'SWEEP', step: { sub: 'commit', scope: 'index', paths: null, flags: ['--message'] }, staged: { 0: [] } });
C('commit -am is -a plus a message', 'git commit -am "x"', { strongest: 'SWEEP', step: { scope: 'tracked', flags: ['--all', '--message'] } });
C('commit -ma is the message "a"', 'git commit -ma', { strongest: 'SWEEP', step: { scope: 'index', flags: ['--message'], noFlags: ['--all'] } });
C('message text is data', 'git commit -m "reset --hard"', { gitCount: 1, strongest: 'SWEEP' });
C('commit -- a.ts is EXPLICIT', 'git commit -- a.ts', { strongest: 'EXPLICIT', step: { scope: 'paths', paths: ['a.ts'] } });
C('commit -m x a.ts b.ts is EXPLICIT', 'git commit -m x a.ts b.ts', { strongest: 'EXPLICIT', step: { paths: ['a.ts', 'b.ts'] } });
C('--amen abbreviates --amend', 'git commit --amen -m x', { strongest: 'SWEEP', step: { scope: 'index', flags: ['--amend'] } });
C('--no-verify is reported as a bypass', 'git commit --no-verify -m x', { reason: /bypassed \(--no-verify\)/ });
C('-n is --no-verify', 'git commit -n -m x', { step: { flags: ['--no-verify'] }, reason: /bypassed/ });
C('--verify after --no-verify wins', 'git commit --no-verify --verify -m x', { noReason: /bypassed/ });
C('--dry-run is SAFE', 'git commit --dry-run', { strongest: 'SAFE' });
C('--fixup takes a value, not a path', 'git commit --fixup abc123', { strongest: 'SWEEP', step: { scope: 'index', paths: null } });
C('--trailer takes a value', 'git commit --trailer "Co-authored-by: x" -m y', { step: { scope: 'index', paths: null } });
C('commit -i adds named paths to the index', 'git commit -i -m x a.ts', { strongest: 'SWEEP', step: { scope: 'index', paths: ['a.ts'] } });
C('commit -- . commits tracked changes under cwd', 'git commit -m x -- .', { strongest: 'SWEEP', step: { scope: 'tracked', paths: ['.'] } });
C('commit -F - with a here-doc message', "git commit -F - <<'EOF'\nfix: tidy\n\nnever git reset --hard here\nEOF", { ok: true, gitCount: 1, step: { scope: 'index' } });
C("Claude's heredoc commit message is data", "git commit -m \"$(cat <<'EOF'\nfix: x\n\nreset --hard and git add -A are words here\nEOF\n)\"", { ok: true, steps: 2, gitCount: 1, step: { sub: 'commit', scope: 'index' } });
C('-c core.hooksPath bypass is reported', 'git -c core.hooksPath=/dev/null commit -m x', { step: { flags: ['-c core.hookspath'] }, reason: /core\.hooksPath/ });
C('commit -C HEAD takes HEAD as the value', 'git commit -C HEAD', { step: { scope: 'index', paths: null } });
C('--author takes a value', 'git commit --author="A <a@b.c>" -m x', { step: { scope: 'index' } });
C('commit -p is interactive', 'git commit -p', { strongest: 'SAFE' });
C('commit --interactive is interactive', 'git commit --interactive', { strongest: 'SAFE' });
C('commit -a with a path still sweeps', 'git commit -a -m x file.txt', { strongest: 'SWEEP', step: { scope: 'tracked' } });
C('a message quoting git commands', "git commit -m 'git add -A && git reset --hard'", { gitCount: 1, strongest: 'SWEEP' });
C('--amend --no-edit sweeps the index', 'git commit --amend --no-edit', { step: { flags: ['--amend'] }, reason: /--amend/ });
C('-F file is the message source', 'git commit -F msg.txt', { step: { scope: 'index', paths: null } });
C('a substitution in the message runs first', 'git commit -m "$(git log -1 --format=%s)"', { git: [{ sub: 'log' }, { sub: 'commit', tier: 'SWEEP' }] });

// D — reset
C('reset --hard discards', 'git reset --hard', { strongest: 'DISCARD', step: { sub: 'reset', scope: 'tracked', paths: null, flags: ['--hard'] } });
C('reset --hard HEAD~1 discards', 'git reset --hard HEAD~1', { strongest: 'DISCARD' });
C('reset --merge discards staged changes', 'git reset --merge', { strongest: 'DISCARD', step: { scope: 'index' } });
C('reset HEAD~1 moves the branch', 'git reset HEAD~1', { strongest: 'MOVE', step: { scope: 'index' } });
C('plain reset unstages everything', 'git reset', { strongest: 'UNSTAGE', step: { scope: 'index', paths: null } });
C('reset -- a.ts unstages one path', 'git reset -- a.ts', { strongest: 'UNSTAGE', step: { paths: ['a.ts'] } });
C('reset HEAD a.ts unstages one path', 'git reset HEAD a.ts', { strongest: 'UNSTAGE', step: { paths: ['a.ts'], needsRefCheck: null } });
C('reset --keep moves', 'git reset --keep main', { strongest: 'MOVE' });
C('reset --soft moves', 'git reset --soft HEAD~2', { strongest: 'MOVE' });
C('reset -p is interactive', 'git reset -p', { strongest: 'SAFE' });
C('reset main: commit or path, ask the repository', 'git reset main', { ok: true, strongest: 'UNSTAGE', step: { needsRefCheck: 'main', paths: ['main'], readings: { commit: { tier: 'MOVE', scope: 'index', paths: null }, path: { tier: 'UNSTAGE', scope: 'index', paths: ['main'] } } } });
C('reset X a.ts reports the union of both readings', 'git reset main a.ts', { strongest: 'UNSTAGE', step: { paths: ['main', 'a.ts'], needsRefCheck: 'main', readings: { commit: { tier: 'UNSTAGE', scope: 'index', paths: ['a.ts'] }, path: { tier: 'UNSTAGE', scope: 'index', paths: ['main', 'a.ts'] } } } });
C('reset HEAD unstages and does not move', 'git reset HEAD', { strongest: 'UNSTAGE', step: { paths: null } });
C('reset --hard origin/main discards', 'git reset --hard origin/main', { strongest: 'DISCARD' });
C('reset <sha> moves', 'git reset abc1234', { strongest: 'MOVE' });

// E — checkout
C('checkout main: branch or file, the DISCARD reading is reported', 'git checkout main', { ok: true, strongest: 'DISCARD', step: { sub: 'checkout', needsRefCheck: 'main', scope: 'tracked', paths: ['main'], readings: { commit: { tier: 'MOVE', scope: 'all', paths: null }, path: { tier: 'DISCARD', scope: 'tracked', paths: ['main'] } } } });
C('checkout file.txt: the same question, the file is covered', 'git checkout file.txt', { strongest: 'DISCARD', step: { needsRefCheck: 'file.txt', paths: ['file.txt'], readings: { commit: { tier: 'MOVE', scope: 'all', paths: null }, path: { tier: 'DISCARD', scope: 'tracked', paths: ['file.txt'] } } } });
C('checkout -- . discards', 'git checkout -- .', { strongest: 'DISCARD', step: { scope: 'tracked', paths: ['.'] } });
C('checkout -- a.ts discards', 'git checkout -- a.ts', { strongest: 'DISCARD', step: { paths: ['a.ts'] } });
C('checkout . is always a path', 'git checkout .', { strongest: 'DISCARD', step: { needsRefCheck: null, readings: null } });
C('checkout -b moves', 'git checkout -b feat', { strongest: 'MOVE' });
C('checkout -f discards the whole tree', 'git checkout -f', { strongest: 'DISCARD', step: { paths: null } });
C('checkout -f main discards every tracked file (wider reading reported)', 'git checkout -f main', { strongest: 'DISCARD', step: { needsRefCheck: 'main', scope: 'tracked', paths: null, readings: { commit: { tier: 'DISCARD', scope: 'tracked', paths: null }, path: { tier: 'DISCARD', scope: 'tracked', paths: ['main'] } } } });
C('checkout HEAD~1 is a revision', 'git checkout HEAD~1', { strongest: 'MOVE', step: { needsRefCheck: null } });
C('checkout - is the previous branch', 'git checkout -', { strongest: 'MOVE' });
C('checkout main -- a.ts discards a.ts', 'git checkout main -- a.ts', { strongest: 'DISCARD', step: { paths: ['a.ts'] } });
C('checkout -p is interactive', 'git checkout -p', { strongest: 'SAFE' });
C('checkout --theirs a.ts discards', 'git checkout --theirs a.ts', { strongest: 'DISCARD', step: { paths: ['a.ts'] } });
C('checkout a.ts b.ts discards both files', 'git checkout a.ts b.ts', { strongest: 'DISCARD', step: { paths: ['a.ts', 'b.ts'], needsRefCheck: 'a.ts', readings: { commit: { tier: 'DISCARD', scope: 'tracked', paths: ['b.ts'] }, path: { tier: 'DISCARD', scope: 'tracked', paths: ['a.ts', 'b.ts'] } } } });
C('checkout ./a.ts b.ts: both are paths', 'git checkout ./a.ts b.ts', { strongest: 'DISCARD', step: { paths: ['./a.ts', 'b.ts'], needsRefCheck: null, readings: null } });
C('checkout HEAD~1 a.ts: a commit then a path', 'git checkout HEAD~1 a.ts', { strongest: 'DISCARD', step: { paths: ['a.ts'], needsRefCheck: null } });
C('checkout -B main origin/main moves', 'git checkout -B main origin/main', { strongest: 'MOVE' });
C('checkout --orphan moves', 'git checkout --orphan gh-pages', { strongest: 'MOVE' });
C('checkout ./src/a.ts is a path', 'git checkout ./src/a.ts', { strongest: 'DISCARD' });
C('checkout main -- with no paths moves', 'git checkout main --', { strongest: 'MOVE' });
C('checkout --detach moves', 'git checkout --detach', { strongest: 'MOVE' });
C('checkout <abbreviated hash> is a revision', 'git checkout abc1234', { strongest: 'MOVE', step: { needsRefCheck: null } });
C('an all-letter hex word is left to the repository', 'git checkout deadbeef', { strongest: 'DISCARD', step: { needsRefCheck: 'deadbeef', paths: ['deadbeef'] } });

// F — switch
C('switch -c moves', 'git switch -c feat', { strongest: 'MOVE', step: { sub: 'switch' } });
C('switch main moves', 'git switch main', { strongest: 'MOVE' });
C('switch -f discards', 'git switch -f main', { strongest: 'DISCARD' });
C('switch --discard-changes discards', 'git switch --discard-changes main', { strongest: 'DISCARD' });
C('switch - moves', 'git switch -', { strongest: 'MOVE' });
C('switch with no branch does nothing', 'git switch', { strongest: 'SAFE' });

// G — restore
C('restore . discards unstaged changes', 'git restore .', { strongest: 'DISCARD', step: { sub: 'restore', scope: 'tracked', paths: ['.'] } });
C('restore --staged . unstages', 'git restore --staged .', { strongest: 'UNSTAGE', step: { scope: 'index' } });
C('restore -SW discards both', 'git restore -SW a.ts', { strongest: 'DISCARD' });
C('restore --source discards', 'git restore --source=HEAD~1 a.ts', { strongest: 'DISCARD', step: { paths: ['a.ts'] } });
C('restore -p is interactive', 'git restore -p a.ts', { strongest: 'SAFE' });
C('restore without paths does nothing', 'git restore', { strongest: 'SAFE' });
C('restore -s HEAD -- a.ts b.ts', 'git restore -s HEAD -- a.ts b.ts', { strongest: 'DISCARD', step: { paths: ['a.ts', 'b.ts'] } });

// H — stash
C('stash parks tracked changes', 'git stash', { strongest: 'PARK', step: { sub: 'stash', action: 'push', scope: 'tracked', paths: null } });
C('stash -u parks untracked too', 'git stash -u', { strongest: 'PARK', step: { scope: 'all' } });
C('stash push -m -- a.ts parks one path', 'git stash push -m "wip" -- a.ts', { strongest: 'PARK', step: { paths: ['a.ts'] } });
C('stash save words are the message', 'git stash save "my message"', { strongest: 'PARK', step: { action: 'save', paths: null } });
C('stash list is SAFE', 'git stash list', { strongest: 'SAFE', step: { action: 'list' } });
C('stash show -p is SAFE', 'git stash show -p', { strongest: 'SAFE', step: { action: 'show' } });
C('stash pop is MOVE, action reported', 'git stash pop', { strongest: 'MOVE', step: { action: 'pop' } });
C('stash drop: action reported, never DISCARD here', 'git stash drop', { strongest: 'MOVE', step: { action: 'drop', tier: 'MOVE' } });
C('stash clear: action reported', 'git stash clear', { strongest: 'MOVE', step: { action: 'clear' } });
C('stash apply stash@{1}', 'git stash apply stash@{1}', { strongest: 'MOVE', step: { action: 'apply' } });
C('stash -S parks staged changes only', 'git stash -S', { strongest: 'PARK', step: { scope: 'index' } });
C('stash -p is interactive', 'git stash -p', { strongest: 'SAFE', step: { action: 'push' } });
C('stash branch moves', 'git stash branch tmp', { strongest: 'MOVE', step: { action: 'branch' } });
C('stash push -a parks ignored files too', 'git stash push -a', { strongest: 'PARK', step: { scope: 'all', flags: ['--all'] } });
C('stash with an unknown word is refused by git', 'git stash foo', { strongest: 'SAFE', step: { action: null } });

// I — clean
C('clean -fd discards untracked files', 'git clean -fd', { strongest: 'DISCARD', step: { sub: 'clean', scope: 'untracked', flags: ['--force', '-d'] } });
C('clean -n is a dry run', 'git clean -n', { strongest: 'SAFE' });
C('clean -fdx includes ignored files', 'git clean -fdx', { strongest: 'DISCARD', step: { flags: ['-x'] } });
C('clean.requireForce=false makes -f unnecessary', 'git -c clean.requireForce=false clean -d', { strongest: 'DISCARD' });
C('clean without -f is refused by git', 'git clean -d', { strongest: 'SAFE', reason: /refuses to clean/ });
C('clean -fn: the dry run wins', 'git clean -fn', { strongest: 'SAFE' });
C('clean -i is interactive', 'git clean -i', { strongest: 'SAFE' });
C('clean -f -- build/ is scoped', 'git clean -f -- build/', { strongest: 'DISCARD', step: { paths: ['build/'] } });

// J — worktree, the MOVE family, rm, plumbing, gh
C('worktree remove discards that worktree', 'git worktree remove ../wt', { strongest: 'DISCARD', step: { sub: 'worktree', action: 'remove', scope: 'all', paths: ['../wt'] } });
C('worktree remove --force', 'git worktree remove --force ../wt', { strongest: 'DISCARD', step: { flags: ['--force'] } });
C('worktree add is SAFE', 'git worktree add ../wt main', { strongest: 'SAFE', step: { action: 'add' } });
C('worktree list is SAFE', 'git worktree list', { strongest: 'SAFE' });
C('pull moves', 'git pull', { strongest: 'MOVE', step: { sub: 'pull' } });
C('pull --rebase --autostash parks', 'git pull --rebase --autostash', { strongest: 'PARK', step: { scope: 'tracked' } });
C('rebase moves', 'git rebase main', { strongest: 'MOVE' });
C('rebase --continue is SAFE', 'git rebase --continue', { strongest: 'SAFE', step: { action: 'continue' } });
C('rebase --abort moves', 'git rebase --abort', { strongest: 'MOVE', step: { action: 'abort' } });
C('merge moves', 'git merge feature', { strongest: 'MOVE', step: { sub: 'merge' } });
C('merge --autostash parks', 'git merge --autostash feature', { strongest: 'PARK' });
C('-c rebase.autoStash=true parks', 'git -c rebase.autoStash=true rebase main', { strongest: 'PARK', step: { flags: ['-c rebase.autostash'] } });
C('cherry-pick moves', 'git cherry-pick abc123', { strongest: 'MOVE', step: { sub: 'cherry-pick' } });
C('revert moves', 'git revert HEAD', { strongest: 'MOVE', step: { sub: 'revert' } });
C('am moves', 'git am < patch.mbox', { strongest: 'MOVE', step: { sub: 'am' } });
C('pull --no-autostash moves', 'git pull --no-autostash', { strongest: 'MOVE' });
C('pull.rebase + rebase.autoStash parks', 'git -c pull.rebase=true -c rebase.autoStash=true pull', { strongest: 'PARK' });
C('rebase --onto takes a value', 'git rebase --onto main topic', { strongest: 'MOVE' });
C('cherry-pick --abort moves', 'git cherry-pick --abort', { strongest: 'MOVE', step: { action: 'abort' } });
C('rm -f discards', 'git rm -f a.ts', { strongest: 'DISCARD', step: { sub: 'rm', paths: ['a.ts'] } });
C('rm --cached unstages', 'git rm --cached a.ts', { strongest: 'UNSTAGE', step: { scope: 'index' } });
C('rm without -f is refused for dirty files', 'git rm a.ts', { strongest: 'SAFE' });
C('rm -r --cached . unstages', 'git rm -r --cached .', { strongest: 'UNSTAGE', step: { paths: ['.'] } });
C('read-tree -u --reset discards', 'git read-tree -u --reset HEAD', { strongest: 'DISCARD' });
C('checkout-index -f -a discards', 'git checkout-index -f -a', { strongest: 'DISCARD' });
C('gh pr checkout moves', 'gh pr checkout 12', { strongest: 'MOVE', step: { git: true, sub: 'gh pr checkout' } });
C('gh pr merge -d moves', 'gh pr merge 12 --squash -d', { strongest: 'MOVE', step: { sub: 'gh pr merge' } });
C('gh pr view is not git', 'gh pr view 12', { gitCount: 0, strongest: 'SAFE' });

// K — globals and the working directory
C('git -C ../x', 'git -C ../x add -A', { strongest: 'SWEEP', step: { cwd: '../x' } });
C('repeated -C composes', 'git -C a -C b status', { step: { cwd: 'a/b' } });
C('cd sub && git add .', 'cd sub && git add .', { ok: true, step: { cwd: 'sub', paths: ['.'] } });
C('cd sub; git add .', 'cd sub; git add .', { step: { cwd: 'sub' } });
C('MSYS /e/repo becomes E:/repo on win32', 'cd /e/repo && git status', { step: { cwd: 'E:/repo' } });
C('/e/repo stays as written elsewhere', 'cd /e/repo && git status', { step: { cwd: '/e/repo' } }, { platform: 'linux' });
C('cd sub then -C .. is back home', 'cd sub && git -C .. add -A', { step: { cwd: null } });
C('a subshell cd stays in the subshell', '(cd sub && git add .) && git commit -m x', { git: [{ cwd: 'sub' }, { cwd: null }] });
C('cd $DIR is unverified', 'cd $DIR && git add -A', { ok: false, step: { tier: 'SWEEP', ok: false }, reason: /only known when the shell runs/ });
C('cd || exit keeps the directory certain', 'cd sub || exit 1; git add .', { ok: true, step: { cwd: 'sub' } });
C('pushd / popd', 'pushd sub && git add . && popd && git commit -m x', { ok: true, git: [{ cwd: 'sub' }, { cwd: null }] });
C('-c user settings are harmless', 'git -c user.name=x -c user.email=y commit -m z', { ok: true, strongest: 'SWEEP' });
C('--git-dir is unverified', 'git --git-dir=.git add -A', { ok: false, strongest: 'SWEEP' });
C('stuck -C is refused by git', 'git -Cfoo status', { ok: false });
C('two cds compose', 'cd a && cd b && git status', { step: { cwd: 'a/b' } });
C('cd ~/repo', 'cd ~/repo && git status', { step: { cwd: '~/repo' } });
C('cd in a pipeline runs in a subshell', 'cd sub | git add .', { step: { cwd: null } });
C('cd in the background runs in a subshell', 'cd sub & git add .', { step: { cwd: null } });
C('a cd that may not run is unverified', 'test -d sub && cd sub; git add .', { ok: false });
C('cd || git: either directory', 'cd sub || git add .', { ok: false });
C('cd - with no earlier cd is unverified', 'cd - && git status', { ok: false });
C('cd a && cd - returns home', 'cd a && cd - && git status', { ok: true, step: { cwd: null } });
C('cd inside an if body is unverified after fi', 'if [ -d sub ]; then cd sub; fi; git add .', { ok: false });
C('a quoted directory', 'cd "my dir" && git status', { step: { cwd: 'my dir' } });
C('-C "" is a no-op', 'git -C "" status', { step: { cwd: null } });
C('cd inside bash -c does not leak', "bash -c 'cd sub && git add .' ; git status", { git: [{ cwd: 'sub', tier: 'SWEEP' }, { cwd: null, tier: 'READ' }] });
C('bash -c starts in the current directory', "cd sub && bash -c 'git status'", { step: { cwd: 'sub' } });

// L — env prefixes and wrappers
C('GIT_DIR= prefix is unverified', 'GIT_DIR=.git git add -A', { ok: false, strongest: 'SWEEP', step: { flags: ['env:GIT_DIR'] } });
C('env -C sub', 'env -C sub git add .', { step: { cwd: 'sub', tier: 'SWEEP' } });
C('timeout 30', 'timeout 30 git clean -fd', { strongest: 'DISCARD' });
C('nohup … &', 'nohup git stash &', { strongest: 'PARK' });
C('xargs supplies the pathspecs', 'git status --porcelain | xargs git add', { ok: false, git: [{ tier: 'READ' }, { sub: 'add', tier: 'SWEEP', ok: false }] });
C('KLYPIX_WHOSE= is reported and ignored', 'KLYPIX_WHOSE=0 git add -A', { ok: true, strongest: 'SWEEP', reason: /KLYPIX_WHOSE is ignored/ });
C('command git', 'command git reset --hard', { strongest: 'DISCARD' });
C('command -v git only looks git up', 'command -v git', { gitCount: 0 });
C('sudo git', 'sudo git clean -fd', { strongest: 'DISCARD' });
C('find -exec git rm -f {} +', "find . -name '*.orig' -exec git rm -f {} +", { ok: false, strongest: 'DISCARD' });
C('GIT_INDEX_FILE= is unverified', 'GIT_INDEX_FILE=/tmp/idx git add -A', { ok: false, step: { flags: ['env:GIT_INDEX_FILE'] } });
C('export GIT_DIR applies to later commands', 'export GIT_DIR=/x; git add -A', { ok: false });
C('exec git', 'exec git reset --hard', { strongest: 'DISCARD' });
C('time git', 'time git add -A', { strongest: 'SWEEP' });
C('harmless prefixes', 'FOO=1 BAR=2 git status', { ok: true, strongest: 'READ' });
C('env GIT_WORK_TREE= is unverified', 'env GIT_WORK_TREE=/x git status', { ok: false });
C('nice -n 10', 'nice -n 10 git gc', { ok: true, strongest: 'SAFE', step: { sub: 'gc' } });
C('stdbuf -oL', 'stdbuf -oL git log --stat', { strongest: 'READ' });
C('GIT_LITERAL_PATHSPECS=1', "GIT_LITERAL_PATHSPECS=1 git add 'a[1].txt'", { ok: true, strongest: 'EXPLICIT' });
C('xargs -0 git rm -f', 'xargs -0 git rm -f < list.txt', { ok: false, strongest: 'DISCARD' });
C('env -S splits a string', "env -S 'git add -A'", { strongest: 'SWEEP' });
C('sudo -D sub', 'sudo -D sub git add .', { step: { cwd: 'sub' } });

// M — false-positive guards
C('echo of a git command', 'echo "git add -A"', { ok: true, gitCount: 0, strongest: 'SAFE' });
C('echo with unquoted words', 'echo git reset --hard', { gitCount: 0 });
C('printf string', "printf 'git stash\\n'", { gitCount: 0 });
C('rg pattern', 'rg "git add -A" src', { gitCount: 0 });
C('grep pattern', 'grep -rn "git reset --hard" .', { gitCount: 0 });
C('a comment', '# git reset --hard', { steps: 0, strongest: 'SAFE' });
C('a trailing comment', 'git status # then git reset --hard', { gitCount: 1, strongest: 'READ' });
C('quoted here-doc body is data', "cat <<'EOF' > notes.md\ngit reset --hard\nEOF", { gitCount: 0 });
C('unquoted here-doc body text is data', 'cat <<EOF\ngit add -A\nEOF', { gitCount: 0 });
C('…but a substitution in it runs', 'cat <<EOF\n$(git add -A)\nEOF', { strongest: 'SWEEP' });
C('a substitution in double quotes runs', 'echo "$(git status)"', { strongest: 'READ' });
C('single quotes stop substitution', "echo '$(git add -A)'", { gitCount: 0 });
C('node -e string', 'node -e "console.log(\'git add -A\')"', { gitCount: 0 });
C('data in a file, then an explicit add', 'echo "git reset --hard" > notes.txt && git add notes.txt', { git: [{ tier: 'EXPLICIT', paths: ['notes.txt'] }] });
C('man page', 'man git-reset', { gitCount: 0 });
C('which git, then git --version', 'which git && git --version', { gitCount: 1, strongest: 'SAFE' });
C('<<- strips tabs from the delimiter', 'cat <<-EOF\n\tgit add -A\n\tEOF\necho done', { gitCount: 0, steps: 2 });
C('ssh runs it on another machine', 'ssh host "git reset --hard"', { gitCount: 0 });
C("$'…' string", "echo $'git reset --hard'", { gitCount: 0 });
C('here-string to cat', 'cat <<< "git add -A"', { gitCount: 0 });
C('POSIX backticks in double quotes do run', 'git commit -m "avoid `git add -A` sweeps"', { git: [{ sub: 'add', tier: 'SWEEP' }, { sub: 'commit' }] });

// N — nested shells
C('bash -lc', 'bash -lc "git stash -u"', { strongest: 'PARK', steps: 2 });
C('sh -c with cd', "sh -c 'cd sub && git add .'", { step: { cwd: 'sub' } });
C('cmd /c chain', 'cmd /c "git add -A && git commit -m x"', { git: [{ tier: 'SWEEP', sub: 'add' }, { sub: 'commit' }] });
C('eval string', 'eval "git reset --hard"', { strongest: 'DISCARD' });
C('eval of a variable is unverified', 'eval "$CMD"', { ok: false });
C('a here-doc fed to bash runs', "bash <<'EOF'\ngit add -A\nEOF", { strongest: 'SWEEP' });
C('powershell -Command from bash', 'powershell -NoProfile -Command "git add -A; git commit -m x"', { git: [{ sub: 'add' }, { sub: 'commit' }] });
C('bash -c of a variable is unverified', 'bash -c "$SCRIPT"', { ok: false });
C('a script piped into bash is unverified', 'echo "git add -A" | bash', { ok: false });
C('a script file is not read', 'bash script.sh', { ok: true, gitCount: 0 });
C('-EncodedCommand is decoded', `powershell -EncodedCommand ${Buffer.from('git add -A', 'utf16le').toString('base64')}`, { ok: true, strongest: 'SWEEP' });
C('cmd //c (Git Bash spelling)', 'cmd //c "git clean -fd"', { strongest: 'DISCARD' });
C('zsh -c', "zsh -c 'git restore .'", { strongest: 'DISCARD' });
C('bash -o pipefail -c', "bash -o pipefail -c 'git add -A'", { strongest: 'SWEEP' });
C('eval words', 'eval git status', { strongest: 'READ' });
C('cmd /c with cd /d', `cmd /c "cd /d E:${BS}repo && git reset --hard"`, { strongest: 'DISCARD', step: { cwd: 'E:/repo' } });

// O — chains and the chain simulation
C('add then commit: the commit gets the added paths', 'git add a.ts b.ts && git commit -m x', { staged: { 1: ['a.ts', 'b.ts'] } });
C('; chain', 'git add a.ts; git commit -m x', { staged: { 1: ['a.ts'] } });
C('|| chain (over-approximated)', 'git add a.ts || git commit -m x', { staged: { 1: ['a.ts'] } });
C('newline chain', 'git add a.ts\ngit commit -m x', { staged: { 1: ['a.ts'] } });
C('cd joins the staged path', 'cd sub && git add a.ts && git commit -m x', { staged: { 2: ['sub/a.ts'] } });
C('commit -- b.ts ignores the index', 'git add a.ts && git commit -m x -- b.ts', { staged: { 1: [] } });
C('reset in between unstages', 'git add a.ts && git reset && git commit -m x', { staged: { 2: [] } });
C('each commit consumes what was staged', 'git add a.ts && git commit -m one && git add b.ts && git commit -m two', { staged: { 1: ['a.ts'], 3: ['b.ts'] } });
C('commit -am includes earlier adds', 'git add a.ts && git commit -am x', { staged: { 1: ['a.ts'] } });
C('add -A is judged by itself', 'git add -A && git commit -m x', { strongest: 'SWEEP', staged: { 1: [] } });
C('reads in between', 'git status && git diff --stat && git add a.ts && git commit -m x', { staged: { 3: ['a.ts'] } });
C('stash in between', 'git add a.ts && git stash && git commit -m x', { staged: { 2: [] } });
C('reset -- a.ts matches ./a.ts', 'git add ./a.ts && git reset -- a.ts && git commit -m x', { staged: { 2: [] } });
C('a dry-run commit gets no entry', 'git add a.ts && git commit --dry-run', { staged: {} });
C('-C on the add joins the path', 'git -C ../x add a.ts && git commit -m y', { staged: { 1: ['../x/a.ts'] } });
C('commit -i keeps earlier adds', 'git add a.ts && git commit -i -m x b.ts', { staged: { 1: ['a.ts'] } });
C('pipes are over-approximated too', 'git add a.ts | git commit -m x', { staged: { 1: ['a.ts'] } });
C('a commit in a subshell', 'git add a.ts && (git commit -m x)', { staged: { 1: ['a.ts'] } });
C('restore --staged in between', 'git add a.ts && git restore --staged a.ts && git commit -m x', { staged: { 2: [] } });
C('amend includes earlier adds', 'git add a.ts && git commit --amend --no-edit', { staged: { 1: ['a.ts'] } });
C('strongest is the max over the chain', 'git status; git reset --hard; git add a.ts', { strongest: 'DISCARD', gitCount: 3 });

// P — PowerShell
C('PS add -A', 'git add -A', { ok: true, strongest: 'SWEEP', dialect: 'powershell' }, PS);
C('PS ; chain with chain simulation', "git add a.ts; git commit -m 'msg'", { staged: { 1: ['a.ts'] } }, PS);
C('PS backtick-escaped quotes in a message', 'git commit -m "fix `"quoted`" text"', { ok: true, gitCount: 1 }, PS);
C("PS '' inside single quotes", "git commit -m 'it''s fine'", { ok: true, gitCount: 1 }, PS);
C('PS & call operator with a quoted path', `& 'C:${BS}Program Files${BS}Git${BS}cmd${BS}git.exe' add -A`, { ok: true, strongest: 'SWEEP' }, PS);
C('PS & git', '& git reset --hard', { strongest: 'DISCARD' }, PS);
C('PS Set-Location', 'Set-Location sub; git add .', { step: { cwd: 'sub' } }, PS);
C('PS cd with a Windows path', `cd C:${BS}repo; git status`, { step: { cwd: 'C:/repo' } }, PS);
C('PS --% stop parsing', 'git --% add -A', { strongest: 'SWEEP' }, PS);
C('PS Write-Host string', 'Write-Host "git add -A"', { gitCount: 0 }, PS);
C('PS Write-Output string', "Write-Output 'git reset --hard'", { gitCount: 0 }, PS);
C('PS Select-String pattern', "Select-String -Pattern 'git add -A' -Path x.txt", { gitCount: 0 }, PS);
C("PS literal here-string is data", "git commit -m @'\nreset --hard\n'@", { ok: true, gitCount: 1 }, PS);
C('PS expandable here-string runs $( )', 'git commit -m @"\n$(git add -A)\n"@', { git: [{ sub: 'add', tier: 'SWEEP' }, { sub: 'commit' }] }, PS);
C('PS pipeline', 'git status | Out-String', { strongest: 'READ' }, PS);
C('PS assignment from git', '$out = git stash', { strongest: 'PARK' }, PS);
C('PS if/else blocks', 'if (git diff --quiet) { } else { git stash }', { git: [{ tier: 'READ' }, { tier: 'PARK' }] }, PS);
C('PS $files pathspec is unverified', 'git add $files', { ok: false }, PS);
C('PS @args splat is unverified', 'git add @args', { ok: false }, PS);
C('PS && chain (pwsh 7)', 'git add a.ts && git commit -m x', { staged: { 1: ['a.ts'] } }, PS);
C('PS `$ escapes the subexpression', 'git commit -m "a `$(git reset --hard) b"', { gitCount: 1, strongest: 'SWEEP' }, PS);
C('PS backtick line continuation', "git commit `\n  -m 'x'", { step: { scope: 'index', flags: ['--message'] } }, PS);
C('PS block comment', '<# git reset --hard #> git status', { gitCount: 1, strongest: 'READ' }, PS);
C('PS line comment', '# git add -A', { steps: 0 }, PS);
C('PS iex string', "iex 'git clean -fd'", { strongest: 'DISCARD' }, PS);
C('PS Invoke-Expression of a variable is unverified', 'Invoke-Expression $cmd', { ok: false }, PS);
C('PS cmd /c', 'cmd /c "git reset --hard"', { strongest: 'DISCARD' }, PS);
C('PS bash -c', "bash -c 'git add -A'", { strongest: 'SWEEP' }, PS);
C('PS Start-Process git', "Start-Process git -ArgumentList 'add','-A' -Wait", { strongest: 'SWEEP' }, PS);
C('PS -C with backslashes', `git -C ..${BS}other add -A`, { step: { cwd: '../other' } }, PS);
C('PS Push-Location / Pop-Location', 'Push-Location sub; git add a.ts; Pop-Location; git commit -m x', { git: [{ cwd: 'sub' }, { cwd: null }], staged: { 3: ['sub/a.ts'] } }, PS);
C('PS $env:GIT_DIR is unverified', "$env:GIT_DIR = 'x'; git add -A", { ok: false }, PS);
C('PS unterminated quote is unverified', "git commit -m 'oops", { ok: false }, PS);
C('PS backticks are escapes, not substitution (safety-B6)', 'git commit -m "avoid `git add -A` sweeps"', { gitCount: 1, git: [{ sub: 'commit' }] }, PS);
C('PS compact if($?){…}', 'if($?){git commit -m x}', { strongest: 'SWEEP' }, PS);
C('PS $env:KLYPIX_WHOSE is reported', "$env:KLYPIX_WHOSE = '0'; git add -A", { ok: true, strongest: 'SWEEP', reason: /KLYPIX_WHOSE is ignored/ }, PS);
C('PS foreach with a variable path is unverified', 'foreach ($f in $files) { git add $f }', { ok: false }, PS);
C('PS ForEach-Object $_ is unverified', 'git diff --name-only | ForEach-Object { git add $_ }', { ok: false }, PS);
C('PS & { … } runs the block', '& { git stash }', { strongest: 'PARK', steps: 2 }, PS);
C('PS checkout -- . keeps --', 'git checkout -- .', { strongest: 'DISCARD', step: { paths: ['.'] } }, PS);
C('PS .\\src\\ is a directory', `git add .${BS}src${BS}`, { strongest: 'SWEEP' }, PS);
C('PS `n in a message', 'git commit -m "line1`nline2"', { gitCount: 1 }, PS);
C('PS comma plus blank separates arguments', 'git add a.ts, b.ts', { strongest: 'EXPLICIT', step: { paths: ['a.ts', 'b.ts'] } }, PS);
C('PS cd ..', 'cd ..; git status', { step: { cwd: '..' } }, PS);
C('pwsh -c from bash', 'pwsh -c "git stash"', { strongest: 'PARK' });
C('PS read then sweep', 'git status; git add -A', { strongest: 'SWEEP', gitCount: 2 }, PS);
C('PS Write-Host "$(git status)" runs git', 'Write-Host "$(git status)"', { strongest: 'READ' }, PS);
C('PS here-string message in a variable', "$msg = @'\nfix: x\n\ngit reset --hard\n'@\ngit commit -m $msg", { ok: true, gitCount: 1, strongest: 'SWEEP' }, PS);
C('PS redirection and Out-Null', "git commit -m 'msg' 2>&1 | Out-Null", { strongest: 'SWEEP' }, PS);
C('PS try block', 'try { git stash } catch { }', { strongest: 'PARK' }, PS);
C('PS Select-String after git log', "git log --oneline -n 5 | Select-String 'git add -A'", { gitCount: 1, strongest: 'SAFE' }, PS);
C('PS typographic quotes', `git commit -m ${LDQ}smart message${RDQ}`, { ok: true, gitCount: 1, step: { scope: 'index' } }, PS);
C('PS Set-Location -Path', "Set-Location -Path 'my dir'; git status", { step: { cwd: 'my dir' } }, PS);
C('PS cd to an environment variable is unverified', 'sl $env:TEMP; git status', { ok: false }, PS);

// Q — dialect, argv and odd input
C('an ambiguous dialect never decides', 'git add -A', { ok: false, dialect: null, strongest: 'SWEEP', reason: /dialect is not known/ }, { dialect: 'auto' });
C('a null dialect is ambiguous', 'git status', { ok: false, dialect: null }, { dialect: null });
C('argv array', ['git', 'add', '-A'], { ok: true, strongest: 'SWEEP' });
C('argv array through bash -lc', ['bash', '-lc', 'git stash'], { strongest: 'PARK' });
C('verbs are case-sensitive: an unknown verb is unverified', 'git ADD -A', { ok: false, strongest: 'SAFE' });
C('an alias from the user config is unverified', 'git co main', { ok: false, step: { sub: 'co' } });
C('an alias defined with -c is expanded', "git -c alias.nuke='reset --hard' nuke", { strongest: 'DISCARD', step: { sub: 'reset' } });
C('a shell alias defined with -c is followed, unverified', "git -c alias.st='!git stash -u' st", { ok: false, strongest: 'PARK' });
C('a here-doc that never closes its $( is unverified', 'git commit -m "$(cat <<EOF', { ok: false });
C('unterminated double quote', 'git commit -m "unterminated', { ok: false });
C('unterminated single quote', "git add 'a.ts", { ok: false });
C('case … esac is not analysed', 'case $x in a) git add -A;; esac', { ok: false });
C('for loop: the list runs, the body is unverified', 'for f in $(git diff --name-only); do git add "$f"; done', { ok: false, git: [{ tier: 'READ' }, { tier: 'SWEEP', ok: false }] });
C('checkout $BRANCH is unverified', 'git checkout $BRANCH', { ok: false });
C('a dynamic program named like git is unverified', '$GIT add -A', { ok: false, gitCount: 0 });
C('"$(which git)" as the program is unverified', '"$(which git)" add -A', { ok: false });
C('/usr/bin/git', '/usr/bin/git add -A', { strongest: 'SWEEP' });
C('git.exe', 'git.exe add -A', { strongest: 'SWEEP' });
C('a quoted absolute git path', '"C:/Program Files/Git/bin/git.exe" reset --hard', { strongest: 'DISCARD' });
C('cmd dialect directly', 'git add -A & git commit -m x', { git: [{ sub: 'add' }, { sub: 'commit' }] }, { dialect: 'cmd' });
C('@{u} is not a brace expansion', 'git log @{u}..HEAD', { ok: true, strongest: 'SAFE' });
C('nested brace expansion', 'git add {a,b}/x.ts', { step: { paths: ['a/x.ts', 'b/x.ts'] } });
C('a sequence brace is unverified', 'git add src/{1..3}.ts', { ok: false });
C('checkout-index --prefix writes elsewhere', 'git checkout-index -f -a --prefix=out/', { strongest: 'SAFE' });
C('an empty argv array', [], { ok: true, steps: 0, strongest: 'SAFE' });
C('cd to a computed top level is unverified', 'cd "$(git rev-parse --show-toplevel)" && git add -A', { ok: false, git: [{ sub: 'rev-parse' }, { sub: 'add', tier: 'SWEEP', ok: false }] });
C('CRLF line endings', 'git add a.ts\r\ngit commit -m x\r\n', { ok: true, staged: { 1: ['a.ts'] } });
C('a backslash-newline continuation', 'git commit \\\n  -m x', { ok: true, step: { scope: 'index', flags: ['--message'] } });

// R — adversarial review 2026-10-19: each case pins one fix
// ambiguous words: the step covers everything either reading could destroy
C('review: checkout a.txt b.txt covers both files', 'git checkout a.txt b.txt', { ok: true, strongest: 'DISCARD', step: { tier: 'DISCARD', scope: 'tracked', paths: ['a.txt', 'b.txt'], needsRefCheck: 'a.txt' } });
C('review: checkout src/a.ts src/b.ts covers both files', 'git checkout src/a.ts src/b.ts', { strongest: 'DISCARD', step: { paths: ['src/a.ts', 'src/b.ts'] } });
C('review: reset a.txt b.txt unstages both files', 'git reset a.txt b.txt', { strongest: 'UNSTAGE', step: { paths: ['a.txt', 'b.txt'] } });
C('review: checkout -f <branch> discards every tracked file', 'git checkout -f main', { strongest: 'DISCARD', step: { scope: 'tracked', paths: null } });
C('review: checkout README.md is DISCARD of the file, not MOVE', 'git checkout README.md', { ok: true, strongest: 'DISCARD', step: { tier: 'DISCARD', scope: 'tracked', paths: ['README.md'], needsRefCheck: 'README.md' } });
C('review: checkout src/a.ts is DISCARD of the file', 'git checkout src/a.ts', { strongest: 'DISCARD', step: { paths: ['src/a.ts'] } });
C('review: reset X stays the weaker UNSTAGE (MOVE loses nothing)', 'git reset file.txt', { strongest: 'UNSTAGE', step: { paths: ['file.txt'] } });
C('review: an ambiguous reset of two files leaves nothing staged for the commit', 'git add a.txt b.txt && git reset a.txt b.txt && git commit -m x', { staged: { 2: [] } });
// (( … )), $(( … )) and arrays that hide git
C('review: ((x) ) is nested subshells', '((git reset --hard) )', { ok: false, strongest: 'DISCARD', step: { sub: 'reset' } });
C('review: ((cd … && git add -A) && …) is nested subshells', '((cd sub && git add -A) && git status)', { ok: false, strongest: 'SWEEP', git: [{ sub: 'add', cwd: 'sub' }, { sub: 'status' }] });
C('review: $( ) inside (( )) runs', '(( $(git clean -fdx) ))', { ok: false, strongest: 'DISCARD' });
C('review: $( ) inside $(( )) runs', 'echo $(( $(git clean -fdx | wc -l) + 1 ))', { ok: false, strongest: 'DISCARD' });
C('review: $( ) in a for (( )) header is unverified', 'for ((i=0; i<$(git rev-list --count HEAD); i++)); do :; done', { ok: false });
C('review: plain arithmetic is still SAFE', '(( n > 1 )) && echo big', { ok: true, strongest: 'SAFE', gitCount: 0 });
C('review: $( ) in an array assignment runs', 'arr=( $(git add -A) )', { strongest: 'SWEEP', step: { sub: 'add' } });
C('review: backticks in an array assignment run', 'arr=( a `git clean -fdx` b )', { strongest: 'DISCARD' });
C('review: a multi-line array assignment', 'arr=(\n  one\n  $(git stash)\n)', { strongest: 'PARK' });
C('review: a plain array assignment', 'arr=(a b c); git status', { ok: true, strongest: 'READ' });
// pathspec magic
C('review: :(literal) is stripped from an EXPLICIT path', 'git add ":(literal)a.txt" && git commit -m x', { ok: true, step: { tier: 'EXPLICIT', paths: ['a.txt'] }, staged: { 1: ['a.txt'] } });
C('review: :/ is stripped and unverified (relative to the top)', 'cd src && git add :/a.txt && git commit -m x', { ok: false, step: { tier: 'EXPLICIT', paths: ['a.txt'] }, reason: /top of the repository/ });
C('review: :(top) is stripped and unverified', 'git add ":(top)a.txt"', { ok: false, step: { paths: ['a.txt'] } });
C('review: :/ alone is the whole tree', 'git add :/', { ok: false, strongest: 'SWEEP' });
C('review: an exclusion keeps its magic', 'git add a.txt ":!b.txt"', { ok: true, step: { tier: 'EXPLICIT', paths: ['a.txt', ':!b.txt'] } });
// PowerShell aliases
C('review: Set-Alias g git', 'Set-Alias g git; g reset --hard', { strongest: 'DISCARD', step: { sub: 'reset' } }, PS);
C('review: New-Alias g git', 'New-Alias g git; g reset --hard', { strongest: 'DISCARD' }, PS);
C('review: sal with named parameters', 'sal -Value git.exe -Name gg; gg add -A', { strongest: 'SWEEP' }, PS);
C('review: New-Alias to a full git path', `New-Alias -Name g -Value 'C:${BS}Program Files${BS}Git${BS}cmd${BS}git.exe' -Scope Global; g stash`, { strongest: 'PARK' }, PS);
C('review: an alias to something else stays SAFE', 'Set-Alias ll Get-ChildItem; ll', { ok: true, strongest: 'SAFE' }, PS);
C('review: an alias to a variable is unverified', 'Set-Alias g $x; g reset --hard', { ok: false }, PS);
// submodule foreach
C('review: submodule foreach is walked, unverified', "git submodule foreach 'git clean -fdx'", { ok: false, strongest: 'DISCARD', git: [{ sub: 'submodule' }, { sub: 'clean', ok: false }] });
C('review: submodule foreach --recursive with bare words', 'git submodule foreach --recursive git reset --hard', { ok: false, strongest: 'DISCARD' });
C('review: submodule update is SAFE', 'git submodule update --init --recursive', { ok: true, strongest: 'SAFE' });
// a cd before ; or a newline may have failed
C('review: cd ; git add is unverified', 'cd nonexist 2>/dev/null; git add a.txt', { ok: false, step: { cwd: 'nonexist', ok: false } });
C('review: cd newline git add is unverified', 'cd src\ngit add a.txt', { ok: false });
C('review: Set-Location ; git add is unverified', 'cd src; git add a.txt', { ok: false }, PS);
C('review: cd || exit ; git add is certain', 'cd src || exit 1; git add a.txt', { ok: true, step: { cwd: 'src', ok: true } });
C('review: cd && git add stays certain', 'cd src && git add a.txt', { ok: true, step: { cwd: 'src' } });
// hidden options
C('review: commit --allow-empty is read', 'git commit --allow-empty -m x', { ok: true, strongest: 'SWEEP', step: { flags: ['--allow-empty'] } });
C('review: commit --allow-empty-message with paths', 'git commit --allow-empty-message -m "" -- a.txt', { ok: true, strongest: 'EXPLICIT' });
C('review: add --warn-embedded-repo is read', 'git add --no-warn-embedded-repo a.txt', { ok: true, strongest: 'EXPLICIT' });
// limits keep a visible destructive step in strongest
C('review: past the step limit strongest still sees git reset --hard', 'true;'.repeat(401) + 'git reset --hard', { ok: false, strongest: 'DISCARD', reason: /rough reading/ });
C('review: past the length limit strongest still sees git reset --hard', 'git reset --hard # ' + 'x'.repeat(200001), { ok: false, strongest: 'DISCARD', steps: 0 });
// home directory
C('review: cd ~/proj is unverified', 'cd ~/proj && git add a.txt', { ok: false, reason: /home directory/ });
C('review: git -C ~/proj is unverified', 'git -C ~/proj add a.txt', { ok: false });
C('review: bare cd goes home, unverified', 'cd && git add a.txt', { ok: false });

// ── run the table ───────────────────────────────────────────────────────────
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function checkStep(actual, expected, where) {
  const problems = [];
  if (!actual) return [`${where}: missing`];
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'flags') { for (const f of v) if (!actual.flags.includes(f)) problems.push(`${where}.flags lacks ${f} (has ${actual.flags.join(',')})`); continue; }
    if (k === 'noFlags') { for (const f of v) if (actual.flags.includes(f)) problems.push(`${where}.flags has ${f}`); continue; }
    if (!sameJSON(actual[k], v)) problems.push(`${where}.${k} = ${JSON.stringify(actual[k])}, expected ${JSON.stringify(v)}`);
  }
  return problems;
}
console.log(`T1 table: ${CASES.length} commands`);
for (const c of CASES) {
  const r = classifyCommand(c.command, { dialect: c.dialect, platform: c.platform });
  const e = c.expect;
  const gitSteps = r.steps.filter((s) => s.git);
  const problems = [];
  if ('ok' in e && r.ok !== e.ok) problems.push(`ok = ${r.ok}, expected ${e.ok}`);
  if ('strongest' in e && r.strongest !== e.strongest) problems.push(`strongest = ${r.strongest}, expected ${e.strongest}`);
  if ('dialect' in e && r.dialect !== e.dialect) problems.push(`dialect = ${r.dialect}, expected ${e.dialect}`);
  if ('steps' in e && r.steps.length !== e.steps) problems.push(`steps = ${r.steps.length}, expected ${e.steps}`);
  if ('gitCount' in e && gitSteps.length !== e.gitCount) problems.push(`git steps = ${gitSteps.length}, expected ${e.gitCount}`);
  if (e.step) problems.push(...checkStep(gitSteps[0], e.step, 'git step 0'));
  if (e.git) {
    if (gitSteps.length !== e.git.length) problems.push(`git steps = ${gitSteps.length}, expected ${e.git.length}`);
    e.git.forEach((x, i) => problems.push(...checkStep(gitSteps[i], x, `git step ${i}`)));
  }
  if ('staged' in e && !sameJSON(r.stagedBeforeCommit, e.staged)) problems.push(`stagedBeforeCommit = ${JSON.stringify(r.stagedBeforeCommit)}, expected ${JSON.stringify(e.staged)}`);
  if (e.reason && !r.reasons.some((x) => e.reason.test(x))) problems.push(`no reason matches ${e.reason}`);
  if (e.noReason && r.reasons.some((x) => e.noReason.test(x))) problems.push(`a reason matches ${e.noReason}`);
  ok(problems.length === 0, `[${c.dialect}] ${c.label}: ${JSON.stringify(c.command)}`, problems.length ? `${problems.join('; ')}\n      reasons: ${JSON.stringify(r.reasons)}` : '');
}
const tiersSeen = new Set(CASES.map((c) => classifyCommand(c.command, { dialect: c.dialect, platform: c.platform }).strongest));
ok(TIERS.every((t) => tiersSeen.has(t)), `T1 the table reaches every tier (${[...tiersSeen].join(', ')})`);

// ── R1 the result contract ──────────────────────────────────────────────────
console.log('R1 result contract');
{
  ok(sameJSON(TIERS, ['SAFE', 'READ', 'EXPLICIT', 'UNSTAGE', 'MOVE', 'PARK', 'DISCARD', 'SWEEP']), 'TIERS is the ascending list from V1_SCOPE');
  ok(TIERS.every((t, i) => tierRank(t) === i), 'tierRank follows TIERS');
  const SCOPES = new Set(['all', 'tracked', 'untracked', 'paths', 'index', null]);
  let shapeProblems = 0;
  let strongestProblems = 0;
  let stagedProblems = 0;
  let reasonProblems = 0;
  for (const c of CASES) {
    const r = classifyCommand(c.command, { dialect: c.dialect, platform: c.platform });
    if (typeof r.ok !== 'boolean' || !Array.isArray(r.steps) || !Array.isArray(r.reasons) || typeof r.stagedBeforeCommit !== 'object') shapeProblems++;
    r.steps.forEach((s, i) => {
      const good = s.index === i && typeof s.raw === 'string' && typeof s.git === 'boolean' && (s.cwd === null || typeof s.cwd === 'string')
        && (s.sub === null || typeof s.sub === 'string') && TIERS.includes(s.tier) && SCOPES.has(s.scope)
        && (s.paths === null || (Array.isArray(s.paths) && s.paths.length > 0 && s.paths.every((p) => typeof p === 'string')))
        && Array.isArray(s.flags) && typeof s.ok === 'boolean' && (s.action === null || typeof s.action === 'string')
        && (s.needsRefCheck === null || typeof s.needsRefCheck === 'string')
        && ((s.needsRefCheck === null && s.readings === null) || (typeof s.needsRefCheck === 'string' && s.readings && TIERS.includes(s.readings.commit.tier) && TIERS.includes(s.readings.path.tier)))
        && (s.readings === null || (() => {
          const hi = Math.max(tierRank(s.readings.commit.tier), tierRank(s.readings.path.tier));
          const lo = Math.min(tierRank(s.readings.commit.tier), tierRank(s.readings.path.tier));
          return tierRank(s.tier) === (hi >= tierRank('PARK') ? hi : lo);
        })());
      if (!good) { shapeProblems++; console.log(`      bad step shape in ${JSON.stringify(c.command)}: ${JSON.stringify(s)}`); }
      if (!s.git && s.tier !== 'SAFE') shapeProblems++;
      if (s.tier !== 'SAFE' && !r.reasons.some((x) => x.startsWith(`step ${s.index} `) && x.includes(s.tier))) reasonProblems++;
      if (!s.ok && r.ok) shapeProblems++;
    });
    const max = r.steps.reduce((t, s) => (tierRank(s.tier) > tierRank(t) ? s.tier : t), 'SAFE');
    // past an input limit a rough reading of the unread text may raise strongest (never with ok: true)
    const rough = !r.ok && r.reasons.some((x) => /rough reading/.test(x));
    if (rough ? tierRank(r.strongest) < tierRank(max) : r.strongest !== max) strongestProblems++;
    for (const k of Object.keys(r.stagedBeforeCommit)) {
      const s = r.steps[Number(k)];
      if (!s || s.sub !== 'commit' || s.tier === 'SAFE' || !Array.isArray(r.stagedBeforeCommit[k])) stagedProblems++;
    }
    for (const s of r.steps) if (s.sub === 'commit' && s.tier !== 'SAFE' && !(String(s.index) in r.stagedBeforeCommit)) stagedProblems++;
  }
  ok(shapeProblems === 0, `every step has the V1_SCOPE fields with the right types (${shapeProblems} problems)`);
  ok(strongestProblems === 0, `strongest is the max tier over steps (or above it, from a rough reading past a limit) (${strongestProblems} problems)`);
  ok(stagedProblems === 0, `stagedBeforeCommit has exactly one entry per committing step (${stagedProblems} problems)`);
  ok(reasonProblems === 0, `every risky step has a reason naming its tier (${reasonProblems} missing)`);
  const cmd = 'cd sub && git add a.ts && git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)"';
  ok(sameJSON(classifyCommand(cmd), classifyCommand(cmd)), 'the same command gives the same answer twice (no hidden state)');
  ok(sameJSON(classifyCommand('git add -A'), classifyCommand('git add -A', {})), 'options are optional');
  const notText = classifyCommand(42);
  ok(notText.ok === false && notText.steps.length === 0, 'a non-string command is unverified, not an exception');
  const huge = classifyCommand(`git add ${'a'.repeat(250000)}`);
  ok(huge.ok === false && huge.steps.length === 0, 'an oversized command is unverified');
  const deepGroups = classifyCommand(`echo ${'$('.repeat(70)}git add -A${')'.repeat(70)}`);
  ok(deepGroups.ok === false, 'substitutions nested past the group limit are unverified, not a stack overflow');
  // nine levels: past the depth limit (8) yet under the input limit (base64 of UTF-16 grows ~2.7x a level)
  let encoded = 'git add -A';
  for (let i = 0; i < 9; i++) encoded = `powershell -EncodedCommand ${Buffer.from(encoded, 'utf16le').toString('base64')}`;
  const deepScripts = classifyCommand(encoded);
  ok(deepScripts.ok === false && deepScripts.reasons.some((x) => /nested too deeply/.test(x)), 'scripts nested past the depth limit are unverified');
  let shallow = 'git add -A';
  for (let i = 0; i < 3; i++) shallow = `powershell -EncodedCommand ${Buffer.from(shallow, 'utf16le').toString('base64')}`;
  ok(classifyCommand(shallow).strongest === 'SWEEP' && classifyCommand(shallow).ok, 'three nested encoded commands are still decoded');
  ok(mentionsGit('git status') && mentionsGit('cd x && git.exe add -A') && mentionsGit('gh pr checkout 3'), 'mentionsGit: the guard gate matches git invocations');
  ok(!mentionsGit('ls -la') && !mentionsGit('digit 3'), 'mentionsGit: unrelated commands stay out of the classifier');
  ok(mentionsGit(`powershell -enc ${Buffer.from('git add -A', 'utf16le').toString('base64')}`), 'mentionsGit: an encoded PowerShell command is let through to be decoded');
  ok(mentionsGit('pwsh -NoProfile -EncodedCommand ZwBpAHQA') && mentionsGit('echo x\npowershell.exe /e ZwBpAHQA ') && !mentionsGit('powershell -NoProfile -Command Get-Date'), 'mentionsGit: the encoded switch is found anywhere after the program name, line by line');
  {
    const t0 = Date.now();
    mentionsGit('powershell '.repeat(20000));
    mentionsGit('pwsh x '.repeat(30000));
    const ms = Date.now() - t0;
    ok(ms < 300, `mentionsGit stays linear on long input (${ms} ms for 380k characters)`);
    const t1 = Date.now();
    const big = classifyCommand('git reset x; '.repeat(16000));
    const ms1 = Date.now() - t1;
    ok(big.ok === false && ms1 < 4000, `a long command past every limit answers inside the hook budget (${ms1} ms)`);
  }
  const step = classifyCommand('git add -A').steps[0];
  ok(sameJSON(Object.keys(step), ['index', 'raw', 'git', 'cwd', 'sub', 'tier', 'scope', 'paths', 'flags', 'action', 'needsRefCheck', 'readings', 'ok']), 'a step carries the V1_SCOPE fields plus action, needsRefCheck, readings and ok');
}

// ── R1b robustness: seeded fuzz ─────────────────────────────────────────────
// Random token soup in every dialect must never throw, never hang and always return a well-formed
// result; anything that does not parse must come back `ok: false`, never a confident reading.
console.log('R1b seeded fuzz');
{
  let seed = 0x5eed1e55;
  const rand = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const TOKENS = ['git', 'add', '-A', '.', 'commit', '-m', '-am', 'x', 'reset', '--hard', 'stash', 'checkout', '--', 'a.ts', '"', "'", '`', '$(', '$x', '${', '}', '{', '(', ')', ';', '&&', '||', '|', '&', '\n', '<<', 'EOF', "<<'EOF'", '#', BS, ' ', ' ', ' ', 'cd', 'sub', 'bash', '-c', 'eval', 'echo', "@'", "'@", '@"', '"@', '--%', ',', '>', '2>&1', 'powershell', '-Command', 'cmd', '/c', '$env:GIT_DIR', '=', 'if', 'then', 'fi', 'do', 'done', 'for', 'in', '[[', ']]', '<#', '#>', '%X%', '^', 'xargs', 'env', 'GIT_DIR=x'];
  const dialects = ['posix', 'powershell', 'cmd'];
  let threw = 0;
  let malformed = 0;
  let confidentButBroken = 0;
  const started = process.hrtime.bigint();
  for (let n = 0; n < 3000; n++) {
    const len = 1 + rand(24);
    let text = '';
    for (let k = 0; k < len; k++) text += TOKENS[rand(TOKENS.length)] + (rand(3) ? ' ' : '');
    const dialect = dialects[n % dialects.length];
    let r;
    try { r = classifyCommand(text, { dialect, platform: 'win32' }); } catch (err) { threw++; if (threw < 4) console.log(`      threw on ${JSON.stringify(text)} (${dialect}): ${err && err.stack}`); continue; }
    if (typeof r.ok !== 'boolean' || !Array.isArray(r.steps) || !TIERS.includes(r.strongest) || !Array.isArray(r.reasons)) malformed++;
    if (r.ok && r.reasons.some((x) => x.startsWith('could not parse'))) confidentButBroken++;
    // run() turns an internal exception into "classifier error"; the fuzz must never reach it
    if (r.reasons.some((x) => /classifier error/.test(x))) { threw++; if (threw < 4) console.log(`      internal error on ${JSON.stringify(text)} (${dialect}): ${r.reasons.join(' | ')}`); }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  ok(threw === 0, `3000 random commands never throw or hit the internal-error fallback (${threw})`);
  ok(malformed === 0, `…and always return a well-formed result (${malformed} malformed)`);
  ok(confidentButBroken === 0, `…and a parse problem is never reported as ok (${confidentButBroken})`);
  ok(ms < 15000, `…in reasonable time (${Math.round(ms)} ms for 3000)`);
  const big = `${'git status && '.repeat(1200)}git add -A`;
  const t0 = process.hrtime.bigint();
  const rb = classifyCommand(big);
  const bigMs = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(rb.ok === false && rb.reasons.some((x) => /more than 400 commands/.test(x)), 'a 1,200-command chain stops at the step cap and is unverified');
  ok(bigMs < 3000, `…quickly (${Math.round(bigMs)} ms for ${big.length} characters)`);
  const typical = 'cd sub && git add src/a.ts src/b.ts && git commit -m "$(cat <<\'EOF\'\nfix: a\n\nbody\nEOF\n)" && git status --short';
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 500; i++) classifyCommand(typical);
  const perMs = Number(process.hrtime.bigint() - t1) / 1e6 / 500;
  ok(perMs < 5, `a typical agent command classifies in well under a millisecond or so (${perMs.toFixed(3)} ms each)`);
}

// ── R2 purity ───────────────────────────────────────────────────────────────
console.log('R2 purity');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'whose-classify.mjs'), 'utf8').replace(/\r/g, '');
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok(sameJSON(imports, ['node:path']), `the module imports only node:path (found ${imports.join(', ') || 'none'})`);
  ok(!/\brequire\s*\(|\bimport\s*\(/.test(src), 'no require() and no dynamic import');
  ok(!/\bprocess\.(?:env|cwd|argv|stdout|stderr|exit)\b/.test(src), 'no process.env / cwd / argv / stdio');
  ok(!/\b(?:Date\.now|new Date|Math\.random|setTimeout|readFileSync|execFileSync|spawnSync)\b/.test(src), 'no clock, randomness, timers or IO calls');
  const platformReads = src.match(/process\.platform/g) || [];
  ok(platformReads.length === 1, 'process.platform is read once, only as the default for the platform option');
}

// ── R3 option tables against the local git ──────────────────────────────────
console.log('R3 option tables vs git -h');
{
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('  (git not found: option-table parity skipped)');
  } else {
    const version = (/(\d+\.\d+)\.\d+/.exec(probe.stdout) || [])[1] || '?';
    const strict = version === '2.53';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-whose-classify-'));
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), HOME: tmp, USERPROFILE: tmp };
    const git = (...a) => spawnSync('git', a, { cwd: tmp, env, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
      // the same column rule the tables were generated with: git pads option specs to column 26
      const parseHelp = (text) => {
        const out = [];
        for (const line of String(text).replace(/\r/g, '').split('\n')) {
          if (!/^\s{2,}-/.test(line)) continue;
          const raw = line.replace(/\s+$/, '');
          const spec = raw.length > 25 && raw[25] === ' ' ? raw.slice(0, 25).trim() : raw.trim();
          let m = /^-([A-Za-z0-9]),\s*--(\[no-\])?([A-Za-z0-9][\w-]*)(.*)$/.exec(spec);
          let short = '';
          let long = '';
          let rest = '';
          if (m) { short = m[1]; long = m[3]; rest = m[4]; }
          else if ((m = /^--(\[no-\])?([A-Za-z0-9][\w-]*)(.*)$/.exec(spec))) { long = m[2]; rest = m[3]; }
          else if ((m = /^-([A-Za-z0-9])(.*)$/.exec(spec))) { short = m[1]; rest = m[2]; }
          else continue;
          out.push(`${short}|${long}${/^\[=/.test(rest) ? '?' : /^\s+\S/.test(rest) ? '=' : ''}`);
        }
        return out;
      };
      let drift = 0;
      for (const [verb, spec] of Object.entries(GIT_OPTION_SPECS)) {
        const h = git(...verb.split(' '), '-h');
        const live = new Set(parseHelp(`${h.stdout}${h.stderr}`));
        const ours = new Set(spec.split(/\s+/).filter(Boolean));
        const missing = [...live].filter((t) => !ours.has(t));
        const extra = [...ours].filter((t) => !live.has(t));
        if (missing.length || extra.length) {
          drift++;
          const note = `git ${verb} -h differs: missing ${missing.join(' ') || '-'}; not in git ${extra.join(' ') || '-'}`;
          if (strict) ok(false, note); else console.log(`  (git ${version}) ${note}`);
        }
      }
      if (strict) ok(drift === 0, `every option table matches git ${probe.stdout.trim()} (${Object.keys(GIT_OPTION_SPECS).length} verbs)`);
      // hidden options: --git-completion-helper-all minus --git-completion-helper (long, positive names)
      let hiddenDrift = 0;
      for (const verb of Object.keys(GIT_OPTION_SPECS)) {
        const words = (flag) => String(git(...verb.split(' '), flag).stdout || '').trim().split(/\s+/).filter(Boolean);
        const visible = new Set(words('--git-completion-helper'));
        const live = new Set(words('--git-completion-helper-all').filter((x) => !visible.has(x) && x.startsWith('--') && !x.startsWith('--no-')).map((x) => x.slice(2).replace(/=$/, '')));
        const shown = new Set(GIT_OPTION_SPECS[verb].split(/\s+/).map((t) => (/\|([\w-]+)/.exec(t) || [])[1]).filter(Boolean));
        for (const x of shown) live.delete(x);
        const ours = new Set(String(GIT_HIDDEN_OPTION_SPECS[verb] || '').split(/\s+/).filter(Boolean).map((t) => t.replace(/^\|/, '').replace(/=$/, '')));
        const missing = [...live].filter((t) => !ours.has(t));
        const extra = [...ours].filter((t) => !live.has(t));
        if (missing.length || extra.length) {
          hiddenDrift++;
          const note = `git ${verb} hidden options differ: missing ${missing.join(' ') || '-'}; not in git ${extra.join(' ') || '-'}`;
          if (strict) ok(false, note); else console.log(`  (git ${version}) ${note}`);
        }
      }
      if (strict) ok(hiddenDrift === 0, 'every hidden-option table matches --git-completion-helper-all');
      else console.log(`  (git ${version} is not the 2.53 baseline: ${drift} table(s) differ, reported above, not failed)`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} whose-classify — ${CASES.length} table cases; ${pass} checks passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
