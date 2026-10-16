// "Whose is this?": classify the git commands inside one shell command (klypix-mcp 1.103.0).
//
// The PreToolUse guard receives a Bash or PowerShell command as one string. Before KLYPIX can warn,
// ask or stop anything it has to know, without running anything, which git invocations that string
// would start, from which directory, what each would do to uncommitted work (its tier) and which
// files each one names. This module answers exactly that and nothing more.
//
// PURE. No fs, no child_process, no clock, no environment reads; the only import is node:path. The
// caller does every git and disk read (status, rev-parse, the ledger), so the classifier is cheap
// enough to run on every command and simple to test as a table.
//
// THE ONE RULE: when the classifier is not sure, it says so (`ok: false`) instead of guessing a
// strong tier, and the caller gives context only; it never asks or denies on a guess. "Not sure"
// covers parse errors (an unbalanced quote, an unterminated substitution), values only the shell
// knows (`$FILES`, `"$@"`, `$(…)` used as a path, `xargs`, an unquoted glob the shell expands), a
// directory only the shell knows (`cd $DIR`, a `cd` that may not have run), git pointed elsewhere
// (GIT_DIR, --git-dir, GIT_INDEX_FILE), a git verb that is not a built-in (an alias) and an
// ambiguous dialect. Where git's reading depends on the repository (`git checkout X` switches
// branches when X is a branch and discards changes when X is a file) the step reports the weaker
// reading, plus `needsRefCheck: X` and both readings, so the caller can settle it with one
// `git rev-parse --verify --quiet --end-of-options X^{commit}`.
//
// FALSE-POSITIVE GUARDS. Only command words are classified. Text that is data never is: arguments
// of echo / printf / Write-Host, patterns of grep / rg / Select-String, `git log -S/-G/--grep`
// values, commit messages (`-m`, `-F`), quoted strings, comments (`#`, `<# #>`), here-doc and
// here-string bodies, and `git help` / `-h` / `--help`. What the shell WOULD execute inside such
// text is still found: `$(…)` and backticks in POSIX double quotes and unquoted here-docs, `$(…)`
// in PowerShell double-quoted strings and @"…"@ here-strings, and a here-doc fed to `bash`.
//
// DIALECTS, one per call: 'posix' (Claude's Bash tool: bash or Git Bash) and 'powershell' (Claude's
// PowerShell tool; Windows PowerShell 5.1 and pwsh 7 syntax are both accepted). Nested scripts
// switch dialect where the program says so: bash|sh|zsh|dash -c, eval, powershell|pwsh -Command or
// -EncodedCommand, Invoke-Expression, cmd /c|/k. Any other dialect value is ambiguous: both
// readings are computed, the stronger one is returned and `ok` is false (safety-B6).
//
// RESULT (V1_SCOPE.md, "src/whose-classify.mjs"):
//   ok        false = could not verify; the caller gives context only.
//   steps[]   every simple command in execution order (substitutions before the command that uses
//             them, a wrapper such as `bash -c` before the script it runs):
//     index, raw     position and source text
//     git            a git invocation (also `gh pr checkout` and `gh pr merge -d`)
//     cwd            null = the hook's cwd; otherwise from cd / pushd / Set-Location earlier in the
//                    same shell and `git -C`, relative to the hook cwd or absolute, with '/'
//                    separators (MSYS /e/x becomes E:/x for the posix dialect on win32)
//     sub            canonical subcommand (`git stage` reports 'add'); null when not git
//     tier           one of TIERS
//     scope          which uncommitted entries the step reaches before `paths` narrows it: 'all'
//                    (tracked and untracked), 'tracked' (staged and unstaged changes to tracked
//                    files), 'untracked' (clean), 'index' (staged entries), 'paths' (just the named
//                    paths: EXPLICIT) or null. `commit -i` reports 'index' plus the paths it adds;
//                    `worktree remove` reports 'all' with the worktree directory in `paths`.
//     paths          pathspecs as git receives them (quotes removed), or null
//     flags          canonical options seen (`--all`, `--message`, `-d`) plus global ones that
//                    matter (`--literal-pathspecs`, `-c core.hookspath`, `env:GIT_DIR`)
//     action         (additive) the sub-subcommand: stash push|save|pop|apply|drop|clear|branch|…,
//                    worktree remove|add|…, rebase/merge/… abort|quit
//     needsRefCheck  (additive) the word whose meaning depends on the repository, or null
//     readings       (additive) with needsRefCheck: { commit, path }, each { tier, scope, paths }:
//                    the reading when the word names a commit and when it does not. The step's
//                    own tier/scope/paths are the weaker of the two (the narrower at equal tiers).
//     ok             (additive) false when this step could not be verified
//   strongest  the strongest tier over all steps
//   stagedBeforeCommit  { [commitStepIndex]: string[] } for every step that creates a commit: the
//             explicit paths that earlier `git add <paths>` steps of the same command stage and that
//             commit would include, joined with the add's cwd (so relative to the hook cwd). A
//             `git reset`, `restore --staged`, `stash` or commit in between removes them; a
//             `commit -- <paths>` lists [] because it ignores the index.
//   reasons   why each risky tier fired, plus every could-not-verify and parse reason
//   dialect   (additive) the dialect used, or null when it was ambiguous
//
// TIERS follow spec §3.2 with the V1_SCOPE changes: `git add <paths>` and `git commit [--] <paths>`
// are EXPLICIT; `stash pop/apply/drop/clear/branch` are MOVE, because whether a popped or dropped
// stash belongs to another session is the caller's call (the classifier reports `action`); MOVE
// covers checkout <branch>, switch, rebase, merge, pull, cherry-pick, revert, am, gh pr checkout.
import path from 'node:path';

export const TIERS = ['SAFE', 'READ', 'EXPLICIT', 'UNSTAGE', 'MOVE', 'PARK', 'DISCARD', 'SWEEP'];
const TIER_RANK = new Map(TIERS.map((tier, rank) => [tier, rank]));
export const tierRank = (tier) => TIER_RANK.get(tier) ?? 0;
const stronger = (a, b) => (tierRank(b) > tierRank(a) ? b : a);

// The guard's cheap pre-check (spec §1.7) plus PowerShell's encoded-command switch, whose payload can
// start git without the word "git" appearing anywhere in the text.
export const GIT_GATE_RE = /\bgit(?:\.exe|\.cmd)?\b|\bgh(?:\.exe)?\s+pr\s+(?:checkout|merge)\b/i;
const ENCODED_SWITCH_RE = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*?\s[-/]e(?:c|n[a-z]*)?\s/i;
export function mentionsGit(command) {
  const text = Array.isArray(command) ? command.map(String).join(' ') : String(command ?? '');
  return GIT_GATE_RE.test(text) || ENCODED_SWITCH_RE.test(text);
}

const MAX_INPUT = 200000;
const MAX_DEPTH = 8; // nested scripts: bash -c "…$(…)…" and the like
const MAX_NEST = 64; // nested groups inside one script
const MAX_STEPS = 400;
const MAX_BRACE_WORDS = 64;
const TOO_MANY_STEPS = `more than ${MAX_STEPS} commands`;
const DEFAULT_PLATFORM = (typeof process !== 'undefined' && process && process.platform) || 'linux';

const dedupe = (list) => [...new Set(list)];
function clip(text, max = 80) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ───────────────────────────── git option tables ─────────────────────────────
// Generated from `git <verb> -h` (Git 2.53.0); test/whose-classify.mjs re-reads them from the local
// git. Token = <short>|<long><arity>: arity '' takes no value, '=' takes one (stuck or the next
// word), '?' takes an optional value that must be stuck (`-u<mode>`, `--gpg-sign=<key>`).
// A missing entry means a value would be read as a path, so the tables err toward completeness.
export const GIT_OPTION_SPECS = Object.freeze({
  add: 'n|dry-run v|verbose i|interactive p|patch U|unified= |inter-hunk-context= e|edit f|force u|update |renormalize N|intent-to-add A|all |ignore-removal |refresh |ignore-errors |ignore-missing |sparse |chmod= |pathspec-from-file= |pathspec-file-nul',
  commit: 'q|quiet v|verbose F|file= |author= |date= m|message= c|reedit-message= C|reuse-message= |fixup= |squash= |reset-author |trailer= s|signoff t|template= e|edit |cleanup= |status S|gpg-sign? a|all i|include |interactive p|patch U|unified= |inter-hunk-context= o|only n|no-verify |verify |dry-run |short |branch |ahead-behind |porcelain |long z|null |amend |no-post-rewrite |post-rewrite u|untracked-files? |pathspec-from-file= |pathspec-file-nul',
  reset: 'q|quiet |no-refresh |refresh |mixed |soft |hard |merge |keep |recurse-submodules? p|patch U|unified= |inter-hunk-context= N|intent-to-add |pathspec-from-file= |pathspec-file-nul z| |stdin',
  checkout: 'b|= B|= l| |guess |overlay q|quiet |recurse-submodules? |progress m|merge |conflict= d|detach t|track? f|force |orphan= |overwrite-ignore |ignore-other-worktrees 2|ours 3|theirs p|patch U|unified= |inter-hunk-context= |ignore-skip-worktree-bits |pathspec-from-file= |pathspec-file-nul',
  switch: 'c|create= C|force-create= |guess |discard-changes q|quiet |recurse-submodules? |progress m|merge |conflict= d|detach t|track? f|force |orphan= |overwrite-ignore |ignore-other-worktrees',
  restore: 's|source= S|staged W|worktree |ignore-unmerged |overlay q|quiet |recurse-submodules? |progress m|merge |conflict= 2|ours 3|theirs p|patch U|unified= |inter-hunk-context= |ignore-skip-worktree-bits |pathspec-from-file= |pathspec-file-nul',
  clean: 'q|quiet n|dry-run f|force i|interactive d| e|exclude= x| X|',
  rm: 'n|dry-run q|quiet |cached f|force r| |ignore-unmatch |sparse |pathspec-from-file= |pathspec-file-nul',
  'stash push': 'k|keep-index S|staged p|patch U|unified= |inter-hunk-context= q|quiet u|include-untracked a|all m|message= |pathspec-from-file= |pathspec-file-nul',
  'stash save': 'k|keep-index S|staged p|patch U|unified= |inter-hunk-context= q|quiet u|include-untracked a|all m|message=',
  'stash pop': 'q|quiet |index',
  'stash apply': 'q|quiet |index',
  'stash drop': 'q|quiet',
  'stash branch': '',
  'stash store': 'q|quiet m|message=',
  'worktree remove': 'f|force',
  'worktree add': 'f|force b|= B|= |orphan d|detach |checkout |lock |reason= q|quiet |track |guess-remote |relative-paths',
  rebase: '|onto= |keep-base |no-verify |verify q|quiet v|verbose n|no-stat |stat |signoff |committer-date-is-author-date |reset-author-date C|= |ignore-whitespace |whitespace= f|force-rebase |no-ff |ff |continue |skip |abort |quit |edit-todo |show-current-patch |apply m|merge i|interactive |rerere-autoupdate |empty= |autosquash |update-refs S|gpg-sign? |autostash x|exec= r|rebase-merges? |fork-point s|strategy= X|strategy-option= |root |reschedule-failed-exec |reapply-cherry-picks',
  merge: 'n| |stat |summary |compact-summary |log? |squash |commit e|edit |cleanup= |ff |ff-only |rerere-autoupdate |verify-signatures s|strategy= X|strategy-option= m|message= F|file= |into-name= v|verbose q|quiet |abort |quit |continue |allow-unrelated-histories |progress S|gpg-sign? |autostash |overwrite-ignore |signoff |no-verify |verify',
  pull: 'v|verbose q|quiet |progress |recurse-submodules? r|rebase? n| |stat |compact-summary |log? |signoff? |squash |commit |edit |cleanup= |ff |ff-only |verify |verify-signatures |autostash s|strategy= X|strategy-option= S|gpg-sign? |allow-unrelated-histories |all a|append |upload-pack= f|force t|tags p|prune j|jobs? |dry-run k|keep |depth= |shallow-since= |shallow-exclude= |deepen= |unshallow |update-shallow |refmap= o|server-option= 4|ipv4 6|ipv6 |negotiation-tip= |show-forced-updates |set-upstream',
  'cherry-pick': '|quit |continue |abort |skip |cleanup= n|no-commit |commit e|edit s|signoff m|mainline= |rerere-autoupdate |strategy= X|strategy-option= S|gpg-sign? x| |ff |allow-empty |allow-empty-message |keep-redundant-commits |empty=',
  revert: '|quit |continue |abort |skip |cleanup= n|no-commit |commit e|edit s|signoff m|mainline= |rerere-autoupdate |strategy= X|strategy-option= S|gpg-sign? |reference',
  am: 'i|interactive n|no-verify |verify 3|3way q|quiet s|signoff u|utf8 k|keep |keep-non-patch m|message-id |keep-cr c|scissors |quoted-cr= |whitespace= |ignore-space-change |ignore-whitespace |directory= |exclude= |include= C|= p|= |patch-format= |reject |resolvemsg= |continue r|resolved |skip |abort |quit |show-current-patch? |retry |allow-empty |committer-date-is-author-date |ignore-date |rerere-autoupdate S|gpg-sign? |empty=',
  'read-tree': '|index-output= |empty v|verbose m| |trivial |aggressive |reset |prefix= u| |exclude-per-directory= i| n|dry-run |no-sparse-checkout |sparse-checkout |debug-unpack |recurse-submodules? q|quiet',
  'checkout-index': 'a|all |ignore-skip-worktree-bits f|force q|quiet n|no-create |create u|index z| |stdin |temp |prefix= |stage=',
  status: 'v|verbose s|short b|branch |show-stash |ahead-behind |porcelain? |long z|null u|untracked-files? |ignored? |ignore-submodules? |column? |no-renames |renames M|find-renames?',
  'ls-files': 'z| t| v| f| c|cached d|deleted m|modified o|others i|ignored s|stage k|killed |directory |eol |empty-directory u|unmerged |resolve-undo x|exclude= X|exclude-from= |exclude-per-directory= |exclude-standard |full-name |recurse-submodules |error-unmatch |with-tree= |abbrev? |debug |deduplicate |sparse |format=',
});

const TABLES = new Map();
function optTable(key) {
  let table = TABLES.get(key);
  if (table) return table;
  const short = new Map();
  const long = new Map();
  for (const token of String(GIT_OPTION_SPECS[key] || '').split(/\s+/)) {
    const m = /^([^|]?)\|([A-Za-z0-9][\w-]*)?([=?]?)$/.exec(token);
    if (!m) continue;
    const entry = { name: m[2] || m[1], short: m[1] || null, long: m[2] || null, arity: m[3] === '=' ? 'req' : m[3] === '?' ? 'opt' : 'none' };
    if (entry.short) short.set(entry.short, entry);
    if (entry.long) long.set(entry.long, entry);
  }
  table = { short, long, longNames: [...long.keys()] };
  TABLES.set(key, table);
  return table;
}

