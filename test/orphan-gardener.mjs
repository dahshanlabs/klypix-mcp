// Orphan gardener (1.70.0) + truthful doctor version states.
//   PART A — proposeOrphanAnchorLinks: the CONFIDENT selector. One anchor max,
//            exact-or-nothing, ambiguity always loses (never guess among
//            multiple candidates), questions excluded (brainInsights parity).
//   PART B — capture: a new card that every existing pass leaves edge-less gets
//            its area-container edge (+ at most one anchor edge) — a capture
//            never mints a graph orphan.
//   PART C — the `orphans` backfill CLI: dry-run default writes NOTHING;
//            --apply links only the confident subset, takes a forced restore
//            point first, and reports measured before→after orphan counts.
//   PART D — doctor G4/G5/G6: installed>registry is AHEAD (a warning, never
//            "✓ current"), installed==registry is current, installed<registry
//            is stale/drift. `matches` keeps its legacy boolean semantics.
//
// Run:  node test/orphan-gardener.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildKlypixMap,
  parseKlypix,
  brainInsights,
  captureIntoBrain,
  proposeOrphanAnchorLinks,
} from '../src/klypix-format.mjs';
import { listBrainHistory } from '../src/brain-history.mjs';
import { inspect, render } from '../src/brain-doctor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORPHANS_BIN = path.join(__dirname, '..', 'bin', 'klypix-orphans.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const byFirstLine = (struct, needle) =>
  struct.cards.find(c => c.type !== 'container' && String(c.text || '').split('\n')[0].includes(needle));
const containerByTitle = (struct, title) =>
  struct.cards.find(c => c.type === 'container' && (c.title || '') === title);

