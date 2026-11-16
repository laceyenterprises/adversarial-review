# REVIEWRESOLVECAP-01

## Summary

Fresh healthy executable resolution re-queues transient review failures without
spending infrastructure recovery. Resolution backoff scales with load; persistent
failures retain bounded escalation. The [SEV3 report](../postmortems/SEV3-REVIEWRESOLVECAP-01.md)
records the Phase 0 finding: exit status one does not prove a timeout.

## Interface changes

No new CLI flags, configuration, database columns, statuses, or CI gates.
Existing cascade counters reset after a healthy probe, a changed resolution
failure class, or a gap over one hour. Canonical state and runbook docs updated.

## Verification

All commands ran through the bounded worker validation runner (900-second
per-command timeout), using synthetic offline fixtures:

- `npm test -- review-cli-recovery.test.mjs review-cli-resolver.test.mjs reviewclijson-01.test.mjs watcher-claim-loop.test.mjs watcher-atomic-claim.test.mjs`: 251 passed.
- `npm test -- review-cli-recovery.test.mjs watcher-cascade-resilience.test.mjs reviewer-cascade-quota-hold-bound.test.mjs`: 74 passed, including terminal persistent-failure escalation.
- `npm test -- review-cli-resolver.test.mjs`: 14 passed after adding a real synthetic child exit-one regression.
- `npm run lint`: passed, zero errors (existing warnings).
- ESLint `--fix` on changed source files: passed, zero errors.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, byte-stable transcript.
- `git diff --check`: passed.

The ticket requested scoped tests; the whole test suite was not run manually.
The initial memory search returned no records; the follow-up search after
Phase 0 timed out, so local runbooks supplied the remaining evidence.
