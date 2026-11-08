# claude-mem benchmark setup audit

Audit completed 8 November 2026 UTC (9 November locally). **Final result: setup unavailable; the paid comparison remains unexecuted at $0.** This is a setup audit, not a capability result or a claude-mem loss. The pinned competitor is `claude-mem@15.12.0`; no model requests were executed during this audit.

## README-supported setup

The [pinned README](https://github.com/thedotmack/claude-mem/blob/v15.12.0/README.md#quick-start) recommends the worker installer for agent-assisted setup. It explicitly supports skipping account sign-in with an explicit provider or a noninteractive installation, and offers the user's Anthropic plan as a provider. We use that supported Claude subscription path. The interactive hosted observer trial requires an account and payment-method checkout; it is not configured or evaluated here.

The adapter uses the published worker, MCP server, memory-search skill and native hook handlers from the pinned npm package. It resolves launchers to absolute local paths, registers hooks in the isolated agent settings, and omits installer-only version/launcher setup hooks. This avoids a global installation and host configuration changes. It is an instrumented local installation, not a claim that the unmodified interactive installer was run.

## Preserved defaults

Source: [v15.12.0 settings defaults](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/shared/SettingsDefaultsManager.ts).

| Setting | Benchmark behavior |
|---|---|
| Provider / authentication | Claude / existing subscription, the supported noninteractive path |
| Observer model | `haiku` |
| Tier routing | Enabled; simple/fast `haiku`; summary inherits; smart `sonnet` |
| Capture | Native lifecycle hooks and observer enabled; batch size 1; bare prompts carried with the next tool event |
| Startup recall | 50 observations, current project, native context formatting |
| Search | Native three-step search skill and MCP tools; Chroma enabled/local with default local MiniLM embedding |
| Per-prompt semantic injection | Off, the shipped experimental-feature default |
| My Work | Default refresh and Haiku/Sonnet per-step choices retained |
| Fallback | Default Claude provider fallback and empty alternate-auth setting retained |

The smart alias does not imply every complex observation is automatically upgraded: [ClaudeProvider](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/worker/ClaudeProvider.ts) resolves the configured observer model and summary override; [model-aliases](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/worker/model-aliases.ts) explains the explicit tier aliases.

The README's documented `SESSION_START_INCLUDE_ALL_SOURCES=true` option is enabled. Telemetry is disabled. Profiles, database, worker port, package copy, npm/Git settings and Python/model caches are isolated under temporary benchmark directories. Only authorized Claude OAuth material is copied into the restricted observer profile, then removed on close. No global settings, project memories or other provider credentials are copied.

Chroma uses a stdio child with `--client-type persistent --data-dir <trial data directory>/chroma`; the [native launcher](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/sync/ChromaMcpManager.ts#L663) only uses host/port settings in remote mode. Thus the default port 8000 is not a connection to any existing Chroma server. The worker itself binds its allocated loopback port. An optional benchmark-only dependency cache may be reused for Python packages and pretrained model downloads; session databases and vector indexes remain per-trial. The adapter's native-search readiness check must succeed before its model-call broker is enabled.

The isolated Windows setup additionally requires managed Python: the Store alias initially produced a broken trampoline under the remapped `LOCALAPPDATA`. The same default Python 3.13 line was installed as CPython 3.13.14 in the benchmark directory. `UV_MANAGED_PYTHON=1`, `UV_PYTHON_NO_REGISTRY=1`, `UV_PYTHON_INSTALL_REGISTRY=false`, `UV_PYTHON_INSTALL_BIN=false`, and `UV_NO_MODIFY_PATH=1` prevent reliance on that alias or host installation changes. These are dependency-isolation settings, not different memory models. See [uv's environment reference](https://docs.astral.sh/uv/reference/environment/).

## Model and budget instrumentation

Foreground models are controlled by the common protocol. The competitor observer retains its own default tier choices. To make alias resolution reproducible, the subprocess environment resolves `haiku` to `claude-haiku-5-5` and `sonnet` to `claude-sonnet-5-5`. It does not replace Sonnet work with Haiku or impose the previous artificial 4,096-token observer output limit.

Official [pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [limits](https://platform.claude.com/docs/en/models/overview), checked 8 November UTC, give a 1M context and 128K maximum output for both. Conservative reservations include the costliest documented one-hour cache write, Haiku's higher long-context rates, and the 1.1 geography multiplier:

| Model | Worst input / million | Output / million | One-call margin | Reservation with $0.50 process cap |
|---|---:|---:|---:|---:|
| Haiku 5.5 | $1 | $2.50 | $1.452 | $1.96 |
| Sonnet 5.5 | $4 | $10 | $5.808 | $6.31 |

Before each child starts, a loopback broker reserves the process cap plus that one-call margin in the same durable **$50 aggregate ledger** as the foreground agents. My Work and retries are included. A reservation is headroom, not an assertion that the entire amount was spent. Actual usage uses the latest cumulative Claude CLI cost receipt; receipts are not summed across streaming turns. These are API-equivalent estimates, not a subscription invoice. Missing/regressing receipts or an unexpected model charge the complete reservation and halt further work.

Cap hits and denied reservations remain visible after native processing queues drain and after adapter shutdown. They produce a **budget-limited diagnostic**, excluded from product outcome rates. Neither a dropped native queue nor an empty queue can erase them. Any allowance needed beyond the aggregate budget requires a revised protocol; the adapter does not silently select cheaper product settings.

## Background route audit

- **Observer and summaries:** `ClaudeProvider` uses the SDK with the configured executable. [Executable resolution](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/shared/find-claude-executable.ts#L427) honors the explicit wrapper path and fails visibly if it is invalid.
- **My Work:** [refresh-task](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/work-view/refresh-task.ts#L51) uses Haiku for grouping/focus and Sonnet for goals/review/story. Its default provider selection confines this setup to Claude. [agent-runner](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/agent-runner/run.ts#L152) passes the resolved executable to the SDK, so these requests use the same broker.
- **Quota fallback:** the [pinned fallback documentation](https://github.com/thedotmack/claude-mem/blob/v15.12.0/docs/public/usage/quota-fallback.mdx) says a provider that is its own fallback pauses. Alternate Claude credentials are off by default and none are supplied. No Gemini, OpenRouter, hosted observer or OpenAI-compatible key is provided.
- **Generated dashboard wording:** [WorkViewRoutes](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/worker/http/routes/WorkViewRoutes.ts#L334) defaults to a direct HTTP copy provider only for an OpenRouter primary. A Claude primary with no explicit copy endpoint resolves to no provider. That path therefore cannot spend under this configuration; its default is preserved.
- **Semantic embeddings:** the default local Chroma/MiniLM path downloads dependencies/model weights; it does not need a paid embedding API. Hosted cloud/team routes have no supplied credentials or configuration.

These are source-route checks, not evidence that real capture or paid background requests have succeeded. No paid integration claim is made before an actual measured run.

## Validation and final blocker

`node test/decision-change-claude-mem.mjs` passes without credentials or model calls. It covers model-specific reservation, no launch before reservation, stream preservation, cumulative/unknown/regressing costs, unexpected-model rejection, budget-refusal persistence, cap diagnostics and host-environment isolation.

| Bounded attempt | Observed result |
|---|---|
| Updated native wrapper compilation, 60-second deadline | Timed out before worker start; $0 ledger; credential removed |
| Compilation retry, 180-second deadline; native worker start | Passed compilation, worker health/readiness and MCP loopback self-check; clean stop; $0 spent/reserved; credential removed |
| Credential-free native search, vendor's 120-second dependency prewarm | Timed out downloading dependencies; explicit semantic-offline/FTS fallback |
| Exact pinned dependency prewarm, 300-second deadline | Installed 109 packages; failed with a broken Windows Store Python trampoline |
| Managed-Python dependency prewarm, 300-second deadline | Passed `chroma-mcp --help` with CPython 3.13.14 and the same 109 dependencies |
| Native worker/search recheck, unchanged vendor 120-second prewarm | Still timed out; HTTP 200 explicitly reported semantic search offline and keyword fallback; doctor marked dependency degradation; worker stopped cleanly |
| Direct disposable Chroma MCP initialization, 120-second request timeout | Timed out after installing 109 packages; no usable MCP connection, collection add, embedding or query result obtained |

The direct MCP diagnostic used a separate `vector-probe` data directory, not a trial memory store. Its uvx child exited; the helper remained open during shutdown and was stopped after confirming that child had gone. No paid work or additional repair attempts followed. Because both native and direct initialization failed, the evidence does **not** establish that the problem is confined to the worker's launch environment. A live process or successful empty-project response alone would not prove working embeddings.

The adapter refuses paid startup on the observed native dependency degradation and reports later degradation as a setup diagnostic. **The remaining gate is a demonstrated native Chroma embedding add/query with disposable data, followed by real producer/consumer capture evidence under the published protocol.** Until then, the full comparison stays unexecuted; no score is assigned to claude-mem.

## Frozen local evidence

Artifact root: `E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5`.

- Paths-only configuration: `adapter-config.json`; observer envelope $12.62, individual process cap $0.50, shared ledger aggregate cap $50.
- Native receipt: `semantic-preflight-zYO8PZ/native-readiness-receipt.json`; SHA-256 `fc3c4fff93b555e379064f5eb5edd0774d4e02f32c8365e77639b6d0ed87d73b`.
- Aggregate receipt including direct MCP diagnostic: `setup-audit-receipt.json`; SHA-256 `27ee1860d7a47bca6870adb4515c25c55dc7c7e68d7610616217ebdbca4ffa16`.
- Native search log: `semantic-preflight-zYO8PZ/data/logs/claude-mem-2026-11-08.log`.
- Successful wrapper/worker zero-spend ledger: `preflight-defaults-vooDUG/ledger.jsonl`.
- Dependency cache home: `semantic-preflight-zYO8PZ`; Python at `.local/share/uv/python`, packages at `.cache/uv`, Hugging Face cache at `.cache/huggingface`. Local Chroma's default ONNX model path is the isolated profile's `.cache/chroma/onnx_models`; no embedding model execution was verified.
- Credential-copy check: **zero remaining** across all five adapter preflight profiles. No live brain, global profile, registry or PATH was changed.

Automatic approval review blocked removal of the failed temporary build artifact `preflight-defaults-NsJOVb/.claude-mem-benchmark/.663ff0ef1e55f027-00000000.bun-build`, with the stated reason **“blocked by policy.”** It was left untouched; no alternate deletion method was attempted.
