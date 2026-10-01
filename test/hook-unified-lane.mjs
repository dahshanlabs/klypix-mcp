// The unified per-prompt recall lanes (1.87) — the measured "unified balanced"
// policy ported from the 2026-09-28 bench (dev/held-out split of real founder
// prompts) into engine primitives. Locks:
//
//   W*  rankHookWords — BM25-idf rarity ranking over live cards, title/tag
//       boost, evidence bar in rare-title-word units, specificity term.
//   M*  rankHookFused — cosine + rarity fusion over the warm vector cache,
//       identical-text collapse (newest copy stands for the group), twin
//       vector reachability, show bar.
//   R*  routing + bars: the four HOOK_* constants ARE the policy; the hook and
//       the harness read them from the engine and never restate them; the
//       model gate counts the asker's own content tokens only.
//   C*  disk index cache: the content fingerprint refuses a doc built from a
//       DIFFERENT card set (TOCTOU with a racing capture; same-mtime+size
//       swaps), and an honest seed is behaviour-neutral.
//   E*  end-to-end through the real hook: words-lane recall, thin-evidence
//       silence, no-model degradation, and the lane/evidence health row the
//       bars get re-fitted from (human decisions only — machine turns write
//       no row).
//
// Run:  node test/hook-unified-lane.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
    rankHookWords, rankHookFused, splitQueryTokens, buildKlypixMap,
    hookIndexCacheDoc, seedHookIndexCache, hookIndexFingerprint,
    HOOK_WORDS_BAR, HOOK_MODEL_MIN_TOKENS, HOOK_FUSED_SHOW_BAR, HOOK_FUSED_IDF_WEIGHT,
} from '../src/klypix-format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'src', 'global-brain-hook.mjs');
const hookSrc = fs.readFileSync(HOOK, 'utf8').replace(/\r/g, '');
const harnessSrc = fs.readFileSync(path.join(here, '..', 'scripts', 'eval-hook-lane.mjs'), 'utf8').replace(/\r/g, '');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// Plain structs are enough for the pure lanes (the rankers read struct.cards).
let nextId = 0;
const card = (text, extra = {}) => ({ id: `c${nextId++}`, type: 'text', text, title: '', tags: [], area: 'Work', createdAt: 1000, ...extra });
const struct = (...cards) => ({ cards });
// A fake semantic bundle: unit query vector + per-card unit vectors, so dot()
// returns exactly the cosine we planted.
const semOf = (pairs) => ({ qv: [1], vecsMap: new Map(pairs), dot: (a, b) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; } });

// ── R: the bars are the measured policy, exported once ───────────────────────
ok(HOOK_WORDS_BAR === 1.8, `R1: HOOK_WORDS_BAR is the measured 1.8 (${HOOK_WORDS_BAR})`);
ok(HOOK_MODEL_MIN_TOKENS === 6, `R1: HOOK_MODEL_MIN_TOKENS is the measured 6 (${HOOK_MODEL_MIN_TOKENS})`);
ok(HOOK_FUSED_SHOW_BAR === 0.65, `R1: HOOK_FUSED_SHOW_BAR is the measured 0.65 (${HOOK_FUSED_SHOW_BAR})`);
ok(HOOK_FUSED_IDF_WEIGHT === 0.006, `R1: HOOK_FUSED_IDF_WEIGHT is the measured 0.006 (${HOOK_FUSED_IDF_WEIGHT})`);

// ── W1: idf weighting beats a flat hit count ─────────────────────────────────
{
    // 'canvas' is on every card; 'quaternion' on one. A card matching the one
    // rare word must outrank a card matching the common word several times.
    const common = Array.from({ length: 10 }, (_, i) => card(`canvas note ${i}: the canvas canvas layer again`));
    const rare = card('quaternion interpolation chosen for the gizmo');
    const s = struct(...common, rare);
    const r = rankHookWords(s, ['canvas', 'quaternion']);
    ok(r.hits.length > 0 && r.hits[0].card.id === rare.id, `W1: the rare-word card ranks first (got ${r.hits[0]?.card.id}, want ${rare.id})`);
}

