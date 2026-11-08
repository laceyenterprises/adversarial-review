# REVIEWVERDICT-01

## Summary

Contradictory Blocking issues and Verdict sections now fail closed. An empty
blocking list cannot turn verdict prose naming blocking defects into a
Comment-only review. Reverse contradictions also remain blocking.

The hosted reviewer reserves one reconciliation per PR head before retrying.
Persistent contradictions remain blocking and carry an operator notice.
Chunk aggregation preserves contradictory evidence; pipeline stages use the
effective verdict. Shared reviewer guidance requires every blocking defect
named in Verdict to appear under Blocking issues.

## Interface changes

`parseReviewFindings` adds `verdict_inconsistent: true` for contradictory reviews
and marks their blocking state unknown. Capture records the fact in reviewer-pass
metadata. `normalizeEffectiveReviewVerdict` returns request-changes for these
reviews, including the former empty-list request-changes downgrade.

The [recovery store](../data-model/reviewer-verdict-recovery.md) consumes one
durable same-head reservation before reconciliation, including on retry failure.
No CI workflow or merge override changes.

## Verification

Scoped offline tests run individually with `node --test <file>` through the
worker validation wrapper, with a 600-second bound and netguard:

- `test/kernel-parsers.test.mjs`
- `test/review-body-capture.test.mjs`
- `test/review-reply-validation.test.mjs`
- `test/reviewer-exact-head-post.test.mjs`
- `test/reviewer-spawn-settle.test.mjs`
- `test/reviewer-verdict-recovery.test.mjs`
- `test/reviewer.test.mjs`
- `test/watcher-claim-loop.test.mjs`
- `test/watcher-review-pipeline.test.mjs`

All listed files pass. The new recovery suite has 16 passing cases. Reviewer
tests explicitly load the standard synthetic timeout fixture so individual
runs have the same isolation as the repository runner. The watcher claim-loop
suite passes all 160 cases, including the duplicate-dispatch regression.

`npm run lint` passes with zero errors; `npm run typecheck:contracts` passes.
