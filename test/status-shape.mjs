// Status-shape detector (1.85.0) — the digest fires for the questions people
// actually ask, and ONLY for those.
//
//   STRICT families (today's four English + the Arabic 'where are we' / 'current
//   state' / 'what is left' shapes) are strong on the phrase alone.
//   LOOSE families ("do i need to update …", "anything left", "what now", "are
//   we up to date?", "is there anything still open for …", Arabic هل/؟-gated
//   need) are strong ONLY under the RESIDUAL RULE: the prompt minus the matched
//   phrase, stopwords and status vocab must consist solely of area aliases.
//   Measured against these very regexes, 14 of 17 ordinary coding questions
//   fired without the rule — and a strong hit REPLACES card retrieval in the
//   hook, so every false positive costs targeted recall.
//
//   Arabic: Unicode tokenizer with the SAME minimum length (3) — ASCII output is
//   byte-identical (locked on 30 prompts); marks stripped and alef/ta-marbuta/
//   alef-maqsura folded before matching; Arabic regexes carry NO `\b` (JS `\b`
//   is ASCII-\w based and never matches beside an Arabic letter).
//
// Run:  node test/status-shape.mjs      (exit 0 = pass, 1 = fail)
import {
  splitQueryTokens, queryTokens, foldArabic, normTokens, stripArabicClitic, residualIsAreaOnly,
  areaFamiliesFromTokens, areaHintsFromPrompt, AREA_FAMILIES, STATUS_FAMILIES_EN, STATUS_FAMILIES_AR,
  STATUS_VOCAB, buildKlypixMap, parseKlypix, statusContextToMarkdown, areaStatusDigest, rankForQuestion,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const fams = (s) => JSON.stringify(splitQueryTokens(s).areaFamilies);

// ── MUST fire (strong=true) — EN ─────────────────────────────────────────────
const POSITIVES_EN = [
  ['do i need to update the desk ? ios ? or web ?', ['desktop', 'ios', 'web']],   // founder prompt #1
  ['anything remaining for the desk app in brain', ['desktop', 'brain']],         // founder prompt #2
  ['what is remaining', []],
  ['what is remaining?', []],
  ['do we need to update desktop', ['desktop']],                                   // no trailing '?'
  ['what now', []],
  ["what's now", []],
  ['anything left', []],
  ['anything else pending?', []],
  ["what's remaining for ios", ['ios']],
  ['are we up to date?', []],
  ['is the desktop build behind?', ['desktop']],
  ['is there anything still open for the website?', ['web']],
  ['what do we still have left', []],
  ['what are the todos', []],
  ['should we ship the electron build?', ['desktop']],
  ['where do we stand', []],
  ['current status', []],
];
for (const [p, expectFams] of POSITIVES_EN) {
  const r = splitQueryTokens(p);
  ok(r.strong === true, `EN strong: "${p}"`);
  ok(r.statusShaped === true, `EN statusShaped implied by strong: "${p}"`);
  ok(JSON.stringify(r.areaFamilies) === JSON.stringify(expectFams), `EN areaFamilies ${fams(p)} == ${JSON.stringify(expectFams)}: "${p}"`);
}

// ── MUST fire — AR ───────────────────────────────────────────────────────────
const POSITIVES_AR = [
  ['ما تبقى', []],
  ['ما تبقّى؟', []],                       // shadda + question mark — marks stripped before matching
  ['ماذا بقي للديسكتوب؟', ['desktop']],    // clitic لل stripped → ديسكتوب
  ['هل نحتاج تحديث الديسكتوب؟', ['desktop']],
  ['نحتاج تحديث الديسكتوب؟', ['desktop']],  // trailing ؟ instead of leading هل
  ['وين وصلنا', []],
  ['الوضع الحالي', []],
  ['ايش الباقي للموقع', ['web']],
];
for (const [p, expectFams] of POSITIVES_AR) {
  const r = splitQueryTokens(p);
  ok(r.strong === true, `AR strong: "${p}"`);
  ok(JSON.stringify(r.areaFamilies) === JSON.stringify(expectFams), `AR areaFamilies ${fams(p)} == ${JSON.stringify(expectFams)}: "${p}"`);
}

// ── must NOT fire (strong=false) — the 17 measured probes + task negatives ───
const NEGATIVES = [
  'update the README',
  'remaining items in the array',
  'do I need to update the lockfile after adding a dependency?',
  'should we bump zod to v4?',
  'should i push to origin or open a PR?',
  'what is now the correct import path for pdf.worker?',
  "what's now the default model in aiRouter?",
  'what todo items does eslint flag in App.tsx?',
  'what is the todo format for BRAIN markers?',
  'why does the cache return stale?',
  'is the snapshot test flaky or is the fixture stale?',
  'what do we need to do to enable CUDA?',
  'what do we need to do to enable CUDA in node-llama-cpp?',
  'what do I need to do to register a new IPC channel?',
  'are items missing from the list after the filter runs?',
  'is something missing in the Zod schema?',
  'is there anything missing from this PR?',
  'fix this: if (queue.length) flush(); // anything left in queue',
  'the reducer returns anything pending in the buffer — is that right',
  'update the desktop installer to 1.3.163',
  'remove the TODO: refactor App.tsx',
  'remove the TODO: refactor header logic in App.tsx',
  'ship the pending fix',
  'add a remaining-count badge to the header',
  'how does the sync status indicator work?',
  'should we cut the release branch from master or from the tag?',
  'is the modal still current when the theme flips?',
  // Arabic work statements / imperatives
  'لازم ننشر النسخة الجديدة',
  'حدّث ملف App.tsx',
  'أضف زر التحديث',
];
ok(NEGATIVES.length >= 20, `≥20 negatives locked (${NEGATIVES.length})`);
for (const p of NEGATIVES) ok(splitQueryTokens(p).strong === false, `not strong: "${p}"`);

// Loose statusShaped still returns for vocab-bearing imperatives — the hook uses
// it to suppress the git-diff file-token fallback (the side door that re-served
// the stale "remaining:" corpse). strong stays false.
{
  const a = splitQueryTokens('remove the TODO: refactor App.tsx');
  ok(a.statusShaped === true && a.strong === false && !a.content.includes('todo'), 'vocab imperative: statusShaped (quarantined) but not strong');
  const b = splitQueryTokens('ship the pending fix');
  ok(b.statusShaped === true && b.strong === false, 'vocab imperative #2: statusShaped, not strong');
  // A loose phrase that FAILS the residual rule is an ordinary coding question —
  // it must not even be statusShaped (1.84.0 behaviour preserved exactly).
  const c = splitQueryTokens('should we bump zod to v4?');
  ok(c.statusShaped === false && c.strong === false && c.content.includes('zod'), 'failed loose hit is NOT statusShaped (tokens untouched)');
  const d = splitQueryTokens('how does the sync status indicator work?');
  ok(d.content.includes('status'), "'status' stays a content token (not in STATUS_VOCAB)");
}

// ── residual rule unit ───────────────────────────────────────────────────────
ok(residualIsAreaOnly([]) === true, 'residual: empty is area-only (vacuous)');
ok(residualIsAreaOnly(['desk', 'ios', 'web']) === true, 'residual: pure aliases');
ok(residualIsAreaOnly(['the', 'remaining', 'desktop', 'or']) === true, 'residual: stopwords / vocab / <3-char tokens are ignored');
ok(residualIsAreaOnly(['lockfile']) === false, 'residual: one non-alias token breaks it');
ok(residualIsAreaOnly(['desktop', 'installer', 'lockfile']) === false, 'residual: aliases plus a non-alias is not area-only');
ok(residualIsAreaOnly(['للديسكتوب']) === true, 'residual: Arabic clitic-prefixed alias counts');

// ── area families: whole-token, never substring ──────────────────────────────
ok(areaFamiliesFromTokens(normTokens('approval scenarios dashboard keyboard webhook driver conversion prerequisite')).length === 0,
  'families: substring traps (approval/scenarios/dashboard/webhook/conversion) match nothing');
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('the app'))) === '["desktop"]', "families: 'app' alone → desktop");
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('the app store listing'))) === '["ios"]', "families: 'app' + 'store' → ios only");
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('appstore review'))) === '["ios"]', "families: 'appstore' ∉ desktop");
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('update the version'))) === '[]', "families: 'update'/'version' are not aliases");
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('is the canvas board current?'))) === '["canvas"]', 'families: canvas');
ok(JSON.stringify(areaFamiliesFromTokens(normTokens('سطح المكتب'))) === '["desktop"]', 'families: two-word Arabic alias matches as a bigram');
ok(stripArabicClitic('للديسكتوب') === 'ديسكتوب' && stripArabicClitic('الموقع') === 'موقع' && stripArabicClitic('ويب') === 'ويب',
  'clitic strip: لل/ال removed, a 3-letter word is never shortened');
