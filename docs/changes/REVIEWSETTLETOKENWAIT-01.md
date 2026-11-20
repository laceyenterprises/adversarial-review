# REVIEWSETTLETOKENWAIT-01

## Summary

Reviewer-pass settlement no longer waits on token-ledger reads that cannot
succeed. `readReviewerLedgerEvidenceWithRetry` in `src/reviewer-spawn-settle.mjs`
now reads once and does not retry a ledger miss; only transient SQLite
contention is retried. Queue wait plus the read is capped by a load-aware
settle bound (10 s nominal). A read that outlives the bound keeps running. Its
late evidence is replayed onto the same pass, a deferred backfill that runs
after the settle's own replay. A settle with no launch ID now records
`worker-run-not-attributable` after one attempt. Every settle that reads
evidence logs one info line with `attempts`, `reason` and `deferred`.

See the [SEV1 report](../postmortems/SEV1-REVIEWSETTLETOKENWAIT-01-reviewer-settlement-waited-on-ledger-reads-that-could-not-succeed-2026-11-20.md)
for Phase 0. In rollback admission mode the poll awaits settlement; in the
default split mode it does not.

## Interface changes

- `workerRunAttribution.lastError` gains `worker-run-not-attributable` (no
  launch ID, `not-applicable`) and `settle-bound-exceeded` (`pending`).
  `lookupAttempts` is now 1 for a ledger miss. Field names, states and
  `retryable` semantics are unchanged.
  [`docs/data-model/reviewer-passes.md`](../data-model/reviewer-passes.md) is
  corrected in place.
- The `step=token-ledger-lookup` timing line gains `reason=` and `deferred=`.
  A new `step=token-ledger-backfill` line logs late replays, and a new
  `reviewer_pass_token_backfill_failed` warning logs failed ones.
- `spawnReviewer` accepts an optional `ledgerLookupBoundMs` override, used by
  tests. No configuration key, CI check or gate is added.

## Verification

- `node --test --test-concurrency=2 test/reviewer-spawn-settle.test.mjs`:
  34/34 passed. Against the base source, the new and updated tests fail: three
  attempts where one is expected, and the bounded-settle test never finishes
  because the settle is still waiting on the blocked read.
- `node test/run-tests.mjs` over `watcher-claim-loop`, `reviewer-spawn-settle`,
  `reviewer-pass-settlement`, `reviewer-token-ledger-lookup`,
  `reviewer-attribution`, `reviewer-token-pool-contention`,
  `afh-reviewer-fallback`, `hq-root-runner-probe`, `codex-account-routing`,
  `claude-account-routing` and `remedbranch-01`: 11 files, 0 failed. The new
  claim-loop test fails against the base source: six reads for two settles.
- `npm run lint`: 0 errors. `npm run typecheck:contracts`: passed.
  `bash demo/research-finding-walkthrough.sh`: passed.
