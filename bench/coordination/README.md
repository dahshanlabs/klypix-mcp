# Coordination bench

Does a coding agent do the right thing when **another session** — a different
agent, vendor, or a session that has already ended — knows something it needs?

This kit measures that with real agents on real repos. It is built so the
numbers can be published: every task is graded by a hidden test, every
condition faces the same history, and anything that was not measured is
reported as **not measured**.

## The scenarios

### Round 1

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S1 | **A decision changed today** | New endpoints use bearer tokens; the "cookie session" note is out of date | Hidden test: logout revokes the token and sets no cookie |
| S2 | **Two sessions on overlapping work** | A session is rewriting `lib/price.js` on branch `a/currency` right now | Hidden test **and** `git merge-tree` against `a/currency`: a conflict fails the strict grade. **Handled** counts a conflict avoided *or named in the agent's final message* |
| S3 | **A note left by a session that has ended** | Run `backfill:emails` before `migrate:002` | Hidden test: the backfill is in the plan, before the migration |
| S4 | **A root cause that is in the code after all** _(control)_ | In production the CDN strips `x-user-id`, so the cache must key on `req.session.uid`. Meant as knowledge from another session; both pilot agents inferred it from the code with no channel. Kept as a **control**: every condition should pass it | Hidden test: behind the CDN users are isolated **and** a user's own profile stays cached |

### Round 2 — what a notes file cannot do by construction

The pilot showed that when the other session has already written one short,
correct sentence in the right file before the agent starts, a notes file ties
KLYPIX. Round 2 keeps the same fairness rules but tests what a file lacks:
expiry (S5), arrival during the task (S6), and ranking inside a long history
(S7). S8 is a calibration row.

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S5 | **A WIP note that outlived its session** | Nothing — the session that wrote "do not touch `lib/report.js`" two days ago is gone. The knowledge is an **absence**: nobody is on the file. The task names only the symptom, and the dead note offers a path the task does not forbid: fix the caller, leave `lib/report.js` alone. A tidy notes file removed the line. An appended one would carry it unchanged — identical to no channel, so that cell is n/a. In KLYPIX the file **still carries the line** (KLYPIX never edits the notes file), the ended session's lane row was written two days old, and the product's own expiry hides it: the empty lane has to beat the dead note | Hidden test calls `lib/report.js` directly, so only the root-cause fix passes. **Stale** = the function still left alone **and** either the final message cites the note, or the agent worked around it while the note was in front of it. A caller-side fix where the notes never held the line is recorded as `workedAround`, not as deference. The no-channel gate (2026-10-12): 0/10 fixed the root cause — both agents obeyed the dead note every time |
| S6 | **A decision made while the agent is working** | Nothing at start. **At the agent's first file write** — seen in its own output stream, so every condition pays the same and KLYPIX's start-up is never inside the window — finance settles the display format. The notes file changes on disk under the agent; KLYPIX adds a card and posts a note the agent gets at its next call (whether the note was posted is recorded). Copy-paste is n/a. The task asks to "follow the project's display conventions", so the decision clarifies the task rather than overruling the user. The fact states the rule with an amount no test uses | Hidden test on an input neither the visible test nor the fact uses: `display` is `"2144 USD"` (a thousands separator is accepted). **Stale** is judged on what the function returns (a `$` or a decimal point), by running it. **Handled** = applied the decision, or surfaced it with its source — scored only where the decision was delivered. A run in which no file write was seen (the fact never fired), or where the fact landed after the agent's last action, is **invalid**, not a fail |
| S7 | **A decision buried in six months of notes** | The September retry rule was reversed late in September, in the log's own terse register, without naming the rule it replaces; two more weeks of notes followed, including an email sender that *does* retry. The file holds ~300 dated lines (2–3 per working day since April); the brain holds the same ~300 as cards, the reversal linked to what it replaced. At ~20 KB the whole log fits in both agents' prompts, so S7 compares **in-prompt text against a channel the agent has to query**, not a search against a search | Hidden test: a failed send is not retried and is dead-lettered once (the event itself or a record wrapping it; a rethrow is tolerated). **Stale** = the sender was called more than once on failure, counted by running it |
| S8 | **A partner limit nothing in the repository shows** _(calibration)_ | The partner drops request ids over 24 characters, with a hyphen, or without the client prefix `p7` — learned from their support, in no file, and the visible tests pass. A kept notes file carries this as well as KLYPIX does: S8 checks that **delivery** works (no channel should fail, every delivering channel should pass), not which channel is better | Hidden test: ids are `p7` + up to 22 alphanumerics and unique. **Stale** = a 400 was retried (the sender called more than once), counted by running it |

