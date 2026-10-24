# Review finding records

**Owner:** review-body capture and remediation completion observations
**Store:** `data/reviews.db`
**Schema:** `migrations/20261021_review_findings.sql`
**Source of truth:** `src/review-finding-records.mjs`,
`src/finding-commit-attribution.mjs`, `src/finding-remediation-capture.mjs`

`review_findings` stores each blocking and non-blocking finding from first-pass
and rereview bodies using the existing kernel parser. Remediation comments and
closer passes are excluded. Unknown sections remain unknown in the parser;
missing locations and categories remain null rather than being invented.

The primary key is `<pass_id>:<ordinal>:<content_sha256>`. Ordinals are one-based,
with blocking findings followed by non-blocking findings. The hash covers a
fixed-order JSON object containing severity, title, category, file, lines,
problem, rationale and recommended fix. CRLF normalization comes from the
existing parser. Re-parsing the same body preserves identities and links.
Changed bodies retain previous content records with `current_body=0`; normal
reads include only the current parse. No records are automatically pruned.

Each record includes the source pass, severity, category, raw file and line
fields, title, parsed content, reviewer identity, model, effort and reviewed
head. Reviewer identity uses the pass's canonical attribution identity when
available, otherwise its recorded reviewer class. Model, effort, identity and
head follow subsequent pass attribution updates through a SQLite trigger;
historical unknowns remain null. This is review-service SQLite storage; no
session-ledger schema or Postgres migration changes.

## Reply and commit links

`review_finding_replies` stores the structured reply payload, artifact path,
job ID, round number, start head and published head. Its ID hashes the job,
round, both heads and payload. `review_finding_remediations` links each finding
to that reply, its array field and zero-based entry ordinal, the first
overlapping commit, and an explicit reason when no addressing commit is proven.
Replaying the same job updates the same links, including filling in history
that was unavailable on the first attempt.

Matching requires the same repository, PR, reviewed head and stored review body.
Reply titles use the existing kernel title normalizer; supplied file lists must
also match. Blocking findings match `addressed`, `pushback` or `blockers`;
non-blocking findings match `nonBlocking` or `addressed`. Duplicate or ambiguous
matches remain unaddressed. A pushback or blocker is linked as evidence but does
not count as an addressing commit. Every unmatched finding receives an explicit
`no-matching-reply` reason.

Commit attribution uses only local history between the round's start and
published heads. The base must lie on the published head's first-parent chain.
Line fields use the shared `src/kernel/finding-lines.mjs` parser, also consumed
by the existing primary-change authorization shim without policy changes.
Each commit uses one diff across all pending candidate paths, with NUL-delimited
raw path records paired to patch sections; quoted or unusual filenames remain
unambiguous. Zero-context hunks are compared with the finding's old line range. Pure insertions anchored after any cited line, including the last line
of a range or a single-line citation, count as overlap; insertions anchored
before the first cited line only shift the range, as do earlier deletions. A file touch
outside that range supplies no attribution. Missing locations, missing history,
nonlinear history and time or size limits leave the finding unaddressed.
Attribution is bounded to two seconds, 128 commits and 4 MiB per git output.
It does not fetch history, execute diff drivers, contact a provider, or establish
whether the finding was correct. Later adjudication can use these observations.

The completion writer captures links after the terminal job is durable. Capture
errors warn and preserve the existing completion result; stored bodies and jobs
remain available for offline repair. Body-capture errors likewise preserve the
stored review body and explicitly warn that backfill is required. Normal,
recovered orphan, daemon-bounce and historical body capture all use the same
finding writer. This observation layer does not change posting, review verdicts,
attestation, dispatch, closure predicates or lifecycle transitions.

## Hammer evidence

`review_finding_disputes` retains the existing hammer finding identity, evidence
head, comment ID, resolution, evidence digest and request/refusal counters.
SQLite insert/update triggers link disputes only to blocking findings of the
same repository, PR, finding identity and reviewed head. Finding backfill links
already-stored disputes too. Both paths require a non-null posted comment ID and a nonempty evidence head;
pending disputes are not projected before both are recorded. Late population
of a previously null head creates one concrete-head link rather than an
empty-head link followed by a duplicate.
Replacing the hammer's latest row for a newer
review does not erase older finding evidence. A missing reviewed head cannot
link a dispute. These records describe historical evidence; they grant no merge
authority and do not carry a withdrawal forward to an arbitrary evaluated head.

## Read API and offline repair

`readReviewFindings(db, options)` accepts a caller-owned, optionally read-only
SQLite connection. Filters are `repo`, `prNumber`, `afterPassId`, `afterOrdinal`
and `limit` (1–5000, default 500). The cursor is the last row's pass and ordinal,
so pagination can stop within a pass. Results include linked reply references,
commit evidence and disputes. A populated page uses three queries: the finding
selection and two batched linked-record reads using a bound JSON array. An
empty page uses only the selection query; read-only connections remain supported. The computed historical status is `withdrawn`
when recorded hammer withdrawal evidence exists, `dismissed` when the pass was
dismissed, `addressed` when a matched reply has an overlapping commit, otherwise
`unaddressed`. No new persisted lifecycle status is introduced. Missing or legacy
schema raises an error rather than reporting a misleading empty corpus.

