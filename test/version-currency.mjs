// Regression test for ambient version-currency surfacing — the brain announces its
// OWN staleness without anyone running `doctor`. Parts:
//   UNIT (hermetic, injected fetcher) — the footer is network-free + correct
//     (stale → one line; current/ahead → silent; missing/"(offline)"/no-baked →
//     silent); the refresh is throttled (≤ once/day), failure-silent, caches latest.
//   UNIT — the footer's remedy states what the UPDATER will do (2026-10-03): it
//     reads the updater's own plan + decision and only promises an automatic
//     install when the updater will make one (dev-owned / new major / held /
//     failed / overdue / running / due / no-plan each say what is true).
//   UNIT — the refresh honours KLYPIX_AUTO_UPDATE=0, skips the GET when the
//     updater's status already holds a fresh figure, dates the figure by its last
//     SUCCESSFUL fetch (latestAt), and names itself to the registry.
//   E2E (subprocess, NO network) — the REAL hook in SessionStart mode emits the line
//     from a stale cache AND leaves the cache file byte-identical, proving session
//     start makes zero npm calls (the refresh lives only on the Stop path); the
//     notice comes right after the ultra brief, before presence and the other
//     footers; the self-update helper is spawned only when the schedule says due.
//
// Every fixture is literal JSON in a fresh temp dir — nothing is read from the
// real ~/.claude. Pass an explicit `env` wherever behaviour depends on it: the
// sandboxed suite runs with KLYPIX_AUTO_UPDATE=0.
//
// Run:  node test/version-currency.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap } from '../src/klypix-format.mjs';

// Import the hook WITHOUT running main()/exiting this test process (the opt-out flag).
process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
const {
    refreshNpmCurrency, versionCurrencyFooter, autoUpdateFooterInputs, knownNpmLatest, httpsFetchLatest,
} = await import('../src/global-brain-hook.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const temps = [];
const tmpDir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `klypix-currency-${tag}-`)); temps.push(d); return d; };
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const ON = {};                                  // auto-update enabled, independent of the suite's env
const OFF = { KLYPIX_AUTO_UPDATE: '0' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dir = tmpDir('unit');
const cacheFile = path.join(dir, '.npm-currency.json');
fs.writeFileSync(path.join(dir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '1.13.0'; // baked\n`);
const writeCache = (o) => fs.writeFileSync(cacheFile, JSON.stringify(o));
const footer = (extra = {}) => versionCurrencyFooter({ file: cacheFile, brainDir: dir, env: ON, ...extra });

// An inspectAutoUpdate()-shaped plan for a managed npm install that is current
// as of an hour ago and next checks in 5 h. Literal, so the footer is tested
// against the updater's documented fields rather than this machine's state.
const NOW = Date.UTC(2026, 9, 3, 9, 0, 0);   // 2026-10-03 09:00 UTC
const planFor = (over = {}) => ({
    enabled: true, due: false, dueAt: iso(NOW + 5 * HOUR), dueReason: 'interval', nextCheckAt: iso(NOW + 5 * HOUR),
    failures: 0, attempt: null, nextRetryAt: null, inProgress: null,
    result: 'current', error: null, latestVersion: '1.13.0', checkedAt: iso(NOW - HOUR),
    stale: false, staleReason: null, hold: null, scheduleError: null,
    installedIdentity: { version: '1.13.0', managed: true, dev: false, channel: 'npm', installedAt: null, unknown: false },
    ...over,
});
const at = (extra) => footer({ now: NOW, ...extra });

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

// The pending case: the updater's own decision is 'install', so the promise stands.
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: 1 });
const line = footer({ plan: planFor({ dueAt: iso(Date.now() + 5 * HOUR) }), decision: 'install' });
ok(/v1\.13\.0/.test(line) && /v1\.14\.0/.test(line) && /automatically in the background/.test(line) && /no action required/.test(line),
   'stale (latest > baked) → advisory line with both versions + automatic remedy');
ok(!/npx klypix-mcp install/.test(line), 'default auto-update footer never asks the user to install manually');
ok(line.split('\n').filter(l => /Brain update available/.test(l)).length === 1, 'exactly ONE advisory line');

const manualLine = versionCurrencyFooter({ file: cacheFile, brainDir: dir, env: OFF, plan: planFor(), decision: 'install' });
ok(/Automatic updates are off/.test(manualLine) && /npx klypix-mcp install/.test(manualLine) && !/no action required/.test(manualLine),
   'explicit auto-update opt-out → manual fallback remains available (whatever the plan says)');

// The cached figure must be DATED, and an overdue check must say the number is a
// FLOOR — the 2026-08-16 field report's notice claimed a one-minor gap while the
// registry was ~29 minors ahead, because nothing said how old the check was.
ok(/checked \d+d ago/.test(line) && /FLOOR/.test(line),
   'a long-overdue check is dated and declared a floor, not a live fact');
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - 3 * HOUR });
const freshLine = footer();
ok(/checked 3h ago/.test(freshLine) && !/FLOOR/.test(freshLine),
   'a recent check is dated but not caveated');

