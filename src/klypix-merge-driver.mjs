#!/usr/bin/env node
// klypix-merge-driver — git merge driver for .klypix files.
//
// Wires the 3-way engine (./merge-brains.mjs — the one the app's
// merge-on-save and Brain Sync use) into git, so two people committing to one
// brain.klypix stop hitting manual binary conflicts: git calls this on
// conflict, the engine merges card by card, and both sides' cards survive —
// except a permanently deleted card's copies, which drop (an edited one is
// reported in the summary line; its text stays in the branch's history).
//
// git invokes it as:   node scripts/klypix-merge-driver.mjs %O %A %B %P
//   %O = common ancestor file   %A = ours (result is written HERE)
//   %B = theirs                 %P = real path (logging only)
// Exit 0 = merged; any failure exits 1, which leaves the normal binary
// conflict — i.e. exactly the behavior without this driver. Git's merge
// commit keeps both parents, so even a bad merge is always reconstructable.
//
// Registration is per-machine (git config is never committed):
//   npx klypix-mcp git-driver install     (any repo, zero setup — canonical)
//   npm run setup:merge-driver            (KLYPIX repo's local convenience)
// The KLYPIX desktop app also self-registers this silently when it opens a
// brain inside a git repo. .gitattributes routes *.klypix here; unregistered
// machines just get the old manual conflict. CANONICAL HOME: klypix-mcp/src —
// installs flatten it into ~/.claude/project-brain beside merge-brains.mjs.
//
// DELETE SEMANTICS (git context ≠ app context): merge-brains treats absence
// as NOT-a-delete (in the app, absence can be a deferred renderer apply) and
// drops cards only via explicit tombstones. In git, both sides are FULL
// COMMITTED snapshots, so "in ancestor, absent from a side" is a deliberate,
// committed delete. We honor it as a tombstone ONLY when the other side left
// the card untouched; if the other side EDITED it after the ancestor, no
// tombstone is passed and the edit survives: on the card itself when the
// deleting branch left no record, or as a new card (revivedIdFor) when its
// bin recorded the delete, so that receipt is never contradicted. A permanent
// delete is the exception: the edit drops, and the summary line says so.
//
// BIN-AWARE MERGE (E-10). Both sides are whole committed files, bins
// included, so the driver asks the engine for the same receipt-aware rules
// Brain Sync uses: the bins merge 3-way (a restore or a purge made on one
// branch propagates), a card new on both branches with different text keeps
// both, and the title merges 3-way. Same inputs, same result as the cloud
// path, so git and Brain Sync converge instead of fighting (F8). The engine is
// imported as a namespace and feature-checked: installs mix file generations,
// and an older merge-brains.mjs beside this driver must still merge (with its
// own rules) rather than fail — a failure here is a manual binary conflict.

import fs from 'node:fs';
import * as engine from './merge-brains.mjs';
import { parseKlypix, shard } from './klypix-format.mjs';

const { mergeBrains, sameMeaning } = engine;
// brain_doctor reads this constant from the installed file's TEXT (it never
// imports a driver) to tell one that asks for the bin-aware rules from one
// that cannot; test/git-tools.mjs pins DRIVER_OPTIONS the same way.
const DRIVER_OPTIONS_API = 2;
const DRIVER_OPTIONS = Object.freeze({
  binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true,
});
// Why a committed absence is a delete, recorded on the receipt it leaves.
const COMMITTED_ABSENCE = Object.freeze({
  initiator: 'unknown', cause: 'git-committed-absence', source: 'git-merge-driver', confidence: 'inferred',
});

// id -> verbatim item JSON string for one side (null for an empty/absent side).
async function itemsOf(buf) {
  if (!buf || buf.length === 0) return null;
  const { zip, canvas } = await parseKlypix(buf);
  const ids = new Set([...(Array.isArray(canvas.order) ? canvas.order : []), ...Object.keys(canvas.positions || {})]);
  const m = new Map();
  for (const id of ids) {
    const f = zip.file(`items/${shard(id)}/${id}.json`);
    m.set(id, f ? await f.async('string') : null);
  }
  return m;
}

