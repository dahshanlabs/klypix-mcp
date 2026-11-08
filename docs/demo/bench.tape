# The bench result card — rendered by VHS, drawn from the results file.
#
# One command: bench/coordination/render-card.mjs prints the coordination
# bench's result card row by row (small delays, so the card builds up). Every
# number on it — pass/n, the 95% interval, the versions, the date, the "not
# measured" reasons — is read from the newest *.summary.json in
# bench/coordination/results/, which summarize.mjs computes from a results
# .jsonl. Nothing on screen is typed by hand; when the results change,
# re-render this tape and the card changes with them. Any cell with n < 5
# puts a visible caveat line on the card (the 2026-11-08 pilot is all n = 1).
#
# Render (CI does this in .github/workflows/demo.yml, input tape=bench.tape):
#   vhs docs/demo/bench.tape
# To render an older file, run the renderer with its path by hand; the tape
# always shows the newest summary, which is what the README should carry.
#
# Requires: vhs, ttyd, ffmpeg, node >= 20, npm ci already run. No tmux, no
# seeded demo repo: the renderer reads one JSON file.

Output docs/demo/bench.gif

Set FontSize 16
Set Width 1240
Set Height 820
Set Padding 14
Set Theme "Catppuccin Mocha"

# The renderer wraps at 96 columns; at 1240 px and 16 pt the terminal is wider
# than that, so nothing wraps a second time and the title stays on screen.
Type `node bench/coordination/render-card.mjs --width 96`
Sleep 600ms
Enter

# The card builds up at ~0.4 s per row; the pilot card is ~28 lines.
Sleep 14s
