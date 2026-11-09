# Preregistered KLYPIX / claude-mem comparison

Recorded 8 November 2026, before any paid model call in this experiment.
This is a small, developer-authored pilot. It cannot establish a general product
ranking, a statistical result across teams, or a 100× advantage.

**Execution update:** the original [preflight report](2026-11-08-setup-result.md)
and [recovery amendment](2026-11-09-setup-recovery.md) remain published. The first
run stopped after two attempts because stdout-based observation missed a real
notes read. The [diagnostic report](2026-11-09-interrupted-run.md) retains both
attempts and $0.03482057 in API-equivalent cost; 28 cells did not start. These
pass marks remain unchanged. No comparison winner or continuation pass is claimed.

The [second-experiment amendment](2026-11-09-native-observation-amendment.md)
replaced the observational transport identically for all arms. Its
[published result](2026-11-09-native-audit-v1-result.md) retains one notes-control
pass and a KLYPIX attempt interrupted by misclassified permission denials, with
28 cells unstarted. Combined spending is $0.05903670; there is still no winner.
The [third-experiment amendment](2026-11-09-typed-denial-amendment.md) attempted
typed native denial recognition. Its [result](2026-11-09-native-audit-v2-result.md)
retains one more interrupted attempt and 29 unstarted cells. Across all three
experiments, five attempts and $0.06817953 are preserved; no winner is established.
The [fourth amendment](2026-11-09-final-reconciliation-amendment.md) removes the
live-journal dependency and requires final typed reconciliation before scoring.
Its [result](2026-11-09-native-audit-v3-result.md) preserves three valid passes
and one claude-mem setup failure: the benchmark wrapper rejected the native SDK's
equals-form model option before an observer model could start. This is not a
competitor loss. All nine attempts across four experiments remain visible, with
$0.16204134 in known API-equivalent usage under the original $50 cap. No comparison
winner or feature-continuation pass is established; the pass marks below are unchanged.
The [native-observer setup probe plan](2026-11-09-observer-setup-probe-plan.md)
requires verified automatic capture and retrieval before another complete matrix.
Its diagnostic calls share the same original budget and never count as benchmark cells.
The [setup result](2026-11-09-native-observer-setup-result.md) confirms the repaired
observer launched, but claude-mem's default 93% quota guard paused capture at
reported weekly usage of 97%. No observation was stored and recall did not start.
Total known usage is now $0.16699419; no fifth matrix or comparative winner exists.

## Conditions and setup requirements

1. One ordinary `CLAUDE.md` document maintained by AI, with a standing rule to
   read current decisions at task start, update them when they change, and re-read
   before completion. No harness or human perfects its policy text.
2. The same AI-maintained notes plus a simple whole-file change-notification hook.
3. Released KLYPIX 1.112.1.
4. The KLYPIX experimental revision-aware decision alerts build.
5. claude-mem 15.12.0, configured through a path recommended by its own pinned
   README, with native capture/recall and the documented default memory models.

All foreground producer and consumer sessions use **`claude-haiku-5-5` at medium
effort**, including the AI maintaining notes. claude-mem's recommended background
processing remains enabled and its model identity and cost are reported separately.
Both KLYPIX builds receive the same supported native-hook configuration. Native
host memory remains enabled in fresh isolated profiles.

Before running, publish an installation audit against the pinned claude-mem README:
provider/authentication path, hook manifest, observer models, semantic-search
readiness, settings, deviations and verification results. A missing essential
component is a setup failure, not evidence that claude-mem loses. No unsupported
stripped-down configuration may be described as the recommended setup.

Source builds, harness and fixture hashes, CLI versions, configuration and fixed
run order must be captured before the first paid call. Necessary amendments must
be published before outcomes exist, with their reason. After the first paid call,
changes create a new experiment; they cannot replace the original observations.

## Block A: decisions changed during active work

Plan **25 trials**: five conditions, each with three repetitions of a changed
invoice-rounding decision, one unchanged-policy control and one unrelated-change
control. All facts and updates are written by real producer sessions through each
condition's ordinary workflow. The continuing consumer must actually receive the
initial policy before a neutral timing checkpoint. The checkpoint supplies no
policy; every condition gets the same subsequent harmless inspection boundary.

If an observed normal memory retrieval fails to return the initial policy, retain
that as a measured retrieval failure. Missing or unauditable delivery traces are
instead unverified exposure. Neither can establish the causal update comparison;
both remain visible with their costs and neither is silently removed.

Record final correctness, preservation of unrelated behavior, delivered alerts,
intermediate source revisions, elapsed time and all model costs. A notification,
acknowledgment or self-reported adaptation is not a successful implementation.

The primary rework proxy is the number of **distinct observed intermediate code
revisions that satisfy the old policy but fail the current policy**. Capture after
completed tools; grade snapshots after the consumer exits, without feeding hidden
tests back to the model. This does not measure hidden reasoning, human minutes or
unobserved writes within a tool invocation.

