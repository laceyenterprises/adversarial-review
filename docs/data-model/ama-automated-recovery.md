# Data Model - AMA Automated Recovery

**Owner:** AMA watcher recovery router
**Store:** `data/follow-up-jobs/ama-automated-recovery/`
**Source of truth:** `src/ama/automated-recovery.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose and files

Recovery retains AMA ownership while requesting a current-head re-review or
retrying the ordinary capped hammer. It grants no merge authority and does not
waive the closer's safety, identity, CI, grace, or lease gates.

The directory is relative to the caller's `rootDir`. The key is the lowercase
hex SHA-256 of the UTF-8 string `${repo}#${prNumber}@${headSha || 'unknown'}`.
Repository spelling is used verbatim, including case. Each key has:

| File | Contract |
|---|---|
| `<key>.json` | Per-head recovery state, replaced atomically while holding the lock. Created on the first state mutation; an ordinary wait may leave only a lock file. |
| `<key>.lock` | Permanent stable inode opened in append mode with creation mode `0600`. Nonblocking exclusive kernel flock serializes recovery actions and page enqueue across processes. Contention returns `ama-pending` without mutation. Closing the descriptor or process death releases the flock; the file is never unlinked. |

This store has no schema-version field. Malformed JSON and read errors other
than a missing file fail the caller rather than silently resetting its budget.

## State fields

| Field | Shape | Contract |
|---|---|---|
| `repo`, `pr`, `head` | string, number, string or null | Caller-supplied repository, PR number, and exact head. |
| `attempts` | number | Confirmed recovery hammer dispatches, triggered re-review requests, and non-cancellation action errors. Ordinary refusals, existing pending requests, and ownership waits consume no attempt. |
| `rereviewRequested` | boolean | A re-review request has been accepted on this head. Unknown findings request only one accepted recovery pass per head. |
| `rereviewPending` | optional boolean | The accepted request still owns the review row. Cleared after a new posting is observed. |
| `rereviewBaseline` | optional string | Prior `posted_at`, otherwise reviewer session UUID, otherwise `unobserved`; prevents a stale posted snapshot from racing the requested pass. |
| `rereviewRequestedAt` | optional number | Request timestamp in epoch milliseconds. |
| `blockedSince` | optional number | First continuously non-progressing observation in epoch milliseconds. Cleared by a confirmed action, an ordinary ownership/time wait, or an operator hold. |
| `lastReason` | optional string | Latest charged action or non-progressing refusal reason. |
| `paged` | boolean | Page delivery/enqueue returned successfully. Prevents another enqueue for this head. |
| `pageError` | optional string | Most recent enqueue error; retained as diagnostic history even if a later enqueue succeeds. |
| `event` | optional object | Sticky exhaustion evidence: `event` (`ama.automated_recovery.exhausted`), `severity` (`SEV1`), `reason`, `reasons` (string array), `repo`, `pr`, `head`, and `attempts`. Persisted before logging or page delivery. |

Returned recovery objects may additionally include `action`, a re-review
result, or other tick diagnostics. These return-only fields are not stored.

## Budget and exhaustion

The watcher passes `amaRetainLoopCapFor(dispatchJob.remediationPlan.maxRounds)`
as the action cap; absent a job budget, the shared convergence default applies.
The cap prevents further recovery actions. A refusal or exhausted action cap
must persist for `stuckDeadlineMs` (default 30 minutes) before paging. Poll
frequency alone cannot exhaust the head. The closer's own dispatch bounds still
apply independently.

Live hammers, follow-up jobs, background launches, leases, uncertain dispatch
status, daemon lease contention, comment-only grace, and proven final-round
pending-CI waits retain ownership without consuming attempts or paging. Safety
and explicit configuration/operator holds return `await-operator`, without a
recovery page. Aborts and coexistence operation timeouts propagate to the caller
without charging an action.

A requested re-review in `pending`, `reviewing`, or `pending-upstream` remains
owned even beyond `rereviewDeadlineMs`; reviewer queue/stall monitoring owns that
latency. An unchanged posted snapshot with no active review status expires after
that deadline (default 30 minutes). A new posting releases the recovery wait.

Exhaustion writes and logs the sticky event, then requests one SEV1 page. A failed
page enqueue preserves `paged: false` and retries on later exhausted ticks. An
ordinary ownership wait or operator hold suppresses redrive/page delivery even
if the head already has exhaustion evidence. A new head has a separate key and
fresh budget.

## Retention and reset

There is no automatic pruning: closed/merged PRs and superseded heads leave
state and lock files indefinitely. Lock files must remain at their stable inode
while any watcher can be using them; removing a live lock can admit two owners.

To reset an exhausted head, first stop every watcher/recovery process sharing
this runtime root, inspect the PR and resolve the recorded cause, then archive
and remove only its `<key>.json`. Keep `<key>.lock`. Restart the watchers; the
next tick initializes fresh recovery state, while the ordinary closer leases,
hammer caps, and review-state CAS continue to apply. Do not edit or remove state
concurrently with a watcher, and do not reset the independent closer caps as a
side effect of this procedure.
