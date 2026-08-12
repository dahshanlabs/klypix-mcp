import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consumeMessageReceipt,
  laneFileFor,
  messageDeliveryState,
  postPresenceMessage,
  upsertSession,
} from '../src/agent-presence.mjs';

const oldCwd = process.cwd();
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
const oldNoMain = process.env.KLYPIX_BRAIN_NO_MAIN;
const oldClaudePid = process.env.CLAUDE_PID;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-claude-delivery-v3-'));
const project = path.join(home, 'project');
const brainPath = path.join(project, 'brain.klypix');
const sender = 'sender-session-0001';
const recipient = 'claude-session-0002';

const readLane = () => JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8'));
const readMessage = (id) => readLane().messages.find((message) => message.id === id);
const writeLane = (lane) => fs.writeFileSync(laneFileFor(brainPath, home), JSON.stringify(lane));

try {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(brainPath, 'fixture');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KLYPIX_BRAIN_NO_MAIN = '1';
  process.env.CLAUDE_PID = '424242';
  process.chdir(project);

  // Import after changing cwd/home: the real Claude hook intentionally binds
  // its project lane once, at process startup.
  const hookUrl = new URL('../src/global-brain-hook.mjs', import.meta.url);
  hookUrl.searchParams.set('delivery-v3-test', String(Date.now()));
  const {
    HOSTMAP_FILE,
    MSG_OUTBOX_FILE,
    SESSIONS_FILE,
    messageFooter,
    postMessages,
    touchSession,
  } = await import(hookUrl.href);

  // Claude's duplicated lane writer must also fail closed. A parse failure is
  // not a fresh lane: the hook returns a visible footer and preserves bytes.
  const laneFile = laneFileFor(brainPath, home);
  const corruptBytes = '{"messages": [broken';
  fs.mkdirSync(path.dirname(laneFile), { recursive: true });
  fs.writeFileSync(laneFile, corruptBytes);
  const corruptFooter = messageFooter(recipient, '', {}, 'corrupt-action');
  assert.match(corruptFooter, /coordination lane unavailable/i);
  assert.match(corruptFooter, /prior bytes were preserved/i);
  assert.equal(fs.readFileSync(laneFile, 'utf8'), corruptBytes);
  fs.unlinkSync(laneFile);

  const now = Date.now();
  upsertSession({ brainPath, home, now, id: sender, channel: 'mcp', event: 'McpTaskStart' });
  upsertSession({ brainPath, home, now, id: recipient, channel: 'lifecycle', event: 'UserPromptSubmit' });

  // Corrupt host correlation state is not "fresh". The Claude writer must
  // preserve it byte-for-byte, refuse the heartbeat, and avoid mutating the
  // otherwise healthy shared lane before returning an explicit failure.
  const corruptHostmap = '{"424242": broken';
  fs.writeFileSync(HOSTMAP_FILE, corruptHostmap);
  const laneBeforeHostmapFailure = fs.readFileSync(laneFile, 'utf8');
  const failedHostmapTouch = touchSession('hostmap-probe-session', { branch: 'test' });
  assert.equal(failedHostmapTouch.ok, false);
  assert.match(failedHostmapTouch.reason, /^hostmap-corrupt:/);
  assert.equal(fs.readFileSync(HOSTMAP_FILE, 'utf8'), corruptHostmap);
  assert.equal(fs.readFileSync(laneFile, 'utf8'), laneBeforeHostmapFailure);
  fs.unlinkSync(HOSTMAP_FILE);

  const markerMessage = (id, to, text = id) => ({
    id,
    from: sender,
    to,
    text,
    ts: Date.now(),
    seen: [],
    deliveryVersion: 3,
    deliveries: [],
  });

  // A broadcast without another live session fails before the durable outbox
  // or shared lane is touched. It cannot become a note for a later joiner.
  let soloLane = readLane();
  soloLane.sessions = soloLane.sessions.filter((session) => session.id === sender);
  writeLane(soloLane);
  if (fs.existsSync(MSG_OUTBOX_FILE)) fs.unlinkSync(MSG_OUTBOX_FILE);
  const emptyBroadcast = postMessages([markerMessage('empty-broadcast', 'all')]);
  assert.deepEqual(
    { ok: emptyBroadcast.ok, durable: emptyBroadcast.durable, posted: emptyBroadcast.posted, reason: emptyBroadcast.reason },
    { ok: false, durable: false, posted: 0, reason: 'no-live-recipients' },
  );
  assert.equal(fs.existsSync(MSG_OUTBOX_FILE), false);
  assert.equal(readMessage('empty-broadcast'), undefined);
  upsertSession({ brainPath, home, now, id: recipient, channel: 'lifecycle', event: 'UserPromptSubmit' });

  // Fail closed on a legacy/corrupt staged empty broadcast as well: draining
  // never turns it into a posted message or silently clears the evidence.
  const stagedEmpty = { ...markerMessage('staged-empty-broadcast', 'all'), candidateIds: [] };
  fs.mkdirSync(path.dirname(MSG_OUTBOX_FILE), { recursive: true });
  fs.writeFileSync(MSG_OUTBOX_FILE, JSON.stringify([stagedEmpty]));
  const emptyDrain = postMessages([]);
  assert.equal(emptyDrain.ok, false);
  assert.equal(emptyDrain.posted, 0);
  assert.equal(emptyDrain.durable, true);
  assert.equal(emptyDrain.reason, 'outbox-corrupt:empty-audience');
  assert.equal(readMessage('staged-empty-broadcast'), undefined);
  assert.equal(fs.existsSync(MSG_OUTBOX_FILE), true);
  fs.unlinkSync(MSG_OUTBOX_FILE);

  // The durable marker outbox is also fail-closed. Existing malformed bytes
  // are never interpreted as an empty queue, overwritten, or reported posted.
  const corruptOutbox = '[{"id":"preserve-me"}, broken';
  fs.mkdirSync(path.dirname(MSG_OUTBOX_FILE), { recursive: true });
  fs.writeFileSync(MSG_OUTBOX_FILE, corruptOutbox);
  const corruptOutboxPost = postMessages([markerMessage('must-not-post', recipient)]);
  assert.equal(corruptOutboxPost.ok, false);
  assert.equal(corruptOutboxPost.posted, 0);
  assert.equal(corruptOutboxPost.durable, false);
  assert.match(corruptOutboxPost.reason, /^outbox-corrupt:/);
  assert.equal(fs.readFileSync(MSG_OUTBOX_FILE, 'utf8'), corruptOutbox);
  assert.equal(readMessage('must-not-post'), undefined);
  fs.unlinkSync(MSG_OUTBOX_FILE);

  // Targeted marker sends are accepted only when exactly one OTHER live row
  // resolves. Missing ids, ambiguous branches, and the sender itself cannot
  // enter or clear the outbox and never claim a post.
  const ambiguousOne = 'ambiguous-peer-0004';
  const ambiguousTwo = 'ambiguous-peer-0005';
  upsertSession({ brainPath, home, now: now + 1, id: ambiguousOne, branch: 'shared-target', channel: 'lifecycle', event: 'SessionStart' });
  upsertSession({ brainPath, home, now: now + 1, id: ambiguousTwo, branch: 'shared-target', channel: 'lifecycle', event: 'SessionStart' });
  for (const [id, target] of [
    ['missing-target-message', 'not-a-live-peer'],
    ['ambiguous-target-message', 'shared-target'],
    ['self-target-message', sender],
  ]) {
    const result = postMessages([markerMessage(id, target)]);
    assert.equal(result.ok, false);
    assert.equal(result.posted, 0);
    assert.equal(result.durable, false);
    assert.equal(result.reason, 'target-not-unique');
    assert.equal(readMessage(id), undefined);
  }
  assert.equal(fs.existsSync(MSG_OUTBOX_FILE), false);
  let targetLane = readLane();
  targetLane.sessions = targetLane.sessions.filter((session) => ![ambiguousOne, ambiguousTwo].includes(session.id));
  writeLane(targetLane);

  // Snapshot happens before waiting on the shared lane lock. If the first
  // drain times out and a new chat joins before retry, that later chat remains
  // outside the already-staged broadcast's immutable audience.
  assert.equal(SESSIONS_FILE, laneFile);
  const delayedId = 'claude-delayed-broadcast';
  fs.writeFileSync(`${SESSIONS_FILE}.lock`, 'held-by-test');
  const delayed = postMessages([markerMessage(delayedId, 'all', 'Audience fixed before lane retry.')]);
  assert.deepEqual(
    { ok: delayed.ok, durable: delayed.durable, posted: delayed.posted, reason: delayed.reason },
    { ok: false, durable: true, posted: 0, reason: 'lane-lock-timeout' },
  );
  const stagedRows = JSON.parse(fs.readFileSync(MSG_OUTBOX_FILE, 'utf8'));
  assert.deepEqual(stagedRows.find((message) => message.id === delayedId)?.candidateIds, [recipient]);
  fs.unlinkSync(`${SESSIONS_FILE}.lock`);
  const delayedLate = 'delayed-late-session-0006';
  upsertSession({ brainPath, home, now: now + 2, id: delayedLate, channel: 'lifecycle', event: 'SessionStart' });
  const drained = postMessages([]);
  assert.equal(drained.ok, true);
  assert.equal(drained.posted, 1);
  const delayedStored = readMessage(delayedId);
  assert.deepEqual(delayedStored.candidateIds, [recipient]);
  assert.equal(delayedStored.deliveries.some((entry) => entry.recipientId === delayedLate), false);
  targetLane = readLane();
  targetLane.sessions = targetLane.sessions.filter((session) => session.id !== delayedLate);
  targetLane.messages = targetLane.messages.filter((message) => message.id !== delayedId);
  writeLane(targetLane);

  const posted = postPresenceMessage({
    brainPath,
    home,
    now: now + 1,
    from: sender,
    to: recipient,
    text: 'Integrate the peer result before continuing.',
  });
  assert.equal(posted.posted, true);
  assert.equal(posted.message.deliveryVersion, 3);
  assert.equal(messageDeliveryState(posted.message, recipient), 'pending');

  const first = messageFooter(recipient, '', {}, 'claude-action-1');
  let stored = readMessage(posted.message.id);
  let delivery = stored.deliveries.find((entry) => entry.recipientId === recipient);
  assert.equal(delivery.state, 'offered');
  assert.equal(delivery.offeredActionId, 'claude-action-1');
  assert.match(delivery.offerToken, /^[A-Za-z0-9_-]{20,}$/);
  assert(first.includes(`message_id \`${posted.message.id}\``));
  assert(first.includes(`offer_token \`${delivery.offerToken}\``));
  assert(first.includes('brain_message_receipt'));

  // Re-entering the same hook event cannot advance or duplicate the offer.
  assert.equal(messageFooter(recipient, '', {}, 'claude-action-1'), '');
  assert.equal(messageDeliveryState(readMessage(posted.message.id), recipient), 'offered');

  const second = messageFooter(recipient, '', {}, 'claude-action-2');
  stored = readMessage(posted.message.id);
  delivery = stored.deliveries.find((entry) => entry.recipientId === recipient);
  assert(second.includes(posted.message.id));
  assert.equal(delivery.state, 'acknowledged');
  assert.equal(delivery.acknowledgedActionId, 'claude-action-2');
  assert.equal(stored.retiredAt, undefined);

  // Acknowledgement is durable but non-terminal: later actions replay the note
  // with the same per-recipient token until an explicit consume receipt lands.
  const third = messageFooter(recipient, '', {}, 'claude-action-3');
  stored = readMessage(posted.message.id);
  delivery = stored.deliveries.find((entry) => entry.recipientId === recipient);
  assert(third.includes(delivery.offerToken));
  assert.equal(delivery.state, 'acknowledged');
  assert.equal(delivery.acknowledgedActionId, 'claude-action-3');
  assert.equal(stored.retiredAt, undefined);

  const consumed = consumeMessageReceipt({
    brainPath,
    home,
    now: now + 10,
    sessionId: recipient,
    messageId: posted.message.id,
    offerToken: delivery.offerToken,
    actionId: 'mcp-receipt-action-4',
  });
  assert.deepEqual(
    { ok: consumed.ok, changed: consumed.changed, status: consumed.status },
    { ok: true, changed: true, status: 'consumed' },
  );
  stored = readMessage(posted.message.id);
  assert.equal(messageDeliveryState(stored, recipient), 'consumed');
  assert.equal(stored.retiredAt, now + 10);
  assert.equal(messageFooter(recipient, '', {}, 'claude-action-5'), '');

  // v3 snapshots the audience at send time. A later chat must not receive an
  // old broadcast simply because it joined the same project lane.
  const broadcast = postPresenceMessage({
    brainPath,
    home,
    now: now + 11,
    from: sender,
    to: 'all',
    text: 'Only peers present at send time receive this.',
  });
  assert.equal(broadcast.posted, true);
  const late = 'late-claude-session-0003';
  upsertSession({ brainPath, home, now: now + 12, id: late, channel: 'lifecycle', event: 'SessionStart' });
  assert.equal(messageFooter(late, '', {}, 'late-action-1'), '');
  assert.equal(messageDeliveryState(readMessage(broadcast.message.id), late), 'pending');
  let lane = readLane();
  lane.messages = lane.messages.filter((message) => message.id !== broadcast.message.id);
  writeLane(lane);

  // Legacy seen/retired state was recorded before model delivery. v3 reopens,
  // replays, mints a token, and never fabricates consumption.
  lane = readLane();
  lane.messages.push({
    id: 'legacy-seen-message',
    from: sender,
    to: recipient,
    text: 'Legacy note must replay.',
    ts: now + 11,
    seen: [recipient],
    candidateIds: [recipient],
    retiredAt: now + 11,
  });
  writeLane(lane);
  const legacyFooter = messageFooter(recipient, '', {}, 'claude-action-6');
  const legacy = readMessage('legacy-seen-message');
  const legacyDelivery = legacy.deliveries.find((entry) => entry.recipientId === recipient);
  assert(legacyFooter.includes('legacy-seen-message'));
  assert.equal(legacy.deliveryVersion, 3);
  assert.equal(legacy.retiredAt, undefined);
  assert.equal(legacyDelivery.legacySeen, true);
  assert.equal(legacyDelivery.state, 'acknowledged');
  assert.match(legacyDelivery.offerToken, /^[A-Za-z0-9_-]{20,}$/);
  const legacyConsumed = consumeMessageReceipt({
    brainPath,
    home,
    now: now + 13,
    sessionId: recipient,
    messageId: legacy.id,
    offerToken: legacyDelivery.offerToken,
    actionId: 'mcp-legacy-receipt',
  });
  assert.equal(legacyConsumed.status, 'consumed');

  // Native v3 terminal records stay terminal; normalization must not reopen or
  // downgrade a legitimate consumption receipt.
  lane = readLane();
  lane.messages.push({
    id: 'native-v3-consumed',
    from: sender,
    to: recipient,
    text: 'Already consumed.',
    ts: now + 12,
    deliveryVersion: 3,
    seen: [recipient],
    candidateIds: [recipient],
    retiredAt: now + 12,
    deliveries: [{
      recipientId: recipient,
      state: 'consumed',
      attempts: 1,
      offerToken: 'native-v3-token-000000000000',
      offeredAt: now + 12,
      acknowledgedAt: now + 12,
      consumedAt: now + 12,
    }],
  });
  writeLane(lane);
  messageFooter(recipient, '', {}, 'claude-action-7');
  const nativeV3 = readMessage('native-v3-consumed');
  assert.equal(nativeV3.retiredAt, now + 12);
  assert.equal(messageDeliveryState(nativeV3, recipient), 'consumed');

  // TTL expiration dead-letters acknowledged-but-unconsumed notes.
  lane = readLane();
  lane.messages.push({
    id: 'expired-unconsumed',
    from: sender,
    to: recipient,
    text: 'Expired before consume.',
    ts: Date.now() - (24 * 60 * 60 * 1000) - 5_000,
    deliveryVersion: 3,
    seen: [recipient],
    candidateIds: [recipient],
    deliveries: [{
      recipientId: recipient,
      state: 'acknowledged',
      attempts: 2,
      offerToken: 'expired-token-00000000000000',
      offeredAt: now,
      acknowledgedAt: now,
    }],
  });
  writeLane(lane);
  messageFooter(recipient, '', {}, 'claude-action-8');
  const expired = readMessage('expired-unconsumed');
  assert.equal(expired.deadLetter.reason, 'expired-before-consumption');
  assert.equal(messageDeliveryState(expired, recipient), 'failed');

  // Apply the six-note budget before grouping identical text. The footer may
  // render one instruction line, but it exposes exactly six receipts and the
  // seventh row remains pending with no minted token.
  lane = readLane();
  for (let index = 0; index < 7; index += 1) {
    lane.messages.push({
      id: `group-budget-${index}`,
      from: sender,
      to: recipient,
      text: 'Identical grouped instruction.',
      ts: now + 14 + index,
      deliveryVersion: 3,
      seen: [],
      candidateIds: [recipient],
      deliveries: [{ recipientId: recipient, state: 'pending', attempts: 0 }],
    });
  }
  writeLane(lane);
  const groupedBudget = messageFooter(recipient, '', {}, 'claude-group-budget');
  assert.equal(groupedBudget.split('Identical grouped instruction.').length - 1, 1);
  for (let index = 0; index < 6; index += 1) assert(groupedBudget.includes(`message_id \`group-budget-${index}\``));
  assert(!groupedBudget.includes('message_id `group-budget-6`'));
  assert.match(groupedBudget, /1 more message\(s\) waiting/);
  for (let index = 0; index < 7; index += 1) {
    const grouped = readMessage(`group-budget-${index}`);
    assert.equal(messageDeliveryState(grouped, recipient), index < 6 ? 'offered' : 'pending');
    const groupedDelivery = grouped.deliveries.find((entry) => entry.recipientId === recipient);
    if (index < 6) assert.match(groupedDelivery.offerToken, /^[A-Za-z0-9_-]{20,}$/);
    else assert.equal(groupedDelivery.offerToken, undefined);
  }
  lane = readLane();
  lane.messages = lane.messages.filter((message) => !String(message.id).startsWith('group-budget-'));
  writeLane(lane);

  // The six-message render budget prioritizes unseen work over offered notes
  // and acknowledged replays, preventing old replay traffic from starvation.
  lane = readLane();
  lane.messages.push(
    {
      id: 'ordering-acknowledged', from: sender, to: recipient, text: 'Ordering acknowledged', ts: now + 20,
      deliveryVersion: 3, seen: [recipient], candidateIds: [recipient],
      deliveries: [{ recipientId: recipient, state: 'acknowledged', attempts: 2,
        offerToken: 'ordering-ack-token-000000000', offeredAt: now, acknowledgedAt: now }],
    },
    {
      id: 'ordering-offered', from: sender, to: recipient, text: 'Ordering offered', ts: now + 21,
      deliveryVersion: 3, seen: [], candidateIds: [recipient],
      deliveries: [{ recipientId: recipient, state: 'offered', attempts: 1,
        offerToken: 'ordering-offer-token-0000000', offeredAt: now }],
    },
  );
  for (let index = 0; index < 6; index += 1) {
    lane.messages.push({
      id: `ordering-pending-${index}`,
      from: sender,
      to: recipient,
      text: `Ordering pending ${index}`,
      ts: now + 22 + index,
      deliveryVersion: 3,
      seen: [],
      candidateIds: [recipient],
      deliveries: [{ recipientId: recipient, state: 'pending', attempts: 0 }],
    });
  }
  writeLane(lane);
  const orderedFooter = messageFooter(recipient, '', {}, 'claude-action-ordering');
  for (let index = 0; index < 6; index += 1) assert(orderedFooter.includes(`ordering-pending-${index}`));
  assert(!orderedFooter.includes('ordering-offered'));
  assert(!orderedFooter.includes('ordering-acknowledged'));
  lane = readLane();
  lane.messages = lane.messages.filter((message) => !String(message.id).startsWith('ordering-'));
  writeLane(lane);

  // Capacity pressure preserves unseen work: acknowledged-only progress is
  // terminalized before offered/pending notes, with a visible failed receipt.
  lane = readLane();
  const capBase = Date.now() - 1_000;
  lane.messages.push({
    id: 'capacity-acknowledged',
    from: sender,
    to: recipient,
    text: 'Capacity acknowledged',
    ts: capBase + 100,
    deliveryVersion: 3,
    seen: [recipient],
    candidateIds: [recipient],
    deliveries: [{ recipientId: recipient, state: 'acknowledged', attempts: 2,
      offerToken: 'capacity-ack-token-000000000', offeredAt: now, acknowledgedAt: now }],
  });
  lane.messages.push({
    id: 'capacity-offered',
    from: sender,
    to: recipient,
    text: 'Capacity offered',
    ts: capBase,
    deliveryVersion: 3,
    seen: [],
    candidateIds: [recipient],
    deliveries: [{ recipientId: recipient, state: 'offered', attempts: 1,
      offerToken: 'capacity-offer-token-0000000', offeredAt: now }],
  });
  for (let index = 0; index < 29; index += 1) {
    lane.messages.push({
      id: `capacity-pending-${index}`,
      from: sender,
      to: recipient,
      text: `Capacity note ${index}`,
      ts: capBase + index,
      deliveryVersion: 3,
      seen: [],
      candidateIds: [recipient],
      deliveries: [{ recipientId: recipient, state: 'pending', attempts: 0 }],
    });
  }
  writeLane(lane);
  messageFooter(recipient, '', {}, 'claude-action-9');
  const overflow = readMessage('capacity-acknowledged');
  assert.equal(overflow.deadLetter.reason, 'lane-capacity-overflow');
  assert.equal(messageDeliveryState(overflow, recipient), 'failed');
  assert.equal(readMessage('capacity-offered').deadLetter, undefined);
  assert.equal(readMessage('capacity-pending-0').deadLetter, undefined);

  console.log('[ok] Claude hook v3 offers, acknowledges, replays, consumes, migrates, and dead-letters durably');
} finally {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  if (oldNoMain === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = oldNoMain;
  if (oldClaudePid === undefined) delete process.env.CLAUDE_PID; else process.env.CLAUDE_PID = oldClaudePid;
  fs.rmSync(home, { recursive: true, force: true });
}
