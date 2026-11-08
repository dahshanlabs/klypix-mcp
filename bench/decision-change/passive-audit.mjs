// Passive host telemetry, identical for every condition. No fixture answer,
// evaluator, stdout, or context injection runs in the hook process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const MEASUREMENT_TRANSPORT = 'native-audit-v2';
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
  const config = { version: 1, dir, home: fs.realpathSync(home), repoDir: fs.realpathSync(repoDir), sessionId };
  fs.writeFileSync(configFile, JSON.stringify(config), { flag: 'wx' });
  const hooks = { ...(settings.hooks || {}) };
  for (const event of EVENTS) hooks[event] = [...(hooks[event] || []), {
    ...(event === 'PostToolBatch' ? {} : { matcher: '*' }),
    hooks: [{ type: 'command', command: process.execPath, args: [fileURLToPath(import.meta.url), configFile], timeout: 15 }],
  }];
  return { dir, configFile, sessionId, settings: { ...settings, hooks },
    read: options => readPassiveAudit(dir, { sessionId, ...options }) };
}

function scopedNativeDenials(config, event) {
  // The batch hook omits execution status. Native 2.1.319 writes its typed
  // rejection record before this synchronous hook runs. Read only this fresh
  // session's host-provided journal; never infer nonexecution from error text.
  const completed = new Set();
  for (const name of fs.readdirSync(config.dir).filter(name => name.endsWith('.event.json'))) {
    const record = JSON.parse(fs.readFileSync(path.join(config.dir, name), 'utf8'));
    if (record.sessionId !== config.sessionId || record.version !== 1 || !EVENTS.includes(record.event)) throw new Error('Invalid preceding native audit record');
    if (record.event !== 'PostToolBatch') completed.add(record.toolUseId);
  }
  const callsNeedingProof = event.tool_calls.filter(call => !completed.has(call.tool_use_id));
  if (!callsNeedingProof.length || !event.transcript_path) return new Map();
  const journal = fs.realpathSync(event.transcript_path);
  const journalRoot = fs.realpathSync(path.join(config.home, '.claude', 'projects'));
  const relative = path.relative(journalRoot, journal);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || path.basename(journal) !== `${config.sessionId}.jsonl`) throw new Error('Native audit journal is outside the isolated session');
  if (fs.statSync(journal).size > 32 * 1024 * 1024) throw new Error('Native audit journal exceeds 32 MiB');
  const text = fs.readFileSync(journal, 'utf8');
  // A concurrent append can leave an unfinished tail. Only newline-completed
  // records can prove a denial; malformed completed records still fail closed.
  const rows = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const denials = new Map();
  for (const call of callsNeedingProof) {
    const matches = rows.flatMap(row => row.type === 'user' && Array.isArray(row.message?.content)
      ? row.message.content.filter(block => block.type === 'tool_result' && block.tool_use_id === call.tool_use_id)
        .map(block => ({ row, block })) : []);
    // A missing/mismatched record cannot excuse a missing completion. The
    // reader below still fails closed if the normal per-tool hook is absent.
    if (matches.length !== 1) continue;
    const { row, block } = matches[0];
    if (row.sessionId !== config.sessionId || !row.cwd || !samePath(row.cwd, config.repoDir)
      || row.isSidechain !== false || block.is_error !== true || !isDeepStrictEqual(block.content, call.tool_response)
      || row.toolDenialKind !== 'user-rejected' || row.permissionDecision?.decision !== 'reject'
      || row.permissionDecision?.source !== 'config') continue;
    const assistants = rows.filter(candidate => candidate.type === 'assistant' && candidate.uuid === row.sourceToolAssistantUUID);
    if (assistants.length !== 1) continue;
    const assistant = assistants[0];
    if (assistant.sessionId !== config.sessionId || !assistant.cwd || !samePath(assistant.cwd, config.repoDir)
      || assistant.isSidechain !== false) continue;
    const uses = (assistant.message?.content || []).filter(item => item.type === 'tool_use' && item.id === call.tool_use_id);
    if (uses.length !== 1 || uses[0].name !== call.tool_name || !isDeepStrictEqual(uses[0].input, call.tool_input || {})) continue;
    // Preserve only matched typed provenance, not the journal, thinking, or
    // unrelated messages. The body already exists in the native batch record.
    denials.set(call.tool_use_id, { source: 'native-session-journal', sessionId: row.sessionId,
      toolUseId: call.tool_use_id, tool: call.tool_name, input: call.tool_input || {},
      resultUuid: row.uuid, assistantUuid: assistant.uuid, cwd: config.repoDir,
      isError: true, kind: row.toolDenialKind,
      permissionDecision: { decision: 'reject', source: 'config' },
      contentSha256: crypto.createHash('sha256').update(JSON.stringify(call.tool_response)).digest('hex') });
  }
  return denials;
}

