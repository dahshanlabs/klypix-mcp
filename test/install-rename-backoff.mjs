// Installer rename hardening (1.71.1) — the first command a user types must
// outlast a transient Windows lock.
//
// Every atomic commit in bin/klypix-install.mjs is a rename-over-destination.
// On Windows that throws EPERM/EBUSY/EACCES whenever any process briefly holds
// the target — an AV scan, an indexer, or (routinely on a developer machine)
// the live MCP servers reading the very bundle being replaced. Measured
// 2026-08-15: three failures in one session with 7-14 servers live, on
// .mcp-runtime.json and brain-history.mjs; every retry succeeded immediately.
//
// The brain's own write funnel has carried a bounded backoff since 1.68.0
// (klypix-format.mjs atomicWrite). This asserts the installer now matches it:
//   R1 — a transient EPERM is survived, and the file really is committed.
//   R2 — EBUSY and EACCES are treated identically; they are the same condition
//        wearing different names on different Windows configurations.
//   R3 — a NON-retryable error (ENOENT) is rethrown IMMEDIATELY. Retrying a
//        missing source would turn a clear bug into a 2.7s mystery.
//   R4 — a PERSISTENT holder still throws rather than reporting success. A
//        delayed install is acceptable; claiming to have written a file that
//        was never written is not.
//   R5 — the persistent failure NAMES the real cause and the fix. "EPERM:
//        operation not permitted" is unactionable; the user needs to be told a
//        process holds the file and that nothing was left half-written.
//   R6 — the backoff is bounded and ordered (ascending, ~2.7s total), so a
//        genuine failure surfaces in seconds rather than hanging the install.
//   R7 — every atomic commit in the installer routes through the hardened
//        helper; a bare fs.renameSync among them is the regression this suite
//        exists to prevent.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(__dirname, '..', 'bin', 'klypix-install.mjs');
const source = fs.readFileSync(INSTALLER, 'utf8');

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };

// The helper is defined at module scope in an installer that performs its work
// on import, so it cannot simply be imported here. Extract and evaluate the
// three declarations under test — the assertions below therefore run against
// the SHIPPING source text, not a copy that can drift.
function loadHelper() {
  const grab = (re, what) => {
    const m = source.match(re);
    assert.ok(m, `could not find ${what} in bin/klypix-install.mjs`);
    return m[0];
  };
  const codes = grab(/const RENAME_RETRYABLE_CODES = new Set\(\[[^\]]*\]\);/, 'RENAME_RETRYABLE_CODES');
  const backoff = grab(/const RENAME_BACKOFF_MS = \[[^\]]*\];/, 'RENAME_BACKOFF_MS');
  const fn = grab(/function renameSyncWithBackoff\(from, to\) \{[\s\S]*?\n\}/, 'renameSyncWithBackoff');
  // A fake clock: the real helper sleeps ~2.7s in total, which no test should pay.
  const slept = [];
  const factory = new Function('fs', 'path', 'retrySleepSync', 'Atomics',
    `${codes}\n${backoff}\n${fn}\nreturn { renameSyncWithBackoff, RENAME_BACKOFF_MS, RENAME_RETRYABLE_CODES };`);
  const api = factory(fs, path, (ms) => slept.push(ms), Atomics);
  return { ...api, slept };
}

