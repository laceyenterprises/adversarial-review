# Data Model - Alert Delivery State

**Owner:** adversarial-review alert delivery
**Store:** `~/.config/adversarial-review/data/alert-delivery/` by default, or the
principal-owned `ADVERSARIAL_ALERT_DELIVERY_ROOT` /
`AGENT_OS_ALERT_DELIVERY_STATE_DIR` owner-root override. Overrides name the
parent root; the sink appends `data/alert-delivery/`. A path already ending in
`data/alert-delivery/` is accepted as the final sink path for compatibility.
**Source of truth:** `src/alert-delivery.mjs`
**Runtime surface:** `src/alert-delivery.mjs`, `src/health-probe.mjs`, `src/watcher.mjs`

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
| `pending/*.json` | Alert document | Durable work waiting for delivery or retry. Drainers process sorted files up to their item cap. |
| `inflight/*.json` | Alert document | Claimed work being posted to the notification bus. Stale inflight files are recovered back to `pending/`. |
| `delivered/*.json` | Alert document with `deliveredAt` | Successful delivery archive, retained for 30 days by default. |
| `quarantine/*.json` | Original unreadable file bytes | Files that cannot be parsed or read during pending drain or inflight recovery. Quarantining is fail-isolating: later alerts continue draining. |
| `dead-letter/*.json` | Alert document with `deadLetteredAt` and `lastError` | Parseable alerts that exhausted the bounded transport-attempt ceiling. Dead letters are terminal and operator-actionable; they are not retried silently forever. |
| `receipts/*.json` | Receipt document | Append-style audit receipts for queued, failed, and delivered phases, retained for 30 days by default. |
| `health.json` | Health snapshot | Last observed delivery health and live queue counters for probes and operators. |

## Health Snapshot

`health.json` records operator-facing state:

| Field | Shape | Contract |
|---|---|---|
| `ready` | boolean | `true` only when live pending, inflight, quarantine, and dead-letter counts are all zero. |
| `pendingCount` | number | Live count of `pending/*.json`; recomputed by `readAlertSinkHealth`. |
| `quarantineCount` | number | Live count of `quarantine/*.json`; recomputed by `readAlertSinkHealth`. |
| `deadLetterCount` | number | Live count of `dead-letter/*.json`; non-zero is an operator-pageable delivery failure. |
| `lastQueuedAt` / `lastDeliveredAt` / `lastFailureAt` | string or null | ISO-8601 timestamps for the latest queue, delivery, and failure observations. |
| `lastFailureReason` | string or null | Last transport or quarantine reason while the sink is not ready. |
| `lastQueuedEvent` | string or null | Event name from the latest queued alert, when present. |
| `lastQuarantinedAt` | string or null | ISO-8601 timestamp for the latest quarantine. |
| `lastQuarantinedFile` | string or null | Basename of the latest quarantined file. |
| `lastDeadLetteredAt` / `lastDeadLetteredFile` | string or null | Timestamp and basename for the latest alert that exhausted its attempt ceiling. |

## Operational Contract

- `deliverAlert` is enqueue-first: once the pending document and queued receipt
  are durable, callers receive `{ status: "queued" }`. Callers intentionally
  treat that durable enqueue as terminal for their own debounce; transport
  delivery authority belongs to the sink health/receipt state.
- The scheduled drain is best-effort fire-and-forget work. It must contain its
  own rejections so a drain failure cannot terminate the long-lived watcher
  daemon through Node's unhandled-rejection policy.
- Each pending item is isolated. A malformed `pending/*.json` file is moved to
  `quarantine/`, health is marked not ready, and the drainer continues with the
  remaining sorted pending files.
- Stale inflight recovery uses the same quarantine behavior for unreadable
  `inflight/*.json` files before recovering later stale alerts. Recovery first
  checks for a matching terminal archive and cleans up the stale inflight copy
  instead of resurrecting it. State transitions rewrite the authoritative
  inflight record and rename it atomically into its destination, so a crash
  before the rename can be completed safely on the next sweep.
- The watcher invokes a drain sweep at startup and every poll, so durable work
  survives a process restart even when no new alert arrives. The scheduled
  retry loop continues between polls while pending work exists.
- Parseable transport failures retry with bounded backoff and move to
  `dead-letter/` after `ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS` (default 8).
  `readAlertSinkHealth()` stays not-ready until an operator resolves the dead
  letter; this is the escalation path for permanent 401, bad URL, or similar
  delivery failures.
- Quarantine is intentionally operator-visible. A non-empty quarantine directory
  keeps `readAlertSinkHealth().ready` false even when no pending alerts remain.
- Sink health resolves only the principal-owned state root; it does not require
  `ALERT_TO`. A missing recipient can therefore never hide already-owed work
  from the watcher health log or an operator probe.
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
  verifies the new sink before creating queue children. This refuses cross-user
  writes before they can leave wrong-UID subdirectories behind and prevents
  shared-root WAL/rename ownership races. Different worker UIDs get distinct
  default roots under their own home directories.
