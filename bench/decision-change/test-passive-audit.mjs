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
assert.equal(missing.read().ok, false, 'missing completed-tool telemetry fails closed');
fs.writeFileSync(path.join(missing.dir, 'broken.event.json'), '{');
assert.throws(() => missing.read(), 'corrupt telemetry is never silently skipped');
assert.throws(() => readPassiveAudit(audit.dir, { sessionId: 'someone-else' }), 'session scoping applies when reading preserved records');

// Native acceptEdits/config rejections skip both per-tool completion hooks.
// Only the same session's exact typed journal result can explain that absence.
const journalRoot = path.join(home, '.claude', 'projects', 'fixture-project');
fs.mkdirSync(journalRoot, { recursive: true });
let denialNumber = 0;
function denialFixture(mutate = () => {}) {
  const sessionId = `denial-${++denialNumber}`;
  const target = preparePassiveAudit({ home, repoDir, sessionId });
  const call = { tool_name: 'Bash', tool_use_id: 'denied-command', tool_input: { command: 'fixture denied command' },
    tool_response: 'Arbitrary display text is not the denial proof.' };
  const assistant = { type: 'assistant', sessionId, cwd: repoDir, isSidechain: false, uuid: 'assistant-id',
    message: { content: [{ type: 'tool_use', id: call.tool_use_id, name: call.tool_name, input: call.tool_input },
      { type: 'thinking', thinking: 'PRIVATE_THINKING_MUST_NOT_BE_COPIED' }] } };
  const result = { type: 'user', sessionId, cwd: repoDir, isSidechain: false, uuid: 'result-id', sourceToolAssistantUUID: assistant.uuid,
    toolDenialKind: 'user-rejected', permissionDecision: { decision: 'reject', source: 'config', reasonCode: 'fixture-only' },
    message: { content: [{ type: 'tool_result', tool_use_id: call.tool_use_id, is_error: true, content: call.tool_response }] } };
  const fixture = { target, call, assistant, result, journal: path.join(journalRoot, `${sessionId}.jsonl`) };
  mutate(fixture);
  fs.writeFileSync(fixture.journal, [assistant, result].map(row => JSON.stringify(row)).join('\n') + '\n');
  return fixture;
}
const invokeDenial = fixture => invoke('PostToolBatch', { tool_calls: [fixture.call], transcript_path: fixture.journal }, fixture.target);
const denied = denialFixture();
success(invokeDenial(denied));
const deniedAudit = denied.target.read({ final: true });
assert.equal(deniedAudit.ok, true);
assert.equal(deniedAudit.responses[0].notExecuted, true);
assert.equal(deniedAudit.responses[0].isError, true);
assert.equal(deniedAudit.records.some(record => record.snapshot), false, 'a rejected command has no execution snapshot');
assert.equal(JSON.stringify(deniedAudit).includes('PRIVATE_THINKING'), false, 'only matched typed provenance is retained');
assert.equal(deniedAudit.records[0].calls[0].nativeDenial.source, 'native-session-journal');
for (const [label, mutate] of [
  ['foreign session', f => { f.result.sessionId = 'foreign'; }],
  ['foreign assistant session', f => { f.assistant.sessionId = 'foreign'; }],
  ['foreign tool', f => { f.assistant.message.content[0].name = 'Read'; }],
  ['foreign tool ID', f => { f.result.message.content[0].tool_use_id = 'other-tool'; }],
  ['foreign cwd', f => { f.result.cwd = home; }],
  ['foreign assistant cwd', f => { f.assistant.cwd = home; }],
  ['different result body', f => { f.result.message.content[0].content += ' changed'; }],
  ['successful result', f => { f.result.message.content[0].is_error = false; }],
  ['accepted permission', f => { f.result.permissionDecision.decision = 'accept'; }],
  ['different decision source', f => { f.result.permissionDecision.source = 'unverified'; }],
  ['missing typed denial', f => { delete f.result.toolDenialKind; }],
  ['different input', f => { f.assistant.message.content[0].input = { command: 'different' }; }],
  ['unlinked assistant', f => { f.result.sourceToolAssistantUUID = 'unlinked'; }],
  ['subagent result', f => { f.result.isSidechain = true; }],
]) {
  const fixture = denialFixture(mutate); success(invokeDenial(fixture));
  assert.equal(fixture.target.read({ final: true }).ok, false, `${label} cannot excuse missing completion`);
}
const missingJournal = denialFixture();
missingJournal.journal = path.join(journalRoot, 'missing.jsonl');
assert.equal(invokeDenial(missingJournal).status, 1);
assert.equal(missingJournal.target.read().ok, false, 'missing native journal fails closed');
const outsideJournal = denialFixture(f => { f.journal = path.join(root, `${f.target.sessionId}.jsonl`); });
assert.equal(invokeDenial(outsideJournal).status, 1);
assert.equal(outsideJournal.target.read().ok, false, 'journal must remain under isolated Claude home');
const borrowed = denialFixture();
const successfulCall = { ...readCall, tool_use_id: 'known-success-with-missing-hook' };
success(invoke('PostToolBatch', { tool_calls: [borrowed.call, successfulCall], transcript_path: borrowed.journal }, borrowed.target));
assert.equal(borrowed.target.read().ok, false, 'a known success without completion cannot borrow another call\'s rejection');
const conflict = denialFixture();
success(invokeDenial(conflict));
success(invoke('PostToolUse', { ...conflict.call, tool_response: { stdout: 'ran' } }, conflict.target));
assert.equal(conflict.target.read().ok, false, 'conflicting completed and rejected evidence is never accepted');
const normal = denialFixture();
success(invoke('PostToolUse', { ...normal.call, tool_response: { stdout: 'ran' } }, normal.target));
normal.journal = path.join(journalRoot, 'does-not-exist.jsonl');
success(invokeDenial(normal));
assert.equal(normal.target.read({ final: true }).ok, true, 'normal completed tools never depend on reading a journal');
const trailing = denialFixture();
fs.appendFileSync(trailing.journal, '{"unfinished":"unrelated');
success(invokeDenial(trailing));
assert.equal(trailing.target.read().ok, true, 'an unrelated incomplete append cannot invalidate complete denial proof');
const incomplete = denialFixture();
fs.writeFileSync(incomplete.journal, `${JSON.stringify(incomplete.assistant)}\n${JSON.stringify(incomplete.result)}`);
success(invokeDenial(incomplete));
assert.equal(incomplete.target.read().ok, false, 'an unterminated needed record cannot prove denial even if JSON parses');
const malformed = denialFixture();
fs.appendFileSync(malformed.journal, '{"malformed":\n');
assert.equal(invokeDenial(malformed).status, 1);
assert.equal(malformed.target.read().ok, false, 'malformed completed journal records are never silently skipped');

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
