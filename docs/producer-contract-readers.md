# Producer evidence in the review consumer

Portable artifacts are pinned to producer revision
`f54169eb71c6f0b55b51d3025dd435c88652277e`, including its repaired fleet
capture scenario. The scenario invokes the real quota-input publisher before
reading status JSON, using disposable state and fake external transport. See
[validation evidence](validation/prm-06.md).

The review service reads four existing producer boundaries without depending on
an Agent OS checkout or a Python process at runtime. Routing, holds, retry
budgets and publication authority remain with their existing owners.

| Producer / definition | Node reader | Consumers |
|---|---|---|
| `quota_reserve.snapshot`, `ReserveFloor`, `QuotaMeasurement`, fleet `FleetQuotaPayload` | `src/fleet-quota-status.mjs` | Codex and Claude account routers; reviewer fallback; remediation and AMA harness fallback |
| `oauth_broker.server.readyz`, `ProviderState` | `src/producer-contracts/broker-evidence.mjs` | Both account routers and remediation OAuth preflight |
| session-ledger `launch_request_terminal_statuses.py` | `src/producer-contracts/launch-status.mjs` | Dispatch receipt interpretation and the existing reviewer, remediation and closer status policies |
| `cwp_dispatch.ticket.DispatchReceipt` | `src/producer-contracts/dispatch-receipt.mjs` | Reviewer HQ runtime, remediation status, merge-agent dispatch and AMA closer dispatch |
| GitHub adapter `ResultEnvelope`, `PrCreateReceiptRead` | `src/producer-contracts/publication-receipt.mjs` | Existing GitHub adapter read and publication mutation boundary |

Reader result shapes use JSDoc. Missing, invalid, stale and unfamiliar evidence
adds producer/field diagnostics to account holds, reviewer transition logs,
status results, adapter mutation results and the closer's `harnessResolution`
audit. Stable routing reason codes retain their existing meanings.
Existing malformed-input exceptions still throw, now naming the producer field.

Weekly percentages still accept the documented old status/confidence shapes
and numeric-string compatibility. The pre-repair `measurement` fallback remains
for floors without `weeklyMeasurementReason`. Current producers explicitly name
unavailable weekly evidence with that field: a five-hour measurement does not
replace their absent, stale or invalid weekly object. No reserve threshold,
account order or unknown-evidence selection rule changes.

Broker readiness and cached-token servability are separate observations. Account
routers still require both explicit booleans. OAuth preflight still accepts a
servable degraded provider, with its existing legacy `providers` boolean fallback.
Aggregate HTTP status and the provider name `google` never stand in for the
broker's registered provider `gemini`.

The launch vocabulary artifact is extracted from the producer's dependency-free
module. Terminality is distinct from success. Existing consumer policy subsets
and legacy spellings remain explicit at their callers; the closer does not gain
retry authority for blocked decisions. Worker-run, dispatch-record and
reviewer-run statuses remain separate contracts. Unknown launch/receipt statuses
carry the producer and offending field/value without a new rejection.

Dispatch receipt identity aliases retain each caller's existing precedence and
permissive compatibility behavior. Banners and legacy text parsing remain
transport shims. Neither exit zero nor a requested/running/succeeded receipt
proves delivered publication. GitHub envelope acceptance and complete reads are
separate facts; diagnostics do not add requirements to legacy responses.

There is no `hq pr open --json` or D1 publication-sidecar consumer in this
repository. The publication captures test the adapter envelope boundary actually
consumed here, including accepted creates followed by local closeout exit 3.
The service does not gain a second D1 completion classifier or PR-create route.

## Portable artifacts and exact refresh

[`provenance.json`](../test/fixtures/producer-contracts/provenance.json) pins the
Agent OS revision, source path and SHA-256 for every copied artifact. Definitions
under `test/fixtures/producer-contracts/definitions` are inert verbatim excerpts
of producer types/readers, not executable policy. The generated runtime launch
vocabulary comes from the same source module, rather than a handwritten set.
All captures are byte-identical copies; this repository adds no redactions.

With the declared companion checkout at the pinned revision, run from this
repository root:

```bash
python3 scripts/contracts/refresh.py ../agent-os
```

This copies artifacts only. To recapture, first use the exact commands and
inputs in the copied owner records below in the producer checkout, review the
producer's parity tests, then run the refresh command. Never point capture
commands at production state or perform a real dispatch/publication.

- [Quota owner record](../test/fixtures/producer-contracts/definitions/quota-producer-contract.md.txt): actual snapshot and fleet serializers over four account inputs, disposable quota files and an empty migrated ledger; fake broker/review-store transport. Includes measured, disabled, missing, short-only, expired, stale and unavailable evidence.
- [Broker capture record](../test/fixtures/producer-contracts/broker/README.md): actual broker app/cache/serializer over disposable stores with stub providers; ready, degraded, unavailable and disabled cases.
- [Launch capture record](../test/fixtures/producer-contracts/launch/README.md): actual ledger lifecycle calls and fetched rows on a disposable ledger, with no worker spawn.
- [Dispatch capture record](../test/fixtures/producer-contracts/dispatch/README.md): real enqueue/post-enqueue serializer and refusal entrypoints, disposable ledger/configuration and fake daemon boundary.
- [Publication capture record](../test/fixtures/producer-contracts/publication/README.md): actual opener closeout block and adapter serialization with fake GitHub transport and disposable Git state; no live PR creation.

The real fleet-ready example confirms corporate Claude availability. Its OpenAI
probe state is unknown despite valid weekly measurements; consumer tests retain
that distinction. Older synthetic routing scenarios remain compatibility tests,
not claims about current producer output. Missing/null/wrong-type/status
mutations of captures are explicitly labelled negative tests.

No migration, configuration change or privileged activation is required.
`operator_steps`: None. Long-running review consumers load the new readers on
their next normal operator-managed deployment/reload; this change requests no
service restart. Same-user read-only verification is `hq fleet quota status
--json`: inspect weekly object/reason, provider probe state and the matching
broker provider fields together. Existing lifecycle transitions, state/smoke
promises and enforcement policy are unchanged.
