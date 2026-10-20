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
the patch-shaped proof. Insertion-only regions also entered reversal checks,
although they contained no removed lines to authorize.

## Repair

The guard matches protected removed content as a multiset, preserving duplicate
counts. It binds original and rebased commit content without surrounding
context, line offsets, ordering or hunk boundaries. Finding coverage still uses
the cited review's coordinates. The authorizing commit must actually remove
the protected introduced content; coordinate overlap alone cannot waive it,
and one removed occurrence cannot cover multiple protected occurrences.
Cited restoration of a primary deletion retains its existing authorization,
using the content added back by the authorizing commit.
Regions with empty removed sets do not request authorization or appear in
reversal diagnostics. Whole-file absence, opaque assets and rename preservation
retain their existing protections.

Hammer provenance, authoritative reviews, effective non-blocking policy,
citation freshness, closure ancestry and superseded-review proofs remain
required. Unauthorized or partially covered removals retain the existing
`primary-change-reverted` refusal and diagnostic messages. The history cache
identity advances to `reversalprov-v2` so unchanged heads recompute old proofs
and refusals once. No manual cache mutation is required.

## Validation and deployment acceptance

Offline synthetic regressions cover context and coordinate shifts, reordered
removed lines, changed hunk boundaries, a cited non-blocking cleanup, missing
citations, unrelated or partially covered removed content, duplicate-line
multiplicity, an uncited remainder and empty removed sets. Existing provenance,
review freshness, rename and opaque-file regressions remain in the focused suite.
The 191-test focused run passed, including the shared hammer/daemon policy
fixtures. Lint completed with zero errors; contract typechecking and the offline
byte-equivalence demo passed. The full offline suite passed with 11,207
passing tests, six skips and zero failures.

After deployment, observe the next naturally occurring hammer cleanup of cited
primary-change content after a context-only rebase. Its citation should remain
accepted and closure should merge once all existing independent predicates pass,
without a `primary-change-reverted` stop. Host acceptance remains to be observed.
This change adds no CI job, gate, label or config key and performs no live-state
repair or action on other PRs.
