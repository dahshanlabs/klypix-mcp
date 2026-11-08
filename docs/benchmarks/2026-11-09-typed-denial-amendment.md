# Third experiment: recognize typed native permission denials

The [second experiment](2026-11-09-native-audit-v1-result.md) preserved a notes
control pass, then stopped before KLYPIX's decision update because the observer
misclassified two permission-denied shell commands. Both interrupted experiments
and all four attempts remain published. No comparison winner is established.

## Narrow measurement correction

Keep the same passive completed-tool snapshots and completed-batch exposure
checks. Change only how a missing completion hook is interpreted when the native
host proves that it rejected a command before execution.

In the unchanged `acceptEdits` configuration, these rejections produce a batch
result but no `PostToolUse`, `PostToolUseFailure` or `PermissionDenied` event.
The native session journal already contains typed rejection metadata when the
synchronous batch observer runs. Offline checks of the actual pinned CLI proved
this ordering using the same denied commands and permission configuration.

`native-audit-v2` may use that journal only inside the isolated profile, for the
exact session filename, session identity, repository, tool ID, tool name, tool
arguments and serialized response. The matching native result must be errored,
marked `toolDenialKind: user-rejected`, and carry a configuration rejection in
`permissionDecision`. Retain only the matched typed provenance and response hash,
not the journal or thinking text.

Such a result remains **failed and not executed**. It supplies no successful
policy exposure and no code revision. It simply does not require a completion
hook for an operation the host proves never ran. Do not broaden permissions,
accept denial-message wording alone, excuse a missing successful-tool record,
or infer execution status for unclassified errors. Existing validation-rejection
handling remains unchanged; unresolved evidence still stops measurement.

The hook-time proof receipt SHA-256 is
`c6a6eb7fb9bbc08d5e21058d1059aeb24a08c617b1f2fc1eeac8fa8260c85d1c`.
The full unchanged-permission diagnostic receipt SHA-256 is
`7c23bc8b1389efa24c9352ef00645e2f47990fd4507488b31097ca3cf42248c4`.
These used synthetic localhost API responses, no credentials and no paid model.

The exact final observer passed the unchanged-permission native check
(`8a3567095be24b5bd4eabc3307a68a8c4fc9a0128978bd82dbb6a88079166de5`).
A separate unknown-tool check remained invalid, as required
(`bac143a124ed97646fe012d086d134c18905eaa21df6cfb42d1f1075e9fad343`).
Normal completed calls skip journal reads. Only complete journal records can
support a rejection; an incomplete required record cannot qualify.

## Unchanged controls, pass marks and aggregate cap

Run the same complete 30-cell matrix as a separate third experiment. Preserve
both earlier experiments independently. The tasks, prompts, seeded order,
foreground and background models, effort, product configuration, permissions and
grading thresholds remain unchanged. The scenario stays `early-boundary-v2`;
only the measurement identifier becomes `native-audit-v2`.

The feature still needs at least 30% fewer stale-policy-correct revisions, no
accuracy regression and at most 10% additional total model cost against the
strongest notes control. Complete matched data is required, and a zero-rework
control cannot establish an advantage. Personal recall still needs at least 7/8
supported correct answers, zero unsupported claims and all seven sessions.

The original shared ledger already contains **$0.05903670** in API-equivalent
model usage, conservatively charged **$0.11**. All reservations are settled;
**$49.89** remains under the same $50 cap. Include earlier diagnostic spending
in that cap and report it separately from the new matched-condition costs.
Publish every loss, tie, setup failure, interrupted attempt and budget stop.

The [third source freeze](2026-11-09-native-audit-v2-source-freeze.json) binds the
exact implementation, unchanged plan, earlier reports and ledger baseline before
any new model call. No result from the earlier attempts is replaced.
