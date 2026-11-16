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

## Review remediation

Settlement performs no resolver probe: it records the failure and applies
ordinary bounded escalation at the five-failure threshold. After durable
backoff, the poll path asynchronously probes every terminal or pending-upstream
resolution row before cap handling or a charged recovery claim. A healthy probe
re-queues only the exact observed row, resets the streak and schedules the
initial load-aware hold without incrementing failure breakdowns or overwriting
the last failure evidence. A failed probe schedules another load-aware hold
without counting a new reviewer failure. Resolution backoff scales with host
load; a changed failure class or a gap over one hour starts a fresh streak.

Targeted recovery, resolver, cascade and claim-loop fixtures verify settlement,
accounting preservation and failed-probe scheduling. The reviewer's environment
divergence concern remains unconfirmed; per-spawn environment parity is not
changed in this patch.

Remediation checks: `npm test -- review-cli-recovery.test.mjs` passed all seven
cases; lint (zero errors), contract typechecking, data-model catalog validation
(98 entries), the byte-equivalence demo and `git diff --check` passed. Missing
locked dependencies were installed with `npm ci`; stale cascade module stubs
were updated for the dedicated probe writer. The first watcher fixture run
reached its 240-second deadline without assertion failures and was rerun with
the documented 900-second allowance.

`npm test -- watcher-claim-loop.test.mjs watcher-fast-merge.test.mjs github-api.test.mjs watcher-reviewer-timeout-handoff.test.mjs`: 317 passed, zero failed.