// ── W2: title and tag hits outweigh body hits ────────────────────────────────
{
    const inTitle = card('body about other things entirely', { title: 'gizmo rotation design' });
    const inBody = card('the gizmo appears once in this body text here');
    const r = rankHookWords(struct(inBody, inTitle), ['gizmo']);
    ok(r.hits[0].card.id === inTitle.id, 'W2: a title hit outranks a body hit on the same token');
    const tagged = card('unrelated body words only nothing shared', { tags: ['#file-toolbar'] });
    const plain = card('the toolbar is mentioned once in the body');
    const rt = rankHookWords(struct(plain, tagged), ['toolbar']);
    ok(rt.hits[0].card.id === tagged.id, 'W2: a #file- tag stem counts as a title word and outranks a body hit');
}

// ── W3: the evidence bar silences thin matches ───────────────────────────────
{
    // One common body word: score ≤ 1, evidence ≤ 1 + 0.2·spec < 1.8 → the
    // hook stays silent (it shows only at evidence >= bar).
    const cards = Array.from({ length: 8 }, (_, i) => card(`note ${i} mentions deployment somewhere in passing`));
    const r = rankHookWords(struct(...cards), ['deployment']);
    ok(r.hits.length > 0 && r.evidence < HOOK_WORDS_BAR, `W3: a single common body word stays under the bar (evidence ${r.evidence.toFixed(3)})`);
}

// ── W4: evidence = top + 0.2 × specificity, and the boundary is SHOWN ────────
{
    // Four cards of identical token length, each carrying one unique rare
    // token: every prompt token is known at weight 1, each card scores exactly
    // 1.0 (single body hit, len == avgLen), so evidence = 1 + 0.2×4 — the
    // float for 1.8 EXACTLY. The reference policy tests `evidence < bar`, so
    // equality shows; the hook must use >= (pinned in R3).
    const mk = (word) => card(`alpha beta ${word} gamma delta epsilon`);
    const s = struct(mk('kraken'), mk('sphinx'), mk('wyvern'), mk('basilisk'));
    const r = rankHookWords(s, ['kraken', 'sphinx', 'wyvern', 'basilisk']);
    ok(Math.abs(r.evidence - (r.top + 0.2 * r.specificity)) === 0, 'W4: evidence is top + 0.2 × specificity');
    ok(r.evidence === HOOK_WORDS_BAR, `W4: boundary construction lands exactly on the bar (evidence ${r.evidence}) — and >= shows`);
}

// ── W5: tie determinism — struct.cards order survives equal score + createdAt ─
{
    const a = card('zeppelin maintenance log entry one two', { createdAt: 500 });
    const b = card('zeppelin maintenance log entry one two', { createdAt: 500 });
    const r = rankHookWords(struct(a, b), ['zeppelin']);
    ok(r.hits.length === 2 && r.hits[0].card.id === a.id && r.hits[1].card.id === b.id,
        'W5: equal score and createdAt keep struct.cards order (parity guard for compare-policies)');
}

// ── W6: a card with a title but blank text is excluded from both lanes ───────
{
    const ghost = card('   ', { title: 'quasar navigation design' });
    const real = card('the quasar module body text');
    const r = rankHookWords(struct(ghost, real), ['quasar']);
    ok(r.hits.length === 1 && r.hits[0].card.id === real.id, 'W6: blank-text card is not indexed even though its title matches');
    const f = rankHookFused(struct(ghost, real), semOf([[ghost.id, [0.9]], [real.id, [0.9]]]), ['quasar']);
    ok(f.pool === 1 && f.hits[0].card.id === real.id, 'W6: blank-text card is invisible to the fused lane too');
}

