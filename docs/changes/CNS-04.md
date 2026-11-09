# CNS-04: durable closer outcome observations

## Summary

Preserve terminal closer launch evidence across same-head retries. Dispatch
projections can be replaced and some terminal launches never write an AMA
audit, so those stores alone cannot supply a complete historical denominator.

## Interface changes

The append-only [outcome journal](../data-model/ama-closer-outcomes.md) separates
terminal launch evidence from authoritative lease outcomes. Consumers join by
launch identity; process success never proves a merge. Closure, strict review,
dispatch, cleanup, and paging policies remain unchanged.

This is the upstream prerequisite for pipeline observers. Downstream work
remains incomplete until this change merges, the normal submodule float
advances the consumer, and fixtures validate that merged version.
This PR does not ship downstream observers or config thresholds.

## Verification

Synthetic offline fixtures cover both terminal evidence kinds, same-head
replacement, exclusion of provisional/parked/unlaunched observations, field
filtering, and dispatch/cleanup equivalence when journal writes fail.
`node --test test/closer-outcomes.test.mjs`, run through the bounded worker
validator with network guards: 7 passed. ESLint on the changed source and test
files: clean. The changed-file CI mirror: CDM re-derivation guard and contract
typecheck passed; the full suite was deferred by the fast tier.