// git parse-options: exact long name, `--no-<name>` negation, or a unique prefix of either.
function lookupLong(table, name) {
  if (!name) return null;
  if (table.long.has(name)) return { entry: table.long.get(name), neg: false };
  if (name.startsWith('no-') && table.long.has(name.slice(3))) return { entry: table.long.get(name.slice(3)), neg: true };
  const hits = new Map();
  for (const n of table.longNames) if (n.startsWith(name)) hits.set(`${n}:+`, { entry: table.long.get(n), neg: false });
  if (name.startsWith('no-') && name.length > 3) {
    for (const n of table.longNames) if (n.startsWith(name.slice(3))) hits.set(`${n}:-`, { entry: table.long.get(n), neg: true });
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

const flagName = (entry, neg) => (neg ? `--no-${entry.long || entry.short}` : entry.long ? `--${entry.long}` : `-${entry.short}`);

// Options may appear anywhere before `--` (git does not stop at the first non-option).
function parseOpts(args, key) {
  const table = optTable(key);
  const o = { set: new Map(), at: new Map(), flags: [], pos: [], dd: [], sawDD: false, unknown: [], help: false, missing: false };
  let seq = 0;
  const record = (entry, value, neg) => {
    o.set.set(entry.name, neg ? false : value === undefined ? true : value);
    o.at.set(entry.name, seq++);
    const f = flagName(entry, neg);
    if (!o.flags.includes(f)) o.flags.push(f);
  };
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = a.value;
    if (endOfOptions || a.dyn || !v.startsWith('-') || v === '-') { o.pos.push(a); continue; }
    if (v === '--') { o.sawDD = true; o.dd = args.slice(i + 1); break; }
    if (v === '--end-of-options') { endOfOptions = true; continue; }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const name = eq < 0 ? v.slice(2) : v.slice(2, eq);
      const value = eq < 0 ? undefined : v.slice(eq + 1);
      if (name === 'help' || name === 'help-all') { o.help = true; continue; }
      const hit = lookupLong(table, name);
      if (!hit) { o.unknown.push(v); continue; }
      if (hit.neg) { if (value !== undefined) o.unknown.push(v); record(hit.entry, undefined, true); continue; }
      if (hit.entry.arity === 'req') {
        if (value !== undefined) { record(hit.entry, value); continue; }
        if (i + 1 >= args.length) { o.missing = true; continue; }
        record(hit.entry, args[i + 1].value);
        i++;
        continue;
      }
      if (hit.entry.arity === 'none' && value !== undefined) { o.unknown.push(v); continue; }
      record(hit.entry, value);
      continue;
    }
    if (v === '-h' && !table.short.has('h')) { o.help = true; continue; }
    // A short cluster is walked left to right; the first letter that takes a value eats the rest of
    // the cluster or the next word, so `-am x` is `-a -m x` and `-ma` is the message "a".
    for (let k = 1; k < v.length; k++) {
      const entry = table.short.get(v[k]);
      if (!entry) { o.unknown.push(`-${v[k]}`); break; }
      if (entry.arity === 'none') { record(entry); continue; }
      const rest = v.slice(k + 1);
      if (entry.arity === 'opt') { record(entry, rest || undefined); break; }
      if (rest) { record(entry, rest); break; }
      if (i + 1 >= args.length) { o.missing = true; break; }
      record(entry, args[i + 1].value);
      i++;
      break;
    }
  }
  return o;
}
const isOn = (o, name) => o.set.has(name) && o.set.get(name) !== false;
const lastAt = (o, name) => (o.at.has(name) ? o.at.get(name) : -1);

// ───────────────────────────── paths and revisions ─────────────────────────────

function msysToWin(p) {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] || '/'}` : p;
}
// Git Bash rewrites /e/x to E:/x before a native program such as git.exe sees it.
const hostPath = (value, ctx) => (ctx && ctx.dialect === 'posix' && ctx.platform === 'win32' ? msysToWin(value) : value);

function normDir(p) {
  const raw = String(p).replace(/\\/g, '/');
  const unc = raw.startsWith('//');
  let n = path.posix.normalize(raw);
  if (unc && !n.startsWith('//')) n = `/${n}`;
  if (n.length > 1 && n.endsWith('/') && !/^[A-Za-z]:\/$/.test(n)) n = n.slice(0, -1);
  if (/^[A-Za-z]:$/.test(n)) n += '/';
  return n === '.' ? '' : n;
}
const isAbsDir = (p) => /^(?:[A-Za-z]:(?:[\\/]|$)|[\\/]|~(?:[\\/]|$))/.test(p);
function joinDir(base, next) {
  const n = String(next ?? '').replace(/\\/g, '/');
  if (n === '') return base ?? null;
  if (isAbsDir(n) || !base) return normDir(n) || null;
  return normDir(`${base}/${n}`) || null;
}
function joinPath(cwd, p) {
  const q = String(p).replace(/\\/g, '/');
  if (!cwd || isAbsDir(q)) return q;
  return path.posix.normalize(`${cwd}/${q}`);
}

function isDirLike(p) {
  const q = p.replace(/\\/g, '/');
  return q === '' || q === '.' || q === '..' || q.endsWith('/') || /(?:^|\/)\.\.?$/.test(q);
}
// 'narrow' (one file, as far as text can tell), 'broad' (a directory, a glob, the whole tree) or
// 'exclude' (an exclusion that adds nothing by itself).
function pathspecKind(spec, literal) {
  let rest = spec;
  if (!literal && spec.startsWith(':')) {
    const magic = new Set();
    if (spec[1] === '(') {
      const close = spec.indexOf(')');
      if (close < 0) return 'broad';
      for (const m of spec.slice(2, close).split(',')) magic.add(m.trim().toLowerCase().split(':')[0]);
      rest = spec.slice(close + 1);
    } else {
      let k = 1;
      while (k < spec.length && '/!^'.includes(spec[k])) { magic.add(spec[k] === '/' ? 'top' : 'exclude'); k++; }
      if (spec[k] === ':') k++;
      rest = spec.slice(k);
    }
    if (magic.has('exclude')) return 'exclude';
    if (magic.has('glob') || magic.has('icase') || magic.has('attr')) return 'broad';
    if (isDirLike(rest)) return 'broad';
    if (magic.has('literal')) return 'narrow';
  }
  if (isDirLike(rest)) return 'broad';
  if (!literal && /[*?[]/.test(rest)) return 'broad';
  return 'narrow';
}
function pathspecs(words, info) {
  const out = { paths: [], broad: false, unknown: false, why: [] };
  let positive = false;
  let exclude = false;
  for (const w of words) {
    out.paths.push(hostPath(w.value, info.ctx));
    if (w.dyn) { out.unknown = true; out.why.push(`the pathspec ${clip(w.raw, 40)} is only known when the shell runs`); continue; }
    if (w.glob && info.ctx.dialect === 'posix') { out.unknown = true; out.why.push(`the shell expands ${clip(w.raw, 40)} against the disk first`); continue; }
    const kind = pathspecKind(w.value, info.literal);
    if (kind === 'exclude') { exclude = true; continue; }
    positive = true;
    if (kind === 'broad') out.broad = true;
  }
  if (exclude && !positive) out.broad = true; // only exclusions: git starts from the whole tree
  return out;
}

const HEADLIKE = new Set(['HEAD', '@']);
function looksLikeRevision(x) {
  if (/^(?:HEAD|@|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|REVERT_HEAD|AUTO_MERGE)$/.test(x)) return true;
  if (x === '-' || /[~^]/.test(x) || x.includes('@{')) return true;
  // an abbreviated hash; an all-letter word such as "defaced" is left for the caller to resolve
  return /^[0-9a-f]{7,64}$/i.test(x) && /\d/.test(x);
}
// True when `x` can only be a path: it breaks git check-ref-format, so no branch can have that name.
function definitelyPath(x) {
  if (x === '' || x === '.' || x === '..') return true;
  if (/^\.\.?[\\/]/.test(x) || /[\\/]$/.test(x)) return true;
  if (/[*?[\\\s:]/.test(x) || x.includes('..')) return true;
  if (/(?:^|\/)\./.test(x) || /\.lock(?:\/|$)/.test(x) || x.endsWith('.')) return true;
  return false;
}

// ───────────────────────────── shell words ─────────────────────────────
// A word keeps its parts: `lit` parts are unquoted text (the only text brace expansion and globbing
// act on), `dyn` parts are expansions whose value only the shell knows.

function newParser(src, depth) {
  return { src, i: 0, errors: [], pending: [], cdepth: 0, depth, nest: 0 };
}
function newWord(start) {
  return { segs: [], start, end: start, raw: '', value: '', dyn: false, opaque: false, quoted: false, glob: false, subs: [] };
}
function addText(w, text, lit) {
  if (!text) return;
  const last = w.segs[w.segs.length - 1];
  if (last && !last.dyn && last.lit === lit) last.t += text;
  else w.segs.push({ t: text, lit, dyn: false });
}
function addDyn(w, text) {
  w.segs.push({ t: text, lit: false, dyn: true });
  w.dyn = true;
}
function endWord(P, w) {
  w.end = P.i;
  w.raw = P.src.slice(w.start, w.end);
  w.value = w.segs.map((s) => s.t).join('');
  w.glob = w.segs.some((s) => s.lit && /[*?[]/.test(s.t));
  return w;
}
const literalArg = (value) => ({ value, raw: value, dyn: false, opaque: false, quoted: true, glob: false, segs: [{ t: value, lit: false, dyn: false }], subs: [] });
const argOf = (w) => ({ value: w.value, raw: w.raw, dyn: w.dyn || w.opaque, opaque: w.opaque, quoted: w.quoted, glob: w.glob, segs: w.segs, subs: w.subs });

// POSIX brace expansion ({a,b} → two words) is deterministic, so it is expanded rather than guessed;
// sequence forms ({1..9}) are left unknown.
function wordToArgs(w, dialect) {
  if (dialect !== 'posix' || w.dyn || !w.segs.some((s) => s.lit && s.t.includes('{'))) return [argOf(w)];
  const chars = [];
  for (const s of w.segs) for (const ch of s.t) chars.push({ ch, lit: s.lit });
  const out = [];
  let unknown = false;
  const expand = (cs) => {
    if (unknown || out.length > MAX_BRACE_WORDS) { unknown = true; return; }
    for (let i = 0; i < cs.length; i++) {
      if (!(cs[i].lit && cs[i].ch === '{')) continue;
      let depth = 0;
      let close = -1;
      const commas = [];
      for (let j = i; j < cs.length; j++) {
        if (!cs[j].lit) continue;
        if (cs[j].ch === '{') depth++;
        else if (cs[j].ch === '}') { depth--; if (depth === 0) { close = j; break; } }
        else if (cs[j].ch === ',' && depth === 1) commas.push(j);
      }
      if (close < 0) continue;
      if (!commas.length) {
        const body = cs.slice(i + 1, close).map((c) => c.ch).join('');
        if (/^-?\w+\.\.-?\w+(?:\.\.-?\d+)?$/.test(body)) { unknown = true; return; }
        continue;
      }
      const bounds = [i, ...commas, close];
      for (let k = 0; k < bounds.length - 1; k++) expand([...cs.slice(0, i), ...cs.slice(bounds[k] + 1, bounds[k + 1]), ...cs.slice(close + 1)]);
      return;
    }
    out.push(cs);
  };
  expand(chars);
  if (unknown) return [{ ...argOf(w), dyn: true }];
  return out.map((cs) => {
    const value = cs.map((c) => c.ch).join('');
    return { value, raw: w.raw, dyn: false, opaque: false, quoted: w.quoted, glob: cs.some((c) => c.lit && /[*?[]/.test(c.ch)), segs: [{ t: value, lit: false, dyn: false }], subs: [] };
  });
}

// ───────────────────────────── POSIX shell ─────────────────────────────

function parsePosixSource(src, depth) {
  const P = newParser(src, depth);
  if (depth > MAX_DEPTH) { P.errors.push('commands are nested too deeply to analyse'); return { seq: { lists: [] }, errors: P.errors }; }
  const seq = seqP(P, null);
  return { seq, errors: P.errors };
}

function skipBlankP(P) {
  const { src } = P;
  for (;;) {
    const c = src[P.i];
    if (c === ' ' || c === '\t' || c === '\r') { P.i++; continue; }
    if (c === '\\' && src[P.i + 1] === '\n') { P.i += 2; continue; }
    if (c === '#') { const nl = src.indexOf('\n', P.i); P.i = nl < 0 ? src.length : nl; continue; }
    return;
  }
}
function skipBlankNLP(P) {
  for (;;) {
    skipBlankP(P);
    if (P.src[P.i] !== '\n') return;
    P.i++;
    readHeredocs(P);
  }
}

function seqP(P, closer) {
  const { src } = P;
  const lists = [];
  while (P.i < src.length) {
    skipBlankP(P);
    if (P.i >= src.length) break;
    const c = src[P.i];
    if (closer === ')' && c === ')') break;
    if (c === '\n') { P.i++; readHeredocs(P); continue; }
    if (c === ';') {
      if (src[P.i + 1] === ';') { P.errors.push("';;' outside a case statement"); P.i += 2; } else P.i++;
      continue;
    }
    if (c === ')') { P.errors.push("unbalanced ')'"); P.i++; continue; }
    if ((c === '&' && src[P.i + 1] !== '>') || c === '|') { P.errors.push(`'${c}' with no command before it`); P.i++; continue; }
    const before = P.i;
    lists.push(andOrP(P, closer));
    if (P.i === before) { P.errors.push(`unexpected '${src[P.i]}'`); P.i++; }
  }
  return { lists };
}

function andOrP(P, closer) {
  const { src } = P;
  const items = [];
  const ops = [];
  for (;;) {
    items.push(pipelineP(P, closer));
    skipBlankP(P);
    const two = src.slice(P.i, P.i + 2);
    if (two === '&&' || two === '||') { ops.push(two); P.i += 2; skipBlankNLP(P); continue; }
    break;
  }
  let term = '';
  const c = src[P.i];
  if (c === ';' && src[P.i + 1] !== ';') { term = ';'; P.i++; }
  else if (c === '&' && src[P.i + 1] !== '>') { term = '&'; P.i++; }
  else if (c === '\n') { term = '\n'; P.i++; readHeredocs(P); }
  return { items, ops, bg: term === '&', term };
}

function pipelineP(P, closer) {
  const { src } = P;
  const cmds = [];
  skipBlankP(P);
  if (src[P.i] === '!' && /[ \t\r\n]/.test(src[P.i + 1] || ' ')) P.i++;
  for (;;) {
    cmds.push(commandP(P, closer));
    skipBlankP(P);
    if (src[P.i] === '|' && src[P.i + 1] !== '|') {
      P.i++;
      if (src[P.i] === '&') P.i++;
      skipBlankNLP(P);
      continue;
    }
    return { cmds };
  }
}

// Reserved words are recognised only where a command name would be. The ones that open or separate
// a body are skipped, so the command after `then` or `do` is read like any other; the conditional
// depth they track lets the walker notice a `cd` inside an if/while body.
const POSIX_SKIP_WORDS = new Set(['if', 'while', 'until', '!', '{', '}', 'elif', 'else', 'esac', 'coproc']);
function commandP(P, closer) {
  const { src } = P;
  skipBlankP(P);
  const start = P.i;
  if (src[P.i] === '(') {
    if (src[P.i + 1] === '(') {
      P.i = skipArith(P, P.i + 2);
      return { kind: 'simple', words: [], assigns: [], redirs: [], start, end: P.i, depth: P.cdepth, src };
    }
    P.i++;
    const seq = nestedSeqP(P);
    const redirs = [];
    for (;;) { skipBlankP(P); if (!redirP(P, redirs)) break; }
    return { kind: 'subshell', seq, redirs, start, end: P.i, depth: P.cdepth, src };
  }
  const cmd = { kind: 'simple', words: [], assigns: [], redirs: [], start, end: start, depth: P.cdepth, src };
  let test = false;
  for (;;) {
    skipBlankP(P);
    if (P.i >= src.length) break;
    const c = src[P.i];
    if (c === '\n') break;
    if (!test) {
      if (c === ';' || c === ')' || c === '|') break;
      if (c === '&' && src[P.i + 1] !== '>') break;
      if (c === '(') {
        const fn = /^\(\s*\)/.exec(src.slice(P.i, P.i + 16));
        if (fn && cmd.words.length === 1 && !cmd.assigns.length) { cmd.words.pop(); P.i += fn[0].length; skipBlankNLP(P); cmd.start = P.i; continue; }
        P.errors.push("unexpected '('");
        P.i++;
        continue;
      }
      if (redirP(P, cmd.redirs)) continue;
    }
    const w = wordP(P, test);
    if (w.end === w.start) { P.errors.push(`unexpected '${c}'`); P.i++; continue; }
    if (test) { cmd.words.push(w); if (w.value === ']]' && !w.quoted) test = false; continue; }
    if (!cmd.words.length && !cmd.assigns.length && !w.quoted && !w.dyn) {
      const word = w.value;
      // the command's own text starts after the reserved word
      if (POSIX_SKIP_WORDS.has(word)) { cmd.start = P.i; continue; }
      if (word === 'then' || word === 'do') { P.cdepth++; cmd.depth = P.cdepth; cmd.start = P.i; continue; }
      if (word === 'fi' || word === 'done') { P.cdepth = Math.max(0, P.cdepth - 1); cmd.depth = P.cdepth; cmd.start = P.i; continue; }
      if (word === 'function') {
        skipBlankP(P);
        wordP(P, false);
        const fn = /^[ \t]*\(\s*\)/.exec(src.slice(P.i, P.i + 16));
        if (fn) P.i += fn[0].length;
        skipBlankNLP(P);
        cmd.start = P.i;
        continue;
      }
      if (word === 'for' || word === 'select') { forHeaderP(P, cmd); break; }
      if (word === 'case') { caseP(P, cmd); break; }
      if (word === '[[') { test = true; cmd.words.push(w); continue; }
    }
    if (!cmd.words.length && isAssignmentWord(w)) { cmd.assigns.push(w); continue; }
    cmd.words.push(w);
  }
  cmd.end = P.i;
  return cmd;
}

const isAssignmentWord = (w) => w.segs.length > 0 && w.segs[0].lit && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(w.segs[0].t);

// `for x in words; do …` — the word list is evaluated (its substitutions run) but is not a command.
function forHeaderP(P, cmd) {
  const { src } = P;
  cmd.header = true;
  skipBlankP(P);
  if (src.startsWith('((', P.i)) { P.i = skipArith(P, P.i + 2); return; }
  wordP(P, false);
  skipBlankP(P);
  const save = P.i;
  const maybeIn = wordP(P, false);
  if (maybeIn.value !== 'in' || maybeIn.quoted) { P.i = save; return; }
  for (;;) {
    skipBlankP(P);
    const c = src[P.i];
    if (P.i >= src.length || c === ';' || c === '\n' || c === '&' || c === '|' || c === ')') return;
    const w = wordP(P, false);
    if (w.end === w.start) return;
    cmd.words.push(w);
  }
}

// case … esac is not analysed: its patterns look like unbalanced parentheses. Skipping it is a
// parse uncertainty, so a command containing one is never decided.
function caseP(P, cmd) {
  const m = /(?:^|[\s;&|()])esac(?=$|[\s;&|)])/.exec(P.src.slice(P.i));
  P.errors.push('case … esac is not analysed');
  P.i = m ? P.i + m.index + m[0].length : P.src.length;
  cmd.header = true;
}

function skipArith(P, j) {
  const { src } = P;
  let depth = 2;
  for (; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return j + 1; }
  }
  P.errors.push('unterminated (( ))');
  return src.length;
}

function nestedSeqP(P) {
  if (++P.nest > MAX_NEST) {
    P.errors.push('groups are nested too deeply to analyse');
    P.i = P.src.length;
    P.nest--;
    return { lists: [] };
  }
  const seq = seqP(P, ')');
  P.nest--;
  if (P.src[P.i] === ')') P.i++;
  else P.errors.push("missing ')'");
  return seq;
}

function wordP(P, test) {
  const { src } = P;
  const w = newWord(P.i);
  while (P.i < src.length) {
    const c = src[P.i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
    if (test) {
      // inside [[ … ]] the operators are words
      if (';&|<>()'.includes(c)) {
        if (!w.segs.length) {
          let j = P.i + 1;
          if ('&|<>'.includes(c) && src[j] === c) j++;
          addText(w, src.slice(P.i, j), false);
          P.i = j;
        }
        break;
      }
    } else {
      if (c === ';' || c === '&' || c === '|' || c === ')') break;
      if (c === '<' || c === '>') {
        if (src[P.i + 1] === '(') { procSubstP(P, w); continue; }
        break;
      }
      if (c === '(') {
        // NAME=( … ) array assignment
        if (w.segs.length && w.segs.every((s) => s.lit) && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(w.segs.map((s) => s.t).join(''))) { arrayAssignP(P, w); continue; }
        break;
      }
    }
    if (c === '\\') {
      const n = src[P.i + 1];
      if (n === '\n') { P.i += 2; continue; }
      if (n === undefined) { addText(w, '\\', true); P.i++; continue; }
      addText(w, n, false);
      w.quoted = true;
      P.i += 2;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", P.i + 1);
      w.quoted = true;
      if (close < 0) { P.errors.push('unterminated single quote'); addText(w, src.slice(P.i + 1), false); P.i = src.length; break; }
      addText(w, src.slice(P.i + 1, close), false);
      P.i = close + 1;
      continue;
    }
    if (c === '$' && src[P.i + 1] === "'") { ansiP(P, w); continue; }
    if (c === '"' || (c === '$' && src[P.i + 1] === '"')) { doubleP(P, w); continue; }
    if (c === '`') { backtickP(P, w); continue; }
    if (c === '$') { dollarP(P, w, false); continue; }
    addText(w, c, true);
    P.i++;
  }
  return endWord(P, w);
}

