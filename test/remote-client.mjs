import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  buildRemoteCommand,
  readRemoteDescriptor,
  remoteActions,
  remoteCommand,
  remoteSessions,
  remoteStatus,
} from '../src/remote-client.mjs';

let pass = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  pass++;
  console.log(`ok ${pass} - ${message}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-client-'));
const descriptorPath = path.join(root, 'desktop.json');
const projectRoot = path.join(root, 'project');
const descendantRoot = path.join(projectRoot, 'packages', 'app');
const otherRoot = path.join(root, 'other-project');
const unboundRoot = path.join(root, 'unbound-project');
const legacyRoot = path.join(root, 'legacy-project');
fs.mkdirSync(descendantRoot, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });
fs.mkdirSync(unboundRoot, { recursive: true });
fs.mkdirSync(legacyRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'brain.klypix'), 'brain');
fs.writeFileSync(path.join(otherRoot, 'brain.klypix'), 'other brain');
fs.writeFileSync(path.join(legacyRoot, 'brain.any'), 'legacy brain');

const canonicalPath = (value) => {
  const resolved = fs.realpathSync.native(value);
  return process.platform === 'win32' ? path.normalize(resolved).toLowerCase() : path.normalize(resolved);
};
const testNow = Date.now();
const session = (localPath, externalSessionId, suffix) => ({
  key: `machine:codex:${externalSessionId}`,
  identity: { machineId: 'machine', provider: 'codex', externalSessionId },
  project: {
    projectId: `local:${canonicalPath(localPath)}`,
    localPath: fs.realpathSync.native(localPath),
    confidence: 'high',
    source: 'test',
    observedAt: testNow,
  },
  ownership: {
    status: 'active',
    activeBinding: { id: `binding-${suffix}` },
    candidates: [],
  },
  capabilities: {
    'send-message': {
      operation: 'send-message', available: true, receiptId: `receipt-${suffix}`,
      bindingId: `binding-${suffix}`, expiresAt: testNow + 50_000,
    },
  },
  observedAt: testNow,
});
const rootSession = session(projectRoot, 'root-session', 'root');
const descendantSession = session(descendantRoot, 'descendant-session', 'descendant');
const otherSession = session(otherRoot, 'other-session', 'other');
const inconsistentSession = {
  ...session(projectRoot, 'inconsistent-session', 'inconsistent'),
  project: {
    ...session(projectRoot, 'inconsistent-session', 'inconsistent').project,
    projectId: `local:${canonicalPath(otherRoot)}`,
  },
};
const allSessions = [rootSession, descendantSession, otherSession, inconsistentSession];
const allActions = allSessions.map((candidate, index) => ({
  id: `action-${index}`,
  identity: candidate.identity,
  type: 'QUESTION',
  status: 'pending',
}));

let server;
let oversized = false;
let oversizedClosed;
let resolveOversizedClosed;
let oversizedWrites = 0;
const requestedRoutes = [];
const postedCommands = [];
let postedSnapshotBytes = null;
let postedSnapshotPath = null;
try {
  const workerSource = fs.readFileSync(new URL('../bin/klypix-worker.mjs', import.meta.url), 'utf8');
  const helperStart = workerSource.indexOf('const remoteToolResult');
  const helperEnd = workerSource.indexOf("server.registerTool('remote_status'", helperStart);
  const remoteHelpers = workerSource.slice(helperStart, helperEnd);
  ok(helperStart >= 0 && helperEnd > helperStart && !remoteHelpers.includes('decorateToolResult'),
    'Remote handlers return raw results so the universal wrapper advances delivery exactly once');
  const remoteHandlers = workerSource.slice(workerSource.indexOf("server.registerTool('remote_status'"), workerSource.indexOf("server.registerTool('list_canvases'"));
  ok(!remoteHandlers.includes('project_id') && remoteHandlers.includes('projectRoot: remoteProjectRoot()')
      && workerSource.includes('mcpPresence.brainPath ? path.dirname(mcpPresence.brainPath) : null'),
  'Remote handlers derive the exact project root from the current bound brain, not launch cwd');
  const commandHandler = remoteHandlers.slice(remoteHandlers.indexOf("server.registerTool('remote_command'"));
  ok(commandHandler.includes('actionIdentity: extra.klypixRequestIdentity?.actionId'),
    'Remote command handler binds commands to the resolved MCP action identity');
  ok(commandHandler.includes('openWorldHint: true'),
    'Remote command truthfully declares that it can affect an external provider session');

  server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer test_token_test_token_test_token_test_token') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
      return;
    }
    requestedRoutes.push(`${request.method} ${request.url}`);
    if (oversized && request.url === '/v1/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      oversizedClosed = new Promise((resolve) => { resolveOversizedClosed = resolve; });
      response.once('close', () => resolveOversizedClosed());
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const writeChunk = () => {
        if (response.destroyed || oversizedWrites >= 80) {
          if (!response.destroyed) response.end();
          return;
        }
        oversizedWrites++;
        if (response.write(chunk)) setImmediate(writeChunk);
        else response.once('drain', writeChunk);
      };
      writeChunk();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/status') {
      response.end(JSON.stringify({
        ok: true,
        status: {
          serviceRunning: true, trayResident: true, localDiscovery: true,
          providerHooks: true, providerHooksConfigured: true, remoteCommands: true,
          networkRelay: true, contentSharing: false, paired: true,
          sessionCount: 99, pendingActionCount: 88,
          warnings: ['another project is failing'], pairedDeviceId: 'private-device-id',
        },
      }));
      return;
    }
    if (request.url === '/v1/sessions') {
      response.end(JSON.stringify({ ok: true, sessions: allSessions }));
      return;
    }
    if (request.url === '/v1/actions') {
      response.end(JSON.stringify({ ok: true, actions: allActions }));
      return;
    }
    if (request.url === '/v1/commands' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      postedCommands.push(command);
      if (command.payload?.attachments?.[0]?.path) {
        postedSnapshotPath = command.payload.attachments[0].path;
        postedSnapshotBytes = fs.readFileSync(postedSnapshotPath);
      }
      response.end(JSON.stringify({ ok: true, receipt: { commandId: command.id, status: 'executed' } }));
      return;
    }
    response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(descriptorPath, JSON.stringify({
    schema: 1,
    instanceId: '11111111-1111-4111-8111-111111111111',
    processId: process.pid,
    port,
    token: 'test_token_test_token_test_token_test_token',
    attachmentIntegrity: 'sha256-v1',
    issuedAt: Date.now(),
  }));
  const liveDescriptor = readRemoteDescriptor(descriptorPath);
  ok(liveDescriptor.port === port && liveDescriptor.attachmentIntegrity === 'sha256-v1',
    'accepts a live, bounded Desktop descriptor with the SHA-256 attachment contract');
  const originalReadFileSync = fs.readFileSync;
  const descriptorOpenSync = fs.openSync;
  let singleDescriptorOpenCount = 0;
  fs.readFileSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(descriptorPath)) {
      throw new Error('descriptor pathname read was attempted');
    }
    return originalReadFileSync(target, ...args);
  };
  fs.openSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(descriptorPath)) singleDescriptorOpenCount++;
    return descriptorOpenSync(target, ...args);
  };
  try {
    ok(readRemoteDescriptor(descriptorPath).port === port && singleDescriptorOpenCount === 1,
      'reads the descriptor twice through one bounded no-follow file descriptor, never by pathname');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.openSync = descriptorOpenSync;
  }

  const swappedDescriptorPath = path.join(root, 'desktop-swapped.json');
  fs.writeFileSync(swappedDescriptorPath, JSON.stringify({
    schema: 1,
    instanceId: '22222222-2222-4222-8222-222222222222',
    processId: process.pid,
    port,
    token: 'swap_token_swap_token_swap_token_swap_token_swap',
    attachmentIntegrity: 'sha256-v1',
    issuedAt: Date.now(),
  }));
  const originalLstatSync = fs.lstatSync;
  let descriptorBindingReads = 0;
  fs.lstatSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(descriptorPath)) {
      descriptorBindingReads++;
      if (descriptorBindingReads >= 3) return originalLstatSync(swappedDescriptorPath, ...args);
    }
    return originalLstatSync(target, ...args);
  };
  let descriptorSwapRejected = false;
  try { readRemoteDescriptor(descriptorPath); }
  catch (error) { descriptorSwapRejected = error.message === 'KLYPIX_REMOTE_DESCRIPTOR_INVALID'; }
  finally { fs.lstatSync = originalLstatSync; }
  ok(descriptorSwapRejected,
    'rejects a deterministic descriptor pathname swap after the fd read using platform-safe same-file checks');
  const supportedDescriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  fs.writeFileSync(descriptorPath, JSON.stringify({ ...supportedDescriptor, attachmentIntegrity: 'unknown' }));
  let unknownIntegrityRejected = false;
  try { readRemoteDescriptor(descriptorPath); }
  catch (error) { unknownIntegrityRejected = error.message === 'KLYPIX_REMOTE_DESCRIPTOR_INVALID'; }
  ok(unknownIntegrityRejected, 'rejects an unknown descriptor attachment-integrity contract');
  fs.writeFileSync(descriptorPath, JSON.stringify(supportedDescriptor));

  const status = await remoteStatus({ projectRoot, descriptorPath });
  ok(status.serviceRunning === true && status.remoteCommands === true && status.contentSharing === false,
    'returns project-safe Remote relay health flags');
  ok(!('sessionCount' in status) && !('pendingActionCount' in status)
      && !('warnings' in status) && !('pairedDeviceId' in status),
  'redacts machine-global counts, warnings, and device identity from project-scoped status');

  const sessions = await remoteSessions({ projectRoot, descriptorPath });
  ok(sessions.length === 2 && sessions.some((candidate) => candidate.identity.externalSessionId === 'root-session')
      && sessions.some((candidate) => candidate.identity.externalSessionId === 'descendant-session'),
  'returns only exact or descendant sessions with consistent canonical project metadata');
  ok(requestedRoutes.includes('GET /v1/sessions') && !requestedRoutes.some((route) => route.includes('projectId=')),
    'fetches relay sessions without a caller-controlled project identifier and filters locally');

  const actions = await remoteActions({ projectRoot, descriptorPath });
  ok(actions.length === 2 && actions.every((action) => action.identity.externalSessionId !== 'other-session'),
    'returns actions only for identities admitted by project-scoped sessions');

  let unboundRejected = false;
  try { await remoteSessions({ projectRoot: unboundRoot, descriptorPath }); }
  catch (error) { unboundRejected = error.message === 'KLYPIX_REMOTE_PROJECT_NOT_BOUND'; }
  ok(unboundRejected, 'fails closed when the MCP vault is not bound by a project brain');
  const legacySessions = await remoteSessions({ projectRoot: legacyRoot, descriptorPath });
  ok(Array.isArray(legacySessions) && legacySessions.length === 0,
    'accepts a legacy brain.any project boundary without exposing another project');

  const receipt = await remoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'descendant-session',
    operation: 'send-message', capabilityReceiptId: 'receipt-descendant', bindingId: 'binding-descendant',
    text: 'continue',
  }, { projectRoot, descriptorPath, actionIdentity: 'mcp-request:scoped-command', now: testNow });
  ok(receipt.status === 'executed' && postedCommands.length === 1,
    'preauthorizes and posts a command to an exact descendant session capability');

  let crossProjectRejected = false;
  try {
    await remoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'other-session',
      operation: 'send-message', capabilityReceiptId: 'receipt-other', bindingId: 'binding-other', text: 'continue',
    }, { projectRoot, descriptorPath, actionIdentity: 'mcp-request:cross-project', now: testNow });
  } catch (error) { crossProjectRejected = error.message === 'KLYPIX_REMOTE_SESSION_OUT_OF_SCOPE'; }
  ok(crossProjectRejected && postedCommands.length === 1,
    'rejects a cross-project command before posting it to the relay');

  let mismatchedCapabilityRejected = false;
  try {
    await remoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'root-session',
      operation: 'send-message', capabilityReceiptId: 'receipt-other', bindingId: 'binding-root', text: 'continue',
    }, { projectRoot, descriptorPath, actionIdentity: 'mcp-request:wrong-capability', now: testNow });
  } catch (error) { mismatchedCapabilityRejected = error.message === 'KLYPIX_REMOTE_CAPABILITY_NOT_AUTHORIZED'; }
  ok(mismatchedCapabilityRejected && postedCommands.length === 1,
    'rejects an operation, receipt, or binding mismatch before POST');

  let pendingRequestRejected = false;
  try {
    await remoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'root-session',
      operation: 'approve', capabilityReceiptId: 'receipt-root', bindingId: 'binding-root',
      requestDigest: 'a'.repeat(64),
    }, { projectRoot, descriptorPath, actionIdentity: 'mcp-request:unmatched-approval', now: testNow });
  } catch (error) { pendingRequestRejected = error.message === 'KLYPIX_REMOTE_PENDING_REQUEST_NOT_AUTHORIZED'; }
  ok(pendingRequestRejected && postedCommands.length === 1,
    'rejects approve/reject unless a scoped pending action matches the exact digest and operation');

  const attachmentPath = path.join(descendantRoot, 'photo.jpg');
  fs.writeFileSync(attachmentPath, 'image');
  const command = buildRemoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'session',
    operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
    text: 'continue', attachments: [{ path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' }],
  }, 1_000, 'mcp-request:same-action', projectRoot);
  const imageDigest = createHash('sha256').update('image').digest('hex');
  ok(command.expiresAt === 61_000 && command.payload.attachments[0].byteSize === 5
      && command.payload.attachments[0].contentDigest === imageDigest
      && canonicalPath(command.payload.attachments[0].path) !== canonicalPath(attachmentPath)
      && fs.readFileSync(command.payload.attachments[0].path, 'utf8') === 'image',
  'posts a distinct exact-byte MCP-owned snapshot with its Desktop-verifiable SHA-256 digest');
  ok(!canonicalPath(command.payload.attachments[0].path).startsWith(`${canonicalPath(projectRoot)}${path.sep}`),
    'keeps the posted snapshot outside the agent-controlled project tree');

  fs.writeFileSync(descriptorPath, JSON.stringify((({ attachmentIntegrity: _omit, ...legacy }) => legacy)(
    JSON.parse(fs.readFileSync(descriptorPath, 'utf8')),
  )));
  const beforeUnsupportedPostCount = postedCommands.length;
  let unsupportedIntegrityRejected = false;
  try {
    await remoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'descendant-session',
      operation: 'send-message', capabilityReceiptId: 'receipt-descendant', bindingId: 'binding-descendant',
      attachments: [{ path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' }],
    }, {
      projectRoot, descriptorPath,
      actionIdentity: 'mcp-request:unsupported-attachment-integrity', now: testNow,
    });
  } catch (error) {
    unsupportedIntegrityRejected = error.message === 'KLYPIX_REMOTE_ATTACHMENT_INTEGRITY_UNSUPPORTED';
  }
  ok(unsupportedIntegrityRejected && postedCommands.length === beforeUnsupportedPostCount,
    'fails closed before POST when an old Desktop descriptor lacks SHA-256 attachment integrity');
  const legacyTextReceipt = await remoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'descendant-session',
    operation: 'send-message', capabilityReceiptId: 'receipt-descendant', bindingId: 'binding-descendant',
    text: 'legacy text stays compatible',
  }, {
    projectRoot, descriptorPath,
    actionIdentity: 'mcp-request:legacy-text-compatibility', now: testNow,
  });
  ok(legacyTextReceipt.status === 'executed',
    'keeps text-only commands compatible with old schema-1 Desktop descriptors');
  fs.writeFileSync(descriptorPath, JSON.stringify(supportedDescriptor));

  const firstPostInput = {
    machineId: 'machine', provider: 'codex', externalSessionId: 'descendant-session',
    operation: 'send-message', capabilityReceiptId: 'receipt-descendant', bindingId: 'binding-descendant',
    text: 'first post verification',
    attachments: [{ path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' }],
  };
  const firstPostCommand = buildRemoteCommand(
    firstPostInput, testNow, 'mcp-request:first-post-verification', projectRoot,
  );
  const firstPostSnapshot = firstPostCommand.payload.attachments[0].path;
  const originalOpenSync = fs.openSync;
  let descriptorOpens = 0;
  fs.openSync = (target, ...args) => {
    const descriptor = originalOpenSync(target, ...args);
    if (path.resolve(String(target)) === path.resolve(descriptorPath)) {
      descriptorOpens++;
      if (descriptorOpens === 2) {
        fs.chmodSync(firstPostSnapshot, 0o600);
        fs.writeFileSync(firstPostSnapshot, 'tampered immediately before POST');
      }
    }
    return descriptor;
  };
  const beforeFirstPostCount = postedCommands.length;
  let firstPostTamperRejected = false;
  try {
    await remoteCommand(firstPostInput, {
      projectRoot, descriptorPath,
      actionIdentity: 'mcp-request:first-post-verification', now: testNow,
    });
  } catch (error) { firstPostTamperRejected = error.message === 'KLYPIX_REMOTE_SNAPSHOT_INVALID'; }
  finally { fs.openSync = originalOpenSync; }
  ok(firstPostTamperRejected && postedCommands.length === beforeFirstPostCount
      && !fs.existsSync(firstPostSnapshot),
  'reverifies snapshot inode, mode, size, and SHA-256 immediately before the first POST');

  const raceDirectory = path.join(descendantRoot, 'attachment-race');
  const savedRaceDirectory = path.join(descendantRoot, 'attachment-race-original');
  const raceAttachment = path.join(raceDirectory, 'payload.txt');
  const outsideRaceAttachment = path.join(otherRoot, 'payload.txt');
  fs.mkdirSync(raceDirectory);
  fs.writeFileSync(raceAttachment, 'trusted-before-post');
  fs.writeFileSync(outsideRaceAttachment, 'outside-after-swap');
  let swappedSourceCanonical = null;
  const replacingFetch = async (url, init) => {
    if (String(url).endsWith('/v1/commands')) {
      const postedCommand = JSON.parse(init.body);
      fs.renameSync(raceDirectory, savedRaceDirectory);
      fs.symlinkSync(otherRoot, raceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      swappedSourceCanonical = canonicalPath(raceAttachment);
      postedSnapshotPath = postedCommand.payload.attachments[0].path;
      postedSnapshotBytes = fs.readFileSync(postedSnapshotPath);
    }
    return fetch(url, init);
  };
  try {
    const raceReceipt = await remoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'descendant-session',
      operation: 'send-message', capabilityReceiptId: 'receipt-descendant', bindingId: 'binding-descendant',
      text: 'attach', attachments: [{ path: raceAttachment, kind: 'file', mimeType: 'text/plain' }],
    }, {
      projectRoot, descriptorPath, fetchImpl: replacingFetch,
      actionIdentity: 'mcp-request:attachment-race', now: testNow,
    });
    ok(raceReceipt.status === 'executed'
        && canonicalPath(postedSnapshotPath) !== canonicalPath(raceAttachment)
        && postedSnapshotBytes?.toString('utf8') === 'trusted-before-post',
    'posts only the immutable snapshot and preserves its exact bytes when the source path is replaced before Desktop reads');
    ok(swappedSourceCanonical === canonicalPath(outsideRaceAttachment),
      'source replacement can escape the project after snapshotting without redirecting the posted attachment');
  } finally {
    if (fs.existsSync(raceDirectory)) {
      if (process.platform === 'win32') fs.rmdirSync(raceDirectory);
      else fs.unlinkSync(raceDirectory);
    }
    if (fs.existsSync(savedRaceDirectory)) fs.renameSync(savedRaceDirectory, raceDirectory);
  }

  let relativeRejected = false;
  try {
    buildRemoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'session',
      operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
      attachments: [{ path: 'photo.jpg', kind: 'image' }],
    }, 1_000, 'mcp-request:relative-attachment', projectRoot);
  } catch (error) { relativeRejected = error.message === 'KLYPIX_REMOTE_ATTACHMENT_PATH_INVALID'; }
  ok(relativeRejected, 'rejects a relative attachment path');

  const outsideAttachment = path.join(otherRoot, 'outside.txt');
  fs.writeFileSync(outsideAttachment, 'outside');
  let outsideRejected = false;
  try {
    buildRemoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'session',
      operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
      attachments: [{ path: outsideAttachment, kind: 'file' }],
    }, 1_000, 'mcp-request:outside-attachment', projectRoot);
  } catch (error) { outsideRejected = error.message === 'KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT'; }
  ok(outsideRejected, 'rejects an attachment outside the bound project');

  const escapeLink = path.join(projectRoot, 'escape-link');
  fs.symlinkSync(otherRoot, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
  let symlinkEscapeRejected = false;
  try {
    buildRemoteCommand({
      machineId: 'machine', provider: 'codex', externalSessionId: 'session',
      operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
      attachments: [{ path: path.join(escapeLink, 'outside.txt'), kind: 'file' }],
    }, 1_000, 'mcp-request:symlink-attachment', projectRoot);
  } catch (error) { symlinkEscapeRejected = error.message === 'KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT'; }
  ok(symlinkEscapeRejected, 'rejects a lexical in-project attachment that escapes through a symlink');

  ok(buildRemoteCommand({
    machineId: 'machine', provider: 'codex', externalSessionId: 'session',
    operation: 'open-provider', capabilityReceiptId: 'receipt', bindingId: 'binding',
  }, 1_000, 'mcp-request:bootstrap-action').operation === 'open-provider',
  'supports the deliberate exact-session control bootstrap');

  const retryInput = {
    machineId: 'machine', provider: 'codex', externalSessionId: 'session',
    operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding', text: 'same content',
    attachments: [{ path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' }],
  };
  const firstAttempt = buildRemoteCommand(retryInput, 1_000, 'mcp-request:retry-action', projectRoot);
  const retryAttempt = buildRemoteCommand(retryInput, 2_000, 'mcp-request:retry-action', projectRoot);
  const otherAction = buildRemoteCommand(retryInput, 1_000, 'mcp-request:other-action', projectRoot);
  ok(JSON.stringify(firstAttempt) === JSON.stringify(retryAttempt),
    'same MCP action and input returns a byte-identical full command across retries');
  ok(firstAttempt.payload.attachments[0].path === retryAttempt.payload.attachments[0].path
      && fs.readFileSync(retryAttempt.payload.attachments[0].path, 'utf8') === 'image',
  'reuses the same verified immutable snapshot across a byte-identical retry');
  ok(firstAttempt.id !== otherAction.id && firstAttempt.idempotencyKey !== otherAction.idempotencyKey,
    'different MCP actions receive distinct command ids and idempotency keys');
  const tamperedSnapshot = otherAction.payload.attachments[0].path;
  fs.chmodSync(tamperedSnapshot, 0o600);
  fs.writeFileSync(tamperedSnapshot, 'tampered');
  let tamperedSnapshotRejected = false;
  try { buildRemoteCommand(retryInput, 2_000, 'mcp-request:other-action', projectRoot); }
  catch (error) { tamperedSnapshotRejected = error.message === 'KLYPIX_REMOTE_SNAPSHOT_INVALID'; }
  ok(tamperedSnapshotRejected && !fs.existsSync(tamperedSnapshot),
    'rejects and cleans a cached snapshot if its inode, mode, size, or content is tampered before retry');
  let changedRetryRejected = false;
  try { buildRemoteCommand({ ...retryInput, text: 'changed content' }, 2_000, 'mcp-request:retry-action', projectRoot); }
  catch (error) { changedRetryRejected = error.message === 'KLYPIX_REMOTE_ACTION_CONTENT_CHANGED'; }
  ok(changedRetryRejected, 'fails closed when one MCP action identity is retried with changed content');
  const replacedAttachment = `${attachmentPath}.original`;
  fs.renameSync(attachmentPath, replacedAttachment);
  fs.writeFileSync(attachmentPath, 'image');
  let replacedSourceRejected = false;
  try { buildRemoteCommand(retryInput, 2_000, 'mcp-request:retry-action', projectRoot); }
  catch (error) { replacedSourceRejected = error.message === 'KLYPIX_REMOTE_ACTION_CONTENT_CHANGED'; }
  fs.unlinkSync(attachmentPath);
  fs.renameSync(replacedAttachment, attachmentPath);
  ok(replacedSourceRejected,
    'fails closed when the original source pathname is replaced even with byte-identical content');

  const snapshotPool = path.dirname(path.dirname(firstAttempt.payload.attachments[0].path));
  const directoriesBeforeFailedBuild = fs.readdirSync(snapshotPool).sort().join('\n');
  let failedBuildRejected = false;
  try {
    buildRemoteCommand({
      ...retryInput,
      attachments: [
        { path: attachmentPath, kind: 'image', mimeType: 'image/jpeg' },
        { path: outsideAttachment, kind: 'file' },
      ],
    }, 1_000, 'mcp-request:failed-snapshot-build', projectRoot);
  } catch (error) { failedBuildRejected = error.message === 'KLYPIX_REMOTE_ATTACHMENT_OUTSIDE_PROJECT'; }
  ok(failedBuildRejected
      && fs.readdirSync(snapshotPool).sort().join('\n') === directoriesBeforeFailedBuild,
  'removes a private snapshot directory when later attachment validation fails');

  const expiringCommand = buildRemoteCommand(retryInput, 1_000, 'mcp-request:expiring-snapshot', projectRoot);
  const expiringSnapshot = expiringCommand.payload.attachments[0].path;
  let expiredRejected = false;
  try { buildRemoteCommand(retryInput, 61_000, 'mcp-request:expiring-snapshot', projectRoot); }
  catch (error) { expiredRejected = error.message === 'KLYPIX_REMOTE_ACTION_EXPIRED'; }
  ok(expiredRejected && !fs.existsSync(expiringSnapshot),
    'removes the private snapshot synchronously when its cached command expires');
  let expiredRegenerationRejected = false;
  try { buildRemoteCommand(retryInput, 62_000, 'mcp-request:expiring-snapshot', projectRoot); }
  catch (error) { expiredRegenerationRejected = error.message === 'KLYPIX_REMOTE_ACTION_EXPIRED'; }
  ok(expiredRegenerationRejected,
    'tombstones an expired action identity so it can never regenerate different command bytes');

  const moduleUrl = new URL('../src/remote-client.mjs', import.meta.url).href;
  const budgetScript = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-budget-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'brain.klypix'), 'brain');
    const files = new Map([
      ['too-big', '12345678901'], ['full', '1234567890'],
      ['a', '123456'], ['b', '1234'], ['c', '12345'], ['d', '123456'], ['e', '1234'],
    ]);
    for (const [name, content] of files) fs.writeFileSync(path.join(project, name), content);
    const input = (name) => ({
      machineId: 'machine', provider: 'codex', externalSessionId: 'session',
      operation: 'send-message', capabilityReceiptId: 'receipt', bindingId: 'binding',
      attachments: [{ path: path.join(project, name), kind: 'file' }],
    });
    const build = (name, now = 1000) => buildRemoteCommand(
      input(name), now, 'budget:' + name, project,
    );
    const errorCode = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
    const originalOpen = fs.openSync;
    let snapshotOpens = 0;
    fs.openSync = (target, ...args) => {
      if (String(target).endsWith('.snapshot')) snapshotOpens++;
      return originalOpen(target, ...args);
    };
    try {
      const overBudget = errorCode(() => build('too-big'));
      const opensAfterOverBudget = snapshotOpens;
      const full = build('full');
      const fullPath = full.payload.attachments[0].path;
      const fullCreated = fs.existsSync(fullPath);
      const expired = errorCode(() => build('full', 61000));
      const expiredAgain = errorCode(() => build('full', 62000));
      const a = build('a');
      const b = build('b');
      const aPath = a.payload.attachments[0].path;
      const bPath = b.payload.attachments[0].path;
      const c = build('c');
      const cPath = c.payload.attachments[0].path;
      const evictedA = errorCode(() => build('a', 2000));
      const bRetryStable = JSON.stringify(b) === JSON.stringify(build('b', 2000));
      const d = build('d');
      const dPath = d.payload.attachments[0].path;
      const evictedB = errorCode(() => build('b', 3000));
      const evictedC = errorCode(() => build('c', 3000));
      const e = build('e');
      process.stdout.write(JSON.stringify({
        overBudget, opensAfterOverBudget, fullCreated, expired, expiredAgain,
        fullCleaned: !fs.existsSync(fullPath), evictedA, aCleaned: !fs.existsSync(aPath),
        bRetryStable, evictedB, evictedC,
        bCleaned: !fs.existsSync(bPath), cCleaned: !fs.existsSync(cPath),
        dAlive: fs.existsSync(dPath), eAlive: fs.existsSync(e.payload.attachments[0].path),
      }));
    } finally {
      fs.openSync = originalOpen;
      fs.rmSync(root, { recursive: true, force: true });
    }
  `;
  const budgetRun = spawnSync(process.execPath, ['--input-type=module', '-e', budgetScript], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      KLYPIX_REMOTE_TEST_SNAPSHOT_BYTE_BUDGET: '10',
      KLYPIX_REMOTE_TEST_SNAPSHOT_ENTRY_LIMIT: '2',
    },
  });
  let budgetEvidence = null;
  try { budgetEvidence = JSON.parse(budgetRun.stdout); } catch { /* asserted below */ }
  ok(budgetRun.status === 0
      && budgetEvidence?.overBudget === 'KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT'
      && budgetEvidence.opensAfterOverBudget === 0
      && budgetEvidence.fullCreated && budgetEvidence.expired === 'KLYPIX_REMOTE_ACTION_EXPIRED'
      && budgetEvidence.expiredAgain === 'KLYPIX_REMOTE_ACTION_EXPIRED'
      && budgetEvidence.fullCleaned,
  'reserves before copying, rejects an over-budget in-flight build without leakage, and tombstones expiry');
  ok(budgetEvidence?.evictedA === 'KLYPIX_REMOTE_ACTION_EVICTED'
      && budgetEvidence.aCleaned && budgetEvidence.bRetryStable,
  'enforces the narrow snapshot-entry cap by evicting and tombstoning only the oldest retained action');
  ok(budgetEvidence?.evictedB === 'KLYPIX_REMOTE_ACTION_EVICTED'
      && budgetEvidence.evictedC === 'KLYPIX_REMOTE_ACTION_EVICTED'
      && budgetEvidence.bCleaned && budgetEvidence.cCleaned
      && budgetEvidence.dAlive && budgetEvidence.eAlive,
  'reclaims byte accounting exactly once across multi-entry eviction and reuses the full released budget');

  const cleanupFailureScript = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-cleanup-failure-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'brain.klypix'), 'brain');
    fs.writeFileSync(path.join(project, 'a'), '123456');
    fs.writeFileSync(path.join(project, 'b'), '12345');
    const input = (name) => ({ machineId: 'm', provider: 'codex', externalSessionId: 's',
      operation: 'send-message', capabilityReceiptId: 'r', bindingId: 'b',
      attachments: [{ path: path.join(project, name), kind: 'file' }] });
    const a = buildRemoteCommand(input('a'), 1000, 'cleanup-failure:a', project);
    const aPath = a.payload.attachments[0].path;
    const snapshotDirectory = path.dirname(aPath);
    const originalRm = fs.rmSync;
    let injected = 0;
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === path.resolve(snapshotDirectory)) {
        injected++;
        throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
      }
      return originalRm(target, options);
    };
    let blocked;
    try { buildRemoteCommand(input('b'), 1000, 'cleanup-failure:b', project); }
    catch (error) { blocked = error.message; }
    const retainedAfterFailure = fs.existsSync(aPath);
    fs.rmSync = originalRm;
    const b = buildRemoteCommand(input('b'), 2000, 'cleanup-failure:b-retry', project);
    process.stdout.write(JSON.stringify({
      blocked, injected, retainedAfterFailure,
      oldRemoved: !fs.existsSync(aPath), newAlive: fs.existsSync(b.payload.attachments[0].path),
    }));
  `;
  const cleanupFailureRun = spawnSync(
    process.execPath, ['--input-type=module', '-e', cleanupFailureScript], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, NODE_ENV: 'test',
        KLYPIX_REMOTE_TEST_SNAPSHOT_BYTE_BUDGET: '10',
        KLYPIX_REMOTE_TEST_SNAPSHOT_ENTRY_LIMIT: '2',
      },
    },
  );
  let cleanupFailureEvidence = null;
  try { cleanupFailureEvidence = JSON.parse(cleanupFailureRun.stdout); } catch { /* asserted below */ }
  ok(cleanupFailureRun.status === 0
      && cleanupFailureEvidence?.blocked === 'KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT'
      && cleanupFailureEvidence.injected >= 1 && cleanupFailureEvidence.retainedAfterFailure
      && cleanupFailureEvidence.oldRemoved && cleanupFailureEvidence.newAlive,
  'keeps failed-deletion bytes charged, blocks over-budget copying, then reuses capacity only after confirmed cleanup');

  const constructionCleanupScript = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-construction-cleanup-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'brain.klypix'), 'brain');
    fs.writeFileSync(path.join(project, 'a'), '123456');
    fs.writeFileSync(path.join(project, 'b'), '12345');
    const input = (name) => ({ machineId: 'm', provider: 'codex', externalSessionId: 's',
      operation: 'send-message', capabilityReceiptId: 'r', bindingId: 'b',
      attachments: [{ path: path.join(project, name), kind: 'file' }] });
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalUnlink = fs.unlinkSync;
    const originalRm = fs.rmSync;
    let partialPath = null;
    fs.openSync = (target, ...args) => {
      const fd = originalOpen(target, ...args);
      if (String(target).endsWith('.snapshot')) partialPath = String(target);
      return fd;
    };
    fs.fsyncSync = () => { throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' }); };
    fs.unlinkSync = (target, ...args) => {
      if (String(target).endsWith('.snapshot')) {
        throw Object.assign(new Error('injected unlink failure'), { code: 'EBUSY' });
      }
      return originalUnlink(target, ...args);
    };
    fs.rmSync = (target, options) => {
      if (String(target).includes('klypix-mcp-remote-')) {
        throw Object.assign(new Error('injected rm failure'), { code: 'EBUSY' });
      }
      return originalRm(target, options);
    };
    let constructionError;
    try { buildRemoteCommand(input('a'), 1000, 'construction:a', project); }
    catch (error) { constructionError = error.message; }
    const partialRetained = partialPath && fs.existsSync(partialPath);
    let blocked;
    try { buildRemoteCommand(input('b'), 1000, 'construction:b', project); }
    catch (error) { blocked = error.message; }
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.unlinkSync = originalUnlink;
    fs.rmSync = originalRm;
    const b = buildRemoteCommand(input('b'), 2000, 'construction:b-retry', project);
    const bPath = b.payload.attachments[0].path;
    process.stdout.write(JSON.stringify({
      constructionError, partialRetained, blocked,
      partialRemoved: !fs.existsSync(partialPath),
      sameRoot: path.dirname(path.dirname(partialPath)) === path.dirname(path.dirname(bPath)),
      retryAlive: fs.existsSync(bPath),
    }));
  `;
  const constructionCleanupRun = spawnSync(
    process.execPath, ['--input-type=module', '-e', constructionCleanupScript], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, NODE_ENV: 'test',
        KLYPIX_REMOTE_TEST_SNAPSHOT_BYTE_BUDGET: '10',
        KLYPIX_REMOTE_TEST_SNAPSHOT_ENTRY_LIMIT: '2',
      },
    },
  );
  let constructionCleanupEvidence = null;
  try { constructionCleanupEvidence = JSON.parse(constructionCleanupRun.stdout); } catch { /* asserted below */ }
  ok(constructionCleanupRun.status === 0
      && constructionCleanupEvidence?.constructionError === 'KLYPIX_REMOTE_SNAPSHOT_CLEANUP_FAILED'
      && constructionCleanupEvidence.partialRetained
      && constructionCleanupEvidence.blocked === 'KLYPIX_REMOTE_SNAPSHOT_RESOURCE_LIMIT'
      && constructionCleanupEvidence.partialRemoved && constructionCleanupEvidence.sameRoot
      && constructionCleanupEvidence.retryAlive,
  'retains construction-failure snapshots and accounting under the same root until confirmed recursive cleanup');

  const commandCapacityScript = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-remote-command-capacity-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'brain.klypix'), 'brain');
    for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(project, name), name.repeat(4));
    const base = { machineId: 'm', provider: 'codex', externalSessionId: 's',
      operation: 'send-message', capabilityReceiptId: 'r', bindingId: 'b' };
    const attached = (name) => ({ ...base,
      attachments: [{ path: path.join(project, name), kind: 'file' }] });
    const errorCode = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
    const first = buildRemoteCommand(attached('a'), 1000, 'capacity:first', project);
    const firstPath = first.payload.attachments[0].path;
    const firstDirectory = path.dirname(firstPath);
    const second = buildRemoteCommand({ ...base, operation: 'open-provider' }, 1000,
      'capacity:second', project);
    const originalRm = fs.rmSync;
    const originalOpen = fs.openSync;
    const createdSnapshots = [];
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (String(target).endsWith('.snapshot')) createdSnapshots.push(String(target));
      return descriptor;
    };
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === path.resolve(firstDirectory)) {
        throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
      }
      return originalRm(target, options);
    };
    const overflowOne = errorCode(() => buildRemoteCommand(
      attached('b'), 1000, 'capacity:overflow-one', project));
    const firstOverflowCleaned = createdSnapshots.length >= 1
      && !fs.existsSync(createdSnapshots[createdSnapshots.length - 1]);
    const overflowTwo = errorCode(() => buildRemoteCommand(
      attached('c'), 1000, 'capacity:overflow-two', project));
    const secondOverflowCleaned = createdSnapshots.length >= 2
      && !fs.existsSync(createdSnapshots[createdSnapshots.length - 1]);
    const retainedOldest = fs.existsSync(firstPath);
    const retiredOldest = errorCode(() => buildRemoteCommand(
      attached('a'), 1000, 'capacity:first', project));
    fs.rmSync = originalRm;
    fs.openSync = originalOpen;
    const admitted = buildRemoteCommand(attached('b'), 2000, 'capacity:admitted', project);
    process.stdout.write(JSON.stringify({
      overflowOne, overflowTwo, firstOverflowCleaned, secondOverflowCleaned,
      retainedOldest, retiredOldest,
      secondStable: JSON.stringify(second) === JSON.stringify(buildRemoteCommand(
        { ...base, operation: 'open-provider' }, 2000, 'capacity:second', project)),
      oldestRemoved: !fs.existsSync(firstPath), admittedAlive: fs.existsSync(admitted.payload.attachments[0].path),
    }));
  `;
  const commandCapacityRun = spawnSync(
    process.execPath, ['--input-type=module', '-e', commandCapacityScript], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, NODE_ENV: 'test', KLYPIX_REMOTE_TEST_COMMAND_CACHE_LIMIT: '2',
      },
    },
  );
  let commandCapacityEvidence = null;
  try { commandCapacityEvidence = JSON.parse(commandCapacityRun.stdout); } catch { /* asserted below */ }
  ok(commandCapacityRun.status === 0
      && commandCapacityEvidence?.overflowOne === 'KLYPIX_REMOTE_COMMAND_RESOURCE_LIMIT'
      && commandCapacityEvidence.overflowTwo === 'KLYPIX_REMOTE_COMMAND_RESOURCE_LIMIT'
      && commandCapacityEvidence.firstOverflowCleaned
      && commandCapacityEvidence.secondOverflowCleaned
      && commandCapacityEvidence.retainedOldest
      && commandCapacityEvidence.retiredOldest === 'KLYPIX_REMOTE_ACTION_EVICTED'
      && commandCapacityEvidence.secondStable
      && commandCapacityEvidence.oldestRemoved
      && commandCapacityEvidence.admittedAlive,
  'keeps the command cache bounded and cleans rejected new snapshots when oldest-entry deletion fails');

  const tombstoneAgingScript = `
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const input = { machineId: 'm', provider: 'codex', externalSessionId: 's',
      operation: 'open-provider', capabilityReceiptId: 'r', bindingId: 'b' };
    const errorCode = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
    for (const identity of ['retired:a', 'retired:b', 'retired:c']) {
      buildRemoteCommand(input, 1000, identity);
      errorCode(() => buildRemoteCommand(input, 61000, identity));
    }
    const agedIdentity = errorCode(() => buildRemoteCommand(input, 62000, 'retired:a'));
    process.stdout.write(JSON.stringify({ agedIdentity }));
  `;
  const tombstoneAgingRun = spawnSync(
    process.execPath, ['--input-type=module', '-e', tombstoneAgingScript], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, NODE_ENV: 'test', KLYPIX_REMOTE_TEST_ACTION_TOMBSTONE_LIMIT: '2',
      },
    },
  );
  let tombstoneAgingEvidence = null;
  try { tombstoneAgingEvidence = JSON.parse(tombstoneAgingRun.stdout); } catch { /* asserted below */ }
  ok(tombstoneAgingRun.status === 0
      && tombstoneAgingEvidence?.agedIdentity === 'KLYPIX_REMOTE_ACTION_RETIRED',
  'keeps aged-out exact tombstones fail-closed in the bounded retired-action fingerprint filter');

  const exitCleanupScript = `
    import { buildRemoteCommand } from ${JSON.stringify(moduleUrl)};
    const command = buildRemoteCommand(${JSON.stringify(retryInput)}, 1000,
      'mcp-request:process-exit-cleanup', ${JSON.stringify(projectRoot)});
    process.stdout.write(command.payload.attachments[0].path);
  `;
  const exitCleanup = spawnSync(process.execPath, ['--input-type=module', '-e', exitCleanupScript], {
    encoding: 'utf8', timeout: 10_000,
  });
  ok(exitCleanup.status === 0 && exitCleanup.stdout.length > 0 && !fs.existsSync(exitCleanup.stdout),
    'removes the private snapshot root when the owning MCP process exits');
  let missingActionIdentity = false;
  try { buildRemoteCommand(retryInput, 1_000, undefined, projectRoot); }
  catch (error) { missingActionIdentity = error.message === 'KLYPIX_REMOTE_ACTION_IDENTITY_INVALID'; }
  ok(missingActionIdentity, 'fails closed when a Remote command has no MCP action identity');

  oversized = true;
  let tooLarge = false;
  try { await remoteStatus({ projectRoot, descriptorPath }); }
  catch (error) { tooLarge = error.message === 'KLYPIX_REMOTE_RESPONSE_TOO_LARGE'; }
  ok(tooLarge, 'rejects a chunked oversized response without Content-Length while streaming');
  await Promise.race([
    oversizedClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('oversized response transport was not cancelled')), 1_000)),
  ]);
  ok(oversizedWrites < 80, 'cancels the oversized response body before the server finishes sending it');
  oversized = false;

  fs.writeFileSync(descriptorPath, JSON.stringify({
    schema: 1, processId: 999_999_999, port, token: 'x'.repeat(43),
    instanceId: '11111111-1111-4111-8111-111111111111',
  }));
  let stale = false;
  try { readRemoteDescriptor(descriptorPath); } catch (error) { stale = error.message === 'KLYPIX_REMOTE_DESCRIPTOR_STALE'; }
  ok(stale, 'rejects a stale descriptor before making a request');
} finally {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`# ${pass} remote client checks passed`);
