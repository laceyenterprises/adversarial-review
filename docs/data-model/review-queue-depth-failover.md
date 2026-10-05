# Review queue-depth failover report

**Source of truth:** `src/review-queue-depth.mjs`, `bin/review-queue-depth.mjs`,
and the report record at `data/review-queue-depth-failover.json`.

The canonical catalog entry is `review-queue-depth-failover` in
`docs/data-model/catalog.json`. The JSON report has `schemaVersion: 1`,
`depthUnit`, top-level compatibility summary fields, and a `lanes` object with
one entry for each reviewer lane:

- `lanes["first-pass"]`
- `lanes.rereview`

Each lane records its own `passKind`, CFG `knob`, `armed` / `engaged` state,
`depth`, `threshold`, `spillSlots`, `engagedSince`, `engagedAtDepth`,
`updatedAt`, `lastTransition`, bounded `transitions`, and `cost`.

Lane `cost` contains lifetime `spilloverReviewsTotal`, `byWorkerClass`, the
current engagement's spillover count, and the last completed engagement's
spillover count. Engagement transitions are compared against the lane's previous
state only, so first-pass and re-review can disagree without resetting each
other's cost ledger or appending alternating engage/disengage events.

The top-level `armed`, `engaged`, `updatedAt`, `lastTransition`, `transitions`,
`engagementSpilloverReviews`, and `cost` fields are derived summaries across the
lane records. Top-level `engagementSpilloverReviews` is the live net count of
depth-spill admissions minus refunds across the lanes
(`cost.currentEngagementSpilloverReviews`). The identically named field in
`transitions[]` is a historical snapshot at that transition; refunds update
the live count but do not rewrite transition snapshots. Top-level
`depth`, `threshold`, and `spillSlots` remain the first-pass values for
compatibility with older operator tooling. Older reports without `lanes` are
loaded as a first-pass lane report and rewritten in the lane shape on the next
persisted transition or spill.
