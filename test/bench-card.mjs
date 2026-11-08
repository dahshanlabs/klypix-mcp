// The bench result card is drawn from the summary file and nothing else.
//
//   C1 — every pass/n and interval printed for the fixture equals the JSON,
//        column for column; a cell with n = 0 prints "—" and never a number;
//        no line is wider than 100 columns; colour is magnitude-only.
//   C2 — the pilot summary (n = 1 per cell) carries the visible n < 5 caveat;
//        a summary whose every cell has n ≥ 5 does not.
//   C3 — a missing or malformed file renders nothing: a clear error on stderr,
//        exit 2, empty stdout. No argument picks the newest *.summary.json.
//   C4 — summarize.mjs over the pilot jsonl reproduces the committed summary
//        byte for byte (same rows → same file), and lists as "not measured"
//        only conditions with no row.
// Run:  node test/bench-card.mjs   (exit 0 = pass)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// conditions.mjs reads the user folder for the KLYPIX install; keep it away from the real one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-bench-card-home-'));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.KLYPIX_BRAIN_DIR = path.join(sandbox, 'brain-dir');
process.env.KLYPIX_AUTO_UPDATE = '0';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'bench', 'coordination', 'render-card.mjs');
const SUMMARIZE = path.join(ROOT, 'bench', 'coordination', 'summarize.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'bench-card.summary.json');
const PILOT_JSONL = path.join(ROOT, 'bench', 'coordination', 'results', '2026-11-08-concord-pilot.jsonl');
const PILOT_SUMMARY = path.join(ROOT, 'bench', 'coordination', 'results', '2026-11-08-concord-pilot.summary.json');

// The colour checks below need colour on; a NO_COLOR in the caller's shell
// (common in agent hosts) must not turn them into false failures.
delete process.env.NO_COLOR;
const { buildCard, renderCard, newestSummary } = await import('../bench/coordination/render-card.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BENCH_CARD_DELAY_MS: '0', ...env } });
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}`);

// ---- C1: fixture numbers, column for column -------------------------------
{
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = run([RENDER, FIXTURE, '--no-delay']);
  ok(res.status === 0, 'C1: the fixture renders (exit 0)');
  const lines = strip(res.stdout).split('\n');
  ok(lines.every((l) => l.length <= 100), `C1: no line wider than 100 columns (widest ${Math.max(...lines.map((l) => l.length))})`);
  ok(lines[0] === 'KLYPIX coordination bench · real agents, hidden tests · 2026-01-01', 'C1: title carries the file\'s date');
  ok(lines.some((l) => /^FIXTURE — fictional numbers/.test(l)), 'C1: a fixture announces itself on the card');

  // The header row names every condition in file order; the next row its version.
  const head = lines.find((l) => l.startsWith(' ') && l.includes('KLYPIX'));
  const labelW0 = Math.min(46, Math.max(24, 100 - fixture.conditions.length * 13 - 1));
  const heads = (head.slice(labelW0).match(/.{1,13}/g) || []).map((t) => t.trim());
  const clip = (t, w) => (t.length <= w ? t : `${t.slice(0, w - 1)}…`);
  ok(JSON.stringify(heads) === JSON.stringify(fixture.conditions.map((c) => clip(c.label, 12))), `C1: column heads are the file's labels in order, clipped to the column (${heads.join(' | ')})`);

  // Every scenario: line 1 = pass/n per column, line 2 = lo–hi% per column.
  const plain = buildCard(fixture, { width: 100 }).map(([p]) => p);
  // The scenario column is what is left of 100 columns after 13 per condition (capped at 46).
  const labelW = Math.min(46, Math.max(24, 100 - fixture.conditions.length * 13 - 1));
  for (const s of fixture.scenarios) {
    const i = plain.findIndex((l) => l.startsWith(s.label.slice(0, 20)));
    ok(i > -1, `C1: scenario "${s.label}" is on the card`);
    if (i < 0) continue;
    const l1 = plain[i].slice(labelW).match(/\S+\/\S+|—/g) || [];
    const wantPn = s.cells.map((c) => (c.n ? `${c.pass}/${c.n}` : '—'));
    ok(JSON.stringify(l1.map((t) => t.replace(/ .*$/, ''))) === JSON.stringify(wantPn), `C1: ${s.key} pass/n ${l1.join(' ')} == ${wantPn.join(' ')}`);
    const l2 = plain[i + 1].slice(labelW).trim().split(/\s+/);
    const wantCi = s.cells.map((c) => (c.n ? `${pct(c.ci[0])}–${pct(c.ci[1])}%${c.invalid ? ` +${c.invalid}inv` : ''}` : (c.invalid ? `${c.invalid} invalid` : 'not run')));
    const gotCi = l2.join(' ');
    ok(gotCi === wantCi.join(' '), `C1: ${s.key} intervals "${gotCi}" == "${wantCi.join(' ')}"`);
    if (s.role) ok(plain[i].includes(`(${s.role})`), `C1: ${s.key} shows its role "(${s.role})"`);
  }
  // No digit on the card that the JSON does not contain: every number printed
  // in a cell is pass, n, lo or hi of some cell, or the runs count.
  const allowed = new Set([String(fixture.runs)]);
  for (const s of fixture.scenarios) for (const c of s.cells) { allowed.add(String(c.pass)); allowed.add(String(c.n)); allowed.add(pct(c.ci[0])); allowed.add(pct(c.ci[1])); allowed.add(String(c.invalid)); }
  const cellLines = plain.filter((l) => fixture.scenarios.some((s) => l.startsWith(s.label)) || /^\s{20,}\d/.test(l));
  const stray = cellLines.flatMap((l) => l.slice(labelW).match(/\d+/g) || []).filter((d) => !allowed.has(d));
  ok(stray.length === 0, `C1: every number in the grid comes from the JSON (stray: ${stray.join(',') || 'none'})`);

  // Colour is by magnitude, not by vendor: a 100% cell is green under every
  // column, a 0% cell red, whichever condition owns it.
  const painted = buildCard(fixture, { width: 100 }).map(([, p]) => p);
  const s4 = painted.find((l) => strip(l).startsWith('Another vendor'));
  const greens = (s4.match(/\x1b\[32m/g) || []).length;
  ok(greens === 4, `C1: four 100% cells on the control row are green regardless of column (${greens})`);
  const s1 = painted.find((l) => strip(l).startsWith('A decision changed'));
  ok(/\x1b\[31m0\/5/.test(s1) && /\x1b\[32m5\/5/.test(s1) && /\x1b\[33m3\/5/.test(s1), 'C1: 0/5 red, 5/5 green, 3/5 yellow on one row');
  ok(/\x1b\[2m—/.test(s1), 'C1: the n = 0 cell is dim "—"');
  ok(plain.some((l) => l.startsWith('Not measured · Clash — ')) && plain.some((l) => l.startsWith('Not measured · Agent-MCP — ')), 'C1: the not-measured footer names each entry with its reason');
  ok(plain.at(-1) === 'every row, including the ones we lose · bench/coordination/results/', 'C1: the last line points at the results folder');
  ok(plain.some((l) => /n < 5/.test(l)), 'C1: the fixture has an n = 1 cell, so the caveat shows');
}

// ---- C2: the n < 5 caveat --------------------------------------------------
{
  const pilot = JSON.parse(fs.readFileSync(PILOT_SUMMARY, 'utf8'));
  const plain = buildCard(pilot).map(([p]) => p);
  const caveat = plain.find((l) => /^⚠ \d+ cells? with n < 5/.test(l));
  ok(!!caveat && caveat.startsWith('⚠ 10 cells with n < 5'), `C2: the pilot card carries the caveat for its 10 single-run cells ("${caveat}")`);
  ok(!plain.some((l) => /Not measured · Concord/.test(l)), 'C2: Concord, measured in the pilot, is not listed as not measured');
  ok(plain.some((l) => /Not measured · MCP Agent Mail/.test(l)), 'C2: Agent Mail, with no row, is listed as not measured with the kit\'s reason');
  // Every cell n >= 5: no caveat.
  const big = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const s of big.scenarios) for (const c of s.cells) if (c.n && c.n < 5) { c.n = 5; c.pass = Math.min(c.pass, 5); c.fail = 5 - c.pass; }
  ok(!buildCard(big).some(([p]) => /n < 5/.test(p)), 'C2: no caveat once every measured cell has n >= 5');
  // Delays are off under the flag: the whole pilot card renders in well under a second.
  const t0 = Date.now();
  const out = [];
  await renderCard(pilot, { out: (s) => out.push(s), delay: 0 });
  ok(Date.now() - t0 < 1000 && out.length === plain.length, 'C2: --no-delay / delay 0 renders every line at once');
}

// ---- C3: missing file → nothing rendered ------------------------------------
{
  const res = run([RENDER, path.join(sandbox, 'does-not-exist.summary.json')]);
  ok(res.status === 2 && res.stdout === '' && /summary file not found/.test(res.stderr), `C3: missing file → exit 2, empty stdout, clear stderr ("${res.stderr.trim()}")`);
  const bad = path.join(sandbox, 'bad.summary.json');
  fs.writeFileSync(bad, '{"generatedAt":"x"}');
  const res2 = run([RENDER, bad]);
  ok(res2.status === 2 && res2.stdout === '' && /missing "conditions"/.test(res2.stderr), 'C3: malformed file → exit 2, empty stdout, names the missing key');
  ok(newestSummary() === PILOT_SUMMARY, `C3: with no argument the newest *.summary.json in results/ is picked (${path.basename(newestSummary() || '')})`);
  const res3 = run([RENDER, '--no-delay']);
  ok(res3.status === 0 && strip(res3.stdout).startsWith('KLYPIX coordination bench · real agents, hidden tests · 2026-11-08'), 'C3: no argument renders that newest file');
  ok(newestSummary(path.join(sandbox, 'empty')) === null, 'C3: an empty results folder yields null, not a throw');
}

// ---- C4: summarize.mjs reproduces the committed pilot summary ---------------
{
  const out = path.join(sandbox, 'regen.summary.json');
  const res = run([SUMMARIZE, PILOT_JSONL, out]);
  ok(res.status === 0, `C4: summarize.mjs runs over the pilot jsonl (${res.stderr.trim()})`);
  const regen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const committed = JSON.parse(fs.readFileSync(PILOT_SUMMARY, 'utf8'));
  // `source` is relative to the output folder and `notMeasured` reasons can
  // name this machine; everything the card prints as a number is compared exactly.
  const numbers = (s) => JSON.stringify({ generatedAt: s.generatedAt, agents: s.agents, conditions: s.conditions, scenarios: s.scenarios, runs: s.runs, experimentId: s.experimentId });
  ok(numbers(regen) === numbers(committed), 'C4: same rows → same scenarios, cells, intervals, conditions and agents as the committed summary');
  ok(regen.scenarios.every((s) => s.cells.every((c) => c.n === 1)) && regen.runs === 10, 'C4: the pilot is 10 cells of n = 1');
  const s9 = regen.scenarios.find((s) => s.key === 's9-continue-stopped-session');
  ok(s9 && s9.cells.find((c) => c.condition === 'klypix').pass === 1 && s9.cells.find((c) => c.condition === 'concord').pass === 0, 'C4: S9 reads KLYPIX 1/1, Concord 0/1 straight from the rows');
  ok(regen.notMeasured.every((x) => !regen.conditions.some((c) => x.name.startsWith(c.label))) && !regen.notMeasured.some((x) => /^Concord/.test(x.name)), 'C4: a measured condition is never listed as not measured');
  const { wilson } = await import('../bench/coordination/lib/stats.mjs');
  const w = wilson(1, 1);
  ok(s9.cells[0].ci[0] === Math.round(w.low * 10000) / 10000 && s9.cells[0].ci[1] === Math.round(w.high * 10000) / 10000, 'C4: intervals are lib/stats.mjs Wilson intervals');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nbench-card: all green');
process.exit(failures ? 1 : 0);
