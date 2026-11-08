# Interrupted comparison: diagnostic report

Machine-readable evidence and input hashes: [diagnostic receipt](2026-11-09-interrupted-run.json).

The registered run attempted **2 of 30 cells** and stopped before the remaining **28**. Both first attempts and all original rows remain unchanged. There were no reruns. **No comparison winner or continuation pass is established.**

The notes-with-notification consumer explicitly read the correct policy from CLAUDE.md. Its retained transcript passes the frozen exposure parser. However, its stdout artifact was first created 11397 ms after the checkpoint arrived. The live checkpoint therefore aborted before it could observe that evidence. This is a harness delivery issue, not a notes retrieval loss.

The KLYPIX prototype's completed code passed the current-policy and preserved-shipping checks in its one diagnostic attempt. Its raw telemetry records one code revision and zero stale revisions. Those rework counts are transport-limited: delayed tool-result callbacks can observe only the later file contents. This is not evidence of an advantage.

To stop new cells without killing an active model call, the run owner temporarily reserved **$48 as an administrative hold**. It launched no model and was settled at **$0**. It must never be reported as model spending. The second original row saw that hold while open and retained an accounting-ineligible label; the final ledger resolves actual cost, while the original row is preserved.

Actual CLI-reported API-equivalent model cost is **$0.03482057**: notes diagnostic $0.00728462, prototype diagnostic $0.02753595. Per-reservation rounding charged **$0.06** against the single $50 cap. No reservations remain open; the ledger is not halted. The remaining conservative budget is **$49.94**. Actual subscription invoice cost is unknown.

The frozen scoring marks, tasks and models were not changed. Any repaired transport run must be preregistered and reported separately, retain these diagnostic costs under the same cap, and preserve this record.
