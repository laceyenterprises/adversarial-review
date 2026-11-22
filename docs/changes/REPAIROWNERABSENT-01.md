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

Deploy the Agent OS companion, including its dispatch-read endpoint,
ledger fence support and worker-pool fence CLI, before using `--ledger-absence`
or accepting repository-scoped absence. There is no runtime enable switch.
A refused or unavailable repository lookup makes one legacy key-only read to
preserve positive ownership during deployment; fallback absence never counts.
The companion supplies the repository-only CWP absence proof, `observe_unlocked_key`
and `_evidence` support for `canonical-cwp-ledger-absence`. The latter checks
PR-wide HQ ownership and native conflict submission custody without the
original worker ID or boot trace offset. [Agent OS PR #11416](https://github.com/laceyenterprises/agent-os/pull/11416)

The watcher trusts that producer grant for the native submission-lock check;
it does not validate a separate lock attestation. The retirement reader also
checks PR-wide HQ custody locally for `--ledger-absence`, under the native key
lock, before rebuilding producer evidence. Local watcher absence-gate errors
log their class, code and message at the persisted thirty-second cadence.
The exclusive closer scan remains: shared flock still blocks writers, and an
unlocked scan loses serialization with closer submissions.

Closer record writers retry nonblocking lock acquisition after 10 ms and 25 ms
to accommodate a brief watcher scan. A persistent holder still refuses the write
with `EBUSY`.

## Post-merge activities

Confirm Agent OS #11416's endpoint, fence schema and CLI are installed before
operator ledger-absence retirement. Observe natural positive ownership during
rollout and canonical repository absence after producer deployment; source tests
do not establish the deployed producer's lock behavior.

## Verification

Synthetic cases cover grace, repeated absence, transport faults, retirement
receipts, competing ownership and watcher admission after retirement.
`python3 -B test/fixtures/legacy-repair-fence-reader.py` passed, including
ledger-absence selector validation, key-lock contention and propagation of
producer custody refusals. The dispatch-read client tests passed with the
repo-only grant and exact-selector fixtures.

Final Comment-only remediation: 106 repair/retirement tests, 47 dispatch-read
tests, 197 watcher claim-loop cases, all 14 Python reader fixtures, lint (zero errors), contract typecheck,
the 101-entry data-model catalog validator and the byte-equivalence demo passed.

Hammer's canonical changed-file validation passed across 43 Node test files
with one skip. The pre-receipt intent fixture verifies that a brief lock
collision allows the record write to proceed and that a persistent holder
prevents the mutation.
