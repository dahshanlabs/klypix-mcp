import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { askRuleApproval, addCandidates, brainRulesTool, loadRulesDoc, lifecycleReview } from '../src/brain-rules.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-approval-'));
const rule = { id: 'safe-import', kind: 'forbid-pattern', severity: 'warn',
  why: 'Absolute imports fail in tests.', fix: 'Use relative imports.',
  source: { card: 'txt_lesson' }, files: ['src/*.ts'], pattern: 'bad-import' };
let cases = 0;
const fixture = () => {
  const root = path.join(temp, String(cases++)); fs.mkdirSync(root);
  assert.equal(addCandidates(root, [rule]).ok, true); return root;
};
const call = (root, requestApproval, extra = {}) => brainRulesTool({ projectRoot: root,
  action: 'promote', ids: [rule.id], block: true, ...extra }, { requestApproval });
const candidate = root => assert.equal(loadRulesDoc(root).rules[0].status, 'candidate');
try {
  for (const answer of [false, undefined, 'true', { confirm: true }]) {
    const root = fixture(); const result = await call(root, async () => answer);
    assert.equal(result.structured.reason, 'not-approved'); candidate(root);
  }
  let root = fixture();
  assert.equal((await call(root, async () => { throw Error('timeout'); })).structured.reason, 'not-approved'); candidate(root);
  root = fixture();
  let shown;
  const accepted = await call(root, async ({ message }) => { shown = message; return true; });
  assert.equal(accepted.structured.ok, true);
  assert.ok(shown.includes(root) && shown.includes('"severity": "block"') && shown.includes(rule.pattern));
  assert.equal(loadRulesDoc(root).rules[0].approvedBy, 'human (approval prompt)');
  assert.equal((await call(root, async () => true)).structured.reason, 'invalid'); // no replay
  root = fixture();
  const stale = await call(root, async () => { addCandidates(root, [{ ...rule, pattern: 'changed' }]); return true; });
  assert.equal(stale.structured.reason, 'stale-approval'); candidate(root);
  root = fixture();
  const originalNow = Date.now;
  try {
    const expired = await call(root, async () => { Date.now = () => originalNow() + 121_000; return true; });
    assert.equal(expired.structured.reason, 'stale-approval'); candidate(root);
  } finally { Date.now = originalNow; }
  root = fixture();
  addCandidates(root, [{ ...rule, id: 'cloud-review', kind: 'cloud-required', severity: 'advise', pattern: undefined }]);
  await call(root, async ({ message }) => { assert.ok(message.includes('"severity": "advise"')); return true; }, { ids: ['cloud-review'] });
  assert.equal(loadRulesDoc(root).rules.find(r => r.id === 'cloud-review').severity, 'advise');
  root = fixture();
  let release;
  const waiting = call(root, () => new Promise(resolve => { release = resolve; }));
  assert.equal((await call(root, async () => true)).structured.reason, 'approval-pending');
  release(false); await waiting; candidate(root);
  root = fixture();
  assert.equal((await call(root, () => { throw Error('must not prompt'); }, { pluginMode: true })).structured.reason, 'plugin-mode'); candidate(root);
  root = fixture();
  assert.equal((await call(root, () => { throw Error('must not prompt'); }, { approve: 'wrong' })).structured.reason, 'code'); candidate(root);
  const code = lifecycleReview(root, 'promote', [rule.id], { block: true }).code;
  assert.equal((await call(root, () => { throw Error('must not prompt'); }, { approve: code })).structured.ok, true);
  assert.equal((await call(root, async () => false, { action: 'retire' })).structured.reason, 'not-approved');
  assert.equal(loadRulesDoc(root).rules[0].status, 'active');
  assert.equal((await call(root, async () => true, { action: 'retire' })).structured.ok, true);
  for (const answer of [{ action: 'accept', content: { confirm: true } }, { action: 'accept', content: {} }, { action: 'decline', content: { confirm: true } }, { action: 'cancel' }]) {
    const yes = await askRuleApproval({ message: 'complete review', requestId: 7, platform: 'linux', server: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async (request, opts) => { assert.equal(request.requestedSchema.properties.confirm.default, false); assert.equal(opts.relatedRequestId, 7); return answer; },
    } });
    assert.equal(yes, answer.action === 'accept' && answer.content?.confirm === true);
  }
  assert.equal(await askRuleApproval({ message: 'review', platform: 'linux' }), false);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await askRuleApproval({ message: 'review', signal: aborted.signal, spawnImpl: () => { throw Error('must not open'); } }), false);
  assert.equal(await askRuleApproval({ message: 'review', platform: 'win32', server: {
    getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => { throw Error('timeout'); },
  }, spawnImpl: () => { throw Error('must not retry in a dialog'); } }), false);
  for (const output of ['approved', '', 'approved extra']) {
    const message = 'Unicode مراجعة and literal $(not-code) ' + 'x'.repeat(2000);
    const yes = await askRuleApproval({ message, platform: 'win32', spawnImpl: (_file, args, options) => {
      assert.equal(options.windowsHide, true);
      assert.ok(!args.join(' ').includes('not-code')); // review only goes to stdin
      const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stdin = new EventEmitter(); proc.kill = () => {};
      proc.stdin.end = data => { assert.equal(data, message); queueMicrotask(() => { proc.stdout.emit('data', output); proc.emit('close', 0); }); };
      return proc;
    } });
    assert.equal(yes, output === 'approved');
  }
  console.log('Rule approval: lifecycle, stale content, duplicate prompts, plugin guard, terminal fallback, MCP form and native transport passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
