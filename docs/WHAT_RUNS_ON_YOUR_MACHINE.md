# What runs on your machine

`npx klypix-mcp install` is not only a set of file copies: it wires lifecycle
hooks and enables two standing behaviors. This page is the complete inventory —
every process this package starts, what each one does, how long it lives, and
how to stop or remove all of it.

Two commands pair with this page:

```bash
npx klypix-mcp install --dry-run   # everything install WOULD write on YOUR machine — zero writes
npx klypix-mcp uninstall --check   # everything currently installed — full inventory, zero writes
```

## The process tree

When an MCP host (Claude Code, Codex, Cursor, Cline, VS Code, Claude Desktop …)
opens its KLYPIX connection, this is what actually runs:

```text
<your editor / agent CLI>                        (the host — not ours)
└─ node klypix-mcp-server.mjs      SUPERVISOR    one per MCP connection
   └─ node klypix-mcp-worker.mjs   WORKER        the actual MCP server (the tools)
      ⋯ spawns, detached ⋯
        node mcp-auto-update.mjs   UPDATE HELPER short-lived; at most one real
                                                 registry check per machine per 24h
```

Outside the MCP connection, three short-lived entry points exist:

```text
node global-brain-hook.mjs         CLAUDE HOOKS   4 invocations per Claude Code session event
node brain-git-hook.mjs            GIT HOOK       per commit/merge, in repos where it is installed
node klypix-semantic-warm.mjs      SEMANTIC WARM  detached, once per install — ONLY if you
                                                  previously enabled the optional local model
```

Several editors open at once means several supervisor+worker pairs — one per
connection. `npx klypix-mcp runtime` attributes them (process, RAM, vault)
without killing anything, and reports parallel sessions as parallel sessions
rather than calling them duplicates.

### Supervisor — `klypix-mcp-server.mjs`

- **Started by:** your MCP host, from the entry in the project's MCP config.
- **Does:** owns the host's stdio connection and delegates protocol work to a
  replaceable worker, so a compatible engine update can be validated and
  hot-swapped **behind** the live connection instead of asking you to restart
  the editor. A failed or tool-incompatible candidate is rejected while the old
  worker keeps serving.
- **Lives:** exactly as long as the host keeps the connection open. When the
  host exits or closes stdio, the supervisor exits.

### Worker — `klypix-mcp-worker.mjs`

- **Started by:** the supervisor (or directly, in a repo checkout).
- **Does:** registers the MCP tools and serves them. Coordination state it
  touches is local files only: the project's `brain.klypix` and the presence
  lane under `~/.claude/project-brain/`. The engine makes no network calls.
- **Also:** upserts a `{pid, version, vault}` heartbeat into
  `~/.claude/project-brain/.running-servers.json` every 30 s so `brain_doctor`
  can compare the *running* server against the *installed* one, and polls the
  supervisor's pid so a dead supervisor can never pin an orphaned worker (and
  its RAM) forever.
- **Lives:** as long as the supervisor does; removes its own heartbeat row on
  exit.
- **Smaller surface on request:** `KLYPIX_MCP_PROFILE=minimal` (or `--minimal`)
  registers 7 tools instead of 22 — see the README's *What connecting costs*.

### Update helper — the 24-hour auto-updater

- **Started by:** the worker (~2 s after the handshake, re-checked hourly) and
  the supervisor. A machine-wide stamp (`.autoupdate-check.json`) plus a lock
  (`.autoupdate.lock`) collapse every session on the machine into **at most one
  real check per 24 hours** — the spawn is skipped entirely when the stamp says
  a check is not due.
- **Does:** one bounded HTTPS request to `registry.npmjs.org` for the latest
  version tag (response capped at 128 KB). If a newer **stable, same-major**
  release exists, it installs that exact version in runtime-only mode —
  preserving `~/.claude/settings.json` and every project file byte — then lets
  the supervisor compatibility-gate and hot-swap it. A new major is never
  auto-installed; a dev-owned (source-deployed) install is never replaced.
- **Lives:** seconds. Detached (`stdio: ignore`, cwd = the OS temp dir), so it
  can never delay or break the MCP connection; every failure mode is fail-open.
- **This is the only network call in a default install.** The brain engine
  itself makes none and sends no telemetry. (Separately: *enabling* the
  optional on-device semantic model — which a default install never does —
  fetches its model weights from Hugging Face at that moment.)
- **Off switch:** `KLYPIX_AUTO_UPDATE=0` in the environment (also honoured:
  `off`, `false`, `no`). Nothing else re-enables it.

