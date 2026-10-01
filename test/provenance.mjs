// Judgment provenance (2026-09-29) — the sidecar that keeps every confirm /
// dismiss / settle verdict WITH its actor grade, plus the rejected-prompt pool
// the 1.86 enrichment gate used to throw away.
//
//   P1  judgment round-trip: record → read, jid dedup (count++ / lastTs), enum
//       strictness, and the no-id-short-key refusal.
//   P2  NO TTL — an ancient judgment survives every read (deliberate divergence
//       from enrichment); the cap prunes OLDEST-by-lastTs only.
//   P3  corrupt or absent sidecars start empty and recover on the next write.
//   P4  rejected pool privacy screen: low-content/too-short keep text, the
//       machine/console/pasted-doc classes store hash+length only, and a
//       credential-shaped low-content text is demoted to hash-only.
//   P5  recordEnrichment forwards its discards (reason attached) with ZERO
//       call-site changes and an unchanged {recorded, rejected} contract.
//   P6  judgeTrainingRows: id-first join, key-substring fallback, the
//       recorded-key fallback for textB (a bare ✓'s closer was never a card),
//       and unresolvable rows dropped + counted.
//   P7  the file never stores raw prompt text — humanPromptText lands as a
//       16-hex hash; 'human-ui' stays a reserved grade no writer emits.
//   P8  provenanceCounts serves the doctor's read-only totals.
//   P9  the writer call-sites exist where designed (source-pinned): hook Stop
//       path (marker-closes / marker-resolve / hint-settle / draft-promotion /
//       draft-decay), klypix-core (reconcile-confirm / reconcile-dismiss /
//       connect-dismiss), worker via, doctor surfacing.
//   P11 jid encoding is unambiguous: keys containing '|' can never alias two
//       distinct judgments onto one record (2026-09-29 review).
//   P12 concurrent writers merge, never interleave-lose: two processes each
//       recording 150 judgments to ONE sidecar end with all 300 on disk, no
//       leaked tmp files, no absent sidecar (2026-09-29 review).
//   P13 drained-batch honesty: markers drained from ANOTHER session's queued
//       batch are recorded with bare actor 'agent' and NO session/prompt —
//       this session's human-adjacency stamps only its own prefix; a
//       markerless drain yields zero agent-human-adjacent records
//       (2026-09-29 review).
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-provenance-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const {
  PROVENANCE_MAX_JUDGMENTS, PROVENANCE_MAX_REJECTED,
  provenanceFileFor, rejectedFileFor, validateJudgment,
  recordJudgments, readJudgments, recordRejectedEnrichment, readRejected,
  judgeTrainingRows, provenanceCounts,
} = await import('../src/provenance.mjs');
const { recordEnrichment } = await import('../src/enrichment.mjs');

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-provenance-explicit-'));
const brain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-provenance-proj-')), 'brain.klypix');
fs.writeFileSync(brain, 'fixture');

const J = (over = {}) => ({
  kind: 'pair', direction: 'fulfills', verdict: 'yes', source: 'reconcile-confirm', actor: 'agent-listing-bound',
  from: { id: 'txt_open1', text: 'Canvas: ❓ capsule header auto-fit is broken when collapsing grouped containers' },
  to: { id: 'txt_mile1', text: 'Canvas: 🏁 capsule header auto-fit fixed for collapsed grouped containers' },
  ...over,
});

// ── P1 — round-trip, dedup, enum strictness ─────────────────────────────────
{
  const r1 = recordJudgments(brain, [J()], { home });
  ok(r1.recorded === 1 && r1.repeated === 0 && r1.refused === 0, 'P1: a judgment records');
  const again = recordJudgments(brain, [J()], { home, now: Date.now() + 5000 });
  ok(again.recorded === 0 && again.repeated === 1, 'P1: the same verdict through the same surface dedups into count++');
  const list = readJudgments(brain, { home });
  ok(list.length === 1 && list[0].count === 2 && list[0].lastTs > list[0].firstTs, 'P1: one record, count 2, lastTs advanced');
  ok(list[0].from.id === 'txt_open1' && typeof list[0].from.key === 'string' && list[0].from.key.length >= 24,
    'P1: sides store the id AND the normalized 160-char key');
  ok(typeof list[0].engine === 'string', 'P1: every record is engine-stamped');
  const bad = recordJudgments(brain, [
    J({ source: 'made-up-surface' }),
    J({ verdict: 'maybe' }),
    J({ actor: 'grand-jury' }),
    J({ from: { text: 'too short' } }),
  ], { home });
  ok(bad.recorded === 0 && bad.refused === 4, 'P1: unknown enums and an unanchored side are refused, never coerced');
  ok(readJudgments(brain, { home }).length === 1, 'P1: refusals write nothing');
  // A different verdict on the same pair is a DIFFERENT record, never an overwrite.
  const flip = recordJudgments(brain, [J({ verdict: 'no', source: 'reconcile-dismiss' })], { home });
  ok(flip.recorded === 1 && readJudgments(brain, { home }).length === 2, 'P1: yes and no on one pair coexist as two records');
}

