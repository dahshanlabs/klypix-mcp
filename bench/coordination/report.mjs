#!/usr/bin/env node
// Turn results.jsonl into the published table.
//   node bench/coordination/report.mjs results.jsonl [--json]
//
// Every number carries its n and a 95% Wilson interval. A "difference" is only
// called out when the two intervals do not overlap — anything else is a tie,
// and the report says so.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { wilson, median, pct } from './lib/stats.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { CONDITIONS } from './conditions.mjs';

export function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.scenario}|${r.condition}|${r.agent}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const cells = [];
  for (const [key, all] of groups) {
    const [scenario, condition, agent] = key.split('|');
    // A run whose channel never came up measured nothing about it: shown as
    // invalid, never counted as a pass or a fail.
    const rs = all.filter((r) => !r.invalid);
    const invalidRuns = all.length - rs.length;
    if (!rs.length) { cells.push({ scenario, condition, agent, n: 0, invalidRuns, success: { k: 0, ...wilson(0, 0) }, staleActions: { k: 0, ...wilson(0, 0) }, relaysPerTask: 0, medianCostUsd: null, medianTokens: null, medianMinutes: null, errors: 0, consulted: 0, versions: [], models: [] }); continue; }
    const n = rs.length;
    const ok = rs.filter((r) => r.success).length;
    const stale = rs.filter((r) => r.staleAction).length;
    const errors = rs.filter((r) => r.error).length;
    cells.push({
      scenario, condition, agent, n, invalidRuns,
      success: { k: ok, ...wilson(ok, n) },
      staleActions: { k: stale, ...wilson(stale, n) },
      relaysPerTask: rs.reduce((a, r) => a + (r.relays || 0), 0) / n,
      medianCostUsd: median(rs.map((r) => r.costUsd)),
      medianTokens: median(rs.map((r) => r.tokens)),
      medianMinutes: median(rs.map((r) => (r.durationMs || 0) / 60000)),
      errors,
      // Runs in which the agent called the condition's MCP server at all.
      consulted: rs.filter((r) => r.mcpCalls && Object.keys(r.mcpCalls).length > 0).length,
      versions: [...new Set(rs.map((r) => r.versions).filter(Boolean))],
      models: [...new Set(rs.map((r) => r.model).filter(Boolean))],
    });
  }
  return cells;
}

const overlaps = (a, b) => a.low != null && b.low != null && !(a.high < b.low || b.high < a.low);

export function toMarkdown(cells) {
  const out = ['# KLYPIX coordination bench — results', ''];
  const agents = [...new Set(cells.map((c) => c.agent))];
  for (const agent of agents) {
    const mine = cells.filter((c) => c.agent === agent);
    const versions = [...new Set(mine.flatMap((c) => c.versions))];
    const models = [...new Set(mine.flatMap((c) => c.models))];
    out.push(`## Agent: ${agent}`, '');
    if (versions.length || models.length) out.push(`${versions.length ? `CLI: ${versions.join(', ')}` : ''}${versions.length && models.length ? ' · ' : ''}${models.length ? `model: ${models.join(', ')}` : ''}`, '');
    if (agent === 'oracle') out.push('> **Dry run — not a result.** The scripted oracle answers correctly whenever the facts were delivered. These rows prove the graders and the delivery, never how an agent behaves.', '');
    out.push( '| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Median cost | Median min |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of SCENARIOS) {
      for (const c of CONDITIONS) {
        const cell = cells.find((x) => x.agent === agent && x.scenario === s.id && x.condition === c.id);
        if (!cell) continue;
        out.push(`| ${s.title} | ${c.label} | ${cell.n}${cell.invalidRuns ? ` (+${cell.invalidRuns} invalid)` : ''} | ${pct(cell.success.p)} (${pct(cell.success.low)}–${pct(cell.success.high)}) | ${cell.staleActions.k}/${cell.n} | ${cell.relaysPerTask.toFixed(1)} | ${c.id === 'klypix' ? `${cell.consulted}/${cell.n}` : '—'} | ${cell.medianCostUsd == null ? '—' : `$${cell.medianCostUsd.toFixed(2)}`} | ${cell.medianMinutes == null ? '—' : cell.medianMinutes.toFixed(1)} |`);
      }
    }
    out.push('');
    out.push('**Clear differences** (95% intervals do not overlap):');
    let any = false;
    for (const s of SCENARIOS) {
      const forS = cells.filter((x) => x.agent === agent && x.scenario === s.id);
      const k = forS.find((x) => x.condition === 'klypix');
      if (!k) continue;
      for (const other of forS) {
        if (other.condition === 'klypix' || other.condition === 'relay') continue;
        if (!overlaps(k.success, other.success) && k.success.p > other.success.p) {
          out.push(`- ${s.title}: KLYPIX ${pct(k.success.p)} vs ${other.condition} ${pct(other.success.p)}`);
          any = true;
        }
      }
    }
    if (!any) out.push('- none at this sample size — report these as ties.');
    out.push('');
  }
  const notRun = CONDITIONS.filter((c) => !c.runnable);
  if (notRun.length) {
    out.push('## Not measured', '');
    for (const c of notRun) out.push(`- **${c.label}** — ${c.reason}`);
    out.push('');
  }
  out.push('_Scripted "other session" actors; hidden tests; no LLM judge. Relay = the human pasted the facts (upper bound). "invalid" = the server of the condition never came up for that run; it is excluded from the rates, not counted as a fail._');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: report.mjs results.jsonl [--json]'); process.exit(2); }
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cells = summarize(rows);
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(cells, null, 2)}\n` : `${toMarkdown(cells)}\n`);
}
