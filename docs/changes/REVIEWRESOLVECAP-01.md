# REVIEWRESOLVECAP-01

## Summary

Fresh healthy executable resolution re-queues transient review failures without
spending infrastructure recovery. Resolution backoff scales with load; persistent
failures retain bounded escalation. The [SEV3 report](../postmortems/SEV3-REVIEWRESOLVECAP-01.md)
records the Phase 0 finding: exit status one does not prove a timeout.

## Interface changes

No new CLI flags, configuration, database columns, statuses, or CI gates.
Healthy probes preserve cascade counters. A changed resolution failure class
or a gap over one hour past scheduled retry starts a fresh streak. Canonical
state and runbook docs updated.

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

Settlement performs no resolver probe: it records failures and applies
ordinary bounded escalation at the five-failure threshold. After durable
backoff, poll-time probes run only below the infrastructure cap. Each
repository discovery pass shares one watcher-context result per CLI. A healthy
probe re-queues the exact observed open row and clears all claim columns; it
preserves the failure streak and budgets. A failed probe schedules a
load-aware hold and ends processing for that row in the same tick. Both
observations preserve failure breakdowns and reasons. At the infrastructure
cap, probes are bypassed so existing cap alerts and scheduled recovery remain
authoritative. Resolution backoff scales with host load; a changed failure
class or a gap over one hour beyond the scheduled nextRetryAfter starts a
fresh streak. Watcher probes are advisory: they do not reproduce
credential-staged spawn environments or Gemini antigravity selection. Only a
successful review clears failure history.

Targeted recovery, resolver, cascade and claim-loop fixtures verify settlement,
accounting preservation and failed-probe scheduling. The reviewer correctly identified environment/runtime divergence. Probe success is now advisory and cannot reset escalation or bypass cap alerts; exact spawn-context probes remain a limitation.

Remediation checks: `npm test -- review-cli-recovery.test.mjs` passed all seven
cases; lint (zero errors), contract typechecking, data-model catalog validation
(98 entries), the byte-equivalence demo and `git diff --check` passed. Missing
locked dependencies were installed with `npm ci`; stale cascade module stubs
were updated for the dedicated probe writer. The first watcher fixture run
reached its 240-second deadline without assertion failures and was rerun with
the documented 900-second allowance.

`npm test -- watcher-claim-loop.test.mjs watcher-fast-merge.test.mjs github-api.test.mjs watcher-reviewer-timeout-handoff.test.mjs`: 317 passed, zero failed.

Current remediation validation (offline synthetic fixtures):

- Five targeted recovery/resolver/cascade/claim suites: 273 passed.
- Latest recovery suite: 11 passed, including healthy probes followed by repeated spawn failures.
- Latest watcher claim-loop suite: 187 passed, including cap alert and failed-probe tick termination. A preceding 120-second run timed out; the final bounded 180-second run completed.
- Lint: zero errors (existing warnings); contract typechecking, catalog validation (98 entries), byte-equivalence demo and `git diff --check`: passed.

Deleted the unused synchronous health API and ignored test arguments. Settlement
now has a real executable-call sentinel. Healthy re-queues clear canonical claim
columns and refuse closed PRs. No deployed recovery or new smoke promise is claimed.
