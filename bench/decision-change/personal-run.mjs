import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareClaudeHome, reservationUsd, runClaudeStage } from './agent.mjs';
import { MEASUREMENT_TRANSPORT, readPassiveAudit } from './passive-audit.mjs';
import { prepareCondition } from './adapters.mjs';
import { createFixture, fileHash } from './scenarios.mjs';
import { PERSONAL_SESSIONS, personalCapturePrompt, personalRecallPrompt, gradePersonalRecall } from './personal-scenario.mjs';
import { costBetween } from './ledger.mjs';
import { applyFlushOutcome, finalizeOutcome } from './outcomes.mjs';
import { authenticationMetadata } from './auth.mjs';

export async function runPersonalReplay({ conditionId, runId, outDir, ledger, limits, approved,
  releasedRoot, improvedRoot, credentialFile, claudeMem = {}, protocol = 'early-boundary-v2', authentication = null }) {
  const auth = authenticationMetadata(authentication);
  authentication?.assertPublic({ conditionId, runId, outDir, limits, releasedRoot, improvedRoot, credentialFile, claudeMem });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decision-change-personal-'));
  const home = path.join(scratch, 'home'), repoDir = path.join(scratch, 'repo');
  const artifacts = path.join(outDir, runId); fs.mkdirSync(artifacts, { recursive: true });
  const row = { runId, block: 'personal-longitudinal-v1', condition: conditionId, protocol, measurementTransport: MEASUREMENT_TRANSPORT, authentication: auth,
    scope: 'One persistent isolated project/profile; six chronological capture sessions plus final recall; simulated days with real timestamps',
    startedAt: new Date().toISOString(), budgetBefore: ledger.snapshot(), stages: [], firstAttempt: true, success: false };
  let adapter; let recallSession;
  try {
    const env = prepareClaudeHome(home, { credentialFile, authentication });
    createFixture(repoDir, env);
    const codeHash = fileHash(path.join(repoDir, 'lib/invoice.mjs'));
    adapter = await prepareCondition({ id: conditionId, repoDir, home, ledger, releasedRoot, improvedRoot, claudeMem, protocol, authentication });
    row.configuration = adapter.metadata;
    if (adapter.metadata?.paidReady === false) { row.notMeasured = adapter.metadata.reason || 'Adapter not ready'; return row; }
    await adapter.start?.({ allowPaid: approved === true });
    const instructions = `${adapter.instructions} Preserve a brief labeled history when a durable choice is explicitly replaced; keep the current choice unambiguous.`;
    const prompts = [...PERSONAL_SESSIONS.map(session => ({ role: `personal-day-${session.day}`, prompt: personalCapturePrompt(session, instructions) })),
      { role: 'personal-recall', prompt: personalRecallPrompt() }];
    for (const { role, prompt } of prompts) {
      if (ledger.remaining() < reservationUsd(limits)) {
        row.notMeasured = 'Aggregate budget cannot reserve the next longitudinal session'; row.failure = 'aggregate-budget-stop'; break;
      }
      const sessionId = crypto.randomUUID();
      if (role === 'personal-recall') recallSession = sessionId;
      const result = await runClaudeStage({ approved, id: `${runId}-${role}`, role, repoDir, home, prompt, sessionId, authentication,
        config: { ...adapter.agentConfig, env: { ...env, ...adapter.agentConfig?.env } }, ledger, limits,
        transcriptDir: artifacts, timeoutMs: 180_000 });
      row.stages.push({ role, ...result });
      if (result.telemetryErrors?.length) row.notMeasured = 'Native telemetry or stream observation failed; preserve attempt and cost';
      if (!result.ok) { row.failure = `${role}-failed`; break; }
      const flush = await adapter.flush({ deadlineMs: 120_000 });
      applyFlushOutcome(row, flush, role);
      if (!flush?.ok) { row.flush = flush; break; }
      if (fileHash(path.join(repoDir, 'lib/invoice.mjs')) !== codeHash) { row.failure = 'implementation-edited-during-memory-replay'; break; }
      if (role === 'personal-recall') {
        const native = await adapter.exposureEvidence?.({ sessionId }) || [];
        const audit = readPassiveAudit(result.auditDirectory, { sessionId, final: true });
        if (!audit.ok) throw new Error('Native recall audit failed');
        row.recallEvidence = [...audit.responses.filter(response => !response.isError), ...native];
        row.grade = gradePersonalRecall(result.finalMessage, row.recallEvidence);
        row.success = row.grade.pass;
        row.failure = row.success ? null : 'recall-current-history-or-support-failed';
      }
    }
  } catch (error) {
    row.failure = row.stages.length ? 'execution-error' : 'setup-error'; row.error = String(error.stack || error);
    if (/audit|telemetry/i.test(error.message)) {
      row.notMeasured = 'Native telemetry failed; preserve attempt and cost';
      (row.telemetryErrors ||= []).push({ error: error.message });
    }
    if (!row.stages.length) row.notMeasured = 'Setup failed before a completed model stage; preserve costs and diagnostics';
  } finally {
    try { applyFlushOutcome(row, await adapter?.flush?.({ deadlineMs: 30_000 }), 'final'); }
    catch (error) { row.success = false; row.failure ||= 'final-capture-check-error'; row.finalFlushError = error.message; }
    row.hookAudit = await adapter?.hookAudit?.({ sessionId: recallSession }) || [];
    try { await adapter?.close?.(); } catch (error) { row.cleanupError = error.message; }
    row.observerAccounting = await adapter?.accounting?.() || null;
    if (row.observerAccounting) applyFlushOutcome(row, {
      ok: !row.observerAccounting.refusals?.length && !row.observerAccounting.records?.some(record => record.capped || record.status === 'unknown'),
      accounting: row.observerAccounting,
    }, 'after-close');
    row.budgetAfter = ledger.snapshot(); row.cost = costBetween(row.budgetBefore, row.budgetAfter);
    row.finishedAt = new Date().toISOString();
    finalizeOutcome(row);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(row, null, 2));
    const target = fs.realpathSync(scratch), relative = path.relative(os.tmpdir(), target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !path.basename(target).startsWith('klypix-decision-change-personal-')) throw new Error('Refusing cleanup outside fresh personal replay temp directory');
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) {
      row.cleanupError = `Isolated temporary profile cleanup failed at ${target}: ${error.message}`;
      fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(row, null, 2));
    }
  }
  return row;
}
