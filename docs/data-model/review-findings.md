# Review finding records

**Owner:** review-body capture and remediation completion observations
**Store:** `data/reviews.db`
**Schema:** `migrations/20261021_review_findings.sql`
**Implementation:** `src/review-finding-records.mjs`,
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
For each commit, zero-context diffs are compared with the finding's old line
range; earlier unrelated insertions and deletions shift the range. A file touch
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
already-stored disputes too. Replacing the hammer's latest row for a newer
review does not erase older finding evidence. A missing reviewed head cannot
link a dispute. These records describe historical evidence; they grant no merge
authority and do not carry a withdrawal forward to an arbitrary evaluated head.

## Read API and offline repair

`readReviewFindings(db, options)` accepts a caller-owned, optionally read-only
SQLite connection. Filters are `repo`, `prNumber`, `afterPassId`, `afterOrdinal`
and `limit` (1–5000, default 500). The cursor is the last row's pass and ordinal,
so pagination can stop within a pass. Results include linked reply references,
commit evidence and disputes. The computed historical status is `withdrawn`
when recorded hammer withdrawal evidence exists, `dismissed` when the pass was
dismissed, `addressed` when a matched reply has an overlapping commit, otherwise
`unaddressed`. No new persisted lifecycle status is introduced. Missing or legacy
schema raises an error rather than reporting a misleading empty corpus.

The JSON CLI requires an explicit existing database; there is no production
default. `show` is read-only. These commands operate entirely on local inputs:

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
