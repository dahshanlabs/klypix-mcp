# Competitors run — 2026-11-08 (KLYPIX vs Concord vs MCP Agent Mail)

> **Configuration interpretation:** these results describe the pinned setups below, not
> every installation of each product. In particular, Concord's plugin/live host delivery
> was not enabled. Concord documents live delivery integrations, so an S6 failure here
> does not establish that the product cannot push messages. S9 describes continuation
> from an unrecorded prompt in these setups, not a ranking against session-memory tools
> such as claude-mem or Entire, which were not run. Raw results and grades are unchanged.
> See the [comparison scope](../../../docs/comparison.md) for the broader evaluation set.

> **Read this first.** Claude Code ran at **n = 4 per cell, not the planned 5**: at the measured
> $0.51 per run, the fifth pass (~$22) would have taken the run past its ~$100 budget, so it was
> stopped after pass 4 ($88.99 spent). The bench's own report marks every n < 5 cell as "not a
> ranking" (its banner is kept verbatim below). The differences listed here clear the bench's
> difference rule (95% Wilson intervals that do not overlap: 4/4 is 51–100%, 0/4 is 0–49%), but they
> are not yet at the n the bench asks before a number is quoted as a ranking. The fifth pass is one
> command away and continues this same experiment (see "Reproduce"). Codex ran at **n = 3** on four
> scenarios; none of its cells separates. Every run is listed, losses included; **no run was invalid**.

## Results in plain words

Only differences whose 95% intervals do not overlap are called; everything else is a tie at this
sample size (a tie is not proof of equivalence). "Notes kept" = the other session tidied
AGENTS.md / CLAUDE.md by hand, the generous upper bar; "none" = nobody wrote anything down.

**Claude Code (n = 4 per cell)**

| Scenario | none | notes kept | KLYPIX | Concord | Agent Mail | Clear differences |
|---|---|---|---|---|---|---|
| S1 A decision changed today | 0/4 | 4/4 | 4/4 | 3/4 | 0/4 | KLYPIX and notes kept beat none and Agent Mail. Concord ties everyone |
| S2 Two sessions on overlapping work | 0/4 | 4/4 | 0/4 | 0/4 | 0/4 | **Notes kept beats every channel, KLYPIX included** (a KLYPIX loss). All three channels delivered the peer and its "merge a/currency first" note; the agents declined to merge and told the human (handled 4/4 KLYPIX, 4/4 Concord, 2/4 Agent Mail) |
| S3 A note left by a session that has ended | 0/4 | 4/4 | 4/4 | 4/4 | 2/4 | KLYPIX, Concord and notes kept beat none. Agent Mail ties everyone (it passed exactly the 2 runs in which the agent opened its inbox) |
| S5 A WIP note that outlived its session | 0/4 | 4/4 | 4/4 | 0/4 | 0/4 | KLYPIX and notes kept beat none, Concord and Agent Mail. Concord (stale claim) and Agent Mail (expired lease) both showed the session was gone; the agents still obeyed the dead note |
| S5b "Hands off" note whose work is finished (held out) | 0/4 | 4/4 | 4/4 | 0/4 | 0/4 | Same as S5: KLYPIX and notes kept beat none, Concord and Agent Mail |
| S5c Same note, still valid _(harm check)_ | 4/4 | n/a | 4/4 | 4/4 | 4/4 | Tie: no channel caused harm |
| S6 A decision made while the agent is working | 0/4 | 3/4 | 4/4 | 0/4 | 0/4 | KLYPIX beats none, Concord and Agent Mail. Notes kept ties everyone. Concord's record + prompt and Agent Mail's mail both landed (read back), but no live push was enabled in these configurations: after their first write the Agent Mail agents never re-read their inbox, and the Concord agents looked only at their own message or task, never again at the other session's task, where the decision was recorded (all 8 transcripts checked) |
| S9 Continue the work a stopped session left | 0/4 | 4/4 | 4/4 | 0/4 | 0/4 | KLYPIX and notes kept beat none, Concord and Agent Mail. The tested Concord/Agent Mail stores contained no stopped-session prompt or reply; only a claim or expired lease remained |
| S10 A live session that has written nothing | 1/4 | 4/4 | 3/4 | 4/4 | 4/4 | Tie: every interval overlaps. All three channels showed the live peer on lib/tax.js |

