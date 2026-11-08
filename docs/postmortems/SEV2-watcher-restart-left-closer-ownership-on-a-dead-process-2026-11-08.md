# SEV2 — watcher restart left closer ownership on a dead process

Date: 2026-11-08. Ticket: DEADWATCHERLEASE-01. Severity: SEV2, closure availability.
Status: source correction and synthetic regression coverage; deployed recovery
observation remains pending normal deployment.

scars: merge.finding-remediation-and-authoritative-terminal

## Impact and timeline

A closer-authored head remained open with green CI after its preceding hammer
ended while CI was pending. Following a routine watcher restart, each discovery
pass reported an expired closure-recovery deadline and an `in-flight:<pid>`
route belonging to the replaced watcher. The process no longer existed.
Pre-receipt reconciliation reported `inspection-required`. The PR waited about
two hours and closed after manual intervention. No unsafe merge was reported.
All repository fixtures and examples are synthetic.

## Cause and investigation

Durable pending ownership can outlive the process that acquired it. Treating a
recorded PID as sufficient ownership prevents normal closer recovery after a
restart; treating any present PID as the same process also permits PID reuse
to preserve a stale claim.

At the source baseline investigated for this ticket, shared abandonment,
startup/periodic sweeps, intent proof and reclaim locks already existed.
The pending predicate checked timeout before liveness, could abandon a live
owner after expiry, and had only started-after-acquisition evidence for PID
reuse. Leases lacked an exact process start identity. The interrupted-submission
probe could obtain that identity from the intent, but not from the lease.
The periodic ticker also converted its absent initial timestamp (`null`) to
zero, causing a duplicate sweep on the first poll instead of waiting its interval.

The supplied `inspection-required` evidence alone does not prove that no
submission occurred. A dead watcher can leave a surviving submitter or an
accepted launch. Releasing that fence without receipt or absence proof would
risk duplicate closers.

## Correction and boundaries

Local acquisitions now persist optional `watcherStartedAt`. Shared abandonment
checks liveness first and compares exact start identity, including mismatches
where both processes predate acquisition. Legacy leases retain their prior
started-after-acquisition proof. Confirmed live owners survive expiry.
Interrupted-submission probing can use the lease identity when the intent lacks
one, while preserving submitter, keyed process and ledger evidence requirements.
Orphan ownership also checks local identity before accepting a pending owner.

Abandonment retains the dispatch-intent fence and expected-snapshot transition
under `.reclaim.lock`. Its audit names the owner PID, start identity, head and
outcome. Ordinary terminal reclamation and exclusive acquisition admit the next
eligible closer on that pass. The ticker now initializes an absent timestamp to
its construction time, so the existing startup sweep runs once before periodic
sweeps. Each inspected prior claim records `ama_closer.startup_claim_observed`,
including retained claims. Deadlines and retry budgets are unchanged.

Live launches, unresolved submissions, review handoffs, authoritative merged or
closed PR state, required checks and finding remediation retain their authority.
No new check, label, config key, service action or live recovery is introduced.

## Validation and recovery observation

Scoped offline fixtures cover expired dead and live pending owners, exact
start mismatch before acquisition, capture failure, same-pass terminal reclaim
and acquisition, startup sweep timing, owner audit evidence and interrupted
submission identity fallback. Existing raced-receipt and unresolved-intent
fixtures remain part of the touched lease suite. The four touched suites pass
235 tests, run individually with the required network guard and 600-second
process-group bounds. Repository lint has zero errors (existing warnings
remain), and contract typechecking passes. The reaper suite imports the existing
synthetic load fixture for deterministic direct execution.

After normal deployment, the runtime owner can observe a naturally stale claim
recording `ama_closer.abandoned_lease_reclaimed`, then ordinary closer admission
on the eligible head. An unresolved submission still requires its existing
receipt/absence reconciliation. No restart, forced dispatch or state mutation
was performed for this source change.
