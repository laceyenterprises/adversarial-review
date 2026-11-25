# FINDINGSGHEMPTY-01

## Summary

Findings settlement keeps a batch pending when a GitHub or HQ preparation
status read yields empty or malformed JSON, or when a GitHub PR view, PR list
or branch ref read yields literal `null`. GitHub JSON reads retry twice locally
after 50 and 100 ms before the next tick retries with the same
custody. Launched batches with a legacy settlement parse error wait for
terminal preparation, then reuse the existing outcomes and marked PR evidence.
Once the collector has valid numbered outcomes, including outcomes recovered
from a marked branch PR, it clears the legacy error before reading the PR.
A transient PR read then retries through ordinary numbered settlement without
another preparation probe. Numbered legacy artifacts retain custody on invalid
preparation status shape or contradictory launch/repository evidence. Only
recognized historical V8 JSON error forms trigger that legacy path.

## Interface changes

Transient parse warnings name the operation and byte count. Outcomes that
remain malformed after bounded local retries record `batch-outcome-invalid-json`
once preparation ends. Malformed publisher intent JSON records
`batch-publish-receipt-pending` and fences resubmission. Both use the existing
timeout and custody checks for release. Empty, malformed or null decision
supersession stdout retries the bound lifecycle operation next pass, allowing
an already canceled source to re-emit its receipt. A valid but mismatched receipt
retains the existing hard error. Failed reads preserve the stored error and
attempt counts; strictly past timeout they record `batch-publication-read-malformed`
in `hold_json`, visible to the existing held-batch alert. Repeated failures retain
the original hold time. Definitive failures during legacy recovery use the
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
- Final advisory remediation passed all 212 tests in
  `test/findings-batch.test.mjs`, covering overdue holds without custody/error/
  attempt changes, rejection of unrelated legacy-error suffixes, numbered legacy
  projection drift, same-pass GitHub JSON retries and exhaustion, and
  canceled-source supersession receipt recovery after truncated stdout.
- The final round also passed 69 targeted tests across
  `test/findingsrequeue-01.test.mjs`, `test/findingsbatchstrand-01.test.mjs`
  and `test/smv.test.mjs`; lint (0 errors, 147 existing warnings), contract
  type checking, the offline research walkthrough and the 105-entry
  data-model catalog validator passed. The full suite remains a PR-head CI gate.

[SEV2 incident report](../postmortems/SEV2-FINDINGSGHEMPTY-01-findings-settlement-empty-json.md)
