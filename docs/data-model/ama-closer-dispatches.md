# Data Model - AMA Closer Dispatch Records

**Owner:** AMA closer dispatch and recovery
**Store:** `data/follow-up-jobs/ama-closer-dispatches/`
**Source of truth:** `src/ama/dispatch-closer.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/follow-up-stuck-claim-sweep.mjs`, `src/recovery-reaper.mjs`

## Purpose

`data/follow-up-jobs/ama-closer-dispatches/` records the AMA closer's current
dispatch state for a pull request head. The watcher, follow-up daemon, and
reapers use these files to avoid double-dispatching terminal remediation, to
reattach to a live closer, and to release stale launch records after bounded
recovery checks.

The file is keyed by `(repo, PR, headSha)`. For stale-review terminal-hammer
redrive, `reviewedSha` preserves the reviewed commit and
`targetRemediationSha` identifies the live head the hammer is allowed to
remediate.

## Files

Directory: `data/follow-up-jobs/ama-closer-dispatches/`

| File | Shape | Contract |
|---|---|---|
| `<repo-slug>-pr-<number>-<head-sha>.json` | AMA closer dispatch record | One current record per `(repo, PR, headSha)`. The repo slug replaces `/` with `__` and unsafe filename characters are replaced with `-`. |

## AMA Closer Dispatch Record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. |
| `headSha` | string | Dispatch-record identity SHA. Current writers use the live remediation target SHA. |
| `reviewedSha` | string or null | Commit SHA that carried the posted review verdict. |
| `targetRemediationSha` | string or null | Live PR head SHA targeted by HAM remediation; may differ from `reviewedSha` during stale-review exhausted-lane redrive. |
| `dispatchReason` | string or null | Operator-visible reason for dispatch, such as `exhausted-final-hammer`. |
| `workerClass` | string | Logical closer class requested by AMA, usually `hammer`. |
| `dispatchWorkerClass` | string | Physical worker class passed to HQ after harness fallback. |
| `workerId` | string or null | Stable HQ worker id for this closer launch when AMA supplies one. Hammer records include `hammer-ama-pr-<PR>-<scope>` where `<scope>` is derived from the target head or existing record. Legacy records may omit this field; recovery falls back to the old bare `hammer-ama-pr-<PR>` only when no scoped id is recorded. |
| `promptPath` | string or null | Prompt file handed to `hq dispatch`. |
| `promptDir` | string or null | Directory holding durable AMA closer prompts. |
| `hqRoot` | string or null | HQ root used for the dispatch. |
| `state` | string | Launch state such as `dispatching`, `dispatched`, `dispatch-deferred-transient`, `dispatch-failed`, `no-dispatch`, or `completed`. |
| `dispatchId` | string or null | Dispatch id parsed from HQ output when available. |
| `launchRequestId` | string or null | Launch request id parsed from HQ output when available. |
| `retryCount` | non-negative integer | Budgeted failed-dispatch count. Transient and branch-holder refusals preserve budget. |
| `branchHolderBlockCount` | non-negative integer | Count of branch-holder refusals for bounded same-PR worktree cleanup. |
| `lastObservedStatus` | string or null | Most recent worker status observed through HQ/session-ledger probes. |
| `lastObservedAt` | string or null | ISO-8601 timestamp for the latest worker observation. |
| `lastAttemptedAt` | string or null | ISO-8601 timestamp for the latest launch attempt. |
| `dispatchedAt` | string or null | ISO-8601 timestamp for a confirmed or ambiguous launch. |
| `createdAt` | string or null | ISO-8601 timestamp from the first write when available. |
| `updatedAt` | string or null | ISO-8601 timestamp from the latest write when available. |
| `lastFailureTransient` | boolean or null | Whether the latest launch refusal was classified as transient. |
| `lastError` | string or null | Sanitized last error or recovery note. |
| `status`, `reason`, `terminalOutcome`, `closureAuthority` | string or null | Terminal/no-dispatch annotations used by recovery and audit paths when present. |

## Operational Contract

- Active `dispatching` and `dispatched` records reserve the same `(repo, PR)`
  from follow-up consumption until the record reaches a terminal state or ages
  past the documented reclaim window.
- Recovery checks age records from the latest parseable timestamp among
  `lastObservedAt`, `lastAttemptedAt`, `dispatchedAt`, and `createdAt`.
- A `dispatching` record with no parseable timestamp is stale; a launch-only
  `dispatched` record without timestamps remains held until first observation.
- `workerId` is authoritative for scoped hammer cleanup when present. Legacy
  records without `workerId` remain readable and use the historical unscoped
  hammer id as the fallback cleanup target.
- Writes are atomic JSON rewrites. Corrupt or unreadable records are skipped by
  bounded scans so one bad file cannot blind later active reservations.
