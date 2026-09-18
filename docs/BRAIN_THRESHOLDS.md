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
| `UPDATE_MIN_WORDS` | 6 (and ≥ half the card's) | `klypix-format.mjs` `isThinUpdate` | **new 1.86.1** — a ~ that would REPLACE its card needs ≥6 distinct content words (tokenSet: 4+ letters) OR at least half the card's own. A thinner one is APPENDED to the matched card as a dated `(~ amended <date>: …)` line (`stats.updateAmended`), never a separate card; it is a no-op when the card already says it word for word (`cardAlreadySays`, `stats.updateUnchanged` — a re-harvest, or a stub whose full correction already landed). The same floor guards the ❓ merge (`QUESTION_MERGE_AT`). Terse confirmations (append) and guard amendments are exempt |
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

## Marker suffix grammar (1.86.1)

`parseMarkerSuffixText` — one block, byte-identical in `global-brain-hook.mjs` (marker
capture) and `klypix-format.mjs` (`parseVerifySuffix`, the prose fallback for `verify`);
`test/marker-suffix-grammar.mjs` fails if the copies drift.

- Keys: `closes:` `ev:` `verify:` `q:` — lowercase only, whitespace before the key AND after
  the colon. `Q:`, `FAQ:`, `q:auth`, `npm run verify:mcp` are text. Two exceptions with no
  space after the colon: `closes:[[X]]` and `ev:src/a.ts`; `Closes:` counts before a
  `[[wikilink]]`.
- One run of suffixes that reaches the end of the line. The run may not start right after a
  word that leaves the clause open: an article / determiner / conjunction / auxiliary / subject
  pronoun / adverb like "always" (`the ev:`, `a q:`, `we verify:`, `Always verify:`), or a word
  ending in `:` (`Rule: verify:`). A single capital letter and "May" do not count ("option A
  closes:"). Particles and copulas (`on`, `in`, `as`, `is` …) block every run except one that
  opens with a well-formed `ev:`.
- Value shapes: `ev:` every item (`,` or `،`) is a PR shorthand or ≤4 words with a path, digit
  or `.ext` and no prose word; `verify:` starts with a known CLI, a PowerShell Verb-Noun, a
  path/script, a hyphenated probe name, or is a tool given a `--flag`, and carries no prose
  connective (`the`, `before`, `matches` …) outside quotes; `q:` starts with a question word
  or a preposition + which/what (English or Arabic, direction and vowel marks ignored) and ends
  with `?` / `؟`; `closes:` any text. A repeated `ev:` joins its references; a dangling key at
  the end is dropped.
- A run whose FIRST segment breaks a rule is not a suffix run; the next key position is tried,
  and with none left the whole line is the body. Once a well-formed `ev:` / `verify:` / `q:`
  (or a `closes:` that is exactly one `[[wikilink]]`) proves the run, a later malformed segment
  goes back into the body (`kept` → ledger `suffix-kept-as-text` + a receipt the next prompt
  shows the model) and the well-formed ones still count.
- `closesAnchored` is judged only by what comes BEFORE the `closes:` or by its own value: it
  follows a clause boundary (`. ! ? ; ) ] ✓ …`), follows another well-formed suffix, or is
  exactly one `[[wikilink]]`. A well-formed `ev:` AFTER a prose `closes:` anchors nothing.
- On `✓` and `~` a `closes:` segment is plain text (they close nothing).
- `closes:` is free text, so capture carries the card as written WITH the segment
  (`closesFallbackText`). Before merge/supersede run, the close is decided once: 1–4 cards → it
  acts; none → the written text lands (`stats.closesKept`); > 4 → the written text lands
  (`stats.closeRefused`) — either way `closes` is dropped so nothing acts on it later. An
  UNanchored `closes:` is `strict` in `closeTierFor`: it acts only on the cards it NAMES
  (exact / prefix / contains title) — never on one that merely carries every word of the target,
  so the `cov === 1` twin guard applies to anchored closes only. A target that names no live
  card by title but names an already-closed one (Archive, ✅, ↩) returns an empty tier
  (`alreadyClosed` → `stats.closesKept`) instead of falling through to word coverage. Every
  archived card is named in `stats.closedCards`, and the receipts never hide a remainder.
- Stop re-reads the whole transcript: additive markers are deduped by text (plus the keys the
  PUBLISHED 1.86.0 / 1.85 cut rules wrote — a 1.86.0 stub is restored in place by the engine's
  STUB REPAIR, `stats.repaired`); a `~` / `✓` line is deduped by transcript event + line
  (`skipped-applied`), so a self-heal re-stamp in a new turn still applies.
- A thin `~` amendment keeps the card's `createdAt`, border colour, `createdVia` and `verify`
  (an explicit `verify: ""` is persisted as a clear); its evidence goes first under the 16-ref
  cap (`evidenceDropped` reported). `cardAlreadySays` matches the body as a pattern that
  tolerates both wrap breaks (a space → line break, an over-long token split mid-word).
  Previews (ultra brief, prompt recall) lead with the newest amendment (`amendmentFirst`).
- `parseVerifySuffix` reads the LOGICAL line: it rejoins wrapText's soft breaks (the next
  line's first word would not have fitted) and a line that starts with a suffix key, so a
  hard-wrapped card never yields half a sentence as a command, and an own-line `verify:` is
  read. A probe stops at a joined line that opens with a plain Titlecase word when the shorter
  reading is itself a probe (a typed break); a joined reading rejected as prose stays rejected.
  A card with no `verify:` at all returns on the fast path. `brain_note`'s clear-verify check
  calls this same reader (`deriveVerify`).

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

## Release-cut reconcile (1.85)

- `commitsInRange`: 500 commits, 4 s, `--no-merges`; a capped scan reports `capped`
  rather than reading as a complete one.
- Containment probes: ≤ 64 unique shas per run, cached per sha, and **false past the
  budget** — a capped probe must never read as proof that work shipped.
- Candidate cap 40 (`RELEASE_RECONCILE_MAX`), `truncated` reported.
- `confirmable`: true for a contained `#commit-`/commit-evidence receipt on the card
  itself, for a hint edge whose milestone carries a contained receipt, and for
  coverage at **cov ≥ 0.6 from a commit whose body is ≥ 12 chars** (the same bar
  `commitToCard` uses). Anchor-grade and body-less commits are listed but never
  confirmable. With `ref` being the branch under cut, containment is true by
  construction for every commit in the range, so it is not evidence on its own.
- The advisory is attached only on a NEW lease or a CHANGED ref; zero candidates
  leaves the key absent entirely. It never rides a lease that was not GRANTED (a
  refused one carries no `reconcile` key and prints no notice).
- No `<ref>~50` baseline guess. A repo with no release-shaped tag and fewer than
  50 commits — the FIRST release of anything — made `git log <ref>~50..<ref>`
  exit non-zero and was told its history "could not be read". An empty baseline
  is passed instead, and `commitsInRange` walks the ref's own tip window under
  the same 500-commit / 4 s cap.
- **Measured cost** (2026-09-16, the real 2,693-card KLYPIX brain, full
  500-commit range, Windows): `collectRepoState` 1,128 ms · `commitsInRange`
  938 ms · `parseKlypix` 434 ms · `releaseFulfilledOpens` 1,255 ms (16
  candidates, 1 containment probe) — **≈3.8 s end to end**, once per lease/ref.
  The variable term is the containment probe: 2 git spawns per unique sha, so a
  run that spends its full 64-sha budget adds several seconds more. That is the
  ceiling the budget exists to bound, and every failure degrades to `{ skipped }`
  rather than slowing or failing the sync.
- `brain_reconcile` confirm: the partial-clause rule is unchanged — a strict subset of
  a multi-item clause writes `✔ partial` and the card stays live unless `whole:true`.
  Refusals are per entry (`unknown-id` · `not-open` · `no-card-evidence` ·
  `not-in-ref` · `not-a-candidate`), and an all-refused call writes nothing.
