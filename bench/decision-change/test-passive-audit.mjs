import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePassiveAudit, readPassiveAudit } from './passive-audit.mjs';
import { createTelemetry, gradeRevisions } from './metrics.mjs';
import { runClaudeStage } from './agent.mjs';
import { BudgetLedger } from './ledger.mjs';
import { freshEnvironment } from './isolation.mjs';
import { runPlanRows } from './run.mjs';
import { resolveCli } from '../coordination/agents.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-passive-audit-test-'));
const home = path.join(root, 'home'), repoDir = path.join(root, 'repo');
fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
const invoice = path.join(repoDir, 'lib/invoice.mjs');
fs.writeFileSync(invoice, 'export const invoiceTotalCents=()=>0;');
const source = fileURLToPath(new URL('./passive-audit.mjs', import.meta.url));
const nativeHook = { matcher: 'Read', hooks: [{ type: 'command', command: 'native-product-command', timeout: 12 }] };
const audit = preparePassiveAudit({ home, repoDir, sessionId: 'native-session', settings: { env: { KEEP: 'yes' }, hooks: { PostToolUse: [nativeHook] } } });
assert.deepEqual(audit.settings.hooks.PostToolUse[0], nativeHook, 'product hook preserved exactly');
assert.equal(audit.settings.env.KEEP, 'yes');
assert.equal(audit.settings.hooks.PostToolBatch[0].matcher, undefined);
assert.equal(audit.settings.hooks.PostToolBatch[0].hooks[0].command, process.execPath);
assert.equal(audit.settings.hooks.PostToolBatch[0].hooks[0].args.length, 2, 'exec-form avoids a shell wrapper');
for (const event of ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']) assert.equal(audit.settings.hooks[event].at(-1).hooks[0].async, undefined, 'observer waits synchronously');
const invoke = (event, extra = {}, target = audit) => spawnSync(process.execPath, [source, target.configFile], {
  cwd: repoDir, env: freshEnvironment(home), encoding: 'utf8', windowsHide: true,
  input: JSON.stringify({ session_id: target.sessionId, cwd: repoDir, hook_event_name: event, ...extra }),
});
const success = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); };
const readCall = { tool_name: 'Read', tool_use_id: 'read-1', tool_input: { file_path: path.join(repoDir, 'CLAUDE.md') }, tool_response: '1\tPricing: round each line.\n' };
success(invoke('PostToolUse', { ...readCall, tool_response: { type: 'text', file: { content: 'Pricing: round each line.' } } }));
assert.equal(audit.read().responses.length, 0, 'a same-batch Read before a blocked checkpoint is not model exposure');
success(invoke('PostToolBatch', { tool_calls: [readCall] }));
const prior = audit.read();
assert.equal(prior.responses[0].text, readCall.tool_response, 'native serialized content preserved');
assert.equal(prior.responses[0].isError, false);
const telemetry = createTelemetry({ repoDir });
telemetry.observeAudit(prior);
const oldCode = 'export const invoiceTotalCents=(xs,p)=>xs.reduce((s,x)=>s+x+Math.round(x*p/100),0);';
const newCode = 'export const invoiceTotalCents=(xs,p)=>{const s=xs.reduce((a,b)=>a+b,0);return s+Math.round(s*p/100)};';
for (const [id, code] of [['write-old', oldCode], ['write-new', newCode]]) {
  fs.writeFileSync(invoice, code);
  success(invoke('PostToolUse', { tool_name: 'Write', tool_use_id: id, tool_response: { type: 'update' } }));
  success(invoke('PostToolBatch', { tool_calls: [{ tool_name: 'Write', tool_use_id: id, tool_input: {}, tool_response: 'Written.' }] }));
}
// Consume every record only after both edits. Delayed stdout cannot collapse
// the old revision into the new one because the hook already saved its bytes.
telemetry.observeAudit(audit.read({ final: true }));
assert.equal(telemetry.revisions.length, 3);
assert.equal(telemetry.revisions[1].source, oldCode);
assert.equal(telemetry.revisions[2].source, newCode);
const rework = gradeRevisions({ revisions: telemetry.revisions, changed: true, scratchDir: path.join(root, 'grading'), env: freshEnvironment(home) });
assert.equal(rework.staleCodeRevisions, 1); assert.equal(rework.correctedAfterStaleCode, true);
assert.equal(fs.existsSync(path.join(repoDir, 'test/hidden.test.mjs')), false);
success(invoke('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'failed-read', error: 'read failed' }));
success(invoke('PostToolBatch', { tool_calls: [{ ...readCall, tool_use_id: 'failed-read' }] }));
assert.equal(audit.read().responses.at(-1).isError, true, 'failed response cannot borrow a successful-looking body');
success(invoke('PostToolBatch', { tool_calls: [{ ...readCall, tool_use_id: 'validation-rejected', tool_input: { file_path: 27 },
  tool_response: '<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `file_path` type is expected as `string` but provided as `number`</tool_use_error>' }] }));
assert.equal(audit.read().ok, true, 'documented preexecution validation rejection needs no completion hook');
assert.equal(audit.read().responses.at(-1).notExecuted, true);
assert.equal(audit.read().responses.at(-1).isError, true);
const invalid = preparePassiveAudit({ home, repoDir, sessionId: 'expected' });
assert.equal(invoke('PostToolUse', { session_id: 'wrong', tool_name: 'Read', tool_use_id: 'foreign' }, invalid).status, 1);
assert.equal(invalid.read().ok, false, 'wrong native session is an explicit audit error');
const missing = preparePassiveAudit({ home, repoDir, sessionId: 'missing' });
success(invoke('PostToolBatch', { tool_calls: [readCall] }, missing));
assert.equal(missing.read().ok, true, 'live missing completion remains pending');
assert.equal(missing.read().pending.length, 1);
assert.equal(missing.read({ final: true }).ok, false, 'unreconciled final evidence fails closed');
fs.writeFileSync(path.join(missing.dir, 'broken.event.json'), '{');
assert.throws(() => missing.read(), 'corrupt telemetry is never silently skipped');
assert.throws(() => readPassiveAudit(audit.dir, { sessionId: 'someone-else' }), 'session scoping applies when reading preserved records');

// Regression from the retained third paid attempt, reduced to this exact call
// and its typed host result; private profile paths replaced consistently below.
// Original stdout SHA256: 59b729963fe2d3324b98dccd30788c5b9acfe4fc4e3f9f63824b89db1d5341b4
// Original native batch SHA256: 3e06b1036774287c0ee1be70602069ab5ed1c549ac71dd1a36d75ef638c1b807
const memoryPath = '/isolated/home/.claude/projects/fixture-project/memory/';
const deniedTail = 'head -100 && echo ---AGENTS--- && cat -A AGENTS.md && echo ---GIT--- && git diff && echo ---MEM--- && ls -la '
  + memoryPath + ' 2>&1 && cat ' + memoryPath + 'MEMORY.md 2>&1';
let denialNumber = 0;
function denialFixture(mutate = () => {}) {
  const sessionId = 'denial-' + ++denialNumber;
  const target = preparePassiveAudit({ home, repoDir, sessionId });
  const call = { tool_name: 'Bash', tool_use_id: 'toolu_01QwbpVpjWQy5YQiFC1E4M5s',
    tool_input: { command: 'cat -A CLAUDE.md | ' + deniedTail, description: 'Read CLAUDE.md, AGENTS.md, git diff, and memory index' },
    tool_response: 'This Bash command contains multiple operations. The following part requires approval: ' + deniedTail };
  const assistant = { type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
    uuid: '5d82a31d-824d-45bb-a9ee-6a7d7a8c8ae9', message: { content: [
      { type: 'tool_use', id: call.tool_use_id, name: call.tool_name, input: structuredClone(call.tool_input), caller: { type: 'direct' } },
      { type: 'thinking', thinking: 'SYNTHETIC_THINKING_MUST_NOT_BE_COPIED' }] } };
  const result = { type: 'user', session_id: sessionId, parent_tool_use_id: null,
    uuid: '8d2baa00-4ea9-4b23-a282-0cedca61ed19', message: { content: [
      { type: 'tool_result', tool_use_id: call.tool_use_id, is_error: true, content: call.tool_response }] },
    tool_result_meta: [{ id: call.tool_use_id, non_execution_kind: 'user-rejected', permission_decision: { decision: 'reject', source: 'config' } }] };
  const fixture = { target, call, assistant, result }; mutate(fixture); return fixture;
}
const invokeDenial = f => invoke('PostToolBatch', { tool_calls: [f.call], transcript_path: path.join(root, 'does-not-exist.jsonl') }, f.target);
const closeFixture = f => f.target.reconcileAfterClose([f.assistant, f.result].map(row => JSON.stringify(row)).join('\n') + '\n');
const denied = denialFixture();
success(invoke('PostToolUse', { ...readCall, tool_response: { type: 'text', file: { content: 'Pricing: round each line.' } } }, denied.target));
success(invoke('PostToolBatch', { tool_calls: [readCall] }, denied.target));
success(invokeDenial(denied));
const pendingAudit = denied.target.read();
assert.equal(pendingAudit.ok, true); assert.equal(pendingAudit.finalized, false);
assert.equal(pendingAudit.pending.length, 1);
assert.equal(pendingAudit.responses.length, 1, 'pending body is never positive or negative retrieval evidence');
assert.equal(pendingAudit.responses[0].text, readCall.tool_response, 'independently paired prior exposure survives delayed stdout');
assert.equal(denied.target.read({ final: true }).ok, false, 'cannot score before every pending result is resolved');
const pendingTelemetry = createTelemetry({ repoDir }); pendingTelemetry.observeAudit(pendingAudit);
assert.equal(pendingTelemetry.revisions.length, 1, 'unmatched result never supplies a rework snapshot');
closeFixture(denied);
const deniedAudit = denied.target.read({ final: true });
assert.equal(deniedAudit.ok, true); assert.equal(deniedAudit.finalized, true); assert.equal(deniedAudit.pending.length, 0);
assert.equal(deniedAudit.responses.at(-1).notExecuted, true); assert.equal(deniedAudit.responses.at(-1).isError, true);
const receipt = fs.readFileSync(path.join(denied.target.dir, 'reconciliation.json'), 'utf8');
assert.equal(receipt.includes('SYNTHETIC_THINKING'), false, 'only matched typed provenance is retained');
for (const [label, mutate] of [
  ['foreign result session', f => { f.result.session_id = 'foreign'; }],
  ['foreign assistant session', f => { f.assistant.session_id = 'foreign'; }],
  ['foreign tool', f => { f.assistant.message.content[0].name = 'Read'; }],
  ['foreign tool ID', f => { f.result.message.content[0].tool_use_id = 'other-tool'; }],
  ['different result body', f => { f.result.message.content[0].content += ' changed'; }],
  ['successful result', f => { f.result.message.content[0].is_error = false; }],
  ['accepted permission', f => { f.result.tool_result_meta[0].permission_decision.decision = 'accept'; }],
  ['different decision source', f => { f.result.tool_result_meta[0].permission_decision.source = 'unverified'; }],
  ['missing typed denial', f => { delete f.result.tool_result_meta; }],
  ['wrong metadata ID', f => { f.result.tool_result_meta[0].id = 'different'; }],
  ['duplicate metadata', f => { f.result.tool_result_meta.push(structuredClone(f.result.tool_result_meta[0])); }],
  ['interrupted execution', f => { f.result.tool_result_meta[0].non_execution_kind = 'interrupted'; }],
  ['different input', f => { f.assistant.message.content[0].input = { command: 'different' }; }],
  ['missing host result', f => { f.result.message.content = []; }],
  ['subagent result', f => { f.result.parent_tool_use_id = 'subagent'; }],
]) {
  const fixture = denialFixture(mutate); success(invokeDenial(fixture)); closeFixture(fixture);
  assert.equal(fixture.target.read({ final: true }).ok, false, label + ' cannot excuse missing completion');
}
const missingHost = denialFixture(); success(invokeDenial(missingHost)); missingHost.target.reconcileAfterClose('');
assert.equal(missingHost.target.read({ final: true }).ok, false, 'missing host stream fails closed');
const malformedHost = denialFixture(); success(invokeDenial(malformedHost));
assert.throws(() => malformedHost.target.reconcileAfterClose('{broken\n'));
assert.equal(malformedHost.target.read({ final: true }).ok, false, 'malformed host stream cannot finalize a row');
const borrowed = denialFixture();
const successfulCall = { ...readCall, tool_use_id: 'known-success-with-missing-hook' };
success(invoke('PostToolBatch', { tool_calls: [borrowed.call, successfulCall] }, borrowed.target)); closeFixture(borrowed);
assert.equal(borrowed.target.read({ final: true }).ok, false, 'a known success without completion cannot borrow another call\'s rejection');
const unknown = denialFixture(f => { f.call.tool_name = 'UnavailableTool'; f.assistant.message.content[0].name = 'UnavailableTool';
  f.call.tool_response = '<tool_use_error>No such tool available</tool_use_error>';
  f.result.message.content[0].content = f.call.tool_response; delete f.result.tool_result_meta; });
success(invokeDenial(unknown)); closeFixture(unknown);
assert.equal(unknown.target.read({ final: true }).ok, false, 'an unclassified host error is not proven nonexecution');
const conflict = denialFixture(); success(invokeDenial(conflict)); closeFixture(conflict);
success(invoke('PostToolUse', { ...conflict.call, tool_response: { stdout: 'ran' } }, conflict.target));
assert.equal(conflict.target.read({ final: true }).ok, false, 'a completion contradicting final denial proof is never accepted');

// Fake executable only: exercises the real stage callback/settlement path
// without any model, authentication, external service, or live ledger.
if (process.platform === 'win32') {
  const bin = path.join(root, 'fake-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\fake-cli.cjs"');
  fs.writeFileSync(path.join(bin, 'fake-cli.cjs'), `process.stdout.write(JSON.stringify({type:'system'})+'\\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0,modelUsage:{},result:'fixture'})+'\\n');`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin};${path.join(process.env.SystemRoot || 'C:/Windows', 'System32')}`;
  try {
    const selected = resolveCli('claude');
    assert.equal(selected.command, process.execPath);
    assert.deepEqual(selected.prefix, [path.join(bin, 'fake-cli.cjs')], 'test cannot fall through to a real model executable');
    const ledger = new BudgetLedger(path.join(root, 'fake-ledger.jsonl'), { limitUsd: 2 });
    const result = await runClaudeStage({ approved: true, id: 'fake-observer-error', role: 'fixture', repoDir, home, prompt: 'unused',
      sessionId: 'fake-callback', ledger, transcriptDir: path.join(root, 'artifacts'),
      limits: { model: 'fixture', stageBudgetUsd: .01, maxContextTokens: 10, maxOutputTokens: 10,
        inputWorstUsdPerMillion: 1, outputUsdPerMillion: 1, priceSource: 'fixture-no-model' },
      onEvent: () => { throw new Error('intentional observer failure'); } });
    assert.equal(result.ok, false);
    assert.ok(result.telemetryErrors.some(error => error.includes('intentional observer failure')));
    assert.equal(fs.existsSync(result.stdoutFile), true, 'raw evidence and accounting retained on callback error');
  } finally { process.env.PATH = previousPath; }
}
const reviewLedger = new BudgetLedger(path.join(root, 'review-stop-ledger.jsonl'), { limitUsd: 2 });
let invoked = 0;
const stopped = await runPlanRows([1, 2], { ledger: reviewLedger, reserveFor: () => .1,
  execute: async () => { invoked++; reviewLedger.reserve({ id: `row-${invoked}`, kind: 'fixture', maxUsd: .1 });
    reviewLedger.settle(`row-${invoked}`, { actualUsd: .03 }); return { stages: [{ telemetryErrors: ['native audit unavailable'] }] }; } });
assert.equal(stopped.stopReason, 'Instrumentation review required'); assert.equal(invoked, 1);
assert.equal(reviewLedger.snapshot().reservations.length, 1, 'no reservation for the next row after observer failure');
let losses = 0;
await runPlanRows([1, 2], { ledger: reviewLedger, reserveFor: () => .1,
  execute: async () => { losses++; return { success: false, failure: 'initial-policy-not-retrieved', stages: [] }; } });
assert.equal(losses, 2, 'ordinary product losses do not stop the registered comparison');
console.log(JSON.stringify({ ok: true, modelCalls: 0, artifactRoot: root,
  checks: 'same-batch exclusion, serialized exposure, delayed revision consumption, failed tools, identity/corruption failures, existing hooks, observer callback failure' }));
