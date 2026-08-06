# KLYPIX brain — benchmark

Run `npx klypix-mcp bench` to reproduce this table on your own machine.

- klypix-mcp **1.58.0** · Node v24.13.1 · win32 10.0.26200
- Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz · 12 cores · 31.9 GB RAM
- 2026-08-06T08:42:53.111Z · mode: full · 24s

## Does this harness detect data loss at all?

Before trusting any "nothing lost" number, the same harness runs writers that BYPASS the lock — the behaviour that existed before the lock protocol. 10 unlocked writers attempted 22 cards and **17 were lost**.

✅ Loss is detectable, so the result below means something.

## Concurrent writers

| writers | cards written | cards surviving | lost | wall clock |
|---|---|---|---|---|
| 10 | 46 | 46 | **0** | 7292 ms |

Verdict: **no-loss**. Separate OS processes call the same `brain_note` every agent uses, released simultaneously by a file barrier.

## Coordination latency

| calls | p50 | p95 | max |
|---|---|---|---|
| 300 | 10 ms | 18 ms | 26 ms |

One call is what an agent pays to declare its task, receive peers, overlap warnings, messages and task-relevant brain context.

## Soak

| queries | p50 | p95 | first-decile p50 | last-decile p50 | drift | RSS |
|---|---|---|---|---|---|---|
| 1000 | 8 ms | 15 ms | 8 ms | 9 ms | +1 ms | 145.1 → 192.1 MB |

Drift compares the last tenth of the run against the first: a brain that slows down as a session grows would show it here.

## Crash safety

4 writers were SIGKILLed mid-write. Brain still parses: **yes** · cards before 41 → after 43 · pre-existing cards intact: **yes**.

## What these numbers are not

- They measure the local brain engine, not any hosted service, and not model quality.
- Latency depends on brain size and disk; a bigger brain on slower storage will be slower.
- Scenarios this machine could not run are reported as skipped, never as passes.

