// Fresh temp-only, zero model calls, no product state mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BudgetLedger } from './ledger.mjs';
import { reservationUsd, evidenceTracker, isNormalMemoryRetrieval } from './agent.mjs';
import { GATE_REPLY } from './gate.mjs';
import { freshEnvironment } from './isolation.mjs';
import { checkNotes, NOTES_NOTICE } from './notes-notify-hook.mjs';
import { auditHookSource, readHookAudit, deliveredHookEvidence, prepareKlypixHooks } from './native-hooks.mjs';
import { createTelemetry, notificationMetrics, gradeRevisions } from './metrics.mjs';
import { prepareCondition } from './adapters.mjs';
import { spawnSync } from 'node:child_process';
import { claudeHookSettings } from '../coordination/conditions.mjs';
import { PERSONAL_SESSIONS, PERSONAL_QUESTIONS, personalRecallPrompt, gradePersonalRecall } from './personal-scenario.mjs';
import { buildPlan } from './run.mjs';
import { applyFlushOutcome, finalizeOutcome } from './outcomes.mjs';
import { CASES, INITIAL_POLICY, matchesInitialPolicy, createFixture, gradeFixture, fileHash } from './scenarios.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-change-self-test-'));
try {
  const file = path.join(root, 'budget.jsonl');
  const ledger = new BudgetLedger(file, { limitUsd: 10 });
  ledger.reserve({ id: 'a', kind: 'producer', maxUsd: 6 });
  assert.throws(() => ledger.reserve({ id: 'b', kind: 'consumer', maxUsd: 5 }), /budget exhausted/);
  ledger.settle('a', { actualUsd: 1.25 });
  assert.equal(new BudgetLedger(file, { limitUsd: 10 }).remaining(), 8.75);
  ledger.reserve({ id: 'observer', kind: 'observer', maxUsd: 2 });
  ledger.unknown('observer', { reason: 'interrupted observer' });
  assert.equal(ledger.snapshot().spentCents, 325);
  assert.throws(() => ledger.reserve({ id: 'c', kind: 'retry', maxUsd: 1 }), /accounting uncertain/);
  const over = new BudgetLedger(path.join(root, 'over.jsonl'), { limitUsd: 10 });
  over.reserve({ id: 'o', kind: 'observer', maxUsd: 1 });
  assert.throws(() => over.settle('o', { actualUsd: 1.1 }), /exceeded/);
  assert.equal(over.snapshot().spentCents, 110);
  assert.equal(over.snapshot().halted, true);
  assert.throws(() => reservationUsd({}), /verified cost bound/);
  assert.equal(reservationUsd({ stageBudgetUsd: 0.5, maxContextTokens: 1e6, maxOutputTokens: 128000,
    inputWorstUsdPerMillion: 1, outputUsdPerMillion: 2.5, model: 'fixture', priceSource: 'fixture' }), 1.82);
  assert.equal(reservationUsd({ stageBudgetUsd: 0.5, maxContextTokens: 1e6, maxOutputTokens: 128000,
    inputWorstUsdPerMillion: 1, outputUsdPerMillion: 2.5, geographyMultiplier: 1.1, model: 'fixture', priceSource: 'fixture' }), 1.96);
  const isolated = freshEnvironment(root, { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'must-not-survive',
    CLAUDE_CODE_SESSION_ID: 'live', KLYPIX_APP_BRIDGE_DIR: 'live', CODEX_HOME: 'live', APPDATA: 'live',
    LOCALAPPDATA: 'live', OPENAI_API_KEY: 'must-not-survive', AWS_SECRET_ACCESS_KEY: 'must-not-survive', GIT_DIR: 'live', NODE_OPTIONS: 'live' });
  assert.equal(isolated.ANTHROPIC_API_KEY, undefined);
  assert.equal(isolated.OPENAI_API_KEY, undefined);
  assert.equal(isolated.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(isolated.KLYPIX_APP_BRIDGE_DIR, undefined);
  assert.equal(isolated.GIT_DIR, undefined);
  assert.equal(isolated.NODE_OPTIONS, undefined);
  for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'TEMP']) {
    assert.ok(isolated[key].startsWith(root), `${key} is isolated`);
  }

  const tracker = evidenceTracker(INITIAL_POLICY);
  tracker.observe({ type: 'assistant', message: { content: [{ type: 'text', text: INITIAL_POLICY }] } });
  assert.equal(tracker.evidence.length, 0, 'self-reported reading is not evidence');
  tracker.observe({ message: { content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'CLAUDE.md' } }] } });
  tracker.observe({ message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: INITIAL_POLICY }] } });
  assert.equal(tracker.evidence.length, 1, 'actual tool response proves exposure');
  assert.equal(tracker.responses.length, 1); assert.equal(isNormalMemoryRetrieval(tracker.responses[0]), true);
  assert.equal(isNormalMemoryRetrieval({ tool: 'mcp__mcp-search__search', text: 'No results' }), true, 'empty actual memory retrieval is measurable');
  assert.equal(isNormalMemoryRetrieval({ tool: 'mcp__mcp-search__save_memory', text: 'saved' }), false, 'server name is not a read operation');
  assert.equal(isNormalMemoryRetrieval({ tool: 'mcp__klypix-canvas__brain_sync', input: { include_context: false } }), false, 'explicit no-context sync is not a retrieval');
  assert.equal(isNormalMemoryRetrieval({ tool: 'Read', input: { file_path: 'package.json' } }), false, 'unrelated reads do not prove memory retrieval');
  const failedRead = evidenceTracker(INITIAL_POLICY);
  failedRead.observe({ message: { content: [{ type: 'tool_use', id: 'ask-error', name: 'mcp__klypix-canvas__brain_ask', input: {} },
    { type: 'tool_result', tool_use_id: 'ask-error', is_error: true, content: `Retrieval failed: ${INITIAL_POLICY}` }] } });
  assert.equal(failedRead.evidence.length, 0, 'failed memory result never proves successful exposure');
  assert.equal(failedRead.responses.length, 1); assert.equal(failedRead.responses[0].isError, true);
  assert.equal(isNormalMemoryRetrieval(failedRead.responses[0]), true, 'actual memory-tool failure is an audited retrieval attempt, not a missing trace');
  assert.equal(matchesInitialPolicy('Round tax on each item, then add those amounts.'), true);
  assert.equal(matchesInitialPolicy('Round invoice tax once on the combined subtotal.'), false);
  assert.equal(matchesInitialPolicy('Old policy was per-line tax rounding; now round once on the combined subtotal.'), false);

  const gatePath = path.join(root, 'gate');
  const client = new Client({ name: 'decision-change-self-test', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs'), gatePath] });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools[0].name, 'checkpoint');
    let released = false;
    const pending = client.callTool({ name: 'checkpoint', arguments: { observed_policy: INITIAL_POLICY, source: 'fixture read' } })
      .then(result => { released = true; return result; });
    const until = Date.now() + 10_000;
    while (!fs.existsSync(`${gatePath}.arrived`) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(`${gatePath}.arrived`));
    assert.equal(released, false, 'consumer remains running behind the neutral barrier');
    fs.writeFileSync(`${gatePath}.release`, 'continue');
    const response = await pending;
    assert.equal(response.content[0].text, GATE_REPLY);
    assert.ok(!response.content[0].text.includes(INITIAL_POLICY), 'gate never leaks policy information');
  } finally { await client.close(); await transport.close(); }

  const repo = path.join(root, 'repo');
  createFixture(repo, { ...process.env, HOME: root, USERPROFILE: root,
    GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
  const shippingHash = fileHash(path.join(repo, 'lib/shipping.mjs'));
  const invoice = path.join(repo, 'lib/invoice.mjs');
  const stateDir = path.join(root, 'notes-state');
  const noteEvent = (hook, session = 'consumer') => ({ hook_event_name: hook, session_id: session });
  assert.equal(checkNotes({ repoDir: repo, stateDir, event: noteEvent('SessionStart') }).status, 'baseline');
  assert.equal(checkNotes({ repoDir: repo, stateDir, event: noteEvent('PreToolUse') }).status, 'unchanged');
  fs.appendFileSync(path.join(repo, 'AGENTS.md'), '\nTransport logs use UTC.\n');
  const notice = checkNotes({ repoDir: repo, stateDir, event: noteEvent('PreToolUse') });
  assert.equal(notice.output.hookSpecificOutput.additionalContext, NOTES_NOTICE);
  assert.equal(notice.output.hookSpecificOutput.permissionDecision, undefined, 'notes notice is advisory');
  assert.ok(!JSON.stringify(notice.output).includes('UTC'), 'generic notification never injects facts');
  assert.equal(checkNotes({ repoDir: repo, stateDir, event: noteEvent('PostToolUse') }).status, 'unchanged', 'one notice per observed whole-file revision');
  assert.equal(checkNotes({ repoDir: repo, stateDir, event: noteEvent('PreToolUse', 'new-session') }).status, 'baseline', 'fresh session does not inherit another session cursor');
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nOwn edit.\n');
  assert.equal(checkNotes({ repoDir: repo, stateDir, event: noteEvent('PostToolUse') }).status, 'changed', 'own writes are not privileged away');

  const baselineHome = path.join(root, 'baseline-home'); fs.mkdirSync(baselineHome);
  const notesAdapter = await prepareCondition({ id: 'notes-notification', repoDir: repo, home: baselineHome });
  assert.ok(notesAdapter.agentConfig.settings.hooks.PreToolUse);
  assert.ok(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').includes('Before declaring a task complete, re-read'));
  const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const native = prepareKlypixHooks({ root: buildRoot, home: baselineHome });
  assert.deepEqual(Object.keys(native.settings.hooks), Object.keys(claudeHookSettings('node fixture').hooks));
  assert.equal(native.settings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell|Edit|Write|MultiEdit');
  const nativeHome = path.join(root, 'native-home'), nativeRepo = path.join(root, 'native-repo');
  fs.mkdirSync(nativeHome); createFixture(nativeRepo, freshEnvironment(nativeHome));
  const product = await prepareCondition({ id: 'klypix-improved', repoDir: nativeRepo, home: nativeHome, improvedRoot: buildRoot });
  const { parseKlypix, questionContextToMarkdown } = await import('../../src/klypix-format.mjs');
  assert.equal((await parseKlypix(fs.readFileSync(path.join(nativeRepo, 'brain.klypix')))).struct.cards.filter(card => card.text).length, 0, 'KLYPIX initialization contains no experimental facts');
  const nativeStart = spawnSync(process.execPath, [path.join(nativeHome, 'klypix-source-hook.mjs')], {
    input: JSON.stringify({ session_id: 'fixture-real-native', hook_event_name: 'SessionStart', source: 'startup', cwd: nativeRepo }),
    cwd: nativeRepo, env: product.agentConfig.env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(nativeStart.status, 0, nativeStart.stderr);
  assert.equal(product.exposureEvidence({ sessionId: 'fixture-real-native' }).length, 1, 'real source SessionStart is auditable in a fresh isolated home');
  const fakeHook = path.join(root, 'echo-hook.mjs'); const wrapper = path.join(root, 'audit-hook.mjs');
  const auditFile = path.join(root, 'audit.jsonl');
  fs.writeFileSync(fakeHook, "import fs from 'node:fs';process.stdout.write(fs.readFileSync(0));");
  fs.writeFileSync(wrapper, auditHookSource({ source: fakeHook, auditFile }));
  const payload = JSON.stringify(noteEvent('PreToolUse', 'native-id'));
  const audited = spawnSync(process.execPath, [wrapper], { input: payload, encoding: 'utf8', env: freshEnvironment(root), windowsHide: true });
  assert.equal(audited.status, 0); assert.equal(audited.stdout, payload, 'native proxy passes event/stdout unchanged');
  assert.equal(deliveredHookEvidence(readHookAudit(auditFile, { sessionId: 'native-id' })).length, 1);
  assert.equal(readHookAudit(auditFile, { sessionId: 'wrong-id' }).length, 0);

  const telemetry = createTelemetry({ repoDir: repo });
  fs.writeFileSync(invoice, 'export const invoiceTotalCents=(xs,p)=>xs.reduce((s,x)=>s+x+Math.round(x*p/100),0);');
  telemetry.observe({ message: { content: [{ type: 'tool_use', id: 'edit-old', name: 'Edit', input: {} }, { type: 'tool_result', tool_use_id: 'edit-old', content: 'edited' }] } });
  assert.equal(fs.existsSync(path.join(repo, 'test/hidden.test.mjs')), false, 'observation creates no hidden tests');
  assert.equal(gradeFixture(repo, CASES[0], shippingHash).success, false, 'stale implementation fails changed case');
  assert.equal(gradeFixture(repo, CASES[1], shippingHash).success, true);
  assert.equal(gradeFixture(repo, CASES[2], shippingHash).success, true);
  fs.writeFileSync(invoice, 'export const invoiceTotalCents=(xs,p)=>{const s=xs.reduce((a,b)=>a+b,0);return s+Math.round(s*p/100)};');
  telemetry.observe({ message: { content: [{ type: 'tool_use', id: 'edit-new', name: 'Bash', input: {} }, { type: 'tool_result', tool_use_id: 'edit-new', content: 'edited' }] } });
  const revisions = gradeRevisions({ revisions: telemetry.revisions, changed: true, scratchDir: path.join(root, 'metrics'), env: freshEnvironment(root) });
  assert.equal(revisions.staleCodeRevisions, 1); assert.equal(revisions.correctedAfterStaleCode, true);
  assert.equal(revisions.firstCodeRevisionCurrent, false); assert.equal(revisions.observedCodeRevisions, 2);
  const unknownRework = gradeRevisions({ revisions: [{ kind: 'completed-tool', source: "import {f} from './helper.mjs'; export const invoiceTotalCents=f;", at: 1 }],
    changed: true, scratchDir: path.join(root, 'unknown-metrics'), env: freshEnvironment(root) });
  assert.equal(unknownRework.eligibleForReworkComparison, false);
  assert.equal(unknownRework.staleCodeRevisions, null, 'unknown historical behavior is never reported as zero rework');
  const capped = { success: true, stages: [], cost: { uncertain: false } };
  applyFlushOutcome(capped, { ok: false, isBudgetLimited: true, accounting: { refusals: [{ reason: 'envelope exhausted' }] } }, 'final');
  assert.equal(finalizeOutcome(capped).outcomeCategory, 'budget-limited');
  assert.equal(capped.success, false, 'a final observer cap cannot leave a successful row');
  const degradedSetup = { success: true, stages: [], cost: { uncertain: false } };
  applyFlushOutcome(degradedSetup, { ok: false, isSetupFailure: true }, 'final');
  assert.equal(finalizeOutcome(degradedSetup).outcomeCategory, 'setup-not-measured');
  assert.equal(degradedSetup.success, false, 'native dependency failure is not a product success or loss');
  const uncertainCost = { success: true, stages: [], cost: { uncertain: true } };
  assert.equal(finalizeOutcome(uncertainCost).outcomeCategory, 'accounting-ineligible');
  const notices = notificationMetrics({ changedAt: 10, revisions: [{ kind: 'completed-tool', at: 30 }],
    responses: [{ at: 11, text: '## Decision changes: PENDING REVIEW', isError: false }],
    hookEvidence: [{ at: 12, exitCode: 0, stdout: NOTES_NOTICE }, { at: 13, exitCode: 1, stdout: NOTES_NOTICE }] });
  assert.equal(notices.decisionNotices, 1); assert.equal(notices.genericNotesNotices, 1);
  assert.equal(notices.noticeBeforeFirstCodeRevision, true);
  const conditions = ['klypix-released', 'klypix-improved', 'notes-native', 'notes-notification', 'claude-mem'];
  const plan = buildPlan({ conditions, seed: 'fixture' });
  assert.equal(plan.filter(row => row.block === 'early-change').length, 25);
  assert.equal(plan.filter(row => row.block === 'personal-longitudinal').length, 5);
  for (const condition of conditions) {
    assert.equal(plan.filter(row => row.conditionId === condition && row.scenario?.changed).length, 3);
    assert.equal(plan.filter(row => row.conditionId === condition && row.block === 'personal-longitudinal').length, 1);
  }
  assert.deepEqual(plan, buildPlan({ conditions, seed: 'fixture' }), 'preregistered order is reproducible');
  assert.equal(PERSONAL_SESSIONS.length + 1, 7); assert.equal(PERSONAL_QUESTIONS.length, 8);
  assert.ok(!/Mira|\b21\b|\bSVG\b|\bPDF\b|\buv\b|3\.12/.test(personalRecallPrompt()), 'recall question prompt contains no answer oracle');
  const personalEvidence = [{ tool: 'Read', input: { file_path: path.join(repo, 'CLAUDE.md') },
    text: 'Current records are tab-delimited. Keep diagnostics 21 days. PDF replaced former SVG. Python 3.12 minimum; uv; owner Mira.' }];
  const personalValues = { delimiter: 'tab', retention: '21 days', export: 'PDF', 'previous-export': 'SVG', runtime: '3.12', packages: 'uv', reviewer: 'Mira', hosting: null };
  const answer = { answers: Object.entries(personalValues).map(([id, value]) => ({ id, value, source: value == null ? null : 'CLAUDE.md' })) };
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, true);
  for (const [id, values] of Object.entries({ delimiter: ['TSV', 'tab character', '\\t', 'tab-delimited text (TSV)'], retention: ['three weeks', '21 days'], runtime: ['>=3.12', 'Python 3.12+', '3.12 or higher', 'Python 3.12 or greater'], export: ['PDF (Portable Document Format)'] })) {
    const selected = answer.answers.find(item => item.id === id), original = selected.value;
    for (const value of values) { selected.value = value; assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, true, `equivalent answer accepted: ${value}`); }
    selected.value = original;
  }
  answer.answers.find(item => item.id === 'delimiter').value = 'tab or pipe';
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, false, 'contradictory old/current values rejected');
  answer.answers.find(item => item.id === 'delimiter').value = 'tab';
  for (const source of ['1', '#1', 'Observation #1', '12']) {
    const id = source === '12' ? 12 : 1;
    const cited = { answers: answer.answers.map(item => ({ ...item, source: item.value == null ? null : source })) };
    const nativeEvidence = [{ text: `#${id} — Larch decisions\n${personalEvidence[0].text}\n\n#99 — Unrelated\nWeather is sunny.` }];
    assert.equal(gradePersonalRecall(JSON.stringify(cited), nativeEvidence).pass, true, `native short record citation supported: ${source}`);
    assert.equal(gradePersonalRecall(JSON.stringify(cited), [{ text: JSON.stringify([{ id, facts: personalEvidence[0].text }, { id: 99, facts: 'Weather' }]) }]).pass, true);
  }
  const wrongRecord = { answers: answer.answers.map(item => ({ ...item, source: item.value == null ? null : 'record-1111' })) };
  assert.equal(gradePersonalRecall(JSON.stringify(wrongRecord), [{ text: `record-1111: unrelated weather.\nrecord-2222: ${personalEvidence[0].text}` }]).pass, false, 'facts must be in cited record, not elsewhere in response');
  const shortWrong = { answers: answer.answers.map(item => ({ ...item, source: item.value == null ? null : '#1' })) };
  assert.equal(gradePersonalRecall(JSON.stringify(shortWrong), [{ text: `#1 — Weather\nSunny.\n#12 — Larch decisions\n${personalEvidence[0].text}` }]).pass, false, 'short ID must not match a longer ID or another record');
  const nativeAskText = questionContextToMarkdown('Larch project decisions', { total: 2, hits: [
    { card: { id: 'txt_weather', area: 'Weather', createdAt: Date.UTC(2026, 10, 9), text: 'Sunny.' } },
    { card: { id: 'txt_larch', area: 'Larch', createdAt: Date.UTC(2026, 10, 9), text: personalEvidence[0].text } },
  ] });
  const nativeLocatorAnswers = source => ({ answers: answer.answers.map(item => ({ ...item, source: item.value == null ? null : source })) });
  assert.equal(gradePersonalRecall(JSON.stringify(nativeLocatorAnswers('[Larch] 2026-11-09')), [{ text: nativeAskText }]).pass, true, 'actual brain_ask native area/date source locator qualifies');
  assert.equal(gradePersonalRecall(JSON.stringify(nativeLocatorAnswers('[Weather] 2026-11-09')), [{ text: nativeAskText }]).pass, false, 'a native locator cannot borrow facts from a neighboring section');
  answer.answers.find(item => item.id === 'hosting').value = 'AWS';
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).unsupportedClaims, 1);
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, false, 'seven known facts do not excuse an invented hosting decision');
  answer.answers.find(item => item.id === 'hosting').value = null;
  answer.answers.find(item => item.id === 'retention').value = '14 days';
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, false, 'stale facts fail the unsupported/current-fact check');
  answer.answers.find(item => item.id === 'retention').value = null;
  answer.answers.find(item => item.id === 'retention').source = null;
  assert.equal(gradePersonalRecall(JSON.stringify(answer), personalEvidence).pass, true, 'seven supported answers with one abstention meet the fixed pass mark');
  assert.equal(gradePersonalRecall(JSON.stringify(answer), []).pass, false, 'self-reported correct facts without served sources do not pass');
  assert.equal(gradeFixture(repo, CASES[0], shippingHash).success, true);
  assert.equal(gradeFixture(repo, CASES[1], shippingHash).success, false, 'unnecessary policy reversal fails harm control');
  fs.writeFileSync(path.join(repo, 'lib/shipping.mjs'), 'export const shippingCents=()=>0;');
  assert.equal(gradeFixture(repo, CASES[0], shippingHash).success, false, 'unrelated edits fail harm check');
  await import('./test-passive-audit.mjs');
  console.log('decision-change self-test: budget, isolation, exposure, native hook parity, passive native audit, generic notes notice, observational rework and harm graders passed (zero model calls)');
} finally {
  const target = fs.realpathSync(root);
  assert.ok(path.basename(target).startsWith('decision-change-self-test-'));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
