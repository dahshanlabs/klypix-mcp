// Marker suffix grammar + the ~ update floor (1.86.1).
//
// 1.86.0 added `q:` to the marker suffix keys and split every marker body at the
// first whitespace + "Q:"/"q:", in any case. A pre-release audit of the desktop
// bundle reproduced the damage end to end: "Support page gets a Q: and A:
// layout so pricing questions read as a FAQ" landed as the card "Support page
// gets a", and "~: Pricing page layout switches to Q: and A: FAQ blocks …"
// REPLACED a thirteen-word card with a four-word stub — no ↩ trace, no Archive
// copy. The same mid-sentence hazard already existed for `ev:`, `verify:` and
// `closes:`. Every harmful case from that audit, and from the review of the
// first fix, is a check here:
//
//   G1  prose "Q:"/"q:" (English and Arabic) never cuts a body; nor does "the
//       ev:", "every agent verify: the tag", `npm run verify:mcp`, "q:auth",
//       "we verify:", "Always verify:", "Rule: verify:", "added: q:", a verify:
//       value that reads as a sentence, or an ev: value that reads as a phrase.
//   G2  every DOCUMENTED form still parses: trailing q:, closes:/ev:/verify: in
//       any order, PR shorthands, absolute paths, probe names, Arabic q: (with
//       direction marks, vowel marks, dialect question words), `ev:src/a.ts`,
//       `closes:[[X]]`, `Closes: [[X]]`, a suffix after "stays on" / "option A"
//       / "in May", repeated ev:, and a malformed LATER segment goes back into
//       the text while the well-formed ones still count.
//   G3  the grammar is ONE block, byte-identical in the hook and klypix-format;
//       parseVerifySuffix agrees with the hook, reads a verify: on its own line,
//       and brain_note's clear-verify check asks that same reader.
//   U1  the ~ floor: a stub never replaces a richer card — it is APPENDED to it
//       as a dated "(~ amended …)" line, never dropped, never a separate card;
//       a re-harvested one is a silent no-op; a full correction still replaces.
//   Q1  the same floor on the open-question merge.
//   C1  a closes: that will not act (names nothing, or > 4 cards) lands the
//       sentence as written; a prose closes: acts only on a card it NAMES.
//   E1  end to end through the real Stop hook on a scratch brain, and the
//       receipts reach the MODEL on its next prompt, once.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const SRC = new URL('../src/', import.meta.url);
const HOOK = fileURLToPath(new URL('global-brain-hook.mjs', SRC));

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);

