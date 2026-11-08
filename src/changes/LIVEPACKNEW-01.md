# LIVEPACKNEW-01

Review and remediation share the same liveness decision. When a plan is
absent at the base ref, one complete recursive base-tree listing and cached
base-plan fetches establish whether its planId already exists. A unique
head-only plan returns `new-pack-absent-at-base` without querying the ledger.
Truncated, unavailable or malformed base evidence remains inconclusive.
The base ref is resolved once to a commit SHA, which pins both the tree
listing and the collision scan's plan reads.

A planId collision retains ledger checks and uses base-plan ticket ownership.
Existing packs continue to use their base plan exclusively; head edits cannot
grant an own-pack exemption.

Unavailable ledger reads get at most three attempts, with 100 ms and 200 ms
backoffs and a three-second limit per attempt, within a ten-second budget.
Scope denials remain immediately inconclusive. Persistent failures still
produce the existing blocking finding. Retry counts appear in structured
review facts, finding JSON and remediation facts, without changing finding
prose. No configuration, waiver, lifecycle or merge-authority changes.
