// Evidence anchors are trust badges. A deleted, renamed, or unresolvable cited
// file must become visibly stale — never inherit its old OID as a green check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const sourceRoot = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-evidence-'));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

try {
  git('init', '-q');
  git('config', 'user.name', 'KLYPIX Evidence Test');
  git('config', 'user.email', 'evidence@example.test');
  fs.writeFileSync(path.join(root, 'kept.txt'), 'v1\n');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'present\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');

  process.chdir(root);
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';
  const hookUrl = pathToFileURL(path.join(sourceRoot, 'src', 'global-brain-hook.mjs')).href;
  const { computeFreshness, evidenceGitPath, gitBlobOid, selfHealFooter, splitMarkerSuffixes } = await import(hookUrl);

  const keptOid = gitBlobOid('kept.txt');
  const goneOid = gitBlobOid('gone.txt');
  ok(Boolean(keptOid && goneOid), 'fixture paths receive committed blob OIDs');
  ok(gitBlobOid('kept.txt:42:7') === keptOid, 'line and column suffixes do not alter the evidence path');
  ok(gitBlobOid('kept.txt#L42') === keptOid, 'GitHub-style line suffixes do not alter the evidence path');

  const absolute = path.join(root, 'kept.txt');
  ok(evidenceGitPath(`${absolute}:42`) === 'kept.txt', 'absolute in-repo path normalizes without splitting the Windows drive colon');
  ok(gitBlobOid(`${absolute}:42`) === keptOid, 'absolute in-repo evidence resolves to the same blob');
  ok(gitBlobOid(path.join(root, '..', 'outside.txt')) === null, 'absolute path outside the repository is rejected');
  const parsed = splitMarkerSuffixes(`claim ev: ${absolute}:42`);
  ok(parsed.evidence?.[0]?.oid === keptOid, 'capture stamps an absolute in-repo evidence ref');

  let result = computeFreshness({ cards: [
    { id: 'fresh', area: 'Test', text: 'fresh fact', evidence: [{ kind: 'file', ref: `${absolute}:42`, oid: keptOid }] },
  ] });
  ok(result.freshness.fresh === '✅' && result.drifted.length === 0,
    'unchanged absolute evidence remains verified');

  git('mv', 'gone.txt', 'renamed.txt');
  fs.writeFileSync(path.join(root, 'kept.txt'), 'v2\n');
  git('add', '.');
  git('commit', '-qm', 'rename and change');
  result = computeFreshness({ cards: [
    { id: 'missing', area: 'Test', text: 'renamed-file fact', evidence: [{ kind: 'file', ref: 'gone.txt:9', oid: goneOid }] },
    { id: 'changed', area: 'Test', text: 'changed-file fact', evidence: [{ kind: 'file', ref: 'kept.txt', oid: keptOid }] },
  ] });
  ok(result.freshness.missing === '⚠️ missing', 'renamed/deleted evidence is badged missing, never verified');
  ok(result.freshness.changed === '⚠️', 'content-changed evidence remains badged drifted');
  ok(result.drifted.find((entry) => entry.text === 'renamed-file fact')?.missingRefs?.[0] === 'gone.txt:9',
    'missing reference is carried into the repair receipt');
  const footer = selfHealFooter(result.drifted);
  ok(/CHANGED or went MISSING/.test(footer) && /⚠️ missing/.test(footer),
    'self-heal footer names missing evidence explicitly');
} finally {
  delete process.env.KLYPIX_BRAIN_NO_MAIN;
  process.chdir(sourceRoot);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] evidence-anchors: all assertions passed');
process.exit(failures ? 1 : 0);
