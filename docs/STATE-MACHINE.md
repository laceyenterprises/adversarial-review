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
| `posted` | review posted successfully |
| `failed` | review attempt failed |
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
            ├─ successful review post
            │    └─ posted
            │
            ├─ review attempt failure
            │    └─ failed
            │
            └─ accepted rereview request from follow-up reconciliation
                 └─ pending
```

### Notes

- `malformed` is intentionally sticky.
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
  ├─ reconcile sees missing/invalid artifacts
  │    └─ failed
  │
  ├─ reconcile sees valid rereview request
  │    └─ completed
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

---

## Failure/stop codes worth remembering

### Queue stop reasons

| Code | Meaning |
|---|---|
| `operator-stop` | human explicitly stopped the job |
| `no-progress` | worker did not leave a durable rereview request |
| `max-rounds-reached` | bounded loop cap hit |

### Common failure classes

| Class | Typical cause |
|---|---|
| launch failure | checkout/auth/workspace prep problem |
| artifact failure | missing `codex-last-message.md` or invalid `remediation-reply.json` |
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
ls -la data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/
jq '.' data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/remediation-reply.json
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
