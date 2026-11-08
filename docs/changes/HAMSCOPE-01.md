# HAMSCOPE-01

## Summary

Check reversal-finding admissibility before hammer author-line edits. Defer
inadmissible advisory findings through the existing backlog with a one-line
reason, preserving author code and avoiding remediation that cannot merge.
Additive fixes remain allowed; blocking and effective strict-mode reversal paths
retain their existing requirements. See the [SEV2 report](../postmortems/SEV2-HAMSCOPE-01-inadmissible-advisory-repairs.md).

## Interface changes

`bin/hammer-edit-plan.mjs OWNER/REPO PR REVIEW_ID PLAN_JSON` reads the review and
effective policy, using the same `checkReversalFinding` implementation as the
primary-change gate. Exit 0 permits the planned edit; exit 20 confirms recorded
deferral and forbids editing; other failures stop editing. The plan format and
audit contract are documented in the closure runbook and hammer prompt.
`captureReadyFindings` accepts optional `deferredFinding` selection and reason;
existing backlog columns and lifecycle are reused without migration.
The hammer invokes the helper as the review-state database owner; the defer
branch checks ownership before opening SQLite and uses the canonical findings
count. Non-strict advisory author-line fixes are deferred, including in-place
edits that the final syntactic preservation check might otherwise permit.

## Verification

- Repaired the stale primary-change prompt assertion that failed both external
  Node lanes: it now verifies durable advisory deferral and the existing intent
  authority boundary instead of the superseded rationale-comment procedure.
- `bash bin/run-bounded.sh --timeout 240 -- node test/run-tests.mjs
  test/primary-change.test.mjs test/hamscope-01.test.mjs`: 90 passed after rebase.
  The initial 60-second bound expired; the completed run took 102 seconds.
- `npm run lint`: passed (0 errors; existing warnings).
- `npm run typecheck:contracts` and `git diff --check`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed offline with byte-stable
  transcript deliveries.
- Full-suite execution remains delegated to PR-head CI under the remediation
  worker's targeted-test-only constraint.
