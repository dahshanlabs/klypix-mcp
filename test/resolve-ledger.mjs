// The Stop hook's ledger tells the truth about a repeated ✓.
//
// ✓ and ~ markers deliberately BYPASS the hook's seen-dedup: that bypass is
// what lets a self-heal ~ re-stamp a drifted fact whose text never changed, and
// it is KEPT. What it rested on was the claim that a resolve is idempotent —
// true for a full resolve, which archives its card, and false for a PARTIAL
// one, which leaves the card live by design. 1.85.0 made it true again in the
// engine (a note the card already carries is skipped), and this suite is the
// other half: the receipt has to SAY that rather than print `resolve` and let a
// reader believe a fresh stamp landed.
//
//   R1  a ✓ that only partially covers a clause writes the note once, the
//       card stays open, and the ledger says `resolve-partial`.
//   R2  THE POINT: replaying the SAME marker on the next Stop changes nothing,
//       the stderr receipt says "✔ partial already noted", and the ledger
//       entry reads `resolve-partial-skipped`, not `resolve`.
//   R3  the bypass itself is intact — the marker was never dropped as
//       `skipped-seen`, which is what would break the self-heal loop.
//   R4  a ✓ that resolves WHOLE still reads `resolve` and archives.
//   R5  one ✓ can hit several near-tie twins, so the ledger reports the
//       STRONGEST outcome — an archive is never filed as a skipped partial.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix, partialNoteRuns } from '../src/klypix-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-resolve-ledger-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-resolve-ledger-proj-'));
const brainHome = path.join(home, '.claude', 'project-brain');
fs.mkdirSync(brainHome, { recursive: true });
// Throttle the Stop hook's once-a-day npm currency refresh → zero network.
fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));

const BRAIN = path.join(proj, 'brain.klypix');
fs.writeFileSync(BRAIN, await buildKlypixMap({
  title: 'brain',
  areas: [{
    title: 'Canvas',
    cards: [{ text: 'Canvas: ❓ remaining: ship the arrow tool for the connection palette + rewrite the lasso hit testing for rotated groups' }],
  }],
}));

// One assistant turn carrying a ✓ marker, exactly as the harvester reads it.
const MARKER = '🧠 BRAIN [Canvas] ✓: ship the arrow tool for the connection palette';
const WHOLE = '🧠 BRAIN [Canvas] ✓: the capsule header auto-fit clipping at low zoom is fixed';
const transcript = path.join(home, 'transcript.jsonl');
const writeTranscript = (texts) => fs.writeFileSync(
  transcript,
  texts.map(t => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } })).join('\n') + '\n',
);

// The hook writes its receipts to stderr and exits 0, so spawnSync (not
// execFileSync) is what hands stderr back in both cases.
const spawnCapture = (sessionSuffix) => {
  const r = spawnSync(process.execPath, [HOOK, '--capture'], {
    cwd: proj, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_BRAIN_NO_MAIN: '' },
    input: JSON.stringify({ session_id: `sess-${sessionSuffix}`, transcript_path: transcript }),
  });
  return String(r.stderr || '');
};