### Round 3 — when nobody writes a note

Rounds 1–2 always had the other session write the right note. Real sessions
usually write nothing. Round 3 holds the other session to that, and asks what
KLYPIX carries **on its own**: a stopped session's work record (its Stop hook
records its last prompt, its last reply and its commits) and a live session's
presence. Each keeps a generous notes condition (the session *did* write the
note) as the upper bar; no channel is the realistic "nobody wrote it down".

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S9 | **Continue the work a stopped session left** | A session stopped halfway through cursor pagination at its usage limit and wrote no note. The page sizes (default 20, max 50) and the response shape it agreed with its human live only in its last prompt and reply. The agent is asked to "continue where it left off". KLYPIX holds no card: only the automatic work record | Hidden test: default page 20, never more than 50, cursors visit every user once and end. **Stale** = built pagination with other sizes, by running it |
| S10 | **A live session that has written nothing** | Another session is rewriting `lib/tax.js` on its own branch right now and never wrote a note. KLYPIX shows its presence (intent, files, branch); a notes file shows it only if it was written down | Hidden test: the rate is 8% **and** the overlap is handled (no conflict with the live branch, or named to the human). **Stale** = a silent conflict |
| S5b | **A "hands off" note whose work is finished** _(held out)_ | Held out from S5, the case klypix-mcp 1.100.0's fix was built from: a different file, section and register, a person's name instead of a session id, a session that stopped five hours ago and left a work record. The refactor the note protected is finished and on main | Hidden test calls `roundCents` directly, so only the root-cause fix passes. **Stale** as in S5 |
| S5c | **The same note, still valid** _(harm check)_ | Byte-identical note; this time the refactor is half done on its own branch and the reservation protects real work. The original 1.100.0 build declared stopped-session notes inapplicable; current builds inspect local work and preserve instruction authority. Historical runs measure their recorded build, not this revised behavior | Hidden test on the invoice, **and** no conflict with the in-progress branch. **Stale** = edited the locked file into a conflict without saying so |

The hidden tests are written into the repo only **after** the agent finishes,
so the agent cannot read or game them. There is no LLM judge.

## The conditions

