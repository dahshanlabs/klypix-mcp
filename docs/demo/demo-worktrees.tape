# The worktrees demo — rendered by VHS, driven by the real server.
#
# Same choreography as demo.tape, but the two sessions sit in TWO LINKED GIT
# WORKTREES of one repository. Session A opens FULL-WIDTH in the primary
# checkout (.demo-repo, branch main) and declares src/auth/token.ts. At ~6s the
# screen splits — that split is Session B arriving in the linked worktree
# .demo-repo/.worktrees/rate-limits (branch feat/rate-limiting), declaring the
# same file. The server's genuine exact-file-overlap heads-up lands in B's pane
# although the two sessions work in two checkouts: every linked worktree of a
# repository resolves to the one lane its primary checkout uses
# (agent-presence.mjs worktreeLaneIdentity follows git's commondir), so the
# peer list, the heads-up and messages span the worktrees. Nothing is staged
# output — both panes run docs/demo/pane.mjs, a real MCP client over stdio.
#
# The workflow plays the result back at 1.4x (ffmpeg, disclosed in README.md
# here): a timelapse of real output is still real output; dead air is not
# content.
#
# Render (CI does this in .github/workflows/demo.yml, input tape=demo-worktrees.tape):
#   node docs/demo/setup-worktrees.mjs && vhs docs/demo/demo-worktrees.tape
#
# Requires: vhs, ttyd, ffmpeg, tmux, git, node >= 20, npm ci already run.

Output docs/demo/demo-worktrees.gif

Set FontSize 17
Set Width 1700
Set Height 760
Set Padding 14
Set Theme "Catppuccin Mocha"

Hide
Type `tmux new-session -d -s demowt -x 224 -y 42 "node docs/demo/pane.mjs --label 'Session A · Claude Code · primary checkout (main)' --intent 'rewrite the auth token refresh' --files src/auth/token.ts --hold; sleep 30" && tmux set -g status off; (sleep 6 && tmux split-window -h -t demowt "node docs/demo/pane.mjs --label 'Session B · Codex · worktree feat/rate-limiting' --repo .demo-repo/.worktrees/rate-limits --intent 'add rate limiting to the auth routes' --files src/auth/token.ts,src/auth/routes.ts; sleep 30") >/dev/null 2>&1 & tmux attach -t demowt`
Enter
Sleep 2s
Show

# 0-6s: A full-width in the primary checkout — capsule + seeded cards arrive.
# ~6s: the split appears = Session B joins from the linked worktree; the
#      overlap heads-up lands in its pane and names the peer "in another worktree".
Sleep 13s

# ~15s: both panes settle on the shared picture.
Sleep 4s

Hide
Type `tmux kill-session -t demowt`
Enter
Show
