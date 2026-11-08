#!/usr/bin/env node
// A compact, machine-readable summary of one or more result files, for
// renderers (a GIF, a chart) that must not re-derive the statistics.
//   node bench/coordination/summary.mjs <out.summary.json> <results.jsonl> [more.jsonl …]
//
// Each input file is one experiment (one agent, one configuration); files are
// summarized separately — their rows are never pooled — and their cells are
// listed side by side, each carrying its `agent`. Keys are stable:
//   { generatedAt, agents, experiments, conditions: [{ key, label, version }],
//     scenarios: [{ key, label, role, cells: [{ agent, condition, n, pass, fail, invalid, ci: [lo, hi], notApplicable }] }],
//     notMeasured: [{ name, reason }] }
// n counts valid completed runs; pass is the hidden-test successes among them;
// fail = n − pass (agent errors included); invalid runs are listed beside n and
// are in no rate; ci is the 95% Wilson interval of pass/n (null when n = 0).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';
import { CONDITIONS } from './conditions.mjs';
import { summarize } from './report.mjs';
import { lastRowPerRun, parseResults } from './lib/results.mjs';

const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

export function buildSummary(files) {
  const agents = new Set();
  const experiments = [];
  const versions = new Map();
  const cells = [];
  for (const file of files) {
    const rows = lastRowPerRun(parseResults(fs.readFileSync(file, 'utf8'), file).rows);
    if (!rows.length) continue;
    for (const r of rows) {
      agents.add(r.agent);
      if (r.klypixServer?.version && !versions.has(r.condition)) versions.set(r.condition, `klypix-mcp ${r.klypixServer.version}${r.klypixServer.commit ? ` @ ${r.klypixServer.commit}` : ''}`);
      if (r.channelServer?.version && !versions.has(r.condition)) versions.set(r.condition, `${r.channelServer.name} ${r.channelServer.version}`);
    }
    const ids = [...new Set(rows.map((r) => r.experimentId || 'legacy'))];
    experiments.push({ file: file.replace(/\\/g, '/').split('/').pop(), experimentId: ids[0], agents: [...new Set(rows.map((r) => r.agent))], rows: rows.length });
    for (const c of summarize(rows)) {
      cells.push({
        scenario: c.scenario, agent: c.agent, condition: c.condition,
        n: c.n, pass: c.success.k, fail: c.n - c.success.k, invalid: c.invalidRuns,
        ci: c.success.low == null ? null : [round(c.success.low), round(c.success.high)],
        notApplicable: c.notApplicable || null,
      });
    }
  }
  const usedConditions = [...new Set(cells.map((c) => c.condition))];
  return {
    generatedAt: new Date().toISOString(),
    agents: [...agents],
    experiments,
    conditions: CONDITIONS.filter((c) => usedConditions.includes(c.id)).map((c) => ({ key: c.id, label: c.label, version: versions.get(c.id) || null })),
    scenarios: SCENARIOS.filter((s) => cells.some((c) => c.scenario === s.id)).map((s) => ({
      key: s.id, label: s.title, role: s.role || null,
      cells: cells.filter((c) => c.scenario === s.id).map(({ scenario, ...rest }) => rest),
    })),
    // What these rows did not measure: never a condition they carry, whatever this machine has installed.
    notMeasured: CONDITIONS.filter((c) => !c.runnable && !usedConditions.includes(c.id)).map((c) => ({ name: c.label, reason: c.reason })),
  };
}

const pctOf = (x) => `${Math.round(x * 100)}%`;
/**
 * Plain words, per scenario and agent: which conditions clearly won or lost
 * (95% intervals that do not overlap — the only differences ever called), and
 * a tie where every interval overlaps. Cells with n < 5 are named as such.
 */
export function plainSummary(summary) {
  const label = Object.fromEntries(summary.conditions.map((c) => [c.key, c.key]));
  const out = [];
  for (const s of summary.scenarios) {
    for (const agent of summary.agents) {
      const cells = s.cells.filter((c) => c.agent === agent && !c.notApplicable && c.n > 0 && c.ci);
      if (!cells.length) continue;
      const rate = (c) => `${label[c.condition]} ${c.pass}/${c.n}`;
      const pairs = [];
      for (const a of cells) for (const b of cells) if (a.ci[0] > b.ci[1]) pairs.push(`${label[a.condition]} > ${label[b.condition]}`);
      const small = cells.some((c) => c.n < 5) ? ' (n < 5 in some cells)' : '';
      const na = s.cells.filter((c) => c.agent === agent && c.notApplicable).map((c) => label[c.condition] || c.condition);
      const verdict = pairs.length ? `clear: ${pairs.join('; ')}` : (cells.length > 1 ? 'tie — every interval overlaps' : 'one condition measured, nothing to compare');
      out.push(`- **${s.label}**${s.role ? ` _(${s.role})_` : ''} · ${agent}: ${verdict}. ${cells.map(rate).join(', ')}${small}${na.length ? `; n/a: ${na.join(', ')}` : ''}.`);
    }
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...files] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!out || !files.length) { console.error('usage: summary.mjs <out.summary.json> <results.jsonl> [more.jsonl …]'); process.exit(2); }
  const summary = buildSummary(files);
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${out}: ${summary.scenarios.length} scenario(s), ${summary.scenarios.reduce((a, s) => a + s.cells.length, 0)} cell(s), agents ${summary.agents.join(', ')}`);
  if (process.argv.includes('--plain')) console.log(plainSummary(summary));
}
