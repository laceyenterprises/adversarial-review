# Review finding records

Review findings additionally carry nullable `reviewer_harness`, `prompt_set`,
`prompt_stage`, `prompt_digest` and `prompt_digests_json` from their pass's
`metadata_json.reviewerExecution`. The digest hashes the exact assembled prompt
text sent to the harness, including runtime guidance, context and diff. Chunked
passes have a NULL scalar digest and an ordered JSON array of actual chunk
prompt digests; no synthetic combined digest is invented. Custom prompt overrides
retain their actual digest with unknown set/stage. Legacy missing provenance
stays NULL. Projection and metadata updates retain this attribution. See
[reviewer passes](reviewer-passes.md) and [finding grades](review-finding-grades.md).

## Blocking evidence and factual disputes (REVIEWEVIDENCE-01)

New PR review output passes through the existing head-grounding pass before
posting or capture. It requires a repository-relative file and valid line/range
on the reviewed head, plus `Input or state: ...; Wrong outcome: ...` in Problem.
Unsupported cards become non-blocking and retain an `Evidence downgrade:` reason
in their parsed Problem; pass metadata retains the grounding reason too. JSON
model findings use path/detail and retain `evidenceDowngradeReason`. Historical
bodies retain their original interpretation; the corpus does not fetch files.
Missing repository metadata or an absent/malformed head SHA preserves the
original blockers and verdict. Grounding retains raw card Markdown and fenced
reproductions rather than rebuilding cards from parsed fields.
Failed file reads and exhausted file budgets preserve blockers and verdicts;
only confirmed absence or invalid citation/behaviour evidence permits demotion.
Hosted result verdicts follow the grounded body before settlement.

Completed, validated replies retain optional `pushback[].evidence` with the
reviewed `headSha`, original `citation`, and either `code`, `reproduction`,
`output` or `test`, `output`. An unambiguous matching factual dispute gets
`review_finding_remediations.reason = disputed-with-evidence`; the full payload
is retained in `review_finding_replies.payload_json`; linked remediation records
return only `dispute_evidence_json`, avoiding repeated full-reply payloads. The
finding remains unaddressed pending a trusted disposition.
Evidence citations accept comma- and semicolon-separated line ranges, such as
`src/worker.mjs:10-15; 20-25, 30`, and must match the original path and complete
ordered range list. The complete citation disambiguates identical titles during
completion and finding evidence projection. Known non-blocking acknowledgements in `addressed` can
accompany evidence-only completion; claimed blocker repairs cannot.

Worker evidence stays in the existing reply and finding-link records. The
watcher checks the completed job directly for adjudication routing. The merge
gate and dismissal readers accept only trusted hammer withdrawals from the
withdrawal store.

**Owner:** review-body capture and remediation completion observations
**Store:** `data/reviews.db`
**Schema:** `migrations/20261021_review_findings.sql`
**Source of truth:** `src/review-finding-records.mjs`,
`src/finding-commit-attribution.mjs`, `src/finding-remediation-capture.mjs`,
`src/findings-backlog.mjs`, `src/findings-batch.mjs`,
`src/finding-backlog-window.mjs`, `migrations/20261112_historical_projection.sql`,
`bin/review-findings.mjs`,
`migrations/20261024_simplicity_batch_lifecycle.sql`,
`migrations/20261107_findings_batch_requeue.sql`,
`migrations/20261120_findings_rate_indexes.sql`,
`migrations/20261122_findings_batch_hold.sql`,
`src/findings-batch-release.mjs`, `bin/findings-batch-release.mjs`

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
finding writer. Apart from factual-dispute admission above, this observation layer does not change posting, review verdicts,
attestation, dispatch, closure predicates or lifecycle transitions.

Finding projection takes the SQLite write lock before reading each pass with
an `IMMEDIATE` transaction. Enclosing live body-capture and orphan-recovery
transactions do the same: a nested transaction is only a savepoint and cannot
upgrade its parent's deferred snapshot safely. A competing WAL writer therefore
waits under the connection's busy timeout rather than invalidating a projection
snapshot. The safe live writer retries a busy failure once after 100 ms, then
retains the existing warning and review result if projection still fails.
Remediation-link projection also uses an immediate transaction.
The programmatic `backfillReviewFindings` options accept `onPass`, called with
`{ passId, inserted }` after each committed pass. A page retry can accumulate
these committed inserts even when a later pass fails; replayed inserts report
zero. Page selection stays outside the per-pass write transactions.
The backfill CLI streams `backfill-pass` JSON receipts to stderr with `passId`,
`inserted`, cumulative `committedPasses`, `committedInserted` and `lastPassId`.
If a pass fails, a `backfill-failed` receipt reports those committed totals
(zero and a null last ID if no pass committed) before the command exits nonzero.
Stdout retains the final page result on success. Retain both streams when
backfilling a live database; replay from the prior page cursor is idempotent.

