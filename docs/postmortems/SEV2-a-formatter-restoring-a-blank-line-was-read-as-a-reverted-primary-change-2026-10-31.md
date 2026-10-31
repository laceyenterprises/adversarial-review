# SEV2 — a formatter restoring a blank line was read as a reverted primary change

Date: 2026-10-31. Ticket: BLANKLINEREVERT-01. Severity: SEV2, merge availability.
Status: source correction and offline regression coverage. The fix takes effect
with the normal review-service deploy. Live recovery is the stranded PR's next
closer pass reading eligible.

scars: merge.finding-remediation-and-authoritative-terminal

The primary-change check is the part of that contract that keeps a repair
from undoing the author's change. Here it refused merge although nothing was
undone. No unsafe merge happened. The failure was a clean PR that could not land.

## Impact

A hammer closed a PR with zero blocking and zero non-blocking findings,
green exact-head CI and green targeted tests. `merge-eligibility` still
returned `eligible: false` with `primary-change-reverted`, routed as
`stale-review-head`. The missing evidence was "no verified
Reversal-Authorized-By covers the reverted <file> region (0 verified)". No
finding could supply that authorization, because there was no finding to cite,
so the PR stayed stranded.

## What happened (generic)

1. In one hunk, the author's change removed a blank line and changed an
   adjacent content line. That made it a mixed region.
2. The formatting guard ran the formatter, which put the blank line back. The
   content change was kept unchanged.
3. The primary-change check compared that final head with the protected author
   head. It saw the base line where the blank had been come back and
   counted that as a reverted author unit.
4. Removing the blank again to satisfy the check would fail the formatting
   guard. The two checks deadlocked.

## Root cause

`preservationChanges()` in `src/ama/primary-change.mjs` splits each author
region into one unit per base line. It already ignored layout in three cases:
regions that change only whitespace, replacements that differ only in trailing
whitespace, and blank removals in a region whose added lines were all blank.
In a mixed region it kept the blank line's unit on purpose. The concern was
that added content "may belong to any removed line", so dropping the blank's
unit might stop protecting content that replaced it.

That concern was valid only for regions whose removed lines are all blank.
When the region also removes content, the content units already carry its
protection, and the blank's unit protects nothing but layout. Keeping that unit
made "the formatter restored a blank line" look exactly like "the hammer
reverted the author's change".

## Correction

- In the protected author diff, a removed line that is blank or whitespace-only
  is never a preservation unit, whatever else its region contains. These units
  are counted in the existing `whitespaceOnlyUnitsIgnored` evidence.
- Content removals in the same region keep their units and their
  removed-text multiset checks, exactly as before. A reverted content line
  still yields `primary-change-reverted`.
- A region that removes only blank lines but adds content keeps protecting
  that content as one insertion unit over the blank span. A final head that
  inserts at either edge of the span, or anywhere inside it, still covers that
  content. This applies when a formatter restores the blank before or after it.
  A final head that returns the region to base, or only changes some other
  line, still refuses.
- The final (closer) diff is unchanged. Its blank-line units only add coverage,
  so this fix adds no new refusals.
- Reversal authorization, rebase proofs and the unit coordinates they use are
  unchanged.

## Regression evidence

Synthetic fixtures in `test/primary-change.test.mjs` (BLANKLINEREVERT-01):

- a mixed region where the author removes a blank and changes content, and the
  final head re-adds the blank, passes and is merge-eligible, with
  `whitespaceOnlyUnitsIgnored: 1`;
- the same region still refuses with `primary-change-reverted` when the
  content line is reverted, whether the blank is also restored, stays removed,
  or an unrelated line elsewhere changes;
- content that replaced a blank survives a blank restored before or after it,
  or a pure re-insertion, and still refuses when it is reverted.

All three fail on the previous code. The existing REVERSALBLANK-01
whitespace-only and trailing-only cases are unchanged. The primary-change and
merge-eligibility suites pass.

## Follow-up

None in source. Live receipt (SRE): after the normal deploy, the stranded PR's
next closer pass reports eligible.
