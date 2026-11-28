# Deferred closer source custody

**Owner:** Hammer validation and the watcher

**Store:** `<HQ_ROOT>/dispatch/audit/deferred-source-custody/<owner>/<repo>/pr-<number>/<target-head>/`

**Source of truth:** `src/ama/deferred-source-custody.mjs`

`hold.json` is a private, atomically created, schema-version-1 marker. It names
the repository, PR, target head, original dispatch head, exact local source head,
validation base, launch and run IDs, original checkout, initial runner and file
selection, exact-head checkout cleanliness, and private `attempt-*` evidence
directory. Controlled validation also names the owning controller registration.
The target and source SHAs are stored in lowercase. For a conflict replay,
the target is the captured remote head used as the publication lease, and the
source is the local replay commit. The controller pointer uses the same target.
The marker blocks a successor even if the validator died while writing evidence.
After a CI-authoritative UNKNOWN (HAMCIAUTH-01: no observed local failure, a
clean committed exact head, declared contexts and confirmed standalone cleanup or
controller drain; coverage may be partial), the marker gains `continuedAt` (an ISO
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
unreadable markers cannot be replaced. Readers interpret consecutive complete
JSON snapshots of the same attempt as the last snapshot without rewriting the
marker. A locked writer normalizes the marker before reconciliation. Ambiguous
identities and truncated tails remain unreadable. Attempt evidence remains private.

| Attempt artifact | Contents |
|---|---|
| `source.json` | `matches-target`, `bundled`, `local-ref-only` or `workspace-only`. `bundled` records the advertised Git ref, bundle name and selected prerequisite SHAs. |
| `source.bundle` | Incremental Git bundle of the original unpublished commit. `source.json` is written after checking the advertised object. Recover on a checkout with the prerequisite commits. |
| `deferred.json` | Exact source head, UNKNOWN reason and original exit status, recorded local failure, and any proof for CI-authoritative continuation. |
| `validation.json`, `*.check-*.log` | Independent copy of the exact-head check receipt and available bounded diagnostics. A run-relative input receipt is resolved within the run directory. Copied diagnostic paths are relative to this attempt. |
| `bounded-cleanup.json` | Standalone bounded runner's actual cleanup verdict, status, reason and launch/head identity. |
| `controller-cleanup.json` | Final matching controller registration with drain and lease disposition. `controller` names its registration file. `validationFinalized: true` confirms that the controller or watcher copied the launch-bound exact-source check receipt after verifying drain and before writing this proof. |

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
change. A clean matching-target hold with confirmed cleanup ordinarily gains `continuedAt`
and returns to per-head retry backoff. A retained non-CI UNKNOWN such as a
mirror setup fault needs finalized exact-source evidence without local failure
to record `continue-local-retry`. An exact-source process-inspection
no-verdict holds the target for operator recovery even if source custody had
already been continued. The watcher also recognizes a legacy environment
deferral when the same attempt's check receipt attributes exit 75 and the
explicit no-verdict to the Telegram responder guard. It reads those receipts
without rewriting the original outcome. Source continuation grants no CI authority.
HAMCIAUTH-01: the watcher also continues an uncontinued hold, recording
`publishedHead`, when its `sourceHead` is the live PR head and the hold is
`clean: true`. The watcher rechecks custody under lock. It requires launch-bound
cleanup and finalized exact-source check evidence for timeout, load or
`node-pin-unavailable` stops. A skipped canonical Node battery retains an
inconclusive check row and false complete coverage; controller-owned runtime
gaps still require the matching round's drain before continuation.
The attempt's `deferred.json` must record `localFailureObserved: false` and
`validation.json` must contain neither a failed row nor a typed process-inspection
refusal. Recording `publishedHead` also requires declared contexts. The watcher also requires an expired owner or a terminal launch with no live
retry and no PR merge lease. A CI-eligible hold initially waits without
paging. After five minutes from the later of `hold.json`'s `at` and the
matching confirmed cleanup's `finishedAt`, the watcher creates an HQ decision
and pages if release remains fenced. Only valid timestamps at or before the
observation count. If none is available, the watcher surfaces the wait
immediately. The atomic marker records `resolution.action`,
`resolution.at` and the declared `resolution.requiredContexts`. A fresh closer
reads this `continue-to-ci` audit row and copies the rechecked UNKNOWN evidence
into its run before waiting for the same head's required checks.
When an older controller cleanup receipt lacks `validationFinalized`, the
watcher locates the original scratch directory through the matching launch's
dispatch record or the archived absolute check receipt reference in the default
prompt directory. It verifies the original controller registration, drain and
lease disposition, then reads the original exact-source deferral and check
receipt. It persists the upgraded proof under the custody lock even if the
launch owner or PR lease still fences release. Unavailable original evidence
keeps custody and can be rechecked on a later pass.
Corrupt retry files are preserved. An ended inconclusive launch on the live
head holds that head's retry and raises one notice until the record is repaired. A legacy
retry alone does not establish custody; new unsafe observations explicitly
record `custodyRequired` to retain fallback custody if the marker disappears. The close controller
and conflict repair also respect holds. Source custody grants zero publication,
provenance, review, validation or merge authority.

A clean `bundled` attempt with launch-bound cleanup is eligible for watcher
re-drive on the original target head. The source receipt gains `redrive.count`,
`redrive.headSha`, `redrive.reservationId` and `redrive.nextAttemptAt` under the
hold lock at admission. `redrive.unsettled` marks a provisional attempt and its
reservation ID matches the closer dispatch's idempotency key. The watcher can
reconcile that reservation even at the attempt ceiling. Confirmed submission
refusal restores the prior receipt only for the matching reservation. Terminal
infrastructure or inconclusive stops clear `unsettled` and refund the count,
retaining the retry clock and candidate. A confirmed publication rejection or
deterministic stop keeps the charge. The optional `redrive.refusal` records a
deterministic replay or validation failure and stops admission. Readers accept
earlier receipts without these optional fields. The closer verifies
the advertised Git ref and retains `redrive.candidate` only after the current
canonical validator passes. Confirmation on the live PR advances `status` to
`matches-target` and records `publishedHead` and `publishedAt` in the same
atomic write. Readers treat this receipt as a continued hold and retain the
original bundle and diagnostics. Independent exact-head review owns the new
head. A missing or ambiguous bundle, conflicting replay, failed validation or
unconfirmed publication preserves custody.

The operator keeps the package for diagnosis and recovery under the existing
protected HQ audit namespace after run scratch and the worker are reclaimed.
A replacement live head follows normal dispatch and daemon merge routing and
keeps historical custody available for recovery. See the
[closure runbook](../RUNBOOK-ama-closure.md) for operator recovery and same-head
release.

## Operator decisions

**Source of truth:** `src/ama/deferred-source-decision.mjs`

The watcher atomically creates `decision.json` under
`<HQ_ROOT>/dispatch/audit/deferred-source-decisions/<launch>/<attempt>/` before
returning an operator-needed result. `hq decision reply` writes
`answer.json` under the hold lock. `keep-custody` retains the source and can be
revised before release. `discard-remediation` waits for stopped ownership and
an absent PR merge lease. The same five-minute quiet window applies to a
saved discard, with `answeredAt` included in the latest applicable timestamp.
When the window expires, the watcher pages about the saved answer and
continues checking ownership. The watcher records the answer timestamp and release
in the marker and then ordinary closure can run from published source. HQ
projects the decision as resolved from the marker and rejects new answers
after release. Invalid or unreadable answers retain custody and trigger a
deduplicated operator notice. Unreadable markers and explicit retry fallback
custody also report operator ownership, with no reply command until the exact
marker is restored. A release cannot clear a custody refusal while a companion
dispatch-head marker still requires an operator.

| Field | File | JSON type and value |
|---|---|---|
| `schemaVersion` | Both | Number `1` |
| `repo` | Both | Lowercase `owner/repo` string |
| `prNumber` | Both | Positive integer JSON number |
| `targetHead`, `sourceHead` | Both | Lowercase 40-hex-character SHA strings |
| `launchRequestId`, `attempt` | Both | Strings with `lrq_` and `attempt-` prefixes, respectively |
| `question`, `command` | Decision | String operator guidance and exact-attempt reply command |
| `options`, `recommended` | Decision | Ordered string array `["keep-custody", "discard-remediation"]` and string `"keep-custody"` |
| `createdAt` | Decision | ISO 8601 timestamp string |
| `answer` | Answer | String `"keep-custody"` or `"discard-remediation"` |
| `answeredAt` | Answer | ISO 8601 timestamp string |
| `previousAnswer` | Answer | Optional previous answer object when revising a keep answer |

Both records must match the current hold's six identity fields exactly. This
comparison includes JSON types and case. An answer also requires a matching
decision record.
