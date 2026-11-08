# How klypix-mcp compares

Written for developers choosing a coordination or memory layer for their coding agents.
Checked on **8 November 2026** against each project's own README and the GitHub and npm APIs.
Everything here is what the other projects say about themselves; nothing was installed or
measured for this page. The [coordination bench](../bench/coordination/README.md) is where
measured numbers live, and it says plainly which tools are **not measured**.

## The short version

- If you want **a warning when two agents are about to touch the same file**, several tools do
  it, and have for a while. Concord MCP, MCP Agent Mail and Agent-MCP do it with claims, leases or
  locks; Clash does it across git worktrees with a Claude Code hook. klypix-mcp does it too, from
  the files each session declares, and since 1.112.0 across the worktrees of one repository.
- What klypix-mcp does that the others do not claim: **the memory lives in your repository**, as
  one committed `brain.klypix` file with a card-level git merge driver, so a fresh clone, a CI
  runner and a teammate's computer all have it without an account or a server. It remembers at
  the **project** level (decisions, corrections, open questions, what the project believes now),
  not only inside a task. It makes **no network calls and sends no telemetry**. Teammates on other
  computers are reached **peer to peer**, encrypted, over a relay you can run yourself. And the
  same file opens in the optional KLYPIX workspace, where a person can see and correct it.

## Side by side

| | klypix-mcp | Concord MCP | MCP Agent Mail (Rust) | Clash | Agent-MCP |
|---|---|---|---|---|---|
| Overlap heads-up before an edit | Yes, from declared files; one computer, all worktrees of a repo (1.112.0) | Yes, file and module claims; worktrees share one workspace | Yes, advisory file leases with a conflict error | Yes, across worktrees, Claude Code hook | Yes, file-level locking |
| Where the state lives | `brain.klypix`, committed in the repo, card-level merge driver | SQLite in `.concord/`, gitignored by default | Git-backed archive plus SQLite, per project | Reads the worktrees; no state of its own | Its own server and database |
| What it remembers | The project: decisions, corrections, open questions, handoffs, a brief at session start | The task: context, decisions and evidence attached to a task; handoff and review packets | Messages, threads, reservations | Nothing; it detects conflicts | Tasks and context for its agents |
| Across computers | Peer to peer, encrypted, self-hostable relay, no account | Concord Cloud, account | Local HTTP server | No | Its server |
| Telemetry | None | On by default to getconcord.ai, opt-out | Not stated in the README we read | Not stated | Not stated |
| Tools exposed to the agent | 6 by default (`core`), 29 or 30 with `all` | 5 | 45 tools, 25 resources | CLI and hook, no MCP tools | MCP tools |
| Hosts with a documented setup | Claude Code (hooks), Codex, Cursor, Cline, VS Code, Gemini CLI, Antigravity, Windsurf, Aider, Claude plugin | Claude Code, Codex, Cursor, Gemini CLI, Grok Build, Goose, Antigravity, Copilot CLI, Devin CLI, Conductor | Claude Code, Codex, Gemini CLI, Oh My Pi, Copilot CLI | Claude Code | MCP clients |
| A person's view | The KLYPIX workspace (optional, Windows) and the web viewer; `klypix-read` prints the brain as text | `concord dashboard` terminal view, `HANDOFF.md`, `REVIEW_PACKET.md` | Terminal console and web UI | Conflict matrix in the terminal | Web dashboard |
| Published benchmark | [Yes, including the rows it loses](../bench/coordination/results/) | Not found | Not found | Not found | Not found |
| Licence | MIT | MIT | MIT with a rider | MIT | Not checked |
| GitHub stars, 8 Nov 2026 | 10 | 995 | 237 (the Python original: 2,233, deprecated) | 65 | 1,304 |

Sources: [Concord MCP](https://github.com/Get-Concord-AI/concord-mcp) ·
[MCP Agent Mail (Rust)](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) ·
[Clash](https://github.com/clash-sh/clash) · [Agent-MCP](https://github.com/rinadelph/Agent-MCP).

## What the bench says, so far

The [coordination bench](../bench/coordination/README.md) runs real Claude Code and Codex sessions
on seeded repositories and grades them with hidden tests. Its published rounds show two things
plainly:

- **A tidy notes file beats klypix-mcp** when a session left a "hands off" note whose work is
  finished: the notes file was edited by hand, the brain still carried the dead line. 0 of 5 against
  5 of 5 ([round 3](../bench/coordination/results/2026-10-13-round3-claude-report.md)).
- **klypix-mcp beats having no channel** when the next session has to continue work a stopped
  session left without writing anything down: 5 of 5 against 0 of 5, because the stopped session's
  last prompt, reply and commits were recorded automatically.

Concord and Agent Mail appear in that bench as conditions only where an adapter exists and was run;
see the results folder for what was and was not measured. We publish every row, including the ones
we lose, because a comparison you cannot rerun is an advertisement.
