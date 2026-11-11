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

This fresh PR supersedes PR 1832. It preserves current main's typed closer-fault
handling alongside checkout recovery. All three review comments are addressed:
path preflight refusals log retained custody, the triggering Git diagnostic
precedes recovery, and differing worktree basenames are accepted only after
shared-repository verification.

The isolated helper-launch fixture includes the new imports, and the prompt
command fixture supplies its synthetic branch. Checkout uses the existing
`ham_step` wrapper; a shorter adjacent comment preserves the existing 60 KiB
prompt budget. The prompt regression verifies recovery remains wired within
that budget.

Validation runs touched test files individually under netguard with a
600-second bound. No full suite, live release, deployment or restart is part
of coding validation. Exact results are recorded in the PR acceptance evidence.

After deployment, AR float and an authorized watcher/follow-up restart, SRE
verifies PID start times and observes 24 hours with zero closer
`checkout-failed` with a terminal holder and zero terminal-holder
already-checked-out provision refusals. See the
[operator plan](../../modules/worker-pool/post-merge-actions/hamcheckoutholder-01.yaml).

The operator plan uses the publication tool’s required
`modules/worker-pool/post-merge-actions/` path; it is an operator-step declaration,
with no new runtime worker-pool implementation in this repository.
