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
//        lib/price.js (S2), the closed session's directed note (S3), the other
//        vendor's root cause (S4).
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
const { oracle, composePrompt, codexMcpOverrides } = await import('../bench/coordination/agents.mjs');
const { runOne } = await import('../bench/coordination/run.mjs');
const { summarize, toMarkdown } = await import('../bench/coordination/report.mjs');
const { makeRepo } = await import('../bench/coordination/lib/repo.mjs');
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
      const g = s.grade(repo);
      if (which === 'good') ok(g.success === true && g.staleAction === false, `B1 ${s.id}: the correct answer passes the hidden test and is not flagged stale`);
      else ok(g.success === false && g.staleAction === true, `B1 ${s.id}: the naive answer fails and is flagged as acting on stale information`);
      if (s.id === 's2-overlapping-work') ok(g.collision === (which === 'naive'), `B1 ${s.id}: git merge-tree reports a conflict only for the naive answer (${which})`);
    } finally { repo.remove(); }
  }
}

// ── B2: dry run over every runnable condition ───────────────────────────────
const runnable = CONDITIONS.filter((c) => c.runnable);
ok(runnable.map((c) => c.id).join(',') === 'none,relay,agents-md-kept,agents-md-appended,klypix', 'B2: five conditions are runnable on any machine');
ok(CONDITIONS.filter((c) => !c.runnable).every((c) => c.reason && c.reason.length > 20), 'B2: every planned condition says why it is not measured');
const rows = [];
for (const s of SCENARIOS.filter(applies)) {
  for (const c of runnable) {
    const r = await runOne({ scenario: s, condition: c, agent: oracle, run: 1, timeoutMs: 60_000 });
    rows.push(r);
    const expectPass = c.id !== 'none';
    ok(r.error === null && r.success === expectPass && r.staleAction === !expectPass && r.delivered === (expectPass ? s.facts.length : 0),
      `B2 ${s.id} × ${c.id}: ${expectPass ? 'facts delivered (read back) → pass' : 'nothing delivered → fail, stale action'}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
  }
}
ok(rows.filter((r) => r.condition === 'relay').every((r) => r.relays === r.facts) && rows.filter((r) => r.condition !== 'relay').every((r) => r.relays === 0),
  'B2: only the copy-paste condition counts human relays');

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
  's3-note-from-closed-session': [(sc) => (sc.messages || []).some((m) => m.from === 'actor-s3-migrations' && /backfill:emails/.test(m.text) && /migrate:002/.test(m.text)) && !/backfill:emails/.test(hitsText(sc)),
    'it is handed the ended session\'s directed note (and the brain does not also carry it)'],
  's4-root-cause-from-other-vendor': [(sc) => /req\.userId/.test(hitsText(sc)), 'its context carries the other vendor\'s root cause'],
};
const syncAs = async (server, repo, sessionId, task) => {
  const c = new Client({ name: 'cobench-agent', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: server.command, args: server.args, cwd: repo.dir, stderr: 'pipe',
    env: { ...process.env, ...server.env, ...(sessionId ? { KLYPIX_SESSION_ID: sessionId } : {}) },
  }));
  try {
    const res = await c.callTool({ name: 'brain_sync', arguments: { project: repo.dir, phase: 'start', intent: task.slice(0, 160), include_context: true } });
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
    if (s.id === 's3-note-from-closed-session') {
      // Directed means directed: another session starting here gets nothing.
      const other = await syncAs(server, repo, `bench-bystander-${Date.now().toString(36)}`, s.task);
      ok(!other.isError && !(other.sc.messages || []).some((m) => m.from === 'actor-s3-migrations'), `B3 ${s.id}: a different session starting here is not handed the note`);
    }
    const { isError, sc } = await syncAs(server, repo, null, s.task);
    const [check, what] = expectations[s.id];
    ok(!isError && check(sc), `B3 ${s.id}: the agent's first brain_sync — ${what}`);
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

// A server child that is still exiting can hold a file in the sandbox for a
// moment on Windows (EBUSY); that must never hide the verdict below.
try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS temp cleaner */ }
console.log(failures ? `\n${failures} coordination-bench check(s) FAILED` : '\nall coordination-bench checks passed');
process.exit(failures ? 1 : 0);
