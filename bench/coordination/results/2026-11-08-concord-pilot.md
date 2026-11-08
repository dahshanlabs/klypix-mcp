# Concord pilot — 2026-11-08 (n = 1 per cell; NOT a ranking)

> **Read this first.** Every cell below has **n = 1**. A single run proves that the adapter, the
> scripted other session, the server and the grader worked end to end for that cell. It says
> nothing about how Concord and KLYPIX compare: one run's 95% interval spans 21–100% (a pass)
> or 0–79% (a fail). **Nothing here may be published as a ranking or quoted as a rate.**

## What ran

- Agent: Claude Code (headless) 2.1.226 (Claude Code), model pinned `opus[1m]` (models recorded per row: claude-haiku-4-5-20251001+claude-opus-5[1m]).
- Conditions: `klypix`, `concord` — exactly these two; no notes-file or no-channel cells in this pilot.
- Scenarios: `s1-changed-decision`, `s3-note-from-closed-session`, `s9-continue-stopped-session`, `s10-live-peer-wrote-nothing`, `s2-overlapping-work`; runs per cell: 1; timeout 600 s; Claude per-run budget cap $2.
- Concord: `@concord-ai/concord-mcp` **0.20.0** (pinned 0.20.0), installed at `E:/tmp/cobench-competitors/concord`; adapter `bench/coordination/conditions-concord.mjs` (MCP server + `concord setup`'s instruction blocks, no plugin, identity via `CONCORD_AGENT_ID`, telemetry off).
- KLYPIX: klypix-mcp **1.111.0** @ 38c3b2d — the `klypix` condition (MCP server in plugin mode + AGENTS.md rules, no hooks).
- Experiment id `2488c91abc3597c55c989f7558baa8faa58ca190badc7da250bbefef224327ce`; harness fingerprint `57762b50981b…`.
- Transcripts (each agent's raw stream-json) were kept outside the repository at `E:/tmp/cobench-competitors/transcripts/2026-11-08-concord-pilot/` on the machine that ran the pilot; the repository does not commit transcripts.
- Wall-clock minutes were measured while the bench self-test (`node test/coordination-bench.mjs`) ran on the same machine; treat the Min column as inflated and do not compare it with other rounds.
- Total recorded cost: **$6.04** over 10 priced run(s); 10 measured, 0 invalid, 0 agent error(s), 0 n/a.

## Every run, one row each

| Scenario | Condition | Verdict | Stale action | Handled | MCP calls | Cost | Turns | Min | Note |
|---|---|---|---|---|---|---|---|---|---|
| s1-changed-decision | klypix | PASS | no | — | brain_sync×2 | $0.37 | 12 | 0.8 |  |
| s1-changed-decision | concord | PASS | no | — | inspect_work×3, start_work×1, finish_work×1 | $0.60 | 17 | 1.6 |  |
| s3-note-from-closed-session | klypix | PASS | no | — | brain_sync×2 | $0.45 | 14 | 0.7 |  |
| s3-note-from-closed-session | concord | PASS | no | — | inspect_work×3, start_work×1, finish_work×1 | $0.44 | 15 | 0.9 |  |
| s9-continue-stopped-session | klypix | PASS | no | — | brain_sync×4, brain_handoff×2, brain_note×1 | $1.06 | 28 | 2.1 |  |
| s9-continue-stopped-session | concord | fail | yes | — | inspect_work×2, transfer_work×3, start_work×2, finish_work×1 | $1.07 | 29 | 3.2 |  |
| s10-live-peer-wrote-nothing | klypix | PASS | no | yes | brain_sync×4, brain_rules×1, brain_message×1 | $0.58 | 18 | 1.3 |  |
| s10-live-peer-wrote-nothing | concord | PASS | no | yes | start_work×1, inspect_work×1, update_work×1, finish_work×1 | $0.47 | 13 | 1.2 |  |
| s2-overlapping-work | klypix | fail | yes | yes | brain_sync×2, brain_message×1, brain_note×1 | $0.61 | 17 | 1.3 |  |
| s2-overlapping-work | concord | fail | yes | yes | start_work×1, inspect_work×1, finish_work×1 | $0.37 | 10 | 0.9 |  |

## Invalid runs (measured nothing about their channel; excluded from every rate)

- none

## Agent errors (counted as errors, never as deference)

- none

## How to read the Concord cells

- S1: the other session's decision is an `update_work` record on its active task; the stale cookie line stays in CLAUDE.md/AGENTS.md (Concord never edits the notes file either). The agent finds the decision only by inspecting that task.
- S2 / S10: the live peer is a `start_work` claim on the file (with its branch); the agent's own `start_work` on that file returns an overlap warning.
- S3: the ended session left its task review-ready with the finding as an update and as handoff evidence (Concord's workspace view lists active and review-ready tasks only — see the README for this reading).
- S9: the stopped session left only its claim (title, files); Concord records no last prompt or reply, so the plan (page sizes) is nowhere in Concord. KLYPIX's record carries the last reply but not the plan either (primary S9).
- "MCP calls" lists which Concord / KLYPIX tools the agent actually called; a cell with none consulted the channel not at all.

## What the single runs showed (from the transcripts; one run each, so anecdotes, not rates)

- **S1 (decision changed today):** both agents found the decision through their channel and wrote the bearer-token logout. Under Concord the agent `inspect_work`ed the other session's active task and quoted its `decision` update; it also noted that CLAUDE.md still said cookies.
- **S3 (note from an ended session):** both passed. Under Concord the agent found the review-ready task and its finding (backfill before `migrate:002`).
- **S9 (continue a stopped session):** KLYPIX passed (default 20, max 50 — the agent read the stopped session's record and the handoff card KLYPIX had drafted from it). Concord failed with a **stale action**: it built pagination with default 50 and max 120 (`pageDefault=50`, `pageCap=120`) — the plan lived in the stopped session's last prompt, which Concord does not record; the agent saw only the stale claim's title and files. It also reported it "could not take over the original Concord task" (owned by the archived agent) and spent three `transfer_work` calls on it.
- **S10 (live peer, wrote nothing):** both passed by the pre-registered rule — the rate is 8% and the overlap was **named to the human** (Concord: "Concord reported an overlap on `lib/tax.js` … a Codex agent holds an active claim … on branch `a/per-line-tax`"; KLYPIX: the live lane row). Neither merged, so both commits conflict with the peer's branch (`collision=true`), which the strict grade would fail; the agents told the human.
- **S2 (two sessions on overlapping work):** both **failed the strict grade with a stale action** and both were **handled**: each agent read the other session's note ("merge `a/currency` first"), **declined** to merge "unfinished work" into the user's branch, and told the human a conflict was coming. The same choice under both channels; the channel delivered, the agent overruled.

Delivery was read back in every run (`delivered = facts` on each row); the agent consulted its channel in 10/10 runs (see MCP calls). None of this is a comparison: one run per cell.

## Harness report (report.mjs, verbatim)

# KLYPIX coordination bench — results

Experiment: `2488c91abc3597c55c989f7558baa8faa58ca190badc7da250bbefef224327ce`

## Agent: claude

CLI: 2.1.226 (Claude Code) · model: claude-haiku-4-5-20251001+claude-opus-5[1m]

Channel servers — klypix: klypix-mcp 1.111.0 @ 38c3b2d · concord: concord 0.20.0

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted channel (MCP) | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | $0.37 | 0.8 |
| A decision changed today | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | $0.60 | 1.6 |
| Two sessions on overlapping work | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 1 | 0% (0%–79%) | 1/1 | 0.0 | 1/1 | 1/1 | $0.61 | 1.3 |
| Two sessions on overlapping work | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 1 | 0% (0%–79%) | 1/1 | 0.0 | 1/1 | 1/1 | $0.37 | 0.9 |
| A note left by a session that has ended | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | $0.45 | 0.7 |
| A note left by a session that has ended | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | $0.44 | 0.9 |
| Continue the work a stopped session left | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | $1.06 | 2.1 |
| Continue the work a stopped session left | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 1 | 0% (0%–79%) | 1/1 | 0.0 | 1/1 | — | $1.07 | 3.2 |
| A live session that has written nothing | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | 1/1 | $0.58 | 1.3 |
| A live session that has written nothing | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | 1/1 | $0.47 | 1.2 |

> **Pilot-sized cells — not a ranking.** 10 cell(s) above have n < 5 (n=1). They show that the harness ran each cell end to end, never how the conditions compare; a single run's interval spans most of 0–100%. Publish none of them as a ranking.

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- none at this sample size — overlapping intervals do not establish equivalence.

## Not measured

- **MCP Agent Mail (Rust rewrite, pinned 0.3.40)** — no verified binary on PATH (KLYPIX_BENCH_AGENT_MAIL_BIN unset); a Windows x64 release asset exists (mcp-agent-mail-x86_64-pc-windows-msvc.zip, v0.3.40; the project calls native Windows unverified); the adapter (register_agent, file_reservation_paths, send_message, fetch_inbox) is a skeleton that has not been verified against the running server, and how a note reaches an agent that has not yet registered a mailbox name is unsettled — no number is published until both are
- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._

