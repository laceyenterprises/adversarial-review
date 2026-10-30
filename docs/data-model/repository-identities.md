# Repository identity and rename continuity

**Owner:** watcher discovery, reviewer settlement, follow-up and AMA state owners  
**Stores:** `data/reviews.db`, `data/repository-names.json`,
`data/repository-renames/`, service-owned files under `data/` and the configured
reviewer state directory  
**Source of truth:** `src/repository-identity.mjs`, `src/repository-state-files.mjs`,
`src/repository-state-lock.mjs`, `src/repository-names.mjs`

## Identity and durable records

`repository_identities` maps GitHub's positive numeric `repository_id` (decimal
text, primary key) to `node_id`, unique case-insensitive `full_name` and
`observed_at`. `repository_name_history` retains `(repository_id, full_name)`
and its observation time. The ordinary organization listing backfills these
records without another API request. An authoritative PR `base.repo` also
provides identity, including responses obtained through GitHub redirects.
Names alone never establish a rename. Missing or conflicting IDs refuse intake.

`repository_rename_audit` records `operation_id` (primary key), `repository_id`,
`old_name`, `new_name`, `at` and `rows_json` (changed row counts per table).
Secondary database participants record the same operation ID in their own
audit table. The main transaction changes the recorded current name last.
Repeated observations of that current name are no-ops.

`repository-names.json` is an atomically published projection for workers that
retain old arguments. An active current name belongs to its current ID; a
reused historical name never redirects the new repository to its former owner.
Ambiguous historical ownership refuses resolution. Opaque job, launch, pass,
family, entry, session and lease IDs remain stable.

## Transaction and recovery

Each asynchronous state owner holds its own shared `data/.repository-state.lock`
flock through settlement, including detached posted-review work and reviewer
subprocesses. Closer and merge lease mutations also take that fence before
their existing mutation locks. A rename takes the exclusive fence and existing
follow-up job lock. Lock contention defers discovery; no cycle sees partial
state. An authoritative payload discovered during a cycle saves
`repository-renames/observation.json` and aborts intake for boundary recovery.

Before changing files, SQL savepoints and file collision checks preflight the
operation. `repository-renames/pending.json` then records the old/new identity,
timestamp, operation ID, database participants and file before/after digests.
Files replay only from their recorded before or after image. Each database
uses one immediate transaction. The marker fences every later state owner until
all participants commit and the name projection is published. Interrupted
replay recognizes committed participant audits and already moved files.
Unexpected edits, occupied destinations, symlinks and live SQLite WALs refuse
recovery rather than overwrite evidence. Recovery must use the same state roots.

The structured console audit is emitted only for a newly committed main
transaction. A crash between commit and log delivery can lose that console
line; the durable audit remains authoritative and replay never duplicates it.

## Audited storage surfaces

SQL discovery enumerates the installed schema, including lazy tables, and
rewrites repository columns (`repo`, `repository`, `target_repo`, `legacy_repo`),
typed subject/family/idempotency/event keys, canonical PR URL identities and
structured `*_json` identities.
Non-code domains retain their independent identities.

| Surface | Continuity |
| --- | --- |
| `reviewed_prs`, `reviewer_passes`, `review_failure_archive`, `ham_finding_disputes`, `review_latency_events`, `pr_merge_closeouts` | Repository and typed subject keys move; review/pass IDs, attempts, heads and terminal states remain. |
| `review_findings`, replies, remediations, disputes; finding backlog, batches and notes | Repo-bearing rows/JSON move; foreign keys and opaque finding/batch IDs remain. |
| `comment_deliveries` | Typed and legacy keys move together; delivery IDs and posted evidence remain. |
| Duplicate families/candidates, review-cycle verdicts/counters, TTM flag events/state, owner state/stuck pages, operator hold releases, nonempty PR heads | Repo/subject keys and structured identities move without resetting counters or clocks. |
| Finalization ledger, shadow, executor leases and queue lane/entry/event/operation/handoff/clean-review/check-page/merge-receipt/delivery/route/legacy-writer/route-return tables | Lookups, nested identities, handoff digests and acknowledgement references move together; signed evidence stays byte-equivalent as values. |
| `data/ham-primary-change-refusals.db` | One separate audited transaction rekeys `refusals`; budgets remain consumed. |
| Per-subject closure-wait/refresh and orphan databases | Their repo/PR digest filenames move; head-based tables (`waits_by_class`, `refresh_cycle`, `decision_mismatch_cycle`, `heads`, `ownership`, `transition_pages`) retain their rows. |
| Schema migrations, DB canary and reviewer rate-limit snapshots | No repository key; unchanged. |
| Repository identity/history/audit tables | Updated explicitly; historical names and completed audits are retained. |

File discovery handles JSON/JSONL identities, exact embedded state-file
references, encoded repo prefixes and known identity digests. This includes
closer/merge leases, waiters/history/attempts, remediation/dispatch intents,
hammer counters/holds/wakes, duplicate-family evidence, reviewer run/spawn
records, comment claims, primary-change caches, gate observations, attestation
outboxes and diagnostics. Job filenames that are also job IDs remain stable;
job readers search historical prefixes and validate the parsed repository.
New CI reservation records include their unhashed identity. Older digest-only
CI budgets resolve their exact historical key on access before another action
can be reserved.

Disposable repo observation maps/sets are invalidated when the identity
projection changes. Queued hammer callbacks and watcher review candidates
refill from migrated durable state; active promises keep their shared fence.
Per-poll caches are discarded with their poll; process/session/model caches
have no repo ownership to rekey.

API caches, Git/workspace trees, human prose, nonidentity URLs and signed
attestations are not rewritten. Service-owned local attestation lookup keys move; signatures do
not change. HQ Control Plane attestation subjects, dispatch authority and HQ
receipt stores are outside this repository: **REPORENAME-02** owns that side.
Local continuity never substitutes for a valid authoritative attestation.

See [the operator procedure](../review-pipeline-health.md#repository-renames-reporename-01)
and offline acceptance in `test/repository-identity.test.mjs` and
`test/watcher-claim-loop.test.mjs`.

## Final-review hardening

Migration enumerates the explicit `STATE_DIRECTORIES` allowlist in
`src/repository-state-files.mjs`, plus the explicitly configured reviewer state
store. Workspace trees (including `*.trash` and directories containing `.git`),
API logs and append-only telemetry such as `handoff-events` are outside the
journal and retain historical names. Exact recipe delimiters and parsed record
ownership protect sibling repository names. New control-state stores must be
registered in that allowlist.

Unchanged identity observations perform no database transaction or names-file
rewrite. Name lookups cache the projection by device/inode, nanosecond
timestamps and size; equal-sized atomic publication invalidates the cache.
Follow-up job roots are normalized before selecting the shared fence.

A reviewer encountering a pending rename exits 78 with the owned
`[repository-state-busy]` marker. The direct adapter classifies that distinct
refusal and settlement releases its claim without charging a review attempt.
Canonicalization errors are separate from malformed JSON diagnostics.

Discovery processes chained renames in destination-vacating order. A conflicting
repository is quarantined and paged with a stable deduplication key; unrelated
repositories continue at the ordinary refresh cadence. An interrupted journal
still keeps the shared fence until replay completes. A deleted/recreated name
with a different ID remains quarantined rather than reassigning the old
repository's string-keyed PR state to the new owner. This deliberate operator
gate preserves old evidence; retiring the identity row alone is insufficient.

Legacy merge-attempt containers inherit ownership only from their exact holder,
waiter or history family. A nonempty legacy attempt store with no provable owner
refuses migration before a journal is published, preserving its consumed budget.
