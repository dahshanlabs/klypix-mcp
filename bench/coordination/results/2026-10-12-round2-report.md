# KLYPIX coordination bench — results

## Agent: claude

CLI: 2.1.226 (Claude Code) · model: claude-haiku-4-5-20251001+claude-opus-5[1m], claude-opus-5[1m]+claude-haiku-4-5-20251001

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.18 | 0.5 |
| A decision changed today | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | $0.22 | 0.7 |
| A decision changed today | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.18 | 0.5 |
| A decision changed today | AGENTS.md / CLAUDE.md, appended (stale line kept) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.18 | 0.5 |
| A decision changed today | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 40% (12%–77%) | 3/5 | 0.0 | 2/5 | — | $0.24 | 0.7 |
| Two sessions on overlapping work | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | 0/5 | $0.16 | 0.4 |
| Two sessions on overlapping work | Human copy-paste (meant as upper bound) | 5 | 0% (0%–43%) | 5/5 | 1.0 | — | 5/5 | $0.29 | 1.1 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 80% (38%–96%) | 1/5 | 0.0 | — | 5/5 | $0.31 | 1.0 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| Two sessions on overlapping work | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 5/5 | 5/5 | $0.49 | 1.0 |
| A note left by a session that has ended | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.21 | 0.6 |
| A note left by a session that has ended | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | $0.20 | 0.6 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.21 | 0.6 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A note left by a session that has ended | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.42 | 0.8 |
| A WIP note that outlived its session | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.23 | 0.7 |
| A WIP note that outlived its session | Human copy-paste (meant as upper bound) | 5 | 40% (12%–77%) | 3/5 | 1.0 | — | — | $0.26 | 0.8 |
| A WIP note that outlived its session | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.22 | 0.6 |
| A WIP note that outlived its session | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: nothing to append — the notes file is identical to the no-channel condition | — | — | — | — | — | — |
| A WIP note that outlived its session | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 4/5 | — | $0.46 | 1.1 |
| A decision made while the agent is working | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.39 | 1.4 |
| A decision made while the agent is working | Human copy-paste (meant as upper bound) | — | n/a: a copy-paste at start cannot carry a decision that is made after the agent begins | — | — | — | — | — | — |
| A decision made while the agent is working | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 40% (12%–77%) | 3/5 | 0.0 | — | 2/5 | $0.39 | 1.4 |
| A decision made while the agent is working | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A decision made while the agent is working | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | 5/5 | $1.29 | 3.8 |
| A decision buried in six months of notes | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.58 | 1.2 |
| A decision buried in six months of notes | Human copy-paste (meant as upper bound) | 5 | 0% (0%–43%) | 5/5 | 1.0 | — | — | $0.56 | 1.3 |
| A decision buried in six months of notes | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.33 | 0.6 |
| A decision buried in six months of notes | AGENTS.md / CLAUDE.md, appended (stale line kept) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.32 | 0.7 |
| A decision buried in six months of notes | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.83 | 1.2 |
| A partner limit nothing in the repository shows _(calibration)_ | No shared channel | 5 | 0% (0%–43%) | 0/5 | 0.0 | — | — | $0.51 | 2.3 |
| A partner limit nothing in the repository shows _(calibration)_ | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | $0.30 | 1.0 |
| A partner limit nothing in the repository shows _(calibration)_ | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.32 | 1.0 |
| A partner limit nothing in the repository shows | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A partner limit nothing in the repository shows _(calibration)_ | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.58 | 1.4 |

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- A note left by a session that has ended: KLYPIX ahead of none — 100% vs 0%
- A WIP note that outlived its session: KLYPIX BEHIND agents-md-kept — 0% vs 100%
- A decision made while the agent is working: KLYPIX ahead of none — 100% vs 0%
- A decision buried in six months of notes: KLYPIX ahead of none — 100% vs 0%
- A decision buried in six months of notes: KLYPIX ahead of relay — 100% vs 0%
- A partner limit nothing in the repository shows: KLYPIX ahead of none — 100% vs 0%

## Agent: codex

CLI: codex-cli 0.153.4

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | — | 1.1 |
| A decision changed today | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | — | 1.2 |
| A decision changed today | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.1 |
| A decision changed today | AGENTS.md / CLAUDE.md, appended (stale line kept) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.0 |
| A decision changed today | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | — | 1.3 |
| Two sessions on overlapping work | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | 0/5 | — | 1.1 |
| Two sessions on overlapping work | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | 5/5 | — | 1.3 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | 5/5 | — | 1.2 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| Two sessions on overlapping work | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | 5/5 | — | 1.6 |
| A note left by a session that has ended | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | — | 1.0 |
| A note left by a session that has ended | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | — | 1.0 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.0 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A note left by a session that has ended | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | — | 1.1 |
| A WIP note that outlived its session | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | — | 1.2 |
| A WIP note that outlived its session | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | — | 1.2 |
| A WIP note that outlived its session | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.1 |
| A WIP note that outlived its session | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: nothing to append — the notes file is identical to the no-channel condition | — | — | — | — | — | — |
| A WIP note that outlived its session | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 5/5 | — | — | 1.5 |
| A decision made while the agent is working | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | — | 1.5 |
| A decision made while the agent is working | Human copy-paste (meant as upper bound) | — | n/a: a copy-paste at start cannot carry a decision that is made after the agent begins | — | — | — | — | — | — |
| A decision made while the agent is working | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 80% (38%–96%) | 1/5 | 0.0 | — | 4/5 | — | 1.8 |
| A decision made while the agent is working | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A decision made while the agent is working | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | 5/5 | — | 2.4 |
| A decision buried in six months of notes | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | — | 1.4 |
| A decision buried in six months of notes | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | — | 1.5 |
| A decision buried in six months of notes | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.4 |
| A decision buried in six months of notes | AGENTS.md / CLAUDE.md, appended (stale line kept) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.3 |
| A decision buried in six months of notes | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | — | 1.7 |
| A partner limit nothing in the repository shows _(calibration)_ | No shared channel | 5 | 0% (0%–43%) | 0/5 | 0.0 | — | — | — | 2.0 |
| A partner limit nothing in the repository shows _(calibration)_ | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | — | 1.4 |
| A partner limit nothing in the repository shows _(calibration)_ | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | — | 1.3 |
| A partner limit nothing in the repository shows | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A partner limit nothing in the repository shows _(calibration)_ | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | — | 1.5 |

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- A decision changed today: KLYPIX ahead of none — 100% vs 0%
- Two sessions on overlapping work: KLYPIX ahead of none — 100% vs 0%
- A note left by a session that has ended: KLYPIX ahead of none — 100% vs 0%
- A WIP note that outlived its session: KLYPIX BEHIND relay — 0% vs 100%
- A WIP note that outlived its session: KLYPIX BEHIND agents-md-kept — 0% vs 100%
- A decision made while the agent is working: KLYPIX ahead of none — 100% vs 0%
- A decision buried in six months of notes: KLYPIX ahead of none — 100% vs 0%
- A partner limit nothing in the repository shows: KLYPIX ahead of none — 100% vs 0%

## Not measured

- **KLYPIX with Claude Code hooks** — needs project-scoped hook settings pointed at this checkout; the MCP server with the AGENTS.md rules block is measured instead (whether hooks change the result is not measured)
- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **MCP Agent Mail** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Concord MCP** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._
