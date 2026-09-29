# Data Model - Merge-Agent Harness Deferrals

**Owner:** merge-agent dispatch (CLOSERREUSE-01)
**Store:** `data/follow-up-jobs/merge-agent-harness-deferrals/`
**Source of truth:** `src/merge-agent-harness.mjs`
**Runtime surface:** `src/follow-up-merge-agent.mjs`

## Purpose

The merge-agent resolves its worker class through the AMA closer's harness
resolver and fallback list. When the configured class is hard- or
soft-grounded and no ungrounded fallback exists, `dispatchMergeAgentForPR`
returns `dispatch-deferred` with reason `merge-agent-harness-grounded` and
dispatches nothing. The merge-agent is the last-resort lane, so a deferral must
not stall silently: each one is recorded here, and one that outlives 30 minutes
escalates once.

## Files

Directory: `data/follow-up-jobs/merge-agent-harness-deferrals/`

| File | Shape | Contract |
|---|---|---|
| `<owner>__<repo>-pr-<n>-<headSha>.json` | Deferral record | One record per `(repo, PR, head SHA)`. Characters outside `[A-Za-z0-9._-]` become `-`. A missing head SHA is written as `no-sha`. |

## Deferral Record

| Field | Shape | Contract |
|---|---|---|
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | number | Pull request number. |
| `headSha` | string or null | PR head the merge-agent job was for. |
| `reason` | string | Always `merge-agent-harness-grounded`. |
| `workerClass` | string or null | Configured merge-agent class that could not dispatch. |
| `provider` | string or null | Grounded provider of that class. |
| `groundedBy` | string or null | `hard` or `soft`. |
| `primaryState` | string or null | Quota state reported for the provider. |
| `firstDeferredAt` | string | ISO-8601 time of the first deferral. Kept on every later tick. |
| `lastDeferredAt` | string | ISO-8601 time of the latest deferral. |
| `deferralCount` | positive integer | Deferred ticks recorded for this head. |
| `escalatedAt` | string or null | Time `merge_agent.harness_grounded_deferral` was logged. Set once. |

## Operational Contract

- Written by `trackMergeAgentHarnessDeferral` on each deferred resolution. Any
  resolution that does not defer removes the record.
- Once `lastDeferredAt - firstDeferredAt` reaches 30 minutes, the
  `merge_agent.harness_grounded_deferral` JSON event is logged at warn level
  exactly once and `escalatedAt` is stamped.
- Best-effort: a read or write failure is logged and never blocks or fails the
  merge-agent tick. An unreadable record restarts the window.
- Writes are atomic JSON rewrites. Operators may delete a record; the next
  deferral starts a new window.
