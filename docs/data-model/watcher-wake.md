# Data Model - Watcher Wake

**Owner:** watcher wake transport and subject priority
**Store:** `data/watcher-wake.json`, `data/watcher-wake-consumed.json`
**Source of truth:** `src/watcher-wake.mjs`
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
| `data/watcher-wake-consumed.json` | JSON object | `consumed_key` is the last snapshot key observed by the watcher: `request_id:<id>` or a `content:<sha256>` fallback for legacy files without a request ID. The watcher atomically replaces this receipt after reading a changed wake. |

## Consumption and expiry

- A writer carries subjects only when the current wake's snapshot key differs
  from the receipt. A missing or unreadable receipt leaves subjects unconsumed.
  A failed receipt write does not stop the wake; later writes may carry its
  subjects until another read succeeds.
- The watcher always consumes the wake signal. It strips subject priority from
  entries older than `ADVERSARIAL_WATCHER_WAKE_SUBJECT_TTL_MS` (default 30
  minutes) **at watcher startup**. Subjects requested after startup remain
  eligible until that watcher reads them, even if its poll runs past the TTL.
  This includes the top-level subject. Legacy list entries without their own
  time inherit the wake file's time; entries with unreadable times have no
  priority on read.
- An invalid time in a carried entry is stamped with the current write time.
  The CLI rejects an invalid `--requested-at` value. Re-waking the same
  repo/PR/head refreshes its time and position. The 64-subject cap still drops
  oldest entries during a burst.
- The receipt identifies a consumed snapshot, not a per-subject claim. If a
  writer reads the wake just before the watcher writes its receipt, that writer
  may carry already consumed subjects once more. The next consumed snapshot
  clears them; head matching and normal dispatch gates still apply.