Backfill shares the database with live writers, so it paces itself and does no
work for unchanged passes (OSGBACKFILLPACE-01). For each pass it reads the row
and parses the review body outside any transaction. A read-only snapshot then
compares the planned projection with the stored notes, findings, attribution,
prompt fields and dispute links. A pass whose projection is already current is
skipped without a write transaction. Otherwise one short `IMMEDIATE`
transaction re-reads the pass row and writes only if the row is unchanged. If a
live writer changed the row, the backfill re-reads and re-parses it outside the
lock. After three changed attempts it re-plans under the lock from the latest
row. A stale parse is never written. Live projection (`persistReviewFindings`)
keeps its read, parse and write inside one immediate transaction. After every
write transaction, including one that inserts nothing or fails, the backfill
yields so that write time stays at or below `maxWriteDutyCycle` of the
wall-clock time (default `0.2`; `1` disables pacing). The finding and grade
backfills accept `maxWriteDutyCycle` or a caller-owned pacer from
`createBackfillWritePacer`, so one pacer can span pages and both phases. The CLI
flag is `--max-write-duty-cycle`, validated before the database is opened. The
page result adds `written`, `skipped`, `replanned` and `pacing`. The `pacing`
object holds `maxWriteDutyCycle`, `writeTransactions`, `writeMs`, `yieldMs`,
`elapsedMs` and the effective `writeDutyCycle`. The module exports
`BACKFILL_WRITE_PACING_SUPPORTED = true` for companion callers.

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
SQLite connection. Filters are `repo`, `prNumber`, `prNumbers` (a nonempty
positive-integer list), `findingId`, `reviewerModel`, `reviewerHarness`,
`promptDigest`, `since` (inclusive), `until` (exclusive), `area`, `blocking`
(`any`, boolean or 0/1), and `labelState` (`ungraded`, `graded`, `disputed`).
All filters intersect before pagination. Timestamp strings accepted by
JavaScript's `Date.parse` are normalized to UTC ISO-8601 before comparison,
including RFC 2822 and non-ISO date strings. Timestamps compare instants. Area
matches a literal complete path or directory prefix after removing Markdown
backticks and padding spaces outside and inside them, or an exact backlog area;
SQL wildcard characters stay literal. Stored timestamps and file fields are unchanged.
Graded means at least one non-lifecycle, non-severity grade. Disputed means
conflicting real/false grades or evidenced withdrawals; it can overlap graded.
Lifecycle-only and severity-only grades leave findings ungraded. This selection
state does not resolve weighted consensus.

Pagination accepts `afterPassId`, `afterOrdinal` and `limit` (1–5000, default 500). The cursor is the last row's pass and ordinal,
so pagination can stop within a pass. Results include linked reply references,
commit evidence, disputes, ordered `grades`, and `graded`/`disputed` indicators.
A populated page uses four queries: the finding selection and three batched
linked-record reads using a bound JSON array. An
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

**Operational hard stop:** no activation re-run or other review-store backfill
or projection until OSGBACKFILLENROLL-01 and OSGPROJECTLOCK-01 are both merged
and floated in both repositories. Verify deployed revisions before any write.

A failed live projection warning requests backfill for evidence recovery only.
Backfill does not restore automatic enrollment, even for a recently merged PR.
Without a later genuine live projection, the recovered observations remain
historical; explicit manifest processing requires its normal consensus validation.

Repeat `backfill` with the returned `nextPassId` until `scanned` is zero. A rerun
from zero is idempotent. Historical projection inserts findings and simplicity
observations with `historical_projection=1` (integer 0/1, default 0), added by
`migrations/20261112_historical_projection.sql`. Both automatic candidate views
exclude these records, so insert, merge and late posting-receipt triggers cannot
enroll them. Existing records retain their original marker when replayed; a
historical replay cannot revoke an existing live capture. Historical projection
preserves matching advisory snapshots and retires stale unassigned notes. `persistReviewFindings` accepts
`{ historicalProjection: true }` for historical callers; `backfillReviewFindings`,
the body-repair backfill and historical link CLI always supply it. The module
exports `HISTORICAL_PROJECTION_SUPPORTED = true` to declare this boundary to
companion callers; the explicit OSG backfill refuses to run without it, and
`test/osgboundaryflag-01.test.mjs` pins the flag with the behaviour. A genuine live
projection can promote matching historical observations to live and enroll them
when the source is merged, recovering receipts that arrived before projection.
Only observations actually promoted from historical to live in this call get
explicit enrollment; replaying an already-live legacy observation does not
create a missing backlog row. New inserts retain their existing capture trigger.
The verified merge-capture boundary can therefore activate a previously backfilled
open PR. A raw receipt metadata update alone preserves the historical marker. Explicit manifest enrollment remains available after consensus
validation and deliberately bypasses this automatic enrollment boundary. `link-job` defaults to the current round; specify each
historical round explicitly. Without `--workspace`, reply links are retained
with `missing-history` rather than guessed commit evidence. Run migrations and
backfill through the normal deployment/maintenance lane after merge; no live
database, service or configuration change is part of a coding test.

The migration does not infer old provenance: every pre-migration finding and
note, including earlier historical-backfill incident rows, keeps the default
`historical_projection=0`. Replaying historical evidence does not reclassify
these live-default rows. Their first automatic claim is protected only by the
merge-age window; increasing that window can expose old incident data again.
Do not widen it to drain historical evidence. Any one-shot reclassification
requires separate operator authorization and remains subject to the hard stop.

## Non-blocking backlog (FINDINGSBATCH-01)

Simplicity advisories are separate observations in `finding_batch_notes`, added
by `migrations/20261024_simplicity_batch.sql`. Capture uses `extractSimplicityNote`
on the stored review body, including bodies with zero findings. Each record has
`note_id` (digest of pass ID and note), `pass_id`, `repo`, `pr_number`, `head_sha`,
`note`, nullable `batch_id` and nullable `dropped_reason` (added by
`migrations/20261024_simplicity_batch_lifecycle.sql`). Re-projecting a pass
replaces only its unassigned observations. Assigned snapshots are immutable. No advisory becomes a finding
or changes verdict parsing, strict-mode gates, round counts or retry caps.

