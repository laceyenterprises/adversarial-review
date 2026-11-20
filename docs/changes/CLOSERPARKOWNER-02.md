# CLOSERPARKOWNER-02 — Recover ownerless closer work

## Summary

Lapsed closer decisions re-enter fenced dispatch through the rescue entry.
A closer-authored head with a carried posted review is eligible for a closure
walk through slow-lane backoff. Spent budgets and hard-stop refusals reach
operator escalation. [SEV1 postmortem](../postmortems/SEV1-CLOSERPARKOWNER-02-ownerless-closer-after-lapsed-action.md)

## Interface changes

`ama.closer_queue_depth` includes admitted background work waiting for a
launch slot. `CLOSERPARKOWNER-02` diagnostics include a bounded outcome and
reason code. No configuration or command changes.

## Verification

- `node --test test/closure-recovery-exec.test.mjs` passed all 45 tests through
  the bounded offline runner.
- `npm run lint` passed with zero errors, and `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` produced three byte-stable deliveries.

The rescue CI repair refreshes the orchestration producer fingerprint after
reviewing its added queued-admission observation guard and immediate escalation
of existing hard-stop reasons. These additions do not add persisted states or
new graph edges; the independently pinned graph and drift-negative fixtures
remain unchanged.
