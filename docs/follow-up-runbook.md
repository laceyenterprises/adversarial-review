# Follow-Up Remediation Runbook

This runbook covers the shipped bounded remediation loop for adversarial-review after `LAC-206`, `LAC-209`, `LAC-210`, `LAC-211`, and the 2026-05-01 automation pass.

Use this when a review has already been posted to GitHub and you need to inspect, reconcile, stop, requeue, or debug the follow-up remediation flow without re-reading the implementation.

---

## Scope and current contract

- This is a **bounded loop** with operator override. It is not an unbounded autonomous retry daemon.
- The **watcher owns review posting**. Follow-up remediation does not post GitHub reviews directly.
- The remediation worker works on the **existing PR branch**, commits changes, and pushes that branch.
- The remediation worker does **not** open a new PR and does **not** merge the PR.
- Advancing from one remediation round to another runs **automatically** via the `ai.laceyenterprises.adversarial-follow-up` LaunchAgent (long-lived, internal 120s tick loop running entirely in a single node process). Each tick runs three steps in order: consume one pending job, reconcile any in-progress jobs whose worker has exited, retry pending PR comment deliveries (bounded by `RETRY_BUDGET_PER_TICK`). The daemon resolves 1Password / `gh` secrets once at startup; subsequent ticks reuse them in-process. The tick loop itself runs in-process (no `node` subprocess fork on every tick), so macOS TCC trust is granted once for the daemon's `node` binary and reused for the daemon's lifetime — eliminates the per-tick "node would like to access data from other apps" prompts that an earlier subprocess-per-tick design produced.
- Public PR comments are best-effort but durable: every reconcile-time post attempt is stamped into the terminal job JSON under `commentDelivery`. A failed post (timeout, gh outage, missing token) is retried on subsequent ticks up to `MAX_COMMENT_DELIVERY_ATTEMPTS = 5`. The terminal JSON is the source of truth, not the PR comment.
- Public PR comments are **idempotent**. Each comment body embeds an HTML-comment marker keyed by `(jobId, round, action)` (prefix `adversarial-review-remediation-marker:`). Before posting, the poster runs a bounded `gh api` lookup on the PR's existing comments and skips the create if a previous attempt already landed on GitHub even though the local CLI saw a timeout. Lookup failures fall through to posting (best-effort: a duplicate is preferable to silent loss).
- The retry path reads from a dedicated index, not the full terminal history. `data/follow-up-jobs/delivery-retry-index/` holds one pointer file per outstanding `posted=false` delivery; pointers are added on failure and removed on success. The first tick after upgrade walks the existing terminal history once to seed the index (sentinel: `.initialized`), then steady-state ticks read only the index — bounded by retry backlog size, not history size.
- A new adversarial review pass only happens when the worker writes a **durable machine-readable rereview request** (`reReview.requested = true` in `remediation-reply.json`).
- Bounding: `DEFAULT_MAX_REMEDIATION_ROUNDS = 6` in `src/follow-up-jobs.mjs`. `requestReviewRereview` in `src/review-state.mjs` does **not** implement a cooldown — it refuses the reset only on hard guardrails (review row missing, malformed-title terminal, PR not open, already pending). The round cap is the only re-arm bound. (An earlier doc claim about a per-PR rereview cooldown was inaccurate.)
- Reviewer-bot tokens (`GH_CLAUDE_REVIEWER_TOKEN`, `GH_CODEX_REVIEWER_TOKEN`) are best-effort: a missing token at startup is logged as a warning, the daemon still runs consume/reconcile, and the comment poster records `token-env-missing` for later retry once the token is restored. A 1Password outage at boot does not block remediation.

Operator levers (still available, override the daemon):

```bash
npm run follow-up:consume                         # claim + spawn one job (manual tick)
npm run follow-up:reconcile                       # reconcile in-progress jobs (manual tick)
npm run follow-up:requeue -- <job-path> [reason]  # re-arm a completed job
npm run follow-up:stop -- <job-path> [reason]     # stop an in-progress job
npm run retrigger-review -- --repo <slug> --pr <n> --reason "<why>"  # force a re-review pass
```

To pause the daemon during an outage:

