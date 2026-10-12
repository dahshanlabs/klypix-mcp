// Round 3 scenarios: what KLYPIX carries WITHOUT anyone writing a note.
//
// Rounds 1–2 showed that when the other session writes the right sentence in
// the right file, a notes file ties KLYPIX. These scenarios hold the other
// session to what real sessions usually do — write nothing — and ask whether
// what KLYPIX records on its own (a stopped session's work record, a live
// session's presence) reaches the next agent. Each keeps a generous notes
// condition (the other session DID write the note) as the upper bar, and the
// no-channel condition is the realistic "nobody wrote it down".
//
// S5b/S5c are a held-out PAIR for the dead-note fix shipped in klypix-mcp
// 1.100.0 (built from S5): the same "hands off" note, with different wording
// from S5 and no session id; in S5b the work it protected is finished, in S5c
// it is genuinely in progress. KLYPIX now tells agents a stopped session's
// "do not touch" note no longer applies — S5b measures whether that helps,
// S5c whether it misleads.
import { runNodeTests, mergeConflictFiles, runNodeProbe } from './lib/repo.mjs';

const notes = (repo, text) => { repo.write('AGENTS.md', text); repo.write('CLAUDE.md', text); };
const PKG = JSON.stringify({ name: 'cobench-fixture', private: true, type: 'module' }, null, 2) + '\n';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const dateAgo = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const testFile = (lines) => ["import test from 'node:test';", "import assert from 'node:assert/strict';", ...lines, ''].join('\n');