ok(Object.keys(AREA_FAMILIES).join(',') === 'desktop,ios,web,canvas,brain,drive,release', 'AREA_FAMILIES order is stable');

// ── tokenizer: ASCII byte-identity on 30 prompts across the Unicode switch ──
{
  const OLD_STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'you', 'your', 'not', 'but', 'its', 'into', 'out', 'can', 'will', 'use', 'using', 'about', 'what', 'when', 'why', 'how', 'add', 'fix', 'make', 'need', 'want', 'let', 'see', 'get', 'got', 'now', 'all', 'any', 'via', 'per', 'etc', 'should', 'could', 'would', 'does', 'did', 'still', 'just', 'like', 'also', 'then', 'than', 'them', 'they']);
  const oldQueryTokens = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])].filter(t => !OLD_STOP.has(t));
  const PROMPTS = [
    'how does auth token rotation work?', 'wire the phone inbox drain routing paths', 'is off-cloud skill execution deferred or working?',
    'Did PR #440 merge?', 'fix the pdf.worker.min.mjs import in pdfjsBrowser.ts', 'node-llama-cpp CUDA build on windows 11',
    'refactor App.tsx into hooks', 'what changed in klypix-format.mjs since v1.84.0', 'ar en ui db js go ok — short tokens must stay out',
    'Electron 33 + React 19 + Vite 6 NSIS installer', 'brain_sync releaseIntent {version, ref}', 'why is the snapshot test flaky',
    'ENUM_WINDOWS vs GetForegroundWindow', 'AES-256-GCM encryption.ts syncBlob', 'x86_64-pc-windows-msvc target triple',
    'the 2,658-card brain takes 432 ms to parse', 'TODO: remove the legacy .any codec', 'localStorage["gemini_api_key"] read path',
    'git worktree remove follows junctions', 'canvas_connect_items SCOPE_ANCHOR_ID arrow', 'deep mode polls getAllOpenFiles every 4s',
    'ship 1.3.163 with the staged updater', 'pnpm vs npm ci in the gate worktree', 'RLS policy on usage_events', 'a b c dd ee fff ggg',
    'UPPERCASE Drive Letter E:\\tmp\\klypix', 'http://localhost:5173/?tab=canvas', 'email haraj100@example.com and phone +1-555-0100',
    'what is remaining for klypix?', 'remove the TODO: refactor header logic in App.tsx',
  ];
  ok(PROMPTS.length === 30, 'identity set has 30 prompts');
  let same = 0;
  for (const p of PROMPTS) {
    const a = JSON.stringify(oldQueryTokens(p)), b = JSON.stringify(queryTokens(p));
    if (a === b) same++; else console.log(`  drift: "${p}"\n    old ${a}\n    new ${b}`);
  }
  ok(same === PROMPTS.length, `queryTokens ASCII output byte-identical on ${same}/${PROMPTS.length} prompts`);
  // The only intended ASCII change: 'anything' is a stopword now.
  ok(!queryTokens('anything left for the desk').includes('anything'), "'anything' is a stopword");
  ok(queryTokens('ar en ui db js go ok').length === 0, 'two-letter tokens never emitted (min length stays 3)');
}

