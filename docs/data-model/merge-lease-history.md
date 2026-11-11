# Data Model — Merge Lease History

**Owner:** AMA daemon and hammer merge lane
**Store:** `data/merge-leases/<repo-slug>__<base>.history.jsonl`
**Source of truth:** `src/ama/merge-lease.mjs`

Holder files additionally retain optional `holderStartedAt`, captured from the
local process table at acquisition. LEASEORPHAN-01 uses the same
host/PID/start-time predicate as closer leases; a missing legacy timestamp can
still prove reuse when the observed process was born after acquisition.
Inspection reclaims a positively dead local holder through `reclaimIfStale`
and its fenced history writer. Unknown local identity retains ownership;
foreign-host deadline expiry remains the fallback at acquisition/reconciliation.
Confirmed-merged PR closeout releases only matching PR generations before
scratch removal, recording `release` with `holder-pr-merged`.

LEASEFAIR-03 records every successful grant, fenced release, dead-holder steal,
foreign-host deadline expiry, and renewal. Each version-1 JSONL row has
`schemaVersion`, `eventId`, `event` (`grant`, `release`, `steal`, `expiry`, `renew`, `requeue`, `park`),
`at`, `reason`, `repo`, `base`, `leaseId`, `holderPr`, `holderHead`, `holderPid`,
`holderHost`, `holderRole` (`closer` or `daemon`), `acquiredAt`, and `releasedAt`.
Grant and renewal rows have null `releasedAt`. Renewal preserves the original
grant time for history while the holder's `acquiredAt` remains its current fence.
Legacy holders without a role are recorded as closer; deployment must drain old
workers before relying on complete role attribution.

History uses the same per-base mutation lock as holder changes. Each logical
append uses an fsynced atomic replacement retaining the newest 4096 rows. It
never exposes a partial JSONL row. There is no migration or new configuration.
Failed history writes fail the operation; a failed grant history write rolls
back the new holder. Stale-fence releases produce no history. A crash between
holder creation and history persistence can leave a holder without a grant row;
existing dead-holder reclamation still records its identity when reclaimed.

The acquisition CLI retains up to 128 observed holder identities from the live
holder and history during a wait. Timeout output and the hammer's deferred audit
include `holders`, `closingStatus`, and the wait reason. History is bounded
operational evidence, not merge authority. A holder still cannot be preempted
merely because a local live PID has exceeded its deadline.

A fenced no-merge release also writes `requeue` (or `park` when its repeated
chargeable failure cap is reached), with reason
`re-queued after no-merge release: <failure reason>`. The ordinary release row
retains the original reason. Planned CI-wait yields use `required-checks-wait`;
outside-lease changed-surface validation yields use `local-validation`. These
are values of the existing free-form `reason` field, with no schema change.
Yields and retryable aborts record re-entry/backoff without charging the parking
count. Only daemon reservations are reinserted; a CLI re-enters on its next
invocation. These rows are scheduling evidence; they grant no
merge permission. Retry records retain counters, backoff deadline and parking
reason independently of the bounded history.
