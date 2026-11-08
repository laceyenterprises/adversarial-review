# REVIEWLARGE-01

Review prompt preparation now summarises base-declared generated paths and
verified pure moves/splits in a content-hashed manifest. Oversized remaining
code uses the existing complete-coverage chunk planner and verdict merger.
Posted reviews disclose the manifest and chunking.

Initial `reviewer-prompt-too-large` failures are eligible for existing bounded
infrastructure recovery. Exhausted summarisation/chunking uses terminal
`reviewer-chunk-budget-exceeded`, preserving the existing size handoff and reason.
No merge gate or review coverage requirement changes.

See [the operational contract](../../docs/review-large-diffs.md).