// ── Arabic: folding, tokens, no `\b` ─────────────────────────────────────────
ok(foldArabic('تبقّى') === 'تبقي' && foldArabic('أإآ') === 'ااا' && foldArabic('مكتبة') === 'مكتبه', 'fold: marks stripped, alef/ta-marbuta/alef-maqsura folded');
ok(foldArabic('plain ASCII 123 _-') === 'plain ASCII 123 _-', 'fold: ASCII is a fixed point');
ok(queryTokens('ما تبقّى للديسكتوب؟').join(',') === 'تبقي,للديسكتوب', 'tokens: Arabic words tokenize whole (؟ is a separator, marks gone)');
ok(STATUS_VOCAB.has('تبقي') && STATUS_VOCAB.has('متبقيه') && !STATUS_VOCAB.has('تبقى'), 'vocab stored in FOLDED spelling');
for (const [name, re] of Object.entries(STATUS_FAMILIES_AR)) {
  ok(!re.source.includes('\\b'), `AR regex ${name} carries no \\b`);
  ok(re.flags.includes('u'), `AR regex ${name} is a /u regex`);
}
ok(Object.keys(STATUS_FAMILIES_EN).join(',') === 'DO_NEED,IS_THERE,ANYTHING,WHAT_NOW,WHAT_TODOS,BEHIND,WHAT_NEED', 'the seven loose EN families are exported');
ok(!Object.values(STATUS_FAMILIES_EN).some(re => /missing/.test(re.source)), "'missing' is in no family");
ok(STATUS_FAMILIES_AR.NEED_AR.test(foldArabic('هل نحتاج تحديث الديسكتوب؟')) && !STATUS_FAMILIES_AR.NEED_AR.test(foldArabic('لازم ننشر النسخة الجديدة')),
  'NEED_AR requires هل or a trailing question mark');