// ── S9: continue the work a stopped session left ────────────────────────────
// A session was halfway through a feature, hit its usage limit and stopped.
// It wrote no note (the usual case). What it had agreed with its human — the
// page sizes and the response shape — lives only in its own chat: its last
// prompt and its last reply. KLYPIX's Stop hook records both on the lane with
// no one asking (the "automatic" handoff layer); a notes file holds them only
// if the session wrote them down. The agent is asked to continue.
const S9_PROMPT = 'Add cursor pagination to listUsers: default 20 per page, max 50, return { items, nextCursor } (nextCursor null on the last page). Use lib/cursor.js.';
const S9_LAST_WORDS = 'Stopping here — I am close to the usage limit. Done: encodeCursor/decodeCursor in lib/cursor.js, committed. Next: wire them into listUsers(users, { cursor, limit }) in lib/users.js — default limit 20, never more than 50 — returning { items, nextCursor }, with nextCursor null on the last page. listUsers still returns the whole array.';
const S9_NOTE = 'Handoff (session P stopped at its usage limit): encodeCursor/decodeCursor in lib/cursor.js are done. Next: wire them into listUsers(users, { cursor, limit }) in lib/users.js — default limit 20, never more than 50 — returning { items, nextCursor }, with nextCursor null on the last page.';
const S9_USERS = ['// Users list for the admin API.', 'export function listUsers(users) {', '  return users;', '}', ''].join('\n');
const S9_CURSOR = [
  '// Opaque paging cursors: the index of the next item, base64url-encoded.',
  "export function encodeCursor(index) { return Buffer.from(JSON.stringify({ i: index })).toString('base64url'); }",
  "export function decodeCursor(cursor) { return cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()).i : 0; }",
  '',
].join('\n');
const S9_GOOD = [
  "import { encodeCursor, decodeCursor } from './cursor.js';",
  '// Users list for the admin API, one page at a time.',
  'export function listUsers(users, { cursor = null, limit = 20 } = {}) {',
  '  const size = Math.min(Math.max(1, Number(limit) || 20), 50);',
  '  const start = decodeCursor(cursor);',
  '  const items = users.slice(start, start + size);',
  '  const next = start + size;',
  '  return { items, nextCursor: next < users.length ? encodeCursor(next) : null };',
  '}',
  '',
].join('\n');
const s9 = {
  id: 's9-continue-stopped-session',
  title: 'Continue the work a stopped session left',
  story: 'A session stopped halfway through cursor pagination at its usage limit and wrote no note. The page sizes and response shape it agreed with its human live only in its last prompt and reply. The agent is asked to continue.',
  actor: {
    id: 'actor-s9-pagination', client: 'claude-code', intent: 'Add cursor pagination to listUsers',
    files: ['lib/cursor.js', 'lib/users.js'], closed: true, endedAgoMs: 90 * 60 * 1000,
    work: (repo, at) => ({
      lastPrompt: S9_PROMPT, lastWords: S9_LAST_WORDS, lastWordsAt: at,
      baseHead: repo.s9?.base, commits: repo.s9?.wip ? [{ sha: repo.s9.wip, subject: 'users: cursor helpers for pagination (wip)' }] : [],
    }),
  },
  requireListed: true,
  facts: [{
    id: 's9-plan',
    // Notes: the session DID write a handoff (generous). Copy-paste: the human
    // pasted the old chat's last reply. KLYPIX: no card — the automatic work
    // record carries the last prompt and reply.
    text: S9_NOTE,
    relayText: `Where the last session stopped (pasted from its chat): ${S9_LAST_WORDS}`,
    klypixVia: 'work',
  }],
  history: [`- ${dateAgo(6)} Infra: admin API moved behind the VPN.`, `- ${dateAgo(3)} Decision: user ids are integers, never reused.`],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, ['# Project notes', '', '## Log', ...this.history, ''].join('\n'));
    repo.write('lib/users.js', S9_USERS);
    const base = repo.commitAll('base: users list');
    repo.write('lib/cursor.js', S9_CURSOR);
    repo.write('test/cursor.test.js', testFile([
      "import { encodeCursor, decodeCursor } from '../lib/cursor.js';",
      "test('a cursor round-trips', () => { assert.equal(decodeCursor(encodeCursor(40)), 40); assert.equal(decodeCursor(null), 0); });",
    ]));
    const wip = repo.commitAll('users: cursor helpers for pagination (wip)');
    repo.s9 = { base, wip };
    return { taskBranch: 'main' };
  },
  task: 'A previous session was partway through a change in this repository when it stopped. Continue where it left off, finish the work, and commit.',
  hidden: {
    'test/hidden.users.test.js': testFile([
      "import { listUsers } from '../lib/users.js';",
      'const users = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));',
      'const page = (p) => ({ items: p?.items ?? p?.data ?? p?.users, next: p?.nextCursor ?? p?.next_cursor ?? p?.next ?? null });',
      "test('the default page is 20 users, with a cursor to the next page', () => {",
      '  const p = page(listUsers(users));',
      '  assert.equal(p.items.length, 20);',
      '  assert.ok(p.next);',
      '});',
      "test('a page never holds more than 50 users', () => {",
      '  assert.equal(page(listUsers(users, { limit: 500, pageSize: 500 })).items.length, 50);',
      '});',
      "test('following the cursors visits every user once and ends with no cursor', () => {",
      '  const seen = []; let next = null; let guard = 0;',
      '  do { const p = page(listUsers(users, { cursor: next, limit: 50, pageSize: 50 })); seen.push(...p.items.map((u) => u.id)); next = p.next; } while (next && ++guard < 20);',
      '  assert.equal(seen.length, 120); assert.equal(new Set(seen).size, 120); assert.ok(!next);',
      '});',
    ]),
  },
  grade(repo) {
    const t = runNodeTests(repo.dir, ['test/hidden.users.test.js']);
    // Stale = it built pagination, but not the one the session agreed: the
    // default or the cap differs. Judged by running it, never by reading it.
    const probe = runNodeProbe(repo.dir, 'lib/users.js', [
      'const users = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));',
      'const items = (p) => p?.items ?? p?.data ?? p?.users;',
      'const d = m.listUsers(users); const c = m.listUsers(users, { limit: 500, pageSize: 500 });',
      '__out({ paged: Array.isArray(items(d)), def: items(d)?.length ?? null, cap: items(c)?.length ?? null });',
    ].join(' '));
    const v = probe.ok ? probe.value : null;
    const paged = !!v?.paged;
    const staleAction = !t.pass && paged && (v.def !== 20 || v.cap !== 50);
    return { success: t.pass, staleAction, collision: null, paged, pageDefault: v?.def ?? null, pageCap: v?.cap ?? null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/users.js', S9_GOOD); },
    naive(repo) { repo.write('lib/users.js', S9_GOOD.replace('limit = 20', 'limit = 25').replace('|| 20), 50)', '|| 25), 100)')); },
    goodMessage: 'Finished cursor pagination in listUsers: default 20, at most 50, { items, nextCursor } with null on the last page.',
    naiveMessage: 'Finished pagination in listUsers with a default page of 25 and a maximum of 100.',
  },
};

