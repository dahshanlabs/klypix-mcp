// whose-rescue — rescue copies on REAL temporary git repositories.
//
// The load-bearing promises, each asserted against git itself:
//   R1  createRescue never changes the user's index (the .git/index BYTES and
//       `git ls-files -s`) or working tree (every path, every byte), leaves no
//       lock, temp file or crash report, and keeps ignored files out (listed).
//   R2  the copy holds the RAW working-tree bytes: tracked-modified, staged,
//       untracked, deleted (recorded absent), spaces, Unicode, `[token]`,
//       CRLF under core.autocrlf=true, a clean filter that would fail, an
//       unborn branch.
//   R3  restore writes exactly those bytes back, into the working tree only,
//       and is itself undoable: restoring its backupId gives back the state
//       it replaced, byte for byte (files it created are removed again).
//   R4  list / show / prune: newest first, files + stat, keep the newest N.
//   R5  the CLI answers the same through `klypix-mcp rescue` and its own bin.
//
// Hermetic: repos under os.tmpdir(); system and global git config shut out
// (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL → an empty file); every spawned CLI
// gets a throwaway HOME / USERPROFILE / KLYPIX_BRAIN_DIR. Nothing here touches
// ~/.claude or any repository outside the temp folder.
// Run:  node test/whose-rescue.mjs        (exit 0 = pass, 1 = fail)
import { execFileSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-whose-rescue-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
const GITCONFIG = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GITCONFIG, '');
// The module inherits these, so it sees exactly the config the test sets up.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
delete process.env.GIT_CONFIG_PARAMETERS;
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_LITERAL_PATHSPECS']) delete process.env[k];

const {
  createRescue, listRescues, listRescuesResult, showRescue, restoreRescue, pruneRescues,
  notIncludedText, rescueRestoreCommand, RESCUE_BUDGET_MS,
} = await import('../src/whose-rescue.mjs');

