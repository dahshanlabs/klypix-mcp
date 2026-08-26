# The README first-screen demo — rendered by VHS, driven by the real server.
#
# Two real MCP sessions in a tmux split. Session A declares a task; Session B
# declares an overlapping file and the server's genuine overlap warning fires.
# Then A records a correction through brain_note. Nothing is staged output —
# both panes run docs/demo/pane.mjs, a real MCP client over stdio.
#
# Render (CI does this in .github/workflows/demo.yml):
#   node docs/demo/setup.mjs && vhs docs/demo/demo.tape
#
# Requires: vhs, ttyd, ffmpeg, tmux, node >= 20, npm ci already run.

Output docs/demo/demo.gif

Set FontSize 15
Set Width 1460
Set Height 720
Set Padding 16
Set Theme "Catppuccin Mocha"

Hide
Type `tmux new-session -d -s demo -x 210 -y 46 "node docs/demo/pane.mjs --label 'Session A · Claude Code' --intent 'rewrite the auth token refresh' --files src/auth/token.ts --note 'Auth: token refresh now retries once on clock skew — CORRECTION: supersedes \"refresh fails closed on any clock skew\".' --note-after 17000 --hold; sleep 30" && tmux split-window -h -t demo "sleep 8; node docs/demo/pane.mjs --label 'Session B · Codex' --intent 'add rate limiting to the auth routes' --files src/auth/token.ts,src/auth/routes.ts; sleep 30" && tmux attach -t demo`
Enter
Sleep 3s
Show

# A's capsule arrives; B joins at ~8s; the overlap warning lands in B's pane.
Sleep 16s

# A's correction is captured; both panes settle.
Sleep 9s

Hide
Type `tmux kill-session -t demo`
Enter
Show
