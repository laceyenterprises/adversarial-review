# TIMINGTESTS-01

## Summary

Audit timing assertions across the test suite. Replace real deadline waits,
short sleep races, busy-loop grace periods, and pacing sleeps with the existing
`FakeClock` helper, Node mock timers, or injected time. Set filesystem timestamps
explicitly for the configuration-cache invalidation test.

Assertions now drive deadline expiry after the relevant operation has started.
Boundary checks cover pending work before expiry, cancellation at expiry, late
completion, and native wake delivery without advancing to a fallback deadline.
Route recheck coverage injects wake delivery; separate tests retain native
wake coverage. Native process fixtures, I/O rendezvous, test watchdogs, and SQLite driver
integration checks retain timers where those timers support the integration
rather than measure application deadline policy.

The audit included the 96 test files containing timer, sleep, or SQLite timeout
references and sibling elapsed-time assertions. Converted files:

- `test/adversarial-gate-status.test.mjs`
- `test/agy-reviewer-identities.test.mjs`
- `test/amascale-01.test.mjs`
- `test/config-loader.test.mjs`
- `test/controller-process-census.test.mjs`
- `test/dispatch-read-client.test.mjs`
- `test/federation-execution-adapter.test.mjs`
- `test/finalization-queue-owner.test.mjs`
- `test/finalization-queue-routing.test.mjs`
- `test/handoff-wake.test.mjs`
- `test/history-read-budget.test.mjs`
- `test/history-read-retry.test.mjs`
- `test/load-aware-operational-waits.test.mjs`
- `test/mes-shadow-hook.test.mjs`
- `test/no-merge-hold.test.mjs`
- `test/operator-gh-read.test.mjs`
- `test/osgbackfillpace-01.test.mjs`
- `test/posted-review-row-log-noise.test.mjs`
- `test/primary-change-store.test.mjs`
- `test/primary-change.test.mjs`
- `test/process-group-spawn.test.mjs`
- `test/reviewed-attestation.test.mjs`
- `test/reviewer-fence.test.mjs`
- `test/reviewer-runtime-adapter.test.mjs`
- `test/reviewer-stall.test.mjs`
- `test/run-bounded.test.mjs`
- `test/watcher-poll-starvation.test.mjs`
- `test/watcher-reviewer-pool.test.mjs`
- `test/watcher-wake.test.mjs`
- `test/worker-observation-client.test.mjs`

## Interface changes

None. Product code and CI configuration are unchanged.

## Verification

- All 30 converted files passed five runs each on Node 22.22.3 using
  `node test/run-tests.mjs` with the converted file paths. Test commands used
  the network guard and process-group validation wrapper, each bounded to
  at most 600 seconds.
- `npm run lint`: passed (zero errors; existing warnings).
- ESLint over all converted files: passed (zero errors; existing warnings).
- `npm run typecheck:contracts`: passed.
- `node scripts/audit-cdm-rederivation.mjs --strict --format json`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable output.
- `npm test`: incomplete; the full 864-file selection exceeded the
  600-second command limit. This is not a full-suite pass.
