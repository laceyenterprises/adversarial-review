# Data Model - Reviewed Attestation Queue

**Owner:** reviewed attestation signing and watcher retry
**Store:** `data/reviewed-attestations/`
**Source of truth:** `src/reviewed-attestation.mjs`
**Runtime surface:** `src/watcher-tick-preflight.mjs`
**Producer:** `src/reviewer.mjs`

## Purpose

`data/reviewed-attestations/` is the durable retry queue for reviewed-head
attestations that could not be signed or recorded after a GitHub review was
already posted. The posted review remains authoritative for the adversarial gate;
this queue preserves attestation recovery without making review dispatch wait on
operator-only cleanup.

## Files

| Path | Shape | Contract |
|---|---|---|
| `pending.jsonl` | One JSON object per queued attestation retry | Active retry queue. Each entry carries a stable `queue_id`, the signed payload inputs under `payload`, failure class, error text, optional error code, optional killed-process marker, enqueue time, and retry breadcrumbs. |
| `pending.jsonl.lock/owner.json` | Lock owner document | Mutual exclusion for queue reads, rewrites, and terminal archiving. Stale locks are removed after the source-defined stale window. |
| `failed.jsonl` | One JSON object per terminal retry failure | Side ledger for queued entries that are known non-retryable, such as `hq attest record` reporting an already-conflicting head attestation. Entries preserve the original payload, last error, optional error code, optional killed-process marker, retry count, `terminal_at`, and `terminal_reason`. |

## Operational Contract

- Queue entries are append-only until a retry pass consumes, refreshes, or
  terminally archives the exact `queue_id`.
- Retry processing preserves entries appended while a retry pass is in flight by
  replacing only the queue IDs it read at the start of the pass.
- Watcher startup and poll preflight cap subprocess-backed retry attempts per
  tick so attestation maintenance cannot starve first-pass or rereview dispatch.
- `hcp-unavailable` and transient subprocess failures stay in `pending.jsonl` for
  later retry. When the transient signal depends on an error code such as `EIO`
  or `ECONNRESET`, or on an exec timeout that killed the child process, retry
  pre-flight classification uses the persisted `last_error_code` and
  `last_error_killed` fields instead of relying on message text alone.
- Non-transient attestation failures are moved to `failed.jsonl` under the same
  queue lock before they are removed from `pending.jsonl`; if terminal archiving
  fails, the pending entry remains available for operator inspection.
- The files contain no secrets. They contain repository, pull request, exact head
  SHA, reviewer identity, verdict metadata, timestamps, and failure text.
