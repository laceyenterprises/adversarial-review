# Data Model - Follow-Up Remediation Jobs

**Owner:** follow-up remediation queue
**Store:** `data/follow-up-jobs/{pending,in-progress,completed,failed,stopped}/*.json`
**Source of truth:** `src/follow-up-jobs.mjs`, `src/follow-up-remediation.mjs`, `src/remediation-quota-hold.mjs`, `src/remediation-claimed-requeue.mjs`, `src/remediation-worker-class-fallback.mjs`
**Runtime surface:** `src/comment-only-final-round.mjs`, `src/comment-only-final-round-completion.mjs`, `src/ama-closure-orchestration.mjs`

## Comment-only final-round evidence

A zero-blocker `Comment only` review with non-blocking findings creates a job
marked `finalRound: "comment-only"`. Every final-round job that reconciles a
worker reply records `reReview.suppressed: "comment-only-final-round"`, whatever
directory it lands in. The optional
`completion.workerPushedHeadSha` is a 40-character commit SHA written only when
the worker workspace's local `HEAD` matches a retried live GitHub PR-head lookup,
its commit carries the matching `Worker-Job-Id` trailer, and a local replay
proof holds (COMMENTCLOSE-01): every reviewed commit has a patch-equivalent in
`HEAD` (`git cherry HEAD <reviewed>`), `HEAD` adds no merge commit, and every
other commit it adds beyond the reviewed head and `origin/<base>` carries the
job's trailer (`git cherry <reviewed> HEAD origin/<base>`). The remediator's
mandatory base rebase makes most pushes `diverged` from the reviewed head, which
the earlier ancestry-only proof rejected without a log line.
`completion.workerPushProof` records `{ method: "git-cherry-replay",
reviewedCommitsReplayed, workerCommits }`. Reconcile remains re-entrant when a
transient lookup exhausts its retry budget. A transient git failure during the
proof (network, remote hang-up, lock contention) is retried after 2 s and 5 s;
if it persists the job stays in `in-progress/` with
`finalRoundProofTransient: { since, lastAttemptAt, attempts, error }` and later
ticks retry it. After one hour from `since` the proof is withheld as usual. HQ jobs use their resolved topic
workspace for this proof. Every withheld proof logs its reason
(`finalRoundOutcome.push`, for example `live-head-mismatch`,
`foreign-commit-in-push`, `branch-contamination-audit-failed`). When the proof
is withheld while the PR head moved, the job records that head as
`completion.withheldPushHeadSha`, an
`adversarial_review.comment_only_final_round_push_unproven` alert fires, and
`requestReviewRereview` refuses that head (`comment-only-final-round-push-unproven`)
unless an operator explicitly retriggers review.
Absent or malformed push proof grants no AMA final-round handoff.

`completion.finalRoundOutcome` (COMMENTCLOSE-01) records the reconciler's
decision: `{ completed, reason, ciState }`. A final round is complete when its
reply has no `blockers[]` and its only operational blockers are PR-head CI that
is still running, and either the reply says `completed` or the push is proven.
Pending CI is classified structurally: each entry carries
`kind: "pending-ci"`, or (legacy replies) exactly one untagged entry with no
`needsHumanInput`, in a reply whose outcome is not `blocked`, is corroborated by
the reconciler's CI probe of the proven pushed head reporting `pending`. `reason`
names the rule that decided, for example `kind-pending-ci`,
`ci-probe-pending-ci`, `operational-blocker-needs-human-input`,
`untagged-blocker-outcome-blocked`, `untagged-blocker-ci-not-pending`,
`ci-failed`, `review-blockers` or `no-proven-push`. An
incomplete final round still records its pushed head and suppression marker.

The ledger summary retains `commentOnlyFinalRoundRevisionRefs` for reviewed
heads and projects verified `(reviewedHead, workerPushedHeadSha)` pairs as
`commentOnlyFinalRoundPushedHeads`, with `completedAt` (the job's terminal
timestamp) for follow-up suppression and `status` for the terminal directory it
came from, and `pushProof` for the recorded proof method. Both read `completed/`,
`stopped/`, `failed/` and `stopped-archived/<YYYY-MM>/`: an archived stopped job
keeps its recorded push, its withheld head and its review key. AMA requires the current PR head to equal a
pair's pushed head, the settled review to match its reviewed head, and GitHub
compare to report the pushed head `ahead` (or `diverged` for a
`git-cherry-replay` proof); the closer then reads the verdict from the
matching terminal job's `reviewBody` (`findCommentOnlyFinalRoundPushJob`). While
PR-head CI on that head is pending, AMA holds the PR without spending the
retain-loop cap for up to two hours after the pair's `completedAt`
(`FINAL_ROUND_CI_WAIT_DEADLINE_MS`); past that it logs
`final-round-ci-pending-timeout` and the cap applies again. A later head can be
reviewed normally.
Job scans skip a file removed during a queue transition and warn on malformed
JSON without discarding other jobs.

