# Follow-up Reaper Cursors

Source of truth: `src/follow-up-stuck-claim-sweep.mjs` (`reapFinishedPrFollowUpJobs`), `src/ama/closer-worktree-reaper.mjs` (`persistScanCursor`), and `src/recovery-reaper.mjs` (`readLeaseRecords`, `persistCloserLeaseCursor`).

`data/follow-up-jobs/finished-pr-reap-cursor.json` is an atomic JSON object with optional `job` and `ama` string keys. `job` is the last processed terminal job path. `ama` is the last processed closer dispatch key in `repo#prNumber#headSha` form. The reaper sorts each candidate list, resumes after its saved key, and wraps to the start when no greater key remains. Missing or unreadable cursor state starts at the beginning. A skipped or failed item does not advance its cursor.

`data/ama-closer-worktree-reaper-cursor.json` is an atomic JSON object with `schemaVersion: 2`, `repo: null`, `worker`, `evaluation`, `probeFailures`, and `updatedAt`. `worker` and `evaluation` are last processed worker IDs or `null`; `probeFailures` records bounded unknown-process probes. `repo` is always `null`: each tick obtains a complete registration scan before deciding whether a worktree is half-registered. An incomplete registration scan defers only half-registered cleanup; terminal and prunable worktrees from successfully scanned repos remain eligible. `updatedAt` is the ISO write timestamp.

LEASEORPHAN-01 uses independent `data/recovery-reaper/closer-lease-cursor.json`
(age/pruning) and `data/recovery-reaper/closer-holder-cursor.json` (per-poll death
observation). Both atomically store `schemaVersion: 2`, `lastEntryName` (string
or null), `entriesSeen` (nonnegative count consumed in the current batch), and
`updatedAt` (ISO timestamp). Missing or unreadable state starts at the beginning.
Each pass selects at most 250 lexical directory entries and reads at most 50
JSON records by default, advancing only through consumed entries. Settled read
errors advance to permit progress and retry after a rotation. When no greater
name remains, scanning wraps to the start, including when the saved entry was
deleted. Directory-name enumeration still visits the whole directory with
bounded page memory; JSON reads, parsing and process probes use the batch bound.
Observation persists progress after processing its batch, independently of the
age sweep, so watcher restarts retain coverage without skipping pruning work.
These cursors grant no authority to release a lease; existing liveness and
generation fences remain mandatory.
