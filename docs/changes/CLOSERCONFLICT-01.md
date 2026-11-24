# CLOSERCONFLICT-01

## Summary

A confirmed conflict at the closer's final GitHub gate yields the merge lease.
The close controller can replay the current PR head onto the current base twice.
It runs bounded local validation before publishing the rebased head with an
exact-head lease, then rebuilds the audit, CI and merge evidence. A changed
patch requires independent review of the published head.

## Interface changes

`needs-rebase-repair` identifies an exact-head continuation when a local rebase
hits conflict markers or the automatic budget is exhausted. A confirmed
conflict can enter closer and successor dispatch. Merge still requires
`MERGEABLE`. Draft, closed and UNKNOWN-mergeability PRs cannot enter closer
dispatch.

Final comment remediation treats an unreadable replay HEAD or unavailable proof
as `review-required`, and nullish or empty mergeability as the existing
`pr-mergeability-unknown` recovery wait before queue preparation. The main rebase
preserves clean daemon successor routing and strict spent-successor fallback
alongside confirmed-conflict repair. No store shape, lifecycle state or smoke
promise changes.

CI repair keeps UNKNOWN mergeability from bypassing existing closer observation
and certified deferral accounting, while refusing new launches. Existing
conflict and prompt assertions now name the intended `conflict-rebase` repair
reason and the changed-patch independent-review handoff.

The closer checks existing launch custody, stacked-base guards and prior HAM
stop evidence before reporting a mergeability wait. Missing mergeability still
blocks new queue preparation and closer launches.

## Verification

Synthetic coverage includes the post-lease gate, a real local Git replay,
validation before publication, conflict markers, exhaustion after two attempts,
changed-patch review handoff, closer and successor admission, and daemon refusal.

Final remediation validation:

- `node test/run-tests.mjs test/ama-hammer-retry-cap.test.mjs test/ama-closer-dispatch-priority.test.mjs test/finalization-queue-closer.test.mjs`: 662 passed.
- Targeted conflict-primary, closer controller, lease-park, successor and hammer prompt tests: passed.
- `test/watcher-claim-loop.test.mjs`: 202 passed.
- `npm run lint`: zero errors; `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: byte-equivalence demo passed.
- `node scripts/validate-data-model-catalog.mjs`: 104 entries validated.
- `git diff --check`: passed. The full suite remains the PR-head CI gate.
