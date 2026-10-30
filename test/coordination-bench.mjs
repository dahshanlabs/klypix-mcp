// Coordination bench — the kit tests itself before anyone spends a model call.
//
//   B1 — every grader separates the scenario's correct answer from its naive
//        one (hidden test + stale-action detector; S2 by a real git merge-tree).
//   B2 — a full dry run (scripted oracle × every runnable condition): no shared
//        channel fails every scenario, and every channel that carries the facts
//        passes it. Proves the pipeline (build → prepare → act → hidden test →
//        grade → cleanup) end to end at zero cost.
//   B3 — KLYPIX delivery through the wire: the klypix-mcp server is started
//        exactly as an agent would start it (the condition's mcpServers entry,
//        plugin mode) and its brain_sync shows the agent what the other session
//        knew — the current decision ahead of the archived one (S1), the peer on
//        lib/price.js (S2), the finding an ended session left (S3), the other
//        vendor's root cause (S4).
//   B5 — live-run safety: CLIs start without a shell, the agent env carries
//        nothing from the launching session, results parse to cost / tokens /
//        model, and a live run keeps KLYPIX files in its own throwaway home.
//   B4 — cleanup leaves no lane file behind; the report keeps n and intervals,
//        and calls a gap only when the intervals do not overlap.
// Run:  node test/coordination-bench.mjs   (exit 0 = pass)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The lane lives under the user folder; keep this run away from the real one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cobench-home-'));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.KLYPIX_BRAIN_DIR = path.join(sandbox, 'brain-dir');
process.env.KLYPIX_AUTO_UPDATE = '0';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SCENARIOS } = await import('../bench/coordination/scenarios.mjs');
const { CONDITIONS, conditionById, KLYPIX_BIN, klypixServerInfo } = await import('../bench/coordination/conditions.mjs');
const { oracle, composePrompt, codexMcpOverrides, resolveCli, cleanAgentEnv, claudeAllowedTools, parseClaudeResult, parseCodexEvents, codexChannelUp, codexGitWritable, MCP_STARTUP_TIMEOUT_SEC, CHANNEL_DOWN, classifyChunk } = await import('../bench/coordination/agents.mjs');
const { runOne, notApplicableReason, validityError, isInvalidReason, FACT_NOT_FIRED, FACT_TOO_LATE, FACT_NOT_DELIVERED, HARNESS_ERROR } = await import('../bench/coordination/run.mjs');
const { summarize, toMarkdown } = await import('../bench/coordination/report.mjs');
const { makeRepo, runNodeTests, runNodeProbe } = await import('../bench/coordination/lib/repo.mjs');
const { wilson } = await import('../bench/coordination/lib/stats.mjs');
await import('./coordination-results.mjs');
const { laneFileFor, listActiveSessions, upsertSession } = await import('../src/agent-presence.mjs');
const { parseKlypix } = await import('../src/klypix-format.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const gitVersion = spawnSync('git', ['version'], { encoding: 'utf8' }).stdout || '';
const [gMaj, gMin] = (gitVersion.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
const mergeTreeOk = gMaj > 2 || (gMaj === 2 && gMin >= 38);
if (!mergeTreeOk) console.log(`(git ${gMaj}.${gMin} has no merge-tree --write-tree; S2 collision checks are skipped)`);
const applies = (s) => s.id !== 's2-overlapping-work' || mergeTreeOk;

// ── B1: graders separate good from naive ────────────────────────────────────
for (const s of SCENARIOS.filter(applies)) {
  for (const which of ['good', 'naive']) {
    const repo = makeRepo('klypix-cobench-b1-');
    try {
      s.build(repo);
      s.oracle[which](repo);
      repo.commitAll(`oracle ${which}`);
      for (const [rel, text] of Object.entries(s.hidden)) repo.write(rel, text);
      const g = s.grade(repo, { finalMessage: s.oracle[`${which}Message`] || '' });
      if (which === 'good') ok(g.success === true && g.staleAction === false, `B1 ${s.id}: the correct answer passes the hidden test and is not flagged stale`);
      else ok(g.success === false && g.staleAction === true, `B1 ${s.id}: the naive answer fails and is flagged as acting on stale information`);
      if (s.id === 's2-overlapping-work') {
        ok(g.collision === (which === 'naive'), `B1 ${s.id}: git merge-tree reports a conflict only for the naive answer (${which})`);
        ok(g.handled === (which === 'good'), `B1 ${s.id}: "handled" is true when merged, false when the conflict is neither avoided nor named (${which})`);
      }
    } finally { repo.remove(); }
  }
}

// ── B2: dry run over every runnable condition ───────────────────────────────
const runnable = CONDITIONS.filter((c) => c.runnable);
ok(runnable.map((c) => c.id).join(',') === 'none,relay,agents-md-kept,agents-md-appended,klypix,klypix-installed', 'B2: six conditions are runnable on any machine');
ok(CONDITIONS.filter((c) => !c.runnable).every((c) => c.reason && c.reason.length > 20), 'B2: every planned condition says why it is not measured');
// Which channel can carry each scenario's knowledge — stated up front, so a
// broken channel cannot pass as "nothing delivered, fail expected". The
// appended notes file keeps the stale WIP line in S5, so it delivers nothing
// there; everything else that applies delivers.
const expectDelivered = (s, c) => c.id !== 'none' || s.truthInNotes === true;
const rows = [];
for (const s of SCENARIOS.filter(applies)) {
  for (const c of runnable) {
    if (notApplicableReason(s, c)) continue;
    const r = await runOne({ scenario: s, condition: c, agent: oracle, run: 1, timeoutMs: 60_000 });
    rows.push(r);
    const expectPass = expectDelivered(s, c);
    ok(r.error === null && r.success === expectPass && r.staleAction === !expectPass && r.delivered === (expectPass ? r.facts : 0) && r.invalid !== true,
      `B2 ${s.id} × ${c.id}: ${expectPass ? 'facts delivered (read back) → pass' : 'nothing delivered → fail, stale action'}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
  }
}
ok(rows.filter((r) => r.condition === 'relay').every((r) => r.relays === r.facts) && rows.filter((r) => r.condition !== 'relay').every((r) => r.relays === 0),
  'B2: only the copy-paste condition counts human relays');
const byId = (id) => SCENARIOS.find((s) => s.id === id);
const appended = conditionById('agents-md-appended');
ok(notApplicableReason(byId('s1-changed-decision'), appended) === null && notApplicableReason(byId('s7-decision-buried-in-history'), appended) === null
  && /identical to the kept-tidy/.test(notApplicableReason(byId('s8-partner-limit-not-in-repo'), appended) || '') && /identical to the no-channel/.test(notApplicableReason(byId('s5-stale-wip-note'), appended) || ''),
  'B2: the appended-notes cell runs only where it differs from another condition (S1, S7) and names why it is n/a elsewhere (S5, S8)');
ok(SCENARIOS.find((s) => s.id === 's6-fact-arrives-mid-task').notApplicable.relay.length > 10 && rows.every((r) => !(r.scenario.startsWith('s6') && r.condition === 'relay')),
  'B2: S6 declares why a copy-paste at start cannot apply, and the runner never runs that cell');
ok(rows.filter((r) => r.scenario.startsWith('s6') && r.condition !== 'none').every((r) => Number.isFinite(r.laterFiredAtMs) && r.laterFiredAtMs < 5_000 && r.delivered === 1),
  'B2: S6\'s mid-task fact is carried by the later() hook (at once for the oracle; anchored to the first edit for a live agent) and read back');
ok(rows.filter((r) => r.scenario.startsWith('s6') && r.condition !== 'none').every((r) => r.laterAnchor === 'immediate'), 'B2: for the oracle the mid-task fact is anchored "immediate" and the row records the anchor');

// ── B3: KLYPIX delivery through the real MCP server ─────────────────────────
const klypix = conditionById('klypix');
// Each channel is read from the structured result, so a fact that reached the
// agent by another route cannot pass for the one under test.
const hitsText = (sc) => (sc.context?.hits || []).map((h) => h.text || '').join('\n');
const expectations = {
  // Crowd scenarios: the brain is replayed through THIS checkout's engine.
  // C1's task names no file and too few card words for the start capsule, so
  // its claim reaches an agent through brain_ask, not this first sync.
  'c1-restated-claim': [(sc) => sc && typeof sc === 'object', 'answers without error (the planted claim reaches an agent through brain_ask, not this sync)'],
  'c2-outvoted-objection': [(sc, text) => /Acme Pay can return 503 after/.test(text) && /Open objection/.test(text),
    'the objection is still shown, as open, after three later cards that agree with the position it objects to'],
  's1-changed-decision': [(sc) => {
    const t = hitsText(sc);
    return /bearer tokens/.test(t) && (!/cookie session in auth\/cookie\.js/.test(t) || t.indexOf('bearer tokens') < t.indexOf('cookie session in auth/cookie.js'));
  }, 'its context leads with the token decision, ahead of the archived cookie note'],
  's2-overlapping-work': [(sc) => (sc.peers || []).some((p) => p.id === 'actor-s2-currency' && p.branch === 'a/currency' && (p.files || []).includes('lib/price.js')),
    'its peer list shows the session rewriting lib/price.js on a/currency'],
  's3-note-from-closed-session': [(sc) => /backfill:emails/.test(hitsText(sc)) && /migrate:002/.test(hitsText(sc)),
    'its context carries the finding the ended session left in the brain'],
  's4-root-cause-from-other-vendor': [(sc) => /req\.session\.uid/.test(hitsText(sc)) && /CDN/.test(hitsText(sc)), 'its context carries the other vendor\'s root cause'],
  's5-stale-wip-note': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5-report') && !/WIP|do not touch/i.test(hitsText(sc)),
    'no row on the lane and no card say anyone is on lib/report.js — the ended session left nothing stale'],
  's6-fact-arrives-mid-task': [(sc) => !/MINOR units/.test(hitsText(sc)) && !(sc.messages || []).some((m) => /MINOR units/.test(m.text || '')),
    'at start, nothing yet says how amounts are displayed (the decision comes later)'],
  's7-decision-buried-in-history': [(sc) => {
    const t = hitsText(sc);
    const cur = t.search(/are not retried/i); const old = t.indexOf('retry failed webhook deliveries 3 times');
    return cur >= 0 && (old < 0 || cur < old);
  }, 'its context leads with the no-retry decision, ahead of the archived retry rule, out of three hundred cards'],
  's8-partner-limit-not-in-repo': [(sc) => /24 characters/.test(hitsText(sc)), 'its context carries the partner limit no file holds'],
  's5b-dead-note-held-out': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5x-ledger') && !/Hands off|mid-refactor/i.test(hitsText(sc)),
    'no live row and no card say anyone is on lib/ledger.js (the note lives only in the file)'],
  's5c-valid-note-held-out': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5x-ledger'),
    'no live row claims lib/ledger.js — the lock is held by a person, through the note'],
  // Held-out pairs, the same kinds as s5b / s5c. s5d/s5e are read from their
  // scenario objects at run time (their note is not read by this file's author).
  ...Object.fromEntries(['s5d-dead-note-heldout2', 's5e-valid-note-heldout2'].map((id) => {
    const s = SCENARIOS.find((x) => x.id === id);
    const actorId = s?.actor?.id;
    const words = (s?.facts || []).find((f) => f.staleLine)?.staleLine?.replace(/^- /, '').slice(0, 40) || null;
    return [id, s?.truthInNotes
      ? [(sc) => !(sc.peers || []).some((p) => p.id === actorId), 'no live row claims the protected file — the lock is held by a person, through the note']
      : [(sc) => !(sc.peers || []).some((p) => p.id === actorId) && !(words && hitsText(sc).includes(words)),
        'no live row and no card say anyone is on the protected file (the note lives only in the file)']];
  })),
  's5f-dead-note-heldout3': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5fg-slug') && !/Mateo|slug helpers/i.test(hitsText(sc)),
    'no live row and no card say anyone is on lib/slug.js (the note lives only in the file)'],
  's5g-valid-note-heldout3': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5fg-slug'),
    'no live row claims lib/slug.js — the lock is held by a person, through the note'],
  's5h-dead-note-heldout4': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5hi-backoff') && !/Tomasz|jitter/i.test(hitsText(sc)),
    'no live row and no card say anyone is on lib/backoff.js (the note lives only in the file)'],
  's5i-valid-note-heldout4': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5hi-backoff'),
    'no live row claims lib/backoff.js — the lock is held by a person, through the note'],
  // Re-check scenarios (scenarios-recheck.mjs, written blind): s5j as s5b, the other three as s5c.
  's5j-dead-note-recheck': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5jk-duration') && !/keep out of lib\/duration|Ines is partway/i.test(hitsText(sc)),
    'no live row and no card say anyone is on lib/duration.js (the note lives only in the file)'],
  's5k-valid-note-recheck': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5jk-duration'),
    'no live row claims lib/duration.js — the reservation is held by a person, through the note'],
  's5l-generated-file-rule': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5l-mime'),
    'no live row claims lib/mime-types.generated.js — the standing rule lives in the notes'],
  's5m-human-restriction': [(sc) => !(sc.peers || []).some((p) => p.id === 'actor-s5m-sms'),
    'no live row claims copy/sms-terms.js — the restriction is a person\'s, through the note'],
  's9-continue-stopped-session': [(sc, text) => (sc.handoffs?.sessions || []).some((r) => r.id === 'actor-s9-pagination' && r.state === 'ended' && r.holdsFiles === false)
    && /Now wiring them into listUsers/.test(text) && !/default limit 20/.test(text),
    'a continue-shaped task lists the stopped session; its last words are a mid-step line, and the plan (in its last prompt) is not shown'],
  's9s-continue-stopped-session-summary': [(sc, text) => (sc.handoffs?.sessions || []).some((r) => r.id === 'actor-s9-pagination') && /default limit 20, never more than 50/.test(text),
    'the summary variant: the stopped session\'s last words carry the plan, in the text'],
  's10-live-peer-wrote-nothing': [(sc) => (sc.peers || []).some((p) => p.id === 'actor-s10-tax' && (p.files || []).includes('lib/tax.js') && p.branch === 'a/per-line-tax'),
    'its peer list shows the live session on lib/tax.js, on a/per-line-tax — though that session wrote nothing'],
};
const syncAs = async (server, repo, sessionId, task, phase = 'start', files = undefined) => {
  const c = new Client({ name: 'cobench-agent', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: server.command, args: server.args, cwd: repo.dir, stderr: 'pipe',
    env: { ...process.env, ...server.env, ...(sessionId ? { KLYPIX_SESSION_ID: sessionId } : {}) },
  }));
  try {
    const res = await c.callTool({ name: 'brain_sync', arguments: { project: repo.dir, phase, intent: task.slice(0, 160), include_context: true, ...(files ? { files } : {}) } });
    return { isError: !!res.isError, sc: res.structuredContent || {}, text: (res.content || []).map((x) => x.text || '').join('\n') };
  } finally { try { await c.close(); } catch { /* */ } }
};
for (const s of SCENARIOS) {
  const repo = makeRepo('klypix-cobench-b3-');
  const sessionIds = { agent: `bench-agent-${s.id.slice(0, 2)}-${Date.now().toString(36)}` };
  let prep = null;
  try {
    s.build(repo);
    prep = await klypix.prepare({ repo, scenario: s, agent: oracle, sessionIds });
    if (s.id === 's1-changed-decision') {
      const { struct, canvas } = await parseKlypix(fs.readFileSync(path.join(repo.dir, 'brain.klypix')));
      const edge = (canvas.connections || []).find((e) => /superseded by/.test(e.label || ''));
      const from = struct.cards.find((c) => c.id === edge?.fromId);
      const to = struct.cards.find((c) => c.id === edge?.toId);
      ok(!!edge && /cookie session/.test(from?.text || '') && /bearer tokens/.test(to?.text || ''), 'B3 s1: the brain archives the cookie note with a "superseded by" arrow to the token decision');
    }
    const server = prep.mcpServers['klypix-canvas'];
    ok(prep.delivered.length === s.facts.length, `B3 ${s.id}: the condition reads every fact back from its channel`);
    ok(!fs.existsSync(path.join(repo.dir, '.mcp.json')) && !fs.existsSync(path.join(repo.dir, '.codex', 'config.toml'))
      && /brain_sync/.test(fs.readFileSync(path.join(repo.dir, 'AGENTS.md'), 'utf8')),
    `B3 ${s.id}: the repo gets the project rules but no MCP config pointing at the machine's own install`);
    if (s.id === 's5-stale-wip-note') {
      const brain = path.join(repo.dir, 'brain.klypix');
      const lane = JSON.parse(fs.readFileSync(laneFileFor(brain, os.homedir()), 'utf8'));
      ok(lane.sessions.some((r) => r.id === 'actor-s5-report') && !listActiveSessions({ brainPath: brain, home: os.homedir() }).some((r) => r.id === 'actor-s5-report'),
        `B3 ${s.id}: session Q's row was written two days old and KLYPIX's own expiry hides it — the absence is produced by the product, not by the bench`);
      upsertSession({ brainPath: brain, home: os.homedir(), now: Date.now() - 60_000, id: 'actor-s5-control', client: 'claude-code', intent: 'control', files: ['lib/report.js'] });
      ok(listActiveSessions({ brainPath: brain, home: os.homedir() }).some((r) => r.id === 'actor-s5-control'), `B3 ${s.id}: control — the same row written a minute ago is still listed (expiry, not a broken lane)`);
      ok((repo.read('AGENTS.md') || '').includes('do not touch') && (repo.read('CLAUDE.md') || '').includes('do not touch'),
        `B3 ${s.id}: the KLYPIX condition leaves the dead WIP line in both instructions files — KLYPIX's empty lane has to beat it (a cleaned file would make this the tidy cell plus a server)`);
    }
    const { isError, sc, text } = await syncAs(server, repo, null, s.task);
    const [check, what] = expectations[s.id];
    ok(!isError && check(sc, text), `B3 ${s.id}: the agent's first brain_sync — ${what}`);
    if (s.id === 's5b-dead-note-held-out' || s.id === 's5c-valid-note-held-out') {
      // The session is ended in both cases; local Git evidence distinguishes
      // merged work from the still-unmerged refactor. Neither grants authority
      // to override a standing instruction.
      const withFile = await syncAs(server, repo, null, s.task, 'start', ['lib/ledger.js']);
      const row = (withFile.sc.handoffs?.sessions || []).find((r) => r.id === 'actor-s5x-ledger');
      const evidence = (withFile.sc.lockNotes || []).flatMap((n) => n.files || []).filter((f) => f.file === 'lib/ledger.js');
      const expectedVerdict = s.id === 's5b-dead-note-held-out' ? 'no-work-found' : 'in-progress';
      ok(!withFile.isError && row?.state === 'ended' && row?.holdsFiles === false
        && evidence.length > 0 && evidence.every((f) => f.verdict === expectedVerdict && f.canOverrideInstructions === false)
        && !/no longer applies/.test(withFile.text),
        `B3 ${s.id}: the ended session holds no file; local work evidence is ${expectedVerdict} and does not override instructions`);
      ok((repo.read('AGENTS.md') || '').includes('Hands off lib/ledger.js'), `B3 ${s.id}: KLYPIX leaves the note in the notes file`);
    }
    if (s.id === 's10-live-peer-wrote-nothing') {
      const withFile = await syncAs(server, repo, null, s.task, 'start', ['lib/tax.js']);
      ok(!withFile.isError && (withFile.sc.conflicts || []).some((c) => c.id === 'actor-s10-tax' && c.kind === 'exact-file'),
        `B3 ${s.id}: declaring lib/tax.js reports an exact-file overlap with the live session`);
    }
    if (s.id === 's6-fact-arrives-mid-task') {
      // The decision is made while the agent works: a card plus a broadcast
      // note. As in a real run the agent's server stays connected (its lane
      // row is live), so the note has a recipient; the agent's NEXT sync
      // carries it — as the note, or as context.
      const live = new Client({ name: 'cobench-agent', version: '1.0.0' }, { capabilities: {} });
      await live.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: repo.dir, stderr: 'pipe', env: { ...process.env, ...server.env } }));
      try {
        await live.callTool({ name: 'brain_sync', arguments: { project: repo.dir, phase: 'start', intent: s.task.slice(0, 160), include_context: true } });
        const out = await klypix.later({ repo, scenario: s, sessionIds });
        ok(out.delivered.length === 1 && out.notePosted === true, `B3 ${s.id}: the mid-task decision is written as a card (read back) and the note was posted to the live session`);
        const next = await live.callTool({ name: 'brain_sync', arguments: { project: repo.dir, phase: 'checkpoint', intent: s.task.slice(0, 160), include_context: true } });
        const nsc = next.structuredContent || {};
        const seen = (nsc.messages || []).some((m) => /MINOR units/.test(m.text || '')) || /MINOR units/.test(hitsText(nsc));
        ok(!next.isError && seen, `B3 ${s.id}: the agent's next brain_sync hands it the decision (note or context)`);
      } finally { try { await live.close(); } catch { /* */ } }
    }
    if (s.id === 's7-decision-buried-in-history') {
      const { struct } = await parseKlypix(fs.readFileSync(path.join(repo.dir, 'brain.klypix')));
      ok(struct.cards.length >= 250, `B3 ${s.id}: the brain is as cluttered as the file — ${struct.cards.length} cards, six months of history included`);
    }
  } catch (err) {
    ok(false, `B3 ${s.id}: ${String(err?.message || err).split('\n')[0]}`);
  } finally {
    const lane = laneFileFor(path.join(repo.dir, 'brain.klypix'), os.homedir());
    prep?.cleanup?.();
    ok(!fs.existsSync(lane) && !fs.existsSync(`${lane}.lock`), `B4 ${s.id}: cleanup removes the lane file and its lock`);
    repo.remove();
  }
}

