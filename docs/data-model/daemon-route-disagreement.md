# Data Model - Daemon Route Disagreements

**Owner:** AMA watcher and closer route arbitration
**Store:** `data/follow-up-jobs/daemon-route-disagreement/`
**Source of truth:** `src/daemon-route-disagreement.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose and files

The watcher records a disagreement when the daemon clean-merge attempt declines
on a tick but the AMA closer answers `daemon-clean-route` for the same PR. This
ledger counts those observations per PR head so a repeated refusal can route to
the capped hammer or surface an operator-visible park. It does not authorize a
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
  declines produce an operator-visible park after the bound; the daemon still
  retries on later ticks. See `docs/RUNBOOK-ama-closure.md` for the gate list.
- A successful daemon clean merge removes the file. A missing file begins a new
  series. An unreadable file is logged and treated as a fresh series. Writes
  and removal are best-effort and do not interrupt route arbitration.
