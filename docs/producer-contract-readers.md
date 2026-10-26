# Producer evidence in the review consumer

Historical portable artifacts are pinned to producer revision
`f54169eb71c6f0b55b51d3025dd435c88652277e`, including its repaired fleet
capture scenario. The scenario invokes the real quota-input publisher before
reading status JSON, using disposable state and fake external transport. See
[validation evidence](validation/prm-06.md).

LVR-09 recordings are separately pinned to the SDK 0.4.0 release below; existing
capture provenance is retained rather than relabelled as a new recording.

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

Account routers explicitly call `reserveFloorWeeklyMeasurement`; its evidence
wrapper delegates normalization to the pinned SDK after excluding short-window
candidates for floors carrying `weeklyMeasurementReason`. The established helper
name retains this policy. Healthy admission, holds, thresholds and account order
are unchanged. Unknown evidence alone never authorizes model fallback.

### Weekly evidence and admission policy

The producer owns window meanings; SDK readers interpret evidence; callers own
admission. `readFleetQuota(payload)` preserves the original floor and its
`weeklyMeasurementReason` in `result.payload.reserveFloors[credential]`. The
corresponding `result.reserveFloors[credential].source` names the selected field.
Retain both together: a measured `measurement` is never a seven-day reading.
The repository's `readReserveFloorWeeklyEvidence` export from
`src/fleet-quota-status.mjs` aliases `readWeeklyOnlyReserveFloorEvidence`. For
current floors (those with a `weeklyMeasurementReason` key), this wrapper clears
the short-window `measurement` candidate before calling the SDK reader and
forwards `weeklyMeasurementReason` in its result. If no weekly candidate remains,
it returns `measurement: null` and `source: null`: both fields are forwarded
from the pinned SDK reader. In contrast, calling the SDK's `readFleetQuota`
on the original payload can still project `source: 'measurement'` for short
evidence. Floors without the reason key retain the
legacy fallback. The table below distinguishes raw SDK evidence from this
repository's weekly-only admission policy. No SDK replacement is required.

| Weekly input | Reason key | Other measurement | SDK evidence/source | Review weekly-only policy |
|---|---|---|---|---|
| Measured, finite percentage in [0,100] | null or present | Any | Weekly / `weeklyMeasurement` | Eligible evidence; zero still proves exhaustion |
| Null or missing | null or non-null | Measured short window | Short / `measurement`; original reason retained in payload | Hold; short capacity cannot prove weekly headroom |
| Null or missing | null or non-null | Missing, stale or invalid | Unknown or invalid, field diagnostics | Hold |
| Stale or malformed object | Present | Measured short window | Weekly retained with status/percentage diagnostics | Hold |
| Unusable or absent weekly | Absent (legacy only) | Measured | Legacy fallback / `measurement` | Existing compatibility fallback retained |
| Measured weekly | null | Any, floor disabled | Weekly / `weeklyMeasurement` | Disabled thresholds do not discard evidence |
| Measured weekly | Any | Any, account probe stale/unavailable | Weekly remains evidence | Hold under account freshness/readiness policy |

Absent reason keys and legacy confidence/status/numeric-string shapes are
compatibility inputs, not current producer captures. Malformed percentage, status
and object mutations are negative fixtures; diagnostics name the producer and
actual selected field. A missing floor remains unknown. Account readiness,
broker servability, reserve flags and account order remain independent gates.

Broker readiness and cached-token servability are separate observations. Account
routers still require both explicit booleans. OAuth preflight still accepts a
servable degraded provider, with its existing legacy `providers` boolean fallback.
Aggregate HTTP status and the provider name `google` never stand in for the
broker's registered provider `gemini`.

Launch evidence comes from the committed SDK 0.4.0 release artifact in
`vendor/`, pinned by npm's lockfile integrity. `src/producer-contracts/launch-status.mjs`
re-exports SDK readers and vocabulary sets; it contains no status interpretation.
The release bundles the public `statusVocabulary` export and runs offline without
an OS checkout, ledger, credentials or network. Install the locked dependencies
before starting the service. The older extracted JSON remains capture/refresh
history only and is no longer read by production code.

Reviewer polling, the app-contract AgentRuntime, remediation liveness and terminal
events, dispatch receipts, merge-agent probes and closer lease/retry readers use `readDispatchStatus`.
Each explicit `terminal` and `succeeded` boolean takes precedence independently,
including false; missing or invalid booleans use vocabulary fallback. Invalid
booleans and unknown statuses carry SDK diagnostics. `blocked_needs_decision`
is terminal and unsuccessful; waiting approval/input remain nonterminal.
Parked ownership and capacity follow the existing closer policy below.

