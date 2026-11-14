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

- Remediation verification on 2026-11-14: all 30 converted files passed one
  run on Node 22.22.3 using `node test/run-tests.mjs` with the converted file
  paths (1,383 tests passed; zero failures). The command used the network guard
  and process-group validation wrapper, bounded to 600 seconds. This replaces
  the earlier five-run claim with evidence reproduced in this round.
- The reviewed head `b1980a79b5fa6b7de2bc810aee5b045d3a40c95d`
  already imports `fs` and `syncBuiltinESMExports` in
  `test/finalization-queue-routing.test.mjs:5-6`, and `utimesSync` in
  `test/handoff-wake.test.mjs:6`. Both files passed in the run above; no import
  correction was needed.
- `npm run lint`: passed (zero errors; existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable output.
- Earlier implementation verification (not repeated in this remediation):
  ESLint over all converted files and
  `node scripts/audit-cdm-rederivation.mjs --strict --format json` were recorded
  as passed. `npm test` was incomplete: the full 864-file selection exceeded
  the 600-second command limit. This is not a full-suite pass; full-suite
  validation remains with PR-head CI.
