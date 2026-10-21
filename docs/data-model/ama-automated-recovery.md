# Data Model - AMA Automated Recovery

**Owner:** AMA watcher recovery router
**Store:** `data/follow-up-jobs/ama-automated-recovery/`
**Source of truth:** `src/ama/automated-recovery.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose and files

Recovery retains AMA ownership while requesting a current-head re-review or
retrying the ordinary capped hammer. It grants no merge authority and does not
waive the closer's safety, identity, CI, grace, or lease gates.

HAMNOREREVIEW-01 binds recognized hammer ownership to the current head through
`result.ownerProofFacts.headSha` and `liveHeadCloserAuthored`. That head retries
the ordinary capped hammer instead of requesting review for stale or unknown
finding evidence. Older-head ownership cannot select this route, and safety
holds and every merge predicate remain in force.

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
| `mergeabilityUnknownCycles` | optional number | Settled `background-pr-mergeable-unknown` observations on this head. Each increments once, without spending `attempts`. A resolved different blocker resets it to zero; neutral observations preserve it. Missing legacy values start at zero. |
| `mergeabilityUnknownSince` | optional number | Epoch milliseconds of the first settled UNKNOWN in the current series; supplies the `stuckDeadlineMs` time floor. Neutral observations preserve it; a resolved different blocker deletes it. Legacy series without this field start the clock at the next UNKNOWN observation. |
| `lastReason` | optional string | Latest charged action, non-progressing refusal, or settled UNKNOWN reason. |
| `paged` | boolean | At least one page delivery/enqueue returned successfully; retained for legacy compatibility. Deduplication uses `pagedReasons`. |
| `pagedReasons` | string array | Exhaustion `event.reason` values successfully paged on this head. Each reason pages once; a different reason can page after UNKNOWN resolves. Legacy state without this field seeds it from `event.reason` when `paged` is true; a paged legacy state with no event seeds `background-pr-mergeable-unknown`, the only event that could have been cleared. Unpaged legacy state starts with an empty array. Migration precedes event clearing and is persisted with the next state mutation. |
| `pageError` | optional string | Most recent enqueue error; retained as diagnostic history even if a later enqueue succeeds. |
| `event` | optional object | Exhaustion evidence: `event` (`ama.automated_recovery.exhausted`), `severity` (`SEV1`), `reason`, `reasons` (string array), `repo`, `pr`, `head`, and `attempts`. Persisted before logging or page delivery. Sticky except an UNKNOWN-origin event is cleared on a resolved different blocker; per-reason page receipts survive clearing. |

Returned recovery objects may additionally include `action`, a re-review
result, or other tick diagnostics. These return-only fields are not stored.

## Budget and exhaustion

The watcher passes `amaRetainLoopCapFor(dispatchJob.remediationPlan.maxRounds)`
as the action cap; absent a job budget, the shared convergence default applies.
The cap prevents further recovery actions. A refusal or exhausted action cap
must persist for `stuckDeadlineMs` (default 30 minutes) before paging. Poll
frequency alone cannot exhaust the head. The closer's own dispatch bounds still
apply independently.

Background mergeability UNKNOWN has a separate cycle budget using the same cap:
K settled UNKNOWN cycles are tolerated; exhaustion requires both more than K
cycles and `stuckDeadlineMs` elapsed since `mergeabilityUnknownSince`. This
survives intervening queued/in-progress observations even though those clear
`blockedSince`. It never spends hammer attempts or requests a stale-head review.
Background launch/in-progress reasons (including `ama-closer-launch-in-progress`),
`background-pr-state-unavailable`, `ama-coexistence-operation-timeout`,
`closer-head-mergeability-unknown`, and nonempty `not-eligible` declines whose
reasons are all `pr-mergeability-unknown` or `labels-unavailable` are
neutral: they neither increment nor reset the UNKNOWN count or timestamp.
A different resolved blocker resets both and clears only UNKNOWN-origin
exhaustion evidence, allowing normal hammer or re-review recovery to resume.
`pagedReasons` remains set for per-head, per-reason deduplication. Recovery
returns an `urgent` boolean for settled UNKNOWN waits and backgrounded probes
only while the series has 1 through K cycles and no exhaustion event. The
handler passes only this boolean to lane scheduling, keeping ordinary retained
ownership decision fingerprints stable. Beyond K cycles normal lane backoff
applies even before the wall-clock floor; later scheduled probes still escalate.

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

Launch reconciliation invoked by per-head recovery is scoped to the same repository, PR number and head SHA; unrelated dispatches neither delay recovery nor get reclaimed by it. Both `verdict-not-eligible` (daemon) and `verdict-not-settled-success` (closer) authorize remediation dispatch, while independent safety holds remain fail closed.

Transient-only eligibility declines retain the ordinary stall clock and page after `stuckDeadlineMs`, while remaining neutral to the UNKNOWN series. Pending re-review ownership and its expiry are evaluated before settled UNKNOWN recovery.