// ── struct-level: areaHintsFromPrompt + scoped digest ────────────────────────
{
  const { struct } = await parseKlypix(await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'desktop', cards: [{ text: '❓ DESKCARD: installer silent relaunch check' }] },
      { title: 'iOS', cards: [{ text: '❓ IOSCARD: pairing survives account switch' }] },
      { title: 'Website', cards: [{ text: '❓ WEBCARD: viewer compaction notice' }] },
      { title: 'Brain', cards: [{ text: '❓ BRAINCARD: gardener skips orphan skills' }] },
      { title: 'Chat/Window', cards: [{ text: '❓ WINDOWCARD: overlay maximize bounds' }] },
      { title: 'Canvas UX ✅', cards: [{ text: '🏁 canvas: capsule auto-fit shipped' }] },
    ],
  }));
  const founder = 'do i need to update the desk ? ios ? or web ?';
  ok(JSON.stringify(areaHintsFromPrompt(struct, founder)) === '["desktop","iOS","Website"]', `hints: founder prompt → ${JSON.stringify(areaHintsFromPrompt(struct, founder))}`);
  ok(!areaHintsFromPrompt(struct, 'is the win build behind?').includes('Chat/Window'), "hints: 'win' does NOT resolve 'Chat/Window' (whole-token, not substring)");
  ok(JSON.stringify(areaHintsFromPrompt(struct, 'anything left on canvas')) === '["Canvas UX ✅"]', 'hints: decorated container title resolves through its tokens');
  ok(areaHintsFromPrompt(struct, 'what is remaining') === null, 'hints: no family named → null (unscoped)');
  ok(JSON.stringify(areaHintsFromPrompt(struct, "what's remaining for drive")) === '["drive"]', 'hints: family with no area on this brain → the hint token');
  ok(JSON.stringify(areaHintsFromPrompt(struct, 'ماذا بقي للديسكتوب؟')) === '["desktop"]', 'hints: Arabic clitic-prefixed alias resolves the desktop area');

  const areas = areaHintsFromPrompt(struct, founder);
  const md = statusContextToMarkdown(struct, { budgetChars: 5200, areas });
  ok(/_Scoped to: desktop, iOS, Website \(3 of 6 areas · 3 open\) — ask without an area name for the whole brain_/.test(md), 'scoped digest: scope line with counts');
  ok(/DESKCARD/.test(md) && /IOSCARD/.test(md) && /WEBCARD/.test(md), 'scoped digest: the three scoped opens render');
  ok(!/BRAINCARD/.test(md) && !/WINDOWCARD/.test(md), 'scoped digest: out-of-scope opens do NOT render');
  ok(/## Open \(3\)/.test(md), 'scoped digest: header counts scoped opens');
  const rows = areaStatusDigest(struct, { areas });
  ok(rows[0].startsWith('_Scoped to: ') && rows.filter(r => /^- /.test(r)).length === 3, 'areaStatusDigest: scope line first, then exactly the kept area rows');
  const dormant = { ...struct, cards: struct.cards.map(c => (c.area === 'iOS' || c.title === 'iOS') ? { ...c, createdAt: Date.now() - 400 * 86_400_000 } : c) };
  ok(areaStatusDigest(dormant, { areas: ['iOS'] }).some(r => /^- iOS — /.test(r)), 'areaStatusDigest: a NAMED area bypasses the dormancy cutoff');
  ok(!areaStatusDigest(dormant).some(r => /^- iOS — /.test(r)), 'areaStatusDigest: the same area is dormant when unscoped');
  const whole = statusContextToMarkdown(struct, { budgetChars: 5200 });
  ok(/## Open \(5\)/.test(whole) && !/Scoped to:/.test(whole) && !/No area matched/.test(whole), 'unscoped digest unchanged (no scope lines)');
  const miss = statusContextToMarkdown(struct, { areas: ['drive'] });
  ok(/_No area matched “drive”; showing the whole brain\._/.test(miss) && /## Open \(5\)/.test(miss), 'zero-match: says so and renders the whole brain');
  const r = rankForQuestion(struct, founder);
  ok(r.statusStrong === true && JSON.stringify(r.areas) === '["desktop","iOS","Website"]' && JSON.stringify(r.areaFamilies) === '["desktop","ios","web"]',
    'rankForQuestion returns statusStrong + areaFamilies + resolved areas');
  ok(rankForQuestion(struct, 'how does the gardener work').areas === null, 'rankForQuestion: non-status question → areas null');
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ status-shape: all assertions passed');
process.exit(failures ? 1 : 0);
