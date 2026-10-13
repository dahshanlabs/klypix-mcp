#!/usr/bin/env node
// Turn results.jsonl into the published table.
//   node bench/coordination/report.mjs results.jsonl [--json]
//
// Every number carries its n and a 95% Wilson interval. A "difference" is only
// called out when the two intervals do not overlap. Overlap does not prove a tie.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { wilson, median, pct } from './lib/stats.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { CONDITIONS } from './conditions.mjs';
import { lastRowPerRun, parseResults, assertSameExperiment } from './lib/results.mjs';
export { lastRowPerRun } from './lib/results.mjs';

export function summarize(rows) {
  assertSameExperiment(rows);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.scenario}|${r.condition}|${r.agent}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const cells = [];
  for (const [key, all] of groups) {
    const [scenario, condition, agent] = key.split('|');
    // A run whose channel never came up, or whose mid-task fact landed after
    // the agent's last action, measured nothing about the channel: shown as
    // invalid, never counted as a pass or a fail. A condition the scenario
    // cannot apply to is shown as n/a with its reason.
    const na = all.find((r) => r.notApplicable)?.notApplicable || null;
    const rs = all.filter((r) => !r.invalid && !r.notApplicable);
    const invalidRuns = all.filter((r) => r.invalid).length;
    if (!rs.length) { cells.push({ scenario, condition, agent, n: 0, invalidRuns, notApplicable: na, success: { k: 0, ...wilson(0, 0) }, staleActions: { k: 0, ...wilson(0, 0) }, relaysPerTask: 0, medianCostUsd: null, medianTokens: null, medianMinutes: null, errors: 0, consulted: 0, handled: 0, handledKnown: 0, versions: [], models: [] }); continue; }
    const n = rs.length;
    const ok = rs.filter((r) => r.success && !r.error && !r.timedOut && r.agentOk !== false).length;
    // "Acted on stale information" is judged only over runs that completed: a
    // timed-out or budget-capped run leaves files untouched, which is not deference.
    const completed = rs.filter((r) => !r.error && !r.timedOut && r.agentOk !== false);
    const stale = completed.filter((r) => r.staleAction).length;
    const errors = n - completed.length;
    cells.push({
      scenario, condition, agent, n, invalidRuns,
      success: { k: ok, ...wilson(ok, n) },
      staleActions: { k: stale, n: completed.length, ...wilson(stale, completed.length) },
      relaysPerTask: rs.reduce((a, r) => a + (r.relays || 0), 0) / n,
      medianCostUsd: median(rs.map((r) => r.costUsd)),
      medianTokens: median(rs.map((r) => r.tokens)),
      medianMinutes: median(rs.map((r) => (r.durationMs || 0) / 60000)),
      errors,
      // Runs in which the agent called the condition's MCP server at all.
      consulted: rs.filter((r) => r.mcpCalls && Object.keys(r.mcpCalls).length > 0).length,
      // Scenarios that define it: S2, the overlap was handled — merged away,
      // or named in the agent's final message (a flagged conflict is not an
      // unnoticed one, even when the strict grade fails it); S6, the decision
      // was applied or surfaced with its source, only where it was delivered.
      handled: rs.filter((r) => r.handled === true).length,
      handledKnown: rs.filter((r) => r.handled === true || r.handled === false).length,
      versions: [...new Set(rs.map((r) => r.versions).filter(Boolean))],
      models: [...new Set(rs.map((r) => r.model).filter(Boolean))],
    });
  }
  return cells;
}

const overlaps = (a, b) => a.low != null && b.low != null && !(a.high < b.low || b.high < a.low);

