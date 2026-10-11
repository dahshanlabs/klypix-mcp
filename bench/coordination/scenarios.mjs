// The coordination scenarios. Each one is a real, tiny Node project in a git
// repo, built from scratch per run:
//
//   facts   — what ANOTHER session knows and the agent under test needs. The
//             condition decides whether and how the facts reach the agent.
//   actor   — the other session, scripted (deterministic) so every condition
//             and every agent faces the exact same history.
//   build   — base project + the actor's history; leaves HEAD on the branch
//             the agent works on.
//   task    — the prompt, identical in every condition.
//   hidden  — tests written into the repo only AFTER the agent finishes, so
//             the agent can neither read nor game them.
//   grade   — deterministic, no LLM judge. grade(repo, { finalMessage }) may
//             also return `handled` (S2): the overlap was merged away or named
//             in the agent's final message.
//   later   — facts that do NOT exist when the agent starts; the condition
//             carries them at later.afterMs (S6).
//   history — dated notes every channel holds (the file has them in build;
//             the brain gets them as cards), so clutter is equal (S5, S7).
//   facts[].text null — an ABSENCE (S5): nothing to write; the right channel
//             state is the stale line removed / no presence row.
//   facts[].relayText / insertAfterLine — what a human says when pasting;
//             where a dated log keeps the note (default: appended at the end).
//   notApplicable — conditions the scenario cannot apply to, with the reason.
//   oracle  — two scripted answers (one that uses the facts, one that does
//             not) so a dry run proves each grader separates them.
import { runNodeTests, mergeConflictFiles } from './lib/repo.mjs';

// Claude Code reads CLAUDE.md natively, Codex and most other hosts AGENTS.md.
// Every scenario writes both, identically, so no agent starts with less.
const notes = (repo, text) => { repo.write('AGENTS.md', text); repo.write('CLAUDE.md', text); };

const PKG = JSON.stringify({ name: 'cobench-fixture', private: true, type: 'module' }, null, 2) + '\n';

// ── S1: a decision changed today ─────────────────────────────────────────────
const S1_STALE_LINE = '- Sessions: endpoints use the cookie session in auth/cookie.js.';
const s1 = {
  id: 's1-changed-decision',
  title: 'A decision changed today',
  story: 'Another session decided this morning that new endpoints use bearer tokens. The project notes still say cookies, and the legacy login still uses them.',
  actor: { id: 'actor-s1-auth', client: 'claude-code', intent: 'Move new endpoints to bearer tokens' },
  facts: [{
    id: 'tokens-for-new-endpoints',
    text: 'Decision (today, replaces the cookie note): every NEW endpoint uses bearer tokens from auth/token.js — logout calls revokeToken on the caller\'s token. auth/cookie.js is legacy, kept only for the old login; do not use it in new code.',
    staleLine: S1_STALE_LINE,
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, `# Project notes\n\n## Decisions\n${S1_STALE_LINE}\n`);
    repo.write('auth/cookie.js', [
      'export function setSessionCookie(res, userId) { res.setHeader(\'Set-Cookie\', `sid=${userId}; HttpOnly`); }',
      'export function clearSessionCookie(res) { res.setHeader(\'Set-Cookie\', \'sid=; Max-Age=0\'); }',
      '',
    ].join('\n'));
    repo.write('auth/token.js', [
      'const revoked = new Set();',
      'export function issueToken(userId) { return `tok-${userId}`; }',
      'export function revokeToken(token) { revoked.add(token); }',
      'export function isRevoked(token) { return revoked.has(token); }',
      'export function bearerFrom(req) { const h = (req.headers && req.headers.authorization) || \'\'; return h.startsWith(\'Bearer \') ? h.slice(7) : null; }',
      '',
    ].join('\n'));
    repo.write('server/routes.js', [
      "import { setSessionCookie } from '../auth/cookie.js';",
      '',
      '// Legacy login (cookie session), still used by the old web client.',
      'export function login(req, res) { setSessionCookie(res, req.body.userId); res.end(\'ok\'); }',
      '',
    ].join('\n'));
    repo.commitAll('base: legacy cookie login, token helpers added');
    return { taskBranch: 'main' };
  },
  task: 'Add a `logout(req, res)` handler to server/routes.js that ends the caller\'s session and then responds with `res.end(\'ok\')`. Keep the change small and do not change login.',
  hidden: {
    'test/hidden.logout.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import * as routes from '../server/routes.js';",
      "import { isRevoked } from '../auth/token.js';",
      "test('logout revokes the bearer token and sets no cookie', () => {",
      '  const headers = {};',
      '  const res = { setHeader: (k, v) => { headers[String(k).toLowerCase()] = v; }, end() {}, statusCode: 200 };',
      "  routes.logout({ headers: { authorization: 'Bearer tok-7' }, body: {} }, res);",
      "  assert.equal(isRevoked('tok-7'), true);",
      "  assert.equal(headers['set-cookie'], undefined);",
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.logout.test.js']);
    const src = repo.read('server/routes.js') || '';
    return { success: t.pass, staleAction: /clearSessionCookie/.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) {
      repo.write('server/routes.js', `${repo.read('server/routes.js')}import { bearerFrom, revokeToken } from '../auth/token.js';\nexport function logout(req, res) { const t = bearerFrom(req); if (t) revokeToken(t); res.end('ok'); }\n`);
    },
    naive(repo) {
      repo.write('server/routes.js', `${repo.read('server/routes.js')}import { clearSessionCookie } from '../auth/cookie.js';\nexport function logout(req, res) { clearSessionCookie(res); res.end('ok'); }\n`);
    },
  },
};

