# Data Model - Hammer Wakes

**Owner:** AMA event-driven hammer wake diagnostics
**Store:** `data/hammer-wakes/`
**Source of truth:** `src/hammer-wake.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`, `src/review-pipeline-health.mjs`

## Purpose

NXA-03 routes the closure caller from the shared immutable snapshot and
`nextAction(snapshot)` decision. A new hammer dispatch intent or daemon merge
intent wakes the watcher; live owners, reconciliation, review/remediation,
holds and deferred dispatches keep their named owners without a hammer wake.
Red CI (including runner-less failure), conflict, final findings and a proven
suppressed push can request repair. Wake admission grants no merge permission.
Other caller routing remains legacy with observational shadow. The legacy
eligibility adapter remains available for a source revert of this caller.
The files are a reservation and audit trail for a latency optimization only: they do not grant
merge authority, bypass the watcher, or replace the normal poll path.

The health collector reads the newest current audit records so an operator can see
whether an eligible PR head was skipped as a duplicate, successfully woke the
watcher, or failed before the wake could be delivered.

## Files

Directory: `data/hammer-wakes/`

| File | Shape | Contract |
|---|---|---|
| `<sha256>.json` | Current wake audit | One current reservation per `(repo, PR, head SHA, eligibility reason, wake attempt)`. The digest input is `<repo>#<pr>@<head>:<eligibilityReason>:attempt:<wakeAttemptKey>` for shared routing. Legacy records omit the attempt suffix. |
| `<sha256>.retry-<12hex>.json` | Archived retry hand-off audit | A failed current record or a `reserved` record abandoned for more than 10 minutes (also delivered no-merge wakes under the retained legacy adapter), moved aside by the retry election path. The suffix is diagnostic uniqueness derived from the retry observation. Older `.failed-<12hex>.json` archives remain under retention. |

## Wake Audit Record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `event` | string | Always `hammer_wake`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. Invalid, zero, fractional, boolean, null, or blank values are rejected before reservation. |
| `headSha` | string | Live PR head SHA admitted for the wake. |
| `eligibilityReason` | string | `shared-next-action` for the adopted caller; retained legacy reasons continue to identify older records. |
| `wakeAttemptKey` | optional string | Shared routing uses `initial`, or the completed launch receipt ID for a retryable no-merge decision (numeric decision attempt when no receipt ID is available); completed retry descendant IDs add a stable set digest because fleet retries reuse ancestor receipts. Independent of reason/deadline changes for ordinary retries. RECOVERYDEADLINE-01 recovery dispatch uses `recovery:<row>:<reason>:<anchoredAt>:<retry-identity-or-initial>` so an earlier initial wake cannot swallow expiry; repeated clocks preserve this key. |
| `nextAction` | optional object | Shared action, actor, original reason, deadline, head, decision key, evidence references, queue intent/deferral, pass ID and generation. No raw evidence. |
| `observedAt` | string | ISO-8601 time when the eligible snapshot was observed. |
| `outcome` | string | `reserved`, `requested`, or `failed`. Returned events may also report `skipped` or `duplicate` without replacing a requested audit file. |
| `route` | string | Current value is `watcher-ama-merge-authority`, because the wake targets the existing watcher AMA route. |
| `requestId` | string or null | Watcher wake request ID after a successful transport confirmation. |
| `retryOfLaunchRequestId` | optional string | Completed no-merge LRQ consumed by this wake; the retained receipt can outlive its lease. Prevents repeated wakes for that same finished attempt; the next distinct failed attempt may wake again. |
| `requestedAt` | string | Watcher wake timestamp after a successful transport confirmation. |
| `reason` | string | Failure or duplicate reason on returned events and failed audit records. |
| `error` | string | Best-effort diagnostic message for failed audit records. |
| `latencyEvent` | object | Present when the wake was delivered but the `review_latency_events` write was annotated as failed. This field never changes `outcome` from `requested`. |

## Operational Contract

- The caller resolves one shared snapshot/decision pair before waking and
  passes that exact pair to the observational shadow. Enrichment preserves
  runner-less checks, drain/capacity, durable anchors and semantic rebase proof.
  Retained dispatch receipts supply launch evidence even after lease removal;
  retry descendants are read through the existing bounded ledger reader.
  Sticky succeeded receipts select remote receipt reconciliation until the recovery deadline; readable ownerless expiry then selects leased hammer admission. Unreadable recovery wakes remain retryable without launch permission.
- Shared latency events carry the original decision reason and `nextAction`
  projection. Only daemon-merge wakes end `clean_verdict_to_hammer_wake`;
  repair wakes remain in telemetry. Older events retain their existing filter.
- Writes are best-effort and synchronous. Audit directory, audit write, latency
  telemetry, and diagnostic logging failures must not abort AMA closure.
- The success boundary is the watcher wake transport. Once the watcher confirms
  `requested: true`, the audit record is persisted as `requested`; later
  latency-event failures are annotations and do not make the wake retryable.
- Reservation creation uses atomic exclusive create. Readers should not observe
  partially written JSON at the final reservation path.
- A current `requested` record suppresses duplicates for the same attempt.
  A reconciled retryable no-merge decision gets a new attempt key from the
  completed LRQ and completed retry descendant IDs, even on the same head
  and after terminal lease removal. Descendant IDs accept `launch_request_id`,
  `launchRequestId`, or `id` in that precedence order; equivalent representations
  share the same digest. Row order and timestamp changes do not rearm.
  Live descendants or unreadable retry chains never rearm it. Transport does
  not re-read launch state or final-push proof for shared routing. The retained
  legacy adapter still uses terminal lease/dispatch evidence to rearm.
  Wakes grant no retry budget; closer admission enforces all existing caps.
  A current `failed` record may be
  archived and retried by a bounded retry election. A `reserved` record whose
  `observedAt` is more than 10 minutes old takes the same path; if that field
  is missing or malformed, the audit file's mtime supplies the age. A rename
  hand-off is not a content compare-and-swap between processes, and a wake may
  already have been delivered before its `requested` write. Stale takeover
  therefore provides at-least-once wake delivery; watcher merge authority and
  its own dedupe remain the safety boundary.
- The returned event's `retryable` value describes whether the persisted
  state lets a later watcher tick resume. It is diagnostic only; the AMA caller
  does not consume it as a retry instruction.
- Retention is enforced by `src/hammer-wake.mjs`: eligible wake attempts start
  best-effort asynchronous maintenance, coalesced per audit directory while a
  sweep runs and for 60 seconds afterward. An unref'd cooldown timer permits
  process exit; dispatch never waits for directory traversal. Sweeps remove
  `.json` audit records older than 30 days and then retain only the newest 5000
  files by filesystem mtime. These bounds are eventual between sweeps. Both
  `.retry-` and legacy `.failed-` archives follow the same retention rule.
- The health collector excludes retry and legacy failed archives, sorts the
  current audit files by mtime, and parses only the newest 20 records before
  rendering the health surface.
- Records contain no secrets, review bodies, or remediation payloads.
