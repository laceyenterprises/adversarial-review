# CLOSERPARKOWNER-02 — Recover ownerless closer work

## Summary

Lapsed closer decisions re-enter fenced dispatch through the rescue entry.
A closer-authored head with a carried posted review is eligible for a closure
walk through slow-lane backoff. Spent budgets and hard-stop refusals reach
operator escalation. [SEV1 postmortem](../postmortems/SEV1-CLOSERPARKOWNER-02-ownerless-closer-after-lapsed-action.md)
Discovery receipts a refused or waiting reconciliation under the PR lock and
retries it after five minutes, or sooner when the selected decision or head
changes. Drain preserves overdue-transition paging. Closer-trailer walks use
the existing evidence recheck cadence, and discovery hard-stop escalation
updates the shared next-action result.

## Interface changes

`ama.closer_queue_depth` includes admitted background work waiting for a
launch slot. `CLOSERPARKOWNER-02` diagnostics include a bounded outcome and
reason code and a redacted reconciliation error. The watchdog database gains
`closer_reconciliation`; no configuration or command changes.

## Verification

- `node --test test/closure-recovery-exec.test.mjs` passed all 45 tests through
  the bounded offline runner.
- `npm run lint` passed with zero errors, and `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` produced three byte-stable deliveries.
- This remediation passed the targeted `CLOSERPARKOWNER-02` closure-recovery
  fixture and the drain recovery fixture, plus lint, contract typecheck,
  data-model catalog validation and `git diff --check`.

The rescue CI repair refreshes the orchestration producer fingerprint after
reviewing its added queued-admission observation guard and immediate escalation
of existing hard-stop reasons. These additions do not add persisted states or
new graph edges; the independently pinned graph and drift-negative fixtures
remain unchanged.
