// Administrative continuation only. Original source, pass marks and raw rows
// remain unchanged. No credentials are loaded unless --paid-approved is set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const BASE = 'E:/tmp/klypix-decision-pilot-20261108';
const OUT = 'C:/Users/HP/AppData/Local/Temp/klypix-decision-pilot-observer-fixed-20261109';
const SOURCE = 'E:/klypix-build/klypix-mcp-1.111.0-gate';
const RETAINED = `${BASE}/observer-fixed-interruption-v1-retained`;
const FREEZE = `${BASE}/observer-fixed-freeze-eaa5ebd-20261109T121819802Z.public.json`;
const CONFIG = 'E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5/adapter-config.json';
const LEDGER = `${BASE}/budget.jsonl`;
const EXPECTED = Object.freeze({
  sourceCommit: 'eaa5ebd4d6fb9e6b0a4631356128771da46690d2',
  experimentSha256: '058c73c25151371b7cf7aa041356203e49b6c13bc27f7cf5f6714d860492feb5',
  freezeSha256: 'edf2ed2d57b5a761795254693cd13c9ef0dff1a947fa5cf5c384668310193273',
  configSha256: '7a0c8573e87c91e6601d62739ff8f456b8459402ad751ad1ad77156958e14842',
  originalSummarySha256: 'e4152f663b80fb2fbbc43ad5226007d47a11d07ec27374499b2201144e0483f6',
  originalResultsPrefix: { sha256: '97756075c5a09aad12df5ba48e55bdc7f6d43c00d38b5a75021c4ec6b8dbc340', byteLength: 314816, rowCount: 4 },
  originalLedgerPrefix: { sha256: '624ed5388092263e71555b8cf260e22065b3f05fd889a36d2031d83065314274', byteLength: 35291 },
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const resultsFile = `${OUT}/results.jsonl`, receiptFile = `${OUT}/cleanup-quiescence.jsonl`, manifestFile = `${OUT}/continuation.json`;
const ownFile = fileURLToPath(import.meta.url);
function checkPrefix(bytes, expected) {
  assert.ok(bytes.length >= expected.byteLength, 'A preserved prefix was shortened');
  assert.equal(sha(bytes.subarray(0, expected.byteLength)), expected.sha256, 'Preserved prefix changed');
}
function rowIdentity(row) { return { block: row.block === 'personal-longitudinal-v1' ? 'personal-longitudinal' : row.block,
  case: row.scenario || null, condition: row.condition, repetition: row.repetition }; }
function auditEligible(row) {
  return !row.notMeasured && !row.budgetLimited && !row.accountingIneligible && !row.setupFailure
    && !row.telemetryErrors?.length && !row.finalFlushError && !row.cost?.uncertain
    && ['pass', 'measured-failure'].includes(row.outcomeCategory)
    && row.stages?.length === (row.block === 'personal-longitudinal-v1' ? 7 : 3)
    && row.stages.every(s => s.ok && s.nativeAuditFinalized && !s.pendingNativeResults?.length
      && !s.telemetryErrors?.length && !s.unpricedModel && !s.timedOut && !s.budgetLimited
      && s.authentication?.method === 'api-key')
    && !row.flushes?.some(f => !f.ok)
    && row.cost?.reservations?.length > 0 && row.cost.reservations.every(r => r.status === 'settle' && Number.isFinite(r.actualUsd));
}
function instrumentationStop(row) {
  return row.telemetryErrors?.length || row.stages?.some(stage => stage.telemetryErrors?.length) || row.failure === 'native-telemetry-invalid';
}
function cleanupScratch(row) {
  assert.equal(row.condition, 'claude-mem', 'Only diagnosed native competitor cleanup may be resolved');
  assert.match(row.cleanupError || '', /^Isolated temporary profile cleanup failed at .*: EPERM,/);
  assert.ok(auditEligible(row), 'Cleanup resolution requires completed, valid measurement and known costs');
  const scratch = row.cleanupError.match(/^Isolated temporary profile cleanup failed at (.+?): EPERM,/)[1];
  assert.match(path.basename(scratch), /^klypix-decision-change-(?:personal-)?[A-Za-z0-9]+$/);
  assert.equal(path.relative(os.tmpdir(), path.resolve(scratch)).split(path.sep).length, 1, 'Scratch must be a direct owned temporary folder');
  assert.ok(samePath(fs.realpathSync(scratch), scratch), 'Scratch may not redirect elsewhere');
  assert.equal(row.configuration?.oauthCredentialCopied, false);
  assert.equal(row.configuration?.authentication?.method, 'api-key');
  assert.ok(row.observerAccounting?.records?.length > 0);
  assert.equal(row.observerAccounting.reservedUsd, 0);
  assert.equal(row.observerAccounting.refusals?.length || 0, 0);
  assert.ok(row.observerAccounting.records.every(r => r.status === 'settled' && !r.inFlight && !r.capped && r.authMethod === 'api-key' && Number.isFinite(r.cost)));
  return scratch;
}
async function closedPort(port) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500); socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', error => resolve(error.code === 'ECONNREFUSED'));
  });
}
function liveProcesses(scratch, knownPids) {
  // The script itself travels over stdin: its source cannot falsely match the
  // runtime-path scan. No environment or command-line contents are returned.
  const q = value => `'${value.replaceAll("'", "''")}'`;
  const code = `$target=${q(scratch.replaceAll('/', '\\'))}; $known=@(${knownPids.join(',')}); $found=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $known -contains $_.ProcessId -or ($_.CommandLine -and $_.CommandLine.Replace('/','\\').IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $found -Compress`;
  return JSON.parse(execFileSync(process.env.KLYPIX_BENCH_PWSH || 'pwsh.exe', ['-NoProfile', '-Command', '-'],
    { input: code, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim());
}
function ledgerBinding(ledger) {
  const bytes = fs.readFileSync(LEDGER); checkPrefix(bytes, EXPECTED.originalLedgerPrefix);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.halted, false); assert.equal(snapshot.reservedCents, 0);
  assert.ok(snapshot.reservations.every(r => r.status === 'settle'), 'No unknown/open costs may be continued');
  return { sha256: sha(bytes), byteLength: bytes.length, reservationIds: snapshot.reservations.map(r => r.id),
    knownApiEquivalentUsd: snapshot.reservations.reduce((sum, r) => sum + r.actualUsd, 0), chargedAgainstBudgetUsd: snapshot.spentCents / 100 };
}
function verifyAttribution(ledger, experiment, rows) {
  const allowed = new Map(experiment.budgetAtStart.reservations.map(r => [r.id, r.actualUsd]));
  for (const row of rows) for (const r of row.cost?.reservations || []) {
    assert.equal(allowed.has(r.id), false, 'Duplicate row cost attribution');
    assert.equal(r.status, 'settle'); assert.ok(Number.isFinite(r.actualUsd)); allowed.set(r.id, r.actualUsd);
  }
  const actual = ledger.snapshot().reservations;
  assert.equal(actual.length, allowed.size, 'Unattributed paid work requires review; never retry an orphan attempt');
  for (const r of actual) { assert.equal(r.status, 'settle'); assert.equal(allowed.get(r.id), r.actualUsd); }
  const runIds = new Set(rows.map(r => r.runId));
  for (const entry of fs.readdirSync(OUT, { withFileTypes: true })) if (entry.isDirectory()) {
    assert.ok(runIds.has(entry.name), 'Unappended run artifacts require review; never retry an orphan attempt');
  }
}
function verifyResolution(receipt, row) {
  assert.equal(receipt.schema, 1); assert.equal(receipt.kind, 'post-grade-scratch-cleanup-quiescence');
  for (const key of ['sourceCommit', 'experimentSha256', 'freezeSha256', 'originalSummarySha256']) assert.equal(receipt[key], EXPECTED[key]);
  assert.deepEqual(receipt.originalResultsPrefix, EXPECTED.originalResultsPrefix);
  assert.equal(receipt.resultRowSha256, sha(JSON.stringify(row))); assert.equal(receipt.cleanupErrorSha256, sha(row.cleanupError));
  assert.equal(receipt.resultFileSha256, sha(fs.readFileSync(path.join(OUT, row.runId, 'result.json'))));
  assert.equal(receipt.noDeletionOrForceKill, true); assert.equal(receipt.retainedScratch, true);
  assert.ok(receipt.quiescence.knownProcessCount > 0);
  for (const key of ['workerPortClosed', 'nativeShutdownComplete', 'observerRecordsAllSettled']) assert.equal(receipt.quiescence[key], true);
  for (const key of ['remainingKnownPids', 'ownRuntimeProcesses']) assert.deepEqual(receipt.quiescence[key], []);
  assert.equal(receipt.quiescence.pendingNativeResults, 0); assert.equal(receipt.quiescence.telemetryErrors, 0); assert.equal(receipt.quiescence.oauthCredentialCopied, false);
  const resultBytes = fs.readFileSync(resultsFile); checkPrefix(resultBytes, receipt.resultsPrefix);
  const resultPrefix = resultBytes.subarray(0, receipt.resultsPrefix.byteLength);
  assert.equal(resultPrefix.at(-1), 10);
  const prefixRows = resultPrefix.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(prefixRows.length, receipt.resultsPrefix.rowCount); assert.equal(prefixRows.at(-1).runId, row.runId);
  const ledgerBytes = fs.readFileSync(LEDGER); checkPrefix(ledgerBytes, receipt.ledgerPrefix);
  const states = new Map();
  for (const event of ledgerBytes.subarray(0, receipt.ledgerPrefix.byteLength).toString('utf8').trimEnd().split('\n').map(JSON.parse)) {
    assert.ok(['init', 'reserve', 'settle'].includes(event.type), 'Resolution ledger prefix must contain no halt/unknown');
    if (event.id) states.set(event.id, event);
  }
  assert.ok([...states.values()].every(r => r.type === 'settle'));
  assert.deepEqual([...states.keys()], receipt.ledgerPrefix.reservationIds);
  assert.equal([...states.values()].reduce((sum, r) => sum + r.actualUsd, 0), receipt.ledgerPrefix.knownApiEquivalentUsd);
  assert.equal([...states.values()].reduce((sum, r) => sum + r.actualCents, 0) / 100, receipt.ledgerPrefix.chargedAgainstBudgetUsd);
}
async function quiescence(row, ledger, readPassiveAudit, persist) {
  const existing = fs.existsSync(receiptFile) ? jsonl(receiptFile).find(r => r.runId === row.runId) : null;
  const resultRowSha256 = sha(JSON.stringify(row));
  if (existing) {
    cleanupScratch(row); verifyResolution(existing, row); return existing;
  }
  const scratch = cleanupScratch(row);
  const settled = new Map(ledger.snapshot().reservations.map(r => [r.id, r]));
  for (const receipt of row.cost.reservations) {
    assert.equal(settled.get(receipt.id)?.status, 'settle');
    assert.equal(settled.get(receipt.id)?.actualUsd, receipt.actualUsd);
  }
  for (const stage of row.stages) {
    const audit = readPassiveAudit(stage.auditDirectory, { sessionId: stage.sessionId, final: true });
    assert.ok(audit.ok && audit.finalized && !audit.pending?.length, 'Retained native audit is not finalized');
  }
  const native = path.join(scratch, 'home/.claude-mem-benchmark'), logs = path.join(native, 'data/logs');
  const logFiles = fs.readdirSync(logs).filter(name => /^claude-mem-\d{4}-\d{2}-\d{2}\.log$/.test(name)).map(name => path.join(logs, name));
  const logText = () => logFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const workerMatches = [...logText().matchAll(/HTTP server started \{host=127\.0\.0\.1, port=(\d+), pid=(\d+)\}/g)]
    .filter(m => Number(m[1]) === row.configuration.workerPort);
  assert.equal(workerMatches.length, 1, 'Require the registered native worker PID');
  const knownPids = [...new Set([Number(workerMatches[0][2]), ...row.observerAccounting.records.flatMap(r => [r.pid, r.childPid])])];
  assert.ok(knownPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const deadline = Date.now() + 30_000; let live, portClosed = false, nativeShutdownComplete = false;
  do {
    live = liveProcesses(scratch, knownPids); portClosed = await closedPort(row.configuration.workerPort);
    nativeShutdownComplete = /Worker shutdown complete/.test(logText());
    if (!live.length && portClosed && nativeShutdownComplete) break;
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(!live.length && portClosed && nativeShutdownComplete, 'Native shutdown did not become quiescent within 30 seconds');
  for (const file of ['home/.claude/.credentials.json', 'home/.claude-mem-benchmark/observer-profile/.credentials.json', 'home/.claude-mem-benchmark/data/.env']) {
    assert.equal(fs.existsSync(path.join(scratch, file)), false, 'Unexpected plaintext/auth credential copy');
  }
  const bytes = fs.readFileSync(resultsFile), rows = jsonl(resultsFile);
  assert.equal(rows.at(-1).runId, row.runId, 'Receipt must bind the raw prefix ending at this row');
  const receipt = { schema: 1, kind: 'post-grade-scratch-cleanup-quiescence', runId: row.runId,
    sourceCommit: EXPECTED.sourceCommit, experimentSha256: EXPECTED.experimentSha256, resultRowSha256,
    resultFileSha256: sha(fs.readFileSync(path.join(OUT, row.runId, 'result.json'))), cleanupErrorSha256: sha(row.cleanupError),
    observedAt: new Date().toISOString(), originalResultsPrefix: EXPECTED.originalResultsPrefix,
    resultsPrefix: { sha256: sha(bytes), byteLength: bytes.length, rowCount: rows.length },
    originalSummarySha256: EXPECTED.originalSummarySha256, freezeSha256: EXPECTED.freezeSha256,
    quiescence: { workerPortClosed: true, remainingKnownPids: [], knownProcessCount: knownPids.length, knownPids,
      ownRuntimeProcesses: [], nativeShutdownComplete: true, observerRecordsAllSettled: true,
      pendingNativeResults: 0, telemetryErrors: 0, oauthCredentialCopied: false },
    noDeletionOrForceKill: true, retainedScratch: true, scratch, ledgerPrefix: ledgerBinding(ledger) };
  if (persist) fs.appendFileSync(receiptFile, JSON.stringify(receipt) + '\n');
  return receipt;
}

async function main() {
  const args = process.argv.slice(2), paid = args.includes('--paid-approved'), record = paid || args.includes('--record-quiescence');
  if (args.includes('--self-test')) {
    const b = Buffer.from('original\n'); checkPrefix(Buffer.concat([b, Buffer.from('later\n')]), { byteLength: b.length, sha256: sha(b) });
    assert.throws(() => checkPrefix(Buffer.from('changed\n'), { byteLength: b.length, sha256: sha(b) }));
    assert.equal(auditEligible({}), false); assert.throws(() => cleanupScratch({ condition: 'notes-native' }));
    assert.deepEqual(rowIdentity({ block: 'personal-longitudinal-v1', condition: 'claude-mem', repetition: 1 }),
      { block: 'personal-longitudinal', case: null, condition: 'claude-mem', repetition: 1 });
    console.log(JSON.stringify({ selfTest: true, modelCalls: 0 })); return;
  }
  assert.equal(process.platform, 'win32');
  for (const [file, expected] of [[`${OUT}/experiment.json`, EXPECTED.experimentSha256], [FREEZE, EXPECTED.freezeSha256],
    [CONFIG, EXPECTED.configSha256], [`${RETAINED}/experiment.json`, EXPECTED.experimentSha256],
    [`${RETAINED}/results.jsonl`, EXPECTED.originalResultsPrefix.sha256], [`${RETAINED}/run-summary.json`, EXPECTED.originalSummarySha256]]) assert.equal(sha(fs.readFileSync(file)), expected, `Frozen artifact changed: ${file}`);
  assert.equal(git(SOURCE, 'rev-parse', 'HEAD'), EXPECTED.sourceCommit);
  assert.equal(git(SOURCE, 'status', '--porcelain'), '', 'Source must remain clean');
  const experiment = read(`${OUT}/experiment.json`), freeze = read(FREEZE), config = read(CONFIG);
  for (const [file, hashes] of Object.entries(freeze.sourceFiles)) assert.equal(sha(fs.readFileSync(path.join(SOURCE, file))), hashes.rawSha256, `Frozen source changed: ${file}`);
  assert.equal(git(experiment.releasedRoot, 'rev-parse', 'HEAD'), freeze.releasedCommit);
  assert.equal(git(experiment.releasedRoot, 'status', '--porcelain'), '', 'Released source must remain clean');
  assert.equal(sha(fs.readFileSync(config.claudePath)), freeze.cli.sha256);
  assert.ok(samePath(experiment.ledger, LEDGER) && samePath(experiment.improvedRoot, SOURCE));
  assert.equal(experiment.authentication.method, 'api-key');
  const imported = async name => import(pathToFileURL(path.join(SOURCE, 'bench/decision-change', name)).href);
  const [{ runWorkflow, buildPlan }, { runPersonalReplay }, { CASES }, { BudgetLedger }, { readPassiveAudit }, authModule, { reservationUsd }] =
    await Promise.all(['run.mjs', 'personal-run.mjs', 'scenarios.mjs', 'ledger.mjs', 'passive-audit.mjs', 'auth.mjs', 'agent.mjs'].map(imported));
  const plan = buildPlan({ conditions: experiment.conditions, cases: experiment.cases.map(id => CASES.find(s => s.id === id)),
    correctedRepetitions: experiment.correctedRepetitions, seed: experiment.seed, blocks: experiment.blocks });
  assert.deepEqual(plan.map(p => ({ block: p.block, case: p.scenario?.id || null, condition: p.conditionId, repetition: p.repetition })), experiment.plan);
  assert.equal(plan.length, 30); assert.equal(reservationUsd(experiment.limits), experiment.reservePerStage);
  const bytes = fs.readFileSync(resultsFile); checkPrefix(bytes, EXPECTED.originalResultsPrefix);
  assert.ok(bytes.at(-1) === 10, 'Partial raw result line requires review');
  const rows = jsonl(resultsFile); assert.ok(rows.length >= 4 && rows.length <= plan.length);
  assert.equal(new Set(rows.map(r => r.runId)).size, rows.length);
  rows.forEach((row, i) => assert.deepEqual(rowIdentity(row), experiment.plan[i], 'Existing rows must be the exact ordered plan prefix'));
  assert.ok(!rows.some(instrumentationStop), 'An unresolved instrumentation stop cannot be resumed');
  assert.ok(fs.existsSync(LEDGER), 'Never initialize a substitute ledger');
  const ledger = new BudgetLedger(LEDGER, { limitUsd: 50 }); ledgerBinding(ledger);
  verifyAttribution(ledger, experiment, rows);
  const manifest = { schema: 1, kind: 'same-source-matrix-continuation', sourceCommit: EXPECTED.sourceCommit,
    experimentSha256: EXPECTED.experimentSha256, freezeSha256: EXPECTED.freezeSha256,
    originalResultsPrefix: EXPECTED.originalResultsPrefix, originalSummarySha256: EXPECTED.originalSummarySha256,
    originalLedgerPrefix: EXPECTED.originalLedgerPrefix, planSha256: sha(JSON.stringify(experiment.plan)),
    remainingPlan: experiment.plan.slice(4), originalRows: rows.slice(0, 4).map(r => r.runId), runnerSha256: sha(fs.readFileSync(ownFile)),
    policy: 'append only; no reruns; only post-grade EPERM cleanup quiescence may resolve' };
  if (fs.existsSync(manifestFile)) { const old = read(manifestFile); delete old.startedAt; assert.deepEqual(old, manifest); }
  else if (record) fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, startedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  for (const row of rows) if (row.cleanupError) await quiescence(row, ledger, readPassiveAudit, record);
  const budget = ledgerBinding(ledger);
  console.log(JSON.stringify({ ready: true, paid, completed: rows.length, remaining: plan.length - rows.length, next: experiment.plan[rows.length],
    settledReservations: budget.reservationIds.length, knownApiEquivalentUsd: budget.knownApiEquivalentUsd, chargedAgainstBudgetUsd: budget.chargedAgainstBudgetUsd }));
  if (!paid) return;
  const pipeIndex = args.indexOf('--api-key-pipe'); assert.ok(pipeIndex >= 0 && args[pipeIndex + 1], 'Explicit secure API pipe required');
  const lockFile = `${OUT}/continuation.lock`, lock = fs.openSync(lockFile, 'wx');
  let authentication, stopReason = null;
  const previousPath = process.env.PATH;
  try {
    authentication = await authModule.loadBenchmarkAuthentication({ method: 'api-key', apiKeyPipe: args[pipeIndex + 1] });
    authentication.assertPublic({ config, experiment });
    process.env.PATH = `${path.dirname(config.claudePath)}${path.delimiter}${previousPath || ''}`;
    for (let i = rows.length; i < plan.length; i++) {
      ledgerBinding(ledger); verifyAttribution(ledger, experiment, rows); checkPrefix(fs.readFileSync(resultsFile), EXPECTED.originalResultsPrefix);
      const entry = plan[i];
      if (ledger.remaining() < experiment.reservePerStage * (entry.block === 'early-change' ? 2 : 1)) { stopReason = 'Insufficient aggregate reserve for next workflow'; break; }
      const runId = `${entry.scenario?.id || entry.block}-${entry.conditionId}-r${entry.repetition}-${crypto.randomUUID().slice(0, 8)}`;
      const common = { conditionId: entry.conditionId, scenario: entry.scenario, runId, outDir: OUT, ledger, limits: experiment.limits,
        approved: true, releasedRoot: experiment.releasedRoot, improvedRoot: SOURCE, claudeMem: config, protocol: experiment.protocol, authentication };
      const row = entry.block === 'early-change' ? await runWorkflow(common) : await runPersonalReplay(common);
      row.repetition = entry.repetition;
      fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n'); rows.push(row);
      console.log(`${row.condition} / ${row.scenario || row.block}: ${row.notMeasured ? 'NOT MEASURED' : row.success ? 'PASS' : 'FAIL'}; completed ${rows.length}/30`);
      if (instrumentationStop(row)) { stopReason = 'Instrumentation review required'; break; }
      if (ledger.snapshot().halted) { stopReason = 'Budget accounting requires review'; break; }
      if (row.cleanupError) {
        try { await quiescence(row, ledger, readPassiveAudit, true); }
        catch { stopReason = 'Isolated profile cleanup requires review'; break; }
      }
      fs.writeFileSync(`${OUT}/run-summary.json`, JSON.stringify({ attempted: rows.length, planned: plan.length, stopReason: null,
        notStarted: experiment.plan.slice(rows.length).map(p => ({ ...p, outcomeCategory: 'not-started', reason: 'Continuation in progress' })), budget: ledger.snapshot(), continuation: 'continuation.json' }, null, 2));
    }
  } catch (error) { stopReason ||= 'Continuation execution error requires review'; throw error; }
  finally {
    authentication?.dispose(); process.env.PATH = previousPath;
    fs.writeFileSync(`${OUT}/run-summary.json`, JSON.stringify({ attempted: rows.length, planned: plan.length, stopReason,
      notStarted: experiment.plan.slice(rows.length).map(p => ({ ...p, outcomeCategory: 'not-started', reason: stopReason || 'Continuation interrupted' })), budget: ledger.snapshot(), continuation: 'continuation.json' }, null, 2));
    fs.closeSync(lock); fs.unlinkSync(lockFile);
  }
  console.log(JSON.stringify({ completed: rows.length, planned: plan.length, stopReason }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
