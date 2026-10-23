# Project rules: lessons that stop the repeat

Agents and people record lessons in the brain while they work: *every new route in `App.tsx` must
also be listed in `frontend-fallback.ts`*, *a new test file must be named in `package.json` or CI
never runs it*, *this file mixes CRLF and LF and a test pins its bytes*. A lesson in a card helps
only when the next session reads it and remembers it at the right moment. Some lessons can be
checked mechanically in a diff. **Project rules** turn exactly those lessons into checks that run
before the change reaches CI.

- **Made from the brain's own lessons.** Each rule cites the card it came from. Nobody writes a
  rule from nothing, and a lesson that cannot be checked mechanically stays a card.
- **Deterministic.** A check is file-name, glob, regex and line-ending work over the diff. No model
  runs at check time. It takes milliseconds, works offline and costs nothing.
- **A person approves every rule.** A drafted rule is a *candidate* and checks nothing until a
  person approves it with a code only they can print.
- **Warn by default.** An approved rule warns: when a session plans its files, while it edits, and
  at commit. It never stops the work unless the person chose *block* when approving it.
- **In the repository.** Rules live in `.klypix/rules.json`, so every change to a rule shows up in
  a pull request. When a rule is approved or retired, a visible card in the brain's **Rules** area
  links back to the lesson.
- **Every exception is on record.** Overrides, bypasses and false alarms become brain cards, and
  `npx klypix-mcp rules` shows each rule's blocks, overrides and false alarms.

Rules do not run your tests, type checker or build. CI still does that. A rule catches a known
mistake early: when an agent is about to write it, and again before the commit.

## What a rule can check

| Kind | What it catches | Example lesson |
|---|---|---|
| `listed-in` | A new file, or a new line matching a pattern, that must also appear in a registry file | New routes must be in the route list; new test files must be in `package.json` |
| `forbid-pattern` | An added line that matches a pattern in the files the rule covers | Admin tests must not import `@/…` |
| `preserve-eol` | A change that rewrites a file's line endings, for example mixed CRLF/LF flattened to CRLF by a Windows editor | A test pins one LF line in a mixed file |
| `cloud-required` | A change to paths that trigger the expensive CI (advice only) | Runner-impacting paths start the macOS and Windows matrix |

Severity is `warn` unless the person approves the rule with `--block`: `warn` says so and lets the
work through, `block` stops the edit or the commit, `advise` is a note. `cloud-required` is always
`advise`, and a candidate is never `block`.

Two real rules, from [`docs/brain-rules-proof/`](brain-rules-proof/):

```json
{
  "id": "frontend-routes-registered",
  "status": "active",
  "kind": "listed-in",
  "severity": "warn",
  "why": "Every new App.tsx route must also be listed in frontend-fallback.ts, or a direct link to it returns 404.",
  "fix": "Add \"{1}\" to PRIVATE_ROUTES (or PUBLIC_ROUTES) in {registry}.",
  "source": { "card": "txt_w4fbw7m1" },
  "files": ["artifacts/agentforge/src/App.tsx"],
  "when": "added-lines",
  "pattern": "<Route path=\"(/[^\"*:]*)\"",
  "registry": ["artifacts/api-server/src/middlewares/frontend-fallback.ts"],
  "needle": "\"{1}\""
}
```

```json
{
  "id": "admin-tests-relative-imports",
  "status": "active",
  "kind": "forbid-pattern",
  "severity": "warn",
  "why": "The root vitest config has no @/ alias for admin/, so an admin test importing @/… fails to load in the Windows ci job.",
  "fix": "Import with a relative path from admin/tests (../lib/…).",
  "source": { "card": "txt_nxj3c0nm" },
  "files": ["admin/tests/**/*.test.ts", "admin/tests/**/*.test.tsx"],
  "pattern": "from ['\"]@/"
}
```

## Where a rule runs

The same engine runs at three points.

| When | Where | What happens |
|---|---|---|
| Planning | `brain_sync`, for the files a session declares or has touched | The session is told which rules apply to its files, with the fix and the lesson |
| Editing | Claude Code's edit hook (Edit, Write, MultiEdit) | Findings come back to the agent as context, once per session. A `block` forbid-pattern line is **denied** before it is written. A line-ending change is reported straight after the edit |
| Editing | Codex's hook | The same findings, as warnings. Codex's hook output cannot deny a tool call, so the commit hook is what stops it |
| Committing | git `pre-commit` and `pre-push` hooks (opt-in) | Every finding is printed. A failing `block` rule stops the commit or push, for every tool and every person; a `warn` rule lets it through |
| After a commit | git `post-commit` hook (opt-in) | A commit that landed while a `block` rule fails on it (`--no-verify`, or the hooks were off) is recorded as a bypass |

