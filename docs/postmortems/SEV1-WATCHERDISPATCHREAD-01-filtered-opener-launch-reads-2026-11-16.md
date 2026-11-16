# SEV1 — filtered opener launch reads stopped closer dispatch

Date: 2026-11-16. Ticket: WATCHERDISPATCHREAD-01. Severity: SEV1.
Status: Phase 0 confirmed; report only. Producer repair and recovery remain unverified.

scars: merge.finding-remediation-and-authoritative-terminal, adversarial-review.verdict-bound-to-current-head

## Impact

The supplied incident probe reports 64 `tenure-evidence-unavailable` decisions
across eight PRs after tenure activation around 03:44 UTC. All named
`tenure-build-launch-unavailable`; no subsequent closer launch was observed.
The last reported closer merge was at 02:22 UTC. Tenure rollback is the
operator's mitigation, not a change performed by this ticket.

The same dependency had already been failing quietly: the supplied probe
reported approximately 1,010 scratch-sweep deferrals extending to the first
watcher log line. A repair-owner reconciliation also reported
`dispatch-read-unavailable`. These sibling symptoms share the reader, but
their individual failing selectors were not reproduced in this investigation.

## Phase 0: read-only reproduction

The reproduction used this checkout's packaged SDK and reader, the service's
configured bootstrap root and default app-contract endpoint, and a fresh
registered review-app session. The service definition confirmed that bootstrap
root and did not specify an endpoint override. The probe did not borrow the
worker's own-launch HCP shortcut: its local environment cleared that identity
so both asynchronous and synchronous calls used the service app's session.
No live watcher, configuration, reviews database or ledger was modified.

An affected PR was selected from a structured closure-blocker log event.
`readDaemonBuildIdentity` returned `ok: true` and one stable opener provenance
row. Both readers then queried that row's exact launch identity. The following
request substitutes a synthetic identifier for the observed identity:

```json
{"launch_request_ids":["lrq_00000000-0000-4000-8000-000000000001"]}
```

The app-contract `POST /v1/dispatch/lookup` response had this exact shape:

```json
{
  "schema_version": 1,
  "status": "not_found",
  "roots": [],
  "items": [],
  "retry_edges": [],
  "complete": true,
  "scope_complete": false
}
```

There was no producer `reason` or `absence_proof` field. SDK
`readDispatchLookupResult` accepts this envelope as available, with
`found: false`. The consumer's `completeAbsence` correctly refuses to treat it
as authoritative absence. Both `readDispatchLaunches` and
`readDispatchLaunchesSync` returned:

```json
{
  "ok": false,
  "reason": "dispatch-read-unavailable",
  "detail": "dispatch absence scope unproven"
}
```

This is the unproven-absence branch, not unavailable transport, SDK envelope
rejection or registration failure. Registration succeeded. Three other launch
identities from historical watcher logs returned `found`, with one item each,
through the same session and both readers. A separate control read of the
worker's known own launch returned one row through its provisioned HCP scope;
the app session returned filtered emptiness for that identity. The HCP control
does not authorize borrowing worker credentials for service reads.

A fresh log count found 1,011 scratch-sweep deferrals, 88 occurrences of
`tenure-evidence-unavailable` and 30 occurrences of
`Tenure review evidence unavailable: tenure-build-launch-unavailable`.
These are literal string counts over the available log, not distinct PR or
dispatch counts, and should not be conflated with the supplied incident probe.

## Defect ownership and repair handoff

The defect is on the producer authorization/read-model side. Stable opener
provenance is visible to the app while the corresponding exact launch is
filtered. The earlier
[tenure incident report](SEV1-TENUREGATE-01-disabled-tenure-routing-stopped-pr-polls-2026-11-14.md#secondary-diagnosis-and-follow-up)
already identified the structural mismatch: repository-wide provenance grants
and app-owned or project/repository-specific dispatch grants have different
coverage. This reproduction confirms the resulting refusal for an affected
opener; it does not establish the producer's loaded revision or inspect its
private implementation.

Stop reader-side implementation here, as required by Phase 0. Dispatch a
producer repair for the app-contract dispatch lookup endpoint and its grant
scope. Qualify a narrowly authorized stable-opener launch read across project
boundaries, including tenure evidence, without broadening arbitrary launch
visibility. The producer should test authorized opener visibility and denied
foreign visibility with synthetic fixtures. An empty filtered reply must
continue to retain ownership and cannot stand in for confirmed absence.

After producer repair, the runtime owner should repeat the service-session
opener probe before enabling tenure, then observe organic closer dispatch,
scratch sweeping and repair-owner reconciliation. This report performs no
activation, restart, retry, grant mutation or backlog repair. Exact reader
reason/detail propagation into tenure diagnostics remains follow-up work;
currently `readPrTenure` replaces the refusal with
`tenure-build-launch-unavailable`.

## Lessons and regression scope

A dependency that has been failing quietly becomes an outage when a new
feature makes it load-bearing. Activation qualification must exercise the new
dependency with the consuming service's actual authorization scope.

The fail-closed reader prevented missing evidence from authorizing closure.
Keep that behavior, stable opener identity, current-head verdict binding,
active-owner fences and the watcher claim CAS intact. Do not repair this by
accepting filtered emptiness, bypassing tenure, or interpreting a recent
remediation completion as the opener.

Both earned-scar searches were available and returned no matching records.
The supplied hardening history and the earlier tenure report informed the
sibling checks and the decision to retain ownership on unknown evidence.
See the [change note](../changes/WATCHERDISPATCHREAD-01.md) for offline validation.