Only a confirmed merged source PR's final posted review can supply a note.
Its verified `reviewed_prs.merged_at` must be at or after the original simplicity
migration's `schema_migrations.applied_at` receipt, compared as timestamps.
Historical backfill retains observations with `dropped_reason=historical-merge`
and cannot dispatch advice for PRs merged before that cutoff. Missing or invalid
merge timestamps use `merge-time-unverified` until refreshed.
Final-pass ordering matches the finding backlog below, including late posting
receipts. Superseded or already-owned duplicate notes remain unassigned with
`dropped_reason=superseded-final-review` and cannot dispatch. Unmerged closes
use `pr-closed-without-merge`. Source lifecycle/merge-time changes, note capture,
assignment and posting receipts recompute dispositions only for unassigned notes
of that PR; reopen and late receipts can restore current advice. The migration
also classifies existing unassigned rows once. The pending index excludes dropped
notes, keeping daily scans scoped to live backlog. Once a note on a given
repository/PR/head is assigned, identical text on a duplicate pass
cannot dispatch again. Notes join the first pending finding area for their
source review, or the reserved `_simplicity` area when there are no pending
findings. The existing daily, transactional per-area fences apply; a batch
assigns at most 100 notes as well as at most 100 findings. There is no historical
corpus body scan during migration; normal capture/backfill projects stored bodies
without making pre-cutoff merged advice dispatchable.

The batch prompt carries these notes separately and requires applying or
declining each one. Advisory fixes may touch their cited files outside the
finding area, so a mixed batch does not impose contradictory area limits.
Application is allowed only when net lines or runtime cost decrease without changing behavior. The existing `outcomes.json` result gains
`simplicityNotes: [{noteId, simplicityNoteApplied, reason}]`, covering every
assigned note exactly once with a boolean and nonempty reason. The collector
normalizes internal whitespace to one line before storing it, so a formatting
slip cannot prevent settlement of valid findings.
An advisory-only batch has `findings: []`. An applied note requires the same
published PR identity, exact batch marker and confirmed merge as an applied
finding; a fully declined/dropped batch requires no PR. On settlement, the
validated `{batchId, prNumber, headSha, findings, simplicityNotes}` projection
is retained in `finding_batches.result_json`, so true/false applied rates can be counted without reading worker artifacts.
Extra worker fields are discarded at both the top level and within outcomes;
unapplied batches store null PR/head identity. Applied/declined note states derive
from the completed batch result rather than mutable note columns.
Historical batches have null `result_json`. Existing batches without notes
continue to accept their original result shape.

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

The hammer pre-edit helper can use the same ready-to-merge capture path to enroll
one deferred advisory finding before making any author-line edit. The optional
`deferredFinding: { findingNumber, reason }` binds a one-based non-blocking section
position to the final captured body's exact head, digest and parsed count. Its
one-line explanation is stored in the existing backlog `reason` field while
`outcome` remains null: deferral neither resolves nor withdraws the finding.
Retries and duplicate passes use the existing repository/PR/head/content identity.
The Hammer closeout comment is the durable deferral audit. Backlog reason is
current state and can be replaced by a later outcome. Overdue alerts count only
unresolved findings whose source PR is merged.

Unavailable or stale capture fails before returning a deferral receipt. Existing
merge enrollment and batch dispatch rules still apply; an open source PR cannot
dispatch a backlog batch. No schema or lifecycle state is added.

The migration is `migrations/20261024_findings_backlog.sql`, installed by the
existing review-state migration runner. All storage remains in `data/reviews.db`.

FINDINGSBATCH-02 removes both the `(repo, area, day)` uniqueness and the
one-active-batch-per-area index. Migration `20261030_findings_batch_drain.sql`
preserves batch IDs, launch IDs, artifacts, results and child references. It adds
`finding_backlog.resolved_at`; existing terminal findings inherit their batch
completion time where available, while historical lifecycle drops with no dated
receipt remain undated. Outcome transitions maintain this timestamp. Historical
empty completed manifests become unresolved `batch-zero-outcomes` errors.

FINDINGSREQUEUE-01 migration `20261107_findings_batch_requeue.sql` adds
`finding_backlog.batch_attempts` (failed batch attempts, default 0),
`finding_batches.launched_at`, `released_at` and `release_reason`, and the audit
table `finding_batch_releases(finding_id, batch_id, attempt, reason,
disposition, released_at)`, where `disposition` is `requeued` or `exhausted`.
Re-applying it is safe. Existing rows keep their values; a pre-migration batch
has no `launched_at` and ages from its claim `day`.

### Releasing batches whose launch ended (FINDINGSREQUEUE-01)

A batch is released when every launch under its preparation and publication
keys is terminal in the launch ledger and either:

- settlement failed with an error that cannot clear after the launch ended:
  `batch-push-evidence-missing`, `batch-push-evidence-mismatch`,
  `batch-preparation-failed`, `batch-branch-missing`,
  `batch-publish-ended-without-pr: <status>`, `batch-publish-receipt-mismatch`,
  `batch-launch-evidence-mismatch`, `batch-publish-reused-decision-launch`,
  `invalid-batch-manifest`, `invalid-advisory-manifest`,
  `invalid-advisory-outcome` or `batch-outcome-too-large`; or
- the batch is still unsettled, with any error or with no outcomes artifact, more
  than `ADVERSARIAL_FINDINGS_BATCH_TIMEOUT_MS` (default 86400000, 24 hours) after
  `launched_at`. In this case a ledger that proves no keyed launch exists also
  counts as ended.

FINDINGSSTUCK-01 also releases an errored batch with no recorded launch after
the timeout, aging from its claim day, except for retryable dispatch failures
(described below). A readable keyed probe must prove every
launch terminal or absent; missing local receipts alone never prove absence.
Applied artifacts without a launch receipt report `batch-launch-receipt-missing`,
distinct from a missing pushed head.

