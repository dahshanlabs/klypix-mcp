# Decision changes during a task

`brain_sync` automatically remembers the card revisions it supplies in a task's
context capsule. No watch list or extra call is needed. At a later checkpoint or
completion, it compares those cards with the current brain and reports meaningful
text changes, archival or removal, and explicit `superseded by` relationships.
An unrelated card edit or a layout change produces no alert. This is an experimental
feature; effectiveness at reducing rework has not been established.

For example, a task receives “round tax per invoice line.” Another session changes
that decision to “round once on the combined subtotal.” The task's next
`brain_sync` shows the previously supplied text, the current text, and their card
IDs. Existing Claude Code guard hooks and optional, trusted Codex hooks can also
offer the alert at a supported tool boundary, before the next `brain_sync`.
Matching the new wording against the original task description is unnecessary.

## Completion and review

An unresolved change appears in `structuredContent.decisionChanges`:

```json
{
  "status": "pending-review",
  "scopeReleased": true,
  "pending": 1,
  "changes": [
    {
      "change_id": "<returned change identifier>",
      "revision": "<returned current revision>",
      "kind": "changed",
      "before": { "id": "txt_example", "text": "Round tax per invoice line." },
      "current": { "id": "txt_example", "text": "Round once on the combined subtotal." }
    }
  ]
}
```

Completion follows the existing presence contract and releases active task scope.
Pending decision reviews remain visible in the response; they do not reserve files
or establish that the task incorporated the change. An agent should report any
unresolved changes in its final response.

After checking its work, the agent can report a disposition through the same tool:

```json
{
  "phase": "checkpoint",
  "decision_reviews": [{
    "change_id": "<previously returned change identifier>",
    "revision": "<still-current returned revision>",
    "outcome": "adapted",
    "note": "Changed invoice calculation and checked the rounding test."
  }]
}
```

`adapted` and `not-applicable` record an **agent-reported** disposition; neither is
independent verification. `blocked` keeps the change pending. A stale revision
cannot clear a newer change. Re-reading the updated card, omitting reviews, or
receiving a coordination-message receipt never counts as adoption.

## Boundaries

- Comparison runs at `brain_sync` and existing native hook boundaries: Claude
  Code's `PreToolUse` guard for Bash/PowerShell/Edit/Write/MultiEdit; Codex's optional
  `PreToolUse` for apply_patch/Edit/Write and `PostToolUse` for other tools. Hook
  installation, matchers and trust settings are unchanged. Without active native
  hooks, the boundary remains `brain_sync`.
- Native alerts are advisory context. They do not cancel an already-selected tool
  call, guarantee the agent reads the warning, or prove prevented rework. The
  next model action can reconsider the decision. A first alert includes old/current
  text; subsequent unchanged pending checks give a compact reminder. Ordinary
  unchanged checks use file metadata and the small task state, without parsing
  the brain. A changed file is rechecked against current privacy settings.
- This version watches the task capsule, not separate `brain_ask` responses or
  memory read outside KLYPIX. Hooks never create a watch or reset task state.
  They require the exact native session and active task generation; Claude
  subagents do not inherit their parent's watched decisions.
- State is machine-local and belongs to one canonical brain, logical session and
  task generation. It survives a worker restart. A new task starts a new baseline;
  this state does not travel in a Git clone or through the optional network add-on.
- The watched revision covers the card, even when the capsule displays an excerpt.
  A later change means the supplied card changed, not proof that the agent used
  every word of it. An already-supplied correction watches the current card.
- Up to 24 cards are watched per task. Four pending changes appear per response;
  reviewing a batch makes room for the next. Limits and omitted changes are explicit.
  Stored text is capped at 4,000 characters and rendered excerpts at 1,200; truncation
  is marked. The revision fingerprint still covers the full card text.
- Current privacy settings apply to both sides. If a supplied card or its replacement
  becomes AI-hidden, the old cached text is removed and neither body is returned.
- Unreadable brain/state data produces `unknown`, never a claim that decisions
  stayed unchanged. `not-watching` means no capsule cards were available to track.
- `include_context:false` on a checkpoint defers this check and adds no watched
  cards. Completion still checks cards supplied earlier, even when retrieval is
  disabled, so the final response can name pending work.

The focused regressions are `node test/decision-watch.mjs` and
`node test/decision-watch-hooks.mjs`. Their fixtures, state, worker and hook
processes use fresh temporary homes; neither requires a model or paid API.