// Two channels fetch npm latest onto a machine (this cache via the Claude Code
// Stop hook, .autoupdate-status.json via the MCP auto-updater). Whichever ran
// most recently is the one to believe — a host that never runs the Stop hook
// would otherwise be stuck with a months-old figure.
const auStamp = path.join(dir, '.autoupdate-status.json');
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - 30 * 86_400_000 });
fs.writeFileSync(auStamp, JSON.stringify({ latestVersion: '1.20.0', checkedAt: new Date(Date.now() - HOUR).toISOString() }));
ok(/v1\.20\.0/.test(footer()), 'the FRESHER auto-update stamp wins over a month-old currency cache');
fs.writeFileSync(auStamp, JSON.stringify({ latestVersion: '1.15.0', checkedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() }));
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - HOUR });
ok(/v1\.14\.0/.test(footer()), 'a stale auto-update stamp never overrides a fresher cache');
fs.writeFileSync(auStamp, JSON.stringify({ latestVersion: 'not-a-version', checkedAt: new Date().toISOString() }));
ok(/v1\.14\.0/.test(footer()), 'a malformed auto-update stamp is ignored, not adopted');

// "Fresher" means the figure was FETCHED more recently (latestAt), not that a
// refresh was last ATTEMPTED more recently: a failed refresh an hour ago must not
// let a 40-day-old cache figure beat the updater's 2-day-old one, nor read as new.
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - HOUR, latestAt: Date.now() - 40 * 86_400_000, lastError: 'ENETDOWN' });
fs.writeFileSync(auStamp, JSON.stringify({ latestVersion: '1.20.0', checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
const byFetch = footer();
ok(/v1\.20\.0/.test(byFetch) && /checked 2d ago/.test(byFetch),
   'fresher-of ranks by latestAt: a failed refresh does not let an old cache figure win');
ok(knownNpmLatest({ file: cacheFile, brainDir: dir })?.latest === '1.20.0', 'knownNpmLatest returns the same freshest figure');
fs.rmSync(auStamp, { force: true });
// A cache written before latestAt existed, after a FAILED attempt: its checkedAt
// dates the attempt, not the figure — the age is unknown, so it is a floor.
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - HOUR, lastError: 'ENETDOWN' });
const legacyFailed = footer();
ok(/age unknown/.test(legacyFailed) && /FLOOR/.test(legacyFailed) && !/checked just now/.test(legacyFailed),
   'a legacy cache whose last attempt failed is not dated "just now"');

writeCache({ pkg: 'klypix-mcp', latest: '9.9.9', checkedAt: 1 });
ok(versionCurrencyFooter({ file: cacheFile, brainDir: path.join(dir, 'nope'), env: ON }) === '',
   'no baked server version → silent (nothing to compare)');

// ── UNIT — the remedy states what the updater will do (D1, 2026-10-03) ───────
writeCache({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: NOW - 3 * HOUR, latestAt: NOW - 3 * HOUR });
const eta = at({ plan: planFor(), decision: 'install' });
ok(/automatically in the background at the next update check \(≈ 2026-10-03 14:00 UTC, in 5h\); no action required/.test(eta),
   'install, next check 5 h out → the promise names when (≈ time, in 5h)');
ok(/\(npm checked 3h ago\.\)/.test(eta), 'the npm figure stays dated');
const dueNow = at({ plan: planFor({ due: true, dueAt: iso(NOW - 10 * 60_000), dueReason: 'install-changed', stale: true, staleReason: 'left-dev-ownership' }), decision: 'install' });
ok(/at the next update check \(due now\); no action required/.test(dueNow), 'install, check due → "(due now)"');
const running = at({ plan: planFor({ dueAt: iso(NOW + 15 * 60_000), inProgress: { pid: 4242, startedAt: iso(NOW - 60_000) } }), decision: 'install' });
ok(/at the next update check \(running now\)/.test(running), 'a live helper holds the lock → "(running now)", not a stale ETA');

const devLine = at({ plan: planFor({ installedIdentity: { version: '1.13.0', managed: true, dev: true, unknown: false } }), decision: 'dev-owned' });
ok(/Automatic updates are paused: developer-owned install — it follows its checkout, not npm releases\. Returning it to npm releases is the owner's decision \(tell the user; do not run an installer yourself\) — `brain_doctor` \(or `npx -y klypix-mcp@[^`]+ doctor`\) shows how\./.test(devLine),
   'dev-owned → says automatic updates are paused, whose decision it is, and where the remedy lives');
ok(!/klypix-mcp(@\S+)? install|install --force|install --runtime-only/.test(devLine),
   'dev-owned → the agent-visible notice never names an installer command (agents have run installers on their own)');
ok(!/no action required/.test(devLine) && !/automatically in the background/.test(devLine),
   'dev-owned → never "no action required", never an install promise');

const majorLine = at({ plan: planFor(), decision: 'major-blocked', known: { latest: '2.0.0', at: NOW - HOUR } });
ok(/will NOT install it: `v2\.0\.0` is a new major version, which needs a manual install/.test(majorLine) && !/no action required/.test(majorLine),
   'major-blocked → names the manual install, promises nothing');
ok(/the owner's decision \(tell the user; do not run an installer yourself\) — `brain_doctor` \(or `npx -y klypix-mcp@[^`]+ doctor`\) shows how\./.test(majorLine),
   'F2: major-blocked names whose decision it is and points at the installed doctor');
ok(!/klypix-mcp(@\S+)? install|install --force|install --runtime-only/.test(majorLine),
   'major-blocked → the agent-visible notice never names an installer command');

const heldLine = at({ plan: planFor({ hold: { version: '1.14.0', since: iso(NOW - HOUR) } }), decision: 'held' });
ok(/held after a manual downgrade to `v1\.13\.0` — only a release newer than `v1\.14\.0` installs automatically/.test(heldLine) && !/no action required/.test(heldLine),
   'held → says it is held after the downgrade and what will still install');

const failedLine = at({ plan: planFor({ failures: 2, result: 'failed', error: 'npm registry timed out after 8000ms', attempt: 2, dueAt: iso(NOW + 45 * 60_000) }), decision: 'install' });
ok(/last automatic attempt failed \(npm registry timed out after 8000ms, attempt 2\); next retry ≈ 2026-10-03 09:45 UTC, in 45m/.test(failedLine) && !/no action required/.test(failedLine),
   'failed → the error, the attempt and the next retry');
const diedLine = at({ plan: planFor({ failures: 1, result: 'current', dueAt: iso(NOW + 10 * 60_000) }), decision: 'install' });
ok(/last automatic attempt failed \(it stopped before recording a result, attempt 1\)/.test(diedLine),
   'an attempt that died after its pre-stamp is reported as such, not as the older result');
// A failed result from a pre-fix updater: its stamp carries no failure count.
const legacyFailedLine = at({ plan: planFor({ failures: 0, result: 'failed', error: 'npm installer exited 1', dueAt: iso(NOW + 3 * HOUR) }), decision: 'install' });
ok(/last automatic attempt failed \(npm installer exited 1, attempt 1\); next retry ≈ 2026-10-03 12:00 UTC, in 3h/.test(legacyFailedLine) && !/no action required/.test(legacyFailedLine),
   'a legacy failed result (no count in its stamp) still reads as one failed attempt');

// Overdue is the UPDATER's rule (autoUpdateOverdue, K2 2026-10-03) — the one the
// doctor applies — judged inside autoUpdateFooterInputs from the live
// supervisors' receipts under this brainDir. The real module decides; only its
// plan is literal. Receipts are literal too; pid = this process.
const realUpdater = await import('../src/mcp-auto-update.mjs');
const judged = async (plan, extra = {}) => {
    const inputs = await autoUpdateFooterInputs({
        file: cacheFile, brainDir: dir, env: ON, now: NOW,
        loadUpdater: async () => ({ ...realUpdater, inspectAutoUpdate: () => plan }),
    });
    return at({ ...inputs, decision: 'install', ...extra });
};
const supDir = path.join(dir, '.supervisors');
const writeSupervisor = (name, receipt) => { fs.mkdirSync(supDir, { recursive: true }); fs.writeFileSync(path.join(supDir, name), JSON.stringify(receipt)); };
const overduePlan = planFor({ due: true, dueAt: iso(NOW - 3 * HOUR) });
writeSupervisor(`${process.pid}.json`, { protocol: 1, pid: process.pid, parentPid: process.pid, bootedAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 60_000), status: 'ready' });
const overdueLine = await judged(overduePlan);
// F2/F3 (2026-10-03 review): the notice states only what is known, and points
// at the doctor that judges THIS install — a bare `npx klypix-mcp doctor` runs
// whatever copy npx resolves (a project's pinned 1.67.0, or npm's latest).
ok(/Automatic check overdue \(due for 3h; a KLYPIX session open ≥ 30 min did not run it\) — run `brain_doctor` \(or `npx -y klypix-mcp@1\.13\.0 doctor`\)\./.test(overdueLine) && !/no action required/.test(overdueLine),
   'overdue (due 3 h ago, a session open all along) → "automatic check overdue" with what is known, pointing at the installed doctor');
