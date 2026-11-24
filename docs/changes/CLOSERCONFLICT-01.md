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

## Verification

Synthetic coverage includes the post-lease gate, a real local Git replay,
validation before publication, conflict markers, exhaustion after two attempts,
changed-patch review handoff, closer and successor admission, and daemon refusal.
