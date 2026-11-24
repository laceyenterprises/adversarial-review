# REVIEWROWLESS-01

## Summary

A docs-only head whose daemon merge is `not-eligible` has its waiver
withdrawn and enters normal review. A failed required check can prevent merge
while a first review proceeds. Discovery writes an open pending row with its
wait reason and owner when routing must wait, including while an active repair
reservation owns the PR. Only a routed pending row can enter durable refill.
An intent left by an older rowless rescue keeps its dispatch fences and does
not impose a re-review CI prerequisite on a first review.

## Interface changes

The watcher logs `review discovery wait` with the PR number, reason and owner.
An unrouted `reviewed_prs` row has an empty `reviewer` and a wait description in
`failure_message`. Reviewer assignment clears the description.

## Verification

Offline fixtures in `docs-fast-path.test.mjs` and `watcher-claim-loop.test.mjs`
exercise the red-check daemon refusal, waiver withdrawal, first-pass claim and
resumption after repair custody clears.