const startedLine = await judged(overduePlan, { spawned: true });
ok(/The automatic update check was overdue \(due for 3h; .*\) and was started just now; if this notice repeats, run `brain_doctor`/.test(startedLine)
    && !/Automatic check overdue —/.test(startedLine),
   'F3: when this SessionStart has just started the overdue check, the notice says so instead of "run the doctor"');
// An install-changed check is due from the moment the receipts changed, not from
// its lastCheck + 5 min floor (the doctor measures it the same way): an install
// 10 min ago after a check 1 h ago is not 55 min late.
const changedPlan = (floorAgoMs, installedAgoMs) => planFor({
    due: true, dueAt: iso(NOW - floorAgoMs), dueReason: 'install-changed', stale: true, staleReason: 'version-increased',
    installedIdentity: { version: '1.13.0', managed: true, dev: false, channel: 'npm', installedAt: iso(NOW - installedAgoMs), unknown: false },
});
ok(/\(due now\); no action required/.test(await judged(changedPlan(55 * 60_000, 10 * 60_000))),
   'install-changed 10 min ago (floor 55 min ago) → "due now", not overdue');
ok(/Automatic check overdue \(due for 2h; a KLYPIX session open ≥ 30 min did not run it\)/.test(await judged(changedPlan(175 * 60_000, 2 * HOUR))),
   'install-changed 2 h ago (floor 2 h 55 min ago) with a session open → overdue by 2h, measured from the install');
