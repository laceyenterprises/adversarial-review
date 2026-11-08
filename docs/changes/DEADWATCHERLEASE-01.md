# DEADWATCHERLEASE-01

## Summary

Bind pending closer ownership to process start identity and reclaim dead or
reused local owners through the existing fenced abandonment path. Startup records
prior claims once, and the ticker now waits its interval before repeating. Confirmed
live owners retain custody after expiry; ordinary closer admission resumes
in the same evaluation. Reclaim audit names the previous owner.

See the [SEV2 report](../postmortems/SEV2-watcher-restart-left-closer-ownership-on-a-dead-process-2026-11-08.md).

## Interface changes

Optional lease field `watcherStartedAt` records the local owner's UTC process
start identity; older leases remain readable. Structured abandonment event
`ama_closer.abandoned_lease_reclaimed` includes the owner PID and start identity. Startup also emits
`ama_closer.startup_claim_observed` for inspected prior claims.
No new runtime option or lifecycle state.
Final remediation makes process capture optional on acquisition, normalizes
missing/null identities for conditional deletion/restoration, and checks identity
in the reaper's legacy age selector. Full-snapshot update CAS remains exact.
Pending reclaim accepts the existing process-capture seam; regression coverage
confirms it already rejects verified reused PIDs before raw liveness fallback.

## Verification

Each test command ran individually under the required network guard through
`python3 -m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 600 --command`:

- `node --test test/ama-closer-lease.test.mjs`: 38 passed.
- `node --test test/ama-dispatch-submitter.test.mjs`: 14 passed.
- `node --test test/finalclose-01.test.mjs`: 75 passed.
- `node --test test/recovery-reaper.test.mjs`: 108 passed.
- `npm run lint`: zero errors (153 existing warnings).
- `npm run typecheck:contracts`: passed.
- Scoped `eslint --fix` and `git diff --check`: passed.

Only touched test files were run, as required by the ticket. The reaper suite
now imports the existing synthetic load fixture so direct execution does not
scale its expected deadlines with host load. No live recovery was performed.

Final-round validation uses `bash bin/run-bounded.sh --timeout 120 -- node --test
test/ama-closer-lease.test.mjs test/recovery-reaper.test.mjs` (42 lease tests and
109 reaper tests passed), scoped ESLint (zero errors), contract typecheck,
data-model catalog validation (91 entries), and `git diff --check`.
The closer-lease state projection remains identical; lifecycle states,
transitions and existing smoke/post-deploy promises are unchanged.
Additional CI repair aligns older live-owner/age fixtures and process-read
counts with acquisition-time identity capture. The raw-evidence fixture now
records the predecessor identity before simulating PID reuse. The disposable
smoke supplies complete synthetic process absence instead of observing its own
live runner. The closer-lease declaration now matches the existing README
description, with its independent graph snapshot refreshed.

- Targeted runner selection (`test/hamclose-ownership.test.mjs`,
  `test/leaseciproof-01.test.mjs`, `test/load-aware-operational-waits.test.mjs`,
  `test/noowner-01.test.mjs`, `test/ama-closer-dispatch-priority.test.mjs`):
  484 passed under `bash bin/run-bounded.sh --timeout 180 -- node test/run-tests.mjs`.
- `test/finalclose-01.test.mjs`: 75 passed.
- `test/smv.test.mjs`: 11 passed, including the disposable-Git smoke.
- `npm run lint`: zero errors, 153 existing warnings.
- `bash demo/research-finding-walkthrough.sh`: passed offline byte equivalence.

## Final HAM adjudication

All four final non-blocking findings were checked against the remediated head.
The reaper verifies start identity before retaining a reused PID, conditional
lease deletion/restoration equates omitted and null identities, and acquisition
rejects invalid PIDs and tolerates capture failures. The pending-reclaim finding
is withdrawn: the shared identity-aware abandonment check runs before the raw
PID fallback; its regression covers matching and reused identities both with
and without a dispatch timeout. Full-snapshot update CAS intentionally remains
exact, preserving stale-observation protection.

HAM validation passed the targeted closer lease, recovery reaper, watcher claim
loop, closure ownership, and dispatch priority suites through
`hammer-validate.mjs`, plus `npm run lint`, `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh`, and
`node scripts/validate-data-model-catalog.mjs`. The full suite remains the
exact-head remote CI authority. No runtime behavior changes in this final note.
