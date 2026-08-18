# Every project gets a brain.

**Active state management for multi-agent coding — a local-first active context engine with a shared brain.**
*One project. One shared understanding.*

**One actively managed project brain for multi-agent coding.** `klypix-mcp` keeps one versioned
`brain.klypix` in your repo: the project's active state — current decisions, corrections, evidence
anchors, open questions, active work, and handoffs. Corrections supersede stale decisions,
`brain_challenge` tests proposed decisions against standing rules and reversed approaches, and
sessions declare their scope and get warned about same-machine file overlap. Agents read it and
write to it over MCP. You read it and correct it in the [KLYPIX app](https://klypix.com).

> **One project. Many agents. One current understanding.**

Klypix does not launch, run, supervise, or replace your agents. It is not an agent runtime, a model
router, a worktree manager, or a replacement for Git. It is the layer underneath them that holds
what the project currently believes.

---

## The problem

You are running more than one coding agent on one codebase — a Claude Code session here, Codex in
another terminal, Cursor open on the side. Each one has excellent memory of *itself* and none of
the others:

- Every new session starts from zero, and you explain the same architecture again.
- Codex does not know what Claude learned an hour ago.
- One agent implements an approach the team already rejected, because the reason it was rejected
  lived in a chat that ended.
- Two sessions start changing the same files and nobody finds out until review.
- Git stores the code history. It does not store a reliable history of project *intent*.

Your agents may run independently. Their project understanding should not.

---

## When NOT to use this

Honest scoping first, because a coordination layer you don't need is pure overhead:

- **Solo dev, one agent, small project?** You don't need this package. A `decisions.md`
  convention plus a 15-line git hook captures most of the value with zero moving parts —
  we wrote that guide for you: **[docs/BUILD_YOUR_OWN.md](docs/BUILD_YOUR_OWN.md)**. It
  teaches the capture conventions, the correction-supersedes rule, the merge problem, and
  ships a working flat-markdown starter. If you build it and never hit its boundaries, you
  never need us.
- **This tool earns its keep** where the flat file breaks: several concurrent agent
  sessions on one checkout (silent last-writer-wins clobbering — the guide states the
  problem precisely, and `npx klypix-mcp bench` measures it), several hosts/providers
  needing one current understanding, or a memory grown past the point where grep finds
  the entry that matters. If none of that is you yet, start flat and come back.

**What connecting costs.** Measured, not hand-waved: the server registers **22 tools**
(count them yourself: `grep -c "server.registerTool('" bin/klypix-worker.mjs`), and the
serialized `tools/list` result we measured is ~36 KB of JSON — roughly **9k tokens** at
the ~4-chars-per-token rule of thumb. That is an estimate (hosts serialize and re-send
schemas differently), but it is context your host spends on every model request whether
or not a tool gets called. If that is too much for your sessions, run the server with
`KLYPIX_MCP_PROFILE=minimal` (env var) or `--minimal` (flag): it registers only the **7**
coordination/recall tools the workflow itself depends on — `brain_sync`, `brain_note`,
`brain_ask`, `brain_message`, `brain_message_receipt`, `brain_doctor`, `read_canvas` —
measured at ~15 KB, roughly 3.7k tokens. Full profile stays the default.

And before installing anything: `npx klypix-mcp install --dry-run` prints every file the
install would write and every standing behavior it would enable (the 24h auto-updater,
the session git-hook auto-install) without writing a byte, and
**[docs/WHAT_RUNS_ON_YOUR_MACHINE.md](docs/WHAT_RUNS_ON_YOUR_MACHINE.md)** documents the
full process tree and how to stop or remove all of it.

---

## 60 seconds: two agents, one project

Session A — Claude Code, in your repo:

```jsonc
brain_sync { intent: "rewrite the auth token refresh", files: ["src/auth/token.ts"] }
// → task-relevant memory capsule (bounded, ~2.8KB)
// → peers: none
```

Session B — Codex, same repo, half a minute later:

```jsonc
brain_sync { intent: "add rate limiting to the auth routes",
             files: ["src/auth/token.ts", "src/auth/routes.ts"] }
// → task capsule
// → peers: 1 active session (claude-code) — "rewrite the auth token refresh"
// → overlap: src/auth/token.ts — declared by both sessions
```

Session A gets the same overlap surfaced on its next KLYPIX action. Neither edit is blocked — the
warning is advisory, and both sides only see the overlap because both declared the files they
expected to touch.

Then the brain pushes back before the decision, not after:

```jsonc
brain_challenge { "move token storage to localStorage" }
// → "reversed on June 12 — here's the correction card, captured by a different agent."
```

And the decision is kept where the next session will find it:

```jsonc
brain_note { text: "Token refresh moves to an httpOnly cookie; localStorage was reversed 2026-06-12." }
```

Prove all of this on your own machine, against the exact build you installed, with two real
isolated MCP clients:

```bash
npx klypix-mcp conformance
```

It runs in a temporary fixture and touches nothing else. It checks tool discovery, task memory,
truthful peer reporting, overlap surfacing, proactive logging, and in-band delivery of a peer note.
It verifies 15 required coordination behaviours — not the 22 tools, and not the retrieval engine.

---

## Quick start

Run this **inside your project**:

```bash
npx klypix-mcp install
```

One command, every editor. It finds the project root (walking up, so running it from `src/` is
fine), gives the project a brain if it doesn't have one, wires the agent tools you actually have
installed, registers the lossless `.klypix` merge driver if it's a git repo, and then **proves the
result** before it exits:

```text
  project   E:\work\api  (git repository root)
  brain     created brain.klypix — a starter brain, ready for its first decision
  editors   Claude Code · Cursor · Codex · Gemini CLI · Antigravity · VS Code
  wired     9 file(s) · 9 updated   (skipped 5 for tools you don't have)
  git       lossless .klypix merge driver registered
  verified  ✓ 22 tools reachable via .mcp.json (892ms)
```

That last line is the point. MCP config fails **silently** — a wrong entry means the server never
starts, the agent quietly loses every brain verb, and nothing reports an error. So `install` opens
a real stdio handshake against the config it just wrote and counts the tools that answered. A
broken entry dies in ~100ms with `Connection closed` and is reported, not shipped.

What goes where:

- **Machine-global, once** — the engine + runtime in `~/.claude/project-brain`, Claude Code's four
  lifecycle hooks in `~/.claude/settings.json`, and the `~/.codex/AGENTS.md` guidance block. Claude
  Code is therefore covered in every project on that machine that has a `./brain.klypix`.
- **Per project** — MCP config and rules for Cursor, Codex, Cline, Windsurf, Copilot, Gemini CLI /
  Antigravity and Aider. Run `install` once inside each project.

Three things it deliberately will **not** do:

- **Write for editors you don't have.** Config is projected only for hosts detected on this
  machine — a two-person team using one editor no longer commits rules for six they never opened.
  A file your project *already* carries stays maintained regardless, so you can't silently stop
  updating your team's committed configs.
- **Wire a directory that isn't a project.** It refuses your home folder, a drive root, and
  anything with no brain, no git repo and no project manifest. A mistyped command can't seed a
  brain into `C:\Users\you`.
- **Replace a project-owned server.** A repo-relative launch like
  `node scripts/klypix-mcp-server.mjs` is deliberate — it resolves offline and rides a bundle the
  repo version-gates — so it's left byte-identical and reported. An explicit `link` still rewrites
  everything: an action you didn't ask for stays more conservative than one you did.

Opt out with `--no-project` (CI images, scripted provisioning). `--json` emits the report as
structured data; `--verify-all` handshakes every written config instead of one.

Optional, opt-in, and approved inside Codex itself:

```bash
npx klypix-mcp install --codex-hooks
```

Six Codex lifecycle hooks that add automatic per-prompt context injection and a pre-edit
file-overlap warning. Codex owns the trust decision and will ask you to review them.
`brain_doctor` reports this layer separately as off, execution-unverified, or active. Even with it
on, **Codex never captures decisions automatically** — the Codex hook never writes the brain.

**Re-project everything explicitly:**

```bash
npx klypix-mcp link
```

`install` already does this for the editors you have. Reach for `link` when you want all 14
managed, hash-stamped files regardless of what's installed — MCP server config for six hosts plus
rules files for eight — or to repair drift. Managed blocks are merged into your existing
instruction files and never clobber your content.

```bash
npx klypix-mcp link --check    # audits without writing; exits non-zero on drift
```

> Either form works, and both are safe in CI: `npx -p klypix-mcp klypix-link --check` used to
> drop `--check` and write anyway — fixed, and locked by `test/cli-args.mjs`, which asserts the
> standalone bin and the dispatcher parse arguments identically.

**Give a project a brain** by dropping a `brain.klypix` into it — the
[KLYPIX app](https://klypix.com) does it in one click (*Save canvas as project brain*), or
`create_canvas` makes one from any agent.

---

## How the brain works

The difference from a folder of notes is not the shape — it is that this memory is a mechanism,
not a filing convention.

- **Decisions have a lifecycle.** A new decision that contradicts an old one supersedes it. The
  stale card is archived with an arrow and a date, never deleted, and later answers surface the
  correction rather than the corpse. If a later decision returns to an earlier superseded stance,
  high-confidence lineage leaves a dated `re-adopts` stamp on the new card plus an earlier→current
  edge; the original A→B→C history remains intact.
- **Corrections are explicit, not guessed.** Supersession fires on an UPPERCASE correction cue or
  an explicit edge. `brain_reconcile` only *proposes* stale-vs-correction pairs for a human to
  confirm.
- **Cards can cite the code they were decided against.** An `ev:` anchor records a file:line plus
  the git blob OID at capture time, so the engine can flag a card whose cited code has since moved
  on. It detects that the code *changed* — never that the claim became false.
- **Position means something.** Drag a card into the 📌 Focus area and it leads every future
  session's brief. That is brief priority, not a retrieval-ranking boost.
- **You can ask what the project believed then.** `brain_ask` with `as_of: 2026-03-01` reweights
  ranking by card lifecycle dates, so corrections made later do not leak backwards.
- **Retrieval is local.** Lexical by default. If the optional on-device model is installed,
  `brain_ask` and `search_all_brains` use BGE semantic ranking with lexical help for exact
  identifiers, paths, and versions — still entirely on your machine. The previous cross-encoder
  is available for experiments with `KLYPIX_RERANK=1`, but is off by default because it reduced
  precision and added latency on the frozen human-paraphrase evaluation. Without the embedding
  model, retrieval degrades cleanly to lexical. `npx klypix-mcp install` deliberately does not
  install that model, so a fresh install is lexical.

### Bounded semantic-memory runtime

Long-lived MCP and A2A workers use the bounded semantic-memory runtime by default. Models load only
when semantic work is requested, native inference is serialized per process, embedding work is
split into small batches, and temporary tensors are released after use. Loaded models retire after
an idle interval and transparently reload on the next semantic request, so warm queries stay fast
without permanently pinning native model memory. These controls change the resource lifecycle only;
brain cards, project coordination, and the on-disk brain format are unchanged.

The previous runtime remains available as an emergency rollback. Set
`KLYPIX_SEMANTIC_MEMORY_MODE=legacy` in the MCP server environment and reconnect or restart the
host. This restores eager model prewarming and the previous inference path without migrating or
deleting brain data. Remove the variable (or set it to `bounded`) to return to the bounded runtime.

Run the deterministic lifecycle tests with `npm run test:memory`. For an opt-in real-model soak
against a disposable or backed-up brain, set `KLYPIX_MEMORY_SOAK_BRAIN` to its path and run
`npm run test:memory:soak`.

For process-level attribution, run `npx klypix-mcp runtime` (or add `--json`; `--watch 30` samples
every 30 seconds). It reports KLYPIX workers, supervisors, and legacy launcher overhead separately,
excludes the owning IDE/chat application's RAM, redacts command-line secrets, and never opens a
brain or terminates a process. Multiple processes under one host are reported as parallel sessions,
not called duplicates without an authoritative logical-session receipt.

### Project Map: current structure beside project understanding

If the project contains a compatible NetworkX node-link `graph.json`, agents can ask for bounded
code-structure evidence and current brain context in one read-only call:

```jsonc
project_map_context {
  "question": "what owns refresh-token rotation?",
  "graph_path": "graphify-out/graph.json"
}
```

Use `compare_to` with another project-relative graph artifact to add exact total node/edge deltas
and additions/removals from the two bounded query neighborhoods. Both paths are confined to the
declared project root; unsafe source paths are withheld; large or unsupported artifacts are
rejected. When a returned brain card names an exact mapped source path, the structured response
also includes a review-only evidence-link proposal. It never promotes similarity into truth and
never writes graph facts or links into `brain.klypix`.

Graphify is the first compatible producer. KLYPIX reads artifacts that users generate separately;
it does not bundle, install, or run Graphify and does not imply a partnership. A compatible generic
`graph.json` works through the same provider-neutral boundary.

For a reproducible map artifact on every pull request and main-branch push, install the shipped
read-only workflow into a Git checkout:

```bash
npx klypix-project-map setup-github /path/to/project
```

The command refuses to overwrite an existing workflow unless `--force` is explicit. The installed
workflow has `contents: read`, pins every action by commit SHA, pins `graphifyy==0.9.33`, validates
the graph contract, and uploads `graphify-out/` as a 14-day build artifact. This is opt-in CI code:
the local MCP tool still never installs or launches Graphify.

---

## Supported hosts and their integration level

Levels are honest. Only the config-writing side is tested for the `link` hosts; their host-side
behaviour is unverified.

| Host | Level | Wired by | Brief into context | Decision capture | Live presence |
|---|---|---|---|---|---|
| **Claude Code** | Full automatic (4 lifecycle hooks) | `install` | Automatic at session start, task-ranked retrieval per prompt | **Automatic** at turn end | Yes |
| **Codex** | Native MCP + presence + Context Gateway; optional `--codex-hooks` | `install` | Via `brain_sync`; per-prompt injection only with `--codex-hooks` | **Explicit only** (`brain_note`) — never automatic | Yes |
| **Cursor** | MCP config + always-on rules file | `link` | Model must call `brain_sync` | Model must call `brain_note` | For the MCP connection |
| **Cline** | MCP config + always-on rules file | `link` | Model must call `brain_sync` | Model must call `brain_note` | For the MCP connection |
| **VS Code (Copilot / Continue)** | MCP config + instructions file | `link` | Model must call `brain_sync` | Model must call `brain_note` | For the MCP connection |
| **Gemini CLI / Antigravity** | MCP config + always-on rules file | `link` | Model must call `brain_sync` | Model must call `brain_note` | For the MCP connection |
| **Windsurf** | Rules file only | `link` | Reaches the tools through Windsurf's own global MCP config | Model must call `brain_note` | Via its own MCP config |
| **Aider** | Rules file only (no MCP) | `link` | CLI path: `npx klypix-read` | CLI path: `npx klypix-append` | — |
| **Claude Desktop** | One-time manual config edit | you | Model must call `brain_sync` | Model must call `brain_note` | For the MCP connection |

`install` and `link` are different things and are not interchangeable: `install` only touches Claude
Code and Codex, and is machine-global for everything except Codex's MCP connection, which it writes
per project (see *Quick start*); `link` is per project and is what wires everything else.

**Claude Desktop** — add this to `claude_desktop_config.json` by hand; nothing writes that file
for you:

```json
{
  "mcpServers": {
    "klypix": {
      "command": "npx",
      "args": ["-y", "klypix-mcp", "--vault", "/absolute/path/to/canvases"]
    }
  }
}
```

---

## Task briefing

Every Claude Code session starts already knowing the project: a bounded ~5KB brief in context, with
the full brief written to disk for when broad history or status work needs it.

Every other host gets a bounded ~2.8KB task capsule from one `brain_sync` call, plus a compact
always-loaded `AGENTS.md` block that tells the agent to make that call at task start, when scope
changes, and on completion. The gateway capsule is lexical-fast by design. A newly captured open
gap can claim a labeled `RECENT OPEN` slot only after clearing the normal lexical-relevance floor,
so fresh relevant findings are not crowded out by older area vocabulary.

Briefs are **not** injected automatically on Cursor, Cline, Copilot, Gemini CLI or Antigravity —
there are no lifecycle hooks on those hosts.

## Capture and corrections

On Claude Code, decisions are captured automatically at turn end from inline `🧠 BRAIN [Area]:`
markers in the transcript, deduped, under a capture lock.

On every other host, capture is explicit: `brain_note` runs the same capture engine as the hooks —
dedup, supersession, round-trip re-adoption receipts, `✓` resolve, `~` update in place, `+` skill,
`closes:` — and stamps which agent wrote the card. A `✓` question preference ranks only candidates
that already clear raw lexical overlap and two subject-identity anchors; generic lifecycle wording
cannot turn weak overlap into a closure.
(If you install the git commit hook from the KLYPIX app, commit messages also capture automatically,
for any agent. That hook has no CLI installer.)

`brain_challenge` is the other direction: propose a decision and the brain answers with receipts —
prior decisions that deterministically contradict it, standing rules that dispute it, and
approaches tried and reversed, flagged when a different agent wrote them. Evidence is deterministic
only (explicit correction cues, opposite-polarity pairs), never mere topical similarity. Silence
means no contradiction signal was found — not verified consistency. A memory that cannot disagree
with you is flattery.

## Presence and task intent

An active session means an authorized MCP connection or host lifecycle adapter that heartbeated
within the TTL. A row in a recent-chat list is history, not presence.

Each MCP connection registers itself at initialization and removes itself on disconnect; the TTL
covers crashes. Optional host adapters merge into that same logical session rather than
double-counting it, enrich it with intent and files, and remove only their own channel. Sessions
that never declared a task are still counted, but are shown separately as scope-unknown rather than
padding the peer list.

Future hosts get baseline support merely by connecting the MCP server. A deeper adapter can import
`klypix-mcp/presence` and map lifecycle events onto `upsertSession`, `removeSession`,
`peekMessages` and `receiveMessages`. The shared contract accepts `id`, `client`, `surface`,
`model`, `branch`, `intent`, touched `files`, and adapter `channel`.

## Overlap warnings

When two sessions declare overlapping expected files, `brain_sync` surfaces it: the peer, its
declared task, and the exact paths in common. A one-time alert is queued to whichever session got
there first, so a late arrival is not the only one who knows.

This warns. It does not prevent. Nothing blocks an edit, matching is exact-path, and both sides
have to have declared their files for the overlap to be visible at all.

## Handoffs and messages

`brain_message` leaves one-time coordination notes for other sessions. A supported KLYPIX action
offers the note in model-visible context; the next independent supported action replays it and
records an acknowledgement. That acknowledgement proves only that a later action followed the
offer — never that a person read it or that an agent acted on it. The note keeps replaying until the
receiving model calls `brain_message_receipt` with the exact message id and per-recipient offer
token; only that token-bound action records `consumed`. Pending, offered, and acknowledged notes
survive reconnects. Expiry or bounded-capacity eviction records a failed per-recipient receipt
instead of silently looking delivered. The send-time audience is fixed, unresolved targeted sends
fail closed, the core lane is machine-local, notes expire after 24 hours, and they are never written
into the brain.

Durable handoffs go in the brain itself — decisions, findings, open questions and skills captured
as cards, each stamped with the agent that wrote it.

## Evidence-gated completion

When a task publishes a quantified or otherwise machine-checkable claim, it can attach one or more
versioned result manifests to `brain_sync { phase: "complete" }`. Each manifest binds the claim to a
report hash, producer/run provenance, the exact declared task scope, material artifact hashes,
evaluation outputs, public metric wording, input/configuration fingerprints, and named metrics with
counts and tolerances. Matching peer evidence is recorded as corroboration; conflicting or
incomparable evidence returns `needs-reconciliation` and keeps the task scope active.

The gate fails closed. Once a task submits result evidence, it cannot bypass an invalid or
conflicting result by retrying completion without the manifest, and that obligation survives worker
restart, hibernation, and transparent hot-swap. A fresh `phase: "start"` is the explicit boundary for
a new task. The strict schema and reusable validator are exported as `klypix-mcp/result-reconcile`.
Schema-v2 receipts can be converted into commit-bound publication evidence and independently checked
with `klypix-mcp/release-evidence`; legacy schema-v1 results remain usable for coordination but cannot
authorize publication.

## Human control in Klypix

> **Not a second brain. A shared one.**

A brain nobody can inspect is a database with good marketing. The
[KLYPIX desktop app](https://klypix.com) renders the same `brain.klypix` as a living spatial map,
with health, freshness, provenance and orrery lenses, an unresolved-questions triage view, and a
one-click flow that connects a folder's brain to six coding agents. You can read, correct, archive
and re-link what your agents recorded.

The file is co-owned. When the app saves a brain it re-reads the disk copy inside the same capture
lock the agent hooks use and union-merges instead of overwriting, so a card an agent captured while
you had the file open is kept. The merge verifies its own output and aborts rather than emit a file
missing a card. Deletes require an explicit tombstone, so a card that is merely absent is never
inferred as deleted.

The app is a separate, proprietary Windows product. The format, this server and the hooks are
Apache-2.0 and work with no app installed. The app's interface is available in English and Arabic
(some newer panels are still English-only).

## Measure it yourself

Claims about a shared brain — "nothing is lost", "it stays fast" — are unfalsifiable until a
stranger can re-run them, so the benchmark ships in the box:

```bash
npx klypix-mcp bench            # ~25s, or --quick for a smaller run
```

It measures concurrent-write safety across real OS processes, coordination latency, a 1,000-query
soak with drift, and crash safety under SIGKILL — then prints the machine it ran on.

**It runs a negative control first.** Writers that bypass the lock go in before the real ones,
because a "0 lost" number means nothing unless the same harness can *see* a loss. On the reference
machine those unlocked writers lost 17 of 22 cards; the same contention through the lock protocol
lost 0 of 46. If the control ever loses nothing, the run reports **inconclusive** instead of a pass.

Latest results, with hardware and date: [BENCHMARKS.md](BENCHMARKS.md).

## Git and concurrency

One file in your repo, committed with your code — versioned, branchable, portable. So two
developers already share one brain the way they share code: clone, branch, pull.

Be precise about what git does on its own: `brain.klypix` is a binary ZIP. Git shows
`Bin 1308328 -> 1309005 bytes` and produces zero line diffs, so out of the box a conflict on it is
an all-or-nothing take-ours or take-theirs, and a reviewer sees nothing. **Card-level merge safety
comes from the KLYPIX engine** — but since 1.48.0 you can hand that engine to git and read its
output in a PR:

```bash
npx klypix-mcp git-driver install     # once per clone, in any repo
```

That registers a merge driver for `*.klypix` (a per-machine git config line plus a `.gitattributes`
rule you commit) and provisions the engine it needs. When two people change the brain and one
pulls, git calls the engine instead of stopping: new cards from both sides are kept, a card only
one side edited takes that edit, and a card edited differently on both sides keeps **both**
versions — the second as a linked twin, never a silent overwrite. Before returning, the merge
asserts it still contains every surviving card from both sides and refuses rather than hand back a
result that lost one.

The honest boundary: a machine that has not run `git-driver install` simply gets the old binary
conflict — safe degradation, not corruption — and git keeps both parents of every merge, so even a
merge you dislike is reconstructable. It is a merge *on pull*, not live sync.

For review, two commands turn a binary blob into something a human can read:

```bash
npx klypix-mcp diff main            # card-level: what was added / updated / removed
npx klypix-mcp pr-brief origin/main # the brain cards that reference this PR's changed files
```

`diff` compares meaning rather than bytes (a re-save restamps timestamps; that is not a change).
`pr-brief` matches a card's `#file-…` evidence anchors against the changed paths, so a reviewer
sees the decisions already recorded about the code in front of them. `examples/github/brain-pr.yml`
wires both into a sticky pull-request comment using nothing but the checkout and the default
`GITHUB_TOKEN` — no KLYPIX service in the path.

Concurrent sessions serialize behind a capture lock, and each write is a temp file plus an atomic
rename, so a crash mid-write leaves the previous good file intact. The lock is advisory with a
~3.6-second budget: past that, a writer proceeds anyway and flags it in the health log, so
sustained contention can still lose an update. That is a deliberate trade — dropping the markers
was judged worse — but it is a real limit, not a guarantee.

### Restore points

Merging, tidying and gardening are lossless by contract. What none of them can undo is a
*deliberate-looking* deletion: you select a dozen cards, delete them, and save. That is not a bug
to prevent — a brain has to stay correctable, and an uncorrectable memory is worse than none — but
it deserves a way back, because the brain is **co-owned**: hooks, the MCP server, commit capture
and peers on other machines all write to it while nobody is watching, so you can destroy work you
never saw arrive.

So every brain write takes a restore point of the previous bytes first:

```bash
npx klypix-mcp brain-history list          # age, card count, delta against the brain now
npx klypix-mcp brain-history restore <id>  # and this is itself undoable
```

They live under `~/.claude/project-brain/history/`, never beside the brain — nothing lands in git,
in the merge driver's path, or in your diffs, and they survive deletion of the `.klypix` file
itself. Routine writes are deduped and throttled to one a minute; a write that **removes cards** is
never throttled, because that is the case they exist for. Retention is the newest 20 plus one per
day for 14 days, so a slow-burn mistake is still recoverable without unbounded growth. A snapshot
that cannot be written is logged and skipped — it never blocks your save.

Normal canvases deliberately get none of this. One human made every mark and saw every change; the
brain is the file where that is not true.

---

## The command line

The MCP verbs below are what agents call. These are what **you** call:

| Command | What it does |
|---|---|
| `npx klypix-mcp init` | Seed a starter `brain.klypix` here and print an MCP config |
| `npx klypix-mcp install` | Set up everything: machine engine + hooks, then this project — brain, config for the editors you have, merge driver, verified (see Quick start). `--dry-run` (alias `--check`) previews every write and every standing behavior first, writing nothing |
| `npx klypix-mcp link` | Re-project all 14 managed files regardless of what is installed (`--check` audits) |
| `npx klypix-mcp doctor` | One verdict: version, hosts, live sessions, tool count, drift. Exits non-zero — usable as a CI gate |
| `npx klypix-mcp runtime` | Passive per-connection process/RAM attribution (`--json`, optional `--watch seconds`); never kills or deduplicates |
| `npx klypix-mcp conformance` | Launch two real MCP clients against this build and verify coordination behaviour |
| `npx klypix-mcp git-driver` | Register the lossless `.klypix` merge driver for a repo (`status` to check) |
| `npx klypix-mcp git-hook` | Wire the agent-neutral commit-capture hook: rationale-bearing `feat`/`fix`/`perf` commits from any agent or branch card into the brain at commit time (`install`/`remove`/`status`; sessions auto-install it where the hook slots are free). Linked worktrees and OS-temp trees are skipped by default — opt one in with `KLYPIX_BRAIN_WORKTREE_CAPTURE=1`, or silence everything with `KLYPIX_BRAIN_QUIET=1` (see Security and permissions) |
| `npx klypix-mcp brain-history` | Restore points for this brain — `list` them, `restore <id>` one. Written automatically before every brain write, kept machine-local, and never throttled away for a write that removes cards |
| `npx klypix-mcp diff [ref]` | Card-level brain diff against a git ref, as markdown |
| `npx klypix-mcp pr-brief [ref]` | Brain cards referencing the files changed since a ref, as markdown |
| `npx klypix-mcp garden-code` | Print the human approval code `brain_garden` requires |

---

## The 22 tools

*(This heading previously said 26 — a drift bug: the table below has always listed 22,
and 22 is what the code registers and what `install` verifies. Corrected 2026-08-18.)*

| Tool | What it does |
|---|---|
| `brain_ask` | Whole-brain question answering — correction-aware, `as_of` time travel |
| `brain_challenge` | The brain argues back: contradictions with receipts, tried-and-reversed chains, standing rules, other-agent provenance flags |
| `brain_note` | Capture with the full lifecycle — supersede / re-adopt / ✓ resolve / ~ update / 🛠 skill / `closes:` |
| `brain_reconcile` | Proposes stale-vs-correction pairs and unrecorded migrations for a human to confirm |
| `brain_insights` | Hubs, orphaned decisions, stale questions, area sizes |
| `brain_lens` | Machine-readable freshness, provenance, activity, timeline, orrery and unresolved views |
| `brain_garden` | Maintenance pass — proposes first, and cannot apply without an approval code the human generates |
| `brain_doctor` | Self-diagnosis: version, core/enhanced host adapters, active sessions, tool count, projection drift |
| `brain_message` | Session-to-session coordination notes with a fixed send-time audience and per-recipient pending / offer / acknowledgement / consumption / failure receipts (24h TTL, never written into the brain) |
| `brain_message_receipt` | Explicitly record model-side consumption using the exact message id and per-recipient offer token; acknowledgement alone never consumes a note |
| `brain_sync` | Context Gateway: task capsule, active-task peers, exact-file overlap, one-time alerts, timing, and optional result-manifest reconciliation |
| `brain_connect` | Find and draw related-but-unlinked cards |
| `project_map_context` | Read-only, bounded code-graph evidence beside correction-aware brain context, with exact-path review proposals; external artifacts (e.g. Graphify) are supported but never installed or run locally |
| `project_map_scan` | KLYPIX's own zero-install scanner: gitignore-aware file inventory + file-level import edges (relative, tsconfig-alias, and monorepo-workspace imports resolved) written to `klypix-map/graph.json` — which then serves `project_map_context` automatically |
| `project_map_drift` | Read-only drift report: brain cards whose referenced files are gone or moved (with rename candidates), plus a headline when the checkout itself is behind its origin default branch |
| `canvas_view` | Returns the board as a structured render spec plus a text summary, and declares an MCP Apps (SEP-1865) UI resource |
| `read_canvas` | A canvas as markdown (cards, connection graph, `[[links]]`, `#tags`) |
| `search_canvases` | Search across canvases by name and content |
| `search_all_brains` | Cross-project memory search across every registered brain on this machine |
| `create_canvas` | New `.klypix` from cards + connections |
| `add_to_canvas` | Append cards/connections (positions preserved) |
| `list_canvases` | List every `.klypix` in the vault |

Exactly 22, machine-verifiable with `npx klypix-mcp doctor`.

> **`canvas_view`:** no MCP Apps host has been observed rendering the UI resource yet — there is no
> screenshot and no host-level test. Hosts without the extension get clean text, which is the path
> that is actually verified.

**Minimal profile.** Set `KLYPIX_MCP_PROFILE=minimal` in the server's environment (or add
`--minimal` to its launch args) to register only 7 of the 22: `brain_sync`, `brain_note`,
`brain_ask`, `brain_message`, `brain_message_receipt`, `brain_doctor`, `read_canvas`. The
selection is the workflow's own dependency set — the Context Gateway call, durable capture,
deeper retrieval, peer notes and their receipts, the self-check, and the full-brief fallback
the server instructions point to. Everything else (create/add/search/list, the analysis
lenses, `project_map_*`, `canvas_view`) needs the full profile. Schema-size numbers are in
*When NOT to use this*; the registration contract is locked by `test/tool-profile.mjs`.

`brain_doctor`, `brain_lens`, `brain_insights` and `brain_reconcile` are read-only introspection.
`brain_garden`, `brain_reconcile` and `brain_connect` always propose before they apply.
`npx klypix-mcp doctor` gives one verdict and exits non-zero on drift, so it doubles as a CI gate.

## One file you can hold

The whole brain — layout, cards, arrows, and the actual bytes (images, PDFs, audio, video) — is a
single `.klypix` file: a plain ZIP with `manifest.json`, `canvas.json`, one JSON file per card, and
an `assets/` folder. Email it. Git it. Hand it to an agent. A folder of markdown points at its
attachments; this file carries them. (Binaries are embedded by the **KLYPIX app** when you drop a
file onto a canvas; this package's `create_canvas` / `add_to_canvas` / `buildKlypix` write cards and
arrows, not assets — they read assets fine, they just don't create them.)

The parser is this package, Apache-2.0, so any tool or agent can read and write the format. Full
spec: [FORMAT.md](FORMAT.md).

Markdown export, JSON Canvas 1.0 export and direct opening of Obsidian `.canvas` files are features
of the **KLYPIX desktop app**, not of this package — there is no export command among this
package's binaries.

**"Project" means any project.** Two showcase brains ship in the npm package *and* the GitHub repo
under [`examples/`](examples/), identical in engine, different in life:
[`showcase-brain.klypix`](examples/showcase-brain.klypix) is *Aurora*, a fictional weather app
mid-build (radar tiles, API caps, a correction with its receipt), and
[`showcase-wedding.klypix`](examples/showcase-wedding.klypix) is *Our Wedding* (venue, vendors,
guest list, the same correction machinery pointed at a caterer). Same 📌 Focus, same arrows, same
brief. If it has decisions worth keeping, it gets a brain.

They ship inside the tarball, so you can read one straight out of `node_modules`:

```bash
npm i klypix-mcp
npx klypix-read node_modules/klypix-mcp/examples/showcase-brain.klypix
```

Both are text-and-arrows only — 14 cards, 4 arrows, no `assets/` entry — so they demonstrate the
card / container / connection model, not the embedded-binaries half of the format.

## Use it as a library

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';
```

```bash
npx -p klypix-mcp klypix-read   path/to/board.klypix      # → markdown brief
echo '{ "title": "Plan", "cards": [{ "text": "kickoff" }] }' \
  | npx -p klypix-mcp klypix-write --out plan.klypix
```

## Also speaks A2A protocol v0.3.0 — experimental

```bash
npx -p klypix-mcp klypix-a2a --vault ./canvases     # 127.0.0.1:41241
# Agent Card: http://127.0.0.1:41241/.well-known/agent-card.json
```

Eight vault/project skills by default: `make_board`, `remember`, `learn_skill`, `recall`,
`read_canvas`, `list_canvases`, `brain_insights`, `brain_connect`. Machine-wide
`search_all_brains` is a ninth, explicit opt-in via `--allow-cross-project`. Unlike a typical A2A
agent that returns text, KLYPIX returns the `.klypix` board itself as a multimodal artifact. Details:
[A2A.md](A2A.md).

Treat this as a preview: the adversarial A2A smoke test runs in the default `npm test` chain, but
the server has not been exercised against a third-party A2A client.

## Updates — the propagation contract

The MCP entry point is a stable stdio supervisor that keeps the host-owned connection open while a
replaceable worker runs the brain core. A staged update is hash-verified, initialized in parallel,
checked for backward-compatible tool schemas, and handed the current `brain_sync` task scope before
the supervisor switches between requests. Added tools use the standard
`notifications/tools/list_changed` signal. A failed or breaking candidate is rejected while the old
worker keeps serving. A blocked result claim is kept in a durable per-project/session marker, so a
worker replacement cannot turn a failed evidence check into a result-less completion.

Compatible engine updates therefore activate behind the same live connection — no reconnect, no
host restart. Three cases still require a deliberate reconnect or manual install: the one-time
legacy→supervisor migration, a supervisor-code change, and a major or tool-removing release.
`brain_doctor` reports the live supervisor and the automatic-update receipt explicitly.

The supervisor performs **one machine-wide npm version check per 24 hours**, however many sessions
are open. It installs an exact stable same-major release in `--runtime-only` mode, preserving host
settings and project files. The check is detached and fail-open, developer-owned installs are
protected, concurrent sessions collapse behind one lock, and `KLYPIX_AUTO_UPDATE=0` opts out
entirely.

When the optional semantic runtime is already enabled, an update also schedules one detached,
single-writer cache migration across registered brains. That removes the multi-minute first-query
re-index after a model/cache upgrade; cache writes are model-keyed and atomic across concurrent
agent sessions. Lexical-only installs download nothing. Set `KLYPIX_SEMANTIC_WARM_ON_UPDATE=0` to
keep lazy first-use indexing instead.

## Security and permissions

- **Apache-2.0, source public** at [github.com/dahshanlabs/klypix-mcp](https://github.com/dahshanlabs/klypix-mcp).
- **The brain engine makes no network calls and sends no telemetry.** All engine intelligence is
  deterministic and local; the only LLM anywhere is *your* agent. The one exception in this package
  is the supervisor's once-per-24h npm version check described above — turn it off with
  `KLYPIX_AUTO_UPDATE=0`.
- **The optional semantic model runs on device.** Enabling it (or upgrading its model) can fetch
  model weights from Hugging Face; retrieval inference and brain data stay local.
- **Coordination state is local files.** The brain is a file in your repo; the presence lane is a
  file under your home directory. Nothing is uploaded — with one explicit, default-OFF exception:
  the cross-PC presence relay, which (only after per-brain consent in the KLYPIX desktop app)
  shares whitelisted presence fields and the text of one-time coordination notes over that
  brain's cloud channel. KLYPIX does not automatically attach file/card contents, diffs, or screen
  data, but a note relays whatever its sender typed (and automatic overlap alerts name the declared
  file paths involved). The scope is versioned: an older metadata-only grant does not authorize note
  text and must be granted again. No current consent, no frames.
- **One quiet switch silences every automatic writer.** Set `KLYPIX_BRAIN_QUIET=1` (or drop a
  `.klypix-brain-quiet` file in the project root — the env var wins in both directions, so `=0`
  overrides a marker) and nothing KLYPIX-automatic writes into that checkout: no commit capture, no
  Stop-hook capture, no AGENTS.md brief refresh, no managed-file reconcile, no registry
  registration. Reads and session context keep working; each skipped writer leaves one debug line
  on stderr. Made for release builds and any tree that must stay byte-clean.
- **Ephemeral checkouts are not projects.** A linked git worktree, or any tree under the OS temp
  directory, is skipped by commit capture and registry registration by default (and the reconcile
  pass never write-touches it); registry rows whose brain is gone or lives in the OS temp dir are
  pruned automatically. A deliberate long-lived worktree opts back in with
  `KLYPIX_BRAIN_WORKTREE_CAPTURE=1`. Main checkouts are unaffected.
- **`install` writes to your home directory:** `~/.claude/project-brain` (engine + runtime),
  `~/.claude/settings.json` (four hooks — written even if Claude Code is not installed),
  `~/.codex/AGENTS.md` (guidance block), and with `--codex-hooks`, `~/.codex/hooks.json`. It also
  writes `<cwd>/.codex/config.toml` **inside the project** you run it in, and removes any KLYPIX
  entry from the global `~/.codex/config.toml`. **`link` writes 14 files inside the project** you
  run it in; `link --check` audits them without writing.
- **Install honesty:** `install --dry-run` (alias `--check`) prints exactly what would be
  written — files, `settings.json` hook entries, dependency copies — plus the standing
  behaviors an install enables (the 24h auto-updater and the session git-hook auto-install,
  with their off switches), and writes nothing. A real install prints the same one-screen
  summary **before** acting. The complete process inventory, lifecycle and removal path is
  documented in [docs/WHAT_RUNS_ON_YOUR_MACHINE.md](docs/WHAT_RUNS_ON_YOUR_MACHINE.md).
- **Codex hooks require Codex's own trust approval** and are opt-in via `--codex-hooks`.

## Current limitations

Read this section before you build on any of it.

- **Coordination is machine-local and OS-user-local.** The presence lane is a file in your home
  directory. Two developers on two machines do not see each other's sessions, peers, overlaps or
  messages. This package ships the cross-machine presence *core* (`./presence-relay` — versioned
  whitelisted presence metadata plus coordination-note text, a symmetric default-off consent gate,
  loop prevention, stable message IDs and per-recipient-machine acknowledgement primitives), but no
  transport: carrying frames between machines is the desktop app's job. With `klypix-mcp` alone,
  coordination is machine-local.
- **Overlap matching is exact-path, and both sides must declare.** A session that never declares
  its expected files is invisible to overlap detection, and `src/auth/token.ts` does not match a
  rename or a parent directory.
- **Overlap warnings are advisory.** Nothing is blocked. One severity string in the payload reads
  `blocking`; the mechanism is not.
- **Codex has no automatic capture**, with or without `--codex-hooks`. The Codex hook never writes
  the brain.
- **Uninstall does not remove per-project files.** `npx klypix-mcp uninstall` handles the
  machine-global install; the 14 files `link` wrote into each project are listed by
  `npx klypix-mcp link --check` and removed by `uninstall unlink` **per project**, one at a time.
- **Drift detection is single-host and opt-in per card.** It needs an `ev:` anchor written by the
  card's author, and it runs only in the Claude Code hook path — the MCP tools do not compute
  freshness.
- **`search_all_brains` finds nothing for a Cursor-only or Codex-only setup.** The cross-project
  registry is written by the Claude Code hook and only by it. This is a silent empty result, not an
  error.
- **`npx klypix-mcp link` does not manage `CLAUDE.md`.** It manages `AGENTS.md` and seven other
  rules files. Only the desktop app writes `CLAUDE.md`.
- **A fresh `npx klypix-mcp install` gets lexical retrieval.** The optional on-device model is
  deliberately not installed.
- **The capture lock is fail-open** past ~3.6 seconds of contention (see *Git and concurrency*).
- **`test/` is not in the published tarball.** Run the suite from a clone. The publish workflow
  *does* gate on it — a `gate` job runs `npm ci`, asserts the test chain is intact, runs `npm test`,
  validates the version/tag, and checks the packed tarball; `publish` declares `needs: gate`, so a
  red gate means npm never sees a tarball.
- **`canvas_view`'s MCP Apps UI has never been verified on a real Apps host.**

## Numbers and methodology

Every number here is measured on our own project brain. Nothing below is published, benchmarked or
independently validated.

- **Dogfood scale.** KLYPIX itself is built with its own brain: **2,479 cards and 2,018
  connections**, written by multiple concurrent agent sessions, receipts in the file. Current as of
  2026-08-13.
- **Recall.** 73% of past decisions recovered with one search round, 55% brief-only, 0% cold.
  Caveat that travels with it: n=20, our own brain, self-authored questions, LLM-judged.
- **Ranker.** With the production embedder (the eval harness was fixed 2026-08-10 — it had been
  measuring a vector space the product does not use): recall@5 **30%**, recall@10 35%, recall@20
  45%, MRR 0.22 of the true source card on n=20 frozen human-paraphrase questions. Lexical-only
  scores 0% on the same set. The previously published "15% → 40% with the reranker" is **retired**:
  re-measured validly, the reranker *reduced* recall@5 to 25% and now ships off by default. At n=20
  every one of these percentages carries a ±20-point 95% confidence interval — treat them as
  directional until the larger frozen set lands. The regressions are recorded next to the wins:
  contextual prefixes on short cards, and the reranker itself.
- **What we do not publish.** No download count: this package's own 24-hour auto-updater generates
  most of it, so it is not a user count. No adoption, team or customer figures. No brief-token
  figure — the last one was measured at ~600 cards and is stale at 2,479.
- **The eval harness is not in this repo.** It lives in the private KLYPIX desktop repository. The
  numbers above are ours to defend, not yours to reproduce from here — treat them accordingly.

## Uninstall

```bash
npx klypix-mcp uninstall --check   # full inventory — writes nothing
npx klypix-mcp uninstall           # asks, then removes the machine-global install
npx klypix-mcp uninstall unlink    # run inside a project: removes the files `link` wrote there
```

It strips only KLYPIX's own entries — every other hook and setting in
`~/.claude/settings.json` stays — backs up each file it edits, and **never deletes a `.klypix`**.
`--yes` skips the prompt for scripted removal. What is there to remove in the first place —
every process, its lifecycle, and every standing behavior's off switch — is documented in
[docs/WHAT_RUNS_ON_YOUR_MACHINE.md](docs/WHAT_RUNS_ON_YOUR_MACHINE.md).

Your `brain.klypix` is yours — it is a plain ZIP and stays readable with or without this package.

## Contributing

Issues and pull requests: [github.com/dahshanlabs/klypix-mcp](https://github.com/dahshanlabs/klypix-mcp).
Questions or feedback: [hello@klypix.com](mailto:hello@klypix.com).

The repository carries 89 test files: 83 listed directly in `scripts.test`, plus the
`pretest` workflow gate (the bench, opt-in soak, shared harness and snapshot helpers run
separately). *(Counts re-measured 2026-08-18 — the previous "68/62" had drifted.)* Together they cover the presence
lane and its cross-machine relay, the Context Gateway, supervisor hot-swap, auto-update, retrieval
quality, decay, challenge, lenses, the format guard, the git tools (including a real `git merge`
through the merge driver), uninstall, the tool profiles, the install dry-run, and conformance. Run them with `npm test` from a clone — they
are not in the published tarball, though the publish workflow does run them as a gate. There is a known intermittent Windows `EPERM` flake on rename in
`test/mcp-supervisor.mjs`.

## Why this exists

A model provider can fix continuity inside its own sessions, and several are. None of them will
ever carry a competitor's context. Cross-tool, cross-agent and cross-provider understanding is the
seam that stays open — so it should live in a file you own, in your repo, that any agent can read
and write.

**Your project, your file, any supported agent, offline.**

---

## Licence

This package — the MCP server, the agent hooks and the `.klypix` format parser — is
**Apache-2.0** ([`LICENSE`](LICENSE), attribution in [`NOTICE`](NOTICE)). Versions up to and
including **1.28.0** were published under MIT and remain available under those terms; **1.29.0** was
the first Apache-2.0 release.

The KLYPIX desktop app and the klypix.com web app are **separate, proprietary products** — their
source is not public, and their terms do not restrict anything Apache-2.0 grants you here. This
package works with no app installed.

Apache-2.0 © [Dahshan Labs](https://klypix.com).