// ── S2: two sessions on overlapping work ─────────────────────────────────────
const PRICE_BASE = [
  'export function applyDiscount(price, pct) {',
  '  return Math.round(price * (1 - pct / 100));',
  '}',
  'export function formatPrice(cents) {',
  '  return `$${(cents / 100).toFixed(2)}`;',
  '}',
  '',
].join('\n');
const PRICE_ACTOR = [
  "export function applyDiscount(price, pct, { currency = 'USD' } = {}) {",
  '  const value = Math.round(price * (1 - pct / 100));',
  "  return currency === 'JPY' ? Math.round(value / 100) * 100 : value;",
  '}',
  "export function formatPrice(cents, currency = 'USD') {",
  "  return currency === 'JPY' ? `¥${cents}` : `$${(cents / 100).toFixed(2)}`;",
  '}',
  '',
].join('\n');
const s2 = {
  id: 's2-overlapping-work',
  title: 'Two sessions on overlapping work',
  story: 'Another session is rewriting lib/price.js on its own branch. The agent is asked to change a line that session already rewrote.',
  actor: { id: 'actor-s2-currency', client: 'codex', branch: 'a/currency', intent: 'Add currency support to lib/price.js', files: ['lib/price.js'] },
  facts: [{
    id: 'price-rewrite-in-progress',
    text: 'Session A (another agent) is rewriting lib/price.js on branch a/currency right now: applyDiscount gains a third `{ currency }` option and formatPrice a currency argument. Build on a/currency (run `git merge a/currency` first) so your change and theirs do not conflict.',
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n');
    repo.write('lib/price.js', PRICE_BASE);
    repo.commitAll('base: pricing');
    repo.git('checkout', '-q', '-b', 'a/currency');
    repo.write('lib/price.js', PRICE_ACTOR);
    repo.commitAll('a/currency: currency-aware pricing (in progress)');
    repo.git('checkout', '-q', 'main');
    repo.git('checkout', '-q', '-b', 'b/discount-cap');
    return { taskBranch: 'b/discount-cap' };
  },
  task: 'In lib/price.js, cap discounts at 50%: applyDiscount must never take more than half off. Commit your change on the current branch.',
  hidden: {
    'test/hidden.cap.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { applyDiscount } from '../lib/price.js';",
      "test('discounts are capped at 50%', () => {",
      '  assert.equal(applyDiscount(1000, 80), 500);',
      '  assert.equal(applyDiscount(1000, 20), 800);',
      '});',
      '',
    ].join('\n'),
  },
  grade(repo, ctx = {}) {
    const t = runNodeTests(repo.dir, ['test/hidden.cap.test.js']);
    const files = mergeConflictFiles(repo.dir, 'a/currency', 'b/discount-cap');
    // No verdict is an error for the run, never a quiet fail.
    if (files == null) throw new Error('git merge-tree could not test-merge a/currency and b/discount-cap (git 2.38+ needed)');
    const collision = files.length > 0;
    // Handled = merged away, or the conflict named to the user. The strict grade
    // still fails a flagged conflict; this says whether the agent saw it.
    const handled = collision === false || /a[/]currency|conflict|other (branch|session)|merge/i.test(String(ctx.finalMessage || ''));
    return { success: t.pass && collision === false, staleAction: collision === true, collision, handled, detail: t.output };
  },
  oracle: {
    good(repo) {
      repo.git('merge', '-q', '--no-edit', 'a/currency');
      repo.write('lib/price.js', repo.read('lib/price.js').replace('price * (1 - pct / 100)', 'price * (1 - Math.min(pct, 50) / 100)'));
    },
    naive(repo) {
      repo.write('lib/price.js', repo.read('lib/price.js').replace('price * (1 - pct / 100)', 'price * (1 - Math.min(pct, 50) / 100)'));
    },
    goodMessage: 'Merged a/currency first, then capped the discount at 50%.',
    naiveMessage: 'Capped the discount at 50% on b/discount-cap.',
  },
};

