#!/usr/bin/env node
// Coordination bench runner.
//
//   node bench/coordination/run.mjs --dry-run                 # oracle only, zero model calls
//   node bench/coordination/run.mjs --live --agent claude --runs 5 --out results.jsonl
//       [--scenario s1,s2] [--condition none,relay,klypix] [--timeout 600] [--keep]
//       [--claude-model <id>] [--codex-model <id>] [--max-budget 2]   (Claude's per-run dollar cap)
//       [--transcripts <dir>]   (each agent's raw output, for auditing a published number)
//       [--klypix-bin <path>]   (the KLYPIX server to measure; default this checkout's bin/klypix-mcp.mjs)
//       [--codex-effort <low|medium|high|xhigh|max>]   (pinned on every Codex run and recorded; default: the model's own)
//       [--shuffle <seed>]   (seeded random run order across all cells; recorded per row)
//       KLYPIX_BENCH_SEMANTIC_DIR=<dir>   (a prepared copy of semantic/ + hf-cache/ for klypix-installed)
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
import { CONDITIONS, conditionById, appendedNotApplicable, klypixServerInfo, isKlypixCondition, semanticDirOrNull, semanticPreflight, semanticDirFingerprint, SEMANTIC_DIR_ENV } from './conditions.mjs';
import { agentById, composePrompt, CHANNEL_DOWN } from './agents.mjs';

