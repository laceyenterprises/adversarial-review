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

Final remediation checks the deadline after backoff before dispatching another
ledger read and counts only retries actually dispatched. Remediation facts
normalize omitted retry counts to zero for packs whose plan could not be read.
Offline regressions cover just before, exactly at and after the deadline and
malformed or identity-less plans.

Verification: `node --test test/live-pack-cross-edit.test.mjs
test/remlabel-live-pack-merge.test.mjs` passed all 50 offline tests.
`npm run lint` passed with zero errors; `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh` and `git diff --check` passed.
The full suite remains delegated to PR-head CI.
