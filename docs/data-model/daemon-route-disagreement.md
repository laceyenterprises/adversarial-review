# Data Model - Daemon Route Disagreements

**Owner:** AMA watcher and closer route arbitration
**Store:** `data/follow-up-jobs/daemon-route-disagreement/`
**Source of truth:** `src/daemon-route-disagreement.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose and files

The watcher records a disagreement when the daemon clean-merge attempt declines
on a tick but the AMA closer answers `daemon-clean-route` for the same PR. This
ledger counts those observations per PR head so a repeated refusal can route to
the capped hammer or enter automated recovery. It does not authorize a
merge; the daemon and closer still apply their normal eligibility gates.

One JSON file per `(repo, PR)` lives at
`data/follow-up-jobs/daemon-route-disagreement/<repo>-pr-<n>.json`. The repo
component replaces `/` with `__`, then replaces characters outside
`[A-Za-z0-9._-]` with `-`. The head SHA is stored in the file rather than in
its name. The writer replaces the file when a new head begins a series.

## Record (schema version 1)

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo` | string | Repository full name supplied by the watcher. |
| `prNumber` | number | Pull request number supplied by the watcher. |
| `headSha` | string | Non-empty head identifier for this series. Missing heads are not persisted. |
| `count` | number | Number of disagreements observed on this head. |
| `firstObservedAt` | string | Timestamp from the first observation on this head. |
| `lastObservedAt` | string | Timestamp from the latest observation. |
| `daemonDisposition` | string or null | Daemon disposition on the latest declined attempt. |
| `daemonReason` | string | Latest daemon reason, or `daemon-result-missing`. |
| `daemonReasons` | string[] | Latest daemon gate reasons, empty when absent. |

## Lifecycle

- Each same-head disagreement increments `count`, preserves `firstObservedAt`,
  and refreshes the latest daemon details and `lastObservedAt`. A different
  head starts at `1`. The first three observations are logged; the fourth
  escalates. The bound is `DAEMON_ROUTE_DISAGREEMENT_BOUND` in the source module.
- On a later tick with a hammer-remediable daemon decline, a count at the bound
  makes the closer dispatch through the existing capped hammer path. Other
  declines keep the diagnostic park record and enter
  [automated recovery](ama-automated-recovery.md) after the bound; the park is not
  itself a `needsOperator` hand-off or page. Recovery preserves safety/configuration
  holds, waits for active owners, and pages only after sustained non-progress.
  See `docs/RUNBOOK-ama-closure.md` for the gate list.
- A successful daemon clean merge removes the file. A missing file begins a new
  series. An unreadable file is logged and treated as a fresh series. Writes
  and removal are best-effort and do not interrupt route arbitration.

## Transient-read sidecar

A decline made only of transient GitHub reads (`pr-mergeability-unknown`,
`labels-unavailable`) never touches the count. Instead the watcher keeps
`<repo>-pr-<n>.transient.json` beside the main file, with the same name
sanitizing. It has `schemaVersion` (`1`), `repo`, `prNumber`, `headSha`,
`firstObservedAt` (reset when the head changes), `lastObservedAt`, and
`stuckReportedAt` (null until reported).

When transient declines on one head span more than
`MERGEABILITY_UNKNOWN_STUCK_MS` (30 minutes), the watcher logs one
`ama.mergeability_unknown_stuck` event and sets `stuckReportedAt`, so each head
reports at most once. The sidecar never counts, parks, or pages. A transient
decline reports the caller's head and a count of `0` when the main file holds
another head's series. A successful daemon clean merge removes both files.
