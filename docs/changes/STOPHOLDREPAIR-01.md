# STOPHOLDREPAIR-01

## Summary

Repairable deterministic stop holds reach the existing bounded repair owner
before generic ownerless recovery. The brief lists fresh gate-attributed
regions across files and requires a builder-authored, trailer-free,
fast-forward restoration. Non-repairable refusals retain their refusal route.
Failing descendants surface evidence without starting another repair chain;
passing repaired heads return to ordinary closure.

Final comment-only remediation makes null comparison metadata return the existing
`repair-ancestry-unreadable` refusal and fetches fresh coordinate evidence for
scalar `refusal.reason: primary-change-reverted` as well as array reasons.
Offline regressions cover both cases, including unchanged repair reservations
and no extra submission when ancestry is unreadable.

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
- Initial implementation: broad tests and the demo were not run, following this
  ticket's touched-test-only constraint.
- Final comment-only remediation: `node --test test/safety-stop-repair.test.mjs`
  passed all 39 tests through `bash bin/run-bounded.sh --timeout 60`.
  The new regressions first reproduced the null-comparison exception and skipped
  scalar-reason evidence collection before the fix.
- Final remediation: `npm run lint` passed with zero errors (152 existing
  warnings); `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed through the bounded runner.
  `node scripts/validate-data-model-catalog.mjs` validated all 91 entries.
  The full local test suite was not run; PR-head CI remains its merge gate.
- `node --test test/watcher-claim-loop.test.mjs` passed all 161 cases with a
  300-second bounded runner after the initial 60-second bound expired.