const { renameSyncWithBackoff, RENAME_BACKOFF_MS, RENAME_RETRYABLE_CODES, slept } = loadHelper();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-rename-'));
try {
  // ---- R6 — the policy itself --------------------------------------------
  ok('R6 the backoff is bounded', RENAME_BACKOFF_MS.length >= 3 && RENAME_BACKOFF_MS.length <= 8);
  ok('R6 delays ascend', RENAME_BACKOFF_MS.every((ms, i) => i === 0 || ms > RENAME_BACKOFF_MS[i - 1]));
  const total = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0);
  ok('R6 total wait outlasts a transient hold but stays under 5s', total >= 1500 && total <= 5000);
  ok('R6 all three Windows lock codes are retryable',
    ['EPERM', 'EBUSY', 'EACCES'].every((c) => RENAME_RETRYABLE_CODES.has(c)));

  // ---- R1 / R2 — a transient holder is survived ---------------------------
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const from = path.join(tmp, `src-${code}`);
    const to = path.join(tmp, `dst-${code}`);
    fs.writeFileSync(from, `committed-${code}`);

    const real = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (a, b) => {
      attempts += 1;
      if (attempts <= 2) { const e = new Error(`${code}: simulated transient hold`); e.code = code; throw e; }
      return real.call(fs, a, b);
    };
    try { renameSyncWithBackoff(from, to); } finally { fs.renameSync = real; }

    ok(`R1/R2 ${code} is retried rather than thrown`, attempts === 3);
    ok(`R1/R2 ${code} — the file is actually committed`, fs.readFileSync(to, 'utf8') === `committed-${code}`);
    ok(`R1/R2 ${code} — the source no longer exists`, !fs.existsSync(from));
  }
  ok('R1 it slept between attempts rather than spinning', slept.length >= 6);
  ok('R1 the first delay is the shortest', slept[0] === RENAME_BACKOFF_MS[0]);

  // ---- R3 — a real bug must not be masked by retries ----------------------
  {
    const real = fs.renameSync;
    let attempts = 0;
    fs.renameSync = () => { attempts += 1; const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; };
    let threw = null;
    try { renameSyncWithBackoff(path.join(tmp, 'nope'), path.join(tmp, 'nope2')); }
    catch (e) { threw = e; }
    finally { fs.renameSync = real; }
    ok('R3 a non-retryable error is rethrown', threw?.code === 'ENOENT');
    ok('R3 and it is rethrown on the FIRST attempt, not after the backoff', attempts === 1);
    ok('R3 its message is left untouched', !/held by another process/.test(threw.message));
  }

  // ---- R4 / R5 — a persistent holder fails honestly and usefully ----------
  {
    const real = fs.renameSync;
    let attempts = 0;
    fs.renameSync = () => { attempts += 1; const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
    let threw = null;
    try { renameSyncWithBackoff(path.join(tmp, 'a'), path.join(tmp, '.mcp-runtime.json')); }
    catch (e) { threw = e; }
    finally { fs.renameSync = real; }

    ok('R4 a persistent holder still throws — never a false success', threw?.code === 'EPERM');
    ok('R4 it gave up only after exhausting the backoff', attempts === RENAME_BACKOFF_MS.length + 1);
    ok('R5 the message names the file that is held', /\.mcp-runtime\.json/.test(threw.message));
    ok('R5 it says a process holds it, not just "not permitted"', /held by another process/i.test(threw.message));
    ok('R5 it names the likely culprits', /MCP server|antivirus|indexer/i.test(threw.message));
    ok('R5 it gives an actionable next step', /Close your editors|run the command again/i.test(threw.message));
    ok('R5 it reassures that nothing was half-written', /half-written/i.test(threw.message));
  }

  // ---- R7 — no atomic commit escapes the hardened path --------------------
  {
    // Strip the helper's own body before counting, so its internal call does
    // not read as an unhardened commit.
    const withoutHelper = source.replace(/function renameSyncWithBackoff\(from, to\) \{[\s\S]*?\n\}/, '');
    const bare = withoutHelper.match(/fs\.renameSync\(/g) || [];
    ok('R7 every atomic commit routes through renameSyncWithBackoff', bare.length === 0);
    const hardened = source.match(/renameSyncWithBackoff\(/g) || [];
    ok('R7 all four commits are hardened (bundle, settings, runtime, version)', hardened.length >= 5);
    ok('R7 there is exactly one retry-sleep helper, not a duplicated one',
      (source.match(/const \w*[sS]leepSync = /g) || []).length === 1);
  }

  console.log(`✓ installer rename backoff — ${pass}/${pass} assertions`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
