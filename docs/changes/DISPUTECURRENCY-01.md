# DISPUTECURRENCY-01 — review currency after rebase and lane remediation

## Summary

The withdrawal helper could reject a rebased review when a remediation lane
published another commit after the reviewed patches. This stopped closure on
agent-os PRs 11531 and 11448.

The currency reader now recognizes a strict ordered patch-ID prefix followed
by commits with verified remediation or in-place PR-update launch evidence.
The dispute still requires the latest authoritative review and concrete
evidence at the live head. A prior withdrawal cannot transfer across a lane
suffix under this proof.

The final Comment-only remediation binds HQ PR-update rounds to the produced
attestation's launch, retains attestation refusal/transient diagnostics, and
uses the existing reply-key resolver for local launch IDs that differ from
the job ID. The dispute refusal now describes live-head applicability.

Per-commit publication remains required: a single tip receipt does not cover
a multi-commit push, and HAM and lane suffix commits cannot be mixed. Read-only
GitHub history inspection on 2026-11-24 found both incident PRs already merged:
11531 shows one commit for each of remediation jobs `20-00-35-344Z`,
`20-24-11-319Z` and `20-53-50Z`; 11448 shows one commit for each of jobs
`21-25-04-015Z` and `22-12-48-839Z`. These are multiple rounds, rather than
multiple commits from one round. This observation establishes the visible
suffix shape, not historical receipt availability or a deployed recovery proof.

## Interface changes

The reader can return `reviewed-rebase-lane-suffix` for finding applicability.
The rebase-only reader continues to require its existing proofs.
Unavailable and capped completed-evidence reads now also return an empty
`lanePublications` Map, matching the success-path shape. No persistent store,
lifecycle state, merge gate or smoke promise changes.

## Verification

Offline synthetic fixtures exercise the attributed suffix, missing attribution,
an altered prefix, a newer review, multi-commit PR updates, and rebase-only
withdrawal reuse.

- The targeted `npm test` run passed all 975 cases across 19 files that exercise
  the currency and completed-remediation readers, including the watcher claim loop.
- `npm run lint` passed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable deliveries.

Final Comment-only remediation validation:

- `node test/run-tests.mjs test/hamwithdraw-01.test.mjs test/lac-2331.test.mjs test/hammer-head-validation.test.mjs test/commentonly-rereview-01.test.mjs`
  passed all 212 targeted cases across four files after the fresh-main rebase.
  Added coverage includes launch mismatch/missing launch, persisted local reply
  keys, both HAM/lane orderings, tip-only receipts, attestation failures and
  unavailable/capped return shapes. The initial run could not load `js-yaml`
  before the workspace was connected to installed dependencies.
- `npm run lint` passed with zero errors (147 existing warnings).
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable deliveries.
- `git diff --check` passed. The full suite remains the PR-head CI gate.