export function toMarkdown(cells, rows = []) {
  const out = ['# KLYPIX coordination bench — results', ''];
  if (rows.some(r => !r.experimentId)) out.push('> Historical rows: experiment identity was not recorded. Configuration compatibility cannot be verified; these numbers are not evidence for the current build.', '');
  else if (rows.length) out.push(`Experiment: \`${rows[0].experimentId}\``, '');
  const agents = [...new Set(cells.map((c) => c.agent))];
  for (const agent of agents) {
    const mine = cells.filter((c) => c.agent === agent);
    const versions = [...new Set(mine.flatMap((c) => c.versions))];
    const models = [...new Set(mine.flatMap((c) => c.models))];
    out.push(`## Agent: ${agent}`, '');
    if (versions.length || models.length) out.push(`${versions.length ? `CLI: ${versions.join(', ')}` : ''}${versions.length && models.length ? ' · ' : ''}${models.length ? `model: ${models.join(', ')}` : ''}`, '');
    if (agent === 'oracle') out.push('> **Dry run — not a result.** The scripted oracle answers correctly whenever the facts were delivered. These rows prove the graders and the delivery, never how an agent behaves.', '');
    out.push( '| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Handled | Median cost | Median min |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const s of SCENARIOS) {
      for (const c of CONDITIONS) {
        const cell = cells.find((x) => x.agent === agent && x.scenario === s.id && x.condition === c.id);
        if (!cell) continue;
        if (cell.notApplicable) { out.push(`| ${s.title} | ${c.label} | — | n/a: ${cell.notApplicable} | — | — | — | — | — | — |`); continue; }
        out.push(`| ${s.title}${s.role ? ` _(${s.role})_` : ''} | ${c.label} | ${cell.n}${cell.invalidRuns ? ` (+${cell.invalidRuns} invalid)` : ''} | ${pct(cell.success.p)} (${pct(cell.success.low)}–${pct(cell.success.high)}) | ${cell.staleActions.k}/${cell.staleActions.n ?? cell.n}${cell.errors ? ` (+${cell.errors} err)` : ''} | ${cell.relaysPerTask.toFixed(1)} | ${String(c.id).startsWith('klypix') ? `${cell.consulted}/${cell.n}` : '—'} | ${cell.handledKnown ? `${cell.handled}/${cell.handledKnown}` : '—'} | ${cell.medianCostUsd == null ? '—' : `$${cell.medianCostUsd.toFixed(2)}`} | ${cell.medianMinutes == null ? '—' : cell.medianMinutes.toFixed(1)} |`);
      }
    }
    out.push('');
    // Both directions, every measured condition: a KLYPIX loss is listed as
    // plainly as a win. A cell that was not run (n/a, or n = 0) has no
    // interval and is never compared.
    out.push('**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:');
    let any = false;
    const measured = (c) => c && !c.notApplicable && c.n > 0 && c.success.low != null;
    for (const s of SCENARIOS) {
      const forS = cells.filter((x) => x.agent === agent && x.scenario === s.id);
      for (const k of forS.filter((x) => String(x.condition).startsWith('klypix') && measured(x))) {
        const name = k.condition === 'klypix' ? 'KLYPIX' : k.condition;
        for (const other of forS) {
          if (String(other.condition).startsWith('klypix') || !measured(other)) continue;
          if (!overlaps(k.success, other.success)) {
            const ahead = k.success.p > other.success.p;
            out.push(`- ${s.title}: ${name} ${ahead ? 'ahead of' : 'BEHIND'} ${other.condition} — ${pct(k.success.p)} vs ${pct(other.success.p)}`);
            any = true;
          }
        }
      }
    }
    if (!any) out.push('- none at this sample size — overlapping intervals do not establish equivalence.');
    out.push('');
  }
  const notRun = CONDITIONS.filter((c) => !c.runnable);
  if (notRun.length) {
    out.push('## Not measured', '');
    for (const c of notRun) out.push(`- **${c.label}** — ${c.reason}`);
    out.push('');
  }
  const reasons = new Map();
  for (const r of rows) if (r.invalid) { const k = String(r.error || 'invalid').split(':')[0]; reasons.set(k, (reasons.get(k) || 0) + 1); }
  if (reasons.size) {
    out.push('## Invalid runs (excluded from every rate)', '');
    for (const [k, n] of reasons) out.push(`- ${k}: ${n}`);
    out.push('');
  }
  out.push('_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: report.mjs results.jsonl [--json]'); process.exit(2); }
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const input = files.flatMap(p => {
    const parsed = parseResults(fs.readFileSync(p, 'utf8'), p);
    if (parsed.discardedTail) console.error(`${p}: ignored unfinished final JSON line`);
    return parsed.rows;
  });
  if (files.length > 1 && input.some(r => !r.experimentId) && !process.argv.includes('--legacy-merge')) throw new Error('Historical files have no experiment identity. Report separately, or use --legacy-merge only after verifying they are continuations of the same experiment.');
  const rows = lastRowPerRun(input);
  const cells = summarize(rows);
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(cells, null, 2)}\n` : `${toMarkdown(cells, rows)}\n`);
}
