// E2E for brain_message (1.16.0) — the MCP twin of the hook's 🧠 MSG lane.
// THE contract under test: a message posted by the MCP op (opBrainMessage, used by
// hookless clients like Cursor/Cline) is offered by the real Claude Code hook — i.e.
// the two independent lane implementations (klypix-core vs global-brain-hook)
// resolve the SAME lane file and speak the same message shape. If they drift,
// this fails — that's the point.
//
//   1. post a note via opBrainMessage (in-process, temp HOME + project)
//   2. run the REAL hook (--prompt) as a receiving session → note IS delivered
//   3. run it again, same session → note is replayed and acknowledged
//   4. explicitly consume its token → only then does the note stay quiet
//
// Run:  node test/lane-message.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  consumeMessageReceipt,
  laneFileFor,
  messageDeliveryState,
  postPresenceMessage,
  upsertSession,
} from '../src/agent-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const WORKER = path.join(__dirname, '..', 'bin', 'klypix-worker.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const home = path.join(os.tmpdir(), 'klypix-lane-msg-home');
const proj = path.join(os.tmpdir(), 'klypix-lane-msg-proj');
for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'brain.klypix'),
  await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
// Delivery v3 snapshots the live audience at send time. Make the intended
// receiver live before the broadcast; a session that appears later must not
// retroactively become a recipient.
upsertSession({ brainPath: path.join(proj, 'brain.klypix'), id: 'sess-recv',
  logicalSessionId: 'sess-recv', identitySource: 'claude-lifecycle',
  client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', home });

// ── 1. Sender: the MCP op, exactly as a hookless client would drive it ──────
// os.homedir() reads HOME/USERPROFILE at call time; point BOTH at the temp home
// and run from the project dir (the MCP server's real working directory).
const NOTE = 'merged the hook refactor — rebase before you commit';
const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const prevCwd = process.cwd();
let sendText = '';
try {
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.chdir(proj);
  const { opBrainMessage } = await import('../src/klypix-core.mjs');
  const res = await opBrainMessage({
    vault: proj, text: NOTE, to: 'all', via: 'cursor', from: 'sender-session', sessionId: 'sender-session',
  });
  sendText = (res.blocks || []).map(b => b.text || '').join('\n');
  ok(res.isError !== true, 'opBrainMessage succeeds');
  ok(/📨/.test(sendText), 'send confirmation is the 📨 lane receipt');
} finally {
  process.chdir(prevCwd);
  process.env.HOME = prevEnv.HOME; process.env.USERPROFILE = prevEnv.USERPROFILE;
}

// ── 2. Receiver: the REAL hook, --prompt, a different session id ────────────
let hookActionSequence = 0;
const runHook = (sid, tp) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' };
  delete env.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main()
  return execFileSync(process.execPath, [HOOK, '--prompt'], {
    cwd: proj, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, event_id: `lane-hook-action-${++hookActionSequence}`,
      prompt: 'continue the refactor', ...(tp ? { transcript_path: tp } : {}) }),
  });
};
const first = runHook('sess-recv');
ok(/📨/.test(first), 'receiving hook surfaces the 📨 message block');
ok(first.includes(NOTE), 'the note text reaches the peer session verbatim');
ok(/from sender-s/.test(first), 'the sender label is the stable logical session id');

// ── 3. Explicit receipt: acknowledgement replays until consumption ─────────
const second = runHook('sess-recv');
ok(second.includes(NOTE), 'same session, next prompt → note replays before later-action acknowledgement');
const third = runHook('sess-recv');
ok(!third.includes(NOTE), 'same session, third prompt → the lease auto-consumes instead of replaying');
const laneAfterAck = JSON.parse(fs.readFileSync(laneFileFor(path.join(proj, 'brain.klypix'), home), 'utf8'));
const firstMessage = laneAfterAck.messages.find((message) => message.text === NOTE);
const firstDelivery = firstMessage?.deliveries?.find((delivery) => delivery.recipientId === 'sess-recv');
ok(firstMessage?.deliveryVersion === 3
  && firstDelivery?.state === 'consumed' && firstDelivery?.consumedVia === 'auto-lease',
'the shared lane persists the pending → offered → acknowledged → auto-lease-consumed receipt');
const consumed = consumeMessageReceipt({
  brainPath: path.join(proj, 'brain.klypix'),
  sessionId: 'sess-recv',
  messageId: firstMessage?.id,
  offerToken: firstDelivery?.offerToken,
  actionId: 'lane-e2e-consume-main',
  home,
});
ok(consumed.ok === true && consumed.status === 'consumed',
  `an exact message id + offer token records explicit consumption (${consumed.status}/${consumed.reason || 'ok'})`);
