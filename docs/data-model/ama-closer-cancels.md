# Data Model - AMA Closer Cancel Obligations

**Owner:** AMA lifecycle settlement
**Store:** `data/ama-closer-cancels/`
**Source of truth:** `src/ama/closer-terminal-cancel.mjs`
**Runtime surface:** `src/pr-lifecycle-sync.mjs`, `src/posted-review-row.mjs`

## Purpose

When GitHub reports a closed, unmerged PR with a live AMA closer lease,
`queueCloserCancelForClosedPr` writes this obligation before the lifecycle
mirror marks the PR closed. The queue survives watcher restarts and lets the
terminal mark proceed without an HQ subprocess in its critical path.

Each `<repo-slug>-pr-<number>.json` record has `schemaVersion: 1`, `repo`,
`prNumber`, `targetHeadSha`, `queuedAt`, `attempts`, `lastAttemptAt`, and `state`. `targetHeadSha` identifies the lease observed when the obligation was queued; an exhausted record is replaced if a later close has a different live lease head. On a failed
attempt, `lastError` stores a bounded diagnostic. `state` is `pending` until
HQ cancellation or definitive no-worker evidence settles the lease; the
record is then deleted. After five failed attempts, `state` becomes
`exhausted`, the record is retained for operator inspection, and an alert is
queued. The `alerted` flag records successful alert queueing; a failed alert
write is retried on a later tick. The watcher drains at most three obligations per tick and spaces
attempts by at least one minute. A pending lease with no launch ID waits for
its launch expiry without consuming the HQ failure budget. Corrupt records are logged and skipped so
one file cannot block later obligations. Before each drain attempt, the watcher
reads the live PR state. Reopened or merged PRs drop their pending obligation
without cancelling the closer. An unavailable state read leaves it queued.
