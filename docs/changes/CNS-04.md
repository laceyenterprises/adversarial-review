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

Remediation retains underscore-bearing operator-hold launch statuses verbatim
and registers the store in the validated data-model catalog. The reader contract
joins on globally unique launch IDs regardless of repository spelling, selects
the latest terminal status, and requires separate live-retry evidence for
current-terminal counts; historical observations alone cannot prove liveness.

Final comment-only remediation keeps reconciliation writes at the scanned
dispatch path, including legacy filename/identity mismatches. Offline fixtures
check one terminal observation, no repeated reconciliation, and identical
return values, cleanup and event logs when the journal is unavailable. The
existing dispatch equivalence test now names its actual coverage.
The reader contract excludes incidental pre-deployment predecessor rows using
an externally supplied deployment cutover and names `handed-to-review` as a
known no-terminal-lease-row case. Catalog registrations share the description.
The journal schema and closer lifecycle/smoke promises are unchanged.

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

Remediation validation: bounded `node --test test/closer-outcomes.test.mjs`
passed all 8 tests, including both operator-hold status round trips.
`node scripts/validate-data-model-catalog.mjs` validated 92 entries.
`npm run lint` passed with 0 errors (152 existing warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`
and `git diff --check` passed. The full suite remains delegated to PR-head CI.

Final-round bounded validation passed the outcome/reconciliation fixtures,
all 161 watcher claim-loop tests, and all 11 SMV tests (including source
projection and disposable Git smoke). The initial 120-second watcher bound
expired without an assertion failure; its targeted rerun completed in 178
seconds under a 360-second bound. Lint passed with 0 errors and the same 152
warnings; contract typecheck, offline walkthrough, 92-entry catalog validation,
exact catalog-fragment comparison, changed-source CDM audit, and
`git diff --check` passed. No full local suite was run.
