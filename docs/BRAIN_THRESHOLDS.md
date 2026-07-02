# Brain thresholds & constants — single reference (v1.18.0)

## Cluster layout (v1.18, `tidyBrain`)

| Constant | Value | What it does |
|---|---|---|
| masonry columns | 1–5, target aspect ~1.15 | cards flow chronologically into the shortest column; areas become squarish tiles |
| placement | incremental, anchored | containers reclaim their previous spot verbatim when nothing grew into it — a capture moves only areas whose size changed (field: a wikilink capture moves ZERO containers) |
| full cluster pass | migration only | triggers: no `settings.brainLayout === 'cluster-v1'` stamp AND no >400px-wide container, or a degenerate >4:1 map; orders hubs first by connectivity, Focus at the anchor, Archive on the rim |
| nested containers | flattened to root | a hand-nested area is promoted (keeps its absolute spot); containers are never masonry kids |
| tiebreaks | code-unit compare | bare `localeCompare` collated per machine locale → cross-machine layout divergence |


The scoring/matching constants live across two files; this table is the coherence
contract (from the 2026-07-02 field report, updated for the v1.17.0 knowledge-quality
release). If you change one, update this table and the snapshot-parity fixtures.

| Constant | Value | Where | What it gates |
|---|---|---|---|
| `SUPERSEDE_AT` | 0.6 | `klypix-format.mjs` `captureIntoBrain` | plain same-area decision supersede |
| `CORRECTION_SUPERSEDE_AT` | 0.4 | `klypix-format.mjs` (exported) | **new 1.17** — correction-cue supersede, ALL areas; also the recall-side overlay bar (`correctionOverlaysFor`) |
| cue absolute-mass clause | ≥10 shared @ ≥0.25 coef | `klypix-format.mjs` `cueMatch` / `detectContradictions` | **new 1.17** — cue-gated matches also fire on absolute subject mass: long real-world cards measure ~0.31-0.33 coefficient with 16-17 shared subject tokens (the field pair), under every pure-ratio bar. Cue-gated ONLY — plain supersede + polarity pairs keep strict ratios |
| `QUESTION_MERGE_AT` | 0.6 | `klypix-format.mjs` `captureIntoBrain` | **new 1.17** — rephrased duplicate ❓ merges into the existing open question |
| `RESOLVE_AT` | 0.3 | `klypix-format.mjs` `captureIntoBrain` | ✓ resolve floor; 1.17 resolves the best match **± 0.1 near-ties** (cap 3), not just the first |
| `CLOSE_COVER_AT` | 0.6 | `klypix-format.mjs` `captureIntoBrain` | `closes:` coverage; 1.17 resolves **ALL** matches ≥ bar (cap 4), was first-match-and-break |
| `UPDATE_AT` | 0.45 | `klypix-format.mjs` `captureIntoBrain` | ~ update in-place match |
| recall `topK=5 / minScore=3` | — | `global-brain-hook.mjs` `promptRetrieve` | per-prompt task-matched recall |
| body-score length norm | `min(1, 6/log2(bodyWords+1))` | `klypix-format.mjs` `scoreCardsAgainstQuery` | **new 1.17** — body hits scale down for cards over ~64 distinct words; title/tag hits untouched |
| repeat `topK=2 / minScore=5 / minTokens=2` | — | `klypix-format.mjs` `detectRepeatWork` | repeat-work nudge floors |
| `REPEAT_VERB_STOP` | ~45 verbs | `klypix-format.mjs` | **new 1.17** — generic work-verbs (deploy/ship/merge/release/build/…) excluded from repeat scoring |
| `#auto` entity gate | ≥1 entity token | `klypix-format.mjs` `detectRepeatWork` | **new 1.17** — auto-harvested ship cards need a digit / kebab / tag-stem match to nudge |
| `BUDGET_CHARS` | 13,500 | `klypix-format.mjs` `structToBrief` | full brief budget — now written to `.claude/brain-brief.md`, not stdout |
| `ULTRA_BUDGET_CHARS` | 1,800 | `klypix-format.mjs` `structToUltraBrief` | **new 1.17** — SessionStart stdout tier, sized for the harness's ~2KB persisted-output preview |
| contradiction `minOverlap=0.45 / topK=12` | — | `klypix-format.mjs` `detectContradictions` | **new 1.17** — `brain_reconcile` contradictions pass |
| `GARDEN_MIN_AGE_DAYS` / `GARDEN_AUTO_MIN_AGE_DAYS` | 14 / 7 | `klypix-format.mjs` | garden dormancy age; **1.17**: `#auto` ship cards age out at 7d |
| garden `KEEP_NEWEST=8 / MIN_CANDIDATES=3 / MAX_DEGREE=1` | — | `klypix-format.mjs` | garden selection (unchanged) |

## Correction cue (shared)

`hasCorrectionCue(text)` = `/\bCORRECTIONS?\b|\bOBSOLETE\b|\bwas WRONG\b/` (**case-sensitive**
— the uppercase form is the deliberate signal; casual prose like "the calc was wrong" or
"remove obsolete helper" must never archive a card) OR `/\bstale note (?:is )?resolved\b/i`
(the one natural-language phrase, any case).

Used in three places (deliberately the same): capture-side widened supersede,
recall-side overlay (`correctionOverlaysFor`), and `detectContradictions`.

## Adversarial-review hardening (post-implementation, 21 confirmed findings)

- `cueMatch` floor is **3** tokens per side (overlapScore keeps 4) — terse deliberate
  corrections keep ~3 subject tokens after `stripCueMeta`; ≤2-token corrections land as a
  new card (use `~` instead).
- `closes:` guards: 🛠 skills are excluded (mirroring supersede); the title-CONTAINS
  fast-path needs a ≥10-char target (exact/prefix stay ≥6); **>4 matches collapses to the
  single best** (a too-generic target must not sweep).
- ✓ resolutions also exclude 🛠 skills.
- `proposeStructuralConnections` excludes the `auto` tag (provenance, not topic).
- Polarity matching is **word-boundary** (`\bdead\b` — 'deadline' no longer carries the
  pole; blocked↔unblocked can actually fire). A pair with any **deliberate** edge
  (label ≠ 'auto') dismisses a POLARITY candidate; a CUE candidate clears only via
  supersede/close/conflicts_with.
- Recall render: the stale-hit demotion is unconditional (even when the corrector already
  rendered as its own hit); corrector full-text respects the per-session injected-set;
  repeat-nudges warn when the nudged card has a live correction.
- Ultra brief: budgeted sections emit "…and N more" elisions (Focus's is never silent);
  all cuts are surrogate-safe; 📨 messages print directly after the brief (delivered-once
  semantics must sit in the visible window).

## Session brief tiers (1.17)

- stdout (SessionStart): ultra tier ≤ ~1.8KB — Focus + conflicts + open questions +
  compact self-heal line + pointer.
- `.claude/brain-brief.md`: the FULL brief + every self-heal/health footer + legend,
  rewritten each session start. Messages are stdout-only (delivery acks on read).
- `--full`: everything to stdout (manual runs / stale-lib fallback).
