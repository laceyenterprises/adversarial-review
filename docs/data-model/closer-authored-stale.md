# Data Model - Closer-Authored Stale Verdict Audits

**Owner:** AMA closer-authored stale-head verdict carry-forward
**Store:** `data/closer-authored-stale/`
**Source of truth:** `src/closer-authored-stale.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Purpose

The orchestrator records which settled reviewed verdict is carried forward to
a newer head composed only of proven single-parent closer commits. It calls
`writeCloserAuthoredStaleAudit` when the shared predicate is eligible, after
the protective-predecessor policy gate, before requesting the eligible hammer
wake. The audit is evidence of carry-forward, not a merge receipt or a grant of
merge authority. Ordinary closure gates and hammer lifetime limits still apply.

## Files and fields

One JSON record per `(repo, PR, closer head)` is stored as
`<repo-slug>-pr-<number>-<headSha>.json`. The slug replaces each run of characters
outside letters, digits, `.`, `_` and `-` with `__`.

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | integer | Current value is `1`. |
| `event` | string | `closer_authored_stale_verdict_carried_forward`. |
| `repo` | string | Repository full name. |
| `prNumber` | integer | Pull request number. |
| `headSha` | string | Exact current closer head authorized by the shared predicate. |
| `reviewedHead` | string | Head on which the carried verdict was posted. |
| `anchorHead` | string | Reviewed head or recorded comment-only final-round push where the proven closer chain ends. |
| `closerCommits` | string array | Proven closer commits, newest first, excluding the anchor. |
| `carriedVerdict` | string or null | Verdict supplied by the orchestrator, such as `comment-only`. |
| `blockingFindingCount` | number | Carried verdict's blocking count; eligible heads have zero. |
| `nonBlockingFindingCount` | number | Carried verdict's non-blocking count; strict closure may still require hammer remediation. |
| `observedAt` | ISO-8601 string | Observation time, defaulting to the writer's current time. |

## Operational contract

The shared predicate requires a proven closer-only chain, a settled success
verdict with known zero blockers, successful exact-head checks and `MERGEABLE`
mergeability. Pending checks or unknown mergeability defer eligibility; resolved
non-mergeable states (including `CONFLICTING`) are hard misses. A foreign commit,
merge commit, broken chain or overlong chain requires exact-head review. A live
review on the closer head supersedes carry-forward.

Writes are atomic and create-only (`overwrite: false`): repeated observations
return `already-audited` and preserve the first record. Ineligible input writes
nothing. Other write failures warn and return `audit-write-failed`; this
best-effort audit never changes the closure decision. Records persist across
daemon restarts, with no automatic pruning in this module. Historical records
do not authorize later heads or reopen retry caps; dispatch uses current
eligibility and the separate [hammer retry ledger](hammer-retry-cap.md).
