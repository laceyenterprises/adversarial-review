# FINDINGSSTUCK-01

## Summary

Release errored batches without launch receipts after the existing timeout, and
bound failed initial dispatch submissions to three per batch. A missing keyed
receipt after timeout requires direct recorded-launch/retry ledger evidence;
unreadable evidence retains custody and reports `needs-operator`.
Every release keeps the existing per-finding requeue/exhaustion accounting.
Add bounded redacted dispatch stderr and one per-pass backlog summary.
See the [SEV2 report](../postmortems/SEV2-findings-batches-retained-open-findings-after-launch-errors-2026-11-08.md).

## Interface changes

Add replay-safe migration `20261109_findings_batch_dispatch_attempts.sql`:
`finding_batches.batch_attempts` counts failed initial submissions, independently
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