const ledgerEntries = () => {
  const f = path.join(proj, '.claude', 'brain-capture-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const decisions = () => ledgerEntries().flatMap(e => e.decisions || []);
const cardText = async () => {
  const { struct } = await parseKlypix(fs.readFileSync(BRAIN));
  const c = struct.cards.find(x => /remaining: ship the arrow/.test(flat(x.text)));
  return { card: c, struct };
};

// ── R1 — first Stop ─────────────────────────────────────────────────────────
writeTranscript([`Wired the arrow tool.\n${MARKER}`]);
const err1 = spawnCapture('r1');
const first = await cardText();
ok(!!first.card, 'R1 the open card is still in the brain');
ok(partialNoteRuns(first.card.text).length === 1, `R1 one ✔ partial note after the first Stop (${partialNoteRuns(first.card.text).length})`);
ok(!/^archive$/i.test(first.card.area || ''), 'R1 the card stays OPEN — that is the partial-clause rule, not a failure');
ok(decisions().some(d => d.action === 'resolve-partial'), `R1 the ledger records the first pass as \`resolve-partial\` [${decisions().map(d => d.action).join(', ')}]`);
ok(!/partial already noted/.test(err1), 'R1 nothing is reported as already noted on the first pass');

// ── R2/R3 — the SAME marker on the next Stop ────────────────────────────────
const err2 = spawnCapture('r2');
const second = await cardText();
ok(partialNoteRuns(second.card.text).length === 1, `R2 THE POINT: still ONE ✔ partial note after the replay (${partialNoteRuns(second.card.text).length})`);
ok(flat(second.card.text) === flat(first.card.text), 'R2 the card content is unchanged by the replay');
ok(/✔ partial already noted/.test(err2), `R2 the stderr receipt says what happened [${(err2.split('\n').find(l => /partial already noted/.test(l)) || '').slice(0, 120)}]`);
ok(/nothing was re-stamped/i.test(err2), 'R2 …and says explicitly that nothing was re-stamped');
const after = decisions();
ok(after.some(d => d.action === 'resolve-partial-skipped'), 'R2 the ledger action is `resolve-partial-skipped`, not `resolve`');
ok(!after.some(d => d.action === 'skipped-seen' && /arrow tool/.test(d.preview || '')), 'R3 the ✓ was NOT dropped by the seen-dedup — the bypass is intact');

// ── R4 — a whole resolve still reads `resolve` ──────────────────────────────
{
  writeTranscript([`Fixed the capsule header.\n🧠 BRAIN [Canvas]: the capsule header auto-fit clipping at low zoom is a real defect on the brain board`]);
  spawnCapture('r4a');
  writeTranscript([`Confirmed.\n${WHOLE}`]);
  const err4 = spawnCapture('r4b');
  const d = decisions();
  ok(d.some(x => x.action === 'resolve'), 'R4 a whole resolve still reads `resolve` in the ledger');
  ok(!/partial already noted/.test(err4), 'R4 and is never reported as an already-noted partial');
  const { struct: s4 } = await parseKlypix(fs.readFileSync(BRAIN));
  ok(s4.cards.some(c => c.type !== 'container' && /^archive$/i.test(c.area || '')), 'R4 the whole resolve actually archived its card');
}

// ── R5 — near-tie twins: the ledger reports the STRONGEST outcome ───────────
// 2026-09-16 review. The engine resolves up to THREE near-tie candidates for one
// ✓ and calls outcomeOf() once per candidate, so stats.resolutionOutcomes can
// carry several entries with the same `i`. Building the lookup by overwrite kept
// the LAST, so a ✓ that ARCHIVED twin A while twin B already carried its note
// was filed as `resolve-partial-skipped` and the receipt said "nothing was
// re-stamped" about a card that had just been archived — TASK C's misreporting,
// in the other direction. Receipt-only, but the receipt is the product here.
{
  const home5 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-resolve-ledger-home5-'));
  const proj5 = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-resolve-ledger-proj5-'));
  fs.mkdirSync(path.join(home5, '.claude', 'project-brain'), { recursive: true });
  fs.writeFileSync(path.join(home5, '.claude', 'project-brain', '.npm-currency.json'),
    JSON.stringify({ pkg: 'klypix-mcp', latest: '99.0.0', checkedAt: Date.now() }));
  const BODY = 'ship the arrow tool for the connection palette';
  const brain5 = path.join(proj5, 'brain.klypix');
  fs.writeFileSync(brain5, await buildKlypixMap({
    title: 'brain',
    areas: [{
      title: 'Canvas',
      cards: [
        // Twin A — no clause tail, so the ✓ resolves it WHOLE and archives it.
        { text: `Canvas: ❓ ${BODY}` },
        // Twin B — a two-item clause that ALREADY carries this exact note.
        { text: `Canvas: ❓ remaining: ${BODY} + rewrite the lasso hit testing for rotated groups\n✔ partial 2026-09-01: ${BODY}` },
      ],
    }],
  }));
  const transcript5 = path.join(home5, 'transcript.jsonl');
  fs.writeFileSync(transcript5, JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: `Shipped it.\n🧠 BRAIN [Canvas] ✓: ${BODY}` }] },
  }) + '\n');
  const r5 = spawnSync(process.execPath, [HOOK, '--capture'], {
    cwd: proj5, encoding: 'utf8',
    env: { ...process.env, HOME: home5, USERPROFILE: home5, KLYPIX_BRAIN_NUDGE: 'off', KLYPIX_BRAIN_NO_MAIN: '' },
    input: JSON.stringify({ session_id: 'sess-r5', transcript_path: transcript5 }),
  });
  const { struct: s5 } = await parseKlypix(fs.readFileSync(brain5));
  const archivedCount = s5.cards.filter(c => c.type !== 'container' && /^archive$/i.test(c.area || '')).length;
  const log5 = path.join(proj5, '.claude', 'brain-capture-log.jsonl');
  const d5 = (fs.existsSync(log5) ? fs.readFileSync(log5, 'utf8') : '').split('\n').filter(Boolean)
    .flatMap(l => { try { return JSON.parse(l).decisions || []; } catch { return []; } });
  const actions = d5.map(x => x.action);
  ok(archivedCount === 1, `R5 (one twin really was archived by this ✓) [${archivedCount}]`);
  ok(actions.includes('resolve'), `R5 THE POINT: the ledger reports the archive, not the skipped twin [${actions.join(', ')}]`);
  ok(!actions.includes('resolve-partial-skipped'), 'R5 the weaker outcome does not overwrite the stronger one');
  const err5 = String(r5.stderr || '');
  ok(/1 resolved/.test(err5), `R5 the stderr receipt reports the archive [${(err5.split('\n').find(l => /capture:/.test(l)) || '').slice(0, 120)}]`);
  // The skip line may still appear — a card really was already noted — but it
  // must name CARDS, not claim the whole marker did nothing.
  ok(!/✓ marker\(s\) matched a card that already carries/.test(err5),
    'R5 …and does not report the marker itself as a no-op');
  for (const d of [home5, proj5]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ } }
}

for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ } }
console.log(failures ? `\n${failures} failure(s)` : '\n✓ resolve-ledger: all assertions passed');
process.exit(failures ? 1 : 0);
