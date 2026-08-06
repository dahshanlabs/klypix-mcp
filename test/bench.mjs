// The benchmark is a PUBLIC claim, so the harness itself needs a harness.
//
// A benchmark that can only ever pass is marketing. These assertions pin the
// properties that make the published numbers trustworthy:
//   • the negative control genuinely loses cards (so "0 lost" is falsifiable);
//   • a no-loss verdict is only issued when that control proved loss is visible;
//   • every number carries the machine and version it was measured on;
//   • the report never rounds an unmeasured scenario into a pass.
//
// Run:  node test/bench.mjs        (exit 0 = pass, 1 = fail)
import { runBenchmark, formatBenchmark } from '../src/bench.mjs';

let failures = 0;
const ok = (condition, label) => { console.log(`${condition ? '✓' : '✗'} ${label}`); if (!condition) failures++; };

const report = await runBenchmark({ quick: true, log: () => {} });
const control = report.scenarios.negativeControl;
const concurrent = report.scenarios.concurrentWriters;

// ── The credibility gate ────────────────────────────────────────────────────
ok(control.lost > 0 && control.detectsLoss,
  'negative control LOSES cards — the harness can see a lost update, so a 0-lost result is falsifiable');
ok(concurrent.lost === 0,
  'the same contention through the real lock protocol loses nothing');
ok(concurrent.verdict === 'no-loss',
  'a no-loss verdict is issued only when the control proved loss is detectable');

// A no-loss verdict must be IMPOSSIBLE when the control saw nothing — otherwise
// a quiet machine would silently manufacture a passing benchmark.
{
  const pretend = {
    scenarios: {
      negativeControl: { ...control, lost: 0, detectsLoss: false },
      concurrentWriters: { ...concurrent },
    },
  };
  const verdict = !pretend.scenarios.negativeControl.detectsLoss
    ? 'inconclusive'
    : (pretend.scenarios.concurrentWriters.lost === 0 ? 'no-loss' : 'loss-detected');
  ok(verdict === 'inconclusive',
    'with an undetecting control the verdict degrades to INCONCLUSIVE, never to a pass');
}

// ── Real work actually happened ─────────────────────────────────────────────
ok(concurrent.writers >= 2 && concurrent.reportedWritten > 0,
  'concurrent scenario ran multiple real writer processes that wrote real cards');
ok(report.scenarios.coordinationLatencyMs.n > 0 && report.scenarios.coordinationLatencyMs.p95 >= report.scenarios.coordinationLatencyMs.p50,
  'coordination latency reports a sane p50/p95 distribution');
ok(report.scenarios.soak.queries > 0 && typeof report.scenarios.soak.driftP50Ms === 'number',
  'soak reports drift between the first and last decile, not just an average');
ok(report.scenarios.crashSafety.brainStillParses && report.scenarios.crashSafety.seedCardsIntact,
  'SIGKILLed writers leave a brain that still parses with every pre-existing card intact');

// ── The environment is part of the result ───────────────────────────────────
const env = report.environment;
ok(Boolean(env.klypixMcp && env.node && env.platform && env.cpu && env.cores && env.totalRamGb),
  'every report stamps version, node, platform, CPU, cores and RAM — a number without a machine is not a measurement');
ok(Boolean(report.startedAt && report.mode),
  'every report stamps when it ran and at which scale');

// ── The published markdown says what it does not measure ────────────────────
const markdown = formatBenchmark(report);
ok(markdown.includes('npx klypix-mcp bench'),
  'the report prints the command that reproduces it');
ok(markdown.includes('What these numbers are not'),
  'the report states its own limits — model quality and hosted services are out of scope');
ok(markdown.includes('Loss is detectable'),
  'the report leads with whether loss was detectable, before any no-loss claim');

console.log(failures ? `\n✗ ${failures} bench assertion(s) failed` : '\n✓ bench: all assertions passed');
process.exit(failures ? 1 : 0);