// K2: the notice used to judge only dated checks, so a helper that never started
// sat at "(due now)" here forever while the doctor already called it overdue.
const neverPlan = planFor({ due: true, dueAt: iso(NOW), dueReason: 'never-checked', checkedAt: null, result: null, stampWrittenAt: null });
ok(/Automatic check overdue \(no check recorded on this machine; a KLYPIX session open ≥ 30 min did not run it\)/.test(await judged(neverPlan)),
   'K2: a check never recorded, with a session open for hours, is overdue in the notice too — the doctor\'s rule');
writeSupervisor(`${process.pid}.json`, { protocol: 1, pid: process.pid, parentPid: process.pid, bootedAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 60_000), status: 'ready', autoUpdate: { enabled: false } });
ok(/\(due now\)/.test(await judged(overduePlan)),
   'a session whose own auto-update is off never runs the check → it does not make one "overdue"');
writeSupervisor(`${process.pid}.json`, { protocol: 1, pid: process.pid, parentPid: process.pid, bootedAt: iso(NOW - 2 * 60_000), updatedAt: iso(NOW - 60_000), status: 'starting' });
ok(/\(due now\); no action required/.test(await judged(overduePlan)),
   'a supervisor that only just started (this session\'s own) does not make a check "overdue"');
// A reused-pid phantom: the pid answers, but its recorded host is dead and the
// receipt has not been rewritten for 10 min (the doctor's dead-receipt rule).
writeSupervisor(`${process.pid}.json`, { protocol: 1, pid: process.pid, parentPid: 2147483646, bootedAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 10 * 60_000), status: 'ready' });
ok(/\(due now\)/.test(await judged(overduePlan)), 'a dead supervisor receipt (dead host, stale updatedAt) is not a live session');
fs.rmSync(supDir, { recursive: true, force: true });
ok(/\(due now\)/.test(await judged(overduePlan)), 'no session open → a long-due check is "due now", not "overdue"');
// An updater module without the rule (older) judges nothing: never "overdue".
writeSupervisor(`${process.pid}.json`, { protocol: 1, pid: process.pid, parentPid: process.pid, bootedAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 60_000), status: 'ready' });
const withoutRule = { ...realUpdater, inspectAutoUpdate: () => overduePlan, autoUpdateOverdue: undefined };
const olderInputs = await autoUpdateFooterInputs({ file: cacheFile, brainDir: dir, env: ON, now: NOW, loadUpdater: async () => withoutRule });
ok(olderInputs.overdue === null && /\(due now\)/.test(at({ ...olderInputs, decision: 'install' })),
   'K2: an updater module without autoUpdateOverdue is never judged overdue by the notice');
fs.rmSync(supDir, { recursive: true, force: true });

// No plan → the updater's view is unknown → a neutral pointer, never a promise.
// F2: the installed doctor, never a bare `npx klypix-mcp doctor` (baked here: 1.13.0).
const NEUTRAL = /`brain_doctor` \(or `npx -y klypix-mcp@1\.13\.0 doctor`\) shows whether it installs automatically\./;
for (const [label, extra] of [
    ['no plan (the updater module could not be loaded)', {}],
    ['a plan without a decision (an older updater module)', { plan: planFor() }],
    ['a schedule error', { plan: planFor({ scheduleError: 'boom' }), decision: 'install' }],
    ['decision unknown (unreadable receipts)', { plan: planFor(), decision: 'unknown' }],
    ['an install decision with no due time', { plan: planFor({ dueAt: null }), decision: 'install' }],
]) {
    const neutral = at(extra);
    ok(/Brain update available/.test(neutral) && NEUTRAL.test(neutral) && !/no action required/.test(neutral) && !/automatically in the background/.test(neutral),
       `${label} → neutral "doctor shows whether it installs automatically"`);
}

