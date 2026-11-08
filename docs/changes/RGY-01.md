# RGY-01 — Finding grade records

## Summary

Add an advisory, multi-source finding-grade store with a closed taxonomy and
append-only backfill from backlog outcomes, remediation receipts and disputes.
Lifecycle events remain distinct from false positives; withdrawals identify
interested parties. Unknown historical attribution stays unknown.

## Interface changes

- `src/review-finding-grades.mjs` exposes validated grade writes, explicit
  backfill and cursor-based reads. The additive migration creates
  `review_finding_grades` and finding provenance columns.
- `node bin/review-grades.mjs show|export|backfill --db <local-database>` requires
  an explicit database. Show/export are read-only; backfill is repeatable.
- Successful review executions record prompt set, stage and SHA-256 of the
  actual submitted text, plus harness. Findings retain the same provenance.
  Chunked reviews retain ordered per-chunk digests.
- No review strictness, routing, merge predicates, services or CI configuration
  change. Production backfill is a separate activation task.

## Verification

All test files ran serially with the network guard and a 600-second process-group
limit, using synthetic data and stubbed providers:

- `node --test test/review-finding-grades.test.mjs`: 5 passed.
- `node --test test/efforttune-02.test.mjs`: 8 passed.
- `node --test test/agy-usage.test.mjs`: 10 passed.
- `node --test test/reviewer-chunk-timeout.test.mjs`: 25 passed.
- ESLint fix/check on changed JavaScript: passed, no warnings or errors.
- `npm run lint`: passed, zero errors (existing repository warnings).
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 91 entries validated.

The full suite and unrelated walkthrough demo were not run under the ticket's
scoped-test constraint. No live database, service or model provider was used.
