# OVERLOADDEFER-01 — helper load timeouts retain closer custody

An actual helper timeout under a load multiplier above one produces
`overload-deferred`. The version 1 wire adapter matches Agent OS's
`agent_os_core.overload_deferral`: phase, deadline, scaled budget, load evidence,
same owner, persistent deferral count, retry time and `host-overload` alert key.
Identical v1 wire vectors qualify both implementations. This repository
remains independently testable without Python or Agent OS.

Read helpers have one local retry with backoff. Mutation helpers preserve their
partial receipts and execute once. Exhausted load timeouts write a deferred
audit, release the merge lease through the existing retryable-abort path and
keep closer retry custody. Generic wrapper failures preserve that observation;
authoritative safety refusals keep their precedence.

The retry ledger retains overload debt across replacement launches. Backoff is
30, 60, 120 and 240 seconds; the fifth deferral stops automatic replacements,
retains ownership and requests overload attention. The existing closure-wait
store coalesces that attention across PRs using one durable host alert latch.
Policy errors, red checks, moved heads, lost ownership and all merge predicates
remain unchanged.

After normal deployment and separately authorized activation, SRE observes
natural helper timeouts under comparable load. Retain receipts showing deferred
closers later completing with the same PR owner, bounded counters and at most
one host overload alert. Terminal failures of this kind should approach zero.
The companion Agent OS PR owns the provisioning/rescue/sweep changes and SEV1
report. This source change authorizes no live mutation or service restart.

## Final remediation summary

Removed the ticket-specific root README paragraph; this file remains the
repository change note. Repeated observations already return from
`deferHammerRetryDispatchUnlocked` when the launch is in `deferralLaunches`
or `leaseWaitLaunches`, before calling `deferOverload`. The dispatch regression
now polls each parked launch six times before its retry deadline and verifies
unchanged debt, deadlines, refunds, lease custody and page counts, followed by
replacement at the deadline. No additional wire receipt field is needed.

The PR-head CI run exposed two terminal-progress regressions. Restored the
final exit's reason in its progress receipt while retaining the first audit
observation and preserving deferred overloads without a terminal-stop receipt.

## Interface changes

None in final remediation. Store shapes, lifecycle states and existing
post-deploy observation promises remain unchanged.

## Verification

Resume validation: overload-deferral 6 passed, hammer-helper-step 22 passed,
hammer-helper-launch 7 passed, and ama-hammer-retry-cap 196 passed. Each file
ran separately under netguard with a 600-second process-group bound. ESLint on
changed sources and the contract typecheck passed.

Final remediation uses bounded targeted tests through `node test/run-tests.mjs`.
The `hammer-progress`, `lvr-no-op-outcomes` and `overload-deferral` files pass
all 41 tests, including the two PR-head CI failures. The updated
`ama-hammer-retry-cap` file passes all 196 tests. `npm run lint` passes with
zero errors (existing warnings); `npm run typecheck:contracts`,
`node scripts/validate-data-model-catalog.mjs` (93 entries),
`bash demo/research-finding-walkthrough.sh` and `git diff --check` pass.
The full local suite was not run; PR-head CI owns that gate.
