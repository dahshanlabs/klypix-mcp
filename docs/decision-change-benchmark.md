# Decision changes and personal continuity: preregistered pilot

This developer-authored, same-computer pilot measures a specific correctness problem: an agent reads an accepted project decision, that decision changes during its work, and its code should follow the current decision. A separate personal-memory block gives automatic memory a case suited to its purpose. This is not a general memory ranking, cross-vendor benchmark or two-computer team test.

**Execution record:** the [first run](benchmarks/2026-11-09-interrupted-run.md), [second run](benchmarks/2026-11-09-native-audit-v1-result.md), [third run](benchmarks/2026-11-09-native-audit-v2-result.md) and [fourth run](benchmarks/2026-11-09-native-audit-v3-result.md) are published with all nine attempts retained. The fourth run has valid passes for a notes control, one prototype correction case and AI-kept notes' personal replay (8/8 supported answers). It stopped because the benchmark wrapper rejected claude-mem's native model-option syntax before automatic capture could run. This is a setup failure, not a competitor loss. Total known API-equivalent usage is $0.16204134; no comparative winner is established. The tasks, permissions and pass marks below remain unchanged. Publish all attempts, including ties, KLYPIX losses and budget stops.

## Conditions and planned blocks

The revised early-boundary block has five conditions, three repetitions of a changed-decision case and one repetition of each of two controls: **25 planned trials**. The separate personal-memory block adds **five seven-session replays**, one per condition. These do not replace the early-change trials. The total plan is 110 foreground model sessions plus native observer work. The shared $50 cap may prevent completion; completion is not promised.

| Condition | Configuration |
|---|---|
| AI-maintained notes/native | One canonical CLAUDE.md, written and maintained by the same foreground model; AGENTS.md only points to it. Read at task start, maintain changed decisions, re-read before completion; native persistence stays on |
| AI-maintained notes + notification | Identical notes rule plus a simple per-session SHA-256 check of the whole notes files at native tool boundaries; generic notice asks the agent to re-read |
| Released KLYPIX | Pinned released source fingerprint; core MCP, generated project rules and source-native Claude installer hooks |
| KLYPIX prototype | Decision-change branch with the same MCP/hook configuration as the released arm |
| claude-mem | Version 15.12.0 local worker, documented Anthropic-plan setup, shipped native capture/recall handlers and mem-search skill |

Both KLYPIX arms use the installer's same hook events, matchers and arguments and the actual native session identity, without a fabricated session override. Their desktop bridge and updater are isolated/disabled; neither gets a semantic-model installation in this pilot. This is not a comparison of every product's richest configuration. claude-mem retains its documented native capture, context injection, search skill and local provider path.

The notes file is AI-maintained, not a perfect file edited by the harness or a human. Its final re-read may catch the correction; a tie is informative. The notification control does not know which text matters: it also notices unrelated changes and the agent's own edits. Its message contains no policy or expected answer. Policy maintenance is not duplicated in AGENTS.md.

## Early-change procedure

The cases are an invoice-rounding correction, an unchanged-policy reaffirmation and an unrelated transport-logging update. Hidden tests distinguish per-line from combined-subtotal rounding and check that shipping code remains intact.

Each trial uses an initial producer, one continuing consumer and an update producer. All policy text is written by the real producer through normal memory operations. The consumer reads the effective policy through its configured integration, then a neutral checkpoint pauses it before edits. The update producer changes or reaffirms the decision; it cannot edit implementation/tests or directly message the consumer. The checkpoint returns no policy.

After capture finishes, every condition receives the same instruction to inspect the implementation with a harmless shell read, then continue its normal workflow. This gives native hooks a boundary before a later edit. An advisory hook does not cancel a tool already selected by the model. No KLYPIX-only extra sync is forced.

Initial exposure requires an actual delivered tool response or successful native context-injection output addressed to the consumer session. A self-reported read, harness database query or tool-call count is insufficient. The fixture-specific parser accepts paraphrases of per-line rounding and retains raw served text/source. If an observed normal memory retrieval fails to return the required old policy, retain **initial-policy-not-retrieved** as a measured retrieval failure in the denominator; no causal update measurement follows. Missing or unauditable delivery traces instead remain **exposure-unverified / not measured**, not proof that a product lacks the capability.

The fixed barrier makes change timing observable. It does not measure natural incidence or remote transport reliability. The prototype checks served revisions at supported native tool boundaries and brain_sync; it does not interrupt running commands or prove uptake. See [the feature boundaries](decision-watch.md).

The earlier `preliminary-sync-v1` design remains selectable for diagnostic work: four conditions, MCP-only KLYPIX and no required post-barrier shell read. It was an **unexecuted exploratory design**, not an earlier result. Do not pool it with revised `early-boundary-v2` results or silently relabel either.

## Separate personal-memory replay

Each condition retains the same fresh isolated project, native profile and memory store over seven real sessions: six chronological capture sessions, then one recall session containing eight fixed paraphrased questions. Narrative labels are “simulated day 1” through “simulated day 6”. No clock, file mtime or database timestamp is altered. This does **not** establish actual multi-day retention.