// ── P2 — NO TTL, cap prunes oldest ──────────────────────────────────────────
{
  const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;   // 400 days — far past any enrichment-style TTL
  recordJudgments(brain, [J({ from: { id: 'txt_ancient' }, to: { id: 'txt_ancient_mile' } })], { home, now: ancient });
  ok(readJudgments(brain, { home }).some(j => j.from.id === 'txt_ancient'),
    'P2: a 400-day-old judgment is still served — judgments never expire');
  const brainCap = path.join(path.dirname(brain), 'cap.klypix');
  fs.writeFileSync(brainCap, 'fixture');
  const bulk = [];
  for (let i = 0; i < PROVENANCE_MAX_JUDGMENTS + 6; i++) {
    bulk.push(J({ from: { id: `txt_bulk_${i}` }, to: { id: `txt_bulk_mile_${i}` } }));
  }
  const base = Date.now() - 10_000_000;
  for (let i = 0; i < bulk.length; i += 1024) {
    recordJudgments(brainCap, bulk.slice(i, i + 1024), { home, now: base + i });
  }
  const capped = readJudgments(brainCap, { home });
  ok(capped.length === PROVENANCE_MAX_JUDGMENTS, 'P2: the sidecar never exceeds its judgment cap');
  ok(!capped.some(j => j.from.id === 'txt_bulk_0') && capped.some(j => j.from.id === `txt_bulk_${bulk.length - 1}`),
    'P2: pruning dropped the OLDEST records, never the newest');
}

// ── P3 — corrupt starts empty, recovers ─────────────────────────────────────
{
  fs.writeFileSync(provenanceFileFor(brain, home), '{ not json at all');
  ok(readJudgments(brain, { home }).length === 0, 'P3: a corrupt judgments sidecar starts empty, never throws');
  recordJudgments(brain, [J()], { home });
  ok(readJudgments(brain, { home }).length === 1, 'P3: recording over the corrupt file recovers it');
  fs.writeFileSync(rejectedFileFor(brain, home), 'also { not json');
  ok(readRejected(brain, { home }).length === 0, 'P3: a corrupt rejected sidecar starts empty too');
}

