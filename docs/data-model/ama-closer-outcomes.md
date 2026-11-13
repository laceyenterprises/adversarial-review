# AMA closer outcome observations

**Source of truth:** `src/ama/closer-outcomes.mjs` and `src/ama/closer-pass-projection.mjs`

Owner: `src/ama/closer-outcomes.mjs`. Store:
`data/ama-closer-outcomes/YYYY-MM-DD.jsonl`, append-only, mode 0640.
The date is the observation's terminal timestamp in UTC.

Version 1 rows contain `schemaVersion`, `kind`, `repo`, `prNumber`, `headSha`,
`launchRequestId`, `terminalAt`, `launchStatus` and `outcome`. No prompt, error
text, environment, labels, user identity or provider response is copied.
Legacy numeric-string PR numbers are normalized to positive safe integers.
Repository and head SHA strings must contain non-whitespace characters.

`launch-terminal` rows come from durable dispatch receipt writes with
`state=launch-terminal`, a `terminalLaunchStatus`, and a `reconciledAt`.
They establish terminal launch evidence, including a failed or canceled launch
that wrote no AMA audit. Process success does not prove a merge:
`outcome` remains null on these rows.
Operator-hold terminal statuses `operator_triage_required` and
`reaped_stuck_requested` are retained verbatim in `launchStatus`.

`lease-terminal` rows come from successful terminal lease writes with an LRQ.
They are the single authoritative closer-outcome store (QWV-04): the
`reviewer_passes.status` of a closer pass is projected from them by
`src/ama/closer-pass-projection.mjs`, which re-projects the launch's pass row after each
lease-terminal append (see [reviewer passes](reviewer-passes.md)).
They retain the authoritative `terminalOutcome`, including `succeeded`,
`failed-without-merge`, `deferred`, `superseded` and retryable reason codes.
They do not establish process exit: a lease may release while a launch remains
active. Pending leases without an LRQ, parked dispatches and provisional phase
failures produce no rows.
The existing launch-status classifier owns terminality. Parked or unknown
statuses (including a missing launch's `not-found`) are excluded.

Readers join the kinds by globally unique `launchRequestId` across dates and heads,
deduplicate repeated observations, and count only launches with terminal launch
evidence in the requested window. Use the earliest terminal launch observation
time; later reconciliation must not move an old launch into a new window.
Repository spelling is descriptive metadata, not part of the join key: lease
and dispatch writers may use different case or names after a repository rename.

A live retry can rearm the dispatch record under its original launch ID.
These rows describe historical terminal observations, not current liveness:
rearming reopens the dispatch lifecycle without removing earlier journal rows.
For status breakdowns, use the latest `terminalAt` observation's `launchStatus`
for that ID (as of the reporting cutoff); conflicting statuses at the same
timestamp are unknown. The earliest timestamp still anchors its historical
window. The journal emits no reopen event, so a current-terminal denominator
must also check the dispatch record and live retry chain, excluding rearmed
launches while their retries remain active or unreadable.
A missing lease outcome is unknown, never inferred from an exit code.
In particular, `handed-to-review` ends closer custody without terminalizing the
lease: the common hammer path that pushes fixes back to review emits no
`lease-terminal` row for that handoff. Its launch can still emit a
`launch-terminal` row. Report this known no-lease-row case separately when
dispatch/lease evidence is available; the journal alone cannot distinguish it
from missing lease evidence and must retain the unknown outcome.
`succeeded` is affirmative merge evidence; a later observation on another head
cannot erase it. Gate reasons can be correlated with the existing AMA audit's
per-launch attempts. Deferred outcomes retain their separate classification.

The writer appends a small row in one O_APPEND write and flushes it. It creates
the directory only after a missing-path error and retries once. Repeated
receipt writes may append duplicates. The predecessor is also captured before a
same-head dispatch projection is replaced, preserving history across retries.
Predecessor capture is skipped when the new terminal document preserves the
same launch ID, reconciliation timestamp and terminal status; its append already
preserves that observation.
Readers must tolerate a torn trailing row after an interrupted append and
report incomplete evidence instead of assuming healthy counts.

Observation-building and filesystem failures, and rejected terminal candidates,
produce only the fixed local diagnostic
`ama_closer.outcome_record_unavailable`. Closure, cleanup, dispatch and paging
decisions retain their existing behavior. There is no automatic backfill,
migration, retention deletion, daemon restart or policy change.
Reporting history begins at the deployment cutover. Predecessor capture can
incidentally append pre-deployment terminal records when their heads are retried;
this is a biased partial sample, not a historical backfill. Readers must ignore
rows whose `terminalAt` predates the deployment cutover, including rows in
old-dated files, and clip reporting windows to that cutover. The journal does
not record the cutover: consumers must obtain it from deployment evidence.
Missing older history is unavailable.
