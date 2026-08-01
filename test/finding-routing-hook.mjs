// Finding routing — the HOOK half (DETECT → persist → DELIVER), end to end.
//
// test/finding-routing.mjs proves the pure ROUTE engine. This one runs the REAL
// global-brain-hook against synthetic transcripts in a hermetic HOME/project and
// asserts the three things only the wiring can get wrong:
//   • the verify gate + own-scope filter actually reach the sidecar;
//   • the draft SURFACES with its "why" and one-paste send line, once per session;
//   • the shared sidecar survives BOTH writers — a rule-draft write must not
//     destroy a pending finding, and vice versa. That is the highest-consequence
//     regression this feature can have, so it is tested explicitly.
//
// Run:  node test/finding-routing-hook.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const TXT = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const BASH = (id, command) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});

// A verified, foreign, defect-shaped finding — the exact shape of the 2026-08-01
// audit item that started this lane.
const FINDING = '🧠 BRAIN [Docs]: CLAUDE.md:135 names scripts/global-brain-hook.mjs as source of truth '
  + 'but that file is GENERATED — an agent obeying it breaks the prebuild check';

async function makeProject(tag) {
  const home = path.join(os.tmpdir(), 'klypix-froute-home-' + tag);
  const proj = path.join(os.tmpdir(), 'klypix-froute-proj-' + tag);
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const brain = path.join(proj, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
  const sidecarFile = path.join(proj, '.claude', 'brain-rule-drafts.json');
  const lane = laneFileFor(brain, home);
  const run = (mode, { transcript = [], sessionId = 'self-' + tag, prompt } = {}) => {
    const tp = path.join(home, `t-${mode.replace(/\W/g, '')}-${sessionId}-${transcript.length}.jsonl`);
    fs.writeFileSync(tp, transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KLYPIX_BRAIN_NO_MAIN;
    return execFileSync(process.execPath, [HOOK, mode], {
      cwd: proj, env, encoding: 'utf8',
      input: JSON.stringify({ session_id: sessionId, transcript_path: tp, ...(prompt !== undefined ? { prompt } : {}) }),
    });
  };
  return {
    proj, lane, run,
    // Seed the presence lane: this session owns src/, a peer owns CLAUDE.md.
    seedLane: (sessions, messages = []) => {
      fs.mkdirSync(path.dirname(lane), { recursive: true });
      fs.writeFileSync(lane, JSON.stringify({ sessions, messages }));
    },
    sidecar: () => { try { return JSON.parse(fs.readFileSync(sidecarFile, 'utf8')); } catch { return {}; } },
    findings: () => { try { return JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).findings || []; } catch { return []; } },
    laneData: () => { try { return JSON.parse(fs.readFileSync(lane, 'utf8')); } catch { return {}; } },
    writeLane: (obj) => fs.writeFileSync(lane, JSON.stringify(obj, null, 2)),
    writeSidecar: (obj) => fs.writeFileSync(sidecarFile, JSON.stringify(obj, null, 2)),
    resetSeen: () => { try { fs.rmSync(path.join(proj, '.claude', 'brain-capture-state.json'), { force: true }); } catch { /* */ } },
    cleanup: () => { for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

const peerLane = (tag) => ([
  { id: 'self-' + tag, client: 'claude-code', branch: 'master', intent: 'canvas work', files: ['src/canvas/KlypixCanvas.tsx'], lastSeen: Date.now(), startedAt: Date.now() - 600_000, channelSeen: {} },
  { id: 'docowner-1', client: 'claude-code', branch: 'master', intent: 'doc audit follow-ups', files: ['CLAUDE.md'], lastSeen: Date.now(), startedAt: Date.now() - 600_000, channelSeen: {} },
]);

// ── H1: a VERIFIED foreign finding is drafted and routed ───────────────────
{
  const P = await makeProject('h1');
  P.seedLane(peerLane('h1'));
  P.run('--capture', { transcript: [TXT(FINDING), BASH('t1', 'npm test')] });
  const f = P.findings();
  ok(f.length === 1, `H1.1: one routed finding drafted (got ${f.length})`);
  ok(f[0]?.verdict === 'routed' && f[0]?.targets?.[0]?.id === 'docowner-1',
    `H1.2: routed to the session that declared CLAUDE.md (got ${f[0]?.targets?.[0]?.id})`);
  ok(f[0]?.line === 135, 'H1.3: the cited line survives into the draft');
  ok(/declared `claude\.md`/.test(f[0]?.reason || ''), 'H1.4: the stored reason names the evidence');
  ok(!/^Docs:/.test(f[0]?.text || '') && !/#file-/.test(f[0]?.text || ''),
    'H1.5: the stored text is the CLAIM — no area prefix, no tag line');
  P.cleanup();
}

// ── H2: the verify gate holds at the hook boundary ────────────────────────
{
  const P = await makeProject('h2');
  P.seedLane(peerLane('h2'));
  P.run('--capture', { transcript: [TXT(FINDING)] });   // marker only — nothing verified
  ok(P.findings().length === 0, 'H2.1: an unverified finding is never drafted (verify gate holds end to end)');
  P.cleanup();
}

// ── H3: R4 — a finding about the session's OWN file never becomes a draft ──
{
  const P = await makeProject('h3');
  P.seedLane(peerLane('h3'));
  P.run('--capture', {
    transcript: [
      TXT('🧠 BRAIN [Canvas]: src/canvas/KlypixCanvas.tsx leaks a listener on every tab switch'),
      BASH('t1', 'npm test'),
    ],
  });
  ok(P.findings().length === 0, 'H3.1: a finding about the sender\'s own declared file is filtered at the source (R4)');
  P.cleanup();
}

// ── H4: the draft SURFACES, once per session, with why + one-paste send ───
{
  const P = await makeProject('h4');
  P.seedLane(peerLane('h4'));
  P.run('--capture', { transcript: [TXT(FINDING), BASH('t1', 'npm test')] });
  const first = P.run('--prompt', { prompt: 'what next?' });
  ok(/Finding\(s\) you verified that belong to SOMEONE ELSE/.test(first), 'H4.1: the routed finding surfaces on the next prompt');
  // 8-char id prefix, matching every other peer surface AND the message-targeting
  // predicate (agent-presence messageTargetsSession matches on id.slice(0,8)) —
  // so the paste that this line produces actually reaches the peer.
  ok(/why: docowner — declared `claude\.md`/.test(first), 'H4.2: it renders the "why this session" line');
  ok(/send → `🧠 MSG \[docowner\]: CLAUDE\.md:135/.test(first), 'H4.3: approval is ONE paste, leading with the artifact');
  // Anchored INSIDE the block: the loose form passed even when the block was
  // missing entirely, because the same words appear in the legend footer.
  const block = (first.split('## 📬 Finding(s)')[1] || '').split('\n## ')[0];
  ok(/nothing was written to the brain/.test(block), 'H4.4: it states that nothing was written and nothing was sent');
  const second = P.run('--prompt', { prompt: 'and now?' });
  ok(!/Finding\(s\) you verified that belong to SOMEONE ELSE/.test(second),
    'H4.5: the same session is not re-nagged with a draft it was already shown');
  P.cleanup();
}

// ── H5: R1 — no owner → held, no send line, offers a durable alternative ──
{
  const P = await makeProject('h5');
  P.seedLane([peerLane('h5')[0]]);   // only this session is live — nobody owns CLAUDE.md
  P.run('--capture', { transcript: [TXT(FINDING), BASH('t1', 'npm test')] });
  const f = P.findings();
  ok(f.length === 1 && f[0].verdict === 'nobody', 'H5.1: with no owner the finding is HELD, not discarded (R1)');
  const out = P.run('--prompt', { prompt: 'status' });
  const block = (out.split('## 📬 Finding(s)')[1] || '').split('\n## ')[0];
  ok(/no live session owns this path/.test(block), 'H5.2: the draft says it is held');
  ok(block && !/send → /.test(block), 'H5.3: nothing is addressed to nobody');
  ok(/🧠 BRAIN \[Docs\]/.test(block), 'H5.4: it offers the durable brain_note alternative instead');
  P.cleanup();
}

// ── H6: the shared sidecar survives BOTH writers (trap 1) ─────────────────
// The old writer serialized `{ drafts }` only, so any rule-draft write would have
// silently destroyed every pending finding. This is the regression that matters.
{
  const P = await makeProject('h6');
  P.seedLane(peerLane('h6'));
  P.run('--capture', { transcript: [TXT(FINDING), BASH('t1', 'npm test')] });
  ok(P.findings().length === 1, 'H6.1: a finding is pending');
  P.resetSeen();
  // A trap-shaped fix in a LATER turn → the rule-draft writer runs.
  P.run('--capture', {
    transcript: [
      TXT('🧠 BRAIN [Fixes]: the fix was to dedup zKeys before REORDER — duplicates silently no-op'),
      BASH('t2', 'npm run build'),
    ],
  });
  const side = P.sidecar();
  ok(Array.isArray(side.drafts) && side.drafts.length >= 1, 'H6.2: the rule-draft writer wrote its own key');
  ok(Array.isArray(side.findings) && side.findings.length === 1,
    'H6.3: …and did NOT destroy the pending finding (sibling keys preserved)');
  P.cleanup();
}

// ── H7: the receipt has a REAL, non-repeating human-visible surface ───────
// Acceptance gate 3: SessionStart shows one compact line; UserPromptSubmit does
// not repeat it on every turn. `seen` means rendered-to, never read-by-human.
{
  const P = await makeProject('h7');
  const sessions = [
    ...peerLane('h7'),
    { id: 'peer-two', client: 'codex', branch: 'master', intent: 'other work', files: ['src/other.ts'], lastSeen: Date.now(), startedAt: Date.now() - 600_000, channelSeen: {} },
  ];
  P.seedLane(sessions, [{
    id: 'msg-h7', from: 'self-h7', to: 'all', text: 'verified note',
    ts: Date.now() - 60_000, candidateIds: ['docowner-1', 'peer-two'], seen: ['docowner-1'],
  }]);
  const start = P.run('--read', { sessionId: 'self-h7' });
  ok(/Your last note \(1m ago\): shown to 1 of 2 peers · pending peer-two\./.test(start),
    'H7.1: SessionStart renders the live message receipt with an honest denominator and pending id');
  const prompt = P.run('--prompt', { sessionId: 'self-h7', prompt: 'continue' });
  ok(!/Your last note/.test(prompt),
    'H7.2: the receipt does not repeat in the per-prompt path');
  P.cleanup();
}

// ── H8: the Claude marker writer snapshots the SEND-time audience ─────
// Without this, a recipient ending before the next SessionStart erases the
// denominator, while a later viewer can inflate the numerator.
{
  const P = await makeProject('h8');
  P.seedLane(peerLane('h8'));
  P.run('--capture', { transcript: [TXT('🧠 MSG [all]: verified cross-lane note')] });
  const data = P.laneData();
  const message = data.messages?.find((m) => m.text === 'verified cross-lane note');
  ok(message?.candidateIds?.join() === 'docowner-1',
    'H8.1: the Claude marker writer snapshots the live recipient id at send time');
  message.seen = ['docowner-1'];
  data.sessions = data.sessions.filter((s) => s.id === 'self-h8');
  P.writeLane(data);
  const start = P.run('--read', { sessionId: 'self-h8' });
  ok(/Your last note .*shown to all 1 peer\(s\) that were live\./.test(start),
    'H8.2: the receipt denominator survives after that recipient exits');
  P.cleanup();
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ finding-routing-hook: all assertions passed');
process.exit(failures ? 1 : 0);
