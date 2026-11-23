# MRQ-21: on queue-v2 lanes the hammer ends at an attested head and the executor merges it

## Summary

On a lane routed `queue-v2`, the hammer is dispatched with its ordinary prompt
and phases. Its close controller runs publish, verify-head and the exact-head
audit, then hands that head to the queue executor and exits. It no longer waits
for CI, runs the merge predicate or merges on these lanes. The executor admits
the handoff, re-validates live state and merges with the expected head under its
existing lane ownership and retries. A head move voids the handoff and the new
head starts a fresh review lifecycle. Legacy lanes are unchanged: they render no
queue inputs and run the same controller sequence as before.

This replaces MGQ-10's queue-only closer prompt (`templates/queue-closer-prompt.md`,
removed), whose handoff was submitted by the model through operator instructions.

## Interface changes

- `bin/hammer-close-controller.sh`: when inputs carry
  `HAM_FINALIZATION_EXECUTOR=queue-v2`, the step after the audit publish runs
  `bin/hammer-queue-handoff.mjs` and finishes with its outcome
  (`queue-handoff-admitted`, exit 0; world stop, exit 20; retryable, exit 75).
- `bin/hammer-close.sh`: no closing comment after an admitted handoff.
- New `src/finalization/hammer-queue-handoff.mjs`: `hammerReviewProof`,
  `buildHammerQueueHandoffRequest`, `admitHammerQueueHandoff`,
  `confirmHammerQueueHandoff`, `runHammerQueueHandoffStep`. New
  `src/finalization/hammer-queue-command.mjs`: `parseHammerQueueHandoffCommand`,
  `hammerQueueInputs`.
- `templates/hammer-bootstrap.sh` / `renderHammerBootstrap`: `<<QUEUE_INPUTS>>`,
  empty on legacy lanes.
- `prepareQueueCloserDispatch`: a queue-v2 lane requires
  `composition.hammerHandoffCommand` (absolute argv) and returns
  `handoffCommand`; otherwise `queue-closer-composition-unavailable`.
  `renderQueueCloserPrompt` and `queue-closer-prompt-input-missing` are removed.
- Queue-v2 hammer launches use `decision-only` / `terminal-audit` (was
  `branch-push` / `push`); the terminal audit is a `superseded` attempt with
  reason `queue-handoff-admitted` naming the launch.
- `normalizeQueueHandoff` / `validateQueueHandoff`: optional `reviewProof`
  (`digest`, `head`), verified against trusted evidence when present.
- Stop codes: `queue-handoff-unadmitted`, `queue-handoff-failed`
  (infrastructure), `pr-closed` (world).

## Verification

- `node --test test/mrq-21-queue-hammer-handoff.test.mjs`: 7/7. Attested head,
  then handoff, then executor merge on the exact head; replay without a second
  delivery; head move voids with no merge and no re-hammer; transient executor
  refusal retried on the same head with the handoff kept; world/unbound refusals;
  receipt binding; validator binding.
- `node --test test/hamcontrollerscript-01.test.mjs`: the legacy close sequence is
  unchanged and never hands off; a queue-v2 close hands off after publish and
  never waits CI, runs the predicate or merges; unconfirmed/world stops release
  the lease without merge.
- `node --test test/finalization-queue-closer.test.mjs test/finalization-queue-closer-race.test.mjs`:
  dispatch renders the ordinary hammer with queue inputs on queue-v2 lanes and
  none on legacy lanes; missing inputs fail exactly as on a legacy lane.
- `test/smv.test.mjs`, `test/hamselferrors-01.test.mjs`: state declaration and
  stop-origin table updated.
