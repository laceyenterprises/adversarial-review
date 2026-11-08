# RGY-04 — Grade-driven findings remediation

## Summary

Frozen selections can drive findings batches using real grades while workers
still verify applicability on current main. Default backlog enrollment and drain
remain available. Settlement records structured grades atomically with validated
outcomes; lifecycle/stale outcomes do not become reviewer errors.

## Interface changes

- `bin/findings-batch-backfill.mjs --manifest <selection.json>` validates RGY-02
  version 1 hashes and finding/repository/PR/head identities. Explicit runs claim,
  dispatch and collect only that selection, excluding simplicity advisories.
- `claimFindingBatches` and `runFindingBatches` accept `manifest` and a synchronous
  `readConsensus` seam. The temporary fallback prefers independent reviewed-head
  grades, then non-interested batch observations; only real admits remediation.
- Selected real findings from merged sources can enroll even when blocking.
  Existing owners, terminal outcomes and retry caps remain authoritative.
- Additive migration `20261108_findings_batch_manifest.sql` stores nullable batch
  selection hashes. Selection hashes and retry attempts fence batch identity.
- Settlement writes idempotent `batch-remediator` observations through the grade
  API. Requeue, release and retry exhaustion create no correctness grade.
- Drop normalization moves to a shared module, preserving the existing export.
  No review routing, strictness, merge predicate, CI or deployment action changes.

## Verification

Tests run individually with netguard and a 600-second process-group bound:

- `node --test test/findings-batch-grades.test.mjs`: 8 passed.
- `node --test test/findings-batch.test.mjs`: 101 passed.
- `node --test test/findingsrequeue-01.test.mjs`: 18 passed.
- `node --test test/review-finding-grades.test.mjs`: 5 passed.
- `npm run lint`: zero errors (existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- CI mirror worker fast tier: CDM re-derivation and contract typecheck passed;
  the broad suite was deferred to CI.

The full suite was not run under the ticket's targeted-test constraint.
No live database, services, model providers or production findings were used.
