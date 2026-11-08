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
  `readConsensus` seam. Manifest validation and one consensus read per finding precede the writer transaction; the consensus statement is reused. Selections are limited to 10,000 findings and DEL escaping matches Python. The temporary fallback prefers independent reviewed-head
  grades, then non-interested batch observations; only real admits remediation.
- Selected real findings from the final posted current body on merged sources can enroll even when blocking.
  Existing owners, terminal outcomes and retry caps remain authoritative.
- Additive migration `20261108_findings_batch_manifest.sql` stores nullable batch
  selection hashes. The follow-up selection-scope migration retains backlog provenance across release and recovers it from existing batch/release receipts. Default claims, dispatch and health exclude selected work; already-started collection continues. Selection hashes and retry attempts fence batch identity.
- Settlement writes idempotent `batch-remediator` observations (`lifecycle` for `life.*`) through the grade
  API; historical backfill skips the same settled decision. Requeue, release and retry exhaustion create no correctness grade.
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

Remediation validation: the grade-driven batch tests pass all 13 cases, including
settle-then-backfill deduplication, released selection recovery/retry, failed
selected dispatch isolation, superseded enrollment, and Python DEL hashing.
The adjacent batch, regression, requeue and grade suites pass (125 tests).
Catalog validation passes (91 entries), lint has zero errors, contract typecheck
and the offline byte-equivalence demo pass. No full local suite was run.

Related hardening keeps historical backlog source hashes independent of the new
selection-provenance column; a seeded pre-migration source key remains unchanged
before and after selection tagging, preventing duplicate historical grades.
