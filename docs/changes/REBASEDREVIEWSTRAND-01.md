# REBASEDREVIEWSTRAND-01

## Summary

The watcher supersedes parked ownership and deadline state when it observes a new actionable head. Durable re-review refill sends the freshly observed head through ordinary review discovery and replaces an older queued candidate for the same PR. Queue and custody supersession are recorded with both heads.

## Interface changes

`review-wait-decision` reports filtered pending re-reviews even when the wait age is unavailable. `review-head-superseded` records old and current heads for queue and parked ownership transitions.

## Verification

Scoped `node --test --test-concurrency=2` runs passed for durable refill, dispatch, admission, the GitHub subject adapter, owner deadlines, closure recovery, and exact-head dispatch leases. The watcher claim-loop file passed all 195 tests. ESLint passed for the changed source files.
