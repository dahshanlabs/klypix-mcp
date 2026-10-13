# KLYPIX coordination bench — results

> Historical rows: experiment identity was not recorded. Configuration compatibility cannot be verified; these numbers are not evidence for the current build.

## Agent: claude

CLI: 2.1.226 (Claude Code) · model: claude-haiku-4-5-20251001+claude-opus-5[1m], claude-opus-5[1m], claude-opus-5[1m]+claude-haiku-4-5-20251001

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Handled | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|---|
| A decision changed today | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 0/5 | — | $0.22 | 0.5 |
| A WIP note that outlived its session | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 4/5 | — | $0.44 | 1.1 |
| A WIP note that outlived its session | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 1/5 | — | $0.30 | 0.7 |
| A "hands off" note whose work is finished (held out) | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.23 | 0.8 |
| A "hands off" note whose work is finished (held out) | Human copy-paste (meant as upper bound) | 5 | 20% (4%–62%) | 4/5 | 1.0 | — | — | $0.29 | 1.0 |
| A "hands off" note whose work is finished (held out) | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.27 | 0.9 |
| A "hands off" note whose work is finished (held out) | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: nothing to append — the notes file is identical to the no-channel condition | — | — | — | — | — | — |
| A "hands off" note whose work is finished (held out) | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 20% (4%–62%) | 4/5 | 0.0 | 2/5 | — | $0.30 | 0.9 |
| A "hands off" note whose work is finished (held out) | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 1/5 | — | $0.28 | 1.0 |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | No shared channel | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | 5/5 | $0.24 | 0.8 |
| A "hands off" note whose work is still in progress (held out) | Human copy-paste (meant as upper bound) | — | n/a: the only thing to relay is the note every condition already holds | — | — | — | — | — | — |
| A "hands off" note whose work is still in progress (held out) | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | — | n/a: a tidy notes file keeps a true note — identical to the no-channel condition | — | — | — | — | — | — |
| A "hands off" note whose work is still in progress (held out) | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 2/5 | 5/5 | $0.24 | 0.8 |
| A "hands off" note whose work is still in progress (held out) _(harm check)_ | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 0/5 | 5/5 | $0.26 | 0.9 |
| Continue the work a stopped session left | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | — | $0.36 | 1.3 |
| Continue the work a stopped session left | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | — | $0.34 | 1.0 |
| Continue the work a stopped session left | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | — | $0.44 | 1.2 |
| Continue the work a stopped session left | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| Continue the work a stopped session left | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.86 | 2.2 |
| Continue the work a stopped session left | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.85 | 2.5 |
| Continue the work a stopped session left — it ended on a summary | No shared channel | — | n/a: identical to S9 (only the KLYPIX record differs) | — | — | — | — | — | — |
| Continue the work a stopped session left — it ended on a summary | Human copy-paste (meant as upper bound) | — | n/a: identical to S9 (only the KLYPIX record differs) | — | — | — | — | — | — |
| Continue the work a stopped session left — it ended on a summary | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | — | n/a: identical to S9 (only the KLYPIX record differs) | — | — | — | — | — | — |
| Continue the work a stopped session left — it ended on a summary | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| Continue the work a stopped session left — it ended on a summary _(secondary)_ | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 5/5 | — | $0.80 | 2.1 |
| Continue the work a stopped session left — it ended on a summary _(secondary)_ | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 4/5 | — | $0.79 | 2.1 |
| A live session that has written nothing | No shared channel | 5 | 0% (0%–43%) | 5/5 | 0.0 | — | 0/5 | $0.19 | 0.5 |
| A live session that has written nothing | Human copy-paste (meant as upper bound) | 5 | 100% (57%–100%) | 0/5 | 1.0 | — | 5/5 | $0.18 | 0.6 |
| A live session that has written nothing | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 5 | 100% (57%–100%) | 0/5 | 0.0 | — | 5/5 | $0.22 | 0.7 |
| A live session that has written nothing | AGENTS.md / CLAUDE.md, appended (stale line kept) | — | n/a: no stale line to keep — the notes file is identical to the kept-tidy condition | — | — | — | — | — | — |
| A live session that has written nothing | KLYPIX (MCP server + AGENTS.md rules, no hooks) | 5 | 0% (0%–43%) | 5/5 | 0.0 | 0/5 | 0/5 | $0.20 | 0.5 |
| A live session that has written nothing | KLYPIX as installed (server + hooks + search by meaning; Claude Code) | 5 | 100% (57%–100%) | 0/5 | 0.0 | 1/5 | 5/5 | $0.24 | 0.7 |

**Clear differences** (95% intervals do not overlap), KLYPIX against each other condition:
- A "hands off" note whose work is finished (held out): klypix-installed BEHIND agents-md-kept — 0% vs 100%
- Continue the work a stopped session left: klypix-installed ahead of none — 100% vs 0%
- Continue the work a stopped session left: KLYPIX ahead of none — 100% vs 0%
- A live session that has written nothing: klypix-installed ahead of none — 100% vs 0%
- A live session that has written nothing: KLYPIX BEHIND agents-md-kept — 0% vs 100%
- A live session that has written nothing: KLYPIX BEHIND relay — 0% vs 100%

## Not measured

- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **MCP Agent Mail** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Concord MCP** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = a teammate pasted the facts into the prompt — meant as an upper bound, but an agent may weigh a paste against a written record that contradicts it. "invalid" = the run measured nothing about its channel (server never came up, a write did not land, a mid-task fact never fired or landed after the last action, or the bench itself failed); it is excluded from the rates, not counted as a fail. _(control)_ rows are solvable without any channel; _(calibration)_ rows check that delivery works, not which channel is better. "Handled" is scored only where a scenario defines it: S2, the overlap was avoided or named in the final message; S6, the decision was applied or surfaced with its source, counted only where it was delivered._
