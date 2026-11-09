# claude-mem benchmark setup audit

Audit amended 8 November 2026 UTC (9 November locally), after the user authorized further setup diagnosis. **Current result: native semantic setup verified; the paid comparison remains unexecuted at $0.** The original setup-unavailable result and all seven bounded attempts are preserved below. This is a setup audit, not a capability result or a claude-mem win or loss. The pinned competitor is `claude-mem@15.12.0`; no model requests were executed during this audit.

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

## Original validation and blocker (preserved)

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

The direct MCP diagnostic used a separate `vector-probe` data directory, not a trial memory store. Its uvx child exited; the helper remained open during shutdown and was stopped after confirming that child had gone. At that freeze, no paid work or additional repair attempts followed. Because both native and direct initialization failed, that evidence did **not** establish that the problem was confined to the worker's launch environment. A live process or successful empty-project response alone would not prove working embeddings.

The adapter refuses paid startup on native dependency degradation and reports later degradation as a setup diagnostic. The original remaining gate was a demonstrated native Chroma embedding add/query with disposable data. The amendment below satisfies that setup gate. Real producer/consumer capture and comparative outcomes remain unmeasured; no score is assigned to claude-mem.

## Original frozen local evidence

Artifact root: `E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5`.

- Paths-only configuration: `adapter-config.json`; observer envelope $12.62, individual process cap $0.50, shared ledger aggregate cap $50.
- Native receipt: `semantic-preflight-zYO8PZ/native-readiness-receipt.json`; SHA-256 `fc3c4fff93b555e379064f5eb5edd0774d4e02f32c8365e77639b6d0ed87d73b`.
- Aggregate receipt including direct MCP diagnostic: `setup-audit-receipt.json`; SHA-256 `27ee1860d7a47bca6870adb4515c25c55dc7c7e68d7610616217ebdbca4ffa16`.
- Native search log: `semantic-preflight-zYO8PZ/data/logs/claude-mem-2026-11-08.log`.
- Successful wrapper/worker zero-spend ledger: `preflight-defaults-vooDUG/ledger.jsonl`.
- Dependency cache home: `semantic-preflight-zYO8PZ`; Python at `.local/share/uv/python`, packages at `.cache/uv`, Hugging Face cache at `.cache/huggingface`. Local Chroma's default ONNX model path is the isolated profile's `.cache/chroma/onnx_models`; no embedding model execution was verified.
- Credential-copy check: **zero remaining** across all five adapter preflight profiles. No live brain, global profile, registry or PATH was changed.

Automatic approval review blocked removal of the failed temporary build artifact `preflight-defaults-NsJOVb/.claude-mem-benchmark/.663ff0ef1e55f027-00000000.bun-build`, with the stated reason **“blocked by policy.”** It was left untouched; no alternate deletion method was attempted.

## Setup recovery amendment, before paid measurement

Controlled probes isolated a storage/cold-cache problem in the original E: staging environment. The same Python and package versions initialized a fresh persistent Chroma database on C: in 2.77–2.93 seconds; first initialization on E: took 24–27 seconds even in a short fresh path. Later stacks progressed through lazy native imports, bytecode writes and ONNX model initialization, so this was not evidence of a permanent deadlock. E: had substantial disk queueing during the probes. The evidence supports moving this benchmark's isolated dependencies and scratch data to C:; it does not establish a general Windows or claude-mem defect.

The existing trial harness already creates fresh profiles/projects through `os.tmpdir()` on C:. The recovery also puts its task-owned dependency cache on C:. The exact resolved versions remain CPython 3.13.14, `chroma-mcp` 0.2.6, `chromadb` 1.5.9 and `onnxruntime` 1.31.1, with the vendor's `protobuf<7` and `pydantic<2.14` constraints. The shipped worker still invokes its own `--python 3.13 --with onnxruntime>=1.20` recipe and native 120-second prewarm deadline. No upstream source, recall setting, embedding model, tier model, capture hook or benchmark pass mark was changed.

Only six default MiniLM pretrained files are reused from the successful native download. The adapter copies this fixed allowlist into each fresh profile's normal ONNX cache, hashes the copied bytes and refuses overwrites. Database files, collection/index state, observations, sessions and setup-probe memories are never copied into a trial. Missing model files leave the native download enabled. This is the protocol's existing dependency/model-cache reuse allowance, now explicit for Chroma's home-based ONNX cache rather than only `HF_HOME`.

