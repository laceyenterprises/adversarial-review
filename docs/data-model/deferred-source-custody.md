# Deferred closer source custody

**Owner:** Hammer validation and the watcher

**Store:** `<HQ_ROOT>/dispatch/audit/deferred-source-custody/<owner>/<repo>/pr-<number>/<target-head>/`

**Source of truth:** `src/ama/deferred-source-custody.mjs`

`hold.json` is a private, atomically created, schema-version-1 marker. It names
the repository, PR, target head, original dispatch head, exact local source head,
validation base, launch and run IDs, original checkout, initial runner and file
selection, exact-head checkout cleanliness, and private `attempt-*` evidence
directory. Controlled validation also names the owning controller registration.
The marker blocks a successor even if the validator died while writing evidence.
After complete exact-head coverage, passing local-only checks and confirmed
standalone cleanup prove CI continuation, the marker gains `continuedAt` (an ISO
timestamp), provided source retention is complete. Evidence stays archived, but validation, watcher and successor hold
lookups ignore this marker, including the legacy retry fallback. The standalone
last-phase receipt records CI-authoritative continuation instead of deferral.
Controlled stops still record deferral before requesting drain.
A persistent sibling flock serializes marker creation and continuation.
The watcher tries the continuation lock once per pass. Explicit continuation
waits up to one second for contention. The controller retries post-publication
completion up to three times without repeating the push. A later deferral may
replace a continued marker with retained source or confirmed exact-source publication. It
first copies the old marker to that attempt's `continued-hold.json`. Active or
unreadable markers cannot be replaced. Attempt evidence remains private.

| Attempt artifact | Contents |
|---|---|
| `source.json` | `matches-target`, `bundled`, `local-ref-only` or `workspace-only`. `bundled` records the advertised Git ref, bundle name and selected prerequisite SHAs. |
| `source.bundle` | Incremental Git bundle of the original unpublished commit. `source.json` is written after checking the advertised object. Recover on a checkout with the prerequisite commits. |
| `deferred.json` | Exact source head, UNKNOWN reason and original exit status, recorded local failure, and any proof for CI-authoritative continuation. |
| `validation.json`, `*.check-*.log` | Independent copy of the exact-head check receipt and available bounded diagnostics. Paths in the copied receipt are relative to this attempt. |
| `bounded-cleanup.json` | Standalone bounded runner's actual cleanup verdict, status, reason and launch/head identity. |
| `controller-cleanup.json` | Final matching controller registration with drain and lease disposition. Its absence leaves cleanup unconfirmed. |

An incomplete bundle retains the original workspace for recovery unless a
continued marker records `publishedHead === sourceHead`. Teardown only retries
retention in a resolved checkout directly under the ending launch's worker
root. The watcher records `lastRetentionAttemptAt` under the hold lock and
attempts asynchronous local Git retention at most once per five minutes per
hold. Unavailable prerequisite objects are omitted so retention can create a
self-contained bundle. After persisting a verified bundle and its receipt, the
retention owner deletes the temporary ref only if it still points to the
recorded source. Failed deletion leaves the ref for the custody operator to
prune after verifying the retained bundle. A missing source receipt means
`matches-target` only when source equals target and `clean !== false`; corrupt
receipts still mean unconfirmed. Teardown
checks all target-head markers for the PR and matches their launch ID, including
continued markers; it cannot assume the dispatch and published heads agree.
Unreadable markers retain the workspace. Missing cleanup proof is UNKNOWN.
The watcher deduplicates unchanged operator decision notices through the
existing closure-wait store and refreshes delivery when source or cleanup facts
change. A clean matching-target hold with confirmed cleanup gains `continuedAt`
and returns to ordinary per-head retry backoff; this grants no CI authority.
Corrupt retry files are preserved. An ended inconclusive launch on the live
head holds that head's retry and raises one notice until the record is repaired. A legacy
retry alone does not establish custody; new unsafe observations explicitly
record `custodyRequired` to retain fallback custody if the marker disappears. The close controller
and conflict repair also respect holds. Source custody grants zero publication,
provenance, review, validation or merge authority.

The operator keeps the package for diagnosis and recovery under the existing
protected HQ audit namespace after run scratch and the worker are reclaimed.
A replacement live head does not delete historical custody. See the
[closure runbook](../RUNBOOK-ama-closure.md) for operator recovery and same-head
release.
