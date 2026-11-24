# REPAIRFENCE-01

## Summary

An operator PR update can replace an `absent-unfenced` repair reservation when
the automatic remediation round budget is exhausted and a fresh canonical
lookup confirms absence. The predecessor's terminal audit and the successor
reservation are written together, preserving spend and refund history.

## Interface changes

The local companion accepts dispatch request provenance from the Agent OS
caller. A successful replacement returns `supersedesEpochId` and the exact
`baseHead` for the successor's force-with-lease publication.

## Verification

The offline reservation fixtures reproduce the old `repair-owned` result and
exercise exhausted and available budgets, current and newly live owners,
dispatch transport failure, automatic callers, moved heads and history
preservation.

`node --test --test-concurrency=2 test/repairdispatchread-01.test.mjs
test/inplacerepair-01.test.mjs test/repairownerscope-01.test.mjs
test/repairownerscope-02.test.mjs test/repair-follow-up-claim.test.mjs` passed
166 tests. Lint reported zero errors. Contract typechecking and the offline
research finding walkthrough passed.
