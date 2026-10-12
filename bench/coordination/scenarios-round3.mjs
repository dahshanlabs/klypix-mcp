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
// S5c whether it misleads. Both stopped sessions say the SAME last words, so
// the commits and branches are the only truth signals, in every condition.
//
// Every grader judges what the agent DID to the code, test-merging the agent's
// final commit against the other session's original work commit (never branch
// names an agent can move). Words in the final message decide only the
// separately reported "named" field, through a peer-specific, negation-aware
// rule that every condition shares.
import { runNodeTests, mergeConflictFiles, runNodeProbe } from './lib/repo.mjs';

const notes = (repo, text) => { repo.write('AGENTS.md', text); repo.write('CLAUDE.md', text); };
const PKG = JSON.stringify({ name: 'cobench-fixture', private: true, type: 'module' }, null, 2) + '\n';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const dateAgo = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const testFile = (lines) => ["import test from 'node:test';", "import assert from 'node:assert/strict';", ...lines, ''].join('\n');

/**
 * What the agent's final commit does to another session's work commit:
 * whether they conflict, whether the agent merged that work in, and whether
 * the other session's branch was moved. Temporary refs point at the two
 * commits, so an agent that worked on a new branch, or moved theirs, is
 * graded on what it did, never on a branch name.
 */
export function relationToWork(repo, workSha, workBranch = null) {
  const head = repo.git('rev-parse', 'HEAD');
  repo.git('branch', '-f', 'bench-grade-head', head);
  repo.git('branch', '-f', 'bench-grade-work', workSha);
  const files = mergeConflictFiles(repo.dir, 'bench-grade-work', 'bench-grade-head');
  let merged = false;
  try { repo.git('merge-base', '--is-ancestor', workSha, head); merged = true; } catch { merged = false; }
  let moved = false;
  if (workBranch) { try { moved = repo.git('rev-parse', `refs/heads/${workBranch}`) !== workSha; } catch { moved = true; } }
  return { conflict: files == null ? null : files.length > 0, files, merged, moved, head };
}

/**
 * Did the final message NAME the other session's work to the human? A strong
 * reference (its branch or id) counts on its own; a generic one ("another
 * session", "a live agent") counts only in a sentence about the shared file or
 * the overlap. A sentence that negates it ("no conflicts", "did not touch any
 * other branch") never counts. One rule for every condition.
 */
export function namesPeer(message, { strong, topic }) {
  const generic = /\b(another|other|concurrent|parallel|live|peer|active|second)\b(?:\s+\w+){0,3}\s+(session|agent|branch|change)s?\b/i;
  const negated = /\b(no|not|none|without|never|nothing)\b[^.;:!?\n]{0,40}\b(conflict|overlap|other|session|agent|branch|peer)/i;
  const sentences = String(message || '').split(/(?<=[.!?;])\s+|\n+/);
  for (const s of sentences) {
    if (strong.test(s)) return { named: true, sentence: s.trim().slice(0, 240) };
    if (generic.test(s) && topic.test(s) && !negated.test(s)) return { named: true, sentence: s.trim().slice(0, 240) };
  }
  return { named: false, sentence: null };
}

