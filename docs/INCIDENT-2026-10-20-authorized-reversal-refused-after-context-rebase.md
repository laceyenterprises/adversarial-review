# REVERSALPROV-02: authorized cleanup refused after a context-only rebase

## Incident and impact

On 2026-10-20, a hammer remediated eight non-blocking findings on a consumer
PR refreshing a generated JSON baseline of roughly 7,000 lines. One commit
removed ten stale entries for finding 4 and carried a
`Reversal-Authorized-By` trailer identifying that non-blocking finding.
After a pipeline rebase, the primary-change guard refused closure despite
seven passing checks and a mergeable head. The hammer stopped and requested
restoration of supposedly uncited regions, leaving the PR without an owner.
This report retains only generic evidence; all regression diffs are synthetic.

The authorization diagnostic reported zero accepted citations and rejected
finding 4 with `rebased protected region patch differs or is ambiguous`.
The flagged regions had `removedLines: []`. The refusal also surfaced
`non-blocking-findings-present`, `stale-review-head` and
`verdict-not-settled-success`; green CI did not clear the preservation refusal.

## Cause

PR 1383 (REVERSALPROV-01) preserved proven hammer identity across pipeline
rebases. Authorization still depended on exact protected patch segments and
a reviewed-parent comparison that retained context and hunk layout. A rebase
could therefore preserve the removed content and its citation yet invalidate
the patch-shaped proof. Insertion-only regions require reversal checks against their introduced content,
even though their base-coordinate removed sets are empty.

## Repair

The guard matches protected removed and added content as multisets, preserving
duplicate counts and distinguishing replacements with identical base deletions.
The reviewed-parent comparison ignores context, offsets, ordering and hunk
boundaries. Original-commit provenance retains ordered edits, hunk/context-run
boundaries and newline-marker attachment while allowing context text/counts and
hunk offsets to drift. Finding coverage still uses the cited review's coordinates.
The authorizing commit must overlap the projected region in its own parent's
coordinates and remove the remaining parent-state content there. Identical text
elsewhere cannot waive the region. Deriving this content from the parent permits
earlier in-place repairs and insertion deletions split across cited commits.
Cited restoration of a primary deletion uses the content added back by the
authorizing commit, including in mixed replacement hunks. Insertion-only regions
remain protected: their reversal requires full finding coverage of the introduced
span and matching HAM removals with multiplicity. Uncited insertion removals
appear in reversal diagnostics; in-place region repairs remain allowed. Whole-file absence, opaque assets and rename preservation
retain their existing protections.

Hammer provenance, authoritative reviews, effective non-blocking policy,
citation freshness, closure ancestry and superseded-review proofs remain
required. Unauthorized or partially covered removals retain the existing
`primary-change-reverted` refusal and diagnostic messages. The history cache
identity advances to `reversalprov-v3` so unchanged heads recompute old proofs
and refusals once. No manual cache mutation is required.

## Validation and deployment acceptance

Offline synthetic regressions cover context and coordinate shifts, reordered
removed lines, changed hunk boundaries, a cited non-blocking cleanup, missing
citations, unrelated or partially covered removed content, duplicate-line
multiplicity, an uncited remainder and insertion-only reversal authorization. Existing provenance,
review freshness, rename and opaque-file regressions remain in the focused suite.
The initial 191-test focused run passed, including the shared hammer/daemon policy
fixtures. Lint completed with zero errors; contract typechecking and the offline
byte-equivalence demo passed. The full offline suite passed with 11,207
passing tests, six skips and zero failures.

Remediation regressions additionally cover insertion reversals with and without
a final file diff, rebased and first-line insertions, full citation spans, duplicate
inserted content, mixed replacement restorations and distinct replacement hunks.
The follow-up 205-test focused run also covers two-commit repair-then-delete and
split-deletion histories, refusal of duplicate content at another location, and
original-proof order/marker attachment. Full-span coverage is cached before
repeated base-unit scans, avoiding quadratic multiset checks.

After deployment, observe the next naturally occurring hammer cleanup of cited
primary-change content after a context-only rebase. Its citation should remain
accepted and closure should merge once all existing independent predicates pass,
without a `primary-change-reverted` stop. Host acceptance remains to be observed.
This change adds no CI job, gate, label or config key and performs no live-state
repair or action on other PRs.
