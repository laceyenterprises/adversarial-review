# HAMVERDICTREADY-01: the shipped hammer close controller marks its owned predicate verdict ready

## Summary

HAMCONTROLLERSCRIPT-01 moved the hammer close controller from the prompt into
`bin/hammer-close-controller.sh`. The prompt version cleared
`HAM_VERDICT_READY_FILE` before `ama-check` and set it to `HAM_VERDICT_FILE`
only after `ama-check` exited 0. The port created and exported
`HAM_VERDICT_FILE` but dropped the marker. `bin/hammer-merge.sh` merges only
when the marker names the verdict file, so every hammer that reached the merge
phase stopped with `predicate-verdict-unavailable`, including closers holding
an eligible exact-head verdict.

The controller now follows the original contract again:

- It clears and exports `HAM_VERDICT_READY_FILE=""` before `ama-check`, so a
  value inherited from the caller cannot name a foreign verdict.
- It sets `HAM_VERDICT_READY_FILE="$HAM_VERDICT_FILE"` only after `ama-check`
  exits 0. A failed `ama-check` stops at `predicate-build-failed` with the
  marker still empty.
- It clears the marker whenever it removes the verdict file: after the merge
  phase and in `ham_close_finish`.

The ownership check in `bin/hammer-merge.sh` is unchanged. A missing marker, a
marker naming another file, and a verdict file the run does not own all still
refuse as `predicate-verdict-unavailable`.

## Interface changes

None. This restores the controller-to-merge contract that existed before
HAMCONTROLLERSCRIPT-01. No new configuration, gate, check or outcome.

## Verification

`test/hamverdictready-01.test.mjs` runs the real `bin/hammer-close.sh` and
`bin/hammer-close-controller.sh`, and the real `bin/hammer-merge.sh` rendered
by `renderHammerProcedure`. It stubs only helper processes, GitHub reads and
the merge call. Verify-head and publish are synthetic. The cases:

- An eligible exact-head verdict passes the ownership gate and reaches one
  `pr merge --squash --match-head-commit <head>` call.
- An inherited marker naming a foreign eligible verdict is empty while
  `ama-check` runs. A failed `ama-check` refuses with `predicate-build-failed`
  before the merge phase.
- A verdict for a stale head refuses with `predicate-not-eligible` in the real
  merge phase.
- The real merge phase refuses an empty marker, a foreign marker and a verdict
  file the run does not own, each as `predicate-verdict-unavailable`.

A/B: with the controller reverted to its pre-fix contents, the eligible case
fails with `stage=hammer-merge outcome=predicate-verdict-unavailable`, which
is the production refusal. The foreign-marker and stale cases also fail.

Commands, each run individually under the netguard environment:

- `node --test test/hamverdictready-01.test.mjs`: 6 pass.
- `node --test test/hamcontrollerscript-01.test.mjs`: 13 pass.
- `node --test test/hammer-controller.test.mjs`: 112 pass.
- `node --test test/hamunknown-02.test.mjs`: 42 pass.
- `node --test test/hammertrim-contract.test.mjs`: 53 pass.
- `shellcheck bin/hammer-close-controller.sh`: clean.