```bash
launchctl bootout gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

To resume (the install layout deploys the plist with the `.placey` suffix dropped — see README "Install LaunchAgents" — so resume uses the deployed filename, NOT the per-user template name from `launchd/`):

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl kickstart gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

Daemon log: `~/Library/Logs/adversarial-follow-up.log`.

---

## Mental model

There are two separate state machines here:

1. **Watcher delivery state** in SQLite (`data/reviews.db`)
2. **Follow-up remediation queue state** in JSON files (`data/follow-up-jobs/*`)

They interact, but they are not the same thing.

- SQLite answers: *has this PR been reviewed / can it be reviewed again?*
- Follow-up jobs answer: *what remediation round is happening around this already-posted review?*

A lot of operator confusion comes from mixing those two ledgers together.

---

## End-to-end architecture

```text
GitHub PR
  │
  ▼
watcher.mjs
  │ validate title tag + choose route
  ▼
reviewer.mjs
  │ fetch diff, run adversarial review, post review
  ▼
create follow-up job JSON
  │
  ▼
data/follow-up-jobs/pending/<jobId>.json
  │
  ├─(operator) npm run follow-up:consume
  ▼
data/follow-up-jobs/in-progress/<jobId>.json
  │
  ▼
detached remediation worker on checked-out PR branch
  │ writes artifacts
  ├─ codex-last-message.md
  └─ remediation-reply.json
  │
  ├─(operator) npm run follow-up:reconcile
  ▼
terminal queue state
  ├─ completed/   -> valid rereview request recorded
  ├─ failed/      -> launch/reconcile/artifact failure
  └─ stopped/     -> bounded stop (no-progress, operator-stop, max-rounds-reached)
  │
  └─ if rereview requested:
       requestReviewRereview(...)
       -> reviews.db row reset to review_status='pending'
       -> watcher may pick the PR up again
```

---

## State transition diagram

### Follow-up queue transitions

```text
pending
  │
  ├─ follow-up:consume
  ▼
in-progress
  │
  ├─ worker still alive during reconcile
  │    └─ stays in-progress
  │
  ├─ launch preparation fails
  │    └─ failed
  │
  ├─ worker exits, final artifact missing/invalid
  │    └─ failed
  │
  ├─ worker exits, valid reply, rereview requested=true
  │    └─ completed
  │
  ├─ worker exits, no durable rereview request
  │    └─ stopped (code=no-progress)
  │
  └─ operator stop
       └─ stopped (code=operator-stop)

completed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ if maxRounds already reached
       └─ stopped (code=max-rounds-reached)

failed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ if maxRounds already reached
       └─ stopped (code=max-rounds-reached)
```

### Watcher delivery state transitions

```text
new tagged PR
  │
  ├─ malformed title
  │    └─ malformed   (terminal by design)
  │
  └─ valid tagged PR
       └─ pending
            │
            ├─ successful review post
            │    └─ posted
            │
            ├─ review attempt fails
            │    └─ failed
            │
            └─ remediation rereview request accepted
                 └─ pending   (re-armed for another watcher pass)
```

### Important consequence

A follow-up job can be `completed` while the PR is still far from done.

Here, `completed` means:

- the remediation round finished cleanly
- a durable rereview request was accepted
- the queue round reached terminal success

It does **not** mean the PR is merged, approved, or production-ready.

---

## Lifecycle in detail

### 1. Review pickup and follow-up job creation

When the watcher successfully posts an adversarial review comment, it writes a durable JSON job under:

```text
data/follow-up-jobs/pending/
```

That job includes:

- PR identity: `repo`, `prNumber`, `linearTicketId`, `reviewerModel`
- review context: `reviewSummary`, `reviewBody`, `critical`
- bounded-loop state: `remediationPlan.mode`, `maxRounds`, `currentRound`, `rounds[]`
- reply contract state: `remediationReply.state`
- future-session placeholder metadata: `sessionHandoff`

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
- commit the remediation changes and push the PR branch
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

---

## Operator control surface

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
- `delivery-retry-index/`: pointer files for terminal jobs whose PR-comment delivery still owes a retry (`<jobId>.json` → `{ "jobPath": "..." }`). The retry tick reads only this directory; pointers are added on delivery failure and removed on success or terminal cap. Operators should not edit these by hand — to clear a stuck pointer, fix the underlying `commentDelivery.posted` state on the terminal record (or delete the record entirely if recovery is hopeless), and the next tick will prune the dangling pointer automatically.

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

---

## Durable metadata operators should read

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

---

## Terminal states and what they mean

### `completed`

Meaning:

- the detached remediation worker produced a non-empty final message artifact
- if a reply path was configured, the reply JSON validated
- the worker requested another adversarial review pass
- the rereview reset was accepted by the watcher delivery ledger

Important nuance:

- `completed` here means successful completion of the remediation round plus durable re-review request handling
- it does **not** mean the PR is merged or finished

### `failed`

Meaning:

- launch preparation failed, or
- worker output artifact was missing/empty/invalid, or
- rereview handling failed in a way the reconciler treats as failure

This is an operator investigation state, not an automatic retry signal.

### `stopped`

Meaning:

- the loop intentionally terminated without arming another review round

Common reasons:

- `operator-stop`
- `no-progress`
- `max-rounds-reached`

`stopped` is often healthy. It frequently means the worker did not make a durable rereview request, so the control plane refused to guess.

---

## Maintenance and debugging tips

### 1. Check the durable artifact before debugging control flow

If a rereview didn’t happen, first inspect:

```bash
jq '.' data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/remediation-reply.json
```

The most common root cause is simply that `reReview.requested` was absent or false.

### 2. Reconcile is not automatic

A worker can finish successfully and the queue can still appear stuck in `in-progress/` if nobody ran:

```bash
npm run follow-up:reconcile
```

This is normal and by design.

### 3. Don’t confuse `completed` with “PR done”

Queue success means the remediation round closed successfully.
It says nothing by itself about merge readiness.

### 4. Malformed-title rows are intentionally sticky

If a PR hit malformed-title guardrails, don’t assume retitling later will restore the happy path.
The safer recovery remains: create a fresh, correctly tagged PR.

### 5. Use the workspace as the forensic record

Before guessing, inspect:

- worker prompt
- final message artifact
- reply artifact
- worker log
- round history in the job JSON

Usually the answer is already there.

### 6. Max rounds is a safety rail, not a suggestion

Default max rounds is 6.
If the loop hits that cap, the correct action is usually human review of strategy, not blind extension.

### 7. Be careful with manual DB resets

Resetting `review_status='pending'` is powerful.
Use it for recovery, not to paper over malformed titles or to bypass queue semantics without understanding the consequences.

### 8. Cross-user auth/permission drift is a real failure mode

If workers or reviewers suddenly start failing after runtime/user changes, verify:

- CLI paths still exist
- Codex OAuth auth file is readable
- cross-user permissions still allow the active runtime to read required artifacts
- queue/workspace directories are writable by the runtime user

---

## Common operator playbooks

### A. “A remediation worker finished. Why didn’t we get another review?”

1. run `npm run follow-up:reconcile`
2. inspect `remediation-reply.json`
3. verify `reReview.requested = true`
4. inspect `data/reviews.db` row for the PR
5. confirm the PR is still `pr_state='open'`

### B. “The queue says completed, but nothing has happened yet.”

Likely meaning:

- the remediation round successfully requested rereview
- the DB row was reset to `pending`
- the watcher has not polled / processed the PR again yet

Check watcher logs and `reviews.db`.

### C. “I want one more bounded remediation round.”

Use:

```bash
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
```

Then consume it explicitly.

### D. “I want this to stop right now.”

Use:

```bash
npm run follow-up:stop -- data/follow-up-jobs/in-progress/<jobId>.json "Operator requested stop"
```

### E. “Something feels inconsistent.”

Inspect in this order:

1. queue JSON file
2. workspace artifacts
3. SQLite review row
4. watcher logs
5. worker log

---

## Canonical files to read before code changes

- `src/follow-up-jobs.mjs`
- `src/follow-up-remediation.mjs`
- `src/follow-up-reconcile.mjs`
- `src/follow-up-requeue.mjs`
- `src/follow-up-stop.mjs`
- `src/review-state.mjs`
- `src/watcher.mjs`

---

## Bottom line

The system is intentionally conservative.

- review posting is owned by the watcher path
- remediation is owned by the follow-up queue path
- rereview is armed only by durable JSON metadata
- explicit operator actions keep the loop bounded and debuggable

That conservatism is the feature. It keeps the service from silently spinning or fabricating progress.
