# Reviewer spawn records

**Source of truth:** `src/reviewer-fence.mjs` (`upsertSpawnRecord`,
`loadSpawnRecords`, `syncSpawnRecords`, `deleteSpawnRecord`), the writer in
`src/reviewer-spawn-settle.mjs` (`spawnReviewer`), the startup/SIGTERM fence
sweep in `src/reviewer-fence-sigterm.mjs`, and the Gemini reservation reader in
`src/watcher-reviewer-pool.mjs` (`persistedSpawnReservationSource`).

## Ownership

- Store: `data/reviewer-fences/spawn-records/<spawnToken>.json` (under
  `ADVERSARIAL_REVIEW_STATE_DIR` when set, otherwise the watcher's `data/`).
  A legacy single-file map, `data/reviewer-fences/spawn-records.json`, is still
  read and is removed by the next `syncSpawnRecords`.
- Writer: `spawnReviewer` writes one record per reviewer spawn before launch
  and deletes it when that spawn settles in the same watcher process.
- Readers: the reviewer-fence startup and SIGTERM sweeps, and the watcher's
  detached reviewer dispatch tracker (Gemini reservations, CCX-08).

## Shape

One JSON object per file, `schemaVersion: 1`:

| Field | Meaning |
|---|---|
| `spawnToken` | Random UUID; also the file name |
| `repo`, `pr` | The reviewed PR |
| `reviewerModel` | Model of this spawn (`claude`, `codex`, `gemini`) |
| `passKind`, `dispatchPassKind` | Reviewer pass kind and the lane it was admitted on |
| `pipelineGeminiSeats` | CCX-08, optional, default `0`: the largest simultaneous Gemini panel of the enclosing pipeline domain when added agy identities are configured |
| `identity`, `botTokenEnv` | Reviewer GitHub identity used to post |
| `reviewerSessionUuid` | Names the reviewer run record (`data/reviewer-runs/<sessionUuid>.json`) |
| `spawnedAt` | ISO timestamp the record was written |

Additive fields are optional; readers treat a missing `pipelineGeminiSeats` as
zero.

## Gemini reservations (CCX-08)

`pipelineGeminiSeats` reserves a pipeline PR's Gemini panel for every stage,
including non-Gemini stages, so another pipeline cannot be admitted into the
capacity its later Gemini stage needs. The dispatch tracker counts it in two
places:

- Spawns this watcher holds in memory are grouped by repository and PR. The
  reservation is the larger of `pipelineGeminiSeats` and the PR's actual
  Gemini spawn count, so concurrent stages reserve the panel once.
- Records a previous watcher persisted (not in this watcher's memory, and for a
  PR this watcher does not already track) still reserve their PR's panel after
  a watcher restart while their stage runs. A record counts only if it is
  younger than the reviewer timeout plus grace and its reviewer run record
  shows it may still be running: no run record, a terminal run state or a gone
  process group ends it; a `launching` record with no process group yet, or
  a run record that cannot be read, keeps it until the expiry. A surviving
  Gemini stage whose run record carries `subjectContext.agyIdentityLease` does
  not count its own seat again, because the agy identity pool adopts that lease
  and holds the identity out of the ready count while the review runs (see
  `reviewer-run-records.md`). A surviving Gemini stage without a lease (a
  runtime that cannot carry an identity, a single-identity pool, or a run
  record that cannot be read) keeps its own seat in the reservation.

There is no SQL schema change; this store is JSON only.