function procSubstP(P, w) {
  const start = P.i;
  P.i += 2;
  const seq = nestedSeqP(P);
  w.subs.push({ seq, kind: '<(' });
  addDyn(w, P.src.slice(start, P.i));
}

function arrayAssignP(P, w) {
  const { src } = P;
  const start = P.i;
  let depth = 0;
  for (; P.i < src.length; P.i++) {
    if (src[P.i] === '(') depth++;
    else if (src[P.i] === ')') { depth--; if (depth === 0) { P.i++; break; } }
  }
  addText(w, src.slice(start, P.i), false);
}

function dollarP(P, w, inDouble) {
  const { src } = P;
  const n = src[P.i + 1];
  if (n === '(' && src[P.i + 2] === '(') {
    const start = P.i;
    P.i = skipArith(P, P.i + 3);
    const text = src.slice(start, P.i);
    if (/\bgit\b/.test(text)) P.errors.push('$(( … )) that mentions git may be a command substitution');
    addDyn(w, text);
    return;
  }
  if (n === '(') {
    const start = P.i;
    P.i += 2;
    const seq = nestedSeqP(P);
    w.subs.push({ seq, kind: '$(' });
    addDyn(w, src.slice(start, P.i));
    return;
  }
  if (n === '{') {
    const start = P.i;
    let depth = 0;
    let j = P.i + 1;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    if (depth !== 0) P.errors.push('unterminated ${');
    const text = src.slice(start, j);
    if (/\$\(|`/.test(text.slice(2))) {
      w.opaque = true;
      if (/\bgit\b/.test(text)) P.errors.push('a command inside ${ … } is not analysed');
    }
    P.i = j;
    addDyn(w, text);
    return;
  }
  if (n !== undefined && /[A-Za-z_]/.test(n)) {
    let j = P.i + 1;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    addDyn(w, src.slice(P.i, j));
    P.i = j;
    return;
  }
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) { addDyn(w, src.slice(P.i, P.i + 2)); P.i += 2; return; }
  addText(w, '$', !inDouble);
  P.i++;
}

function doubleP(P, w) {
  const { src } = P;
  P.i += src[P.i] === '$' ? 2 : 1;
  w.quoted = true;
  while (P.i < src.length) {
    const c = src[P.i];
    if (c === '"') { P.i++; return; }
    if (c === '\\') {
      const n = src[P.i + 1];
      if (n === '\n') { P.i += 2; continue; }
      if (n !== undefined && '$`"\\'.includes(n)) { addText(w, n, false); P.i += 2; continue; }
      addText(w, '\\', false);
      P.i++;
      continue;
    }
    if (c === '`') { backtickP(P, w); continue; }
    if (c === '$') { dollarP(P, w, true); continue; }
    addText(w, c, false);
    P.i++;
  }
  P.errors.push('unterminated double quote');
}

function backtickP(P, w) {
  const { src } = P;
  const start = P.i;
  P.i++;
  let inner = '';
  while (P.i < src.length) {
    const c = src[P.i];
    if (c === '\\' && P.i + 1 < src.length && '$`\\'.includes(src[P.i + 1])) { inner += src[P.i + 1]; P.i += 2; continue; }
    if (c === '`') {
      P.i++;
      const sub = parsePosixSource(inner, P.depth + 1);
      for (const e of sub.errors) P.errors.push(e);
      w.subs.push({ seq: sub.seq, kind: '`' });
      addDyn(w, src.slice(start, P.i));
      return;
    }
    inner += c;
    P.i++;
  }
  P.errors.push('unterminated backtick');
  addDyn(w, src.slice(start));
}

const ANSI_ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, e: 27, E: 27, f: 12, v: 11 };
function ansiP(P, w) {
  const { src } = P;
  P.i += 2;
  w.quoted = true;
  let out = '';
  while (P.i < src.length) {
    const c = src[P.i];
    if (c === "'") { P.i++; addText(w, out, false); return; }
    if (c === '\\' && P.i + 1 < src.length) {
      const n = src[P.i + 1];
      if (n in ANSI_ESCAPES) { out += String.fromCharCode(ANSI_ESCAPES[n]); P.i += 2; continue; }
      const hex = n === 'x' ? /^[0-9a-fA-F]{1,2}/ : n === 'u' ? /^[0-9a-fA-F]{1,4}/ : n === 'U' ? /^[0-9a-fA-F]{1,8}/ : null;
      if (hex) {
        const m = hex.exec(src.slice(P.i + 2));
        if (m) {
          const code = parseInt(m[0], 16);
          out += code <= 0x10ffff ? String.fromCodePoint(code) : '?';
          P.i += 2 + m[0].length;
          continue;
        }
      }
      if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(src.slice(P.i + 1)); out += String.fromCharCode(parseInt(m[0], 8)); P.i += 1 + m[0].length; continue; }
      if (n === 'c' && P.i + 2 < src.length) { out += String.fromCharCode(src.charCodeAt(P.i + 2) & 31); P.i += 3; continue; }
      out += n === '\\' || n === "'" || n === '"' || n === '?' ? n : `\\${n}`;
      P.i += 2;
      continue;
    }
    out += c;
    P.i++;
  }
  P.errors.push("unterminated $'");
  addText(w, out, false);
}

const REDIR_RE = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)|^&>>?/;
function redirP(P, list) {
  const { src } = P;
  const m = REDIR_RE.exec(src.slice(P.i, P.i + 48));
  if (!m) return false;
  const op = m[0].replace(/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})/, '');
  if ((op === '<' || op === '>') && src[P.i + m[0].length] === '(') return false; // process substitution
  P.i += m[0].length;
  skipBlankP(P);
  const target = wordP(P, false);
  if (target.end === target.start) P.errors.push(`redirection '${op}' without a target`);
  const r = { op, target };
  if (op === '<<' || op === '<<-') P.pending.push({ redir: r, delim: target.value, strip: op === '<<-', quoted: target.quoted });
  list.push(r);
  return true;
}

