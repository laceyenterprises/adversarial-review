# Data Model - Rereview Wakes

**Owner:** RPL-04 event-driven rereview wake queue
**Store:** `data/rereview-wakes/`
**Source of truth:** `src/rereview-wake.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/posted-review-row.mjs`, `bin/rereview-wake.mjs`, `src/review-latency-report.mjs`

## Purpose

`data/rereview-wakes/` is the durable, idempotent queue of "this PR became
eligible for re-review — look at it now" requests. It exists because the
ordinary watcher wake (`data/watcher-wake.json`) is a single overwritable slot
that is consumed once and forgotten: if the watcher was mid-poll, bouncing, or
rate-capped when a remediation push landed, the wake evaporated and the PR
waited a full poll interval with nothing recorded about why.

A record in this queue answers three operator questions that the wake file
cannot: *was a re-review ever asked for*, *when did the watcher pick it up*, and
*what is holding it now*.

## What this queue does NOT do

- It does not reset a review row, claim one, or spawn a reviewer. Arming the
  re-review is the producer's job (`requestReviewRereview`); this queue only
  records the request and observes what admission did with it.
- It does not grant admission. Every existing eligibility gate — CI admission,
  active-follow-up defer, cascade backoff, review-cycle caps, terminal-PR
  guards — still runs unchanged.
- It is not required for correctness. Normal polling remains the fallback for
  every request this queue drops, expires, or never sees.

## Files

| Path | Shape | Contract |
|---|---|---|
| `pending/<repo>__pr-<n>__<sha256>.json` | Outstanding request | At most one per `(repo, PR, head SHA, wake reason)`. The digest is the SHA-256 of `<repo>#<pr>@<head or ->:<reason>` and decides identity; the subject slug prefix exists so the per-PR drain can filter by directory entry instead of parsing every file. Created with an atomic exclusive create, which is the dedupe CAS. |
| `settled/<repo>__pr-<n>__<sha256>.completed.json` | Terminal request | Admission took the re-review. |
| `settled/<repo>__pr-<n>__<sha256>.skipped.json` | Terminal request | The request can never be satisfied (terminal PR, superseded head, missing row, expired). |

A pending record is settled by renaming it into `settled/` and then annotating
it in place. The rename is the CAS: exactly one caller can move the inode, and
every other caller gets `ENOENT` and reports `wake-already-settled` without
emitting a second terminal latency event.

## Request record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `event` | string | Always `rereview_wake`. |
| `requestId` | string | UUID minted by the producer. |
| `repo` | string | Repository full name, `owner/repo`. |
| `prNumber` | positive integer | Pull request number. |
| `headSha` | string or null | The head the request is about. Null collapses to the `-` dedupe slot for that `(repo, PR, reason)`. |
| `reason` | string | Wake reason, one of `remediation-closeout`, `ci-transition`, `follow-up-eligible`, `operator`. Part of the dedupe key, so it is a closed set rather than free text. |
| `source` / `sourceRef` | string or null | Producer label and its own reference (follow-up job ID, CI transition detail, CLI). |
| `state` | string | `requested` -> `claimed` -> (`completed` \| `skipped`). |
| `requestedAt` | ISO-8601 | When the producer enqueued it. |
| `claimedAt` | ISO-8601 or null | First time the watcher observed it. Never overwritten on re-observation — the claim latency is the FIRST pickup. |
| `claimCount` / `holdCount` | integer | Observations and non-settling observations. |
| `holdReason` | string or null | Why the last observation could not settle it, e.g. `ci-blocked`, `awaiting-admission:failed`. |
| `settledAt` / `settledReason` | ISO-8601 / string | Terminal transition and its named reason. |
| `watcherWake` | object | Result of the transport nudge to `data/watcher-wake.json`. A failed transport does not fail the request. |

## Settle reasons

| Reason | State | Meaning |
|---|---|---|
| `rereview-admitted:pending` / `:reviewing` | completed | The row is queued for, or held by, a reviewer. |
| `rereview-posted` | completed | A review posted on the requested head at or after the request. |
| `pr-terminal` | skipped | The PR is merged or closed. |
| `review-row-missing` | skipped | No `reviewed_prs` row for the subject. |
| `head-superseded` | skipped | A newer head landed; that head's own wake is the live one. |
| `review-status-terminal:<status>` | skipped | `malformed`, `unroutable-bot-author`, or `argus-security-queued`. |
| `wake-expired:<hold reason>` | skipped | Unsettled past `ADVERSARIAL_REREVIEW_WAKE_MAX_AGE_MS` (default 24h). |

## Operational contract

- Every write is best-effort and synchronous. A dir, write, transport, or
  telemetry failure is recorded and returned; it never throws into remediation
  closeout or the watcher tick.
- Each state transition emits one `rereview_wake` row in `review_latency_events`
  with `payload.state` set to `requested`, `claimed`, `completed`, or `skipped`,
  keyed `rereview-wake:<state>:<dedupe key>` so replays collapse.
- The per-PR drain runs in the watcher's admission lane; a once-per-tick sweep
  in the adoption phase covers PRs the admission lane cannot reach. Both are
  bounded at 200 records per pass.
- A record that settled within the last 10 minutes suppresses a fresh request
  for the same key. The guard is time-bounded on purpose: a head does not always
  move between remediation rounds, and an unbounded guard would silently disable
  the wake for that PR/head for the rest of retention.
- Retention: settled records older than 30 days are swept, then only the newest
  5000 are retained, by filesystem mtime.
- `ADVERSARIAL_REREVIEW_WAKE=0` disables the queue. Disabling degrades to the
  pre-RPL-04 poll cadence; it never stops the pipeline.
- Records contain no secrets, review bodies, or remediation payloads.