**Feature continuation pass mark — all conditions must hold:**

- At least **30% fewer stale code revisions** than the strongest notes control.
  Choose the stronger notes control by higher final correctness, then lower total
  stale-revision count, then lower total model cost. Use the three changed-decision repetitions
  per condition. If its count is zero, reduction is undefined and there is **no
  demonstrated advantage** on this endpoint.
- No lower final-correctness rate than that control, and no new unrelated-code
  damage. A false decision-change warning on the unchanged/unrelated controls is
  a control failure; report generic whole-file notices separately because their
  claim is only that the file changed.
- Total model cost, including maintenance and background processing, at most
  **10% above** that control for the same complete early-change block.
- The planned comparison must be complete and its exposure/accounting valid.
  Budget-stopped, setup-failed or otherwise incomplete matrices cannot pass.

These are precommitted product gates, not statistical significance claims.
claude-mem and released KLYPIX receive the same per-case outcome reporting;
passing the notes gate alone does not establish superiority over either.

## Block B: personal memory across sessions

Plan one **seven-session replay per condition**: six chronological capture
sessions followed by eight fixed, paraphrased recall questions. Keep one person's
isolated project and profile across the replay. Include stable facts, distracting
details, explicit corrections, a superseded historical choice, and one fact that
was never decided. This exercises claude-mem's automatic personal-memory use case;
it does not prescribe the winner.

The sessions are labeled simulated days. Use actual execution timestamps: do not
alter the clock, file times or memory database dates. This tests multi-session
continuity, **not actual multi-day retention or time-based decay**.

**Personal-memory pass mark: at least 7 of 8 answers correct, with zero unsupported
factual claims.** Current facts, historical facts and appropriate abstention are
scored separately. A known answer must have supporting context actually supplied
  to the final session through a normal retrieval tool. All conditions must verify
  their cited sources in that final session, even if startup already supplied the
  facts. Opening the notes file qualifies. This is retrieval-assisted recall,
  and its additional cost is included for every condition.
Accept equivalent wording under a rubric fixed before running. Publish answer
values, source support, automatic grades and any separately identified review.

Each set of eight answers belongs to one correlated replay. Do not call the five
replays forty independent trials, or aggregate this block into a single flattering
score with Block A.

## Budget, stopping and publication

One durable **$50 maximum ledger** covers both blocks, foreground and background
models, setup/debug model calls, smoke attempts and retries. Reserve a verified
process limit plus a worst-call overshoot allowance before starting; a CLI budget
flag alone is insufficient. Missing cost receipts or unpriced models halt further
spending. Costs are reported as CLI API-equivalent estimates; the actual subscription
invoice is not inferred. No new account or paid service purchase is included.

Publish the protocol commit before the first paid call and publish the resulting
report even when KLYPIX loses. Include ties, losses, raw first attempts, setup
failures, unknown exposure, timeouts, budget stops, exact integrations, model costs
and limitations. Preserve retries as additional attempts; never silently replace
failures or select only winning cases. Synthetic transcripts may be published
after credential and private-path review.

A successful pilot still requires independent real-team validation. A tie with
notes plus a small hook is a reason to withhold a differentiation claim, not to
weaken the baseline.

## Clarifications before execution

No paid calls or outcomes exist. Before running, the strongest-control selection
was clarified to prioritize final correctness before stale-revision count, so an
incorrect or empty implementation is not favored for producing few revisions.
Final source verification was also made explicit and identical across the personal
memory conditions, avoiding unequal proof standards for native startup context.
The numerical 30%, 10% and 7/8 pass marks are unchanged.
The distinction between a measured retrieval omission and unverified exposure was
also fixed before execution, so genuine retrieval failures cannot disappear from
the reported denominator.


## 2026-11-09 API authentication update

The [published API authentication amendment](2026-11-09-api-authentication-amendment.md) switches every future arm to the authorized API account after the native subscription quota guard paused setup. Original pass marks and the single $50 ledger are unchanged. The separate API capture/recall probe must pass before a new complete matrix. All previous outcomes remain published.


## 2026-11-09 native lifecycle update

The [first API setup result](2026-11-09-native-observer-api-v2-result.md) preserves successful automatic capture and correct retrieval alongside checker and shutdown-order defects. The [lifecycle amendment](2026-11-09-native-lifecycle-amendment.md) repairs those harness defects before a fresh setup probe. Original benchmark pass marks and budget are unchanged.


## 2026-11-09 fifth matrix authorization

The [API native setup proof](2026-11-09-native-observer-api-v3-result.md) passed all 15 gates. The [fifth matrix amendment](2026-11-09-observer-sdk-compatible-amendment.md) and source freeze bind the same original pass marks, plan, models and ledger before execution. All four interrupted matrices and three setup probes remain separately preserved.
