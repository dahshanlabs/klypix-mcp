// Standalone setup diagnostic. It is not a benchmark cell or a product score.
// No paid call is possible without --paid-approved and a reviewed source/protocol.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SOURCE = path.resolve(option('--source-root') || 'E:/klypix-build/klypix-mcp-1.111.0-gate');
const CONFIG = path.resolve(option('--config') || 'E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5/adapter-config.json');
const LEDGER = path.resolve(option('--ledger') || 'E:/tmp/klypix-decision-pilot-20261108/budget.jsonl');
const VERSION = 'native-observer-api-setup-probe-v2';
const FACTS = { label: 'amber-orchid', delaySeconds: 47 };
const producerPrompt = `Implement the accepted Beacon kiosk decision: its maintenance status label is "amber-orchid", and its status polling interval is 47 seconds. Create src/status-display.mjs exporting maintenanceLabel and pollIntervalMs, then verify both values using node. Explain the decision briefly when done. Work only inside this repository. Do not write project instruction files, ordinary memory notes or manual save_memory records; this setup diagnostic verifies the installed native automatic capture of ordinary tool work. Do not commit.`;
const consumerPrompt = `This is a fresh session in the Beacon kiosk project. Using the installed claude-mem integration, retrieve the earlier decision about its maintenance status label and status polling interval. Search and then open the relevant observation with get_observations; use the normal native integration and cite the observation ID. Do not inspect implementation files, Git history, saved conversations or ordinary notes. Do not write or manually save any memory. Answer only JSON: {"maintenanceLabel":string|null,"pollIntervalSeconds":number|null,"observationIds":[number],"source":string}. If the decision is unavailable, use null values and an empty observationIds list.`;
const exec = promisify(execFile);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const resolveSame = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const factParts = text => ({ label: /amber[ -]orchid/i.test(String(text)), delay: /(?:\b47000\b|\b47,000\b|\b47\s*(?:s\b|sec|second))/i.test(String(text)) });
const factMatch = text => Object.values(factParts(text)).every(Boolean);
const citedIds = text => [...new Set([...String(text).matchAll(/(?:#|\b(?:observation(?:\s+ID)?|id)\s*[#:=" ]+)(\d+)\b/gi)].map(match => Number(match[1])))];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function option(name) {
  const hits = process.argv.slice(2).filter(arg => arg === name || arg.startsWith(`${name}=`));
  if (hits.length > 1) throw new Error(`Duplicate ${name}`);
  if (!hits.length) return null;
  const arg = hits[0];
  const value = arg.includes('=') ? arg.slice(name.length + 1) : process.argv[process.argv.indexOf(name) + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
function safeStage(stage) {
  return { role: stage.role, sessionId: stage.sessionId, ok: stage.ok, exitCode: stage.exitCode,
    nativeAuditFinalized: stage.nativeAuditFinalized, pendingResults: stage.pendingNativeResults?.length ?? null,
    telemetryErrorCount: stage.telemetryErrors?.length ?? null, budgetLimited: stage.budgetLimited,
    timedOut: stage.timedOut, costUsd: stage.costUsd, model: stage.model, authentication: stage.authentication,
    stdoutSha256: fs.existsSync(stage.stdoutFile) ? sha(stage.stdoutFile) : null };
}
function stageValid(stage) {
  return stage.ok === true && stage.nativeAuditFinalized === true && stage.pendingNativeResults?.length === 0
    && stage.telemetryErrors?.length === 0 && !stage.budgetLimited && !stage.unpricedModel;
}
function parseAnswer(text) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(stripped); } catch { return null; }
}
function selectedObservationSections(text) {
  // Pinned native MCP rP/oP format: one anchored '#ID â€” title' section per
  // returned record. Omitted IDs and index/timeline entries do not qualify.
  const body = String(text);
  if (!body.startsWith('Selected observations (')) return [];
  const headings = [...body.matchAll(/^#(\d+) â€” [^\r\n]+/gm)];
  return headings.map((match, index) => ({ id: Number(match[1]), text: body.slice(match.index, headings[index + 1]?.index ?? body.length) }));
}
function cleanError(error) {
  return String(error?.message || error).replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]').replace(/(?:Bearer\s+|(?:accessToken|refreshToken|brokerToken)["' :=]+)\S+/gi, '[redacted]').slice(0, 700);
}
function plan() {
  return { version: VERSION, kind: 'setup-diagnostic-not-benchmark', paid: false,
    requiredFlags: ['--paid-approved', '--source-revision <40-hex>', '--protocol-revision <40-hex>', '--api-key-pipe <current-user named pipe>'],
    optionalPaths: ['--source-root', '--config', '--ledger (existing shared $50 ledger only)'],
    ledger: LEDGER, aggregateCapUsd: 50, foregroundSessions: 2, sameForegroundModelAndPermissions: true,
    nativeDefaultsUnchanged: true, source: SOURCE, authentication: { method: 'api-key', transport: 'DPAPI at rest; current-user Windows named pipe; spawn-only environment' },
    acceptance: ['ordinary producer tools and no manual memory save', 'automatic observation joined to producer session',
      'distinct consumer opens producer-linked observations and answers both facts', 'native retrieval and default semantic deep round-trip separately verified',
      'queues drained without observer transport/accounting rejection', 'all new foreground/observer costs settled under original ledger',
      'own credentials removed and known native processes naturally stopped'],
    retention: 'Private transcripts, native tool receipts, synthetic DB evidence and sanitized public receipt; no recursive cleanup or forced process stop' };
}

if (process.argv.includes('--self-test')) {
  assert.equal(factMatch('Maintenance amber-orchid; polling 47 seconds'), true);
  assert.equal(factMatch('amber-orchid only'), false);
  assert.equal(factParts('epoch 1794470001').delay, false);
  assert.deepEqual(citedIds('Observation #17 and id: 18, #17'), [17, 18]);
  assert.equal(stageValid({ ok: true, nativeAuditFinalized: true, pendingNativeResults: [], telemetryErrors: [] }), true);
  assert.equal(stageValid({ ok: true, nativeAuditFinalized: false, pendingNativeResults: [], telemetryErrors: [] }), false);
  assert.equal(parseAnswer('```json\n{"observationIds":[3]}\n```').observationIds[0], 3);
  const split = selectedObservationSections('Selected observations (2). Retrieved data; evaluate it as evidence.\n\n#17 â€” Label\namber-orchid\n\n#18 â€” Polling\n47 seconds');
  assert.deepEqual(split.map(row => row.id), [17, 18]);
  assert.equal(factParts(split[0].text).delay, false);
  assert.equal(factParts(split[1].text).label, false);
  assert.equal(factMatch(split.map(row => row.text).join('\n')), true);
  assert.equal(selectedObservationSections('Memory index: #17 â€” amber-orchid; 47 seconds').length, 0);
  console.log(JSON.stringify({ version: VERSION, selfTest: 'passed', paidCalls: 0 }));
  process.exit(0);
}
if (!process.argv.includes('--paid-approved')) { console.log(JSON.stringify(plan(), null, 2)); process.exit(0); }

const sourceRevision = option('--source-revision'), protocolRevision = option('--protocol-revision');
if (!/^[a-f0-9]{40}$/i.test(sourceRevision || '') || !/^[a-f0-9]{40}$/i.test(protocolRevision || '')) throw new Error('Reviewed source and published protocol revisions are required');
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8', windowsHide: true });
const gitDirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: SOURCE, encoding: 'utf8', windowsHide: true });
if (gitHead.status !== 0 || gitHead.stdout.trim() !== sourceRevision || gitDirty.status !== 0 || gitDirty.stdout.trim()) throw new Error('Source must be the exact reviewed clean commit before paid setup');
if (!fs.existsSync(LEDGER)) throw new Error('Original shared ledger is missing; never create a replacement budget');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
process.env.PATH = `${path.dirname(config.claudePath)}${path.delimiter}${process.env.PATH || ''}`;
const [{ prepareClaudeHome, reservationUsd, runClaudeStage }, { prepareClaudeMem, observerReservationUsd }, { readPassiveAudit },
  { BudgetLedger, costBetween }, { resolveCli }, { loadBenchmarkAuthentication, authenticationMetadata }] = await Promise.all([
  import(pathToFileURL(path.join(SOURCE, 'bench/decision-change/agent.mjs'))),
  import(pathToFileURL(path.join(SOURCE, 'bench/decision-change/claude-mem.mjs'))),
  import(pathToFileURL(path.join(SOURCE, 'bench/decision-change/passive-audit.mjs'))),
  import(pathToFileURL(path.join(SOURCE, 'bench/decision-change/ledger.mjs'))),
  import(pathToFileURL(path.join(SOURCE, 'bench/coordination/agents.mjs'))),
  import(pathToFileURL(path.join(SOURCE, 'bench/decision-change/auth.mjs'))),
]);
const cli = resolveCli('claude');
if (!cli || cli.prefix?.length || !resolveSame(cli.command, config.claudePath)) throw new Error('Foreground CLI does not resolve to the pinned observer executable');
const limitsFile = path.join(SOURCE, 'bench/decision-change/pilot-limits.json');
const limits = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
if (config.processCapUsd !== limits.stageBudgetUsd || config.observerBudgetUsd !== 2 * observerReservationUsd(config.processCapUsd, 'sonnet')) throw new Error('Observer accounting envelopes must match the registered setup');
const ledger = new BudgetLedger(LEDGER, { limitUsd: 50 });
const budgetBefore = ledger.snapshot();
if (budgetBefore.halted || budgetBefore.reservedCents || ledger.remaining() < 2 * reservationUsd(limits) + config.observerBudgetUsd) throw new Error('Shared ledger is not idle or cannot reserve the setup workflow');
if (path.parse(os.tmpdir()).root.toLowerCase() !== 'c:\\') throw new Error('This diagnostic requires fresh C-drive scratch');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decision-change-observer-probe-'));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'cmem-observer-setup-proof-'));
const home = path.join(scratch, 'home'), repoDir = path.join(scratch, 'repo');
const runId = `native-observer-api-setup-${crypto.randomUUID()}`;
const producerSession = crypto.randomUUID(), consumerSession = crypto.randomUUID();
const receipt = { version: VERSION, kind: 'setup-diagnostic-not-benchmark', sourceRevision, protocolRevision,
  startedAt: new Date().toISOString(), runId, success: false, scriptSha256: sha(fileURLToPath(import.meta.url)),
  limitsSha256: sha(limitsFile), adapterConfigSha256: sha(CONFIG), nativeCliSha256: sha(config.claudePath),
  ledgerBaselineSha256: sha(LEDGER), ledgerBaselineBytes: fs.statSync(LEDGER).size,
  priorActualUsd: budgetBefore.reservations.reduce((sum, row) => sum + (row.actualUsd || 0), 0),
  priorChargedUsd: budgetBefore.spentCents / 100, stages: [], gates: {}, cleanup: {},
  promptsSha256: crypto.createHash('sha256').update(JSON.stringify({ producerPrompt, consumerPrompt })).digest('hex') };
