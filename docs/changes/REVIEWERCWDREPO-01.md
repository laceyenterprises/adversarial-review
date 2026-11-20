# REVIEWERCWDREPO-01 — Bind reviewer workspaces to the reviewed repository

## Summary

The reviewer and Argus share a checkout resolver that verifies the full
GitHub origin. The reviewer archives the requested PR commit and uses an empty
read-only workspace when the commit cannot be materialized. The review body
records diff-only mode, and legacy saved bodies are ineligible for redelivery.

[SEV2 report](../postmortems/SEV2-REVIEWERCWDREPO-01-reviewer-used-a-foreign-checkout-2026-11-20.md)

## Interface changes

`ADVERSARIAL_REVIEWER_CLONE_ROOT` optionally supplies additional local checkouts
at `<root>/<owner>/<repo>`. See the [reviewer workspace runbook](../RUNBOOK-reviewer-workspace.md).

## Verification

- `npm test -- test/reviewer-workspace.test.mjs test/reviewer.test.mjs test/argus-dependency-evidence.test.mjs test/reviewer-file-inventory.test.mjs test/reviewer-generated-review-delivery.test.mjs test/reviewer-snapshot-base-alert.test.mjs` passed 322 tests under netguard. One optional rubric integration test skipped because its companion package was unavailable.
- `npm run lint` completed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable transcript deliveries.