/** Deterministic in-place shuffle (mulberry32), so an order can be reproduced from its seed. */
export function shuffleInPlace(list, seed) {
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

/** Why a (scenario, condition) cell is not run, or null. */
export function notApplicableReason(scenario, condition, agent = null) {
  if (agent && typeof condition.notApplicableFor === 'function') { const why = condition.notApplicableFor(agent); if (why) return why; }
  if (scenario.notApplicable?.[condition.id]) return scenario.notApplicable[condition.id];
  if (condition.id === 'agents-md-appended') return appendedNotApplicable(scenario);
  return null;
}
import { makeRepo, commitAgentWork } from './lib/repo.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const list = (v, all) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : all);

// Every way a run can fail to measure its channel is INVALID — kept, shown
// beside n, excluded from rates — never counted as the channel failing:
//   CHANNEL_DOWN        the condition's server never came up (agents.mjs)
//   FACT_NOT_DELIVERED  the condition's write did not land (read back short),
//                       at start or mid-task
//   FACT_NOT_FIRED      a mid-task fact never fired: no file write was seen
//   FACT_TOO_LATE       it fired after the agent's last action
//   HARNESS_ERROR       the bench itself threw (build, write, grader)
export const FACT_TOO_LATE = 'fact-arrived-after-last-action';
export const FACT_NOT_FIRED = 'fact-never-fired-no-edit-seen';
export const FACT_NOT_DELIVERED = 'channel-write-did-not-land';
export const HARNESS_ERROR = 'harness-error';
// klypix-installed: no hook started at all (wrapper, PATH or shell failure) —
// the run measured MCP-only, not the installed product.
export const HOOKS_DID_NOT_RUN = 'hooks-did-not-run';
export const isInvalidReason = (error) => !!error && (error === CHANNEL_DOWN || error === FACT_TOO_LATE || error === FACT_NOT_FIRED
  || String(error).startsWith(FACT_NOT_DELIVERED) || String(error).startsWith(HARNESS_ERROR) || error === HOOKS_DID_NOT_RUN);

/** Why this run measured nothing about its channel, or null. */
export function validityError({ scenario, condition, agent, prep, later, laterFiredAtMs, lastToolAtMs, hookRuns = null }) {
  if (condition.id === 'none') return null;
  // A hook that ran and failed is the product's outcome (kept); no hook
  // starting at all is the bench's (invalid).
  if (hookRuns && agent.id !== 'oracle' && !hookRuns.sessionStart) return HOOKS_DID_NOT_RUN;   // carries nothing by design
  const startFacts = scenario.facts.length;
  if ((prep.delivered || []).length < startFacts) return `${FACT_NOT_DELIVERED}: ${(prep.delivered || []).length}/${startFacts} at start`;
  // A scenario that needs the product to LIST the stopped session (its own
  // window and evidence rules) measured nothing about KLYPIX when it did not.
  if (scenario.requireListed && isKlypixCondition(condition) && !prep.actorListed) return `${FACT_NOT_DELIVERED}: the stopped session is not listed as unfinished work`;
  if (!scenario.later) return null;
  if (!later.fired) return agent.id === 'oracle' ? null : FACT_NOT_FIRED;
  const want = scenario.later.facts?.length || 0;
  if (later.error || later.delivered.length < want) return `${FACT_NOT_DELIVERED}: mid-task${later.error ? ` (${later.error})` : ` ${later.delivered.length}/${want}`}`;
  if (agent.id !== 'oracle' && lastToolAtMs != null && laterFiredAtMs != null && laterFiredAtMs > lastToolAtMs) return FACT_TOO_LATE;
  return null;
}

export async function runOne({ scenario, condition, agent, run, timeoutMs, keep = false, agentOptions = {}, transcriptDir = null, klypixServer = null }) {
  const repo = makeRepo(`klypix-cobench-${scenario.id.split('-')[0]}-`);
  // KLYPIX files of this run (lane, registry) live here, never in the user's home.
  const benchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cobench-home-'));
  const sessionIds = { agent: crypto.randomUUID() };
  const started = Date.now();
  const totalFacts = scenario.facts.length + (scenario.later?.facts?.length || 0);
  let prep = { relays: 0, delivered: [] };
  let hb = null;
  const later = { fired: false, firing: false, firedAt: null, anchor: null, delivered: [], notePosted: null, error: null };
  let onEvent = null;
  try {
    scenario.build(repo);
    prep = await condition.prepare({ repo, scenario, agent, sessionIds, benchHome, klypixBin: klypixServer?.bin ?? null });
    if (prep.heartbeat) hb = setInterval(() => { try { prep.heartbeat(); } catch { /* */ } }, 60_000);
    const prompt = composePrompt(scenario.task, prep.promptAddendum);
    // What the instructions files said when the agent started — a grader may
    // need to know whether a stale line was in front of the agent (S5).
    const notesAtStart = `${repo.read('AGENTS.md') || ''}\n${repo.read('CLAUDE.md') || ''}`;
    // A decision made WHILE the agent works: the condition carries it the way it
    // would in real life (a file edited on disk, a brain card and a note). It is
    // anchored to the agent's own progress — its FIRST file write, seen in its
    // output stream — so every condition pays the same: the agent has committed
    // to an answer built on what it knew, then the world changes. There is no
    // clock fallback (a clock from launch would charge KLYPIX its server start-up
    // and could land the fact before the agent's first channel read): a run in
    // which no write was seen never gets the fact and is invalid. The scripted
    // oracle acts instantly, so for it the fact lands at once — the dry run
    // proves delivery, not timing.
    if (scenario.later && typeof condition.later === 'function') {
      const fire = async (anchor) => {
        if (later.fired || later.firing) return;
        later.firing = true; later.anchor = anchor;
        try { const out = await condition.later({ repo, scenario, sessionIds, benchHome, prep }); later.delivered = out?.delivered || []; later.notePosted = out?.notePosted ?? null; } catch (err) { later.error = String(err?.message || err); }
        later.fired = true; later.firedAt = Date.now();
      };
      if (agent.id === 'oracle') await fire('immediate');
      else onEvent = (kind) => { if (kind === 'edit') fire('first-edit'); };
    }
    const delivered = [...(prep.delivered || []), ...later.delivered];
    const res = await agent.run({ repo, scenario, prompt, mcpServers: prep.mcpServers || {}, sessionId: sessionIds.agent, delivered, timeoutMs, onEvent, ...agentOptions });
    // A fire still in flight when the agent exits must finish before grading.
    for (let i = 0; i < 100 && later.firing && !later.fired; i++) await new Promise((r) => setTimeout(r, 100));
    // On the agent's own clock (both stamps are absolute, so no origin drift).
    const laterFiredAtMs = later.fired && later.firedAt != null ? (res.startedAt != null ? later.firedAt - res.startedAt : 0) : null;
    if (transcriptDir && res.raw) {
      // The agent's own output, kept so any published number can be audited run by run.
      fs.mkdirSync(transcriptDir, { recursive: true });
      // The scenario's own short id (s10, s5b): two characters would file S10's
      // transcripts over S1's.
      const base = path.join(transcriptDir, `${scenario.id.split('-')[0]}-${condition.id}-${agent.id}-${run}`);
      fs.writeFileSync(`${base}.out.jsonl`, res.raw.stdout || '');
      if (res.raw.stderr) fs.writeFileSync(`${base}.err.txt`, res.raw.stderr);
    }
    commitAgentWork(repo, 'bench: agent work (uncommitted remainder)');
    for (const [rel, text] of Object.entries(scenario.hidden)) repo.write(rel, text);
    const deliveredIds = [...(prep.delivered || []), ...later.delivered];
    const g = scenario.grade(repo, { finalMessage: res.finalMessage || '', deliveredIds, notesAtStart, promptAddendum: prep.promptAddendum || '' });
    const hookRuns = typeof prep.hookRuns === 'function' ? prep.hookRuns() : null;
    const error = res.error || validityError({ scenario, condition, agent, prep, later, laterFiredAtMs, lastToolAtMs: res.lastToolAtMs, hookRuns });
    return {
      scenario: scenario.id, condition: condition.id, agent: agent.id, run,
      success: !!g.success, staleAction: !!g.staleAction, collision: g.collision, handled: g.handled ?? null,
      ...(g.untouched != null ? { untouched: g.untouched } : {}), ...(g.workedAround != null ? { workedAround: g.workedAround } : {}),
      ...(g.sendCalls != null ? { sendCalls: g.sendCalls } : {}), ...(g.display != null ? { display: g.display } : {}),
      relays: prep.relays || 0, delivered: deliveredIds.length, facts: totalFacts,
      ...(scenario.later ? { laterAnchor: later.anchor, laterFiredAtMs, laterNotePosted: later.notePosted, laterError: later.error } : {}),
      firstToolAtMs: res.firstToolAtMs ?? null, firstEditAtMs: res.firstEditAtMs ?? null, firstMcpAtMs: res.firstMcpAtMs ?? null, lastToolAtMs: res.lastToolAtMs ?? null,
      ...(res.codexGlobalRules !== undefined ? { codexGlobalRules: res.codexGlobalRules } : {}),
      agentOk: res.ok, model: res.model ?? null, permissionDenials: res.permissionDenials ?? null, mcpCalls: res.mcpCalls ?? null, channelUp: res.channelUp ?? null,
      invalid: isInvalidReason(error), costUsd: res.costUsd ?? null, tokens: res.tokens ?? null, turns: res.turns ?? null,
      durationMs: res.durationMs ?? (Date.now() - started), timedOut: !!res.timedOut,
      ...(isKlypixCondition(condition) && klypixServer ? { klypixServer } : {}),
      ...(isKlypixCondition(condition) ? { actorListed: prep.actorListed ?? null, semantic: prep.semantic ?? false } : {}),
      ...(hookRuns ? { hookRuns } : {}),
      ...(g.named != null ? { named: g.named, namedSentence: g.namedSentence ?? null } : {}),
      ...(g.strict != null ? { strict: g.strict } : {}),
      ...(g.heldOff != null ? { heldOff: g.heldOff } : {}),
      ...(g.overrodeKnowingly != null ? { overrodeKnowingly: g.overrodeKnowingly } : {}),
      ...(g.peerMerged != null ? { peerMerged: g.peerMerged, peerMoved: g.peerMoved } : {}),
      ...(g.workMerged != null ? { workMerged: g.workMerged, workMoved: g.workMoved } : {}),
      ...(g.pageDefault !== undefined ? { paged: g.paged, pageDefault: g.pageDefault, pageCap: g.pageCap } : {}),
      ...(res.effort ? { effort: res.effort } : {}),
      error, keptRepo: keep ? repo.dir : null,
    };
  } catch (err) {
    // The bench's own failure (a scenario build, a condition write, a grader)
    // measured nothing about the agent or the channel: invalid, never a fail.
    return { scenario: scenario.id, condition: condition.id, agent: agent.id, run, success: false, staleAction: false, collision: null, handled: null, relays: prep.relays || 0, delivered: 0, facts: totalFacts, agentOk: false, costUsd: null, tokens: null, turns: null, durationMs: Date.now() - started, timedOut: false, invalid: true, error: `${HARNESS_ERROR}: ${String(err?.stack || err).slice(0, 780)}`, keptRepo: keep ? repo.dir : null };
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
    ...(agent.id === 'codex' && opt('codex-effort', null) ? { effort: opt('codex-effort', null) } : {}),
  });
  const out = opt('out', null);
  const klypixBin = opt('klypix-bin', null);
  if (klypixBin && !fs.existsSync(klypixBin)) { console.error(`--klypix-bin: no such file: ${klypixBin}`); process.exit(2); }
  const klypixServer = klypixServerInfo(klypixBin ? path.resolve(klypixBin) : undefined);
  for (const a of agents) if (!a.available()) { console.error(`agent ${a.id} is not installed on this machine`); process.exit(2); }
  const total = scenarios.length * runnable.length * agents.length * runs;
  console.log(`${dry ? 'DRY RUN (oracle, no model calls)' : 'LIVE RUN'}: ${scenarios.length} scenario(s) × ${runnable.length} condition(s) × ${agents.length} agent(s) × ${runs} run(s) = ${total} run(s)`);
  if (runnable.some(isKlypixCondition)) console.log(`KLYPIX server: ${klypixServer.version ?? '?'} @ ${klypixServer.commit ?? 'no git'}${klypixServer.dirty ? ' (modified)' : ''} — ${klypixServer.bin}`);
  // KLYPIX as installed includes search by meaning: a live run needs the
  // prepared copy, proven to load before any model is called, and checked
  // unchanged afterwards (a missing model would be downloaded INTO it).
  let semanticDir = null; let semanticBefore = null;
  if (!dry && runnable.some((c) => c.id === 'klypix-installed') && agents.some((a) => !(conditionById('klypix-installed').notApplicableFor?.(a)))) {
    semanticDir = semanticDirOrNull();
    if (!semanticDir) { console.error(`klypix-installed needs ${SEMANTIC_DIR_ENV} set to a prepared copy of semantic/ and hf-cache/`); process.exit(2); }
    const pre = semanticPreflight(semanticDir);
    console.log(`search by meaning preflight: embedder ${pre.embed ? `ok (${pre.dims} dims)` : 'FAILED'}, reranker ${pre.rerank ? 'ok' : 'FAILED'}`);
    if (!pre.embed || !pre.rerank) { console.error(`search by meaning did not load from ${semanticDir}: ${pre.error || ''}`); process.exit(2); }
    semanticBefore = semanticDirFingerprint(semanticDir);
  }
  if (!dry && !flag('yes') && !(await confirm('This spends model usage on your account. Continue? [y/N] '))) { console.log('cancelled'); return; }
  const versions = {};
  for (const a of agents) versions[a.id] = await a.version();
  const results = [];
  // Run order: by default scenario by scenario, conditions in a fixed order.
  // --shuffle <seed> interleaves every run of every cell in a seeded random
  // order, so no condition always runs last or under the same machine load;
  // each row records its position.
  const plan = [];
  for (const scenario of scenarios) for (const condition of runnable) for (const agent of agents) for (let run = 1; run <= runs; run++) plan.push({ scenario, condition, agent, run });
  const seed = opt('shuffle', null);
  if (seed != null) shuffleInPlace(plan, Number(seed) || 1);
  if (seed != null) console.log(`order: shuffled (seed ${Number(seed) || 1})`);
  for (const [order, { scenario, condition, agent, run }] of plan.entries()) {
    // A condition a scenario cannot apply to (a copy-paste at start cannot
    // carry a decision made later; an appended notes file byte-identical to
    // another condition) is recorded as such, never as a fail — and never run.
    const notApplicable = notApplicableReason(scenario, condition, agent);
    const r = notApplicable
      ? { scenario: scenario.id, condition: condition.id, agent: agent.id, run, notApplicable, success: false, staleAction: false, collision: null, handled: null, relays: 0, delivered: 0, facts: scenario.facts.length + (scenario.later?.facts?.length || 0), agentOk: null, costUsd: null, tokens: null, turns: null, durationMs: 0, timedOut: false, error: null, keptRepo: null }
      : await runOne({ scenario, condition, agent, run, timeoutMs, keep: flag('keep'), agentOptions: agentOptionsFor(agent), transcriptDir: opt('transcripts', null), klypixServer });
    r.versions = versions[agent.id];
    r.order = order;
    if (seed != null) r.shuffleSeed = Number(seed) || 1;
    results.push(r);
    console.log(notApplicable
      ? `n/a   ${scenario.id}  ${condition.id}  ${agent.id}#${run}  (${notApplicable})`
      : `${r.success ? 'PASS' : 'fail'}  ${scenario.id}  ${condition.id}  ${agent.id}#${run}${r.staleAction ? '  stale-action' : ''}${r.collision ? '  merge-conflict' : ''}${r.handled === true && !r.success ? '  handled(flagged)' : ''}${r.error ? `  error: ${r.error.split('\n')[0].slice(0, 120)}` : ''}`);
    if (out) fs.appendFileSync(out, `${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`);
  }
  if (semanticDir) {
    const after = semanticDirFingerprint(semanticDir);
    const same = JSON.stringify(after) === JSON.stringify(semanticBefore);
    console.log(`search by meaning copy ${same ? 'unchanged' : `CHANGED during the run (${JSON.stringify(semanticBefore)} -> ${JSON.stringify(after)})`}`);
  }
  if (!out) process.stdout.write(`${JSON.stringify(results)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
