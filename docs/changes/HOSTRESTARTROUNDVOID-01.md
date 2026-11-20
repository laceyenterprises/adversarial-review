# HOSTRESTARTROUNDVOID-01 - a closer lost to a host restart is void

## Summary

The orchestrator settles a closer killed by a host reboot with the terminal
class `worker_lost_to_host_restart` and does not charge it an attempt. The PR
round ledger and the hammer retry cap did not know that class. They charged
the dead closer like any other failure, so after a reboot a clean PR could
reach the cycle and retry caps and need an operator to rescue it.

A hammer launch whose launch row carries that exact structured
`failure_class` is now void:

- `src/pr-round-ledger.mjs` exports `VOID_TERMINAL_CLASSES` /
  `isVoidTerminalClass`, an exact match on the structured class. Free text is
  never evidence.
- `src/ama/hammer-retry-cap.mjs` adds `voidHostRestartLostHammerDispatch`. It
  gives the charge back in full, once per charge, with a durable
  `hostRestartVoids` receipt, and it voids the dispatch's `hammer` round
  through the round ledger's existing `void` path. It shares its crediting
  with the RCV-08 no-work refund, so neither path can credit a charge twice.
- `src/ama/dispatch-closer.mjs` calls it when a failed hammer launch is
  observed. It reuses the launch-row probe the closer already reads, and a
  voided launch skips the dead-hammer re-arm, the inconclusive refund and the
  same-head no-delivery attempt. The dispatch record's
  `unexecutedRefundCount` goes up once per launch, so the per-head re-dispatch
  bound is not spent either.

Every other terminal class keeps its existing charging, including
`worker_crashed` and the CLOSERREUSE-01 refund classes.

Final remediation requires a committed refund or matching durable refund receipt
before voiding the round or crediting the per-head bound. Missing, corrupt,
unproven or invalid retry-ledger evidence now retains every other budget and
returns an owned retry before other failure accounting or successor dispatch.
Existing host-restart and no-work receipts can reconcile an interrupted round
void without crediting the retry charge twice. The canonical data-model catalog
now inventories both persistent fields alongside the existing fragment.

## Interface changes

- New optional retry-cap ledger field `hostRestartVoids`; see
  `docs/data-model/hammer-retry-cap.md`.
- New optional closer dispatch record field
  `hostRestartVoidedLaunchRequestId`; see
  `docs/data-model/ama-closer-dispatches.md`.
- New round-ledger writer row; see `docs/data-model/pr-round-ledger.md`.
- New structured log event `ama_closer.host_restart_void`; see
  `docs/RUNBOOK-ama-closure.md`.

No config keys, lifecycle states, checks or smoke actions are added.

## Validation

`test/hostrestartroundvoid-01.test.mjs` uses synthetic fixtures to cover the
following:

- the exact-match predicate;
- full and idempotent voiding of round and retry counts;
- no double credit across refund paths;
- unchanged charging for `worker_crashed` and the existing refund classes;
- two closer replays through `maybeDispatchAmaCloser`. A second closer lost to
  a host restart re-dispatches. A second closer that crashed still reaches
  `hammer-retry-cap-exhausted`.
- missing, corrupt, invalid-counter and unproven-charge refusals preserve round
  and per-head budgets across repeated observations and recover after the ledger
  is restored;
- durable host-restart and no-work receipts reconcile an interrupted round void.

Final remediation validation uses targeted offline tests only; PR-head CI owns
the full suite. The state/transition source projection remains unchanged.
`npm run lint` passed with zero errors, `npm run typecheck:contracts` passed,
`bash demo/research-finding-walkthrough.sh` passed, and
`node scripts/validate-data-model-catalog.mjs` validated all 100 entries.
`node test/run-tests.mjs test/hostrestartroundvoid-01.test.mjs
test/pr-round-ledger.test.mjs` passed all 39 tests under a 120-second bound.