Launch aliases such as `completed`, `complete`, `done`, `cancelled`, `reaped` and
`rejected` are unknown. Worker-run, reviewer-run and app dispatch-record states
remain separate contracts. Retry/rearm policy remains an explicit subset and
fails loudly if the SDK vocabulary no longer recognizes one of its terminal
members. Producer terminality supplies no additional retry or merge authority.
Transport probes retain both booleans rather than projecting a status alone.
The app-contract reader accepts the documented nested `live_status` evidence;
top-level boolean fields take precedence. Its AgentRunStatus mapping occurs only
after SDK terminality: success is `completed`, cancellation/supersession is
`cancelled`, and other unsuccessful terminal launches are `failed` (or `timeout`
when the failure class says so). Client deadline expiry remains a separate timeout.
Quota deferral logs deduplicate on routing state, reason and sorted diagnostic
field paths, retaining changing values only in the emitted message.

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

### Recorded producer examples (LVR-10)

The immutable SDK 0.4.0 release from merged producer revision
`1c60bb0f82e2924f5df7c11003a3d523917f3cc8` carries the LVR-09 recordings in
its full Node snapshot. `provenance.json` keeps their per-producer capture
versions, source revisions, shape/content hashes and fixture byte hashes under
`recorded`, plus `producerHashes` for the producer's report-only stale command.
The older `files`/`revision` pins and `released-provenance.json` retain their
independent historical provenance. A release revision can differ from a capture's
source revision: the latter identifies the producer when it was recorded.

Adopt a reviewed, merged release artifact unchanged in `vendor/`, update the
`file:` dependency and npm lockfile, then extract its recorded examples:

```bash
npm install --offline --ignore-scripts --no-audit --no-fund
python3 scripts/contracts/refresh-recorded.py vendor/agent-os-app-sdk-0.4.0.tgz 1c60bb0f82e2924f5df7c11003a3d523917f3cc8
```

The refresher reads only the tarball's public snapshot and package metadata,
verifies every recording content hash before writing, and preserves historical
captures. A missing provenance manifest starts with an empty dictionary; a
missing fixture directory is created only after input validation succeeds.
It never imports producer code or invokes a live command. Review the
artifact SHA-256 against [the release record](../vendor/README.md) and verify it
matches the release committed at the named merged revision. A refresh is not a
recapture; request changed examples from the producer owner.

JSON fixture files use the producer's compact, sorted JSON spelling, including
`1.0`, with non-ASCII characters preserved as UTF-8 bytes rather than Unicode
escapes; no trailing newline is added. Their bytes hash to `contentHash`. Token text
is extracted verbatim, including its trailing newline; its `contentHash` hashes
the JSON string encoding, while `sha256` hashes the actual text bytes. Never
derive `producerHashes` from pretty-printed JSON. Tests compare both hashes and
the parsed example against the installed SDK snapshot, and verify npm integrity.

`test/hammer-token.test.mjs` uses `github-token-refresh.v1.txt` for its shared
refresh stub. Dedicated consumer tests exercise fleet routing, registry model
selection and launch status/ownership from the other three recordings. Negative
mutations fail as `<producer> contract <version>: recorded producer fixture drift`
without embedding payloads or underlying assertion errors. Existing shell quote,
alias, expiry and routing edge cases remain labelled consumer mutations or
compatibility tests.

The fleet recording anonymizes account-map keys, so unknown account evidence
must hold even with an `ok` provider. Positive account admission remains covered
by the public reserve-floor fixtures below. There is no `worker-class show`
stdout consumer here: the test explicitly projects its `className`/`spec`
envelope into the existing registry mirror, retaining the recorded spec. The
launch test supplies the complete captured row at the ledger snapshot seam; it
does not qualify live database transport. No production source, lifecycle,
durable state, smoke promise, CI gate or service configuration changes.

The existing plan assertion `lvr-10-consumer-fixture-pinned` returns 75 until
the token fixture reaches the deployed submodule, then passes on its presence.
Normal deployment supplies the artifact; no restart, config flip or live action
is requested by this ticket. Tests demonstrate offline consumer compatibility,
not deployed activation. See [validation evidence](validation/lvr-10.md).

### Historical owner captures