At edit time a `listed-in` rule never denies the edit, because the registry change may be the next
edit. The commit hook checks the finished change.

What an agent reads when a rule fires. This is the rule above, run on the commit that failed
AgentMug's CI in PR #790 (from the [backtest](brain-checks-proof.md)):

```text
⚠ WARNING — project rule `frontend-routes-registered` (lesson txt_w4fbw7m1)
  Found: artifacts/agentforge/src/App.tsx:522 adds `<Route path="/organization"`, but `"/organization"` is not in artifacts/api-server/src/middlewares/frontend-fallback.ts
  Why:   Every new App.tsx route must also be listed in frontend-fallback.ts, or a direct link to it returns 404.
  Fix:   Add "/organization" to PRIVATE_ROUTES (or PUBLIC_ROUTES) in artifacts/api-server/src/middlewares/frontend-fallback.ts.
```

A rule approved with `--block` prints the same lines under `✗ BLOCKED`, and the commit stops.

You can also run the check by hand, or as a step in CI:

```bash
npx klypix-mcp check                 # the working tree against HEAD
npx klypix-mcp check --staged        # what the next commit holds
npx klypix-mcp check --base origin/main    # everything this branch adds
npx klypix-mcp check --json --strict       # machine-readable; warnings fail too
```

Exit codes: `0` passes, `1` a `block` rule failed (or a `warn`, with `--strict`), `2` the rules
file is invalid. When the rules file is invalid, the git hooks do not block anything: an invalid
rules file must not stop every commit.

## From lesson to active rule

1. **Propose.** An agent calls `brain_rules` with `action: "propose"`. It reads the brain's lessons
   and sends each one to one of three routes, and says why:
   - **rule** — the lesson's own sentence states a constraint (*must*, *never*, *only*, …, or the
     card is a 🛠️ skill) and names a file or folder that exists in this repository, or, for a
     forbidden pattern, the code it forbids. A draft comes with it, with the paths resolved.
   - **instruction** — the lesson is about how to work, not about a file's content ("amend locally
     and push once"). It belongs in the agent instructions, not in a check.
   - **note** — a record of what happened. It stays a card.
2. **Add.** The agent completes a draft (pattern, registry, fix) and calls `brain_rules` with
   `action: "add"`. The rule is written to `.klypix/rules.json` as a `candidate`. It checks
   nothing yet. A rule must cite a card that exists in the brain.
3. **Try it.** `brain_rules` with `action: "check"` and `include_candidates: true` shows what the
   candidate would catch on the current change, before anyone approves it.
4. **Approve.** In their own terminal, the person runs:

   ```bash
   npx klypix-mcp rules code promote frontend-routes-registered
   ```

   It prints each rule in full (files, pattern, registry, fix and the lesson it came from), says
   whether the rules will warn or block, then prints an 8-character code for exactly that, valid
   today. Approved rules warn. To make them stop an edit or a commit, the person adds `--block`
   (`npx klypix-mcp rules code promote <ids> --block`); the code covers that choice, so a code
   printed for warning rules cannot make them block. The person pastes the code into the
   chat, and the agent calls `brain_rules` with `action: "promote"` and `approve: "<code>"` (and
   `block: true` after `--block`). Or the person runs `npx klypix-mcp rules promote <ids> --code
   <code>` themselves, with `--block` if they chose it. The rule becomes
   `active`, records who approved it and when, and gets its card in the brain's Rules area, linked
   from the lesson.
5. **Commit `.klypix/rules.json`.** The rule is now part of the repository and reaches every clone.
6. **Turn on the commit hooks** in each clone that should be stopped at commit time:

   ```bash
   npx klypix-mcp check --install-hook   # pre-commit, pre-push, post-commit
   npx klypix-mcp check --remove-hook
   ```

   The installer adds a marked block to an existing shell hook and leaves other hooks alone. If a
   hook manager (husky, lefthook) owns `core.hooksPath`, it writes nothing and prints the line to
   add to each of that manager's hooks.

`rules code` and `rules allow` refuse to run inside an agent's shell. Claude Code and Codex mark
every command their agent runs (`CLAUDECODE`, `CODEX_THREAD_ID`), so an agent cannot print the
approval code for itself by accident. This prevents mistakes; it is not a
security boundary. An agent that strips its environment is deliberately working around you, and
any change to `.klypix/rules.json` still shows in review.

## Exceptions, bypasses and false alarms

