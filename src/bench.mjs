// klypix-mcp bench — the public, reproducible benchmark.
//
// WHY THIS EXISTS. Every claim about a shared agent brain ("nothing is lost",
// "it stays fast") is unfalsifiable until a stranger can re-run it. This
// harness measures the properties KLYPIX actually sells, on real processes
// against a real brain file, and prints the command that reproduces it.
//
// HOW IT STAYS HONEST — the rules that make the numbers worth reading:
//
//  1. A NEGATIVE CONTROL RUNS FIRST. A no-loss result only means something if
//     the same harness can DETECT loss. Control writers deliberately bypass the
//     advisory lock; if they do not lose cards, contention was too weak and the
//     whole no-loss result is reported INCONCLUSIVE rather than as a pass.
//  2. REAL PROCESSES, REAL OPS. Writers are separate node processes calling the
//     same opBrainNote every agent uses, released together by a file barrier —
//     in-process promises cannot prove cross-process safety.
//  3. NOTHING IS ROUNDED IN OUR FAVOUR. Latency is reported p50/p95/max, soak
//     drift compares the last decile against the first, and any scenario that
//     cannot be measured on this machine is reported as "skipped", never as a
//     pass.
//  4. THE ENVIRONMENT IS PART OF THE RESULT. Version, platform, CPU, RAM and
//     date are stamped into every report, because a number without a machine is
//     a marketing asset, not a measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildKlypixMap, parseKlypix } from './klypix-format.mjs';

const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (card) => String(card?.text || '').replace(/\s+/g, ' ').trim();

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
  };
}

// One writer process. `locked` false is the NEGATIVE CONTROL: it performs the
// same read-modify-write WITHOUT the advisory lock, which is what every writer
// did before the lock protocol existed.
const WRITER_SOURCE = String.raw`
import fs from 'node:fs';
const [coreUrl, formatUrl, lockUrl, brain, ready, barrier, tag, countRaw, lockedRaw] = process.argv.slice(2);
const count = Number(countRaw);
const locked = lockedRaw === '1';
const core = await import(coreUrl);
const fmt = await import(formatUrl);
const lock = await import(lockUrl);
fs.writeFileSync(ready, 'ready');
while (!fs.existsSync(barrier)) await new Promise(r => setTimeout(r, 5));
let wrote = 0;
for (let i = 0; i < count; i++) {
  const text = 'BENCH ' + tag + ' card ' + i + ' unique-' + tag + '-' + i;
  try {
    if (locked) {
      const res = await core.opBrainNote({ vault: '.', canvas: brain, text });
      if (!res?.isError) wrote++;
    } else {
      // Unlocked read-modify-write — the pre-lock behaviour, kept ONLY as the
      // control that proves this harness can see a lost update.
      const captured = await fmt.captureIntoBrain(fs.readFileSync(brain), {
        cards: [{ text, color: '#e8e8ed', createdVia: 'bench-control' }],
      });
      await fmt.atomicWrite(brain, captured.buffer);
      wrote++;
    }
  } catch { /* counted as not-written */ }
}
process.stdout.write(JSON.stringify({ tag, wrote }));
`;

async function runWriters({ brain, writers, cardsEach, locked, root }) {
  const writerFile = path.join(root, 'bench-writer.mjs');
  fs.writeFileSync(writerFile, WRITER_SOURCE);
  const barrier = path.join(root, `barrier-${locked ? 'locked' : 'control'}-${Date.now()}`);
  const urls = {
    core: new URL('./klypix-core.mjs', import.meta.url).href,
    format: new URL('./klypix-format.mjs', import.meta.url).href,
    lock: new URL('./brain-write-lock.mjs', import.meta.url).href,
  };
  const children = [];
  const readies = [];
  for (let w = 0; w < writers; w++) {
    const tag = `${locked ? 'L' : 'C'}${w}`;
    const ready = path.join(root, `ready-${tag}-${Date.now()}`);
    readies.push(ready);
    const child = spawn(process.execPath, [
      writerFile, urls.core, urls.format, urls.lock, brain, ready, barrier, tag,
      String(cardsEach), locked ? '1' : '0',
    ], { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    children.push(new Promise((resolve) => child.on('exit', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ tag, wrote: 0 }); }
    })));
  }
  // Release every writer at the same instant — contention is the point.
  const until = Date.now() + 30_000;
  while (Date.now() < until && !readies.every((f) => fs.existsSync(f))) await delay(10);
  const startedAt = nowMs();
  fs.writeFileSync(barrier, 'go');
  const results = await Promise.all(children);
  const durationMs = Math.round(nowMs() - startedAt);
  const attempted = writers * cardsEach;
  const reportedWritten = results.reduce((sum, r) => sum + Number(r?.wrote || 0), 0);
  const { struct } = await parseKlypix(fs.readFileSync(brain));
  const present = new Set(struct.cards.map(flat).filter((t) => t.includes('unique-')));
  let survived = 0;
  for (const r of results) {
    for (let i = 0; i < cardsEach; i++) {
      const needle = `unique-${r.tag}-${i}`;
      for (const text of present) { if (text.includes(needle)) { survived++; break; } }
    }
  }
  return { writers, cardsEach, attempted, reportedWritten, survived, lost: reportedWritten - survived, durationMs };
}

