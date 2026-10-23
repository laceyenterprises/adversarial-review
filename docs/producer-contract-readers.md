# Producer evidence in the review consumer

Portable artifacts are pinned to producer revision
`f54169eb71c6f0b55b51d3025dd435c88652277e`, including its repaired fleet
capture scenario. The scenario invokes the real quota-input publisher before
reading status JSON, using disposable state and fake external transport. See
[validation evidence](validation/prm-06.md).

The review service reads five existing producer boundaries without depending on
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
Producer values in quota diagnostics are limited to 200 characters. Diagnostic
lists are deduplicated and limited to 20 entries of at most 500 characters before
account holds, closer audits and reviewer logs persist them. Malformed dispatch
status output retains its last 1,000 characters for investigation; blank stdout
is consistently identified as `$stdout empty`.
Existing malformed-input exceptions still throw, now naming the producer field.

Weekly percentages still accept the documented old status/confidence shapes
and numeric-string compatibility. The pre-repair `measurement` fallback remains
for floors without `weeklyMeasurementReason`. Current producers explicitly name
unavailable weekly evidence with that field: a five-hour measurement does not
replace their absent, stale or invalid weekly object. Presence of the reason
key, even with a null value, disables that fallback. This narrows admission:
accounts previously admitted through short-window evidence now hold with
`codex-account-evidence-unknown` until weekly evidence is measured. Reserve
thresholds and account order are unchanged.

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

Dispatch status probes preserve the dispatch/worker vocabulary and producer
diagnostics without interpreting them as launch-row statuses. Caller-owned
terminal policy sets fail loudly at module load if generated producer vocabulary
no longer recognizes a required terminal status. Each required policy entry is
asserted before producer terminality filters the set, so a vocabulary refresh
cannot silently remove retry, remediation or reviewer terminal handling; legacy capacity aliases remain
explicit caller policy. Quota deferral logs deduplicate on routing state, reason
and sorted diagnostic field paths, retaining changing values only in the emitted message.

Dispatch receipt identity aliases retain each caller's existing precedence and
permissive compatibility behavior; whitespace-only aliases are skipped so a
later non-empty identifier can be used. Banners and legacy text parsing remain
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
All copied owner captures are byte-identical; this repository adds no redactions.

Relative links inside copied owner records resolve against their `source` path
in `provenance.json` at the pinned agent-os revision. The publication directory
deliberately vendors only six adapter-envelope captures; policy, completion,
disposition, drift and backfill examples listed in the owner README are
intentionally not vendored. `repaired-expired` and `repaired-five-hour-only` are
byte-identical because the producer collapses both to `no-weekly-window`;
consumer tests assert this equivalence rather than claiming distinct shapes.
The ready, degraded, disabled and unavailable fleet captures share identical
`providerStatuses` and `reserveFloors`; an equality test makes recapture drift
explicit. All their reserve floors are paused; "ready" names broker readiness,
not account admission. Positive Claude admission uses `fleet-released`; a
labelled consumer mutation of `fleet-ready` changes only OpenAI probe states to
healthy to exercise current-shape Codex admission.

`quota/fleet-released.json` is an additional consumer-side capture of the pinned
producer, with its hash and input provenance in `released-provenance.json`.
It runs the owner's real fleet capture scenario with fresh 20%-used short
windows, 25%-used weekly windows resetting in six hours, and healthy Anthropic
status-store inputs. Real reserve release, input publication and fleet
serialization execute over disposable SQLite/files; external broker/review
transport stays stubbed and sockets are forbidden. Only scratch path prefixes
are normalized. A positive personal Claude test uses this output after local
corporate exhaustion. Reproduce using the producer's Python test dependencies:

```bash
python3 scripts/contracts/capture-released.py /path/to/pinned-producer-archive
```

Create that archive with `git archive f54169eb71c6f0b55b51d3025dd435c88652277e
modules/worker-pool/lib/python platform modules/token-budget/lib/python
modules/hq-control-plane/server` in agent-os and extract it into a disposable
directory. This extra capture is maintained separately from the copied owner
artifacts and is not rewritten by `refresh.py`.

With the declared companion checkout at the pinned revision, run from this
repository root:

```bash
python3 scripts/contracts/refresh.py ../agent-os
```

The refresh command requires exactly one source checkout path; missing or extra
arguments print usage to stderr and exit with status 2 before copying artifacts.
Refresh removes stale managed JSON/owner records and definition excerpts, while
preserving the separately maintained `quota/fleet-released.json` capture and its
provenance. Deleted or renamed producer artifacts therefore cannot remain as
untracked evidence in a managed capture directory.

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

## Activation and verification

`operator_steps`: Before activating a superproject submodule bump or deploying
these readers, run the read-only `hq fleet quota status --json` on the deployed
producer. Require both `openai-oauth` and `openai-oauth-corp` reserve floors to
contain a non-null `weeklyMeasurement` with `status: "measured"` and a finite
numeric `percentRemaining` in [0, 100]. Inspect each account's provider probe
state and matching broker provider readiness/servability separately; weekly
capacity alone does not admit an account. If either weekly check fails, keep
activation held until the producer publishes current weekly evidence.

This is a required pre-activation check, not an instruction to restart a
service. Long-running consumers load the readers at their next normal
operator-managed deployment/reload; no migration or configuration flip is
required. After deployment, repeat the same read-only check and inspect routing
hold reasons. Weekly expiry or reset can produce `no-weekly-window`, which
holds the affected account with `codex-account-evidence-unknown` until the next
successful weekly probe; unknown evidence alone does not trigger AFH model
fallback. A reason key must never promote short-window evidence to weekly
capacity. Existing lifecycle states and offline smoke promises are unchanged.


LRQSTATUS-01: launch status meanings come from the pinned producer vocabulary
(`hq api spec --surface producer-contracts --format json`, contractVersion 1.x).
Boolean wire `terminal` and `succeeded` values take precedence when present;
status-only ledger rows use the producer definitions. `blocked_needs_decision`
and vocabulary-defined `blocked_`/`waiting_` states are parked: they consume no
closer capacity and settle an active lease as terminal `deferred`, but their
unchanged dispatch identity still owns the PR. They cannot be reclaimed,
redispatched by ordinary or orphan recovery, or lose their scratch directory
while parked. Parked observations are re-read rather than cached as final.
A later resolved producer status restores the existing retry/settlement policy.
Producer terminality alone is not child-exit or ownership-release authority:
`blocked_needs_decision` is itself terminal in the producer vocabulary, including
when the wire explicitly reports `terminal: true`. A live wire-only observation
without a status string retains ownership and uses an `unknown` wait reason.
The legacy stored spellings map through producer values: `completed` →
`succeeded`, `cancelled` → `canceled`, `reaped` → `reaped_stuck_requested`,
`rejected` → `failed`. These aliases supply no new retry authority. Unknown
status-only evidence remains unknown. No new durable states or fields are added.