// Here-doc bodies are data. Only an UNQUOTED delimiter lets the shell expand $( … ) and backticks
// inside the body, and those run; the body text itself never does.
function readHeredocs(P) {
  const { src } = P;
  while (P.pending.length) {
    const h = P.pending.shift();
    let body = '';
    let done = false;
    while (P.i < src.length) {
      const nl = src.indexOf('\n', P.i);
      const end = nl < 0 ? src.length : nl;
      const line = src.slice(P.i, end);
      P.i = nl < 0 ? src.length : nl + 1;
      const cmp = (h.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
      if (cmp === h.delim) { done = true; break; }
      body += `${line}\n`;
    }
    h.redir.heredoc = { body, quoted: h.quoted, done, subs: [] };
    if (!h.quoted && /[$`]/.test(body)) {
      const scan = expandLikeDouble(body, P.depth + 1);
      for (const e of scan.errors) P.errors.push(e);
      h.redir.heredoc.subs = scan.subs;
    }
  }
}
function expandLikeDouble(text, depth) {
  const P = newParser(text, depth);
  const w = newWord(0);
  while (P.i < text.length) {
    const c = text[P.i];
    if (c === '\\') { P.i += 2; continue; }
    if (c === '`') { backtickP(P, w); continue; }
    if (c === '$') { dollarP(P, w, true); continue; }
    P.i++;
  }
  return { subs: w.subs, errors: P.errors };
}

// ───────────────────────────── PowerShell ─────────────────────────────
// Typographic quotes are string delimiters in PowerShell too.
const PS_SQ = new Set(["'", String.fromCharCode(0x2018), String.fromCharCode(0x2019), String.fromCharCode(0x201a), String.fromCharCode(0x201b)]);
const PS_DQ = new Set(['"', String.fromCharCode(0x201c), String.fromCharCode(0x201d), String.fromCharCode(0x201e)]);
const PS_BLANK = new Set([' ', '\t', '\r', String.fromCharCode(0xa0), String.fromCharCode(0xfeff)]);
const PS_KEYWORDS = new Set(['if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'try', 'catch', 'finally', 'trap', 'function', 'filter', 'workflow', 'param', 'begin', 'process', 'end', 'return', 'throw', 'exit', 'break', 'continue', 'data', 'dynamicparam', 'class', 'enum', 'using', 'configuration']);
const PS_ESCAPES = { 0: 0, a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11 };
const psEscape = (n) => (n in PS_ESCAPES ? String.fromCharCode(PS_ESCAPES[n]) : n);

function parsePsSource(src, depth) {
  const P = newParser(src, depth);
  if (depth > MAX_DEPTH) { P.errors.push('commands are nested too deeply to analyse'); return { seq: { lists: [] }, errors: P.errors }; }
  const seq = seqPS(P, null);
  return { seq, errors: P.errors };
}

function skipBlankPS(P) {
  const { src } = P;
  for (;;) {
    const c = src[P.i];
    if (PS_BLANK.has(c)) { P.i++; continue; }
    if (c === '`' && (src[P.i + 1] === '\n' || (src[P.i + 1] === '\r' && src[P.i + 2] === '\n'))) { P.i += src[P.i + 1] === '\r' ? 3 : 2; continue; }
    if (c === '<' && src[P.i + 1] === '#') {
      const e = src.indexOf('#>', P.i + 2);
      if (e < 0) P.errors.push('unterminated <# comment');
      P.i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '#') { const nl = src.indexOf('\n', P.i); P.i = nl < 0 ? src.length : nl; continue; }
    return;
  }
}
function skipBlankNLPS(P) {
  for (;;) {
    skipBlankPS(P);
    if (P.src[P.i] !== '\n') return;
    P.i++;
  }
}

function seqPS(P, closer) {
  const { src } = P;
  const lists = [];
  while (P.i < src.length) {
    skipBlankPS(P);
    if (P.i >= src.length) break;
    const c = src[P.i];
    if (closer && c === closer) break;
    if (c === '\n' || c === ';') { P.i++; continue; }
    if (c === ')' || c === '}') { P.errors.push(`unbalanced '${c}'`); P.i++; continue; }
    if (c === '|' || (c === '&' && src[P.i + 1] === '&')) { P.errors.push(`'${c}' with no command before it`); P.i++; continue; }
    const before = P.i;
    lists.push(andOrPS(P, closer));
    if (P.i === before) { P.errors.push(`unexpected '${c}'`); P.i++; }
  }
  return { lists };
}

// `&&` and `||` exist in pwsh 7 only; Windows PowerShell 5.1 refuses the whole line. Reading them as
// pwsh 7 does is the cautious choice: it finds every command that could run.
function andOrPS(P, closer) {
  const items = [];
  const ops = [];
  for (;;) {
    items.push(pipelinePS(P, closer));
    skipBlankPS(P);
    const two = P.src.slice(P.i, P.i + 2);
    if (two === '&&' || two === '||') { ops.push(two); P.i += 2; skipBlankNLPS(P); continue; }
    break;
  }
  let term = '';
  const c = P.src[P.i];
  if (c === ';' || c === '\n') { term = c; P.i++; }
  else if (c === '&') { term = '&'; P.i++; }
  return { items, ops, bg: term === '&', term };
}

function pipelinePS(P, closer) {
  const cmds = [];
  for (;;) {
    cmds.push(commandPS(P, closer));
    skipBlankPS(P);
    if (P.src[P.i] === '|' && P.src[P.i + 1] !== '|') { P.i++; skipBlankNLPS(P); continue; }
    return { cmds };
  }
}

const PS_ASSIGN_RE = /^\$(?:\{([^}]*)\}|((?:[A-Za-z_]\w*:)?\w+))(?:\[[^\]\n]*\])?\s*(?:[-+*/%]|\?\?)?=(?!=)/;
function commandPS(P, closer) {
  const { src } = P;
  skipBlankPS(P);
  const cmd = { kind: 'simple', words: [], assigns: [], redirs: [], start: P.i, end: P.i, src, callOp: null };
  const am = PS_ASSIGN_RE.exec(src.slice(P.i, P.i + 256));
  if (am) { cmd.assigns.push({ name: am[1] ?? am[2] ?? '', raw: am[0] }); P.i += am[0].length; }
  for (;;) {
    skipBlankPS(P);
    if (P.i >= src.length) break;
    const c = src[P.i];
    if (c === '\n' || c === ';' || c === '|') break;
    if ((closer && c === closer) || c === ')' || c === '}') break;
    if (c === '&') {
      if (src[P.i + 1] === '&') break;
      if (!cmd.words.length && !cmd.callOp) { cmd.callOp = '&'; P.i++; continue; }
      break; // pwsh 7 background operator
    }
    if (c === '.' && !cmd.words.length && !cmd.callOp && PS_BLANK.has(src[P.i + 1])) { cmd.callOp = '.'; P.i++; continue; }
    if (c === ',') { P.i++; continue; }
    if (src.startsWith('--%', P.i) && (P.i + 3 >= src.length || PS_BLANK.has(src[P.i + 3]) || src[P.i + 3] === '\n')) { stopParsingPS(P, cmd); break; }
    if (redirPS(P, cmd)) continue;
    const before = P.i;
    const w = tokenPS(P);
    if (P.i === before) { P.errors.push(`unexpected '${c}'`); P.i++; continue; }
    cmd.words.push(w);
  }
  cmd.end = P.i;
  return cmd;
}

// One argument-mode token: barewords, quoted parts and expansions glued together (`a"b c"d` is one
// argument), commas followed by a blank separate arguments, a comma inside a word stays literal.
function tokenPS(P) {
  const { src } = P;
  const w = newWord(P.i);
  while (P.i < src.length) {
    const c = src[P.i];
    if (PS_BLANK.has(c) || c === '\n' || c === ';' || c === '|' || c === '&' || c === ')' || c === '}') break;
    if (c === ',') {
      const n = src[P.i + 1];
      if (n === undefined || PS_BLANK.has(n) || n === '\n') break;
      addText(w, ',', true);
      P.i++;
      continue;
    }
    if (c === '>' || (c === '<' && src[P.i + 1] !== '#')) break;
    if (c === '#' && !w.segs.length) break;
    if (c === '`') {
      const n = src[P.i + 1];
      if (n === undefined) { P.i++; continue; }
      if (n === '\n') { P.i += 2; break; }
      if (n === '\r' && src[P.i + 2] === '\n') { P.i += 3; break; }
      addText(w, psEscape(n), false);
      w.quoted = true;
      P.i += 2;
      continue;
    }
    if (c === '@' && (PS_SQ.has(src[P.i + 1]) || PS_DQ.has(src[P.i + 1])) && /^@.[ \t]*\r?\n/.test(src.slice(P.i, P.i + 80))) { hereStringPS(P, w); continue; }
    if (PS_SQ.has(c)) { singlePS(P, w); continue; }
    if (PS_DQ.has(c)) { doublePS(P, w); continue; }
    if (c === '@' && src[P.i + 1] === '(') { groupPS(P, w, 2, ')', '@('); continue; }
    if (c === '@' && src[P.i + 1] === '{') { groupPS(P, w, 2, '}', '@{'); continue; }
    if (c === '@' && !w.segs.length && /[A-Za-z_?]/.test(src[P.i + 1] || '')) {
      const m = /^@[\w?]+/.exec(src.slice(P.i));
      addDyn(w, m[0]);
      w.splat = true;
      P.i += m[0].length;
      continue;
    }
    if (c === '$') { if (psDollar(P, w)) continue; addText(w, '$', true); P.i++; continue; }
    if (c === '(' || c === '{') {
      // `if(…)`, `foreach(…)`, `else{` — a keyword ends where its group starts
      if (w.segs.length && w.segs.every((s) => s.lit) && PS_KEYWORDS.has(w.segs.map((s) => s.t).join('').toLowerCase())) break;
      if (c === '(') groupPS(P, w, 1, ')', '(');
      else groupPS(P, w, 1, '}', '{');
      continue;
    }
    addText(w, c, true);
    P.i++;
  }
  return endWord(P, w);
}

function psDollar(P, w) {
  const { src } = P;
  const n = src[P.i + 1];
  if (n === '(') { groupPS(P, w, 2, ')', '$('); return true; }
  if (n === '{') {
    const close = src.indexOf('}', P.i + 2);
    const end = close < 0 ? src.length : close + 1;
    if (close < 0) P.errors.push('unterminated ${');
    addDyn(w, src.slice(P.i, end));
    P.i = end;
    return true;
  }
  const m = /^\$(?:[A-Za-z_]\w*:)?\w+|^\$[?^$]/.exec(src.slice(P.i, P.i + 160));
  if (m) { addDyn(w, m[0]); P.i += m[0].length; return true; }
  return false;
}

function groupPS(P, w, openLen, close, kind) {
  const start = P.i;
  P.i += openLen;
  if (++P.nest > MAX_NEST) {
    P.errors.push('groups are nested too deeply to analyse');
    P.i = P.src.length;
    P.nest--;
    addDyn(w, P.src.slice(start));
    return;
  }
  const seq = seqPS(P, close);
  P.nest--;
  if (P.src[P.i] === close) P.i++;
  else P.errors.push(`missing '${close}'`);
  w.subs.push({ seq, kind });
  addDyn(w, P.src.slice(start, P.i));
}

function singlePS(P, w) {
  const { src } = P;
  P.i++;
  w.quoted = true;
  let out = '';
  while (P.i < src.length) {
    const c = src[P.i];
    if (PS_SQ.has(c)) {
      if (PS_SQ.has(src[P.i + 1])) { out += c; P.i += 2; continue; }
      P.i++;
      addText(w, out, false);
      return;
    }
    out += c;
    P.i++;
  }
  P.errors.push('unterminated single quote');
  addText(w, out, false);
}

function doublePS(P, w) {
  const { src } = P;
  P.i++;
  w.quoted = true;
  let buf = '';
  const flush = () => { addText(w, buf, false); buf = ''; };
  while (P.i < src.length) {
    const c = src[P.i];
    if (PS_DQ.has(c)) {
      if (PS_DQ.has(src[P.i + 1])) { buf += c; P.i += 2; continue; }
      P.i++;
      flush();
      return;
    }
    if (c === '`') {
      const n = src[P.i + 1];
      if (n === undefined) { P.i++; continue; }
      buf += psEscape(n);
      P.i += 2;
      continue;
    }
    if (c === '$') {
      flush();
      if (psDollar(P, w)) continue;
      buf += '$';
      P.i++;
      continue;
    }
    buf += c;
    P.i++;
  }
  P.errors.push('unterminated double quote');
  flush();
}

// @'…'@ is literal; @"…"@ expands $( … ), which runs. The closing quote must start a line.
function hereStringPS(P, w) {
  const { src } = P;
  const expandable = PS_DQ.has(src[P.i + 1]);
  const open = /^@.[ \t]*\r?\n/.exec(src.slice(P.i, P.i + 80));
  const bodyStart = P.i + open[0].length;
  let end = -1;
  let after = src.length;
  for (let k = bodyStart; k <= src.length;) {
    if ((expandable ? PS_DQ.has(src[k]) : PS_SQ.has(src[k])) && src[k + 1] === '@') { end = k; after = k + 2; break; }
    const nl = src.indexOf('\n', k);
    if (nl < 0) break;
    k = nl + 1;
  }
  w.quoted = true;
  if (end < 0) { P.errors.push('unterminated here-string'); end = src.length; }
  const body = src.slice(bodyStart, end).replace(/\r?\n$/, '');
  P.i = after;
  if (expandable && body.includes('$')) {
    const scan = expandLikeDoublePS(body, P.depth + 1);
    for (const e of scan.errors) P.errors.push(e);
    for (const s of scan.subs) w.subs.push(s);
    if (scan.dyn) w.dyn = true;
  }
  addText(w, body, false);
}
function expandLikeDoublePS(text, depth) {
  const P = newParser(text, depth);
  const w = newWord(0);
  while (P.i < text.length) {
    const c = text[P.i];
    if (c === '`') { P.i += 2; continue; }
    if (c === '$' && psDollar(P, w)) continue;
    P.i++;
  }
  return { subs: w.subs, dyn: w.dyn, errors: P.errors };
}

// --% passes the rest of the line to the native program verbatim (a `;` stays literal; a pipe ends it).
function stopParsingPS(P, cmd) {
  const { src } = P;
  P.i += 3;
  let end = P.i;
  while (end < src.length && src[end] !== '\n' && src[end] !== '|') end++;
  for (const a of splitCommandLine(src.slice(P.i, end))) cmd.words.push(a);
  P.i = end;
}

const PS_REDIR_RE = /^(?:[1-6*])?>>?(?:&[1-6])?/;
function redirPS(P, cmd) {
  const { src } = P;
  const m = PS_REDIR_RE.exec(src.slice(P.i, P.i + 8));
  if (!m) return false;
  P.i += m[0].length;
  if (/&[1-6]$/.test(m[0])) { cmd.redirs.push({ op: m[0] }); return true; }
  skipBlankPS(P);
  const target = tokenPS(P);
  cmd.redirs.push({ op: m[0], target });
  return true;
}

// ───────────────────────────── cmd.exe (cmd /c "…") ─────────────────────────────

function parseCmdSource(src, depth) {
  const errors = [];
  if (depth > MAX_DEPTH) return { seq: { lists: [] }, errors: ['commands are nested too deeply to analyse'] };
  const lists = [];
  let items = [];
  let ops = [];
  let cmds = [];
  let words = [];
  let w = null;
  let quote = false;
  let cmdStart = 0;
  const endWordAt = (i) => {
    if (!w) return;
    const value = w.text;
    words.push({ value, raw: src.slice(w.start, i), start: w.start, end: i, dyn: /%[^%\s]+%|![^!\s]+!/.test(value), opaque: false, quoted: w.quoted, glob: false, segs: [{ t: value, lit: !w.quoted, dyn: false }], subs: [] });
    w = null;
  };
  const endCmdAt = (i) => {
    endWordAt(i);
    if (words.length) {
      if (/^(?:if|for)$/i.test(words[0].value)) errors.push(`cmd ${words[0].value.toLowerCase()} is not analysed`);
      cmds.push({ kind: 'simple', words, assigns: [], redirs: [], start: cmdStart, end: i, src });
    }
    words = [];
  };
  const endPipe = () => { if (cmds.length) items.push({ cmds }); cmds = []; };
  const endList = (term) => {
    endPipe();
    if (items.length) lists.push({ items, ops: ops.slice(0, items.length - 1), bg: false, term });
    items = [];
    ops = [];
  };
  const startWord = (i) => { if (!w) w = { text: '', start: i, quoted: false }; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '"') quote = false;
      else w.text += c;
      i++;
      continue;
    }
    if (c === '"') { startWord(i); w.quoted = true; quote = true; i++; continue; }
    if (c === '^') {
      startWord(i);
      if (i + 1 < src.length) { w.text += src[i + 1]; w.quoted = true; }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWordAt(i); i++; continue; }
    if (c === '\n' || c === '(' || c === ')') { endCmdAt(i); endList(';'); i++; cmdStart = i; continue; }
    if (c === '&') {
      endCmdAt(i);
      if (src[i + 1] === '&') { endPipe(); ops.push('&&'); i += 2; } else { endList(';'); i++; }
      cmdStart = i;
      continue;
    }
    if (c === '|') {
      endCmdAt(i);
      if (src[i + 1] === '|') { endPipe(); ops.push('||'); i += 2; } else i++;
      cmdStart = i;
      continue;
    }
    if (c === '<' || c === '>') {
      if (w && /^\d$/.test(w.text) && !w.quoted) w = null;
      else endWordAt(i);
      let j = i + 1;
      if (src[j] === '>') j++;
      if (src[j] === '&' && /\d/.test(src[j + 1] || '')) { i = j + 2; continue; }
      while (src[j] === ' ' || src[j] === '\t') j++;
      let q = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '"') { q = !q; j++; continue; }
        if (!q && (d === ' ' || d === '\t' || d === '&' || d === '|' || d === '\n' || d === '(' || d === ')')) break;
        j++;
      }
      i = j;
      continue;
    }
    startWord(i);
    w.text += c;
    i++;
  }
  if (quote) errors.push('unterminated double quote');
  endCmdAt(src.length);
  endList('');
  return { seq: { lists }, errors };
}

// A native command line split the way MSVCRT programs (git.exe) split it: blanks separate, double
// quotes group. Used for --%, Start-Process -ArgumentList and env -S.
function splitCommandLine(text) {
  const out = [];
  let cur = null;
  let q = false;
  for (const c of String(text)) {
    if (q) { if (c === '"') q = false; else cur.value += c; continue; }
    if (c === '"') { if (!cur) cur = { value: '', quoted: true }; cur.quoted = true; q = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur) cur = { value: '', quoted: false };
    cur.value += c;
  }
  if (cur) out.push(cur);
  return out.map((p) => ({ value: p.value, raw: p.value, dyn: /%[^%\s]+%/.test(p.value), opaque: false, quoted: p.quoted, glob: false, segs: [{ t: p.value, lit: !p.quoted, dyn: false }], subs: [] }));
}

// git's split_cmdline for alias values: single and double quotes, backslash escapes.
function splitAlias(text) {
  const out = [];
  let cur = null;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < text.length) { cur += text[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { if (cur === null) cur = ''; q = c; continue; }
    if (c === '\\' && i + 1 < text.length) { if (cur === null) cur = ''; cur += text[++i]; continue; }
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (cur === null) cur = '';
    cur += c;
  }
  if (cur !== null) out.push(cur);
  return out.map(literalArg);
}

function decodeEncodedCommand(b64) {
  const s = String(b64 ?? '').trim();
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1 || typeof Buffer === 'undefined') return null;
  try {
    const buf = Buffer.from(s, 'base64');
    if (!buf.length || buf.length % 2) return null;
    return buf.toString('utf16le');
  } catch {
    return null;
  }
}

function parseSource(text, dialect, depth) {
  if (dialect === 'powershell') return parsePsSource(text, depth);
  if (dialect === 'cmd') return parseCmdSource(text, depth);
  return parsePosixSource(text, depth);
}

// ───────────────────────────── walking the parsed command ─────────────────────────────
// The walk follows execution order and the shell's directory rules: POSIX subshells, pipelines and
// background jobs never change the directory of what follows; PowerShell keeps one location for the
// whole runspace; a `cd` that may not have run (inside an if body, after `||`, behind an earlier
// command that can fail) leaves the directory uncertain for the git commands after it.

function newCtx(dialect, platform) {
  return { dialect, platform, depth: 0, cwd: null, cwdUnc: null, localUnc: null, oldpwd: undefined, stack: [], env: {}, cdDepth: null };
}
const forkCtx = (ctx) => ({ ...ctx, stack: ctx.stack.slice(), env: { ...ctx.env } });

function walkSeq(seq, ctx, R) {
  for (const list of seq.lists) walkList(list, ctx, R);
}

function walkList(list, ctx, R) {
  const c = list.bg ? forkCtx(ctx) : ctx;
  const outer = c.localUnc;
  let cdAt = -1;
  for (let k = 0; k < list.items.length; k++) {
    const orSinceCd = cdAt >= 0 && list.ops.slice(cdAt, k).includes('||');
    c.localUnc = outer || (orSinceCd ? 'the directory depends on whether an earlier cd in this chain succeeded' : null);
    if (walkPipeline(list.items[k], c, R)) cdAt = k;
  }
  c.localUnc = outer;
  if (cdAt > 0) c.cwdUnc = c.cwdUnc || 'a cd that runs only if an earlier command succeeds decides the directory';
  else if (cdAt === 0 && list.ops[0] === '||' && !isExitLike(list.items[1])) c.cwdUnc = c.cwdUnc || 'after `cd … || …` the next command runs in either directory';
}

function isExitLike(pipe) {
  const cmd = pipe && pipe.cmds.length === 1 ? pipe.cmds[0] : null;
  const w = cmd && cmd.kind === 'simple' && cmd.words[0];
  return !!w && !w.quoted && /^(?:exit|return|throw)$/i.test(w.value);
}

function walkPipeline(pipe, ctx, R) {
  const fork = pipe.cmds.length > 1 && ctx.dialect !== 'powershell';
  let moved = false;
  pipe.cmds.forEach((cmd, index) => {
    const c = fork ? forkCtx(ctx) : ctx;
    if (walkCommand(cmd, c, R, { piped: index > 0 }) && !fork) moved = true;
  });
  return moved;
}