The fictional Larch project accumulates a review owner, runtime/package choices, import/export decisions and diagnostic retention. Later sessions change three decisions and add unrelated details. Final questions cover current facts, an explicitly superseded historical choice and an unsaved hosting choice for which abstention is required. Producers use normal capture; the harness never writes their memory. Notes receive the same instruction to preserve brief labeled history of explicitly replaced choices.

The final prompt contains questions and an answer schema, never expected answers or previous session text. Every condition must explicitly verify its cited source through a normal retrieval tool in the final session, even if a source was automatically supplied at startup. Opening the cited notes file qualifies; a memory tool can verify several answers in one response. Native context injection alone does not satisfy this block's verification rule. This is a **retrieval-assisted recall** condition, not natural unsolicited recall; its extra retrieval cost is included for every arm. A correct unsupported guess does not establish recall.

Keep the deterministic grader and raw answers/sources for audit. Equivalent concise answers are accepted; contradictory current/old values are rejected. These are **five replays with eight correlated answers each**, not 40 independent trials. The case is suited to personal memory without requiring a specific product to win.

## Published pass marks

- **Early-change functional pass per condition:** all three changed-decision repetitions and both controls finish with correct current-policy code and untouched unrelated shipping behavior. A claimed invoice-decision alert in an unchanged/unrelated control fails that harm check. A generic notes-file change notice is counted as notification burden, not relabeled an invoice-policy claim.
- **Personal replay pass:** at least **7/8 source-supported correct answers**, **zero unsupported claims**, and all seven sessions completed. A wrong/stale factual value or asserted known value without served source support is unsupported. Abstention on a known fact is incorrect but is not an invented claim. The unsaved hosting question must be answered unknown.
- **Continue the feature:** at least **30% fewer stale-policy-correct code revisions** than the strongest notes control, **no final-accuracy regression**, and **no more than 10% extra total model cost**, including all producers, consumer and observer. The strongest notes control is selected by final correctness, then fewer stale revisions, then lower total cost. Compare complete matched early-change cells. A zero-rework baseline makes the denominator undefined: report **no demonstrated advantage**, never an infinite improvement. Missing/capped cells cannot establish the gate.

“Rework” means stale-policy-correct code revisions observed at completed tool boundaries. It does not mean minutes, hidden reasoning or every intermediate write. Read-only telemetry records source snapshots during work; their grading runs after the consumer exits in a separate temporary directory. Ungradable historical revisions make the rework comparison ineligible; their stale count is null, not zero. Hidden grader files and expected answers never enter the active repository/context. Report first observed revision correctness, stale revisions, later repair, notice timing and duplicate/unrelated notices separately from final correctness. Notice latency is measured from producer/capture completion, not an inferred exact memory-write time.

The seeded plan rotates condition order across cases/repetitions and interleaves the two blocks. Record its exact order before calls. Preserve setup, exposure-unverified, stalled, budget-limited, measured-failure and not-started rows with their costs. Do not merge these into a flattering denominator. Capture/retrieval omissions after functioning setup remain product failures; unverified delivery remains a measurement limitation.

Even complete results cannot establish statistical significance, a broad ranking, a moat or a 100x advantage. Publish KLYPIX losses and all controls. A rerun never replaces an unfavorable first attempt. Dated protocol amendments must be published before new calls; exploratory follow-ups stay separate.

## Native integration and isolation

The claude-mem adapter reads the pinned package into a fresh trial home and resolves its native hook launchers locally. The supported worker uses portable Bun; no global install or PATH change is performed. Installer-only hooks are omitted because their artifacts are supplied. Native capture/recall logic and the shipped search skill are retained. Hook stdin/stdout passes through unchanged and successful context output is audited. `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES=true` is explicit, although this pilot uses Claude throughout.

Pinned source defaults are retained: observer default/simple/fast Haiku, summary inheriting default, smart Sonnet, tier routing enabled, Chroma/local MiniLM on and per-prompt semantic injection off. The README documents the local Anthropic-plan/headless provider path. Its hosted sign-in/checkout route is not used. Model aliases resolve to pinned current model IDs for repeatable cost accounting. Native readiness, including required semantic dependencies, must be verified before paid work; an incomplete setup is reported, not silently called a successful default installation.

Only authorized OAuth credential material is copied into restricted temporary profiles. Global settings, memories and sessions are never copied. The observer has a separate profile; all temporary credentials are removed. Credentials never enter transcripts or result files. There is no account registration, interactive login or purchase.

## Cost controls

Every producer, consumer, observer, smoke and retry shares one durable **$50 maximum ledger**. Paid calls require root review of guards and the published protocol revision. The observer broker starts disabled; only `start({allowPaid:true})` enables spending. Missing executable cap/accounting prerequisites mean not ready.

Foreground agents use the exact `claude-haiku-5-5` model, same effort/output settings in every arm, including AI-maintained notes. Native claude-mem retains its Haiku/Sonnet tier routing; observer cost is included in the comparison. Its separate model choices are not hidden behind the foreground-model label.