write(path.join(artifacts, 'setup-plan.json'), { ...plan(), paid: true, sourceRevision, protocolRevision, producerPrompt, consumerPrompt, producerSession, consumerSession });
let adapter, authentication, initialEnv, beforeConsumer, knownPids = new Set(), workerPort;
const dbPath = path.join(home, '.claude-mem-benchmark/data/claude-mem.db');
async function observations(session) {
  // Read-only DB inspection is evaluator evidence. Never supplied to either agent.
  const code = `import { Database } from 'bun:sqlite';const db=new Database(process.argv[1],{readonly:true});const wanted=['id','memory_session_id','project','text','title','subtitle','narrative','facts','type','generated_by_model','prompt_number','files_read','files_modified','created_at_epoch'];const cols=new Set(db.query('PRAGMA table_info(observations)').all().map(x=>x.name));const select=wanted.filter(x=>cols.has(x)).map(x=>'o.'+x).join(',');const rows=db.query('SELECT '+select+',s.content_session_id AS producer_session FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE s.content_session_id=? ORDER BY o.id').all(process.argv[2]);db.close();console.log(JSON.stringify(rows));`;
  const result = await exec(config.bunPath, ['-e', code, dbPath, session], { env: initialEnv, windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}
async function endpoint(route) {
  const response = await fetch(`http://127.0.0.1:${workerPort}${route}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Native ${route.split('?')[0]} returned HTTP ${response.status}`);
  return response.json();
}
function collectPids(doctor) {
  const pidFile = path.join(home, '.claude-mem-benchmark/data/worker.pid');
  if (fs.existsSync(pidFile)) {
    try { const raw = fs.readFileSync(pidFile, 'utf8'), parsed = JSON.parse(raw); const pid = typeof parsed === 'number' ? parsed : parsed.pid; if (Number.isSafeInteger(pid) && pid > 0) knownPids.add(pid); } catch { /* absence remains visible below */ }
  }
  for (const item of doctor?.processes || []) if (Number.isSafeInteger(item.pid) && item.pid > 0) knownPids.add(item.pid);
  for (const item of adapter?.accounting?.().records || []) for (const key of ['pid', 'childPid']) if (Number.isSafeInteger(item[key]) && item[key] > 0) knownPids.add(item[key]);
}
function failUnless(condition, message) { if (!condition) throw new Error(message); }
try {
  authentication = await loadBenchmarkAuthentication({ method: 'api-key', apiKeyPipe: option('--api-key-pipe') });
  authentication.assertPublic(config);
  receipt.authentication = authenticationMetadata(authentication);
  initialEnv = prepareClaudeHome(home, { authentication });
  fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"type":"module","private":true}\n');
  fs.writeFileSync(path.join(repoDir, 'lib/invoice.mjs'), 'export const setupProbeOnly = true;\n'); // passive observer source, no benchmark policy
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Isolated setup fixture\nUse the configured native integration. Keep work inside this repository.\n');
  fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), '# Isolated setup fixture\n');
  const init = spawnSync('git', ['-c', `core.hooksPath=${path.join(repoDir, '.no-hooks')}`, 'init', '-q', '-b', 'main'], { cwd: repoDir, env: initialEnv, windowsHide: true, encoding: 'utf8' });
  failUnless(init.status === 0, 'Fresh repository initialization failed');
  adapter = await prepareClaudeMem({ repoDir, home, ledger, packageDir: config.packageDir, bunPath: config.bunPath,
    claudePath: config.claudePath, authentication, dependencyHome: config.dependencyHome,
    observerBudgetUsd: config.observerBudgetUsd, processCapUsd: config.processCapUsd });
  failUnless(adapter.metadata?.paidReady === true, adapter.metadata?.reason || 'Adapter preparation failed');
  workerPort = adapter.metadata.workerPort;
  await adapter.start({ allowPaid: true });
  receipt.configuration = { version: adapter.version, authentication: adapter.metadata.authentication, oauthCredentialCopied: adapter.metadata.oauthCredentialCopied, observerAliases: adapter.metadata.observerAliases, observerProcessCapUsd: adapter.metadata.observerProcessCapUsd,
    observerBudgetUsd: adapter.metadata.observerBudgetUsd, sourceHashes: adapter.metadata.sourceHashes, semanticReadiness: adapter.metadata.semanticReadiness?.ok === true };
  collectPids(await endpoint('/api/admin/doctor'));
  const stage = async (role, sessionId, prompt) => {
    const result = await runClaudeStage({ approved: true, authentication, id: `${runId}-${role}`, role, repoDir, home, sessionId, prompt,
      config: { ...adapter.agentConfig, env: { ...initialEnv, ...adapter.agentConfig.env } }, ledger, limits, transcriptDir: artifacts, timeoutMs: 180_000 });
    receipt.stages.push(safeStage({ role, ...result }));
    write(path.join(artifacts, `${role}.private-stage.json`), result);
    failUnless(result.authentication?.method === 'api-key', `${role} did not use API billing`);
    failUnless(stageValid(result), `${role} did not finish with valid native audit and accounting`);
    const audit = readPassiveAudit(result.auditDirectory, { sessionId, final: true });
    failUnless(audit.ok && audit.finalized && audit.pending.length === 0, `${role} final native audit is incomplete`);
    return { result, audit };
  };
  const producer = await stage('setup-producer', producerSession, producerPrompt);
  receipt.gates.noManualSave = !producer.audit.responses.some(row => /save_memory/i.test(row.tool));
  receipt.gates.ordinaryProducerToolWork = producer.audit.responses.some(row => !row.isError && /^(Write|Edit|Bash)$/i.test(row.tool));
  failUnless(receipt.gates.noManualSave && receipt.gates.ordinaryProducerToolWork, 'Producer used manual saving or performed no ordinary tool work');
  const producerFlush = await adapter.flush({ deadlineMs: 120_000 });
  receipt.gates.producerQueueDrained = producerFlush.ok === true;
  failUnless(receipt.gates.producerQueueDrained, 'Native automatic producer capture did not drain');
  const generated = await observations(producerSession);
  write(path.join(artifacts, 'producer-observations.private.json'), generated);
  const matching = generated.filter(row => Object.values(factParts(JSON.stringify(row))).some(Boolean));
  receipt.automaticObservations = matching.map(row => ({ id: row.id, producerSession: row.producer_session, type: row.type, generatedByModel: row.generated_by_model || null,
    facts: factParts(JSON.stringify(row)), contentSha256: crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex') }));
  receipt.gates.automaticObservation = matching.length > 0 && factMatch(JSON.stringify(matching)) && adapter.accounting().records.length > 0;
  failUnless(receipt.gates.automaticObservation, 'Automatic observations tied to the producer session do not jointly support both facts');
  beforeConsumer = await endpoint('/api/admin/doctor'); collectPids(beforeConsumer);
  const nativeSearch = await endpoint('/api/search?query=Beacon%20kiosk%20maintenance%20status%20polling&project=repo&limit=5');
  const deep = await endpoint('/api/chroma/status?deep=1');
  const searchText = JSON.stringify(nativeSearch);
  const ids = new Set(matching.map(row => Number(row.id)));
  receipt.gates.nativeSearchFindsObservation = citedIds(searchText).some(id => ids.has(id));
  receipt.gates.defaultSemanticRoundTrip = deep.status === 'healthy' && deep.connected === true && deep.probe?.ok === true
    && beforeConsumer.health?.dependencies?.degraded === false;
  receipt.semantic = { status: deep.status, connected: deep.connected, probeOk: deep.probe?.ok,
    hitProvenance: 'The default native search route does not expose whether this hit was semantic or lexical; no vector-hit claim is made.',
    matchingObservationIds: citedIds(searchText).filter(id => ids.has(id)), resultSha256: crypto.createHash('sha256').update(searchText).digest('hex') };
  write(path.join(artifacts, 'native-search.private.json'), nativeSearch);
  failUnless(receipt.gates.nativeSearchFindsObservation && receipt.gates.defaultSemanticRoundTrip, 'Native observation retrieval or default semantic deep round-trip failed');
  const consumer = await stage('setup-consumer', consumerSession, consumerPrompt);
  const served = consumer.audit.responses.filter(row => !row.isError && /^mcp__.*__get_observations$/i.test(row.tool));
  const generatedById = new Map(matching.map(row => [Number(row.id), row]));
  const linked = served.flatMap(response => selectedObservationSections(response.text).flatMap(section => {
    const original = generatedById.get(section.id);
    if (!original || !Array.isArray(response.input?.ids) || !response.input.ids.some(id => Number(id) === section.id)) return [];
    const originalFacts = factParts(JSON.stringify(original)), servedFacts = factParts(section.text);
    const facts = { label: originalFacts.label && servedFacts.label, delay: originalFacts.delay && servedFacts.delay };
    return Object.values(facts).some(Boolean) ? [{ ...section, facts, tool: response.tool, toolUseId: response.toolUseId }] : [];
  }));
  const answer = parseAnswer(consumer.result.finalMessage);
  const shippedSkillRoot = path.resolve(home, '.claude-mem-benchmark/skill-plugin/skills');
  receipt.gates.consumerMemoryOnly = !consumer.audit.responses.some(row => {
    if (/save_memory/i.test(row.tool) || /^(Bash|Glob|Grep|Write|Edit|MultiEdit)$/i.test(row.tool)) return true;
    if (!/^Read$/i.test(row.tool)) return false;
    // Reading the shipped mem-search skill is normal integration use. It does
    // not contain the synthetic decision and cannot establish recall itself.
    const file = row.input?.file_path || row.input?.path;
    if (typeof file !== 'string') return true;
    const relative = path.relative(shippedSkillRoot, path.resolve(file));
    return !relative || relative.startsWith('..') || path.isAbsolute(relative);
  });
  receipt.gates.consumerRetrievedSameObservation = linked.some(row => row.facts.label) && linked.some(row => row.facts.delay);
  const answerIds = new Set(Array.isArray(answer?.observationIds) ? answer.observationIds.map(Number) : []);
  receipt.gates.consumerAnswer = answer?.maintenanceLabel === FACTS.label && answer?.pollIntervalSeconds === FACTS.delaySeconds
    && linked.some(row => row.facts.label && answerIds.has(row.id)) && linked.some(row => row.facts.delay && answerIds.has(row.id));
  receipt.retrieval = linked.map(row => ({ tool: row.tool, toolUseId: row.toolUseId, observationId: row.id, facts: row.facts, textSha256: crypto.createHash('sha256').update(row.text).digest('hex') }));
  receipt.answer = answer ? { maintenanceLabel: typeof answer.maintenanceLabel === 'string' ? answer.maintenanceLabel.slice(0, 100) : null,
    pollIntervalSeconds: Number.isFinite(answer.pollIntervalSeconds) ? answer.pollIntervalSeconds : null,
    observationIds: Array.isArray(answer.observationIds) ? answer.observationIds.map(Number).filter(Number.isSafeInteger).slice(0, 20) : [] } : null;
  failUnless(receipt.gates.consumerMemoryOnly && receipt.gates.consumerRetrievedSameObservation && receipt.gates.consumerAnswer, 'Fresh consumer did not verify the same automatic observation through normal memory retrieval');
  const consumerFlush = await adapter.flush({ deadlineMs: 120_000 });
  receipt.gates.consumerQueueDrained = consumerFlush.ok === true;
  failUnless(receipt.gates.consumerQueueDrained, 'Consumer native capture did not drain');
  const finalDoctor = await endpoint('/api/admin/doctor'); collectPids(finalDoctor);
  receipt.gates.dependenciesHealthy = finalDoctor.health?.dependencies?.degraded === false;
  failUnless(receipt.gates.dependenciesHealthy, 'Native dependency degraded during the probe');
} catch (error) { receipt.error = cleanError(error); }
finally {
  collectPids();
  if (adapter) try { await adapter.close(); receipt.cleanup.nativeCloseReturned = true; } catch (error) { receipt.cleanup.nativeCloseError = cleanError(error); }
  // Remove only credentials copied by this fresh probe; preserve all other evidence.
  for (const file of [path.join(home, '.claude/.credentials.json'), path.join(home, '.claude-mem-benchmark/observer-profile/.credentials.json')]) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (error) { (receipt.cleanup.credentialRemovalErrors ||= []).push(cleanError(error)); }
  }
  receipt.cleanup.credentialsRemoved = !fs.existsSync(path.join(home, '.claude/.credentials.json')) && !fs.existsSync(path.join(home, '.claude-mem-benchmark/observer-profile/.credentials.json'));
  const until = Date.now() + 15_000;
  while (Date.now() < until && [...knownPids].some(alive)) await pause(250);
  receipt.cleanup.knownProcessCount = knownPids.size;
  receipt.cleanup.remainingKnownPids = [...knownPids].filter(alive);
  receipt.cleanup.processCoverage = 'Native worker PID file, doctor process list and observer broker; no forced stop or OS-wide process sweep';
  try { await fetch(`http://127.0.0.1:${workerPort}/api/health`, { signal: AbortSignal.timeout(2000) }); receipt.cleanup.workerPortClosed = false; }
  catch (error) {
    // A timeout is not evidence that the worker has exited.
    const codes = [error.cause?.code, ...(error.cause?.errors || []).map(item => item.code)].filter(Boolean);
    receipt.cleanup.workerPortClosed = codes.length > 0 && codes.every(code => code === 'ECONNREFUSED');
    receipt.cleanup.workerPortCheck = codes.length ? [...new Set(codes)] : [error.name || 'unknown'];
  }
  const observer = adapter?.accounting?.();
  receipt.observerAccounting = observer ? { spentUsd: observer.spentUsd, reservedUsd: observer.reservedUsd,
    records: observer.records.map(row => ({ id: row.id, model: row.model, authMethod: row.authMethod, status: row.status, cost: row.cost, capped: row.capped, inFlight: row.inFlight })),
    refusalCount: observer.refusals.length } : null;
  const after = ledger.snapshot(), fresh = after.reservations.filter(row => !budgetBefore.reservations.some(prior => prior.id === row.id));
  receipt.cost = costBetween(budgetBefore, after);
  receipt.totalActualUsd = after.reservations.reduce((sum, row) => sum + (row.actualUsd || 0), 0);
  receipt.totalChargedUsd = after.spentCents / 100;
  receipt.gates.accountingComplete = !after.halted && after.reservedCents === 0 && fresh.length >= 3 && fresh.every(row => row.status === 'settle')
    && observer?.records.length > 0 && observer.records.every(row => row.status === 'settled' && !row.capped && !row.inFlight && ['claude-haiku-5-5', 'claude-sonnet-5-5'].includes(row.model)) && observer.refusals.length === 0;
  const logsDir = path.join(home, '.claude-mem-benchmark/data/logs');
  const logTexts = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter(name => name.endsWith('.log')).map(name => fs.readFileSync(path.join(logsDir, name), 'utf8')).join('\n') : '';
  receipt.observerDiagnosticCounts = Object.fromEntries(['Observer launch refused:', 'Observer accounting stopped:', 'Observer final cost unavailable', 'Generator paused for transport', 'SDK stream ended without a result'].map(text => [text, logTexts.split(text).length - 1]));
  receipt.gates.noObserverTransportErrors = Object.values(receipt.observerDiagnosticCounts).every(value => value === 0);
  receipt.gates.ownCleanup = receipt.cleanup.credentialsRemoved && receipt.cleanup.workerPortClosed && receipt.cleanup.nativeCloseReturned === true && knownPids.size > 0 && receipt.cleanup.remainingKnownPids.length === 0;
  receipt.success = !receipt.error && receipt.stages.length === 2 && Object.values(receipt.gates).every(value => value === true);
  receipt.finishedAt = new Date().toISOString();
  receipt.privateArtifactsRetained = true;
  receipt.sanitization = 'Allowlisted metadata, synthetic answers, hashes and cost only. Fixed prompts are published in this script; raw streams, DB rows and local runtime configuration remain private.';
  receipt.gates.apiAuthentication = receipt.authentication?.method === 'api-key' && receipt.configuration?.authentication?.method === 'api-key' && receipt.configuration?.oauthCredentialCopied === false && observer?.records.length > 0 && observer.records.every(row => row.authMethod === 'api-key') && receipt.stages.length === 2 && receipt.stages.every(stage => stage.authentication?.method === 'api-key');
  receipt.success = receipt.success && receipt.gates.apiAuthentication;
  authentication?.assertPublic(receipt);
  write(path.join(artifacts, 'public-receipt.json'), receipt);
  write(path.join(artifacts, 'private-location.json'), { scratch, home, repoDir, artifacts });
  console.log(JSON.stringify({ version: VERSION, success: receipt.success, receipt: path.join(artifacts, 'public-receipt.json'), cost: receipt.cost.apiEquivalentUsd, totalActualUsd: receipt.totalActualUsd, error: receipt.error || null }));
  authentication?.dispose();
  if (!receipt.success) process.exitCode = 1;
}
