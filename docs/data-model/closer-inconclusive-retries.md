# Data Model - Closer Inconclusive Retries

**Owner:** the watcher's AMA closer (INCONCLUSIVERETRY-01b)
**Store:** `data/follow-up-jobs/closer-inconclusive-retries/<repo>-pr-<n>.json`
**Source of truth:** `src/ama/closer-inconclusive-retry.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closure-budget-escalation.mjs`

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
      "launches": [{ "launchRequestId": "lrq_...", "reason": "checkout-failed", "at": "ISO-8601" }]
    }
  }
}
```

The file keeps the eight most recently attempted heads and 32 launches per head.
Writes are atomic. Recording is idempotent per launch. An unreadable file reads
as corrupt and is rebuilt on the next record; at worst that delays a backoff.
`closure-budget-escalation` reads `launches[].launchRequestId` across heads to
decide whether a spent series budget was spent only by inconclusive launches.
