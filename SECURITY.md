# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security report.**

Use GitHub's private reporting — [Report a vulnerability](https://github.com/dahshanlabs/klypix-mcp/security/advisories/new) —
or email [hello@klypix.com](mailto:hello@klypix.com) with `SECURITY` in the subject.

This is a small project. What that means in practice, stated plainly rather than as an
SLA we cannot keep: expect a first human reply within about a week. If you have not
heard back in two weeks, please chase it — a missed report is far more likely to be an
oversight than a decision.

Tell us what you can of: the version (`npx klypix-mcp doctor` prints it), the host and
OS, what an attacker gains, and the smallest reproduction you have. A partial report is
worth sending; do not sit on something because it is not fully characterised.

## Supported versions

Fixes ship on the latest published version only. There are no maintained release
branches — `npm i klypix-mcp@latest` is the upgrade path, and the supervisor's
once-per-24h version check (disable with `KLYPIX_AUTO_UPDATE=0`) is how most
installations learn a new one exists.

## What this package touches

The [Security and permissions](README.md#security-and-permissions) section of the README
is the authoritative description and is kept current. In summary, and relevant to what a
report might concern:

- **`install` writes outside the project** — `~/.claude/project-brain`,
  `~/.claude/settings.json` (five hooks, written even when Claude Code is absent),
  `~/.codex/AGENTS.md`, and with `--codex-hooks`, `~/.codex/hooks.json`.
- **`link` writes 14 files inside the project** it is run in. `link --check` audits
  without writing.
- **The brain is a file in your repository** and the presence lane is a file under your
  home directory. Both are readable by anything running as your user; neither is
  encrypted at rest, and neither is intended to hold secrets.
- **The engine makes no network calls**, with two documented exceptions: the
  once-per-24h npm version check, and — only after explicit, per-brain, default-off
  consent given in the KLYPIX desktop app — the cross-PC presence relay.
- **Coordination between sessions is advisory.** Overlap warnings are a coordination
  aid, not an access control. Nothing here is a security boundary between agents
  running as the same user, and it should not be relied on as one.

## Scope

In scope: anything that lets a repository, a dependency, an MCP host, or another user on
the machine read or write outside the paths listed above; injection through brain
content, coordination notes, or tool arguments; and any path where the relay transmits
without a current consent grant.

Out of scope: an agent you authorised doing something you did not want, and the fact
that a local file is readable by processes running as you.

## Credit

We will credit you in the release notes for the fix unless you would rather we did not.
