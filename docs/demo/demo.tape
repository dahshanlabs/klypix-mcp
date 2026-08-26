# The README first-screen demo — rendered by VHS, driven by the real server.
#
# Choreography: Session A opens FULL-WIDTH and declares its task. At ~6s the
# screen splits — that split is Session B arriving. B declares an overlapping
# file and the server's genuine exact-file-overlap warning lands in its pane.
# A then records a correction through brain_note. Nothing is staged output —
# both panes run docs/demo/pane.mjs, a real MCP client over stdio.
#
# The workflow plays the result back at 1.4x (ffmpeg, disclosed in README.md
# here): a timelapse of real output is still real output; dead air is not
# content.
#
# Render (CI does this in .github/workflows/demo.yml):
#   node docs/demo/setup.mjs && vhs docs/demo/demo.tape
#
# Requires: vhs, ttyd, ffmpeg, tmux, node >= 20, npm ci already run.

Output docs/demo/demo.gif

Set FontSize 17
Set Width 1700
Set Height 760
Set Padding 14
Set Theme "Catppuccin Mocha"

Hide
Type `tmux new-session -d -s demo -x 224 -y 42 "node docs/demo/pane.mjs --label 'Session A · Claude Code' --intent 'rewrite the auth token refresh' --files src/auth/token.ts --note 'Auth: token refresh now retries once on clock skew — CORRECTION: supersedes \"refresh fails closed on any clock skew\".' --note-after 14500 --hold; sleep 30" && tmux set -g status off; (sleep 6 && tmux split-window -h -t demo "node docs/demo/pane.mjs --label 'Session B · Codex' --intent 'add rate limiting to the auth routes' --files src/auth/token.ts,src/auth/routes.ts; sleep 30") >/dev/null 2>&1 & tmux attach -t demo`
Enter
Sleep 2s
Show

# 0-6s: A full-width — capsule + seeded correction card arrive.
# ~6s: the split appears = Session B joins; its overlap warning lands.
Sleep 13s

# ~16s: A's brain_note correction fires and both panes settle.
Sleep 7s

Hide
Type `tmux kill-session -t demo`
Enter
Show
