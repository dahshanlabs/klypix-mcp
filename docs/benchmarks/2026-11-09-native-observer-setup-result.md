# Native capture setup probe: launch repaired, comparison still unavailable

The repaired wrapper launched claude-mem’s native observer and settled its model cost. The setup probe still failed: no supporting automatic observation was stored, and the independent recall session did not start. This is a setup diagnostic, not a benchmark loss for claude-mem.

claude-mem’s own preventive quota guard reported **97% weekly subscription usage**, above its **93% pause threshold**, and paused capture to preserve interactive allowance. This was not an observed provider refusal or proof of account exhaustion. Its defaults and guard were not bypassed.

The guard recorded a weekly reset at **10 November 2026, 23:00 UTC** (11 November,
02:00 Riyadh). Its earlier 30-minute recheck is not a guarantee of readiness while
reported utilization remains above the threshold. No further model calls are
planned without a change in the blocking condition.

A read-only database check found zero observations and zero summaries. An empty processing queue was therefore not accepted as successful capture. The quota diagnosis comes from the native persisted guard state; the underlying provider event was not separately retained. Initial semantic readiness passed, but the probe stopped before its later semantic round-trip and independent recall checks.

| Probe component | Observed result | Known API-equivalent cost |
|---|---|---:|
| Foreground producer | Completed ordinary tool work with a finalized audit | $0.00391085 |
| Native observer | Launched and settled; no supporting observation | $0.00104200 |
| Independent recall consumer | Not started | $0 |

The probe cost **$0.00495285**. The four earlier experiments remain at **$0.16204134**, so total known API-equivalent usage is **$0.16699419**, conservatively charged **$0.31** against the original **$50** cap. All **33** ledger reservations are settled; none is open or unknown. Actual subscription invoice cost is unknown.

The raw receipt retains `success: false` and `accountingComplete: false`. The latter gate includes completion of a workflow with at least three reservations; only the producer and one observer ran. Both actual costs are known and settled. The flag is not reinterpreted as a successful setup.

The native worker closed, its known processes stopped, and copied credentials were removed. Temporary evidence folders remain. This fresh probe attempted no forced process stop or recursive deletion. The fourth experiment’s separate cleanup history remains in its report.

All [four earlier reports and nine original attempts](2026-11-09-native-audit-v3-result.md) remain preserved. This probe is reported separately and is not pooled into benchmark scores. No fifth matrix was started and no winner is established. Another full comparison requires a successful native automatic capture and independent recall probe under the unchanged defaults and pass marks.

Source: `a5d5a9777a72e28f0d94a0971fd40eba8dad761c`. [Published setup plan](2026-11-09-observer-setup-probe-plan.md): `479a45308778a2162cb80c5b2bf0ef86b59de486`. Input and receipt hashes are retained in the accompanying JSON.
