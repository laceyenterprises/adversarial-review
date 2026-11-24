# Data Model - Closer Inconclusive Retries

**Owner:** the watcher's AMA closer (INCONCLUSIVERETRY-01b)
**Store:** `data/follow-up-jobs/closer-inconclusive-retries/<repo>-pr-<n>.json`
**Source of truth:** `src/ama/closer-inconclusive-retry.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closure-budget-escalation.mjs`, `src/ama/closer-supersede.mjs`

## Purpose

One JSON file per PR records the closer launches that ended inconclusively on
each head. Each entry is the owned retry: who owns it, which attempt it is, why,
and when the next ordinary dispatch is due. It grants no authority. See the
[runbook section](../RUNBOOK-ama-closure.md#inconclusive-closer-results-inconclusiveretry-01b).

## Shape (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "repo": "owner/name",
  "prNumber": 1,
  "owner": "watcher",
  "heads": {
    "<headSha>": {
      "owner": "watcher",
      "attempt": 3,
      "reason": "checkout-failed",
      "lastAttemptAt": "ISO-8601",
      "nextAttemptAt": "ISO-8601",
      "deadline": "ISO-8601",
      "surfaceAfterAttempts": 3,
      "surfacedAt": "ISO-8601 or null",
      "reviewServiceRevision": "git:<sha> or null",
      "launches": [{ "launchRequestId": "lrq_...", "reason": "checkout-failed", "at": "ISO-8601" }]
    }
  }
}
```

The file keeps the eight most recently attempted heads and 32 launches per head.
Writes are atomic. Recording is idempotent per launch. An unreadable file reads
as corrupt and is preserved for recovery. When the watcher observes an ended
inconclusive launch for the live head, it logs `retry-record-unreadable`, holds
that retry, and issues a deduplicated closure-wait notice. Restore a validated
record through the runtime owner before retrying. A new head requires its own
ended-launch evidence. Matching unsafe custody evidence still holds its own head.
`closure-budget-escalation` reads `launches[].launchRequestId` across heads and
refunds each open series charge whose launch is listed (CLOSERRETRYREFUND-01:
per charge, not only when every charge is listed). It also records launches it
proves were closer faults from the AMA audit, and `closer-supersede` records a
launch the pipeline cancelled before it booted (reason
`superseded-by-clean-exact-head-review`).
Dispatch also records ended `canonical-validation-deferred` launches here,
including full infrastructure refunds. Optional `sourcePublished: true` records
launch-bound publication. Optional `launches[].custodyRequired: true` records an
active unsafe custody hold for fallback if its marker disappears. Legacy entries
without explicit custody evidence do not create operator holds. Readable holds
with clean matching-target source and confirmed cleanup resume ordinary per-head
backoff and once-only notification. Corrupt retry files remain preserved for
recovery; admission holds only heads with matching unsafe custody evidence.

`reviewServiceRevision` (optional, CLOSERRETRYREFUND-01) is the service revision
that recorded the entry's latest launch. When the running revision differs, the
dispatch gate releases that head's backoff once. Entries written before this
field existed carry no revision and are not released.