// ── UNIT — autoUpdateFooterInputs: the guarded load of the real updater ──────
{
    const bd = tmpDir('inputs');
    const cache = path.join(bd, '.npm-currency.json');
    fs.writeFileSync(path.join(bd, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '1.13.0';\n`);
    fs.writeFileSync(cache, JSON.stringify({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - HOUR, latestAt: Date.now() - HOUR }));
    const receipts = ({ dev = false, version = '1.13.0' } = {}) => {
        fs.writeFileSync(path.join(bd, '.mcp-runtime.json'), JSON.stringify({ protocol: 1, version, worker: 'klypix-mcp-worker.mjs', channel: 'npm', ...(dev ? { dev: true } : {}) }));
        fs.writeFileSync(path.join(bd, '.brain-version.json'), JSON.stringify({ brainVersion: version, via: 'npm', ...(dev ? { dev: true } : {}) }));
    };
    const inputs = (extra = {}) => autoUpdateFooterInputs({ file: cache, brainDir: bd, env: ON, ...extra });
    const render = (update) => versionCurrencyFooter({ file: cache, brainDir: bd, env: ON, ...update });

    // Unmanaged (no receipts yet): the helper bootstraps it — the promise stands.
    const unmanaged = await inputs();
    ok(unmanaged.plan && unmanaged.decision === 'install' && unmanaged.plan.due === true
        && /automatically in the background at the next update check \(due now\); no action required/.test(render(unmanaged)),
       'inputs: an unmanaged runtime with a newer npm figure → install, due now (never checked)');
    // …but with no receipt naming a version, the helper this hook spawns decides
    // with the BAKED version (KLYPIX_MCP_AUTO_UPDATE_CURRENT), so a new major is
    // blocked — the notice must not promise what the helper will refuse.
    fs.writeFileSync(cache, JSON.stringify({ pkg: 'klypix-mcp', latest: '2.0.0', checkedAt: Date.now() - HOUR, latestAt: Date.now() - HOUR }));
    const major = await inputs();
    ok(major.decision === 'major-blocked' && /`v2\.0\.0` is a new major version/.test(render(major)) && !/no action required/.test(render(major)),
       'inputs: an unmanaged runtime and a new major → major-blocked, as the spawned helper decides');
    fs.writeFileSync(cache, JSON.stringify({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: Date.now() - HOUR, latestAt: Date.now() - HOUR }));

    // Dev-owned receipts → the updater never fetches for it.
    receipts({ dev: true });
    const dev = await inputs();
    ok(dev.decision === 'dev-owned' && /automatic updates are paused/i.test(render(dev)) && !/no action required/.test(render(dev)),
       'inputs: dev-owned receipts → decision dev-owned → "paused", no promise');

    // The founder's PC on 2026-10-02: the last result was dev-owned, the receipts
    // are npm now — the result describes the previous install, so it is due again.
    receipts();
    fs.writeFileSync(path.join(bd, '.autoupdate-check.json'), JSON.stringify({ protocol: 1, lastCheck: Date.now() - 2 * HOUR, checkedAt: iso(Date.now() - 2 * HOUR) }));
    fs.writeFileSync(path.join(bd, '.autoupdate-status.json'), JSON.stringify({ protocol: 1, result: 'dev-owned', checkedAt: iso(Date.now() - 2 * HOUR), currentVersion: '1.13.0' }));
    const left = await inputs();
    ok(left.plan.stale === true && left.decision === 'install' && /\(due now\); no action required/.test(render(left)),
       'inputs: a dev-owned result for a now-npm install → stale → install, due now');

    // A --force downgrade the updater has not evaluated yet: it will HOLD the
    // version it left at its next check, so no install may be promised.
    fs.writeFileSync(path.join(bd, '.autoupdate-check.json'), JSON.stringify({ protocol: 1, lastCheck: Date.now() - HOUR, failures: 0, nextCheckAt: Date.now() + 5 * HOUR }));
    fs.writeFileSync(path.join(bd, '.autoupdate-status.json'), JSON.stringify({
        protocol: 1, result: 'current', checkedAt: iso(Date.now() - HOUR), currentVersion: '1.14.0', latestVersion: '1.14.0',
        identity: { version: '1.14.0', managed: true, dev: false },
    }));
    const downgraded = await inputs();
    ok(downgraded.plan.staleReason === 'manual-downgrade' && downgraded.decision === null
        && NEUTRAL.test(render(downgraded)) && !/no action required/.test(render(downgraded)),
       'inputs: an unevaluated manual downgrade → no decision → neutral, never "installs automatically"');

    // A recorded hold → the updater will not reinstall the version it left.
    fs.writeFileSync(path.join(bd, '.autoupdate-status.json'), JSON.stringify({
        protocol: 1, result: 'held', checkedAt: iso(Date.now() - HOUR), currentVersion: '1.13.0', latestVersion: '1.14.0',
        identity: { version: '1.13.0', managed: true, dev: false }, hold: { version: '1.14.0', since: iso(Date.now() - HOUR) },
    }));
    const held = await inputs();
    ok(held.decision === 'held' && /held after a manual downgrade to `v1\.13\.0`/.test(render(held)), 'inputs: a recorded hold → decision held');

    // The opt-out: the plan is not due (so the SessionStart spawn is skipped).
    ok((await inputs({ env: OFF })).plan.due === false, 'inputs: KLYPIX_AUTO_UPDATE=0 → the plan is never due');

    // The guard: a missing/older/broken module never breaks SessionStart.
    const missing = await inputs({ loadUpdater: async () => { throw new Error('Cannot find module mcp-auto-update.mjs'); } });
    ok(missing.plan === null && missing.decision === null && missing.known?.latest === '1.14.0' && NEUTRAL.test(render(missing)),
       'inputs: module missing → plan null → neutral notice (the figure is still known)');
    const older = await inputs({ loadUpdater: async () => ({ inspectAutoUpdate: () => ({ due: true }) }) });
    ok(older.plan?.due === true && older.decision === null && NEUTRAL.test(render(older)),
       'inputs: an older module without autoUpdateDecision → plan kept for the spawn gate, neutral notice');
    const throwing = await inputs({ loadUpdater: async () => ({ inspectAutoUpdate: () => { throw new Error('boom'); }, autoUpdateDecision: () => 'install' }) });
    ok(throwing.plan === null && throwing.decision === null, 'inputs: a throwing inspectAutoUpdate → plan null, no throw');
}

// The updater is loaded ONLY by a guarded dynamic import: a static one would stop
// every hook mode — the --live / --guard fast paths included — from even loading
// when an older flat deployment lacks mcp-auto-update.mjs. (CR stripped: Windows
// checkouts are CRLF.)
{
    const src = fs.readFileSync(HOOK, 'utf8').replace(/\r/g, '');
    ok(!/^\s*(?:import|export)\s[^;]*from\s+['"]\.\/mcp-auto-update\.mjs['"]/m.test(src) && !/^\s*import\s+['"]\.\/mcp-auto-update\.mjs['"]/m.test(src),
       'the hook has no static import of mcp-auto-update.mjs (the fast paths survive its absence)');
}

// ── UNIT — refresh throttle + failure-silence + cache write (injected fetcher) ─
fs.rmSync(cacheFile, { force: true });
let calls = 0;
const fakeFetch = async () => { calls++; return '2.0.0'; };
const T0 = 1_700_000_000_000;

await refreshNpmCurrency({ now: T0, fetcher: fakeFetch, file: cacheFile, env: ON });
ok(calls === 1, 'first refresh (no cache) → fetches');
ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).latest === '2.0.0', 'refresh caches the fetched latest');
ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).latestAt === T0, 'a successful fetch records latestAt (when the figure was fetched)');

await refreshNpmCurrency({ now: T0 + 60_000, fetcher: fakeFetch, file: cacheFile, env: ON });        // +1 min
ok(calls === 1, 'second refresh within TTL → throttled (no fetch)');

await refreshNpmCurrency({ now: T0 + 25 * HOUR, fetcher: fakeFetch, file: cacheFile, env: ON }); // +25h
ok(calls === 2, 'refresh after the once/day TTL → fetches again');

let threw = false;
try {
    await refreshNpmCurrency({ now: T0 + 50 * HOUR, file: cacheFile, env: ON,
        fetcher: async () => { throw new Error('ENETDOWN'); } });
} catch { threw = true; }
ok(!threw, 'fetcher throwing → refresh never throws (failure-silent)');
const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
ok(after.latest === '2.0.0', 'failed fetch preserves the prior good latest');
ok(!!after.lastError && after.checkedAt === T0 + 50 * HOUR, 'failed fetch records lastError + advances checkedAt (no offline hammering)');
ok(after.latestAt === T0 + 25 * HOUR, 'failed fetch keeps latestAt at the last SUCCESSFUL fetch (the figure is not re-dated)');

await refreshNpmCurrency({ now: T0 + 75 * HOUR, file: cacheFile, env: ON, fetcher: async () => 'not-a-version' });
const garbage = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
ok(garbage.latest === '2.0.0' && !!garbage.lastError && garbage.latestAt === T0 + 25 * HOUR,
   'a non-semver registry answer counts as a failed fetch (figure and latestAt kept)');

// The opt-out covers this probe too (README: KLYPIX_AUTO_UPDATE=0).
{
    const optFile = path.join(tmpDir('optout'), '.npm-currency.json');
    let optCalls = 0;
    const res = await refreshNpmCurrency({ now: T0, file: optFile, env: OFF, fetcher: async () => { optCalls++; return '2.0.0'; } });
    ok(optCalls === 0 && res.skipped === 'disabled' && !fs.existsSync(optFile),
       'KLYPIX_AUTO_UPDATE=0 → no registry GET and nothing written');
}

// One probe per machine: a fresh updater figure next to the cache makes the GET
// redundant — skip it and write nothing (the cache keeps its true dates).
{
    const pd = tmpDir('probe');
    const pFile = path.join(pd, '.npm-currency.json');
    const status = (o) => fs.writeFileSync(path.join(pd, '.autoupdate-status.json'), JSON.stringify(o));
    let pCalls = 0;
    const pFetch = async () => { pCalls++; return '2.1.0'; };
    status({ protocol: 1, result: 'current', latestVersion: '2.1.0', checkedAt: iso(T0 - HOUR) });
    const skipped = await refreshNpmCurrency({ now: T0, file: pFile, env: ON, fetcher: pFetch });
    ok(pCalls === 0 && skipped.skipped === 'updater-fresh' && !fs.existsSync(pFile),
       'a fresh updater latestVersion (1 h old) → no GET, nothing written');
    status({ protocol: 1, result: 'current', latestVersion: '2.1.0', checkedAt: iso(T0 - 30 * HOUR) });
    await refreshNpmCurrency({ now: T0, file: pFile, env: ON, fetcher: pFetch });
    ok(pCalls === 1, 'an updater figure older than the TTL → fetches as before');
    fs.rmSync(pFile, { force: true });
    for (const [label, bad] of [
        ['a non-semver latestVersion', { latestVersion: 'abc', checkedAt: iso(T0 - HOUR) }],
        ['an unparseable checkedAt', { latestVersion: '2.1.0', checkedAt: 'x' }],
        ['a failed result (no figure)', { result: 'failed', checkedAt: iso(T0 - HOUR), error: 'offline' }],
        ['a status dated hours ahead', { latestVersion: '2.1.0', checkedAt: iso(T0 + 2 * HOUR) }],
    ]) {
        const before = pCalls;
        status(bad);
        await refreshNpmCurrency({ now: T0, file: pFile, env: ON, fetcher: pFetch });
        ok(pCalls === before + 1, `${label} in the updater status → still fetches`);
        fs.rmSync(pFile, { force: true });
    }
    fs.writeFileSync(path.join(pd, '.autoupdate-status.json'), '{ "latestVersion": "2.1.0", ');
    const before = pCalls;
    await refreshNpmCurrency({ now: T0, file: pFile, env: ON, fetcher: pFetch });
    ok(pCalls === before + 1, 'a torn (unparseable) updater status → still fetches');
}

// The probe names itself to the registry (it sent no User-Agent before).
{
    let seen = null;
    const fakeRequest = (url, options, onResponse) => {
        seen = { url, options };
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = (error) => req.emit('error', error);
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        res.resume = () => {};
        setImmediate(() => { onResponse(res); res.emit('data', JSON.stringify({ name: 'klypix-mcp', version: '2.2.0' })); res.emit('end'); });
        return req;
    };
    const version = await httpsFetchLatest('klypix-mcp', 4000, fakeRequest);
    ok(version === '2.2.0' && seen?.url === 'https://registry.npmjs.org/klypix-mcp/latest',
       'httpsFetchLatest resolves the version from the per-version endpoint (offline fake)');
    ok(/^klypix-mcp/.test(String(seen?.options?.headers?.['user-agent'] || '')) && seen?.options?.headers?.accept === 'application/json',
       'httpsFetchLatest sends a klypix-mcp User-Agent with the default json accept');
}

// ── E2E — the REAL hook at SessionStart (subprocess; refresh is Stop-only) ────
const hookEnv = (home, extra = {}) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off', ...extra };
    delete env.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main() (real SessionStart)
    delete env.CLAUDE_PID;             // no host correlation: two runs here are two distinct sessions
    return env;
};
const seedHome = (tag, { baked = '1.13.0', latest = '1.14.0', checkedAt = Date.now() } = {}) => {
    const home = tmpDir(`${tag}-home`);
    const brainDir = path.join(home, '.claude', 'project-brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '${baked}';\n`);
    fs.writeFileSync(path.join(brainDir, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest, checkedAt, latestAt: checkedAt }));
    return { home, brainDir };
};
const seedProject = async (tag) => {
    const proj = tmpDir(`${tag}-proj`);
    fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Goal', cards: [{ text: 'Ship the version notice that tells the truth.' }] },
            { title: 'Open questions', cards: [{ text: '❓ Should the notice name the next check time?' }] },
        ],
    }));
    return proj;
};
const sessionStart = (proj, env, sessionId) => execFileSync(process.execPath, [HOOK], {
    cwd: proj, env, encoding: 'utf8', ...(sessionId ? { input: JSON.stringify({ session_id: sessionId }) } : {}),
});

