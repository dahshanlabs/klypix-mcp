# Build your own project memory

You do not need this package to give a project a memory. The ideas are simple,
and for a solo developer running one agent on a small project, a flat markdown
file plus a 15-line git hook covers most of the value. This page teaches the
ideas, gives you that starter, and is honest about exactly where it stops
working — with measured numbers, not vibes.

If you build the starter and never hit the boundaries at the end, you never
need us. That is a fine outcome.

## The ideas

### 1. Capture decisions, not activity

The single most important convention. A project memory rots in two ways:
nothing gets written, or *everything* gets written and the signal drowns. The
test for an entry is:

> Would a fresh session, three weeks from now, do something wrong without this
> line?

"Refactored the auth module" fails the test — git already knows. "Token refresh
moved to httpOnly cookies; localStorage was reversed because XSS exposure
outweighed the convenience" passes: it prevents a future agent from
re-implementing the rejected approach. Capture the *why*, the reversal, the
constraint, the gotcha. Skip the play-by-play.

### 2. Corrections supersede — they never edit

When a decision turns out wrong, do not edit or delete the old entry. Append a
new one that names what it replaces. Two reasons:

- **History is evidence.** "We tried X and reversed it" is the most valuable
  sentence in the file — it is the one that stops the third agent from trying
  X again. An edited-away mistake teaches nobody.
- **Appends merge; edits conflict.** An append-only file is the difference
  between git merging your memory automatically and you resolving conflicts in
  it by hand.

Make the correction cue **explicit and deliberate** (we use an UPPERCASE
`CORRECTION:` prefix). Detecting contradictions automatically from prose is a
false-positive machine — "the calc was wrong" in a casual sentence must not
retire a card. A loud, unambiguous marker that a human or agent writes on
purpose is more reliable than any classifier. That is not a shortcut; after an
adversarial review of our own engine, it is the design we kept.

### 3. When hooks should fire

Automate capture at the *boundaries* of work, not inside it:

- **Session start** — inject the tail of the memory into context. This is the
  highest-value hook: it costs one read and kills the "explain the
  architecture again" tax.
- **Session end / turn end** — harvest anything the agent explicitly marked as
  a decision during the session. Explicit markers beat transcript mining: let
  the model say "this is durable" rather than guessing.
- **Commit time** — a post-commit hook (starter below) catches decisions that
  ride commit messages. Crucially, it also catches *other* agents and other
  worktrees: a session-scoped hook only sees its own checkout, but a git hook
  fires wherever the commit happens.
- **Not on every file edit.** Per-edit capture generates activity logs, which
  fail the test in idea 1.

### 4. One file, one-file-per-fact, or spatial cards

Three storage shapes, in ascending order of machinery:

- **One flat markdown file** (`decisions.md`). Greppable, diffable, readable in
  a PR, zero tooling. Append-only with a single writer, git merges it almost
  for free. This is the right starting point and the starter below.
- **One file per fact** (a `decisions/` directory). Concurrent writers stop
  colliding (two branches adding different files never conflict), and facts
  get stable identities you can reference. You pay for it in reading order —
  you now need an index or a build step to answer "what happened recently",
  and the PR diff stops telling a story.
- **Spatial cards** (what `.klypix` is). Position and links carry meaning: an
  area for each concern, an arrow from correction to corrected, a focus zone
  the brief always leads with, per-card provenance of which agent wrote it.
  You pay for it with an engine and a viewer. At small scale you genuinely do
  not need this — the honest reason it exists is the lifecycle mechanics
  (supersede/resolve/dedup) and the merge invariant below, which flat text
  cannot enforce.

### 5. The merge problem, stated precisely

This is the wall every shared-memory design eventually hits, so it is worth
stating as an invariant rather than an anecdote:

> Two writers hold the same memory. Each reads it, changes it, and writes it
> back. Whatever the storage, the merged result must contain **every entry
> that survived on either side** — and you must be able to *prove* it, because
> the writers are unattended agents and nobody is watching the file.

- Append-only + one writer: trivially safe.
- Append-only + two *branches*: a textual conflict at the tail of the file —
  annoying, manually resolvable, not dangerous.
- Two *processes* in one working tree (two agent sessions, an editor plus a
  hook): read-modify-write races. Last writer silently wins; the loser's entry
  is gone and nothing reports it.

The third case is why our engine has a write lock and a union merge that
re-verifies its own output (and *aborts* rather than emit a file missing a
card). It is measurable, not theoretical: our shipped benchmark runs writers
that bypass the lock as a negative control — on the reference machine they
lost **17 of 22 entries**; the same contention through the lock protocol lost
**0 of 46** (`npx klypix-mcp bench` reproduces both numbers on your machine,
and reports itself *inconclusive* if the control fails to lose anything). If
your setup is solo-single-agent, you simply do not have this problem — which
is exactly why the starter below is enough there.

## The flat-markdown starter

Two pieces: a convention and a hook. Both work today, unmodified.

### `decisions.md` — the convention

```markdown
# Decisions

Append-only. Newest at the bottom. One entry = one durable decision
(something a future session would otherwise get wrong). Corrections are new
entries prefixed CORRECTION: — never edit or delete an old entry.

## 2026-06-02 — auth: store refresh token in localStorage
Simplest path to shipping the beta; revisit before GA.

## 2026-08-18 — auth: refresh tokens move to httpOnly cookies
Supersedes 2026-06-02. XSS exposure outweighed the convenience; the beta
shortcut must not survive into GA.

## 2026-08-19 — CORRECTION: cookie SameSite must be Lax, not Strict
Strict broke the OAuth redirect flow on Safari. Applies to the 2026-08-18
entry.
```

