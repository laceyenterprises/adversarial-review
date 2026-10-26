# TTM ownership observations (HOLDOWNER-01)

**Owner:** watcher TTM tracker
**Store:** `data/reviews.db`
**Schema surface:** `src/ttm-owner.mjs`

The tracker observes ownership; these records never authorize admission, dispatch,
retry, hold release, or merge. Existing routing and merge authority are unchanged.

`ttm_owner_state` has one row per `(repo, pr_number)`: `head_sha`,
`review_suppressed` (0/1), `review_reason`, `observed_at`, and nullable
`ownerless_since`. Reviewer gates record decisions they already made. An ordinary
poll preserves a previous suppression until a gate admits review or observes a
new head. New heads reset suppression and the ownerless clock. The tracker sets
`ownerless_since` on its first unowned observation, preserves it while unowned,
and clears it when ownership returns or the PR becomes terminal. Restarting the
watcher retains the clock. No backdated PR age or TTM budget starts it.

Resolution selects one owner in this precedence: operator hold label, live closer
or remediator, bounded machine-checkable hold, actionable review lane. Completed
review alone is not a promise to act next. The closer reader uses existing lease
and dispatch exports, including launches keyed to an earlier head and terminal
launch observations. Hold readers use the existing hammer-stop exports; input
change holds need a finite future deadline. A transient retry time and a recorded
quota-reset time are machine-checkable deadlines. Unbounded, released or expired
holds cannot claim ownership. Reasons name the declined lanes and hold gap.

After more than seven minutes without an owner (one ordinary five-minute watcher
cadence plus two minutes), the existing TTM flag store records STUCK `ownerless`.
Its event key includes the PR head. The three existing STUCK kinds and SLOW
budget classification keep their thresholds and conditions.

`ttm_stuck_pages` is keyed by `(repo, pr_number, head_sha)` and stores `paged_at`.
All STUCK kinds share one page per head through `alert-delivery.mjs`, with every
active reason in the payload. A receipt is saved only after alert enqueue succeeds;
errors retry next poll. The alert outbox also uses a deterministic PR/head identity,
so losing the tracker receipt after enqueue cannot duplicate the page. Ownership
return or flag resolution does not erase a page receipt. New heads are evaluated
anew. These are observation/delivery records, not blocking gates.

The health collector reads these observations without writing or paging. Offline
regressions are in `test/ttm-owner.test.mjs`, `test/ttm-tracker.test.mjs`,
`test/review-pipeline-health-ttm.test.mjs`, `test/review-pipeline-health.test.mjs`,
`test/watcher-claim-loop.test.mjs`, and the HOLDOWNER-01 alert-delivery fixture.
