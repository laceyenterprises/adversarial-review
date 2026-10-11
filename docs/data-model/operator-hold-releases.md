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
| `stage` | TEXT, nullable | Classifier stage: `first-review`, `rereview`, `blocking-findings`, `clean-review`, `code-work`, `closeout`, `cycle-cap`, or `pr-terminal`. Null until routed. |
| `action` | TEXT, nullable | Existing handler selected: `review`, `remediation`, `daemon-clean-merge`, `hammer`, or `none` for a terminal PR. |
| `routed_at` | TEXT, nullable | Timestamp when routing was armed; not proof of execution or merge. |
| `cancelled_at` | TEXT, nullable | Timestamp when a later observed hold invalidated this intent, including previously routed releases. |

`idx_operator_hold_releases_pr` indexes `(repo, pr_number, id DESC)`.
There is no TTL or pruning; rows are retained for audit. Schema creation is
idempotent and currently occurs from `observeHoldRelease`.

## Routing and recovery

The watcher observes release before ordinary per-PR early returns. The newest
unrouted, non-cancelled intent for the PR is retried across ticks and restarts;
this lookup is not restricted to its original head. Before arming a route, a
live `gh pr view` checks state, head and holds. Re-applying any hold cancels
existing intents. A live CLOSED or MERGED PR routes to `pr-terminal`/`none`.
If the head moved or labels are unknown, routing waits for a later observation.

Classification uses settled verdict, live checks/mergeability, remediation
round budget and cycle-cap evidence. Missing or uncaptured completed review
bodies on a remediation route fall back to a current-head re-review. All
routing exceptions log a warning and fall through to ordinary handlers,
without the release-driven reviewer fence for that tick; they cannot wedge
whole-PR processing. Unrouted intent remains durable for another tick.
Routing grants no merge authority and no additional remediation rounds.

Review routes retain label freshness checks before claim and spawn. The
current pending/failed fallback lookup can retain a historical release ID on
the same head, including a cancelled row; these claims remain fenced and defer
on unreadable live labels. This store does not yet clear that association when
a review posts. Mirror writers also observe releases before refreshing labels.

The closer uses the latest non-cancelled exact-head release to unlock a hammer
stop (including routed intents); see [Hammer Stop Hold](hammer-stop-hold.md).
Refunds require separate proven non-execution evidence; current hammer audit
producers do not provide it, as documented in [Hammer Retry Cap](hammer-retry-cap.md).