Bounds come from [official model limits](https://platform.claude.com/docs/en/models/overview) and [official pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked 8 November 2026. The full one-million-token context and 128,000-token output bounds are used for reservation safety. Haiku's worst one-hour cache input is $1/million and output $2.50/million; with the 1.1 geography multiplier, one full call costs at most $1.452. At a $0.50 process cap, reserve **$1.96**. Sonnet's corresponding one-call margin is $5.808; reserve **$6.31**. A foreground output request limit is additional protection; the envelope does not depend on it. Native observer output defaults remain intact.

The supported `CLAUDE_CODE_PATH` override points to a transparent local proxy. Before a child starts, it reserves the process cap plus one full-call margin, adds the native CLI budget flag and forwards its stream unchanged. Cumulative cost receipts count once per child. Missing receipts or unfinished termination charge the full reservation and halt spending. Unexpected/unpriced models halt spending. An empty processing queue alone does not prove capture.

A monetary cap is an explicit benchmark constraint. An observer hitting it is a budget-limited diagnostic, not a completed default-product result. A CLI budget flag alone is not a strict aggregate cap; the final call can cross its threshold, hence the reservation margin.

Dollars are **API-equivalent usage reported by the CLI**, conservatively counted against the cap; the actual subscription invoice is unknown. Overruns remain recorded and halt new work. Setup, incomplete runs and retries retain their costs. Each run directory points to the same ledger; a new output folder cannot reset $50.

## Verification and publication

Record model/CLI/product versions, source fingerprints, enabled integrations, prompts, exact plan order, served sources, raw outputs, final code, snapshot grades, hidden tests, intervention, notification timestamps and all costs. Publish the protocol revision first; freeze harness/source fingerprints before paid work and publish the resulting report even if KLYPIX loses.

Deterministic checks: `node bench/decision-change/self-test.mjs`, `node test/decision-change-claude-mem.mjs` and `node test/decision-watch.mjs`. They use fresh temporary fixtures and no paid models. The runner defaults to no paid execution. Historical benchmark reports remain unchanged.

## Why these competitors

GitHub API counts below were checked on 8 November 2026 around 20:10 UTC. They
measure repository popularity, not effectiveness. Capability descriptions come
from primary documentation; they are not hands-on performance findings.

| Project | Stars | Relevant comparison |
|---|---:|---|
| [claude-mem](https://github.com/thedotmack/claude-mem) | 114,831 | Largest direct coding-memory comparison here; capture, summaries, multiple hosts and optional TeamBrain |
| [Mem0](https://github.com/mem0ai/mem0) | 68,640 | Broader memory SDK/platform; compare when building a custom memory integration is the actual alternative |
| [Supermemory](https://github.com/supermemoryai/supermemory) | 31,569 | Direct coding-memory alternative with Claude/Codex plugins and shared repository containers |
| [Beads](https://github.com/gastownhall/beads) | 28,597 | Persistent tasks, dependencies, project facts and messaging in a versioned database |
| [Engram](https://github.com/Gentleman-Programming/engram) | 7,853 | Local project/session memory, conflict surfacing, Git Sync and optional cloud sharing |
| [Entire CLI](https://github.com/entireio/cli) | 5,320 | Git-linked session evidence, resume and separately installed project-memory tooling |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 4,534 | Readable Markdown knowledge and host integrations |
| [Concord](https://github.com/Get-Concord-AI/concord-mcp) | 1,003 | Live communication, claims and handoffs; retain its supported live integration in future coordination comparisons |
| [MCP Agent Mail, Rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) | 238 | Mailboxes, advisory reservations and Git-backed archive |
| [Clash](https://github.com/clash-sh/clash) | 65 | Worktree conflicts rather than general decision memory |

The original Python Agent Mail had 2,234 stars but is deprecated in favor of the
Rust rewrite; their counts must not be combined. The [old OpenMemory MCP/dashboard
is archived](https://github.com/mem0ai/openmemory/blob/main/openmemory-archive/README.md).
The current OpenMemory CLI is a different session import/export product, with
realtime autosync on its roadmap. Neither inherits Mem0's star count.

Supermemory's [Claude integration](https://github.com/supermemoryai/claude-supermemory)
and [Codex integration](https://github.com/supermemoryai/codex-supermemory) are material
future comparisons. No existing authorized credential was available for this
pilot, so it is **not run**, with no account registration or purchase. Engram is
also not measured in this first bounded run. Session capture, team sharing,
cross-tool support and Git portability must not be claimed as exclusive to KLYPIX.

Pinned claude-mem references: [release 15.12.0](https://github.com/thedotmack/claude-mem/releases/tag/v15.12.0),
[native hooks](https://github.com/thedotmack/claude-mem/blob/v15.12.0/plugin/hooks/hooks.json),
[observer provider and cost receipts](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/services/worker/ClaudeProvider.ts),
and [supported settings](https://github.com/thedotmack/claude-mem/blob/v15.12.0/src/shared/SettingsDefaultsManager.ts).
