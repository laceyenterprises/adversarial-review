# OSGPROJECTLOCK-01

## Summary

Finding projection and its enclosing body-capture/recovery transactions acquire
an immediate SQLite write reservation before reading. Remediation-link
projection does the same. Grade backfill commits one immediate transaction per
review pass, keeping shared WAL writer holds short. The safe live finding path
retries a busy failure once before retaining its existing advisory warning.
Review verdicts, strictness, dispatch and merge authority are unchanged.

## Interface changes

The finding and grade backfill APIs accept an optional `onPass` callback with
`{ passId, inserted }` after each committed pass. Callers can count committed
inserts accurately while replaying a partially completed page. Persistent
schemas, finding identities and immutable grade source keys are unchanged.

The findings and grades CLIs stream committed-pass JSON receipts to stderr,
including cumulative committed totals and the last pass ID. On failure they
emit a final progress receipt before exiting nonzero; stdout retains its
existing final-result shape. The post-merge plan provides a read-only count
probe and explicitly reserves backfill execution and receipt review for the
designated operator.

## Follow-up

`captureReadyFindings` in `src/findings-backlog.mjs` still encloses projection
in a deferred transaction. Track its immediate-transaction change and a WAL
contention regression as the OSGPROJECTLOCK-01 merge-boundary follow-up.
This can defer a merge under contention; it does not silently lose findings.

## Verification

Synthetic temporary WAL fixtures use real connections on separate threads to
reproduce deferred snapshot failure and cover immediate lock waiting, writer
exclusion after the projector read, live retry/exhaustion, resumed backfill and
per-pass grade commits. CLI fixtures abort the first or second pass and verify
committed receipts, nonzero exits and idempotent replay for both backfills.

Commands run from the repository root:

```sh
bash bin/run-bounded.sh --timeout 60 -- node --test test/review-backfill-cli.test.mjs test/finding-projection-contention.test.mjs test/review-finding-records.test.mjs test/review-finding-grades.test.mjs
bash bin/run-bounded.sh --timeout 60 -- npm run lint
bash bin/run-bounded.sh --timeout 60 -- npm run typecheck:contracts
bash bin/run-bounded.sh --timeout 60 -- bash demo/research-finding-walkthrough.sh
node scripts/validate-data-model-catalog.mjs
git diff --check
```

The four focused suites pass 37 tests. Lint reports zero errors (149 existing
warnings); contract typecheck, byte-equivalence demo, catalog validation (94
entries) and whitespace checks pass. The full suite is reserved for PR-head CI.
The nine contention cases also pass through a checkout path containing spaces.
The YAML count command was executed against a synthetic database with spaces
in its filename and returned the expected two findings and one grade.

## Manual post-merge acceptance

From the deployed review-service checkout, the designated operator sets
`ADVERSARIAL_REVIEW_DB` to the explicit existing review database. Keep daemons
active and retain stdout (page/final results) and stderr (committed-pass receipts)
from these commands in the maintenance record:

```sh
node bin/review-findings.mjs backfill --db "${ADVERSARIAL_REVIEW_DB:?}" --limit 500 --after-pass-id 0
```

For each next page, replace the cursor below with the previous result's
`nextPassId`; continue until `scanned` is zero:

```sh
node bin/review-findings.mjs backfill --db "${ADVERSARIAL_REVIEW_DB:?}" --limit 500 --after-pass-id <nextPassId>
node bin/review-grades.mjs backfill --db "${ADVERSARIAL_REVIEW_DB:?}"
```

Run the plan's read-only count probe after this complete sweep. Repeat the entire
sweep from cursor zero and retain another count receipt. Require zero duplicate
inserts for previously committed passes and stable counts for that corpus;
account separately for newly posted passes during the observation. Failures
retain their last committed pass and totals and require a successful retry
before acceptance. Also retain the consuming application's seven-day reviewer
report without backfill-required gaps. These are manual acceptance requirements;
a successful count probe alone cannot complete them. The consuming application
owns its deployment/maintenance runbook and reporting command outside this repo.
