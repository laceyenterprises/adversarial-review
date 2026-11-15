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

Final remediation moves the eight infrastructure additions into
`HAMMER_INFRASTRUCTURE_OUTCOMES`, from which the origin registry already derives
their classification. The fixture is alphabetized without changing its values.
Audit field metadata now belongs to `catalog.d/STOPREASONREG-01.json` and is
mirrored in `catalog.json`; the audit doc states the existing syntax check and
preservation without normalization precisely. Lifecycle states and smoke
promises are unchanged.

PR-head CI exposed stale retry fixtures: `checkout-failed` is now a world
refusal, so owned-retry examples use `checkout-timeout` and explicitly assert
the real refusal. Certified infrastructure mergeability parks bypass the
ordinary deferral backoff and retain live CI/mergeability gates, then select the
shared daemon merge route rather than the contention-specific inline resume.
The integration expectations now reflect those existing paths.

## Verification

- `node --test test/hamselferrors-01.test.mjs`: 14 tests passed under netguard,
  through `cwp_dispatch.worker_validation`, bounded to 600 seconds.
- `node node_modules/eslint/bin/eslint.js --fix` on the two changed source
  files and touched test: passed; `git diff --check`: passed.

Final remediation validation (tests, lint and type checking bounded through
`bin/run-bounded.sh`):

- `node test/run-tests.mjs test/hamselferrors-01.test.mjs test/inconclusiveretry-01b.test.mjs`:
  29 passed.
- `NODE_OPTIONS='--test-name-pattern=ama-hammer-retry-cap|certified.lease.park' node test/run-tests.mjs test/ama-hammer-retry-cap.test.mjs`:
  10 affected integration cases passed. An earlier complete two-file retry run
  passed 311 of 313 cases; its two stale final-route expectations were corrected
  and passed in this focused rerun.
- `npm run lint`: 0 errors, 149 existing warnings; ESLint on the changed source
  and three test files also passed without warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: validated 98 entries.
- Fixture comparison: all 227 values unchanged, keys sorted; audit field metadata
  matches the ticket fragment. Three malformed reason strings were rejected
  before audit recording.
- `git diff --check`: passed.

Only targeted test files and affected integration cases run locally; PR-head CI
owns the full-suite merge gate. The research demo is not run in this round.
