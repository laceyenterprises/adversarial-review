# SEV2 — interrupted closer dispatch could not adopt its own empty-ticket receipt

Date: 2026-11-08. Ticket: PRERECEIPTADOPT-01. Severity: SEV2, closure availability.
Status: source correction and offline regression coverage; production recovery
has not been observed for this change.

scars: merge.finding-remediation-and-authoritative-terminal

## Impact and sequence

The supplied incident evidence describes two indefinitely blocked closer lanes
following one watcher restart. One PR carried a SEV1 correction; another gated
nine build-pack steps. Bounded closure waits eventually requested operator
attention rather than admitting another closer. No unsafe merge was reported.
Repository examples and test identities are synthetic.

1. A deployment replaced a watcher during a closer's `submitting` phase, before
   the local record persisted a launch ID.
2. The launch service had accepted exactly one launch carrying that intent's
   idempotency key. It later succeeded as a process and ended without a merge
   for a separate machinery reason.
3. Exact-key lookup returned that launch with matching repository/head metadata
   and `ticket_ref: null`.
4. Reconciliation rejected the row as `receipt-identity-ambiguous`, recorded one
   query row, and retained the unreceipted intent.
5. The pending lease still named the dead watcher and had no launch ID. The
   unresolved-intent fence prevented abandonment. Subsequent passes returned an
   `in-flight` refusal; the operator tool could neither recover the receipt nor
   prove launch absence.

## Cause

Receipt matching required the exact closer ticket even when a unique,
intent-specific dispatch key positively identified the accepted closer launch.
The row therefore supplied neither accepted receipt identity nor absence proof.
Caller death cannot safely stand in for absence: a surviving submission may
already have created a launch.

The current baseline already invokes native intent reconciliation before the
watcher's ownership wait, including dead pending owners. That path could not
reach ordinary terminal settlement while receipt adoption failed. The operator
path additionally refused all matching receipts as `closer-receipt-exists`.

## Correction

Exact-key reconciliation now accepts one recognized closer launch whose ticket
is expected or absent/null/empty, retaining the repository/head checks when
present. Non-empty foreign tickets, ambiguous identity, multiple rows, another
key and missing/other worker classes cannot authorize adoption. Generic dispatch
output and retry matching still require their exact closer ticket.

After canonical receipt persistence and lease promotion, terminal recovery
releases the intent lock and invokes the existing terminal observer. Retry
traversal, merge proof, success grace and auto-merge holds remain authoritative.
A successful process exit alone cannot produce a successful merge outcome.
Conclusive no-merge settlement permits normal watcher admission in the same
pass, including rekeyed leases. Exclusive acquisition still admits one owner.

The operator tool can preview the same terminal receipt recovery. Apply audits
authorization before mutation and records `settled-terminal-receipt` only after
the matching lease becomes terminal. Live receipts remain held; unavailable
terminal evidence reports settlement pending.

## Projection follow-up and evidence boundary

The upstream reason for the null ticket remains unproven. The supplied incident
records the null value at the app-contract boundary; it does not identify which
producer identity source was missing.

In this repository, `readLaunchRequestByIdempotencyKeyAsync` in
`src/session-ledger-read-adapter.mjs` selects the dispatch key.
`checked` in `src/dispatch-read-client.mjs` returns `result.items` unchanged.
The pinned SDK's `AgentOsSession.dispatchLookup` sends the selector to
`/v1/dispatch/lookup`; this repository does not implement that server projection.
An offline SDK-boundary regression returns a null ticket and verifies recovery.

Follow-up for Agent OS: inspect the server's exact-key lookup projection and its
canonical ticket/lineage/claim sources for an accepted closer launch; preserve
the expected closer ticket when available, while retaining genuine identity
ambiguity. No companion repository was provisioned or modified. The consumer
matcher is limited to the rules above.

## Validation and recovery boundary

Both touched suites ran individually under the requested network guard and
600-second process-group timeout:

- `node --test test/ama-pre-receipt-intent.test.mjs`: 148 pass, 29 fail; all
  21 ticket regressions pass. The same 29 failures reproduce on unmodified
  current `origin/main` (127 pass, 29 fail), with no new failing test names.
- `node --test test/ama-hammer-background-dispatch.test.mjs`: 148 pass.
- Repository lint: zero errors, existing warnings. Contract typecheck: pass.

Coverage includes empty tickets, foreign tickets, multiple rows, identity and
worker-class mismatches, the SDK boundary, terminal success without merge,
live retries, watcher admission on original/rekeyed heads, dry-run preservation,
operator audit failure and unavailable terminal evidence. The baseline failures
are existing process-probe fixtures; they were not repaired in this ticket.

No live lease or dispatch record was changed, and no service restart, forced
dispatch or deployment was performed. After normal deployment, the runtime
owner can observe natural receipt recovery, a terminal lease outcome and normal
eligible closer admission. This PR claims source-level recovery coverage only.
