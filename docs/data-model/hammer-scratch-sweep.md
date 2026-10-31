# Data Model - Hammer Scratch Sweep Checkpoints

**Owner:** AMA hammer scratch maintenance
**Source of truth:** `src/ama/hammer-scratch-sweep.mjs`
**Stores:** `data/follow-up-jobs/hammer-scratch-record-index.json` and
`data/follow-up-jobs/hammer-scratch-candidate-cursor.json`

Both stores use atomic replacement with mode `0600`. They are maintenance
checkpoints and grant no deletion or merge authority. Dispatch evidence is
retained separately.

Quota-killed launches retain their scratch while quota resume is pending,
including before a successor exists. The public dispatch projection supplies
the latest `worker_killed_cause` and `last_admit_refusal_reason`; a pending
provider-quota kill or enqueued intent cannot authorize deletion. Live retry
descendants retain scratch as before. A terminal descendant settles the original
enqueued intent; genuinely terminal owners remain eligible for reclamation.
Publication settles the parent's intent even if its enqueue marker is absent.
Public retry edges distinguish settled historical kills from an unresolved
quota-killed descendant, which still retains scratch. Named
`quota-resume-phase-inputs-missing` failures/cancellations resolve quota intent
even when the previous quota cause and enqueue marker remain on the row.
Terminal lease/dispatch reconciliation uses the same pending-resume protection.

## Record index

The existing index has `schemaVersion: 1` and `entries`, an array of
`[filename, { version, record }]` pairs. Each filename is a dispatch JSON basename;
`version` fingerprints source device, inode, size, mtime and ctime. Partial
indexing is checkpointed, but deletion still requires a complete current source
census and fresh owner checks. Missing, invalid or unreadable state starts cold.

## Candidate cursor (SCRATCHLEAK-02)

```json
{"schemaVersion":1,"after":{"name":"hammer-scratch-synthetic","mtimeMs":1000}}
```

`after` is the last fully examined candidate's directory basename and the mtime
observed when the pass listed candidates. Candidates sort by numeric mtime,
then name in string order. The next pass starts at the first key greater than
`after`, wraps to the oldest key when necessary, and visits at most one lap.
The saved key works even if its directory was removed. It is never used to
construct a deletion path or as evidence that a directory is unused.

Kept and ledger-timeout candidates advance the cursor. A scan or census pause
during an unfinished candidate leaves it pending; a pause before the first
candidate leaves the saved cursor untouched. A full zero-removal lap saves its
last examined key rather than resetting to a cold start. Each invocation reads
the disk cursor, so watcher restarts retain progress. An invalid version, unsafe
basename, non-finite mtime or unreadable checkpoint restarts oldest first.
Write failure warns and does not inhibit safe reclamation in the current pass.

Ledger reads have independent timeouts (10 seconds by default, overridden by the
caller's `ledgerTimeoutMs` option); elapsed time is refunded to the unchanged
scan budget. Timeout is inconclusive and retains the candidate.
Summary `deferredCandidates` counts these visited deferrals alongside other
inconclusive candidates; `remainingCandidates` counts the unvisited portion of
the current rotated lap. Neither checkpoint changes dispatch or lease state.
