import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
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
// The Remote attachment security suite was pinned here until KLYPIX Remote was
// removed (2026-08-15). Its only subject was buildRemoteCommand, which no longer
// exists, so the pin goes with it rather than guarding a deleted surface.
ok(body(testChain).includes('test/semantic-security.mjs'),
  'the load-bearing suite gate pins the semantic security suite');
ok(body(tarball).includes('.release-evidence'),
  'release evidence is explicitly forbidden from the consumer tarball');


// Exercise the real registry wait block offline: curl and sleep are mocked,
// while Bash set -e/pipefail and jq parsing run unchanged. Ubuntu CI provides
// both executables; Windows developers may set BASH_BIN and JQ_BIN explicitly.
const registryWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'publish-mcp-registry.yml'), 'utf8').replace(/\r/g, '');
const registryWait = registryWorkflow.match(/      - name: Wait for npm to carry the ownership marker\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1]
  .split('\n').map((line) => line.replace(/^          /, '')).join('\n');
ok(Boolean(registryWait), 'the real MCP Registry ownership wait block is available for execution');
let bashBin = process.env.BASH_BIN || 'bash';
if (process.platform === 'win32' && !process.env.BASH_BIN) {
  const gitBin = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0];
  const gitBash = gitBin && path.resolve(path.dirname(gitBin), '..', 'bin', 'bash.exe');
  if (gitBash && fs.existsSync(gitBash)) bashBin = gitBash;
}
const jqBin = process.env.JQ_BIN || 'jq';
const bashAvailable = spawnSync(bashBin, ['--version'], { encoding: 'utf8' }).status === 0;
const jqAvailable = spawnSync(jqBin, ['--version'], { encoding: 'utf8' }).status === 0;
if (!bashAvailable || !jqAvailable) {
  if (process.platform !== 'win32' || process.env.CI) ok(false, 'Bash and jq are required for registry wait regressions in CI');
  else console.log('[skip] registry wait execution needs Bash and jq (set BASH_BIN/JQ_BIN on Windows)');
} else if (registryWait) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-registry-wait-'));
  const shQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const marker = 'io.github.dahshanlabs/klypix-mcp';
  const ready = { body: JSON.stringify({ mcpName: marker }), code: 0 };
  const scenarios = [
    { name: 'exact marker succeeds immediately', replies: [ready], attempts: 1, success: true },
    { name: 'npm 404 JSON string retries until published', replies: [{ body: '"version not found: 1.84.0"', code: 22 }, ready], attempts: 2, success: true },
    { name: 'transport and HTTP errors cannot pass with matching bodies', replies: [{ ...ready, code: 28 }, { ...ready, code: 22 }, ready], attempts: 3, success: true },
    { name: 'empty, malformed and scalar metadata retry', replies: ['', '<html>unavailable</html>', 'null', 'true', '42', '"not ready"', '[]'].map((body) => ({ body, code: 0 })).concat(ready), attempts: 8, success: true },
    { name: 'only the exact top-level string marker passes', replies: [{}, { mcpName: marker.toUpperCase() }, { mcpName: marker + ' ' }, { mcpName: [marker] }, { mcpName: { value: marker } }, { nested: { mcpName: marker } }].map((value) => ({ body: JSON.stringify(value), code: 0 })).concat(ready), attempts: 7, success: true },
    { name: 'malformed tail after matching metadata retries', replies: [{ body: ready.body + '\nnot JSON', code: 0 }, ready], attempts: 2, success: true },
    { name: 'multiple JSON values are not one metadata object', replies: [{ body: 'null\n' + ready.body, code: 0 }, { body: ready.body + '\n' + ready.body, code: 0 }, ready], attempts: 3, success: true },
    { name: 'wrong marker exhausts bounded retries', replies: [{ body: '{"mcpName":"someone-else"}', code: 0 }], attempts: 45, success: false },
    { name: 'persistent transport failure exhausts bounded retries', replies: [{ body: '', code: 28 }], attempts: 45, success: false },
  ];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const countFile = path.join(fixtureRoot, index + '-attempts');
      const sleepFile = path.join(fixtureRoot, index + '-sleeps');
      const argsFile = path.join(fixtureRoot, index + '-args');
      const branches = scenario.replies.map((reply, n) =>
        '    ' + (n === scenario.replies.length - 1 ? '*' : n + 1) + ') printf %s ' + shQuote(reply.body) + '; return ' + reply.code + ';;'
      ).join('\n');
      const script = [
        'curl() {',
        '  local count=0',
        '  if [ -f "$COUNT_FILE" ]; then read -r count < "$COUNT_FILE"; fi',
        '  count=$((count + 1))',
        '  printf "%s\\n" "$count" > "$COUNT_FILE"',
        '  printf "%s\\n" "$*" >> "$ARGS_FILE"',
        '  case "$count" in', branches, '  esac', '}',
        'sleep() { printf "%s\\n" "$1" >> "$SLEEP_FILE"; }',
        'jq() { command "$JQ_BIN" "$@"; }',
        registryWait,
      ].join('\n');
      const result = spawnSync(bashBin, ['--noprofile', '--norc', '-c', script], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, VERSION: '1.84.0', JQ_BIN: jqBin.replace(/\\/g, '/'),
          COUNT_FILE: countFile.replace(/\\/g, '/'), SLEEP_FILE: sleepFile.replace(/\\/g, '/'), ARGS_FILE: argsFile.replace(/\\/g, '/') },
      });
      const attempts = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8').trim()) : 0;
      const sleeps = fs.existsSync(sleepFile) ? fs.readFileSync(sleepFile, 'utf8').trim().split('\n') : [];
      ok(result.status === (scenario.success ? 0 : 1) && attempts === scenario.attempts,
        'registry: ' + scenario.name);
      ok(sleeps.length === scenario.attempts - (scenario.success ? 1 : 0) && sleeps.every((value) => value === '20'),
        'registry: ' + scenario.name + ' preserves retry delays');
      const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n') : [];
      ok(args.length === scenario.attempts && args.every((value) =>
        /(?:^| )--fail(?: |$)/.test(value) && value.includes('--max-time 20')
        && value.includes('https://registry.npmjs.org/klypix-mcp/1.84.0')),
      'registry: ' + scenario.name + ' bounds version-specific requests and rejects HTTP errors');
      if (!scenario.success) ok(result.stdout.includes('::error::klypix-mcp@1.84.0'),
        'registry: retry exhaustion reports the publication prerequisite');
      if (result.error) console.error(result.error.message);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n[x] publish-workflow: ${failures} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\n[ok] publish-workflow: all assertions passed');
}