function walkCommand(cmd, ctx, R, where) {
  if (R.steps.length >= MAX_STEPS) { if (!R.errors.includes(TOO_MANY_STEPS)) R.errors.push(TOO_MANY_STEPS); return false; }
  if (cmd.kind === 'subshell') {
    walkSeq(cmd.seq, forkCtx(ctx), R);
    walkRedirs(cmd.redirs, ctx, R);
    return false;
  }
  if (ctx.dialect === 'posix' && ctx.cdDepth !== null && typeof cmd.depth === 'number' && cmd.depth < ctx.cdDepth) {
    ctx.cwdUnc = ctx.cwdUnc || 'a cd inside an if/while body decides the directory';
    ctx.cdDepth = null;
  }
  if (ctx.dialect === 'powershell') {
    const kw = psKeyword(cmd);
    if (kw) return walkPsKeyword(cmd, kw, ctx, R, where);
    // `& { … }` and `. { … }` run the block now, in this runspace
    const first = cmd.words[0];
    if (cmd.callOp && first && first.subs.length === 1 && first.subs[0].kind === '{' && first.segs.length === 1) {
      const before = ctx.cwd;
      pushStep(R, ctx, { raw: rawOf(cmd) });
      walkSeq(first.subs[0].seq, ctx, R);
      for (const w of cmd.words.slice(1)) walkWordSubs(w, ctx, R);
      return ctx.cwd !== before;
    }
  }
  for (const w of cmd.words) walkWordSubs(w, ctx, R);
  for (const a of cmd.assigns) walkWordSubs(a, ctx, R);
  walkRedirs(cmd.redirs, ctx, R);
  if (cmd.header) return false;
  return classifySimple(cmd, ctx, R, where);
}

function walkWordSubs(w, ctx, R) {
  for (const s of (w && w.subs) || []) {
    if (ctx.dialect === 'powershell') {
      if (s.kind === '{') walkMerged(s.seq, ctx, R, 'Set-Location inside a script block decides the directory');
      else walkSeq(s.seq, ctx, R);
    } else walkSeq(s.seq, forkCtx(ctx), R);
  }
}

// A block that may or may not run (a script block, an if/loop body): walk it, and when it moved the
// location the directory after it is uncertain.
function walkMerged(seq, ctx, R, why) {
  const c = forkCtx(ctx);
  walkSeq(seq, c, R);
  if (c.cwd !== ctx.cwd || c.cwdUnc !== ctx.cwdUnc) {
    ctx.cwd = c.cwd;
    ctx.cwdUnc = ctx.cwdUnc || c.cwdUnc || why;
  }
  for (const [k, v] of Object.entries(c.env)) ctx.env[k] = v;
}

function walkRedirs(redirs, ctx, R) {
  for (const r of redirs || []) {
    if (r.target) walkWordSubs(r.target, ctx, R);
    if (r.heredoc) for (const s of r.heredoc.subs) walkSeq(s.seq, forkCtx(ctx), R);
  }
}

function psKeyword(cmd) {
  if (cmd.callOp || cmd.assigns.length || !cmd.words.length) return null;
  const w = cmd.words[0];
  if (w.quoted || w.dyn) return null;
  const k = w.value.toLowerCase();
  return PS_KEYWORDS.has(k) ? k : null;
}

function walkPsKeyword(cmd, kw, ctx, R, where) {
  if ((kw === 'return' || kw === 'throw') && cmd.words.length > 1) {
    // `return git status` runs the pipeline after the keyword
    const rest = { ...cmd, words: cmd.words.slice(1) };
    for (const w of rest.words) walkWordSubs(w, ctx, R);
    return classifySimple(rest, ctx, R, where);
  }
  for (const w of cmd.words) for (const s of w.subs) walkMerged(s.seq, ctx, R, `Set-Location inside a ${kw} block decides the directory`);
  return false;
}

const rawOf = (cmd) => cmd.src.slice(cmd.start, cmd.end).trim();

function walkSource(text, dialect, ctx, R, same) {
  if (ctx.depth + 1 > MAX_DEPTH) { R.errors.push('commands are nested too deeply to analyse'); return; }
  const parsed = parseSource(text, dialect, ctx.depth + 1);
  for (const e of parsed.errors) R.errors.push(e);
  const c = same ? ctx : forkCtx(ctx);
  const saved = { dialect: c.dialect, depth: c.depth, cdDepth: c.cdDepth };
  c.dialect = dialect;
  c.depth = ctx.depth + 1;
  c.cdDepth = null;
  walkSeq(parsed.seq, c, R);
  Object.assign(c, saved);
}

// ───────────────────────────── one simple command ─────────────────────────────

const WATCHED_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']);
const TARGET_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const BYPASS_NOTE = (name) => `${name} is ignored: it does not switch the check off`;

function recordEnv(name, value, env, notes) {
  if (/^KLYPIX_WHOSE/i.test(name)) { notes.push(BYPASS_NOTE(name)); return; }
  if (WATCHED_ENV.has(name)) env[name] = value;
}

function classifySimple(cmd, ctx, R, where) {
  const raw = rawOf(cmd);
  const notes = [];
  const env = {};
  if (ctx.dialect === 'powershell') {
    for (const a of cmd.assigns) {
      const m = /^env:(.+)$/i.exec(a.name);
      if (m) recordEnv(m[1].toUpperCase(), cmd.words[0] ? cmd.words[0].value : '', ctx.env, notes);
    }
  } else {
    for (const a of cmd.assigns) {
      const eq = a.value.indexOf('=');
      recordEnv(a.value.slice(0, eq).replace(/\+$/, ''), a.value.slice(eq + 1), env, notes);
    }
  }
  if (!cmd.words.length) {
    // `GIT_DIR=x` alone sets a shell variable that later commands may see
    if (ctx.dialect !== 'powershell') Object.assign(ctx.env, env);
    if (cmd.assigns.length || notes.length) pushStep(R, ctx, { raw, notes });
    return false;
  }
  if (ctx.dialect === 'powershell' && !cmd.callOp && psExpressionStart(cmd.words[0])) {
    pushStep(R, ctx, { raw, notes });
    return false;
  }
  const argv = [];
  for (const w of cmd.words) for (const a of wordToArgs(w, ctx.dialect)) argv.push(a);
  return classifyArgv(argv, ctx, R, { raw, env, notes, cmd, piped: !!(where && where.piped) });
}

// In PowerShell a statement that starts with a value (a string, a variable, a number, a group) is an
// expression, not a command: `'git' add -A` is a parse error and `$x` runs nothing.
function psExpressionStart(w) {
  if (w.segs.length && !w.segs[0].lit && !w.segs[0].dyn) return true;
  return /^[$(@[{0-9]/.test(w.raw);
}

function progName(arg) {
  if (!arg || arg.dyn) return null;
  const base = arg.value.replace(/\\/g, '/').split('/').pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}
const GIT_PROG_RE = /^git(?:\.exe|\.cmd)?$/i;
const isGitName = (name) => !!name && GIT_PROG_RE.test(name);
const RISKY_VERB_RE = /^(?:add|stage|commit|reset|checkout|switch|restore|stash|clean|rm|worktree|rebase|merge|pull|cherry-pick|revert|am)$/;

function literalTail(arg) {
  const tail = arg.value.replace(/\\/g, '/').split('/').pop() || '';
  return /[$`(]/.test(tail) ? null : tail;
}

function uncertainAt(R, step, why) {
  step.ok = false;
  R.uncertain.push(`step ${step.index} \`${clip(step.raw)}\`: could not verify — ${why}`);
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);
const CD_NAMES = {
  posix: new Set(['cd', 'pushd', 'popd', 'chdir']),
  powershell: new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location', 'popd', 'pop-location']),
  cmd: new Set(['cd', 'chdir', 'pushd', 'popd']),
};

function classifyArgv(argv, ctx, R, base) {
  const ps = ctx.dialect === 'powershell';
  const u = unwrap(argv, ctx);
  const notes = [...(base.notes || []), ...u.notes];
  const env = { ...(base.env || {}), ...u.env };
  const a0 = u.argv[0];
  if (!a0 || u.lookup) { pushStep(R, ctx, { raw: base.raw, notes }); return false; }
  if (a0.dyn) {
    const tail = literalTail(a0);
    if (tail && GIT_PROG_RE.test(tail)) return gitStep(u.argv.slice(1), ctx, R, { ...base, env, notes, u });
    const step = pushStep(R, ctx, { raw: base.raw, notes });
    const nextWord = u.argv[1] && !u.argv[1].dyn ? u.argv[1].value : '';
    if (/git/i.test(a0.raw) || RISKY_VERB_RE.test(nextWord)) uncertainAt(R, step, `the program ${clip(a0.raw, 40)} is only known when the shell runs`);
    return false;
  }
  const name = progName(a0);
  if (isGitName(name)) return gitStep(u.argv.slice(1), ctx, R, { ...base, env, notes, u });
  const rest = u.argv.slice(1);
  if (CD_NAMES[ctx.dialect] && CD_NAMES[ctx.dialect].has(name)) {
    pushStep(R, ctx, { raw: base.raw, notes });
    const before = [ctx.cwd, ctx.cwdUnc];
    applyCd(name, rest, ctx, base.cmd);
    return ctx.cwd !== before[0] || ctx.cwdUnc !== before[1];
  }
  if (POSIX_SHELLS.has(name)) return runPosixShell(u.argv, ctx, R, base, notes, name);
  if (name === 'powershell' || name === 'pwsh') return runPowerShell(u.argv, ctx, R, base, notes, name);
  if (name === 'cmd') return runCmd(u.argv, ctx, R, base, notes);
  if (!ps && name === 'eval') {
    const step = pushStep(R, ctx, { raw: base.raw, notes });
    if (rest.some((p) => p.dyn)) { uncertainAt(R, step, 'eval runs a string that is only known when the shell runs'); return false; }
    const before = ctx.cwd;
    walkSource(rest.map((p) => p.value).join(' '), 'posix', ctx, R, true);
    return ctx.cwd !== before;
  }
  if (ps && (name === 'iex' || name === 'invoke-expression')) {
    const step = pushStep(R, ctx, { raw: base.raw, notes });
    const parts = rest.filter((p) => !(p.segs.length && p.segs[0].lit && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(p.value)));
    if (!parts.length) { if (base.piped) uncertainAt(R, step, 'Invoke-Expression runs text piped into it'); return false; }
    if (parts.some((p) => p.dyn)) { uncertainAt(R, step, 'Invoke-Expression runs a string that is only known when the shell runs'); return false; }
    const before = ctx.cwd;
    walkSource(parts.map((p) => p.value).join(' '), 'powershell', ctx, R, true);
    return ctx.cwd !== before;
  }
  if (ps && (name === 'start-process' || name === 'saps' || name === 'start')) return runStartProcess(rest, ctx, R, base, notes, env);
  if (name === 'gh') return ghStep(rest, ctx, R, base, notes);
  if (name === 'find') {
    pushStep(R, ctx, { raw: base.raw, notes });
    for (let j = 0; j < rest.length; j++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(rest[j].value)) continue;
      let k = j + 1;
      const inner = [];
      while (k < rest.length && rest[k].value !== ';' && rest[k].value !== '+') inner.push(rest[k++]);
      if (inner.length) classifyArgv(inner.map((a) => (a.value === '{}' ? { ...a, dyn: true } : a)), ctx, R, { ...base, notes: [], extraUnc: 'find runs it once per file it finds' });
      j = k;
    }
    return false;
  }
  if (!ps && (name === 'export' || name === 'declare' || name === 'typeset')) {
    pushStep(R, ctx, { raw: base.raw, notes });
    const exporting = name === 'export' || rest.some((a) => /^-\w*x/.test(a.value));
    if (exporting) {
      for (const a of rest) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(a.value);
        if (m) recordEnv(m[1], m[2] ?? '', ctx.env, notes);
      }
    }
    return false;
  }
  if (!ps && name === 'unset') {
    pushStep(R, ctx, { raw: base.raw, notes });
    for (const a of rest) delete ctx.env[a.value];
    return false;
  }
  pushStep(R, ctx, { raw: base.raw, notes });
  return false;
}

// Strip the programs that only run the next one: env, command, exec, nohup, time, nice, timeout,
// stdbuf, sudo, doas, xargs, wsl, winpty. Their options are skipped by arity.
function unwrap(argv, ctx) {
  const out = { argv, env: {}, cwd: null, unc: [], notes: [], xargs: null, lookup: false };
  const ps = ctx.dialect === 'powershell';
  const setCwd = (d) => {
    if (!d) return;
    if (d.dyn) out.unc.push(`the directory ${clip(d.raw, 40)} is only known when the shell runs`);
    out.cwd = joinDir(out.cwd, hostPath(d.value, ctx));
  };
  for (let guard = 0; guard < 16 && out.argv.length; guard++) {
    const a0 = out.argv[0];
    if (a0.dyn) break;
    const name = progName(a0);
    const rest = out.argv.slice(1);
    let j = 0;
    const isOpt = (k) => rest[k] && !rest[k].dyn && rest[k].value.startsWith('-') && rest[k].value !== '--';
    if (!ps && name === 'env') {
      let split = null;
      for (; j < rest.length; j++) {
        const v = rest[j].value;
        if (rest[j].dyn) break;
        if (v === '--') { j++; break; }
        if (/^(?:-i|-|--ignore-environment|-0|--null|-v|--debug)$/.test(v) || /^--(?:block|default|ignore)-signal(?:=|$)/.test(v)) continue;
        if (v === '-u' || v === '--unset') { j++; continue; }
        if (/^-u.|^--unset=/.test(v)) continue;
        if (v === '-C' || v === '--chdir') { setCwd(rest[++j]); continue; }
        if (/^-C./.test(v)) { setCwd({ ...rest[j], value: v.slice(2) }); continue; }
        if (v.startsWith('--chdir=')) { setCwd({ ...rest[j], value: v.slice(8) }); continue; }
        if (v === '-S' || v === '--split-string') { split = rest[++j]; j++; break; }
        if (/^-S./.test(v) || v.startsWith('--split-string=')) { split = { ...rest[j], value: v.startsWith('-S') ? v.slice(2) : v.slice(15) }; j++; break; }
        const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(v);
        if (pair) { recordEnv(pair[1], pair[2], out.env, out.notes); continue; }
        break;
      }
      if (split) {
        if (split.dyn) out.unc.push('env -S splits a string that is only known when the shell runs');
        out.argv = [...splitCommandLine(split.value), ...rest.slice(j)];
      } else out.argv = rest.slice(j);
      continue;
    }
    if (!ps && (name === 'command' || name === 'builtin')) {
      if (name === 'command' && rest[0] && /^-[pvV]*[vV][pvV]*$/.test(rest[0].value)) { out.lookup = true; out.argv = rest; return out; }
      while (rest[j] && rest[j].value === '-p') j++;
      out.argv = rest.slice(j);
      continue;
    }
    if (!ps && name === 'exec') {
      while (rest[j] && /^-[cl]+$/.test(rest[j].value)) j++;
      if (rest[j] && rest[j].value === '-a') j += 2;
      out.argv = rest.slice(j);
      continue;
    }
    if (name === 'nohup' || name === 'winpty' || name === 'chronic' || name === 'unbuffer') { out.argv = rest; continue; }
    if (!ps && name === 'time') {
      while (isOpt(j)) { if (/^-(?:f|o)$/.test(rest[j].value)) j++; j++; }
      out.argv = rest.slice(j);
      continue;
    }
    if (!ps && (name === 'nice' || name === 'ionice')) {
      while (isOpt(j)) { if (/^-(?:n|c|p|t)$/.test(rest[j].value)) j++; j++; }
      out.argv = rest.slice(j);
      continue;
    }
    if (!ps && name === 'timeout') {
      while (isOpt(j)) { if (/^-(?:s|k)$/.test(rest[j].value)) j++; j++; }
      if (rest[j] && rest[j].value === '--') j++;
      out.argv = rest.slice(j + 1); // skip the duration
      continue;
    }
    if (!ps && name === 'stdbuf') {
      while (isOpt(j)) { if (/^-[ioe]$/.test(rest[j].value)) j++; j++; }
      out.argv = rest.slice(j);
      continue;
    }
    if (!ps && (name === 'sudo' || name === 'doas')) {
      for (; j < rest.length; j++) {
        const v = rest[j].value;
        if (rest[j].dyn) break;
        if (v === '--') { j++; break; }
        if (v === '-D' || v === '--chdir') { setCwd(rest[++j]); continue; }
        if (v.startsWith('--chdir=')) { setCwd({ ...rest[j], value: v.slice(8) }); continue; }
        if (/^-[ugChprtTU]$/.test(v) || /^--(?:user|group|close-from|host|prompt|role|type|command-timeout|other-user)$/.test(v)) { j++; continue; }
        if (v.startsWith('-')) continue;
        const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(v);
        if (pair) { recordEnv(pair[1], pair[2], out.env, out.notes); continue; }
        break;
      }
      out.argv = rest.slice(j);
      continue;
    }
    if (!ps && name === 'xargs') {
      for (; j < rest.length; j++) {
        const v = rest[j].value;
        if (rest[j].dyn) break;
        if (v === '--') { j++; break; }
        if (/^-[adEILnPs]$/.test(v) || /^--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var)$/.test(v)) { j++; continue; }
        if (v.startsWith('-')) continue;
        break;
      }
      out.argv = rest.slice(j);
      out.xargs = 'xargs adds arguments it reads from stdin';
      if (!out.argv.length) out.argv = [literalArg('echo')];
      continue;
    }
    if (name === 'wsl') {
      for (; j < rest.length; j++) {
        const v = rest[j].value;
        if (rest[j].dyn) break;
        if (v === '--' || v === '-e' || v === '--exec') { j++; break; }
        if (v === '--cd') { setCwd(rest[++j]); continue; }
        if (/^(?:-d|--distribution|-u|--user|--shell-type|--distribution-id)$/.test(v)) { j++; continue; }
        if (v.startsWith('-')) continue;
        break;
      }
      out.argv = rest.slice(j);
      continue;
    }
    break;
  }
  return out;
}