## One follow-up per posted review

`createFollowUpJob` creates at most one job per posted review (COMMENTCLOSE-01).
The reviewer process and the watcher's reviewer-pass reaper can both queue the
same review (agent-os#7311: two final-round jobs 9 s apart). A review is keyed
by repo, PR, reviewed head (`revisionRef`) and the SHA-256 of its normalized
`reviewBody`. An existing job for that key in `pending/`, `in-progress/`,
`completed/`, `failed/`, `stopped/` or `stopped-archived/` makes the request a duplicate: the call
returns `{ job: null, jobPath: null, duplicateOf }`, the reviewer reports
`queued: false, reason: "duplicate-review-follow-up"`, and the reaper skips its
wake. A short-lived claim serializes the two processes between that scan and
the job write. It is a chain of generation files
`data/follow-up-jobs/review-claims/<repo>-pr-<n>-<revisionRef>-<digest16>.g<N>.json`
(`{ repo, prNumber, revisionRef, digest, token, claimedAt, pid, host }`), each
created exclusively; the highest generation holds the claim. A holder older than
2 minutes, whose process has exited on this host, or whose file is unreadable is
abandoned, and taking it over means creating the next generation, so only one
recoverer wins. A claim held by a live creator is not a duplicate: the caller
waits for that job to appear or the claim to be released or abandoned, and throws
`review-follow-up-in-flight` if that takes more than 4 minutes. Release is
token-checked and removes the chain only for the current holder. A review with no
reviewed SHA or no body is not de-duplicated.

## Remediator quota holds and fallback (REMFALLBACK-01)

A quota hold is a job whose latest `remediationPlan.retryHistory[]` entry has
`retryMetadata.code: "quota-exhausted"` (a legacy job with no history is read
from `remediationPlan.lastRetryMetadata`). Two writers produce it.

Reconcile (`settleQuotaExhaustedRemediation`, `src/remediation-quota-hold.mjs`)
writes it when a spawned worker hit a provider usage cap:

- `harness`: the quota harness named by the cap signal.
- `workerClass`, `model`: the remediator class (`remediationWorker.model`) and
  resolved model that ran, or `null`. These are the job-local cap evidence the
  next claim reads.
- `resetAt`, `providerResetAt`: the parsed provider reset (ISO) or `null`.
- `source`: `"provider-reported"` or `"fallback-window"`.
- `maxUnvalidatedHoldMs`: the one-hour hold window.
- `pastHoldWindow`: `true` when the provider reset is more than one hold window
  away. That hold does not increment `remediationPlan.transientRetries`, and it
  never reaches the terminal `quota-exhausted-budget-exhausted` failure, because
  the next claim re-resolves the remediator class instead of respawning the
  capped one.

Claim (`holdClaimedJobForCappedRemediator`, `src/remediation-claimed-requeue.mjs`)
writes it when the routed remediator is capped and no declared fallback class
can take the job. The job returns to `pending/` budget neutral, with its claimed
round removed, `remediationPlan.retryAfter` set to the hold end and a
`consume-pending-round` `nextAction`. The entry has `worker: null`, and
`retryMetadata` carries `code`, `harness`, `workerClass`, `model`, `resetAt`,
`providerResetAt`, `maxUnvalidatedHoldMs` as above, plus:

- `source`: `"remediator-fallback-resolution"`.
- `capSource`: what proved the cap, for example a fleet quota state or
  `"provider-reset-past-hold-window"`.
- `fallbackReason`: `"no-available-fallback"`, `"no-fallback-configured"` or
  `"primary-resets-within-hold-window"`.
- `skipped[]`: `{ workerClass, reason }` for each declared fallback class passed
  over (`provider-untracked`, `reviews-next-round:<reviewer>`,
  `capped:<capSource>`, `resets-within-hold-window`, `unavailable:<state>`).
- `noRespawn: true`: the claim gate releases the hold early only on a fleet
  probe whose `lastGoodAt` is newer than the entry's `requeuedAt`.

When the claim moves the job to a fallback class, the spawned
`remediationWorker` records the substitution:

- `fallbackFrom`: the routed class that was capped.
- `fallbackReason`: the cap source, or the routing reason when none.
- `fallbackResolution`: `{ reason: "primary-grounded-fallback", capSource,
  primaryState, resetAt, candidateState, skipped[] }`. `candidateState` is the
  fallback's fleet quota state, or `"unverified"` when the fleet status could
  not be read.

A job run by its routed class has none of these fields. The fallback order is
`roles.remediator_fallback` in `config.yaml`.
