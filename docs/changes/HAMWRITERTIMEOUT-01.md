# HAMWRITERTIMEOUT-01

## Summary

A hammer whose merge predicate passed could end `succeeded` with no merge when
the legacy merge writer timed out reading review proof, and nothing re-drove the
merge. The writer's `legacy-writer-timeout` and `merge-target-unparseable`
refusals were recognised by the hammer's click-hold classifier but were never
registered in the stop-origin table.

## Cause

1. `bin/hammer-merge.sh` recorded a `deferred` audit with the real code, then
   exited 20. The run's final stop reported the same code to
   `recordHammerEarlyFailure`, which found it unregistered, fell back to
   `stop-reason-unregistered` (closer origin) and demanded an in-run closer
   correction. That overwrote the `last-phase` receipt with
   `stop-reason-unregistered`.
2. Unregistered, the code was not in `HAMMER_RETRYABLE_READ_OUTCOMES`, so the
   rendered procedure did not mark the lease as a retryable abort and its last
   hint said to stop, and the closer's retry allowlist
   (`AMA_CLOSER_RETRYABLE_DEFERRAL_REASONS`, built from that set) did not name
   the code. The ended launch therefore was not treated as an infrastructure
   deferral, and no same-head retry was owned.
3. The in-lane proof deadline was a load-aware 15 s clamped to a fixed 30 s.
   The load-aware value exceeds 30 s as soon as the multiplier exceeds 2
   (host load per core above 1.4); at the 5.6x multiplier of the incident it is
   about 84 s, so the cap turned a slow read into a timeout.

## Change

- `src/ama/hammer-stop-origin.mjs`: `legacy-writer-timeout` joins
  `HAMMER_INFRASTRUCTURE_OUTCOMES` (a transport/observation deadline, not a PR
  fact); `merge-target-unparseable` is registered with origin `closer`
  (command construction).
- Registration is the hand-off. The terminal audit now records the real code,
  the procedure releases the lease as a retryable abort, and the existing
  closer retry owns the next attempt: a fresh launch on the same head, the
  existing deferral backoff and refund (no retry-budget charge for the
  timeout), no re-remediation and no re-review. Operator-veto and review-change
  holds stay `world` origin and keep their terminal audit; they still do not
  qualify for retry or refund credit.
- `src/finalization/legacy-lane-write.mjs`: the in-lane proof-read deadline
  follows the load-aware value of its 15 s nominal; the fixed 30 s ceiling
  (`LEGACY_PROOF_CEILING_MS`) is removed. The only ceiling is the remaining run
  budget, and an exhausted budget still never starts transport.
- `state-machines.json` (`queueRouting.legacyTerminalReview`),
  `docs/STATE-MACHINE.md` and `docs/RUNBOOK-ama-closure.md` state the rule.

## Tests

`test/hamwritertimeout-01.test.mjs` (synthetic):

- registry completeness: every code in the shipped click-hold classifier and
  every reason `legacy-lane-write.mjs` returns is registered in
  `HAMMER_STOP_ORIGINS`, and every writer refusal is named by the classifier;
- a writer timeout after a passed predicate records its real code (not
  `stop-reason-unregistered`) and keeps the `last-phase` receipt;
- a hammer that exited `succeeded` on a writer timeout is re-driven on the same
  head without charging the retry budget; an operator-veto hold is not refunded;
- `merge-target-unparseable` is a closer fault;
- the deadline rule under a simulated 5.62x load multiplier, a read slower than
  30 s that still reaches transport, the remaining-budget ceiling and the idle
  nominal.

`test/legacy-lane-write-run-budget.test.mjs` replaces its fixed-cap
expectation with the new rule; `test/fixtures/hammer-stop-origins.json` pins
the two new registrations.

No CI check, gate or ratchet is added.