// ── P4 — rejected pool privacy screen ───────────────────────────────────────
{
  const r = recordRejectedEnrichment(brain, [
    { text: 'ok do them and the recommendations', reason: 'low-content' },
    { text: 'tmam', reason: 'too-short' },
    { text: 'Stop hook feedback: [node global-brain-hook.mjs --capture] uncaptured work', reason: 'machine' },
    { text: '> klypix@1.3.127 release:register ✔ releases row registered', reason: 'console' },
    { text: '# Workflow authoring reference — structures work across agents', reason: 'pasted-doc' },
    { text: 'the api key is hunter2secret', reason: 'low-content' },
  ], { home });
  ok(r.recorded === 6, 'P4: every discard class records');
  const pool = readRejected(brain, { home });
  const lc = pool.find(e => e.reason === 'low-content' && e.t === 'ok do them and the recommendations');
  ok(!!lc && lc.count === 1, 'P4: a low-content acknowledgement keeps its text — the negative class the judge study needs');
  ok(pool.some(e => e.reason === 'too-short' && e.t === 'tmam'), 'P4: a too-short text is kept (under 8 chars carries nothing)');
  for (const reason of ['machine', 'console', 'pasted-doc']) {
    const e = pool.find(x => x.reason === reason);
    ok(!!e && !('t' in e) && /^[0-9a-f]{16}$/.test(e.h) && e.len > 0,
      `P4: the ${reason} class stores hash+length ONLY (it can embed secrets or pasted private material)`);
  }
  const cred = pool.find(e => e.reason === 'low-content' && e.h && !e.t);
  ok(!!cred, 'P4: a credential-shaped low-content text is demoted to hash-only');
  ok(!JSON.stringify(pool).includes('hunter2'), 'P4: the secret never reaches disk');
  recordRejectedEnrichment(brain, [{ text: 'ok do them and the recommendations', reason: 'low-content' }], { home });
  ok(readRejected(brain, { home }).find(e => e.t === 'ok do them and the recommendations').count === 2,
    'P4: a repeated discard dedups into count++');
  const brainCap2 = path.join(path.dirname(brain), 'cap2.klypix');
  fs.writeFileSync(brainCap2, 'fixture');
  const bulk = [];
  for (let i = 0; i < PROVENANCE_MAX_REJECTED + 5; i++) bulk.push({ text: `overflow rejected number ${i} ok fine`, reason: 'low-content' });
  const base = Date.now() - 5_000_000;
  for (let i = 0; i < bulk.length; i += 1024) recordRejectedEnrichment(brainCap2, bulk.slice(i, i + 1024), { home, now: base + i });
  ok(readRejected(brainCap2, { home }).length === PROVENANCE_MAX_REJECTED, 'P4: the rejected pool is capped, oldest pruned');
}

// ── P5 — recordEnrichment forwards its discards, contract unchanged ─────────
{
  const brain5 = path.join(path.dirname(brain), 'forward.klypix');
  fs.writeFileSync(brain5, 'fixture');
  const body = 'The hook lane fallback is a production primitive so the harness can import it directly';
  const r5 = recordEnrichment(brain5, [
    { body, question: 'how does the eval measure the same fallback ranking the hook actually runs?' },
    { body, question: 'ok do it now' },
    { body, question: '> npm run test ✔ 12 passed' },
  ], { home });
  ok(r5.recorded === 1 && r5.rejected === 2, 'P5: the {recorded, rejected} contract is unchanged');
  // The forwarding is fire-and-forget (lazy import) — give the microtask a beat.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pool5 = readRejected(brain5, { home });
  ok(pool5.length === 2, `P5: both discards reached the rejected pool (${pool5.length})`);
  ok(pool5.some(e => e.reason === 'low-content' && e.t === 'ok do it now'),
    'P5: the acknowledgement arrives WITH its refusal reason and text');
  ok(pool5.some(e => e.reason === 'console' && e.h && !e.t),
    'P5: the console echo arrives hash-only through the same screen');
}

// ── P6 — judgeTrainingRows ──────────────────────────────────────────────────
{
  const brain6 = path.join(path.dirname(brain), 'train.klypix');
  fs.writeFileSync(brain6, 'fixture');
  const cardA = { id: 'txt_a', type: 'text', text: 'Canvas: ❓ capsule header auto-fit is broken when collapsing grouped containers' };
  const cardB = { id: 'txt_b', type: 'text', text: 'Canvas: 🏁 capsule header auto-fit fixed for collapsed grouped containers' };
  const cardC = { id: 'txt_c_NEW', type: 'text', text: 'Sync: ❓ the operation log replay drops trailing batches during reconnect handshakes' };
  recordJudgments(brain6, [
    // id join on both sides
    J({ from: { id: 'txt_a', text: cardA.text }, to: { id: 'txt_b', text: cardB.text } }),
    // from joins by KEY only (merge-twin id churn: recorded id no longer exists)
    J({ verdict: 'no', source: 'reconcile-dismiss', from: { id: 'txt_c_OLD', text: cardC.text }, to: { id: 'txt_b', text: cardB.text } }),
    // a bare ✓: textB falls back to the recorded key (the resolve prose was never a card)
    { kind: 'pair', direction: 'closes', verdict: 'yes', source: 'marker-resolve', actor: 'agent',
      from: { id: 'txt_a' }, to: { text: 'the capsule header auto-fit was fixed for collapsed containers' } },
    // unresolvable from → dropped and counted
    J({ from: { id: 'txt_gone_forever', text: 'a card that was deleted outright and can never join back to anything' }, to: { id: 'txt_b', text: cardB.text } }),
  ], { home });
  const { rows, total, dropped } = judgeTrainingRows(brain6, [cardA, cardB, cardC], { home });
  ok(total === 4 && rows.length === 3 && dropped === 1, `P6: 4 records → 3 rows + 1 dropped (${rows.length}/${dropped})`);
  const idRow = rows.find(r => r.source === 'reconcile-confirm');
  ok(!!idRow && idRow.textA === cardA.text && idRow.textB === cardB.text && idRow.label === 1,
    'P6: an id-joined record becomes a labelled pair of live card texts');
  const keyRow = rows.find(r => r.source === 'reconcile-dismiss');
  ok(!!keyRow && keyRow.textA === cardC.text && keyRow.label === 0,
    'P6: a churned id degrades to the key-substring join instead of dropping the row');
  const markerRow = rows.find(r => r.source === 'marker-resolve');
  ok(!!markerRow && /was fixed for collapsed containers/.test(markerRow.textB),
    'P6: a bare ✓ row keeps the resolve prose as textB');
  ok(rows.every(r => r.actor && r.direction && typeof r.ts === 'number'), 'P6: rows carry actor, direction and ts');
}

