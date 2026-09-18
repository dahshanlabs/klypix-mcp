// Question enrichment (1.77) — the question that produced a card becomes
// searchable text for it.
//
// The measured retrieval failure is a vocabulary gap: paraphrase questions
// share no words with the cards that answer them, and structural enrichment
// (area/tags/neighbours) was falsified TWICE — 62% → 52% recall@5 on the valid
// harness — because more project jargon compresses an already-compressed
// cosine space. Asker-language is the opposite medicine, and capture holds it
// for free. This suite locks the whole path:
//
//   EN1  sidecar round-trip: record → read → join, keyed by body prefix so no
//        card id is ever needed; decorations (area prefix, emoji, #tags)
//        around the body do not break the join.
//   EN2  bounds: per-entry question cap, entry cap pruning OLDEST first, TTL
//        expiry, corrupt file starts empty — additive signal, never a crash.
//   EN3  the embed input actually changes: vectorsForBrain's hash covers the
//        enrichment, so recording a question re-embeds exactly that card.
//   EN4  the MCP path: opBrainNote with an enrichmentQuestion records the
//        sidecar entry only when the card actually landed.
//   EN5  the memo layer serves identical results and refreshes on file change.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ENRICHMENT_MAX_ENTRIES,
  ENRICHMENT_MAX_QUESTIONS,
  enrichmentFileFor,
  enrichmentKeyFor,
  enrichmentQuestionQuality,
  enrichmentTextFor,
  readEnrichment,
  recordEnrichment,
} from '../src/enrichment.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-enrichment-home-'));
const brain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-enrichment-proj-')), 'brain.klypix');
fs.writeFileSync(brain, 'fixture');

