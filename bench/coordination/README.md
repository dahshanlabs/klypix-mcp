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
| S4 | **Another vendor's session found the root cause** | The cache key must include the user id; the cache lifetime is fine | Hidden test: users are isolated **and** a user's own profile stays cached |

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
| `klypix` | The other session used KLYPIX: decisions as brain cards (a replaced one archived with a "superseded by" arrow), live work as a lane row, a closed session's note as a directed message. The agent gets **only the klypix-mcp server** (plugin mode) and the project rules `klypix link` writes — no hooks. |

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
  message write did not land, the run is recorded with `delivered: 0`.
- Every number is printed with its `n` and a 95% Wilson interval. A difference
  is called out only when the intervals do not overlap; anything else is a tie.
- Agent CLI versions are recorded on every row.

## Running it

```bash
# Free: scripted oracle, no model calls. Proves graders and delivery.
node bench/coordination/run.mjs --dry-run

# Real agents. Spends model usage on YOUR account; asks before starting.
node bench/coordination/run.mjs --live --agent claude --runs 10 --out results.jsonl
node bench/coordination/run.mjs --live --agent codex  --runs 10 --out results.jsonl \
  --scenario s1,s3 --condition none,agents-md-kept,klypix

# Table with intervals.
node bench/coordination/report.mjs results.jsonl > results.md
```

`--keep` leaves each run's repo on disk for inspection. `--timeout` is per run,
in seconds (default 600).

The self-test (`node test/coordination-bench.mjs`) runs the dry run, proves each
grader separates the right answer from the naive one, and starts the real
klypix-mcp server the way an agent would to check that its first `brain_sync`
shows the agent what the other session knew.

## Honest limits

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
