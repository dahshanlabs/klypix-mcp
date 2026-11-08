# Fourth experiment: reconcile nonexecution after the CLI closes

All three [earlier experiments](2026-11-09-native-audit-v2-result.md) and their
five attempts remain published, including the valid notes-control pass. The
third run found a typed permission rejection in final stdout but no matching
proof in the live observer. Its exact journal lookup/binding failure is not
established. No comparison winner is claimed.

## Remove the live-journal dependency

The fourth implementation keeps the same silent native batch receipts and
completed-tool source snapshots for every condition. It removes journal reads
from the hook. A batch result lacking a matching completion is explicitly
pending while the agent runs; it supplies neither positive policy exposure nor
a source revision.

The checkpoint may proceed only when other, independently verified prior-batch
retrieval or permitted native-context evidence already proves the initial policy
was supplied. Pending results cannot satisfy that requirement. Later stdout is
never used to manufacture earlier exposure.

After the CLI closes and stdout drains, reconcile every pending result against
the same session's exact assistant tool ID/name/input, errored user result and
matching typed `non_execution_kind: user-rejected` plus configuration rejection
metadata. Preserve a small provenance receipt and the raw-stream hash. A proven
rejection remains failed and not executed, with no code snapshot.

No row can qualify until final reconciliation completes. An unexplained missing
execution hook, mismatched receipt or unresolved result still invalidates the
row and stops subsequent trials. Unknown/cancelled errors are not assumed to
mean no execution. Existing validation-rejection handling is unchanged. Product
permissions, prompts, memory configuration and grading thresholds do not change.

## Verification before new paid calls

The retained real third-run failure is an exact sanitized regression: its one
pending result resolves only after the valid typed native receipt is available.
Independent replay verified that no pending response becomes positive exposure.

The full stage runner was also tested with the actual pinned CLI, real MCP gate,
actual observer and unchanged permission rules against a synthetic localhost
API. Direct stdout and stdout entirely withheld until exit both passed. A
deliberately missing successful Read completion correctly invalidated the stage.
The final receipt SHA-256 is
`6e988580d66e75b543b3e54bcb580452dcbde50f213d59760f039965c9d67373`.
These checks used a separate fake-usage ledger, no credentials and no paid model.

## Same experiment, separate execution record

Run a fresh complete 30-cell matrix with measurement identifier
`native-audit-v3`. Keep `early-boundary-v2` as the scenario protocol, and preserve
the same seed, order, 25 early-change cells and five seven-session personal
replays. Every attempt in all four experiments remains separately visible.

The pass marks are unchanged: at least 30% fewer stale-policy-correct revisions,
no accuracy regression, and at most 10% extra total model cost versus the
strongest notes control; complete matched data is required, and a zero-rework
control cannot establish an advantage. Personal recall still requires at least
7/8 supported correct answers, zero unsupported claims and all seven sessions.

The original ledger has **$0.06817953** in known API-equivalent usage,
conservatively charged **$0.14**, with all **16** prior reservations settled.
The remaining conservative allowance is **$49.86** under the same **$50** cap.
Retain prior diagnostic costs in that cap and report them separately from the
new matched-condition costs. Publish losses, ties and incomplete results.

The [fourth source freeze](2026-11-09-native-audit-v3-source-freeze.json) binds the
implementation, unchanged tasks/models/pass marks, earlier reports and ledger
baseline before any new model call.
