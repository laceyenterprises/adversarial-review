# Adversarial Review State Machine Notes

Quick reference for the two durable state machines in this module.

Use this when you want the control-plane picture without the full runbook.

---

## The important distinction

There are **two different ledgers**:

1. **Watcher delivery state** in SQLite: `data/reviews.db`
2. **Follow-up remediation queue state** in JSON files: `data/follow-up-jobs/*`

They interact, but they are not interchangeable.

- SQLite answers: **can this PR be reviewed / re-reviewed?**
- Queue files answer: **what remediation round is happening around the posted review?**

---

## End-to-end flow

```text
GitHub PR
  │
  ▼
watcher.mjs
  │ title validation + route selection
  ▼
reviewer.mjs
  │ review post succeeds
  ▼
reviews.db row -> posted
  │
  └─ create follow-up job -> data/follow-up-jobs/pending/<jobId>.json
                                │
                                ├─ follow-up:consume
                                ▼
                           in-progress
                                │
                                ├─ detached remediation worker runs
                                │
                                ├─ follow-up:reconcile
                                ▼
                           completed / failed / stopped
                                │
                                └─ if reply JSON says rereview requested=true:
                                     reviews.db row -> pending
                                     watcher can review again
```

---

## 1) Watcher delivery state machine

Source of truth:

```text
data/reviews.db
```

### Main statuses

| review_status | Meaning |
|---|---|
| `pending` | eligible for watcher review / re-review |
| `reviewing` | reviewer subprocess in flight; durable claim before spawn |
| `posted` | review posted successfully |
| `failed` | review attempt failed (auto-retried by next poll) |
| `failed-orphan` | watcher restarted while a `reviewing` row was in flight and safe automatic recovery could not be proven — sticky, requires operator verification + `npm run retrigger-review` |
| `malformed` | title guardrail failure; terminal by design |

### Transitions

```text
new PR
  │
  ├─ malformed title
  │    └─ malformed
  │
  └─ valid tagged PR
       └─ pending
            │
            ├─ stmtMarkAttemptStarted (just before spawnReviewer)
            ▼
       reviewing
            │
            ├─ reviewer subprocess returns ok
            │    └─ posted
            │
            ├─ reviewer subprocess fails
            │    └─ failed
            │
            ├─ watcher restart while reviewing
            │    ├─ confirmed dead + no late review after bounded overdue recovery
            │    │    └─ failed
            │    └─ otherwise
            │         └─ failed-orphan   (sticky, operator-only recovery)
            │
            └─ accepted rereview request from follow-up reconciliation
                 └─ pending
```

### Notes

- `malformed` is intentionally sticky.
- `failed-orphan` is intentionally sticky. It covers any restart-era session where the watcher cannot prove a safe handoff back to automation, including missing launch-time timeout metadata on legacy rows, a live PGID that survives the bounded SIGTERM/SIGKILL recovery loop, or a late GitHub review that appears during recovery. Recovery is operator-only:
  1. Inspect the GitHub PR. If a review was already posted by the reviewer bot, leave the row alone (the round is effectively done).
  2. If no orphan review is present, run `npm run retrigger-review --repo <slug> --pr <n> --reason "verified no orphan review"`. The reset clears the sticky state and re-arms `pending`.
- Steady-state recovery does not touch a newly claimed row merely because `reviewer_started_at` is still empty. Until the authoritative spawn callback persists `reviewer_started_at` and `reviewer_pgid`, `last_attempted_at + reviewer_timeout_ms` is the temporary guard window; only after that window expires may the row be reconciled as missing spawn metadata.
- Overdue orphan auto-retry is deliberately narrow. The watcher only attempts it when the row persisted the original launch timeout and an authoritative reviewer spawn timestamp, the orphan age exceeds that persisted timeout from the actual subprocess start, the process group is confirmed dead after the bounded recovery loop, and GitHub is reprobed over a short delayed window with no late review found. That same steady-state recovery path also settles the runtime reviewer run-state ledger before the SQLite row flips terminal. Any ambiguity falls back to sticky `failed-orphan` instead of launching a second reviewer.
- Re-review does **not** happen because of prose. It happens because reconciliation resets the row to `pending`.
- A PR can move from `posted` back to `pending` only via explicit recovery logic or a valid rereview request.

