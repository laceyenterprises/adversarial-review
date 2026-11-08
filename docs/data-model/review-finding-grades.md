# Review finding grades

`migrations/20261108_review_finding_grades.sql` owns the additive
`review_finding_grades` table in the reviews database. Schema application uses
the existing transactional migration runner and tolerates repeat application.
`src/review-finding-grades.mjs` owns validation, append-only source observations,
backfill and reads. Grades are advisory observations; review strictness, routing,
withdrawal admission and merge predicates do not read them.

Each finding can have multiple grades. `grade_id` is the export cursor;
`source_key` uniquely identifies an immutable observation. Replaying a source
key does not replace its grade. Backfill keys include the source record hash,
so changed evidence adds a grade and preserves earlier observations.

Fields include `finding_id`, nullable `graded_head_sha`, `grader_kind`, nullable
`grader_harness`, `grader_model`, `grader_effort`, `prompt_digest`, `label`,
`taxonomy_code`, nullable `confidence`, `evidence_sha256`, `evidence_json`, nullable
`cost_usd`, positive `attempt`, `interested_party`, `lifecycle` and `graded_at`.
The evidence hash is SHA-256 of the exact stored JSON bytes. Unknown historical
arm, prompt, confidence, cost and evaluation head stay NULL. A backlog's reviewed
head is evidence about the source review, not proof of the main head evaluated
by a batch worker. A known source resolution time supplies `graded_at`; otherwise
it is the backfill observation time, with the original timestamp fields preserved
inside evidence. Backfill attempt defaults to one observation; remediation round
numbers remain in evidence and are not presented as grader attempts.

The closed taxonomy maps `tp.valid`, `tp.already-fixed-elsewhere` and
`tp.out-of-scope` to `real`; `fp.misread-code`, `fp.hallucinated-symbol`,
`fp.wrong-spec`, `fp.speculative`, `fp.duplicate` and `fp.unclassified` to `false`;
`ind.stale`, `ind.cannot-reproduce`, `life.pr-closed` and `life.superseded` to
`indeterminate`. Severity calibration codes `sev.should-block` and
`sev.should-not-block` require an explicit label. Storage and the write API
reject unknown taxonomy/label combinations. Only `life.*` grades have
`lifecycle=1`.

Backfill retains one grade per eligible source observation:

| Source | Mapping |
| --- | --- |
| Applied backlog result | `tp.valid`, batch-remediator |
| Already-fixed / out-of-scope drop | `tp.already-fixed-elsewhere` / `tp.out-of-scope`, batch-remediator |
| Stale / not reproducible drop | `ind.stale` / `ind.cannot-reproduce`, batch-remediator |
| Exact close / superseded trigger text, including legacy codes | `life.pr-closed` / `life.superseded`, lifecycle |
| False-positive drop | Explicit taxonomy reason maps to `fp.*`; ambiguous prose maps to `fp.unclassified` |
| Remediation with an attributed commit | `tp.valid`, remediator |
| Evidence-backed remediator withdrawal | `fp.unclassified`, remediator, interested party |
| Hammer withdrawal with a comment receipt | `fp.unclassified`, hammer, interested party |

Legacy drop spellings use the batch collector's existing normalization. Unknown
outcomes, retry exhaustion, unmatched replies and missing history do not fabricate
a grade. Commentless remediator withdrawals are read from their admitted dispute
record and matched on finding identity and reviewed head. These source records
remain separate from remediation replies. No consensus is computed here.

Commands require an explicit existing database:

```sh
node bin/review-grades.mjs backfill --db <local-database>
node bin/review-grades.mjs show --db <local-database> --finding-id <finding-id>
node bin/review-grades.mjs export --db <local-database> --after-grade-id 0 --limit 500
```

Backfill explicitly migrates the selected database, synchronizes dispute
projections and adds grades in a transaction. It does not run automatically at
startup or deployment. `show` and `export` open SQLite read-only and never migrate.
Both accept optional `--finding-id`, `--repo`, `--after-grade-id` and `--limit`
(1–5000). Show emits a JSON page with `grades` and `nextCursor`; export emits one
grade per JSONL line. Continue with the last grade ID until a page is empty.
Missing/legacy schema fails visibly. Reads include source reviewer provenance
and the reviewed head separately from the graded head. Keep production exports
in private storage; public test fixtures are synthetic.
