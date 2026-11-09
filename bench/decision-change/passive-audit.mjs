// Passive host telemetry, identical for every condition. No fixture answer,
// evaluator, stdout, or context injection runs in the hook process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { redactProcessCredential } from './auth.mjs';

export const MEASUREMENT_TRANSPORT = 'native-audit-v3';
const EVENTS = ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch'];
const textOf = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.filter(item => item?.type === 'text').map(item => item.text || '').join('\n') : '';
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export function preparePassiveAudit({ home, repoDir, sessionId, settings = {} }) {
  if (!sessionId || !path.isAbsolute(home) || !path.isAbsolute(repoDir)) throw new Error('Passive audit requires explicit isolated paths and session');
  const dir = path.join(home, 'passive-tool-audit', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  const config = { version: 1, dir, repoDir: fs.realpathSync(repoDir), sessionId };
  fs.writeFileSync(configFile, JSON.stringify(config), { flag: 'wx' });
  const hooks = { ...(settings.hooks || {}) };
  for (const event of EVENTS) hooks[event] = [...(hooks[event] || []), {
    ...(event === 'PostToolBatch' ? {} : { matcher: '*' }),
    hooks: [{ type: 'command', command: process.execPath, args: [fileURLToPath(import.meta.url), configFile], timeout: 15 }],
  }];
  return { dir, configFile, sessionId, settings: { ...settings, hooks },
    read: options => readPassiveAudit(dir, { sessionId, ...options }),
    reconcileAfterClose: stdout => reconcilePassiveAudit(dir, { sessionId, stdout }) };
}

const contentHash = content => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');

// Called only after the CLI closes and stdout has drained. This stream is
// never a source of causal exposure: it can only prove that an otherwise
// unmatched native batch result represents a command that did not execute.
export function reconcilePassiveAudit(dir, { sessionId, stdout }) {
  const audit = readPassiveAudit(dir, { sessionId, useReconciliation: false });
  if (!audit.ok) throw new Error('Cannot reconcile structurally invalid native audit');
  const events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const proofs = [];
  for (const call of audit.pending) {
    const uses = [], results = [];
    for (const event of events) {
      if (!Array.isArray(event.message?.content)) continue;
      for (const block of event.message.content) {
        if (event.type === 'assistant' && block.type === 'tool_use' && block.id === call.toolUseId) uses.push({ event, block });
        if (event.type === 'user' && block.type === 'tool_result' && block.tool_use_id === call.toolUseId) results.push({ event, block });
      }
    }
    if (uses.length !== 1 || results.length !== 1) continue;
    const use = uses[0], result = results[0];
    if (use.event.session_id !== sessionId || result.event.session_id !== sessionId
      || use.event.parent_tool_use_id !== null || result.event.parent_tool_use_id !== null
      || use.block.name !== call.tool || !isDeepStrictEqual(use.block.input, call.input)
      || result.block.is_error !== true || !isDeepStrictEqual(result.block.content, call.content)) continue;
    const metadata = (result.event.tool_result_meta || []).filter(item => item.id === call.toolUseId);
    if (metadata.length !== 1 || metadata[0].non_execution_kind !== 'user-rejected'
      || metadata[0].permission_decision?.decision !== 'reject' || metadata[0].permission_decision?.source !== 'config') continue;
    proofs.push({ source: 'closed-native-cli-stream', sessionId, toolUseId: call.toolUseId,
      tool: call.tool, input: call.input, resultUuid: result.event.uuid, assistantUuid: use.event.uuid,
      isError: true, kind: metadata[0].non_execution_kind,
      permissionDecision: { decision: 'reject', source: 'config' }, contentSha256: contentHash(call.content) });
  }
  const receipt = { version: 1, measurementTransport: MEASUREMENT_TRANSPORT, sessionId,
    source: 'closed-native-cli-stream', stdoutSha256: crypto.createHash('sha256').update(stdout).digest('hex'),
    checkedToolUseIds: audit.pending.map(call => call.toolUseId), proofs,
    unresolvedToolUseIds: audit.pending.filter(call => !proofs.some(proof => proof.toolUseId === call.toolUseId)).map(call => call.toolUseId) };
  const temporary = path.join(dir, 'reconciliation.tmp'), target = path.join(dir, 'reconciliation.json');
  fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  if (fs.existsSync(target)) throw new Error('Native audit was already reconciled');
  fs.renameSync(temporary, target);
  return receipt;
}

function isVerifiedNativeDenial(proof, call, record) {
  return proof?.source === 'closed-native-cli-stream' && proof.sessionId === record.sessionId
    && proof.toolUseId === call.toolUseId && proof.tool === call.tool && isDeepStrictEqual(proof.input, call.input)
    && typeof proof.resultUuid === 'string' && proof.resultUuid.length > 0
    && typeof proof.assistantUuid === 'string' && proof.assistantUuid.length > 0
    && proof.isError === true && proof.kind === 'user-rejected'
    && proof.permissionDecision?.decision === 'reject' && proof.permissionDecision?.source === 'config'
    && proof.contentSha256 === contentHash(call.content);
}

export function recordPassiveAudit(config, event) {
  const startedAt = Date.now();
  if (event.session_id !== config.sessionId) throw new Error('Passive audit session mismatch');
  if (!EVENTS.includes(event.hook_event_name)) throw new Error('Unexpected passive audit event');
  if (!event.cwd || !samePath(fs.realpathSync(event.cwd), config.repoDir)) throw new Error('Passive audit project mismatch');
  const record = { version: 1, sessionId: config.sessionId, event: event.hook_event_name, startedAt };
  if (event.hook_event_name === 'PostToolBatch') {
    if (!Array.isArray(event.tool_calls)) throw new Error('Missing native tool batch');
    record.calls = event.tool_calls.map(call => {
      if (!call.tool_use_id || !call.tool_name || !('tool_response' in call)
        || !(typeof call.tool_response === 'string' || Array.isArray(call.tool_response))) throw new Error('Malformed serialized native tool response');
      return { toolUseId: call.tool_use_id, tool: call.tool_name, input: call.tool_input || {},
        content: call.tool_response, isError: call.is_error === true };
    });
  } else {
    if (!event.tool_use_id || !event.tool_name) throw new Error('Missing native tool identity');
    record.toolUseId = event.tool_use_id; record.tool = event.tool_name;
    record.isError = event.hook_event_name === 'PostToolUseFailure' || event.tool_response?.isError === true;
    // Capture bytes now, before the host continues. Reading a file later when
    // stdout finally arrives can collapse several edits into the final state.
    try {
      const source = redactProcessCredential(fs.readFileSync(path.join(config.repoDir, 'lib/invoice.mjs'), 'utf8'));
      record.snapshot = { source, hash: crypto.createHash('sha256').update(source).digest('hex') };
    } catch (error) { record.snapshot = { error: error.message }; }
  }
  record.at = Date.now();
  const id = `${record.at}-${crypto.randomUUID()}`;
  const temporary = path.join(config.dir, `${id}.tmp`), target = path.join(config.dir, `${id}.event.json`);
  fs.writeFileSync(temporary, redactProcessCredential(JSON.stringify(record)), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
  return record;
}

export function readPassiveAudit(dir, { sessionId, before = Infinity, final = false, useReconciliation = true } = {}) {
  const records = [], errors = [], pending = [];
  const proofById = new Map(), receiptFile = path.join(dir, 'reconciliation.json');
  if (useReconciliation && fs.existsSync(receiptFile)) {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.version !== 1 || receipt.measurementTransport !== MEASUREMENT_TRANSPORT || receipt.sessionId !== sessionId
      || receipt.source !== 'closed-native-cli-stream' || !/^[a-f0-9]{64}$/.test(receipt.stdoutSha256)
      || !Array.isArray(receipt.proofs)) throw new Error('Invalid native reconciliation receipt');
    for (const proof of receipt.proofs) {
      if (proofById.has(proof.toolUseId)) throw new Error('Duplicate native reconciliation proof');
      proofById.set(proof.toolUseId, proof);
    }
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.error.json')) { errors.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); continue; }
    if (final && name.endsWith('.tmp')) errors.push({ error: 'Incomplete native audit record' });
    if (!name.endsWith('.event.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (record.version !== 1 || record.sessionId !== sessionId || !EVENTS.includes(record.event)
      || !Number.isFinite(record.at) || !Number.isFinite(record.startedAt)) throw new Error('Invalid native audit record');
    if (record.at <= before) records.push(record);
  }
  records.sort((a, b) => a.at - b.at || a.startedAt - b.startedAt);
  const completions = new Map(), responses = [], batched = new Set();
  for (const record of records.filter(r => r.event !== 'PostToolBatch')) {
    if (completions.has(record.toolUseId)) errors.push({ error: 'Duplicate tool completion', toolUseId: record.toolUseId });
    completions.set(record.toolUseId, record);
  }
  for (const record of records.filter(r => r.event === 'PostToolBatch')) {
    for (const call of record.calls) {
      if (batched.has(call.toolUseId)) errors.push({ error: 'Duplicate batched tool result', toolUseId: call.toolUseId });
      batched.add(call.toolUseId);
      const completion = completions.get(call.toolUseId);
      const proof = proofById.get(call.toolUseId);
      if (proof && !isVerifiedNativeDenial(proof, call, record)) errors.push({ error: 'Mismatched native reconciliation proof', toolUseId: call.toolUseId });
      if (isVerifiedNativeDenial(proof, call, record)) {
        if (completion) errors.push({ error: 'Native denial conflicts with a completed-tool audit', toolUseId: call.toolUseId });
        responses.push({ tool: call.tool, input: call.input, toolUseId: call.toolUseId, text: textOf(call.content),
          isError: true, notExecuted: true, at: record.at, channel: 'native-tool-batch' }); continue;
      }
      // Native 2.1.319 does not fire per-tool hooks when its input schema
      // rejects a call before execution. Its exact serialized validation
      // error is still a failed model-visible result, never positive exposure.
      const validationRejected = !completion && typeof call.content === 'string'
        && call.content.startsWith(`<tool_use_error>InputValidationError: ${call.tool} failed due to the following issue`)
        && call.content.endsWith('</tool_use_error>');
      if (validationRejected) {
        responses.push({ tool: call.tool, input: call.input, toolUseId: call.toolUseId, text: call.content,
          isError: true, notExecuted: true, at: record.at, channel: 'native-tool-batch' }); continue;
      }
      if (!completion) {
        pending.push({ ...call, at: record.at, status: 'pending-execution-evidence' });
        if (final) errors.push({ error: 'Unresolved native batch result lacks completion or typed nonexecution proof', toolUseId: call.toolUseId });
        continue;
      }
      if (completion.tool !== call.tool || completion.at > record.at) {
        errors.push({ error: 'Batch lacks a preceding matching completed-tool audit', toolUseId: call.toolUseId }); continue;
      }
      responses.push({ tool: call.tool, input: call.input, toolUseId: call.toolUseId, text: textOf(call.content),
        isError: call.isError || completion.isError, at: record.at, channel: 'native-tool-batch' });
    }
  }
  if (final) for (const id of completions.keys()) if (!batched.has(id)) errors.push({ error: 'Completed tool has no final batch audit', toolUseId: id });
  for (const id of proofById.keys()) if (!batched.has(id)) errors.push({ error: 'Native reconciliation proof lacks matching batch', toolUseId: id });
  return { records, responses, pending, errors, ok: errors.length === 0, finalized: final && errors.length === 0 && pending.length === 0,
    latestBatchAt: records.filter(r => r.event === 'PostToolBatch').at(-1)?.at ?? null };
}

async function main(configFile) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('Native audit input exceeds 32 MiB; no partial exposure accepted');
      chunks.push(chunk);
    }
    recordPassiveAudit(config, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (config?.dir) try { fs.writeFileSync(path.join(config.dir, `${crypto.randomUUID()}.error.json`),
      JSON.stringify({ at: Date.now(), error: error.message }), { flag: 'wx', mode: 0o600 }); } catch { /* missing records are rejected by the controller */ }
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