Then tell your agent about it, in whatever standing-instructions file your
tool reads (`AGENTS.md`, `CLAUDE.md`, a rules file):

```markdown
Before architectural decisions, read decisions.md (at least the last ~30
entries; grep it for the topic first). When you make a durable decision or
reverse one, append an entry in the established format. Never edit old
entries; corrections are new entries prefixed CORRECTION:.
```

That instruction block *is* your session-start hook on tools that auto-load
rules files. On Claude Code you can make it mechanical with a real
`SessionStart` hook that runs `tail -n 120 decisions.md`.

### The commit hook — `.git/hooks/post-commit`

```sh
#!/bin/sh
# Append rationale-bearing commits to decisions.md — any agent, any worktree.
subject=$(git log -1 --format=%s)
body=$(git log -1 --format=%b | tr -d '\r')
case "$subject" in
  feat*|fix*|perf*) ;;      # high-signal types only
  *) exit 0 ;;
esac
# No rationale, no entry — a bare subject line is what `git log` is for.
[ "$(printf %s "$body" | wc -c)" -ge 12 ] || exit 0
{
  printf '\n## %s — %s\n' "$(date +%F)" "$subject"
  printf '%s\n' "$body"
  printf '<!-- commit %s -->\n' "$(git rev-parse --short HEAD)"
} >> decisions.md
```

`chmod +x .git/hooks/post-commit` and it works. Design notes, because each
line is a lesson we paid for:

- **The type filter + minimum body length is the difference between a memory
  and a log.** Without the ≥12-char rationale gate you get one entry per
  commit and the file is unreadable in a month.
- The new entry lands **uncommitted** in your working tree. That is a feature:
  you review what the hook captured and commit it with your next change.
  (Amending HEAD from inside a post-commit hook invites recursion — don't.)
- It fires in whichever worktree the commit happens in, so a second agent on
  another branch still feeds the same file when the branches merge.

This starter — file, instruction block, hook — is genuinely sufficient for the
solo-single-agent case, and it degrades gracefully: everything is plain text
in your repo, so nothing breaks if you stop maintaining it.

## Where it breaks

Three boundaries, in the order you will hit them. Each one is the reason a
piece of this package exists — and if you never hit them, you never need that
piece.

### Concurrent writers

The moment two agent sessions (or a session plus a hook) write in one working
tree, you are in the silent-clobber case from idea 5. Mitigations in
ascending effort: a lock file convention; one-file-per-fact; or an engine
with a write lock and a verified union merge. Ours also registers a git merge
driver so *branch* merges of the binary brain file union at the card level
instead of take-ours/take-theirs — that is `npx klypix-mcp git-driver install`,
and the no-loss claim is the benchmarked one quoted above.

### Retrieval past a few hundred entries

While the file fits in a context window, "paste the tail, grep for the topic"
is honestly hard to beat. It stops working quietly, not loudly: the agent
still *reads* something, it just misses the entry that mattered.

Published numbers so you can calibrate (all measured on our own dogfood brain
— **2,479 cards, 2,018 connections** as of 2026-08-13 — with the caveats
attached; methodology in the README's *Numbers and methodology*):

- On n=20 frozen human-paraphrase questions against that brain, **lexical-only
  retrieval scored 0% recall@5** — the asker's vocabulary and the card's
  vocabulary had drifted that far apart. The on-device semantic ranker reaches
  **30% recall@5 / 35% @10 / 45% @20, MRR 0.22**. At n=20 each figure carries
  a ±20-point 95% confidence interval; treat them as directional.
- End-to-end task recall on the same brain: **73%** of past decisions
  recovered within one search round, 55% from the brief alone, 0% cold
  (n=20, self-authored questions, LLM-judged).
- Engine latency is not the problem at this scale: a 1,000-query soak holds
  p50 ≈ 8 ms with +1 ms drift (`npx klypix-mcp bench`).

Read those numbers as a warning about the problem, not an ad for our solution:
at thousands of entries even a tuned semantic ranker misses the true source
card more than half the time at k=5. What actually moves the needle is
structure the flat file lacks — lifecycle metadata (is this entry superseded,
and by what?), correction-aware ranking (surface the fix, not the corpse),
and time-scoped queries ("what was true in March"). If you outgrow grep, build
or adopt *that*, whether or not it is ours.

### Live multi-session coordination

A file — markdown or ours — cannot tell you that another session is editing
`src/auth/token.ts` *right now*. That needs presence: sessions declaring
intent and expected files somewhere a peer can read within seconds. You can
approximate it solo with a lockfile-per-area convention; past that it wants a
process. Ours does it through the MCP server (declared scope, exact-path
overlap warnings, one-time handoff notes) and we are explicit about its
limits: machine-local, OS-user-local, advisory-only, and both sides must have
declared their files for an overlap to be visible at all.

## Summary

| Situation | Honest recommendation |
|---|---|
| Solo dev, one agent, small project | The starter above. All of it. |
| One agent + commit-time capture from other tools | Starter + the git hook, maybe one-file-per-fact |
| Multiple concurrent sessions, one machine | You now need locking + verified merge — build it or use ours |
| Hundreds→thousands of entries, "it stopped finding things" | You need lifecycle-aware retrieval, not a bigger grep |
| Multiple machines / teammates | Git carries the file; live coordination stays an open problem everywhere — ours is machine-local too |

The README's *When NOT to use this* section is the same table from the other
side.
