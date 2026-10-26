# Data Model - Alert Delivery State

**Owner:** adversarial-review alert delivery
**Store:** `~/.config/adversarial-review/data/alert-delivery/` by default, or the
principal-owned `ADVERSARIAL_ALERT_DELIVERY_ROOT` /
`AGENT_OS_ALERT_DELIVERY_STATE_DIR` owner-root override. Overrides name the
parent root; the sink appends `data/alert-delivery/`. A path already ending in
`data/alert-delivery/` is accepted as the final sink path for compatibility.
**Source of truth:** `src/alert-delivery.mjs`
**Runtime surface:** `src/alert-delivery.mjs`, `src/health-probe.mjs`, `src/watcher.mjs`, `src/fleet-stop.mjs`

## Purpose

The principal-owned `data/alert-delivery/` root is the durable alert sink used when watcher and merge
authority paths need to page an operator. `deliverAlert` writes an alert
document and receipt before returning; background drain work then moves the
document through delivery states until the notification bus accepts it.

The sink is designed for at-least-once delivery. A malformed or unreadable alert
file must affect only that file, not the rest of the queue.

## Directories

Directory: `data/alert-delivery/`

| Path | Shape | Contract |
|---|---|---|
| `pending/*.json` | Alert document | Durable work waiting for delivery or retry. `id` is a safe filename token and must exactly match the file basename. Drainers process sorted files up to their item cap. |
| `inflight/*.json` | Alert document | Claimed work being posted to the notification bus. The same ID/basename invariant applies. Stale inflight files are recovered back to `pending/`. |
| `delivered/*.json` | Alert document with `deliveredAt` | Successful delivery archive, retained for 30 days by default. |
| `quarantine/*.json` | Original unreadable file bytes | Files that cannot be parsed or read during pending drain or inflight recovery. Quarantining is fail-isolating: later alerts continue draining. |
| `dead-letter/*.json` | Alert document with `deadLetteredAt` and `lastError` | Parseable alerts with a permanent delivery error or exhausted transport attempts. Dead letters are terminal and operator-actionable; they are not retried silently forever. |
| `receipts/*.json` | Receipt document | Append-style audit receipts for queued, failed, and delivered phases, retained for 30 days by default. |
| `health.json` | Health snapshot | Last observed delivery health and live queue counters for probes and operators. |

## Health Snapshot

`health.json` records operator-facing state:

| Field | Shape | Contract |
|---|---|---|
| `ready` | boolean | `true` only when live pending, inflight, quarantine, and dead-letter counts are all zero. |
| `pendingCount` | number or null | Live count of `pending/*.json`; `null` when the lane cannot be safely inspected. |
| `quarantineCount` | number or null | Live count of `quarantine/*.json`; `null` when the lane cannot be safely inspected. |
| `deadLetterCount` | number or null | Live count of `dead-letter/*.json`; non-zero or unreadable is an operator-pageable delivery failure. |
| `healthCheckError` | string or null | Actionable ownership, type, or read error. Any non-null value forces `ready: false`; only a genuine `ENOENT` lane is counted as zero. |
| `lastQueuedAt` / `lastDeliveredAt` / `lastFailureAt` | string or null | ISO-8601 timestamps for the latest queue, delivery, and failure observations. |
| `lastFailureReason` | string or null | Last transport or quarantine reason while the sink is not ready. |
| `lastQueuedEvent` | string or null | Event name from the latest queued alert, when present. |
| `lastQuarantinedAt` | string or null | ISO-8601 timestamp for the latest quarantine. |
| `lastQuarantinedFile` | string or null | Basename of the latest quarantined file. |
| `lastDeadLetteredAt` / `lastDeadLetteredFile` | string or null | Timestamp and basename for the latest permanent or exhausted delivery failure. |
| `lastSev1DeliveryFailure` | object or absent | Latest dead-lettered SEV1 signal: `signal: "alert-delivery-failed"`, `alertId`, `event`, `repo`, `pr`, `at`, `attemptCount`, `reason` (up to 2,000 characters). Event/PR identifiers may be null when absent from the original page. Retained across unrelated deliveries and process restarts. |

## Operational Contract