[`provenance.json`](../test/fixtures/producer-contracts/provenance.json) pins the
Agent OS revision, source path and SHA-256 for every copied artifact. Definitions
under `test/fixtures/producer-contracts/definitions` are inert verbatim excerpts
of producer types/readers, not executable policy. The historical extracted launch
vocabulary records that capture revision; runtime interpretation uses the pinned
SDK release and its public export.
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
Refresh removes stale JSON/owner records only inside the five named capture
directories (`quota`, `broker`, `launch`, `dispatch`, `publication`), plus
definition excerpts. It preserves the separately maintained
`quota/fleet-released.json` capture and root-level artifacts other than the
regenerated `provenance.json`, including `reserve-floors.json` and
`released-provenance.json`. Deleted or renamed producer artifacts cannot remain as
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


Launch status meanings come from the SDK-pinned public producer vocabulary
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
The installed SDK 0.4.0 `readDispatchStatus` reader interprets its bundled
public `statusVocabulary`. Each explicit boolean wins independently, including
false; absent or invalid booleans use the vocabulary and malformed values carry
diagnostics. Launch aliases `completed`, `complete`, `done`, `cancelled`, `reaped`
and `rejected` remain unknown rather than authorizing success or retries.
Worker-run and app-owned lifecycle spellings are separate contracts. Unknown
status-only evidence remains unknown. No new durable states or fields are added.

SDK dispatch regressions use the release's public `dispatch-status` serializer
examples, covering every canonical state without copying producer source.
Labelled negative/compatibility mutations cover explicit false, missing booleans,
unknown/malformed values and removed aliases. Run the complete
`test/producer-contract-readers.test.mjs`, `test/hq-dispatch-status-json.test.mjs`
and `test/launch-request-status.test.mjs` files through `test/run-tests.mjs`, plus
the reviewer-runtime, remediation, merge-agent and closer/retry/lease consumers.
These checks do not dispatch work or prove deployed runtime activation.

See the [SDK migration validation record](validation/sdk-launch-status.md) for
scoped commands, artifact isolation and native-backend evidence limits.

### Public reserve-floor routing fixtures

`test/fixtures/producer-contracts/reserve-floors.json` projects the unmodified
`producers.reserve-floors.examples` from the public export, recording the full
export SHA-256 and producer revision. Refresh from an exported file only:

```bash
hq api spec --surface producer-contracts --format json > /tmp/producer-contracts.json
node scripts/contracts/refresh-reserve-floors.mjs /tmp/producer-contracts.json <producer-revision>
```

The shared Codex and Claude helpers use `repaired-disabled` verbatim for all
four accounts. Disabled thresholds still have measured independent weekly
windows, so healthy admission needs no invented positive percentages or flags.
Provider probes and broker responses in these helpers are synthetic transport
inputs. Near-cap, zero, stale and malformed cases are labelled consumer
mutations. Older confidence/status-only fixtures in
`reserve-floor-measurement.test.mjs` remain explicit compatibility tests.
Every helper call clones the public examples before mutation.

`weekly-evidence-policy.test.mjs` exercises both Codex routers and both Claude
accounts over the exported scenarios and negative mutations. It demonstrates
that measured short-window SDK evidence stays held by weekly-only admission,
and that the personal Claude reserve flags still hold independently of valid
weekly evidence. SDK Node/Python parity uses the same producer scenarios and
field mutations. No database reader, durable state, lifecycle transition or
smoke promise changes; no service restart or configuration flip is performed.

The [weekly evidence validation record](validation/weekly-evidence-policy.md)
lists the complete helper-consumer commands, results and baseline limitations.

## Dispatch lookup

The pinned `vendor/agent-os-app-sdk-0.9.0.tgz` supplies `dispatchLookup` and the
bounded `readDispatchLookupSync` compatibility reader. `dispatch-read-client.mjs`
adapts the producer's `schema_version: 1`, `roots`, ordered `items`, `retry_edges`
and completeness evidence. The historical launch-reader export names remain
compatibility aliases; they contain no launch SQL or backend resolution.
The controller also stops interpreting canonical/standby database settings.

Operator-provisioned app grants must explicitly name each project and
owner-qualified repository observed by CLI-origin review/closer launches.
These grants are a separate operator step for app-scoped lookups; the hammer
controller's own-launch HCP read uses its provisioned worker token and needs no
app grant. Endpoint outage or incomplete traversal means unavailable, never
absence or permission to retry.
Successful reads carry `app-contract` / `app-sdk` transport provenance, without
connection details. Settlement deadlines, lease mutation fences, parked work,
rearm, cancellation and current-head merge authority remain caller policy.