// ── B4: agents and report ───────────────────────────────────────────────────
ok(composePrompt('Do X.', null).startsWith('Do X.\n\n') && composePrompt('Do X.', 'Pasted.').includes('Do X.\n\nPasted.\n\n'), 'B4: the prompt is the task, then the condition addendum (relay only), then the shared suffix');
const overrides = codexMcpOverrides({ 'klypix-canvas': { command: 'C:\\node.exe', args: ['C:\\a b\\klypix-mcp.mjs', '--vault', 'C:\\r'], env: { KLYPIX_PLUGIN: '1' } } });
ok(overrides.includes('mcp_servers.klypix-canvas.command="C:\\\\node.exe"') && overrides.includes('mcp_servers.klypix-canvas.args=["C:\\\\a b\\\\klypix-mcp.mjs", "--vault", "C:\\\\r"]') && overrides.includes('mcp_servers.klypix-canvas.env={ KLYPIX_PLUGIN = "1" }'),
  'B4: Codex gets the same server through -c overrides, Windows paths escaped as TOML strings');
const c1 = classifyChunk('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}');
const c2 = classifyChunk('{"type":"item.started","item":{"type":"mcp_tool_call","tool":"brain_sync"}}');
const c3 = classifyChunk('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__klypix-canvas__brain_sync"}]}}');
const c4 = classifyChunk('{"type":"item.started","item":{"type":"file_change"}}');
ok(c1.edit && c1.tool && !c1.mcp && c2.mcp && c2.tool && !c2.edit && c3.mcp && !c3.edit && c4.edit && !c4.mcp,
  'B5: the stream classifier tells edits (Claude Edit/Write, Codex file_change) from channel calls (mcp__…, mcp_tool_call) — the mid-task fact is anchored to the first edit');
