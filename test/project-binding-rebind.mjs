// 2026-08-16 — the routing-rebind regression.
//
// FIELD INCIDENT: a 13-hour release-coordination session lost brain_note,
// brain_message, brain_message_receipt, brain_ask and every other verb for its
// entire run. Each call returned "KLYPIX project routing changed after
// brain_sync"; each brain_sync immediately before it SUCCEEDED and reported the
// correct project.
//
// MECHANISM: the cross-call guard pins the brain FILE's identity
// (dev:ino:mode:birthtimeNs). Every managed brain write is writeFileSync(tmp) +
// renameSync(tmp, target) — an atomic replace, which mints a NEW inode. So any
// legitimate write by anyone (a peer session, this session's own Stop hook
// harvesting a marker, the desktop app's merge-on-save) retires the pinned
// identity. That part is by design.
//
// The DEFECT is that nothing re-adopted the new identity. currentProjectBinding
// was assigned exactly once per (worker, project) inside start(); a same-project
// re-sync takes the touch() branch, which never reassigned it, and start()'s own
// early return bailed before its assignment. sync() measured a fresh,
// triple-validated binding in its preflight and then discarded it. The only
// refresh path ran AFTER a successful non-brain_sync handler — i.e. behind the
// very gate that was failing. Deadlock, permanent for the life of the worker.
//
// Minimum concurrency to trigger: ZERO peers. One solo session bricks itself the
// first time its own Stop hook writes the brain.
//
// R1 locks the repair. R2 keeps the guard honest — re-adoption must follow the
// SAME canonical project, never silently adopt a different one.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildKlypixMap } from '../src/klypix-core.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-rebind-'));
const project = path.join(tmpRoot, 'proj');
fs.mkdirSync(project, { recursive: true });

const brainBuf = await buildKlypixMap({
  title: 'brain',
  areas: [{ title: 'Goal', cards: [{ text: 'lock the routing rebind' }] }],
});
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, brainBuf);

// Exactly what src/klypix-format.mjs atomicWrite does for EVERY managed write.
const atomicRewrite = (target) => {
  const tmp = `${target}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, fs.readFileSync(target));
  fs.renameSync(tmp, target);
};

const identityOf = (p) => {
  const s = fs.statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}:${s.mode}:${s.birthtimeNs}`;
};

const presence = createMcpPresence({ vault: project });
const syncArgs = (phase) => ({
  project,
  phase,
  intent: 'lock the routing rebind',
  sessionId: 'rebind-session',
  clientInfo: { name: 'claude-code' },
});

// --- R1: a normal re-sync re-adopts a brain replaced since the last bind ------
presence.sync(syncArgs('start'));
ok(presence.verifyCurrentProjectBinding() === true,
  'R1a: binding is valid immediately after the first brain_sync');

const before = identityOf(brainPath);
atomicRewrite(brainPath);
const after = identityOf(brainPath);
ok(before !== after,
  'R1b: an atomic rewrite really does change the pinned file identity (premise holds on this host)');

ok(presence.verifyCurrentProjectBinding() === false,
  'R1c: the guard notices the retired identity — this is the guard working, not the bug');

// THE REGRESSION. Before the fix this stayed false forever: touch() never
// reassigned, so every non-brain_sync verb was rejected until the worker died,
// and the error text's own remedy ("call brain_sync again with the exact current
// project root") was a guaranteed no-op because the exact root is what keeps the
// call on the non-rebinding branch.
presence.sync(syncArgs('checkpoint'));
ok(presence.verifyCurrentProjectBinding() === true,
  'R1d: a plain same-project re-sync RE-ADOPTS the new brain identity (the regression guard)');

// And it must keep working — a second write/sync cycle must recover too, so this
// is a durable property rather than a one-shot repair.
atomicRewrite(brainPath);
presence.sync(syncArgs('checkpoint'));
ok(presence.verifyCurrentProjectBinding() === true,
  'R1e: re-adoption is repeatable across further brain rewrites');

// --- R2: re-adoption must not become a way to drift onto another project -----
// A brain swapped for a DIFFERENT project's brain at the same path is a content
// change, not a routing change, so the connection stays bound to this canonical
// root. What must never happen is the binding silently pointing somewhere else.
const boundRoot = path.resolve(project);
const foreign = path.join(tmpRoot, 'other');
fs.mkdirSync(foreign, { recursive: true });
fs.writeFileSync(path.join(foreign, 'brain.klypix'), brainBuf);

presence.sync(syncArgs('checkpoint'));
const stillHere = presence.verifyCurrentProjectBinding();
ok(stillHere === true, 'R2a: the session remains bound and usable after the neighbour project appears');

const report = presence.sync(syncArgs('checkpoint'));
const reportedProject = report?.structured?.project || report?.project || '';
ok(!reportedProject || path.resolve(reportedProject) === boundRoot,
  'R2b: re-adoption never retargets the connection to a different canonical root');

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failures === 0
  ? '\n[ok] project-binding-rebind: all assertions passed'
  : `\n[x] project-binding-rebind: ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