const prevNoMain = process.env.KLYPIX_BRAIN_NO_MAIN;
process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const hook = await import(new URL('global-brain-hook.mjs', SRC).href);
if (prevNoMain === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = prevNoMain;
const fmt = await import(new URL('klypix-format.mjs', SRC).href);
const { prepareBrainEvidence } = await import(new URL('brain-evidence.mjs', SRC).href);
const { splitMarkerSuffixes } = hook;
const { buildKlypixMap, parseKlypix, captureIntoBrain, formatCaptureReceipts, parseVerifySuffix, partialNoteRuns, hasPartialNote } = fmt;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-proj-'));

try {
  // ── G1 — prose is never a suffix ──────────────────────────────────────────
  const untouched = (label, body) => {
    const r = splitMarkerSuffixes(body);
    ok(r.body === body && !r.closes && !r.evidence && !r.verify && !r.question && !r.kept,
      `G1 ${label} → whole body kept [${flat(r.body).slice(0, 60)}]`);
  };
  untouched('uppercase Q: mid-sentence', 'Support page gets a Q: and A: layout so pricing questions read as a FAQ');
  untouched('uppercase Q: after an adjective', 'Onboarding doc adds a short Q: section answering the three most common install errors');
  untouched('lowercase q: in prose (value is not a question)', 'Help center entries use q: prefixes so search indexes the question text first');
  untouched('interview notes with Q: … A:', 'User interview notes: Q: what blocks adoption? A: no team sharing yet, so shared canvases move up the roadmap');
  untouched('q: as literal search syntax, and q:auth', 'Search box accepts q: syntax like q:auth to filter cards by area');
  untouched('Q&A has no colon', 'Keep the Q&A page as the single FAQ source; the landing page links to it');
  untouched('FAQ: is not a key', 'Decided: FAQ: entries stay in the docs, not the brain');
  untouched('an open question quoting Q:', 'Should the Q: prefix in support macros be localized for Arabic agents?');
  untouched('an open question quoting q: after "the"', 'Should the q: prefix in support macros be localized for Arabic agents?');
  untouched('ev: after "the" (1.85 hazard too)', 'Retrieval scores the ev: field separately from card text so evidence paths do not dominate ranking');
  untouched('"see the ev: numbers" (1.85 hazard too)', 'Semantic blend stays on; see the ev: numbers in the eval report for the lift on paraphrase prompts');
  untouched('verify: used as a verb (value is not a command)', 'Release checklist now makes every agent verify: the tag, the npm version and the desktop bundle before announcing');
  untouched('"runs the verify: probe"', 'Capture hook now runs the verify: probe only for fast-decay cards, never for decisions');
  untouched('an npm script name `verify:mcp`', 'Bundle synced (c8a69a8, `npm run verify:mcp` gate green)');
  untouched('Verify: capitalized', 'Release notes list the steps. Verify: gh release view v1.2.0');
  untouched('Arabic prose quoting Q:', 'صفحة الدعم تعرض الأسئلة بصيغة Q: و A: حتى تقرأ كأسئلة شائعة');
  untouched('Arabic without suffixes', 'قررنا إبقاء الفهرس المحلي مجانيا لكل الخطط');
  untouched('ev: with a one-word non-reference value', 'Brain decision ev: pending');
  untouched('a q: with no question word', 'Pan tool moves to the toolbar q: pan tool location?');
  // Review round 2: a value that happens to LOOK valid, after a word that
  // leaves the clause open or inside a sentence.
  untouched('verify: whose command is followed by prose', 'Release gate now requires agents verify: npm view klypix-mcp version matches the tag before announcing');
  untouched('"Rule: verify:" (a label, not a claim)', 'Rule: verify: git tag and npm version agree before announcing');
  untouched('"always verify:"', 'Before tagging, always verify: npm view klypix-mcp version');
  untouched('"Always verify:" (Titlecase open word)', 'Before tagging, Always verify: npm view klypix-mcp version');
  untouched('verify: in a status sentence', 'Status line shows verify: gh run list as the probe when stale');
  untouched('"added: q:" (a body ending in a colon)', 'FAQ entry added: q: how do I reset my password?');
  untouched('"we verify:" (subject pronoun)', 'Before tagging we verify: gh release view v1.2.0');
  untouched('"I verify:" (subject pronoun)', 'Stale cards get flagged; I verify: git log -1 before trusting them');
  untouched('an ev: value that is a phrase', 'Docs say to append ev: PR#12 to the line');
  untouched('an ev: value longer than a reference', 'Fix landed ev: CI run 35345269613 on the fix branch');

  // ── G2 — every documented form still parses ──────────────────────────────
  const en9 = splitMarkerSuffixes('Pan = dedicated hand tool in toolbar; Zoom = steppers in the status bar q: how do I move around the board and change magnification? closes: [[Canvas navigation]] ev: src/canvas/Toolbar.tsx');
  ok(en9.body === 'Pan = dedicated hand tool in toolbar; Zoom = steppers in the status bar'
    && en9.question === 'how do I move around the board and change magnification?'
    && en9.closes === '[[Canvas navigation]]' && en9.evidence?.[0]?.ref === 'src/canvas/Toolbar.tsx',
    'G2 q: + closes: + ev: together (the EN9 form)');
  const trailingQ = splitMarkerSuffixes('Pan tool moves to the toolbar q: where did the pan tool go?');
  ok(trailingQ.body === 'Pan tool moves to the toolbar' && trailingQ.question === 'where did the pan tool go?', 'G2 a trailing q: question');
  const qAlone = splitMarkerSuffixes('Keep the merge driver append-only q: why can a merge never drop a card?');
  ok(qAlone.body === 'Keep the merge driver append-only' && qAlone.question === 'why can a merge never drop a card?' && !qAlone.closes && qAlone.evidence === null,
    'G2 q: alone, other keys empty');
  const arabicQ = splitMarkerSuffixes('تم نقل أداة التحريك إلى شريط الأدوات q: أين ذهبت أداة التحريك؟');
  ok(arabicQ.body === 'تم نقل أداة التحريك إلى شريط الأدوات' && arabicQ.question === 'أين ذهبت أداة التحريك؟', 'G2 an Arabic q: question ending in ؟');
  const upperQ = splitMarkerSuffixes('Merge driver stays append-only Q: why can a merge never drop a card?');
  ok(upperQ.body === 'Merge driver stays append-only Q: why can a merge never drop a card?' && !upperQ.question,
    'G2 an UPPERCASE Q: is text (the key is lowercase, as documented) — the 1.85 result');
  const all3 = splitMarkerSuffixes('shipped the uploader closes: Upload question ev: src/x.mjs verify: gh run list --limit 3');
  ok(all3.body === 'shipped the uploader' && all3.closes === 'Upload question' && all3.evidence?.length === 1
    && all3.evidence[0].ref === 'src/x.mjs' && all3.verify === 'gh run list --limit 3', 'G2 closes: + ev: + verify: (decay-hook form)');
  const reordered = splitMarkerSuffixes('did x verify: gh release list; gh run list closes: Old q');
  ok(reordered.body === 'did x' && reordered.verify === 'gh release list; gh run list' && reordered.closes === 'Old q', 'G2 verify: before closes:, PS-safe ; chain kept');
  const selfHeal = splitMarkerSuffixes('Auth tokens rotate every 7 days in the session store ev: src/auth/session.ts:42');
  ok(selfHeal.body === 'Auth tokens rotate every 7 days in the session store' && selfHeal.evidence?.[0]?.ref === 'src/auth/session.ts:42', 'G2 the self-heal footer form (claim ev: file:line)');
  for (const ref of ['PR#123', 'PR 123', 'GH3', 'issue#3', '#3', '123']) {
    ok(splitMarkerSuffixes(`claim ev: ${ref}`).evidence?.[0]?.kind === 'pr', `G2 ev: shorthand ${ref} is still a PR reference`);
  }
  const multi = splitMarkerSuffixes('fixed ev: klypix-app PR #222, klypix-mcp PR #45, https://github.com/x/y/pull/35, Makefile');
  ok(multi.body === 'fixed' && multi.evidence?.length === 4, 'G2 ev: repo-qualified PRs, a URL and an extensionless file');
  const probe = splitMarkerSuffixes('npm currency checked verify: npm-version klypix-mcp');
  ok(probe.verify === 'npm-version klypix-mcp', 'G2 verify: a hyphenated probe name (PROBE_DESIGN form)');
  const pwsh = splitMarkerSuffixes('installer staged verify: Get-ChildItem release/*.exe');
  ok(pwsh.verify === 'Get-ChildItem release/*.exe', 'G2 verify: a PowerShell cmdlet');
  const afterProse = splitMarkerSuffixes('Retrieval scores the ev: field separately ev: src/rank.mjs');
  ok(afterProse.body === 'Retrieval scores the ev: field separately' && afterProse.evidence?.[0]?.ref === 'src/rank.mjs',
    'G2 a real suffix AFTER a prose "ev:" still parses, and the prose stays');
  const closesProse = splitMarkerSuffixes('The resolver treats closes: links as exact title matches rather than fuzzy overlap');
  ok(closesProse.closes === 'links as exact title matches rather than fuzzy overlap' && closesProse.closesAnchored === false
    && closesProse.bodyWithCloses === 'The resolver treats closes: links as exact title matches rather than fuzzy overlap',
    'G2 closes: is free text — an UNanchored one, with the full sentence for capture to fall back to (C1 below)');
  ok(splitMarkerSuffixes('Shipped the retry. closes: Upload retry question').closesAnchored === true
    && splitMarkerSuffixes('Shipped the retry closes: [[Upload retry question]]').closesAnchored === true
    && splitMarkerSuffixes('Shipped the retry closes: Upload retry question ev: src/retry.mjs').closesAnchored === true
    && splitMarkerSuffixes('The resolver treats closes: [[wikilinks]] as exact titles now').closesAnchored === false,
    'G2 closesAnchored: after a clause boundary, a lone [[wikilink]], or a well-formed sibling — not a wikilink inside prose');
  // Review round 2: one malformed segment no longer cancels the others.
  const foldQ = splitMarkerSuffixes('Pan hand tool moved into the main toolbar closes: Canvas navigation ev: src/canvas/Toolbar.tsx q: how do I pan the canvas');
  ok(foldQ.closes === 'Canvas navigation' && foldQ.evidence?.[0]?.ref === 'src/canvas/Toolbar.tsx' && !foldQ.question
    && foldQ.body === 'Pan hand tool moved into the main toolbar q: how do I pan the canvas' && foldQ.kept === 'q: how do I pan the canvas',
    'G2 closes:+ev:+q:<no ?> keeps closes and ev; the q: text goes back into the body and is reported as kept');
  const foldVerify = splitMarkerSuffixes('Release 1.2 cut closes: Release question ev: PR#12 verify: open the admin releases page and read the rollout row');
  ok(foldVerify.closes === 'Release question' && foldVerify.evidence?.[0]?.ref === 'PR#12' && !foldVerify.verify
    && /verify: open the admin releases page/.test(foldVerify.body), 'G2 closes:+ev:+verify:<prose> keeps closes and ev; the verify: prose stays text');
  const prepQ = splitMarkerSuffixes('Pan hand tool moved closes: Canvas navigation ev: src/canvas/Toolbar.tsx q: On which toolbar does the pan tool live?');
  ok(prepQ.question === 'On which toolbar does the pan tool live?' && prepQ.closes === 'Canvas navigation', 'G2 a q: that opens with a preposition + which/what');
  const soft = [
    ['Semantic blend stays on ev: brain-eval-report.md', 'Semantic blend stays on', 'brain-eval-report.md'],
    ['Leave the merge driver as is ev: src/merge-driver.mjs', 'Leave the merge driver as is', 'src/merge-driver.mjs'],
    ['Uploads have to be signed in ev: src/drive/upload.ts', 'Uploads have to be signed in', 'src/drive/upload.ts'],
    ['Nightly cron fires at 07:00 am ev: src/core/schedule.ts', 'Nightly cron fires at 07:00 am', 'src/core/schedule.ts'],
  ];
  for (const [line, body, ref] of soft) {
    const r = splitMarkerSuffixes(line);
    ok(r.body === body && r.evidence?.[0]?.ref === ref, `G2 an end-of-line ev: after "${body.split(' ').slice(-2).join(' ')}" still parses`);
  }
  ok(splitMarkerSuffixes('Beta ships in May closes: Beta date question').closes === 'Beta date question'
    && splitMarkerSuffixes('Went with option A closes: Which pricing option should we pick').closes === 'Which pricing option should we pick',
    'G2 "in May closes:" and "option A closes:" end a clause');
  const nospace = splitMarkerSuffixes('Shipped the uploader closes:[[Upload retry question]]');
  ok(nospace.body === 'Shipped the uploader' && nospace.closes === '[[Upload retry question]]', 'G2 closes:[[wikilink]] with no space');
  const nospaceEv = splitMarkerSuffixes('Uploader retries ev:src/upload.ts');
  ok(nospaceEv.body === 'Uploader retries' && nospaceEv.evidence?.[0]?.ref === 'src/upload.ts', 'G2 ev:src/path with no space');
  const capCloses = splitMarkerSuffixes('Merged the fix. Closes: [[Upload retry question]]');
  ok(capCloses.body === 'Merged the fix.' && capCloses.closes === '[[Upload retry question]]', 'G2 a capitalised Closes: before a [[wikilink]]');
  ok(splitMarkerSuffixes('shipped X ev:').body === 'shipped X', 'G2 a dangling key at the very end is dropped');
  const dangling2 = splitMarkerSuffixes('shipped X closes: [[Y]] ev:');
  ok(dangling2.body === 'shipped X' && dangling2.closes === '[[Y]]', 'G2 a dangling ev: after closes: never folds into the target');
  const twoEv = splitMarkerSuffixes('shipped X ev: docs/sync.md ev: src/sync.mjs');
  ok(twoEv.evidence?.map((e) => e.ref).join(',') === 'docs/sync.md,src/sync.mjs', 'G2 a repeated ev: joins its references');
  const arabicComma = splitMarkerSuffixes('Sync moved ev: docs/sync.md، src/sync.mjs');
  ok(arabicComma.evidence?.map((e) => e.ref).join(',') === 'docs/sync.md,src/sync.mjs', 'G2 ev: references separated by the Arabic comma');
  const arabicForms = [
    ['q: أين ذهبت أداة التحريك؟‏', 'a trailing right-to-left mark'],
    ['q: ‏أين ذهبت أداة التحريك؟', 'a leading right-to-left mark'],
    ['q: كَيْفَ أحرك اللوحة؟', 'vowel marks'],
    ['q: وين راحت أداة التحريك؟', 'a dialect question word (وين)'],
    ['q: ماهي أداة التحريك الجديدة؟', 'the joined spelling ماهي'],
  ];
  for (const [suffix, label] of arabicForms) {
    const r = splitMarkerSuffixes(`تم نقل أداة التحريك ${suffix}`);
    ok(r.body === 'تم نقل أداة التحريك' && r.question && !/[‎‏]/.test(r.question), `G2 an Arabic q: with ${label}`);
  }

  // ── G3 — one grammar, two byte-identical copies ───────────────────────────
  const blockOf = (file) => {
    const src = fs.readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('// ── Marker suffix grammar ─── MIRROR BEGIN');
    const b = src.indexOf('// ── Marker suffix grammar ─── MIRROR END');
    return a >= 0 && b > a ? src.slice(a, b) : null;
  };
  const hookBlock = blockOf('global-brain-hook.mjs');
  const fmtBlock = blockOf('klypix-format.mjs');
  ok(Boolean(hookBlock) && hookBlock === fmtBlock, 'G3 the grammar block is byte-identical in global-brain-hook.mjs and klypix-format.mjs');
  ok(!/[‎‏‪-‮⁦-⁩]/.test(hookBlock || ''), 'G3 the grammar source carries no invisible direction marks (they are written as escapes)');
  const corpus = [
    'shipped the uploader closes: Upload question ev: src/x.mjs verify: gh run list --limit 3',
    'did x verify: gh release list; gh run list closes: Old q',
    '🏁 build 26 uploaded verify: gh run list --limit 5 ev: PR #855',
    'Release checklist now makes every agent verify: the tag, the npm version and the desktop bundle before announcing',
    'Capture hook now runs the verify: probe only for fast-decay cards, never for decisions',
    'Bundle synced (c8a69a8, `npm run verify:mcp` gate green)',
    'the engine actually RUNNING a card\'s verify: command on demand, and demanding a probe receipt',
    'installer staged verify: Get-ChildItem release/*.exe',
    'Release gate now requires agents verify: npm view klypix-mcp version matches the tag before announcing',
    'plain decision with no suffixes',
  ];
  const disagree = corpus.filter((line) => (splitMarkerSuffixes(line).verify || null) !== parseVerifySuffix(line));
  ok(disagree.length === 0, `G3 parseVerifySuffix (card prose) agrees with the hook on every line (${disagree.length} disagree)`);
  ok(parseVerifySuffix('Release: 🏁 build 26 uploaded verify: gh run list --limit 5\n#release') === 'gh run list --limit 5',
    'G3 parseVerifySuffix reads a suffix on its own line of a multi-line card');
  ok(parseVerifySuffix('Release: 🏁 build 26 uploaded\nverify: gh run list --limit 5') === 'gh run list --limit 5',
    'G3 parseVerifySuffix reads a verify: that starts its own line (the tail of the line above)');
  const clear = (text) => prepareBrainEvidence({ projectRoot: proj, marker: '~', verify: '', text, deriveVerify: parseVerifySuffix }).ok;
  ok(!clear('claim verify: gh run list --limit 5'), 'G3 brain_note still refuses to clear verify while a real `verify: <command>` sits in the text');
  ok(!clear('Release: 🏁 build 26 uploaded\nverify: gh run list --limit 5'), 'G3 …including one on its own line');
  ok(clear('Release checklist now makes every agent verify: the tag, the npm version and the desktop bundle'),
    'G3 …but a sentence that uses "verify:" as a verb is not refused (the reader derives nothing from it)');
  ok(clear('gate `npm run verify:mcp` is green'), 'G3 …nor an npm script name');

  // ── U1 — the ~ update floor ────────────────────────────────────────────────
  const seed = () => buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Pricing', cards: [{ text: 'Pricing: Pricing page layout uses three tiered plan cards with an annual toggle above them' }] },
      { title: 'Support', cards: [{ text: 'Support: Support page layout is one long list of help articles grouped by product area' }] },
      { title: 'Dev', cards: [{ text: 'Dev: Dev server listens on port 5173' }] },
    ],
  });
  const live = (struct) => struct.cards.filter((c) => c.type !== 'container' && !/^archive$/i.test(c.area || ''));
  const liveText = (struct, re) => live(struct).filter((c) => re.test(flat(c.text))).map((c) => flat(c.text));
  const amendments = (text) => (flat(text).match(/\(~ amended \d{4}-\d{2}-\d{2}:/g) || []).length;
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const pricingBefore = s0.cards.find((c) => /three tiered plan/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Pricing', text: 'Pricing page layout switches to', createdVia: 'claude-code' }] });
    const { struct } = await parseKlypix(buffer);
    const pricingAfter = struct.cards.find((c) => c.id === pricingBefore.id);
    ok(flat(pricingAfter.text).startsWith(flat(pricingBefore.text)),
      `U1 a four-word stub does NOT replace the thirteen-word card [${flat(pricingAfter.text).slice(0, 50)}]`);
    ok(flat(pricingAfter.text).includes(`(~ amended ${today}: Pricing page layout switches to)`) && stats.updated === 1,
      'U1 …it is appended to that card as a dated amendment line');
    ok(!/^archive$/i.test(pricingAfter.area || '') && !/↩/.test(pricingAfter.text), 'U1 the card stays live — no supersede by another route');
    ok(stats.updateAmended?.length === 1 && stats.updateAmended[0].id === pricingBefore.id && stats.updateAmended[0].words === 4,
      'U1 the amendment is reported with its counts and the card id');
    ok(liveText(struct, /^Pricing: Pricing page layout switches to/).length === 0 && live(struct).length === live(s0).length,
      'U1 no separate stub card is minted');
    ok(formatCaptureReceipts(stats).some((l) => /appended, not replaced/.test(l) && l.includes(pricingBefore.id)), 'U1 the receipt tells the author, naming the card');
    const again = await captureIntoBrain(buffer, { updates: [{ area: 'Pricing', text: 'Pricing page layout switches to', createdVia: 'claude-code' }] });
    const { struct: s2 } = await parseKlypix(again.buffer);
    const richAgain = s2.cards.find((c) => c.id === pricingBefore.id);
    ok(amendments(richAgain.text) === 1 && again.stats.updated === 0 && again.stats.updateUnchanged?.length === 1 && !again.stats.updateAmended,
      'U1 a re-harvested thin ~ is a silent no-op: one amendment line, nothing reported as amended');
    ok(formatCaptureReceipts(again.stats).length === 0, 'U1 …and no receipt repeats at every Stop');
  }
  {
    // The price repro: every content word of the correction is already on the
    // card ("$5" is not a content word), so a separate card was dropped as a
    // near-duplicate of the stale one and the correction was lost.
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Store', cards: [{ text: 'Store: Pro plan price is $4 monthly, billed via Stripe checkout; annual plans get two months free and team seats' }] }] });
    const { struct: s0 } = await parseKlypix(buf);
    const card = s0.cards.find((c) => /\$4 monthly/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Store', text: 'Pro plan price is $5 monthly, billed via Stripe' }] });
    const { struct } = await parseKlypix(buffer);
    const after = flat(struct.cards.find((c) => c.id === card.id).text);
    ok(stats.updated === 1 && after.includes('(~ amended') && after.includes('$5 monthly') && liveText(struct, /Pro plan price/).length === 1,
      'U1 the price correction lands ON its card (the $4 claim is kept, the $5 amendment follows it), never lost as a near-duplicate');
  }
  {
    // The deploy repro: the old floor left the stale card live AND a
    // contradicting card beside it.
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Deploy', cards: [{ text: 'Deploy: Staging deploys run from the release branch through the GitHub Actions workflow nightly' }] }] });
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Deploy', text: 'Staging deploys now run from main branch' }] });
    const { struct } = await parseKlypix(buffer);
    const cards = liveText(struct, /Staging deploys/);
    ok(stats.updated === 1 && cards.length === 1 && /now run from main branch/.test(cards[0]), `U1 the deploy correction is ON the one live Deploy card (${cards.length} live)`);
  }
  {
    // The follow-the-receipt sequence: a stub, then the full correction, then
    // both re-harvested. The full ~ must rewrite the ORIGINAL card, and the
    // stub must never be reported again once the card says it.
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const support = s0.cards.find((c) => /one long list/.test(c.text));
    const stub = { area: 'Support', text: 'Support page layout now uses' };
    const full = { area: 'Support', text: 'Support page layout now uses Q: and A: pairs grouped by plan instead of one long list' };
    const r1 = await captureIntoBrain(buf, { updates: [stub] });
    ok(r1.stats.updateAmended?.length === 1 && amendments((await parseKlypix(r1.buffer)).struct.cards.find((c) => c.id === support.id).text) === 1,
      'U1 Stop 1: the Support stub (4 words vs 10) is appended to its card');
    const r2 = await captureIntoBrain(r1.buffer, { updates: [stub, full] });
    const { struct: s2 } = await parseKlypix(r2.buffer);
    const orig = flat(s2.cards.find((c) => c.id === support.id).text);
    ok(orig.startsWith('Support: Support page layout now uses Q: and A: pairs') && liveText(s2, /Support page layout/).length === 1,
      'U1 Stop 2: the full ~ rewrites the ORIGINAL card, and there is no stub card to attract it');
    const r3 = await captureIntoBrain(r2.buffer, { updates: [stub, full] });
    const { struct: s3 } = await parseKlypix(r3.buffer);
    ok(!r3.stats.updateAmended && liveText(s3, /Support page layout/).length === 1 && amendments(s3.cards.find((c) => c.id === support.id).text) === 0,
      'U1 Stop 3: the re-harvested stub is a no-op (the card already says it) — nothing reported, nothing appended');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const pricing = s0.cards.find((c) => /three tiered plan/.test(c.text));
    const full = 'Pricing page layout switches to Q: and A: FAQ blocks and the annual toggle is removed';
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Pricing', text: full }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.updated === 1 && !stats.updateAmended && flat(struct.cards.find((c) => c.id === pricing.id).text).startsWith(`Pricing: ${full}`),
      'U1 the FULL correction still replaces in place (documented ~ semantics, the 1.85 result)');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const dev = s0.cards.find((c) => /port 5173/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Dev', text: 'Dev server listens on port 5174' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.updated === 1 && /5174/.test(struct.cards.find((c) => c.id === dev.id).text) && !/5173/.test(struct.cards.find((c) => c.id === dev.id).text),
      'U1 a four-word correction of a four-word card still replaces (the floor is relative, not absolute)');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const pricing = s0.cards.find((c) => /three tiered plan/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Pricing', text: 'still true: pricing page layout plan cards' }] });
    const { struct } = await parseKlypix(buffer);
    const after = flat(struct.cards.find((c) => c.id === pricing.id).text);
    ok(stats.updated === 1 && /three tiered plan/.test(after) && /re-affirmed/.test(after), 'U1 a terse confirmation still APPENDS (exempt from the floor)');
  }
  ok(typeof fmt.isThinUpdate === 'function' && fmt.isThinUpdate(4, 13) && fmt.isThinUpdate(5, 11) && !fmt.isThinUpdate(6, 40) && !fmt.isThinUpdate(4, 8) && fmt.UPDATE_MIN_WORDS === 6,
    'U1 isThinUpdate: < 6 content words AND under half the card\'s');
  ok(typeof fmt.cardAlreadySays === 'function' && fmt.cardAlreadySays('Dev: Dev server listens on port 5173', 'port 5173') && !fmt.cardAlreadySays('Dev: Dev server listens on port 5173', 'port 51')
    && fmt.cardAlreadySays('Paths: see src/canvas/interaction/ConnectionPale\ntteOverlay.tsx for it', 'src/canvas/interaction/ConnectionPaletteOverlay.tsx'),
    'U1 cardAlreadySays is word-bounded ("port 51" is not in "port 5173") and reads a mid-word wrap');
  {
    // An amendment line ENDS a ✔ partial note run, so the note keeps its
    // identity and a re-harvested ✓ is still recognised as already noted.
    const text = 'Release: 🏁 1.2 shipped — remaining: docs + changelog\n✔ partial 2026-09-18: docs updated — still open: changelog\n(~ amended 2026-09-18: npm tag is latest)';
    ok(partialNoteRuns(text).length === 1 && partialNoteRuns(text)[0].key === 'docs updated' && hasPartialNote(text, 'docs updated'),
      'U1 an amendment after a ✔ partial note is not absorbed into the note (no re-stacking)');
  }

  // ── Q1 — the floor on the open-question merge ─────────────────────────────
  {
    const rich = 'Support: ❓ Should support macros be localized for Arabic agents, and who owns the translations for the help center articles and canned replies?';
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Support', cards: [{ text: rich }] }] });
    const { struct: s0 } = await parseKlypix(buf);
    const q = s0.cards.find((c) => /canned replies/.test(c.text));
    const r1 = await captureIntoBrain(buf, { cards: [{ text: 'Support: ❓ Should support macros be localized\n#support', area: 'Support' }] });
    const { struct: s1 } = await parseKlypix(r1.buffer);
    ok(flat(s1.cards.find((c) => c.id === q.id).text) === flat(q.text) && live(s1).length === live(s0).length && r1.stats.merged === 1,
      'Q1 a thin ❓ the rich question already says is a duplicate — the rich question is NOT rewritten to the stub');
    const r2 = await captureIntoBrain(buf, { cards: [{ text: 'Support: ❓ Should support macros be translated?\n#support', area: 'Support' }] });
    const { struct: s2 } = await parseKlypix(r2.buffer);
    ok(flat(s2.cards.find((c) => c.id === q.id).text) === flat(q.text) && liveText(s2, /support macros be translated/).length === 1,
      'Q1 a thin ❓ with a new word lands as its own card; the rich question is untouched');
  }

  // ── C1 — a closes: that will not act lands the sentence as written ────────
  const closeSeed = () => buildKlypixMap({
    title: 'brain',
    areas: [{ title: 'Brain', cards: [
      { text: 'Brain: ❓ Should the uploader retry on a 429 or back off entirely' },
      { text: 'Brain: the merge driver keeps every card from both sides' },
    ] }],
  });
  {
    const proseCard = 'Brain: The resolver treats\n#brain';
    const written = 'Brain: The resolver treats closes: links as exact title matches rather than fuzzy overlap\n#brain';
    const { stats, buffer } = await captureIntoBrain(await closeSeed(), {
      cards: [{ text: proseCard, area: 'Brain', closes: 'links as exact title matches rather than fuzzy overlap', closesFallbackText: written }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(liveText(struct, /^Brain: The resolver treats closes: links as exact title matches rather than fuzzy overlap/).length === 1,
      'C1 a prose closes: that names no card lands the WHOLE sentence');
    ok(!liveText(struct, /^Brain: The resolver treats( #|$)/).length && stats.closed === 0 && stats.closesKept?.length === 1,
      'C1 no truncated card, nothing closed, and the receipt is in stats');
    ok(formatCaptureReceipts(stats).some((l) => /names no live card/.test(l)), 'C1 the receipt tells the author');
    const raw = JSON.stringify(struct.cards);
    ok(!/closesFallbackText|closesAnchored|__closeStrict/.test(raw), 'C1 the fallback fields are transport only — never persisted');
  }
  {
    const { stats, buffer } = await captureIntoBrain(await closeSeed(), {
      cards: [{ text: 'Brain: 🏁 uploader backs off on 429\n#brain', area: 'Brain', closes: 'Should the uploader retry on a 429 or back off entirely',
        closesFallbackText: 'Brain: 🏁 uploader backs off on 429 closes: Should the uploader retry on a 429 or back off entirely\n#brain' }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 1 && !stats.closesKept && liveText(struct, /^Brain: 🏁 uploader backs off on 429( #|$)/).length === 1,
      'C1 an unanchored closes: that NAMES a card by title still closes it, and the card text stays clean');
    ok(stats.closedCards?.length === 1 && formatCaptureReceipts(stats).some((l) => /archived \(id /.test(l) && /Should the uploader retry/.test(l)),
      'C1 the receipt names the card a closes: archived');
  }
  {
    const { stats, buffer } = await captureIntoBrain(await closeSeed(), {
      cards: [{ text: 'Brain: 🏁 shipped the thing\n#brain', area: 'Brain', closes: 'a target that matches nothing at all anywhere' }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && !stats.closesKept && liveText(struct, /^Brain: 🏁 shipped the thing( #|$)/).length === 1,
      'C1 a structured closes (brain_note, no fallback text) is unchanged');
  }
  // A target too generic to trust (> 4 cards) closes nothing AND lands the
  // sentence as written — it used to land the cut text.
  const genericSeed = (n) => buildKlypixMap({
    title: 'brain',
    areas: [{ title: 'Release', cards: Array.from({ length: n }, (_, i) => ({ text: `Release: ❓ matching release question card number ${['one', 'two', 'three', 'four', 'five', 'six'][i]} about the train` })) }],
  });
  for (const n of [6, 5]) {
    const cut = 'Release: Release checklist says every milestone\n#release';
    const written = 'Release: Release checklist says every milestone closes: the matching release question card\n#release';
    const { stats, buffer } = await captureIntoBrain(await genericSeed(n), {
      cards: [{ text: cut, area: 'Release', closes: 'the matching release question card', closesFallbackText: written, closesAnchored: true }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && stats.closeRefused?.[0]?.total === n && liveText(struct, /closes: the matching release question card/).length === 1
      && !liveText(struct, /^Release: Release checklist says every milestone( #|$)/).length && !JSON.stringify(struct.cards).includes('closed by'),
      `C1 a closes: matching ${n} cards (> 4) archives nothing and lands the WHOLE sentence, not the cut text`);
  }
  {
    // A prose closes: whose tail loosely covers a live card archived it. (A
    // closes: acts across areas, so the card sits in another area: this checks
    // the close, not the same-area supersede.)
    const buf = await buildKlypixMap({ title: 'brain', areas: [
      { title: 'Ship', cards: [{ text: 'Ship: 🏁 Card text falls back to the full note when no card matches, and the hook treats free text as prose — shipped in the capture lane' }] },
      { title: 'Brain', cards: [{ text: 'Brain: the merge driver keeps every card from both sides' }] },
    ] });
    const written = 'Brain: Hook now treats closes: as free text, so the card text falls back when no card matches\n#brain';
    const { stats, buffer } = await captureIntoBrain(buf, {
      cards: [{ text: 'Brain: Hook now treats\n#brain', area: 'Brain', closes: 'as free text, so the card text falls back when no card matches', closesFallbackText: written, closesAnchored: false }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && stats.closesKept?.length === 1 && stats.closesKept[0].strict === true
      && liveText(struct, /^Brain: Hook now treats closes: as free text/).length === 1 && liveText(struct, /shipped in the capture lane/).length === 1,
      'C1 an UNanchored prose closes: never archives a card it only loosely covers; the sentence lands whole');
  }
  {
    const buf = await genericSeed(6);
    const written = 'Release: A milestone closes: matching release question card when the feature ships\n#release';
    const { stats, buffer } = await captureIntoBrain(buf, {
      cards: [{ text: 'Release: A milestone\n#release', area: 'Release', closes: 'matching release question card when the feature ships', closesFallbackText: written, closesAnchored: false }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && liveText(struct, /^Release: A milestone closes: matching release question card/).length === 1 && live(struct).filter((c) => /❓/.test(c.text)).length === 6,
      'C1 an unanchored prose closes: with many loose hits lands the whole sentence and archives nothing');
  }
  {
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Brain', cards: [
      { text: 'Brain: ❓ Should the uploader retry on a 429 or back off entirely' },
      { text: 'Brain: ❓ Uploader should retry or back off entirely on 429s?' },
    ] }] });
    const { stats } = await captureIntoBrain(buf, {
      cards: [{ text: 'Brain: 🏁 uploader backs off\n#brain', area: 'Brain', closes: 'Should the uploader retry on a 429 or back off entirely',
        closesFallbackText: 'Brain: 🏁 uploader backs off closes: Should the uploader retry on a 429 or back off entirely\n#brain', closesAnchored: false }],
    });
    ok(stats.closed === 2, `C1 an unanchored closes: naming a ❓ by title still closes it AND its paraphrased twin (closed=${stats.closed})`);
  }
  {
    const buf = await closeSeed();
    const { stats } = await captureIntoBrain(buf, {
      cards: [{ text: 'Brain: 🏁 Backoff shipped.\n#brain', area: 'Brain', closes: 'uploader retry 429 back off',
        closesFallbackText: 'Brain: 🏁 Backoff shipped. closes: uploader retry 429 back off\n#brain', closesAnchored: true }],
    });
    ok(stats.closed === 1, 'C1 an ANCHORED "…shipped. closes: <paraphrase>" still closes by token coverage (unchanged)');
  }

  // ── E1 — end to end through the real Stop hook ────────────────────────────
  fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Pricing', cards: [{ text: 'Pricing: Pricing page layout uses three tiered plan cards with an annual toggle above them' }] },
      { title: 'Support', cards: [{ text: 'Support: Support page layout is one long list of help articles grouped by product area' }] },
      { title: 'Help', cards: [{ text: 'Help: Help center layout is one long list of articles grouped by product area' }] },
      { title: 'Brain', cards: [{ text: 'Brain: the merge driver keeps every card from both sides' }] },
      { title: 'Resolver', cards: [{ text: 'Resolver: Close-link resolver uses fuzzy token overlap' }] },
      { title: 'Matcher', cards: [{ text: 'Matcher: ❓ Should the matcher treat wikilinks as exact titles?' }] },
      { title: 'Canvas', cards: [{ text: 'Canvas: ❓ Canvas navigation — where do pan and zoom live' }] },
      { title: 'Gate', cards: [{ text: 'Gate: Release gate requires agents to check the tag' }] },
      { title: 'Store', cards: [{ text: 'Store: Pro plan price is $4 monthly, billed via Stripe checkout; annual plans get two months free and team seats' }] },
      { title: 'Nav', cards: [{ text: 'Nav: Pan hand tool lives in the bottom status bar next to the zoom steppers' }] },
    ],
  }));
  // An older hook keyed a closes-bearing note on its CUT body; that key must
  // still count as seen after the upgrade, or a live session re-captures it.
  const legacyKey = crypto.createHash('sha1').update(('|Legacy|Legacy note already captured').toLowerCase()).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(proj, '.claude', 'brain-capture-state.json'), JSON.stringify({ seen: [legacyKey] }));
  const markers = [
    '🧠 BRAIN [Support]: Support page gets a Q: and A: layout so pricing questions read as a FAQ',
    '🧠 BRAIN [Support] ?: Should the Q: prefix in support macros be localized for Arabic agents?',
    '🧠 BRAIN [Pricing] ~: Pricing page layout switches to Q: and A: FAQ blocks and the annual toggle is removed',
    '🧠 BRAIN [Help]: Help center layout now uses Q: and A: pairs grouped by plan instead of one long list',
    '🧠 BRAIN [Brain]: The resolver treats closes: links as exact title matches rather than fuzzy overlap',
    '🧠 BRAIN [Release] !: Release checklist now makes every agent verify: the tag, the npm version and the desktop bundle before announcing',
    '🧠 BRAIN [Eval]: Semantic blend stays on; see the ev: numbers in the eval report for the lift on paraphrase prompts',
    '🧠 BRAIN [Canvas]: Pan hand tool moves into the main toolbar q: where did the pan hand tool move in the toolbar?',
    '🧠 BRAIN [Support] ~: Support page layout now uses',
    // Review round 2.
    '🧠 BRAIN [Resolver] ~: The close-link resolver now treats closes: targets as exact titles only and never uses fuzzy token overlap',
    '🧠 BRAIN [Matcher] ✓: The matcher treats closes: [[wikilinks]] as exact titles now',
    '🧠 BRAIN [Canvas] !: Pan hand tool moved into the main toolbar closes: Canvas navigation ev: src/canvas/Toolbar.tsx q: pan tool location?',
    '🧠 BRAIN [Gate] ~: Release gate now requires agents verify: npm view klypix-mcp version matches the tag before announcing',
    '🧠 BRAIN [Dedup]: Dedup key treats closes: links as exact title matches rather than fuzzy overlap',
    '🧠 BRAIN [Dedup]: Dedup key treats closes: targets case-insensitively after the grammar change',
    '🧠 BRAIN [Store] ~: Pro plan price is $5 monthly, billed via Stripe',
    '🧠 BRAIN [Nav] ~: Pan hand tool now lives in the main toolbar beside the select tool q: where did the pan hand tool move to?',
    '🧠 BRAIN [Legacy]: Legacy note already captured closes: Some old target',
  ];
  const tp = path.join(home, 't-grammar.jsonl');
  fs.writeFileSync(tp, [
    { type: 'user', message: { role: 'user', content: 'restructure the support and pricing pages around the questions customers ask' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${markers.join('\n')}` }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runHook = (mode, input) => execFileSync(process.execPath, [HOOK, mode], {
    cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  try {
    runHook('--capture', { session_id: 'grammar-e2e', transcript_path: tp });
  } catch (e) { stderr = String(e.stderr || ''); ok(false, `E1 the hook exits 0 (${e.status})`); }
  const { struct: e2e } = await parseKlypix(fs.readFileSync(brain));
  const has = (re) => liveText(e2e, re).length > 0;
  const cardIn = (area, re) => e2e.cards.find((c) => c.type !== 'container' && re.test(flat(c.text)) && (!area || c.area === area || new RegExp(`^${area}:`).test(flat(c.text))));
  ok(has(/^Support: Support page gets a Q: and A: layout so pricing questions read as a FAQ/), 'E1 the audit sentence lands whole');
  ok(!has(/^Support: Support page gets a( #|$)/), 'E1 …and the 1.86.0 stub "Support page gets a" does not exist');
  ok(has(/^Support: ❓ Should the Q: prefix in support macros be localized for Arabic agents\?/), 'E1 the open question lands whole');
  ok(has(/^Pricing: Pricing page layout switches to Q: and A: FAQ blocks and the annual toggle is removed/)
    && !has(/^Pricing: Pricing page layout switches to( #|$)/), 'E1 the ~ replaces its card with the FULL correction, never the stub');
  ok(has(/^Help: Help center layout now uses Q: and A: pairs grouped by plan instead of one long list/), 'E1 the superseding decision is the full sentence');
  ok(has(/^Brain: The resolver treats closes: links as exact title matches rather than fuzzy overlap/), 'E1 a prose closes: lands whole');
  const release = cardIn(null, /Release checklist now makes every agent/);
  ok(Boolean(release) && /verify: the tag, the npm version and the desktop bundle before announcing/.test(flat(release.text)) && !release.verify,
    `E1 verify: used as a verb stays text — no probe field [verify=${JSON.stringify(release && release.verify)}]`);
  const evalCard = cardIn(null, /Semantic blend stays on/);
  ok(Boolean(evalCard) && /see the ev: numbers in the eval report/.test(flat(evalCard.text)) && !(evalCard.evidence || []).length,
    'E1 "see the ev: numbers" stays text — no junk evidence ref');
  ok(has(/^Canvas: Pan hand tool moves into the main toolbar( #|$)/), 'E1 a documented trailing q: is still stripped from the card');
  const support = cardIn(null, /one long list of help articles/);
  ok(Boolean(support) && !/^archive$/i.test(support.area || '') && flat(support.text).includes('(~ amended') && flat(support.text).includes('Support page layout now uses)'),
    'E1 the thin ~ was appended to the Support card, which stays live and keeps its text');
  // Review round 2, end to end.
  const resolver = cardIn(null, /^Resolver:/);
  ok(Boolean(resolver) && flat(resolver.text).includes('treats closes: targets as exact titles only and never uses fuzzy token overlap') && !has(/now treats( #|$)/),
    'E1 a ~ whose prose says "closes:" replaces its card with the WHOLE sentence, never "…now treats"');
  const matcherQ = cardIn(null, /Should the matcher treat wikilinks/);
  ok(Boolean(matcherQ) && /^archive$/i.test(matcherQ.area || '') && !has(/🏁 The matcher treats( #|$)/),
    'E1 a ✓ whose prose says "closes: [[…]]" resolves the question with the whole sentence — no cut fallback milestone');
  const navQ = cardIn(null, /Canvas navigation — where do pan and zoom live/);
  const panMilestone = cardIn(null, /🏁 Pan hand tool moved into the main toolbar/);
  ok(Boolean(navQ) && /^archive$/i.test(navQ.area || '') && Boolean(panMilestone) && (panMilestone.evidence || []).some((e) => e.ref === 'src/canvas/Toolbar.tsx')
    && flat(panMilestone.text).includes('q: pan tool location?'),
    'E1 a malformed q: no longer cancels its line: closes: archived the ❓, ev: anchored, and the q: text stayed on the card');
  const gate = cardIn(null, /^Gate:/);
  ok(Boolean(gate) && flat(gate.text).includes('verify: npm view klypix-mcp version matches the tag before announcing') && !gate.verify,
    'E1 a ~ with a prose "verify:" replaces its card whole — no cut text, no probe field');
  ok(has(/^Dedup: Dedup key treats closes: links as exact title matches/) && has(/^Dedup: Dedup key treats closes: targets case-insensitively/),
    'E1 two notes that share the words before their closes: are two notes (dedup keys the note as written)');
  ok(!has(/Legacy note already captured/), 'E1 a note an older hook already captured (key on the cut body) is not re-captured after the upgrade');
  const store = live(e2e).filter((c) => /Pro plan price/.test(flat(c.text)));
  ok(store.length === 1 && flat(store[0].text).includes('$4 monthly') && /\(~ amended [^)]*\$5 monthly/.test(flat(store[0].text)),
    'E1 the price correction is appended to its one card end to end');
  const ledgerFile = path.join(proj, '.claude', 'brain-capture-log.jsonl');
  const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
  ok(/"update-amended-thin"/.test(ledger), 'E1 the ledger records the thin ~ as update-amended-thin, not "update"');
  ok(/"suffix-kept-as-text"/.test(ledger) && /q: pan tool location\?/.test(ledger), 'E1 the ledger records the suffix that stayed text');
  const { readEnrichment } = await import(new URL('enrichment.mjs', SRC).href);
  const sidecar = readEnrichment(brain, { home });
  ok(sidecar.some((entry) => entry.q.some((q) => /where did the pan hand tool move in the toolbar/.test(q))), 'E1 the q: question reached the enrichment sidecar');
  ok(sidecar.some((entry) => entry.q.some((q) => /where did the pan hand tool move to\?/.test(q))), 'E1 the q: on a successful ~ is recorded too');
  ok(!sidecar.some((entry) => entry.q.some((q) => /A: layout so pricing|section answering|pan tool location/.test(q))), 'E1 no prose fragment was recorded as a "question"');
  // The receipts reach the MODEL: the next prompt of the same session prints
  // them once (Stop-hook stderr with exit 0 never does).
  const prompts = [];
  for (let i = 0; i < 4; i++) prompts.push(runHook('--prompt', { session_id: 'grammar-e2e', prompt: 'ok, continue with the pages' }));
  const allOut = prompts.join('\n');
  ok(/Brain capture — what your last 🧠 BRAIN markers actually did/.test(prompts[0]), 'E1 the next prompt shows what the last markers actually did');
  ok((allOut.match(/appended, not replaced: "Pro plan price is \$5 monthly/g) || []).length === 1, 'E1 the price amendment receipt reaches the model exactly once');
  ok((allOut.match(/suffix kept as card text: "q: pan tool location\?"/g) || []).length === 1, 'E1 the kept-suffix receipt reaches the model exactly once');
  ok(!/Brain capture —/.test(prompts[3]), 'E1 once shown, the receipts do not repeat');
  if (stderr) console.log(stderr);
} catch (e) {
  console.error('✗ suite crashed:', e && e.stack || e);
  failures++;
} finally {
  for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}

if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
console.log('\n✓ marker-suffix-grammar — all assertions passed');
