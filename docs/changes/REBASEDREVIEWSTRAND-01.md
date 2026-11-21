# REBASEDREVIEWSTRAND-01 — Admit a re-review for a PR rebased in place after a parked failure

## Summary

A PR whose review failed and parked, and which was then rebased in place,
never received a review of the new head. Operator exact-head retriggers did not
help. The durable re-review refill read the row's recorded head, saw a different
live head, returned `durable-refill-subject-changed` and dropped the request.
That settled the row, so the refill never offered it again while it stayed
`pending`. The wait-decision log only fires under wait pressure, so later
passes were silent.

Phase 0 on a synthetic row (pending at head A, live head B): the first pass
returns `durable-refill-subject-changed`; passes two and three offer no
candidate; the row stays `pending` on its old head. The gate is the head test in
`createDurableReviewerCandidate().run` together with the settle rule in
`createDurableReviewerRefill().onSettled`.

Closure-park custody (`recoverOverdueOwnership`), next-action deadlines and
orphan-recovery state are keyed by head, so state recorded for A is already
inert for B. The in-place repair reservation fence is a separate single-writer
guard that deliberately stays in force; it is not relaxed here.

## Interface changes

- `createDurableReviewerCandidate` accepts `rebindHead`. When the live subject
  is open, unheld and on a different head, the pending row is rebound to the
  live head by compare-and-swap (`createDurableHeadRebinder`) and the candidate
  continues on that head. The request time, reason and budgets are unchanged.
  The CAS also matches the captured `rereview_requested_at`, including null;
  a replaced request refuses the stale candidate without changing its revision.
  Settlement preserves refill eligibility for that newer request at the same
  revision.
  The supersession is logged as `REBASEDREVIEWSTRAND-01: superseded durable re-review`.
- A pending re-review refused before admission logs `review-wait-decision` with
  its filtering reason on every drain, not only under wait pressure.
- A pending head held by the repair reservation fence logs
  `review-wait-decision … decision=repair-reservation-owns-pr`.

No persistent fields change. Refreshed the `pollonce-phases` state-source
projection after confirming that its only addition is the repair-reservation
logging guard; state writers, lifecycle transitions and smoke promises are unchanged.

## Verification

- `node --test --test-concurrency=2 test/rebasedreviewstrand-01.test.mjs`
  (new): rebase after a parked failure is admitted, startup admission and
  settlement precede an admitted exact-head retrigger (including an abbreviated head),
  replacement requests during a paused live-head read refuse the stale candidate
  and admit the new request (with null and non-null original timestamps);
  an unchanged null-timestamp request can also rebind,
  terminal or held subjects are not rebound, a racing claim is not rebound,
  custody at the old head is inert for the new head, an unrelated PR keeps its
  custody, the filtered reason is logged.
- Touched suites: `watcher-reviewer-refill`, `watcher-reviewer-dispatch`,
  `closerparkowner-01`, `review-queue-depth-failover`, `inplacerepair-01`,
  `watcher-claim-loop` all pass.
- `npm run lint`, `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` pass.
- Focused SMV graph, source-projection, mutation and declaration checks pass.