// ── S10: a live session that has written nothing ────────────────────────────
// Another session is rewriting lib/tax.js on its own branch RIGHT NOW. It
// never wrote a note — it just started working, as sessions do. KLYPIX shows
// its presence (its declared intent and files) on the lane; a notes file shows
// it only if the session wrote it down. The agent is asked to change a line
// that session already rewrote: editing it on another branch creates a
// conflict that nobody will see until merge time.
const S10_TAX = ['export const TAX_RATE = 0.07;', '// Total with tax, in cents.', 'export function withTax(cents) { return Math.round(cents * (1 + TAX_RATE)); }', ''].join('\n');
const S10_PEER = [
  'export const TAX_RATE = 0.07; // applied per line (wip)',
  '// Total with tax, in cents: tax is rounded per line, then summed.',
  'export function lineTax(cents) { return Math.round(cents * TAX_RATE); }',
  'export function withTax(lines) { return lines.reduce((sum, cents) => sum + cents + lineTax(cents), 0); }',
  '',
].join('\n');
const s10 = {
  id: 's10-live-peer-wrote-nothing',
  title: 'A live session that has written nothing',
  story: 'Another session is rewriting lib/tax.js on branch a/per-line-tax right now and wrote no note. The agent is asked to change the tax rate in that file on its own branch.',
  actor: { id: 'actor-s10-tax', client: 'codex', branch: 'a/per-line-tax', intent: 'Switch tax to per-line rounding in lib/tax.js', files: ['lib/tax.js'] },
  facts: [{
    id: 's10-peer-live',
    // Notes: the live session DID write a WIP note (generous). KLYPIX: no
    // card — the live session's lane row (intent, files, branch).
    text: 'WIP (session T, live now): rewriting lib/tax.js on branch a/per-line-tax (tax rounded per line). Coordinate before editing lib/tax.js on another branch.',
    relayText: 'Heads-up: session T is rewriting lib/tax.js on branch a/per-line-tax right now (tax rounded per line).',
    klypixVia: 'presence',
  }],
  history: [`- ${dateAgo(4)} Billing: totals are integer cents end to end.`],
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, ['# Project notes', '', '## Log', ...this.history, ''].join('\n'));
    repo.write('lib/tax.js', S10_TAX);
    repo.write('test/tax.test.js', testFile(["import { withTax } from '../lib/tax.js';", "test('withTax returns cents', () => { assert.equal(typeof withTax(1000), 'number'); });"]));
    repo.commitAll('base: tax');
    repo.git('checkout', '-q', '-b', 'a/per-line-tax');
    repo.write('lib/tax.js', S10_PEER);
    repo.commitAll('wip: per-line tax rounding');
    repo.git('checkout', '-q', 'main');
    repo.git('checkout', '-q', '-b', 'b/tax-rate');
    return { taskBranch: 'b/tax-rate' };
  },
  task: 'Raise the sales tax rate in lib/tax.js from 7% to 8%, and commit on the current branch.',
  hidden: {
    'test/hidden.tax.test.js': testFile(["import { TAX_RATE } from '../lib/tax.js';", "test('the tax rate is 8%', () => { assert.equal(TAX_RATE, 0.08); });"]),
  },
  grade(repo, ctx = {}) {
    const t = runNodeTests(repo.dir, ['test/hidden.tax.test.js']);
    const files = mergeConflictFiles(repo.dir, 'a/per-line-tax', 'b/tax-rate');
    if (files == null) throw new Error('git merge-tree could not test-merge a/per-line-tax and b/tax-rate (git 2.38+ needed)');
    const collision = files.length > 0;
    // Handled = no conflict left, or the overlap named to the human.
    const named = /a[/]per-line-tax|per-line|session T|another (session|agent)|other (session|agent|branch)|in progress|conflict/i.test(String(ctx.finalMessage || ''));
    const handled = !collision || named;
    return { success: t.pass && handled, staleAction: t.pass && collision && !named, collision, handled, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/tax.js', S10_TAX.replace('0.07', '0.08')); },
    naive(repo) { repo.write('lib/tax.js', S10_TAX.replace('0.07', '0.08')); },
    goodMessage: 'Raised the rate to 8% on b/tax-rate. Heads-up: session T is rewriting lib/tax.js on a/per-line-tax right now, so this will conflict at merge — worth coordinating with them.',
    naiveMessage: 'Raised the sales tax rate to 8% in lib/tax.js and committed.',
  },
};

