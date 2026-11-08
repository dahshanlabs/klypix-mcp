# Pre-execution setup recovery — 9 November 2026

Recorded in Asia/Riyadh local time (8 November UTC). No paid comparison call has
run. This amends setup preparation only; the published pass marks, tasks, models,
condition order and scoring rules remain unchanged.

The [previous setup failure](2026-11-08-setup-result.md) remains part of the
record. It was not a claude-mem performance loss and is not replaced by this check.

## What changed

The earlier setup probes put persistent data and Python dependencies on E:.
During diagnosis that disk had a queue of about 30; C: had a queue of zero.
Equivalent fresh persistent-database checks took about 24–27 seconds on E: and
2.8–2.9 seconds on C:. Imports, database startup and the first embedding query
could accumulate enough delay to exceed the bounded setup deadlines.

Use task-owned C: temporary directories for the dependency cache and fresh
profiles. The registered runner already creates all five conditions' trial
repositories and homes under the system temporary directory on C:. Result files
and the single shared budget ledger remain at their registered locations.

The adapter can copy only the six pretrained files belonging to the genuine
default `all-MiniLM-L6-v2` model into a new profile's native cache. It records their
SHA-256 hashes and refuses to overwrite existing files. No database, vector index,
observation, session, retrieved answer or benchmark fact crosses trial profiles.
If the complete cache is unavailable, native downloading remains enabled.

These changes preserve claude-mem 15.12.0, Chroma MCP 0.2.6, ChromaDB 1.5.9,
managed Python 3.13.14, the default embedding model, native capture/recall hooks,
Haiku/Sonnet tiers, My Work and fallback behavior. No memory feature was disabled,
no model was replaced with a cheaper one, and keyword fallback is still rejected.

## Verification

An independent native Chroma MCP check used a fresh C: database and only the
default pretrained model cache. It initialized, created a collection, embedded
two documents and returned the wildlife document for a paraphrased question in
22.1 seconds. This validates real local vector write/query, not merely an HTTP
status, live process or successful dependency installation.

The complete claude-mem worker then passed in a fresh isolated profile. Its
shipped `save_memory` tool stored two synthetic records; its shipped `search`
tool returned only the wildlife record for the paraphrase above. The deep Chroma
health check confirmed a semantic round-trip in 280 ms, dependency health was
nondegraded, and the worker stopped cleanly. This proof had no model credentials
and made zero model calls. The original receipt SHA-256 is
`e009acc137f63c78bbd2f3067de8f62a87387e9e11d528221742134f2a256e29`.
The [public proof receipt](2026-11-09-semantic-setup-proof.json) retains the
synthetic tool results and health evidence while removing local process/profile
identifiers.

The [setup audit](../claude-mem-setup-audit-2026-11-08.md) records the prior
failures, the corrected diagnostic helper, exact dependency and pretrained-model
hashes, and the verification limits. Semantic setup readiness does not establish
successful paid capture or a comparative score; those remain to be measured.

## Claude Code compatibility

The initially installed Claude Code 2.1.226 predates the vendor's documented
requirements for the already-registered models. Anthropic requires at least
2.1.284 for Sonnet 5.5 and recommends at least 2.1.293 for Haiku 5.5
([model configuration](https://code.claude.com/docs/en/model-config)).
Before paid execution, all five arms will use the same compatible, privately
installed CLI, including claude-mem's observer. The user's global installation
is unchanged. This corrects host compatibility; it does not change either
registered model or the competitor's background model tiers.

The private copy is Claude Code **2.1.319**, from the official
`@anthropic-ai/claude-code-win32-x64@2.1.319` npm package, with verified package
integrity. Executable SHA-256:
`2e055732c9d03d22700d9046251a8370b673607bfcc9e4d16a1b0e8fb1345cbd`.
Local preflight confirms this executable is selected, supports the dollar cap,
and reports authenticated `claude.ai` / `firstParty` access. No model call was
used for that check. Its built-in catalog recognizes both registered 5.5 models
and their current pricing tiers.

The [source freeze](2026-11-09-source-freeze.json) records committed builds,
working-file hashes, executable provenance and the unchanged 30-cell run plan.

## Unchanged experiment

The five arms remain released KLYPIX, experimental KLYPIX, AI-maintained notes,
the same notes with a simple change-notification hook, and claude-mem. All
foreground sessions, including notes maintenance, use `claude-haiku-5-5` at
medium effort. The native claude-mem observer retains its own default model tiers,
whose usage is included in total cost.

The registered 25 early-change trials and five seven-session personal-memory
replays are unchanged. The continuation gate still requires at least 30% fewer
stale code revisions, no final-accuracy regression and at most 10% extra total
model cost versus the strongest notes control. Personal recall still requires
at least 7/8 supported correct answers and zero unsupported factual claims.

All calls, including background processing and any debug attempts, share the
same $50 cap. Preserve every first attempt, loss, tie, setup failure and budget
stop. Incomplete data or a zero-rework baseline cannot establish an advantage.
