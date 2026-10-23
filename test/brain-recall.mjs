// brain-recall — what the brain records stays usable, and the lessons that name
// a task's files reach the session working on them (1.107).
//   • the writer keeps a token longer than a card line whole; readers rejoin
//     the forced breaks of cards written before (unwrapCardText);
//   • a `rule:` suffix (on a 🧠 marker, or at the end of brain_note's text)
//     records a rule-ready lesson as a visible `⚙ rule candidate:` line,
//     checked against the checkout first and never active by itself;
//   • lessonsForFiles ranks lessons by how closely they name a file, and
//     brain_sync and the SessionStart brief put them first;
//   • brain_rules reads a rule candidate before it routes the prose;
//   • scratch, memory, tmp and worktree-root paths never become card tags, and
//     a commit card is not re-glyphed 🛠️.
// Every fixture is synthetic. Run: node test/brain-recall.mjs (exit 0 = pass).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-recall-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
// Sandbox BEFORE the engine is imported: os.homedir() and git read these.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const GIT_GLOBAL = path.join(TMP, 'gitconfig');
fs.writeFileSync(GIT_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = GIT_GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const {
  buildKlypixMap, captureIntoBrain, parseKlypix, unwrapCardText, lessonsForFiles, parseRuleSpec, parseRuleCandidate,
  checkRuleSpec, parseMarkerSuffixText, structToUltraBrief, RULE_CANDIDATE_PREFIX,
} = await import('../src/klypix-format.mjs');
const { opBrainTaskContext, opBrainNote } = await import('../src/klypix-core.mjs');
const { proposeFromCards } = await import('../src/brain-rules.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const live = (struct) => struct.cards.filter((c) => c.type !== 'container' && !/^archive$/i.test(c.area || ''));
// The wrap every writer used before 1.107: an over-long token is cut at the width.
const legacyWrap = (text, cpl = 37) => {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para.length <= cpl) { out.push(para); continue; }
    let line = '';
    for (const tok of para.split(/(\s+)/)) {
      if (line && (line + tok).trimEnd().length > cpl) { out.push(line.trimEnd()); line = tok.replace(/^\s+/, ''); }
      else line += tok;
      while (line.length > cpl) { out.push(line.slice(0, cpl)); line = line.slice(cpl); }
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out.join('\n');
};
let clock = Date.parse('2026-09-01T00:00:00Z');
const L = (id, text, extra = {}) => ({ id, type: 'text', area: 'Lessons', text, createdAt: (clock += 1000), ...extra });
const CHECKOUT = 'web/tests/checkoutForm.test.ts';

// ── 1. Writer and reader ─────────────────────────────────────────────────────
{
  const longPath = 'src/features/notifications/preferencesPanelRenderer.ts';
  const rule = `${RULE_CANDIDATE_PREFIX} web/tests/**/*.test.ts never "from '@/"`;
  const seed = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Seed', cards: [{ text: 'Seed: the fixture brain' }] }] });
  const { buffer: buf } = await captureIntoBrain(seed, { cards: [
    { area: 'Canvas', text: `Canvas: 🛠️ Never edit ${longPath} by hand — the build writes it`, createdVia: 'test' },
    { area: 'Web', text: `Web: 🛠️ Web tests import relatively\n${rule}`, createdVia: 'test' },
  ] });
  const { struct } = await parseKlypix(buf);
  const [pathCard, ruleCard] = [/preferencesPanelRenderer/, /Web tests/].map((re) => live(struct).find((c) => re.test(c.text)));
  const lines = pathCard.text.split('\n');
  ok(lines.includes(longPath) && !lines.some((l) => l.length === 37 && !/\s/.test(l)),
    'writer: a token longer than a card line stays whole on its own line — no forced break');
  ok(ruleCard.text.split('\n').includes(rule), 'writer: a ⚙ rule candidate line is never wrapped');
  ok(ruleCard.ruleDraft?.kind === 'never' && ruleCard.ruleDraft.literal === "from '@/" && ruleCard.ruleDraft.files[0] === 'web/tests/**/*.test.ts',
    'parseKlypix reads the rule candidate back as card.ruleDraft');

  const legacy = legacyWrap(`Canvas: 🛠️ Never edit ${longPath} by hand — the build writes it\n#canvas`);
  ok(legacy.split('\n').some((l) => l.length === 37 && !/\s/.test(l)) && !legacy.includes(longPath), '(setup) the legacy wrap cut the path');
  const rejoined = unwrapCardText(legacy);
  ok(rejoined.includes(longPath) && rejoined.split('\n').pop() === '#canvas', 'unwrapCardText rejoins a forced break and leaves the tag line alone');
  const word37 = 'x'.repeat(37);
  ok(unwrapCardText(`Notes: see\n${word37}\n#notes`) === `Notes: see\n${word37}\n#notes`
    && unwrapCardText(`${word37}\n(~ amended 2026-09-01: moved)`) === `${word37}\n(~ amended 2026-09-01: moved)`,
  'unwrapCardText never joins a 37-character line to a tag line or an amendment line');
  const found = lessonsForFiles({ cards: [L('txt_legacy', legacy)] }, [longPath]);
  ok(found[0]?.tier === 'exact', 'a lesson stored with a cut path is found by that path (exact)');
}

// ── 2. Rule specs ────────────────────────────────────────────────────────────
{
  const never = parseRuleSpec(`web/tests/**/*.test.ts never "from '@/"`);
  const re = parseRuleSpec('src/**/*.ts never /console\\.log\\(/i');
  const must = parseRuleSpec('docs/**/*.md must "title:"');
  const listed = parseRuleSpec('app/pages/*.tsx listed-in src/routes.ts, src/nav.ts');
  ok(never?.kind === 'never' && never.literal === "from '@/" && never.files.join() === 'web/tests/**/*.test.ts', 'parseRuleSpec: never "<literal>"');
  ok(re?.kind === 'never' && re.pattern === 'console\\.log\\(' && re.flags === 'i', 'parseRuleSpec: never /<regex>/flags');
  ok(must?.kind === 'must' && must.literal === 'title:', 'parseRuleSpec: must "<literal>"');
  ok(listed?.kind === 'listed-in' && listed.registry.join() === 'src/routes.ts,src/nav.ts', 'parseRuleSpec: listed-in <file>[,<file>]');
  ok(parseRuleSpec('scripts/*.ps1 keep-eol')?.kind === 'keep-eol' && parseRuleSpec('.github/workflows/*.yml costly')?.kind === 'costly', 'parseRuleSpec: keep-eol and costly');
  ok(parseRuleSpec('never use var') === null && parseRuleSpec('foo never "x"') === null && parseRuleSpec('https://x.io/a never "x"') === null,
    'parseRuleSpec: prose, a word that is not a path and a URL are not rules');
  ok(parseRuleCandidate(`Lesson\n${RULE_CANDIDATE_PREFIX} scripts/*.ps1 keep-eol`)?.kind === 'keep-eol', 'parseRuleCandidate reads the ⚙ line of a card');

  const tracked = [CHECKOUT, 'app/pages/home.tsx', 'src/routes.ts', 'packages/web/src/api/client.ts', 'scripts/release.ps1'];
  ok(checkRuleSpec(`web/tests/**/*.test.ts never "from '@/"`, tracked).ok, 'checkRuleSpec: a glob that names tracked files passes');
  ok(checkRuleSpec('*.test.ts never "only("', tracked).ok, 'checkRuleSpec: a glob without a slash matches file names');
  ok(checkRuleSpec('src/api/*.ts never "fetch("', tracked).ok, 'checkRuleSpec: a glob may be relative to a sub-package');
  const miss = checkRuleSpec('lib/legacy/**/*.js never "var "', tracked);
  ok(!miss.ok && /names no tracked file/.test(miss.reason), `checkRuleSpec: a glob that names nothing is refused (${miss.reason})`);
  const badRe = checkRuleSpec('src/**/*.ts never /(unclosed/', tracked);
  ok(!badRe.ok && /does not compile/.test(badRe.reason), 'checkRuleSpec: a /regex/ that does not compile is refused');
  const noList = checkRuleSpec('app/pages/*.tsx listed-in src/nav.ts', tracked);
  ok(!noList.ok && /src\/nav\.ts is not tracked/.test(noList.reason), 'checkRuleSpec: a listed-in file that is not tracked is refused');
  ok(checkRuleSpec('lib/legacy/**/*.js never "var "', null).ok, 'checkRuleSpec: without git only the shape is checked');
}

// ── 3. The `rule:` suffix in the marker grammar ──────────────────────────────
{
  const p = parseMarkerSuffixText(`Web tests import relatively rule: web/tests/**/*.test.ts never "from '@/"`);
  ok(p.rule === `web/tests/**/*.test.ts never "from '@/"` && p.body === 'Web tests import relatively', 'a rule: suffix is parsed off the body');
  ok(!parseMarkerSuffixText('Lint rule: never use var in new code').rule && !parseMarkerSuffixText('we adopted a new rule: never merge on Fridays').rule,
    'a prose "rule:" stays text');
  const both = parseMarkerSuffixText('Release scripts keep CRLF rule: scripts/*.ps1 keep-eol verify: npm test');
  ok(both.rule === 'scripts/*.ps1 keep-eol' && both.verify === 'npm test' && both.body === 'Release scripts keep CRLF', 'a rule: rides beside another suffix');
}

// ── 4. lessonsForFiles ───────────────────────────────────────────────────────
{
  const tiers = { cards: [
    L('txt_folder', 'Web: 🛠️ Everything in web/tests/ runs in the root test runner — keep it fast.'),
    L('txt_glob', 'Web: 🛠️ Tests under web/tests/*.test.ts must not reach the network.'),
    L('txt_name', 'Web: 🛠️ checkoutForm.test.ts must mock the payment RPC.'),
    L('txt_exact', `Web: 🛠️ ${CHECKOUT} must import relatively — the root test runner has no alias.`),
    L('txt_other', 'Billing: 🛠️ src/billing/charge.ts must round to cents.'),
  ] };
  const r = lessonsForFiles(tiers, [CHECKOUT]);
  ok(r.map((x) => x.card.id).join() === 'txt_exact,txt_name,txt_glob,txt_folder' && r.map((x) => x.tier).join() === 'exact,name,glob,folder',
    `ranked exact > file name > glob > folder (${r.map((x) => x.tier).join(' > ')})`);
  ok(r[0].file === CHECKOUT && r[0].via === CHECKOUT, 'a result names the declared file and the mention that matched it');
  ok(lessonsForFiles(tiers, [CHECKOUT], { limit: 2 }).length === 2, 'limit caps the list');
  ok(lessonsForFiles({ cards: [L('txt_page', 'Web: 🛠️ page.tsx files must export metadata.')] }, ['app/settings/page.tsx']).length === 0,
    "a framework's stock file name (page.tsx) does not match by name alone");
  const twins = lessonsForFiles({ cards: [
    L('txt_twin', 'Build: 🛠️ scripts/release.ps1 must keep CRLF.'),
    L('txt_twin__agconf_ab12', 'Build: 🛠️ scripts/release.ps1 must keep CRLF line endings.'),
  ] }, ['scripts/release.ps1']);
  ok(twins.length === 1, 'a merge-conflict twin (__agconf_) is the same lesson once');
  const weak = lessonsForFiles({ cards: [
    L('txt_ship1', 'Release: 🏁 Shipped 1.4 — touched scripts/release.ps1 and docs/notes.md. Gotcha: tags must be pushed before the release.'),
    L('txt_ship2', 'Release: 🏁 Shipped 1.5 — touched scripts/release.ps1 again. Gotcha: the changelog must be dated.'),
    L('txt_rule', 'Build: 🛠️ scripts/release.ps1 must keep CRLF line endings.'),
  ] }, ['scripts/release.ps1']);
  ok(weak[0]?.card.id === 'txt_rule' && weak.filter((x) => x.card.id.startsWith('txt_ship')).length === 1 && weak[1]?.tier === 'exact',
    'a path a milestone mentions in passing ranks like a tag: below the lesson, at most one shown');
  const dump = L('txt_dump', `Status: changed ${Array.from({ length: 12 }, (_, i) => `src/mod${i}/file${i}.ts`).join(', ')}. Next step: avoid regressions.`);
  ok(lessonsForFiles({ cards: [dump] }, ['src/mod3/file3.ts']).length === 0, 'a status card that names more than ten paths is not a lesson about each');
  const rc = lessonsForFiles({ cards: [L('txt_rc', `Web: Web tests import relatively\n${RULE_CANDIDATE_PREFIX} web/tests/**/*.test.ts never "from '@/"`)] }, [CHECKOUT]);
  ok(rc[0]?.tier === 'glob' && rc[0].via === 'web/tests/**/*.test.ts', 'a rule candidate is a lesson about the files its globs name');
  const tags = lessonsForFiles({ cards: [
    L('txt_tag_ship', 'Web: 🏁 Checkout flow shipped; the checkout tests must stay green\n#web #file-checkoutform-test'),
    L('txt_tag_skill', 'Web: 🛠️ Checkout tests must reset the clock between cases\n#web #file-checkoutform-test'),
  ] }, [CHECKOUT]);
  ok(tags.length === 1 && tags[0].card.id === 'txt_tag_skill' && tags[0].tier === 'tag', 'a #file- tag counts on a 🛠️ lesson, not on a milestone');
  ok(lessonsForFiles({ cards: [
    L('txt_q', `Web: ❓ Should ${CHECKOUT} mock the RPC? It must be decided.`),
    L('txt_done', `Web: ✅ ${CHECKOUT} must import relatively — done`),
    L('txt_arch', `Web: 🛠️ ${CHECKOUT} must import relatively`, { area: 'Archive' }),
  ] }, [CHECKOUT]).length === 0, 'an open question, a resolved card and an archived card are not lessons');
  ok(lessonsForFiles({ cards: [L('txt_x', 'Payments: 🛠️ checkout must use the hosted page')] }, [CHECKOUT]).length === 0, 'a lesson that names no file is never matched');
}

// ── 5. brain_sync capsule: "Lessons for your files" ──────────────────────────
{
  const proj = path.join(TMP, 'capsule');
  fs.mkdirSync(proj, { recursive: true });
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [
    { title: 'Web', cards: [{ text: `Web: 🛠️ ${CHECKOUT} must import relatively — the root test runner has no alias.` }] },
    { title: 'Routes', cards: [{ text: `Routes: New pages are registered in the route table\n${RULE_CANDIDATE_PREFIX} app/pages/*.tsx listed-in src/routes.ts` }] },
    { title: 'Canvas', cards: [{ text: 'Canvas: 🛠️ Never call layout() inside a render loop.' }] },
    { title: 'Payments', cards: [{ text: 'Payments: Checkout uses the hosted page.' }] },
  ] }));
  const res = await opBrainTaskContext({ vault: proj, canvas: brain, intent: 'fix the checkout test imports and add a billing page', files: [CHECKOUT, 'app/pages/billing.tsx'] });
  const out = res.blocks.map((b) => b.text || '').join('\n');
  const lessons = res.context.fileLessons || [];
  ok(/### 📂 Lessons for your files \(2\)/.test(out) && out.indexOf('📂 Lessons for your files') < out.indexOf('🛠️ Standing rules'),
    'brain_sync shows "Lessons for your files" ahead of the standing rules and the hits');
  ok(out.includes(`(for ${CHECKOUT} · names \`${CHECKOUT}\`)`), 'each lesson says which declared file it is for and what it names');
  const exact = lessons.find((l) => l.match === 'exact');
  const route = lessons.find((l) => l.match === 'glob');
  ok(Boolean(exact) && Boolean(route) && route.ruleCandidate === 'app/pages/*.tsx listed-in src/routes.ts' && route.file === 'app/pages/billing.tsx',
    'context.fileLessons carries the match, the file and the rule candidate');
  const elsewhere = [...(res.context.hits || []), ...(res.context.standingRules || [])].map((h) => h.id);
  ok(!lessons.some((l) => elsewhere.includes(l.id)), 'a lesson shown for the files is not repeated among the hits or standing rules');
  ok(res.context.sufficient === true, 'lessons for the files count as sufficient context');
}

