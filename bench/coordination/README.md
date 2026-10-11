# Coordination bench

Does a coding agent do the right thing when **another session** — a different
agent, vendor, or a session that has already ended — knows something it needs?

This kit measures that with real agents on real repos. It is built so the
numbers can be published: every task is graded by a hidden test, every
condition faces the same history, and anything that was not measured is
reported as **not measured**.

## The four scenarios

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S1 | **A decision changed today** | New endpoints use bearer tokens; the "cookie session" note is out of date | Hidden test: logout revokes the token and sets no cookie |
| S2 | **Two sessions on overlapping work** | A session is rewriting `lib/price.js` on branch `a/currency` right now | Hidden test **and** `git merge-tree` against `a/currency`: a conflict fails the run |
| S3 | **A note left by a session that has ended** | Run `backfill:emails` before `migrate:002` | Hidden test: the backfill is in the plan, before the migration |
| S4 | **Control: a root cause that is in the code after all** | In production the CDN strips `x-user-id`, so the cache must key on `req.session.uid`. Meant to be knowledge from another session; both agents inferred it from the code with no channel (pilot, 2026-10-11). Kept as a **control**: every condition should pass it | Hidden test: behind the CDN users are isolated **and** a user's own profile stays cached |

**Round 2 — what a notes file cannot do by construction.** The pilot showed that when the other
session has already written one short, correct sentence in the right file before the agent starts,
a notes file ties KLYPIX. These four keep the same fairness rules but test what a file lacks:
expiry, arrival during the task, ranking inside a long history, and knowledge that is nowhere in
the repository.

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S5 | **A WIP note that outlived its session** | Nothing — the session that wrote "do not touch `lib/report.js`" two days ago is gone. The knowledge is an **absence**: nobody is on the file. A tidy notes file removed the line; an appended one still carries it (so that cell is n/a: identical to no channel); in KLYPIX the session's row was written two days old and the product's own expiry hides it, and the file never held the line (work in progress is presence there). The task names only the symptom, and the stale note offers a path it does not forbid: fix the caller and leave `lib/report.js` alone | Hidden test calls `lib/report.js` directly, so only the root-cause fix passes. "Stale" = the file untouched **and** either a workaround in the caller or a final message citing the note. May be at ceiling (agents may ignore dead notes) — gated by a no-channel pilot before any matrix |
| S6 | **A decision made while the agent is working** | Nothing at start. **At the agent's first file write** (seen in its own output stream, so every condition pays the same and KLYPIX's start-up is not charged to the window), finance settles the display format. The notes file changes on disk under the agent; KLYPIX adds a card and posts a note the agent gets at its next call (whether it was posted is recorded). Copy-paste is n/a. The fact states the rule with an amount no test uses | Hidden test on an input neither the visible test nor the fact uses: `display` is `"2144 USD"`. "Stale" is judged on what the function returns (a `# Coordination bench

Does a coding agent do the right thing when **another session** — a different
agent, vendor, or a session that has already ended — knows something it needs?

This kit measures that with real agents on real repos. It is built so the
numbers can be published: every task is graded by a hidden test, every
condition faces the same history, and anything that was not measured is
reported as **not measured**.

## The four scenarios

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S1 | **A decision changed today** | New endpoints use bearer tokens; the "cookie session" note is out of date | Hidden test: logout revokes the token and sets no cookie |
| S2 | **Two sessions on overlapping work** | A session is rewriting `lib/price.js` on branch `a/currency` right now | Hidden test **and** `git merge-tree` against `a/currency`: a conflict fails the run |
| S3 | **A note left by a session that has ended** | Run `backfill:emails` before `migrate:002` | Hidden test: the backfill is in the plan, before the migration |
| S4 | **Control: a root cause that is in the code after all** | In production the CDN strips `x-user-id`, so the cache must key on `req.session.uid`. Meant to be knowledge from another session; both agents inferred it from the code with no channel (pilot, 2026-10-11). Kept as a **control**: every condition should pass it | Hidden test: behind the CDN users are isolated **and** a user's own profile stays cached |

**Round 2 — what a notes file cannot do by construction.** The pilot showed that when the other
session has already written one short, correct sentence in the right file before the agent starts,
a notes file ties KLYPIX. These four keep the same fairness rules but test what a file lacks:
expiry, arrival during the task, ranking inside a long history, and knowledge that is nowhere in
the repository.

| | Scenario | What the other session knows | Graded by |
|---|---|---|---|
| S5 | **A WIP note that outlived its session** | Nothing — the session that wrote "do not touch `lib/report.js`" two days ago is gone. The knowledge is an **absence**: nobody is on the file. A tidy notes file removed the line; an appended one still carries it (so that cell is n/a: identical to no channel); in KLYPIX the session's row was written two days old and the product's own expiry hides it, and the file never held the line (work in progress is presence there). The task names only the symptom, and the stale note offers a path it does not forbid: fix the caller and leave `lib/report.js` alone | Hidden test calls `lib/report.js` directly, so only the root-cause fix passes. "Stale" = the file untouched **and** either a workaround in the caller or a final message citing the note. May be at ceiling (agents may ignore dead notes) — gated by a no-channel pilot before any matrix |
 or a decimal point), not on the source. **Handled** = applied the decision or surfaced it in the final message (it contradicts the user's own wording). A run where the fact landed after the agent's last action, or never landed, is **invalid**, not a fail |
| S7 | **A decision buried in six months of notes** | The September retry rule was reversed late in September, in the log's own terse register, without naming the rule it replaces; two more weeks of notes followed, including an email sender that *does* retry. The file holds ~330 dated lines (2–3 per working day since April); the brain holds the same ~330 as cards, the reversal linked to what it replaced | Hidden test: a failed send is not retried and lands in the dead-letter queue once (a rethrow is tolerated). "Stale" = the sender was called more than once on failure, counted by running it |
| S8 | **A partner limit nothing in the repository shows** | The partner drops request ids over 24 characters, with a hyphen, or without the client prefix `p7` — learned from their support, in no file, and the visible tests pass. The prefix is there so no hardening instinct passes by luck. The symptom ("intermittent 400s") invites retries | Hidden test: ids are `p7` + up to 22 alphanumerics and unique. "Stale" = a 400 was retried (the sender called more than once), counted by running it |

S2 also gains a **handled-overlap** measure beside the strict grade: a conflict the agent avoided
*or named in its final message* counts as handled. The pilot's two S2 "failures" were Claude
declining to merge another session's unfinished branch and saying so.

Each scenario also records whether the agent **acted on stale information**
(used the legacy cookie helper, wrote a conflicting change, ran the migration
without the backfill, or killed the cache instead of fixing the key).

The hidden tests are written into the repo only **after** the agent finishes,
so the agent cannot read or game them. There is no LLM judge.

## The conditions

| Condition | How the other session's knowledge reaches the agent |
|---|---|
| `none` | It does not. The project notes still carry whatever they said before. |
| `relay` | A human pasted the facts into the prompt. **Upper bound**: counts one human relay per fact. |
| `agents-md-kept` | The other session edited `AGENTS.md` / `CLAUDE.md` tidily (the out-of-date line replaced). |
| `agents-md-appended` | The other session appended to `AGENTS.md` / `CLAUDE.md` (the out-of-date line left in). |
| `klypix` | The other session used KLYPIX: decisions as brain cards (a replaced one archived with a "superseded by" arrow), live work as a lane row, and a finding left by a session that has ended as a card too. The agent gets **only the klypix-mcp server** (plugin mode) and the project rules `klypix link` writes — no hooks. |

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
- A channel's delivery is **read back**, not assumed: if the brain, lane or
  write did not land, the run is recorded with `delivered: 0`.
- Every number is printed with its `n` and a 95% Wilson interval. A difference
  is called out only when the intervals do not overlap; anything else is a tie.
- A run that measured nothing about its channel is **invalid**, shown beside `n`
  and left out of the rate: the condition's server never came up, or a mid-task
  fact landed after the agent's last action (timed from the agent's own output
  stream). A condition a scenario cannot apply to prints as **n/a** with the reason,
  and is never run: copy-paste for a decision made later, and the appended notes
  file wherever it would be byte-identical to another condition (no stale line to
  keep, or nothing to append).
- "Acted on stale information" is counted over completed runs only; a timed-out
  or budget-capped run is an error, not deference. Graders judge behaviour by
  running the agent's code (how many times a sender was called, what a formatter
  returned), never by searching its source for words.
- A notes-file condition commits only when the file changed, under a neutral
  message: git history never announces another session's activity to the agent.
- A replaced **decision** stays in the file for the KLYPIX condition too
  (conservative: the brain's current card has to beat it). Only an **absence**'s
  stale line is stripped there, because a session's work in progress never was a
  note in a KLYPIX team.
- Each scenario ships two scripted answers, one that uses the facts and one that
  does not, and the self-test proves every grader tells them apart before any
  model is called.
- Agent CLI versions are recorded on every row.

## Running it

```bash
# Free: scripted oracle, no model calls. Proves graders and delivery.
node bench/coordination/run.mjs --dry-run

# Real agents. Spends model usage on YOUR account; asks before starting.
# Pin the models for reproducible numbers; keep each agent's raw output for auditing.
node bench/coordination/run.mjs --live --agent claude --claude-model 'opus[1m]' --runs 10 \
  --transcripts transcripts/ --out results.jsonl
node bench/coordination/run.mjs --live --agent codex --codex-model gpt-6-astra --runs 10 \
  --scenario s1,s3 --condition none,agents-md-kept,klypix --transcripts transcripts/ --out results.jsonl

# Table with intervals.
node bench/coordination/report.mjs results.jsonl > results.md
```

`--keep` leaves each run's repo on disk for inspection. `--timeout` is per run,
in seconds (default 600). `--max-budget` caps Claude's dollars per run (default 2).

Live runs leave your own setup alone. The CLIs start directly, never through
`cmd.exe`, and get the prompt on stdin. The agent's environment carries nothing
from the session that launched the bench. Claude runs with
`--no-session-persistence` and Codex with `--ephemeral`. Every KLYPIX file of a
run (lane, project registry) lives in a throwaway home that is deleted
afterwards. On Windows, Codex gets `windows.sandbox="elevated"`, the one user
setting it cannot write without.

The self-test (`node test/coordination-bench.mjs`) runs the dry run, proves each
grader separates the right answer from the naive one, and starts the real
klypix-mcp server the way an agent would to check that its first `brain_sync`
shows the agent what the other session knew.

## Honest limits

- **The mailbox is not measured here.** KLYPIX's directed notes reach a session the sender
  already knew, and resume with it. Every agent here is a brand-new session, so a finding left by
  an ended session travels as a brain card, the way KLYPIX tells a closing session to leave it.
  On Codex, the server even identifies itself by Codex's own thread id.
- **Codex's sandbox keeps `.git` read-only,** so Codex cannot commit. The harness commits whatever
  any agent leaves in the working tree, and grades every agent the same way.

- **Scripted actors.** The "other session" is a script, so every condition
  faces the same history. That isolates the channel; it does not measure how
  well a real second agent *writes* notes.
- **Small repos.** Four scenarios on tiny projects. They test whether
  knowledge crosses sessions, not whether an agent can navigate a large
  codebase.
- **The relay condition is an upper bound**, not a competitor: a human
  carrying every fact by hand, at the moment it is needed.
- **One machine.** KLYPIX's lane is machine-local; a teammate on another PC is
  out of scope here, as it is in the product.
- **Small samples prove little.** Five runs that all pass give an interval of
  roughly 57–100%. Publish only what the intervals support.
