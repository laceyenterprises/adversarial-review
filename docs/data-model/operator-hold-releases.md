# Data Model - Operator Hold Releases

**Owner:** watcher operator-hold release routing
**Store:** `data/reviews.db`, table `operator_hold_releases`
**Source of truth:** `src/operator-hold-release.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/review-state.mjs`, `src/ama/hammer-stop-hold.mjs`

## Purpose and schema

HOLDRELEASE-01 persists removal of the last operator hold with the
`reviewed_prs.labels_json` snapshot in one IMMEDIATE transaction. Holds are
`do-not-merge`, `no-merge-hold` and `merge-agent-skip` (see
`src/operator-hold-labels.mjs`). Partial removal does not release. Invalid or
missing label snapshots cannot manufacture a release.

| Column | SQLite type | Contract |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Durable release identity. |
| `repo` | TEXT NOT NULL | Repository full name. |
| `pr_number` | INTEGER NOT NULL | PR number. |
| `head_sha` | TEXT NOT NULL | Live head observed when the final hold disappears. |
| `released_at` | TEXT NOT NULL | ISO timestamp of release observation. |
| `removed_json` | TEXT NOT NULL | JSON array of sorted, unique hold labels removed from the preceding snapshot. |
| `stage` | TEXT, nullable | Classifier stage: `first-review`, `rereview`, `blocking-findings`, `clean-review`, `code-work`, `closeout`, `cycle-cap`, `review-failed`, or `pr-terminal`. Null until routed. |
| `action` | TEXT, nullable | Existing handler selected: `review`, `remediation`, `daemon-clean-merge`, `hammer`, or `none` for a terminal PR or same-head failed review. |
| `routed_at` | TEXT, nullable | Timestamp when routing was armed; not proof of execution or merge. |
| `cancelled_at` | TEXT, nullable | Timestamp when a later observed hold invalidated this intent, including previously routed releases. |

`idx_operator_hold_releases_pr` indexes `(repo, pr_number, id DESC)`.
There is no TTL or pruning; rows are retained for audit. Schema creation is
idempotent and currently occurs from `observeHoldRelease`.

## Routing and recovery

The watcher observes release before ordinary per-PR early returns. Stale-drift
subjects retain unrouted intent until stale-drift clears. Observation failures
preserve the held label snapshot by suppressing ordinary label refreshes. Schema
creation is cached per connection; unchanged hold state avoids a write transaction. The newest
unrouted, non-cancelled intent for the PR is retried across ticks and restarts;
this lookup is not restricted to its original head. Before arming a route, a
live `gh pr view` checks state, head and holds. Re-applying any hold cancels
existing intents. A live CLOSED or MERGED PR routes to `pr-terminal`/`none`.
If the head moved, labels are unknown or a hold was re-applied, the subject
returns for that tick before gate projection and ordinary handlers. A live
terminal PR also returns after settling the intent. These race fences defer
ordinary processing until the next tick; routing exceptions instead fall through.

Classification uses settled verdict, live checks/mergeability, remediation
round budget and cycle-cap evidence. Missing or uncaptured completed review
bodies on a remediation route fall back to a current-head re-review. All
routing exceptions log a warning and fall through to ordinary handlers,
without the release-driven reviewer fence for that tick; they cannot wedge
whole-PR processing. Unrouted intent remains durable for another tick.
Routing grants no merge authority and no additional remediation rounds.
An active remediation job routes to `blocking-findings`/`remediation` and remains
the owner: release does not enqueue another job or reset the posted row.
Same-head terminal review failures route to `review-failed`/`none`, retaining
`failed_at`, failure text, head and all counters. The ordinary retry/park gates
still decide whether recovery is permitted, including bounded infrastructure
recovery; removing a hold is not an operator retrigger.
Held verdicts with standing blockers still accrue the ordinary cycle-cap count;
hold toggles do not hide real review/remediation cycles from the breaker.

Review routes retain label freshness checks before claim and spawn. The
current pending/failed fallback lookup retains only unrouted releases or releases
routed after the last reviewer attempt on the same head; these claims remain fenced and defer on unreadable
live labels. When the post-claim freshness read fails or observes a re-applied
hold, the unexecuted claim restores every claim/routing-mutated column from a
snapshot read in the same IMMEDIATE transaction as the claim CAS. A single
UPDATE requires the
row to remain `reviewing` under that exact session UUID; it restores the prior
status, failure evidence, quota/attempt timestamps, revision, all three retry
counters and population retry metadata, lease/process evidence and reviewer
routing attribution. It leaves live label observations and release cancellation
intact. The next tick must still pass the original bounded retry/park gates;
Rollback releases the in-process head dispatch lease, and triage sync runs only
after the freshness fence. Rollback never converts a failed or upstream-held row into plain `pending`.
Cancelled intents are excluded, so a re-applied hold does not
prevent ordinary held reviews through old release history. This store does not
clear historical release rows; attempt timestamps bound their claim association. The watcher and
ordinary label mirror writers observe releases before refreshing labels.
`recoverFastMergeVetoes` in `src/fast-merge-audit-recovery.mjs` is an exception:
its `fast_merge_skipped` label refresh writes directly and can lose a release
edge before the watcher's observation.

The closer uses the latest non-cancelled exact-head release to unlock a hammer
stop (including routed intents); see [Hammer Stop Hold](hammer-stop-hold.md).
Refunds require separate proven non-execution evidence; current hammer audit
producers do not provide it, as documented in [Hammer Retry Cap](hammer-retry-cap.md).

## Awaited approval labels

APPROVALREARM-01 handles addition of an approval explicitly awaited by a
recorded closer refusal through `operator-approval-applied` in the hammer stop
hold and a once-per-head retry-ledger allowance. This event does not write an
`operator_hold_releases` row. Removing an unrelated label or toggling a hold
still follows the existing rules above. See the
[approval re-arm contract](hammer-retry-cap.md#operator-approval-re-arm-approvalrearm-01).
