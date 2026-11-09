# API authentication before another paid attempt

The [subscription setup probe](2026-11-09-native-observer-setup-result.md) remains a failed setup diagnostic. Its native claude-mem safeguard paused capture at reported 97% weekly usage, above its unchanged 93% threshold. This is not a measured competitor loss or evidence that the account rejected a model call.

The owner authorized a separately billed Anthropic API key within the **same original $50 aggregate cap**. All five arms in the next matrix will use API authentication for their foreground sessions; claude-mem will use the same API account for its native observer. No subscription fallback is allowed. Earlier subscription runs remain separately reported as CLI-reported API-equivalent usage; API costs are also CLI-reported, not independently reconciled to a provider invoice.

## Supported native path and credential handling

Pinned claude-mem 15.12.0 documents `CLAUDE_MEM_CLAUDE_AUTH_METHOD=api-key` and the `CLAUDE_MEM_ENV_FILE` override. Its own loader reads the credential on every observer launch. The override points to a Windows named pipe serving dotenv-formatted data, with the actual native Bun loader unchanged. The key is stored locally using Windows CurrentUser DPAPI and decoded only in process memory. The helper verifies each pipe's owner and access-control entries; only the current Windows user is allowed. This is user isolation, not isolation between processes running as that user.

No plaintext credential file, credential-bearing command line, serialized benchmark configuration or OAuth credential copy is created for these runs. Foreground credentials enter only the child process environment. Stream and passive-receipt guards redact the exact key if echoed. Missing credentials fail closed. The helper has a bounded lifetime and an explicit stop signal. The [helper source](2026-11-09-serve-anthropic-key.ps1) is published for review.

Independent fake-credential verification completed 104 reads through the exact pinned native loader, including six concurrent processes, and verified rejection after pipe shutdown, no OAuth copy, safe serialization, stream redaction and clean shutdown. The actual pipe DACL had one current-user FullControl allow entry and no inherited allow entries; its `AreAccessRulesProtected` field was false. No real key or paid model call was used for these tests. A separate authenticated models-list GET returned HTTP 200 and listed both registered models; it made no model call and does not establish an available credit balance.

## Unchanged measurement and separate setup gate

The original pass marks, fixtures, answers, randomized seed and order, 25 early-change cases plus five seven-session personal replays, foreground Haiku 5.5 with medium effort, notes-maintenance rule, native audit v3, process caps and conservative cost reservations remain unchanged. claude-mem keeps its native hooks, shipped search skill, default Haiku/Sonnet tier routing, Chroma and default MiniLM model. Its quota defaults are not weakened. Product implementation is unchanged by this authentication amendment.

Before any matrix, the [API setup probe](2026-11-09-native-observer-api-setup-probe.mjs) repeats the earlier probe's exact producer and consumer prompts and acceptance requirements in a fresh profile: native automatic capture, producer-linked observations, a distinct consumer opening and citing them, both supported answers, healthy semantic deep round-trip, completed audit, drained queues, known costs and normal native shutdown. It additionally requires API authentication metadata for both sessions and the native adapter. It is a setup diagnostic, never a scored matrix cell. A successful setup result is required before publishing and executing the next matrix freeze.

At publication, the original ledger contains **33 settled reservations**, **$0.16699419** in known CLI-reported API-equivalent usage and **$0.31** conservatively charged against $50. No open reservation, unknown cost or accounting halt exists. The API probe and any later matrix use this exact ledger, including every earlier attempt and both zero-cost administrative holds.

Publish the probe outcome and the comparison even if KLYPIX loses. Retain all previous incomplete attempts and setup failures; no retry replaces them. No superiority claim is supported by the existing incomplete evidence.

Exact reviewed source, probe, helper, unchanged protocol fingerprints and offline proof hashes are recorded in [the source freeze](2026-11-09-api-authentication-source-freeze.json).