When a launched batch's keyed receipt is empty or omits its recorded launch,
timeout release additionally reads that exact `launch_id` from the public ledger,
including retry descendants. The recorded launch must be present and every
observed launch must be terminal. A direct snapshot cannot certify absence. Unknown status, incomplete reads, unproven absence, mismatched
identity and live launches retain custody. Unreadable evidence after the timeout
emits `needs-operator` with the batch ID and a named probe reason; it never becomes
an absence certificate.

Migration `20261109_findings_batch_dispatch_attempts.sql` adds
`finding_batches.batch_attempts` (default 0), a durable counter of successful
initial dispatch responses with invalid/missing receipts. This differs from
`finding_backlog.batch_attempts`, which counts released finding attempts.
After three invalid receipts, no more initial dispatches are made for that
batch. Readable terminal/absent keyed evidence permits release with
`batch-dispatch-attempts-exhausted: batch-dispatch-receipt-invalid: <detail>`;
unreadable evidence reports `needs-operator`, and live launches retain custody.
A failed subprocess (including timeout, transport or admission failure) records
`batch-dispatch-retryable: <detail>` and retries with the same batch/key on the
next dispatch pass while preserving invalid-receipt charges. An overdue retry
reports `needs-operator` and retains custody without consuming per-finding
attempts. Legacy `batch-dispatch-failed` and raw `Command failed:` errors reset
the old counter once and become retryable. Resolution-only passes retain them
without dispatch.
Dispatch stderr is preferred to the command echo, redacted and capped at 300
characters before the named error prefix. Each release still charges a finding
only once. Reapplying the migration preserves the counter.

A live keyed launch, or ledger evidence that cannot be read, leaves the findings
untouched. A batch waiting on its open, marked PR has no error and is never
released. One compact per-pass `summary` log records total open findings and
stuck batch counts grouped by reason with the oldest age in milliseconds,
including `needs-operator` probe holds. Release runs in one transaction. Each still-open finding gets
`batch_attempts + 1` and an audit row naming the old batch and reason, then
returns to the queue with `batch_id` cleared. On its third attempt it is instead
dropped with `batch-retry-exhausted: <last error>`. The batch keeps its
`error`, launch ID and artifacts. It gets `released_at` and `release_reason` and
leaves the collection queue. Its advisory notes, which never gate anything, are
retired with `dropped_reason = 'batch-released: <reason>'`. The next claim pass
re-batches the findings. A re-batched finding hashes its attempt number into the
manifest, so the retry gets a fresh batch ID, artifact directory and dispatch
idempotency key, and never collides with the released batch.

#### Read scope and operator holds (FINDINGSBATCHSTRAND-01)

The review app reads dispatch launches only through exact `(project,
owner/repo)` grants. Every keyed batch read (the publication receipt probe and
the release probe) therefore names the pair the batch was dispatched under:
`project_ref` is `HQ_PROJECT` (default `adversarial-merge-authority`, the same
value passed to `hq dispatch --project`), and `repo` is the batch's qualified
repository. An unqualified repository keeps the unscoped read. Without the pair,
an unscoped read silently dropped the launch row, and the empty reply read as
unproven absence. A repository under a second GitHub owner with no grant
therefore held its batches with no stated cause. The scoped read is refused
instead (`selectorRefused`):

- Publication records `batch-dispatch-read-scope-denied: <project> <owner/repo>`.
- Release reports that same reason as `needs-operator` on the first pass,
  without waiting for the timeout, because only an operator grant clears it.
- Once the pair is granted, an unexpired prepared batch publishes on the next
  pass. An ended preparation releases as before.

With the grant present, a scoped empty reply can also carry the producer's
exact-selector absence proof.

Migration `20261122_findings_batch_hold.sql` adds `finding_batches.hold_json`,
`{reason, error, heldAt}` or NULL. Each release decision rewrites it: a
`needs-operator` result records the reason and keeps `heldAt` while the reason
and error are unchanged; any other result clears it. The backlog summary lists
`heldBatches` (`batchId`, `repo`, `area`, `launchId`, `reason`, `error`,
`heldAt`, `openFindings`) and `heldFindingCount`. It lists only unsettled,
unreleased batches whose current `error` still equals the held error, so a later
settlement write retires a stale hold. Any held batch raises
`review:findings_backlog_overdue`, with one `held=<batchId>:<reason>` evidence
entry per batch (at most 10).

The operator release verb is read-only unless `--apply` is given:

```sh
node bin/findings-batch-release.mjs --root <review-root> --db <review-root>/data/reviews.db \
  --batch <64-hex batch id> --mode retry|drop --reason '<one line>' [--accept-unreadable-custody] [--apply]
```

It refuses (exit 2, JSON `refused`) in these cases:

- the batch is already settled or released;
- the recorded launch's `hq dispatch status` is not terminal, is decision-blocked,
  is unreadable or names another launch;
- a readable keyed launch is live, decision-blocked or has an unknown status;
- the collector holds the batch's `publish.lock` (apply only).

When the keyed read is refused or unreadable, the verb proceeds only for a
recorded terminal launch with no `publish-intent.json` (no publisher submitted),
and only with `--accept-unreadable-custody`. Retry descendants of that launch are
otherwise unobserved.

- `retry` uses `releaseFindingBatch` with `operator-retry: <reason>`. Each open
  finding gets `batch_attempts + 1` and a `requeued` audit row; the third attempt
  exhausts as usual.
- `drop` sets each open finding to `outcome='dropped'`,
  `reason='operator-dropped: <reason>'`, retires the batch's advice and records
  `released_at`/`release_reason`. It writes no grade or release audit row.

A preview creates nothing, not even the lock file.