**Codex (n = 3 per cell; S1, S3, S9, S10; KLYPIX, Concord, Agent Mail only)**

| Scenario | KLYPIX | Concord | Agent Mail | Clear differences |
|---|---|---|---|---|
| S1 A decision changed today | 3/3 | 0/3 | 2/3 | none (KLYPIX vs Concord is 44–100% vs 0–56%, which overlap) |
| S3 A note left by a session that has ended | 3/3 | 0/3 | 3/3 | none |
| S9 Continue the work a stopped session left | 3/3 | 0/3 | 0/3 | none (the tested Concord/Agent Mail stores contained no stopped-session prompt or reply, as above) |
| S10 A live session that has written nothing | 0/3 | 0/3 | 0/3 | none: all three fail |

Under Codex, Concord's agent called `start_work` / `finish_work` and never `inspect_work` in S1 and
S3, so it never saw the other session's task; Agent Mail's agent read its inbox in every run.

## What ran

- **Claude Code** 2.1.226, model pinned `opus[1m]` (rows record `claude-opus-5[1m]` with
  `claude-haiku-4-5-20251001` for Claude Code's own side calls), per-run budget cap $2, timeout
  600 s. Scenarios S1, S2, S3, S5, S5b, S5c, S6, S9, S10 × conditions `none`, `agents-md-kept`,
  `klypix`, `concord`, `agent-mail`; the plan was n = 5 and passes 1–4 ran (seeded shuffle 20261108,
  run-major, three parallel shards of one experiment). 176 runs, 4 n/a rows (S5c × notes kept),
  0 invalid, 0 agent errors. Experiment `4a55efd3aaab…f7cf60`, harness `e563316fa5c9…`. Ran
  2026-11-08 11:44–13:14 UTC.
- **Codex** codex-cli 0.153.4, model pinned `gpt-6-astra`, effort the model's default,
  `windows.sandbox="elevated"` (the harness's Windows setting), timeout 600 s. S1, S3, S9, S10 ×
  `klypix`, `concord`, `agent-mail`, n = 3, two shards. 36 runs, 0 invalid, 0 errors. Experiment
  `ca37cb1439fd…761fff`. Codex loads the user's global AGENTS.md (fingerprint `5758579bf42c`, it
  carries a KLYPIX rules block — inert where there is no `brain.klypix`; rounds 1–3 ran the same
  way).
- **Channels**: klypix-mcp **1.112.0** @ 5156221 (clean; MCP server in plugin mode + AGENTS.md rules,
  no hooks); Concord MCP **0.20.0** (server + `concord setup`'s instruction blocks, no plugin);
  MCP Agent Mail **0.3.40** (Rust rewrite, Windows x64 release binary; `am serve-http` per run, its
  own `am docs insert-blurbs` text in CLAUDE.md and AGENTS.md, plus the bench's one seat line).
- **Spend**: Claude **$88.74** for the 176 measured runs, plus $0.25 for one smoke run before the
  batch = **$88.99**. Codex **14,143,723 tokens** for the 36 runs, plus 355,124 for one smoke run =
  **14,498,847 tokens** (Codex reports tokens, not dollars). Smoke runs are not in the results.
- Transcripts (each agent's raw stream) are kept outside the repository, on the machine that ran
  them, at `E:/tmp/cobench-competitors/transcripts/2026-11-08-competitors-{claude,codex}/`.

## How to read the Agent Mail and Concord cells

- **Agent Mail's seat is the bench's reading of the product.** Agent Mail delivers to named mailboxes
  only, refuses an unregistered recipient and `broadcast`, and does not hand its project mailbox to an
  agent that registers later. So the bench pre-registers the agent's mailbox (`BlueLake`) and tells
  the agent its name in one line after Agent Mail's own blurb: a team that gives each seat a fixed
  Agent Mail name. It is the only documented route by which an ended session's note reaches a later
  one. Under Claude, the agent never opened Agent Mail at all in S1 (0/4 consulted) and in 2 of 4 S3
  runs; it read Agent Mail's blurb, which sits at the end of CLAUDE.md after the project notes.
- **Agent Mail's stopped sessions read too fresh.** Their lease is expired by Agent Mail's own 60 s
  minimum ttl (the bench waited 60–61 s for it in every S5 / S5b / S5c / S9 run; nothing was
  released by hand), but Agent Mail stamps "now", so `list_agents` shows the stopped session as active
  about a minute ago, not two days or five hours ago. Rows carry `agentMail.endedActorAgeDistorted`.
- **Concord** is configured as in the 2026-11-08 pilot (see the README): a finished session's task is
  left review-ready, a stopped session's claim goes stale under Concord's own presence rules, the
  live prompt has no endpoint without Concord's plugin and Concord's first tool result says so.
- **S9 had no stopped-session prompt or reply in the tested Concord or Agent Mail stores.**
  That is a limitation of these configurations; session-memory alternatives were not run.
- **S5 / S5b**: the knowledge is an absence (nobody holds the file any more). Concord flags the claim
  as stale, Agent Mail shows the lease expired; KLYPIX's empty lane and its stopped-session evidence
  are what beat the dead note here (klypix-mcp 1.112.0; round 3's older build lost S5 0/5).

## Invalid runs (excluded from every rate)

- None: 0 of 176 Claude runs, 0 of 36 Codex runs.

## n/a and not measured

- **n/a cells** (never run): S5c × notes kept — a tidy notes file keeps a true note, identical to no
  channel. S4 (control), S7 (no faithful Concord / Agent Mail shape for a six-month log) and S8
  (calibration) were not part of this run; S9s is identical to S9 for both third-party channels.
- **Codex** ran only the four scenarios and three channel conditions above (no `none` / notes kept
  cells for Codex in this run).
- **Not measured**: Claude Code cross-session messaging; OpenMemory; **Clash** — a Claude Code hook
  that detects cross-worktree conflicts and keeps no memory, so only S2 / S10-type scenarios could
  apply, and no adapter exists; **Agent-MCP** — no adapter exists. KLYPIX's hooks (`klypix-installed`)
  were not part of this run.

## Reproduce

```bash
# Pinned installs (see bench/coordination/README.md), then for each shard i of 3:
KLYPIX_BENCH_CONCORD_DIR=<concord 0.20.0 dir> KLYPIX_BENCH_AGENT_MAIL_DIR=<agent mail 0.3.40 dir> \
node bench/coordination/run.mjs --live --yes --agent claude --claude-model 'opus[1m]' --max-budget 2 \
  --scenario s1,s2,s3,s5,s5b,s5c,s6,s9,s10 --condition none,agents-md-kept,klypix,concord,agent-mail \
  --runs 5 --timeout 600 --shuffle 20261108 --run-major --shard i/3 --up-to-run 4 \
  --transcripts <dir> --out claude-shard-i.jsonl
# The fifth pass: the same command with --resume and without --up-to-run (same experiment identity).
# Codex: --agent codex --codex-model gpt-6-astra --scenario s1,s3,s9,s10 --condition klypix,concord,agent-mail
#        --runs 3 --timeout 600 --shuffle 20261108 --run-major --shard i/2
node bench/coordination/report.mjs 2026-11-08-competitors.jsonl
node bench/coordination/summary.mjs 2026-11-08-competitors.summary.json 2026-11-08-competitors.jsonl 2026-11-08-competitors-codex.jsonl --plain
```

The machine-readable twin of these tables is
[`2026-11-08-competitors.summary.json`](2026-11-08-competitors.summary.json).

## Harness report — Claude Code (report.mjs, verbatim)

# KLYPIX coordination bench — results

Experiment: `4a55efd3aaabc7ec26c2b8db034da2ad56cb70af93989707171d636a06f7cf60`

## Agent: claude

CLI: 2.1.226 (Claude Code) · model: claude-haiku-4-5-20251001+claude-opus-5[1m]

Channel servers — klypix: klypix-mcp 1.112.0 @ 5156221 · agent-mail: agent-mail 0.3.40 · concord: concord 0.20.0

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted channel (MCP) | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.22 | 0.5 |
| A decision changed today | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | — | $0.22 | 0.5 |
| A decision changed today | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.43 | 0.8 |
| A decision changed today | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 75% (30%–95%) | 1/4 | 0.0 | 4/4 | — | $0.50 | 1.3 |
| A decision changed today | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 0/4 | — | $0.27 | 0.5 |
| Two sessions on overlapping work | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | 0/4 | $0.20 | 0.4 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | 4/4 | $0.29 | 0.8 |
| Two sessions on overlapping work | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | 4/4 | $0.64 | 1.3 |
| Two sessions on overlapping work | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | 4/4 | $0.59 | 1.5 |
| Two sessions on overlapping work | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 2/4 | 2/4 | $0.41 | 0.8 |
| A note left by a session that has ended | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.23 | 0.5 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | — | $0.24 | 0.5 |
| A note left by a session that has ended | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.45 | 0.8 |
| A note left by a session that has ended | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.56 | 1.2 |
| A note left by a session that has ended | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 50% (15%–85%) | 2/4 | 0.0 | 2/4 | — | $0.33 | 0.6 |
| A WIP note that outlived its session | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.24 | 0.6 |
| A WIP note that outlived its session | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | — | $0.25 | 0.6 |
| A WIP note that outlived its session | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.51 | 0.9 |
| A WIP note that outlived its session | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | — | $0.52 | 1.2 |
| A WIP note that outlived its session | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | — | $0.57 | 1.2 |
| A decision made while the agent is working | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.43 | 1.2 |
| A decision made while the agent is working | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 75% (30%–95%) | 1/4 | 0.0 | — | 3/4 | $0.49 | 1.4 |
| A decision made while the agent is working | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | 4/4 | $1.23 | 2.7 |
| A decision made while the agent is working | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | 4/4 | $0.92 | 2.3 |
| A decision made while the agent is working | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | 2/4 | $0.90 | 2.3 |
| A "hands off" note whose work is finished (held out) | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.27 | 0.7 |
| A "hands off" note whose work is finished (held out) | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | — | $0.32 | 0.9 |
| A "hands off" note whose work is finished (held out) | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.73 | 1.6 |
| A "hands off" note whose work is finished (held out) | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | — | $0.58 | 1.4 |
| A "hands off" note whose work is finished (held out) | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | — | $0.47 | 1.1 |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | No shared channel | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | 4/4 | $0.26 | 0.7 |
| A "hands off" note whose work is still in progress (held out) | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | — | n/a: a tidy notes file keeps a true note — identical to the no-channel condition | — | — | — | — | — | — |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 3/4 | 4/4 | $0.63 | 1.4 |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | 4/4 | $0.64 | 1.6 |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | 4/4 | $0.64 | 1.4 |
| Continue the work a stopped session left | No shared channel | 4 | 0% (0%–49%) | 4/4 | 0.0 | — | — | $0.43 | 1.3 |
| Continue the work a stopped session left | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | — | $0.45 | 1.1 |
| Continue the work a stopped session left | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | — | $0.96 | 2.2 |
| Continue the work a stopped session left | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 4/4 | — | $1.05 | 3.0 |
| Continue the work a stopped session left | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 0% (0%–49%) | 4/4 | 0.0 | 3/4 | — | $0.72 | 1.9 |
| A live session that has written nothing | No shared channel | 4 | 25% (5%–70%) | 3/4 | 0.0 | — | 1/4 | $0.24 | 0.7 |
| A live session that has written nothing | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 4 | 100% (51%–100%) | 0/4 | 0.0 | — | 4/4 | $0.24 | 0.6 |
| A live session that has written nothing | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 4 | 75% (30%–95%) | 1/4 | 0.0 | 3/4 | 3/4 | $0.75 | 1.5 |
| A live session that has written nothing | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | 4/4 | $0.55 | 1.4 |
| A live session that has written nothing | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 4 | 100% (51%–100%) | 0/4 | 0.0 | 4/4 | 4/4 | $0.70 | 1.6 |

> **Pilot-sized cells — not a ranking.** 44 cell(s) above have n < 5 (n=4). They show that the harness ran each cell end to end, never how the conditions compare; a single run's interval spans most of 0–100%. Publish none of them as a ranking.

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- A decision changed today: KLYPIX ahead of none — 100% vs 0%
- A decision changed today: KLYPIX ahead of agent-mail — 100% vs 0%
- Two sessions on overlapping work: KLYPIX BEHIND agents-md-kept — 0% vs 100%
- A note left by a session that has ended: KLYPIX ahead of none — 100% vs 0%
- A WIP note that outlived its session: KLYPIX ahead of agent-mail — 100% vs 0%
- A WIP note that outlived its session: KLYPIX ahead of concord — 100% vs 0%
- A WIP note that outlived its session: KLYPIX ahead of none — 100% vs 0%
- A decision made while the agent is working: KLYPIX ahead of concord — 100% vs 0%
- A decision made while the agent is working: KLYPIX ahead of agent-mail — 100% vs 0%
- A decision made while the agent is working: KLYPIX ahead of none — 100% vs 0%
- A "hands off" note whose work is finished (held out): KLYPIX ahead of concord — 100% vs 0%
- A "hands off" note whose work is finished (held out): KLYPIX ahead of agent-mail — 100% vs 0%
- A "hands off" note whose work is finished (held out): KLYPIX ahead of none — 100% vs 0%
- Continue the work a stopped session left: KLYPIX ahead of concord — 100% vs 0%
- Continue the work a stopped session left: KLYPIX ahead of agent-mail — 100% vs 0%
- Continue the work a stopped session left: KLYPIX ahead of none — 100% vs 0%

## Not measured

- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Clash (Claude Code hook)** — a Claude Code hook that detects cross-worktree conflicts and keeps no memory, so only the overlapping-work scenarios (S2, S10) could apply, and no adapter exists
- **Agent-MCP** — no adapter exists; nothing is measured until one is verified against a pinned version

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._

## Harness report — Codex (report.mjs, verbatim)

# KLYPIX coordination bench — results

Experiment: `ca37cb1439fd63d63201369538a7e8034a6bfc48bd5db65d6787d8cc8d761fff`

## Agent: codex

CLI: codex-cli 0.153.4 · model: gpt-6-astra

Channel servers — agent-mail: agent-mail 0.3.40 · concord: concord 0.20.0 · klypix: klypix-mcp 1.112.0 @ 5156221

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted channel (MCP) | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 3 | 100% (44%–100%) | 0/3 | 0.0 | 3/3 | — | — | 1.1 |
| A decision changed today | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 3 | 0% (0%–56%) | 3/3 | 0.0 | 3/3 | — | — | 1.0 |
| A decision changed today | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 3 | 67% (21%–94%) | 1/3 | 0.0 | 3/3 | — | — | 1.1 |
| A note left by a session that has ended | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 3 | 100% (44%–100%) | 0/3 | 0.0 | 3/3 | — | — | 1.1 |
| A note left by a session that has ended | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 3 | 0% (0%–56%) | 3/3 | 0.0 | 3/3 | — | — | 0.9 |
| A note left by a session that has ended | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 3 | 100% (44%–100%) | 0/3 | 0.0 | 3/3 | — | — | 1.3 |
| Continue the work a stopped session left | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 3 | 100% (44%–100%) | 0/3 | 0.0 | 3/3 | — | — | 1.8 |
| Continue the work a stopped session left | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 3 | 0% (0%–56%) | 1/3 | 0.0 | 3/3 | — | — | 2.8 |
| Continue the work a stopped session left | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 3 | 0% (0%–56%) | 2/3 | 0.0 | 3/3 | — | — | 2.4 |
| A live session that has written nothing | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 3 | 0% (0%–56%) | 3/3 | 0.0 | 3/3 | 0/3 | — | 1.3 |
| A live session that has written nothing | Concord MCP 0.20.0 (server + its instruction blocks, no plugin) | 3 | 0% (0%–56%) | 3/3 | 0.0 | 3/3 | 0/3 | — | 1.3 |
| A live session that has written nothing | MCP Agent Mail 0.3.40 (server + its AGENTS.md blurb; a named seat mailbox) | 3 | 0% (0%–56%) | 0/3 | 0.0 | 3/3 | 3/3 | — | 1.9 |

> **Pilot-sized cells — not a ranking.** 12 cell(s) above have n < 5 (n=3). They show that the harness ran each cell end to end, never how the conditions compare; a single run's interval spans most of 0–100%. Publish none of them as a ranking.

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- none at this sample size — overlapping intervals do not establish equivalence.

## Not measured

- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Clash (Claude Code hook)** — a Claude Code hook that detects cross-worktree conflicts and keeps no memory, so only the overlapping-work scenarios (S2, S10) could apply, and no adapter exists
- **Agent-MCP** — no adapter exists; nothing is measured until one is verified against a pinned version

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._
