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

## Interface changes

The reader can return `reviewed-rebase-lane-suffix` for finding applicability.
The rebase-only reader continues to require its existing proofs.

## Verification

Offline synthetic fixtures exercise the attributed suffix, missing attribution,
an altered prefix, a newer review, multi-commit PR updates, and rebase-only
withdrawal reuse.

- The targeted `npm test` run passed all 975 cases across 19 files that exercise
  the currency and completed-remediation readers, including the watcher claim loop.
- `npm run lint` passed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable deliveries.
