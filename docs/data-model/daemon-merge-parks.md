# Data Model - Daemon Merge Parks

**Owner:** AMA daemon clean-merge diagnostics
**Store:** `data/daemon-merge-parks/`
**Source of truth:** `src/daemon-merge-park-log.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`, `src/review-pipeline-health.mjs`

## Purpose

`data/daemon-merge-parks/` records why the AMA daemon clean-merge path declined
to merge a review-settled PR. These files are diagnostic only: they do not
authorize, block, or otherwise participate in merge decisions.

The health collector reads the records so it can ticket the exact park reason
and remedy, such as `worker-identity-unresolved`, instead of surfacing a generic
terminal-but-unmerged stall.

## Files

Directory: `data/daemon-merge-parks/`

| File | Shape | Contract |
|---|---|---|
| `<repo-slug>__pr-<number>.json` | Park record | One current park per `(repo, PR)`. The repo slug is filesystem-safe and is derived from the repository full name. |

## Park Record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. Invalid, zero, fractional, boolean, null, or blank values are rejected before writing. |
| `headSha` | string or null | PR head SHA observed when the daemon declined, when available. |
| `reason` | string | The daemon decline reason. Repeating the same reason increments the standing observation count. |
| `firstObservedAt` | string | ISO-8601 timestamp for the first observation in the current same-reason streak. |
| `lastObservedAt` | string | ISO-8601 timestamp for the latest observation in the current same-reason streak. |
| `observationCount` | positive integer | Consecutive observations for the same reason. A different reason restarts the record at `1`. |
| `remedy` | string or null | Reason-specific operator remedy when known, otherwise null. |

## Operational Contract

- Writes are best-effort and synchronous. A write, parse, or cleanup failure must
  not break the merge path being observed.
- A repeat park with the same `reason` preserves `firstObservedAt`, updates
  `lastObservedAt`, and increments `observationCount`.
- A park with a different `reason` restarts the record because the old reason is
  no longer the current merge blocker.
- The daemon clears the record after a clean daemon merge succeeds.
- The health collector prunes records for PRs that are no longer active/open and
  expires records that have not been refreshed for the configured stale window.
- Corrupt, unreadable, or structurally invalid files are removed on read so one
  bad diagnostic file cannot blind the rest of the health surface.
- Records contain no secrets, review bodies, or remediation payloads.