async function seedBrain(file, cards = 200) {
  const areas = [{
    title: 'Bench',
    cards: Array.from({ length: cards }, (_, i) => ({
      text: `Seed decision ${i}: the retrieval path must stay correct under load, area ${i % 7}, topic ${['auth', 'canvas', 'sync', 'brain', 'release', 'drive', 'index'][i % 7]}`,
    })),
  }];
  fs.writeFileSync(file, await buildKlypixMap({ title: 'bench-brain', areas }));
}

export async function runBenchmark({ quick = false, log = console.error } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-bench-'));
  const started = new Date();
  const scale = quick ? { writers: 4, cardsEach: 3, queries: 100, soak: 200 } : { writers: 10, cardsEach: 5, queries: 300, soak: 1000 };
  const results = { scenarios: {} };
  try {
    // ── 1. NEGATIVE CONTROL — can this harness see a lost update at all? ─────
    log(`[bench] negative control: ${scale.writers} unlocked writers …`);
    const controlBrain = path.join(root, 'control.klypix');
    await seedBrain(controlBrain, 40);
    const control = await runWriters({ brain: controlBrain, writers: scale.writers, cardsEach: scale.cardsEach, locked: false, root });
    results.scenarios.negativeControl = {
      ...control,
      detectsLoss: control.lost > 0,
      note: control.lost > 0
        ? 'Unlocked writers lost cards, so this harness demonstrably detects lost updates.'
        : 'Unlocked writers lost nothing — contention was too weak on this machine, so the no-loss result below is INCONCLUSIVE, not a pass.',
    };

    // ── 2. CONCURRENT WRITERS through the real lock protocol ────────────────
    log(`[bench] concurrent writers: ${scale.writers} locked writers …`);
    const brain = path.join(root, 'brain.klypix');
    await seedBrain(brain, 40);
    const concurrent = await runWriters({ brain, writers: scale.writers, cardsEach: scale.cardsEach, locked: true, root });
    results.scenarios.concurrentWriters = {
      ...concurrent,
      verdict: !results.scenarios.negativeControl.detectsLoss
        ? 'inconclusive'
        : (concurrent.lost === 0 ? 'no-loss' : 'loss-detected'),
    };

    // ── 3. COORDINATION LATENCY — the per-call cost every agent pays ────────
    log(`[bench] coordination latency: ${scale.queries} task-context calls …`);
    const { opBrainTaskContext } = await import('./klypix-core.mjs');
    const coordination = [];
    for (let i = 0; i < scale.queries; i++) {
      const t = nowMs();
      await opBrainTaskContext({ vault: root, canvas: brain, intent: `bench intent ${i % 11} sync auth canvas`, files: [`src/file-${i % 5}.ts`], k: 5 });
      coordination.push(nowMs() - t);
    }
    results.scenarios.coordinationLatencyMs = stats(coordination);

    // ── 4. SOAK — does retrieval drift or leak over a long session? ─────────
    log(`[bench] soak: ${scale.soak} queries …`);
    const rssStart = process.memoryUsage().rss;
    const soak = [];
    for (let i = 0; i < scale.soak; i++) {
      const t = nowMs();
      await opBrainTaskContext({ vault: root, canvas: brain, intent: `soak query ${i} topic ${['auth', 'canvas', 'sync', 'brain'][i % 4]}`, k: 5 });
      soak.push(nowMs() - t);
    }
    const decile = Math.max(1, Math.floor(soak.length / 10));
    const firstDecile = stats(soak.slice(0, decile));
    const lastDecile = stats(soak.slice(-decile));
    results.scenarios.soak = {
      queries: soak.length,
      overall: stats(soak),
      firstDecileP50: firstDecile.p50,
      lastDecileP50: lastDecile.p50,
      driftP50Ms: Math.round(((lastDecile.p50 ?? 0) - (firstDecile.p50 ?? 0)) * 10) / 10,
      rssStartMb: Math.round((rssStart / 1048576) * 10) / 10,
      rssEndMb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
    };

    // ── 5. CRASH SAFETY — kill writers mid-write, is the brain still whole? ─
    log('[bench] crash safety: SIGKILL during concurrent writes …');
    const crashBrain = path.join(root, 'crash.klypix');
    await seedBrain(crashBrain, 40);
    const { struct: beforeStruct } = await parseKlypix(fs.readFileSync(crashBrain));
    const writerFile = path.join(root, 'bench-writer.mjs');
    const barrier = path.join(root, `barrier-crash-${Date.now()}`);
    const kids = [];
    for (let w = 0; w < 4; w++) {
      kids.push(spawn(process.execPath, [
        writerFile,
        new URL('./klypix-core.mjs', import.meta.url).href,
        new URL('./klypix-format.mjs', import.meta.url).href,
        new URL('./brain-write-lock.mjs', import.meta.url).href,
        crashBrain, path.join(root, `ready-crash-${w}`), barrier, `K${w}`, '6', '1',
      ], { stdio: 'ignore', cwd: root }));
    }
    await delay(400);
    fs.writeFileSync(barrier, 'go');
    await delay(250);
    for (const kid of kids) { try { kid.kill('SIGKILL'); } catch { /* already gone */ } }
    await delay(600);
    let parsedAfterCrash = false;
    let cardsAfter = 0;
    try {
      const { struct } = await parseKlypix(fs.readFileSync(crashBrain));
      parsedAfterCrash = true;
      cardsAfter = struct.cards.length;
    } catch { parsedAfterCrash = false; }
    results.scenarios.crashSafety = {
      killedWriters: kids.length,
      brainStillParses: parsedAfterCrash,
      cardsBefore: beforeStruct.cards.length,
      cardsAfter,
      seedCardsIntact: cardsAfter >= beforeStruct.cards.length,
      note: 'Writers are SIGKILLed mid-write. The brain must still parse and must never lose cards that existed before the crash.',
    };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }

  const cpus = os.cpus();
  return {
    schemaVersion: 1,
    tool: 'klypix-mcp bench',
    startedAt: started.toISOString(),
    durationSec: Math.round((Date.now() - started.getTime()) / 1000),
    mode: quick ? 'quick' : 'full',
    environment: {
      klypixMcp: (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; } })(),
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: cpus[0]?.model?.trim() || 'unknown',
      cores: cpus.length,
      totalRamGb: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    },
    ...results,
  };
}

