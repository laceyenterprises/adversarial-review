# SEV2 — findings batches retained open findings after launch errors

Date: 2026-11-08. Ticket: FINDINGSSTUCK-01. Severity: SEV2, findings
remediation availability. Status: source repair with offline synthetic
qualification; deployment and backlog recovery are not established by this PR.

scars: merge.finding-remediation-and-authoritative-terminal, program.worker-dispatch-reliability

## Impact and evidence

The supplied anonymised snapshot reports 238 open findings, 203 attached to
batches, and nine errored batches neither completed nor released. Examples
include 39 findings in a batch without a launch receipt, 14 in a batch launched
25 hours earlier with an unavailable publication receipt, and one in a batch
whose dispatcher failed repeatedly. Each repeating error appeared 33 times in
the supplied log window. The ticket headline attributes 62 findings to three
stuck batches; the enumerated examples total 54. That difference is unresolved
in the supplied evidence and is not used to infer additional affected findings.
No production DB query or mutation was performed for this change.

## Sequence and cause

1. Claiming a batch attached open findings to its durable batch ID.
2. Preparation or publication failed. The collector retained the error and
   retried on later passes.
3. The release helper returned immediately for every batch without `launch_id`.
   Such batches could not reach the existing release/requeue transaction,
   regardless of age. Failed initial dispatches had no durable submission cap.
4. Publication combined a missing launch receipt and a missing tested head into
   `batch-push-evidence-missing`. An applied artifact encountered without a local
   receipt therefore reported a push error without establishing a launch.
5. Receipt-unavailable cases depended entirely on the keyed launch probe.
   There was no independent lookup of the batch's recorded launch, and failed
   or malformed probes silently held custody indefinitely.

The old helper permits a readable empty keyed result after timeout. Therefore
the 25-hour example alone does not prove that an empty successful result caused
its hold. Synthetic cases distinguish `{ok:true, rows:[]}` from `{ok:false}` and
unreadable rows. The public adapter also returns
`dispatch-read-unavailable / dispatch absence scope unproven` when an empty
reply lacks canonical authorization-scope proof. That envelope reproduces the
silent hold. The production probe envelope was not supplied, so its exact
transport/authorization failure remains unconfirmed.

## Correction and preserved contracts

An errored never-launched batch becomes releasable after the existing timeout,
using its claim day when no launch timestamp exists. Release runs before another
submission can mask that state. Applied artifacts without a local receipt report
`batch-launch-receipt-missing`.

After timeout, readable empty keyed receipts additionally require the recorded
launch's public ledger snapshot, including retries, to establish no live launch.
Known terminal launches or authoritative absence permit release. Unreadable
keyed/direct probes, unknown statuses and unproven absence retain custody and
report `needs-operator`, with batch ID and named reason. Live launches retain
custody. A status-command failure alone is never terminal proof.

The additive, replay-safe migration adds `finding_batches.batch_attempts` for
failed initial dispatch submissions, distinct from each finding's release
counter. Three failures stop further submissions. Terminal/absent keyed evidence
permits `batch-dispatch-attempts-exhausted` release; a live or unreadable launch
still holds. Bounded, redacted stderr preserves the dispatcher's refusal reason.
The per-pass summary reports open findings and stuck batch counts by reason and
oldest age.

Every release uses the existing transaction: open findings requeue with one
attempt charge and audit row, or exhaust at the existing third finding attempt.
No finding is marked applied by a release, and no reviewer correctness grade is
invented. Fresh batches retain fresh attempt-derived identities. Publication
intent, remote head/marked PR evidence, normal pipeline settlement and merge
authority remain authoritative. Legacy drop mapping and per-finding invalid
outcome requeue remain as implemented by FINDINGSREQUEUE-01.

## Qualification and recovery ownership

`test/findingsrequeue-01.test.mjs` uses disposable SQLite, synthetic findings,
injected dispatch/ledger reads and controlled time. It covers timeout boundaries,
never-launched release, missing-receipt diagnosis, terminal/absent/live/unknown
launches and live retries, unreadable evidence, durable submission caps, redacted
stderr, requeue/exhaustion accounting, migration replay and normal pending waits.
The [change note](../changes/FINDINGSSTUCK-01.md) records validation results.
Memory searches for the symptom and receipt/ownership cause returned no records;
the supplied contract history and local runbooks supplied the historical context.

After ordinary deployment, the runtime owner can observe existing collector
passes and retain the loaded build, per-pass summary, release audit counts and
needs-operator reasons. Compare open/unbatched/stranded/retrying/exhausted counts;
release is progress, not proof that remediation finished. Reconcile unreadable
public ledger evidence before any separately authorized recovery. This PR runs
no drain, restart, live dispatch, artifact repair or database edit on merge.
