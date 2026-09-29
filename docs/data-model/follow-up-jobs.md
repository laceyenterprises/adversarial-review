# Data Model - Follow-Up Remediation Jobs

**Owner:** follow-up remediation queue
**Store:** `data/follow-up-jobs/{pending,in-progress,completed,failed,stopped}/*.json`
**Source of truth:** `src/follow-up-jobs.mjs`, `src/follow-up-remediation.mjs`
**Runtime surface:** `src/comment-only-final-round.mjs`, `src/comment-only-final-round-completion.mjs`, `src/ama-closure-orchestration.mjs`

## Comment-only final-round evidence

A zero-blocker `Comment only` review with non-blocking findings creates a job
marked `finalRound: "comment-only"`. Every final-round job that reconciles a
worker reply records `reReview.suppressed: "comment-only-final-round"`, whatever
directory it lands in. The optional
`completion.workerPushedHeadSha` is a 40-character commit SHA written only when
the worker workspace's local `HEAD` matches a retried live GitHub PR-head lookup,
its commit carries the matching `Worker-Job-Id` trailer, and GitHub compare
reports the worker head as ahead of the reviewed head. Reconcile remains
re-entrant when a transient lookup exhausts its retry budget. HQ jobs use their
resolved topic workspace for this proof.
Absent or malformed push proof grants no AMA final-round handoff.

`completion.finalRoundOutcome` (COMMENTCLOSE-01) records the reconciler's
decision: `{ completed, reason, ciState }`. A final round is complete when its
reply has no `blockers[]` and its only operational blockers are PR-head CI that
is still running, and either the reply says `completed` or the push is proven.
Pending CI is classified structurally: each entry carries
`kind: "pending-ci"`, or exactly one untagged entry is corroborated by the
reconciler's CI probe of the proven pushed head (`ciState` is `pending` or
`green`, never `failed`). `reason` names the rule that decided, for example
`ci-probe-pending-ci`, `ci-failed`, `review-blockers` or `no-proven-push`. An
incomplete final round still records its pushed head and suppression marker.

The ledger summary retains `commentOnlyFinalRoundRevisionRefs` for reviewed
heads and projects verified `(reviewedHead, workerPushedHeadSha)` pairs as
`commentOnlyFinalRoundPushedHeads`, with `completedAt` (the job's terminal
timestamp) for follow-up suppression and `status` for the terminal directory it
came from. Both read `completed/`, `stopped/` and `failed/`. AMA requires the current PR head to equal a
pair's pushed head, the settled review to match its reviewed head, and GitHub
ancestry to confirm the transition. A later head can be reviewed normally.
Job scans skip a file removed during a queue transition and warn on malformed
JSON without discarding other jobs.
