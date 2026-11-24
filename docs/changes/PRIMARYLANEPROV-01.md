# PRIMARYLANEPROV-01

## Summary

The primary-change gate now checks a closer's citation against the content
span of a pure insertion on the reviewed ancestor. Git can include adjacent
blank lines in that insertion even when the finding precisely cites the
content to remove. The gate still checks the full protected insertion against
the closer's patch and requires coverage for every nonblank line.

Read-only replay of agent-os PRs 11523 and 11497 isolated separate refusals.
The first reached finding coverage on the closer commit. Lane-provenance
diagnostics belonged to an earlier candidate with its own trailers. The
second retained a historical uncited reversal and lacked exact paths in the
doc-currency claim. Coverage, commit provenance and doc-currency are evaluated
separately.

## Interface changes

None. Use the existing `Reviewed-Head` and `Reversal-Authorized-By` trailers.

## Verification

Synthetic regressions exercise both merge predicates on a reviewed lane
head, including an authorized removal, uncovered lines and paths, missing
citations, unknown reviewers and a review outside the closer's ancestry.
An eligibility regression verifies that omitted documentation paths fail
doc-currency evidence and that only a passing preservation check can enable
terminal remediation.

- `npm test -- lanereversal-01.test.mjs ama-eligibility.test.mjs` passed all
  209 tests.
- The affected-surface run covered 121 files with 4,810 passes and four
  environment or opt-in skips. Full `npm test` reported 22,194 passes,
  13 skips and five failures in `remlabel-publication.test.mjs`. The same
  five failures reproduced on `origin/main` under the offline test guard.
- `npm run lint` reported zero errors and 147 warnings.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` produced three byte-stable
  deliveries.
