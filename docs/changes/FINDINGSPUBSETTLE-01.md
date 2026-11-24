# FINDINGSPUBSETTLE-01

## Summary

The findings collector waits for terminal preparation and retries incomplete
`outcomes.json` reads. Workers receive explicit temp-and-rename instructions.
All-drop batches settle locally. Applied batches use the PR number from
`outcomes.json` against the batch repository. A single validated marked branch
PR prevents duplicate publication and atomically recovers a missing artifact PR
number/head, preserving all decisions. Numbered outcomes skip repeated preparation
probes. Exhausted transient GitHub reads defer collection; permanent errors remain
visible and follow the existing timeout and terminal-custody release rules.

The final review's runbook attachment finding does not hold on reviewed head
`d559fef05b2af7bec33c2ecbdf7304180c219d75`: `settleFindingBatch`
explicitly accepts an open current-head PR enrolled in the active review pipeline.
The existing attachment regression verifies rejection without attachment or on a
stale head, then successful settlement on a matching enrolled head. Preserve that
contract and its runbook text.

## Interface changes

Invalid JSON after the bounded rereads records `batch-outcome-invalid-json`.
An explicit missing-PR response for the artifact's numbered PR records
`batch-pr-not-found`. Already-fixed drop citations remain in the outcome
reason and do not initiate a lookup. The store schema is unchanged.

## Verification

The synthetic replays reproduce the partial-read and foreign drop-citation
errors on the original collector. The focused batch suites exercise terminal
status, retries, literal PR ownership, drop-only settlement and malformed JSON.
The original validation passed 288 tests in seven affected suites. Final-round
validation passed all 256 tests in `test/findings-batch.test.mjs`,
`test/findingsrequeue-01.test.mjs`, `test/findingsbatchstrand-01.test.mjs` and
`test/findings-batch-grades.test.mjs` through `node test/run-tests.mjs` with
those four explicit paths. `npm run lint` passed with zero errors (147 existing
warnings); `npm run typecheck:contracts`,
`node scripts/validate-data-model-catalog.mjs` (104 entries),
`bash demo/research-finding-walkthrough.sh` and `git diff --check` passed.
The full local suite was not run; PR-head CI owns that merge gate.