function isVerifiedNativeDenial(call, record) {
  const proof = call.nativeDenial;
  return proof?.source === 'native-session-journal' && proof.sessionId === record.sessionId
    && proof.toolUseId === call.toolUseId && proof.tool === call.tool && isDeepStrictEqual(proof.input, call.input)
    && typeof proof.resultUuid === 'string' && proof.resultUuid.length > 0
    && typeof proof.assistantUuid === 'string' && proof.assistantUuid.length > 0
    && typeof proof.cwd === 'string' && proof.isError === true && proof.kind === 'user-rejected'
    && proof.permissionDecision?.decision === 'reject' && proof.permissionDecision?.source === 'config'
    && proof.contentSha256 === crypto.createHash('sha256').update(JSON.stringify(call.content)).digest('hex');
}

export function recordPassiveAudit(config, event) {
  const startedAt = Date.now();
  if (event.session_id !== config.sessionId) throw new Error('Passive audit session mismatch');
  if (!EVENTS.includes(event.hook_event_name)) throw new Error('Unexpected passive audit event');
  if (!event.cwd || !samePath(fs.realpathSync(event.cwd), config.repoDir)) throw new Error('Passive audit project mismatch');
  const record = { version: 1, sessionId: config.sessionId, event: event.hook_event_name, startedAt };
  if (event.hook_event_name === 'PostToolBatch') {
    if (!Array.isArray(event.tool_calls)) throw new Error('Missing native tool batch');
    const denials = scopedNativeDenials(config, event);
    record.calls = event.tool_calls.map(call => {
      if (!call.tool_use_id || !call.tool_name || !('tool_response' in call)
        || !(typeof call.tool_response === 'string' || Array.isArray(call.tool_response))) throw new Error('Malformed serialized native tool response');
      return { toolUseId: call.tool_use_id, tool: call.tool_name, input: call.tool_input || {},
        content: call.tool_response, isError: call.is_error === true,
        ...(denials.has(call.tool_use_id) ? { nativeDenial: denials.get(call.tool_use_id) } : {}) };
    });
  } else {
    if (!event.tool_use_id || !event.tool_name) throw new Error('Missing native tool identity');
    record.toolUseId = event.tool_use_id; record.tool = event.tool_name;
    record.isError = event.hook_event_name === 'PostToolUseFailure' || event.tool_response?.isError === true;
    // Capture bytes now, before the host continues. Reading a file later when
    // stdout finally arrives can collapse several edits into the final state.
    try {
      const source = fs.readFileSync(path.join(config.repoDir, 'lib/invoice.mjs'), 'utf8');
      record.snapshot = { source, hash: crypto.createHash('sha256').update(source).digest('hex') };
    } catch (error) { record.snapshot = { error: error.message }; }
  }
  record.at = Date.now();
  const id = `${record.at}-${crypto.randomUUID()}`;
  const temporary = path.join(config.dir, `${id}.tmp`), target = path.join(config.dir, `${id}.event.json`);
  fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
  return record;
}

export function readPassiveAudit(dir, { sessionId, before = Infinity, final = false } = {}) {
  const records = [], errors = [];
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
      if (isVerifiedNativeDenial(call, record)) {
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
      if (!completion || completion.tool !== call.tool || completion.at > record.at) {
        errors.push({ error: 'Batch lacks a preceding matching completed-tool audit', toolUseId: call.toolUseId }); continue;
      }
      responses.push({ tool: call.tool, input: call.input, toolUseId: call.toolUseId, text: textOf(call.content),
        isError: call.isError || completion.isError, at: record.at, channel: 'native-tool-batch' });
    }
  }
  if (final) for (const id of completions.keys()) if (!batched.has(id)) errors.push({ error: 'Completed tool has no final batch audit', toolUseId: id });
  return { records, responses, errors, ok: errors.length === 0,
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
