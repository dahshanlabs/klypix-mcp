// Marker suffix grammar + the ~ update floor (1.86.1).
//
// 1.86.0 added `q:` to the marker suffix keys and split every marker body at the
// first whitespace + "Q:"/"q:", in any case. A pre-release audit of the desktop
// bundle reproduced the damage end to end: "Support page gets a Q: and A:
// layout so pricing questions read as a FAQ" landed as the card "Support page
// gets a", and "~: Pricing page layout switches to Q: and A: FAQ blocks …"
// REPLACED a thirteen-word card with a four-word stub — no ↩ trace, no Archive
// copy. The same mid-sentence hazard already existed for `ev:`, `verify:` and
// `closes:`. Every harmful case from that audit is a check here, and each one
// fails on v1.86.0:
//
//   G1  prose "Q:"/"q:" (English and Arabic) never cuts a body; nor does "the
//       ev:", "every agent verify: the tag", `npm run verify:mcp`, "q:auth".
//   G2  every DOCUMENTED form still parses: trailing q:, closes:/ev:/verify: in
//       any order, PR shorthands, absolute paths, probe names, Arabic q:.
//   G3  the grammar is ONE block, byte-identical in the hook and klypix-format,
//       and parseVerifySuffix agrees with the hook on every line of the corpus.
//   U1  the ~ floor: a stub never replaces a richer card; the card is left
//       untouched, the text is kept beside it, the refusal is reported, and a
//       re-harvested marker does not stack copies. Full corrections, short
//       corrections of short cards and terse confirmations are unchanged.
//   C1  a closes: whose target names no live card goes back into the card
//       text; a closes: that names a card still closes it.
//   E1  end to end through the real Stop hook on a scratch brain.
import fs from 'fs';
import os from 'os';
import path from 'path';
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

