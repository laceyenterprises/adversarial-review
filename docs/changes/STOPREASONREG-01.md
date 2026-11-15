# STOPREASONREG-01

## Summary

Register missing hammer stop emissions, including `conflict-resolver-failed`
as world-origin, so unresolved conflicts do not become retryable closer faults.
Extend the existing ordinary sync test across shell stop helpers, terminal
audit calls, generated helper/procedure reasons and forwarded review-proof reasons.
See the [SEV3 report](../postmortems/SEV3-STOPREASONREG-01-unregistered-hammer-stops.md).

## Interface changes

Unknown runtime stop attempts retain optional `originalReason` alongside
existing `reasonDetail`; routing still uses `stop-reason-unregistered`.
No new command, configuration, CI check or live operation.

## Verification

- `node --test test/hamselferrors-01.test.mjs`: 14 tests passed under netguard,
  through `cwp_dispatch.worker_validation`, bounded to 600 seconds.
- `node node_modules/eslint/bin/eslint.js --fix` on the two changed source
  files and touched test: passed; `git diff --check`: passed.

Only the touched test file is run, per ticket constraints; the broad suite,
contract test suite and research demo are not run.
