# DIRTYHOLDERSALVAGE-01 — Report validation custody before promising a retry

## Summary

The hammer records `canonical-validation-operator-decision` immediately for
dirty or unreadable custody and for a retained process-inspection no-verdict.
When reconciling an ended launch, the watcher uses the closure sweep's custody
predicate and appends an operator continuation if the latest matching audit
has yet to record one. A clean, published source with confirmed cleanup
retains watcher-owned same-head backoff and fresh-lease admission.

## Interface changes

The append-only audit can add an operator continuation for the same launch
after its initial deferral. The audit schema and merge gates are unchanged.

## Verification

`node test/run-tests.mjs test/inconclusiveretry-01b.test.mjs test/ama-audit.test.mjs test/deferred-source-custody.test.mjs test/smv.test.mjs`
passed all 76 tests. `npm run lint`, `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh` and
`node scripts/validate-data-model-catalog.mjs` passed.
