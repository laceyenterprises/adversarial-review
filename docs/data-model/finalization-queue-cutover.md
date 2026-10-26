# Data model — Queue expansion observations

Owner: v2 finalization port / rollout operator. Source:
`src/finalization/queue-cutover.mjs`; read surface:
`node src/finalization/queue-probe.mjs --capability cutover --json`.

The operator atomically installs `data/finalization-queue-cutover.json` (schema
version 1, at most 1 MiB), retaining previous versions privately. This artifact
is observation data, never routing configuration. It uses the lane, window,
deployment, entries and rollback shapes from the
[canary contract](finalization-queue-canary.md). Lane identity comes from private
operator inputs. Source references identify retained evidence; the probe neither
fetches nor authenticates them. The operator owns their truth and review.
No runtime writer, database migration or configuration key is added.

Additional fields:

| Field | Contract |
|---|---|
| `canaryApproval` | Prior explicit operator result `approved`, `principal`, `observedAt` no later than expansion window start, durable `sourceRef`. This references approval; the probe cannot grant or record it. |
| `deployment.queueOwner` | Fresh sourced process observation: `build`, `configGeneration`, `service`, positive `pid`, `ownerId`, `generation`, `routeGeneration`. Service/PID joins an inventoried writer; owner fields join the current lane row. An idle owner has null `ownerId`. Active owner expiry remains fixed policy. |
| `closerReleases` | One sourced record per sampled remediated entry: `entryId`, `ackId`, closer `launchRequestId`, observed runtime `build`, `releasedAt`, `observedAt`, `workerReleased: true`, `closerLeaseReleased: true`, `sourceRef`. Release must follow durable ack and strictly precede the first stored `waiting-checks` event; observation follows release and is no later than probe time. Duplicate, missing, foreign, future or late records remain unproven. |

The reader resolves real routing, admission, shadow, event and merge-receipt
adapters and reads them in one transaction. It reuses existing preflight,
shadow-readiness and ordered isolated rollback/reactivation rules. Expansion
counts unique sourced organic admissions in the declared window, without imposing
a second twenty-entry canary requirement. At least one sampled remediated closer
with stored CI history is required to establish release; an empty set cannot
prove that closers released. Every sampled remediated closer must be accounted for,
including unfinished entries. No new waiting or polling is introduced.

`rollout.expansion` exposes:

- `route`: `queue-v2` only when effective/configured route, fresh writer census,
  loaded builds/config, producer/identity/shadow readiness and running owner match.
  A mismatch, missing evidence or a transfer yields null.
- `legacyWriters`: zero only with fresh complete external/old-writer inventory
  and zero unresolved registered writers. Unproven absence is null.
- `confirmedReceipts`: count in the organic sample with an immutable merge receipt
  whose digest, entry/ack, original admission digest, candidate/base, green complete
  check snapshot, persisted eligible decision, squash result and attributed bot
  agree with the store. This validates stored evidence, not live GitHub state or
  cryptographic signatures anew. Original admission validation is reused.
- `closersReleasedBeforeCi`, per-entry `closerObservations`, bounded-by-artifact
  receipt sample, rejected receipt IDs, metrics and their sample denominators.
- `status: pending|complete` and `pending`: approval, rollback, delivery backlog,
  missing observations, rejected receipts and unresolved evidence remain visible.
  The documented JSON predicate is an observation assertion, never approval.

Fresh process observations use the existing fixed five-minute bound, unscaled.
Observer build fingerprints include the queue closer code and prompt. The digest
identifies observer bytes; the sourced inventory identifies loaded processes.
Runtime registration is only a last-writer hint. Missing artifact or organic
receipts leaves capability available with pending evidence; incompatible
store/schema/lane/window reports unavailable. Other capability requests do not
read or emit private expansion inputs. The read-only probe never migrates,
submits a handoff, releases a resource, mutates a lane or manufactures evidence.
