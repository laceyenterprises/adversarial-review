# CLOSURELAGSTALE-01 — a merged PR leaves the closure-lag queue even after its breach paged

## Summary

`observeClosureLag` only re-read live PR state for overdue waits whose per-PR
breach had **not** paged. A PR that paged and then merged outside an observed
walk therefore stayed `terminal: false` forever. It kept counting toward
`ama.closure_queue_depth`, its age held the rolling p95 above the SLO, and the
aggregate `p95` breach stayed latched as paged, so it could never page again.

Paged waits are now re-read too, throttled and bounded:

- at most `LIVE_READS_PER_PASS` (10) live reads per observation, undelivered
  breaches first, then least recently read, then oldest `eligibleAt`, so a
  large stale backlog drains over a few observations without a read burst;
- each paged wait is re-read at most once per `PAGED_RECHECK_MS` (15 minutes),
  tracked by the new optional `prs[].liveCheckedAt` field;
- a failed or ambiguous read still leaves the wait pending (it only records
  the attempt, which rotates the queue).

A reconciled PR becomes terminal through the existing `markTerminal` path,
which removes its `pr:` breach. A completion sample for a merge discovered by
the live read is dated by its merge time (capped at the observation time)
instead of the reconciliation time, so a month-old merge reconciled late does
not hold the 24-hour p95 above the SLO. Merges reported by callers keep the
observation time.
The `p95` breach then clears through the existing `p95 <= limit` branch and can
page again on a later real breach. The SLO, paging text, per-PR breach rule and
merge behaviour are unchanged. No new client or configuration key.

## Interface changes

- New exports `LIVE_READS_PER_PASS` and `PAGED_RECHECK_MS` from
  `src/ama/closure-lag.mjs`.
- New optional state field `prs[].liveCheckedAt` (epoch ms); older ledgers need
  no migration.
- `samples[].at` is the merge time, not the observation time, for merges the
  live read discovers.

## Verification

`test/closurelagstale-01.test.mjs` covers
reconciliation after paging, the recheck throttle, the per-pass bound over 30
stale waits, p95 clearing and re-paging, priority of unpaged breaches, and
failed or ambiguous reads. All 8 fail against the base source.

All commands ran offline under the network guard.

- `node test/run-tests.mjs closurelagstale-01.test.mjs amascale-01.test.mjs terminal-daemon-waiters.test.mjs ama-daemon-merge.test.mjs watcher-daemon-clean-merge.test.mjs ama-closer-dispatch-priority.test.mjs alert-delivery.test.mjs`:
  **712/712 passed**; existing closure-lag tests are unchanged.
- `npm run lint`: **0 errors** (149 existing warnings). `npm run typecheck:contracts`: **passed**.
  `bash demo/research-finding-walkthrough.sh`: **passed**.
- `npm test`: hit the runner's 900-second local deadline (a known local
  limit). The one failure seen before then was `derived-artifacts.test.mjs`
  `spawnSync npm ETIMEDOUT` under load. That file is untouched, and it passes
  40/40 when run alone. PR-head CI runs the full suite.
