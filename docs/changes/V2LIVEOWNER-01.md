# V2LIVEOWNER-01

## Summary

Merge Authority v2 waits while the canonical next-action snapshot proves a live
closer or remediator owner. This prevents duplicate remediation and premature
patience escalation. Expired/stale leases and terminal/refused owners retain
the existing decisions. V1 and shadow disposition rules are unchanged.

Final comment-only remediation preserves the already-read canonical owner
snapshot in the leased execution error fallback. Deferred outcomes now retain
the live-owner wait instead of proposing remediation or patience escalation.
The promotion runbook documents this diagnostic behavior.

## Interface changes

V2 eligibility and shadow observation accept an optional `ownerSnapshot`.
Live shadow composition supplies its existing canonical snapshot; executor
live readers may return that same snapshot as `ownerSnapshot`. It must match
the tick time, subject and head. Closer status alone cannot renew a missing or
expired durable lease/progress bound. Canonical remediator liveness retains
the existing reader's heartbeat/launch bounds.

Organic pairs persist `live.ownerState`; live-owner decisions also carry
`liveOwner` and `monitor-agent`. The existing runtime fingerprint includes
the owner projection and its decision dependencies. No SQL migration, configuration, CI job,
disposition, override, live activation or v1 execution change is introduced.

## Verification

### Final comment-only remediation

Final remediation: four new offline regressions first reproduced the lost-owner
decision on leased-read and execution errors, then passed for closer and
remediator owners after the fix. Targeted executor, executor-lease and eligibility
suites passed (57 tests); `npm run lint` passed with zero errors and existing
warnings, `npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed with three byte-stable deliveries.
The full suite remains delegated to PR-head CI.

### Original implementation

All validation used bounded commands. Test commands used the required netguard
PATH and `NETGUARD_LOG` prefix; fixtures were synthetic and offline.

- `npm run lint`: passed, zero errors (existing repository warnings).
- ESLint `--fix` on all changed JavaScript modules and tests: passed, no warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- Scoped `node --test`: **555 passed, zero failed**, across these 19 files,
  selected with `git grep -l` for each changed module and its test helpers:

```text
test/arfinalcheck-01.test.mjs
test/finalization-eligibility.test.mjs
test/finalization-executor.test.mjs
test/finalization-executor-lease.test.mjs
test/finalization-lane-baseline.test.mjs
test/finalization-ledger-regression-fixtures.test.mjs
test/finalization-ledger-store.test.mjs
test/finalization-live-shadow.test.mjs
test/finalization-queue-owner.test.mjs
test/finalization-queue-shadow.test.mjs
test/finalization-shadow-recorder.test.mjs
test/finalization-shadow-store.test.mjs
test/finalization-workflow.test.mjs
test/finalization-simulator.test.mjs
test/finalization-v1-wrapper-parity.test.mjs
test/pr-next-action.test.mjs
test/pr-next-action-shadow.test.mjs
test/finalization-queue-canary.test.mjs
test/finalization-queue-cutover.test.mjs
```

Regressions cover blocking findings and expired verdict patience under a live
hammer, canonical remediator ownership, absent/expired/stale/terminal/refused
owners, loss of ownership without patience reset, stale/foreign observations,
execution brakes, offline shadow persistence and pure replay. V1 decision and
wrapper parity suites pass. The full host suite was not run.
