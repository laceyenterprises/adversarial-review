# REPAIROWNERABSENT-01

## Summary

Legacy CWP conflict reservations use a repository-authorized exact-key read
to prove absence after grace. A second positive observation escalates through
`repair-absent-unfenced`. Read failures retain custody and surface the overdue
operator action. Review admission still requires publication or retirement.

## Interface changes

`retire-legacy-repair.mjs --ledger-absence` consumes the committed canonical
owner-family fence when the original conflict worker evidence is unavailable.
It retains the existing custody checks, receipt and cooldown history.
Rescue can read the operator hold from repair facts.

## Verification

Synthetic cases cover grace, repeated absence, transport faults, retirement
receipts, competing ownership and watcher admission after retirement.