const staleCell = summarize([
  { scenario: 's5-stale-wip-note', condition: 'none', agent: 'claude', run: 1, success: false, staleAction: true, error: 'timed out' },
  { scenario: 's5-stale-wip-note', condition: 'none', agent: 'claude', run: 2, success: false, staleAction: true },
]).find((c) => c.scenario === 's5-stale-wip-note');
ok(staleCell.staleActions.k === 1 && staleCell.staleActions.n === 1 && staleCell.errors === 1, 'B5: "acted on stale information" is counted over completed runs only — a timed-out run is an error, not deference');
// The probe's answer cannot be forged or corrupted by what the module prints.
{
  const repo = makeRepo('klypix-cobench-probe-');
  try {
    repo.write('package.json', '{ "type": "module" }\n');
    repo.write('lib/noisy.js', "console.log('7'); process.stdout.write('99\\n'); export async function deliver(e, send) { for (let i = 0; i < 3; i++) { try { console.log('attempt', i); await send(e); return; } catch {} } }\n");
    const p = runNodeProbe(repo.dir, 'lib/noisy.js', "let calls = 0; await m.deliver({}, async () => { calls++; throw new Error('x'); }); __out(calls);");
    ok(p.ok && p.value === 3, `B5: the probe reports through its own marker — a module that logs and writes to stdout cannot change the count (got ${JSON.stringify(p.value)})`);
    const silent = runNodeProbe(repo.dir, 'lib/noisy.js', 'process.stdout.write("no marker");');
    ok(!silent.ok, 'B5: a probe that never reports is not ok (no answer is never read as an answer)');
  } finally { repo.remove(); }
}
// Every way a run can fail to measure its channel is invalid, never a fail.
{
  const s1 = SCENARIOS.find((s) => s.id === 's1-changed-decision');
  const s6 = SCENARIOS.find((s) => s.id === 's6-fact-arrives-mid-task');
  const live = { id: 'claude' };
  const kept = conditionById('agents-md-kept');
  ok(validityError({ scenario: s1, condition: kept, agent: live, prep: { delivered: [] }, later: {} }).startsWith(FACT_NOT_DELIVERED),
    'B5: a condition whose write did not land at start makes the run invalid (channel-write-did-not-land)');
  ok(validityError({ scenario: s1, condition: conditionById('none'), agent: live, prep: { delivered: [] }, later: {} }) === null,
    'B5: the no-channel condition delivers nothing by design and is never invalid for it');
  ok(validityError({ scenario: s6, condition: kept, agent: live, prep: { delivered: [] }, later: { fired: false, delivered: [] } }) === FACT_NOT_FIRED,
    'B5: a mid-task fact that never fired (no file write seen) makes the run invalid');
  ok(validityError({ scenario: s6, condition: kept, agent: live, prep: { delivered: [] }, later: { fired: true, delivered: [], error: 'EPERM' }, laterFiredAtMs: 10, lastToolAtMs: 50 }).startsWith(FACT_NOT_DELIVERED),
    'B5: a mid-task write that failed makes the run invalid, not a KLYPIX fail');
  ok(validityError({ scenario: s6, condition: kept, agent: live, prep: { delivered: [] }, later: { fired: true, delivered: ['display-minor-units'] }, laterFiredAtMs: 90, lastToolAtMs: 50 }) === FACT_TOO_LATE,
    'B5: a mid-task fact that landed after the agent\'s last action makes the run invalid');
  ok(validityError({ scenario: s6, condition: kept, agent: live, prep: { delivered: [] }, later: { fired: true, delivered: ['display-minor-units'] }, laterFiredAtMs: 10, lastToolAtMs: 50 }) === null,
    'B5: a mid-task fact that landed in time, read back, makes a valid run');
  ok(isInvalidReason(`${HARNESS_ERROR}: Error: boom`) && isInvalidReason(`${FACT_NOT_DELIVERED}: 0/1 at start`) && !isInvalidReason('timed out'),
    'B5: harness errors and undelivered writes are invalid; an agent timeout is an ordinary error');
  const g = s6.grade, handledProbe = makeRepo('klypix-cobench-s6h-');
  try {
    s6.build(handledProbe); s6.oracle.naive(handledProbe); handledProbe.commitAll('naive');
    for (const [rel, text] of Object.entries(s6.hidden)) handledProbe.write(rel, text);
    const noDelivery = g(handledProbe, { finalMessage: 'Kept a human-readable amount; finance may want another format.', deliveredIds: [] });
    const delivered = g(handledProbe, { finalMessage: 'Kept $21.44; another session just made a decision about the display I did not apply.', deliveredIds: ['display-minor-units'] });
    ok(noDelivery.handled === null && delivered.handled === true,
      'B5: S6 "handled" is scored only where the decision was delivered — a no-channel summary that mentions finance is not credited');
  } finally { handledProbe.remove(); }
}
const w = wilson(5, 5);
ok(w.p === 1 && w.low > 0.5 && w.low < 0.6 && w.high === 1, 'B4: Wilson interval for 5/5 is about 57%–100% (five runs prove little)');
const synthetic = [
  ...Array.from({ length: 20 }, (_, i) => ({ scenario: 's1-changed-decision', condition: 'klypix', agent: 'claude', run: i, success: i < 19, staleAction: false, relays: 0 })),
  ...Array.from({ length: 20 }, (_, i) => ({ scenario: 's1-changed-decision', condition: 'none', agent: 'claude', run: i, success: i < 3, staleAction: i >= 3, relays: 0 })),
  ...Array.from({ length: 3 }, (_, i) => ({ scenario: 's3-note-from-closed-session', condition: 'klypix', agent: 'claude', run: i, success: true, staleAction: false, relays: 0 })),
  ...Array.from({ length: 3 }, (_, i) => ({ scenario: 's3-note-from-closed-session', condition: 'none', agent: 'claude', run: i, success: i < 1, staleAction: i >= 1, relays: 0 })),
];
const md = toMarkdown(summarize(synthetic));
ok(/A decision changed today: KLYPIX ahead of none — 95% vs 15%/.test(md) && !/A note left by a session that has ended: KLYPIX/.test(md),
  'B4: the report calls the 20-run gap a difference and does not claim a difference for the 3-run gap');
