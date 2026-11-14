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
