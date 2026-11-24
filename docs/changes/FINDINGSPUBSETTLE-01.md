# FINDINGSPUBSETTLE-01

## Summary

The findings collector waits for terminal preparation and retries incomplete
`outcomes.json` reads. Workers receive explicit temp-and-rename instructions.
All-drop batches settle locally. Applied batches use the PR number from
`outcomes.json` against the batch repository. A marked PR found by branch
prevents duplicate publication while the collector waits for that artifact.
GitHub read failures that exhaust the transport's retries leave the batch
pending for the next collection pass.

## Interface changes

Invalid JSON after the bounded rereads records `batch-outcome-invalid-json`.
An explicit missing-PR response for the artifact's numbered PR records
`batch-pr-not-found`. Already-fixed drop citations remain in the outcome
reason and do not initiate a lookup. The store schema is unchanged.

## Verification

The synthetic replays reproduce the partial-read and foreign drop-citation
errors on the original collector. The focused batch suites exercise terminal
status, retries, literal PR ownership, drop-only settlement and malformed JSON.
All 288 tests in the seven affected suites passed, along with `npm run lint`
and `npm run typecheck:contracts`.
