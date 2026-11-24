# Closer successor custody

Owner: `src/ama/closer-successor.mjs`.
Store: `data/closer-successors/<sha256(repo#pr@head)>.json` with a sibling
persistent flock inode. Records use schemaVersion 1 and retain repo, prNumber,
headSha, source, requestedAt, the refusing reviewBody and refusingReasons.
Before enrollment, a newer refusing review refreshes that input under the
receipt lock and records reviewObservedAt without resetting custody.
If the receipt disappears before the locked read, a request recreates its
`successor-pending` record under the lock. Settlement returns the same pending
deferral as lock contention, without dispatch or a refusal alert, when its
locked read finds no receipt.

`requestCloserSuccessor` atomically enrolls once per PR/head, including after
terminal settlement. An exhausted closer with a confirmed open PR and no merge,
or an ordinary remediation pre-claim cap, writes `successor-pending`. The
watcher executes pending requests with current admission evidence through the
existing final-fix-all work order. The work order retains its normal full review,
one-round budget and PR/head/reason deduplication.
Legacy infrastructure/exit audits without refusing review input retain the
existing bounded retry and cap-alert executor.

Settlement holds the receipt's exclusive flock across admission and enqueue.
A confirmed remediation job records `successor-enrolled` and successorJobId;
repeated settlement returns that receipt without dispatch. Disabled, refused,
failed or unreadable handoff records `needs-closer`, reason and
updatedAt, then calls the existing closure-wait alert surface immediately with
waitClass `closer-successor`. Its persistent page latch deduplicates repeated
observations. Delivery failures remain retryable. The closure pass can retry
admission from `needs-closer` or the legacy `ownerless-closer-no-merge` value.
When a terminal final-fix-all job returns fallback for a strict exact-head
review with findings that selects hammer (including failed-CI repair), the watcher
records optional `fallbackAt` (UTC ISO 8601) under the receipt flock and passes
the selected hammer decision to normal admission. This transfers deadline
ownership to hammer, including retry-admission gaps, unreadable launch liveness
and retry-cap escalation. Later passes that select the same hammer route reuse `fallbackAt` without another final-fix-all lookup. A later non-fallback settlement clears `fallbackAt`. Other routes record `needs-closer` with the
handoff's reason and surface the refusal instead of admitting another hammer.
Final-fix-all's durable claim prevents duplicate work. An independent watcher
sweep checks receipts after 1800 seconds from the original `requestedAt`. Poll
updates to `updatedAt` do not extend custody. Enrolled, escalated and
hammer-owned receipts get retirement-only probes at most daily. The sweep
records optional `retiredAt` (UTC ISO 8601) under the receipt flock if GitHub
confirms the PR is terminal or its head moved. Retired receipts skip future
probes. After seven days the sweep removes retired receipt JSON under the same
flock, with a locked timestamp recheck, and unlinks its lock file. Openers verify the lock inode is still linked after acquiring it. The bounded sweep also removes orphaned legacy locks after confirming under flock that the receipt is absent.
Fresh admission can clear the marker if the PR returns to that head.
A same-head open PR only pages after a locked receipt recheck and when the
sweep confirms there is no live closer dispatch or retry on that head. The sweep
records optional `lastProbedAt` (UTC ISO 8601) under the receipt lock for an
inconclusive or retirement-only probe. A live closer, pending lease or unreadable PR or launch evidence backs
off deadline probes for five minutes across restarts.
The immediate refusal and overdue escalation share one page latch.
After either observation succeeds, optional `escalatedAt` (UTC ISO 8601) is
written under the receipt flock. It ends deadline paging across restarts.
Failed delivery leaves the marker unset and remains retryable. Later settlement
still attempts admission. Reopening a retired receipt clears its probe and
escalation timestamps. The existing page latch remains authoritative.

A pending receipt grants no merge, review or budget authority. Head matching,
operator holds, strict findings remediation, CI and both closure paths keep their
existing predicates. A terminal PR is never dispatched through this receipt.
