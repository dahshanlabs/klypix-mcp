// "Whose is this?" edit ledger (src/whose-ledger.mjs, klypix-mcp 1.103.0).
//
// Before a risky git command KLYPIX has to say whose uncommitted edit a dirty
// file still holds. The ledger answers from bytes, not from clocks: a session
// owns a dirty file only while the file still hashes to what that session's
// newest recorded edit left, and a `clean` record retires everything before it.
//
// The contract under test (E:/tmp/whose-design/V1_SCOPE.md):
//   L1  hashBytes gives git's own blob ids: `git hash-object --no-filters`,
//       autocrlf=false and --stdin for the raw bytes; `git hash-object` under
//       core.autocrlf=true for CRLF text (blobLf); git's `text` conversion on
//       every .txt sample and on 300 KiB of random text;
//   L2  ledgerFileFor shares the lane's <sha16> (laneFileFor is reused, not
//       re-derived) and is a non-.json sibling of the lane;
//   L3  fileKey: repo-relative, '/' separators, NFC, lowercased on win32 only;
//       null outside the repo; MSYS, \\?\ and junction/symlink spellings;
//   L4  recordEdit / recordClean append exactly the V1 record shapes, find the
//       repo root when none is given (the BRAIN's repo: a sibling repo's or a
//       nested worktree's file never collides with a path here), and never throw;
//   L5  readLedger: TTL, oldest first with stable ties, torn and garbage
//       lines, a torn tail followed by a new append, Windows case folding;
//   L6  several processes appending at once: nothing lost, nothing torn, and a
//       reader polling meanwhile never fails;
//   L7  ownership: every class, clean resets, only each session's newest
//       record counts, adoption, the same-window label, deletes, line-ending
//       rewrites, unknown hashes, case-insensitive ids and Windows keys;
//   L8  rotation keeps the newest record per (key, session) and the latest
//       clean per key, drops expired, retired and garbage lines, keeps a newer
//       build's records, leaves ownership() unchanged on random ledgers,
//       carries over appends that race it (also under real concurrent load),
//       backs off when another rotation won or holds the rotation lock (a
//       stale lock is taken over), and does not rewrite a
//       legitimately large ledger on every call;
//   L9  end to end in a real repo, including the safety-B3 cases: a discarded
//       edit is never billed for the next change nobody recorded.
//
// Run:  node test/whose-ledger.mjs        (exit 0 = pass, 1 = fail)
// Writes only under a fresh os.tmpdir() folder; every call gets that folder as
// `home`, so the real ~/.claude is never read or written.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIRECTORY_FRESH_MS, laneFileFor } from '../src/agent-presence.mjs';
import {
  LEDGER_HASH_MAX_BYTES,
  LEDGER_KEY_MAX,
  LEDGER_SID_MAX,
  LEDGER_TTL_MS,
  SAME_HOST_LABEL,
  fileKey,
  findRepoRoot,
  hashBytes,
  ledgerFileFor,
  ownership,
  readLedger,
  recordClean,
  recordEdit,
  rotateLedgerIfLarge,
} from '../src/whose-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'src', 'whose-ledger.mjs')).href;
const win = process.platform === 'win32';
const fold = (key) => (win ? key.toLowerCase() : key);
let checks = 0;
const ok = (condition, label) => { checks++; assert.ok(condition, label); console.log(`[ok] ${label}`); };
const same = (actual, expected, label) => { checks++; assert.deepStrictEqual(actual, expected, label); console.log(`[ok] ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-whose-ledger-'));
const home = path.join(root, 'home');
const emptyGitConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyGitConfig, '');
// The machine's own git config (here: core.autocrlf=true system-wide) must not
// decide what the parity checks see; each check sets what it needs.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const gitRaw = (cwd, args, input) => execFileSync('git', args, { cwd, input, env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const git = (cwd, args, input) => gitRaw(cwd, args, input).trim();
const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['config', 'user.email', 'ledger-test@example.invalid']);
  git(dir, ['config', 'user.name', 'Ledger Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
};
const makeBrain = (dir, name = 'brain.klypix') => {
  fs.mkdirSync(dir, { recursive: true });
  const brainPath = path.join(dir, name);
  fs.writeFileSync(brainPath, 'fixture');
  return brainPath;
};
// Deterministic pseudo-random numbers (mulberry32).
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const countRecords = (map) => [...map.values()].reduce((n, list) => n + list.length, 0);
const tmpLeft = (brainPath) => fs.readdirSync(path.dirname(ledgerFileFor(brainPath, home))).filter((name) => name.includes('.tmp-'));

// Records and ownership questions, built by hand for the pure checks.
const H = (content) => hashBytes(content);
const ed = (sid, at, content, client = 'codex', key = 'f.ts') => {
  const h = content === null ? { blob: null, blobLf: null } : H(content);
  return { v: 1, sid, client, key, at, blob: h.blob, blobLf: h.blobLf };
};
const cl = (at, key = 'f.ts') => ({ v: 1, kind: 'clean', key, at });
const who = (records, hash, ids = {}) => ownership({ ledger: new Map([['f.ts', records]]), dirty: [{ key: 'f.ts', hash }], selfIds: ['me'], ...ids }).get('f.ts');
const sids = (list) => list.map((o) => o.sid).join(',');

// Child processes that append through the real module at the same moment.
const CHILD = [
  `const { recordEdit, recordClean } = await import(${JSON.stringify(MODULE_URL)});`,
  'const job = JSON.parse(process.env.WHOSE_LEDGER_JOB);',
  'while (Date.now() < job.startAt) { /* start together */ }',
  'let wrote = 0;',
  'let at = 0;',
  'const last = {};',
  'for (let i = 0; i < job.count; i++) {',
  '  at = Math.max(Date.now(), at + 1);',
  "  const name = job.cycle ? 'load/' + job.sid + '-' + (i % job.cycle) + '.ts' : null;",
  '  const absPath = name ? job.repo + "/" + name : job.files[i % job.files.length];',
  "  if (recordEdit({ brainPath: job.brainPath, home: job.home, sid: job.sid, client: 'codex', repoRoot: job.repo, absPath, now: at })) { wrote++; if (name) last[name] = at; }",
  '  if (job.pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, job.pauseMs);',
  '}',
  'for (const key of job.cleanKeys || []) if (recordClean({ brainPath: job.brainPath, home: job.home, key, now: Date.now() })) wrote++;',
  'process.stdout.write(JSON.stringify({ wrote, last }));',
].join('\n');

function runChildren(jobs) {
  return Promise.all(jobs.map((job) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), WHOSE_LEDGER_JOB: JSON.stringify(job) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${job.sid} exited ${code}: ${err.slice(0, 600)}`))));
  })));
}

