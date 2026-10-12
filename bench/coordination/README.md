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

The instructions-file conditions are deliberately generous: the other session
always writes the facts, in the right file, committed. Real teams forget.

**Not measured yet** (listed in every report, never simulated):
KLYPIX with Claude Code hooks, Claude Code cross-session messaging, MCP Agent
Mail, Concord, and memory tools such as OpenMemory. Each needs an adapter
verified against a pinned version before any number is published.

## Fairness rules

- Same repo, same task text, same facts, same scripted actor in every
  condition. Only the channel differs.
- Agents run isolated from your setup. Claude Code: `--setting-sources project
  --strict-mcp-config` (no user hooks, no user MCP servers). Codex:
  `--ignore-user-config --ephemeral`. Both get the condition's MCP servers and
  nothing else.
- A channel's delivery is **read back**, not assumed.
- Every number is printed with its `n` and a 95% Wilson interval. A difference
  is called out only when the intervals do not overlap; anything else is a tie.
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
that its first `brain_sync` shows the agent what the other session knew.

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
- **Claude Code without hooks.** The KLYPIX condition gives Claude Code only the
  MCP server's instructions; Claude Code with KLYPIX's hooks is a planned,
  separate condition.
- **One machine.** KLYPIX's lane is machine-local; a teammate on another PC is
  out of scope here, as it is in the product.
- **Small samples prove little.** Five runs that all pass give an interval of
  roughly 57–100%. Publish only what the intervals support.
