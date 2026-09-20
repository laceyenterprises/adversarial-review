# Data Model - Hammer Wakes

**Owner:** AMA event-driven hammer wake diagnostics
**Store:** `data/hammer-wakes/`
**Source of truth:** `src/hammer-wake.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`, `src/review-pipeline-health.mjs`

## Purpose

`data/hammer-wakes/` records event-driven watcher wake attempts for PR heads
that have already cleared the AMA merge-eligibility snapshot. The files are a
reservation and audit trail for a latency optimization only: they do not grant
merge authority, bypass the watcher, or replace the normal poll path.

The health collector reads the newest audit records so an operator can see
whether an eligible PR head was skipped as a duplicate, successfully woke the
watcher, or failed before the wake could be delivered.

## Files

Directory: `data/hammer-wakes/`

| File | Shape | Contract |
|---|---|---|
| `<sha256>.json` | Current wake audit | One current reservation per `(repo, PR, head SHA, eligibility reason)`. The filename is the SHA-256 digest of `<repo>#<pr>@<head>:<eligibilityReason>`. |
| `<sha256>.failed-<12hex>.json` | Archived failed wake audit | A failed current reservation moved aside by the retry election path. The suffix is diagnostic uniqueness derived from the retry observation. |

## Wake Audit Record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `event` | string | Always `hammer_wake`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. Invalid, zero, fractional, boolean, null, or blank values are rejected before reservation. |
| `headSha` | string | PR head SHA that satisfied the merge-eligibility snapshot. |
| `eligibilityReason` | string | Stable reason used in the dedupe key. The default is `clean-current-head-ci-green-policy-eligible`. |
| `observedAt` | string | ISO-8601 time when the eligible snapshot was observed. |
| `outcome` | string | `reserved`, `requested`, or `failed`. Returned events may also report `skipped` or `duplicate` without replacing a requested audit file. |
| `route` | string | Current value is `watcher-ama-merge-authority`, because the wake targets the existing watcher AMA route. |
| `requestId` | string or null | Watcher wake request ID after a successful transport confirmation. |
| `requestedAt` | string | Watcher wake timestamp after a successful transport confirmation. |
| `reason` | string | Failure or duplicate reason on returned events and failed audit records. |
| `error` | string | Best-effort diagnostic message for failed audit records. |
| `latencyEvent` | object | Present when the wake was delivered but the `review_latency_events` write was annotated as failed. This field never changes `outcome` from `requested`. |

## Operational Contract

- Writes are best-effort and synchronous. Audit directory, audit write, latency
  telemetry, and diagnostic logging failures must not abort AMA closure.
- The success boundary is the watcher wake transport. Once the watcher confirms
  `requested: true`, the audit record is persisted as `requested`; later
  latency-event failures are annotations and do not make the wake retryable.
- Reservation creation uses atomic exclusive create. Readers should not observe
  partially written JSON at the final reservation path.
- A current `requested` record suppresses duplicate wakes for the same
  `(repo, PR, head SHA, eligibility reason)`. A current `failed` record may be
  archived and retried by a bounded retry election.
- Retention is enforced by `src/hammer-wake.mjs`: eligible wake attempts sweep
  `.json` audit records older than 30 days and then retain only the newest 5000
  files by filesystem mtime. Failed archives follow the same retention rule.
- The health collector sorts audit files by mtime and parses only the newest 20
  records before rendering the health surface, so directory size does not make
  every watcher tick parse every historical wake.
- Records contain no secrets, review bodies, or remediation payloads.