// ── S9 / S9s: continue the work a stopped session left ──────────────────────
// A session was halfway through a feature and stopped. It wrote no note. What
// it had agreed with its human — page sizes and response shape — was in the
// human's prompt. KLYPIX's Stop hook records the session's last prompt, the
// tail of its last reply and its commits on the lane with no one asking.
//   S9  (primary): the last reply is a realistic mid-step tail; the plan is in
//       the last PROMPT only. Today no KLYPIX surface prints the last prompt,
//       so this measures the record as the product shows it.
//   S9s (secondary, labelled): the session happened to end its turn with a
//       done/next summary. Never reported as "nobody wrote a note".
// The stopped session is ALWAYS another vendor's (cross-vendor handoff): a
// Claude agent continues a Codex session and vice versa, so no native resume
// command could carry it.
const S9_PROMPT = 'Add cursor pagination to listUsers: default 20 per page, max 50, return { items, nextCursor } (nextCursor null on the last page). Use lib/cursor.js.';
const S9_TAIL = 'Helpers committed. Now wiring them into listUsers in lib/users.js.';
const S9_SUMMARY = 'Done: encodeCursor/decodeCursor in lib/cursor.js, committed. Next: wire them into listUsers(users, { cursor, limit }) in lib/users.js — default limit 20, never more than 50 — returning { items, nextCursor }, with nextCursor null on the last page.';
const S9_NOTE = 'Handoff (the previous session stopped mid-task): encodeCursor/decodeCursor in lib/cursor.js are done. Next: wire them into listUsers(users, { cursor, limit }) in lib/users.js — default limit 20, never more than 50 — returning { items, nextCursor }, with nextCursor null on the last page.';
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
const S9_HISTORY = [`- ${dateAgo(6)} Infra: admin API moved behind the VPN.`, `- ${dateAgo(3)} Decision: user ids are integers, never reused.`];
const makeS9 = ({ id, title, lastWords, story, notApplicable = null, role = null }) => ({
  id,
  title,
  ...(role ? { role } : {}),
  story,
  actor: {
    id: 'actor-s9-pagination',
    // Cross-vendor: the stopped session is the OTHER vendor's.
    clientFor: (agent) => (agent?.id === 'codex' ? 'claude-code' : 'codex'),
    intent: 'Add cursor pagination to listUsers',
    // What a Stop hook records: the files the session EDITED.
    files: ['lib/cursor.js', 'test/cursor.test.js'],
    closed: true, endedAgoMs: 90 * 60 * 1000,
    work: (repo, at) => ({
      lastPrompt: S9_PROMPT, lastWords, lastWordsAt: at,
      baseHead: repo.s9?.base, commits: repo.s9?.wip ? [{ sha: repo.s9.wip, subject: 'users: cursor helpers for pagination (wip)' }] : [],
    }),
  },
  requireListed: true,
  facts: [{
    id: 's9-plan',
    // Notes: the session DID write a handoff (generous). Copy-paste: the human
    // pastes that handoff. KLYPIX: no card — only the automatic work record.
    text: S9_NOTE,
    klypixVia: 'work',
  }],
  ...(notApplicable ? { notApplicable } : {}),
  history: S9_HISTORY,
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, ['# Project notes', '', '## Log', ...S9_HISTORY, ''].join('\n'));
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
      "test('a limit within range is honoured', () => {",
      '  assert.equal(page(listUsers(users, { limit: 30, pageSize: 30 })).items.length, 30);',
      '});',
      // "Never more than 50": a clamp, a fall-back to the default, or a refusal all keep it.
      "test('a page never holds more than 50 users', () => {",
      '  let p; try { p = page(listUsers(users, { limit: 500, pageSize: 500 })); } catch { return; }',
      '  assert.ok(p.items.length > 0 && p.items.length <= 50);',
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
    // Stale = it built pagination, but not the one agreed: a default other than
    // 20, or a page larger than 50. Each call probed on its own.
    const probe = runNodeProbe(repo.dir, 'lib/users.js', [
      'const users = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));',
      'const items = (p) => p?.items ?? p?.data ?? p?.users;',
      'let d = null, c = null, paged = false;',
      'try { const r = m.listUsers(users); paged = Array.isArray(items(r)); d = items(r)?.length ?? null; } catch { d = null; }',
      "try { c = items(m.listUsers(users, { limit: 500, pageSize: 500 }))?.length ?? null; } catch { c = 'threw'; }",
      '__out({ paged, def: d, cap: c });',
    ].join(' '));
    const v = probe.ok ? probe.value : null;
    const paged = !!v?.paged;
    const tooBig = typeof v?.cap === 'number' && v.cap > 50;
    const staleAction = !t.pass && paged && (v.def !== 20 || tooBig);
    return { success: t.pass, staleAction, collision: null, paged, pageDefault: v?.def ?? null, pageCap: v?.cap ?? null, detail: t.output };
  },
  oracle: {
    good(repo) { repo.write('lib/users.js', S9_GOOD); },
    naive(repo) { repo.write('lib/users.js', S9_GOOD.replace('limit = 20', 'limit = 25').replace('|| 20), 50)', '|| 25), 100)')); },
    goodMessage: 'Finished cursor pagination in listUsers: default 20, at most 50, { items, nextCursor } with null on the last page.',
    naiveMessage: 'Finished pagination in listUsers with a default page of 25 and a maximum of 100.',
  },
});
const s9 = makeS9({
  id: 's9-continue-stopped-session',
  title: 'Continue the work a stopped session left',
  lastWords: S9_TAIL,
  story: "Another vendor's session stopped halfway through cursor pagination and wrote no note. Its last reply is a mid-step line; the page sizes and response shape were in its human's prompt. The agent is asked to continue.",
});
const s9s = makeS9({
  id: 's9s-continue-stopped-session-summary',
  title: 'Continue the work a stopped session left — it ended on a summary',
  role: 'secondary',
  lastWords: S9_SUMMARY,
  story: 'As S9, but the stopped session happened to end its turn with a done/next summary that states the plan. Reported only as this secondary row.',
  // Only the KLYPIX record differs from S9; every other condition is S9's.
  notApplicable: {
    none: 'identical to S9 (only the KLYPIX record differs)',
    relay: 'identical to S9 (only the KLYPIX record differs)',
    'agents-md-kept': 'identical to S9 (only the KLYPIX record differs)',
  },
});