let failures = 0;
let checks = 0;
const ok = (condition, label, detail) => {
  checks++;
  console.log(`${condition ? '[ok]' : '[x]'} ${label}${!condition && detail !== undefined ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!condition) failures++;
};

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, args, opts = {}) => execFileSync('git', args, {
  cwd, env: { ...GIT_ENV, ...(opts.env || {}) }, encoding: opts.binary ? 'buffer' : 'utf8',
  input: opts.input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});
const gitTry = (cwd, args, opts = {}) => {
  try { return { ok: true, out: git(cwd, args, opts) }; } catch (error) { return { ok: false, out: String(error.stdout || ''), err: String(error.stderr || '') }; }
};
const write = (repo, rel, data) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};
const read = (repo, rel) => fs.readFileSync(path.join(repo, rel));
const exists = (repo, rel) => fs.existsSync(path.join(repo, rel));

function makeRepo(name, { autocrlf = 'false', init = true } = {}) {
  const repo = path.join(ROOT, name);
  fs.mkdirSync(repo, { recursive: true });
  if (init) {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@klypix.local']);
    git(repo, ['config', 'user.name', 'klypix-test']);
    git(repo, ['config', 'core.autocrlf', autocrlf]);
  }
  return repo;
}

// Every path and every byte (and, on POSIX, the exec bit) of the working tree.
function treeSnapshot(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === '.git') continue;
      const full = path.join(abs, e.name);
      if (e.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) { out.push(`${r}/`); walk(full, r); }
      else {
        const st = fs.statSync(full);
        out.push(`${r} ${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}${WIN ? '' : ` ${(st.mode & 0o111) ? 'x' : '-'}`}`);
      }
    }
  };
  walk(dir, '');
  return out.join('\n');
}

const indexFile = (repo) => path.join(repo, '.git', 'index');
function indexState(repo) {
  return {
    bytes: fs.existsSync(indexFile(repo)) ? fs.readFileSync(indexFile(repo)) : null,
    ls: git(repo, ['ls-files', '-s', '-z']),
  };
}
const sameIndex = (a, b) => ((a.bytes === null && b.bytes === null) || (a.bytes && b.bytes && a.bytes.equals(b.bytes))) && a.ls === b.ls;
const refsOf = (repo) => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/klypix']);

// What createRescue may leave inside .git: objects, one ref, and last.json.
function gitDirLeftovers(repo) {
  const gitDir = path.join(repo, '.git');
  const found = [];
  for (const name of fs.readdirSync(gitDir)) {
    if (/^fast_import_crash_/.test(name) || /\.lock$/.test(name)) found.push(name);
  }
  const mine = path.join(gitDir, 'klypix-rescue');
  if (fs.existsSync(mine)) for (const name of fs.readdirSync(mine)) if (name !== 'last.json') found.push(`klypix-rescue/${name}`);
  const pack = path.join(gitDir, 'objects', 'pack');
  if (fs.existsSync(pack)) for (const name of fs.readdirSync(pack)) if (/^tmp_|\.keep$/.test(name)) found.push(`objects/pack/${name}`);
  return found;
}

const blobAt = (repo, commit, rel) => git(repo, ['cat-file', 'blob', `${commit}:${rel}`], { binary: true });
const inTree = (repo, commit, rel) => gitTry(repo, ['cat-file', '-e', `${commit}:${rel}`]).ok;
const rawHash = (repo, rel) => git(repo, ['hash-object', '--no-filters', '--', rel]).trim();

// ── R1/R2: the main repository ────────────────────────────────────────────────
const main = makeRepo('main repo');
write(main, '.gitignore', '*.env\nbuild/\n\\[token\\].txt\n');
write(main, 'tracked.txt', 'v1\n');
write(main, 'gone.txt', 'will be deleted\n');
write(main, 'dir with space/inner file.txt', 'space v1\n');
write(main, 'ünï/çödé.txt', 'unicode v1\n');
write(main, '[token]/route.ts', 'export const v = 1;\n');
write(main, 't.txt', 'a tracked file the [token].txt glob would match\n');
write(main, 'staged.txt', 's1\n');
write(main, 'exec.sh', '#!/bin/sh\necho v1\n');
if (!WIN) fs.chmodSync(path.join(main, 'exec.sh'), 0o755);
git(main, ['add', '.']);
git(main, ['update-index', '--chmod=+x', 'exec.sh']);
git(main, ['commit', '-q', '-m', 'seed']);
const mainHead = git(main, ['rev-parse', 'HEAD']).trim();

// The uncommitted work a destructive command would throw away.
write(main, 'tracked.txt', 'v2 — changed, not committed\n');
fs.rmSync(path.join(main, 'gone.txt'));
write(main, 'new file.txt', 'brand new, untracked\n');
write(main, 'dir with space/inner file.txt', 'space v2\n');
write(main, 'ünï/çödé.txt', 'unicode v2 ✓\n');
write(main, '[token]/route.ts', 'export const v = 2;\n');
write(main, 'staged.txt', 's2\n');
git(main, ['add', 'staged.txt']);
write(main, 'staged.txt', 's3 — worktree, after staging s2\n');
write(main, 'exec.sh', '#!/bin/sh\necho v2\n');
write(main, 'secret.env', 'TOKEN=never-copied\n');
write(main, 'build/out.bin', Buffer.from([0, 1, 2, 3, 255]));
write(main, '[token].txt', 'ignored by a literal \\[token\\] pattern\n');
const nested = path.join(main, 'nested');
fs.mkdirSync(nested, { recursive: true });
git(nested, ['init', '-q', '-b', 'main']);
write(nested, 'inside.txt', 'belongs to the nested repository\n');

const request = [
  'tracked.txt', 'gone.txt', 'new file.txt', 'dir with space/inner file.txt', 'ünï/çödé.txt',
  '[token]/route.ts', 'staged.txt', 'exec.sh',
  'secret.env', 'build/out.bin', '[token].txt', 'nested', 'nested/inside.txt',
  '../outside.txt', '.git/config', path.join(main, 'tracked.txt'),
];
const rescuedExpected = ['[token]/route.ts', 'dir with space/inner file.txt', 'exec.sh', 'gone.txt', 'new file.txt', 'staged.txt', 'tracked.txt', 'ünï/çödé.txt'];
const beforeTree = treeSnapshot(main);
const beforeIndex = indexState(main);
const beforeStatus = git(main, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
const preBytes = new Map(rescuedExpected.filter((p) => exists(main, p)).map((p) => [p, read(main, p)]));

const r1 = createRescue({ repoRoot: main, paths: request, sid: 'Claude-1a2b3c4d-session', reason: 'before `git reset --hard`' });
ok(r1.ok, 'R1 createRescue succeeds on a repo with tracked, staged, untracked, deleted, ignored and nested work', r1.error);
ok(sameIndex(beforeIndex, indexState(main)), 'R1 the user\'s index is byte-identical (.git/index bytes and `git ls-files -s`)');
ok(treeSnapshot(main) === beforeTree, 'R1 the working tree is byte-identical (every path, every byte)');
ok(git(main, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) === beforeStatus, 'R1 `git status` reads exactly as before');
ok(!fs.existsSync(`${indexFile(main)}.lock`) && gitDirLeftovers(main).length === 0,
  'R1 no index.lock, no temporary file and no fast-import crash report is left in .git', gitDirLeftovers(main));
ok(/^\d{8}-\d{6}-claude1a-[0-9a-f]{4}$/.test(r1.id || ''), `R1 the id is <yyyymmdd-hhmmss>-<sid8>-<rand4>, lowercase (${r1.id})`);
ok(r1.ref === `refs/klypix/rescue/${r1.id}` && git(main, ['rev-parse', r1.ref]).trim() === r1.commit,
  'R1 refs/klypix/rescue/<id> points at the returned commit');
ok(typeof r1.ms === 'number' && r1.ms < RESCUE_BUDGET_MS, `R1 within the 2.5 s budget (${r1.ms} ms)`);
ok(JSON.stringify(r1.paths) === JSON.stringify(rescuedExpected), 'R2 exactly the rescuable paths are in the copy', r1.paths);
ok(JSON.stringify(r1.deleted) === JSON.stringify(['gone.txt']), 'R2 the deleted tracked file is recorded as absent', r1.deleted);
const whyOf = (res, p) => res.skipped.find((s) => s.path === p)?.why;
ok(whyOf(r1, 'secret.env') === 'ignored' && whyOf(r1, 'build/out.bin') === 'ignored',
  'R2 ignored files are never copied and are listed as not included');
ok(whyOf(r1, '[token].txt') === 'ignored',
  'R2 an ignored `[token].txt` beside a tracked `t.txt` is still ignored (check-ignore --no-index: no glob trap)');
ok(whyOf(r1, 'nested') === 'nested repository' && whyOf(r1, 'nested/inside.txt') === 'inside a nested repository',
  'R2 a nested repository and the files inside it are listed, not copied');
ok(whyOf(r1, '../outside.txt') === 'outside the repository' && whyOf(r1, '.git/config') === 'inside .git',
  'R2 paths outside the worktree or inside .git are refused and listed');
ok(r1.skipped.filter((s) => s.path.includes('tracked.txt')).length === 0,
  'R2 an absolute path naming a file already requested is folded into it, not listed twice');
const parents = git(main, ['rev-list', '--parents', '-n', '1', r1.commit]).trim().split(' ').slice(1);
ok(parents.length === 1 && parents[0] === mainHead, 'R2 the rescue commit\'s parent is HEAD');
ok(/^author KLYPIX <rescue@klypix\.invalid> /m.test(git(main, ['cat-file', 'commit', r1.commit])), 'R2 the commit carries the pinned KLYPIX identity');
ok([...preBytes].every(([p, bytes]) => blobAt(main, r1.commit, p).equals(bytes)),
  'R2 every rescued blob holds the exact working-tree bytes');
ok([...preBytes].every(([p]) => git(main, ['rev-parse', `${r1.commit}:${p}`]).trim() === rawHash(main, p)),
  'R2 every blob id is the raw-byte id (`git hash-object --no-filters`)');
ok(blobAt(main, r1.commit, 'staged.txt').toString() === 's3 — worktree, after staging s2\n'
  && git(main, ['show', ':staged.txt']) === 's2\n',
'R2 a staged-then-edited file: the copy holds the working-tree bytes and the index still holds the staged ones');
ok(!inTree(main, r1.commit, 'gone.txt') && !inTree(main, r1.commit, 'secret.env') && !inTree(main, r1.commit, 'build/out.bin'),
  'R2 the tree has no deleted file and no ignored file');
ok(inTree(main, r1.commit, 't.txt') && blobAt(main, r1.commit, 't.txt').equals(read(main, 't.txt')),
  'R2 files that were not rescued keep their HEAD content in the tree (HEAD + rescued changes)');
ok(git(main, ['ls-tree', r1.commit, '--', 'exec.sh']).startsWith('100755 '), 'R2 the exec bit is kept (100755)');
ok(notIncludedText(r1.skipped).startsWith('not included: ') && rescueRestoreCommand(r1.id) === `npx klypix-mcp rescue restore ${r1.id}`,
  'R2 the wording helpers produce the "not included" list and the restore command');

// ── R4: list and show ─────────────────────────────────────────────────────────
const list1 = listRescues({ repoRoot: main });
ok(list1.length === 1 && list1[0].id === r1.id && list1[0].sid === 'Claude-1a2b3c4d-session'
  && list1[0].reason === 'before `git reset --hard`' && JSON.stringify(list1[0].paths) === JSON.stringify(rescuedExpected),
'R4 listRescues returns { id, ref, commit, at, sid, reason, paths }', list1[0]);
ok(listRescues({ repoRoot: path.join(main, 'ünï') })[0]?.id === r1.id, 'R4 listRescues works from a subfolder of the worktree');
const show1 = showRescue({ repoRoot: main, id: '1' });
const change = (p) => show1.files?.find((f) => f.path === p)?.change;
ok(show1.ok && show1.id === r1.id && change('tracked.txt') === 'modified' && change('gone.txt') === 'deleted'
  && change('new file.txt') === 'added' && change('staged.txt') === 'modified',
'R4 showRescue by list number lists each file with how it differs from HEAD', show1.files);
ok(show1.stat?.files === rescuedExpected.length && show1.stat.added >= 7 && show1.stat.removed >= 6,
  `R4 showRescue gives a short stat (${JSON.stringify(show1.stat)})`);
ok(showRescue({ repoRoot: main, id: r1.id.slice(0, 18) }).id === r1.id && showRescue({ repoRoot: main, id: r1.ref }).id === r1.id,
  'R4 a unique id prefix and the full ref both resolve');
ok(!showRescue({ repoRoot: main, id: 'nope-nope' }).ok && !showRescue({ repoRoot: main, id: '7' }).ok,
  'R4 an unknown id or number answers ok:false, never throws');

// ── R5 (part): dedup — the same state again reuses the copy ───────────────────
const again = createRescue({ repoRoot: main, paths: request, sid: 'Claude-1a2b3c4d-session', reason: 'retry' });
ok(again.ok && again.reused === true && again.id === r1.id, 'R2 the same state saved again moments later reuses that copy (no duplicate)');
ok(listRescues({ repoRoot: main }).length === 1, 'R2 …so the list still has one copy');

// ── R3: the destructive command runs; restore puts the bytes back ─────────────
git(main, ['reset', '-q', '--hard']);
git(main, ['clean', '-q', '-f', '-d']);
ok(read(main, 'tracked.txt').toString() === 'v1\n' && exists(main, 'gone.txt') && !exists(main, 'new file.txt'),
  'R3 (setup) `git reset --hard` + `git clean -fd` discarded the uncommitted work');
const afterReset = treeSnapshot(main);
const indexAfterReset = indexState(main);
const restored1 = restoreRescue({ repoRoot: main, id: r1.id });
ok(restored1.ok && restored1.backupId && restored1.backupId !== r1.id, 'R3 restore succeeds and saves what it replaces first (backupId)', restored1);
ok([...preBytes].every(([p, bytes]) => exists(main, p) && read(main, p).equals(bytes)),
  'R3 every rescued file has its exact rescued bytes again');
ok(!exists(main, 'gone.txt') && restored1.deleted.includes('gone.txt'), 'R3 the file that was absent in the copy is absent again');
ok(sameIndex(indexAfterReset, indexState(main)), 'R3 restore never touches the index (byte-identical before and after)');
ok(exists(main, 'secret.env') && exists(main, '[token].txt'), 'R3 ignored files nobody copied are left alone');
ok(WIN || (fs.statSync(path.join(main, 'exec.sh')).mode & 0o111) !== 0, 'R3 the exec bit comes back (POSIX)');
const backup = listRescues({ repoRoot: main }).find((e) => e.id === restored1.backupId);
ok(backup && backup.reason === `before restoring ${r1.id}` && backup.paths.includes('new file.txt') && backup.deleted.includes('new file.txt'),
  'R3 the backup records the files the restore created as absent', backup);

const undo = restoreRescue({ repoRoot: main, id: restored1.backupId });
ok(undo.ok && treeSnapshot(main) === afterReset, 'R3 restoring the backupId undoes the restore exactly (files it created are gone again)', undo);
ok(sameIndex(indexAfterReset, indexState(main)), 'R3 …and the index is still untouched');
ok(undo.backupId && listRescues({ repoRoot: main }).some((e) => e.id === undo.backupId), 'R3 the undo is itself undoable (its own backup exists)');

// Restoring selected paths, folders and paths relative to a sub-folder.
const one = restoreRescue({ repoRoot: main, id: r1.id, paths: ['tracked.txt', 'not-rescued.txt'] });
ok(one.ok && JSON.stringify(one.restored) === '["tracked.txt"]' && read(main, 'tracked.txt').equals(preBytes.get('tracked.txt'))
  && read(main, 'staged.txt').toString() === 's1\n',
'R3 restore of one path writes only that path', one);
ok(one.skipped.some((s) => s.path === 'not-rescued.txt' && s.why === 'not in this rescue'), 'R3 a path the copy does not hold is reported, not invented');
const folder = restoreRescue({ repoRoot: main, id: r1.id, paths: ['ünï'] });
ok(folder.ok && JSON.stringify(folder.restored) === JSON.stringify(['ünï/çödé.txt']) && read(main, 'ünï/çödé.txt').equals(preBytes.get('ünï/çödé.txt')),
  'R3 a folder name restores the rescued files under it (Unicode path)');
const rel = restoreRescue({ repoRoot: main, id: r1.id, paths: ['inner file.txt'], cwd: path.join(main, 'dir with space') });
ok(rel.ok && JSON.stringify(rel.restored) === JSON.stringify(['dir with space/inner file.txt'])
  && read(main, 'dir with space/inner file.txt').equals(preBytes.get('dir with space/inner file.txt')),
'R3 a path relative to the current folder resolves (path with spaces)');
const same = restoreRescue({ repoRoot: main, id: r1.id, paths: ['tracked.txt'] });
ok(same.ok && same.restored.length === 0 && same.unchanged.includes('tracked.txt') && same.backupId === null,
  'R3 a file already as in the copy is left alone and needs no backup');

// Safety: a file whose current bytes could not be saved first is never overwritten.
write(main, 'notes.md', 'notes v1\n');
const rNotes = createRescue({ repoRoot: main, paths: ['notes.md'], sid: 's-notes', reason: 'notes' });
fs.appendFileSync(path.join(main, '.gitignore'), 'notes.md\n');
write(main, 'notes.md', 'notes v2, now ignored\n');
const guarded = restoreRescue({ repoRoot: main, id: rNotes.id });
ok(rNotes.ok && guarded.ok && guarded.restored.length === 0 && read(main, 'notes.md').toString() === 'notes v2, now ignored\n'
  && /could not be saved first \(ignored\)/.test(guarded.skipped[0]?.why || ''),
'R3 restore leaves a file alone when its current bytes cannot be saved first (here: now ignored)', guarded);
git(main, ['checkout', '--', '.gitignore']);
fs.rmSync(path.join(main, 'notes.md'));

// ── R2: core.autocrlf=true, CRLF content, safecrlf and a clean filter ─────────
const crlf = makeRepo('crlf repo', { autocrlf: 'true' });
write(crlf, 'crlf.txt', 'one\r\ntwo\r\n');
write(crlf, 'lf.txt', 'one\ntwo\n');
write(crlf, '.gitattributes', '*.dat filter=boom\n');
git(crlf, ['add', 'crlf.txt', 'lf.txt', '.gitattributes']);
git(crlf, ['commit', '-q', '-m', 'seed']);
// Now make `git add` refuse: safecrlf=true rejects irreversible line-ending
// changes, and a required clean filter that always fails rejects x.dat. A
// rescue must not run either of them.
git(crlf, ['config', 'core.safecrlf', 'true']);
git(crlf, ['config', 'filter.boom.clean', 'false']);
git(crlf, ['config', 'filter.boom.required', 'true']);
write(crlf, 'crlf.txt', 'one\r\nTWO\r\nthree\r\n');
write(crlf, 'lf.txt', 'one\nTWO\n');
write(crlf, 'mixed.txt', 'unix\nwindows\r\nunix again\n');
write(crlf, 'new-crlf.txt', 'new\r\nfile\r\n');
write(crlf, 'x.dat', 'filtered\r\ncontent\n');
{
  const scratch = path.join(ROOT, 'scratch.index');   // never the repo's index
  const wouldAdd = (rel) => gitTry(crlf, ['add', '--', rel], { env: { GIT_INDEX_FILE: scratch } }).ok;
  ok(!wouldAdd('x.dat') && !wouldAdd('mixed.txt'),
    'R2 (setup) `git add` itself refuses x.dat (failing clean filter) and mixed.txt (safecrlf=true, autocrlf=true)');
  for (const f of [scratch, `${scratch}.lock`]) fs.rmSync(f, { force: true });
}
const crlfFiles = ['crlf.txt', 'lf.txt', 'mixed.txt', 'new-crlf.txt', 'x.dat'];
const crlfBytes = new Map(crlfFiles.map((p) => [p, read(crlf, p)]));
const crlfTreeBefore = treeSnapshot(crlf);
const crlfIndexBefore = indexState(crlf);
const rc = createRescue({ repoRoot: crlf, paths: crlfFiles, sid: 'codex-7f3a91c2', reason: 'before `git checkout -- .`' });
ok(rc.ok && JSON.stringify(rc.paths) === JSON.stringify(crlfFiles.slice().sort()), 'R2 a CRLF rescue succeeds with safecrlf=true and a failing clean filter', rc);
ok(sameIndex(crlfIndexBefore, indexState(crlf)) && treeSnapshot(crlf) === crlfTreeBefore, 'R1 index and working tree byte-identical (autocrlf=true repo)');
ok(crlfFiles.every((p) => blobAt(crlf, rc.commit, p).equals(crlfBytes.get(p))),
  'R2 the stored blobs keep CRLF, LF and mixed line endings exactly (no conversion, no filter)');
ok(git(crlf, ['rev-parse', `${rc.commit}:crlf.txt`]).trim() === rawHash(crlf, 'crlf.txt'), 'R2 the CRLF blob id is the raw-byte id');
git(crlf, ['reset', '-q', '--hard']);
git(crlf, ['clean', '-q', '-f']);
const crlfAfterReset = treeSnapshot(crlf);
const rcBack = restoreRescue({ repoRoot: crlf, id: rc.id });
ok(rcBack.ok && crlfFiles.every((p) => read(crlf, p).equals(crlfBytes.get(p))), 'R3 restore under autocrlf=true writes the exact bytes back (CRLF, LF and mixed)', rcBack);
const rcUndo = restoreRescue({ repoRoot: crlf, id: rcBack.backupId });
ok(rcUndo.ok && treeSnapshot(crlf) === crlfAfterReset, 'R3 …and its undo gives back the reset state byte for byte');
const showCrlf = showRescue({ repoRoot: crlf, id: rc.id });
const crlfLine = showCrlf.files?.find((f) => f.path === 'crlf.txt');
ok(showCrlf.ok && crlfLine?.added === 2 && crlfLine?.removed === 1, 'R4 show counts real line changes, not CR-only differences', crlfLine);

// ── R2: unborn HEAD ───────────────────────────────────────────────────────────
const unborn = makeRepo('unborn repo');
write(unborn, '.gitignore', '*.env\n');
write(unborn, 'a.txt', 'untracked a\n');
write(unborn, 'b.txt', 'staged b\n');
write(unborn, 'sp ace/ü.txt', 'unicode in a folder with a space\n');
write(unborn, 'x.env', 'SECRET=1\n');
git(unborn, ['add', 'b.txt']);
const ubIndex = indexState(unborn);
const ubTree = treeSnapshot(unborn);
const ub = createRescue({ repoRoot: unborn, paths: ['a.txt', 'b.txt', 'sp ace/ü.txt', 'x.env', '.gitignore'], sid: 'first', reason: 'before `git stash -u`' });
ok(ub.ok && JSON.stringify(ub.paths) === JSON.stringify(['.gitignore', 'a.txt', 'b.txt', 'sp ace/ü.txt']) && whyOf(ub, 'x.env') === 'ignored',
  'R2 an unborn branch (no commit yet) still gets a rescue; the ignored file is listed', ub);
ok(!/^parent /m.test(git(unborn, ['cat-file', 'commit', ub.commit])), 'R2 …as a root commit (no parent)');
ok(sameIndex(ubIndex, indexState(unborn)) && treeSnapshot(unborn) === ubTree, 'R1 index and working tree byte-identical (unborn branch)');
ok(gitTry(unborn, ['rev-parse', '-q', '--verify', 'HEAD']).ok === false, 'R1 HEAD is still unborn (no branch was created)');
const ubShow = showRescue({ repoRoot: unborn, id: ub.id });
ok(ubShow.ok && ubShow.head === null && ubShow.files.every((f) => f.change === 'added'), 'R4 show on an unborn rescue lists every file as added');
fs.rmSync(path.join(unborn, 'a.txt'));
write(unborn, 'b.txt', 'changed b\n');
fs.rmSync(path.join(unborn, 'sp ace'), { recursive: true, force: true });
const ubBack = restoreRescue({ repoRoot: unborn, id: ub.id });
ok(ubBack.ok && read(unborn, 'a.txt').toString() === 'untracked a\n' && read(unborn, 'b.txt').toString() === 'staged b\n'
  && read(unborn, 'sp ace/ü.txt').toString() === 'unicode in a folder with a space\n',
'R3 restore on an unborn branch writes the files back');
ok(sameIndex(ubIndex, indexState(unborn)), 'R3 …and leaves the staged index entry exactly as it was');

// ── R2: folders, size caps, budget, environment ───────────────────────────────
const misc = makeRepo('misc repo');
write(misc, '.gitignore', '*.env\n');
write(misc, 'base.txt', 'base\n');
git(misc, ['add', '.']);
git(misc, ['commit', '-q', '-m', 'seed']);
write(misc, 'newdir/a.txt', 'a\n');
write(misc, 'newdir/sub/b.txt', 'b\n');
write(misc, 'newdir/x.env', 'ignored inside a folder\n');
const fold = createRescue({ repoRoot: misc, paths: ['newdir'], sid: 'fold', reason: 'before `git clean -fd`' });
ok(fold.ok && JSON.stringify(fold.paths) === JSON.stringify(['newdir/a.txt', 'newdir/sub/b.txt']) && whyOf(fold, 'newdir/x.env') === 'ignored',
  'R2 a folder expands to its untracked, non-ignored files; ignored files inside are listed', fold);

write(misc, 'f5.txt', '12345');
write(misc, 'f8.txt', '12345678');
write(misc, 'f9.txt', '123456789');
write(misc, 'f12.txt', '123456789012');
const capped = createRescue({ repoRoot: misc, paths: ['f5.txt', 'f8.txt', 'f9.txt', 'f12.txt'], sid: 'caps', reason: 'caps', maxFileBytes: 10, maxTotalBytes: 15 });
ok(capped.ok && JSON.stringify(capped.paths) === JSON.stringify(['f5.txt', 'f8.txt'])
  && /limit/.test(whyOf(capped, 'f12.txt') || '') && /total/.test(whyOf(capped, 'f9.txt') || ''),
'R2 a file over the per-file cap is listed; past the total cap the largest are dropped first and listed', capped);

const refsBefore = refsOf(misc);
const miscIndex = indexState(misc);
const slow = createRescue({ repoRoot: misc, paths: ['base.txt', 'f5.txt'], sid: 'slow', reason: 'budget', budgetMs: 1 });
ok(!slow.ok && /took too long/.test(slow.error) && refsOf(misc) === refsBefore && sameIndex(miscIndex, indexState(misc)) && gitDirLeftovers(misc).length === 0,
  'R1 out of time: ok:false "took too long", no ref, index untouched, nothing left behind', slow);

const nothing = createRescue({ repoRoot: misc, paths: ['x.env'], sid: 's', reason: 'only ignored' });
ok(!nothing.ok && nothing.error === 'nothing to rescue' && whyOf(nothing, 'x.env') === 'ignored' && refsOf(misc) === refsBefore,
  'R2 nothing rescuable → ok:false "nothing to rescue", no ref, and the reason listed', nothing);
ok(!createRescue({ repoRoot: path.join(ROOT, 'no such folder'), paths: ['a'] }).ok && !createRescue({ repoRoot: HOME, paths: ['a'] }).ok,
  'R1 a missing folder or a folder outside any repository answers ok:false, never throws');

{
  // An existing ref is never overwritten: force the id's 4 random hex to
  // collide once with a ref that is already there.
  const headSha = git(misc, ['rev-parse', 'HEAD']).trim();
  const taken = 'refs/klypix/rescue/20260102-030405-collide-abab';
  git(misc, ['update-ref', taken, headSha]);
  const original = crypto.randomBytes;
  let draws = 0;
  crypto.randomBytes = (n, ...rest) => (n === 2 && !rest.length ? Buffer.from(draws++ === 0 ? [0xab, 0xab] : [0xcd, 0xcd]) : original.call(crypto, n, ...rest));
  let col;
  try {
    col = createRescue({ repoRoot: misc, paths: ['base.txt'], sid: 'collide', reason: 'collision', now: Date.UTC(2026, 0, 2, 3, 4, 5) });
  } finally { crypto.randomBytes = original; }
  ok(draws >= 2 && col.ok && col.id === '20260102-030405-collide-cdcd' && git(misc, ['rev-parse', taken]).trim() === headSha
    && git(misc, ['rev-parse', col.ref]).trim() === col.commit,
  'R1 an id that collides with an existing ref gets a fresh name; the existing ref is left exactly as it was', col);
  git(misc, ['update-ref', '-d', taken]);
}

// A hook can inherit GIT_DIR / GIT_INDEX_FILE / GIT_LITERAL_PATHSPECS from a parent git.
const bogusIndex = path.join(ROOT, 'bogus.index');
const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_LITERAL_PATHSPECS: process.env.GIT_LITERAL_PATHSPECS };
process.env.GIT_DIR = path.join(ROOT, 'bogus.git');
process.env.GIT_INDEX_FILE = bogusIndex;
process.env.GIT_LITERAL_PATHSPECS = '1';
write(misc, 'env-test.txt', 'env\n');
const envRes = createRescue({ repoRoot: misc, paths: ['env-test.txt', 'x.env'], sid: 'env', reason: 'env' });
for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
ok(envRes.ok && JSON.stringify(envRes.paths) === '["env-test.txt"]' && whyOf(envRes, 'x.env') === 'ignored'
  && !fs.existsSync(bogusIndex) && !fs.existsSync(path.join(ROOT, 'bogus.git')),
'R1 an inherited GIT_DIR / GIT_INDEX_FILE / GIT_LITERAL_PATHSPECS cannot redirect or break the rescue', envRes);

if (!WIN) {
  fs.symlinkSync('base.txt', path.join(misc, 'link-to-base'));
  const lr = createRescue({ repoRoot: misc, paths: ['link-to-base'], sid: 'link', reason: 'link' });
  ok(lr.ok && git(misc, ['ls-tree', lr.commit, '--', 'link-to-base']).startsWith('120000 '), 'R2 a symbolic link is copied as a link (POSIX)');
  fs.rmSync(path.join(misc, 'link-to-base'));
  const lb = restoreRescue({ repoRoot: misc, id: lr.id });
  ok(lb.ok && fs.lstatSync(path.join(misc, 'link-to-base')).isSymbolicLink() && fs.readlinkSync(path.join(misc, 'link-to-base')) === 'base.txt',
    'R3 …and restored as a link (POSIX)');
}

// ── Review fixes (2026-10-19): folders, time budget, links, case, junction, cwd ─
{
  // F1  A folder (and '.') means what `git add -- <folder>` means: tracked
  //     files that differ from HEAD are in it, not only untracked ones — they
  //     are exactly what `checkout -- <dir>` / `restore .` / `reset --hard`
  //     throw away.
  const fr = makeRepo('folder pathspec repo');
  write(fr, 'src/a.txt', 'committed\n');
  write(fr, 'src/same.txt', 'never changed\n');
  write(fr, 'src/staged.txt', 'staged v1\n');
  write(fr, 'src/gone.txt', 'deleted later\n');
  write(fr, 'top.txt', 'committed top\n');
  write(fr, '.gitignore', '*.env\n');
  git(fr, ['add', '.']);
  git(fr, ['commit', '-q', '-m', 'seed']);
  write(fr, 'src/a.txt', 'UNCOMMITTED WORK\n');
  write(fr, 'src/staged.txt', 'staged v2\n');
  git(fr, ['add', 'src/staged.txt']);
  fs.rmSync(path.join(fr, 'src/gone.txt'));
  write(fr, 'src/new.txt', 'untracked\n');
  write(fr, 'src/k.env', 'ignored\n');
  write(fr, 'top.txt', 'UNCOMMITTED TOP\n');
  const idxBefore = indexState(fr);
  const treeBefore = treeSnapshot(fr);
  const sub = createRescue({ repoRoot: fr, paths: ['src'], sid: 'fold2', reason: 'git checkout -- src' });
  ok(sub.ok && JSON.stringify(sub.paths) === JSON.stringify(['src/a.txt', 'src/gone.txt', 'src/new.txt', 'src/staged.txt'])
    && JSON.stringify(sub.deleted) === '["src/gone.txt"]' && whyOf(sub, 'src/k.env') === 'ignored'
    && blobAt(fr, sub.commit, 'src/a.txt').toString() === 'UNCOMMITTED WORK\n',
  'F1 a folder holds its modified, staged and deleted tracked files plus untracked ones (unchanged and ignored left out)', sub);
  const dot = createRescue({ repoRoot: fr, paths: ['.'], sid: 'fold2', reason: 'git restore .' });
  ok(dot.ok && JSON.stringify(dot.paths) === JSON.stringify(['src/a.txt', 'src/gone.txt', 'src/new.txt', 'src/staged.txt', 'top.txt']),
    "F1 '.' is the whole repository, not 'not a file path'", dot);
  const viaTop = createRescue({ repoRoot: fr, paths: [fr], sid: 'fold3', reason: 'toplevel path' });
  ok(viaTop.ok && viaTop.paths.includes('top.txt'), 'F1 the toplevel as an absolute path is the whole repository too', viaTop);
  ok(sameIndex(idxBefore, indexState(fr)) && treeSnapshot(fr) === treeBefore && gitDirLeftovers(fr).length === 0,
    'F1 …and expanding folders leaves the index, the working tree and .git exactly as they were');
  git(fr, ['checkout', '--', 'src']);
  git(fr, ['reset', '-q', '--hard']);
  const back = restoreRescue({ repoRoot: fr, id: dot.id, paths: ['.'] });
  ok(back.ok && read(fr, 'src/a.txt').toString() === 'UNCOMMITTED WORK\n' && read(fr, 'top.txt').toString() === 'UNCOMMITTED TOP\n'
    && read(fr, 'src/staged.txt').toString() === 'staged v2\n' && !exists(fr, 'src/gone.txt'),
  "F1 after `checkout -- src` + `reset --hard`, restoring '.' brings every tracked edit back", back);
}

{
  // F2/F3  The 2.5 s budget is kept by leaving out what the time cannot
  //        write, largest first — a big fresh binary never costs a small
  //        source edit its copy, and a human-run restore (minutes) still
  //        saves files up to the 50 MB cap.
  const br = makeRepo('budget repo');
  write(br, 'a.txt', 'a\n');
  git(br, ['add', '.']);
  git(br, ['commit', '-q', '-m', 'seed']);
  write(br, 'a.txt', 'IMPORTANT SOURCE EDIT\n');
  write(br, 'data0.bin', crypto.randomBytes(20 * 1024 * 1024));
  write(br, 'data1.bin', crypto.randomBytes(20 * 1024 * 1024));
  const t0 = Date.now();
  const quick = createRescue({ repoRoot: br, paths: ['a.txt', 'data0.bin', 'data1.bin'], sid: 'budget', reason: 'git reset --hard' });
  const took = Date.now() - t0;
  ok(quick.ok && JSON.stringify(quick.paths) === '["a.txt"]' && /too large to save in the 2\.5 s/.test(whyOf(quick, 'data0.bin') || '')
    && /too large to save/.test(whyOf(quick, 'data1.bin') || '') && blobAt(br, quick.commit, 'a.txt').toString() === 'IMPORTANT SOURCE EDIT\n'
    && took < RESCUE_BUDGET_MS + 1000 && gitDirLeftovers(br).length === 0,
  `F2/F3 two fresh 20 MB binaries: the source edit is saved, the binaries listed as too large for the time, within budget (${took} ms)`, quick);
  const roomy = createRescue({ repoRoot: br, paths: ['a.txt', 'data0.bin'], sid: 'budget', reason: 'before restoring', budgetMs: 120_000 });
  ok(roomy.ok && JSON.stringify(roomy.paths) === '["a.txt","data0.bin"]' && blobAt(br, roomy.commit, 'data0.bin').equals(read(br, 'data0.bin')),
    'F3 with a restore-sized budget the same 20 MB file is saved (the caps, not the clock, decide)', roomy.skipped);
}

{
  // F4  A symbolic link stays a link: an unchanged link is left alone, a
  //     removed one comes back as a link, and the undo does not turn it into
  //     a file holding its target (Windows included, where links can be made).
  const lr = makeRepo('link repo');
  write(lr, 'target.txt', 'T\n');
  git(lr, ['add', '.']);
  git(lr, ['commit', '-q', '-m', 'seed']);
  let canLink = true;
  try { fs.symlinkSync('target.txt', path.join(lr, 'lnk')); } catch { canLink = false; }
  if (canLink) {
    write(lr, 'other.txt', 'x\n');
    const lk = createRescue({ repoRoot: lr, paths: ['lnk', 'other.txt'], sid: 'link', reason: 'link' });
    ok(lk.ok && git(lr, ['ls-tree', lk.commit, '--', 'lnk']).startsWith('120000 ') && blobAt(lr, lk.commit, 'lnk').toString() === 'target.txt',
      'F4 a link is saved as a link whose target uses / (as git stores it)', lk);
    write(lr, 'other.txt', 'changed\n');
    const rs = restoreRescue({ repoRoot: lr, id: lk.id });
    ok(rs.ok && JSON.stringify(rs.restored) === '["other.txt"]' && rs.unchanged.includes('lnk') && fs.lstatSync(path.join(lr, 'lnk')).isSymbolicLink(),
      'F4 restore leaves an unchanged link alone (it is not rewritten as a file)', rs);
    const undo = restoreRescue({ repoRoot: lr, id: rs.backupId });
    ok(undo.ok && fs.lstatSync(path.join(lr, 'lnk')).isSymbolicLink() && read(lr, 'other.txt').toString() === 'changed\n',
      'F4 …and its undo keeps the link a link', undo);
    fs.rmSync(path.join(lr, 'lnk'));
    const again = restoreRescue({ repoRoot: lr, id: lk.id, paths: ['lnk'] });
    ok(again.ok && fs.lstatSync(path.join(lr, 'lnk')).isSymbolicLink() && read(lr, 'lnk').toString() === 'T\n',
      'F4 a removed link is restored as a link to the same target', again);
  } else ok(true, 'F4 (skipped: this system cannot create symbolic links)');
}

if (WIN) {
  // F5  A path given in another case (the lowercased ledger key) is saved
  //     under its real spelling, so show and restore agree with the copy.
  const cr = makeRepo('case repo');
  write(cr, 'Src/Foo.TXT', 'v1\n');
  git(cr, ['add', '.']);
  git(cr, ['commit', '-q', '-m', 'seed']);
  write(cr, 'Src/Foo.TXT', 'WORK\n');
  write(cr, 'Docs/Note.md', 'untracked note\n');
  const cs = createRescue({ repoRoot: cr, paths: ['src/foo.txt', 'docs/note.md'], sid: 'case', reason: 'case' });
  ok(cs.ok && JSON.stringify(cs.paths) === '["Docs/Note.md","Src/Foo.TXT"]' && blobAt(cr, cs.commit, 'Src/Foo.TXT').toString() === 'WORK\n',
    'F5 tracked and untracked paths in another case are recorded under their real spelling', cs);
  const sh = showRescue({ repoRoot: cr, id: cs.id });
  ok(sh.ok && sh.files.find((f) => f.path === 'Src/Foo.TXT')?.change === 'modified', 'F5 show reports the file as modified, not "same as HEAD"', sh.files);
  git(cr, ['checkout', '--', '.']);
  const rc = restoreRescue({ repoRoot: cr, id: cs.id, paths: ['src/foo.txt'] });
  ok(rc.ok && JSON.stringify(rc.restored) === '["Src/Foo.TXT"]' && read(cr, 'Src/Foo.TXT').toString() === 'WORK\n',
    'F5 restore (asked in any case) writes the work back', rc);
}

{
  // F6  A repository reached through a junction / folder symlink works.
  const jr = makeRepo('junction repo');
  write(jr, 'a.txt', 'v1\n');
  git(jr, ['add', '.']);
  git(jr, ['commit', '-q', '-m', 'seed']);
  write(jr, 'a.txt', 'WORK\n');
  const link = path.join(ROOT, 'junction link');
  let linked = true;
  try { fs.symlinkSync(jr, link, 'junction'); } catch { linked = false; }
  if (linked) {
    const jx = createRescue({ repoRoot: link, paths: ['a.txt', path.join(link, 'a.txt')], sid: 'junction', reason: 'junction' });
    ok(jx.ok && JSON.stringify(jx.paths) === '["a.txt"]' && listRescues({ repoRoot: link }).some((e) => e.id === jx.id),
      'F6 createRescue and list work through a junction (an absolute path through it maps onto the repository)', jx);
    git(jr, ['checkout', '--', 'a.txt']);
    const jb = restoreRescue({ repoRoot: link, id: jx.id });
    ok(jb.ok && read(jr, 'a.txt').toString() === 'WORK\n', 'F6 …and restore does too', jb);
  } else ok(true, 'F6 (skipped: this system cannot create a folder link)');
}

{
  // F7  `restore <id> foo.txt` typed in src/ means src/foo.txt, as in git;
  //     the repository-relative reading is only the fallback.
  const cw = makeRepo('cwd repo');
  write(cw, 'foo.txt', 'root v1\n');
  write(cw, 'src/foo.txt', 'src v1\n');
  write(cw, 'src/only.txt', 'only v1\n');
  git(cw, ['add', '.']);
  git(cw, ['commit', '-q', '-m', 'seed']);
  write(cw, 'foo.txt', 'root WORK\n');
  write(cw, 'src/foo.txt', 'src WORK\n');
  write(cw, 'src/only.txt', 'only WORK\n');
  const cc = createRescue({ repoRoot: cw, paths: ['foo.txt', 'src/foo.txt', 'src/only.txt'], sid: 'cwd', reason: 'cwd' });
  git(cw, ['checkout', '--', '.']);
  const fromSrc = restoreRescue({ repoRoot: path.join(cw, 'src'), id: cc.id, paths: ['foo.txt'], cwd: path.join(cw, 'src') });
  ok(fromSrc.ok && JSON.stringify(fromSrc.restored) === '["src/foo.txt"]' && read(cw, 'foo.txt').toString() === 'root v1\n'
    && read(cw, 'src/foo.txt').toString() === 'src WORK\n',
  'F7 a relative path from a subfolder restores that subfolder\'s file, not the root one', fromSrc);
  const fallback = restoreRescue({ repoRoot: path.join(cw, 'src'), id: cc.id, paths: ['src/only.txt'], cwd: path.join(cw, 'src') });
  ok(fallback.ok && JSON.stringify(fallback.restored) === '["src/only.txt"]', 'F7 …and a repository-relative path still works from there', fallback);
}

// ── R4: prune keeps the newest N ──────────────────────────────────────────────
const pr = makeRepo('prune repo');
write(pr, 'p.txt', 'seed\n');
git(pr, ['add', '.']);
git(pr, ['commit', '-q', '-m', 'seed']);
const DAY = 86400000;
const base = Date.now();
const made = [];
for (let i = 0; i < 6; i++) {
  write(pr, 'p.txt', `old ${i}\n`);
  made.push(createRescue({ repoRoot: pr, paths: ['p.txt'], sid: `old${i}`, reason: `old ${i}`, now: base - 30 * DAY + i * 60000 }));
}
for (let i = 0; i < 2; i++) {
  write(pr, 'p.txt', `recent ${i}\n`);
  made.push(createRescue({ repoRoot: pr, paths: ['p.txt'], sid: `new${i}`, reason: `recent ${i}`, now: base - (2 - i) * 60000 }));
}
ok(made.every((m) => m.ok) && listRescues({ repoRoot: pr }).length === 8, 'R4 (setup) eight rescues: six 30 days old, two recent');
const order = listRescues({ repoRoot: pr }).map((e) => e.reason);
ok(JSON.stringify(order) === JSON.stringify(['recent 1', 'recent 0', 'old 5', 'old 4', 'old 3', 'old 2', 'old 1', 'old 0']), 'R4 listRescues is newest first', order);
const dry = pruneRescues({ repoRoot: pr, keep: 3, maxAgeMs: 14 * DAY, dryRun: true });
ok(dry.ok && dry.wouldDelete?.length === 5 && listRescues({ repoRoot: pr }).length === 8, 'R4 prune --dry-run names five and deletes nothing', dry);
const pruned = pruneRescues({ repoRoot: pr, keep: 3, maxAgeMs: 14 * DAY });
const left = listRescues({ repoRoot: pr }).map((e) => e.reason);
ok(pruned.ok && pruned.deleted.length === 5 && JSON.stringify(left) === JSON.stringify(['recent 1', 'recent 0', 'old 5']),
  'R4 prune keeps the newest N (3) and deletes the older, expired ones', left);
ok(made.slice(0, 5).every((m) => !gitTry(pr, ['rev-parse', '-q', '--verify', m.ref]).ok), 'R4 the pruned refs are gone from git');
const keep0 = pruneRescues({ repoRoot: pr, keep: 0, maxAgeMs: 14 * DAY });
ok(keep0.ok && JSON.stringify(listRescues({ repoRoot: pr }).map((e) => e.reason)) === JSON.stringify(['recent 1', 'recent 0']),
  'R4 a copy younger than maxAge is never pruned, even with keep 0');

// ── R1: another worktree, and a concurrent `git add` loop ─────────────────────
const wt2 = path.join(ROOT, 'second worktree');
git(main, ['worktree', 'add', '-q', '-b', 'second', wt2]);
ok(listRescues({ repoRoot: wt2 }).length === 0 && listRescues({ repoRoot: wt2, allWorktrees: true }).some((e) => e.id === r1.id && e.here === false),
  'R4 a linked worktree lists only its own copies; allWorktrees shows the others, marked as elsewhere');
const refused = restoreRescue({ repoRoot: wt2, id: r1.id });
ok(!refused.ok && /another worktree/.test(refused.error), 'R3 restore refuses a copy taken in another worktree', refused);
const allowed = restoreRescue({ repoRoot: wt2, id: r1.id, paths: ['new file.txt'], allowOtherWorktree: true });
ok(allowed.ok && read(wt2, 'new file.txt').equals(preBytes.get('new file.txt')), 'R3 …unless explicitly allowed');
{
  // `list --all` must not number another worktree's copies: <n> means this worktree's list.
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'klypix-rescue.mjs'), 'list', '--all'], {
    cwd: wt2, encoding: 'utf8', timeout: 120_000, env: { ...GIT_ENV, HOME, USERPROFILE: HOME },
  });
  const lines = String(r.stdout).split('\n');
  ok(r.status === 0 && lines.some((l) => l.startsWith(`    1  ${allowed.backupId}`)) && lines.some((l) => l.startsWith(`    -  ${r1.id}`)),
    'R5 `list --all` numbers only this worktree\'s copies (others show "-"), matching `show <n>`', r.stdout);
}
git(main, ['worktree', 'remove', '--force', wt2]);

{
  const loopRepo = makeRepo('loop repo');
  write(loopRepo, 'loop.txt', 'seed\n');
  write(loopRepo, 'mine.txt', 'mine v1\n');
  git(loopRepo, ['add', '.']);
  git(loopRepo, ['commit', '-q', '-m', 'seed']);
  const script = [
    "const { execFileSync } = require('child_process');",
    "const fs = require('fs');",
    'let fails = 0, runs = 0; const end = Date.now() + 2500;',
    "while (Date.now() < end) { fs.writeFileSync('loop.txt', 'run ' + runs + '\\n'); try { execFileSync('git', ['add', 'loop.txt'], { stdio: 'ignore' }); } catch { fails++; } runs++; }",
    'process.stdout.write(JSON.stringify({ fails, runs }));',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd: loopRepo, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  const results = [];
  const until = Date.now() + 2000;
  for (let i = 0; Date.now() < until && i < 8; i++) {
    write(loopRepo, 'mine.txt', `mine v${i + 2}\n`);
    results.push(createRescue({ repoRoot: loopRepo, paths: ['mine.txt'], sid: 'loop', reason: 'concurrent' }));
  }
  await done;
  let loop = { fails: -1, runs: 0 };
  try { loop = JSON.parse(childOut); } catch { /* reported below */ }
  ok(results.length > 0 && results.every((r) => r.ok), `R1 rescues taken while another process runs \`git add\` in a loop all succeed (${results.length})`);
  ok(loop.fails === 0 && loop.runs > 0, `R1 …and that loop's ${loop.runs} \`git add\` calls never failed (no index.lock taken by the rescue)`, loop);
}

