# HAMCONFLICTCUSTODY-01

## Summary

Hammer conflict repair stopped with `conflict-checkout-failed` whenever the PR's
builder worktree was still present, which is the normal case.
`bin/hammer-conflict-repair.sh` ran `git checkout "$HEAD_BRANCH"` in the hammer
worktree. That worktree can share its git directory with the builder's linked
worktree, and git refuses to check out a branch that another linked worktree
holds. HAMCONFLICTSYNC-01 made the repair's helpers available, and that exposed
this next failure.

The rule: a closer never needs a branch's checkout slot to update the branch.

- The repair now detaches at the exact fetched PR head
  (`git checkout --detach <origin/<head> sha>`) and rebases there. A builder
  worktree holding the branch name no longer matters, and the builder's local
  branch ref, worktree and any unpushed builder commits are never read or
  changed.
- Before detaching, the repair refuses (`conflict-source-not-fetched-head`)
  when the hammer worktree's HEAD has commits the fetched PR head lacks. A
  detached checkout would otherwise orphan them. The old named-branch
  checkout refused a stale local branch by accident; this check states
  the same protection directly.
- When the repair succeeds, it writes `<run-dir>/conflict-repair-publish.env`
  (`source=`, `head=`, `branch=`). `bin/hammer-api-publish.mjs` uses that binding
  only while the local HEAD is the repaired head:
  - the lease-protected git fallback pushes `HEAD:refs/heads/<branch>` with
    `--force-with-lease=refs/heads/<branch>:<source>`;
  - a live PR head that differs from the captured source is reported as moved,
    and git refuses the push against the same exact-head expectation;
  - a binding for another branch, or a malformed binding, leaves no explicit
    refspec, and the bare push fails on the detached HEAD.

  Before this change, the fallback lease was whatever head the PR read returned
  at publication time. A branch update made after the repair captured its
  source (for example, a later author push) could therefore be overwritten by
  the rebased head. It is now refused.
- These fences are unchanged: the exact source head (`HAM_CONFLICT_SOURCE` is
  the fetched `origin/<head>`), no squash or amend of author commits,
  `core.commentChar=;`, resolver order (hand-written sources first, then the
  GENCONFLICT-01 resolver), the HAMEMPTYPRIMARY-01 reviewed-head capture and
  proof, SUBSYNC-01 submodule sync, the merge lease and every predicate.
- The simpler option was chosen over calling HQ's branch-release custody
  (BRANCHRELEASESUPERSEDED-01). The repair needs no live worktree mutation,
  host CLI or ownership classification, and it cannot release a slot that a
  builder still needs.

## Interface changes

- `bin/hammer-conflict-repair.sh`:
  - runs on a detached HEAD;
  - the state file `conflict-repair.env` also records `HAM_CONFLICT_BRANCH`;
  - success writes `conflict-repair-publish.env`;
  - exit codes are unchanged.
- New `src/ama/hammer-conflict-binding.mjs` (`conflictPublishBinding`,
  `parseConflictPublishBinding`, `CONFLICT_PUBLISH_FILE`).
- `bin/hammer-api-publish.mjs` reads the binding for a conflict-repaired head.
  Output fields are unchanged.
- `docs/RUNBOOK-ama-closure.md` was corrected in place.

No CI check, gate, ratchet, guard, override label or configuration key is added.

## Verification

- New `test/hamconflictcustody-01.test.mjs` uses a synthetic bare origin, a
  shared clone, a builder linked worktree on the PR branch with an unpushed
  commit, and a detached hammer linked worktree. It runs the real conflict
  repair and the real rendered publication phase against real git:
  - A plain `git checkout feature` in the hammer worktree is refused ("already
    used by worktree"). The shipped repair still stops at 22, continues, and
    produces the rebased head with the author identity and
    `conflict-primary-preserved`. Publication pushes it with
    `HEAD:refs/heads/feature --force-with-lease=refs/heads/feature:<source>`.
    The builder's branch, unpushed commit and clean status are untouched.
  - After a concurrent update of the PR branch, publication is refused and the
    concurrent head survives. This holds when the live PR read shows the move,
    and also when the read is stale, where the git lease alone refuses.
  - The binding applies only to its own head and fails closed when malformed.
- A/B against `origin/main`:
  - with the base repair script, the builder test fails with
    `conflict-checkout-failed` and git's "already used by worktree" error;
  - with the base publisher, the live-read concurrent-update case overwrites
    the concurrent head.
- `test/hamconflictsync-01.test.mjs`: the exact-head case now covers the
  hammer worktree holding a commit the PR head lacks, which is refused and
  retained. `test/hammertrim-contract.test.mjs` pins the detached checkout line.
- `node --test` passed for each file run individually:
  - `hamconflictcustody-01` (5), `hamconflictsync-01` (11),
    `hammertrim-contract` (53), `hammer-rebase-guards` (13),
    `hamcontrollerscript-01` (13), `hammer-api-publish` (7);
  - `hammer-api-publish-cli` (29), with ambient worker token variables unset as
    in its fixtures;
  - `conflict-primary` (13), `ama-hammer-merge-protocol-prompt` (45),
    `hammer-helper-step`, `inconclusiveretry-01b` (14),
    `hammer-prompt-contract` (6), `github-outbound-call-sites` (2).
