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
The rescue bridge exposes only the status and head to closure recovery.
Final-fix-all's durable claim prevents duplicate work.

A pending receipt grants no merge, review or budget authority. Head matching,
operator holds, strict findings remediation, CI and both closure paths keep their
existing predicates. A terminal PR is never dispatched through this receipt.
