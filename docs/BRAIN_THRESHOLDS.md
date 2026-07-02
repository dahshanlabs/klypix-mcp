# Brain thresholds & constants — single reference (v1.17.0)

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

## Correction cue (shared regex)

`CORRECTION_RE = /\bCORRECTIONS?\b|\bOBSOLETE\b|\bstale note (?:is )?resolved\b|\bwas WRONG\b/i`

Used in three places (deliberately the same): capture-side widened supersede,
recall-side overlay (`correctionOverlaysFor`), and `detectContradictions`.

## Session brief tiers (1.17)

- stdout (SessionStart): ultra tier ≤ ~1.8KB — Focus + conflicts + open questions +
  compact self-heal line + pointer.
- `.claude/brain-brief.md`: the FULL brief + every self-heal/health footer + legend,
  rewritten each session start. Messages are stdout-only (delivery acks on read).
- `--full`: everything to stdout (manual runs / stale-lib fallback).
