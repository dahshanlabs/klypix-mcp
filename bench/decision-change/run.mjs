// Controlled same-host active-session pilot. No cross-vendor claim and no
// ranking. Default execution is deterministic and spends no model usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BudgetLedger, costBetween } from './ledger.mjs';
import { inspectClaude, prepareClaudeHome, reservationUsd, runClaudeStage, isNormalMemoryRetrieval } from './agent.mjs';
import { MEASUREMENT_TRANSPORT } from './passive-audit.mjs';
import { prepareCondition } from './adapters.mjs';
import { CASES, matchesInitialPolicy, initialPrompt, consumerPrompt, createFixture, gradeFixture, fileHash } from './scenarios.mjs';
import { createTelemetry, notificationMetrics, gradeRevisions } from './metrics.mjs';
import { runPersonalReplay } from './personal-run.mjs';
import { applyFlushOutcome, finalizeOutcome } from './outcomes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

export async function runWorkflow({ conditionId, scenario, runId, outDir, ledger, limits, approved,
  releasedRoot, improvedRoot = ROOT, credentialFile, claudeMem = {}, timeoutMs = 600_000, protocol = 'early-boundary-v2' }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decision-change-'));
  const home = path.join(scratch, 'home'); const repoDir = path.join(scratch, 'repo');
  const artifacts = path.join(outDir, runId); fs.mkdirSync(artifacts, { recursive: true });
  let homeEnv; let originalCode; let shippingHash; let telemetry;
  const gatePath = path.join(scratch, 'checkpoint');
  const sessionIds = {};
  const row = { runId, condition: conditionId, scenario: scenario.id,
    block: 'early-change', protocol, measurementTransport: MEASUREMENT_TRANSPORT, budgetBefore: ledger.snapshot(),
    scope: 'same-host active-session change; controlled barrier; developer-authored fixture',
    startedAt: new Date().toISOString(), stages: [], firstAttempt: true, success: false };
  let adapter; let consumerPromise; let consumerFinished = false; let consumerAudit;
  const preReservedRoles = new Set(); const startedRoles = new Set();
  const stage = async (role, prompt, config = {}) => {
    const sessionId = sessionIds[role] = crypto.randomUUID();
    startedRoles.add(role);
    const result = await runClaudeStage({ approved, id: `${runId}-${role}`, role, repoDir, home,
      prompt, sessionId, config: { ...adapter.agentConfig, ...config,
        env: { ...homeEnv, ...adapter.agentConfig?.env, ...config.env } },
      ledger, limits, transcriptDir: artifacts, timeoutMs: role === 'consumer' ? timeoutMs : 120_000,
      preReserved: preReservedRoles.has(role),
      onAuditReady: role === 'consumer' ? audit => { consumerAudit = audit; } : null });
    row.stages.push({ role, ...result });
    if (result.telemetryErrors?.length) row.notMeasured = 'Native telemetry or stream observation failed; preserve attempt and cost';
    return result;
  };
  try {
    homeEnv = prepareClaudeHome(home, { credentialFile });
    createFixture(repoDir, homeEnv);
    originalCode = fileHash(path.join(repoDir, 'lib/invoice.mjs'));
    shippingHash = fileHash(path.join(repoDir, 'lib/shipping.mjs'));
    telemetry = createTelemetry({ repoDir });
    adapter = await prepareCondition({ id: conditionId, repoDir, home, ledger, releasedRoot, improvedRoot, claudeMem, protocol });
    row.configuration = adapter.metadata;
    if (adapter.metadata?.paidReady === false) {
      row.notMeasured = adapter.metadata.reason || 'Adapter not ready for bounded paid execution';
      return row;
    }
    await adapter.start?.({ allowPaid: approved === true });
    const initial = await stage('producer-initial', initialPrompt(adapter.instructions));
    if (!initial.ok) { row.failure = 'producer-initial-failed'; return row; }
    const initialFlush = await adapter.flush({ deadlineMs: 120_000 });
    applyFlushOutcome(row, initialFlush, 'producer-initial');
    if (!initialFlush?.ok) { row.flush = initialFlush; return row; }
    if (fileHash(path.join(repoDir, 'lib/invoice.mjs')) !== originalCode) {
      row.failure = 'producer-edited-implementation'; return row;
    }
    const stageReserve = reservationUsd(limits);
    if (ledger.remaining() < stageReserve * 2) {
      row.notMeasured = 'Global budget cannot reserve consumer and producer update after initial capture';
      row.failure = 'aggregate-budget-stop-before-consumer'; return row;
    }
    // Hold BOTH foreground envelopes before starting the consumer. Observer
    // activity cannot use the funds needed for the pending producer update.
    for (const role of ['consumer', 'producer-update']) {
      ledger.reserve({ id: `${runId}-${role}`, kind: `agent:${role}`, maxUsd: stageReserve,
        meta: { model: limits.model, stageBudgetUsd: limits.stageBudgetUsd, pricing: limits.priceSource, prepaid: true } });
      preReservedRoles.add(role);
    }
    const gateServer = { command: process.execPath, args: [path.join(HERE, 'gate.mjs'), gatePath] };
    consumerPromise = stage('consumer', consumerPrompt({ protocol }), {
      mcpServers: { ...(adapter.agentConfig?.mcpServers || {}), 'project-checkpoint': gateServer },
    }).finally(() => { consumerFinished = true; });
    consumerPromise.catch(() => {}); // awaited below; don't race Node's unhandled-rejection check
    const gateDeadline = Date.now() + timeoutMs;
    while (!fs.existsSync(`${gatePath}.arrived`) && !consumerFinished && Date.now() < gateDeadline) await sleep(100);
    if (!fs.existsSync(`${gatePath}.arrived`)) {
      row.failure = 'consumer-did-not-reach-checkpoint';
      fs.writeFileSync(`${gatePath}.abort`, 'abort');
      await consumerPromise;
      return row;
    }
    row.checkpoint = JSON.parse(fs.readFileSync(`${gatePath}.arrived`, 'utf8'));
    // Only a completed prior batch can have reached the model that requested
    // this checkpoint. A Read in the checkpoint's own batch does not qualify,
    // even if its stdout tool_result or PostToolUse audit is already visible.
    const priorAudit = consumerAudit.read({ before: row.checkpoint.at });
    if (!priorAudit.ok) {
      row.failure = 'native-telemetry-invalid'; row.notMeasured = 'Native audit failed before checkpoint';
      row.telemetryErrors = priorAudit.errors;
      fs.writeFileSync(`${gatePath}.abort`, 'abort'); await consumerPromise; return row;
    }
    telemetry.observeAudit(priorAudit);
    const hookEvidence = await adapter.exposureEvidence?.({ sessionId: sessionIds.consumer }) || [];
    const priorContext = hookEvidence.filter(item => {
      const at = typeof item.at === 'number' ? item.at : Date.parse(item.at);
      return at <= row.checkpoint.at && (['SessionStart', 'UserPromptSubmit'].includes(item.hookEvent)
        || priorAudit.latestBatchAt !== null && at <= priorAudit.latestBatchAt);
    });
    row.initialEvidence = [...priorAudit.responses.filter(item => !item.isError && matchesInitialPolicy(item.text)),
      ...priorContext.filter(item => matchesInitialPolicy(item.text || item.stdout || ''))];
    if (!row.initialEvidence.length) {
      row.initialRetrievalResponses = priorAudit.responses.filter(isNormalMemoryRetrieval);
      if (row.initialRetrievalResponses.length) {
        row.failure = 'initial-policy-not-retrieved';
        row.causalUpdateMeasurement = 'Not reached: actual memory retrieval did not deliver the required initial policy';
      } else {
        row.exposureUnverified = true;
        row.notMeasured = 'Initial policy exposure could not be verified from an actual tool response or native context injection';
        row.failure = 'initial-policy-exposure-unverified';
      }
      fs.writeFileSync(`${gatePath}.abort`, 'abort');
      await consumerPromise;
      return row;
    }
    if (fileHash(path.join(repoDir, 'lib/invoice.mjs')) !== originalCode) {
      row.failure = 'consumer-edited-before-checkpoint';
      fs.writeFileSync(`${gatePath}.abort`, 'abort'); await consumerPromise; return row;
    }
    row.policyChangeStartedAt = new Date().toISOString();
    const update = await stage('producer-update', `${adapter.instructions}\n\n${scenario.update}\nFinish after saving and state what was saved.`);
    const updateFlush = await adapter.flush({ deadlineMs: 120_000 });
    applyFlushOutcome(row, updateFlush, 'producer-update');
    row.updateFlush = updateFlush;
    if (!update.ok || !updateFlush?.ok) {
      row.failure ||= 'producer-update-or-product-capture-failed';
      fs.writeFileSync(`${gatePath}.abort`, 'abort'); await consumerPromise; return row;
    }
    if (fileHash(path.join(repoDir, 'lib/invoice.mjs')) !== originalCode) {
      row.failure = 'producer-update-edited-implementation';
      fs.writeFileSync(`${gatePath}.abort`, 'abort'); await consumerPromise; return row;
    }
    // The released response is byte-identical for changed and harm controls.
    row.policyChangeFinishedAt = new Date().toISOString();
    fs.writeFileSync(`${gatePath}.release`, 'continue');
    const consumer = await consumerPromise;
    telemetry.observeAudit(consumerAudit.read({ final: true }));
    telemetry.snapshot({ kind: 'final-after-consumer' });
    row.nativeHookEvidence = await adapter.exposureEvidence?.({ sessionId: sessionIds.consumer }) || [];
    row.notifications = notificationMetrics({ responses: telemetry.responses, hookEvidence: row.nativeHookEvidence,
      changedAt: row.policyChangeFinishedAt, revisions: telemetry.revisions });
    row.rework = gradeRevisions({ revisions: telemetry.revisions, changed: scenario.changed,
      scratchDir: path.join(scratch, 'post-run-metrics'), env: homeEnv });
    writeJson(path.join(artifacts, 'observed-source-revisions.json'), telemetry.revisions);
    row.grade = gradeFixture(repoDir, scenario, shippingHash);
    // A generic whole-file notice honestly reports an unrelated text change;
    // count its burden without calling it a false claim about invoice policy.
    row.falseChangeNotice = !scenario.changed && row.notifications.decisionNotices > 0;
    row.success = consumer.ok && row.grade.success && !row.falseChangeNotice;
    row.failure = row.success ? null : (!consumer.ok ? 'consumer-error-or-budget'
      : row.falseChangeNotice ? 'spurious-decision-change-warning' : 'functional-or-harm-check-failed');
    return row;
  } catch (error) {
    row.failure = row.stages.length ? 'execution-error' : 'setup-error'; row.error = String(error.stack || error);
    if (/audit|telemetry/i.test(error.message)) {
      row.notMeasured = 'Native telemetry failed; preserve attempt and cost';
      (row.telemetryErrors ||= []).push({ error: error.message });
    }
    if (!row.stages.length) row.notMeasured = 'Setup failed before a completed model stage; preserve any incurred cost and diagnostics';
    if (consumerPromise && !consumerFinished) {
      fs.writeFileSync(`${gatePath}.abort`, 'abort');
      try { await consumerPromise; } catch { /* budget error already retained */ }
    }
    return row;
  } finally {
    for (const role of preReservedRoles) if (!startedRoles.has(role)) {
      ledger.settle(`${runId}-${role}`, { actualUsd: 0, usage: { notStarted: true, role } });
    }
    try { applyFlushOutcome(row, await adapter?.flush?.({ deadlineMs: 30_000 }), 'final'); }
    catch (error) { row.success = false; row.failure ||= 'final-capture-check-error'; row.finalFlushError = error.message; }
    try { await adapter?.close?.(); } catch (error) { row.cleanupError = error.message; }
    row.observerAccounting = await adapter?.accounting?.() || null;
    if (row.observerAccounting) applyFlushOutcome(row, {
      ok: !row.observerAccounting.refusals?.length && !row.observerAccounting.records?.some(record => record.capped || record.status === 'unknown'),
      accounting: row.observerAccounting,
    }, 'after-close');
    row.hookAudit = await adapter?.hookAudit?.({ sessionId: sessionIds.consumer }) || [];
    row.finishedAt = new Date().toISOString();
    row.budgetAfter = ledger.snapshot();
    row.cost = costBetween(row.budgetBefore, row.budgetAfter);
    finalizeOutcome(row);
    writeJson(path.join(artifacts, 'result.json'), row);
    // Preserve only fixture source and audit evidence. Credentials, databases,
    // settings and running host state remain in scratch and are removed.
    for (const file of ['lib/invoice.mjs', 'lib/shipping.mjs']) {
      if (!fs.existsSync(path.join(repoDir, file))) continue;
      const dest = path.join(artifacts, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(repoDir, file), dest);
    }
    const realScratch = fs.realpathSync(scratch);
    const relativeScratch = path.relative(os.tmpdir(), realScratch);
    if (!relativeScratch || relativeScratch.startsWith('..') || path.isAbsolute(relativeScratch)
      || !path.basename(realScratch).startsWith('klypix-decision-change-')) throw new Error('Refusing cleanup outside the fresh benchmark temp directory');
    try { fs.rmSync(realScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) {
      row.cleanupError = `Isolated temporary profile cleanup failed at ${realScratch}: ${error.message}`;
      writeJson(path.join(artifacts, 'result.json'), row);
    }
  }
}

export function buildPlan({ conditions, cases = CASES, correctedRepetitions = 3, seed, blocks = ['early-change', 'personal-longitudinal'] }) {
  const orderKey = key => crypto.createHash('sha256').update(`${seed}:${key}`).digest('hex');
  const ordered = [...conditions].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  const plan = [];
  for (let repetition = 1; repetition <= correctedRepetitions; repetition++) {
    const families = [];
    if (blocks.includes('early-change')) families.push(...cases.filter(s => repetition === 1 || s.changed)
      .map(scenario => ({ block: 'early-change', scenario })));
    if (repetition === 1 && blocks.includes('personal-longitudinal')) families.push({ block: 'personal-longitudinal' });
    families.sort((a, b) => orderKey(`${a.block}:${a.scenario?.id || ''}`).localeCompare(orderKey(`${b.block}:${b.scenario?.id || ''}`)));
    // Rotate condition order across families and repetitions. Interleave the
    // families so longitudinal cases are not all pushed beyond the budget.
    for (let slot = 0; slot < ordered.length; slot++) for (let family = 0; family < families.length; family++) {
      const conditionId = ordered[(slot + family + repetition - 1) % ordered.length];
      plan.push({ ...families[family], conditionId, repetition });
    }
  }
  return plan;
}

export async function runPlanRows(plan, { ledger, reserveFor, execute, onResult = () => {} }) {
  let attempted = 0, stopReason = null;
  for (const entry of plan) {
    if (ledger.remaining() < reserveFor(entry)) { stopReason = 'Insufficient aggregate reserve for next workflow'; break; }
    const row = await execute(entry);
    await onResult(row, entry); attempted++;
    if (row.telemetryErrors?.length || row.stages?.some(stage => stage.telemetryErrors?.length)
      || row.failure === 'native-telemetry-invalid') { stopReason = 'Instrumentation review required'; break; }
    if (ledger.snapshot().halted) { stopReason = 'Budget accounting requires review'; break; }
    if (row.cleanupError) { stopReason = 'Isolated profile cleanup requires review'; break; }
  }
  return { attempted, stopReason };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback = null) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
  if (args.includes('--preflight')) { console.log(JSON.stringify(inspectClaude(), null, 2)); return; }
  if (!args.includes('--live')) {
    await import('./self-test.mjs');
    return;
  }
  if (!args.includes('--paid-approved')) throw new Error('Root must review the ledger and pricing envelope before --paid-approved is supplied');
  const protocolRevision = opt('protocol-revision');
  if (!/^[0-9a-f]{7,40}$/i.test(protocolRevision || '')) throw new Error('--protocol-revision must identify the reviewed, published preregistration commit before paid work');
  const limitsPath = opt('limits');
  if (!limitsPath) throw new Error('--limits requires a reviewed model/pricing JSON file');
  const limits = JSON.parse(fs.readFileSync(limitsPath, 'utf8'));
  const reservePerStage = reservationUsd(limits);
  const outDir = path.resolve(opt('out', path.join(os.tmpdir(), `decision-change-results-${Date.now()}`)));
  fs.mkdirSync(outDir, { recursive: true });
  const ledgerPath = opt('ledger');
  if (!ledgerPath) throw new Error('--ledger must name the ONE shared $50 ledger for all smokes, output directories and later repetitions');
  const ledger = new BudgetLedger(ledgerPath, { limitUsd: 50 });
  if (ledger.snapshot().reservations.some(r => r.status === 'reserved')) throw new Error('Unsettled reservations remain; review their costs before starting more work');
  const protocol = opt('protocol', 'early-boundary-v2');
  if (!['early-boundary-v2', 'preliminary-sync-v1'].includes(protocol)) throw new Error('Unknown protocol');
  const conditions = opt('conditions', protocol === 'early-boundary-v2'
    ? 'klypix-released,klypix-improved,notes-native,notes-notification,claude-mem'
    : 'klypix-released,klypix-improved,notes-native,claude-mem').split(',');
  const cases = opt('cases', CASES.map(s => s.id).join(',')).split(',').map(id => {
    const s = CASES.find(c => c.id === id); if (!s) throw new Error(`Unknown case ${id}`); return s;
  });
  const releasedRoot = opt('released-root');
  if (conditions.includes('klypix-released') && !releasedRoot) throw new Error('--released-root must identify the exact released source build');
  const credentialFile = opt('credential-file');
  const claudeMem = opt('claude-mem-config') ? JSON.parse(fs.readFileSync(opt('claude-mem-config'), 'utf8')) : {};
  const output = path.join(outDir, 'results.jsonl');
  if (fs.existsSync(output) && fs.statSync(output).size) throw new Error('Use a new output directory; paid retries must never replace prior outcomes');
  const correctedRepetitions = Number(opt('corrected-repetitions', '3'));
  if (!Number.isInteger(correctedRepetitions) || correctedRepetitions < 1 || correctedRepetitions > 3) throw new Error('Pilot corrected repetitions must be 1..3, preregistered before results');
  const seed = opt('seed', 'decision-change-pilot-1');
  const blocks = opt('blocks', protocol === 'early-boundary-v2' ? 'early-change,personal-longitudinal' : 'early-change').split(',');
  if (!blocks.length || blocks.some(block => !['early-change', 'personal-longitudinal'].includes(block))) throw new Error('Unknown experiment block');
  const plan = buildPlan({ conditions, cases, correctedRepetitions, seed, blocks });
  const planned = plan.map(p => ({ block: p.block, case: p.scenario?.id || null, condition: p.conditionId, repetition: p.repetition }));
  const budgetAtStart = ledger.snapshot(), ledgerBaselineBytes = fs.readFileSync(path.resolve(ledgerPath));
  const ledgerBaseline = { sha256: crypto.createHash('sha256').update(ledgerBaselineBytes).digest('hex'),
    byteLength: ledgerBaselineBytes.length, reservationIds: budgetAtStart.reservations.map(record => record.id),
    knownApiEquivalentUsd: budgetAtStart.reservations.filter(record => record.status === 'settle').reduce((sum, record) => sum + record.actualUsd, 0),
    chargedAgainstBudgetUsd: budgetAtStart.spentCents / 100 };
  writeJson(path.join(outDir, 'experiment.json'), { schema: 2, protocol, protocolRevision, measurementTransport: MEASUREMENT_TRANSPORT,
    noPriorUsageInLedger: budgetAtStart.reservations.length === 0,
    budgetAtStart, ledgerBaseline,
    limits, reservePerStage, ledger: path.resolve(ledgerPath),
    conditions, blocks, cases: cases.map(s => s.id), correctedRepetitions, seed, plan: planned,
    passMarks: { earlyFunctional: 'All 3 corrected repetitions and both controls pass current-policy/untouched-shipping checks; no spurious invoice-change warning in controls',
      personal: 'At least 7 of 8 source-supported answers, zero unsupported claims, all seven sessions completed; one replay per condition',
      continuation: 'At least 30% fewer stale-policy-correct code revisions than strongest notes control, no final-accuracy regression, at most 10% higher total model cost; complete matched data required; zero baseline rework means no demonstrated advantage' },
    releasedRoot, improvedRoot: ROOT, integration: 'same-host controlled active-session update; no cross-tool ranking claim',
    budgetBasis: 'CLI API-equivalent estimates including observer; actual subscription invoice unknown',
    nativeSessionPersistence: true, sourceHashes: Object.fromEntries(fs.readdirSync(HERE).filter(f => f.endsWith('.mjs')).map(f => [f, fileHash(path.join(HERE, f))])) });
  const { attempted, stopReason } = await runPlanRows(plan, { ledger,
    reserveFor: ({ block }) => reservePerStage * (block === 'early-change' ? 2 : 1),
    execute: async ({ block, scenario, conditionId, repetition }) => {
    const runId = `${scenario?.id || block}-${conditionId}-r${repetition}-${crypto.randomUUID().slice(0, 8)}`;
    const common = { conditionId, scenario, runId, outDir, ledger, limits, approved: true,
      releasedRoot, improvedRoot: ROOT, credentialFile, claudeMem, protocol };
    const row = block === 'early-change' ? await runWorkflow(common) : await runPersonalReplay(common);
    row.repetition = repetition;
    return row;
    }, onResult: (row, { conditionId, scenario, block }) => {
    fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
    console.log(`${conditionId} / ${scenario?.id || block}: ${row.notMeasured ? 'NOT MEASURED' : row.success ? 'PASS' : 'FAIL'}${row.failure ? ` (${row.failure})` : ''}; reserved + settled $${((50 - ledger.remaining())).toFixed(2)} API-equivalent`);
    } });
  writeJson(path.join(outDir, 'run-summary.json'), { attempted, planned: plan.length, stopReason,
    notStarted: planned.slice(attempted).map(item => ({ ...item, outcomeCategory: 'not-started', reason: stopReason })), budget: ledger.snapshot() });
  if (stopReason) console.log(`Stopped: ${stopReason}. Remaining planned rows are recorded as not started.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
