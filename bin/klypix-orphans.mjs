#!/usr/bin/env node
// klypix-orphans — `npx klypix-mcp orphans`. The orphan gardener's backfill pass:
// report how many live decision/milestone cards have NO connections, and link the
// CONFIDENT subset in one pass using the same selector capture uses
// (proposeOrphanAnchorLinks): at most ONE lexical-anchor edge per card — exact
// [[wikilink]], exact file-slug tag, or an unambiguous ≥0.6 title overlap —
// never a fan-out, never a guess among multiple candidates.
//
//   npx klypix-mcp orphans [brain]        # DRY RUN (default) — report, write nothing
//   npx klypix-mcp orphans --apply        # draw the confident edges (restore point first)
//   npx klypix-mcp orphans --areas        # ALSO include each orphan's area-container edge
//   npx klypix-mcp orphans --json         # machine-readable report
//
// Contract: additive + lossless — no card is archived, rewritten, or moved; every
// arrow remains individually removable in KLYPIX. `--apply` takes a FORCED restore
// point via the brain-history machinery before writing, so the whole pass is one
// `brain-history restore` away from undone. Dry-run is the default because a
// backfill touches history, not just this session's capture.
//
// `--areas` is opt-in for backfill (unlike capture, where the area edge is part
// of the no-new-orphans contract): mass-adding hundreds of containment edges to
// an old brain is a layout decision the human should make deliberately.
//
// Synchronous top-level by design: the dispatcher does `await import(this);
// process.exit(0)`, so all work must complete during module evaluation. ARGV is
// the standalone shape — the dispatcher splices its verb out first (runVerb).
import fs from 'fs';
import path from 'path';
import { parseKlypix, brainInsights, proposeOrphanAnchorLinks, addBrainConnections, atomicWrite } from '../src/klypix-format.mjs';
import { snapshotBrain } from '../src/brain-history.mjs';
import { withAdvisoryWriteLock, brainCaptureLockPath } from '../src/brain-write-lock.mjs';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

