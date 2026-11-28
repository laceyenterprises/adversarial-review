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

The watcher uses the selected decision's `evidenceRefs` and deadline for a
deferred-source refusal. The current selector projects this refusal as
`R05-structural`. The watcher can also reconcile `R02-hold` when the decision
identifies the deferred-source refusal. Explicit operator holds retain custody.
Expiry uses launch status for launch records and `process_status` for worker-run
evidence.

Final comment-only remediation tolerates synthesized closure decisions without
`evidenceRefs`. Expiry skips a hold removed before its locked reload without
recreating the hold or modifying retained source and cleanup evidence. Other
reload failures still propagate.

This ticket tracks the expiry lifecycle for repair epochs and deferred source.
Deferred source reuses its existing cleanup receipt, custody lock and re-drive
admission. Pre-receipt intent reconciliation owns a dispatch submission and
lease. Live closer handoff escalates a running controller for operator review.
Deferred-source expiry settles a retained bundle after its controller stops.

## Interface changes

Existing custody receipts and status values are unchanged.

## Verification

- `node --test --test-name-pattern=expiry test/closer-next-action.test.mjs test/deferred-source-custody.test.mjs`
  passed all 129 closer-next-action tests and the six deferred-source expiry cases.
- The offline runner passed all 87 repair-dispatch-read and 11 SMV tests.
- Lint passed with zero errors. Contract typechecking, data-model catalog
  validation, and the byte-equivalence walkthrough passed.
- Follow-up validation passed all 427 tests from `closer-next-action`,
  `pr-next-action`, and `smv` with the offline runner.
- Final comment-only validation: `node test/run-tests.mjs test/closer-next-action.test.mjs`
  passed 131 tests. With `NODE_OPTIONS='--test-name-pattern=\.test\.mjs$|deferred.source.expiry'`,
  `node test/run-tests.mjs test/deferred-source-custody.test.mjs` passed nine expiry
  tests, including removed, replaced and corrupt hold reloads.
- The watcher claim-loop file exceeded 50- and 110-second local bounds without
  reported failures; its scoped `single.claim|CAS|duplicate|claim.loop` selection
  passed 14 tests. PR-head CI owns the complete suite.