The JSON CLI requires an explicit existing database; there is no production
default. `show` is read-only. CLI failures retain the actionable error and
stack on stderr while leaving stdout empty. These commands operate entirely on local inputs:

```bash
node bin/review-findings.mjs show --db /path/to/reviews.db --repo sample/service --limit 500
node bin/review-findings.mjs backfill --db /path/to/reviews.db --limit 500 --after-pass-id 0
node bin/review-findings.mjs link-job --db /path/to/reviews.db --job /path/to/job.json --workspace /path/to/history --round 1
```

Repeat `backfill` with the returned `nextPassId` until `scanned` is zero. A rerun
from zero is idempotent. `link-job` defaults to the current round; specify each
historical round explicitly. Without `--workspace`, reply links are retained
with `missing-history` rather than guessed commit evidence. Run migrations and
backfill through the normal deployment/maintenance lane after merge; no live
database, service or configuration change is part of a coding test.

## Non-blocking backlog (FINDINGSBATCH-01)

`finding_backlog` references the existing finding records, retaining repository,
PR, reviewed head, content hash, reviewer family and top-level cited path as its
area (`_uncited` for absent paths). The final posted review is selected by capture
time, end time, start time and pass ID, matching the captured-review resolver.
A merge-state transition enrolls its non-blocking findings in the same SQLite
transaction. Ready-to-merge capture additionally binds the exact head, body digest
and parsed count; failure must defer the strict-off merge. Enrollment is
idempotent across retries and duplicate passes on a head by repository, PR,
head and content hash. Late finding inserts on an already merged PR also enroll.
No historical full-corpus scan runs at deployment. Records are never pruned.

The migration is `migrations/20261024_findings_backlog.sql`, installed by the
existing review-state migration runner. All storage remains in `data/reviews.db`.

`finding_batches` owns one active batch per repository and area (partial unique
index), and at most one new batch per UTC date. An immediate SQLite transaction
assigns up to 100 oldest findings from confirmed merged PRs. Ready-to-merge rows
remain visible but cannot dispatch until merged. The watcher checks a cached UTC
midnight deadline after its ordinary poll; only the daily sweep does database,
GitHub or dispatch work, asynchronously from review admission. The deadline
advances after successful sweep completion; startup failures and fleet-stop
interruptions retry on the next poll with the existing claimed batches and dispatch
keys. An in-flight sweep fences overlapping ticks. Per-batch errors remain
recorded for the next daily sweep.

The sweep reuses `hq dispatch`, the configured remediation worker resolver and
normal priority. It persists the batch before submission and uses its stable
idempotency key after a lost receipt. A recorded launch fences further dispatch
until completion, across days and restarts. The manifest and atomic outcome
artifact live in `data/finding-batches/<batch-id>/`; retain them until collected.
Workers re-check current main, drop stale/no-evidence findings with reasons and
open one normal-review PR per area for valid fixes. An all-dropped batch needs
no PR. Outcome JSON must cover every manifest ID exactly once. Applied outcomes
require a merged PR in the same repository with the
`Finding-Batch: <batch-id>` body marker; otherwise the batch stays unresolved.
The collector reads body and merge state via `gh pr view` using the retrying
GitHub transport. Marker lines accept surrounding whitespace, bold or HTML
comments, while still requiring the exact batch ID. Normal review may rebase the batch PR;
completion records the worker outcome and PR merge, without granting merge authority.
`outcome` is null, `applied` or `dropped`; terminal rows retain `reason` and
`result_pr`. Batch failures retain `error` until valid manifest and batch PR
evidence is confirmed, at which point even an unmerged PR clears the stale error
without settling findings. Failures never discard findings or launch a second
worker blindly. Diagnose a missing artifact or failed worker before
repairing its existing batch; no automatic timeout releases its fence.

`pipeline-health` JSON includes `nonBlockingBacklog`; the read-only local CLI is
`node bin/review-findings.mjs backlog --db <existing-review-db>`. Each unresolved
repository/area reports `size`, `oldestAt`, `oldestAgeMs`, `waitingForMerge`,
`inBatch` and `error`. Missing schema/store reports `available: false`, never a
healthy empty backlog. No new alert transport or per-item provider read is added.
Ready captures superseded by the final merged review are retained as dropped
with reason `superseded-final-review`; they cannot inflate a later batch.
Late posting receipts also enroll findings for already-observed merges.
Ready captures closed without merge are dropped with `pr-closed-without-merge`;
if reopened and merged with that same final finding, merge enrollment restores
its pending outcome. This event-driven cleanup prevents abandoned merge attempts
from becoming a permanent waiting-for-merge backlog.

The existing `show` CLI/read API also returns `backlog_outcome`, `backlog_reason`,
`backlog_batch_id` and `backlog_result_pr` on the enrolled source finding. This
left join adds no per-finding query and leaves historical reply/commit status
semantics unchanged; use the backlog fields to audit batch application.
