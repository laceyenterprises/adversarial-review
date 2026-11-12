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
notes gain `historical_projection` (0/1, default 0).
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

The final review's advisory fixes add bounded operator expiry disposition
(`review-findings retire-expired`, read-only preview by default, `--apply` to
retain an `out-of-window:` reason and terminal timestamp). Owned, retried and
selected work is excluded. Backlog areas exclude unassigned historical/expired
advice and expose `notesHistorical` and `notesOutOfWindow` separately. Explicit
live enrollment now covers only actual historical-to-live promotions. Direct
automatic claims read the caller's `env`; manifest claims ignore the unused
window/clock. The canonical store doc records that old incident rows keep their
live-default marker and rely on the age window.

The earlier local full-suite failures are superseded by the reviewed head's
[green Node 22 and Node 26 full-suite CI run](https://github.com/laceyenterprises/adversarial-review/actions/runs/43169358963)
at `59ca2bcd63c5ca7f2dc38649459b5eb12f421025`; no inference that all three
failures also occurred on main is needed. The current base also has a
[green full-suite run](https://github.com/laceyenterprises/adversarial-review/actions/runs/43166501772)
at `6a64b9f3a9055f10d4be67ad17820ca345ebf83a`.

Advisory remediation validation: 214 targeted batch, grade, retry, contention,
state/smoke and closure-latency tests passed; after correcting two fixture
expectations, the 34 projection/CLI and historical-enrollment tests passed.
Lint has zero errors (149 existing warnings); contract typecheck, the offline
research demo, 94-entry catalog validation and whitespace checks passed.
The initial workspace lacked dependencies; locked `npm ci` restored them.
No full local suite or live store maintenance was run in this round.
The watcher claim-loop guard passed all 168 tests in 219 seconds under the
360-second bound (the initial 120-second bound expired after 89 passing cases).
The full PR diff also passes whitespace validation after removing a trailing
blank line from the historical-projection migration.

HAM final-review remediation clarifies that failed live projection backfill
recovers evidence without automatic enrollment. Deployment receipts must record
the standing expired-source alert baseline. Summaries probe historical-note
provenance for compatibility with unmigrated stores; canonical source lists
include the migration and window module. The unused capability export is removed.
Validation: canonical changed-surface runner passed 276 tests in 13 files,
including the unmigrated-note regression and projection warning assertions.
Lint passed with zero errors (149 existing warnings); contract typecheck,
offline research walkthrough, 94-entry data-model catalog and whitespace checks
passed. Full-suite validation remains with exact-head remote CI.
