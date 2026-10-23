# Brain rules on two real repositories: what they would have caught, and what that was worth

This is a backtest. It takes the lessons two real projects had recorded, turns the checkable ones
into [project rules](brain-rules.md), and runs those rules over 30 days of real pull requests: every
commit that GitHub Actions checked, with the real job logs and the real bill. The numbers come from
[`scripts/brain-rules-proof.mjs`](../scripts/brain-rules-proof.mjs), which anyone with read access
to the repositories can re-run (see *Reproduce it* at the end).

- **Repositories:** `dahshanlabs/AgentMug` (pnpm monorepo, default branch `main`) and
  `dahshanlabs/klypix-app` (the Electron app, default branch `master`). Both are **private**, so
  their Actions minutes are billed. The public repositories (klypix-mcp, KLYPIX, klypix-network,
  klypix-plugin) run on free minutes and are not measured here.
- **Window:** 2026-09-24 to 2026-10-23, 30 days. The last day ends when the data was read
  (2026-10-23, afternoon UTC).
- **Rules:** the ones made from lessons in each repository's own brain, plus, in a separate set,
  lessons that were written down only in an agent's memory notes or in `CLAUDE.md` and never reached
  the brain. Both sets are in [`docs/brain-rules-proof/`](brain-rules-proof/). They are at the
  default severity, `warn`: the backtest counts what a rule flags. Whether a flagged commit would
  then have been stopped depends on the person approving the rule with `--block`, or on the agent
  acting on the warning; a backtest cannot tell which.

## The short answer