| Condition | How the other session's knowledge reaches the agent |
|---|---|
| `none` | It does not. The project notes still carry whatever they said before. |
| `relay` | A teammate pasted the facts into the prompt ("A teammate pasted this from another agent session: …"). Meant as an **upper bound**, counting one human relay per fact — but it is a second-hand claim, and an agent may weigh it against a written record that contradicts it (round 2, S7). |
| `agents-md-kept` | The other session edited `AGENTS.md` / `CLAUDE.md` tidily (the out-of-date line removed). |
| `agents-md-appended` | The other session appended to `AGENTS.md` / `CLAUDE.md` (the out-of-date line left in). |
| `klypix` | The other session used KLYPIX: decisions as brain cards (a replaced one archived with a "superseded by" arrow), live work as a lane row, an ended session as an expired row. **KLYPIX never edits the notes file**: whatever it said before is still there, and KLYPIX's signal has to beat it. The agent gets **only the klypix-mcp server** (plugin mode) and the project rules `klypix link` writes — no hooks. Those rules go into `AGENTS.md`, which Codex loads itself. `klypix link` writes no `CLAUDE.md` target, because Claude Code's rules channel is hooks, so **Claude Code sees the rules only if it opens `AGENTS.md`**; otherwise its only pointer is the server's own instructions. (Round 2: Claude consulted KLYPIX in exactly the 31 of 35 runs in which it opened `AGENTS.md`.) Plugin mode means keyword-only `brain_ask`. This is not the default install, and whether hooks change the result is not measured. |
| `klypix-installed` | What `npx klypix-mcp install` gives a Claude Code user: the server **not** in plugin mode, the five hooks the installer wires (SessionStart, UserPromptSubmit `--prompt`, Stop `--capture`, PostToolUse `--live`, PreToolUse `--guard`; the self-test checks them against `bin/klypix-install.mjs`) and search by meaning when `KLYPIX_BENCH_SEMANTIC_DIR` points at a prepared copy of its runtime and model. The hooks go into the run repo's `.claude/settings.json` (kept out of git) and run this checkout's hook through a wrapper pinned to the run's throwaway home, so no hook touches the user's own KLYPIX. **n/a for Codex**: Codex reads hooks only from the user's own `CODEX_HOME` (project-level hooks are not read), so running them would run the user's installed KLYPIX — not measured. |
| `concord` | **Concord MCP 0.20.0** (`@concord-ai/concord-mcp`, pinned; adapter in `conditions-concord.mjs`). The other session uses Concord's own five tools the way Concord's instructions tell a session to: its work is a `start_work` task (title = its intent, `expected_files` = the files it is on, `branch` when it has one), so a live peer is a claim the agent's own `start_work` collides with (S2, S10); a decision or finding is an `update_work` record on that task (S1, S4, S8; S6 mid-task, plus a `prompt` to the agent); a session that finished and left marks its task review-ready with `finish_work` (S3 — Concord's workspace view lists active and review-ready tasks only, so a task closed as `complete` takes its notes out of `inspect_work`'s view; review-ready is the generous reading); a session that stopped mid-work leaves its claim, which Concord's own presence rules flag as **stale** once the owner has been away 30 minutes (S5-family, S9). Concord has no automatic work record, so in S9 it carries the claim — title, files, branch — and no last prompt or reply; the fact counts as delivered when the stale claim lists that title. The repo gets exactly what `concord setup` writes except its MCP registrations (`.concord/` with its self-ignoring `.gitignore`; Concord's instruction block in CLAUDE.md, AGENTS.md, `.codex/`, `.cursor/`, `.github/`, `.agents/`); the harness supplies the pinned server under the same `concord` key. **Claude Code reads the CLAUDE.md block natively**, which the KLYPIX condition's AGENTS.md rules do not get. No Concord plugin or hooks (the bench's Claude reads project settings only), so a live prompt has no reachable endpoint and Concord's own notice says so in the first tool result; identity is the documented operator path (`CONCORD_AGENT_ID`); telemetry and update checks off; every Concord process runs in the run's throwaway home. The one bench write outside Concord's tools is backdating an ended session's timestamps to when it really stopped (the tools stamp "now"), as the KLYPIX condition writes an ended lane row at its real age. **n/a**: S7 (a dated six-month log has no faithful Concord shape), S9s (Concord records no last words), the crowd scenarios (KLYPIX's own capture engine). Runs only where `KLYPIX_BENCH_CONCORD_DIR` names a 0.20.0 install; otherwise listed as not measured. |

From round 3, Codex gets the KLYPIX server's tools approved
(`default_tools_approval_mode = "approve"` on that server only), as Claude's
allow-list already did; in round 2 Codex's approval policy refused every KLYPIX
tool but `brain_sync`. `--codex-effort` pins Codex's reasoning effort on every
run and records it.

The instructions-file conditions are deliberately generous: the other session
always writes the facts, in the right file, committed. Real teams forget.

**Not measured yet** (listed in every report, never simulated):
KLYPIX's hooks on **Codex** (they live only in the user's own `CODEX_HOME`),
Claude Code cross-session messaging, Claude Code's and Codex's native session
resume (S9 makes every handoff cross-vendor so no native resume applies), **MCP
Agent Mail** and memory tools such as OpenMemory. Each needs an adapter
verified against a pinned version before any number is published. KLYPIX's
hooks on **Claude Code** are measured from round 3 (`klypix-installed`);
**Concord** is measured from the 2026-11-08 pilot (`concord`, above).

