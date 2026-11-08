# How klypix-mcp compares

KLYPIX is a portable project workspace with a shared brain. This page compares its
open brain layer, **klypix-mcp**, with alternatives a software team might use for
shared understanding, continuity and coordination. It does not rank the desktop app.

Reviewed **8 November 2026**. Competitor capabilities below come from their primary
documentation, not our hands-on verification. Measured results are identified separately.
Stars, download counts and the number of exposed tools are not measures of effectiveness.

## Compare by the job the team needs done

| Alternative | Why it belongs in the comparison | Relevant evaluation |
|---|---|---|
| Maintained `AGENTS.md` / `CLAUDE.md`, ordinary Git and the host's native session features | The simplest practical alternative, and a strong baseline in our measured runs | Correct continuation, upkeep effort, tokens and time; include native resume and memory where supported |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Automatic session observations and summaries; multiple coding hosts; optional TeamBrain sharing | Interrupted work, cross-tool recall, current decisions; distinguish local and team configurations |
| [Engram](https://github.com/Gentleman-Programming/engram) | Project-aware memory, session tools, conflict surfacing and portable Git Sync exports from its local database | Cross-tool continuity, competing decisions, sharing and recovery |
| [Concord MCP](https://github.com/Get-Concord-AI/concord-mcp) | Live messaging, work claims, task context and handoffs | Mid-task decisions, ownership coordination and handoff; include the supported host integration |
| [MCP Agent Mail, Rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) | Persistent mailboxes, advisory file reservations and a Git-backed message archive | Team communication, reservation expiry and integration agreement |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | Human-readable Markdown knowledge with an index, multiple MCP hosts and a Claude Code capture plugin | Readable shared knowledge, changed decisions and maintenance burden |
| [Beads](https://github.com/gastownhall/beads) | Persistent tasks, dependencies, project facts and messaging in a versioned database | Task handoff, unfinished work and dependency awareness |
| [Entire CLI](https://github.com/entireio/cli) | Agent transcripts and checkpoint references alongside Git commits, with session resume and separately installed project-memory tooling | Session continuity, provenance and review; record exactly which components are enabled |
| [Clash](https://github.com/clash-sh/clash) | A Claude Code hook that checks worktree conflicts before writes | Overlapping edits only; do not score it as a general memory system |

Native features must be part of the baseline rather than assumed absent:
[Claude Code memory](https://code.claude.com/docs/en/memory) and
[Codex session persistence and resume](https://learn.chatgpt.com/docs/app-server#api-overview).
MCP Agent Mail here means the coding-agent coordination project, not the unrelated
AgentMail email service. This is a focused comparison set, not a complete market census.
Memory infrastructure and agent orchestration frameworks become relevant when a team's
actual alternative is building its own system; they need a separate setup-cost comparison.

## What is measured

The [8 November competitor run](../bench/coordination/results/2026-11-08-competitors.md)
contains **176 Claude Code runs, n=4 per cell**, and **36 Codex runs, n=3 per cell**.
The channels were klypix-mcp 1.112.0, Concord MCP 0.20.0 and MCP Agent Mail 0.3.40.
Claude also had no-channel and maintained-notes conditions; Codex did not in that run.

- KLYPIX passed the four Claude repetitions for stopped-work continuation, expired WIP
  restrictions and mid-task changed decisions. Maintained notes tied it on many tasks.
- On overlapping work (S2), **KLYPIX, Concord and Agent Mail each scored 0/4** against
  the strict completion grade; maintained notes scored 4/4. Warning delivery did not
  establish agreed ownership or successful integration.
- All three channels scored 0/3 on Codex's silent-live-peer scenario (S10). That grade
  must not be read as proof that no warning was delivered: inspect the transcripts and
  separate notice, response, integration and final disclosure.
- These are small samples and the report explicitly does **not** establish a general
  ranking. None of the other tools in the table was measured in this run.

The configurations matter. KLYPIX ran through MCP plus project instructions, without its
hooks; Concord ran its MCP server plus setup instructions, without its plugin. Concord
[documents live delivery integrations](https://github.com/Get-Concord-AI/concord-mcp/blob/main/CHANGELOG.md).
Its S6 result therefore describes that configured experiment, not an inability of the
full product to deliver live messages. Agent Mail used a preregistered mailbox and its
own instructions; registration, inbox consultation and lease timing affect those cells.

The earlier [one-repetition pilot](../bench/coordination/results/2026-11-08-concord-pilot.md)
is historical. Likewise, the older KLYPIX build's stale-note loss in round 3 is not the
current build's result: version 1.112.0 passed S5 and the held-out S5b, four times each.
Keep both results and their versions visible; neither erases the other.

## The differentiation to earn

The useful question is: **can another developer's supported agent continue correctly,
using current decisions, without the human reconstructing the project?** Evaluate the
whole path: interrupted work, a changed decision, a concurrent branch, then review.

KLYPIX's approach combines project memory in `brain.klypix`, session evidence, live
coordination and review through the project's Git workflow. Its intended advantage is
less human explanation and repair while preserving inspectable project understanding.
That is an outcome to demonstrate, not proof of an exclusive feature or a moat.

Do not claim that repository sharing, session capture, cross-tool support or team memory
belongs only to KLYPIX. Engram has Git Sync; Basic Memory uses readable files; Agent Mail
has a Git-backed archive; Entire attaches session evidence to Git; claude-mem documents
multiple hosts and optional team sharing. A combined workflow may still perform better,
but the comparison has to establish that.

Three reliability repairs support this direction: conservative correction targeting,
retaining unresolved branch integration information at completion, and readable before/after
decision bodies in PR diffs. Code in a development branch is not a released capability;
use the release notes and tests for the version being evaluated. An overlap warning or a
commit hook alone does not prove that conflicts were prevented.

## Spend the next evaluation effort where it can change a decision

1. Verify the repaired failures with deterministic isolated regressions first. Do not
   repeat the whole paid matrix merely to add a fifth repetition or a stronger headline.
2. For the next continuity evaluation, prioritize maintained notes with native host
   features, claude-mem, and Engram. Use Basic Memory as the readable-knowledge comparison;
   add Beads or Entire when evaluating task handoff or session history respectively.
3. For coordination, retain Concord and MCP Agent Mail, and include Clash on overlap
   scenarios. Pin versions, use each documented supported setup, and distinguish minimal
   MCP from full host integrations. Apply the same correctness criteria and human-help
   allowance to each; do not silently disable a competitor's relevant feature.
4. Observe one real team's workflow before expanding the matrix. Measure correct outcomes,
   human explanation/repair minutes, setup and upkeep, latency, token cost, false warnings,
   missed conflicts, and wrong-memory changes. Preserve held-out cases and harmful-action
   checks; keep raw results, failures and configuration limits visible.

“100× better” is an ambition, not a supported product claim. A defensible ratio needs a
named outcome, an observed baseline and the same correctness requirement—for example,
human recovery time across comparable interrupted tasks. Include setup and maintenance,
handle zero denominators, and report the distribution and uncertainty, not a selected demo.