An immediate SQLite transaction assigns **all** unassigned findings from confirmed
merged source PRs to capped batches. Severity (`critical`/P0, `high`/P1,
`medium`/P2, `low`/P3) sorts first where supplied, then capture age and ID;
unclassified findings sort by age. Batches retain repository/area ownership, avoid mixing severity priorities, and
use a hash of their manifest IDs as stable identity. Combined findings and
advisories never exceed the cap. Repeating a claim, including on a later day,
finds no already-assigned IDs. Existing unfinished batches never prevent another
batch in that area. Claimed insertion order controls submission order.

The watcher claims and collects hourly by default, checking deadlines after its
ordinary poll. `ADVERSARIAL_FINDINGS_BATCH_INTERVAL_MS` and
`ADVERSARIAL_FINDINGS_BATCH_SIZE` configure cadence and cap (defaults 3600000
and 100); programmatic callers can supply `intervalMs` and `batchSize`.
`ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY` (positive integer, default 2) bounds the
live collector's concurrent `hq dispatch` submissions. Each pass submits every
claimed batch; dispatch provisions before it returns, so this bounds the pass's
wall-clock, not the number of batches. HQ normal-priority admission still owns
running worker capacity, and an invalid value refuses the pass before any claim.
There is no dedicated findings-batch slot in the shared strict CFG schema, nor a
previous named daily key: the old cadence and cap were literals. These local
runtime settings follow the existing pipeline-health environment convention;
this change adds no cross-repository schema key. Collection still runs at least
hourly when the claim interval is longer. Startup failures and fleet stops retry
on the next poll. An in-flight ticker fences overlapping polls.

The sweep reuses `hq dispatch`, the configured remediation worker resolver and
normal priority. It persists the batch before submission. If dispatch fails or
times out, it attempts a scoped read by idempotency key and adopts a matching
launch. Confirmed absence follows the dispatch-error path. Unreadable evidence
leaves custody unresolved for a later pass. A recorded preparation launch fences
further preparation until completion, across days and restarts. The manifest and atomic outcome
artifact live in `data/finding-batches/<batch-id>/`; retain them until collected.
FINDINGSSHAPE-01 keeps preparation `decision-only`: workers re-check current main,
drop stale/no-evidence findings with reasons, and push tested fixes on their batch
branch. They write provisional outcomes in the existing schema, with null
`prNumber` and the pushed commit as `headSha`. A provisional applied outcome never
settles a finding. An all-dropped/declined batch completes from this artifact
without GitHub, a push, or a publication launch. Preparation and publication
write complete JSON to a temporary file in the same directory and rename it to
`outcomes.json` with mode `0664`. The collector reads a dispatched batch's
provisional artifact after observing terminal preparation. Published outcomes with
an existing PR number skip further preparation status probes except when
recovering a legacy settlement JSON error. The collector retries malformed
outcomes after 50, 100 and 200 ms, then defers to the next collection pass.
A launched batch with a legacy JSON parse error waits for terminal preparation
and reuses its existing artifact and PR evidence without releasing its findings
when recovery cannot verify publication.

For provisional applied findings or advice, the collector validates complete
manifest coverage, waits for terminal preparation (including a launch parked at
publication), and reads its branch from `hq dispatch status --json`. The launch
ID must match; a non-null slug/short-name status repository must match too.
Absolute native repository/workspace paths are display metadata and supply no
repository authority. The public launch projection intentionally omits worktree
paths; no extra workspace field or path-based fallback is required. See
FINDINGSBATCHCUSTODY-01 in the follow-up runbook.
The keyed launch
ledger must independently bind that launch to the repository and ticket. Status
`repo` may be null in the producer contract. `git-safe` writes a branch-push
projection (`status: pushed`, `reason: branch_pushed`), which does not guarantee a
`branch_pushed` milestone in dispatch status. The collector therefore checks the
remote branch SHA against the reported tested head, or recovers the marked PR.
Dispatch status fills every unobserved milestone as `not_started` and does not
re-probe a decision-only launch when it exits, so a real push can show any
non-`done` value. Since FINDINGSREQUEUE-01 the milestone value is not consulted
at all; the remote tested head is the push evidence. Failed or unknown terminal
preparation still refuses publication. It looks for PRs on that branch across all states before inspecting the
remote ref, preserving branch slashes and percent-encoding each path segment.
The same-repository PR with the exact marker prevents a duplicate publisher,
even after its branch is deleted. If a publisher exited before updating the
artifact, the collector atomically recovers only `prNumber` and `headSha` from
the single validated branch PR, preserving every decision and reason. Recovery
requires a positive PR number and valid head SHA as well as the branch,
same-repository and exact-marker checks. It then uses the ordinary numbered PR
lookup in the batch repository for settlement; no live publisher is required.
An unmerged close stays unresolved. Foreign, unmarked, or ambiguous branch PR
evidence retains the batch fence. Transient transport, timeout, signal and JSON
parse failures keep the batch pending for the next collection pass. Parse
diagnostics log the operation and byte count. Permanent authentication,
permission, repository and valid-JSON evidence failures remain visible in the
batch error and enter the existing timeout and terminal-custody release path.
Only release charges finding attempts for those failures.

With no existing PR, a matching remote branch SHA permits one follow-up
`--completion-shape pr --branch <existing-branch>` launch. If preparation ended
`blocked_needs_decision`, the collector first calls
`hq decision supersede-publication` with the exact source launch, batch,
repository, branch and tested head. The supported API refuses saved answers,
continuations, live processes and unpushed work; it supersedes the decision
without an answer, closes blocked launch/run capacity, and releases the retained
branch under the existing locks and Git fence. Only a receipt with
`state=superseded` and `branchReleased=true`, matching every binding field,
permits publisher submission. `finding_batches.decision_publication_json`
retains that receipt. A source canceled by an interrupted handoff is accepted
only through this same API/audit recovery. A succeeded preparation follows the
ordinary path without closing a decision. The preparation prompt ends
successfully after its tested push and complete outcomes artifact.

