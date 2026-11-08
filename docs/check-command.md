# `klypix-mcp check <files...>`: is a live session working on this file right now?

A hook or a CI step often needs one small answer before an edit or a commit goes ahead: *is
another agent session on this project — a different terminal, a different tool, a different
provider — declaring or editing this file at this moment?* `brain_sync` already answers that
inside a session. `check` is the same answer as a process exit code, so a shell can act on it
without an MCP client.

```sh
npx klypix-mcp check src/App.tsx electron/main.ts
```

It is **read-only**. It never writes to the session lane, never registers itself as a session,
never changes the brain. It reads the lane the way `brain_sync` does and applies the same rules:
only live sessions count (a stale row or a session whose host process is gone is not a peer),
a session's own twin rows are never its peers, and a path a session was only *observed* editing
counts as much as a declared one.

## Exit codes

| Exit | Meaning | What prints (unless `--quiet`) |
|---|---|---|
| `0` | No live session declares or was observed editing any of the files. | `KLYPIX: no live session is working on <file>` |
| `1` | Overlap. **A heads-up, not a lock.** The hook author decides whether to stop. | One line per file and session, then `KLYPIX: N file(s) overlap with a live session — a heads-up, not a lock` |
| `2` | Could not answer: no `brain.klypix` above the directory, the session lane is unreadable, no files were named, or an unknown flag. | `KLYPIX: cannot answer — <reason>` on stderr |

An overlap line reads:

```
src/save.ts  Claude Code claude-a1 · fix the save path · branch feat/save
src/App.tsx*  Codex codex-bb · wire the settings panel · branch master
(* = observed from live edits, scope not declared)
KLYPIX: 2 file(s) overlap with a live session — a heads-up, not a lock
```

`*` marks a path the session never declared through `brain_sync` but was seen editing by its
host (the same mark `brain_sync` uses). The short id is the shortest prefix that identifies
that session among the live ones, the same one `brain_message` accepts.

Exit `2` is deliberately separate from `0`: a hook that treats "cannot answer" as "clear" would
go silent exactly when the lane is broken. Each hook below says what it does with `2`.

## Flags and arguments

| | |
|---|---|
| `<files...>` | Project-relative or absolute. Resolved against the folder holding `brain.klypix`, found by walking up from the current directory. Case and slash direction do not matter (same normalisation as `brain_sync`). A file that does not exist yet can be checked. |
| `--json` | Print one object instead of lines (below). Exit codes unchanged. |
| `--quiet`, `-q` | Print nothing. Exit code only. |
| `--project <dir>` | Start the walk from `<dir>` instead of the current directory. |
| `KLYPIX_SESSION_ID` (env) | When set, that session and its twin rows are excluded, so a hook running inside a session never warns about the session's own work. Claude Code sessions started through KLYPIX's hooks already have it; a hook can also pass it. |

`check` with flags only (`--staged`, `--base <ref>`, `--range A..B`, `--install-hook`, …) is the
[project rules check](brain-rules.md). Naming at least one file is what selects the
live-session check.

### `--json`

```json
{
  "command": "check",
  "project": "E:/work/klypix",
  "brain": "E:/work/klypix/brain.klypix",
  "status": "overlap",
  "exit": 1,
  "liveSessions": 2,
  "overlappingFiles": 1,
  "files": [
    {
      "file": "src/save.ts",
      "overlaps": [
        {
          "session": "claude-a1b2c3d4-…",
          "sessionShort": "claude-a1",
          "client": "claude-code",
          "intent": "fix the save path",
          "branch": "feat/save",
          "observed": false,
          "status": "working"
        }
      ]
    },
    { "file": "src/other.ts", "overlaps": [] }
  ]
}
```

`status` is `clear`, `overlap` or `unknown`; an `unknown` object carries `reason`, and `files` is the list as typed. Otherwise
every file asked about is listed, clear ones with an empty `overlaps` array.

## Hook snippets

### Claude Code: a `PreToolUse` hook on `Write` and `Edit`

Claude Code hands the tool input on stdin as JSON. This hook asks about the file the tool is about
to write and lets the overlap through as context (exit 2 from a PreToolUse hook shows its stderr
to the model and blocks the call; exit 0 lets the call proceed). The choice is the hook author's;
here, overlap is surfaced and allowed, and "cannot answer" is allowed silently.

`~/.claude/settings.json` (or the project's `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "bash .claude/hooks/klypix-check.sh" }]
      }
    ]
  }
}
```

`.claude/hooks/klypix-check.sh`:

```sh
#!/usr/bin/env sh
# Warn when another live session is on the file Claude is about to write.
FILE=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.tool_input?.file_path||"")}catch{}})')
[ -n "$FILE" ] || exit 0
OUT=$(npx -y klypix-mcp check "$FILE" 2>/dev/null)
case $? in
  0) exit 0 ;;                                   # nobody else is on it
  1) printf '%s\n' "$OUT" >&2; exit 2 ;;         # overlap: show it to the model and stop this write
  *) exit 0 ;;                                   # cannot answer: let the edit through
esac
```

To warn without stopping the write, exit `0` instead and print the lines as the hook's JSON
answer (`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"<the lines>"}}`),
which Claude Code hands to the model as context; plain stdout of an exit-0 PreToolUse hook is
kept in the transcript, not shown to the model. To stop the write when KLYPIX cannot answer
either, change the last branch to `exit 2`.

### git `pre-commit`

Ask about every staged file. Here an overlap prints and the commit continues; set
`KLYPIX_CHECK_STRICT=1` to stop the commit instead. "Cannot answer" never stops a commit here.

```sh
#!/usr/bin/env sh
FILES=$(git diff --cached --name-only --diff-filter=ACMR)
[ -n "$FILES" ] || exit 0
# shellcheck disable=SC2086
npx -y klypix-mcp check $FILES
case $? in
  1) [ "${KLYPIX_CHECK_STRICT:-0}" = "1" ] && exit 1 ;;
esac
exit 0
```

### GitHub Actions

On a shared runner the lane is empty (no session has run there), so the useful place is a
self-hosted runner or a developer machine acting as one. The step annotates the job instead of
failing it; drop `continue-on-error` and map exit 1 to a failure if the team wants the gate.

```yaml
- name: KLYPIX — live-session overlap on the changed files
  continue-on-error: true
  run: |
    FILES=$(git diff --name-only "${{ github.event.pull_request.base.sha }}" "${{ github.sha }}")
    [ -n "$FILES" ] || exit 0
    set +e
    OUT=$(npx -y klypix-mcp check $FILES)
    CODE=$?
    set -e
    case $CODE in
      0) echo "$OUT" ;;
      1) echo "::warning title=KLYPIX overlap::$OUT" ;;
      *) echo "::notice title=KLYPIX::could not answer (exit $CODE) — no brain or lane on this runner" ;;
    esac
```

## What it is, and is not

`check` warns. It reads what live sessions declared or were seen editing and reports it; it does
not hold a lock, does not stop another session from writing, and cannot see a session that never
reached the lane (an editor with no KLYPIX hook, a machine whose lane is elsewhere). Treat exit
`1` as a reason to look at `brain_sync` or send a `brain_message`, and let the hook author decide
what the shell does with it.