function applyCd(name, args, ctx, cmd) {
  const d = ctx.dialect;
  const kind = /^(?:pushd|push-location)$/.test(name) ? 'push' : /^(?:popd|pop-location)$/.test(name) ? 'pop' : 'cd';
  let target = null;
  let dyn = false;
  let unknownWhy = null;
  if (d === 'cmd') {
    const parts = args.filter((a) => !/^\/d$/i.test(a.value));
    if (kind !== 'pop') {
      if (!parts.length) return; // `cd` alone prints the directory
      target = parts.map((a) => a.value).join(' ');
      dyn = parts.some((a) => a.dyn);
    }
  } else if (d === 'powershell') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.quoted && !a.dyn && a.value.length > 1 && a.value.startsWith('-')) {
        const p = a.value.slice(1).toLowerCase();
        if ('path'.startsWith(p) || 'literalpath'.startsWith(p) || p === 'lp' || p === 'pspath') { const t = args[++i]; if (t) { target = t.value; dyn = t.dyn; } continue; }
        if ('stackname'.startsWith(p)) { i++; continue; }
        continue;
      }
      if (target === null) { target = a.value; dyn = a.dyn; }
    }
    if (target === '-' || target === '+') unknownWhy = `${name} ${target} returns to a location from history`;
    if (kind === 'cd' && target === null) return; // Set-Location alone stays put
  } else {
    let i = 0;
    while (i < args.length && /^-[LPe@]+$/.test(args[i].value)) i++;
    if (args[i] && args[i].value === '--') i++;
    if (kind === 'push' && args[i] && /^[+-]\d+$/.test(args[i].value)) unknownWhy = `${name} ${args[i].value} rotates the directory stack`;
    else if (args[i]) { target = args[i].value; dyn = args[i].dyn; }
    else if (kind === 'cd') target = '~';
  }
  const before = ctx.cwd;
  const atDepth = () => { ctx.cdDepth = d === 'posix' && cmd && cmd.depth > 0 ? cmd.depth : null; };
  if (kind === 'pop') {
    if (!ctx.stack.length) { ctx.cwdUnc = ctx.cwdUnc || `${name} returns to a directory pushed before this command`; return; }
    ctx.cwd = ctx.stack.pop();
    ctx.oldpwd = before;
    atDepth();
    return;
  }
  if (unknownWhy) { ctx.cwdUnc = ctx.cwdUnc || unknownWhy; return; }
  if (kind === 'push' && target === null) { ctx.cwdUnc = ctx.cwdUnc || `${name} with no directory swaps the directory stack`; return; }
  if (target === '-' && d === 'posix') {
    if (ctx.oldpwd === undefined) { ctx.cwdUnc = ctx.cwdUnc || 'cd - returns to a directory from before this command'; return; }
    ctx.cwd = ctx.oldpwd;
    ctx.oldpwd = before;
    atDepth();
    return;
  }
  if (dyn) ctx.cwdUnc = ctx.cwdUnc || `cd ${clip(target, 40)} goes to a directory that is only known when the shell runs`;
  if (kind === 'push') ctx.stack.push(before);
  ctx.oldpwd = before;
  ctx.cwd = joinDir(before, hostPath(target, ctx));
  atDepth();
}

function runPosixShell(argv, ctx, R, base, notes, name) {
  const step = pushStep(R, ctx, { raw: base.raw, notes });
  let cflag = false;
  let j = 1;
  for (; j < argv.length; j++) {
    const a = argv[j];
    const v = a.value;
    if (a.dyn) break;
    if (v === '--' || v === '-') { j++; break; }
    if (v === '--rcfile' || v === '--init-file') { j++; continue; }
    if (v.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(v)) {
      if (v[0] === '-' && v.includes('c')) cflag = true;
      if (/[oO]/.test(v.slice(1))) j++;
      continue;
    }
    break;
  }
  const script = argv[j];
  if (cflag) {
    if (!script) return false;
    if (script.dyn) { uncertainAt(R, step, `${name} -c runs a script that is only known when the shell runs`); return false; }
    walkSource(script.value, 'posix', ctx, R, false);
    return false;
  }
  if (script) return false; // a script file KLYPIX cannot read here
  const body = stdinScript(base.cmd);
  if (body !== null) walkSource(body, 'posix', ctx, R, false);
  else if (base.piped) uncertainAt(R, step, `${name} runs a script piped into it`);
  return false;
}

function stdinScript(cmd) {
  for (const r of (cmd && cmd.redirs) || []) {
    if (r.heredoc) return r.heredoc.body;
    if (r.op === '<<<' && r.target) return r.target.dyn ? null : r.target.value;
  }
  return null;
}

const isPureGroup = (w) => w.subs.length === 1 && w.segs.length === 1 && w.segs[0].dyn;
const PWSH_COMMAND_RE = /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/;
const PWSH_ENCODED_RE = /^[-/]e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?$/;
const PWSH_FILE_RE = /^[-/]f(?:i(?:l(?:e)?)?)?$/;
const PWSH_VALUE_RE = /^[-/](?:executionpolicy|ep|ex|exe|exec|windowstyle|w|inputformat|inp|in|if|outputformat|o|of|out|version|v|configurationname|config|custompipename|settingsfile|settings|psconsolefile|configurationfile)$/;
const PWSH_CWD_RE = /^[-/](?:workingdirectory|wd|wo)$/;

function runPowerShell(argv, ctx, R, base, notes, name) {
  const step = pushStep(R, ctx, { raw: base.raw, notes });
  const c = forkCtx(ctx);
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    if (isPureGroup(a)) return false; // `powershell { … }` — the block was walked as part of this word
    if (a.dyn) { uncertainAt(R, step, `${name} runs code that is only known when the shell runs`); return false; }
    const v = a.value.toLowerCase();
    if (PWSH_COMMAND_RE.test(v)) {
      const parts = argv.slice(j + 1);
      if (parts.length && parts.every(isPureGroup)) return false;
      if (parts.some((p) => p.dyn)) { uncertainAt(R, step, `${name} -Command runs code that is only known when the shell runs`); return false; }
      const text = parts.map((p) => p.value).join(' ');
      if (text.trim() === '-') { uncertainAt(R, step, `${name} -Command - reads its commands from stdin`); return false; }
      walkSource(text, 'powershell', c, R, true);
      return false;
    }
    if (PWSH_ENCODED_RE.test(v)) {
      const payload = argv[j + 1];
      const text = payload && !payload.dyn ? decodeEncodedCommand(payload.value) : null;
      if (text === null) { uncertainAt(R, step, `${name} -EncodedCommand could not be decoded`); return false; }
      walkSource(text, 'powershell', c, R, true);
      return false;
    }
    if (PWSH_FILE_RE.test(v)) return false;
    if (PWSH_VALUE_RE.test(v)) { j++; continue; }
    if (PWSH_CWD_RE.test(v)) {
      const dir = argv[++j];
      if (dir) {
        if (dir.dyn) c.cwdUnc = c.cwdUnc || `${name} -WorkingDirectory is only known when the shell runs`;
        c.cwd = joinDir(c.cwd, dir.value);
      }
      continue;
    }
    if (/^[-/]/.test(v)) continue;
    if (name === 'pwsh') return false; // pwsh's first positional argument is a script file
    const parts = argv.slice(j);
    if (parts.some((p) => p.dyn)) { uncertainAt(R, step, `${name} runs code that is only known when the shell runs`); return false; }
    walkSource(parts.map((p) => p.value).join(' '), 'powershell', c, R, true);
    return false;
  }
  return false;
}

function runCmd(argv, ctx, R, base, notes) {
  const step = pushStep(R, ctx, { raw: base.raw, notes });
  for (let j = 1; j < argv.length; j++) {
    const v = argv[j].value;
    if (/^\/{1,2}[ck]$/i.test(v)) {
      const parts = argv.slice(j + 1);
      if (parts.some((p) => p.dyn)) { uncertainAt(R, step, 'cmd /c runs a command line that is only known when the shell runs'); return false; }
      walkSource(parts.map((p) => p.value).join(' '), 'cmd', ctx, R, false);
      return false;
    }
    if (/^\/{1,2}[a-z](?::\w+)?$/i.test(v)) continue;
    break;
  }
  return false;
}

const SP_PARAMS = [['filepath', 1], ['argumentlist', 1], ['workingdirectory', 1], ['verb', 1], ['windowstyle', 1], ['redirectstandardinput', 1], ['redirectstandardoutput', 1], ['redirectstandarderror', 1], ['credential', 1], ['environment', 1], ['wait', 0], ['nonewwindow', 0], ['passthru', 0], ['loaduserprofile', 0], ['usenewenvironment', 0]];
const SP_ALIASES = { args: 'argumentlist', path: 'filepath', pspath: 'filepath', lup: 'loaduserprofile', nnw: 'nonewwindow', rsi: 'redirectstandardinput', rso: 'redirectstandardoutput', rse: 'redirectstandarderror' };

// PowerShell arrays (`'add','-A'`) reach a cmdlet as several values; split on unquoted commas.
function psArrayValues(w) {
  if (!w.segs) return [w.value];
  const out = [''];
  for (const s of w.segs) {
    if (!s.lit) { out[out.length - 1] += s.t; continue; }
    const parts = s.t.split(',');
    out[out.length - 1] += parts[0];
    for (const p of parts.slice(1)) out.push(p);
  }
  return out;
}

function runStartProcess(args, ctx, R, base, notes, env) {
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = !a.quoted && !a.dyn ? /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(a.value) : null;
    if (m) {
      const key = m[1].toLowerCase();
      const hits = SP_PARAMS.filter(([p]) => p.startsWith(key));
      const full = SP_ALIASES[key] || (hits.length === 1 ? hits[0][0] : null);
      if (full) {
        if (SP_PARAMS.find(([p]) => p === full)[1]) named[full] = m[2] !== undefined ? { ...a, value: m[2] } : args[++i];
        continue;
      }
    }
    positional.push(a);
  }
  const file = named.filepath || positional[0] || null;
  const list = named.argumentlist || positional[1] || null;
  if (!file || (!file.dyn && !isGitName(progName(file)))) { pushStep(R, ctx, { raw: base.raw, notes }); return false; }
  if (file.dyn) {
    const step = pushStep(R, ctx, { raw: base.raw, notes });
    if (/git/i.test(file.raw)) uncertainAt(R, step, `Start-Process runs ${clip(file.raw, 40)}, which is only known when the shell runs`);
    return false;
  }
  const unc = [];
  let gitArgs = [];
  if (list) {
    if (list.dyn) unc.push('Start-Process -ArgumentList is only known when the shell runs');
    else gitArgs = splitCommandLine(psArrayValues(list).join(' '));
  }
  const dir = named.workingdirectory;
  return gitStep(gitArgs, ctx, R, { ...base, env, notes, u: { cwd: dir ? joinDir(null, dir.value) : null, unc: dir && dir.dyn ? [...unc, 'Start-Process -WorkingDirectory is only known when the shell runs'] : unc, xargs: null } });
}

function ghStep(rest, ctx, R, base, notes) {
  const v = rest.map((a) => a.value);
  if (v[0] === 'pr' && v[1] === 'checkout') {
    pushStep(R, ctx, { raw: base.raw, git: true, cwd: ctx.cwd, sub: 'gh pr checkout', tier: 'MOVE', scope: 'all', notes, why: ['checks out a pull-request branch; uncommitted files of every session are carried along'], unc: ctxUnc(ctx) });
    return false;
  }
  if (v[0] === 'pr' && v[1] === 'merge' && v.slice(2).some((x) => x === '-d' || x === '--delete-branch')) {
    pushStep(R, ctx, { raw: base.raw, git: true, cwd: ctx.cwd, sub: 'gh pr merge', tier: 'MOVE', scope: 'all', flags: ['--delete-branch'], notes, why: ['switches the local branch after merging (--delete-branch)'], unc: ctxUnc(ctx) });
    return false;
  }
  pushStep(R, ctx, { raw: base.raw, notes });
  return false;
}

const ctxUnc = (ctx) => [ctx.cwdUnc, ctx.localUnc].filter(Boolean);
const envTruthy = (v) => v !== undefined && !/^(?:|0|false|no|off)$/i.test(String(v));

function gitStep(args, ctx, R, base) {
  const u = base.u || { cwd: null, unc: [], xargs: null };
  const unc = [...(u.unc || []), ...ctxUnc(ctx)];
  const flags = [];
  const env = { ...ctx.env, ...(base.env || {}) };
  for (const k of TARGET_ENV) {
    if (env[k] === undefined) continue;
    flags.push(`env:${k}`);
    unc.push(`${k} is set, so git may use another repository or index`);
  }
  if (base.extraUnc) unc.push(base.extraUnc);
  const literal = envTruthy(env.GIT_LITERAL_PATHSPECS) || envTruthy(env.GIT_NOGLOB_PATHSPECS);
  const cwd = u.cwd ? joinDir(ctx.cwd, u.cwd) : ctx.cwd;
  if (u.xargs) {
    // xargs appends what it reads from stdin: for git those words are usually pathspecs
    unc.push(u.xargs);
    args = [...args, { ...literalArg('(arguments from stdin)'), dyn: true, quoted: false }];
  }
  const r = classifyGitArgs(args, { ctx, cwd, literal, config: new Map(), aliasDepth: 0 });
  pushStep(R, ctx, {
    raw: base.raw,
    git: true,
    cwd: r.cwd,
    sub: r.sub,
    tier: r.tier,
    scope: r.scope,
    paths: r.paths,
    flags: [...flags, ...r.flags],
    action: r.action,
    needsRefCheck: r.needsRefCheck,
    readings: r.readings,
    why: r.why,
    notes: [...(base.notes || []), ...r.notes],
    unc: [...unc, ...r.unc],
    commitsIndex: r.commitsIndex,
  });
  if (r.shellAlias !== undefined) {
    // git runs a `!` alias with sh from the top level of the repository
    const c = forkCtx(ctx);
    c.cwd = r.cwd;
    c.cwdUnc = c.cwdUnc || 'a git shell alias runs from the top level of the repository';
    walkSource(r.shellAlias, 'posix', c, R, true);
  }
  return false;
}

// ───────────────────────────── git argv ─────────────────────────────

