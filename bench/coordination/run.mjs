#!/usr/bin/env node
// Coordination bench runner.
//
//   node bench/coordination/run.mjs --dry-run                 # oracle only, zero model calls
//   node bench/coordination/run.mjs --live --agent claude --runs 5 --out results.jsonl
//       [--scenario s1,s2] [--condition none,relay,klypix] [--timeout 600] [--keep]
//       [--claude-model <id>] [--codex-model <id>] [--max-budget 2]   (Claude's per-run dollar cap)
//       [--transcripts <dir>]   (each agent's raw output, for auditing a published number)
//
// A live run spends model usage on YOUR account. It prints the run count and
// waits for --yes (or asks on a TTY) before the first agent starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SCENARIOS, scenarioById } from './scenarios.mjs';
import { CONDITIONS, conditionById } from './conditions.mjs';
import { agentById, composePrompt } from './agents.mjs';
import { makeRepo, commitAgentWork } from './lib/repo.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const list = (v, all) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : all);

export async function runOne({ scenario, condition, agent, run, timeoutMs, keep = false, agentOptions = {}, transcriptDir = null }) {
  const repo = makeRepo(`klypix-cobench-${scenario.id.slice(0, 2)}-`);
  // KLYPIX files of this run (lane, registry) live here, never in the user's home.
  const benchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cobench-home-'));
  const sessionIds = { agent: crypto.randomUUID() };
  const started = Date.now();
  let prep = { relays: 0, delivered: [] };
  let hb = null;
  try {
    scenario.build(repo);
    prep = await condition.prepare({ repo, scenario, agent, sessionIds, benchHome });
    if (prep.heartbeat) hb = setInterval(() => { try { prep.heartbeat(); } catch { /* */ } }, 60_000);
    const prompt = composePrompt(scenario.task, prep.promptAddendum);
    const res = await agent.run({ repo, scenario, prompt, mcpServers: prep.mcpServers || {}, sessionId: sessionIds.agent, delivered: prep.delivered || [], timeoutMs, ...agentOptions });
    if (transcriptDir && res.raw) {
      // The agent's own output, kept so any published number can be audited run by run.
      fs.mkdirSync(transcriptDir, { recursive: true });
      const base = path.join(transcriptDir, `${scenario.id.slice(0, 2)}-${condition.id}-${agent.id}-${run}`);
      fs.writeFileSync(`${base}.out.jsonl`, res.raw.stdout || '');
      if (res.raw.stderr) fs.writeFileSync(`${base}.err.txt`, res.raw.stderr);
    }
    commitAgentWork(repo, 'bench: agent work (uncommitted remainder)');
    for (const [rel, text] of Object.entries(scenario.hidden)) repo.write(rel, text);
    const g = scenario.grade(repo);
    return {
      scenario: scenario.id, condition: condition.id, agent: agent.id, run,
      success: !!g.success, staleAction: !!g.staleAction, collision: g.collision,
      relays: prep.relays || 0, delivered: (prep.delivered || []).length, facts: scenario.facts.length,
      agentOk: res.ok, model: res.model ?? null, permissionDenials: res.permissionDenials ?? null, mcpCalls: res.mcpCalls ?? null, costUsd: res.costUsd ?? null, tokens: res.tokens ?? null, turns: res.turns ?? null,
      durationMs: res.durationMs ?? (Date.now() - started), timedOut: !!res.timedOut,
      error: res.error || null, keptRepo: keep ? repo.dir : null,
    };
  } catch (err) {
    return { scenario: scenario.id, condition: condition.id, agent: agent.id, run, success: false, staleAction: false, collision: null, relays: prep.relays || 0, delivered: 0, facts: scenario.facts.length, agentOk: false, costUsd: null, tokens: null, turns: null, durationMs: Date.now() - started, timedOut: false, error: String(err?.stack || err).slice(0, 800), keptRepo: keep ? repo.dir : null };
  } finally {
    if (hb) clearInterval(hb);
    try { prep.cleanup?.(); } catch { /* */ }
    if (!keep) repo.remove();
    try { fs.rmSync(benchHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS temp cleaner */ }
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const dry = flag('dry-run') || !flag('live');
  const agents = dry ? [agentById('oracle')] : list(opt('agent'), ['claude']).map(agentById).filter(Boolean);
  const scenarios = list(opt('scenario'), SCENARIOS.map((s) => s.id)).map(scenarioById).filter(Boolean);
  const conditionIds = list(opt('condition'), CONDITIONS.filter((c) => c.runnable).map((c) => c.id));
  const conditions = conditionIds.map(conditionById).filter(Boolean);
  const skipped = conditions.filter((c) => !c.runnable);
  for (const c of skipped) console.log(`[skip] ${c.id}: ${c.reason}`);
  const runnable = conditions.filter((c) => c.runnable);
  const runs = Number(opt('runs', dry ? '1' : '5'));
  const timeoutMs = Number(opt('timeout', '600')) * 1000;
  // Pin a model for reproducible numbers; every row records the model the CLI actually used.
  const agentOptionsFor = (agent) => ({
    model: opt(`${agent.id}-model`, null),
    ...(agent.id === 'claude' ? { maxBudgetUsd: Number(opt('max-budget', '2')) || null } : {}),
  });
  const out = opt('out', null);
  for (const a of agents) if (!a.available()) { console.error(`agent ${a.id} is not installed on this machine`); process.exit(2); }
  const total = scenarios.length * runnable.length * agents.length * runs;
  console.log(`${dry ? 'DRY RUN (oracle, no model calls)' : 'LIVE RUN'}: ${scenarios.length} scenario(s) × ${runnable.length} condition(s) × ${agents.length} agent(s) × ${runs} run(s) = ${total} run(s)`);
  if (!dry && !flag('yes') && !(await confirm('This spends model usage on your account. Continue? [y/N] '))) { console.log('cancelled'); return; }
  const versions = {};
  for (const a of agents) versions[a.id] = await a.version();
  const results = [];
  for (const scenario of scenarios) for (const condition of runnable) for (const agent of agents) for (let run = 1; run <= runs; run++) {
    const r = await runOne({ scenario, condition, agent, run, timeoutMs, keep: flag('keep'), agentOptions: agentOptionsFor(agent), transcriptDir: opt('transcripts', null) });
    r.versions = versions[agent.id];
    results.push(r);
    console.log(`${r.success ? 'PASS' : 'fail'}  ${scenario.id}  ${condition.id}  ${agent.id}#${run}${r.staleAction ? '  stale-action' : ''}${r.collision ? '  merge-conflict' : ''}${r.error ? `  error: ${r.error.split('\n')[0].slice(0, 120)}` : ''}`);
    if (out) fs.appendFileSync(out, `${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`);
  }
  if (!out) process.stdout.write(`${JSON.stringify(results)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
