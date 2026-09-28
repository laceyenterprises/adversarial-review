# Data Model - Follow-Up Remediation Jobs

**Owner:** follow-up remediation queue
**Store:** `data/follow-up-jobs/{pending,in-progress,completed,failed,stopped}/*.json`
**Source of truth:** `src/follow-up-jobs.mjs`, `src/follow-up-remediation.mjs`
**Runtime surface:** `src/comment-only-final-round.mjs`, `src/ama-closure-orchestration.mjs`

## Comment-only final-round evidence

A zero-blocker `Comment only` review with non-blocking findings creates a job
marked `finalRound: "comment-only"`. When that worker completes, the completed
job records `reReview.suppressed: "comment-only-final-round"`. The optional
`completion.workerPushedHeadSha` is a 40-character commit SHA written only when
the worker workspace's local `HEAD` matches a fresh GitHub PR-head lookup and its commit carries the matching `Worker-Job-Id` trailer.
Absent or malformed push proof grants no AMA final-round handoff.

The ledger summary retains `commentOnlyFinalRoundRevisionRefs` for reviewed
heads and projects verified `(reviewedHead, workerPushedHeadSha)` pairs as
`commentOnlyFinalRoundPushedHeads`, with `completedAt` for follow-up suppression. AMA requires the current PR head to equal a
pair's pushed head, the settled review to match its reviewed head, and GitHub
ancestry to confirm the transition. A later head can be reviewed normally.
Job scans skip a file removed during a queue transition and warn on malformed
JSON without discarding other jobs.
