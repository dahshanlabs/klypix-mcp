#!/usr/bin/env node
// klypix-merge-driver — git merge driver for .klypix files.
//
// Wires the existing lossless 3-way engine (./merge-brains.mjs — the same one
// the app uses for merge-on-save) into git, so two people committing to one
// brain.klypix stop hitting manual binary conflicts: git calls this on
// conflict, the union merge runs, and both sides' cards survive.
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
// tombstone is passed and the union keeps the edited card (delete-vs-edit
// resolves to the edit — no-loss wins over delete).

import fs from 'node:fs';
import { mergeBrains } from './merge-brains.mjs';
import { parseKlypix, shard } from './klypix-format.mjs';

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

  // Committed-absence tombstones (see DELETE SEMANTICS above).
  const deletedIds = [];
  if (bi && ai && ti) {
    for (const [id, baseJson] of bi) {
      const inA = ai.has(id), inB = ti.has(id);
      if (inA && inB) continue;                                   // alive on both
      if (!inA && !inB) { deletedIds.push(id); continue; }        // deleted on both
      const survivorJson = inA ? ai.get(id) : ti.get(id);
      if (survivorJson === baseJson) deletedIds.push(id);         // delete vs untouched → honor
      // delete vs EDIT → no tombstone; union keeps the edited card
    }
  }

  const { buffer, conflicts, delta } = await mergeBrains({ base, ours: A, theirs: B, deletedIds });
  fs.writeFileSync(aPath, buffer);
  const bits = [];
  if (delta.added.length) bits.push(`+${delta.added.length} card(s)`);
  if (deletedIds.length) bits.push(`-${deletedIds.length} delete(s) honored`);
  if (conflicts.length) bits.push(`${conflicts.length} conflict twin(s) preserved`);
  console.error(`klypix-merge: ${realPath || 'brain'} united losslessly${bits.length ? ' — ' + bits.join(', ') : ''}`);
  process.exit(0);
} catch (e) {
  // Any failure → normal binary conflict, same as a machine without the driver.
  console.error(`klypix-merge: ${realPath || 'brain'} — falling back to manual conflict (${e?.message || e})`);
  process.exit(1);
}