Consumer fixtures use synthetic transport replies. The committed
`test/fixtures/dispatch-lookup-v1.json` is an actual producer serialization over
synthetic disposable inputs, including an ordered cyclic retry tree and a
blocked decision. Negative identity mutations are labelled in tests. Backend
schema, claims, scope, malformed metadata and native index-plan regressions now
run at the OS producer; clients need neither database tools nor OS source.

The contained controller uses SDK `readHcpDispatchLookup` with its provisioned
worker token to observe exactly its own LRQ. The watcher keeps app-scoped lookup
for retries, leases and receipt recovery. Route selection occurs before the
read; a transport failure never switches routes or opens local state.

### Dispatch lookup activation and limits

Runtime reads require exactly `ADVERSARIAL_DISPATCH_READS_ENABLED=1` and default
off in environments without it. The tracked watcher and follow-up service
templates now carry this flag so hammer controllers inherit the activation
required by their mandatory own-launch HCP read. That read uses the provisioned
worker token; app grants remain a separate operator step and are not needed for
hammer starts. Without grants, key, ticket and receipt lookups return not-found,
which maps to `dispatch absence scope unproven` and retains ownership holds.

Before service deployment, verify the reviewed merged 0.9.0 producer release
and its artifact hashes, deploy its endpoint, and run `npm ci` in the deployed
adversarial-review submodule. Observe organic own-LRQ HCP reads and, once grants
are provisioned, app receipt/retry reads. Disabled reads return unavailable with
`dispatch lookup disabled`; they retain ownership holds and refuse hammer starts.
Rollback removes the flag from both templates and redeploys through the normal
service deployment to pause observations safely; no SQL/file fallback is
restored. Source publication does not authorize service activation.
Dispatch-only SDK exports load at read time, so an older installed SDK produces
unavailable evidence rather than preventing daemon module linking.

The SDK release is pinned to merged producer revision
`f37c7489439a8b53eafecb38870f75fe9f07fa57`; see `vendor/README.md`.
SDK 0.9.0 `not_found` is scoped to authenticated grants, and its envelope
has no authorization completeness field. The consumer therefore maps empty
lookups and missing rows within positive snapshots to `dispatch-read-unavailable`
with `dispatch absence scope unproven`. They never prove absence for terminal
lease reclamation, missing-launch capacity settlement or pre-receipt settlement.
Positive authorized launch/retry observations remain available. Even a genuinely
missing launch retains its hold until a coordinated producer contract can prove
complete scope; provisioned grants alone cannot enable absence settlement.
`--ledger-target` is rejected by the settlement CLI so it cannot misrepresent
which source was queried.

Session reuse is keyed by connection settings, excluding caller timeout. Each
HTTP request receives its own remaining budget (8 seconds by default; receipt
recovery supplies its load-aware 30-second budget). Every
connection/read failure evicts the session. Results expose the shared transient
classification and fixed secret-free diagnostics, allowing the existing receipt
owner to retry at most three times with its 100/200ms backoff; no nested retry
loop is added. A caller deadline or abort bounds settlement across registration
and lookup. SDK 0.9.0 does not accept an abort signal: its outstanding HTTP work
can outlive caller cancellation and follows SDK transport timeout handling. Full
transport cancellation requires a producer SDK update. Sync compatibility reads
are included in watcher latency summaries under `node`.

### Worker observations

SDK 0.9.0 supplies `readWorkerObservations` and its synchronous HTTP bridge.
`readWorkerObservations` validates response envelopes; it is not a session
transport method. Async observations use the public SDK
`readSessionDispatchLookup(selector, options)` on `/v1/dispatch/lookup`, as the
synchronous observation bridge does. The registered session supplies its token
and endpoint; each call supplies its remaining physical HTTP timeout. Connection
identity sorts option keys and excludes `request_timeout_ms`, so equivalent
options in different insertion orders, pagination and concurrent callers
reuse one registration without mutating a shared session timeout. Registration,
lookup and caller settlement are bounded; failures evict cached session evidence.
SDK 0.9.0 has no AbortSignal API: caller abort settles promptly, while physical
HTTP continues only within its supplied timeout.
The observation selector chooses workers, sessions or provenance on that route.
The SDK validator keys provenance by `launch_request_id`, not completion or
head: duplicate launch IDs are invalid within a page and across collected pages.
Distinct launches remain ordered even when their head/completion fields match.
An empty `scope_complete: false` result cannot distinguish missing builder
provenance from grant-filtered evidence. A valid complete empty read is
`worker-observation-inconclusive`, never an absence certificate. Builder review
intake maps this to `missing-builder-provenance` with `deferClaim:false`.
Disabled, unsupported, malformed and failed public observations likewise retain
the existing title-based cross-model review route and persist
`builder_class_inconclusive` in the existing per-head routing audit. This permits
review intake only: merge identity, lease release, teardown and accounting stay
unknown without positive authorized evidence. Explicit legacy/custom reader
claim holds retain their existing semantics.