- `fleet-stop-unreadable` is an operator page. The shared fleet-stop evaluator
  keeps its merge hold and emits one error log and alert per distinct state root,
  path class (state root or halt directory), and error code per process lifetime.
  Logs and payloads contain the path class and code, never paths or file contents.
  Its event uses the same safe-prefix sanitizer as orphan recovery identities;
  `deliverAlert` allocates the normal safe outbox ID. Recovery is tracked per
  state root and emits a log only when that root becomes readable again;
  deliberate halt markers and readable empty directories never alert here.
  Enqueue failure is logged and retains the hold; the process debounce still
  suppresses further attempts for that cause. Durable transport retries remain
  owned by the existing drain.
- Enqueue deduplication reads the real durable sink, matching its writes and
  state-transition renames. `deliverAlert`'s `fsImpl` supplies token/config
  reads, not a virtual outbox; tests use a temporary real state root. A mocked
  token-file existence check cannot create or hide a durable alert receipt.
  Model-refusal receipt checks accept a separate `receiptFsImpl.existsSync`
  test seam, defaulting to the real sink; token/config mocks remain separate.
- `deliverAlert` is enqueue-first: once the pending document and queued receipt
  are durable, callers receive `{ status: "queued" }`. Callers intentionally
  treat that durable enqueue as terminal for their own debounce; transport
  delivery authority belongs to the sink health/receipt state.
  GitHub rate-limit or deferred-budget scopes do not suppress enqueueing or
  delivery: the local outbox and notification transport use no GitHub quota.
- Orphan recovery `exhausted`, `ownership-uncertain` and `store-error` events,
  and the hammer-owner SEV1 pages — CYCLECAPHAM-01
  `ama.review_cycle_cap.hammer_final` (review-cycle-cap PR) and CIBLOCKHAM-01
  `ama.ci_blocked.hammer_final` (failed CI with no remediation job left), each
  sent for the hammer's final no-merge decision or exhausted retry cap — use a
  deterministic event plus SHA-256 identity over
  `repo#prNumber@headSha`.
  Enqueue retries reuse pending, inflight, delivered and dead-letter documents,
  including a crash before the watchdog's SQLite page guard is updated.
- Review-exhaustion `adversarial_review.operator_decision_required` pages use
  `review-decision-<sha256(JSON.stringify([decisionId, decisionSeriesId]))>`.
  The per-head record ID stays stable; the persisted blocker-series UUID changes
  after the no-progress lane is cleared or replaced. Retries within one series
  reuse pending, inflight, delivered and dead-letter documents, while a new
  series can page again on the same head. If record persistence fails, no series
  ID is supplied and the normal outbox identity applies; the lane debounce still
  suppresses repeats. Legacy payloads without a series ID also use normal IDs.
- HOLDOWNER-01 `adversarial_review.pr_progress_stalled` is a page for every TTM
  STUCK kind, including `ownerless`. It uses
  `pr-progress-<sha256(JSON.stringify([repo, prNumber, headSha]))>` and reuses
  pending, inflight, delivered and dead-letter documents after a lost tracker
  receipt. All active reasons for that PR share the same per-head page. A new
  head gets a new identity; SLOW flags never enter this path. The tracker owns
  the additional observation and page-receipt tables documented in
  [TTM ownership observations](ttm-ownership.md).
- Model-refusal `reviewer.model_unavailable` alerts use
  `reviewer-model-<sha256(JSON.stringify([refusedModel, YYYY-MM-DD]))>`,
  where the date is UTC. Daily deduplication reuses pending, inflight, delivered
  and dead-letter documents for the same refused model; a new UTC day allows
  a new alert.
- AMA automated recovery exhaustion pages use
  `ama-recovery-<sha256(JSON.stringify([repo, pr, head, reason]))>`. Same-reason
  retries reuse pending, inflight, delivered and dead-letter documents; a later
  different exhaustion reason can page on the same head. Pre-upgrade IDs hashed
  `repo#pr@head` without the reason. Those legacy documents are reused only when
  their event and payload reason match; a different reason gets the new ID.
- The scheduled drain is best-effort fire-and-forget work. It must contain its
  own rejections so a drain failure cannot terminate the long-lived watcher
  daemon through Node's unhandled-rejection policy.
- Each pending item is isolated. A malformed `pending/*.json` file is moved to
  `quarantine/`, health is marked not ready, and the drainer continues with the
  remaining sorted pending files. A parseable document whose ID is unsafe or
  does not exactly match its own filename is malformed: the drainer quarantines
  that source file before deriving any transition path, so it cannot rename or
  overwrite a neighboring alert.