ok(!runHook('sess-recv').includes(NOTE), 'consumed note stays quiet on later prompts');

// ── 4. Self-echo guard: the SENDER (whose transcript holds the brain_message
//      tool_use) never gets its own note back; a third session still does ────
const NOTE2 = 'deploying the lane fix — hold your pushes for 5 minutes';
upsertSession({ brainPath: path.join(proj, 'brain.klypix'), id: 'sess-third',
  logicalSessionId: 'sess-third', identitySource: 'claude-lifecycle',
  client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', home });
try {
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.chdir(proj);
  const { opBrainMessage } = await import('../src/klypix-core.mjs');
  await opBrainMessage({
    vault: proj, text: NOTE2, to: 'all', via: 'claude-code', from: 'sess-sender', sessionId: 'sess-sender',
  });
} finally {
  process.chdir(prevCwd);
  process.env.HOME = prevEnv.HOME; process.env.USERPROFILE = prevEnv.USERPROFILE;
}
const senderTranscript = path.join(home, 'sender-transcript.jsonl');
fs.writeFileSync(senderTranscript, JSON.stringify({
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__klypix-canvas__brain_message', id: 't1', input: { text: NOTE2, to: 'all' } }] },
}) + '\n');
const senderView = runHook('sess-sender', senderTranscript);
ok(!senderView.includes(NOTE2), 'sender (transcript holds the tool_use) does NOT get its own note back');
const thirdView = runHook('sess-third');
ok(thirdView.includes(NOTE2), 'a different session still receives the note');

// ── 5. Incident migration: legacy seen[] is only an OFFER, never an ack ────
const legacyText = 'legacy seen was stamped before stdout reached the model';
const laneFile = laneFileFor(path.join(proj, 'brain.klypix'), home);
const legacyLane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
legacyLane.messages.push({
  id: 'legacy-false-positive', from: 'legacy-sender', to: 'all', text: legacyText,
  ts: Date.now(), candidateIds: ['sess-legacy'], seen: ['sess-legacy'],
});
fs.writeFileSync(laneFile, JSON.stringify(legacyLane), 'utf8');
const legacyReplay = runHook('sess-legacy');
ok(legacyReplay.includes(legacyText), 'legacy seen[] row replays once instead of being trusted as acknowledged');
const legacyAck = runHook('sess-legacy');
ok(!legacyAck.includes(legacyText), 'legacy row lease-consumes on the action after its acknowledgement');
const migratedLegacy = JSON.parse(fs.readFileSync(laneFile, 'utf8')).messages
  .find((message) => message.id === 'legacy-false-positive');
const migratedDelivery = migratedLegacy?.deliveries?.find((delivery) => delivery.recipientId === 'sess-legacy');
consumeMessageReceipt({ brainPath: path.join(proj, 'brain.klypix'), sessionId: 'sess-legacy',
  messageId: migratedLegacy?.id, offerToken: migratedDelivery?.offerToken,
  actionId: 'lane-e2e-consume-legacy', home });
ok(!runHook('sess-legacy').includes(legacyText), 'legacy row stays quiet only after explicit consumption');

// ── 6. Stop retry: a busy lane stages durably, then another hook drains it ──
const lockTarget = 'sess-lock-target-full-123';
runHook(lockTarget); // make the full-id target live before the send-time snapshot
const lockNote = 'this marker must survive a lane-lock timeout';
const lockTranscript = path.join(home, 'lock-message-transcript.jsonl');
fs.writeFileSync(lockTranscript, JSON.stringify({
  uuid: 'assistant-event-stable-1',
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: `🧠 MSG [${lockTarget}]: ${lockNote}` }] },
}) + '\n');
const runCapture = () => execFileSync(process.execPath, [HOOK, '--capture'], {
  cwd: proj,
  env: { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_NUDGE: 'off' },
  encoding: 'utf8',
  input: JSON.stringify({ session_id: 'sess-lock-sender', transcript_path: lockTranscript }),
});
const lockedLane = laneFileFor(path.join(proj, 'brain.klypix'), home);
fs.writeFileSync(`${lockedLane}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
runCapture();
let afterRefusedWrite = JSON.parse(fs.readFileSync(lockedLane, 'utf8'));
ok(!afterRefusedWrite.messages.some((message) => message.text === lockNote),
  'a forced lane-lock timeout does not race an unsafe direct write');
fs.unlinkSync(`${lockedLane}.lock`);
const drainedOffer = runHook(lockTarget);
ok(drainedOffer.includes(lockNote),
  'a later hook drains the durable outbox and offers the full-session-id-directed note');
const recoveredAck = runHook(lockTarget);
const recoveredReplay = runHook(lockTarget);
ok(recoveredAck.includes(lockNote) && !recoveredReplay.includes(lockNote),
  'the recovered note follows the same offer → acknowledge → auto-lease lifecycle');
const recoveredMessage = JSON.parse(fs.readFileSync(lockedLane, 'utf8')).messages
  .find((message) => message.text === lockNote);
const recoveredDelivery = recoveredMessage?.deliveries?.find((delivery) => delivery.recipientId === lockTarget);
consumeMessageReceipt({ brainPath: path.join(proj, 'brain.klypix'), sessionId: lockTarget,
  messageId: recoveredMessage?.id, offerToken: recoveredDelivery?.offerToken,
  actionId: 'lane-e2e-consume-recovered', home });
ok(!runHook(lockTarget).includes(lockNote), 'the recovered note stays quiet after explicit consumption');
runCapture(); // the real Stop hook re-scans the entire transcript
afterRefusedWrite = JSON.parse(fs.readFileSync(lockedLane, 'utf8'));
ok(afterRefusedWrite.messages.filter((message) => message.text === lockNote).length === 1,
  'stable marker ids make repeated Stop scans idempotent instead of reposting an acknowledged note');

const peerSameText = 'a real peer may repeat text from my old brain_message call';
upsertSession({ brainPath: path.join(proj, 'brain.klypix'), id: 'sess-identical-text',
  logicalSessionId: 'sess-identical-text', identitySource: 'claude-lifecycle',
  client: 'claude-code', channel: 'lifecycle', event: 'UserPromptSubmit', home });
try {
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.chdir(proj);
  const { opBrainMessage } = await import('../src/klypix-core.mjs');
  await opBrainMessage({ vault: proj, text: peerSameText, to: 'sess-identical-text', from: 'peer-stable-id', via: 'cursor' });
} finally {
  process.chdir(prevCwd);
  process.env.HOME = prevEnv.HOME; process.env.USERPROFILE = prevEnv.USERPROFILE;
}
const identicalTranscript = path.join(home, 'identical-text-transcript.jsonl');
fs.writeFileSync(identicalTranscript, JSON.stringify({
  message: { role: 'assistant', content: [{
    type: 'tool_use', name: 'mcp__klypix-canvas__brain_message', id: 'same-text-tool',
    input: { text: peerSameText, to: 'all' },
  }] },
}) + '\n');
ok(runHook('sess-identical-text', identicalTranscript).includes(peerSameText),
  'transcript text never suppresses identical text from a stable peer sender');

// ── 7. Production MCP tool path: refresh a /clear-rotated host id BEFORE the
// send snapshots recipients. This catches the worker-wiring defect a direct
// opBrainMessage test cannot see.
const registeredHome = path.join(os.tmpdir(), `klypix-lane-registered-${process.pid}`);
fs.rmSync(registeredHome, { recursive: true, force: true });
fs.mkdirSync(registeredHome, { recursive: true });
// This lane exercises the lifecycle hostmap used by non-Codex hosts. Codex
// threads deliberately ignore host-pid maps and are covered by the host-authored
// request-metadata assertions in request-identity.mjs.
const registeredClient = new Client({ name: 'cursor-registered-message-test', version: '1.0.0' }, { capabilities: {} });
const registeredTransport = new StdioClientTransport({
  command: process.execPath,
  args: [WORKER, '--vault', proj],
  env: {
    ...process.env,
    HOME: registeredHome,
    USERPROFILE: registeredHome,
    KLYPIX_SESSION_ID: 'pre-clear-sender',
    KLYPIX_HOST_PID: '424242',
    CLAUDE_PID: '',
    KLYPIX_AUTO_UPDATE: '0',
  },
});
await registeredClient.connect(registeredTransport);
const registeredBrain = path.join(proj, 'brain.klypix');
const registeredLane = laneFileFor(registeredBrain, registeredHome);
upsertSession({
  brainPath: registeredBrain,
  id: 'registered-receiver',
  client: 'cursor',
  channel: 'mcp',
  intent: 'receive registered tool message',
  home: registeredHome,
});
const sidecarWindowNote = postPresenceMessage({
  brainPath: registeredBrain,
  from: 'registered-receiver',
  to: 'pre-clear-sender',
  text: 'A inbox must remain pending during sidecar-ahead.',
  home: registeredHome,
});
fs.writeFileSync(registeredLane.replace(/\.json$/, '.hostmap'), JSON.stringify({
  424242: { sessionId: 'post-clear-sender', ts: Date.now() },
}));
const sidecarDeferredCall = await registeredClient.callTool({
  name: 'brain_message',
  arguments: { text: 'this handler must not run', to: 'all' },
});
const afterSidecarDeferredCall = fs.readFileSync(registeredLane, 'utf8');
const afterSidecarData = JSON.parse(afterSidecarDeferredCall);
ok(sidecarDeferredCall.isError === true
  && sidecarDeferredCall.structuredContent?.status === 'sidecar-ahead'
  && sidecarDeferredCall.content?.some((block) => /No handler, presence identity, or queued-message delivery changed/i.test(block.text || '')),
'the universal registered-tool pre-handler defers while B exists only in hostmap');
const sidecarHandlerBlocked = !afterSidecarData.messages.some((message) => message.text === 'this handler must not run');
const sidecarNotePending = messageDeliveryState(afterSidecarData.messages
  .find((message) => message.id === sidecarWindowNote.message?.id), 'pre-clear-sender') === 'pending';
ok(sidecarHandlerBlocked && sidecarNotePending,
'a sidecar-ahead registered action leaves its handler unrun and A delivery pending');
upsertSession({
  brainPath: registeredBrain,
  id: 'post-clear-sender',
  client: 'cursor',
  channel: 'lifecycle',
  event: 'UserPromptSubmit',
  hostPid: 424242,
  home: registeredHome,
});
const registeredResult = await registeredClient.callTool({
  name: 'brain_message',
  arguments: { text: 'registered tool identity refresh', to: 'all' },
});
const registeredData = JSON.parse(fs.readFileSync(registeredLane, 'utf8'));
const registeredMessage = registeredData.messages.find((message) => message.text === 'registered tool identity refresh');
ok(registeredResult.isError !== true
  && registeredMessage?.from === 'post-clear-sender'
  && registeredMessage.candidateIds?.includes('registered-receiver')
  && !registeredMessage.candidateIds?.includes('post-clear-sender')
  && !registeredMessage.candidateIds?.includes('pre-clear-sender'),
'the registered brain_message tool refreshes a rotated sender id before recipient snapshotting');

const probeMessage = postPresenceMessage({
  brainPath: registeredBrain,
  from: 'registered-receiver',
  to: 'post-clear-sender',
  text: 'registered hidden probe must not consume this',
  home: registeredHome,
});
const registeredProbeState = () => {
  const data = JSON.parse(fs.readFileSync(registeredLane, 'utf8'));
  return messageDeliveryState(data.messages.find((message) => message.id === probeMessage.message?.id), 'post-clear-sender');
};
await registeredClient.callTool({ name: 'brain_sync', arguments: { phase: 'checkpoint', include_context: false } });
await registeredClient.callTool({ name: 'brain_sync', arguments: { phase: 'checkpoint', include_context: false } });
ok(registeredProbeState() === 'pending',
  'the registered brain_sync path leaves messages pending across discarded include_context:false probes');
const registeredOffer = await registeredClient.callTool({ name: 'list_canvases', arguments: {} });
ok(registeredProbeState() === 'offered'
  && registeredOffer.content?.some((block) => block.text?.includes('registered hidden probe must not consume this')),
'the next supported registered-tool result offers the probe message into model context');
const registeredAck = await registeredClient.callTool({ name: 'list_canvases', arguments: {} });
ok(registeredProbeState() === 'acknowledged'
  && registeredAck.content?.some((block) => block.text?.includes('registered hidden probe must not consume this')),
'a later registered-tool action replays and acknowledges the offer');
const registeredMessageAfterAck = JSON.parse(fs.readFileSync(registeredLane, 'utf8')).messages
  .find((message) => message.id === probeMessage.message?.id);
const registeredDelivery = registeredMessageAfterAck?.deliveries
  ?.find((delivery) => delivery.recipientId === 'post-clear-sender');
const registeredConsumed = await registeredClient.callTool({
  name: 'brain_message_receipt',
  arguments: { message_id: probeMessage.message?.id, offer_token: registeredDelivery?.offerToken },
});
ok(registeredConsumed.isError !== true && registeredProbeState() === 'consumed',
  'the registered receipt tool records explicit token-bound consumption');
const registeredQuiet = await registeredClient.callTool({ name: 'list_canvases', arguments: {} });
ok(!registeredQuiet.content?.some((block) => block.text?.includes('registered hidden probe must not consume this')),
  'a consumed registered-tool message stays quiet');
await registeredClient.close();
fs.rmSync(registeredHome, { recursive: true, force: true });

for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ lane-message: all assertions passed');
process.exit(failures ? 1 : 0);
