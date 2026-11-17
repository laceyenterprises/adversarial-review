# REVERSALRENAME-01 — a cited rename or deletion of an added file is authorized like an in-place reversal

## Summary

A builder commit added a file. A review at that head carried a non-blocking
finding on it asking for a rename. A verified hammer commit performed the rename
and carried a valid `Reversal-Authorized-By` trailer for that finding. The
primary-change gate still refused the head with `primary-change-reverted` and
`accepted: 0, rejected: []`: the citation was never evaluated.

Three defects combined:

1. `evaluatePrimaryChange` only ran `reversalAuthorized` for a path missing from
   the final diff when the primary file was not `added`. An added file that is
   renamed or deleted is missing from the base-to-head diff, so it was refused
   with no evaluation at all. An in-place edit of the same file passed.
2. A `renamed` commit file lists only the edited lines. The removal-coverage
   proof therefore saw a partial removal even though the old path no longer
   holds any content.
3. The refusal's diagnostic pass recorded its rejections in a cache that
   `missingReversalEvidence` never read, so an evaluated citation could still
   print as "0 rejected".

## Behavior

- A cited rename or deletion of an added file is authorized by the same checks as
  an in-place reversal: verified hammer commit, HAM/AMA worker ticket, matching
  `Reviewed-Head`, authoritative reviewer, and a finding that names the file and
  covers the region. An uncited rename or deletion still fails closed, as do a
  citation to a finding on another file, a non-authoritative reviewer, a
  mismatched `Reviewed-Head`, a non-hammer author and a rename into a test path.
- A rename counts as removing the old path only for an added primary file whose
  parent state still holds it.
- `missingEvidence.rejected` now lists every citation the collector kept: an
  evaluator or diagnostic rejection when one exists, otherwise
  `not-applied-to-reverted-region`. Early evaluator refusals (provenance,
  reviewer authority, worker ticket, `Reviewed-Head`) are recorded with a reason
  instead of returning silently.
- A trailer-less hammer commit on top of the citing commit does not void the
  citation: the collector's closure is every commit after the primary head.

## Verification

`test/reversalrename-01.test.mjs` builds a synthetic history (builder adds
`a/x.yaml`, review finding on it, hammer rename / split rename / deletion /
in-place edit, optionally under a later hammer commit). It reproduced the
refusal before the change. The existing primary-change, reversal-rebase and
lane-reversal suites pass; `npm run lint` and `npm run typecheck:contracts` are clean.