The collector re-reads keyed launch custody after the lifecycle call. A verified
handoff adds its exact binding as `publish-intent.json.decisionPublication`.
After the previous intent's submission deadline and grace, an intent without
that field may be replaced once even if its pre-handoff retry was spent.
`handoffOf` preserves the prior `submittedAt`, `dispatchTimeoutMs` and
`resubmissionCount`; the new publication epoch starts at zero and retains the
ordinary single proven-absence retry. An intent already carrying the handoff
binding cannot renew its retry this way. Unknown bindings, live/late publisher
receipts and unreadable evidence retain custody. Successful handoff work with
no publisher remains retained beyond the age limit.

Publication failures store the actual `[hq] error:` cause (or stderr fallback)
within the existing 300-character error bound; one watcher log record per
failure retains the redacted full stderr. An unresolved blocked decision keeps
its batch even beyond the ordinary age limit and reports
`batch-decision-custody-retained` for operator attention.
Untyped lifecycle failures carry `batch-decision-publication-failed` so an
already canceled source also retains its batch as
`batch-decision-publication-unresolved`. A verified receipt updates both the
stored row and the in-memory batch before subsequent publication steps.
Both phases retain the batch ID and ticket. Preparation uses
`findings-batch-<batch-id>` and publication uses `findings-batch-publish-<batch-id>`.
After a failed preparation submission or invalid receipt, the collector checks
the exact preparation key. A matching launch is adopted. Readable absence uses
the existing dispatch error accounting. An unreadable or unconfirmed probe logs
a warning and defers that batch for a later pass without charging an attempt.
Other queued batches continue dispatch and settlement in the same pass.
A PR-shaped launch without PR evidence still fails. The collector reads scoped
launch receipts, including terminal rows, before publication. It continues to
recognize legacy publishers under the preparation key. A publisher with a new
key has a durable intent before submission. Any publisher receipt fences another
publisher, even after failure or a lost response. A per-batch file lock serializes
collectors, and atomic `publish-intent.json` records `batchId`, `branch`,
`idempotencyKey`, `sourceLaunchId`, ISO `submittedAt`, `dispatchTimeoutMs` (the
actual load-scaled timeout used), and `resubmissionCount` (initially zero) before
submission. An ambiguous transport failure with no visible receipt retains that
intent and reports `batch-publish-receipt-pending` through the submission deadline
plus `ADVERSARIAL_FINDINGS_BATCH_PUBLISH_RECEIPT_GRACE_MS` (default 10 minutes;
positive integer milliseconds, injectable as `publishReceiptGraceMs` in runner
options). Only strictly after that bound, with readable keyed evidence containing
the decision launch, no publisher row, and every keyed row terminal, the collector
atomically replaces the intent under the same lock and resubmits once on the same
branch and ticket using the publication key. The replacement has `resubmissionCount: 1` and `resubmitOf`
containing the prior submission's `submittedAt` and `dispatchTimeoutMs`. It is
durable before dispatch, so even another failed submission cannot earn a third.
Legacy intents without `submittedAt` use file mtime; a missing timeout uses the
current load-scaled dispatch bound. Malformed or mismatched intent evidence holds.
Any publisher row retains the existing receipt recovery/terminal failure behavior;
unreadable probes report `batch-publish-receipt-unavailable`, and live or unknown
keyed custody never permits resubmission. A second absence stays pending until
the existing bounded stale release. Retain the
intent, `publish.lock` inode, and `publish-prompt.md` beside the outcomes artifact.
These are collector recovery artifacts; the outcome schema is unchanged.
The nullable handoff receipt column is added by
`migrations/20261114_findings_decision_publication.sql`. Uncertain publication outside that one proven-absence retry requires
repairing the existing launch/intent after proving its state, rather than
resetting the batch ID/key or starting a fresh branch. Once every keyed launch has ended, the
FINDINGSREQUEUE-01 release path above returns the findings to the queue instead.

The publisher reuses the pushed branch and checks for an existing PR again,
opens the single PR through `hq pr open --spec-ref none` with the exact batch
marker, and atomically updates only `prNumber` and `headSha` in the outcome
artifact. For an older parked batch, retain its original batch row and launch ID,
retain its complete provisional manifest without inferring or rewriting decisions, and
retain its pushed branch. Collection follows the same recovery path without
reapplying fixes or opening a duplicate PR. No runtime recovery is performed by
this source change.

Outcome JSON must cover every manifest ID exactly once. Applied outcomes
require a positive PR number (the existing SQLite CHECK), a commit SHA and the
`Finding-Batch: <batch-id>` body marker. The PR must be merged, or open with a
matching head enrolled in `reviewed_prs` in an active review-pipeline state.
A closed unmerged PR, an unattached open PR or stale-head attachment stays
unresolved.
The collector reads body and merge state via `gh pr view` using the retrying
GitHub transport. Marker lines accept surrounding whitespace, bold or HTML
comments, while still requiring the exact batch ID. Normal review may rebase the batch PR;
completion records the live PR head and outcome, without granting merge authority.
`outcome` is null, `applied` or `dropped`; terminal rows retain `reason` and
`result_pr` (null for dropped findings). Batch failures retain `error` until valid manifest and batch PR
evidence is confirmed, at which point even an unmerged PR clears the stale error
when it is not yet eligible to settle. Failures never discard findings or blindly repeat a
preparation/publication phase within a batch. After the batch's launches end, the
release path re-batches the findings under a bounded attempt count.

