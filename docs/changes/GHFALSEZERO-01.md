# GHFALSEZERO-01

## Summary

GitHub rate limits require structured response evidence. Secondary observations
preserve primary remaining and hold a separate minute-scale backoff. Long
admission holds confirm through the exact credential's `/rate_limit`; false
zeros are corrected. Reviewer 401 refresh retains the selected reviewer role.
Sibling GitHub classifiers accept only structured evidence or anchored gh stderr records; hammer helpers consume the reserved transport protocol.

The [SEV0 report](../postmortems/SEV0-false-github-rate-limit-2026-11-14.md)
includes the incident timeline, incorrect initial diagnosis, command-path
reproduction, unrecoverable original-output evidence gap, fleet inventory and
four named non-GitHub follow-ups. Merge this repository before its independent
agent-os companion. No live state changes or new CI gates.

The final comment-only remediation removes duplicate conditional-response
recording and shadowed retry checks. Daemon merge result wrappers retain typed
throttling evidence; the metered CLI carries it across subprocess boundaries
with a reserved stderr protocol that hammer and closer recognize. Confirmation
reuses the existing unthrottled gh seam with explicit User-Agent, API URL/host
selection, proxy environment and exact-token aliases. Fresh-main reviewer
budget deferral and allowlisted exhaustion telemetry remain intact.
HQ failures that emit only prose still need producer-owned typed evidence in
the companion; this round documents that follow-up rather than restoring
substring-based quota classification. Existing lifecycle states and smoke
promises are unchanged.

Follow-up remediation makes the daemon merge classifier accept the reserved
metered CLI stderr line before generic HTTP 403 rejection. Live budget reads
pass the configured environment into confirmation, preserving the selected
credential and enterprise/proxy routing after a watcher restart. Closure gate
cooldown math uses its injected clock.

## Interface changes

Version-2 buckets add `secondaryUntil` and `secondaryAttempts`; `remaining` may
be null for unknown secondary primary capacity. New API-log categories
`github_rate_limit` and `github_budget_confirmation` retain bounded structured
evidence. The sync bridge adds `admit` and returns recorded observations.
`GITHUB_REVIEWER_TOKEN_ENV` pins selected reviewer refresh identity.
Canonical [store contract](../data-model/github-rate-limit-state.md) is updated.

## PR update

Rebased onto main at `9fbeab377`, preserving REVIEWTHROTTLESLEEP-01 typed
pre-model deferral, FINDINGSSTATUSTIMEOUT-01 load-aware probes and TENUREGATE-01
opt-in tenure reads with ordinary poll continuation on read failure.

Both blocking review findings are covered: daemon merge accepts the metered
stderr protocol, and confirmed budget reads pass the configured environment
into a probe whose environment defaults to `process.env`. gh's anchored stderr
error records also establish limits. Debug bodies, stdout, content echoes and
maxBuffer failures cannot establish quota evidence.

Fresh response evidence replaces zero in memory and disk; peer-store snapshot
merging stays conservative. Header resource attribution wins over caller hints.
Anonymous default buckets retain their admission behavior. Urgent closer reads
use positive reserve capacity without an unnecessary probe, and unavailable
confirmation propagates deferral accounting to the enclosing scope. A review
write refused before execution propagates its budget deferral without ambiguous
write reconciliation. Existing recovery reasons and bounded shell retries keep
their retry treatment. Fixtures now use structured signals and preserve
secondary cooldowns independently of primary recovery.

## Verification

Each selected test file runs individually, bounded to 600 seconds, under:

```sh
NETGUARD_LOG=<isolated-log> PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH \
  PYTHONPATH=<worker-pool-python> python3 -m cwp_dispatch.worker_validation \
  --repo-root . --timeout-seconds 600 --command \
  node --import ./test/helpers/rate-limit-state-isolation.mjs --test test/<file>
```

The isolation preload delegates each file to the repository sandbox, preserving
synthetic state, offline executors and child-leak checking. The full local suite
is omitted under this ticket's explicit instruction; GitHub CI owns that run.

All 1,621 tests passed across 37 individually invoked files, including every
file reported failing by the supplied CI run and every changed test file.
The watcher claim-loop passed 185 tests; tenure routing passed 30 tests.
The PR update comment lists the selected files.

`npm run lint` passed with zero errors (149 existing warnings),
`npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed with byte-stable deliveries.
Shell syntax passed; shellcheck warning-or-higher findings match origin/main
exactly in the four changed hammer scripts (39/19/27/0; no additions).
SMV source projections passed unchanged; the generated data-model catalog is
left to main automation, with the canonical fragment updated here.
