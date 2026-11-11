## Summary

A closer's in-run checkout now asks Agent OS to release an eligible terminal
branch holder, then retries exactly once. Cleanliness, terminal ownership,
process/lease proofs, salvage preservation and detach stay owned by Agent OS.
Live, dirty, uncertain and unavailable release evidence retains custody and
reports the holder. Branches and worker directories are never deleted.

## Interface changes

`hammer-helper-step.mjs` recognizes a collision only for a mutation-mode
`checkout` step executing plain `git checkout BRANCH`. Shared canonical holder
parsing serves provision and checkout recovery. The runner verifies the same
repository and expected branch and calls the companion
`hq worker release-branch --root ROOT --holder PATH --branch BRANCH` command.
Other mutations retain their single-attempt behavior. Deploy the companion
command before relying on recovery; absence fails closed.

## Verification

Targeted offline tests under netguard, each command bounded to 600 seconds:
`test/checkout-holder.test.mjs` (8 passed) and
`test/hammer-helper-step.test.mjs` (22 passed). `test/ama-closer-branch-holder-reap.test.mjs` passed all 62 regressions.
Scoped ESLint and contract typechecking passed. No full suite or live
mutation was run.

After deployment, AR float and an authorized watcher/follow-up restart, SRE
verifies PID start times and observes 24 hours with zero closer
`checkout-failed` with a terminal holder and zero terminal-holder
already-checked-out provision refusals. See the
[operator plan](../../modules/worker-pool/post-merge-actions/hamcheckoutholder-01.yaml).

The operator plan uses the publication tool’s required
`modules/worker-pool/post-merge-actions/` path; it is an operator-step declaration,
with no new runtime worker-pool implementation in this repository.