---

## 2) Follow-up remediation queue state machine

Source of truth:

```text
data/follow-up-jobs/
  pending/
  in-progress/
  completed/
  failed/
  stopped/
```

Directory = state.

### Main states

| Queue state | Meaning |
|---|---|
| `pending` | waiting for operator to consume |
| `in-progress` | claimed/spawned round exists |
| `completed` | round finished and rereview request was accepted |
| `failed` | launch/reconcile/artifact failure |
| `stopped` | bounded terminal stop |

### Transitions

```text
pending
  │
  ├─ follow-up:consume
  ▼
in-progress
  │
  ├─ worker still running during reconcile
  │    └─ in-progress
  │
  ├─ launch failure
  │    └─ failed
  │
  ├─ legacy job base branch cannot be proven
  │    └─ failed (base-branch-resolution-failed)
  │
  ├─ reconcile sees missing/invalid artifacts
  │    └─ failed
  │
  ├─ reconcile sees valid rereview request and contamination audit passes
  │    └─ completed
  │
  ├─ reconcile sees valid rereview request but contamination audit fails
  │    └─ failed (branch-contamination)
  │
  ├─ reconcile cannot complete contamination audit (fetch/cherry error)
  │    └─ failed (branch-contamination-audit-error)
  │
  ├─ reconcile sees no durable rereview request
  │    └─ stopped (no-progress)
  │
  └─ operator stop
       └─ stopped (operator-stop)

completed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ max rounds guardrail trips
       └─ stopped (max-rounds-reached)

failed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ max rounds guardrail trips
       └─ stopped (max-rounds-reached)
```

### Important nuance

`completed` does **not** mean:

- PR merged
- code approved
- work finished

It means:

- this remediation round ended successfully
- the rereview request was durable and accepted
- the watcher can pick the PR up again

---

## Rereview contract

The only normal rereview trigger is the remediation reply artifact:

```json
{
  "reReview": {
    "requested": true,
    "reason": "..."
  }
}
```

If that durable flag is absent or false:

- the queue does **not** fabricate another pass
- the job stops with `code = "no-progress"`

That conservatism is intentional.

If the flag is true, reconcile still runs the branch-contamination gate before resetting `reviews.db` back to `pending`. A contaminated branch does **not** produce a synthetic stop; it moves to durable `failed/` with `failure.code = "branch-contamination"` so operators have an audit trail and a retryable terminal record after they clean the branch.

Legacy durable jobs created before `baseBranch` was persisted are hydrated from GitHub before any worker prompt or reconcile audit uses the branch. If GitHub cannot prove the real PR base, the job fails with `base-branch-resolution-failed` rather than rebasing or auditing against `main` by default.

---

## 3) Fast-merge skip lane

Source of truth:

```text
data/reviews.db.reviewed_prs
```

Fast-merge is a watcher-owned bypass lane for narrowly allowlisted PR labels.
It is gated by `FML_WATCHER_SKIP_ENABLED=true`; when the flag is false, the
watcher records audit-only `would-have-skipped` entries and still runs normal
first-pass adversarial review.

### Additional watcher states

| Field | Value | Meaning |
|---|---|---|
| `pr_state` | `fast_merge_skipped` | watcher deliberately skipped first-pass review for an authorized head |
| `pr_state` | `fast_merge_merged` | merge-agent merged the authorized fast-merge head |
| `pr_state` | `fast_merge_closed` | PR closed without merging after entering the fast-merge lane |
| `pr_state` | `fast_merge_blocked` | merge-agent or watcher refused to complete the fast-merge lane |
| `review_status` | `fast_merge_skipped` | first-pass review was intentionally bypassed for the stored authorized head |
| `fast_merge_audit_status` | `pending` | a fast-merge state transition happened but its audit JSON still needs retry |
| `fast_merge_audit_status` | `written` | the audit JSON for the latest fast-merge transition was persisted |

