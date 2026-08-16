// Decay-aware status guard — HOOK-LANE regression test (2026-07-28 post-mortem).
// Class-B incidents (a peer's stale build/deploy message relayed as CURRENT
// state) are fixed by ENGINE-emitted ⏱️ LAST-KNOWN stamps at every message
// delivery surface. This suite is hermetic: it drives the REAL delivery code
// with MOCK classifiers (the real classifyDecay lives in klypix-format.mjs and
// is the lib lane's suites' job), proving:
//   1. the Claude hook's messageFooter stamps an aged (>6h) fast-decay message
//      and leaves a fresh one and an aged NON-status one unstamped;
//   2. typeof-guard degradation — an old lib without classifyDecay (or a
//      throwing classifier) → no stamp, never a throw;
//   3. the Codex delivery lane (stampReceivedMessages) applies the identical
//      stamp AFTER the 400-char render slice, with per-MESSAGE dedup — a ⏱
//      inside one message's quoted text never suppresses another's stamp;
//   3b. the MCP delivery lane (createMcpPresence) stamps all four surfaces —
//      pollInbox logging, decorateToolResult notices, brain_sync text, and
//      structured.messages ({ lastKnown, age, stampText }) — and degrades to
//      unstamped delivery when no classifier is injected (old bundle);
//   4. brain-doctor's DECAY layer fires on a stub lib lacking the export, on a
//      renderer that leaves a synthetic 20h-old stale claim unstamped, and on
//      a deployed bundle that predates the feature — and degrades ('unknown')
//      on an unloadable engine instead of crashing;
//   5. splitMarkerSuffixes parses the new `verify:` suffix without letting it
//      leak into ev:'s value (the swallowing hazard) in either order.
// Run:  node test/decay-hook.mjs        (exit 0 = pass, 1 = fail)
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const HOUR = 3_600_000;
const STAMP_RE = /⏱️ This message is \d+[hd] old and contains build\/deploy status — treat as LAST KNOWN, verify live before reporting it\./;
// Mock classifier: fast-decay = completed-status verbs near release nouns.
const mockClassify = (t) => /\b(uploaded|published|deployed|installed|rolled out|live)\b/i.test(String(t || ''));

// ── Hermetic home/project — set env + cwd BEFORE importing the hook module
// (CWD/BRAIN/SESSIONS_FILE are captured at import time). KLYPIX_BRAIN_NO_MAIN
// is the hook's documented test seam: pure exports, main() skipped.
// UNIQUE PER RUN, deliberately. These were fixed paths cleared with an
// unguarded rmSync at import time, which made the suite fail in exactly the
// conditions this product is built for: two runs racing collide on the same
// directory, and — the case that actually bit — a run killed mid-flight leaves
// the stub brain open in some process, so every LATER run dies at import with
// EPERM before a single assertion executes. A test that cannot be re-run after
// an interrupted run is not a gate. mkdtemp costs nothing and removes the whole
// class; teardown stays best-effort, because a leftover unique dir is harmless.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decay-hook-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decay-hook-proj-'));
fs.mkdirSync(path.join(home, '.claude', 'project-brain', 'sessions'), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'brain.klypix'), 'stub');   // must EXIST before import (lane key uses realpath)

const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NOMAIN: process.env.KLYPIX_BRAIN_NO_MAIN };
const prevCwd = process.cwd();
process.env.HOME = home; process.env.USERPROFILE = home; process.env.KLYPIX_BRAIN_NO_MAIN = '1';
process.chdir(proj);

