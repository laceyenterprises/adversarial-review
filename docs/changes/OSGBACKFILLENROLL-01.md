# OSGBACKFILLENROLL-01

## Summary

Historical finding and advisory projections retain evidence without automatic
remediation enrollment, including after late receipts or merges. Live capture
provenance remains intact. Automatic claims skip old/unknown source merge times;
explicit consensus-validated manifests retain selection authority.

## Interface changes

`persistReviewFindings` and `linkFindingRemediation` accept `historicalProjection`;
the explicit finding/body backfills and historical link CLI supply it. A genuine
live projection can activate matching historical observations, including at
verified merge capture. Findings and advisory
notes gain `historical_projection` (0/1, default 0). The companion capability
export allows activation callers to refuse older implementations.
`claimFindingBatches` accepts `now` and `maxAgeMs`; the runner forwards its clock
and configured age window. Backlog summaries add `outOfWindow` and exclude
expired unassigned findings from batchable metrics, preserving owned monitoring.

## Verification

All six test files ran individually under netguard through the bounded
worker-validation runner: 207 tests passed across historical enrollment (8),
body repair (19), projection (19), batches (101), manifests (18), and retries (42).
`npm run lint`: 0 errors, 149 existing warnings; final touched-source ESLint passes.
`npm run typecheck:contracts` and the research-finding byte-equivalence demo pass.
The full `npm test` invocation did not return within its requested 600-second
bound; the wrapper and its process group were stopped and no full-suite pass is
claimed. Final scoped suites passed after the last implementation change.

Initial targeted memory search was available with no matching records. A
follow-up search for the sibling historical body writer timed out; local
projection/backlog contracts and sibling call sites supplied the evidence.
