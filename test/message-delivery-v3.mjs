import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consumeMessageReceipt,
  endSession,
  formatReceivedMessages,
  laneFileFor,
  messageDeliveryReceipt,
  messageDeliveryState,
  postPresenceMessage,
  receiveMessages,
  upsertSession,
} from '../src/agent-presence.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-delivery-v3-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const brainPath = path.join(project, 'brain.klypix');
fs.writeFileSync(brainPath, 'fixture');
const now = 2_200_000_000_000;
const sender = 'sender-session-0001';
const recipient = 'recipient-session-0002';

try {
  upsertSession({ brainPath, home, now, id: sender, channel: 'lifecycle', event: 'UserPromptSubmit' });
  upsertSession({ brainPath, home, now, id: recipient, channel: 'mcp', event: 'McpTaskStart' });
  const posted = postPresenceMessage({ brainPath, home, now: now + 1, from: sender, to: recipient, text: 'coordinate safely' });
  assert.equal(posted.posted, true);
  assert.equal(posted.message.deliveryVersion, 3);
  assert.equal(posted.message.deliveries[0].state, 'pending');
  assert.equal(posted.message.deliveries[0].offerToken, undefined);

  const laneFile = laneFileFor(brainPath, home);
  const read = () => JSON.parse(fs.readFileSync(laneFile, 'utf8')).messages
    .find((message) => message.id === posted.message.id);

  const offered = receiveMessages({ brainPath, home, now: now + 2, sessionId: recipient, actionId: 'action-1' });
  assert.equal(offered.deliveryWriteOk, true);
  assert.equal(offered.length, 1);
  let stored = read();
  assert.equal(messageDeliveryState(stored, recipient), 'offered');
  const receipt = messageDeliveryReceipt(stored, recipient);
  assert(receipt.offerToken.length >= 20);
  const rendered = formatReceivedMessages(offered, now + 2, {}, recipient);
  assert(rendered.includes(posted.message.id));
  assert(rendered.includes(receipt.offerToken));
  assert(!rendered.toLowerCase().includes('human read'));

  const sameAction = consumeMessageReceipt({
    brainPath, home, now: now + 3, sessionId: recipient, messageId: posted.message.id,
    offerToken: receipt.offerToken, actionId: 'action-1',
  });
  assert.deepEqual({ ok: sameAction.ok, status: sameAction.status, reason: sameAction.reason },
    { ok: false, status: 'rejected', reason: 'same-action-not-consumable' });

  const wrongToken = consumeMessageReceipt({
    brainPath, home, now: now + 4, sessionId: recipient, messageId: posted.message.id,
    offerToken: 'wrong-token', actionId: 'action-2',
  });
  assert.equal(wrongToken.reason, 'offer-token-mismatch');

  const consumed = consumeMessageReceipt({
    brainPath, home, now: now + 5, sessionId: recipient, messageId: posted.message.id,
    offerToken: receipt.offerToken, actionId: 'action-2',
  });
  assert.deepEqual({ ok: consumed.ok, changed: consumed.changed, status: consumed.status },
    { ok: true, changed: true, status: 'consumed' });
  stored = read();
  const durable = stored.deliveries.find((delivery) => delivery.recipientId === recipient);
  assert.equal(durable.state, 'consumed');
  assert.equal(durable.acknowledgedActionId, 'action-2');
  assert.equal(durable.consumedActionId, 'action-2');
  assert.equal(stored.retiredAt, now + 5);

  const repeated = consumeMessageReceipt({
    brainPath, home, now: now + 6, sessionId: recipient, messageId: posted.message.id,
    offerToken: receipt.offerToken, actionId: 'action-3',
  });
  assert.deepEqual({ ok: repeated.ok, changed: repeated.changed, status: repeated.status },
    { ok: true, changed: false, status: 'consumed' });

  // A legacy v2 acknowledgement is conservative: it migrates but does not
  // retire as consumed or fabricate an offer token.
  const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  lane.messages.push({
    id: 'legacy-v2-message', from: sender, to: recipient, text: 'legacy', ts: now + 6,
    deliveryVersion: 2, seen: [recipient], candidateIds: [recipient], retiredAt: now + 6,
    deliveries: [{ recipientId: recipient, state: 'acknowledged', acknowledgedAt: now + 6 }],
  });
  fs.writeFileSync(laneFile, JSON.stringify(lane));
  const replayed = receiveMessages({ brainPath, home, now: now + 7, sessionId: recipient, actionId: 'legacy-action' });
  assert(replayed.some((message) => message.id === 'legacy-v2-message'));
  const migrated = readLaneMessage(laneFile, 'legacy-v2-message');
  assert.equal(migrated.retiredAt, undefined);
  assert.equal(messageDeliveryState(migrated, recipient), 'acknowledged');

  // A solo broadcast is an explicit send failure, not a durable zero-audience
  // message that a future session could accidentally inherit.
  const soloProject = path.join(home, 'solo-project');
  fs.mkdirSync(soloProject, { recursive: true });
  const soloBrain = path.join(soloProject, 'brain.klypix');
  fs.writeFileSync(soloBrain, 'fixture');
  upsertSession({ brainPath: soloBrain, home, now, id: sender, channel: 'mcp', event: 'McpTaskStart' });
  const emptyBroadcast = postPresenceMessage({
    brainPath: soloBrain, home, now: now + 10,
    from: sender, to: 'all', text: 'must have a live peer',
  });
  assert.deepEqual({ posted: emptyBroadcast.posted, message: emptyBroadcast.message, reason: emptyBroadcast.reason },
    { posted: false, message: null, reason: 'no-live-recipients' });
  assert.deepEqual(JSON.parse(fs.readFileSync(laneFileFor(soloBrain, home), 'utf8')).messages || [], []);

  // A Codex lifecycle event arriving after SessionEnd cannot offer a pending
  // note or acknowledge an earlier offer. Only a real task-start revival may
  // make the exact row eligible again.
  const endedProject = path.join(home, 'ended-project');
  fs.mkdirSync(endedProject, { recursive: true });
  const endedBrain = path.join(endedProject, 'brain.klypix');
  fs.writeFileSync(endedBrain, 'fixture');
  upsertSession({ brainPath: endedBrain, home, now, id: sender, channel: 'mcp', event: 'McpTaskStart' });
  upsertSession({ brainPath: endedBrain, home, now, id: recipient, channel: 'lifecycle', event: 'SessionStart' });
  const lateMessage = postPresenceMessage({
    brainPath: endedBrain, home, now: now + 11,
    from: sender, to: recipient, text: 'do not advance after close',
  }).message;
  assert.equal(endSession({ brainPath: endedBrain, home, now: now + 12, id: recipient }).ok, true);
  const lateTouch = upsertSession({
    brainPath: endedBrain, home, now: now + 13,
    id: recipient, channel: 'lifecycle', event: 'PostToolUse',
  });
  assert.equal(lateTouch.laneWriteOk, false);
  assert.equal(lateTouch.laneWriteSkippedReason, 'session-ended');
  const lateOffer = receiveMessages({
    brainPath: endedBrain, home, now: now + 13,
    sessionId: recipient, actionId: 'late-post-tool',
  });
  assert.equal(lateOffer.length, 0);
  assert.equal(lateOffer.deliveryWriteOk, false);
  assert.equal(lateOffer.deliveryWriteSkippedReason, 'session-not-live');
  assert.equal(messageDeliveryState(readLaneMessage(laneFileFor(endedBrain, home), lateMessage.id), recipient), 'pending');

  upsertSession({ brainPath: endedBrain, home, now: now + 14, id: recipient, channel: 'mcp', event: 'McpTaskStart' });
  const liveOffer = receiveMessages({
    brainPath: endedBrain, home, now: now + 15,
    sessionId: recipient, actionId: 'new-live-task',
  });
  assert.equal(liveOffer.length, 1);
  assert.equal(messageDeliveryState(readLaneMessage(laneFileFor(endedBrain, home), lateMessage.id), recipient), 'offered');
  assert.equal(endSession({ brainPath: endedBrain, home, now: now + 16, id: recipient }).ok, true);
  upsertSession({
    brainPath: endedBrain, home, now: now + 17, id: 'ended-recipient-alias-holder',
    aliases: [recipient], channel: 'lifecycle', event: 'SessionStart',
  });
  const endedLaneFile = laneFileFor(endedBrain, home);
  const offeredAfterEnd = readLaneMessage(endedLaneFile, lateMessage.id);
  const lateReceipt = messageDeliveryReceipt(offeredAfterEnd, recipient);
  const beforeLateReceipt = fs.readFileSync(endedLaneFile, 'utf8');
  const rejectedLateReceipt = consumeMessageReceipt({
    brainPath: endedBrain, home, now: now + 17,
    sessionId: recipient, messageId: lateMessage.id, offerToken: lateReceipt.offerToken,
    actionId: 'late-explicit-receipt',
  });
  assert.deepEqual(
    { ok: rejectedLateReceipt.ok, changed: rejectedLateReceipt.changed, status: rejectedLateReceipt.status, reason: rejectedLateReceipt.reason },
    { ok: false, changed: false, status: 'rejected', reason: 'session-not-live' },
  );
  assert.equal(fs.readFileSync(endedLaneFile, 'utf8'), beforeLateReceipt,
    'an alias cannot consume for a missing exact recipient and the lane remains byte-for-byte unchanged');
  assert.equal(messageDeliveryState(readLaneMessage(endedLaneFile, lateMessage.id), recipient), 'offered');
  upsertSession({ brainPath: endedBrain, home, now: now + 17, id: recipient, channel: 'lifecycle', event: 'PreToolUse' });
  const lateAck = receiveMessages({
    brainPath: endedBrain, home, now: now + 17,
    sessionId: recipient, actionId: 'late-pre-tool',
  });
  assert.equal(lateAck.deliveryWriteOk, false);
  assert.equal(lateAck.deliveryWriteSkippedReason, 'session-not-live');
  assert.equal(messageDeliveryState(readLaneMessage(laneFileFor(endedBrain, home), lateMessage.id), recipient), 'offered');

  // Duplicate delivery is receipt-lossless. Identical instructions may render
  // once, but every advanced message remains returned and explicitly
  // consumable. Case-distinct paths are separate instructions.
  const duplicateProject = path.join(home, 'duplicate-project');
  fs.mkdirSync(duplicateProject, { recursive: true });
  const duplicateBrain = path.join(duplicateProject, 'brain.klypix');
  fs.writeFileSync(duplicateBrain, 'fixture');
  upsertSession({ brainPath: duplicateBrain, home, now, id: sender, channel: 'lifecycle', event: 'UserPromptSubmit' });
  upsertSession({ brainPath: duplicateBrain, home, now, id: recipient, channel: 'mcp', event: 'McpTaskStart' });
  const exactText = 'Edit src/API.ts before release';
  const exact = [0, 1].map((offset) => postPresenceMessage({
    brainPath: duplicateBrain, home, now: now + 20 + offset,
    from: sender, to: recipient, text: exactText,
  }).message);
  const caseDistinct = postPresenceMessage({
    brainPath: duplicateBrain, home, now: now + 22,
    from: sender, to: recipient, text: 'Edit src/api.ts before release',
  }).message;
  const duplicateOffer = receiveMessages({
    brainPath: duplicateBrain, home, now: now + 23,
    sessionId: recipient, actionId: 'duplicate-offer',
  });
  assert.deepEqual(new Set(duplicateOffer.map((message) => message.id)),
    new Set([...exact.map((message) => message.id), caseDistinct.id]));
  const duplicateLaneFile = laneFileFor(duplicateBrain, home);
  const duplicateStored = JSON.parse(fs.readFileSync(duplicateLaneFile, 'utf8')).messages;
  for (const message of duplicateStored) {
    assert.equal(messageDeliveryState(message, recipient), 'offered');
    assert(messageDeliveryReceipt(message, recipient)?.offerToken);
  }
  const duplicateRendered = formatReceivedMessages(duplicateOffer, now + 23, {}, recipient);
  assert.equal(duplicateRendered.split(exactText).length - 1, 1,
    'same-sender exact duplicates render as one instruction');
  assert(duplicateRendered.includes('Edit src/api.ts before release'),
    'case-distinct paths remain separate instructions');
  for (const message of duplicateStored) {
    const messageReceipt = messageDeliveryReceipt(message, recipient);
    assert(duplicateRendered.includes(message.id));
    assert(duplicateRendered.includes(messageReceipt.offerToken));
    const duplicateConsumed = consumeMessageReceipt({
      brainPath: duplicateBrain, home, now: now + 24,
      sessionId: recipient, messageId: message.id,
      offerToken: messageReceipt.offerToken, actionId: `consume-${message.id}`,
    });
    assert.deepEqual({ ok: duplicateConsumed.ok, status: duplicateConsumed.status },
      { ok: true, status: 'consumed' });
  }

  // The context budget advances six actual notes, never an unreturned seventh
  // duplicate hidden behind a grouped rendering line.
  const budgetProject = path.join(home, 'budget-project');
  fs.mkdirSync(budgetProject, { recursive: true });
  const budgetBrain = path.join(budgetProject, 'brain.klypix');
  fs.writeFileSync(budgetBrain, 'fixture');
  upsertSession({ brainPath: budgetBrain, home, now, id: sender, channel: 'lifecycle', event: 'UserPromptSubmit' });
  upsertSession({ brainPath: budgetBrain, home, now, id: recipient, channel: 'mcp', event: 'McpTaskStart' });
  const budgetMessages = Array.from({ length: 7 }, (_, offset) => postPresenceMessage({
    brainPath: budgetBrain, home, now: now + 30 + offset,
    from: sender, to: recipient, text: 'same instruction under budget pressure',
  }).message);
  const budgetOffer = receiveMessages({
    brainPath: budgetBrain, home, now: now + 40,
    sessionId: recipient, actionId: 'budget-offer',
  });
  assert.equal(budgetOffer.length, 6);
  const budgetStored = JSON.parse(fs.readFileSync(laneFileFor(budgetBrain, home), 'utf8')).messages;
  const advancedIds = new Set(budgetOffer.map((message) => message.id));
  for (const message of budgetStored) {
    if (advancedIds.has(message.id)) {
      assert.equal(messageDeliveryState(message, recipient), 'offered');
      assert(messageDeliveryReceipt(message, recipient)?.offerToken);
    } else {
      assert.equal(messageDeliveryState(message, recipient), 'pending');
      assert.equal(messageDeliveryReceipt(message, recipient), null);
    }
  }
  assert.equal(budgetMessages.filter((message) => !advancedIds.has(message.id)).length, 1);
  const budgetRendered = formatReceivedMessages(budgetOffer, now + 40, {}, recipient);
  assert.equal(budgetRendered.split('same instruction under budget pressure').length - 1, 1);
  for (const message of budgetOffer) {
    const storedMessage = budgetStored.find((candidate) => candidate.id === message.id);
    const messageReceipt = messageDeliveryReceipt(storedMessage, recipient);
    assert(budgetRendered.includes(message.id));
    assert(budgetRendered.includes(messageReceipt.offerToken));
  }

  console.log('[ok] delivery v3 offers, lossless duplicate receipts, case-sensitive instructions, budget safety, consumption, retirement, and conservative v2 migration');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

function readLaneMessage(file, id) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).messages.find((message) => message.id === id);
}