let exitCode = 1;
try {
  const hook = await import('../src/global-brain-hook.mjs');
  const { decayStampForMessage, messageFooter, splitMarkerSuffixes } = hook;

  // Replicate the hook's lane-file key (drift between the implementations is
  // test/lane-message.mjs's job; here we only need to WRITE the lane).
  const laneCanon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
  const sha16 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
  const laneFile = path.join(home, '.claude', 'project-brain', 'sessions',
    `${sha16(normBrainPath(laneCanon(path.resolve(proj, 'brain.klypix'))))}.json`);

  const now = Date.now();
  const writeLane = () => fs.writeFileSync(laneFile, JSON.stringify({
    // Delivery now requires the exact recipient to be live. Keep each fixture
    // recipient explicit instead of relying on a nonexistent-row broadcast.
    sessions: ['sess-claude', 'sess-old-lib', 'sess-throwing', 'sess-no-lib'].map((id) => ({ id, lastSeen: now })),
    messages: [
      { id: 'm-aged-fast', from: 'peer-a', to: 'all', text: 'TestFlight build 26 uploaded — processing green', ts: now - 12 * HOUR, seen: [] },
      { id: 'm-fresh-fast', from: 'peer-a', to: 'all', text: 'v1.41.0 published to npm just now', ts: now - 1 * HOUR, seen: [] },
      { id: 'm-aged-slow', from: 'peer-b', to: 'all', text: 'we agreed the tidy layout uses diagonal projection math', ts: now - 12 * HOUR, seen: [] },
    ],
  }));

  // ── 1. messageFooter stamps aged fast-decay; fresh + non-status stay clean ──
  writeLane();
  const footer = messageFooter('sess-claude', null, { classifyDecay: mockClassify });
  ok(footer.includes('build 26 uploaded'), 'messageFooter delivers the aged fast-decay message');
  const lines = footer.split('\n');
  const agedIdx = lines.findIndex(l => l.includes('build 26 uploaded'));
  const agedStampIdx = lines.findIndex((line, index) => index > agedIdx && index <= agedIdx + 2 && STAMP_RE.test(line));
  ok(agedIdx >= 0 && agedStampIdx > agedIdx,
    'aged (12h) fast-decay message gets the ⏱️ LAST-KNOWN stamp on its own line after receipt metadata');
  ok((footer.match(/⏱️ This message is/g) || []).length === 1, 'exactly ONE stamp — fresh fast-decay and aged non-status messages are NOT stamped');
  ok(footer.includes('12h old'), 'the stamp renders the age in hours (12h), not raw minutes');

  // ── 2. typeof-guard degradation (old lib / broken classifier) ───────────────
  writeLane();
  let degraded = '';
  try { degraded = messageFooter('sess-old-lib', null, {}); ok(true, 'lib without classifyDecay → no throw'); }
  catch { ok(false, 'lib without classifyDecay → no throw'); }
  ok(degraded.includes('build 26 uploaded') && !degraded.includes('⏱️'), 'old lib → messages still delivered, just unstamped');
  writeLane();
  let threw = false, thrownOut = '';
  try { thrownOut = messageFooter('sess-throwing', null, { classifyDecay: () => { throw new Error('boom'); } }); } catch { threw = true; }
  ok(!threw && thrownOut.includes('build 26 uploaded') && !thrownOut.includes('⏱️'), 'throwing classifier → delivery intact, no stamp, no throw');
  writeLane();
  try { const noLib = messageFooter('sess-no-lib', null, undefined); ok(noLib.includes('build 26 uploaded') && !noLib.includes('⏱️'), 'missing lib arg → delivery intact, no stamp'); }
  catch { ok(false, 'missing lib arg → delivery intact, no stamp'); }

  // ── decayStampForMessage unit surface (threshold + shapes) ──────────────────
  const lib = { classifyDecay: mockClassify };
  ok(STAMP_RE.test(decayStampForMessage('build 7 uploaded', now - 7 * HOUR, now, lib)), 'unit: 7h-old fast-decay → stamped');
  ok(decayStampForMessage('build 7 uploaded', now - 5 * HOUR, now, lib) === '', 'unit: 5h-old (under 6h threshold) → no stamp');
  ok(decayStampForMessage('build 7 uploaded', 0, now, lib) === '', 'unit: missing ts → no stamp (never guess age)');
  ok(/\b2d\b/.test(decayStampForMessage('build 7 uploaded', now - 60 * HOUR, now, lib)), 'unit: 60h-old → age renders as days (2d)');
  ok(decayStampForMessage('we refactored the parser', now - 12 * HOUR, now, lib) === '', 'unit: aged NON-status text → no stamp');
  ok(STAMP_RE.test(decayStampForMessage('x uploaded', now - 12 * HOUR, now, { classifyDecay: () => ({ fast: true }) })), 'unit: {fast:true} object shape accepted');
  ok(decayStampForMessage('x uploaded', now - 12 * HOUR, now, { classifyDecay: () => ({ decay: 'slow' }) }) === '', 'unit: slow-shaped object → no stamp (precision-first)');

  // ── 3. Codex lane parity: stampReceivedMessages ─────────────────────────────
  const codex = await import('../src/codex-brain-hook.mjs');   // KLYPIX_BRAIN_NO_MAIN set → pure exports
  const { stampReceivedMessages } = codex;
  const longTail = 'the CI matrix finished and after the artifact signing step completed the pipeline build 7 uploaded to TestFlight';
  const codexMsgs = [
    { id: 'c1', from: 'peer-a', text: 'rollout flipped to LIVE for build 26', ts: now - 13 * HOUR, seen: [] },
    { id: 'c2', from: 'peer-a', text: 'v1.41.0 published seconds ago', ts: now - 1 * HOUR, seen: [] },
    { id: 'c3', from: 'peer-b', text: 'decided to keep the reducer flat', ts: now - 13 * HOUR, seen: [] },
    { id: 'c4', from: 'peer-c', text: 'x'.repeat(450) + ' ' + longTail, ts: now - 13 * HOUR, seen: [] },
  ];
  const codexOut = stampReceivedMessages(codexMsgs, now, mockClassify);
  const codexLines = codexOut.split('\n');
  const liveIdx = codexLines.findIndex(l => l.includes('rollout flipped'));
  ok(liveIdx >= 0 && STAMP_RE.test(codexLines[liveIdx + 1] || ''), 'codex: aged fast-decay message stamped on its own next line');
  ok((codexOut.match(/⏱️ This message is/g) || []).length === 2, 'codex: fresh + non-status unstamped (2 stamps total: the aged + the sliced-long one)');
  const longIdx = codexLines.findIndex(l => l.includes('xxxxxxxx'));
  ok(longIdx >= 0 && !codexLines[longIdx].includes('uploaded') && STAMP_RE.test(codexLines[longIdx + 1] || ''),
    'codex: classifier runs on the RAW text — a claim sliced out of the 400-char render still stamps');
  ok(stampReceivedMessages(codexMsgs, now, null) === (await import('../src/agent-presence.mjs')).formatReceivedMessages(codexMsgs, now),
    'codex: no classifier (old bundle) → byte-identical to the unstamped renderer, no throw');
  try { const dflt = stampReceivedMessages(codexMsgs, now); ok(typeof dflt === 'string' && dflt.includes('rollout flipped'), 'codex: default classifier path (real lib, present or not) never throws'); }
  catch { ok(false, 'codex: default classifier path (real lib, present or not) never throws'); }

  // Finding-2 granularity: a ⏱ inside one message's own quoted text (a peer
  // relaying an already-stamped digest) must not suppress the stamp another
  // qualifying message needs — the old whole-output includes('⏱') guard did.
  const glyphMsgs = [
    { id: 'g1', from: 'peer-a', text: 'relaying the digest: "⏱️ LAST KNOWN (20h): build 25 uploaded" for context', ts: now - 1 * HOUR, seen: [] },
    { id: 'g2', from: 'peer-b', text: 'rollout flipped to LIVE for build 26', ts: now - 13 * HOUR, seen: [] },
  ];
  const glyphLines = stampReceivedMessages(glyphMsgs, now, mockClassify).split('\n');
  const glyphIdx = glyphLines.findIndex(l => l.includes('rollout flipped'));
  ok(glyphIdx >= 0 && STAMP_RE.test(glyphLines[glyphIdx + 1] || ''),
    'codex: ⏱ quoted inside another (fresh) message does not suppress a stale message\'s stamp (per-message granularity)');
  const glyphFreshIdx = glyphLines.findIndex(l => l.includes('relaying the digest'));
  ok(glyphFreshIdx >= 0 && !STAMP_RE.test(glyphLines[glyphFreshIdx + 1] || ''),
    'codex: the fresh quoting message itself stays unstamped');

  // ── 3b. MCP delivery lane: createMcpPresence stamps all four surfaces ───────
  const { createMcpPresence } = await import('../src/mcp-presence.mjs');
  const { laneFileFor } = await import('../src/agent-presence.mjs');
  const mcpProj = path.join(proj, 'mcp-lane');
  fs.mkdirSync(mcpProj, { recursive: true });
  fs.writeFileSync(path.join(mcpProj, 'brain.klypix'), 'stub');
  const mcpLane = laneFileFor(path.join(mcpProj, 'brain.klypix'), home);
  const writeMcpLane = () => {
    fs.mkdirSync(path.dirname(mcpLane), { recursive: true });
    fs.writeFileSync(mcpLane, JSON.stringify({
      sessions: [],
      messages: [
        { id: 'mm1', from: 'peer-a', to: 'all', text: 'TestFlight build 26 uploaded — processing green', ts: now - 12 * HOUR, seen: [] },
        { id: 'mm2', from: 'peer-b', to: 'all', text: 'decided to keep the reducer flat', ts: now - 12 * HOUR, seen: [] },
      ],
    }));
  };
  const mcpNotices = [];
  const fakeMcpServer = {
    server: { getClientVersion: () => ({ name: 'cursor', version: 'test' }) },
    sendLoggingMessage: (message) => { mcpNotices.push(String(message?.data || '')); },
  };
  const stubTimer = () => ({ unref() {} });
  const mcp = createMcpPresence({
    server: fakeMcpServer,
    initialVault: mcpProj,
    env: { KLYPIX_SESSION_ID: 'mcp-decay-test' },
    home,
    now: () => now,
    setIntervalFn: stubTimer,
    clearIntervalFn: () => {},
    decay: { classifyDecay: mockClassify },
  });
  writeMcpLane();
  mcp.start();
  const peeked = mcp.pollInbox();
  ok(peeked.length === 2 && mcpNotices.some(n => n.includes('build 26 uploaded') && STAMP_RE.test(n)),
    'mcp: pollInbox logging notification carries the ⏱️ LAST-KNOWN stamp');
  const decorated = mcp.decorateToolResult({ content: [{ type: 'text', text: 'tool result' }] });
  const decoratedTail = String(decorated.content[decorated.content.length - 1]?.text || '');
  ok(decoratedTail.includes('build 26 uploaded') && STAMP_RE.test(decoratedTail)
    && (decoratedTail.match(/⏱️ This message is/g) || []).length === 1,
  'mcp: decorateToolResult (guaranteed next-action delivery) stamps the stale claim only');
  writeMcpLane();   // reset seen so brain_sync re-delivers
  const mcpSync = mcp.sync({ phase: 'checkpoint', intent: 'decay mcp check' });
  ok(STAMP_RE.test(mcpSync.text) && (mcpSync.text.match(/⏱️ This message is/g) || []).length === 1,
    'mcp: brain_sync in-band text stamps the stale fast-decay message, not the non-status one');
  const structuredStale = (mcpSync.structured.messages || []).find(m => m.id === 'mm1');
  const structuredSlow = (mcpSync.structured.messages || []).find(m => m.id === 'mm2');
  ok(structuredStale?.lastKnown === true && structuredStale?.age === '12h' && STAMP_RE.test(structuredStale?.stampText || ''),
    'mcp: structured.messages marks the stale claim { lastKnown, age, stampText }');
  ok(structuredSlow && !('lastKnown' in structuredSlow),
    'mcp: structured.messages leaves the non-status message unmarked');
  mcp.stop();
  writeMcpLane();
  const bare = createMcpPresence({
    server: fakeMcpServer,
    initialVault: mcpProj,
    env: { KLYPIX_SESSION_ID: 'mcp-decay-bare' },
    home,
    now: () => now,
    setIntervalFn: stubTimer,
    clearIntervalFn: () => {},
  });
  let bareSync = null, bareThrew = false;
  try { bareSync = bare.sync({ phase: 'checkpoint', intent: 'bare' }); } catch { bareThrew = true; }
  ok(!bareThrew && bareSync?.text.includes('build 26 uploaded') && !bareSync.text.includes('⏱')
    && (bareSync.structured.messages || []).every(m => !('lastKnown' in m)),
  'mcp: no decay injection (old bundle) → delivery intact, unstamped, no throw');
  bare.stop();

  // ── 4. brain-doctor DECAY layer ─────────────────────────────────────────────
  const { inspect, inspectDecayGuard, render, driftLine } = await import('../src/brain-doctor.mjs');
  const brainDir = path.join(home, '.claude', 'project-brain');
  const stampingRenderer = (struct) => `# status\n⏱️ LAST KNOWN (20h): ${struct.cards[0].text} — VERIFY: gh run list\n`;
  const goodLib = { classifyDecay: mockClassify, statusContextToMarkdown: stampingRenderer };
  const noExportLib = { statusContextToMarkdown: stampingRenderer };
  const unstampingLib = { classifyDecay: mockClassify, statusContextToMarkdown: () => '# status\n- [Release] build 26 uploaded to TestFlight\n' };
  const throwingLib = { classifyDecay: mockClassify, statusContextToMarkdown: () => { throw new Error('boom'); } };

  ok(inspectDecayGuard(brainDir, noExportLib).exported === false, 'doctor: stub lib lacking classifyDecay → exported=false');
  ok(inspect({ home, projectDir: home, fmtLib: noExportLib }).layers.decayGuard === 'drift', 'doctor: lib lacking the export → DECAY layer drifts');
  ok(inspectDecayGuard(brainDir, goodLib).rendererStamps === true, 'doctor: renderer that stamps the synthetic 20h-old claim → self-test passes');
  ok(inspectDecayGuard(brainDir, unstampingLib).rendererStamps === false
    && inspect({ home, projectDir: home, fmtLib: unstampingLib }).layers.decayGuard === 'drift',
  'doctor: renderer that leaves the stale claim unstamped → drift');
  ok(inspectDecayGuard(brainDir, throwingLib).rendererStamps === false, 'doctor: throwing renderer → reads as unprotected, not a crash');
  ok(inspect({ home, projectDir: home, fmtLib: null }).layers.decayGuard === 'unknown', 'doctor: unloadable engine → unknown (a fact, not a crash)');

  // Deployed-bundle currency: a brainDir klypix-format WITHOUT classifyDecay is
  // a stale bundle → drift even when the running package lib is current.
  fs.writeFileSync(path.join(brainDir, 'klypix-format.mjs'), '// old bundle without the guard\nexport function parseKlypix() {}\n');
  ok(inspect({ home, projectDir: home, fmtLib: goodLib }).layers.decayGuard === 'drift', 'doctor: deployed bundle predating classifyDecay → DRIFT (stale bundle surfaces, not silent)');
  fs.writeFileSync(path.join(brainDir, 'klypix-format.mjs'), 'export function classifyDecay(text) { return false; }\n');
  const aligned = inspect({ home, projectDir: home, fmtLib: goodLib });
  ok(aligned.layers.decayGuard === 'ok', 'doctor: current deployed bundle + stamping engine → ok');
  ok(/DECAY/.test(render(aligned, { color: false })), 'doctor: render() surfaces the DECAY layer');
  // driftLine needs an "installed" machine (it early-returns NOT-INSTALLED
  // otherwise) — fabricate the baked server stamp, then drift only the guard.
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '1.40.2';\n");
  const drifted = inspect({ home, projectDir: home, fmtLib: noExportLib });
  ok(drifted.verdict === 'DRIFTED' && /decay-guard stale/.test(driftLine(drifted) || ''), 'doctor: driftLine names the decay-guard gap and it flips the verdict');
  ok(drifted.actions.some(a => /decay-aware status guard/.test(a)), 'doctor: reconcile actions include the decay-guard repair line');

  // ── 5. verify: marker suffix (atomic regex trio — no ev: swallowing) ────────
  const r1 = splitMarkerSuffixes('shipped the uploader closes: Upload question ev: src/x.mjs verify: gh run list --limit 3');
  ok(r1.body === 'shipped the uploader' && r1.closes === 'Upload question', 'verify: body + closes still parse cleanly alongside verify');
  ok(Array.isArray(r1.evidence) && r1.evidence.length === 1 && r1.evidence[0].ref === 'src/x.mjs', 'verify: ev value stops at verify: — no junk refs minted from the probe command');
  ok(r1.verify === 'gh run list --limit 3', 'verify: probe command captured verbatim');
  const r2 = splitMarkerSuffixes('did x verify: gh release list; gh run list closes: Old q');
  ok(r2.verify === 'gh release list; gh run list' && r2.closes === 'Old q' && r2.body === 'did x', 'verify: order-independent (verify before closes), PS-safe `;` chain preserved');
  const r3 = splitMarkerSuffixes('plain decision with no suffixes');
  ok(r3.verify === '' && r3.body === 'plain decision with no suffixes' && r3.evidence === null, 'no suffixes → verify empty, body untouched');

  exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('✗ suite crashed:', e && e.stack || e);
  exitCode = 1;
} finally {
  process.chdir(prevCwd);
  process.env.HOME = prevEnv.HOME; process.env.USERPROFILE = prevEnv.USERPROFILE;
  if (prevEnv.NOMAIN === undefined) delete process.env.KLYPIX_BRAIN_NO_MAIN; else process.env.KLYPIX_BRAIN_NO_MAIN = prevEnv.NOMAIN;
  for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ decay-hook: all assertions passed');
process.exit(exitCode);
