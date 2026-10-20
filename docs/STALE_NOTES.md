# Checking temporary file reservations

Introduced in klypix-mcp 1.102.0; the note-kind guidance described below ships in
1.103.0. Release receipts and publication status are tracked by the tagged
release and its publication workflow.

An agent can leave “hands off this file” in project instructions after its work
has ended. KLYPIX surfaces local work evidence beside that note so the next
session can distinguish a temporary reservation from ongoing work. It does not
decide whether a human instruction remains binding; it asks the agent to decide
which kind of note it faces.

## Evidence and authority

| Result | Meaning |
|---|---|
| IN USE | Another observed session lists this exact file. Coordinate before overlapping edits. |
| WORK IN PROGRESS | A local branch, registered worktree, or recorded stopped-session commit has relevant work. Preserve it; coordinate or isolate changes. |
| NO WORK FOUND | The completed local check found no such work. If the note is a temporary reservation for someone’s in-flight change, that work has ended: the agent may make the change in the file and must tell the human. A permanent rule still applies. |
| UNKNOWN | A Git probe failed, a revision is unavailable, or a search/time limit was reached. Do not infer staleness. |

These results are evidence, not permission to break a rule. The agent first
decides which kind of note it faces:

- A **temporary reservation** holds a file for someone’s in-flight change (it
  names a person, a session, a branch, or a change “until it lands”). It ends
  when that work ends.
- A **permanent rule** — a generated-file policy, a security or legal
  restriction, a standing project rule, or a human instruction with no end —
  always applies, even when the worktree is clean.

For an expired temporary reservation, the agent makes the change where it
belongs (not a workaround elsewhere) and reports the stale note to the human.
The checker never edits or deletes the note. It does not lock files.

Structured results use `workFound: true | false | null` and
`canOverrideInstructions: false`; unknown is not represented as a negative result.

## Scope and limits

- Sources: root `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, and
  `.github/copilot-instructions.md`. Nested rules and arbitrary notes are not
  recursively scanned. A missing result is not clearance.
- Detection: reservation wording plus a file path; when files are declared or
  named by a stopped session, matching lines are also surfaced without requiring
  a reservation keyword. The agent still interprets their purpose.
- Fenced examples and KLYPIX managed blocks are skipped. Each source is limited
  to 64 KiB; at most six selected notes are assessed per hook/sync. Paths must be
  project-relative. Instruction sources resolving outside the project are skipped.
- Surfaces (1.104.0): the verdict block is printed at session start by the Claude
  Code and Codex hooks and by `brain_sync`, and the same text is written into the
  live-projection block of `CLAUDE.local.md` and of the Codex global instructions
  file at session start and at every Stop, so a host that reads files rather than
  hook output sees it too. `CLAUDE.local.md` is never itself a note source.
- Evidence: observed local sessions, up to 30 local branches, up to 20 registered
  worktrees (including detached and dirty worktrees), and recorded commits.
  Connected-but-idle sessions use the same activity window as the handoff list;
  heartbeats do not renew a work claim, but their unfinished commits still count.
  Squash/cherry-picked work is recognised when this file matches the target.
  Subsequent changes can make that conservative comparison report work again.
- Git reads share one cached 2.5-second budget per hook/sync; individual commands
  are capped at 750 ms. Failed or truncated evidence cannot produce NO WORK FOUND.
  Git uses literal pathspecs and optional index locking is disabled.
- It cannot see other machines, unfetched remote branches, unregistered
  worktrees, or changes made after its observation. It is not a global lock or a
  security boundary.
- Delivery: Claude/Codex SessionStart hooks and `brain_sync` start or relevant
  checkpoints. MCP-only clients must call `brain_sync`. Completion and
  `include_context:false` do not run this check.

## Validation and claims

`node test/lock-notes.mjs` uses real Git repositories and worktrees, injected Git
failures, and actual Claude/Codex hooks plus an MCP worker. It covers authority
limits, sibling and detached worktrees, unknown revisions, bounded searches,
literal filenames, self-session exclusion and context opt-out.

The inherited experiment is retained separately on `feat/bench-heldout`, under
`bench/coordination/results/stale-note-check-2026-10-13/`. It compares agent runs
with and without KLYPIX on small synthetic scenarios, not competing products.
Several scenarios informed implementation changes; only the final scenario pair
was unseen by the final inherited build. MCP-only Claude was less reliable than
hook delivery. One installed run still obeyed a dead note despite the evidence.

### Live evaluation of the note-kind guidance (2026-10-15)

`bench/coordination/results/note-kinds-2026-10-15/README.md` compares
1.102.0’s original wording with the note-kind guidance on Claude Code with
KLYPIX hooks installed: 5 runs per cell, shuffled, with identical evidence
code, so only the words the agent reads differ.

- Dead temporary reservations (6 scenarios): 30/30 handled correctly with the
  note-kind guidance, 12/30 with 1.102.0’s wording, 5/30 without KLYPIX.
- Live work, true reservations and permanent rules (7 scenarios, including a
  generated file and legal-approved text): 35/35 with both wordings.
- In every 1.102.0 failure the agent saw the evidence, reported the note as
  stale, and still worked around the file.

Limits: small synthetic repositories on one machine; Claude Code only (the
Codex account’s usage limit was reached during the run; Codex is re-tested
after 2026-10-22); the guidance was written after reading 1.102.0’s failures
on s5–s5i, while s5j–s5m were written blind before it; only two
permanent-rule scenarios. It compares KLYPIX wordings, not competing
products, and does not establish “best in class.” Public claims follow the
claims-matrix review process.

### The inherited experiment

That experiment predates the authority and incomplete-evidence fixes described
here. It does not measure this revised version or establish “best in class.”
Before a public effectiveness claim, run a fresh held-out evaluation of this
version, include standing-rule and real-work harm cases, publish failures and
uncertainty, and follow the claims-matrix review process.
