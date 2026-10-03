# Data Model - Review Failure Archive

**Owner:** watcher review-state recovery
**Store:** `data/reviews.db`, table `review_failure_archive`
**Source of truth:** `src/review-state.mjs` (`ensureReviewStateSchema`, `requestReviewRereview`)
**Runtime surface:** `src/pollonce-phases.mjs`, `src/retrigger-review.mjs`

## Purpose and writes

Schema setup creates this table and its indexes before any re-arm request.
`requestReviewRereview` archives the complete failed `reviewed_prs` row when a
compare-and-swap reset succeeds, including operator-triggered failed resets.
The snapshot insert, reset, and retention pruning share an immediate SQLite
transaction. An archive or prune failure rolls back the reset so failure
evidence remains on the delivery row. A refused or raced reset adds no snapshot.

For automatic head-change recovery, the reset requires the observed failed
head to still match. It sets `review_status` to `pending`, resets
`review_attempts` to zero, clears failure and spawn evidence, and stores the new
`revision_ref`; dispatch must still pass all normal admission gates.

## Columns

| Column | Type | Contract |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Archive insertion order. |
| `repo` | TEXT NOT NULL | Repository owning the failed row. |
| `pr_number` | INTEGER NOT NULL | PR number. |
| `archived_at` | TEXT NOT NULL | Re-arm request timestamp, ISO 8601 UTC. |
| `reason` | TEXT NOT NULL | Re-arm reason; defaults to `Re-review requested`. |
| `row_json` | TEXT NOT NULL | JSON snapshot of the entire pre-reset delivery row, including failed head, attempt counts, failure message, and session/lease evidence. |

`idx_review_failure_archive_pr` indexes `(repo, pr_number, id)` for PR lookup
and insertion-order retention. `idx_review_failure_archive_age` indexes
`archived_at` for age pruning. This is diagnostic evidence, not a dispatch or
merge authority ledger; there are no foreign keys into the mutable delivery row.

## Retention

Each successful failed-row archive prunes snapshots older than 90 days relative
to the request timestamp across the table, then keeps the newest 100 snapshots
for that PR. Idle databases retain expired evidence until the next archive
write; there is no background sweep. The watcher owns this bounded diagnostic
retention. Export evidence before the retention window if longer history is
needed. Deletion reclaims SQLite pages for reuse; it does not shrink the file.

## Operator query

Inspect this archive after a head-change re-arm clears `failed_at` and
`failure_message` on the current delivery row:

```sql
SELECT id, archived_at, reason, row_json
FROM review_failure_archive
WHERE repo = 'owner/repo' AND pr_number = 1210
ORDER BY id DESC;
```