// ── W7: degenerate tags contribute nothing; a duplicate slug cannot double-count ─
{
    const weird = card('plain body with nothing rare', { tags: ['#', '#file-'] });
    const r = rankHookWords(struct(weird, card('another plain body here nothing')), ['file']);
    ok(r.hits.length === 0, 'W7: "#" and "#file-" produce empty slugs and match nothing');
    // Tag slug == title word: head is a Set, so df for that stem stays 1 per card.
    const dup = card('body text here', { title: 'toolbar design', tags: ['#toolbar'] });
    const other = card('toolbar mentioned in body once more');
    const rd = rankHookWords(struct(dup, other), ['toolbar']);
    // df('toolbar') must be 2 (one per card), not 3 — weight = idf(2)/idf(1) < 1.
    ok(rd.hits.length === 2 && rd.hits[0].card.id === dup.id && rd.specificity < 1,
        `W7: a tag duplicating a title word does not double-count df (specificity ${rd.specificity.toFixed(3)})`);
}

// ── W8: Arabic recall through the words lane (NEW capability) ────────────────
{
    // termsOf is Unicode + foldArabic: an Arabic prompt token must land on an
    // Arabic card title — today's scoreCardsAgainstQuery wordsOf is Latin-only.
    const ar = card('نص عادي عن الموضوع', { title: 'ترحيل قاعدة البيانات' });
    const en = card('unrelated english body entirely here');
    const r = rankHookWords(struct(ar, en), splitQueryTokens('وين وصلت خطة ترحيل قاعده البيانات بالضبط').content);
    ok(r.hits.length > 0 && r.hits[0].card.id === ar.id, 'W8: folded Arabic prompt tokens match a folded Arabic title');
}

// ── W9: single-card brain — no division hazards ──────────────────────────────
{
    const only = card('solitary card about the meteor shower');
    const r = rankHookWords(struct(only), ['meteor']);
    ok(Number.isFinite(r.evidence) && r.hits.length === 1, `W9: N=1 brain yields finite evidence (${r.evidence.toFixed(3)})`);
}

// ── W10: archived cards are excluded from the words lane ─────────────────────
{
    const dead = card('obelisk retirement notes live here', { area: 'Archive' });
    const r = rankHookWords(struct(dead, card('nothing shared with the prompt')), ['obelisk']);
    ok(r.hits.length === 0 && r.evidence === 0, 'W10: an Archive-area card never surfaces (and contributes no specificity)');
}

// ── M1/M2/M3: fused show, silent, and boundary ───────────────────────────────
{
    const a = card('vector one about the sync design');
    const b = card('vector two about the render loop');
    const s = struct(a, b);
    const shown = rankHookFused(s, semOf([[a.id, [0.80]], [b.id, [0.40]]]), ['nomatch']);
    ok(shown.pool === 2 && shown.best >= shown.bar && shown.hits[0].card.id === a.id,
        `M1: best cosine 0.80 clears the bar and ranks first (best ${shown.best})`);
    const silent = rankHookFused(s, semOf([[a.id, [0.60]], [b.id, [0.40]]]), ['nomatch']);
    ok(silent.hits.length === 2 && silent.best < silent.bar,
        `M2: best 0.60 stays under the bar — hits are returned, the caller silences (best ${silent.best})`);
    const boundary = rankHookFused(s, semOf([[a.id, [0.65]], [b.id, [0.40]]]), ['nomatch']);
    ok(boundary.best === HOOK_FUSED_SHOW_BAR, `M3: best exactly at the bar (${boundary.best}) — and >= shows (reference tests < bar)`);
}