- Stale inflight recovery uses the same quarantine behavior for unreadable
  `inflight/*.json` files before recovering later stale alerts. Recovery first
  checks for a matching terminal archive and cleans up the stale inflight copy
  instead of resurrecting it. State transitions rewrite the authoritative
  inflight record and rename it atomically into its destination, so a crash
  before the rename can be completed safely on the next sweep.
- The watcher invokes a drain sweep at startup and every poll, so durable work
  survives a process restart even when no new alert arrives. The scheduled
  retry loop continues between polls while pending work exists.
- ALERTTIMEOUT-01: the canonical delivery child uses the shared load-aware
  helper on its nominal 35-second budget exactly once per spawn, with a fixed
  five-minute ceiling and Node's `2^31 - 1` ms platform timer bound. Timeout
  errors report the effective budget and carry `ETIMEDOUT` for retry classification.
- Transient transport failures (including timeouts, unknown nonzero script
  exits, HTTP 408/409/425/429 and 5xx) retry with exponential backoff, starting
  at five seconds and capped at sixty seconds by default, and move to
  `dead-letter/` after `ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS` (default 8).
  Permanent errors (other HTTP 4xx, bad request, unknown/unsupported sink,
  invalid URL or recipient) dead-letter immediately.
- A dead-lettered SEV1 creates one `lastSev1DeliveryFailure` health signal
  naming its original event and PR. Every subsequent watcher heartbeat carries
  that record as `alert_delivery_failure`, read from the durable local health
  file independently of the notification transport. The latest record persists
  across polls, unrelated deliveries and watcher restarts; a later SEV1 failure
  replaces it. Its `alertId` identifies the signal for watchdog deduplication.
  This is historical failure evidence, not a new alert queued on the failing
  bus. Terminal dead letters are never automatically replayed.
  `readAlertSinkHealth()` stays not-ready until an operator resolves the dead
  letter. The external heartbeat consumer can observe the failed delivery
  without depending on a successful notification send.
- Quarantine is intentionally operator-visible. A non-empty quarantine directory
  keeps `readAlertSinkHealth().ready` false even when no pending alerts remain.
  Its returned `quarantineEventCounts` diagnostic samples the first 1,000 sorted
  JSON filenames using the injected filesystem, with at most 20 event classes
  plus an overflow bucket and sorted event keys. Empty quarantine skips document
  reads. The last sink's breakdown is cached in memory until its quarantine
  count or filesystem reader changes; empty quarantine clears the cache. Editing
  or replacing files without changing the count can leave this diagnostic stale
  until restart or a count change; live lane counts and ownership/readability
  checks still run on every health read. Quarantined documents are never replayed.
- Sink health resolves only the principal-owned state root; it does not require
  `ALERT_TO`. A missing recipient can therefore never hide already-owed work
  from the watcher health log or an operator probe.
- Queue-time configuration requires `ALERT_TO` and persists the complete
  destination under `doc.delivery`. Drain-time transport resolution does not
  consult current `ALERT_TO`; already-owed work continues to its persisted
  recipient after a restart or recipient-env regression.
- Each drain sweep removes `delivered/` documents and `receipts/` older than
  `ADVERSARIAL_ALERT_DELIVERY_ARCHIVE_RETENTION_DAYS` (default 30). Health never
  scans the delivered archive, so its cost is bounded by the live queue lanes.
- The default URL is host-reachable `http://127.0.0.1:18799/hooks/wake`; container
  deployments must set the canonical config/env URL explicitly.
- `/hooks/wake` receives the exact body pinned in
  `test/alert-delivery.test.mjs`, including `mode: now`, `wakeMode: now`,
  `deliver: true`, the configured destination fields, and
  `metadata.alertId`. Because stale-inflight recovery is at-least-once, the
  receiver must deduplicate on `metadata.alertId`; a crash after receiver
  acceptance but before the delivered rename can otherwise produce one
  duplicate operator page.
- The state root is principal-owned. Before creating a missing sink, the writer
  verifies the nearest existing parent against its effective UID; it then
  verifies the new sink and every existing/created lane directory. Health also
  verifies ownership and actual readability of each live lane. Wrong-owner,
  non-directory, `EACCES`, `EPERM`, and other read failures are degraded health,
  never empty healthy queues. This refuses cross-user writes before they can
  leave wrong-UID subdirectories behind and prevents shared-root WAL/rename
  ownership races. Different worker UIDs get distinct default roots under their
  own home directories.

An unreadable or corrupt legacy recovery receipt is retained conservatively for deduplication and logged; it does not prevent enqueue through a thrown read error.