ok(/## Not measured/.test(md) && /MCP Agent Mail/.test(md), 'B4: the report lists the tools it did not measure, with the reason');
const naMd = toMarkdown(summarize([
  { scenario: 's6-fact-arrives-mid-task', condition: 'relay', agent: 'claude', run: 1, notApplicable: 'a paste at start cannot carry it', success: false, staleAction: false },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 1, success: false, staleAction: true, handled: true },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 2, success: true, staleAction: false, handled: true },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 3, success: false, staleAction: true, handled: false, mcpCalls: { brain_sync: 1 } },
]));
ok(/n\/a: a paste at start cannot carry it/.test(naMd), 'B4: a condition a scenario cannot apply to prints as n/a with its reason, never as 0%');
ok(/\| 2\/3 \| —/.test(naMd) && /\| Handled \|/.test(naMd), 'B4: the "handled" column counts a flagged conflict beside the strict grade (2/3)');
{
  // The clear-differences list names a KLYPIX loss as plainly as a win, and
  // never compares against a cell that was not run.
  const mk = (condition, success, extra = {}) => Array.from({ length: 5 }, (_, i) => ({ scenario: 's5-stale-wip-note', condition, agent: 'claude', run: i + 1, success, staleAction: !success, handled: null, relays: 0, delivered: 1, facts: 1, ...extra }));
  const cdRows = [...mk('klypix', false), ...mk('agents-md-kept', true), ...mk('none', false), ...mk('agents-md-appended', false, { notApplicable: 'identical to none' })];
  const cdMd = toMarkdown(summarize(cdRows), cdRows);
  ok(/KLYPIX BEHIND agents-md-kept — 0% vs 100%/.test(cdMd) && !/vs agents-md-appended|agents-md-appended —/.test(cdMd) && !/KLYPIX ahead of none/.test(cdMd),
    'B4: the report lists a clear KLYPIX loss, and never compares against a cell that was not run');
}