// ── M4/M5: identical-text collapse + twin vector reachability ────────────────
{
    const older = card('The gradient checkpoint decision   stands', { createdAt: 100 });
    const newer = card('The gradient  checkpoint decision stands', { createdAt: 900 });   // same normalized text
    const other = card('a different unrelated card body', { createdAt: 50 });
    const s = struct(older, newer, other);
    // Vector lives only on the OLDER twin — the group must still be reachable,
    // and the card SHOWN must be the newest copy.
    const f = rankHookFused(s, semOf([[older.id, [0.9]], [other.id, [0.1]]]), ['gradient']);
    ok(f.pool === 2, `M4: identical-text twins collapse to one piece of evidence (pool ${f.pool})`);
    ok(f.hits[0].card.id === newer.id, 'M5: the NEWEST twin stands for the group even when the vector came from the older copy');
    // Rarity counted once per group: df('gradient') is 1 group of 2 cards.
    const idf = Math.log((2 + 1) / (1 + 1));
    const want = 0.9 + HOOK_FUSED_IDF_WEIGHT * idf;
    ok(Math.abs(f.hits[0].score - want) < 1e-12, `M4: rarity uses group-level df (score ${f.hits[0].score.toFixed(6)} vs ${want.toFixed(6)})`);
}

// ── M6: vectorless groups are invisible; an all-archived cache degrades ──────
{
    const withVec = card('card that has a vector today');
    const noVec = card('card whose cache entry went stale after an edit');
    const f = rankHookFused(struct(withVec, noVec), semOf([[withVec.id, [0.9]]]), ['card']);
    ok(f.pool === 1 && f.hits.every((h) => h.card.id === withVec.id), 'M6: a group with no vector on any copy is skipped without error');
    const buried = card('archived card carrying the only vector', { area: 'Archive' });
    const liveDry = card('live card with no vector at all');
    const empty = rankHookFused(struct(buried, liveDry), semOf([[buried.id, [0.9]]]), ['card']);
    ok(empty.pool === 0 && empty.hits.length === 0 && empty.best === null,
        'M6: only-archived vectors → empty pool → the caller degrades to the words lane, never model-silent');
}

// ── M7: the rarity term can reorder near-equal cosines ───────────────────────
{
    const near1 = card('the quokka release checklist body');
    const near2 = card('completely disjoint vocabulary in here');
    const s = struct(near1, near2, card('filler card one body'), card('filler card two body'));
    const sem = semOf([[near1.id, [0.700]], [near2.id, [0.702]]]);
    const f = rankHookFused(s, sem, ['quokka', 'release']);
    // near1 gains 0.006·(ln(5/2)+ln(5/2)) ≈ 0.011 > the 0.002 cosine deficit.
    ok(f.hits[0].card.id === near1.id, 'M7: matched-token rarity lifts the lexically-corroborated card past a bare cosine edge');
}

// ── M8: no/invalid sem is the degradation contract ───────────────────────────
{
    const s = struct(card('anything at all in this body'));
    for (const sem of [null, undefined, {}, { qv: null, vecsMap: new Map(), dot: () => 0 }]) {
        const f = rankHookFused(s, sem, ['anything']);
        if (!(f.hits.length === 0 && f.best === null && f.pool === 0)) { ok(false, 'M8: invalid sem must yield empty hits / null best'); break; }
    }
    ok(true, 'M8: null / malformed sem yields { hits: [], best: null } — the words-lane degradation signal');
}

// ── M9: the fused rarity term is Latin-only — Arabic tokens add nothing ──────
{
    // Parity pin on a reference property (fusion-core wordsOf is [a-z0-9]):
    // an Arabic prompt token sitting verbatim in the card text contributes ZERO
    // rarity, so the fused score is the bare cosine. The words lane (Unicode
    // termsOf) is where Arabic recall lives; a below-bar Arabic model-lane
    // result is model-silent with no words rescue — routing, not a bug.
    const ar = card('ترحيل قاعدة البيانات اكتمل بنجاح');
    const other = card('unrelated latin body here entirely');
    const f = rankHookFused(struct(ar, other), semOf([[ar.id, [0.7]], [other.id, [0.1]]]), ['ترحيل', 'قاعده']);
    ok(f.hits[0].card.id === ar.id && f.hits[0].score === 0.7,
        `M9: Arabic tokens are invisible to the fused rarity term — score is the bare cosine (${f.hits[0].score})`);
}

