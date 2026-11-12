# HAMCONFLICTSYNC-01

## Summary

A hammer that had to repair a merge conflict stopped at setup. HAMCONTROLLERSCRIPT-01
moved the close controller into a shipped script. After that change the prompt's
Appendix D conflict block still called `ham_bounded_git_sync`, but that function
was defined only inside the shipped verify-head phase, and nothing sourced the
phase into the closer's shell. Conflicting PRs were therefore never rebased by a
closer.

- The bounded fetch helpers (`ham_update_branch_transient`, `ham_is_full_sha`,
  `ham_bounded_git_operation`, `ham_bounded_git_sync`) now also live in
  `bin/hammer-shell-helpers.sh`. Every `inputs.sh` sources that file, so every
  closer shell has them. The verify-head phase keeps its rendered copy, and a
  test pins the two copies byte-equal.
- The conflict-repair shell is now a shipped script, `bin/hammer-conflict-repair.sh
  <run-dir>/inputs.sh [--continue]`, which sources `inputs.sh` itself and checks
  that each helper it calls is defined. Appendix D only invokes it. The semantics
  are unchanged:
  - it uses the live base/head branches and fetches them through the bounded sync;
  - it checks out the exact fetched head, with the fence that the head is `origin/<head>`;
  - it rebases without squashing or amending author commits, using `core.commentChar=;`;
  - the GENCONFLICT-01 resolver runs after hand-written sources are resolved;
  - the HAMEMPTYPRIMARY-01 reviewed-head proof uses the same refusal reasons;
  - the SUBSYNC-01 submodule sync keeps its retry cap.
- The rebase used to run past hand-written markers inside a single block. It now
  stops with exit 22 `conflict-markers-pending`, listing the unmerged paths. The
  closer resolves them and reruns the script with `--continue`. A failed fetch now
  stops (`conflict-sync-failed`, or 76 `git-credential-refresh-failed`). The old
  block ignored that status.
- Appendix C's revalidation prose described the controller's work as closer
  steps, including a call to `ham_release_merge_lease`, which the closer's shell
  does not have. It now says the close command performs those steps.

## Interface changes

- New shipped script `bin/hammer-conflict-repair.sh`. Exit codes:
  - 0: rebased head is ready;
  - 22: hand-written conflicts remain; resolve them, then rerun with `--continue`;
  - 76: retryable credential refresh;
  - 64: usage error;
  - other nonzero: a named stop.
- `bin/hammer-shell-helpers.sh` exports the bounded fetch helpers.
- `templates/hammer-prompt.md` Appendix D invokes the script. Appendix C prose was
  reworded. No phase script, lease, predicate or merge rule changed.
- `docs/RUNBOOK-ama-closure.md` was corrected in place.

## Verification

- `test/hamconflictsync-01.test.mjs` (new), 9 tests:
  - The template-to-helper contract runs each closer-run bash block and inline
    command against the real `inputs.sh` sourced in bash (`declare -F`).
  - A shipped-script contract checks that every `ham_*` call in each controller-sourced
    phase, the controller and the conflict repair is defined at that point.
  - A refusal-gate handoff-marker contract fails on the HAMVERDICTREADY-01
    dropped-marker shape.
  - A test pins the helper copy byte-equal to verify-head's copy.
  - A synthetic CONFLICTING PR runs the real script through the stop, the
    resolution and `--continue` to a rebased head whose author message and
    identity are preserved, and the real `conflict-primary-preserved` proof passes.
  - Further cases cover a clean replay and the exact-head and inputs fences.
- A/B: on an `origin/main` tree the contract reports
  `prompt block at line 987 calls undefined helper(s) ham_bounded_git_sync`.
- Updated pins now read the shipped script: `ama-hammer-merge-protocol-prompt`,
  `conflict-primary`, `hammer-helper-step`, `hammer-prompt-contract`,
  `inconclusiveretry-01b` and `hammertrim-contract`.
