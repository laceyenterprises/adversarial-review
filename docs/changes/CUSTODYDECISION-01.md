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
