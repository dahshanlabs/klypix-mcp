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
const { CONDITIONS, conditionById } = await import('../bench/coordination/conditions.mjs');
const { oracle, composePrompt, codexMcpOverrides, resolveCli, cleanAgentEnv, claudeAllowedTools, parseClaudeResult, parseCodexEvents, codexChannelUp, codexGitWritable, MCP_STARTUP_TIMEOUT_SEC, CHANNEL_DOWN } = await import('../bench/coordination/agents.mjs');
const { runOne } = await import('../bench/coordination/run.mjs');
const { summarize, toMarkdown } = await import('../bench/coordination/report.mjs');
const { makeRepo, runNodeTests } = await import('../bench/coordination/lib/repo.mjs');
const { wilson } = await import('../bench/coordination/lib/stats.mjs');
const { laneFileFor } = await import('../src/agent-presence.mjs');
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
ok(runnable.map((c) => c.id).join(',') === 'none,relay,agents-md-kept,agents-md-appended,klypix', 'B2: five conditions are runnable on any machine');
ok(CONDITIONS.filter((c) => !c.runnable).every((c) => c.reason && c.reason.length > 20), 'B2: every planned condition says why it is not measured');
// Which channel can carry each scenario's knowledge — stated up front, so a
// broken channel cannot pass as "nothing delivered, fail expected". The
// appended notes file keeps the stale WIP line in S5, so it delivers nothing
// there; everything else that applies delivers.
const expectDelivered = (s, c) => {
  if (c.id === 'none') return false;
  if (s.id === 's5-stale-wip-note' && c.id === 'agents-md-appended') return false;
  return true;
};
const rows = [];
for (const s of SCENARIOS.filter(applies)) {
  for (const c of runnable) {
    if (s.notApplicable?.[c.id]) continue;
    const r = await runOne({ scenario: s, condition: c, agent: oracle, run: 1, timeoutMs: 60_000 });
    rows.push(r);
    const expectPass = expectDelivered(s, c);
    ok(r.error === null && r.success === expectPass && r.staleAction === !expectPass && r.delivered === (expectPass ? r.facts : 0) && r.invalid !== true,
      `B2 ${s.id} × ${c.id}: ${expectPass ? 'facts delivered (read back) → pass' : 'nothing delivered → fail, stale action'}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
  }
}
ok(rows.filter((r) => r.condition === 'relay').every((r) => r.relays === r.facts) && rows.filter((r) => r.condition !== 'relay').every((r) => r.relays === 0),
  'B2: only the copy-paste condition counts human relays');
ok(SCENARIOS.find((s) => s.id === 's6-fact-arrives-mid-task').notApplicable.relay.length > 10 && rows.every((r) => !(r.scenario.startsWith('s6') && r.condition === 'relay')),
  'B2: S6 declares why a copy-paste at start cannot apply, and the runner never runs that cell');
ok(rows.filter((r) => r.scenario.startsWith('s6') && r.condition !== 'none').every((r) => Number.isFinite(r.laterFiredAtMs) && r.laterFiredAtMs < 5_000 && r.delivered === 1),
  'B2: S6\'s mid-task fact is carried by the later() hook (at once for the oracle) and read back');

// ── B3: KLYPIX delivery through the real MCP server ─────────────────────────
const klypix = conditionById('klypix');
// Each channel is read from the structured result, so a fact that reached the
// agent by another route cannot pass for the one under test.
const hitsText = (sc) => (sc.context?.hits || []).map((h) => h.text || '').join('\n');
const expectations = {
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
    return /NOT retried/.test(t) && (!/retry failed webhook deliveries 3 times/.test(t) || t.indexOf('NOT retried') < t.indexOf('retry failed webhook deliveries 3 times'));
  }, 'its context leads with the no-retry decision, ahead of the archived retry rule, out of forty cards'],
  's8-partner-limit-not-in-repo': [(sc) => /24 characters/.test(hitsText(sc)), 'its context carries the partner limit no file holds'],
};
const syncAs = async (server, repo, sessionId, task, phase = 'start') => {
  const c = new Client({ name: 'cobench-agent', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: server.command, args: server.args, cwd: repo.dir, stderr: 'pipe',
    env: { ...process.env, ...server.env, ...(sessionId ? { KLYPIX_SESSION_ID: sessionId } : {}) },
  }));
  try {
    const res = await c.callTool({ name: 'brain_sync', arguments: { project: repo.dir, phase, intent: task.slice(0, 160), include_context: true } });
    return { isError: !!res.isError, sc: res.structuredContent || {} };
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
    const { isError, sc } = await syncAs(server, repo, null, s.task);
    const [check, what] = expectations[s.id];
    ok(!isError && check(sc), `B3 ${s.id}: the agent's first brain_sync — ${what}`);
    if (s.id === 's6-fact-arrives-mid-task') {
      // The decision is made while the agent works: a card plus a broadcast
      // note. The agent's NEXT sync (same session, so its lane row is live)
      // carries it — as the note, or as context.
      const out = await klypix.later({ repo, scenario: s, sessionIds });
      ok(out.delivered.length === 1, `B3 ${s.id}: the mid-task decision is written as a card and read back`);
      const next = await syncAs(server, repo, null, s.task, 'checkpoint');
      const seen = (next.sc.messages || []).some((m) => /MINOR units/.test(m.text || '')) || /MINOR units/.test(hitsText(next.sc));
      ok(!next.isError && seen, `B3 ${s.id}: the agent's next brain_sync hands it the decision (note or context)`);
    }
    if (s.id === 's7-decision-buried-in-history') {
      const { struct } = await parseKlypix(fs.readFileSync(path.join(repo.dir, 'brain.klypix')));
      ok(struct.cards.length >= 26, `B3 ${s.id}: the brain is as cluttered as the file — ${struct.cards.length} cards, the history included`);
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
const w = wilson(5, 5);
ok(w.p === 1 && w.low > 0.5 && w.low < 0.6 && w.high === 1, 'B4: Wilson interval for 5/5 is about 57%–100% (five runs prove little)');
const synthetic = [
  ...Array.from({ length: 20 }, (_, i) => ({ scenario: 's1-changed-decision', condition: 'klypix', agent: 'claude', run: i, success: i < 19, staleAction: false, relays: 0 })),
  ...Array.from({ length: 20 }, (_, i) => ({ scenario: 's1-changed-decision', condition: 'none', agent: 'claude', run: i, success: i < 3, staleAction: i >= 3, relays: 0 })),
  ...Array.from({ length: 3 }, (_, i) => ({ scenario: 's3-note-from-closed-session', condition: 'klypix', agent: 'claude', run: i, success: true, staleAction: false, relays: 0 })),
  ...Array.from({ length: 3 }, (_, i) => ({ scenario: 's3-note-from-closed-session', condition: 'none', agent: 'claude', run: i, success: i < 1, staleAction: i >= 1, relays: 0 })),
];
const md = toMarkdown(summarize(synthetic));
ok(/A decision changed today: KLYPIX 95% vs none 15%/.test(md) && !/A note left by a session that has ended: KLYPIX/.test(md),
  'B4: the report calls the 20-run gap a difference and the 3-run gap a tie');
ok(/## Not measured/.test(md) && /MCP Agent Mail/.test(md), 'B4: the report lists the tools it did not measure, with the reason');
const naMd = toMarkdown(summarize([
  { scenario: 's6-fact-arrives-mid-task', condition: 'relay', agent: 'claude', run: 1, notApplicable: 'a paste at start cannot carry it', success: false, staleAction: false },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 1, success: false, staleAction: true, handled: true },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 2, success: true, staleAction: false, handled: true },
  { scenario: 's2-overlapping-work', condition: 'klypix', agent: 'claude', run: 3, success: false, staleAction: true, handled: false, mcpCalls: { brain_sync: 1 } },
]));
ok(/n\/a: a paste at start cannot carry it/.test(naMd), 'B4: a condition a scenario cannot apply to prints as n/a with its reason, never as 0%');
ok(/\| 2\/3 \| —/.test(naMd) && /Handled overlap/.test(naMd), 'B4: the "handled overlap" column counts a flagged conflict beside the strict grade (2/3)');

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
