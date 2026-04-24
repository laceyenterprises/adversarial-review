# Follow-Up Remediation Runbook

This runbook covers the shipped bounded remediation loop for adversarial-review after `LAC-206`, `LAC-209`, `LAC-210`, and `LAC-211`.

Use this when a review has already been posted to GitHub and you need to run, inspect, reconcile, stop, or debug the follow-up remediation flow without reading the implementation first.

## Scope and Current Contract

- This is a bounded, operator-visible loop. It is not an autonomous retry daemon.
- The watcher owns review posting. Follow-up remediation does not post GitHub reviews directly.
- The remediation worker works on the existing PR branch, commits changes, and pushes that branch.
- The remediation worker does **not** open a new PR and does **not** land or merge the PR.
- Advancing from one remediation round to another remains an explicit operator action.

Relevant scripts:

```bash
npm run follow-up:consume
npm run follow-up:reconcile
npm run follow-up:requeue -- <job-path> [reason]
npm run follow-up:stop -- <job-path> [reason]
```

## Lifecycle

### 1. Review pickup and follow-up job creation

When the watcher successfully posts an adversarial review comment, it writes a durable JSON job under:

```text
data/follow-up-jobs/pending/
```

That job includes:

- PR identity: `repo`, `prNumber`, `linearTicketId`, `reviewerModel`
- Review context: `reviewSummary`, `reviewBody`, `critical`
- Bounded-loop state: `remediationPlan.mode`, `maxRounds`, `currentRound`, `rounds[]`
- Reply contract state: `remediationReply.state`
- Future-session placeholder metadata: `sessionHandoff`

Initial state:

- `status = "pending"`
- `remediationPlan.mode = "bounded-manual-rounds"`
- `remediationPlan.maxRounds = 6` unless overridden at creation
- `remediationPlan.currentRound = 0`
- `remediationReply.state = "awaiting-worker-write"`
- `remediationPlan.nextAction.type = "consume-pending-round"`

### 2. Start one remediation round

Consume the oldest pending job:

```bash
npm run follow-up:consume
```

What this does:

- claims the oldest JSON file in `data/follow-up-jobs/pending/`
- moves it to `data/follow-up-jobs/in-progress/`
- increments `remediationPlan.currentRound`
- appends a round entry to `remediationPlan.rounds[]`
- prepares a workspace at `data/follow-up-jobs/workspaces/<jobId>/`
- checks out the existing PR branch there with `gh pr checkout`
- writes worker artifacts under `data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/`
- spawns a detached Codex remediation worker

Launch artifacts written into the job record include:

- `remediationWorker.processId`
- `remediationWorker.workspaceDir`
- `remediationWorker.promptPath`
- `remediationWorker.outputPath`
- `remediationWorker.logPath`
- `remediationWorker.replyPath`
- `remediationWorker.workspaceState`

Current worker authority and expectations:

- edit code in the checked-out PR branch
- run focused validation
- commit and push the PR branch
- write a machine-readable remediation reply JSON file
- do not open a new PR
- do not merge the PR

If launch preparation fails, the claimed job moves to:

```text
data/follow-up-jobs/failed/
```

### 3. Worker finishes and writes reply/output artifacts

The detached worker is expected to leave two important artifacts in the workspace:

- final message: `.adversarial-follow-up/codex-last-message.md`
- reply JSON: `.adversarial-follow-up/remediation-reply.json`

The final message is operator-facing completion text.

The reply JSON is the durable control-plane signal. It must use kind:

```text
adversarial-review-remediation-reply
```

and it is where re-review intent is expressed:

- `reReview.requested = true` means the worker is asking for another adversarial review pass
- if `reReview.requested = true`, `reReview.reason` is required

Prose alone is not enough to trigger another review pass.

### 4. Reconcile detached completion

Reconciliation is explicit and one-shot:

```bash
npm run follow-up:reconcile
```

What reconciliation inspects:

- only jobs in `data/follow-up-jobs/in-progress/`
- only jobs whose `remediationWorker.state` is `spawned`

Possible outcomes:

- worker PID still live: job stays `in_progress`
- worker PID gone and final message artifact missing or empty: job moves to `failed/`
- worker PID gone and final message artifact present:
  - if a valid reply requested re-review, job moves to `completed/`
  - if no durable re-review request was recorded, job moves to `stopped/`

Reconciliation never starts another remediation round on its own.

### 5. Re-review trigger

If the worker wrote a valid reply JSON with `reReview.requested = true`, reconciliation tries to reset the matching watcher row in `data/reviews.db` back to `review_status = 'pending'`.

