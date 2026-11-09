# Fifth matrix: administrative continuation after row 27

The same registered matrix has completed 27 of 30 rows. Continue only the final three rows, preserving every existing result and its original order.

Row 27 (`corrected-decision-claude-mem-r3-6b871a16`) remains a **measured failure: `initial-policy-not-retrieved`**. Its producer and consumer completed with finalized native audits. The original workflow therefore did not start the producer update; that reservation settled at $0 with `usage.notStarted=true`.

The first continuation runner stopped on the subsequent temporary-folder cleanup error because its administrative eligibility check assumed every early-change row had three completed stages. That assumption excluded this legitimate two-stage failure. The v2 runner accepts only this exact failure shape, verifies the unstarted update against the original ledger, and requires the same native-process, port, audit and accounting checks before resolving cleanup. The raw failure and cleanup error remain unchanged. The retained scratch folder is neither deleted nor force-stopped by the continuation runner.

No benchmark pass mark, task, model, permission, competitor configuration, grading rule or product source changes. All 27 raw rows are retained byte for byte, and none is rerun. The final three cells remain, in order:

1. Released KLYPIX — corrected decision, repetition 3.
2. AI-maintained notes with notification — corrected decision, repetition 3.
3. KLYPIX prototype — corrected decision, repetition 3.

The original v1 runner and `continuation.json` remain immutable. A separate `resume-fifth-matrix-v2.mjs` and `continuation-v2.json` record the continuation chain. The 27-row interruption snapshot preserves the original experiment, raw results, stopped summary, v1 manifest and existing cleanup receipts. Any further model work still requires the explicit paid-run flag and the same shared $50 ledger.

Bindings:

- Frozen product/harness source: `eaa5ebd4d6fb9e6b0a4631356128771da46690d2`.
- v1 runner SHA256: `72593ccb2ab55891af056e10ffa2934db67c9023818d8165e220523a2179fc56`.
- v2 runner SHA256: `b768ce1450b5f47ff1dc3f2687a52668356d24dcb39eaaf6158e9b33725a05e0`.
- Immutable 27-row prefix: 3,868,088 bytes; SHA256 `3f685bfc3361c4368037a208a6cd4e96befc7335dda267009e732aafaef592b7`.
- Original stopped summary SHA256: `a5e62ddbdab77a653c49fd773cac4e4045d612a3cf5bbd0c901647815049081b`.
- v1 continuation manifest SHA256: `8252249ac29fe13106ff82b8d27083d55a4c75f6c985843e404a22bce4784daf`.
- Shared ledger prefix: 98,756 bytes; SHA256 `66e026214a9db8fe889dcefedd5b05995522426e6a82ff0275060fc533c0663b`.

At this interruption, all 166 reservations were settled: $0.70744316 in known CLI-reported API-equivalent cost and $1.68 charged against the cap, with no open or unknown cost. This amendment is administrative; it neither changes a result nor claims a comparative winner. The independently reviewed [v2 runner](2026-11-09-resume-fifth-matrix-v2.mjs), [manifest and quiescence receipt](2026-11-09-fifth-matrix-continuation-v2.json) are published before the final three paid rows. The real no-model preflight passed.

The no-paid administrative receipt was recorded at 2026-11-09T13:20:09.398Z. The v2 manifest SHA256 is `dd697fd93caf0135a965e4cc60245d19be3e05c610eb182fe130d82f075ece6b`; row 27's quiescence receipt SHA256 (canonical JSON, no newline) is `b8ac50de5c53023f876f4500840b15c995c68603b20b0267f4218dd210b4a698`. Publication remains required before the final three paid rows.
