// whose-rescue — rescue copies of uncommitted files ("Whose is this?" v1).
//
// Before a git command that would discard uncommitted work runs (reset --hard,
// checkout/restore of paths, clean -f, stash), KLYPIX saves the CURRENT bytes
// of the affected files as an ordinary commit under refs/klypix/rescue/<id>.
// `npx klypix-mcp rescue restore <id>` writes them back. A copy is a copy: the
// git command still runs (or not) exactly as the agent and the human decide.
//
// HOW — git through execFileSync argument arrays, never a shell:
//   1. Node reads the RAW bytes of each file. Nothing applies a clean filter,
//      CRLF→LF conversion or an LFS hook, so a restore is byte-identical
//      whatever core.autocrlf or .gitattributes say, and each blob id equals
//      the raw `blob` hash whose-ledger records for the same bytes.
//   2. ONE `for-each-ref` picks a ref name no ref has yet (and finds the copy
//      a retry may reuse). An existing ref is never moved or overwritten.
//   3. ONE `git fast-import` builds the tree from HEAD plus the rescued files
//      (`from <HEAD>`, then D/M commands), writes the commit with a pinned
//      KLYPIX identity, and creates that ref. `git diff <rescue>^ <rescue>`
//      shows exactly what was saved; an unborn branch gets a root commit.
//   Measured on Windows (2026-10-16, Git 2.53, ~100-150 ms per process): the
//   temporary-index pipeline (read-tree, update-index, write-tree,
//   commit-tree, update-ref — 8 spawns) took 0.9-2.8 s, too close to the
//   2.5 s budget; fast-import (3-4 spawns) took 0.3-0.5 s warm.
//
// THE USER'S INDEX AND WORKING TREE NEVER CHANGE during createRescue. No index
// is used at all: fast-import never reads or writes one, the real index is only
// read (ls-files), and every command that writes anything runs with
// GIT_INDEX_FILE pointed at a throwaway path that is never created — so not
// even a git bug could touch the real index. Nothing is written into the
// working tree. What is added: objects (one small pack), one ref, and a
// one-line dedup note in <git dir>/klypix-rescue/. GIT_OPTIONAL_LOCKS=0
// throughout. A user's reference-transaction hook does not run for this
// plumbing (core.hooksPath points at a folder that does not exist).
//
// NEVER INCLUDED — always listed in `skipped`, never dropped silently:
// ignored files (V1 decision 5), files over 50 MB, anything past 300 MB in
// total (largest first), unreadable files, nested repositories and
// submodules, paths outside the repository or inside .git, and names git
// cannot store on this system.
//
// A rescued path that does not exist is recorded as `deleted` (absent when the
// copy was taken). That is what makes a restore undoable: the backup a restore
// takes first records the files the restore is about to create as absent, so
// restoring that backup removes them again.
//
// Never throws: every export returns { ok:false, error } instead.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const RESCUE_REF_PREFIX = 'refs/klypix/rescue/';
export const RESCUE_BUDGET_MS = 2500;
export const RESCUE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const RESCUE_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
export const RESCUE_KEEP = 50;
export const RESCUE_MAX_AGE_MS = 14 * 86400000;
// What one rescue may write per second of the time it has left: below the
// slowest cold pack write measured on Windows (6 MB/s, 2026-10-19), so the
// 2.5 s budget holds about 11 MB and a slower machine still finishes in time.
// A human-run restore has minutes, so its backup is bounded only by the caps.
export const RESCUE_BYTES_PER_SEC = 6 * 1024 * 1024;
// Kept back from the time left for the spawns after the byte count is fixed
// (one for-each-ref, fast-import start-up and its index write).
const RESCUE_RESERVE_MS = 400;
// However little time is left, small files are still attempted.
const RESCUE_MIN_BYTES = 256 * 1024;

const META_TAG = 'klypix-rescue-v1 ';
const NUL = '\x00';
const WIN = process.platform === 'win32';
const IDENT = 'KLYPIX <rescue@klypix.invalid>';
// A human-invoked list/show/restore/prune may take longer than the hook's
// rescue; it is still bounded so a wedged git cannot hang the terminal.
const CLI_BUDGET_MS = 120_000;
// Repeating the same risky command (deny → retry) must not pile up identical
// copies that crowd the list.
const DEDUP_WINDOW_MS = 60 * 60 * 1000;
// Windows caps a command line at 32,767 characters; pathspec lists are chunked.
const ARGV_CHARS = 20_000;
const TOO_LONG = 'took too long';

// Variables that would point git at a different repository, index or object
// store than repoRoot, or switch every pathspec into a magic mode
// (GIT_LITERAL_PATHSPECS breaks check-ignore outright). A hook can inherit any
// of them from a parent git process; the rescue must mean THIS repository.
const STRIP_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_QUARANTINE_PATH',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
];

function gitEnv(extra) {
  const env = { ...process.env };
  for (const key of STRIP_ENV) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}

// One git runner per call tree, bound to a working directory and a shared
// deadline. Returns { ok, code, out, err, timedOut } and never throws.
function makeGit(cwd, deadline) {
  return (args, { input, env, binary = false, maxBuffer = 64 * 1024 * 1024, allow = [0] } = {}) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) return { ok: false, code: null, out: binary ? Buffer.alloc(0) : '', err: TOO_LONG, timedOut: true };
    try {
      const out = execFileSync('git', args, {
        cwd,
        env: gitEnv(env),
        // Always bytes: a string `input` would be decoded with `encoding`.
        input: input == null ? Buffer.alloc(0) : Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'),
        encoding: binary ? 'buffer' : 'utf8',
        timeout,
        maxBuffer,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, code: 0, out, err: '', timedOut: false };
    } catch (error) {
      const code = typeof error?.status === 'number' ? error.status : null;
      const timedOut = error?.code === 'ETIMEDOUT';
      const out = error?.stdout ?? '';
      return {
        ok: !timedOut && allow.includes(code),
        code,
        out: binary ? Buffer.from(out) : String(out),
        err: timedOut ? TOO_LONG : String(error?.stderr || error?.message || error),
        timedOut,
      };
    }
  };
}

const firstLine = (s) => String(s || '').trim().split('\n').find(Boolean) || '';
const gitError = (what, r) => (r.timedOut ? TOO_LONG : `git ${what} failed${r.err ? `: ${firstLine(r.err)}` : ''}`);

// ── paths ─────────────────────────────────────────────────────────────────────

// `.git` in any spelling NTFS or HFS+ would resolve to the same folder.
function isDotGit(part) {
  return /^\.git[. ]*$/i.test(part) || /^git~\d+$/i.test(part);
}

