# API setup probe: capture worked, verification failed

claude-mem automatically stored two supporting observations, and a fresh consumer returned the correct synthetic facts using native memory search and retrieval. The setup receipt still failed because our verification parser misread the native response separator and the adapter emitted two transport warnings. This is a setup diagnostic, not a competitor win or loss.

A separate offline check of the retained response confirms that both requested observation IDs belonged to the producer and were delivered by `get_observations`. The original parser expected three corrupted characters instead of the native em dash. Correcting that parser makes its two dependent checks pass on the retained evidence. The original `success: false` receipt and all original gate values remain unchanged.

Source inspection and event order also support a harness cleanup-order defect: the adapter closed idle observer input before requesting native shutdown. Both observers had already settled their costs, and no messages were claimed or pending when the native streams warned. This diagnosis does not remove the warnings from the original result; the corrected shutdown sequence still needs a separate setup proof.

| Original setup gate group | Status |
|---|---|
| Capture, normal tool work, producer queue, search, semantic round-trip, memory-only consumer, accounting, cleanup and API authentication | 10 passed |
| Consumer observation binding and answer binding | 2 failed in the original checker; independently passed by the offline parser regrade |
| Observer transport errors | Failed; two SDK stream warnings retained |
| Consumer queue and final dependency health | Not reached |

Both foreground sessions completed with finalized native audits, zero pending results and zero telemetry errors. Semantic readiness and the default search route passed their setup checks; this does not identify any particular hit as vector-derived. A separate successful setup is still required before a fifth comparison matrix.

This API probe cost **$0.009019665** in reported usage, with **$0.04** charged conservatively. At its completion, all **37** ledger reservations were settled: total known usage was **$0.176013855**, with **$0.35** charged against the original **$50** cap. The total preserves **$0.162041340** from the four earlier experiments and **$0.004952850** from the failed subscription setup. Prior subscription estimates and API usage remain separately labeled; provider invoices were not independently reconciled.

API authentication applied to both foreground sessions and native observers. Native observer model tiers and pass marks were unchanged. No OAuth credential copy was used. The native worker closed and no known probe processes remained; evidence folders were retained.

All [four earlier reports and nine original attempts](2026-11-09-native-audit-v3-result.md), plus the earlier failed subscription setup, remain preserved. Setup costs are excluded from matched benchmark scores while remaining inside the shared budget. No fifth matrix or comparative winner is established.

Source: `6a053eb3dee0894ba900220cf64558281cd63a98`. Protocol: `299a84066b213f0ed1dc524fad7af0390925b421`. The accompanying JSON records all 15 original gate states, the separately labeled offline regrade and input hashes.
