# Brain reliability validation

This work strengthens shared project continuity: what the next human or agent receives, where a decision came from, and which outcomes still need capture. It does not establish general AI memory or guaranteed agent compliance.

## Behavior under test

- Current context qualifies superseded standing rules and suspected obsolete rules. Explicit correction links differ from unconfirmed repair candidates. Protected rules and their history remain inspectable; retrieval does not rewrite the brain.
- Evidence metadata travels through MCP, CLI, A2A and hook capture. Local fingerprints describe captured working-tree bytes; repository HEAD is separate. Source changes, missing files and unavailable checks remain distinct. Verification instructions are stored as data and are never executed by recall.
- Source inspection shares a bounded response budget. Optional evidence text follows priority task facts, with complete structured metadata available to the receiving host.
- Outcome receipts track what a note actually covered. An early note cannot suppress later undocumented commits; old transcript markers cannot suppress newly observed outcomes. Discussion-only decisions still require deliberate capture.

## Focused checks

Run these in a development checkout with its locked dependencies:

    node test/current-guidance.mjs
    node test/brain-evidence.mjs
    node test/evidence-anchors.mjs
    node test/capture-gap.mjs
    node test/ship-capture.mjs
    node test/context-gateway.mjs
    node test/a2a-smoke.mjs
    node test/eval-retrieval.mjs

The package test command also includes these regressions. Isolate TEMP/TMP outside all Git repositories when running concurrent suites: some fixtures deliberately test behavior outside a repository. A cleanup failure after a child transport exits is still a failed test process and must be reported separately from assertion outcomes.

## Frozen retrieval comparisons

Copy the brain and authored question set once to private local artifacts. Do not commit project-memory snapshots or private question text to a public repository. Use the SAME evaluator script, input paths and effective enrichment for both engine checkouts:

    node scripts/eval-retrieval.mjs --brain /private/brain.snapshot.klypix --questions /private/questions.snapshot.json --engine /checkouts/baseline --mode semantic --out /private/baseline.json
    node scripts/eval-retrieval.mjs --brain /private/brain.snapshot.klypix --questions /private/questions.snapshot.json --engine /checkouts/candidate --mode semantic --out /private/candidate.json

Repeat with mode lexical. Outputs must be new files. The receipt pins brain/question bytes, engine source, embedding configuration, and raw/effective enrichment hashes including absence. A mid-run input change rejects the report. Compare both enrichment hashes; timestamps alone are not input equivalence. Semantic mode fails if its actual runtime is unavailable, rather than silently reporting lexical fallback as semantic retrieval.

Missing or text-drifted pinned golds are explicitly reported and excluded only when no valid gold remains. Keep the excluded count beside the answerable denominator. Unknown-answer labels need human review as the corpus evolves; a nonempty retrieval result does not by itself mean the model hallucinated. These receipts measure retrieval ranks, not LLM answer accuracy or task completion.

## Handoff and release boundaries

Deterministic restart tests prove what context is delivered. A few fresh-agent smoke cases can reveal whether that context is usable, but cannot establish a general success rate, superiority over curated Markdown, or cross-model reliability. Broader claims require a frozen, independently reviewed task set and repeated runs with the same budgets and source facts.

Desktop inspection belongs in the existing Who wrote it lens. Validate save/reopen preservation, inert rendering, oversized/malformed metadata and English/Arabic labels; complete an interactive visual review before announcing it as released. Generate the bundled runtime from the canonical core with scripts/sync-bundled-mcp.mjs, include brain-evidence.mjs in every runtime copy list, and run the strict parity gate against the explicitly selected checkout. A deliberate prerelease bundle uses KLYPIX_MCP_ALLOW_UNTAGGED=1; this does not make the checkout a release.
