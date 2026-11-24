# Data Model - Adversarial Gate Status

**Owner:** watcher gate projection and docs fast path
**Store:** `data/adversarial-gate-status/`
**Source of truth:** `src/adversarial-gate-status.mjs`
**Runtime surface:** `src/docs-fast-path.mjs`

## Key and fields

The filename is `<owner__repo>-pr-<number>-<headSha>.json`, with unsafe path
characters replaced by hyphens. Each record describes one repository, PR and
commit head.

| Field | Shape | Contract |
|---|---|---|
| `context` | string | Published commit-status context. |
| `repo`, `prNumber`, `headSha` | string, integer, string | Repository, positive PR number and exact commit head. |
| `state`, `description`, `reason` | strings | Latest published gate decision. |
| `postedAt` | ISO-8601 string | Successful publication time. |
| `docsFastPathWithdrawn` | optional boolean | Once true, retained across subsequent publications for this head. Records a settled docs fast-path refusal and keeps ordinary review admission active even after reviewer assignment and reset. It never authorizes merge. |

## Persistence and compatibility

After successful status publication, the publisher atomically replaces the
record and prunes other heads for the same PR. Identical decisions reuse the
existing record without another status write. Failed publication leaves the
prior record intact. Disabling gate publication also suppresses record writes.

Legacy records with `state: pending` and `reason: docs-fast-path-not-eligible`
remain withdrawal evidence; the next changed publication carries that evidence
into `docsFastPathWithdrawn: true`. A missing flag without that legacy reason
does not imply withdrawal. The docs fast path reads this evidence independently
of the current gate status or reviewer assignment, including nullish reviewer
fields. A new head starts without its predecessor's withdrawal.
