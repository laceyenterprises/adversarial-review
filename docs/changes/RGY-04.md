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

CI remediation accounts separately for the manifest and selection-scope migration
sentinel reads in the existing closure-latency test. Both Node CI lanes failed
because these twelve expected reads were charged to the unchanged non-migration
budget of 114. The test now pins six reads for each new migration while retaining
that budget and all existing GitHub read assertions.

CI remediation verification: bounded targeted runs of
`test/watcher-closure-latency.test.mjs` (33 passed) and
`test/findings-batch-grades.test.mjs` (13 passed) succeed on Node 26.
`npm run lint` reports zero errors (existing warnings),
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`
and `git diff --check` pass. No full local suite was run.

Rescue remediation (PR #1766): settlement prepares the attempt lookup once per
transaction and uses null-safe lifecycle classification before the existing
grade validator. A multi-finding regression verifies distinct retry attempts
and lifecycle kinds remain correct.

The catalog currency finding is confined to the generated artifact:
`catalog.d/review-finding-grades.json` already declares the manifest migration,
selection module, settlement sources and current compatibility contract.
In-memory derivation of its two entries into the catalog verified every cited
surface exists and all requested metadata is present (92 resulting entries).
The rescue closeout explicitly prohibits committing `catalog.json` and assigns
regeneration to main automation after merge. That rescue did not change the
compiled file; the earlier partial scope-migration edit was still present. The
subsequent advisory remediation below removes that partial edit, restoring the
compiled file to the PR base while leaving regeneration to main automation.

Rescue verification (bounded by `cwp_dispatch.worker_validation`, 900 seconds):

- `node test/run-tests.mjs test/findings-batch-grades.test.mjs test/findings-batch.test.mjs test/findingsrequeue-01.test.mjs test/review-finding-grades.test.mjs`: 138 passed.
- `npm run lint`: zero errors, 152 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- In-memory catalog fragment derivation and surface assertions: passed.

No full suite was run, following the rescue's scoped-validation instruction.

Advisory rescue remediation (PR #1766, round 2):

- Probe backlog and batch selection columns independently so pre-migration and
  partially migrated read-only stores retain summaries and overdue alerts.
- Add per-manifest `selectedBacklog` health counts for open, unbatched, errored
  and undispatched findings, exposing dispatch failures and released selections.
- Recover selection provenance from release history only for unowned rows;
  a current default owner takes precedence over old selection receipts.
- Restore the base compiled catalog and unrelated queue-rebase arrow encoding.
  Canonical catalog fragments remain the source for main's regeneration.
- Pin byte-for-byte output from the installed RGY-02 producer using a temporary
  synthetic store; confirm object-shaped heads and distinguish heads mismatch
  from findings hash mismatch. No production store or provider was used.

Round 2 verification (each command bounded by `cwp_dispatch.worker_validation`,
900 seconds):

- `node test/run-tests.mjs test/findings-batch-grades.test.mjs test/findings-batch.test.mjs test/findingsrequeue-01.test.mjs test/review-finding-grades.test.mjs test/watcher-claim-loop.test.mjs test/watcher-closure-latency.test.mjs`: 336 passed.
- ESLint `--fix` on changed JavaScript and `npm run lint`: zero errors;
  the repository lint reports 152 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- Catalog byte equality with the PR base, producer-fixture byte equality,
  state-machine JSON parsing and `git diff --check`: passed.

Validation follows this rescue's scoped-test instruction; no full suite was run.
