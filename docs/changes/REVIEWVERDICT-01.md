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

Final remediation normalizes numeric and string PR numbers to the same durable
reservation key. Pipeline stage blocking metadata uses `parseReviewFindings`
so contradictory reviews report unknown blocking state as well as request-changes.

## Interface changes

`parseReviewFindings` adds `verdict_inconsistent: true` for contradictory reviews
and marks their blocking state unknown. Capture records the fact in reviewer-pass
metadata. `normalizeEffectiveReviewVerdict` returns request-changes for these
reviews, including the former empty-list request-changes downgrade.

The [recovery store](../data-model/reviewer-verdict-recovery.md) consumes one
durable same-head reservation before reconciliation, including on retry failure.
No CI workflow or merge override changes.

The recovery receipt stores a numeric `prNumber`; head normalization is unchanged.
Lifecycle states, transitions and deployed smoke promises are unchanged.

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

Final remediation validation on the freshly rebased branch:

- `node --import ./test/helpers/load-aware-timeout-fixture.mjs --test test/reviewer-verdict-recovery.test.mjs test/watcher-review-pipeline.test.mjs`: 18 recovery and 12 pipeline tests pass, including mixed PR-number types and unknown blocking metadata.
- `node --import ./test/helpers/load-aware-timeout-fixture.mjs --test test/watcher-claim-loop.test.mjs`: all 160 tests pass under a 180-second bound.
- `npm run lint`: zero errors (153 existing warnings).
- `npm run typecheck:contracts`: passes.
- `node scripts/validate-data-model-catalog.mjs`: validates all 91 entries.
- `bash demo/research-finding-walkthrough.sh`: byte-stable offline demo passes.
- `git diff --check`: passes.

Tests, lint, typechecking and the demo use `bin/run-bounded.sh`. No full local
suite was run; PR-head CI retains that merge gate.