// ── B6: KLYPIX as installed (round 3) ───────────────────────────────────────
{
  const { INSTALLED_CLAUDE_HOOKS, claudeHookSettings } = await import('../bench/coordination/conditions.mjs');
  // The bench wires the same eight hooks the installer wires: event, matcher,
  // argument and timeout, read from bin/klypix-install.mjs itself.
  const installer = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'klypix-install.mjs'), 'utf8').replace(/\r/g, '');
  const wired = [...installer.matchAll(/\['(SessionStart|UserPromptSubmit|Stop|PostToolUse|PreToolUse|SessionEnd|SubagentStart|SubagentStop)', \{ (?:matcher: '([^']+)', )?hooks: \[\{ type: 'command', command: brainCmd\('([^']*)'\)(?:, timeout: (\d+))? \}\] \}\]/g)]
    .map((m) => [m[1], m[2] || null, m[3], m[4] ? Number(m[4]) : null]);
  ok(wired.length === 8 && JSON.stringify(wired) === JSON.stringify(INSTALLED_CLAUDE_HOOKS.map((h) => [...h])),
    'B6: the installed condition wires exactly the hooks bin/klypix-install.mjs wires (event, matcher, argument, timeout)');
  const settings = claudeHookSettings('"node" "w.mjs"');
  ok(settings.hooks.UserPromptSubmit[0].hooks[0].command === '"node" "w.mjs" --prompt' && settings.hooks.SessionStart[0].matcher === 'startup|resume|clear',
    'B6: hook commands carry the installer\'s arguments');

  const installed = conditionById('klypix-installed');
  ok(/CODEX_HOME/.test(notApplicableReason(SCENARIOS[0], installed, { id: 'codex' }) || '') && notApplicableReason(SCENARIOS[0], installed, { id: 'claude' }) === null,
    'B6: KLYPIX as installed runs for Claude and is n/a for Codex, with the reason');

  const s9 = SCENARIOS.find((s) => s.id === 's9-continue-stopped-session');
  const repo = makeRepo('klypix-cobench-b6-');
  const benchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cobench-b6home-'));
  let prep = null;
  try {
    s9.build(repo);
    prep = await installed.prepare({ repo, scenario: s9, agent: oracle, sessionIds: { agent: 'bench-agent-b6' }, benchHome });
    const server = prep.mcpServers['klypix-canvas'];
    ok(!('KLYPIX_PLUGIN' in server.env) && server.env.HOME === benchHome && !('KLYPIX_SESSION_ID' in server.env),
      'B6: the installed server is not in plugin mode, runs in the run\'s home, and gets no pinned session id (the installer sets none)');
    ok(server.env.KLYPIX_APP_BRIDGE_DIR && server.env.KLYPIX_APP_BRIDGE_DIR.startsWith(benchHome),
      'B6: the desktop app\'s bridge is looked up inside the run\'s home — no run can reach the user\'s open canvases');
    const hooks = JSON.parse(fs.readFileSync(path.join(repo.dir, '.claude', 'settings.json'), 'utf8')).hooks;
    const wrapperPath = path.join(benchHome, 'klypix-hook.mjs');
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');
    // The installer's exact command form: a bare node, then the quoted script.
    // On Windows Claude Code runs hooks through PowerShell, where a line that
    // starts with a quoted path is a parse error (round-3 smoke: every hook failed).
    const installerForm = installer.includes('const brainCmd = (arg) => ' + String.fromCharCode(96) + 'node "$' + '{');
    ok(installerForm && Object.values(hooks).every((g) => /^node "[^"]+"( --[a-z-]+)?$/.test(g[0].hooks[0].command)),
      'B6: every hook command has the installer\'s form, a bare node then the quoted script');
    ok(Object.keys(hooks).length === 8 && hooks.Stop[0].hooks[0].command.includes(wrapperPath.replace(/\\/g, '/')),
      'B6: the run repo carries the eight hooks, each through the run\'s wrapper');
    ok(wrapper.includes(JSON.stringify(benchHome)) && wrapper.includes('KLYPIX_BRAIN_DIR') && wrapper.includes('global-brain-hook.mjs') && /delete process\.env\.KLYPIX_PLUGIN/.test(wrapper) && /await import\(/.test(wrapper),
      'B6: the wrapper pins HOME, USERPROFILE and KLYPIX_BRAIN_DIR to the run\'s home and runs this checkout\'s hook');
    ok(repo.git('status', '--porcelain') === '' && /\.claude\//.test(fs.readFileSync(path.join(repo.dir, '.git', 'info', 'exclude'), 'utf8')),
      'B6: the hook settings stay out of git, like a user-scope file');
    ok(prep.delivered.includes('s9-plan') && prep.actorListed === true, 'B6: the stopped session\'s work record is listed (installed condition)');
    {
      // Run the SessionStart hook the way Claude Code would (a bare node, the
      // wrapper, the hook's JSON on stdin) and read the run log back.
      const r = spawnSync('node', [wrapperPath], { cwd: repo.dir, input: JSON.stringify({ session_id: 'bench-agent-b6', cwd: repo.dir, hook_event_name: 'SessionStart', source: 'startup' }), encoding: 'utf8', timeout: 60_000 });
      const runs = prep.hookRuns();
      ok(r.status === 0 && runs.sessionStart === 1 && !runs.failed['session-start'], 'B6: the SessionStart hook runs through the wrapper and its run is logged (exit 0)');
      ok(validityError({ scenario: s9, condition: installed, agent: { id: 'claude' }, prep, later: {}, hookRuns: { started: {}, failed: {}, sessionStart: 0 } }) === 'hooks-did-not-run'
        && validityError({ scenario: s9, condition: installed, agent: { id: 'claude' }, prep, later: {}, hookRuns: runs }) === null,
        'B6: a run whose hooks never started is invalid; one whose hooks ran is valid');
    }
    ok(repo.git('status', '--porcelain') === '', 'B6: the project harness a real install has is in place before the agent starts — nothing appears in git status');
  } catch (err) {
    ok(false, 'B6: ' + String(err?.message || err).split('\n')[0]);
  } finally {
    prep?.cleanup?.();
    repo.remove();
    try { fs.rmSync(benchHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* */ }
  }
  // Codex gets the condition server's tools approved, and only that server's.
  const ov = codexMcpOverrides({ 'klypix-canvas': { command: 'node', args: [] } });
  ok(ov.includes('mcp_servers.klypix-canvas.default_tools_approval_mode="approve"') && ov.filter((a) => /approval/.test(a)).length === 1,
    'B6: Codex approves the KLYPIX server\'s tools (round 2 refused 29 calls) — nothing else is approved');
}

{
  const { namesPeer, S10_NAME, S5C_NAME } = await import('../bench/coordination/scenarios-round3.mjs');
  const yes = [
    'Heads-up: session T is rewriting lib/tax.js on a/per-line-tax, so this will conflict at merge.',
    'Another live Codex session is rewriting lib/tax.js right now; coordinate before merging.',
    'Note: a concurrent session is changing the same file (lib/tax.js) — expect a merge conflict.',
    'KLYPIX shows peer actor-s10-tax editing lib/tax.js.',
  ];
  const no = ['Tests pass, no conflicts.', 'brain_sync complete; no file conflicts reported.', 'I did not touch any other branch.', 'Raised the rate to 8% and committed.', 'The work is no longer in progress.'];
  ok(yes.every((m) => namesPeer(m, S10_NAME).named) && no.every((m) => !namesPeer(m, S10_NAME).named),
    'B4: S10 counts a message as naming the peer only when it points at the live session and its file — "no conflicts" and the like never count');
  ok(namesPeer("Left lib/ledger.js alone: Priya's refactor is in progress on a/ledger-refactor.", S5C_NAME).named && !namesPeer('Fixed roundCents. No conflicts.', S5C_NAME).named,
    'B4: S5c records whether the agent named Priya\'s work, by the same rule');
}

// ── B5: live-run safety (no model call) ─────────────────────────────────────
{
  // npm shims are read for their real target, so no prompt ever passes through cmd.exe.
  const files = {
    'C:\\npm\\claude.cmd': '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe': '',
    // npm's real node-program shim, which also names a bundled node.exe first.
    'C:\\npm\\codex.cmd': [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', '',
    ].join('\r\n'),
    'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '',
  };
  const fake = { pathEnv: 'C:\\other;C:\\npm', platform: 'win32', readFile: (p) => files[p], isFile: (p) => p in files };
  const c = resolveCli('claude', fake);
  const x = resolveCli('codex', fake);
  ok(c?.command === 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' && c.prefix.length === 0, 'B5: a shim pointing at a native exe runs that exe directly');
  ok(x?.command === process.execPath && x.prefix[0] === 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'B5: a shim pointing at a .js entry runs it on this Node');
  ok(resolveCli('missing', fake) === null, 'B5: a CLI that is not installed resolves to null');

  const env = cleanAgentEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KLYPIX_SESSION_ID: 'parent', ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' });
  ok(env.PATH === 'p' && env.ANTHROPIC_API_KEY === 'k' && env.OPENAI_API_KEY === 'o' && !('CLAUDECODE' in env) && !('CLAUDE_CODE_ENTRYPOINT' in env) && !('KLYPIX_SESSION_ID' in env) && !('ELECTRON_RUN_AS_NODE' in env),
    'B5: the agent starts clean — no parent Claude session, KLYPIX id or Electron flag leaks in (credentials stay)');
  ok(claudeAllowedTools({ 'klypix-canvas': {} }).includes('mcp__klypix-canvas') && !claudeAllowedTools({}).some((t) => t.startsWith('mcp__')),
    'B5: Claude may use every tool of the condition\'s server, and no MCP tool otherwise');
  ok(['Bash(git *)', 'PowerShell(git *)', 'PowerShell(node *)', 'PowerShell(npm test*)'].every((t) => claudeAllowedTools({}).includes(t)),
    'B5: Claude\'s git/node/test rules cover its PowerShell tool too (Windows runs shell commands there)');
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__klypix-canvas__brain_sync"},{"type":"tool_use","name":"Read"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"mcp__klypix-canvas__brain_ask"},{"type":"tool_use","name":"mcp__klypix-canvas__brain_sync"}]}}',
    '{"type":"result","is_error":false,"num_turns":3,"total_cost_usd":0.1,"usage":{"input_tokens":1,"output_tokens":2},"modelUsage":{"m":{}},"permission_denials":[]}',
  ].join('\n');
  const sr = parseClaudeResult(stream);
  ok(sr.mcpCalls.brain_sync === 2 && sr.mcpCalls.brain_ask === 1 && !('Read' in sr.mcpCalls) && sr.turns === 3 && sr.permissionDenials === 0,
    'B5: Claude\'s event stream yields which KLYPIX tools it called, and how often');
  ok(parseClaudeResult('{"type":"assistant","message":{"content":[]}}').resultError === 'no result event', 'B5: a Claude stream that never reached its result is an error row');
  const xm = parseCodexEvents(['{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"brain_sync"}}', '{"type":"item.started","item":{"type":"mcp_tool_call","tool":"brain_sync"}}', '{"type":"item.completed","item":{"type":"command_execution"}}'].join('\n'));
  ok(xm.mcpCalls.brain_sync === 1 && Object.keys(xm.mcpCalls).length === 1, 'B5: Codex events yield its completed KLYPIX tool calls');

  // A run whose channel never came up is INVALID, never a KLYPIX fail.
  const down = parseClaudeResult(['{"type":"system","subtype":"init","mcp_servers":[{"name":"klypix-canvas","status":"failed"}]}', '{"type":"result","is_error":false,"num_turns":1}'].join('\n'));
  const up = parseClaudeResult(['{"type":"system","subtype":"init","mcp_servers":[{"name":"klypix-canvas","status":"connected"}]}', '{"type":"result","is_error":false,"num_turns":1}'].join('\n'));
  const none = parseClaudeResult(['{"type":"system","subtype":"init","mcp_servers":[]}', '{"type":"result","is_error":false,"num_turns":1}'].join('\n'));
  ok(down.channelUp === false && up.channelUp === true && none.channelUp === null, 'B5: Claude\'s init event says whether the condition server came up');
  ok(codexChannelUp(['klypix-canvas'], { brain_sync: 1 }, '') === true
    && codexChannelUp(['klypix-canvas'], {}, 'ERROR mcp: klypix-canvas failed to start: timed out') === false
    && codexChannelUp(['klypix-canvas'], {}, 'ERROR codex_skills: failed to install system skills') === null
    && codexChannelUp([], {}, '') === null,
  'B5: Codex counts as up only after a KLYPIX call, as down only on a start-up failure naming it, otherwise unknown');
  ok(codexMcpOverrides({ 'klypix-canvas': { command: 'node', args: [] } }).includes(`mcp_servers.klypix-canvas.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`) && MCP_STARTUP_TIMEOUT_SEC >= 120,
    'B5: both agents wait up to two minutes for the server to start (Codex defaults to 10 s)');
  const gw = codexGitWritable(path.join(os.tmpdir(), 'klypix-cobench-x'));
  ok(gw[0] === '-c' && /^sandbox_workspace_write\.writable_roots=\["[^"]*klypix-cobench-x\/\.git"\]$/.test(gw[1]),
    'B5: Codex may write only the run repo\'s .git (it could not commit or merge otherwise)');

  // S4 must not be solvable from the repository alone: its visible test
  // passes before any fix, so the cause can only come from the other session.
  {
    const s4 = SCENARIOS.find((s) => s.id === 's4-root-cause-from-other-vendor');
    const repo4 = makeRepo('klypix-cobench-s4v-');
    try {
      s4.build(repo4);
      ok(runNodeTests(repo4.dir, ['test/cache.test.js']).pass, 'B5: S4\'s visible test already passes — the repository holds no clue to the cause');
    } finally { repo4.remove(); }
  }
  const invalidMd = toMarkdown(summarize([
    { scenario: 's1-changed-decision', condition: 'klypix', agent: 'claude', run: 1, success: false, staleAction: true, invalid: true, error: CHANNEL_DOWN },
    { scenario: 's1-changed-decision', condition: 'klypix', agent: 'claude', run: 2, success: true, staleAction: false, mcpCalls: { brain_sync: 1 } },
  ]));
  ok(/\| 1 \(\+1 invalid\) \| 100%/.test(invalidMd) && /\| 1\/1 \|/.test(invalidMd), 'B5: the report leaves an invalid run out of the rate and shows it beside n');

  const cr = parseClaudeResult('{"type":"result","is_error":false,"num_turns":7,"total_cost_usd":0.4123,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":300,"cache_creation_input_tokens":40},"modelUsage":{"claude-opus-5-5":{}}}\n');
  ok(cr.costUsd === 0.4123 && cr.tokens === 370 && cr.turns === 7 && cr.model === 'claude-opus-5-5' && cr.resultError === null, 'B5: Claude\'s JSON result yields cost, tokens, turns and the model used');
  ok(parseClaudeResult('{"type":"result","is_error":true,"subtype":"error_max_budget_usd"}').resultError === 'error_max_budget_usd', 'B5: a Claude run stopped by the dollar cap is an error row, not a quiet fail');
  const xr = parseCodexEvents(['{"type":"thread.started","model":"gpt-5.5-codex"}', 'not json', '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":25}}'].join('\n'));
  ok(xr.tokens === 175 && xr.turns === 1 && xr.model === 'gpt-5.5-codex' && xr.failure === null, 'B5: Codex events yield tokens, turns and the model used');
  ok(parseCodexEvents('{"type":"turn.failed","error":{"message":"usage limit reached"}}').failure === 'usage limit reached', 'B5: a failed Codex turn is an error row');

  // A live run keeps every KLYPIX file of the run in its own throwaway home.
  const s2 = SCENARIOS.find((s) => s.id === 's2-overlapping-work');
  const repo = makeRepo('klypix-cobench-b5-');
  const benchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cobench-b5home-'));
  try {
    s2.build(repo);
    const prep = await klypix.prepare({ repo, scenario: s2, agent: oracle, sessionIds: { agent: 'bench-agent-b5' }, benchHome });
    const brain = path.join(repo.dir, 'brain.klypix');
    const server = prep.mcpServers['klypix-canvas'];
    ok(server.env.HOME === benchHome && server.env.USERPROFILE === benchHome && server.env.KLYPIX_AUTO_UPDATE === '0', 'B5: the KLYPIX server of a live run gets the run\'s throwaway home');
    ok(fs.existsSync(laneFileFor(brain, benchHome)) && !fs.existsSync(laneFileFor(brain, os.homedir())) && prep.delivered.length === 1,
      'B5: the live actor\'s lane row is written in that home — the launching user\'s lane is never touched');
    prep.cleanup();
    const other = path.join(os.tmpdir(), 'elsewhere', 'bin', 'klypix-mcp.mjs');
    const prep2 = await klypix.prepare({ repo, scenario: s2, agent: oracle, sessionIds: { agent: 'bench-agent-b5b' }, benchHome, klypixBin: other });
    ok(prep2.mcpServers['klypix-canvas'].args[0] === other && server.args[0] === KLYPIX_BIN, 'B5: --klypix-bin points the KLYPIX condition at another build; the default is this checkout');
    prep2.cleanup();
    const info = klypixServerInfo();
    ok(info.bin === KLYPIX_BIN && info.version === JSON.parse(fs.readFileSync(path.join(path.dirname(KLYPIX_BIN), '..', 'package.json'), 'utf8')).version && (info.commit === null || /^[0-9a-f]{7,}$/.test(info.commit)),
      'B5: every KLYPIX row can name the server build it measured (version and commit)');
  } finally {
    repo.remove();
    try { fs.rmSync(benchHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* */ }
  }
}

// A server child that is still exiting can hold a file in the sandbox for a
// moment on Windows (EBUSY); that must never hide the verdict below.
try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS temp cleaner */ }
console.log(failures ? `\n${failures} coordination-bench check(s) FAILED` : '\nall coordination-bench checks passed');
process.exit(failures ? 1 : 0);
