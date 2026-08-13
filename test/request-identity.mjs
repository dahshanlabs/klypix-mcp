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
  messageDeliveryState,
  postPresenceMessage,
  upsertSession,
} from '../src/agent-presence.mjs';
import {
  createMcpPresence,
  isLogicalTwin,
  resultClaimMarkerFileFor,
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

  // The lifecycle writer commits hostmap before lane. During that narrow
  // sidecar-ahead window, a shared Claude worker must not treat "B is not yet
  // adoptable" as "keep operating as A". Every pre-handler gate defers, while
  // heartbeat and logging poll remain read-only and A's note stays pending.
  const sidecarProject = path.join(temp, 'sidecar-project');
  fs.mkdirSync(sidecarProject, { recursive: true });
  const sidecarBrain = path.join(sidecarProject, 'brain.klypix');
  fs.writeFileSync(sidecarBrain, 'test');
  const sidecarNow = 2_300_000_000_000;
  const sidecarA = 'claude-sidecar-session-a';
  const sidecarB = 'claude-sidecar-session-b';
  const sidecarHostPid = 515151;
  let failDestinationClaimMigration = false;
  const claudeServer = {
    server: { getClientVersion: () => ({ name: 'Claude Code' }) },
    notices: [],
    sendLoggingMessage(message) { this.notices.push(message); },
  };
  const sidecarPresence = createMcpPresence({
    server: claudeServer,
    initialVault: sidecarProject,
    home,
    now: () => sidecarNow,
    env: { KLYPIX_SESSION_ID: sidecarA, KLYPIX_HOST_PID: String(sidecarHostPid) },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    markResultClaimPendingFn: (options) => {
      if (failDestinationClaimMigration && options.sessionId === sidecarB) {
        return { ok: false, pending: true, reason: 'injected-durable-write-failure' };
      }
      const file = resultClaimMarkerFileFor(options.brainPath, options.sessionId, options.home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessionId: options.sessionId }), { flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      return { ok: true, pending: true, file };
    },
  });
  sidecarPresence.start(sidecarProject);
  upsertSession({
    brainPath: sidecarBrain, home, now: sidecarNow, id: 'sidecar-sender',
    client: 'codex', channel: 'mcp', event: 'McpTaskStart',
  });
  const sidecarNote = postPresenceMessage({
    brainPath: sidecarBrain, home, now: sidecarNow,
    from: 'sidecar-sender', to: sidecarA, text: 'This belongs only to A.',
  });
  assert.equal(sidecarNote.posted, true);
  const sidecarLaneFile = laneFileFor(sidecarBrain, home);
  const sidecarHostmap = sidecarLaneFile.replace(/\.json$/, '.hostmap');
  fs.writeFileSync(sidecarHostmap, JSON.stringify({
    [sidecarHostPid]: { sessionId: sidecarB, ts: sidecarNow },
  }));
  const beforeDeferredActions = fs.readFileSync(sidecarLaneFile, 'utf8');
  for (const toolName of ['brain_sync', 'brain_message', 'remote_status']) {
    const deferred = sidecarPresence.adoptRequestIdentity({}, { toolName, toolInput: {} });
    assert.deepEqual(
      { ok: deferred.ok, status: deferred.status, id: deferred.id },
      { ok: false, status: 'sidecar-ahead', id: null },
      `${toolName} fails before its handler while lifecycle B is only staged`,
    );
  }
  const deferredHeartbeat = sidecarPresence.touch();
  assert.equal(deferredHeartbeat.laneWriteOk, false);
  assert.equal(deferredHeartbeat.laneWriteSkippedReason, 'identity-sidecar-ahead');
  assert.deepEqual(sidecarPresence.pollInbox(), []);
  assert.deepEqual(claudeServer.notices, []);
  assert.equal(sidecarPresence.id, sidecarA);
  assert.equal(fs.readFileSync(sidecarLaneFile, 'utf8'), beforeDeferredActions,
    'sidecar-ahead actions, heartbeat, and poll leave presence and delivery bytes unchanged');
  const stillPending = JSON.parse(beforeDeferredActions).messages
    .find((message) => message.id === sidecarNote.message.id);
  assert.equal(messageDeliveryState(stillPending, sidecarA), 'pending');

  upsertSession({
    brainPath: sidecarBrain, home, now: sidecarNow, id: sidecarB,
    client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', hostPid: sidecarHostPid,
  });
  const sourceClaim = resultClaimMarkerFileFor(sidecarBrain, sidecarA, home);
  const destinationClaim = resultClaimMarkerFileFor(sidecarBrain, sidecarB, home);
  fs.writeFileSync(sourceClaim, JSON.stringify({ schemaVersion: 1, sessionId: sidecarA }));
  failDestinationClaimMigration = true;
  const beforeFailedClaimMigration = fs.readFileSync(sidecarLaneFile, 'utf8');
  const migrationBlocked = sidecarPresence.adoptRequestIdentity({}, { toolName: 'brain_sync', toolInput: {} });
  assert.deepEqual(
    { ok: migrationBlocked.ok, status: migrationBlocked.status, id: migrationBlocked.id },
    { ok: false, status: 'result-claim-migration-failed', id: null },
    'hostmap adoption fails closed when its durable result-claim marker cannot migrate',
  );
  assert.equal(sidecarPresence.id, sidecarA, 'failed claim migration keeps the prior logical identity');
  assert.equal(fs.readFileSync(sidecarLaneFile, 'utf8'), beforeFailedClaimMigration,
    'failed claim migration leaves the presence lane byte-for-byte unchanged');
  assert.equal(fs.statSync(sourceClaim).isFile(), true, 'failed migration retains the source completion obligation');
  assert.equal(fs.existsSync(destinationClaim), false, 'failed migration never invents a destination sentinel');
  const beforeDirectSyncMigration = fs.readFileSync(sidecarLaneFile, 'utf8');
  const directSyncBlocked = sidecarPresence.sync({
    project: sidecarProject,
    phase: 'start',
    intent: 'must stop before result or task mutation',
    files: ['blocked.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(directSyncBlocked.isError, true);
  assert.equal(directSyncBlocked.structured.status, 'result-claim-migration-failed');
  assert.equal(directSyncBlocked.structured.mutation, 'none');
  assert.equal(directSyncBlocked.structured.identityMutation, 'none');
  assert.equal(sidecarPresence.id, sidecarA);
  assert.equal(fs.readFileSync(sidecarLaneFile, 'utf8'), beforeDirectSyncMigration,
    'direct sync gates failed hostmap adoption before task/result/lane mutation');
  assert.equal(fs.existsSync(destinationClaim), false,
    'direct sync cannot create result evidence state under B when adoption migration failed');
  failDestinationClaimMigration = false;
  const ready = sidecarPresence.adoptRequestIdentity({}, { toolName: 'brain_sync', toolInput: {} });
  assert.equal(ready.ok, true, 'the pre-handler gate reopens once exact lifecycle B is live');
  assert.equal(sidecarPresence.id, sidecarB, 'normal hostmap adoption resumes after the lifecycle commit');
  assert.equal(fs.statSync(destinationClaim).isFile(), true, 'successful adoption lands the destination result-claim marker first');
  assert.equal(fs.existsSync(sourceClaim), false, 'successful adoption clears the old marker after durable migration');
  const afterSidecarCommit = JSON.parse(fs.readFileSync(sidecarLaneFile, 'utf8'));
  const retainedNote = afterSidecarCommit.messages.find((message) => message.id === sidecarNote.message.id);
  assert.equal(messageDeliveryState(retainedNote, sidecarA), 'pending');
  assert.deepEqual(sidecarPresence.pollInbox(), [], 'B never previews A\'s pending inbox after adoption');
  sidecarPresence.stop();

  // An explicit project switch is one transaction. Target identity readiness
  // must be proven while source A is still fully bound; neither sidecar-ahead
  // nor a failed destination marker may stop A, alter either lane, or change
  // worker identity. A's pending result obligation also remains project-local:
  // a checkpoint switch to B rebases from B's marker, so B can complete cleanly
  // without erasing A's still-required evidence. A successful retry detaches A
  // by its captured id and lands on B without a second fallible hostmap check.
  const crossSourceProject = path.join(temp, 'cross-source-project');
  const crossTargetProject = path.join(temp, 'cross-target-project');
  fs.mkdirSync(crossSourceProject, { recursive: true });
  fs.mkdirSync(crossTargetProject, { recursive: true });
  const crossSourceBrain = path.join(crossSourceProject, 'brain.klypix');
  const crossTargetBrain = path.join(crossTargetProject, 'brain.klypix');
  fs.writeFileSync(crossSourceBrain, 'source');
  fs.writeFileSync(crossTargetBrain, 'target');
  const crossA = 'claude-cross-project-a';
  const crossB = 'claude-cross-project-b';
  let failCrossDestination = false;
  const crossPresence = createMcpPresence({
    server: claudeServer,
    initialVault: crossSourceProject,
    home,
    now: () => sidecarNow,
    env: { KLYPIX_SESSION_ID: crossA, KLYPIX_HOST_PID: String(sidecarHostPid) },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    markResultClaimPendingFn: (options) => {
      if (failCrossDestination
        && options.brainPath === crossTargetBrain
        && options.sessionId === crossB) {
        return { ok: false, pending: true, reason: 'injected-cross-project-write-failure' };
      }
      const file = resultClaimMarkerFileFor(options.brainPath, options.sessionId, options.home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessionId: options.sessionId }), { flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      return { ok: true, pending: true, file };
    },
  });
  crossPresence.start(crossSourceProject);
  const crossSourceLane = laneFileFor(crossSourceBrain, home);
  const crossTargetLane = laneFileFor(crossTargetBrain, home);
  const crossProjectAClaim = resultClaimMarkerFileFor(crossSourceBrain, crossA, home);
  const sourceMalformed = crossPresence.sync({
    project: crossSourceProject,
    phase: 'checkpoint',
    intent: 'retain malformed evidence obligation only in source A',
    files: ['src/source-result.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(sourceMalformed.isError, true);
  assert.equal(sourceMalformed.structured.resultReconciliation?.status, 'needs-reconciliation');
  assert.equal(fs.existsSync(crossProjectAClaim), true,
    'source A starts with a durable pending result obligation');
  const crossTargetHostmap = crossTargetLane.replace(/\.json$/, '.hostmap');
  fs.writeFileSync(crossTargetHostmap, JSON.stringify({
    [sidecarHostPid]: { sessionId: crossB, ts: sidecarNow },
  }));
  const laneBytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const sourceBeforeAhead = laneBytes(crossSourceLane);
  const targetBeforeAhead = laneBytes(crossTargetLane);
  const crossAhead = crossPresence.sync({
    project: crossTargetProject,
    phase: 'start',
    intent: 'must not detach source while target lifecycle is staged',
    files: ['src/cross-ahead.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(crossAhead.isError, true);
  assert.equal(crossAhead.structured.status, 'sidecar-ahead');
  assert.deepEqual(
    {
      mutation: crossAhead.structured.mutation,
      identityMutation: crossAhead.structured.identityMutation,
      deliveryMutation: crossAhead.structured.deliveryMutation,
    },
    { mutation: 'none', identityMutation: 'none', deliveryMutation: 'none' },
  );
  assert.equal(crossPresence.id, crossA);
  assert.equal(crossPresence.brainPath, crossSourceBrain);
  assert.equal(crossPresence.vault, crossSourceProject);
  assert.equal(laneBytes(crossSourceLane), sourceBeforeAhead);
  assert.equal(laneBytes(crossTargetLane), targetBeforeAhead);
  assert.equal(fs.existsSync(crossProjectAClaim), true,
    'sidecar-ahead target rejection preserves source A result state');

  upsertSession({
    brainPath: crossTargetBrain,
    home,
    now: sidecarNow,
    id: crossB,
    client: 'claude-code',
    channel: 'lifecycle',
    event: 'UserPromptSubmit',
    hostPid: sidecarHostPid,
  });
  const crossTargetSourceClaim = resultClaimMarkerFileFor(crossTargetBrain, crossA, home);
  const crossDestinationClaim = resultClaimMarkerFileFor(crossTargetBrain, crossB, home);
  failCrossDestination = true;
  const sourceBeforeMigrationFailure = laneBytes(crossSourceLane);
  const targetBeforeMigrationFailure = laneBytes(crossTargetLane);
  const crossMigrationBlocked = crossPresence.sync({
    project: crossTargetProject,
    phase: 'start',
    intent: 'must precommit the target result obligation before switching',
    files: ['src/cross-marker.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(crossMigrationBlocked.isError, true);
  assert.equal(crossMigrationBlocked.structured.status, 'result-claim-migration-failed');
  assert.deepEqual(
    {
      mutation: crossMigrationBlocked.structured.mutation,
      identityMutation: crossMigrationBlocked.structured.identityMutation,
      deliveryMutation: crossMigrationBlocked.structured.deliveryMutation,
    },
    { mutation: 'none', identityMutation: 'none', deliveryMutation: 'none' },
  );
  assert.equal(crossPresence.id, crossA);
  assert.equal(crossPresence.brainPath, crossSourceBrain);
  assert.equal(crossPresence.vault, crossSourceProject);
  assert.equal(laneBytes(crossSourceLane), sourceBeforeMigrationFailure);
  assert.equal(laneBytes(crossTargetLane), targetBeforeMigrationFailure);
  assert.equal(fs.existsSync(crossProjectAClaim), true);
  assert.equal(fs.existsSync(crossTargetSourceClaim), false);
  assert.equal(fs.existsSync(crossDestinationClaim), false);

  failCrossDestination = false;
  const crossReady = crossPresence.sync({
    project: crossTargetProject,
    phase: 'checkpoint',
    intent: 'route the live connection to target B',
    files: ['src/cross-ready.mjs'],
  });
  assert.equal(crossReady.isError, false);
  assert.equal(crossPresence.id, crossB);
  assert.equal(crossPresence.brainPath, crossTargetBrain);
  assert.equal(crossPresence.vault, crossTargetProject);
  const crossSourceSessions = JSON.parse(fs.readFileSync(crossSourceLane, 'utf8')).sessions;
  assert.equal(crossSourceSessions.some((session) => session.id === crossA
    && session.channels?.includes('mcp')), false,
  'successful cross-project commit detaches source A using its captured pre-adoption identity');
  const crossTargetSession = JSON.parse(fs.readFileSync(crossTargetLane, 'utf8')).sessions
    .find((session) => session.id === crossB);
  assert.equal(crossTargetSession?.channels?.includes('lifecycle'), true);
  assert.equal(crossTargetSession?.channels?.includes('mcp'), true);
  assert.deepEqual(crossTargetSession?.files, ['src/cross-ready.mjs']);
  assert.equal(fs.existsSync(crossProjectAClaim), true,
    'checkpoint switching to B preserves A\'s pending marker on A');
  assert.equal(fs.existsSync(crossTargetSourceClaim), false);
  assert.equal(fs.existsSync(crossDestinationClaim), false,
    'checkpoint switching to B does not synthesize a B result obligation from worker-global A state');
  const crossTargetComplete = crossPresence.sync({
    project: crossTargetProject,
    phase: 'complete',
  });
  assert.equal(crossTargetComplete.isError, false);
  assert.equal(crossTargetComplete.structured.status, 'complete');
  assert.equal(fs.existsSync(crossProjectAClaim), true,
    'completing B leaves unresolved source A evidence durable for a later A retry');
  assert.equal(fs.existsSync(crossDestinationClaim), false,
    'B completes without a false result-manifest-required obligation');
  crossPresence.stop();

  // The host client-version callback is outside KLYPIX control. If it retargets
  // the exact project directory after authorization, the final binding guard
  // rejects before task/result/presence mutation; the pre-pinned lane identity
  // also makes it impossible for laneFileFor to hash the foreign target.
  const callbackTarget = path.join(temp, 'callback-target');
  const callbackForeign = path.join(temp, 'callback-foreign');
  const callbackProject = path.join(temp, 'callback-project-link');
  fs.mkdirSync(callbackTarget, { recursive: true });
  fs.mkdirSync(callbackForeign, { recursive: true });
  fs.writeFileSync(path.join(callbackTarget, 'brain.klypix'), 'callback-target');
  fs.writeFileSync(path.join(callbackForeign, 'brain.klypix'), 'callback-foreign');
  fs.symlinkSync(callbackTarget, callbackProject, process.platform === 'win32' ? 'junction' : 'dir');
  let swapDuringClientVersion = false;
  const callbackServer = {
    server: {
      getClientVersion() {
        if (swapDuringClientVersion) {
          swapDuringClientVersion = false;
          fs.rmSync(callbackProject, { force: true });
          fs.symlinkSync(callbackForeign, callbackProject, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return { name: 'Claude Code' };
      },
    },
    sendLoggingMessage() {},
  };
  const callbackPresence = createMcpPresence({
    server: callbackServer,
    initialVault: crossSourceProject,
    home,
    now: () => sidecarNow,
    env: { KLYPIX_SESSION_ID: 'callback-session' },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  const callbackTargetBrain = path.join(callbackTarget, 'brain.klypix');
  const callbackForeignBrain = path.join(callbackForeign, 'brain.klypix');
  const callbackTargetLane = laneFileFor(callbackTargetBrain, home);
  const callbackForeignLane = laneFileFor(callbackForeignBrain, home);
  const callbackTargetBefore = laneBytes(callbackTargetLane);
  const callbackForeignBefore = laneBytes(callbackForeignLane);
  swapDuringClientVersion = true;
  const callbackRejected = callbackPresence.sync({
    project: callbackProject,
    phase: 'start',
    intent: 'reject a project swap inside getClientVersion',
    files: ['src/callback-swap.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(callbackRejected.isError, true);
  assert.equal(callbackRejected.structured.status, 'project-changed');
  assert.equal(callbackRejected.structured.mutation, 'none');
  assert.equal(callbackRejected.structured.identityMutation, 'none');
  assert.equal(callbackPresence.brainPath, null);
  assert.equal(laneBytes(callbackTargetLane), callbackTargetBefore);
  assert.equal(laneBytes(callbackForeignLane), callbackForeignBefore);
  callbackPresence.stop();

  // A provisional direct-sync result marker is the prepare half of identity
  // migration. If that fallible callback retargets the project junction on its
  // second invocation, binding verification must abort before the lane rekey.
  // The source identity/obligation and both target/foreign lane bytes are exact.
  const markerTarget = path.join(temp, 'marker-callback-target');
  const markerForeign = path.join(temp, 'marker-callback-foreign');
  const markerProject = path.join(temp, 'marker-callback-project-link');
  fs.mkdirSync(markerTarget, { recursive: true });
  fs.mkdirSync(markerForeign, { recursive: true });
  fs.writeFileSync(path.join(markerTarget, 'brain.klypix'), 'marker-callback-target');
  fs.writeFileSync(path.join(markerForeign, 'brain.klypix'), 'marker-callback-foreign');
  fs.symlinkSync(markerTarget, markerProject, process.platform === 'win32' ? 'junction' : 'dir');
  let markerWriteCalls = 0;
  const markerPresence = createMcpPresence({
    server,
    initialVault: markerProject,
    home,
    env: { KLYPIX_MCP_CONNECTION_ID: 'mcp-marker-callback-provisional' },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    markResultClaimPendingFn: (options) => {
      markerWriteCalls += 1;
      if (markerWriteCalls === 2) {
        fs.rmSync(markerProject, { force: true });
        fs.symlinkSync(markerForeign, markerProject, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const file = resultClaimMarkerFileFor(options.brainPath, options.sessionId, options.home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let created = false;
      try {
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessionId: options.sessionId }), { flag: 'wx' });
        created = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      return { ok: true, pending: true, file, created };
    },
  });
  const provisionalMarkerId = markerPresence.id;
  const markerTargetBrain = path.join(markerTarget, 'brain.klypix');
  const markerForeignBrain = path.join(markerForeign, 'brain.klypix');
  const firstMarkerResult = markerPresence.sync({
    project: markerProject,
    phase: 'checkpoint',
    intent: 'retain provisional result obligation across request identity preparation',
    files: ['src/marker-callback.mjs'],
    results: [{ malformed: true }],
  });
  assert.equal(firstMarkerResult.isError, true);
  assert.equal(markerWriteCalls, 1, 'the first direct sync creates the provisional result marker');
  const markerTargetLane = laneFileFor(markerTargetBrain, home);
  const markerForeignLane = laneFileFor(markerForeignBrain, home);
  const sourceMarkerClaim = resultClaimMarkerFileFor(markerTargetBrain, provisionalMarkerId, home);
  const exactMarkerId = '019ff22f-d710-7093-b76b-14f0b1fade02';
  const destinationMarkerClaim = resultClaimMarkerFileFor(markerTargetBrain, exactMarkerId, home);
  assert.equal(fs.existsSync(sourceMarkerClaim), true);
  assert.equal(fs.existsSync(destinationMarkerClaim), false);
  const markerTargetBefore = laneBytes(markerTargetLane);
  const markerForeignBefore = laneBytes(markerForeignLane);

  const markerSwapRejected = markerPresence.sync({
    project: markerProject,
    phase: 'checkpoint',
    requestIdentity: {
      ok: true,
      id: exactMarkerId,
      clientInfo: { client: 'codex', surface: 'OpenAI Codex' },
    },
  });
  assert.equal(markerWriteCalls, 2, 'request identity migration reaches the deterministic second marker callback');
  assert.equal(markerSwapRejected.isError, true);
  assert.equal(markerSwapRejected.structured.status, 'project-changed');
  assert.equal(markerSwapRejected.structured.mutation, 'none');
  assert.equal(markerSwapRejected.structured.identityMutation, 'none');
  assert.equal(markerPresence.id, provisionalMarkerId,
    'a project swap during marker preparation keeps the provisional identity');
  assert.equal(laneBytes(markerTargetLane), markerTargetBefore,
    'the authorized target lane remains byte-identical because rekey never began');
  assert.equal(laneBytes(markerForeignLane), markerForeignBefore,
    'the retargeted foreign lane is never selected or mutated');
  assert.equal(fs.existsSync(sourceMarkerClaim), true,
    'the provisional source result obligation remains durable');
  assert.equal(fs.existsSync(destinationMarkerClaim), false,
    'the aborted preparation removes only its newly-created destination marker');
  fs.rmSync(markerProject, { force: true });
  fs.symlinkSync(markerTarget, markerProject, process.platform === 'win32' ? 'junction' : 'dir');
  markerPresence.stop();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('request identity tests passed');