// ── 6. SessionStart brief: lessons for the changed files lead ───────────────
{
  const buf = await buildKlypixMap({ title: 'brain', areas: [{ title: 'Skills', cards: [
    { text: 'Parser: 🛠️ src/legacy/oldParser.ts must keep its CRLF fixtures' },
    ...Array.from({ length: 6 }, (_, i) => ({ text: `Area${i}: 🛠️ Rule number ${i} must hold for module${i}` })),
  ] }] });
  const { struct } = await parseKlypix(buf);
  for (const c of struct.cards) c.createdAt = /oldParser/.test(c.text || '') ? 1 : Date.parse('2026-09-10') + Number((/Rule number (\d)/.exec(c.text || '') || [0, 0])[1]);
  const plain = structToUltraBrief(struct, {});
  const focused = structToUltraBrief(struct, { focusFiles: ['src/legacy/oldParser.ts'] });
  ok(/Standing rules \(7 — newest first/.test(plain) && !plain.includes('oldParser'), 'without changed files the brief lists the newest standing rules');
  const ruleLines = focused.split('\n').filter((l) => /^- /.test(l));
  ok(/Standing rules \(7 — for the files you are changing first, then newest/.test(focused) && /oldParser/.test(ruleLines[0] || ''),
    'with changed files the lesson that names one leads the standing rules');
}

// ── 7. brain_rules: rule candidates first, prose routing ─────────────────────
{
  const cards = [
    L('txt_r1', `Web: 🛠️ Web tests import relatively\n${RULE_CANDIDATE_PREFIX} web/tests/**/*.test.ts never "console.log("`, { ruleDraft: parseRuleSpec('web/tests/**/*.test.ts never "console.log("') }),
    L('txt_r2', `Routes: 🛠️ New pages are registered\n${RULE_CANDIDATE_PREFIX} app/pages/*.tsx listed-in src/routes.ts`, { ruleDraft: parseRuleSpec('app/pages/*.tsx listed-in src/routes.ts') }),
    L('txt_r3', `Docs: 🛠️ Guides carry a title\n${RULE_CANDIDATE_PREFIX} docs/**/*.md must "title:"`, { ruleDraft: parseRuleSpec('docs/**/*.md must "title:"') }),
    L('txt_r4', `Build: 🛠️ Release scripts keep CRLF\n${RULE_CANDIDATE_PREFIX} scripts/*.ps1 keep-eol`, { ruleDraft: parseRuleSpec('scripts/*.ps1 keep-eol') }),
    L('txt_r5', `CI: 🛠️ Workflow edits run the full matrix\n${RULE_CANDIDATE_PREFIX} .github/workflows/*.yml costly`, { ruleDraft: parseRuleSpec('.github/workflows/*.yml costly') }),
  ];
  const byCard = new Map(proposeFromCards(cards).proposals.map((p) => [p.card, p]));
  const r1 = byCard.get('txt_r1');
  ok(r1?.route === 'rule' && r1.draft.kind === 'forbid-pattern' && r1.draft.pattern === 'console\\.log\\(' && r1.draft.files[0] === 'web/tests/**/*.test.ts'
    && /recorded rule-ready/.test(r1.reason), 'a never "…" candidate becomes a forbid-pattern draft with the literal escaped');
  const r2 = byCard.get('txt_r2');
  ok(r2?.route === 'rule' && r2.draft.kind === 'listed-in' && r2.draft.registry.join() === 'src/routes.ts' && r2.draft.needle === '{basename}', 'a listed-in candidate becomes a listed-in draft');
  ok(byCard.get('txt_r3')?.route === 'instruction' && !byCard.get('txt_r3').draft, 'a must "…" candidate stays an instruction (no rule kind checks it yet)');
  ok(byCard.get('txt_r4')?.draft?.kind === 'preserve-eol' && byCard.get('txt_r5')?.draft?.kind === 'cloud-required' && byCard.get('txt_r5').draft.severity === 'advise',
    'keep-eol and costly become preserve-eol and cloud-required (advise)');

  const cut = legacyWrap('Nav: 🛠️ A new settings page must also be added to `src/navigation/settingsSectionRegistry.ts` or it never shows.');
  ok(!cut.includes('src/navigation/settingsSectionRegistry.ts'), '(setup) the legacy wrap cut the registry path');
  const prose = proposeFromCards([
    L('txt_cut', cut),
    L('txt_decode', 'Perf: 🛠️ Never synchronously decode `atob(` on the UI thread — chunk it.'),
    L('txt_mustnot', 'Web: 🛠️ Web tests must not import `@/lib/supabase` — the root test runner has no alias.'),
    L('txt_shell', 'Git: 🛠️ Never use `git push --force` on the shared checkout.'),
  ]).proposals;
  const by = new Map(prose.map((p) => [p.card, p]));
  ok(by.get('txt_cut')?.route === 'rule' && by.get('txt_cut').draft.registry.includes('src/navigation/settingsSectionRegistry.ts'),
    'a path cut by a forced break is rejoined before routing (listed-in registry is whole)');
  ok(by.get('txt_decode')?.draft?.kind === 'forbid-pattern' && by.get('txt_decode').draft.pattern === 'atob\\(', '"never <adverb> decode `…`" routes to forbid-pattern');
  ok(by.get('txt_mustnot')?.draft?.kind === 'forbid-pattern' && by.get('txt_mustnot').draft.pattern === '@/lib/supabase', '"must not import `…`" routes to forbid-pattern');
  ok(by.get('txt_shell')?.route !== 'rule', 'a shell command is never drafted as a pattern to forbid in source files');
}

// ── 8. brain_note: the rule rides the text ───────────────────────────────────
{
  const proj = path.join(TMP, 'note');
  fs.mkdirSync(proj, { recursive: true });
  git(proj, 'init', '-q');
  for (const f of [CHECKOUT, 'app/pages/home.tsx', 'src/routes.ts']) write(proj, f, 'export {};\n');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', 'fixture');
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Seed', cards: [{ text: 'Seed: the fixture brain' }] }] }));
  const note = (args) => opBrainNote({ vault: proj, canvas: brain, via: 'test', ...args });
  const cards = async () => live((await parseKlypix(fs.readFileSync(brain))).struct);

  const a = await note({ text: `Web tests import relatively; the root test runner has no alias rule: web/tests/**/*.test.ts never "from '@/"`, area: 'Web' });
  const admin = (await cards()).find((c) => /Web tests import relatively/.test(flat(c.text)));
  ok(!a.isError && Boolean(admin) && /🛠️/.test(admin.text) && admin.text.split('\n').includes(`${RULE_CANDIDATE_PREFIX} web/tests/**/*.test.ts never "from '@/"`)
    && !/ rule: /.test(flat(admin.text)) && admin.ruleDraft?.kind === 'never',
  'brain_note: a rule: suffix at the end of the text lands as the ⚙ line of a 🛠️ lesson');
  const b = await note({ text: 'Guide pages carry a front-matter title rule: docs/guides/*.md must "title:"', area: 'Docs' });
  ok(b.isError && /Invalid rule: .*names no tracked file/.test(flat(b.blocks?.[0]?.text)), 'brain_note: a rule whose glob names no tracked file is refused, loudly');
  const c = await note({ text: `Web tests import relatively rule: web/tests/**/*.test.ts never "from '@/"`, marker: '~', area: 'Web' });
  ok(c.isError && /rule rides a new lesson card/.test(flat(c.blocks?.[0]?.text)), 'brain_note: a rule on a ~ update is refused');
  const d = await note({ text: 'New pages must be registered in the route table', rule: 'app/pages/*.tsx listed-in src/routes.ts', area: 'Routes' });
  const routes = (await cards()).find((c2) => /New pages must be registered/.test(flat(c2.text)));
  ok(!d.isError && routes?.ruleDraft?.kind === 'listed-in', 'opBrainNote: the rule parameter (the internal API) still records a candidate');
  const e = await note({ text: 'Team rule: never merge on Fridays', area: 'Process' });
  const proc = (await cards()).find((c2) => /never merge on Fridays/.test(flat(c2.text)));
  ok(!e.isError && Boolean(proc) && !proc.ruleDraft && flat(proc.text).includes('Team rule: never merge on Fridays'), 'brain_note: a prose "rule:" stays the note');
}

// ── 9. The Stop hook end to end ──────────────────────────────────────────────
{
  const proj = path.join(TMP, 'hook');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.claude', 'project-brain'), { recursive: true });
  git(proj, 'init', '-q');
  for (const f of [CHECKOUT, 'app/pages/home.tsx', 'src/routes.ts', 'src/widgets/rangeSlider.ts', 'src/legacy/oldParser.ts']) write(proj, f, 'export {};\n');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', 'fixture');
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [
    { title: 'Seed', cards: [{ text: 'Seed: the fixture brain' }] },
    { title: 'Parser', cards: [{ text: 'Parser: 🛠️ src/legacy/oldParser.ts must keep its CRLF fixtures' }] },
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Area${i}`, cards: [{ text: `Area${i}: 🛠️ Rule number ${i} must hold for module${i}` }] })),
  ] }));
  const env = { ...process.env, HOME, USERPROFILE: HOME, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_AUTO_UPDATE: '0' };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const runHook = (args, input) => execFileSync(process.execPath, [HOOK, ...args], {
    cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const edit = (file) => ({ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2, 8)}`, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } });
  const markers = [
    `🧠 BRAIN [Web] +: Web tests import relatively; the root test runner has no alias rule: web/tests/**/*.test.ts never "from '@/"`,
    '🧠 BRAIN [Routes]: New pages are registered in the route table rule: app/pages/*.tsx listed-in src/routes.ts',
    '🧠 BRAIN [Docs] +: Guide pages carry a front-matter title rule: docs/guides/*.md must "title:"',
    '🧠 BRAIN [Widgets] ?: Should range sliders snap to whole steps rule: src/widgets/*.ts never "Math.round("',
  ];
  // The prompt hook records where this turn starts; the Stop hook tags a card
  // with the files edited after it.
  const tp = path.join(HOME, 't-recall.jsonl');
  fs.writeFileSync(tp, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'tidy the web tests and the routes' } })}\n`);
  runHook(['--prompt'], { session_id: 'recall-e2e', prompt: 'tidy the web tests and the routes', transcript_path: tp });
  fs.appendFileSync(tp, [
    { type: 'assistant', message: { role: 'assistant', content: [
      edit(path.join(proj, '.claude', 'worktrees', 'agent-1', 'src', 'widgets', 'rangeSlider.ts')),
      edit(path.join(proj, '.worktrees', 'ci-cost', 'package.json')),
      edit(path.join(os.tmpdir(), 'klypix-recall-scratch', 'notes.md')),
      edit(path.join(HOME, '.claude', 'projects', 'p', 'memory', 'MEMORY.md')),
      edit(path.join(path.parse(TMP).root, 'klypix-recall-none', 'tmp', 'commitmsg.txt')),
      edit(path.join(proj, '.claude', 'brain-capture-state.json')),
    ] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n\n${markers.join('\n')}` }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  try { runHook(['--capture'], { session_id: 'recall-e2e', transcript_path: tp }); }
  catch (e) { ok(false, `the Stop hook exits 0 (${e.status}: ${String(e.stderr || '').slice(0, 200)})`); }
  const { struct } = await parseKlypix(fs.readFileSync(brain));
  const find = (re) => live(struct).find((c) => re.test(flat(c.text)));
  const admin = find(/^Web: 🛠️ Web tests import relatively; the root test runner has no alias/);
  ok(Boolean(admin) && admin.text.split('\n').includes(`${RULE_CANDIDATE_PREFIX} web/tests/**/*.test.ts never "from '@/"`) && admin.ruleDraft?.kind === 'never'
    && !/alias rule:/.test(flat(admin.text)), 'hook: a + marker with rule: lands with its ⚙ rule candidate line, the suffix off the body');
  const routes = find(/^Routes: 🛠️ New pages are registered in the route table/);
  ok(routes?.ruleDraft?.kind === 'listed-in', 'hook: a plain decision with a valid rule: is recorded as a 🛠️ lesson');
  const docs = find(/^Docs: 🛠️ Guide pages carry a front-matter title/);
  ok(Boolean(docs) && !docs.ruleDraft && !docs.text.includes(RULE_CANDIDATE_PREFIX), 'hook: a rule naming no tracked file is not recorded, the lesson is');
  const question = find(/Should range sliders snap to whole steps/);
  ok(Boolean(question) && !question.ruleDraft, 'hook: a rule: on a ? question is not recorded');
  const ledger = fs.readFileSync(path.join(proj, '.claude', 'brain-capture-log.jsonl'), 'utf8');
  ok((ledger.match(/"rule-not-recorded"/g) || []).length === 2, 'hook: the ledger records both refused rules');
  const prompt = runHook(['--prompt'], { session_id: 'recall-e2e', prompt: 'ok, continue' });
  ok(/rule: not recorded on the 🧠 BRAIN \[Docs\] \+ marker/.test(prompt) && /names no tracked file/.test(prompt)
    && /rule: not recorded on the 🧠 BRAIN \[Widgets\] \? marker/.test(prompt) && /rides a new lesson card/.test(prompt),
  'hook: the author is told, on the next prompt, which rule: was not recorded and why');

  const tagLine = flat(admin?.text).slice(Math.max(0, flat(admin?.text).indexOf('#web')));
  ok(/#file-rangeslider/.test(tagLine) && /#dir-widgets/.test(tagLine) && /#file-package/.test(tagLine),
    `hook: work inside a worktree is tagged as the path inside it (${tagLine})`);
  ok(!/#dir-agent-1|#dir-ci-cost|#file-notes|#dir-klypix-recall-scratch|#file-memory|#dir-memory|#file-commitmsg|#dir-tmp|#file-brain-capture-state/.test(tagLine),
    'hook: scratch, memory, tmp, project .claude and worktree-root paths never become tags');

  // A commit whose subject reads like a rule stays a commit card.
  write(proj, 'src/routes.ts', 'export const routes = [];\n');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', 'fix(config): never read the settings file before the loader finishes', '-m', 'Reading it early returned the defaults and dropped what the person had saved.');
  const tp2 = path.join(HOME, 't-recall-2.jsonl');
  fs.writeFileSync(tp2, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'commit it' } })}\n`);
  try { runHook(['--capture'], { session_id: 'recall-e2e-2', transcript_path: tp2 }); }
  catch (e) { ok(false, `the second Stop exits 0 (${e.status})`); }
  const after = live((await parseKlypix(fs.readFileSync(brain))).struct);
  const commitCard = after.find((c) => /never read the settings file before the loader finishes/.test(flat(c.text)));
  ok(Boolean(commitCard) && !/🛠/.test(commitCard.text), 'hook: a commit card is not re-glyphed 🛠️ when its subject reads like a rule');

  // SessionStart: the standing rules lead with the lesson naming a changed file.
  write(proj, 'src/legacy/oldParser.ts', 'export const parse = () => 1;\n');
  const start = runHook([], { session_id: 'recall-start', source: 'startup' });
  // Changed files = uncommitted (oldParser.ts) + the last commits (routes.ts):
  // both lessons that name them come before the newest unrelated rule.
  const standing = start.slice(start.indexOf('## 🛠️ Standing rules')).split('\n').filter((l) => /^- /.test(l));
  const at = (re) => standing.findIndex((l) => re.test(l));
  ok(/for the files you are changing first, then newest/.test(start) && at(/oldParser/) >= 0 && at(/New pages are registered/) >= 0
    && at(/Rule number/) > Math.max(at(/oldParser/), at(/New pages are registered/)),
  `SessionStart: lessons that name a changed file lead the standing rules (${standing.length} lines)`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ brain-recall: all assertions passed');
process.exit(failures ? 1 : 0);