| Recovery check | Observed result |
|---|---|
| Native uvx prewarm with `UV_LINK_MODE=copy`, same E: cache | Passed independently through Node and portable Bun; this did not prove embeddings |
| Fresh C: database with warmed original dependencies and default MiniLM files | Native Chroma MCP connected in 12.6 seconds, added two documents in 7.0 seconds, then queried them in 2.4 seconds; the paraphrase selected the animal document over the programming document |
| Same resolved dependencies provisioned in fresh C: dependency home | Native `chroma-mcp --help` passed in 88.865 seconds |
| Full isolated adapter with C: dependencies and six default MiniLM assets | Native worker/MCP/readiness passed, dependency health nondegraded; $0 ledger and copied credential removed on close |
| First external worker-proof helper | Its MCP SDK result-schema argument was incorrect (`safeParse` error) after a native save; corrected the diagnostic helper, with no competitor code change |
| Credential-free native worker proof, using the corrected helper | Native `save_memory` saved two records; native `search` for “Which entry describes wildlife?” returned only `Field report` (#2), not the programming distractor; deep Chroma check reported a successful semantic round-trip (280 ms), health nondegraded, worker and Chroma stopped cleanly |

The final proof used ordinary native tools and disposable setup data, not a model producer. It proves embedding storage/query and the worker's semantic route. It does **not** prove paid observation quality, longitudinal recall, mid-task delivery or any comparative outcome. Those remain the unchanged preregistered experiment. No trial data or knowledge was prepared by this setup proof.

### Recovery evidence and reproducible paths

- Paths-only run configuration: `E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5/adapter-config.json`.
- C: dependency home: `C:/Users/HP/AppData/Local/Temp/cmem-dependencies-c-afvmbC`; managed Python at `.local/share/uv/python`, uv packages at `.cache/uv`, default weights at `.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx`.
- Final setup-only profile: `C:/Users/HP/AppData/Local/Temp/cmem-native-c-QojaAe`; all its memories/indexes stay outside the trial profiles.
- Independent native add/query trace: `C:/Users/HP/AppData/Local/Temp/chroma-native-mcp-Zk4Ao8/probe.log`.
- Full-worker proof: `C:/Users/HP/AppData/Local/Temp/cmem-native-c-QojaAe/native-worker-embedding-proof.json`; no model credentials present, no model calls, clean native stop.
- Adapter readiness and zero-spend/credential-cleanup receipt: `C:/Users/HP/AppData/Local/Temp/cmem-native-c-QojaAe/native-adapter-receipt.json`.
- Exact installed dependency manifest: `E:/tmp/claude-mem-bench-inspect-d73c86a27a8b4f8190da25f655b1e2a5/setup-recovery-dependency-manifest.json`; includes package versions, installed METADATA/RECORD hashes and native binary hashes.

| Recovery artifact | SHA-256 |
|---|---|
| Full-worker embedding proof | `e009acc137f63c78bbd2f3067de8f62a87387e9e11d528221742134f2a256e29` |
| Adapter readiness/cleanup receipt | `ae0354d19a9b752a6126938afb2bb6945bf106d5014a758f7747b237c0d20ef8` |
| Dependency provisioning receipt | `07bd6ce17be1504eb802c130edf5830837b97428c096fa4530c2c3d8f8ac86f0` |
| Independent native add/query log | `81713e4d25530e3259f78682756cc2b65b1145ee213cbd8a17c7a8372ea1699f` |
| All 109 installed dependencies manifest | `01ad1a86dedeb74b704bc65256e834093a6fd75b59f96e54450a75eea0246aee` |
| CPython executable | `081786173866d86cda1b06aa671848217fa0d635edb6dcd2218644466f4229cd` |
| Chroma Rust binding | `43e00b2792bf31bac0eabc85b9bd7b06095db4c61c0cdac25246ed5852623dd5` |
| ONNX Runtime Python binding | `7bae3cc7128be0692a06eecca5f6a3b21fcbbd107938552a89e930cd9f2684ab` |
| Portable Bun 1.4.4 executable | `cb1d8e6564e655e49d30cead359750a1cbbd12f42651caa4b62244d7bd93c244` |
| Pinned claude-mem worker script | `2f82b53623dd23a08a858007a999501cf6e628c69fa5dc7bc0f5a088c61284de` |

| Default pretrained asset | SHA-256 |
|---|---|
| `config.json` | `b567c7d5a55b636c95186aaf993f9a8920842b7e05a9e703e68b23cab2c3a670` |
| `model.onnx` | `4f148ba8ae9c2c7fbee4af2b132db8d06c6a6545b47fc83bbb98c3d22b8393e6` |
| `special_tokens_map.json` | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `tokenizer_config.json` | `7702051bbc4953b94d47fa1d61b42ed4cbb3c71b501a8dd7183a823f8bea1f20` |
| `tokenizer.json` | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` |
| `vocab.txt` | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |

The focused adapter suite passes after this change, including the six-file allowlist, absence of database copying and refusal to overwrite an existing profile cache. The original blocked build artifact remains untouched.

## Native observer follow-up — 9 November 2026

The [fourth experiment](benchmarks/2026-11-09-native-audit-v3-result.md) reached
claude-mem's native observer for the first time. Worker and semantic health were
ready, but the benchmark cost wrapper rejected the SDK's `--model=haiku` syntax:
it recognized only split `--model haiku`. Two launches were refused before any
observer reservation or model call. Correct Haiku/Sonnet tier settings remained
in place. This is an adapter compatibility failure, not a competitor loss.

The [repair](https://github.com/dahshanlabs/klypix-mcp/commit/a5d5a9777a72e28f0d94a0971fd40eba8dad761c)
accepts both argument forms, forwards the native arguments unchanged and rejects
ambiguous/missing model or output-format options and injected budget flags.
Focused tests and 16 cases through the actual Bun-compiled proxy passed without
credentials or paid calls. Proof receipt SHA-256:
`e47783b380f0016a849b78e4981b811cd1b0bfa07a200197d2461a3c3307bd8e`.

Before another complete comparison, require a separate native automatic-capture
and cross-session retrieval probe with all observer costs settled in the original
$50 ledger. Manual `save_memory`, an empty queue or a healthy process alone do
not satisfy it. Model defaults, permissions, scenarios and pass marks stay unchanged.
