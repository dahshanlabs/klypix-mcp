# Contributing

Thanks for looking under the hood. This project is small, moves fast, and holds itself
to one rule above everything: **a claim that a stranger cannot verify does not ship.**
Contributions are reviewed against that rule too.

## Ground rules

- **Node >= 20.** CI runs 24.x; anything that only works on newer syntax will surface there.
- **Plain JavaScript ESM** (`.mjs`). No TypeScript, no build step — what is in `src/` is
  what runs.
- **No new runtime dependencies without discussion.** The dependency list is five entries
  and deliberately so; every addition is supply-chain surface for everyone who runs
  `npx klypix-mcp` inside their repo.
- **Never hand-edit a `.klypix` file in a test or fixture** — go through the format API
  in `src/klypix-format.mjs`, as the whole no-loss story depends on every writer using
  the same codec.

## Running the tests

```bash
npm ci
npm test
```

`npm test` runs the full chain — 83 suites plus a `pretest` gate that lints the release
workflow. It is the same command the release gate runs on ubuntu, so green locally is a
good predictor of green in CI. Known flake: an intermittent Windows `EPERM` on rename in
`test/mcp-supervisor.mjs`; if you hit it once, re-run before assuming your change caused it.

A focused loop while developing:

```bash
node test/<one-suite>.mjs
```

Every suite is a standalone Node script with its own assertions — there is no test
runner to configure.

## What a good PR looks like here

- **One concern per PR.** A fix and a refactor travel separately.
- **A test that fails without the change.** The suites in `test/` are the contract;
  behaviour that matters gets pinned there. If your change is worth merging it is worth
  a pin.
- **Commit messages say why**, not just what. This repo's history is used as evidence
  by the brain tooling itself — a rationale-bearing message is literally more useful
  here than in most projects.
- **Numbers come with a reproduction.** If your PR description quotes a measurement,
  include the command that produced it. `npx klypix-mcp bench` exists for exactly this.

## Reporting bugs

Open an issue with the version (`npx klypix-mcp doctor` prints it, along with most of
what we will ask next), the host (Claude Code / Codex / Cursor / …), the OS, and the
smallest reproduction you have. `doctor` output pasted verbatim saves a round-trip.

For anything security-shaped, see [SECURITY.md](SECURITY.md) — please do not open a
public issue.

## Questions

[GitHub Discussions](https://github.com/dahshanlabs/klypix-mcp/discussions) for
anything open-ended; [hello@klypix.com](mailto:hello@klypix.com) works too.
