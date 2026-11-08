# CLOSERWAKEEXPIRY-01

## Summary

Expired unacted hammer wakes can reserve a new audited attempt. AMA closer
dispatch reconciles existing custody before refusing missing reviewed-head
evidence with a deduplicated alert. Wake targets never fill live-head metadata.
See the [SEV1 report](../postmortems/SEV1-expired-closer-wake-and-missing-reviewed-head-2026-11-08.md).

## Interface changes

Wake audits add optional `supersedes` and `wakeDeadline` fields. AMA bootstrap
dispatch refuses new launches without review provenance: `ama-reviewed-head-unavailable`
with a known current head, otherwise `ama-head-unavailable`. Both alert through
the existing closure-wait path. Catalog fields live in the canonical catalog.json.
No configuration, CI job, review budget or merge predicate changes.

## Verification

Targeted offline validation (full local suite intentionally omitted per the
remediation worker contract):

- `node test/run-tests.mjs test/ama-closer-dispatch-priority.test.mjs`: 327 passed.
- `node test/run-tests.mjs test/hammer-wake-next-action.test.mjs`: 52 passed.
- `node --test test/smv.test.mjs`: 11 passed, including the disposable smoke
  and missing-review refusal before prompt rendering.
- `npm run lint`: zero errors, 152 existing warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 91 entries validated.
- `bash demo/research-finding-walkthrough.sh`: byte-equivalence demo passed.
- `git diff --check`: passed.

The initial dispatch run passed 324 cases; expanded custody coverage passed
in the final dispatch run. An attempted name-filtered run was redirected by the
repository sandbox runner to the whole file and exceeded its 120-second bound;
validation uses the explicit file runner with a 600-second bound instead.

A head and wake attempt may renew at most three times. Further expiry uses
the existing deduplicated closure-wait page and does not request another wake.
No live recovery operation or production acceptance observation was performed.

## CI remediation

Initial wake deliveries now persist their own `wakeDeadline` from reservation
time and the decision's finite positive budget. This prevents an overdue
ownership deadline from renewing a freshly delivered wake on the next call;
the original deadline remains in `nextAction`. The domain doc, canonical
catalog, runbook, state declarations and disposable smoke describe this timing.
Stacked-base dispatch fixtures supply reviewed provenance so they still exercise
the base guard. The cancellation fixture allows bounded observation of process
group termination on Linux as well as macOS.

Validation: the seven targeted wake, recovery, stacked-base and artifact suites
passed all 218 tests; closer dispatch and watcher claim-loop suites passed all
487 tests. SMV passed all 11 tests including disposable smoke. Lint
passed with zero errors (152 existing warnings), contract typechecking passed,
the catalog validator passed 91 entries and the research-finding demo passed.
The full local suite was not run, per the remediation worker contract.
