# Independent differentiation review — 8 November 2026

Status: an experiment selected, no competitive advantage established. This work
is separate from the 1.112.1 repair release. No paid benchmark call had run when
this review and the revised experiment direction were recorded.

The founder asked whether the proposed work was useful differentiation or merely
another plausible AI-generated feature. Three fresh reviewers received the same
product facts and a strong AI-maintained Markdown baseline. They worked without
reading the prototype or one another's proposals. They share a model family;
independent context is not independent model architecture. A separate Claude
critique was also queued through the project brain; it is not counted as a
completed review here.

## What the reviewers concluded

| Perspective | Initial choice | Challenge and resulting judgment |
|---|---|---|
| Customer value | Compatibility checks for complementary agent outputs | A source audit found most proposed evidence/receipt machinery already shipped. The remaining Pact-style integration might save setup effort, but is ordinary integration work with unvalidated demand. |
| Strongest case against KLYPIX | Deliver explicit decision revisions to affected live sessions | Strong notes can already preserve and correct project understanding. Test earlier delivery against notes **plus a cheap change-notification hook**, not just a static document. No demonstrated moat. |
| Technical mechanism | Revision-aware delivery; also considered Git-scoped decisions and portable unfinished-work packages | Revision delivery is the smallest credible experiment. It is an established coherence mechanism and competitors could add it. Adapter coverage and customer retention, not algorithm novelty, would have to create value. |

The compatibility proposal was checked against `src/result-reconcile.mjs`,
`src/release-evidence.mjs`, completion checks and merge-tree integration. Existing
hash-bound evidence must be reused; renaming it would not constitute a new feature.

Current primary competitor documentation raises the bar: [claude-mem](https://github.com/thedotmack/claude-mem)
documents multiple clients and optional TeamBrain; [Concord](https://github.com/Get-Concord-AI/concord-mcp)
documents shared decisions, messages, handoffs and coordination; the maintained
[MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) documents
reservations and Git-backed communication. These are documentation findings,
not measured reliability. TeamBrain availability must be reported separately from
the pinned local claude-mem configuration. GitHub stars do not establish quality.

## Selected experiment

When a decision changes, identify active tasks that were supplied its earlier
revision and show the precise change at their next supported boundary. Measure
whether that saves incorrect implementation work. Supplying a card is not proof
that the model understood or used it; delivery and self-reported adaptation are
also distinct from a verified output.

The initial prototype only checked at `brain_sync`, including completion. That
can be too late to save work, and disciplined notes already allow a completion
re-read. The next bounded slice therefore uses existing optional native hooks for
earlier advisory context. It does not broaden host trust, stop every selected tool,
or establish semantic correctness. Unsupported clients retain the explicitly
documented next-sync boundary.

The implementation is experimental. It must preserve privacy on both sides of a
revision, exact session/task identity, normal scope release and existing permission
checks. No agent launcher, semantic classifier or new transport is proposed.

## Fair comparison and stop rule

Use the same model and tasks for AI-maintained notes, the same notes with a simple
whole-file change notice, released KLYPIX, experimental KLYPIX and pinned
claude-mem. Both KLYPIX builds receive identical host integrations. A model writes
and updates all experimental facts through each product's ordinary workflow; the
harness does not perfect the notes. Native memory remains available in isolated
profiles. Observer processing and setup/debug attempts count against the same $50
ceiling. See [the preregistered protocol](decision-change-benchmark.md).

Measure final defects, stale intermediate implementations, correction-related
rework, unnecessary alerts, total model cost and elapsed time. A notification by
itself is not a successful task. Keep failures and uncertain exposure visible.

The proposed continuation gate is at least a 30% reduction in measured
correction-related rework, without worse final correctness or more than 10% total
model-cost overhead, against the strongest cheap control. This is a product
decision threshold, not a statistical significance claim from a small pilot. If
the simple notes hook matches the outcome and effort, do not market this as a
distinctive technical advantage. Do not retune cases until KLYPIX wins.

Even a successful controlled pilot would leave customer demand unproven. Broader
investment requires external teams encountering the problem repeatedly and
voluntarily retaining the feature. No team adoption, universal superiority,
100× result or untested competitor loss is claimed.
