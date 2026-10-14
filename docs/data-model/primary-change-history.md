# Data Model - Primary Change History (PCCSLOW-01)

**Owner:** AMA canonical daemon data owner
**Store:** `<runtime rootDir>/data/primary-change-history/`
**Source of truth:** `src/ama/primary-change-store.mjs`
**Runtime surfaces:** `src/ama/primary-change.mjs`, `src/ama/history-reader.mjs`,
`bin/primary-change-context.mjs`, `src/watcher.mjs`

## Identity and record shape

Each completed history read is an atomic JSON record named
`<sha256(JSON.stringify(key))>.json`. The ordered `key` array is:

| Position | Value |
|---|---|
| 0 | Repository `owner/repo` |
| 1 | Numeric PR number |
| 2 | Live base SHA |
| 3 | Requested head SHA |
| 4 | Live merge-base SHA |
| 5 | Review-response SHA-256 digest (`reviewKey`), or `null` |
| 6 | Trusted dispatcher launch head (`launchHead`), or `null` |

The JSON object contains `key` and `history`; there is no schema-version field.
`history.headSha` is the requested head and `hasHammerCommits` is a boolean.
Without hammer commits, those two fields are sufficient. With hammer commits,
history includes `primaryHead`, `mergeBase`, `primaryFiles`, `finalFiles`,
`completeFileLists` and `testRegionsChanged`. It may include `builderBoundary`,
`reversalAuthorizations` and `rejectedReversalAuthorizations`. New hammer-history
records also include optional `diagnosticCommitRange`: an ordered array of
`{ sha: <commit SHA> }` entries from the first hammer commit through `headSha`,
including intervening remediation commits. This range supports observational
refusal attribution only; it never authorizes a merge. Older records without
the field remain reusable: explicit operator diagnostics fetch the range on demand.
Only `fetchPrimaryChangeContext` (the CLI's opt-in `--diagnostics` mode) performs
attribution, with the caller's effective strictness policy, a 20-commit cap and a
15-second wall-clock budget. Deadline expiry retains partial attribution with an
error; cancellation and transport/auth/read failures propagate. Capped snapshots
are errors rather than evidence of a missing region. The range is stored in full;
attribution results (`revertedRegionDiagnostics`) are returned to the operator and
are not cached here. Shared `fetchPrimaryChange` and default CLI reads never
collect attribution, including on repeated refused-head cache hits. Production
merge gates and their refusal audits therefore do not pay for these diagnostics.
File evidence and reversal citations use the collector's shapes in
`src/ama/primary-change.mjs`.
CI-cost evidence is collected live after history reuse and is never cached here.

Reuse requires an exact key, matching head, a boolean `hasHammerCommits`, and a
matching merge base when hammer commits exist. A stored `builderBoundary` must
match an explicit caller `builderHead` when both are present; the boundary is
validated separately from the filename key. Live PR head/base, merge-base
metadata, reviews and dispatcher provenance are read before lookup. Missing,
corrupt or mismatched records trigger recomputation. Unknown, failed or
head-mismatched reads are never published.

## Ownership and publication

Daemon and hammer CLI calls must run as the canonical runtime data owner.
Before lookup, creation, replacement or sweeping, the helper checks the
effective UID against existing `data/`, the cache directory and the relevant
record. If `data/` is absent, the runtime root is the ownership anchor.
Symlinks at those checked paths are refused. The asynchronous read checks
ownership again before publication. Wrong-owner state fails with an actionable
canonical-owner error; the collector reports `historyReadFailed: true` and
does not authorize merge from unreadable evidence.

Workers using a different UID must invoke the helper through the established
canonical-owner execution boundary, for example `sudo -A -H -u <owner>` with
that owner's runtime environment and `HAM_ROOT_DIR`. The store does not switch
users, change existing ownership, or relax permissions. Existing wrong-owner
records require operator cleanup of this disposable cache before retrying as
the canonical owner.

A writer exclusively creates `<record>.json.<uuid>.tmp` with mode `0600`, then
renames it over the destination and removes its temporary file in `finally`.
All sharing is between processes running as that same UID. Reads for the same
path share one in-process promise; separate processes may compute concurrently
and publish complete records atomically. A daemon merge timeout leaves the
bounded history read running to completion so a later attempt can reuse it.
The running-read map and elapsed-time status are process-local, not persistent.

## Retention and debugging

The watcher's existing periodic cache sweep removes files older than seven
days and all but the 512 most recently modified entries, without live API
reads or an additional cadence knob. Both JSON records and orphan temporary
files count toward the bounds. A file removed between enumeration and stat is
skipped individually; other stat errors propagate. Missing directories are
empty stores. Sweeping refuses deletion of a foreign-owned record.

The store is disposable derived evidence, not an audit ledger. New heads,
bases, review digests or launch heads produce new filenames; there is no
migration or PR-closure deletion hook. Operators can inspect the `key`,
`history.headSha`, optional boundary and filesystem UID/mode to diagnose a
miss. Removing obsolete records causes a fresh read, never a waiver of the
primary-change merge gate.
