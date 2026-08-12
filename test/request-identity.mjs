import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexToolActionId,
  consumeMessageReceipt,
  endSession,
  laneFileFor,
  listActiveSessions,
  postPresenceMessage,
  upsertSession,
} from '../src/agent-presence.mjs';
import {
  createMcpPresence,
  isLogicalTwin,
  resolveRequestIdentity,
} from '../src/mcp-presence.mjs';

process.env.KLYPIX_BRAIN_NO_MAIN = '1';
const { hookActionId } = await import('../src/codex-brain-hook.mjs');

const threadId = '019ff22f-d710-7093-b76b-14f0b1fad8e0';
const turnId = '019ff75c-efce-76e1-ad69-15d7e0384cf2';
const liveMeta = {
  _meta: {
    progressToken: 1,
    threadId,
    'x-codex-turn-metadata': {
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
    },
  },
  requestId: 7,
};

const actionArgs = { canvas: 'brain', question: 'current truth' };
const resolved = resolveRequestIdentity(liveMeta, {
  client: 'OpenAI Codex',
  toolName: 'brain_ask',
  toolInput: actionArgs,
});
assert.equal(resolved.ok, true);
assert.equal(resolved.id, threadId);
assert.equal(resolved.actionId, codexToolActionId({
  turnId,
  toolName: 'mcp__klypix_canvas__brain_ask',
  toolInput: { question: 'current truth', canvas: 'brain' },
}));
assert.equal(resolveRequestIdentity(liveMeta, {
  client: 'codex', toolName: 'brain_ask', toolInput: actionArgs,
}).actionId, resolved.actionId, 'MCP and lifecycle canonical tool spellings converge');
assert.notEqual(resolveRequestIdentity(liveMeta, {
  client: 'codex', toolName: 'brain_note', toolInput: actionArgs,
}).actionId, resolved.actionId, 'a distinct later tool in the same turn can advance delivery');
assert.equal(hookActionId({
  turn_id: turnId,
  tool_use_id: 'hook-only-id',
  tool_name: 'mcp__klypix_canvas__brain_ask',
  tool_input: { question: 'current truth', canvas: 'brain' },
}, 'PreToolUse'), resolved.actionId, 'PreToolUse and MCP use one shared action identity');
assert.equal(hookActionId({
  turn_id: turnId,
  tool_use_id: 'hook-only-id',
  tool_name: 'mcp__klypix_canvas__brain_ask',
  tool_input: { canvas: 'brain', question: 'current truth' },
}, 'PostToolUse'), resolved.actionId, 'PostToolUse and MCP use one shared action identity');

const stringMetadata = resolveRequestIdentity({
  _meta: {
    threadId,
    'x-codex-turn-metadata': JSON.stringify({ session_id: threadId, thread_id: threadId, turn_id: turnId }),
  },
}, { client: 'codex' });
assert.equal(stringMetadata.id, threadId, 'JSON-encoded host metadata is accepted');

const mismatch = resolveRequestIdentity({
  _meta: {
    threadId,
    'x-codex-turn-metadata': { session_id: '019ff22f-d710-7093-b76b-14f0b1fad8e0', thread_id: 'different-thread' },
  },
}, { client: 'codex' });
assert.equal(mismatch.ok, false);
assert.equal(mismatch.status, 'mismatch');

const invalid = resolveRequestIdentity({ _meta: { threadId: 'bad id with spaces' } }, { client: 'codex' });
assert.equal(invalid.ok, false);
assert.equal(invalid.status, 'invalid');

const turnOnly = resolveRequestIdentity({
  _meta: { 'x-codex-turn-metadata': { turn_id: turnId } },
}, { client: 'codex' });
assert.equal(turnOnly.ok, true);
assert.equal(turnOnly.id, null, 'turn_id is never promoted to logical identity');
assert.equal(turnOnly.actionId, `codex-turn:${turnId}`);

const ignored = resolveRequestIdentity(liveMeta, { client: 'antigravity' });
assert.equal(ignored.ok, true);
assert.equal(ignored.id, null, 'Codex-specific keys are ignored for other clients');

