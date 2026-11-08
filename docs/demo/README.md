# The README demo — real output, rendered by CI

This folder produces the first-screen GIF: two real MCP sessions in a tmux
split, the second one receiving the server's genuine file-overlap warning,
then a correction captured through `brain_note`.

**Nothing here is staged.** `pane.mjs` is a real MCP client (the repo's own
SDK, stdio transport, same as any coding-agent host); it prints the server's
response text verbatim, colorized by section and never rewritten. If the
product stops warning about overlap, the demo stops showing a warning. The
project content on screen is `aurora`, a fictional weather app seeded by
`setup.mjs` — never a real project (public-asset rule).

## Render it

**CI (recommended):** run the *Render README demo GIF* workflow
(Actions → workflow_dispatch). It seeds the demo repo, plays `demo.tape`
with VHS on a clean runner, sanity-checks the file size, and uploads
`demo-gif` as an artifact. Download, look at it, commit it deliberately —
the workflow itself has no write access.

**Locally** (Linux/macOS with [vhs](https://github.com/charmbracelet/vhs),
ttyd, ffmpeg, tmux):

```bash
npm ci
node docs/demo/setup.mjs
vhs docs/demo/demo.tape     # writes docs/demo/demo.gif
```

A clean machine matters: live sessions from earlier runs appear as real peers
(they are real peers — presence ages out after ~10 minutes).

## Try one pane by hand

```bash
node docs/demo/setup.mjs
node docs/demo/pane.mjs --label "Session A" \
  --intent "rewrite the auth token refresh" --files src/auth/token.ts
```

Run it twice in two terminals with an overlapping `--files` (keep the first
alive with `--hold`) and the second one shows the real overlap warning.

## Timing in `demo.tape`

Session A opens full-width and declares its task; at ~6s the screen splits —
the split itself is Session B arriving. B's overlap warning lands, then A's
correction fires at ~15s so it lands after the warning is on screen. If you
retune the pacing, keep B after A and the note after B.

## The worktrees tape — `demo-worktrees.tape`

A second recording of the same real server, with the two sessions in **two
linked git worktrees of one repository**: Session A in the primary checkout
(`.demo-repo`, branch `main`), Session B in
`.demo-repo/.worktrees/rate-limits` (branch `feat/rate-limiting`). Both declare
`src/auth/token.ts` through `brain_sync`, and B's pane receives the genuine
exact-file-overlap heads-up, naming the peer as working `(in another worktree)`.
Every linked worktree of a repository resolves to the one lane its primary
checkout uses (`agent-presence.mjs` `worktreeLaneIdentity` follows git's
`commondir`), so the peer list, the heads-up and messages span the worktrees.
No pane changes: B is simply started with `--repo` pointing at the worktree.

```bash
node docs/demo/setup-worktrees.mjs          # seeds .demo-repo AND adds the worktree
vhs docs/demo/demo-worktrees.tape           # writes docs/demo/demo-worktrees.gif
```

In CI the *Render README demo GIF* workflow takes a `tape` input
(`demo.tape`, the default, or `demo-worktrees.tape`); it seeds with the matching
setup script, renders `docs/demo/<tape name>.gif` and uploads it as the
`<tape name>-gif` artifact. The committed `demo.gif` is untouched by a
worktrees render.

## The bench card — `bench.tape`

A third tape, with no tmux and no demo repo: it runs
`node bench/coordination/render-card.mjs`, which prints the coordination bench's
result card row by row — one row per scenario, one column per condition, each
cell `pass/n`, a small bar and the 95% Wilson interval, colour by pass rate
only (never by vendor), then the "Not measured" conditions with the kit's own
reason and the line that points at `bench/coordination/results/`.

**Every number is read from a file.** The renderer opens the newest
`bench/coordination/results/*.summary.json`; that file is written by
`bench/coordination/summarize.mjs` from a results `.jsonl`, with
`lib/stats.mjs` computing the intervals and `scenarios.mjs` / `conditions.mjs`
supplying titles, labels and the not-measured reasons. Nothing is typed into
the tape or the renderer, so when the results change the GIF is re-rendered,
not edited. Any cell with n < 5 puts a visible caveat line on the card — the
2026-11-08 Concord pilot is all n = 1 and says so on screen.

```bash
node bench/coordination/summarize.mjs bench/coordination/results/<run>.jsonl \
     bench/coordination/results/<run>.summary.json     # once per results file
node bench/coordination/render-card.mjs                 # newest summary, with delays
node bench/coordination/render-card.mjs <file> --no-delay --no-color   # plain text
vhs docs/demo/bench.tape                                # writes docs/demo/bench.gif
```

In CI: *Render README demo GIF* → `tape` = `bench.tape`. The workflow skips the
tmux install and both seeding steps, runs `test/bench-card.mjs` and prints the
card to the log before VHS draws it, then uploads `bench-gif`. The 1.4×
playback step applies to this tape too. `test/bench-card.mjs` (in `npm test`)
checks that the printed numbers equal the JSON, that the n < 5 caveat appears
for the pilot, and that a missing file renders nothing but a clear error.

**Playback is sped up 1.4× by the workflow's ffmpeg step** — a timelapse of a
real run, disclosed here on purpose: every frame is genuine output; only the
dead air between server responses is compressed. The pane driver word-wraps
its output at ~72 columns (the ~77-col post-split pane minus slack for wide glyphs like — and ·) so lines printed before the split are not clipped
when the pane narrows (tmux does not rewrap existing rows).

## The bench chart

`bench/coordination/render-chart.py` draws the same `*.summary.json` the card
uses as animated bars: one group per scenario, one bar per condition, height =
pass rate, thin line = the 95% interval, label = pass/n. KLYPIX is emerald,
every other condition a neutral grey. A cell with fewer than five runs puts a
visible caveat on the chart. The *Render README demo GIF* workflow renders it
next to the card when `tape = bench.tape` and uploads `bench-chart`
(`bench-chart.gif` + a still `bench-chart.png`). Locally:

```bash
python -m pip install matplotlib pillow
python bench/coordination/render-chart.py            # newest summary -> docs/demo/bench-chart.gif
```
