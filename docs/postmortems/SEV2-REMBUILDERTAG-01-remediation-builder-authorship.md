# SEV2 — missing builder authorship deferred remediation indefinitely

Ticket: REMBUILDERTAG-01. Date: 2026-11-08. Severity: SEV2, remediation
availability. Status: source correction and synthetic verification; normal
review, deployment and organic recovery observation remain separate.

## Impact and evidence

The supplied incident evidence describes two findings-batch PRs waiting about
30 hours. Every rescue attempt returned `unknown-builder-family` for Codex and
left Gemini unevaluated. The operator escalated the backlog. Two later PRs of
the same shape dispatched normally during the comparison minute. No unsafe
merge is reported. This public report uses neutral descriptions and synthetic
tests; production job records were not accessed or changed.

## Cause and uncertainty

The shared remediation subject predicate rejects code-PR jobs whose persisted
`builderTag` cannot normalize. The job constructor permits a null tag, and the
consumer previously entered selection without recovering recorded authorship.
That refusal became a hold rather than an owned evidence-repair escalation.
Repeated attempts could not create the missing evidence.

Synthetic persisted jobs reproduce both a missing/null tag and an unrecognized
historical value. The supplied evidence does not distinguish those shapes in
the affected production records; attributing either exact shape would require
those records. Corporate Codex and Claude aliases were already recognized in
the investigated baseline. The correction additionally handles bracketed values
and title-tag aliases, with explicit tests across the repository's known builder
vocabulary and published corporate alias contract.

## Correction

Before selecting a remediator, the claim consumer compares recorded PR title,
stable opener identity and explicit body metadata. A single recognized family
permits a durable tag repair with source evidence and a named audit log.
The stable opener lookup ignores the current head because remediation moves
heads after PR creation. Reviewer identity never supplies builder provenance.
Clio and Codex agree as one model family.

Settled conflicting or absent sources stop before dispatch, recording the job/PR,
evidence, operator owner and escalation/retrigger action in the job and output.
These stops permit explicit operator retrigger after evidence correction.
Unavailable PR or transient opener reads instead requeue for 60 seconds with
a pre-spawn round refund; PR reads retry transient failures twice within 15 seconds.
Existing noncanonical tags are persisted with job-tag recovery evidence.
Recovered jobs reject same-family remediators, including pinned or pooled
proposals. The change retains normal review, CI and merge predicates, and adds
no check, label, override, runner or live operation.

## Verification and recovery

The dedicated offline suite exercises real persistence and routing, a bounded
synthetic PR metadata transport, head-independent opener lookup, missing and
unknown tags, body evidence, conflicts, unavailable sources, normalization, and
the claim consumer's durable stopped outcome without dispatch.
The repository change note records commands and final results.

After ordinary deployment, the runtime owner can observe the next naturally
claimed legacy job emit `builder-tag-derived` and select a different-family
remediator. An unresolved job must instead name its evidence-repair owner and
action. Existing stopped jobs require the documented explicit operator
retrigger after evidence correction. No production rescue, restart or state
mutation was performed for this ticket.
