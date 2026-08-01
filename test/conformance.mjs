import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = execFileSync(process.execPath, [
  path.join(root, 'bin', 'klypix-mcp.mjs'),
  'conformance',
  '--json',
], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 20_000,
});
const result = JSON.parse(output);
const required = [
  'brainSyncDiscoverable',
  'taskMemory',
  'truthfulTaskCount',
  'exactBlockingOverlap',
  'alertQueued',
  'proactiveLogging',
  'guaranteedInBandDelivery',
  'crossMachineConsentGate',
  'crossMachinePeerVisibility',
  'crossMachineOverlapWarning',
  'crossMachineMessageOnce',
  'crossMachineOfflineDegradation',
];
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

ok(result.ok === true, 'public conformance command returns PASS');
for (const name of required) ok(result.checks?.[name] === true, `conformance: ${name}`);
ok(result.contract?.proactive?.includes('best-effort')
  && result.contract?.guaranteed?.includes('next KLYPIX action'),
'conformance report distinguishes proactive best-effort from guaranteed delivery');

console.log(failures
  ? `\n[x] ${failures} conformance assertion(s) failed`
  : '\n[ok] conformance: all assertions passed');
process.exit(failures ? 1 : 0);
