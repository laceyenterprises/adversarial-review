# REVIEWROWLESS-01

## Summary

A settled check failure or definite mergeability refusal on a docs-only head
withdraws the waiver and starts normal review. Pending checks and unknown
mergeability retain the waiver for another poll. Discovery writes an open pending row with its
wait reason and owner when routing must wait, including while an active repair
reservation owns the PR. Unrouted waits keep discovery-first priority. Routed
non-draft pending rows are eligible for reviewer queue reporting and durable refill.
An intent left by an older rowless rescue keeps its dispatch fences and does
not impose a re-review CI prerequisite on a first review.
The watcher reuses the exact-head waiver withdrawal receipt while ordinary
review routing waits, including when an explicit review request arrives.
Discovery uses the original reference and the available live head when the
fetched subject has no reference. Both ordering passes and initial subject
processing share the poll's review-row lookup, including cached misses.

## Interface changes

The watcher logs `review discovery wait` with the PR number, reason and owner
when the wait is first recorded or changes.
An unrouted `reviewed_prs` row has an empty `reviewer` and a wait description in
`failure_message`. Reviewer assignment clears the description.

## Verification

Offline fixtures in `docs-fast-path.test.mjs`, `watcher-claim-loop.test.mjs`,
`review-pipeline-health.test.mjs`, and `review-latency-report.test.mjs` exercise
same-head merge after transient gates settle, waiver withdrawal on red CI,
first-pass claim after repair custody clears, and queue accounting.
The remediation fixtures also cover repeated polls after waiver withdrawal,
new-head reconsideration, wait persistence without a fetched reference, and
production discovery-first and oldest-first re-review ordering.
