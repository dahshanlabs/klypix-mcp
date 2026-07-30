# Every project gets a brain.

**A portable project workspace with a shared brain.**
*One project. One shared understanding.*

**One shared project brain for multi-agent coding.** `klypix-mcp` gives supported coding agents
and humans one versioned `brain.klypix` in your repo, containing current decisions, corrections,
evidence anchors, open questions, active work, and handoffs. Agents read it and write to it over
MCP. You read it and correct it in the [KLYPIX app](https://klypix.com).

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
It verifies 7 coordination behaviours — not the 18 tools, and not the retrieval engine.

---

## Quick start

**Claude Code + Codex — one machine-global command:**

```bash
npx klypix-mcp install
```

This copies the engine and a local MCP runtime into `~/.claude/project-brain`, wires Claude Code's
four lifecycle hooks, and wires Codex's project MCP connection. It is machine-global: every project
on that machine with a `./brain.klypix` is covered. It does **not** set up Cursor, Cline, Windsurf,
Copilot, Gemini CLI or Aider — those need `link`.

Optional, opt-in, and approved inside Codex itself:

```bash
npx klypix-mcp install --codex-hooks
```

Six Codex lifecycle hooks that add automatic per-prompt context injection and a pre-edit
file-overlap warning. Codex owns the trust decision and will ask you to review them.
`brain_doctor` reports this layer separately as off, execution-unverified, or active. Even with it
on, **Codex never captures decisions automatically** — the Codex hook never writes the brain.

**Every other agent tool — one command per project:**

```bash
npx klypix-mcp link
```

Writes 14 managed, hash-stamped files: MCP server config for six hosts, plus rules files for
eight. Managed blocks are merged into your existing instruction files and never clobber your
content.

```bash
npx klypix-mcp link --check    # audits without writing; exits non-zero on drift
```

> Use that exact form. The standalone `klypix-link` binary currently drops the `--check` flag and
> writes instead (`bin/klypix-link.mjs:23`). Do not wire `npx -p klypix-mcp klypix-link --check`
> into CI until that is fixed.

**Give a project a brain** by dropping a `brain.klypix` into it — the
[KLYPIX app](https://klypix.com) does it in one click (*Save canvas as project brain*), or
`create_canvas` makes one from any agent.

---

## How the brain works

The difference from a folder of notes is not the shape — it is that this memory is a mechanism,
not a filing convention.

- **Decisions have a lifecycle.** A new decision that contradicts an old one supersedes it. The
  stale card is archived with an arrow and a date, never deleted, and later answers surface the
  correction rather than the corpse.
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
  `brain_ask` and `search_all_brains` blend semantic similarity with lexical scoring and rerank
  with a cross-encoder — still entirely on your machine. Without it, retrieval degrades cleanly to
  lexical. `npx klypix-mcp install` deliberately does not install that model, so a fresh install
  is lexical.

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

`install` and `link` are different things and are not interchangeable: `install` is machine-global
and only touches Claude Code and Codex; `link` is per project and is what wires everything else.

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
changes, and on completion. The gateway capsule is lexical-fast by design.

Briefs are **not** injected automatically on Cursor, Cline, Copilot, Gemini CLI or Antigravity —
there are no lifecycle hooks on those hosts.

## Capture and corrections

On Claude Code, decisions are captured automatically at turn end from inline `🧠 BRAIN [Area]:`
markers in the transcript, deduped, under a capture lock.

On every other host, capture is explicit: `brain_note` runs the same capture engine as the hooks —
dedup, supersession, `✓` resolve, `~` update in place, `+` skill, `closes:` — and stamps which
agent wrote the card. (If you install the git commit hook from the KLYPIX app, commit messages also
capture automatically, for any agent. That hook has no CLI installer.)

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

`brain_message` leaves one-time coordination notes for other sessions. They arrive on the peer's
next KLYPIX action, expire after 24 hours, and are never written into the brain. Delivery is
best-effort-proactive through MCP logging (which some hosts hide) and in-band on the peer's next
action. A peer that stays offline past the TTL misses the note.

Durable handoffs go in the brain itself — decisions, findings, open questions and skills captured
as cards, each stamped with the agent that wrote it.

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

## Git and concurrency

One file in your repo, committed with your code — versioned, branchable, portable.

Be precise about what git does here: `brain.klypix` is a binary ZIP. Git shows
`Bin 1308328 -> 1309005 bytes`, produces zero line diffs, and a merge conflict on it is an
all-or-nothing take-ours or take-theirs. You cannot review a brain change in a PR diff. **All
card-level merge safety comes from the KLYPIX engine, not from git.**

Concurrent sessions serialize behind a capture lock, and each write is a temp file plus an atomic
rename, so a crash mid-write leaves the previous good file intact. The lock is advisory with a
~3.6-second budget: past that, a writer proceeds anyway and flags it in the health log, so
sustained contention can still lose an update. That is a deliberate trade — dropping the markers
was judged worse — but it is a real limit, not a guarantee.

---

## The 18 verbs

| Tool | What it does |
|---|---|
| `brain_ask` | Whole-brain question answering — correction-aware, `as_of` time travel |
| `brain_challenge` | The brain argues back: contradictions with receipts, tried-and-reversed chains, standing rules, other-agent provenance flags |
| `brain_note` | Capture with the full lifecycle — supersede / ✓ resolve / ~ update / 🛠 skill / `closes:` |
| `brain_reconcile` | Proposes stale-vs-correction pairs and unrecorded migrations for a human to confirm |
| `brain_insights` | Hubs, orphaned decisions, stale questions, area sizes |
| `brain_lens` | Machine-readable freshness, provenance, activity, timeline, orrery and unresolved views |
| `brain_garden` | Maintenance pass — proposes first, and cannot apply without an approval code the human generates |
| `brain_doctor` | Self-diagnosis: version, core/enhanced host adapters, active sessions, tool count, projection drift |
| `brain_message` | Session-to-session coordination notes (24h TTL, never written into the brain) |
| `brain_sync` | Context Gateway: task capsule, active-task peers, exact-file overlap, one-time alerts, timing |
| `brain_connect` | Find and draw related-but-unlinked cards |
| `canvas_view` | Returns the board as a structured render spec plus a text summary, and declares an MCP Apps (SEP-1865) UI resource |
| `read_canvas` | A canvas as markdown (cards, connection graph, `[[links]]`, `#tags`) |
| `search_canvases` | Search across canvases by name and content |
| `search_all_brains` | Cross-project memory search across every registered brain on this machine |
| `create_canvas` | New `.klypix` from cards + connections |
| `add_to_canvas` | Append cards/connections (positions preserved) |
| `list_canvases` | List every `.klypix` in the vault |

Exactly 18, machine-verifiable with `npx klypix-mcp doctor`.

> **`canvas_view`:** no MCP Apps host has been observed rendering the UI resource yet — there is no
> screenshot and no host-level test. Hosts without the extension get clean text, which is the path
> that is actually verified.

`brain_doctor`, `brain_lens`, `brain_insights` and `brain_reconcile` are read-only introspection.
`brain_garden`, `brain_reconcile` and `brain_connect` always propose before they apply.
`npx klypix-mcp doctor` gives one verdict and exits non-zero on drift, so it doubles as a CI gate.

## One file you can hold

The whole brain — layout, cards, arrows, and the actual bytes (images, PDFs, audio, code) — is a
single `.klypix` file: a plain ZIP with `manifest.json`, `canvas.json`, one JSON file per card, and
an `assets/` folder. Email it. Git it. Hand it to an agent. A folder of markdown points at its
attachments; this file carries them.

The parser is this package, Apache-2.0, so any tool or agent can read and write the format. Full
spec: [FORMAT.md](FORMAT.md).

Markdown export, JSON Canvas 1.0 export and direct opening of Obsidian `.canvas` files are features
of the **KLYPIX desktop app**, not of this package — there is no export command among this
package's binaries.

**"Project" means any project.** Two showcase brains ship in the GitHub repo under
[`examples/`](examples/), identical in engine, different in life:
[`showcase-brain.klypix`](examples/showcase-brain.klypix) is *Aurora*, a fictional weather app
mid-build (radar tiles, API caps, a correction with its receipt), and
[`showcase-wedding.klypix`](examples/showcase-wedding.klypix) is *Our Wedding* (venue, vendors,
guest list, the same correction machinery pointed at a caterer). Same 📌 Focus, same arrows, same
brief. If it has decisions worth keeping, it gets a brain.

## Use it as a library

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';
```

```bash
npx -p klypix-mcp klypix-read   path/to/board.klypix      # → markdown brief
echo '{ "title": "Plan", "cards": [{ "text": "kickoff" }] }' \
  | npx -p klypix-mcp klypix-write --out plan.klypix
```

## Also speaks A2A (Agent-to-Agent) — experimental

```bash
npx -p klypix-mcp klypix-a2a --vault ./canvases     # 127.0.0.1:41241
# Agent Card: http://127.0.0.1:41241/.well-known/agent-card.json
```

Nine skills: `make_board`, `remember`, `learn_skill`, `recall`, `read_canvas`, `list_canvases`,
`brain_insights`, `search_all_brains`, `brain_connect`. Unlike a typical A2A agent that returns
text, KLYPIX returns the `.klypix` board itself as a multimodal artifact. Details:
[A2A.md](A2A.md).

Treat this as a preview: the A2A smoke test is not in the default `npm test` chain, and it has not
been exercised against a third-party A2A client.

## Updates — the propagation contract

The MCP entry point is a stable stdio supervisor that keeps the host-owned connection open while a
replaceable worker runs the brain core. A staged update is hash-verified, initialized in parallel,
checked for backward-compatible tool schemas, and handed the current `brain_sync` task scope before
the supervisor switches between requests. Added tools use the standard
`notifications/tools/list_changed` signal. A failed or breaking candidate is rejected while the old
worker keeps serving.

Compatible engine updates therefore activate behind the same live connection — no reconnect, no
host restart. Three cases still require a deliberate reconnect or manual install: the one-time
legacy→supervisor migration, a supervisor-code change, and a major or tool-removing release.
`brain_doctor` reports the live supervisor and the automatic-update receipt explicitly.

The supervisor performs **one machine-wide npm version check per 24 hours**, however many sessions
are open. It installs an exact stable same-major release in `--runtime-only` mode, preserving host
settings and project files. The check is detached and fail-open, developer-owned installs are
protected, concurrent sessions collapse behind one lock, and `KLYPIX_AUTO_UPDATE=0` opts out
entirely.

## Security and permissions

- **Apache-2.0, source public** at [github.com/dahshanlabs/klypix-mcp](https://github.com/dahshanlabs/klypix-mcp).
- **The brain engine makes no network calls and sends no telemetry.** All engine intelligence is
  deterministic and local; the only LLM anywhere is *your* agent. The one exception in this package
  is the supervisor's once-per-24h npm version check described above — turn it off with
  `KLYPIX_AUTO_UPDATE=0`.
- **The optional semantic model runs on device.** No cloud inference on any retrieval path.
- **Coordination state is local files.** The brain is a file in your repo; the presence lane is a
  file under your home directory. Nothing is uploaded.
- **`install` writes to your home directory:** `~/.claude/project-brain` (engine + runtime),
  `~/.claude/settings.json` (four hooks — written even if Claude Code is not installed) and Codex
  config. **`link` writes 14 files inside the project** you run it in; `link --check` audits them
  without writing.
- **Codex hooks require Codex's own trust approval** and are opt-in via `--codex-hooks`.

## Current limitations

Read this section before you build on any of it.

- **Coordination is machine-local and OS-user-local.** The presence lane is a file in your home
  directory. Two developers on two machines do not see each other's sessions, peers, overlaps or
  messages. There is no cross-machine or cross-team coordination today.
- **Overlap matching is exact-path, and both sides must declare.** A session that never declares
  its expected files is invisible to overlap detection, and `src/auth/token.ts` does not match a
  rename or a parent directory.
- **Overlap warnings are advisory.** Nothing is blocked. One severity string in the payload reads
  `blocking`; the mechanism is not.
- **Codex has no automatic capture**, with or without `--codex-hooks`. The Codex hook never writes
  the brain.
- **There is no uninstall command.** Removing Klypix means hand-editing `~/.claude/settings.json`,
  `~/.codex/config.toml` and `~/.codex/hooks.json`, deleting `~/.claude/project-brain`, and
  deleting the 14 per-project files. The removal primitives exist in the source but no CLI reaches
  them yet.
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
- **Tests are developer-run, not CI-gated.** The npm publish workflow runs no tests, and `test/` is
  not in the published tarball.
- **`canvas_view`'s MCP Apps UI has never been verified on a real Apps host.**

## Numbers and methodology

Every number here is measured on our own project brain. Nothing below is published, benchmarked or
independently validated.

- **Dogfood scale.** KLYPIX itself is built with its own brain: **1,523 cards and 1,404
  connections**, written by multiple concurrent agent sessions, receipts in the file. Current as of
  2026-07-30.
- **Recall.** 73% of past decisions recovered with one search round, 55% brief-only, 0% cold.
  Caveat that travels with it: n=20, our own brain, self-authored questions, LLM-judged.
- **Ranker.** recall@5 of the true source card went **15% → 40%** across two upgrades (n=20 frozen
  human-paraphrase questions), measured with the optional on-device reranker enabled. The
  experiment that *regressed* — contextual prefixes on short cards — is recorded next to the wins.
- **What we do not publish.** No download count: this package's own 24-hour auto-updater generates
  most of it, so it is not a user count. No adoption, team or customer figures. No brief-token
  figure — the last one was measured at ~600 cards and is stale at 1,523.
- **The eval harness is not in this repo.** It lives in the private KLYPIX desktop repository. The
  numbers above are ours to defend, not yours to reproduce from here — treat them accordingly.

## Uninstall

There is no uninstall command yet. To remove Klypix by hand:

```bash
rm -rf ~/.claude/project-brain
# then remove the klypix hook entries from ~/.claude/settings.json
# and the klypix MCP entry from ~/.codex/config.toml (and ~/.codex/hooks.json if you used --codex-hooks)
npx klypix-mcp link --check      # lists the 14 managed files in a project, so you know what to delete
```

Your `brain.klypix` is yours — it is a plain ZIP and stays readable with or without this package.

## Contributing

Issues and pull requests: [github.com/dahshanlabs/klypix-mcp](https://github.com/dahshanlabs/klypix-mcp).

The repository carries 28 test files covering the presence lane, Context Gateway, supervisor
hot-swap, auto-update, retrieval quality, decay, challenge, lenses and conformance. Run them with
`npm test` from a clone — they are not in the published tarball and the publish workflow does not
run them. There is a known intermittent Windows `EPERM` flake on rename in
`test/mcp-supervisor.mjs`.

## Why this exists

A model provider can fix continuity inside its own sessions, and several are. None of them will
ever carry a competitor's context. Cross-tool, cross-agent and cross-provider understanding is the
seam that stays open — so it should live in a file you own, in your repo, that any agent can read
and write.

**Your project, your file, any supported agent, offline.**

---

Apache-2.0 © [Dahshan Labs](https://klypix.com). The KLYPIX desktop app is a separate, proprietary
product — the format and this server are fully open and work without it.
