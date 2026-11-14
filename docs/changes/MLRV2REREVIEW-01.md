# MLRV2REREVIEW-01

## Summary

V2 requests strict exact-head review for a proven final-round remediator push
whose automatic review was suppressed by a spent round budget. Other heads and
heads with verdicts retain their existing paths. V1 behavior is unchanged.

## Interface changes

The workflow emits `wait` / `request-reexact-review`, then `monitor-review` after
queue acceptance. Live executors accept app `rootDir` or an injected
`reviewSurface`; `createExactHeadReviewSurface` reuses the existing explicit
request API and durable repo/PR/head receipts without changing round budgets.
Shadow records would-request decisions without queueing. Existing watcher
lifecycle reconciliation cancels pending requests after head movement.
The queue transaction preserves a verdict posted during the final refresh,
and expired verdict patience still permits a bounded recovery read.

## Verification

Synthetic fixtures use fake time and cover once-per-head requests, repeated
ticks, restarts, concurrent executors, head movement, arriving verdicts,
non-remediator heads, shadow isolation, request coalescing, lost acknowledgements
and expired verdict patience.

- `npm run lint`: passed with zero errors; edited files also passed scoped ESLint.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable deliveries.
- `node --test --test-concurrency=4 --test-timeout=600000 test/finalization-*.test.mjs test/arfinalcheck-01.test.mjs test/explicit-review-intent.test.mjs test/retrigger-review.test.mjs test/watcher-claim-loop.test.mjs`: passed, 45 files, including all 176 watcher claim-loop cases.
- Final regression run of the exact-head, executor, live-shadow, workflow and
  divergence-classifier files with concurrency 1 and the same file timeout:
  passed, including all 19 new cases.
- Full `npm test` did not pass: the unmodified SMV sandbox smoke and closer
  retry lock-contention tests failed, followed by the runner's existing
  900-second suite timeout.

Test commands used the requested `NETGUARD_LOG`/`PATH` prefix and the validation
wrapper with `--timeout-seconds 600`. The requested netguard directory was
unavailable in this environment; tests used the repository's offline fixtures.