**MCP Agent Mail — status, honest** (`conditions-agent-mail.mjs`, `runnable:false`).
The maintained version is the Rust rewrite
(`Dicklesworthstone/mcp_agent_mail_rust`); its latest release, v0.3.40
(2026-11-01), ships a Windows x64 asset
(`mcp-agent-mail-x86_64-pc-windows-msvc.zip`), so the earlier "Linux/macOS
binaries only" note was out of date. On 2026-11-08 that zip was downloaded,
its SHA-256 matched the published `.sha256`, and the binary started over stdio
on this Windows 11 machine (`am serve-stdio` with an existing `STORAGE_ROOT`;
~5 s to first reply; MCP protocol 2024-11-05; `tools/list` answered — the names
are in the module header). That is all that was verified. The adapter is a
skeleton: the planned mapping (`ensure_project`, `register_agent`,
`file_reservation_paths` for a live peer, `send_message` for a decision,
`fetch_inbox` / `search_messages` to read back) has not been run against the
server, and one design question is unsettled — Agent Mail delivers to **named**
mailboxes (broadcast is rejected) and an agent under test has no name before it
registers, so how a note from an ended session reaches it (a thread the agent is
told to read, search, or a pre-created identity) is a choice about the product
that must be made and documented before any number is published. The project's
own release notes call native Windows unverified. No Agent Mail number exists.

## Fairness rules

- Same repo, same task text, same facts, same scripted actor in every
  condition. Only the channel differs.
- Agents run isolated from your setup. Claude Code: `--setting-sources project
  --strict-mcp-config` (no user hooks, no user MCP servers). Codex:
  `--ignore-user-config --ephemeral`. Both get the condition's MCP servers and
  nothing else.
- A channel's delivery is **read back**, not assumed.
- Every number is printed with its `n` and a 95% Wilson interval. A difference
  is called out only when the intervals do not overlap. Overlap means no clear
  difference at this sample size; it does not establish equivalence.
- A run that measured nothing about its channel is **invalid** — shown beside
  `n`, listed by reason, and left out of every rate: the condition's server
  never came up; a write did not land (read back short, at start or mid-task); a
  mid-task fact never fired (no file write seen) or landed after the agent's
  last action; or the bench itself failed. None of these is ever counted as the
  channel failing.
- A condition a scenario cannot apply to prints as **n/a** with the reason, and
  is never run: copy-paste for a decision made later, and the appended notes file
  wherever it would be byte-identical to another condition.
- "Acted on stale information" is counted over completed runs only; a timed-out
  or budget-capped run is an error, not deference. Graders judge behaviour by
  running the agent's code (how many times a sender was called, what a formatter
  returned), never by searching its source for words. The probe reports through
  its own marker, so nothing the agent's code prints can change a verdict.
- A notes-file condition commits only when the file changed, under a neutral
  message: git history never announces another session's activity to the agent.
- Each scenario ships two scripted answers, one that uses the facts and one that
  does not, and the self-test proves every grader tells them apart before any
  model is called.
- Agent CLI versions and models are recorded on every row; every agent's raw
  output can be kept (`--transcripts`) so any number can be audited run by run.

## Running it

