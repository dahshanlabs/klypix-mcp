import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { experimentId, sourceFingerprint, parseResults, pendingRuns, lastRowPerRun } from '../bench/coordination/lib/results.mjs';
import { summarize, toMarkdown } from '../bench/coordination/report.mjs';

const row = { scenario: 's5-stale-wip-note', condition: 'klypix', agent: 'claude', run: 1, experimentId: 'a', success: true, error: null };
const plan = [{ scenario: { id: row.scenario }, condition: { id: row.condition }, agent: { id: row.agent }, run: 1, order: 7 }];
const failed = { ...row, error: 'budget exceeded' };
assert.deepEqual(pendingRuns(plan, [row, failed], 'a'), plan, 'latest failed attempt must be retried even after an older success');
assert.deepEqual(pendingRuns(plan, [failed, row], 'a'), [], 'latest completed attempt is skipped');
assert.equal(lastRowPerRun([row, failed])[0], failed);
assert.equal(pendingRuns(plan, [failed], 'a')[0].order, 7, 'resume preserves the original shuffled position');
for (const extra of [{ invalid: true }, { timedOut: true }, { agentOk: false }]) assert.equal(pendingRuns(plan, [{ ...row, ...extra }], 'a').length, 1);
assert.throws(() => pendingRuns(plan, [{ ...row, experimentId: 'b' }], 'a'), /different/);
assert.throws(() => pendingRuns(plan, [{ ...row, experimentId: undefined }], 'a'), /unverified/);
assert.throws(() => lastRowPerRun([row, { ...row, experimentId: 'b' }]), /different/);
assert.throws(() => summarize([row, { ...row, experimentId: 'b' }]), /different/);
for (const changed of [{ model: 'b' }, { revision: '2' }, { timeout: 200 }, { seed: 2 }]) {
  const base = { model: 'a', revision: '1', timeout: 100, seed: 1 };
  assert.notEqual(experimentId(base), experimentId({ ...base, ...changed }));
}
const text = JSON.stringify(row);
assert.deepEqual(parseResults(`${text}\n{"scenario":`).rows, [row]);
assert.equal(parseResults(`${text}\n{"scenario":`).repairedText, `${text}\n`);
assert.equal(parseResults(text).repairedText, `${text}\n`, 'complete last row without newline must be separated before append');
assert.throws(() => parseResults(`${text}\nBROKEN\n${text}\n`), /invalid JSON/);
assert.throws(() => parseResults(`${text}\nBROKEN\n`), /invalid JSON/);
assert.throws(() => parseResults('{}\n'), /invalid run identity/);
const cell = summarize([row, { ...failed, run: 2 }])[0];
assert.equal(cell.success.k, 1, 'a passing grader after an agent error is not a completed success');
assert.equal(cell.n, 2);
assert.equal(cell.errors, 1);
assert.equal(cell.staleActions.n, 1);
assert.match(toMarkdown([cell], [{ ...row, experimentId: undefined }]), /Historical rows/);
assert.match(toMarkdown([cell], [row]), /do not establish equivalence/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-result-source-'));
try {
  fs.writeFileSync(path.join(root, 'x.mjs'), 'one');
  const before = sourceFingerprint(root, ['x.mjs', 'optional.json']);
  fs.writeFileSync(path.join(root, 'x.mjs'), 'two');
  assert.notEqual(before, sourceFingerprint(root, ['x.mjs', 'optional.json']), 'uncommitted source changes alter the experiment identity');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('coordination result integrity checks passed');
