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
expired never-claimed findings from batchable metrics, preserving owned monitoring.
Released automatic findings remain batchable regardless of source age until
settlement or third-attempt exhaustion. Health alerts on `outOfWindow > 0` as
well as overdue batchable work, and uses the health-configured window. Invalid
direct summary defaults return unavailable evidence. Shared batch fixtures pass
explicit clocks instead of mocking `Date.now` for whole files. Summaries retain
pre-requeue-schema compatibility with unavailable retry progress.

## Verification

All six test files ran individually under netguard through the bounded
worker-validation runner: 207 tests passed across historical enrollment (8),
body repair (19), projection (19), batches (101), manifests (18), and retries (42).
`npm run lint`: 0 errors, 149 existing warnings; final touched-source ESLint passes.
`npm run typecheck:contracts` and the research-finding byte-equivalence demo pass.
The full `npm test` invocation did not return within its requested 600-second
bound; the wrapper and its process group were stopped and no full-suite pass is
claimed. Final scoped suites passed after the last implementation change.

After rebasing onto OSGPROJECTLOCK-01, the read-count pin accounts for the new
migration's sentinel reads separately, keeping the non-migration budget at 114.
The open-PR deferral fixture records `merged_at` at merge, as merge writers do,
because unknown merge times are outside the automatic window. Scoped suites
pass on Node 22 and 26. The full `npm test` completed in about 16 minutes with
three failures in untouched hammer and remediation suites. One also fails on
`origin/main`; another passes in isolation on both trees.

Initial targeted memory search was available with no matching records. A
follow-up search for the sibling historical body writer timed out; local
projection/backlog contracts and sibling call sites supplied the evidence.

Operator steering adds a hard stop on all review-store backfills and projections
until both this fix and OSGPROJECTLOCK-01 merge and float in both repositories.
The operator declaration and canonical store instructions carry that prerequisite.
The companion incident report is classified SEV0; implementation is unchanged.

Final fix-all remediation: targeted batch, graded-selection, retry, historical
enrollment and hammer-scope suites passed (184 tests across five files). The
existing publication latency and state/smoke suites passed (44 tests). Lint
reported zero errors and 149 existing warnings; contract typecheck, the offline
research demo, 94-entry data-model catalog validation and diff whitespace check
passed. No full local suite or live review-store operation was run.