// ── S3: a note left by a session that has ended ──────────────────────────────
const s3 = {
  id: 's3-note-from-closed-session',
  title: 'A note left by a session that has ended',
  story: 'The session that wrote migration 002 found a trap and ended. The agent is asked to add that migration to the deploy plan.',
  actor: { id: 'actor-s3-migrations', client: 'claude-code', intent: 'Write migration 002 (unique emails)', closed: true },
  facts: [{
    id: 'backfill-before-002',
    text: 'Note from the session that wrote migration 002 (now closed): 002 adds a UNIQUE index on users.email. Run the `backfill:emails` step (scripts/backfill.js) BEFORE `migrate:002`, or the migration fails on existing duplicate emails.',
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n');
    repo.write('scripts/deploy.js', [
      '// The ordered steps the deploy runs.',
      'export function deployPlan() {',
      "  return ['build', 'migrate:001'];",
      '}',
      '',
    ].join('\n'));
    repo.write('scripts/backfill.js', '// Merges duplicate user emails. Step name: backfill:emails\nexport function backfillEmails(rows) { return [...new Map(rows.map((r) => [r.email.toLowerCase(), r])).values()]; }\n');
    repo.write('db/migrations/001_init.sql', 'CREATE TABLE users (id INT PRIMARY KEY, email TEXT);\n');
    repo.write('db/migrations/002_unique_email.sql', 'CREATE UNIQUE INDEX users_email_unique ON users (email);\n');
    repo.commitAll('base: deploy plan and migrations');
    return { taskBranch: 'main' };
  },
  task: 'Add migration 002 (db/migrations/002_unique_email.sql) to the deploy plan in scripts/deploy.js. Step names follow the existing pattern.',
  hidden: {
    'test/hidden.plan.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { deployPlan } from '../scripts/deploy.js';",
      "test('migration 002 runs after the email backfill', () => {",
      '  const plan = deployPlan();',
      "  assert.ok(plan.includes('migrate:002'), 'migrate:002 is in the plan');",
      "  assert.ok(plan.includes('backfill:emails'), 'backfill:emails is in the plan');",
      "  assert.ok(plan.indexOf('backfill:emails') < plan.indexOf('migrate:002'), 'backfill runs first');",
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.plan.test.js']);
    const src = repo.read('scripts/deploy.js') || '';
    return { success: t.pass, staleAction: /migrate:002/.test(src) && !/backfill:emails/.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('scripts/deploy.js', repo.read('scripts/deploy.js').replace("['build', 'migrate:001']", "['build', 'migrate:001', 'backfill:emails', 'migrate:002']")); },
    naive(repo) { repo.write('scripts/deploy.js', repo.read('scripts/deploy.js').replace("['build', 'migrate:001']", "['build', 'migrate:001', 'migrate:002']")); },
  },
};

// ── S4: another vendor's session found the root cause ────────────────────────
// The fact must be knowledge the repository cannot give. The first S4 (cache
// key without the user id) was readable from the code and its failing test, so
// every agent solved it with no channel at all (pilot, 2026-10-11) — it
// measured nothing. Now the code looks right and its tests pass; the cause is
// in production, where the CDN strips the header the key relies on. Only the
// other session's investigation knows that.
const s4 = {
  id: 's4-root-cause-from-other-vendor',
  title: 'Another vendor\'s session found the root cause',
  story: 'A Codex session traced a production-only cross-user leak to the CDN stripping a header the cache key relies on. Nothing in the repository shows it, and the symptom invites shortening the cache.',
  actor: { id: 'actor-s4-codex', client: 'codex', intent: 'Investigate the production profile leak' },
  facts: [{
    id: 'cdn-strips-user-header',
    text: 'Root cause (found by the Codex session in production logs): the CDN strips the x-user-id header, so keyFor() in lib/cache.js builds profile:undefined:/me for everyone and users share one entry. The user id that survives the CDN is req.session.uid (set by server/session.js) — key the cache on that. The cache lifetime is NOT the problem; keep TTL_MS and caching.',
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n');
    repo.write('server/session.js', [
      '// Signed session cookie -> req.session (runs before every route).',
      'export function attachSession(req) {',
      "  const raw = (req.headers && req.headers.cookie) || '';",
      "  const m = /(?:^|; )sid=([^;]+)/.exec(raw);",
      '  req.session = m ? { uid: decodeURIComponent(m[1]) } : {};',
      '  return req;',
      '}',
      '',
    ].join('\n'));
    repo.write('lib/cache.js', [
      'const store = new Map();',
      'export const TTL_MS = 60_000;',
      "export function keyFor(req) { return `profile:${req.headers && req.headers['x-user-id']}:${req.path}`; }",
      'export function get(req, now = Date.now()) { const e = store.get(keyFor(req)); return e && now - e.at < TTL_MS ? e.value : undefined; }',
      'export function put(req, value, now = Date.now()) { store.set(keyFor(req), { value, at: now }); }',
      'export function clear() { store.clear(); }',
      '',
    ].join('\n'));
    repo.write('test/cache.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { get, put, clear } from '../lib/cache.js';",
      "test('profiles are cached per user', () => {",
      '  clear();',
      "  put({ path: '/me', headers: { 'x-user-id': 'a' } }, { name: 'Alice' });",
      "  assert.equal(get({ path: '/me', headers: { 'x-user-id': 'b' } }), undefined);",
      "  assert.deepEqual(get({ path: '/me', headers: { 'x-user-id': 'a' } }), { name: 'Alice' });",
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: per-user profile cache (tests pass locally)');
    return { taskBranch: 'main' };
  },
  task: 'Users report that in production they sometimes see another user\'s profile for up to a minute. The tests pass locally. Fix the bug.',
  hidden: {
    'test/hidden.cache.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { get, put, clear, TTL_MS } from '../lib/cache.js';",
      "test('behind the CDN (no x-user-id header) users stay isolated and a user\\'s own profile stays cached', () => {",
      '  clear();',
      "  put({ path: '/me', headers: {}, session: { uid: 'a' } }, { name: 'Alice' }, 1000);",
      "  assert.equal(get({ path: '/me', headers: {}, session: { uid: 'b' } }, 1001), undefined);",
      "  assert.deepEqual(get({ path: '/me', headers: {}, session: { uid: 'a' } }, 1001), { name: 'Alice' });",
      '  assert.equal(TTL_MS, 60_000);',
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.cache.test.js']);
    const src = repo.read('lib/cache.js') || '';
    return { success: t.pass, staleAction: !/TTL_MS = 60_000/.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/cache.js', repo.read('lib/cache.js').replace("`profile:${req.headers && req.headers['x-user-id']}:${req.path}`", '`profile:${(req.session && req.session.uid) || (req.headers && req.headers[\'x-user-id\'])}:${req.path}`')); },
    naive(repo) { repo.write('lib/cache.js', repo.read('lib/cache.js').replace('TTL_MS = 60_000', 'TTL_MS = 0')); },
  },
};


// ═══ Round 2 — scenarios a notes file cannot serve by construction ═══════════
// The pilot (2026-10-11) showed that when the other session has already
// written one short, correct sentence in the right file before the agent
// starts, a notes file ties KLYPIX. These four hold the same fairness rules
// (every channel gets its best shot) but test what a file structurally lacks:
// expiry (S5), arrival during the task (S6), ranking inside a long history
// (S7), and knowledge that is not in the repository at all (S8).

// ── S5: a WIP note that outlived its session ────────────────────────────────
// A notes file cannot expire a line; presence ages out on its own. The other
// session is gone, its "do not touch" note is not. The knowledge the agent
// needs is an ABSENCE: nobody is working on the file now.
const S5_WIP_LINE = '- 2026-10-09 WIP (session Q): rewriting lib/report.js top to bottom — please do not touch it until this note is gone.';
const S5_REPORT = [
  '// Column sums for the weekly report.',
  'export function sumColumn(rows, key) {',
  '  let total = 0;',
  '  for (const row of rows) total += row[key];',
  '  return total;',
  '}',
  '',
].join('\n');
const s5 = {
  id: 's5-stale-wip-note',
  title: 'A WIP note that outlived its session',
  story: 'Two days ago a session wrote "do not touch lib/report.js" in the notes, then ended without removing it. Nobody is working on the file now. The agent is asked to fix a bug in it.',
  actor: { id: 'actor-s5-report', client: 'claude-code', intent: 'Rewrite lib/report.js', files: ['lib/report.js'], closed: true, endedAgoMs: 2 * 24 * 3600 * 1000 },
  facts: [{
    id: 'report-is-free',
    // An absence: the right channel state is "no WIP on lib/report.js", not a sentence.
    text: null,
    absence: true,
    relayText: 'Session Q — the one that wrote the WIP note about lib/report.js — finished two days ago and left the note behind. Nobody is touching the file now.',
    staleLine: S5_WIP_LINE,
  }],
  // The same dated lines the notes file holds, as brain cards — the WIP line is
  // not among them: in KLYPIX a session's work in progress is presence, not a
  // card, and presence ages out.
  history: [
    '- 2026-10-06 Infra: nightly report job moved to 02:00 UTC.',
    '- 2026-10-08 Decision: report CSVs are UTF-8 with BOM for Excel.',
    '- 2026-10-10 Infra: rotated the report bucket credentials.',
  ],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, [
      '# Project notes', '', '## Log',
      '- 2026-10-06 Infra: nightly report job moved to 02:00 UTC.',
      '- 2026-10-08 Decision: report CSVs are UTF-8 with BOM for Excel.',
      S5_WIP_LINE,
      '- 2026-10-10 Infra: rotated the report bucket credentials.',
      '',
    ].join('\n'));
    repo.write('lib/report.js', S5_REPORT);
    repo.write('test/report.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { sumColumn } from '../lib/report.js';",
      "test('sumColumn adds numeric strings as numbers', () => {",
      "  assert.equal(sumColumn([{ amount: '1' }, { amount: '2' }, { amount: '3' }], 'amount'), 6);",
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: weekly report helpers (sumColumn test failing)');
    return { taskBranch: 'main' };
  },
  task: '`node --test test/report.test.js` fails: sumColumn in lib/report.js concatenates numeric strings instead of adding them. Fix it so the test passes.',
  hidden: {
    'test/hidden.report.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { sumColumn } from '../lib/report.js';",
      "test('sumColumn adds numeric strings and numbers', () => {",
      "  assert.equal(sumColumn([{ amount: '1' }, { amount: '2' }, { amount: '3' }], 'amount'), 6);",
      "  assert.equal(sumColumn([{ amount: 2.5 }, { amount: '2.5' }], 'amount'), 5);",
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.report.test.js']);
    const src = repo.read('lib/report.js') || '';
    // Acting on the stale note = leaving the file alone because "someone is on it".
    return { success: t.pass, staleAction: src === S5_REPORT, collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/report.js', S5_REPORT.replace('total += row[key];', 'total += Number(row[key]);')); },
    naive() { /* defers: "session Q is rewriting this file" */ },
    naiveMessage: 'Not changed: the project notes say session Q is rewriting lib/report.js; I left it alone.',
  },
};

// ── S6: a decision made while the agent is working ──────────────────────────
// Nothing is known when the agent starts. Twenty-five seconds in, another
// session settles the display format. A file edited on disk is only seen if
// the agent re-reads it; KLYPIX hands a note to the agent at its next call.
const S6_DECISION = 'Decision (finance, just now): invoice amounts are displayed in MINOR units followed by the currency code, e.g. "2681 USD" — never "$26.81" or "26.81 USD". The PDF renderer breaks on currency symbols and decimal points.';
const s6 = {
  id: 's6-fact-arrives-mid-task',
  title: 'A decision made while the agent is working',
  story: 'The agent starts implementing invoice formatting. Twenty-five seconds in, another session settles how amounts are displayed. Nothing said so when the agent began.',
  actor: { id: 'actor-s6-finance', client: 'codex', intent: 'Settle the invoice display format with finance' },
  facts: [],
  later: { afterMs: 25_000, facts: [{ id: 'display-minor-units', text: S6_DECISION }] },
  notApplicable: { relay: 'a copy-paste at start cannot carry a decision that is made after the agent begins' },
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n\n## Log\n- 2026-10-01 Billing: invoices are issued in USD only for now.\n');
    repo.write('config/tax.json', '{ "rate": 0.0725 }\n');
    repo.write('lib/invoice.js', [
      "import { readFileSync } from 'node:fs';",
      '// Line items carry unit prices in minor units (cents) and a quantity.',
      "export const tax = JSON.parse(readFileSync(new URL('../config/tax.json', import.meta.url), 'utf8'));",
      'export function formatInvoice(lines) {',
      '  // TODO: sum unit × qty, apply tax.rate, round to the nearest minor unit,',
      '  // return { total, display } where display is the human-readable amount.',
      "  throw new Error('not implemented');",
      '}',
      '',
    ].join('\n'));
    repo.write('test/invoice.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { formatInvoice } from '../lib/invoice.js';",
      "test('total applies the configured tax rate', () => {",
      '  const r = formatInvoice([{ unit: 1000, qty: 2 }, { unit: 500, qty: 1 }]);',
      '  assert.equal(r.total, 2681);',
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: invoice formatting stub');
    return { taskBranch: 'main' };
  },
  task: 'Implement formatInvoice(lines) in lib/invoice.js: sum unit × qty (minor units), apply the rate from config/tax.json, round to the nearest minor unit, and return { total, display } where display is the human-readable amount. Make test/invoice.test.js pass, then add one more test of your own for an edge case and make it pass too.',
  hidden: {
    'test/hidden.invoice.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { formatInvoice } from '../lib/invoice.js';",
      "test('display is minor units plus the currency code', () => {",
      '  const r = formatInvoice([{ unit: 1000, qty: 2 }, { unit: 500, qty: 1 }]);',
      '  assert.equal(r.total, 2681);',
      "  assert.equal(r.display, '2681 USD');",
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.invoice.test.js']);
    const src = repo.read('lib/invoice.js') || '';
    // The natural answer without the decision: a currency symbol or decimals.
    return { success: t.pass, staleAction: !t.pass && /\$|toFixed\(2\)|\/\s*100/.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/invoice.js', repo.read('lib/invoice.js').replace("  throw new Error('not implemented');", '  const total = Math.round(lines.reduce((a, l) => a + l.unit * l.qty, 0) * (1 + tax.rate));\n  return { total, display: `${total} USD` };')); },
    naive(repo) { repo.write('lib/invoice.js', repo.read('lib/invoice.js').replace("  throw new Error('not implemented');", '  const total = Math.round(lines.reduce((a, l) => a + l.unit * l.qty, 0) * (1 + tax.rate));\n  return { total, display: `${(total / 100).toFixed(2)}` };')); },
  },
};

// ── S7: a decision buried in six weeks of notes ─────────────────────────────
// Appended notes never lose a line: the retry rule from September and its
// reversal both sit in the log, with a fortnight of unrelated notes after the
// reversal. The brain holds the same forty cards; what differs is that the
// reversal is linked to what it replaced and served first.
const S7_STALE = '- 2026-09-02 Decision (billing): retry failed webhook deliveries 3 times with exponential backoff (lib/webhooks.js).';
const S7_HISTORY = [
  '- 2026-08-26 Infra: staging database moved to the eu-west region.',
  '- 2026-08-27 Decision (auth): sessions expire after 14 days of inactivity.',
  '- 2026-08-29 Infra: CI runners upgraded to Node 24.',
  '- 2026-09-01 Billing: partner X onboarding starts; webhooks go live on the 3rd.',
  S7_STALE,
  '- 2026-09-03 Infra: webhook sender gets its own worker queue.',
  '- 2026-09-05 Decision (ui): dates are shown in the viewer\'s local time zone.',
  '- 2026-09-08 Billing: invoices are numbered per fiscal year.',
  '- 2026-09-10 Infra: log retention cut to 30 days.',
  '- 2026-09-12 Decision (api): list endpoints page at 50 by default, 200 max.',
  '- 2026-09-15 Auth: password reset links expire after 1 hour.',
  '- 2026-09-17 Infra: nightly backup verified by restore drill.',
  '- 2026-09-19 Decision (ui): empty states carry one primary action.',
  '- 2026-09-22 Billing: refunds post to the original payment method only.',
  '- 2026-09-24 Infra: moved error tracking to the new project key.',
  '- 2026-09-26 Decision (api): errors return RFC 7807 problem documents.',
  '- 2026-09-27 Billing: partner X reported duplicate charges; investigating.',
  '- 2026-09-28 Infra: moved the cron runner to the new box.',
  '- 2026-09-30 Decision (ui): the sidebar collapses below 1024px.',
  '- 2026-10-02 Infra: dependency audit clean; two dev-only advisories ignored.',
  '- 2026-10-03 Auth: SSO pilot with two customers.',
  '- 2026-10-06 Decision (api): rate limits are per API key, 600/min.',
  '- 2026-10-08 Billing: dunning emails go out on days 3, 7 and 14.',
  '- 2026-10-09 Infra: image builds cached per branch.',
  '- 2026-10-10 Decision (ui): keyboard shortcuts are listed under "?".',
];
const s7 = {
  id: 's7-decision-buried-in-history',
  title: 'A decision buried in six weeks of notes',
  story: 'The notes log says in September to retry failed webhooks three times. Later in September that rule was reversed because retries caused duplicate charges. Two more weeks of notes followed. The agent is asked to implement webhook delivery.',
  actor: { id: 'actor-s7-billing', client: 'claude-code', intent: 'Stop webhook retries after the duplicate-charge incident' },
  facts: [{
    id: 'webhooks-no-retry',
    text: 'Decision 2026-09-28 (billing, replaces the 09-02 retry rule): webhook deliveries are NOT retried. On a failed send, push the event to the dead-letter queue (lib/dlq.js) once and return. The retries caused the duplicate charges at partner X on 09-27.',
    staleLine: S7_STALE,
    // The note belongs where it was written — in September, not at the end of the file.
    insertAfterLine: '- 2026-09-28 Infra: moved the cron runner to the new box.',
  }],
  history: S7_HISTORY,
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, `# Project notes\n\n## Log\n${S7_HISTORY.join('\n')}\n`);
    repo.write('lib/dlq.js', '// Dead-letter queue for events that could not be delivered.\nexport const queue = [];\nexport function push(event) { queue.push(event); }\n');
    repo.write('lib/webhooks.js', [
      "import * as dlq from './dlq.js';",
      '// deliver(event, send): `send(event)` performs one HTTP delivery and throws on failure.',
      'export async function deliver(event, send) {',
      '  // TODO: follow the project\'s webhook delivery rules.',
      "  throw new Error('not implemented');",
      '}',
      '',
    ].join('\n'));
    repo.write('test/webhooks.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { deliver } from '../lib/webhooks.js';",
      "test('a successful send is delivered once', async () => {",
      '  let calls = 0;',
      "  await deliver({ id: 'e1' }, async () => { calls++; });",
      '  assert.equal(calls, 1);',
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: webhook delivery stub and dead-letter queue');
    return { taskBranch: 'main' };
  },
  task: 'Implement deliver(event, send) in lib/webhooks.js following the project\'s rules for webhook delivery failures, and make test/webhooks.test.js pass.',
  hidden: {
    'test/hidden.webhooks.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { deliver } from '../lib/webhooks.js';",
      "import { queue } from '../lib/dlq.js';",
      "test('a failed send is not retried and lands in the dead-letter queue once', async () => {",
      '  let calls = 0;',
      "  const event = { id: 'e2' };",
      "  await deliver(event, async () => { calls++; throw new Error('503'); });",
      '  assert.equal(calls, 1);',
      "  assert.equal(queue.filter((e) => e.id === 'e2').length, 1);",
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.webhooks.test.js']);
    const src = repo.read('lib/webhooks.js') || '';
    return { success: t.pass, staleAction: !t.pass && /retr|attempt|backoff/i.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/webhooks.js', repo.read('lib/webhooks.js').replace("  throw new Error('not implemented');", '  try { await send(event); } catch { dlq.push(event); }')); },
    naive(repo) { repo.write('lib/webhooks.js', repo.read('lib/webhooks.js').replace("  throw new Error('not implemented');", '  for (let attempt = 0; attempt < 3; attempt++) { try { await send(event); return; } catch { await new Promise((r) => setTimeout(r, 2 ** attempt)); } }')); },
  },
};

// ── S8: a partner limit nothing in the repository shows ─────────────────────
// Both earlier attempts at "knowledge from another vendor's session" were
// inferable from the code, and both agents inferred them with no channel at
// all. A partner's undocumented header limit, learned from their support, is
// not in any file here — and the symptom ("intermittent 400s") invites retries.
const S8_PARTNER = [
  "import { randomUUID } from 'node:crypto';",
  "export const BASE = 'https://api.partner.example';",
  'export async function callPartner(path, body, fetchImpl = fetch) {',
  '  const res = await fetchImpl(BASE + path, {',
  "    method: 'POST',",
  "    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },",
  '    body: JSON.stringify(body),',
  '  });',
  '  if (!res.ok) throw new Error(`partner ${res.status}`);',
  '  return res.json();',
  '}',
  '',
].join('\n');
const s8 = {
  id: 's8-partner-limit-not-in-repo',
  title: 'A partner limit nothing in the repository shows',
  story: 'A Codex session spent an afternoon with the partner\'s support and learned why production calls fail: the partner drops request ids longer than 24 characters. Nothing in the code or its tests shows that. The agent is told only that calls fail intermittently.',
  actor: { id: 'actor-s8-codex', client: 'codex', intent: 'Work the partner 400s with their support' },
  facts: [{
    id: 'partner-request-id-limit',
    text: 'Found with partner support (ticket #4821): the partner API rejects any x-request-id longer than 24 characters or containing "-" — their edge cache drops it and answers 400, which looks random. Our ids are 36-character UUIDs. Send a 20-character [a-z0-9] id instead. Do not add retries: the same long id fails again.',
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n\n## Log\n- 2026-10-01 Partner: production credentials rotated.\n');
    repo.write('lib/partner.js', S8_PARTNER);
    repo.write('test/partner.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { callPartner } from '../lib/partner.js';",
      "test('posts JSON with a request id and parses the reply', async () => {",
      '  let seen = null;',
      "  const fake = async (url, init) => { seen = init; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };",
      "  const out = await callPartner('/orders', { id: 1 }, fake);",
      '  assert.deepEqual(out, { ok: true });',
      "  assert.ok(seen.headers['x-request-id']);",
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: partner client (tests pass)');
    return { taskBranch: 'main' };
  },
  task: 'In production, about 30% of calls made through lib/partner.js fail with HTTP 400 from the partner. Locally every test passes. Fix the cause.',
  hidden: {
    'test/hidden.partner.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { callPartner } from '../lib/partner.js';",
      "test('request ids fit the partner\\'s limit and stay unique', async () => {",
      '  const ids = [];',
      "  const fake = async (url, init) => { ids.push(init.headers['x-request-id']); return { ok: true, status: 200, json: async () => ({}) }; };",
      "  await callPartner('/a', {}, fake);",
      "  await callPartner('/b', {}, fake);",
      '  for (const id of ids) assert.match(String(id), /^[A-Za-z0-9]{1,24}$/);',
      '  assert.notEqual(ids[0], ids[1]);',
      '});',
      '',
    ].join('\n'),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.partner.test.js']);
    const src = repo.read('lib/partner.js') || '';
    return { success: t.pass, staleAction: !t.pass && /retr|attempt/i.test(src), collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/partner.js', S8_PARTNER.replace("import { randomUUID } from 'node:crypto';", "import { randomBytes } from 'node:crypto';").replace("'x-request-id': randomUUID()", "'x-request-id': randomBytes(10).toString('hex')")); },
    naive(repo) { repo.write('lib/partner.js', S8_PARTNER.replace('  const res = await fetchImpl(BASE + path, {', '  let res;\n  for (let attempt = 0; attempt < 3; attempt++) {\n  res = await fetchImpl(BASE + path, {').replace("  if (!res.ok) throw new Error(`partner ${res.status}`);", '  if (res.ok) break;\n  }\n  if (!res.ok) throw new Error(`partner ${res.status}`);')); },
  },
};

export const SCENARIOS = [s1, s2, s3, s4, s5, s6, s7, s8];
export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id || s.id.startsWith(`${id}-`) || s.id.split('-')[0] === id) || null;
