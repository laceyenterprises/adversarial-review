# LAC-2096: closer recovery assumed projected launch identity columns

Severity: SEV3. [Issue and retained operator evidence](https://linear.app/laceyenterprises/issue/LAC-2096).
Source scope is adversarial-review; incident recovery and source selection for
the affected Agent OS PRs belong to the independent rescue owner.

## Evidence and root cause

The issue records the #9059 recovery dry-run failing with `column ticket_ref
does not exist`. The ticket-wide reader selected `ticket_ref` directly from
`launch_requests`. Nearby keyed/status readers probed optional columns, but
substituted null when absent instead of reading canonical launch identity.
The #9100 read-only evidence subsequently returned a real terminal LRQ for its
key with null ticket/head projections. Those nulls did not prove no submission.
A later-head intent naming that LRQ did not establish ownership of the older
attempt. Neither incident intent is changed by this source fix.

The producer schema and writer were inspected through read-only GitHub source
at Agent OS main `5b89a0193a7461a4408081c3790132ce3b08b0a9`:

- `platform/session-ledger/src/session_ledger/migrations/002_launcher_substrate.sql`
  and `docs/data-model/02-worker-pool-and-dispatch.md`: the launch stores JSONB
  request/lineage and target projections; ticket/head are not native columns.
- `modules/worker-pool/lib/python/cwp_dispatch/dispatch.py`, `provenance.py`
  and `launch_request_metadata.py`: request/lineage carry `ticketRef`, logical
  task identity and `launchProvenance.ticketId`, `prHeadSha`, `repoFullName` / `repo`.
- The logical-job claim migration and `worker_logical_jobs.py`: exact LRQ links
  associate claim `ticket_ref` and worker `task_key`; status is independent of
  historical identity. An active logical job must be preserved, never evicted
  or duplicated to repair a reader.

This was reader/schema drift, compounded by fixture coverage that treated
missing columns only as null identity. It did not exercise positive canonical
identity in a production-shaped schema. The operator settlement branch could
also accept an empty keyed read despite an unreadable supplemental ticket read,
or treat a returned unidentified receipt as negative ticket evidence.

## Repair and sibling sweep

The adapter resolves identity from fixed catalog-selected SQL expressions over
the existing launch, claim and worker records. It never dumps a whole launch
row, infers a ticket from a branch/key, introduces a ledger, or migrates the
production database. Conflicting sources remain explicitly ambiguous. Missing
identity on an in-window row blocks ticket-wide absence. Ticket queries include
all repositories, heads and statuses, the exact time boundary and null times.
Status, retry and bounded snapshot readers share canonical identity, preserving
indexed recursive retry traversal and the existing response/time bounds.
Other launch-column assumptions were swept; build-completion `head_sha` belongs
to that distinct table and builder provenance already reads the native payload.
SQLite keyed/status and ticket readers retain their established behavior.

Operator settlement now requires its supplemental ticket proof even when the
key returns zero, and a returned ambiguous receipt cannot be settled through
ticket absence. Existing native valid-key empty-read recovery, lease/intent
replacement comparisons, flock ownership, terminal ambiguity, retry charging,
refunds and inspection deadlines remain authoritative. The dispatch receipt
consumer preserves the ambiguity diagnostic when validating canonical evidence.

## Offline validation and release boundary

`test/session-ledger-retry-postgres.test.mjs` starts an isolated local Postgres
cluster with a SELECT-only reader and no production DSN. The production-shaped
fixture has no launch `ticket_ref` or `head_sha`; positive request, lineage,
work-item provenance, claim and worker identities must find an existing launch.
It covers empty results, conflicting/null identity, different heads/repos,
terminal receipts, time boundaries and unreadable evidence. It calls the real
`bin/settle-legacy-closer-intent.mjs` entrypoint with the real ledger adapter;
only the psql executor maps the synthetic target to the disposable database.
Dry-run/refusal compares intent bytes, leases and retry budgets. Apply is tested
only against disposable local intent/lease/audit records. Existing suites retain
concurrent receipt, replacement fence and budget regressions.

HCP memory searches for both the original symptom and canonical-identity scope
were available and returned no records. Linear shared context was unavailable
(`Tool get_agent_context not found`); local owner schemas and runbooks supplied
context. No config key changed, so the three-loader parity contract is unaffected.
Authoritative PR-terminal guards and finding-remediation merge gates are unchanged.

Normal cross-model review, required checks, merge and deployment must precede
any separately authorized read-only live acceptance. No live queue/DB mutation,
intent settlement, worker cancellation, duplicate launch, service restart,
provider pin or Agent OS workspace change is part of this delivery. Source
publication is not incident recovery acceptance.

The final native Postgres regression run passed 21 tests with no failures or
skips, including the operator entrypoint and indexed retry-plan assertions.
Repository lint and changed-file ESLint autofix checks report zero errors;
kernel contract typechecking and the byte-equivalence research walkthrough
pass. The reviewed lifecycle graph and source-projection check also pass.
The full `npm test` attempt reached its 900-second bound: 12,878 passed,
five failed, 48 cancelled and seven skipped (12,938 reported tests). All five
assertion failures were in untouched `test/derived-artifacts.test.mjs` (four
npm rebuild fixtures and descendant cancellation). Cancellation at the bound
is not a passing result. This source change does not alter those fixtures,
raise their timeouts or weaken publication/merge gates; focused results and
managed publication evidence are reported separately.
The final focused pass of pre-receipt recovery, dispatch priority, ledger readers
and the watcher claim-loop passed all 569 tests, with zero failures,
cancellations or skips. The native 21-test SQL run above is additional evidence.

### Recovery deployment boundaries

Deployment restores the daemon's automatic reconciliation, including legacy absence settlement with its existing retry refund and lease deferral, and exact-key receipt recovery. The prior missing-column failure prevented those paths. Inspect affected intents before activation; an operator dry-run does not pin or freeze subsequent daemon reconciliation. This source change itself performs no live settlement.

Canonical identity and unidentified-row absence guarantees in LAC-2096 apply to PostgreSQL. The legacy SQLite ticket reader requires projected ticket/head columns: a producer-shaped SQLite ledger without them remains fenced/unsupported for ticket-wide recovery; do not interpret its unreadable result as absence. SQLite ledgers with projected columns do not supply the PostgreSQL unidentified-row guarantee.

Before deploying, verify the configured reader can SELECT launch_requests, launch_request_logical_job_claims and worker_runs, with ticket_ref and launch_request_id on claims and task_key and launch_request_id on worker_runs. Missing privileges fail closed; do not omit existing linked evidence to turn a failed grant into an apparent absence. Required CI discovers native PostgreSQL tools through pg_config --bindir or PATH and fails if unavailable. Each payload and lineage document is expanded once per candidate row into small typed identity fields; the legacy whole-table pre-16 text fallback still scales with row count and remains an explicit operational limit.
