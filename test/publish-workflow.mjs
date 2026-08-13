import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'publish.yml'), 'utf8')
  .replace(/\r/g, '');
const lines = workflow.split('\n');
const step = (name) => lines.findIndex((line) => line.trim() === `- name: ${name}`);
const body = (start) => {
  const end = lines.findIndex((line, index) => index > start && /^\s+- name: /.test(line));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
};
const bindIndex = lines.findIndex((line) => line === '  bind:');
const gateIndex = lines.findIndex((line) => line === '  gate:');
const publishIndex = lines.findIndex((line) => line === '  publish:');
const bindBody = lines.slice(bindIndex, gateIndex).join('\n');
const publishBody = lines.slice(publishIndex).join('\n');

ok(/^on:\n  release:\n    types: \[published\]\n  workflow_dispatch:\s*$/m.test(workflow),
  'only published releases and deliberate manual dispatch can trigger publication');
ok(/^    needs: \[bind, gate\]$/m.test(publishBody),
  'the OIDC publish job requires both immutable identity binding and the unprivileged gate');
ok(/^      id-token: write\b/m.test(publishBody) && /^      contents: read\b/m.test(publishBody),
  'the privileged job has only the permissions needed for OIDC and checkout');

const checkout = step('Checkout the gate-cleared evidence commit');
const proof = step('Prove the privileged checkout identity');
const setup = step('Setup pinned Node toolchain');
const npmFloor = step('Assert npm supports OIDC trusted publishing (>= 11.5.1)');
const versionProof = step('Confirm the version the gate cleared');
const publish = step('Publish (OIDC, auto-provenance)');
ok(publishIndex < checkout && checkout < proof && proof < setup && setup < npmFloor
  && npmFloor < versionProof && versionProof < publish,
  'the privileged path proves checkout identity before its pinned toolchain can publish');
ok(body(checkout).includes('ref: ${{ needs.bind.outputs.evidence_commit }}')
  && body(proof).includes('needs.bind.outputs.evidence_commit'),
  'the privileged checkout consumes the pre-execution event binding directly');

const bind = step('Bind the event commit before untrusted execution');
const gateCheckout = step('Checkout (clean, full history + tags)');
const gateProof = step('Prove the gate checkout identity');
ok(bindIndex >= 0 && bindIndex < gateIndex && bindIndex < bind && bind < gateIndex
  && !/^\s+uses:/m.test(bindBody) && !/\b(?:node|npm|git)\b/.test(body(bind))
  && body(bind).includes('EVENT_SHA: ${{ github.sha }}'),
  'a no-checkout/no-package job binds canonical github.sha before repository execution');
ok(gateIndex < gateCheckout && gateCheckout < gateProof
  && body(gateCheckout).includes('ref: ${{ needs.bind.outputs.evidence_commit }}')
  && body(gateProof).includes('BOUND_EVIDENCE_COMMIT'),
  'the unprivileged gate checks out and proves only the pre-bound event commit');

const actionRefs = [...publishBody.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
ok(actionRefs.length === 2 && actionRefs.every((ref) => /@[a-f0-9]{40}$/.test(ref)),
  'every action in the OIDC-capable job is immutable-SHA pinned');
ok(body(setup).includes("node-version: '24.13.1'")
  && body(setup).includes('package-manager-cache: false')
  && !body(setup).includes('registry-url:'),
  'the privileged Node runtime is exact, cache-free, and creates no token-auth registry config');
ok(publishBody.includes('NPM_CONFIG_IGNORE_SCRIPTS: "true"'),
  'repository lifecycle scripts are disabled throughout the OIDC-capable job');
ok(!/^\s+(?:run:\s*)?npm\s+(?:ci|install|i)\b/m.test(publishBody),
  'the OIDC-capable job never installs dependencies or a mutable npm CLI');
ok(body(npmFloor).includes('11.5.1') && !body(npmFloor).includes('npm install'),
  'the trusted-publishing npm floor is asserted without downloading executable code');

const version = step('Version validation (the tag must match package.json)');
const evidence = step('Verify committed corroborated release evidence');
const install = step('Install (npm ci — lockfile enforced)');
const testChain = step('Assert the test chain still contains the load-bearing suites');
const tarball = step('Tarball contents (npm pack --dry-run + assertions)');
ok(gateProof < version && version < evidence && evidence < install && install < tarball && tarball < publishIndex,
  'identity and evidence are verified before dependency execution, then tests and tarball proof precede OIDC');
ok(body(version).includes('BOUND_EVIDENCE_COMMIT')
  && body(evidence).includes('BOUND_EVIDENCE_COMMIT'),
  'version topology and evidence verification remain bound to the immutable event SHA');
ok(!body(version).includes('npm view') && !/already published/.test(body(version)),
  'the gate leaves idempotent existing-version verification to the privileged integrity check');
ok(body(evidence).includes('--require-corroborated')
  && body(evidence).includes('--git-commit "$SOURCE_COMMIT"')
  && body(evidence).includes('.release-evidence/v${VERSION}'),
  'the release gate invokes the real verifier against corroborated evidence for the source parent');
ok(body(testChain).includes('test/remote-client.mjs'),
  'the load-bearing suite gate pins the Remote attachment security regression suite');
ok(body(tarball).includes('.release-evidence'),
  'release evidence is explicitly forbidden from the consumer tarball');

if (failures) {
  console.error(`\n[x] publish-workflow: ${failures} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\n[ok] publish-workflow: all assertions passed');
}
