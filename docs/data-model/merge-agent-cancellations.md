# Data Model - Operator Merge-Agent Cancellation Receipts

**Owner:** Follow-up merge-agent operations
**Store:** `data/follow-up-jobs/merge-agent-cancellations/`
**Source of truth:** `src/merge-agent-cancel.mjs`
**Runtime surface:** `src/follow-up-merge-agent.mjs`, `src/ama/receipted-closer-alias.mjs`

`npm run merge-agent:cancel` atomically writes one receipt per completed
attempt. The filename includes sanitized repository, PR and request timestamp
segments, with a numeric suffix for collisions. Version 1 receipts have kind
`adversarial-review-merge-agent-cancellation` and record `requestedAt`,
`requestedBy`, `reason`, `repo`, `prNumber`, `hqPath`, `lifecycleCleanupQueued`
and `result`.

`result.launchRequestId`, `result.cancelled`, and `result.labelRemoved` describe
the immediate merge-agent cleanup. The optional `result.closer` describes AMA
settlement with `released` and `reason`, plus `launchRequestId`,
`dispatchHeadSha` and `leaseHeadSha` when known. A release records
`launchStatus`, `failureClass` and `source` from terminal App SDK evidence.
Receipts without `result.closer` are valid, including older receipts.

`result.cleanupComplete` requires terminal merge-agent cleanup, including label
removal, plus release when `result.closer` is present. `result.retryable`
includes failures from either path. An attempt with any closer disposition
leaves PR-wide watcher cleanup queue records alone.