The [round-3 historical reconciliation](results/2026-10-13-round3-reconciliation.md)
preserves the existing result rows, including failures, and explains why they
are not an evaluation of the current build. The
[2026-11-08 Concord pilot](results/2026-11-08-concord-pilot.md) is the first
run of a third-party channel: **n = 1 per cell, Claude Code only — it proves
the adapter end to end and ranks nothing.**

```bash
# Free: scripted oracle, no model calls. Proves graders and delivery.
node bench/coordination/run.mjs --dry-run

# Real agents. Spends model usage on YOUR account; asks before starting.
# Pin the models for reproducible numbers; keep each agent's raw output for auditing.
node bench/coordination/run.mjs --live --agent claude,codex --claude-model 'opus[1m]' \
  --codex-model gpt-6-astra --runs 5 --transcripts transcripts/ --out results.jsonl

# Table with intervals.
node bench/coordination/report.mjs results.jsonl > results.md
```

`--scenario` and `--condition` take comma lists. `--keep` leaves each run's repo
on disk for inspection. `--timeout` is per run, in seconds (default 600).
`--max-budget` caps Claude's dollars per run (default 2).
`--klypix-bin` points the KLYPIX condition at another server build — for
example a released tag's checkout — so two versions can be compared on the same
scenarios; every KLYPIX row records the server's version and commit.

**Concord** runs only against a pinned local install, never a global one:

```bash
mkdir -p /tmp/cobench-competitors/concord && cd /tmp/cobench-competitors/concord
npm init -y >/dev/null && npm install @concord-ai/concord-mcp@0.20.0
KLYPIX_BENCH_CONCORD_DIR=/tmp/cobench-competitors/concord node bench/coordination/run.mjs --dry-run --condition concord
```

Another version at that path is refused with the reason (the adapter is
verified against 0.20.0 only). Every Concord row records the package version
(`channelServer`), and the experiment identity carries it, so rows from two
Concord versions can never be pooled. The `concord` CLI is **not** on the
agent's PATH (and not in Claude's allow-list): the five MCP tools are the
channel, as they are for KLYPIX.

`--shuffle <seed>` interleaves the runs reproducibly. To continue an interrupted
run, repeat the **same command** with `--resume`. The output must match the
recorded source fingerprints, server revision, CLI versions, requested models,
effort, budget, timeout, scenario/condition selection, run count, semantic assets
and shuffle seed. Changed configurations need a new output file. Pin explicit
models: an unpinned provider default can change outside this harness.

Resume uses the latest attempt for each run and preserves its original order.
Only completed attempts are skipped. A partially written final JSON line is
removed before appending; malformed interior lines fail visibly. An existing
nonempty output cannot be appended to without `--resume`.

Reports reject different experiment identities instead of silently pooling them.
Historical files without that identity remain readable with a warning, but cannot
be resumed. Combining several historical files requires `--legacy-merge` and a
manual check that they continue the same experiment; this flag does not establish
their provenance. A grader passing after an agent error is counted as an error,
not a completed success.

Live runs leave your own setup alone. The CLIs start directly, never through
`cmd.exe`, and get the prompt on stdin. The agent's environment carries nothing
from the session that launched the bench. Claude runs with
`--no-session-persistence` and Codex with `--ephemeral`. Every KLYPIX file of a
run (lane, project registry) lives in a throwaway home that is deleted
afterwards. On Windows, Codex gets `windows.sandbox="elevated"` (the one user
setting it cannot run without) and the run repo's `.git` as its only extra
writable root, so it can commit and merge like Claude.

The self-test (`node test/coordination-bench.mjs`) runs the dry run, proves each
grader separates the right answer from the naive one, checks every invalid-run
reason, and starts the real klypix-mcp server the way an agent would to check
that its first `brain_sync` shows the agent what the other session knew. Where
the pinned Concord install is present it does the same for Concord: the agent's
own Concord server, started as the bench starts it, must show the other
session's decision (S1), the overlap on its file (S2, S10), the review-ready
task with its finding (S3), the stale claim two days old (S5) and the stopped
session's claim without a plan (S9).