// ── P7 — hash-only prompt adjacency; human-ui stays reserved ────────────────
{
  const brain7 = path.join(path.dirname(brain), 'prompt.klypix');
  fs.writeFileSync(brain7, 'fixture');
  const secretPrompt = 'yes close it — and the staging password is swordfish99';
  recordJudgments(brain7, [
    { kind: 'pair', direction: 'closes', verdict: 'yes', source: 'marker-resolve', actor: 'agent-human-adjacent',
      humanPromptText: secretPrompt, session: 'sess-1',
      from: { id: 'txt_x', text: 'Notes: ❓ the export dialog forgets its last chosen folder between sessions' },
      to: { text: 'the export dialog remembers the folder now' } },
  ], { home });
  const raw = fs.readFileSync(provenanceFileFor(brain7, home), 'utf8');
  ok(!raw.includes('swordfish99') && !raw.includes('close it'), 'P7: the adjacent prompt never reaches disk as text');
  const rec = readJudgments(brain7, { home })[0];
  ok(/^[0-9a-f]{16}$/.test(rec.humanPrompt), 'P7: only the 16-hex fingerprint of the prompt is stored');
  ok(validateJudgment({ ...J(), actor: 'human-ui' }) !== null,
    'P7: human-ui is schema-reserved (valid) so a future app UI needs no format bump…');
  const stripCr = (s) => s.replace(/\r/g, '');
  const writers = ['src/global-brain-hook.mjs', 'src/klypix-core.mjs'].map(f =>
    stripCr(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))).join('\n');
  ok(!/actor:\s*'human-ui'/.test(writers), 'P7: …and no current writer claims it');
}

// ── P8 — doctor counts ──────────────────────────────────────────────────────
{
  // P3 rebuilt the sidecar from corrupt with one yes — add a no so both buckets serve.
  recordJudgments(brain, [J({ verdict: 'no', source: 'reconcile-dismiss' })], { home });
  const counts = provenanceCounts(brain, { home });
  ok(counts.judgments.total >= 2 && counts.judgments.byVerdict.yes >= 1 && counts.judgments.byVerdict.no >= 1,
    'P8: judgment totals by verdict serve');
  ok(counts.judgments.bySource['reconcile-confirm'] >= 1 && typeof counts.judgments.firstTs === 'number',
    'P8: counts by source + first-ts serve');
  ok(counts.rejected.total >= 6, 'P8: the rejected-pool size serves');
  const empty = provenanceCounts(path.join(path.dirname(brain), 'never-written.klypix'), { home });
  ok(empty.judgments.total === 0 && empty.rejected.total === 0 && empty.judgments.firstTs === null,
    'P8: a brain with no records reads as zero, never as an error');
}

