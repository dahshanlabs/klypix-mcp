# Fourth experiment: three valid passes, comparison incomplete

Four of 30 planned cells were attempted; 26 did not start. All first attempts remain preserved. The completed cells are:

| Condition and case | Result | Known API-equivalent cost |
|---|---|---:|
| AI-maintained notes + notification, unchanged policy | PASS | $0.01148703 |
| Improved KLYPIX, corrected decision | PASS; one current-policy-correct revision, zero stale revisions | $0.02589460 |
| AI-maintained notes/native, personal replay | PASS; 8/8 supported answers, zero unsupported claims | $0.05222123 |
| claude-mem, unrelated-change control | NOT MEASURED: benchmark adapter setup failure | $0.00425895 |

The KLYPIX warning arrived before its first code revision. The personal replay contains seven sessions and eight correlated questions. These isolated passes do not establish a comparative advantage, the 30% rework gate, or statistical significance.

claude-mem’s worker and semantic dependencies were ready, with the intended Haiku/Sonnet settings. Its SDK passed `--model=haiku`, while the benchmark wrapper recognized only split `--model haiku`, so two observer launches were refused before any observer model reservation. No observer model cost was incurred. The queued capture then timed out. This is a benchmark adapter failure, not a competitor loss.

The original claude-mem row remains `accounting-ineligible`: it was written while an administrative review hold was open. That hold prevented the next launch, reserved $49.71, and later settled at $0 without launching a model. The reserved amount is not spending. The row also records a temporary-profile cleanup error; cleanup is handled separately from performance.

This experiment cost **$0.09386181**. Across all four experiments, known CLI-reported API-equivalent cost is **$0.16204134**, conservatively charged **$0.29** against the unchanged **$50** cap. All 31 receipts are settled; no holds, unknown costs or unattributed reservations remain. Actual subscription invoice cost is unknown.

The three earlier reports and their five attempts remain published, including the earlier passing notes control. Together, all nine original attempts remain visible and charged to the same ledger. No earlier result is silently replaced or pooled into this experiment.

Source: `7a0fd6026c293996e7762268d69ae9591c21d0f0`. Published protocol: `a9f5c93dddfd524e28f35971af5fbc5d530def7e`. Tasks, models, permissions, grading and pass marks remained unchanged. Postprocessor: `native-audit-v3-report-1.3` (hash in JSON); it independently verifies final native stage audit eligibility without rewriting raw outcomes.

Cleanup did not finish. The credential copy was removed, but residual experiment-owned state remains. Automatic approval review rejected the combined exact-process stop and validated scratch-directory deletion, stating only that policy blocked it. No bypass was attempted; any future run requires fresh isolation.

A later read-only check found that the residual worker had exited naturally. The temporary folder remains; the credential copy is absent.