| | AgentMug | klypix-app |
|---|---|---|
| Actions runs in 30 days | 957 | 1,409 |
| Billable minutes / list price | 8,952 min / $69.57 | 9,556 min / $88.24 |
| Pull requests with runs / cost per PR | 121 / $0.47 | 300 / $0.20 |
| Failed CI attempts / what they cost | 111 / $20.25 | 46 / $4.51 |
| Failed CI runs whose cause a rule flags before the push | **2** (PRs #790 and #776) | **2** (master, PR #559), flagged in the PR that caused them (#549) |
| What those runs cost | **$0.22** (≤ $0.24 counting everything else that ran on those commits) | **$0.25**, plus **$0.26** for the fix PR (#564) |
| Mistakes that passed the PR's own CI and that a rule flags | a line-ending flatten (#726) that later forced a rebase conflict resolved by hand | the same `@/` imports: #549 merged green because its Windows job runs only with a label |
| False alarms | 14 findings in 3 PRs, all from one rule; one folder exclusion removes them | 1 finding (#470), from one rule |

What this says, plainly:

1. **The dollars are small.** The rules would have saved under 1% of each Actions bill (0.3% and
   0.6%). Most failed runs had causes no diff check can see: new advisories against dependencies,
   upstream tooling risk, release gates, and ordinary test failures from real bugs. Rules are not
   a CI cost tool, and we do not sell them as one.
2. **The repeat mistakes are real, and each one costs a round trip.** In every caught case a change
   broke a known rule of the project. CI took 7 to 12 minutes to say so, and a fix push and another
   full run followed; in klypix-app it took a separate fix PR. A rule says it in about 0.2 seconds,
   before the commit, with the fix.
3. **Some mistakes pass the pull request's own CI.** A line-ending flatten merged green in AgentMug
   and turned into a rebase conflict that another PR resolved by hand with a script. In klypix-app
   the expensive Windows job is skipped on unlabelled PRs, so broken imports merged green and broke
   master. A diff rule sees both before the push, whatever CI runs.
4. **A rule needs its own false-alarm budget.** One rule written from an agent's memory note fired
   14 times on a folder that has its own test runner, and one copy-list rule flagged a file that
   rightly is not on the list. That is the case the lifecycle is for: a false-alarm report narrows
   the rule, or retires it.

## How it was measured

For each repository, the script:

1. Lists every Actions run created in the window (in 7-day slices, because the API returns at most
   1,000 runs per query) and the jobs of every attempt, including re-runs.
2. Prices each job: billable minutes are the job's duration rounded up to whole minutes, times the
   list price for its runner (Linux $0.006, Windows $0.010, macOS $0.062 a minute). A job with no
   steps never ran because the spending limit had been reached; it costs nothing. The free minutes
   included in the plan are not subtracted, so these are list prices, not the invoice.
3. For every commit a pull-request run checked, runs the rules on what that pull request had
   changed at that moment: `merge-base(commit, the base branch the run saw)..commit`. This is what
   `npx klypix-mcp check --base origin/main` would have printed before that push.
4. Reads the log of every failed job in the repository's test workflows and looks for each rule's
   failure signature ([`signatures.json`](brain-rules-proof/signatures.json)), for example
   `Missing direct-link route` or a failing `P6 review N3` test. A failed run counts as *caught* only
   when its log carries a rule's signature **and** that rule fires at the run's commit.
5. Checks every merged pull request's last commit, and whether today's default branch still has the
   problem. This is how rules whose mistakes never fail CI are judged.
6. With `--per-commit`, checks every commit that touches a rule's files on its own, as the
   pre-commit hook would.

A clone made with `git clone --shared --no-checkout` reads the objects of the local checkout and
fetches the pull-request heads it lacks. Nothing in the developer's checkout is written. API answers
and job logs are cached, so a re-run with changed rules reads nothing from GitHub again.

## AgentMug

**Actions in the window.** 957 runs, 8,952 billable minutes, **$69.57** at list price: Linux 8,107
minutes ($48.64), Windows 605 ($6.05), macOS 240 ($14.88). 705 runs belonged to 121 pull requests:
$57.14, or **$0.47 a pull request**. The two test workflows (CI and Release safety) had 111 failed
attempts costing **$20.25** and 26 re-run attempts. 71 runs never started because the Actions
spending limit had been reached.

Rules ran at all 705 pull-request runs (485 distinct changes). 204 failed job logs were read; one
had expired.

### Rules from the brain

**`frontend-routes-registered`** — *every new App.tsx route must also be listed in
`frontend-fallback.ts`, or a direct link to it returns 404* (card `txt_w4fbw7m1`).

- **Caught:** PR #790. Commit `44dca7c` added `<Route path="/organization">` without the route
  list entry. CI failed after 7 minutes (`Missing direct-link route: /organization`, $0.11); a fix
  was pushed and the full CI ran again 12 minutes after the first run started. The rule's message
  at that commit:

  ```text
  ⚠ WARNING — project rule `frontend-routes-registered` (lesson txt_w4fbw7m1)
    Found: artifacts/agentforge/src/App.tsx:522 adds `<Route path="/organization"`, but `"/organization"` is not in artifacts/api-server/src/middlewares/frontend-fallback.ts
    Why:   Every new App.tsx route must also be listed in frontend-fallback.ts, or a direct link to it returns 404.
    Fix:   Add "/organization" to PRIVATE_ROUTES (or PUBLIC_ROUTES) in artifacts/api-server/src/middlewares/frontend-fallback.ts.
  ```

- **Missed:** none. It was the only failed log with that signature in the window.
- **False alarms:** none.
- **Not counted:** 10 runs that added routes before the route list existed (it was added in #765 on
  2026-10-15). A rule cannot apply before its registry exists.
- The lesson card was written on 2026-10-23, after this failure. The case shows what the rule
  stops the *next* time, not a prediction made in advance.

**`runner-impacting-paths`** (advice only) — *changes under `artifacts/runtime` or
`artifacts/runner` start the runner image build and the macOS and Windows desktop matrix* (card
`txt_k0y07qny`, written 2026-08-23, so it existed for the whole window).

- It fired in **50 of 121 pull requests** (311 runs). Those pull requests averaged **$0.76 and 7.1
  runs**; the other 71 averaged **$0.27 and 4.9 runs**.
- It only advises (*amend locally and push once*). A backtest cannot tell how many pushes the
  advice would have saved, so no saving is claimed for it.

### Rules from lessons that never reached the brain

These lessons were written only in an agent's memory notes. Turning them into rules first means
recording them as cards; they are tested here to show what that would have bought.

**`managed-run-worker-eol`** — *`managed-run-worker.ts` mixes CRLF and LF, and a test pins one LF
line; a Windows editor flattens it and CI fails.*

- **Caught:** PR #776. Commits `3190c9e`, `764267b` and `f25327d` all carried the file flattened to
  CRLF. The first two failed CI for other reasons (a dependency audit, an unrelated assertion);
  `f25327d` failed on the pinned test after 8 minutes ($0.11). The rule fires at all three, so the
  flatten would have been fixed before the first push.
- **A silent one:** PR #726 (merged 2026-10-10) flattened the same file, and CI passed: the pinning
  test did not exist yet. PR #722 then hit a rebase conflict on the file's line endings that had to
  be resolved with a hand-written script (recorded in AgentMug's memory notes). The rule flags #726.
- **Also flagged:** #686 (merged 2026-10-01; three untouched lines flipped; harmless at the time),
  #744 (fixed inside the pull request before merging), and #722 itself, which restored the bytes
  #726 had flattened. A person would let #722 through with that reason.
- **What the backtest fixed in the rule engine:** the first run of this backtest missed #776. The
  file has a raw NUL character inside a string, about 180,000 bytes in, and the line-ending check
  called the whole file binary. It now follows git's own test (a NUL in the first 8,000 bytes), and
  it now also catches *untouched lines whose endings flipped* while the file as a whole stays mixed.
  Both have tests.

**`api-tests-enumerated`** — *a new `*.test.ts` in api-server must be listed in its
`package.json`, or CI never runs it.*

- **14 findings in PRs #694, #696 and #697, all false alarms.** Every one is under
  `src/lib/video-workspace/`, a folder whose tests run through `scripts/test-video-workspace.mjs`,
  which runs every test file in the folder. Excluding that folder leaves **0 findings** in the
  window, and the rule caught nothing real. It would be a candidate to narrow, and then to retire.

**`postgres-tests-enumerated`** — no fires.

### What AgentMug's failed runs were

Of the 111 failed CI attempts, the biggest groups were dependency audits against newly published
advisories (26 jobs) and the public release gate (31 jobs), most of it reacting to upstream risk
changes. Two were `ERR_PNPM_OUTDATED_LOCKFILE`: a `package.json` changed without its lockfile. That
is a co-change mistake the four rule kinds cannot express; a fifth kind (*these files change
together*) would catch it. It is not built.

## klypix-app

**Actions in the window.** 1,409 runs, 9,556 billable minutes, **$88.24** at list price: Windows
7,844 minutes ($78.44), Linux 1,634 ($9.80), and 78 minutes on a self-hosted Windows runner, which
GitHub does not bill. 966 runs belonged to 300 pull requests: $59.01, or **$0.20 a pull request**.
The Windows `ci` job is most of the bill, and on a pull request it runs only when the PR carries
the `windows-build` label. The five test workflows had 46 failed attempts costing **$4.51**, and 20
re-run attempts. 43 runs never started because the spending limit had been reached.

Rules ran at all 966 pull-request runs (787 distinct changes). All 46 failed job logs were read.

### Rules from the brain

**`admin-tests-relative-imports`** — *admin tests must import relatively; the root vitest config has
no `@/` alias for `admin/`* (card `txt_nxj3c0nm`, written on 2026-10-23 after this incident).

- **Caught, although the pull request's own CI could not see it.** PR #549's first commit
  (`2b836ff`) added `from '@/lib/networkCommands'` and `from '@/lib/networkConnect'` to two admin
  tests. The Windows `ci` job was skipped on the PR because it had no `windows-build` label, and the
  PR merged on 2026-10-22.
- What followed: master's scheduled `ci` run failed (`Cannot find package '@/lib/networkCommands'`,
  after 12 minutes, $0.12); PR #559's labelled `ci` run failed on the inherited imports (after 12
  minutes, $0.13); and fix PR #564 had to run ($0.26) before #559 could run `ci` again and merge.
- The rule fires on #549's first commit, before that push, with the fix (*import with a relative
  path from admin/tests*). It does not fire on #559, which did not add the imports: a rule judges
  the change being made, not the state of the branch.
- **False alarms:** none. Both failed logs with the signature trace back to #549.

**`bundled-mcp-copy-lists`** — *a new bundled `packages/klypix-mcp/src/*.mjs` must be in the
app's four copy lists* (card `txt_lzblh4jq`).

- **One finding, a false alarm.** PR #470 added `semantic-install.mjs`, which only klypix-mcp's npm
  installer imports. The app's deployed project brain never loads it, so it is rightly absent from
  the copy lists. Whether a file must be listed depends on what imports it, and a diff rule does
  not follow imports. The rule should be narrowed (or retired) after this report.
- **A correct pass:** PR #548 added `network-bridge.mjs` together with all four list entries, and
  the rule stayed quiet.

### Rules from CLAUDE.md

The three hard constraints tested (`backgroundThrottling: false`, the `pdf.worker.js` path,
`window.prompt`) fired on nothing in 30 days. Nobody broke them, and the rules cost nothing.

### What klypix-app's failed runs were

42 of the 46 failed jobs failed in the vitest step of the Windows `ci` job. Two of those were
#549's imports; the rest were individual test failures. Of the other four, one failed installing
dependencies, one in the security-boundary step, one in a phone-space contract test, and one when
the runner shut down.

## Lesson routing on the real brains

`brain_rules` with `action: "propose"` sorts every lesson-shaped card into *rule*, *instruction* or
*note*, and drafts the rules. Run against each brain and its default branch:

| | AgentMug | klypix-app |
|---|---|---|
| Cards in the brain | 1,938 | 4,218 |
| Lesson-shaped cards | 356 | 1,007 |
| Routed to rule / instruction / note | 10 / 311 / 35 | 8 / 881 / 118 |
| Time (routing; parsing the brain and listing the repository) | 127 ms; 526 ms | 184 ms; 975 ms |
| Rule drafts that are real, checkable lessons (read by hand) | 3 of 10 | 5 of 8 |

The rule route is a shortlist for a person, not a decision. Of the 18 drafts, 8 were real lessons.
The other 10 were release notes and audit records that mention a lockfile or line endings next to
a file name; they would be rejected at approval, and nothing becomes active without approval. In
klypix-app the router found four real lessons that the hand-made rule set had missed:

- *relay errors must not use `error.details`* (`txt_05aznte9`);
- *new Drive owner API routes must be added to the web app's host-routing allowlist*
  (`txt_m2bdif2w`);
- *a new `../src/X.mjs` import must go into the flatten list in `bin/klypix-install.mjs`*
  (`txt_u2v50a93`);
- *a new src file must go into `bin/klypix-install.mjs` and all four app copy lists*
  (`txt_plz7n5y8`).

It missed one that the hand-made set has (`txt_lzblh4jq`): that card states the copy-list fact
without a *must* or *never*, so the router treats it as a record.

The flatten-list lesson is one this change repeated while it was being built: the new engine was
imported by the MCP worker but not added to the flatten list, and `test/cli-args.mjs` caught it
after a 276-second run. A rule made from that card would have flagged the import as it was written.

## What this does not show

- **A backtest is not a live run.** It shows what the rules would have printed on real commits. It
  cannot show whether an agent would have fixed the change or overridden the rule.
- **Most of the lessons are recent.** Several cards were written in the last days of the window, in
  some cases because of the very failure counted here. The cases show what a rule stops the next
  time a lesson repeats; a lesson the brain never recorded is caught by nothing.
- **List prices, not the invoice.** Included free minutes are not subtracted, and runs that the
  spending limit blocked are counted as free.
- **Time is the larger cost, and it is not priced here.** Each caught mistake cost a CI round trip
  of 7 to 12 minutes and a fix push with another full run; in klypix-app, a separate fix PR. The
  waiting and re-work of the agent or developer is not in the dollar figures.
- **Fires and blocks are counted per computer** in normal use (`~/.claude/project-brain/rules/`).
  Overrides, bypasses, false alarms and lifecycle changes are brain cards, shared through Git.
- **klypix-ios was not backtested.** Its CI runs on macOS runners. The rules themselves are plain
  diff checks and would run on its diffs from any computer.

## Reproduce it

```bash
node scripts/brain-rules-proof.mjs --gh dahshanlabs/AgentMug \
  --local <AgentMug checkout> --clone <scratch>/bt-agentmug --cache <scratch>/cache-agentmug \
  --since 2026-09-24 --until 2026-10-23 \
  --rules docs/brain-rules-proof/agentmug.rules.json \
  --rules docs/brain-rules-proof/agentmug.not-in-brain.rules.json \
  --signatures docs/brain-rules-proof/signatures.json \
  --log-workflows CI --log-workflows "Release safety" --per-commit --out agentmug.json

node scripts/brain-rules-proof.mjs --gh dahshanlabs/klypix-app \
  --local <klypix-app checkout> --clone <scratch>/bt-klypix --cache <scratch>/cache-klypix \
  --since 2026-09-24 --until 2026-10-23 \
  --rules docs/brain-rules-proof/klypix-app.rules.json \
  --rules docs/brain-rules-proof/klypix-app.not-in-brain.rules.json \
  --signatures docs/brain-rules-proof/signatures.json \
  --log-workflows ci --log-workflows ai-source-reading-contract --log-workflows ai-space-contract \
  --log-workflows drive-recovery-contract --log-workflows phone-space-contract \
  --per-commit --out klypix-app.json
```

It needs `gh` signed in with read access to the repository and its Actions. The first run reads
everything from GitHub (about 15 minutes for 1,000 runs); later runs use the cache.