That is the shipped re-review trigger. The queue does not directly post another review.

If the reset succeeds:

- the follow-up job ends in `completed/`
- `job.reReview.requested = true`
- `job.reReview.triggered = true`
- `job.reReview.status = "pending"`

Then the next watcher poll can pick that PR up for another adversarial review pass.

### 6. Bounded stop conditions

The loop is intentionally capped and explicit. A job moves to `data/follow-up-jobs/stopped/` when one of these durable stop conditions applies:

- `operator-stop`
- `no-progress`
- `max-rounds-reached`

`no-progress` means the latest remediation round finished without a durable re-review request. This is deliberate: the system stops instead of silently pretending forward progress exists.

`max-rounds-reached` means another round would exceed the stored `remediationPlan.maxRounds` cap.

## Operator Control Surface

### Inspect queue state

There is no dedicated list/status CLI yet. Inspect the queue directly:

```bash
find data/follow-up-jobs -maxdepth 2 -type f -name '*.json' | sort
```

For a specific job:

```bash
jq '.' data/follow-up-jobs/in-progress/<jobId>.json
```

The state directories are the queue:

- `pending/`: waiting for an operator to start a round
- `in-progress/`: claimed or spawned round
- `completed/`: worker finished and requested re-review; reconciliation recorded terminal success for that round
- `failed/`: launch or reconciliation failure
- `stopped/`: bounded-loop terminal stop
- `workspaces/`: per-job repo checkout and worker artifacts

### Start the next round

Only pending jobs can be consumed:

```bash
npm run follow-up:consume
```

If no work is pending, the command exits with a no-op message.

### Reconcile detached workers

Run:

```bash
npm run follow-up:reconcile
```

This is the normal way to convert spawned work into a durable terminal state.

### Request another bounded remediation round

Only `completed/` and `failed/` jobs are accepted:

```bash
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
```

Requeue behavior:

- moves the existing record back to `pending/`
- preserves round history in `remediationPlan.rounds[]`
- clears transient terminal fields like `completion`, `failure`, and `remediationWorker`
- sets `remediationPlan.nextAction.type = "consume-pending-round"`

Guardrails:

- if the current round count already hit `maxRounds`, requeue stops the job with `max-rounds-reached`
- if the source job is `completed/` but `reReview.requested` is not `true`, requeue stops the job with `no-progress`
- this is why there is no hidden infinite loop

### Stop a job

Accepted source states:

- `pending`
- `in_progress`
- `completed`
- `failed`

Command:

```bash
npm run follow-up:stop -- data/follow-up-jobs/in-progress/<jobId>.json "Operator requested stop"
```

Stop behavior:

- moves the job to `stopped/`
- records `remediationPlan.stop.code = "operator-stop"`
- records `remediationPlan.stop.reason`
- records `remediationPlan.stop.stoppedBy`

## Durable Metadata Operators Should Read

### In the follow-up job JSON

These fields are the primary audit trail:

- `status`
- `jobId`
- `repo`
- `prNumber`
- `reviewSummary`
- `reviewBody`
- `remediationPlan.currentRound`
- `remediationPlan.maxRounds`
- `remediationPlan.rounds[]`
- `remediationPlan.nextAction`
- `remediationPlan.stop`
- `remediationWorker`
- `remediationReply`
- `reReview`
- `completion`
- `failure`

Round-level records in `remediationPlan.rounds[]` are especially important. They preserve:

- when a round was claimed and spawned
- which worker metadata applied to that round
- completion, failure, or stop details for that round

### In the workspace

For a spawned or terminalized round, inspect:

```text
data/follow-up-jobs/workspaces/<jobId>/
data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/prompt.md
data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/codex-last-message.md
data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/remediation-reply.json
data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/codex-worker.log
```

What each tells you:

- `prompt.md`: exact worker contract and trusted metadata passed to the worker
- `codex-last-message.md`: worker’s final narrative summary, used as the completion artifact
- `remediation-reply.json`: machine-readable outcome and re-review intent
- `codex-worker.log`: launch/runtime stderr/stdout trail

### In SQLite

The watcher delivery ledger lives in:

```text
data/reviews.db
```

This is where reconciliation resets a PR back to `review_status = 'pending'` when a valid reply requests re-review.

Useful inspection query:

```bash
sqlite3 data/reviews.db "select id, repo, pr_number, reviewer, pr_state, review_status, review_attempts, last_attempted_at, posted_at, failed_at, failure_message, rereview_requested_at, rereview_reason from reviewed_prs where repo='laceyenterprises/adversarial-review' and pr_number=212;"
```