const GLOBAL_FLAGS = new Set(['-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
const GLOBAL_WITH_VALUE = new Set(['--git-dir', '--work-tree', '--namespace', '--attr-source', '--super-prefix', '--shallow-file']);
const GLOBAL_EXITS = new Set(['--html-path', '--man-path', '--info-path', '--version', '-v', '--help', '-h']);
const CONFIG_FLAG_RE = /^(?:core\.hookspath|clean\.requireforce|rebase\.autostash|merge\.autostash|pull\.rebase|alias\..+)$/;
const KNOWN_VERBS = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential credential-cache credential-manager credential-store daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch filter-repo flow fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep gui hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers last-modified lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-resolve merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree survey svn switch symbolic-ref tag unpack-file unpack-objects update-git-for-windows update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree').split(' '));

const configBool = (v) => !/^(?:false|no|off|0|)$/i.test(String(v ?? 'true'));

function classifyGitArgs(args, info) {
  const out = { cwd: info.cwd, flags: [], unc: [], notes: [], why: [], sub: null, tier: 'SAFE', scope: null, paths: null, action: null, needsRefCheck: null, readings: null, commitsIndex: false };
  const { config } = info;
  let literal = info.literal;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    const v = a.value;
    if (a.dyn) { out.unc.push(`git ${clip(a.raw, 40)} is only known when the shell runs`); return out; }
    if (!v.startsWith('-')) break;
    if (v === '-C') {
      const dir = args[++i];
      if (!dir) { out.notes.push('git -C without a directory: git refuses'); return out; }
      if (dir.dyn) out.unc.push('git -C points at a directory that is only known when the shell runs');
      if (dir.value !== '') out.cwd = joinDir(out.cwd, hostPath(dir.value, info.ctx));
      continue;
    }
    if (v === '-c') {
      const kv = args[++i];
      if (!kv) { out.notes.push('git -c without a setting: git refuses'); return out; }
      if (kv.dyn) { out.unc.push('a git -c setting is only known when the shell runs'); continue; }
      const eq = kv.value.indexOf('=');
      const key = (eq < 0 ? kv.value : kv.value.slice(0, eq)).toLowerCase();
      config.set(key, eq < 0 ? 'true' : kv.value.slice(eq + 1));
      if (CONFIG_FLAG_RE.test(key)) out.flags.push(`-c ${key}`);
      continue;
    }
    const eq = v.indexOf('=');
    const name = eq < 0 ? v : v.slice(0, eq);
    if (name === '--config-env') {
      const spec = eq < 0 ? args[++i] && args[i].value : v.slice(eq + 1);
      const key = String(spec || '').split('=')[0].toLowerCase();
      out.flags.push(`--config-env ${key}`);
      if (CONFIG_FLAG_RE.test(key)) out.unc.push(`git --config-env takes ${key} from an environment variable`);
      continue;
    }
    if (GLOBAL_WITH_VALUE.has(name)) {
      if (eq < 0) i++;
      out.flags.push(name);
      if (name === '--git-dir' || name === '--work-tree') out.unc.push(`${name} points git at another repository or working tree`);
      continue;
    }
    if (name === '--exec-path') { if (eq < 0) return out; continue; } // without a value it prints a path
    if (GLOBAL_EXITS.has(v) || name === '--list-cmds') return out; // prints and exits
    if (GLOBAL_FLAGS.has(v)) {
      out.flags.push(v);
      if (v === '--literal-pathspecs' || v === '--noglob-pathspecs') literal = true;
      if (v === '--glob-pathspecs') literal = false;
      continue;
    }
    out.unc.push(`unknown git option ${v}`);
    return out;
  }
  const verbArg = args[i];
  if (!verbArg) return out; // `git` alone prints its usage
  let verb = verbArg.value;
  const rest = args.slice(i + 1);
  if (!KNOWN_VERBS.has(verb)) {
    // aliases defined in this very command; an alias can never redefine a built-in
    const alias = config.get(`alias.${verb.toLowerCase()}`);
    if (alias !== undefined && info.aliasDepth < 8) {
      if (alias.startsWith('!')) {
        out.sub = verb;
        out.shellAlias = [alias.slice(1), ...rest.map((a) => `'${a.value.replace(/'/g, "'\\''")}'`)].join(' ');
        out.notes.push(`git ${verb} is the shell alias ${clip(alias, 60)}`);
        return out;
      }
      const inner = classifyGitArgs([...splitAlias(alias), ...rest], { ...info, cwd: out.cwd, literal, aliasDepth: info.aliasDepth + 1 });
      inner.flags.unshift(...out.flags);
      inner.unc.unshift(...out.unc);
      inner.notes.unshift(...out.notes, `git ${verb} is the alias ${clip(alias, 60)}`);
      return inner;
    }
    out.sub = verb;
    out.unc.push(`git ${clip(verb, 30)} is not a built-in command (an alias or an extension?)`);
    return out;
  }
  if (verb === 'stage') verb = 'add';
  out.sub = verb;
  const handler = VERBS[verb];
  if (!handler) return out; // a known command that never touches uncommitted work
  const r = handler(rest, { ctx: info.ctx, literal, config });
  out.tier = r.tier;
  out.scope = r.scope;
  out.paths = r.paths;
  out.action = r.action;
  out.needsRefCheck = r.needsRefCheck;
  out.readings = r.readings;
  out.commitsIndex = r.commitsIndex;
  out.flags.push(...r.flags);
  out.why.push(...r.why);
  out.notes.push(...r.notes);
  out.unc.push(...r.unc);
  return out;
}

function res(o) {
  const unc = [];
  if (o && o.unknown.length) unc.push(`unknown option ${o.unknown.join(' ')}`);
  if (o && o.missing) unc.push('an option is missing its value');
  return { tier: 'SAFE', scope: null, paths: null, flags: o ? o.flags.slice() : [], action: null, needsRefCheck: null, readings: null, why: [], notes: [], unc, commitsIndex: false };
}
function put(r, tier, scope, paths, why) {
  r.tier = tier;
  r.scope = scope;
  r.paths = paths && paths.length ? paths : null;
  if (why) r.why.push(why);
  return r;
}

// A word git reads as a commit when one by that name exists and as a path otherwise (`checkout X`,
// `reset X`, `checkout X Y`). The step reports the weaker reading (or, at equal tiers, the narrower
// one), so a caller that never resolves the word cannot ask or deny on a guess; both readings are
// handed over for the caller that runs `git rev-parse --verify --quiet --end-of-options X^{commit}`.
function ambiguous(r, word, asCommit, asPath, note) {
  const shape = (x) => ({ tier: x.tier, scope: x.scope, paths: x.paths && x.paths.length ? x.paths : null });
  const width = (x) => (x.paths && x.paths.length ? x.paths.length : Infinity);
  r.needsRefCheck = word;
  r.readings = { commit: shape(asCommit), path: shape(asPath) };
  r.notes.push(note);
  const rankDiff = tierRank(asCommit.tier) - tierRank(asPath.tier);
  const pick = rankDiff < 0 || (rankDiff === 0 && width(asCommit) <= width(asPath)) ? asCommit : asPath;
  return put(r, pick.tier, pick.scope, pick.paths, pick.why);
}
const listOf = (paths, max = 3) => (paths.length > max ? `${paths.slice(0, max).join(', ')} and ${paths.length - max} more` : paths.join(', '));
function unknownPaths(r, ps, extra) {
  if (extra) r.unc.push(extra);
  for (const why of ps.why) r.unc.push(why);
}

function moveVerb(verb) {
  return (rest, info) => {
    const o = parseOpts(rest, verb);
    const r = res(o);
    if (o.help) return r;
    for (const done of ['continue', 'skip', 'edit-todo', 'show-current-patch', 'retry', 'resolved']) if (isOn(o, done)) { r.action = done; return r; }
    if (isOn(o, 'abort') || isOn(o, 'quit')) {
      r.action = isOn(o, 'abort') ? 'abort' : 'quit';
      return put(r, 'MOVE', 'all', null, `git ${verb} --${r.action} puts the branch and the working tree back to before the ${verb}`);
    }
    let autostash = o.set.has('autostash') ? isOn(o, 'autostash') : null;
    if (autostash === null) {
      const rebasing = verb === 'rebase' || (verb === 'pull' && (o.set.has('rebase') ? o.set.get('rebase') !== false && o.set.get('rebase') !== 'false' : info.config.has('pull.rebase') && configBool(info.config.get('pull.rebase'))));
      const key = rebasing ? 'rebase.autostash' : verb === 'merge' || verb === 'pull' ? 'merge.autostash' : null;
      autostash = !!key && info.config.has(key) && configBool(info.config.get(key));
    }
    if (autostash) return put(r, 'PARK', 'tracked', null, `stashes every session's uncommitted changes for the duration of the ${verb} (autostash)`);
    return put(r, 'MOVE', 'all', null, `moves the branch under every session's uncommitted files (${verb})`);
  };
}

const STASH_ACTIONS = new Set(['push', 'save', 'pop', 'apply', 'drop', 'clear', 'branch', 'list', 'show', 'create', 'store', 'export', 'import']);

const VERBS = {
  add(rest, info) {
    const o = parseOpts(rest, 'add');
    const r = res(o);
    if (o.help) return r;
    if (['dry-run', 'interactive', 'patch', 'edit', 'refresh', 'intent-to-add'].some((n) => isOn(o, n))) return r;
    const ps = pathspecs([...o.pos, ...o.dd], info);
    const fromFile = o.set.has('pathspec-from-file');
    const all = isOn(o, 'all') && !isOn(o, 'ignore-removal');
    const update = isOn(o, 'update') || isOn(o, 'renormalize');
    if (!ps.paths.length && !fromFile) {
      if (all) return put(r, 'SWEEP', 'all', null, 'stages every change in the working tree, tracked and untracked (add -A)');
      if (update) return put(r, 'SWEEP', 'tracked', null, 'stages every change to tracked files in the working tree (add -u)');
      return r; // "Nothing specified, nothing added."
    }
    const scope = update && !all ? 'tracked' : 'all';
    if (fromFile || ps.unknown) {
      unknownPaths(r, ps, fromFile ? 'add reads its pathspecs from a file' : null);
      return put(r, 'SWEEP', scope, ps.paths, 'stages pathspecs that are only known when the command runs');
    }
    if (ps.broad) return put(r, 'SWEEP', scope, ps.paths, `stages everything under ${listOf(ps.paths)}`);
    return put(r, 'EXPLICIT', 'paths', ps.paths, `stages the files it names: ${listOf(ps.paths)}`);
  },

  commit(rest, info) {
    const o = parseOpts(rest, 'commit');
    const r = res(o);
    if (o.help || isOn(o, 'dry-run') || isOn(o, 'interactive') || isOn(o, 'patch')) return r;
    if (lastAt(o, 'no-verify') > lastAt(o, 'verify')) r.notes.push('the commit-time check is bypassed (--no-verify)');
    if (info.config.has('core.hookspath')) r.notes.push('the commit-time check is bypassed (-c core.hooksPath)');
    const ps = pathspecs([...o.pos, ...o.dd], info);
    const fromFile = o.set.has('pathspec-from-file');
    const amend = isOn(o, 'amend') ? ' and rewrites the last commit (--amend)' : '';
    if (isOn(o, 'all')) {
      r.commitsIndex = true;
      if (ps.unknown) unknownPaths(r, ps);
      return put(r, 'SWEEP', 'tracked', ps.paths, `commits everything staged plus every change to tracked files (commit -a)${amend}`);
    }
    if (!ps.paths.length && !fromFile) {
      r.commitsIndex = true;
      return put(r, 'SWEEP', 'index', null, `commits everything staged in the shared index, including what other sessions staged${amend}`);
    }
    if (isOn(o, 'include')) {
      r.commitsIndex = true;
      if (fromFile || ps.unknown) unknownPaths(r, ps, fromFile ? 'commit reads its pathspecs from a file' : null);
      return put(r, 'SWEEP', 'index', ps.paths, `commits everything staged plus ${listOf(ps.paths)} (commit -i)${amend}`);
    }
    if (fromFile || ps.unknown) {
      unknownPaths(r, ps, fromFile ? 'commit reads its pathspecs from a file' : null);
      return put(r, 'SWEEP', 'tracked', ps.paths, 'commits pathspecs that are only known when the command runs');
    }
    if (ps.broad) return put(r, 'SWEEP', 'tracked', ps.paths, `commits every tracked change under ${listOf(ps.paths)}${amend}`);
    return put(r, 'EXPLICIT', 'paths', ps.paths, `commits only the files it names: ${listOf(ps.paths)}${amend}`);
  },

  reset(rest, info) {
    const o = parseOpts(rest, 'reset');
    const r = res(o);
    if (o.help || isOn(o, 'patch')) return r;
    let mode = 'mixed';
    let at = -1;
    for (const m of ['hard', 'soft', 'mixed', 'merge', 'keep']) if (lastAt(o, m) > at) { at = lastAt(o, m); mode = m; }
    if (mode === 'hard') return put(r, 'DISCARD', 'tracked', null, 'throws away every staged and unstaged change to tracked files (reset --hard)');
    if (mode === 'merge') return put(r, 'DISCARD', 'index', null, 'throws away staged changes (reset --merge)');
    if (mode === 'keep' || mode === 'soft') return put(r, 'MOVE', null, null, `moves the branch (reset --${mode})`);
    if (o.set.has('pathspec-from-file') || isOn(o, 'stdin')) { r.unc.push('reset reads its pathspecs from a file'); return put(r, 'UNSTAGE', 'index', null, 'unstages paths read from a file'); }
    const pos = o.pos;
    let commit = o.sawDD ? pos[0] || null : null;
    let paths = o.sawDD ? o.dd : [];
    if (!o.sawDD && pos.length) {
      const x = pos[0];
      if (!x.dyn && looksLikeRevision(x.value)) { commit = x; paths = pos.slice(1); }
      else if (x.dyn || definitelyPath(x.value)) paths = pos;
      else {
        const all = pathspecs(pos, info);
        const after = pathspecs(pos.slice(1), info);
        if (all.unknown) unknownPaths(r, all);
        return ambiguous(r, x.value,
          after.paths.length
            ? { tier: 'UNSTAGE', scope: 'index', paths: after.paths, why: `unstages ${listOf(after.paths)} (back to their version in ${x.value})` }
            : { tier: 'MOVE', scope: 'index', paths: null, why: `moves the branch to ${x.value} and unstages everything` },
          { tier: 'UNSTAGE', scope: 'index', paths: all.paths, why: `unstages ${listOf(all.paths)}` },
          `"${x.value}" is a commit or a path; the caller resolves it with git rev-parse --verify`);
      }
    }
    if (paths.length) {
      const ps = pathspecs(paths, info);
      if (ps.unknown) unknownPaths(r, ps);
      return put(r, 'UNSTAGE', 'index', ps.paths, `unstages ${listOf(ps.paths)}`);
    }
    if (commit && !HEADLIKE.has(commit.value)) return put(r, 'MOVE', 'index', null, `moves the branch to ${commit.value} and unstages everything`);
    return put(r, 'UNSTAGE', 'index', null, "unstages everything in the shared index, including other sessions' staged files");
  },

  checkout(rest, info) {
    const o = parseOpts(rest, 'checkout');
    const r = res(o);
    if (o.help || isOn(o, 'patch')) return r;
    const force = isOn(o, 'force');
    const switching = (what) => (force
      ? put(r, 'DISCARD', 'tracked', null, `${what} and throws away every local change to tracked files (-f)`)
      : put(r, 'MOVE', 'all', null, `${what}; uncommitted files of every session are carried along`));
    if (o.set.has('b') || o.set.has('B') || o.set.has('orphan')) return switching('creates a branch and switches to it');
    if (isOn(o, 'detach')) return switching('detaches HEAD');
    const fromFile = o.set.has('pathspec-from-file');
    const pos = o.pos;
    if (o.sawDD || fromFile) {
      if (!o.dd.length && !fromFile) return pos.length ? switching(`switches to ${pos[0].value}`) : r;
      const ps = pathspecs(o.dd, info);
      if (fromFile || ps.unknown) unknownPaths(r, ps, fromFile ? 'checkout reads its pathspecs from a file' : null);
      const source = pos[0] ? `the version in ${pos[0].value} (staged and unstaged)` : 'the staged version';
      return put(r, 'DISCARD', 'tracked', ps.paths, `overwrites ${ps.paths.length ? listOf(ps.paths) : 'the paths it reads'} with ${source}`);
    }
    if (!pos.length) return force ? put(r, 'DISCARD', 'tracked', null, 'throws away every local change to tracked files (checkout -f)') : r;
    if (pos.length === 1) {
      const x = pos[0];
      if (x.dyn) { r.unc.push(`${clip(x.raw, 40)} is only known when the shell runs`); return switching('checks out a branch or path that is only known when the shell runs'); }
      if (looksLikeRevision(x.value)) return switching(`switches to ${x.value}`);
      if (definitelyPath(x.value) || x.glob || isOn(o, 'ours') || isOn(o, 'theirs')) {
        const ps = pathspecs([x], info);
        if (ps.unknown) unknownPaths(r, ps);
        return put(r, 'DISCARD', 'tracked', ps.paths, `throws away unstaged changes to ${listOf(ps.paths)}`);
      }
      const asPath = pathspecs([x], info).paths;
      return ambiguous(r, x.value,
        force
          ? { tier: 'DISCARD', scope: 'tracked', paths: null, why: `switches to ${x.value} and throws away every local change to tracked files (-f)` }
          : { tier: 'MOVE', scope: 'all', paths: null, why: `switches to ${x.value}; uncommitted files of every session are carried along` },
        { tier: 'DISCARD', scope: 'tracked', paths: asPath, why: `throws away unstaged changes to ${x.value}` },
        `"${x.value}" is a branch (checkout switches to it) or a path (its changes are thrown away); the caller resolves it with git rev-parse --verify`);
    }
    const first = pos[0];
    const all = pathspecs(pos, info);
    if (all.unknown) unknownPaths(r, all);
    if (!first.dyn && looksLikeRevision(first.value)) {
      const ps = pathspecs(pos.slice(1), info);
      return put(r, 'DISCARD', 'tracked', ps.paths, `overwrites ${listOf(ps.paths)} with the version in ${first.value}`);
    }
    if (first.dyn || definitelyPath(first.value)) return put(r, 'DISCARD', 'tracked', all.paths, `throws away unstaged changes to ${listOf(all.paths)}`);
    const after = pathspecs(pos.slice(1), info).paths;
    return ambiguous(r, first.value,
      { tier: 'DISCARD', scope: 'tracked', paths: after, why: `overwrites ${listOf(after)} with the version in ${first.value}` },
      { tier: 'DISCARD', scope: 'tracked', paths: all.paths, why: `throws away unstaged changes to ${listOf(all.paths)}` },
      `"${first.value}" is a commit to check the other paths out of, or one more path; the caller resolves it with git rev-parse --verify`);
  },

  switch(rest) {
    const o = parseOpts(rest, 'switch');
    const r = res(o);
    if (o.help) return r;
    const create = o.set.has('create') || o.set.has('force-create') || o.set.has('orphan');
    if (!create && !o.pos.length && !isOn(o, 'detach')) return r; // git switch needs a branch
    if (isOn(o, 'force') || isOn(o, 'discard-changes')) return put(r, 'DISCARD', 'tracked', null, 'switches branches and throws away every local change to tracked files');
    return put(r, 'MOVE', 'all', null, `${create ? 'creates a branch and switches to it' : 'switches branches'}; uncommitted files of every session are carried along`);
  },

  restore(rest, info) {
    const o = parseOpts(rest, 'restore');
    const r = res(o);
    if (o.help || isOn(o, 'patch')) return r;
    const staged = isOn(o, 'staged');
    const worktree = isOn(o, 'worktree') || !staged;
    const fromFile = o.set.has('pathspec-from-file');
    const ps = pathspecs([...o.pos, ...o.dd], info);
    if (!ps.paths.length && !fromFile) return r; // git restore needs paths
    if (fromFile || ps.unknown) unknownPaths(r, ps, fromFile ? 'restore reads its pathspecs from a file' : null);
    const what = ps.paths.length ? listOf(ps.paths) : 'the paths it reads';
    if (worktree) return put(r, 'DISCARD', 'tracked', ps.paths, `throws away ${staged ? 'staged and unstaged' : 'unstaged'} changes to ${what}`);
    return put(r, 'UNSTAGE', 'index', ps.paths, `unstages ${what}`);
  },

  stash(rest, info) {
    const first = rest[0];
    let action = 'push';
    let args = rest;
    if (first && first.dyn) { const r = res(null); r.unc.push(`git stash ${clip(first.raw, 30)} is only known when the shell runs`); return r; }
    if (first && !first.value.startsWith('-')) {
      if (!STASH_ACTIONS.has(first.value)) { const r = res(null); r.notes.push(`git stash ${clip(first.value, 30)} is not a stash command: git refuses`); return r; }
      action = first.value;
      args = rest.slice(1);
    }
    if (action === 'push' || action === 'save') {
      const o = parseOpts(args, `stash ${action}`);
      const r = res(o);
      r.action = action;
      if (o.help || isOn(o, 'patch')) return r;
      const scope = isOn(o, 'staged') ? 'index' : isOn(o, 'include-untracked') || isOn(o, 'all') ? 'all' : 'tracked';
      let paths = null;
      if (action === 'push') {
        const fromFile = o.set.has('pathspec-from-file');
        const ps = pathspecs([...o.pos, ...o.dd], info);
        if (fromFile || ps.unknown) unknownPaths(r, ps, fromFile ? 'stash reads its pathspecs from a file' : null);
        paths = ps.paths;
      }
      const what = scope === 'index' ? 'staged changes' : scope === 'all' ? 'uncommitted changes and untracked files' : 'uncommitted changes';
      return put(r, 'PARK', scope, paths, `takes every session's ${what}${paths && paths.length ? ` under ${listOf(paths)}` : ''} out of the working tree (stash ${action})`);
    }
    const table = `stash ${action}`;
    const o = GIT_OPTION_SPECS[table] !== undefined ? parseOpts(args, table) : { flags: [], unknown: [], missing: false, help: args.some((a) => a.value === '-h' || a.value === '--help') };
    const r = GIT_OPTION_SPECS[table] !== undefined ? res(o) : res(null);
    r.action = action;
    if (o.help) return r;
    if (action === 'pop' || action === 'apply') return put(r, 'MOVE', null, null, `writes a stash entry back into the working tree (stash ${action}); the stash stack is shared by every worktree`);
    if (action === 'drop' || action === 'clear') return put(r, 'MOVE', null, null, `deletes stash entries (stash ${action}); whether they belong to another session is the caller's to check`);
    if (action === 'branch') return put(r, 'MOVE', null, null, 'creates a branch from a stash entry and switches to it');
    return r;
  },

  clean(rest, info) {
    const o = parseOpts(rest, 'clean');
    const r = res(o);
    if (o.help || isOn(o, 'dry-run') || isOn(o, 'interactive')) return r;
    const requireForce = info.config.has('clean.requireforce') ? configBool(info.config.get('clean.requireforce')) : true;
    if (!isOn(o, 'force') && requireForce) { r.notes.push('git refuses to clean without -f (unless clean.requireForce=false is configured)'); return r; }
    const ps = pathspecs([...o.pos, ...o.dd], info);
    if (ps.unknown) unknownPaths(r, ps);
    const what = o.set.has('X') ? 'ignored files only' : o.set.has('x') ? 'untracked and ignored files' : 'untracked files';
    return put(r, 'DISCARD', 'untracked', ps.paths, `deletes ${what}${o.set.has('d') ? ' and directories' : ''}${ps.paths.length ? ` under ${listOf(ps.paths)}` : ''}`);
  },

  worktree(rest) {
    const first = rest[0];
    if (!first || first.dyn) { const r = res(null); if (first) r.unc.push('the worktree command is only known when the shell runs'); return r; }
    if (first.value !== 'remove') { const r = res(null); r.action = first.value; return r; }
    const o = parseOpts(rest.slice(1), 'worktree remove');
    const r = res(o);
    r.action = 'remove';
    if (o.help) return r;
    const target = o.pos[0] || o.dd[0];
    if (!target) return r;
    if (target.dyn) r.unc.push(`the worktree ${clip(target.raw, 40)} is only known when the shell runs`);
    return put(r, 'DISCARD', 'all', [target.value], `deletes the worktree ${target.value} with its uncommitted and ignored files`);
  },

  rebase: moveVerb('rebase'),
  merge: moveVerb('merge'),
  pull: moveVerb('pull'),
  'cherry-pick': moveVerb('cherry-pick'),
  revert: moveVerb('revert'),
  am: moveVerb('am'),

  rm(rest, info) {
    const o = parseOpts(rest, 'rm');
    const r = res(o);
    if (o.help || isOn(o, 'dry-run')) return r;
    const fromFile = o.set.has('pathspec-from-file');
    const ps = pathspecs([...o.pos, ...o.dd], info);
    if (fromFile || ps.unknown) unknownPaths(r, ps, fromFile ? 'rm reads its pathspecs from a file' : null);
    if (isOn(o, 'cached')) return put(r, 'UNSTAGE', 'index', ps.paths, `removes ${listOf(ps.paths)} from the index only`);
    if (isOn(o, 'force')) return put(r, 'DISCARD', 'tracked', ps.paths, `deletes ${listOf(ps.paths)} even with uncommitted changes (rm -f)`);
    return r; // git refuses to remove files that have uncommitted changes
  },

  'read-tree'(rest) {
    const o = parseOpts(rest, 'read-tree');
    const r = res(o);
    if (o.help) return r;
    if (o.set.has('u') && isOn(o, 'reset')) return put(r, 'DISCARD', 'tracked', null, 'overwrites the working tree and the index (read-tree -u --reset)');
    return r;
  },

  'checkout-index'(rest, info) {
    const o = parseOpts(rest, 'checkout-index');
    const r = res(o);
    if (o.help || !isOn(o, 'force') || o.set.has('prefix') || isOn(o, 'temp')) return r; // --prefix/--temp write elsewhere
    if (isOn(o, 'all')) return put(r, 'DISCARD', 'tracked', null, 'overwrites every tracked file with its staged version (checkout-index -f -a)');
    if (!o.pos.length && !o.dd.length) return r;
    const ps = pathspecs([...o.pos, ...o.dd], info);
    if (ps.unknown) unknownPaths(r, ps);
    return put(r, 'DISCARD', 'tracked', ps.paths, `overwrites ${listOf(ps.paths)} with the staged version (checkout-index -f)`);
  },

  status(rest, info) {
    const o = parseOpts(rest, 'status');
    const r = res(o);
    if (o.help) return r;
    return put(r, 'READ', null, [...o.pos, ...o.dd].map((w) => hostPath(w.value, info.ctx)), 'lists uncommitted changes');
  },

  diff(rest, info) {
    const r = res(null);
    if (rest.some((a) => a.value === '-h' || a.value === '--help')) return r;
    const dd = rest.findIndex((a) => a.value === '--');
    return put(r, 'READ', null, dd < 0 ? null : rest.slice(dd + 1).map((w) => hostPath(w.value, info.ctx)), 'shows uncommitted changes');
  },

  log: logLike,
  show: logLike,
  whatchanged: logLike,

  'ls-files'(rest) {
    const o = parseOpts(rest, 'ls-files');
    const r = res(o);
    r.unc = []; // ls-files changes nothing; an option it does not know is harmless
    if (o.help) return r;
    if (['modified', 'others', 'deleted', 'killed', 'unmerged'].some((n) => isOn(o, n))) return put(r, 'READ', null, null, 'lists uncommitted files');
    return r;
  },
};

// log/show take revision and diff options git's -h does not list; scan them leniently and skip the
// values of the options whose argument is data (-S, -G, --grep, …) so a search string is never read.
const LOG_VALUE_OPTS = new Set(['-S', '-G', '-n', '-L', '-O', '--grep', '--author', '--committer', '--since', '--after', '--until', '--before', '--skip', '--max-count', '--min-parents', '--max-parents', '--format', '--pretty', '--date', '--decorate-refs', '--decorate-refs-exclude', '--exclude', '--glob', '--diff-filter', '--word-diff-regex', '-U', '--unified', '--output', '--encoding']);
const LOG_READ_OPTS = /^--(?:stat|name-only|name-status|numstat|shortstat)(?:=|$)/;
function logLike(rest) {
  const r = res(null);
  let read = false;
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (v === '--') break;
    if (v === '-h' || v === '--help') return r;
    if (LOG_VALUE_OPTS.has(v)) { i++; continue; }
    if (/^-[SGnLOU]./.test(v)) continue;
    if (LOG_READ_OPTS.test(v)) read = true;
  }
  return read ? put(r, 'READ', null, null, 'lists the files commits changed') : r;
}

