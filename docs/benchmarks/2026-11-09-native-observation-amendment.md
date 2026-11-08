# Second experiment: repair observational transport

This amendment follows the [interrupted first run](2026-11-09-interrupted-run.md).
It is not a replacement for its two retained attempts. Their cost remains in the
same $50 ledger. The first run establishes no product comparison or feature pass.

## Reason for the change

The notes consumer actually read the initial policy. Its stdout evidence reached
the parent after the independent checkpoint file appeared, and the parent
aborted before observing that evidence. Replaying the retained transcript with
the frozen parser finds the read. Delayed stdout can also cause the parent to
snapshot a file after a later edit, losing intermediate revisions.

A zero-model reproduction demonstrates that these independent transports have no
ordering guarantee. A separate credential-free check of the real pinned CLI
against a localhost synthetic API streamed normally with both the original flags
and partial-message output. We therefore do not claim a general Claude CLI defect
or that a streaming flag alone fixes the observed failure. Slow synchronous
writes to E: are a plausible contributor, not an established sole cause.

## Identical passive observation for all five conditions

Add the same silent, synchronous native observer to every foreground producer
and consumer. Preserve the product's existing hooks. The observer records data
outside the trial repository, returns no advice or context to the model, and
never runs an answer checker while the model is working.

- `PostToolBatch` records the exact serialized tool results supplied at a
  completed batch boundary. A completed prior batch can establish that a real
  retrieval supplied the initial policy before the checkpoint. A Read and
  checkpoint launched in the same batch do not meet that condition. Verified
  native startup-context injection remains a distinct permitted evidence source.
- `PostToolUse` and `PostToolUseFailure` record invoice-file bytes at the native
  completed-tool boundary. Grade those recorded bytes only after the consumer
  exits. Do not re-read a later file when delayed stdout arrives.
- Keep stdout for costs, transcripts and cross-checks. Missing or invalid audit
  evidence is an instrumentation limitation; it cannot become zero rework or a
  product win. Observation errors must remain visible.

These event contracts are documented in the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks). Actual
CLI 2.1.319 localhost checks verified prior-batch delivery, exclusion of a
same-batch Read/checkpoint, and snapshots before and after subsequent edits.
They used synthetic local responses, no credentials and no paid model calls.

The actual observer also passed native ToolSearch, successful Read, missing-file
Read, rejected tool arguments and MCP-response checks. A documented argument
validation rejection occurs before tool execution and has no completion hook;
retain it as an errored, unexecuted result, never as successful exposure or a
code revision. An initially over-strict observer rejected that case in an offline
check; that failed diagnostic remains recorded alongside the correction.

| Offline receipt | SHA-256 |
|---|---|
| Final native observer coverage | `94aa96e817818b1e5190087d1d75d141928f2b328c537fe83f84ee853221b625` |
| Same-batch exclusion with actual observer | `68508a5b38640627c6003d8fe4a1023b5f0ce7db3050d78666adb25a96df8f5b` |
| Earlier validation-rejection diagnostic | `6c8a9e86de411c19266433289c3ce59fac81d18ae947fe8bc271045f306b29fe` |

Live transcripts and result artifacts for this experiment also move to task-owned
C: storage. Trial repositories and homes already use C:. The original shared
budget ledger stays in place; export artifacts after execution. This avoids
depending on the previously slow E: volume for live stdout recording.

## Unchanged experiment and reporting rules

Use the same 25 early-change cells and five seven-session personal-memory replays,
the same seed and order, tasks, prompts, model identities, effort, native product
defaults and grading thresholds. The scenario protocol remains
`early-boundary-v2`; identify the repaired measurement transport separately as
`native-audit-v1`. Run a complete separate matrix, so one comparison never mixes
two observation methods. Every first attempt in each experiment remains visible.

The feature gate still requires at least 30% fewer stale-policy-correct revisions,
no final-accuracy regression and no more than 10% additional total model cost
versus the strongest notes control. The zero-baseline and complete-data rules
still apply. Personal recall still requires at least 7/8 source-supported correct
answers, zero unsupported claims and all seven sessions completed.

Before the new experiment, the shared ledger has $0.03482057 in reported model
usage and $0.06 in conservative charges. All reservations are settled, including
the zero-cost administrative hold. The remaining conservative allowance is
$49.94; this amendment does not create a fresh $50 budget.

Record the baseline ledger and reservation identities before restarting. Report
those earlier diagnostic costs separately from the new matched-condition costs,
while retaining them in the aggregate spending limit. New unattributed or
uncertain spending cannot be hidden as prior usage. Stop launching cells if the
shared observer itself fails; ordinary product losses remain in the comparison.

Publish losses, ties, incomplete cases, setup failures and budget stops. The
original attempts remain diagnostics even if the repaired experiment succeeds.
No broad product ranking, statistical advantage or 100-times claim follows from
this small developer-authored pilot.

The [new source freeze](2026-11-09-native-audit-source-freeze.json) records the
final source commit, unchanged plan, CLI provenance and ledger baseline before
any new model call.