// Names git refuses to store here (verify_path; on Windows also
// is_valid_win32_path with core.protectNTFS, the default). Such a name would
// make fast-import stop, so it is skipped and listed instead. Stricter than
// git at worst, which only means a strange name is listed as not included.
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|:|$)/i;
function storable(rel, isLink) {
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..' || isDotGit(part)) return false;
    if (WIN && (/[<>:"|?*\\\x00-\x1f]/.test(part) || /[. ]$/.test(part) || WIN_RESERVED.test(part))) return false;
  }
  return !(isLink && /(^|\/)\.(gitmodules|gitattributes|gitignore|mailmap)$/i.test(rel));
}

const foldKey = (rel) => (WIN ? rel.toLowerCase() : rel);

// The real path of `abs`, resolving the deepest part of it that exists (so a
// path reached through a junction or a folder symlink maps onto the real tree
// git reports as the toplevel, even when the file itself is gone).
function realpathNearest(abs) {
  const tail = [];
  let cur = path.resolve(abs);
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return null;
    tail.push(path.basename(cur));
    cur = up;
  }
}

const outside = (relative) => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

// Request path → repository-relative, '/'-separated, or { why }. The whole
// repository ('.', or the toplevel itself) is rel '' — a folder pathspec like
// any other, as in `git restore .` / `git checkout -- .`.
function repoRel(top, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { why: 'empty path' };
  let rel = raw.replace(/\\/g, '/');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(rel)) {
    let relative = path.relative(top, path.resolve(raw));
    if (outside(relative)) {
      const real = realpathNearest(raw);
      if (real) relative = path.relative(top, real);
    }
    if (outside(relative)) return { why: 'outside the repository' };
    rel = relative.replace(/\\/g, '/');
  }
  rel = path.posix.normalize(rel).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return { rel: '' };
  const parts = rel.split('/');
  if (parts.includes('..')) return { why: 'outside the repository' };
  if (parts.some(isDotGit)) return { why: 'inside .git' };
  return { rel };
}

function lstatOrNull(abs) {
  try { return fs.lstatSync(abs); } catch { return null; }
}

// Why a path's PARENT folders make it unsafe to read or write, or null.
// A parent that is a nested repository belongs to that repository; a parent
// that is a symbolic link would send a write (or a read) outside this tree.
function ancestorProblem(top, rel, cache) {
  const parts = rel.split('/');
  let dir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (!cache.has(dir)) {
      const abs = path.join(top, dir);
      const st = lstatOrNull(abs);
      let problem = null;
      if (st?.isSymbolicLink()) problem = 'beyond a symbolic link';
      else if (st && !st.isDirectory()) problem = 'a parent folder is a file';
      else if (st && lstatOrNull(path.join(abs, '.git'))) problem = 'inside a nested repository';
      cache.set(dir, problem);
    }
    if (cache.get(dir)) return cache.get(dir);
  }
  return null;
}