// Run `tick` again and again until `promise` settles; return its result.
async function whileRunning(promise, tick) {
  let done = false;
  const settled = promise.finally(() => { done = true; });
  settled.catch(() => {});
  while (!done) {
    tick();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return settled;
}

try {
  // -- L1: hashBytes gives git's own blob ids ----------------------------------------
  {
    ok(hashBytes('').blob === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', "L1 the empty file has git's well-known empty blob id");
    ok(hashBytes('hello\n').blob === 'ce013625030ba8dba906f756967f9e9ca394464a', 'L1 "hello\\n" has the blob id the git book prints');
    const bytes = Buffer.from('a\r\nb\r\n');
    const backing = new Uint8Array(bytes.length + 2);
    backing.set(bytes, 2);
    same(hashBytes(backing.subarray(2)), hashBytes(bytes), 'L1 a Uint8Array view with a byte offset hashes like the Buffer');
    same(hashBytes(backing.buffer.slice(2)), hashBytes(bytes), 'L1 an ArrayBuffer hashes like the Buffer');
    same(hashBytes('a\r\nb\r\n'), hashBytes(bytes), 'L1 a string hashes as its UTF-8 bytes');
    let threw = 0;
    for (const bad of [null, undefined, 42, {}]) {
      try { hashBytes(bad); } catch (error) { if (error instanceof TypeError) threw++; }
    }
    ok(threw === 4, 'L1 input that is not bytes throws a TypeError (never a null, which would read as "deleted")');

    const repo = gitInit(path.join(root, 'hash-repo'));
    const samples = [
      { name: 'lf.txt', bytes: 'alpha\nbeta\n', text: true },
      { name: 'crlf.txt', bytes: 'alpha\r\nbeta\r\n', text: true },
      { name: 'mixed.txt', bytes: 'one\r\ntwo\nthree\r\n', text: true },
      { name: 'unicode.txt', bytes: 'caf\u00e9 \u2014 \u0645\u0644\u0641\r\n\u65e5\u672c\u8a9e\r\n', text: true },
      { name: 'tail.txt', bytes: 'x\r\ny', text: true },
      { name: 'empty.txt', bytes: '', text: true },
      { name: 'lone-cr.txt', bytes: 'a\rb\r\n', text: false },
      { name: 'cr-cr-lf.txt', bytes: 'a\r\r\nb\r\n', text: false },
      { name: 'binary.bin', bytes: Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff, 0x0d, 0x0a, 0x0d]), text: false },
    ];
    for (const sample of samples) {
      const content = Buffer.isBuffer(sample.bytes) ? sample.bytes : Buffer.from(sample.bytes, 'utf8');
      fs.writeFileSync(path.join(repo, sample.name), content);
      const h = hashBytes(content);
      const raw = git(repo, ['hash-object', '--no-filters', sample.name]);
      const noConversion = git(repo, ['-c', 'core.autocrlf=false', 'hash-object', sample.name]);
      const stdin = git(repo, ['hash-object', '--stdin'], content);
      const autocrlf = git(repo, ['-c', 'core.autocrlf=true', 'hash-object', sample.name]);
      ok(h.blob === raw && h.blob === noConversion && h.blob === stdin,
        `L1 ${sample.name}: blob = git hash-object --no-filters = autocrlf=false = --stdin (${raw.slice(0, 12)})`);
      const hasCrlf = content.includes(Buffer.from('\r\n'));
      ok(hasCrlf ? h.blobLf !== h.blob : h.blobLf === h.blob, `L1 ${sample.name}: blobLf ${hasCrlf ? 'differs from' : 'equals'} blob`);
      if (sample.text) ok(autocrlf === h.blobLf, `L1 ${sample.name}: git hash-object under core.autocrlf=true = blobLf`);
      else ok(autocrlf === h.blob, `L1 ${sample.name}: git leaves a file with a lone CR or a NUL alone under autocrlf, so it is blob`);
    }
    // With an explicit `text` attribute git removes exactly the CR before each LF.
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text\n');
    for (const sample of samples.filter((s) => s.name.endsWith('.txt'))) {
      ok(git(repo, ['hash-object', sample.name]) === hashBytes(Buffer.from(sample.bytes, 'utf8')).blobLf,
        `L1 ${sample.name}: blobLf = git's \`text\` conversion (lone CRs kept)`);
    }
    const rnd = prng(20261016);
    const parts = [];
    let size = 0;
    while (size < 300 * 1024) {
      const r = rnd();
      const piece = r < 0.08 ? '\r\n' : r < 0.12 ? '\n' : r < 0.14 ? '\r' : r < 0.15 ? '\r\r\n'
        : String.fromCharCode(0x20 + Math.floor(rnd() * 95)).repeat(1 + Math.floor(rnd() * 24));
      parts.push(piece);
      size += piece.length;
    }
    const big = Buffer.from(parts.join(''), 'latin1');
    const hb = hashBytes(big);
    ok(git(repo, ['hash-object', '--stdin'], big) === hb.blob && git(repo, ['hash-object', '--stdin', '--path=random.txt'], big) === hb.blobLf,
      `L1 ${big.length} random bytes of CR/LF/CRLF text: blob and blobLf both equal git's`);
  }

  // -- L2: the ledger is the lane's sidecar -----------------------------------------
  {
    const project = path.join(root, 'Project');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    const brainPath = makeBrain(project);
    const lane = laneFileFor(brainPath, home);
    const ledger = ledgerFileFor(brainPath, home);
    ok(ledger === lane.replace(/\.json$/, '.edits'), 'L2 the ledger is the lane file with .json replaced by .edits');
    ok(path.dirname(ledger) === path.join(home, '.claude', 'project-brain', 'sessions') && /^[0-9a-f]{16}\.edits$/.test(path.basename(ledger)),
      'L2 it lives in project-brain/sessions as <sha16>.edits (not *.json, so lane globs never see it)');
    ok(ledgerFileFor(brainPath) === laneFileFor(brainPath).replace(/\.json$/, '.edits'), 'L2 home defaults where the lane defaults (path only; nothing written)');
    ok(ledgerFileFor(`${project}${path.sep}sub${path.sep}..${path.sep}brain.klypix`, home) === ledger, 'L2 another spelling of the same brain path shares the ledger');
    if (win) ok(ledgerFileFor(brainPath.toUpperCase(), home) === ledger, 'L2 Windows: a differently cased path to the same brain shares the ledger');
    ok([ledgerFileFor(null, home), ledgerFileFor('', home), ledgerFileFor(42, home)].every((v) => v === null), 'L2 no brain, no ledger (null, never a throw)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'whose-ledger.mjs'), 'utf8').replace(/\r/g, '');
    ok(/import\s*\{[^}]*\blaneFileFor\b[^}]*\}\s*from\s*'\.\/agent-presence\.mjs'/.test(src) && !/\.slice\(0,\s*16\)/.test(src) && !/normBrainPath/.test(src),
      'L2 the <sha16> comes from agent-presence laneFileFor, not a second copy of the hash');
    ok(LEDGER_TTL_MS === DIRECTORY_FRESH_MS, "L2 a record lives as long as a lane directory entry (14 days)");
  }

  // -- L3: fileKey ----------------------------------------------------------------
  {
    const repo = path.join(root, 'KeyRepo');
    const tax = path.join(repo, 'Src', 'Deep', 'Tax.ts');
    fs.mkdirSync(path.dirname(tax), { recursive: true });
    fs.writeFileSync(tax, 'export const rate = 0.2;\n');
    const key = fold('Src/Deep/Tax.ts');
    ok(fileKey(repo, tax) === key, `L3 an absolute path becomes a repo-relative key with '/' separators (${key})`);
    ok(fileKey(repo, 'Src/Deep/Tax.ts') === key && fileKey(repo, ['.', 'Src', 'Deep', '..', 'Deep', 'Tax.ts'].join(path.sep)) === key,
      'L3 a relative path is relative to the repo root (as git status paths are), normalized');
    ok(fileKey(repo, repo) === null && fileKey(repo, `${repo}${path.sep}`) === null, 'L3 the repo root itself is not a file');
    ok(fileKey(repo, path.join(root, 'KeyRepo2', 'x.ts')) === null, 'L3 a sibling directory that shares the name prefix is outside');
    ok(fileKey(repo, path.join(repo, '..', 'x.ts')) === null && fileKey(repo, `..${path.sep}x.ts`) === null && fileKey(repo, '..') === null,
      'L3 paths that climb out of the repo are outside (null)');
    ok(fileKey(repo, path.join(repo, '..dotdot.txt')) === fold('..dotdot.txt'), 'L3 a file whose name starts with ".." is inside');
    ok([fileKey(null, tax), fileKey('', tax), fileKey(repo, ''), fileKey(repo, null), fileKey(repo, 42), fileKey(repo, 'a\0b')].every((v) => v === null),
      'L3 bad arguments give null, never a throw');
    if (win) {
      ok(fileKey(repo.toUpperCase(), tax.toLowerCase()) === 'src/deep/tax.ts', 'L3 Windows: case differences do not matter, and the key is lowercase');
      ok(fileKey(repo, tax.replace(/\\/g, '/')) === 'src/deep/tax.ts', 'L3 Windows: forward slashes work');
      const msys = `/${tax[0].toLowerCase()}${tax.slice(2).replace(/\\/g, '/')}`;
      ok(fileKey(repo, msys) === 'src/deep/tax.ts', 'L3 Windows: a Git Bash (MSYS) path works');
    }
    const W = { platform: 'win32' };
    ok(fileKey('C:\\Work\\Repo', 'c:\\WORK\\repo\\SRC\\Tax.TS', W) === 'src/tax.ts', 'L3 win32 rules (on any OS): case-insensitive, lowercased');
    ok(fileKey('C:\\Work\\Repo', 'C:/Work/Repo/src/a.ts', W) === 'src/a.ts', 'L3 win32 rules: forward slashes');
    ok(fileKey('C:\\Work\\Repo', '/c/Work/Repo/src/a.ts', W) === 'src/a.ts' && fileKey('C:\\Work\\Repo', '/cygdrive/c/Work/Repo/src/a.ts', W) === 'src/a.ts',
      'L3 win32 rules: MSYS and Cygwin drive paths');
    ok(fileKey('C:\\Work\\Repo', '\\\\?\\C:\\Work\\Repo\\src\\a.ts', W) === 'src/a.ts' && fileKey('\\\\server\\share\\repo', '\\\\?\\UNC\\server\\share\\repo\\a.ts', W) === 'a.ts',
      'L3 win32 rules: the \\\\?\\ long-path prefix, local and UNC');
    ok(fileKey('C:\\Work\\Repo', 'D:\\Work\\Repo\\a.ts', W) === null && fileKey('C:\\Work\\Repo', 'C:\\Work\\Repo2\\a.ts', W) === null,
      'L3 win32 rules: another drive, or a prefix sibling, is outside');
    const X = { platform: 'linux' };
    ok(fileKey('/work/repo', '/work/repo/Src/A.ts', X) === 'Src/A.ts', 'L3 POSIX rules: case is kept');
    ok(fileKey('/work/repo', '/work/Repo/Src/A.ts', X) === null, 'L3 POSIX rules: a differently cased root is another directory');
    ok(fileKey('/work/repo', '/work/repo/a\\b.txt', X) === 'a\\b.txt', 'L3 POSIX rules: a backslash is part of the name');
    ok(fileKey('/r', '/r/cafe\u0301.txt', X) === 'caf\u00e9.txt' && fileKey('C:\\r', 'C:\\r\\CAFE\u0301.txt', W) === 'caf\u00e9.txt',
      'L3 keys are NFC on every platform (a decomposed name matches its composed spelling)');
    ok(fileKey('/work/repo', '/work/repo/My Docs/na\u00efve \u0444\u0430\u0439\u043b.md', X) === 'My Docs/na\u00efve \u0444\u0430\u0439\u043b.md',
      'L3 spaces and non-ASCII names are kept');
    const link = path.join(root, 'KeyLink');
    let linked = false;
    try { fs.symlinkSync(repo, link, win ? 'junction' : 'dir'); linked = true; }
    catch { console.log('[skip] L3 junction/symlink cases: this machine cannot create a link'); }
    if (linked) {
      ok(fileKey(link, tax) === key, 'L3 a repo root reached through a junction/symlink still owns its files');
      ok(fileKey(repo, path.join(link, 'Src', 'Deep', 'Tax.ts')) === key, 'L3 a file reached through a junction/symlink gets the same key');
      ok(fileKey(repo, path.join(link, 'Src', 'Gone.ts')) === fold('Src/Gone.ts'), 'L3 ... even when that file no longer exists');
    }
  }

  // -- L4: recordEdit / recordClean ---------------------------------------------------
  {
    const repo = gitInit(path.join(root, 'EditRepo'));
    const brainPath = makeBrain(repo);
    const file = ledgerFileFor(brainPath, home);
    const tax = path.join(repo, 'Src', 'Tax.ts');
    fs.mkdirSync(path.dirname(tax), { recursive: true });
    fs.writeFileSync(tax, 'export const rate = 0.2;\r\nexport const cap = 9;\r\n');
    const T = 2_000_000_000_000;
    const rec = recordEdit({ brainPath, home, sid: 'codex-7f3a91c2', client: 'codex', repoRoot: repo, absPath: tax, now: T });
    const h = hashBytes(fs.readFileSync(tax));
    same(rec, { v: 1, sid: 'codex-7f3a91c2', client: 'codex', key: fold('Src/Tax.ts'), at: T, blob: h.blob, blobLf: h.blobLf },
      'L4 recordEdit returns the V1 record {v,sid,client,key,at,blob,blobLf}');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    ok(lines.length === 2 && lines[1] === '' && lines[0] === JSON.stringify(rec), 'L4 ... and appends it as exactly one JSON line');
    same(Object.keys(JSON.parse(lines[0])), ['v', 'sid', 'client', 'key', 'at', 'blob', 'blobLf'], 'L4 the stored line has exactly the V1 fields');
    ok(rec.blob === git(repo, ['hash-object', '--no-filters', 'Src/Tax.ts']) && rec.blobLf === git(repo, ['-c', 'core.autocrlf=true', 'hash-object', 'Src/Tax.ts']),
      "L4 the hashes are git's blob ids of the bytes the edit left (raw, and CRLF→LF)");

    const sizeBefore = fs.statSync(file).size;
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'x');
    ok(recordEdit({ brainPath, home, sid: 's', client: 'codex', repoRoot: repo, absPath: outside, now: T }) === null && fs.statSync(file).size === sizeBefore,
      'L4 a path outside the repo is not recorded (null, nothing written)');
    ok(recordEdit({ brainPath, home, sid: 's', client: 'codex', repoRoot: repo, absPath: path.join(repo, '.git', 'config'), now: T }) === null
      && recordEdit({ brainPath, home, sid: 's', client: 'codex', repoRoot: repo, absPath: path.join(repo, 'Src'), now: T }) === null,
      'L4 .git internals and directories are not recorded');
    const bad = [undefined, {}, { brainPath }, { brainPath, home, sid: '', absPath: tax }, { brainPath, home, sid: 'x'.repeat(LEDGER_SID_MAX + 1), absPath: tax },
      { brainPath, home, sid: 7, absPath: tax }, { brainPath, home, sid: 's', absPath: null }, { brainPath, home, sid: 's', absPath: tax, now: 'soon' },
      { brainPath: null, home, sid: 's', absPath: tax }];
    ok(bad.every((args) => recordEdit(args) === null) && fs.statSync(file).size === sizeBefore, 'L4 bad arguments give null and write nothing (never a throw)');
    ok(recordEdit({ brainPath, home, sid: 's', client: 'codex', repoRoot: repo, absPath: path.join(repo, 'd'.repeat(LEDGER_KEY_MAX + 10)), now: T }) === null,
      'L4 a key over the length cap is dropped, never cut');
    const fileHome = path.join(root, 'home-is-a-file');
    fs.writeFileSync(fileHome, '');
    ok(recordEdit({ brainPath, home: fileHome, sid: 's', client: 'codex', repoRoot: repo, absPath: tax, now: T }) === null, 'L4 a ledger that cannot be written gives null, never a throw');

    const gone = recordEdit({ brainPath, home, sid: 'codex-7f3a91c2', client: 'codex', repoRoot: repo, absPath: path.join(repo, 'Src', 'Gone.ts'), now: T + 1 });
    ok(gone && gone.blob === null && gone.blobLf === null && gone.key === fold('Src/Gone.ts'), 'L4 a file missing after the edit is recorded with null hashes');
    const big = path.join(repo, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(4096, 1));
    const capped = recordEdit({ brainPath, home, sid: 'codex-7f3a91c2', client: 'codex', repoRoot: repo, absPath: big, now: T + 2, maxHashBytes: 1024 });
    ok(capped && capped.blob === null && LEDGER_HASH_MAX_BYTES === 8 * 1024 * 1024, 'L4 a file over the hash cap (default 8 MiB) is recorded without a hash');
    const odd = path.join(repo, 'My Docs', 'na\u00efve \u0444\u0430\u0439\u043b [v2].md');
    fs.mkdirSync(path.dirname(odd), { recursive: true });
    fs.writeFileSync(odd, '# notes\n');
    const oddRec = recordEdit({ brainPath, home, sid: 'me', client: 'claude-code', repoRoot: repo, absPath: odd, now: T + 3 });
    ok(oddRec && oddRec.key === fold('My Docs/na\u00efve \u0444\u0430\u0439\u043b [v2].md') && oddRec.blob === hashBytes(fs.readFileSync(odd)).blob,
      'L4 a path with spaces, brackets and non-ASCII letters is recorded');

    const nested = makeBrain(path.join(repo, 'pkg'));
    const viaGit = recordEdit({ brainPath: nested, home, sid: 'me', client: 'claude-code', absPath: path.join(repo, 'pkg', 'x.ts'), now: T + 4 });
    ok(viaGit && viaGit.key === fold('pkg/x.ts'), 'L4 without repoRoot the repo root is found by walking up to .git (keys stay repo-relative under a nested brain)');
    ok(findRepoRoot(path.join(repo, 'pkg', 'x.ts')) === repo && findRepoRoot(repo) === repo, 'L4 findRepoRoot: the nearest ancestor holding .git');

    // Without repoRoot the root is the BRAIN's repo, never the edited file's:
    // a sibling repo's README.md must not land here as 'readme.md', and a
    // nested worktree's src/a.ts must not pose as this repo's src/a.ts.
    const crossP = gitInit(path.join(root, 'CrossP'));
    const crossQ = gitInit(path.join(root, 'CrossQ'));
    const crossBrain = makeBrain(crossP);
    fs.writeFileSync(path.join(crossQ, 'README.md'), 'sibling readme\n');
    fs.writeFileSync(path.join(crossQ, 'LICENSE'), 'MIT 2026\n');
    const crossFile = ledgerFileFor(crossBrain, home);
    const sibling = recordEdit({ brainPath: crossBrain, home, sid: 'peer-O', client: 'claude-code', absPath: path.join(crossQ, 'README.md'), now: T + 5 });
    const siblingLicense = recordEdit({ brainPath: crossBrain, home, sid: 'peer-O', client: 'claude-code', absPath: path.join(crossQ, 'LICENSE'), now: T + 6 });
    ok(sibling === null && siblingLicense === null && !fs.existsSync(crossFile), "L4 without repoRoot an edit in a sibling repo is not recorded in this brain's ledger");
    fs.writeFileSync(path.join(crossP, 'LICENSE'), 'MIT 2026\n');
    const crossOwn = ownership({
      ledger: readLedger({ brainPath: crossBrain, home, now: T + 10 }),
      dirty: [{ key: 'README.md', hash: null }, { key: 'LICENSE', hash: hashBytes(fs.readFileSync(path.join(crossP, 'LICENSE'))) }],
      selfIds: ['self-S'],
    });
    ok(crossOwn.get('README.md').cls === 'UNATTRIBUTED' && crossOwn.get('LICENSE').cls === 'UNATTRIBUTED',
      'L4 ... so files here with the same name or the same bytes are never FOREIGN to a session that only touched the sibling');
    const nestedWt = path.join(crossP, '.worktrees', 'feat');
    fs.mkdirSync(path.join(nestedWt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(nestedWt, '.git'), 'gitdir: elsewhere\n');
    fs.writeFileSync(path.join(nestedWt, 'src', 'a.ts'), 'x\n');
    const inWt = recordEdit({ brainPath: crossBrain, home, sid: 'peer-O', client: 'claude-code', absPath: path.join(nestedWt, 'src', 'a.ts'), now: T + 7 });
    ok(inWt && inWt.key === fold('.worktrees/feat/src/a.ts'), "L4 without repoRoot a nested worktree's file keeps its .worktrees/ prefix (no collision with src/a.ts)");
    const subBrain = makeBrain(path.join(crossP, 'docs'));
    fs.writeFileSync(path.join(crossP, 'top.ts'), 'x\n');
    const fromSub = recordEdit({ brainPath: subBrain, home, sid: 'me', client: 'claude-code', absPath: path.join(crossP, 'top.ts'), now: T + 8 });
    ok(fromSub && fromSub.key === 'top.ts', "L4 ... and a brain in a subfolder still keys from its repo's top level");
    const wt = path.join(root, 'Worktree');
    fs.mkdirSync(path.join(wt, 'a'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
    ok(findRepoRoot(path.join(wt, 'a', 'b.ts')) === wt, "L4 findRepoRoot: a linked worktree's .git file counts");
    ok(findRepoRoot(path.join(root, 'plain', 'x.ts')) === findRepoRoot(root) && findRepoRoot(null) === null, 'L4 findRepoRoot walks past directories without .git');

    const c1 = recordClean({ brainPath, home, key: 'Src/Tax.ts', now: T + 10 });
    same(c1, { v: 1, kind: 'clean', key: fold('Src/Tax.ts'), at: T + 10 }, 'L4 recordClean returns {v:1,kind:"clean",key,at}');
    const lastLine = fs.readFileSync(file, 'utf8').trimEnd().split('\n').pop();
    same(Object.keys(JSON.parse(lastLine)), ['v', 'kind', 'key', 'at'], 'L4 ... and stores exactly those fields');
    const before = fs.readFileSync(file, 'utf8').split('\n').length;
    const batch = recordClean({ brainPath, home, keys: ['a.ts', 'b.ts', 'a.ts', '', 7], now: T + 11 });
    ok(batch.length === 2 && batch.every((r) => r.kind === 'clean' && r.at === T + 11) && fs.readFileSync(file, 'utf8').split('\n').length === before + 2,
      'L4 recordClean with keys: one record per distinct key, in one append');
    ok(recordClean({ brainPath: null, key: 'a.ts' }) === null && recordClean({ brainPath, home }) === null && recordClean({ brainPath, home, keys: 'nope' }).length === 0
      && recordClean({ brainPath, home, key: 'a.ts', now: -1 }) === null, 'L4 recordClean never throws on bad input');
    ok(recordClean({ brainPath, home, key: 'Src\\Mixed\\Case.TS', now: T + 12, platform: 'win32' }).key === 'src/mixed/case.ts',
      'L4 recordClean folds keys like fileKey (win32: \\ becomes /, lowercase)');
  }

  // -- L5: readLedger -------------------------------------------------------------
  {
    const brainPath = makeBrain(path.join(root, 'ReadProject'));
    const file = ledgerFileFor(brainPath, home);
    ok(readLedger({ brainPath, home }).size === 0 && readLedger().size === 0 && readLedger({ brainPath: null }).size === 0, 'L5 no ledger yet: an empty Map');
    const T = 2_000_000_000_000;
    const good = (sid, at, extra = {}) => ({ v: 1, sid, client: 'codex', key: 'src/a.ts', at, blob: hashBytes(String(sid)).blob, blobLf: hashBytes(String(sid)).blobLf, ...extra });
    const lines = [
      `\uFEFF${JSON.stringify(good('first', T + 10))}`,
      '{"v":1,"sid":"torn","client":"codex","key":"src/',
      'not json at all',
      '\u0000\u0001garbage\uFFFD',
      '[1,2,3]', '"a string"', '42', 'null', '{}',
      JSON.stringify(good('newer-version', T + 11, { v: 2 })),
      JSON.stringify({ ...good('no-key', T + 12), key: undefined }),
      JSON.stringify(good('', T + 13)),
      JSON.stringify(good('x'.repeat(LEDGER_SID_MAX + 1), T + 14)),
      JSON.stringify(good('string-time', String(T + 15))),
      JSON.stringify(good('negative-time', -5)),
      JSON.stringify(good('unknown-kind', T + 16, { kind: 'stash' })),
      JSON.stringify({ v: 1, kind: 'rotated', at: T, bytes: 10 }),
      JSON.stringify({ ...good('long-key', T + 17), key: 'k'.repeat(LEDGER_KEY_MAX + 1) }),
      `{"v":1,"sid":"fragment${JSON.stringify(good('glued', T + 20))}`,
      `${JSON.stringify(good('crlf-line', T + 30))}\r`,
      JSON.stringify(good('bad-hashes', T + 40, { blob: 'XYZ', blobLf: 42 })),
      `{"v":1,"__proto__":{"polluted":true},"sid":"proto","client":"codex","key":"src/a.ts","at":${T + 50}}`,
      JSON.stringify({ v: 1, kind: 'clean', key: 'src/b.ts', at: T + 60 }),
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n{"v":1,"sid":"in-flight","key":"src/a.ts","at":`);
    const map = readLedger({ brainPath, home, now: T + 100 });
    same([...map.keys()], ['src/a.ts', 'src/b.ts'], 'L5 torn, garbage, non-object, newer-version, unknown-kind and over-long lines are skipped');
    same(map.get('src/a.ts').map((r) => r.sid), ['first', 'glued', 'crlf-line', 'bad-hashes', 'proto'],
      'L5 valid records are read: after a BOM, glued behind a torn fragment, CRLF-terminated, with a bad hash, with a __proto__ key');
    ok(map.get('src/a.ts')[3].blob === null && map.get('src/a.ts')[3].blobLf === null, 'L5 an invalid hash is read as no hash');
    const proto = map.get('src/a.ts')[4];
    ok(({}).polluted === undefined && Object.getPrototypeOf(proto) === Object.prototype && !('polluted' in proto), 'L5 records are rebuilt from known fields only');
    ok(map.get('src/b.ts')[0].kind === 'clean', 'L5 clean records are read');
    const next = recordClean({ brainPath, home, key: 'src/c.ts', now: T + 70 });
    const after = readLedger({ brainPath, home, now: T + 100 });
    const tail = fs.readFileSync(file, 'utf8').split('\n').slice(-3);
    ok(next && tail[0] === '{"v":1,"sid":"in-flight","key":"src/a.ts","at":' && tail[1] === JSON.stringify(next) && tail[2] === '',
      'L5 an append after a half-written last line starts on a line of its own (the writer adds the newline)');
    ok(after.has('src/c.ts') && after.get('src/a.ts').length === 5, 'L5 ... and is read, while the fragment stays skipped');

    const ttlBrain = makeBrain(path.join(root, 'TtlProject'));
    const ttlFile = ledgerFileFor(ttlBrain, home);
    const now = T;
    const at = (sid, when) => JSON.stringify({ v: 1, sid, client: 'codex', key: 'k.ts', at: when, blob: null, blobLf: null });
    fs.mkdirSync(path.dirname(ttlFile), { recursive: true });
    fs.writeFileSync(ttlFile, `${[at('recent', now - 5), at('expired', now - LEDGER_TTL_MS - 1), at('boundary', now - LEDGER_TTL_MS), at('future', now + 60000),
      at('tie-1', now - 7), at('tie-2', now - 7)].join('\n')}\n`);
    same(readLedger({ brainPath: ttlBrain, home, now }).get('k.ts').map((r) => r.sid), ['boundary', 'tie-1', 'tie-2', 'recent', 'future'],
      'L5 the 14-day TTL drops older records (the boundary is kept); lists come oldest first; equal times keep file order');
    same(readLedger({ brainPath: ttlBrain, home, now, ttlMs: 10 }).get('k.ts').map((r) => r.sid), ['tie-1', 'tie-2', 'recent', 'future'], 'L5 ttlMs is honoured');
    ok(readLedger({ brainPath: ttlBrain, home, now, ttlMs: Infinity }).get('k.ts').length === 6, 'L5 ttlMs: Infinity keeps everything');
    ok(readLedger({ brainPath: ttlBrain, home, now, ttlMs: Number.NaN }).get('k.ts').length === 5, 'L5 an unusable ttlMs falls back to 14 days');

    const caseBrain = makeBrain(path.join(root, 'CaseProject'));
    const caseFile = ledgerFileFor(caseBrain, home);
    fs.mkdirSync(path.dirname(caseFile), { recursive: true });
    fs.writeFileSync(caseFile, `${['SRC/A.ts', 'src/a.ts', 'Src\\A.ts'].map((key, i) => JSON.stringify({ v: 1, sid: `s${i}`, client: 'codex', key, at: T + i, blob: null, blobLf: null })).join('\n')}\n`);
    const w = readLedger({ brainPath: caseBrain, home, now: T, platform: 'win32' });
    ok([...w.keys()].join() === 'src/a.ts' && w.get('src/a.ts').length === 3, 'L5 win32: one file however its path was cased or slashed');
    same([...readLedger({ brainPath: caseBrain, home, now: T, platform: 'linux' }).keys()], ['SRC/A.ts', 'src/a.ts', 'Src\\A.ts'], 'L5 POSIX: case and backslashes are part of the name');
    if (win) ok(readLedger({ brainPath: caseBrain, home, now: T }).size === 1, 'L5 on this Windows machine the default folds case');
  }

  // -- L6: several processes appending at once --------------------------------------
  {
    const repo = gitInit(path.join(root, 'BusyRepo'));
    const brainPath = makeBrain(repo);
    const files = [];
    for (let i = 0; i < 8; i++) {
      const f = path.join(repo, `f${i}.ts`);
      fs.writeFileSync(f, `export const n = ${i};\n`);
      files.push(f);
    }
    const writers = 6;
    const edits = 60;
    const cleans = 5;
    const startAt = Date.now() + 1500;
    const jobs = Array.from({ length: writers }, (_, c) => ({
      brainPath, home, repo, files, sid: `writer-${c}`, count: edits, cleanKeys: Array.from({ length: cleans }, (_, i) => `clean-${c}-${i}.ts`), startAt,
    }));
    let polls = 0;
    let backwards = 0;
    let last = 0;
    const results = await whileRunning(runChildren(jobs), () => {
      const n = countRecords(readLedger({ brainPath, home, ttlMs: Infinity }));
      if (n < last) backwards++;
      last = n;
      polls++;
    });
    const wrote = results.reduce((n, r) => n + r.wrote, 0);
    const map = readLedger({ brainPath, home, ttlMs: Infinity });
    const raw = fs.readFileSync(ledgerFileFor(brainPath, home), 'utf8').split('\n').filter(Boolean);
    const unparsable = raw.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } });
    ok(wrote === writers * (edits + cleans), `L6 ${writers} processes wrote ${wrote} records at the same moment, every append reported written`);
    ok(countRecords(map) === wrote, 'L6 every record is read back: no append was lost');
    const perWriter = Array.from({ length: writers }, (_, c) => [...map.values()].flat().filter((r) => r.sid === `writer-${c}`).length);
    ok(perWriter.every((n) => n === edits), `L6 each writer's ${edits} edit records are all there`);
    ok(unparsable.length === 0 && raw.length === wrote, `L6 no line is torn or interleaved (${raw.length} lines)`);
    ok(polls > 0 && backwards === 0, `L6 a reader polling during the writes (${polls} reads) never failed and never saw records disappear`);
  }

  // -- L7: ownership ----------------------------------------------------------------
  {
    let r = who([ed('peer', 10, 'v1')], H('v1'));
    same(r, { cls: 'FOREIGN', owners: [{ sid: 'peer', client: 'codex', at: 10 }], self: false, also: [] }, "L7 FOREIGN: another session's newest edit left exactly these bytes");
    r = who([ed('me', 10, 'v1', 'claude-code')], H('v1'));
    same(r, { cls: 'MINE', owners: [{ sid: 'me', client: 'claude-code', at: 10 }], self: true, also: [] }, "L7 MINE: the asking session's newest edit left these bytes");
    r = who([ed('taken', 10, 'v1')], H('v1'), { adoptedIds: ['taken'] });
    ok(r.cls === 'MINE' && r.label === undefined && sids(r.owners) === 'taken', 'L7 MINE: a stopped session taken over with brain_handoff counts as mine');
    r = who([ed('before-clear', 10, 'v1', 'claude-code')], H('v1'), { sameHostIds: ['before-clear'] });
    ok(r.cls === 'MINE' && r.label === SAME_HOST_LABEL, `L7 MINE: the same Claude window before /clear, labelled "${SAME_HOST_LABEL}"`);
    r = who([ed('before-clear', 10, 'v1'), ed('me', 20, 'v1')], H('v1'), { sameHostIds: ['before-clear'] });
    ok(r.cls === 'MINE' && r.label === undefined && sids(r.owners) === 'me,before-clear', 'L7 MINE: when this session matches too, no "earlier conversation" label');
    r = who([ed('peer', 10, 'v1')], H('v2'));
    same(r, { cls: 'SHARED', owners: [{ sid: 'peer', client: 'codex', at: 10 }], self: false, also: [] }, 'L7 SHARED: another session edited it, but the bytes changed since (context only)');
    r = who([ed('peer', 10, 'v1'), ed('me', 20, 'v2', 'claude-code')], H('v3'));
    ok(r.cls === 'SHARED' && sids(r.owners) === 'peer' && r.self === true, "L7 SHARED: nobody's bytes match; another session and I both have edits");
    r = who([ed('peer', 10, 'v1'), ed('me', 20, 'v1', 'claude-code')], H('v1'));
    ok(r.cls === 'SHARED' && sids(r.owners) === 'peer' && r.self === true, 'L7 SHARED: both sides left these exact bytes, a guess either way, so never FOREIGN');
    ok(who([], H('v1')).cls === 'UNATTRIBUTED' && who([], H('v1')).self === false, 'L7 UNATTRIBUTED: no record at all');
    r = who([ed('me', 10, 'v1', 'claude-code')], H('v2'));
    ok(r.cls === 'UNATTRIBUTED' && r.self === true && r.owners.length === 0, 'L7 UNATTRIBUTED: only my own edit, changed since (self: true)');
    r = who([ed('peer', 10, 'v1'), ed('peer', 20, 'v2')], H('v1'));
    ok(r.cls === 'SHARED' && r.owners[0].at === 20, "L7 only each session's NEWEST record is evidence: an older matching edit is not");
    r = who([ed('peer-a', 10, 'v1'), ed('peer-b', 20, 'v1', 'cursor')], H('v1'));
    ok(r.cls === 'FOREIGN' && sids(r.owners) === 'peer-b,peer-a' && r.owners[0].client === 'cursor', 'L7 FOREIGN with two owners, newest first');
    r = who([ed('peer-a', 10, 'v0'), ed('peer-b', 20, 'v1')], H('v1'));
    ok(r.cls === 'FOREIGN' && sids(r.owners) === 'peer-b' && sids(r.also) === 'peer-a', 'L7 FOREIGN: `also` names the other session whose edit may be in there too');
    r = who([ed('peer', 10, 'v1'), ed('me', 20, 'v2', 'claude-code')], H('v2'));
    ok(r.cls === 'MINE' && sids(r.also) === 'peer', "L7 MINE on top of another session's edit: `also` names it (context, never a block)");
    ok(who([ed('peer', 10, 'a\nb\n')], H('a\r\nb\r\n')).cls === 'FOREIGN', 'L7 still FOREIGN after a checkout turned LF into CRLF (blobLf)');
    ok(who([ed('peer', 10, 'a\r\nb\r\n')], H('a\nb\n')).cls === 'FOREIGN', 'L7 still FOREIGN after a tool turned CRLF into LF (blobLf)');
    ok(who([ed('peer', 10, 'a\nb\n')], H('a\r\nb')).cls === 'SHARED', 'L7 a content change on top of a line-ending change is not a match');
    ok(who([ed('peer', 10, null)], H('v1')).cls === 'SHARED', 'L7 a record without a hash (over the cap) can only give context');
    ok(who([ed('peer', 10, 'v1')], undefined).cls === 'SHARED' && who([ed('peer', 10, 'v1')], { blob: null, blobLf: null }).cls === 'SHARED',
      'L7 a dirty file that was not hashed can never be FOREIGN');
    ok(who([ed('peer', 10, 'v1')], H('v1').blob.toUpperCase()).cls === 'FOREIGN', 'L7 a bare blob id (any case) is accepted as the current hash');
    ok(who([ed('me', 10, 'v1')], H('v1'), { selfIds: ['ME'] }).cls === 'MINE' && who([ed('peer', 10, 'v1')], H('v1'), { selfIds: 'PEER' }).cls === 'MINE',
      'L7 session ids compare case-insensitively; a single id string works');

    ok(who([ed('peer', 10, 'v1'), cl(20)], H('v1')).cls === 'UNATTRIBUTED', 'L7 clean resets: an edit before the latest clean is retired, even when the bytes match');
    r = who([ed('peer', 10, 'v1'), cl(20), ed('peer', 30, 'v2')], H('v2'));
    ok(r.cls === 'FOREIGN' && r.owners[0].at === 30, 'L7 clean resets: an edit after it counts again');
    r = who([ed('peer', 10, 'v1'), cl(20), ed('me', 30, 'v2', 'claude-code')], H('v2'));
    ok(r.cls === 'MINE' && r.also.length === 0, 'L7 clean resets: a retired edit is not even context any more');
    ok(who([ed('peer', 10, 'v1'), cl(20), ed('peer', 30, 'v1'), cl(40)], H('v1')).cls === 'UNATTRIBUTED', 'L7 only the latest clean decides');
    ok(who([cl(50), ed('peer', 50, 'v1')], H('v1')).cls === 'FOREIGN', 'L7 an edit at the same time as the clean but written after it counts');
    ok(who([ed('peer', 50, 'v1'), cl(50)], H('v1')).cls === 'UNATTRIBUTED', 'L7 an edit at the same time as the clean but written before it is retired');
    ok(who([ed('peer', 30, 'v2'), ed('peer', 10, 'v1')], H('v2')).cls === 'FOREIGN', 'L7 records handed over out of order are ordered by time');

    same(who([ed('peer', 10, 'v1')], null), { cls: 'FOREIGN', owners: [{ sid: 'peer', client: 'codex', at: 10 }], self: false, also: [] },
      'L7 deleted: owned by the session with the newest record; FOREIGN when that is another session');
    r = who([ed('peer', 10, 'v1'), ed('me', 20, 'v2', 'claude-code')], null);
    ok(r.cls === 'MINE' && sids(r.owners) === 'me' && sids(r.also) === 'peer', 'L7 deleted: MINE when my record is the newest');
    r = who([ed('me', 10, 'v1', 'claude-code'), ed('peer', 20, 'v2')], null);
    ok(r.cls === 'FOREIGN' && sids(r.owners) === 'peer' && r.self === true, 'L7 deleted: FOREIGN when another session edited after me');
    ok(who([ed('before-clear', 10, 'v1')], null, { sameHostIds: ['before-clear'] }).label === SAME_HOST_LABEL
      && who([ed('taken', 10, 'v1')], null, { adoptedIds: ['taken'] }).cls === 'MINE', 'L7 deleted: same-window (labelled) and adopted sessions are mine');
    ok(who([ed('peer', 10, 'v1'), cl(20)], null).cls === 'UNATTRIBUTED' && who([], null).cls === 'UNATTRIBUTED', 'L7 deleted with nothing since the latest clean: UNATTRIBUTED');

    const ledger = new Map([['src/tax.ts', [ed('peer', 10, 'v1', 'codex', 'src/tax.ts')]]]);
    ok(ownership({ ledger, dirty: [{ key: 'SRC/Tax.ts', hash: H('v1') }], selfIds: ['me'], platform: 'win32' }).get('SRC/Tax.ts').cls === 'FOREIGN',
      'L7 Windows: keys compare case-insensitively, and the answer is keyed as asked');
    ok(ownership({ ledger, dirty: [{ key: 'SRC/Tax.ts', hash: H('v1') }], selfIds: ['me'], platform: 'linux' }).get('SRC/Tax.ts').cls === 'UNATTRIBUTED',
      'L7 POSIX: keys stay case-sensitive');
    const split = new Map([['Src/A.ts', [ed('peer', 10, 'v1', 'codex', 'Src/A.ts')]], ['src/a.ts', [ed('peer', 20, 'v2', 'codex', 'src/a.ts')]]]);
    ok(ownership({ ledger: split, dirty: [{ key: 'Src/A.ts', hash: H('v1') }], platform: 'win32' }).get('Src/A.ts').cls === 'SHARED'
      && ownership({ ledger: split, dirty: [{ key: 'Src/A.ts', hash: H('v1') }], platform: 'linux' }).get('Src/A.ts').cls === 'FOREIGN',
      'L7 Windows: two spellings of one path are one file (its newest record is v2); POSIX: two files');
    const many = ownership({ ledger: { 'a.ts': [ed('peer', 10, 'v1', 'codex', 'a.ts')] }, dirty: [{ key: 'a.ts', hash: H('v1') }, null, { hash: H('v1') }, { key: 'b.ts', hash: H('v1') }] });
    ok(many.size === 2 && many.get('a.ts').cls === 'FOREIGN' && many.get('b.ts').cls === 'UNATTRIBUTED', 'L7 a plain-object ledger works; entries without a key are skipped');
    ok(ownership({ ledger: 'garbage', dirty: 'garbage' }).size === 0 && ownership().size === 0, 'L7 garbage in, an empty Map out (never a throw)');
    ok(ownership({ ledger: new Map([['a.ts', [null, 7, { kind: 'clean' }, { sid: 'peer' }]]]), dirty: [{ key: 'a.ts', hash: H('v1') }] }).get('a.ts').cls === 'UNATTRIBUTED',
      'L7 malformed records are ignored');
  }

  // -- L8: rotation ----------------------------------------------------------------
  {
    const day = 86400000;
    const now = 2_000_000_000_000;
    ok(rotateLedgerIfLarge({ brainPath: null }).rotated === false && rotateLedgerIfLarge().rotated === false, 'L8 no brain: nothing to rotate (never a throw)');
    const brainPath = makeBrain(path.join(root, 'RotateProject'));
    const file = ledgerFileFor(brainPath, home);
    ok(rotateLedgerIfLarge({ brainPath, home }).reason === 'missing', 'L8 no ledger yet: nothing to rotate');
    const stash = { v: 1, kind: 'stash', key: 'refs/stash', sid: 'peer', at: now - day, sha: 'c0ffee' };
    const future = { v: 2, sid: 'peer', key: 'a.ts', at: now - day, shape: 'from a newer build' };
    const lines = [
      ed('peer', now - 3 * day, 'old', 'codex', 'a.ts'),
      ed('peer', now - 2 * day, 'mid', 'codex', 'a.ts'),
      ed('peer', now - 1 * day, 'new', 'codex', 'a.ts'),
      ed('me', now - 2 * day, 'mine', 'claude-code', 'a.ts'),
      ed('peer', now - 5 * day, 'x', 'codex', 'b.ts'),
      cl(now - 4 * day, 'b.ts'),
      cl(now - 3 * day, 'b.ts'),
      ed('peer', now - 2 * day, 'y', 'codex', 'b.ts'),
      ed('ghost', now - 20 * day, 'z', 'codex', 'c.ts'),
      cl(now - 15 * day, 'd.ts'),
      stash,
      future,
    ].map((r) => JSON.stringify(r));
    lines.splice(3, 0, 'garbage {', '{"v":1,"sid":"torn"');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const ask = (map) => ownership({ ledger: map, dirty: ['a.ts', 'b.ts', 'c.ts'].flatMap((key) => [{ key, hash: H('new') }]), selfIds: ['me'] });
    const ownBefore = [...ask(readLedger({ brainPath, home, now })).entries()];
    ok(rotateLedgerIfLarge({ brainPath, home, now }).reason === 'small', 'L8 under 512 KiB nothing is rewritten');
    const res = rotateLedgerIfLarge({ brainPath, home, maxBytes: 64, now });
    ok(res.rotated === true && res.kept === 6 && res.dropped === 6 && res.bytesAfter < res.bytesBefore, `L8 over the limit it rotates: kept ${res.kept}, dropped ${res.dropped}`);
    const after = readLedger({ brainPath, home, now });
    same(after.get('a.ts').map((x) => `${x.sid}@${(now - x.at) / day}d`), ['me@2d', 'peer@1d'], 'L8 the newest record per (key, session) is kept, the older ones go');
    same(after.get('b.ts').map((x) => x.kind || x.sid), ['clean', 'peer'], 'L8 the latest clean per key is kept, and the edit retired by it is gone');
    ok(after.get('b.ts')[0].at === now - 3 * day, 'L8 ... it is the LATEST clean that is kept');
    ok(!after.has('c.ts') && !after.has('d.ts'), 'L8 records past the 14-day TTL are dropped');
    const rotatedText = fs.readFileSync(file, 'utf8');
    const rotatedLines = rotatedText.split('\n').filter(Boolean);
    ok(JSON.parse(rotatedLines[0]).kind === 'rotated' && rotatedLines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } }),
      'L8 the rewritten file starts with a header line, and garbage lines are gone');
    ok(rotatedLines.some((line) => JSON.stringify(JSON.parse(line)) === JSON.stringify(stash)) && rotatedLines.some((line) => JSON.stringify(JSON.parse(line)) === JSON.stringify(future)),
      "L8 a newer build's records (an unknown kind, a later version) are kept, not erased");
    same([...ask(after).entries()], ownBefore, 'L8 ownership() gives the same answers before and after');
    ok(tmpLeft(brainPath).length === 0, 'L8 no tmp file or link is left behind');

    // Random ledgers: rotation never changes what ownership() says.
    const rnd = prng(424242);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const keys = ['a.ts', 'b.ts', 'c/d.ts', 'C/D.ts'];
    const sessions = ['me', 'peer-1', 'PEER-1', 'peer-2', 'taken', 'before-clear'];
    const contents = ['v0', 'v1', 'v2', 'v3', null];
    const variants = [H('v0'), H('v1'), H('v2'), H('v3'), null, undefined];
    let rounds = 0;
    let questions = 0;
    let rotations = 0;
    for (let round = 0; round < 80; round++) {
      const platform = round % 2 ? 'win32' : process.platform;
      const brain = makeBrain(path.join(root, 'RandomProject'), `brain-${round}.klypix`);
      const records = [];
      const n = 3 + Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) {
        const key = pick(keys);
        const at = now - Math.floor(rnd() * 20) * day; // coarse times: many ties, some past the TTL
        records.push(rnd() < 0.18 ? cl(at, key) : ed(pick(sessions), at, pick(contents), pick(['codex', 'claude-code']), key));
      }
      const text = records.map((x) => JSON.stringify(x)).join('\n');
      const ledgerFile = ledgerFileFor(brain, home);
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.writeFileSync(ledgerFile, `garbage line\n${text}\n`);
      const idSets = [
        { selfIds: ['me'] },
        { selfIds: ['me'], adoptedIds: ['taken'], sameHostIds: ['before-clear'] },
        { selfIds: ['peer-1'], adoptedIds: ['peer-2'] },
      ];
      const answers = () => {
        const map = readLedger({ brainPath: brain, home, now, platform });
        return JSON.stringify(idSets.flatMap((ids) => variants.map((hash) => [...ownership({ ledger: map, dirty: keys.map((key) => ({ key, hash })), platform, ...ids }).entries()])));
      };
      const before = answers();
      const r = rotateLedgerIfLarge({ brainPath: brain, home, maxBytes: 1, now, platform });
      if (r.rotated) rotations++;
      assert.equal(answers(), before, `rotation changed ownership() in random round ${round}`);
      rounds++;
      questions += idSets.length * variants.length * keys.length;
    }
    ok(rounds === 80 && rotations === 80, `L8 ${rounds} random ledgers (ties, cleans, expired records, case variants): ${questions} ownership answers identical after rotation`);

    // Lines that land while the rotation works are carried over.
    const seamRepo = gitInit(path.join(root, 'SeamRepo'));
    const seamBrain = makeBrain(seamRepo);
    const seamFile = ledgerFileFor(seamBrain, home);
    const racer = path.join(seamRepo, 'racer.ts');
    fs.writeFileSync(racer, 'export {};\n');
    for (let i = 0; i < 30; i++) recordClean({ brainPath: seamBrain, home, key: `filler-${i}.ts`, now: now + i });
    const seam = rotateLedgerIfLarge({
      brainPath: seamBrain, home, maxBytes: 256, now: now + 100,
      _seams: { afterRead: () => {
        recordClean({ brainPath: seamBrain, home, key: 'raced-clean.ts', now: now + 101 });
        recordEdit({ brainPath: seamBrain, home, sid: 'racer', client: 'codex', repoRoot: seamRepo, absPath: racer, now: now + 102 });
        fs.appendFileSync(seamFile, '{"v":1,"kind":"clean","key":"half-written'); // an append still in flight
      } },
    });
    const seamAfter = readLedger({ brainPath: seamBrain, home, now: now + 200 });
    ok(seam.rotated && seamAfter.has('raced-clean.ts') && seamAfter.get(fold('racer.ts'))?.[0]?.sid === 'racer' && seamAfter.size === 32,
      'L8 records appended while the rotation worked are carried over');
    recordClean({ brainPath: seamBrain, home, key: 'after.ts', now: now + 103 });
    ok(readLedger({ brainPath: seamBrain, home, now: now + 200 }).has('after.ts'), 'L8 a half-written line at the rotation does not swallow the next record');
    ok(tmpLeft(seamBrain).length === 0, 'L8 no tmp file or link is left behind after a raced rotation');

    // Two rotations at once: one wins, the other leaves the result alone.
    // (Enough new lines that the file has more than doubled since the last
    // rotation, which would otherwise wait.)
    for (let i = 0; i < 80; i++) recordClean({ brainPath: seamBrain, home, key: `more-${i}.ts`, now: now + 300 + i });
    const expected = readLedger({ brainPath: seamBrain, home, now: now + 400 });
    let inner = null;
    const outer = rotateLedgerIfLarge({ brainPath: seamBrain, home, maxBytes: 256, now: now + 400, _seams: { afterRead: () => { inner = rotateLedgerIfLarge({ brainPath: seamBrain, home, maxBytes: 256, now: now + 400 }); } } });
    ok((inner.rotated && !outer.rotated && outer.reason === 'raced') || (!inner.rotated && outer.rotated),
      `L8 two rotations at once: one wins, the other backs off (inner ${inner.reason}, outer ${outer.reason})`);
    same(readLedger({ brainPath: seamBrain, home, now: now + 400 }), expected, 'L8 ... and every record is still there');
    ok(tmpLeft(seamBrain).length === 0, 'L8 ... with no tmp file or link left behind');

    // Two rotations that overlap past the identity check: the slower one used
    // to rename its tmp over the faster one's fresh file and drop what was
    // appended to it. The rotation lock makes the second one back off.
    const dblBrain = makeBrain(path.join(root, 'DoubleRotate'));
    const dblFile = ledgerFileFor(dblBrain, home);
    for (let i = 0; i < 60; i++) recordClean({ brainPath: dblBrain, home, key: `filler-${i}.ts`, now: now + i });
    let dblInner = null;
    const dblOuter = rotateLedgerIfLarge({
      brainPath: dblBrain, home, maxBytes: 256, now: now + 100,
      _seams: { beforeRename: (attempt) => {
        if (attempt) return;
        dblInner = rotateLedgerIfLarge({ brainPath: dblBrain, home, maxBytes: 256, now: now + 100 });
        recordClean({ brainPath: dblBrain, home, key: 'stopped-session.ts', now: now + 101 });
      } },
    });
    ok(dblOuter.rotated && dblInner && !dblInner.rotated && dblInner.reason === 'busy',
      `L8 a rotation that starts while another holds the lock backs off (inner ${dblInner?.reason}, outer ${dblOuter.reason})`);
    ok(readLedger({ brainPath: dblBrain, home, now: now + 200 }).has('stopped-session.ts'), 'L8 ... and a record appended meanwhile survives the rename');
    ok(!fs.existsSync(`${dblFile}.rotate-lock`) && tmpLeft(dblBrain).length === 0, 'L8 ... with the lock released and no tmp left behind');
    // A lock left by a process that died is taken over once stale; a fresh one is respected.
    for (let i = 0; i < 200; i++) recordClean({ brainPath: dblBrain, home, key: `grow-${i}.ts`, now: now + 300 + i });
    fs.writeFileSync(`${dblFile}.rotate-lock`, 'someone-else');
    ok(rotateLedgerIfLarge({ brainPath: dblBrain, home, maxBytes: 256, now: now + 600 }).reason === 'busy' && fs.readFileSync(`${dblFile}.rotate-lock`, 'utf8') === 'someone-else',
      'L8 a fresh rotation lock held by another process is respected (and left alone)');
    const staleAt = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(`${dblFile}.rotate-lock`, staleAt, staleAt);
    ok(rotateLedgerIfLarge({ brainPath: dblBrain, home, maxBytes: 256, now: now + 600 }).rotated && !fs.existsSync(`${dblFile}.rotate-lock`),
      'L8 a stale rotation lock (its process died) is taken over and released');

    // The very last moment: a line appended after the final copy, just before
    // the rename, reaches only the old file. The hard link carries it over.
    const lateBrain = makeBrain(path.join(root, 'LateProject'));
    for (let i = 0; i < 30; i++) recordClean({ brainPath: lateBrain, home, key: `filler-${i}.ts`, now: now + i });
    let beforeRename = 0;
    const late = rotateLedgerIfLarge({
      brainPath: lateBrain, home, maxBytes: 256, now: now + 100,
      _seams: { beforeRename: () => { if (!beforeRename++) recordClean({ brainPath: lateBrain, home, key: 'last-moment.ts', now: now + 101 }); } },
    });
    ok(late.rotated && beforeRename >= 1 && readLedger({ brainPath: lateBrain, home, now: now + 200 }).has('last-moment.ts'),
      'L8 a line appended between the final copy and the rename is carried over (read through the hard link)');
    ok(tmpLeft(lateBrain).length === 0, 'L8 ... and the link is removed afterwards');

    // POSIX: a writer whose handle was opened before a rotation's rename wrote
    // into the old file; it sees that the path now names another file and
    // writes again. Simulated: the ledger's stat answers as if replaced.
    const reBrain = makeBrain(seamRepo, 'brain-reappend.klypix');
    const reFile = ledgerFileFor(reBrain, home);
    recordClean({ brainPath: reBrain, home, key: 'seed.ts', now });
    const realStat = fs.statSync;
    const fakeReplaced = (times) => {
      let faked = 0;
      fs.statSync = (p, opts) => {
        const s = realStat(p, opts);
        if (faked < times && String(p) === reFile && opts?.bigint) { faked++; return { ...s, ino: s.ino + 1n }; }
        return s;
      };
      return () => faked;
    };
    let fakedCount;
    let reRec;
    try {
      fakedCount = fakeReplaced(1);
      reRec = recordEdit({ brainPath: reBrain, home, sid: 'posix-writer', client: 'codex', repoRoot: seamRepo, absPath: racer, now: now + 1 });
    } finally { fs.statSync = realStat; }
    const copies = fs.readFileSync(reFile, 'utf8').split('\n').filter((line) => line.includes('"posix-writer"'));
    ok(fakedCount() === 1 && reRec && copies.length === 2 && copies[0] === copies[1], 'L8 a writer whose handle no longer matches the path writes its record again');
    const reAnswer = ownership({ ledger: readLedger({ brainPath: reBrain, home, now: now + 10 }), dirty: [{ key: fold('racer.ts'), hash: hashBytes(fs.readFileSync(racer)) }] }).get(fold('racer.ts'));
    ok(reAnswer.cls === 'FOREIGN' && reAnswer.owners.length === 1, 'L8 ... and the duplicate is harmless (one owner, the same answer)');
    try {
      fakedCount = fakeReplaced(Infinity);
      recordClean({ brainPath: reBrain, home, key: 'stubborn.ts', now: now + 2 });
    } finally { fs.statSync = realStat; }
    ok(fs.readFileSync(reFile, 'utf8').split('\n').filter((line) => line.includes('stubborn.ts')).length === 3, 'L8 ... at most twice more, even if the path never matches');

    // A ledger that is legitimately larger than maxBytes is not rewritten on every call.
    const bigBrain = makeBrain(path.join(root, 'BigProject'));
    const many = (from, count) => { for (let i = from; i < from + count; i++) recordClean({ brainPath: bigBrain, home, key: `src/file-${i}.ts`, now: now + i }); };
    many(0, 60);
    const first = rotateLedgerIfLarge({ brainPath: bigBrain, home, maxBytes: 1024, now: now + 1000 });
    const second = rotateLedgerIfLarge({ brainPath: bigBrain, home, maxBytes: 1024, now: now + 1000 });
    ok(first.rotated && first.kept === 60 && !second.rotated && second.reason === 'recently-rotated', 'L8 right after a rotation that could not shrink it, the next call waits');
    many(60, 80);
    const third = rotateLedgerIfLarge({ brainPath: bigBrain, home, maxBytes: 1024, now: now + 1000 });
    ok(third.rotated && third.kept === 140, 'L8 ... until the file has doubled, then it rotates again');

    // Real concurrent load: writers append while rotations keep running.
    const loadRepo = gitInit(path.join(root, 'LoadRepo'));
    const loadBrain = makeBrain(loadRepo);
    const writers = 4;
    const cycle = 5;
    const startAt = Date.now() + 1500;
    // Paced writers (a short pause between appends) keep the load going long
    // enough for many rotations to interleave with it.
    const jobs = Array.from({ length: writers }, (_, c) => ({ brainPath: loadBrain, home, repo: loadRepo, sid: `load-${c}`, count: 220, cycle, startAt, pauseMs: 2 }));
    const reasons = {};
    const results = await whileRunning(runChildren(jobs), () => {
      if (Date.now() < startAt) return;
      const r = rotateLedgerIfLarge({ brainPath: loadBrain, home, maxBytes: 2048, ttlMs: Infinity });
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    });
    const loadMap = readLedger({ brainPath: loadBrain, home, ttlMs: Infinity });
    let pairs = 0;
    let newestKept = 0;
    for (const [c, result] of results.entries()) {
      for (const [name, at] of Object.entries(result.last)) {
        pairs++;
        const list = (loadMap.get(fold(name)) || []).filter((x) => x.sid === `load-${c}`);
        if (list.length && list[list.length - 1].at === at) newestKept++;
      }
    }
    const summary = Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ');
    ok((reasons.rotated || 0) >= 3, `L8 under load the rotation ran again and again (${summary})`);
    ok(pairs === writers * cycle && newestKept === pairs, `L8 under load every (file, session) still has its newest record: ${newestKept}/${pairs}`);
    ok(Object.keys(reasons).every((k) => ['rotated', 'small', 'missing', 'recently-rotated', 'raced'].includes(k) || /^failed:E[A-Z]+$/.test(k)),
      'L8 under load every call returned a known outcome (a refused rename is retried on a later call)');
    ok(tmpLeft(loadBrain).length === 0, 'L8 under load no tmp file or link is left behind');
  }

  // -- L9: end to end in a real repo --------------------------------------------------
  {
    const repo = gitInit(path.join(root, 'ShopRepo'));
    git(repo, ['config', 'core.autocrlf', 'false']);
    const brainPath = makeBrain(repo);
    const tax = path.join(repo, 'tax.ts');
    const invoice = path.join(repo, 'invoice.js');
    const readme = path.join(repo, 'README.md');
    fs.writeFileSync(tax, 'export const rate = 0.2;\n');
    fs.writeFileSync(invoice, 'module.exports = {};\n');
    fs.writeFileSync(readme, '# shop\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const dirtyNow = () => gitRaw(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
      .map((entry) => entry.slice(3)).filter((p) => !p.endsWith('/'))
      .map((p) => { const abs = path.join(repo, p); return { key: fileKey(repo, p), hash: fs.existsSync(abs) ? hashBytes(fs.readFileSync(abs)) : null }; });
    const ask = (selfIds = ['claude-me'], more = {}) => ownership({ ledger: readLedger({ brainPath, home }), dirty: dirtyNow(), selfIds, ...more });
    const edit = (sid, client, abs, content) => { fs.writeFileSync(abs, content); return recordEdit({ brainPath, home, sid, client, repoRoot: repo, absPath: abs }); };

    edit('codex-peer', 'codex', tax, 'export const rate = 0.25;\n');
    edit('claude-me', 'claude-code', invoice, 'module.exports = { total: 1 };\n');
    fs.writeFileSync(readme, '# shop\n\nnotes nobody recorded\n');
    let own = ask();
    ok(own.get('tax.ts').cls === 'FOREIGN' && own.get('tax.ts').owners[0].sid === 'codex-peer', "L9 the peer's uncommitted edit is FOREIGN to me");
    ok(own.get('invoice.js').cls === 'MINE', 'L9 my own uncommitted edit is MINE');
    ok(own.get(fold('README.md')).cls === 'UNATTRIBUTED', 'L9 a change no hook recorded is UNATTRIBUTED');
    const mirror = ask(['codex-peer']);
    ok(mirror.get('tax.ts').cls === 'MINE' && mirror.get('invoice.js').cls === 'FOREIGN', 'L9 the peer sees the mirror image');

    // safety-B3: the peer's edit is discarded, then a human edits the file in an editor.
    git(repo, ['restore', '--', 'tax.ts']);
    ok(!dirtyNow().some((d) => d.key === 'tax.ts'), 'L9 after git restore the peer\'s file is clean again');
    fs.writeFileSync(tax, 'export const rate = 0.3; // the human, in an editor\n');
    ok(ask().get('tax.ts').cls === 'SHARED', 'L9 safety-B3: without a clean record, the next unrecorded change is only context, never billed to the peer');
    recordClean({ brainPath, home, key: fileKey(repo, 'tax.ts') });
    own = ask();
    ok(own.get('tax.ts').cls === 'UNATTRIBUTED' && own.get('tax.ts').owners.length === 0, 'L9 safety-B3: once the clean is recorded, the peer is out of the picture');

    // The peer edits again; a stash round trip under autocrlf rewrites its line endings.
    edit('codex-peer', 'codex', tax, 'export const rate = 0.25;\nexport const cap = 9;\n');
    git(repo, ['-c', 'core.autocrlf=true', 'stash', 'push', '-q', '--', 'tax.ts']);
    git(repo, ['-c', 'core.autocrlf=true', 'stash', 'pop', '-q']);
    ok(fs.readFileSync(tax).includes(Buffer.from('\r\n')), 'L9 a stash round trip under core.autocrlf=true wrote the file back with CRLF');
    ok(ask().get('tax.ts').cls === 'FOREIGN', 'L9 ... and it is still the peer\'s edit (blobLf)');

    // Deleted: the newest record's session owns the deletion.
    fs.rmSync(tax);
    own = ask();
    ok(own.get('tax.ts').cls === 'FOREIGN' && own.get('tax.ts').owners[0].sid === 'codex-peer', 'L9 a deleted file belongs to the session with the newest record');

    // /clear in the same Claude window: the earlier conversation is mine, labelled.
    edit('claude-before-clear', 'claude-code', readme, '# shop\n\nwritten before /clear\n');
    own = ask(['claude-after-clear'], { sameHostIds: ['claude-before-clear'] });
    ok(own.get(fold('README.md')).cls === 'MINE' && own.get(fold('README.md')).label === SAME_HOST_LABEL, 'L9 the same window before /clear is mine, with its label');
    ok(ask(['claude-after-clear']).get(fold('README.md')).cls === 'FOREIGN', 'L9 ... and without the same-window id it would be another session');

    // Rotating this real ledger changes no answer.
    const before = JSON.stringify([...ask().entries()]);
    ok(rotateLedgerIfLarge({ brainPath, home, maxBytes: 1 }).rotated && JSON.stringify([...ask().entries()]) === before, 'L9 rotating the real ledger changes no answer');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n[ok] whose-ledger: all ${checks} assertions passed`);