// ── R2/R3/R4: routing + comparison pins on the hook source ───────────────────
ok(/new Set\(ptoks\)\.size >= lib\.HOOK_MODEL_MIN_TOKENS/.test(hookSrc),
    'R2: the model gate counts unique CONTENT tokens (ptoks) — git-diff file tokens never route to the model');
ok(/const fileToks = \(ptoks\.length < 2 && !statusShaped && humanText !== null\)/.test(hookSrc),
    'R2: the terse-prompt git-diff fallback is kept (fileToks still feed the words lane)');
ok(/fused\.best >= fused\.bar/.test(hookSrc) && /w\.evidence >= w\.bar/.test(hookSrc),
    'R3: both show decisions are >= (evidence exactly at the bar SHOWS)');
{
    const gate = hookSrc.indexOf('new Set(ptoks).size >= lib.HOOK_MODEL_MIN_TOKENS');
    const call = hookSrc.indexOf('semanticVecs(BRAIN, struct, humanText ||');
    ok(gate > 0 && call > gate, 'R4: semanticVecs is called only after the token gate (no embedder load for terse prompts)');
    ok(/semanticVecs\(BRAIN, struct, humanText \|\| ''/.test(hookSrc), 'R4: the model lane embeds the DERIVED human text, never the raw prompt');
}
ok(/lib\.HOOK_WORDS_BAR/.test(harnessSrc) && /lib\.HOOK_FUSED_SHOW_BAR/.test(harnessSrc) && /lib\.HOOK_MODEL_MIN_TOKENS/.test(harnessSrc),
    'R5: the harness reads the bars from the engine exports, never restates them');

// ── R6: statusShaped-but-not-strong stays on the normal lanes ────────────────
{
    const sp = splitQueryTokens('remove the TODO: refactor App.tsx and drop the pending cleanup');
    ok(!sp.strong && sp.statusShaped && !sp.content.includes('todo') && !sp.content.includes('pending') && sp.content.length > 0,
        'R6: a work request with incidental status vocab keeps its content tokens and never takes the digest');
}

// ── C: disk index cache — the content fingerprint refuses stale seeds ────────
// (2026-09-29 review, both reproduced: a doc built from an OLD struct seeded
// silently onto a struct with an added card — the TOCTOU where a Stop capture
// races a prompt — and a same-key different-content doc silently changed the
// words-lane scores. The fingerprint closes both: seed only when the live
// struct's content hash matches the one the doc was built from.)
{
    const a1 = card('the falcon heavy booster landed on the drone ship', { title: 'falcon booster' });
    const a2 = card('unrelated second body about warehouse shelving');
    const sA = struct(a1, a2);
    const doc = hookIndexCacheDoc(sA);
    ok(typeof doc.fp === 'string' && doc.fp.length === 40 && doc.fp === hookIndexFingerprint(sA),
        'C1: the cache doc carries the content fingerprint of the struct that built it');
    // C2 — TOCTOU shape: a struct with one ADDED card must reject the old doc
    // (it used to seed, leaving the freshly captured card invisible to both lanes).
    const added = card('the zirconium coupling replacement decision', { title: 'zirconium coupling' });
    const sB = { cards: [...sA.cards, added] };
    ok(seedHookIndexCache(sB, doc) === false, 'C2: a struct with an added card REJECTS the stale doc (TOCTOU guard)');
    const r = rankHookWords(sB, ['zirconium', 'coupling']);
    ok(r.hits.length > 0 && r.hits[0].card.id === added.id, 'C2: after the rejection, the in-memory rebuild sees the added card');
    // C3 — same key, same SHAPE, different content: one card's text swapped at
    // identical length (the mtime-restore / timestamp-granularity swap class).
    const sC = { cards: [{ ...a1, text: 'the falcon heavy booster landed on the barge deck' }, a2] };
    ok(sC.cards[0].text.length === a1.text.length, 'C3: (fixture) the swapped text preserves length — only content differs');
    ok(seedHookIndexCache(sC, doc) === false, 'C3: same ids and lengths but different text rejects the seed — never stale term stats');
    // C4 — honest roundtrip is behaviour-neutral: an identical-content
    // re-parse seeds, and seeded results equal a fresh build exactly.
    const clone = JSON.parse(JSON.stringify(sA));
    const fresh = rankHookWords(JSON.parse(JSON.stringify(sA)), ['falcon', 'booster']);
    ok(seedHookIndexCache(clone, doc) === true, 'C4: an identical-content re-parse still seeds');
    const seeded = rankHookWords(clone, ['falcon', 'booster']);
    ok(JSON.stringify(seeded.hits.map(h => [h.card.id, h.score])) === JSON.stringify(fresh.hits.map(h => [h.card.id, h.score]))
        && seeded.evidence === fresh.evidence && seeded.specificity === fresh.specificity,
        'C4: seeded and fresh rankings are identical (behaviour-neutrality holds)');
    // C5 — a doc with no fingerprint (pre-fingerprint format, or hand-stripped)
    // never seeds; the rankers rebuild instead.
    const docNoFp = { ...doc }; delete docNoFp.fp;
    ok(seedHookIndexCache(JSON.parse(JSON.stringify(sA)), docNoFp) === false, 'C5: a doc without a fingerprint is refused');
}

// ── E: through the real hook (temp HOME, no model → words lane) ──────────────
function fixture(tag) {
    const home = path.join(os.tmpdir(), 'klypix-unified-home-' + tag);
    const proj = path.join(os.tmpdir(), 'klypix-unified-proj-' + tag);
    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.npm-currency.json'),
        JSON.stringify({ pkg: 'klypix-mcp', latest: '1.86.3', checkedAt: Date.now() }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    const run = (args, input) => execFileSync(process.execPath, [HOOK, ...args], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });
    const health = () => {
        const dir = path.join(home, '.claude', 'project-brain', 'health');
        try {
            return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
        } catch { return []; }
    };
    const cleanup = () => { for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true }); };
    return { home, proj, run, health, cleanup };
}