// ── P9 — the designed writer call-sites exist (source-pinned) ───────────────
{
  const stripCr = (s) => s.replace(/\r/g, '');
  const hook = stripCr(fs.readFileSync(new URL('../src/global-brain-hook.mjs', import.meta.url), 'utf8'));
  const core = stripCr(fs.readFileSync(new URL('../src/klypix-core.mjs', import.meta.url), 'utf8'));
  const worker = stripCr(fs.readFileSync(new URL('../bin/klypix-worker.mjs', import.meta.url), 'utf8'));
  const doctor = stripCr(fs.readFileSync(new URL('../src/brain-doctor.mjs', import.meta.url), 'utf8'));
  const enrich = stripCr(fs.readFileSync(new URL('../src/enrichment.mjs', import.meta.url), 'utf8'));
  for (const source of ['marker-closes', 'marker-resolve', 'hint-settle', 'draft-promotion', 'draft-decay']) {
    ok(hook.includes(`'${source}'`), `P9: the hook writes source '${source}'`);
  }
  for (const source of ['reconcile-confirm', 'reconcile-dismiss', 'connect-dismiss', 'hint-settle']) {
    ok(core.includes(`'${source}'`), `P9: klypix-core writes source '${source}'`);
  }
  ok(/opBrainConnect\(\{[^}]*via: extra\.klypixClientName/.test(worker), 'P9: the worker passes the MCP client name into brain_connect');
  ok(/provenanceCounts/.test(doctor) && /JUDGMENTS/.test(doctor), 'P9: the doctor surfaces judgment counts');
  ok(/recordRejectedEnrichment/.test(enrich) && /rejected\+\+; discarded\.push/.test(enrich),
    'P9: the enrichment discard point forwards, with zero call-site changes');
}

// ── P10 — the Stop hook end to end ──────────────────────────────────────────
// A real `--capture` run over a transcript whose ✓ sits below a human prompt:
// the marker-resolve judgment lands with actor 'agent-human-adjacent' and a
// hash-only prompt fingerprint, and the settle the resolve caused lands as
// hint-settle. Source pins (P9) say the code exists; this proves it RUNS —
// the writers are try/caught, so a scope bug would otherwise fail silently.
{
  const { spawnSync } = await import('child_process');
  const { buildKlypixMap, addBrainConnections, parseKlypix } = await import('../src/klypix-format.mjs');
  const hookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-provenance-hook-home-'));
  const hookProj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-provenance-hook-proj-'));
  const brainHome = path.join(hookHome, '.claude', 'project-brain');
  fs.mkdirSync(brainHome, { recursive: true });
  fs.writeFileSync(path.join(brainHome, '.npm-currency.json'),
    JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
  const hookBrain = path.join(hookProj, 'brain.klypix');
  // buildKlypixMap so the cards live INSIDE a titled area container — the ✓
  // marker's [Notes] area filter has to actually match.
  fs.writeFileSync(hookBrain, await buildKlypixMap({ title: 'hook probe', areas: [{ title: 'Notes', cards: [
    { text: 'Notes: ❓ the export dialog forgets its last chosen folder between sessions' },
    { text: 'Notes: 🏁 the export dialog remembers its last chosen folder now' },
  ] }] }));
  const sP10 = (await parseKlypix(fs.readFileSync(hookBrain))).struct;
  const openId = (sP10.cards.find(c => /forgets its last chosen folder/.test(c.text || '')) || {}).id;
  const mileId = (sP10.cards.find(c => /remembers its last chosen folder/.test(c.text || '')) || {}).id;
  const hintedP10 = await addBrainConnections(fs.readFileSync(hookBrain), [
    { fromId: openId, toId: mileId, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
  ]);
  fs.writeFileSync(hookBrain, hintedP10.buffer);
  const transcript = path.join(hookHome, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ uuid: 'turn-0', message: { role: 'user', content: 'did the export dialog folder amnesia get fixed for real between sessions?' } }),
    JSON.stringify({ uuid: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes.\n🧠 BRAIN [Notes] ✓: the export dialog forgets its last chosen folder between sessions is fixed' }] } }),
  ].join('\n') + '\n');
  const { fileURLToPath } = await import('url');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/global-brain-hook.mjs', import.meta.url)), '--capture'], {
    cwd: hookProj, encoding: 'utf8',
    env: { ...process.env, HOME: hookHome, USERPROFILE: hookHome, KLYPIX_BRAIN_NUDGE: 'off' },
    input: JSON.stringify({ session_id: 'sess-p10', transcript_path: transcript }),
  });
  ok(/capture: /.test(String(run.stderr || '')), `P10: the hook captured (${String(run.stderr || '').split('\n').find(l => /capture:/.test(l)) || 'no capture line'})`);
  const hookJudgments = readJudgments(hookBrain, { home: hookHome });
  const mr = hookJudgments.find(j => j.source === 'marker-resolve');
  ok(!!mr && mr.verdict === 'yes' && mr.from.id === openId,
    'P10: the archived ✓ lands as a marker-resolve judgment naming the card id');
  ok(!!mr && mr.actor === 'agent-human-adjacent' && /^[0-9a-f]{16}$/.test(mr.humanPrompt || '') && mr.session === 'sess-p10',
    'P10: the adjacent human prompt upgrades the actor grade, hash-only, with the session id');
  const hs = hookJudgments.find(j => j.source === 'hint-settle');
  ok(!!hs && hs.from.id === openId && hs.to.id === mileId && hs.verdict === 'yes',
    'P10: the settle the resolve caused lands as a hint-settle judgment with both ids');
  const raw = fs.readFileSync(provenanceFileFor(hookBrain, hookHome), 'utf8');
  ok(!raw.includes('amnesia'), 'P10: the prompt text itself never reaches the sidecar');
  const { canvas: cP10 } = await parseKlypix(fs.readFileSync(hookBrain));
  const edge = (cP10.connections || []).find(cn => cn.fromId === openId && cn.toId === mileId);
  ok(!!edge && edge.label === 'closed by' && edge.hintVia === 'resolve',
    'P10: and the edge itself is settled with the honest marker grade');
  try { fs.rmSync(hookHome, { recursive: true, force: true }); } catch { /* temp */ }
  try { fs.rmSync(hookProj, { recursive: true, force: true }); } catch { /* temp */ }
}