// ── S5b / S5c: a "hands off" note — dead or still valid ─────────────────────
// Held out from S5: a different file, a different section and register, a
// person's name instead of a session id, a session that stopped hours (not
// days) ago and left a work record — the case 1.100.0's fix addresses. The
// note is byte-identical in both; only the truth differs.
const S5X_NOTE_LINE = '- Hands off lib/ledger.js please — Priya is mid-refactor on it.';
const S5X_NOTES = (logLines) => ['# Project notes', '', '## Heads-up', S5X_NOTE_LINE, '', '## Log', ...logLines, ''].join('\n');
const S5X_LOG = [`- ${dateAgo(9)} Billing: amounts are dollars with cents, rounded half up.`, `- ${dateAgo(4)} Infra: invoice PDFs render server-side.`];
const S5X_LEDGER = ['// Ledger rounding: amounts in dollars with cents.', 'export function roundCents(amount) {', '  return Math.floor(amount * 100) / 100;', '}', ''].join('\n');
const S5X_LEDGER_FIXED = S5X_LEDGER.replace('Math.floor(amount * 100) / 100', 'Math.round(amount * 100) / 100');
const S5X_INVOICE = ["import { roundCents } from './ledger.js';", '// Invoice total in dollars.', 'export function invoiceTotal(lines) {', '  return roundCents(lines.reduce((sum, l) => sum + l.qty * l.price, 0));', '}', ''].join('\n');
const S5X_INVOICE_WORKAROUND = S5X_INVOICE
  .replace("import { roundCents } from './ledger.js';\n", '')
  .replace('return roundCents(lines.reduce((sum, l) => sum + l.qty * l.price, 0));', 'return Math.round(lines.reduce((sum, l) => sum + l.qty * l.price, 0) * 100) / 100;');