// ── R5: the CLI — standalone bin and dispatcher ───────────────────────────────
const RESCUE_BIN = path.join(REPO, 'bin', 'klypix-rescue.mjs');
const MCP_BIN = path.join(REPO, 'bin', 'klypix-mcp.mjs');
const cli = (args, cwd = main) => {
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...GIT_ENV, HOME, USERPROFILE: HOME, KLYPIX_BRAIN_DIR: path.join(HOME, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0' },
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};
const help = cli([MCP_BIN, '--help']);
ok(help.code === 0 && /\brescue \[list\|show <id>\|restore <id> \[paths…\]\|prune\]/.test(help.out), 'R5 `klypix-mcp --help` lists the rescue verb');
const ownHelp = cli([RESCUE_BIN, '--help']);
ok(ownHelp.code === 0 && /npx klypix-mcp rescue restore <n\|id> \[paths…\]/.test(ownHelp.out), 'R5 `rescue --help` prints its usage');
const listBin = cli([RESCUE_BIN, 'list', '--json']);
const listDispatch = cli([MCP_BIN, 'rescue', 'list', '--json']);
ok(listBin.code === 0 && listBin.out === listDispatch.out && listBin.code === listDispatch.code,
  'R5 PARITY: `list --json` is byte-identical from the bin and from `klypix-mcp rescue`', listDispatch.err);
let parsed = null;
try { parsed = JSON.parse(listBin.out); } catch { /* reported below */ }
ok(Array.isArray(parsed) && parsed.some((e) => e.id === r1.id), 'R5 `list --json` is the listRescues array');
const textList = cli([MCP_BIN, 'rescue']);
ok(textList.code === 0 && textList.out.includes(r1.id) && /npx klypix-mcp rescue restore <n\|id>/.test(textList.out), 'R5 bare `klypix-mcp rescue` lists the copies with the restore command');
const showBin = cli([RESCUE_BIN, 'show', r1.id]);
const showDispatch = cli([MCP_BIN, 'rescue', 'show', r1.id]);
ok(showBin.code === 0 && showBin.out === showDispatch.out && /modified +tracked\.txt/.test(showBin.out) && /secret\.env \(ignored\)/.test(showBin.out),
  'R5 PARITY: `show <id>` is identical from both shapes and names what was not included', showBin.out);
write(main, 'tracked.txt', 'edited again after the rescue\n');
const cliRestore = cli([MCP_BIN, 'rescue', 'restore', r1.id, 'tracked.txt']);
const undoId = /Undo this restore: npx klypix-mcp rescue restore (\S+)/.exec(cliRestore.out)?.[1];
ok(cliRestore.code === 0 && read(main, 'tracked.txt').equals(preBytes.get('tracked.txt')) && undoId,
  'R5 `klypix-mcp rescue restore <id> <path>` restores and prints the undo command', cliRestore.out + cliRestore.err);
const cliUndo = cli([MCP_BIN, 'rescue', 'restore', undoId || 'missing']);
ok(cliUndo.code === 0 && read(main, 'tracked.txt').toString() === 'edited again after the rescue\n', 'R5 …and that undo command gives the edit back');
const bad = cli([MCP_BIN, 'rescue', 'restore', 'no-such-rescue']);
ok(bad.code === 1 && /Restore failed: no rescue "no-such-rescue"/.test(bad.err), 'R5 an unknown id exits 1 with the reason');
const flag = cli([RESCUE_BIN, 'list', '--bogus']);
ok(flag.code === 2 && /unknown flag --bogus/.test(flag.err), 'R5 an unknown flag exits 2 with the usage');
const dryCli = cli([MCP_BIN, 'rescue', 'prune', '--dry-run', '--days', '0', '--keep', '1']);
ok(dryCli.code === 0 && /DRY RUN — nothing was deleted\./.test(dryCli.out), 'R5 `rescue prune --dry-run` deletes nothing');

// ── R1: the source never reaches for a shell ──────────────────────────────────
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'whose-rescue.mjs'), 'utf8').replace(/\r/g, '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The only child_process import is execFileSync (no exec/execSync/spawn can
  // be reached), nothing loads child_process another way, and no call passes
  // a `shell` option. (`.exec(` in the source is RegExp#exec.)
  ok((code.match(/child_process/g) || []).length === 1 && /^import \{ execFileSync \} from 'child_process';$/m.test(code)
    && !/\brequire\(|\bimport\(/.test(code) && !/\bshell\s*:/.test(code),
  'R1 git runs through execFileSync argument arrays only (no exec, no execSync, no spawn, no shell option)');
  ok((code.match(/execFileSync\(/g) || []).length === 1 && /GIT_OPTIONAL_LOCKS: '0'/.test(code),
    'R1 one git runner, and it sets GIT_OPTIONAL_LOCKS=0');
  ok(!/GIT_INDEX_FILE: (?!path\.join\(ctx\.gitDir, 'klypix-rescue')/.test(code),
    'R1 the only GIT_INDEX_FILE the module sets is its never-created guard path');
}

fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures
  ? `\n[x] whose-rescue: ${failures} of ${checks} assertion(s) failed`
  : `\n[ok] whose-rescue: all ${checks} assertions passed`);
process.exit(failures ? 1 : 0);
