// app-lease-vectors — the canonical-path rule both repositories hash is pinned
// by test/fixtures/app-bridge-vectors.json, which the KLYPIX desktop app mirrors
// byte-for-byte (scripts/sync-bundled-mcp.mjs --check --strict). If this test
// and the app's discovery test both pass, a canvas open in KLYPIX hashes to the
// same lease entry klypix-mcp computes. The fixture is never edited to make a
// failing computation pass — a mismatch means the rule changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalCanvasPath, pathHash, APP_BRIDGE_PROTOCOL } from '../src/app-lease.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const BS = String.fromCharCode(92);

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'app-bridge-vectors.json'), 'utf8'));
ok(fixture.protocol === APP_BRIDGE_PROTOCOL, `the fixture names the protocol this module speaks (${APP_BRIDGE_PROTOCOL})`);
ok(Array.isArray(fixture.canonicalPath?.vectors) && fixture.canonicalPath.vectors.length >= 1, 'the fixture carries at least one path vector');
for (const v of fixture.canonicalPath.vectors) {
  ok(canonicalCanvasPath(v.input) === v.canonical, `canonical path of ${v.input} is ${v.canonical} (got ${canonicalCanvasPath(v.input)})`);
  ok(pathHash(v.input) === v.sha256, `sha256 of the canonical path is the pinned ${v.sha256.slice(0, 12)}…`);
  ok(crypto.createHash('sha256').update(v.canonical, 'utf8').digest('hex') === v.sha256, 'the pinned hash is the plain sha256 of the pinned canonical string');
}
// The plan's own vector, spelled out once more so a fixture edit cannot slip by.
ok(pathHash('C:/Users/Test/Documents/KLYPIX/Launch ideas.klypix') === 'a1228c43f60b602d8daa30eaaab7e1b0230a92901d1a7d3dbb8f96a8806c033e',
  'the plan vector (C:/Users/Test/Documents/KLYPIX/Launch ideas.klypix) is unchanged');
// Spellings of one Windows path hash alike.
const spelled = [`C:${BS}Users${BS}Test${BS}Documents${BS}KLYPIX${BS}Launch ideas.klypix`, 'c:/users/TEST/documents/klypix/Launch Ideas.KLYPIX', 'C:/Users/Test/Documents/KLYPIX/x/../Launch ideas.klypix'];
for (const s of spelled) ok(pathHash(s) === fixture.canonicalPath.vectors[0].sha256, `"${s}" hashes like the vector`);

// An existing file resolves through realpath: a symlinked/junctioned folder
// hashes like its real path (the case KC:115's slash-and-lowercase rule misses).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-lease-vec-'));
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const file = path.join(real, 'Board.klypix');
  fs.writeFileSync(file, 'x');
  const link = path.join(root, 'link');
  let linked = false;
  try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch { /* unprivileged: skip */ }
  if (linked) ok(pathHash(path.join(link, 'Board.klypix')) === pathHash(file), 'a path through a junction/symlink hashes like the real path');
  else console.log('- (symlink not permitted here; realpath case skipped)');
  ok(canonicalCanvasPath(file) === canonicalCanvasPath(file).toLowerCase() && !canonicalCanvasPath(file).includes('/'), 'canonical paths are lowercase with backslashes on every system');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ app-lease-vectors: all assertions passed');
process.exit(failures ? 1 : 0);