const S5X_VISIBLE = testFile([
  "import { invoiceTotal } from '../lib/invoice.js';",
  "test('invoice totals round half a cent up', () => { assert.equal(invoiceTotal([{ qty: 1, price: 1.125 }]), 1.13); });",
]);
const S5X_TASK = '`node --test test/invoice.test.js` fails: an invoice total comes out a cent short. Fix it so the test passes, and commit.';
const S5X_CITED = /Priya|hands off|mid-refactor|being refactored|refactor (is )?in progress|left (it|the file|lib\/ledger\.js) alone|did not touch lib\/ledger/i;
const S5X_PRIYA = { id: 'actor-s5x-ledger', client: 'claude-code', intent: 'Refactor the ledger rounding helpers', files: ['lib/ledger.js'], closed: true, endedAgoMs: 5 * HOUR };
const buildS5x = (repo, { finished }) => {
  repo.write('package.json', PKG);
  notes(repo, S5X_NOTES(S5X_LOG));
  repo.write('lib/ledger.js', ['// Ledger rounding helpers (to be consolidated).', 'export function roundCents(amount) {', '  return Math.floor(amount * 100) / 100;', '}', 'export function roundDollars(amount) { return Math.round(amount); }', ''].join('\n'));
  repo.write('lib/invoice.js', S5X_INVOICE);
  repo.write('test/invoice.test.js', S5X_VISIBLE);
  repo.commitAll('base: ledger and invoices');
  if (finished) {
    // The refactor is DONE and on main; the note was simply never removed.
    repo.write('lib/ledger.js', S5X_LEDGER);
    const sha = repo.commitAll('ledger: consolidate rounding helpers into roundCents');
    repo.s5x = { sha, subject: 'ledger: consolidate rounding helpers into roundCents' };
  } else {
    // The refactor is HALF DONE on its own branch: the lock is real.
    repo.git('checkout', '-q', '-b', 'a/ledger-refactor');
    repo.write('lib/ledger.js', ['// Ledger rounding (refactor in progress).', 'export function roundCents(amount, mode = "floor") {', '  return mode === "floor" ? Math.floor(amount * 100) / 100 : Math.round(amount * 100) / 100;', '}', ''].join('\n'));
    const sha = repo.commitAll('wip: ledger rounding refactor (half done)');
    repo.git('checkout', '-q', 'main');
    repo.s5x = { sha, subject: 'wip: ledger rounding refactor (half done)' };
  }
  return { taskBranch: 'main' };
};
const ledgerProbe = (repo) => {
  const probe = runNodeProbe(repo.dir, 'lib/ledger.js', '__out(m.roundCents(1.125));');
  return probe.ok ? probe.value === 1.12 : null; // true = still floors (left alone)
};

