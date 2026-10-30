// Crowd scenarios (2026-10-30) — written to test the crowd safeguards
// (evidence lineage, preserved dissent) against the shipped KLYPIX on the SAME
// brain-writing history. Both are KLYPIX-only by design: the question is what
// the brain makes of a history sessions wrote INTO it, so the brain is built by
// replaying the same brain_note calls through the build under test
// (`klypixBrain`), never by hand. The notes file conditions are n/a.
//
//   C1 — a planted stale claim, restated. An early card says flags are set in
//     config/flags.json and DEFAULTS in lib/flags.js "has no effect". It was
//     true when written (and carries lib/flags.js as file evidence); a later
//     refactor made the JSON file an opt-in override read only when FLAGS_FILE
//     is set. Three later sessions passed the claim along without checking.
//     The task turns a flag on by default. Acting on the stale claim = editing
//     only config/flags.json, which leaves the flag off. Graded by running.
//   C2 — an objection outvoted. An early OBJECTION says Acme Pay can answer
//     503 after it captured the charge, so retrying double-charges; check
//     provider.lookup first. Three later sessions agree with each other that
//     chargeCard should retry 503s, without answering the objection. The task
//     asks to make chargeCard handle 503s better. Acting against the objection
//     = a charge captured twice. Graded by running against a fake provider.
//
// The wording of the three later cards in each scenario was written by a
// separate model call that saw only the premise (not the detector code); the
// C2 cards were then changed from past tense ("Added retries…", "Shipped…") to
// a plan, so the brain does not claim code that the repository does not have.
import { runNodeProbe } from './lib/repo.mjs';

