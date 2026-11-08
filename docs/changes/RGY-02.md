# Finding selection read API

## Summary

`readReviewFindings` accepts repo, PR number/list, finding ID, reviewer model,
harness, prompt digest, inclusive since/exclusive until, literal area prefix,
blocking and label-state filters before keyset pagination. Returned findings
include ordered grade records and graded/disputed indicators. Graded excludes
lifecycle and severity-only observations. Disputed includes conflicting
real/false grades or evidenced withdrawals and can overlap graded. Timestamps
compare instants, and area matching respects path boundaries (or backlog area).
The API remains observational and supports caller-owned read-only connections.

## Interface changes

Validated `since` and `until` strings are normalized to UTC ISO-8601 before
SQLite comparison, so RFC 2822 and other JavaScript-accepted formats no longer
silently return no findings. Area queries strip padding spaces both outside and
inside Markdown backticks while preserving literal path boundaries. Stored
records, lifecycle states and merge authority are unchanged.

The existing populated-page regression now expects four batched queries,
including the grades read already documented by this API.

## Verification

- `node --test test/review-finding-selection.test.mjs test/review-finding-records.test.mjs`:
  23 passed; the two new regressions failed before the query fixes.
- `npm run lint`: passed with zero errors (existing warnings remain).
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: validated 91 entries.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable deliveries.
- `git diff --check`: passed.

The full test suite is left to PR-head CI as required by this remediation job.