`pipeline-health` JSON includes `nonBlockingBacklog`; the read-only local CLI is
`node bin/review-findings.mjs backlog --db <existing-review-db>`. Each unresolved
repository/area reports `size`, `oldestAt`, `oldestAgeMs`, `waitingForMerge`,
`inBatch` and `error`. Size and age cover findings plus pending or
assigned-unsettled notes, including advisory-only batches and their launch or
settlement errors; completed notes and dropped unassigned notes are excluded.
Unassigned historical notes and merged-source notes outside the age window
are also excluded from `areas`. `notesHistorical` counts unassigned, undropped
historical notes; `notesOutOfWindow` separately counts unassigned, undropped
live-default notes whose merged source has an old or unknown merge timestamp.
These evidence counters do not dispatch work or trigger the finding-only
overdue alert. Assigned notes remain monitored in their owning area regardless
of age or provenance.
Unassigned notes waiting for a source merge use `_simplicity` until assignment;
assigned notes retain the owning batch's area. Missing schema/store reports
`available: false`, never a healthy empty backlog. No new alert transport or per-item provider read is added.
Ready captures superseded by the final merged review are retained as dropped
with reason `stale-code-changed: Final posted review superseded this finding`; they cannot inflate a later batch.
Live late posting receipts also enroll findings for already-observed merges.
First automatic batch claims require a valid source `merged_at` within
`ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS` (default 48 hours) of the current clock;
the boundary is inclusive. This applies to findings and simplicity advice.
Released findings (`batch_attempts > 0`) remain eligible regardless of source
merge age or timestamp validity, until settlement or third-attempt exhaustion.
Unknown merge times fail closed for never-claimed work. Skipped findings retain
their rows, outcome, reason and ownership. Summary `outOfWindow` counts automatic, open, unassigned
findings with no prior release and old or unknown merge times; these are excluded
from `batchableCount` and its oldest timestamp. Already-owned batches remain monitored regardless of
source age, as do released findings awaiting retry. Explicit manifests bypass the
automatic age filter and remain separately accounted in `selectedBacklog`.
Direct `claimFindingBatches` callers may pass `env` for the default age window.
Explicit manifest claims do not read or validate the unused automatic window
or clock.
Ready captures closed without merge are dropped with
`false-positive: Source PR closed without merge; reviewed changes did not land`;
if reopened and merged with that same final finding, merge enrollment restores
its pending outcome. This event-driven cleanup prevents abandoned merge attempts
from becoming a permanent waiting-for-merge backlog.

The existing `show` CLI/read API also returns `backlog_outcome`, `backlog_reason`,
`backlog_batch_id` and `backlog_result_pr` on the enrolled source finding. This
left join adds no per-finding query and leaves historical reply/commit status
semantics unchanged; use the backlog fields to audit batch application.

Worker drops use `reason: "<code>: <justification line>"`, with code restricted to
`stale-code-changed`, `already-fixed-in-<positive PR number>`, `not-reproducible`,
`out-of-scope-with-ticket`, or `false-positive`. The worker must describe the
current-main evidence; lack of time is not a drop. For already-fixed drops the
worker cites the merged fix with its repository and explains the current-main
evidence. The collector retains the citation as evidence without a GitHub
lookup. Out-of-scope drops must cite a ticket or ticket URL. Incomplete,
duplicate or foreign manifest IDs leave the
entire batch unresolved (`invalid-batch-manifest`). Since FINDINGSREQUEUE-01 a
single bad outcome no longer errors the batch. A legacy drop reason written
before this vocabulary maps to the current code only when the code is exact and
justified. That covers spelling variants such as `False positive - <why>`,
`Stale: <why>` or `already fixed in #23: <why>`, plus the lifecycle codes
`superseded-final-review` and `pr-closed-without-merge`. Any other drop reason,
any outcome other than `applied`/`dropped`, a blank reason, or an out-of-scope
drop with no ticket returns that finding to the queue for re-verification. This
counts as an attempt and is recorded in `result_json.requeued`. The rest of the
batch settles normally, and such a claim is never published as applied. Empty finding/advisory
manifests fail instead of completing. Advisory-only applied/declined manifests remain supported.

Health also exposes finding-only `openCount`, `unbatchedCount`, `oldestOpenAt`,
`oldestOpenAgeMs`, `perDay` (applied/dropped by UTC resolution date), `rates`
(`capturedLastHour`, `resolvedLastHour`, `batchesCompletedLastHour`, and
`netLastHour` = captured − resolved; a positive net means capture is outpacing
the drain), and aggregated
unresolved `batchErrors` (released batches excluded), plus the drain view
`progress`: `open` (= `unbatched` + `batched` + `stranded`), `unbatched`, `batched`
(in an unsettled batch with no error), `stranded` (in an unsettled batch with an
error), `retrying` (open after at least one release), `exhausted` (dropped with
`batch-retry-exhausted:`) and `releasedBatches`. The drain is complete when `open`
is 0. `review:findings_backlog_overdue` enters the existing
pipeline-health/Sentinel findings path when the oldest batchable finding exceeds
`ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS` (default 172800000, 48 hours).
It also fires whenever `outOfWindow > 0`, so ordinary merge-time enrollments
remain visible after a stalled runner misses their first-claim window. Operator
batch backfill can reclaim released findings regardless of age; never-claimed
out-of-window findings can use an explicit consensus-validated manifest or an
operator expiry disposition, including ungraded findings:

```sh
node bin/review-findings.mjs retire-expired --db <existing-review-db> \
  --repo <owner/repo> --limit 100 --reason '<operator disposition rationale>'
```

