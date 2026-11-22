# MRQ-20: CI on the exact head decides when local validation is UNKNOWN

## Summary

A host-local validation that times out, is killed for load or is denied
process inspection is now UNKNOWN: no verdict. UNKNOWN no longer stops a
closer when the repository declares required check contexts. The hammer
continues, and its exact-head gate merges only when every declared context
has reported and is green on that head. A red, pending, absent or undeclared
context still blocks. A local check that genuinely failed still blocks, and
the hammer remediates it.

Required contexts can now be declared for one repository, so a check that
only one repository runs never reads as missing in another.

## Interface changes

- Config: `roles.adversarial.merge_authority.required_check_contexts_by_repository`,
  a list of `{ repository: owner/name, contexts: [non-empty strings] }`
  (default `[]`). The vendored CFG schema (`src/generated/config.schema.json`)
  gains the key. `getMergeAuthorityConfig()` exposes
  `requiredCheckContextsByRepository`.
- `resolveRequiredCheckContextsFromCfg(cfg, { repository })`: with a
  repository, returns the global list plus that repository's contexts. Without
  one it returns the global list only, unchanged for every existing caller.
- New `src/ama/local-validation-unknown.mjs`: the UNKNOWN reasons that may
  defer to CI, the deferral decision and the exact-head gate.
- `bin/hammer-validate.mjs`: the receipt `validation-deferred-<head>.json`
  gains `ciAuthoritative`, `requiredContexts` and `localFailureObserved`. A
  CI-authoritative UNKNOWN exits 0 with
  `local-validation-unknown-github-required-gate-authoritative` and writes no
  early-failure audit. `--check-deferred` and a repeat on the same head exit 0
  for such a receipt instead of 75. The mirror's budget stop (exit 75 without a
  failed check) and a battery killed by a signal the validator did not send are
  now UNKNOWN. Before, both were read as failed validation.
- `bin/hammer-close.sh`: after a controller round that a CI-authoritative
  validation timeout stopped, runs one fresh round.
- `bin/hammer-merge.sh` gate: passes the resolved global and per-repository
  contexts to the shared classifier and to `evaluateMergeEligibility`. With an
  UNKNOWN receipt for the head, it also requires a non-empty declared set.
  The gate JSON gains `requiredContexts` and `localValidationUnknown`.
- Queue-v2: `resolveQueueRequiredSet` takes the lane repository; a trusted
  handoff local-validation read of `result: unknown` is admissible, and
  `queue-merge` returns it to the closer unless the exact candidate's declared
  contexts are non-empty and green.
- Docs corrected in place: `docs/RUNBOOK-ama-closure.md`,
  `docs/STATE-MACHINE.md`, `docs/data-model/hammer-controllers.md` and its
  catalog fragment.

The daemon and closer still read only the global list; giving them the
repository is a follow-up. No CI job, check, gate, ratchet or label is added.

## Verification

- `node test/run-tests.mjs test/mrq-20-validation-unknown.test.mjs`: 13/13.
  Covers timeout + green declared CI (eligible), timeout + red CI (blocked), a
  real local failure (blocked), a declared-but-absent context (not green),
  undeclared contexts, failures seen before the stop, the mirror budget stop,
  external kills, the rendered hammer gate and the queue-v2 path.
- Related suites (hammer controller, close-controller script, validation
  deferral, rendered gate, prompt pins, queue-v2 checks/handoff/merge/cutover,
  config loader and CFG parity, SMV, watcher claim loop, daemon clean merge):
  green after updating three expectations for the new receipt fields and the
  UNKNOWN classification of an inconclusive mirror exit 75.
- `npm run lint` (0 errors), `npm run typecheck:contracts`,
  `bash demo/research-finding-walkthrough.sh`: pass.
