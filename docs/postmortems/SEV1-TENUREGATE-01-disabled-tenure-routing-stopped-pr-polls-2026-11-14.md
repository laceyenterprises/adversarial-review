# SEV1 — disabled tenure routing stopped ordinary PR polls

Date: 2026-11-14. Ticket: TENUREGATE-01. Severity: SEV1.
Status: source correction and offline qualification; deployed recovery is unverified.

scars: merge.finding-remediation-and-authoritative-terminal, config-schema.multi-loader-parity

## Impact and evidence

The supplied incident probe reports 63 `tenure review routing deferred` warnings
with `tenure-build-launch-unavailable` across nine open PRs in approximately
35 minutes after watcher activation at 22:37 UTC. Only three reviews posted
fleet-wide during that window. Two pending re-reviews did not spawn, closer
ownership expired repeatedly on another PR, and both parts of an open SEV0
repair were affected. The effective fleet tenure setting was disabled.

Counts and timestamps are supplied evidence; no live state was modified.

## Sequence and cause

[TEN-06](../changes/TEN-06.md) introduced the path, reportedly merged at
approximately 22:08 UTC and activated by the 22:37 UTC restart. Every nonterminal
code PR with an existing row attempted `readPrTenure` without consulting the
fleet switch. An unavailable opener-launch read threw; the catch warned and
returned from the whole handler before review dispatch, re-review and closure.
Each poll repeated the read and early return. Optional, bounded continuity with
rollback was the commissioned contract. Unknown evidence was handled correctly;
the unconditional read and whole-handler return violated that boundary.

## Correction

The existing config loader now exposes the already established
`worker_pool.tenure.enabled` leaf, default false, and its conventional
`AGENT_OS_WORKER_POOL_TENURE_ENABLED` projection, preserving config precedence.
The Python and shell readers already expose the key; no companion change is needed.

The watcher and shared reader honor the switch, including closure/remediation
consumers. Disabled routing performs no tenure reads or tenure-specific queueing.
Enabled lookup failures warn once per repository/PR/head per watcher process,
skip the tenure step and continue ordinary handlers. Suppression receives the
cached failure, preserving unknown tenure and active-writer custody without
certifying a closer exemption. Successful tenured reads retain the existing
independent exact-head review request, family exclusions and claim CAS.
Merge eligibility, terminal transitions, budgets and checks remain unchanged.

## Secondary diagnosis and follow-up

Read-only source and entitlement inspection found different read scopes:

- Stable opener identity uses the public `provenance` observation, which accepts
  a repository-wide `provenance_repositories` entitlement across projects.
- Exact `launch_request_ids` lookup in the canonical dispatch producer accepts
  app-owned registry launches or exact `(project_ref, repo)` grants. It filters
  out provenance-only grants before authorizing launch rows.
- The review-app entitlements grant repository-wide provenance but limited
  project-specific dispatch reads. Other-project openers can be visible as
  provenance while exact launch lookups are filtered, not confirmed absent.

Relevant producer sources in agent-os are
`platform/session-ledger/src/session_ledger/canonical_views/app_worker_observations.py`
(`fetch_worker_observations`) and `app_dispatch_reads.py`
(`fetch_app_dispatch_reads`, grant filtering and `owned`). The producer's
`public` projection already includes an available payload `tenureId`, so the
inspected source does not support a missing-field explanation. It does not
establish which producer revision was loaded during the incident.

This structural grant mismatch explains visible openers with unavailable exact
launch reads. The nine opener rows were not individually re-queried; other
transport or deployed-version failures remain possible. Follow-up: qualify a narrowly
authorized stable-opener tenure read across project boundaries, with synthetic
authorization fixtures and deployed-revision evidence. Do not broaden ordinary
launch visibility or reinterpret a filtered reply as absence. This secondary
producer repair is separate from restoring the optional watcher boundary.

## Qualification and runtime ownership

Synthetic regressions cover disabled/default-off no-read behavior, enabled
failure dispatch and closure continuation, no tenure queue write, unknown
suppression, warning deduplication and unchanged enabled routing. Config
precedence, invalid booleans and writer custody are covered too.
The [change note](../changes/TENUREGATE-01.md) records results.

Memory searches returned no records. Supplied hardening history informed
sibling suppression and config checks: unknown ownership still refuses exemption;
the loader mirrors an existing setting. Runtime recovery remains unverified.
Normal deployment and passive organic review/closure observation belong to
the runtime owner; this PR performs no restart, retrigger or backlog mutation.