| You want to | Command | What is recorded |
|---|---|---|
| Let one real exception through | `npx klypix-mcp rules allow <id> --reason "<why>" [--file <path>]`, in your own terminal | An allowance for one hour, used up by the next commit that needs it. The override and your reason become a brain card |
| Override one command | `KLYPIX_RULES_OVERRIDE="<id>: <reason>" git commit …` | The same override card, naming the agent shell it was set in, if any |
| Skip the hook | `git commit --no-verify` | If a `block` rule fails on that commit, the post-commit hook records a bypass card |
| Switch rules off for one command | `KLYPIX_RULES=0 git commit …` | Recorded the same way as `--no-verify` |
| Say a rule was wrong | `npx klypix-mcp rules false-alarm <id> --reason "<why>"`, or `brain_rules` `false_alarm` | A false-alarm card. The rule stays active |

The messages an agent receives name the fix first. They mention the exception commands only as the
person's choice.

## Is a rule earning its place?

```bash
npx klypix-mcp rules
```

In a scratch repository with those two rules, the route rule approved with `--block`, after one
blocked commit that was then pushed through with `--no-verify`:

```text
.klypix/rules.json: 2 rule(s) · git hooks: installed
  [active] frontend-routes-registered (listed-in, block) — fires 1, blocks 1, overrides 1, false alarms 0 · lesson txt_w4fbw7m1
  [active] runner-impacting-paths (cloud-required, advise) — fires 0, blocks 0, overrides 0, false alarms 0 · lesson txt_k0y07qny
```

It suggests retiring a rule that has not fired for 30 days, and narrowing a rule that is often
overridden or reported as wrong (3 or more, and at least half as many as it blocked). Retiring
needs a code too (`npx klypix-mcp rules code retire <id>`), so a session that a rule blocks cannot
lift the rule itself. A retired rule stays in the file with its reason, and its card says so.

Fires and blocks are counted in a small file on each computer
(`~/.claude/project-brain/rules/`), because a card for every block would flood the brain. So the
counts are per computer. Overrides, bypasses, false alarms, approvals and retirements are brain
cards, so everyone sees them through Git.

## Limits

- **Diff only.** A rule sees file names, added lines, line endings and which paths changed. It does
  not run code, types, tests or builds, and it cannot know what a test will conclude.
- **As good as its pattern.** The route rule above checks fixed paths. Routes with parameters
  (`/agents/:id`) are matched by regexes in the code it guards, so the rule leaves them alone.
- **Codex is warned, not stopped, while it edits.** The commit hook stops the commit.
- **The commit hooks are opt-in per clone.** A clone without them still gets the planning notice
  and, in Claude Code, the edit check.
- **The approval code and the agent-shell refusal prevent accidents.** They do not stop someone
  who sets out to get around them. Review of `.klypix/rules.json` and the bypass cards are the
  backstop.
- **Plugin mode** (`KLYPIX_PLUGIN=1`) can propose, check, show status and record false alarms. It
  does not write `.klypix/rules.json`.

## Rule fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits, `.`, `_`, `-`; 2–64 characters |
| `status` | yes | `candidate`, `active` or `retired`. Only `active` rules check anything |
| `kind` | yes | `listed-in`, `forbid-pattern`, `preserve-eol` or `cloud-required` |
| `severity` | yes | `block`, `warn` or `advise` |
| `why` | yes | The lesson in one line, as the agent will read it |
| `fix` | yes | What to do. Templates: `{file}` `{line}` `{needle}` `{registry}` `{match}` `{1}` |
| `source.card` | yes | The brain card the lesson is in |
| `files` | yes | Repo-relative globs the rule covers (`**` spans folders; `{a,b}` alternates) |
| `exclude` | no | Globs left out |
| `when` | listed-in | `added-files` (a new file) or `added-lines` (a new line matching `pattern`) |
| `pattern`, `flags` | listed-in (added-lines), forbid-pattern | A regex. For `listed-in`, capture group 1 is the value to look for |
| `registry` | listed-in | The file or files the value must appear in |
| `registryMode` | no | `all` (default) or `any` |
| `needle` | listed-in | What to look for in the registry. Templates: `{file}` `{basename}` `{name}` `{relpath}` `{1}` |
| `base` | no | The folder `{relpath}` is relative to |

Approval and retirement add `approvedAt`, `approvedBy`, `retiredAt`, `retiredReason` and
`mirrorCard` (the rule's card in the brain). A rule with an unknown field, a `<placeholder>` left
in or a pattern that does not compile is refused.

What the backtest on two real repositories found is in [brain-checks-proof.md](brain-checks-proof.md).