try {
  const raw = process.argv.slice(2);
  const argv = (raw[0] === 'orphans' && !isDir(path.resolve(raw[0]))) ? raw.slice(1) : raw;
  const apply = argv.includes('--apply');
  const withAreas = argv.includes('--areas');
  const json = argv.includes('--json');
  const pathArg = argv.find(a => !a.startsWith('-'));
  const file = path.resolve(process.cwd(), pathArg || 'brain.klypix');
  if (!fs.existsSync(file)) {
    console.error(`No brain at ${file} — run from the project folder (or pass a path).`);
    process.exit(1);
  }

  const { struct } = await parseKlypix(fs.readFileSync(file));
  const before = brainInsights(struct).orphans;
  const byId = new Map(struct.cards.map(c => [c.id, c]));
  const flat = (id) => {
    const c = byId.get(id);
    if (!c) return id;
    const s = c.type === 'container' ? `[area] ${c.title || ''}` : String(c.text || '').replace(/\s+/g, ' ').trim();
    return s.slice(0, 70);
  };

  const proposals = proposeOrphanAnchorLinks(struct);
  const anchored = proposals.filter(p => p.anchor);
  // The confident subset: anchor edges always; area edges only with --areas.
  // Reversed twins (A anchors B, B anchors A) collapse to ONE edge here so the
  // dry-run list, the drawn count, and the apply receipt all agree exactly.
  const seenPair = new Set();
  const edges = [];
  for (const p of proposals) {
    if (p.anchor) {
      const key = [p.cardId, p.anchor.toId].sort().join('|');
      if (!seenPair.has(key)) {
        seenPair.add(key);
        edges.push({ fromId: p.cardId, toId: p.anchor.toId, relationship: 'relates_to', label: 'auto', why: p.anchor.why });
      }
    }
    if (withAreas && p.areaId) edges.push({ fromId: p.cardId, toId: p.areaId, relationship: 'relates_to', label: 'in area', color: 'rgba(120,120,135,0.45)', width: 1, style: 'dashed', why: 'area container' });
  }
  // An anchor edge between two orphans repairs BOTH endpoints — project on the
  // orphan set, not just the source card.
  const orphanIdSet = new Set(before.map(o => o.id));
  const repairable = new Set();
  for (const e of edges) {
    if (orphanIdSet.has(e.fromId)) repairable.add(e.fromId);
    if (orphanIdSet.has(e.toId)) repairable.add(e.toId);
  }
  const projected = Math.max(0, before.length - repairable.size);

  if (json && !apply) {
    console.log(JSON.stringify({
      brain: file, dryRun: true, orphans: before.length, confident: anchored.length,
      projectedOrphans: projected,
      edges: edges.map(e => ({ fromId: e.fromId, toId: e.toId, label: e.label, why: e.why })),
    }, null, 2));
    process.exit(0);
  }

  if (!apply) {
    console.log(`# orphan gardener — ${path.basename(file)} (DRY RUN, nothing written)`);
    console.log('');
    console.log(`Orphans now: ${before.length} live decision/milestone card(s) with no connections.`);
    console.log(`Confident subset: ${anchored.length} card(s) have exactly one unambiguous lexical anchor${withAreas ? `; --areas adds ${proposals.filter(p => p.areaId).length} area-container edge(s)` : ''}.`);
    console.log(`Projected after --apply: ${projected} orphan(s) remain (the rest need brain_connect review or a human).`);
    if (edges.length) {
      console.log('');
      for (const e of edges) console.log(`  - ${flat(e.fromId)}  →  ${flat(e.toId)}  (${e.why})`);
      console.log('');
      console.log('Re-run with --apply to draw these. Additive only: no card is archived or rewritten;');
      console.log('a forced restore point is taken first (undo: npx klypix-mcp brain-history).');
    } else {
      console.log('');
      console.log(before.length
        ? 'No edge clears the confidence bar — review the rest with brain_connect (dry-run receipts).'
        : 'Nothing to do — this brain has no orphaned decision/milestone cards.');
    }
    process.exit(0);
  }

  if (!edges.length) {
    console.log(before.length
      ? `No edge clears the confidence bar — ${before.length} orphan(s) remain for brain_connect review. Nothing written.`
      : 'Nothing to do — this brain has no orphaned decision/milestone cards. Nothing written.');
    process.exit(0);
  }

  // APPLY — one locked snapshot + read-modify-write. The restore point is taken
  // INSIDE the advisory lock (forced: an additive pass never trips the shrink
  // rule, and the throttle must not skip the one snapshot that makes a whole
  // backfill reversible): taken outside it, a concurrent capture landing between
  // snapshot and write would be silently rolled back by a later restore.
  let snap = null;
  const result = await withAdvisoryWriteLock(brainCaptureLockPath(file), async (locked) => {
    if (!locked) return { ok: false, error: 'brain is busy (another writer holds the capture lock) — retry in a moment; nothing written' };
    snap = snapshotBrain(file, { reason: 'orphan-backfill', force: true });
    const { buffer, added } = await addBrainConnections(fs.readFileSync(file), edges);
    if (!added) return { ok: true, added: 0, after: before.length };
    await atomicWrite(file, buffer, { snapshot: false });   // the forced pre-apply snapshot above is the restore point
    let after = projected;
    try { after = brainInsights((await parseKlypix(buffer)).struct).orphans.length; } catch { /* projected stays the honest fallback */ }
    return { ok: true, added, after };
  });
  if (!result.ok) { console.error(`✗ ${result.error}`); process.exit(1); }

  // A drawn count below the planned count means the brain changed between the
  // dry-run read and the locked write (a pair already present, an endpoint
  // gone) — slicing the planned list by count would then name the WRONG edges,
  // so the per-edge list is only printed when it is exact.
  const exact = result.added === edges.length;
  // An 'unchanged' skip means the newest restore point already holds these
  // exact bytes — the pass is just as reversible as a fresh snapshot.
  const covered = snap && (snap.saved || snap.skipped === 'unchanged');
  if (json) {
    console.log(JSON.stringify({
      brain: file, dryRun: false, added: result.added,
      orphansBefore: before.length, orphansAfter: result.after,
      restorePoint: covered ? (snap.id || true) : null,
      edges: exact ? edges.map(e => ({ fromId: e.fromId, toId: e.toId, label: e.label, why: e.why })) : null,
      ...(exact ? {} : { edgesNote: `${edges.length - result.added} planned edge(s) were skipped (already present or endpoint missing) — re-run the dry run for the current pair list` }),
    }, null, 2));
    process.exit(0);
  }
  console.log(`✓ Drew ${result.added} additive connection(s). Orphan receipt: ${before.length} → ${result.after} (${Math.max(0, before.length - result.after)} repaired).`);
  console.log(covered
    ? 'Restore point taken first — undo the whole pass: npx klypix-mcp brain-history'
    : 'Restore point: not saved (best-effort) — arrows remain individually removable in KLYPIX.');
  if (exact) for (const e of edges) console.log(`  - ${flat(e.fromId)}  →  ${flat(e.toId)}  (${e.why})`);
  else console.log(`  (${edges.length - result.added} planned edge(s) were already present or lost an endpoint — re-run the dry run for the current pair list)`);
  process.exit(0);
} catch (e) {
  console.error(`✗ orphans failed (brain unchanged): ${e?.message || e}`);
  process.exit(1);
}