Session time windows preserve the former ledger null semantics explicitly.
A missing/blank start satisfies an upper bound; a lower bound requires a
non-empty end timestamp or its start fallback. Rows with neither timestamp are
included without a lower bound and excluded with one, without parsing an empty
string. Timestamp comparisons are inclusive. A successful non-empty observation
whose rows all fall outside the requested interval returns `no-session-in-window`;
it is distinct from transport/grant unavailability or inconclusive empty evidence.
Historical accounting uses explicit `adapterSessionKey`/`sessionKeys` from a worker
or job. A workspace path alone never initiates a public session lookup; existing
unlinked transcript/log fallback remains separate from OS-selected accounting.

The 0.9.0 artifact is byte-identical to merged producer revision
`f37c7489439a8b53eafecb38870f75fe9f07fa57` ([agent-os#9435](https://github.com/laceyenterprises/agent-os/pull/9435)).
The fixture records the exact SHA-256/SHA-512 integrity and `releaseStatus: merged`.
The producer is merged/deployed; artifact verification does not establish app grants.

`ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED=1` is a separate, default-off, env-only
rollout gate for worker/process/session/provenance reads. It is absent from service
templates. `ADVERSARIAL_DISPATCH_READS_ENABLED=1` remains the independent DOG-09
own-launch HCP gate, already enabled in tracked templates. Do not roll it back to
stage DOG-10. No shared YAML key, loader-schema change or live flag change is part
of this work. Runtime owner verifies the deployed producer revision, SDK bytes,
project AND repository grants and organic reads before a reviewed observation
flag activation. Missing support/grants preserve title review intake but cannot
supply daemon merge identity. With observations disabled, existing positive head
attestations remain usable; otherwise daemon identity can park explicitly unknown.
There is no authorized legacy private fallback. Roll back only the observation
flag to disable DOG-10 reads, leaving own-launch HCP reads intact.

Worker/run/session IDs are opaque. The adapter consumes producer ordering,
collects up to ten pages within a bounded read budget, and treats unavailable
scope or incomplete reads as holds. It preserves null/zero usage and strips no
producer ownership requirements. Daemon identity and builder routing use the
same public endpoint with distinct producer selectors. Default PR provenance
filters `signal_kind='pr_opened'`, excludes superseded/unauthorized rows and
returns the latest single opener. Daemon current-head and head-independent
retries retain that default (no `builder_identity:true`). That builder selector
allows later completions for reviewer routing and must not identify the opener.
The producer omits `signal_kind` from the wire; adding a consumer-only field or
blindly enabling builder identity cannot impose opener semantics. Ambiguous PR
pages fail closed. Branch provenance is diagnostic-only: even a unique matching
launch can be remediation when grants hide the opener, so it cannot supply merge
identity after an inconclusive opener lookup. The immutable source and recorded
SQLite projection in `test/fixtures/producer-contracts/pr-opener-projection.json`
include simultaneous opener, later remediation, superseded and foreign records;
`provenance.json` pins source and capture hashes. Authorization is stubbed in
that capture and is not live grant evidence. Review/merge authority still requires
its existing exact-head evidence; observed process success never supplies it.
No SQL, OS config, worker-file or workspace-path fallback is permitted.

An explicit OS worker/run selector keeps usage unknown when the public read is
unavailable; accounting does not fall through to a worker log or transcript.
Local reviews without an OS worker selector retain their app-owned provider
evidence policy. Deprecated ledger-target arguments do not select a database.

Synchronous observation reads reuse an already registered SDK app session
with matching connection identity, or an explicit existing session token. Synchronous read
timeout changes reuse the cached session receipt; another endpoint cannot borrow
the cached token. Cold sync reads remain unavailable until async registration.
The reroute CLI now awaits async provenance directly and reports an inconclusive
reason on failure. The backfill CLI calls `prepareWorkerObservationSession` once
before entering its synchronous pass/closer/attribution loops; failed readiness
returns an error before writes. Disabled observations are reported explicitly;
local-only backfill can proceed, while OS-selected usage remains unknown.
Programmatic synchronous backfill callers must await preparation using matching
default connection settings. Direct synchronous observation readers can instead
supply an explicit existing session token in `connectOptions`.
Partial worker accounting remains marked partial through reviewer capture.
