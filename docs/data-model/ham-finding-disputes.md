# Data Model - HAM Finding Disputes

**Owner:** AMA bounded finding disputes and reviewer context provenance
**Store:** `data/reviews.db`, table `ham_finding_disputes`
**Source of truth:** `src/review-state.mjs` (`ensureReviewStateSchema`)
**Runtime surface:** `src/ama/finding-dispute.mjs`, `src/ama/finding-dispute-owner.mjs`, `src/ama/finding-dispute-context.mjs`, `bin/dispute-finding.mjs`, `src/prompt-context.mjs`, `src/reviewer.mjs`, `src/reviewer-prompt.mjs`

## Schema

The composite primary key is `(repo, pr_number, identity)`. `repo` is text,
`pr_number` is an integer, and `identity` is the SHA-256 of the JSON pair
`[finding.title, finding.file]`, preserving per-finding accounting across heads.

| Column | Type | Contract |
|---|---|---|
| `reserved_at` | TEXT, nullable | ISO UTC timestamp of an in-flight reservation; stale after five minutes. |
| `requests` | INTEGER, default 0 | Reserved requests; at most two per identity and bounded by the configured PR-wide review cap. |
| `refusals` | INTEGER, default 0 | Non-pending, non-in-flight review CAS refusals; two prevent further requests. |
| `paged` | INTEGER, default 0 | 0 = unclaimed; 1 = uncertain enqueue; 2 = durable enqueue confirmed. PR-wide deterministic alert identity prevents duplicate pages across restarts. |
| `head_sha` | TEXT, nullable | Exact live head for the latest helper-posted comment for this identity. |
| `comment_id` | TEXT, nullable | GitHub comment node ID returned by the successful helper post. |
| `comment_author` | TEXT, nullable | Trusted HAM login returned by GitHub for that post. |
| `comment_sha256` | TEXT, nullable | SHA-256 of the exact posted UTF-8 body. |

## Reservation and prompt trust

Before opening SQLite, the CLI requires effective UID ownership of the existing
database, data directory, any WAL/SHM sidecars and configured pager owner boundary.
It refuses missing databases or cross-user callers before schema writes.
The helper validates the latest submitted authoritative blocking review in the
live head's ancestry, live head and evidence bound of 16,000 UTF-8 bytes. An immediate transaction reserves a request before
posting. Failed posts, head rechecks and thrown review requests refund that
reservation; those comments cannot enter dispute context. Successful post
provenance is recorded before `requestReviewRereview` so an immediately claimed
review sees it. Structured CAS refusals count toward the refusal budget.
Triggered, pending and in-flight requests retain fresh provenance; other structured
refusals restore the prior admission for that identity.

The reviewer reads this table without writes, scoped by `(repo, PR, head)`.
Only comments matching the recorded node ID, trusted HAM author and body digest
enter dispute context. Legacy REST and adapter contexts retain `node_id` alongside
their numeric IDs; either the context ID or its node ID may match the reservation.
String and `{ login }` author forms use the same trusted-login and digest check.
Each reservation contributes its latest comment, bounded to 16,000 UTF-8 bytes
per comment and 256,000 bytes total. REST `[bot]` and GraphQL bare app slugs are equivalent.
Missing, legacy or unreadable stores contribute no trusted context. Comments
remain untrusted evidence and never grant merge authority.

Exhaustion atomically sets `paged` before emitting
`ama_finding_dispute_exhausted` and attempting a SEV1 page. It records the
enqueue claim, not remote delivery acknowledgment. If the pager throws, the
claim is cleared and a later helper invocation can retry. Successful durable
queueing sets the guard to 2; the alert outbox retries delivery.

## Retention and migration

AMA owns these rows; no automatic pruning exists. Keep open-PR budget/page
records across restarts and head changes. Closed-PR archival is an operator
maintenance action, not a budget reset. `ensureReviewStateSchema` creates the
table and adds nullable provenance columns to legacy helper-created tables,
preserving existing request/refusal/page counts. Legacy rows without provenance
cannot authorize prompt context.

A structured re-review refusal restores the previous admitted comment provenance,
except when a review is already pending or in flight. A thrown request also restores it
and refunds the request reservation. Restoration compares the new comment ID
so a concurrent newer admission cannot be overwritten. Refused comments remain
on GitHub but never enter reserved reviewer context.

The CLI exits 78 with `ama_finding_dispute_owner_refused` before opening SQLite
when the daemon owner check fails, and exits 79 with
`ama_finding_dispute_identity_refused` when the posted comment lacks authoritative
HAM provenance; its reservation is refunded and no re-review is admitted.
The hammer preserves evidence and records no-merge
status for canonical-owner handoff; it never changes user or credentials itself.

### Crash recovery

`reserved_at` (nullable TEXT, ISO UTC) marks an in-flight request. After five
minutes, the next invocation refunds a stale reservation before enforcing the
budget. Concurrent live reservations refuse a second caller. Posted provenance
is retained for pending/in-flight reviews so they can read the fresh evidence.
`paged` is 0 before a claim, 1 while enqueue is uncertain, and 2 after durable
enqueue. A restart retries state 1 with the same deterministic outbox identity;
pending, inflight, delivered and dead-letter entries all deduplicate that identity.
