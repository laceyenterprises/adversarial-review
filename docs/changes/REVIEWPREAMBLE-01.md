# REVIEWPREAMBLE-01

## Summary

Accept brief progress prose before a complete reviewer reply. Keep completed
chunks when one chunk needs a single retry. See the
[SEV2 report](../postmortems/SEV2-REVIEWPREAMBLE-01-chunked-review-lost-on-preamble.md).

## Interface changes

The reviewer logs `droppedPreambleBytes` when it removes a preamble. Each
rejected chunk attempt gets its own forensic dump. The watcher still handles
validation failures that reach it under the existing reviewer-output policy.

## Verification

- `npm test -- test/review-reply-validation.test.mjs test/reviewer-verdict-recovery.test.mjs test/reviewer-chunk-timeout.test.mjs`
  passed all 71 tests under NetGuard.
- `npm run lint` passed with zero errors and 149 warnings.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable
  transcript deliveries.
