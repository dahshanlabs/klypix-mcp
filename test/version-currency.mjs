// Regression test for ambient version-currency surfacing — the brain announces its
// OWN staleness without anyone running `doctor`. Two halves:
//   UNIT (hermetic, injected fetcher) — the footer is network-free + correct
//     (stale → one line; current/ahead → silent; missing/"(offline)"/no-baked →
//     silent); the refresh is throttled (≤ once/day), failure-silent, caches latest.
//   E2E (subprocess, NO network) — the REAL hook in SessionStart mode emits the line
//     from a stale cache AND leaves the cache file byte-identical, proving session
//     start makes zero npm calls (the refresh lives only on the Stop path).
//
// Run:  node test/version-currency.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeVault, seedBrain } from './_harness.mjs';

// Import the hook WITHOUT running main()/exiting this test process (the opt-out flag).
process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
const { refreshNpmCurrency, versionCurrencyFooter } = await import('../src/global-brain-hook.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const dir = path.join(os.tmpdir(), 'klypix-currency-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const cacheFile = path.join(dir, '.npm-currency.json');
fs.writeFileSync(path.join(dir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '1.13.0'; // baked\n`);
const writeCache = (o) => fs.writeFileSync(cacheFile, JSON.stringify(o));
const footer = () => versionCurrencyFooter({ file: cacheFile, brainDir: dir });

// ── UNIT — footer behavior (pure fs, no network) ────────────────────────────
fs.rmSync(cacheFile, { force: true });
ok(footer() === '', 'missing cache → silent');

writeCache({ pkg: 'klypix-mcp', latest: '1.13.0', checkedAt: 1 });
ok(footer() === '', 'current (latest == baked) → silent');

writeCache({ pkg: 'klypix-mcp', latest: '1.12.9', checkedAt: 1 });
ok(footer() === '', 'ahead (baked > latest) → silent');

writeCache({ pkg: 'klypix-mcp', latest: '(offline)', checkedAt: 1 });
ok(footer() === '', 'sentinel "(offline)" latest → silent');

// Defense-in-depth: a hand-corrupted cache with a non-semver `latest` must not
// false-nag (bare number) or false-silence-wrongly — the strict semver guard
// rejects anything not matching N.N.N before comparing.
for (const bad of ['123', 'v1.14.0', 'latest', '1.14', '']) {
    writeCache({ pkg: 'klypix-mcp', latest: bad, checkedAt: 1 });
    ok(footer() === '', `malformed cache latest ${JSON.stringify(bad)} → silent (strict semver guard)`);
}

writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: 1 });
const line = footer();
ok(/v1\.13\.0/.test(line) && /v1\.14\.0/.test(line) && /npx klypix-mcp install/.test(line),
   'stale (latest > baked) → advisory line with both versions + remedy');
ok(line.split('\n').filter(l => /Brain update available/.test(l)).length === 1, 'exactly ONE advisory line');

writeCache({ pkg: 'klypix-mcp', latest: '9.9.9', checkedAt: 1 });
ok(versionCurrencyFooter({ file: cacheFile, brainDir: path.join(dir, 'nope') }) === '',
   'no baked server version → silent (nothing to compare)');

// ── UNIT — refresh throttle + failure-silence + cache write (injected fetcher) ─
fs.rmSync(cacheFile, { force: true });
let calls = 0;
const fakeFetch = async () => { calls++; return '2.0.0'; };
const NOW = 1_700_000_000_000;

await refreshNpmCurrency({ now: NOW, fetcher: fakeFetch, file: cacheFile });
ok(calls === 1, 'first refresh (no cache) → fetches');
ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).latest === '2.0.0', 'refresh caches the fetched latest');

await refreshNpmCurrency({ now: NOW + 60_000, fetcher: fakeFetch, file: cacheFile });        // +1 min
ok(calls === 1, 'second refresh within TTL → throttled (no fetch)');

await refreshNpmCurrency({ now: NOW + 25 * 60 * 60 * 1000, fetcher: fakeFetch, file: cacheFile }); // +25h
ok(calls === 2, 'refresh after the once/day TTL → fetches again');

let threw = false;
try {
    await refreshNpmCurrency({ now: NOW + 50 * 60 * 60 * 1000, file: cacheFile,
        fetcher: async () => { throw new Error('ENETDOWN'); } });
} catch { threw = true; }
ok(!threw, 'fetcher throwing → refresh never throws (failure-silent)');
const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
ok(after.latest === '2.0.0', 'failed fetch preserves the prior good latest');
ok(!!after.lastError, 'failed fetch records lastError + advances checkedAt (no offline hammering)');

// ── E2E — SessionStart is zero-network (subprocess; refresh is Stop-only) ─────
{
    const home = path.join(os.tmpdir(), 'klypix-currency-home');
    fs.rmSync(home, { recursive: true, force: true });
    const brainDir = path.join(home, '.claude', 'project-brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '1.13.0';\n`);
    const cachePath = path.join(brainDir, '.npm-currency.json');
    fs.writeFileSync(cachePath, JSON.stringify({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: 123 }));

    const proj = makeVault();
    await seedBrain(proj);

    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main() (real SessionStart)
    env.KLYPIX_AUTO_UPDATE = '0';      // this fixture (cached latest > baked) would otherwise fire the SessionStart self-update — off so the test stays hermetic (self-update is covered by test/autoprop.mjs)
    const before = fs.readFileSync(cachePath, 'utf8');
    const out = execFileSync(process.execPath, [HOOK], { cwd: proj, env, encoding: 'utf8' });  // SessionStart = no arg
    const afterCache = fs.readFileSync(cachePath, 'utf8');

    ok(/Brain update available/.test(out) && /v1\.14\.0/.test(out),
       'SessionStart surfaces the stale install from the cache (the footer fires)');
    ok(before === afterCache,
       'SessionStart left the cache byte-identical → ZERO network at session start (refresh is Stop-only)');

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ version-currency: all assertions passed');
process.exit(failures ? 1 : 0);
