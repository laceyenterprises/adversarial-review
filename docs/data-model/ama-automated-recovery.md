# Data Model - AMA Automated Recovery

## Actions infrastructure (CIBLOCKINFRA-01)

The shared decision's CI observer, backed by `isInfrastructureStop` and
recorded failed-check evidence, does not increment `attempts`, start a
stall timer or arm an exhaustion event during an Actions infrastructure block.

On successful current-head replacements, a historical automated stop clears
only if the audited stop series is entirely infrastructure-only and its unique
launch count equals this recovery receipt's charged attempts. Unknown or mixed
history retains the cap/event. `ciInfrastructureRecovery` records
`reason: checks-executed-again`, `stopKey`, `refundedAt`, the previous
`attempts` and previous `event`. Recovery is idempotent per stop key;
existing page receipts are retained. Ordinary merge and dispatch gates still
apply after recovery.


**Owner:** AMA watcher recovery router
**Store:** `data/follow-up-jobs/ama-automated-recovery/`
**Source of truth:** `src/ama/automated-recovery.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose and files

Recovery projects `nextAction(snapshot)` and retains its action, actor, reason,
head, anchored deadline, decision key and queue intent. A reviewer/hammer dispatch
uses the existing request reservation or capped closer. Other actions retain
their owner; automatic stops and unreadable evidence remain recovery workflows.
Only explicit hold/draft/disabled intent selects the operator. Reason text is
not an eligibility registry. Every execution retains the existing content,
identity, HCP, CI, protection, arming and lease restrictions.

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
| `rereviewRequested` | boolean | A re-review request has been accepted on this head. The existing pending-request reservation prevents duplicate queueing. |
| `rereviewPending` | optional boolean | The accepted request still owns the review row. Cleared after a new posting is observed. |
| `rereviewBaseline` | optional string | Prior `posted_at`, otherwise reviewer session UUID, otherwise `unobserved`; prevents a stale posted snapshot from racing the requested pass. |
| `rereviewRequestedAt` | optional number | Request timestamp in epoch milliseconds. |
| `blockedSince` | optional number | First continuously non-progressing observation in epoch milliseconds. Cleared by a confirmed action, an ordinary ownership/time wait, or an operator hold. |
| `mergeabilityUnknownCycles` | optional number | Historical counter, preserved when reading old state; no longer selects eligibility. |
| `mergeabilityUnknownSince` | optional number | Historical UNKNOWN clock, preserved without controlling successor selection. |
| `lastReason` | optional string | Latest charged action, non-progressing refusal, or settled UNKNOWN reason. |
| `paged` | boolean | At least one page delivery/enqueue returned successfully; retained for legacy compatibility. Deduplication uses `pagedReasons`. |
| `pagedReasons` | string array | Exhaustion `event.reason` values successfully paged on this head. Each event reason pages once. Legacy state without this field seeds it from `event.reason` when `paged` is true; a paged legacy state with no event seeds `background-pr-mergeable-unknown`, the only event that could have been cleared. Unpaged legacy state starts with an empty array. Migration is persisted with the next state mutation. |
| `pageError` | optional string | Most recent enqueue error; retained as diagnostic history even if a later enqueue succeeds. |
| `event` | optional object | Exhaustion evidence: `event` (`ama.automated_recovery.exhausted`), `severity` (`SEV1`), `reason`, `reasons` (string array), `repo`, `pr`, `head`, and `attempts`. Persisted before logging or page delivery. Sticky diagnostic evidence; remaining physical action budget is evaluated independently. |
| `firstActionableAt` | optional UTC string | Durable first actionable anchor for this recovery head. |
| `nextAction` | optional object | Latest shared action/actor/reason/head/deadline/key/queue projection. Old files without it remain readable. |

Returned recovery objects may additionally include `action`, a re-review
result, or other tick diagnostics. These return-only fields are not stored.

## Budget and exhaustion

The watcher passes `amaRetainLoopCapFor(dispatchJob.remediationPlan.maxRounds)`
as the action cap; absent a job budget, the shared convergence default applies.
The cap prevents further recovery actions. A refusal or exhausted action cap
must persist for `stuckDeadlineMs` (default 30 minutes) before paging. Poll
frequency alone cannot exhaust the head. The closer's own dispatch bounds still
apply independently.

Owned workflows and deferred dispatch retain their shared deadlines without
consuming attempts. Unknown/read/automatic-stop recovery retains the stall
clock for reporting; deadline expiry never grants dispatch authority or removes
remaining physical budget. Historical UNKNOWN counters no longer implement a
second recovery policy. Aborts and coexistence timeouts propagate without charge.

A requested re-review in `pending`, `reviewing`, or `pending-upstream` remains
owned even beyond `rereviewDeadlineMs`; reviewer queue/stall monitoring owns that
latency. An unchanged posted snapshot with no active review status expires after
that deadline (default 30 minutes). A new posting releases the recovery wait.

Exhaustion writes and logs the sticky event, then requests one SEV1 page per
head and exhaustion reason. A failed page enqueue adds no receipt to
`pagedReasons` and retries on later exhausted ticks, even if a different reason
was previously paged. The page text and payload use the persisted event reason. An
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

Launch reconciliation is scoped to the same repository, PR and head. A changed
receipt is observed; a later immutable generation decides its successor. Neither
reason text nor reconciliation itself grants merge or dispatch permission.
