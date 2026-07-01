// E2E for brain_message (1.16.0) — the MCP twin of the hook's 🧠 MSG lane.
// THE contract under test: a message posted by the MCP op (opBrainMessage, used by
// hookless clients like Cursor/Cline) is READ by the real Claude Code hook — i.e.
// the two independent lane implementations (klypix-core vs global-brain-hook)
// resolve the SAME lane file and speak the same message shape. If they drift,
// this fails — that's the point.
//
//   1. post a note via opBrainMessage (in-process, temp HOME + project)
//   2. run the REAL hook (--prompt) as a receiving session → note IS delivered
//   3. run it again, same session → note is NOT re-delivered (seen-ack)
//
// Run:  node test/lane-message.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap } from '../src/klypix-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');

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
  const res = await opBrainMessage({ vault: proj, text: NOTE, to: 'all', via: 'cursor' });
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
ok(/from cursor/.test(first), 'the sender label (MCP client name) is shown');

// ── 3. Delivered ONCE: a second prompt of the same session stays quiet ──────
const second = runHook('sess-recv');
ok(!second.includes(NOTE), 'same session, next prompt → note NOT re-delivered (seen-ack)');

// ── 4. Self-echo guard: the SENDER (whose transcript holds the brain_message
//      tool_use) never gets its own note back; a third session still does ────
const NOTE2 = 'deploying the lane fix — hold your pushes for 5 minutes';
try {
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.chdir(proj);
  const { opBrainMessage } = await import('../src/klypix-core.mjs');
  await opBrainMessage({ vault: proj, text: NOTE2, to: 'all', via: 'claude-code' });
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

for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ lane-message: all assertions passed');
process.exit(failures ? 1 : 0);
