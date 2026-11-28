# CUSTODYDECISION-01

After confirmed owner expiry or terminal launch, the watcher releases a clean
published hold with finalized deferrable UNKNOWN evidence and declared CI
contexts. It records the exact-head release in `hold.json`. A fresh closer
reuses the saved UNKNOWN through its existing exact-head CI path.

Other operator custody gets a durable HQ decision for the exact launch and
attempt. The reply can keep custody or authorize discarding the retained work.
Discard takes effect when the watcher confirms the owner has stopped and the
PR merge lease is clear. Legacy concatenated snapshots of the same attempt
are normalized under the custody lock.

Clean matching-target setup faults with finalized, non-failing evidence
continue to paced local retry. CI-eligible holds quietly await ownership
proof and lease clearance for five minutes before the watcher raises a
decision and pages. A stalled discard pages after the same window from the
latest applicable timestamp. Legacy controller evidence can be finalized
while clearance is pending. Confirm HQ CLI support on the target host before
the watcher float. HQ settles earlier decisions from the hold
resolution. Invalid answers and unreadable or fallback custody retain
operator visibility. Marker reads leave legacy files untouched, and resolving
the live-head hold preserves a refusal still required by the dispatch head.
