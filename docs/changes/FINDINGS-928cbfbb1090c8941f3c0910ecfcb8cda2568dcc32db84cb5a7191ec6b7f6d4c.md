# FINDINGS-928cbfbb1090c8941f3c0910ecfcb8cda2568dcc32db84cb5a7191ec6b7f6d4c

## Summary

Add `idx_reviewer_passes_status_ended_at` on `reviewer_passes(status, ended_at)`
to bound readyz reviewer-pass failure diagnostics by status and completion time.
Schema convergence creates the index idempotently after legacy column backfills.
Keep the offline regression suite in `test/review-state-index.test.mjs` and
document the index in the reviewer-passes data model and catalog.

## Interface changes

No public API, row shape, lifecycle or merge-gate changes. Fresh and existing
databases gain a query index during schema convergence.

## Verification

After rebasing onto freshly fetched `origin/main`:

- `node --test test/review-state-index.test.mjs test/review-state-identity-schema.test.mjs test/review-state-schema-bootstrap-busy.test.mjs`:
  10 passed, covering fresh/legacy index use, repeat convergence, identity and busy bootstrap.
- `node scripts/validate-data-model-catalog.mjs`: validated 98 entries.
- `npm run lint`: zero errors, 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable deliveries.
- `git diff --check`: passed.

The full test suite is reserved for PR-head CI.
