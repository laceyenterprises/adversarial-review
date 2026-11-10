# FINDINGSSTUCK-01

## Summary

Release errored batches without launch receipts after the existing timeout, and
bound returned invalid initial dispatch receipts to three per batch. Subprocess
transport, timeout and admission failures retain the same batch/key without
consuming finding attempts or resetting invalid-receipt charges. Legacy
ambiguous dispatch errors reset the old counter once. A missing keyed receipt
after timeout requires the recorded launch and its observed retries to be
terminal in the direct snapshot. Missing or unreadable evidence retains
custody. Overdue dispatch retries and unproven probes report `needs-operator`.
Every release keeps the existing per-finding requeue/exhaustion accounting.
Add bounded redacted dispatch stderr and one per-pass backlog summary.
See the [SEV2 report](../postmortems/SEV2-findings-batches-retained-open-findings-after-launch-errors-2026-11-08.md).

## Interface changes

Add replay-safe migration `20261109_findings_batch_dispatch_attempts.sql`:
`finding_batches.batch_attempts` counts returned invalid initial receipts, independently
of `finding_backlog.batch_attempts` release charges. Missing launch receipts
report `batch-launch-receipt-missing`; capped submissions release with
`batch-dispatch-attempts-exhausted` only on terminal/absent ledger custody.
`runFindingBatches` adds the injectable `readLaunchSnapshot` seam.
Per-pass summary logs include `openFindings` and grouped
`stuckBatches` with `reason`, `count` and `oldestAgeMs`.
No configuration key, CI check, merge predicate or override label is added.
Canonical data-model, README operational text, runbook and state/verification
declarations describe the release/hold behavior. No new smoke command.

## Verification

Explicit commands use `python3 -m cwp_dispatch.worker_validation --repo-root .
--timeout-seconds 600 --command ...` with the available worker-pool Python
module path. Tests run one touched file at a time under
`NETGUARD_LOG=/tmp/FINDINGSSTUCK-01-netguard-final.log
PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH`.

- `node --test test/findingsrequeue-01.test.mjs`: final run passed all 40 tests
  (66.2 seconds), including the public unproven-absence envelope.
- `node node_modules/eslint/bin/eslint.js src/findings-batch.mjs
  test/findingsrequeue-01.test.mjs`: passed, zero errors.
- `npm run typecheck:contracts`: passed.
- `git diff --check`: passed.

The ticket limits test execution to touched test files; no full suite or
walkthrough demo was run. Fixtures use disposable SQLite and injected synthetic
dispatch/ledger responses. No live review DB changes or recovery actions were
performed. Source validation does not establish deployed backlog recovery.

## Remediation validation (PR #1777, round 2)

Regression coverage exercises twelve daily transient dispatch failures on a
legacy capped batch already at two finding attempts, then successful recovery
on the original idempotency key. A separate fixture retains the invalid-receipt
cap. Canonical state, data-model and README contracts describe the distinction;
no schema shape, lifecycle values or deployed smoke commands change.

- Bounded `node --test test/findingsrequeue-01.test.mjs test/findings-batch.test.mjs test/smv.test.mjs`: 153 passed, zero failures.
- Targeted ESLint on the source and both findings test files: zero errors.
- `node scripts/validate-data-model-catalog.mjs`: validated 91 entries.
- `npm run typecheck:contracts` and `git diff --check`: passed.

The neighboring PR-reader fixture now fixes its clock inside the timeout so
its marker/read-error checks cannot accidentally exercise overdue release.

## CI remediation (PR #1777, round 3)

Both Node CI lanes failed the posted-review database-read assertion because
the new dispatch-attempt migration's six sentinel reads were included in the
non-migration budget. Account for that migration separately using the existing
test convention, asserting exactly six reads and retaining the 114-read runtime
budget. No production interface, schema, lifecycle or smoke contract changes.

Verification: reproduced the CI failure locally (`120 !== 114`) before the fix.
`npm run lint` passed with zero errors (152 existing warnings); targeted ESLint
on the changed test, `npm run typecheck:contracts`, the offline research-finding
walkthrough and `git diff --check` passed. Full-suite execution remains with CI.
The changed watcher-closure-latency file passed all 33 tests independently.
A broader bounded run also passed both findings files (110 tests) and those
33 tests, but its additional, unchanged watcher-claim-loop file exceeded the
120-second deadline; that optional expansion does not establish a full
claim-loop result.
