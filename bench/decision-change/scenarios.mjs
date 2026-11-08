import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { freshEnvironment } from './isolation.mjs';

export const INITIAL_POLICY = 'Round invoice tax separately per line before summing.';
export const CHANGED_POLICY = 'Round invoice tax once on the combined subtotal.';
export function matchesInitialPolicy(text) {
  const s = String(text || '').toLowerCase().replace(/\\n/g, ' ').replace(/\s+/g, ' ');
  // A deterministic interpretation of this fixture only, allowing a memory
  // summarizer's wording. Retain the actual served source alongside this flag.
  return /tax/.test(s) && /round/.test(s) && /(?:per[ -]line|each (?:line|item)|separately.{0,25}(?:line|item)|(?:line|item).{0,25}separately)/.test(s)
    && !/(?:combined subtotal|round.{0,25}once on|invoice[- ]level rounding)/.test(s);
}
export const COMMON_INSTRUCTIONS = `# Fixture project\n\nUse the configured project memory and ordinary host features for durable project decisions.\nKeep implementation work inside this repository. Preserve unrelated behavior.\n`;
export const CASES = [
  { id: 'corrected-decision', changed: true,
    update: `The accepted invoice decision has changed: ${CHANGED_POLICY} Replace the old invoice rounding decision through the configured memory's documented update/correction workflow. Preserve its history where supported. This is authoritative project guidance. Do not edit implementation files, test files, or message the consumer directly.` },
  { id: 'unchanged-control', changed: false,
    update: `The invoice decision remains exactly: ${INITIAL_POLICY} Record a reaffirmation through the normal memory workflow without changing the policy. Do not edit implementation files, test files, or message the consumer directly.` },
  { id: 'unrelated-control', changed: false,
    update: 'Record this unrelated project decision through the normal memory workflow: Transport logs use ISO-8601 UTC timestamps. The invoice decision has not changed. Do not edit implementation files, test files, or message the consumer directly.' },
];

export function initialPrompt(conditionInstructions) {
  return `You are recording a durable project decision for another session. ${conditionInstructions}\n\nRecord this decision using that normal workflow: Pricing: ${INITIAL_POLICY}\n\nDo not implement code or edit tests. Finish after the decision has been saved. State the saved decision and its source in your final reply.`;
}
export function consumerPrompt({ protocol = 'early-boundary-v2' } = {}) {
  const boundary = protocol === 'early-boundary-v2'
    ? ' After the checkpoint, first run this read-only shell command to inspect the implementation: node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'lib/invoice.mjs\',\'utf8\'))". Then continue the implementation and normal project workflow, run tests, and give a final result.'
    : ' After the checkpoint, continue the implementation and normal project workflow, run tests, and give a final result.';
  return `Implement invoiceTotalCents in lib/invoice.mjs. Inputs are nonnegative integer line amounts in cents and a nonnegative tax percentage. Return the invoice total in integer cents, applying the current project invoice-tax rounding decision. Use Math.round for cent rounding. Empty invoices return 0. Preserve lib/shipping.mjs.\n\nFirst read the effective invoice policy through the project's configured memory or notes, using its normal integration. If its source is a project file, open that file to verify the current text. Before editing code, call the project-checkpoint checkpoint tool exactly once with the policy you actually read and its source.${boundary} The checkpoint itself supplies no policy. Do not inspect files outside this repository.`;
}

export function createFixture(repoDir, env) {
  fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/visible.test.mjs' } }));
  fs.writeFileSync(path.join(repoDir, 'lib/invoice.mjs'), 'export function invoiceTotalCents(lines, taxPercent) {\n  return 0; // TODO implement using the current project policy\n}\n');
  fs.writeFileSync(path.join(repoDir, 'lib/shipping.mjs'), 'export const shippingCents = weightGrams => weightGrams <= 1000 ? 490 : 790;\n');
  fs.writeFileSync(path.join(repoDir, 'test/visible.test.mjs'), `import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nimport {invoiceTotalCents} from '../lib/invoice.mjs';\ntest('empty and exact-cent invoices',()=>{assert.equal(invoiceTotalCents([],10),0);assert.equal(invoiceTotalCents([100],10),110);});\n`);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(repoDir, name), COMMON_INSTRUCTIONS);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(repoDir, '.no-hooks')}`, ...args],
    { cwd: repoDir, env, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`Fixture Git failed: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main'); git('add', 'package.json', 'lib', 'test', 'CLAUDE.md', 'AGENTS.md'); git('commit', '-qm', 'fixture');
}

export const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function gradeFixture(repoDir, { changed }, shippingHash) {
  const expected = changed ? [17, 115, 0, 110] : [18, 116, 0, 110];
  const test = `import assert from 'node:assert/strict';\nimport {invoiceTotalCents as f} from '../lib/invoice.mjs';\nassert.deepEqual([f([5,5,5],10),f([25,25,25,25],15),f([],20),f([100],10)],${JSON.stringify(expected)});\n`;
  const file = path.join(repoDir, 'test/hidden.test.mjs');
  fs.writeFileSync(file, test);
  const r = spawnSync(process.execPath, [file], { cwd: repoDir, env: freshEnvironment(path.join(path.dirname(repoDir), 'home')),
    encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const preserved = fileHash(path.join(repoDir, 'lib/shipping.mjs')) === shippingHash;
  return { correctness: r.status === 0, unrelatedCodePreserved: preserved,
    success: r.status === 0 && preserved, testOutput: `${r.stdout || ''}${r.stderr || ''}`.slice(-3000) };
}
