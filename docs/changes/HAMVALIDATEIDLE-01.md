# HAMVALIDATEIDLE-01

## Summary

Closer local validation scales its no-progress (idle) limit with host load, as
its absolute deadline already did. A slow check that prints nothing for longer
than the 120 s base is no longer killed as a hang on a busy host. The base,
`LEASE_VALIDATION_IDLE_MS`, is unchanged and still applies at normal load. The
effective limit is capped strictly below the remaining absolute deadline, so a
truly hung validator still ends before the merge lease does. Report:
`docs/postmortems/SEV1-closer-validation-idle-limit-is-not-load-aware-2026-11-19.md`.

## Interface changes

New export `leaseValidationIdleMs(remainingMs, loadOptions)` in
`src/ama/lease-validation.mjs`. `hammer-validate.mjs` logs the effective value
in its existing `run-bounded: started ... idle=<ms>` line. The merge-agent
prompt no longer calls the bound "unscaled". `bounded-command.mjs` semantics are
unchanged.

## Verification

- `node test/run-tests.mjs test/hamvalidateidle-01.test.mjs`: 6 passed.
- `node test/run-tests.mjs test/run-bounded.test.mjs`: passed; its CLI test now
  asserts the idle limit is below the absolute deadline.
- Prompt and controller suites that read the changed prompt text passed:
  `hammer-prompt-contract`, `ama-hammer-merge-protocol-prompt`,
  `hamcontrollerscript-01`, `hammer-scratch`, `root-change-notes`.
- `npx eslint` on the changed sources and `npm run typecheck:contracts`: clean.