{
    const { home, brainDir } = seedHome('zero-net', { checkedAt: 123 });
    const cachePath = path.join(brainDir, '.npm-currency.json');
    fs.writeFileSync(cachePath, JSON.stringify({ pkg: 'klypix-mcp', latest: '1.14.0', checkedAt: 123 }));
    const proj = await seedProject('zero-net');
    // This fixture (cached latest > baked) would otherwise fire the SessionStart
    // self-update — off so the test stays hermetic (self-update: test/autoprop.mjs + below).
    const env = hookEnv(home, { KLYPIX_AUTO_UPDATE: '0' });
    const before = fs.readFileSync(cachePath, 'utf8');
    const out = sessionStart(proj, env);  // SessionStart = no arg
    const afterCache = fs.readFileSync(cachePath, 'utf8');

    ok(/Brain update available/.test(out) && /v1\.14\.0/.test(out),
       'SessionStart surfaces the stale install from the cache (the footer fires)');
    ok(before === afterCache,
       'SessionStart left the cache byte-identical → ZERO network at session start (refresh is Stop-only)');
}

// D3: the one-line notice rides right after the ultra brief (and messages),
// before the presence line and the variable-length footers; the FULL brief file
// keeps its order (the readiness footer still precedes the version footer there).
{
    const { home } = seedHome('order');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');   // → the "half-wired" readiness footer
    const proj = await seedProject('order');
    const env = hookEnv(home, { KLYPIX_AUTO_UPDATE: '0' });
    sessionStart(proj, env, 'order-peer-a');                               // a live peer row for the presence line
    const out = sessionStart(proj, env, 'order-self-b');
    const iBrief = out.indexOf('Full brief:'), iNotice = out.indexOf('Brain update available');
    const iPresence = out.indexOf('other live session(s)'), iHalf = out.indexOf('Brain half-wired');
    ok(iBrief > -1 && iNotice > -1 && iPresence > -1 && iHalf > -1,
       `order fixture renders the ultra brief, the notice, the presence line and the readiness footer (${[iBrief, iNotice, iPresence, iHalf].join(',')})`);
    ok(iBrief < iNotice && iNotice < iPresence && iNotice < iHalf,
       'the version notice comes right after the ultra brief, before the presence line and the footers');
    let brief = ''; try { brief = fs.readFileSync(path.join(proj, '.claude', 'brain-brief.md'), 'utf8'); } catch { brief = ''; }
    ok(brief.indexOf('Brain half-wired') > -1 && brief.indexOf('Brain half-wired') < brief.indexOf('Brain update available'),
       'the full brief file keeps its order (readiness footer, then the version footer)');
}