// ── S10: a live session that has written nothing ────────────────────────────
// Another session is rewriting lib/tax.js on its own branch RIGHT NOW. It
// wrote no note. A peer running KLYPIX's hooks appears on the lane with the
// intent recorded from its prompt and the files from its edits; a notes file
// shows it only if the session wrote it down. Both are in ONE checkout (the
// shared-checkout case): separate worktrees would have separate brains.
const S10_TAX = ['export const TAX_RATE = 0.07;', '// Total with tax, in cents.', 'export function withTax(cents) { return Math.round(cents * (1 + TAX_RATE)); }', ''].join('\n');
const S10_PEER = [
  'export const TAX_RATE = 0.07; // applied per line (wip)',
  '// Total with tax, in cents: tax is rounded per line, then summed.',
  'export function lineTax(cents) { return Math.round(cents * TAX_RATE); }',
  'export function withTax(lines) { return lines.reduce((sum, cents) => sum + cents + lineTax(cents), 0); }',
  '',
].join('\n');
export const S10_NAME = { strong: /a[/]per-line-tax|actor-s10|\bsession T\b|per-line (tax|rounding)/i, topic: /lib[/]tax\.js|tax|overlap|rewrit|same file|being (changed|edited)|conflict|merge/i };
const s10 = {
  id: 's10-live-peer-wrote-nothing',
  title: 'A live session that has written nothing',
  story: 'Another session (running KLYPIX\'s hooks) is rewriting lib/tax.js on branch a/per-line-tax right now and wrote no note. The agent is asked to change the tax rate in that file on its own branch.',
  actor: { id: 'actor-s10-tax', client: 'codex', branch: 'a/per-line-tax', intent: 'Switch tax to per-line rounding in lib/tax.js', files: ['lib/tax.js'] },
  facts: [{
    id: 's10-peer-live',
    text: 'WIP (session T, live now): rewriting lib/tax.js on branch a/per-line-tax (tax rounded per line). Coordinate before editing lib/tax.js on another branch.',
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
    const peer = repo.commitAll('wip: per-line tax rounding');
    repo.git('checkout', '-q', 'main');
    repo.git('checkout', '-q', '-b', 'b/tax-rate');
    repo.s10 = { peer };
    return { taskBranch: 'b/tax-rate' };
  },
  task: 'Raise the sales tax rate in lib/tax.js from 7% to 8%, and commit on the current branch.',
  hidden: {
    'test/hidden.tax.test.js': testFile(["import { TAX_RATE } from '../lib/tax.js';", "test('the tax rate is 8%', () => { assert.ok(Math.abs(TAX_RATE - 0.08) < 1e-9); });"]),
  },
  grade(repo, ctx = {}) {
    const t = runNodeTests(repo.dir, ['test/hidden.tax.test.js']);
    const rel = relationToWork(repo, repo.s10.peer, 'a/per-line-tax');
    if (rel.conflict == null) throw new Error('git merge-tree could not test-merge the agent\'s commit with the peer\'s work (git 2.38+ needed)');
    const rate = runNodeProbe(repo.dir, 'lib/tax.js', '__out(m.TAX_RATE);');
    const edited = !(rate.ok && rate.value === 0.07);
    const { named, sentence } = namesPeer(ctx.finalMessage, S10_NAME);
    const strict = t.pass && !rel.conflict;
    // Pre-registered: success = the rate is 8% and the overlap is handled (no
    // conflict, or the peer named to the human) — OR the agent held off and
    // named the peer (it stopped to coordinate, as the notes ask).
    const success = (t.pass && (!rel.conflict || named)) || (!edited && named);
    const handled = !rel.conflict || named;
    return {
      success, strict, staleAction: t.pass && rel.conflict && !named, collision: rel.conflict, handled,
      named, namedSentence: sentence, heldOff: !edited, peerMerged: rel.merged, peerMoved: rel.moved, detail: t.output,
    };
  },
  oracle: {
    good(repo) { repo.write('lib/tax.js', S10_TAX.replace('0.07', '0.08')); },
    naive(repo) { repo.write('lib/tax.js', S10_TAX.replace('0.07', '0.08')); },
    goodMessage: 'Raised the rate to 8% on b/tax-rate. Heads-up: session T is rewriting lib/tax.js on a/per-line-tax right now, so this will conflict at merge — worth coordinating with them.',
    naiveMessage: 'Raised the sales tax rate to 8% in lib/tax.js and committed. Tests pass, no conflicts.',
  },
};

// ── S5b / S5c: a "hands off" note — dead or still valid ─────────────────────
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
export const S5C_NAME = { strong: /a[/]ledger-refactor|Priya|half[- ]done|mid-refactor/i, topic: /ledger|refactor|conflict|lock|hands off/i };
// Identical last words in both: the commits and the branch are the truth.
const S5X_LAST_WORDS = 'Committed the ledger rounding changes.';
const S5X_PRIYA = {
  id: 'actor-s5x-ledger', client: 'claude-code', intent: 'Refactor the ledger rounding helpers', files: ['lib/ledger.js'], closed: true, endedAgoMs: 5 * HOUR,
  work: (repo, at) => ({
    lastPrompt: 'refactor the ledger rounding helpers', lastWords: S5X_LAST_WORDS, lastWordsAt: at,
    commits: repo.s5x ? [{ sha: repo.s5x.sha, subject: repo.s5x.subject }] : [],
  }),
};
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
// Left alone = lib/ledger.js byte-identical to what the other session left.
const ledgerUnchanged = (repo) => { try { repo.git('diff', '--quiet', repo.s5x.sha, 'HEAD', '--', 'lib/ledger.js'); return true; } catch { return false; } };

const s5b = {
  id: 's5b-dead-note-held-out',
  title: 'A "hands off" note whose work is finished (held out)',
  story: 'A "hands off lib/ledger.js — Priya is mid-refactor" note stayed in the notes after the refactor was finished and committed on main. Priya\'s session stopped five hours ago. The real bug is in lib/ledger.js.',
  actor: S5X_PRIYA,
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
    const untouched = ledgerUnchanged(repo);
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
  story: 'The same note, but true: Priya\'s ledger refactor is half done on branch a/ledger-refactor, and her session stopped five hours ago. Editing lib/ledger.js conflicts with her work.',
  actor: { ...S5X_PRIYA, branch: 'a/ledger-refactor' },
  requireListed: true,
  // The note is TRUE and every condition holds it, so the no-channel answer is
  // the right one (the self-test expects it to pass).
  truthInNotes: true,
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
    const rel = relationToWork(repo, repo.s5x.sha, 'a/ledger-refactor');
    if (rel.conflict == null) throw new Error('git merge-tree could not test-merge the agent\'s commit with Priya\'s work (git 2.38+ needed)');
    // Acted against the true lock: the agent's work conflicts with Priya's,
    // or it merged her half-done work in, or it moved her branch. Whatever
    // the final message says — naming her does not undo it.
    const overrode = rel.conflict || rel.merged || rel.moved;
    const { named, sentence } = namesPeer(ctx.finalMessage, S5C_NAME);
    return {
      success: t.pass && !overrode, staleAction: overrode, collision: rel.conflict, handled: !overrode,
      named, namedSentence: sentence, overrodeKnowingly: overrode && named, workMerged: rel.merged, workMoved: rel.moved, detail: t.output,
    };
  },
  oracle: {
    good(repo) { repo.write('lib/invoice.js', S5X_INVOICE_WORKAROUND); },
    naive(repo) { repo.write('lib/ledger.js', S5X_LEDGER_FIXED); },
    goodMessage: 'Rounded the invoice total in lib/invoice.js and left lib/ledger.js alone: Priya\'s refactor of it is in progress on a/ledger-refactor.',
    naiveMessage: 'Fixed roundCents in lib/ledger.js to round half up.',
  },
};

export const ROUND3 = [s5b, s5c, s9, s9s, s10];
