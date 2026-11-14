# FINDINGSDECISIONHOLD-01

## Summary

Prepared batches blocked on a publication question hand off decision custody
before publisher dispatch. Unresolved decision custody survives stale release.
See the [SEV2 report](../postmortems/SEV2-findings-decision-publication-hold-2026-11-14.md).

## Interface changes

The collector calls the supported `hq decision supersede-publication` API and
stores its exact branch/head/source receipt in
`finding_batches.decision_publication_json`. This requires the companion Agent
OS PR to merge first. The decision-only prompt explicitly ends successfully
after its push and outcomes artifact. Bounded errors prefer the actual refusal;
one watcher log record per failure includes the redacted full stderr.
The verified handoff can replace a spent pre-handoff intent once after its
ambiguity deadline, preserving its history and the ordinary bounded retry.
Keyed custody is checked again after the lifecycle call.

## Verification

Synthetic findings-batch tests cover ordered handoff and publication, receipt
recovery/mismatch, unchanged success, typed refusal diagnostics, stale
decision retention and the bounded handoff publication epoch. Node tests ran
separately through `cwp_dispatch.worker_validation --timeout-seconds 600` under
the prescribed netguard environment:

- `node --test test/findings-batch.test.mjs`: 137 passed.
- `node --test test/findingsrequeue-01.test.mjs`: 45 passed, including keyed and
  direct-snapshot blocked custody with no outcomes beyond the age limit.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`: passed.

No production repair, service operation or CI check was added.
