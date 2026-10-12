# KLYPIX coordination bench — results

## Agent: claude

CLI: 2.1.226 (Claude Code) · model: claude-haiku-4-5-20251001+claude-opus-5[1m]

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|
| A decision changed today | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | $0.21 | 0.5 |
| A decision changed today | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | $0.20 | 0.6 |
| A decision changed today | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.18 | 0.6 |
| A decision changed today | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.18 | 0.5 |
| A decision changed today | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | $0.33 | 0.7 |
| Two sessions on overlapping work | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | $0.15 | 0.3 |
| Two sessions on overlapping work | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | $0.39 | 1.5 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | $0.28 | 1.0 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.29 | 1.0 |
| Two sessions on overlapping work | KLYPIX (brain + lane, MCP only) | 1 | 0% (0%–79%) | 1/1 | 0.0 | 1/1 | $0.43 | 0.9 |
| A note left by a session that has ended | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | $0.22 | 0.6 |
| A note left by a session that has ended | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | $0.19 | 1.3 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.21 | 0.5 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.18 | 0.4 |
| A note left by a session that has ended | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | $0.36 | 0.7 |
| Another vendor's session found the root cause | No shared channel | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.35 | 1.2 |
| Another vendor's session found the root cause | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | $0.36 | 1.2 |
| Another vendor's session found the root cause | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.47 | 1.5 |
| Another vendor's session found the root cause | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | $0.39 | 1.1 |
| Another vendor's session found the root cause | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | $0.69 | 1.7 |

**Clear differences** (95% intervals do not overlap):
- none at this sample size — report these as ties.

## Agent: codex

CLI: codex-cli 0.153.4 · model: gpt-6-astra

| Scenario | Condition | n | Success (95% CI) | Acted on stale info | Human relays / task | Agent consulted KLYPIX | Median cost | Median min |
|---|---|---|---|---|---|---|---|---|
| A decision changed today | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | — | 1.2 |
| A decision changed today | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | — | 1.1 |
| A decision changed today | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 0.9 |
| A decision changed today | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.2 |
| A decision changed today | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | 1.3 |
| Two sessions on overlapping work | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | — | 0.8 |
| Two sessions on overlapping work | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | — | 1.2 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.1 |
| Two sessions on overlapping work | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 0.9 |
| Two sessions on overlapping work | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | 1.8 |
| A note left by a session that has ended | No shared channel | 1 | 0% (0%–79%) | 1/1 | 0.0 | — | — | 0.9 |
| A note left by a session that has ended | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | — | 0.8 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 0.8 |
| A note left by a session that has ended | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.6 |
| A note left by a session that has ended | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | 1.2 |
| Another vendor's session found the root cause | No shared channel | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.5 |
| Another vendor's session found the root cause | Human copy-paste (upper bound) | 1 | 100% (21%–100%) | 0/1 | 1.0 | — | — | 1.2 |
| Another vendor's session found the root cause | AGENTS.md / CLAUDE.md, kept tidy (stale line replaced) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.3 |
| Another vendor's session found the root cause | AGENTS.md / CLAUDE.md, appended (stale line kept) | 1 | 100% (21%–100%) | 0/1 | 0.0 | — | — | 1.3 |
| Another vendor's session found the root cause | KLYPIX (brain + lane, MCP only) | 1 | 100% (21%–100%) | 0/1 | 0.0 | 1/1 | — | 1.5 |

**Clear differences** (95% intervals do not overlap):
- none at this sample size — report these as ties.

## Not measured

- **KLYPIX with Claude Code hooks** — needs project-scoped hook settings pointed at this checkout; MCP-only KLYPIX is measured instead (conservative)
- **Claude Code cross-session messaging** — needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design
- **MCP Agent Mail** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Concord MCP** — third-party server not installed here; adapter must be verified against a pinned version before any result is published
- **Memory tool (OpenMemory MCP)** — third-party server not installed here; adapter must be verified against a pinned version before any result is published

_Scripted "other session" actors; hidden tests; no LLM judge. Relay = the human pasted the facts (upper bound). "invalid" = the server of the condition never came up for that run; it is excluded from the rates, not counted as a fail._