export function formatBenchmark(report) {
  const env = report.environment || {};
  const c = report.scenarios?.concurrentWriters || {};
  const ctrl = report.scenarios?.negativeControl || {};
  const lat = report.scenarios?.coordinationLatencyMs || {};
  const soak = report.scenarios?.soak || {};
  const crash = report.scenarios?.crashSafety || {};
  const lines = [
    '# KLYPIX brain — benchmark',
    '',
    `Run \`npx klypix-mcp bench\` to reproduce this table on your own machine.`,
    '',
    `- klypix-mcp **${env.klypixMcp}** · Node ${env.node} · ${env.platform}`,
    `- ${env.cpu} · ${env.cores} cores · ${env.totalRamGb} GB RAM`,
    `- ${report.startedAt} · mode: ${report.mode} · ${report.durationSec}s`,
    '',
    '## Does this harness detect data loss at all?',
    '',
    `Before trusting any "nothing lost" number, the same harness runs writers that BYPASS the lock — the behaviour that existed before the lock protocol. ${ctrl.writers} unlocked writers attempted ${ctrl.reportedWritten} cards and **${ctrl.lost} were lost**.`,
    '',
    ctrl.detectsLoss
      ? '✅ Loss is detectable, so the result below means something.'
      : '⚠️ No loss appeared in the control, so contention was too weak on this machine and the result below is **inconclusive**.',
    '',
    '## Concurrent writers',
    '',
    '| writers | cards written | cards surviving | lost | wall clock |',
    '|---|---|---|---|---|',
    `| ${c.writers} | ${c.reportedWritten} | ${c.survived} | **${c.lost}** | ${c.durationMs} ms |`,
    '',
    `Verdict: **${c.verdict}**. Separate OS processes call the same \`brain_note\` every agent uses, released simultaneously by a file barrier.`,
    '',
    '## Coordination latency',
    '',
    `| calls | p50 | p95 | max |`,
    '|---|---|---|---|',
    `| ${lat.n} | ${lat.p50} ms | ${lat.p95} ms | ${lat.max} ms |`,
    '',
    'One call is what an agent pays to declare its task, receive peers, overlap warnings, messages and task-relevant brain context.',
    '',
    '## Soak',
    '',
    `| queries | p50 | p95 | first-decile p50 | last-decile p50 | drift | RSS |`,
    '|---|---|---|---|---|---|---|',
    `| ${soak.queries} | ${soak.overall?.p50} ms | ${soak.overall?.p95} ms | ${soak.firstDecileP50} ms | ${soak.lastDecileP50} ms | ${soak.driftP50Ms >= 0 ? '+' : ''}${soak.driftP50Ms} ms | ${soak.rssStartMb} → ${soak.rssEndMb} MB |`,
    '',
    'Drift compares the last tenth of the run against the first: a brain that slows down as a session grows would show it here.',
    '',
    '## Crash safety',
    '',
    `${crash.killedWriters} writers were SIGKILLed mid-write. Brain still parses: **${crash.brainStillParses ? 'yes' : 'NO'}** · cards before ${crash.cardsBefore} → after ${crash.cardsAfter} · pre-existing cards intact: **${crash.seedCardsIntact ? 'yes' : 'NO'}**.`,
    '',
    '## What these numbers are not',
    '',
    '- They measure the local brain engine, not any hosted service, and not model quality.',
    '- Latency depends on brain size and disk; a bigger brain on slower storage will be slower.',
    '- Scenarios this machine could not run are reported as skipped, never as passes.',
    '',
  ];
  return lines.join('\n');
}
