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
//   4. run it a third time → the acknowledged note stays quiet
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
const runHook = (sid, tp) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main()
  return execFileSync(process.execPath, [HOOK, '--prompt'], {
    cwd: proj, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, prompt: 'continue the refactor', ...(tp ? { transcript_path: tp } : {}) }),
  });
};
const first = runHook('sess-recv');
ok(/📨/.test(first), 'receiving hook surfaces the 📨 message block');
ok(first.includes(NOTE), 'the note text reaches the peer session verbatim');
ok(/from sender-s/.test(first), 'the sender label is the stable logical session id');

// ── 3. Two-step receipt: replay once, then stay quiet ───────────────────────
const second = runHook('sess-recv');
ok(second.includes(NOTE), 'same session, next prompt → note replays before later-action acknowledgement');
const third = runHook('sess-recv');
ok(!third.includes(NOTE), 'same session, third prompt → acknowledged note stays quiet');
const laneAfterAck = JSON.parse(fs.readFileSync(laneFileFor(path.join(proj, 'brain.klypix'), home), 'utf8'));
const firstMessage = laneAfterAck.messages.find((message) => message.text === NOTE);
ok(firstMessage?.deliveryVersion === 2
  && firstMessage.deliveries?.find((delivery) => delivery.recipientId === 'sess-recv')?.state === 'acknowledged',
'the shared lane persists the pending → offered → acknowledged receipt');

// ── 4. Self-echo guard: the SENDER (whose transcript holds the brain_message
//      tool_use) never gets its own note back; a third session still does ────
const NOTE2 = 'deploying the lane fix — hold your pushes for 5 minutes';
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
const legacyQuiet = runHook('sess-legacy');
ok(!legacyQuiet.includes(legacyText), 'legacy row stays quiet after the replay records a later-action acknowledgement');

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
  env: { ...process.env, HOME: home, USERPROFILE: home },
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
ok(runHook(lockTarget).includes(lockNote) && !runHook(lockTarget).includes(lockNote),
  'the recovered note follows the same offer → replay/ack → quiet lifecycle');
runCapture(); // the real Stop hook re-scans the entire transcript
afterRefusedWrite = JSON.parse(fs.readFileSync(lockedLane, 'utf8'));
ok(afterRefusedWrite.messages.filter((message) => message.text === lockNote).length === 1,
  'stable marker ids make repeated Stop scans idempotent instead of reposting an acknowledged note');

const peerSameText = 'a real peer may repeat text from my old brain_message call';
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
const registeredClient = new Client({ name: 'codex-registered-message-test', version: '1.0.0' }, { capabilities: {} });
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
fs.writeFileSync(registeredLane.replace(/\.json$/, '.hostmap'), JSON.stringify({
  424242: { sessionId: 'post-clear-sender', ts: Date.now() },
}));
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
await registeredClient.close();
fs.rmSync(registeredHome, { recursive: true, force: true });

for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ lane-message: all assertions passed');
process.exit(failures ? 1 : 0);
