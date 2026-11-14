# IMMEDIATETX-01

## Summary

Reserve SQLite's writer before the first transaction read in posted-artifact
and timed-out pass settlement, duplicate-family upsert, selection-audit
confirmation, TTM flag synchronization, and live finalization-shadow recording.
Each uses the existing better-sqlite3 `transaction.immediate()` pattern. Busy
timeouts and retry handling are unchanged.

## Interface changes

None. No schema, configuration, or deployment changes.

## Verification

- `node --test test/immediate-store-transactions.test.mjs`: seven passing
  regressions using two connections to a synthetic temporary WAL database and
  fake clocks. A competing writer is attempted immediately after the first
  transaction read. Tests check committed output and release of the writer
  reservation. Timed-out settlement covers both claim release and exhausted
  infrastructure recovery; both new cases reproduce `SQLITE_BUSY_SNAPSHOT`
  before the fix. Restoring deferred mode makes the regressions fail.
- Final remediation: `node test/run-tests.mjs
  test/immediate-store-transactions.test.mjs test/reviewer-timeout.test.mjs
  test/reviewer-timeout-budget.test.mjs test/reviewbounce.test.mjs
  test/reviewed-head-settlement.test.mjs`: 104 tests passed across five files
  in the isolated offline runner after rebasing onto fresh `origin/main`.
- `node test/run-tests.mjs <23 test files exercising the changed modules>`:
  726 tests passed, zero failures, in 556 seconds, including the watcher
  claim-loop suite.
- `npm run lint`: passed with zero errors.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable output.
- `npm test`: incomplete; the 865-file runner reached its own 900-second
  timeout with no test failures reported before termination. The validation
  wrapper's nominal 600-second timeout was extended by its load-aware policy.
