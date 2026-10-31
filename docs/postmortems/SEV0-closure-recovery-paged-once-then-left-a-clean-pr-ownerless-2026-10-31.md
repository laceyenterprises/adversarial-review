# SEV0: closure recovery paged once, then left a clean PR ownerless

Date: 2026-10-31  
Ticket: RECOVERYSTALL-01  
Severity: SEV0, within the declared old-PR closure incident  
scars: program.worker-dispatch-reliability — recovery must reconcile durable launch custody and report actual ownership rather than treating a background scheduling indication as a live worker.

## Impact and evidence

A clean, green PR remained open for more than twelve hours. Successive passes
alternated an ownership-unresolved closure blocker, whose deadline was already
about twelve hours overdue, and a background-dispatch indication. No new closer
launch existed. Earlier closer launches had completed hours before.

This report describes the failure generically. All regression identities,
repository names, PR numbers, heads and launch records are synthetic.

## Cause

R04 correctly refused speculative dispatch when lease or launch/retry custody
could not be read. Recovery delegated reconciliation to closer admission.
Receipt-driven reconciliation could miss a terminal lease's launch when no
dispatch receipt survived, leaving the adopted unreadable snapshot unchanged.
The deadline executor then reserved a permanent, once-only closure-wait page.
There was no deadline-specific refresh of both custody observations and no
periodic reminder. A page could also be suppressed by the delivery budget.
Background execution indicated an attempted reconciliation, not closer ownership.

The safety refusal was appropriate during uncertainty. The liveness failure was
allowing unresolved recovery and its exhausted alert receipt to persist forever.

## Repair

After the anchored deadline, every R04 execution re-reads the exact-head lease
and referenced launch with retry descendants, including terminal leases without
receipts. Lease replacement during the read invalidates the evidence. Terminal
custody and expired ownerless leases return to normal next-action admission.
The existing per-PR intent lock encloses retirement, exclusive reacquisition
and replacement submission. The terminal retirement audit event names
`terminal-custody-confirmed`; ordinary retry budgets still apply.

Unreachable or partial ledger evidence retains the ownership fence. The
closure-wait receipt now supports six-hour reminders with durable reservation
timestamps, separate delivery deduplication keys and failed-delivery refunds.
Deadline, attempt count and last evidence persist in the existing wait database
and appear in closure status and unresolved blocker details.

No merge predicate, exact-head requirement, required-check rule, strict-mode
rule or sticky-success protection changes. No CI check or live rescue is added.

## Regression evidence and deployment receipt

Offline tests exercise actual closer admission with a terminal lease and no
receipt, concurrent recovery and repeated passes, expired dead pending custody,
live/suspended/parked owners, ledger outage and later recovery, replacement
custody during a read, legacy page migration and delivery refunds. They also
retain the existing next-action, closure-recovery and closure-wait fixtures.

After ordinary deployment, SRE must record that no open PR has
`closure-recovery-ownership-unresolved` with a deadline more than one recovery
cycle overdue. An ongoing ledger outage remains unresolved and must produce
bounded reminders. This worker performs no live inspection, rescue, paging,
ledger mutation or service restart; source tests do not establish that receipt.
