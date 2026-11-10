# NEXTACTIONSTALE-01

## Summary

Restore certainly budget-suppressed queued reviews to the shared closure path
before retry scheduling. Re-evaluate completed final-push waits every pass from
current evidence, with one budget-handoff log per head.

## Interface changes

The existing review row records `system-budget-exhausted-closure`; no schema,
budget or merge predicate changes. The read-only rescue gate exports
`budgetExhaustedClosureEvidence` so companion rescue routing uses watcher policy.
Read-only callers supply their own database handle; importing the policy opens
no writable database.

## Verification

Each test file ran separately under netguard with a 600-second bound:

- `node --test test/budget-exhausted-closure.test.mjs`: 10 passed.
- `node --test test/watcher-claim-loop.test.mjs`: 168 passed.
- `node --test test/adversarial-gate-status.test.mjs`: 102 passed.
- `node --test test/hamclose-replay.test.mjs`: 20 passed.
- `node --test test/closer-next-action.test.mjs`: 97 passed.
- `node --test test/watcher-review-dedup-ceiling.test.mjs`: 14 passed.
- `node --test test/watcher-auto-refresh-stale-posted-review.test.mjs`: 47 passed.

`npm run lint` passed with zero errors (existing warnings);
`npm run typecheck:contracts` passed. Changed sources passed scoped ESLint.
Operator plan parsing, report links and catalog JSON validated offline.
The full test suite was not run, per ticket constraints.
The committed operator-only post-merge plan declares deployment and natural
traffic verification; this change makes no live service changes.
