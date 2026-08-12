import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildRemoteCommand, readRemoteDescriptor, remoteSessions } from '../src/remote-client.mjs';

let pass = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  pass++;
  console.log(`ok ${pass} - ${message}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-client-'));
const descriptorPath = path.join(root, 'desktop.json');
let server;
try {
  server = http.createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer test_token_test_token_test_token_test_token') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, sessions: [{ key: request.url }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(descriptorPath, JSON.stringify({
    schema: 1,
    instanceId: '11111111-1111-4111-8111-111111111111',
    processId: process.pid,
    port,
    token: 'test_token_test_token_test_token_test_token',
    issuedAt: Date.now(),
  }));
  ok(readRemoteDescriptor(descriptorPath).port === port, 'accepts a live, bounded desktop descriptor');
  const sessions = await remoteSessions({ projectId: 'project/path', descriptorPath });
  ok(sessions[0].key === '/v1/sessions?projectId=project%2Fpath', 'authenticates and encodes the project route');

  const attachmentPath = path.join(root, 'photo.jpg');
  fs.writeFileSync(attachmentPath, 'image');
  const command = buildRemoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'session',
    operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
    text: 'continue', attachments: [{ path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' }],
  }, 1_000);
  ok(command.expiresAt === 61_000 && command.payload.attachments[0].byteSize === 5,
    'builds a short-lived command with verified local attachment metadata');
  ok(buildRemoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'session',
    operation: 'open-provider', capabilityReceiptId: 'receipt', bindingId: 'binding',
  }, 1_000).operation === 'open-provider', 'supports the deliberate exact-session control bootstrap');

  fs.writeFileSync(descriptorPath, JSON.stringify({ schema: 1, processId: 999_999_999, port, token: 'x'.repeat(43), instanceId: '11111111-1111-4111-8111-111111111111' }));
  let stale = false;
  try { readRemoteDescriptor(descriptorPath); } catch (error) { stale = error.message === 'KLYPIX_REMOTE_DESCRIPTOR_STALE'; }
  ok(stale, 'rejects a stale descriptor before making a request');
} finally {
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`# ${pass} remote client checks passed`);