## Honest limits

- **Scripted actors.** The "other session" is a script, so every condition
  faces the same history. That isolates the channel; it does not measure how
  well a real second agent *writes* notes, or how often real sessions forget to.
- **Small repos.** Eight scenarios on tiny projects. They test whether
  knowledge crosses sessions, not whether an agent can navigate a large codebase.
- **The relay condition is meant as an upper bound**, not a competitor: a
  human carrying every fact by hand, at the moment it is needed. It is not
  always one: when the notes file contradicts the paste, an agent may side with
  the file (round 2, S7).
- **The mailbox is not measured.** KLYPIX's directed notes reach a session the
  sender already knew. Every agent here is a brand-new session, so a finding
  left by an ended session travels as a brain card.
- **Two KLYPIX setups.** `klypix` is the MCP server alone (plugin mode); for
  Claude Code the rules reach it only if it opens `AGENTS.md`. `klypix-installed`
  (round 3, Claude Code only) is the installed product. Its known deviations from
  a field install: Claude runs with `--no-session-persistence`, so the Stop hook
  has no transcript (no capture-gap nudge, no work stamp for the agent itself) —
  do not compare its turns or cost with field use; the hooks run through a
  wrapper that pins the run's home; search by meaning comes from a prepared copy
  that is checked before and after the run.
- **Codex loads the user's global `AGENTS.md`.** `--ignore-user-config` skips
  `config.toml` only. On a KLYPIX machine that file carries a KLYPIX rules block
  (inert where there is no `brain.klypix`); every Codex row records its
  fingerprint (`codexGlobalRules`). Rounds 1–2 ran the same way.
- **Codex's reasoning effort is the model's own default** unless `--codex-effort`
  pins it: the CLI sends none, and the API refuses an explicit `none` for
  `gpt-6-astra`. Rounds 1–2 ran at that default (not "effort none").
- **S10 and S2 are the shared-checkout case.** Both sessions work in one
  checkout, so they share one brain and lane. Sessions in separate worktrees
  have separate brains; that case is not measured.
- **S9's plan lives where the scenario puts it.** In S9 the stopped session's
  last reply is a mid-step line and the plan is in its last prompt; S9s is the
  case where its last reply happened to summarise the plan. Real last replies
  vary between the two.
- **One machine.** KLYPIX's lane is machine-local; a teammate on another PC is
  out of scope here, as it is in the product.
- **Concord without its plugin.** The `concord` condition is Concord's MCP
  server plus the instruction blocks `concord setup` writes; its Claude Code
  plugin (hooks + idle monitor for live messages) is not installed, because the
  bench's Claude reads project settings only. Live `prompt` delivery therefore
  has no endpoint, and Concord's own first-call notice tells the agent its
  adapter "needs attention" — both are what a user without the plugin sees.
  Concord's `CLAUDE.md` block, on the other hand, IS read by Claude natively,
  so Concord's rules reach Claude more directly than KLYPIX's AGENTS.md rules do
  in the `klypix` condition.
- **Concord's S3 is a reading.** A finished session's task is left
  review-ready so its finding stays in the workspace view; a task closed as
  `complete` would leave the view and survive only in `.concord/` artifacts and
  per-task inspection. That choice is stated here so a number is never read as
  "Concord's only possible behaviour".
- **Concord's S9 carries less than KLYPIX's by design of the product.** Concord
  records no last prompt or reply; the stopped session's claim (title, files)
  is what the agent can find. A Concord session that had also called
  `finish_work outcome: handoff` would be the generous notes condition's twin,
  not "nobody wrote a note", and is not run.
- **Small samples prove little.** Five runs that all pass give an interval of
  roughly 57–100%. Publish only what the intervals support.