// ── P11 — jid encoding is unambiguous under '|' in keys ─────────────────────
// normalizeForKey keeps pipes, so a '|'.join jid aliased two DISTINCT
// judgments onto one record and silently absorbed the second as a repeat
// (2026-09-29 review, reproduced). The JSON-array encoding cannot.
{
  const brain11 = path.join(path.dirname(brain), 'pipes.klypix');
  fs.writeFileSync(brain11, 'fixture');
  const A = 'alpha component owns the parser pipeline stage and its buffers';
  const B = 'beta component owns the renderer pipeline stage and its buffers';
  const C = 'gamma component owns the exporter pipeline stage and its buffers';
  const r11 = recordJudgments(brain11, [
    J({ from: { text: `${A}|${B}` }, to: { text: C } }),
    J({ from: { text: A }, to: { text: `${B}|${C}` } }),
  ], { home });
  ok(r11.recorded === 2 && r11.repeated === 0,
    'P11: two distinct pipe-bearing judgments record as TWO records, never one absorbed repeat');
  ok(readJudgments(brain11, { home }).length === 2, 'P11: both survive on disk');
}

// ── P12 — concurrent writers merge, never interleave-lose ───────────────────
// The no-TTL premise ("labels whose value grows with age") dies if a lost
// read-modify-write can wipe them. Probe that forced the lock: two 200-record
// writers lost ~half of all records and once left the sidecar ABSENT
// (2026-09-29 review, reproduced pre-fix).
{
  const { spawn } = await import('child_process');
  const brain12 = path.join(path.dirname(brain), 'concurrent.klypix');
  fs.writeFileSync(brain12, 'fixture');
  const childSrc = [
    `import { recordJudgments } from ${JSON.stringify(new URL('../src/provenance.mjs', import.meta.url).href)};`,
    'const [brain, home, tag] = process.argv.slice(2);',
    'let recorded = 0, repeated = 0;',
    'for (let b = 0; b < 30; b++) {',
    '  const entries = [];',
    '  for (let k = 0; k < 5; k++) {',
    '    const i = b * 5 + k;',
    "    entries.push({ kind: 'pair', direction: 'fulfills', verdict: 'yes', source: 'reconcile-confirm', actor: 'agent-listing-bound',",
    '      from: { id: `txt_${tag}_${i}` }, to: { id: `txt_${tag}_mile_${i}` } });',
    '  }',
    '  const r = recordJudgments(brain, entries, { home });',
    '  recorded += r.recorded; repeated += r.repeated;',
    '}',
    'console.log(JSON.stringify({ recorded, repeated }));',
  ].join('\n');
  const childPath = path.join(path.dirname(brain12), 'concurrent-writer.mjs');
  fs.writeFileSync(childPath, childSrc);
  const runChild = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, brain12, home, tag], { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const [a, b] = await Promise.all([runChild('a'), runChild('b')]);
  const aRes = JSON.parse(a.out || '{}'), bRes = JSON.parse(b.out || '{}');
  ok(a.code === 0 && b.code === 0, `P12: both writers exit cleanly (${a.code}/${b.code})`);
  ok(aRes.recorded === 150 && bRes.recorded === 150,
    `P12: every batch write succeeds — no swallowed EPERM (${aRes.recorded}/${bRes.recorded})`);
  const file12 = provenanceFileFor(brain12, home);
  ok(fs.existsSync(file12), 'P12: the sidecar file exists after both writers exit');
  const final = readJudgments(brain12, { home });
  ok(final.length === 300, `P12: all 300 records survive the concurrent RMWs (${final.length})`);
  const leaked = fs.readdirSync(path.dirname(file12)).filter((n) => n.includes('.tmp-'));
  ok(leaked.length === 0, `P12: no leaked tmp files (${leaked.join(', ') || 'none'})`);
}

