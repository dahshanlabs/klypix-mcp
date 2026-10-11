// The four coordination scenarios. Each one is a real, tiny Node project in a
// git repo, built from scratch per run:
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
//   grade   — deterministic, no LLM judge.
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
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.cap.test.js']);
    const files = mergeConflictFiles(repo.dir, 'a/currency', 'b/discount-cap');
    // No verdict is an error for the run, never a quiet fail.
    if (files == null) throw new Error('git merge-tree could not test-merge a/currency and b/discount-cap (git 2.38+ needed)');
    const collision = files.length > 0;
    return { success: t.pass && collision === false, staleAction: collision === true, collision, detail: t.output };
  },
  oracle: {
    good(repo) {
      repo.git('merge', '-q', '--no-edit', 'a/currency');
      repo.write('lib/price.js', repo.read('lib/price.js').replace('price * (1 - pct / 100)', 'price * (1 - Math.min(pct, 50) / 100)'));
    },
    naive(repo) {
      repo.write('lib/price.js', repo.read('lib/price.js').replace('price * (1 - pct / 100)', 'price * (1 - Math.min(pct, 50) / 100)'));
    },
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
const s4 = {
  id: 's4-root-cause-from-other-vendor',
  title: 'Another vendor\'s session found the root cause',
  story: 'A Codex session traced a cross-user cache leak to the cache key. The symptom points at the cache lifetime; the agent is asked to fix it.',
  actor: { id: 'actor-s4-codex', client: 'codex', intent: 'Investigate the profile leak' },
  facts: [{
    id: 'cache-key-root-cause',
    text: 'Root cause (found by the Codex session): keyFor() in lib/cache.js builds the key from the path only — it must include req.userId. The cache lifetime is NOT the problem; keep TTL_MS and caching as they are.',
  }],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, '# Project notes\n');
    repo.write('lib/cache.js', [
      'const store = new Map();',
      'export const TTL_MS = 60_000;',
      'export function keyFor(req) { return `profile:${req.path}`; }',
      'export function get(req, now = Date.now()) { const e = store.get(keyFor(req)); return e && now - e.at < TTL_MS ? e.value : undefined; }',
      'export function put(req, value, now = Date.now()) { store.set(keyFor(req), { value, at: now }); }',
      'export function clear() { store.clear(); }',
      '',
    ].join('\n'));
    repo.write('test/cache.test.js', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { get, put, clear } from '../lib/cache.js';",
      "test('a user never sees another user\\'s cached profile (stale cache?)', () => {",
      '  clear();',
      "  put({ path: '/me', userId: 'a' }, { name: 'Alice' });",
      "  assert.equal(get({ path: '/me', userId: 'b' }), undefined);",
      '});',
      '',
    ].join('\n'));
    repo.commitAll('base: profile cache with a failing leak test');
    return { taskBranch: 'main' };
  },
  task: 'Users report seeing another user\'s profile for up to a minute. Fix the bug so `node --test test/cache.test.js` passes.',
  hidden: {
    'test/hidden.cache.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { get, put, clear, TTL_MS } from '../lib/cache.js';",
      "test('users are isolated and a user\\'s own profile stays cached', () => {",
      '  clear();',
      "  put({ path: '/me', userId: 'a' }, { name: 'Alice' }, 1000);",
      "  assert.equal(get({ path: '/me', userId: 'b' }, 1001), undefined);",
      "  assert.deepEqual(get({ path: '/me', userId: 'a' }, 1001), { name: 'Alice' });",
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
    good(repo) { repo.write('lib/cache.js', repo.read('lib/cache.js').replace('`profile:${req.path}`', '`profile:${req.userId}:${req.path}`')); },
    naive(repo) { repo.write('lib/cache.js', repo.read('lib/cache.js').replace('TTL_MS = 60_000', 'TTL_MS = 0')); },
  },
};

export const SCENARIOS = [s1, s2, s3, s4];
export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id || s.id.startsWith(`${id}-`) || s.id.split('-')[0] === id) || null;