{
    const f = fixture('lanes');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [
            { title: 'Sync', cards: [{ text: 'Op-log compaction keeps the newest five thousand operations and folds older ones into the base checkpoint blob.' }] },
            { title: 'Archive', cards: [{ text: 'Retired plan: the palimpsest exporter was cancelled before launch.' }] },
            { title: 'Render', cards: [{ text: 'Viewport culling caps decoration passes at the visible set.' }] },
        ],
    }));
    // E1 — a 6+-content-token prompt with NO model installed degrades to the
    // words lane and still recalls the matching card.
    const out = f.run(['--prompt'], { session_id: 's-e1', prompt: 'why does the op-log compaction fold older operations into the base checkpoint blob?' });
    ok(/compaction keeps the newest five thousand/.test(out), 'E1: no model installed → words lane still recalls the right card');
    ok(!/semantic match/.test(out), 'E1: the words lane header is the lexical one');
    const rows = f.health().filter((r) => r.mode === 'prompt' && r.lane);
    const shown = rows.find((r) => r.lane === 'words-shown');
    ok(shown && Number.isFinite(shown.evidence) && shown.evidence >= 1.8, `E1: health row logs lane + deciding evidence (${JSON.stringify({ lane: shown?.lane, evidence: shown?.evidence })})`);
    ok(shown && shown.sem === 'lexical', `E1: the row keeps the legacy sem field for grep continuity — top1's successor is evidence (sem ${shown?.sem})`);
    // E2 — junk-shaped prompt: thin evidence stays silent AND is still logged
    // (silent rows are the refit data).
    const quiet = f.run(['--prompt'], { session_id: 's-e2', prompt: 'sounds perfect thanks, carry on with everything discussed' });
    ok(!/Relevant prior decisions|semantic match/.test(quiet), 'E2: a junk prompt injects no cards');
    const silentRow = f.health().find((r) => r.lane === 'words-silent' || r.lane === 'no-tokens');
    ok(silentRow && (silentRow.lane === 'no-tokens' || 'evidence' in silentRow), `E2: the silent decision writes a health row (${JSON.stringify(silentRow)})`);
    // E3 — a prompt matching ONLY the archived card stays silent.
    const arch = f.run(['--prompt'], { session_id: 's-e3', prompt: 'what happened to the palimpsest exporter cancellation exactly, and why was it retired?' });
    ok(!/palimpsest exporter was cancelled/.test(arch), 'E3: an Archive-area card is never recalled');
    // E4 — a machine turn (harness-injected "user" prompt) derives no intent:
    // no recall, NEITHER index is ever built, and NO health row — hundreds of
    // task-notification turns a day must not rotate the evidence-bearing
    // silent rows out of the 500-row cap (2026-09-29 review).
    const rowsBefore = f.health().filter((r) => r.mode === 'prompt').length;
    const mach = f.run(['--prompt'], { session_id: 's-e4', prompt: '<system-reminder>the op-log compaction checkpoint blob was mentioned here</system-reminder>' });
    ok(!/compaction keeps the newest/.test(mach), 'E4: a machine turn never retrieves, even when its text matches a card');
    const rowsAfter = f.health().filter((r) => r.mode === 'prompt').length;
    ok(rowsAfter === rowsBefore, `E4: a machine turn writes NO health row (rows before ${rowsBefore}, after ${rowsAfter})`);
    f.cleanup();
}