// D4: the SessionStart spawn asks the shared schedule first. The helper at
// <home>/.claude/project-brain/mcp-auto-update.mjs is a STUB that only writes a
// marker — the real updater never runs and nothing touches the network. The plan
// itself is computed by the real src/mcp-auto-update.mjs over these literal files.
{
    const { home, brainDir } = seedHome('spawn');
    fs.writeFileSync(path.join(brainDir, '.mcp-runtime.json'), JSON.stringify({ protocol: 1, version: '1.13.0', worker: 'klypix-mcp-worker.mjs', channel: 'npm' }));
    fs.writeFileSync(path.join(brainDir, '.brain-version.json'), JSON.stringify({ brainVersion: '1.13.0', via: 'npm' }));
    const marker = path.join(brainDir, 'stub-helper-ran.json');
    fs.writeFileSync(path.join(brainDir, 'mcp-auto-update.mjs'), [
        "import fs from 'fs';",
        "import path from 'path';",
        "if (process.argv.includes('--klypix-auto-update-worker')) {",
        "  fs.writeFileSync(path.join(process.env.KLYPIX_MCP_AUTO_UPDATE_DIR, 'stub-helper-ran.json'), JSON.stringify({ current: process.env.KLYPIX_MCP_AUTO_UPDATE_CURRENT }));",
        '}',
        '',
    ].join('\n'));
    const proj = await seedProject('spawn');
    const waitFor = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(marker)) return true; await sleep(100); } return fs.existsSync(marker); };

    // Due (never checked) → spawned; the notice says "due now". The time the
    // stub takes to appear after the hook exits sizes the negative waits below.
    const dueOut = sessionStart(proj, hookEnv(home, { KLYPIX_AUTO_UPDATE: '1' }), 'spawn-due');
    const t0 = Date.now();
    const spawned = await waitFor(15_000);
    const spawnMs = Date.now() - t0;
    ok(spawned, 'a due check → SessionStart spawns the shared helper');
    ok(/\(due now\); no action required/.test(dueOut), 'a due check → the notice says the install happens at the check due now');
    const quietWait = Math.max(3_000, 3 * spawnMs);

    // Not due (checked an hour ago for this exact install) → no spawn.
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(brainDir, '.autoupdate-check.json'), JSON.stringify({ protocol: 1, lastCheck: Date.now() - HOUR, failures: 0, nextCheckAt: Date.now() + 5 * HOUR }));
    fs.writeFileSync(path.join(brainDir, '.autoupdate-status.json'), JSON.stringify({
        protocol: 1, result: 'current', checkedAt: iso(Date.now() - HOUR), currentVersion: '1.13.0', latestVersion: '1.13.0',
        identity: { version: '1.13.0', managed: true, dev: false },
    }));
    const notDueOut = sessionStart(proj, hookEnv(home, { KLYPIX_AUTO_UPDATE: '1' }), 'spawn-not-due');
    ok(!(await waitFor(quietWait)), `a check that is not due → no helper spawned (waited ${quietWait} ms)`);
    ok(/at the next update check \(≈ \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, in (4h 5\dm|5h)\); no action required/.test(notDueOut),
       'a check that is not due → the notice names the next check time');

    // The opt-out: never due → never spawned (it used to spawn and exit 'disabled').
    fs.rmSync(path.join(brainDir, '.autoupdate-check.json'), { force: true });
    fs.rmSync(path.join(brainDir, '.autoupdate-status.json'), { force: true });
    const offOut = sessionStart(proj, hookEnv(home, { KLYPIX_AUTO_UPDATE: '0' }), 'spawn-off');
    ok(!(await waitFor(quietWait)), 'KLYPIX_AUTO_UPDATE=0 → no helper spawned at SessionStart');
    ok(/Automatic updates are off/.test(offOut), 'KLYPIX_AUTO_UPDATE=0 → the notice keeps the manual fallback');
}

for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ version-currency: all assertions passed');
process.exit(failures ? 1 : 0);
