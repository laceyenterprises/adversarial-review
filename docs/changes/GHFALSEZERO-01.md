# GHFALSEZERO-01

## Summary

GitHub rate limits require structured response evidence. Secondary observations
preserve primary remaining and hold a separate minute-scale backoff. Long
admission holds confirm through the exact credential's `/rate_limit`; false
zeros are corrected. Reviewer 401 refresh retains the selected reviewer role.
Sibling GitHub classifiers and hammer helpers no longer accept rate-limit prose.

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

## Verification

Tests run one file at a time under netguard, each bounded to 600 seconds:

```sh
NETGUARD_LOG=<isolated-log> PATH=<netguard-bin>:$PATH \
  PYTHONPATH=<worker-pool-python> python3 -m cwp_dispatch.worker_validation \
  --repo-root . --timeout-seconds 600 --command node --test test/<file>
```

Passing scoped files: `ghfalsezero-01` (19), `rate-limit-throttle` (27),
`gh-cli-auth-outage-remint` (17), `reviewer-context-auth` (28),
`metered-gh-cli` (18), `metered-gh-sync-env` (8), `etag-cache` (13),
`watcher-github-budget` (4), `branch-protection` (18),
`ama-closer-transient-classification` (36), `ama-daemon-merge` (103),
`closergates-01` (14), `history-read-retry` (27),
`watcher-claim-loop` (180), `duplicate-content` (5),
`github-budget-credentials` (16), `watcher-auto-refresh-stale-posted-review` (47),
`ama-hammer-background-dispatch` (148), `msm-04-single-route` (25).
Confirmation-probe refusals retain their structured cooldown and core resource
attribution; fixtures cover both core and GraphQL admission.
Shellcheck: no new warning-or-higher findings versus origin/main in the four
changed hammer scripts (existing counts 38/19/0/27).
`npm run lint`: zero errors (existing warnings). `npm run typecheck:contracts`: passed.
Full suites and the demo were not run, following this ticket's scoped-test constraint.

Final remediation verification uses the checked-in `bin/run-bounded.sh` and
`node test/run-tests.mjs <explicit test files>` to isolate synthetic state.
The focused rate-limit, CLI, conditional-cache and daemon unit group passed
175 tests across four files. Confirmation fixtures cover GitHub.com, Enterprise,
API URL precedence, proxy-environment inheritance, User-Agent and structured
403 refusal evidence. Sync fixtures cover known long holds with missing and
healthy disk buckets. Shell syntax passed; shellcheck remains at 38 existing
warning-or-higher findings with zero additions. Catalog validation passed
98 entries and contract typechecking passed. The full local suite remains
omitted under the remediation scope rule; PR-head CI owns it.

The remaining focused group passed 81 tests across five files. Watcher claim-loop,
watcher daemon wiring and SMV checks passed 320 tests; reviewer budget fixtures
passed all eight after narrowing their immediate-deferral window to one minute
(long-hold confirmation has dedicated coverage). Total: 584 passing targeted
tests across 13 files. `npm run lint` passed with zero errors and 149 existing
warnings; `git diff --check` passed. State source projections remain unchanged.
