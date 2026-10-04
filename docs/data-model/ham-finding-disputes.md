# Data Model - HAM Finding Disputes

**Owner:** AMA bounded finding disputes and reviewer context provenance
**Store:** `data/reviews.db`, table `ham_finding_disputes`
**Source of truth:** `src/review-state.mjs` (`ensureReviewStateSchema`)
**Runtime surface:** `src/ama/finding-dispute.mjs`, `src/ama/finding-dispute-context.mjs`, `bin/dispute-finding.mjs`, `src/prompt-context.mjs`, `src/reviewer.mjs`

## Schema

The composite primary key is `(repo, pr_number, identity)`. `repo` is text,
`pr_number` is an integer, and `identity` is the SHA-256 of the JSON pair
`[finding.title, finding.file]`, preserving per-finding accounting across heads.

| Column | Type | Contract |
|---|---|---|
| `requests` | INTEGER, default 0 | Reserved requests; at most two per identity and bounded by the configured PR-wide review cap. |
| `refusals` | INTEGER, default 0 | Non-pending, non-in-flight review CAS refusals; two prevent further requests. |
| `paged` | INTEGER, default 0 | One exhaustion delivery attempt per PR lifetime, guarded across all identities. Later heads do not reset it. |
| `head_sha` | TEXT, nullable | Exact live head for the latest helper-posted comment for this identity. |
| `comment_id` | TEXT, nullable | GitHub comment node ID returned by the successful helper post. |
| `comment_author` | TEXT, nullable | Trusted HAM login returned by GitHub for that post. |
| `comment_sha256` | TEXT, nullable | SHA-256 of the exact posted UTF-8 body. |

## Reservation and prompt trust

The helper validates an authoritative blocking review, live head and evidence
bound of 16,000 UTF-8 bytes. An immediate transaction reserves a request before
posting. Failed posts, head rechecks and thrown review requests refund that
reservation; those comments cannot enter dispute context. Successful post
provenance is recorded before `requestReviewRereview` so an immediately claimed
review sees it. Structured CAS refusals count toward the refusal budget.
The latest comment replaces prior provenance for that identity.

The reviewer reads this table without writes, scoped by `(repo, PR, head)`.
Only comments matching the recorded node ID, trusted HAM author and body digest
enter dispute context. REST `[bot]` and GraphQL bare app slugs are equivalent.
Missing, legacy or unreadable stores contribute no trusted context. Comments
remain untrusted evidence and never grant merge authority.

Exhaustion atomically sets `paged` before emitting
`ama_finding_dispute_exhausted` and attempting a SEV1 page. It records the
attempt, not delivery acknowledgment; failed delivery is not automatically retried.

## Retention and migration

AMA owns these rows; no automatic pruning exists. Keep open-PR budget/page
records across restarts and head changes. Closed-PR archival is an operator
maintenance action, not a budget reset. `ensureReviewStateSchema` creates the
table and adds nullable provenance columns to legacy helper-created tables,
preserving existing request/refusal/page counts. Legacy rows without provenance
cannot authorize prompt context.
