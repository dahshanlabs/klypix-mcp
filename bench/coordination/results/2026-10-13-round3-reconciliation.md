# Round 3: historical run reconciliation

Audited 2026-10-13 while completing PR #88. These are the existing runs from
October 12–13, not a fresh evaluation of the current release or the later
stale-note changes in PR #90. The raw result rows are retained unchanged;
transcripts remain in the original local run directory.

| Agent | Raw rows | Unique attempts after latest-row selection | Measured | Not applicable | Final errors / invalid |
|---|---:|---:|---:|---:|---:|
| Claude | 166 | 165 | 115 | 50 | 0 / 0 |
| Codex | 156 | 155 | 80 | 75 | 0 / 0 |

Each measured cell has five trials. Reports are generated separately from
[Claude's rows](2026-10-13-round3-claude.jsonl) and
[Codex's rows](2026-10-13-round3-codex.jsonl):
[Claude report](2026-10-13-round3-claude-report.md),
[Codex report](2026-10-13-round3-codex-report.md).

The stopped-session task (S9) passed 5/5 with KLYPIX for both agents and 0/5
without a channel. Kept notes and a supplied relay also passed 5/5. For the
live-peer task (S10), Claude with installed hooks passed 5/5; MCP-only KLYPIX
passed 0/5 for both agents. The stale-note task S5 passed 0/5 in every measured
KLYPIX cell. On S5b, Claude MCP-only passed 1/5, Claude installed 0/5 and Codex
MCP-only 0/5; kept notes passed 5/5 for both agents. The valid-note harm check
S5c passed 5/5 in all measured cells, including no channel. These failures and
controls matter as much as the successful handoffs.

Limits:

- Rows name server version 1.101.0 at commits `69b7b39` and `91839b6`.
  The `src/` and `bin/` trees are identical between those commits, but the
  harness changed and did not yet record immutable experiment identities.
- The old resume implementation reset order positions after resuming, and
  selected any earlier successful attempt as complete. Repeated row identities
  are resolved here using the latest row in each original file.
- Claude's model field is aggregated model usage, sometimes including Haiku
  alongside Opus; it is not proof that the primary model changed between cells.
- Codex rows record `gpt-6-astra`, but global AGENTS.md rules mentioning KLYPIX
  were present. This is not a clean baseline with no KLYPIX-related instructions.
- These tasks informed development. Small samples and successful delivery
  do not establish superiority to other tools or general safety. Competitors
  were not measured, and overlapping intervals do not prove equivalence.
- The stronger result provenance and resume checks added during PR #88 review
  cannot be retroactively attributed to these historical runs.

Raw file SHA-256 (before any Git line-ending normalization):

```text
claude 55886ccfa4e270d4df6ba1876d6539b7df15de63b1762d94402bbd6005cb3bab
codex  f181a46f02ca4c6f84be17342a6c085110966a54246926c920ef8005d4a69550
```

Reproduce each report with `node bench/coordination/report.mjs <rows.jsonl>`.
No new live model calls were made for this reconciliation.
