# Reviewer Cleanup Findings

**Owner:** reviewer reattach cleanup  
**Store:** `data/reviewer-cleanup-findings/`  
**Source of truth:** `src/reviewer-cleanup-findings.mjs`  
**Runtime surface:** `src/reviewer-reattach.mjs`, `src/watcher.mjs`,
`src/pollonce-phases.mjs`, `src/reviewer-orphan-reconcile.mjs`

## Purpose

Reviewer subprocesses can still be alive after the reviewer bot's GitHub review
is visible. When reviewer reattach confirms the process group still matches the
stored reviewer session, it sends `SIGKILL` before moving the `reviewed_prs` row
from `reviewing` to `posted`. The cleanup-finding store records the exceptional
case where the process group remains alive and identity-matched after that kill
attempt, so the watcher does not reduce a still-live process group to a single
log line after the row leaves the active `reviewing` population.

Each JSON file is keyed by `reviewerSessionUuid`. The watcher rewrites the same
file on later checks while the process group is still alive and removes it once
the probe proves the process group is gone.

## Artifact Schema

| Field | Shape | Contract |
|---|---|---|
| `id` | string | Currently `reviewer:posted_process_group_leak`. |
| `severity` | string | Currently `warning`; the file is evidence, not a pager route by itself. |
| `repo` | string | Repository slug for the reviewed PR. |
| `prNumber` | number | GitHub PR number. |
| `reviewerSessionUuid` | string | Stable file identity and reviewer process-session matcher. |
| `reviewerPgid` | number | Positive process-group id that remained alive after the posted-review kill and cleanup checks. |
| `matched` | boolean or null | Whether the live process group still matched the original reviewer session identity when the finding was recorded. |
| `postedAt` | ISO-8601 string or null | GitHub review submission time that caused the row to move to `posted`. |
| `firstObservedAt` | ISO-8601 string | First time the cleanup finding was persisted. |
| `lastObservedAt` | ISO-8601 string | Most recent watcher recheck time. |
| `checks` | number | Count of durable observations for this session. |

Writers may add diagnostic fields later, but readers only rely on the session
UUID and PGID for rechecks.

## Operational Contract

- `writeReviewerCleanupFinding` uses the repository atomic-write helper and
  overwrites by session UUID, preserving `firstObservedAt` while bumping
  `lastObservedAt` and `checks`.
- `recheckReviewerCleanupFindings` scans a bounded batch of JSON files, prunes
  findings past the configured age window, probes the stored
  process-group/session evidence, removes files whose process group is no
  longer alive or no longer matches the original reviewer session, and rewrites
  files whose process group remains alive and matching.
- Corrupt files are skipped so one bad artifact cannot block every other
  cleanup finding from being rechecked.
- The store contains no credentials or review body content. It records only PR
  identity, reviewer session identity, process-group evidence, and timestamps.
