# SEV3 — findings publisher intent stranded without a launch receipt

Date: 2026-11-14. Ticket: PUBLISHINTENTSTRAND-01. Severity: SEV3.
Status: source repair with offline synthetic qualification. Deployment and
organic recovery are not established by this change.

scars: program.worker-dispatch-reliability, merge.finding-remediation-and-authoritative-terminal

## Impact and evidence

The supplied anonymised evidence describes one batch of 32 findings whose
decision launch finished remediation and pushed its branch at 10:53 UTC.
At 11:40 UTC the collector wrote its publication intent, but the keyed launch
ledger retained only the decision row. Two hours later no publisher row existed.
Every collection pass reported `batch-publish-receipt-pending`.

The existing 24-hour stale release requeues the findings with its normal
attempt charge. Findings are not lost, but their finished remediation is
abandoned and they remain open for a day. The evidence also reports 23 healthy
two-row keys over three days and 20 receipt-pending batches in an earlier
backlog sample. The earlier sample establishes recurrence of the symptom,
not proof that all 20 batches had this exact cause.

These observations came from the supplied evidence. This change queried or
mutated no live review database, batch artifacts or launch ledger.

## Sequence and root cause

1. The decision-only launch prepared and pushed the tested remediation.
2. The collector verified its branch/head and keyed launch identity, took
   `publish.lock`, and atomically created `publish-intent.json` before invoking
   the publisher submission.
3. Submission never reached the launch ledger. The intent survived, but contained
   neither a submission time nor the dispatch timeout used.
4. Every later pass found no publisher row and failed the non-overwriting intent
   write with `EEXIST`. That unconditionally meant receipt pending, even beyond
   the bounded dispatch lifetime.
5. The only automatic escape was the existing stale release. It preserved
   findings accounting but forfeited completed preparation.

The pre-submit fence correctly prevents duplicate publishers after an ambiguous
response. Its missing contract was a bounded distinction between a receipt that
could still arrive and a submission proven never enqueued. A local intent alone
is neither a receipt nor proof of absence.

## Correction and preserved safety

New intents record ISO `submittedAt`, the actual load-scaled `dispatchTimeoutMs`,
and `resubmissionCount: 0`. Under the existing lock, the collector can replace
an intent only strictly after its submission deadline plus a default 10-minute
grace, and only with readable keyed evidence containing the decision row,
all rows terminal, no publisher row and the existing remote-head/PR checks.
The grace uses `ADVERSARIAL_FINDINGS_BATCH_PUBLISH_RECEIPT_GRACE_MS`, or
`publishReceiptGraceMs` in runner options.

The replacement preserves branch, ticket and idempotency key, records
`resubmitOf` with the previous time/timeout, and spends `resubmissionCount: 1`
before submission. A crash or another lost response therefore cannot authorize
a third submission. Legacy intents use file mtime when the submission time is
absent and the current dispatch bound when its timeout is absent.

A late publisher row retains existing receipt recovery, including terminal
`batch-publish-ended-without-pr`. Live, unknown, unreadable or mismatched keyed
custody never permits resubmission. A second absence keeps receipt pending until
the unchanged FINDINGSSTUCK-01 stale release, requeue/exhaustion counters and
release audit. No new lifecycle state, SQLite migration, CI gate or merge
authority is introduced.

Sibling checks covered initial decision dispatch retries and the release helper.
Those already distinguish transport failure from terminal evidence and retain
their existing budgets and custody rules; they need no retry-policy change.
The memory search for absent publisher receipts and bounded dispatch recovery
returned no matching records. The supplied contract history and local
FINDINGSSTUCK-01 report supplied the failure-family context.

## Qualification and runtime ownership

Synthetic fixtures exercise the deadline boundary, configurable grace, recorded
timeout, one resubmission, second-absence release accounting, late publisher
receipts, unreadable/live/unknown ledger evidence, legacy mtime, malformed
intent and concurrent collectors. The [change note](../changes/PUBLISHINTENTSTRAND-01.md)
records exact validation results.

After normal deployment, the runtime owner can retain the loaded revision and
observe the next organic collector pass for an eligible batch: one replacement
intent and publisher receipt, then the marked PR through normal review. Keep
that evidence separate from source qualification. This PR performs no runtime
restart, backlog drain, intent reset or live recovery operation.