// ── PART A — the confident selector ──────────────────────────────────────────
{
  const buf = await buildKlypixMap({
    title: 'brain',
    areas: [
      {
        title: 'Auth',
        cards: [
          { text: 'Session lock design\nthe advisory lock file protocol for concurrent writers' },
          { text: 'See also [[Session lock design]] for the lock protocol basis' },
          { text: 'Token refresh rotation flow keeps sliding expiry\n#auth-service-ts' },
          { text: 'Refresh token storage hardening uses DPAPI wrapping\n#auth-service-ts' },
          { text: 'Refresh failure recovery emits a visible receipt\n#auth-service-ts' },
        ],
      },
      {
        title: 'Impl',
        cards: [
          { text: 'Doctor render layer prints one verdict\n#brain-doctor-mjs' },
          { text: 'Doctor npm compare gains a relation field\n#brain-doctor-mjs' },
        ],
      },
      {
        title: 'Docs',
        cards: [
          { text: 'Merge driver contract notes' },
          { text: 'Merge driver contract notes alpha' },
          { text: 'Merge driver contract notes beta' },
        ],
      },
      { title: 'Canvas', cards: [{ text: '❓ should the capsule overlay anchor top-left on desktop?' }] },
      {
        // The field failure mode (real-brain review, 2026-08-14): truncated
        // 3-token titles sharing TWO brain-ubiquitous tokens hit exactly 0.67
        // and cleared the ratio bar alone — "JSON Canvas importer" anchored to
        // "TWO colour systems" via {klypix, canvas}. Two shared words are
        // never confident evidence.
        title: 'Field',
        cards: [
          { text: 'KLYPIX canvas importer' },
          { text: 'KLYPIX canvas theming' },
        ],
      },
    ],
  });
  const { struct } = await parseKlypix(buf);
  ok(struct.connections.length === 0, 'A: fixture starts with zero connections (everything is an orphan)');

  const props = proposeOrphanAnchorLinks(struct);
  const forCard = (needle) => props.find(p => p.cardId === byFirstLine(struct, needle)?.id);

  const wiki = forCard('See also');
  ok(!!wiki?.anchor && String(struct.cards.find(c => c.id === wiki.anchor.toId)?.text || '').startsWith('Session lock design'),
    'A: exact [[wikilink]] to exactly ONE matching title → that one anchor edge');
  ok(!!wiki && /\[\[/.test(wiki.anchor?.why || ''), 'A: wikilink anchor carries a [[...]] receipt');

  const slugA = forCard('Token refresh rotation');
  ok(!!slugA && slugA.anchor === null, 'A: a file-slug tag shared by THREE cards is ambiguous → NO anchor (never guess)');

  const slugOk = forCard('Doctor render layer');
  ok(!!slugOk?.anchor && struct.cards.find(c => c.id === slugOk.anchor.toId)?.text.includes('Doctor npm compare'),
    'A: a file-slug tag shared with exactly ONE other card → that one anchor edge');
  ok(/#brain-doctor-mjs/.test(slugOk?.anchor?.why || ''), 'A: slug anchor carries the tag as its receipt');

  const ambig = forCard('Merge driver contract notes alpha');
  ok(!!ambig && ambig.anchor === null, 'A: two title-overlap candidates ≥0.6 → ambiguous → NO anchor');

  const twoTok = forCard('KLYPIX canvas importer');
  ok(!!twoTok && twoTok.anchor === null,
    'A: a 0.67 ratio built from only TWO shared tokens is a guess → NO anchor (≥3 shared tokens required)');
  ok(!!twoTok?.areaId, 'A: the two-token orphan still gets its area-container edge');

  ok(props.every(p => p.areaId), 'A: every orphan proposal carries its area-container edge');
  const auth = containerByTitle(struct, 'Auth');
  ok(forCard('See also')?.areaId === auth?.id, 'A: the area edge points at the card\'s OWN container');

  const question = byFirstLine(struct, '❓ should the capsule');
  ok(!props.some(p => p.cardId === question?.id), 'A: open questions are excluded (brainInsights orphan parity)');

  // Never fan out: at most one anchor per proposal by construction.
  ok(props.every(p => !p.anchor || (p.anchor && typeof p.anchor.toId === 'string')), 'A: at most one anchor edge per card');
}

// ── PART B — capture never mints a graph orphan ──────────────────────────────
{
  const base = await buildKlypixMap({
    title: 'brain',
    areas: [
      { title: 'Decisions', cards: [{ text: 'Retrieval fusion rank blending\nreciprocal rank fusion across lexical and semantic lanes\n#retrieval' }] },
      { title: 'Notes', cards: [{ text: 'The eval harness prints its pooling contract line every run' }] },
    ],
  });

  // A card with NO wikilink, NO tag, NO title overlap → area edge only.
  const r1 = await captureIntoBrain(base, { cards: [{ text: 'Pipeline cache eviction uses LRU with a fourteen day floor', area: 'Notes' }] });
  const s1 = (await parseKlypix(r1.buffer)).struct;
  const added1 = byFirstLine(s1, 'Pipeline cache eviction');
  const notes = containerByTitle(s1, 'Notes');
  ok(!!added1 && s1.connections.some(cn => (cn.fromId === added1.id && cn.toId === notes.id)),
    'B: an anchor-less capture gets its area-container edge (label "in area")');
  ok(s1.connections.filter(cn => cn.fromId === added1.id || cn.toId === added1.id).length === 1,
    'B: no fan-out — exactly one edge for an anchor-less card');
  ok(!brainInsights(s1).orphans.some(o => o.id === added1.id), 'B: the captured card is NOT a graph orphan');
  ok(r1.stats.orphanLinked >= 1, 'B: stats.orphanLinked reports the gardener acted (additive field)');

  // A card whose TITLE unambiguously overlaps ONE existing card (cross-area, so
  // no supersede fires) → one anchor edge + the area edge.
  const r2 = await captureIntoBrain(r1.buffer, { cards: [{ text: 'Retrieval fusion rank blending update', area: 'Notes' }] });
  const s2 = (await parseKlypix(r2.buffer)).struct;
  const added2 = byFirstLine(s2, 'Retrieval fusion rank blending update');
  const target = s2.cards.find(c => c.type !== 'container' && /reciprocal rank fusion/.test(c.text || ''));
  ok(!!added2 && !!target && s2.connections.some(cn =>
    (cn.fromId === added2.id && cn.toId === target.id) || (cn.fromId === target.id && cn.toId === added2.id)),
    'B: an unambiguous ≥0.6 title overlap draws exactly that one anchor edge');
  ok(!/^archive$/i.test(target.area || ''), 'B: the anchor target was NOT archived (additive, no supersede side-effect)');
  // The two NEW cards are linked; the anchor edge also repaired the pre-existing
  // retrieval card. Only the untouched pre-existing eval-harness card remains an
  // orphan — capture links what IT adds, never silently rewires history.
  const remaining = brainInsights(s2).orphans;
  ok(remaining.length === 1 && /eval harness/.test(remaining[0].headline || ''),
    'B: no NEW card is an orphan; pre-existing cards are left for the backfill CLI');
}

// ── PART C — the backfill CLI (dry-run default, --apply with restore point) ──
{
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-orphan-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-orphan-home-'));
  const file = path.join(vault, 'brain.klypix');
  try {
    const buf = await buildKlypixMap({
      title: 'brain',
      areas: [{
        title: 'Auth',
        cards: [
          { text: 'Session lock design\nthe advisory lock file protocol' },
          { text: 'See also [[Session lock design]] for the lock protocol basis' },
          { text: 'Completely unrelated orphan about coffee brewing temperature control' },
        ],
      }],
    });
    fs.writeFileSync(file, buf);
    const bytesBefore = fs.readFileSync(file);
    const env = { ...process.env, USERPROFILE: home, HOME: home };

    const dry = execFileSync(process.execPath, [ORPHANS_BIN, file], { encoding: 'utf8', env });
    ok(/DRY RUN/.test(dry) && /Orphans now: 3/.test(dry), 'C: dry run is the default and reports the measured orphan count');
    ok(/Confident subset: 1/.test(dry), 'C: dry run names the confident subset (1 wikilink anchor)');
    ok(Buffer.compare(bytesBefore, fs.readFileSync(file)) === 0, 'C: dry run writes NOTHING (bytes identical)');

    const applied = execFileSync(process.execPath, [ORPHANS_BIN, file, '--apply'], { encoding: 'utf8', env });
    ok(/Drew 1 additive connection/.test(applied), 'C: --apply draws exactly the confident subset');
    // The one anchor edge joins TWO orphans — both endpoints are repaired.
    ok(/3 → 1/.test(applied), 'C: --apply reports the measured before→after orphan receipt (both endpoints repaired)');
    const after = (await parseKlypix(fs.readFileSync(file))).struct;
    ok(brainInsights(after).orphans.length === 1, 'C: orphan count measured on disk drops 3 → 1');
    ok(after.cards.some(c => /coffee brewing/.test(c.text || '') && !/^archive$/i.test(c.area || '')),
      'C: the unconfident orphan is left exactly as it was (no archive, no guess)');
    const points = listBrainHistory(file, { home });
    ok(points.length >= 1 && points.some(p => (p.reason || '') === 'orphan-backfill'),
      'C: a FORCED restore point lands before the write (reason orphan-backfill)');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── PART D — doctor: ahead / current / stale (G4/G5/G6) ──────────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-doctor-rel-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-doctor-proj-'));
  try {
    const brainDir = path.join(home, '.claude', 'project-brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '1.70.0'; // baked\n");

    // G4 — installed > registry: AHEAD, a warning, never "✓ current".
    const ahead = inspect({ home, projectDir: project, npmLatest: '1.69.0' });
    ok(ahead.npm.relation === 'ahead', 'G4: installed 1.70.0 > registry 1.69.0 → relation "ahead"');
    ok(ahead.npm.matches === true, 'G4: legacy `matches` boolean keeps its historical semantics (additive change)');
    ok(ahead.layers.version === 'ok', 'G4: ahead is a warning, NOT machine drift (dev deploys must not fail CI gates)');
    const aheadOut = render(ahead, { color: false });
    ok(/AHEAD of npm/.test(aheadOut) && /UNRELEASED/.test(aheadOut), 'G4: render says AHEAD / unreleased');
    ok(!/✓ current/.test(aheadOut), 'G4: render never says "✓ current" while ahead');
    ok(/\[!\]\s+VERSION/.test(aheadOut), 'G4: the VERSION line carries the warning mark');
    ok(ahead.actions.some(a => /UNRELEASED/.test(a)), 'G4: reconcile block names the unreleased state');

    // G5 — installed == registry: current.
    const current = inspect({ home, projectDir: project, npmLatest: '1.70.0' });
    ok(current.npm.relation === 'current' && current.npm.matches === true, 'G5: installed == registry → "current"');
    ok(/✓ current/.test(render(current, { color: false })), 'G5: render says ✓ current only when truly current');

    // G6 — installed < registry: stale, the existing drift path unchanged.
    const stale = inspect({ home, projectDir: project, npmLatest: '1.71.0' });
    ok(stale.npm.relation === 'stale' && stale.npm.matches === false, 'G6: installed < registry → "stale", matches false');
    ok(stale.layers.version === 'drift', 'G6: stale still counts as version drift (behavior preserved)');
    ok(/installed brain is behind/.test(render(stale, { color: false })), 'G6: render keeps the behind warning');
    ok(stale.actions.some(a => /npx klypix-mcp install/.test(a) && /1\.71\.0/.test(a)), 'G6: reconcile still prescribes install');

    // Offline sentinel stays undecidable, not wrong.
    const offline = inspect({ home, projectDir: project, npmLatest: '(offline)' });
    ok(offline.npm.matches === null && offline.npm.relation === null, 'D: "(offline)" sentinel → relation null (no false verdicts)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ orphan-gardener: all assertions passed');