// fast-import paths, C-quoted: quotes, backslashes, control and non-ASCII
// bytes escaped (octal), so no name can break the command stream.
function cQuote(rel) {
  let out = '"';
  for (const byte of Buffer.from(rel, 'utf8')) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

function chunkByLength(items, max = ARGV_CHARS) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const item of items) {
    if (cur.length && len + item.length + 3 > max) { chunks.push(cur); cur = []; len = 0; }
    cur.push(item);
    len += item.length + 3;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

function stampOf(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// Ref ids are lowercase: the Windows files ref backend is case-insensitive.
function sid8Of(sid) {
  return String(sid || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'session';
}

const wtKey = (p) => foldKey(String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''));
const sameWorktree = (a, b) => Boolean(a && b) && wtKey(a) === wtKey(b);

// The git blob id of raw bytes ("blob <len>\0" + bytes).
function blobId(bytes, oidLen) {
  return crypto.createHash(oidLen === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\x00`).update(bytes).digest('hex');
}

// ── repository ────────────────────────────────────────────────────────────────

// One spawn: toplevel, git dir, object format and HEAD. `--verify -q` exits 1
// with the first three lines printed when the branch has no commit yet.
function repoContext(repoRoot, deadline) {
  const dir = path.resolve(String(repoRoot || '.'));
  // statSync follows a junction or a folder symlink, as git itself does: a
  // project opened through one is still that project.
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) return { ok: false, error: `not a folder: ${dir}` };
  const probe = makeGit(dir, deadline)(
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--show-object-format', '--verify', '-q', 'HEAD^{commit}'],
    { allow: [0, 1] },
  );
  const [top, gitDir, commonDir, format, head] = String(probe.out).split('\n').map((s) => s.trim());
  if (!probe.ok || !top || !gitDir) {
    if (probe.timedOut) return { ok: false, error: TOO_LONG };
    return { ok: false, error: /not a git repository/i.test(probe.err) ? `not inside a git working tree: ${dir}` : gitError('rev-parse', probe) };
  }
  return {
    ok: true,
    git: makeGit(top, deadline),
    top,
    gitDir,
    commonDir: commonDir || gitDir,
    oidLen: format === 'sha256' ? 64 : 40,
    head: probe.code === 0 && /^[0-9a-f]{40,64}$/.test(head || '') ? head : null,
  };
}

// Metadata only, so no spawn: the files backend keeps "ref: refs/heads/x" in
// <git dir>/HEAD; reftable leaves a "refs/heads/.invalid" stub there.
function branchOf(gitDir) {
  try {
    const m = /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'));
    return m && m[1].trim() !== '.invalid' ? m[1].trim() : null;
  } catch { return null; }
}

// Git config for every writing call: the user's hooks stay out of it.
const noHooks = (ctx) => ['-c', `core.hooksPath=${path.join(ctx.gitDir, 'klypix-rescue', 'no-hooks')}`];

// A literal pathspec (never a glob). On Windows it is also case-insensitive,
// like the file system: `src/foo.txt` finds the tracked `Src/Foo.TXT`. The
// magic is per path because git refuses the global --literal-pathspecs
// together with --icase-pathspecs. '' (the whole repository) is '.'.
const spec = (rel) => `:(${WIN ? 'literal,icase' : 'literal'})${rel || '.'}`;

// Real-index entries for the given paths: Map rel → { mode, oid }, keyed by
// the index's own spelling. Read-only.
function indexEntries(git, rels) {
  const entries = new Map();
  for (const chunk of chunkByLength(rels.map(spec))) {
    const r = git(['ls-files', '-s', '-z', '--', ...chunk]);
    if (!r.ok) return { error: gitError('ls-files', r) };
    for (const rec of r.out.split(NUL)) {
      const m = /^(\d{6}) ([0-9a-f]+) \d\t([\s\S]+)$/.exec(rec);
      if (m && !entries.has(m[3])) entries.set(m[3], { mode: m[1], oid: m[2] });
    }
  }
  return { entries };
}

// The spelling the disk uses for an existing path (Windows: a request in
// another case opens the same file, but git must be told the real name).
// Falls back to the request for any part it cannot read.
function diskCase(top, rel, cache) {
  const out = [];
  let dir = top;
  for (const part of rel.split('/')) {
    let names = cache.get(dir);
    if (names === undefined) {
      try { names = fs.readdirSync(dir); } catch { names = null; }
      cache.set(dir, names);
    }
    const real = !names || names.includes(part) ? part : names.find((n) => n.toLowerCase() === part.toLowerCase()) || part;
    out.push(real);
    dir = path.join(dir, real);
  }
  return out.join('/');
}

// A link's target as git stores it: '/' separators (Windows keeps '\').
function linkBytes(abs) {
  const raw = fs.readlinkSync(abs, { encoding: 'buffer' });
  return WIN ? Buffer.from(raw.toString('utf8').replace(/\\/g, '/'), 'utf8') : raw;
}

// Which of these UNTRACKED paths .gitignore & co. exclude. --no-index is right
// for untracked paths and necessary: with the index consulted, check-ignore
// treats each input as a glob against tracked files, so an ignored
// `[token].txt` beside a tracked `t.txt` is reported as not ignored. (It also
// rejects --literal-pathspecs, so it is the one pathspec call made without it.)
function ignoredSet(git, rels) {
  const ignored = new Set();
  if (!rels.length) return { ignored };
  const input = rels.map((rel) => (rel.startsWith(':') ? `./${rel}` : rel)).join(NUL) + NUL;
  const r = git(['check-ignore', '--no-index', '-v', '-n', '-z', '--stdin'], { input, allow: [0, 1] });
  if (!r.ok) return { error: gitError('check-ignore', r) };
  // -v -n: four fields per input path, in input order: source, line, pattern, path.
  const f = r.out.split(NUL);
  for (let i = 0; i < rels.length; i++) {
    const pattern = f[i * 4 + 2];
    if (pattern && !pattern.startsWith('!')) ignored.add(rels[i]);
  }
  return { ignored };
}

// ── metadata ──────────────────────────────────────────────────────────────────

function parseMeta(contents) {
  const lines = String(contents || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(META_TAG)) continue;
    try {
      const meta = JSON.parse(lines[i].slice(META_TAG.length));
      return meta && typeof meta === 'object' && meta.v === 1 ? meta : null;
    } catch { return null; }
  }
  return null;
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function entryOf(ref, commit, unixTs, tree, contents) {
  const meta = parseMeta(contents);
  const at = Number.isFinite(meta?.at) ? meta.at : Number(unixTs) * 1000;
  return {
    id: ref.slice(RESCUE_REF_PREFIX.length),
    ref,
    commit,
    tree,
    at: Number.isFinite(at) ? at : 0,
    sid: typeof meta?.sid === 'string' ? meta.sid : null,
    reason: typeof meta?.reason === 'string' ? meta.reason : firstLine(contents),
    paths: strings(meta?.paths),
    deleted: strings(meta?.deleted),
    skipped: Array.isArray(meta?.skipped) ? meta.skipped.filter((s) => s && typeof s.path === 'string') : [],
    worktree: typeof meta?.worktree === 'string' ? meta.worktree : null,
    branch: typeof meta?.branch === 'string' ? meta.branch : null,
    head: typeof meta?.head === 'string' ? meta.head : null,
    known: Boolean(meta),
  };
}

const FER_FORMAT = '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(tree)%00%(contents)%00';

// Each record is the format plus '\n'. A message never holds NUL, so the
// record boundary "NUL + newline" is unambiguous even for multi-line bodies.
function parseRefRecords(out) {
  const entries = [];
  for (const rec of String(out).split(`${NUL}\n`)) {
    const [ref, commit, ts, tree, contents = ''] = rec.replace(/^\n/, '').split(NUL);
    if (ref?.startsWith(RESCUE_REF_PREFIX) && commit) entries.push(entryOf(ref, commit, ts, tree, contents));
  }
  return entries;
}

const newestFirst = (a, b) => (b.at - a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function readAllRescues(ctx) {
  const r = ctx.git(['for-each-ref', FER_FORMAT, 'refs/klypix/rescue'], { maxBuffer: 512 * 1024 * 1024 });
  if (!r.ok) return { error: gitError('for-each-ref', r) };
  return { entries: parseRefRecords(r.out).sort(newestFirst) };
}

const withHere = (entry, top) => ({ ...entry, here: !entry.worktree || sameWorktree(entry.worktree, top) });

// ── create ────────────────────────────────────────────────────────────────────

function fastImportStream({ ref, head, message, date, deletes, files }) {
  const parts = [];
  const add = (x) => parts.push(Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8'));
  const msg = Buffer.from(message, 'utf8');
  add('feature done\n');
  add(`commit ${ref}\nmark :1\nauthor ${IDENT} ${date}\ncommitter ${IDENT} ${date}\ndata ${msg.length}\n`);
  add(msg);
  add('\n');
  if (head) add(`from ${head}\n`);
  for (const rel of deletes) add(`D ${cQuote(rel)}\n`);
  for (const f of files) {
    add(`M ${f.mode} inline ${cQuote(f.rel)}\ndata ${f.bytes.length}\n`);
    add(f.bytes);
    add('\n');
  }
  add('\nget-mark :1\ndone\n');
  return Buffer.concat(parts);
}

// A fatal fast-import leaves .git/fast_import_crash_<pid>; ours is ours to remove.
function removeCrashReport(top, err) {
  const m = /dumping crash report to (.+)$/m.exec(String(err));
  if (!m) return;
  const file = path.resolve(top, m[1].trim());
  if (/^fast_import_crash_\d+$/.test(path.basename(file))) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } }
}

// A fast-import stopped by the time limit leaves its half-written pack as
// objects/pack/tmp_pack_*. Only one that came into being after this import
// started is removed; a file another git still holds open refuses (Windows) or
// is left to that git's own clean-up.
function removeKilledPack(commonDir, since) {
  const dir = path.join(commonDir, 'objects', 'pack');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^tmp_pack_[A-Za-z0-9]+$/.test(name)) continue;
    const st = lstatOrNull(path.join(dir, name));
    const born = st && (st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs);
    if (st?.isFile() && born >= since - 1000) { try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best effort */ } }
  }
}

function readLastNote(file) {
  try {
    const note = JSON.parse(fs.readFileSync(file, 'utf8'));
    return note && typeof note.fingerprint === 'string' ? note : null;
  } catch { return null; }
}

function writeLastNote(file, note) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(note));
    fs.renameSync(tmp, file);
  } catch {
    // Dedup is only an optimisation; a rename refused (a reader on Windows)
    // must not leave the temporary file behind.
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Save the current bytes of `paths` as refs/klypix/rescue/<id>.
 * paths: repository-relative (as `git status --porcelain` prints them) or
 * absolute; '.' is the whole repository. A folder is expanded as `git add --
 * <folder>` would see it: tracked files that differ from HEAD (modified,
 * staged, deleted) and untracked, non-ignored files — what `checkout --`,
 * `restore`, `reset --hard` and `clean -d` would discard. On Windows a path
 * in another case is saved under its real spelling. Budget 2.5 s, kept by
 * leaving out the largest files the time cannot write (listed); never throws.
 * → { ok, id, ref, commit, paths, deleted, skipped:[{path,why}], ms, reused? }
 */
export function createRescue({
  repoRoot, paths, sid, reason, now = Date.now(),
  budgetMs = RESCUE_BUDGET_MS, maxFileBytes = RESCUE_MAX_FILE_BYTES, maxTotalBytes = RESCUE_MAX_TOTAL_BYTES,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(1, Number(budgetMs) || RESCUE_BUDGET_MS);
  const skipped = [];
  const skip = (p, why) => skipped.push({ path: p, why });
  const fail = (error) => ({ ok: false, error, paths: [], deleted: [], skipped, ms: Date.now() - started });
  try {
    const ctx = repoContext(repoRoot, deadline);
    if (!ctx.ok) return fail(ctx.error);
    const { git, top } = ctx;
    // One printable line each: they head the commit message and the CLI rows.
    const oneLine = (s, max) => String(s ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
    const session = oneLine(sid, 160) || 'unknown';
    const why = oneLine(reason, 200) || 'rescue copy';

    // 1. The request, normalised and de-duplicated.
    const seen = new Set();
    const wanted = [];
    for (const raw of Array.isArray(paths) ? paths : paths == null ? [] : [paths]) {
      const r = repoRel(top, raw);
      if (r.rel == null) { skip(String(raw ?? ''), r.why); continue; }
      if (seen.has(foldKey(r.rel))) continue;
      seen.add(foldKey(r.rel));
      wanted.push(r.rel);
    }
    if (!wanted.length) return fail('nothing to rescue');

    // 2. What is on disk now.
    const ancestors = new Map();
    const items = [];             // { rel, kind: 'file'|'link'|'missing', size, exec, expanded, untracked }
    const folders = [];
    const statItem = (rel, st, extra = {}) => {
      if (st.isSymbolicLink()) return { rel, kind: 'link', size: st.size, ...extra };
      if (st.isFile()) return { rel, kind: 'file', size: st.size, exec: (st.mode & 0o111) !== 0, ...extra };
      return null;
    };
    for (const rel of wanted) {
      if (rel === '') { folders.push(rel); continue; }   // the whole repository
      const problem = ancestorProblem(top, rel, ancestors);
      if (problem) {
        // A path under a folder that is now a file is simply gone.
        if (problem === 'a parent folder is a file') items.push({ rel, kind: 'missing' });
        else skip(rel, problem);
        continue;
      }
      const abs = path.join(top, rel);
      let st;
      try { st = fs.lstatSync(abs); } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') items.push({ rel, kind: 'missing' });
        else skip(rel, 'unreadable');
        continue;
      }
      const item = statItem(rel, st);
      if (item) items.push(item);
      else if (st.isDirectory()) {
        if (lstatOrNull(path.join(abs, '.git'))) skip(rel, 'nested repository');
        else folders.push(rel);
      } else skip(rel, 'not a regular file');
    }

    // 3. Folders: what `git add -- <folder>` would take from them, which is
    //    exactly what `checkout -- <folder>`, `restore <folder>`, `reset
    //    --hard` and `clean -d` throw away: every tracked file that differs
    //    from HEAD (modified, staged or deleted) and every untracked,
    //    non-ignored file. One read-only `status` per chunk (optional locks
    //    off, so it never refreshes the real index); ignored content listed.
    const known = new Set(items.map((i) => foldKey(i.rel)));
    for (const chunk of chunkByLength(folders.map(spec))) {
      const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', ...chunk]);
      if (!st.ok) return fail(gitError('status', st));
      for (const rec of st.out.split(NUL)) {
        if (rec.length < 4) continue;
        const xy = rec.slice(0, 2);
        const rel = rec.slice(3);
        if (xy === '!!') continue;
        if (rel.endsWith('/')) { skip(rel.slice(0, -1), 'nested repository'); continue; }
        if (known.has(foldKey(rel))) continue;
        known.add(foldKey(rel));
        const problem = ancestorProblem(top, rel, ancestors);
        if (problem && problem !== 'a parent folder is a file') { skip(rel, problem); continue; }
        const lst = problem ? null : lstatOrNull(path.join(top, rel));
        const untracked = xy === '??';
        const item = lst && statItem(rel, lst, { expanded: true, untracked });
        if (item) items.push(item);
        else if (!lst || (lst.isDirectory() && !untracked)) items.push({ rel, kind: 'missing', expanded: true });
        else skip(rel, 'not a regular file');
      }
      const ignoredHere = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...chunk]);
      if (!ignoredHere.ok) return fail(gitError('ls-files', ignoredHere));
      for (const rel of ignoredHere.out.split(NUL).filter(Boolean)) skip(rel.replace(/\/$/, ''), 'ignored');
    }

    // 4. The real index (read only): modes, submodules, tracked or not. On
    //    Windows also the real spelling of a path asked for in another case
    //    (the index's spelling when tracked, the disk's otherwise), so the
    //    copy, its file list, `show` and `restore` all name the same file.
    const idx = indexEntries(git, [...items.filter((i) => !i.untracked).map((i) => i.rel), ...folders.filter(Boolean)]);
    if (idx.error) return fail(idx.error);
    const tracked = idx.entries;
    if (WIN) {
      const byFold = new Map();
      for (const rel of tracked.keys()) if (!byFold.has(foldKey(rel))) byFold.set(foldKey(rel), rel);
      const dirCache = new Map();
      const canon = (rel) => (tracked.has(rel) ? rel : byFold.get(foldKey(rel)) || diskCase(top, rel, dirCache));
      for (const item of items) if (!item.expanded) item.rel = canon(item.rel);
      for (let i = 0; i < folders.length; i++) if (folders[i]) folders[i] = canon(folders[i]);
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (tracked.get(items[i].rel)?.mode === '160000') { skip(items[i].rel, 'submodule'); items.splice(i, 1); }
    }
    for (const rel of folders) {
      const mode = tracked.get(rel)?.mode;
      if (mode === '160000') { skip(rel, 'submodule'); continue; }
      if (mode && !items.some((i) => i.rel === rel)) items.push({ rel, kind: 'missing' });   // a tracked FILE is now a folder
    }

    // 5. Ignored files are never rescued (V1 decision 5). Only untracked paths
    //    can be ignored; folder expansion already left them out.
    const untracked = items.filter((i) => !i.expanded && !tracked.has(i.rel)).map((i) => i.rel);
    const ign = ignoredSet(git, untracked);
    if (ign.error) return fail(ign.error);
    let keep = items.filter((i) => {
      if (ign.ignored.has(i.rel)) { skip(i.rel, 'ignored'); return false; }
      if (!storable(i.rel, i.kind === 'link')) { skip(i.rel, 'a name git cannot store here'); return false; }
      return true;
    });

    // 6. Size caps: per file, then the total, then what the time left can
    //    write. Each time the LARGEST go first, so a big binary never costs
    //    the small source edits beside it their copy.
    keep = keep.filter((i) => {
      if (i.kind === 'file' && i.size > maxFileBytes) { skip(i.rel, `${mb(i.size)}, over the ${mb(maxFileBytes)} limit`); return false; }
      return true;
    });
    const sizeOf = (i) => (i.kind === 'missing' ? 0 : i.size || 0);
    const dropLargest = (limit, why) => {
      let total = keep.reduce((n, i) => n + sizeOf(i), 0);
      if (total <= limit) return;
      for (const big of keep.filter((i) => sizeOf(i) > 0).sort((a, b) => sizeOf(b) - sizeOf(a))) {
        if (total <= limit) break;
        total -= sizeOf(big);
        big.dropped = true;
        skip(big.rel, `${mb(sizeOf(big))}, ${why}`);
      }
      keep = keep.filter((i) => !i.dropped);
    };
    dropLargest(maxTotalBytes, `over the ${mb(maxTotalBytes)} total`);
    // The kill a timeout sends does not reliably stop git on Windows while it
    // finishes a large pack (measured 2026-10-19: a 2.2 s timeout returned
    // after 3.0-3.8 s; a cold write ran at 6-20 MB/s). So the time limit is
    // kept by never starting more than the time left can write.
    const writable = Math.max(RESCUE_MIN_BYTES, Math.floor(((deadline - Date.now() - RESCUE_RESERVE_MS) / 1000) * RESCUE_BYTES_PER_SEC));
    dropLargest(writable, `too large to save in the ${Math.max(0.1, Math.round((deadline - started) / 100) / 10)} s a check may take`);

    // 7. The raw bytes (a link's bytes are its target, as git stores it).
    const files = [];
    const deletes = [];
    for (const item of keep) {
      if (item.kind === 'missing') { deletes.push(item.rel); continue; }
      const abs = path.join(top, item.rel);
      let bytes;
      try { bytes = item.kind === 'link' ? linkBytes(abs) : fs.readFileSync(abs); } catch {
        skip(item.rel, 'unreadable');
        continue;
      }
      if (item.kind === 'file' && bytes.length > maxFileBytes) { skip(item.rel, `${mb(bytes.length)}, over the ${mb(maxFileBytes)} limit`); continue; }
      let mode;
      if (item.kind === 'link') mode = '120000';
      else {
        const indexMode = tracked.get(item.rel)?.mode;
        // Windows has no exec bit, and core.symlinks=false checks a link out as
        // a file: there, the index's mode is the file's mode (git does the same).
        if (WIN) mode = indexMode === '100755' || indexMode === '120000' ? indexMode : '100644';
        else mode = item.exec ? '100755' : '100644';
      }
      files.push({ rel: item.rel, mode, bytes, oid: blobId(bytes, ctx.oidLen) });
    }
    if (!files.length && !deletes.length) return fail('nothing to rescue');
    if (Date.now() >= deadline) return fail(TOO_LONG);

    const rescuedPaths = [...files.map((f) => f.rel), ...deletes].sort();
    const absentPaths = deletes.slice().sort();
    const branch = branchOf(ctx.gitDir);
    const fingerprintOf = (list) => crypto.createHash('sha1').update(JSON.stringify([
      ctx.head, wtKey(top), list.map((f) => [f.rel, f.mode, f.oid]).sort(), absentPaths,
    ])).digest('hex');

    // 8. ONE look at the refs answers two questions. Is the copy saved moments
    //    ago of this same state still there (an agent retrying the same
    //    command reuses it instead of adding an identical one)? And which of
    //    four candidate names is free? fast-import alone would move an
    //    existing ref whose tip the new commit happens to contain; an
    //    existing ref is never touched.
    const notePath = path.join(ctx.gitDir, 'klypix-rescue', 'last.json');
    const last = readLastNote(notePath);
    const dedup = Boolean(last) && last.fingerprint === fingerprintOf(files) && now - last.at >= 0 && now - last.at < DEDUP_WINDOW_MS
      && /^refs\/klypix\/rescue\/[0-9a-z-]+$/.test(String(last.ref)) && /^[0-9a-f]{40,64}$/.test(String(last.commit));
    const newId = () => `${stampOf(now)}-${sid8Of(session)}-${crypto.randomBytes(2).toString('hex')}`;
    const candidates = [...new Set(Array.from({ length: 4 }, newId))];
    const probe = git(['for-each-ref', '--format=%(refname)%00%(objectname)',
      ...candidates.map((c) => `${RESCUE_REF_PREFIX}${c}`), ...(dedup ? [last.ref] : [])]);
    if (!probe.ok) return fail(gitError('for-each-ref', probe));
    const existing = new Map(probe.out.split('\n').filter(Boolean).map((line) => line.split(NUL)));
    if (dedup && existing.get(last.ref) === last.commit) {
      return { ok: true, id: last.ref.slice(RESCUE_REF_PREFIX.length), ref: last.ref, commit: last.commit, paths: rescuedPaths, deleted: absentPaths, skipped, ms: Date.now() - started, reused: true };
    }
    const free = candidates.filter((c) => !existing.has(`${RESCUE_REF_PREFIX}${c}`));
    if (!free.length) return fail('could not name the rescue (every candidate id was taken)');

    // 9. One fast-import: tree from HEAD + the rescued state, commit, ref.
    const meta = {
      v: 1, sid: session, reason: why, at: now, worktree: top, branch, head: ctx.head,
      paths: rescuedPaths, deleted: absentPaths, skipped: skipped.slice(0, 500),
    };
    const messageOf = () => [
      `KLYPIX rescue: ${why}`,
      '',
      'Uncommitted files KLYPIX saved before a git command could discard them.',
      'List and restore: npx klypix-mcp rescue list',
      '',
      `Session: ${session}`,
      `Files: ${meta.paths.length}${absentPaths.length ? ` (${absentPaths.length} absent)` : ''}${skipped.length ? `; not included: ${skipped.length}` : ''}`,
      '',
      `${META_TAG}${JSON.stringify(meta)}`,
      '',
    ].join('\n');
    const date = `${Math.floor(now / 1000)} +0000`;
    // Never created: whatever git does here, it cannot be the user's index.
    const guardEnv = { GIT_INDEX_FILE: path.join(ctx.gitDir, 'klypix-rescue', `${process.pid}-${crypto.randomBytes(4).toString('hex')}.no-index`) };
    let id = free.shift();
    let commit = '';
    let pending = files;
    for (let attempt = 0; attempt < 4 && !commit; attempt++) {
      const importStarted = Date.now();
      const r = git([...noHooks(ctx), '-c', 'fastimport.unpackLimit=0', '-c', 'pack.compression=1', 'fast-import', '--quiet', '--date-format=raw'], {
        input: fastImportStream({ ref: `${RESCUE_REF_PREFIX}${id}`, head: ctx.head, message: messageOf(), date, deletes, files: pending }),
        env: guardEnv,
        allow: [0, 1],
      });
      const sha = String(r.out).trim().split('\n').pop();
      if (r.ok && /^[0-9a-f]{40,64}$/.test(sha)) {
        if (r.code === 0) { commit = sha; break; }
        // Exit 1: the free name was taken in the moment since the look above
        // and fast-import refused to move it. The commit is written; name it
        // with update-ref and an EMPTY old value, which can only create.
        for (let n = 0; n < 4 && !commit; n++) {
          id = free.length ? free.shift() : newId();
          const named = git([...noHooks(ctx), 'update-ref', '-m', 'klypix rescue', `${RESCUE_REF_PREFIX}${id}`, sha, ''], { env: guardEnv });
          if (named.ok) commit = sha;
          else if (named.timedOut || !/exists/i.test(named.err)) return fail(gitError('update-ref', named));
        }
        if (!commit) return fail('could not name the rescue');
        break;
      }
      removeCrashReport(top, r.err);
      if (r.timedOut) { removeKilledPack(ctx.commonDir, importStarted); return fail(TOO_LONG); }
      // A name this check missed but git refuses: list it, try once more without it.
      const bad = /invalid path '([\s\S]*?)'\s*$/m.exec(r.err)?.[1];
      const culprit = bad && pending.find((f) => f.rel === bad);
      if (!culprit) return fail(gitError('fast-import', r));
      skip(culprit.rel, 'a name git cannot store here');
      pending = pending.filter((f) => f !== culprit);
      rescuedPaths.splice(rescuedPaths.indexOf(culprit.rel), 1);
      meta.paths = rescuedPaths;
      meta.skipped = skipped.slice(0, 500);
      if (!pending.length && !deletes.length) return fail('nothing to rescue');
    }
    if (!commit) return fail('fast-import did not finish');
    const ref = `${RESCUE_REF_PREFIX}${id}`;
    writeLastNote(notePath, { fingerprint: fingerprintOf(pending), id, ref, commit, at: now });
    return { ok: true, id, ref, commit, paths: rescuedPaths, deleted: absentPaths, skipped, ms: Date.now() - started };
  } catch (error) {
    return fail(`rescue failed: ${error?.message || error}`);
  }
}