const [, , oPath, aPath, bPath, realPath] = process.argv;
if (!oPath || !aPath || !bPath) {
  console.error('usage: klypix-merge-driver <ancestor> <ours> <theirs> [path]');
  process.exit(1);
}

try {
  const O = fs.readFileSync(oPath);           // may be 0 bytes (added on both sides)
  const A = fs.readFileSync(aPath);
  const B = fs.readFileSync(bPath);
  const base = O.length ? O : null;

  const [bi, ai, ti] = await Promise.all([itemsOf(base), itemsOf(A), itemsOf(B)]);

  // Committed-absence tombstones (see DELETE SEMANTICS above). Each carries a
  // receipt saying where it came from; a real receipt already in either
  // side's bin wins over this inferred one through the engine's entry choice.
  const deletedIds = [];
  const deletedMeta = {};
  const honor = (id) => { deletedIds.push(id); deletedMeta[id] = COMMITTED_ABSENCE; };
  if (bi && ai && ti) {
    for (const [id, baseJson] of bi) {
      const inA = ai.has(id), inB = ti.has(id);
      if (inA && inB) continue;                                   // alive on both
      if (!inA && !inB) { honor(id); continue; }                  // deleted on both
      // "Untouched" by MEANING, not bytes — a side that merely re-saved the
      // file restamps volatile fields (updatedAt), and a byte compare would
      // read that as an edit and silently refuse to propagate a real delete.
      const survivorJson = inA ? ai.get(id) : ti.get(id);
      if (sameMeaning(survivorJson, baseJson)) honor(id);         // delete vs untouched → honor
      // delete vs EDIT → no tombstone; union keeps the edited card
    }
  }

  // An engine older than the bin-aware rules (no api 2) merges with its own.
  const options = engine.MERGE_ENGINE_FEATURES?.api >= 2 ? DRIVER_OPTIONS : undefined;
  const { buffer, conflicts, delta, stats } = await mergeBrains({
    base, ours: A, theirs: B, deletedIds, deletedMeta, ...(options ? { options } : {}),
  });
  fs.writeFileSync(aPath, buffer);
  // Say what happened, and nothing it did not: a twin counts only when this
  // merge made it (not one a side already held, a conflict already resolved,
  // or one a person deleted), and an edit a purge took is named apart from
  // stale copies, because that text exists now only in the branch's history.
  const twinsMade = conflicts.filter((c) => c.twin && !c.existing && !c.suppressed && !c.adopted).length;
  const editsDropped = conflicts.filter((c) => c.kind === 'purge-vs-edit').length;
  const staleDropped = Math.max(0, (stats?.purgedCopies || 0) - editsDropped);
  const bits = [];
  if (delta.added.length) bits.push(`+${delta.added.length} card(s)`);
  if (deletedIds.length) bits.push(`-${deletedIds.length} delete(s) honored`);
  if (delta.revived?.length) bits.push(`~${delta.revived.length} revived`);
  if (staleDropped) bits.push(`${staleDropped} purged ${staleDropped === 1 ? 'copy' : 'copies'} dropped`);
  if (editsDropped) {
    bits.push(editsDropped === 1
      ? '1 edited copy of a permanently deleted card dropped (still in git history)'
      : `${editsDropped} edited copies of permanently deleted cards dropped (still in git history)`);
  }
  if (twinsMade) bits.push(`${twinsMade} conflict twin(s) preserved`);
  console.error(`klypix-merge: ${realPath || 'brain'} merged${bits.length ? ' — ' + bits.join(', ') : ''}`);
  process.exit(0);
} catch (e) {
  // Any failure → normal binary conflict, same as a machine without the driver.
  console.error(`klypix-merge: ${realPath || 'brain'} — falling back to manual conflict (${e?.message || e})`);
  process.exit(1);
}
