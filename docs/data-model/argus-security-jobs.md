# Data Model - Argus Security Review Jobs

**Owner:** ASR-03 Argus security review queue
**Store:** `data/argus-security-jobs/`
**Source of truth:** `src/argus-security-queue.mjs`
**Runtime surface:** `src/argus-security-queue.mjs`

## Purpose

`data/argus-security-jobs/` is the durable on-disk queue for Argus security
review work. It is intentionally separate from `data/follow-up-jobs/` so a
remediation backlog cannot starve security review, and a burst of security
reviews cannot starve normal follow-up remediation.

Each job is bound to one exact `(repo, prNumber, headSha)` identity. A re-poll
of the same PR head is idempotent, while a new head SHA creates a new job
because the prior security review only speaks for the tree it inspected.

## Directories

Directory: `data/argus-security-jobs/`

| Path | Shape | Contract |
|---|---|---|
| `pending/*.json` | Argus job document with `status: "pending"` | Durable work waiting to be claimed. Filenames are deterministic job IDs derived from `(repo, prNumber, headSha)`. |
| `in-progress/*.json` | Argus job document with `status: "in_progress"` | Claimed work owned by a security reviewer worker. Claims are acquired by hard-linking the pending file into this lane, then unlinking the pending name. |
| `completed/*.json` | Argus job document with `status: "completed"`, `completedAt`, and `result` | Terminal archive for successful security reviews. |
| `failed/*.json` | Argus job document with `status: "failed"`, `failedAt`, and `error` | Terminal archive for failed reviews and unreadable pending records that were quarantined out of the active queue. |

## Job Document

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Currently `1`. |
| `kind` | string | Always `argus-security-review`. |
| `status` | string | One of `pending`, `in_progress`, `completed`, or `failed`. |
| `jobId` | string | Deterministic filename stem for `(repo, prNumber, headSha)`. |
| `repo` | string or null | GitHub `owner/repo` for normal jobs; `null` only for synthetic failed records created from corrupt pending files. |
| `prNumber` | number or null | Pull request number for normal jobs; `null` only for synthetic corrupt-record failures. |
| `headSha` | string or null | Full 40- or 64-character commit object name for normal jobs; `null` only for synthetic corrupt-record failures. |
| `reasons` | array | ASR-02 trigger reason objects copied verbatim from the security-surface classifier. |
| `enqueuedAt` | string or null | ISO-8601 enqueue time for normal jobs; `null` only for synthetic corrupt-record failures. |
| `source` | string or null | Optional enqueue source label. |
| `claimedAt` | string or null | ISO-8601 claim time once moved to `in-progress`. |
| `completedAt` | string or null | ISO-8601 completion time for completed jobs. |
| `failedAt` | string or null | ISO-8601 failure time for failed jobs. |
| `result` | object or null | Successful review result payload on completed jobs. |
| `error` | string or null | Failure reason on failed jobs. |

## Operational Contract

- Enqueue is write-once and idempotent per `(repo, prNumber, headSha)`. The
  same head may appear in any bucket and still suppress a duplicate enqueue; a
  different head always gets a distinct job.
- Claiming uses a hard link into `in-progress/` as the ownership boundary. If a
  worker crashes after creating the hard link but before removing the pending
  name, the next claim compares inodes and completes the pending unlink when
  both paths point at the same file. If the in-progress file is a different
  inode, the pending file remains untouched and the claimant skips it.
- If the pending pathname disappears after the in-progress hard link succeeds,
  the claim is still valid. The worker must persist the claimed record rather
  than rolling back and deleting the in-progress file.
- Unreadable pending records are moved to `failed/` as synthetic failed jobs so
  one corrupt file cannot remain the oldest pending entry forever or jam queue
  monitoring.
- Queue depth is content-free and uncapped. It counts `.json` entries in every
  bucket so Sentinel sees real backlog even when some records are corrupt.
- Listing APIs are fail-soft per record and cap only successfully parsed jobs,
  so corrupt files near the newest edge do not hide valid records below them.
- Terminal transitions rename the in-progress file into `completed/` or
  `failed/` before stamping the terminal payload. Callers may pass the in-memory
  claimed job to avoid re-reading a file that was corrupted while work was in
  flight.
- The files contain no secrets. They contain PR identity, exact head SHA,
  security trigger reasons, timestamps, and review result or failure metadata.
