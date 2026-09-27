# Follow-up Reaper Cursors

Source of truth: `src/follow-up-stuck-claim-sweep.mjs` (`reapFinishedPrFollowUpJobs`) and `src/ama/closer-worktree-reaper.mjs` (`persistScanCursor`).

`data/follow-up-jobs/finished-pr-reap-cursor.json` is an atomic JSON object with optional `job` and `ama` string keys. `job` is the last processed terminal job path. `ama` is the last processed closer dispatch key in `repo#prNumber#headSha` form. The reaper sorts each candidate list, resumes after its saved key, and wraps to the start when no greater key remains. Missing or unreadable cursor state starts at the beginning. A skipped or failed item does not advance its cursor.

`data/ama-closer-worktree-reaper-cursor.json` is an atomic JSON object with `schemaVersion: 2`, `repo: null`, `worker`, `evaluation`, `probeFailures`, and `updatedAt`. `worker` and `evaluation` are last processed worker IDs or `null`; `probeFailures` records bounded unknown-process probes. `repo` is always `null`: each tick obtains a complete registration scan before deciding whether a worktree is half-registered. An incomplete registration scan defers only half-registered cleanup; terminal and prunable worktrees from successfully scanned repos remain eligible. `updatedAt` is the ISO write timestamp.
