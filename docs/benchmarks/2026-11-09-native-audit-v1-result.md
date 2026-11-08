# Second experiment: interrupted native audit

Machine-readable evidence and raw-artifact hashes: [result receipt](2026-11-09-native-audit-v1-result.json).

Two of 30 planned cells completed; **28 were not started**. The runner stopped itself for an instrumentation review. Both first attempts, original scores and costs are preserved. No reruns occurred.

- **AI-maintained notes with notification, unchanged control: PASS.** Native evidence shows the successful policy Read reached the consumer before its checkpoint. The completed implementation and preserved-shipping checks passed, with no audit errors.
- **KLYPIX prototype, changed-policy case: NOT MEASURED.** Brain-sync retrieval was recorded correctly. Two attempted Bash commands were denied by the host's existing permission policy before execution. The CLI emitted failed model-visible results and PostToolBatch events, but no per-tool completion hooks; the audit had handled only schema-validation rejection and stopped before the update stage. The retained stream explicitly marks both as non_execution_kind=user-rejected and permission_decision=reject/source=config. This is a measurement limitation, not a product loss.

This run cost **$0.02421613** API-equivalent. Including the first published diagnostics, the shared ledger totals **$0.05903670**, conservatively charged **$0.11** against the original $50 cap. No reservations remain open; actual subscription invoice cost is unknown. The earlier administrative hold cost $0.

The single notes control pass is retained, but the matrix is incomplete and supports **no winner or continuation pass**. No model, task, grade, permission allowance or pass mark was changed during this run.
