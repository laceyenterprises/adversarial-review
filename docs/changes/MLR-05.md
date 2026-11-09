# MLR-05 — Deterministic finalization simulator

## Summary

Add an offline discrete-event harness around the existing finalization fold and
executor, with synthetic GitHub/runtime/clock/load/fault surfaces. Generate 78
scenarios from all 61 MLR-02 requirement identities and the nine named parked-PR
references. Record the current pass/fail table at ×1, ×3 and ×6 for MLR-06 without
changing production policy or the fold. See [the simulator guide](../../test/sim/README.md)
for regeneration, evidence boundaries and baseline interpretation.

The memory search was available and returned no matches for the simulator scope.
`hq hardening for` resolved the current-head-verdict and hammer-liveness contracts
but returned no local records. The canonical requirements ledger remains the
scar input: stale-head guards, strict all-findings remediation, exhaustion landing,
no phantom completion after crash, admission/kill retries, bounded ownership,
dirty-terminal custody, conflict recovery and exactly-once escalation are retained
as explicit scenarios/oracle predicates. Missing production mechanisms are
recorded failures, not silently simulated fixes.

Read-only DAG evidence reported MLR-02 and MLR-04 succeeded. The checked-in v1.0
spec still labels itself proposed; this change neither edits approval text nor
asserts live activation approval.

## Interface changes

Test-only `test/sim/` APIs and explicit offline generation/report commands. A
single top-level `node:test` bridge uses the existing test discovery. No workflow,
CI check, config, production store, runtime interface or merge policy changes.

## Verification

- `node --test test/finalization-simulator.test.mjs`: 18 tests passed, including
  determinism, a deliberately bad policy for each oracle predicate and the full
  234-run recorded baseline.
- Scoped ESLint: passed, no errors or warnings.
- `npm run lint`: passed, zero errors (152 warnings in unchanged source).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- Agent OS CI mirror with the 13 explicit changed paths: CDM re-derivation and
  contract typecheck passed; its slow full-suite command was deferred by the
  existing mirror policy. The ticket's scoped-test constraint replaces a local
  `npm test` run; no broad worker-pool, main-catchup or Sentinel suites ran.

Deployment: ordinary source merge; no runtime activation. Read-only activation
evidence is the offline report, not a live-service receipt. Actual v1 rollback,
adapter integration and operator/SRE cutover evidence remain with MLR-06/08.