// ── list / show ───────────────────────────────────────────────────────────────

/**
 * Rescues of this worktree, newest first (allWorktrees: every worktree of the
 * repository — refs are shared between them).
 * → [{ id, ref, commit, at, sid, reason, paths, deleted, skipped, worktree, here, branch, head }]
 * On failure: [] (it never throws; listRescuesResult carries the error).
 */
export function listRescues({ repoRoot, allWorktrees = false } = {}) {
  const res = listRescuesResult({ repoRoot, allWorktrees });
  return res.ok ? res.rescues : [];
}

export function listRescuesResult({ repoRoot, allWorktrees = false } = {}) {
  try {
    const ctx = repoContext(repoRoot, Date.now() + CLI_BUDGET_MS);
    if (!ctx.ok) return { ok: false, error: ctx.error, rescues: [] };
    const all = readAllRescues(ctx);
    if (all.error) return { ok: false, error: all.error, rescues: [] };
    const marked = all.entries.map((e) => withHere(e, ctx.top));
    const rescues = marked.filter((e) => allWorktrees || e.here);
    return { ok: true, top: ctx.top, rescues, elsewhere: marked.filter((e) => !e.here).length };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), rescues: [] };
  }
}

// A number (its place in this worktree's list), a full id, a unique id
// prefix, the full ref, or a commit id prefix.
function pickRescue(all, top, want) {
  const raw = String(want ?? '').trim();
  if (!raw) return { error: 'no rescue id given' };
  const here = all.filter((e) => withHere(e, top).here);
  if (/^\d{1,3}$/.test(raw)) {
    const entry = here[Number(raw) - 1];
    return entry ? { entry } : { error: `there is no rescue number ${raw} in this worktree (it has ${here.length})` };
  }
  const id = (raw.startsWith(RESCUE_REF_PREFIX) ? raw.slice(RESCUE_REF_PREFIX.length) : raw).toLowerCase();
  const exact = all.find((e) => e.id === id);
  if (exact) return { entry: exact };
  const byId = all.filter((e) => e.id.startsWith(id));
  if (byId.length === 1) return { entry: byId[0] };
  if (byId.length > 1) return { error: `"${raw}" matches ${byId.length} rescues (${byId.slice(0, 4).map((e) => e.id).join(', ')}${byId.length > 4 ? ', …' : ''}); give more of the id` };
  const byCommit = /^[0-9a-f]{7,64}$/.test(id) ? all.filter((e) => e.commit.startsWith(id)) : [];
  if (byCommit.length === 1) return { entry: byCommit[0] };
  return { error: `no rescue "${raw}" in this repository` };
}

