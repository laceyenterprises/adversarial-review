# CLOSUREOWNEREXPIRY-01

## Summary

Closure can retire an in-place repair epoch or a drained deferred-validation
owner ten minutes after its next-action deadline when the exact launch and
retry family have stopped. Repair retirement preserves publication evidence
and spend. Deferred validation preserves the original cleanup receipt and
bundle, records `owner-expired`, and returns the bundle to ordinary re-drive
admission after verifying that the PR has no retained merge lease.

Expiry falls back to the reservation or confirmed cleanup clock when the
decision deadline is missing or invalid. A launch still recorded as running
can expire with complete terminal worker evidence when each PID is absent or
confirmed dead. The closer forwards its ledger options through the launch and
worker probes.

## Interface changes

Existing custody receipts and status values are unchanged.

## Verification

- `node --test --test-name-pattern=expiry test/closer-next-action.test.mjs test/deferred-source-custody.test.mjs`
  passed all 129 closer-next-action tests and the six deferred-source expiry cases.
- The offline runner passed all 87 repair-dispatch-read and 11 SMV tests.
- Lint passed with zero errors. Contract typechecking, data-model catalog
  validation, and the byte-equivalence walkthrough passed.
