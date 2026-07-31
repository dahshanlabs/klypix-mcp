# Probe engine — design (not built)

**Status:** design only, 2026-08-01. Nothing here is implemented; do not describe it as shipped.
**Closes:** the last open item of the decay-aware roadmap (class-C: the world changed with no
session watching) — "the engine actually RUNNING a card's `verify:` command on demand, and
demanding a probe receipt before rendering a release-shaped answer as current."

## Why this is design-first, in one sentence

`brain.klypix` is a **co-owned file**: humans, multiple agent brands, and — on shared projects —
*other people* write it, and it travels by git to every collaborator's machine. An engine that
executes `verify:` strings from that file is remote code execution with extra steps: user A (or a
compromised agent session, or a poisoned merge) writes `verify: curl … | sh`, and it runs on user
B's machine the first time B's brain asks a status question. Every other property of this design
is subordinate to closing that path.

## The threat model, explicitly

| Actor | Vector | Consequence if naive |
|---|---|---|
| Malicious/compromised collaborator on a shared brain | authors a hostile `verify:` line; git delivers it | arbitrary command execution on every collaborator machine |
| Compromised agent session | captures a card carrying a hostile probe | same, self-inflicted |
| Prompt-injected agent | tricked into writing a probe that exfiltrates (`gh api` to attacker host, `git push`) | data exfiltration under an allowlisted binary |
| Nobody malicious | a typo'd probe with side effects (`npm version`, `git tag`) | state mutation presented as verification |

## Design: the card never carries a command — it carries a *reference*

The single load-bearing decision: **the brain file must never contain executable text.** A card's
`verify:` field holds a *probe reference* — a name from an engine-side registry plus bounded,
validated arguments:

```
verify: npm-version klypix-mcp            → registry probe "npm-version", arg validated as a package name
verify: gh-release dahshanlabs/KLYPIX     → probe "gh-release", arg validated as owner/repo
verify: git-file-head electron/main.ts    → probe "git-file-head", arg validated as a repo-relative path
```

- The **registry lives in engine code** (versioned, reviewed, shipped through the same test-gated
  pipeline as everything else). A brain file can name a probe; it can never define one.
- Each probe is **read-only by construction**: implemented with `execFileSync` (argv array — no
  shell, no interpolation, ever), a fixed binary, fixed subcommand, and arguments that must match a
  strict per-probe validator (package-name grammar, `owner/repo` grammar, repo-relative path with
  no `..`). An argument that fails validation is a refused probe, not a sanitized one.
- **Network egress is confined** to the probe's own tool (`npm view`, `gh api GET`, `git ls-remote`)
  — no probe takes a URL. A URL-shaped argument is refused.
- **Unknown probe name → the card renders exactly as today** (⏱️ LAST KNOWN). Forward-compatible
  and fail-closed.

## When probes run — never on render

- **Never during brief/sync/ask assembly.** Those paths are pure and fast today; a network call in
  them would tax every session start on every host. Probes run only:
  1. **on demand** — `brain_ask` status mode / `brain_doctor` explicitly requesting verification;
  2. **per-user consent, once per project** — the first probe on a machine asks (same consent
     shape as the Codex hook trust boundary); headless runs without consent simply don't probe.
- **Receipts are cached** (`probe-receipts.jsonl` beside the lane, machine-local, TTL per probe
  class — minutes for release state, hours for file heads). A cached receipt renders as
  `✅ probed <age>`; an expired one as ⏱️ LAST KNOWN with the offer to re-probe.
- **Failure is a first-class result**: offline / rate-limited / nonzero-exit probes render
  `⏱️ LAST KNOWN (probe failed: <class>)` — never an exception, never silently "current".
- **Timeout ≤ 5s per probe, ≤ 3 probes per answer**, refusals logged to the health ledger.

## What a receipt buys

A release-shaped answer ("is 1.3.72 published?") can then hold three honest states instead of two:

| State | Render |
|---|---|
| probed, fresh | `✅ probed 2m ago — npm has 1.45.1` |
| known, unprobed | `⏱️ LAST KNOWN (…) — verify live` (today's behavior, unchanged) |
| probe failed | `⏱️ LAST KNOWN — probe failed (offline)` |

The brain stops *asserting* fast-decay state without saying which of the three it is in.

## Deliberately out of scope

- Arbitrary user-defined probes (that is the vulnerability, not a feature gap).
- Probes that write anything, anywhere, including "harmless" cache warms via the probed tool.
- Cross-machine receipt sharing (receipts are observations of *this* machine's vantage; shipping
  them re-creates the stale-relay class the decay work closed).
- Auto-probing on a schedule (cost + surprise egress; on-demand keeps the user the initiator).

## Acceptance gates before building

1. A hostile-brain fixture: cards carrying shell metacharacters, URLs, `..` paths, and an unknown
   probe name — the suite must prove zero process spawns for all of them.
2. The three-state render proven in `brain_ask` status mode and `brain_doctor`.
3. Consent flow proven denied-by-default in a headless run.
4. Latency: brief/sync/ask assembly time unchanged to the millisecond with probing enabled but
   not requested.