const prevNoMain = process.env.KLYPIX_BRAIN_NO_MAIN;
process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const hook = await import(new URL('global-brain-hook.mjs', SRC).href);
if (prevNoMain === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = prevNoMain;
const fmt = await import(new URL('klypix-format.mjs', SRC).href);
const { prepareBrainEvidence } = await import(new URL('brain-evidence.mjs', SRC).href);
const { splitMarkerSuffixes } = hook;
const { buildKlypixMap, parseKlypix, captureIntoBrain, formatCaptureReceipts, parseVerifySuffix } = fmt;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-grammar-proj-'));

try {
  // ── G1 — prose is never a suffix ──────────────────────────────────────────
  const untouched = (label, body) => {
    const r = splitMarkerSuffixes(body);
    ok(r.body === body && !r.closes && !r.evidence && !r.verify && !r.question,
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
  ok(closesProse.closes === 'links as exact title matches rather than fuzzy overlap'
    && closesProse.bodyWithCloses === 'The resolver treats closes: links as exact title matches rather than fuzzy overlap',
    'G2 closes: is free text — the parser hands capture the full sentence to fall back to (C1 below)');

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
  const corpus = [
    'shipped the uploader closes: Upload question ev: src/x.mjs verify: gh run list --limit 3',
    'did x verify: gh release list; gh run list closes: Old q',
    '🏁 build 26 uploaded verify: gh run list --limit 5 ev: PR #855',
    'Release checklist now makes every agent verify: the tag, the npm version and the desktop bundle before announcing',
    'Capture hook now runs the verify: probe only for fast-decay cards, never for decisions',
    'Bundle synced (c8a69a8, `npm run verify:mcp` gate green)',
    'the engine actually RUNNING a card\'s verify: command on demand, and demanding a probe receipt',
    'installer staged verify: Get-ChildItem release/*.exe',
    'plain decision with no suffixes',
  ];
  const disagree = corpus.filter((line) => (splitMarkerSuffixes(line).verify || null) !== parseVerifySuffix(line));
  ok(disagree.length === 0, `G3 parseVerifySuffix (card prose) agrees with the hook on every line (${disagree.length} disagree)`);
  ok(parseVerifySuffix('Release: 🏁 build 26 uploaded verify: gh run list --limit 5\n#release') === 'gh run list --limit 5',
    'G3 parseVerifySuffix reads a suffix on its own line of a multi-line card');
  ok(!prepareBrainEvidence({ projectRoot: proj, marker: '~', verify: '', text: 'claim verify: old command' }).ok,
    'G3 brain_note still refuses to clear verify while a lowercase `verify: value` sits in the text');
  ok(prepareBrainEvidence({ projectRoot: proj, marker: '~', verify: '', text: 'gate `npm run verify:mcp` is green' }).ok,
    'G3 …but an npm script name is not an inline suffix and is not refused');

  // ── U1 — the ~ update floor ────────────────────────────────────────────────
  const seed = () => buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Pricing', cards: [{ text: 'Pricing: Pricing page layout uses three tiered plan cards with an annual toggle above them' }] },
      { title: 'Support', cards: [{ text: 'Support: Support page layout is one long list of help articles grouped by product area' }] },
      { title: 'Dev', cards: [{ text: 'Dev: Dev server listens on port 5173' }] },
    ],
  });
  const liveText = (struct, re) => struct.cards.filter((c) => c.type !== 'container' && !/^archive$/i.test(c.area || '') && re.test(flat(c.text))).map((c) => flat(c.text));
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const pricingBefore = s0.cards.find((c) => /three tiered plan/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Pricing', text: 'Pricing page layout switches to', createdVia: 'claude-code' }] });
    const { struct } = await parseKlypix(buffer);
    const pricingAfter = struct.cards.find((c) => c.id === pricingBefore.id);
    ok(stats.updated === 0 && flat(pricingAfter.text) === flat(pricingBefore.text),
      `U1 a four-word stub does NOT replace the thirteen-word card (updated=${stats.updated}) [${flat(pricingAfter.text).slice(0, 50)}]`);
    ok(!/^archive$/i.test(pricingAfter.area || '') && !/↩/.test(pricingAfter.text), 'U1 the card stays live — no supersede by another route');
    ok(stats.updateRefused?.length === 1 && stats.updateRefused[0].id === pricingBefore.id && stats.updateRefused[0].words === 4
      && stats.updateRefused[0].savedAsCard === true, 'U1 the refusal is reported with its counts, and the text was saved');
    ok(liveText(struct, /^Pricing: Pricing page layout switches to/).length === 1, 'U1 the stub text is kept beside the card, not lost');
    ok(formatCaptureReceipts(stats).some((l) => /~ update NOT applied/.test(l) && /left exactly as it was/.test(l)), 'U1 the receipt tells the author');
    const again = await captureIntoBrain(buffer, { updates: [{ area: 'Pricing', text: 'Pricing page layout switches to', createdVia: 'claude-code' }] });
    const { struct: s2 } = await parseKlypix(again.buffer);
    const richAgain = s2.cards.find((c) => c.id === pricingBefore.id);
    ok(liveText(s2, /^Pricing: Pricing page layout switches to/).length === 1 && flat(richAgain.text) === flat(pricingBefore.text),
      'U1 a re-harvested thin ~ does not stack a second copy, and the rich card is still untouched');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const support = s0.cards.find((c) => /one long list/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Support', text: 'Support page layout now uses' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.updated === 0 && flat(struct.cards.find((c) => c.id === support.id).text) === flat(support.text),
      'U1 the Support stub (4 words vs 10) is refused too');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const pricing = s0.cards.find((c) => /three tiered plan/.test(c.text));
    const full = 'Pricing page layout switches to Q: and A: FAQ blocks and the annual toggle is removed';
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Pricing', text: full }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.updated === 1 && !stats.updateRefused && flat(struct.cards.find((c) => c.id === pricing.id).text).startsWith(`Pricing: ${full}`),
      'U1 the FULL correction still replaces in place (documented ~ semantics, the 1.85 result)');
  }
  {
    const buf = await seed();
    const { struct: s0 } = await parseKlypix(buf);
    const dev = s0.cards.find((c) => /port 5173/.test(c.text));
    const { stats, buffer } = await captureIntoBrain(buf, { updates: [{ area: 'Dev', text: 'Dev server listens on port 5174' }] });
    const { struct } = await parseKlypix(buffer);
    ok(stats.updated === 1 && /5174/.test(struct.cards.find((c) => c.id === dev.id).text),
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

  // ── C1 — a closes: that names nothing goes back into the card ─────────────
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
    ok(!/closesFallbackText/.test(raw), 'C1 the fallback field is transport only — never persisted');
  }
  {
    const { stats, buffer } = await captureIntoBrain(await closeSeed(), {
      cards: [{ text: 'Brain: 🏁 uploader backs off on 429\n#brain', area: 'Brain', closes: 'Should the uploader retry on a 429 or back off entirely',
        closesFallbackText: 'Brain: 🏁 uploader backs off on 429 closes: Should the uploader retry on a 429 or back off entirely\n#brain' }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 1 && !stats.closesKept && liveText(struct, /^Brain: 🏁 uploader backs off on 429( #|$)/).length === 1,
      'C1 a closes: that names a card still closes it, and the card text stays clean');
  }
  {
    const { stats, buffer } = await captureIntoBrain(await closeSeed(), {
      cards: [{ text: 'Brain: 🏁 shipped the thing\n#brain', area: 'Brain', closes: 'a target that matches nothing at all anywhere' }],
    });
    const { struct } = await parseKlypix(buffer);
    ok(stats.closed === 0 && !stats.closesKept && liveText(struct, /^Brain: 🏁 shipped the thing( #|$)/).length === 1,
      'C1 a structured closes (brain_note, no fallback text) is unchanged');
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
    ],
  }));
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
  ];
  const tp = path.join(home, 't-grammar.jsonl');
  fs.writeFileSync(tp, [
    { type: 'user', message: { role: 'user', content: 'restructure the support and pricing pages around the questions customers ask' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${markers.join('\n')}` }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  let stderr = '';
  try {
    execFileSync(process.execPath, [HOOK, '--capture'], {
      cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'grammar-e2e', transcript_path: tp }), stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { stderr = String(e.stderr || ''); ok(false, `E1 the hook exits 0 (${e.status})`); }
  const { struct: e2e } = await parseKlypix(fs.readFileSync(brain));
  const has = (re) => liveText(e2e, re).length > 0;
  ok(has(/^Support: Support page gets a Q: and A: layout so pricing questions read as a FAQ/), 'E1 the audit sentence lands whole');
  ok(!has(/^Support: Support page gets a( #|$)/), 'E1 …and the 1.86.0 stub "Support page gets a" does not exist');
  ok(has(/^Support: ❓ Should the Q: prefix in support macros be localized for Arabic agents\?/), 'E1 the open question lands whole');
  ok(has(/^Pricing: Pricing page layout switches to Q: and A: FAQ blocks and the annual toggle is removed/)
    && !has(/^Pricing: Pricing page layout switches to( #|$)/), 'E1 the ~ replaces its card with the FULL correction, never the stub');
  ok(has(/^Help: Help center layout now uses Q: and A: pairs grouped by plan instead of one long list/), 'E1 the superseding decision is the full sentence');
  ok(has(/^Brain: The resolver treats closes: links as exact title matches rather than fuzzy overlap/), 'E1 a prose closes: lands whole');
  const release = e2e.cards.find((c) => /Release checklist now makes every agent/.test(flat(c.text)));
  ok(Boolean(release) && /verify: the tag, the npm version and the desktop bundle before announcing/.test(flat(release.text)) && !release.verify,
    `E1 verify: used as a verb stays text — no probe field [verify=${JSON.stringify(release && release.verify)}]`);
  const evalCard = e2e.cards.find((c) => /Semantic blend stays on/.test(flat(c.text)));
  ok(Boolean(evalCard) && /see the ev: numbers in the eval report/.test(flat(evalCard.text)) && !(evalCard.evidence || []).length,
    'E1 "see the ev: numbers" stays text — no junk evidence ref');
  ok(has(/^Canvas: Pan hand tool moves into the main toolbar( #|$)/), 'E1 a documented trailing q: is still stripped from the card');
  const support = e2e.cards.find((c) => /one long list of help articles/.test(flat(c.text)));
  ok(Boolean(support) && !/^archive$/i.test(support.area || ''), 'E1 the thin ~ left the Support card live and untouched');
  const ledgerFile = path.join(proj, '.claude', 'brain-capture-log.jsonl');
  const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
  ok(/"update-refused-thin"/.test(ledger), 'E1 the ledger records the refused ~ as update-refused-thin, not "update"');
  const { readEnrichment } = await import(new URL('enrichment.mjs', SRC).href);
  const sidecar = readEnrichment(brain, { home });
  ok(sidecar.some((entry) => entry.q.some((q) => /where did the pan hand tool move/.test(q))), 'E1 the q: question reached the enrichment sidecar');
  ok(!sidecar.some((entry) => entry.q.some((q) => /A: layout so pricing|section answering/.test(q))), 'E1 no prose fragment was recorded as a "question"');
  if (stderr) console.log(stderr);
} catch (e) {
  console.error('✗ suite crashed:', e && e.stack || e);
  failures++;
} finally {
  for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}

if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
console.log('\n✓ marker-suffix-grammar — all assertions passed');
