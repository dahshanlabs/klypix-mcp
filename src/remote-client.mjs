import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_DESCRIPTOR_PATH = path.join(os.homedir(), '.klypix', 'remote-relay', 'desktop.json');

const PROVIDERS = new Set([
  'antigravity-agent', 'claude-code', 'codex', 'cursor-agent', 'gemini-cli',
  'grok-build', 'kimi-code', 'opencode', 'pi', 'qoder', 'mistral-vibe', 'unknown',
]);
const OPERATIONS = new Set([
  'send-text', 'send-message', 'attach-image', 'attach-file', 'interrupt',
  'approve', 'reject', 'close', 'archive', 'resume', 'open-provider',
]);
const ATTACHMENT_KINDS = new Set(['image', 'video', 'audio', 'document', 'file']);

function isProcessAlive(processId) {
  try { process.kill(processId, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function readRemoteDescriptor(descriptorPath = DEFAULT_DESCRIPTOR_PATH) {
  const stat = fs.lstatSync(descriptorPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
  }
  const value = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  if (value?.schema !== 1
      || !Number.isSafeInteger(value.processId) || value.processId <= 0
      || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535
      || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(value.token)
      || typeof value.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.instanceId)
      || !isProcessAlive(value.processId)) {
    throw new Error('KLYPIX_REMOTE_DESCRIPTOR_STALE');
  }
  return Object.freeze({ ...value, descriptorPath });
}

async function requestRemote(method, route, body, options = {}) {
  let descriptor;
  try { descriptor = readRemoteDescriptor(options.descriptorPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('KLYPIX_DESKTOP_NOT_RUNNING');
    if (error instanceof SyntaxError) throw new Error('KLYPIX_REMOTE_DESCRIPTOR_INVALID');
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${descriptor.port}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('KLYPIX_REMOTE_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('KLYPIX_REMOTE_RESPONSE_TOO_LARGE');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('KLYPIX_REMOTE_RESPONSE_INVALID'); }
    if (!response.ok || parsed?.ok !== true) throw new Error(String(parsed?.code || 'KLYPIX_REMOTE_REQUEST_REJECTED'));
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('KLYPIX_REMOTE_REQUEST_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function remoteStatus(options) {
  return (await requestRemote('GET', '/v1/status', undefined, options)).status;
}

export async function remoteSessions({ projectId, ...options } = {}) {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await requestRemote('GET', `/v1/sessions${suffix}`, undefined, options)).sessions;
}

export async function remoteActions(options) {
  return (await requestRemote('GET', '/v1/actions', undefined, options)).actions;
}

function resolveAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 25) throw new Error('KLYPIX_REMOTE_ATTACHMENTS_INVALID');
  let total = 0;
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment.path !== 'string' || !ATTACHMENT_KINDS.has(attachment.kind)) {
      throw new Error('KLYPIX_REMOTE_ATTACHMENT_INVALID');
    }
    const resolvedPath = fs.realpathSync(attachment.path);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw new Error('KLYPIX_REMOTE_ATTACHMENT_SIZE_INVALID');
    total += stat.size;
    if (total > 100 * 1024 * 1024) throw new Error('KLYPIX_REMOTE_ATTACHMENTS_TOO_LARGE');
    const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType.length <= 128
      ? attachment.mimeType : 'application/octet-stream';
    return {
      id: randomUUID().toLowerCase(),
      kind: attachment.kind,
      path: resolvedPath,
      fileName: path.basename(resolvedPath),
      mimeType,
      byteSize: stat.size,
    };
  });
}

export function buildRemoteCommand(input, now = Date.now()) {
  if (!input || !PROVIDERS.has(input.provider) || !OPERATIONS.has(input.operation)) {
    throw new Error('KLYPIX_REMOTE_COMMAND_INVALID');
  }
  for (const [label, value, max] of [
    ['machine', input.machineId, 256], ['session', input.externalSessionId, 512],
    ['receipt', input.capabilityReceiptId, 256], ['binding', input.bindingId, 256],
  ]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`KLYPIX_REMOTE_${label.toUpperCase()}_INVALID`);
  }
  const attachments = resolveAttachments(input.attachments);
  const id = randomUUID().toLowerCase();
  const payload = {};
  if (typeof input.text === 'string') payload.text = input.text;
  if (attachments.length) payload.attachments = attachments;
  if (input.replaceDraft !== undefined) payload.replaceDraft = input.replaceDraft;
  return {
    id,
    idempotencyKey: randomUUID().toLowerCase(),
    identity: {
      machineId: input.machineId,
      provider: input.provider,
      externalSessionId: input.externalSessionId,
    },
    operation: input.operation,
    capabilityReceiptId: input.capabilityReceiptId,
    bindingId: input.bindingId,
    issuedAt: now,
    expiresAt: now + 60_000,
    ...(input.requestDigest ? { requestDigest: input.requestDigest } : {}),
    ...(Object.keys(payload).length ? { payload } : {}),
  };
}

export async function remoteCommand(input, options = {}) {
  const command = buildRemoteCommand(input, options.now ?? Date.now());
  return (await requestRemote('POST', '/v1/commands', command, options)).receipt;
}
