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
| 7 | History proof cache identity version: `reversalprov-v5` |

The JSON object contains `key` and `history`; there is no schema-version field.
`history.headSha` is the requested head and `hasHammerCommits` is a boolean.
Without hammer commits, those two fields are sufficient. With hammer commits,
history includes `primaryHead`, `mergeBase`, `primaryFiles`, `finalFiles`,
`completeFileLists` and `testRegionsChanged`. It may include `builderBoundary`,
`reversalAuthorizations`, `rejectedReversalAuthorizations`, `renameProofs` and
`primaryPathChanges`. The returned history may also carry `renameProofReadFailed`,
which prevents disk publication as described below. The identity version forces
one recomputation of older records, including cached original-reversal refusals
and proofs from before context-tolerant, structure-preserving reversal matching
and before proof-backed HAM-author reversals with a foreign rebase committer
or REVERSALPROV-02 content multiset matching across context-only rebases,
including historical original-reversal refusals before secondary/brace location support,
parent-state insertion authorization, mixed replacement restorations
and segment identity over both removed and added content. Reviewed-parent
matching uses multisets; original-commit provenance retains ordered edits,
hunk/context-run boundaries and newline-marker attachment. Evaluator coverage
uses the commit's own parent region and excludes removals elsewhere in the file;
those older records remain disposable and expire through the ordinary sweep.
New hammer-history records also include optional `diagnosticCommitRange`: an ordered array of
`{ sha: <commit SHA> }` entries from the first hammer commit through `headSha`,
including intervening remediation commits. This range pins rename-proof
candidates and supports observational refusal attribution; the range alone
never authorizes a merge. Older records without
the field remain reusable: explicit operator diagnostics fetch the range on demand.
Only `fetchPrimaryChangeContext` (the CLI's opt-in `--diagnostics` mode) performs
snapshot attribution, with the caller's effective strictness policy, a
20-commit cap and a 15-second wall-clock budget. Deadline expiry retains partial attribution with an
error; cancellation and transport/auth/read failures propagate. Capped snapshots
are errors rather than evidence of a missing region. The range is stored in full;
attribution results (`revertedRegionDiagnostics`) are returned to the operator and
are not cached here. Shared `fetchPrimaryChange` and default CLI reads do not
collect refusal-attribution snapshots, including on repeated refused-head cache hits.
MIGRENUMBERDERIVED-02 separately reads bounded immutable snapshots only when
verifying an actual migration-renumber candidate, to retain its derived chain.
They retain commit-file attribution gathered alongside rename proof instead.
Production merge gates and their refusal audits do not pay for operator
snapshot diagnostics.
File evidence and reversal citations use the collector's shapes in
`src/ama/primary-change.mjs`.
CI-cost evidence is collected live after history reuse and is never cached here.
MIGRENUMBERDERIVED-01 `migrationRenumberProofs` are likewise transient, collected
from hash-verified immutable blobs after cache reuse. Each contains
`classification: mechanical-migration-renumber`, `path`, `destination`,
`registryPath`, `primaryBlob`, `blob`, `primaryRegistryBlob`, `registryBlob`,
`primaryHead`, `headSha` and `mergeBase`. The evaluator binds all identities to
the current file comparisons and returns successful proofs as `derivedChanges`.
They are never written into history records and require no cache version bump.
For a shared registry, only candidates whose migration bodies have already
matched may be normalized together. Each pair needs exactly one tuple in each
snapshot; pair identity, tuple order and every unrelated byte remain protected.
PRIMARYOPAQUE-01 derived-artifact proofs are also collected after history reuse
and never written into these records. Returned evidence may carry
`derivedArtifacts`, an array of `{ path, primaryBlob, blob, directory, command,
headSha, primaryHead, comparison: 'git-blob-sha1' }`. Each entry records a
successful isolated rebuild under the unchanged author-declared package script,
or the fixed recipe in an [owner-registered receipt](derived-artifact-receipts.md).
Receipt proofs additionally carry `recipe`, `mergeBase`, `receipt`, `review`, `finding`, `kind`;
the registration and proof are outside this history cache.
The evaluator binds it to the protected author blob and final head blob at the
same path and change status. Failed proofs add no authority and retry on the
next collection; existing cache keys and durable shapes do not change.
Within a closure evaluation, object-addressed transport responses can also be
reused across history readers. These shared response values are deeply frozen;
consumers cannot rewrite evidence seen by a sibling. Pending reads share only
their cancellation signal, while completed reads can serve a new operation
signal. Failed tree/blob promises are evicted from the per-reader cache. The
existing context budget still bounds a retry. This NXA-01 collection change
does not change the durable record shape, key or reversal-proof semantics.

Entries in `rejectedReversalAuthorizations` retain their existing `reason` codes.
SAFETYSTOPOWNER-01 searches subsequent authoritative review snapshots when an
intermediate snapshot does not contain the original reversal. The cited finding
must still be authoritative at the original commit's parent, including when that
parent is the finding's reviewed head. Immutable commit identity, exact changed
content and cited-region coverage remain required. Version `reversalprov-v5`
recomputes earlier cached refusals at an unchanged head and review key.
An `original-reversal-not-proven-before-supersession` entry also carries optional
`detail`: no candidate with the same commit message, a change-line mismatch with
the affected paths, or the failed snapshot/provenance/ancestry/parent-patch check.
At most ten candidate failures are included. Mismatches list the first five paths
(at most 160 characters each), followed by `(+N more)` when paths are omitted.
The complete `detail` is capped at 1200 characters, including a trailing `...`
when truncated. The refusal's `missingEvidence` forwards this detail in `rejected`;
the operator-facing `summary` is capped at 4096 characters, including truncation.
Older cache records are recomputed once under the new identity, even if their
head and reviews have not moved; no manual re-read or sweep wait is needed.

The rename-related optional history fields are:

| Field | Shape and meaning |
|---|---|
| `renameProofs` | Array of `{ source, destination, commit, baseParentProof? }`. `commit` retains the complete commit identity, parents and files proving source removal, destination introduction and identical blob SHA. Sources may be added, modified or builder-renamed files; builder-renamed sources require the original merge-base name to remain removed or renamed in the final diff. Proof requires trusted hammer identity, a parent descended from `primaryHead` and a production destination for a production source. A two-parent commit additionally carries `{ parentSha, baseSha, status }` in `baseParentProof`, with `status` equal to `ahead` or `identical`, proving its second parent is in live base ancestry. The evaluator rechecks the cached proof against the final diff and `diagnosticCommitRange`. |
| `primaryPathChanges` | Array of `{ path, start: null, end: null, commits, error? }` for missing primary paths. Each removal/rename attribution has `{ sha, author, pipelineRepair: null, repairKind: null }`. This is observational evidence and never grants preservation authority. Candidate commit metadata is reused within the evaluation. Without a candidate destination, only the first 20 commits are read; larger ranges retain a truncation `error`, including when no removal was attributed. Rename proof scans retain the full candidate range. Refusals combine these records with operator snapshot attribution by path. |
| `renameProofReadFailed` | Optional `true` on returned history when a candidate read failed for a path with a possible destination and no later valid proof resolved that path. Earlier failures do not prevent caching a later proven rename. A successful proof for one path cannot clear an unresolved failure for another. Histories carrying this flag are not written to disk, so subsequent reads retry optional proof instead of caching a transient refusal. |

Reuse requires an exact key, matching head, a boolean `hasHammerCommits`, and a
matching merge base when hammer commits exist. A stored `builderBoundary` must
match an explicit caller `builderHead` when both are present; the boundary is
validated separately from the filename key. Live PR head/base, merge-base
metadata, reviews and dispatcher provenance are read before lookup. Missing,
corrupt or mismatched records trigger recomputation. Unknown, failed or
head-mismatched reads and unresolved rename-proof read failures are never published.

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

MIGRENUMBERDERIVED-02 extends these transient proofs to Alembic wrappers with
paired revision modules and explicit module-name registries. Each proof binds
`modulePath`, `moduleDestination`, `primaryModuleBlob`, `moduleBlob` and an
observed `chain` of `{ headSha, path, blob }` entries from the
protected author head. Every intermediate hammer snapshot is compared with
that same author baseline. These proofs remain outside cached history and
are retained in `derivedChanges` through merge receipts.

MIGRENUMBERDERIVED-03 also returns transient `migrationRenumberDiagnostics`:
up to 128 recent `{ proven: false, reason, headSha, path?, detail? }` records.
The proof collector retains its array return while recording refusal reasons on
the evidence passed to it. The predicate exposes them as a sibling
`migrationRenumberDiagnostics` field on the refusal, outside `missingEvidence`
and its bounded summary, preserving deterministic stop identity and region
history. Legacy stop keys/probes also exclude diagnostics and their summary
suffix. No migration candidates means no diagnostics, timer or load sampling.
These records are never stored in history. Collection uses
one load-scaled 90-second deadline (180-second maximum), 64 distinct snapshots,
512 reads, and complete directory trees capped at 10,000 entries. After an
oversized/truncated recursive tree, later heads use directory walks directly.

SQL-backed author proofs use `moduleOrigin: author-sql`, `sqlPath`,
`sqlDestination`, `primarySqlBlob`, `sqlBlob`, `moduleDestination`, `moduleBlob`,
`moduleIdentity` (the hash of the normalized literal data module), and
`snapshotMergeBase`. Here `primaryRegistryBlob` names the snapshot-base registry;
the author did not change that registry or own the paired ordinal module.
The registry insertion must leave every base byte intact, and embedded SQL must
match the author's SQL exactly. Literal decoding rejects JSON escaped slashes
and Unicode surrogate escapes because their Python values differ. The predicate
may exempt the protected wrapper
and SQL path, while author-owned module/registry edits retain the original
paired-module rules. Every intermediate module must have the same normalized
identity; snapshots before module introduction still preserve the author SQL
and author-equivalent wrapper, including mechanical renames. SQL-only snapshots
after the first module-bearing observation refuse proof.

Chains with mechanical filename resets additionally carry `rebased: true` and
require evidence `migrationRenumberAncestry: { primaryHead, headSha, status:
diverged }`, obtained from an immutable compare and bound to both heads. All
observed bodies remain author-equivalent; only intermediate revision/slot
metadata can differ, and no observed slot may fall below the author slot.
Otherwise chains are strictly increasing. These fields are outside cached history
and flow with successful derived-change receipts; see the full persisted shape
in [merge-action receipts](automation-merge-actions.md). The history cache shape
and identity do not change.
