# REVIEWSPILLSTALL-01

## Summary

A spilled review is now admitted to the alternate reviewer capacity it
reserved. It is no longer refunded and routed back to a saturated Gemini lane.
Review queue depth now counts every unreviewed head, so spill slots match real
demand. The pool cap and the per-lane spill budgets are unchanged.

- **A duplicate of an in-flight head no longer takes spill slots.** Discovery
  can re-queue a PR whose current head this process is already dispatching.
  That snapshot used to spill, take a depth-budget slot, start, and then refuse
  with `head-dispatch-lease-held`. Another PR in the same wave had already been
  denied that slot. The snapshot is now admission-blocked
  (`admissionBlockReason() === 'head-dispatch-lease-held'`). It reserves
  nothing and waits until the in-flight review settles.
- **Real reasons replace the generic label.** Refunds and
  `review-wait-decision` lines used to report every unstarted or refused
  candidate as `pool-admission-deferred`. They now carry the real reason: the
  refusal (`head-dispatch-lease-held`, `claim-race-lost`, `watcher-drain-active`,
  `hold-release-*`, `inline-final-hammer-pending`, `reviewer-not-spawned`), the
  pool's own deferral reason, `admission-error` for a thrown drain,
  `candidate-refreshed` for a replaced snapshot, or `not-started`.
- **A deferred spill stays on its alternate class.** When the pool defers a
  queued spilled candidate after a normal drain, the candidate keeps its
  reservation and its alternate route, logs `review-queue-depth-spill-retained`,
  and starts on that class in the next drain. A started candidate that is
  refused leaves the queue, and its route no longer flips back to Gemini. A
  thrown drain (`admission-error`) and a discovery refresh
  (`candidate-refreshed`) still refund and restore, so no reservation outlives
  its queue entry. The refreshed snapshot re-evaluates the spill against the
  current tick's budget.
- **Depth counts unreviewed heads.** `SQL_COUNT_OPEN_AWAITING_REREVIEW`, and
  through it `SQL_COUNT_OPEN_AWAITING_REVIEW`, now include a `posted` row whose
  `revision_ref` has moved past `reviewer_head_sha` and has no delivered review.
  In-place repairs leave rows in that shape, and the old predicate counted them
  as already reviewed. The first-pass stall pager population is unchanged.
- **Missing drain results preserve normal accounting.** A queue implementation
  returning `undefined` or `null` is treated as an empty result, avoiding errors
  in both deferred-candidate unpacking and dispatch logging. Unstarted
  candidates stay queued and use `not-started` when no deferral reason is given.

## Interface changes

- No configuration keys, CI checks or gates.
- New candidate hooks used by the shared drain: `admissionBlockReason()` and
  `retainDepthSpill(reason)`. `refundDepthSpill(reason)` now defaults to
  `not-started`.
- New log line: `review-queue-depth-spill-retained repo=… pr=… reviewer=… reason=…`.
- `FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT` text now names heads newer than their
  posted review.
- `state-machines.json`: the source projection hash for
  `src/review-state-statements.mjs` was refreshed. The edit touched only a
  read-only count predicate; no states or transitions changed.
- Canonical doc corrected in place:
  [RUNBOOK-review-queue-depth-failover.md](../RUNBOOK-review-queue-depth-failover.md).

## Verification

- `node test/run-tests.mjs test/reviewspillstall-01.test.mjs`: 5/5 pass. All 5
  fail against an archive of `origin/main`.
- `node --test test/watcher-claim-loop.test.mjs`: 169/169 pass. The two updated
  scenarios and the new lease-busy scenario fail against `origin/main`.
- RSP-01 / RSPREREVIEW-01 / REVIEWAGE-02 / REVIEWSPILL-01 suites:
  `review-queue-depth-failover`, `review-queue-depth-cli`,
  `watcher-reviewer-dispatch`, `watcher-reviewer-admission`,
  `watcher-reviewer-refill`, `watcher-reviewer-pool`, `operator-hold-counts`
  and `smv` are green.
- Final comment-only remediation adds dispatch regression cases for
  `undefined`, `null`, empty and partial queue results, checking queue retention,
  next-wave preparation and `not-started` reservation accounting.
- `node test/run-tests.mjs test/watcher-reviewer-dispatch.test.mjs
  test/reviewspillstall-01.test.mjs`: 30/30 pass.
- The broader claim-loop run reached its 120-second bound without reporting
  assertion failures. A 30-second name-filtered retry also timed out because
  the isolation helper re-executes through the runner without forwarding the
  name filter. Full claim-loop completion remains a PR-head CI check.
- `npm run lint`: passes with 0 errors (149 existing warnings).
- `npm run typecheck:contracts`: passes.
- `bash demo/research-finding-walkthrough.sh`: passes offline with three
  byte-stable transcript deliveries.
