# Data model — Queue canary observations

**Owner:** v2 finalization port / rollout operator
**Store:** runtime-owner-maintained `data/finalization-queue-canary.json`, schema version 1, at most 1 MiB
**Source of truth:** `src/finalization/queue-canary.mjs`
**Runtime surface:** `src/finalization/queue-probe.mjs`

No runtime writer is installed. The probe only reads this artifact and the real
`reviews.db`; it cannot create a lane, converge schema, dispatch, page or transfer
ownership. This is observation data, not another configuration selector or policy.

The operator assembles the record from retained deployment/process observations,
organic entry observations and isolated recovery transcripts. Install the record
atomically under the runtime owner after retaining its prior version with the
rollout record. Never place private rollout inputs, real lane identity, tokens,
broker output or host details in the public repository. `sourceRef` identifies a
durable evidence artifact; it must not contain credentials. References are not
fetched or independently authenticated by the probe. The operator owns their
truth, retention and review; an observation record is not a signed attestation.

| Field | Contract |
|---|---|
| `schemaVersion` | Exactly `1`. |
| `lane` | Canonical `{repository, base}`, supplied privately by the operator. |
| `window` | `{from, to}` timestamps, increasing and ending no later than probe time. |
| `deployment` | `observedAt`, `validUntil`, `sourceRef` for the complete deployment observation. A single top-level PID/build is not sufficient. |
| `deployment.writers` | Complete array of deployed writer processes, each with `service`, positive integer `pid`, `build`, `configGeneration`, `observedAt`, `validUntil`, `sourceRef`. Include every watcher/follow-up instance and other active helpers. Required services are exported as `CANARY_WRITER_SERVICES` (`watcher`, `follow-up`). Every writer must match observer build and resolved config; missing services, stale observations or malformed records keep preflight pending. |
| `deployment.inventory` | `legacyWriters` count including old/external writers, plus the same observation timestamp/deadline/reference fields. Registered DB writers are checked independently. |
| `deployment.producers` | Records with `kind`, actual resolved `adapter` identity and observation timestamp/deadline/reference fields. Required kinds are exported as `CANARY_PRODUCERS`. |
| `deployment.identity` | `result: verified` with observation timestamp/deadline/reference fields for the installed merge identity/attestation surface. |
| `entries` | `{entryId, source: organic, sourceRef}` observations. Unique IDs count once; the reader joins stored clean/remediated receipts and live admission provenance in the same lane/window. |
| `recoveries` | One record per `CANARY_RECOVERIES` ID, with `environment: isolated`, `result: passed\|failed\|unknown`, `observedAt`, `sourceRef`, `build` matching the observer. Missing/duplicate/future/unsourced or different-build results remain unknown. |
| `rollback` | The same isolated result fields including matching `build`; `noOverlap: true`, `lostHandoffs: 0`, `duplicateHandoffs: 0`, `pendingReturns: 0`; `steps` contains every `CANARY_ROLLBACK_STEPS` ID once in order, each with sourced isolated result fields and nondecreasing timestamps. |

Deployment, writer, inventory, producer and identity observations expire after at most
five minutes: `observedAt <= now < validUntil <= observedAt + 5 minutes`.
This fixed freshness rule is never load scaled. Renew observations by observing
the deployed process again, never by extending an old record's deadline.
Owner expiry and entry patience are read without scaling or resetting either.

`resolveQueueCanaryAdapter` resolves actual routing, admission, event, operation,
delivery and shadow statements. It reads a single DB snapshot, borrowing the
read-only shadow adapter on that connection. Shadow readiness uses a seven-day
window plus the existing full-table `readCoverage()` aggregate without loading
historical payloads. Metrics load only selected entries' lifecycle events through
probe time (including history before the metric window). The outer probe
verifies the shipped queue/routing/shadow schemas and resolved adapters. No new
DB table or config key is introduced. Missing/incompatible schemas report
capability unavailable. Missing/malformed evidence files yield available reader
capability with pending observations; invalid lane/window data reports unavailable.
Wrongly shaped collections or non-object collection items remain pending with
`operator-evidence-malformed:<field path>` diagnostics; invalid entry items are
rejected and invalid recovery/rollback items remain unknown. Raw parse/auth
diagnostics are not printed. Only an explicit `canary` capability request reads
this artifact or emits `rollout`; other capabilities omit private rollout inputs.

`rollout.canary.entries`, `clean` and `remediated` count unique observed organic
entries whose acknowledgement and live admission both fall inside the window,
with a stored matching receipt and live subject source reference. Unknown,
foreign, synthetic, out-of-window or unreadable receipts are excluded and listed
in `rejected`. This is an operator-observed sample, not an independent claim
that all historical DB rows are organic. `outcomes` describes current stored
phases; counts include admitted entries still in progress, not just merges.

Metrics reuse `buildQueueShadowMetrics` over the selected entries' durable
acknowledgement/progress histories. They retain the exact window, entry and service
sample denominators, null service mean without completed service, arrival/merge/
return rates, oldest ready age, CI wait, infrastructure park and hold/permission
time. Observe whole-lane status separately for backlog outside the sample.
`pendingDeliveries` covers the whole lane and stays visible after lane release.

`preflight` compares each inventoried process with the observer build and resolved
config, checks the complete writer inventory and required producers, existing
unmodified seven-day shadow readiness, unresolved operations and stale actionable
deadlines.
The artifact cannot prove a process is alive: the operator must supply fresh
process/service evidence. The route's `runtime_json` (exposed as
`preflight.running`) is only the latest writer hint: a mismatching build is flagged as `last-writer-build-mismatch`, but
a matching build never proves that other writers match. An unlisted CLI PID with
the expected build does not invalidate the inventory. Owner ID/generation churn
is reported in `preflight.owner` without requiring equality to process evidence;
active owner expiry still blocks readiness. A registered runtime alone is
historical evidence.
Preflight can be read before activation; it neither transfers nor enables a lane.

`recoveryComplete` and `rollbackRehearsed` derive only from the explicitly sourced
isolated outcomes. `status: complete` additionally needs a current queue route,
ready preflight, at least 20 organic entries, both admission types, no rejected
observations and no pending return acknowledgements. Otherwise `status: pending`
lists the missing evidence. Every result remains observation only; explicit
operator approval is separate and is never recorded by this reader or a worker.
