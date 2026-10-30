# Crowd safeguards

When many sessions share one project record, they can fail the way groups do:
a note gets repeated until it looks agreed, later sessions copy earlier ones
instead of checking, and an objection is outvoted without being answered.
These three small mechanisms come from research on that failure. They are
applied here to a shared project record across separate sessions and tools.
That application is new and only lightly measured (see the bench report in the
pull request that added this).

| Mechanism | Research it comes from |
|---|---|
| Evidence lineage | Information cascades: Bikhchandani, Hirshleifer and Welch, 1992 |
| Independent first pass | Lorenz et al., PNAS 2011; BenchForm (Weng et al., ICLR 2025) |
| Preserved dissent | Nemeth et al., 2001; CONSENSAGENT (Pitre et al., ACL Findings 2025) |

Debate-or-Vote (Choi, Zhu and Li, NeurIPS 2025) is the caution: more
discussion between agents is not automatically better than independent votes.

Everything is stored as visible card text, so older brains, older klypix-mcp
versions, the KLYPIX app and git merges carry it unchanged. No new card
fields.

## 1. Evidence lineage

A brain card can say where its claim came from and whether it was checked.
With `brain_note`, end the text with any of these lines:

```
source: lib/flags.js at 3f2a9c1
restates: Flags decision of 2 Oct
rechecked: read lib/flags.js at HEAD; DEFAULTS is the only source
```

They are stored as `↳ source:`, `↳ restates:` and `✔ re-checked <date>:`.
File evidence passed with `evidence` counts as a source too.

`brain_ask` answers and the `brain_sync` task context then show one line per
claim that several cards state:

> 🧬 Lineage: "config/flags.json is loaded at startup…" — 1 recorded source
> (file lib/flags.js) — that source is now: changed; stated by 4 cards: 1
> original + 3 restatements with no source of their own; re-checked against
> code/evidence 0×. Repetition is not corroboration…

Cards that never declared `restates:` are still grouped when they make the
same claim: they name the same files or identifiers and share a good part of
their words. A card that declares a change ("instead", "no longer", a
correction) starts a new claim. This grouping is a heuristic. It can miss a
restatement worded very differently, and it can group two cards that name
the same file but say different things.

## 2. Independent first pass (opt-in)

For a review or a decision several sessions weigh in on:

1. `brain_review {action:"start", topic:"…"}` — from now on, for this session,
   `brain_sync` and `brain_ask` leave out other sessions' **assessments**
   (`🔎 ASSESSMENT` cards) and **objections** on that topic. Facts, decisions
   and evidence stay visible.
2. Form your view from the code and evidence.
3. `brain_review {action:"submit", assessment:"…"}` — records it as a
   `🔎 ASSESSMENT` card and shows you the withheld peer opinions.

**Limit:** KLYPIX controls only what KLYPIX returns. It cannot stop an agent
from opening the brain file, notes, git history or other sessions directly.
This records an independent first pass; it does not enforce one. Two
sessions' assessments on one topic never supersede each other.

## 3. Preserved dissent

Start a `brain_note` text with `OBJECTION:` and it is stored as
`⚖️ OBJECTION:`. Until it is answered it:

- appears in `brain_sync` and `brain_ask` for any task or question on its
  topic, with a count of later cards that touch the same thing without
  answering it;
- is never superseded by a later decision, however similar, and never closed
  by a fuzzy `✓` that only shares its words.

It closes when someone records a decision or milestone that links it
(`closes: <its title>`), ideally with evidence, or resolves it by id. A later
majority does not close it.
