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

Deploy the Agent OS companion first, including its dispatch-read endpoint,
ledger fence support and worker-pool fence CLI. Enable this watcher and use
`--ledger-absence` only after those producer components are installed. The
companion supplies the repository-only CWP absence proof, `observe_unlocked_key`
and `_evidence` support for `canonical-cwp-ledger-absence`. The latter checks
PR-wide HQ ownership and native conflict submission custody without the
original worker ID or boot trace offset. [Agent OS PR #11416](https://github.com/laceyenterprises/agent-os/pull/11416)

## Verification

Synthetic cases cover grace, repeated absence, transport faults, retirement
receipts, competing ownership and watcher admission after retirement.
`python3 -B test/fixtures/legacy-repair-fence-reader.py` passed, including
ledger-absence selector validation, key-lock contention and propagation of
producer custody refusals. The dispatch-read client tests passed with the
repo-only grant and exact-selector fixtures.