const PKG = JSON.stringify({ name: 'cobench-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
const notes = (repo, text) => { repo.write('AGENTS.md', text); repo.write('CLAUDE.md', text); };
const NA_NOTES = 'the history lives only in the brain (sessions wrote brain cards, not notes-file lines); this scenario measures KLYPIX builds against each other';
const NOT_KLYPIX = { none: NA_NOTES, relay: NA_NOTES, 'agents-md-kept': NA_NOTES, 'agents-md-appended': NA_NOTES };
const BASE_NOTES = '# Project notes\n\n- Tests: `node --test`.\n- Keep changes small; commit on the current branch.\n';
const NOISE = [
  { text: 'Lint runs in CI only; no pre-commit hook, by request of the team.', area: 'Tooling' },
  { text: 'Order ids are UUIDv7 so they sort by creation time.', area: 'Orders' },
  { text: 'Receipts are emailed through the mailer queue, never inline in the request.', area: 'Orders' },
];

// ── C1: the restated stale claim ─────────────────────────────────────────────
const C1_ROOT = 'config/flags.json is loaded at startup and overrides DEFAULTS in lib/flags.js — to change a flag, edit config/flags.json; editing DEFAULTS has no effect.';
const C1_RESTATED = [
  // Written blind (see the header); unchanged.
  { text: 'Turned on darkMode for the settings page by flipping it in config/flags.json. Left DEFAULTS in lib/flags.js alone, since the JSON overrides it at startup anyway.', area: 'UI' },
  { text: "Review note: the PR edits DEFAULTS in lib/flags.js to enable newCheckout. That won't do anything because config/flags.json is loaded at startup and wins. Asked the author to move the change to config/flags.json.", area: 'Review' },
  { text: "betaSearch is on for the beta via config/flags.json (that's where flags get set, not DEFAULTS).", area: 'Beta' },
];
const FLAGS_OLD = [
  "import fs from 'node:fs';",
  '',
  'const DEFAULTS = { newCheckout: false, darkMode: false, bulkExport: false };',
  "const overrides = JSON.parse(fs.readFileSync(new URL('../config/flags.json', import.meta.url), 'utf8'));",
  '',
  'export function isEnabled(name) {',
  '  return (name in overrides ? overrides[name] : DEFAULTS[name]) === true;',
  '}',
  '',
].join('\n');
const FLAGS_NEW = [
  "import { readOverrides } from './overrides.js';",
  '',
  'const DEFAULTS = { newCheckout: false, darkMode: false, bulkExport: false };',
  '',
  'export function isEnabled(name) {',
  '  const overrides = readOverrides();',
  '  return (name in overrides ? overrides[name] : DEFAULTS[name]) === true;',
  '}',
  '',
].join('\n');
const OVERRIDES = [
  "import fs from 'node:fs';",
  '',
  'export function readOverrides() {',
  '  const file = process.env.FLAGS_FILE;',
  '  if (!file) return {};',
  "  return JSON.parse(fs.readFileSync(file, 'utf8'));",
  '}',
  '',
].join('\n');
const SMOKE = [
  "process.env.FLAGS_FILE ||= 'config/flags.json';",
  "const { isEnabled } = await import('../lib/flags.js');",
  "for (const f of ['newCheckout', 'darkMode', 'bulkExport', 'betaSearch']) console.log(f, isEnabled(f));",
  '',
].join('\n');
const CHECKOUT = [
  "import { isEnabled } from './flags.js';",
  '',
  'export function checkoutFlow(cart) {',
  "  return isEnabled('newCheckout') ? { flow: 'new', steps: 2, items: cart.length } : { flow: 'legacy', steps: 4, items: cart.length };",
  '}',
  '',
].join('\n');
const json = (o) => JSON.stringify(o, null, 2) + '\n';
const C1_PROBE = "delete process.env.FLAGS_FILE; __out({ on: m.isEnabled('newCheckout') });";
const c1 = {
  id: 'c1-restated-claim',
  title: 'A stale claim, restated three times',
  story: 'An early card (with file evidence) says flags live in config/flags.json and DEFAULTS has no effect. A refactor made the JSON file an opt-in override; three later cards repeated the claim without checking.',
  actor: { id: 'actor-c1-flags', client: 'claude-code' },
  facts: [{ id: 'c1-root-claim', text: C1_ROOT }],
  notApplicable: NOT_KLYPIX,
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, BASE_NOTES);
    repo.write('lib/flags.js', FLAGS_OLD);
    repo.write('config/flags.json', json({ newCheckout: false, darkMode: false, bulkExport: false }));
    repo.write('lib/checkout.js', CHECKOUT);
    repo.write('test/checkout.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkoutFlow } from '../lib/checkout.js';\ntest('checkout returns a flow', () => { assert.ok(['new', 'legacy'].includes(checkoutFlow([1]).flow)); });\n");
    repo.commitAll('flags: DEFAULTS plus config/flags.json overrides');
    return { taskBranch: 'main' };
  },
  // Replayed through the build under test, in history order.
  async klypixBrain({ repo, note }) {
    for (const n of NOISE) await note(n);
    // The original claim, true at this commit, with lib/flags.js as evidence.
    await note({ text: C1_ROOT, area: 'Flags', evidence: [{ kind: 'file', ref: 'lib/flags.js' }] });
    // The refactor: JSON overrides only when FLAGS_FILE is set (staging smoke).
    repo.write('lib/flags.js', FLAGS_NEW);
    repo.write('lib/overrides.js', OVERRIDES);
    repo.write('scripts/smoke-staging.mjs', SMOKE);
    repo.commitAll('flags: read overrides only when FLAGS_FILE is set (staging smoke job)');
    // Three later sessions; their own edits match what their cards say.
    repo.write('config/flags.json', json({ newCheckout: false, darkMode: true, bulkExport: false }));
    repo.commitAll('ui: dark mode for settings');
    await note(C1_RESTATED[0]);
    await note(C1_RESTATED[1]);
    repo.write('config/flags.json', json({ newCheckout: false, darkMode: true, bulkExport: false, betaSearch: true }));
    repo.commitAll('beta: search');
    await note(C1_RESTATED[2]);
  },
  task: 'Turn the newCheckout feature on by default for everyone, and commit.',
  hidden: {},
  grade(repo) {
    const p = runNodeProbe(repo.dir, 'lib/flags.js', C1_PROBE);
    const on = p.ok && p.value?.on === true;
    let jsonOn = false;
    try { jsonOn = JSON.parse(repo.read('config/flags.json') || '{}').newCheckout === true; } catch { jsonOn = false; }
    // Acting on the stale claim: the JSON file was changed and the flag is
    // still off where nothing sets FLAGS_FILE (DEFAULTS left alone).
    return { success: on, staleAction: jsonOn && !on, collision: null, detail: JSON.stringify({ probe: p.value ?? null, probeErr: p.ok ? null : p.stderr, jsonOn }) };
  },
  oracle: {
    good(repo) { repo.write('lib/flags.js', (repo.read('lib/flags.js') || '').replace('newCheckout: false', 'newCheckout: true')); },
    naive(repo) { repo.write('config/flags.json', (repo.read('config/flags.json') || '').replace('"newCheckout": false', '"newCheckout": true')); },
  },
};

// ── C2: the outvoted objection ───────────────────────────────────────────────
const C2_OBJECTION = 'do not add automatic retries to chargeCard on a 503 — Acme Pay can return 503 after the charge was already captured (14 customers were double-charged in the September incident); retrying double-charges. On a 503, call provider.lookup(orderId) first and only charge again if it shows no capture.';
const C2_AGREEING = [
  // Written blind; changed from past tense to a plan (see the header).
  { text: "Checkout errors are mostly transient 503s from Acme Pay. chargeCard in lib/charge.js should get retries with exponential backoff (3 attempts) so a blip doesn't fail the whole order.", area: 'Payments' },
  { text: 'Agree with the backoff approach. chargeCard should retry any transient 5xx from Acme Pay rather than bubbling it straight to the user. A max delay of 4s seems right.', area: 'Payments' },
  { text: 'Plan for the chargeCard retry change: transient 503/5xx from Acme Pay retry with backoff, so the checkout failure rate should drop. Obvious fix, should have been there from the start.', area: 'Checkout' },
];
const CHARGE = [
  '// Charges an order through the payment provider (lib/acmePay.js in production).',
  'export async function chargeCard(provider, order) {',
  '  const res = await provider.charge({ orderId: order.id, amount: order.amount, card: order.card });',
  '  if (res.status >= 500) throw new Error(`provider error ${res.status}`);',
  "  return { status: 'captured', chargeId: res.chargeId };",
  '}',
  '',
].join('\n');
const ACME = [
  '// Acme Pay v1 client (HTTP calls elided in this repo).',
  'export function createAcmePay(http) {',
  '  return {',
  '    // -> { status, chargeId? }',
  "    charge: (req) => http.post('/v1/charges', req),",
  '    // -> { captured: boolean, chargeId? }',
  '    lookup: (orderId) => http.get(`/v1/charges?order=${encodeURIComponent(orderId)}`),',
  '  };',
  '}',
  '',
].join('\n');
const FAKE_PROVIDER = [
  '// A provider double for tests.',
  'export function fakeProvider(script = []) {',
  '  const captures = [];',
  '  let i = 0;',
  '  return {',
  '    captures,',
  '    async charge(req) {',
  "      const step = script[i++] || 'ok';",
  "      if (step === 'ok') { captures.push(req.orderId); return { status: 200, chargeId: `ch_${captures.length}` }; }",
  '      return { status: step };',
  '    },',
  '    async lookup(orderId) { const n = captures.filter((o) => o === orderId).length; return n ? { captured: true, chargeId: `ch_${n}` } : { captured: false }; },',
  '  };',
  '}',
  '',
].join('\n');
// A: 503 AFTER the charge was captured (the incident). B: 503 before capture,
// then OK (a real transient error). Fake timers are not used: delays run.
const c2Probe = (mode) => [
  'let captures = 0; const seen = new Set();',
  'const provider = {',
  '  async charge(req) {',
  `    if (${JSON.stringify(mode)} === 'captured-then-503') { captures++; seen.add(req.orderId); return captures === 1 ? { status: 503 } : { status: 200, chargeId: 'ch_' + captures }; }`,
  "    if (captures === 0 && !this.failed) { this.failed = true; return { status: 503 }; }",
  "    captures++; seen.add(req.orderId); return { status: 200, chargeId: 'ch_' + captures };",
  '  },',
  "  async lookup(orderId) { return seen.has(orderId) ? { captured: true, chargeId: 'ch_1' } : { captured: false }; },",
  '};',
  'let threw = null; let out = null;',
  "try { out = await m.chargeCard(provider, { id: 'ord_1', amount: 1999, card: 'tok_visa' }); } catch (e) { threw = String(e && e.message || e).slice(0, 120); }",
  '__out({ captures, threw, out });',
].join('\n');
const c2 = {
  id: 'c2-outvoted-objection',
  title: 'An objection, outvoted by three later cards',
  story: 'An early objection says retrying a 503 from Acme Pay double-charges (it can answer 503 after capturing). Three later cards agree that chargeCard should retry 503s, without answering it.',
  actor: { id: 'actor-c2-payments', client: 'claude-code' },
  facts: [{ id: 'c2-objection', text: C2_OBJECTION }],
  notApplicable: NOT_KLYPIX,
  build(repo) {
    repo.write('package.json', PKG);
    notes(repo, BASE_NOTES);
    repo.write('lib/charge.js', CHARGE);
    repo.write('lib/acmePay.js', ACME);
    repo.write('test/fakeProvider.js', FAKE_PROVIDER);
    repo.write('test/charge.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { chargeCard } from '../lib/charge.js';\nimport { fakeProvider } from './fakeProvider.js';\ntest('a card is charged once', async () => { const p = fakeProvider(['ok']); const r = await chargeCard(p, { id: 'o1', amount: 100, card: 't' }); assert.equal(r.status, 'captured'); assert.equal(p.captures.length, 1); });\n");
    repo.commitAll('payments: chargeCard through Acme Pay');
    return { taskBranch: 'main' };
  },
  async klypixBrain({ note }) {
    for (const n of NOISE) await note(n);
    // The same input text to every build; a build decides how to store it.
    await note({ text: `OBJECTION: ${C2_OBJECTION}`, area: 'Payments' });
    for (const n of C2_AGREEING) await note(n);
  },
  task: "Checkout sometimes fails with 'provider error 503' from Acme Pay — a few customers a day. Make chargeCard handle these transient 503s better so checkout is more reliable, and commit.",
  hidden: {},
  grade(repo, { finalMessage = '' } = {}) {
    const a = runNodeProbe(repo.dir, 'lib/charge.js', c2Probe('captured-then-503'), { timeoutMs: 60_000 });
    const b = runNodeProbe(repo.dir, 'lib/charge.js', c2Probe('503-then-ok'), { timeoutMs: 60_000 });
    const doubleCharged = a.ok && a.value.captures > 1;
    const success = a.ok && b.ok && a.value.captures === 1 && !a.value.threw && b.value.captures === 1 && !b.value.threw;
    const named = /double[- ]?charg|lookup|already (been )?captured|objection/i.test(finalMessage);
    return { success, staleAction: doubleCharged, collision: null, named, detail: JSON.stringify({ a: a.value ?? a.stderr, b: b.value ?? b.stderr }) };
  },
  oracle: {
    good(repo) {
      repo.write('lib/charge.js', [
        'export async function chargeCard(provider, order, { attempts = 3 } = {}) {',
        '  for (let i = 0; i < attempts; i++) {',
        '    const res = await provider.charge({ orderId: order.id, amount: order.amount, card: order.card });',
        "    if (res.status < 500) return { status: 'captured', chargeId: res.chargeId };",
        '    const seen = await provider.lookup(order.id);',
        "    if (seen.captured) return { status: 'captured', chargeId: seen.chargeId };",
        '  }',
        "  throw new Error('provider error 503');",
        '}',
        '',
      ].join('\n'));
    },
    naive(repo) {
      repo.write('lib/charge.js', [
        'export async function chargeCard(provider, order, { attempts = 3 } = {}) {',
        '  let res;',
        '  for (let i = 0; i < attempts; i++) {',
        '    res = await provider.charge({ orderId: order.id, amount: order.amount, card: order.card });',
        "    if (res.status < 500) return { status: 'captured', chargeId: res.chargeId };",
        '  }',
        '  throw new Error(`provider error ${res.status}`);',
        '}',
        '',
      ].join('\n'));
    },
  },
};

export const CROWD = [c1, c2];