assert.equal(isLogicalTwin(
  { id: 'one', hostPid: 42 },
  { id: 'two', hostPid: 42 },
), false, 'a shared host pid never suppresses an independent session');
assert.equal(isLogicalTwin(
  { id: 'one', hostPid: 42, logicalSessionId: threadId },
  { id: 'two', hostPid: 42, logicalSessionId: threadId },
), true, 'only an explicit logical-session id may pair rows');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-request-identity-'));
try {
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, 'brain.klypix'), 'test');
  const server = {
    server: { getClientVersion: () => ({ name: 'OpenAI Codex' }) },
    notices: [],
    sendLoggingMessage(message) { this.notices.push(message); },
  };
  const presence = createMcpPresence({
    server,
    initialVault: project,
    home,
    env: { KLYPIX_MCP_CONNECTION_ID: 'mcp-connection-one' },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  presence.start(project);
  assert.equal(presence.id, 'mcp-connection-one');

  const adopted = presence.adoptRequestIdentity(liveMeta);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.status, 'adopted');
  assert.equal(presence.id, threadId);
  presence.sync({ phase: 'start', intent: 'first task', files: ['old-file.mjs'] });
  presence.sync({ phase: 'start', intent: 'next task' });

  const [row] = listActiveSessions({ brainPath: path.join(project, 'brain.klypix'), home })
    .filter((session) => session.id === threadId);
  assert.ok(row, 'the provisional connection row was atomically rekeyed');
  assert.equal(row.logicalSessionId, threadId);
  assert.equal(row.identitySource, 'mcp-request');
  assert.deepEqual(row.files, [], 'phase:start with omitted files clears prior scope');

  const brainPath = path.join(project, 'brain.klypix');
  upsertSession({
    brainPath,
    id: 'sender-session',
    client: 'claude-code',
    channel: 'lifecycle',
    event: 'UserPromptSubmit',
    home,
  });
  const posted = postPresenceMessage({
    brainPath,
    from: 'sender-session',
    to: threadId,
    text: 'Coordinate this change.',
    home,
  });
  assert.equal(posted.posted, true);
  const offered = presence.sync({ phase: 'checkpoint', actionId: 'codex-turn:offer' });
  assert.equal(offered.structured.messages.length, 1);
  assert.equal(offered.structured.messages[0].deliveryState, 'offered');
  assert.ok(offered.structured.messages[0].offerToken, 'sync exposes only this recipient\'s exact offer token');
  const offerToken = offered.structured.messages[0].offerToken;
  presence.sync({ phase: 'checkpoint', actionId: 'codex-turn:acknowledge' });
  assert.equal(consumeMessageReceipt({
    brainPath,
    sessionId: threadId,
    messageId: posted.message.id,
    offerToken,
    home,
    actionId: 'codex-turn:consume',
  }).status, 'consumed');

  const rejected = presence.adoptRequestIdentity({
    _meta: {
      threadId,
      'x-codex-turn-metadata': { session_id: 'another-thread', thread_id: threadId },
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(presence.id, threadId, 'a mismatch cannot mutate the adopted identity');

  // SessionEnd(A) followed by request metadata for B is a fresh identity
  // rotation. It must not rekey A's scope, messages, or authorship onto B.
  const ended = endSession({ brainPath, id: threadId, home });
  assert.equal(ended.ok, true);
  const nextThread = '019ff22f-d710-7093-b76b-14f0b1fad8e1';
  const rotated = presence.adoptRequestIdentity({
    _meta: {
      threadId: nextThread,
      'x-codex-turn-metadata': {
        session_id: nextThread,
        thread_id: nextThread,
        turn_id: 'new-turn',
      },
    },
  }, { toolName: 'brain_sync', toolInput: { phase: 'start' } });
  assert.equal(rotated.status, 'rotated-after-end');
  assert.equal(presence.id, nextThread);
  const afterRotation = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  const nextRow = afterRotation.sessions.find((session) => session.id === nextThread);
  assert.ok(nextRow, 'B gets a fresh owned MCP row');
  assert.equal(nextRow.intent, '');
  assert.deepEqual(nextRow.files, []);
  assert(!nextRow.aliases?.includes(threadId));
  assert(afterRotation.endedSessions.some((entry) => entry.id === threadId), 'A tombstone remains');
  const authored = afterRotation.messages.find((message) => message.id === posted.message.id);
  assert.equal(authored.to, threadId, 'A-targeted message is not retargeted to B');
  assert.deepEqual(authored.candidateIds, [threadId]);
  presence.stop();

  // Adversarial lifecycle ordering: B's first exact MCP request can arrive
  // before SessionEnd(A). This is a fresh transport switch, never a rekey of
  // A's already-exact logical identity.
  const earlyPresence = createMcpPresence({
    server,
    initialVault: project,
    home,
    env: { KLYPIX_MCP_CONNECTION_ID: 'mcp-live-switch-connection' },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  earlyPresence.start(project);
  const earlyA = '019ff22f-d710-7093-b76b-14f0b1fad8a0';
  const earlyB = '019ff22f-d710-7093-b76b-14f0b1fad8b0';
  assert.equal(earlyPresence.adoptRequestIdentity({
    _meta: {
      threadId: earlyA,
      'x-codex-turn-metadata': { session_id: earlyA, thread_id: earlyA, turn_id: 'early-turn-a' },
    },
  }, { toolName: 'brain_sync', toolInput: { phase: 'start' } }).status, 'adopted');
  earlyPresence.sync({
    phase: 'start', intent: 'A private scope', files: ['src/a-private.mjs'], actionId: 'early-a-start',
  });
  // Keep A's lifecycle half live so the switch must preserve its own row while
  // detaching only this worker's MCP channel.
  upsertSession({
    brainPath, home, id: earlyA, client: 'codex', channel: 'lifecycle',
    event: 'UserPromptSubmit', logicalSessionId: earlyA, identitySource: 'codex-lifecycle',
  });
  // Simulate a stale/pre-fix alias collision: the exact destination id must
  // still become independent and be removed from A's alias set.
  const poisonedLane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  poisonedLane.sessions.find((session) => session.id === earlyA).aliases.push(earlyB);
  fs.writeFileSync(laneFileFor(brainPath, home), JSON.stringify(poisonedLane));
  const aTargeted = postPresenceMessage({
    brainPath, home, from: 'sender-session', to: earlyA, text: 'Only conversation A may receive this.',
  });
  const aAuthored = postPresenceMessage({
    brainPath, home, from: earlyA, to: 'sender-session', text: 'Authored by conversation A.',
  });
  assert.equal(aTargeted.posted, true);
  assert.equal(aAuthored.posted, true);

  const switched = earlyPresence.adoptRequestIdentity({
    _meta: {
      threadId: earlyB,
      'x-codex-turn-metadata': { session_id: earlyB, thread_id: earlyB, turn_id: 'early-turn-b' },
    },
  }, { toolName: 'brain_sync', toolInput: { phase: 'start' } });
  assert.equal(switched.status, 'switched-live-session');
  assert.equal(earlyPresence.id, earlyB);
  const switchedLane = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
  const retainedA = switchedLane.sessions.find((session) => session.id === earlyA);
  const freshB = switchedLane.sessions.find((session) => session.id === earlyB);
  assert.ok(retainedA, 'A remains present through its independently live lifecycle channel');
  assert.deepEqual(retainedA.channels, ['lifecycle']);
  assert.equal(retainedA.intent, 'A private scope');
  assert.deepEqual(retainedA.files, ['src/a-private.mjs']);
  assert(!retainedA.aliases?.includes(earlyB), 'A no longer aliases the new exact B identity');
  assert.ok(freshB, 'B gets a fresh MCP-owned logical row');
  assert.equal(freshB.intent, '');
  assert.deepEqual(freshB.files, []);
  assert(!freshB.aliases?.includes(earlyA), 'B never aliases A');
  const stillTargetedToA = switchedLane.messages.find((message) => message.id === aTargeted.message.id);
  const stillAuthoredByA = switchedLane.messages.find((message) => message.id === aAuthored.message.id);
  assert.equal(stillTargetedToA.to, earlyA);
  assert.deepEqual(stillTargetedToA.candidateIds, [earlyA]);
  assert.equal(stillAuthoredByA.from, earlyA);

  // A shared worker can outlive SessionEnd(B). Its best-effort logging poll is
  // read-only, but it must also be identity-safe: no B-only note may be previewed
  // after B's live row is gone and before the next thread adopts itself.
  const bOnly = postPresenceMessage({
    brainPath, home, from: 'sender-session', to: earlyB, text: 'Only ended conversation B may receive this.',
  });
  assert.equal(bOnly.posted, true);
  assert.equal(endSession({ brainPath, id: earlyB, home }).ok, true);
  server.notices.length = 0;
  assert.deepEqual(earlyPresence.pollInbox(), []);
  assert.deepEqual(server.notices, [], 'an ended/non-live identity produces no MCP logging preview');
  earlyPresence.stop();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('request identity tests passed');
