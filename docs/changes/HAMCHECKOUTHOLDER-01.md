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

Final comment-only remediation emits the original checkout failure before
recovery diagnostics and logs preflight path refusals. Repository identity uses
the shared Git directory without requiring matching worktree directory names;
canonical path and expected-branch checks remain mandatory. Lifecycle states,
durable store shapes and existing post-deploy verification promises are unchanged.

## Verification

Targeted offline tests under netguard, each command bounded to 600 seconds:
`test/checkout-holder.test.mjs` (8 passed) and
`test/hammer-helper-step.test.mjs` (22 passed). `test/ama-closer-branch-holder-reap.test.mjs` passed all 62 regressions.
Scoped ESLint and contract typechecking passed. No full suite or live
mutation was run.

Final remediation verification: `bash bin/run-bounded.sh --timeout 120 -- node
test/run-tests.mjs test/checkout-holder.test.mjs test/hammer-helper-step.test.mjs
test/ama-closer-branch-holder-reap.test.mjs` passed all 97 tests (13 checkout,
22 helper and 62 provision regressions). `npm run lint` passed with zero errors
(149 existing warnings); scoped ESLint, contract typechecking, the offline
research-finding walkthrough and `git diff --check` passed.
The clone uses the deployed dependency tree with an identical lockfile.

After deployment, AR float and an authorized watcher/follow-up restart, SRE
verifies PID start times and observes 24 hours with zero closer
`checkout-failed` with a terminal holder and zero terminal-holder
already-checked-out provision refusals. See the
[operator plan](../../modules/worker-pool/post-merge-actions/hamcheckoutholder-01.yaml).

The operator plan uses the publication tool’s required
`modules/worker-pool/post-merge-actions/` path; it is an operator-step declaration,
with no new runtime worker-pool implementation in this repository.