// ───────────────────────────── steps, staging and the result ─────────────────────────────

function pushStep(R, ctx, f) {
  const step = {
    index: R.steps.length,
    raw: f.raw || '',
    git: !!f.git,
    cwd: f.git ? f.cwd ?? null : ctx.cwd ?? null,
    sub: f.sub ?? null,
    tier: f.tier || 'SAFE',
    scope: f.scope ?? null,
    paths: f.paths && f.paths.length ? f.paths.slice() : null,
    flags: dedupe(f.flags || []),
    action: f.action ?? null,
    needsRefCheck: f.needsRefCheck ?? null,
    readings: f.readings ?? null,
    ok: true,
  };
  R.steps.push(step);
  R.commitsIndex[step.index] = !!f.commitsIndex;
  const label = `step ${step.index} \`${clip(step.raw)}\``;
  if (step.tier !== 'SAFE') for (const why of f.why || []) R.reasons.push(`${label}: ${step.tier} — ${why}`);
  for (const note of dedupe(f.notes || [])) R.reasons.push(`${label}: ${note}`);
  for (const why of dedupe(f.unc || [])) uncertainAt(R, step, why);
  return step;
}

// What each commit in the chain would also commit because an earlier `git add <paths>` in the same
// command staged it — the index before the command runs does not hold those files yet (safety-B4).
function simulateStaging(steps, commitsIndex) {
  const out = {};
  let staged = [];
  const key = (p) => p.replace(/^\.\//, '');
  const remove = (paths) => { const drop = new Set(paths.map(key)); staged = staged.filter((p) => !drop.has(key(p))); };
  for (const s of steps) {
    if (!s.git) continue;
    const joined = (s.paths || []).map((p) => joinPath(s.cwd, p));
    if (s.sub === 'add' && s.tier === 'EXPLICIT') { for (const p of joined) if (!staged.includes(p)) staged.push(p); continue; }
    if ((s.sub === 'reset' || s.sub === 'restore') && s.tier === 'UNSTAGE') { if (!s.paths) staged = []; else remove(joined); continue; }
    if (s.sub === 'stash' && s.tier === 'PARK') { if (!s.paths) staged = []; else remove(joined); continue; }
    if (s.sub === 'commit' && s.tier !== 'SAFE') {
      if (commitsIndex[s.index]) { out[s.index] = staged.slice(); staged = []; } else { out[s.index] = []; remove(joined); }
    }
  }
  return out;
}

function normalizeDialect(d) {
  const v = String(d ?? '').trim().toLowerCase();
  if (['posix', 'bash', 'sh', 'zsh', 'git-bash', 'gitbash'].includes(v)) return 'posix';
  if (['powershell', 'pwsh', 'ps', 'powershell.exe', 'pwsh.exe'].includes(v)) return 'powershell';
  if (v === 'cmd' || v === 'cmd.exe') return 'cmd';
  return null;
}

function finish(R, dialect) {
  const errors = dedupe(R.errors);
  return {
    ok: errors.length === 0 && R.uncertain.length === 0,
    dialect,
    steps: R.steps,
    strongest: R.steps.reduce((tier, s) => stronger(tier, s.tier), 'SAFE'),
    stagedBeforeCommit: simulateStaging(R.steps, R.commitsIndex),
    reasons: [...R.reasons, ...R.uncertain, ...errors.map((e) => `could not parse: ${e}`)],
  };
}

function run(source, dialect, platform) {
  const R = { steps: [], reasons: [], uncertain: [], errors: [], commitsIndex: [] };
  try {
    if (Array.isArray(source)) {
      // An argv array (no shell): the words are exactly what the program receives.
      if (source.length) classifyArgv(source.map((s) => literalArg(String(s))), newCtx('argv', platform), R, { raw: source.map(String).join(' '), env: {}, notes: [] });
      return finish(R, dialect);
    }
    const parsed = parseSource(source, dialect, 0);
    for (const e of parsed.errors) R.errors.push(e);
    walkSeq(parsed.seq, newCtx(dialect, platform), R);
    return finish(R, dialect);
  } catch (err) {
    // The guard's contract is "never throw": a bug here must turn into "could not verify".
    R.errors.push(`classifier error: ${clip(err && err.message ? err.message : err, 120)}`);
    return finish(R, dialect);
  }
}

export function classifyCommand(command, options = {}) {
  const { dialect = 'posix', platform = DEFAULT_PLATFORM } = (options && typeof options === 'object') ? options : {};
  const d = normalizeDialect(dialect);
  if (Array.isArray(command)) return run(command, d || 'posix', platform);
  if (typeof command !== 'string') {
    return { ok: false, dialect: d, steps: [], strongest: 'SAFE', stagedBeforeCommit: {}, reasons: ['could not parse: the command is not text'] };
  }
  if (command.length > MAX_INPUT) {
    return { ok: false, dialect: d, steps: [], strongest: 'SAFE', stagedBeforeCommit: {}, reasons: [`could not parse: the command is longer than ${MAX_INPUT} characters`] };
  }
  if (d) return run(command, d, platform);
  // Ambiguous dialect: a backtick is an escape in PowerShell and a command substitution in POSIX,
  // so the two readings can disagree; report the stronger one and never decide on it.
  const a = run(command, 'posix', platform);
  const b = run(command, 'powershell', platform);
  const pick = tierRank(b.strongest) > tierRank(a.strongest) ? b : a;
  return { ...pick, ok: false, dialect: null, reasons: [`could not verify: the shell dialect is not known (POSIX reads ${a.strongest}, PowerShell reads ${b.strongest})`, ...pick.reasons] };
}