This defaults to a read-only preview of at most 100 finding IDs (limit 1–500).
After reviewing the candidates and obtaining live-operation authorization,
repeat with `--apply`. Each invocation reselects under an immediate transaction,
so concurrent claims retain their owner. Only automatic, merged-source,
never-claimed, unassigned, unresolved rows outside the configured window are
eligible, including unknown merge times. Selected and released work is excluded.
Apply retains every source/backlog record, writes `outcome='dropped'` and
`reason='out-of-window: <rationale>'`, and uses the existing `resolved_at`
transition trigger. It makes no correctness grade, batch, release or paid
dispatch. Repeated bounded invocations clear the expired count and its alert;
newly aged-out work can alert again. No live invocation is authorized by this
source change; the existing backfill/projection hard stop remains in force.

Pipeline health uses its resolved `findingsBacklogMaxAgeMs` for both summary and
alert thresholds. Invalid direct summary defaults return `available: false`
without throwing out of the health API.
This is an operational alert, with no additional merge or CI gate.

The three last-hour rates use strictly-after-cutoff normalized timestamp range
reads, excluding selected work. Migration `20261120_findings_rate_indexes.sql`
adds partial expression indexes on `julianday(captured_at)`,
`julianday(resolved_at)` (terminal outcomes only), and `julianday(completed_at)`.
Each index excludes rows with a selection manifest. These indexes preserve
offset timestamp semantics without scanning historical rows for each rate.
Schema migration builds them once over existing history; no data is rewritten.
Other backlog summary fields retain their existing query behavior.

The live ticker's `ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY` accepts integers 1–8
(default 2). Invalid settings and out-of-range explicit ticker overrides reject
the pass before claiming or submitting batches. The ceiling bounds concurrent
host provisioning subprocesses; HQ admission still owns running worker capacity
and budget. Direct `runFindingBatches` callers and explicit backfill concurrency
retain their existing positive-integer interface.

After deployment and watcher restart, SRE explicitly runs the one-shot drain:

```sh
node bin/findings-batch-backfill.mjs --root <review-root> \
  --db <review-root>/data/reviews.db --concurrency 2 --batch-size 100
```

Both target and submission concurrency are required. The command cuts the whole
eligible open backlog and submits at most the requested number of concurrent
`hq dispatch` calls; HQ's existing normal-priority admission still owns running
worker capacity and budget. It does not create a second admission mechanism.
Rerunning retains batch IDs and launch/publication fences. Failed batches retain
their findings and reported errors for repair of the existing launch/artifact;
never clear ownership or open a duplicate PR to retry. No backfill runs at deploy
or startup. Within 24 hours SRE records declining open count, dated applied/dropped
outcomes and absence of evidence-format failures. This organic receipt is separate
from offline synthetic tests.

### Graded selection remediation

`node bin/findings-batch-backfill.mjs` additionally accepts
`--manifest <selection.json>` with the RGY-02 version 1 frozen manifest:
`findings` entries contain `finding_id`, `repo`, `pr_number`, `head_sha`;
`heads` lists distinct objects `{repo, pr_number, head_sha}`, sorted by repository,
PR number and head SHA; `sha256` hashes compact,
recursively key-sorted, ASCII-escaped JSON of
`{"version":1,"findings":<entries sorted by finding_id>}`. Metadata such as
name, counts and estimates is not hashed. Files are capped at 128 MiB and 10,000 findings. Validation and one consensus read per finding run before the claim write transaction.
Every entry must match its stored finding identity and reviewed head before any
claim or dispatch. Tampering, duplicate/missing identities and pin mismatches
refuse the selection.

An explicit selection admits only consensus-real findings from merged source
PRs, using the [grade consensus seam](review-finding-grades.md). It may enroll
selected blocking findings absent from the automatic non-blocking backlog. Enrollment requires a current body in the final posted first-pass/rereview.
Existing owners and terminal outcomes are preserved; an already-owned finding
is not stolen or rebatched. No simplicity advisories enroll in selected batches.
Workers must re-check applicability on current main and drop findings that no
longer apply. Grades describe reviewed-head correctness; they do not prove main
applicability.

`migrations/20261108_findings_batch_manifest.sql` adds nullable
`finding_batches.manifest_sha256`. The additive
`20261108_findings_selection_scope.sql` also stores `finding_backlog.manifest_sha256`,
including recovery from existing selected batches and, only for unowned rows,
release receipts. A current default batch never inherits an old selection. Selected batch IDs incorporate that hash,
and selected runner invocations dispatch/collect only matching batches.
Releases still increment attempts and retain old batch evidence; repeating the
selection re-reads consensus and can claim released real findings under fresh IDs.
Default claims exclude selected backlog rows; the default ticker never starts an
undispatched selected batch. Collection/publication of already-started selected
batches continues. Selected rows and batches are excluded from the automatic
non-blocking backlog health counts. The summary additionally exposes
`selectedBacklog`, an array grouped by `manifestSha256`, with `openCount`,
`unbatchedCount`, `erroredCount` (open findings in batches with errors), and
`undispatchedCount` (open findings owned by batches without a launch ID).
Dispatch failures and released selections remain visible here and require an
explicit rerun with that manifest. Before the selection columns are migrated,
`selectedBacklog` is null and automatic-drain health remains available.
No selection is automatically activated.
Settlement writes append-only `batch-remediator` grades (`lifecycle` for `life.*`) atomically with valid
outcomes after existing publication/PR checks. Requeue and exhaustion produce
no correctness grade. No new lifecycle state or merge authority is introduced.

At deployment, the operator receipt records `outOfWindow` and
`notesOutOfWindow` from `node bin/review-findings.mjs backlog --db <existing-review-db>`
as a known standing alert baseline. Late-observed merges retain their original
merge time; missing merge times fail closed. Enrollment does not restart the
window. Retiring expired rows requires separate authorization under the hard stop.