try {
  // ── EN1 — round-trip and decoration-proof join ──────────────────────────
  const body = 'Pan = dedicated hand tool in toolbar (H, next to Select, Space+drag kept); Zoom = −/+ steppers added to the status-bar % cluster';
  const question = 'What did we settle on for grab-and-move navigation of the board, and where did the magnification controls end up?';
  const r1 = recordEnrichment(brain, [{ body, question }], { home });
  ok(r1.recorded === 1, 'EN1: a body/question pair records');
  const entries = readEnrichment(brain, { home });
  ok(entries.length === 1 && entries[0].q[0] === question, 'EN1: it reads back verbatim');
  // The stored card decorates the body: area prefix, type emoji, tag line.
  const storedCardText = `Canvas UX: 🏁 ${body}\n#canvas-ux #file-toolbar #dir-interaction`;
  ok(enrichmentTextFor(entries, storedCardText) === question,
    'EN1: the join survives the area prefix, emoji, and tag decorations around the body');
  ok(enrichmentTextFor(entries, 'Auth: token refresh only happens at app start #auth') === '',
    'EN1: an unrelated card gets nothing');
  ok(enrichmentKeyFor('  PAN =   dedicated HAND tool  ') === enrichmentKeyFor('pan = dedicated hand tool'),
    'EN1: the key normalizes case and whitespace so both sides always agree');

  // ── EN2 — bounds and resilience ─────────────────────────────────────────
  for (let i = 0; i < ENRICHMENT_MAX_QUESTIONS + 2; i++) {
    recordEnrichment(brain, [{ body, question: `${question} variant ${i}` }], { home });
  }
  const capped = readEnrichment(brain, { home });
  ok(capped[0].q.length === ENRICHMENT_MAX_QUESTIONS,
    'EN2: per-entry questions cap; newest are kept');
  const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;
  recordEnrichment(brain, [{ body: 'ancient decision body that should expire from the sidecar entirely', question: 'why did the old thing happen back then?' }], { home, now: oldTs });
  const afterTtl = readEnrichment(brain, { home });
  ok(!afterTtl.some((entry) => entry.key.includes('ancient decision body')),
    'EN2: entries beyond the TTL are gone on read');
  fs.writeFileSync(enrichmentFileFor(brain, home), '{ definitely not json');
  ok(readEnrichment(brain, { home }).length === 0, 'EN2: a corrupt sidecar starts empty, never throws');
  recordEnrichment(brain, [{ body, question }], { home });
  ok(readEnrichment(brain, { home }).length === 1, 'EN2: and recording over a corrupt file recovers it');
  // Entry-cap pruning drops the OLDEST.
  const bulk = [];
  for (let i = 0; i < ENRICHMENT_MAX_ENTRIES + 8; i++) {
    bulk.push({ body: `unique overflow body number ${i} padded to pass the minimum key length check`, question: `question for overflow body ${i} long enough to keep` });
  }
  recordEnrichment(brain, bulk.slice(0, 2048), { home, now: Date.now() - 1000 });
  recordEnrichment(brain, bulk.slice(2048), { home });
  const pruned = readEnrichment(brain, { home });
  ok(pruned.length <= ENRICHMENT_MAX_ENTRIES, 'EN2: the sidecar never exceeds its entry cap');
  ok(pruned.some((entry) => entry.key.includes(`overflow body number ${ENRICHMENT_MAX_ENTRIES + 7}`)),
    'EN2: pruning dropped the OLDEST entries, never the newest');

  // ── EN3 — the embed hash covers enrichment ──────────────────────────────
  // vectorsForBrain is model-heavy; the contract that matters is the INPUT:
  // semantic-memory builds its per-card hash from embedInputFor, which appends
  // the joined enrichment. Assert at the seam by reading the source contract.
  const sem = fs.readFileSync(new URL('../src/semantic-memory.mjs', import.meta.url), 'utf8');
  ok(/embedInputFor/.test(sem) && /sha1\(embedInputFor\(card\)\)/.test(sem),
    'EN3: the cache hash is computed over the ENRICHED embed input, so a new question re-embeds its card');
  ok(/enrichmentTextFor\(enrichmentEntries, card\.text\)/.test(sem),
    'EN3: and the enrichment join feeds the same input the embedder receives');

  // ── EN4 — MCP path records only when the card lands ─────────────────────
  const { opBrainNote } = await import('../src/klypix-core.mjs');
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-enrichment-mcp-'));
  const { buildKlypix } = await import('../src/klypix-format.mjs');
  const built = await buildKlypix({ title: 'test brain', cards: [{ text: 'seed card', area: 'Seed' }] });
  const brain2 = path.join(proj2, 'brain.klypix');
  fs.writeFileSync(brain2, Buffer.from(built.buffer ?? built));
  // recordEnrichment inside opBrainNote uses the DEFAULT home — the assertion
  // reads the real sidecar path for brain2 under the actual home dir.
  const noteText = 'Retrieval: the enrichment sidecar records the asker vocabulary for every MCP-captured card';
  const res = await opBrainNote({ vault: proj2, canvas: brain2, text: noteText, area: 'Retrieval', via: 'test', enrichmentQuestion: 'how do MCP-captured cards learn the words people actually use?' });
  ok(!res.isError, 'EN4: the note lands');
  const sidecar2 = readEnrichment(brain2, {});
  ok(sidecar2.some((entry) => entry.key === enrichmentKeyFor(noteText)
    && entry.q.some((q) => q.includes('words people actually use'))),
    'EN4: the sidecar carries the session intent for the captured card');

  // ── EN5 — memo refreshes on file change ─────────────────────────────────
  const before = readEnrichment(brain, { home });
  ok(readEnrichment(brain, { home }) === before, 'EN5: an unchanged sidecar serves the memoized array');
  // mtime granularity can be coarse; force a visible change.
  const f = enrichmentFileFor(brain, home);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 2000));
  const after = readEnrichment(brain, { home });
  ok(after !== before, 'EN5: touching the sidecar invalidates the memo');

  // ── EN6 — the quality gate (1.86) ───────────────────────────────────────
  // Every class below was found in a REAL sidecar on 2026-09-16, recorded as
  // "the asker's language" and fed to the embedder.
  const gate = (q) => enrichmentQuestionQuality(q);
  ok(gate('done , what now').reason === 'low-content', 'EN6: an acknowledgement carries no askable vocabulary');
  ok(gate('300mb is ok').reason === 'low-content', 'EN6: "300mb is ok" is not a question about anything');
  ok(gate('ok do them and the recommendations').reason === 'low-content', 'EN6: a go-ahead with one content word is rejected');
  ok(gate('> klypix@1.3.127 release:register > node scripts/register-release.mjs --rollout=100 ✔ releases row registered').reason === 'console',
    'EN6: an npm script echo is console output, not a prompt');
  ok(gate('Stop hook feedback: [node global-brain-hook.mjs --capture]: [brain] 🧠 uncaptured work — this outcome should be recorded').reason === 'machine',
    'EN6: hook feedback re-injected as a user turn is a machine text');
  ok(gate('another claude session sent a message: <agent-message from="a817"> [subagent hand-back] the report below').reason === 'machine',
    'EN6: a peer message relayed into the prompt is a machine text');
  ok(gate('# Workflow authoring reference — a workflow structures work across many agents').reason === 'pasted-doc',
    'EN6: a pasted markdown document is not the asker speaking');
  ok(gate('[Image: original 3200x1800, displayed at 2000x1125. Multiply coordinates by 1.60 to map to the original]').reason === 'machine',
    'EN6: an image-attachment preamble is harness text');
  ok(gate('Base directory for this skill: e:\\ANTIGRAVITY\\KLYPIX\\.claude\\skills\\impeccable Designs and audits interfaces').reason === 'machine',
    'EN6: a skill-invocation preamble is harness text');
  ok(gate('see this is competotor ? i posted jst question to check and he reached this way').ok === true,
    'EN6: a real, typo-laden founder question passes — the gate is about vocabulary, not polish');
  ok(gate('why the message not appear .. regarding the folder features what are they to be tested ?').ok === true,
    'EN6: a terse but content-bearing question passes');
  ok(gate('ليش ما تظهر الرسالة عند فتح المجلد الجديد في الكانفس؟').ok === true,
    'EN6: an Arabic question passes — tokens are Unicode words, not [a-z]');
  ok(gate('تمام طيب').reason === 'low-content', 'EN6: an Arabic acknowledgement is rejected');
  ok(gate('').reason === 'too-short' && gate(null).reason === 'too-short', 'EN6: empty input is too short, never a throw');

  // ── EN7 — the gate runs on BOTH sides ───────────────────────────────────
  const gatedBody = 'The hook lane fallback is a production primitive so the harness can import it';
  const r7 = recordEnrichment(brain, [
    { body: gatedBody, question: 'how does the eval measure the same fallback ranking the hook actually runs?' },
    { body: gatedBody, question: 'ok do it' },
    { body: gatedBody, question: '> npm run test ✔ 12 passed' },
  ], { home });
  ok(r7.recorded === 1 && r7.rejected === 2, `EN7: record keeps the question and reports the two rejections (${r7.recorded}/${r7.rejected})`);
  const r7entry = readEnrichment(brain, { home }).find((entry) => entry.key === enrichmentKeyFor(gatedBody));
  ok(r7entry && r7entry.q.length === 1 && /eval measure/.test(r7entry.q[0]), 'EN7: only the question reached the sidecar');
  // A legacy sidecar (pre-1.86 hook) carrying junk is cleaned ON READ.
  const legacyBrain = path.join(path.dirname(brain), 'legacy.klypix');
  fs.writeFileSync(legacyBrain, 'fixture');
  const legacyFile = enrichmentFileFor(legacyBrain, home);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ v: 1, entries: {
    [enrichmentKeyFor(gatedBody)]: { q: ['done , what now', 'which lane does every prompt actually pass through before anything is injected?'], ts: Date.now() },
    [enrichmentKeyFor('a second body whose only recorded text is an acknowledgement, long enough to key')]: { q: ['300mb is ok'], ts: Date.now() },
  } }));
  const legacy = readEnrichment(legacyBrain, { home });
  ok(legacy.length === 1 && legacy[0].q.length === 1 && /every prompt/.test(legacy[0].q[0]),
    'EN7: a legacy sidecar is cleaned on read — junk texts dropped, an entry with nothing left is dropped whole');
  ok(enrichmentTextFor(legacy, `Retrieval: 🛠️ ${gatedBody}\n#retrieval`) === legacy[0].q[0],
    'EN7: the cleaned entry still joins to its card');

  // ── EN8 — the MCP path records the AUTHORED question beside the intent ──
  const noteText8 = 'Retrieval: the authored question rides beside the declared intent on the MCP note path';
  const res8 = await opBrainNote({ vault: proj2, canvas: brain2, text: noteText8, area: 'Retrieval', via: 'test',
    enrichmentQuestion: ['how does a note become findable by a paraphrase nobody typed?', 'ok do them', 'audit the brain retrieval core for over- and underfitting'] });
  ok(!res8.isError, 'EN8: the note lands');
  const side8 = readEnrichment(brain2, {}).find((entry) => entry.key === enrichmentKeyFor(noteText8));
  ok(side8 && side8.q.some((q) => /paraphrase nobody typed/.test(q)) && side8.q.some((q) => /audit the brain/.test(q)) && !side8.q.some((q) => /ok do them/.test(q)),
    'EN8: both the authored question and the intent are recorded; the acknowledgement is not');

  // ── EN9 — the hook's `q:` marker suffix ─────────────────────────────────
  const { splitMarkerSuffixes } = await import('../src/global-brain-hook.mjs');
  const parsed = splitMarkerSuffixes('Pan = dedicated hand tool in toolbar; Zoom = steppers in the status bar q: how do I move around the board and change magnification? closes: [[Canvas navigation]] ev: src/canvas/Toolbar.tsx');
  ok(parsed.body === 'Pan = dedicated hand tool in toolbar; Zoom = steppers in the status bar', 'EN9: the q: suffix never leaks into the card text');
  ok(parsed.question === 'how do I move around the board and change magnification?', 'EN9: the question is parsed out in full');
  ok(parsed.closes === '[[Canvas navigation]]' && parsed.evidence && parsed.evidence.length === 1,
    'EN9: closes: and ev: still parse around it (shared lookahead — no lockstep drift)');
  const noQ = splitMarkerSuffixes('Decided: FAQ: entries stay in the docs, not the brain');
  ok(noQ.body === 'Decided: FAQ: entries stay in the docs, not the brain' && noQ.question === '', 'EN9: "FAQ:" is not a q: suffix — a key needs whitespace before it (1.86.1 grammar)');
  const onlyQ = splitMarkerSuffixes('Keep the merge driver append-only q: why can a merge never drop a card?');
  ok(onlyQ.body === 'Keep the merge driver append-only' && onlyQ.question === 'why can a merge never drop a card?' && onlyQ.closes === '' && onlyQ.evidence === null,
    'EN9: q: alone works, other keys stay empty');

  if (failures) { console.error(`\n✗ ${failures} assertion(s) failed`); process.exit(1); }
  console.log('\n✓ enrichment — all assertions passed');
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
  try { fs.rmSync(path.dirname(brain), { recursive: true, force: true }); } catch { /* temp */ }
}
