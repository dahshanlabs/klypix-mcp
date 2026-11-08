# Setup result: paid comparison not started

The preregistered comparison has **no performance result**. Its required native
semantic-search setup for claude-mem did not pass on this Windows machine. No
paid model call was made, and no part of the $50 model budget was spent. None of
the five conditions has a measured win or loss.

The [pass marks](2026-11-08-preregister.md) were published before execution in
commit `6c408cb00dcbb436bb064307b65db0adbc3950f3`, with pre-execution clarifications
and the [detailed protocol](../decision-change-benchmark.md) in
`640c3062cb4b41dae0eda11510911c74f29ce2af`. The
[fixed seeded plan](2026-11-08-plan.json) preserves all 25 early-change trials and
five personal-memory replays as **not started**. Missing trials are not failures
or silently removed rows.

## Observed setup outcome

The pinned competitor is claude-mem 15.12.0, using its README-supported local
Anthropic-plan path. Native capture, recall, search handlers, Haiku/Sonnet tier
choices and local Chroma/MiniLM defaults were retained. The setup was instrumented
and isolated; the unmodified interactive installer was not run. See the
[setup audit](../claude-mem-setup-audit-2026-11-08.md) for configuration and deviations.

| Setup check | Observed outcome |
|---|---|
| First native budget-wrapper compilation | Exceeded its 60-second setup deadline; no model call |
| Bounded compilation retry and native worker | Compiled; worker health/readiness and loopback MCP check passed; temporary credentials removed |
| First native semantic search | Dependency startup exceeded the native 120-second prewarm limit; worker explicitly fell back to keyword search |
| Isolated dependency preparation | A remapped Windows Store Python path failed; managed Python 3.13.14 and the exact 109 pinned dependencies then installed, and Chroma CLI help exited successfully |
| Final native worker search | HTTP 200 carried an explicit semantic-offline/keyword-fallback notice; doctor reported degraded dependencies; not a successful semantic query |
| Bounded direct Chroma MCP diagnostic | Initialization timed out; no successful embedding add/query was obtained |

Worker health, a successful dependency install and an HTTP 200 are insufficient
evidence that semantic retrieval works. The direct diagnostic did not establish
whether the remaining problem is specific to worker launch, dependency startup
or this isolated Windows environment. This is **setup unavailable in this
environment**, not a finding that claude-mem lacks semantic search or loses a
memory task.

The [setup receipt](2026-11-08-setup-receipt.json) records zero model calls,
zero known spend, no remaining temporary credential copies, native worker
shutdown and the direct MCP timeout. Its SHA-256 is
`27ee1860d7a47bca6870adb4515c25c55dc7c7e68d7610616217ebdbca4ffa16`.
The full native receipt's hash and local diagnostic paths are in the setup audit.

## Decision and remaining work

Keep the paid comparison on hold. Running a silently degraded competitor would
violate the preregistration. Running the other conditions alone would not complete
the promised comparison or establish the feature continuation gate.

The next prerequisite is a verified README-supported setup that completes an
actual native semantic query, with fresh memory stores and the same isolated
accounting controls. Preserve this setup report and all first attempts. Any
necessary configuration amendment must be published before model execution;
the 30%, 10% and 7/8 pass marks remain unchanged.

The experimental decision-change feature remains unproven. It must not be
marketed as beating AI-maintained notes, claude-mem or other competitors. This
setup report is separate from the completed KLYPIX 1.112.1 repair release.