Interpretation:

- `review_status = 'pending'` means the watcher can pick the PR up again
- `review_status = 'posted'` means the previous review is terminal unless requeued by reconciliation or manual DB recovery
- `review_status = 'malformed'` is terminal by design for malformed-title cases

## Terminal States and What They Mean

### `completed`

Meaning:

- the detached remediation worker produced a non-empty final message artifact
- if a reply path was configured, the reply JSON validated
- the worker requested another adversarial review pass

Important nuance:

- `completed` here means successful completion of the remediation round plus durable re-review request handling
- it does **not** mean the PR is merged or finished

### `failed`

Meaning:

- the round did not produce a trustworthy terminal completion

Common failure codes:

- `worker-failure`
- `invalid-output-path`
- `artifact-missing-completion`
- `artifact-empty-completion`
- `invalid-remediation-reply`
- `manual-inspection-required`

`manual-inspection-required` is used when the recorded worker PID still appears live past the reconciliation runtime cap. The system does not trust PID-only liveness forever.

### `stopped`

Meaning:

- the bounded loop was ended intentionally or because it could not make durable progress

Stop codes:

- `operator-stop`
- `no-progress`
- `max-rounds-reached`

Read `remediationPlan.stop` first; that is the machine-readable explanation.

## No-Progress Semantics

This is the part operators should be explicit about with stakeholders:

- A remediation round can finish with useful code changes and still be considered `no-progress` by the bounded loop.
- That happens when no valid durable re-review request was recorded.
- In that case the system stops instead of assuming another round or another review should happen.

Current shipped behavior:

- reconciliation stops a finished round with `no-progress` when the worker did not request re-review durably
- requeue also stops a `completed/` job with `no-progress` if `reReview.requested` is not `true`

This is working as designed. It prevents silent loops and prose-only state transitions.

## Blocked Re-Review Cases

A worker can request re-review and still not get the watcher row reset.

Current explicit blocked cases include:

- malformed-title terminal watcher rows
- non-open PR rows

When that happens:

- the follow-up job still records the worker’s request
- `job.reReview.triggered = false`
- `job.reReview.status = "blocked"`
- `job.reReview.outcomeReason` explains why

The system does not bypass watcher terminal safeguards automatically.

## Manual Recovery

### When to use direct SQLite edits

Manual DB edits are a recovery path, not the normal operator flow.

Use them when:

- the reply artifact is missing
- the reply artifact is invalid
- watcher state intentionally blocked re-review and you have decided to override that state
- you need to recover from an older row that will not be reset by reconciliation

Safe procedure for an open PR:

```bash
sqlite3 data/reviews.db "select id,repo,pr_number,reviewer,pr_state,review_status,review_attempts,last_attempted_at,posted_at,failed_at,failure_message from reviewed_prs where repo='laceyenterprises/adversarial-review' and pr_number=212;"
sqlite3 data/reviews.db "BEGIN; UPDATE reviewed_prs SET review_status='pending', posted_at=NULL, failed_at=NULL, failure_message=NULL WHERE repo='laceyenterprises/adversarial-review' AND pr_number=212; COMMIT;"
```

Constraints:

- keep `reviewer` unchanged unless you intentionally want a different reviewer route
- keep `review_attempts` and `last_attempted_at` intact so history survives
- do not casually override malformed-title terminal rows

## Debugging Checklist

If an operator says “the loop is stuck”, check in this order:

1. Is the JSON file in `pending/`, `in-progress/`, `completed/`, `failed/`, or `stopped/`?
2. What does `remediationPlan.nextAction` say?
3. What does the latest `remediationPlan.rounds[]` entry say?
4. Does `remediationWorker.state` match the directory state?
5. Does the workspace contain `codex-last-message.md`?
6. Does the workspace contain a valid `remediation-reply.json`?
7. If re-review was requested, what does `job.reReview` say?
8. Does `data/reviews.db` show `review_status = 'pending'` for that PR?

Common interpretations:

- `in-progress` plus live PID: worker is still running or appears to be
- `in-progress` plus dead PID plus no artifacts: reconcile should fail the round
- `completed` plus `reReview.triggered = false`: worker asked for re-review but watcher state blocked it
- `stopped` plus `no-progress`: the round ended without a durable re-review request

## Related Context

- [README](../README.md)
- [SPEC](../SPEC.md)
- [SPEC-durable-first-pass-review-jobs](../SPEC-durable-first-pass-review-jobs.md)
- [docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md](./INCIDENT-2026-04-21-ACPX-codex-exec-regression.md)