function resolve(repoRoot, id, deadline) {
  const ctx = repoContext(repoRoot, deadline);
  if (!ctx.ok) return { error: ctx.error };
  const all = readAllRescues(ctx);
  if (all.error) return { error: all.error };
  const picked = pickRescue(all.entries, ctx.top, id);
  if (picked.error) return { error: picked.error };
  return { ctx, entry: withHere(picked.entry, ctx.top) };
}

/**
 * One rescue: its metadata, every rescued file with how it differs from the
 * HEAD it was taken on (line counts ignore CR at end of line), and a short stat.
 */
export function showRescue({ repoRoot, id } = {}) {
  try {
    const found = resolve(repoRoot, id, Date.now() + CLI_BUDGET_MS);
    if (found.error) return { ok: false, error: found.error };
    const { ctx, entry } = found;
    const r = ctx.git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--root', '--raw', '--numstat', '--ignore-cr-at-eol', entry.commit]);
    if (!r.ok) return { ok: false, error: gitError('diff-tree', r) };
    const changes = new Map();
    const f = r.out.split(NUL);
    for (let i = 0; i < f.length; i++) {
      const raw = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(f[i]);
      if (raw) {
        const p = f[++i];
        changes.set(p, { ...(changes.get(p) || {}), status: raw[3] });
        continue;
      }
      const num = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(f[i]);
      if (num) {
        const binary = num[1] === '-';
        changes.set(num[3], { ...(changes.get(num[3]) || {}), added: binary ? 0 : Number(num[1]), removed: binary ? 0 : Number(num[2]), binary });
      }
    }
    const absent = new Set(entry.deleted);
    const CHANGE = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' };
    const files = entry.paths.map((p) => {
      const c = changes.get(p);
      // 'absent': it did not exist when the copy was taken, and HEAD had no such file either.
      const change = absent.has(p) ? (c?.status === 'D' ? 'deleted' : 'absent') : c ? (CHANGE[c.status] || 'modified') : 'same as HEAD';
      return { path: p, change, added: c?.added || 0, removed: c?.removed || 0, binary: Boolean(c?.binary) };
    });
    const stat = {
      files: files.length,
      changed: files.filter((x) => x.change !== 'same as HEAD').length,
      added: files.reduce((n, x) => n + x.added, 0),
      removed: files.reduce((n, x) => n + x.removed, 0),
    };
    return { ok: true, ...entry, files, stat };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// ── restore ───────────────────────────────────────────────────────────────────

// Tree entries of a rescue for the given paths: Map path → { mode, oid, size }.
function treeEntries(git, commit, rels) {
  const out = new Map();
  for (const chunk of chunkByLength(rels)) {
    const r = git(['--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', '--full-tree', commit, '--', ...chunk]);
    if (!r.ok) return { error: gitError('ls-tree', r) };
    for (const rec of r.out.split(NUL)) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(rec);
      if (m && m[2] === 'blob') out.set(m[5], { mode: m[1], oid: m[3], size: Number(m[4]) });
    }
  }
  return { entries: out };
}

// The exact stored bytes of each blob (cat-file --batch prints raw content, no
// smudge or end-of-line conversion), fetched in chunks of about 64 MB.
function readBlobs(git, wanted) {
  const blobs = new Map();
  const queue = [...wanted.entries()];   // [oid, size]
  while (queue.length) {
    const batch = [];
    let bytes = 0;
    while (queue.length && (!batch.length || bytes + queue[0][1] <= 64 * 1024 * 1024)) {
      const [oid, size] = queue.shift();
      batch.push(oid);
      bytes += size;
    }
    const r = git(['cat-file', '--batch'], { input: `${batch.join('\n')}\n`, binary: true, maxBuffer: bytes + batch.length * 160 + 1024 * 1024 });
    if (!r.ok) return { error: gitError('cat-file', r) };
    const buf = r.out;
    let pos = 0;
    for (const oid of batch) {
      const eol = buf.indexOf(0x0a, pos);
      if (eol < 0) break;
      const header = buf.subarray(pos, eol).toString('latin1').split(' ');
      pos = eol + 1;
      if (header[1] === 'missing' || header.length < 3) continue;
      const size = Number(header[2]);
      if (header[0] === oid && header[1] === 'blob') blobs.set(oid, Buffer.from(buf.subarray(pos, pos + size)));
      pos += size + 1;
    }
  }
  return { blobs };
}

// After removing a file, remove the folders it leaves empty, up to (never
// including) the worktree root — what git does when it deletes a file.
function removeEmptyParents(top, abs) {
  const root = path.resolve(top);
  for (let dir = path.dirname(abs); dir.length > root.length && dir.startsWith(root); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { return; }
  }
}

function currentState(abs) {
  const st = lstatOrNull(abs);
  if (!st) return { kind: 'missing' };
  const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  return { kind, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
}

// A link's stored target compared the way git compares it ('/' on Windows).
const sameLink = (abs, bytes) => linkBytes(abs).equals(WIN ? Buffer.from(bytes.toString('utf8').replace(/\\/g, '/'), 'utf8') : bytes);

function matchesRescue(abs, cur, bytes, mode) {
  try {
    if (mode === '120000') {
      if (cur.kind === 'link') return sameLink(abs, bytes);
      // Windows with core.symlinks=false checks a link out as a file holding
      // its target; that file is the link's unchanged form there.
      if (!WIN) return false;
    }
    if (cur.kind !== 'file' || cur.size !== bytes.length) return false;
    if (!WIN && ((cur.mode & 0o111) !== 0) !== (mode === '100755')) return false;
    return fs.readFileSync(abs).equals(bytes);
  } catch { return false; }
}

function writeRescued(abs, bytes, mode, cur) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // A link comes back as a link. On Windows the one exception is git's own:
  // where a link already stands as a plain file (core.symlinks=false), or
  // links cannot be made at all, it is written as that file, never by
  // replacing a real link with one.
  if (mode === '120000' && (!WIN || cur.kind !== 'file')) {
    const target = WIN ? bytes.toString('utf8').replace(/\//g, '\\') : bytes;
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.klypix-restore-${crypto.randomBytes(4).toString('hex')}`);
    let made = false;
    try { fs.symlinkSync(target, tmp); made = true; } catch (error) {
      if (!WIN || cur.kind === 'link' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
    }
    if (made) {
      try {
        if (cur.kind !== 'missing') fs.unlinkSync(abs);
        fs.renameSync(tmp, abs);
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
      }
      return;
    }
  }
  // Replace a link itself; never write through it to wherever it points.
  if (cur.kind === 'link') fs.unlinkSync(abs);
  const exec = mode === '100755';
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.klypix-restore-${crypto.randomBytes(4).toString('hex')}`);
  let renamed = false;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: exec ? 0o777 : 0o666 });
    fs.renameSync(tmp, abs);
    renamed = true;
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    // Windows refuses to rename over a file another program holds open; an
    // in-place write usually still works there.
    if (!['EPERM', 'EACCES', 'EBUSY', 'EXDEV'].includes(error?.code)) throw error;
  }
  if (!renamed) fs.writeFileSync(abs, bytes);
  if (!WIN) {
    const keep = cur.kind === 'file' ? cur.mode & 0o777 : null;
    if (keep != null) fs.chmodSync(abs, exec ? keep | ((keep & 0o444) >> 2) : keep & ~0o111);
    else if (!renamed) fs.chmodSync(abs, exec ? 0o755 : 0o644);
  }
}