// ── P13 — drained-batch honesty: another session's markers, honest grade ────
// Scope 'all' (the NORMAL path) lands this session's markers PLUS batches an
// earlier session queued on a lock refusal. Pre-fix, those drained verdicts
// were stamped with THIS session's prompt hash, session id and
// 'agent-human-adjacent' — fabricated human adjacency for markers no prompt
// of this session sat above (2026-09-29 review, reproduced end-to-end).
{
  const { spawnSync } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const crypto13 = await import('crypto');
  const { buildKlypixMap, addBrainConnections, parseKlypix } = await import('../src/klypix-format.mjs');
  const hookPath = fileURLToPath(new URL('../src/global-brain-hook.mjs', import.meta.url));
  const sha16 = (s) => crypto13.createHash('sha1').update(s).digest('hex').slice(0, 16);
  // The hook's pending-queue file name: sha16 of the canonicalized brain path
  // (realpath, forward slashes, lowercased drive letter) — mirrored from
  // PENDING_CAPTURES_FILE / normBrainPath / laneCanon.
  const pendingFileFor = (home13, brainPath) => {
    let canon; try { canon = fs.realpathSync.native(brainPath); } catch { canon = path.resolve(brainPath); }
    const norm = String(canon).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
    return path.join(home13, '.claude', 'project-brain', 'pending', `${sha16(norm)}.captures.json`);
  };
  const OPEN_X = 'Notes: ❓ the export dialog forgets its last chosen folder between sessions';
  const MILE_X = 'Notes: 🏁 the export dialog remembers its last chosen folder now';
  const OPEN_Y = 'Notes: ❓ the vault tag filter hangs on giant boards during chunked decode';
  const RESOLVE_X = 'the export dialog forgets its last chosen folder between sessions is fixed';
  const RESOLVE_Y = 'the vault tag filter hangs on giant boards during chunked decode is fixed';
  const setup = async (label) => {
    const home13 = fs.mkdtempSync(path.join(os.tmpdir(), `klypix-provenance-drain-${label}-home-`));
    const proj13 = fs.mkdtempSync(path.join(os.tmpdir(), `klypix-provenance-drain-${label}-proj-`));
    const brain13 = path.join(proj13, 'brain.klypix');
    fs.writeFileSync(brain13, await buildKlypixMap({ title: 'drain probe', areas: [{ title: 'Notes', cards: [
      { text: OPEN_X }, { text: MILE_X }, { text: OPEN_Y },
    ] }] }));
    const s13 = (await parseKlypix(fs.readFileSync(brain13))).struct;
    const xId = (s13.cards.find(c => /forgets its last chosen folder/.test(c.text || '')) || {}).id;
    const xMileId = (s13.cards.find(c => /remembers its last chosen folder/.test(c.text || '')) || {}).id;
    const yId = (s13.cards.find(c => /vault tag filter hangs/.test(c.text || '')) || {}).id;
    const hinted13 = await addBrainConnections(fs.readFileSync(brain13), [
      { fromId: xId, toId: xMileId, relationship: 'relates_to', label: 'likely closed by', style: 'dashed' },
    ]);
    fs.writeFileSync(brain13, hinted13.buffer);
    // Session A's queued batch: its ✓ never landed (lock refusal), so its
    // resolution waits in the pending queue for the next capture to drain.
    const pending = pendingFileFor(home13, brain13);
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify([{
      id: 'batch-foreign-session', ts: new Date().toISOString(),
      cards: [], resolutions: [{ area: 'Notes', text: RESOLVE_X }], updates: [],
    }]));
    return { home13, proj13, brain13, xId, xMileId, yId };
  };
  const runHook = (home13, proj13, sid, transcriptLines) => {
    const transcript = path.join(home13, 'transcript.jsonl');
    fs.writeFileSync(transcript, transcriptLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return spawnSync(process.execPath, [hookPath, '--capture'], {
      cwd: proj13, encoding: 'utf8',
      env: { ...process.env, HOME: home13, USERPROFILE: home13, KLYPIX_BRAIN_NUDGE: 'off' },
      input: JSON.stringify({ session_id: sid, transcript_path: transcript }),
    });
  };
  // (a) MARKERLESS session B drains the queue: no record anywhere may claim
  //     human adjacency, B's session id, or B's prompt.
  {
    const { home13, proj13, brain13, xId, xMileId } = await setup('a');
    runHook(home13, proj13, 'sess-markerless-b', [
      { uuid: 'turn-0', message: { role: 'user', content: 'unrelated question about the weather in the harbour today' } },
      { uuid: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Nothing brain-worthy happened.' }] } },
    ]);
    const j = readJudgments(brain13, { home: home13 });
    const mrX = j.find((x) => x.source === 'marker-resolve' && x.from.id === xId);
    ok(!!mrX && mrX.actor === 'agent' && !mrX.session && !mrX.humanPrompt,
      'P13a: the drained ✓ is recorded with bare actor "agent" and NO session/prompt');
    const hsX = j.find((x) => x.source === 'hint-settle' && x.from.id === xId);
    ok(!!hsX && hsX.actor === 'agent' && hsX.to.id === xMileId && !hsX.session && !hsX.humanPrompt,
      'P13a: the settle the drained resolve caused carries the same honest grade');
    ok(!j.some((x) => x.actor === 'agent-human-adjacent') && !j.some((x) => x.session === 'sess-markerless-b'),
      'P13a: a markerless drain records ZERO human-adjacent or session-stamped judgments');
    try { fs.rmSync(home13, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(proj13, { recursive: true, force: true }); } catch { /* temp */ }
  }
  // (b) Session B has its OWN ✓ too (scope 'all', merged arrays): the human
  //     adjacency stamps exactly the own prefix, never the drained tail.
  {
    const { home13, proj13, brain13, xId, yId } = await setup('b');
    runHook(home13, proj13, 'sess-own-b', [
      { uuid: 'turn-0', message: { role: 'user', content: 'did the giant-board tag filter hang actually get fixed?' } },
      { uuid: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: `Yes.\n🧠 BRAIN [Notes] ✓: ${RESOLVE_Y}` }] } },
    ]);
    const j = readJudgments(brain13, { home: home13 });
    const own = j.find((x) => x.source === 'marker-resolve' && x.from.id === yId);
    ok(!!own && own.actor === 'agent-human-adjacent' && own.session === 'sess-own-b' && /^[0-9a-f]{16}$/.test(own.humanPrompt || ''),
      'P13b: this session\'s own ✓ keeps its earned adjacency, session and prompt hash');
    const drained = j.find((x) => x.source === 'marker-resolve' && x.from.id === xId);
    ok(!!drained && drained.actor === 'agent' && !drained.session && !drained.humanPrompt,
      'P13b: the drained ✓ in the SAME capture stays bare "agent" with no session/prompt');
    try { fs.rmSync(home13, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(proj13, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
try { fs.rmSync(path.dirname(brain), { recursive: true, force: true }); } catch { /* temp */ }
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ provenance: all assertions passed');
process.exit(failures ? 1 : 0);
