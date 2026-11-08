# STOPHOLDREPAIR-01

## Summary

Repairable deterministic stop holds reach the existing bounded repair owner
before generic ownerless recovery. The brief lists fresh gate-attributed
regions across files and requires a builder-authored, trailer-free,
fast-forward restoration. Non-repairable refusals retain their refusal route.
Failing descendants surface evidence without starting another repair chain;
passing repaired heads return to ordinary closure.

See the [SEV2 report](../postmortems/SEV2-repairable-hammer-stop-hold-had-no-reachable-repair-owner-2026-11-08.md).

## Interface changes

No new configuration, command, CI check, gate or label. Repair execution now
requires the gate's explicit `repairable: true`. The existing retry ledger
retains optional `stopRepairReservations`; recovery exhaustion includes the
current refusal and prior repair evidence. The runbook, state contract and
data-model fragments describe these compatible additions.

## Verification

- `node --test test/safety-stop-repair.test.mjs`, run alone through
  `cwp_dispatch.worker_validation` with a 600-second timeout and the required
  `NETGUARD_LOG` and netguard `PATH`: 35 passed, including persistence across head/review churn.
- Scoped ESLint (including `--fix`) and `npm run typecheck:contracts`: passed.
- Broad tests and the demo were not run, following this ticket's touched-test-only constraint.