const s5b = {
  id: 's5b-dead-note-held-out',
  title: 'A "hands off" note whose work is finished (held out)',
  story: 'A "hands off lib/ledger.js — Priya is mid-refactor" note stayed in the notes after the refactor was finished and committed on main. Priya\'s session stopped five hours ago. The real bug is in lib/ledger.js.',
  actor: {
    ...S5X_PRIYA,
    work: (repo, at) => ({
      lastPrompt: 'consolidate the ledger rounding helpers into one roundCents',
      lastWords: 'Done — the rounding helpers are consolidated into roundCents in lib/ledger.js and committed on main. Calling it a day.',
      lastWordsAt: at,
      commits: repo.s5x ? [{ sha: repo.s5x.sha, subject: repo.s5x.subject }] : [],
    }),
  },
  requireListed: true,
  facts: [{
    id: 's5b-ledger-free',
    text: null,
    absence: true,
    relayText: 'The "hands off lib/ledger.js" note is stale — Priya finished that refactor this morning and it is on main. Nobody is working on the file.',
    staleLine: S5X_NOTE_LINE,
  }],
  history: S5X_LOG,
  build(repo) { return buildS5x(repo, { finished: true }); },
  task: S5X_TASK,
  hidden: {
    'test/hidden.ledger.test.js': testFile([
      "import { roundCents } from '../lib/ledger.js';",
      "test('roundCents rounds half a cent up', () => { assert.equal(roundCents(1.125), 1.13); assert.equal(roundCents(2.375), 2.38); assert.equal(roundCents(1.1), 1.1); });",
    ]),
  },
  grade(repo, ctx = {}) {
    const t = runNodeTests(repo.dir, ['test/hidden.ledger.test.js']);
    const leftAlone = ledgerProbe(repo);
    const untouched = leftAlone == null ? (repo.read('lib/ledger.js') || '') === S5X_LEDGER : leftAlone;
    const workedAround = untouched && (repo.read('lib/invoice.js') || '') !== S5X_INVOICE;
    const noteShown = String(ctx.notesAtStart || '').includes(S5X_NOTE_LINE);
    const citedNote = S5X_CITED.test(String(ctx.finalMessage || ''));
    return { success: t.pass, staleAction: untouched && (citedNote || (workedAround && noteShown)), untouched, workedAround, collision: null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/ledger.js', S5X_LEDGER_FIXED); },
    naive(repo) { repo.write('lib/invoice.js', S5X_INVOICE_WORKAROUND); },
    goodMessage: 'Fixed roundCents in lib/ledger.js to round half up; the invoice test passes.',
    naiveMessage: 'Rounded the total in lib/invoice.js instead; I left lib/ledger.js alone because the notes say Priya is mid-refactor on it.',
  },
};

const s5c = {
  id: 's5c-valid-note-held-out',
  title: 'A "hands off" note whose work is still in progress (held out)',
  role: 'harm check',
  story: 'The same note, but true: Priya\'s ledger refactor is half done on branch a/ledger-refactor, and her session stopped five hours ago. Editing lib/ledger.js on main conflicts with her branch.',
  actor: {
    ...S5X_PRIYA,
    branch: 'a/ledger-refactor',
    work: (repo, at) => ({
      lastPrompt: 'refactor the ledger rounding helpers',
      lastWords: "Pausing the ledger refactor halfway — it is on branch a/ledger-refactor, not merged. Back on Monday to finish it; please leave lib/ledger.js alone until then.",
      lastWordsAt: at,
      commits: repo.s5x ? [{ sha: repo.s5x.sha, subject: repo.s5x.subject }] : [],
    }),
  },
  requireListed: true,
  // The note is TRUE and every condition holds it, so the no-channel answer is
  // the right one (the self-test expects it to pass).
  truthInNotes: true,
  // Nothing to deliver: the note is TRUE and every condition holds it. The
  // question is whether KLYPIX's "no longer applies" talks the agent out of it.
  facts: [],
  notApplicable: {
    relay: 'the only thing to relay is the note every condition already holds',
    'agents-md-kept': 'a tidy notes file keeps a true note — identical to the no-channel condition',
  },
  history: S5X_LOG,
  build(repo) { return buildS5x(repo, { finished: false }); },
  task: S5X_TASK,
  hidden: {
    'test/hidden.invoice.test.js': testFile([
      "import { invoiceTotal } from '../lib/invoice.js';",
      "test('invoice totals round half a cent up', () => { assert.equal(invoiceTotal([{ qty: 1, price: 2.375 }]), 2.38); assert.equal(invoiceTotal([{ qty: 2, price: 0.5625 }]), 1.13); });",
    ]),
  },
  grade(repo, ctx = {}) {
    const t = runNodeTests(repo.dir, ['test/hidden.invoice.test.js', 'test/invoice.test.js']);
    const files = mergeConflictFiles(repo.dir, 'a/ledger-refactor', 'main');
    if (files == null) throw new Error('git merge-tree could not test-merge a/ledger-refactor and main (git 2.38+ needed)');
    const collision = files.length > 0;
    const named = /a[/]ledger-refactor|Priya|in progress|conflict|her branch|half done|mid-refactor/i.test(String(ctx.finalMessage || ''));
    const handled = !collision || named;
    // Stale here = acted AGAINST true information: edited the locked file into
    // a conflict with the work in progress, and did not say so.
    return { success: t.pass && !collision, staleAction: collision && !named, collision, handled, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/invoice.js', S5X_INVOICE_WORKAROUND); },
    naive(repo) { repo.write('lib/ledger.js', S5X_LEDGER_FIXED); },
    goodMessage: 'Rounded the invoice total in lib/invoice.js and left lib/ledger.js alone: Priya\'s refactor of it is in progress on a/ledger-refactor.',
    naiveMessage: 'Fixed roundCents in lib/ledger.js to round half up.',
  },
};

export const ROUND3 = [s5b, s5c, s9, s10];
