# FINDINGSBATCHADOPT-01 — Recover findings-batch dispatch receipts by key

## Summary

If dispatch fails or times out, the collector reads the scoped launch ledger.
It adopts a matching preparation launch and resumes normal collection. A
matching publication launch fences another publication. A readable empty
probe preserves the existing error behavior, and an unreadable probe leaves
custody unresolved for a later pass.

Preparation and publication use distinct idempotency keys because they carry
different prompts and completion shapes. Collection and release still recognize
legacy publishers and respect existing publication intents and retry budgets.

Preparation recovery defers only the affected batch when its probe is
unreadable. A three-batch fixture covers the warning and retained custody,
followed by another batch's dispatch and a third batch's settlement in the same
pass. Both phases use the shared 30-second nominal dispatch probe budget.

## Interface changes

Preparation and publication use separate dispatch keys as described above.

## Verification

The offline `test/findings-batch.test.mjs` suite passed on the reviewed
implementation with the new regression fixture. The final targeted run of
`node test/run-tests.mjs` with the findings-batch, requeue, stranded-batch,
regression and probe-census files passed all 252 tests. `npm run lint` reported
zero errors. `npm run typecheck:contracts`,
`node scripts/validate-data-model-catalog.mjs`,
`bash demo/research-finding-walkthrough.sh` and `git diff --check` passed.