### Authorization rule

The label alone is never the authority. The watcher may set
`fast_merge_authorized_head_sha` only when all of the following are true:

- A current allowlisted `fast-merge:*` label is present and `fast-merge-veto` is absent.
- The current PR head SHA can be fetched successfully.
- The issue timeline both records the authorizing label and corroborates the
  authorized head SHA by pairing the most recent allowlisted-operator label
  event with the live PR head from `pulls.get`.
- The changed-file list matches the allowlisted category shape. For example,
  `fast-merge:docs` is limited to documentation file extensions,
  `fast-merge:submodule-bump` is limited to known gitlink paths, and
  `fast-merge:spec-hash-rebind` only allows a tiny spec-lock/spec-hash rebind.
- Any commit, force-push, or head-restore event at or after the label
  invalidates the authorization.

If that proof is missing, the watcher fails closed to the normal review path.
When the fast-merge label is later removed, or `fast-merge-veto` appears, the
watcher resets the row back to normal first-pass review and records the recovery
transition in the fast-merge audit stream. Recovery scans are bounded per tick
to keep skipped-row cleanup from monopolizing the watcher.

`reviewed_at` stores when the watcher processed the skip. The label application
time remains in the audit entry as `authorized_at`; do not use `reviewed_at` as
the operator-label timestamp.

### Merge-agent contract

`fast_merge_authorized_head_sha` is the commit the operator effectively approved
for the bypass lane. The follow-up daemon now actively consumes
`fast_merge_skipped` rows and closes them through the fast-merge path:

- it re-checks the live PR head and `fast-merge-veto` label,
- summarizes `gh pr checks` output for pending/failed/successful CI,
- merges with `gh pr merge --squash --admin --delete-branch --match-head-commit <authorizedHeadSha>`,
- records `fast_merge_merged`, `fast_merge_closed`, or `fast_merge_blocked`,
- and requeues normal first-pass review when the head changed or veto appeared.

Before recording `fast_merge_blocked` on a merge error, the daemon must re-fetch
PR state; if GitHub already shows the PR merged, the durable state becomes
`fast_merge_merged` instead so partial merge success cannot be misreported as a
blocked refusal.

---

## Failure/stop codes worth remembering

### Queue stop reasons

| Code | Meaning |
|---|---|
| `operator-stop` | human explicitly stopped the job |
| `no-progress` | worker did not leave a durable rereview request |
| `max-rounds-reached` | bounded loop cap hit |
| `stale-review-head` | consume-time stale-job guard: the PR head moved before this worker spawned |

### Common failure classes

| Class | Typical cause |
|---|---|
| launch failure | checkout/auth/workspace prep problem |
| base-branch-resolution-failed | legacy job is missing `baseBranch` and GitHub could not prove the real PR base |
| artifact failure | missing `codex-last-message.md` or invalid `remediation-reply.json` |
| branch-contamination | rereview audit found patch-equivalent commits already on `origin/<baseBranch>` |
| review failure | reviewer auth/path/token/runtime issue |
| malformed title | PR missing required creation-time tag |

---

## Operator quick checks

### Queue view

```bash
find data/follow-up-jobs -maxdepth 2 -type f -name '*.json' | sort
jq '.' data/follow-up-jobs/in-progress/<jobId>.json
```

### Workspace artifacts

```bash
ls -la "$HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/.adversarial-follow-up/"
jq '.' "$HQ_ROOT/dispatch/remediation-replies/<storage-key>/remediation-reply.json"
```

### Watcher row

```bash
sqlite3 data/reviews.db "select repo,pr_number,review_status,pr_state,review_attempts,posted_at,failed_at,rereview_requested_at,rereview_reason from reviewed_prs order by id desc limit 20;"
```

---

## If something looks weird

Check in this order:

1. queue JSON
2. workspace artifacts
3. SQLite row
4. watcher logs
5. worker log

That order usually gets you to the truth fastest.