### Semantic warm — optional-model cache migration

- **Started by:** the installer, once, **only** when the optional on-device
  semantic runtime is already present under
  `~/.claude/project-brain/semantic/` — a fresh install is lexical-only and
  never starts this.
- **Does:** re-indexes registered brains' embedding caches after a model/cache
  contract upgrade, so the first semantic question is not a multi-minute stall.
- **Off switch:** `KLYPIX_SEMANTIC_WARM_ON_UPDATE=0`.

### Claude Code lifecycle hooks — `global-brain-hook.mjs`

- **Wired by:** `install`, into `~/.claude/settings.json` (four entries:
  SessionStart brief, UserPromptSubmit retrieval, Stop capture, PostToolUse
  live). The installer backs the file up first and refuses to touch a file that
  is not valid JSON.
- **Does:** each hook is one short-lived `node` process on that session event —
  there is no resident hook daemon. In a project with no `./brain.klypix` the
  hook exits almost immediately.
- **Side behavior to know about:** on session start, in a repo whose root holds
  a brain, the hook **auto-installs the git commit-capture hook** (below) when
  the hook slots are free. It writes only files it fully owns and never edits a
  foreign hook.
- **Remove:** `npx klypix-mcp uninstall` strips exactly the KLYPIX entries from
  `settings.json` and leaves every other hook and setting in place.

### Git commit-capture hook — `brain-git-hook.mjs`

- **Installed by:** `npx klypix-mcp git-hook install` explicitly, or
  automatically at session start (see above), as a marker-fenced block in
  `.git/hooks/post-commit` and `post-merge`.
- **Does:** on each commit/merge, one short-lived process cards
  rationale-bearing `feat`/`fix`/`perf` commits into `./brain.klypix`. Not
  blind capture — a commit without a rationale body (≥ 12 chars) is ignored.
- **Off switches:** `KLYPIX_GIT_CAPTURE=0` disables the auto-install
  machine-wide; `npx klypix-mcp git-hook remove` removes it from one repo *and
  sticks* (a `.claude/git-capture-optout` marker stops sessions from silently
  re-wiring it).

### What never runs

- No resident daemon, service, tray process, or scheduled OS task. Everything
  above is either connection-scoped (supervisor/worker) or event-scoped
  (hooks, helper).
- The A2A server (`npx -p klypix-mcp klypix-a2a`) runs **only** when you launch
  it yourself.
- No telemetry, ever. In a default install the auto-updater's version check is
  the single outbound request, and it carries no payload about you or your
  projects. The only other network activity possible is the one-time model
  download if you explicitly enable the optional semantic runtime.

## Standing behaviors and their switches

| Behavior | Cadence | Scope | Off switch |
|---|---|---|---|
| npm version check + same-major runtime-only self-update | ≤ 1/24 h, machine-wide | `~/.claude/project-brain` only | `KLYPIX_AUTO_UPDATE=0` |
| Git commit-capture hook auto-install at session start | per session, only where hook slots are free | repos whose root holds a brain | `KLYPIX_GIT_CAPTURE=0` (machine) · `git-hook remove` (per repo, sticks) |
| Claude Code lifecycle hooks | per session event, short-lived | projects with `./brain.klypix` | `uninstall` (removes only KLYPIX entries) |
| Worker heartbeat registry | every 30 s while connected | one JSON file in `~/.claude/project-brain` | ends with the connection |
| Semantic warm after updates | once per install, opt-in-model users only | registered brains' caches | `KLYPIX_SEMANTIC_WARM_ON_UPDATE=0` |

## Observe it

```bash
npx klypix-mcp runtime            # who is running, per connection, with RAM — read-only
npx klypix-mcp doctor             # installed vs running version, hooks, sessions, drift
npx klypix-mcp install --dry-run  # what a (re)install would change — zero writes
```

## Stop and remove everything

```bash
npx klypix-mcp uninstall --check   # full machine inventory first — writes nothing
npx klypix-mcp uninstall           # remove the machine-global install (asks; --yes for scripts)
npx klypix-mcp uninstall unlink    # inside a project: remove the files `link` wrote there
```

The uninstaller strips only KLYPIX-owned entries, backs up each file it edits,
and **never deletes a `.klypix`** — `brain.klypix` is a plain ZIP and stays
readable with or without this package. Per-project files are per-project:
run `unlink` in each project that was linked. Running MCP servers exit when
their host closes the connection; there is nothing else to kill.
