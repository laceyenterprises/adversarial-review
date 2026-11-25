# ROUNDBUDGETDEFER-01

## Summary

Charge the PR review cycle for closer rounds that publish a distinct head or
reach a substantive outcome. Existing paced retry owns unpublished
infrastructure stops. Recompute older charges on the next pass and preserve
operator holds. [SEV1 report](../postmortems/SEV1-ROUNDBUDGETDEFER-01-unpublished-closer-rounds-exhausted-review-budget.md)

## Interface changes

Version 1 closer outcome records accept optional `publishedHeadSha`,
`publishedAt`, and `substantiveRefusal` evidence. The round ledger uses retained
launch progress and audits for earlier records.

## Verification

The synthetic reproduction observed two rounds used and `reviewCycleExhausted`
before the fix. The regression cases cover two unpublished deferrals, mixed and
two-published histories, operator custody, substantive refusals, paced retries,
and an existing automatic budget handoff. The watcher claim-loop suite passed
208 tests.

- `node --test test/pr-round-ledger.test.mjs` passed 18 tests.
- `node --test test/closer-next-action.test.mjs` passed 114 tests.
- `node --test test/inconclusiveretry-01b.test.mjs` passed 29 tests.
- `node --test test/inplacerepair-01.test.mjs` passed 71 tests.
- `node --test test/hamciauth-01.test.mjs` passed 16 tests.
- `node --test test/smv.test.mjs` passed 11 tests.
- `npm run lint` reported zero errors. Contract typecheck and the
  research-finding byte-equivalence demo passed.

The operator plan records the passive deployment acceptance check. Runtime
verification is pending rollout.
