# Data Model - Closer No-Delivery Ledger

**Owner:** AMA closer repeat no-delivery suppression (CLOSERRETRY-01)
**Store:** `data/follow-up-jobs/closer-no-delivery/<repo>-pr-<n>.json`
**Source of truth:** `src/ama/closer-no-delivery.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/reset-pr.mjs`

## Purpose

One JSON file per PR records closer attempts that ended with the PR open and
its head unmoved (no merge, no push), keyed on `(head, failure class)`. The
closer gate refuses a third dispatch once a class has ended two attempts on one
head. See the
[runbook section](../RUNBOOK-ama-closure.md#repeated-no-delivery-closer-attempts-closerretry-01).

## Shape (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "repo": "owner/name",
  "prNumber": 1,
  "heads": {
    "<headSha>": {
      "latestClass": "crashed",
      "updatedAt": "ISO-8601 or null",
      "redriveKeys": ["approval:<grantedAt>"],
      "classes": {
        "crashed": {
          "attempts": [
            { "launchRequestId": "lrq_... or null", "attemptKey": "lrq_... | dispatch:<id> | intent:<key> | attempted:<at> | unidentified",
              "workerClass": "hammer", "observedAt": "ISO-8601" }
          ],
          "skippedCount": 1,
          "firstSkippedAt": "ISO-8601",
          "lastSkippedAt": "ISO-8601"
        }
      }
    }
  }
}
```

- **Attempt identity.** `attemptKey` is the launch request id, else the
  dispatch record's `dispatchId`, intent key or attempt time, else the fixed
  `unidentified`. A repeated poll of the same attempt is never recorded twice.
  Attempts written before `attemptKey` existed deduplicate on `launchRequestId`.
- **Skip counters.** The first skip on a key is persisted; later skips are
  persisted at most once per 15 minutes per key, so `skippedCount` counts
  persisted skips. Every skipped poll is still logged.
- **Bounds.** At most 8 heads (newest `updatedAt` first; a missing or malformed
  timestamp sorts as oldest), 16 attempts per class and 8 re-drive keys per head.
- **Unreadable file.** Reads as corrupt and blocks; writers never overwrite it.
  An operator re-drive replaces it; `npm run reset-pr` moves it into the reset
  archive.
