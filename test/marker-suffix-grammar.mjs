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
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SRC = new URL('../src/', import.meta.url);
const REPO = fileURLToPath(new URL('../', import.meta.url));
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
const extraDirs = [];
// Junctions are unlinked BEFORE the dirs holding them are removed: a recursive
// remove must never be pointed at the repo's real node_modules.
const junctions = [];

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
    && splitMarkerSuffixes('Shipped the retry. closes: Upload retry question ev: src/retry.mjs').closesAnchored === true
    && splitMarkerSuffixes('Shipped the retry ev: src/retry.mjs closes: Upload retry question').closesAnchored === true
    && splitMarkerSuffixes('The resolver treats closes: [[wikilinks]] as exact titles now').closesAnchored === false,
    'G2 closesAnchored: after a clause boundary, after another well-formed suffix, or a lone [[wikilink]] — not a wikilink inside prose');
  // Review 2026-09-18 (F2): a well-formed ev: AFTER a prose closes: proves
  // nothing about the closes: — the documented marker shape "… ev: <file>" is
  // exactly when agents follow instructions, and it archived unrelated cards.
  const proseCloseEv = splitMarkerSuffixes('The resolver now treats closes: targets as exact titles ev: src/klypix-format.mjs');
  ok(proseCloseEv.closesAnchored === false && proseCloseEv.evidence?.[0]?.ref === 'src/klypix-format.mjs'
    && proseCloseEv.bodyWithCloses === 'The resolver now treats closes: targets as exact titles'
    && splitMarkerSuffixes('Shipped the retry closes: Upload retry question ev: src/retry.mjs').closesAnchored === false,
    'G2 a prose closes: followed by a well-formed ev: is NOT anchored (only what comes before a closes: anchors it)');
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
  // Review 2026-09-18 (R7): an AUTHORED line break (brain_note text, the app)
  // that falls where wrapText would also have broken must not glue the next
  // sentence onto the command; a wrapped long command still reads whole, and a
  // wrapped prose "verify:" sentence still derives nothing.
  ok(parseVerifySuffix('Gate probe verify: gh run list -L 5\nOwner release lane weekly') === 'gh run list -L 5'
    && parseVerifySuffix('Health probe verify: curl -sf /api/up\nNightly window returns 503 by design') === 'curl -sf /api/up',
    'G3 a typed break before a new sentence ends the probe (never "gh run list -L 5 Owner release lane weekly")');
  {
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Rel', cards: [{ text: 'Rel: unrelated seed card about the lint rules' }] }] });
    const { buffer } = await captureIntoBrain(buf, { cards: [
      { text: 'Rel: 🏁 build 26 uploaded and the notes were posted verify: gh run list --workflow publish.yml --limit 5\n#rel', area: 'Rel' },
      { text: 'Rel: Release gate now requires agents verify: npm view klypix-mcp version matches the tag before announcing\n#rel', area: 'Rel' },
    ] });
    const { struct } = await parseKlypix(buffer);
    const longCmd = struct.cards.find((c) => /build 26 uploaded/.test(flat(c.text)));
    const proseCmd = struct.cards.find((c) => /Release gate now requires/.test(flat(c.text)));
    ok(/\n/.test(longCmd.text) && longCmd.verify === 'gh run list --workflow publish.yml --limit 5', `G3 a hard-wrapped long command still reads whole [${longCmd.verify}]`);
    ok(/\n/.test(proseCmd.text) && !proseCmd.verify, 'G3 a hard-wrapped prose "verify:" sentence still derives nothing');
  }
  {
    // The explicit clear holds (R7): the reader used to derive the probe back
    // from the prose of a card whose verify a ~ had just cleared.
    const text = 'Smoke probe verify: npm run smoke:ci\nDeploys happen after the gate passes';
    const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Smoke', cards: [{ text: `Smoke: ${text}` }] }] });
    const { struct: s0 } = await parseKlypix(buf);
    const before = s0.cards.find((c) => /Smoke probe verify/.test(flat(c.text)));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Smoke', text, verify: '' }] });
    const { struct, zip } = await parseKlypix(buffer);
    const card = struct.cards.find((c) => c.id === before.id);
    const raw = JSON.parse(await zip.file(Object.keys(zip.files).find((n) => n.endsWith(`/${card.id}.json`))).async('string'));
    ok(before.verify === 'npm run smoke:ci' && stats.updated === 1 && raw.verify === '' && card.verify === null,
      `G3 an explicit verify clear is PERSISTED as "" and the reader derives nothing from the prose after it [${JSON.stringify(card.verify)}]`);
  }
  ok(parseVerifySuffix('A card with no probe key at all, wrapped\nacross two lines') === null && parseVerifySuffix('') === null,
    'G3 a card that never says "verify:" is answered on the fast path (null)');

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
    // Review 2026-09-18 (F1/R1): an amendment that mixes ordinary words with a
    // token longer than a card line (a path, a URL, a 40-char SHA) is stored
    // with BOTH kinds of wrap break — reading every break as a space, or every
    // break as nothing, never rebuilt it, so the same thin ~ re-appended itself
    // at every Stop and re-dated the card.
    const cases = [
      ['Dev', 'Dev: The dev server port is configured in vite.config.ts and electron waits on it before launching the overlay; strictPort stays true so a busy port fails loudly', 'Dev port now set in electron/config/devServerPortSettings.ts', 'now set in electron/config/devServerPortSettings'],
      ['Store', 'Store: Stripe checkout plan is configured in the billing settings page with monthly and annual prices and a coupon field', 'Stripe checkout plan moved to https://p.io/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p', null],
      ['Release', 'Release: Release installer builds are produced by the publish workflow on every tag and uploaded to the GitHub release with checksums', 'Release installer builds pinned at 3f9a1c2e4b5d6f708192a3b4c5d6e7f8091a2b3c', null],
    ];
    for (const [area, cardText, thin, headOfToken] of cases) {
      let buf = await buildKlypixMap({ title: 'brain', areas: [{ title: area, cards: [{ text: cardText }] }] });
      const { struct: s0 } = await parseKlypix(buf);
      const { id, createdAt: born } = live(s0)[0];
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const r = await captureIntoBrain(buf, { updates: [{ area, text: thin, createdVia: 'claude-code' }] });
        buf = r.buffer; runs.push(r.stats);
      }
      const { struct } = await parseKlypix(buf);
      const card = struct.cards.find((c) => c.id === id);
      const lines = card.text.split('\n');
      const mixed = lines.some((l) => l.length === 37 && !/\s/.test(l)) && lines.some((l) => /^\(~ amended/.test(l) && !l.includes(')'));
      ok(mixed && amendments(card.text) === 1 && runs[0].updateAmended?.length === 1
        && runs.slice(1).every((s) => !s.updateAmended && s.updateUnchanged?.length === 1 && s.updated === 0),
        `U1 a thin ~ carrying a long token (${area}) is appended ONCE over 3 captures, then "already says" (${amendments(card.text)} line(s))`);
      ok(card.createdAt === born, `U1 …and the amendment never re-dates the claim it sits under (${area})`);
      if (headOfToken) ok(!fmt.cardAlreadySays(card.text, headOfToken), `U1 …while the HEAD of a wrapped long token is not "said" (${area})`);
    }
  }
  {
    // Review 2026-09-18 (F5): an amendment leaves the claim's own metadata
    // alone and keeps its own evidence at the 16-ref cap.
    const seedBuf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Deploy', cards: [{ text: 'Deploy: lint runs before tests in the pipeline' }] }] });
    const ev16 = Array.from({ length: 16 }, (_, i) => ({ kind: 'file', ref: `docs/deploy-${i}.md` }));
    const seeded = await captureIntoBrain(seedBuf, { cards: [{ text: 'Deploy: 🏁 Production deploy runs from the release branch through the publish workflow with manual approval and a canary stage\n#deploy', area: 'Deploy', borderColor: 'rgba(59,130,246,0.8)', createdVia: 'cli', evidence: ev16, verify: 'gh workflow view publish' }] });
    const { struct: s0, zip: z0 } = await parseKlypix(seeded.buffer);
    const ms = s0.cards.find((c) => /Production deploy runs/.test(flat(c.text)));
    const rawOf = async (zip, id) => JSON.parse(await zip.file(Object.keys(zip.files).find((n) => n.endsWith(`/${id}.json`))).async('string'));
    const j0 = await rawOf(z0, ms.id);
    const { stats, buffer } = await captureIntoBrain(seeded.buffer, { updates: [{ area: 'Deploy', text: 'Production deploy now runs from main', createdVia: 'claude-code', evidence: [{ kind: 'file', ref: 'deploy/main-pipeline.yml' }], verify: 'gh run list' }] });
    const { zip } = await parseKlypix(buffer);
    const j1 = await rawOf(zip, ms.id);
    ok(stats.updateAmended?.length === 1 && j1.content.includes('(~ amended'), 'U1 (setup) the thin ~ was appended to the 🏁 card');
    ok(j1.verify === 'gh workflow view publish' && j1.createdAt === j0.createdAt && j1.borderColor === j0.borderColor && j1.createdVia === 'cli',
      'U1 an amendment keeps the claim\'s verify, createdAt, border colour and createdVia');
    ok(j1.evidence.length === 16 && j1.evidence[0].ref === 'deploy/main-pipeline.yml' && stats.updateAmended[0].evidenceDropped === 1
      && formatCaptureReceipts(stats).some((l) => /oldest were dropped/.test(l)),
      'U1 …its own evidence survives the 16-ref cap (the amendment\'s refs first) and the drop is reported');
  }
  {
    // Review 2026-09-18 (R6a): a thin ~ and then a full ~ for the same card in
    // ONE batch leave no amendment behind — and must not report one.
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const support = s0.cards.find((c) => /one long list/.test(c.text));
    const r = await captureIntoBrain(buf, { updates: [
      { area: 'Support', text: 'Support page layout now uses' },
      { area: 'Support', text: 'Support page layout now uses Q: and A: pairs grouped by plan instead of one long list' },
    ] });
    const { struct } = await parseKlypix(r.buffer);
    ok(!r.stats.updateAmended && amendments(struct.cards.find((c) => c.id === support.id).text) === 0 && !formatCaptureReceipts(r.stats).some((l) => /appended, not replaced/.test(l)),
      'U1 an amendment a later full ~ in the same batch replaced is not reported as "appended"');
  }
  {
    // Review 2026-09-18 (F6): previews lead with the newest amendment — the
    // stale claim still heads the stored card, and ~120 characters of head
    // never reached the correction.
    const stored = 'Dev: The dev server port is configured in\nvite.config.ts and electron waits on it\n#dev\n(~ amended 2026-09-17: port was 5174)\n(~ amended 2026-09-18: Dev port now set in\nelectron/config/devServerPortSettings\n.ts)';
    const lead = fmt.amendmentFirst(stored);
    ok(lead.startsWith('(~ amended 2026-09-18: Dev port now set in electron/config/devServerPortSettings.ts)\nDev: The dev server port')
      && lead.includes('(~ amended 2026-09-17: port was 5174)') && fmt.amendmentFirst('Dev: no amendment here') === 'Dev: no amendment here',
      'U1 amendmentFirst puts the newest amendment (rejoined across its wrap) ahead of the claim, and leaves other cards alone');
    const q = { text: 'Support: ❓ Should support macros be localized for Arabic agents, and who owns the translations for the help center articles?\n(~ amended 2026-09-18: owner is the support lead)', area: 'Support' };
    const ultra = fmt.structToUltraBrief({ title: 'brain', counts: { cards: 1, connections: 0 }, cards: [{ id: 'q1', type: 'text', area: 'Support', createdAt: Date.now(), ...q }], connections: [] });
    ok(/owner is the support lead/.test(ultra), 'U1 the ultra brief shows the amendment of a long open question');
  }
  {
    // ── Third review, 2026-09-18 (F4/F5) — cardAlreadySays must answer, not
    // throw, and must not lose a letter to case folding.
    //
    // F4: the pattern the first fix compiled made V8 throw
    // "SyntaxError: Invalid regular expression … Stack overflow" from exec at
    // about 5,000 characters of body — OUTSIDE its try, so one long thin ~
    // threw captureIntoBrain, lost its whole Stop batch and, once queued,
    // failed at every later Stop of every session in the project.
    const tail = ' 12 34 56 78 90'.repeat(500);          // ~7.5k characters
    const longBody = `Release gate verification smoke signing:${tail}`;
    let threw = null, exact = null, miss = null;
    try {
      exact = fmt.cardAlreadySays(`Gate: Release gate verification smoke signing:${tail}`, longBody);
      miss = fmt.cardAlreadySays('Gate: Release gate verification smoke signing: 12 34 and then something else', longBody);
    } catch (e) { threw = e; }
    ok(!threw && exact === true && miss === false,
      `U1 a ~7.5k-character body is answered, not thrown at (${threw ? threw.message.slice(0, 60) : `${exact}/${miss}`})`);
    // F5: "İ".toLowerCase() is "i" + U+0307, which simple case folding under
    // /iu never maps back — so a Turkish thin ~ did not match itself and
    // re-appended at every Stop.
    ok(fmt.cardAlreadySays('Office: the office moved to İstanbul last spring', 'İstanbul')
      && fmt.cardAlreadySays('Office: the office moved to İstanbul last spring', 'moved to İstanbul')
      && fmt.cardAlreadySays('Sirket: ŞİRKETİ kuruldu geçen yıl', 'ŞİRKETİ')
      && fmt.cardAlreadySays('Dev: Dev server listens on PORT 5173', 'port 5173')
      && !fmt.cardAlreadySays('Office: the office moved to Istanbul last spring', 'İstanbul'),
      'U1 …and a letter whose lowercase EXPANDS (Turkish İ) matches itself, while plain I still does not');
  }
  {
    // ── Third review, 2026-09-18 (R6) — what a preview may NOT reorder.
    const sup = '↩︎ superseded 2026-09-10 by [[Dev server port]]\nDev: the dev server listens on port 5173\n#dev\n(~ amended 2026-09-05: port is 5174)';
    const supLines = fmt.amendmentFirst(sup).split('\n');
    ok(supLines[0] === '↩︎ superseded 2026-09-10 by [[Dev server port]]' && supLines[1] === '(~ amended 2026-09-05: port is 5174)',
      'U1 amendmentFirst keeps a ↩︎ superseded stamp first (the repeat nudge previews archived cards) and puts the amendment right after it');
    const cons = '⤵ consolidated 2026-09-10 into [[Dev server port]]\nDev: the dev server listens on port 5173\n(~ amended 2026-09-05: port is 5174)';
    ok(fmt.amendmentFirst(cons).split('\n')[0] === '⤵ consolidated 2026-09-10 into [[Dev server port]]', 'U1 …the same for a ⤵ consolidated stamp');
    const reaff = 'Dev: the dev server listens on port 5173\n(~ amended 2026-09-05: port is 5174)\n(re-affirmed 2026-09-12: still true, verified on the release build)';
    ok(fmt.amendmentFirst(reaff) === reaff, 'U1 …a NEWER (re-affirmed …) line means the amendment is not the newest word, so the card is previewed as stored');
    const human = 'Dev: the dev server listens on port 5173\n(~ amended 2026-09-05: port is 5174)\nHuman note: actually we reverted this last week';
    const led = fmt.amendmentFirst(human);
    ok(led.startsWith('(~ amended 2026-09-05: port is 5174)\nDev: the dev server') && /\nHuman note: actually we reverted this last week$/.test(led),
      'U1 …and a human line under a one-line amendment is not absorbed into it');
    // The ✅ a resolve writes is prefixed INLINE onto the claim line, so unlike
    // a ↩︎ / ⤵ stamp it cannot be kept on top — the card is previewed as
    // stored instead, because "resolved" is its newest word.
    const resolved = '✅ Dev: the dev server listens on port 5173\nand electron waits on it before launching\n#dev\n(~ amended 2026-09-05: port is 5174)';
    ok(fmt.amendmentFirst(resolved) === resolved,
      'U1 …and a card whose claim line already carries a ✅ is previewed as stored, not led by its amendment');
  }
  {
    // STUB REPAIR (engine): the stub a 1.86.0 cut left is rewritten in place;
    // an ev: / verify: 1.86.0 read out of the very prose it cut is dropped, and
    // metadata this text does not name is kept.
    const base = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Rel', cards: [{ text: 'Rel: unrelated seed card about the lint rules' }] }] });
    const seeded = await captureIntoBrain(base, { cards: [{ text: 'Rel: 🛠️ Every agent must\n#rel', area: 'Rel', verify: 'the npm tag and the desktop bundle before announcing', evidence: [{ kind: 'file', ref: 'docs/release.md' }] }] });
    const { struct: s0 } = await parseKlypix(seeded.buffer);
    const stub = s0.cards.find((c) => /Every agent must/.test(flat(c.text)));
    const full = 'Rel: 🛠️ Every agent must verify: the npm tag and the desktop bundle before announcing\n#rel';
    const { stats, buffer } = await captureIntoBrain(seeded.buffer, { cards: [{ text: full, area: 'Rel', repairStub: 'Every agent must' }] });
    const { struct } = await parseKlypix(buffer);
    const card = struct.cards.find((c) => c.id === stub.id);
    ok(stats.repaired === 1 && stats.stubRepairs?.[0]?.id === stub.id && flat(card.text).startsWith(flat(full).replace(/ #rel$/, ''))
      && live(struct).length === live(s0).length && !card.verify && (card.evidence || []).some((e) => e.ref === 'docs/release.md'),
      'U1 a stub is repaired in place: full text, no junk verify read from its own prose, unrelated evidence kept, no second card');
    const again = await captureIntoBrain(buffer, { cards: [{ text: full, area: 'Rel', repairStub: 'Every agent must' }] });
    ok(!again.stats.repaired && again.stats.stubRepairMissing?.length === 1 && again.stats.added === 0,
      'U1 with no live stub left, a repair lands nothing (reported as stubRepairMissing)');
  }
  {
    // Third review, 2026-09-18 (F3) — a repair rewrites the stub's TEXT, and
    // nothing else: the tag lines the stub match deliberately ignores (a
    // user's own tags, the #file-/#dir- anchors it was captured with) are the
    // one thing an edit-detector cannot see, and rebuilding the tag line from
    // the current transcript scan — usually empty after an upgrade — destroyed
    // every one of them.
    const base = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Tags', cards: [{ text: 'Tags: unrelated seed card about the lint rules' }] }] });
    const seeded = await captureIntoBrain(base, { cards: [{ text: 'Tags: Support page gets a\n#tags #file-supportpagetsx #dir-srcpages', area: 'Tags' }] });
    const { struct: s0, zip: z0 } = await parseKlypix(seeded.buffer);
    const stub = s0.cards.find((c) => /Support page gets a/.test(flat(c.text)));
    const stubId = stub.id;
    // The human tagged it in the app afterwards.
    const rawName = Object.keys(z0.files).find((n) => n.endsWith(`/${stubId}.json`));
    const withUserTags = JSON.parse(await z0.file(rawName).async('string'));
    withUserTags.content = 'Tags: Support page gets a\n#tags #file-supportpagetsx #dir-srcpages #founder-pick #keep';
    z0.file(rawName, JSON.stringify(withUserTags));
    const tagged = await z0.generateAsync({ type: 'nodebuffer' });
    const { stats, buffer } = await captureIntoBrain(tagged, { cards: [{ text: 'Tags: Support page gets a Q: and A: layout so billing questions read as a FAQ\n#tags', area: 'Tags', repairStub: 'Support page gets a' }] });
    const { struct } = await parseKlypix(buffer);
    const repaired = struct.cards.find((c) => c.id === stubId);
    ok(stats.repaired === 1 && /Q: and A: layout so billing questions read as a FAQ/.test(flat(repaired.text)),
      'U1 (setup) the stub is repaired to the full marker text');
    const tagsOn = (t) => flat(t).split(/\s+/).filter((w) => w.startsWith('#'));
    ok(['#founder-pick', '#keep', '#file-supportpagetsx', '#dir-srcpages', '#tags'].every((t) => tagsOn(repaired.text).includes(t)),
      `U1 …and a repair keeps the stub's own tag lines — user tags and #file-/#dir- anchors (${tagsOn(repaired.text).join(' ')})`);
    ok(tagsOn(repaired.text).filter((t) => t === '#tags').length === 1, 'U1 …merged with the marker\'s tag line, not duplicated');
  }
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
    const close = (anchored) => captureIntoBrain(buf, {
      cards: [{ text: 'Brain: 🏁 uploader backs off\n#brain', area: 'Brain', closes: 'Should the uploader retry on a 429 or back off entirely',
        closesFallbackText: 'Brain: 🏁 uploader backs off closes: Should the uploader retry on a 429 or back off entirely\n#brain', closesAnchored: anchored }],
    });
    const unanchored = await close(false);
    ok(unanchored.stats.closed === 1 && unanchored.stats.closedCards?.[0]?.title?.startsWith('Brain: ❓ Should the uploader'),
      `C1 an UNanchored closes: closes only the ❓ it NAMES by title — its paraphrased twin stays open, visibly (closed=${unanchored.stats.closed})`);
    const anchored = await close(true);
    ok(anchored.stats.closed === 2, `C1 an ANCHORED closes: naming a ❓ by title still closes it AND its paraphrased twin (closed=${anchored.stats.closed})`);
  }
  {
    // Review 2026-09-18 (F4): a strict close that names ONE card by title
    // archived every other card that merely carried all the target's words.
    // Stored as capture stores them: hard-wrapped, so a card's title is its
    // first line (wrapText output, written out).
    const buf = await buildKlypixMap({ title: 'brain', areas: [
      { title: 'Brain', cards: [
        { text: 'Brain: Merge driver container dedup' },
        { text: 'Brain: ❓ Does the merge driver\ncontainer dedup lose edges when two\ncontainers collapse into one?' },
      ] },
      { title: 'Canvas', cards: [{ text: 'Canvas: container dedup inside the\nmerge driver path is slow on big\nbrains, 4 s on 3k cards' }] },
    ] });
    const { stats, buffer } = await captureIntoBrain(buf, {
      cards: [{ text: 'Brain: The gardener pass\n#brain', area: 'Brain', closes: 'merge driver container dedup',
        closesFallbackText: 'Brain: The gardener pass closes: merge driver container dedup\n#brain', closesAnchored: false }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 1 && liveText(struct, /Does the merge driver container dedup/).length === 1 && liveText(struct, /inside the merge driver path/).length === 1,
      `C1 a strict close archives only the card it names by title, not the ones that merely carry its words (closed=${stats.closed})`);
  }
  {
    // Review 2026-09-18 (F2), through the hook's own parse: the documented
    // marker shape "… closes: … ev: <file>" with a PROSE closes: archived four
    // unrelated live cards by word coverage.
    const buf = await buildKlypixMap({ title: 'brain', areas: [
      { title: 'Ship', cards: [{ text: 'Ship: 🏁 Exact titles for release targets shipped in the resolver lane' }] },
      { title: 'Brain', cards: [{ text: 'Brain: the merge driver keeps every card from both sides' }] },
    ] });
    const p = splitMarkerSuffixes('The resolver now treats closes: targets as exact titles ev: src/klypix-format.mjs');
    const { stats, buffer } = await captureIntoBrain(buf, {
      cards: [{ text: `Brain: ${p.body}\n#brain`, area: 'Brain', closes: p.closes, closesFallbackText: `Brain: ${p.bodyWithCloses}\n#brain`, closesAnchored: p.closesAnchored, evidence: p.evidence }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && liveText(struct, /Exact titles for release targets/).length === 1
      && liveText(struct, /^Brain: The resolver now treats closes: targets as exact titles/).length === 1,
      'C1 a prose closes: followed by an ev: archives no card it only covers by words, and the whole sentence lands');
    const control = await captureIntoBrain(buf, {
      cards: [{ text: 'Brain: The resolver ships.\n#brain', area: 'Brain', closes: p.closes, closesFallbackText: 'Brain: The resolver ships. closes: targets as exact titles\n#brain', closesAnchored: true }],
    });
    ok(control.stats.closed === 1, 'C1 (control) the same target after a clause boundary still closes by coverage — the setup exercises the coverage path');
  }
  {
    // Review 2026-09-18 (F8): an ANCHORED close whose named card is already
    // closed must not fall through to word coverage on unrelated live cards
    // (corpus replay: "closes: PR #153 needs founder Merge click." archived
    // "🏁 Overlap story CLOSED 100%").
    const buf = await buildKlypixMap({ title: 'brain', areas: [
      { title: 'Canvas', cards: [{ text: 'Canvas: 🏁 Overlap story CLOSED 100% — one-click merge-brains after the founder ruling; needs one dev restart' }] },
      { title: 'Archive', cards: [{ text: 'Release: PR #153 needs founder Merge click.\n✅ 2026-09-01: closed by → merged' }] },
    ] });
    const { stats, buffer } = await captureIntoBrain(buf, {
      cards: [{ text: 'Release: 🏁 Merged it.\n#release', area: 'Release', closes: 'PR #153 needs founder Merge click.',
        closesFallbackText: 'Release: 🏁 Merged it. closes: PR #153 needs founder Merge click.\n#release', closesAnchored: true }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && liveText(struct, /Overlap story CLOSED/).length === 1 && stats.closesKept?.[0]?.alreadyClosed
      && formatCaptureReceipts(stats).some((l) => /already closed/.test(l)),
      'C1 a close that names an already-closed card archives nothing else by word coverage, and says so');
    const noArchive = await buildKlypixMap({ title: 'brain', areas: [
      { title: 'Canvas', cards: [{ text: 'Canvas: 🏁 Overlap story CLOSED 100% — one-click merge-brains after the founder ruling; needs one dev restart' }] },
    ] });
    const control = await captureIntoBrain(noArchive, {
      cards: [{ text: 'Release: 🏁 Merged it.\n#release', area: 'Release', closes: 'PR #153 needs founder Merge click.',
        closesFallbackText: 'Release: 🏁 Merged it. closes: PR #153 needs founder Merge click.\n#release', closesAnchored: true }],
    });
    ok(control.stats.closed === 1, 'C1 (control) with no closed card named, the same anchored target closes by coverage — the setup exercises that path');
  }
  {
    // Review 2026-09-18: 4 cards closed, 3 named — the receipt never hides a remainder.
    const lines = formatCaptureReceipts({ closedCards: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, title: `card ${n}`, target: 't' })) }, { maxEach: 3 });
    ok(lines.filter((l) => /archived \(id c\d\)/.test(l)).length === 3 && lines.some((l) => /and 1 more card archived by closes: \(id c4\)/.test(l)),
      'C1 every archived card is named in the receipts, the fourth one on an overflow line');
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
  ];
  // The legacy note was emitted BEFORE the upgrade (its event is older than
  // the state file an older hook wrote); everything else is new.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const tp = path.join(home, 't-grammar.jsonl');
  fs.writeFileSync(tp, [
    { type: 'assistant', timestamp: hourAgo, message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier.\n\n🧠 BRAIN [Legacy]: Legacy note already captured closes: Some old target' }] } },
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

  // ── E2 — re-harvest, upgrade and stub repair through the real Stop hook ───
  // Review 2026-09-18: Stop re-reads the WHOLE transcript, so (R6/F7) one ~ / ✓
  // line must apply once, (F1) a thin ~ naming a long token must never stack,
  // (F2) a prose closes: followed by an ev: must not archive by word coverage,
  // and (R2/F3) a marker the published 1.86.0 hook already landed — keyed on
  // the text it CUT — must not land again after the upgrade: its stub is
  // repaired in place instead.
  {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-home2-'));
    const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-proj2-'));
    extraDirs.push(home2, proj2);
    fs.mkdirSync(path.join(home2, '.claude', 'project-brain'), { recursive: true });
    fs.writeFileSync(path.join(home2, '.claude', 'project-brain', '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
    fs.mkdirSync(path.join(proj2, '.claude'), { recursive: true });
    const brain2 = path.join(proj2, 'brain.klypix');
    fs.writeFileSync(brain2, await buildKlypixMap({
      title: 'brain',
      areas: [
        { title: 'Dev', cards: [{ text: 'Dev: The dev server port is configured in vite.config.ts and electron waits on it before launching the overlay; strictPort stays true so a busy port fails loudly instead of drifting silently' }] },
        { title: 'Ship', cards: [{ text: 'Ship: 🏁 Exact titles for release targets shipped in the resolver lane' }] },
        { title: 'Deploy', cards: [
          { text: 'Deploy: Production deploy runs from the release branch through the GitHub publish workflow job, gated by the canary ring and the rollout table' },
          { text: 'Deploy: Staging deploy runs from main on every push through the preview workflow, no canary gate and no rollout row' },
        ] },
        // What 1.86.0 already landed for three of the markers below.
        { title: 'Faq', cards: [{ text: 'Faq: Faq page gets a\n#faq' }] },
        { title: 'Uploader', cards: [{ text: 'Uploader: 🏁 Uploader retry shipped\n#uploader' }] },
        { title: 'Docs', cards: [{ text: 'Docs: Docs index uses a\n#docs' }] },
        { title: 'Share', cards: [{ text: 'Share: Share page gets a\n#share' }] },
        { title: 'Pair', cards: [{ text: 'Pair: Pair key treats\n#pair' }] },
        // …and one 1.86.0 landed COMPLETE: it cut at the " closes:" and acted
        // on the close, so this card was never a stub (third review, F2).
        { title: 'Pairing', cards: [{ text: 'Pairing: Pairing-staleness detection now runs on the desktop lane\n#pairing' }] },
      ],
    }));
    const key186 = (type, area, cut) => crypto.createHash('sha1').update(`${type}|${area}|${cut}`.toLowerCase()).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(proj2, '.claude', 'brain-capture-state.json'), JSON.stringify({ seen: [
      key186('', 'Faq', 'Faq page gets a'),
      key186('!', 'Uploader', 'Uploader retry shipped'),
      key186('', 'Docs', 'Docs index uses a'),
      key186('', 'Gone', 'Gone page gets a'),                 // its stub card is not live any more
      key186('', 'Share', 'Share page gets a'),
      key186('', 'Pair', 'Pair key treats'),
      key186('', 'Pairing', 'Pairing-staleness detection now runs on the desktop lane'),
    ] }));
    const thinDev = '🧠 BRAIN [Dev] ~: Dev port now set in electron/config/devServerPortSettings.ts';
    // What 1.86.0 already processed (its Stop ran before the upgrade, so these
    // events are older than the state file it wrote) …
    const turn0 = [
      '🧠 BRAIN [Faq]: Faq page gets a Q: and A: layout so billing questions read as a FAQ',
      '🧠 BRAIN [Uploader] !: Uploader retry shipped q: backoff and jitter numbers',
      '🧠 BRAIN [Docs]: Docs index uses a q: prefix for search terms ev: docs/search.md',
      '🧠 BRAIN [Gone]: Gone page gets a Q: and A: section for refunds',
      // Two different notes with the same words before the prose "Q:": 1.86.0
      // landed the first as the stub and skipped the second as already seen.
      '🧠 BRAIN [Share]: Share page gets a Q: and A: block for team invites',
      '🧠 BRAIN [Share]: Share page gets a Q: prefix on every invite question',
      // The same through the closes: key the grammar still cuts at.
      '🧠 BRAIN [Pair]: Pair key treats closes: links as exact title matches rather than fuzzy overlap',
      '🧠 BRAIN [Pair]: Pair key treats closes: targets case-insensitively after the grammar change',
      // Third review (F2): 1.86.0 cut at " closes:" whether or not a space
      // followed, and ACTED on the close — its card is complete. This grammar
      // reads "closes:txt_…" as prose, so the marker looks "longer" than the
      // cut and used to be "repaired", appending that junk to the card.
      '🧠 BRAIN [Pairing]: Pairing-staleness detection now runs on the desktop lane closes:txt_b08gx7zl',
      // Third review (F1/R4): two notes of ONE capture where the second's old
      // CUT is byte-identical to the first's own key. The second is a note
      // that never landed, not a repair of the first.
      '🧠 BRAIN [Rollout]: Rollout ring expanded to twenty percent ev: docs/rollout.md',
      '🧠 BRAIN [Rollout]: Rollout ring expanded to twenty percent Q: and A: blocks now render in the rollout console',
      // Third review (F6): 1.86.0 applied this ~ at its own Stop and wrote no
      // per-line key, so the first 1.86.1 Stop re-applied every old ~ / ✓ over
      // whatever the brain held by then.
      '🧠 BRAIN [Ship] ~: Exact titles for release targets shipped in the resolver lane and the fuzzy fallback is gone',
    ];
    // … and what is new since the upgrade.
    const turn1 = [
      thinDev,
      '🧠 BRAIN [Brain]: The resolver now treats closes: targets as exact titles ev: src/klypix-format.mjs',
      '🧠 BRAIN [Deploy] ~: Production deploy now runs from main',
    ];
    const tp2 = path.join(home2, 't-e2.jsonl');
    const beforeUpgrade = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const entries = [
      { type: 'user', uuid: 'u-0', timestamp: beforeUpgrade, message: { role: 'user', content: 'restructure the faq, docs and share pages' } },
      { type: 'assistant', uuid: 'a-0', timestamp: beforeUpgrade, message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${turn0.join('\n')}` }] } },
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'wire the dev port and ship the uploader retry' } },
      { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${turn1.join('\n')}` }] } },
    ];
    const writeT = () => fs.writeFileSync(tp2, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const env2 = { ...process.env, HOME: home2, USERPROFILE: home2, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
    delete env2.KLYPIX_BRAIN_NO_MAIN;
    const stop2 = () => spawnSync(process.execPath, [HOOK, '--capture'], { cwd: proj2, env: env2, encoding: 'utf8', input: JSON.stringify({ session_id: 'grammar-e2', transcript_path: tp2 }) });
    const snap = async () => (await parseKlypix(fs.readFileSync(brain2))).struct;
    const ledger2 = () => { const f = path.join(proj2, '.claude', 'brain-capture-log.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    writeT();
    const r1 = stop2();
    ok(r1.status === 0, `E2 Stop 1 exits 0 (${r1.status})`);
    const s1 = await snap();
    const devOf = (s) => s.cards.find((c) => c.type !== 'container' && /dev server port is configured/.test(flat(c.text)));
    const dev1 = devOf(s1);
    ok(amendments(dev1.text) === 1, 'E2 Stop 1: the thin ~ naming a long path is appended once');
    ok(liveText(s1, /Exact titles for release targets/).length === 1 && liveText(s1, /^Brain: The resolver now treats closes: targets as exact titles/).length === 1,
      'E2 a prose closes: followed by an ev: archives nothing by word coverage; the whole sentence lands');
    const faq = liveText(s1, /Faq page gets a/);
    ok(faq.length === 1 && /^Faq: Faq page gets a Q: and A: layout so billing questions read as a FAQ/.test(faq[0]),
      `E2 a 1.86.0 stub cut at a prose Q: is REPAIRED in place with the full text — one live card (${faq.length})`);
    const up = liveText(s1, /Uploader retry shipped/);
    ok(up.length === 1 && /^Uploader: 🏁 Uploader retry shipped q: backoff and jitter numbers/.test(up[0]),
      `E2 a 1.86.0 stub cut at a malformed q: is repaired in place — one live milestone (${up.length})`);
    const docs = liveText(s1, /Docs index uses a/);
    const docsCard = s1.cards.find((c) => c.type !== 'container' && /Docs index uses a q: prefix/.test(flat(c.text)));
    ok(docs.length === 1 && Boolean(docsCard) && (docsCard.evidence || []).some((e) => e.ref === 'docs/search.md'),
      'E2 …and a repaired stub takes the marker\'s real evidence');
    ok(liveText(s1, /Gone page gets a/).length === 0, 'E2 a marker 1.86.0 already landed whose card is gone is NOT re-added');
    ok(liveText(s1, /^Share: Share page gets a Q: and A: block for team invites/).length === 1
      && liveText(s1, /^Share: Share page gets a Q: prefix on every invite question/).length === 1 && liveText(s1, /^Share: Share page gets a( #|$)/).length === 0,
      'E2 two notes 1.86.0 keyed as one: the first repairs the stub, the second (never captured) lands as its own card');
    ok(liveText(s1, /links as exact title matches/).length === 0 && liveText(s1, /^Pair: Pair key treats closes: targets case-insensitively/).length === 1,
      'E2 …and through a closes: cut: the first is already captured, the second lands');
    ok(/"repair-stub"/.test(ledger2()) && /repaired/.test(r1.stderr || ''), 'E2 the ledger and the receipt say "repaired"');
    // …and the MODEL hears both, on its next prompt: a Stop hook's exit-0
    // stderr never reaches it, and "folded into another card" / "not re-added"
    // are exactly the outcomes only the author can judge (third review, F1).
    // Three receipts per prompt, so read the next few — this Stop produced
    // several, and the point is that these two are among them.
    const promptE2 = Array.from({ length: 4 }, () => spawnSync(process.execPath, [HOOK, '--prompt'], { cwd: proj2, env: env2, encoding: 'utf8', input: JSON.stringify({ session_id: 'grammar-e2', prompt: 'continue with the pages' }) }).stdout || '').join('\n');
    ok(/Brain capture —/.test(promptE2) && /repaired a note 1\.86\.0 cut short/.test(promptE2) && /not re-added/.test(promptE2),
      `E2 (F1) the model hears about a note folded into an existing card and one NOT re-added, on its next prompts (${flat(promptE2).slice(0, 200) || 'EMPTY'})`);
    // ── Third review, 2026-09-18 ─────────────────────────────────────────────
    const pairing = liveText(s1, /Pairing-staleness detection/);
    ok(pairing.length === 1 && !/closes:txt_b08gx7zl/.test(pairing[0]),
      `E2 (F2) a note an older hook cut at an unspaced "closes:" — and ACTED on — is not "repaired" with that junk (${flat(pairing[0] || 'gone')})`);
    ok(liveText(s1, /Rollout ring expanded to twenty percent Q: and A: blocks now render/).length === 1
      && s1.cards.some((c) => c.type !== 'container' && /Rollout ring expanded to twenty percent/.test(flat(c.text)) && !/Q: and A:/.test(flat(c.text))),
      'E2 (F1/R4) two notes of ONE capture whose second\'s old cut equals the first\'s own key land as TWO cards');
    const ship = liveText(s1, /Exact titles for release targets/);
    ok(ship.length === 1 && !/fuzzy fallback is gone/.test(ship[0]),
      `E2 (F6) a ~ from an event an older hook already applied is not applied again at the first 1.86.1 Stop (${flat(ship[0] || 'gone')})`);
    const prodAmended = liveText(s1, /Production deploy runs from the release branch/);
    ok(prodAmended.length === 1 && /now runs from main/.test(prodAmended[0]), 'E2 (setup) the thin Production ~ is appended to the Production card');
    // Stops 2 and 3 re-read the same transcript: nothing changes.
    const brainBytes1 = fs.readFileSync(brain2);
    stop2(); stop2();
    const s3 = await snap();
    ok(amendments(devOf(s3).text) === 1 && devOf(s3).createdAt === dev1.createdAt, 'E2 Stops 2–3: still ONE amendment line, the card not re-dated');
    ok(/"skipped-applied"/.test(ledger2()), 'E2 the re-read ~ lines are ledgered as skipped-applied');
    ok(Buffer.compare(brainBytes1, fs.readFileSync(brain2)) === 0, 'E2 a re-read transcript leaves brain.klypix byte-identical');
    // A NEW turn repeating the same thin ~ is a new marker — the engine sees the
    // card already says it.
    entries.push({ type: 'user', uuid: 'u-2', message: { role: 'user', content: 'again' } });
    entries.push({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: `Confirmed.\n\n${thinDev}` }] } });
    // F7: the ✓ that retires the Production card, one Stop later.
    entries.push({ type: 'assistant', uuid: 'a-3', message: { role: 'assistant', content: [{ type: 'text', text: 'Retired.\n\n🧠 BRAIN [Deploy] ✓: Production deploy runs from the release branch through the publish workflow — retired, replaced by tag pipeline' }] } });
    writeT();
    stop2(); stop2();
    const s5 = await snap();
    ok(amendments(devOf(s5).text) === 1 && /"update-already-says"/.test(ledger2()), 'E2 the same thin ~ in a NEW turn is "already says" — still one line');
    const staging = s5.cards.find((c) => c.type !== 'container' && /Staging deploy runs from main/.test(flat(c.text)));
    ok(Boolean(staging) && amendments(staging.text) === 0, 'E2 once its card is resolved, a re-read thin ~ never lands on ANOTHER card');
    // Third review (R5): the seen set is a capped FIFO and a Set keeps FIRST
    // insertion order, so a key re-read at every Stop never refreshed — it
    // aged out while its transcript was still live, and resuming that session
    // re-applied its ~ lines over whatever the cards said by then. KLYPIX's own
    // state already held 1,658 of the old 2,000. A capture now moves every key
    // it HIT to the young end (including a Stop with nothing new to land), and
    // the cap leaves room for several busy sessions.
    const stateFile = path.join(proj2, '.claude', 'brain-capture-state.json');
    const stateBefore = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // 6,000 keys from the project's other sessions arrive AFTER this session's,
    // which are now the oldest in the set.
    fs.writeFileSync(stateFile, JSON.stringify({ ...stateBefore, seen: [...stateBefore.seen, ...Array.from({ length: 6000 }, (_, i) => `busy-peer-key-${i}`)] }));
    // This session Stops again with nothing new to land — the common case, and
    // the moment its keys must be refreshed.
    stop2();
    // Then ANOTHER session captures, which is what trims the set.
    const tp2b = path.join(home2, 't-e2b.jsonl');
    fs.writeFileSync(tp2b, [
      { type: 'user', uuid: 'u-peer', message: { role: 'user', content: 'unrelated work in another session' } },
      { type: 'assistant', uuid: 'a-peer', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n🧠 BRAIN [Peer]: A second session captured an unrelated decision about the preview workflow' }] } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    spawnSync(process.execPath, [HOOK, '--capture'], { cwd: proj2, env: env2, encoding: 'utf8', input: JSON.stringify({ session_id: 'grammar-e2-peer', transcript_path: tp2b }) });
    const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8')).seen;
    ok(kept.length <= 5000, `E2 (R5) the seen set stays capped (${kept.length} keys)`);
    // …and resuming the first session re-reads its whole transcript against a
    // brain that has moved on. Its ~ lines must still count as applied.
    const bytesBeforeResume = fs.readFileSync(brain2);
    stop2(); stop2();
    ok(Buffer.compare(bytesBeforeResume, fs.readFileSync(brain2)) === 0,
      'E2 (R5) a session resumed after the project\'s seen set overflowed does not re-apply the ~ / ✓ lines it already applied');
  }

  // ── E2b — the upgrade back-compat is BOUNDED to what an older hook wrote ──
  // Third review, 2026-09-18 (F1). 1.86.1 keys a note with no closes: on
  // sha(type|area|body) — byte-identical to the OLD-CUT key of any LATER note
  // that starts with the same sentence and then carries a key this grammar
  // keeps as TEXT (a prose "Q:", an unspaced "closes:", a prose "ev:"). Those
  // old keys were consulted for every additive marker with no time bound, so
  // the collision had nothing to do with an upgrade: in a project that never
  // ran an older hook at all, a second note was folded into the FIRST note's
  // card as a "repair", dropped as "not re-added", or had its closes: skipped
  // while the ❓ stayed open. Reproduced on a scratch copy of the real brain.
  // A project whose capture state was never written by an older hook now has
  // legacyUntil 0 and never looks at an old key.
  {
    const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-home4-'));
    const proj4 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-proj4-'));
    extraDirs.push(home4, proj4);
    fs.mkdirSync(path.join(home4, '.claude', 'project-brain'), { recursive: true });
    fs.writeFileSync(path.join(home4, '.claude', 'project-brain', '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
    fs.mkdirSync(path.join(proj4, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj4, 'README.md'), '# probe\n');
    const brain4 = path.join(proj4, 'brain.klypix');
    fs.writeFileSync(brain4, await buildKlypixMap({
      title: 'brain',
      areas: [
        { title: 'ProbeSupport', cards: [{ text: 'ProbeSupport: The support area is where the help centre and its macros live' }] },
        // The ❓ is about something else, so nothing but an explicit closes:
        // can retire it.
        { title: 'ProbeFaq', cards: [{ text: 'ProbeFaq: ❓ Should the invite emails carry a plain-text fallback body' }] },
      ],
    }));
    // NO .claude/brain-capture-state.json: this project has never run any hook.
    const env4 = { ...process.env, HOME: home4, USERPROFILE: home4, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
    delete env4.KLYPIX_BRAIN_NO_MAIN;
    const session4 = (sid, markerLines) => {
      const tp4 = path.join(home4, `t-${sid}.jsonl`);
      fs.writeFileSync(tp4, [
        { type: 'user', uuid: `u-${sid}`, message: { role: 'user', content: 'work on the support pages' } },
        { type: 'assistant', uuid: `a-${sid}`, message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${markerLines.join('\n')}` }] } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n');
      return spawnSync(process.execPath, [HOOK, '--capture'], { cwd: proj4, env: env4, encoding: 'utf8', input: JSON.stringify({ session_id: sid, transcript_path: tp4 }) });
    };
    const a = session4('probe-a', [
      '🧠 BRAIN [ProbeSupport]: Support page redesign shipped ev: README.md',
      '🧠 BRAIN [ProbeFaq]: Support FAQ accordion shipped ev: README.md',
    ]);
    ok(a.status === 0, `E2b Stop a exits 0 (${a.status})`);
    const b = session4('probe-b', [
      '🧠 BRAIN [ProbeSupport]: Support page redesign shipped Q: and A: blocks now render as an accordion instead of a flat list',
      '🧠 BRAIN [ProbeFaq]: Support FAQ accordion shipped closes: [[Should the invite emails carry a plain-text fallback body]]',
    ]);
    ok(b.status === 0, `E2b Stop b exits 0 (${b.status})`);
    const s4 = (await parseKlypix(fs.readFileSync(brain4))).struct;
    const all4 = (re) => s4.cards.filter((c) => c.type !== 'container' && re.test(flat(c.text))).map((c) => flat(c.text));
    ok(all4(/Support page redesign shipped Q: and A: blocks now render as an accordion/).length === 1
      && all4(/Support page redesign shipped/).some((t) => !/Q: and A:/.test(t)),
      `E2b a later note that starts with an earlier note's sentence is its own card, not a "repair" of it (${all4(/Support page redesign shipped/).length} card(s))`);
    const stderr4 = `${a.stderr || ''}\n${b.stderr || ''}`;
    ok(!/repaired a note 1\.86\.0 cut short/.test(stderr4) && !/were NOT re-added/.test(stderr4),
      `E2b …with no repair and nothing dropped in a project that never ran an older hook (${flat(stderr4).slice(0, 120)})`);
    ok(liveText(s4, /❓ Should the invite emails carry a plain-text fallback body/).length === 0
      && all4(/Support FAQ accordion shipped/).length >= 1,
      'E2b …and a later note whose closes: names an unrelated open question still closes it');
    // The bound is on the OLD keys only: this project's own dedup is untouched,
    // so re-reading the same transcripts changes nothing.
    const bytes4 = fs.readFileSync(brain4);
    session4('probe-a', ['🧠 BRAIN [ProbeSupport]: Support page redesign shipped ev: README.md', '🧠 BRAIN [ProbeFaq]: Support FAQ accordion shipped ev: README.md']);
    ok(Buffer.compare(bytes4, fs.readFileSync(brain4)) === 0, 'E2b a re-read transcript still leaves brain.klypix byte-identical');
  }

  // ── E5 — a marker the engine cannot apply never cancels the batch, and a
  //        queued batch it keeps failing on never wedges the project ─────────
  // Third review, 2026-09-18 (F4). The real trigger was cardAlreadySays
  // throwing V8's regexp "Stack overflow" on a ~5,000-character thin ~ (fixed
  // above, U1); the damage was everything downstream of it. captureIntoBrain
  // threw, so the WHOLE Stop batch was lost — an unrelated decision in the
  // same transcript never landed. And when the brain lock was held (a routine
  // desktop save) that batch was QUEUED, the author was told "nothing lost",
  // and every later session drained it, threw, landed nothing and left the
  // queue in place: capture was dead project-wide until someone deleted the
  // file.
  {
    const buf = await buildKlypixMap({
      title: 'brain',
      areas: [
        { title: 'Dev', cards: [{ text: 'Dev: The dev server port is configured in vite.config.ts and electron waits on it before launching the overlay' }] },
        { title: 'Ops', cards: [{ text: 'Ops: The deploy pipeline runs lint then tests then the packaging job before uploading the artifacts' }] },
      ],
    });
    // A marker whose own shape makes the engine throw mid-update — the only
    // way left to exercise containment now that the real thrower is fixed.
    const bad = { area: 'Dev', text: 'The dev server port is now configured in electron config and the overlay waits on it' };
    Object.defineProperty(bad, 'guard', { get() { throw new Error('synthetic marker failure'); }, enumerable: true });
    const good = { area: 'Ops', text: 'The deploy pipeline now runs the packaging job before the tests and uploads the artifacts afterwards' };
    let threw = null, r = null;
    try { r = await captureIntoBrain(buf, { updates: [bad, good] }); } catch (e) { threw = e; }
    ok(!threw && r?.stats.updated === 1 && r.stats.captureErrors?.length === 1 && r.stats.captureErrors[0].kind === 'update'
      && /synthetic marker failure/.test(r.stats.captureErrors[0].error),
      `E5 a ~ the engine throws on is contained: the other marker of the same batch still lands (${threw ? threw.message.slice(0, 60) : `${r.stats.updated} updated`})`);
    ok(Boolean(r) && formatCaptureReceipts(r.stats).some((l) => /~ update failed/.test(l) && /The rest of the capture landed/.test(l)),
      'E5 …and the author is told which marker failed, not left to guess');
    const struct = r ? (await parseKlypix(r.buffer)).struct : { cards: [] };
    ok(liveText(struct, /packaging job before the tests/).length === 1 && liveText(struct, /configured in vite\.config\.ts/).length === 1,
      'E5 …the good correction is on its card, and the failed one changed nothing');
  }
  {
    // Through the REAL hook, with a queued batch the engine keeps failing on.
    // The sandbox is the shipped src/ with ONE line added to captureIntoBrain:
    // it throws on a sentinel. node_modules is junctioned so bare imports still
    // resolve; nothing else differs from what ships.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-poison-'));
    const sandboxSrc = path.join(sandbox, 'src');
    const nm = path.join(sandbox, 'node_modules');
    junctions.push(nm);
    extraDirs.push(sandbox);
    fs.mkdirSync(sandboxSrc, { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules'), nm, 'junction');
    const srcDir = fileURLToPath(SRC);
    for (const f of fs.readdirSync(srcDir)) { const s = path.join(srcDir, f); if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(sandboxSrc, f)); }
    const engine = path.join(sandboxSrc, 'klypix-format.mjs');
    const sig = 'export async function captureIntoBrain(buffer, { cards = [], resolutions = [], updates = [] } = {}) {';
    const engineSrc = fs.readFileSync(engine, 'utf8');
    ok(engineSrc.includes(sig), 'E5 (setup) the sandbox engine carries the signature the seam goes after');
    fs.writeFileSync(engine, engineSrc.replace(sig, `${sig}\n    if ([...cards, ...updates, ...resolutions].some((x) => /POISON-MARKER/.test(String((x && x.text) || '')))) throw new Error('synthetic engine failure');`));
    const sandboxHook = path.join(sandboxSrc, 'global-brain-hook.mjs');
    const homeP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-homeP-'));
    const projP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-projP-'));
    extraDirs.push(homeP, projP);
    fs.mkdirSync(path.join(homeP, '.claude', 'project-brain'), { recursive: true });
    fs.writeFileSync(path.join(homeP, '.claude', 'project-brain', '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
    fs.mkdirSync(path.join(projP, '.claude'), { recursive: true });
    const brainP = path.join(projP, 'brain.klypix');
    fs.writeFileSync(brainP, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Queue', cards: [{ text: 'Queue: The capture queue drains under the brain write lock on the next Stop' }] }] }));
    const { laneFileFor } = await import(new URL('agent-presence.mjs', SRC).href);
    const pendingFile = path.join(homeP, '.claude', 'project-brain', 'pending', path.basename(laneFileFor(brainP, homeP)).replace(/\.json$/, '.captures.json'));
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify([{
      id: 'poison-1', ts: new Date().toISOString(),
      cards: [{ text: 'Queue: POISON-MARKER a queued batch the engine cannot apply', area: 'Queue', createdVia: 'claude-code' }],
      resolutions: [], updates: [],
    }]));
    const envP = { ...process.env, HOME: homeP, USERPROFILE: homeP, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
    delete envP.KLYPIX_BRAIN_NO_MAIN;
    const stopP = (sid, line) => {
      const tp = path.join(homeP, `t-${sid}.jsonl`);
      fs.writeFileSync(tp, [
        { type: 'user', uuid: `u-${sid}`, message: { role: 'user', content: 'keep working on the queue' } },
        { type: 'assistant', uuid: `a-${sid}`, message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${line}` }] } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n');
      return spawnSync(process.execPath, [sandboxHook, '--capture'], { cwd: projP, env: envP, encoding: 'utf8', input: JSON.stringify({ session_id: sid, transcript_path: tp }) });
    };
    // Four unrelated decisions from four later sessions: each must land even
    // though the queue they drain keeps throwing.
    const own = [
      ['Queue', 'The pending queue file is read under its own lock before the brain write', /pending queue file is read under its own lock/],
      ['Docs', 'The troubleshooting guide gains a section on capture batches that will not land', /troubleshooting guide gains a section/],
      ['Health', 'Hook health rows carry the batch scope so a wedged queue is visible to the doctor', /Hook health rows carry the batch scope/],
      ['Cli', 'A doctor subcommand lists set-aside capture batches with the first card of each', /doctor subcommand lists set-aside capture batches/],
    ];
    const runs = own.map(([area, text], i) => stopP(`poison-${i + 1}`, `🧠 BRAIN [${area}]: ${text}`));
    ok(runs.every((r) => r.status === 0), `E5 every Stop still exits 0 (${runs.map((r) => r.status).join(',')})`);
    const sP = (await parseKlypix(fs.readFileSync(brainP))).struct;
    const landed = own.filter(([, , re]) => liveText(sP, re).length === 1);
    ok(landed.length === own.length, `E5 a queued batch the engine cannot apply never cancels another session's own markers (${landed.length}/${own.length} landed)`);
    const stillQueued = (() => { try { const d = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } })();
    const poisonFiles = fs.readdirSync(path.dirname(pendingFile)).filter((n) => n.startsWith(`${path.basename(pendingFile)}.poison-`));
    ok(!stillQueued.some((b) => b && b.id === 'poison-1') && poisonFiles.length === 1,
      `E5 …and after 3 failed drains it is SET ASIDE, not drained forever (queued=${stillQueued.length}, set aside=${poisonFiles.length})`);
    ok(poisonFiles.length === 1 && /POISON-MARKER/.test(fs.readFileSync(path.join(path.dirname(pendingFile), poisonFiles[0]), 'utf8')),
      'E5 …kept whole in a file of its own, never deleted');
    const told = runs.map((r) => r.stderr || '').join('\n');
    ok(/queued batch from an earlier capture threw/.test(told) && /set aside/.test(told), 'E5 …and both facts are reported, not silent');
    const healthDir = path.join(homeP, '.claude', 'project-brain', 'health');
    const health = fs.existsSync(healthDir) ? fs.readdirSync(healthDir).map((f) => fs.readFileSync(path.join(healthDir, f), 'utf8')).join('\n') : '';
    ok(/batch-isolated:own/.test(health), 'E5 …and recorded in the per-project health log');
  }

  // ── E3 — receipts reach the author, or a session that replaced it ─────────
  // Review 2026-09-18 (R3/R4/R5): a new session printed a LIVE session's
  // receipts at SessionStart (past the ~2 KB preview) and marked them shown for
  // everyone, so the author never saw them; an unwritable sidecar re-printed
  // the same receipt on every prompt.
  {
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-home3-'));
    const proj3 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-proj3-'));
    extraDirs.push(home3, proj3);
    fs.mkdirSync(path.join(home3, '.claude', 'project-brain'), { recursive: true });
    fs.writeFileSync(path.join(home3, '.claude', 'project-brain', '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
    fs.mkdirSync(path.join(proj3, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj3, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: [{ title: 'Nav', cards: [{ text: 'Nav: Pan hand tool lives in the bottom status bar next to the zoom steppers' }] }] }));
    const env3 = (hostPid) => {
      const env = { ...process.env, HOME: home3, USERPROFILE: home3, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0', CLAUDE_PID: String(hostPid) };
      delete env.KLYPIX_BRAIN_NO_MAIN;
      return env;
    };
    const hostA = process.pid, hostB = process.ppid || process.pid;
    const run3 = (mode, input, hostPid) => spawnSync(process.execPath, [HOOK, ...(mode ? [mode] : [])], { cwd: proj3, env: env3(hostPid), encoding: 'utf8', input: JSON.stringify(input) });
    let turn = 0;
    const markerStop = (sid, marker, hostPid) => {
      const tp = path.join(home3, `t-${sid}.jsonl`);
      turn++;
      fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', uuid: `e3-${turn}`, message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${marker}` }] } }) + '\n');
      return run3('--capture', { session_id: sid, transcript_path: tp }, hostPid);
    };
    const receiptsFile = path.join(proj3, '.claude', 'brain-rule-drafts.json');
    const receipts = () => { try { return JSON.parse(fs.readFileSync(receiptsFile, 'utf8')).captureReceipts || []; } catch { return []; } };
    const block = /Brain capture —/;
    // A live author on another host keeps its receipt.
    markerStop('sess-A', '🧠 BRAIN [Nav] !: Pan tool moved to the main toolbar ev: src/canvas/Toolbar.tsx q: pan tool location?', hostA);
    ok(receipts().some((r) => r.sid === 'sess-A' && !r.shown), 'E3 (setup) session A has an unshown receipt');
    const startB = run3('', { session_id: 'sess-B', source: 'startup' }, hostB);
    ok(startB.status === 0 && !block.test(startB.stdout || ''), 'E3 SessionStart prints no receipts block (it would land past the preview)');
    ok(!block.test(run3('--prompt', { session_id: 'sess-B', prompt: 'continue with the toolbar work' }, hostB).stdout || ''),
      'E3 a new session on ANOTHER host does not take a LIVE session\'s receipts');
    const promptA = run3('--prompt', { session_id: 'sess-A', prompt: 'continue with the toolbar work' }, hostA).stdout || '';
    ok(/what your last 🧠 BRAIN markers actually did/.test(promptA) && /q: pan tool location\?/.test(promptA), 'E3 …the author sees its own receipt on its next prompt');
    // A /clear in the SAME host replaces the conversation: its receipts move
    // over on the new session's first PROMPT. Third review (R1): the installed
    // SessionStart matcher was "startup|resume", so no SessionStart ran on a
    // real /clear and the handoff never happened — this runs none.
    markerStop('sess-A', '🧠 BRAIN [Nav] !: Zoom steppers moved beside the pan tool ev: src/canvas/Zoom.tsx q: zoom location?', hostA);
    ok(!block.test(run3('--prompt', { session_id: 'sess-B', prompt: 'continue with the toolbar work' }, hostB).stdout || '')
      && receipts().some((r) => r.sid === 'sess-A' && !r.shown && /zoom location/.test(r.line)),
      'E3 a session on ANOTHER host process (another CLAUDE_PID) never takes a live author\'s receipt at its prompt');
    const promptA2 = run3('--prompt', { session_id: 'sess-A2', prompt: 'continue with the toolbar work' }, hostA).stdout || '';
    ok(/\(earlier session\) suffix kept as card text: "q: zoom location\?"/.test(promptA2) && /replaced in this terminal \(\/clear or \/resume\)/.test(promptA2),
      'E3 after a /clear in the same host — with NO SessionStart between — the new session\'s first prompt adopts the predecessor\'s receipt and prints it, marked as from the conversation it replaced');
    ok(!block.test(run3('--prompt', { session_id: 'sess-A2', prompt: 'continue' }, hostA).stdout || '')
      && !block.test(run3('--prompt', { session_id: 'sess-A', prompt: 'continue' }, hostA).stdout || ''), 'E3 …once, and nobody prints it again');
    const sessDir = path.join(home3, '.claude', 'project-brain', 'sessions');
    const dropLane = (sid) => {
      for (const f of fs.readdirSync(sessDir).filter((n) => /\.json$/.test(n))) {
        const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (Array.isArray(d.sessions)) { d.sessions = d.sessions.filter((s) => s.id !== sid); fs.writeFileSync(path.join(sessDir, f), JSON.stringify(d)); }
      }
    };
    const editReceipts = (fn) => { const d = JSON.parse(fs.readFileSync(receiptsFile, 'utf8')); for (const r of d.captureReceipts) fn(r); fs.writeFileSync(receiptsFile, JSON.stringify(d)); };
    // R2: an author that is idle but ALIVE keeps its receipt, however long.
    markerStop('sess-E', '🧠 BRAIN [Nav] !: Ruler toggle moved into the view menu ev: src/canvas/Ruler.tsx q: ruler location?', hostB);
    dropLane('sess-E');
    editReceipts((r) => { if (r.sid === 'sess-E') r.ts = Date.now() - 31 * 60 * 1000; });
    run3('', { session_id: 'sess-F', source: 'startup' }, hostA);
    ok(!block.test(run3('--prompt', { session_id: 'sess-F', prompt: 'continue with the menus' }, hostA).stdout || '')
      && receipts().some((r) => r.sid === 'sess-E' && !r.shown),
      'E3 an author idle for 30+ minutes whose host process is still ALIVE keeps its receipt (no lane row is not "ended")');
    ok(/q: ruler location\?/.test(run3('--prompt', { session_id: 'sess-E', prompt: 'back from lunch' }, hostB).stdout || ''),
      'E3 …and sees it itself when it comes back');
    // An author whose host process is provably gone is handed off at the next
    // SessionStart, and the heading says it is no longer running.
    const deadHost = spawnSync(process.execPath, ['-e', '']).pid;
    markerStop('sess-C', '🧠 BRAIN [Nav] !: Minimap toggle moved into the view menu ev: src/canvas/ViewMenu.tsx q: minimap location?', deadHost);
    run3('', { session_id: 'sess-D', source: 'startup' }, hostA);
    // R4: a shown-mark that cannot be persisted prints nothing (the lock is held).
    const lockFile = `${receiptsFile}.lock`;
    fs.writeFileSync(lockFile, 'held by the test');
    const held = run3('--prompt', { session_id: 'sess-D', prompt: 'continue with the menus' }, hostA).stdout || '';
    fs.rmSync(lockFile, { force: true });
    ok(!block.test(held) && receipts().some((r) => r.sid === 'sess-D' && !r.shown), 'E3 a receipt whose shown-mark cannot be written is not printed, and stays pending');
    const promptD = run3('--prompt', { session_id: 'sess-D', prompt: 'continue with the menus' }, hostA).stdout || '';
    ok(/\(earlier session\) suffix kept as card text: "q: minimap location\?"/.test(promptD) && /no longer running/.test(promptD),
      'E3 a receipt whose author\'s host process is gone is adopted at the next SessionStart and printed on that session\'s prompt');
    ok(!block.test(run3('--prompt', { session_id: 'sess-D', prompt: 'continue' }, hostA).stdout || ''), 'E3 …once');
    // A receipt with no host pid (a session without CLAUDE_PID, or 1.86.1's)
    // keeps the old rule: no live lane row and unshown for 30+ minutes — and
    // the heading does not claim its author has ended.
    markerStop('sess-G', '🧠 BRAIN [Nav] !: Grid toggle moved into the view menu ev: src/canvas/Grid.tsx q: grid location?', hostB);
    dropLane('sess-G');
    editReceipts((r) => { if (r.sid === 'sess-G') { delete r.hostPid; delete r.machine; r.ts = Date.now() - 31 * 60 * 1000; } });
    run3('', { session_id: 'sess-H', source: 'startup' }, hostA);
    const promptH = run3('--prompt', { session_id: 'sess-H', prompt: 'continue with the menus' }, hostA).stdout || '';
    ok(/\(earlier session\) suffix kept as card text: "q: grid location\?"/.test(promptH) && /no activity for 30\+ minutes/.test(promptH) && !/no longer running/.test(promptH),
      'E3 a legacy receipt with no host pid is handed off by the lane + 30-minute rule, worded as idle, not ended');
    // …and one from ANOTHER machine is never adopted.
    markerStop('sess-M', '🧠 BRAIN [Nav] !: Snap toggle moved into the view menu ev: src/canvas/Snap.tsx q: snap location?', hostB);
    dropLane('sess-M');
    editReceipts((r) => { if (r.sid === 'sess-M') { r.machine = 'another-machine'; r.hostPid = 999999; r.ts = Date.now() - 31 * 60 * 1000; } });
    run3('', { session_id: 'sess-N', source: 'startup' }, hostA);
    ok(!block.test(run3('--prompt', { session_id: 'sess-N', prompt: 'continue' }, hostA).stdout || '') && receipts().some((r) => r.sid === 'sess-M' && !r.shown),
      'E3 a receipt from another machine is never adopted (its TTL expires it)');
    // ── Third review, 2026-09-18 ─────────────────────────────────────────────
    // R3: the stale-lock break was mtime-ONLY, so a crashed holder's lock
    // survived a clock that stepped backwards (a dual-boot RTC/UTC mixup, an
    // NTP step) — every prompt with a pending receipt paid ~2.9 s, printed
    // nothing, and the lock stayed. The lock file already carries the holder's
    // pid: a provably dead holder is broken on the spot, at any mtime.
    markerStop('sess-L', '🧠 BRAIN [Nav] !: Scale bar moved into the view menu ev: src/canvas/Scale.tsx q: scale bar location?', hostB);
    const deadHolder = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lockFile, `${deadHolder} crashed-token`);
    const hourAhead = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(lockFile, hourAhead, hourAhead);
    const promptL = run3('--prompt', { session_id: 'sess-L', prompt: 'continue with the menus' }, hostB).stdout || '';
    ok(/q: scale bar location\?/.test(promptL) && !fs.existsSync(lockFile),
      'E3 (R3) a lock whose holder is a DEAD process is broken even with an mtime an hour in the future');
    // …and a live holder's lock is still respected (the pid is checked, not assumed).
    markerStop('sess-L', '🧠 BRAIN [Nav] !: Compass moved into the view menu ev: src/canvas/Compass.tsx q: compass location?', hostB);
    fs.writeFileSync(lockFile, `${process.pid} this-test-holds-it`);
    const heldLive = run3('--prompt', { session_id: 'sess-L', prompt: 'continue' }, hostB).stdout || '';
    ok(!/q: compass location\?/.test(heldLive) && fs.existsSync(lockFile),
      'E3 (R3) …while a lock held by a LIVE process is neither broken nor removed by the waiter');
    fs.rmSync(lockFile, { force: true });
    run3('--prompt', { session_id: 'sess-L', prompt: 'continue' }, hostB);
    // R4: a sidecar that CANNOT be written used to run the full ~940 ms rename
    // backoff inside the lock on EVERY prompt, for up to the 3-day TTL, and
    // still print nothing (measured: ~1.33 s per prompt against a ~0.4 s
    // baseline). It now fails fast, stamps the project's health dir, and skips
    // the locked write while that stamp is fresh — and drops the stamp the
    // moment the destination is writable again.
    const healthDir = path.join(home3, '.claude', 'project-brain', 'health');
    const stampOf = () => { try { return fs.readdirSync(healthDir).filter((n) => n.endsWith('.sidecar-unwritable')); } catch { return []; } };
    markerStop('sess-W', '🧠 BRAIN [Nav] !: Locator moved into the view menu ev: src/canvas/Locator.tsx q: locator location?', hostB);
    fs.chmodSync(receiptsFile, 0o444);
    const w1 = run3('--prompt', { session_id: 'sess-W', prompt: 'continue with the menus' }, hostB).stdout || '';
    const stamped = stampOf();
    const w2 = run3('--prompt', { session_id: 'sess-W', prompt: 'continue with the menus' }, hostB).stdout || '';
    fs.chmodSync(receiptsFile, 0o666);
    ok(!block.test(w1) && !block.test(w2) && stamped.length === 1,
      `E3 (R4) an unwritable sidecar prints nothing and is recorded once, not retried blind on every prompt (${stamped.length} stamp)`);
    const stampText = (() => { try { return fs.readFileSync(path.join(healthDir, stamped[0]), 'utf8'); } catch { return ''; } })();
    ok(/read-only/.test(stampText), 'E3 (R4) …and the stamp says why');
    const w3 = run3('--prompt', { session_id: 'sess-W', prompt: 'continue with the menus' }, hostB).stdout || '';
    ok(/q: locator location\?/.test(w3) && stampOf().length === 0,
      'E3 (R4) …and the receipt is printed as soon as the sidecar is writable again — the backoff never outlives its cause');
    // R8: the 40-receipt cap trimmed by POSITION, so an idle author's still
    // unshown receipt was pushed out while SHOWN ones sat waiting for their
    // 3-day TTL. Shown receipts go first now.
    {
      const d = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
      const now = Date.now();
      d.captureReceipts = [
        { key: 'idle-author', sid: 'sess-IDLE', ts: now - 60 * 60 * 1000, line: 'suffix kept as card text: "q: the idle author\'s receipt"', shown: false, hostPid: hostB, machine: (d.captureReceipts[0] || {}).machine },
        ...Array.from({ length: 41 }, (_, i) => ({ key: `shown-${i}`, sid: 'sess-OLD', ts: now - 30 * 60 * 1000 + i, line: `already shown ${i}`, shown: true })),
      ];
      fs.writeFileSync(receiptsFile, JSON.stringify(d));
      markerStop('sess-Z', '🧠 BRAIN [Nav] !: Overview moved into the view menu ev: src/canvas/Overview.tsx q: overview location?', hostA);
      const after = receipts();
      ok(after.length <= 40 && after.some((r) => r.key === 'idle-author'),
        `E3 (R8) the receipt cap drops SHOWN receipts first — an idle author's unshown one survives (${after.length} kept, ${after.filter((r) => r.shown).length} shown)`);
    }
  }
} catch (e) {
  console.error('✗ suite crashed:', e && e.stack || e);
  failures++;
} finally {
  for (const j of junctions) { try { fs.unlinkSync(j); } catch { try { fs.rmdirSync(j); } catch { /* already gone */ } } }
  for (const d of [home, proj, ...extraDirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}

if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
console.log('\n✓ marker-suffix-grammar — all assertions passed');
