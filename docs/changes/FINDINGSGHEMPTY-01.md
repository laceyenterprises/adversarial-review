# FINDINGSGHEMPTY-01

## Summary

Findings settlement keeps a batch pending when a GitHub or HQ preparation
status read yields empty or malformed JSON, or when a GitHub PR view, PR list
or branch ref read yields literal `null`. The next tick retries with the same
custody. Launched batches with a legacy settlement parse error wait for
terminal preparation, then reuse the existing outcomes and marked PR evidence.
Once the collector has valid numbered outcomes and has verified terminal
preparation, it clears the legacy error and resumes ordinary numbered PR
settlement without further preparation probes.

## Interface changes

Transient parse warnings name the operation and byte count. Outcomes that
remain malformed after bounded local retries record `batch-outcome-invalid-json`
once preparation ends. Malformed publisher intent JSON records
`batch-publish-receipt-pending` and fences resubmission. Both use the existing
timeout and custody checks for release. An invalid decision supersession
response records `batch-decision-publication-receipt-invalid` and surfaces an
overdue operator hold. Definitive failures during legacy recovery use the
ordinary release path.

## Verification

- `node --test test/findings-batch.test.mjs` passed 187 tests, including empty
  and truncated stdout, partial outcomes, branch and ref reads, recovery to an
  existing open fix PR without relaunch, and permanent failure behavior.
- `npm run lint` passed with zero errors. `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- The single-worker `npm test` run exceeded the local time budget and was
  stopped before producing a suite result. PR-head CI provides full-suite
  verification.
- Remediation passed 397 tests across six targeted files covering findings,
  producer contracts and state/smoke declarations. The data-model catalog
  validator also passed.

[SEV2 incident report](../postmortems/SEV2-FINDINGSGHEMPTY-01-findings-settlement-empty-json.md)