// ── E5: terse prompt + git diff — fileToks feed the WORDS lane, never the gate ─
{
    const f = fixture('filetoks');
    const g = (args) => execFileSync('git', args, { cwd: f.proj, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: f.home, USERPROFILE: f.home } });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    // Six distinct changed files → the merged token set passes 6, but the
    // model gate counts the asker's OWN content tokens (0 here), so the words
    // lane must decide — and it recalls the compaction card from the file
    // slugs alone (the terse-prompt git-diff feature the 1.8 bar was never
    // tuned with, kept deliberately).
    const names = ['oplog-compaction.md', 'checkpoint-blob.md', 'operations-fold.md', 'newest-five.md', 'thousand-ops.md', 'base-records.md'];
    for (const n of names) fs.writeFileSync(path.join(f.proj, n), 'seed\n');
    g(['add', '.']); g(['commit', '-q', '-m', 'seed', '--no-gpg-sign']);
    for (const n of names) fs.appendFileSync(path.join(f.proj, n), 'changed\n');
    fs.writeFileSync(path.join(f.proj, 'brain.klypix'), await buildKlypixMap({
        title: 'brain',
        areas: [{ title: 'Sync', cards: [{ text: 'Op-log compaction keeps the newest five thousand operations and folds older ones into the base checkpoint blob.\n#file-oplog-compaction #file-checkpoint-blob' }] }],
    }));
    const out = f.run(['--prompt'], { session_id: 's-e5', prompt: 'go on' });
    ok(/compaction keeps the newest five thousand/.test(out), 'E5: a terse human prompt still recalls through the git-diff file tokens (words lane)');
    const row = f.health().filter((r) => r.lane).pop();
    ok(row && /^words-/.test(row.lane) && row.mtok < HOOK_MODEL_MIN_TOKENS,
        `E5: the decision is a words lane and the model gate saw only the asker's content tokens (${JSON.stringify({ lane: row?.lane, mtok: row?.mtok })})`);
    f.cleanup();
}

if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
console.log('\n✓ hook-unified-lane: all assertions passed');
