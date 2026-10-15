# Data Model - Watcher Wake

**Owner:** watcher wake transport and subject priority
**Store:** `data/watcher-wake.json`, `data/watcher-wake-consumed.json`, `data/watcher-wake-retained.json`
**Source of truth:** `src/watcher-wake.mjs`, `src/watcher-retained-wakes.mjs`
**Runtime surface:** `src/watcher.mjs`, `bin/watcher-wake.mjs`

## Purpose

The wake file nudges the watcher to poll and gives selected PR heads dispatch
priority. It is a best-effort latency signal; ordinary polling remains the
correctness path. Each write atomically replaces the single wake file. Until
the watcher consumes it, later writers carry its subjects forward, up to the
newest 64 subjects.

## Files and fields

| Path | Shape | Contract |
|---|---|---|
| `data/watcher-wake.json` | JSON object | The current wake. `request_id` identifies a write; `requested_at` timestamps it; `reason` and top-level `repo`, `pr_number`, optional `head_sha` describe the newest request. `pending_subjects` holds the carried subjects, each with `repo`, `pr_number`, optional `head_sha`, and `requested_at`. |
| `data/watcher-wake-consumed.json` | JSON object | `consumed_key` is the last delivered snapshot key: `request_id:<id>` or a `content:<sha256>` fallback for legacy files without a request ID. The watcher atomically replaces this receipt after accepting at least one subject (or a subjectless wake). |
| `data/watcher-wake-retained.json` | JSON object | `schema_version: 1` and `subjects: [{ repoPath, prNumber, headSha }]`. The watcher atomically retains capacity-deferred wake priority by repository, PR and head; producers continue writing only the one-shot wake file. |

## Retained priority

Retained wakes survive restarts without a TTL. A changed head, terminal subject
observation or confirmed reviewer process start removes them. Failed launches
preserve priority, including fresh wakes consumed in that tick. Successful
runtime results also settle priority when an adapter has no process callback.
For subjects absent from open PR discovery, a live read confirms closure or
merge (case-insensitive states or a merge timestamp) or head movement, accepting either raw
`headRefOid` or normalized `headSha`. Absence alone and failed live reads keep
the record. A stale dispatch cannot remove a wake retained for a newer head.
Malformed records and write failures do not refuse ordinary reviewer admission.

The per-tick priority discovery barrier is separate from this durable record.
It drops subjects that cannot enter that tick's candidate queue without
discarding their retained wakes; see the
[discovery dispatch contract](../RUNBOOK-review-queue-depth-failover.md#what-it-does).

## Consumption and expiry

- A writer carries subjects only when the current wake's snapshot key differs
  from the receipt. A missing or unreadable receipt leaves subjects unconsumed.
  A failed receipt write does not stop the wake; later writes may carry its
  subjects until another read succeeds.
- The watcher reads each changed wake signal. It strips subject priority from
  entries older than `ADVERSARIAL_WATCHER_WAKE_SUBJECT_TTL_MS` (default 30
  minutes) **at watcher startup**. Subjects requested after startup remain
  eligible until that watcher reads them, even if its poll runs past the TTL.
  This includes the top-level subject. Legacy list entries without their own
  time inherit the wake file's time; entries with unreadable times have no
  priority on read.
- The watcher applies the per-PR-head rate cap to each distinct fresh subject.
  A capped subject is omitted from the delivered payload. If the newest
  top-level subject is capped, the latest accepted subject takes its place in
  the delivered payload's legacy top-level fields. If every subject is capped,
  the watcher leaves the snapshot unacknowledged so a later write carries its
  pending subjects. A different eligible head in the same snapshot can still
  wake the watcher and receives priority.
- An invalid time in a carried entry is stamped with the current write time.
  The CLI requires an ISO `--requested-at` timestamp with a timezone.
  Re-waking the same
  repo/PR/head refreshes its time and position. The 64-subject cap still drops
  oldest entries during a burst.
- The receipt identifies a consumed snapshot, not a per-subject claim. If a
  writer reads the wake just before the watcher writes its receipt, that writer
  may carry already consumed subjects once more. The next consumed snapshot
  clears them; head matching and normal dispatch gates still apply.
