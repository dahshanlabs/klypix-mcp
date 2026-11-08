#!/usr/bin/env node
// Print the coordination-bench result card in a terminal, row by row.
//   node bench/coordination/render-card.mjs [<summary.json>] [--no-delay] [--width 100]
//
// No argument: the newest *.summary.json in bench/coordination/results/ (by
// file name, which starts with the date). The card is drawn ONLY from that
// file — produced by summarize.mjs from a results.jsonl — so no number here is
// typed by hand, and docs/demo/bench.tape re-renders it when the results change.
//
// Layout: one row per scenario, one column per condition. A cell is pass/n, a
// small bar, and the 95% Wilson interval underneath. Colour follows the pass
// rate only (green ≥ 80%, yellow ≥ 50%, red below) — never the vendor. Any
// cell with n < 5 puts a visible caveat line on the card. Fits 100 columns.
//
// Delays are the point of the GIF: the card builds up. BENCH_CARD_DELAY_MS=0
// or --no-delay prints it at once (the test does).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(here, 'results');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : fallback; };
const WIDTH = Math.max(80, Number(opt('width', '100')) || 100);
const DELAY = flag('no-delay') ? 0 : Math.max(0, Number(process.env.BENCH_CARD_DELAY_MS ?? '420') || 0);
const COLOR = !('NO_COLOR' in process.env) && !flag('no-color');

const RESET = '\x1b[0m';
const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}${RESET}` : s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Newest summary by file name (dates lead the name), so CI and a laptop agree. */
export function newestSummary(dir = RESULTS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.summary.json')).sort(); } catch { names = []; }
  return names.length ? path.join(dir, names.at(-1)) : null;
}

export function loadSummary(file) {
  if (!file) throw new Error(`no *.summary.json found in ${RESULTS_DIR} — run: node bench/coordination/summarize.mjs <results.jsonl> <out.summary.json>`);
  if (!fs.existsSync(file)) throw new Error(`summary file not found: ${file}`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['conditions', 'scenarios']) if (!Array.isArray(s[k])) throw new Error(`${file}: missing "${k}" array`);
  return s;
}

// Display width: every character here is one cell wide except the few two-cell
// glyphs we never use; `…`, `–`, `·`, `▇` and `░` are one cell in a monospace
// terminal, so String.length is the width.
const padEnd = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const clip = (s, w) => (s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}`);

export function wrap(line, width, indent = '  ') {
  if (line.length <= width) return [line];
  const out = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width - 30) cut = width;
    out.push(rest.slice(0, cut));
    rest = indent + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

function toneFor(p) {
  if (p == null) return '2';
  if (p >= 0.8) return '32';
  if (p >= 0.5) return '33';
  return '31';
}

function bar(p, width) {
  if (p == null || width <= 0) return '';
  const filled = Math.round(p * width);
  return '▇'.repeat(filled) + '░'.repeat(width - filled);
}

/** Build the card as [plainLine, paintedLine] pairs; the test reads the plain side. */
// The card is a picture: one short clause per not-measured entry. The full
// reason lives in the results file and the bench README.
export function shortReason(reason) {
  const first = String(reason || '').split(/[;(]| — /)[0].trim().replace(/[.,:]$/, '');
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

export function buildCard(summary, { width = WIDTH } = {}) {
  const lines = [];
  const push = (plain, painted = plain) => lines.push([plain, painted]);
  const conds = summary.conditions;
  const colW = 13;
  const labelW = Math.min(46, Math.max(24, width - conds.length * colW - 1));

  const date = String(summary.generatedAt || '').slice(0, 10) || 'undated';
  const title = `KLYPIX coordination bench · real agents, hidden tests · ${date}`;
  push(title, bold(paint('36', title)));
  if (summary.fixture) push('FIXTURE — fictional numbers for the renderer test, not a measurement', paint('1;33', 'FIXTURE — fictional numbers for the renderer test, not a measurement'));
  const who = (summary.agents || []).map((a) => [a.label || a.key, ...(a.versions || []), ...(a.models || [])].join(' · ')).join(' + ');
  const sub = [summary.runs != null ? `${summary.runs} graded runs` : null, who].filter(Boolean).join(' · ');
  if (sub) for (const w of wrap(sub, width)) push(w, dim(w));
  push('');

  // Column heads: label, then the version that was measured.
  let head = padEnd('', labelW); let headP = head;
  let vers = padEnd('', labelW); let versP = vers;
  for (const c of conds) {
    const l = padEnd(clip(c.label, colW - 1), colW);
    head += l; headP += bold(l);
    const v = padEnd(clip(c.version || '—', colW - 1), colW);
    vers += v; versP += dim(v);
  }
  push(head.trimEnd(), headP);
  push(vers.trimEnd(), versP);

  let small = 0;
  for (const s of summary.scenarios) {
    const roleTag = s.role ? ` (${s.role})` : '';
    // The role survives a clipped title: "(control)" is part of the reading.
    const label = `${clip(s.label, labelW - 1 - roleTag.length)}${roleTag}`;
    let l1 = padEnd(label, labelW); let l1p = l1;
    let l2 = padEnd('', labelW); let l2p = l2;
    for (const c of conds) {
      const cell = (s.cells || []).find((x) => x.condition === c.key);
      if (!cell || !cell.n) {
        const t = padEnd('—', colW);
        l1 += t; l1p += dim(t);
        const u = padEnd(cell && cell.invalid ? `${cell.invalid} invalid` : 'not run', colW);
        l2 += u; l2p += dim(u);
        continue;
      }
      if (cell.n < 5) small++;
      const p = cell.pass / cell.n;
      const pn = `${cell.pass}/${cell.n}`;
      const b = bar(p, Math.max(0, colW - 2 - pn.length));
      const t = padEnd(`${pn} ${b}`.trimEnd(), colW);
      l1 += t; l1p += paint(toneFor(p), t);
      const [lo, hi] = cell.ci || [];
      const u = padEnd(`${pct(lo)}–${pct(hi)}%${cell.invalid ? ` +${cell.invalid}inv` : ''}`, colW);
      l2 += u; l2p += dim(u);
    }
    push(l1.trimEnd(), l1p);
    push(l2.trimEnd(), l2p);
  }
  push('');
  if (small) {
    const c = `⚠ ${small} cell${small === 1 ? '' : 's'} with n < 5: a pilot, not a ranking`;
    for (const w of wrap(c, width)) push(w, paint('33', w));
  }
  const nm = summary.notMeasured || [];
  if (nm.length) {
    for (const x of nm) { const t = `Not measured · ${x.name} — ${shortReason(x.reason)}`; for (const w of wrap(t, width)) push(w, dim(w)); }
  }
  const last = 'every row, including the ones we lose · bench/coordination/results/';
  push(last, dim(last));
  return lines;
}

export async function renderCard(summary, { out = (s) => process.stdout.write(`${s}\n`), delay = DELAY, width = WIDTH } = {}) {
  const lines = buildCard(summary, { width });
  for (const [plain, painted] of lines) {
    out(painted);
    if (plain) await sleep(delay);
  }
  return lines.map(([plain]) => plain);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--width') || newestSummary();
  let summary;
  try { summary = loadSummary(file); } catch (e) { console.error(`render-card: ${e.message}`); process.exit(2); }
  await renderCard(summary);
}
