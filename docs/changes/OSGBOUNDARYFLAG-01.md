# OSGBOUNDARYFLAG-01

## Summary

`src/review-finding-records.mjs` exports `HISTORICAL_PROJECTION_SUPPORTED = true`
again. The companion explicit OSG finding backfill reads this flag and refuses to
run unless it is `true`. OSGBACKFILLENROLL-01 shipped the behaviour the flag
declares, but its final-review remediation removed the export as unused, because
nothing in this repository read it. The backfill therefore refused before making
any write, even with both halves deployed.

## Interface changes

New export `HISTORICAL_PROJECTION_SUPPORTED` (`true`). It asserts that
`backfillReviewFindings` persists `historical_projection=1` and that the
`finding_backlog_candidates` view excludes those rows. No behaviour changes.

## Verification

`test/osgboundaryflag-01.test.mjs` tests the flag together with the behaviour it
declares, using synthetic fixtures. It checks that the export exists and is
`true`. On a merged PR, a backfilled finding is stored as historical and is
neither a backlog candidate nor enrolled by the late-capture trigger. A finding
captured live on a merged PR still enrolls. The flag test fails against the
base source and passes with this change.
