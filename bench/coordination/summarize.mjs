#!/usr/bin/env node
// Fold a bench results.jsonl into the small summary the result card renders.
//   node bench/coordination/summarize.mjs <results.jsonl> <out.summary.json>
//
// The summary is the ONLY input render-card.mjs reads. Every number in it is
// computed here from the rows — pass counts, n, Wilson intervals — never typed.
// Scenario titles come from scenarios.mjs, condition labels and the
// "not measured" list from conditions.mjs, so the card says what the kit says.
//
// Shape (another producer may write the same shape from a different source):
//   { generatedAt, agents: [{ key, label, versions, models }],
//     conditions: [{ key, label, version }],
//     scenarios:  [{ key, label, role, cells: [{ condition, n, pass, fail, invalid, ci: [lo, hi] }] }],
//     notMeasured: [{ name, reason }],
//     source, experimentId, runs }
//
// Cells pool every agent that ran the cell (the card has no agent axis; the
// agents block names who ran). `generatedAt` is the LAST ROW's timestamp, not
// the clock, so regenerating from the same rows yields the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { wilson } from './lib/stats.mjs';
import { SCENARIOS, scenarioById } from './scenarios.mjs';
import { CONDITIONS, conditionById } from './conditions.mjs';
import { AGENTS } from './agents.mjs';
import { lastRowPerRun, parseResults } from './lib/results.mjs';

// Short column heads for a 100-column card. Anything else falls back to the
// condition's id, never to a guess.
const SHORT_LABEL = {
  none: 'none',
  relay: 'human relay',
  'agents-md-kept': 'notes file (tidy)',
  'agents-md-appended': 'notes file',
  klypix: 'KLYPIX',
  'klypix-installed': 'KLYPIX (installed)',
  concord: 'Concord',
  'agent-mail': 'Agent Mail',
};

const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const measured = (r) => !r.invalid && !r.notApplicable;
const passed = (r) => !!r.success && !r.error && !r.timedOut && r.agentOk !== false;

export function summarizeForCard(rows, { source = null } = {}) {
  const live = rows.filter(measured);
  const conditionOrder = CONDITIONS.map((c) => c.id);
  const seenConditions = [...new Set(rows.map((r) => r.condition))]
    .sort((a, b) => (conditionOrder.indexOf(a) + 1 || 1e9) - (conditionOrder.indexOf(b) + 1 || 1e9));
  const conditions = seenConditions.map((key) => {
    const mine = live.filter((r) => r.condition === key);
    const version = mine.map((r) => r.klypixServer?.version || r.channelServer?.version || null).find(Boolean) || null;
    return { key, label: SHORT_LABEL[key] || conditionById(key)?.label || key, version };
  });

  const scenarioOrder = SCENARIOS.map((s) => s.id);
  const seenScenarios = [...new Set(rows.map((r) => r.scenario))]
    .sort((a, b) => (scenarioOrder.indexOf(a) + 1 || 1e9) - (scenarioOrder.indexOf(b) + 1 || 1e9));
  const scenarios = seenScenarios.map((key) => {
    const def = scenarioById(key);
    const cells = conditions.map((c) => {
      const all = rows.filter((r) => r.scenario === key && r.condition === c.key);
      const rs = all.filter(measured);
      const pass = rs.filter(passed).length;
      const w = wilson(pass, rs.length);
      return { condition: c.key, n: rs.length, pass, fail: rs.length - pass, invalid: all.filter((r) => r.invalid).length, ci: [round4(w.low), round4(w.high)] };
    });
    return { key, label: def?.title || key, role: def?.role || null, cells };
  });

  const agents = [...new Set(rows.map((r) => r.agent))].map((key) => {
    const mine = rows.filter((r) => r.agent === key);
    return {
      key,
      label: AGENTS.find((a) => a.id === key)?.label || key,
      versions: [...new Set(mine.map((r) => r.versions).filter(Boolean))],
      models: [...new Set(mine.map((r) => r.model).filter(Boolean))],
    };
  });

  // A condition the rows measured is measured, whatever this machine lacks
  // today (Concord's install check is per machine); only conditions with no
  // row at all are listed, each with the kit's own reason.
  const notMeasured = CONDITIONS.filter((c) => !c.runnable && !seenConditions.includes(c.id)).map((c) => ({ name: c.label, reason: c.reason }));
  const generatedAt = rows.map((r) => r.at).filter(Boolean).sort().at(-1) || null;
  const experimentId = rows.find((r) => r.experimentId)?.experimentId || null;
  return { generatedAt, agents, conditions, scenarios, notMeasured, source, experimentId, runs: live.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: summarize.mjs <results.jsonl> <out.summary.json>'); process.exit(2); }
  const parsed = parseResults(fs.readFileSync(input, 'utf8'), input);
  if (parsed.discardedTail) console.error(`${input}: ignored unfinished final JSON line`);
  const rows = lastRowPerRun(parsed.rows);
  const summary = summarizeForCard(rows, { source: path.relative(path.join(path.dirname(output)), input).split(path.sep).join('/') });
  fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`${output}: ${summary.scenarios.length} scenario(s) × ${summary.conditions.length} condition(s), ${summary.runs} run(s)`);
}
