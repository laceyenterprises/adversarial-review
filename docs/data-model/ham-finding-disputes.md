# Data Model - HAM Finding Disputes

**Owner:** AMA bounded finding disputes and reviewer context provenance
**Store:** `data/reviews.db`, table `ham_finding_disputes`
**Source of truth:** `src/review-state.mjs` (`ensureReviewStateSchema`)
**Runtime surface:** `src/ama/finding-dispute.mjs`, `src/ama/hammer-adjudication.mjs`, `src/ama/finding-dispute-owner.mjs`, `src/ama/finding-dispute-context.mjs`, `bin/dispute-finding.mjs`, `src/prompt-context.mjs`, `src/reviewer.mjs`, `src/reviewer-prompt.mjs`

## Schema

The composite primary key is `(repo, pr_number, identity)`. `repo` is text,
`pr_number` is an integer, and `identity` is the SHA-256 of the JSON pair
`[finding.title, finding.file]`, preserving per-finding accounting across heads.

| Column | Type | Contract |
|---|---|---|
| `reserved_at` | TEXT, nullable | ISO UTC timestamp of an in-flight reservation; stale after five minutes. |
| `requests` | INTEGER, default 0 | Withdrawal attempts (successful or in flight). Since HAMFINAL-01 no longer budgeted. |
| `refusals` | INTEGER, default 0 | Legacy: re-review CAS refusals from before HAMFINAL-01. No longer written. |
| `paged` | INTEGER, default 0 | Legacy: pre-HAMFINAL-01 exhaustion page guard. No longer written. |
| `head_sha` | TEXT, nullable | Exact live head for the latest helper-posted comment for this identity. |
| `comment_id` | TEXT, nullable | GitHub comment node ID returned by the successful helper post. |
| `comment_author` | TEXT, nullable | Trusted HAM login returned by GitHub for that post. |
| `comment_sha256` | TEXT, nullable | SHA-256 of the exact posted UTF-8 body. |
| `resolution` | TEXT, nullable | `withdrawn-by-hammer` once the hammer's final adjudication is recorded (HAMFINAL-01). |
| `resolved_at` | TEXT, nullable | ISO UTC time the withdrawal was recorded. |
| `finding_reviewed_head` | TEXT, nullable | Head the withdrawn finding's review was submitted on. |
| `evidence_sha256` | TEXT, nullable | SHA-256 of the trimmed evidence, also printed as `Evidence-SHA256` in the comment. |

## Final adjudication (HAMFINAL-01)

Operator decision, 2026-10-10, after agent-os PR 7987: "Hammers judgement is
final". A row with `resolution = 'withdrawn-by-hammer'` and a `comment_id` is a
resolved blocking finding. The gate (`src/adversarial-gate-status.mjs`) and the
watcher closure orchestration read these rows through the read-only, fail-soft
`readHammerWithdrawals` in `src/ama/hammer-adjudication.mjs`. A withdrawal resolves
a finding only when its identity is a blocking finding of the reviewed head's
review and `finding_reviewed_head` (or `head_sha`) equals that head.
`bin/ama-check.mjs` reads the same adjudication from the HAM-authored PR comment
instead, and re-hashes the embedded evidence against `Evidence-SHA256`. The
helper requires a fenced exact-head repro or head-file quote, requests no
re-review, and does not page.

## Reservation and prompt trust

Before opening SQLite, the CLI requires effective UID ownership of the existing
database, data directory, any WAL/SHM sidecars and configured pager owner boundary.
It refuses missing databases or cross-user callers before schema writes.
The helper validates the latest submitted authoritative blocking review in the
live head's ancestry, live head and evidence bound of 16,000 UTF-8 bytes. An immediate transaction reserves a request before
posting. Failed posts, head rechecks and thrown review requests refund that
reservation; those comments cannot enter dispute context. Successful post
provenance and the withdrawal are recorded together after a live head recheck.
A rerun for the same identity and head returns the recorded withdrawal without
posting again.

The reviewer reads this table without writes, scoped by `(repo, PR, head)`.
Only comments matching the recorded node ID, trusted HAM author and body digest
enter dispute context. Legacy REST and adapter contexts retain `node_id` alongside
their numeric IDs; either the context ID or its node ID may match the reservation.
String and `{ login }` author forms use the same trusted-login and digest check.
Each reservation contributes its latest comment, bounded to 16,000 UTF-8 bytes
per comment and 256,000 bytes total. REST `[bot]` and GraphQL bare app slugs are equivalent.
Missing, legacy or unreadable stores contribute no trusted context. Comments
remain untrusted evidence and never grant merge authority.

Before HAMFINAL-01, exhaustion set `paged` and emitted `ama_finding_dispute_exhausted`
with a SEV1 page. Disputes no longer request re-review, so they no longer exhaust
or page.

## Retention and migration

AMA owns these rows; no automatic pruning exists. Keep open-PR withdrawal
records across restarts and head changes. Closed-PR archival is an operator
maintenance action. `ensureReviewStateSchema` creates the
table and adds nullable provenance columns to legacy helper-created tables,
preserving existing request/refusal/page counts. Legacy rows without provenance
cannot authorize prompt context.

A failed withdrawal (post failure, untrusted identity, head race) refunds the
request reservation and records no provenance or resolution. Its comment, if
posted, stays on GitHub but never enters reserved reviewer context.
The HAMFINAL-01 columns are added as nullable to legacy tables; legacy rows have
no `resolution` and resolve nothing.

The CLI exits 78 with `ama_finding_dispute_owner_refused` before opening SQLite
when the daemon owner check fails, and exits 79 with
`ama_finding_dispute_identity_refused` when the posted comment lacks authoritative
HAM provenance; its reservation is refunded and no withdrawal is recorded.
The hammer preserves evidence and records no-merge
status for canonical-owner handoff; it never changes user or credentials itself.

### Crash recovery

`reserved_at` (nullable TEXT, ISO UTC) marks an in-flight request. After five
minutes, the next invocation refunds a stale reservation before enforcing the
reservation. Concurrent live reservations refuse a second caller.
Legacy `paged` state 1 rows are inert; no code path retries them.
