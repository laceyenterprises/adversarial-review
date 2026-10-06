# Data Model - Review Failure Records

**Owner:** watcher review retry exhaustion
**Store:** `data/review-failure-decisions/`
**Source of truth:** `src/review-retry-exhaustion.mjs`
**Runtime surface:** `src/adversarial-gate-status.mjs`, `src/alert-delivery.mjs`

## Purpose and key

An informational record identifies an exhausted review head for operator
inspection. The filename is `<sha256(JSON.stringify([repo, prNumber, headSha]))>.json`.
The gate appends the record ID to terminal failure descriptions only when
`updatedAt` is at or after the row's current `failed_at`; missing or invalid
timestamps omit the ID. Failure-class reason codes remain intact, and an older
record does not describe a later same-head attempt as parked. This record does not consume
operator choices, resolve a failure, or authorize merge. Operators act through
existing retrigger, risk approval, and hold/closure controls.

## Fields

| Field | Shape | Contract |
|---|---|---|
| `id` | string | `review-failure-` plus the first 20 hex characters of the filename hash. Stable per head. |
| `repo`, `prNumber`, `headSha` | string, integer, string | Exact repository, PR number and failed head used in the key. |
| `reason` | string | Latest exhaustion reason. Refreshed on parking. |
| `kind` | string | `informational`; there is no resolution consumer. |
| `seriesId` | UUID string | Reused while the matching no-progress lane persists; regenerated after the lane is cleared or replaced. Alert outbox dedupe uses this plus `id`. |
| `createdAt` | ISO-8601 string | First record creation, preserved on refresh. |
| `updatedAt` | ISO-8601 string | Latest parking observation. |

## Persistence and retention

Parking atomically writes the current record before paging. Persistence is
best-effort: on a write failure the computed record ID still accompanies the
page, with no deterministic series identity. The lane's existing debounce
remains authoritative. The legacy `review-retry-cap-exhausted` fingerprint is
preserved so already-parked heads do not re-page merely on deployment.

Earlier records may contain `status: pending`, `question`, `options`, and
`recommended`. These had no consumer and are replaced by the informational
shape when next parked. No operator decision is inferred from those fields.

There is no automatic retention sweeper. The watcher operator owns archival
and cleanup after the PR is closed and its failure evidence is no longer
needed; retain open-PR records for audit and gate-description continuity.