/**
 * Write a rescue's bytes back into the working tree (never the index).
 * First saves the CURRENT state of every path it is about to change as a new
 * rescue (backupId), so the restore is itself undoable; a path whose current
 * bytes could not be saved is left exactly as it is.
 * paths: null = everything in the rescue; otherwise rescued paths or folders
 * (repository-relative, or relative to `cwd`).
 * → { ok, restored, deleted, unchanged, skipped, backupId, from }
 */
export function restoreRescue({
  repoRoot, id, paths = null, sid = 'cli', now = Date.now(), cwd = null, allowOtherWorktree = false,
  budgetMs = CLI_BUDGET_MS,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(1, Number(budgetMs) || CLI_BUDGET_MS);
  try {
    const found = resolve(repoRoot, id, deadline);
    if (found.error) return { ok: false, error: found.error };
    const { ctx, entry } = found;
    const { git, top } = ctx;
    if (!entry.here && !allowOtherWorktree) {
      return { ok: false, error: `rescue ${entry.id} was taken in another worktree (${entry.worktree}); restore it there, or pass --other-worktree to write its files here` };
    }
    if (!entry.paths.length) return { ok: false, error: `rescue ${entry.id} lists no files (it was not made by this version of KLYPIX)` };

    // Which rescued paths.
    const skipped = [];
    let targets = entry.paths.slice();
    if (paths != null) {
      const picked = new Set();
      for (const raw of Array.isArray(paths) ? paths : [paths]) {
        // As in every git pathspec, a relative path typed in a subfolder means
        // that subfolder's file first; the repository-relative reading (what
        // `rescue show` prints) is the fallback when that names nothing.
        const forms = [];
        if (cwd && !path.isAbsolute(String(raw))) forms.push(repoRel(top, path.resolve(cwd, String(raw))).rel);
        forms.push(repoRel(top, String(raw)).rel);
        let hit = false;
        for (const form of forms.filter((f) => f != null)) {
          const want = foldKey(form);
          for (const p of entry.paths) {
            const key = foldKey(p);
            if (want === '' || key === want || key.startsWith(`${want}/`)) { picked.add(p); hit = true; }
          }
          if (hit) break;
        }
        if (!hit) skipped.push({ path: String(raw), why: 'not in this rescue' });
      }
      targets = entry.paths.filter((p) => picked.has(p));
    }
    if (!targets.length) return { ok: false, error: 'nothing to restore', skipped };

    // The rescued state of each target.
    const absent = new Set(entry.deleted);
    const listed = treeEntries(git, entry.commit, targets.filter((p) => !absent.has(p)));
    if (listed.error) return { ok: false, error: listed.error };
    const wantBlobs = new Map();
    for (const [, t] of listed.entries) wantBlobs.set(t.oid, t.size);
    const read = readBlobs(git, wantBlobs);
    if (read.error) return { ok: false, error: read.error };

    // Plan every change before touching anything.
    const plan = [];
    const unchanged = [];
    const ancestors = new Map();
    for (const p of targets) {
      const abs = path.join(top, p);
      const problem = ancestorProblem(top, p, ancestors);
      if (problem) {
        // Under a folder that is now a file, an absent path is already absent.
        if (absent.has(p) && problem === 'a parent folder is a file') unchanged.push(p);
        else skipped.push({ path: p, why: `left as it is: ${problem}` });
        continue;
      }
      const cur = currentState(abs);
      if (absent.has(p)) {
        if (cur.kind === 'missing') unchanged.push(p);
        else if (cur.kind === 'file' || cur.kind === 'link') plan.push({ p, abs, op: 'delete', cur });
        else skipped.push({ path: p, why: cur.kind === 'dir' ? 'left as it is: a folder is there now' : 'left as it is: not a regular file now' });
        continue;
      }
      const t = listed.entries.get(p);
      const bytes = t && read.blobs.get(t.oid);
      if (!bytes) { skipped.push({ path: p, why: 'missing from the rescue copy' }); continue; }
      if (cur.kind === 'dir' || cur.kind === 'other') {
        skipped.push({ path: p, why: `left as it is: ${cur.kind === 'dir' ? 'a folder is in the way now' : 'not a regular file now'}` });
        continue;
      }
      if (cur.kind !== 'missing' && matchesRescue(abs, cur, bytes, t.mode)) { unchanged.push(p); continue; }
      plan.push({ p, abs, op: 'write', bytes, mode: t.mode, cur });
    }
    if (!plan.length) {
      return { ok: true, restored: [], deleted: [], unchanged, skipped, backupId: null, from: entry.id, ms: Date.now() - started };
    }

    // Save what is there now. A failed backup stops the whole restore; a backup
    // with nothing it may hold ("nothing to rescue": every such file is ignored
    // now, too large…) only stops the paths whose bytes would be replaced.
    const backup = createRescue({
      repoRoot: top, paths: plan.map((x) => x.p), sid, reason: `before restoring ${entry.id}`, now,
      budgetMs: Math.max(1, deadline - Date.now()),
    });
    if (!backup.ok && backup.error !== 'nothing to rescue') {
      return { ok: false, error: `could not save the current files first (${backup.error}); nothing was changed`, skipped: [...skipped, ...backup.skipped] };
    }
    const saved = new Set(backup.ok ? backup.paths : []);
    const backupWhy = new Map(backup.skipped.map((s) => [s.path, s.why]));

    const restored = [];
    const removed = [];
    for (const step of plan) {
      if (!saved.has(step.p) && step.cur.kind !== 'missing') {
        skipped.push({ path: step.p, why: `left as it is: its current bytes could not be saved first (${backupWhy.get(step.p) || 'not saved'})` });
        continue;
      }
      // Changed between the backup and now: those bytes are in no copy.
      const again = currentState(step.abs);
      if (again.kind !== step.cur.kind || again.size !== step.cur.size || again.mtimeMs !== step.cur.mtimeMs) {
        skipped.push({ path: step.p, why: 'left as it is: it changed while restoring' });
        continue;
      }
      try {
        if (step.op === 'delete') {
          fs.unlinkSync(step.abs);
          removeEmptyParents(top, step.abs);
          removed.push(step.p);
        } else writeRescued(step.abs, step.bytes, step.mode, step.cur);
        restored.push(step.p);
      } catch (error) {
        skipped.push({ path: step.p, why: `could not ${step.op === 'delete' ? 'remove' : 'write'} it (${error?.code || error?.message || error})` });
      }
    }
    return { ok: true, restored, deleted: removed, unchanged, skipped, backupId: backup.ok ? backup.id : null, from: entry.id, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: `restore failed: ${error?.message || error}` };
  }
}

// ── prune ─────────────────────────────────────────────────────────────────────

/**
 * Delete rescues older than maxAgeMs, but always keep the newest `keep` of
 * each worktree — a recent copy is never pruned, however many there are.
 * One `update-ref --stdin -z` transaction with each ref's old id, so a ref
 * re-pointed meanwhile is not deleted. → { ok, deleted, kept }
 */
export function pruneRescues({
  repoRoot, keep = RESCUE_KEEP, maxAgeMs = RESCUE_MAX_AGE_MS, now = Date.now(), dryRun = false,
} = {}) {
  try {
    const ctx = repoContext(repoRoot, Date.now() + CLI_BUDGET_MS);
    if (!ctx.ok) return { ok: false, error: ctx.error, deleted: [], kept: 0 };
    const keepN = Math.max(0, Math.floor(Number.isFinite(Number(keep)) ? Number(keep) : RESCUE_KEEP));
    const maxAge = Math.max(0, Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : RESCUE_MAX_AGE_MS);
    for (let attempt = 0; attempt < 2; attempt++) {
      const all = readAllRescues(ctx);
      if (all.error) return { ok: false, error: all.error, deleted: [], kept: 0 };
      const groups = new Map();
      for (const e of all.entries) {
        const key = e.worktree ? wtKey(e.worktree) : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      const victims = [];
      for (const list of groups.values()) list.forEach((e, i) => { if (i >= keepN && now - e.at > maxAge) victims.push(e); });
      const kept = all.entries.length - victims.length;
      if (!victims.length) return { ok: true, deleted: [], kept };
      if (dryRun) return { ok: true, deleted: [], wouldDelete: victims.map((e) => e.id), kept };
      const input = victims.map((e) => `delete ${e.ref}${NUL}${e.commit}${NUL}`).join('');
      const r = ctx.git([...noHooks(ctx), 'update-ref', '--stdin', '-z'], { input });
      if (r.ok) return { ok: true, deleted: victims.map((e) => e.id), kept };
      if (r.timedOut || attempt) return { ok: false, error: gitError('update-ref', r), deleted: [], kept: all.entries.length };
      // Another prune or a re-point raced this one: read again, once.
    }
    return { ok: false, error: 'prune did not settle', deleted: [], kept: 0 };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), deleted: [], kept: 0 };
  }
}

// ── wording helpers for the hook's messages ───────────────────────────────────

export function rescueRestoreCommand(id) {
  return `npx klypix-mcp rescue restore ${id}`;
}

/** "not included: secret.env (ignored), big.bin (63 MB, over the 50 MB limit)" */
export function notIncludedText(skipped, max = 6) {
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length) return '';
  const shown = list.slice(0, max).map((s) => `${s.path} (${s.why})`);
  return `not included: ${shown.join(', ')}${list.length > max ? `, +${list.length - max} more` : ''}`;
}
