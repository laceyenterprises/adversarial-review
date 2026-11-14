# PUBLISHINTENTSTRAND-01

## Summary

Recover a prepared findings batch whose publisher submission never reached the
launch ledger. After the recorded dispatch deadline plus grace, readable
all-terminal keyed custody with no publisher permits one atomic intent
replacement and same-branch/key/ticket resubmission. Late publisher receipts
retain existing recovery; live, unknown and unreadable evidence holds. A second
absence preserves the existing 24-hour stale release and finding accounting.
See the [SEV3 report](../postmortems/SEV3-findings-publisher-intent-stranded-without-a-launch-receipt-2026-11-14.md).

## Interface changes

`publish-intent.json` adds ISO `submittedAt`, `dispatchTimeoutMs` and
`resubmissionCount`. Its one replacement records `resubmitOf` with the previous
submission time/timeout and persists count one before dispatch. Legacy intents
use mtime and the current dispatch timeout. Invalid intent evidence holds.
Submission timestamps include elapsed processing/probe time since the runner's
clock origin, so slow earlier work cannot shorten the grace.

`ADVERSARIAL_FINDINGS_BATCH_PUBLISH_RECEIPT_GRACE_MS` defaults to 600000 positive
integer milliseconds; `findingBatchOptions` exposes `publishReceiptGraceMs`,
also injectable in `runFindingBatches`. No config.yaml key, SQLite schema,
outcome schema, lifecycle enum, merge gate or smoke command changes.
Canonical data-model/catalog fragment, README, runbook and lifecycle/verification
declarations describe the bounded retry.

## Verification

Explicit validation commands use `python3 -m cwp_dispatch.worker_validation
--repo-root . --timeout-seconds 600 --command <argv>`. The test command alone
adds the required `NETGUARD_LOG` and netguard-prefixed `PATH`.

- `node --test test/findings-batch.test.mjs`: 122 passed, zero failures
  (5.5 seconds), including all existing cases in that file.
- `npm run lint`: zero errors, 149 existing warnings.
- `node node_modules/eslint/bin/eslint.js --fix src/findings-batch.mjs
  test/findings-batch.test.mjs`: passed with no rewrites.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: validated 98 entries.
- `git diff --check`: passed.

The ticket limits tests to touched files, so the full suite and walkthrough demo
were not run. Fixtures use disposable SQLite and injected synthetic dispatch,
ledger and publication evidence. No live review store or batch artifacts were
changed; source validation does not establish deployed recovery.
