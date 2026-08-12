import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acknowledgeMessages,
  consumeMessageReceipt,
  endSession,
  laneFileFor,
  listActiveSessions,
  postPresenceMessage,
  purgeRemotePresence,
  rekeySessionIdentity,
  removeSession,
  resolveMessageTargetIds,
  shortestUniqueSessionPrefix,
  switchMcpSessionIdentity,
  upsertSession,
  receiveMessages,
  rotateEndedSessionIdentity,
  upsertRemoteSessions,
} from '../src/agent-presence.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-identity-core-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');
const now = 2_100_000_000_000;

try {
  upsertSession({
    brainPath, home, now, id: 'mcp-provisional-transport', client: 'codex',
    channel: 'mcp', event: 'McpTaskStart', intent: 'MCP scope', files: ['src/mcp.mjs'],
    identitySource: 'provisional',
  });
  upsertSession({
    brainPath, home, now: now + 1, id: '019ff22f-d710-7093-b76b-14f0b1fad8e0', client: 'codex',
    channel: 'lifecycle', event: 'UserPromptSubmit', intent: 'Lifecycle scope',
    files: ['src/hook.mjs'], branch: 'feature/exact-target',
    logicalSessionId: '019ff22f-d710-7093-b76b-14f0b1fad8e0', identitySource: 'hook',
  });
  assert.equal(listActiveSessions({ brainPath, home, now: now + 2 })
    .find((row) => row.id === 'mcp-provisional-transport')?.logicalSessionId, null,
  'a transport-generated id is visible but never mislabeled as exact logical identity');
  upsertSession({
    brainPath, home, now: now + 2, id: 'sender-session-0001', client: 'claude-code',
    channel: 'lifecycle', branch: 'sender', intent: 'Sender',
  });

  const inbound = postPresenceMessage({
    brainPath, home, now: now + 3, from: 'sender-session-0001', to: 'mcp-provisional-transport', text: 'inbound',
  });
  const outbound = postPresenceMessage({
    brainPath, home, now: now + 4, from: 'mcp-provisional-transport', to: 'all', text: 'outbound',
  });
  assert.equal(inbound.message.candidateIds[0], 'mcp-provisional-transport');

  const denied = rekeySessionIdentity({
    brainPath, home, now: now + 5, fromId: 'mcp-provisional-transport',
    toId: '019ff22f-d710-7093-b76b-14f0b1fad8e0', expectedPid: process.pid + 1,
  });
  assert.deepEqual({ ok: denied.ok, changed: denied.changed, reason: denied.reason },
    { ok: false, changed: false, reason: 'owner-mismatch' });

  const adopted = rekeySessionIdentity({
    brainPath, home, now: now + 6, fromId: 'mcp-provisional-transport',
    toId: '019ff22f-d710-7093-b76b-14f0b1fad8e0', expectedPid: process.pid,
  });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.changed, true);
  const sessions = listActiveSessions({ brainPath, home, now: now + 6 });
  const logical = sessions.find((row) => row.id === '019ff22f-d710-7093-b76b-14f0b1fad8e0');
  assert.equal(sessions.filter((row) => row.id !== 'sender-session-0001').length, 1);
  assert.deepEqual(new Set(logical.channels), new Set(['mcp', 'lifecycle']));
  assert.deepEqual(new Set(logical.files), new Set(['src/mcp.mjs', 'src/hook.mjs']));
  assert.equal(logical.logicalSessionId, logical.id);
  assert(logical.aliases.includes('mcp-provisional-transport'));

  const laneFile = laneFileFor(brainPath, home);
  let lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const rewrittenInbound = lane.messages.find((message) => message.id === inbound.message.id);
  const rewrittenOutbound = lane.messages.find((message) => message.id === outbound.message.id);
  assert.equal(rewrittenInbound.to, logical.id);
  assert.deepEqual(rewrittenInbound.candidateIds, [logical.id]);
  assert(rewrittenInbound.deliveries.some((delivery) => delivery.recipientId === logical.id));
  assert.equal(rewrittenOutbound.from, logical.id);

  assert.deepEqual(resolveMessageTargetIds({ to: 'mcp-provisional-transport' }, sessions), [logical.id]);
  assert.deepEqual(resolveMessageTargetIds({ to: 'feature/exact-target' }, sessions), [logical.id]);
  assert.deepEqual(resolveMessageTargetIds({ to: 'codex' }, sessions), []);
  assert.equal(shortestUniqueSessionPrefix(sessions, logical.id).length >= 8, true);

  upsertSession({
    brainPath, home, now: now + 6, id: 'ambiguous-branch-peer', client: 'codex',
    channel: 'mcp', branch: 'feature/exact-target', logicalSessionId: 'ambiguous-branch-peer',
  });
  const refusedAmbiguous = postPresenceMessage({
    brainPath, home, now: now + 6, from: 'sender-session-0001',
    to: 'feature/exact-target', text: 'must fail closed',
  });
  assert.deepEqual({ posted: refusedAmbiguous.posted, reason: refusedAmbiguous.reason },
    { posted: false, reason: 'target-not-unique' });

  // Per-channel owner beats the legacy row-level pid fallback.
  lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const stored = lane.sessions.find((row) => row.id === logical.id);
  stored.pid = process.pid + 99;
  stored.channelOwners.mcp = process.pid;
  stored.channelOwners.lifecycle = process.pid + 1;
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const afterMcpClose = removeSession({
    brainPath, home, now: now + 7, id: logical.id, channel: 'mcp', expectedPid: process.pid,
  });
  assert.equal(afterMcpClose.laneWriteOk, true);
  assert.deepEqual(afterMcpClose.find((row) => row.id === logical.id).channels, ['lifecycle']);

  const ended = endSession({ brainPath, home, now: now + 8, id: logical.id });
  assert.deepEqual({ ok: ended.ok, changed: ended.changed }, { ok: true, changed: true });
  const ghost = upsertSession({
    brainPath, home, now: now + 9, id: logical.id, channel: 'mcp', event: 'McpHibernated',
  });
  assert.equal(ghost.laneWriteOk, false);
  assert.equal(ghost.laneWriteSkippedReason, 'session-ended');
  assert(!listActiveSessions({ brainPath, home, now: now + 9 }).some((row) => row.id === logical.id));

  upsertSession({
    brainPath, home, now: now + 10, id: logical.id, channel: 'mcp', event: 'McpTaskStart',
  });
  let revived = listActiveSessions({ brainPath, home, now: now + 10 }).find((row) => row.id === logical.id);
  assert.equal(revived.scopeGeneration, 1);
  assert.equal(revived.scopeStartedAt, now + 10);
  assert.equal(revived.completedAt, null);
  upsertSession({
    brainPath, home, now: now + 11, id: logical.id, channel: 'mcp', event: 'McpTaskComplete',
  });
  revived = listActiveSessions({ brainPath, home, now: now + 11 }).find((row) => row.id === logical.id);
  assert.equal(revived.completedAt, now + 11);

  // Every core mutator must distinguish a missing first-use lane from corrupt
  // existing bytes. No operation may overwrite corruption or report success.
  const corruptBytes = '{"sessions": [broken';
  fs.writeFileSync(laneFile, corruptBytes);
  const corruptCases = [
    ['upsert', upsertSession({ brainPath, home, now: now + 20, id: 'corrupt-new', channel: 'mcp' }), 'laneWriteOk'],
    ['remove', removeSession({ brainPath, home, now: now + 21, id: 'corrupt-new' }), 'laneWriteOk'],
    ['end', endSession({ brainPath, home, now: now + 22, id: 'corrupt-new' }), 'ok'],
    ['rekey', rekeySessionIdentity({ brainPath, home, now: now + 23, fromId: 'a', toId: 'b' }), 'ok'],
    ['rotate', rotateEndedSessionIdentity({ brainPath, home, now: now + 23, fromId: 'a', toId: 'b' }), 'ok'],
    ['switch', switchMcpSessionIdentity({ brainPath, home, now: now + 23, fromId: 'a', toId: 'b' }), 'ok'],
    ['remote-upsert', upsertRemoteSessions({ brainPath, home, now: now + 23, rows: [{ id: 'remote', machine: 'other', via: 'cloud' }] }), 'laneWriteOk'],
    ['remote-purge', purgeRemotePresence({ brainPath, home, now: now + 23 }), 'laneWriteOk'],
    ['receive', receiveMessages({ brainPath, home, now: now + 24, sessionId: 'b', actionId: 'x' }), 'deliveryWriteOk'],
    ['acknowledge', acknowledgeMessages({ brainPath, home, now: now + 24, sessionId: 'b', messageIds: ['m'], actionId: 'x' }), 'deliveryWriteOk'],
    ['consume', consumeMessageReceipt({ brainPath, home, now: now + 24, sessionId: 'b', messageId: 'm', offerToken: 'token', actionId: 'x' }), 'ok'],
    ['post', postPresenceMessage({ brainPath, home, now: now + 25, from: 'a', to: 'all', text: 'do not overwrite' }), 'posted'],
  ];
  for (const [label, result, successKey] of corruptCases) {
    assert.equal(result[successKey], false, `${label} fails closed on corrupt lane`);
    assert.match(String(result.reason || result.laneWriteSkippedReason || result.deliveryWriteSkippedReason), /^lane-corrupt:/);
    assert.equal(fs.readFileSync(laneFile, 'utf8'), corruptBytes, `${label} leaves corrupt bytes unchanged`);
  }

  console.log('[ok] atomic session identity, targeting, ownership, tombstone, and scope lifecycle');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
