# DOGH16REVIEWROWS-01

## Summary

The Sentinel DOG-H16 selector can bound `review_rows` below the reader's
101-page x 100-row ceiling; the agent-os side renders the cutoff and validates
the key. The agent-os change must not be installed before this lands and floats.

## Interface changes

`readReviewObservations` accepts an optional `since` for `kind: 'reviews'`, keeping
rows whose `reviewed_at` is at or after it (`julianday` comparison, so Z and offset
timestamps both work). Before, `since` was valid only for `passes` (on `started_at`)
and `reviews` rejected it. `ended_since` remains pass-only, and an absent `reviewed_at`
column reports `review time schema unavailable`. Omitting `since` keeps the unbounded read.

## Verification

`node --test test/review-observations.test.mjs` passes, covering bounded review
reads, offset timestamps, invalid selectors, and explicit rejection of a
`reviews` cutoff when the store lacks `reviewed_at`.
