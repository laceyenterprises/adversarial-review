# SEV2: Cross-model Claude reviews ignored the personal Claude reserve floor

Date: 2026-10-31
Ticket: REVIEWERFLOOR-01
Status: Code fix prepared; production verification pending deployment.
scars: none — no matching reserve-selection hardening contract was returned by the memory searches; the supplied schema-parity and merge-terminal contracts do not describe this failure.

## Impact

Native cross-model reviews continued consuming personal Anthropic capacity
below the reserve intended to preserve it. Builders stopped at the configured
80% remaining floor while reviewer roles could continue toward the separate
5% pause. This reduced capacity available for protected operational work.
The supplied incident evidence showed substantial personal review usage and
remaining capacity approaching the floor; it does not establish a completed
quota exhaustion or an exact incident start time.

## Cause

The review service launches reviewers natively rather than routing each review
through dispatch admission. The dispatch reserve exemption roster included
reviewers, while native family selection did not compare independent measured
weekly personal capacity with the effective reserve threshold. Provider
availability and pause evidence therefore did not enforce the intended
reviewer floor. Existing account protection alone did not cover that
family-selection decision.

## Resolution

Reviewer selection now reads the same fleet quota projection used by quota
status: the personal Anthropic reserve threshold and measured weekly remaining
capacity. At or below a positive configured floor, personal Claude is excluded
for that attempt. An admitted corporate Claude account remains independent
with account routing enabled. AFH rollback deliberately skips Claude proposals
and conservatively treats Claude as personal, even with a corporate-bearing pool.
Otherwise selection tries Codex through its existing corporate-first account
policy, then enabled and available Gemini. Builder-family refusal still applies:
a Codex-built PR uses Gemini, and holds if no eligible alternative is available.

The fallback log and existing review pass/run metadata carry the reserve reason,
remaining percentage and threshold. Each attempt re-evaluates the evidence,
allowing automatic return to Claude above the floor. Unknown or stale floor
evidence contributes no floor refusal. Existing account-admission holds remain
in force. Hammer, remediation, responder and merge-role reserve exemptions are
unchanged. No shared configuration key or schema changes are needed.

## Validation and follow-up

Synthetic offline regressions cover above-floor, equality, below-floor, stale
and unknown evidence, corporate account independence, pooled personal selection,
effective threshold changes, automatic recovery, family refusal and protected
roles. Existing routing cases remain in the scoped suites. No CI job or gate
was added.

The personal reserve is shared across every `claude-code` pool account because
the producer exposes only one `anthropic-oauth` projection. The reviewer-specific
weekly comparison intentionally overrides dispatch reviewer exemptions; producer
`active`/`paused` flags can instead reflect a shorter window. Public export
fixtures test this distinction and local boundary mutations pin the weekly
`<=` rule; they do not establish parity with a producer reviewer-scoped verdict,
which is not currently exported. An account-specific projection and producer
reviewer verdict remain producer-owner follow-ups.

Floor hold reasons are stable while measured percentages remain structured
metadata and diagnostic text. After 15 minutes of continuous floor holds, a
deduplicated error-level `reviewer-reserve-floor SUSTAINED_HOLD` health signal
names the affected PR. Recovery or a different hold re-arms it; watcher restart
resets this process-local clock. Existing freshness paging owns operator pages.
Inspect reserve capacity and Gemini eligibility when Codex-family reviews stall.

After deployment, SRE must capture an organic review while personal Claude is
at or below the floor. Verify the selected family/account and the
`personal-anthropic-reserve-floor` reason in its review record and watcher log.
For a Codex-built PR, the current family-refusal contract requires Gemini;
a corporate Codex receipt is expected only for a builder it may review.
This change does not claim a live receipt or modify production quota/configuration.
